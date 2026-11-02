//! Thumbnail generation and cache freshness.

use crate::epub::{epub_cover_item_path, epub_opf_path, read_zip_entry};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use zip::ZipArchive;

pub fn is_thumbnail_fresh(pdf_path: &Path, thumbnail_path: &Path) -> bool {
    let pdf_modified = fs::metadata(pdf_path).and_then(|metadata| metadata.modified());
    let thumb_modified = fs::metadata(thumbnail_path).and_then(|metadata| metadata.modified());

    match (pdf_modified, thumb_modified) {
        (Ok(pdf_modified), Ok(thumb_modified)) => thumb_modified >= pdf_modified,
        _ => false,
    }
}

pub fn generate_thumbnail(file_path: &Path, output_dir: &Path) -> Result<PathBuf, String> {
    fs::create_dir_all(output_dir).map_err(|error| error.to_string())?;

    let status = Command::new("/usr/bin/qlmanage")
        .args(["-t", "-s", "320", "-o"])
        .arg(output_dir)
        .arg(file_path)
        .status()
        .map_err(|error| error.to_string())?;

    if !status.success() {
        return Err(format!("qlmanage failed with status: {status}"));
    }

    let generated_png = fs::read_dir(output_dir)
        .map_err(|error| error.to_string())?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .find(|path| {
            path.extension()
                .and_then(|ext| ext.to_str())
                .map(|ext| ext.eq_ignore_ascii_case("png"))
                .unwrap_or(false)
        })
        .ok_or_else(|| "Quick Look did not generate a PNG thumbnail".to_string())?;

    let thumbnail_path = output_dir.join("thumbnail.jpg");
    let convert_status = Command::new("/usr/bin/sips")
        .args(["-s", "format", "jpeg"])
        .arg(&generated_png)
        .args(["--out"])
        .arg(&thumbnail_path)
        .status()
        .map_err(|error| error.to_string())?;

    if !convert_status.success() {
        return Err(format!("sips failed with status: {convert_status}"));
    }

    Ok(thumbnail_path)
}

/// Extract the cover image from an EPUB file and write it to `output_dir` as
/// `thumbnail.jpg`. PNG and other non-JPEG formats are converted via `sips`
/// (macOS). Returns the path of the written thumbnail.
pub fn generate_epub_cover(epub_path: &Path, output_dir: &Path) -> Result<PathBuf, String> {
    fs::create_dir_all(output_dir).map_err(|e| e.to_string())?;

    let file = fs::File::open(epub_path).map_err(|e| e.to_string())?;
    let mut archive = ZipArchive::new(file).map_err(|e| e.to_string())?;

    let opf_path = epub_opf_path(&mut archive)?;
    let cover_item_path = epub_cover_item_path(&mut archive, &opf_path)?;

    let cover_bytes = read_zip_entry(&mut archive, &cover_item_path)?;

    let cover_ext = Path::new(&cover_item_path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("jpg")
        .to_ascii_lowercase();

    let thumbnail_path = output_dir.join("thumbnail.jpg");

    if cover_ext == "jpg" || cover_ext == "jpeg" {
        fs::write(&thumbnail_path, &cover_bytes).map_err(|e| e.to_string())?;
        return Ok(thumbnail_path);
    }

    // Non-JPEG: write to a temp file and convert via sips (macOS).
    let temp_path = output_dir.join(format!("cover.{cover_ext}"));
    fs::write(&temp_path, &cover_bytes).map_err(|e| e.to_string())?;

    let status = Command::new("/usr/bin/sips")
        .args(["-s", "format", "jpeg"])
        .arg(&temp_path)
        .args(["--out"])
        .arg(&thumbnail_path)
        .status()
        .map_err(|e| e.to_string())?;

    let _ = fs::remove_file(&temp_path);

    if !status.success() {
        return Err(format!("sips failed with status: {status}"));
    }

    Ok(thumbnail_path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::unique_temp_dir;
    use std::fs;
    use std::path::Path;
    use std::time::UNIX_EPOCH;

    #[test]
    fn is_thumbnail_fresh_compares_modification_times() {
        let dir = unique_temp_dir("thumb-fresh");
        let pdf = dir.join("a.pdf");
        let thumb = dir.join("thumbnail.jpg");
        fs::write(&pdf, b"pdf").expect("pdf fixture should write");
        fs::write(&thumb, b"jpg").expect("thumb fixture should write");

        let set_mtime = |path: &Path, secs: u64| {
            let file = fs::File::options()
                .write(true)
                .open(path)
                .expect("fixture should open");
            file.set_modified(UNIX_EPOCH + std::time::Duration::from_secs(secs))
                .expect("mtime should set");
        };

        // Thumbnail newer than the PDF -> fresh.
        set_mtime(&pdf, 1_000);
        set_mtime(&thumb, 2_000);
        assert!(is_thumbnail_fresh(&pdf, &thumb));

        // PDF newer than the thumbnail -> stale.
        set_mtime(&pdf, 3_000);
        assert!(!is_thumbnail_fresh(&pdf, &thumb));

        // A missing thumbnail is never fresh.
        assert!(!is_thumbnail_fresh(&pdf, &dir.join("missing.jpg")));

        fs::remove_dir_all(&dir).ok();
    }
}
