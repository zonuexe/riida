//! Phase 0 spike: prove pdfium-render can extract readable CJK text from real
//! Japanese PDFs (both horizontal technical books and vertical/tategaki books),
//! using a dynamically-loaded libpdfium (no build-time linking).
//!
//! Driven by env vars so no store paths or private file paths are hard-coded:
//!   PDFIUM_DYLIB_PATH = full path to libpdfium.dylib/.so/.dll
//!   PDFIUM_SAMPLE_PDF = path to a Japanese PDF to extract
//!
//! Skips (passes) when the env vars are absent so it never breaks CI.
//! Throwaway validation; delete once the real extraction module lands.

use pdfium_render::prelude::*;

#[test]
fn pdfium_extracts_japanese_text() {
    let (Ok(dylib), Ok(sample)) = (
        std::env::var("PDFIUM_DYLIB_PATH"),
        std::env::var("PDFIUM_SAMPLE_PDF"),
    ) else {
        eprintln!("skipping: set PDFIUM_DYLIB_PATH and PDFIUM_SAMPLE_PDF to run");
        return;
    };

    let bindings = Pdfium::bind_to_library(&dylib).unwrap_or_else(|e| panic!("bind {dylib}: {e}"));
    let pdfium = Pdfium::new(bindings);

    let document = pdfium
        .load_pdf_from_file(&sample, None)
        .unwrap_or_else(|e| panic!("open {sample}: {e}"));

    let page_count = document.pages().len();
    eprintln!("=== {sample} ===");
    eprintln!("pages: {page_count}");

    let mut total_chars = 0usize;
    let mut cjk_chars = 0usize;
    let mut sampled_pages = 0usize;

    for (idx, page) in document.pages().iter().enumerate() {
        let text = page.text().map(|t| t.all()).unwrap_or_default();
        let trimmed = text.trim();
        if trimmed.is_empty() {
            continue;
        }
        total_chars += trimmed.chars().count();
        cjk_chars += trimmed.chars().filter(|c| is_cjk(*c)).count();

        // Print a short readable preview from the first few non-empty pages.
        if sampled_pages < 3 {
            let preview: String = trimmed.chars().take(60).collect();
            eprintln!("  page {} preview: {}", idx + 1, preview.replace('\n', " "));
            sampled_pages += 1;
        }
    }

    eprintln!("total extracted chars: {total_chars}, CJK chars: {cjk_chars}");

    assert!(total_chars > 0, "no text extracted at all from {sample}");
    assert!(
        cjk_chars > 0,
        "no CJK characters extracted from {sample} (extraction likely garbled)"
    );
    // For a Japanese book a meaningful fraction of glyphs should be CJK.
    let ratio = cjk_chars as f64 / total_chars as f64;
    eprintln!("CJK ratio: {ratio:.3}");
}

fn is_cjk(c: char) -> bool {
    matches!(c as u32,
        0x3040..=0x309F | // hiragana
        0x30A0..=0x30FF | // katakana
        0x4E00..=0x9FFF | // CJK unified ideographs
        0x3400..=0x4DBF   // CJK ext A
    )
}
