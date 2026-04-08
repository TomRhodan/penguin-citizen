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

use crate::config::{ AppConfig, PerformanceSettings };
use crate::runners::resolve_wine_bin;
use serde::{ Deserialize, Serialize };
use std::io::{ BufRead, BufReader };
use std::path::{ Path, PathBuf };
use std::process::{ Command, Stdio };
use std::sync::atomic::{ AtomicBool, Ordering };
use std::sync::Mutex;
use tauri::{ AppHandle, Emitter };

/// Global flag for cancelling a running installation.
/// Set to `true` when the user cancels the installation.
static INSTALL_CANCEL: AtomicBool = AtomicBool::new(false);

/// Stores the PID of the running game process together with the installation path.
/// Needed to terminate the process later (stop_game) and
/// clean up the associated wineserver.
static GAME_PID: Mutex<Option<(u32, String)>> = Mutex::new(None);

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

use crate::util::expand_tilde;

/// Sends a progress message as an event to the frontend.
/// The frontend receives these via the "install-progress" event listener
/// and uses them to update the progress bar and log output.
fn emit_progress(app: &AppHandle, phase: &str, step: &str, percent: f64, log_line: &str) {
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
fn is_cancelled() -> bool {
    INSTALL_CANCEL.load(Ordering::Relaxed)
}

/// Streams the output of a child process (stdout/stderr) to the frontend in real time.
///
/// Stdout and stderr are read in separate threads to avoid pipe deadlocks.
/// A deadlock occurs when the child process fills the stderr buffer while we
/// are blocking on stdout - the process cannot write further and
/// both sides hang.
fn stream_command_output(
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

/// Configures all environment variables for Wine execution.
///
/// Sets performance flags (ESync, FSync, DXVK Async), display settings
/// (Wayland, HDR, FSR), overlay options (MangoHUD, DXVK HUD), and shader caches.
/// Custom environment variables can override the built-in ones.
///
/// Returns the list of all set variables so they can be displayed in the log.
fn configure_wine_env(
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
    // Set primary monitor for the Wine Wayland driver (e.g. "DP-1")
    if let Some(ref monitor) = perf.primary_monitor {
        vars.push(("WAYLANDDRV_PRIMARY_MONITOR".into(), monitor.clone()));
        vars.push(("PROTON_WAYLAND_MONITOR".into(), monitor.clone()));
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

/// Checks the current installation status of Star Citizen.
///
/// Verifies whether a Wine runner is present and whether the RSI Launcher .exe
/// exists in the Wine prefix. Returns a detailed status that the frontend
/// uses for display and the "install vs. launch" decision.
#[tauri::command]
pub fn check_installation(config: AppConfig) -> InstallationStatus {
    let install_path = expand_tilde(&config.install_path);

    // Check whether the selected runner actually exists as a wine binary
    let runner_name = config.selected_runner.clone();
    let has_runner = runner_name.as_ref().is_some_and(|name| {
        let runner_dir = Path::new(&install_path).join("runners").join(name);
        resolve_wine_bin(&runner_dir).is_some()
    });

    // Check whether the RSI Launcher .exe exists at the expected path within the Wine prefix
    let launcher_exe = Path::new(&install_path)
        .join("drive_c")
        .join("Program Files")
        .join("Roberts Space Industries")
        .join("RSI Launcher")
        .join("RSI Launcher.exe");
    let launcher_exe_exists = launcher_exe.exists();

    // Build status message based on the installation state
    let message = if runner_name.is_none() {
        "No runner selected".to_string()
    } else if !has_runner {
        format!("Runner '{}' not found", runner_name.as_deref().unwrap_or(""))
    } else if !launcher_exe_exists {
        "RSI Launcher not found - please run installation first".to_string()
    } else {
        "Ready to launch".to_string()
    };

    // Only considered "installed" when both runner and launcher are present
    let installed = has_runner && launcher_exe_exists;

    InstallationStatus {
        installed,
        has_runner,
        runner_name,
        install_path,
        launcher_exe_exists,
        message,
    }
}

/// Launches Star Citizen via the RSI Launcher with Wine.
///
/// This function:
/// 1. Determines Wine binary and wineserver from the selected runner
/// 2. Kills any still-running wineserver processes
/// 3. Configures all environment variables (performance, display, overlays)
/// 4. Starts the RSI Launcher as a child process
/// 5. Monitors the process in the background and reports termination to the frontend
///
/// All important information (runner, paths, variables) is sent as
/// "launch-log" events to the frontend for the live console.
#[tauri::command]
pub async fn launch_game(app: AppHandle, config: AppConfig) -> Result<(), String> {
    let install_path = expand_tilde(&config.install_path);
    let runner_name = config.selected_runner.as_deref().ok_or("No runner selected")?;
    let log_level = config.log_level.as_str();
    let is_debug = log_level == "debug";

    // Resolve Wine binary from the runner directory (supports standard Wine + Proton layouts)
    let runner_dir = Path::new(&install_path).join("runners").join(runner_name);
    let wine = resolve_wine_bin(&runner_dir)
        .ok_or_else(|| format!("Wine binary not found in {}", runner_dir.display()))?;
    let runner_bin = wine.parent().unwrap().to_path_buf();
    let wineserver = runner_bin.join("wineserver");

    let launcher_exe = Path::new(&install_path)
        .join("drive_c")
        .join("Program Files")
        .join("Roberts Space Industries")
        .join("RSI Launcher")
        .join("RSI Launcher.exe");

    if !launcher_exe.exists() {
        return Err("RSI Launcher not found - please run installation first".to_string());
    }

    // --- Log: Header for the launch console in the frontend ---
    let _ = app.emit("launch-log", "────────────────────────────────────────");
    let _ = app.emit("launch-log", "  Penguin Citizen - Launch");
    let _ = app.emit("launch-log", "────────────────────────────────────────");

    // --- Log: Output runner and paths for diagnostics ---
    let _ = app.emit("launch-log", &format!("Runner:     {}", runner_name));
    let _ = app.emit("launch-log", &format!("Wine:       {}", wine.to_string_lossy()));
    let _ = app.emit("launch-log", &format!("Prefix:     {}", install_path));

    // --- Log: Determine and output Wine version ---
    if
        let Ok(out) = Command::new(wine.to_string_lossy().as_ref())
            .arg("--version")
            .env("WINEPREFIX", &install_path)
            .output()
    {
        let version = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if !version.is_empty() {
            let _ = app.emit("launch-log", &format!("Version:    {}", version));
        }
    }

    let _ = app.emit("launch-log", "");

    // --- Kill old wineserver processes left over from previous sessions ---
    let _ = app.emit("launch-log", "> Killing old wineserver processes...");
    let _ = Command::new(wineserver.to_string_lossy().as_ref())
        .arg("-k")
        .env("WINEPREFIX", &install_path)
        .output();

    // --- Build launch command (gamescope → gamemoderun → wine → launcher) ---
    let perf_settings = &config.performance;
    let launcher_path = "C:\\Program Files\\Roberts Space Industries\\RSI Launcher\\RSI Launcher.exe";

    let mut cmd = if perf_settings.gamescope.enabled {
        let mut c = Command::new("gamescope");
        if let Some(w) = perf_settings.gamescope.width {
            c.arg("-W").arg(w.to_string());
        }
        if let Some(h) = perf_settings.gamescope.height {
            c.arg("-H").arg(h.to_string());
        }
        if perf_settings.gamescope.hdr {
            c.arg("--hdr-enabled");
        }
        if perf_settings.gamescope.force_grab_cursor {
            c.arg("--force-grab-cursor");
        }
        if perf_settings.gamescope.keyboard_grab {
            c.arg("-g");
        }
        c.arg("--");
        if perf_settings.gamemode {
            c.arg("gamemoderun");
        }
        c.arg(wine.to_string_lossy().as_ref());
        c.arg(launcher_path);
        if perf_settings.in_process_gpu {
            c.arg("--in-process-gpu");
        }
        c
    } else if perf_settings.gamemode {
        let mut c = Command::new("gamemoderun");
        c.arg(wine.to_string_lossy().as_ref());
        c.arg(launcher_path);
        if perf_settings.in_process_gpu {
            c.arg("--in-process-gpu");
        }
        c
    } else {
        let mut c = Command::new(wine.to_string_lossy().as_ref());
        c.arg(launcher_path);
        if perf_settings.in_process_gpu {
            c.arg("--in-process-gpu");
        }
        c
    };

    let env_log = configure_wine_env(&mut cmd, &install_path, &config.performance, log_level);

    // --- Log: List set environment variables ---
    let _ = app.emit("launch-log", "");
    let _ = app.emit("launch-log", "> Environment variables:");
    for (key, val) in &env_log {
        if val.is_empty() {
            let _ = app.emit(
                "launch-log",
                &format!("  {}=\"\" (cleared - forcing Wayland driver)", key)
            );
        } else {
            let _ = app.emit("launch-log", &format!("  {}={}", key, val));
        }
    }

    // --- Log: Summary of performance settings ---
    let perf = &config.performance;
    let _ = app.emit("launch-log", "");
    let _ = app.emit("launch-log", "> Performance settings:");
    let _ = app.emit(
        "launch-log",
        &format!("  ESync={}, FSync={}, DXVK Async={}", perf.esync, perf.fsync, perf.dxvk_async)
    );
    let _ = app.emit(
        "launch-log",
        &format!("  Wayland={}, HDR={}, FSR={}", perf.wayland, perf.hdr, perf.fsr)
    );
    let _ = app.emit(
        "launch-log",
        &format!("  MangoHUD={}, DXVK HUD={}", perf.mangohud, perf.dxvk_hud)
    );
    if perf.gamemode {
        let _ = app.emit("launch-log", "  GameMode=true");
    }
    if perf.nvidia_dlss {
        let _ = app.emit("launch-log", "  NVIDIA DLSS 4.0=true");
    }
    if perf.nvidia_smooth_motion {
        let _ = app.emit("launch-log", "  NVIDIA Smooth Motion=true");
    }
    if perf.nvidia_gsync {
        let _ = app.emit("launch-log", "  NVIDIA G-Sync Optimization=true");
    }
    if perf.amd_radv_zero_vram {
        let _ = app.emit("launch-log", "  AMD radv_zero_vram=true");
    }
    if perf.amd_nogttspill {
        let _ = app.emit("launch-log", "  AMD RADV_PERFTEST=nogttspill");
    }
    if let Some(ref device) = perf.gpu_device_filter {
        let _ = app.emit("launch-log", &format!("  GPU Filter={}", device));
    }
    if perf.in_process_gpu {
        let _ = app.emit("launch-log", "  --in-process-gpu=true");
    }
    if perf.vulkan_mailbox {
        let _ = app.emit("launch-log", "  Vulkan Mailbox Mode=true");
    }
    if perf.enable_hdr_wsi {
        let _ = app.emit("launch-log", "  HDR WSI Layer=true");
    }
    if let Some(ref topology) = perf.wine_cpu_topology {
        let _ = app.emit("launch-log", &format!("  CPU Topology={}", topology));
    }
    if let Some(ref monitor) = perf.primary_monitor {
        let _ = app.emit("launch-log", &format!("  Primary Monitor={}", monitor));
    }
    if perf.gamescope.enabled {
        let mut gs_flags = vec!["enabled".to_string()];
        if let Some(w) = perf.gamescope.width { gs_flags.push(format!("-W {}", w)); }
        if let Some(h) = perf.gamescope.height { gs_flags.push(format!("-H {}", h)); }
        if perf.gamescope.hdr { gs_flags.push("--hdr-enabled".into()); }
        if perf.gamescope.force_grab_cursor { gs_flags.push("--force-grab-cursor".into()); }
        if perf.gamescope.keyboard_grab { gs_flags.push("-g".into()); }
        let _ = app.emit("launch-log", &format!("  Gamescope: {}", gs_flags.join(", ")));
    }

    // --- Log: Custom environment variables (if present) ---
    let active_custom: Vec<_> = perf.custom_env_vars.iter()
        .filter(|v| v.enabled && !v.key.trim().is_empty())
        .collect();
    if !active_custom.is_empty() {
        let _ = app.emit("launch-log", "");
        let _ = app.emit("launch-log", "> Custom environment variables:");
        for v in &active_custom {
            let _ = app.emit("launch-log", &format!("  {}={}", v.key, v.value));
        }
    }

    // --- Log: Output full command only in debug mode ---
    if is_debug {
        let _ = app.emit("launch-log", "");
        let cmd_prefix = if perf.gamescope.enabled {
            "gamescope [flags] --"
        } else if perf.gamemode {
            "gamemoderun"
        } else {
            ""
        };
        let in_proc = if perf.in_process_gpu { " --in-process-gpu" } else { "" };
        let _ = app.emit(
            "launch-log",
            &format!(
                "> Command: {} {} \"{}\"{}",
                cmd_prefix,
                wine.to_string_lossy(),
                launcher_path,
                in_proc
            )
        );
    }

    // The RSI Launcher is an Electron app - piping keeps
    // the child handles open and prevents detection of process termination.
    // Therefore redirect stdout/stderr to /dev/null.
    cmd.stdout(Stdio::null()).stderr(Stdio::null());

    let _ = app.emit("launch-log", "");
    let _ = app.emit("launch-log", "> Starting RSI Launcher...");

    let mut child = cmd.spawn().map_err(|e| format!("Failed to launch RSI Launcher: {}", e))?;

    let pid = child.id();
    let _ = app.emit("launch-log", &format!("> RSI Launcher started (PID: {})", pid));
    let _ = app.emit("launch-started", "RSI Launcher process started");

    // Store PID and installation path so stop_game can terminate the process
    if let Ok(mut guard) = GAME_PID.lock() {
        *guard = Some((pid, install_path.clone()));
    }

    // Monitor child process in the background - when the launcher exits,
    // the thread sends a "launch-exited" event to the frontend
    std::thread::spawn(move || {
        let status = child.wait();
        let code = status.ok().and_then(|s| s.code());

        // Clear stored PID since the process is no longer running
        if let Ok(mut guard) = GAME_PID.lock() {
            *guard = None;
        }

        let _ = app.emit("launch-log", "");
        let _ = app.emit("launch-log", &format!("> RSI Launcher exited (code: {:?})", code));
        let _ = app.emit("launch-exited", code.unwrap_or(-1));
    });

    Ok(())
}

/// Stops the running game process and cleans up all Wine processes.
///
/// Procedure:
/// 1. First send SIGTERM (graceful shutdown)
/// 2. After 2 seconds send SIGKILL (forced termination)
/// 3. Kill all wineservers in the runner directory to clean up orphaned Wine processes
/// 4. Clear stored PID and notify the frontend
#[tauri::command]
pub async fn stop_game(app: AppHandle) -> Result<(), String> {
    // Retrieve PID and installation path from global storage
    let (pid, install_path) = {
        let guard = GAME_PID.lock().map_err(|e| format!("Lock error: {}", e))?;
        guard.clone().ok_or("No game process is running")?
    };

    let _ = app.emit("launch-log", "");
    let _ = app.emit("launch-log", &format!("> Stopping game process (PID: {})...", pid));

    // Send SIGTERM - gives the process a chance to shut down cleanly
    let _ = Command::new("kill").arg("-TERM").arg(pid.to_string()).output();

    // Wait 2 seconds, then SIGKILL if the process is still alive
    std::thread::sleep(std::time::Duration::from_secs(2));
    let _ = Command::new("kill").arg("-9").arg(pid.to_string()).output();

    // Kill all wineservers in all runner directories
    // to clean up orphaned Wine processes (e.g. winedevice.exe)
    let runner_dirs = std::fs::read_dir(Path::new(&install_path).join("runners")).ok();
    if let Some(dirs) = runner_dirs {
        for entry in dirs.flatten() {
            if let Some(wine) = resolve_wine_bin(&entry.path()) {
                let wineserver = wine.with_file_name("wineserver");
                if wineserver.exists() {
                    let _ = app.emit("launch-log", "> Killing wineserver...");
                    let _ = Command::new(wineserver.to_string_lossy().as_ref())
                        .arg("-k")
                        .env("WINEPREFIX", &install_path)
                        .output();
                }
            }
        }
    }

    // Clear stored PID - the game is no longer running
    if let Ok(mut guard) = GAME_PID.lock() {
        *guard = None;
    }

    let _ = app.emit("launch-log", "> Game stopped.");
    // Exit code -1 signals to the frontend that the game was stopped manually
    let _ = app.emit("launch-exited", -1);

    Ok(())
}

/// Cleans up all child processes spawned by this application.
/// Called synchronously during app shutdown to prevent orphaned processes.
///
/// Kills the game process (if running) via SIGKILL and shuts down all
/// wineservers in the runner directory.
pub fn cleanup_child_processes() {
    let game_info = GAME_PID.lock().ok().and_then(|guard| guard.clone());

    if let Some((pid, install_path)) = game_info {
        // SIGKILL - no graceful shutdown needed during app exit
        let _ = Command::new("kill").arg("-9").arg(pid.to_string()).output();

        // Kill all wineservers to clean up Wine process trees
        if let Ok(dirs) = std::fs::read_dir(Path::new(&install_path).join("runners")) {
            for entry in dirs.flatten() {
                if let Some(wine) = resolve_wine_bin(&entry.path()) {
                    let wineserver = wine.with_file_name("wineserver");
                    if wineserver.exists() {
                        let _ = Command::new(wineserver.to_string_lossy().as_ref())
                            .arg("-k")
                            .env("WINEPREFIX", &install_path)
                            .output();
                    }
                }
            }
        }
    }
}

/// Performs the full installation of Star Citizen.
///
/// The installation process consists of six phases:
/// - Phase 1 (0-5%):   Prepare environment, download Winetricks
/// - Phase 2 (5-45%):  Run Winetricks verbs (win11, fonts, PowerShell)
/// - Phase 3 (45-60%): Download and install DXVK from GitHub
/// - Phase 4 (60-65%): Configure Windows registry
/// - Phase 5 (65-95%): Download and install RSI Launcher (skipped in quick mode)
/// - Phase 6 (95-100%): Launch RSI Launcher
///
/// Can be cancelled at any time via `cancel_installation()`.
/// In "quick" mode only phases 1-4 + 6 are executed (launcher download is skipped).
#[tauri::command]
pub async fn run_installation(app: AppHandle, config: AppConfig) -> Result<(), String> {
    // Reset cancellation flag for a new installation
    INSTALL_CANCEL.store(false, Ordering::SeqCst);

    // The frontend may not pass all fields (e.g. github_token or install_mode).
    // In that case, load the missing values from the saved configuration file.
    let config = if config.github_token.is_none() || config.install_mode.is_empty() {
        if let Ok(Some(saved)) = crate::config::load_config().await {
            AppConfig {
                github_token: if config.github_token.is_none() {
                    saved.github_token
                } else {
                    config.github_token
                },
                install_mode: if config.install_mode.is_empty() {
                    saved.install_mode
                } else {
                    config.install_mode
                },
                ..config
            }
        } else {
            config
        }
    } else {
        config
    };

    let install_path = expand_tilde(&config.install_path);
    // In quick mode the RSI Launcher download is skipped (phases 4/5)
    let skip_launcher = config.install_mode == "quick";

    // In quick mode, verify that the RSI Launcher already exists
    if skip_launcher {
        let launcher_exe = Path::new(&install_path)
            .join("drive_c")
            .join("Program Files")
            .join("Roberts Space Industries")
            .join("RSI Launcher")
            .join("RSI Launcher.exe");
        if !launcher_exe.exists() {
            return Err(
                "Quick Install selected but RSI Launcher not found. Please use Full Installation.".into()
            );
        }
    }

    let runner_name = config.selected_runner.as_deref().ok_or("No runner selected")?;

    let runner_dir = Path::new(&install_path).join("runners").join(runner_name);
    let wine = resolve_wine_bin(&runner_dir)
        .ok_or_else(|| format!("Wine binary not found in {}", runner_dir.display()))?;
    let runner_bin = wine.parent().unwrap().to_path_buf();
    let wineserver = runner_bin.join("wineserver");

    // ── Phase 1: Prepare environment (0–5%) ──
    // Note: In quick mode phases 1-4 + 6 are executed, phases 4/5 (RSI Launcher) are skipped

    // Temporary directory for downloads and intermediate files
    let tmp_dir = Path::new(&install_path).join(".tmp");
    // HTTP client with custom User-Agent for GitHub API requests
    let client = reqwest::Client
        ::builder()
        .user_agent("penguin-citizen/0.5.0")
        .connect_timeout(std::time::Duration::from_secs(10))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());

    emit_progress(&app, "prepare", "Preparing environment...", 0.0, "Starting installation...");

    // Create Wine prefix directory structure
    let live_dir = Path::new(&install_path).join("drive_c");

    std::fs
        ::create_dir_all(&install_path)
        .map_err(|e| format!("Failed to create install directory: {}", e))?;
    std::fs
        ::create_dir_all(&live_dir)
        .map_err(|e| format!("Failed to create drive_c directory: {}", e))?;
    std::fs
        ::create_dir_all(&tmp_dir)
        .map_err(|e| format!("Failed to create .tmp directory: {}", e))?;

    // Create marker file early so Winetricks skips the 64-bit warning
    let marker = Path::new(&install_path).join("no_win64_warnings");
    let _ = std::fs::write(&marker, "");

    // Kill remaining wineservers from previous installation attempts
    emit_progress(
        &app,
        "prepare",
        "Cleaning up old processes...",
        1.0,
        "Killing any lingering wineserver..."
    );
    let _ = Command::new(wineserver.to_string_lossy().as_ref())
        .arg("-k")
        .env("WINEPREFIX", &install_path)
        .output();

    emit_progress(&app, "prepare", "Downloading winetricks...", 2.0, "Downloading winetricks...");

    // Download Winetricks script directly from GitHub (always latest version)
    let winetricks_path = tmp_dir.join("winetricks");

    let wt_bytes = client
        .get("https://raw.githubusercontent.com/Winetricks/winetricks/master/src/winetricks")
        .send().await
        .map_err(|e| format!("Failed to download winetricks: {}", e))?
        .bytes().await
        .map_err(|e| format!("Failed to read winetricks response: {}", e))?;

    std::fs
        ::write(&winetricks_path, &wt_bytes)
        .map_err(|e| format!("Failed to write winetricks: {}", e))?;

    // Mark Winetricks script as executable (only needed on Unix systems)
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs
            ::set_permissions(&winetricks_path, std::fs::Permissions::from_mode(0o755))
            .map_err(|e| format!("Failed to chmod winetricks: {}", e))?;
    }

    emit_progress(&app, "prepare", "Environment ready", 5.0, "Environment prepared successfully");

    if is_cancelled() {
        return Err("Installation cancelled".into());
    }

    // ── Phase 2: Run Winetricks verbs (5–45%) ──
    // DXVK is NOT installed via Winetricks (provides outdated versions).
    // Instead, DXVK is downloaded directly from GitHub in phase 3.
    // win11: Set Windows 11 compatibility mode
    // arial/tahoma: Fonts needed for display in the RSI Launcher
    // powershell: Required by the RSI Launcher for certain operations
    let verbs = ["win11", "arial", "tahoma", "powershell"];
    let verb_count = verbs.len() as f64;

    for (i, verb) in verbs.iter().enumerate() {
        if is_cancelled() {
            return Err("Installation cancelled".into());
        }

        let step_label = format!("Installing {}...", verb);
        let base_percent = 5.0 + ((i as f64) / verb_count) * 40.0;

        // Kill wineserver before each verb to avoid hangs from lingering processes
        let _ = Command::new(wineserver.to_string_lossy().as_ref())
            .arg("-k")
            .env("WINEPREFIX", &install_path)
            .output();

        emit_progress(
            &app,
            "winetricks",
            &step_label,
            base_percent,
            &format!("Running: winetricks -q {}", verb)
        );

        let mut child = Command::new(winetricks_path.to_string_lossy().as_ref())
            .args(["-q", verb])
            .env("WINEPREFIX", &install_path)
            .env("WINE", wine.to_string_lossy().as_ref())
            .env("WINESERVER", wineserver.to_string_lossy().as_ref())
            .env("WINEDLLOVERRIDES", "winemenubuilder.exe=d;winedbg.exe=d")
            .env("WINEDEBUG", "-all")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("Failed to run winetricks {}: {}", verb, e))?;

        stream_command_output(&app, "winetricks", &step_label, base_percent, &mut child);

        let status = child
            .wait()
            .map_err(|e| format!("Failed to wait for winetricks {}: {}", verb, e))?;

        if !status.success() {
            emit_progress(
                &app,
                "error",
                &format!("winetricks {} failed", verb),
                base_percent,
                &format!("winetricks {} exited with code {:?}", verb, status.code())
            );
            return Err(format!("winetricks {} failed with exit code {:?}", verb, status.code()));
        }

        let done_percent = 5.0 + (((i + 1) as f64) / verb_count) * 40.0;
        emit_progress(
            &app,
            "winetricks",
            &format!("{} installed", verb),
            done_percent,
            &format!("Completed: {}", verb)
        );
    }

    if is_cancelled() {
        return Err("Installation cancelled".into());
    }

    // ── Phase 3: Install DXVK (45–60%) ──
    // DXVK translates Direct3D 9/10/11 calls to Vulkan - essential for
    // graphics performance on Linux since Vulkan communicates directly with the GPU.
    emit_progress(
        &app,
        "dxvk",
        "Installing DXVK...",
        45.0,
        "Fetching latest DXVK release from GitHub..."
    );

    // Kill wineserver before DXVK installation
    let _ = Command::new(wineserver.to_string_lossy().as_ref())
        .arg("-k")
        .env("WINEPREFIX", &install_path)
        .output();

    // Fetch latest DXVK version from the GitHub API
    let dxvk_url = "https://api.github.com/repos/doitsujin/dxvk/releases/latest";
    let mut dxvk_request = client.get(dxvk_url);

    // Use GitHub token if available (increases API rate limit from 60 to 5000/hour)
    if let Some(ref token) = config.github_token {
        dxvk_request = dxvk_request.header("Authorization", format!("Bearer {}", token));
    }

    let dxvk_resp = dxvk_request
        .send().await
        .map_err(|e| format!("Failed to fetch DXVK release: {}", e))?;

    if !dxvk_resp.status().is_success() {
        return Err(format!("GitHub API returned {} for DXVK", dxvk_resp.status()));
    }

    /// A GitHub release object from the GitHub Releases API.
    #[derive(Deserialize)]
    struct GhRelease {
        /// Release tag (e.g. "v2.5.1"), used as the version identifier.
        tag_name: String,
        /// List of downloadable assets attached to this release.
        assets: Vec<GhAsset>,
    }
    /// A single downloadable asset within a GitHub release.
    #[derive(Deserialize)]
    struct GhAsset {
        /// Filename of the asset (e.g. "dxvk-2.5.1.tar.gz").
        name: String,
        /// Direct download URL for the asset.
        browser_download_url: String,
    }

    let release: GhRelease = dxvk_resp
        .json().await
        .map_err(|e| format!("Failed to parse DXVK release: {}", e))?;

    // Find the .tar.gz archive from the release assets (contains the DXVK DLLs)
    let dxvk_asset = release.assets
        .iter()
        .find(|a| a.name.ends_with(".tar.gz"))
        .ok_or("No .tar.gz asset found in DXVK release")?;

    let dxvk_version = release.tag_name.clone();
    emit_progress(
        &app,
        "dxvk",
        "Downloading DXVK...",
        47.0,
        &format!("Downloading DXVK {}...", dxvk_version)
    );

    // Download DXVK archive
    let mut dxvk_dl_request = client.get(&dxvk_asset.browser_download_url);
    if let Some(ref token) = config.github_token {
        dxvk_dl_request = dxvk_dl_request.header("Authorization", format!("Bearer {}", token));
    }
    let dxvk_bytes = dxvk_dl_request
        .send().await
        .map_err(|e| format!("Failed to download DXVK: {}", e))?
        .bytes().await
        .map_err(|e| format!("Failed to read DXVK download: {}", e))?;

    let dxvk_archive_path = tmp_dir.join("dxvk.tar.gz");
    std::fs
        ::write(&dxvk_archive_path, &dxvk_bytes)
        .map_err(|e| format!("Failed to save DXVK archive: {}", e))?;

    emit_progress(&app, "dxvk", "Extracting DXVK...", 52.0, "Extracting DXVK archive...");

    // Extract archive (tar.gz -> directory with x32/ and x64/ subdirectories)
    let extract_dir = tmp_dir.join("dxvk-extract");
    std::fs
        ::create_dir_all(&extract_dir)
        .map_err(|e| format!("Failed to create extract dir: {}", e))?;

    {
        let file = std::fs::File
            ::open(&dxvk_archive_path)
            .map_err(|e| format!("Failed to open DXVK archive: {}", e))?;
        let decoder = flate2::read::GzDecoder::new(file);
        let mut archive = tar::Archive::new(decoder);
        crate::util::safe_unpack(&mut archive, &extract_dir).map_err(|e| format!("Failed to extract DXVK: {}", e))?;
    }

    emit_progress(&app, "dxvk", "Installing DXVK DLLs...", 55.0, "Copying DLLs to Wine prefix...");

    // Find extracted directory (typically dxvk-X.Y.Z/ within the archive)
    let dxvk_inner = std::fs
        ::read_dir(&extract_dir)
        .map_err(|e| format!("Failed to read extract dir: {}", e))?
        .filter_map(|e| e.ok())
        .find(|e| e.path().is_dir())
        .map(|e| e.path())
        .unwrap_or(extract_dir.clone());

    // The four DXVK DLLs that replace Direct3D with Vulkan
    let dll_names = ["d3d9.dll", "d3d10core.dll", "d3d11.dll", "dxgi.dll"];

    // Copy 64-bit DLLs to system32 (Wine uses system32 for 64-bit libraries)
    let sys32 = Path::new(&install_path).join("drive_c").join("windows").join("system32");
    std::fs::create_dir_all(&sys32).ok();
    let x64_dir = dxvk_inner.join("x64");
    if x64_dir.is_dir() {
        for name in &dll_names {
            let src = x64_dir.join(name);
            if src.exists() {
                let _ = std::fs::copy(&src, sys32.join(name));
            }
        }
    }

    // Copy 32-bit DLLs to syswow64 (Wine uses syswow64 for 32-bit libraries in a 64-bit prefix)
    let syswow64 = Path::new(&install_path).join("drive_c").join("windows").join("syswow64");
    std::fs::create_dir_all(&syswow64).ok();
    let x32_dir = dxvk_inner.join("x32");
    if x32_dir.is_dir() {
        for name in &dll_names {
            let src = x32_dir.join(name);
            if src.exists() {
                let _ = std::fs::copy(&src, syswow64.join(name));
            }
        }
    }

    // Register DLL overrides in the Wine registry so Wine uses the native
    // DXVK DLLs instead of the built-in Wine implementations
    emit_progress(
        &app,
        "dxvk",
        "Registering DXVK DLLs...",
        57.0,
        "Setting DLL overrides in registry..."
    );
    for name in &["d3d9", "d3d10core", "d3d11", "dxgi"] {
        let _ = Command::new(wine.to_string_lossy().as_ref())
            .args([
                "reg",
                "add",
                "HKEY_CURRENT_USER\\Software\\Wine\\DllOverrides",
                "/v",
                name,
                "/d",
                "native",
                "/f",
            ])
            .env("WINEPREFIX", &install_path)
            .env("WINEDLLOVERRIDES", "winemenubuilder.exe=d;winedbg.exe=d")
            .env("WINEDEBUG", "-all")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }

    // Write version marker so future installations can detect
    // which DXVK version is currently installed
    let dxvk_marker = Path::new(&install_path).join(".dxvk_version");
    let _ = std::fs::write(&dxvk_marker, &dxvk_version);

    // Clean up temporary DXVK files
    let _ = std::fs::remove_file(&dxvk_archive_path);
    let _ = std::fs::remove_dir_all(&extract_dir);

    emit_progress(
        &app,
        "dxvk",
        "DXVK installed",
        60.0,
        &format!("DXVK {} installed successfully", dxvk_version)
    );

    if is_cancelled() {
        return Err("Installation cancelled".into());
    }

    // ── Phase 4: Configure registry (60–65%) ──
    // Disable file associations so Wine doesn't create .desktop files
    // and MIME type associations on the Linux host
    emit_progress(&app, "registry", "Configuring registry...", 60.0, "Setting registry keys...");

    let mut reg_child = Command::new(wine.to_string_lossy().as_ref())
        .args([
            "reg",
            "add",
            "HKEY_CURRENT_USER\\Software\\Wine\\FileOpenAssociations",
            "/v",
            "Enable",
            "/d",
            "N",
            "/f",
        ])
        .env("WINEPREFIX", &install_path)
        .env("WINEDLLOVERRIDES", "winemenubuilder.exe=d;winedbg.exe=d")
        .env("WINEDEBUG", "-all")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to run wine reg: {}", e))?;

    stream_command_output(&app, "registry", "Setting registry keys...", 62.0, &mut reg_child);

    let reg_status = reg_child.wait().map_err(|e| format!("Failed to wait for wine reg: {}", e))?;

    if !reg_status.success() {
        emit_progress(
            &app,
            "registry",
            "Registry warning",
            63.0,
            "Registry key set returned non-zero (continuing anyway)"
        );
    }

    emit_progress(&app, "registry", "Registry configured", 64.0, "Registry configuration complete");

    // Kill wineserver after registry configuration so no
    // remaining Wine processes keep pipe handles open and
    // block the subsequent asynchronous download phase
    let _ = Command::new(wineserver.to_string_lossy().as_ref())
        .arg("-k")
        .env("WINEPREFIX", &install_path)
        .output();
    std::thread::sleep(std::time::Duration::from_secs(1));

    emit_progress(&app, "registry", "Registry complete", 65.0, "Wine processes cleaned up");

    if is_cancelled() {
        return Err("Installation cancelled".into());
    }

    // ── Phase 4 & 5: Download & install RSI Launcher (65–95%) ──
    // Skip in quick mode (RSI Launcher already exists)
    if skip_launcher {
        emit_progress(
            &app,
            "launcher_skip",
            "Skipping RSI Launcher...",
            65.0,
            "Quick Install: RSI Launcher already exists, skipping download and install"
        );
    } else {
        // ── Phase 4: Download RSI Launcher (65–85%) ──
        emit_progress(
            &app,
            "download",
            "Fetching launcher info...",
            65.0,
            "Downloading latest.yml..."
        );

        // Download latest.yml from RSI - contains the filename of the current installer version
        let latest_yml = client
            .get("https://install.robertsspaceindustries.com/rel/2/latest.yml")
            .send().await
            .map_err(|e| format!("Failed to fetch latest.yml: {}", e))?
            .text().await
            .map_err(|e| format!("Failed to read latest.yml: {}", e))?;

        // Extract installer filename from the "path:" line in latest.yml
        let installer_filename = latest_yml
            .lines()
            .find_map(|line| {
                let trimmed = line.trim();
                // First look for "path: filename.exe" at the top level
                if let Some(val) = trimmed.strip_prefix("path:") {
                    return Some(val.trim().to_string());
                }
                // Fallback: nested format "- url: filename.exe"
                let stripped = trimmed
                    .strip_prefix('-')
                    .map(|s| s.trim())
                    .unwrap_or(trimmed);
                if let Some(val) = stripped.strip_prefix("url:") {
                    return Some(val.trim().to_string());
                }
                None
            })
            .filter(|s| s.ends_with(".exe"))
            .ok_or("Could not find installer filename in latest.yml")?;

        let download_url =
            format!("https://install.robertsspaceindustries.com/rel/2/{}", installer_filename);

        emit_progress(
            &app,
            "download",
            "Downloading RSI Launcher...",
            67.0,
            &format!("Downloading {}", installer_filename)
        );

        // Download RSI Launcher installer (typically ~100 MB)
        let response = client
            .get(&download_url)
            .send().await
            .map_err(|e| format!("Failed to download RSI Launcher: {}", e))?;

        // Streaming download with progress display - the file is downloaded
        // and written in chunks instead of loading everything into memory
        let total_bytes = response.content_length().unwrap_or(0);
        let mut downloaded: u64 = 0;
        let installer_path = tmp_dir.join(&installer_filename);

        use futures_util::StreamExt;
        use tokio::io::AsyncWriteExt;

        let mut file = tokio::fs::File
            ::create(&installer_path).await
            .map_err(|e| format!("Failed to create installer file: {}", e))?;

        let mut stream = response.bytes_stream();
        let mut last_emit = std::time::Instant::now();
        while let Some(chunk_result) = stream.next().await {
            if is_cancelled() {
                let _ = file.flush().await;
                drop(file);
                return Err("Installation cancelled".into());
            }

            match chunk_result {
                Ok(chunk) => {
                    file
                        .write_all(&chunk).await
                        .map_err(|e| format!("Failed to write installer chunk: {}", e))?;
                    downloaded += chunk.len() as u64;

                    // Limit progress messages to at most one per 500ms
                    // to avoid flooding the frontend with events
                    let is_complete = total_bytes > 0 && downloaded >= total_bytes;
                    if is_complete || last_emit.elapsed() >= std::time::Duration::from_millis(500) {
                        let dl_percent = if total_bytes > 0 {
                            65.0 + ((downloaded as f64) / (total_bytes as f64)) * 20.0
                        } else {
                            75.0
                        };
                        let status_msg = if total_bytes > 0 {
                            format!(
                                "Downloading... {:.1} MB / {:.1} MB",
                                (downloaded as f64) / 1_048_576.0,
                                (total_bytes as f64) / 1_048_576.0
                            )
                        } else {
                            format!("Downloading... {:.1} MB", (downloaded as f64) / 1_048_576.0)
                        };
                        emit_progress(
                            &app,
                            "download",
                            "Downloading RSI Launcher...",
                            dl_percent,
                            &status_msg
                        );
                        last_emit = std::time::Instant::now();
                    }
                }
                Err(e) => {
                    return Err(format!("Download stream error: {}", e));
                }
            }
        }

        file.flush().await.map_err(|e| format!("Failed to flush installer file: {}", e))?;
        drop(file);

        emit_progress(
            &app,
            "download",
            "Download complete",
            85.0,
            "RSI Launcher downloaded successfully"
        );

        if is_cancelled() {
            return Err("Installation cancelled".into());
        }

        // ── Phase 5: Install RSI Launcher (85–95%) ──
        emit_progress(
            &app,
            "install",
            "Installing RSI Launcher...",
            85.0,
            &format!("Running: wine {} /S", installer_filename)
        );

        // The NSIS installer with /S (Silent Mode) automatically launches the RSI Launcher
        // as a child process. Stdio::null() prevents pipe handles from being inherited.
        // try_wait() with timeout is used because the NSIS process may not
        // exit until the RSI Launcher it spawned exits
        // (Wine keeps the parent process alive).
        let mut install_child = Command::new(wine.to_string_lossy().as_ref())
            .arg(installer_path.to_string_lossy().as_ref())
            .arg("/S")
            .env("WINEPREFIX", &install_path)
            .env("WINEDLLOVERRIDES", "winemenubuilder.exe=d;winedbg.exe=d")
            .env("WINEDEBUG", "-all")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("Failed to run RSI Launcher installer: {}", e))?;

        emit_progress(
            &app,
            "install",
            "Installing RSI Launcher...",
            88.0,
            "Waiting for installer to finish..."
        );

        // Monitor installer with timeout - the NSIS installer may block
        // because it waits for its child process (RSI Launcher)
        let install_timeout = std::time::Duration::from_secs(120);
        let install_start = std::time::Instant::now();
        let mut timed_out = false;

        loop {
            match install_child.try_wait() {
                Ok(Some(status)) => {
                    if !status.success() {
                        emit_progress(
                            &app,
                            "install",
                            "Install warning",
                            92.0,
                            &format!(
                                "Installer exited with code {:?} (may be normal)",
                                status.code()
                            )
                        );
                    }
                    break;
                }
                Ok(None) => {
                    // Check whether the RSI Launcher .exe has already been installed
                    // (installer is done but hasn't exited the process yet)
                    let launcher_exe = Path::new(&install_path).join(
                        "drive_c/Program Files/Roberts Space Industries/RSI Launcher/RSI Launcher.exe"
                    );
                    if
                        install_start.elapsed() > std::time::Duration::from_secs(15) &&
                        launcher_exe.exists()
                    {
                        emit_progress(
                            &app,
                            "install",
                            "Installing RSI Launcher...",
                            92.0,
                            "RSI Launcher installed, stopping installer process..."
                        );
                        let _ = install_child.kill();
                        let _ = install_child.wait();
                        timed_out = true;
                        break;
                    }

                    if install_start.elapsed() > install_timeout {
                        emit_progress(
                            &app,
                            "install",
                            "Install timeout",
                            92.0,
                            "Installer timed out, killing process..."
                        );
                        let _ = install_child.kill();
                        let _ = install_child.wait();
                        timed_out = true;
                        break;
                    }

                    std::thread::sleep(std::time::Duration::from_secs(1));
                    let elapsed = install_start.elapsed().as_secs();
                    emit_progress(
                        &app,
                        "install",
                        "Installing RSI Launcher...",
                        88.0 + ((elapsed as f64) / 120.0) * 4.0,
                        &format!("Waiting for installer... ({}s)", elapsed)
                    );
                }
                Err(e) => {
                    emit_progress(
                        &app,
                        "install",
                        "Install warning",
                        92.0,
                        &format!("Could not check installer status: {}", e)
                    );
                    break;
                }
            }
        }

        if timed_out {
            emit_progress(
                &app,
                "install",
                "Cleaning up...",
                93.0,
                "Killing Wine processes from installer..."
            );
        } else {
            emit_progress(
                &app,
                "install",
                "Cleaning up...",
                93.0,
                "Stopping installer-spawned processes..."
            );
        }

        // Kill wineserver to stop all processes automatically started by the installer
        let _ = Command::new(wineserver.to_string_lossy().as_ref())
            .arg("-k")
            .env("WINEPREFIX", &install_path)
            .output();

        // Give wineserver a moment to shut down all processes
        std::thread::sleep(std::time::Duration::from_secs(2));

        emit_progress(
            &app,
            "install",
            "Installation complete",
            95.0,
            "RSI Launcher installed successfully"
        );
    } // End of non-quick mode (phases 4/5)

    // Clean up temporary directory (only relevant in non-quick mode
    // where installer and other temporary files were created)
    if !skip_launcher {
        let _ = std::fs::remove_dir_all(&tmp_dir);
    }

    if is_cancelled() {
        return Err("Installation cancelled".into());
    }

    // ── Phase 6: Launch game (95–100%) ──
    // After successful installation the RSI Launcher is started directly
    // so the user doesn't have to manually switch to the launch page
    emit_progress(
        &app,
        "launch",
        "Launching RSI Launcher...",
        95.0,
        "Preparing launch environment..."
    );

    let mut cmd = Command::new(wine.to_string_lossy().as_ref());
    cmd.arg("C:\\Program Files\\Roberts Space Industries\\RSI Launcher\\RSI Launcher.exe");

    let _ = configure_wine_env(&mut cmd, &install_path, &config.performance, "info");

    cmd.stdout(Stdio::null()).stderr(Stdio::null());

    let mut child = cmd.spawn().map_err(|e| format!("Failed to launch RSI Launcher: {}", e))?;

    let pid = child.id();

    // Store PID so the launch page and stop_game know a process is running
    if let Ok(mut guard) = GAME_PID.lock() {
        *guard = Some((pid, install_path.clone()));
    }

    let _ = app.emit("launch-started", "RSI Launcher process started");
    let _ = app.emit("launch-log", &format!("> RSI Launcher started (PID: {})", pid));

    emit_progress(&app, "complete", "RSI Launcher started", 100.0, "RSI Launcher is now running");

    // Monitor child process in the background - send exit event when terminated
    let bg_app = app.clone();
    std::thread::spawn(move || {
        let status = child.wait();
        let code = status.ok().and_then(|s| s.code());

        if let Ok(mut guard) = GAME_PID.lock() {
            *guard = None;
        }

        let _ = bg_app.emit("launch-log", &format!("> RSI Launcher exited (code: {:?})", code));
        let _ = bg_app.emit("launch-exited", code.unwrap_or(-1));
    });

    Ok(())
}

/// Cancels the running installation.
/// Sets the global cancellation flag that is checked at multiple points in the
/// installation process. The installation will terminate cleanly at the next checkpoint.
#[tauri::command]
pub fn cancel_installation() -> bool {
    INSTALL_CANCEL.store(true, Ordering::SeqCst);
    true
}

/// Checks whether a game process is currently running.
/// Used by the frontend to control the state of the start/stop buttons.
#[tauri::command]
pub fn is_game_running() -> bool {
    GAME_PID.lock()
        .map(|guard| guard.is_some())
        .unwrap_or(false)
}

// ── Launcher Repair ──────────────────────────────────────────────────

/// Information about an existing repair backup.
#[derive(Serialize, Deserialize, Clone)]
pub struct RepairBackupInfo {
    /// Full path to the backup directory
    pub path: String,
    /// Total size in bytes (approximate, top-level only for speed)
    pub size_bytes: u64,
    /// Timestamp extracted from the folder name (e.g. "20260406_143022")
    pub created: String,
}

/// Prepares a repair by renaming the current Wine prefix to a timestamped backup.
///
/// After this, the frontend navigates the user through the normal installation
/// wizard (pick runner, install). Once installation completes, the frontend
/// calls `restore_sc_data` to move game data from the backup into the new prefix.
///
/// Returns the backup path on success.
#[tauri::command]
pub async fn repair_installation(app: AppHandle) -> Result<String, String> {
    let config = crate::config::load_config().await
        .map_err(|e| format!("Failed to load config: {}", e))?
        .ok_or("No configuration found")?;

    let install_path = expand_tilde(&config.install_path);

    if is_game_running() {
        return Err("Cannot repair while the game is running. Please stop it first.".into());
    }

    // Kill wineserver to clean up orphaned processes
    log::info!("Repair: killing wineserver...");
    let runner_name = config.selected_runner.as_deref();
    if let Some(name) = runner_name {
        let runner_dir = Path::new(&install_path).join("runners").join(name);
        if let Some(wine) = resolve_wine_bin(&runner_dir) {
            let wineserver = wine.with_file_name("wineserver");
            if wineserver.exists() {
                let _ = Command::new(wineserver.to_string_lossy().as_ref())
                    .arg("-k")
                    .env("WINEPREFIX", &install_path)
                    .output();
            }
        }
    }

    // Rename prefix to backup
    let timestamp = chrono::Local::now().format("%Y%m%d_%H%M%S").to_string();
    let install_dir = PathBuf::from(&install_path);
    let parent = install_dir.parent()
        .ok_or("Cannot determine parent directory of install path")?;
    let dir_name = install_dir.file_name()
        .ok_or("Cannot determine directory name of install path")?
        .to_string_lossy();
    let backup_name = format!("{}_repair_backup_{}", dir_name, timestamp);
    let backup_path = parent.join(&backup_name);

    log::info!("Repair: renaming {} -> {}", install_dir.display(), backup_path.display());
    std::fs::rename(&install_dir, &backup_path)
        .map_err(|e| format!("Failed to rename prefix to backup: {}", e))?;

    let _ = app.emit("repair-backup-created", backup_path.to_string_lossy().to_string());
    log::info!("Repair: prefix renamed to backup. User can now run a fresh installation.");

    Ok(backup_path.to_string_lossy().to_string())
}

/// Restores Star Citizen game data from a repair backup into the current installation.
///
/// Called by the frontend after a successful fresh installation completes.
/// Moves the `StarCitizen` folder from the backup's RSI directory into the
/// new installation's RSI directory.
#[tauri::command]
pub async fn restore_sc_data(backup_path: String, install_path: String) -> Result<(), String> {
    let install_path = expand_tilde(&install_path);
    let backup = PathBuf::from(&backup_path);
    let install_dir = PathBuf::from(&install_path);

    let sc_folder_name = "StarCitizen";
    let rsi_base = PathBuf::from("drive_c")
        .join("Program Files")
        .join("Roberts Space Industries");
    let sc_src = backup.join(&rsi_base).join(sc_folder_name);
    let sc_dst = install_dir.join(&rsi_base).join(sc_folder_name);

    if !sc_src.exists() {
        log::info!("No StarCitizen folder found in backup, skipping restore");
        return Ok(());
    }

    // Remove the empty SC dir in the new install if it exists
    if sc_dst.exists() {
        let _ = std::fs::remove_dir_all(&sc_dst);
    }

    log::info!("Restoring StarCitizen data: {} -> {}", sc_src.display(), sc_dst.display());
    std::fs::rename(&sc_src, &sc_dst)
        .map_err(|e| format!(
            "Failed to move StarCitizen folder: {}. Please copy manually from: {}",
            e, sc_src.display()
        ))?;

    Ok(())
}

/// Checks whether a repair backup exists next to the installation directory.
/// Returns info about the most recent backup if found.
#[tauri::command]
pub async fn check_repair_backup(install_path: String) -> Result<Option<RepairBackupInfo>, String> {
    let install_path = expand_tilde(&install_path);
    let install_dir = PathBuf::from(&install_path);
    let parent = install_dir.parent()
        .ok_or("Cannot determine parent directory")?;
    let dir_name = install_dir.file_name()
        .ok_or("Cannot determine directory name")?
        .to_string_lossy();

    let prefix = format!("{}_repair_backup_", dir_name);

    let mut best: Option<RepairBackupInfo> = None;

    if let Ok(entries) = std::fs::read_dir(parent) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if !name.starts_with(&prefix) {
                continue;
            }
            if !entry.path().is_dir() {
                continue;
            }
            let timestamp = name.strip_prefix(&prefix).unwrap_or("").to_string();

            // Calculate approximate size (non-recursive for speed)
            let size = dir_size_approx(&entry.path());

            let info = RepairBackupInfo {
                path: entry.path().to_string_lossy().to_string(),
                size_bytes: size,
                created: timestamp.clone(),
            };

            // Keep the most recent backup (lexicographic comparison on timestamp)
            if best.as_ref().is_none_or(|b| timestamp > b.created) {
                best = Some(info);
            }
        }
    }

    Ok(best)
}

/// Deletes a repair backup directory after validation.
/// Safety checks prevent misuse (path must contain `_repair_backup_`
/// and must be in the same parent directory as the install path).
#[tauri::command]
pub async fn delete_repair_backup(backup_path: String, install_path: String) -> Result<(), String> {
    let install_path = expand_tilde(&install_path);
    let backup = PathBuf::from(&backup_path);
    let install_dir = PathBuf::from(&install_path);

    // Validation: backup name must contain the marker
    let backup_name = backup.file_name()
        .ok_or("Invalid backup path")?
        .to_string_lossy();
    if !backup_name.contains("_repair_backup_") {
        return Err("Invalid backup path: does not look like a repair backup.".into());
    }

    // Validation: same parent directory
    let backup_parent = backup.parent().ok_or("Cannot determine backup parent")?;
    let install_parent = install_dir.parent().ok_or("Cannot determine install parent")?;
    if backup_parent != install_parent {
        return Err("Invalid backup path: not in the same directory as the installation.".into());
    }

    // Validation: must exist and be a directory
    if !backup.is_dir() {
        return Err("Backup directory does not exist.".into());
    }

    log::info!("Deleting repair backup: {}", backup.display());
    tokio::fs::remove_dir_all(&backup).await
        .map_err(|e| format!("Failed to delete backup: {}", e))?;

    Ok(())
}

/// Calculates the approximate size of a directory (recursive).
/// Returns 0 on errors rather than failing.
fn dir_size_approx(path: &Path) -> u64 {
    let mut total: u64 = 0;
    if let Ok(entries) = std::fs::read_dir(path) {
        for entry in entries.flatten() {
            let ft = entry.file_type();
            if let Ok(ft) = ft {
                if ft.is_file() {
                    total += entry.metadata().map(|m| m.len()).unwrap_or(0);
                } else if ft.is_dir() {
                    total += dir_size_approx(&entry.path());
                }
            }
        }
    }
    total
}
