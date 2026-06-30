//! Native rendering support for image-sequence fixed-layout EPUBs.
//!
//! Some EPUB3 books are "pre-paginated" comics / scans whose every spine page is
//! an XHTML wrapping a single full-page image (a JPEG inside an SVG `<image>`).
//! Rendering those through epub.js means unzipping the whole archive in JS and
//! drawing nested iframes. Instead we parse the OPF here and let the frontend
//! display the images directly (served per-entry by the `riida-epub` URI scheme),
//! which is far lighter for large books.
//!
//! The pure parsers here (`parse_opf_layout`, `page_dimensions_from_xhtml`,
//! `single_image_href`, `jpeg_dimensions`) are unit-tested; `epub_image_layout`
//! and the zip-reading helpers do IO and are excluded from the mutation gate.

use crate::fulltext_extract::{join_zip_path, opf_rootfile, parent_dir, zip_bytes};
use quick_xml::events::attributes::Attribute;
use quick_xml::events::{BytesStart, Event as XmlEvent};
use quick_xml::reader::Reader as XmlReader;
use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use zip::ZipArchive;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SpreadSide {
    Left,
    Right,
    Center,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Progression {
    Ltr,
    Rtl,
}

/// Parsed OPF fields needed to lay out an image-sequence fixed-layout EPUB.
pub(crate) struct OpfLayout {
    /// manifest id -> (href, media-type)
    pub manifest: HashMap<String, (String, String)>,
    /// spine in reading order: (idref, page-spread side from itemref properties)
    pub spine: Vec<(String, Option<SpreadSide>)>,
    pub progression: Progression,
    /// True when `rendition:layout` resolves to `pre-paginated`.
    pub pre_paginated: bool,
}

// --- serialized command output --------------------------------------------

#[derive(Serialize)]
pub struct EpubImagePage {
    pub index: u32,
    /// Fully-resolved zip entry path of the page image, or `None` when the page
    /// is not a single-image page.
    pub image_entry: Option<String>,
    /// "left" | "right" | "center" | "" (empty when the itemref omits it).
    pub spread_side: String,
    pub width: u32,
    pub height: u32,
}

#[derive(Serialize)]
pub struct EpubImageLayout {
    pub is_image_epub: bool,
    /// "ltr" | "rtl"
    pub progression: String,
    pub pages: Vec<EpubImagePage>,
}

// --- pure parsers ----------------------------------------------------------

fn attr_string(attr: &Attribute) -> String {
    String::from_utf8_lossy(&attr.value).into_owned()
}

fn spread_side_from_properties(props: &str) -> Option<SpreadSide> {
    for token in props.split_whitespace() {
        match token {
            "page-spread-left" | "rendition:page-spread-left" => return Some(SpreadSide::Left),
            "page-spread-right" | "rendition:page-spread-right" => return Some(SpreadSide::Right),
            "page-spread-center" | "rendition:page-spread-center" => {
                return Some(SpreadSide::Center)
            }
            _ => {}
        }
    }
    None
}

fn spread_side_str(side: SpreadSide) -> &'static str {
    match side {
        SpreadSide::Left => "left",
        SpreadSide::Right => "right",
        SpreadSide::Center => "center",
    }
}

/// Apply one OPF tag to the accumulating layout state. Returns `true` when the
/// tag is an open `<meta property="rendition:layout">` whose value is carried as
/// the following text node (spec form).
fn apply_opf_tag(
    e: &BytesStart,
    manifest: &mut HashMap<String, (String, String)>,
    spine: &mut Vec<(String, Option<SpreadSide>)>,
    progression: &mut Progression,
    pre_paginated: &mut bool,
) -> bool {
    match e.local_name().as_ref() {
        b"item" => {
            let mut id = None;
            let mut href = None;
            let mut media = None;
            for attr in e.attributes().flatten() {
                match attr.key.as_ref() {
                    b"id" => id = Some(attr_string(&attr)),
                    b"href" => href = Some(attr_string(&attr)),
                    b"media-type" => media = Some(attr_string(&attr)),
                    _ => {}
                }
            }
            if let (Some(id), Some(href)) = (id, href) {
                manifest.insert(id, (href, media.unwrap_or_default()));
            }
            false
        }
        b"itemref" => {
            let mut idref = None;
            let mut side = None;
            for attr in e.attributes().flatten() {
                match attr.key.as_ref() {
                    b"idref" => idref = Some(attr_string(&attr)),
                    b"properties" => side = spread_side_from_properties(&attr_string(&attr)),
                    _ => {}
                }
            }
            if let Some(idref) = idref {
                spine.push((idref, side));
            }
            false
        }
        b"spine" => {
            for attr in e.attributes().flatten() {
                if attr.key.as_ref() == b"page-progression-direction" && attr_string(&attr) == "rtl"
                {
                    *progression = Progression::Rtl;
                }
            }
            false
        }
        b"meta" => {
            let mut is_layout_prop = false;
            let mut name = None;
            let mut content = None;
            for attr in e.attributes().flatten() {
                match attr.key.as_ref() {
                    b"property" => {
                        if attr_string(&attr).trim() == "rendition:layout" {
                            is_layout_prop = true;
                        }
                    }
                    b"name" => name = Some(attr_string(&attr)),
                    b"content" => content = Some(attr_string(&attr)),
                    _ => {}
                }
            }
            // Legacy attribute forms: <meta name="fixed-layout" content="true"/>
            // or <meta name="...layout" content="pre-paginated"/>.
            if let Some(name) = name {
                let n = name.to_ascii_lowercase();
                let c = content.unwrap_or_default();
                if (n == "fixed-layout" && c.eq_ignore_ascii_case("true"))
                    || (n.contains("layout") && c.trim() == "pre-paginated")
                {
                    *pre_paginated = true;
                }
            }
            is_layout_prop
        }
        _ => false,
    }
}

/// Parse an OPF capturing the manifest media-types, itemref page-spread
/// properties, page-progression-direction, and the `rendition:layout` mode.
pub(crate) fn parse_opf_layout(opf_bytes: &[u8]) -> Result<OpfLayout, String> {
    let mut reader = XmlReader::from_reader(opf_bytes);
    reader.config_mut().check_end_names = false;
    let mut buf = Vec::new();

    let mut manifest: HashMap<String, (String, String)> = HashMap::new();
    let mut spine: Vec<(String, Option<SpreadSide>)> = Vec::new();
    let mut progression = Progression::Ltr;
    let mut pre_paginated = false;
    let mut in_layout_meta = false;

    loop {
        match reader
            .read_event_into(&mut buf)
            .map_err(|e| format!("parse opf: {e}"))?
        {
            XmlEvent::Start(e) => {
                if apply_opf_tag(
                    &e,
                    &mut manifest,
                    &mut spine,
                    &mut progression,
                    &mut pre_paginated,
                ) {
                    in_layout_meta = true;
                }
            }
            XmlEvent::Empty(e) => {
                apply_opf_tag(
                    &e,
                    &mut manifest,
                    &mut spine,
                    &mut progression,
                    &mut pre_paginated,
                );
            }
            XmlEvent::Text(t) if in_layout_meta => {
                if let Ok(decoded) = t.decode() {
                    if decoded.trim() == "pre-paginated" {
                        pre_paginated = true;
                    }
                }
                in_layout_meta = false;
            }
            XmlEvent::End(_) => in_layout_meta = false,
            XmlEvent::Eof => break,
            _ => {}
        }
        buf.clear();
    }

    Ok(OpfLayout {
        manifest,
        spine,
        progression,
        pre_paginated,
    })
}

fn dimensions_from_viewbox(viewbox: &str) -> Option<(u32, u32)> {
    let parts: Vec<&str> = viewbox.split_whitespace().collect();
    if parts.len() != 4 {
        return None;
    }
    let w = parts[2].parse::<f64>().ok()?;
    let h = parts[3].parse::<f64>().ok()?;
    if w <= 0.0 || h <= 0.0 {
        return None;
    }
    Some((w.round() as u32, h.round() as u32))
}

fn dimensions_from_viewport(content: &str) -> Option<(u32, u32)> {
    let mut w = None;
    let mut h = None;
    for pair in content.split([',', ';']) {
        let pair = pair.trim();
        if pair.is_empty() {
            continue;
        }
        let mut kv = pair.splitn(2, '=');
        let key = kv.next().unwrap_or("").trim();
        let val = kv.next().map(str::trim);
        match key {
            "width" => w = val.and_then(|v| v.parse::<u32>().ok()),
            "height" => h = val.and_then(|v| v.parse::<u32>().ok()),
            _ => {}
        }
    }
    match (w, h) {
        (Some(w), Some(h)) if w > 0 && h > 0 => Some((w, h)),
        _ => None,
    }
}

/// Extract intrinsic (width, height) from a fixed-layout page XHTML. Tries the
/// SVG `viewBox` first, then a `<meta name="viewport" content="width=..,height=..">`.
pub(crate) fn page_dimensions_from_xhtml(xhtml: &[u8]) -> Option<(u32, u32)> {
    let mut reader = XmlReader::from_reader(xhtml);
    reader.config_mut().check_end_names = false;
    let mut buf = Vec::new();
    let mut viewport: Option<(u32, u32)> = None;

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(XmlEvent::Start(e)) | Ok(XmlEvent::Empty(e)) => match e.local_name().as_ref() {
                b"svg" => {
                    for attr in e.attributes().flatten() {
                        if attr.key.as_ref() == b"viewBox" {
                            if let Some(dim) = dimensions_from_viewbox(&attr_string(&attr)) {
                                return Some(dim);
                            }
                        }
                    }
                }
                b"meta" => {
                    let mut is_viewport = false;
                    let mut content = None;
                    for attr in e.attributes().flatten() {
                        match attr.key.as_ref() {
                            b"name" => {
                                if attr_string(&attr).eq_ignore_ascii_case("viewport") {
                                    is_viewport = true;
                                }
                            }
                            b"content" => content = Some(attr_string(&attr)),
                            _ => {}
                        }
                    }
                    if is_viewport {
                        if let Some(c) = content {
                            viewport = dimensions_from_viewport(&c);
                        }
                    }
                }
                _ => {}
            },
            Ok(XmlEvent::Eof) | Err(_) => break,
            _ => {}
        }
        buf.clear();
    }
    viewport
}

fn image_href_attr(e: &BytesStart) -> Option<String> {
    let mut fallback = None;
    for attr in e.attributes().flatten() {
        match attr.key.as_ref() {
            b"xlink:href" => return Some(attr_string(&attr)),
            b"href" | b"src" => fallback = Some(attr_string(&attr)),
            _ => {}
        }
    }
    fallback
}

/// Return the single image href referenced by a fixed-layout page XHTML, or
/// `None` when the page is not a single-image page (multiple images, or it
/// carries text content outside `<head>`/`<script>`/`<style>`).
pub(crate) fn single_image_href(xhtml: &[u8]) -> Option<String> {
    let mut reader = XmlReader::from_reader(xhtml);
    let config = reader.config_mut();
    config.check_end_names = false;
    config.allow_dangling_amp = true;
    let mut buf = Vec::new();

    let mut hrefs: Vec<String> = Vec::new();
    let mut text_len = 0usize;
    let mut skip_depth = 0u32;

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(XmlEvent::Start(e)) => {
                let local = e.local_name();
                match local.as_ref() {
                    b"script" | b"style" | b"head" => skip_depth += 1,
                    b"image" | b"img" => {
                        if let Some(h) = image_href_attr(&e) {
                            hrefs.push(h);
                        }
                    }
                    _ => {}
                }
            }
            Ok(XmlEvent::Empty(e)) => {
                if matches!(e.local_name().as_ref(), b"image" | b"img") {
                    if let Some(h) = image_href_attr(&e) {
                        hrefs.push(h);
                    }
                }
            }
            Ok(XmlEvent::End(e)) => {
                if matches!(e.local_name().as_ref(), b"script" | b"style" | b"head")
                    && skip_depth > 0
                {
                    skip_depth -= 1;
                }
            }
            Ok(XmlEvent::Text(t)) if skip_depth == 0 => {
                if let Ok(decoded) = t.decode() {
                    text_len += decoded.trim().chars().count();
                }
            }
            Ok(XmlEvent::Eof) | Err(_) => break,
            _ => {}
        }
        buf.clear();
    }

    if hrefs.len() == 1 && text_len == 0 {
        hrefs.into_iter().next()
    } else {
        None
    }
}

/// Read width/height from a JPEG's frame header (first SOF0..SOF15 marker,
/// excluding DHT/JPG/DAC). Pure byte scan; no image-decoding dependency.
pub(crate) fn jpeg_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    if bytes.len() < 4 || bytes[0] != 0xFF || bytes[1] != 0xD8 {
        return None;
    }
    let mut i = 2;
    while i + 3 < bytes.len() {
        if bytes[i] != 0xFF {
            i += 1;
            continue;
        }
        let marker = bytes[i + 1];
        // Padding 0xFF run: advance one byte.
        if marker == 0xFF {
            i += 1;
            continue;
        }
        // Standalone markers carry no length segment (TEM, RSTn, SOI, EOI).
        if marker == 0x01 || (0xD0..=0xD9).contains(&marker) {
            i += 2;
            continue;
        }
        let len = ((bytes[i + 2] as usize) << 8) | (bytes[i + 3] as usize);
        if len < 2 {
            return None;
        }
        let is_sof =
            (0xC0..=0xCF).contains(&marker) && marker != 0xC4 && marker != 0xC8 && marker != 0xCC;
        if is_sof {
            // Segment: FF marker len_hi len_lo precision height_hi height_lo width_hi width_lo
            if i + 8 >= bytes.len() {
                return None;
            }
            let height = ((bytes[i + 5] as u32) << 8) | (bytes[i + 6] as u32);
            let width = ((bytes[i + 7] as u32) << 8) | (bytes[i + 8] as u32);
            if width == 0 || height == 0 {
                return None;
            }
            return Some((width, height));
        }
        i += 2 + len;
    }
    None
}

// --- IO: command + zip serving (mutation-gate excluded) --------------------

/// Determine the layout of an EPUB and, when it is an image-sequence
/// fixed-layout book, the per-page resolved image entries and dimensions.
#[tauri::command]
pub fn epub_image_layout(file_path: String) -> Result<EpubImageLayout, String> {
    let file = fs::File::open(&file_path).map_err(|e| format!("open epub {file_path}: {e}"))?;
    let mut archive = ZipArchive::new(file).map_err(|e| format!("read epub zip: {e}"))?;
    let opf_path = opf_rootfile(&mut archive)?;
    let opf_bytes = zip_bytes(&mut archive, &opf_path)?;
    let layout = parse_opf_layout(&opf_bytes)?;

    // Reflowable books are never image-sequence; skip the per-page scan so
    // detection stays cheap on large novels (no zip read per spine section).
    if !layout.pre_paginated {
        return Ok(EpubImageLayout {
            is_image_epub: false,
            progression: match layout.progression {
                Progression::Ltr => "ltr",
                Progression::Rtl => "rtl",
            }
            .to_owned(),
            pages: Vec::new(),
        });
    }

    let base = parent_dir(&opf_path);

    let mut pages: Vec<EpubImagePage> = Vec::with_capacity(layout.spine.len());
    let mut image_pages = 0usize;

    for (index, (idref, side)) in layout.spine.iter().enumerate() {
        let Some((href, _media)) = layout.manifest.get(idref) else {
            continue;
        };
        let page_path = join_zip_path(&base, href);

        let (image_entry, width, height) = match zip_bytes(&mut archive, &page_path) {
            Ok(xhtml) => match single_image_href(&xhtml) {
                Some(img_href) => {
                    let entry = join_zip_path(&parent_dir(&page_path), &img_href);
                    let (w, h) = page_dimensions_from_xhtml(&xhtml)
                        .or_else(|| {
                            zip_bytes(&mut archive, &entry)
                                .ok()
                                .and_then(|b| jpeg_dimensions(&b))
                        })
                        .unwrap_or((0, 0));
                    image_pages += 1;
                    (Some(entry), w, h)
                }
                None => (None, 0, 0),
            },
            Err(_) => (None, 0, 0),
        };

        pages.push(EpubImagePage {
            index: index as u32,
            image_entry,
            spread_side: side
                .as_ref()
                .map(|s| spread_side_str(*s))
                .unwrap_or("")
                .to_owned(),
            width,
            height,
        });
    }

    let ratio = if pages.is_empty() {
        0.0
    } else {
        image_pages as f64 / pages.len() as f64
    };
    let is_image_epub = layout.pre_paginated && ratio >= 0.9;

    Ok(EpubImageLayout {
        is_image_epub,
        progression: match layout.progression {
            Progression::Ltr => "ltr",
            Progression::Rtl => "rtl",
        }
        .to_owned(),
        pages,
    })
}

/// Read a single entry's bytes from an EPUB zip. Used by the `riida-epub` URI
/// scheme to serve page images without unzipping the whole archive.
pub(crate) fn read_zip_entry(file_path: &str, entry: &str) -> Result<Vec<u8>, String> {
    let file = fs::File::open(file_path).map_err(|e| format!("open epub {file_path}: {e}"))?;
    let mut archive = ZipArchive::new(file).map_err(|e| format!("read epub zip: {e}"))?;
    zip_bytes(&mut archive, entry)
}

/// Decode a percent-encoded URL component (as produced by JS
/// `encodeURIComponent`) back into a UTF-8 string. Used to recover the file
/// path and zip entry from a `riida-epub` request query.
pub(crate) fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hi = (bytes[i + 1] as char).to_digit(16);
            let lo = (bytes[i + 2] as char).to_digit(16);
            if let (Some(hi), Some(lo)) = (hi, lo) {
                out.push((hi * 16 + lo) as u8);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// MIME type for a zip image entry, by extension.
pub(crate) fn content_type_for(entry: &str) -> &'static str {
    match entry
        .rsplit('.')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const OPF: &[u8] = br#"<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
<metadata>
<meta property="rendition:layout">pre-paginated</meta>
<meta property="rendition:spread">landscape</meta>
</metadata>
<manifest>
<item id="cover-img" href="image/cover.jpg" media-type="image/jpeg"/>
<item id="p-cover" href="xhtml/p-cover.xhtml" media-type="application/xhtml+xml"/>
<item id="page0" href="xhtml/p0000.xhtml" media-type="application/xhtml+xml"/>
<item id="page1" href="xhtml/p0001.xhtml" media-type="application/xhtml+xml"/>
</manifest>
<spine page-progression-direction="ltr">
<itemref idref="p-cover" properties="rendition:page-spread-center"/>
<itemref idref="page0" properties="page-spread-right"/>
<itemref idref="page1" properties="page-spread-left"/>
</spine>
</package>"#;

    #[test]
    fn parse_opf_layout_reads_spine_manifest_and_layout() {
        let layout = parse_opf_layout(OPF).unwrap();
        assert!(layout.pre_paginated);
        assert_eq!(layout.progression, Progression::Ltr);
        assert_eq!(layout.spine.len(), 3);
        assert_eq!(layout.spine[0].1, Some(SpreadSide::Center));
        assert_eq!(layout.spine[1].1, Some(SpreadSide::Right));
        assert_eq!(layout.spine[2].1, Some(SpreadSide::Left));
        assert_eq!(
            layout.manifest.get("page0"),
            Some(&(
                "xhtml/p0000.xhtml".to_owned(),
                "application/xhtml+xml".to_owned()
            ))
        );
    }

    #[test]
    fn parse_opf_layout_detects_rtl() {
        let opf = br#"<package><spine page-progression-direction="rtl"></spine></package>"#;
        let layout = parse_opf_layout(opf).unwrap();
        assert_eq!(layout.progression, Progression::Rtl);
    }

    #[test]
    fn parse_opf_layout_legacy_fixed_layout_meta() {
        let opf = br#"<package><metadata>
<meta name="fixed-layout" content="true"/>
</metadata><spine></spine></package>"#;
        let layout = parse_opf_layout(opf).unwrap();
        assert!(layout.pre_paginated);
    }

    #[test]
    fn parse_opf_layout_reflowable_is_not_pre_paginated() {
        let opf = br#"<package><spine page-progression-direction="ltr"></spine></package>"#;
        let layout = parse_opf_layout(opf).unwrap();
        assert!(!layout.pre_paginated);
    }

    #[test]
    fn page_dimensions_from_viewbox() {
        let xhtml = br#"<html><body>
<svg viewBox="0 0 1396 1980"><image xlink:href="../image/img0000.jpg"/></svg>
</body></html>"#;
        assert_eq!(page_dimensions_from_xhtml(xhtml), Some((1396, 1980)));
    }

    #[test]
    fn page_dimensions_falls_back_to_viewport_meta() {
        let xhtml = br#"<html><head>
<meta name="viewport" content="width=1200, height=1600"/>
</head><body><p>text</p></body></html>"#;
        assert_eq!(page_dimensions_from_xhtml(xhtml), Some((1200, 1600)));
    }

    #[test]
    fn page_dimensions_none_when_absent() {
        let xhtml = br#"<html><body><p>no dimensions</p></body></html>"#;
        assert_eq!(page_dimensions_from_xhtml(xhtml), None);
    }

    #[test]
    fn single_image_href_for_image_page() {
        let xhtml = br#"<html><head><title>title</title></head><body>
<div class="main"><svg viewBox="0 0 1396 1980">
<image width="1396" height="1980" xlink:href="../image/img0000.jpg"/></svg></div>
</body></html>"#;
        assert_eq!(
            single_image_href(xhtml).as_deref(),
            Some("../image/img0000.jpg")
        );
    }

    #[test]
    fn single_image_href_none_for_text_page() {
        let xhtml = br#"<html><head><title>t</title></head><body>
<p>This page has prose text and no image.</p></body></html>"#;
        assert_eq!(single_image_href(xhtml), None);
    }

    #[test]
    fn single_image_href_none_for_multi_image_page() {
        let xhtml = br#"<html><body>
<img src="a.jpg"/><img src="b.jpg"/></body></html>"#;
        assert_eq!(single_image_href(xhtml), None);
    }

    #[test]
    fn jpeg_dimensions_from_sof0() {
        // FFD8 SOI, then APP0-ish padding skipped, then SOF0 with 1396x1980.
        let mut bytes: Vec<u8> = vec![0xFF, 0xD8];
        // A non-SOF segment with length to ensure skipping works (FFE0 len=4).
        bytes.extend_from_slice(&[0xFF, 0xE0, 0x00, 0x04, 0x00, 0x00]);
        // SOF0: FFC0 len=17 precision=8 height=1980 width=1396 ...
        bytes.extend_from_slice(&[0xFF, 0xC0, 0x00, 0x11, 0x08]);
        bytes.extend_from_slice(&1980u16.to_be_bytes());
        bytes.extend_from_slice(&1396u16.to_be_bytes());
        bytes.extend_from_slice(&[0x03, 0x01, 0x22, 0x00]); // component data (partial ok)
        assert_eq!(jpeg_dimensions(&bytes), Some((1396, 1980)));
    }

    #[test]
    fn jpeg_dimensions_rejects_non_jpeg() {
        assert_eq!(jpeg_dimensions(&[0x89, 0x50, 0x4E, 0x47]), None);
        assert_eq!(jpeg_dimensions(&[0xFF, 0xD8]), None);
    }

    #[test]
    fn percent_decode_handles_utf8_and_specials() {
        assert_eq!(
            percent_decode("%2FUsers%2Fa%2FC%26R%E7%A0%94%E7%A9%B6%E6%89%80"),
            "/Users/a/C&R研究所"
        );
        assert_eq!(percent_decode("plain%20path"), "plain path");
        // A stray percent that is not a valid escape is passed through.
        assert_eq!(percent_decode("100%"), "100%");
    }

    #[test]
    fn content_type_by_extension() {
        assert_eq!(content_type_for("item/image/img.jpg"), "image/jpeg");
        assert_eq!(content_type_for("a.JPEG"), "image/jpeg");
        assert_eq!(content_type_for("a.png"), "image/png");
        assert_eq!(content_type_for("a.bin"), "application/octet-stream");
    }

    /// Env-gated smoke test against a real image EPUB. Set RIIDA_IMAGE_EPUB to a
    /// fixed-layout image book to run it.
    #[test]
    fn image_epub_layout_detects_real_file() {
        let Ok(path) = std::env::var("RIIDA_IMAGE_EPUB") else {
            return;
        };
        let layout = epub_image_layout(path).unwrap();
        assert!(layout.is_image_epub);
        assert!(layout.pages.len() > 10);
        assert!(
            layout
                .pages
                .iter()
                .filter(|p| p.image_entry.is_some())
                .count()
                > 10
        );
    }
}
