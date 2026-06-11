//! Full-text search index (tantivy + lindera/IPADIC).
//!
//! This module owns the tantivy schema, the Japanese (lindera) tokenizer, and
//! the index lifecycle (open/create, upsert, delete, search). It is kept free
//! of Tauri/global-state coupling so the core can be unit-tested against a
//! temporary or in-RAM index.
//!
//! Document model (see docs/fulltext-search-design.md §3): one index with
//! content-unit documents distinguished by `kind`:
//!   - `metadata` — one doc per book (title/authors/publisher/… + tags)
//!   - `note`     — one doc per book's note
//!   - `body`     — one doc per PDF page / EPUB section
//!
//! Re-indexing granularity is per `(file_path, kind)` via the `doc_key` term,
//! so editing a note or re-extracting a body replaces only those documents.

use lindera::dictionary::load_dictionary;
use lindera::mode::Mode;
use lindera::segmenter::Segmenter;
use lindera_tantivy::tokenizer::LinderaTokenizer;
use serde::{Deserialize, Serialize};
use tantivy::collector::TopDocs;
use tantivy::directory::MmapDirectory;
use tantivy::query::QueryParser;
use tantivy::schema::{
    Field, IndexRecordOption, Schema, TextFieldIndexing, TextOptions, Value, STORED, STRING,
};
use tantivy::snippet::SnippetGenerator;
use tantivy::{doc, Index, IndexReader, IndexWriter, TantivyDocument, Term};

/// Tokenizer name registered on the index for all Japanese text fields.
const TOKENIZER: &str = "lang_ja";

/// Writer heap budget for bulk indexing. tantivy splits this across its worker
/// threads (≥15 MB each), so 100 MB yields ~6 indexing threads — transient
/// memory during a build only.
const WRITER_HEAP_BYTES: usize = 100_000_000;

/// Batches at or below this many docs use a minimal single-threaded writer
/// (15 MB, tantivy's floor). The incremental save hooks index one doc at a
/// time; spinning up the full multi-threaded writer for that wastes most of
/// its setup cost.
const SMALL_BATCH_MAX_DOCS: usize = 8;

/// Kind of content a document represents.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ContentKind {
    Metadata,
    Note,
    Body,
}

impl ContentKind {
    pub fn as_str(self) -> &'static str {
        match self {
            ContentKind::Metadata => "metadata",
            ContentKind::Note => "note",
            ContentKind::Body => "body",
        }
    }
}

/// A single content-unit document to index. Serde because the extraction
/// worker processes return these over the JSON-lines pipe (fulltext_pool).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContentDoc {
    pub file_path: String,
    pub kind: ContentKind,
    /// Denormalized book title, shown in results without a DB join.
    pub title: String,
    /// Author names joined; empty for non-metadata docs.
    pub authors: String,
    /// Tags joined; empty for non-metadata docs.
    pub tags: String,
    /// The searchable + snippet body.
    pub text: String,
    /// PDF page (1-based) for body docs; None otherwise.
    pub loc_page: Option<u64>,
    /// EPUB CFI / spine anchor for body docs; None otherwise.
    pub loc_anchor: Option<String>,
}

impl ContentDoc {
    /// Per-(path, kind) delete/replace key. NUL-separated so it can never
    /// collide with a real path or kind string.
    fn doc_key(&self) -> String {
        format!("{}\u{0}{}", self.file_path, self.kind.as_str())
    }
}

/// A search hit returned to the frontend.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FullTextHit {
    pub file_path: String,
    pub title: String,
    pub kind: String,
    pub page: Option<u64>,
    pub anchor: Option<String>,
    pub score: f32,
    pub snippet_html: String,
}

/// Handles to the schema fields, resolved once at open.
struct Fields {
    file_path: Field,
    doc_key: Field,
    kind: Field,
    loc_page: Field,
    loc_anchor: Field,
    title: Field,
    authors: Field,
    tags: Field,
    text: Field,
}

/// The full-text index plus its resolved fields and a reader.
pub struct FullTextIndex {
    index: Index,
    fields: Fields,
    reader: IndexReader,
    /// Serializes mutations: tantivy allows only one `IndexWriter` at a time, so
    /// concurrent index/delete calls (worker vs. save hooks) must not overlap.
    /// Reads (`search`) take no lock.
    write_lock: std::sync::Mutex<()>,
}

/// Build the tantivy schema. Japanese text fields use the lindera tokenizer and
/// keep positions so phrase queries and snippets work.
fn build_schema() -> (Schema, Fields) {
    let mut b = Schema::builder();

    let ja_text = || {
        TextOptions::default().set_indexing_options(
            TextFieldIndexing::default()
                .set_tokenizer(TOKENIZER)
                .set_index_option(IndexRecordOption::WithFreqsAndPositions),
        )
    };

    let file_path = b.add_text_field("file_path", STRING | STORED);
    let doc_key = b.add_text_field("doc_key", STRING);
    let kind = b.add_text_field("kind", STRING | STORED);
    let loc_page = b.add_u64_field("loc_page", STORED);
    let loc_anchor = b.add_text_field("loc_anchor", STORED);
    let title = b.add_text_field("title", ja_text().set_stored());
    let authors = b.add_text_field("authors", ja_text());
    let tags = b.add_text_field("tags", ja_text());
    let text = b.add_text_field("text", ja_text().set_stored());

    let schema = b.build();
    let fields = Fields {
        file_path,
        doc_key,
        kind,
        loc_page,
        loc_anchor,
        title,
        authors,
        tags,
        text,
    };
    (schema, fields)
}

/// Construct the lindera (IPADIC, embedded) tokenizer for tantivy.
fn build_tokenizer() -> Result<LinderaTokenizer, String> {
    let dictionary =
        load_dictionary("embedded://ipadic").map_err(|e| format!("load ipadic: {e}"))?;
    let segmenter = Segmenter::new(Mode::Normal, dictionary, None);
    Ok(LinderaTokenizer::from_segmenter(segmenter))
}

impl FullTextIndex {
    /// Open an existing on-disk index at `dir`, or create one there.
    pub fn open_or_create(dir: &std::path::Path) -> Result<Self, String> {
        std::fs::create_dir_all(dir).map_err(|e| format!("create index dir: {e}"))?;
        let (schema, fields) = build_schema();
        let mmap = MmapDirectory::open(dir).map_err(|e| format!("open index dir: {e}"))?;
        // Zstd for the doc store (the stored page text that snippets read).
        // Settings are persisted in meta.json at creation; an index created
        // before this change keeps lz4 until it is rebuilt.
        let settings = tantivy::IndexSettings {
            docstore_compression: tantivy::store::Compressor::Zstd(
                tantivy::store::ZstdCompressor::default(),
            ),
            ..Default::default()
        };
        let index = Index::builder()
            .schema(schema)
            .settings(settings)
            .open_or_create(mmap)
            .map_err(|e| format!("open_or_create index: {e}"))?;
        Self::finish(index, fields)
    }

    /// Create an in-RAM index (tests).
    #[cfg(test)]
    pub fn in_ram() -> Result<Self, String> {
        let (schema, fields) = build_schema();
        let index = Index::create_in_ram(schema);
        Self::finish(index, fields)
    }

    fn finish(index: Index, fields: Fields) -> Result<Self, String> {
        // Tokenizers are not persisted in the index; register on every open.
        index.tokenizers().register(TOKENIZER, build_tokenizer()?);
        let reader = index.reader().map_err(|e| format!("index reader: {e}"))?;
        Ok(Self {
            index,
            fields,
            reader,
            write_lock: std::sync::Mutex::new(()),
        })
    }

    fn lock_writes(&self) -> std::sync::MutexGuard<'_, ()> {
        self.write_lock
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Writer sized to the batch: bulk batches get the multi-threaded writer,
    /// tiny batches (save hooks, deletes) a minimal single-threaded one.
    fn writer(&self, batch_docs: usize) -> Result<IndexWriter, String> {
        if batch_docs <= SMALL_BATCH_MAX_DOCS {
            // 15 MB is tantivy's MEMORY_BUDGET_NUM_BYTES_MIN (not re-exported).
            self.index.writer_with_num_threads(1, 15_000_000)
        } else {
            self.index.writer(WRITER_HEAP_BYTES)
        }
        .map_err(|e| format!("index writer: {e}"))
    }

    /// Finish a mutation: commit, refresh the reader, and — for small batches —
    /// wait for the merges this commit kicked off.
    ///
    /// Dropping an `IndexWriter` aborts its in-flight merges, and every call
    /// here uses a fresh writer. Aborted merges leave superseded/partial
    /// segment files on disk that the next writer does not reclaim; measured on
    /// a real ~740 MB index, a handful of single-doc commits ballooned the
    /// directory to 5 GB. Small batches are the save hooks' path (background
    /// worker, latency-tolerant), so they wait. Bulk chunk commits skip the
    /// wait to keep merging overlapped with extraction; the bulk callers must
    /// call [`consolidate`](Self::consolidate) once at the end instead.
    fn finish_write(&self, writer: IndexWriter, batch_docs: usize) -> Result<(), String> {
        let mut writer = writer;
        writer.commit().map_err(|e| format!("commit: {e}"))?;
        self.reader.reload().map_err(|e| format!("reload: {e}"))?;
        if batch_docs <= SMALL_BATCH_MAX_DOCS {
            writer
                .wait_merging_threads()
                .map_err(|e| format!("wait merging threads: {e}"))?;
        }
        Ok(())
    }

    /// Run pending segment merges to completion and let tantivy delete the
    /// superseded files. Called once after a bulk build/sync, whose per-chunk
    /// writers abort their merges on drop (see [`finish_write`](Self::finish_write)).
    pub fn consolidate(&self) -> Result<(), String> {
        let _guard = self.lock_writes();
        let mut writer = self.writer(usize::MAX)?;
        // An (empty) commit makes the merge policy evaluate the current
        // segment set; waiting then runs those merges to completion and
        // garbage-collects replaced segment files.
        writer.commit().map_err(|e| format!("commit: {e}"))?;
        writer
            .wait_merging_threads()
            .map_err(|e| format!("wait merging threads: {e}"))?;
        self.reader.reload().map_err(|e| format!("reload: {e}"))?;
        Ok(())
    }

    /// Replace-and-insert a batch of documents. Every `(file_path, kind)` pair
    /// present in the batch is deleted first, so re-indexing a book's body (all
    /// pages in one batch) cleanly supersedes the previous version.
    pub fn index_docs(&self, docs: &[ContentDoc]) -> Result<(), String> {
        if docs.is_empty() {
            return Ok(());
        }
        let _guard = self.lock_writes();
        let writer = self.writer(docs.len())?;

        // Distinct doc_keys → one delete each (deletes precede adds in opstamp
        // order, so the freshly added docs survive).
        let mut seen = std::collections::HashSet::new();
        for d in docs {
            let key = d.doc_key();
            if seen.insert(key.clone()) {
                writer.delete_term(Term::from_field_text(self.fields.doc_key, &key));
            }
        }

        for d in docs {
            let mut tdoc = doc!(
                self.fields.file_path => d.file_path.as_str(),
                self.fields.doc_key => d.doc_key(),
                self.fields.kind => d.kind.as_str(),
                self.fields.title => d.title.as_str(),
                self.fields.authors => d.authors.as_str(),
                self.fields.tags => d.tags.as_str(),
                self.fields.text => d.text.as_str(),
            );
            if let Some(page) = d.loc_page {
                tdoc.add_u64(self.fields.loc_page, page);
            }
            if let Some(anchor) = &d.loc_anchor {
                tdoc.add_text(self.fields.loc_anchor, anchor);
            }
            writer
                .add_document(tdoc)
                .map_err(|e| format!("add document: {e}"))?;
        }

        self.finish_write(writer, docs.len())
    }

    /// Remove every document from the index (used by "clear index").
    pub fn delete_all(&self) -> Result<(), String> {
        let _guard = self.lock_writes();
        let writer = self.writer(0)?;
        writer
            .delete_all_documents()
            .map_err(|e| format!("delete all: {e}"))?;
        self.finish_write(writer, 0)
    }

    /// Delete every document for a book (all kinds) — used when a file is
    /// removed from the library.
    pub fn delete_book(&self, file_path: &str) -> Result<(), String> {
        let _guard = self.lock_writes();
        let writer = self.writer(0)?;
        writer.delete_term(Term::from_field_text(self.fields.file_path, file_path));
        self.finish_write(writer, 0)
    }

    /// Delete only the documents of one kind for a book.
    pub fn delete_kind(&self, file_path: &str, kind: ContentKind) -> Result<(), String> {
        let key = format!("{}\u{0}{}", file_path, kind.as_str());
        let _guard = self.lock_writes();
        let writer = self.writer(0)?;
        writer.delete_term(Term::from_field_text(self.fields.doc_key, &key));
        self.finish_write(writer, 0)
    }

    /// Search and return scored hits with highlighted snippets. The query runs
    /// over title/authors/tags/text with title and author boosted so a title
    /// match outranks a deep body match.
    pub fn search(&self, query_text: &str, limit: usize) -> Result<Vec<FullTextHit>, String> {
        let trimmed = query_text.trim();
        if trimmed.is_empty() {
            return Ok(Vec::new());
        }
        let searcher = self.reader.searcher();

        let mut parser = QueryParser::for_index(
            &self.index,
            vec![
                self.fields.title,
                self.fields.authors,
                self.fields.tags,
                self.fields.text,
            ],
        );
        parser.set_field_boost(self.fields.title, 3.0);
        parser.set_field_boost(self.fields.authors, 2.0);
        parser.set_field_boost(self.fields.tags, 2.0);

        // Lenient parsing: user input is not query syntax. Bare operators
        // ("AND"), trailing colons ("futures::"), unknown fields ("title:"),
        // and unclosed quotes must degrade to a best-effort term query
        // instead of failing the whole search. When the input is not valid
        // syntax, re-parse it with the metacharacters stripped — the lenient
        // parse alone would silently drop terms like `futures:` (an unknown
        // field reference) rather than match them as text.
        let (query, parse_errors) = parser.parse_query_lenient(trimmed);
        let query = if parse_errors.is_empty() {
            query
        } else {
            let (fallback, _) = parser.parse_query_lenient(&strip_query_syntax(trimmed));
            fallback
        };

        let mut snippet_gen = SnippetGenerator::create(&searcher, &query, self.fields.text)
            .map_err(|e| format!("snippet generator: {e}"))?;
        snippet_gen.set_max_num_chars(160);

        let top = searcher
            .search(&query, &TopDocs::with_limit(limit))
            .map_err(|e| format!("search: {e}"))?;

        // Per-hit cost is dominated by snippet generation (it tokenizes the
        // whole stored page text, ~0.6 ms per hit), so fan the hits out over a
        // few scoped threads. `snippet_from_doc` takes &self (it clones its
        // tokenizer internally), so the generator and searcher are shared.
        let per_thread = top.len().div_ceil(SNIPPET_THREADS).max(1);
        let mut slots: Vec<Option<FullTextHit>> = Vec::new();
        slots.resize_with(top.len(), || None);
        std::thread::scope(|scope| {
            let searcher = &searcher;
            let snippet_gen = &snippet_gen;
            let fields = &self.fields;
            for (top_chunk, out_chunk) in top.chunks(per_thread).zip(slots.chunks_mut(per_thread)) {
                scope.spawn(move || {
                    for ((score, addr), slot) in top_chunk.iter().zip(out_chunk.iter_mut()) {
                        *slot = build_hit(searcher, snippet_gen, fields, *score, *addr);
                    }
                });
            }
        });
        Ok(slots.into_iter().flatten().collect())
    }
}

/// How many threads share snippet generation for one search. Hits are cheap to
/// retrieve but each snippet tokenizes a full stored page; 4 threads cut a
/// 50-hit search's latency roughly in proportion without monopolizing cores.
const SNIPPET_THREADS: usize = 4;

/// Retrieve one hit's stored doc and render its snippet. Returns `None` if the
/// doc cannot be retrieved (practically impossible for a committed doc; the
/// remaining hits still succeed rather than failing the whole search).
fn build_hit(
    searcher: &tantivy::Searcher,
    snippet_gen: &SnippetGenerator,
    fields: &Fields,
    score: f32,
    addr: tantivy::DocAddress,
) -> Option<FullTextHit> {
    let tdoc: TantivyDocument = searcher.doc(addr).ok()?;
    let snippet = snippet_gen.snippet_from_doc(&tdoc).to_html();
    Some(FullTextHit {
        file_path: stored_text(&tdoc, fields.file_path),
        title: stored_text(&tdoc, fields.title),
        kind: stored_text(&tdoc, fields.kind),
        page: tdoc.get_first(fields.loc_page).and_then(|v| v.as_u64()),
        anchor: tdoc
            .get_first(fields.loc_anchor)
            .and_then(|v| v.as_str())
            .map(str::to_owned),
        score,
        snippet_html: snippet,
    })
}

/// Replace tantivy query-syntax metacharacters with spaces so the input can be
/// re-parsed as plain search terms. Used as the fallback when the raw input is
/// not valid query syntax; the lindera/default tokenizers discard this
/// punctuation anyway, so nothing searchable is lost.
fn strip_query_syntax(input: &str) -> String {
    input
        .chars()
        .map(|ch| match ch {
            '+' | '-' | '!' | '(' | ')' | '{' | '}' | '[' | ']' | '^' | '"' | '~' | '*' | '?'
            | ':' | '\\' => ' ',
            _ => ch,
        })
        .collect()
}

fn stored_text(doc: &TantivyDocument, field: Field) -> String {
    doc.get_first(field)
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_owned()
}

/// Normalize text extracted from a PDF/EPUB before tokenizing.
///
/// pdfium (and per-glyph-positioned PDFs, especially vertical/tategaki text)
/// can emit whitespace *between adjacent CJK glyphs* — `た と え ば` instead of
/// `たとえば` — which defeats morphological tokenization. This collapses
/// whitespace that sits between two Japanese glyphs, while preserving spaces at
/// genuine word boundaries (e.g. between Japanese and Latin runs). It also drops
/// control characters and trims leading/trailing whitespace, and collapses other
/// whitespace runs to a single space.
pub fn normalize_extracted_text(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut pending_ws = false;
    let mut last: Option<char> = None;

    for ch in input.chars() {
        if ch.is_whitespace() {
            pending_ws = true;
            continue;
        }
        if ch.is_control() {
            // Drop control chars; treat them like a (boundary) gap.
            pending_ws = true;
            continue;
        }
        if pending_ws {
            pending_ws = false;
            match last {
                // Leading whitespace: drop.
                None => {}
                // Between two Japanese glyphs: drop the space.
                Some(prev) if is_japanese_glyph(prev) && is_japanese_glyph(ch) => {}
                // Genuine boundary: keep a single space.
                Some(_) => out.push(' '),
            }
        }
        out.push(ch);
        last = Some(ch);
    }
    out
}

/// Whether a character is a Japanese glyph for whitespace-collapsing purposes.
/// Includes kana, CJK ideographs, CJK symbols/punctuation, and full/half-width
/// forms, so spaces around 、。「」 and full-width characters are also collapsed.
fn is_japanese_glyph(c: char) -> bool {
    matches!(c as u32,
        0x3000..=0x303F |   // CJK symbols and punctuation (includes 、。「」 and U+3000)
        0x3040..=0x309F |   // hiragana
        0x30A0..=0x30FF |   // katakana
        0x31F0..=0x31FF |   // katakana phonetic extensions
        0x3400..=0x4DBF |   // CJK unified ideographs ext A
        0x4E00..=0x9FFF |   // CJK unified ideographs
        0xF900..=0xFAFF |   // CJK compatibility ideographs
        0xFF00..=0xFFEF     // half/full-width forms
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- normalize_extracted_text -------------------------------------------

    #[test]
    fn collapses_spaces_between_japanese_glyphs() {
        assert_eq!(
            normalize_extracted_text("た と え ば 、 ム ウ 大 陸 だ 。"),
            "たとえば、ムウ大陸だ。"
        );
    }

    #[test]
    fn collapses_newlines_and_fullwidth_space_between_glyphs() {
        assert_eq!(normalize_extracted_text("内部\n\u{3000}文字"), "内部文字");
    }

    #[test]
    fn keeps_space_at_japanese_latin_boundary() {
        assert_eq!(normalize_extracted_text("日本 ABC"), "日本 ABC");
        assert_eq!(normalize_extracted_text("ABC 日本"), "ABC 日本");
    }

    #[test]
    fn keeps_space_between_latin_words() {
        assert_eq!(normalize_extracted_text("hello   world"), "hello world");
    }

    #[test]
    fn trims_and_drops_control_chars() {
        assert_eq!(
            normalize_extracted_text("  \u{0}検索\u{0}エンジン  "),
            "検索エンジン"
        );
    }

    #[test]
    fn empty_input_yields_empty() {
        assert_eq!(normalize_extracted_text(""), "");
        assert_eq!(normalize_extracted_text("   \n\t "), "");
    }

    // --- index lifecycle / search -------------------------------------------

    fn meta_doc(path: &str, title: &str, authors: &str, tags: &str, text: &str) -> ContentDoc {
        ContentDoc {
            file_path: path.into(),
            kind: ContentKind::Metadata,
            title: title.into(),
            authors: authors.into(),
            tags: tags.into(),
            text: text.into(),
            loc_page: None,
            loc_anchor: None,
        }
    }

    fn body_doc(path: &str, title: &str, page: u64, text: &str) -> ContentDoc {
        ContentDoc {
            file_path: path.into(),
            kind: ContentKind::Body,
            title: title.into(),
            authors: String::new(),
            tags: String::new(),
            text: text.into(),
            loc_page: Some(page),
            loc_anchor: None,
        }
    }

    #[test]
    fn indexes_and_searches_japanese_body() {
        let idx = FullTextIndex::in_ram().unwrap();
        idx.index_docs(&[
            body_doc(
                "a.pdf",
                "形態素の本",
                12,
                "全文検索エンジンと形態素解析の解説",
            ),
            body_doc("b.pdf", "料理の本", 3, "これは料理のレシピであって関係ない"),
        ])
        .unwrap();

        let hits = idx.search("検索", 10).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].file_path, "a.pdf");
        assert_eq!(hits[0].page, Some(12));
        assert_eq!(hits[0].kind, "body");
        assert!(hits[0].snippet_html.contains("<b>"), "snippet highlights");
    }

    #[test]
    fn title_match_outranks_body_match() {
        let idx = FullTextIndex::in_ram().unwrap();
        idx.index_docs(&[
            meta_doc("title.pdf", "検索の教科書", "著者", "", "概要"),
            body_doc("body.pdf", "別の本", 1, "本文の中に検索という語がある"),
        ])
        .unwrap();
        let hits = idx.search("検索", 10).unwrap();
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].file_path, "title.pdf", "title hit ranks first");
    }

    #[test]
    fn reindexing_body_replaces_old_pages() {
        let idx = FullTextIndex::in_ram().unwrap();
        idx.index_docs(&[body_doc("a.pdf", "本", 1, "古い内容のテキスト")])
            .unwrap();
        assert_eq!(idx.search("古い", 10).unwrap().len(), 1);

        // Re-index the same book's body with new text.
        idx.index_docs(&[body_doc("a.pdf", "本", 1, "新しい内容のテキスト")])
            .unwrap();
        assert!(idx.search("古い", 10).unwrap().is_empty(), "old pages gone");
        assert_eq!(idx.search("新しい", 10).unwrap().len(), 1);
    }

    #[test]
    fn delete_book_removes_all_docs() {
        let idx = FullTextIndex::in_ram().unwrap();
        idx.index_docs(&[
            meta_doc("a.pdf", "削除する本", "著者", "タグ", "メタ"),
            body_doc("a.pdf", "削除する本", 1, "本文のテキスト"),
        ])
        .unwrap();
        // "削除" is in the shared title → matches both the metadata and body docs.
        assert_eq!(idx.search("削除", 10).unwrap().len(), 2);
        idx.delete_book("a.pdf").unwrap();
        assert!(idx.search("削除", 10).unwrap().is_empty());
        assert!(idx.search("本文", 10).unwrap().is_empty());
    }

    #[test]
    fn delete_kind_keeps_other_kinds() {
        let idx = FullTextIndex::in_ram().unwrap();
        idx.index_docs(&[
            meta_doc("a.pdf", "本", "著者", "タグ", "メタ情報"),
            body_doc("a.pdf", "本", 1, "本文情報"),
        ])
        .unwrap();
        idx.delete_kind("a.pdf", ContentKind::Body).unwrap();
        assert!(idx.search("本文", 10).unwrap().is_empty(), "body removed");
        assert_eq!(idx.search("メタ", 10).unwrap().len(), 1, "metadata kept");
    }

    #[test]
    fn delete_all_empties_the_index() {
        let idx = FullTextIndex::in_ram().unwrap();
        idx.index_docs(&[
            meta_doc("a.pdf", "本A", "著者", "", "メタ"),
            body_doc("b.pdf", "本B", 1, "本文テキスト"),
        ])
        .unwrap();
        assert!(!idx.search("本", 10).unwrap().is_empty());
        idx.delete_all().unwrap();
        assert!(idx.search("本", 10).unwrap().is_empty());
        assert!(idx.search("本文", 10).unwrap().is_empty());
    }

    #[test]
    fn empty_query_returns_no_hits() {
        let idx = FullTextIndex::in_ram().unwrap();
        idx.index_docs(&[body_doc("a.pdf", "本", 1, "テキスト")])
            .unwrap();
        assert!(idx.search("   ", 10).unwrap().is_empty());
    }

    // --- query-syntax robustness ----------------------------------------------
    //
    // Users type plain text, not tantivy query syntax. Inputs that are invalid
    // as syntax (bare operators, trailing colons, unclosed quotes) must not
    // error out; they should parse leniently and still match where possible.

    #[test]
    fn strip_query_syntax_replaces_metacharacters_with_spaces() {
        assert_eq!(strip_query_syntax("futures::"), "futures  ");
        assert_eq!(strip_query_syntax("\"未閉じ"), " 未閉じ");
        assert_eq!(strip_query_syntax("a+b-c"), "a b c");
        assert_eq!(strip_query_syntax("日本語 rust"), "日本語 rust");
    }

    #[test]
    fn bare_operator_query_does_not_error() {
        let idx = FullTextIndex::in_ram().unwrap();
        idx.index_docs(&[body_doc("a.pdf", "本", 1, "rust の非同期処理")])
            .unwrap();
        assert!(idx.search("AND", 10).is_ok());
        assert!(idx.search("OR", 10).is_ok());
    }

    #[test]
    fn leading_operator_query_still_matches_terms() {
        let idx = FullTextIndex::in_ram().unwrap();
        idx.index_docs(&[body_doc("a.pdf", "本", 1, "rust の非同期処理")])
            .unwrap();
        let hits = idx.search("OR rust", 10).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].file_path, "a.pdf");
    }

    #[test]
    fn trailing_colon_query_still_matches_terms() {
        let idx = FullTextIndex::in_ram().unwrap();
        idx.index_docs(&[body_doc(
            "a.pdf",
            "本",
            1,
            "futures::executor::block_on の使い方",
        )])
        .unwrap();
        let hits = idx.search("futures::", 10).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].file_path, "a.pdf");
    }

    #[test]
    fn bare_field_prefix_query_does_not_error() {
        let idx = FullTextIndex::in_ram().unwrap();
        idx.index_docs(&[body_doc("a.pdf", "本", 1, "テキスト")])
            .unwrap();
        assert!(idx.search("title:", 10).is_ok());
    }

    #[test]
    fn unclosed_quote_query_still_matches_terms() {
        let idx = FullTextIndex::in_ram().unwrap();
        idx.index_docs(&[body_doc("a.pdf", "本", 1, "未閉じの引用符を含む本文")])
            .unwrap();
        let hits = idx.search("\"未閉じ", 10).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].file_path, "a.pdf");
    }
}
