//! EPUB package (OPF) parsing for metadata and covers.

use quick_xml::events::Event as XmlEvent;
use quick_xml::reader::Reader as XmlReader;
use serde::Serialize;
use std::fs;
use std::io::Read as _;
use std::path::Path;
use zip::ZipArchive;

/// Read all bytes of a named entry from a zip archive.
pub fn read_zip_entry(archive: &mut ZipArchive<fs::File>, name: &str) -> Result<Vec<u8>, String> {
    let mut entry = archive
        .by_name(name)
        .map_err(|e| format!("zip entry '{name}' not found: {e}"))?;
    let mut buf = Vec::new();
    entry.read_to_end(&mut buf).map_err(|e| e.to_string())?;
    Ok(buf)
}

/// Parse META-INF/container.xml and return the OPF rootfile path.
pub fn epub_opf_path(archive: &mut ZipArchive<fs::File>) -> Result<String, String> {
    let bytes = read_zip_entry(archive, "META-INF/container.xml")?;
    let xml = String::from_utf8_lossy(&bytes);
    let mut reader = XmlReader::from_str(xml.as_ref());
    reader.config_mut().trim_text(true);

    loop {
        match reader.read_event() {
            Ok(XmlEvent::Empty(ref e)) | Ok(XmlEvent::Start(ref e))
                if e.local_name().as_ref() == b"rootfile" =>
            {
                for attr in e.attributes().flatten() {
                    if attr.key.local_name().as_ref() == b"full-path" {
                        return Ok(String::from_utf8_lossy(&attr.value).into_owned());
                    }
                }
            }
            Ok(XmlEvent::Eof) | Err(_) => break,
            _ => {}
        }
    }
    Err("rootfile/@full-path not found in container.xml".to_string())
}

/// Parse an OPF manifest and return the archive-relative path of the cover
/// image. Priority: `properties="cover-image"` → `id="cover-image"` →
/// item href matching `cover.(jpg|jpeg|png|webp|gif)` → first image/* item.
pub(crate) fn epub_cover_item_path(
    archive: &mut ZipArchive<fs::File>,
    opf_path: &str,
) -> Result<String, String> {
    let opf_dir = Path::new(opf_path)
        .parent()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default();

    let bytes = read_zip_entry(archive, opf_path)?;
    let xml = String::from_utf8_lossy(&bytes);
    let mut reader = XmlReader::from_str(xml.as_ref());
    reader.config_mut().trim_text(true);

    // Candidates in priority order:
    // 0: properties="cover-image"
    // 1: id="cover-image" or id="cover"
    // 2: href matching cover.*
    // 3: first image/* item
    let mut candidates: [Option<String>; 4] = [None, None, None, None];

    loop {
        match reader.read_event() {
            Ok(XmlEvent::Empty(ref e)) | Ok(XmlEvent::Start(ref e))
                if e.local_name().as_ref() == b"item" =>
            {
                let mut href = String::new();
                let mut id = String::new();
                let mut properties = String::new();
                let mut media_type = String::new();

                for attr in e.attributes().flatten() {
                    match attr.key.local_name().as_ref() {
                        b"href" => href = String::from_utf8_lossy(&attr.value).into_owned(),
                        b"id" => id = String::from_utf8_lossy(&attr.value).into_owned(),
                        b"properties" => {
                            properties = String::from_utf8_lossy(&attr.value).into_owned()
                        }
                        b"media-type" => {
                            media_type = String::from_utf8_lossy(&attr.value).into_owned()
                        }
                        _ => {}
                    }
                }

                if href.is_empty() || !media_type.starts_with("image/") {
                    continue;
                }

                let archive_href = if opf_dir.is_empty() {
                    href.clone()
                } else {
                    format!("{opf_dir}/{href}")
                };

                if properties.split_whitespace().any(|p| p == "cover-image") {
                    candidates[0] = Some(archive_href.clone());
                }
                let id_lower = id.to_ascii_lowercase();
                if candidates[1].is_none() && (id_lower == "cover-image" || id_lower == "cover") {
                    candidates[1] = Some(archive_href.clone());
                }
                let href_lower = href.to_ascii_lowercase();
                let stem = Path::new(&href_lower)
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .unwrap_or("");
                if candidates[2].is_none() && stem == "cover" {
                    candidates[2] = Some(archive_href.clone());
                }
                if candidates[3].is_none() {
                    candidates[3] = Some(archive_href);
                }
            }
            Ok(XmlEvent::Eof) | Err(_) => break,
            _ => {}
        }
    }

    candidates
        .into_iter()
        .flatten()
        .next()
        .ok_or_else(|| "no cover image found in OPF manifest".to_string())
}

/// Extracted Dublin Core metadata from an OPF manifest.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EpubMetadataPayload {
    pub title: String,
    pub authors: Vec<String>,
    pub description: String,
    pub publisher: String,
    pub release_date: String,
    pub language: String,
}

/// Parse OPF Dublin Core metadata from an EPUB archive.
///
/// Authors are collected from `<dc:creator>` elements where the `opf:role`
/// attribute is absent or equal to `aut`. Other roles (illustrator, editor,
/// translator, …) are skipped so that the authors list reflects only the
/// book's primary authorship.
pub fn epub_extract_opf_metadata(
    archive: &mut ZipArchive<fs::File>,
    opf_path: &str,
) -> Result<EpubMetadataPayload, String> {
    let bytes = read_zip_entry(archive, opf_path)?;
    let xml = String::from_utf8_lossy(&bytes);
    let mut reader = XmlReader::from_str(xml.as_ref());
    reader.config_mut().trim_text(true);

    let mut title = String::new();
    let mut authors: Vec<String> = Vec::new();
    let mut description = String::new();
    let mut publisher = String::new();
    let mut release_date = String::new();
    let mut language = String::new();

    // State machine: track which DC element we are inside.
    #[derive(PartialEq)]
    enum State {
        None,
        Title,
        Creator { role: Option<String> },
        Description,
        Publisher,
        Date,
        Language,
    }
    let mut state = State::None;

    loop {
        match reader.read_event() {
            Ok(XmlEvent::Start(ref e)) => {
                let local = e.local_name();
                match local.as_ref() {
                    b"title" if state == State::None => state = State::Title,
                    b"creator" if state == State::None => {
                        // opf:role or role attribute decides authorship.
                        let role = e.attributes().flatten().find_map(|attr| {
                            let key = attr.key.local_name();
                            if key.as_ref() == b"role" {
                                Some(String::from_utf8_lossy(&attr.value).into_owned())
                            } else {
                                None
                            }
                        });
                        state = State::Creator { role };
                    }
                    b"description" if state == State::None => state = State::Description,
                    b"publisher" if state == State::None => state = State::Publisher,
                    b"date" if state == State::None => state = State::Date,
                    b"language" if state == State::None => state = State::Language,
                    _ => {}
                }
            }
            Ok(XmlEvent::Text(ref e)) => {
                let text = String::from_utf8_lossy(e.as_ref()).trim().to_string();
                if text.is_empty() {
                    continue;
                }
                match &state {
                    State::Title => {
                        if title.is_empty() {
                            title = text;
                        }
                    }
                    State::Creator { role } => {
                        let role_str = role.as_deref().unwrap_or("").to_ascii_lowercase();
                        if role_str.is_empty() || role_str == "aut" {
                            authors.push(text);
                        }
                    }
                    State::Description => {
                        if description.is_empty() {
                            description = text;
                        }
                    }
                    State::Publisher => {
                        if publisher.is_empty() {
                            publisher = text;
                        }
                    }
                    State::Date => {
                        if release_date.is_empty() {
                            // Normalize to YYYY-MM-DD when possible.
                            release_date = text.get(..10).unwrap_or(&text).to_string();
                        }
                    }
                    State::Language => {
                        if language.is_empty() {
                            language = text;
                        }
                    }
                    State::None => {}
                }
            }
            Ok(XmlEvent::End(_)) => {
                state = State::None;
            }
            Ok(XmlEvent::Eof) | Err(_) => break,
            _ => {}
        }
    }

    Ok(EpubMetadataPayload {
        title,
        authors,
        description,
        publisher,
        release_date,
        language,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{open_epub, opf_with_manifest, write_epub, OPF_FIXTURE};
    use std::fs;

    #[test]
    fn epub_opf_path_reads_rootfile_full_path() {
        let container = r#"<?xml version="1.0"?>
<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <link full-path="DECOY.opf"/>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>"#;
        let (dir, path) = write_epub(&[("META-INF/container.xml", container)]);
        let mut archive = open_epub(&path);
        // The decoy <link full-path> must be ignored; only <rootfile> counts.
        assert_eq!(epub_opf_path(&mut archive).unwrap(), "OEBPS/content.opf");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn epub_opf_path_errors_without_rootfile() {
        let container = r#"<?xml version="1.0"?>
<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles></rootfiles></container>"#;
        let (dir, path) = write_epub(&[("META-INF/container.xml", container)]);
        let mut archive = open_epub(&path);
        assert!(epub_opf_path(&mut archive).is_err());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn epub_extract_opf_metadata_reads_dublin_core() {
        let (dir, path) = write_epub(&[("OEBPS/content.opf", OPF_FIXTURE)]);
        let mut archive = open_epub(&path);
        let md = epub_extract_opf_metadata(&mut archive, "OEBPS/content.opf").unwrap();

        assert_eq!(md.title, "The Great Book");
        // The illustrator (opf:role="ill") is excluded; the roleless creator is kept.
        assert_eq!(
            md.authors,
            vec!["Alice Author".to_string(), "Bob Coauthor".to_string()]
        );
        assert_eq!(md.description, "A fine description.");
        assert_eq!(md.publisher, "Acme Press");
        assert_eq!(md.release_date, "2021-07-15"); // truncated from the datetime
        assert_eq!(md.language, "en");

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn epub_cover_item_path_priority_and_fallbacks() {
        // Each case isolates one selection mechanism so deleting the matching
        // branch changes the result.
        let cases: &[(&str, &str)] = &[
            // properties="cover-image" has top priority. The plain image comes
            // first so dropping the properties handling would change the result.
            (
                "<item id=\"y\" href=\"other.png\" media-type=\"image/png\"/>\
                 <item id=\"x\" href=\"c.png\" media-type=\"image/png\" properties=\"cover-image\"/>",
                "OEBPS/c.png",
            ),
            // id == "cover" when no properties.
            (
                "<item id=\"a\" href=\"first.png\" media-type=\"image/png\"/>\
                 <item id=\"cover\" href=\"c2.png\" media-type=\"image/png\"/>",
                "OEBPS/c2.png",
            ),
            // href stem "cover" when no id/properties.
            (
                "<item id=\"a\" href=\"x.png\" media-type=\"image/png\"/>\
                 <item id=\"b\" href=\"cover.jpg\" media-type=\"image/jpeg\"/>",
                "OEBPS/cover.jpg",
            ),
            // first image/* item is the fallback; non-image items are ignored.
            (
                "<item id=\"s\" href=\"s.css\" media-type=\"text/css\"/>\
                 <item id=\"a\" href=\"first.png\" media-type=\"image/png\"/>\
                 <item id=\"b\" href=\"second.png\" media-type=\"image/png\"/>",
                "OEBPS/first.png",
            ),
            // The FIRST cover-stem image wins over a later one.
            (
                "<item id=\"a\" href=\"cover.png\" media-type=\"image/png\"/>\
                 <item id=\"b\" href=\"cover.jpg\" media-type=\"image/jpeg\"/>",
                "OEBPS/cover.png",
            ),
        ];

        for (items, expected) in cases {
            let (dir, path) = write_epub(&[("OEBPS/content.opf", &opf_with_manifest(items))]);
            let mut archive = open_epub(&path);
            assert_eq!(
                epub_cover_item_path(&mut archive, "OEBPS/content.opf").unwrap(),
                *expected,
                "items: {items}"
            );
            fs::remove_dir_all(&dir).ok();
        }
    }

    #[test]
    fn epub_cover_item_path_resolves_relative_to_root_opf() {
        let items =
            "<item id=\"cover-image\" href=\"cover.png\" media-type=\"image/png\" properties=\"cover-image\"/>";
        let (dir, path) = write_epub(&[("content.opf", &opf_with_manifest(items))]);
        let mut archive = open_epub(&path);
        // OPF at the archive root: href is used as-is, with no directory prefix.
        assert_eq!(
            epub_cover_item_path(&mut archive, "content.opf").unwrap(),
            "cover.png"
        );
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn epub_cover_item_path_errors_without_image() {
        let items = "<item id=\"s\" href=\"s.css\" media-type=\"text/css\"/>";
        let (dir, path) = write_epub(&[("OEBPS/content.opf", &opf_with_manifest(items))]);
        let mut archive = open_epub(&path);
        assert!(epub_cover_item_path(&mut archive, "OEBPS/content.opf").is_err());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn epub_cover_item_path_ignores_non_item_elements() {
        // A non-<item> element carrying image-like attributes must be ignored;
        // the real first <item> image wins.
        let items = "<itemref href=\"decoy.png\" media-type=\"image/png\"/>\
                     <item id=\"a\" href=\"real.png\" media-type=\"image/png\"/>";
        let (dir, path) = write_epub(&[("OEBPS/content.opf", &opf_with_manifest(items))]);
        let mut archive = open_epub(&path);
        assert_eq!(
            epub_cover_item_path(&mut archive, "OEBPS/content.opf").unwrap(),
            "OEBPS/real.png"
        );
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn epub_metadata_ignores_nested_dc_elements() {
        // A DC element nested inside another (malformed) is seen while the
        // parser is already inside an element, so the `state == None` guards
        // must reject it instead of capturing the inner text.
        fn meta(inner: &str) -> String {
            format!(
                "<?xml version=\"1.0\"?><package xmlns=\"http://www.idpf.org/2007/opf\">\
                 <metadata xmlns:dc=\"http://purl.org/dc/elements/1.1/\">{inner}</metadata></package>"
            )
        }
        let extract = |inner: &str| {
            let (dir, path) = write_epub(&[("c.opf", &meta(inner))]);
            let mut archive = open_epub(&path);
            let md = epub_extract_opf_metadata(&mut archive, "c.opf").expect("metadata");
            fs::remove_dir_all(&dir).ok();
            md
        };

        // <title> nested in <description>: title stays empty.
        assert_eq!(
            extract("<dc:description>D<dc:title>NESTED</dc:title></dc:description>").title,
            ""
        );
        // The rest nested inside <title>: none are captured.
        assert!(
            extract("<dc:title>T<dc:creator>NESTED</dc:creator></dc:title>")
                .authors
                .is_empty()
        );
        assert_eq!(
            extract("<dc:title>T<dc:description>NESTED</dc:description></dc:title>").description,
            ""
        );
        assert_eq!(
            extract("<dc:title>T<dc:publisher>NESTED</dc:publisher></dc:title>").publisher,
            ""
        );
        assert_eq!(
            extract("<dc:title>T<dc:date>2099-09-09</dc:date></dc:title>").release_date,
            ""
        );
        assert_eq!(
            extract("<dc:title>T<dc:language>zz</dc:language></dc:title>").language,
            ""
        );
    }
}
