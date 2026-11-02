//! Fixtures shared by this crate's unit tests.

use crate::config::{AppConfig, CONFIG_FILE, DEFAULT_PDF_RENDERER, DEFAULT_THEME};
use crate::fulltext;
use crate::fulltext_books::BookIndexInput;
use crate::metadata::BookMetadataInput;
use crate::storage::AppPaths;
use crate::viewer_prefs::ViewerPreferences;
use rusqlite::{params, Connection};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;
use zip::ZipArchive;

use proptest::prelude::*;
pub fn fulltext_book(file_path: &str, source_type: &str, modified_at: u64) -> BookIndexInput {
    BookIndexInput {
        file_path: file_path.into(),
        source_type: source_type.into(),
        modified_at,
        title: "T".into(),
        authors: vec![],
        publisher: String::new(),
        description: String::new(),
        release_date: String::new(),
        language: String::new(),
        asin: String::new(),
        url: String::new(),
        tags: vec![],
        note: None,
        password: None,
    }
}

pub fn chunk_doc(path: &str, text: &str) -> fulltext::ContentDoc {
    fulltext::ContentDoc {
        file_path: path.into(),
        kind: fulltext::ContentKind::Metadata,
        title: "T".into(),
        authors: String::new(),
        tags: String::new(),
        text: text.into(),
        loc_page: None,
        loc_anchor: None,
    }
}

pub fn test_connection() -> Connection {
    let connection = Connection::open_in_memory().expect("in-memory db should open");
    connection
        .execute_batch(
            "
            CREATE TABLE viewer_preferences (
              scope_key TEXT PRIMARY KEY,
              file_path TEXT UNIQUE,
              source_type TEXT NOT NULL DEFAULT 'pdf',
              page_mode TEXT NOT NULL,
              binding_direction TEXT NOT NULL,
              zoom_mode TEXT NOT NULL,
              align_mode TEXT NOT NULL,
              vertical_gap_mode TEXT NOT NULL,
              treat_first_page_as_cover INTEGER NOT NULL,
              background_mode TEXT NOT NULL DEFAULT 'inherit-theme',
              scroll_mode TEXT NOT NULL DEFAULT 'paged',
              epub_font_size INTEGER NOT NULL DEFAULT 100,
              deskew_mode TEXT NOT NULL DEFAULT 'off',
              trim_mode TEXT NOT NULL DEFAULT 'off',
              updated_at INTEGER NOT NULL
            );
            ",
        )
        .expect("viewer_preferences table should be created");
    connection
}

pub fn viewer_preferences(
    page_mode: &str,
    binding_direction: &str,
    zoom_mode: &str,
    align_mode: &str,
    vertical_gap_mode: &str,
    treat_first_page_as_cover: bool,
    background_mode: &str,
) -> ViewerPreferences {
    ViewerPreferences {
        page_mode: page_mode.to_string(),
        binding_direction: binding_direction.to_string(),
        zoom_mode: zoom_mode.to_string(),
        align_mode: align_mode.to_string(),
        vertical_gap_mode: vertical_gap_mode.to_string(),
        treat_first_page_as_cover,
        background_mode: background_mode.to_string(),
        scroll_mode: String::new(),
        epub_font_size: 0,
        deskew_mode: String::new(),
        trim_mode: String::new(),
    }
}

pub fn test_config(patterns: &[&str]) -> AppConfig {
    AppConfig {
        library_roots: Vec::new(),
        excluded_patterns: patterns.iter().map(|value| value.to_string()).collect(),
        pdf_renderer: DEFAULT_PDF_RENDERER.to_string(),
        theme: DEFAULT_THEME.to_string(),
        enabled_external_sources: vec![],
    }
}

pub fn unique_temp_dir(label: &str) -> PathBuf {
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

pub fn test_app_paths(root: &Path) -> AppPaths {
    AppPaths {
        config_file: root.join("config").join(CONFIG_FILE),
        data_dir: root.join("data"),
        database_file: root.join("data").join("app.db"),
        cache_dir: root.join("cache"),
        thumbnail_root: root.join("cache").join("thumbnails"),
        legacy_config_files: vec![root.join("legacy").join(CONFIG_FILE)],
        legacy_database_files: vec![root.join("legacy").join("app.db")],
        legacy_thumbnail_roots: vec![root.join("legacy").join("thumbnails")],
    }
}

prop_compose! {
    pub fn arbitrary_viewer_preferences()(
        page_mode in ".*",
        binding_direction in ".*",
        zoom_mode in ".*",
        align_mode in ".*",
        vertical_gap_mode in ".*",
        treat_first_page_as_cover in any::<bool>(),
        background_mode in ".*",
        scroll_mode in ".*",
        epub_font_size in any::<i64>(),
        deskew_mode in ".*",
        trim_mode in ".*",
    ) -> ViewerPreferences {
        ViewerPreferences {
            page_mode,
            binding_direction,
            zoom_mode,
            align_mode,
            vertical_gap_mode,
            treat_first_page_as_cover,
            background_mode,
            scroll_mode,
            epub_font_size,
            deskew_mode,
            trim_mode,
        }
    }
}

prop_compose! {
    pub fn normalized_viewer_preferences_strategy()(
        page_mode in prop_oneof![Just("single".to_string()), Just("spread".to_string())],
        binding_direction in prop_oneof![Just("left".to_string()), Just("right".to_string())],
        zoom_mode in prop_oneof![
            Just("fit-width".to_string()),
            Just("fit-height".to_string()),
            Just("original".to_string())
        ],
        align_mode in prop_oneof![
            Just("left".to_string()),
            Just("center".to_string()),
            Just("right".to_string())
        ],
        vertical_gap_mode in prop_oneof![
            Just("wide".to_string()),
            Just("compact".to_string()),
            Just("none".to_string())
        ],
        treat_first_page_as_cover in any::<bool>(),
        background_mode in prop_oneof![
            Just("inherit-theme".to_string()),
            Just("default".to_string()),
            Just("snow-white".to_string()),
            Just("night-city".to_string()),
            Just("navy-blue".to_string())
        ],
        scroll_mode in prop_oneof![
            Just("continuous".to_string()),
            Just("paged".to_string())
        ],
        epub_font_size in 50i64..=200i64,
        deskew_mode in prop_oneof![Just("off".to_string()), Just("auto".to_string())],
        trim_mode in prop_oneof![Just("off".to_string()), Just("auto".to_string())],
    ) -> ViewerPreferences {
        ViewerPreferences {
            page_mode,
            binding_direction,
            zoom_mode,
            align_mode,
            vertical_gap_mode,
            treat_first_page_as_cover,
            background_mode,
            scroll_mode,
            epub_font_size,
            deskew_mode,
            trim_mode,
        }
    }
}

pub fn sample_metadata_input(release_date: &str) -> BookMetadataInput {
    BookMetadataInput {
        file_path: "/a.pdf".to_string(),
        source_type: None,
        title: " Title ".to_string(),
        authors: vec![" Alice ".to_string()],
        description: " desc ".to_string(),
        publisher: " Pub ".to_string(),
        release_date: release_date.to_string(),
        language: " en ".to_string(),
        url: " http://x ".to_string(),
        asin: " A1 ".to_string(),
        cover_url: " http://c ".to_string(),
    }
}

pub fn create_snapshot_schema(connection: &Connection) {
    connection
        .execute_batch(
            "
            CREATE TABLE books (
              id INTEGER PRIMARY KEY, file_path TEXT NOT NULL UNIQUE,
              file_name TEXT NOT NULL, file_size INTEGER NOT NULL,
              modified_at INTEGER NOT NULL, indexed_at INTEGER NOT NULL,
              source_type TEXT NOT NULL DEFAULT 'pdf'
            );
            CREATE TABLE book_tags (
              file_path TEXT NOT NULL, tag TEXT NOT NULL, PRIMARY KEY (file_path, tag)
            );
            CREATE TABLE book_metadata (
              file_path TEXT PRIMARY KEY, title TEXT NOT NULL, authors_json TEXT NOT NULL,
              description TEXT NOT NULL, publisher TEXT NOT NULL, release_date TEXT NOT NULL,
              language TEXT NOT NULL, url TEXT NOT NULL, asin TEXT NOT NULL,
              cover_url TEXT NOT NULL DEFAULT '', updated_at INTEGER NOT NULL
            );
            CREATE TABLE external_books (
              file_path TEXT PRIMARY KEY, source_type TEXT NOT NULL, title TEXT NOT NULL,
              authors_json TEXT NOT NULL, description TEXT NOT NULL, publisher TEXT NOT NULL,
              release_date TEXT NOT NULL, language TEXT NOT NULL, url TEXT NOT NULL,
              asin TEXT NOT NULL, cover_url TEXT NOT NULL, updated_at INTEGER NOT NULL
            );
            CREATE TABLE custom_sources (
              id TEXT PRIMARY KEY, name TEXT NOT NULL, icon TEXT NOT NULL,
              created_at INTEGER NOT NULL
            );
            CREATE TABLE reading_positions (
              file_path TEXT PRIMARY KEY, page_number INTEGER NOT NULL,
              page_offset_ratio REAL NOT NULL, cfi TEXT, updated_at INTEGER NOT NULL
            );
            ",
        )
        .expect("snapshot schema should be created");
}

// ----- EPUB parsing fixtures -------------------------------------------

pub fn write_epub(entries: &[(&str, &str)]) -> (PathBuf, PathBuf) {
    use std::io::Write as _;
    let dir = unique_temp_dir("epub");
    let path = dir.join("book.epub");
    let mut zip = zip::ZipWriter::new(fs::File::create(&path).expect("epub should create"));
    let options = zip::write::SimpleFileOptions::default();
    for (name, contents) in entries {
        zip.start_file(*name, options)
            .expect("zip entry should start");
        zip.write_all(contents.as_bytes())
            .expect("zip entry should write");
    }
    zip.finish().expect("zip should finish");
    (dir, path)
}

pub fn open_epub(path: &Path) -> ZipArchive<fs::File> {
    ZipArchive::new(fs::File::open(path).expect("epub should open")).expect("zip should parse")
}

pub fn opf_with_manifest(items: &str) -> String {
    format!(
        "<?xml version=\"1.0\"?><package xmlns=\"http://www.idpf.org/2007/opf\">\
         <manifest>{items}</manifest></package>"
    )
}

pub const OPF_FIXTURE: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">
<dc:title>The Great Book</dc:title>
<dc:creator opf:role="aut">Alice Author</dc:creator>
<dc:creator opf:role="ill">Ivan Illustrator</dc:creator>
<dc:creator>Bob Coauthor</dc:creator>
<dc:description>A fine description.</dc:description>
<dc:publisher>Acme Press</dc:publisher>
<dc:date>2021-07-15T00:00:00Z</dc:date>
<dc:language>en</dc:language>
  </metadata>
</package>"#;

pub fn password_connection() -> Connection {
    let connection = Connection::open_in_memory().expect("in-memory db should open");
    connection
        .execute_batch(
            "
            CREATE TABLE pdf_passwords (
              file_path TEXT PRIMARY KEY,
              password TEXT NOT NULL,
              updated_at INTEGER NOT NULL
            );
            ",
        )
        .expect("pdf_passwords table should be created");
    connection
}

pub fn book_tags_connection() -> Connection {
    let connection = Connection::open_in_memory().expect("in-memory db should open");
    connection
        .execute_batch(
            "
            CREATE TABLE book_tags (
              file_path TEXT NOT NULL,
              tag TEXT NOT NULL,
              PRIMARY KEY (file_path, tag)
            );
            ",
        )
        .expect("book_tags table should be created");
    connection
}

pub fn insert_tag(connection: &Connection, file_path: &str, tag: &str) {
    connection
        .execute(
            "INSERT INTO book_tags (file_path, tag) VALUES (?1, ?2)",
            params![file_path, tag],
        )
        .expect("tag should be inserted");
}

pub fn collect_tags(connection: &Connection, file_path: &str) -> Vec<String> {
    let mut stmt = connection
        .prepare("SELECT tag FROM book_tags WHERE file_path = ?1 ORDER BY tag")
        .expect("prepare should succeed");
    let rows = stmt
        .query_map(params![file_path], |row| row.get::<_, String>(0))
        .expect("query should succeed");
    rows.map(|row| row.expect("row should read")).collect()
}

pub fn books_schema_connection() -> Connection {
    let connection = Connection::open_in_memory().expect("in-memory db should open");
    connection
        .execute_batch(
            "
            CREATE TABLE books (
              id INTEGER PRIMARY KEY,
              file_path TEXT NOT NULL UNIQUE,
              file_name TEXT NOT NULL,
              file_size INTEGER NOT NULL,
              modified_at INTEGER NOT NULL,
              indexed_at INTEGER NOT NULL,
              source_type TEXT NOT NULL DEFAULT 'pdf'
            );
            CREATE TABLE book_tags (
              file_path TEXT NOT NULL,
              tag TEXT NOT NULL,
              PRIMARY KEY (file_path, tag)
            );
            CREATE TABLE book_metadata (
              file_path TEXT PRIMARY KEY,
              title TEXT NOT NULL,
              authors_json TEXT NOT NULL,
              description TEXT NOT NULL,
              publisher TEXT NOT NULL,
              release_date TEXT NOT NULL,
              language TEXT NOT NULL,
              url TEXT NOT NULL,
              asin TEXT NOT NULL,
              cover_url TEXT NOT NULL DEFAULT '',
              updated_at INTEGER NOT NULL
            );
            CREATE TABLE external_books (
              file_path TEXT PRIMARY KEY,
              source_type TEXT NOT NULL,
              title TEXT NOT NULL,
              authors_json TEXT NOT NULL,
              description TEXT NOT NULL,
              publisher TEXT NOT NULL,
              release_date TEXT NOT NULL,
              language TEXT NOT NULL,
              url TEXT NOT NULL,
              asin TEXT NOT NULL,
              cover_url TEXT NOT NULL,
              updated_at INTEGER NOT NULL
            );
            CREATE TABLE custom_sources (
              id TEXT PRIMARY KEY,
              name TEXT NOT NULL,
              icon TEXT NOT NULL,
              created_at INTEGER NOT NULL
            );
            CREATE TABLE reading_positions (
              file_path TEXT PRIMARY KEY,
              page_number INTEGER NOT NULL,
              page_offset_ratio REAL NOT NULL,
              cfi TEXT,
              updated_at INTEGER NOT NULL
            );
            ",
        )
        .expect("schema should be created");
    connection
}
