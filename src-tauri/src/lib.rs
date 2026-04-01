use directories::ProjectDirs;
use globset::{Glob, GlobMatcher};
use notify::{Config, Event, RecommendedWatcher, RecursiveMode, Watcher};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::{
    collections::{hash_map::DefaultHasher, HashSet},
    fs,
    hash::{Hash, Hasher},
    path::{Path, PathBuf},
    process::Command,
    sync::{mpsc, Arc, Mutex, OnceLock},
    thread,
    time::{Duration, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Manager, State};
use walkdir::WalkDir;

const CONFIG_FILE: &str = "riida.toml";
const DEFAULT_EXCLUDED_PATTERNS: &[&str] = &["**/backup/**", "*.bak"];
const DEFAULT_PDF_RENDERER: &str = "native";
const VIEWER_DEFAULT_SCOPE_KEY: &str = "__default__";
const DEFAULT_VIEWER_PAGE_MODE: &str = "spread";
const DEFAULT_VIEWER_BINDING_DIRECTION: &str = "left";
const DEFAULT_VIEWER_ZOOM_MODE: &str = "fit-height";
const DEFAULT_VIEWER_ALIGN_MODE: &str = "center";
const DEFAULT_VIEWER_VERTICAL_GAP_MODE: &str = "compact";
const DEFAULT_VIEWER_TREAT_FIRST_PAGE_AS_COVER: bool = true;

static APP_PATHS: OnceLock<AppPaths> = OnceLock::new();

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BookSummary {
    file_name: String,
    file_path: String,
    file_size: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LibrarySnapshot {
    library_roots: Vec<String>,
    indexed_count: usize,
    books: Vec<BookSummary>,
    excluded_patterns: Vec<String>,
    pdf_renderer: String,
}

#[derive(Clone)]
struct AppConfig {
    library_roots: Vec<String>,
    excluded_patterns: Vec<String>,
    pdf_renderer: String,
}

#[derive(Clone, Deserialize, Serialize)]
struct AppConfigFile {
    library_roots: Option<Vec<String>>,
    excluded_patterns: Option<Vec<String>>,
    #[serde(default)]
    excluded_dir_names: Option<Vec<String>>,
    #[serde(default)]
    excluded_file_suffixes: Option<Vec<String>>,
    pdf_renderer: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AppConfigInput {
    library_roots: Vec<String>,
    excluded_patterns: Vec<String>,
    pdf_renderer: String,
}

struct ConfigState {
    config: Mutex<AppConfig>,
}

struct ThumbnailQueue {
    sender: mpsc::Sender<String>,
    pending: Arc<Mutex<HashSet<String>>>,
}

#[derive(Clone)]
struct AppPaths {
    config_file: PathBuf,
    data_dir: PathBuf,
    database_file: PathBuf,
    cache_dir: PathBuf,
    thumbnail_root: PathBuf,
    legacy_config_file: PathBuf,
    legacy_database_file: PathBuf,
    legacy_thumbnail_root: PathBuf,
}

struct CompiledExcludePatterns {
    matchers: Vec<GlobMatcher>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NoteDocument {
    file_path: String,
    format: String,
    content: String,
    updated_at: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ReadingPosition {
    file_path: String,
    page_number: u32,
    page_offset_ratio: f64,
    updated_at: Option<u64>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ViewerPreferences {
    page_mode: String,
    binding_direction: String,
    zoom_mode: String,
    align_mode: String,
    vertical_gap_mode: String,
    treat_first_page_as_cover: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ViewerPreferencesPayload {
    global: ViewerPreferences,
    file: Option<ViewerPreferences>,
    effective: ViewerPreferences,
    uses_file_override: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ThumbnailReadyEvent {
    file_path: String,
    thumbnail_path: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AppConfigPayload {
    config_path: String,
    library_roots: Vec<String>,
    excluded_patterns: Vec<String>,
    pdf_renderer: String,
}

fn collapse_home_path(path: &str) -> String {
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

fn database_file() -> Result<PathBuf, String> {
    Ok(app_paths()?.database_file.clone())
}

fn project_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")))
}

fn config_file() -> PathBuf {
    app_paths()
        .map(|paths| paths.config_file.clone())
        .unwrap_or_else(|_| project_root().join(CONFIG_FILE))
}

fn thumbnail_root() -> PathBuf {
    app_paths()
        .map(|paths| paths.thumbnail_root.clone())
        .unwrap_or_else(|_| project_root().join("data").join("thumbnails"))
}

fn resolve_app_paths() -> Result<AppPaths, String> {
    let project_dirs = ProjectDirs::from("com", "megurine", "riida")
        .ok_or_else(|| "failed to resolve app directories".to_string())?;
    let project_root = project_root();
    let data_dir = project_dirs.data_dir().to_path_buf();
    let cache_dir = project_dirs.cache_dir().to_path_buf();
    let config_file = std::env::var_os("HOME")
        .map(PathBuf::from)
        .map(|home| home.join(".config"))
        .filter(|xdg_dir| xdg_dir.exists())
        .map(|xdg_dir| xdg_dir.join("riida").join(CONFIG_FILE))
        .unwrap_or_else(|| project_dirs.config_dir().join(CONFIG_FILE));

    Ok(AppPaths {
        config_file,
        database_file: data_dir.join("app.db"),
        thumbnail_root: cache_dir.join("thumbnails"),
        data_dir,
        cache_dir,
        legacy_config_file: project_root.join(CONFIG_FILE),
        legacy_database_file: project_root.join("data").join("app.db"),
        legacy_thumbnail_root: project_root.join("data").join("thumbnails"),
    })
}

fn app_paths() -> Result<&'static AppPaths, String> {
    APP_PATHS
        .get()
        .ok_or_else(|| "application paths have not been initialized".to_string())
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

fn prepare_storage(paths: &AppPaths) -> Result<(), String> {
    let config_dir = paths
        .config_file
        .parent()
        .ok_or_else(|| "failed to resolve config directory".to_string())?;

    fs::create_dir_all(config_dir).map_err(|error| error.to_string())?;
    fs::create_dir_all(&paths.data_dir).map_err(|error| error.to_string())?;
    fs::create_dir_all(&paths.cache_dir).map_err(|error| error.to_string())?;

    if !paths.config_file.exists() && paths.legacy_config_file.exists() {
        fs::copy(&paths.legacy_config_file, &paths.config_file)
            .map_err(|error| error.to_string())?;
    }

    if !paths.database_file.exists() && paths.legacy_database_file.exists() {
        fs::copy(&paths.legacy_database_file, &paths.database_file)
            .map_err(|error| error.to_string())?;
    }

    migrate_directory_contents(&paths.legacy_thumbnail_root, &paths.thumbnail_root)?;

    Ok(())
}

fn default_config() -> AppConfig {
    AppConfig {
        library_roots: Vec::new(),
        excluded_patterns: DEFAULT_EXCLUDED_PATTERNS
            .iter()
            .map(|value| value.to_string())
            .collect(),
        pdf_renderer: DEFAULT_PDF_RENDERER.to_string(),
    }
}

fn normalize_pdf_renderer(renderer: String) -> String {
    match renderer.trim().to_lowercase().as_str() {
        "pdfjs" => "pdfjs".to_string(),
        _ => DEFAULT_PDF_RENDERER.to_string(),
    }
}

fn expand_home_path(path: &str) -> String {
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

    Some(if trimmed.starts_with('*') {
        trimmed
    } else {
        format!("*{trimmed}")
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

fn compile_exclude_patterns(config: &AppConfig) -> Result<CompiledExcludePatterns, String> {
    let mut matchers = Vec::new();

    for pattern in &config.excluded_patterns {
        let glob = Glob::new(pattern)
            .map_err(|error| format!("invalid excluded pattern '{pattern}': {error}"))?;
        matchers.push(glob.compile_matcher());
    }

    Ok(CompiledExcludePatterns { matchers })
}

fn load_config() -> Result<AppConfig, String> {
    let config_path = config_file();

    if !config_path.exists() {
        return Ok(default_config());
    }

    let config_contents = fs::read_to_string(&config_path).map_err(|error| error.to_string())?;
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
    })
}

fn lock_config<'a>(
    config_state: &'a State<'a, ConfigState>,
) -> Result<std::sync::MutexGuard<'a, AppConfig>, String> {
    config_state
        .config
        .lock()
        .map_err(|_| "failed to lock app config".to_string())
}

fn app_config_to_payload(config: &AppConfig) -> AppConfigPayload {
    AppConfigPayload {
        config_path: config_file().to_string_lossy().into_owned(),
        library_roots: config
            .library_roots
            .iter()
            .map(|value| collapse_home_path(value))
            .collect(),
        excluded_patterns: config.excluded_patterns.clone(),
        pdf_renderer: config.pdf_renderer.clone(),
    }
}

fn normalize_config_input(config: AppConfigFile) -> AppConfig {
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
    }
}

fn normalize_gui_config_input(config: AppConfigInput) -> AppConfig {
    normalize_config_input(AppConfigFile {
        library_roots: Some(config.library_roots),
        excluded_patterns: Some(config.excluded_patterns),
        excluded_dir_names: None,
        excluded_file_suffixes: None,
        pdf_renderer: Some(config.pdf_renderer),
    })
}

fn save_config_input_file(input: &AppConfigInput) -> Result<(), String> {
    let payload = AppConfigFile {
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
    };
    let serialized = toml::to_string_pretty(&payload).map_err(|error| error.to_string())?;
    fs::write(config_file(), serialized).map_err(|error| error.to_string())
}

fn open_database() -> Result<Connection, String> {
    let database_file = database_file()?;

    if let Some(parent) = database_file.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }

    let connection = Connection::open(database_file).map_err(|error| error.to_string())?;

    connection
        .execute_batch(
            "
            CREATE TABLE IF NOT EXISTS books (
              id INTEGER PRIMARY KEY,
              file_path TEXT NOT NULL UNIQUE,
              file_name TEXT NOT NULL,
              file_size INTEGER NOT NULL,
              modified_at INTEGER NOT NULL,
              indexed_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS notes (
              id INTEGER PRIMARY KEY,
              file_path TEXT NOT NULL UNIQUE,
              format TEXT NOT NULL,
              content TEXT NOT NULL,
              updated_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS viewer_preferences (
              scope_key TEXT PRIMARY KEY,
              file_path TEXT UNIQUE,
              page_mode TEXT NOT NULL,
              binding_direction TEXT NOT NULL,
              zoom_mode TEXT NOT NULL,
              align_mode TEXT NOT NULL,
              vertical_gap_mode TEXT NOT NULL,
              treat_first_page_as_cover INTEGER NOT NULL,
              updated_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS reading_positions (
              file_path TEXT PRIMARY KEY,
              page_number INTEGER NOT NULL,
              page_offset_ratio REAL NOT NULL,
              updated_at INTEGER NOT NULL
            );
            ",
        )
        .map_err(|error| error.to_string())?;

    Ok(connection)
}

fn is_pdf_file(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.eq_ignore_ascii_case("pdf"))
        .unwrap_or(false)
}

fn normalized_path_for_glob(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/").to_lowercase()
}

fn matches_excluded_pattern(path: &Path, compiled: &CompiledExcludePatterns) -> bool {
    let full_path = normalized_path_for_glob(path);
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .map(|name| name.to_lowercase())
        .unwrap_or_default();
    let directory_probe = if path.is_dir() {
        Some(format!("{full_path}/__riida__"))
    } else {
        None
    };

    compiled.matchers.iter().any(|matcher| {
        matcher.is_match(&full_path)
            || (!file_name.is_empty() && matcher.is_match(&file_name))
            || directory_probe
                .as_ref()
                .map(|probe| matcher.is_match(probe))
                .unwrap_or(false)
    })
}

fn should_include_pdf(path: &Path, compiled: &CompiledExcludePatterns) -> bool {
    is_pdf_file(path) && !matches_excluded_pattern(path, compiled)
}

fn modified_unix_seconds(metadata: &fs::Metadata) -> u64 {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

fn default_viewer_preferences() -> ViewerPreferences {
    ViewerPreferences {
        page_mode: DEFAULT_VIEWER_PAGE_MODE.to_string(),
        binding_direction: DEFAULT_VIEWER_BINDING_DIRECTION.to_string(),
        zoom_mode: DEFAULT_VIEWER_ZOOM_MODE.to_string(),
        align_mode: DEFAULT_VIEWER_ALIGN_MODE.to_string(),
        vertical_gap_mode: DEFAULT_VIEWER_VERTICAL_GAP_MODE.to_string(),
        treat_first_page_as_cover: DEFAULT_VIEWER_TREAT_FIRST_PAGE_AS_COVER,
    }
}

fn normalize_page_mode(value: &str) -> String {
    match value.trim().to_lowercase().as_str() {
        "single" => "single".to_string(),
        _ => DEFAULT_VIEWER_PAGE_MODE.to_string(),
    }
}

fn normalize_binding_direction(value: &str) -> String {
    match value.trim().to_lowercase().as_str() {
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

fn normalize_viewer_preferences(preferences: ViewerPreferences) -> ViewerPreferences {
    ViewerPreferences {
        page_mode: normalize_page_mode(&preferences.page_mode),
        binding_direction: normalize_binding_direction(&preferences.binding_direction),
        zoom_mode: normalize_zoom_mode(&preferences.zoom_mode),
        align_mode: normalize_align_mode(&preferences.align_mode),
        vertical_gap_mode: normalize_vertical_gap_mode(&preferences.vertical_gap_mode),
        treat_first_page_as_cover: preferences.treat_first_page_as_cover,
    }
}

fn load_saved_viewer_preferences(
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
              treat_first_page_as_cover
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
    }
}

fn build_file_viewer_preferences_for_storage(
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
    }
}

fn save_viewer_preferences_record(
    connection: &Connection,
    scope_key: &str,
    file_path: Option<&str>,
    preferences: ViewerPreferences,
) -> Result<ViewerPreferences, String> {
    let normalized = normalize_viewer_preferences(preferences);
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
              page_mode,
              binding_direction,
              zoom_mode,
              align_mode,
              vertical_gap_mode,
              treat_first_page_as_cover,
              updated_at
            )
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
            ON CONFLICT(scope_key) DO UPDATE SET
              file_path = excluded.file_path,
              page_mode = excluded.page_mode,
              binding_direction = excluded.binding_direction,
              zoom_mode = excluded.zoom_mode,
              align_mode = excluded.align_mode,
              vertical_gap_mode = excluded.vertical_gap_mode,
              treat_first_page_as_cover = excluded.treat_first_page_as_cover,
              updated_at = excluded.updated_at
            ",
            params![
                scope_key,
                file_path,
                normalized.page_mode,
                normalized.binding_direction,
                normalized.zoom_mode,
                normalized.align_mode,
                normalized.vertical_gap_mode,
                if normalized.treat_first_page_as_cover {
                    1
                } else {
                    0
                },
                updated_at
            ],
        )
        .map_err(|error| error.to_string())?;

    Ok(normalized)
}

fn load_viewer_preferences_payload(
    connection: &Connection,
    file_path: Option<&str>,
) -> Result<ViewerPreferencesPayload, String> {
    let global = load_saved_viewer_preferences(connection, VIEWER_DEFAULT_SCOPE_KEY)?
        .map(normalize_viewer_preferences)
        .unwrap_or_else(default_viewer_preferences);
    let file_raw = if let Some(file_path) = file_path {
        load_saved_viewer_preferences(connection, file_path)?
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

fn scan_and_index(
    connection: &Connection,
    config: &AppConfig,
    excluded_patterns: &CompiledExcludePatterns,
) -> Result<(), String> {
    let now = std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_secs();

    for root in &config.library_roots {
        for entry in WalkDir::new(root)
            .into_iter()
            .filter_map(Result::ok)
            .filter(|entry| {
                entry.file_type().is_file() && should_include_pdf(entry.path(), excluded_patterns)
            })
        {
            let path = entry.path();
            let metadata = fs::metadata(path).map_err(|error| error.to_string())?;
            let file_size = metadata.len();

            if file_size == 0 {
                continue;
            }

            let file_path = path.to_string_lossy().into_owned();
            let file_name = path
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("unknown.pdf")
                .to_string();
            let modified_at = modified_unix_seconds(&metadata);

            connection
                .execute(
                    "
                    INSERT INTO books (file_path, file_name, file_size, modified_at, indexed_at)
                    VALUES (?1, ?2, ?3, ?4, ?5)
                    ON CONFLICT(file_path) DO UPDATE SET
                      file_name = excluded.file_name,
                      file_size = excluded.file_size,
                      modified_at = excluded.modified_at,
                      indexed_at = excluded.indexed_at
                    ",
                    params![file_path, file_name, file_size, modified_at, now],
                )
                .map_err(|error| error.to_string())?;
        }
    }

    connection
        .execute("DELETE FROM books WHERE indexed_at < ?1", params![now])
        .map_err(|error| error.to_string())?;

    Ok(())
}

fn load_snapshot(connection: &Connection, config: &AppConfig) -> Result<LibrarySnapshot, String> {
    let indexed_count: usize = connection
        .query_row("SELECT COUNT(*) FROM books", [], |row| row.get(0))
        .map_err(|error| error.to_string())?;

    let mut statement = connection
        .prepare(
            "
            SELECT
              file_name,
              file_path,
              file_size
            FROM books
            ORDER BY books.modified_at DESC, books.file_name ASC
            ",
        )
        .map_err(|error| error.to_string())?;

    let books = statement
        .query_map([], |row| {
            Ok(BookSummary {
                file_name: row.get(0)?,
                file_path: row.get(1)?,
                file_size: row.get(2)?,
            })
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;

    Ok(LibrarySnapshot {
        library_roots: config.library_roots.clone(),
        indexed_count,
        books,
        excluded_patterns: config.excluded_patterns.clone(),
        pdf_renderer: config.pdf_renderer.clone(),
    })
}

fn refresh_library_snapshot(config: &AppConfig) -> Result<LibrarySnapshot, String> {
    if let Some(missing_root) = config
        .library_roots
        .iter()
        .find(|root| !Path::new(root).exists())
    {
        return Err(format!("library root does not exist: {missing_root}"));
    }

    let connection = open_database()?;
    let excluded_patterns = compile_exclude_patterns(config)?;
    scan_and_index(&connection, config, &excluded_patterns)?;
    load_snapshot(&connection, config)
}

fn thumbnail_cache_dir(file_path: &str) -> PathBuf {
    let mut hasher = DefaultHasher::new();
    file_path.hash(&mut hasher);
    thumbnail_root().join(format!("{:016x}", hasher.finish()))
}

fn thumbnail_output_file(file_path: &str) -> PathBuf {
    thumbnail_cache_dir(file_path).join("thumbnail.jpg")
}

fn is_thumbnail_fresh(pdf_path: &Path, thumbnail_path: &Path) -> bool {
    let pdf_modified = fs::metadata(pdf_path).and_then(|metadata| metadata.modified());
    let thumb_modified = fs::metadata(thumbnail_path).and_then(|metadata| metadata.modified());

    match (pdf_modified, thumb_modified) {
        (Ok(pdf_modified), Ok(thumb_modified)) => thumb_modified >= pdf_modified,
        _ => false,
    }
}

fn generate_thumbnail(file_path: &Path, output_dir: &Path) -> Result<PathBuf, String> {
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

fn start_thumbnail_worker(app: AppHandle) -> ThumbnailQueue {
    let (tx, rx) = mpsc::channel::<String>();
    let pending = Arc::new(Mutex::new(HashSet::<String>::new()));
    let pending_for_worker = Arc::clone(&pending);

    thread::spawn(move || {
        while let Ok(file_path) = rx.recv() {
            let pdf_path = PathBuf::from(&file_path);
            let output_dir = thumbnail_cache_dir(&file_path);
            let result = generate_thumbnail(&pdf_path, &output_dir);

            if let Ok(thumbnail_path) = result {
                let _ = app.emit(
                    "thumbnail-ready",
                    ThumbnailReadyEvent {
                        file_path: file_path.clone(),
                        thumbnail_path: thumbnail_path.to_string_lossy().into_owned(),
                    },
                );
            }

            if let Ok(mut pending) = pending_for_worker.lock() {
                pending.remove(&file_path);
            }
        }
    });

    ThumbnailQueue {
        sender: tx,
        pending,
    }
}

fn should_rescan(event: &Event, excluded_patterns: &CompiledExcludePatterns) -> bool {
    event.paths.iter().any(|path| {
        (path.is_dir() && !matches_excluded_pattern(path, excluded_patterns))
            || should_include_pdf(path, excluded_patterns)
    })
}

fn emit_library_snapshot(app: &AppHandle, config: &AppConfig) -> Result<(), String> {
    let snapshot = refresh_library_snapshot(config)?;

    app.emit("library-updated", &snapshot)
        .map_err(|error| error.to_string())
}

fn start_library_watcher(app: AppHandle, config: AppConfig) -> Result<(), String> {
    if config
        .library_roots
        .iter()
        .all(|root| !Path::new(root).exists())
    {
        return Ok(());
    }

    let (tx, rx) = mpsc::channel::<notify::Result<Event>>();

    thread::spawn(move || {
        let excluded_patterns = match compile_exclude_patterns(&config) {
            Ok(patterns) => patterns,
            Err(error) => {
                let _ = app.emit("library-watch-error", error);
                return;
            }
        };
        let mut watcher = match RecommendedWatcher::new(
            move |result| {
                let _ = tx.send(result);
            },
            Config::default(),
        ) {
            Ok(watcher) => watcher,
            Err(error) => {
                let _ = app.emit("library-watch-error", error.to_string());
                return;
            }
        };

        for root in &config.library_roots {
            if !Path::new(root).exists() {
                continue;
            }

            if let Err(error) = watcher.watch(Path::new(root), RecursiveMode::Recursive) {
                let _ = app.emit("library-watch-error", error.to_string());
                return;
            }
        }

        while let Ok(result) = rx.recv() {
            match result {
                Ok(event) if should_rescan(&event, &excluded_patterns) => {
                    thread::sleep(Duration::from_millis(250));

                    while rx.try_recv().is_ok() {}

                    if let Err(error) = emit_library_snapshot(&app, &config) {
                        let _ = app.emit("library-watch-error", error);
                    }
                }
                Ok(_) => {}
                Err(error) => {
                    let _ = app.emit("library-watch-error", error.to_string());
                }
            }
        }
    });

    Ok(())
}

#[tauri::command]
fn library_snapshot(config_state: State<'_, ConfigState>) -> Result<LibrarySnapshot, String> {
    let config = lock_config(&config_state)?.clone();
    refresh_library_snapshot(&config)
}

#[tauri::command]
fn book_thumbnail(
    file_path: String,
    queue: State<'_, ThumbnailQueue>,
    config_state: State<'_, ConfigState>,
) -> Result<Option<String>, String> {
    let pdf_path = PathBuf::from(&file_path);
    let config = lock_config(&config_state)?.clone();
    let excluded_patterns = compile_exclude_patterns(&config)?;

    if !pdf_path.exists() || !should_include_pdf(&pdf_path, &excluded_patterns) {
        return Ok(None);
    }

    let thumbnail_path = thumbnail_output_file(&file_path);

    if thumbnail_path.exists() && is_thumbnail_fresh(&pdf_path, &thumbnail_path) {
        return Ok(Some(thumbnail_path.to_string_lossy().into_owned()));
    }

    let mut pending = queue
        .pending
        .lock()
        .map_err(|_| "failed to lock thumbnail queue".to_string())?;

    if pending.insert(file_path.clone()) {
        queue
            .sender
            .send(file_path)
            .map_err(|error| error.to_string())?;
    }

    Ok(None)
}

#[tauri::command]
fn load_app_config(config_state: State<'_, ConfigState>) -> Result<AppConfigPayload, String> {
    let config = lock_config(&config_state)?.clone();
    Ok(app_config_to_payload(&config))
}

#[tauri::command]
fn save_app_config(
    app: AppHandle,
    config_state: State<'_, ConfigState>,
    input: AppConfigInput,
) -> Result<AppConfigPayload, String> {
    let next_config = normalize_gui_config_input(input);

    if next_config.library_roots.is_empty() {
        return Err("at least one library root is required".to_string());
    }

    save_config_input_file(&AppConfigInput {
        library_roots: next_config
            .library_roots
            .iter()
            .map(|value| collapse_home_path(value))
            .collect(),
        excluded_patterns: next_config.excluded_patterns.clone(),
        pdf_renderer: next_config.pdf_renderer.clone(),
    })?;

    {
        let mut config = lock_config(&config_state)?;
        *config = next_config.clone();
    }

    emit_library_snapshot(&app, &next_config)?;
    Ok(app_config_to_payload(&next_config))
}

#[tauri::command]
fn load_note(file_path: String) -> Result<NoteDocument, String> {
    let connection = open_database()?;
    let mut statement = connection
        .prepare(
            "
            SELECT
              format,
              content,
              updated_at
            FROM notes
            WHERE file_path = ?1
            ",
        )
        .map_err(|error| error.to_string())?;

    let note = statement.query_row(params![&file_path], |row| {
        Ok(NoteDocument {
            file_path: file_path.clone(),
            format: row.get(0)?,
            content: row.get(1)?,
            updated_at: Some(row.get(2)?),
        })
    });

    match note {
        Ok(note) => Ok(note),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(NoteDocument {
            file_path,
            format: "markdown".to_string(),
            content: String::new(),
            updated_at: None,
        }),
        Err(error) => Err(error.to_string()),
    }
}

#[tauri::command]
fn save_note(file_path: String, content: String) -> Result<NoteDocument, String> {
    let connection = open_database()?;
    let updated_at = std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_secs();

    connection
        .execute(
            "
            INSERT INTO notes (file_path, format, content, updated_at)
            VALUES (?1, ?2, ?3, ?4)
            ON CONFLICT(file_path) DO UPDATE SET
              format = excluded.format,
              content = excluded.content,
              updated_at = excluded.updated_at
            ",
            params![&file_path, "markdown", &content, updated_at],
        )
        .map_err(|error| error.to_string())?;

    Ok(NoteDocument {
        file_path,
        format: "markdown".to_string(),
        content,
        updated_at: Some(updated_at),
    })
}

#[tauri::command]
fn load_reading_position(file_path: String) -> Result<Option<ReadingPosition>, String> {
    let connection = open_database()?;
    let mut statement = connection
        .prepare(
            "
            SELECT
              page_number,
              page_offset_ratio,
              updated_at
            FROM reading_positions
            WHERE file_path = ?1
            ",
        )
        .map_err(|error| error.to_string())?;

    let position = statement.query_row(params![&file_path], |row| {
        Ok(ReadingPosition {
            file_path: file_path.clone(),
            page_number: row.get(0)?,
            page_offset_ratio: row.get(1)?,
            updated_at: Some(row.get(2)?),
        })
    });

    match position {
        Ok(position) => Ok(Some(position)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

#[tauri::command]
fn save_reading_position(
    file_path: String,
    page_number: u32,
    page_offset_ratio: f64,
) -> Result<ReadingPosition, String> {
    let connection = open_database()?;
    let updated_at = std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_secs();
    let normalized_ratio = normalize_page_offset_ratio(page_offset_ratio);

    connection
        .execute(
            "
            INSERT INTO reading_positions (file_path, page_number, page_offset_ratio, updated_at)
            VALUES (?1, ?2, ?3, ?4)
            ON CONFLICT(file_path) DO UPDATE SET
              page_number = excluded.page_number,
              page_offset_ratio = excluded.page_offset_ratio,
              updated_at = excluded.updated_at
            ",
            params![&file_path, page_number, normalized_ratio, updated_at],
        )
        .map_err(|error| error.to_string())?;

    Ok(ReadingPosition {
        file_path,
        page_number,
        page_offset_ratio: normalized_ratio,
        updated_at: Some(updated_at),
    })
}

fn normalize_page_offset_ratio(page_offset_ratio: f64) -> f64 {
    page_offset_ratio.clamp(0.0, 1.0)
}

#[tauri::command]
fn load_viewer_preferences(file_path: String) -> Result<ViewerPreferencesPayload, String> {
    let connection = open_database()?;
    load_viewer_preferences_payload(&connection, Some(&file_path))
}

#[tauri::command]
fn save_default_viewer_preferences(
    current_file_path: Option<String>,
    preferences: ViewerPreferences,
) -> Result<ViewerPreferencesPayload, String> {
    let connection = open_database()?;
    save_viewer_preferences_record(&connection, VIEWER_DEFAULT_SCOPE_KEY, None, preferences)?;
    load_viewer_preferences_payload(&connection, current_file_path.as_deref())
}

#[tauri::command]
fn save_file_viewer_preferences(
    file_path: String,
    preferences: ViewerPreferences,
) -> Result<ViewerPreferencesPayload, String> {
    let connection = open_database()?;
    let global = load_saved_viewer_preferences(&connection, VIEWER_DEFAULT_SCOPE_KEY)?
        .map(normalize_viewer_preferences)
        .unwrap_or_else(default_viewer_preferences);
    let normalized = normalize_viewer_preferences(preferences);
    let stored_preferences = build_file_viewer_preferences_for_storage(&global, normalized);
    save_viewer_preferences_record(
        &connection,
        &file_path,
        Some(&file_path),
        stored_preferences,
    )?;
    load_viewer_preferences_payload(&connection, Some(&file_path))
}

#[tauri::command]
fn clear_file_viewer_preferences(file_path: String) -> Result<ViewerPreferencesPayload, String> {
    let connection = open_database()?;
    connection
        .execute(
            "DELETE FROM viewer_preferences WHERE scope_key = ?1",
            params![&file_path],
        )
        .map_err(|error| error.to_string())?;
    load_viewer_preferences_payload(&connection, Some(&file_path))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let paths = resolve_app_paths()?;
            let _ = APP_PATHS.set(paths.clone());
            prepare_storage(&paths)?;
            let config = load_config()?;
            start_library_watcher(app.handle().clone(), config.clone())?;
            app.manage(ConfigState {
                config: Mutex::new(config),
            });
            app.manage(start_thumbnail_worker(app.handle().clone()));
            Ok(())
        })
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            library_snapshot,
            load_app_config,
            save_app_config,
            book_thumbnail,
            load_note,
            save_note,
            load_reading_position,
            save_reading_position,
            load_viewer_preferences,
            save_default_viewer_preferences,
            save_file_viewer_preferences,
            clear_file_viewer_preferences
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;
    use notify::event::{CreateKind, ModifyKind, RemoveKind};
    use notify::{event::DataChange, EventKind};
    use proptest::prelude::*;
    use rusqlite::Connection;
    use std::fs;

    fn test_connection() -> Connection {
        let connection = Connection::open_in_memory().expect("in-memory db should open");
        connection
            .execute_batch(
                "
                CREATE TABLE viewer_preferences (
                  scope_key TEXT PRIMARY KEY,
                  file_path TEXT UNIQUE,
                  page_mode TEXT NOT NULL,
                  binding_direction TEXT NOT NULL,
                  zoom_mode TEXT NOT NULL,
                  align_mode TEXT NOT NULL,
                  vertical_gap_mode TEXT NOT NULL,
                  treat_first_page_as_cover INTEGER NOT NULL,
                  updated_at INTEGER NOT NULL
                );
                ",
            )
            .expect("viewer_preferences table should be created");
        connection
    }

    fn viewer_preferences(
        page_mode: &str,
        binding_direction: &str,
        zoom_mode: &str,
        align_mode: &str,
        vertical_gap_mode: &str,
        treat_first_page_as_cover: bool,
    ) -> ViewerPreferences {
        ViewerPreferences {
            page_mode: page_mode.to_string(),
            binding_direction: binding_direction.to_string(),
            zoom_mode: zoom_mode.to_string(),
            align_mode: align_mode.to_string(),
            vertical_gap_mode: vertical_gap_mode.to_string(),
            treat_first_page_as_cover,
        }
    }

    fn test_config(patterns: &[&str]) -> AppConfig {
        AppConfig {
            library_roots: Vec::new(),
            excluded_patterns: patterns.iter().map(|value| value.to_string()).collect(),
            pdf_renderer: DEFAULT_PDF_RENDERER.to_string(),
        }
    }

    #[test]
    fn normalize_excluded_patterns_merges_legacy_entries() {
        let defaults = vec!["**/backup/**".to_string(), "*.bak".to_string()];

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
                "*.bak".to_string(),
                "prefix_*".to_string(),
            ]
        );
    }

    #[test]
    fn normalize_excluded_patterns_falls_back_to_defaults() {
        let defaults = vec!["**/backup/**".to_string(), "*.bak".to_string()];

        let normalized = normalize_excluded_patterns(None, None, None, &defaults);

        assert_eq!(normalized, defaults);
    }

    #[test]
    fn excluded_patterns_match_paths_and_file_names() {
        let compiled =
            compile_exclude_patterns(&test_config(&["**/backup/**", "*.bak", "prefix_*"]))
                .expect("patterns should compile");

        assert!(matches_excluded_pattern(
            Path::new("/tmp/library/backup/book.pdf"),
            &compiled
        ));
        assert!(matches_excluded_pattern(
            Path::new("/tmp/library/prefix_manual.pdf"),
            &compiled
        ));
        assert!(matches_excluded_pattern(
            Path::new("/tmp/library/archive/document.bak"),
            &compiled
        ));
        assert!(!matches_excluded_pattern(
            Path::new("/tmp/library/regular/document.pdf"),
            &compiled
        ));
    }

    #[test]
    fn should_include_pdf_only_accepts_non_excluded_pdfs() {
        let compiled = compile_exclude_patterns(&test_config(&["**/backup/**", "*.bak"]))
            .expect("patterns should compile");

        assert!(should_include_pdf(
            Path::new("/tmp/library/regular/document.pdf"),
            &compiled
        ));
        assert!(!should_include_pdf(
            Path::new("/tmp/library/backup/document.pdf"),
            &compiled
        ));
        assert!(!should_include_pdf(
            Path::new("/tmp/library/regular/document.bak"),
            &compiled
        ));
        assert!(!should_include_pdf(
            Path::new("/tmp/library/regular/document.epub"),
            &compiled
        ));
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
            library_roots: Some(vec!["~/Books".to_string(), "  ".to_string()]),
            excluded_patterns: Some(vec!["Prefix_*".to_string(), r"**\BACKUP\**".to_string()]),
            excluded_dir_names: None,
            excluded_file_suffixes: None,
            pdf_renderer: Some("PDFJS".to_string()),
        });

        assert_eq!(config.library_roots, vec![format!("{home}/Books")]);
        assert_eq!(
            config.excluded_patterns,
            vec!["**/backup/**".to_string(), "prefix_*".to_string()]
        );
        assert_eq!(config.pdf_renderer, "pdfjs");
    }

    #[test]
    fn normalize_gui_config_input_preserves_new_glob_format() {
        let config = normalize_gui_config_input(AppConfigInput {
            library_roots: vec!["~/Library".to_string()],
            excluded_patterns: vec!["*.BAK".to_string(), "prefix_*".to_string()],
            pdf_renderer: "native".to_string(),
        });

        assert_eq!(
            config.excluded_patterns,
            vec!["*.bak".to_string(), "prefix_*".to_string()]
        );
        assert_eq!(config.pdf_renderer, "native");
    }

    #[test]
    fn app_config_to_payload_collapses_home_paths() {
        let home = std::env::var("HOME").expect("HOME should exist for tests");
        let payload = app_config_to_payload(&AppConfig {
            library_roots: vec![
                format!("{home}/Documents/Ebooks"),
                "/tmp/library".to_string(),
            ],
            excluded_patterns: vec!["**/backup/**".to_string()],
            pdf_renderer: "pdfjs".to_string(),
        });

        assert_eq!(
            payload.library_roots,
            vec!["~/Documents/Ebooks".to_string(), "/tmp/library".to_string()]
        );
        assert_eq!(payload.excluded_patterns, vec!["**/backup/**".to_string()]);
        assert_eq!(payload.pdf_renderer, "pdfjs");
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
    }

    #[test]
    fn merge_file_viewer_preferences_inherits_blank_fields_from_global() {
        let global = viewer_preferences("spread", "left", "fit-height", "center", "compact", true);
        let file = viewer_preferences("", "right", "", "left", "", false);

        let merged = merge_file_viewer_preferences(&global, &file);

        assert_eq!(merged.page_mode, "spread");
        assert_eq!(merged.binding_direction, "right");
        assert_eq!(merged.zoom_mode, "fit-height");
        assert_eq!(merged.align_mode, "left");
        assert_eq!(merged.vertical_gap_mode, "compact");
        assert!(!merged.treat_first_page_as_cover);
    }

    #[test]
    fn load_viewer_preferences_payload_merges_global_and_file_records() {
        let connection = test_connection();

        save_viewer_preferences_record(
            &connection,
            VIEWER_DEFAULT_SCOPE_KEY,
            None,
            viewer_preferences("spread", "left", "fit-height", "center", "compact", true),
        )
        .expect("global preferences should save");
        save_viewer_preferences_record(
            &connection,
            "/tmp/book.pdf",
            Some("/tmp/book.pdf"),
            viewer_preferences("", "right", "original", "", "", false),
        )
        .expect("file preferences should save");

        let payload = load_viewer_preferences_payload(&connection, Some("/tmp/book.pdf"))
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
        assert_eq!(payload.effective.binding_direction, "right");
        assert_eq!(payload.effective.zoom_mode, "original");
    }

    #[test]
    fn file_viewer_preferences_store_only_non_global_overrides() {
        let global = viewer_preferences("spread", "left", "fit-height", "center", "compact", true);
        let stored = build_file_viewer_preferences_for_storage(
            &global,
            normalize_viewer_preferences(viewer_preferences(
                "spread",
                "right",
                "fit-height",
                "center",
                "compact",
                false,
            )),
        );

        assert_eq!(stored.page_mode, "");
        assert_eq!(stored.binding_direction, "right");
        assert_eq!(stored.zoom_mode, "");
        assert_eq!(stored.align_mode, "");
        assert_eq!(stored.vertical_gap_mode, "");
        assert!(!stored.treat_first_page_as_cover);
    }

    #[test]
    fn should_rescan_ignores_excluded_paths_and_non_pdf_files() {
        let compiled = compile_exclude_patterns(&test_config(&["**/backup/**", "*.bak"]))
            .expect("patterns should compile");

        let temp_root = std::env::temp_dir().join(format!(
            "riida-test-{}",
            std::time::SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("time should move forward")
                .as_nanos()
        ));
        let backup_dir = temp_root.join("backup");
        let regular_dir = temp_root.join("regular");
        fs::create_dir_all(&backup_dir).expect("backup dir should be created");
        fs::create_dir_all(&regular_dir).expect("regular dir should be created");

        let excluded_dir_event = Event {
            kind: EventKind::Create(CreateKind::Folder),
            paths: vec![backup_dir.clone()],
            attrs: Default::default(),
        };
        let pdf_event = Event {
            kind: EventKind::Modify(ModifyKind::Data(DataChange::Content)),
            paths: vec![regular_dir.join("book.pdf")],
            attrs: Default::default(),
        };
        let txt_event = Event {
            kind: EventKind::Modify(ModifyKind::Data(DataChange::Content)),
            paths: vec![regular_dir.join("notes.txt")],
            attrs: Default::default(),
        };
        let regular_dir_event = Event {
            kind: EventKind::Remove(RemoveKind::Folder),
            paths: vec![regular_dir.clone()],
            attrs: Default::default(),
        };

        assert!(!should_rescan(&excluded_dir_event, &compiled));
        assert!(should_rescan(&pdf_event, &compiled));
        assert!(!should_rescan(&txt_event, &compiled));
        assert!(should_rescan(&regular_dir_event, &compiled));

        let _ = fs::remove_dir_all(&temp_root);
    }

    prop_compose! {
        fn arbitrary_viewer_preferences()(
            page_mode in ".*",
            binding_direction in ".*",
            zoom_mode in ".*",
            align_mode in ".*",
            vertical_gap_mode in ".*",
            treat_first_page_as_cover in any::<bool>(),
        ) -> ViewerPreferences {
            ViewerPreferences {
                page_mode,
                binding_direction,
                zoom_mode,
                align_mode,
                vertical_gap_mode,
                treat_first_page_as_cover,
            }
        }
    }

    prop_compose! {
        fn normalized_viewer_preferences_strategy()(
            page_mode in prop_oneof![Just("single".to_string()), Just("spread".to_string())],
            binding_direction in prop_oneof![Just("left".to_string()), Just("right".to_string())],
            zoom_mode in prop_oneof![
                Just("fit-width".to_string()),
                Just("fit-height".to_string()),
                Just("original".to_string())
            ],
            align_mode in prop_oneof![
                Just("left".to_string()),
                Just("center".to_string()),
                Just("right".to_string())
            ],
            vertical_gap_mode in prop_oneof![
                Just("wide".to_string()),
                Just("compact".to_string()),
                Just("none".to_string())
            ],
            treat_first_page_as_cover in any::<bool>(),
        ) -> ViewerPreferences {
            ViewerPreferences {
                page_mode,
                binding_direction,
                zoom_mode,
                align_mode,
                vertical_gap_mode,
                treat_first_page_as_cover,
            }
        }
    }

    proptest! {
        #[test]
        fn normalized_viewer_preferences_always_use_supported_values(
            preferences in arbitrary_viewer_preferences()
        ) {
            let normalized = normalize_viewer_preferences(preferences);

            prop_assert!(matches!(normalized.page_mode.as_str(), "single" | "spread"));
            prop_assert!(matches!(normalized.binding_direction.as_str(), "left" | "right"));
            prop_assert!(matches!(
                normalized.zoom_mode.as_str(),
                "fit-width" | "fit-height" | "original"
            ));
            prop_assert!(matches!(normalized.align_mode.as_str(), "left" | "center" | "right"));
            prop_assert!(matches!(
                normalized.vertical_gap_mode.as_str(),
                "wide" | "compact" | "none"
            ));
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
        }
    }
}
