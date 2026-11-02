//! Viewer preferences: defaults, normalization, and global/per-file storage.

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::time::UNIX_EPOCH;

pub(crate) const VIEWER_DEFAULT_SCOPE_KEY: &str = "__default__";
const VIEWER_SOURCE_TYPE_PDF: &str = "pdf";
const VIEWER_SOURCE_TYPE_EPUB: &str = "epub";
const DEFAULT_VIEWER_PAGE_MODE: &str = "spread";
const DEFAULT_VIEWER_BINDING_DIRECTION: &str = "auto";
const DEFAULT_VIEWER_ZOOM_MODE: &str = "fit-height";
const DEFAULT_VIEWER_ALIGN_MODE: &str = "center";
const DEFAULT_VIEWER_VERTICAL_GAP_MODE: &str = "compact";
const DEFAULT_VIEWER_TREAT_FIRST_PAGE_AS_COVER: bool = true;
const DEFAULT_VIEWER_BACKGROUND_MODE: &str = "inherit-theme";
const DEFAULT_VIEWER_SCROLL_MODE: &str = "paged";
const DEFAULT_VIEWER_DESKEW_MODE: &str = "off";
const VIEWER_DESKEW_MODE_AUTO: &str = "auto";
const DEFAULT_VIEWER_TRIM_MODE: &str = "off";
const VIEWER_TRIM_MODE_AUTO: &str = "auto";
const DEFAULT_VIEWER_EPUB_FONT_SIZE: i64 = 100;
const DEFAULT_THEME_VIEWER_BACKGROUND_MODE: &str = "default";
const SNOW_WHITE_VIEWER_BACKGROUND_MODE: &str = "snow-white";
const NIGHT_CITY_VIEWER_BACKGROUND_MODE: &str = "night-city";
const NAVY_BLUE_VIEWER_BACKGROUND_MODE: &str = "navy-blue";

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewerPreferences {
    pub page_mode: String,
    pub binding_direction: String,
    pub zoom_mode: String,
    pub align_mode: String,
    pub vertical_gap_mode: String,
    pub treat_first_page_as_cover: bool,
    pub background_mode: String,
    pub scroll_mode: String,
    pub epub_font_size: i64,
    /// `"off"` or `"auto"`; blank on a file row means "inherit the global
    /// value". Defaulted on deserialize so a payload from a build that predates
    /// the field still parses.
    #[serde(default)]
    pub deskew_mode: String,
    /// `"off"` or `"auto"`: trim scanned margins. Same blank-means-inherit
    /// and serde-default rules as `deskew_mode`.
    #[serde(default)]
    pub trim_mode: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewerPreferencesPayload {
    pub global: ViewerPreferences,
    pub file: Option<ViewerPreferences>,
    pub effective: ViewerPreferences,
    pub uses_file_override: bool,
}

pub fn default_viewer_preferences() -> ViewerPreferences {
    ViewerPreferences {
        page_mode: DEFAULT_VIEWER_PAGE_MODE.to_string(),
        binding_direction: DEFAULT_VIEWER_BINDING_DIRECTION.to_string(),
        zoom_mode: DEFAULT_VIEWER_ZOOM_MODE.to_string(),
        align_mode: DEFAULT_VIEWER_ALIGN_MODE.to_string(),
        vertical_gap_mode: DEFAULT_VIEWER_VERTICAL_GAP_MODE.to_string(),
        treat_first_page_as_cover: DEFAULT_VIEWER_TREAT_FIRST_PAGE_AS_COVER,
        background_mode: DEFAULT_VIEWER_BACKGROUND_MODE.to_string(),
        scroll_mode: DEFAULT_VIEWER_SCROLL_MODE.to_string(),
        epub_font_size: DEFAULT_VIEWER_EPUB_FONT_SIZE,
        deskew_mode: DEFAULT_VIEWER_DESKEW_MODE.to_string(),
        trim_mode: DEFAULT_VIEWER_TRIM_MODE.to_string(),
    }
}

fn normalize_epub_font_size(value: i64) -> i64 {
    value.clamp(50, 200)
}

pub fn normalize_viewer_source_type(value: &str) -> String {
    match value.trim().to_lowercase().as_str() {
        VIEWER_SOURCE_TYPE_EPUB => VIEWER_SOURCE_TYPE_EPUB.to_string(),
        _ => VIEWER_SOURCE_TYPE_PDF.to_string(),
    }
}

pub fn viewer_global_scope_key(source_type: &str) -> String {
    format!("{VIEWER_DEFAULT_SCOPE_KEY}:{source_type}")
}

pub fn viewer_file_scope_key(file_path: &str, source_type: &str) -> String {
    format!("{file_path}::{source_type}")
}

fn normalize_page_mode(value: &str) -> String {
    match value.trim().to_lowercase().as_str() {
        "single" => "single".to_string(),
        _ => DEFAULT_VIEWER_PAGE_MODE.to_string(),
    }
}

fn normalize_binding_direction(value: &str) -> String {
    // "auto" is the default, so an explicit arm would be redundant with `_`.
    match value.trim().to_lowercase().as_str() {
        "left" => "left".to_string(),
        "right" => "right".to_string(),
        _ => DEFAULT_VIEWER_BINDING_DIRECTION.to_string(),
    }
}

fn normalize_zoom_mode(value: &str) -> String {
    match value.trim().to_lowercase().as_str() {
        "fit-width" => "fit-width".to_string(),
        "original" => "original".to_string(),
        _ => DEFAULT_VIEWER_ZOOM_MODE.to_string(),
    }
}

fn normalize_align_mode(value: &str) -> String {
    match value.trim().to_lowercase().as_str() {
        "left" => "left".to_string(),
        "right" => "right".to_string(),
        _ => DEFAULT_VIEWER_ALIGN_MODE.to_string(),
    }
}

fn normalize_vertical_gap_mode(value: &str) -> String {
    match value.trim().to_lowercase().as_str() {
        "wide" => "wide".to_string(),
        "none" => "none".to_string(),
        _ => DEFAULT_VIEWER_VERTICAL_GAP_MODE.to_string(),
    }
}

fn normalize_scroll_mode(value: &str) -> String {
    match value.trim().to_lowercase().as_str() {
        "continuous" => "continuous".to_string(),
        _ => DEFAULT_VIEWER_SCROLL_MODE.to_string(),
    }
}

fn normalize_background_mode(value: &str) -> String {
    match value.trim().to_lowercase().as_str() {
        DEFAULT_THEME_VIEWER_BACKGROUND_MODE => DEFAULT_THEME_VIEWER_BACKGROUND_MODE.to_string(),
        SNOW_WHITE_VIEWER_BACKGROUND_MODE => SNOW_WHITE_VIEWER_BACKGROUND_MODE.to_string(),
        NIGHT_CITY_VIEWER_BACKGROUND_MODE => NIGHT_CITY_VIEWER_BACKGROUND_MODE.to_string(),
        NAVY_BLUE_VIEWER_BACKGROUND_MODE => NAVY_BLUE_VIEWER_BACKGROUND_MODE.to_string(),
        _ => DEFAULT_VIEWER_BACKGROUND_MODE.to_string(),
    }
}

fn normalize_deskew_mode(value: &str) -> String {
    match value.trim().to_lowercase().as_str() {
        VIEWER_DESKEW_MODE_AUTO => VIEWER_DESKEW_MODE_AUTO.to_string(),
        _ => DEFAULT_VIEWER_DESKEW_MODE.to_string(),
    }
}

fn normalize_trim_mode(value: &str) -> String {
    match value.trim().to_lowercase().as_str() {
        VIEWER_TRIM_MODE_AUTO => VIEWER_TRIM_MODE_AUTO.to_string(),
        _ => DEFAULT_VIEWER_TRIM_MODE.to_string(),
    }
}

pub fn normalize_viewer_preferences(preferences: ViewerPreferences) -> ViewerPreferences {
    ViewerPreferences {
        page_mode: normalize_page_mode(&preferences.page_mode),
        binding_direction: normalize_binding_direction(&preferences.binding_direction),
        zoom_mode: normalize_zoom_mode(&preferences.zoom_mode),
        align_mode: normalize_align_mode(&preferences.align_mode),
        vertical_gap_mode: normalize_vertical_gap_mode(&preferences.vertical_gap_mode),
        treat_first_page_as_cover: preferences.treat_first_page_as_cover,
        background_mode: normalize_background_mode(&preferences.background_mode),
        scroll_mode: normalize_scroll_mode(&preferences.scroll_mode),
        epub_font_size: normalize_epub_font_size(preferences.epub_font_size),
        deskew_mode: normalize_deskew_mode(&preferences.deskew_mode),
        trim_mode: normalize_trim_mode(&preferences.trim_mode),
    }
}

pub fn load_saved_viewer_preferences(
    connection: &Connection,
    scope_key: &str,
) -> Result<Option<ViewerPreferences>, String> {
    let mut statement = connection
        .prepare(
            "
            SELECT
              page_mode,
              binding_direction,
              zoom_mode,
              align_mode,
              vertical_gap_mode,
              treat_first_page_as_cover,
              background_mode,
              scroll_mode,
              epub_font_size,
              deskew_mode,
              trim_mode
            FROM viewer_preferences
            WHERE scope_key = ?1
            ",
        )
        .map_err(|error| error.to_string())?;

    let preferences = statement.query_row(params![scope_key], |row| {
        Ok(ViewerPreferences {
            page_mode: row.get(0)?,
            binding_direction: row.get(1)?,
            zoom_mode: row.get(2)?,
            align_mode: row.get(3)?,
            vertical_gap_mode: row.get(4)?,
            treat_first_page_as_cover: row.get::<_, i64>(5)? != 0,
            background_mode: row.get(6)?,
            scroll_mode: row.get(7)?,
            epub_font_size: row
                .get::<_, i64>(8)
                .unwrap_or(DEFAULT_VIEWER_EPUB_FONT_SIZE),
            deskew_mode: row
                .get::<_, String>(9)
                .unwrap_or_else(|_| DEFAULT_VIEWER_DESKEW_MODE.to_string()),
            trim_mode: row
                .get::<_, String>(10)
                .unwrap_or_else(|_| DEFAULT_VIEWER_TRIM_MODE.to_string()),
        })
    });

    match preferences {
        Ok(preferences) => Ok(Some(preferences)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

fn merge_file_viewer_preferences(
    global: &ViewerPreferences,
    file: &ViewerPreferences,
) -> ViewerPreferences {
    ViewerPreferences {
        page_mode: if file.page_mode.trim().is_empty() {
            global.page_mode.clone()
        } else {
            normalize_page_mode(&file.page_mode)
        },
        binding_direction: normalize_binding_direction(&file.binding_direction),
        zoom_mode: if file.zoom_mode.trim().is_empty() {
            global.zoom_mode.clone()
        } else {
            normalize_zoom_mode(&file.zoom_mode)
        },
        align_mode: if file.align_mode.trim().is_empty() {
            global.align_mode.clone()
        } else {
            normalize_align_mode(&file.align_mode)
        },
        vertical_gap_mode: if file.vertical_gap_mode.trim().is_empty() {
            global.vertical_gap_mode.clone()
        } else {
            normalize_vertical_gap_mode(&file.vertical_gap_mode)
        },
        treat_first_page_as_cover: file.treat_first_page_as_cover,
        background_mode: if file.background_mode.trim().is_empty() {
            global.background_mode.clone()
        } else {
            normalize_background_mode(&file.background_mode)
        },
        scroll_mode: if file.scroll_mode.trim().is_empty() {
            global.scroll_mode.clone()
        } else {
            normalize_scroll_mode(&file.scroll_mode)
        },
        epub_font_size: if file.epub_font_size == 0 {
            global.epub_font_size
        } else {
            normalize_epub_font_size(file.epub_font_size)
        },
        deskew_mode: if file.deskew_mode.trim().is_empty() {
            global.deskew_mode.clone()
        } else {
            normalize_deskew_mode(&file.deskew_mode)
        },
        trim_mode: if file.trim_mode.trim().is_empty() {
            global.trim_mode.clone()
        } else {
            normalize_trim_mode(&file.trim_mode)
        },
    }
}

pub fn build_file_viewer_preferences_for_storage(
    global: &ViewerPreferences,
    normalized: ViewerPreferences,
) -> ViewerPreferences {
    ViewerPreferences {
        page_mode: if normalized.page_mode == global.page_mode {
            String::new()
        } else {
            normalized.page_mode
        },
        binding_direction: normalized.binding_direction,
        zoom_mode: if normalized.zoom_mode == global.zoom_mode {
            String::new()
        } else {
            normalized.zoom_mode
        },
        align_mode: if normalized.align_mode == global.align_mode {
            String::new()
        } else {
            normalized.align_mode
        },
        vertical_gap_mode: if normalized.vertical_gap_mode == global.vertical_gap_mode {
            String::new()
        } else {
            normalized.vertical_gap_mode
        },
        treat_first_page_as_cover: normalized.treat_first_page_as_cover,
        background_mode: if normalized.background_mode == global.background_mode {
            String::new()
        } else {
            normalized.background_mode
        },
        scroll_mode: if normalized.scroll_mode == global.scroll_mode {
            String::new()
        } else {
            normalized.scroll_mode
        },
        epub_font_size: if normalized.epub_font_size
            == normalize_epub_font_size(global.epub_font_size)
        {
            0
        } else {
            normalized.epub_font_size
        },
        deskew_mode: if normalized.deskew_mode == global.deskew_mode {
            String::new()
        } else {
            normalized.deskew_mode
        },
        trim_mode: if normalized.trim_mode == global.trim_mode {
            String::new()
        } else {
            normalized.trim_mode
        },
    }
}

/// Write one `viewer_preferences` row exactly as given.
///
/// Callers own normalization: the global scope normalizes first, while the
/// file scope passes the output of `build_file_viewer_preferences_for_storage`,
/// whose blank string fields and `epub_font_size == 0` mean "inherit the
/// global value" and must reach the database untouched so
/// `merge_file_viewer_preferences` can honour them on load.
pub fn save_viewer_preferences_record(
    connection: &Connection,
    scope_key: &str,
    file_path: Option<&str>,
    source_type: &str,
    preferences: ViewerPreferences,
) -> Result<ViewerPreferences, String> {
    let record = preferences;
    let normalized_source_type = normalize_viewer_source_type(source_type);
    let updated_at = std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_secs();

    connection
        .execute(
            "
            INSERT INTO viewer_preferences (
              scope_key,
              file_path,
              source_type,
              page_mode,
              binding_direction,
              zoom_mode,
              align_mode,
              vertical_gap_mode,
              treat_first_page_as_cover,
              background_mode,
              scroll_mode,
              epub_font_size,
              deskew_mode,
              trim_mode,
              updated_at
            )
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
            ON CONFLICT(scope_key) DO UPDATE SET
              file_path = excluded.file_path,
              source_type = excluded.source_type,
              page_mode = excluded.page_mode,
              binding_direction = excluded.binding_direction,
              zoom_mode = excluded.zoom_mode,
              align_mode = excluded.align_mode,
              vertical_gap_mode = excluded.vertical_gap_mode,
              treat_first_page_as_cover = excluded.treat_first_page_as_cover,
              background_mode = excluded.background_mode,
              scroll_mode = excluded.scroll_mode,
              epub_font_size = excluded.epub_font_size,
              deskew_mode = excluded.deskew_mode,
              trim_mode = excluded.trim_mode,
              updated_at = excluded.updated_at
            ",
            params![
                scope_key,
                file_path,
                normalized_source_type,
                record.page_mode,
                record.binding_direction,
                record.zoom_mode,
                record.align_mode,
                record.vertical_gap_mode,
                if record.treat_first_page_as_cover {
                    1
                } else {
                    0
                },
                record.background_mode,
                record.scroll_mode,
                record.epub_font_size,
                record.deskew_mode,
                record.trim_mode,
                updated_at
            ],
        )
        .map_err(|error| error.to_string())?;

    Ok(record)
}

pub fn load_viewer_preferences_payload(
    connection: &Connection,
    file_path: Option<&str>,
    source_type: &str,
) -> Result<ViewerPreferencesPayload, String> {
    let normalized_source_type = normalize_viewer_source_type(source_type);
    let global_scope_key = viewer_global_scope_key(&normalized_source_type);
    let global = load_saved_viewer_preferences(connection, &global_scope_key)?
        .map(normalize_viewer_preferences)
        .unwrap_or_else(default_viewer_preferences);
    let file_raw = if let Some(file_path) = file_path {
        let file_scope_key = viewer_file_scope_key(file_path, &normalized_source_type);
        load_saved_viewer_preferences(connection, &file_scope_key)?
    } else {
        None
    };
    let file = file_raw
        .as_ref()
        .map(|preferences| merge_file_viewer_preferences(&global, preferences));
    let uses_file_override = file_raw.is_some();
    let effective = file.clone().unwrap_or_else(|| global.clone());

    Ok(ViewerPreferencesPayload {
        global,
        file,
        effective,
        uses_file_override,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{
        apply_pre_version_migrations, migrate_legacy_config_with_connection,
        normalize_gui_config_input, AppConfigInput, CONFIG_FILE,
    };
    use crate::reading::normalize_page_offset_ratio;
    use crate::test_support::{
        arbitrary_viewer_preferences, normalized_viewer_preferences_strategy, test_connection,
        unique_temp_dir, viewer_preferences,
    };
    use proptest::prelude::*;
    use std::fs;

    #[test]
    fn migrate_legacy_config_stamps_version_and_runs_migration() {
        let connection = test_connection();
        save_viewer_preferences_record(
            &connection,
            &viewer_global_scope_key("pdf"),
            None,
            "pdf",
            viewer_preferences(
                "dual",
                "left",
                "fit-width",
                "left",
                "wide",
                false,
                "inherit-theme",
            ),
        )
        .expect("global prefs should save");

        let dir = unique_temp_dir("legacy-config");
        let config_path = dir.join("riida.toml");
        // A versionless config predates the version-stamped migration scheme.
        fs::write(&config_path, "library_roots = []\n").expect("config should write");

        migrate_legacy_config_with_connection(&config_path, &connection)
            .expect("legacy migration should run");

        // The pre-version migration flipped the legacy global binding...
        let global = load_saved_viewer_preferences(&connection, &viewer_global_scope_key("pdf"))
            .expect("global load")
            .expect("global row exists");
        assert_eq!(global.binding_direction, "auto");
        // ...and the file was stamped with the current version so later launches skip it.
        let rewritten = fs::read_to_string(&config_path).expect("config should read");
        assert!(
            rewritten.contains(&format!("version = \"{}\"", env!("CARGO_PKG_VERSION"))),
            "config should be stamped with the current version, got: {rewritten}"
        );

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn migrate_legacy_config_is_noop_when_version_present() {
        let connection = test_connection();
        save_viewer_preferences_record(
            &connection,
            &viewer_global_scope_key("pdf"),
            None,
            "pdf",
            viewer_preferences(
                "dual",
                "left",
                "fit-width",
                "left",
                "wide",
                false,
                "inherit-theme",
            ),
        )
        .expect("global prefs should save");

        let dir = unique_temp_dir("versioned-config");
        let config_path = dir.join("riida.toml");
        let original = "version = \"0.0.1\"\nlibrary_roots = []\n";
        fs::write(&config_path, original).expect("config should write");

        migrate_legacy_config_with_connection(&config_path, &connection)
            .expect("versioned config should be a no-op");

        // The migration never ran, so the legacy "left" binding is preserved.
        let global = load_saved_viewer_preferences(&connection, &viewer_global_scope_key("pdf"))
            .expect("global load")
            .expect("global row exists");
        assert_eq!(global.binding_direction, "left");
        // The already-versioned file is left byte-for-byte unchanged.
        let after = fs::read_to_string(&config_path).expect("config should read");
        assert_eq!(after, original, "versioned config must not be rewritten");

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn load_viewer_preferences_payload_applies_file_override() {
        let connection = test_connection();
        save_viewer_preferences_record(
            &connection,
            &viewer_global_scope_key("pdf"),
            None,
            "pdf",
            viewer_preferences(
                "dual",
                "auto",
                "fit-width",
                "left",
                "wide",
                false,
                "inherit-theme",
            ),
        )
        .expect("global prefs should save");

        // With no file-scoped row, the effective settings fall back to global.
        let payload = load_viewer_preferences_payload(&connection, Some("/book.pdf"), "pdf")
            .expect("payload should load");
        assert!(!payload.uses_file_override);
        assert!(payload.file.is_none());
        assert_eq!(payload.effective.binding_direction, "auto");

        // A file-scoped override with an explicit "right" binding.
        save_viewer_preferences_record(
            &connection,
            &viewer_file_scope_key("/book.pdf", "pdf"),
            Some("/book.pdf"),
            "pdf",
            viewer_preferences(
                "dual",
                "right",
                "fit-width",
                "left",
                "wide",
                false,
                "inherit-theme",
            ),
        )
        .expect("file prefs should save");

        let payload = load_viewer_preferences_payload(&connection, Some("/book.pdf"), "pdf")
            .expect("payload should load");
        assert!(payload.uses_file_override);
        assert_eq!(payload.effective.binding_direction, "right");
        // The reported global is still the untouched global row.
        assert_eq!(payload.global.binding_direction, "auto");

        // Loading without a file path ignores the per-file override entirely.
        let global_payload =
            load_viewer_preferences_payload(&connection, None, "pdf").expect("payload should load");
        assert!(!global_payload.uses_file_override);
        assert_eq!(global_payload.effective.binding_direction, "auto");
    }

    #[test]
    fn normalize_viewer_preferences_falls_back_to_defaults_for_unknown_values() {
        let normalized = normalize_viewer_preferences(viewer_preferences(
            "mystery",
            "upside-down",
            "stretch",
            "outer-space",
            "tight",
            false,
            "glow",
        ));

        assert_eq!(normalized.page_mode, DEFAULT_VIEWER_PAGE_MODE);
        assert_eq!(
            normalized.binding_direction,
            DEFAULT_VIEWER_BINDING_DIRECTION
        );
        assert_eq!(normalized.zoom_mode, DEFAULT_VIEWER_ZOOM_MODE);
        assert_eq!(normalized.align_mode, DEFAULT_VIEWER_ALIGN_MODE);
        assert_eq!(
            normalized.vertical_gap_mode,
            DEFAULT_VIEWER_VERTICAL_GAP_MODE
        );
        assert!(!normalized.treat_first_page_as_cover);
        assert_eq!(normalized.background_mode, DEFAULT_VIEWER_BACKGROUND_MODE);
        assert_eq!(normalized.epub_font_size, 50);
    }

    #[test]
    fn merge_file_viewer_preferences_inherits_blank_fields_from_global() {
        let global = viewer_preferences(
            "spread",
            "left",
            "fit-height",
            "center",
            "compact",
            true,
            "inherit-theme",
        );
        let file = viewer_preferences("", "right", "", "left", "", false, "");

        let merged = merge_file_viewer_preferences(&global, &file);

        assert_eq!(merged.page_mode, "spread");
        assert_eq!(merged.binding_direction, "right");
        assert_eq!(merged.zoom_mode, "fit-height");
        assert_eq!(merged.align_mode, "left");
        assert_eq!(merged.vertical_gap_mode, "compact");
        assert!(!merged.treat_first_page_as_cover);
        assert_eq!(merged.background_mode, "inherit-theme");
    }

    #[test]
    fn normalize_deskew_mode_accepts_auto_and_falls_back_to_off() {
        assert_eq!(normalize_deskew_mode("auto"), "auto");
        assert_eq!(normalize_deskew_mode("  AUTO "), "auto");
        assert_eq!(normalize_deskew_mode("off"), "off");
        assert_eq!(normalize_deskew_mode(""), "off");
        assert_eq!(normalize_deskew_mode("sideways"), "off");
    }

    #[test]
    fn normalize_trim_mode_accepts_auto_and_falls_back_to_off() {
        assert_eq!(normalize_trim_mode("auto"), "auto");
        assert_eq!(normalize_trim_mode(" Auto "), "auto");
        assert_eq!(normalize_trim_mode("off"), "off");
        assert_eq!(normalize_trim_mode(""), "off");
        assert_eq!(normalize_trim_mode("crop"), "off");
    }

    #[test]
    fn trim_mode_normalizes_merges_and_stores_like_deskew_mode() {
        let mut preferences = default_viewer_preferences();
        preferences.trim_mode = "AUTO".to_string();
        assert_eq!(normalize_viewer_preferences(preferences).trim_mode, "auto");

        let mut global = default_viewer_preferences();
        global.trim_mode = "auto".to_string();
        let inherited = viewer_preferences("", "", "", "", "", true, "");
        assert_eq!(
            merge_file_viewer_preferences(&global, &inherited).trim_mode,
            "auto"
        );
        let mut explicit_off = viewer_preferences("", "", "", "", "", true, "");
        explicit_off.trim_mode = "off".to_string();
        assert_eq!(
            merge_file_viewer_preferences(&global, &explicit_off).trim_mode,
            "off"
        );

        let same = build_file_viewer_preferences_for_storage(&global, global.clone());
        assert_eq!(same.trim_mode, "");
        let mut differs = global.clone();
        differs.trim_mode = "off".to_string();
        assert_eq!(
            build_file_viewer_preferences_for_storage(&global, differs).trim_mode,
            "off"
        );
    }

    #[test]
    fn trim_mode_round_trips_through_sqlite() {
        let connection = test_connection();
        let mut global = default_viewer_preferences();
        global.trim_mode = "auto".to_string();
        save_viewer_preferences_record(
            &connection,
            &viewer_global_scope_key(VIEWER_SOURCE_TYPE_PDF),
            None,
            VIEWER_SOURCE_TYPE_PDF,
            global,
        )
        .expect("global preferences should save");
        let payload = load_viewer_preferences_payload(&connection, None, VIEWER_SOURCE_TYPE_PDF)
            .expect("payload should load");
        assert_eq!(payload.global.trim_mode, "auto");
        assert_eq!(payload.effective.trim_mode, "auto");
    }

    #[test]
    fn normalize_viewer_preferences_normalizes_deskew_mode() {
        let mut preferences = viewer_preferences(
            "spread",
            "left",
            "fit-height",
            "center",
            "compact",
            true,
            "inherit-theme",
        );
        preferences.deskew_mode = "Auto".to_string();
        assert_eq!(
            normalize_viewer_preferences(preferences).deskew_mode,
            "auto"
        );

        let blank = viewer_preferences("", "", "", "", "", true, "");
        assert_eq!(normalize_viewer_preferences(blank).deskew_mode, "off");
    }

    #[test]
    fn merge_file_viewer_preferences_inherits_deskew_mode_from_global() {
        let mut global = default_viewer_preferences();
        global.deskew_mode = "auto".to_string();

        let inherited = viewer_preferences("", "", "", "", "", true, "");
        assert_eq!(
            merge_file_viewer_preferences(&global, &inherited).deskew_mode,
            "auto"
        );

        let mut explicit_off = viewer_preferences("", "", "", "", "", true, "");
        explicit_off.deskew_mode = "off".to_string();
        assert_eq!(
            merge_file_viewer_preferences(&global, &explicit_off).deskew_mode,
            "off"
        );

        let mut garbage = viewer_preferences("", "", "", "", "", true, "");
        garbage.deskew_mode = "tilted".to_string();
        assert_eq!(
            merge_file_viewer_preferences(&global, &garbage).deskew_mode,
            "off"
        );
    }

    #[test]
    fn file_viewer_preferences_storage_blanks_deskew_mode_matching_global() {
        let global = default_viewer_preferences();

        let same = build_file_viewer_preferences_for_storage(&global, global.clone());
        assert_eq!(same.deskew_mode, "");

        let mut auto = global.clone();
        auto.deskew_mode = "auto".to_string();
        let stored = build_file_viewer_preferences_for_storage(&global, auto);
        assert_eq!(stored.deskew_mode, "auto");
    }

    #[test]
    fn pre_version_migration_promotes_global_left_to_auto() {
        let connection = test_connection();
        save_viewer_preferences_record(
            &connection,
            &viewer_global_scope_key(VIEWER_SOURCE_TYPE_PDF),
            None,
            VIEWER_SOURCE_TYPE_PDF,
            viewer_preferences(
                "spread",
                "left",
                "fit-height",
                "center",
                "compact",
                true,
                "default",
            ),
        )
        .expect("global pdf preferences should save");
        save_viewer_preferences_record(
            &connection,
            &viewer_global_scope_key(VIEWER_SOURCE_TYPE_EPUB),
            None,
            VIEWER_SOURCE_TYPE_EPUB,
            viewer_preferences(
                "single",
                "left",
                "fit-height",
                "center",
                "wide",
                false,
                "default",
            ),
        )
        .expect("global epub preferences should save");
        save_viewer_preferences_record(
            &connection,
            &viewer_file_scope_key("/tmp/book.pdf", VIEWER_SOURCE_TYPE_PDF),
            Some("/tmp/book.pdf"),
            VIEWER_SOURCE_TYPE_PDF,
            viewer_preferences("", "left", "", "", "", false, ""),
        )
        .expect("file pdf preferences should save");

        apply_pre_version_migrations(&connection).expect("migration should run");

        let pdf_global = load_saved_viewer_preferences(
            &connection,
            &viewer_global_scope_key(VIEWER_SOURCE_TYPE_PDF),
        )
        .expect("global pdf row should load")
        .expect("global pdf row should exist");
        let epub_global = load_saved_viewer_preferences(
            &connection,
            &viewer_global_scope_key(VIEWER_SOURCE_TYPE_EPUB),
        )
        .expect("global epub row should load")
        .expect("global epub row should exist");
        let file_row = load_saved_viewer_preferences(
            &connection,
            &viewer_file_scope_key("/tmp/book.pdf", VIEWER_SOURCE_TYPE_PDF),
        )
        .expect("file row should load")
        .expect("file row should exist");

        assert_eq!(pdf_global.binding_direction, "auto");
        assert_eq!(epub_global.binding_direction, "auto");
        // Per-file rows are explicit user choices and must not be touched.
        assert_eq!(file_row.binding_direction, "left");
    }

    #[test]
    fn pre_version_migration_leaves_explicit_global_right_alone() {
        let connection = test_connection();
        save_viewer_preferences_record(
            &connection,
            &viewer_global_scope_key(VIEWER_SOURCE_TYPE_PDF),
            None,
            VIEWER_SOURCE_TYPE_PDF,
            viewer_preferences(
                "spread",
                "right",
                "fit-height",
                "center",
                "compact",
                true,
                "default",
            ),
        )
        .expect("global preferences should save");

        apply_pre_version_migrations(&connection).expect("migration should run");

        let global = load_saved_viewer_preferences(
            &connection,
            &viewer_global_scope_key(VIEWER_SOURCE_TYPE_PDF),
        )
        .expect("global row should load")
        .expect("global row should exist");
        assert_eq!(global.binding_direction, "right");
    }

    #[test]
    fn legacy_config_migration_stamps_version_and_runs_once() {
        let temp_root = unique_temp_dir("legacy-config-migration");
        let config_path = temp_root.join(CONFIG_FILE);
        fs::write(
            &config_path,
            "library_roots = [\"~/Documents/Ebooks/\"]\npdf_renderer = \"pdfjs\"\n",
        )
        .expect("legacy config should be written");

        let connection = test_connection();
        save_viewer_preferences_record(
            &connection,
            &viewer_global_scope_key(VIEWER_SOURCE_TYPE_PDF),
            None,
            VIEWER_SOURCE_TYPE_PDF,
            viewer_preferences(
                "spread",
                "left",
                "fit-height",
                "center",
                "compact",
                true,
                "default",
            ),
        )
        .expect("global preferences should save");

        migrate_legacy_config_with_connection(&config_path, &connection)
            .expect("legacy migration should succeed");

        let global = load_saved_viewer_preferences(
            &connection,
            &viewer_global_scope_key(VIEWER_SOURCE_TYPE_PDF),
        )
        .expect("global row should load")
        .expect("global row should exist");
        assert_eq!(global.binding_direction, "auto");

        let after_first = fs::read_to_string(&config_path).expect("config should be readable");
        assert!(
            after_first.contains(&format!("version = \"{}\"", env!("CARGO_PKG_VERSION"))),
            "stamped config should include current version: {after_first}"
        );

        // Second run with version present must be a no-op: revert global to
        // "left" by hand and confirm the migration leaves it alone.
        save_viewer_preferences_record(
            &connection,
            &viewer_global_scope_key(VIEWER_SOURCE_TYPE_PDF),
            None,
            VIEWER_SOURCE_TYPE_PDF,
            viewer_preferences(
                "spread",
                "left",
                "fit-height",
                "center",
                "compact",
                true,
                "default",
            ),
        )
        .expect("global preferences should save");
        migrate_legacy_config_with_connection(&config_path, &connection)
            .expect("repeat run should succeed");
        let after_second = load_saved_viewer_preferences(
            &connection,
            &viewer_global_scope_key(VIEWER_SOURCE_TYPE_PDF),
        )
        .expect("global row should load")
        .expect("global row should exist");
        assert_eq!(
            after_second.binding_direction, "left",
            "version-stamped config should not re-run the migration",
        );

        let _ = fs::remove_dir_all(&temp_root);
    }

    #[test]
    fn legacy_config_migration_is_noop_when_config_missing() {
        let temp_root = unique_temp_dir("legacy-config-missing");
        let config_path = temp_root.join(CONFIG_FILE);
        let connection = test_connection();
        save_viewer_preferences_record(
            &connection,
            &viewer_global_scope_key(VIEWER_SOURCE_TYPE_PDF),
            None,
            VIEWER_SOURCE_TYPE_PDF,
            viewer_preferences(
                "spread",
                "left",
                "fit-height",
                "center",
                "compact",
                true,
                "default",
            ),
        )
        .expect("global preferences should save");

        migrate_legacy_config_with_connection(&config_path, &connection)
            .expect("missing config should not error");

        let global = load_saved_viewer_preferences(
            &connection,
            &viewer_global_scope_key(VIEWER_SOURCE_TYPE_PDF),
        )
        .expect("global row should load")
        .expect("global row should exist");
        // Fresh installs have no config file yet — the migration must not
        // touch the DB until a real upgrade is detected.
        assert_eq!(global.binding_direction, "left");

        let _ = fs::remove_dir_all(&temp_root);
    }

    #[test]
    fn load_viewer_preferences_payload_merges_global_and_file_records() {
        let connection = test_connection();

        save_viewer_preferences_record(
            &connection,
            &viewer_global_scope_key(VIEWER_SOURCE_TYPE_PDF),
            None,
            VIEWER_SOURCE_TYPE_PDF,
            viewer_preferences(
                "spread",
                "left",
                "fit-height",
                "center",
                "compact",
                true,
                "inherit-theme",
            ),
        )
        .expect("global preferences should save");
        save_viewer_preferences_record(
            &connection,
            &viewer_file_scope_key("/tmp/book.pdf", VIEWER_SOURCE_TYPE_PDF),
            Some("/tmp/book.pdf"),
            VIEWER_SOURCE_TYPE_PDF,
            viewer_preferences("", "right", "original", "", "", false, "night-city"),
        )
        .expect("file preferences should save");

        let payload = load_viewer_preferences_payload(
            &connection,
            Some("/tmp/book.pdf"),
            VIEWER_SOURCE_TYPE_PDF,
        )
        .expect("payload should load");

        assert_eq!(payload.global.binding_direction, "left");
        assert!(payload.uses_file_override);
        let file = payload.file.expect("file payload should exist");
        assert_eq!(file.page_mode, "spread");
        assert_eq!(file.binding_direction, "right");
        assert_eq!(file.zoom_mode, "original");
        assert_eq!(file.align_mode, "center");
        assert_eq!(file.vertical_gap_mode, "compact");
        assert!(!file.treat_first_page_as_cover);
        assert_eq!(file.background_mode, "night-city");
        assert_eq!(payload.effective.binding_direction, "right");
        assert_eq!(payload.effective.zoom_mode, "original");
        assert_eq!(payload.effective.background_mode, "night-city");
    }

    #[test]
    fn deskew_mode_round_trips_through_sqlite_and_inherits_from_global() {
        let connection = test_connection();

        let mut global = default_viewer_preferences();
        global.deskew_mode = "auto".to_string();
        save_viewer_preferences_record(
            &connection,
            &viewer_global_scope_key(VIEWER_SOURCE_TYPE_PDF),
            None,
            VIEWER_SOURCE_TYPE_PDF,
            global,
        )
        .expect("global preferences should save");
        save_viewer_preferences_record(
            &connection,
            &viewer_file_scope_key("/tmp/scan.pdf", VIEWER_SOURCE_TYPE_PDF),
            Some("/tmp/scan.pdf"),
            VIEWER_SOURCE_TYPE_PDF,
            viewer_preferences("", "right", "", "", "", true, ""),
        )
        .expect("file preferences should save");

        let payload = load_viewer_preferences_payload(
            &connection,
            Some("/tmp/scan.pdf"),
            VIEWER_SOURCE_TYPE_PDF,
        )
        .expect("payload should load");

        assert_eq!(payload.global.deskew_mode, "auto");
        assert_eq!(payload.effective.deskew_mode, "auto");

        let mut file_off = viewer_preferences("", "right", "", "", "", true, "");
        file_off.deskew_mode = "off".to_string();
        save_viewer_preferences_record(
            &connection,
            &viewer_file_scope_key("/tmp/scan.pdf", VIEWER_SOURCE_TYPE_PDF),
            Some("/tmp/scan.pdf"),
            VIEWER_SOURCE_TYPE_PDF,
            file_off,
        )
        .expect("file preferences should save");
        let payload = load_viewer_preferences_payload(
            &connection,
            Some("/tmp/scan.pdf"),
            VIEWER_SOURCE_TYPE_PDF,
        )
        .expect("payload should load");
        assert_eq!(payload.effective.deskew_mode, "off");
    }

    #[test]
    fn file_rows_saved_for_storage_keep_inheriting_later_global_changes() {
        let connection = test_connection();
        let global_scope_key = viewer_global_scope_key(VIEWER_SOURCE_TYPE_PDF);
        let file_scope_key = viewer_file_scope_key("/tmp/book.pdf", VIEWER_SOURCE_TYPE_PDF);

        let mut global = default_viewer_preferences();
        global.align_mode = "left".to_string();
        global.vertical_gap_mode = "wide".to_string();
        global.deskew_mode = "auto".to_string();
        save_viewer_preferences_record(
            &connection,
            &global_scope_key,
            None,
            VIEWER_SOURCE_TYPE_PDF,
            global.clone(),
        )
        .expect("global preferences should save");

        // The file draft starts as a copy of the effective settings and only
        // flips the binding direction; everything else must keep following the
        // global row rather than freezing at the built-in defaults.
        let mut draft = global.clone();
        draft.binding_direction = "right".to_string();
        let stored = build_file_viewer_preferences_for_storage(&global, draft);
        save_viewer_preferences_record(
            &connection,
            &file_scope_key,
            Some("/tmp/book.pdf"),
            VIEWER_SOURCE_TYPE_PDF,
            stored,
        )
        .expect("file preferences should save");

        let payload = load_viewer_preferences_payload(
            &connection,
            Some("/tmp/book.pdf"),
            VIEWER_SOURCE_TYPE_PDF,
        )
        .expect("payload should load");
        assert_eq!(payload.effective.binding_direction, "right");
        assert_eq!(payload.effective.align_mode, "left");
        assert_eq!(payload.effective.vertical_gap_mode, "wide");
        assert_eq!(payload.effective.deskew_mode, "auto");
        assert_eq!(payload.effective.epub_font_size, global.epub_font_size);

        let mut updated_global = global.clone();
        updated_global.align_mode = "right".to_string();
        updated_global.deskew_mode = "off".to_string();
        save_viewer_preferences_record(
            &connection,
            &global_scope_key,
            None,
            VIEWER_SOURCE_TYPE_PDF,
            updated_global,
        )
        .expect("global preferences should save");

        let payload = load_viewer_preferences_payload(
            &connection,
            Some("/tmp/book.pdf"),
            VIEWER_SOURCE_TYPE_PDF,
        )
        .expect("payload should load");
        assert_eq!(payload.effective.binding_direction, "right");
        assert_eq!(payload.effective.align_mode, "right");
        assert_eq!(payload.effective.deskew_mode, "off");
    }

    #[test]
    fn file_viewer_preferences_store_only_non_global_overrides() {
        let global = viewer_preferences(
            "spread",
            "left",
            "fit-height",
            "center",
            "compact",
            true,
            "inherit-theme",
        );
        let stored = build_file_viewer_preferences_for_storage(
            &global,
            normalize_viewer_preferences(viewer_preferences(
                "spread",
                "right",
                "fit-height",
                "center",
                "compact",
                false,
                "navy-blue",
            )),
        );

        assert_eq!(stored.page_mode, "");
        assert_eq!(stored.binding_direction, "right");
        assert_eq!(stored.zoom_mode, "");
        assert_eq!(stored.align_mode, "");
        assert_eq!(stored.vertical_gap_mode, "");
        assert!(!stored.treat_first_page_as_cover);
        assert_eq!(stored.background_mode, "navy-blue");
        assert_eq!(stored.epub_font_size, 0);
    }

    #[test]
    fn viewer_preferences_are_scoped_by_source_type() {
        let connection = test_connection();

        save_viewer_preferences_record(
            &connection,
            &viewer_global_scope_key(VIEWER_SOURCE_TYPE_PDF),
            None,
            VIEWER_SOURCE_TYPE_PDF,
            viewer_preferences(
                "spread",
                "left",
                "fit-height",
                "center",
                "compact",
                true,
                "default",
            ),
        )
        .expect("pdf preferences should save");
        save_viewer_preferences_record(
            &connection,
            &viewer_global_scope_key(VIEWER_SOURCE_TYPE_EPUB),
            None,
            VIEWER_SOURCE_TYPE_EPUB,
            viewer_preferences(
                "single",
                "right",
                "original",
                "left",
                "wide",
                false,
                "inherit-theme",
            ),
        )
        .expect("epub preferences should save");

        let pdf_payload = load_viewer_preferences_payload(
            &connection,
            Some("/tmp/book.pdf"),
            VIEWER_SOURCE_TYPE_PDF,
        )
        .expect("pdf payload should load");
        let epub_payload = load_viewer_preferences_payload(
            &connection,
            Some("/tmp/book.epub"),
            VIEWER_SOURCE_TYPE_EPUB,
        )
        .expect("epub payload should load");

        assert_eq!(pdf_payload.global.background_mode, "default");
        assert_eq!(epub_payload.global.background_mode, "inherit-theme");
    }

    proptest! {
        #[test]
        fn normalized_viewer_preferences_always_use_supported_values(
            preferences in arbitrary_viewer_preferences()
        ) {
            let normalized = normalize_viewer_preferences(preferences);

            prop_assert!(matches!(normalized.page_mode.as_str(), "single" | "spread"));
            prop_assert!(matches!(
                normalized.binding_direction.as_str(),
                "left" | "right" | "auto"
            ));
            prop_assert!(matches!(
                normalized.zoom_mode.as_str(),
                "fit-width" | "fit-height" | "original"
            ));
            prop_assert!(matches!(normalized.align_mode.as_str(), "left" | "center" | "right"));
            prop_assert!(matches!(
                normalized.vertical_gap_mode.as_str(),
                "wide" | "compact" | "none"
            ));
            prop_assert!(matches!(
                normalized.background_mode.as_str(),
                "inherit-theme" | "default" | "snow-white" | "night-city" | "navy-blue"
            ));
            prop_assert!(matches!(
                normalized.scroll_mode.as_str(),
                "continuous" | "paged"
            ));
            prop_assert!((50..=200).contains(&normalized.epub_font_size));
            prop_assert!(matches!(normalized.deskew_mode.as_str(), "off" | "auto"));
            prop_assert!(matches!(normalized.trim_mode.as_str(), "off" | "auto"));
        }

        #[test]
        fn normalized_page_offset_ratio_stays_in_range(value in any::<f64>()) {
            let normalized = normalize_page_offset_ratio(value);

            prop_assert!(normalized.is_finite());
            prop_assert!((0.0..=1.0).contains(&normalized));
        }

        #[test]
        fn normalized_page_offset_ratio_preserves_values_already_in_range(value in 0.0f64..=1.0f64) {
            let normalized = normalize_page_offset_ratio(value);

            prop_assert_eq!(normalized, value);
        }

        #[test]
        fn file_viewer_preferences_storage_round_trips_effective_settings(
            global in normalized_viewer_preferences_strategy(),
            effective in normalized_viewer_preferences_strategy(),
        ) {
            let stored = build_file_viewer_preferences_for_storage(&global, effective.clone());
            let merged = merge_file_viewer_preferences(&global, &stored);

            prop_assert_eq!(merged.page_mode, effective.page_mode);
            prop_assert_eq!(merged.binding_direction, effective.binding_direction);
            prop_assert_eq!(merged.zoom_mode, effective.zoom_mode);
            prop_assert_eq!(merged.align_mode, effective.align_mode);
            prop_assert_eq!(merged.vertical_gap_mode, effective.vertical_gap_mode);
            prop_assert_eq!(
                merged.treat_first_page_as_cover,
                effective.treat_first_page_as_cover
            );
            prop_assert_eq!(merged.background_mode, effective.background_mode);
            prop_assert_eq!(merged.scroll_mode, effective.scroll_mode);
            prop_assert_eq!(merged.epub_font_size, effective.epub_font_size);
            prop_assert_eq!(merged.deskew_mode, effective.deskew_mode);
            prop_assert_eq!(merged.trim_mode, effective.trim_mode);
        }

        #[test]
        fn gui_config_normalization_produces_lowercase_forward_slash_patterns(
            library_roots in prop::collection::vec(".*", 0..4),
            excluded_patterns in prop::collection::vec(".*", 0..8),
            pdf_renderer in ".*",
            theme in ".*",
        ) {
            let normalized = normalize_gui_config_input(AppConfigInput {
                library_roots,
                excluded_patterns,
                pdf_renderer,
                theme,
                enabled_external_sources: vec![],
            });

            for pattern in &normalized.excluded_patterns {
                prop_assert_eq!(pattern, &pattern.to_lowercase());
                prop_assert!(!pattern.contains('\\'));
            }
        }
    }

    #[test]
    fn normalize_binding_direction_preserves_known_values() {
        assert_eq!(normalize_binding_direction("auto"), "auto");
        assert_eq!(normalize_binding_direction("left"), "left");
        assert_eq!(normalize_binding_direction("right"), "right");
        assert_eq!(
            normalize_binding_direction("bogus"),
            DEFAULT_VIEWER_BINDING_DIRECTION
        );
    }

    #[test]
    fn viewer_scope_keys_have_expected_shape() {
        assert_eq!(viewer_file_scope_key("/a.pdf", "pdf"), "/a.pdf::pdf");
        assert_eq!(viewer_global_scope_key("epub"), "__default__:epub");
    }
}
