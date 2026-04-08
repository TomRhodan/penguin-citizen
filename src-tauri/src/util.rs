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

//! Shared utility functions used across multiple modules.

use std::io;
use std::path::Path;
use tauri::Window;
use base64::{Engine as _, engine::general_purpose};

/// Validates a screenshot filename to prevent path traversal.
/// Only a plain filename (no slashes, no `..`) is accepted.
fn validate_screenshot_filename(filename: &str) -> Result<(), String> {
    if filename.is_empty()
        || filename.contains('/')
        || filename.contains('\\')
        || filename.contains("..")
    {
        return Err("Invalid filename: must not contain path separators or '..'".into());
    }
    Ok(())
}

/// Robustly captures the current active window to a file using system tools.
/// Automatically detects project root to avoid rebuild loops during development.
#[tauri::command]
pub async fn capture_app_window(window: Window, filename: String) -> Result<(), String> {
    validate_screenshot_filename(&filename)?;

    let mut project_root = std::env::current_dir().map_err(|e| format!("Failed to get current dir: {}", e))?;

    // If we are in src-tauri, we must go up to reach the project root
    if project_root.ends_with("src-tauri") {
        project_root.pop();
    }

    let target_path = project_root
        .join("docs/penguin-citizen.de/assets/screenshots")
        .join(&filename);

    log::info!("Capturing window to: {:?}", target_path);

    // Ensure directory exists
    if let Some(parent) = target_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    #[cfg(target_os = "linux")]
    {
        // Focus the window before taking the screenshot to ensure it's on top
        let _ = window.set_focus();
        
        // Short delay to ensure UI has finished rendering and focus is set
        std::thread::sleep(std::time::Duration::from_millis(500));

        let path_str = target_path.to_str()
            .ok_or_else(|| "Screenshot path contains invalid UTF-8".to_string())?;

        // KDE Spectacle: -a (active window), -b (background), -n (non-interactive), -o (output)
        if let Ok(status) = std::process::Command::new("spectacle")
            .args(["-a", "-b", "-n", "-o", path_str])
            .status()
        {
            if status.success() { return Ok(()); }
        }

        // Fallback: GNOME Screenshot
        if let Ok(status) = std::process::Command::new("gnome-screenshot")
            .args(["-w", "-f", path_str])
            .status()
        {
            if status.success() { return Ok(()); }
        }

        // Fallback: Grim (Wayland Generic)
        if let Ok(status) = std::process::Command::new("grim")
            .args([path_str])
            .status()
        {
            if status.success() { return Ok(()); }
        }

        Err("No screenshot tool found. Please install spectacle or gnome-screenshot.".into())
    }

    #[cfg(not(target_os = "linux"))]
    {
        Err("Only Linux supported.".into())
    }
}

/// Robustly saves a base64 encoded image (Fallback).
#[tauri::command]
pub async fn save_screenshot(base64_data: String, filename: String) -> Result<(), String> {
    validate_screenshot_filename(&filename)?;

    let mut project_root = std::env::current_dir().map_err(|e| e.to_string())?;
    if project_root.ends_with("src-tauri") { project_root.pop(); }

    let target_path = project_root.join("docs/penguin-citizen.de/assets/screenshots").join(&filename);
    let data = base64_data.split(',').next_back().ok_or("Invalid image data")?;
    let decoded = general_purpose::STANDARD.decode(data).map_err(|e| e.to_string())?;
    
    std::fs::write(target_path, decoded).map_err(|e| e.to_string())?;
    Ok(())
}

/// Detects the default browser binary on Linux.
/// Reads the .desktop file's Exec= line to find the actual binary name.
#[cfg(target_os = "linux")]
fn detect_default_browser() -> Option<String> {
    let output = std::process::Command::new("xdg-settings")
        .args(["get", "default-web-browser"])
        .output()
        .ok()?;
    if !output.status.success() { return None; }
    let desktop_name = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if desktop_name.is_empty() { return None; }

    // Search for the .desktop file in standard locations
    let data_dirs = std::env::var("XDG_DATA_DIRS")
        .unwrap_or_else(|_| "/usr/local/share:/usr/share".to_string());
    let home = dirs::home_dir().unwrap_or_default();
    let mut search_dirs: Vec<std::path::PathBuf> = vec![home.join(".local/share/applications")];
    for dir in data_dirs.split(':') {
        search_dirs.push(std::path::PathBuf::from(dir).join("applications"));
    }

    for dir in &search_dirs {
        let path = dir.join(&desktop_name);
        if let Ok(content) = std::fs::read_to_string(&path) {
            for line in content.lines() {
                if let Some(exec) = line.strip_prefix("Exec=") {
                    // Exec line is e.g. "/usr/bin/google-chrome-stable %U"
                    // Take the first token as the binary
                    let binary = exec.split_whitespace().next()?;
                    // Could be a full path or just a name
                    let bin_name = std::path::Path::new(binary)
                        .file_name()?
                        .to_str()?
                        .to_string();
                    if std::process::Command::new("which")
                        .arg(&bin_name)
                        .output()
                        .map(|o| o.status.success())
                        .unwrap_or(false)
                    {
                        return Some(bin_name);
                    }
                }
            }
        }
    }

    // Fallback: try the desktop file name without .desktop suffix
    let name = desktop_name.strip_suffix(".desktop")?;
    if std::process::Command::new("which")
        .arg(name)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
    {
        Some(name.to_string())
    } else {
        None
    }
}

/// Opens a URL in the default browser or a path in the file manager, robustly.
#[tauri::command]
pub fn open_browser(url: String) -> Result<(), String> {
    let is_url = url.starts_with("http://") || url.starts_with("https://") || url.starts_with("mailto:");
    let is_path = url.starts_with('/') || url.starts_with('~');

    if !is_url && !is_path {
        return Err("Invalid target. Only URLs (http/https/mailto) and absolute paths are allowed.".into());
    }

    let target = if is_path { expand_tilde(&url) } else { url.clone() };

    log::info!("Opening via XDG Portal (D-Bus): {}", target);

    #[cfg(target_os = "linux")]
    {
        // For URLs, try launching the default browser directly with --new-window
        if is_url {
            if let Some(browser) = detect_default_browser() {
                log::info!("Trying direct browser launch: {} --new-window {}", browser, target);
                let mut cmd = std::process::Command::new(&browser);
                cmd.arg("--new-window").arg(&target);
                cmd.env_remove("LD_LIBRARY_PATH");
                cmd.env_remove("LD_PRELOAD");
                cmd.env_remove("APPDIR");
                cmd.env_remove("APPIMAGE");
                if let Ok(mut child) = cmd.spawn() {
                    std::thread::sleep(std::time::Duration::from_millis(100));
                    if let Ok(Some(status)) = child.try_wait() {
                        if status.success() { return Ok(()); }
                    } else {
                        return Ok(());
                    }
                }
            }
        }

        let dbus_uri = if is_path {
            format!("file://{}", target)
        } else {
            target.clone()
        };

        let mut command = std::process::Command::new("dbus-send");
        command.args([
            "--session",
            "--dest=org.freedesktop.portal.Desktop",
            "--type=method_call",
            "--print-reply",
            "/org/freedesktop/portal/desktop",
            "org.freedesktop.portal.OpenURI.OpenURI",
            "string:",
            &format!("string:{}", dbus_uri),
            "array:dict:string:variant:handle_token,string:penguincitizen"
        ]);

        command.env_clear();
        if let Ok(dbus_addr) = std::env::var("DBUS_SESSION_BUS_ADDRESS") {
            command.env("DBUS_SESSION_BUS_ADDRESS", dbus_addr);
        }
        if let Ok(display) = std::env::var("DISPLAY") {
            command.env("DISPLAY", display);
        }
        if let Ok(w_display) = std::env::var("WAYLAND_DISPLAY") {
            command.env("WAYLAND_DISPLAY", w_display);
        }

        if let Ok(mut child) = command.spawn() {
            std::thread::sleep(std::time::Duration::from_millis(100));
            if let Ok(Some(status)) = child.try_wait() {
                if status.success() { return Ok(()); }
            } else {
                return Ok(());
            }
        }

        let mut gio_cmd = std::process::Command::new("gio");
        gio_cmd.arg("open").arg(&target);
        gio_cmd.env_remove("LD_LIBRARY_PATH");
        gio_cmd.env_remove("LD_PRELOAD");
        gio_cmd.env_remove("APPDIR");
        gio_cmd.env_remove("APPIMAGE");
        if let Ok(mut child) = gio_cmd.spawn() {
            std::thread::sleep(std::time::Duration::from_millis(100));
            if let Ok(Some(status)) = child.try_wait() {
                if status.success() { return Ok(()); }
            } else {
                return Ok(());
            }
        }

        let mut xdg_cmd = std::process::Command::new("xdg-open");
        xdg_cmd.arg(&target);
        xdg_cmd.env_remove("LD_LIBRARY_PATH");
        xdg_cmd.env_remove("LD_PRELOAD");
        xdg_cmd.env_remove("APPDIR");
        xdg_cmd.env_remove("APPIMAGE");
        xdg_cmd.env_remove("XDG_DATA_DIRS");

        match xdg_cmd.spawn() {
            Ok(_) => Ok(()),
            Err(e) => Err(format!("Failed to open browser: {}", e))
        }
    }

    #[cfg(not(target_os = "linux"))]
    {
        Err("Robust open_browser is only implemented for Linux.".into())
    }
}

pub(crate) fn expand_tilde(p: &str) -> String {
    if p.starts_with('~') {
        if let Some(h) = dirs::home_dir() {
            return p.replacen('~', &h.to_string_lossy(), 1);
        }
    }
    p.to_string()
}

pub(crate) fn safe_unpack<R: io::Read>(archive: &mut tar::Archive<R>, dst: &Path) -> io::Result<()> {
    let canonical_dst = dst.canonicalize()?;
    for entry in archive.entries()? {
        let mut entry = entry?;
        let path = entry.path()?;
        let target = canonical_dst.join(&path);
        let parent = target.parent().ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "No parent"))?;
        std::fs::create_dir_all(parent)?;
        let canonical_target = parent.canonicalize()?.join(target.file_name().ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "No name"))?);
        if !canonical_target.starts_with(&canonical_dst) { return Err(io::Error::new(io::ErrorKind::InvalidInput, "Traversal")); }
        entry.unpack(&canonical_target)?;
    }
    Ok(())
}

pub(crate) fn validate_env_var_key(key: &str) -> Result<(), String> {
    if key.is_empty() { return Err("Empty".to_string()); }
    if !key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') { return Err("Invalid".to_string()); }
    const BLOCKED: &[&str] = &["PATH", "LD_PRELOAD", "LD_LIBRARY_PATH", "HOME", "USER", "SHELL"];
    if BLOCKED.contains(&key) { return Err("Blocked".to_string()); }
    Ok(())
}
