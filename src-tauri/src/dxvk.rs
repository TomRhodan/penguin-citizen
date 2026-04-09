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

//! Module for installing and managing DXVK.
//!
//! This module is responsible for:
//! - Fetching available DXVK releases from GitHub
//! - Detecting installed DXVK versions in Wine prefixes
//! - Installing DXVK (downloading, extracting, copying DLLs)
//!
//! DXVK is a Vulkan-based implementation of Direct3D 9, 10, and 11
//! for Wine-based runners and provides better graphics performance than
//! the default Wine implementation.

use serde::{ Deserialize, Serialize };
use std::path::Path;
use tauri::{ AppHandle, Emitter };

use crate::config::AppConfig;

/// Loads the GitHub token from the configuration file to increase the API rate limit.
fn load_github_token() -> Option<String> {
    let config_path = dirs::config_dir()?.join("penguin-citizen").join("config.json");
    let contents = std::fs::read_to_string(config_path).ok()?;
    let config: AppConfig = serde_json::from_str(&contents).ok()?;
    config.github_token
}

// --- Data structures ---

/// Information about an available DXVK release from GitHub.
#[derive(Serialize, Deserialize, Clone)]
pub struct DxvkRelease {
    /// Version identifier (e.g. "v2.3")
    pub version: String,
    /// Direct download URL for the archive
    pub download_url: String,
    /// Original file name of the archive
    pub file_name: String,
    /// File size in bytes
    pub size_bytes: u64,
}

/// Status of DXVK in a Wine prefix.
///
/// Used to show the user whether and which version
/// of DXVK is installed in the current prefix.
#[derive(Serialize, Deserialize, Clone)]
pub struct DxvkStatus {
    /// Whether DXVK is installed
    pub installed: bool,
    /// Installed version (if detected)
    pub version: Option<String>,
    /// List of found DXVK DLLs in the system32 directory
    pub dlls_found: Vec<String>,
}

/// Progress information for the DXVK installation.
///
/// Sent to the frontend via Tauri events.
#[derive(Serialize, Deserialize, Clone)]
pub struct DxvkProgress {
    /// Current phase: "downloading", "extracting", "installing", "complete"
    pub phase: String,
    /// Progress in percent (0-100)
    pub percent: f64,
    /// Status message for display
    pub message: String,
}

// --- GitHub API types ---

/// Structure for a GitHub release response.
#[derive(Deserialize)]
struct GhRelease {
    tag_name: String,
    assets: Vec<GhAsset>,
}

/// A download asset within a GitHub release.
#[derive(Deserialize)]
struct GhAsset {
    name: String,
    browser_download_url: String,
    size: u64,
}

use crate::util::{expand_tilde, http_client};

// --- Tauri commands ---

/// Fetches the last 10 DXVK releases from the official GitHub repository.
///
/// Filters the assets for .tar.gz archives and takes only one asset per release,
/// since each DXVK release typically contains only one relevant archive.
#[tauri::command]
pub async fn fetch_dxvk_releases() -> Result<Vec<DxvkRelease>, String> {
    let token = load_github_token();

    let client = http_client();

    let url = "https://api.github.com/repos/doitsujin/dxvk/releases?per_page=10";
    let mut request = client.get(url);
    if let Some(ref t) = token {
        request = request.header("Authorization", format!("Bearer {}", t));
    }
    let resp = request.send().await.map_err(|e| format!("Failed to fetch DXVK releases: {}", e))?;

    let status = resp.status();
    if !status.is_success() {
        if status.as_u16() == 403 || status.as_u16() == 429 {
            return Err("GitHub API rate limit reached. Add a GitHub token in Settings to increase the limit.".into());
        }
        return Err(format!("GitHub API returned {}", status));
    }

    let releases: Vec<GhRelease> = resp
        .json().await
        .map_err(|e| format!("Failed to parse DXVK releases: {}", e))?;

    let mut result = Vec::new();
    for release in &releases {
        for asset in &release.assets {
            // Only consider .tar.gz archives
            if asset.name.ends_with(".tar.gz") {
                result.push(DxvkRelease {
                    version: release.tag_name.clone(),
                    download_url: asset.browser_download_url.clone(),
                    file_name: asset.name.clone(),
                    size_bytes: asset.size,
                });
                break; // Only use one asset per release
            }
        }
    }

    Ok(result)
}

/// Detects the installed DXVK version in a Wine prefix.
///
/// Detection is done in two steps:
/// 1. Check if the typical DXVK DLLs (d3d9, d3d10core, d3d11, dxgi) are
///    present in the system32 directory
/// 2. Read the marker file `.dxvk_version` in the prefix root for version info
///
/// If DLLs are present but no marker file exists (e.g. from a winetricks
/// installation), a corresponding marker file is created.
#[tauri::command]
pub async fn detect_dxvk_version(base_path: String) -> Result<DxvkStatus, String> {
    tokio::task
        ::spawn_blocking(move || {
            let expanded = expand_tilde(&base_path);
            let prefix = Path::new(&expanded);
            // system32 is the directory for 64-bit DLLs in the Wine prefix
            let sys32 = prefix.join("drive_c").join("windows").join("system32");

            // These DLLs are provided by DXVK and replace the Wine originals
            let check_dlls = ["d3d9.dll", "d3d10core.dll", "d3d11.dll", "dxgi.dll"];
            let mut dlls_found = Vec::new();

            for dll in &check_dlls {
                if sys32.join(dll).exists() {
                    dlls_found.push(dll.to_string());
                }
            }

            // Read the marker file that is created during installation
            let marker = prefix.join(".dxvk_version");
            let version = std::fs
                ::read_to_string(&marker)
                .ok()
                .map(|s| s.trim().to_string());

            // If DLLs are present but no marker file exists,
            // DXVK was likely installed via winetricks -- create marker retroactively
            let installed = if !dlls_found.is_empty() && version.is_none() {
                if !dlls_found.is_empty() {
                    let _ = std::fs::write(&marker, "dxvk (winetricks)");
                    Some("dxvk (winetricks)".to_string())
                } else {
                    None
                }
            } else {
                version
            };

            // DXVK is considered installed when both DLLs and version information are present
            let is_installed = !dlls_found.is_empty() && installed.is_some();

            DxvkStatus {
                installed: is_installed,
                version: installed,
                dlls_found,
            }
        }).await
        .map_err(|e| format!("Task failed: {}", e))
}

/// Installs DXVK in a Wine prefix.
///
/// Workflow:
/// 1. Download DXVK archive from GitHub (progress: 0-50%)
/// 2. Extract archive (50%)
/// 3. Copy x64 DLLs to system32 (for 64-bit applications)
/// 4. Copy x32 DLLs to syswow64 (for 32-bit applications in 64-bit prefix)
/// 5. Create version marker file `.dxvk_version` in the prefix (90%)
/// 6. Clean up temporary files (100%)
///
/// Progress is sent to the frontend via Tauri events ("dxvk-progress").
#[tauri::command]
pub async fn install_dxvk(
    app: AppHandle,
    download_url: String,
    version: String,
    base_path: String
) -> Result<(), String> {
    let expanded = expand_tilde(&base_path);
    let prefix = Path::new(&expanded);
    let tmp_dir = prefix.join(".tmp");

    // Closure for sending progress updates to the frontend
    let emit = |phase: &str, percent: f64, msg: &str| {
        let _ = app.emit("dxvk-progress", DxvkProgress {
            phase: phase.to_string(),
            percent,
            message: msg.to_string(),
        });
    };

    // Create temporary directory
    tokio::fs
        ::create_dir_all(&tmp_dir).await
        .map_err(|e| format!("Failed to create tmp dir: {}", e))?;

    emit("downloading", 0.0, "Downloading DXVK...");

    // --- Download phase ---
    let client = http_client();

    let response = client
        .get(&download_url)
        .send().await
        .map_err(|e| format!("Download failed: {}", e))?;

    let total_bytes = response.content_length().unwrap_or(0);
    let mut downloaded: u64 = 0;

    let archive_path = tmp_dir.join("dxvk.tar.gz");

    use futures_util::StreamExt;
    use tokio::io::AsyncWriteExt;

    let mut file = tokio::fs::File
        ::create(&archive_path).await
        .map_err(|e| format!("Failed to create file: {}", e))?;

    // Download data in chunks -- progress goes up to 50%
    let mut stream = response.bytes_stream();
    while let Some(chunk_result) = stream.next().await {
        match chunk_result {
            Ok(chunk) => {
                file.write_all(&chunk).await.map_err(|e| format!("Write error: {}", e))?;
                downloaded += chunk.len() as u64;
                // Download progress: 0-50% of total progress
                let percent = if total_bytes > 0 {
                    ((downloaded as f64) / (total_bytes as f64)) * 50.0
                } else {
                    25.0
                };
                emit("downloading", percent, "Downloading DXVK...");
            }
            Err(e) => {
                let _ = tokio::fs::remove_file(&archive_path).await;
                return Err(format!("Stream error: {}", e));
            }
        }
    }

    file.flush().await.map_err(|e| format!("Flush error: {}", e))?;
    drop(file);

    // --- Extraction phase ---
    emit("extracting", 50.0, "Extracting DXVK...");

    let extract_dir = tmp_dir.join("dxvk-extract");
    let extract_dir_clone = extract_dir.clone();
    let archive_path_clone = archive_path.clone();

    // Extraction in a blocking thread, since flate2/tar work synchronously
    let extract_result = tokio::task::spawn_blocking(move || {
        std::fs::create_dir_all(&extract_dir_clone)?;
        let file = std::fs::File::open(&archive_path_clone)?;
        let decoder = flate2::read::GzDecoder::new(file);
        let mut archive = tar::Archive::new(decoder);
        crate::util::safe_unpack(&mut archive, &extract_dir_clone)?;
        Ok::<(), std::io::Error>(())
    }).await;

    match extract_result {
        Ok(Ok(())) => {}
        Ok(Err(e)) => {
            let _ = tokio::fs::remove_dir_all(&tmp_dir).await;
            return Err(format!("Extraction failed: {}", e));
        }
        Err(e) => {
            let _ = tokio::fs::remove_dir_all(&tmp_dir).await;
            return Err(format!("Task error: {}", e));
        }
    }

    // --- Installation phase: copy DLLs into the Wine prefix ---
    emit("installing", 70.0, "Installing DXVK DLLs...");

    // Find the extracted directory (typically "dxvk-X.Y.Z/")
    let entries: Vec<_> = std::fs
        ::read_dir(&extract_dir)
        .map_err(|e| format!("Read error: {}", e))?
        .filter_map(|e| e.ok())
        .collect();

    // If a single directory was extracted, use it
    let dxvk_dir = if entries.len() == 1 && entries[0].path().is_dir() {
        entries[0].path()
    } else {
        extract_dir.clone()
    };

    // Copy x64 DLLs to system32 (for 64-bit Windows applications)
    let sys32 = prefix.join("drive_c").join("windows").join("system32");
    let x64_dir = dxvk_dir.join("x64");

    tokio::fs
        ::create_dir_all(&sys32).await
        .map_err(|e| format!("Failed to create system32: {}", e))?;

    if x64_dir.is_dir() {
        copy_dlls(&x64_dir, &sys32)?;
    }

    // Copy x32 DLLs to syswow64 (for 32-bit applications in 64-bit Wine prefix)
    let syswow64 = prefix.join("drive_c").join("windows").join("syswow64");
    let x32_dir = dxvk_dir.join("x32");

    tokio::fs
        ::create_dir_all(&syswow64).await
        .map_err(|e| format!("Failed to create syswow64: {}", e))?;

    if x32_dir.is_dir() {
        copy_dlls(&x32_dir, &syswow64)?;
    }

    emit("installing", 90.0, "Writing version marker...");

    // Create version marker file in the prefix root so the version
    // can be detected by later calls to detect_dxvk_version()
    let marker_path = prefix.join(".dxvk_version");
    std::fs::write(&marker_path, &version).map_err(|e| format!("Failed to write marker: {}", e))?;

    // Clean up temporary files
    let _ = tokio::fs::remove_dir_all(&tmp_dir).await;

    emit("complete", 100.0, "DXVK installed successfully!");

    Ok(())
}

/// Copies the DXVK DLLs from a source directory to a destination directory.
///
/// Only copies the four standard DXVK DLLs (d3d9, d3d10core, d3d11, dxgi),
/// which replace Wine's own DirectX implementations.
fn copy_dlls(src_dir: &Path, dest_dir: &Path) -> Result<(), String> {
    let dll_names = ["d3d9.dll", "d3d10core.dll", "d3d11.dll", "dxgi.dll"];

    for name in &dll_names {
        let src = src_dir.join(name);
        if src.exists() {
            let dest = dest_dir.join(name);
            std::fs::copy(&src, &dest).map_err(|e| format!("Failed to copy {}: {}", name, e))?;
        }
    }

    Ok(())
}
