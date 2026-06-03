use directories::ProjectDirs;
use globset::{Glob, GlobMatcher};
use notify::{Config, Event, RecommendedWatcher, RecursiveMode, Watcher};
use quick_xml::events::Event as XmlEvent;
use quick_xml::reader::Reader as XmlReader;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::{
    collections::{hash_map::DefaultHasher, HashMap, HashSet},
    fs,
    hash::{Hash, Hasher},
    io::Read as _,
    path::{Path, PathBuf},
    process::Command,
    sync::{mpsc, Arc, Mutex, OnceLock},
    thread,
    time::{Duration, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Manager, State, Url};
use tauri_plugin_opener::OpenerExt;
use unicode_normalization::UnicodeNormalization;
use walkdir::WalkDir;
use zip::ZipArchive;

mod fulltext;
mod fulltext_extract;

const CONFIG_FILE: &str = "riida.toml";
const DEFAULT_EXCLUDED_PATTERNS: &[&str] = &["**/backup/**", "*.bak.pdf"];
const DEFAULT_PDF_RENDERER: &str = "native";
const DEFAULT_THEME: &str = "default";
const VIEWER_DEFAULT_SCOPE_KEY: &str = "__default__";
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
const DEFAULT_VIEWER_EPUB_FONT_SIZE: i64 = 100;
const DEFAULT_THEME_VIEWER_BACKGROUND_MODE: &str = "default";
const SNOW_WHITE_VIEWER_BACKGROUND_MODE: &str = "snow-white";
const NIGHT_CITY_VIEWER_BACKGROUND_MODE: &str = "night-city";
const NAVY_BLUE_VIEWER_BACKGROUND_MODE: &str = "navy-blue";

static APP_PATHS: OnceLock<AppPaths> = OnceLock::new();
static DATABASE: OnceLock<Mutex<Connection>> = OnceLock::new();
static FULLTEXT: OnceLock<fulltext::FullTextIndex> = OnceLock::new();
static FULLTEXT_BUILDING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
static FULLTEXT_SYNCING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
// Directory containing libpdfium, resolved once at startup: `PDFIUM_LIB_DIR`
// (dev shell) or the bundled Tauri resource dir (release). `None` falls back to
// a system-installed library inside `bind_pdfium`.
static PDFIUM_DIR: OnceLock<Option<PathBuf>> = OnceLock::new();

fn should_allow_internal_navigation(url: &Url) -> bool {
    match url.scheme() {
        "tauri" | "about" | "blob" | "data" | "file" | "asset" | "ipc" => true,
        "http" | "https" => matches!(
            url.host_str(),
            Some("localhost") | Some("127.0.0.1") | Some("asset.localhost") | Some("ipc.localhost")
        ),
        _ => false,
    }
}

fn uuid_v4() -> String {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut h = DefaultHasher::new();
    std::time::SystemTime::now().hash(&mut h);
    std::thread::current().id().hash(&mut h);
    let a = h.finish();
    h.write_u64(a);
    let b = h.finish();
    format!(
        "{:08x}-{:04x}-4{:03x}-{:04x}-{:012x}",
        (a >> 32) as u32,
        (a >> 16) as u16,
        a as u16 & 0x0fff,
        (b >> 48) as u16 & 0x3fff | 0x8000,
        b & 0x0000_ffff_ffff_ffff,
    )
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct CustomSource {
    id: String,
    name: String,
    icon: String,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Shelf {
    id: String,
    name: String,
    query: String,
    icon: Option<String>,
    sort_order: i64,
    created_at: u64,
    updated_at: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ShelfDraft {
    id: Option<String>,
    name: String,
    query: String,
    icon: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BookSummary {
    file_name: String,
    title: Option<String>,
    file_path: String,
    file_size: u64,
    tags: Vec<String>,
    authors: Vec<String>,
    source_type: String,
    cover_url: Option<String>,
    location_label: Option<String>,
    is_openable: bool,
    asin: Option<String>,
    url: Option<String>,
    publisher: Option<String>,
    release_date: Option<String>,
    language: Option<String>,
    last_read_at: Option<u64>,
    indexed_at: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LibrarySnapshot {
    library_roots: Vec<String>,
    existing_library_roots: Vec<String>,
    missing_library_roots: Vec<String>,
    indexed_count: usize,
    books: Vec<BookSummary>,
    excluded_patterns: Vec<String>,
    pdf_renderer: String,
    custom_sources: Vec<CustomSource>,
}

#[derive(Clone)]
struct AppConfig {
    library_roots: Vec<String>,
    excluded_patterns: Vec<String>,
    pdf_renderer: String,
    theme: String,
    enabled_external_sources: Vec<String>,
}

#[derive(Clone, Deserialize, Serialize)]
struct AppConfigFile {
    /// `riida` package version that wrote this file. Absence indicates the
    /// file was written before the version-stamped migration scheme was
    /// introduced and may need fix-up migrations applied.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    version: Option<String>,
    library_roots: Option<Vec<String>>,
    excluded_patterns: Option<Vec<String>>,
    #[serde(default)]
    excluded_dir_names: Option<Vec<String>>,
    #[serde(default)]
    excluded_file_suffixes: Option<Vec<String>>,
    pdf_renderer: Option<String>,
    #[serde(default)]
    enabled_external_sources: Option<Vec<String>>,
    theme: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AppConfigInput {
    library_roots: Vec<String>,
    excluded_patterns: Vec<String>,
    pdf_renderer: String,
    theme: String,
    enabled_external_sources: Vec<String>,
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
    legacy_config_files: Vec<PathBuf>,
    legacy_database_files: Vec<PathBuf>,
    legacy_thumbnail_roots: Vec<PathBuf>,
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
    cfi: Option<String>,
    updated_at: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BookMetadataPayload {
    file_path: String,
    title: String,
    authors: Vec<String>,
    description: String,
    publisher: String,
    release_date: String,
    language: String,
    url: String,
    asin: String,
    cover_url: String,
    updated_at: Option<u64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BookMetadataInput {
    file_path: String,
    source_type: Option<String>,
    title: String,
    authors: Vec<String>,
    description: String,
    publisher: String,
    release_date: String,
    language: String,
    url: String,
    asin: String,
    cover_url: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BookTagsPayload {
    file_path: String,
    tags: Vec<String>,
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
    background_mode: String,
    scroll_mode: String,
    epub_font_size: i64,
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
    config_exists: bool,
    library_roots: Vec<String>,
    excluded_patterns: Vec<String>,
    pdf_renderer: String,
    theme: String,
    enabled_external_sources: Vec<String>,
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

fn preferred_config_file(project_dirs: &ProjectDirs) -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .map(|home| home.join(".config"))
        .filter(|xdg_dir| xdg_dir.exists())
        .map(|xdg_dir| xdg_dir.join("riida").join(CONFIG_FILE))
        .unwrap_or_else(|| project_dirs.config_dir().join(CONFIG_FILE))
}

fn development_app_paths(project_root: &Path) -> AppPaths {
    let data_dir = project_root.join("data");
    let cache_dir = project_root.join("cache");
    let mut legacy_config_files = Vec::new();
    let mut legacy_database_files = Vec::new();
    let mut legacy_thumbnail_roots = vec![project_root.join("data").join("thumbnails")];

    for legacy_project_dirs in [
        ProjectDirs::from("com", "zonuexe", "riida"),
        ProjectDirs::from("com", "megurine", "riida"),
    ]
    .into_iter()
    .flatten()
    {
        let legacy_config_file = preferred_config_file(&legacy_project_dirs);
        if !legacy_config_files.contains(&legacy_config_file) {
            legacy_config_files.push(legacy_config_file);
        }

        let legacy_database_file = legacy_project_dirs.data_dir().join("app.db");
        if !legacy_database_files.contains(&legacy_database_file) {
            legacy_database_files.push(legacy_database_file);
        }

        let legacy_thumbnail_root = legacy_project_dirs.cache_dir().join("thumbnails");
        if !legacy_thumbnail_roots.contains(&legacy_thumbnail_root) {
            legacy_thumbnail_roots.push(legacy_thumbnail_root);
        }
    }

    AppPaths {
        config_file: project_root.join(CONFIG_FILE),
        data_dir: data_dir.clone(),
        database_file: data_dir.join("app.db"),
        cache_dir: cache_dir.clone(),
        thumbnail_root: cache_dir.join("thumbnails"),
        legacy_config_files,
        legacy_database_files,
        legacy_thumbnail_roots,
    }
}

fn resolve_app_paths() -> Result<AppPaths, String> {
    let project_root = project_root();
    if cfg!(debug_assertions) {
        return Ok(development_app_paths(&project_root));
    }

    let project_dirs = ProjectDirs::from("me", "zonu", "riida")
        .ok_or_else(|| "failed to resolve app directories".to_string())?;
    let data_dir = project_dirs.data_dir().to_path_buf();
    let cache_dir = project_dirs.cache_dir().to_path_buf();
    let config_file = preferred_config_file(&project_dirs);

    let mut legacy_config_files = vec![project_root.join(CONFIG_FILE)];
    let mut legacy_database_files = vec![project_root.join("data").join("app.db")];
    let mut legacy_thumbnail_roots = vec![project_root.join("data").join("thumbnails")];

    for legacy_project_dirs in [
        ProjectDirs::from("com", "zonuexe", "riida"),
        ProjectDirs::from("com", "megurine", "riida"),
    ]
    .into_iter()
    .flatten()
    {
        let legacy_config_file = preferred_config_file(&legacy_project_dirs);
        if !legacy_config_files.contains(&legacy_config_file) {
            legacy_config_files.push(legacy_config_file);
        }

        let legacy_database_file = legacy_project_dirs.data_dir().join("app.db");
        if !legacy_database_files.contains(&legacy_database_file) {
            legacy_database_files.push(legacy_database_file);
        }

        let legacy_thumbnail_root = legacy_project_dirs.cache_dir().join("thumbnails");
        if !legacy_thumbnail_roots.contains(&legacy_thumbnail_root) {
            legacy_thumbnail_roots.push(legacy_thumbnail_root);
        }
    }

    Ok(AppPaths {
        config_file,
        database_file: data_dir.join("app.db"),
        thumbnail_root: cache_dir.join("thumbnails"),
        data_dir,
        cache_dir,
        legacy_config_files,
        legacy_database_files,
        legacy_thumbnail_roots,
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

fn migrate_first_existing_file(sources: &[PathBuf], destination: &Path) -> Result<(), String> {
    if destination.exists() {
        return Ok(());
    }

    if let Some(source) = sources.iter().find(|source| source.exists()) {
        fs::copy(source, destination).map_err(|error| error.to_string())?;
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

    migrate_first_existing_file(&paths.legacy_config_files, &paths.config_file)?;
    migrate_first_existing_file(&paths.legacy_database_files, &paths.database_file)?;

    for legacy_thumbnail_root in &paths.legacy_thumbnail_roots {
        migrate_directory_contents(legacy_thumbnail_root, &paths.thumbnail_root)?;
    }

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

fn compile_exclude_patterns(config: &AppConfig) -> Result<CompiledExcludePatterns, String> {
    let mut matchers = Vec::new();

    for pattern in &config.excluded_patterns {
        let glob = Glob::new(pattern)
            .map_err(|error| format!("invalid excluded pattern '{pattern}': {error}"))?;
        matchers.push(glob.compile_matcher());
    }

    Ok(CompiledExcludePatterns { matchers })
}

fn load_config_file(config_path: &Path) -> Result<AppConfig, String> {
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

fn load_config() -> Result<AppConfig, String> {
    load_config_file(&config_file())
}

/// If the config file exists without a `version` field it predates the
/// version-stamped migration scheme. Run the pending fix-ups against the
/// SQLite DB and rewrite the file with the current version stamped, so
/// subsequent launches skip the work.
fn migrate_legacy_config_if_needed(config_path: &Path) -> Result<(), String> {
    let connection = lock_database()?;
    migrate_legacy_config_with_connection(config_path, &connection)
}

fn migrate_legacy_config_with_connection(
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
fn apply_pre_version_migrations(connection: &Connection) -> Result<(), String> {
    connection
        .execute(
            "UPDATE viewer_preferences SET binding_direction = 'auto' \
             WHERE binding_direction = 'left' AND scope_key LIKE ?1",
            params![format!("{VIEWER_DEFAULT_SCOPE_KEY}:%")],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
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
    let config_path = config_file();
    AppConfigPayload {
        config_path: config_path.to_string_lossy().into_owned(),
        config_exists: config_path.exists(),
        library_roots: config
            .library_roots
            .iter()
            .map(|value| collapse_home_path(value))
            .collect(),
        excluded_patterns: config.excluded_patterns.clone(),
        pdf_renderer: config.pdf_renderer.clone(),
        theme: config.theme.clone(),
        enabled_external_sources: config.enabled_external_sources.clone(),
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
        theme: normalize_theme(config.theme.unwrap_or(defaults.theme)),
        enabled_external_sources: config
            .enabled_external_sources
            .unwrap_or(defaults.enabled_external_sources),
    }
}

fn normalize_gui_config_input(config: AppConfigInput) -> AppConfig {
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

fn save_config_input_file(input: &AppConfigInput) -> Result<(), String> {
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
    fs::write(config_file(), serialized).map_err(|error| error.to_string())
}

fn open_database() -> Result<Connection, String> {
    let database_file = database_file()?;

    if let Some(parent) = database_file.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }

    let connection = Connection::open(database_file).map_err(|error| error.to_string())?;

    // WAL keeps readers from blocking the writer and is safe for the
    // out-of-process MCP writer that shares this database. `synchronous =
    // NORMAL` is the recommended companion for WAL and avoids an fsync on
    // every commit. `busy_timeout` lets a concurrent writer (e.g. the MCP
    // server) finish instead of failing immediately with SQLITE_BUSY.
    connection
        .execute_batch(
            "
            PRAGMA journal_mode = WAL;
            PRAGMA synchronous = NORMAL;
            PRAGMA busy_timeout = 5000;
            ",
        )
        .map_err(|error| error.to_string())?;

    connection
        .execute_batch(
            "
            CREATE TABLE IF NOT EXISTS books (
              id INTEGER PRIMARY KEY,
              file_path TEXT NOT NULL UNIQUE,
              file_name TEXT NOT NULL,
              file_size INTEGER NOT NULL,
              modified_at INTEGER NOT NULL,
              indexed_at INTEGER NOT NULL,
              source_type TEXT NOT NULL DEFAULT 'pdf'
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
              source_type TEXT NOT NULL DEFAULT 'pdf',
              page_mode TEXT NOT NULL,
              binding_direction TEXT NOT NULL,
              zoom_mode TEXT NOT NULL,
              align_mode TEXT NOT NULL,
              vertical_gap_mode TEXT NOT NULL,
              treat_first_page_as_cover INTEGER NOT NULL,
              background_mode TEXT NOT NULL DEFAULT 'inherit-theme',
              scroll_mode TEXT NOT NULL DEFAULT 'paged',
              updated_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS reading_positions (
              file_path TEXT PRIMARY KEY,
              page_number INTEGER NOT NULL,
              page_offset_ratio REAL NOT NULL,
              cfi TEXT,
              updated_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS book_tags (
              file_path TEXT NOT NULL,
              tag TEXT NOT NULL,
              PRIMARY KEY (file_path, tag)
            );
            CREATE TABLE IF NOT EXISTS book_metadata (
              file_path TEXT PRIMARY KEY,
              title TEXT NOT NULL,
              authors_json TEXT NOT NULL,
              description TEXT NOT NULL,
              publisher TEXT NOT NULL,
              release_date TEXT NOT NULL,
              language TEXT NOT NULL,
              url TEXT NOT NULL,
              asin TEXT NOT NULL,
              cover_url TEXT NOT NULL DEFAULT '',
              updated_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS external_books (
              file_path TEXT PRIMARY KEY,
              source_type TEXT NOT NULL,
              title TEXT NOT NULL,
              authors_json TEXT NOT NULL,
              description TEXT NOT NULL,
              publisher TEXT NOT NULL,
              release_date TEXT NOT NULL,
              language TEXT NOT NULL,
              url TEXT NOT NULL,
              asin TEXT NOT NULL,
              cover_url TEXT NOT NULL,
              updated_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS custom_sources (
              id TEXT PRIMARY KEY,
              name TEXT NOT NULL,
              icon TEXT NOT NULL,
              created_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS pdf_passwords (
              file_path TEXT PRIMARY KEY,
              password TEXT NOT NULL,
              updated_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS shelves (
              id TEXT PRIMARY KEY,
              name TEXT NOT NULL,
              query TEXT NOT NULL,
              icon TEXT,
              sort_order INTEGER NOT NULL DEFAULT 0,
              created_at INTEGER NOT NULL,
              updated_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS fulltext_index (
              file_path TEXT PRIMARY KEY,
              body_modified_at INTEGER,
              indexed_at INTEGER,
              status TEXT NOT NULL DEFAULT 'pending',
              error TEXT
            );
            ",
        )
        .map_err(|error| error.to_string())?;

    let _ = connection.execute(
        "ALTER TABLE book_metadata ADD COLUMN cover_url TEXT NOT NULL DEFAULT ''",
        [],
    );
    let _ = connection.execute(
        "ALTER TABLE books ADD COLUMN source_type TEXT NOT NULL DEFAULT 'pdf'",
        [],
    );
    let _ = connection.execute("ALTER TABLE reading_positions ADD COLUMN cfi TEXT", []);
    let _ = connection.execute(
        "ALTER TABLE viewer_preferences ADD COLUMN source_type TEXT NOT NULL DEFAULT 'pdf'",
        [],
    );
    let _ = connection.execute(
        "ALTER TABLE viewer_preferences ADD COLUMN background_mode TEXT NOT NULL DEFAULT 'inherit-theme'",
        [],
    );
    let _ = connection.execute(
        "ALTER TABLE viewer_preferences ADD COLUMN scroll_mode TEXT NOT NULL DEFAULT 'paged'",
        [],
    );
    let _ = connection.execute(
        "ALTER TABLE viewer_preferences ADD COLUMN epub_font_size INTEGER NOT NULL DEFAULT 100",
        [],
    );

    migrate_paths_to_nfc(&connection).map_err(|error| error.to_string())?;

    Ok(connection)
}

/// Open the shared database connection once and store it in the process-wide
/// `DATABASE` cell. Schema creation, column back-fills, and the NFC path
/// migration all run here exactly once at startup instead of on every command.
fn initialize_database() -> Result<(), String> {
    if DATABASE.get().is_some() {
        return Ok(());
    }
    let connection = open_database()?;
    let _ = DATABASE.set(Mutex::new(connection));
    Ok(())
}

/// Lock the shared database connection. Callers hold the guard only for the
/// duration of their own statements; expensive non-database work (such as the
/// filesystem walk during a rescan) must happen before acquiring this lock.
fn lock_database() -> Result<std::sync::MutexGuard<'static, Connection>, String> {
    DATABASE
        .get()
        .ok_or_else(|| "database is not initialized".to_string())?
        .lock()
        .map_err(|error| error.to_string())
}

/// One-time migration: convert any NFD file_path values to NFC across all tables.
///
/// macOS (HFS+/APFS) returns NFD strings from the file system API. Previous
/// versions of the app wrote those raw NFD paths into the database. External
/// writers such as the MCP server write NFC paths. This mismatch silently
/// breaks JOINs between `books` and `book_metadata`. Running this on every
/// startup is idempotent (NFC strings normalise to themselves), so it is safe
/// to leave in place permanently.
fn migrate_paths_to_nfc(connection: &Connection) -> Result<(), rusqlite::Error> {
    // Tables where file_path is the sole primary / unique key.
    let simple_tables = [
        "books",
        "notes",
        "viewer_preferences",
        "reading_positions",
        "external_books",
    ];

    for table in &simple_tables {
        let nfd_paths: Vec<String> = {
            let mut stmt = connection.prepare(&format!("SELECT file_path FROM {table}"))?;
            // `file_path` is nullable in some of these tables (e.g. the global
            // `viewer_preferences` row keys off `scope_key` and stores a NULL
            // path). A NULL path has nothing to NFC-normalize, so read it as
            // `Option<String>` and skip the NULLs — while still propagating a
            // genuine row-decode error rather than silently dropping the row.
            let all_paths: Vec<String> = stmt
                .query_map([], |row| row.get::<_, Option<String>>(0))?
                .collect::<Result<Vec<_>, _>>()?
                .into_iter()
                .flatten()
                .collect();
            all_paths
                .into_iter()
                .filter(|p| {
                    let nfc: String = p.nfc().collect();
                    nfc != *p
                })
                .collect()
        };

        for nfd in nfd_paths {
            let nfc: String = nfd.nfc().collect();
            let nfc_exists = connection
                .query_row(
                    &format!("SELECT 1 FROM {table} WHERE file_path = ?1"),
                    params![nfc],
                    |_| Ok(()),
                )
                .is_ok();

            if nfc_exists {
                // NFC row already exists (written by MCP or a later scan).
                // Drop the obsolete NFD duplicate.
                connection.execute(
                    &format!("DELETE FROM {table} WHERE file_path = ?1"),
                    params![nfd],
                )?;
            } else {
                if *table == "viewer_preferences" {
                    let scope_keys: Vec<String> = {
                        let mut stmt = connection.prepare(
                            "SELECT scope_key FROM viewer_preferences WHERE file_path = ?1",
                        )?;
                        let rows = stmt.query_map(params![&nfd], |row| row.get(0))?;
                        rows.collect::<Result<Vec<_>, _>>()?
                    };
                    for scope_key in scope_keys {
                        let next_scope_key = scope_key.replacen(&nfd, &nfc, 1);
                        connection.execute(
                            "UPDATE viewer_preferences SET file_path = ?1, scope_key = ?2 WHERE scope_key = ?3",
                            params![&nfc, &next_scope_key, &scope_key],
                        )?;
                    }
                } else {
                    connection.execute(
                        &format!("UPDATE {table} SET file_path = ?1 WHERE file_path = ?2"),
                        params![nfc, nfd],
                    )?;
                }
            }
        }
    }

    // book_tags has a compound primary key (file_path, tag).
    let nfd_tags: Vec<(String, String)> = {
        let mut stmt = connection.prepare("SELECT file_path, tag FROM book_tags")?;
        let all_tags: Vec<(String, String)> = stmt
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
            .collect::<Result<Vec<_>, _>>()?;
        all_tags
            .into_iter()
            .filter(|(p, _)| {
                let nfc: String = p.nfc().collect();
                nfc != *p
            })
            .collect()
    };

    for (nfd, tag) in nfd_tags {
        let nfc: String = nfd.nfc().collect();
        connection.execute(
            "INSERT OR IGNORE INTO book_tags (file_path, tag) VALUES (?1, ?2)",
            params![nfc, tag],
        )?;
        connection.execute(
            "DELETE FROM book_tags WHERE file_path = ?1 AND tag = ?2",
            params![nfd, tag],
        )?;
    }

    Ok(())
}

fn is_pdf_file(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.eq_ignore_ascii_case("pdf"))
        .unwrap_or(false)
}

fn is_epub_file(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.eq_ignore_ascii_case("epub"))
        .unwrap_or(false)
}

fn book_source_type(path: &Path) -> Option<&'static str> {
    if is_pdf_file(path) {
        Some("pdf")
    } else if is_epub_file(path) {
        Some("epub")
    } else {
        None
    }
}

fn should_include_book(path: &Path, compiled: &CompiledExcludePatterns) -> bool {
    book_source_type(path).is_some() && !matches_excluded_pattern(path, compiled)
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

#[cfg(test)]
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

fn current_scan_token() -> Result<u64, String> {
    std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_nanos()
        .try_into()
        .map_err(|_| "failed to convert scan token".to_string())
}

fn normalize_book_tags(tags: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut normalized = Vec::new();

    for tag in tags {
        let trimmed = tag.trim();
        if trimmed.is_empty() {
            continue;
        }

        let owned = trimmed.to_string();
        if seen.insert(owned.clone()) {
            normalized.push(owned);
        }
    }

    normalized
}

fn normalize_book_metadata_authors(authors: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut normalized = Vec::new();

    for author in authors {
        let trimmed = author.trim();
        if trimmed.is_empty() {
            continue;
        }

        let owned = trimmed.to_string();
        if seen.insert(owned.clone()) {
            normalized.push(owned);
        }
    }

    normalized
}

fn is_leap_year(year: u32) -> bool {
    (year.is_multiple_of(4) && !year.is_multiple_of(100)) || year.is_multiple_of(400)
}

fn is_valid_release_date(value: &str) -> bool {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return true;
    }

    let mut parts = trimmed.split('-');
    let Some(year) = parts.next() else {
        return false;
    };
    let Some(month) = parts.next() else {
        return false;
    };
    let Some(day) = parts.next() else {
        return false;
    };
    if parts.next().is_some() || year.len() != 4 || month.len() != 2 || day.len() != 2 {
        return false;
    }

    let Ok(year) = year.parse::<u32>() else {
        return false;
    };
    let Ok(month) = month.parse::<u32>() else {
        return false;
    };
    let Ok(day) = day.parse::<u32>() else {
        return false;
    };

    // Months outside 1..=12 fall through the match's `_` arm below, so only the
    // day-zero case needs an explicit guard here.
    if day == 0 {
        return false;
    }

    let max_day = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if is_leap_year(year) => 29,
        2 => 28,
        _ => return false,
    };

    day <= max_day
}

fn normalize_book_metadata(input: BookMetadataInput) -> Result<BookMetadataPayload, String> {
    let release_date = input.release_date.trim().to_string();
    if !is_valid_release_date(&release_date) {
        return Err("Release date must use YYYY-MM-DD.".to_string());
    }

    Ok(BookMetadataPayload {
        file_path: input.file_path,
        title: input.title.trim().to_string(),
        authors: normalize_book_metadata_authors(input.authors),
        description: input.description.trim().to_string(),
        publisher: input.publisher.trim().to_string(),
        release_date,
        language: input.language.trim().to_string(),
        url: input.url.trim().to_string(),
        asin: input.asin.trim().to_string(),
        cover_url: input.cover_url.trim().to_string(),
        updated_at: None,
    })
}

fn default_viewer_preferences() -> ViewerPreferences {
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
    }
}

fn normalize_epub_font_size(value: i64) -> i64 {
    value.clamp(50, 200)
}

fn normalize_viewer_source_type(value: &str) -> String {
    match value.trim().to_lowercase().as_str() {
        VIEWER_SOURCE_TYPE_EPUB => VIEWER_SOURCE_TYPE_EPUB.to_string(),
        _ => VIEWER_SOURCE_TYPE_PDF.to_string(),
    }
}

fn viewer_global_scope_key(source_type: &str) -> String {
    format!("{VIEWER_DEFAULT_SCOPE_KEY}:{source_type}")
}

fn viewer_file_scope_key(file_path: &str, source_type: &str) -> String {
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

fn normalize_viewer_preferences(preferences: ViewerPreferences) -> ViewerPreferences {
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
              treat_first_page_as_cover,
              background_mode,
              scroll_mode,
              epub_font_size
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
    }
}

fn save_viewer_preferences_record(
    connection: &Connection,
    scope_key: &str,
    file_path: Option<&str>,
    source_type: &str,
    preferences: ViewerPreferences,
) -> Result<ViewerPreferences, String> {
    let normalized = normalize_viewer_preferences(preferences);
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
              updated_at
            )
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
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
              updated_at = excluded.updated_at
            ",
            params![
                scope_key,
                file_path,
                normalized_source_type,
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
                normalized.background_mode,
                normalized.scroll_mode,
                normalized.epub_font_size,
                updated_at
            ],
        )
        .map_err(|error| error.to_string())?;

    Ok(normalized)
}

fn load_viewer_preferences_payload(
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

/// A book discovered on disk, ready to be upserted into the index.
struct IndexableBook {
    file_path: String,
    file_name: String,
    file_size: u64,
    modified_at: u64,
    source_type: &'static str,
}

/// Walk the configured library roots and collect every indexable book.
///
/// This performs the filesystem traversal and `stat` calls but touches no
/// database state, so it can run without holding the shared connection lock.
fn collect_indexable_books(
    config: &AppConfig,
    excluded_patterns: &CompiledExcludePatterns,
) -> Result<Vec<IndexableBook>, String> {
    let mut books = Vec::new();

    for root in &config.library_roots {
        for entry in WalkDir::new(root)
            .into_iter()
            .filter_map(Result::ok)
            .filter(|entry| {
                entry.file_type().is_file() && should_include_book(entry.path(), excluded_patterns)
            })
        {
            let path = entry.path();
            let metadata = fs::metadata(path).map_err(|error| error.to_string())?;
            let file_size = metadata.len();

            if file_size == 0 {
                continue;
            }

            // Normalize to NFC so that paths stored in the database are
            // consistent across all writers (Tauri, MCP server, etc.).
            // macOS (HFS+/APFS) returns NFD strings from the file system API,
            // which would otherwise cause JOIN mismatches with NFC-written rows.
            let file_path: String = path.to_string_lossy().nfc().collect();
            let file_name: String = path
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("unknown")
                .nfc()
                .collect();

            books.push(IndexableBook {
                file_path,
                file_name,
                file_size,
                modified_at: modified_unix_seconds(&metadata),
                source_type: book_source_type(path).unwrap_or("pdf"),
            });
        }
    }

    Ok(books)
}

/// Upsert the discovered books inside a single transaction and prune any rows
/// not seen during this scan. Only the database work happens here, so the
/// caller can keep the connection lock held for the shortest possible time.
fn index_books(
    connection: &mut Connection,
    books: &[IndexableBook],
    scan_token: u64,
) -> Result<(), String> {
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;

    for book in books {
        transaction
            .execute(
                "
                INSERT INTO books (file_path, file_name, file_size, modified_at, indexed_at, source_type)
                VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                ON CONFLICT(file_path) DO UPDATE SET
                  file_name = excluded.file_name,
                  file_size = excluded.file_size,
                  modified_at = excluded.modified_at,
                  indexed_at = excluded.indexed_at,
                  source_type = excluded.source_type
                ",
                params![
                    book.file_path,
                    book.file_name,
                    book.file_size,
                    book.modified_at,
                    scan_token,
                    book.source_type
                ],
            )
            .map_err(|error| error.to_string())?;
    }

    transaction
        .execute(
            "DELETE FROM books WHERE indexed_at != ?1",
            params![scan_token],
        )
        .map_err(|error| error.to_string())?;

    transaction.commit().map_err(|error| error.to_string())?;

    Ok(())
}

/// Convenience wrapper combining the walk and the upsert. Production code
/// calls `collect_indexable_books` + `index_books` separately so the
/// filesystem walk runs without holding the connection lock; this single-call
/// form is retained for tests that operate on an isolated in-memory database.
#[cfg(test)]
fn scan_and_index(
    connection: &mut Connection,
    config: &AppConfig,
    excluded_patterns: &CompiledExcludePatterns,
) -> Result<(), String> {
    let books = collect_indexable_books(config, excluded_patterns)?;
    let scan_token = current_scan_token()?;
    index_books(connection, &books, scan_token)
}

fn load_snapshot(connection: &Connection, config: &AppConfig) -> Result<LibrarySnapshot, String> {
    let (existing_library_roots, missing_library_roots): (Vec<_>, Vec<_>) = config
        .library_roots
        .iter()
        .cloned()
        .partition(|root| Path::new(root).exists());

    let mut tags_statement = connection
        .prepare(
            "
            SELECT file_path, tag
            FROM book_tags
            ORDER BY tag COLLATE NOCASE ASC
            ",
        )
        .map_err(|error| error.to_string())?;

    let mut tags_by_file_path: HashMap<String, Vec<String>> = HashMap::new();
    let tag_rows = tags_statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|error| error.to_string())?;

    for row in tag_rows {
        let (file_path, tag) = row.map_err(|error| error.to_string())?;
        tags_by_file_path.entry(file_path).or_default().push(tag);
    }

    let mut books = Vec::new();

    let mut pdf_statement = connection
        .prepare(
            "
            SELECT
              books.file_name,
              books.file_path,
              books.file_size,
              COALESCE(book_metadata.authors_json, '[]'),
              COALESCE(book_metadata.cover_url, ''),
              books.modified_at,
              COALESCE(book_metadata.asin, ''),
              COALESCE(book_metadata.url, ''),
              COALESCE(book_metadata.title, ''),
              books.source_type,
              COALESCE(book_metadata.publisher, ''),
              COALESCE(book_metadata.release_date, ''),
              COALESCE(book_metadata.language, ''),
              reading_positions.updated_at,
              books.indexed_at
            FROM books
            LEFT JOIN book_metadata ON book_metadata.file_path = books.file_path
            LEFT JOIN reading_positions ON reading_positions.file_path = books.file_path
            ORDER BY books.modified_at DESC, books.file_name ASC
            ",
        )
        .map_err(|error| error.to_string())?;

    let pdf_rows = pdf_statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, u64>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, u64>(5)?,
                row.get::<_, String>(6)?,
                row.get::<_, String>(7)?,
                row.get::<_, String>(8)?,
                row.get::<_, String>(9)?,
                row.get::<_, String>(10)?,
                row.get::<_, String>(11)?,
                row.get::<_, String>(12)?,
                row.get::<_, Option<u64>>(13)?,
                row.get::<_, u64>(14)?,
            ))
        })
        .map_err(|error| error.to_string())?;

    for row in pdf_rows {
        let (
            file_name,
            file_path,
            file_size,
            authors_json,
            cover_url,
            sort_key,
            asin,
            url,
            title,
            source_type,
            publisher,
            release_date,
            language,
            last_read_at,
            indexed_at,
        ) = row.map_err(|error| error.to_string())?;
        let authors = serde_json::from_str::<Vec<String>>(&authors_json).unwrap_or_default();
        books.push((
            sort_key,
            BookSummary {
                file_name,
                title: if title.is_empty() { None } else { Some(title) },
                tags: tags_by_file_path.remove(&file_path).unwrap_or_default(),
                file_path,
                file_size,
                authors,
                source_type,
                cover_url: if cover_url.is_empty() {
                    None
                } else {
                    Some(cover_url)
                },
                location_label: None,
                is_openable: true,
                asin: if asin.is_empty() { None } else { Some(asin) },
                url: if url.is_empty() { None } else { Some(url) },
                publisher: if publisher.is_empty() {
                    None
                } else {
                    Some(publisher)
                },
                release_date: if release_date.is_empty() {
                    None
                } else {
                    Some(release_date)
                },
                language: if language.is_empty() {
                    None
                } else {
                    Some(language)
                },
                last_read_at,
                indexed_at,
            },
        ));
    }

    // PDF-priority deduplication: when both book.pdf and book.epub exist in the
    // same directory, only show the PDF and suppress the EPUB entry.
    let pdf_keys: HashSet<(String, String)> = books
        .iter()
        .filter(|(_, book)| book.source_type == "pdf")
        .filter_map(|(_, book)| {
            let path = Path::new(&book.file_path);
            let parent = path.parent()?.to_string_lossy().to_lowercase();
            let stem = path.file_stem()?.to_string_lossy().to_lowercase();
            Some((parent, stem))
        })
        .collect();

    books.retain(|(_, book)| {
        if book.source_type != "epub" {
            return true;
        }
        let path = Path::new(&book.file_path);
        let Some(parent) = path.parent() else {
            return true;
        };
        let Some(stem) = path.file_stem() else {
            return true;
        };
        let key = (
            parent.to_string_lossy().to_lowercase(),
            stem.to_string_lossy().to_lowercase(),
        );
        !pdf_keys.contains(&key)
    });

    let mut external_statement = connection
        .prepare(
            "
            SELECT
              eb.file_path,
              eb.source_type,
              eb.title,
              eb.authors_json,
              eb.cover_url,
              eb.updated_at,
              eb.asin,
              eb.url,
              eb.publisher,
              eb.release_date,
              eb.language,
              rp.updated_at,
              eb.updated_at
            FROM external_books eb
            LEFT JOIN reading_positions rp ON rp.file_path = eb.file_path
            ORDER BY eb.updated_at DESC, eb.title COLLATE NOCASE ASC
            ",
        )
        .map_err(|error| error.to_string())?;

    let external_rows = external_statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, u64>(5)?,
                row.get::<_, String>(6)?,
                row.get::<_, String>(7)?,
                row.get::<_, String>(8)?,
                row.get::<_, String>(9)?,
                row.get::<_, String>(10)?,
                row.get::<_, Option<u64>>(11)?,
                row.get::<_, u64>(12)?,
            ))
        })
        .map_err(|error| error.to_string())?;

    // Load custom sources to resolve location labels for custom books
    let mut custom_sources_stmt = connection
        .prepare("SELECT id, name, icon FROM custom_sources ORDER BY created_at ASC")
        .map_err(|error| error.to_string())?;
    let custom_sources: Vec<CustomSource> = custom_sources_stmt
        .query_map([], |row| {
            Ok(CustomSource {
                id: row.get(0)?,
                name: row.get(1)?,
                icon: row.get(2)?,
            })
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;

    for row in external_rows {
        let (
            file_path,
            source_type,
            title,
            authors_json,
            cover_url,
            sort_key,
            asin,
            url,
            publisher,
            release_date,
            language,
            last_read_at,
            indexed_at,
        ) = row.map_err(|error| error.to_string())?;
        let authors = serde_json::from_str::<Vec<String>>(&authors_json).unwrap_or_default();
        let location_label = if source_type == "kindle" {
            Some("Kindle library".to_string())
        } else {
            custom_sources
                .iter()
                .find(|s| s.id == source_type)
                .map(|s| s.name.clone())
        };
        books.push((
            sort_key,
            BookSummary {
                file_name: title,
                title: None,
                tags: tags_by_file_path.remove(&file_path).unwrap_or_default(),
                file_path,
                file_size: 0,
                authors,
                source_type,
                cover_url: if cover_url.is_empty() {
                    None
                } else {
                    Some(cover_url)
                },
                location_label,
                is_openable: false,
                asin: if asin.is_empty() { None } else { Some(asin) },
                url: if url.is_empty() { None } else { Some(url) },
                publisher: if publisher.is_empty() {
                    None
                } else {
                    Some(publisher)
                },
                release_date: if release_date.is_empty() {
                    None
                } else {
                    Some(release_date)
                },
                language: if language.is_empty() {
                    None
                } else {
                    Some(language)
                },
                last_read_at,
                indexed_at,
            },
        ));
    }

    books.sort_by(|(left_key, left_book), (right_key, right_book)| {
        right_key
            .cmp(left_key)
            .then_with(|| left_book.file_name.cmp(&right_book.file_name))
    });

    let indexed_count = books.len();
    let books = books.into_iter().map(|(_, book)| book).collect();

    Ok(LibrarySnapshot {
        library_roots: config.library_roots.clone(),
        existing_library_roots,
        missing_library_roots,
        indexed_count,
        books,
        excluded_patterns: config.excluded_patterns.clone(),
        pdf_renderer: config.pdf_renderer.clone(),
        custom_sources,
    })
}

fn refresh_library_snapshot(config: &AppConfig) -> Result<LibrarySnapshot, String> {
    let excluded_patterns = compile_exclude_patterns(config)?;
    // Walk the filesystem before touching the shared connection so a large
    // rescan does not block concurrent database commands while it runs.
    let books = collect_indexable_books(config, &excluded_patterns)?;
    let scan_token = current_scan_token()?;

    let snapshot = {
        let mut connection = lock_database()?;
        index_books(&mut connection, &books, scan_token)?;
        load_snapshot(&connection, config)?
    };
    // Catch the index up to any added/removed/changed files (no-op unless the
    // user already opted in by building the index). Runs in the background.
    fulltext_sync_after_scan();
    Ok(snapshot)
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

/// Read all bytes of a named entry from a zip archive.
fn read_zip_entry(archive: &mut ZipArchive<fs::File>, name: &str) -> Result<Vec<u8>, String> {
    let mut entry = archive
        .by_name(name)
        .map_err(|e| format!("zip entry '{name}' not found: {e}"))?;
    let mut buf = Vec::new();
    entry.read_to_end(&mut buf).map_err(|e| e.to_string())?;
    Ok(buf)
}

/// Parse META-INF/container.xml and return the OPF rootfile path.
fn epub_opf_path(archive: &mut ZipArchive<fs::File>) -> Result<String, String> {
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
fn epub_cover_item_path(
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
struct EpubMetadataPayload {
    title: String,
    authors: Vec<String>,
    description: String,
    publisher: String,
    release_date: String,
    language: String,
}

/// Parse OPF Dublin Core metadata from an EPUB archive.
///
/// Authors are collected from `<dc:creator>` elements where the `opf:role`
/// attribute is absent or equal to `aut`. Other roles (illustrator, editor,
/// translator, …) are skipped so that the authors list reflects only the
/// book's primary authorship.
fn epub_extract_opf_metadata(
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

/// Extract the cover image from an EPUB file and write it to `output_dir` as
/// `thumbnail.jpg`. PNG and other non-JPEG formats are converted via `sips`
/// (macOS). Returns the path of the written thumbnail.
fn generate_epub_cover(epub_path: &Path, output_dir: &Path) -> Result<PathBuf, String> {
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

fn start_thumbnail_worker(app: AppHandle) -> ThumbnailQueue {
    let (tx, rx) = mpsc::channel::<String>();
    let pending = Arc::new(Mutex::new(HashSet::<String>::new()));
    let pending_for_worker = Arc::clone(&pending);

    thread::spawn(move || {
        while let Ok(file_path) = rx.recv() {
            let book_path = PathBuf::from(&file_path);
            let output_dir = thumbnail_cache_dir(&file_path);
            let result = if is_epub_file(&book_path) {
                generate_epub_cover(&book_path, &output_dir)
            } else {
                generate_thumbnail(&book_path, &output_dir)
            };

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
            || should_include_book(path, excluded_patterns)
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
                    thread::sleep(Duration::from_millis(750));

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
async fn library_snapshot(config_state: State<'_, ConfigState>) -> Result<LibrarySnapshot, String> {
    let config = lock_config(&config_state)?.clone();
    // The rescan walks the whole library and writes to SQLite; run it on the
    // blocking pool so the UI thread stays responsive.
    tauri::async_runtime::spawn_blocking(move || refresh_library_snapshot(&config))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn load_library_snapshot(
    config_state: State<'_, ConfigState>,
) -> Result<LibrarySnapshot, String> {
    let config = lock_config(&config_state)?.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let connection = lock_database()?;
        load_snapshot(&connection, &config)
    })
    .await
    .map_err(|error| error.to_string())?
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

    if !pdf_path.exists() || !should_include_book(&pdf_path, &excluded_patterns) {
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
        theme: next_config.theme.clone(),
        enabled_external_sources: next_config.enabled_external_sources.clone(),
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
    let connection = lock_database()?;
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
    let connection = lock_database()?;
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

    fulltext_on_note_changed(&connection, &file_path, &content);

    Ok(NoteDocument {
        file_path,
        format: "markdown".to_string(),
        content,
        updated_at: Some(updated_at),
    })
}

#[tauri::command]
fn save_book_tags(file_path: String, tags: Vec<String>) -> Result<BookTagsPayload, String> {
    let mut connection = lock_database()?;
    let normalized = normalize_book_tags(tags);
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;

    transaction
        .execute(
            "DELETE FROM book_tags WHERE file_path = ?1",
            params![file_path.clone()],
        )
        .map_err(|error| error.to_string())?;

    for tag in &normalized {
        transaction
            .execute(
                "INSERT INTO book_tags (file_path, tag) VALUES (?1, ?2)",
                params![file_path.clone(), tag],
            )
            .map_err(|error| error.to_string())?;
    }

    transaction.commit().map_err(|error| error.to_string())?;

    fulltext_on_metadata_changed(&connection, &file_path);

    Ok(BookTagsPayload {
        file_path,
        tags: normalized,
    })
}

fn validate_tag_value(value: &str) -> Result<(), String> {
    if value.is_empty() {
        return Err("Tag must not be empty.".to_string());
    }
    if value == "/" || value.starts_with('/') || value.ends_with('/') || value.contains("//") {
        return Err("Tag cannot start or end with '/', be just '/', or contain '//'.".to_string());
    }
    Ok(())
}

// Rename `old_tag` (and any descendant tags using it as a hierarchy prefix)
// to `new_tag`. Returns the number of distinct books whose tags changed.
//
// Hierarchy semantics: renaming `foo` to `bar` rewrites every tag whose path
// starts with `foo/` so that `foo/sub` becomes `bar/sub`. If a book already
// has the target tag, the rename collapses into it instead of duplicating.
fn rename_book_tag(
    connection: &mut Connection,
    old_tag: &str,
    new_tag: &str,
) -> Result<u64, String> {
    let old = old_tag.trim();
    let new = new_tag.trim();
    validate_tag_value(old)?;
    validate_tag_value(new)?;
    if old == new {
        return Ok(0);
    }

    let descendant_prefix = format!("{old}/");
    let descendant_prefix_len = descendant_prefix.len() as i64;

    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;

    let pairs: Vec<(String, String)> = {
        let mut statement = transaction
            .prepare(
                "
                SELECT file_path, tag
                FROM book_tags
                WHERE tag = ?1 OR substr(tag, 1, ?2) = ?3
                ",
            )
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map(
                params![old, descendant_prefix_len, &descendant_prefix],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .map_err(|error| error.to_string())?;
        let mut collected = Vec::new();
        for row in rows {
            collected.push(row.map_err(|error| error.to_string())?);
        }
        collected
    };

    if pairs.is_empty() {
        transaction.commit().map_err(|error| error.to_string())?;
        return Ok(0);
    }

    let mut affected_books = HashSet::new();
    for (file_path, _) in &pairs {
        affected_books.insert(file_path.clone());
    }

    transaction
        .execute(
            "
            DELETE FROM book_tags
            WHERE tag = ?1 OR substr(tag, 1, ?2) = ?3
            ",
            params![old, descendant_prefix_len, &descendant_prefix],
        )
        .map_err(|error| error.to_string())?;

    for (file_path, tag) in &pairs {
        let renamed = if tag == old {
            new.to_string()
        } else {
            format!("{new}{}", &tag[old.len()..])
        };
        transaction
            .execute(
                "INSERT OR IGNORE INTO book_tags (file_path, tag) VALUES (?1, ?2)",
                params![file_path, renamed],
            )
            .map_err(|error| error.to_string())?;
    }

    transaction.commit().map_err(|error| error.to_string())?;
    Ok(affected_books.len() as u64)
}

// Remove `tag` and every descendant hierarchical tag (`tag/...`) from every
// book that currently has them. Returns the number of distinct affected
// books.
fn delete_book_tag(connection: &Connection, tag: &str) -> Result<u64, String> {
    let target = tag.trim();
    validate_tag_value(target)?;

    let descendant_prefix = format!("{target}/");
    let descendant_prefix_len = descendant_prefix.len() as i64;

    let affected_books: u64 = connection
        .query_row(
            "
            SELECT COUNT(DISTINCT file_path)
            FROM book_tags
            WHERE tag = ?1 OR substr(tag, 1, ?2) = ?3
            ",
            params![target, descendant_prefix_len, &descendant_prefix],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| error.to_string())? as u64;

    connection
        .execute(
            "
            DELETE FROM book_tags
            WHERE tag = ?1 OR substr(tag, 1, ?2) = ?3
            ",
            params![target, descendant_prefix_len, &descendant_prefix],
        )
        .map_err(|error| error.to_string())?;

    Ok(affected_books)
}

#[tauri::command]
fn open_viewer_window(
    app: AppHandle,
    file_path: String,
    source: Option<String>,
) -> Result<String, String> {
    if file_path.is_empty() {
        return Err("file_path is required".to_string());
    }

    let now_nanos = std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let label = format!("viewer-{}", now_nanos);

    // Pass launch parameters via an initialization script. Setting them on
    // window.__RIIDA_LAUNCH_PARAMS__ before any other script runs avoids the
    // cross-platform pitfalls of stuffing a query string into WebviewUrl::App.
    let payload = serde_json::json!({
        "filePath": file_path,
        "source": source,
    });
    let init_script = format!(
        "window.__RIIDA_LAUNCH_PARAMS__ = Object.freeze({});",
        payload,
    );

    tauri::WebviewWindowBuilder::new(
        &app,
        &label,
        tauri::WebviewUrl::App(PathBuf::from("viewer.html")),
    )
    .title("riida viewer")
    .inner_size(1320.0, 860.0)
    .min_inner_size(960.0, 640.0)
    .initialization_script(&init_script)
    .build()
    .map_err(|e| e.to_string())?;

    Ok(label)
}

#[tauri::command]
fn rename_tag_globally(old_tag: String, new_tag: String) -> Result<u64, String> {
    let mut connection = lock_database()?;
    rename_book_tag(&mut connection, &old_tag, &new_tag)
}

#[tauri::command]
fn delete_tag_globally(tag: String) -> Result<u64, String> {
    let connection = lock_database()?;
    delete_book_tag(&connection, &tag)
}

#[tauri::command]
fn extract_epub_metadata(file_path: String) -> Result<EpubMetadataPayload, String> {
    let epub_path = PathBuf::from(&file_path);
    if !is_epub_file(&epub_path) {
        return Err("not an EPUB file".to_string());
    }
    let file = fs::File::open(&epub_path).map_err(|e| e.to_string())?;
    let mut archive = ZipArchive::new(file).map_err(|e| e.to_string())?;
    let opf_path = epub_opf_path(&mut archive)?;
    epub_extract_opf_metadata(&mut archive, &opf_path)
}

#[tauri::command]
fn load_book_metadata(file_path: String) -> Result<BookMetadataPayload, String> {
    let connection = lock_database()?;
    let (table_name, file_path_filter) =
        if file_path.starts_with("kindle:") || file_path.starts_with("custom:") {
            ("external_books", "")
        } else {
            ("book_metadata", "")
        };
    let mut statement = connection
        .prepare(&format!(
            "
                SELECT
                  title,
                  authors_json,
                  description,
                  publisher,
                  release_date,
                  language,
                  url,
                  asin,
                  cover_url,
                  updated_at
                FROM {table_name}
                WHERE {file_path_filter}file_path = ?1
                "
        ))
        .map_err(|error| error.to_string())?;

    let metadata = statement.query_row(params![&file_path], |row| {
        let authors_json: String = row.get(1)?;
        let authors = serde_json::from_str::<Vec<String>>(&authors_json).unwrap_or_default();
        Ok(BookMetadataPayload {
            file_path: file_path.clone(),
            title: row.get(0)?,
            authors,
            description: row.get(2)?,
            publisher: row.get(3)?,
            release_date: row.get(4)?,
            language: row.get(5)?,
            url: row.get(6)?,
            asin: row.get(7)?,
            cover_url: row.get(8)?,
            updated_at: Some(row.get(9)?),
        })
    });

    match metadata {
        Ok(metadata) => Ok(metadata),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(BookMetadataPayload {
            file_path,
            title: String::new(),
            authors: Vec::new(),
            description: String::new(),
            publisher: String::new(),
            release_date: String::new(),
            language: String::new(),
            url: String::new(),
            asin: String::new(),
            cover_url: String::new(),
            updated_at: None,
        }),
        Err(error) => Err(error.to_string()),
    }
}

#[tauri::command]
fn save_book_metadata(input: BookMetadataInput) -> Result<BookMetadataPayload, String> {
    let connection = lock_database()?;
    let input_source_type = input.source_type.clone();
    let mut payload = normalize_book_metadata(input)?;
    let updated_at = std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_secs();
    let authors_json =
        serde_json::to_string(&payload.authors).map_err(|error| error.to_string())?;
    if payload.file_path.starts_with("kindle:") || payload.file_path.starts_with("custom:") {
        let source_type = if payload.file_path.starts_with("kindle:") {
            "kindle".to_string()
        } else {
            input_source_type.ok_or("source_type required for custom books")?
        };
        connection
            .execute(
                "
                INSERT INTO external_books (
                  file_path,
                  source_type,
                  title,
                  authors_json,
                  description,
                  publisher,
                  release_date,
                  language,
                  url,
                  asin,
                  cover_url,
                  updated_at
                )
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
                ON CONFLICT(file_path) DO UPDATE SET
                  title = excluded.title,
                  authors_json = excluded.authors_json,
                  description = excluded.description,
                  publisher = excluded.publisher,
                  release_date = excluded.release_date,
                  language = excluded.language,
                  url = excluded.url,
                  asin = excluded.asin,
                  cover_url = excluded.cover_url,
                  updated_at = excluded.updated_at
                ",
                params![
                    &payload.file_path,
                    &source_type,
                    &payload.title,
                    &authors_json,
                    &payload.description,
                    &payload.publisher,
                    &payload.release_date,
                    &payload.language,
                    &payload.url,
                    &payload.asin,
                    &payload.cover_url,
                    updated_at
                ],
            )
            .map_err(|error| error.to_string())?;
    } else {
        connection
            .execute(
                "
                INSERT INTO book_metadata (
                  file_path,
                  title,
                  authors_json,
                  description,
                  publisher,
                  release_date,
                  language,
                  url,
                  asin,
                  cover_url,
                  updated_at
                )
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
                ON CONFLICT(file_path) DO UPDATE SET
                  title = excluded.title,
                  authors_json = excluded.authors_json,
                  description = excluded.description,
                  publisher = excluded.publisher,
                  release_date = excluded.release_date,
                  language = excluded.language,
                  url = excluded.url,
                  asin = excluded.asin,
                  cover_url = excluded.cover_url,
                  updated_at = excluded.updated_at
                ",
                params![
                    &payload.file_path,
                    &payload.title,
                    &authors_json,
                    &payload.description,
                    &payload.publisher,
                    &payload.release_date,
                    &payload.language,
                    &payload.url,
                    &payload.asin,
                    &payload.cover_url,
                    updated_at
                ],
            )
            .map_err(|error| error.to_string())?;
    }

    payload.updated_at = Some(updated_at);
    fulltext_on_metadata_changed(&connection, &payload.file_path);
    Ok(payload)
}

#[tauri::command]
fn delete_book_metadata(file_path: String) -> Result<(), String> {
    let connection = lock_database()?;

    if file_path.starts_with("kindle:") || file_path.starts_with("custom:") {
        connection
            .execute(
                "DELETE FROM external_books WHERE file_path = ?1",
                params![&file_path],
            )
            .map_err(|error| error.to_string())?;
        connection
            .execute(
                "DELETE FROM book_tags WHERE file_path = ?1",
                params![&file_path],
            )
            .map_err(|error| error.to_string())?;
        connection
            .execute(
                "DELETE FROM notes WHERE file_path = ?1",
                params![&file_path],
            )
            .map_err(|error| error.to_string())?;
        connection
            .execute(
                "DELETE FROM reading_positions WHERE file_path = ?1",
                params![&file_path],
            )
            .map_err(|error| error.to_string())?;
        connection
            .execute(
                "DELETE FROM viewer_preferences WHERE file_path = ?1 OR scope_key = ?1",
                params![&file_path],
            )
            .map_err(|error| error.to_string())?;
    } else {
        connection
            .execute(
                "DELETE FROM book_metadata WHERE file_path = ?1",
                params![&file_path],
            )
            .map_err(|error| error.to_string())?;
    }

    if file_path.starts_with("kindle:") || file_path.starts_with("custom:") {
        // External book entry removed entirely.
        fulltext_on_book_removed(&file_path);
    } else {
        // Local book stays; only its saved metadata was cleared.
        fulltext_on_metadata_changed(&connection, &file_path);
    }

    Ok(())
}

#[tauri::command]
fn save_custom_source(
    id: Option<String>,
    name: String,
    icon: String,
) -> Result<CustomSource, String> {
    let connection = lock_database()?;
    let source_id = id.unwrap_or_else(uuid_v4);
    let created_at = std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_secs();
    connection
        .execute(
            "
            INSERT INTO custom_sources (id, name, icon, created_at)
            VALUES (?1, ?2, ?3, ?4)
            ON CONFLICT(id) DO UPDATE SET
              name = excluded.name,
              icon = excluded.icon
            ",
            params![&source_id, &name, &icon, created_at],
        )
        .map_err(|error| error.to_string())?;
    Ok(CustomSource {
        id: source_id,
        name,
        icon,
    })
}

#[tauri::command]
fn delete_custom_source(id: String) -> Result<(), String> {
    let connection = lock_database()?;
    // Collect file_paths of books in this source before deleting
    let mut stmt = connection
        .prepare("SELECT file_path FROM external_books WHERE source_type = ?1")
        .map_err(|error| error.to_string())?;
    let file_paths: Vec<String> = stmt
        .query_map(params![&id], |row| row.get(0))
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    for fp in &file_paths {
        connection
            .execute("DELETE FROM book_tags WHERE file_path = ?1", params![fp])
            .map_err(|error| error.to_string())?;
        connection
            .execute("DELETE FROM notes WHERE file_path = ?1", params![fp])
            .map_err(|error| error.to_string())?;
        connection
            .execute(
                "DELETE FROM reading_positions WHERE file_path = ?1",
                params![fp],
            )
            .map_err(|error| error.to_string())?;
        connection
            .execute(
                "DELETE FROM viewer_preferences WHERE file_path = ?1 OR scope_key = ?1",
                params![fp],
            )
            .map_err(|error| error.to_string())?;
        fulltext_on_book_removed(fp);
    }
    connection
        .execute(
            "DELETE FROM external_books WHERE source_type = ?1",
            params![&id],
        )
        .map_err(|error| error.to_string())?;
    connection
        .execute("DELETE FROM custom_sources WHERE id = ?1", params![&id])
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
fn list_shelves() -> Result<Vec<Shelf>, String> {
    let connection = lock_database()?;
    let mut stmt = connection
        .prepare(
            "
            SELECT id, name, query, icon, sort_order, created_at, updated_at
            FROM shelves
            ORDER BY sort_order ASC, created_at ASC
            ",
        )
        .map_err(|error| error.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok(Shelf {
                id: row.get(0)?,
                name: row.get(1)?,
                query: row.get(2)?,
                icon: row.get(3)?,
                sort_order: row.get(4)?,
                created_at: row.get::<_, i64>(5)? as u64,
                updated_at: row.get::<_, i64>(6)? as u64,
            })
        })
        .map_err(|error| error.to_string())?;
    let shelves = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    Ok(shelves)
}

#[tauri::command]
fn save_shelf(draft: ShelfDraft) -> Result<Shelf, String> {
    let name = draft.name.trim().to_string();
    if name.is_empty() {
        return Err("Shelf name must not be empty".to_string());
    }
    let query = draft.query.trim().to_string();
    if query.is_empty() {
        return Err("Shelf query must not be empty".to_string());
    }
    let now = std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_secs();
    let connection = lock_database()?;

    if let Some(id) = draft.id {
        connection
            .execute(
                "
                UPDATE shelves SET
                  name = ?2,
                  query = ?3,
                  icon = ?4,
                  updated_at = ?5
                WHERE id = ?1
                ",
                params![&id, &name, &query, &draft.icon, now as i64],
            )
            .map_err(|error| error.to_string())?;
        let mut stmt = connection
            .prepare(
                "
                SELECT id, name, query, icon, sort_order, created_at, updated_at
                FROM shelves WHERE id = ?1
                ",
            )
            .map_err(|error| error.to_string())?;
        let shelf = stmt
            .query_row(params![&id], |row| {
                Ok(Shelf {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    query: row.get(2)?,
                    icon: row.get(3)?,
                    sort_order: row.get(4)?,
                    created_at: row.get::<_, i64>(5)? as u64,
                    updated_at: row.get::<_, i64>(6)? as u64,
                })
            })
            .map_err(|error| error.to_string())?;
        return Ok(shelf);
    }

    let id = uuid_v4();
    let next_order: i64 = connection
        .query_row(
            "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM shelves",
            [],
            |row| row.get(0),
        )
        .unwrap_or(0);
    connection
        .execute(
            "
            INSERT INTO shelves (id, name, query, icon, sort_order, created_at, updated_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
            ",
            params![&id, &name, &query, &draft.icon, next_order, now as i64],
        )
        .map_err(|error| error.to_string())?;
    Ok(Shelf {
        id,
        name,
        query,
        icon: draft.icon,
        sort_order: next_order,
        created_at: now,
        updated_at: now,
    })
}

#[tauri::command]
fn delete_shelf(id: String) -> Result<(), String> {
    let connection = lock_database()?;
    connection
        .execute("DELETE FROM shelves WHERE id = ?1", params![&id])
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
fn reorder_shelves(ids: Vec<String>) -> Result<(), String> {
    let mut connection = lock_database()?;
    let tx = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    for (index, id) in ids.iter().enumerate() {
        tx.execute(
            "UPDATE shelves SET sort_order = ?2 WHERE id = ?1",
            params![id, index as i64],
        )
        .map_err(|error| error.to_string())?;
    }
    tx.commit().map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
fn load_reading_position(file_path: String) -> Result<Option<ReadingPosition>, String> {
    let connection = lock_database()?;
    let mut statement = connection
        .prepare(
            "
            SELECT
              page_number,
              page_offset_ratio,
              cfi,
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
            cfi: row.get(2)?,
            updated_at: Some(row.get(3)?),
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
    let connection = lock_database()?;
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
        cfi: None,
        updated_at: Some(updated_at),
    })
}

#[tauri::command]
fn save_epub_position(file_path: String, cfi: String) -> Result<(), String> {
    let connection = lock_database()?;
    let updated_at = std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_secs();

    connection
        .execute(
            "
            INSERT INTO reading_positions (file_path, page_number, page_offset_ratio, cfi, updated_at)
            VALUES (?1, 0, 0.0, ?2, ?3)
            ON CONFLICT(file_path) DO UPDATE SET
              cfi = excluded.cfi,
              updated_at = excluded.updated_at
            ",
            params![&file_path, &cfi, updated_at],
        )
        .map_err(|error| error.to_string())?;

    Ok(())
}

fn normalize_page_offset_ratio(page_offset_ratio: f64) -> f64 {
    page_offset_ratio.clamp(0.0, 1.0)
}

#[tauri::command]
fn load_viewer_preferences(
    file_path: String,
    source_type: String,
) -> Result<ViewerPreferencesPayload, String> {
    let connection = lock_database()?;
    load_viewer_preferences_payload(&connection, Some(&file_path), &source_type)
}

#[tauri::command]
fn save_default_viewer_preferences(
    current_file_path: Option<String>,
    source_type: String,
    preferences: ViewerPreferences,
) -> Result<ViewerPreferencesPayload, String> {
    let connection = lock_database()?;
    let normalized_source_type = normalize_viewer_source_type(&source_type);
    let global_scope_key = viewer_global_scope_key(&normalized_source_type);
    save_viewer_preferences_record(
        &connection,
        &global_scope_key,
        None,
        &normalized_source_type,
        preferences,
    )?;
    load_viewer_preferences_payload(
        &connection,
        current_file_path.as_deref(),
        &normalized_source_type,
    )
}

#[tauri::command]
fn save_file_viewer_preferences(
    file_path: String,
    source_type: String,
    preferences: ViewerPreferences,
) -> Result<ViewerPreferencesPayload, String> {
    let connection = lock_database()?;
    let normalized_source_type = normalize_viewer_source_type(&source_type);
    let global_scope_key = viewer_global_scope_key(&normalized_source_type);
    let global = load_saved_viewer_preferences(&connection, &global_scope_key)?
        .map(normalize_viewer_preferences)
        .unwrap_or_else(default_viewer_preferences);
    let normalized = normalize_viewer_preferences(preferences);
    let stored_preferences = build_file_viewer_preferences_for_storage(&global, normalized);
    let file_scope_key = viewer_file_scope_key(&file_path, &normalized_source_type);
    save_viewer_preferences_record(
        &connection,
        &file_scope_key,
        Some(&file_path),
        &normalized_source_type,
        stored_preferences,
    )?;
    load_viewer_preferences_payload(&connection, Some(&file_path), &normalized_source_type)
}

#[tauri::command]
fn clear_file_viewer_preferences(
    file_path: String,
    source_type: String,
) -> Result<ViewerPreferencesPayload, String> {
    let connection = lock_database()?;
    let normalized_source_type = normalize_viewer_source_type(&source_type);
    let file_scope_key = viewer_file_scope_key(&file_path, &normalized_source_type);
    connection
        .execute(
            "DELETE FROM viewer_preferences WHERE scope_key = ?1",
            params![&file_scope_key],
        )
        .map_err(|error| error.to_string())?;
    load_viewer_preferences_payload(&connection, Some(&file_path), &normalized_source_type)
}

fn query_pdf_password(connection: &Connection, file_path: &str) -> Result<Option<String>, String> {
    let result = connection.query_row(
        "SELECT password FROM pdf_passwords WHERE file_path = ?1",
        params![file_path],
        |row| row.get::<_, String>(0),
    );
    match result {
        Ok(password) => Ok(Some(password)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

fn upsert_pdf_password(
    connection: &Connection,
    file_path: &str,
    password: &str,
) -> Result<(), String> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;
    connection
        .execute(
            "INSERT INTO pdf_passwords (file_path, password, updated_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(file_path) DO UPDATE SET password = excluded.password, updated_at = excluded.updated_at",
            params![file_path, password, now],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
fn get_pdf_password(file_path: String) -> Result<Option<String>, String> {
    let connection = lock_database()?;
    query_pdf_password(&connection, &file_path)
}

#[tauri::command]
fn save_pdf_password(file_path: String, password: String) -> Result<(), String> {
    let connection = lock_database()?;
    upsert_pdf_password(&connection, &file_path, &password)
}

// ---------------------------------------------------------------------------
// Full-text search
// ---------------------------------------------------------------------------

fn current_unix_seconds() -> u64 {
    std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// On-disk location of the tantivy index. Lives in the data dir (not cache) so
/// the expensive body extraction survives a cache clear.
fn fulltext_dir() -> Result<PathBuf, String> {
    Ok(app_paths()?.data_dir.join("fulltext-index"))
}

/// Whether the index has been built at least once (opt-in: the user triggers
/// the first build). tantivy writes `meta.json` when the index is created.
fn fulltext_built() -> bool {
    fulltext_dir()
        .map(|dir| dir.join("meta.json").exists())
        .unwrap_or(false)
}

/// Directory to load libpdfium from, resolved at startup. None ⇒ rely on a
/// system library.
fn pdfium_dir() -> Option<PathBuf> {
    PDFIUM_DIR.get().cloned().flatten()
}

/// Lazily open (or create) the process-wide full-text index.
fn fulltext_index() -> Result<&'static fulltext::FullTextIndex, String> {
    if let Some(index) = FULLTEXT.get() {
        return Ok(index);
    }
    let dir = fulltext_dir()?;
    let index = fulltext::FullTextIndex::open_or_create(&dir)?;
    // A concurrent caller may have won the race; either way return the stored one.
    let _ = FULLTEXT.set(index);
    FULLTEXT
        .get()
        .ok_or_else(|| "full-text index unavailable".to_string())
}

/// All data needed to index one book, gathered under the DB lock so the slow
/// extraction can run lock-free afterwards.
struct BookIndexInput {
    file_path: String,
    source_type: String,
    modified_at: u64,
    title: String,
    authors: Vec<String>,
    publisher: String,
    description: String,
    release_date: String,
    language: String,
    asin: String,
    url: String,
    tags: Vec<String>,
    note: Option<String>,
    password: Option<String>,
}

impl BookIndexInput {
    fn is_pdf(&self) -> bool {
        self.source_type == "pdf"
    }
    fn is_epub(&self) -> bool {
        self.source_type == "epub"
    }
}

/// Read every book (local + external) plus its tags, note, and password into
/// owned structs. Three small full-table maps avoid N+1 queries.
fn gather_books_for_index(connection: &Connection) -> Result<Vec<BookIndexInput>, String> {
    let mut tags_by_path: HashMap<String, Vec<String>> = HashMap::new();
    {
        let mut stmt = connection
            .prepare("SELECT file_path, tag FROM book_tags ORDER BY tag")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|e| e.to_string())?;
        for row in rows {
            let (path, tag) = row.map_err(|e| e.to_string())?;
            tags_by_path.entry(path).or_default().push(tag);
        }
    }

    let mut note_by_path: HashMap<String, String> = HashMap::new();
    {
        let mut stmt = connection
            .prepare("SELECT file_path, content FROM notes")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|e| e.to_string())?;
        for row in rows {
            let (path, content) = row.map_err(|e| e.to_string())?;
            note_by_path.insert(path, content);
        }
    }

    let mut password_by_path: HashMap<String, String> = HashMap::new();
    {
        let mut stmt = connection
            .prepare("SELECT file_path, password FROM pdf_passwords")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|e| e.to_string())?;
        for row in rows {
            let (path, password) = row.map_err(|e| e.to_string())?;
            password_by_path.insert(path, password);
        }
    }

    let mut books = Vec::new();

    // Local, file-backed books (PDF/EPUB) with optional metadata override.
    {
        let mut stmt = connection
            .prepare(
                "SELECT b.file_path, b.file_name, b.source_type, b.modified_at,
                        COALESCE(m.title, ''), COALESCE(m.authors_json, '[]'),
                        COALESCE(m.publisher, ''), COALESCE(m.description, ''),
                        COALESCE(m.release_date, ''), COALESCE(m.language, ''),
                        COALESCE(m.asin, ''), COALESCE(m.url, '')
                 FROM books b
                 LEFT JOIN book_metadata m ON m.file_path = b.file_path",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, String>(7)?,
                    row.get::<_, String>(8)?,
                    row.get::<_, String>(9)?,
                    row.get::<_, String>(10)?,
                    row.get::<_, String>(11)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        for row in rows {
            let (
                file_path,
                file_name,
                source_type,
                modified_at,
                title,
                authors_json,
                publisher,
                description,
                release_date,
                language,
                asin,
                url,
            ) = row.map_err(|e| e.to_string())?;
            let title = if title.trim().is_empty() {
                file_name
            } else {
                title
            };
            let authors = serde_json::from_str::<Vec<String>>(&authors_json).unwrap_or_default();
            books.push(BookIndexInput {
                tags: tags_by_path.get(&file_path).cloned().unwrap_or_default(),
                note: note_by_path.get(&file_path).cloned(),
                password: password_by_path.get(&file_path).cloned(),
                file_path,
                source_type,
                modified_at: modified_at.max(0) as u64,
                title,
                authors,
                publisher,
                description,
                release_date,
                language,
                asin,
                url,
            });
        }
    }

    // External books (Kindle, custom sources): metadata-only, no body.
    {
        let mut stmt = connection
            .prepare(
                "SELECT file_path, source_type, title, authors_json, description,
                        publisher, release_date, language, url, asin
                 FROM external_books",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, String>(7)?,
                    row.get::<_, String>(8)?,
                    row.get::<_, String>(9)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        for row in rows {
            let (
                file_path,
                source_type,
                title,
                authors_json,
                description,
                publisher,
                release_date,
                language,
                url,
                asin,
            ) = row.map_err(|e| e.to_string())?;
            let authors = serde_json::from_str::<Vec<String>>(&authors_json).unwrap_or_default();
            books.push(BookIndexInput {
                tags: tags_by_path.get(&file_path).cloned().unwrap_or_default(),
                note: note_by_path.get(&file_path).cloned(),
                password: None,
                file_path,
                source_type,
                modified_at: 0,
                title,
                authors,
                publisher,
                description,
                release_date,
                language,
                asin,
                url,
            });
        }
    }

    Ok(books)
}

/// Build the `ContentDoc`s for one book (metadata + note + body).
fn build_docs_for_book(
    pdfium: Option<&pdfium_render::prelude::Pdfium>,
    book: &BookIndexInput,
) -> Vec<fulltext::ContentDoc> {
    let mut docs = vec![fulltext_extract::build_metadata_doc(
        &book.file_path,
        &book.title,
        &book.authors,
        &book.publisher,
        &book.description,
        &book.release_date,
        &book.language,
        &book.asin,
        &book.url,
        &book.tags,
    )];

    if let Some(note) = &book.note {
        let note_doc = fulltext_extract::build_note_doc(&book.file_path, &book.title, note);
        if !note_doc.text.trim().is_empty() {
            docs.push(note_doc);
        }
    }

    let body = if book.is_pdf() {
        pdfium.and_then(|p| {
            fulltext_extract::extract_pdf_body(
                p,
                &book.file_path,
                &book.title,
                book.password.as_deref(),
            )
            .map_err(|e| eprintln!("pdf body extraction failed for {}: {e}", book.file_path))
            .ok()
        })
    } else if book.is_epub() {
        fulltext_extract::extract_epub_body(&book.file_path, &book.title)
            .map_err(|e| eprintln!("epub body extraction failed for {}: {e}", book.file_path))
            .ok()
    } else {
        None
    };
    if let Some(body_docs) = body {
        docs.extend(body_docs);
    }

    docs
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct FullTextProgress {
    done: usize,
    total: usize,
    file_path: String,
}

/// Run a full index (re)build. Gathers inputs under the lock, then extracts and
/// indexes lock-free, emitting progress events. Runs on a worker thread.
fn run_fulltext_build(app: &AppHandle) -> Result<(), String> {
    let books = {
        let connection = lock_database()?;
        gather_books_for_index(&connection)?
    };
    let total = books.len();

    let index = fulltext_index()?;
    let pdfium = fulltext_extract::bind_pdfium(pdfium_dir().as_deref())
        .map_err(|e| eprintln!("pdfium unavailable, indexing metadata/notes only: {e}"))
        .ok();

    for (done, book) in books.iter().enumerate() {
        let docs = build_docs_for_book(pdfium.as_ref(), book);
        let status = match index.index_docs(&docs) {
            Ok(()) => "indexed",
            Err(e) => {
                eprintln!("index failed for {}: {e}", book.file_path);
                "failed"
            }
        };
        if let Ok(connection) = lock_database() {
            let _ = connection.execute(
                "INSERT INTO fulltext_index (file_path, body_modified_at, indexed_at, status, error)
                 VALUES (?1, ?2, ?3, ?4, NULL)
                 ON CONFLICT(file_path) DO UPDATE SET
                   body_modified_at = ?2, indexed_at = ?3, status = ?4, error = NULL",
                params![
                    book.file_path,
                    book.modified_at as i64,
                    current_unix_seconds() as i64,
                    status
                ],
            );
        }
        let _ = app.emit(
            "fulltext-progress",
            FullTextProgress {
                done: done + 1,
                total,
                file_path: book.file_path.clone(),
            },
        );
    }

    let _ = app.emit("fulltext-complete", total);
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FullTextStatus {
    total: i64,
    indexed: i64,
    failed: i64,
    building: bool,
    built: bool,
}

#[tauri::command]
fn fulltext_index_status() -> Result<FullTextStatus, String> {
    let connection = lock_database()?;
    let total: i64 = connection
        .query_row(
            "SELECT (SELECT COUNT(*) FROM books) + (SELECT COUNT(*) FROM external_books)",
            [],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    let indexed: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM fulltext_index WHERE status = 'indexed'",
            [],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    let failed: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM fulltext_index WHERE status = 'failed'",
            [],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    Ok(FullTextStatus {
        total,
        indexed,
        failed,
        building: FULLTEXT_BUILDING.load(std::sync::atomic::Ordering::SeqCst),
        built: fulltext_built(),
    })
}

/// Opt-in trigger: (re)build the whole index in the background. Returns
/// immediately; progress arrives via `fulltext-progress` / `fulltext-complete`.
#[tauri::command]
fn fulltext_build_index(app: AppHandle) -> Result<(), String> {
    use std::sync::atomic::Ordering;
    if FULLTEXT_BUILDING.swap(true, Ordering::SeqCst) {
        return Err("full-text index build already in progress".to_string());
    }
    std::thread::spawn(move || {
        if let Err(e) = run_fulltext_build(&app) {
            eprintln!("full-text index build failed: {e}");
            let _ = app.emit("fulltext-error", e);
        }
        FULLTEXT_BUILDING.store(false, Ordering::SeqCst);
    });
    Ok(())
}

/// After a library scan, reconcile the index with added/removed/changed files —
/// but only if the user already opted in by building the index. Runs in the
/// background so the scan/snapshot path is never blocked, and is a no-op when a
/// full build or another sync is already running.
fn fulltext_sync_after_scan() {
    use std::sync::atomic::Ordering;
    if !fulltext_built() || FULLTEXT_BUILDING.load(Ordering::SeqCst) {
        return;
    }
    if FULLTEXT_SYNCING.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::spawn(move || {
        if let Err(e) = run_fulltext_sync() {
            eprintln!("full-text incremental sync failed: {e}");
        }
        FULLTEXT_SYNCING.store(false, Ordering::SeqCst);
    });
}

fn run_fulltext_sync() -> Result<(), String> {
    // Snapshot the current library and the index's per-file record under the lock.
    let (books, indexed) = {
        let connection = lock_database()?;
        let books = gather_books_for_index(&connection)?;
        let mut stmt = connection
            .prepare("SELECT file_path, COALESCE(body_modified_at, 0) FROM fulltext_index")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
            })
            .map_err(|e| e.to_string())?;
        let mut indexed: HashMap<String, i64> = HashMap::new();
        for row in rows {
            let (path, ts) = row.map_err(|e| e.to_string())?;
            indexed.insert(path, ts);
        }
        (books, indexed)
    };

    let current: HashSet<&str> = books.iter().map(|b| b.file_path.as_str()).collect();
    let index = fulltext_index()?;

    // Removed: recorded in the index but no longer present in the library.
    for path in indexed.keys().filter(|p| !current.contains(p.as_str())) {
        let _ = index.delete_book(path);
        if let Ok(connection) = lock_database() {
            let _ = connection.execute(
                "DELETE FROM fulltext_index WHERE file_path = ?1",
                params![path],
            );
        }
    }

    // New or changed file-backed books need their body (re)extracted.
    let to_index: Vec<&BookIndexInput> = books
        .iter()
        .filter(|b| b.is_pdf() || b.is_epub())
        .filter(|b| match indexed.get(&b.file_path) {
            None => true,
            Some(&ts) => b.modified_at as i64 > ts,
        })
        .collect();
    if to_index.is_empty() {
        return Ok(());
    }

    let pdfium = fulltext_extract::bind_pdfium(pdfium_dir().as_deref()).ok();
    for book in to_index {
        let docs = build_docs_for_book(pdfium.as_ref(), book);
        let status = match index.index_docs(&docs) {
            Ok(()) => "indexed",
            Err(e) => {
                eprintln!("incremental index failed for {}: {e}", book.file_path);
                "failed"
            }
        };
        if let Ok(connection) = lock_database() {
            let _ = connection.execute(
                "INSERT INTO fulltext_index (file_path, body_modified_at, indexed_at, status, error)
                 VALUES (?1, ?2, ?3, ?4, NULL)
                 ON CONFLICT(file_path) DO UPDATE SET
                   body_modified_at = ?2, indexed_at = ?3, status = ?4, error = NULL",
                params![
                    book.file_path,
                    book.modified_at as i64,
                    current_unix_seconds() as i64,
                    status
                ],
            );
        }
    }
    Ok(())
}

#[tauri::command]
fn search_fulltext(
    query: String,
    limit: Option<u32>,
) -> Result<Vec<fulltext::FullTextHit>, String> {
    if !fulltext_built() {
        return Ok(Vec::new());
    }
    let index = fulltext_index()?;
    index.search(&query, limit.unwrap_or(50) as usize)
}

// --- incremental updates (run while the caller still holds the DB lock, so
// these take &Connection and must never re-lock) --------------------------

fn fulltext_tags(connection: &Connection, file_path: &str) -> Vec<String> {
    let Ok(mut stmt) =
        connection.prepare("SELECT tag FROM book_tags WHERE file_path = ?1 ORDER BY tag")
    else {
        return Vec::new();
    };
    let Ok(rows) = stmt.query_map(params![file_path], |row| row.get::<_, String>(0)) else {
        return Vec::new();
    };
    rows.flatten().collect()
}

/// Build the metadata `ContentDoc` for one book (local or external), or None if
/// the book no longer exists.
fn fulltext_metadata_doc(connection: &Connection, file_path: &str) -> Option<fulltext::ContentDoc> {
    let tags = fulltext_tags(connection, file_path);

    let local = connection
        .query_row(
            "SELECT b.file_name, COALESCE(m.title, ''), COALESCE(m.authors_json, '[]'),
                    COALESCE(m.publisher, ''), COALESCE(m.description, ''),
                    COALESCE(m.release_date, ''), COALESCE(m.language, ''),
                    COALESCE(m.asin, ''), COALESCE(m.url, '')
             FROM books b LEFT JOIN book_metadata m ON m.file_path = b.file_path
             WHERE b.file_path = ?1",
            params![file_path],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, String>(7)?,
                    row.get::<_, String>(8)?,
                ))
            },
        )
        .optional()
        .ok()
        .flatten();
    if let Some((
        file_name,
        title,
        authors_json,
        publisher,
        description,
        release,
        lang,
        asin,
        url,
    )) = local
    {
        let title = if title.trim().is_empty() {
            file_name
        } else {
            title
        };
        let authors = serde_json::from_str::<Vec<String>>(&authors_json).unwrap_or_default();
        return Some(fulltext_extract::build_metadata_doc(
            file_path,
            &title,
            &authors,
            &publisher,
            &description,
            &release,
            &lang,
            &asin,
            &url,
            &tags,
        ));
    }

    let external = connection
        .query_row(
            "SELECT title, authors_json, description, publisher, release_date, language, url, asin
             FROM external_books WHERE file_path = ?1",
            params![file_path],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, String>(7)?,
                ))
            },
        )
        .optional()
        .ok()
        .flatten();
    if let Some((title, authors_json, description, publisher, release, lang, url, asin)) = external
    {
        let authors = serde_json::from_str::<Vec<String>>(&authors_json).unwrap_or_default();
        return Some(fulltext_extract::build_metadata_doc(
            file_path,
            &title,
            &authors,
            &publisher,
            &description,
            &release,
            &lang,
            &asin,
            &url,
            &tags,
        ));
    }

    None
}

/// Re-index a book's metadata doc after a metadata/tag edit (no body re-extract).
fn fulltext_on_metadata_changed(connection: &Connection, file_path: &str) {
    if !fulltext_built() {
        return;
    }
    let Some(doc) = fulltext_metadata_doc(connection, file_path) else {
        return;
    };
    if let Ok(index) = fulltext_index() {
        let _ = index.index_docs(&[doc]);
    }
}

/// Re-index (or clear) a book's note doc after a note edit.
fn fulltext_on_note_changed(connection: &Connection, file_path: &str, content: &str) {
    if !fulltext_built() {
        return;
    }
    let Ok(index) = fulltext_index() else {
        return;
    };
    if content.trim().is_empty() {
        let _ = index.delete_kind(file_path, fulltext::ContentKind::Note);
        return;
    }
    let title = fulltext_metadata_doc(connection, file_path)
        .map(|doc| doc.title)
        .unwrap_or_else(|| file_path.to_owned());
    let note_doc = fulltext_extract::build_note_doc(file_path, &title, content);
    let _ = index.index_docs(&[note_doc]);
}

/// Remove a book entirely from the index (book deleted from the library).
fn fulltext_on_book_removed(file_path: &str) {
    if !fulltext_built() {
        return;
    }
    if let Ok(index) = fulltext_index() {
        let _ = index.delete_book(file_path);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let paths = resolve_app_paths()?;
            let _ = APP_PATHS.set(paths.clone());
            // Resolve libpdfium's location once: the dev shell sets
            // PDFIUM_LIB_DIR; a release build finds it in the bundled resource
            // dir. `bind_pdfium` falls back to a system library if neither has it.
            let pdfium_dir = std::env::var("PDFIUM_LIB_DIR")
                .ok()
                .map(PathBuf::from)
                .or_else(|| app.path().resource_dir().ok().map(|dir| dir.join("pdfium")));
            let _ = PDFIUM_DIR.set(pdfium_dir);
            prepare_storage(&paths)?;
            initialize_database()?;
            migrate_legacy_config_if_needed(&paths.config_file)?;
            let config = load_config()?;
            start_library_watcher(app.handle().clone(), config.clone())?;
            app.manage(ConfigState {
                config: Mutex::new(config),
            });
            app.manage(start_thumbnail_worker(app.handle().clone()));
            Ok(())
        })
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri::plugin::Builder::<tauri::Wry, ()>::new("riida-epub-navigation")
                .on_navigation(|webview, url| {
                    if should_allow_internal_navigation(url) {
                        return true;
                    }

                    match url.scheme() {
                        // EPUB iframe external links do not reliably open from WKWebView.
                        // Route them through the system opener and cancel the embedded
                        // navigation so the reader content stays intact.
                        "http" | "https" | "mailto" | "tel" => {
                            let _ = webview.opener().open_url(url.as_str(), None::<String>);
                            false
                        }
                        _ => true,
                    }
                })
                .build(),
        )
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            library_snapshot,
            load_library_snapshot,
            load_app_config,
            save_app_config,
            book_thumbnail,
            load_note,
            save_note,
            save_book_tags,
            rename_tag_globally,
            delete_tag_globally,
            extract_epub_metadata,
            load_book_metadata,
            save_book_metadata,
            delete_book_metadata,
            save_custom_source,
            delete_custom_source,
            list_shelves,
            save_shelf,
            delete_shelf,
            reorder_shelves,
            load_reading_position,
            save_reading_position,
            save_epub_position,
            load_viewer_preferences,
            save_default_viewer_preferences,
            save_file_viewer_preferences,
            clear_file_viewer_preferences,
            get_pdf_password,
            save_pdf_password,
            open_viewer_window,
            search_fulltext,
            fulltext_index_status,
            fulltext_build_index
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
    use std::{fs, path::PathBuf};

    fn test_connection() -> Connection {
        let connection = Connection::open_in_memory().expect("in-memory db should open");
        connection
            .execute_batch(
                "
                CREATE TABLE viewer_preferences (
                  scope_key TEXT PRIMARY KEY,
                  file_path TEXT UNIQUE,
                  source_type TEXT NOT NULL DEFAULT 'pdf',
                  page_mode TEXT NOT NULL,
                  binding_direction TEXT NOT NULL,
                  zoom_mode TEXT NOT NULL,
                  align_mode TEXT NOT NULL,
                  vertical_gap_mode TEXT NOT NULL,
                  treat_first_page_as_cover INTEGER NOT NULL,
                  background_mode TEXT NOT NULL DEFAULT 'inherit-theme',
                  scroll_mode TEXT NOT NULL DEFAULT 'paged',
                  epub_font_size INTEGER NOT NULL DEFAULT 100,
                  updated_at INTEGER NOT NULL
                );
                ",
            )
            .expect("viewer_preferences table should be created");
        connection
    }

    #[test]
    fn migrate_paths_to_nfc_tolerates_null_file_path() {
        let connection = Connection::open_in_memory().expect("in-memory db should open");
        connection
            .execute_batch(
                "
                CREATE TABLE books (file_path TEXT);
                CREATE TABLE notes (file_path TEXT);
                CREATE TABLE viewer_preferences (scope_key TEXT, file_path TEXT);
                CREATE TABLE reading_positions (file_path TEXT);
                CREATE TABLE external_books (file_path TEXT);
                CREATE TABLE book_tags (file_path TEXT, tag TEXT);
                ",
            )
            .expect("migration tables should be created");

        // Global viewer preferences are keyed only by `scope_key` and store a
        // NULL `file_path`. Reading that column as a non-optional `String`
        // previously aborted the startup setup hook (panic on `Invalid column
        // type Null`). The migration must skip NULL paths.
        connection
            .execute(
                "INSERT INTO viewer_preferences (scope_key, file_path) VALUES ('global::pdf', NULL)",
                [],
            )
            .expect("global pref row should insert");

        // A real NFD path alongside the NULL row, to confirm normalization of
        // non-NULL paths is unaffected.
        let nfd = "cafe\u{0301}.pdf";
        let nfc: String = nfd.nfc().collect();
        connection
            .execute(
                "INSERT INTO books (file_path) VALUES (?1)",
                rusqlite::params![nfd],
            )
            .expect("nfd book row should insert");

        migrate_paths_to_nfc(&connection).expect("migration should tolerate NULL file_path");

        let stored: String = connection
            .query_row("SELECT file_path FROM books", [], |row| row.get(0))
            .expect("book row should still exist");
        assert_eq!(stored, nfc, "non-NULL NFD path should be normalized to NFC");
    }

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
    fn migrate_legacy_config_is_noop_when_file_missing() {
        let connection = test_connection();
        let dir = unique_temp_dir("missing-config");
        let config_path = dir.join("riida.toml"); // intentionally never created
        migrate_legacy_config_with_connection(&config_path, &connection)
            .expect("a missing config file should be a no-op");
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

    fn viewer_preferences(
        page_mode: &str,
        binding_direction: &str,
        zoom_mode: &str,
        align_mode: &str,
        vertical_gap_mode: &str,
        treat_first_page_as_cover: bool,
        background_mode: &str,
    ) -> ViewerPreferences {
        ViewerPreferences {
            page_mode: page_mode.to_string(),
            binding_direction: binding_direction.to_string(),
            zoom_mode: zoom_mode.to_string(),
            align_mode: align_mode.to_string(),
            vertical_gap_mode: vertical_gap_mode.to_string(),
            treat_first_page_as_cover,
            background_mode: background_mode.to_string(),
            scroll_mode: String::new(),
            epub_font_size: 0,
        }
    }

    fn test_config(patterns: &[&str]) -> AppConfig {
        AppConfig {
            library_roots: Vec::new(),
            excluded_patterns: patterns.iter().map(|value| value.to_string()).collect(),
            pdf_renderer: DEFAULT_PDF_RENDERER.to_string(),
            theme: DEFAULT_THEME.to_string(),
            enabled_external_sources: vec![],
        }
    }

    fn unique_temp_dir(label: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "riida-test-{label}-{}",
            std::time::SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("time should move forward")
                .as_nanos()
        ));
        fs::create_dir_all(&path).expect("temp dir should be created");
        path
    }

    fn test_app_paths(root: &Path) -> AppPaths {
        AppPaths {
            config_file: root.join("config").join(CONFIG_FILE),
            data_dir: root.join("data"),
            database_file: root.join("data").join("app.db"),
            cache_dir: root.join("cache"),
            thumbnail_root: root.join("cache").join("thumbnails"),
            legacy_config_files: vec![root.join("legacy").join(CONFIG_FILE)],
            legacy_database_files: vec![root.join("legacy").join("app.db")],
            legacy_thumbnail_roots: vec![root.join("legacy").join("thumbnails")],
        }
    }

    #[test]
    fn development_app_paths_use_repository_storage_layout() {
        let root = unique_temp_dir("development-app-paths");
        let paths = development_app_paths(&root);

        assert_eq!(paths.config_file, root.join(CONFIG_FILE));
        assert_eq!(paths.data_dir, root.join("data"));
        assert_eq!(paths.database_file, root.join("data").join("app.db"));
        assert_eq!(paths.cache_dir, root.join("cache"));
        assert_eq!(paths.thumbnail_root, root.join("cache").join("thumbnails"));
        assert!(paths
            .legacy_thumbnail_roots
            .contains(&root.join("data").join("thumbnails")));

        let _ = fs::remove_dir_all(root);
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
    fn excluded_patterns_match_paths_and_file_names() {
        let compiled =
            compile_exclude_patterns(&test_config(&["**/backup/**", "*.bak.pdf", "prefix_*"]))
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
            Path::new("/tmp/library/archive/document.bak.pdf"),
            &compiled
        ));
        assert!(!matches_excluded_pattern(
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
        let compiled = compile_exclude_patterns(&test_config(&["**/backup/**", "*.bak.pdf"]))
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
            Path::new("/tmp/library/regular/document.bak.pdf"),
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
    fn should_include_book_accepts_epub_files() {
        let compiled = compile_exclude_patterns(&test_config(&["**/backup/**", "*.bak.epub"]))
            .expect("patterns should compile");

        assert!(should_include_book(
            Path::new("/tmp/library/regular/document.epub"),
            &compiled
        ));
        assert!(should_include_book(
            Path::new("/tmp/library/regular/document.pdf"),
            &compiled
        ));
        assert!(!should_include_book(
            Path::new("/tmp/library/backup/document.epub"),
            &compiled
        ));
        assert!(!should_include_book(
            Path::new("/tmp/library/regular/document.bak.epub"),
            &compiled
        ));
        assert!(!should_include_book(
            Path::new("/tmp/library/regular/document.txt"),
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
    fn app_config_to_payload_collapses_home_paths() {
        let home = std::env::var("HOME").expect("HOME should exist for tests");
        let payload = app_config_to_payload(&AppConfig {
            library_roots: vec![
                format!("{home}/Documents/Ebooks"),
                "/tmp/library".to_string(),
            ],
            excluded_patterns: vec!["**/backup/**".to_string()],
            pdf_renderer: "pdfjs".to_string(),
            theme: "snow-white".to_string(),
            enabled_external_sources: vec!["kindle".to_string()],
        });

        assert_eq!(
            payload.library_roots,
            vec!["~/Documents/Ebooks".to_string(), "/tmp/library".to_string()]
        );
        assert_eq!(payload.excluded_patterns, vec!["**/backup/**".to_string()]);
        assert_eq!(payload.pdf_renderer, "pdfjs");
        assert_eq!(payload.theme, "snow-white");
    }

    #[test]
    fn database_file_requires_initialized_app_paths() {
        let error =
            database_file().expect_err("database_file should fail without initialized paths");
        assert!(error.contains("application paths have not been initialized"));
    }

    #[test]
    fn project_root_points_to_repository_root() {
        let root = project_root();

        // This asserts the real repository layout. Tools like cargo-mutants run
        // tests from a sandbox copy of the crate alone, where these repo-root
        // files are absent; skip there rather than fail.
        if !root.join("package.json").exists() {
            return;
        }

        assert!(root.exists());
        assert!(root.join("package.json").exists());
        assert!(root.join("src-tauri").is_dir());
    }

    #[test]
    fn config_and_thumbnail_paths_fall_back_under_project_root() {
        let root = project_root();

        assert_eq!(config_file(), root.join(CONFIG_FILE));
        assert_eq!(thumbnail_root(), root.join("data").join("thumbnails"));
    }

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
    fn load_config_file_reads_and_normalizes_existing_config_file() {
        let config_path = project_root().join("riida.toml.example");
        // Skip when the repo-root fixture is absent (e.g. a cargo-mutants
        // sandbox that copies only the crate); the per-push gate runs it fully.
        if !config_path.exists() {
            return;
        }
        let config_contents =
            fs::read_to_string(&config_path).expect("example config file should be readable");
        let file_config: AppConfigFile =
            toml::from_str(&config_contents).expect("example config file should parse");
        let expected = normalize_config_input(file_config);
        let loaded = load_config_file(&config_path).expect("load_config_file should succeed");

        assert_eq!(loaded.library_roots, expected.library_roots);
        assert_eq!(loaded.excluded_patterns, expected.excluded_patterns);
        assert_eq!(loaded.pdf_renderer, expected.pdf_renderer);
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

    #[test]
    fn should_rescan_ignores_excluded_paths_and_non_book_files() {
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
        let epub_event = Event {
            kind: EventKind::Modify(ModifyKind::Data(DataChange::Content)),
            paths: vec![regular_dir.join("book.epub")],
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
        assert!(should_rescan(&epub_event, &compiled));
        assert!(should_rescan(&regular_dir_event, &compiled));

        let _ = fs::remove_dir_all(&temp_root);
    }

    #[test]
    fn scan_and_index_removes_books_that_become_excluded_after_config_changes() {
        let mut connection = Connection::open_in_memory().expect("in-memory db should open");
        connection
            .execute_batch(
                "
                CREATE TABLE books (
                  id INTEGER PRIMARY KEY,
                  file_path TEXT NOT NULL UNIQUE,
                  file_name TEXT NOT NULL,
                  file_size INTEGER NOT NULL,
                  modified_at INTEGER NOT NULL,
                  indexed_at INTEGER NOT NULL,
                  source_type TEXT NOT NULL DEFAULT 'pdf'
                );
                CREATE TABLE book_tags (
                  file_path TEXT NOT NULL,
                  tag TEXT NOT NULL,
                  PRIMARY KEY (file_path, tag)
                );
                CREATE TABLE book_metadata (
                  file_path TEXT PRIMARY KEY,
                  title TEXT NOT NULL,
                  authors_json TEXT NOT NULL,
                  description TEXT NOT NULL,
                  publisher TEXT NOT NULL,
                  release_date TEXT NOT NULL,
                  language TEXT NOT NULL,
                  url TEXT NOT NULL,
                  asin TEXT NOT NULL,
                  cover_url TEXT NOT NULL DEFAULT '',
                  updated_at INTEGER NOT NULL
                );
                CREATE TABLE external_books (
                  file_path TEXT PRIMARY KEY,
                  source_type TEXT NOT NULL,
                  title TEXT NOT NULL,
                  authors_json TEXT NOT NULL,
                  description TEXT NOT NULL,
                  publisher TEXT NOT NULL,
                  release_date TEXT NOT NULL,
                  language TEXT NOT NULL,
                  url TEXT NOT NULL,
                  asin TEXT NOT NULL,
                  cover_url TEXT NOT NULL,
                  updated_at INTEGER NOT NULL
                );
                CREATE TABLE custom_sources (
                  id TEXT PRIMARY KEY,
                  name TEXT NOT NULL,
                  icon TEXT NOT NULL,
                  created_at INTEGER NOT NULL
                );
                CREATE TABLE reading_positions (
                  file_path TEXT PRIMARY KEY,
                  page_number INTEGER NOT NULL,
                  page_offset_ratio REAL NOT NULL,
                  cfi TEXT,
                  updated_at INTEGER NOT NULL
                );
                ",
            )
            .expect("books schema should be created");

        let temp_root = unique_temp_dir("scan-index-config-change");
        let kindlepw_dir = temp_root.join("KindlePW");
        fs::create_dir_all(&kindlepw_dir).expect("kindlepw dir should be created");
        fs::write(kindlepw_dir.join("Guide.pdf"), "pdf").expect("pdf fixture should be written");

        let initial_config = AppConfig {
            library_roots: vec![temp_root.to_string_lossy().into_owned()],
            excluded_patterns: Vec::new(),
            pdf_renderer: DEFAULT_PDF_RENDERER.to_string(),
            theme: DEFAULT_THEME.to_string(),
            enabled_external_sources: vec![],
        };
        let initial_patterns =
            compile_exclude_patterns(&initial_config).expect("initial patterns should compile");
        scan_and_index(&mut connection, &initial_config, &initial_patterns)
            .expect("initial scan should succeed");
        let initial_snapshot =
            load_snapshot(&connection, &initial_config).expect("initial snapshot should load");
        assert_eq!(initial_snapshot.indexed_count, 1);

        let updated_config = AppConfig {
            library_roots: vec![temp_root.to_string_lossy().into_owned()],
            excluded_patterns: vec!["**/kindlepw/**".to_string(), "kindlepw*".to_string()],
            pdf_renderer: DEFAULT_PDF_RENDERER.to_string(),
            theme: DEFAULT_THEME.to_string(),
            enabled_external_sources: vec![],
        };
        let updated_patterns =
            compile_exclude_patterns(&updated_config).expect("updated patterns should compile");
        scan_and_index(&mut connection, &updated_config, &updated_patterns)
            .expect("updated scan should succeed");
        let updated_snapshot =
            load_snapshot(&connection, &updated_config).expect("updated snapshot should load");
        assert_eq!(updated_snapshot.indexed_count, 0);
        assert!(updated_snapshot.books.is_empty());

        let _ = fs::remove_dir_all(temp_root);
    }

    prop_compose! {
        fn arbitrary_viewer_preferences()(
            page_mode in ".*",
            binding_direction in ".*",
            zoom_mode in ".*",
            align_mode in ".*",
            vertical_gap_mode in ".*",
            treat_first_page_as_cover in any::<bool>(),
            background_mode in ".*",
            scroll_mode in ".*",
            epub_font_size in any::<i64>(),
        ) -> ViewerPreferences {
            ViewerPreferences {
                page_mode,
                binding_direction,
                zoom_mode,
                align_mode,
                vertical_gap_mode,
                treat_first_page_as_cover,
                background_mode,
                scroll_mode,
                epub_font_size,
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
            background_mode in prop_oneof![
                Just("inherit-theme".to_string()),
                Just("default".to_string()),
                Just("snow-white".to_string()),
                Just("night-city".to_string()),
                Just("navy-blue".to_string())
            ],
            scroll_mode in prop_oneof![
                Just("continuous".to_string()),
                Just("paged".to_string())
            ],
            epub_font_size in 50i64..=200i64,
        ) -> ViewerPreferences {
            ViewerPreferences {
                page_mode,
                binding_direction,
                zoom_mode,
                align_mode,
                vertical_gap_mode,
                treat_first_page_as_cover,
                background_mode,
                scroll_mode,
                epub_font_size,
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
    fn normalize_book_tags_discards_empty_values_and_deduplicates() {
        let normalized = normalize_book_tags(vec![
            "  rust ".to_string(),
            "".to_string(),
            "pdf".to_string(),
            "rust".to_string(),
            "  ".to_string(),
            "PDF".to_string(),
        ]);

        assert_eq!(normalized, vec!["rust", "pdf", "PDF"]);
    }

    #[test]
    fn normalize_book_metadata_authors_discards_empty_values_and_deduplicates() {
        let normalized = normalize_book_metadata_authors(vec![
            " Alice ".to_string(),
            "".to_string(),
            "Bob".to_string(),
            "Alice".to_string(),
        ]);

        assert_eq!(normalized, vec!["Alice", "Bob"]);
    }

    #[test]
    fn release_date_validation_accepts_empty_and_valid_dates() {
        assert!(is_valid_release_date(""));
        assert!(is_valid_release_date("2026-04-04"));
        assert!(is_valid_release_date("2024-02-29"));
    }

    #[test]
    fn release_date_validation_rejects_invalid_dates() {
        assert!(!is_valid_release_date("2026/04/04"));
        assert!(!is_valid_release_date("2026-02-29"));
        assert!(!is_valid_release_date("2026-13-01"));
        assert!(!is_valid_release_date("2026-04-31"));
    }

    #[test]
    fn release_date_validation_covers_boundaries() {
        // Each month-length arm plus the leap-year path, and month == 12.
        assert!(is_valid_release_date("2020-01-31"));
        assert!(is_valid_release_date("2020-04-30"));
        assert!(is_valid_release_date("2021-02-28"));
        assert!(is_valid_release_date("2020-02-29"));
        assert!(is_valid_release_date("2020-12-31"));

        // Each branch of the structural guard
        // (extra component / year / month / day length).
        assert!(!is_valid_release_date("2020-01-01-01"));
        assert!(!is_valid_release_date("202-01-01"));
        assert!(!is_valid_release_date("2020-1-01"));
        assert!(!is_valid_release_date("2020-01-1"));

        // Each branch of `month == 0 || month > 12 || day == 0`.
        assert!(!is_valid_release_date("2020-00-01"));
        assert!(!is_valid_release_date("2020-13-01"));
        assert!(!is_valid_release_date("2020-01-00"));

        // Day exceeds the month length.
        assert!(!is_valid_release_date("2020-02-30"));
        assert!(!is_valid_release_date("2021-02-29"));
    }

    #[test]
    fn should_allow_internal_navigation_classifies_schemes() {
        let allow = |u: &str| should_allow_internal_navigation(&Url::parse(u).unwrap());

        for scheme in ["tauri", "about", "blob", "data", "file", "asset", "ipc"] {
            assert!(
                allow(&format!("{scheme}://host/path")),
                "scheme {scheme} should be allowed"
            );
        }

        // http(s) only for known local hosts.
        assert!(allow("http://localhost/app"));
        assert!(allow("https://asset.localhost/x"));
        assert!(allow("http://127.0.0.1/x"));
        assert!(!allow("https://example.com/x"));

        // Unknown scheme is rejected.
        assert!(!allow("ftp://localhost/x"));
    }

    #[test]
    fn uuid_v4_has_canonical_shape() {
        let id = uuid_v4();
        let bytes = id.as_bytes();

        assert_eq!(id.len(), 36, "uuid {id} should be 36 chars");
        for index in [8usize, 13, 18, 23] {
            assert_eq!(bytes[index], b'-', "expected hyphen at {index} in {id}");
        }
        assert_eq!(bytes[14], b'4', "version nibble should be 4 in {id}");
        assert!(
            matches!(bytes[19], b'8' | b'9' | b'a' | b'b'),
            "variant nibble in {id}"
        );
    }

    #[test]
    fn modified_unix_seconds_reads_file_mtime() {
        let dir = unique_temp_dir("mtime");
        let path = dir.join("f.bin");
        fs::write(&path, b"x").expect("file should write");
        fs::File::options()
            .write(true)
            .open(&path)
            .expect("file should open")
            .set_modified(UNIX_EPOCH + std::time::Duration::from_secs(1_700_000_000))
            .expect("mtime should set");
        let metadata = fs::metadata(&path).expect("metadata should read");
        assert_eq!(modified_unix_seconds(&metadata), 1_700_000_000);
        fs::remove_dir_all(&dir).ok();
    }

    fn sample_metadata_input(release_date: &str) -> BookMetadataInput {
        BookMetadataInput {
            file_path: "/a.pdf".to_string(),
            source_type: None,
            title: " Title ".to_string(),
            authors: vec![" Alice ".to_string()],
            description: " desc ".to_string(),
            publisher: " Pub ".to_string(),
            release_date: release_date.to_string(),
            language: " en ".to_string(),
            url: " http://x ".to_string(),
            asin: " A1 ".to_string(),
            cover_url: " http://c ".to_string(),
        }
    }

    #[test]
    fn normalize_book_metadata_validates_and_trims() {
        let ok =
            normalize_book_metadata(sample_metadata_input(" 2021-07-15 ")).expect("valid date");
        assert_eq!(ok.release_date, "2021-07-15");
        assert_eq!(ok.title, "Title");
        assert!(normalize_book_metadata(sample_metadata_input("2021-13-01")).is_err());
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

    fn create_snapshot_schema(connection: &Connection) {
        connection
            .execute_batch(
                "
                CREATE TABLE books (
                  id INTEGER PRIMARY KEY, file_path TEXT NOT NULL UNIQUE,
                  file_name TEXT NOT NULL, file_size INTEGER NOT NULL,
                  modified_at INTEGER NOT NULL, indexed_at INTEGER NOT NULL,
                  source_type TEXT NOT NULL DEFAULT 'pdf'
                );
                CREATE TABLE book_tags (
                  file_path TEXT NOT NULL, tag TEXT NOT NULL, PRIMARY KEY (file_path, tag)
                );
                CREATE TABLE book_metadata (
                  file_path TEXT PRIMARY KEY, title TEXT NOT NULL, authors_json TEXT NOT NULL,
                  description TEXT NOT NULL, publisher TEXT NOT NULL, release_date TEXT NOT NULL,
                  language TEXT NOT NULL, url TEXT NOT NULL, asin TEXT NOT NULL,
                  cover_url TEXT NOT NULL DEFAULT '', updated_at INTEGER NOT NULL
                );
                CREATE TABLE external_books (
                  file_path TEXT PRIMARY KEY, source_type TEXT NOT NULL, title TEXT NOT NULL,
                  authors_json TEXT NOT NULL, description TEXT NOT NULL, publisher TEXT NOT NULL,
                  release_date TEXT NOT NULL, language TEXT NOT NULL, url TEXT NOT NULL,
                  asin TEXT NOT NULL, cover_url TEXT NOT NULL, updated_at INTEGER NOT NULL
                );
                CREATE TABLE custom_sources (
                  id TEXT PRIMARY KEY, name TEXT NOT NULL, icon TEXT NOT NULL,
                  created_at INTEGER NOT NULL
                );
                CREATE TABLE reading_positions (
                  file_path TEXT PRIMARY KEY, page_number INTEGER NOT NULL,
                  page_offset_ratio REAL NOT NULL, cfi TEXT, updated_at INTEGER NOT NULL
                );
                ",
            )
            .expect("snapshot schema should be created");
    }

    #[test]
    fn load_snapshot_labels_custom_source_books() {
        let connection = Connection::open_in_memory().expect("in-memory db should open");
        create_snapshot_schema(&connection);
        connection
            .execute(
                "INSERT INTO custom_sources (id, name, icon, created_at) VALUES ('zenn', 'Zenn', 'i', 1)",
                [],
            )
            .expect("custom source should insert");
        connection
            .execute(
                "INSERT INTO external_books (file_path, source_type, title, authors_json, \
                 description, publisher, release_date, language, url, asin, cover_url, updated_at) \
                 VALUES ('zenn:1', 'zenn', 'Z', '[]', '', '', '', '', '', '', '', 1)",
                [],
            )
            .expect("custom-source book should insert");

        let snapshot = load_snapshot(&connection, &test_config(&[])).expect("snapshot should load");
        let book = snapshot
            .books
            .iter()
            .find(|b| b.file_path == "zenn:1")
            .expect("custom-source book should be present");
        // The label is resolved from custom_sources by matching id == source_type.
        assert_eq!(book.location_label, Some("Zenn".to_string()));
    }

    #[test]
    fn normalize_theme_preserves_known_themes() {
        assert_eq!(normalize_theme("snow-white".to_string()), "snow-white");
        assert_eq!(normalize_theme("night-city".to_string()), "night-city");
        assert_eq!(normalize_theme("navy-blue".to_string()), "navy-blue");
        assert_eq!(normalize_theme("bogus".to_string()), DEFAULT_THEME);
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

    #[test]
    fn migrate_paths_to_nfc_normalizes_book_tags() {
        let connection = Connection::open_in_memory().expect("in-memory db should open");
        connection
            .execute_batch(
                "
                CREATE TABLE books (file_path TEXT);
                CREATE TABLE notes (file_path TEXT);
                CREATE TABLE viewer_preferences (scope_key TEXT, file_path TEXT);
                CREATE TABLE reading_positions (file_path TEXT);
                CREATE TABLE external_books (file_path TEXT);
                CREATE TABLE book_tags (file_path TEXT, tag TEXT);
                ",
            )
            .expect("migration tables should be created");

        let nfd = "cafe\u{0301}.pdf";
        let nfc: String = nfd.nfc().collect();
        connection
            .execute(
                "INSERT INTO book_tags (file_path, tag) VALUES (?1, 'fiction')",
                rusqlite::params![nfd],
            )
            .expect("nfd tag row should insert");

        migrate_paths_to_nfc(&connection).expect("migration should run");

        let stored: String = connection
            .query_row("SELECT file_path FROM book_tags", [], |row| row.get(0))
            .expect("tag row should still exist");
        assert_eq!(
            stored, nfc,
            "book_tags file_path should be normalized to NFC"
        );
    }

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

    // ----- EPUB parsing fixtures -------------------------------------------

    fn write_epub(entries: &[(&str, &str)]) -> (PathBuf, PathBuf) {
        use std::io::Write as _;
        let dir = unique_temp_dir("epub");
        let path = dir.join("book.epub");
        let mut zip = zip::ZipWriter::new(fs::File::create(&path).expect("epub should create"));
        let options = zip::write::SimpleFileOptions::default();
        for (name, contents) in entries {
            zip.start_file(*name, options)
                .expect("zip entry should start");
            zip.write_all(contents.as_bytes())
                .expect("zip entry should write");
        }
        zip.finish().expect("zip should finish");
        (dir, path)
    }

    fn open_epub(path: &Path) -> ZipArchive<fs::File> {
        ZipArchive::new(fs::File::open(path).expect("epub should open")).expect("zip should parse")
    }

    fn opf_with_manifest(items: &str) -> String {
        format!(
            "<?xml version=\"1.0\"?><package xmlns=\"http://www.idpf.org/2007/opf\">\
             <manifest>{items}</manifest></package>"
        )
    }

    const OPF_FIXTURE: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">
    <dc:title>The Great Book</dc:title>
    <dc:creator opf:role="aut">Alice Author</dc:creator>
    <dc:creator opf:role="ill">Ivan Illustrator</dc:creator>
    <dc:creator>Bob Coauthor</dc:creator>
    <dc:description>A fine description.</dc:description>
    <dc:publisher>Acme Press</dc:publisher>
    <dc:date>2021-07-15T00:00:00Z</dc:date>
    <dc:language>en</dc:language>
  </metadata>
</package>"#;

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

    #[test]
    fn load_snapshot_includes_external_kindle_books() {
        let connection = Connection::open_in_memory().expect("in-memory db should open");
        connection
            .execute_batch(
                "
                CREATE TABLE books (
                  id INTEGER PRIMARY KEY,
                  file_path TEXT NOT NULL UNIQUE,
                  file_name TEXT NOT NULL,
                  file_size INTEGER NOT NULL,
                  modified_at INTEGER NOT NULL,
                  indexed_at INTEGER NOT NULL,
                  source_type TEXT NOT NULL DEFAULT 'pdf'
                );
                CREATE TABLE book_tags (
                  file_path TEXT NOT NULL,
                  tag TEXT NOT NULL,
                  PRIMARY KEY (file_path, tag)
                );
                CREATE TABLE book_metadata (
                  file_path TEXT PRIMARY KEY,
                  title TEXT NOT NULL,
                  authors_json TEXT NOT NULL,
                  description TEXT NOT NULL,
                  publisher TEXT NOT NULL,
                  release_date TEXT NOT NULL,
                  language TEXT NOT NULL,
                  url TEXT NOT NULL,
                  asin TEXT NOT NULL,
                  cover_url TEXT NOT NULL DEFAULT '',
                  updated_at INTEGER NOT NULL
                );
                CREATE TABLE external_books (
                  file_path TEXT PRIMARY KEY,
                  source_type TEXT NOT NULL,
                  title TEXT NOT NULL,
                  authors_json TEXT NOT NULL,
                  description TEXT NOT NULL,
                  publisher TEXT NOT NULL,
                  release_date TEXT NOT NULL,
                  language TEXT NOT NULL,
                  url TEXT NOT NULL,
                  asin TEXT NOT NULL,
                  cover_url TEXT NOT NULL,
                  updated_at INTEGER NOT NULL
                );
                CREATE TABLE custom_sources (
                  id TEXT PRIMARY KEY,
                  name TEXT NOT NULL,
                  icon TEXT NOT NULL,
                  created_at INTEGER NOT NULL
                );
                CREATE TABLE reading_positions (
                  file_path TEXT PRIMARY KEY,
                  page_number INTEGER NOT NULL,
                  page_offset_ratio REAL NOT NULL,
                  cfi TEXT,
                  updated_at INTEGER NOT NULL
                );
                ",
            )
            .expect("schema should be created");

        connection
            .execute(
                "
                INSERT INTO external_books (
                  file_path,
                  source_type,
                  title,
                  authors_json,
                  description,
                  publisher,
                  release_date,
                  language,
                  url,
                  asin,
                  cover_url,
                  updated_at
                )
                VALUES (?1, 'kindle', ?2, ?3, '', '', '', 'ja', '', 'B09MLLNP2B', ?4, 10)
                ",
                params![
                    "kindle:B09MLLNP2B",
                    "bit 1995年09月号",
                    "[\"石田晴久\",\"竹内郁雄\"]",
                    "https://example.com/cover.jpg"
                ],
            )
            .expect("external book should be inserted");
        connection
            .execute(
                "INSERT INTO book_tags (file_path, tag) VALUES (?1, ?2)",
                params!["kindle:B09MLLNP2B", "magazine"],
            )
            .expect("tag should be inserted");

        let snapshot = load_snapshot(&connection, &test_config(&[])).expect("snapshot should load");
        assert_eq!(snapshot.indexed_count, 1);
        assert_eq!(snapshot.books.len(), 1);
        assert_eq!(snapshot.books[0].file_path, "kindle:B09MLLNP2B");
        assert_eq!(snapshot.books[0].source_type, "kindle");
        assert_eq!(
            snapshot.books[0].cover_url,
            Some("https://example.com/cover.jpg".to_string())
        );
        assert_eq!(snapshot.books[0].authors, vec!["石田晴久", "竹内郁雄"]);
        assert_eq!(snapshot.books[0].tags, vec!["magazine"]);
        assert_eq!(
            snapshot.books[0].location_label,
            Some("Kindle library".to_string())
        );
        assert!(!snapshot.books[0].is_openable);
    }

    fn password_connection() -> Connection {
        let connection = Connection::open_in_memory().expect("in-memory db should open");
        connection
            .execute_batch(
                "
                CREATE TABLE pdf_passwords (
                  file_path TEXT PRIMARY KEY,
                  password TEXT NOT NULL,
                  updated_at INTEGER NOT NULL
                );
                ",
            )
            .expect("pdf_passwords table should be created");
        connection
    }

    #[test]
    fn pdf_password_returns_none_when_not_saved() {
        let connection = password_connection();
        let result = query_pdf_password(&connection, "/some/book.pdf");
        assert_eq!(result, Ok(None));
    }

    #[test]
    fn pdf_password_round_trips_after_save() {
        let connection = password_connection();
        upsert_pdf_password(&connection, "/some/book.pdf", "s3cr3t").expect("save should succeed");
        let result = query_pdf_password(&connection, "/some/book.pdf");
        assert_eq!(result, Ok(Some("s3cr3t".to_string())));
    }

    #[test]
    fn pdf_password_save_updates_existing_entry() {
        let connection = password_connection();
        upsert_pdf_password(&connection, "/some/book.pdf", "old_pass")
            .expect("first save should succeed");
        upsert_pdf_password(&connection, "/some/book.pdf", "new_pass")
            .expect("second save should succeed");
        let result = query_pdf_password(&connection, "/some/book.pdf");
        assert_eq!(result, Ok(Some("new_pass".to_string())));
    }

    #[test]
    fn pdf_password_is_scoped_to_file_path() {
        let connection = password_connection();
        upsert_pdf_password(&connection, "/books/a.pdf", "pass_a").expect("save should succeed");
        assert_eq!(
            query_pdf_password(&connection, "/books/a.pdf"),
            Ok(Some("pass_a".to_string()))
        );
        assert_eq!(query_pdf_password(&connection, "/books/b.pdf"), Ok(None));
    }

    fn book_tags_connection() -> Connection {
        let connection = Connection::open_in_memory().expect("in-memory db should open");
        connection
            .execute_batch(
                "
                CREATE TABLE book_tags (
                  file_path TEXT NOT NULL,
                  tag TEXT NOT NULL,
                  PRIMARY KEY (file_path, tag)
                );
                ",
            )
            .expect("book_tags table should be created");
        connection
    }

    fn insert_tag(connection: &Connection, file_path: &str, tag: &str) {
        connection
            .execute(
                "INSERT INTO book_tags (file_path, tag) VALUES (?1, ?2)",
                params![file_path, tag],
            )
            .expect("tag should be inserted");
    }

    fn collect_tags(connection: &Connection, file_path: &str) -> Vec<String> {
        let mut stmt = connection
            .prepare("SELECT tag FROM book_tags WHERE file_path = ?1 ORDER BY tag")
            .expect("prepare should succeed");
        let rows = stmt
            .query_map(params![file_path], |row| row.get::<_, String>(0))
            .expect("query should succeed");
        rows.map(|row| row.expect("row should read")).collect()
    }

    #[test]
    fn delete_book_tag_removes_exact_and_descendants_across_books() {
        let connection = book_tags_connection();
        insert_tag(&connection, "/a.pdf", "rust");
        insert_tag(&connection, "/a.pdf", "rust/async");
        insert_tag(&connection, "/a.pdf", "other");
        insert_tag(&connection, "/b.pdf", "rust/sync");
        insert_tag(&connection, "/c.pdf", "rusty"); // intentionally not a descendant
        insert_tag(&connection, "/c.pdf", "other");

        let affected = delete_book_tag(&connection, "rust").expect("delete should succeed");

        assert_eq!(affected, 2);
        assert_eq!(collect_tags(&connection, "/a.pdf"), vec!["other"]);
        assert!(collect_tags(&connection, "/b.pdf").is_empty());
        assert_eq!(
            collect_tags(&connection, "/c.pdf"),
            vec!["other", "rusty"],
            "siblings sharing only a name prefix must stay"
        );
    }

    #[test]
    fn delete_book_tag_returns_zero_for_unknown_tag() {
        let connection = book_tags_connection();
        insert_tag(&connection, "/a.pdf", "rust");

        let affected = delete_book_tag(&connection, "ghost").expect("delete should succeed");

        assert_eq!(affected, 0);
        assert_eq!(collect_tags(&connection, "/a.pdf"), vec!["rust"]);
    }

    #[test]
    fn delete_book_tag_rejects_invalid_input() {
        let connection = book_tags_connection();
        assert!(delete_book_tag(&connection, "").is_err());
        assert!(delete_book_tag(&connection, "  ").is_err());
        assert!(delete_book_tag(&connection, "/leading").is_err());
        assert!(delete_book_tag(&connection, "trailing/").is_err());
        assert!(delete_book_tag(&connection, "a//b").is_err());
    }

    #[test]
    fn rename_book_tag_renames_exact_and_descendants() {
        let mut connection = book_tags_connection();
        insert_tag(&connection, "/a.pdf", "rust");
        insert_tag(&connection, "/a.pdf", "rust/async");
        insert_tag(&connection, "/b.pdf", "rust/sync");
        insert_tag(&connection, "/c.pdf", "rusty"); // not a descendant

        let affected =
            rename_book_tag(&mut connection, "rust", "lang/rust").expect("rename should succeed");

        assert_eq!(affected, 2);
        assert_eq!(
            collect_tags(&connection, "/a.pdf"),
            vec!["lang/rust", "lang/rust/async"]
        );
        assert_eq!(collect_tags(&connection, "/b.pdf"), vec!["lang/rust/sync"]);
        assert_eq!(collect_tags(&connection, "/c.pdf"), vec!["rusty"]);
    }

    #[test]
    fn rename_book_tag_collapses_into_existing_target_tag() {
        let mut connection = book_tags_connection();
        insert_tag(&connection, "/a.pdf", "draft");
        insert_tag(&connection, "/a.pdf", "wip"); // already has both
        insert_tag(&connection, "/b.pdf", "draft");

        let affected =
            rename_book_tag(&mut connection, "draft", "wip").expect("rename should succeed");

        assert_eq!(affected, 2);
        assert_eq!(collect_tags(&connection, "/a.pdf"), vec!["wip"]);
        assert_eq!(collect_tags(&connection, "/b.pdf"), vec!["wip"]);
    }

    #[test]
    fn rename_book_tag_noop_when_unchanged() {
        let mut connection = book_tags_connection();
        insert_tag(&connection, "/a.pdf", "rust");

        let affected =
            rename_book_tag(&mut connection, "rust", "rust").expect("rename should succeed");

        assert_eq!(affected, 0);
        assert_eq!(collect_tags(&connection, "/a.pdf"), vec!["rust"]);
    }

    #[test]
    fn rename_book_tag_rejects_invalid_input() {
        let mut connection = book_tags_connection();
        insert_tag(&connection, "/a.pdf", "rust");

        assert!(rename_book_tag(&mut connection, "", "rust").is_err());
        assert!(rename_book_tag(&mut connection, "rust", "").is_err());
        assert!(rename_book_tag(&mut connection, "rust", "/bad").is_err());
        assert!(rename_book_tag(&mut connection, "rust", "bad/").is_err());
        assert!(rename_book_tag(&mut connection, "rust", "a//b").is_err());
        assert_eq!(collect_tags(&connection, "/a.pdf"), vec!["rust"]);
    }

    fn books_schema_connection() -> Connection {
        let connection = Connection::open_in_memory().expect("in-memory db should open");
        connection
            .execute_batch(
                "
                CREATE TABLE books (
                  id INTEGER PRIMARY KEY,
                  file_path TEXT NOT NULL UNIQUE,
                  file_name TEXT NOT NULL,
                  file_size INTEGER NOT NULL,
                  modified_at INTEGER NOT NULL,
                  indexed_at INTEGER NOT NULL,
                  source_type TEXT NOT NULL DEFAULT 'pdf'
                );
                CREATE TABLE book_tags (
                  file_path TEXT NOT NULL,
                  tag TEXT NOT NULL,
                  PRIMARY KEY (file_path, tag)
                );
                CREATE TABLE book_metadata (
                  file_path TEXT PRIMARY KEY,
                  title TEXT NOT NULL,
                  authors_json TEXT NOT NULL,
                  description TEXT NOT NULL,
                  publisher TEXT NOT NULL,
                  release_date TEXT NOT NULL,
                  language TEXT NOT NULL,
                  url TEXT NOT NULL,
                  asin TEXT NOT NULL,
                  cover_url TEXT NOT NULL DEFAULT '',
                  updated_at INTEGER NOT NULL
                );
                CREATE TABLE external_books (
                  file_path TEXT PRIMARY KEY,
                  source_type TEXT NOT NULL,
                  title TEXT NOT NULL,
                  authors_json TEXT NOT NULL,
                  description TEXT NOT NULL,
                  publisher TEXT NOT NULL,
                  release_date TEXT NOT NULL,
                  language TEXT NOT NULL,
                  url TEXT NOT NULL,
                  asin TEXT NOT NULL,
                  cover_url TEXT NOT NULL,
                  updated_at INTEGER NOT NULL
                );
                CREATE TABLE custom_sources (
                  id TEXT PRIMARY KEY,
                  name TEXT NOT NULL,
                  icon TEXT NOT NULL,
                  created_at INTEGER NOT NULL
                );
                CREATE TABLE reading_positions (
                  file_path TEXT PRIMARY KEY,
                  page_number INTEGER NOT NULL,
                  page_offset_ratio REAL NOT NULL,
                  cfi TEXT,
                  updated_at INTEGER NOT NULL
                );
                ",
            )
            .expect("schema should be created");
        connection
    }

    #[test]
    fn load_snapshot_epub_only_book_is_shown() {
        let mut connection = books_schema_connection();
        let temp_root = unique_temp_dir("epub-only");
        fs::create_dir_all(&temp_root).expect("temp dir should be created");
        fs::write(temp_root.join("novel.epub"), "epub").expect("epub fixture should be written");

        let config = AppConfig {
            library_roots: vec![temp_root.to_string_lossy().into_owned()],
            excluded_patterns: Vec::new(),
            pdf_renderer: DEFAULT_PDF_RENDERER.to_string(),
            theme: DEFAULT_THEME.to_string(),
            enabled_external_sources: vec![],
        };
        let patterns = compile_exclude_patterns(&config).expect("patterns should compile");
        scan_and_index(&mut connection, &config, &patterns).expect("scan should succeed");
        let snapshot = load_snapshot(&connection, &config).expect("snapshot should load");

        assert_eq!(snapshot.indexed_count, 1);
        assert_eq!(snapshot.books[0].source_type, "epub");
        assert!(snapshot.books[0].is_openable);

        let _ = fs::remove_dir_all(temp_root);
    }

    #[test]
    fn load_snapshot_pdf_takes_priority_over_same_stem_epub() {
        let mut connection = books_schema_connection();
        let temp_root = unique_temp_dir("pdf-epub-dedup");
        fs::create_dir_all(&temp_root).expect("temp dir should be created");
        fs::write(temp_root.join("book.pdf"), "pdf").expect("pdf fixture should be written");
        fs::write(temp_root.join("book.epub"), "epub").expect("epub fixture should be written");
        fs::write(temp_root.join("epub-only.epub"), "epub")
            .expect("epub-only fixture should be written");

        let config = AppConfig {
            library_roots: vec![temp_root.to_string_lossy().into_owned()],
            excluded_patterns: Vec::new(),
            pdf_renderer: DEFAULT_PDF_RENDERER.to_string(),
            theme: DEFAULT_THEME.to_string(),
            enabled_external_sources: vec![],
        };
        let patterns = compile_exclude_patterns(&config).expect("patterns should compile");
        scan_and_index(&mut connection, &config, &patterns).expect("scan should succeed");
        let snapshot = load_snapshot(&connection, &config).expect("snapshot should load");

        // book.epub is suppressed; book.pdf and epub-only.epub are shown
        assert_eq!(snapshot.indexed_count, 2);
        let shown_paths: Vec<&str> = snapshot
            .books
            .iter()
            .map(|b| b.file_path.as_str())
            .collect();
        assert!(
            shown_paths.iter().any(|p| p.ends_with("book.pdf")),
            "book.pdf should be shown"
        );
        assert!(
            shown_paths.iter().any(|p| p.ends_with("epub-only.epub")),
            "epub-only.epub should be shown"
        );
        assert!(
            !shown_paths.iter().any(|p| p.ends_with("book.epub")),
            "book.epub should be suppressed"
        );

        let _ = fs::remove_dir_all(temp_root);
    }
}
