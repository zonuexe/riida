use notify::{Config, Event, RecommendedWatcher, RecursiveMode, Watcher};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::mpsc,
    thread,
    time::{Duration, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter};
use walkdir::WalkDir;

const WATCH_ROOT: &str = "/Users/megurine/Dropbox/EBook/";
const DATABASE_PATH: &str = "../data/app.db";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BookSummary {
    file_name: String,
    file_path: String,
    file_size: u64,
    last_page: Option<u32>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LibrarySnapshot {
    watch_root: &'static str,
    indexed_count: usize,
    recent_books: Vec<BookSummary>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveReadingProgressPayload {
    file_path: String,
    last_page: u32,
}

fn database_file() -> Result<PathBuf, String> {
    Ok(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(DATABASE_PATH))
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
            CREATE TABLE IF NOT EXISTS reading_progress (
              file_path TEXT PRIMARY KEY,
              last_page INTEGER NOT NULL,
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
        .filter(|entry| entry.file_type().is_file() && is_pdf_file(entry.path()))
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
              books.file_name,
              books.file_path,
              books.file_size,
              reading_progress.last_page
            FROM books
            LEFT JOIN reading_progress
              ON reading_progress.file_path = books.file_path
            ORDER BY modified_at DESC, file_name ASC
            LIMIT 8
            ",
        )
        .map_err(|error| error.to_string())?;

    let recent_books = statement
        .query_map([], |row| {
            Ok(BookSummary {
                file_name: row.get(0)?,
                file_path: row.get(1)?,
                file_size: row.get(2)?,
                last_page: row.get(3)?,
            })
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;

    Ok(LibrarySnapshot {
        watch_root: WATCH_ROOT,
        indexed_count,
        recent_books,
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

fn should_rescan(event: &Event) -> bool {
    event.paths.iter().any(|path| path.is_dir() || is_pdf_file(path))
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
fn save_reading_progress(payload: SaveReadingProgressPayload) -> Result<(), String> {
    let now = std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_secs();
    let connection = open_database()?;

    connection
        .execute(
            "
            INSERT INTO reading_progress (file_path, last_page, updated_at)
            VALUES (?1, ?2, ?3)
            ON CONFLICT(file_path) DO UPDATE SET
              last_page = excluded.last_page,
              updated_at = excluded.updated_at
            ",
            params![payload.file_path, payload.last_page, now],
        )
        .map_err(|error| error.to_string())?;

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            start_library_watcher(app.handle().clone())?;
            Ok(())
        })
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            library_snapshot,
            save_reading_progress
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
