//! On-disk layout (config, data, cache) and migration of legacy locations.

use std::fs;
use std::path::{Path, PathBuf};

#[derive(Clone)]
pub struct AppPaths {
    pub config_file: PathBuf,
    pub data_dir: PathBuf,
    pub database_file: PathBuf,
    pub cache_dir: PathBuf,
    pub thumbnail_root: PathBuf,
    pub legacy_config_files: Vec<PathBuf>,
    pub legacy_database_files: Vec<PathBuf>,
    pub legacy_thumbnail_roots: Vec<PathBuf>,
}

fn migrate_directory_contents(source: &Path, destination: &Path) -> Result<(), String> {
    if !source.exists() || destination.exists() {
        return Ok(());
    }

    fs::create_dir_all(destination).map_err(|error| error.to_string())?;

    for entry in fs::read_dir(source).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let entry_path = entry.path();
        let destination_path = destination.join(entry.file_name());

        if entry_path.is_dir() {
            migrate_directory_contents(&entry_path, &destination_path)?;
        } else {
            fs::copy(&entry_path, &destination_path).map_err(|error| error.to_string())?;
        }
    }

    Ok(())
}

fn migrate_first_existing_file(sources: &[PathBuf], destination: &Path) -> Result<(), String> {
    if destination.exists() {
        return Ok(());
    }

    if let Some(source) = sources.iter().find(|source| source.exists()) {
        fs::copy(source, destination).map_err(|error| error.to_string())?;
    }

    Ok(())
}

pub fn prepare_storage(paths: &AppPaths) -> Result<(), String> {
    let config_dir = paths
        .config_file
        .parent()
        .ok_or_else(|| "failed to resolve config directory".to_string())?;

    fs::create_dir_all(config_dir).map_err(|error| error.to_string())?;
    fs::create_dir_all(&paths.data_dir).map_err(|error| error.to_string())?;
    fs::create_dir_all(&paths.cache_dir).map_err(|error| error.to_string())?;

    migrate_first_existing_file(&paths.legacy_config_files, &paths.config_file)?;
    migrate_first_existing_file(&paths.legacy_database_files, &paths.database_file)?;

    for legacy_thumbnail_root in &paths.legacy_thumbnail_roots {
        migrate_directory_contents(legacy_thumbnail_root, &paths.thumbnail_root)?;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::CONFIG_FILE;
    use crate::test_support::{test_app_paths, unique_temp_dir};
    use std::fs;

    #[test]
    fn migrate_directory_contents_copies_files_recursively_when_destination_missing() {
        let temp_root = unique_temp_dir("migrate-directory-contents");
        let source = temp_root.join("source");
        let destination = temp_root.join("destination");
        let nested_source = source.join("nested");
        fs::create_dir_all(&nested_source).expect("source tree should be created");
        fs::write(source.join("top.txt"), "top").expect("top file should be written");
        fs::write(nested_source.join("child.txt"), "nested")
            .expect("nested file should be written");

        migrate_directory_contents(&source, &destination).expect("migration should succeed");

        assert_eq!(
            fs::read_to_string(destination.join("top.txt")).expect("top file should be copied"),
            "top"
        );
        assert_eq!(
            fs::read_to_string(destination.join("nested").join("child.txt"))
                .expect("nested file should be copied"),
            "nested"
        );

        let _ = fs::remove_dir_all(temp_root);
    }

    #[test]
    fn prepare_storage_copies_legacy_files_only_when_targets_are_missing() {
        let temp_root = unique_temp_dir("prepare-storage");
        let paths = test_app_paths(&temp_root);
        let legacy_thumbnail_root = paths.legacy_thumbnail_roots[0].clone();
        let legacy_config_file = paths.legacy_config_files[0].clone();
        let legacy_database_file = paths.legacy_database_files[0].clone();

        fs::create_dir_all(legacy_thumbnail_root.join("nested"))
            .expect("legacy thumbnail dir should be created");
        fs::write(&legacy_config_file, "pdf_renderer = \"pdfjs\"\n")
            .expect("legacy config should be written");
        fs::write(&legacy_database_file, "db").expect("legacy database should be written");
        fs::write(
            legacy_thumbnail_root.join("nested").join("thumb.jpg"),
            "thumb",
        )
        .expect("legacy thumbnail should be written");

        prepare_storage(&paths).expect("storage preparation should succeed");

        assert_eq!(
            fs::read_to_string(&paths.config_file).expect("config should be copied"),
            "pdf_renderer = \"pdfjs\"\n"
        );
        assert_eq!(
            fs::read_to_string(&paths.database_file).expect("database should be copied"),
            "db"
        );
        assert_eq!(
            fs::read_to_string(paths.thumbnail_root.join("nested").join("thumb.jpg"))
                .expect("thumbnail should be migrated"),
            "thumb"
        );

        fs::write(&paths.config_file, "pdf_renderer = \"native\"\n")
            .expect("existing config should be overwritten for test");
        prepare_storage(&paths).expect("second storage preparation should succeed");
        assert_eq!(
            fs::read_to_string(&paths.config_file).expect("existing config should remain"),
            "pdf_renderer = \"native\"\n"
        );

        let _ = fs::remove_dir_all(temp_root);
    }

    #[test]
    fn prepare_storage_migrates_from_old_app_namespace_paths() {
        let temp_root = unique_temp_dir("prepare-storage-old-namespace");
        let mut paths = test_app_paths(&temp_root);
        let old_namespace_root = temp_root.join("old-namespace");
        let old_config_file = old_namespace_root.join("config").join(CONFIG_FILE);
        let old_database_file = old_namespace_root.join("data").join("app.db");
        let old_thumbnail_root = old_namespace_root.join("cache").join("thumbnails");

        paths.legacy_config_files = vec![old_config_file.clone()];
        paths.legacy_database_files = vec![old_database_file.clone()];
        paths.legacy_thumbnail_roots = vec![old_thumbnail_root.clone()];

        fs::create_dir_all(
            old_config_file
                .parent()
                .expect("config parent should exist"),
        )
        .expect("old namespace config dir should be created");
        fs::create_dir_all(
            old_database_file
                .parent()
                .expect("database parent should exist"),
        )
        .expect("old namespace data dir should be created");
        fs::create_dir_all(old_thumbnail_root.join("nested"))
            .expect("old namespace thumbnail dir should be created");
        fs::write(&old_config_file, "pdf_renderer = \"pdfjs\"\n")
            .expect("old namespace config should be written");
        fs::write(&old_database_file, "db2").expect("old namespace database should be written");
        fs::write(
            old_thumbnail_root.join("nested").join("thumb.jpg"),
            "thumb2",
        )
        .expect("old namespace thumbnail should be written");

        prepare_storage(&paths).expect("storage preparation should succeed");

        assert_eq!(
            fs::read_to_string(&paths.config_file).expect("config should be copied"),
            "pdf_renderer = \"pdfjs\"\n"
        );
        assert_eq!(
            fs::read_to_string(&paths.database_file).expect("database should be copied"),
            "db2"
        );
        assert_eq!(
            fs::read_to_string(paths.thumbnail_root.join("nested").join("thumb.jpg"))
                .expect("thumbnail should be migrated"),
            "thumb2"
        );

        let _ = fs::remove_dir_all(temp_root);
    }

    #[test]
    fn migrate_directory_contents_skips_when_source_missing_or_destination_exists() {
        let root = unique_temp_dir("migrate-guard");

        // Source missing -> no-op, destination not created.
        migrate_directory_contents(&root.join("nope"), &root.join("dest"))
            .expect("missing source is a no-op");
        assert!(!root.join("dest").exists());

        // Destination already exists -> no-op, existing content preserved and
        // the source content is NOT copied in.
        let src = root.join("src");
        fs::create_dir_all(&src).unwrap();
        fs::write(src.join("new.txt"), b"new").unwrap();
        let dest = root.join("dest2");
        fs::create_dir_all(&dest).unwrap();
        fs::write(dest.join("keep.txt"), b"keep").unwrap();
        migrate_directory_contents(&src, &dest).expect("existing destination is a no-op");
        assert!(dest.join("keep.txt").exists());
        assert!(!dest.join("new.txt").exists());

        fs::remove_dir_all(&root).ok();
    }
}
