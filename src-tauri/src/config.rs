// Penguin Citizen - Star Citizen Linux Manager
// Copyright (C) 2024-2026 TomRhodan <tomrhodan@gmail.com>
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.
//
// You should have received a copy of the GNU General Public License
// along with this program.  If not, see <https://www.gnu.org/licenses/>.

//! Configuration module for Penguin Citizen.
//!
//! This module manages all application configuration:
//! - Performance settings (esync, fsync, DXVK, etc.)
//! - Runner sources (Wine/Proton repositories on GitHub)
//! - Installation settings (path, mode)
//! - Caching of runner and DXVK data
//!
//! Configuration is stored in `~/.config/penguin-citizen/config.json`.
//! The cache is stored in `~/.config/penguin-citizen/cache.json`.

use serde::{ Deserialize, Serialize };
use std::fs;
use std::os::unix::fs::MetadataExt;
use std::path::Path;

use crate::error::AppError;

/// A custom environment variable that is set when launching Star Citizen.
///
/// Allows the user to define custom KEY=VALUE pairs
/// that are passed as environment variables to the Wine process.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct CustomEnvVar {
    /// Name of the environment variable (e.g. "WINEDEBUG")
    pub key: String,
    /// Value of the environment variable (e.g. "-all")
    pub value: String,
    /// Whether this variable is active - disabled variables are ignored at launch
    pub enabled: bool,
}

/// Gamescope compositor settings for wrapping the Wine launch command.
///
/// When enabled, the game is launched inside gamescope with the specified flags.
/// Gamescope provides HDR support, resolution scaling, and cursor capture.
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct GamescopeSettings {
    /// Whether to wrap the launch command with gamescope
    pub enabled: bool,
    /// Output width (-W flag)
    pub width: Option<u32>,
    /// Output height (-H flag)
    pub height: Option<u32>,
    /// Enable HDR pass-through (--hdr-enabled)
    pub hdr: bool,
    /// Force cursor grab (--force-grab-cursor)
    pub force_grab_cursor: bool,
    /// Grab keyboard input (-g)
    pub keyboard_grab: bool,
}

/// Performance settings for Wine/Star Citizen execution.
///
/// These settings control various Wine features, overlays, and
/// graphics options. They are set as environment variables at game launch.
#[derive(Serialize, Deserialize, Clone)]
#[serde(default)]
pub struct PerformanceSettings {
    /// Eventfd-based synchronization - reduces overhead for multithreading
    pub esync: bool,
    /// Futex-based synchronization (Linux 5.16+) - faster than esync
    pub fsync: bool,
    /// Asynchronous shader compilation via DXVK - prevents shader stuttering
    pub dxvk_async: bool,
    /// Show MangoHud overlay - displays FPS, GPU/CPU load, etc.
    pub mangohud: bool,
    /// Show DXVK's own HUD - displays basic Vulkan/DXVK statistics
    pub dxvk_hud: bool,
    /// Native Wayland execution instead of X11/XWayland
    pub wayland: bool,
    /// Enable HDR mode (experimental, requires Wayland + HDR-capable monitor)
    pub hdr: bool,
    /// AMD FidelityFX Super Resolution - upscaling for performance improvement
    pub fsr: bool,
    /// Primary monitor for fullscreen mode (e.g. "DP-1", "HDMI-A-1")
    pub primary_monitor: Option<String>,
    /// Custom environment variables that are additionally set
    pub custom_env_vars: Vec<CustomEnvVar>,

    // --- GPU Selection ---
    /// DXVK_FILTER_DEVICE_NAME - force a specific GPU on hybrid systems
    pub gpu_device_filter: Option<String>,

    // --- NVIDIA ---
    /// Enable DLSS 4.0 (sets 6 DXVK_NVAPI env vars)
    pub nvidia_dlss: bool,
    /// Enable Smooth Motion (NVPRESENT_ENABLE_SMOOTH_MOTION + QUEUE_FAMILY)
    pub nvidia_smooth_motion: bool,
    /// Enable G-Sync latency optimization (__GL_GSYNC_ALLOWED + __GL_MaxFramesAllowed)
    pub nvidia_gsync: bool,

    // --- AMD ---
    /// Fix flickering lights on panel edges (radv_zero_vram=true)
    pub amd_radv_zero_vram: bool,
    /// Fix framerate drops on <8GB VRAM cards (RADV_PERFTEST=nogttspill)
    pub amd_nogttspill: bool,

    // --- Troubleshooting ---
    /// Pass --in-process-gpu CLI arg to RSI Launcher (fixes black/white window)
    pub in_process_gpu: bool,
    /// Set MESA_VK_WSI_PRESENT_MODE=mailbox (fixes Vulkan assertion crashes)
    pub vulkan_mailbox: bool,
    /// Set ENABLE_HDR_WSI=1 (HDR layer for NVIDIA without color manager)
    pub enable_hdr_wsi: bool,
    /// WINE_CPU_TOPOLOGY for multi-die CPUs (e.g. "16:0,1,2,...,15")
    pub wine_cpu_topology: Option<String>,

    // --- Performance ---
    /// Wrap launch command with gamemoderun (Feral GameMode)
    pub gamemode: bool,

    // --- Gamescope ---
    /// Gamescope compositor settings
    pub gamescope: GamescopeSettings,
}

/// Defaults: esync, fsync, dxvk_async, and Wayland are enabled,
/// as they provide the best performance for most Linux systems.
impl Default for PerformanceSettings {
    fn default() -> Self {
        Self {
            esync: true,
            fsync: true,
            dxvk_async: true,
            mangohud: false,
            dxvk_hud: false,
            wayland: true,
            hdr: false,
            fsr: false,
            primary_monitor: None,
            custom_env_vars: vec![],
            gpu_device_filter: None,
            nvidia_dlss: false,
            nvidia_smooth_motion: false,
            nvidia_gsync: false,
            amd_radv_zero_vram: false,
            amd_nogttspill: false,
            in_process_gpu: false,
            vulkan_mailbox: false,
            enable_hdr_wsi: false,
            wine_cpu_topology: None,
            gamemode: false,
            gamescope: GamescopeSettings::default(),
        }
    }
}

/// Configuration for a Wine/Proton runner source.
///
/// Runner sources are GitHub repositories that provide precompiled Wine builds
/// as release assets. Each source has an API URL for
/// fetching the available releases.
#[derive(Serialize, Deserialize, Clone)]
#[serde(default)]
pub struct RunnerSourceConfig {
    /// Display name of the source (e.g. "LUG", "Kron4ek")
    pub name: String,
    /// GitHub API URL for releases (e.g. "https://api.github.com/repos/owner/repo/releases")
    pub api_url: String,
    /// Filter mode for release assets: "all" = all assets, "kron4ek" = special filter
    /// for the Kron4ek naming scheme (e.g. only "staging-tkg" builds)
    pub filter: Option<String>,
    /// Whether this source is included when fetching the runner list
    pub enabled: bool,
}

/// Defaults: empty name and URL, no filter, enabled by default.
impl Default for RunnerSourceConfig {
    fn default() -> Self {
        Self {
            name: String::new(),
            api_url: String::new(),
            filter: None,
            enabled: true,
        }
    }
}

/// Main application configuration.
///
/// Contains all settings needed to run Star Citizen.
/// Persisted as JSON in `~/.config/penguin-citizen/config.json`.
#[derive(Serialize, Deserialize, Clone)]
#[serde(default)]
pub struct AppConfig {
    /// Installation path for Star Citizen and Wine runners (e.g. "~/Games/star-citizen")
    pub install_path: String,
    /// Name of the currently selected Wine runner (directory name under `runners/`)
    pub selected_runner: Option<String>,
    /// Performance and graphics settings
    pub performance: PerformanceSettings,
    /// Optional GitHub token for higher API rate limits when fetching releases
    pub github_token: Option<String>,
    /// Log level for the application (e.g. "info", "debug", "warn")
    pub log_level: String,
    /// Automatic backup of game configuration before each launch
    pub auto_backup_on_launch: Option<bool>,
    /// List of configured runner sources (GitHub repositories)
    pub runner_sources: Vec<RunnerSourceConfig>,
    /// Installation mode: "full" = complete installation with all steps,
    /// "quick" = quick installation without optional steps
    pub install_mode: String,
    /// UI scale factor (1.0 = 100%, 0.5 = 50%, 2.0 = 200%)
    pub ui_scale: f64,
    /// UI language override (e.g. "en", "de"). None = auto-detect from system.
    pub language: Option<String>,
}

/// Defaults: Empty installation path (must be set by the user),
/// log level "info", and full installation mode.
impl Default for AppConfig {
    fn default() -> Self {
        Self {
            install_path: String::new(),
            selected_runner: None,
            performance: PerformanceSettings::default(),
            github_token: None,
            log_level: "info".to_string(),
            auto_backup_on_launch: None,
            runner_sources: vec![],
            install_mode: "full".to_string(),
            ui_scale: 1.0,
            language: None,
        }
    }
}

/// Returns the system locale as a two-letter language code (e.g. "de", "en").
///
/// Checks environment variables in order: LANGUAGE, LC_MESSAGES, LANG.
/// Parses values like "de_DE.UTF-8" down to "de".
/// Falls back to "en" if no locale can be determined.
#[tauri::command]
pub fn get_system_locale() -> String {
    for var in &["LANGUAGE", "LC_MESSAGES", "LANG"] {
        if let Ok(val) = std::env::var(var) {
            let val = val.trim().to_string();
            if val.is_empty() || val == "C" || val == "POSIX" {
                continue;
            }
            // LANGUAGE can contain colon-separated list, take the first
            let first = val.split(':').next().unwrap_or(&val);
            // Parse "de_DE.UTF-8" -> "de"
            let lang = first.split('_').next().unwrap_or(first);
            let lang = lang.split('.').next().unwrap_or(lang);
            if !lang.is_empty() {
                return lang.to_lowercase();
            }
        }
    }
    "en".to_string()
}

// --- Cached data structures (Cache) ---
// The cache stores runner and DXVK data locally so that the GitHub API
// does not need to be queried on every start. The cache is stored in
// `~/.config/penguin-citizen/cache.json`.

/// Cached information about an available runner.
///
/// Contains all data needed to display and download a runner
/// without having to query the GitHub API again.
#[derive(Serialize, Deserialize, Clone, Default)]
pub struct CachedRunner {
    /// Display name of the runner
    pub name: String,
    /// Name of the source this runner originates from
    pub source: String,
    /// Version number or release tag
    pub version: String,
    /// Direct download URL for the archive
    pub download_url: String,
    /// File name of the archive (e.g. "wine-lug-9.0.tar.xz")
    pub file_name: String,
    /// File size in bytes - used for the download progress indicator
    pub size_bytes: u64,
}

/// Cached information about an available DXVK release.
///
/// DXVK translates DirectX calls to Vulkan and is essential
/// for Star Citizen's graphics performance on Linux.
#[derive(Serialize, Deserialize, Clone, Default)]
pub struct CachedDxvkRelease {
    /// Version string of the DXVK release (e.g. "2.4")
    pub version: String,
    /// Direct download URL for the archive
    pub download_url: String,
    /// File name of the archive (e.g. "dxvk-2.4.tar.gz")
    pub file_name: String,
    /// File size in bytes - used for the download progress indicator
    pub size_bytes: u64,
}

/// Cache container for runner data with timestamp.
#[derive(Serialize, Deserialize, Clone, Default)]
pub struct RunnerCache {
    /// List of cached runner entries
    pub runners: Vec<CachedRunner>,
    /// Unix timestamp of the last cache update - enables expiration checking
    pub cached_at: u64,
}

/// Cache container for DXVK release data with timestamp.
#[derive(Serialize, Deserialize, Clone, Default)]
pub struct DxvkCache {
    /// List of cached DXVK release entries
    pub releases: Vec<CachedDxvkRelease>,
    /// Unix timestamp of the last cache update
    pub cached_at: u64,
}

/// Complete application cache containing both runner and DXVK data.
///
/// Stored as a single JSON file so that when updating one part
/// (e.g. only runners), the other part (DXVK) is not lost.
#[derive(Serialize, Deserialize, Clone, Default)]
pub struct AppCache {
    /// Cached runner data (Wine/Proton builds)
    pub runners: RunnerCache,
    /// Cached DXVK release data
    pub dxvk: DxvkCache,
}

/// Returns the path to the cache file (`~/.config/penguin-citizen/cache.json`).
/// Returns `None` if the configuration directory cannot be determined.
fn cache_file_path() -> Option<String> {
    dirs::config_dir().map(|p| {
        p.join("penguin-citizen").join("cache.json").to_string_lossy().into_owned()
    })
}

/// Result of validating an installation path.
///
/// Returned to the frontend to give the user feedback about
/// the chosen path (write permissions, free disk space, etc.).
#[derive(Serialize, Deserialize)]
pub struct PathValidation {
    /// Whether the path is overall valid (writable + sufficient space)
    pub valid: bool,
    /// Whether write permissions exist on the path
    pub writable: bool,
    /// Free disk space in gigabytes
    pub free_space_gb: u64,
    /// Whether at least 100 GB of free space is available
    pub space_sufficient: bool,
    /// Human-readable message for the UI display
    pub message: String,
}

/// Information about a detected runner in the local installation directory.
///
/// Created when scanning the `runners/` directory. A valid
/// runner must contain a wine binary in a known layout
/// (e.g. `bin/wine`, `files/bin/wine`, `dist/bin/wine`).
#[derive(Serialize, Deserialize, Clone)]
pub struct DetectedRunner {
    /// Directory name of the runner (e.g. "wine-lug-9.0")
    pub name: String,
    /// Path to the runner's `bin/` directory
    pub bin_path: String,
    /// Full path to the Wine executable
    pub wine_executable: String,
}

/// Result of scanning for locally installed runners.
#[derive(Serialize, Deserialize)]
pub struct ScanRunnersResult {
    /// List of found runners
    pub runners: Vec<DetectedRunner>,
    /// Path to the `runners/` directory
    pub runners_dir: String,
}

use crate::runners::resolve_wine_bin;
use crate::util::{expand_tilde, validate_env_var_key};

/// Finds the first existing parent directory in a path.
///
/// Used to check disk space and write permissions even when
/// the target path does not yet exist. Walks up the path until an
/// existing directory is found.
fn find_existing_parent(path: &str) -> String {
    let mut p = Path::new(path);
    while !p.exists() {
        match p.parent() {
            Some(parent) => {
                p = parent;
            }
            None => {
                // No more parent directories found - fallback to root
                return "/".into();
            }
        }
    }
    p.to_string_lossy().into_owned()
}

/// Determines the free disk space in gigabytes for a given path.
///
/// Uses the POSIX system call `statvfs` to query filesystem statistics.
/// `f_bavail` returns the blocks available to non-privileged users,
/// `f_frsize` the block size in bytes.
fn get_free_space_gb(path: &str) -> u64 {
    use std::ffi::CString;

    let c_path = match CString::new(path) {
        Ok(p) => p,
        Err(_) => {
            return 0;
        }
    };

    // SAFETY: c_path is a valid, NUL-terminated CString. statvfs is zero-initialized
    // and only read after a successful statvfs() call.
    unsafe {
        let mut stat: libc::statvfs = std::mem::zeroed();
        if libc::statvfs(c_path.as_ptr(), &mut stat) == 0 {
            // Available bytes = available blocks x block size
            let free_bytes = stat.f_bavail * stat.f_frsize;
            free_bytes / (1024 * 1024 * 1024)
        } else {
            0
        }
    }
}

/// Checks whether the current user has write permissions on a path.
///
/// Analyzes Unix file permissions (owner/group/other) and compares
/// them with the UID/GID of the current process. Root (UID 0) always has write permissions.
fn is_writable(path: &str) -> bool {
    let p = Path::new(path);
    if !p.exists() {
        return false;
    }
    match fs::metadata(p) {
        Ok(meta) => {
            let mode = meta.mode();
            let uid = meta.uid();
            let gid = meta.gid();
            // SAFETY: getuid/getgid are always safe to call, no preconditions
            let my_uid = unsafe { libc::getuid() };
            let my_gid = unsafe { libc::getgid() };

            // Root always has write access
            if my_uid == 0 {
                return true;
            }
            // Check owner write bit (bit 7, octal 0o200)
            if uid == my_uid {
                return (mode & 0o200) != 0;
            }
            // Check group write bit (bit 4, octal 0o020)
            if gid == my_gid {
                return (mode & 0o020) != 0;
            }
            // Check other write bit (bit 1, octal 0o002)
            (mode & 0o002) != 0
        }
        Err(_) => false,
    }
}

/// Returns the path to the configuration file (`~/.config/penguin-citizen/config.json`).
/// Returns `None` if the configuration directory cannot be determined.
fn config_file_path() -> Option<String> {
    dirs::config_dir().map(|p| {
        p.join("penguin-citizen").join("config.json").to_string_lossy().into_owned()
    })
}

/// Result of checking whether initial setup is needed.
#[derive(Serialize, Deserialize)]
pub struct SetupCheck {
    /// Whether the setup wizard needs to be shown
    pub needs_setup: bool,
    /// Suggested default installation path
    pub default_path: String,
}

// --- Tauri commands ---
// These functions are called from the frontend via `invoke()`.
// All blocking filesystem operations are executed in `spawn_blocking`
// to avoid blocking the Tokio runtime thread.

/// Checks whether initial setup needs to be performed.
///
/// Setup is needed if no configuration file exists
/// or the stored installation path does not point to an existing
/// directory.
#[tauri::command]
pub async fn check_needs_setup() -> Result<SetupCheck, AppError> {
    tokio::task
        ::spawn_blocking(move || {
            // Default installation path: ~/Games/star-citizen, fallback to /tmp
            let default_path = if let Ok(home) = std::env::var("HOME") {
                format!("{}/Games/star-citizen", home)
            } else {
                "/tmp/star-citizen".into()
            };

            // Check if a valid configuration with an existing installation path is present
            let has_valid_install = config_file_path()
                .and_then(|p| fs::read_to_string(p).ok())
                .and_then(|c| serde_json::from_str::<AppConfig>(&c).ok())
                .map(|cfg| {
                    let path = expand_tilde(&cfg.install_path);
                    !path.is_empty() && Path::new(&path).exists()
                })
                .unwrap_or(false);

            SetupCheck {
                needs_setup: !has_valid_install,
                default_path,
            }
        }).await
        .map_err(|e| AppError::Task(e.to_string()))
}

/// Creates the installation directory recursively (including all parent directories).
#[tauri::command]
pub async fn create_install_directory(path: String) -> Result<(), AppError> {
    tokio::task
        ::spawn_blocking(move || {
            let expanded = expand_tilde(&path);
            fs::create_dir_all(&expanded).map_err(|e| format!("Failed to create directory: {}", e))
        }).await
        .map_err(|e| AppError::Task(e.to_string()))?
        .map_err(Into::into)
}

/// Validates an installation path for write permissions and sufficient disk space.
///
/// Checks the nearest existing parent directory, since the target path
/// may not yet exist. Requires at least 100 GB of free space.
#[tauri::command]
pub async fn validate_install_path(path: String) -> Result<PathValidation, AppError> {
    tokio::task
        ::spawn_blocking(move || {
            let expanded = expand_tilde(&path);

            if expanded.is_empty() {
                return PathValidation {
                    valid: false,
                    writable: false,
                    free_space_gb: 0,
                    space_sufficient: false,
                    message: "Path cannot be empty".into(),
                };
            }

            let existing_parent = find_existing_parent(&expanded);
            let writable = is_writable(&existing_parent);
            let free_space_gb = get_free_space_gb(&existing_parent);
            let space_sufficient = free_space_gb >= 100;

            let (valid, message) = if !writable {
                (false, format!("No write permission on {}", existing_parent))
            } else if !space_sufficient {
                (
                    false,
                    format!("{} GB free (100 GB required) at {}", free_space_gb, existing_parent),
                )
            } else {
                (true, format!("{} GB free at {}", free_space_gb, existing_parent))
            };

            PathValidation {
                valid,
                writable,
                free_space_gb,
                space_sufficient,
                message,
            }
        }).await
        .map_err(|e| AppError::Task(e.to_string()))
}

/// Scans the `runners/` directory for locally installed Wine runners.
///
/// A valid runner is detected if it contains a wine binary in a known layout.
/// Results are returned sorted alphabetically by name.
#[tauri::command]
pub async fn scan_runners(base_path: String) -> Result<ScanRunnersResult, AppError> {
    tokio::task
        ::spawn_blocking(move || {
            let expanded = expand_tilde(&base_path);
            let runners_dir = Path::new(&expanded).join("runners");
            let runners_dir_str = runners_dir.to_string_lossy().into_owned();

            let mut runners = Vec::new();

            // Search all subdirectories in the runners/ folder
            if runners_dir.is_dir() {
                if let Ok(entries) = fs::read_dir(&runners_dir) {
                    for entry in entries.flatten() {
                        let entry_path = entry.path();
                        // Only directories are potential runners
                        if !entry_path.is_dir() {
                            continue;
                        }

                        // Check known wine binary locations (standard Wine + Proton layouts)
                        if let Some(wine_exe) = resolve_wine_bin(&entry_path) {
                            let name = entry_path
                                .file_name()
                                .unwrap_or_default()
                                .to_string_lossy()
                                .into_owned();
                            let bin_path = wine_exe.parent().unwrap().to_string_lossy().into_owned();
                            let wine_executable = wine_exe.to_string_lossy().into_owned();

                            runners.push(DetectedRunner {
                                name,
                                bin_path,
                                wine_executable,
                            });
                        }
                    }
                }
            }

            runners.sort_by(|a, b| a.name.cmp(&b.name));

            ScanRunnersResult {
                runners,
                runners_dir: runners_dir_str,
            }
        }).await
        .map_err(|e| AppError::Task(e.to_string()))
}

/// Saves the configuration to the JSON file.
///
/// Performs an intelligent merge with the existing configuration
/// so that fields not managed by the frontend (e.g. github_token,
/// runner_sources) are not accidentally overwritten or deleted.
#[tauri::command]
pub async fn save_config(config: AppConfig) -> Result<(), AppError> {
    // Validate custom environment variable keys before saving
    for env_var in &config.performance.custom_env_vars {
        validate_env_var_key(&env_var.key)?;
    }

    tokio::task
        ::spawn_blocking(move || -> Result<(), String> {
            let path = config_file_path().ok_or("Could not determine config directory")?;
            let config_path = Path::new(&path);

            // Create configuration directory if it does not yet exist
            if let Some(parent) = config_path.parent() {
                fs
                    ::create_dir_all(parent)
                    .map_err(|e| format!("Failed to create config directory: {}", e))?;
            }

            // Merge with existing configuration to preserve fields
            // that the frontend does not send
            let defaults = AppConfig::default();
            let merged = if
                let Some(existing) = config_path
                    .exists()
                    .then(|| fs::read_to_string(config_path).ok())
                    .flatten()
                    .and_then(|c| serde_json::from_str::<AppConfig>(&c).ok())
            {
                // Preserve runner sources: use existing ones if available,
                // otherwise apply defaults
                let runner_sources = if
                    existing.runner_sources.is_empty() &&
                    config.runner_sources.is_empty()
                {
                    defaults.runner_sources.clone()
                } else if config.runner_sources.is_empty() {
                    existing.runner_sources
                } else {
                    config.runner_sources
                };

                AppConfig {
                    // GitHub token: empty string = explicit deletion,
                    // Some = new value, None = keep existing token
                    github_token: match &config.github_token {
                        Some(t) if t.is_empty() => None,
                        Some(_) => config.github_token,
                        None => existing.github_token,
                    },
                    runner_sources,
                    // Empty strings mean "not sent by the frontend" -> keep existing value
                    install_mode: if config.install_mode.is_empty() {
                        existing.install_mode
                    } else {
                        config.install_mode
                    },
                    ..config
                }
            } else {
                // No existing configuration - use provided values,
                // fill in missing fields with defaults
                AppConfig {
                    runner_sources: if config.runner_sources.is_empty() {
                        defaults.runner_sources
                    } else {
                        config.runner_sources
                    },
                    github_token: config.github_token,
                    install_path: config.install_path,
                    selected_runner: config.selected_runner,
                    performance: config.performance,
                    log_level: if config.log_level.is_empty() {
                        defaults.log_level
                    } else {
                        config.log_level
                    },
                    auto_backup_on_launch: config.auto_backup_on_launch,
                    install_mode: if config.install_mode.is_empty() {
                        defaults.install_mode
                    } else {
                        config.install_mode
                    },
                    ui_scale: config.ui_scale,
                    language: config.language,
                }
            };

            let json = serde_json
                ::to_string_pretty(&merged)
                .map_err(|e| format!("Failed to serialize config: {}", e))?;

            fs::write(config_path, json).map_err(|e| format!("Failed to write config: {}", e))?;

            Ok(())
        }).await
        .map_err(|e| AppError::Task(e.to_string()))?
        .map_err(Into::into)
}

/// Loads the configuration from the JSON file.
///
/// Returns `None` if the file does not exist or cannot be read.
/// If the runner sources are empty, the default sources are inserted and
/// immediately written back to the file so they are available on the next load.
#[tauri::command]
pub async fn load_config() -> Result<Option<AppConfig>, AppError> {
    tokio::task
        ::spawn_blocking(move || {
            let path = match config_file_path() {
                Some(p) => p,
                None => {
                    return None;
                }
            };
            let contents = match fs::read_to_string(&path) {
                Ok(c) => c,
                Err(e) => {
                    eprintln!("[config] Failed to read config file {}: {}", path, e);
                    return None;
                }
            };
            let config: AppConfig = match serde_json::from_str(&contents) {
                Ok(c) => c,
                Err(e) => {
                    eprintln!("[config] Failed to parse config JSON: {}", e);
                    return None;
                }
            };

            // If no runner sources are configured, insert defaults
            // and write to file immediately so they are persistently available
            let defaults = AppConfig::default();
            if config.runner_sources.is_empty() {
                let new_config = AppConfig {
                    runner_sources: defaults.runner_sources.clone(),
                    ..config
                };
                if let Ok(json) = serde_json::to_string_pretty(&new_config) {
                    let _ = fs::write(&path, json);
                }
                return Some(new_config);
            }

            Some(config)
        }).await
        .map_err(|e| AppError::Task(e.to_string()))
}

/// Resets the entire application to its initial state.
///
/// Deletes the installation directory (including runners, Wine prefix, game data),
/// the configuration file, and the cache. However, the GitHub token is preserved
/// since it must be manually entered and should not be lost.
#[tauri::command]
pub async fn reset_app() -> Result<(), AppError> {
    let config_path = config_file_path().ok_or(AppError::Config("Could not determine config directory".into()))?;
    let cache_path = cache_file_path();

    // Load existing configuration to determine installation path and token
    let existing: Option<AppConfig> = fs
        ::read_to_string(&config_path)
        .ok()
        .and_then(|c| serde_json::from_str(&c).ok());

    let install_path = existing
        .as_ref()
        .map(|c| expand_tilde(&c.install_path))
        .unwrap_or_default();
    let github_token = existing.as_ref().and_then(|c| c.github_token.clone());

    // Completely delete the installation directory (runners, prefix, game data)
    if !install_path.is_empty() {
        let p = Path::new(&install_path);
        if p.exists() {
            fs::remove_dir_all(p)?;
        }
    }

    // Remove configuration file
    let _ = fs::remove_file(&config_path);

    // Remove cache file
    if let Some(cp) = cache_path {
        let _ = fs::remove_file(&cp);
    }

    // Preserve the GitHub token in a minimal configuration
    // so the user does not have to enter it again
    if let Some(token) = github_token {
        let minimal = AppConfig {
            github_token: Some(token),
            ..AppConfig::default()
        };
        if let Ok(json) = serde_json::to_string_pretty(&minimal) {
            if let Some(parent) = Path::new(&config_path).parent() {
                let _ = fs::create_dir_all(parent);
            }
            let _ = fs::write(&config_path, json);
        }
    }

    Ok(())
}

// --- Cache commands ---
// The cache functions store and load runner and DXVK data separately,
// but in the same JSON file (AppCache). When saving, the existing file
// is loaded and only the relevant part is updated so that the other
// part (e.g. DXVK during a runner update) is not lost.

/// Loads the runner cache from the cache file.
/// Returns an empty cache if the file does not exist or is invalid.
#[tauri::command]
pub async fn load_runner_cache() -> Result<RunnerCache, AppError> {
    tokio::task
        ::spawn_blocking(move || {
            let path = match cache_file_path() {
                Some(p) => p,
                None => {
                    return RunnerCache::default();
                }
            };
            let contents = match fs::read_to_string(&path) {
                Ok(c) => c,
                Err(_) => {
                    return RunnerCache::default();
                }
            };
            let cache: AppCache = match serde_json::from_str(&contents) {
                Ok(c) => c,
                Err(_) => {
                    return RunnerCache::default();
                }
            };
            cache.runners
        }).await
        .map_err(|e| AppError::Task(e.to_string()))
}

/// Saves the runner data to the cache with the current timestamp.
///
/// Loads the existing cache, updates only the runner part, and writes
/// the entire file back so the DXVK cache is preserved.
#[tauri::command]
pub async fn save_runner_cache(runners: Vec<CachedRunner>) -> Result<(), AppError> {
    // Set current Unix timestamp to record the time of caching
    let runners_cache = RunnerCache {
        runners,
        cached_at: std::time::SystemTime
            ::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0),
    };

    let result = tokio::task::spawn_blocking(move || {
        let path = match cache_file_path() {
            Some(p) => p,
            None => {
                return Err("Could not determine cache directory".to_string());
            }
        };
        let cache_path = Path::new(&path);

        if let Some(parent) = cache_path.parent() {
            if let Err(e) = fs::create_dir_all(parent) {
                return Err(format!("Failed to create cache directory: {}", e));
            }
        }

        // Load existing cache to preserve the DXVK part
        let mut cache = if cache_path.exists() {
            fs::read_to_string(&path)
                .ok()
                .and_then(|c| serde_json::from_str(&c).ok())
                .unwrap_or_default()
        } else {
            AppCache::default()
        };

        // Only update the runner part
        cache.runners = runners_cache;

        let json = match serde_json::to_string_pretty(&cache) {
            Ok(j) => j,
            Err(e) => {
                return Err(format!("Failed to serialize cache: {}", e));
            }
        };

        if let Err(e) = fs::write(cache_path, json) {
            return Err(format!("Failed to write cache: {}", e));
        }

        Ok(())
    }).await;

    result.map_err(|e| AppError::Task(e.to_string()))?.map_err(Into::into)
}

/// Loads the DXVK cache from the cache file.
/// Returns an empty cache if the file does not exist or is invalid.
#[tauri::command]
pub async fn load_dxvk_cache() -> Result<DxvkCache, AppError> {
    tokio::task
        ::spawn_blocking(move || {
            let path = match cache_file_path() {
                Some(p) => p,
                None => {
                    return DxvkCache::default();
                }
            };
            let contents = match fs::read_to_string(&path) {
                Ok(c) => c,
                Err(_) => {
                    return DxvkCache::default();
                }
            };
            let cache: AppCache = match serde_json::from_str(&contents) {
                Ok(c) => c,
                Err(_) => {
                    return DxvkCache::default();
                }
            };
            cache.dxvk
        }).await
        .map_err(|e| AppError::Task(e.to_string()))
}

/// Saves the DXVK release data to the cache with the current timestamp.
///
/// Works analogously to `save_runner_cache` - loads the existing cache,
/// updates only the DXVK part, and preserves the runner cache.
#[tauri::command]
pub async fn save_dxvk_cache(releases: Vec<CachedDxvkRelease>) -> Result<(), AppError> {
    // Set current Unix timestamp
    let dxvk_cache = DxvkCache {
        releases,
        cached_at: std::time::SystemTime
            ::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0),
    };

    let result = tokio::task::spawn_blocking(move || {
        let path = match cache_file_path() {
            Some(p) => p,
            None => {
                return Err("Could not determine cache directory".to_string());
            }
        };
        let cache_path = Path::new(&path);

        if let Some(parent) = cache_path.parent() {
            if let Err(e) = fs::create_dir_all(parent) {
                return Err(format!("Failed to create cache directory: {}", e));
            }
        }

        // Load existing cache to preserve the runner part
        let mut cache = if cache_path.exists() {
            fs::read_to_string(&path)
                .ok()
                .and_then(|c| serde_json::from_str(&c).ok())
                .unwrap_or_default()
        } else {
            AppCache::default()
        };

        // Only update the DXVK part
        cache.dxvk = dxvk_cache;

        let json = match serde_json::to_string_pretty(&cache) {
            Ok(j) => j,
            Err(e) => {
                return Err(format!("Failed to serialize cache: {}", e));
            }
        };

        if let Err(e) = fs::write(cache_path, json) {
            return Err(format!("Failed to write cache: {}", e));
        }

        Ok(())
    }).await;

    result.map_err(|e| AppError::Task(e.to_string()))?.map_err(Into::into)
}

// --- Runner source management ---
// Runner sources can be added individually or imported as a predefined set
// (LUG helper sources).

/// Result of adding a new runner source.
#[derive(Serialize, Deserialize)]
pub struct AddRunnerSourceResult {
    /// Whether the addition was successful
    pub success: bool,
    /// Status message for the UI display
    pub message: String,
    /// Names of the newly added sources
    pub added_sources: Vec<String>,
}

/// Adds a new runner source from a GitHub API URL.
///
/// Validates the inputs (name not empty, valid GitHub API URL) and
/// checks for duplicates. The filter is automatically determined based on
/// the name: "kron4ek" for Kron4ek builds (special naming scheme),
/// "all" for all other sources.
#[tauri::command]
pub async fn add_runner_source_from_github(
    name: String,
    api_url: String
) -> Result<AddRunnerSourceResult, AppError> {
    let name = name.trim().to_string();
    let api_url = api_url.trim().to_string();

    // Input validation
    if name.is_empty() {
        return Err(AppError::Validation("Name cannot be empty".into()));
    }
    if api_url.is_empty() {
        return Err(AppError::Validation("API URL cannot be empty".into()));
    }

    // Check URL format - only GitHub API URLs are supported
    let parsed_url = reqwest::Url::parse(&api_url).map_err(|_| {
        AppError::Validation("URL must be a valid GitHub API URL (e.g., https://api.github.com/repos/owner/repo/releases)".into())
    })?;
    if parsed_url.host_str() != Some("api.github.com") || !parsed_url.path().starts_with("/repos/") {
        return Err(AppError::Validation(
            "URL must be a GitHub API URL (e.g., https://api.github.com/repos/owner/repo/releases)".into()
        ));
    }

    tokio::task
        ::spawn_blocking(move || {
            let config_path = match config_file_path() {
                Some(p) => Path::new(&p).to_path_buf(),
                None => {
                    return Err("Could not determine config directory".to_string());
                }
            };

            // Load existing configuration or use defaults
            let mut config = if config_path.exists() {
                let contents = fs::read_to_string(&config_path).map_err(|e| e.to_string())?;
                serde_json::from_str::<AppConfig>(&contents).map_err(|e| e.to_string())?
            } else {
                AppConfig::default()
            };

            // Check for duplicates by name
            if config.runner_sources.iter().any(|s| s.name == name) {
                return Ok(AddRunnerSourceResult {
                    success: false,
                    message: format!("Source '{}' already exists", name),
                    added_sources: vec![],
                });
            }

            // Automatically determine filter: Kron4ek builds have a special
            // naming scheme and need their own filter
            let filter = if name.to_lowercase().contains("kron4ek") {
                Some("kron4ek".into())
            } else {
                Some("all".into())
            };

            // Add new source to the list
            config.runner_sources.push(RunnerSourceConfig {
                name: name.clone(),
                api_url: api_url.clone(),
                filter,
                enabled: true,
            });

            // Save config
            let json = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
            fs::write(&config_path, json).map_err(|e| e.to_string())?;

            Ok(AddRunnerSourceResult {
                success: true,
                message: format!("Added source '{}'", name),
                added_sources: vec![name],
            })
        }).await
        .map_err(|e| AppError::Task(e.to_string()))?
        .map_err(Into::into)
}

/// Imports the predefined runner sources from the LUG helper project.
///
/// LUG (Linux Users Group) provides special Wine builds optimized for
/// Star Citizen. This function adds all four default sources
/// (LUG, LUG Experimental, RawFox, Kron4ek) and skips already
/// existing sources (duplicate check by name).
#[tauri::command]
pub async fn import_lug_helper_sources() -> Result<AddRunnerSourceResult, AppError> {
    // Predefined LUG helper Wine runner sources
    // (based on https://github.com/starcitizen-lug/lug-helper)
    let lug_sources = vec![
        ("LUG", "https://api.github.com/repos/starcitizen-lug/lug-wine/releases"),
        (
            "LUG Experimental",
            "https://api.github.com/repos/starcitizen-lug/lug-wine-experimental/releases",
        ),
        ("RawFox", "https://api.github.com/repos/starcitizen-lug/raw-wine/releases"),
        ("Kron4ek", "https://api.github.com/repos/Kron4ek/Wine-Builds/releases")
    ];

    tokio::task
        ::spawn_blocking(move || {
            let config_path = match config_file_path() {
                Some(p) => Path::new(&p).to_path_buf(),
                None => {
                    return Err("Could not determine config directory".to_string());
                }
            };

            // Load existing configuration
            let mut config = if config_path.exists() {
                let contents = fs::read_to_string(&config_path).map_err(|e| e.to_string())?;
                serde_json::from_str::<AppConfig>(&contents).map_err(|e| e.to_string())?
            } else {
                AppConfig::default()
            };

            let mut added_sources = Vec::new();

            // Check each source individually and only add new ones
            for (name, api_url) in lug_sources {
                // Duplicate check: only add if the name does not yet exist
                if !config.runner_sources.iter().any(|s| s.name == name) {
                    // Determine filter based on the source name
                    let filter = if name.to_lowercase().contains("kron4ek") {
                        Some("kron4ek".into())
                    } else {
                        Some("all".into())
                    };

                    config.runner_sources.push(RunnerSourceConfig {
                        name: name.to_string(),
                        api_url: api_url.to_string(),
                        filter,
                        enabled: true,
                    });
                    added_sources.push(name.to_string());
                }
            }

            // Save configuration (even if no new sources were added)
            let json = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
            fs::write(&config_path, json).map_err(|e| e.to_string())?;

            let message = if added_sources.is_empty() {
                "All LUG sources already configured".to_string()
            } else {
                format!("Added {} new source(s)", added_sources.len())
            };

            Ok(AddRunnerSourceResult {
                success: true,
                message,
                added_sources,
            })
        }).await
        .map_err(|e| AppError::Task(e.to_string()))?
        .map_err(Into::into)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_config_default_has_sensible_values() {
        let config = AppConfig::default();
        assert!(config.install_path.is_empty());
        assert!(config.selected_runner.is_none());
        assert_eq!(config.log_level, "info");
        assert_eq!(config.install_mode, "full");
        assert_eq!(config.ui_scale, 1.0);
        assert!(config.language.is_none());
    }

    #[test]
    fn performance_defaults_enable_core_features() {
        let perf = PerformanceSettings::default();
        assert!(perf.esync);
        assert!(perf.fsync);
        assert!(perf.dxvk_async);
        assert!(perf.wayland);
        assert!(!perf.mangohud);
        assert!(!perf.dxvk_hud);
    }

    #[test]
    fn app_config_serialization_roundtrip() {
        let config = AppConfig {
            install_path: "~/Games/star-citizen".into(),
            selected_runner: Some("wine-ge-proton8-25".into()),
            performance: PerformanceSettings {
                mangohud: true,
                custom_env_vars: vec![CustomEnvVar {
                    key: "WINEDEBUG".into(),
                    value: "-all".into(),
                    enabled: true,
                }],
                ..Default::default()
            },
            github_token: Some("ghp_test123".into()),
            log_level: "debug".into(),
            auto_backup_on_launch: Some(true),
            runner_sources: vec![RunnerSourceConfig {
                name: "LUG".into(),
                api_url: "https://api.github.com/repos/starcitizen-lug/lug-wine/releases".into(),
                filter: Some("all".into()),
                enabled: true,
            }],
            install_mode: "quick".into(),
            ui_scale: 1.25,
            language: Some("de".into()),
        };

        let json = serde_json::to_string_pretty(&config).unwrap();
        let restored: AppConfig = serde_json::from_str(&json).unwrap();

        assert_eq!(restored.install_path, config.install_path);
        assert_eq!(restored.selected_runner, config.selected_runner);
        assert!(restored.performance.mangohud);
        assert_eq!(restored.performance.custom_env_vars.len(), 1);
        assert_eq!(restored.performance.custom_env_vars[0].key, "WINEDEBUG");
        assert_eq!(restored.github_token, config.github_token);
        assert_eq!(restored.log_level, "debug");
        assert_eq!(restored.runner_sources.len(), 1);
        assert_eq!(restored.runner_sources[0].name, "LUG");
        assert_eq!(restored.install_mode, "quick");
        assert_eq!(restored.ui_scale, 1.25);
        assert_eq!(restored.language, Some("de".into()));
    }

    #[test]
    fn app_config_deserializes_with_missing_fields() {
        // Simulate an older config that's missing newer fields
        let json = r#"{"install_path": "/tmp/sc", "log_level": "info"}"#;
        let config: AppConfig = serde_json::from_str(json).unwrap();
        assert_eq!(config.install_path, "/tmp/sc");
        assert!(config.selected_runner.is_none());
        assert_eq!(config.ui_scale, 1.0);
        assert!(config.performance.esync); // default should be true
    }

    #[test]
    fn custom_env_var_roundtrip() {
        let var = CustomEnvVar {
            key: "DXVK_HUD".into(),
            value: "fps,frametimes".into(),
            enabled: false,
        };
        let json = serde_json::to_string(&var).unwrap();
        let restored: CustomEnvVar = serde_json::from_str(&json).unwrap();
        assert_eq!(restored.key, "DXVK_HUD");
        assert!(!restored.enabled);
    }

    #[test]
    fn gamescope_settings_default() {
        let gs = GamescopeSettings::default();
        assert!(!gs.enabled);
        assert!(gs.width.is_none());
    }

    #[test]
    fn get_system_locale_returns_nonempty() {
        let locale = get_system_locale();
        assert!(!locale.is_empty());
        assert!(locale.len() >= 2);
    }
}
