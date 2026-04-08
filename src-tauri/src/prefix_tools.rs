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

//! Module for Wine prefix tools.
//!
//! This module provides various tools for managing Wine prefixes:
//! - winecfg: Open the Wine configuration dialog
//! - Wine shell: Launch a terminal with a preconfigured Wine environment
//! - DPI settings: Read and set the DPI value in the Wine prefix
//! - PowerShell: Install PowerShell via winetricks in the prefix
//!
//! These tools help with configuring the Wine prefix
//! for optimal Star Citizen performance.

use std::io::{ BufRead, BufReader };
use std::path::Path;
use std::process::{ Command, Stdio };
use tauri::{ AppHandle, Emitter };

use crate::runners::resolve_wine_bin;
use crate::util::expand_tilde;

/// Determines the paths for the Wine binary, runner bin directory, and prefix.
///
/// Returns a tuple: (prefix path, Wine binary path, runner bin directory).
/// Checks known wine binary layouts (standard Wine, GE-Proton, older Proton).
fn get_wine_paths(
    base_path: &str,
    runner_name: &str
) -> Result<(std::path::PathBuf, std::path::PathBuf, std::path::PathBuf), String> {
    let expanded = expand_tilde(base_path);
    let prefix = Path::new(&expanded);
    let runner_dir = prefix.join("runners").join(runner_name);
    let wine = resolve_wine_bin(&runner_dir)
        .ok_or_else(|| format!("Wine binary not found in {}", runner_dir.display()))?;
    let runner_bin = wine.parent()
        .ok_or_else(|| "Wine binary has no parent directory".to_string())?
        .to_path_buf();

    Ok((prefix.to_path_buf(), wine, runner_bin))
}

/// Launches the Wine configuration dialog (winecfg).
///
/// Opens the graphical Wine configuration tool in the context of the specified prefix.
/// The environment variables suppress the Wine menu builder and debugger,
/// which are not needed for Star Citizen and can cause error messages.
#[tauri::command]
pub async fn run_winecfg(base_path: String, runner_name: String) -> Result<(), String> {
    let (prefix, wine, _) = get_wine_paths(&base_path, &runner_name)?;

    Command::new(wine.to_string_lossy().as_ref())
        .arg("winecfg")
        .env("WINEPREFIX", prefix.to_string_lossy().as_ref())
        // Disable winemenubuilder and winedbg to avoid unwanted side effects
        .env("WINEDLLOVERRIDES", "winemenubuilder.exe=d;winedbg.exe=d")
        // Suppress all debug output for clean execution
        .env("WINEDEBUG", "-all")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("Failed to launch winecfg: {}", e))?;

    Ok(())
}

/// Opens a terminal with a preconfigured Wine environment.
///
/// Automatically searches for an available terminal emulator on the system
/// (Konsole, GNOME Terminal, XFCE4 Terminal, or xterm) and launches
/// a Wine command line (wine cmd) inside it.
///
/// The Wine environment variables (WINEPREFIX, PATH) are set safely via .env()
/// instead of shell interpolation to avoid injection risks.
#[tauri::command]
pub async fn launch_wine_shell(base_path: String, runner_name: String) -> Result<(), String> {
    let (prefix, _wine, wine_bin_dir) = get_wine_paths(&base_path, &runner_name)?;

    let prefix_str = prefix.to_string_lossy().to_string();
    let wine_bin_str = wine_bin_dir.to_string_lossy().to_string();

    // Search for an available terminal emulator -- supports the most common Linux terminals.
    // AppImage sandboxes modify PATH/LD_LIBRARY_PATH, so we must clean the environment
    // for `which` to find host system binaries.
    let find_terminal = |name: &str| -> bool {
        let mut cmd = Command::new("which");
        cmd.arg(name);
        cmd.env_remove("LD_LIBRARY_PATH");
        cmd.env_remove("LD_PRELOAD");
        cmd.env_remove("APPDIR");
        cmd.env_remove("APPIMAGE");
        cmd.output().map(|o| o.status.success()).unwrap_or(false)
    };

    let terminal = if find_terminal("konsole") {
        "konsole"
    } else if find_terminal("gnome-terminal") {
        "gnome-terminal"
    } else if find_terminal("xfce4-terminal") {
        "xfce4-terminal"
    } else if find_terminal("xterm") {
        "xterm"
    } else {
        return Err(
            "No terminal emulator found (konsole, gnome-terminal, xfce4-terminal, xterm)".into()
        );
    };

    // Create a helper script that sets up the Wine environment.
    // A script is used instead of direct shell interpolation
    // to avoid command injection risks with paths containing special characters.
    let script_dir = std::path::Path::new(&prefix_str).join(".tmp");
    std::fs::create_dir_all(&script_dir).map_err(|e| format!("Failed to create tmp dir: {}", e))?;
    let script_path = script_dir.join("wine_shell.sh");
    let script_content = "#!/bin/bash\nexport WINEDEBUG=-all\nwine cmd\n";
    std::fs
        ::write(&script_path, script_content)
        .map_err(|e| format!("Failed to write shell script: {}", e))?;

    // Make script executable (Unix systems only)
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs
            ::set_permissions(&script_path, std::fs::Permissions::from_mode(0o755))
            .map_err(|e| format!("Failed to chmod script: {}", e))?;
    }

    let script_path_str = script_path.to_string_lossy().to_string();

    // Helper function to launch a terminal command with the required environment variables.
    // The Wine bin path is prepended to PATH so the script can find "wine" directly.
    // AppImage env vars are removed so the terminal runs in the host environment.
    let build_cmd = |name: &str, args: &[&str]| -> Result<(), String> {
        Command::new(name)
            .args(args)
            .env("WINEPREFIX", &prefix_str)
            .env("PATH", format!("{}:{}", wine_bin_str, std::env::var("PATH").unwrap_or_default()))
            .env("WINEDEBUG", "-all")
            .env_remove("LD_LIBRARY_PATH")
            .env_remove("LD_PRELOAD")
            .env_remove("APPDIR")
            .env_remove("APPIMAGE")
            .spawn()
            .map_err(|e| format!("Failed to launch {}: {}", name, e))?;
        Ok(())
    };

    // Launch the terminal with the Wine shell script -- each terminal has different arguments
    match terminal {
        "konsole" => build_cmd("konsole", &["--hold", "-e", "bash", &script_path_str])?,
        "gnome-terminal" => build_cmd("gnome-terminal", &["--", "bash", &script_path_str])?,
        "xfce4-terminal" =>
            build_cmd("xfce4-terminal", &["-e", &format!("bash {}", &script_path_str)])?,
        "xterm" => build_cmd("xterm", &["-e", "bash", &script_path_str])?,
        _ => {
            return Err("No terminal emulator found".into());
        }
    }

    Ok(())
}

/// Reads the current DPI value from the Windows registry of the Wine prefix.
///
/// The DPI value is read from the registry key `HKCU\Control Panel\Desktop\LogPixels`.
/// This value affects the UI scaling of Windows applications running through Wine.
///
/// Returns 96 as the default value if the value cannot be read.
#[tauri::command]
pub async fn get_dpi(base_path: String, runner_name: String) -> Result<u32, String> {
    let (prefix, wine, _) = get_wine_paths(&base_path, &runner_name)?;

    tokio::task
        ::spawn_blocking(move || {
            // Query the Wine registry via "wine reg query"
            let output = Command::new(wine.to_string_lossy().as_ref())
                .args(["reg", "query", "HKCU\\Control Panel\\Desktop", "/v", "LogPixels"])
                .env("WINEPREFIX", prefix.to_string_lossy().as_ref())
                .env("WINEDLLOVERRIDES", "winemenubuilder.exe=d;winedbg.exe=d")
                .env("WINEDEBUG", "-all")
                .output()
                .map_err(|e| format!("Failed to query DPI: {}", e))?;

            let stdout = String::from_utf8_lossy(&output.stdout);

            // Parse output: "    LogPixels    REG_DWORD    0x60"
            // The hex value at the end of the line is the DPI value
            for line in stdout.lines() {
                if line.contains("LogPixels") {
                    if let Some(hex_val) = line.split_whitespace().last() {
                        // Try hex format first (0x...)
                        if let Some(stripped) = hex_val.strip_prefix("0x") {
                            if let Ok(val) = u32::from_str_radix(stripped, 16) {
                                return Ok(val);
                            }
                        }
                        // Alternatively try decimal format
                        if let Ok(val) = hex_val.parse::<u32>() {
                            return Ok(val);
                        }
                    }
                }
            }

            // Return default DPI if nothing was found
            Ok(96)
        }).await
        .map_err(|e| format!("Task failed: {}", e))?
}

/// Sets the DPI value in the Windows registry of the Wine prefix.
///
/// Allows values between 96 (100% scaling) and 480 (500% scaling).
/// The value is written to the registry via "wine reg add".
/// A higher DPI value makes the UI elements in Star Citizen larger.
#[tauri::command]
pub async fn set_dpi(base_path: String, runner_name: String, dpi: u32) -> Result<(), String> {
    // Input validation: only allow sensible DPI values
    if !(96..=480).contains(&dpi) {
        return Err(format!("DPI must be between 96 and 480, got {}", dpi));
    }

    let (prefix, wine, _) = get_wine_paths(&base_path, &runner_name)?;

    tokio::task
        ::spawn_blocking(move || {
            // Write DPI value to the registry via "wine reg add"
            // /f forces overwriting without confirmation dialog
            let output = Command::new(wine.to_string_lossy().as_ref())
                .args([
                    "reg",
                    "add",
                    "HKCU\\Control Panel\\Desktop",
                    "/v",
                    "LogPixels",
                    "/t",
                    "REG_DWORD",
                    "/d",
                    &dpi.to_string(),
                    "/f",
                ])
                .env("WINEPREFIX", prefix.to_string_lossy().as_ref())
                .env("WINEDLLOVERRIDES", "winemenubuilder.exe=d;winedbg.exe=d")
                .env("WINEDEBUG", "-all")
                .output()
                .map_err(|e| format!("Failed to set DPI: {}", e))?;

            if !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr);
                return Err(format!("Failed to set DPI: {}", stderr));
            }

            Ok(())
        }).await
        .map_err(|e| format!("Task failed: {}", e))?
}

/// Installs PowerShell in the Wine prefix via winetricks.
///
/// PowerShell is needed by some Star Citizen tools. The installation runs
/// via winetricks, which is automatically downloaded from GitHub.
///
/// Workflow:
/// 1. Download winetricks script from GitHub
/// 2. Make script executable
/// 3. Kill running wineserver instances (prevents conflicts)
/// 4. Execute `winetricks -q powershell`
/// 5. Stream stdout/stderr live to the frontend (via Tauri events)
/// 6. Create marker file for later detection
/// 7. Clean up temporary files
#[tauri::command]
pub async fn install_powershell(
    app: AppHandle,
    base_path: String,
    runner_name: String
) -> Result<(), String> {
    let (prefix, wine, wineserver) = get_wine_paths(&base_path, &runner_name)?;

    // Closure for sending log lines to the frontend
    let emit_log = |line: &str| {
        let _ = app.emit("prefix-tool-log", line.to_string());
    };

    emit_log("Downloading winetricks...");

    // Download winetricks from GitHub
    let tmp_dir = prefix.join(".tmp");
    std::fs::create_dir_all(&tmp_dir).map_err(|e| format!("Failed to create tmp dir: {}", e))?;

    let winetricks_path = tmp_dir.join("winetricks");

    let client = reqwest::Client
        ::builder()
        .user_agent("penguin-citizen/0.5.0")
        .connect_timeout(std::time::Duration::from_secs(10))
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());

    let wt_bytes = client
        .get("https://raw.githubusercontent.com/Winetricks/winetricks/master/src/winetricks")
        .send().await
        .map_err(|e| format!("Failed to download winetricks: {}", e))?
        .bytes().await
        .map_err(|e| format!("Failed to read winetricks: {}", e))?;

    std::fs
        ::write(&winetricks_path, &wt_bytes)
        .map_err(|e| format!("Failed to write winetricks: {}", e))?;

    // Make winetricks script executable (Unix only)
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs
            ::set_permissions(&winetricks_path, std::fs::Permissions::from_mode(0o755))
            .map_err(|e| format!("Failed to chmod winetricks: {}", e))?;
    }

    emit_log("Installing PowerShell via winetricks (this may take several minutes)...");

    // Create marker to suppress Wine 64-bit warnings
    let marker = prefix.join("no_win64_warnings");
    let _ = std::fs::write(&marker, "");

    // Kill any running wineserver to avoid conflicts
    let _ = Command::new(wineserver.to_string_lossy().as_ref())
        .arg("-k")
        .env("WINEPREFIX", prefix.to_string_lossy().as_ref())
        .output();

    // Run winetricks with PowerShell package (-q = quiet mode)
    let mut child = Command::new(winetricks_path.to_string_lossy().as_ref())
        .args(["-q", "powershell"])
        .env("WINEPREFIX", prefix.to_string_lossy().as_ref())
        .env("WINE", wine.to_string_lossy().as_ref())
        .env("WINESERVER", wineserver.to_string_lossy().as_ref())
        .env("WINEDLLOVERRIDES", "winemenubuilder.exe=d;winedbg.exe=d")
        .env("WINEDEBUG", "-all")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to run winetricks: {}", e))?;

    // Read stderr in a separate thread and send to the frontend
    // to avoid deadlocks (stdout and stderr could fill up simultaneously)
    let stderr_handle = child.stderr.take().map(|stderr| {
        let app_clone = app.clone();
        std::thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines().map_while(Result::ok) {
                let _ = app_clone.emit("prefix-tool-log", line);
            }
        })
    });

    // Read stdout line by line and send to the frontend
    if let Some(stdout) = child.stdout.take() {
        let reader = BufReader::new(stdout);
        for line in reader.lines().map_while(Result::ok) {
            emit_log(&line);
        }
    }

    // Wait until the stderr thread is finished
    if let Some(handle) = stderr_handle {
        let _ = handle.join();
    }

    // Wait for the winetricks process to finish
    let status = child.wait().map_err(|e| format!("Failed to wait for winetricks: {}", e))?;

    // Clean up temporary files
    let _ = std::fs::remove_dir_all(&tmp_dir);

    if !status.success() {
        emit_log(&format!("winetricks powershell exited with code {:?}", status.code()));
        return Err(format!("winetricks powershell failed with exit code {:?}", status.code()));
    }

    // Create marker file so detect_powershell() can recognize the installation
    let ps_marker = prefix.join(".powershell_installed");
    let _ = std::fs::write(&ps_marker, "1");

    emit_log("PowerShell installed successfully!");
    Ok(())
}

/// Detects whether PowerShell is installed in the Wine prefix.
///
/// First checks the marker file `.powershell_installed` (created during installation),
/// and as a fallback checks the actual installation paths of PowerShell
/// (Windows PowerShell 5.x and PowerShell 7.x).
#[tauri::command]
pub async fn detect_powershell(base_path: String) -> Result<bool, String> {
    let result = tokio::task
        ::spawn_blocking(move || {
            let expanded = expand_tilde(&base_path);
            let prefix = Path::new(&expanded);

            // Check marker file first (faster than filesystem search)
            let marker = prefix.join(".powershell_installed");
            if marker.exists() {
                return Ok::<bool, String>(true);
            }

            // Fallback: Check actual PowerShell installation paths
            // Path 1: Windows PowerShell 5.x (installed via winetricks)
            let ps_path1 = prefix
                .join("drive_c")
                .join("windows")
                .join("system32")
                .join("WindowsPowerShell")
                .join("v1.0")
                .join("powershell.exe");

            // Path 2: PowerShell 7.x (standalone installation)
            let ps_path2 = prefix
                .join("drive_c")
                .join("Program Files")
                .join("PowerShell")
                .join("7")
                .join("pwsh.exe");

            Ok(ps_path1.exists() || ps_path2.exists())
        }).await
        .map_err(|e| format!("Task failed: {}", e))?;

    result.map_err(|e| format!("Task failed: {}", e))
}
