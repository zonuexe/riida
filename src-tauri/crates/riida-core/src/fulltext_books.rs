//! Library-side glue for full-text indexing: which books to index and their documents.

use crate::{fulltext, fulltext_extract, fulltext_pool};
use rusqlite::{params, Connection, OptionalExtension};
use std::collections::HashMap;

/// All data needed to index one book, gathered under the DB lock so the slow
/// extraction can run lock-free afterwards.
pub struct BookIndexInput {
    pub file_path: String,
    pub source_type: String,
    pub modified_at: u64,
    pub title: String,
    pub authors: Vec<String>,
    pub publisher: String,
    pub description: String,
    pub release_date: String,
    pub language: String,
    pub asin: String,
    pub url: String,
    pub tags: Vec<String>,
    pub note: Option<String>,
    pub password: Option<String>,
}

impl BookIndexInput {
    pub fn is_pdf(&self) -> bool {
        self.source_type == "pdf"
    }
    pub fn is_epub(&self) -> bool {
        self.source_type == "epub"
    }
}

/// Read every book (local + external) plus its tags, note, and password into
/// owned structs. Three small full-table maps avoid N+1 queries.
pub fn gather_books_for_index(connection: &Connection) -> Result<Vec<BookIndexInput>, String> {
    let mut tags_by_path: HashMap<String, Vec<String>> = HashMap::new();
    {
        let mut stmt = connection
            .prepare("SELECT file_path, tag FROM book_tags ORDER BY tag")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|e| e.to_string())?;
        for row in rows {
            let (path, tag) = row.map_err(|e| e.to_string())?;
            tags_by_path.entry(path).or_default().push(tag);
        }
    }

    let mut note_by_path: HashMap<String, String> = HashMap::new();
    {
        let mut stmt = connection
            .prepare("SELECT file_path, content FROM notes")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|e| e.to_string())?;
        for row in rows {
            let (path, content) = row.map_err(|e| e.to_string())?;
            note_by_path.insert(path, content);
        }
    }

    let mut password_by_path: HashMap<String, String> = HashMap::new();
    {
        let mut stmt = connection
            .prepare("SELECT file_path, password FROM pdf_passwords")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|e| e.to_string())?;
        for row in rows {
            let (path, password) = row.map_err(|e| e.to_string())?;
            password_by_path.insert(path, password);
        }
    }

    let mut books = Vec::new();

    // Local, file-backed books (PDF/EPUB) with optional metadata override.
    {
        let mut stmt = connection
            .prepare(
                "SELECT b.file_path, b.file_name, b.source_type, b.modified_at,
                        COALESCE(m.title, ''), COALESCE(m.authors_json, '[]'),
                        COALESCE(m.publisher, ''), COALESCE(m.description, ''),
                        COALESCE(m.release_date, ''), COALESCE(m.language, ''),
                        COALESCE(m.asin, ''), COALESCE(m.url, '')
                 FROM books b
                 LEFT JOIN book_metadata m ON m.file_path = b.file_path",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, String>(7)?,
                    row.get::<_, String>(8)?,
                    row.get::<_, String>(9)?,
                    row.get::<_, String>(10)?,
                    row.get::<_, String>(11)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        for row in rows {
            let (
                file_path,
                file_name,
                source_type,
                modified_at,
                title,
                authors_json,
                publisher,
                description,
                release_date,
                language,
                asin,
                url,
            ) = row.map_err(|e| e.to_string())?;
            let title = if title.trim().is_empty() {
                file_name
            } else {
                title
            };
            let authors = serde_json::from_str::<Vec<String>>(&authors_json).unwrap_or_default();
            books.push(BookIndexInput {
                tags: tags_by_path.get(&file_path).cloned().unwrap_or_default(),
                note: note_by_path.get(&file_path).cloned(),
                password: password_by_path.get(&file_path).cloned(),
                file_path,
                source_type,
                modified_at: modified_at.max(0) as u64,
                title,
                authors,
                publisher,
                description,
                release_date,
                language,
                asin,
                url,
            });
        }
    }

    // External books (Kindle, custom sources): metadata-only, no body.
    {
        let mut stmt = connection
            .prepare(
                "SELECT file_path, source_type, title, authors_json, description,
                        publisher, release_date, language, url, asin
                 FROM external_books",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, String>(7)?,
                    row.get::<_, String>(8)?,
                    row.get::<_, String>(9)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        for row in rows {
            let (
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
            ) = row.map_err(|e| e.to_string())?;
            let authors = serde_json::from_str::<Vec<String>>(&authors_json).unwrap_or_default();
            books.push(BookIndexInput {
                tags: tags_by_path.get(&file_path).cloned().unwrap_or_default(),
                note: note_by_path.get(&file_path).cloned(),
                password: None,
                file_path,
                source_type,
                modified_at: 0,
                title,
                authors,
                publisher,
                description,
                release_date,
                language,
                asin,
                url,
            });
        }
    }

    Ok(books)
}

/// Whether a file is a cloud "online-only" (dataless) placeholder, judged from
/// its size and allocated blocks: a non-empty file with zero allocated blocks
/// has no local content (macOS File Provider / Dropbox etc.). Reading it would
/// force a download, so the indexer skips its body unless asked otherwise.
#[cfg(unix)]
fn is_dataless_blocks(len: u64, blocks: u64) -> bool {
    len > 0 && blocks == 0
}

#[cfg(unix)]
pub fn is_dataless(path: &str) -> bool {
    use std::os::unix::fs::MetadataExt;
    match std::fs::metadata(path) {
        Ok(meta) => is_dataless_blocks(meta.len(), meta.blocks()),
        // If we cannot stat it, treat it as present and let extraction fail
        // gracefully rather than silently skipping.
        Err(_) => false,
    }
}

// Windows has no sparse-file / cloud-placeholder block count via std; always
// treat files as locally present.
#[cfg(not(unix))]
pub fn is_dataless(_path: &str) -> bool {
    false
}

/// Build the `ContentDoc`s for one book. Metadata and note docs are always built
/// (they read only SQLite); the body is extracted only when `include_body` is
/// set (the caller skips it for online-only cloud files to avoid downloads).
pub fn base_docs_for_book(book: &BookIndexInput) -> Vec<fulltext::ContentDoc> {
    let mut docs = vec![fulltext_extract::build_metadata_doc(
        &book.file_path,
        &book.title,
        &book.authors,
        &book.publisher,
        &book.description,
        &book.release_date,
        &book.language,
        &book.asin,
        &book.url,
        &book.tags,
    )];

    if let Some(note) = &book.note {
        let note_doc = fulltext_extract::build_note_doc(&book.file_path, &book.title, note);
        if !note_doc.text.trim().is_empty() {
            docs.push(note_doc);
        }
    }

    docs
}

/// The worker-pool request for a book's body.
pub fn extract_request_for_book(book: &BookIndexInput) -> fulltext_pool::ExtractRequest {
    fulltext_pool::ExtractRequest {
        file_path: book.file_path.clone(),
        title: book.title.clone(),
        is_pdf: book.is_pdf(),
        password: book.password.clone(),
    }
}

/// Decide whether to extract a book's body now. Online-only cloud placeholders
/// are deferred (body skipped) unless the user opted to download them.
pub fn should_index_body(book: &BookIndexInput, include_online_only: bool) -> (bool, &'static str) {
    if !(book.is_pdf() || book.is_epub()) {
        return (false, "indexed"); // external/metadata-only book; nothing deferred
    }
    if !include_online_only && is_dataless(&book.file_path) {
        return (false, "deferred");
    }
    (true, "indexed")
}

/// Books per index commit during bulk indexing. A per-book `index_docs` call
/// pays a large fixed cost (writer setup + segment flush + fsync + reader
/// reload — ~250 ms measured on real data, regardless of book size), so bulk
/// paths accumulate extracted docs and commit per chunk instead. The write
/// lock is held only while a chunk commits, so the note/metadata save hooks
/// stay responsive during a long build.
const FULLTEXT_CHUNK_BOOKS: usize = 32;

/// Flush a chunk early once this much extracted text is pending, bounding
/// memory when a chunk happens to contain several very large books.
const FULLTEXT_CHUNK_TEXT_BYTES: usize = 16_000_000;

/// Accumulates extracted docs for several books and commits them in one
/// `index_docs` call. Status rows are reported by `flush` only after the
/// commit succeeded, so a crash mid-build never leaves a book marked
/// `indexed` without its documents.
#[derive(Default)]
pub struct FulltextChunk {
    pub docs: Vec<fulltext::ContentDoc>,
    /// (file_path, modified_at, status) for each pending book.
    pub books: Vec<(String, i64, &'static str)>,
    pub text_bytes: usize,
}

impl FulltextChunk {
    pub fn add(
        &mut self,
        book: &BookIndexInput,
        status: &'static str,
        docs: Vec<fulltext::ContentDoc>,
    ) {
        self.text_bytes += docs.iter().map(|d| d.text.len()).sum::<usize>();
        self.docs.extend(docs);
        self.books
            .push((book.file_path.clone(), book.modified_at as i64, status));
    }

    pub fn should_flush(&self) -> bool {
        self.books.len() >= FULLTEXT_CHUNK_BOOKS || self.text_bytes >= FULLTEXT_CHUNK_TEXT_BYTES
    }

    /// Commit pending docs and return the status rows to persist. If the
    /// commit fails, every book in the chunk is reported `failed`.
    pub fn flush(&mut self, index: &fulltext::FullTextIndex) -> Vec<(String, i64, &'static str)> {
        if self.books.is_empty() {
            return Vec::new();
        }
        let failed = if let Err(e) = index.index_docs(&self.docs) {
            eprintln!("index chunk failed ({} books): {e}", self.books.len());
            true
        } else {
            false
        };
        self.docs.clear();
        self.text_bytes = 0;
        let mut rows: Vec<(String, i64, &'static str)> = std::mem::take(&mut self.books);
        if failed {
            for row in &mut rows {
                row.2 = "failed";
            }
        }
        rows
    }
}

/// Decide whether a scan-time reconciliation needs to (re)index a book.
/// `dataless` is the file's current online-only state. Returns false when the
/// index is already up to date for that book.
pub fn sync_needs_reindex(
    book: &BookIndexInput,
    prev: Option<&(i64, String)>,
    dataless: bool,
) -> bool {
    match prev {
        None => true, // never indexed
        Some((ts, status)) => {
            book.modified_at as i64 > *ts            // file changed
                || (status == "deferred" && !dataless) // online-only file became local
        }
    }
}

fn fulltext_tags(connection: &Connection, file_path: &str) -> Vec<String> {
    let Ok(mut stmt) =
        connection.prepare("SELECT tag FROM book_tags WHERE file_path = ?1 ORDER BY tag")
    else {
        return Vec::new();
    };
    let Ok(rows) = stmt.query_map(params![file_path], |row| row.get::<_, String>(0)) else {
        return Vec::new();
    };
    rows.flatten().collect()
}

/// Build the metadata `ContentDoc` for one book (local or external), or None if
/// the book no longer exists.
pub fn fulltext_metadata_doc(
    connection: &Connection,
    file_path: &str,
) -> Option<fulltext::ContentDoc> {
    let tags = fulltext_tags(connection, file_path);

    let local = connection
        .query_row(
            "SELECT b.file_name, COALESCE(m.title, ''), COALESCE(m.authors_json, '[]'),
                    COALESCE(m.publisher, ''), COALESCE(m.description, ''),
                    COALESCE(m.release_date, ''), COALESCE(m.language, ''),
                    COALESCE(m.asin, ''), COALESCE(m.url, '')
             FROM books b LEFT JOIN book_metadata m ON m.file_path = b.file_path
             WHERE b.file_path = ?1",
            params![file_path],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, String>(7)?,
                    row.get::<_, String>(8)?,
                ))
            },
        )
        .optional()
        .ok()
        .flatten();
    if let Some((
        file_name,
        title,
        authors_json,
        publisher,
        description,
        release,
        lang,
        asin,
        url,
    )) = local
    {
        let title = if title.trim().is_empty() {
            file_name
        } else {
            title
        };
        let authors = serde_json::from_str::<Vec<String>>(&authors_json).unwrap_or_default();
        return Some(fulltext_extract::build_metadata_doc(
            file_path,
            &title,
            &authors,
            &publisher,
            &description,
            &release,
            &lang,
            &asin,
            &url,
            &tags,
        ));
    }

    let external = connection
        .query_row(
            "SELECT title, authors_json, description, publisher, release_date, language, url, asin
             FROM external_books WHERE file_path = ?1",
            params![file_path],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, String>(7)?,
                ))
            },
        )
        .optional()
        .ok()
        .flatten();
    if let Some((title, authors_json, description, publisher, release, lang, url, asin)) = external
    {
        let authors = serde_json::from_str::<Vec<String>>(&authors_json).unwrap_or_default();
        return Some(fulltext_extract::build_metadata_doc(
            file_path,
            &title,
            &authors,
            &publisher,
            &description,
            &release,
            &lang,
            &asin,
            &url,
            &tags,
        ));
    }

    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fulltext;
    use crate::test_support::{chunk_doc, fulltext_book};

    #[test]
    #[cfg(unix)]
    fn is_dataless_blocks_detects_online_only_files() {
        // Non-empty file with no allocated blocks = online-only placeholder.
        assert!(is_dataless_blocks(5_000_000, 0));
        // Materialized file has allocated blocks.
        assert!(!is_dataless_blocks(5_000_000, 9766));
        // A genuinely empty file is not "online-only".
        assert!(!is_dataless_blocks(0, 0));
    }

    #[test]
    fn should_index_body_defers_only_dataless_file_backed_books() {
        // External (metadata-only) book: never has a body, never deferred.
        let ext = fulltext_book("kindle:abc", "kindle", 0);
        assert_eq!(should_index_body(&ext, false), (false, "indexed"));
    }

    #[test]
    fn sync_needs_reindex_logic() {
        let book = fulltext_book("a.pdf", "pdf", 100);
        // Never indexed → yes.
        assert!(sync_needs_reindex(&book, None, false));
        // Up to date, local → no.
        assert!(!sync_needs_reindex(
            &book,
            Some(&(100, "indexed".into())),
            false
        ));
        // File changed (newer modified_at than recorded) → yes.
        assert!(sync_needs_reindex(
            &book,
            Some(&(50, "indexed".into())),
            false
        ));
        // Deferred and still online-only → no (do not download).
        assert!(!sync_needs_reindex(
            &book,
            Some(&(100, "deferred".into())),
            true
        ));
        // Deferred and now local → yes (pick up the body).
        assert!(sync_needs_reindex(
            &book,
            Some(&(100, "deferred".into())),
            false
        ));
    }

    #[test]
    fn base_docs_for_book_builds_metadata_and_nonempty_note() {
        let mut book = fulltext_book("a.pdf", "pdf", 1);
        let docs = base_docs_for_book(&book);
        assert_eq!(docs.len(), 1, "metadata only when no note");
        assert_eq!(docs[0].kind, fulltext::ContentKind::Metadata);

        book.note = Some("メモ本文".into());
        let docs = base_docs_for_book(&book);
        assert_eq!(docs.len(), 2);
        assert_eq!(docs[1].kind, fulltext::ContentKind::Note);
        assert_eq!(docs[1].text, "メモ本文");

        book.note = Some("   ".into());
        let docs = base_docs_for_book(&book);
        assert_eq!(docs.len(), 1, "blank note is not indexed");
    }

    #[test]
    fn extract_request_carries_book_identity() {
        let mut book = fulltext_book("a.epub", "epub", 1);
        book.title = "本のタイトル".into();
        book.password = Some("pw".into());
        let req = extract_request_for_book(&book);
        assert_eq!(req.file_path, "a.epub");
        assert_eq!(req.title, "本のタイトル");
        assert!(!req.is_pdf);
        assert_eq!(req.password.as_deref(), Some("pw"));
    }

    #[test]
    fn fulltext_chunk_flushes_on_book_count() {
        let book = fulltext_book("a.pdf", "pdf", 1);
        let mut chunk = FulltextChunk::default();
        assert!(!chunk.should_flush());
        for _ in 0..FULLTEXT_CHUNK_BOOKS - 1 {
            chunk.add(&book, "indexed", vec![]);
        }
        assert!(!chunk.should_flush(), "one below the book threshold");
        chunk.add(&book, "indexed", vec![]);
        assert!(chunk.should_flush(), "at the book threshold");
    }

    #[test]
    fn fulltext_chunk_flushes_on_accumulated_text_bytes() {
        let book = fulltext_book("a.pdf", "pdf", 1);
        let half = "x".repeat(FULLTEXT_CHUNK_TEXT_BYTES / 2);
        let mut chunk = FulltextChunk::default();
        chunk.add(&book, "indexed", vec![chunk_doc("a.pdf", &half)]);
        assert!(!chunk.should_flush(), "half the text budget");
        chunk.add(&book, "indexed", vec![chunk_doc("a.pdf", &half)]);
        assert!(chunk.should_flush(), "text bytes accumulate across adds");
    }

    #[test]
    fn fulltext_chunk_flush_commits_docs_and_reports_statuses() {
        let index = fulltext::FullTextIndex::in_ram().unwrap();
        let mut chunk = FulltextChunk::default();
        chunk.add(
            &fulltext_book("a.pdf", "pdf", 7),
            "indexed",
            vec![chunk_doc("a.pdf", "チャンク収集テスト")],
        );
        chunk.add(&fulltext_book("b.pdf", "pdf", 8), "deferred", vec![]);
        let rows = chunk.flush(&index);
        assert_eq!(
            rows,
            vec![
                ("a.pdf".to_string(), 7, "indexed"),
                ("b.pdf".to_string(), 8, "deferred"),
            ]
        );
        assert_eq!(index.search("チャンク", 10).unwrap().len(), 1);
        // Flushing emptied the chunk: nothing left to flush or re-index.
        assert!(chunk.flush(&index).is_empty());
        assert!(!chunk.should_flush());
    }

    #[test]
    #[cfg(unix)]
    fn fulltext_chunk_flush_marks_all_books_failed_when_commit_fails() {
        use crate::test_support::unique_temp_dir;
        use std::fs;
        use std::os::unix::fs::PermissionsExt;
        // A read-only index directory makes the commit (writer lock) fail.
        let dir = unique_temp_dir("fulltext-chunk-fail");
        let index = fulltext::FullTextIndex::open_or_create(&dir).unwrap();
        let mut perms = fs::metadata(&dir).unwrap().permissions();
        perms.set_mode(0o555);
        fs::set_permissions(&dir, perms).unwrap();

        let mut chunk = FulltextChunk::default();
        chunk.add(
            &fulltext_book("a.pdf", "pdf", 1),
            "indexed",
            vec![chunk_doc("a.pdf", "本文")],
        );
        let rows = chunk.flush(&index);

        let mut perms = fs::metadata(&dir).unwrap().permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&dir, perms).unwrap();
        let _ = fs::remove_dir_all(&dir);

        assert_eq!(rows, vec![("a.pdf".to_string(), 1, "failed")]);
    }
}
