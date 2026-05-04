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

//! Penguin Citizen Library – Main library of the Tauri application.
//!
//! This is the central library crate of Penguin Citizen, a desktop application
//! for managing Star Citizen on Linux with Wine/Proton.
//!
//! ## Modules
//!
//! - `config`: Application configuration management (installation paths, runner sources, etc.)
//! - `dashboard`: RSI news, server status and community statistics from the RSI website
//! - `dxvk`: Installation and detection of DXVK (DirectX-to-Vulkan translation layer)
//! - `installer`: Game installation and launching the RSI Launcher / the game itself
//! - `localization`: Language pack management for Star Citizen (e.g. German translation)
//! - `prefix_tools`: Wine prefix tools (winecfg, DPI settings, PowerShell)
//! - `runners`: Wine/Proton runner management (download, install, delete)
//! - `sc_config`: Star Citizen configuration, profile management and binding editor
//! - `system_check`: System requirements check (vm.max_map_count, file limits, etc.)
//! - `binding_capture`: Input device event capture (joysticks, gamepads) for the binding editor
//! - `action_definitions`: Definitions of available actions/key bindings in the game
//!
//! ## Window State
//!
//! The application saves the window's position, size and scale factor on close
//! and restores them on the next start, so the user can seamlessly continue working.

use tauri::Manager;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;

// Global flag to store if the app was started with --screenshots
static IS_SCREENSHOT_MODE: AtomicBool = AtomicBool::new(false);

/// XWayland compensation factor, computed once at startup from Xft.dpi.
/// Used by save/restore_window_state to normalize sizes across environments.
static XWAYLAND_COMPENSATION: OnceLock<f64> = OnceLock::new();

// ── Module Declarations ──
// Each module encapsulates a self-contained functional area of the application.
pub(crate) mod error;
mod util;
mod config;
mod dashboard;
mod dxvk;
mod installer;
mod localization;
mod prefix_tools;
mod binding_capture;
// binding_database was removed – bindings are now managed per profile in sc_config
mod runners;
mod launch_profiles;
mod sc_config;
mod shader_cache;
mod system_check;
mod action_definitions;

// simplelog is used for file-based logging (writes to ~/.config/penguin-citizen/logs/debug.log)
use simplelog::{ CombinedLogger, WriteLogger, TermLogger, LevelFilter, ConfigBuilder, TerminalMode, ColorChoice };
use std::fs::File;

/// Initializes the logging system with file output.
///
/// Logs are written to `~/.config/penguin-citizen/logs/debug.log`.
/// This function is called once at app startup, before other
/// components are initialized. The frontend can also log to this file
/// via the `app_log` command.
/// Marker substring written by `init_logging` once per app start.
/// Used by `rotate_log_file` to identify session boundaries.
const LOG_START_MARKER: &str = "Logging initialized. Log file:";

/// How many previous startups' log content to preserve. The current run is
/// always appended on top, so the file ends up with `KEEP_PREVIOUS_STARTS + 1`
/// sessions worth of logs after `init_logging` returns.
const KEEP_PREVIOUS_STARTS: usize = 1;

/// Truncates `path` to keep only the last `keep_previous_starts` sessions
/// (delimited by `LOG_START_MARKER`). If the file has fewer markers than
/// requested it is left untouched. If `keep_previous_starts` is 0, the file
/// is fully cleared. Errors are swallowed — log rotation is best-effort.
fn rotate_log_file(path: &std::path::Path, keep_previous_starts: usize) {
    if !path.exists() {
        return;
    }
    if keep_previous_starts == 0 {
        let _ = std::fs::write(path, "");
        return;
    }
    let content = match std::fs::read_to_string(path) {
        Ok(c) => c,
        Err(_) => return,
    };
    let lines: Vec<&str> = content.lines().collect();
    let marker_lines: Vec<usize> = lines
        .iter()
        .enumerate()
        .filter_map(|(i, l)| if l.contains(LOG_START_MARKER) { Some(i) } else { None })
        .collect();
    if marker_lines.len() <= keep_previous_starts {
        return;
    }
    let cutoff_marker = marker_lines.len() - keep_previous_starts;
    let cutoff_line = marker_lines[cutoff_marker];
    let kept = lines[cutoff_line..].join("\n");
    // Re-add a trailing newline so subsequent appends start on a fresh line
    let _ = std::fs::write(path, format!("{}\n", kept));
}

fn init_logging() {
    // Determine log directory (XDG_CONFIG_HOME or fallback to current directory)
    let log_dir = dirs
        ::config_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join("penguin-citizen")
        .join("logs");

    // Create directory if it does not exist yet
    let _ = std::fs::create_dir_all(&log_dir);

    let log_file_path = log_dir.join("debug.log");

    // Rotate before opening so the new session starts on top of at most
    // KEEP_PREVIOUS_STARTS previous sessions.
    rotate_log_file(&log_file_path, KEEP_PREVIOUS_STARTS);

    // Open log file in append mode (or create new), so logs persist across
    // multiple sessions
    let log_file = match File::options().create(true).append(true).open(&log_file_path) {
        Ok(file) => file,
        Err(e) => {
            eprintln!("Failed to open log file: {}", e);
            return;
        }
    };

    // Filter out verbose third-party debug spam.
    // Only the specific high-volume debug sub-modules are silenced; warn/error from reqwest
    // (TLS failures, unexpected redirects) are NOT suppressed because we filter by exact
    // module path rather than the top-level "reqwest" prefix.
    // gilrs_core and gilrs::gamepad produce multi-KB per-device debug dumps on every connect.
    let filter_config = ConfigBuilder::new()
        .add_filter_ignore("reqwest::connect".to_string())
        .add_filter_ignore("reqwest::async_impl::client".to_string())
        .add_filter_ignore("gilrs_core".to_string())
        .add_filter_ignore("gilrs::gamepad".to_string())
        .build();

    let logger = CombinedLogger::init(
        vec![
            // Terminal: Debug — app debug output visible during development, no third-party noise.
            TermLogger::new(LevelFilter::Debug, filter_config.clone(), TerminalMode::Mixed, ColorChoice::Auto),
            // File: Info — only meaningful events land in debug.log.
            WriteLogger::new(LevelFilter::Info, filter_config, log_file)
        ]
    );

    match logger {
        Ok(_) => {
            log::info!("Logging initialized. Log file: {:?}", log_file_path);
        }
        Err(e) => {
            eprintln!("Failed to initialize logger: {}", e);
        }
    }
}

/// Receives log messages from the JavaScript frontend and forwards them to Rust logging.
///
/// Called from the frontend via `debugLog(category, level, message)`.
/// This places frontend and backend logs together in the same log file,
/// which greatly simplifies debugging.
#[tauri::command]
fn app_log(level: String, category: String, message: String) {
    let full_message = format!("[{}] {}", category, message);
    // Map the frontend log level to the corresponding Rust log level
    match level.as_str() {
        "error" => log::error!("{}", full_message),
        "warn" => log::warn!("{}", full_message),
        "info" => log::info!("{}", full_message),
        _ => log::debug!("{}", full_message),
    }
}

/// Returns the file path to the debug log file.
///
/// Used by the frontend to display the path to the user or
/// to open the file e.g. in a file manager.
#[tauri::command]
fn get_log_file_path() -> String {
    dirs::config_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join("penguin-citizen")
        .join("logs")
        .join("debug.log")
        .to_string_lossy()
        .to_string()
}

#[tauri::command]
fn is_screenshot_mode() -> bool {
    IS_SCREENSHOT_MODE.load(Ordering::Relaxed)
}

/// Returns display and scaling information for debugging scaling issues.
///
/// Detects whether the app is running under XWayland (e.g. AppImage with
/// `GDK_BACKEND=x11` on a Wayland session), reports the Tauri scale factor,
/// and lists all available monitors with their sizes and scale factors.
#[tauri::command]
fn get_display_info(window: tauri::WebviewWindow) -> serde_json::Value {
    let gdk_backend = std::env::var("GDK_BACKEND").unwrap_or_default();
    let wayland_display = std::env::var("WAYLAND_DISPLAY").unwrap_or_default();
    let scale_factor = window.scale_factor().unwrap_or(1.0);

    let monitors: Vec<serde_json::Value> = if let Ok(monitors) = window.available_monitors() {
        monitors.iter().map(|m| {
            let size = m.size();
            serde_json::json!({
                "name": m.name().cloned().unwrap_or_default(),
                "width": size.width,
                "height": size.height,
                "scale_factor": m.scale_factor(),
            })
        }).collect()
    } else {
        vec![]
    };

    let is_xwayland = gdk_backend == "x11" && !wayland_display.is_empty();

    let expected_scale = if is_xwayland { query_xft_scale() } else { 1.0 };
    let xft_dpi: Option<f64> = if is_xwayland {
        Some(expected_scale * 96.0)
    } else {
        None
    };

    serde_json::json!({
        "gdk_backend": gdk_backend,
        "is_wayland_session": !wayland_display.is_empty(),
        "is_xwayland": is_xwayland,
        "tauri_scale_factor": scale_factor,
        "expected_scale": expected_scale,
        "xft_dpi": xft_dpi,
        "monitors": monitors,
    })
}

/// Simple test command to verify the Tauri command infrastructure.
/// Can be used to test the IPC connection between frontend and backend.
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! Welcome to Penguin Citizen.", name)
}

// ── Window State ──
// The window state is saved on close and restored on start,
// so the window always appears at the same position and size.

/// Returns the path to the window state file (`~/.config/penguin-citizen/window-state.json`).
fn window_state_path() -> Option<std::path::PathBuf> {
    dirs::config_dir().map(|p| p.join("penguin-citizen").join("window-state.json"))
}

/// Represents the saved window state.
///
/// All coordinates and sizes are stored in **logical** units
/// (not physical pixels), so the values work independently of
/// the monitor's scale factor.
#[derive(serde::Serialize, serde::Deserialize)]
struct WindowState {
    /// Window width in logical units
    width: u32,
    /// Window height in logical units
    height: u32,
    /// X position of the window (logical)
    x: i32,
    /// Y position of the window (logical)
    y: i32,
    /// Whether the window was maximized
    maximized: bool,
    /// Monitor scale factor at the time of saving (e.g. 1.0, 1.25, 2.0)
    #[serde(default = "default_scale")]
    scale: f64,
}

/// Default scale factor (1.0 = 100%), used when the value
/// is missing from an older configuration file.
fn default_scale() -> f64 {
    1.0
}

/// Loads the saved window state from the JSON file.
///
/// Returns `None` if the file does not exist (first launch)
/// or cannot be read/parsed.
fn load_window_state() -> Option<WindowState> {
    let path = window_state_path()?;
    let data = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&data).ok()
}

/// Saves the current window state to the JSON file.
///
/// Called when the window is closed (CloseRequested event).
/// The Tauri API returns physical pixels, which are converted here to logical units,
/// so the values can be correctly restored across different scale factors.
fn save_window_state_from(window: &tauri::WebviewWindow) {
    if let Some(path) = window_state_path() {
        // Query current window data – abort on errors
        let Ok(size) = window.inner_size() else {
            return;
        };
        let Ok(pos) = window.outer_position() else {
            return;
        };
        let Ok(scale) = window.scale_factor() else {
            return;
        };
        let maximized = window.is_maximized().unwrap_or(false);

        // Convert physical pixels to logical units (division by scale factor)
        let mut logical_width = ((size.width as f64) / scale) as u32;
        let mut logical_height = ((size.height as f64) / scale) as u32;
        let logical_x = ((pos.x as f64) / scale) as i32;
        let logical_y = ((pos.y as f64) / scale) as i32;

        // Under XWayland with compensation, the window is larger than the
        // "reference" size. Divide by compensation so the saved size is
        // environment-independent and can be restored in both XWayland
        // and native Wayland.
        let comp = *XWAYLAND_COMPENSATION.get().unwrap_or(&1.0);
        if comp > 1.0 {
            logical_width = ((logical_width as f64) / comp) as u32;
            logical_height = ((logical_height as f64) / comp) as u32;
        }

        let state = WindowState {
            width: logical_width,
            height: logical_height,
            x: logical_x,
            y: logical_y,
            maximized,
            scale,
        };

        // Ensure config directory exists and save state as JSON
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Ok(json) = serde_json::to_string_pretty(&state) {
            use std::os::unix::fs::OpenOptionsExt;
            let _ = std::fs::OpenOptions::new()
                .write(true)
                .create(true)
                .truncate(true)
                .mode(0o600)
                .open(&path)
                .and_then(|mut f| {
                    use std::io::Write;
                    f.write_all(json.as_bytes())
                });
        }
    }
}

/// Restores the window state from the saved configuration.
///
/// Called at app startup. The saved logical coordinates are converted back
/// to physical pixels for positioning. The window size is clamped to the
/// monitor size to prevent the window from being larger than the screen
/// (e.g. after a monitor change).
fn restore_window_state(window: &tauri::WebviewWindow) {
    if let Some(state) = load_window_state() {
        let comp = *XWAYLAND_COMPENSATION.get().unwrap_or(&1.0);
        let mut width = state.width;
        let mut height = state.height;

        // Clamp to monitor size (with 50px buffer for taskbars etc.)
        if let Ok(Some(monitor)) = window.current_monitor() {
            let monitor_scale = monitor.scale_factor();
            let monitor_physical = monitor.size();
            let monitor_logical_w = ((monitor_physical.width as f64) / monitor_scale) as u32;
            let monitor_logical_h = ((monitor_physical.height as f64) / monitor_scale) as u32;

            // Under XWayland with compensation, the window will be larger,
            // so clamp the compensated size to monitor bounds
            let max_w = monitor_logical_w.saturating_sub(50);
            let max_h = monitor_logical_h.saturating_sub(50);

            if comp > 1.0 {
                // Apply compensation: scale up for XWayland
                width = ((width as f64 * comp) as u32).min(max_w);
                height = ((height as f64 * comp) as u32).min(max_h);
            } else {
                width = width.min(max_w);
                height = height.min(max_h);
            }
        } else if comp > 1.0 {
            // No monitor detected - apply compensation with generous 4K fallback limit
            width = ((width as f64 * comp) as u32).min(3840);
            height = ((height as f64 * comp) as u32).min(2160);
        }

        // Use LogicalSize - works better on Wayland than PhysicalSize
        let _ = window.set_size(tauri::LogicalSize::new(width, height));

        // Set position only on X11 (Wayland ignores set_position anyway due
        // to compositor security policy). This avoids misinterpretation of
        // saved coordinates when switching between XWayland and native Wayland.
        if std::env::var("GDK_BACKEND").unwrap_or_default() == "x11"
            || std::env::var("WAYLAND_DISPLAY").unwrap_or_default().is_empty()
        {
            let current_scale = window.scale_factor().unwrap_or(1.0);
            let _ = window.set_position(
                tauri::PhysicalPosition::new(
                    ((state.x as f64) * current_scale) as i32,
                    ((state.y as f64) * current_scale) as i32,
                )
            );
        }

        // If the window was maximized when last closed, maximize again
        if state.maximized {
            let _ = window.maximize();
        }
    }
}

/// Queries `Xft.dpi` from X resources via `xrdb -query` and returns the
/// expected scale factor (`Xft.dpi / 96.0`). Returns 1.0 on failure or
/// when the value is not set.
fn query_xft_scale() -> f64 {
    std::process::Command::new("xrdb")
        .args(["-query"])
        .output()
        .ok()
        .and_then(|out| {
            let stdout = String::from_utf8_lossy(&out.stdout);
            stdout.lines()
                .find(|l| l.starts_with("Xft.dpi:"))
                .and_then(|l| l.split(':').nth(1))
                .and_then(|v| v.trim().parse::<f64>().ok())
        })
        .map(|dpi| dpi / 96.0)
        .unwrap_or(1.0)
}

/// Main entry point of the Tauri application.
///
/// Initializes logging, registers plugins and all IPC commands,
/// sets up window restoration and starts the event loop.
/// This function is called from `main.rs` and only returns
/// when the application is terminated.
pub fn run() {
    // Logging must be initialized first so that all subsequent
    // initialization steps can already be logged
    init_logging();

    // AppImage Type 2 inherits file descriptors from the runtime (including
    // the FUSE mount keepalive on fd 1023). Without CLOEXEC, child processes
    // (wine, wineserver, xdg-open, etc.) inherit these fds, preventing the
    // FUSE daemon from exiting after our app closes. Set CLOEXEC on ALL
    // inherited fds so no child process keeps the mount busy.
    #[cfg(target_os = "linux")]
    unsafe {
        for fd in 3..=1023 {
            let flags = libc::fcntl(fd, libc::F_GETFD);
            if flags >= 0 {
                libc::fcntl(fd, libc::F_SETFD, flags | libc::FD_CLOEXEC);
            }
        }
    }

    // When running under XWayland (AppImage with GDK_BACKEND=x11 on a Wayland
    // session), GTK/WebKit reports scale_factor=1 even on HiDPI monitors.
    // We detect the expected scale from Xft.dpi (set by all major Wayland
    // compositors for XWayland) and apply it via WebView zoom + window resize.
    // GDK_SCALE is NOT used because it only supports integers.
    let gdk_backend = std::env::var("GDK_BACKEND").unwrap_or_default();
    let wayland_display = std::env::var("WAYLAND_DISPLAY").unwrap_or_default();
    let is_xwayland = gdk_backend == "x11" && !wayland_display.is_empty();
    let compensation = if is_xwayland {
        let scale = query_xft_scale();
        if scale > 1.0 { scale } else { 1.0 }
    } else {
        1.0
    };
    let _ = XWAYLAND_COMPENSATION.set(compensation);
    if compensation > 1.0 {
        log::info!("XWayland detected: applying compensation={:.2}", compensation);
    }

    // Screenshot mode is only available in development builds (tauri dev).
    // In release builds (AppImage, .deb) the env var is intentionally ignored.
    if cfg!(debug_assertions) && std::env::var("PENGUIN_CITIZEN_SCREENSHOTS").map(|v| v == "1").unwrap_or(false) {
        IS_SCREENSHOT_MODE.store(true, Ordering::Relaxed);
        log::info!("Screenshot mode enabled via environment variable");
    }

    tauri::Builder
        ::default()
        // Dialog plugin: enables native file picker dialogs
        .plugin(tauri_plugin_dialog::init())
        // Opener plugin: enables opening URLs in the default browser
        .plugin(tauri_plugin_opener::init())
        .setup(move |app| {
            // Restore window state in a separate thread.
            // The short delay (200ms) is needed so the window is fully
            // created before size and position are set.
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(200));
                if let Some(window) = handle.get_webview_window("main") {
                    restore_window_state(&window);

                    // Apply XWayland compensation via WebView zoom.
                    // This uniformly scales all content (px, rem, borders,
                    // icons) without requiring any JS-side hacks.
                    if compensation > 1.0 {
                        if let Err(e) = window.set_zoom(compensation) {
                            log::warn!("Failed to set WebView zoom: {}", e);
                        }
                    }
                }
            });
            Ok(())
        })
        // ── IPC Command Registration ──
        // All functions registered here can be called from the JavaScript frontend
        // via `invoke("command_name", { args })`.
        .invoke_handler(
            tauri::generate_handler![
                // General commands
                greet,
                app_log,
                get_log_file_path,
                get_display_info,

                // System checks (vm.max_map_count, file limits, monitor detection)
                system_check::run_system_check,
                system_check::fix_mapcount,
                system_check::fix_filelimit,
                system_check::detect_monitors,
                system_check::get_default_install_path,
                system_check::detect_gpu_vendor,
                system_check::detect_vulkan_devices,
                system_check::check_gamescope_installed,
                system_check::check_gamemode_installed,

                // App configuration (setup, installation path, runner sources)
                config::check_needs_setup,
                config::create_install_directory,
                config::validate_install_path,
                config::scan_runners,
                config::save_config,
                config::load_config,
                config::load_runner_cache,
                config::save_runner_cache,
                config::load_dxvk_cache,
                config::save_dxvk_cache,
                config::reset_app,
                config::add_runner_source_from_github,
                config::import_lug_helper_sources,
                config::get_system_locale,

                // Wine/Proton runner management (download, installation, deletion)
                runners::fetch_available_runners,
                runners::install_runner,
                runners::cancel_runner_install,
                runners::delete_runner,

                // Launch profiles (named, switchable launch configurations)
                launch_profiles::create_launch_profile,
                launch_profiles::update_launch_profile,
                launch_profiles::revert_launch_working_state,
                launch_profiles::switch_launch_profile,
                launch_profiles::rename_launch_profile,
                launch_profiles::update_profile_description,
                launch_profiles::delete_launch_profile,
                launch_profiles::duplicate_launch_profile,
                launch_profiles::set_fallback_runner,
                launch_profiles::get_runner_usage,
                launch_profiles::create_and_activate_launch_profile,

                // DXVK management (DirectX-to-Vulkan translation layer)
                dxvk::fetch_dxvk_releases,
                dxvk::detect_dxvk_version,
                dxvk::install_dxvk,

                // Wine prefix tools (configuration, DPI, PowerShell)
                prefix_tools::run_winecfg,
                prefix_tools::launch_wine_shell,
                prefix_tools::get_dpi,
                prefix_tools::set_dpi,
                prefix_tools::install_powershell,
                prefix_tools::detect_powershell,

                // Game installation and launch (RSI Launcher / Star Citizen)
                installer::run_installation,
                installer::cancel_installation,
                installer::check_installation,
                installer::is_game_running,
                installer::launch_game,
                installer::stop_game,
                installer::repair_installation,
                installer::restore_sc_data,
                installer::check_repair_backup,
                installer::delete_repair_backup,

                // Star Citizen configuration and profile management
                sc_config::versions::read_user_cfg,
                sc_config::versions::write_user_cfg,
                sc_config::versions::detect_sc_versions,
                sc_config::versions::list_profiles,
                sc_config::versions::export_profile,
                sc_config::versions::import_profile,
                sc_config::versions::read_attributes,
                sc_config::versions::write_attributes,
                sc_config::versions::read_attributes_map,
                sc_config::versions::write_attributes_partial,
                sc_config::versions::get_attributes_hash,
                sc_config::versions::read_live_sc_settings,

                // Binding editor (parse actionmaps, assign/remove bindings)
                sc_config::bindings::parse_actionmaps,
                sc_config::bindings::get_action_definitions,
                sc_config::bindings::get_complete_binding_list,
                sc_config::bindings::assign_binding,
                sc_config::bindings::remove_binding,

                // P4K archive access (read and list game files)
                sc_config::p4k::read_p4k,
                sc_config::p4k::list_p4k,

                // Localization within SC configuration
                sc_config::localization::get_localization_labels,
                sc_config::localization::get_localization_ini,
                sc_config::localization::list_localization_languages,

                // Per-profile binding management (save/load bindings per profile)
                sc_config::profiles::get_profile_bindings,
                sc_config::profiles::assign_profile_binding,
                sc_config::profiles::remove_profile_binding,
                sc_config::profiles::reset_profile_binding,
                sc_config::profiles::update_profile_device_wine_maps,
                sc_config::profiles::apply_profile_to_sc,
                sc_config::profiles::set_profile_device_alias,
                sc_config::profiles::migrate_binding_database,
                sc_config::profiles::reorder_profile_devices,

                // Profile backup system
                sc_config::profiles::backup_profile,
                sc_config::profiles::restore_profile,
                sc_config::profiles::backup_profile_manual,
                sc_config::profiles::list_backups,
                sc_config::profiles::delete_backup,
                sc_config::profiles::check_profile_status,
                sc_config::profiles::load_active_profiles,
                sc_config::profiles::save_active_profile,
                sc_config::profiles::update_backup_label,
                sc_config::profiles::update_backup_from_sc,

                // Environments management (import, create, link SC versions)
                sc_config::versions::list_importable_versions,
                sc_config::versions::import_from_version,
                sc_config::profiles::import_version_as_profile,
                sc_config::versions::list_exported_layouts,
                sc_config::p4k::copy_data_p4k,
                sc_config::p4k::move_data_p4k,
                sc_config::p4k::get_data_p4k_size,
                sc_config::p4k::abort_copy_data_p4k,
                sc_config::versions::delete_sc_version,
                sc_config::versions::create_sc_version,
                sc_config::versions::link_data_p4k,

                // Joystick tuning (deadzone, curves, inversion, sensitivity)
                sc_config::profiles::get_device_tuning,
                sc_config::profiles::update_device_tuning,

                // File diff (comparison of configuration files)
                sc_config::profiles::get_file_diff,

                // Input device capture for the binding editor (joysticks, gamepads)
                binding_capture::start_input_capture,
                binding_capture::stop_input_capture,
                binding_capture::list_connected_devices,
                binding_capture::list_device_axes,
                binding_capture::get_wine_axis_mappings,

                // Language pack management (e.g. German translation for Star Citizen)
                localization::check_localization_update,
                localization::get_available_languages,
                localization::get_localization_status,
                localization::install_localization,
                localization::remove_localization,
                localization::fetch_remote_language_info,
                localization::check_blueprints_compat,

                // Shader cache management (detection, deletion)
                shader_cache::get_shader_cache_info,
                shader_cache::delete_shader_cache,
                shader_cache::check_shader_cache_exists,

                // Dashboard (RSI news, server status, community statistics)
                dashboard::fetch_rsi_news,
                dashboard::fetch_server_status,
                dashboard::fetch_community_stats,
                dashboard::fetch_community_stats_history,
                
                // Utilities
                util::open_browser,
                util::capture_app_window,
                util::save_screenshot,
                is_screenshot_mode
            ]
        )
        // Window event handler: save window state on close,
        // so it can be restored on the next start.
        // The detour via `get_webview_window()` is needed because the event handler
        // only receives a Window reference, but we need a WebviewWindow.
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                if let Some(ww) = window.app_handle().get_webview_window(window.label()) {
                    save_window_state_from(&ww);
                }
                // Kill all child processes (game, wineserver) to prevent orphans
                installer::cleanup_child_processes();
                // SAFETY: _exit(0) is used intentionally to bypass GTK/WebKitGTK
                // atexit handlers that deadlock during normal shutdown on some
                // Linux distributions. This is a known upstream issue.
                // Window state is saved above, child processes are cleaned up,
                // and the kernel closes all remaining fds (releasing FUSE mounts).
                // std::process::exit() is NOT suitable because it still triggers
                // C atexit handlers where the deadlock occurs.
                unsafe { libc::_exit(0); }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod log_rotation_tests {
    use super::{rotate_log_file, LOG_START_MARKER};
    use std::io::Write;

    fn make_session(start_idx: usize) -> String {
        format!(
            "12:00:00 [INFO] {} \"/tmp/x\"\n12:00:01 [INFO] session-{}-line-1\n12:00:02 [INFO] session-{}-line-2\n",
            LOG_START_MARKER, start_idx, start_idx
        )
    }

    fn write_temp(content: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir();
        let path = dir.join(format!(
            "penguin-citizen-rotate-test-{}-{}.log",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let mut f = std::fs::File::create(&path).unwrap();
        f.write_all(content.as_bytes()).unwrap();
        path
    }

    #[test]
    fn truncates_to_last_n_sessions() {
        let combined = (1..=4).map(make_session).collect::<String>();
        let path = write_temp(&combined);

        rotate_log_file(&path, 2);

        let result = std::fs::read_to_string(&path).unwrap();
        assert_eq!(result.matches(LOG_START_MARKER).count(), 2);
        assert!(!result.contains("session-1-line-1"));
        assert!(!result.contains("session-2-line-1"));
        assert!(result.contains("session-3-line-1"));
        assert!(result.contains("session-4-line-2"));
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn leaves_file_alone_when_not_enough_markers() {
        let combined = make_session(1);
        let path = write_temp(&combined);

        rotate_log_file(&path, 5);

        let result = std::fs::read_to_string(&path).unwrap();
        assert_eq!(result, combined);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn zero_clears_file() {
        let combined = make_session(1) + &make_session(2);
        let path = write_temp(&combined);

        rotate_log_file(&path, 0);

        let result = std::fs::read_to_string(&path).unwrap();
        assert!(result.is_empty());
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn nonexistent_file_is_noop() {
        let path = std::env::temp_dir().join(format!(
            "penguin-citizen-nonexistent-{}.log",
            std::process::id()
        ));
        rotate_log_file(&path, 2);
        assert!(!path.exists());
    }
}
