//! Text extraction for the full-text index.
//!
//! Produces [`ContentDoc`]s from the three content sources:
//!   - PDF body  → one doc per page (pdfium-render, runtime dynamic binding)
//!   - EPUB body → one doc per spine section (zip + quick-xml)
//!   - metadata / note → assembled from SQLite values (pure builders)
//!
//! The pdfium/zip entry points do IO and are excluded from the mutation gate;
//! the parsing/assembly helpers around them are pure and unit-tested.

use crate::fulltext::{normalize_extracted_text, ContentDoc, ContentKind};
use pdfium_render::prelude::*;
use quick_xml::events::Event as XmlEvent;
use quick_xml::reader::Reader as XmlReader;
use std::collections::HashMap;
use std::fs;
use zip::ZipArchive;

// --- pdfium ----------------------------------------------------------------

/// Bind to libpdfium for runtime use. Prefers `PDFIUM_LIB_DIR` (set by the Nix
/// dev shell / by the bundled resource dir in release), then falls back to a
/// system-installed library.
pub fn bind_pdfium() -> Result<Pdfium, String> {
    if let Ok(dir) = std::env::var("PDFIUM_LIB_DIR") {
        let lib = Pdfium::pdfium_platform_library_name_at_path(&dir);
        match Pdfium::bind_to_library(&lib) {
            Ok(bindings) => return Ok(Pdfium::new(bindings)),
            Err(e) => return Err(format!("bind pdfium at {dir}: {e}")),
        }
    }
    Pdfium::bind_to_system_library()
        .map(Pdfium::new)
        .map_err(|e| format!("bind system pdfium: {e}"))
}

/// Extract one body document per non-empty PDF page.
pub fn extract_pdf_body(
    pdfium: &Pdfium,
    file_path: &str,
    title: &str,
    password: Option<&str>,
) -> Result<Vec<ContentDoc>, String> {
    let document = pdfium
        .load_pdf_from_file(file_path, password)
        .map_err(|e| format!("open pdf {file_path}: {e}"))?;

    let mut docs = Vec::new();
    for (idx, page) in document.pages().iter().enumerate() {
        let raw = page.text().map(|t| t.all()).unwrap_or_default();
        let text = normalize_extracted_text(strip_leading_watermark(&raw));
        if text.is_empty() {
            continue;
        }
        docs.push(ContentDoc {
            file_path: file_path.to_owned(),
            kind: ContentKind::Body,
            title: title.to_owned(),
            authors: String::new(),
            tags: String::new(),
            text,
            loc_page: Some((idx as u64) + 1),
            loc_anchor: None,
        });
    }
    Ok(docs)
}

/// Some stores (e.g. ラムダノート) stamp a per-purchaser watermark hash as the
/// first text line of every page. Drop a leading line that is a long hex string
/// (optionally prefixed by `#`) so it does not pollute the index.
pub fn strip_leading_watermark(text: &str) -> &str {
    let trimmed = text.trim_start();
    let Some(first_end) = trimmed.find('\n') else {
        return if is_watermark_line(trimmed) { "" } else { text };
    };
    let (first, rest) = trimmed.split_at(first_end);
    if is_watermark_line(first) {
        rest.trim_start_matches('\n')
    } else {
        text
    }
}

fn is_watermark_line(line: &str) -> bool {
    let candidate = line.trim().trim_start_matches('#').trim();
    candidate.len() >= 32 && candidate.chars().all(|c| c.is_ascii_hexdigit())
}

// --- EPUB ------------------------------------------------------------------

/// Extract one body document per EPUB spine section, in reading order.
pub fn extract_epub_body(file_path: &str, title: &str) -> Result<Vec<ContentDoc>, String> {
    let file = fs::File::open(file_path).map_err(|e| format!("open epub {file_path}: {e}"))?;
    let mut archive = ZipArchive::new(file).map_err(|e| format!("read epub zip: {e}"))?;

    let opf_path = opf_rootfile(&mut archive)?;
    let opf_bytes = zip_bytes(&mut archive, &opf_path)?;
    let (manifest, spine) = parse_opf_spine(&opf_bytes)?;
    let base = parent_dir(&opf_path);

    let mut docs = Vec::new();
    for idref in spine {
        let Some(href) = manifest.get(&idref) else {
            continue;
        };
        let entry = join_zip_path(&base, href);
        let Ok(bytes) = zip_bytes(&mut archive, &entry) else {
            continue;
        };
        let text = normalize_extracted_text(&html_to_text(&bytes));
        if text.is_empty() {
            continue;
        }
        docs.push(ContentDoc {
            file_path: file_path.to_owned(),
            kind: ContentKind::Body,
            title: title.to_owned(),
            authors: String::new(),
            tags: String::new(),
            text,
            loc_page: None,
            loc_anchor: Some(href.clone()),
        });
    }
    Ok(docs)
}

fn zip_bytes(archive: &mut ZipArchive<fs::File>, name: &str) -> Result<Vec<u8>, String> {
    use std::io::Read;
    let mut entry = archive
        .by_name(name)
        .map_err(|e| format!("zip entry {name}: {e}"))?;
    let mut buf = Vec::new();
    entry
        .read_to_end(&mut buf)
        .map_err(|e| format!("read zip entry {name}: {e}"))?;
    Ok(buf)
}

/// Read META-INF/container.xml and return the OPF rootfile path.
fn opf_rootfile(archive: &mut ZipArchive<fs::File>) -> Result<String, String> {
    let bytes = zip_bytes(archive, "META-INF/container.xml")?;
    let mut reader = XmlReader::from_reader(bytes.as_slice());
    let mut buf = Vec::new();
    loop {
        match reader.read_event_into(&mut buf) {
            Ok(XmlEvent::Empty(e)) | Ok(XmlEvent::Start(e))
                if e.local_name().as_ref() == b"rootfile" =>
            {
                for attr in e.attributes().flatten() {
                    if attr.key.as_ref() == b"full-path" {
                        return Ok(String::from_utf8_lossy(&attr.value).into_owned());
                    }
                }
            }
            Ok(XmlEvent::Eof) => break,
            Err(e) => return Err(format!("parse container.xml: {e}")),
            _ => {}
        }
        buf.clear();
    }
    Err("rootfile/@full-path not found in container.xml".to_owned())
}

/// Parse an OPF: returns (manifest id→href, spine idref order).
fn parse_opf_spine(opf_bytes: &[u8]) -> Result<(HashMap<String, String>, Vec<String>), String> {
    let mut reader = XmlReader::from_reader(opf_bytes);
    let mut buf = Vec::new();
    let mut manifest = HashMap::new();
    let mut spine = Vec::new();

    loop {
        let event = reader
            .read_event_into(&mut buf)
            .map_err(|e| format!("parse opf: {e}"))?;
        match event {
            XmlEvent::Empty(e) | XmlEvent::Start(e) => match e.local_name().as_ref() {
                b"item" => {
                    let mut id = None;
                    let mut href = None;
                    for attr in e.attributes().flatten() {
                        match attr.key.as_ref() {
                            b"id" => id = Some(String::from_utf8_lossy(&attr.value).into_owned()),
                            b"href" => {
                                href = Some(String::from_utf8_lossy(&attr.value).into_owned())
                            }
                            _ => {}
                        }
                    }
                    if let (Some(id), Some(href)) = (id, href) {
                        manifest.insert(id, href);
                    }
                }
                b"itemref" => {
                    for attr in e.attributes().flatten() {
                        if attr.key.as_ref() == b"idref" {
                            spine.push(String::from_utf8_lossy(&attr.value).into_owned());
                        }
                    }
                }
                _ => {}
            },
            XmlEvent::Eof => break,
            _ => {}
        }
        buf.clear();
    }
    Ok((manifest, spine))
}

/// Strip XHTML markup to plain text, skipping script/style content. Entities are
/// decoded; element boundaries become spaces (later collapsed by normalization).
fn html_to_text(bytes: &[u8]) -> String {
    let mut reader = XmlReader::from_reader(bytes);
    let config = reader.config_mut();
    config.check_end_names = false;
    config.allow_dangling_amp = true;

    let mut buf = Vec::new();
    let mut out = String::new();
    let mut skip_depth = 0u32;

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(XmlEvent::Start(e)) => {
                if is_skipped_element(e.local_name().as_ref()) {
                    skip_depth += 1;
                }
            }
            Ok(XmlEvent::End(e)) => {
                if is_skipped_element(e.local_name().as_ref()) && skip_depth > 0 {
                    skip_depth -= 1;
                }
                out.push(' ');
            }
            Ok(XmlEvent::Text(t)) if skip_depth == 0 => {
                // Entity references are emitted as separate GeneralRef events, so
                // Text holds literal text only; decoding the charset is enough.
                if let Ok(decoded) = t.decode() {
                    out.push_str(&decoded);
                }
            }
            Ok(XmlEvent::GeneralRef(e)) if skip_depth == 0 => {
                if let Ok(Some(c)) = e.resolve_char_ref() {
                    out.push(c);
                } else if let Ok(name) = e.decode() {
                    out.push_str(match name.as_ref() {
                        "amp" => "&",
                        "lt" => "<",
                        "gt" => ">",
                        "quot" => "\"",
                        "apos" => "'",
                        "nbsp" => " ",
                        _ => "",
                    });
                }
            }
            Ok(XmlEvent::Eof) => break,
            Err(_) => break,
            _ => {}
        }
        buf.clear();
    }
    out
}

fn is_skipped_element(name: &[u8]) -> bool {
    matches!(name, b"script" | b"style" | b"head")
}

/// Directory portion of an archive path (`"OEBPS/content.opf"` → `"OEBPS"`).
fn parent_dir(path: &str) -> String {
    match path.rfind('/') {
        Some(idx) => path[..idx].to_owned(),
        None => String::new(),
    }
}

/// Join an OPF-relative href onto the OPF's base dir, resolving `.`/`..` and
/// dropping any fragment. Always produces a forward-slash zip path.
fn join_zip_path(base: &str, href: &str) -> String {
    let href = href.split('#').next().unwrap_or(href);
    let mut segments: Vec<&str> = Vec::new();
    if !base.is_empty() {
        segments.extend(base.split('/').filter(|s| !s.is_empty()));
    }
    for seg in href.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                segments.pop();
            }
            other => segments.push(other),
        }
    }
    segments.join("/")
}

// --- metadata / note doc builders (pure) -----------------------------------

/// Assemble the per-book metadata document. Concatenates the bibliographic
/// fields and tags into one searchable text blob, while keeping title/authors/
/// tags also in their own boosted fields.
#[allow(clippy::too_many_arguments)]
pub fn build_metadata_doc(
    file_path: &str,
    title: &str,
    authors: &[String],
    publisher: &str,
    description: &str,
    release_date: &str,
    language: &str,
    asin: &str,
    url: &str,
    tags: &[String],
) -> ContentDoc {
    let authors_joined = authors.join(" ");
    let tags_joined = tags.join(" ");
    let mut parts: Vec<&str> = vec![title, &authors_joined, publisher, description];
    parts.extend([release_date, language, asin, url, &tags_joined]);
    let text = parts
        .iter()
        .filter(|p| !p.trim().is_empty())
        .copied()
        .collect::<Vec<_>>()
        .join(" ");
    ContentDoc {
        file_path: file_path.to_owned(),
        kind: ContentKind::Metadata,
        title: title.to_owned(),
        authors: authors_joined,
        tags: tags_joined,
        text,
        loc_page: None,
        loc_anchor: None,
    }
}

/// Assemble the per-book note document.
pub fn build_note_doc(file_path: &str, title: &str, content: &str) -> ContentDoc {
    ContentDoc {
        file_path: file_path.to_owned(),
        kind: ContentKind::Note,
        title: title.to_owned(),
        authors: String::new(),
        tags: String::new(),
        text: normalize_extracted_text(content),
        loc_page: None,
        loc_anchor: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_hex_watermark_first_line() {
        let input = "# fd54a58c7f4206e500f9bed4257b4f8e358a26d6\n本文のテキスト";
        assert_eq!(strip_leading_watermark(input), "本文のテキスト");
    }

    #[test]
    fn keeps_normal_first_line() {
        let input = "第一章 はじめに\n本文のテキスト";
        assert_eq!(strip_leading_watermark(input), input);
    }

    #[test]
    fn watermark_without_body_becomes_empty() {
        assert_eq!(
            strip_leading_watermark("fd54a58c7f4206e500f9bed4257b4f8e358a26d6"),
            ""
        );
    }

    #[test]
    fn short_hex_is_not_treated_as_watermark() {
        let input = "abc123\n本文";
        assert_eq!(strip_leading_watermark(input), input);
    }

    #[test]
    fn html_to_text_strips_tags_and_decodes_entities() {
        let html = b"<html><body><h1>\xe7\xab\xa0</h1><p>AT&amp;T &#x3068; \xe6\x97\xa5\xe6\x9c\xac</p></body></html>";
        let text = html_to_text(html);
        assert!(text.contains("章"), "got: {text}");
        assert!(text.contains("AT&T"), "got: {text}");
        assert!(text.contains("日本"), "got: {text}");
    }

    #[test]
    fn html_to_text_skips_script_and_style() {
        let html = b"<html><head><style>.x{color:red}</style></head><body>\xe6\x9c\xac\xe6\x96\x87<script>var x=1;</script></body></html>";
        let text = html_to_text(html);
        assert!(text.contains("本文"));
        assert!(!text.contains("color"));
        assert!(!text.contains("var x"));
    }

    #[test]
    fn join_zip_path_resolves_relative_segments() {
        assert_eq!(join_zip_path("OEBPS", "text/ch1.xhtml"), "OEBPS/text/ch1.xhtml");
        assert_eq!(join_zip_path("OEBPS/text", "../images/c.png"), "OEBPS/images/c.png");
        assert_eq!(join_zip_path("OEBPS", "ch1.xhtml#frag"), "OEBPS/ch1.xhtml");
        assert_eq!(join_zip_path("", "ch1.xhtml"), "ch1.xhtml");
    }

    #[test]
    fn parse_opf_spine_reads_manifest_and_order() {
        let opf = br#"<?xml version="1.0"?>
        <package xmlns="http://www.idpf.org/2007/opf">
          <manifest>
            <item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
            <item id="c2" href="ch2.xhtml" media-type="application/xhtml+xml"/>
            <item id="css" href="style.css" media-type="text/css"/>
          </manifest>
          <spine>
            <itemref idref="c1"/>
            <itemref idref="c2"/>
          </spine>
        </package>"#;
        let (manifest, spine) = parse_opf_spine(opf).unwrap();
        assert_eq!(manifest.get("c1").map(String::as_str), Some("ch1.xhtml"));
        assert_eq!(spine, vec!["c1".to_owned(), "c2".to_owned()]);
    }

    #[test]
    fn build_metadata_doc_joins_nonempty_fields() {
        let doc = build_metadata_doc(
            "a.pdf",
            "型システム入門",
            &["著者A".into(), "著者B".into()],
            "出版社",
            "",
            "2020-01-01",
            "ja",
            "",
            "",
            &["プログラミング".into()],
        );
        assert_eq!(doc.kind, ContentKind::Metadata);
        assert_eq!(doc.authors, "著者A 著者B");
        assert_eq!(doc.tags, "プログラミング");
        assert!(doc.text.contains("型システム入門"));
        assert!(doc.text.contains("出版社"));
        assert!(doc.text.contains("プログラミング"));
        // Empty fields (description, asin, url) must not leave double spaces.
        assert!(!doc.text.contains("  "), "no doubled spaces: {:?}", doc.text);
    }

    #[test]
    fn build_note_doc_normalizes_text() {
        let doc = build_note_doc("a.pdf", "本", "メモ\n\n本文");
        assert_eq!(doc.kind, ContentKind::Note);
        assert_eq!(doc.text, "メモ本文");
    }

    fn cjk_chars(s: &str) -> usize {
        s.chars()
            .filter(|c| {
                matches!(*c as u32,
                    0x3040..=0x309F | 0x30A0..=0x30FF | 0x4E00..=0x9FFF | 0x3400..=0x4DBF)
            })
            .count()
    }

    // Real-file validation of the extraction wrappers. Env-gated so normal CI
    // skips it (passes). Set RIIDA_EXTRACT_PDF (+ PDFIUM_LIB_DIR) / RIIDA_EXTRACT_EPUB.
    #[test]
    fn extract_pdf_body_yields_cjk_pages() {
        let Ok(path) = std::env::var("RIIDA_EXTRACT_PDF") else {
            eprintln!("skipping: set RIIDA_EXTRACT_PDF + PDFIUM_LIB_DIR to run");
            return;
        };
        let pdfium = bind_pdfium().expect("bind pdfium");
        let docs = extract_pdf_body(&pdfium, &path, "title", None).expect("extract pdf");
        assert!(!docs.is_empty(), "no body pages extracted");
        assert!(docs.iter().all(|d| d.kind == ContentKind::Body));
        assert!(docs.iter().all(|d| d.loc_page.is_some()));
        let total_cjk: usize = docs.iter().map(|d| cjk_chars(&d.text)).sum();
        eprintln!("pdf: {} pages, {} CJK chars", docs.len(), total_cjk);
        assert!(total_cjk > 0, "no CJK extracted");
        // Normalization must have removed inter-glyph spaces: no doc should have
        // a space directly between two kana/kanji.
        for d in &docs {
            let chars: Vec<char> = d.text.chars().collect();
            for w in chars.windows(3) {
                if w[1] == ' ' {
                    assert!(
                        !(cjk_chars(&w[0].to_string()) == 1 && cjk_chars(&w[2].to_string()) == 1),
                        "space between CJK glyphs survived: {:?}",
                        w
                    );
                }
            }
        }
    }

    #[test]
    fn extract_epub_body_yields_cjk_sections() {
        let Ok(path) = std::env::var("RIIDA_EXTRACT_EPUB") else {
            eprintln!("skipping: set RIIDA_EXTRACT_EPUB to run");
            return;
        };
        let docs = extract_epub_body(&path, "title").expect("extract epub");
        assert!(!docs.is_empty(), "no sections extracted");
        assert!(docs.iter().all(|d| d.kind == ContentKind::Body));
        assert!(docs.iter().all(|d| d.loc_anchor.is_some()));
        let total_cjk: usize = docs.iter().map(|d| cjk_chars(&d.text)).sum();
        eprintln!("epub: {} sections, {} CJK chars", docs.len(), total_cjk);
        assert!(total_cjk > 0, "no CJK extracted");
    }
}
