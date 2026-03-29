use rusqlite::{params, Connection};
use serde::Serialize;
use std::{
    fs,
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};
use walkdir::WalkDir;

const WATCH_ROOT: &str = "/Users/megurine/Dropbox/EBook/";
const DATABASE_PATH: &str = "../data/app.db";

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
    recent_books: Vec<BookSummary>,
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
            SELECT file_name, file_path, file_size
            FROM books
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

#[tauri::command]
fn library_snapshot() -> Result<LibrarySnapshot, String> {
    if !Path::new(WATCH_ROOT).exists() {
        return Err(format!("watch root does not exist: {WATCH_ROOT}"));
    }

    let connection = open_database()?;
    scan_and_index(&connection)?;
    load_snapshot(&connection)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![library_snapshot])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
