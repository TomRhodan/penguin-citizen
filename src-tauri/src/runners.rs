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

//! Module for managing Wine/Proton runners.
//!
//! This module is responsible for:
//! - Fetching available Wine/Proton runners from configured GitHub sources
//! - Installing runners (downloading, extracting archives)
//! - Deleting installed runners
//! - Cancelling active downloads
//!
//! Supported archive formats: .tar.gz, .tar.xz, .tar.zst, .tar.zstd

use serde::{ Deserialize, Serialize };
use std::path::Path;
use std::sync::atomic::{ AtomicBool, Ordering };
use tauri::{ AppHandle, Emitter };

use crate::config::{ AppConfig, RunnerSourceConfig };

/// Loads the GitHub token from the configuration file.
///
/// The token is used to increase the GitHub API rate limit.
/// Without a token, only 60 requests per hour are allowed.
fn load_github_token() -> Option<String> {
    let config_path = dirs::config_dir()?.join("penguin-citizen").join("config.json");
    let contents = std::fs::read_to_string(config_path).ok()?;
    let config: AppConfig = serde_json::from_str(&contents).ok()?;
    config.github_token
}

/// Global flag for cancelling an active runner download.
/// Set atomically so the download thread can safely read it.
static CANCEL_FLAG: AtomicBool = AtomicBool::new(false);

// --- Runner sources ---

/// Loads the configured runner sources (GitHub repositories) from the configuration file.
///
/// If the configuration cannot be read or contains no sources,
/// the default sources from `AppConfig::default()` are returned.
fn load_runner_sources() -> Vec<RunnerSourceConfig> {
    let config_path = match dirs::config_dir() {
        Some(p) => p.join("penguin-citizen").join("config.json"),
        None => {
            return AppConfig::default().runner_sources;
        }
    };

    let contents = match std::fs::read_to_string(&config_path) {
        Ok(c) => c,
        Err(_) => {
            return AppConfig::default().runner_sources;
        }
    };

    let config: AppConfig = match serde_json::from_str(&contents) {
        Ok(c) => c,
        Err(_) => {
            return AppConfig::default().runner_sources;
        }
    };

    // If no runner sources are present in the configuration, use defaults
    if config.runner_sources.is_empty() {
        AppConfig::default().runner_sources
    } else {
        config.runner_sources
    }
}

/// Returns the appropriate filter function based on the source setting.
///
/// Different runner sources provide different builds.
/// Some sources (e.g. Kron4ek) also offer 32-bit builds,
/// which are not needed for Star Citizen and are filtered out.
fn get_filter_fn(filter: &Option<String>) -> fn(&str) -> bool {
    match filter.as_deref() {
        Some("kron4ek") => filter_kron4ek,
        _ => accept_all,
    }
}

/// Accepts all runner names without filtering.
fn accept_all(_name: &str) -> bool {
    true
}

/// Filters out 32-bit runners (x86, wow64) for Kron4ek builds.
/// Star Citizen requires 64-bit runners exclusively.
fn filter_kron4ek(name: &str) -> bool {
    let lower = name.to_lowercase();
    !lower.contains("x86") && !lower.contains("wow64")
}

// --- Data structures ---

/// Information about an available runner from a GitHub source.
///
/// Contains all metadata needed by the frontend for display and installation.
#[derive(Serialize, Deserialize, Clone)]
pub struct AvailableRunner {
    /// Display name of the runner (archive name without file extension)
    pub name: String,
    /// Name of the source (e.g. "GloriousEggroll", "Kron4ek")
    pub source: String,
    /// Version tag of the GitHub release
    pub version: String,
    /// Direct download URL for the archive
    pub download_url: String,
    /// Original file name of the archive
    pub file_name: String,
    /// File size in bytes
    pub size_bytes: u64,
    /// Whether the runner is already installed locally
    pub installed: bool,
}

/// Result of fetching available runners from all sources.
///
/// Contains both the found runners and any error messages from
/// individual sources, so the frontend can display both.
#[derive(Serialize, Deserialize)]
pub struct FetchRunnersResult {
    pub runners: Vec<AvailableRunner>,
    pub errors: Vec<String>,
}

/// Progress information during runner download.
///
/// Sent to the frontend via Tauri events to enable a progress display.
#[derive(Serialize, Deserialize, Clone)]
pub struct DownloadProgress {
    /// Current phase: "downloading", "extracting", "complete" or "error"
    pub phase: String,
    /// Name of the runner being downloaded
    pub runner_name: String,
    /// Bytes downloaded so far
    pub bytes_downloaded: u64,
    /// Total size in bytes (0 if unknown)
    pub total_bytes: u64,
    /// Progress in percent (0-100)
    pub percent: f64,
    /// Status message for display
    pub message: String,
}

/// Result of a runner installation.
#[derive(Serialize, Deserialize)]
pub struct InstallRunnerResult {
    /// Whether the installation was successful
    pub success: bool,
    /// Name of the installed runner
    pub runner_name: String,
    /// Path to the installation directory
    pub install_path: String,
    /// Status message (success or error description)
    pub message: String,
}

// --- GitHub API types ---

/// Structure for a GitHub release response.
/// Contains the version tag and the associated download assets.
#[derive(Deserialize)]
struct GhRelease {
    tag_name: String,
    assets: Vec<GhAsset>,
}

/// A download asset within a GitHub release.
/// Represents a single downloadable file.
#[derive(Deserialize)]
struct GhAsset {
    name: String,
    browser_download_url: String,
    size: u64,
}

// --- Helper functions for archive file names ---

/// Removes known archive extensions from a file name.
///
/// Used to determine the display name of the runner.
/// Example: "wine-ge-8-25.tar.gz" -> "wine-ge-8-25"
fn strip_archive_ext(name: &str) -> String {
    let mut s = name.to_string();
    for ext in &[".tar.gz", ".tar.xz", ".tar.zst", ".tar.zstd"] {
        if s.ends_with(ext) {
            s = s[..s.len() - ext.len()].to_string();
            return s;
        }
    }
    s
}

/// Checks whether a file name has a supported archive format.
fn is_archive(name: &str) -> bool {
    name.ends_with(".tar.gz") ||
        name.ends_with(".tar.xz") ||
        name.ends_with(".tar.zst") ||
        name.ends_with(".tar.zstd")
}

use crate::util::expand_tilde;

// --- Tauri commands ---

/// Fetches all available runners from the configured GitHub sources.
///
/// For each enabled source, the last 25 releases are queried via the GitHub API.
/// Archive assets are filtered and enriched with installation status.
/// Errors from individual sources are collected instead of aborting the entire operation.
#[tauri::command]
pub async fn fetch_available_runners(base_path: String) -> FetchRunnersResult {
    let expanded = expand_tilde(&base_path);
    let runners_dir = Path::new(&expanded).join("runners");

    let token = load_github_token();
    let sources = load_runner_sources();

    // Create HTTP client with User-Agent (GitHub requires a User-Agent)
    let client = reqwest::Client
        ::builder()
        .user_agent("penguin-citizen/0.4.4")
        .connect_timeout(std::time::Duration::from_secs(10))
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());

    let mut all_runners = Vec::new();
    let mut errors = Vec::new();

    // Query each configured source individually
    for source in sources {
        // Skip disabled sources
        if !source.enabled {
            continue;
        }

        let filter_fn = get_filter_fn(&source.filter);
        let url = format!("{}?per_page=25", source.api_url);
        let mut request = client.get(&url);
        // Attach GitHub token for authenticated requests (higher rate limit)
        if let Some(ref t) = token {
            request = request.header("Authorization", format!("Bearer {}", t));
        }
        match request.send().await {
            Ok(resp) => {
                if !resp.status().is_success() {
                    errors.push(format!("{}: GitHub API returned {}", source.name, resp.status()));
                    continue;
                }
                match resp.json::<Vec<GhRelease>>().await {
                    Ok(releases) => {
                        // Iterate through all releases and their assets
                        for release in &releases {
                            for asset in &release.assets {
                                // Only consider archive files
                                if !is_archive(&asset.name) {
                                    continue;
                                }
                                // Apply source-specific filters (e.g. exclude 32-bit)
                                if !filter_fn(&asset.name) {
                                    continue;
                                }

                                let display_name = strip_archive_ext(&asset.name);
                                // Check if the directory already exists = installed
                                let installed = runners_dir.join(&display_name).is_dir();

                                all_runners.push(AvailableRunner {
                                    name: display_name,
                                    source: source.name.clone(),
                                    version: release.tag_name.clone(),
                                    download_url: asset.browser_download_url.clone(),
                                    file_name: asset.name.clone(),
                                    size_bytes: asset.size,
                                    installed,
                                });
                            }
                        }
                    }
                    Err(e) => {
                        errors.push(format!("{}: Failed to parse response: {}", source.name, e));
                    }
                }
            }
            Err(e) => {
                errors.push(format!("{}: {}", source.name, e));
            }
        }
    }

    FetchRunnersResult {
        runners: all_runners,
        errors,
    }
}

/// Installs a runner: downloads the archive, extracts it, and moves it
/// into the runner directory.
///
/// Progress is sent to the frontend via Tauri events ("runner-download-progress").
/// The download can be cancelled at any time via `cancel_runner_install()`.
///
/// Workflow:
/// 1. Check if already installed
/// 2. Create temporary directory
/// 3. Download archive (with progress reporting)
/// 4. Extract archive (supports gz, xz, zst/zstd)
/// 5. Normalize directory structure (single subdirectory -> use directly)
/// 6. Move to final directory and clean up temporary files
#[tauri::command]
pub async fn install_runner(
    app: AppHandle,
    download_url: String,
    file_name: String,
    base_path: String
) -> InstallRunnerResult {
    let expanded = expand_tilde(&base_path);
    let runner_name = strip_archive_ext(&file_name);
    let runners_dir = Path::new(&expanded).join("runners");
    let final_path = runners_dir.join(&runner_name);

    // If already installed, return success immediately
    if final_path.is_dir() {
        return InstallRunnerResult {
            success: true,
            runner_name: runner_name.clone(),
            install_path: final_path.to_string_lossy().into_owned(),
            message: "Runner already installed".into(),
        };
    }

    // Reset cancel flag for the new download
    CANCEL_FLAG.store(false, Ordering::SeqCst);

    // Create runner directory if it does not exist
    if let Err(e) = tokio::fs::create_dir_all(&runners_dir).await {
        return InstallRunnerResult {
            success: false,
            runner_name: runner_name.clone(),
            install_path: String::new(),
            message: format!("Failed to create runners directory: {}", e),
        };
    }

    // Create temporary directory for download and extraction
    // Created with ".tmp-" prefix to distinguish it from normal runner directories
    let tmp_dir = runners_dir.join(format!(".tmp-{}", runner_name));
    let _ = tokio::fs::remove_dir_all(&tmp_dir).await;
    if let Err(e) = tokio::fs::create_dir_all(&tmp_dir).await {
        return InstallRunnerResult {
            success: false,
            runner_name: runner_name.clone(),
            install_path: String::new(),
            message: format!("Failed to create temp directory: {}", e),
        };
    }

    let archive_path = tmp_dir.join(&file_name);

    // --- Download phase ---

    // Closure for sending progress updates to the frontend
    let emit_progress = |phase: &str, downloaded: u64, total: u64, msg: &str| {
        let percent = if total > 0 { ((downloaded as f64) / (total as f64)) * 100.0 } else { 0.0 };
        let _ = app.emit("runner-download-progress", DownloadProgress {
            phase: phase.to_string(),
            runner_name: runner_name.clone(),
            bytes_downloaded: downloaded,
            total_bytes: total,
            percent,
            message: msg.to_string(),
        });
    };

    let client = reqwest::Client
        ::builder()
        .user_agent("penguin-citizen/0.4.4")
        .connect_timeout(std::time::Duration::from_secs(10))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());

    // Start HTTP request
    let response = match client.get(&download_url).send().await {
        Ok(r) => r,
        Err(e) => {
            let _ = tokio::fs::remove_dir_all(&tmp_dir).await;
            emit_progress("error", 0, 0, &format!("Download failed: {}", e));
            return InstallRunnerResult {
                success: false,
                runner_name: runner_name.clone(),
                install_path: String::new(),
                message: format!("Download failed: {}", e),
            };
        }
    };

    let total_bytes = response.content_length().unwrap_or(0);
    let mut downloaded: u64 = 0;

    emit_progress("downloading", 0, total_bytes, "Starting download...");

    use futures_util::StreamExt;
    use tokio::io::AsyncWriteExt;

    // Create destination file for the download
    let mut file = match tokio::fs::File::create(&archive_path).await {
        Ok(f) => f,
        Err(e) => {
            let _ = tokio::fs::remove_dir_all(&tmp_dir).await;
            emit_progress("error", 0, 0, &format!("Failed to create file: {}", e));
            return InstallRunnerResult {
                success: false,
                runner_name: runner_name.clone(),
                install_path: String::new(),
                message: format!("Failed to create file: {}", e),
            };
        }
    };

    // Download data in chunks and write to file
    let mut stream = response.bytes_stream();
    while let Some(chunk_result) = stream.next().await {
        // Check on each chunk whether the user has cancelled the download
        if CANCEL_FLAG.load(Ordering::SeqCst) {
            let _ = file.flush().await;
            drop(file);
            let _ = tokio::fs::remove_dir_all(&tmp_dir).await;
            emit_progress("error", downloaded, total_bytes, "Download cancelled");
            return InstallRunnerResult {
                success: false,
                runner_name: runner_name.clone(),
                install_path: String::new(),
                message: "Download cancelled by user".into(),
            };
        }

        match chunk_result {
            Ok(chunk) => {
                if let Err(e) = file.write_all(&chunk).await {
                    let _ = tokio::fs::remove_dir_all(&tmp_dir).await;
                    emit_progress("error", downloaded, total_bytes, &format!("Write error: {}", e));
                    return InstallRunnerResult {
                        success: false,
                        runner_name: runner_name.clone(),
                        install_path: String::new(),
                        message: format!("Write error: {}", e),
                    };
                }
                downloaded += chunk.len() as u64;
                emit_progress("downloading", downloaded, total_bytes, "Downloading...");
            }
            Err(e) => {
                let _ = tokio::fs::remove_dir_all(&tmp_dir).await;
                emit_progress("error", downloaded, total_bytes, &format!("Stream error: {}", e));
                return InstallRunnerResult {
                    success: false,
                    runner_name: runner_name.clone(),
                    install_path: String::new(),
                    message: format!("Stream error: {}", e),
                };
            }
        }
    }

    // Ensure all data has been written to disk
    if let Err(e) = file.flush().await {
        let _ = tokio::fs::remove_dir_all(&tmp_dir).await;
        emit_progress("error", downloaded, total_bytes, &format!("Flush error: {}", e));
        return InstallRunnerResult {
            success: false,
            runner_name: runner_name.clone(),
            install_path: String::new(),
            message: format!("Flush error: {}", e),
        };
    }
    drop(file);

    // --- Extraction phase ---
    emit_progress("extracting", downloaded, total_bytes, "Extracting archive...");

    let extract_dir = tmp_dir.join("extract");
    let archive_path_clone = archive_path.clone();
    let extract_dir_clone = extract_dir.clone();
    let file_name_clone = file_name.clone();

    // Run extraction in a blocking thread,
    // since the decompression libraries work synchronously
    let extract_result = tokio::task::spawn_blocking(move || {
        std::fs::create_dir_all(&extract_dir_clone)?;

        let file = std::fs::File::open(&archive_path_clone)?;

        // Use the appropriate decompressor based on the archive format
        if file_name_clone.ends_with(".tar.gz") {
            let decoder = flate2::read::GzDecoder::new(file);
            let mut archive = tar::Archive::new(decoder);
            crate::util::safe_unpack(&mut archive, &extract_dir_clone)?;
        } else if file_name_clone.ends_with(".tar.xz") {
            let decoder = xz2::read::XzDecoder::new(file);
            let mut archive = tar::Archive::new(decoder);
            crate::util::safe_unpack(&mut archive, &extract_dir_clone)?;
        } else if file_name_clone.ends_with(".tar.zst") || file_name_clone.ends_with(".tar.zstd") {
            let decoder = zstd::stream::read::Decoder::new(file)?;
            let mut archive = tar::Archive::new(decoder);
            crate::util::safe_unpack(&mut archive, &extract_dir_clone)?;
        } else {
            return Err(
                std::io::Error::new(std::io::ErrorKind::InvalidInput, "Unknown archive format")
            );
        }

        Ok::<(), std::io::Error>(())
    }).await;

    match extract_result {
        Ok(Ok(())) => {}
        Ok(Err(e)) => {
            let _ = tokio::fs::remove_dir_all(&tmp_dir).await;
            emit_progress("error", downloaded, total_bytes, &format!("Extraction failed: {}", e));
            return InstallRunnerResult {
                success: false,
                runner_name: runner_name.clone(),
                install_path: String::new(),
                message: format!("Extraction failed: {}", e),
            };
        }
        Err(e) => {
            let _ = tokio::fs::remove_dir_all(&tmp_dir).await;
            emit_progress("error", downloaded, total_bytes, &format!("Task error: {}", e));
            return InstallRunnerResult {
                success: false,
                runner_name: runner_name.clone(),
                install_path: String::new(),
                message: format!("Task error: {}", e),
            };
        }
    }

    // --- Normalize directory structure (LUG helper convention) ---
    // Some archives contain a single directory as root,
    // others extract their files directly. Both cases are handled here.
    let entries: Vec<_> = match std::fs::read_dir(&extract_dir) {
        Ok(rd) => rd.filter_map(|e| e.ok()).collect(),
        Err(e) => {
            let _ = tokio::fs::remove_dir_all(&tmp_dir).await;
            emit_progress("error", downloaded, total_bytes, &format!("Read error: {}", e));
            return InstallRunnerResult {
                success: false,
                runner_name: runner_name.clone(),
                install_path: String::new(),
                message: format!("Read extracted dir error: {}", e),
            };
        }
    };

    if entries.len() == 1 && entries[0].path().is_dir() {
        // Single directory -- rename directly to target name
        if let Err(e) = std::fs::rename(entries[0].path(), &final_path) {
            let _ = tokio::fs::remove_dir_all(&tmp_dir).await;
            emit_progress("error", downloaded, total_bytes, &format!("Move error: {}", e));
            return InstallRunnerResult {
                success: false,
                runner_name: runner_name.clone(),
                install_path: String::new(),
                message: format!("Failed to move runner: {}", e),
            };
        }
    } else {
        // Multiple entries -- rename the entire extract directory to target name
        if let Err(e) = std::fs::rename(&extract_dir, &final_path) {
            let _ = tokio::fs::remove_dir_all(&tmp_dir).await;
            emit_progress("error", downloaded, total_bytes, &format!("Move error: {}", e));
            return InstallRunnerResult {
                success: false,
                runner_name: runner_name.clone(),
                install_path: String::new(),
                message: format!("Failed to move runner: {}", e),
            };
        }
    }

    // Clean up temporary directory
    let _ = tokio::fs::remove_dir_all(&tmp_dir).await;

    emit_progress("complete", downloaded, total_bytes, "Installation complete!");

    InstallRunnerResult {
        success: true,
        runner_name: runner_name.clone(),
        install_path: final_path.to_string_lossy().into_owned(),
        message: "Runner installed successfully".into(),
    }
}

/// Cancels an active runner download.
///
/// Sets the global cancel flag that is checked in the download loop.
/// Always returns `true` since setting the flag cannot fail.
#[tauri::command]
pub fn cancel_runner_install() -> bool {
    CANCEL_FLAG.store(true, Ordering::SeqCst);
    true
}

/// Deletes an installed runner.
///
/// Performs a safety check before deletion: the directory must
/// contain a `bin/wine` file to prevent accidental deletion of
/// wrong directories.
#[tauri::command]
pub async fn delete_runner(runner_name: String, base_path: String) -> Result<(), String> {
    let expanded = expand_tilde(&base_path);
    let runner_path = Path::new(&expanded).join("runners").join(&runner_name);

    if !runner_path.is_dir() {
        return Err(format!("Runner directory not found: {}", runner_path.display()));
    }

    // Safety check: directory must contain bin/wine
    // to prevent accidental deletion of other directories
    let wine_bin = runner_path.join("bin").join("wine");
    if !wine_bin.exists() {
        return Err(
            format!("Safety check failed: {} does not contain bin/wine", runner_path.display())
        );
    }

    tokio::fs
        ::remove_dir_all(&runner_path).await
        .map_err(|e| format!("Failed to delete runner: {}", e))?;

    Ok(())
}
