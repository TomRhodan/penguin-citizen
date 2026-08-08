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
use std::path::{Path, PathBuf};
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
    /// Publication timestamp of the GitHub release (ISO-8601).
    /// Primary sort key for the download list. `None` for entries
    /// restored from a cache written before this field existed.
    #[serde(default)]
    pub published_at: Option<String>,
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
    /// ISO-8601 publication timestamp. Absent for draft releases.
    #[serde(default)]
    published_at: Option<String>,
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

/// Compares two version-like strings in "natural" order.
///
/// Digit runs are compared numerically, everything else byte-wise. This is
/// required because a plain string comparison ranks `"11.9-1"` above
/// `"11.14-1"`, which would put an older runner at the top of the list.
///
/// Leading zeros are ignored for the numeric comparison; a digit run always
/// sorts after a non-digit run at the same position (so `"11.9"` < `"11.9a"`
/// stays intuitive for suffixed tags).
fn compare_natural(a: &str, b: &str) -> std::cmp::Ordering {
    use std::cmp::Ordering;

    let mut ai = a.chars().peekable();
    let mut bi = b.chars().peekable();

    loop {
        let (Some(&ac), Some(&bc)) = (ai.peek(), bi.peek()) else {
            // At least one side ran out: the shorter string sorts first.
            return match (ai.peek().is_some(), bi.peek().is_some()) {
                (false, true) => Ordering::Less,
                (true, false) => Ordering::Greater,
                _ => Ordering::Equal,
            };
        };

        if ac.is_ascii_digit() && bc.is_ascii_digit() {
            // Consume both digit runs and compare them as numbers.
            let a_num: String = take_digits(&mut ai);
            let b_num: String = take_digits(&mut bi);
            let a_trim = a_num.trim_start_matches('0');
            let b_trim = b_num.trim_start_matches('0');

            // Longer digit run (after stripping zeros) means larger number.
            match a_trim.len().cmp(&b_trim.len()).then_with(|| a_trim.cmp(b_trim)) {
                Ordering::Equal => {}
                other => {
                    return other;
                }
            }
        } else {
            match ac.cmp(&bc) {
                Ordering::Equal => {
                    ai.next();
                    bi.next();
                }
                other => {
                    return other;
                }
            }
        }
    }
}

/// Consumes and returns the leading run of ASCII digits from `iter`.
fn take_digits(iter: &mut std::iter::Peekable<std::str::Chars<'_>>) -> String {
    let mut out = String::new();
    while let Some(&c) = iter.peek() {
        if !c.is_ascii_digit() {
            break;
        }
        out.push(c);
        iter.next();
    }
    out
}

/// Checks whether a file name has a supported archive format.
fn is_archive(name: &str) -> bool {
    name.ends_with(".tar.gz") ||
        name.ends_with(".tar.xz") ||
        name.ends_with(".tar.zst") ||
        name.ends_with(".tar.zstd")
}

/// Known wine binary locations within runner directories, checked in order.
const WINE_BIN_PATHS: &[&[&str]] = &[
    &["bin", "wine"],           // Standard Wine (LUG, Kron4ek)
    &["files", "bin", "wine"],  // GE-Proton, Valve Proton
    &["dist", "bin", "wine"],   // Older Proton builds
];

/// Resolves the wine binary path for a runner directory by checking
/// known layouts in priority order.
pub(crate) fn resolve_wine_bin(runner_dir: &Path) -> Option<PathBuf> {
    for segments in WINE_BIN_PATHS {
        let mut path = runner_dir.to_path_buf();
        for seg in *segments {
            path.push(seg);
        }
        if path.exists() {
            return Some(path);
        }
    }
    None
}

use crate::util::{expand_tilde, http_client};

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

    let client = http_client();

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
                let status = resp.status();
                if !status.is_success() {
                    if status.as_u16() == 403 || status.as_u16() == 429 {
                        errors.push(format!(
                            "{}: GitHub API rate limit reached ({}). Add a GitHub token in Settings to increase the limit.",
                            source.name, status
                        ));
                    } else {
                        errors.push(format!("{}: GitHub API returned {}", source.name, status));
                    }
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
                                    published_at: release.published_at.clone(),
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

    sort_runners_newest_first(&mut all_runners);

    FetchRunnersResult {
        runners: all_runners,
        errors,
    }
}

/// Sorts available runners newest-first.
///
/// Primary key is the release publication date (ISO-8601 sorts correctly
/// lexicographically); entries without a date go last. Ties are broken by a
/// natural comparison of the release tag, so `11.14-1` outranks `11.9-1`.
/// `sort_by` is stable, so assets belonging to the same release keep the
/// order GitHub returned them in.
fn sort_runners_newest_first(runners: &mut [AvailableRunner]) {
    runners.sort_by(|a, b| {
        let a_date = a.published_at.as_deref().unwrap_or("");
        let b_date = b.published_at.as_deref().unwrap_or("");

        // Missing dates sort last regardless of direction.
        match (a_date.is_empty(), b_date.is_empty()) {
            (true, false) => {
                return std::cmp::Ordering::Greater;
            }
            (false, true) => {
                return std::cmp::Ordering::Less;
            }
            _ => {}
        }

        b_date.cmp(a_date).then_with(|| compare_natural(&b.version, &a.version))
    });
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
    base_path: String,
    source: Option<String>,
    version: Option<String>
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

    emit_progress("downloading", 0, 0, "Starting download...");

    // Stream to disk with retry + Range-resume (shared helper). Track the final
    // byte counts so the extraction phase can report them. Atomics (not Cell) so
    // the download future stays `Send` for the Tauri command.
    let final_downloaded = std::sync::atomic::AtomicU64::new(0);
    let final_total = std::sync::atomic::AtomicU64::new(0);

    let dl_result = crate::util::download_to_file(
        &download_url,
        &archive_path,
        |downloaded, total| {
            final_downloaded.store(downloaded, Ordering::SeqCst);
            final_total.store(total, Ordering::SeqCst);
            emit_progress("downloading", downloaded, total, "Downloading...");
        },
        || CANCEL_FLAG.load(Ordering::SeqCst),
    ).await;

    match dl_result {
        Ok(()) => {}
        Err(crate::util::DownloadError::Cancelled) => {
            let _ = tokio::fs::remove_dir_all(&tmp_dir).await;
            emit_progress("error", final_downloaded.load(Ordering::SeqCst), final_total.load(Ordering::SeqCst), "Download cancelled");
            return InstallRunnerResult {
                success: false,
                runner_name: runner_name.clone(),
                install_path: String::new(),
                message: "Download cancelled by user".into(),
            };
        }
        Err(crate::util::DownloadError::Failed(msg)) => {
            let _ = tokio::fs::remove_dir_all(&tmp_dir).await;
            emit_progress("error", final_downloaded.load(Ordering::SeqCst), final_total.load(Ordering::SeqCst), &format!("Download failed: {}", msg));
            return InstallRunnerResult {
                success: false,
                runner_name: runner_name.clone(),
                install_path: String::new(),
                message: format!("Download failed: {}", msg),
            };
        }
    }

    let downloaded = final_downloaded.load(Ordering::SeqCst);
    let total_bytes = final_total.load(Ordering::SeqCst);

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

    // Record provenance so the runners page can show where this build came
    // from. Best-effort: a missing marker only means the source is unknown.
    write_runner_marker(&final_path, source.as_deref(), version.as_deref());

    emit_progress("complete", downloaded, total_bytes, "Installation complete!");

    InstallRunnerResult {
        success: true,
        runner_name: runner_name.clone(),
        install_path: final_path.to_string_lossy().into_owned(),
        message: "Runner installed successfully".into(),
    }
}

// --- Runner provenance & details ---

/// File name of the provenance marker written into every runner directory
/// installed by Penguin Citizen. Runners installed before this existed (or
/// unpacked by hand) simply have no marker.
const RUNNER_MARKER_FILE: &str = ".penguin-citizen-runner.json";

/// Provenance information stored alongside an installed runner.
#[derive(Serialize, Deserialize, Clone, Default)]
pub struct RunnerMarker {
    /// Name of the source the runner was downloaded from (e.g. "LUG")
    #[serde(default)]
    pub source: Option<String>,
    /// Release tag the runner belonged to
    #[serde(default)]
    pub version: Option<String>,
    /// Installation timestamp (RFC 3339)
    #[serde(default)]
    pub installed_at: Option<String>,
}

/// Writes the provenance marker into a freshly installed runner directory.
///
/// Best-effort: failures are logged but never fail the installation, since
/// the runner itself is already usable at this point.
fn write_runner_marker(runner_dir: &Path, source: Option<&str>, version: Option<&str>) {
    let marker = RunnerMarker {
        source: source.map(str::to_string),
        version: version.map(str::to_string),
        installed_at: Some(chrono::Utc::now().to_rfc3339()),
    };

    match serde_json::to_string_pretty(&marker) {
        Ok(json) => {
            if let Err(e) = std::fs::write(runner_dir.join(RUNNER_MARKER_FILE), json) {
                log::warn!("Failed to write runner marker for {}: {}", runner_dir.display(), e);
            }
        }
        Err(e) => log::warn!("Failed to serialize runner marker: {}", e),
    }
}

/// Reads the provenance marker of an installed runner, if present.
fn read_runner_marker(runner_dir: &Path) -> Option<RunnerMarker> {
    let contents = std::fs::read_to_string(runner_dir.join(RUNNER_MARKER_FILE)).ok()?;
    serde_json::from_str(&contents).ok()
}

/// Builds a name -> source map from the runner cache in `cache.json`.
///
/// Fallback for runners installed before markers existed. Only works while
/// the runner is still among the cached releases of its source.
fn cached_sources_by_name() -> std::collections::HashMap<String, String> {
    let mut map = std::collections::HashMap::new();

    let Some(cache_path) = dirs::config_dir().map(|p|
        p.join("penguin-citizen").join("cache.json")
    ) else {
        return map;
    };
    let Ok(contents) = std::fs::read_to_string(cache_path) else {
        return map;
    };
    let Ok(cache) = serde_json::from_str::<crate::config::AppCache>(&contents) else {
        return map;
    };

    for runner in cache.runners.runners {
        map.entry(runner.name).or_insert(runner.source);
    }

    map
}

/// Detailed information about an installed runner.
///
/// Deliberately kept out of `scan_runners`: gathering these values walks the
/// whole runner directory and spawns `wine --version`, which is far too
/// expensive for the five pages that only need the runner names.
#[derive(Serialize, Deserialize, Clone)]
pub struct RunnerDetails {
    /// Directory name of the runner
    pub name: String,
    /// Absolute path of the runner directory
    pub install_path: String,
    /// Total size of the runner directory in bytes
    pub size_bytes: u64,
    /// Installation timestamp (RFC 3339), from the marker or the directory mtime
    pub installed_at: Option<String>,
    /// Version reported by `wine --version`, e.g. "wine-10.0"
    pub wine_version: Option<String>,
    /// Detected directory layout: "wine", "proton" or "proton-legacy"
    pub layout: String,
    /// Source the runner was downloaded from, if known
    pub source: Option<String>,
    /// Release tag the runner was installed from, if known
    pub version: Option<String>,
}

/// Determines the layout label for a runner from the location of its wine binary.
fn layout_label(runner_dir: &Path, wine_bin: &Path) -> &'static str {
    let relative = wine_bin.strip_prefix(runner_dir).unwrap_or(wine_bin);
    match relative.iter().next().and_then(|s| s.to_str()) {
        Some("files") => "proton",
        Some("dist") => "proton-legacy",
        _ => "wine",
    }
}

/// Queries the wine version of a runner by running `wine --version`.
///
/// Returns `None` if the binary cannot be executed or produces no output.
/// `--version` returns immediately, so no timeout handling is needed.
fn query_wine_version(wine_bin: &Path, prefix: &Path) -> Option<String> {
    let mut cmd = std::process::Command::new(wine_bin);
    cmd.arg("--version")
        .env("WINEPREFIX", prefix)
        .env("WINEDEBUG", "-all")
        .stdin(std::process::Stdio::null());
    crate::util::clean_appimage_env(&mut cmd);

    let output = cmd.output().ok()?;
    if !output.status.success() {
        return None;
    }

    let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if version.is_empty() { None } else { Some(version) }
}

/// Collects detailed information about all locally installed runners.
///
/// Runs entirely on a blocking thread: it walks each runner directory to
/// compute its size and executes `wine --version` once per runner. The
/// frontend calls this in parallel to the cheap `scan_runners` and patches
/// the results in once they arrive.
#[tauri::command]
pub async fn get_runner_details(base_path: String) -> Result<Vec<RunnerDetails>, String> {
    tokio::task
        ::spawn_blocking(move || {
            let expanded = expand_tilde(&base_path);
            let prefix = PathBuf::from(&expanded);
            let runners_dir = prefix.join("runners");

            let mut details = Vec::new();
            if !runners_dir.is_dir() {
                return details;
            }

            let cached_sources = cached_sources_by_name();

            let Ok(entries) = std::fs::read_dir(&runners_dir) else {
                return details;
            };

            for entry in entries.flatten() {
                let runner_dir = entry.path();
                if !runner_dir.is_dir() {
                    continue;
                }
                // Same validity rule as scan_runners: must contain a wine binary
                let Some(wine_bin) = resolve_wine_bin(&runner_dir) else {
                    continue;
                };

                let name = runner_dir
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .into_owned();

                let marker = read_runner_marker(&runner_dir);

                // Prefer the marker's timestamp; fall back to the directory mtime
                let installed_at = marker
                    .as_ref()
                    .and_then(|m| m.installed_at.clone())
                    .or_else(|| {
                        runner_dir
                            .metadata()
                            .ok()
                            .and_then(|m| m.modified().ok())
                            .map(|t| {
                                let dt: chrono::DateTime<chrono::Utc> = t.into();
                                dt.to_rfc3339()
                            })
                    });

                let source = marker
                    .as_ref()
                    .and_then(|m| m.source.clone())
                    .or_else(|| cached_sources.get(&name).cloned());

                details.push(RunnerDetails {
                    layout: layout_label(&runner_dir, &wine_bin).to_string(),
                    size_bytes: crate::util::dir_size(&runner_dir),
                    wine_version: query_wine_version(&wine_bin, &prefix),
                    install_path: runner_dir.to_string_lossy().into_owned(),
                    installed_at,
                    source,
                    version: marker.and_then(|m| m.version),
                    name,
                });
            }

            details.sort_by(|a, b| a.name.cmp(&b.name));
            details
        }).await
        .map_err(|e| format!("Failed to collect runner details: {}", e))
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
/// contain a wine binary (in any known layout) to prevent
/// accidental deletion of wrong directories.
#[tauri::command]
pub async fn delete_runner(runner_name: String, base_path: String) -> Result<(), String> {
    let expanded = expand_tilde(&base_path);
    let runner_path = Path::new(&expanded).join("runners").join(&runner_name);

    if !runner_path.is_dir() {
        return Err(format!("Runner directory not found: {}", runner_path.display()));
    }

    // Safety check: directory must contain a wine binary
    // to prevent accidental deletion of other directories
    if resolve_wine_bin(&runner_path).is_none() {
        return Err(
            format!("Safety check failed: {} does not contain a wine binary", runner_path.display())
        );
    }

    tokio::fs
        ::remove_dir_all(&runner_path).await
        .map_err(|e| format!("Failed to delete runner: {}", e))?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cmp::Ordering as Cmp;

    fn runner(name: &str, version: &str, published_at: Option<&str>) -> AvailableRunner {
        AvailableRunner {
            name: name.to_string(),
            source: "LUG".to_string(),
            version: version.to_string(),
            download_url: String::new(),
            file_name: format!("{}.tar.xz", name),
            size_bytes: 0,
            installed: false,
            published_at: published_at.map(str::to_string),
        }
    }

    // ── compare_natural ──

    #[test]
    fn natural_compares_digit_runs_numerically() {
        // The whole reason this helper exists: plain string order gets this wrong.
        assert_eq!(compare_natural("11.14-1", "11.9-1"), Cmp::Greater);
        assert_eq!(compare_natural("11.9-1", "11.14-1"), Cmp::Less);
        assert!("11.14-1" < "11.9-1", "sanity: plain string order really is wrong here");
    }

    #[test]
    fn natural_handles_multi_digit_and_zero_padding() {
        assert_eq!(compare_natural("10.0", "9.0"), Cmp::Greater);
        assert_eq!(compare_natural("v2.100", "v2.99"), Cmp::Greater);
        assert_eq!(compare_natural("1.007", "1.7"), Cmp::Equal);
        assert_eq!(compare_natural("1.08", "1.9"), Cmp::Less);
    }

    #[test]
    fn natural_equal_and_prefix_strings() {
        assert_eq!(compare_natural("11.14-1", "11.14-1"), Cmp::Equal);
        assert_eq!(compare_natural("", ""), Cmp::Equal);
        // Shorter string sorts first when one is a prefix of the other
        assert_eq!(compare_natural("11.14", "11.14-1"), Cmp::Less);
        assert_eq!(compare_natural("11.14-1", "11.14"), Cmp::Greater);
    }

    #[test]
    fn natural_compares_non_digit_segments_bytewise() {
        assert_eq!(compare_natural("lug-wine-11.1", "lug-wine-11.1"), Cmp::Equal);
        assert_eq!(compare_natural("a-11", "b-11"), Cmp::Less);
        // Digits sort before letters at the same position ('1' < 'a')
        assert_eq!(compare_natural("11.9", "11.9a"), Cmp::Less);
    }

    // ── sort_runners_newest_first ──

    #[test]
    fn sort_puts_newest_release_first() {
        let mut list = vec![
            runner("old", "11.9-1", Some("2026-01-05T10:00:00Z")),
            runner("new", "11.14-1", Some("2026-03-20T10:00:00Z")),
            runner("mid", "11.12-1", Some("2026-02-10T10:00:00Z")),
        ];
        sort_runners_newest_first(&mut list);
        let names: Vec<&str> = list.iter().map(|r| r.name.as_str()).collect();
        assert_eq!(names, vec!["new", "mid", "old"]);
    }

    #[test]
    fn sort_breaks_date_ties_by_natural_version() {
        let date = Some("2026-03-20T10:00:00Z");
        let mut list = vec![
            runner("a", "11.9-1", date),
            runner("b", "11.14-1", date),
            runner("c", "11.10-1", date),
        ];
        sort_runners_newest_first(&mut list);
        let names: Vec<&str> = list.iter().map(|r| r.name.as_str()).collect();
        assert_eq!(names, vec!["b", "c", "a"]);
    }

    #[test]
    fn sort_preserves_asset_order_within_one_release() {
        // Same date and same tag: the GitHub asset order must survive,
        // which only holds because sort_by is stable.
        let date = Some("2026-03-20T10:00:00Z");
        let mut list = vec![
            runner("lug-wine-tkg-git-11.14-1", "11.14-1", date),
            runner("lug-wine-tkg-staging-git-11.14-1", "11.14-1", date),
        ];
        sort_runners_newest_first(&mut list);
        let names: Vec<&str> = list.iter().map(|r| r.name.as_str()).collect();
        assert_eq!(names, vec!["lug-wine-tkg-git-11.14-1", "lug-wine-tkg-staging-git-11.14-1"]);
    }

    #[test]
    fn sort_pushes_entries_without_date_to_the_end() {
        let mut list = vec![
            runner("undated", "99.0", None),
            runner("dated-old", "1.0", Some("2020-01-01T00:00:00Z")),
            runner("dated-new", "2.0", Some("2026-01-01T00:00:00Z")),
        ];
        sort_runners_newest_first(&mut list);
        let names: Vec<&str> = list.iter().map(|r| r.name.as_str()).collect();
        assert_eq!(names, vec!["dated-new", "dated-old", "undated"]);
    }

    // ── layout_label ──

    #[test]
    fn layout_label_detects_known_layouts() {
        let root = Path::new("/runners/foo");
        assert_eq!(layout_label(root, &root.join("bin/wine")), "wine");
        assert_eq!(layout_label(root, &root.join("files/bin/wine")), "proton");
        assert_eq!(layout_label(root, &root.join("dist/bin/wine")), "proton-legacy");
    }
}
