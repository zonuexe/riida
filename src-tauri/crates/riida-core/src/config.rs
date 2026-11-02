//! `riida.toml`: loading, normalization, saving, and version-stamp migrations.

use crate::viewer_prefs::VIEWER_DEFAULT_SCOPE_KEY;
use globset::{Glob, GlobMatcher};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

pub const CONFIG_FILE: &str = "riida.toml";
const DEFAULT_EXCLUDED_PATTERNS: &[&str] = &["**/backup/**", "*.bak.pdf"];
pub(crate) const DEFAULT_PDF_RENDERER: &str = "native";
pub(crate) const DEFAULT_THEME: &str = "default";

#[derive(Clone)]
pub struct AppConfig {
    pub library_roots: Vec<String>,
    pub excluded_patterns: Vec<String>,
    pub pdf_renderer: String,
    pub theme: String,
    pub enabled_external_sources: Vec<String>,
}

#[derive(Clone, Deserialize, Serialize)]
pub struct AppConfigFile {
    /// `riida` package version that wrote this file. Absence indicates the
    /// file was written before the version-stamped migration scheme was
    /// introduced and may need fix-up migrations applied.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    pub library_roots: Option<Vec<String>>,
    pub excluded_patterns: Option<Vec<String>>,
    #[serde(default)]
    pub excluded_dir_names: Option<Vec<String>>,
    #[serde(default)]
    pub excluded_file_suffixes: Option<Vec<String>>,
    pub pdf_renderer: Option<String>,
    #[serde(default)]
    pub enabled_external_sources: Option<Vec<String>>,
    pub theme: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppConfigInput {
    pub library_roots: Vec<String>,
    pub excluded_patterns: Vec<String>,
    pub pdf_renderer: String,
    pub theme: String,
    pub enabled_external_sources: Vec<String>,
}

pub struct CompiledExcludePatterns {
    pub matchers: Vec<GlobMatcher>,
}

pub fn collapse_home_path(path: &str) -> String {
    if let Ok(home) = std::env::var("HOME") {
        if path == home {
            return "~".to_string();
        }

        if let Some(rest) = path.strip_prefix(&(home.clone() + "/")) {
            return format!("~/{}", rest);
        }
    }

    path.to_string()
}

fn default_config() -> AppConfig {
    AppConfig {
        library_roots: Vec::new(),
        excluded_patterns: DEFAULT_EXCLUDED_PATTERNS
            .iter()
            .map(|value| value.to_string())
            .collect(),
        pdf_renderer: DEFAULT_PDF_RENDERER.to_string(),
        theme: DEFAULT_THEME.to_string(),
        enabled_external_sources: vec!["kindle".to_string()],
    }
}

fn normalize_pdf_renderer(renderer: String) -> String {
    match renderer.trim().to_lowercase().as_str() {
        "pdfjs" => "pdfjs".to_string(),
        _ => DEFAULT_PDF_RENDERER.to_string(),
    }
}

fn normalize_theme(theme: String) -> String {
    match theme.trim().to_lowercase().as_str() {
        "snow-white" => "snow-white".to_string(),
        "night-city" => "night-city".to_string(),
        "navy-blue" => "navy-blue".to_string(),
        _ => DEFAULT_THEME.to_string(),
    }
}

pub fn expand_home_path(path: &str) -> String {
    if path == "~" {
        return std::env::var("HOME").unwrap_or_else(|_| path.to_string());
    }

    if let Some(rest) = path.strip_prefix("~/") {
        if let Ok(home) = std::env::var("HOME") {
            return PathBuf::from(home)
                .join(rest)
                .to_string_lossy()
                .into_owned();
        }
    }

    path.to_string()
}

fn legacy_dir_name_to_pattern(value: &str) -> Option<String> {
    let trimmed = value.trim().to_lowercase();
    if trimmed.is_empty() {
        return None;
    }

    Some(format!("**/{trimmed}/**"))
}

fn legacy_file_suffix_to_pattern(value: &str) -> Option<String> {
    let trimmed = value.trim().to_lowercase();
    if trimmed.is_empty() {
        return None;
    }

    Some(if trimmed.ends_with(".pdf") {
        if trimmed.starts_with('*') {
            trimmed
        } else {
            format!("*{trimmed}")
        }
    } else {
        format!("*{trimmed}.pdf")
    })
}

fn normalize_excluded_patterns(
    patterns: Option<Vec<String>>,
    legacy_dir_names: Option<Vec<String>>,
    legacy_file_suffixes: Option<Vec<String>>,
    defaults: &[String],
) -> Vec<String> {
    let mut normalized = patterns
        .unwrap_or_default()
        .into_iter()
        .map(|value| value.trim().replace('\\', "/").to_lowercase())
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>();

    normalized.extend(
        legacy_dir_names
            .unwrap_or_default()
            .into_iter()
            .filter_map(|value| legacy_dir_name_to_pattern(&value)),
    );
    normalized.extend(
        legacy_file_suffixes
            .unwrap_or_default()
            .into_iter()
            .filter_map(|value| legacy_file_suffix_to_pattern(&value)),
    );

    if normalized.is_empty() {
        defaults.to_vec()
    } else {
        normalized.sort();
        normalized.dedup();
        normalized
    }
}

pub fn compile_exclude_patterns(config: &AppConfig) -> Result<CompiledExcludePatterns, String> {
    let mut matchers = Vec::new();

    for pattern in &config.excluded_patterns {
        let glob = Glob::new(pattern)
            .map_err(|error| format!("invalid excluded pattern '{pattern}': {error}"))?;
        matchers.push(glob.compile_matcher());
    }

    Ok(CompiledExcludePatterns { matchers })
}

pub fn load_config_file(config_path: &Path) -> Result<AppConfig, String> {
    if !config_path.exists() {
        return Ok(default_config());
    }

    let config_contents = fs::read_to_string(config_path).map_err(|error| error.to_string())?;
    let file_config: AppConfigFile =
        toml::from_str(&config_contents).map_err(|error| error.to_string())?;
    let defaults = default_config();

    Ok(AppConfig {
        library_roots: file_config
            .library_roots
            .unwrap_or(defaults.library_roots)
            .into_iter()
            .map(|value| expand_home_path(&value))
            .collect(),
        excluded_patterns: normalize_excluded_patterns(
            file_config.excluded_patterns,
            file_config.excluded_dir_names,
            file_config.excluded_file_suffixes,
            &defaults.excluded_patterns,
        ),
        pdf_renderer: normalize_pdf_renderer(
            file_config.pdf_renderer.unwrap_or(defaults.pdf_renderer),
        ),
        theme: normalize_theme(file_config.theme.unwrap_or(defaults.theme)),
        enabled_external_sources: file_config
            .enabled_external_sources
            .unwrap_or(defaults.enabled_external_sources),
    })
}

pub fn migrate_legacy_config_with_connection(
    config_path: &Path,
    connection: &Connection,
) -> Result<(), String> {
    if !config_path.exists() {
        return Ok(());
    }
    let contents = fs::read_to_string(config_path).map_err(|error| error.to_string())?;
    let file_config: AppConfigFile =
        toml::from_str(&contents).map_err(|error| error.to_string())?;
    if file_config.version.is_some() {
        return Ok(());
    }

    apply_pre_version_migrations(connection)?;

    let stamped = AppConfigFile {
        version: Some(env!("CARGO_PKG_VERSION").to_string()),
        ..file_config
    };
    let serialized = toml::to_string_pretty(&stamped).map_err(|error| error.to_string())?;
    fs::write(config_path, serialized).map_err(|error| error.to_string())
}

/// Migrations to apply once when an unversioned config is detected:
/// flip global viewer preferences whose `binding_direction` is the legacy
/// default `"left"` to the new `"auto"`. File-level rows are explicit
/// user choices and stay untouched.
pub(crate) fn apply_pre_version_migrations(connection: &Connection) -> Result<(), String> {
    connection
        .execute(
            "UPDATE viewer_preferences SET binding_direction = 'auto' \
             WHERE binding_direction = 'left' AND scope_key LIKE ?1",
            params![format!("{VIEWER_DEFAULT_SCOPE_KEY}:%")],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

pub fn normalize_config_input(config: AppConfigFile) -> AppConfig {
    let defaults = default_config();

    AppConfig {
        library_roots: config
            .library_roots
            .unwrap_or(defaults.library_roots)
            .into_iter()
            .map(|value| expand_home_path(value.trim()))
            .filter(|value| !value.trim().is_empty())
            .collect(),
        excluded_patterns: normalize_excluded_patterns(
            config.excluded_patterns,
            config.excluded_dir_names,
            config.excluded_file_suffixes,
            &defaults.excluded_patterns,
        ),
        pdf_renderer: normalize_pdf_renderer(config.pdf_renderer.unwrap_or(defaults.pdf_renderer)),
        theme: normalize_theme(config.theme.unwrap_or(defaults.theme)),
        enabled_external_sources: config
            .enabled_external_sources
            .unwrap_or(defaults.enabled_external_sources),
    }
}

pub fn normalize_gui_config_input(config: AppConfigInput) -> AppConfig {
    normalize_config_input(AppConfigFile {
        version: None,
        library_roots: Some(config.library_roots),
        excluded_patterns: Some(config.excluded_patterns),
        excluded_dir_names: None,
        excluded_file_suffixes: None,
        pdf_renderer: Some(config.pdf_renderer),
        theme: Some(config.theme),
        enabled_external_sources: Some(config.enabled_external_sources),
    })
}

/// Write `input` to `config_path`, stamped with the current version.
/// `CARGO_PKG_VERSION` here is riida-core's, which the workspace keeps equal
/// to the app's.
pub fn save_config_input_file_at(config_path: &Path, input: &AppConfigInput) -> Result<(), String> {
    let payload = AppConfigFile {
        version: Some(env!("CARGO_PKG_VERSION").to_string()),
        library_roots: Some(
            input
                .library_roots
                .iter()
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
                .collect(),
        ),
        excluded_patterns: Some(
            input
                .excluded_patterns
                .iter()
                .map(|value| value.trim().replace('\\', "/").to_lowercase())
                .filter(|value| !value.is_empty())
                .collect(),
        ),
        excluded_dir_names: None,
        excluded_file_suffixes: None,
        pdf_renderer: Some(normalize_pdf_renderer(input.pdf_renderer.clone())),
        theme: Some(normalize_theme(input.theme.clone())),
        enabled_external_sources: Some(input.enabled_external_sources.clone()),
    };
    let serialized = toml::to_string_pretty(&payload).map_err(|error| error.to_string())?;
    fs::write(config_path, serialized).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{test_config, test_connection, unique_temp_dir, viewer_preferences};
    use crate::viewer_prefs::{
        load_saved_viewer_preferences, save_viewer_preferences_record, viewer_file_scope_key,
        viewer_global_scope_key,
    };
    use std::fs;
    use std::path::PathBuf;

    #[test]
    fn apply_pre_version_migrations_flips_only_global_left_binding() {
        let connection = test_connection();
        // Global pdf prefs carrying the legacy default "left" binding.
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
        // Global epub prefs with an explicit "right" binding (not the legacy default).
        save_viewer_preferences_record(
            &connection,
            &viewer_global_scope_key("epub"),
            None,
            "epub",
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
        .expect("global epub prefs should save");
        // File-scoped prefs with a "left" binding — a deliberate per-file choice.
        let file_scope = viewer_file_scope_key("/book.pdf", "pdf");
        save_viewer_preferences_record(
            &connection,
            &file_scope,
            Some("/book.pdf"),
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
        .expect("file prefs should save");

        apply_pre_version_migrations(&connection).expect("migration should apply");

        let global_pdf =
            load_saved_viewer_preferences(&connection, &viewer_global_scope_key("pdf"))
                .expect("global pdf load")
                .expect("global pdf row exists");
        assert_eq!(
            global_pdf.binding_direction, "auto",
            "global legacy-left binding should flip to auto"
        );

        let global_epub =
            load_saved_viewer_preferences(&connection, &viewer_global_scope_key("epub"))
                .expect("global epub load")
                .expect("global epub row exists");
        assert_eq!(
            global_epub.binding_direction, "right",
            "non-left global binding should be untouched"
        );

        let file = load_saved_viewer_preferences(&connection, &file_scope)
            .expect("file load")
            .expect("file row exists");
        assert_eq!(
            file.binding_direction, "left",
            "explicit per-file binding should be untouched"
        );
    }

    #[test]
    fn migrate_legacy_config_is_noop_when_file_missing() {
        let connection = test_connection();
        let dir = unique_temp_dir("missing-config");
        let config_path = dir.join("riida.toml"); // intentionally never created
        migrate_legacy_config_with_connection(&config_path, &connection)
            .expect("a missing config file should be a no-op");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn normalize_excluded_patterns_merges_legacy_entries() {
        let defaults = vec!["**/backup/**".to_string(), "*.bak.pdf".to_string()];

        let normalized = normalize_excluded_patterns(
            Some(vec!["prefix_*".to_string()]),
            Some(vec!["backup".to_string()]),
            Some(vec![".bak".to_string()]),
            &defaults,
        );

        assert_eq!(
            normalized,
            vec![
                "**/backup/**".to_string(),
                "*.bak.pdf".to_string(),
                "prefix_*".to_string(),
            ]
        );
    }

    #[test]
    fn normalize_excluded_patterns_falls_back_to_defaults() {
        let defaults = vec!["**/backup/**".to_string(), "*.bak.pdf".to_string()];

        let normalized = normalize_excluded_patterns(None, None, None, &defaults);

        assert_eq!(normalized, defaults);
    }

    #[test]
    fn invalid_excluded_pattern_is_rejected() {
        let error = compile_exclude_patterns(&test_config(&["["]))
            .err()
            .expect("invalid glob should fail to compile");

        assert!(error.contains("invalid excluded pattern"));
    }

    #[test]
    fn normalize_config_input_expands_home_and_normalizes_patterns() {
        let home = std::env::var("HOME").expect("HOME should exist for tests");
        let config = normalize_config_input(AppConfigFile {
            version: None,
            library_roots: Some(vec!["~/Books".to_string(), "  ".to_string()]),
            excluded_patterns: Some(vec!["Prefix_*".to_string(), r"**\BACKUP\**".to_string()]),
            excluded_dir_names: None,
            excluded_file_suffixes: None,
            pdf_renderer: Some("PDFJS".to_string()),
            theme: Some("night-city".to_string()),
            enabled_external_sources: None,
        });

        let expected_root = PathBuf::from(&home)
            .join("Books")
            .to_string_lossy()
            .into_owned();
        assert_eq!(config.library_roots, vec![expected_root]);
        assert_eq!(
            config.excluded_patterns,
            vec!["**/backup/**".to_string(), "prefix_*".to_string()]
        );
        assert_eq!(config.pdf_renderer, "pdfjs");
        assert_eq!(config.theme, "night-city");
    }

    #[test]
    fn normalize_gui_config_input_preserves_new_glob_format() {
        let config = normalize_gui_config_input(AppConfigInput {
            library_roots: vec!["~/Library".to_string()],
            excluded_patterns: vec!["*.BAK".to_string(), "prefix_*".to_string()],
            pdf_renderer: "native".to_string(),
            theme: "navy-blue".to_string(),
            enabled_external_sources: vec![],
        });

        assert_eq!(
            config.excluded_patterns,
            vec!["*.bak".to_string(), "prefix_*".to_string()]
        );
        assert_eq!(config.pdf_renderer, "native");
        assert_eq!(config.theme, "navy-blue");
    }

    #[test]
    fn load_config_file_reads_present_and_defaults_when_missing() {
        let dir = unique_temp_dir("load-config");

        let present = dir.join("riida.toml");
        fs::write(
            &present,
            "library_roots = [\"/books\"]\npdf_renderer = \"native\"\n",
        )
        .unwrap();
        let loaded = load_config_file(&present).expect("present config should load");
        assert_eq!(loaded.pdf_renderer, "native"); // not the "pdfjs" default
        assert_eq!(loaded.library_roots, vec!["/books".to_string()]);

        let defaulted =
            load_config_file(&dir.join("absent.toml")).expect("missing config should default");
        assert_eq!(defaulted.pdf_renderer, DEFAULT_PDF_RENDERER);

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn save_config_input_file_at_stamps_version_and_normalizes_fields() {
        let dir = unique_temp_dir("save-config");
        let config_path = dir.join("riida.toml");

        save_config_input_file_at(
            &config_path,
            &AppConfigInput {
                library_roots: vec!["  ~/Books  ".to_string(), " ".to_string()],
                excluded_patterns: vec![r" **\BACKUP\** ".to_string(), "".to_string()],
                pdf_renderer: "PDFJS".to_string(),
                theme: "unknown-theme".to_string(),
                enabled_external_sources: vec!["kindle".to_string()],
            },
        )
        .expect("config should save");

        let contents = fs::read_to_string(&config_path).expect("saved config should exist");
        let saved: AppConfigFile = toml::from_str(&contents).expect("saved config should parse");
        assert_eq!(saved.version.as_deref(), Some(env!("CARGO_PKG_VERSION")));
        assert_eq!(saved.library_roots, Some(vec!["~/Books".to_string()]));
        assert_eq!(
            saved.excluded_patterns,
            Some(vec!["**/backup/**".to_string()])
        );
        assert_eq!(saved.pdf_renderer.as_deref(), Some("pdfjs"));
        assert_eq!(saved.theme.as_deref(), Some(DEFAULT_THEME));
        assert_eq!(
            saved.enabled_external_sources,
            Some(vec!["kindle".to_string()])
        );

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn normalize_theme_preserves_known_themes() {
        assert_eq!(normalize_theme("snow-white".to_string()), "snow-white");
        assert_eq!(normalize_theme("night-city".to_string()), "night-city");
        assert_eq!(normalize_theme("navy-blue".to_string()), "navy-blue");
        assert_eq!(normalize_theme("bogus".to_string()), DEFAULT_THEME);
    }
}
