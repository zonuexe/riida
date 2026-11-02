//! Library scanning, indexing, and the snapshot the frontend lists.

use crate::config::{AppConfig, CompiledExcludePatterns};
use notify::Event;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::Path;
use std::time::UNIX_EPOCH;
use unicode_normalization::UnicodeNormalization;
use walkdir::WalkDir;

pub fn uuid_v4() -> String {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut h = DefaultHasher::new();
    std::time::SystemTime::now().hash(&mut h);
    std::thread::current().id().hash(&mut h);
    let a = h.finish();
    h.write_u64(a);
    let b = h.finish();
    format!(
        "{:08x}-{:04x}-4{:03x}-{:04x}-{:012x}",
        (a >> 32) as u32,
        (a >> 16) as u16,
        a as u16 & 0x0fff,
        (b >> 48) as u16 & 0x3fff | 0x8000,
        b & 0x0000_ffff_ffff_ffff,
    )
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CustomSource {
    pub id: String,
    pub name: String,
    pub icon: String,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Shelf {
    pub id: String,
    pub name: String,
    pub query: String,
    pub icon: Option<String>,
    pub sort_order: i64,
    pub created_at: u64,
    pub updated_at: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShelfDraft {
    pub id: Option<String>,
    pub name: String,
    pub query: String,
    pub icon: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BookSummary {
    pub file_name: String,
    pub title: Option<String>,
    pub file_path: String,
    pub file_size: u64,
    pub tags: Vec<String>,
    pub authors: Vec<String>,
    pub source_type: String,
    pub cover_url: Option<String>,
    pub location_label: Option<String>,
    pub is_openable: bool,
    pub asin: Option<String>,
    pub url: Option<String>,
    pub publisher: Option<String>,
    pub release_date: Option<String>,
    pub language: Option<String>,
    pub last_read_at: Option<u64>,
    pub indexed_at: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibrarySnapshot {
    pub library_roots: Vec<String>,
    pub existing_library_roots: Vec<String>,
    pub missing_library_roots: Vec<String>,
    pub indexed_count: usize,
    pub books: Vec<BookSummary>,
    pub excluded_patterns: Vec<String>,
    pub pdf_renderer: String,
    pub custom_sources: Vec<CustomSource>,
}

fn is_pdf_file(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.eq_ignore_ascii_case("pdf"))
        .unwrap_or(false)
}

pub fn is_epub_file(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.eq_ignore_ascii_case("epub"))
        .unwrap_or(false)
}

fn book_source_type(path: &Path) -> Option<&'static str> {
    if is_pdf_file(path) {
        Some("pdf")
    } else if is_epub_file(path) {
        Some("epub")
    } else {
        None
    }
}

pub fn should_include_book(path: &Path, compiled: &CompiledExcludePatterns) -> bool {
    book_source_type(path).is_some() && !matches_excluded_pattern(path, compiled)
}

fn normalized_path_for_glob(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/").to_lowercase()
}

fn matches_excluded_pattern(path: &Path, compiled: &CompiledExcludePatterns) -> bool {
    let full_path = normalized_path_for_glob(path);
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .map(|name| name.to_lowercase())
        .unwrap_or_default();
    let directory_probe = if path.is_dir() {
        Some(format!("{full_path}/__riida__"))
    } else {
        None
    };

    compiled.matchers.iter().any(|matcher| {
        matcher.is_match(&full_path)
            || (!file_name.is_empty() && matcher.is_match(&file_name))
            || directory_probe
                .as_ref()
                .map(|probe| matcher.is_match(probe))
                .unwrap_or(false)
    })
}

#[cfg(test)]
fn should_include_pdf(path: &Path, compiled: &CompiledExcludePatterns) -> bool {
    is_pdf_file(path) && !matches_excluded_pattern(path, compiled)
}

fn modified_unix_seconds(metadata: &fs::Metadata) -> u64 {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

pub fn current_scan_token() -> Result<u64, String> {
    std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_nanos()
        .try_into()
        .map_err(|_| "failed to convert scan token".to_string())
}

/// A book discovered on disk, ready to be upserted into the index.
pub struct IndexableBook {
    pub file_path: String,
    pub file_name: String,
    pub file_size: u64,
    pub modified_at: u64,
    pub source_type: &'static str,
}

/// Walk the configured library roots and collect every indexable book.
///
/// This performs the filesystem traversal and `stat` calls but touches no
/// database state, so it can run without holding the shared connection lock.
pub fn collect_indexable_books(
    config: &AppConfig,
    excluded_patterns: &CompiledExcludePatterns,
) -> Result<Vec<IndexableBook>, String> {
    let mut books = Vec::new();

    for root in &config.library_roots {
        for entry in WalkDir::new(root)
            .into_iter()
            .filter_map(Result::ok)
            .filter(|entry| {
                entry.file_type().is_file() && should_include_book(entry.path(), excluded_patterns)
            })
        {
            let path = entry.path();
            let metadata = fs::metadata(path).map_err(|error| error.to_string())?;
            let file_size = metadata.len();

            if file_size == 0 {
                continue;
            }

            // Normalize to NFC so that paths stored in the database are
            // consistent across all writers (Tauri, MCP server, etc.).
            // macOS (HFS+/APFS) returns NFD strings from the file system API,
            // which would otherwise cause JOIN mismatches with NFC-written rows.
            let file_path: String = path.to_string_lossy().nfc().collect();
            let file_name: String = path
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("unknown")
                .nfc()
                .collect();

            books.push(IndexableBook {
                file_path,
                file_name,
                file_size,
                modified_at: modified_unix_seconds(&metadata),
                source_type: book_source_type(path).unwrap_or("pdf"),
            });
        }
    }

    Ok(books)
}

/// Upsert the discovered books inside a single transaction and prune any rows
/// not seen during this scan. Only the database work happens here, so the
/// caller can keep the connection lock held for the shortest possible time.
pub fn index_books(
    connection: &mut Connection,
    books: &[IndexableBook],
    scan_token: u64,
) -> Result<(), String> {
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;

    for book in books {
        transaction
            .execute(
                "
                INSERT INTO books (file_path, file_name, file_size, modified_at, indexed_at, source_type)
                VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                ON CONFLICT(file_path) DO UPDATE SET
                  file_name = excluded.file_name,
                  file_size = excluded.file_size,
                  modified_at = excluded.modified_at,
                  indexed_at = excluded.indexed_at,
                  source_type = excluded.source_type
                ",
                params![
                    book.file_path,
                    book.file_name,
                    book.file_size,
                    book.modified_at,
                    scan_token,
                    book.source_type
                ],
            )
            .map_err(|error| error.to_string())?;
    }

    transaction
        .execute(
            "DELETE FROM books WHERE indexed_at != ?1",
            params![scan_token],
        )
        .map_err(|error| error.to_string())?;

    transaction.commit().map_err(|error| error.to_string())?;

    Ok(())
}

/// Convenience wrapper combining the walk and the upsert. Production code
/// calls `collect_indexable_books` + `index_books` separately so the
/// filesystem walk runs without holding the connection lock; this single-call
/// form is retained for tests that operate on an isolated in-memory database.
#[cfg(test)]
fn scan_and_index(
    connection: &mut Connection,
    config: &AppConfig,
    excluded_patterns: &CompiledExcludePatterns,
) -> Result<(), String> {
    let books = collect_indexable_books(config, excluded_patterns)?;
    let scan_token = current_scan_token()?;
    index_books(connection, &books, scan_token)
}

pub fn load_snapshot(
    connection: &Connection,
    config: &AppConfig,
) -> Result<LibrarySnapshot, String> {
    let (existing_library_roots, missing_library_roots): (Vec<_>, Vec<_>) = config
        .library_roots
        .iter()
        .cloned()
        .partition(|root| Path::new(root).exists());

    let mut tags_statement = connection
        .prepare(
            "
            SELECT file_path, tag
            FROM book_tags
            ORDER BY tag COLLATE NOCASE ASC
            ",
        )
        .map_err(|error| error.to_string())?;

    let mut tags_by_file_path: HashMap<String, Vec<String>> = HashMap::new();
    let tag_rows = tags_statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|error| error.to_string())?;

    for row in tag_rows {
        let (file_path, tag) = row.map_err(|error| error.to_string())?;
        tags_by_file_path.entry(file_path).or_default().push(tag);
    }

    let mut books = Vec::new();

    let mut pdf_statement = connection
        .prepare(
            "
            SELECT
              books.file_name,
              books.file_path,
              books.file_size,
              COALESCE(book_metadata.authors_json, '[]'),
              COALESCE(book_metadata.cover_url, ''),
              books.modified_at,
              COALESCE(book_metadata.asin, ''),
              COALESCE(book_metadata.url, ''),
              COALESCE(book_metadata.title, ''),
              books.source_type,
              COALESCE(book_metadata.publisher, ''),
              COALESCE(book_metadata.release_date, ''),
              COALESCE(book_metadata.language, ''),
              reading_positions.updated_at,
              books.indexed_at
            FROM books
            LEFT JOIN book_metadata ON book_metadata.file_path = books.file_path
            LEFT JOIN reading_positions ON reading_positions.file_path = books.file_path
            ORDER BY books.modified_at DESC, books.file_name ASC
            ",
        )
        .map_err(|error| error.to_string())?;

    let pdf_rows = pdf_statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, u64>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, u64>(5)?,
                row.get::<_, String>(6)?,
                row.get::<_, String>(7)?,
                row.get::<_, String>(8)?,
                row.get::<_, String>(9)?,
                row.get::<_, String>(10)?,
                row.get::<_, String>(11)?,
                row.get::<_, String>(12)?,
                row.get::<_, Option<u64>>(13)?,
                row.get::<_, u64>(14)?,
            ))
        })
        .map_err(|error| error.to_string())?;

    for row in pdf_rows {
        let (
            file_name,
            file_path,
            file_size,
            authors_json,
            cover_url,
            sort_key,
            asin,
            url,
            title,
            source_type,
            publisher,
            release_date,
            language,
            last_read_at,
            indexed_at,
        ) = row.map_err(|error| error.to_string())?;
        let authors = serde_json::from_str::<Vec<String>>(&authors_json).unwrap_or_default();
        books.push((
            sort_key,
            BookSummary {
                file_name,
                title: if title.is_empty() { None } else { Some(title) },
                tags: tags_by_file_path.remove(&file_path).unwrap_or_default(),
                file_path,
                file_size,
                authors,
                source_type,
                cover_url: if cover_url.is_empty() {
                    None
                } else {
                    Some(cover_url)
                },
                location_label: None,
                is_openable: true,
                asin: if asin.is_empty() { None } else { Some(asin) },
                url: if url.is_empty() { None } else { Some(url) },
                publisher: if publisher.is_empty() {
                    None
                } else {
                    Some(publisher)
                },
                release_date: if release_date.is_empty() {
                    None
                } else {
                    Some(release_date)
                },
                language: if language.is_empty() {
                    None
                } else {
                    Some(language)
                },
                last_read_at,
                indexed_at,
            },
        ));
    }

    // PDF-priority deduplication: when both book.pdf and book.epub exist in the
    // same directory, only show the PDF and suppress the EPUB entry.
    let pdf_keys: HashSet<(String, String)> = books
        .iter()
        .filter(|(_, book)| book.source_type == "pdf")
        .filter_map(|(_, book)| {
            let path = Path::new(&book.file_path);
            let parent = path.parent()?.to_string_lossy().to_lowercase();
            let stem = path.file_stem()?.to_string_lossy().to_lowercase();
            Some((parent, stem))
        })
        .collect();

    books.retain(|(_, book)| {
        if book.source_type != "epub" {
            return true;
        }
        let path = Path::new(&book.file_path);
        let Some(parent) = path.parent() else {
            return true;
        };
        let Some(stem) = path.file_stem() else {
            return true;
        };
        let key = (
            parent.to_string_lossy().to_lowercase(),
            stem.to_string_lossy().to_lowercase(),
        );
        !pdf_keys.contains(&key)
    });

    let mut external_statement = connection
        .prepare(
            "
            SELECT
              eb.file_path,
              eb.source_type,
              eb.title,
              eb.authors_json,
              eb.cover_url,
              eb.updated_at,
              eb.asin,
              eb.url,
              eb.publisher,
              eb.release_date,
              eb.language,
              rp.updated_at,
              eb.updated_at
            FROM external_books eb
            LEFT JOIN reading_positions rp ON rp.file_path = eb.file_path
            ORDER BY eb.updated_at DESC, eb.title COLLATE NOCASE ASC
            ",
        )
        .map_err(|error| error.to_string())?;

    let external_rows = external_statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, u64>(5)?,
                row.get::<_, String>(6)?,
                row.get::<_, String>(7)?,
                row.get::<_, String>(8)?,
                row.get::<_, String>(9)?,
                row.get::<_, String>(10)?,
                row.get::<_, Option<u64>>(11)?,
                row.get::<_, u64>(12)?,
            ))
        })
        .map_err(|error| error.to_string())?;

    // Load custom sources to resolve location labels for custom books
    let mut custom_sources_stmt = connection
        .prepare("SELECT id, name, icon FROM custom_sources ORDER BY created_at ASC")
        .map_err(|error| error.to_string())?;
    let custom_sources: Vec<CustomSource> = custom_sources_stmt
        .query_map([], |row| {
            Ok(CustomSource {
                id: row.get(0)?,
                name: row.get(1)?,
                icon: row.get(2)?,
            })
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;

    for row in external_rows {
        let (
            file_path,
            source_type,
            title,
            authors_json,
            cover_url,
            sort_key,
            asin,
            url,
            publisher,
            release_date,
            language,
            last_read_at,
            indexed_at,
        ) = row.map_err(|error| error.to_string())?;
        let authors = serde_json::from_str::<Vec<String>>(&authors_json).unwrap_or_default();
        let location_label = if source_type == "kindle" {
            Some("Kindle library".to_string())
        } else {
            custom_sources
                .iter()
                .find(|s| s.id == source_type)
                .map(|s| s.name.clone())
        };
        books.push((
            sort_key,
            BookSummary {
                file_name: title,
                title: None,
                tags: tags_by_file_path.remove(&file_path).unwrap_or_default(),
                file_path,
                file_size: 0,
                authors,
                source_type,
                cover_url: if cover_url.is_empty() {
                    None
                } else {
                    Some(cover_url)
                },
                location_label,
                is_openable: false,
                asin: if asin.is_empty() { None } else { Some(asin) },
                url: if url.is_empty() { None } else { Some(url) },
                publisher: if publisher.is_empty() {
                    None
                } else {
                    Some(publisher)
                },
                release_date: if release_date.is_empty() {
                    None
                } else {
                    Some(release_date)
                },
                language: if language.is_empty() {
                    None
                } else {
                    Some(language)
                },
                last_read_at,
                indexed_at,
            },
        ));
    }

    books.sort_by(|(left_key, left_book), (right_key, right_book)| {
        right_key
            .cmp(left_key)
            .then_with(|| left_book.file_name.cmp(&right_book.file_name))
    });

    let indexed_count = books.len();
    let books = books.into_iter().map(|(_, book)| book).collect();

    Ok(LibrarySnapshot {
        library_roots: config.library_roots.clone(),
        existing_library_roots,
        missing_library_roots,
        indexed_count,
        books,
        excluded_patterns: config.excluded_patterns.clone(),
        pdf_renderer: config.pdf_renderer.clone(),
        custom_sources,
    })
}

pub fn should_rescan(event: &Event, excluded_patterns: &CompiledExcludePatterns) -> bool {
    event.paths.iter().any(|path| {
        (path.is_dir() && !matches_excluded_pattern(path, excluded_patterns))
            || should_include_book(path, excluded_patterns)
    })
}

/// Why a dropped or chosen folder cannot become a library root.
#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum LibraryRootRejection {
    NotADirectory,
    /// The asset protocol and the `riida-epub:` scheme only serve `$HOME/**`,
    /// so books outside it would be listed but could not be opened.
    OutsideHome,
    AlreadyInLibrary,
}

pub fn check_library_root_candidate(
    candidate: &Path,
    is_dir: bool,
    home: Option<&Path>,
    existing_roots: &[String],
) -> Result<(), LibraryRootRejection> {
    if !is_dir {
        return Err(LibraryRootRejection::NotADirectory);
    }
    if home.is_some_and(|home| !candidate.starts_with(home)) {
        return Err(LibraryRootRejection::OutsideHome);
    }
    // A folder inside an existing root is already scanned through it.
    if existing_roots
        .iter()
        .any(|root| candidate.starts_with(Path::new(root)))
    {
        return Err(LibraryRootRejection::AlreadyInLibrary);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{compile_exclude_patterns, AppConfig, DEFAULT_PDF_RENDERER, DEFAULT_THEME};
    use crate::test_support::{
        books_schema_connection, create_snapshot_schema, test_config, unique_temp_dir,
    };
    use notify::event::{CreateKind, DataChange, ModifyKind, RemoveKind};
    use notify::{Event, EventKind};
    use rusqlite::{params, Connection};
    use std::fs;
    use std::path::Path;
    use std::time::UNIX_EPOCH;

    #[test]
    fn excluded_patterns_match_paths_and_file_names() {
        let compiled =
            compile_exclude_patterns(&test_config(&["**/backup/**", "*.bak.pdf", "prefix_*"]))
                .expect("patterns should compile");

        assert!(matches_excluded_pattern(
            Path::new("/tmp/library/backup/book.pdf"),
            &compiled
        ));
        assert!(matches_excluded_pattern(
            Path::new("/tmp/library/prefix_manual.pdf"),
            &compiled
        ));
        assert!(matches_excluded_pattern(
            Path::new("/tmp/library/archive/document.bak.pdf"),
            &compiled
        ));
        assert!(!matches_excluded_pattern(
            Path::new("/tmp/library/archive/document.bak"),
            &compiled
        ));
        assert!(!matches_excluded_pattern(
            Path::new("/tmp/library/regular/document.pdf"),
            &compiled
        ));
    }

    #[test]
    fn should_include_pdf_only_accepts_non_excluded_pdfs() {
        let compiled = compile_exclude_patterns(&test_config(&["**/backup/**", "*.bak.pdf"]))
            .expect("patterns should compile");

        assert!(should_include_pdf(
            Path::new("/tmp/library/regular/document.pdf"),
            &compiled
        ));
        assert!(!should_include_pdf(
            Path::new("/tmp/library/backup/document.pdf"),
            &compiled
        ));
        assert!(!should_include_pdf(
            Path::new("/tmp/library/regular/document.bak.pdf"),
            &compiled
        ));
        assert!(!should_include_pdf(
            Path::new("/tmp/library/regular/document.bak"),
            &compiled
        ));
        assert!(!should_include_pdf(
            Path::new("/tmp/library/regular/document.epub"),
            &compiled
        ));
    }

    #[test]
    fn should_include_book_accepts_epub_files() {
        let compiled = compile_exclude_patterns(&test_config(&["**/backup/**", "*.bak.epub"]))
            .expect("patterns should compile");

        assert!(should_include_book(
            Path::new("/tmp/library/regular/document.epub"),
            &compiled
        ));
        assert!(should_include_book(
            Path::new("/tmp/library/regular/document.pdf"),
            &compiled
        ));
        assert!(!should_include_book(
            Path::new("/tmp/library/backup/document.epub"),
            &compiled
        ));
        assert!(!should_include_book(
            Path::new("/tmp/library/regular/document.bak.epub"),
            &compiled
        ));
        assert!(!should_include_book(
            Path::new("/tmp/library/regular/document.txt"),
            &compiled
        ));
    }

    #[test]
    fn check_library_root_candidate_accepts_new_folder_under_home() {
        let roots = vec!["/Users/reader/Documents/Ebooks".to_string()];
        assert_eq!(
            check_library_root_candidate(
                Path::new("/Users/reader/Books"),
                true,
                Some(Path::new("/Users/reader")),
                &roots,
            ),
            Ok(())
        );
        // A parent of an existing root is a new, wider root, not a duplicate.
        assert_eq!(
            check_library_root_candidate(
                Path::new("/Users/reader/Documents"),
                true,
                Some(Path::new("/Users/reader")),
                &roots,
            ),
            Ok(())
        );
        // Without a known home there is nothing to confine the folder to.
        assert_eq!(
            check_library_root_candidate(Path::new("/Volumes/Books"), true, None, &[]),
            Ok(())
        );
    }

    #[test]
    fn check_library_root_candidate_rejects_unusable_folders() {
        let home = Some(Path::new("/Users/reader"));
        let roots = vec!["/Users/reader/Documents/Ebooks/".to_string()];

        assert_eq!(
            check_library_root_candidate(
                Path::new("/Users/reader/Books/novel.pdf"),
                false,
                home,
                &roots,
            ),
            Err(LibraryRootRejection::NotADirectory)
        );
        assert_eq!(
            check_library_root_candidate(Path::new("/Volumes/Books"), true, home, &roots),
            Err(LibraryRootRejection::OutsideHome)
        );
        // Component-wise: a sibling sharing the home prefix is still outside.
        assert_eq!(
            check_library_root_candidate(Path::new("/Users/reader2"), true, home, &roots),
            Err(LibraryRootRejection::OutsideHome)
        );
        assert_eq!(
            check_library_root_candidate(
                Path::new("/Users/reader/Documents/Ebooks"),
                true,
                home,
                &roots,
            ),
            Err(LibraryRootRejection::AlreadyInLibrary)
        );
        assert_eq!(
            check_library_root_candidate(
                Path::new("/Users/reader/Documents/Ebooks/Comics"),
                true,
                home,
                &roots,
            ),
            Err(LibraryRootRejection::AlreadyInLibrary)
        );
    }

    #[test]
    fn should_rescan_ignores_excluded_paths_and_non_book_files() {
        let compiled = compile_exclude_patterns(&test_config(&["**/backup/**", "*.bak"]))
            .expect("patterns should compile");

        let temp_root = std::env::temp_dir().join(format!(
            "riida-test-{}",
            std::time::SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("time should move forward")
                .as_nanos()
        ));
        let backup_dir = temp_root.join("backup");
        let regular_dir = temp_root.join("regular");
        fs::create_dir_all(&backup_dir).expect("backup dir should be created");
        fs::create_dir_all(&regular_dir).expect("regular dir should be created");

        let excluded_dir_event = Event {
            kind: EventKind::Create(CreateKind::Folder),
            paths: vec![backup_dir.clone()],
            attrs: Default::default(),
        };
        let pdf_event = Event {
            kind: EventKind::Modify(ModifyKind::Data(DataChange::Content)),
            paths: vec![regular_dir.join("book.pdf")],
            attrs: Default::default(),
        };
        let txt_event = Event {
            kind: EventKind::Modify(ModifyKind::Data(DataChange::Content)),
            paths: vec![regular_dir.join("notes.txt")],
            attrs: Default::default(),
        };
        let epub_event = Event {
            kind: EventKind::Modify(ModifyKind::Data(DataChange::Content)),
            paths: vec![regular_dir.join("book.epub")],
            attrs: Default::default(),
        };
        let regular_dir_event = Event {
            kind: EventKind::Remove(RemoveKind::Folder),
            paths: vec![regular_dir.clone()],
            attrs: Default::default(),
        };

        assert!(!should_rescan(&excluded_dir_event, &compiled));
        assert!(should_rescan(&pdf_event, &compiled));
        assert!(!should_rescan(&txt_event, &compiled));
        assert!(should_rescan(&epub_event, &compiled));
        assert!(should_rescan(&regular_dir_event, &compiled));

        let _ = fs::remove_dir_all(&temp_root);
    }

    #[test]
    fn scan_and_index_removes_books_that_become_excluded_after_config_changes() {
        let mut connection = Connection::open_in_memory().expect("in-memory db should open");
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
            .expect("books schema should be created");

        let temp_root = unique_temp_dir("scan-index-config-change");
        let kindlepw_dir = temp_root.join("KindlePW");
        fs::create_dir_all(&kindlepw_dir).expect("kindlepw dir should be created");
        fs::write(kindlepw_dir.join("Guide.pdf"), "pdf").expect("pdf fixture should be written");

        let initial_config = AppConfig {
            library_roots: vec![temp_root.to_string_lossy().into_owned()],
            excluded_patterns: Vec::new(),
            pdf_renderer: DEFAULT_PDF_RENDERER.to_string(),
            theme: DEFAULT_THEME.to_string(),
            enabled_external_sources: vec![],
        };
        let initial_patterns =
            compile_exclude_patterns(&initial_config).expect("initial patterns should compile");
        scan_and_index(&mut connection, &initial_config, &initial_patterns)
            .expect("initial scan should succeed");
        let initial_snapshot =
            load_snapshot(&connection, &initial_config).expect("initial snapshot should load");
        assert_eq!(initial_snapshot.indexed_count, 1);

        let updated_config = AppConfig {
            library_roots: vec![temp_root.to_string_lossy().into_owned()],
            excluded_patterns: vec!["**/kindlepw/**".to_string(), "kindlepw*".to_string()],
            pdf_renderer: DEFAULT_PDF_RENDERER.to_string(),
            theme: DEFAULT_THEME.to_string(),
            enabled_external_sources: vec![],
        };
        let updated_patterns =
            compile_exclude_patterns(&updated_config).expect("updated patterns should compile");
        scan_and_index(&mut connection, &updated_config, &updated_patterns)
            .expect("updated scan should succeed");
        let updated_snapshot =
            load_snapshot(&connection, &updated_config).expect("updated snapshot should load");
        assert_eq!(updated_snapshot.indexed_count, 0);
        assert!(updated_snapshot.books.is_empty());

        let _ = fs::remove_dir_all(temp_root);
    }

    #[test]
    fn uuid_v4_has_canonical_shape() {
        let id = uuid_v4();
        let bytes = id.as_bytes();

        assert_eq!(id.len(), 36, "uuid {id} should be 36 chars");
        for index in [8usize, 13, 18, 23] {
            assert_eq!(bytes[index], b'-', "expected hyphen at {index} in {id}");
        }
        assert_eq!(bytes[14], b'4', "version nibble should be 4 in {id}");
        assert!(
            matches!(bytes[19], b'8' | b'9' | b'a' | b'b'),
            "variant nibble in {id}"
        );
    }

    #[test]
    fn modified_unix_seconds_reads_file_mtime() {
        let dir = unique_temp_dir("mtime");
        let path = dir.join("f.bin");
        fs::write(&path, b"x").expect("file should write");
        fs::File::options()
            .write(true)
            .open(&path)
            .expect("file should open")
            .set_modified(UNIX_EPOCH + std::time::Duration::from_secs(1_700_000_000))
            .expect("mtime should set");
        let metadata = fs::metadata(&path).expect("metadata should read");
        assert_eq!(modified_unix_seconds(&metadata), 1_700_000_000);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn load_snapshot_labels_custom_source_books() {
        let connection = Connection::open_in_memory().expect("in-memory db should open");
        create_snapshot_schema(&connection);
        connection
            .execute(
                "INSERT INTO custom_sources (id, name, icon, created_at) VALUES ('zenn', 'Zenn', 'i', 1)",
                [],
            )
            .expect("custom source should insert");
        connection
            .execute(
                "INSERT INTO external_books (file_path, source_type, title, authors_json, \
                 description, publisher, release_date, language, url, asin, cover_url, updated_at) \
                 VALUES ('zenn:1', 'zenn', 'Z', '[]', '', '', '', '', '', '', '', 1)",
                [],
            )
            .expect("custom-source book should insert");

        let snapshot = load_snapshot(&connection, &test_config(&[])).expect("snapshot should load");
        let book = snapshot
            .books
            .iter()
            .find(|b| b.file_path == "zenn:1")
            .expect("custom-source book should be present");
        // The label is resolved from custom_sources by matching id == source_type.
        assert_eq!(book.location_label, Some("Zenn".to_string()));
    }

    #[test]
    fn load_snapshot_includes_external_kindle_books() {
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
                VALUES (?1, 'kindle', ?2, ?3, '', '', '', 'ja', '', 'B09MLLNP2B', ?4, 10)
                ",
                params![
                    "kindle:B09MLLNP2B",
                    "bit 1995年09月号",
                    "[\"石田晴久\",\"竹内郁雄\"]",
                    "https://example.com/cover.jpg"
                ],
            )
            .expect("external book should be inserted");
        connection
            .execute(
                "INSERT INTO book_tags (file_path, tag) VALUES (?1, ?2)",
                params!["kindle:B09MLLNP2B", "magazine"],
            )
            .expect("tag should be inserted");

        let snapshot = load_snapshot(&connection, &test_config(&[])).expect("snapshot should load");
        assert_eq!(snapshot.indexed_count, 1);
        assert_eq!(snapshot.books.len(), 1);
        assert_eq!(snapshot.books[0].file_path, "kindle:B09MLLNP2B");
        assert_eq!(snapshot.books[0].source_type, "kindle");
        assert_eq!(
            snapshot.books[0].cover_url,
            Some("https://example.com/cover.jpg".to_string())
        );
        assert_eq!(snapshot.books[0].authors, vec!["石田晴久", "竹内郁雄"]);
        assert_eq!(snapshot.books[0].tags, vec!["magazine"]);
        assert_eq!(
            snapshot.books[0].location_label,
            Some("Kindle library".to_string())
        );
        assert!(!snapshot.books[0].is_openable);
    }

    #[test]
    fn load_snapshot_epub_only_book_is_shown() {
        let mut connection = books_schema_connection();
        let temp_root = unique_temp_dir("epub-only");
        fs::create_dir_all(&temp_root).expect("temp dir should be created");
        fs::write(temp_root.join("novel.epub"), "epub").expect("epub fixture should be written");

        let config = AppConfig {
            library_roots: vec![temp_root.to_string_lossy().into_owned()],
            excluded_patterns: Vec::new(),
            pdf_renderer: DEFAULT_PDF_RENDERER.to_string(),
            theme: DEFAULT_THEME.to_string(),
            enabled_external_sources: vec![],
        };
        let patterns = compile_exclude_patterns(&config).expect("patterns should compile");
        scan_and_index(&mut connection, &config, &patterns).expect("scan should succeed");
        let snapshot = load_snapshot(&connection, &config).expect("snapshot should load");

        assert_eq!(snapshot.indexed_count, 1);
        assert_eq!(snapshot.books[0].source_type, "epub");
        assert!(snapshot.books[0].is_openable);

        let _ = fs::remove_dir_all(temp_root);
    }

    #[test]
    fn load_snapshot_pdf_takes_priority_over_same_stem_epub() {
        let mut connection = books_schema_connection();
        let temp_root = unique_temp_dir("pdf-epub-dedup");
        fs::create_dir_all(&temp_root).expect("temp dir should be created");
        fs::write(temp_root.join("book.pdf"), "pdf").expect("pdf fixture should be written");
        fs::write(temp_root.join("book.epub"), "epub").expect("epub fixture should be written");
        fs::write(temp_root.join("epub-only.epub"), "epub")
            .expect("epub-only fixture should be written");

        let config = AppConfig {
            library_roots: vec![temp_root.to_string_lossy().into_owned()],
            excluded_patterns: Vec::new(),
            pdf_renderer: DEFAULT_PDF_RENDERER.to_string(),
            theme: DEFAULT_THEME.to_string(),
            enabled_external_sources: vec![],
        };
        let patterns = compile_exclude_patterns(&config).expect("patterns should compile");
        scan_and_index(&mut connection, &config, &patterns).expect("scan should succeed");
        let snapshot = load_snapshot(&connection, &config).expect("snapshot should load");

        // book.epub is suppressed; book.pdf and epub-only.epub are shown
        assert_eq!(snapshot.indexed_count, 2);
        let shown_paths: Vec<&str> = snapshot
            .books
            .iter()
            .map(|b| b.file_path.as_str())
            .collect();
        assert!(
            shown_paths.iter().any(|p| p.ends_with("book.pdf")),
            "book.pdf should be shown"
        );
        assert!(
            shown_paths.iter().any(|p| p.ends_with("epub-only.epub")),
            "epub-only.epub should be shown"
        );
        assert!(
            !shown_paths.iter().any(|p| p.ends_with("book.epub")),
            "book.epub should be suppressed"
        );

        let _ = fs::remove_dir_all(temp_root);
    }
}
