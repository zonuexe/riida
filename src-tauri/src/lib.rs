use notify::{Config, Event, RecommendedWatcher, RecursiveMode, Watcher};
use rusqlite::{params, Connection};
use serde::Serialize;
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

const WATCH_ROOT: &str = "/Users/megurine/Dropbox/EBook/";
const DATABASE_PATH: &str = "../data/app.db";
const THUMBNAIL_DIR: &str = "../data/thumbnails";
const EXCLUDED_DIR_NAMES: &[&str] = &["backup"];
const EXCLUDED_FILE_SUFFIXES: &[&str] = &[".bak"];

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
    watch_root: &'static str,
    indexed_count: usize,
    books: Vec<BookSummary>,
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

fn database_file() -> Result<PathBuf, String> {
    Ok(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(DATABASE_PATH))
}

fn thumbnail_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(THUMBNAIL_DIR)
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

fn path_contains_excluded_directory(path: &Path) -> bool {
    path.components().any(|component| {
        let name = component.as_os_str().to_string_lossy().to_lowercase();
        EXCLUDED_DIR_NAMES.iter().any(|excluded| name == *excluded)
    })
}

fn is_excluded_file(path: &Path) -> bool {
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .map(|name| name.to_lowercase())
        .unwrap_or_default();

    EXCLUDED_FILE_SUFFIXES
        .iter()
        .any(|suffix| file_name.ends_with(suffix))
}

fn should_include_pdf(path: &Path) -> bool {
    is_pdf_file(path) && !path_contains_excluded_directory(path) && !is_excluded_file(path)
}

fn modified_unix_seconds(metadata: &fs::Metadata) -> u64 {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

fn scan_and_index(connection: &Connection) -> Result<(), String> {
    let now = std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_secs();

    for entry in WalkDir::new(WATCH_ROOT)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_file() && should_include_pdf(entry.path()))
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

fn load_snapshot(connection: &Connection) -> Result<LibrarySnapshot, String> {
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
        watch_root: WATCH_ROOT,
        indexed_count,
        books,
    })
}

fn refresh_library_snapshot() -> Result<LibrarySnapshot, String> {
    if !Path::new(WATCH_ROOT).exists() {
        return Err(format!("watch root does not exist: {WATCH_ROOT}"));
    }

    let connection = open_database()?;
    scan_and_index(&connection)?;
    load_snapshot(&connection)
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

fn should_rescan(event: &Event) -> bool {
    event.paths.iter().any(|path| {
        (path.is_dir() && !path_contains_excluded_directory(path)) || should_include_pdf(path)
    })
}

fn emit_library_snapshot(app: &AppHandle) -> Result<(), String> {
    let snapshot = refresh_library_snapshot()?;

    app.emit("library-updated", &snapshot)
        .map_err(|error| error.to_string())
}

fn start_library_watcher(app: AppHandle) -> Result<(), String> {
    if !Path::new(WATCH_ROOT).exists() {
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

        if let Err(error) = watcher.watch(Path::new(WATCH_ROOT), RecursiveMode::Recursive) {
            let _ = app.emit("library-watch-error", error.to_string());
            return;
        }

        while let Ok(result) = rx.recv() {
            match result {
                Ok(event) if should_rescan(&event) => {
                    thread::sleep(Duration::from_millis(250));

                    while rx.try_recv().is_ok() {}

                    if let Err(error) = emit_library_snapshot(&app) {
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
fn library_snapshot() -> Result<LibrarySnapshot, String> {
    refresh_library_snapshot()
}

#[tauri::command]
fn book_thumbnail(file_path: String, queue: State<'_, ThumbnailQueue>) -> Result<Option<String>, String> {
    let pdf_path = PathBuf::from(&file_path);

    if !pdf_path.exists() || !should_include_pdf(&pdf_path) {
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            start_library_watcher(app.handle().clone())?;
            app.manage(start_thumbnail_worker(app.handle().clone()));
            Ok(())
        })
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![library_snapshot, book_thumbnail])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
