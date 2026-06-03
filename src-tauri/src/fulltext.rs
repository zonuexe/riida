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

/// Writer heap budget. tantivy requires at least a few MB; 50 MB is comfortable
/// for batched book indexing without excessive memory.
const WRITER_HEAP_BYTES: usize = 50_000_000;

/// Kind of content a document represents.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
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

/// A single content-unit document to index.
#[derive(Debug, Clone)]
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
        let index =
            Index::open_or_create(mmap, schema).map_err(|e| format!("open_or_create index: {e}"))?;
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

    fn writer(&self) -> Result<IndexWriter, String> {
        self.index
            .writer(WRITER_HEAP_BYTES)
            .map_err(|e| format!("index writer: {e}"))
    }

    /// Replace-and-insert a batch of documents. Every `(file_path, kind)` pair
    /// present in the batch is deleted first, so re-indexing a book's body (all
    /// pages in one batch) cleanly supersedes the previous version.
    pub fn index_docs(&self, docs: &[ContentDoc]) -> Result<(), String> {
        if docs.is_empty() {
            return Ok(());
        }
        let _guard = self.lock_writes();
        let mut writer = self.writer()?;

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

        writer.commit().map_err(|e| format!("commit: {e}"))?;
        self.reader.reload().map_err(|e| format!("reload: {e}"))?;
        Ok(())
    }

    /// Delete every document for a book (all kinds) — used when a file is
    /// removed from the library.
    pub fn delete_book(&self, file_path: &str) -> Result<(), String> {
        let _guard = self.lock_writes();
        let mut writer = self.writer()?;
        writer.delete_term(Term::from_field_text(self.fields.file_path, file_path));
        writer.commit().map_err(|e| format!("commit: {e}"))?;
        self.reader.reload().map_err(|e| format!("reload: {e}"))?;
        Ok(())
    }

    /// Delete only the documents of one kind for a book.
    pub fn delete_kind(&self, file_path: &str, kind: ContentKind) -> Result<(), String> {
        let key = format!("{}\u{0}{}", file_path, kind.as_str());
        let _guard = self.lock_writes();
        let mut writer = self.writer()?;
        writer.delete_term(Term::from_field_text(self.fields.doc_key, &key));
        writer.commit().map_err(|e| format!("commit: {e}"))?;
        self.reader.reload().map_err(|e| format!("reload: {e}"))?;
        Ok(())
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

        let query = parser
            .parse_query(trimmed)
            .map_err(|e| format!("parse query: {e}"))?;

        let mut snippet_gen = SnippetGenerator::create(&searcher, &query, self.fields.text)
            .map_err(|e| format!("snippet generator: {e}"))?;
        snippet_gen.set_max_num_chars(160);

        let top = searcher
            .search(&query, &TopDocs::with_limit(limit))
            .map_err(|e| format!("search: {e}"))?;

        let mut hits = Vec::with_capacity(top.len());
        for (score, addr) in top {
            let tdoc: TantivyDocument = searcher
                .doc(addr)
                .map_err(|e| format!("retrieve doc: {e}"))?;
            let snippet = snippet_gen.snippet_from_doc(&tdoc).to_html();
            hits.push(FullTextHit {
                file_path: stored_text(&tdoc, self.fields.file_path),
                title: stored_text(&tdoc, self.fields.title),
                kind: stored_text(&tdoc, self.fields.kind),
                page: tdoc.get_first(self.fields.loc_page).and_then(|v| v.as_u64()),
                anchor: tdoc
                    .get_first(self.fields.loc_anchor)
                    .and_then(|v| v.as_str())
                    .map(str::to_owned),
                score,
                snippet_html: snippet,
            });
        }
        Ok(hits)
    }
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
        assert_eq!(
            normalize_extracted_text("内部\n\u{3000}文字"),
            "内部文字"
        );
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
            body_doc("a.pdf", "形態素の本", 12, "全文検索エンジンと形態素解析の解説"),
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
    fn empty_query_returns_no_hits() {
        let idx = FullTextIndex::in_ram().unwrap();
        idx.index_docs(&[body_doc("a.pdf", "本", 1, "テキスト")])
            .unwrap();
        assert!(idx.search("   ", 10).unwrap().is_empty());
    }
}
