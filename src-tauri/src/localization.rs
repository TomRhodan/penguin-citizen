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

//! Localization module (language pack management).
//!
//! This module is responsible for:
//! - Fetching available translations from GitHub repositories
//! - Installing translation files (global.ini) into the Star Citizen directory
//! - Checking for available translation updates
//! - Removing installed translations and cleaning up USER.cfg
//!
//! Supported languages: German, French, Spanish, Italian, and Portuguese.
//! The translation files come from community repositories on GitHub.

use crate::sc_config::{ expand_tilde, sc_base_dir };
use crate::util::http_client;
use chrono::Local;
use serde::{ Deserialize, Serialize };
use std::fs;
use std::path::PathBuf;
use tauri::{ AppHandle, Emitter };

// ============================================================
// Data structures
// ============================================================

/// Information about an available language source.
///
/// Each language source points to a GitHub repository that provides
/// translation files (global.ini). Multiple sources can exist for the
/// same language (e.g., different repos for German).
#[derive(Serialize, Deserialize, Clone)]
pub struct LanguageSource {
    /// Language code as used by Star Citizen (e.g., "german_(germany)")
    pub language_code: String,
    /// Display name of the language (e.g., "Deutsch")
    pub language_name: String,
    /// Country flag abbreviation (e.g., "DE") - displayed as an emoji flag in the frontend
    pub flag: String,
    /// GitHub repository path (e.g., "Dymerz/StarCitizen-Localization")
    pub source_repo: String,
    /// User-friendly name of the source (e.g., "Community Localization")
    pub source_label: String,
    /// Full URL to the GitHub repository
    pub repo_url: String,
    /// Variant of the source (rjcncpt only): Some("hybrid") for live/global.ini,
    /// Some("full") for live/full/global.ini. None for sources without variant concept.
    pub variant: Option<String>,
}

/// Status of an installed localization.
///
/// Sent to the frontend to display the current installation state
/// of a translation for a specific game version.
/// Contains both installation metadata and USER.cfg settings.
#[derive(Serialize, Deserialize, Clone)]
pub struct LocalizationStatus {
    /// Whether a translation is installed
    pub installed: bool,
    /// Installed language code
    pub language_code: Option<String>,
    /// Display name of the installed language
    pub language_name: Option<String>,
    /// Source label of the installation
    pub source_label: Option<String>,
    /// Installation timestamp as a formatted string
    pub installed_at: Option<String>,
    /// File size of global.ini in bytes
    pub file_size: Option<u64>,
    /// Current g_language value from USER.cfg
    pub cfg_language: Option<String>,
    /// Current g_languageAudio value from USER.cfg
    pub cfg_language_audio: Option<String>,
    /// Git commit SHA of the installed version (for update checking)
    pub commit_sha: Option<String>,
    /// Date of the git commit of the installed version
    pub commit_date: Option<String>,
    /// Source repository of the installed translation
    pub source_repo: Option<String>,
    /// URL to the source repository
    pub repo_url: Option<String>,
    /// Installed variant ("hybrid" or "full") - currently only meaningful for rjcncpt
    pub variant: Option<String>,
    /// Whether blueprint injection was applied during the last install
    pub blueprints_installed: Option<bool>,
    /// Patch identifier from the BP data (e.g. "4.7.2-live.11674325")
    pub blueprints_version: Option<String>,
}

/// Result of a localization installation.
///
/// Returned to the frontend after a successful or failed installation.
#[derive(Serialize, Deserialize, Clone)]
pub struct LocalizationInstallResult {
    /// Whether the installation was successful
    pub success: bool,
    /// User-friendly status message
    pub message: String,
    /// Size of the downloaded file in bytes
    pub bytes: u64,
    /// Non-fatal warning to surface alongside success — currently used for
    /// blueprint-injection hit-rate warnings. None means no warning.
    #[serde(default)]
    pub bp_warning: Option<String>,
}

/// Metadata of an installed localization (stored locally on disk).
///
/// This data is saved as JSON in ~/.config/penguin-citizen/localization/{version}.json
/// and allows tracking the installation status and update checks
/// even after an application restart.
#[derive(Serialize, Deserialize, Clone)]
struct LocalizationMeta {
    language_code: String,
    language_name: String,
    source_label: String,
    installed_at: String,
    file_size: u64,
    /// Commit SHA - with serde(default) because older installations did not have this field
    #[serde(default)]
    commit_sha: Option<String>,
    /// Commit date - also added retroactively
    #[serde(default)]
    commit_date: Option<String>,
    /// Source repository - added retroactively for update checking
    #[serde(default)]
    source_repo: Option<String>,
    /// Variant - added retroactively via serde(default) for older installations
    #[serde(default)]
    variant: Option<String>,
    /// Whether blueprint injection was applied during the last install
    #[serde(default)]
    blueprints_installed: Option<bool>,
    /// Patch identifier from the BP data (e.g. "4.7.2-live.11674325")
    #[serde(default)]
    blueprints_version: Option<String>,
}

/// Progress message during localization installation.
///
/// Sent to the frontend via Tauri event ("localization-progress")
/// so that a progress bar can be displayed.
#[derive(Serialize, Deserialize, Clone)]
pub struct LocalizationProgress {
    /// Current phase: "download", "install", or "done"
    pub phase: String,
    /// Progress in percent (0.0 to 100.0)
    pub percent: f64,
    /// User-friendly status message
    pub message: String,
}

/// GitHub API response: commit information.
///
/// Used to deserialize the latest commit of a translation file
/// from the GitHub API.
#[derive(Deserialize)]
struct GitHubCommitInfo {
    /// SHA hash of the commit
    sha: String,
    /// Detailed commit information
    commit: GitHubCommitDetail,
}

/// Nested commit details from the GitHub API response.
#[derive(Deserialize)]
struct GitHubCommitDetail {
    committer: GitHubCommitAuthor,
}

/// Commit author information from the GitHub API response.
#[derive(Deserialize)]
struct GitHubCommitAuthor {
    /// ISO 8601 timestamp of the commit
    date: String,
}

/// Information about a remote language version.
///
/// Cached per combination of source repository, language code, and variant,
/// so the GitHub API does not need to be queried on every display.
#[derive(Serialize, Deserialize, Clone)]
pub struct RemoteLanguageInfo {
    pub source_repo: String,
    pub language_code: String,
    /// SHA hash of the latest commit for the translation file
    pub commit_sha: String,
    /// Date of the latest commit
    pub commit_date: String,
    /// Timestamp when this information was fetched
    pub fetched_at: String,
    /// Variant - needed so the frontend can distinguish remote info per variant (rjcncpt only)
    #[serde(default)]
    pub variant: Option<String>,
}

/// On-disk cache for remote metadata.
///
/// Stores the most recently fetched remote information for all language sources
/// to minimize GitHub API calls. The cache has a TTL of 30 minutes.
#[derive(Serialize, Deserialize, Clone)]
struct RemoteCache {
    /// All cached entries
    entries: Vec<RemoteLanguageInfo>,
    /// Timestamp of the last update of the entire cache
    #[serde(default)]
    last_fetched: Option<String>,
}

/// Result of an update check for an installed localization.
///
/// Compares the local commit SHA with the latest remote SHA
/// to determine whether an update is available.
#[derive(Serialize)]
pub struct LocalizationUpdateCheck {
    /// Whether an update is available
    pub update_available: bool,
    /// SHA of the locally installed commit
    pub local_commit_sha: Option<String>,
    /// SHA of the latest commit in the remote repository
    pub remote_commit_sha: Option<String>,
    /// Date of the latest remote commit
    pub remote_commit_date: Option<String>,
}

// ============================================================
// Path helper functions
// ============================================================

/// Returns the path to the localization directory for a specific language.
///
/// Star Citizen expects translation files in the directory:
/// `{game_path}/{version}/data/Localization/{language_code}/global.ini`
fn sc_localization_dir(game_path: &str, version: &str, language_code: &str) -> Result<PathBuf, String> {
    Ok(sc_base_dir(game_path, version)?.join("data").join("Localization").join(language_code))
}

/// Returns the directory where localization metadata is stored.
///
/// Default: `~/.config/penguin-citizen/localization/`
fn meta_dir() -> Result<PathBuf, String> {
    dirs::config_dir()
        .map(|p| p.join("penguin-citizen").join("localization"))
        .ok_or_else(|| "Could not determine config directory".to_string())
}

/// Returns the path to the metadata file for a specific game version.
///
/// e.g., `~/.config/penguin-citizen/localization/LIVE.json`
fn meta_path(version: &str) -> Result<PathBuf, String> {
    Ok(meta_dir()?.join(format!("{}.json", version)))
}

// ============================================================
// Download URL construction
// ============================================================

/// Builds the download URL for the global.ini file from the respective repository.
///
/// The URL structure differs depending on the repository:
/// - **rjcncpt**: Always uses the `main` branch, but distinguishes between `live/` and `ptu/` folders.
///   The `variant` parameter further controls the path:
///   - `Some("full")`: uses `{folder}/full/global.ini` (Volle Übersetzung)
///   - `None` or `Some("hybrid")`: uses `{folder}/global.ini` (Hybrid, default)
/// - **Dymerz**: Uses different git branches (`main` for LIVE, `ptu` for test server versions)
///
/// The version determines whether the LIVE or PTU variant is downloaded.
fn build_download_url(source_repo: &str, language_code: &str, version: &str, variant: Option<&str>) -> String {
    // PTU-like versions use the ptu branch/folder, everything else uses the main/live branch
    let branch = match version {
        "PTU" | "EPTU" | "TECH-PREVIEW" => "ptu",
        _ => "main",
    };

    if source_repo == "rjcncpt/StarCitizen-Deutsch-INI" {
        // rjcncpt repo: folder-based separation (live/ptu) on the main branch
        let folder = if branch == "ptu" { "ptu" } else { "live" };
        if variant == Some("full") {
            format!(
                "https://raw.githubusercontent.com/{}/{}/{}/full/global.ini",
                source_repo,
                "main",
                folder
            )
        } else {
            format!(
                "https://raw.githubusercontent.com/{}/{}/{}/global.ini",
                source_repo,
                "main",
                folder
            )
        }
    } else {
        // Dymerz repo: branch-based separation (main/ptu), language in path
        format!(
            "https://raw.githubusercontent.com/{}/{}/data/Localization/{}/global.ini",
            source_repo,
            branch,
            language_code
        )
    }
}

// ============================================================
// USER.cfg language settings management
// ============================================================

/// Sets the language settings in the Star Citizen USER.cfg file.
///
/// Star Citizen reads the variables `g_language` and `g_languageAudio`
/// from USER.cfg at startup to determine the display language and audio language.
/// This function updates existing entries or adds new ones.
/// The audio language is always set to English, as only English
/// voice output is available.
fn update_user_cfg_language(
    game_path: &str,
    version: &str,
    language_code: &str
) -> Result<(), String> {
    let cfg_path = sc_base_dir(game_path, version)?.join("USER.cfg");

    // Read existing file or start with empty content
    let content = if cfg_path.exists() {
        fs::read_to_string(&cfg_path).map_err(|e| format!("Failed to read USER.cfg: {}", e))?
    } else {
        String::new()
    };

    let mut lines: Vec<String> = content
        .lines()
        .map(|l| l.to_string())
        .collect();

    let mut found_lang = false;
    let mut found_audio = false;

    // Find and overwrite existing entries
    for line in lines.iter_mut() {
        let trimmed = line.trim();
        if trimmed.starts_with("g_language") && trimmed.contains('=') {
            *line = format!("g_language = {}", language_code);
            found_lang = true;
        } else if trimmed.starts_with("g_languageAudio") && trimmed.contains('=') {
            *line = "g_languageAudio = english".to_string();
            found_audio = true;
        }
    }

    // If the entries do not exist yet, append them at the end of the file
    if !found_lang {
        lines.push(format!("g_language = {}", language_code));
    }
    if !found_audio {
        lines.push("g_languageAudio = english".to_string());
    }

    let result = lines.join("\n");
    // Ensure the file ends with a newline
    let result = if result.ends_with('\n') { result } else { format!("{}\n", result) };

    if let Some(parent) = cfg_path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Failed to create directory: {}", e))?;
    }

    fs::write(&cfg_path, result).map_err(|e| format!("Failed to write USER.cfg: {}", e))
}

/// Removes the language settings from the USER.cfg file.
///
/// Filters out all lines that set `g_language` or `g_languageAudio`,
/// so that Star Citizen uses the default language (English) again.
fn remove_user_cfg_language(game_path: &str, version: &str) -> Result<(), String> {
    let cfg_path = sc_base_dir(game_path, version)?.join("USER.cfg");

    if !cfg_path.exists() {
        return Ok(());
    }

    let content = fs
        ::read_to_string(&cfg_path)
        .map_err(|e| format!("Failed to read USER.cfg: {}", e))?;

    // Keep all lines that do NOT set g_language or g_languageAudio
    let lines: Vec<&str> = content
        .lines()
        .filter(|line| {
            let trimmed = line.trim();
            !(
                (trimmed.starts_with("g_language") && trimmed.contains('=')) ||
                (trimmed.starts_with("g_languageAudio") && trimmed.contains('='))
            )
        })
        .collect();

    let result = lines.join("\n");
    let result = if result.ends_with('\n') { result } else { format!("{}\n", result) };

    fs::write(&cfg_path, result).map_err(|e| format!("Failed to write USER.cfg: {}", e))
}

/// Reads a single configuration value from the contents of a USER.cfg file.
///
/// Searches for a line in the format `key = value` and returns the value.
/// Inline comments (after `;`) are stripped.
fn parse_cfg_value(content: &str, key: &str) -> Option<String> {
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with(key) && trimmed.contains('=') {
            let parts: Vec<&str> = trimmed.splitn(2, '=').collect();
            // Exact key comparison to avoid confusing e.g. "g_language" with "g_languageAudio"
            if parts.len() == 2 && parts[0].trim() == key {
                let mut val = parts[1].trim().to_string();
                // Remove inline comments after semicolon
                if let Some(idx) = val.find(';') {
                    val = val[..idx].trim().to_string();
                }
                return Some(val);
            }
        }
    }
    None
}

// ============================================================
// Metadata management
// ============================================================

/// Saves the localization metadata as a JSON file on disk.
///
/// The metadata contains information about the installed translation
/// (language, source, commit SHA, etc.) and is needed for update checking
/// and status display.
fn save_meta(version: &str, meta: &LocalizationMeta) -> Result<(), String> {
    let path = meta_path(version)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Failed to create meta directory: {}", e))?;
    }
    let json = serde_json
        ::to_string_pretty(meta)
        .map_err(|e| format!("Failed to serialize meta: {}", e))?;
    fs::write(&path, json).map_err(|e| format!("Failed to write meta: {}", e))
}

/// Loads the stored localization metadata for a game version.
///
/// Returns `None` if no metadata exists (no installation)
/// or the file cannot be read.
fn load_meta(version: &str) -> Option<LocalizationMeta> {
    let path = meta_path(version).ok()?;
    let content = fs::read_to_string(&path).ok()?;
    serde_json::from_str(&content).ok()
}

/// Deletes the metadata file for a specific game version.
///
/// Called when removing a localization to clean up
/// the installation information.
fn delete_meta(version: &str) -> Result<(), String> {
    let path = meta_path(version)?;
    if path.exists() {
        fs::remove_file(&path).map_err(|e| format!("Failed to delete meta: {}", e))?;
    }
    Ok(())
}

// ============================================================
// GitHub API & remote cache
// ============================================================

/// Builds the GitHub API path for a specific repository, language, version, and variant.
///
/// Returns a tuple of (branch, file path) needed for the GitHub commits API.
/// The logic mirrors the folder structure of the respective repositories.
/// For rjcncpt, the `variant` parameter controls the sub-folder:
/// - `Some("full")`: uses `{folder}/full/global.ini`
/// - `None` or `Some("hybrid")`: uses `{folder}/global.ini`
fn build_github_api_path(source_repo: &str, language_code: &str, version: &str, variant: Option<&str>) -> (String, String) {
    let branch = match version {
        "PTU" | "EPTU" | "TECH-PREVIEW" => "ptu",
        _ => "main",
    };

    if source_repo == "rjcncpt/StarCitizen-Deutsch-INI" {
        // rjcncpt: always main branch, but live/ptu as folders
        let folder = if branch == "ptu" { "ptu" } else { "live" };
        let path = if variant == Some("full") {
            format!("{}/full/global.ini", folder)
        } else {
            format!("{}/global.ini", folder)
        };
        ("main".to_string(), path)
    } else {
        // Dymerz: branch-based separation, language as folder in path
        let path = format!("data/Localization/{}/global.ini", language_code);
        (branch.to_string(), path)
    }
}

/// Fetches the latest commit information for a translation file from the GitHub API.
///
/// Uses the GitHub commits API with path filter to find the last commit
/// that modified the global.ini file. Returns (SHA, date).
/// The User-Agent header is required as GitHub rejects API requests without it.
async fn fetch_github_commit_info(
    client: &reqwest::Client,
    source_repo: &str,
    language_code: &str,
    version: &str,
    variant: Option<&str>,
) -> Result<(String, String), String> {
    let (branch, file_path) = build_github_api_path(source_repo, language_code, version, variant);

    // GitHub API: query commits for a specific file on a specific branch
    // per_page=1 ensures only the latest commit is returned
    let url = format!(
        "https://api.github.com/repos/{}/commits?path={}&sha={}&per_page=1",
        source_repo, file_path, branch
    );

    let resp = client
        .get(&url)
        .header("User-Agent", "penguin-citizen")
        .header("Accept", "application/vnd.github.v3+json")
        .send()
        .await
        .map_err(|e| format!("GitHub API request failed: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("GitHub API returned status: {}", resp.status()));
    }

    let commits: Vec<GitHubCommitInfo> = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse GitHub API response: {}", e))?;

    // Extract the first (latest) commit from the response
    let commit = commits
        .into_iter()
        .next()
        .ok_or_else(|| "No commits found for file".to_string())?;

    Ok((commit.sha, commit.commit.committer.date))
}

/// Returns the path to the remote cache file.
///
/// Stored at: `~/.config/penguin-citizen/localization/remote_cache.json`
fn remote_cache_path() -> Result<PathBuf, String> {
    Ok(meta_dir()?.join("remote_cache.json"))
}

/// Loads the remote cache from disk.
///
/// The cache contains the most recently fetched commit information for all language sources
/// to avoid unnecessary GitHub API calls.
fn load_remote_cache() -> Option<RemoteCache> {
    let path = remote_cache_path().ok()?;
    let content = fs::read_to_string(&path).ok()?;
    serde_json::from_str(&content).ok()
}

/// Saves the remote cache to disk.
fn save_remote_cache(cache: &RemoteCache) -> Result<(), String> {
    let path = remote_cache_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create cache directory: {}", e))?;
    }
    let json = serde_json::to_string_pretty(cache)
        .map_err(|e| format!("Failed to serialize cache: {}", e))?;
    fs::write(&path, json).map_err(|e| format!("Failed to write cache: {}", e))
}

/// Checks whether the cache is still fresh (within the TTL).
///
/// Compares the timestamp of the last update with the current time.
/// If the cache is older than `ttl_minutes` minutes, it is considered stale.
fn is_cache_fresh(cache: &RemoteCache, ttl_minutes: i64) -> bool {
    if let Some(ref fetched) = cache.last_fetched {
        if let Ok(fetched_time) = chrono::DateTime::parse_from_rfc3339(fetched) {
            let now = chrono::Utc::now();
            let age = now.signed_duration_since(fetched_time);
            return age.num_minutes() < ttl_minutes;
        }
    }
    false
}

/// Builds the full GitHub URL from a repository path.
fn build_repo_url(source_repo: &str) -> String {
    format!("https://github.com/{}", source_repo)
}

// ============================================================
// Tauri commands (callable from the frontend)
// ============================================================

/// Checks whether an update is available for the installed localization.
///
/// Compares the locally stored commit SHA with the latest commit
/// on GitHub. If the SHAs differ, an update is available.
/// For older installations without a stored SHA, an update is always recommended.
#[tauri::command]
pub async fn check_localization_update(
    _game_path: String,
    version: String
) -> Result<LocalizationUpdateCheck, String> {
    let meta = load_meta(&version).ok_or_else(|| "No localization installed".to_string())?;

    // Older installations do not have a commit_sha stored -
    // in this case an update is always recommended
    let local_sha = meta.commit_sha.clone();
    if local_sha.is_none() {
        return Ok(LocalizationUpdateCheck {
            update_available: true,
            local_commit_sha: None,
            remote_commit_sha: None,
            remote_commit_date: None,
        });
    }

    // Determine source repository - for older installations it must be
    // resolved via the available languages
    let source_repo = meta.source_repo.clone().unwrap_or_else(|| {
        let languages = get_available_languages_sync();
        languages
            .iter()
            .find(|l| l.language_code == meta.language_code && l.source_label == meta.source_label)
            .map(|l| l.source_repo.clone())
            .unwrap_or_default()
    });

    if source_repo.is_empty() {
        return Err("Could not determine source repository".to_string());
    }

    // Fetch latest commit from GitHub and compare with local SHA
    let client = http_client();
    let (remote_sha, remote_date) =
        fetch_github_commit_info(client, &source_repo, &meta.language_code, &version, meta.variant.as_deref()).await?;

    let update_available = local_sha.as_deref() != Some(&remote_sha);

    Ok(LocalizationUpdateCheck {
        update_available,
        local_commit_sha: local_sha,
        remote_commit_sha: Some(remote_sha),
        remote_commit_date: Some(remote_date),
    })
}

/// Complete list of all available language sources (unfiltered).
///
/// Contains all known community translation sources.
/// German is provided by the rjcncpt/StarCitizen-Deutsch-INI repository;
/// all other languages are provided by the Dymerz/StarCitizen-Localization repository.
fn all_language_sources() -> Vec<LanguageSource> {
    vec![
        LanguageSource {
            language_code: "german_(germany)".to_string(),
            language_name: "Deutsch".to_string(),
            flag: "DE".to_string(),
            source_repo: "rjcncpt/StarCitizen-Deutsch-INI".to_string(),
            source_label: "rjcncpt \u{2014} Hybrid".to_string(),
            repo_url: "https://github.com/rjcncpt/StarCitizen-Deutsch-INI".to_string(),
            variant: Some("hybrid".to_string()),
        },
        LanguageSource {
            language_code: "german_(germany)".to_string(),
            language_name: "Deutsch+".to_string(),
            flag: "DE".to_string(),
            source_repo: "rjcncpt/StarCitizen-Deutsch-INI".to_string(),
            source_label: "rjcncpt \u{2014} Volle \u{dc}bersetzung".to_string(),
            repo_url: "https://github.com/rjcncpt/StarCitizen-Deutsch-INI".to_string(),
            variant: Some("full".to_string()),
        },
        LanguageSource {
            language_code: "french_(france)".to_string(),
            language_name: "Fran\u{00e7}ais".to_string(),
            flag: "FR".to_string(),
            source_repo: "Dymerz/StarCitizen-Localization".to_string(),
            source_label: "Community Localization".to_string(),
            repo_url: "https://github.com/Dymerz/StarCitizen-Localization".to_string(),
            variant: None,
        },
        LanguageSource {
            language_code: "spanish_(spain)".to_string(),
            language_name: "Espa\u{00f1}ol".to_string(),
            flag: "ES".to_string(),
            source_repo: "Dymerz/StarCitizen-Localization".to_string(),
            source_label: "Community Localization".to_string(),
            repo_url: "https://github.com/Dymerz/StarCitizen-Localization".to_string(),
            variant: None,
        },
        LanguageSource {
            language_code: "italian_(italy)".to_string(),
            language_name: "Italiano".to_string(),
            flag: "IT".to_string(),
            source_repo: "Dymerz/StarCitizen-Localization".to_string(),
            source_label: "Community Localization".to_string(),
            repo_url: "https://github.com/Dymerz/StarCitizen-Localization".to_string(),
            variant: None,
        },
        LanguageSource {
            language_code: "portuguese_(brazil)".to_string(),
            language_name: "Portugu\u{00ea}s".to_string(),
            flag: "BR".to_string(),
            source_repo: "Dymerz/StarCitizen-Localization".to_string(),
            source_label: "Community Localization".to_string(),
            repo_url: "https://github.com/Dymerz/StarCitizen-Localization".to_string(),
            variant: None,
        },
    ]
}

/// Checks whether a source supports a specific game version.
///
/// The rjcncpt repository only has reliable `live` and `ptu` folders.
/// It supports LIVE and HOTFIX (both mapped to the `live` folder) but
/// does not support PTU/EPTU/TECH-PREVIEW versions.
/// The Dymerz repository supports all versions via separate branches.
fn source_supports_version(source_repo: &str, version: &str) -> bool {
    if source_repo == "rjcncpt/StarCitizen-Deutsch-INI" {
        !matches!(version, "PTU" | "EPTU" | "TECH-PREVIEW")
    } else {
        true
    }
}

/// Synchronous helper function to retrieve all available languages.
///
/// Used internally when no async context is available
/// (e.g., during fallback resolution of the source repository).
fn get_available_languages_sync() -> Vec<LanguageSource> {
    all_language_sources()
}

/// Returns the available language sources, optionally filtered by game version.
///
/// When a version is specified, only sources that support that version
/// are returned (e.g., rjcncpt is filtered out for PTU versions).
#[tauri::command]
pub async fn get_available_languages(version: Option<String>) -> Result<Vec<LanguageSource>, String> {
    let all = all_language_sources();
    match version {
        Some(ref v) => Ok(all.into_iter().filter(|l| source_supports_version(&l.source_repo, v)).collect()),
        None => Ok(all),
    }
}

/// Determines the current localization status for a specific game version.
///
/// This function checks three information sources:
/// 1. **Metadata**: Stored installation information (preferred)
/// 2. **USER.cfg**: Language settings that Star Citizen actually uses
/// 3. **File system**: Whether the global.ini file actually exists
///
/// This also allows detecting manually installed translations (without metadata).
#[tauri::command]
pub async fn get_localization_status(
    game_path: String,
    version: String
) -> Result<LocalizationStatus, String> {
    let expanded = expand_tilde(&game_path);

    // Read USER.cfg to determine the current language settings
    let cfg_path = sc_base_dir(&expanded, &version)?.join("USER.cfg");
    let (cfg_language, cfg_language_audio) = if cfg_path.exists() {
        let content = fs::read_to_string(&cfg_path).unwrap_or_default();
        (parse_cfg_value(&content, "g_language"), parse_cfg_value(&content, "g_languageAudio"))
    } else {
        (None, None)
    };

    // Primary check: metadata present -> translation was installed via Penguin Citizen
    if let Some(meta) = load_meta(&version) {
        let ini_path = sc_localization_dir(&expanded, &version, &meta.language_code)?.join(
            "global.ini"
        );

        if ini_path.exists() {
            let file_size = fs
                ::metadata(&ini_path)
                .map(|m| m.len())
                .ok();

            let repo_url = meta.source_repo.as_deref().map(build_repo_url);

            return Ok(LocalizationStatus {
                installed: true,
                language_code: Some(meta.language_code),
                language_name: Some(meta.language_name),
                source_label: Some(meta.source_label),
                installed_at: Some(meta.installed_at),
                file_size,
                cfg_language,
                cfg_language_audio,
                commit_sha: meta.commit_sha,
                commit_date: meta.commit_date,
                source_repo: meta.source_repo,
                repo_url,
                variant: meta.variant,
                blueprints_installed: meta.blueprints_installed,
                blueprints_version: meta.blueprints_version.clone(),
            });
        }
    }

    // Fallback: g_language is set in USER.cfg but no metadata exists
    // This detects manually installed translations (e.g., by other tools)
    if let Some(ref lang) = cfg_language {
        let ini_path = sc_localization_dir(&expanded, &version, lang)?.join("global.ini");
        if ini_path.exists() {
            let file_size = fs
                ::metadata(&ini_path)
                .map(|m| m.len())
                .ok();
            return Ok(LocalizationStatus {
                installed: true,
                language_code: Some(lang.clone()),
                language_name: None,
                source_label: None,
                installed_at: None,
                file_size,
                cfg_language,
                cfg_language_audio,
                commit_sha: None,
                commit_date: None,
                source_repo: None,
                repo_url: None,
                variant: None,
                blueprints_installed: None,
                blueprints_version: None,
            });
        }
    }

    Ok(LocalizationStatus {
        installed: false,
        language_code: None,
        language_name: None,
        source_label: None,
        installed_at: None,
        file_size: None,
        cfg_language,
        cfg_language_audio,
        commit_sha: None,
        commit_date: None,
        source_repo: None,
        repo_url: None,
        variant: None,
        blueprints_installed: None,
        blueprints_version: None,
    })
}

/// Installs a localization (translation) for a specific game version.
///
/// Process:
/// 1. Download translation file (global.ini) from GitHub
/// 2. Save file in the Star Citizen localization directory
/// 3. Update USER.cfg with the language settings
/// 4. Fetch commit information from GitHub (for later update checks)
/// 5. Save installation metadata locally
///
/// Progress events are sent to the frontend throughout the entire process.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn install_localization(
    app: AppHandle,
    game_path: String,
    version: String,
    language_code: String,
    source_repo: String,
    language_name: String,
    source_label: String,
    variant: Option<String>,
    inject_blueprints: bool,
) -> Result<LocalizationInstallResult, String> {
    let expanded = expand_tilde(&game_path);

    // Send progress to frontend: download starting
    let _ = app.emit("localization-progress", LocalizationProgress {
        phase: "download".to_string(),
        percent: 0.0,
        message: format!("Downloading {} translation...", language_name),
    });

    // Build download URL (differs depending on the repository)
    let url = build_download_url(&source_repo, &language_code, &version, variant.as_deref());

    // Download translation file
    let client = http_client();
    let response = client
        .get(&url)
        .send().await
        .map_err(|e| format!("Download failed: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("Download failed with status: {}", response.status()));
    }

    let _ = app.emit("localization-progress", LocalizationProgress {
        phase: "download".to_string(),
        percent: 50.0,
        message: "Downloading...".to_string(),
    });

    let bytes = response.bytes().await.map_err(|e| format!("Failed to read response body: {}", e))?;

    let file_size = bytes.len() as u64;

    // Convert downloaded bytes to UTF-8 text for potential BP injection
    let global_ini_text = String::from_utf8_lossy(&bytes).into_owned();

    // Track non-fatal BP warning to surface in the install result
    let mut bp_low_hit_rate_warning: Option<String> = None;

    // Optionally inject blueprint data
    let (final_ini_text, bp_patch_for_meta): (String, Option<String>) = if inject_blueprints {
        // Emit progress event signaling the BP download phase
        let _ = app.emit("localization-progress", LocalizationProgress {
            phase: "download".into(),
            percent: 60.0,
            message: "Lade Blueprint-Daten…".into(),
        });

        let bp_url = "https://raw.githubusercontent.com/rjcncpt/StarCitizen-Deutsch-INI/main/blueprints/Data/bp-contracts_short.json";
        let version_url = "https://raw.githubusercontent.com/rjcncpt/StarCitizen-Deutsch-INI/main/blueprints/version.json";

        // Parallel download
        let bp_client = http_client();
        let (bp_resp, ver_resp) = tokio::join!(
            bp_client.get(bp_url).send(),
            bp_client.get(version_url).send(),
        );

        let bp_json = bp_resp
            .map_err(|e| format!("Failed to fetch BP contracts: {}", e))?
            .text()
            .await
            .map_err(|e| format!("Failed to read BP contracts body: {}", e))?;

        let version_json_text = ver_resp
            .map_err(|e| format!("Failed to fetch BP version.json: {}", e))?
            .text()
            .await
            .map_err(|e| format!("Failed to read BP version body: {}", e))?;

        // Extract bp_patch (best effort — soft-fail if missing)
        let bp_patch = serde_json::from_str::<serde_json::Value>(&version_json_text)
            .ok()
            .and_then(|v| v.get("version").and_then(|x| x.as_str()).map(String::from));

        let _ = app.emit("localization-progress", LocalizationProgress {
            phase: "install".into(),
            percent: 80.0,
            message: "Wende Blueprint-Daten an…".into(),
        });

        // `inject_blueprints` as a local name shadows the fn; qualify with self::
        let (merged, stats) = self::inject_blueprints_with_stats(&global_ini_text, &bp_json)?;

        // Sanity-check: if fewer than half the BP entries matched, the data
        // probably doesn't fit this SC build. Surface a non-fatal warning in
        // the install result — the install itself proceeds (user opted in).
        let max_possible = stats.entries_total.saturating_mul(2);
        bp_low_hit_rate_warning = if max_possible > 0 && stats.hits * 2 < max_possible {
            log::warn!(
                "Blueprint hit rate low: {}/{} (entries={}, misses={})",
                stats.hits, max_possible, stats.entries_total, stats.misses
            );
            Some(format!(
                "Blueprint-Daten passen nur teilweise zur installierten SC-Version ({} von {} möglichen Treffern). Mission-Markierungen sind eventuell unvollständig.",
                stats.hits,
                max_possible
            ))
        } else {
            None
        };

        (merged, bp_patch)
    } else {
        let _ = app.emit("localization-progress", LocalizationProgress {
            phase: "install".to_string(),
            percent: 75.0,
            message: "Installing translation file...".to_string(),
        });
        (global_ini_text, None)
    };

    // Create target directory and save translation file
    let loc_dir = sc_localization_dir(&expanded, &version, &language_code)?;
    fs
        ::create_dir_all(&loc_dir)
        .map_err(|e| format!("Failed to create localization directory: {}", e))?;

    let ini_path = loc_dir.join("global.ini");
    // Atomic write: write to a sibling .tmp file, then rename. Prevents the SC
    // launcher / EAC from ever observing a half-written file. rename() on the
    // same filesystem (the install dir) is atomic on POSIX.
    let tmp_path = loc_dir.join("global.ini.tmp");
    fs::write(&tmp_path, final_ini_text.as_bytes())
        .map_err(|e| format!("Failed to write global.ini.tmp: {}", e))?;
    if let Err(e) = fs::rename(&tmp_path, &ini_path) {
        let _ = fs::remove_file(&tmp_path);
        return Err(format!("Failed to atomically install global.ini: {}", e));
    }

    // Update USER.cfg so Star Citizen uses the new language
    update_user_cfg_language(&expanded, &version, &language_code)?;

    // Fetch commit information from GitHub (errors are tolerated as this is not critical)
    let commit_info = fetch_github_commit_info(client, &source_repo, &language_code, &version, variant.as_deref())
        .await
        .ok();

    // Save installation metadata locally (for status display and update checking)
    let now = Local::now();
    let meta = LocalizationMeta {
        language_code: language_code.clone(),
        language_name: language_name.clone(),
        source_label: source_label.clone(),
        installed_at: now.format("%Y-%m-%d %H:%M:%S").to_string(),
        file_size,
        commit_sha: commit_info.as_ref().map(|(sha, _)| sha.clone()),
        commit_date: commit_info.as_ref().map(|(_, date)| date.clone()),
        source_repo: Some(source_repo.clone()),
        variant: variant.clone(),
        blueprints_installed: Some(inject_blueprints),
        blueprints_version: bp_patch_for_meta,
    };
    save_meta(&version, &meta)?;

    let _ = app.emit("localization-progress", LocalizationProgress {
        phase: "done".to_string(),
        percent: 100.0,
        message: "Installation complete!".to_string(),
    });

    Ok(LocalizationInstallResult {
        success: true,
        message: format!("{} translation installed successfully", language_name),
        bytes: file_size,
        bp_warning: bp_low_hit_rate_warning,
    })
}

/// Fetches remote information (latest commit) for all available languages.
///
/// Uses a local cache with a TTL of 30 minutes to minimize
/// the number of GitHub API calls. Can be forced to ignore the cache
/// and fetch fresh data via `force_refresh`.
///
/// Results are deduplicated - each unique combination of
/// repository and language code is only queried once.
#[tauri::command]
pub async fn fetch_remote_language_info(
    force_refresh: bool,
) -> Result<Vec<RemoteLanguageInfo>, String> {
    // Check the cache first - if it is still fresh, use it
    if !force_refresh {
        if let Some(cache) = load_remote_cache() {
            if is_cache_fresh(&cache, 30) {
                return Ok(cache.entries);
            }
        }
    }

    let languages = get_available_languages_sync();
    let client = http_client();
    let mut entries = Vec::new();

    // Deduplication: each unique (source_repo, language_code, variant) triple
    // only needs one API call
    let mut seen = std::collections::HashSet::new();
    for lang in &languages {
        let key = format!("{}:{}:{}", lang.source_repo, lang.language_code, lang.variant.as_deref().unwrap_or(""));
        if !seen.insert(key) {
            continue;
        }

        // Use "LIVE" as the default version for remote fetching
        match fetch_github_commit_info(client, &lang.source_repo, &lang.language_code, "LIVE", lang.variant.as_deref())
            .await
        {
            Ok((sha, date)) => {
                entries.push(RemoteLanguageInfo {
                    source_repo: lang.source_repo.clone(),
                    language_code: lang.language_code.clone(),
                    commit_sha: sha,
                    commit_date: date,
                    fetched_at: chrono::Utc::now().to_rfc3339(),
                    variant: lang.variant.clone(),
                });
            }
            Err(e) => {
                log::warn!(
                    "Failed to fetch commit info for {}/{} (variant: {:?}): {}",
                    lang.source_repo,
                    lang.language_code,
                    lang.variant,
                    e
                );
            }
        }
    }

    // Save cache with the new results
    let cache = RemoteCache {
        entries: entries.clone(),
        last_fetched: Some(chrono::Utc::now().to_rfc3339()),
    };
    let _ = save_remote_cache(&cache);

    Ok(entries)
}

// ============================================================
// Blueprint injection (experimental)
// ============================================================

/// Root of the bp-contracts_short.json file (as published by rjcncpt's launcher tooling).
#[derive(Deserialize)]
struct BpContractsRoot {
    _meta: serde_json::Value,
    entries: Vec<BpEntry>,
}

/// One blueprint entry — describes how to modify the mission's title and description.
#[derive(Deserialize)]
#[allow(non_snake_case)] // field names match the JSON shape
struct BpEntry {
    titleLocKey: String,
    title: String,
    descriptionLocKey: String,
    description: String,
}

/// Statistics about a blueprint injection pass — exposed to the install flow so
/// it can warn the user when the BP data is a poor match for the installed SC build.
pub(crate) struct BpInjectStats {
    /// Number of (title or description) keys actually found and modified.
    pub hits: usize,
    /// Number of (title or description) keys that were absent in the INI and skipped.
    pub misses: usize,
    /// Number of entries in the BP JSON. Maximum possible `hits` is `2 * entries_total`.
    pub entries_total: usize,
}

/// Thin wrapper that drops the stats — kept as a stable signature for unit tests.
#[cfg(test)]
pub(crate) fn inject_blueprints(
    global_ini_text: &str,
    bp_contracts_json: &str,
) -> Result<String, String> {
    inject_blueprints_with_stats(global_ini_text, bp_contracts_json).map(|(text, _)| text)
}

/// Merges blueprint markers and description blocks from the rjcncpt JSON
/// into a global.ini file. Pure filesystem-free logic.
///
/// For each entry whose `titleLocKey` matches a key in the INI, the entry's `title`
/// string is **prepended** to the existing value. For each entry whose
/// `descriptionLocKey` matches, the entry's `description` is **appended** to the
/// existing value. Entries whose keys are absent in the INI are silently skipped
/// (logged at debug level). Comments, blank lines, and original line order are
/// preserved verbatim. Backslash-n sequences in JSON (`\\n` → literal `\n`) round-trip
/// into the INI as the literal two-character sequence — Star Citizen's runtime
/// parser handles the conversion to actual newlines.
///
/// Returns the merged text plus statistics about how well the BP data matched the
/// INI's keyspace — the caller can decide to warn the user on low hit rates.
pub(crate) fn inject_blueprints_with_stats(
    global_ini_text: &str,
    bp_contracts_json: &str,
) -> Result<(String, BpInjectStats), String> {
    let bp: BpContractsRoot = serde_json::from_str(bp_contracts_json)
        .map_err(|e| format!("Failed to parse blueprint JSON: {}", e))?;

    // Parse the INI as a Vec<Line> preserving everything verbatim except modified values.
    enum Line {
        KeyValue { key: String, separator: String, value: String },
        Verbatim(String),
    }

    // Split into lines, preserving line endings absent — we'll re-join with '\n'.
    let mut lines: Vec<Line> = global_ini_text
        .split('\n')
        .map(|raw| {
            // Empty trailing line from trailing '\n' becomes Verbatim("")
            // Comment lines start with ';' or '#' — keep verbatim
            let trimmed_start = raw.trim_start();
            if trimmed_start.is_empty() || trimmed_start.starts_with(';') || trimmed_start.starts_with('#') || trimmed_start.starts_with('[') {
                return Line::Verbatim(raw.to_string());
            }
            // Find the first '=' — split into key and value preserving whitespace around it
            if let Some(eq_pos) = raw.find('=') {
                let key = raw[..eq_pos].to_string();
                let value = raw[eq_pos + 1..].to_string();
                Line::KeyValue {
                    key,
                    separator: "=".to_string(),
                    value,
                }
            } else {
                Line::Verbatim(raw.to_string())
            }
        })
        .collect();

    // Build key → index lookup. If the same key appears more than once, the first wins.
    let mut key_to_idx = std::collections::HashMap::<String, usize>::new();
    for (i, line) in lines.iter().enumerate() {
        if let Line::KeyValue { key, .. } = line {
            key_to_idx.entry(key.clone()).or_insert(i);
        }
    }

    let mut hits = 0_usize;
    let mut misses = 0_usize;
    for entry in &bp.entries {
        if let Some(&idx) = key_to_idx.get(&entry.titleLocKey) {
            if let Line::KeyValue { value, .. } = &mut lines[idx] {
                let new_value = format!("{}{}", entry.title, value);
                *value = new_value;
                hits += 1;
            }
        } else {
            misses += 1;
            log::debug!("Blueprint titleLocKey not found in INI: {}", entry.titleLocKey);
        }
        if let Some(&idx) = key_to_idx.get(&entry.descriptionLocKey) {
            if let Line::KeyValue { value, .. } = &mut lines[idx] {
                let new_value = format!("{}{}", value, entry.description);
                *value = new_value;
                hits += 1;
            }
        } else {
            misses += 1;
            log::debug!("Blueprint descriptionLocKey not found in INI: {}", entry.descriptionLocKey);
        }
    }
    log::info!(
        "Blueprint injection: {} hits, {} misses across {} entries",
        hits,
        misses,
        bp.entries.len()
    );

    // Serialize back: each Line becomes its raw form, joined with '\n'.
    let mut out = String::with_capacity(global_ini_text.len() + 4096);
    for (i, line) in lines.iter().enumerate() {
        match line {
            Line::KeyValue { key, separator, value } => {
                out.push_str(key);
                out.push_str(separator);
                out.push_str(value);
            }
            Line::Verbatim(raw) => {
                out.push_str(raw);
            }
        }
        // Append '\n' between lines (but not after the last "line", because the original
        // had a trailing '\n' which produced an empty final element via .split('\n')).
        if i + 1 < lines.len() {
            out.push('\n');
        }
    }

    let stats = BpInjectStats {
        hits,
        misses,
        entries_total: bp.entries.len(),
    };
    Ok((out, stats))
}

/// Result of the BP compatibility pre-check.
/// Returned to the install modal so the user sees what SC patch the BP data targets.
#[derive(Serialize, Deserialize, Clone)]
pub struct BpCompat {
    /// Patch identifier from blueprints/version.json `version` field
    /// (e.g. "4.7.2-live.11674325"). None if the file could not be fetched/parsed.
    pub bp_patch: Option<String>,
    /// Human-readable BP version label from bp-contracts_short.json `_meta.version`
    /// (e.g. "Beta 22.04.2026"). None if missing.
    pub bp_version: Option<String>,
}

/// Fetches the blueprint version metadata from upstream so the install modal can
/// show the user which SC patch the data was generated for. Read-only; never writes.
#[tauri::command]
pub async fn check_blueprints_compat() -> Result<BpCompat, String> {
    let client = http_client();
    let bp_url = "https://raw.githubusercontent.com/rjcncpt/StarCitizen-Deutsch-INI/main/blueprints/Data/bp-contracts_short.json";
    let version_url = "https://raw.githubusercontent.com/rjcncpt/StarCitizen-Deutsch-INI/main/blueprints/version.json";

    let (ver_resp, bp_resp) = tokio::join!(
        client.get(version_url).send(),
        client.get(bp_url).send(),
    );

    let bp_patch = match ver_resp {
        Ok(r) => match r.text().await {
            Ok(text) => serde_json::from_str::<serde_json::Value>(&text)
                .ok()
                .and_then(|v| v.get("version").and_then(|x| x.as_str()).map(String::from)),
            Err(_) => None,
        },
        Err(_) => None,
    };

    let bp_version = match bp_resp {
        Ok(r) => match r.text().await {
            Ok(text) => serde_json::from_str::<serde_json::Value>(&text)
                .ok()
                .and_then(|v| v.get("_meta").and_then(|m| m.get("version")).and_then(|x| x.as_str()).map(String::from)),
            Err(_) => None,
        },
        Err(_) => None,
    };

    Ok(BpCompat { bp_patch, bp_version })
}

#[cfg(test)]
mod blueprint_inject_tests {
    use super::*;

    /// Helper to build a small global.ini fixture
    fn ini(lines: &[&str]) -> String {
        lines.join("\n") + "\n"
    }

    #[test]
    fn inject_appends_description_when_key_present() {
        let global_ini = ini(&[
            "headhunters_eliminateall_cfp_M_desc_001=Original description",
            "other_key=other value",
        ]);
        let bp_json = r#"{
            "_meta": {"version_patch": "4.7.2"},
            "entries": [
                {
                    "titleLocKey": "missing_title_key",
                    "title": " <EM4>[BP]</EM4>",
                    "descriptionLocKey": "headhunters_eliminateall_cfp_M_desc_001",
                    "description": "\\n---\\n<EM4>BP info</EM4>"
                }
            ]
        }"#;
        let result = inject_blueprints(&global_ini, bp_json).unwrap();
        assert!(result.contains("headhunters_eliminateall_cfp_M_desc_001=Original description\\n---\\n<EM4>BP info</EM4>"));
        assert!(result.contains("other_key=other value"));
    }

    #[test]
    fn inject_prepends_title_when_key_present() {
        let global_ini = ini(&[
            "mission_title=Eliminate Targets",
        ]);
        let bp_json = r#"{
            "_meta": {},
            "entries": [
                {
                    "titleLocKey": "mission_title",
                    "title": " <EM4>[BP]</EM4>",
                    "descriptionLocKey": "absent",
                    "description": ""
                }
            ]
        }"#;
        let result = inject_blueprints(&global_ini, bp_json).unwrap();
        assert!(result.contains("mission_title= <EM4>[BP]</EM4>Eliminate Targets"));
    }

    #[test]
    fn inject_skips_unknown_keys() {
        let global_ini = ini(&[
            "real_key=real value",
        ]);
        let bp_json = r#"{
            "_meta": {},
            "entries": [
                {
                    "titleLocKey": "phantom_title",
                    "title": " <EM4>[BP]</EM4>",
                    "descriptionLocKey": "phantom_desc",
                    "description": "stuff"
                }
            ]
        }"#;
        let result = inject_blueprints(&global_ini, bp_json).unwrap();
        // Real value untouched, no spurious lines added
        assert_eq!(result.trim_end(), "real_key=real value");
    }

    #[test]
    fn inject_preserves_original_line_order_and_comments() {
        let global_ini = "; header comment\n\nfirst_key=first\nsecond_key=second\n; trailing comment\nthird_key=third\n";
        let bp_json = r#"{
            "_meta": {},
            "entries": [
                {
                    "titleLocKey": "second_key",
                    "title": "[BP] ",
                    "descriptionLocKey": "absent",
                    "description": ""
                }
            ]
        }"#;
        let result = inject_blueprints(global_ini, bp_json).unwrap();
        // Comment lines and blank line must remain in place; relative order unchanged
        let lines: Vec<&str> = result.lines().collect();
        assert_eq!(lines[0], "; header comment");
        assert_eq!(lines[1], "");
        assert_eq!(lines[2], "first_key=first");
        assert_eq!(lines[3], "second_key=[BP] second");
        assert_eq!(lines[4], "; trailing comment");
        assert_eq!(lines[5], "third_key=third");
    }

    #[test]
    fn inject_preserves_backslash_n_literals() {
        // The JSON source contains "\\n" which serde decodes to literal two chars: backslash + n.
        // Those must NOT be interpreted as newlines during merge — they must round-trip into the INI value as the literal two chars.
        let global_ini = ini(&["mission_desc=Base desc"]);
        let bp_json = r#"{
            "_meta": {},
            "entries": [
                {
                    "titleLocKey": "absent_title",
                    "title": "",
                    "descriptionLocKey": "mission_desc",
                    "description": "\\n--SEP--\\nMore"
                }
            ]
        }"#;
        let result = inject_blueprints(&global_ini, bp_json).unwrap();
        // The output line must contain the literal sequence backslash+n (two chars), not an actual newline within the value
        let target_line = result.lines().find(|l| l.starts_with("mission_desc=")).expect("line exists");
        assert_eq!(target_line, r"mission_desc=Base desc\n--SEP--\nMore");
    }

    #[test]
    fn inject_handles_empty_entries_array_as_noop() {
        let global_ini = ini(&[
            "alpha=1",
            "beta=2",
        ]);
        let bp_json = r#"{"_meta":{},"entries":[]}"#;
        let result = inject_blueprints(&global_ini, bp_json).unwrap();
        // Should round-trip (modulo trailing newline normalization)
        assert!(result.contains("alpha=1"));
        assert!(result.contains("beta=2"));
    }
}

/// Completely removes an installed localization.
///
/// Performs the following cleanup steps:
/// 1. Deletes the global.ini translation file
/// 2. Removes the language directory (if empty)
/// 3. Removes the language settings from USER.cfg
/// 4. Deletes the stored metadata
///
/// Also works with manually installed translations (without metadata)
/// by reading the language from USER.cfg.
#[tauri::command]
pub async fn remove_localization(game_path: String, version: String) -> Result<(), String> {
    let expanded = expand_tilde(&game_path);

    // Determine language code - first from metadata, then from USER.cfg as fallback
    let language_code = if let Some(meta) = load_meta(&version) {
        meta.language_code
    } else {
        // Fallback: read from USER.cfg
        let cfg_path = sc_base_dir(&expanded, &version)?.join("USER.cfg");
        if cfg_path.exists() {
            let content = fs::read_to_string(&cfg_path).unwrap_or_default();
            parse_cfg_value(&content, "g_language").ok_or_else(||
                "No localization found to remove".to_string()
            )?
        } else {
            return Err("No localization found to remove".to_string());
        }
    };

    // Delete translation file
    let ini_path = sc_localization_dir(&expanded, &version, &language_code)?.join("global.ini");
    if ini_path.exists() {
        fs::remove_file(&ini_path).map_err(|e| format!("Failed to delete global.ini: {}", e))?;
    }

    // Remove language directory if empty (error is ignored if not empty)
    let lang_dir = sc_localization_dir(&expanded, &version, &language_code)?;
    if lang_dir.exists() {
        let _ = fs::remove_dir(&lang_dir); // Ignore error if not empty
    }

    // Remove language settings from USER.cfg
    remove_user_cfg_language(&expanded, &version)?;

    // Delete local metadata
    delete_meta(&version)?;

    Ok(())
}
