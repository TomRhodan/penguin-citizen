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
use std::sync::OnceLock;
use tauri::Window;
use base64::{Engine as _, engine::general_purpose};

/// Global HTTP client with connection pooling, User-Agent, and timeouts.
///
/// Initialized once on first use. All modules should use `http_client()`
/// instead of creating their own `reqwest::Client` instances.
static HTTP_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

/// Returns the shared HTTP client with sensible defaults:
/// - User-Agent: `penguin-citizen/{version}`
/// - Connect timeout: 10 seconds
/// - Read timeout: 30 seconds (per read, resets on each received chunk)
/// - Connection pooling across all requests
///
/// We deliberately use `read_timeout` rather than the total `timeout`: the
/// latter caps the *entire* request including body streaming, which aborts
/// large downloads (e.g. the ~320 MB RSI Launcher) that cannot finish inside
/// the window even though bytes keep flowing (#8). `read_timeout` instead
/// detects a genuinely stalled connection (no bytes for 30 s) without limiting
/// the total transfer duration.
pub(crate) fn http_client() -> &'static reqwest::Client {
    HTTP_CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .user_agent(concat!("penguin-citizen/", env!("CARGO_PKG_VERSION")))
            .connect_timeout(std::time::Duration::from_secs(10))
            .read_timeout(std::time::Duration::from_secs(30))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new())
    })
}

/// Maximum number of retry attempts for a failed streaming download (on top of
/// the initial attempt), so a transient CDN reset or stall doesn't fail a large
/// install.
const MAX_DOWNLOAD_RETRIES: u32 = 4;

/// Outcome of a failed [`download_to_file`] call.
pub(crate) enum DownloadError {
    /// The caller's cancel check returned `true` mid-download.
    Cancelled,
    /// The download failed (after exhausting retries). Carries a message.
    Failed(String),
}

/// Streams `url` to `dest` with progress reporting, automatic retry, and
/// HTTP Range-based resume.
///
/// - `on_progress(downloaded, total)` is invoked after each written chunk
///   (and once at the start of each attempt). `total` is 0 if the server did
///   not report a content length. Callers own throttling/percent-mapping.
/// - `is_cancelled()` is checked before each chunk; when it returns `true` the
///   function stops and returns [`DownloadError::Cancelled`].
///
/// On a mid-stream failure (stall via the client's `read_timeout`, a CDN
/// connection reset, etc.) the download is retried up to
/// [`MAX_DOWNLOAD_RETRIES`] times with exponential backoff, resuming from the
/// current byte offset via a `Range: bytes=<offset>-` header. If the server
/// ignores the range (responds `200` instead of `206`), the download restarts
/// from the beginning. The caller is responsible for removing `dest` on error.
pub(crate) async fn download_to_file(
    url: &str,
    dest: &Path,
    mut on_progress: impl FnMut(u64, u64),
    is_cancelled: impl Fn() -> bool,
) -> Result<(), DownloadError> {
    use futures_util::StreamExt;
    use tokio::io::AsyncWriteExt;

    let client = http_client();
    let mut downloaded: u64 = 0;
    let mut total: u64 = 0;
    let mut last_err = String::new();

    for attempt in 0..=MAX_DOWNLOAD_RETRIES {
        if is_cancelled() {
            return Err(DownloadError::Cancelled);
        }

        // Back off before a retry (never before the first attempt), capped at 5s.
        if attempt > 0 {
            let backoff = std::time::Duration::from_millis(500u64 << (attempt - 1))
                .min(std::time::Duration::from_secs(5));
            tokio::time::sleep(backoff).await;
            log::warn!(
                "Download retry {}/{} for {} (resuming at {} bytes): {}",
                attempt, MAX_DOWNLOAD_RETRIES, url, downloaded, last_err
            );
        }

        // Resume via Range header when we already have bytes on disk.
        let mut req = client.get(url);
        if downloaded > 0 {
            req = req.header(reqwest::header::RANGE, format!("bytes={}-", downloaded));
        }

        let response = match req.send().await {
            Ok(r) => r,
            Err(e) => {
                last_err = e.to_string();
                continue;
            }
        };

        let status = response.status();
        // Did the server honor our Range request?
        let resuming = downloaded > 0 && status == reqwest::StatusCode::PARTIAL_CONTENT;
        if downloaded > 0 && !resuming {
            // Server ignored the range (200 OK) — start over from scratch.
            downloaded = 0;
        }

        if !status.is_success() {
            last_err = format!("unexpected HTTP status {}", status);
            continue;
        }

        // Full length is only meaningful on a fresh (200) response; on a 206
        // resume content_length is just the remaining bytes, so keep the prior total.
        if !resuming {
            total = response.content_length().unwrap_or(0);
        }

        // Truncate on a fresh download, append when resuming.
        let file_result = if resuming {
            tokio::fs::OpenOptions::new().append(true).open(dest).await
        } else {
            tokio::fs::File::create(dest).await
        };
        let mut file = match file_result {
            Ok(f) => f,
            Err(e) => {
                return Err(DownloadError::Failed(format!(
                    "Failed to open destination file: {}", e
                )));
            }
        };

        on_progress(downloaded, total);

        let mut stream = response.bytes_stream();
        let mut stream_failed = false;
        while let Some(chunk_result) = stream.next().await {
            if is_cancelled() {
                let _ = file.flush().await;
                return Err(DownloadError::Cancelled);
            }
            match chunk_result {
                Ok(chunk) => {
                    if let Err(e) = file.write_all(&chunk).await {
                        return Err(DownloadError::Failed(format!(
                            "Failed to write chunk: {}", e
                        )));
                    }
                    downloaded += chunk.len() as u64;
                    on_progress(downloaded, total);
                }
                Err(e) => {
                    last_err = e.to_string();
                    stream_failed = true;
                    break;
                }
            }
        }

        if !stream_failed {
            file.flush().await.map_err(|e| {
                DownloadError::Failed(format!("Failed to flush file: {}", e))
            })?;
            return Ok(());
        }
        // Stream broke mid-transfer: flush what we have and retry (resume).
        let _ = file.flush().await;
    }

    Err(DownloadError::Failed(format!(
        "download failed after {} retries: {}", MAX_DOWNLOAD_RETRIES, last_err
    )))
}

/// Removes AppImage-injected loader/path variables so a child process loads
/// host system libraries instead of the AppImage's bundled ones.
///
/// Required for any subprocess that itself dlopens system libraries (wget,
/// curl, terminals, browsers). Without this, the host's wget will pick up the
/// AppImage's older libssl/libcrypto via LD_LIBRARY_PATH and crash when other
/// host libs require newer OpenSSL symbols (e.g. Fedora 44 / Bazzite, #6).
///
/// No-op when not running from an AppImage (the variables simply aren't set).
pub(crate) fn clean_appimage_env(cmd: &mut std::process::Command) {
    cmd.env_remove("LD_LIBRARY_PATH");
    cmd.env_remove("LD_PRELOAD");
    cmd.env_remove("APPDIR");
    cmd.env_remove("APPIMAGE");
}

/// Pinned Winetricks version and its SHA-256 hash.
///
/// Using a fixed release tag instead of `master` ensures reproducible installs
/// and allows integrity verification of the downloaded script.
/// Update both constants together when upgrading to a new Winetricks release.
const WINETRICKS_TAG: &str = "20250102";
const WINETRICKS_SHA256: &str = "53194dead910f8a5eb1deacaa4773d4e48f5873633d18ab1ecd6fdb0cb92243b";

/// Downloads the pinned Winetricks script to `tmp_dir` and verifies its SHA-256 hash.
///
/// Returns the path to the downloaded, executable script.
/// This is shared between `installer::install` and `prefix_tools` to avoid
/// duplicating the download + chmod + verification logic.
pub(crate) async fn download_winetricks(tmp_dir: &std::path::Path) -> Result<std::path::PathBuf, String> {
    let url = format!(
        "https://raw.githubusercontent.com/Winetricks/winetricks/{}/src/winetricks",
        WINETRICKS_TAG
    );
    let winetricks_path = tmp_dir.join("winetricks");

    let wt_bytes = http_client()
        .get(&url)
        .send().await
        .map_err(|e| format!("Failed to download winetricks: {}", e))?
        .bytes().await
        .map_err(|e| format!("Failed to read winetricks response: {}", e))?;

    // Verify integrity via SHA-256
    use sha2::{Sha256, Digest};
    let hash = format!("{:x}", Sha256::digest(&wt_bytes));
    if hash != WINETRICKS_SHA256 {
        return Err(format!(
            "Winetricks integrity check failed!\nExpected: {}\nGot:      {}\n\
             The downloaded script does not match the pinned version {}. \
             This could indicate a tampered download or an update is needed.",
            WINETRICKS_SHA256, hash, WINETRICKS_TAG
        ));
    }

    std::fs::write(&winetricks_path, &wt_bytes)
        .map_err(|e| format!("Failed to write winetricks: {}", e))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&winetricks_path, std::fs::Permissions::from_mode(0o755))
            .map_err(|e| format!("Failed to chmod winetricks: {}", e))?;
    }

    log::info!("Winetricks {} downloaded and verified (SHA-256 OK)", WINETRICKS_TAG);

    Ok(winetricks_path)
}

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

/// XDG Desktop Entry field codes that get substituted at launch time.
/// We strip them so they don't end up as literal arguments to the browser.
/// See https://specifications.freedesktop.org/desktop-entry-spec/latest/exec-variables.html
#[cfg(target_os = "linux")]
fn is_field_code(token: &str) -> bool {
    matches!(token, "%u" | "%U" | "%f" | "%F" | "%i" | "%c" | "%k")
}

/// Detects the default browser launch command on Linux.
///
/// Returns the full tokenized `Exec=` line from the default browser's `.desktop`
/// file (field codes stripped), not just the first binary. This is required for
/// Flatpak browsers, whose Exec line looks like
/// `/usr/bin/flatpak run --branch=stable --arch=x86_64 org.mozilla.firefox %u`
/// — taking only the first token would yield `flatpak`, which then can't be
/// invoked with browser-specific flags like `--new-window` (#7).
#[cfg(target_os = "linux")]
fn detect_default_browser() -> Option<Vec<String>> {
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

    let which_succeeds = |name: &str| -> bool {
        std::process::Command::new("which")
            .arg(name)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    };

    for dir in &search_dirs {
        let path = dir.join(&desktop_name);
        let Ok(content) = std::fs::read_to_string(&path) else { continue; };
        for line in content.lines() {
            let Some(exec) = line.strip_prefix("Exec=") else { continue; };
            // Naive whitespace tokenization. XDG spec allows quoting, but real-world
            // browser .desktop files don't use it; we'd add `shell_words` if needed.
            let tokens: Vec<String> = exec
                .split_whitespace()
                .filter(|t| !is_field_code(t))
                .map(|s| s.to_string())
                .collect();
            let first = tokens.first()?;
            let bin_name = std::path::Path::new(first).file_name()?.to_str()?;
            if which_succeeds(bin_name) {
                return Some(tokens);
            }
        }
    }

    // Fallback: try the desktop file name without .desktop suffix as a bare binary
    let name = desktop_name.strip_suffix(".desktop")?;
    if which_succeeds(name) {
        Some(vec![name.to_string()])
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

    #[cfg(target_os = "linux")]
    {
        // For URLs, try launching the default browser directly with --new-window.
        // The parsed argv carries `flatpak run <app-id>` for Flatpak browsers, so
        // appending --new-window + URL works for both native and Flatpak (#7).
        if is_url {
            if let Some(mut argv) = detect_default_browser() {
                argv.push("--new-window".to_string());
                argv.push(target.clone());
                log::info!("Trying direct browser launch: {}", argv.join(" "));
                let mut cmd = std::process::Command::new(&argv[0]);
                cmd.args(&argv[1..]);
                clean_appimage_env(&mut cmd);
                if let Ok(mut child) = cmd.spawn() {
                    // Browser processes stay alive in the background. A short
                    // probe distinguishes "started OK and detached" (try_wait =
                    // None) from "spawn succeeded but the binary rejected its
                    // args and died instantly" (try_wait = Some(non-zero)).
                    std::thread::sleep(std::time::Duration::from_millis(150));
                    match child.try_wait() {
                        Ok(None) => return Ok(()),
                        Ok(Some(s)) if s.success() => return Ok(()),
                        _ => log::warn!("Direct browser launch failed, trying portal"),
                    }
                }
            }
        }

        let dbus_uri = if is_path {
            format!("file://{}", target)
        } else {
            target.clone()
        };

        log::info!("Trying XDG Portal (D-Bus): {}", target);
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

        // dbus-send --print-reply blocks until the portal answers. Wait for the
        // real exit status instead of guessing after 100ms (#7).
        if let Ok(out) = command.output() {
            if out.status.success() { return Ok(()); }
            log::warn!("Portal call failed (exit {:?}), trying gio", out.status.code());
        }

        log::info!("Trying gio open: {}", target);
        let mut gio_cmd = std::process::Command::new("gio");
        gio_cmd.arg("open").arg(&target);
        clean_appimage_env(&mut gio_cmd);
        if let Ok(out) = gio_cmd.output() {
            if out.status.success() { return Ok(()); }
            log::warn!("gio open failed (exit {:?}), trying xdg-open", out.status.code());
        }

        log::info!("Trying xdg-open: {}", target);
        let mut xdg_cmd = std::process::Command::new("xdg-open");
        xdg_cmd.arg(&target);
        clean_appimage_env(&mut xdg_cmd);
        xdg_cmd.env_remove("XDG_DATA_DIRS");
        match xdg_cmd.output() {
            Ok(o) if o.status.success() => Ok(()),
            Ok(o) => Err(format!("xdg-open failed with exit {:?}", o.status.code())),
            Err(e) => Err(format!("Failed to open browser: {}", e)),
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

/// Maximum total extracted size: 50 GB. Protects against archive bombs
/// (e.g., a 1 KB archive that expands to 1 TB).
const MAX_EXTRACT_SIZE: u64 = 50 * 1024 * 1024 * 1024;

pub(crate) fn safe_unpack<R: io::Read>(archive: &mut tar::Archive<R>, dst: &Path) -> io::Result<()> {
    let canonical_dst = dst.canonicalize()?;
    let mut total_size: u64 = 0;
    for entry in archive.entries()? {
        let mut entry = entry?;
        // Archive bomb protection: abort if total extracted size exceeds limit
        total_size = total_size.saturating_add(entry.size());
        if total_size > MAX_EXTRACT_SIZE {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!("Archive exceeds maximum extraction size ({} GB)", MAX_EXTRACT_SIZE / (1024 * 1024 * 1024)),
            ));
        }
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
    // Variables that could break Wine/Proton operation or compromise security.
    // The app manages these internally and users should not override them.
    const BLOCKED: &[&str] = &[
        // System security
        "PATH", "LD_PRELOAD", "LD_LIBRARY_PATH", "HOME", "USER", "SHELL",
        // Wine/Proton internals (managed by the app)
        "WINEPREFIX", "WINEARCH", "WINE", "WINESERVER", "WINELOADER", "WINEDLLPATH",
        // XDG paths (could redirect config/data storage)
        "XDG_CONFIG_HOME", "XDG_DATA_HOME",
    ];
    if BLOCKED.contains(&key) { return Err("Blocked".to_string()); }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── expand_tilde ──

    #[test]
    fn expand_tilde_replaces_home() {
        let result = expand_tilde("~/Games/star-citizen");
        assert!(!result.starts_with('~'), "tilde should be expanded");
        assert!(result.ends_with("/Games/star-citizen"));
    }

    #[test]
    fn expand_tilde_no_tilde_unchanged() {
        assert_eq!(expand_tilde("/tmp/foo"), "/tmp/foo");
    }

    #[test]
    fn expand_tilde_empty_string() {
        assert_eq!(expand_tilde(""), "");
    }

    #[test]
    fn expand_tilde_only_tilde() {
        let result = expand_tilde("~");
        assert!(!result.is_empty());
        assert!(!result.starts_with('~'));
    }

    // ── validate_env_var_key ──

    #[test]
    fn env_var_valid_keys() {
        assert!(validate_env_var_key("WINEDEBUG").is_ok());
        assert!(validate_env_var_key("MY_VAR_123").is_ok());
        assert!(validate_env_var_key("X").is_ok());
    }

    #[test]
    fn env_var_empty_rejected() {
        assert_eq!(validate_env_var_key("").unwrap_err(), "Empty");
    }

    #[test]
    fn env_var_invalid_chars_rejected() {
        assert_eq!(validate_env_var_key("MY-VAR").unwrap_err(), "Invalid");
        assert_eq!(validate_env_var_key("MY VAR").unwrap_err(), "Invalid");
        assert_eq!(validate_env_var_key("MY.VAR").unwrap_err(), "Invalid");
        assert_eq!(validate_env_var_key("$VAR").unwrap_err(), "Invalid");
    }

    #[test]
    fn env_var_blocked_system_vars() {
        for key in &["PATH", "LD_PRELOAD", "LD_LIBRARY_PATH", "HOME", "USER", "SHELL"] {
            assert_eq!(validate_env_var_key(key).unwrap_err(), "Blocked",
                       "{} should be blocked", key);
        }
    }

    #[test]
    fn env_var_blocked_wine_vars() {
        for key in &["WINEPREFIX", "WINEARCH", "WINE", "WINESERVER", "WINELOADER", "WINEDLLPATH"] {
            assert_eq!(validate_env_var_key(key).unwrap_err(), "Blocked",
                       "{} should be blocked", key);
        }
    }

    #[test]
    fn env_var_blocked_xdg_vars() {
        for key in &["XDG_CONFIG_HOME", "XDG_DATA_HOME"] {
            assert_eq!(validate_env_var_key(key).unwrap_err(), "Blocked",
                       "{} should be blocked", key);
        }
    }

    // ── safe_unpack ──

    #[test]
    fn safe_unpack_normal_archive() {
        let tmp = tempfile::tempdir().unwrap();
        let dst = tmp.path();

        // Create a simple tar archive in memory
        let mut builder = tar::Builder::new(Vec::new());
        let content = b"hello world";
        let mut header = tar::Header::new_gnu();
        header.set_size(content.len() as u64);
        header.set_mode(0o644);
        header.set_cksum();
        builder.append_data(&mut header, "test.txt", &content[..]).unwrap();
        let data = builder.into_inner().unwrap();

        let mut archive = tar::Archive::new(&data[..]);
        safe_unpack(&mut archive, dst).unwrap();

        let extracted = std::fs::read_to_string(dst.join("test.txt")).unwrap();
        assert_eq!(extracted, "hello world");
    }

    #[test]
    fn safe_unpack_subdirectory_structure() {
        let tmp = tempfile::tempdir().unwrap();
        let dst = tmp.path();

        // Create archive with a subdirectory entry
        let mut builder = tar::Builder::new(Vec::new());
        let content = b"nested file";
        let mut header = tar::Header::new_gnu();
        header.set_size(content.len() as u64);
        header.set_mode(0o644);
        header.set_cksum();
        builder.append_data(&mut header, "subdir/nested.txt", &content[..]).unwrap();
        let data = builder.into_inner().unwrap();

        let mut archive = tar::Archive::new(&data[..]);
        safe_unpack(&mut archive, dst).unwrap();

        let extracted = std::fs::read_to_string(dst.join("subdir/nested.txt")).unwrap();
        assert_eq!(extracted, "nested file");
    }

    // ── validate_screenshot_filename ──

    #[test]
    fn screenshot_filename_valid() {
        assert!(validate_screenshot_filename("screenshot.png").is_ok());
        assert!(validate_screenshot_filename("my-shot_01.jpg").is_ok());
    }

    #[test]
    fn screenshot_filename_rejects_traversal() {
        assert!(validate_screenshot_filename("../etc/passwd").is_err());
        assert!(validate_screenshot_filename("foo/bar.png").is_err());
        assert!(validate_screenshot_filename("foo\\bar.png").is_err());
        assert!(validate_screenshot_filename("").is_err());
    }

    // ── http_client ──

    #[test]
    fn http_client_returns_same_instance() {
        let a = http_client() as *const reqwest::Client;
        let b = http_client() as *const reqwest::Client;
        assert_eq!(a, b, "http_client should return the same instance");
    }

    // ── download_to_file ──

    /// A mid-stream connection drop must be recovered via a Range-based resume,
    /// yielding the complete file — this is the core of the #8 fix.
    #[tokio::test]
    async fn download_to_file_resumes_after_midstream_drop() {
        use std::io::{Read, Write};
        use std::net::TcpListener;

        // Full body the client should end up with on disk.
        let body: &[u8] = b"0123456789ABCDEF";
        let split = 6; // bytes served before the simulated drop

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();

        // Mock server: attempt 1 sends headers + a partial body then closes the
        // socket (simulating a CDN reset). Attempt 2 must carry `Range: bytes=6-`
        // and is answered with a 206 serving the remaining bytes.
        let server = std::thread::spawn(move || {
            // attempt 1: partial, then drop
            let (mut sock, _) = listener.accept().unwrap();
            let mut buf = [0u8; 1024];
            let _ = sock.read(&mut buf).unwrap();
            sock.write_all(
                format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nAccept-Ranges: bytes\r\n\r\n",
                    body.len()
                )
                .as_bytes(),
            )
            .unwrap();
            sock.write_all(&body[..split]).unwrap();
            sock.flush().unwrap();
            drop(sock); // close mid-stream

            // attempt 2: honor the Range request with a 206
            let (mut sock, _) = listener.accept().unwrap();
            let mut buf = [0u8; 1024];
            let n = sock.read(&mut buf).unwrap();
            let req = String::from_utf8_lossy(&buf[..n]);
            assert!(
                req.contains(&format!("range: bytes={}-", split))
                    || req.contains(&format!("Range: bytes={}-", split)),
                "expected resume Range header, got:\n{}",
                req
            );
            sock.write_all(
                format!(
                    "HTTP/1.1 206 Partial Content\r\nContent-Length: {}\r\nContent-Range: bytes {}-{}/{}\r\n\r\n",
                    body.len() - split,
                    split,
                    body.len() - 1,
                    body.len()
                )
                .as_bytes(),
            )
            .unwrap();
            sock.write_all(&body[split..]).unwrap();
            sock.flush().unwrap();
        });

        let tmp = tempfile::tempdir().unwrap();
        let dest = tmp.path().join("out.bin");
        let url = format!("http://{}/file", addr);

        let result = download_to_file(&url, &dest, |_d, _t| {}, || false).await;

        assert!(matches!(result, Ok(())), "download should succeed after resume");
        let got = std::fs::read(&dest).unwrap();
        assert_eq!(got, body, "resumed file must equal the full body");

        server.join().unwrap();
    }

    /// Cancellation before the first chunk must short-circuit with `Cancelled`.
    #[tokio::test]
    async fn download_to_file_honors_cancellation() {
        let tmp = tempfile::tempdir().unwrap();
        let dest = tmp.path().join("out.bin");
        // URL never contacted because the cancel check trips immediately.
        let result =
            download_to_file("http://127.0.0.1:1/never", &dest, |_d, _t| {}, || true).await;
        assert!(matches!(result, Err(DownloadError::Cancelled)));
    }
}
