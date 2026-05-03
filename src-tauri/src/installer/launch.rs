use crate::config::AppConfig;
use crate::runners::resolve_wine_bin;
use crate::util::expand_tilde;
use std::path::Path;
use std::process::{ Command, Stdio };
use tauri::{ AppHandle, Emitter };

use super::{ configure_wine_env, InstallationStatus, GAME_PID };

/// Checks whether a runner directory contains a usable wine binary.
fn runner_is_installed(install_path: &str, runner_name: &str) -> bool {
    if runner_name.is_empty() {
        return false;
    }
    let dir = Path::new(install_path).join("runners").join(runner_name);
    resolve_wine_bin(&dir).is_some()
}

/// Resolves which runner to actually launch with.
///
/// 1. If the active profile's runner (`working_runner`) is installed, use it.
/// 2. Else if a `fallback` is configured AND installed, use the fallback
///    (caller is expected to emit a `runner-fallback-used` event so the
///    user knows their profile's chosen runner has been substituted).
/// 3. Else return a user-facing error string.
///
/// Returns `(resolved_runner_name, used_fallback)`.
pub(super) fn resolve_runner_for_launch(
    install_path: &str,
    working_runner: &str,
    fallback: Option<&str>,
) -> Result<(String, bool), String> {
    if runner_is_installed(install_path, working_runner) {
        return Ok((working_runner.to_string(), false));
    }
    if let Some(fb) = fallback.filter(|s| !s.is_empty()) {
        if runner_is_installed(install_path, fb) {
            return Ok((fb.to_string(), true));
        }
    }
    if working_runner.is_empty() {
        Err(
            "No runner selected for the active profile. Choose one on the Launch page or set a fallback in Settings.".to_string()
        )
    } else {
        Err(format!(
            "No usable runner. Profile runner '{}' is not installed and no usable fallback is set.",
            working_runner
        ))
    }
}

/// Checks the current installation status of Star Citizen.
///
/// Verifies whether a Wine runner is present and whether the RSI Launcher .exe
/// exists in the Wine prefix. Returns a detailed status that the frontend
/// uses for display and the "install vs. launch" decision.
#[tauri::command]
pub fn check_installation(config: AppConfig) -> InstallationStatus {
    let install_path = expand_tilde(&config.install_path);

    // Use the live working state's runner. None == empty string here.
    let working_runner = &config.launch_working_state.runner_name;
    let runner_name = if working_runner.is_empty() {
        None
    } else {
        Some(working_runner.clone())
    };
    let has_runner = runner_name
        .as_ref()
        .is_some_and(|name| runner_is_installed(&install_path, name));

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
    // Guard against double-launch: reject if a game process is already tracked
    {
        let guard = GAME_PID.lock().unwrap_or_else(|e| e.into_inner());
        if guard.is_some() {
            return Err("Game is already running".into());
        }
    }

    let install_path = expand_tilde(&config.install_path);
    let working = &config.launch_working_state;
    let (runner_name, used_fallback) = resolve_runner_for_launch(
        &install_path,
        &working.runner_name,
        config.fallback_runner.as_deref(),
    )?;
    let log_level = config.log_level.as_str();
    let is_debug = log_level == "debug";

    // Resolve Wine binary from the runner directory (supports standard Wine + Proton layouts)
    let runner_dir = Path::new(&install_path).join("runners").join(&runner_name);
    let wine = resolve_wine_bin(&runner_dir)
        .ok_or_else(|| format!("Wine binary not found in {}", runner_dir.display()))?;
    let runner_bin = wine.parent()
        .ok_or_else(|| "Wine binary has no parent directory".to_string())?
        .to_path_buf();
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
    if used_fallback {
        let _ = app.emit(
            "launch-log",
            &format!(
                "            (fallback used: profile runner '{}' is not installed)",
                working.runner_name
            ),
        );
        let _ = app.emit(
            "runner-fallback-used",
            serde_json::json!({
                "profile_runner": working.runner_name.clone(),
                "fallback_runner": runner_name.clone(),
            }),
        );
    }
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

    // --- Build launch command (gamescope -> gamemoderun -> wine -> launcher) ---
    let perf_settings = &config.launch_working_state.performance;
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

    let env_log = configure_wine_env(&mut cmd, &install_path, &config.launch_working_state.performance, log_level);

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
    let perf = &config.launch_working_state.performance;
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
    // Therefore redirect stdout/stderr either to /dev/null (default) or, in
    // debug mode, to a dedicated wine.log file. A file-backed Stdio::from is
    // owned by the child kernel-side, so it does not keep parent handles
    // alive (unlike Stdio::piped()).
    if is_debug {
        let wine_log_path = dirs::config_dir()
            .unwrap_or_else(|| std::path::PathBuf::from("."))
            .join("penguin-citizen")
            .join("logs")
            .join("wine.log");
        match std::fs::File::options()
            .create(true)
            .truncate(true)
            .write(true)
            .open(&wine_log_path)
        {
            Ok(file) => {
                // Use the same file for both streams so output stays chronologically ordered.
                let dup = file.try_clone();
                cmd.stdout(Stdio::from(file));
                match dup {
                    Ok(d) => { cmd.stderr(Stdio::from(d)); }
                    Err(_) => { cmd.stderr(Stdio::null()); }
                }
                let _ = app.emit(
                    "launch-log",
                    &format!("> Wine output -> {}", wine_log_path.display())
                );
            }
            Err(e) => {
                let _ = app.emit(
                    "launch-log",
                    &format!("> Failed to open wine.log ({}), falling back to /dev/null", e)
                );
                cmd.stdout(Stdio::null()).stderr(Stdio::null());
            }
        }
    } else {
        cmd.stdout(Stdio::null()).stderr(Stdio::null());
    }

    let _ = app.emit("launch-log", "");
    let _ = app.emit("launch-log", "> Starting RSI Launcher...");

    let mut child = cmd.spawn().map_err(|e| format!("Failed to launch RSI Launcher: {}", e))?;

    let pid = child.id();
    let _ = app.emit("launch-log", &format!("> RSI Launcher started (PID: {})", pid));
    let _ = app.emit("launch-started", "RSI Launcher process started");

    // Store PID and installation path so stop_game can terminate the process
    *GAME_PID.lock().unwrap_or_else(|e| e.into_inner()) = Some((pid, install_path.clone()));

    // Monitor child process in the background - when the launcher exits,
    // the thread sends a "launch-exited" event to the frontend
    std::thread::spawn(move || {
        let status = child.wait();
        let code = status.ok().and_then(|s| s.code());

        // Clear stored PID since the process is no longer running
        *GAME_PID.lock().unwrap_or_else(|e| e.into_inner()) = None;

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

    // Verify the PID still belongs to a Wine-related process before killing.
    // This guards against PID reuse by the OS after the process has already exited.
    let pid_i32 = pid as i32;
    let comm = std::fs::read_to_string(format!("/proc/{}/comm", pid)).unwrap_or_default();
    let comm = comm.trim();
    if !comm.is_empty() {
        // SAFETY: PID verified to still exist via /proc
        unsafe { libc::kill(pid_i32, libc::SIGTERM); }

        // Wait 2 seconds, then SIGKILL if the process is still alive
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        unsafe { libc::kill(pid_i32, libc::SIGKILL); }
    }

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
    *GAME_PID.lock().unwrap_or_else(|e| e.into_inner()) = None;

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

/// Checks whether a game process is currently running.
/// Used by the frontend to control the state of the start/stop buttons.
#[tauri::command]
pub fn is_game_running() -> bool {
    GAME_PID.lock()
        .map(|guard| guard.is_some())
        .unwrap_or(false)
}
