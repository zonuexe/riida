use directories::ProjectDirs;
use notify::{Config, Event, RecommendedWatcher, RecursiveMode, Watcher};
use rusqlite::{params, Connection};
use serde::Serialize;
use std::{
    collections::{hash_map::DefaultHasher, HashMap, HashSet},
    fs,
    hash::{Hash, Hasher},
    path::{Path, PathBuf},
    sync::{mpsc, Arc, Mutex, OnceLock},
    thread,
    time::{Duration, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Manager, State, Url};
use tauri_plugin_opener::OpenerExt;
use walkdir::WalkDir;
use zip::ZipArchive;

use riida_core::config::{
    collapse_home_path, compile_exclude_patterns, expand_home_path, load_config_file,
    migrate_legacy_config_with_connection, normalize_gui_config_input, save_config_input_file_at,
    AppConfig, AppConfigInput, CONFIG_FILE,
};
use riida_core::db::open_database_at;
use riida_core::epub::{epub_extract_opf_metadata, epub_opf_path, EpubMetadataPayload};
use riida_core::fulltext_books::{
    base_docs_for_book, extract_request_for_book, fulltext_metadata_doc, gather_books_for_index,
    is_dataless, should_index_body, sync_needs_reindex, BookIndexInput, FulltextChunk,
};
use riida_core::library::{
    check_library_root_candidate, collect_indexable_books, current_scan_token, index_books,
    is_epub_file, load_snapshot, should_include_book, should_rescan, uuid_v4, CustomSource,
    LibraryRootRejection, LibrarySnapshot, Shelf, ShelfDraft,
};
use riida_core::metadata::{normalize_book_metadata, BookMetadataInput, BookMetadataPayload};
use riida_core::reading::{
    normalize_page_offset_ratio, query_pdf_password, upsert_pdf_password, NoteDocument,
    ReadingPosition,
};
use riida_core::storage::{prepare_storage, AppPaths};
use riida_core::tags::{delete_book_tag, normalize_book_tags, rename_book_tag, BookTagsPayload};
use riida_core::thumbnail::{generate_epub_cover, generate_thumbnail, is_thumbnail_fresh};
use riida_core::viewer_prefs::{
    build_file_viewer_preferences_for_storage, default_viewer_preferences,
    load_saved_viewer_preferences, load_viewer_preferences_payload, normalize_viewer_preferences,
    normalize_viewer_source_type, save_viewer_preferences_record, viewer_file_scope_key,
    viewer_global_scope_key, ViewerPreferences, ViewerPreferencesPayload,
};
use riida_core::{epub_image, fulltext, fulltext_extract, fulltext_pool};

static APP_PATHS: OnceLock<AppPaths> = OnceLock::new();
static DATABASE: OnceLock<Mutex<Connection>> = OnceLock::new();
static FULLTEXT: OnceLock<fulltext::FullTextIndex> = OnceLock::new();
static FULLTEXT_BUILDING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
static FULLTEXT_SYNCING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
// Directory containing libpdfium, resolved once at startup: `PDFIUM_LIB_DIR`
// (dev shell) or the bundled Tauri resource dir (release). `None` falls back to
// a system-installed library inside `bind_pdfium`.
static PDFIUM_DIR: OnceLock<Option<PathBuf>> = OnceLock::new();
// Bumped by every `start_library_watcher` call. A watcher thread whose
// generation is no longer current stops, so a config change replaces the
// watcher instead of leaving the old one rescanning with a stale root list.
static LIBRARY_WATCHER_GENERATION: std::sync::atomic::AtomicU64 =
    std::sync::atomic::AtomicU64::new(0);
// Wake-up handle of the running watcher thread. The thread blocks on its event
// channel with no timeout (an idle app must not wake up periodically), so
// retiring it means sending it a message rather than waiting for a poll.
static LIBRARY_WATCHER_WAKE: Mutex<Option<mpsc::Sender<notify::Result<Event>>>> = Mutex::new(None);

fn should_allow_internal_navigation(url: &Url) -> bool {
    match url.scheme() {
        "tauri" | "about" | "blob" | "data" | "file" | "asset" | "ipc" => true,
        // Windows serves the app itself, IPC, and every custom scheme from
        // `<name>.localhost` subdomains instead of macOS's `tauri://`.
        "http" | "https" => match url.host_str() {
            Some("localhost") | Some("127.0.0.1") => true,
            Some(host) => host.ends_with(".localhost"),
            None => false,
        },
        _ => false,
    }
}

struct ConfigState {
    config: Mutex<AppConfig>,
}

struct ThumbnailQueue {
    sender: mpsc::Sender<String>,
    pending: Arc<Mutex<HashSet<String>>>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ThumbnailReadyEvent {
    file_path: String,
    thumbnail_path: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AppConfigPayload {
    config_path: String,
    config_exists: bool,
    library_roots: Vec<String>,
    excluded_patterns: Vec<String>,
    pdf_renderer: String,
    theme: String,
    enabled_external_sources: Vec<String>,
}

fn database_file() -> Result<PathBuf, String> {
    Ok(app_paths()?.database_file.clone())
}

fn project_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")))
}

fn config_file() -> PathBuf {
    app_paths()
        .map(|paths| paths.config_file.clone())
        .unwrap_or_else(|_| project_root().join(CONFIG_FILE))
}

fn thumbnail_root() -> PathBuf {
    app_paths()
        .map(|paths| paths.thumbnail_root.clone())
        .unwrap_or_else(|_| project_root().join("data").join("thumbnails"))
}

fn preferred_config_file(project_dirs: &ProjectDirs) -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .map(|home| home.join(".config"))
        .filter(|xdg_dir| xdg_dir.exists())
        .map(|xdg_dir| xdg_dir.join("riida").join(CONFIG_FILE))
        .unwrap_or_else(|| project_dirs.config_dir().join(CONFIG_FILE))
}

fn development_app_paths(project_root: &Path) -> AppPaths {
    let data_dir = project_root.join("data");
    let cache_dir = project_root.join("cache");
    let mut legacy_config_files = Vec::new();
    let mut legacy_database_files = Vec::new();
    let mut legacy_thumbnail_roots = vec![project_root.join("data").join("thumbnails")];

    for legacy_project_dirs in [
        ProjectDirs::from("com", "zonuexe", "riida"),
        ProjectDirs::from("com", "megurine", "riida"),
    ]
    .into_iter()
    .flatten()
    {
        let legacy_config_file = preferred_config_file(&legacy_project_dirs);
        if !legacy_config_files.contains(&legacy_config_file) {
            legacy_config_files.push(legacy_config_file);
        }

        let legacy_database_file = legacy_project_dirs.data_dir().join("app.db");
        if !legacy_database_files.contains(&legacy_database_file) {
            legacy_database_files.push(legacy_database_file);
        }

        let legacy_thumbnail_root = legacy_project_dirs.cache_dir().join("thumbnails");
        if !legacy_thumbnail_roots.contains(&legacy_thumbnail_root) {
            legacy_thumbnail_roots.push(legacy_thumbnail_root);
        }
    }

    AppPaths {
        config_file: project_root.join(CONFIG_FILE),
        data_dir: data_dir.clone(),
        database_file: data_dir.join("app.db"),
        cache_dir: cache_dir.clone(),
        thumbnail_root: cache_dir.join("thumbnails"),
        legacy_config_files,
        legacy_database_files,
        legacy_thumbnail_roots,
    }
}

fn resolve_app_paths() -> Result<AppPaths, String> {
    let project_root = project_root();
    if cfg!(debug_assertions) {
        return Ok(development_app_paths(&project_root));
    }

    let project_dirs = ProjectDirs::from("me", "zonu", "riida")
        .ok_or_else(|| "failed to resolve app directories".to_string())?;
    let data_dir = project_dirs.data_dir().to_path_buf();
    let cache_dir = project_dirs.cache_dir().to_path_buf();
    let config_file = preferred_config_file(&project_dirs);

    let mut legacy_config_files = vec![project_root.join(CONFIG_FILE)];
    let mut legacy_database_files = vec![project_root.join("data").join("app.db")];
    let mut legacy_thumbnail_roots = vec![project_root.join("data").join("thumbnails")];

    for legacy_project_dirs in [
        ProjectDirs::from("com", "zonuexe", "riida"),
        ProjectDirs::from("com", "megurine", "riida"),
    ]
    .into_iter()
    .flatten()
    {
        let legacy_config_file = preferred_config_file(&legacy_project_dirs);
        if !legacy_config_files.contains(&legacy_config_file) {
            legacy_config_files.push(legacy_config_file);
        }

        let legacy_database_file = legacy_project_dirs.data_dir().join("app.db");
        if !legacy_database_files.contains(&legacy_database_file) {
            legacy_database_files.push(legacy_database_file);
        }

        let legacy_thumbnail_root = legacy_project_dirs.cache_dir().join("thumbnails");
        if !legacy_thumbnail_roots.contains(&legacy_thumbnail_root) {
            legacy_thumbnail_roots.push(legacy_thumbnail_root);
        }
    }

    Ok(AppPaths {
        config_file,
        database_file: data_dir.join("app.db"),
        thumbnail_root: cache_dir.join("thumbnails"),
        data_dir,
        cache_dir,
        legacy_config_files,
        legacy_database_files,
        legacy_thumbnail_roots,
    })
}

fn app_paths() -> Result<&'static AppPaths, String> {
    APP_PATHS
        .get()
        .ok_or_else(|| "application paths have not been initialized".to_string())
}

fn load_config() -> Result<AppConfig, String> {
    load_config_file(&config_file())
}

/// If the config file exists without a `version` field it predates the
/// version-stamped migration scheme. Run the pending fix-ups against the
/// SQLite DB and rewrite the file with the current version stamped, so
/// subsequent launches skip the work.
fn migrate_legacy_config_if_needed(config_path: &Path) -> Result<(), String> {
    let connection = lock_database()?;
    migrate_legacy_config_with_connection(config_path, &connection)
}

fn lock_config<'a>(
    config_state: &'a State<'a, ConfigState>,
) -> Result<std::sync::MutexGuard<'a, AppConfig>, String> {
    config_state
        .config
        .lock()
        .map_err(|_| "failed to lock app config".to_string())
}

fn app_config_to_payload(config: &AppConfig) -> AppConfigPayload {
    let config_path = config_file();
    AppConfigPayload {
        config_path: config_path.to_string_lossy().into_owned(),
        config_exists: config_path.exists(),
        library_roots: config
            .library_roots
            .iter()
            .map(|value| collapse_home_path(value))
            .collect(),
        excluded_patterns: config.excluded_patterns.clone(),
        pdf_renderer: config.pdf_renderer.clone(),
        theme: config.theme.clone(),
        enabled_external_sources: config.enabled_external_sources.clone(),
    }
}

fn save_config_file(config: &AppConfig) -> Result<(), String> {
    save_config_input_file(&AppConfigInput {
        library_roots: config
            .library_roots
            .iter()
            .map(|value| collapse_home_path(value))
            .collect(),
        excluded_patterns: config.excluded_patterns.clone(),
        pdf_renderer: config.pdf_renderer.clone(),
        theme: config.theme.clone(),
        enabled_external_sources: config.enabled_external_sources.clone(),
    })
}

fn save_config_input_file(input: &AppConfigInput) -> Result<(), String> {
    save_config_input_file_at(&config_file(), input)
}

fn open_database() -> Result<Connection, String> {
    open_database_at(&database_file()?)
}

/// Open the shared database connection once and store it in the process-wide
/// `DATABASE` cell. Schema creation, column back-fills, and the NFC path
/// migration all run here exactly once at startup instead of on every command.
fn initialize_database() -> Result<(), String> {
    if DATABASE.get().is_some() {
        return Ok(());
    }
    let connection = open_database()?;
    let _ = DATABASE.set(Mutex::new(connection));
    Ok(())
}

/// Lock the shared database connection. Callers hold the guard only for the
/// duration of their own statements; expensive non-database work (such as the
/// filesystem walk during a rescan) must happen before acquiring this lock.
fn lock_database() -> Result<std::sync::MutexGuard<'static, Connection>, String> {
    DATABASE
        .get()
        .ok_or_else(|| "database is not initialized".to_string())?
        .lock()
        .map_err(|error| error.to_string())
}

fn refresh_library_snapshot(config: &AppConfig) -> Result<LibrarySnapshot, String> {
    let excluded_patterns = compile_exclude_patterns(config)?;
    // Walk the filesystem before touching the shared connection so a large
    // rescan does not block concurrent database commands while it runs.
    let books = collect_indexable_books(config, &excluded_patterns)?;
    let scan_token = current_scan_token()?;

    let snapshot = {
        let mut connection = lock_database()?;
        index_books(&mut connection, &books, scan_token)?;
        load_snapshot(&connection, config)?
    };
    // Catch the index up to any added/removed/changed files (no-op unless the
    // user already opted in by building the index). Runs in the background.
    fulltext_sync_after_scan();
    Ok(snapshot)
}

fn thumbnail_cache_dir(file_path: &str) -> PathBuf {
    let mut hasher = DefaultHasher::new();
    file_path.hash(&mut hasher);
    thumbnail_root().join(format!("{:016x}", hasher.finish()))
}

fn thumbnail_output_file(file_path: &str) -> PathBuf {
    thumbnail_cache_dir(file_path).join("thumbnail.jpg")
}

fn start_thumbnail_worker(app: AppHandle) -> ThumbnailQueue {
    let (tx, rx) = mpsc::channel::<String>();
    let pending = Arc::new(Mutex::new(HashSet::<String>::new()));
    let pending_for_worker = Arc::clone(&pending);

    thread::spawn(move || {
        while let Ok(file_path) = rx.recv() {
            let book_path = PathBuf::from(&file_path);
            let output_dir = thumbnail_cache_dir(&file_path);
            let result = if is_epub_file(&book_path) {
                generate_epub_cover(&book_path, &output_dir)
            } else {
                generate_thumbnail(&book_path, &output_dir)
            };

            if let Ok(thumbnail_path) = result {
                let _ = app.emit(
                    "thumbnail-ready",
                    ThumbnailReadyEvent {
                        file_path: file_path.clone(),
                        thumbnail_path: thumbnail_path.to_string_lossy().into_owned(),
                    },
                );
            }

            if let Ok(mut pending) = pending_for_worker.lock() {
                pending.remove(&file_path);
            }
        }
    });

    ThumbnailQueue {
        sender: tx,
        pending,
    }
}

fn emit_library_snapshot(app: &AppHandle, config: &AppConfig) -> Result<(), String> {
    let snapshot = refresh_library_snapshot(config)?;

    app.emit("library-updated", &snapshot)
        .map_err(|error| error.to_string())
}

fn library_watcher_is_current(generation: u64) -> bool {
    LIBRARY_WATCHER_GENERATION.load(std::sync::atomic::Ordering::SeqCst) == generation
}

fn start_library_watcher(app: AppHandle, config: AppConfig) -> Result<(), String> {
    // Retire the previous watcher even when this config has nothing to watch.
    let (tx, rx) = mpsc::channel::<notify::Result<Event>>();

    // Bump the generation, retire the previous thread and install this one's
    // wake-up handle in a single critical section, so overlapping calls cannot
    // retire each other's thread or strand an old one.
    let generation = {
        let mut wake = LIBRARY_WATCHER_WAKE
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let generation =
            LIBRARY_WATCHER_GENERATION.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
        if let Some(previous) = wake.replace(tx.clone()) {
            let _ = previous.send(Err(notify::Error::generic("library watcher retired")));
        }
        generation
    };

    // Nothing to watch: the previous watcher is retired above, and this
    // call's handle is dropped with `tx`/`rx`.
    if config
        .library_roots
        .iter()
        .all(|root| !Path::new(root).exists())
    {
        return Ok(());
    }

    thread::spawn(move || {
        let excluded_patterns = match compile_exclude_patterns(&config) {
            Ok(patterns) => patterns,
            Err(error) => {
                let _ = app.emit("library-watch-error", error);
                return;
            }
        };
        let mut watcher = match RecommendedWatcher::new(
            move |result| {
                let _ = tx.send(result);
            },
            Config::default(),
        ) {
            Ok(watcher) => watcher,
            Err(error) => {
                let _ = app.emit("library-watch-error", error.to_string());
                return;
            }
        };

        for root in &config.library_roots {
            if !Path::new(root).exists() {
                continue;
            }

            if let Err(error) = watcher.watch(Path::new(root), RecursiveMode::Recursive) {
                let _ = app.emit("library-watch-error", error.to_string());
                return;
            }
        }

        while let Ok(result) = rx.recv() {
            if !library_watcher_is_current(generation) {
                break;
            }

            match result {
                Ok(event) if should_rescan(&event, &excluded_patterns) => {
                    thread::sleep(Duration::from_millis(750));

                    while rx.try_recv().is_ok() {}

                    // The drain may have swallowed the retire message; the
                    // generation is bumped before it is sent, so it shows here.
                    if !library_watcher_is_current(generation) {
                        break;
                    }

                    if let Err(error) = emit_library_snapshot(&app, &config) {
                        let _ = app.emit("library-watch-error", error);
                    }
                }
                Ok(_) => {}
                Err(error) => {
                    let _ = app.emit("library-watch-error", error.to_string());
                }
            }
        }
    });

    Ok(())
}

#[tauri::command]
async fn library_snapshot(config_state: State<'_, ConfigState>) -> Result<LibrarySnapshot, String> {
    let config = lock_config(&config_state)?.clone();
    // The rescan walks the whole library and writes to SQLite; run it on the
    // blocking pool so the UI thread stays responsive.
    tauri::async_runtime::spawn_blocking(move || refresh_library_snapshot(&config))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn load_library_snapshot(
    config_state: State<'_, ConfigState>,
) -> Result<LibrarySnapshot, String> {
    let config = lock_config(&config_state)?.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let connection = lock_database()?;
        load_snapshot(&connection, &config)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
fn book_thumbnail(
    file_path: String,
    queue: State<'_, ThumbnailQueue>,
    config_state: State<'_, ConfigState>,
) -> Result<Option<String>, String> {
    let pdf_path = PathBuf::from(&file_path);
    let config = lock_config(&config_state)?.clone();
    let excluded_patterns = compile_exclude_patterns(&config)?;

    if !pdf_path.exists() || !should_include_book(&pdf_path, &excluded_patterns) {
        return Ok(None);
    }

    let thumbnail_path = thumbnail_output_file(&file_path);

    if thumbnail_path.exists() && is_thumbnail_fresh(&pdf_path, &thumbnail_path) {
        return Ok(Some(thumbnail_path.to_string_lossy().into_owned()));
    }

    let mut pending = queue
        .pending
        .lock()
        .map_err(|_| "failed to lock thumbnail queue".to_string())?;

    if pending.insert(file_path.clone()) {
        queue
            .sender
            .send(file_path)
            .map_err(|error| error.to_string())?;
    }

    Ok(None)
}

#[tauri::command]
fn load_app_config(config_state: State<'_, ConfigState>) -> Result<AppConfigPayload, String> {
    let config = lock_config(&config_state)?.clone();
    Ok(app_config_to_payload(&config))
}

#[tauri::command]
fn save_app_config(
    app: AppHandle,
    config_state: State<'_, ConfigState>,
    input: AppConfigInput,
) -> Result<AppConfigPayload, String> {
    let next_config = normalize_gui_config_input(input);

    if next_config.library_roots.is_empty() {
        return Err("at least one library root is required".to_string());
    }

    save_config_file(&next_config)?;

    {
        let mut config = lock_config(&config_state)?;
        *config = next_config.clone();
    }

    start_library_watcher(app.clone(), next_config.clone())?;
    emit_library_snapshot(&app, &next_config)?;
    Ok(app_config_to_payload(&next_config))
}

/// `add_library_root`'s error, structured so the frontend can word it in the
/// user's language instead of showing backend text.
#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum AddLibraryRootError {
    Rejected { reason: LibraryRootRejection },
    Failed { message: String },
}

impl From<String> for AddLibraryRootError {
    fn from(message: String) -> Self {
        Self::Failed { message }
    }
}

/// Adds one folder to the library and scans it right away, without the
/// Settings form's save step. Used by the welcome screen and folder drops.
#[tauri::command]
async fn add_library_root(
    app: AppHandle,
    config_state: State<'_, ConfigState>,
    path: String,
) -> Result<AppConfigPayload, AddLibraryRootError> {
    let candidate = PathBuf::from(expand_home_path(path.trim()));
    let home = std::env::var("HOME").ok().map(PathBuf::from);

    let next_config = {
        let mut config = lock_config(&config_state)?;
        check_library_root_candidate(
            &candidate,
            candidate.is_dir(),
            home.as_deref(),
            &config.library_roots,
        )
        .map_err(|reason| AddLibraryRootError::Rejected { reason })?;

        let mut next_config = config.clone();
        next_config
            .library_roots
            .push(candidate.to_string_lossy().into_owned());
        save_config_file(&next_config)?;
        *config = next_config.clone();
        next_config
    };

    start_library_watcher(app.clone(), next_config.clone())?;
    let scan_config = next_config.clone();
    // A first scan of a large folder takes a while; keep it off the UI thread.
    tauri::async_runtime::spawn_blocking(move || emit_library_snapshot(&app, &scan_config))
        .await
        .map_err(|error| error.to_string())??;
    Ok(app_config_to_payload(&next_config))
}

#[tauri::command]
fn load_note(file_path: String) -> Result<NoteDocument, String> {
    let connection = lock_database()?;
    let mut statement = connection
        .prepare(
            "
            SELECT
              format,
              content,
              updated_at
            FROM notes
            WHERE file_path = ?1
            ",
        )
        .map_err(|error| error.to_string())?;

    let note = statement.query_row(params![&file_path], |row| {
        Ok(NoteDocument {
            file_path: file_path.clone(),
            format: row.get(0)?,
            content: row.get(1)?,
            updated_at: Some(row.get(2)?),
        })
    });

    match note {
        Ok(note) => Ok(note),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(NoteDocument {
            file_path,
            format: "markdown".to_string(),
            content: String::new(),
            updated_at: None,
        }),
        Err(error) => Err(error.to_string()),
    }
}

#[tauri::command]
fn save_note(file_path: String, content: String) -> Result<NoteDocument, String> {
    let connection = lock_database()?;
    let updated_at = std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_secs();

    connection
        .execute(
            "
            INSERT INTO notes (file_path, format, content, updated_at)
            VALUES (?1, ?2, ?3, ?4)
            ON CONFLICT(file_path) DO UPDATE SET
              format = excluded.format,
              content = excluded.content,
              updated_at = excluded.updated_at
            ",
            params![&file_path, "markdown", &content, updated_at],
        )
        .map_err(|error| error.to_string())?;

    fulltext_on_note_changed(&connection, &file_path, &content);

    Ok(NoteDocument {
        file_path,
        format: "markdown".to_string(),
        content,
        updated_at: Some(updated_at),
    })
}

#[tauri::command]
fn save_book_tags(file_path: String, tags: Vec<String>) -> Result<BookTagsPayload, String> {
    let mut connection = lock_database()?;
    let normalized = normalize_book_tags(tags);
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;

    transaction
        .execute(
            "DELETE FROM book_tags WHERE file_path = ?1",
            params![file_path.clone()],
        )
        .map_err(|error| error.to_string())?;

    for tag in &normalized {
        transaction
            .execute(
                "INSERT INTO book_tags (file_path, tag) VALUES (?1, ?2)",
                params![file_path.clone(), tag],
            )
            .map_err(|error| error.to_string())?;
    }

    transaction.commit().map_err(|error| error.to_string())?;

    fulltext_on_metadata_changed(&connection, &file_path);

    Ok(BookTagsPayload {
        file_path,
        tags: normalized,
    })
}

#[tauri::command]
fn open_viewer_window(
    app: AppHandle,
    file_path: String,
    source: Option<String>,
) -> Result<String, String> {
    if file_path.is_empty() {
        return Err("file_path is required".to_string());
    }

    let now_nanos = std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let label = format!("viewer-{}", now_nanos);

    // Pass launch parameters via an initialization script. Setting them on
    // window.__RIIDA_LAUNCH_PARAMS__ before any other script runs avoids the
    // cross-platform pitfalls of stuffing a query string into WebviewUrl::App.
    let payload = serde_json::json!({
        "filePath": file_path,
        "source": source,
    });
    let init_script = format!(
        "window.__RIIDA_LAUNCH_PARAMS__ = Object.freeze({});",
        payload,
    );

    tauri::WebviewWindowBuilder::new(
        &app,
        &label,
        tauri::WebviewUrl::App(PathBuf::from("viewer.html")),
    )
    .title("riida viewer")
    .inner_size(1320.0, 860.0)
    .min_inner_size(960.0, 640.0)
    .initialization_script(&init_script)
    .build()
    .map_err(|e| e.to_string())?;

    Ok(label)
}

#[tauri::command]
fn rename_tag_globally(old_tag: String, new_tag: String) -> Result<u64, String> {
    let mut connection = lock_database()?;
    rename_book_tag(&mut connection, &old_tag, &new_tag)
}

#[tauri::command]
fn delete_tag_globally(tag: String) -> Result<u64, String> {
    let connection = lock_database()?;
    delete_book_tag(&connection, &tag)
}

/// Image-sequence fixed-layout EPUB detection; see `riida_core::epub_image`.
#[tauri::command]
fn epub_image_layout(file_path: String) -> Result<epub_image::EpubImageLayout, String> {
    epub_image::epub_image_layout(&file_path)
}

#[tauri::command]
fn extract_epub_metadata(file_path: String) -> Result<EpubMetadataPayload, String> {
    let epub_path = PathBuf::from(&file_path);
    if !is_epub_file(&epub_path) {
        return Err("not an EPUB file".to_string());
    }
    let file = fs::File::open(&epub_path).map_err(|e| e.to_string())?;
    let mut archive = ZipArchive::new(file).map_err(|e| e.to_string())?;
    let opf_path = epub_opf_path(&mut archive)?;
    epub_extract_opf_metadata(&mut archive, &opf_path)
}

#[tauri::command]
fn load_book_metadata(file_path: String) -> Result<BookMetadataPayload, String> {
    let connection = lock_database()?;
    let (table_name, file_path_filter) =
        if file_path.starts_with("kindle:") || file_path.starts_with("custom:") {
            ("external_books", "")
        } else {
            ("book_metadata", "")
        };
    let mut statement = connection
        .prepare(&format!(
            "
                SELECT
                  title,
                  authors_json,
                  description,
                  publisher,
                  release_date,
                  language,
                  url,
                  asin,
                  cover_url,
                  updated_at
                FROM {table_name}
                WHERE {file_path_filter}file_path = ?1
                "
        ))
        .map_err(|error| error.to_string())?;

    let metadata = statement.query_row(params![&file_path], |row| {
        let authors_json: String = row.get(1)?;
        let authors = serde_json::from_str::<Vec<String>>(&authors_json).unwrap_or_default();
        Ok(BookMetadataPayload {
            file_path: file_path.clone(),
            title: row.get(0)?,
            authors,
            description: row.get(2)?,
            publisher: row.get(3)?,
            release_date: row.get(4)?,
            language: row.get(5)?,
            url: row.get(6)?,
            asin: row.get(7)?,
            cover_url: row.get(8)?,
            updated_at: Some(row.get(9)?),
        })
    });

    match metadata {
        Ok(metadata) => Ok(metadata),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(BookMetadataPayload {
            file_path,
            title: String::new(),
            authors: Vec::new(),
            description: String::new(),
            publisher: String::new(),
            release_date: String::new(),
            language: String::new(),
            url: String::new(),
            asin: String::new(),
            cover_url: String::new(),
            updated_at: None,
        }),
        Err(error) => Err(error.to_string()),
    }
}

#[tauri::command]
fn save_book_metadata(input: BookMetadataInput) -> Result<BookMetadataPayload, String> {
    let connection = lock_database()?;
    let input_source_type = input.source_type.clone();
    let mut payload = normalize_book_metadata(input)?;
    let updated_at = std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_secs();
    let authors_json =
        serde_json::to_string(&payload.authors).map_err(|error| error.to_string())?;
    if payload.file_path.starts_with("kindle:") || payload.file_path.starts_with("custom:") {
        let source_type = if payload.file_path.starts_with("kindle:") {
            "kindle".to_string()
        } else {
            input_source_type.ok_or("source_type required for custom books")?
        };
        connection
            .execute(
                "
                INSERT INTO external_books (
                  file_path,
                  source_type,
                  title,
                  authors_json,
                  description,
                  publisher,
                  release_date,
                  language,
                  url,
                  asin,
                  cover_url,
                  updated_at
                )
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
                ON CONFLICT(file_path) DO UPDATE SET
                  title = excluded.title,
                  authors_json = excluded.authors_json,
                  description = excluded.description,
                  publisher = excluded.publisher,
                  release_date = excluded.release_date,
                  language = excluded.language,
                  url = excluded.url,
                  asin = excluded.asin,
                  cover_url = excluded.cover_url,
                  updated_at = excluded.updated_at
                ",
                params![
                    &payload.file_path,
                    &source_type,
                    &payload.title,
                    &authors_json,
                    &payload.description,
                    &payload.publisher,
                    &payload.release_date,
                    &payload.language,
                    &payload.url,
                    &payload.asin,
                    &payload.cover_url,
                    updated_at
                ],
            )
            .map_err(|error| error.to_string())?;
    } else {
        connection
            .execute(
                "
                INSERT INTO book_metadata (
                  file_path,
                  title,
                  authors_json,
                  description,
                  publisher,
                  release_date,
                  language,
                  url,
                  asin,
                  cover_url,
                  updated_at
                )
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
                ON CONFLICT(file_path) DO UPDATE SET
                  title = excluded.title,
                  authors_json = excluded.authors_json,
                  description = excluded.description,
                  publisher = excluded.publisher,
                  release_date = excluded.release_date,
                  language = excluded.language,
                  url = excluded.url,
                  asin = excluded.asin,
                  cover_url = excluded.cover_url,
                  updated_at = excluded.updated_at
                ",
                params![
                    &payload.file_path,
                    &payload.title,
                    &authors_json,
                    &payload.description,
                    &payload.publisher,
                    &payload.release_date,
                    &payload.language,
                    &payload.url,
                    &payload.asin,
                    &payload.cover_url,
                    updated_at
                ],
            )
            .map_err(|error| error.to_string())?;
    }

    payload.updated_at = Some(updated_at);
    fulltext_on_metadata_changed(&connection, &payload.file_path);
    Ok(payload)
}

#[tauri::command]
fn delete_book_metadata(file_path: String) -> Result<(), String> {
    let connection = lock_database()?;

    if file_path.starts_with("kindle:") || file_path.starts_with("custom:") {
        connection
            .execute(
                "DELETE FROM external_books WHERE file_path = ?1",
                params![&file_path],
            )
            .map_err(|error| error.to_string())?;
        connection
            .execute(
                "DELETE FROM book_tags WHERE file_path = ?1",
                params![&file_path],
            )
            .map_err(|error| error.to_string())?;
        connection
            .execute(
                "DELETE FROM notes WHERE file_path = ?1",
                params![&file_path],
            )
            .map_err(|error| error.to_string())?;
        connection
            .execute(
                "DELETE FROM reading_positions WHERE file_path = ?1",
                params![&file_path],
            )
            .map_err(|error| error.to_string())?;
        connection
            .execute(
                "DELETE FROM viewer_preferences WHERE file_path = ?1 OR scope_key = ?1",
                params![&file_path],
            )
            .map_err(|error| error.to_string())?;
    } else {
        connection
            .execute(
                "DELETE FROM book_metadata WHERE file_path = ?1",
                params![&file_path],
            )
            .map_err(|error| error.to_string())?;
    }

    if file_path.starts_with("kindle:") || file_path.starts_with("custom:") {
        // External book entry removed entirely.
        fulltext_on_book_removed(&file_path);
    } else {
        // Local book stays; only its saved metadata was cleared.
        fulltext_on_metadata_changed(&connection, &file_path);
    }

    Ok(())
}

#[tauri::command]
fn save_custom_source(
    id: Option<String>,
    name: String,
    icon: String,
) -> Result<CustomSource, String> {
    let connection = lock_database()?;
    let source_id = id.unwrap_or_else(uuid_v4);
    let created_at = std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_secs();
    connection
        .execute(
            "
            INSERT INTO custom_sources (id, name, icon, created_at)
            VALUES (?1, ?2, ?3, ?4)
            ON CONFLICT(id) DO UPDATE SET
              name = excluded.name,
              icon = excluded.icon
            ",
            params![&source_id, &name, &icon, created_at],
        )
        .map_err(|error| error.to_string())?;
    Ok(CustomSource {
        id: source_id,
        name,
        icon,
    })
}

#[tauri::command]
fn delete_custom_source(id: String) -> Result<(), String> {
    let connection = lock_database()?;
    // Collect file_paths of books in this source before deleting
    let mut stmt = connection
        .prepare("SELECT file_path FROM external_books WHERE source_type = ?1")
        .map_err(|error| error.to_string())?;
    let file_paths: Vec<String> = stmt
        .query_map(params![&id], |row| row.get(0))
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    for fp in &file_paths {
        connection
            .execute("DELETE FROM book_tags WHERE file_path = ?1", params![fp])
            .map_err(|error| error.to_string())?;
        connection
            .execute("DELETE FROM notes WHERE file_path = ?1", params![fp])
            .map_err(|error| error.to_string())?;
        connection
            .execute(
                "DELETE FROM reading_positions WHERE file_path = ?1",
                params![fp],
            )
            .map_err(|error| error.to_string())?;
        connection
            .execute(
                "DELETE FROM viewer_preferences WHERE file_path = ?1 OR scope_key = ?1",
                params![fp],
            )
            .map_err(|error| error.to_string())?;
        fulltext_on_book_removed(fp);
    }
    connection
        .execute(
            "DELETE FROM external_books WHERE source_type = ?1",
            params![&id],
        )
        .map_err(|error| error.to_string())?;
    connection
        .execute("DELETE FROM custom_sources WHERE id = ?1", params![&id])
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
fn list_shelves() -> Result<Vec<Shelf>, String> {
    let connection = lock_database()?;
    let mut stmt = connection
        .prepare(
            "
            SELECT id, name, query, icon, sort_order, created_at, updated_at
            FROM shelves
            ORDER BY sort_order ASC, created_at ASC
            ",
        )
        .map_err(|error| error.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok(Shelf {
                id: row.get(0)?,
                name: row.get(1)?,
                query: row.get(2)?,
                icon: row.get(3)?,
                sort_order: row.get(4)?,
                created_at: row.get::<_, i64>(5)? as u64,
                updated_at: row.get::<_, i64>(6)? as u64,
            })
        })
        .map_err(|error| error.to_string())?;
    let shelves = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    Ok(shelves)
}

#[tauri::command]
fn save_shelf(draft: ShelfDraft) -> Result<Shelf, String> {
    let name = draft.name.trim().to_string();
    if name.is_empty() {
        return Err("Shelf name must not be empty".to_string());
    }
    let query = draft.query.trim().to_string();
    if query.is_empty() {
        return Err("Shelf query must not be empty".to_string());
    }
    let now = std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_secs();
    let connection = lock_database()?;

    if let Some(id) = draft.id {
        connection
            .execute(
                "
                UPDATE shelves SET
                  name = ?2,
                  query = ?3,
                  icon = ?4,
                  updated_at = ?5
                WHERE id = ?1
                ",
                params![&id, &name, &query, &draft.icon, now as i64],
            )
            .map_err(|error| error.to_string())?;
        let mut stmt = connection
            .prepare(
                "
                SELECT id, name, query, icon, sort_order, created_at, updated_at
                FROM shelves WHERE id = ?1
                ",
            )
            .map_err(|error| error.to_string())?;
        let shelf = stmt
            .query_row(params![&id], |row| {
                Ok(Shelf {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    query: row.get(2)?,
                    icon: row.get(3)?,
                    sort_order: row.get(4)?,
                    created_at: row.get::<_, i64>(5)? as u64,
                    updated_at: row.get::<_, i64>(6)? as u64,
                })
            })
            .map_err(|error| error.to_string())?;
        return Ok(shelf);
    }

    let id = uuid_v4();
    let next_order: i64 = connection
        .query_row(
            "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM shelves",
            [],
            |row| row.get(0),
        )
        .unwrap_or(0);
    connection
        .execute(
            "
            INSERT INTO shelves (id, name, query, icon, sort_order, created_at, updated_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
            ",
            params![&id, &name, &query, &draft.icon, next_order, now as i64],
        )
        .map_err(|error| error.to_string())?;
    Ok(Shelf {
        id,
        name,
        query,
        icon: draft.icon,
        sort_order: next_order,
        created_at: now,
        updated_at: now,
    })
}

#[tauri::command]
fn delete_shelf(id: String) -> Result<(), String> {
    let connection = lock_database()?;
    connection
        .execute("DELETE FROM shelves WHERE id = ?1", params![&id])
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
fn reorder_shelves(ids: Vec<String>) -> Result<(), String> {
    let mut connection = lock_database()?;
    let tx = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    for (index, id) in ids.iter().enumerate() {
        tx.execute(
            "UPDATE shelves SET sort_order = ?2 WHERE id = ?1",
            params![id, index as i64],
        )
        .map_err(|error| error.to_string())?;
    }
    tx.commit().map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
fn load_reading_position(file_path: String) -> Result<Option<ReadingPosition>, String> {
    let connection = lock_database()?;
    let mut statement = connection
        .prepare(
            "
            SELECT
              page_number,
              page_offset_ratio,
              cfi,
              updated_at
            FROM reading_positions
            WHERE file_path = ?1
            ",
        )
        .map_err(|error| error.to_string())?;

    let position = statement.query_row(params![&file_path], |row| {
        Ok(ReadingPosition {
            file_path: file_path.clone(),
            page_number: row.get(0)?,
            page_offset_ratio: row.get(1)?,
            cfi: row.get(2)?,
            updated_at: Some(row.get(3)?),
        })
    });

    match position {
        Ok(position) => Ok(Some(position)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

#[tauri::command]
fn save_reading_position(
    file_path: String,
    page_number: u32,
    page_offset_ratio: f64,
) -> Result<ReadingPosition, String> {
    let connection = lock_database()?;
    let updated_at = std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_secs();
    let normalized_ratio = normalize_page_offset_ratio(page_offset_ratio);

    connection
        .execute(
            "
            INSERT INTO reading_positions (file_path, page_number, page_offset_ratio, updated_at)
            VALUES (?1, ?2, ?3, ?4)
            ON CONFLICT(file_path) DO UPDATE SET
              page_number = excluded.page_number,
              page_offset_ratio = excluded.page_offset_ratio,
              updated_at = excluded.updated_at
            ",
            params![&file_path, page_number, normalized_ratio, updated_at],
        )
        .map_err(|error| error.to_string())?;

    Ok(ReadingPosition {
        file_path,
        page_number,
        page_offset_ratio: normalized_ratio,
        cfi: None,
        updated_at: Some(updated_at),
    })
}

#[tauri::command]
fn save_epub_position(file_path: String, cfi: String) -> Result<(), String> {
    let connection = lock_database()?;
    let updated_at = std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_secs();

    connection
        .execute(
            "
            INSERT INTO reading_positions (file_path, page_number, page_offset_ratio, cfi, updated_at)
            VALUES (?1, 0, 0.0, ?2, ?3)
            ON CONFLICT(file_path) DO UPDATE SET
              cfi = excluded.cfi,
              updated_at = excluded.updated_at
            ",
            params![&file_path, &cfi, updated_at],
        )
        .map_err(|error| error.to_string())?;

    Ok(())
}

#[tauri::command]
fn load_viewer_preferences(
    file_path: String,
    source_type: String,
) -> Result<ViewerPreferencesPayload, String> {
    let connection = lock_database()?;
    load_viewer_preferences_payload(&connection, Some(&file_path), &source_type)
}

#[tauri::command]
fn save_default_viewer_preferences(
    current_file_path: Option<String>,
    source_type: String,
    preferences: ViewerPreferences,
) -> Result<ViewerPreferencesPayload, String> {
    let connection = lock_database()?;
    let normalized_source_type = normalize_viewer_source_type(&source_type);
    let global_scope_key = viewer_global_scope_key(&normalized_source_type);
    save_viewer_preferences_record(
        &connection,
        &global_scope_key,
        None,
        &normalized_source_type,
        normalize_viewer_preferences(preferences),
    )?;
    load_viewer_preferences_payload(
        &connection,
        current_file_path.as_deref(),
        &normalized_source_type,
    )
}

#[tauri::command]
fn save_file_viewer_preferences(
    file_path: String,
    source_type: String,
    preferences: ViewerPreferences,
) -> Result<ViewerPreferencesPayload, String> {
    let connection = lock_database()?;
    let normalized_source_type = normalize_viewer_source_type(&source_type);
    let global_scope_key = viewer_global_scope_key(&normalized_source_type);
    let global = load_saved_viewer_preferences(&connection, &global_scope_key)?
        .map(normalize_viewer_preferences)
        .unwrap_or_else(default_viewer_preferences);
    let normalized = normalize_viewer_preferences(preferences);
    let stored_preferences = build_file_viewer_preferences_for_storage(&global, normalized);
    let file_scope_key = viewer_file_scope_key(&file_path, &normalized_source_type);
    save_viewer_preferences_record(
        &connection,
        &file_scope_key,
        Some(&file_path),
        &normalized_source_type,
        stored_preferences,
    )?;
    load_viewer_preferences_payload(&connection, Some(&file_path), &normalized_source_type)
}

#[tauri::command]
fn clear_file_viewer_preferences(
    file_path: String,
    source_type: String,
) -> Result<ViewerPreferencesPayload, String> {
    let connection = lock_database()?;
    let normalized_source_type = normalize_viewer_source_type(&source_type);
    let file_scope_key = viewer_file_scope_key(&file_path, &normalized_source_type);
    connection
        .execute(
            "DELETE FROM viewer_preferences WHERE scope_key = ?1",
            params![&file_scope_key],
        )
        .map_err(|error| error.to_string())?;
    load_viewer_preferences_payload(&connection, Some(&file_path), &normalized_source_type)
}

#[tauri::command]
fn get_pdf_password(file_path: String) -> Result<Option<String>, String> {
    let connection = lock_database()?;
    query_pdf_password(&connection, &file_path)
}

#[tauri::command]
fn save_pdf_password(file_path: String, password: String) -> Result<(), String> {
    let connection = lock_database()?;
    upsert_pdf_password(&connection, &file_path, &password)
}

// ---------------------------------------------------------------------------
// Full-text search
// ---------------------------------------------------------------------------

fn current_unix_seconds() -> u64 {
    std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// On-disk location of the tantivy index. Lives in the data dir (not cache) so
/// the expensive body extraction survives a cache clear.
fn fulltext_dir() -> Result<PathBuf, String> {
    Ok(app_paths()?.data_dir.join("fulltext-index"))
}

/// Sentinel marking that the user has opted in and built the index. Created by
/// the build worker, removed by `fulltext_clear_index`. Used instead of the
/// tantivy `meta.json` so a clear can fully disable indexing again.
fn fulltext_built_marker() -> Result<PathBuf, String> {
    Ok(fulltext_dir()?.join(".riida-built"))
}

/// Whether the index has been built at least once (opt-in). Search and all
/// incremental/reconciliation work are no-ops until this is true.
fn fulltext_built() -> bool {
    fulltext_built_marker()
        .map(|marker| marker.exists())
        .unwrap_or(false)
}

fn mark_fulltext_built() {
    if let Ok(marker) = fulltext_built_marker() {
        if let Some(parent) = marker.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let _ = fs::write(&marker, b"");
    }
}

/// Directory to load libpdfium from, resolved at startup. None ⇒ rely on a
/// system library.
fn pdfium_dir() -> Option<PathBuf> {
    PDFIUM_DIR.get().cloned().flatten()
}

/// Lazily open (or create) the process-wide full-text index.
fn fulltext_index() -> Result<&'static fulltext::FullTextIndex, String> {
    if let Some(index) = FULLTEXT.get() {
        return Ok(index);
    }
    let dir = fulltext_dir()?;
    let index = fulltext::FullTextIndex::open_or_create(&dir)?;
    // A concurrent caller may have won the race; either way return the stored one.
    let _ = FULLTEXT.set(index);
    FULLTEXT
        .get()
        .ok_or_else(|| "full-text index unavailable".to_string())
}

/// Index a set of books, extracting bodies in parallel worker processes while
/// this thread builds the cheap metadata/note docs and chunk-commits results
/// as they stream in. `plan` pairs each book with (extract body?, status);
/// `on_book_done` fires once per book, in completion order.
fn index_books_with_pool(
    index: &'static fulltext::FullTextIndex,
    plan: Vec<(&BookIndexInput, bool, &'static str)>,
    mut on_book_done: impl FnMut(&BookIndexInput),
) {
    let mut chunk = FulltextChunk::default();

    // Books without body extraction (external books, deferred online-only
    // placeholders) are indexed inline.
    let mut requests = Vec::new();
    let mut body_books: HashMap<&str, (&BookIndexInput, &'static str)> = HashMap::new();
    for (book, include_body, status) in &plan {
        if *include_body {
            requests.push(extract_request_for_book(book));
            body_books.insert(book.file_path.as_str(), (book, status));
        } else {
            chunk.add(book, status, base_docs_for_book(book));
            if chunk.should_flush() {
                flush_fulltext_chunk(&mut chunk, index);
            }
            on_book_done(book);
        }
    }

    if !requests.is_empty() {
        let workers = fulltext_pool::default_worker_count().min(requests.len());
        let (tx, rx) = std::sync::mpsc::channel();
        let pdfium = pdfium_dir();
        let producer = std::thread::spawn(move || {
            fulltext_pool::run_extraction(requests, workers, pdfium, tx)
        });
        for resp in rx {
            let Some((book, status)) = body_books.get(resp.file_path.as_str()).copied() else {
                continue;
            };
            if let Some(e) = &resp.error {
                // Match the previous inline behavior: an extraction failure
                // still indexes the metadata/note docs and the book counts as
                // indexed (its body is simply absent).
                eprintln!("body extraction failed for {}: {e}", resp.file_path);
            }
            let mut docs = base_docs_for_book(book);
            docs.extend(resp.docs);
            chunk.add(book, status, docs);
            if chunk.should_flush() {
                flush_fulltext_chunk(&mut chunk, index);
            }
            on_book_done(book);
        }
        let _ = producer.join();
    }

    flush_fulltext_chunk(&mut chunk, index);
    if let Err(e) = index.consolidate() {
        eprintln!("fulltext consolidate after bulk indexing failed: {e}");
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct FullTextProgress {
    done: usize,
    total: usize,
    file_path: String,
}

/// Persist a book's index status row.
fn record_fulltext_status(file_path: &str, modified_at: i64, status: &str) {
    if let Ok(connection) = lock_database() {
        let _ = connection.execute(
            "INSERT INTO fulltext_index (file_path, body_modified_at, indexed_at, status, error)
             VALUES (?1, ?2, ?3, ?4, NULL)
             ON CONFLICT(file_path) DO UPDATE SET
               body_modified_at = ?2, indexed_at = ?3, status = ?4, error = NULL",
            params![
                file_path,
                modified_at,
                current_unix_seconds() as i64,
                status
            ],
        );
    }
}

/// Flush a chunk and persist the resulting status rows.
fn flush_fulltext_chunk(chunk: &mut FulltextChunk, index: &fulltext::FullTextIndex) {
    for (path, modified_at, status) in chunk.flush(index) {
        record_fulltext_status(&path, modified_at, status);
    }
}

/// Run a full index (re)build. Gathers inputs under the lock, then extracts
/// bodies in parallel worker processes and indexes lock-free, emitting
/// progress events in completion order. Runs on a worker thread.
/// `include_online_only` forces downloading + indexing the body of cloud
/// placeholder files; otherwise their body is deferred until they are local.
fn run_fulltext_build(app: &AppHandle, include_online_only: bool) -> Result<(), String> {
    let books = {
        let connection = lock_database()?;
        gather_books_for_index(&connection)?
    };
    let total = books.len();

    let index = fulltext_index()?;
    mark_fulltext_built();

    let plan: Vec<(&BookIndexInput, bool, &'static str)> = books
        .iter()
        .map(|book| {
            let (include_body, status) = should_index_body(book, include_online_only);
            (book, include_body, status)
        })
        .collect();

    let mut done = 0usize;
    index_books_with_pool(index, plan, |book| {
        done += 1;
        let _ = app.emit(
            "fulltext-progress",
            FullTextProgress {
                done,
                total,
                file_path: book.file_path.clone(),
            },
        );
    });

    let _ = app.emit("fulltext-complete", total);
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FullTextStatus {
    total: i64,
    indexed: i64,
    /// File-backed books whose body was skipped because they are online-only.
    deferred: i64,
    failed: i64,
    building: bool,
    built: bool,
    /// Disk used by the tantivy index, in bytes.
    index_size_bytes: u64,
}

/// Total size of the on-disk index directory.
fn fulltext_index_size_bytes() -> u64 {
    let Ok(dir) = fulltext_dir() else {
        return 0;
    };
    WalkDir::new(dir)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|e| e.file_type().is_file())
        .filter_map(|e| e.metadata().ok())
        .map(|m| m.len())
        .sum()
}

#[tauri::command]
fn fulltext_index_status() -> Result<FullTextStatus, String> {
    let connection = lock_database()?;
    let total: i64 = connection
        .query_row(
            "SELECT (SELECT COUNT(*) FROM books) + (SELECT COUNT(*) FROM external_books)",
            [],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    let count_status = |status: &str| -> Result<i64, String> {
        connection
            .query_row(
                "SELECT COUNT(*) FROM fulltext_index WHERE status = ?1",
                params![status],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())
    };
    Ok(FullTextStatus {
        total,
        indexed: count_status("indexed")?,
        deferred: count_status("deferred")?,
        failed: count_status("failed")?,
        building: FULLTEXT_BUILDING.load(std::sync::atomic::Ordering::SeqCst),
        built: fulltext_built(),
        index_size_bytes: fulltext_index_size_bytes(),
    })
}

/// Opt-in trigger: (re)build the whole index in the background. Returns
/// immediately; progress arrives via `fulltext-progress` / `fulltext-complete`.
/// `include_online_only` downloads + indexes the body of cloud placeholder
/// files instead of deferring them.
#[tauri::command]
fn fulltext_build_index(app: AppHandle, include_online_only: Option<bool>) -> Result<(), String> {
    use std::sync::atomic::Ordering;
    if FULLTEXT_BUILDING.swap(true, Ordering::SeqCst) {
        return Err("full-text index build already in progress".to_string());
    }
    let include_online_only = include_online_only.unwrap_or(false);
    std::thread::spawn(move || {
        if let Err(e) = run_fulltext_build(&app, include_online_only) {
            eprintln!("full-text index build failed: {e}");
            let _ = app.emit("fulltext-error", e);
        }
        FULLTEXT_BUILDING.store(false, Ordering::SeqCst);
    });
    Ok(())
}

/// Empty the index and disable it again (frees disk; returns to the opt-in
/// "not built" state). A no-op if a build is in progress.
#[tauri::command]
fn fulltext_clear_index() -> Result<(), String> {
    use std::sync::atomic::Ordering;
    if FULLTEXT_BUILDING.load(Ordering::SeqCst) {
        return Err("cannot clear while the index is building".to_string());
    }
    if let Ok(index) = fulltext_index() {
        index.delete_all()?;
    }
    if let Ok(connection) = lock_database() {
        let _ = connection.execute("DELETE FROM fulltext_index", []);
    }
    if let Ok(marker) = fulltext_built_marker() {
        let _ = fs::remove_file(marker);
    }
    Ok(())
}

/// After a library scan, reconcile the index with added/removed/changed files —
/// but only if the user already opted in by building the index. Runs in the
/// background so the scan/snapshot path is never blocked, and is a no-op when a
/// full build or another sync is already running.
fn fulltext_sync_after_scan() {
    use std::sync::atomic::Ordering;
    if !fulltext_built() || FULLTEXT_BUILDING.load(Ordering::SeqCst) {
        return;
    }
    if FULLTEXT_SYNCING.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::spawn(move || {
        if let Err(e) = run_fulltext_sync() {
            eprintln!("full-text incremental sync failed: {e}");
        }
        FULLTEXT_SYNCING.store(false, Ordering::SeqCst);
    });
}

fn run_fulltext_sync() -> Result<(), String> {
    // Snapshot the current library and the index's per-file record under the lock.
    let (books, indexed) = {
        let connection = lock_database()?;
        let books = gather_books_for_index(&connection)?;
        let mut stmt = connection
            .prepare("SELECT file_path, COALESCE(body_modified_at, 0), status FROM fulltext_index")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    (row.get::<_, i64>(1)?, row.get::<_, String>(2)?),
                ))
            })
            .map_err(|e| e.to_string())?;
        let mut indexed: HashMap<String, (i64, String)> = HashMap::new();
        for row in rows {
            let (path, value) = row.map_err(|e| e.to_string())?;
            indexed.insert(path, value);
        }
        (books, indexed)
    };

    let current: HashSet<&str> = books.iter().map(|b| b.file_path.as_str()).collect();
    let index = fulltext_index()?;

    // Removed: recorded in the index but no longer present in the library.
    for path in indexed.keys().filter(|p| !current.contains(p.as_str())) {
        let _ = index.delete_book(path);
        if let Ok(connection) = lock_database() {
            let _ = connection.execute(
                "DELETE FROM fulltext_index WHERE file_path = ?1",
                params![path],
            );
        }
    }

    // File-backed books that are new, changed, or were deferred and are now local.
    // Online-only files are never downloaded here (incremental sync stays cheap);
    // their body waits until they are local.
    let to_index: Vec<(&BookIndexInput, bool)> = books
        .iter()
        .filter(|b| b.is_pdf() || b.is_epub())
        .filter_map(|b| {
            let dataless = is_dataless(&b.file_path);
            if sync_needs_reindex(b, indexed.get(&b.file_path), dataless) {
                Some((b, dataless))
            } else {
                None
            }
        })
        .collect();
    if to_index.is_empty() {
        return Ok(());
    }

    // Sync never force-downloads: a still-online-only file is body-deferred.
    // (Only PDF/EPUB reach here, so body is wanted iff the file is local.)
    let plan: Vec<(&BookIndexInput, bool, &'static str)> = to_index
        .into_iter()
        .map(|(book, dataless)| {
            let include_body = !dataless;
            let status = if include_body { "indexed" } else { "deferred" };
            (book, include_body, status)
        })
        .collect();
    index_books_with_pool(index, plan, |_| {});
    Ok(())
}

#[tauri::command]
fn search_fulltext(
    query: String,
    limit: Option<u32>,
) -> Result<Vec<fulltext::FullTextHit>, String> {
    if !fulltext_built() {
        return Ok(Vec::new());
    }
    let index = fulltext_index()?;
    index.search(&query, limit.unwrap_or(50) as usize)
}

// --- incremental updates (run while the caller still holds the DB lock, so
// these take &Connection and must never re-lock) --------------------------

/// Repair the index in the background at startup. Quitting (or crashing)
/// mid-build drops per-chunk writers whose in-flight merges abort, stranding
/// superseded segment files — and the incremental sync never touches a book
/// that is already up to date, so nothing else would ever reclaim that space.
/// `consolidate` is a near-no-op on an already-compact index, so this is cheap
/// in the common case. Skipped entirely until the user opts in to indexing.
fn fulltext_consolidate_on_startup() {
    if !fulltext_built() {
        return;
    }
    std::thread::spawn(|| {
        let Ok(index) = fulltext_index() else {
            return;
        };
        if let Err(e) = index.consolidate() {
            eprintln!("fulltext startup consolidate failed: {e}");
        }
    });
}

/// An index mutation queued by a save hook.
enum FulltextHookOp {
    Index(Vec<fulltext::ContentDoc>),
    DeleteKind(String, fulltext::ContentKind),
    DeleteBook(String),
}

static FULLTEXT_HOOK_TX: OnceLock<std::sync::mpsc::Sender<FulltextHookOp>> = OnceLock::new();

/// Queue an index mutation for the single background worker. The hooks run
/// while their caller holds the global database lock, and a tantivy commit
/// costs ~100 ms (segment flush + fsync + reader reload) — far too slow to run
/// inline on every debounced note autosave. One worker applies ops strictly in
/// send order, so a stale save can never overwrite a newer one.
fn fulltext_enqueue(op: FulltextHookOp) {
    let tx = FULLTEXT_HOOK_TX.get_or_init(|| {
        let (tx, rx) = std::sync::mpsc::channel::<FulltextHookOp>();
        std::thread::spawn(move || {
            for op in rx {
                let Ok(index) = fulltext_index() else {
                    continue;
                };
                let result = match &op {
                    FulltextHookOp::Index(docs) => index.index_docs(docs),
                    FulltextHookOp::DeleteKind(path, kind) => index.delete_kind(path, *kind),
                    FulltextHookOp::DeleteBook(path) => index.delete_book(path),
                };
                if let Err(e) = result {
                    eprintln!("fulltext hook update failed: {e}");
                }
            }
        });
        tx
    });
    let _ = tx.send(op);
}

/// Re-index a book's metadata doc after a metadata/tag edit (no body re-extract).
fn fulltext_on_metadata_changed(connection: &Connection, file_path: &str) {
    if !fulltext_built() {
        return;
    }
    let Some(doc) = fulltext_metadata_doc(connection, file_path) else {
        return;
    };
    fulltext_enqueue(FulltextHookOp::Index(vec![doc]));
}

/// Re-index (or clear) a book's note doc after a note edit.
fn fulltext_on_note_changed(connection: &Connection, file_path: &str, content: &str) {
    if !fulltext_built() {
        return;
    }
    if content.trim().is_empty() {
        fulltext_enqueue(FulltextHookOp::DeleteKind(
            file_path.to_owned(),
            fulltext::ContentKind::Note,
        ));
        return;
    }
    let title = fulltext_metadata_doc(connection, file_path)
        .map(|doc| doc.title)
        .unwrap_or_else(|| file_path.to_owned());
    let note_doc = fulltext_extract::build_note_doc(file_path, &title, content);
    fulltext_enqueue(FulltextHookOp::Index(vec![note_doc]));
}

/// Remove a book entirely from the index (book deleted from the library).
fn fulltext_on_book_removed(file_path: &str) {
    if !fulltext_built() {
        return;
    }
    fulltext_enqueue(FulltextHookOp::DeleteBook(file_path.to_owned()));
}

/// Build the HTTP response for a `riida-epub` image request. `query` is the raw
/// URL query (`file=<enc abs path>&entry=<enc zip entry>`); `home`, when set,
/// confines reads to that directory (mirrors the asset-protocol `$HOME/**` scope).
fn serve_epub_image(query: &str, home: Option<&Path>) -> tauri::http::Response<Vec<u8>> {
    use tauri::http::{header, Response, StatusCode};

    let empty = |status: StatusCode| {
        Response::builder()
            .status(status)
            .body(Vec::new())
            .expect("static response builds")
    };

    let mut file = None;
    let mut entry = None;
    for pair in query.split('&') {
        let mut kv = pair.splitn(2, '=');
        let key = kv.next().unwrap_or("");
        let val = kv.next().unwrap_or("");
        match key {
            "file" => file = Some(epub_image::percent_decode(val)),
            "entry" => entry = Some(epub_image::percent_decode(val)),
            _ => {}
        }
    }
    let (Some(file), Some(entry)) = (file, entry) else {
        return empty(StatusCode::BAD_REQUEST);
    };

    // Confine reads to the user's home directory so the scheme cannot be abused
    // as an arbitrary-file-read endpoint.
    if let Some(home) = home {
        let inside = std::fs::canonicalize(&file)
            .map(|p| p.starts_with(home))
            .unwrap_or(false);
        if !inside {
            return empty(StatusCode::FORBIDDEN);
        }
    }

    match epub_image::read_zip_entry(&file, &entry) {
        Ok(bytes) => Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, epub_image::content_type_for(&entry))
            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
            .header(header::CACHE_CONTROL, "no-cache")
            .body(bytes)
            .expect("image response builds"),
        Err(_) => empty(StatusCode::NOT_FOUND),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let paths = resolve_app_paths()?;
            let _ = APP_PATHS.set(paths.clone());
            // Resolve libpdfium's location once: the dev shell sets
            // PDFIUM_LIB_DIR; a release build finds it in the bundled resource
            // dir. `bind_pdfium` falls back to a system library if neither has it.
            let pdfium_dir = std::env::var("PDFIUM_LIB_DIR")
                .ok()
                .map(PathBuf::from)
                .or_else(|| app.path().resource_dir().ok().map(|dir| dir.join("pdfium")));
            let _ = PDFIUM_DIR.set(pdfium_dir);
            prepare_storage(&paths)?;
            initialize_database()?;
            migrate_legacy_config_if_needed(&paths.config_file)?;
            let config = load_config()?;
            start_library_watcher(app.handle().clone(), config.clone())?;
            app.manage(ConfigState {
                config: Mutex::new(config),
            });
            app.manage(start_thumbnail_worker(app.handle().clone()));
            fulltext_consolidate_on_startup();
            Ok(())
        })
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri::plugin::Builder::<tauri::Wry, ()>::new("riida-epub-navigation")
                .on_navigation(|webview, url| {
                    if should_allow_internal_navigation(url) {
                        return true;
                    }

                    match url.scheme() {
                        // EPUB iframe external links do not reliably open from WKWebView.
                        // Route them through the system opener and cancel the embedded
                        // navigation so the reader content stays intact.
                        "http" | "https" | "mailto" | "tel" => {
                            let _ = webview.opener().open_url(url.as_str(), None::<String>);
                            false
                        }
                        _ => true,
                    }
                })
                .build(),
        )
        .plugin(tauri_plugin_opener::init())
        // Serve individual page images out of an image-sequence fixed-layout
        // EPUB zip without unzipping the whole archive in JS. The frontend image
        // viewer points <img src> at riida-epub://localhost/img?file=..&entry=..
        .register_asynchronous_uri_scheme_protocol("riida-epub", |ctx, request, responder| {
            let home = ctx
                .app_handle()
                .path()
                .home_dir()
                .ok()
                .map(|h| std::fs::canonicalize(&h).unwrap_or(h));
            let query = request.uri().query().unwrap_or("").to_owned();
            std::thread::spawn(move || {
                responder.respond(serve_epub_image(&query, home.as_deref()))
            });
        })
        .invoke_handler(tauri::generate_handler![
            library_snapshot,
            load_library_snapshot,
            load_app_config,
            save_app_config,
            add_library_root,
            book_thumbnail,
            load_note,
            save_note,
            save_book_tags,
            rename_tag_globally,
            delete_tag_globally,
            extract_epub_metadata,
            epub_image_layout,
            load_book_metadata,
            save_book_metadata,
            delete_book_metadata,
            save_custom_source,
            delete_custom_source,
            list_shelves,
            save_shelf,
            delete_shelf,
            reorder_shelves,
            load_reading_position,
            save_reading_position,
            save_epub_position,
            load_viewer_preferences,
            save_default_viewer_preferences,
            save_file_viewer_preferences,
            clear_file_viewer_preferences,
            get_pdf_password,
            save_pdf_password,
            open_viewer_window,
            search_fulltext,
            fulltext_index_status,
            fulltext_build_index,
            fulltext_clear_index
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;
    use riida_core::config::{normalize_config_input, AppConfigFile};

    // Mirror encodeURIComponent for the riida-epub query test below.
    fn percent_encode_component(s: &str) -> String {
        s.bytes()
            .map(|b| {
                if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
                    (b as char).to_string()
                } else {
                    format!("%{b:02X}")
                }
            })
            .collect()
    }

    #[test]
    fn serve_epub_image_serves_zip_entry_and_enforces_scope() {
        use std::io::Write;
        use zip::write::SimpleFileOptions;

        let dir =
            std::env::temp_dir().join(format!("riida-epub-image-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let zip_path = dir.join("book.epub");
        {
            let file = std::fs::File::create(&zip_path).unwrap();
            let mut zip = zip::ZipWriter::new(file);
            zip.start_file("item/image/a.jpg", SimpleFileOptions::default())
                .unwrap();
            zip.write_all(&[0xFF, 0xD8, 0xFF, 0xD9]).unwrap();
            zip.finish().unwrap();
        }
        // canonicalize so the scope check (which canonicalizes the file) matches
        // on platforms where temp_dir is a symlink (macOS /var -> /private/var).
        let home = std::fs::canonicalize(&dir).unwrap();
        let query = format!(
            "file={}&entry={}",
            percent_encode_component(&zip_path.to_string_lossy()),
            percent_encode_component("item/image/a.jpg"),
        );

        let ok = serve_epub_image(&query, Some(&home));
        assert_eq!(ok.status(), 200);
        assert_eq!(ok.headers().get("content-type").unwrap(), "image/jpeg");
        assert_eq!(ok.body(), &vec![0xFF, 0xD8, 0xFF, 0xD9]);

        // A file outside the allowed home directory is rejected.
        let elsewhere = home.join("nope");
        let forbidden = serve_epub_image(&query, Some(&elsewhere));
        assert_eq!(forbidden.status(), 403);

        // Missing parameters are a bad request; a missing entry is a 404.
        assert_eq!(serve_epub_image("file=x", None).status(), 400);
        let missing = format!(
            "file={}&entry={}",
            percent_encode_component(&zip_path.to_string_lossy()),
            percent_encode_component("item/image/missing.jpg"),
        );
        assert_eq!(serve_epub_image(&missing, Some(&home)).status(), 404);

        std::fs::remove_dir_all(&dir).ok();
    }

    use std::{fs, path::PathBuf};

    fn unique_temp_dir(label: &str) -> PathBuf {
        // A timestamp alone is not unique: macOS reports `SystemTime::now()`
        // at microsecond resolution, and nextest starts tests in parallel
        // processes, so two tests launched in the same microsecond shared a
        // directory and raced over its files. The process id separates
        // nextest's per-test processes; the counter separates threads within
        // one process (`cargo test`).
        static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "riida-test-{label}-{}-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
            std::time::SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("time should move forward")
                .as_nanos()
        ));
        fs::create_dir_all(&path).expect("temp dir should be created");
        path
    }

    #[test]
    fn development_app_paths_use_repository_storage_layout() {
        let root = unique_temp_dir("development-app-paths");
        let paths = development_app_paths(&root);

        assert_eq!(paths.config_file, root.join(CONFIG_FILE));
        assert_eq!(paths.data_dir, root.join("data"));
        assert_eq!(paths.database_file, root.join("data").join("app.db"));
        assert_eq!(paths.cache_dir, root.join("cache"));
        assert_eq!(paths.thumbnail_root, root.join("cache").join("thumbnails"));
        assert!(paths
            .legacy_thumbnail_roots
            .contains(&root.join("data").join("thumbnails")));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn add_library_root_error_serializes_for_the_frontend() {
        assert_eq!(
            serde_json::to_value(AddLibraryRootError::Rejected {
                reason: LibraryRootRejection::NotADirectory,
            })
            .unwrap(),
            serde_json::json!({ "kind": "rejected", "reason": "notADirectory" })
        );
        assert_eq!(
            serde_json::to_value(AddLibraryRootError::Rejected {
                reason: LibraryRootRejection::OutsideHome,
            })
            .unwrap(),
            serde_json::json!({ "kind": "rejected", "reason": "outsideHome" })
        );
        assert_eq!(
            serde_json::to_value(AddLibraryRootError::Rejected {
                reason: LibraryRootRejection::AlreadyInLibrary,
            })
            .unwrap(),
            serde_json::json!({ "kind": "rejected", "reason": "alreadyInLibrary" })
        );
        assert_eq!(
            serde_json::to_value(AddLibraryRootError::from("disk full".to_string())).unwrap(),
            serde_json::json!({ "kind": "failed", "message": "disk full" })
        );
    }

    #[test]
    fn app_config_to_payload_collapses_home_paths() {
        let home = std::env::var("HOME").expect("HOME should exist for tests");
        let payload = app_config_to_payload(&AppConfig {
            library_roots: vec![
                format!("{home}/Documents/Ebooks"),
                "/tmp/library".to_string(),
            ],
            excluded_patterns: vec!["**/backup/**".to_string()],
            pdf_renderer: "pdfjs".to_string(),
            theme: "snow-white".to_string(),
            enabled_external_sources: vec!["kindle".to_string()],
        });

        assert_eq!(
            payload.library_roots,
            vec!["~/Documents/Ebooks".to_string(), "/tmp/library".to_string()]
        );
        assert_eq!(payload.excluded_patterns, vec!["**/backup/**".to_string()]);
        assert_eq!(payload.pdf_renderer, "pdfjs");
        assert_eq!(payload.theme, "snow-white");
    }

    #[test]
    fn database_file_requires_initialized_app_paths() {
        let error =
            database_file().expect_err("database_file should fail without initialized paths");
        assert!(error.contains("application paths have not been initialized"));
    }

    #[test]
    fn project_root_points_to_repository_root() {
        let root = project_root();

        // This asserts the real repository layout. Tools like cargo-mutants run
        // tests from a sandbox copy of the crate alone, where these repo-root
        // files are absent; skip there rather than fail.
        if !root.join("package.json").exists() {
            return;
        }

        assert!(root.exists());
        assert!(root.join("package.json").exists());
        assert!(root.join("src-tauri").is_dir());
    }

    #[test]
    fn config_and_thumbnail_paths_fall_back_under_project_root() {
        let root = project_root();

        assert_eq!(config_file(), root.join(CONFIG_FILE));
        assert_eq!(thumbnail_root(), root.join("data").join("thumbnails"));
    }

    #[test]
    fn load_config_file_reads_and_normalizes_existing_config_file() {
        let config_path = project_root().join("riida.toml.example");
        // Skip when the repo-root fixture is absent (e.g. a cargo-mutants
        // sandbox that copies only the crate); the per-push gate runs it fully.
        if !config_path.exists() {
            return;
        }
        let config_contents =
            fs::read_to_string(&config_path).expect("example config file should be readable");
        let file_config: AppConfigFile =
            toml::from_str(&config_contents).expect("example config file should parse");
        let expected = normalize_config_input(file_config);
        let loaded = load_config_file(&config_path).expect("load_config_file should succeed");

        assert_eq!(loaded.library_roots, expected.library_roots);
        assert_eq!(loaded.excluded_patterns, expected.excluded_patterns);
        assert_eq!(loaded.pdf_renderer, expected.pdf_renderer);
    }

    #[test]
    fn should_allow_internal_navigation_classifies_schemes() {
        let allow = |u: &str| should_allow_internal_navigation(&Url::parse(u).unwrap());

        for scheme in ["tauri", "about", "blob", "data", "file", "asset", "ipc"] {
            assert!(
                allow(&format!("{scheme}://host/path")),
                "scheme {scheme} should be allowed"
            );
        }

        // http(s) only for known local hosts.
        assert!(allow("http://localhost/app"));
        assert!(allow("https://asset.localhost/x"));
        assert!(allow("http://127.0.0.1/x"));
        assert!(!allow("https://example.com/x"));

        // Unknown scheme is rejected.
        assert!(!allow("ftp://localhost/x"));
    }

    #[test]
    fn should_allow_internal_navigation_allows_windows_localhost_subdomains() {
        let allow = |u: &str| should_allow_internal_navigation(&Url::parse(u).unwrap());

        // Rejecting these cancelled the app's own startup navigation on Windows
        // and handed it to the system browser, leaving the window blank.
        assert!(allow("http://tauri.localhost/"));
        assert!(allow("https://tauri.localhost/"));
        assert!(allow("http://ipc.localhost/"));
        assert!(allow("http://riida-epub.localhost/img?file=a&entry=b"));

        // The suffix must fall on a label boundary.
        assert!(!allow("https://tauri.localhost.example.com/"));
        assert!(!allow("https://notlocalhost/"));
    }
}
