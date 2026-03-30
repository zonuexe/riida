use notify::{Config, Event, RecommendedWatcher, RecursiveMode, Watcher};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::{
    collections::{hash_map::DefaultHasher, HashSet},
    fs,
    hash::{Hash, Hasher},
    path::{Path, PathBuf},
    process::Command,
    sync::{mpsc, Arc, Mutex},
    thread,
    time::{Duration, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Manager, State};
use walkdir::WalkDir;

const DEFAULT_WATCH_ROOT: &str = "/Users/megurine/Dropbox/EBook/";
const CONFIG_FILE: &str = "riida.toml";
const DEFAULT_EXCLUDED_DIR_NAMES: &[&str] = &["backup"];
const DEFAULT_EXCLUDED_FILE_SUFFIXES: &[&str] = &[".bak"];
const DEFAULT_PDF_RENDERER: &str = "native";
const VIEWER_DEFAULT_SCOPE_KEY: &str = "__default__";
const DEFAULT_VIEWER_PAGE_MODE: &str = "spread";
const DEFAULT_VIEWER_BINDING_DIRECTION: &str = "left";
const DEFAULT_VIEWER_ZOOM_MODE: &str = "fit-height";
const DEFAULT_VIEWER_ALIGN_MODE: &str = "center";
const DEFAULT_VIEWER_VERTICAL_GAP_MODE: &str = "compact";
const DEFAULT_VIEWER_TREAT_FIRST_PAGE_AS_COVER: bool = true;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BookSummary {
    file_name: String,
    file_path: String,
    file_size: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LibrarySnapshot {
    watch_root: String,
    indexed_count: usize,
    books: Vec<BookSummary>,
    excluded_dir_names: Vec<String>,
    excluded_file_suffixes: Vec<String>,
    pdf_renderer: String,
}

#[derive(Clone)]
struct AppConfig {
    watch_root: String,
    excluded_dir_names: Vec<String>,
    excluded_file_suffixes: Vec<String>,
    pdf_renderer: String,
}

#[derive(Deserialize)]
struct AppConfigFile {
    watch_root: Option<String>,
    excluded_dir_names: Option<Vec<String>>,
    excluded_file_suffixes: Option<Vec<String>>,
    pdf_renderer: Option<String>,
}

struct ConfigState {
    config: AppConfig,
}

struct ThumbnailQueue {
    sender: mpsc::Sender<String>,
    pending: Arc<Mutex<HashSet<String>>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NoteDocument {
    file_path: String,
    format: String,
    content: String,
    updated_at: Option<u64>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ViewerPreferences {
    page_mode: String,
    binding_direction: String,
    zoom_mode: String,
    align_mode: String,
    vertical_gap_mode: String,
    treat_first_page_as_cover: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ViewerPreferencesPayload {
    global: ViewerPreferences,
    file: Option<ViewerPreferences>,
    effective: ViewerPreferences,
    uses_file_override: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ThumbnailReadyEvent {
    file_path: String,
    thumbnail_path: String,
}

fn database_file() -> Result<PathBuf, String> {
    Ok(project_root().join("data").join("app.db"))
}

fn project_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")))
}

fn config_file() -> PathBuf {
    project_root().join(CONFIG_FILE)
}

fn thumbnail_root() -> PathBuf {
    project_root().join("data").join("thumbnails")
}

fn default_config() -> AppConfig {
    AppConfig {
        watch_root: DEFAULT_WATCH_ROOT.to_string(),
        excluded_dir_names: DEFAULT_EXCLUDED_DIR_NAMES
            .iter()
            .map(|value| value.to_string())
            .collect(),
        excluded_file_suffixes: DEFAULT_EXCLUDED_FILE_SUFFIXES
            .iter()
            .map(|value| value.to_string())
            .collect(),
        pdf_renderer: DEFAULT_PDF_RENDERER.to_string(),
    }
}

fn normalize_pdf_renderer(renderer: String) -> String {
    match renderer.trim().to_lowercase().as_str() {
        "pdfjs" => "pdfjs".to_string(),
        _ => DEFAULT_PDF_RENDERER.to_string(),
    }
}

fn expand_home_path(path: &str) -> String {
    if path == "~" {
        return std::env::var("HOME").unwrap_or_else(|_| path.to_string());
    }

    if let Some(rest) = path.strip_prefix("~/") {
        if let Ok(home) = std::env::var("HOME") {
            return PathBuf::from(home).join(rest).to_string_lossy().into_owned();
        }
    }

    path.to_string()
}

fn load_config() -> Result<AppConfig, String> {
    let config_path = config_file();

    if !config_path.exists() {
        return Ok(default_config());
    }

    let config_contents = fs::read_to_string(&config_path).map_err(|error| error.to_string())?;
    let file_config: AppConfigFile =
        toml::from_str(&config_contents).map_err(|error| error.to_string())?;
    let defaults = default_config();

    Ok(AppConfig {
        watch_root: expand_home_path(&file_config.watch_root.unwrap_or(defaults.watch_root)),
        excluded_dir_names: file_config
            .excluded_dir_names
            .unwrap_or(defaults.excluded_dir_names)
            .into_iter()
            .map(|value| value.to_lowercase())
            .collect(),
        excluded_file_suffixes: file_config
            .excluded_file_suffixes
            .unwrap_or(defaults.excluded_file_suffixes)
            .into_iter()
            .map(|value| value.to_lowercase())
            .collect(),
        pdf_renderer: normalize_pdf_renderer(
            file_config.pdf_renderer.unwrap_or(defaults.pdf_renderer),
        ),
    })
}

fn open_database() -> Result<Connection, String> {
    let database_file = database_file()?;

    if let Some(parent) = database_file.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }

    let connection = Connection::open(database_file).map_err(|error| error.to_string())?;

    connection
        .execute_batch(
            "
            CREATE TABLE IF NOT EXISTS books (
              id INTEGER PRIMARY KEY,
              file_path TEXT NOT NULL UNIQUE,
              file_name TEXT NOT NULL,
              file_size INTEGER NOT NULL,
              modified_at INTEGER NOT NULL,
              indexed_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS notes (
              id INTEGER PRIMARY KEY,
              file_path TEXT NOT NULL UNIQUE,
              format TEXT NOT NULL,
              content TEXT NOT NULL,
              updated_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS viewer_preferences (
              scope_key TEXT PRIMARY KEY,
              file_path TEXT UNIQUE,
              page_mode TEXT NOT NULL,
              binding_direction TEXT NOT NULL,
              zoom_mode TEXT NOT NULL,
              align_mode TEXT NOT NULL,
              vertical_gap_mode TEXT NOT NULL,
              treat_first_page_as_cover INTEGER NOT NULL,
              updated_at INTEGER NOT NULL
            );
            ",
        )
        .map_err(|error| error.to_string())?;

    Ok(connection)
}

fn is_pdf_file(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.eq_ignore_ascii_case("pdf"))
        .unwrap_or(false)
}

fn path_contains_excluded_directory(path: &Path, config: &AppConfig) -> bool {
    path.components().any(|component| {
        let name = component.as_os_str().to_string_lossy().to_lowercase();
        config
            .excluded_dir_names
            .iter()
            .any(|excluded| name == *excluded)
    })
}

fn is_excluded_file(path: &Path, config: &AppConfig) -> bool {
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .map(|name| name.to_lowercase())
        .unwrap_or_default();

    config
        .excluded_file_suffixes
        .iter()
        .any(|suffix| file_name.ends_with(suffix))
}

fn should_include_pdf(path: &Path, config: &AppConfig) -> bool {
    is_pdf_file(path)
        && !path_contains_excluded_directory(path, config)
        && !is_excluded_file(path, config)
}

fn modified_unix_seconds(metadata: &fs::Metadata) -> u64 {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

fn default_viewer_preferences() -> ViewerPreferences {
    ViewerPreferences {
        page_mode: DEFAULT_VIEWER_PAGE_MODE.to_string(),
        binding_direction: DEFAULT_VIEWER_BINDING_DIRECTION.to_string(),
        zoom_mode: DEFAULT_VIEWER_ZOOM_MODE.to_string(),
        align_mode: DEFAULT_VIEWER_ALIGN_MODE.to_string(),
        vertical_gap_mode: DEFAULT_VIEWER_VERTICAL_GAP_MODE.to_string(),
        treat_first_page_as_cover: DEFAULT_VIEWER_TREAT_FIRST_PAGE_AS_COVER,
    }
}

fn normalize_page_mode(value: &str) -> String {
    match value.trim().to_lowercase().as_str() {
        "single" => "single".to_string(),
        _ => DEFAULT_VIEWER_PAGE_MODE.to_string(),
    }
}

fn normalize_binding_direction(value: &str) -> String {
    match value.trim().to_lowercase().as_str() {
        "right" => "right".to_string(),
        _ => DEFAULT_VIEWER_BINDING_DIRECTION.to_string(),
    }
}

fn normalize_zoom_mode(value: &str) -> String {
    match value.trim().to_lowercase().as_str() {
        "fit-width" => "fit-width".to_string(),
        "original" => "original".to_string(),
        _ => DEFAULT_VIEWER_ZOOM_MODE.to_string(),
    }
}

fn normalize_align_mode(value: &str) -> String {
    match value.trim().to_lowercase().as_str() {
        "left" => "left".to_string(),
        "right" => "right".to_string(),
        _ => DEFAULT_VIEWER_ALIGN_MODE.to_string(),
    }
}

fn normalize_vertical_gap_mode(value: &str) -> String {
    match value.trim().to_lowercase().as_str() {
        "wide" => "wide".to_string(),
        "none" => "none".to_string(),
        _ => DEFAULT_VIEWER_VERTICAL_GAP_MODE.to_string(),
    }
}

fn normalize_viewer_preferences(preferences: ViewerPreferences) -> ViewerPreferences {
    ViewerPreferences {
        page_mode: normalize_page_mode(&preferences.page_mode),
        binding_direction: normalize_binding_direction(&preferences.binding_direction),
        zoom_mode: normalize_zoom_mode(&preferences.zoom_mode),
        align_mode: normalize_align_mode(&preferences.align_mode),
        vertical_gap_mode: normalize_vertical_gap_mode(&preferences.vertical_gap_mode),
        treat_first_page_as_cover: preferences.treat_first_page_as_cover,
    }
}

fn load_saved_viewer_preferences(
    connection: &Connection,
    scope_key: &str,
) -> Result<Option<ViewerPreferences>, String> {
    let mut statement = connection
        .prepare(
            "
            SELECT
              page_mode,
              binding_direction,
              zoom_mode,
              align_mode,
              vertical_gap_mode,
              treat_first_page_as_cover
            FROM viewer_preferences
            WHERE scope_key = ?1
            ",
        )
        .map_err(|error| error.to_string())?;

    let preferences = statement.query_row(params![scope_key], |row| {
        Ok(ViewerPreferences {
            page_mode: row.get(0)?,
            binding_direction: row.get(1)?,
            zoom_mode: row.get(2)?,
            align_mode: row.get(3)?,
            vertical_gap_mode: row.get(4)?,
            treat_first_page_as_cover: row.get::<_, i64>(5)? != 0,
        })
    });

    match preferences {
        Ok(preferences) => Ok(Some(preferences)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

fn merge_file_viewer_preferences(
    global: &ViewerPreferences,
    file: &ViewerPreferences,
) -> ViewerPreferences {
    ViewerPreferences {
        page_mode: if file.page_mode.trim().is_empty() {
            global.page_mode.clone()
        } else {
            normalize_page_mode(&file.page_mode)
        },
        binding_direction: normalize_binding_direction(&file.binding_direction),
        zoom_mode: if file.zoom_mode.trim().is_empty() {
            global.zoom_mode.clone()
        } else {
            normalize_zoom_mode(&file.zoom_mode)
        },
        align_mode: if file.align_mode.trim().is_empty() {
            global.align_mode.clone()
        } else {
            normalize_align_mode(&file.align_mode)
        },
        vertical_gap_mode: if file.vertical_gap_mode.trim().is_empty() {
            global.vertical_gap_mode.clone()
        } else {
            normalize_vertical_gap_mode(&file.vertical_gap_mode)
        },
        treat_first_page_as_cover: file.treat_first_page_as_cover,
    }
}

fn save_viewer_preferences_record(
    connection: &Connection,
    scope_key: &str,
    file_path: Option<&str>,
    preferences: ViewerPreferences,
) -> Result<ViewerPreferences, String> {
    let normalized = normalize_viewer_preferences(preferences);
    let updated_at = std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_secs();

    connection
        .execute(
            "
            INSERT INTO viewer_preferences (
              scope_key,
              file_path,
              page_mode,
              binding_direction,
              zoom_mode,
              align_mode,
              vertical_gap_mode,
              treat_first_page_as_cover,
              updated_at
            )
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
            ON CONFLICT(scope_key) DO UPDATE SET
              file_path = excluded.file_path,
              page_mode = excluded.page_mode,
              binding_direction = excluded.binding_direction,
              zoom_mode = excluded.zoom_mode,
              align_mode = excluded.align_mode,
              vertical_gap_mode = excluded.vertical_gap_mode,
              treat_first_page_as_cover = excluded.treat_first_page_as_cover,
              updated_at = excluded.updated_at
            ",
            params![
                scope_key,
                file_path,
                normalized.page_mode,
                normalized.binding_direction,
                normalized.zoom_mode,
                normalized.align_mode,
                normalized.vertical_gap_mode,
                if normalized.treat_first_page_as_cover {
                    1
                } else {
                    0
                },
                updated_at
            ],
        )
        .map_err(|error| error.to_string())?;

    Ok(normalized)
}

fn load_viewer_preferences_payload(
    connection: &Connection,
    file_path: Option<&str>,
) -> Result<ViewerPreferencesPayload, String> {
    let global = load_saved_viewer_preferences(connection, VIEWER_DEFAULT_SCOPE_KEY)?
        .map(normalize_viewer_preferences)
        .unwrap_or_else(default_viewer_preferences);
    let file_raw = if let Some(file_path) = file_path {
        load_saved_viewer_preferences(connection, file_path)?
    } else {
        None
    };
    let file = file_raw
        .as_ref()
        .map(|preferences| merge_file_viewer_preferences(&global, preferences));
    let uses_file_override = file_raw.is_some();
    let effective = file.clone().unwrap_or_else(|| global.clone());

    Ok(ViewerPreferencesPayload {
        global,
        file,
        effective,
        uses_file_override,
    })
}

fn scan_and_index(connection: &Connection, config: &AppConfig) -> Result<(), String> {
    let now = std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_secs();

    for entry in WalkDir::new(&config.watch_root)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_file() && should_include_pdf(entry.path(), config))
    {
        let path = entry.path();
        let metadata = fs::metadata(path).map_err(|error| error.to_string())?;
        let file_size = metadata.len();

        if file_size == 0 {
            continue;
        }

        let file_path = path.to_string_lossy().into_owned();
        let file_name = path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("unknown.pdf")
            .to_string();
        let modified_at = modified_unix_seconds(&metadata);

        connection
            .execute(
                "
                INSERT INTO books (file_path, file_name, file_size, modified_at, indexed_at)
                VALUES (?1, ?2, ?3, ?4, ?5)
                ON CONFLICT(file_path) DO UPDATE SET
                  file_name = excluded.file_name,
                  file_size = excluded.file_size,
                  modified_at = excluded.modified_at,
                  indexed_at = excluded.indexed_at
                ",
                params![file_path, file_name, file_size, modified_at, now],
            )
            .map_err(|error| error.to_string())?;
    }

    connection
        .execute("DELETE FROM books WHERE indexed_at < ?1", params![now],)
        .map_err(|error| error.to_string())?;

    Ok(())
}

fn load_snapshot(connection: &Connection, config: &AppConfig) -> Result<LibrarySnapshot, String> {
    let indexed_count: usize = connection
        .query_row("SELECT COUNT(*) FROM books", [], |row| row.get(0))
        .map_err(|error| error.to_string())?;

    let mut statement = connection
        .prepare(
            "
            SELECT
              file_name,
              file_path,
              file_size
            FROM books
            ORDER BY books.modified_at DESC, books.file_name ASC
            ",
        )
        .map_err(|error| error.to_string())?;

    let books = statement
        .query_map([], |row| {
            Ok(BookSummary {
                file_name: row.get(0)?,
                file_path: row.get(1)?,
                file_size: row.get(2)?,
            })
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;

    Ok(LibrarySnapshot {
        watch_root: config.watch_root.clone(),
        indexed_count,
        books,
        excluded_dir_names: config.excluded_dir_names.clone(),
        excluded_file_suffixes: config.excluded_file_suffixes.clone(),
        pdf_renderer: config.pdf_renderer.clone(),
    })
}

fn refresh_library_snapshot(config: &AppConfig) -> Result<LibrarySnapshot, String> {
    if !Path::new(&config.watch_root).exists() {
        return Err(format!("watch root does not exist: {}", config.watch_root));
    }

    let connection = open_database()?;
    scan_and_index(&connection, config)?;
    load_snapshot(&connection, config)
}

fn thumbnail_cache_dir(file_path: &str) -> PathBuf {
    let mut hasher = DefaultHasher::new();
    file_path.hash(&mut hasher);
    thumbnail_root().join(format!("{:016x}", hasher.finish()))
}

fn thumbnail_output_file(file_path: &str) -> PathBuf {
    thumbnail_cache_dir(file_path).join("thumbnail.jpg")
}

fn is_thumbnail_fresh(pdf_path: &Path, thumbnail_path: &Path) -> bool {
    let pdf_modified = fs::metadata(pdf_path).and_then(|metadata| metadata.modified());
    let thumb_modified = fs::metadata(thumbnail_path).and_then(|metadata| metadata.modified());

    match (pdf_modified, thumb_modified) {
        (Ok(pdf_modified), Ok(thumb_modified)) => thumb_modified >= pdf_modified,
        _ => false,
    }
}

fn generate_thumbnail(file_path: &Path, output_dir: &Path) -> Result<PathBuf, String> {
    fs::create_dir_all(output_dir).map_err(|error| error.to_string())?;

    let status = Command::new("/usr/bin/qlmanage")
        .args(["-t", "-s", "320", "-o"])
        .arg(output_dir)
        .arg(file_path)
        .status()
        .map_err(|error| error.to_string())?;

    if !status.success() {
        return Err(format!("qlmanage failed with status: {status}"));
    }

    let generated_png = fs::read_dir(output_dir)
        .map_err(|error| error.to_string())?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .find(|path| {
            path.extension()
                .and_then(|ext| ext.to_str())
                .map(|ext| ext.eq_ignore_ascii_case("png"))
                .unwrap_or(false)
        })
        .ok_or_else(|| "Quick Look did not generate a PNG thumbnail".to_string())?;

    let thumbnail_path = output_dir.join("thumbnail.jpg");
    let convert_status = Command::new("/usr/bin/sips")
        .args(["-s", "format", "jpeg"])
        .arg(&generated_png)
        .args(["--out"])
        .arg(&thumbnail_path)
        .status()
        .map_err(|error| error.to_string())?;

    if !convert_status.success() {
        return Err(format!("sips failed with status: {convert_status}"));
    }

    Ok(thumbnail_path)
}

fn start_thumbnail_worker(app: AppHandle) -> ThumbnailQueue {
    let (tx, rx) = mpsc::channel::<String>();
    let pending = Arc::new(Mutex::new(HashSet::<String>::new()));
    let pending_for_worker = Arc::clone(&pending);

    thread::spawn(move || {
        while let Ok(file_path) = rx.recv() {
            let pdf_path = PathBuf::from(&file_path);
            let output_dir = thumbnail_cache_dir(&file_path);
            let result = generate_thumbnail(&pdf_path, &output_dir);

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

fn should_rescan(event: &Event, config: &AppConfig) -> bool {
    event.paths.iter().any(|path| {
        (path.is_dir() && !path_contains_excluded_directory(path, config))
            || should_include_pdf(path, config)
    })
}

fn emit_library_snapshot(app: &AppHandle, config: &AppConfig) -> Result<(), String> {
    let snapshot = refresh_library_snapshot(config)?;

    app.emit("library-updated", &snapshot)
        .map_err(|error| error.to_string())
}

fn start_library_watcher(app: AppHandle, config: AppConfig) -> Result<(), String> {
    if !Path::new(&config.watch_root).exists() {
        return Ok(());
    }

    let (tx, rx) = mpsc::channel::<notify::Result<Event>>();

    thread::spawn(move || {
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

        if let Err(error) = watcher.watch(Path::new(&config.watch_root), RecursiveMode::Recursive) {
            let _ = app.emit("library-watch-error", error.to_string());
            return;
        }

        while let Ok(result) = rx.recv() {
            match result {
                Ok(event) if should_rescan(&event, &config) => {
                    thread::sleep(Duration::from_millis(250));

                    while rx.try_recv().is_ok() {}

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
fn library_snapshot(config_state: State<'_, ConfigState>) -> Result<LibrarySnapshot, String> {
    refresh_library_snapshot(&config_state.config)
}

#[tauri::command]
fn book_thumbnail(
    file_path: String,
    queue: State<'_, ThumbnailQueue>,
    config_state: State<'_, ConfigState>,
) -> Result<Option<String>, String> {
    let pdf_path = PathBuf::from(&file_path);

    if !pdf_path.exists() || !should_include_pdf(&pdf_path, &config_state.config) {
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
fn load_note(file_path: String) -> Result<NoteDocument, String> {
    let connection = open_database()?;
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
    let connection = open_database()?;
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

    Ok(NoteDocument {
        file_path,
        format: "markdown".to_string(),
        content,
        updated_at: Some(updated_at),
    })
}

#[tauri::command]
fn load_viewer_preferences(file_path: String) -> Result<ViewerPreferencesPayload, String> {
    let connection = open_database()?;
    load_viewer_preferences_payload(&connection, Some(&file_path))
}

#[tauri::command]
fn save_default_viewer_preferences(
    current_file_path: Option<String>,
    preferences: ViewerPreferences,
) -> Result<ViewerPreferencesPayload, String> {
    let connection = open_database()?;
    save_viewer_preferences_record(
        &connection,
        VIEWER_DEFAULT_SCOPE_KEY,
        None,
        preferences,
    )?;
    load_viewer_preferences_payload(&connection, current_file_path.as_deref())
}

#[tauri::command]
fn save_file_viewer_preferences(
    file_path: String,
    preferences: ViewerPreferences,
) -> Result<ViewerPreferencesPayload, String> {
    let connection = open_database()?;
    let global = load_saved_viewer_preferences(&connection, VIEWER_DEFAULT_SCOPE_KEY)?
        .map(normalize_viewer_preferences)
        .unwrap_or_else(default_viewer_preferences);
    let normalized = normalize_viewer_preferences(preferences);
    let stored_preferences = ViewerPreferences {
        page_mode: if normalized.page_mode == global.page_mode {
            String::new()
        } else {
            normalized.page_mode
        },
        binding_direction: normalized.binding_direction,
        zoom_mode: if normalized.zoom_mode == global.zoom_mode {
            String::new()
        } else {
            normalized.zoom_mode
        },
        align_mode: if normalized.align_mode == global.align_mode {
            String::new()
        } else {
            normalized.align_mode
        },
        vertical_gap_mode: if normalized.vertical_gap_mode == global.vertical_gap_mode {
            String::new()
        } else {
            normalized.vertical_gap_mode
        },
        treat_first_page_as_cover: normalized.treat_first_page_as_cover,
    };
    save_viewer_preferences_record(&connection, &file_path, Some(&file_path), stored_preferences)?;
    load_viewer_preferences_payload(&connection, Some(&file_path))
}

#[tauri::command]
fn clear_file_viewer_preferences(file_path: String) -> Result<ViewerPreferencesPayload, String> {
    let connection = open_database()?;
    connection
        .execute(
            "DELETE FROM viewer_preferences WHERE scope_key = ?1",
            params![&file_path],
        )
        .map_err(|error| error.to_string())?;
    load_viewer_preferences_payload(&connection, Some(&file_path))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let config = load_config()?;
            start_library_watcher(app.handle().clone(), config.clone())?;
            app.manage(ConfigState { config });
            app.manage(start_thumbnail_worker(app.handle().clone()));
            Ok(())
        })
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            library_snapshot,
            book_thumbnail,
            load_note,
            save_note,
            load_viewer_preferences,
            save_default_viewer_preferences,
            save_file_viewer_preferences,
            clear_file_viewer_preferences
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
