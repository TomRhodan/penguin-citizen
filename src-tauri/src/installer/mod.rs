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

//! Module for Star Citizen game installation and launching.
//!
//! This module handles the following tasks:
//! - Performing the entire installation process (Winetricks, DXVK, RSI Launcher)
//! - Launching Star Citizen with the appropriate Wine settings
//! - Stopping running game processes
//! - Checking the installation status
//!
//! The installation proceeds in multiple phases:
//! 1. Prepare environment (download Winetricks)
//! 2. Run Winetricks (win11, arial, tahoma, powershell)
//! 3. Install DXVK
//! 4. Configure registry
//! 5. Download and install RSI Launcher
//! 6. Launch the game

mod launch;
mod install;
mod repair;

pub use launch::*;
pub use install::*;
pub use repair::*;

use crate::config::PerformanceSettings;
use serde::{ Deserialize, Serialize };
use std::io::{ BufRead, BufReader };
use std::process::Command;
use std::sync::atomic::{ AtomicBool, Ordering };
use std::sync::Mutex;
use tauri::{ AppHandle, Emitter };

use crate::util::validate_env_var_key;

/// Global flag for cancelling a running installation.
/// Set to `true` when the user cancels the installation.
pub(crate) static INSTALL_CANCEL: AtomicBool = AtomicBool::new(false);

/// Stores the PID of the running game process together with the installation path.
/// Needed to terminate the process later (stop_game) and
/// clean up the associated wineserver.
pub(crate) static GAME_PID: Mutex<Option<(u32, String)>> = Mutex::new(None);

/// Progress message during installation.
/// Sent as an event to the frontend so the UI can display the current status.
#[derive(Serialize, Deserialize, Clone)]
pub struct InstallProgress {
    /// Current phase (e.g. "prepare", "winetricks", "dxvk", "download", "install", "launch")
    pub phase: String,
    /// Description of the current step within the phase
    pub step: String,
    /// Progress in percent (0.0 to 100.0)
    pub percent: f64,
    /// Detailed log line for the console display in the frontend
    pub log_line: String,
}

/// Current status of the game installation.
/// Queried by the frontend to decide whether to install or launch.
#[derive(Serialize, Deserialize, Clone)]
pub struct InstallationStatus {
    /// Whether the installation is complete (runner present AND launcher installed)
    pub installed: bool,
    /// Whether a Wine runner was found in the filesystem
    pub has_runner: bool,
    /// Name of the selected runner (e.g. "wine-ge-proton8-25")
    pub runner_name: Option<String>,
    /// Path to the installation directory (Wine prefix)
    pub install_path: String,
    /// Whether the RSI Launcher .exe exists in the Wine prefix
    pub launcher_exe_exists: bool,
    /// Status message for display in the frontend
    pub message: String,
}

/// Sends a progress message as an event to the frontend.
/// The frontend receives these via the "install-progress" event listener
/// and uses them to update the progress bar and log output.
pub(crate) fn emit_progress(app: &AppHandle, phase: &str, step: &str, percent: f64, log_line: &str) {
    let _ = app.emit("install-progress", InstallProgress {
        phase: phase.to_string(),
        step: step.to_string(),
        percent,
        log_line: log_line.to_string(),
    });
}

/// Checks whether the installation was cancelled by the user.
/// Called at various points in the installation process
/// to return early with an error message when cancelled.
pub(crate) fn is_cancelled() -> bool {
    INSTALL_CANCEL.load(Ordering::Relaxed)
}

/// Streams the output of a child process (stdout/stderr) to the frontend in real time.
///
/// Stdout and stderr are read in separate threads to avoid pipe deadlocks.
/// A deadlock occurs when the child process fills the stderr buffer while we
/// are blocking on stdout - the process cannot write further and
/// both sides hang.
pub(crate) fn stream_command_output(
    app: &AppHandle,
    phase: &str,
    step: &str,
    percent: f64,
    child: &mut std::process::Child
) {
    // Read stderr in a separate thread so we can process stdout simultaneously
    let stderr_handle = child.stderr.take().map(|stderr| {
        let app = app.clone();
        let phase = phase.to_string();
        let step = step.to_string();
        std::thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines().map_while(Result::ok) {
                emit_progress(&app, &phase, &step, percent, &line);
            }
        })
    });

    // Read stdout in the current thread and send each line as a progress message
    if let Some(stdout) = child.stdout.take() {
        let reader = BufReader::new(stdout);
        for line in reader.lines().map_while(Result::ok) {
            emit_progress(app, phase, step, percent, &line);
        }
    }

    // Wait for the stderr thread to finish before returning
    if let Some(handle) = stderr_handle {
        let _ = handle.join();
    }
}

/// Returns true if the given string looks like a valid DRM connector name
/// (e.g. "DP-1", "HDMI-A-1", "eDP-1"). Used to guard the WAYLANDDRV_PRIMARY_MONITOR
/// env var against bogus values like display model names ("LG HDR 4K").
fn is_valid_connector_name(s: &str) -> bool {
    if s.is_empty() || s.contains(char::is_whitespace) {
        return false;
    }
    // Common DRM connector prefixes — keep in sync with what Wayland compositors
    // and xrandr expose. Values must end with a numeric suffix; we check the prefix
    // only because numbering varies (DP-1 / DP-2 / HDMI-A-1 / eDP-1 / DSI-1 / ...).
    const PREFIXES: &[&str] = &[
        "DP-",
        "HDMI-A-", "HDMI-B-",
        "DVI-D-", "DVI-I-", "DVI-",
        "eDP-", "LVDS-",
        "VGA-",
        "DSI-",
        "Virtual-",
    ];
    PREFIXES.iter().any(|p| s.starts_with(p))
}

/// Configures all environment variables for Wine execution.
///
/// Sets performance flags (ESync, FSync, DXVK Async), display settings
/// (Wayland, HDR, FSR), overlay options (MangoHUD, DXVK HUD), and shader caches.
/// Custom environment variables can override the built-in ones.
///
/// Returns the list of all set variables so they can be displayed in the log.
pub(crate) fn configure_wine_env(
    cmd: &mut Command,
    install_path: &str,
    perf: &PerformanceSettings,
    log_level: &str
) -> Vec<(String, String)> {
    let mut vars: Vec<(String, String)> = Vec::new();

    // Basic Wine environment variables
    vars.push(("WINEPREFIX".into(), install_path.into()));
    // Disable winemenubuilder.exe and winedbg.exe - otherwise creates
    // unwanted desktop entries and starts the debugger on errors
    // Disable DXVK for RSI Launcher (it's an Electron app that doesn't need DXVK)
    // Also disable winemenubuilder and winedbg
    vars.push(("WINEDLLOVERRIDES".into(), "winemenubuilder.exe=d;winedbg.exe=d".into()));

    // LD_LIBRARY_PATH: Put system paths first for Vulkan/graphics libraries,
    // then existing paths. This ensures Wine uses system Vulkan drivers
    // instead of potentially incompatible bundled libraries in AppImage.
    let current_ld_path = std::env::var("LD_LIBRARY_PATH").unwrap_or_default();
    let new_ld_path = format!("/usr/lib:/usr/lib64:{}", current_ld_path);
    vars.push(("LD_LIBRARY_PATH".into(), new_ld_path));

    // XDG_RUNTIME_DIR: Required for X11/Wayland socket connections.
    // Set fallback if not already defined.
    if std::env::var("XDG_RUNTIME_DIR").is_err() {
        let runtime_dir = format!("/run/user/{}", std::process::id());
        vars.push(("XDG_RUNTIME_DIR".into(), runtime_dir));
    }

    // WINEDEBUG: In debug mode enable detailed Wine output,
    // otherwise suppress all messages for better performance
    let winedebug = match log_level {
        "debug" => "+waylanddrv,+explorer,err+all",
        _ => "-all",
    };
    vars.push(("WINEDEBUG".into(), winedebug.into()));

    // Performance flags: ESync/FSync accelerate synchronization between
    // Wine threads by using Linux kernel features instead of expensive NT emulation
    if perf.esync {
        vars.push(("WINEESYNC".into(), "1".into()));
    }
    if perf.fsync {
        vars.push(("WINEFSYNC".into(), "1".into()));
    }
    // DXVK Async allows asynchronous shader compilation - prevents micro-stuttering
    if perf.dxvk_async {
        vars.push(("DXVK_ASYNC".into(), "1".into()));
    }

    // Display settings - Wayland support
    if perf.wayland {
        vars.push(("PROTON_ENABLE_WAYLAND".into(), "1".into())); // For Proton runners
        // For pure Wine runners: remove DISPLAY entirely so the X11 driver initialization
        // fails and the Wayland driver takes over.
        // DISPLAY="" is not enough - getenv("DISPLAY") still returns a
        // non-NULL pointer and Wine tries X11 anyway.
        vars.push(("DISPLAY".into(), "(removed)".to_string())); // Only logged, not set
    }
    // Enable HDR (High Dynamic Range) support for Proton and DXVK
    if perf.hdr {
        vars.push(("PROTON_ENABLE_HDR".into(), "1".into()));
        vars.push(("DXVK_HDR".into(), "1".into()));
    }
    // AMD FidelityFX Super Resolution 4 - automatic upscaling for better performance
    if perf.fsr {
        vars.push(("PROTON_FSR4_UPGRADE".into(), "1".into()));
    }
    // Set primary monitor for the Wine Wayland driver (e.g. "DP-1").
    // Wine/Proton expect a DRM connector name (DP-1, HDMI-A-1, eDP-1, ...),
    // not a display model name like "LG HDR 4K". If the saved value does
    // not match the connector format, skip both env vars so Wine falls back
    // to its own auto-detection (GE-Proton uses xrandr for that).
    if let Some(ref monitor) = perf.primary_monitor {
        if is_valid_connector_name(monitor) {
            vars.push(("WAYLANDDRV_PRIMARY_MONITOR".into(), monitor.clone()));
            vars.push(("PROTON_WAYLAND_MONITOR".into(), monitor.clone()));
        } else {
            log::warn!(
                "Ignoring invalid primary_monitor value {:?} (not a connector name like DP-1/HDMI-A-1) — letting Wine auto-detect",
                monitor
            );
        }
    }

    // Overlay options for performance monitoring during gameplay
    // MangoHUD displays FPS, CPU/GPU utilization and other metrics as an overlay
    if perf.mangohud {
        vars.push(("MANGOHUD".into(), "1".into()));
    }
    // DXVK's own HUD - displays FPS and shader compilation status
    if perf.dxvk_hud {
        vars.push(("DXVK_HUD".into(), "fps,compiler".into()));
    }

    // --- NVIDIA: DLSS 4.0 ---
    if perf.nvidia_dlss {
        vars.push(("PROTON_ENABLE_NGX_UPDATER".into(), "1".into()));
        vars.push(("DXVK_NVAPI_DRS_NGX_DLSS_SR_OVERRIDE".into(), "on".into()));
        vars.push(("DXVK_NVAPI_DRS_NGX_DLSS_RR_OVERRIDE".into(), "on".into()));
        vars.push(("DXVK_NVAPI_DRS_NGX_DLSS_FG_OVERRIDE".into(), "on".into()));
        vars.push(("DXVK_NVAPI_DRS_NGX_DLSS_SR_OVERRIDE_RENDER_PRESET_SELECTION".into(), "RENDER_PRESET_K".into()));
        vars.push(("DXVK_NVAPI_DRS_NGX_DLSS_RR_OVERRIDE_RENDER_PRESET_SELECTION".into(), "RENDER_PRESET_K".into()));
    }

    // --- NVIDIA: Smooth Motion ---
    if perf.nvidia_smooth_motion {
        vars.push(("NVPRESENT_ENABLE_SMOOTH_MOTION".into(), "1".into()));
        vars.push(("NVPRESENT_QUEUE_FAMILY".into(), "1".into()));
    }

    // --- NVIDIA: G-Sync optimization ---
    if perf.nvidia_gsync {
        vars.push(("__GL_GSYNC_ALLOWED".into(), "1".into()));
        vars.push(("__GL_MaxFramesAllowed".into(), "1".into()));
    }

    // --- AMD: Fix flickering lights on display panels ---
    if perf.amd_radv_zero_vram {
        vars.push(("radv_zero_vram".into(), "true".into()));
    }

    // --- AMD: Fix framerate drops / stuttering ---
    if perf.amd_nogttspill {
        vars.push(("RADV_PERFTEST".into(), "nogttspill".into()));
    }

    // --- GPU Selection: Force specific Vulkan device ---
    if let Some(ref device) = perf.gpu_device_filter {
        if !device.is_empty() {
            vars.push(("DXVK_FILTER_DEVICE_NAME".into(), device.clone()));
        }
    }

    // --- Troubleshooting: Vulkan mailbox present mode ---
    if perf.vulkan_mailbox {
        vars.push(("MESA_VK_WSI_PRESENT_MODE".into(), "mailbox".into()));
    }

    // --- Troubleshooting: HDR WSI layer ---
    if perf.enable_hdr_wsi {
        vars.push(("ENABLE_HDR_WSI".into(), "1".into()));
    }

    // --- Troubleshooting: CPU topology for multi-die CPUs ---
    if let Some(ref topology) = perf.wine_cpu_topology {
        if !topology.is_empty() {
            vars.push(("WINE_CPU_TOPOLOGY".into(), topology.clone()));
        }
    }

    // Shader cache settings: Store compiled shaders on disk
    // so they don't need to be recompiled on the next launch.
    // Large cache size (10 GB) and no automatic cleanup because
    // Star Citizen generates a very large number of shaders.
    vars.push(("__GL_SHADER_DISK_CACHE".into(), "1".into()));
    vars.push(("__GL_SHADER_DISK_CACHE_SIZE".into(), "10737418240".into()));
    vars.push(("__GL_SHADER_DISK_CACHE_PATH".into(), install_path.into()));
    vars.push(("__GL_SHADER_DISK_CACHE_SKIP_CLEANUP".into(), "1".into()));
    vars.push(("MESA_SHADER_CACHE_DIR".into(), install_path.into()));
    vars.push(("MESA_SHADER_CACHE_MAX_SIZE".into(), "10G".into()));

    // Apply custom environment variables from the settings.
    // These can override built-in variables (e.g. custom DXVK_HUD configuration).
    // Disabled or empty variables are skipped.
    for custom in &perf.custom_env_vars {
        if !custom.enabled || custom.key.trim().is_empty() {
            continue;
        }
        if validate_env_var_key(&custom.key).is_err() {
            log::warn!("Skipping blocked environment variable: {}", custom.key);
            continue;
        }
        let key = custom.key.clone();
        let value = custom.value.clone();
        // Remove existing variable with the same key so that the
        // custom version takes precedence
        vars.retain(|(k, _)| k != &key);
        vars.push((key, value));
    }

    // Determine DISPLAY value before applying environment variables
    // For X11 mode: use current DISPLAY from environment (or fallback to :0)
    // For Wayland mode: remove DISPLAY so Wine uses Wayland driver
    let display_value = if perf.wayland {
        None // Remove DISPLAY for Wayland
    } else {
        Some(std::env::var("DISPLAY").unwrap_or_else(|_| ":0".to_string()))
    };

    // Add DISPLAY to vars so it appears in the log
    // Replace any existing DISPLAY entry
    vars.retain(|(k, _)| k != "DISPLAY");
    if let Some(ref display) = display_value {
        vars.push(("DISPLAY".into(), display.clone()));
    } else {
        vars.push(("DISPLAY".into(), "(removed)".to_string()));
    }

    // Apply all collected environment variables to the command
    for (key, val) in &vars {
        // Skip the "(removed)" DISPLAY placeholder - we handle DISPLAY separately
        if key == "DISPLAY" && val == "(removed)" {
            continue;
        }
        cmd.env(key, val);
    }

    // Apply DISPLAY based on mode
    if let Some(display) = display_value {
        cmd.env("DISPLAY", display);
    } else {
        cmd.env_remove("DISPLAY");
    }

    vars
}

#[cfg(test)]
mod tests {
    use super::is_valid_connector_name;

    #[test]
    fn valid_connector_names() {
        for name in ["DP-1", "DP-2", "HDMI-A-1", "HDMI-B-2", "eDP-1", "LVDS-1", "DVI-D-1", "DSI-1", "VGA-1", "Virtual-1"] {
            assert!(is_valid_connector_name(name), "expected {name} to be a valid connector name");
        }
    }

    #[test]
    fn rejects_display_model_names() {
        for name in ["LG HDR 4K", "Dell U2723QE", "Samsung Odyssey G7"] {
            assert!(!is_valid_connector_name(name), "expected {name} to be rejected (contains whitespace)");
        }
    }

    #[test]
    fn rejects_unknown_or_empty() {
        for name in ["", "Foo Bar", "Monitor1", "1234", "DP1"] {
            assert!(!is_valid_connector_name(name), "expected {name:?} to be rejected");
        }
    }
}
