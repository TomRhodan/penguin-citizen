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

//! Shader cache management for Star Citizen.
//!
//! On Linux with Wine/Proton, Star Citizen uses two relevant shader caches:
//!
//! 1. **SC native shader cache** — compiled DirectX shader bytecode stored in
//!    `%LOCALAPPDATA%\Star Citizen\` (Wine: `drive_c/users/*/AppData/Local/Star Citizen/`)
//!
//! 2. **DXVK pipeline cache** — DirectX-to-Vulkan translation cache stored as
//!    `*.dxvk-cache` files in the game version directory
//!
//! This module provides detection, status reporting, and deletion of these caches.
//! Since SC 3.19, shader cache folders contain version numbers in their names,
//! allowing stale-cache detection by comparing with the installed game version.

use std::fs;
use std::path::{Path, PathBuf};
use serde::{Deserialize, Serialize};

use crate::util::expand_tilde;

// ── Data Structures ──

#[derive(Serialize, Deserialize, Clone)]
pub struct ShaderCacheInfo {
    /// SC version channel (e.g. "LIVE", "PTU", "EPTU", "HOTFIX")
    pub sc_version: String,
    /// Path to the SC shader cache directory (if found)
    pub sc_cache_path: Option<String>,
    /// Total size of the SC shader cache in bytes
    pub sc_cache_size_bytes: u64,
    /// Shader cache version extracted from folder names (SC 3.19+)
    pub sc_cache_version: Option<String>,
    /// Path to the DXVK pipeline cache file (if found)
    pub dxvk_cache_path: Option<String>,
    /// Size of the DXVK cache file in bytes
    pub dxvk_cache_size_bytes: u64,
    /// Last-modified timestamp of the DXVK cache (ISO 8601)
    pub dxvk_cache_modified: Option<String>,
    /// Installed game build version (from Data.p4k modification time as proxy)
    pub game_build_date: Option<String>,
    /// Whether the shader cache appears stale (version mismatch)
    pub is_stale: bool,
    /// Recommendation key: "ok", "stale", "missing", "large"
    pub recommendation: String,
    /// Human-readable recommendation message (English, frontend localizes via key)
    pub recommendation_message: String,
}

#[derive(Serialize, Deserialize)]
pub struct DeleteResult {
    /// Number of bytes freed by the deletion
    pub freed_bytes: u64,
    /// List of paths that were deleted
    pub deleted_paths: Vec<String>,
    /// List of paths that failed to delete (with error messages)
    pub failed_paths: Vec<String>,
}

// ── Helper Functions ──

/// Recursively calculates the total size of a directory in bytes.
fn dir_size(path: &Path) -> u64 {
    if !path.is_dir() {
        return 0;
    }
    let mut total: u64 = 0;
    if let Ok(entries) = fs::read_dir(path) {
        for entry in entries.flatten() {
            let p = entry.path();
            if p.is_dir() {
                total += dir_size(&p);
            } else if let Ok(meta) = p.metadata() {
                total += meta.len();
            }
        }
    }
    total
}

/// Finds the SC shader cache base directory within a Wine prefix.
///
/// Scans `{install_path}/drive_c/users/*/AppData/Local/` for a directory
/// matching "star citizen" (case-insensitive), since the Wine username varies
/// (Linux user, "steamuser" for Proton, etc.) and SC may use different casing.
fn find_sc_shader_cache_base(install_path: &str) -> Option<PathBuf> {
    let users_dir = Path::new(install_path).join("drive_c/users");
    if !users_dir.is_dir() {
        return None;
    }

    if let Ok(user_entries) = fs::read_dir(&users_dir) {
        for user_entry in user_entries.flatten() {
            let local_dir = user_entry.path().join("AppData/Local");
            if !local_dir.is_dir() {
                continue;
            }
            // Search case-insensitively for "star citizen" directory
            if let Ok(local_entries) = fs::read_dir(&local_dir) {
                for local_entry in local_entries.flatten() {
                    let name = local_entry.file_name().to_string_lossy().to_lowercase();
                    if name == "star citizen" && local_entry.path().is_dir() {
                        return Some(local_entry.path());
                    }
                }
            }
        }
    }
    None
}

/// Reads the `Branch` field from a version's `build_manifest.id` file.
///
/// Returns e.g. `"sc-alpha-4.7.0"` for LIVE or `"sc-alpha-4.7.0-hotfix"` for HOTFIX.
fn read_branch_from_manifest(version_path: &Path) -> Option<String> {
    let manifest = version_path.join("build_manifest.id");
    let content = fs::read_to_string(manifest).ok()?;
    let json: serde_json::Value = serde_json::from_str(&content).ok()?;
    json["Data"]["Branch"].as_str().map(|s| s.to_string())
}

/// Lists all shader cache subdirectories with their extracted branch names.
///
/// Shader cache folders are named like `starcitizen_(sc-alpha-4.7.0)_hash_N`.
/// Returns a list of (directory_path, branch_name) tuples.
fn list_shader_cache_entries(cache_base: &Path) -> Vec<(PathBuf, String)> {
    let mut entries = Vec::new();
    let Ok(dir) = fs::read_dir(cache_base) else { return entries };

    for entry in dir.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        // Extract branch from pattern: starcitizen_(sc-alpha-X.Y.Z...)_hash_N
        if let Some(start) = name.find('(') {
            if let Some(end) = name[start..].find(')') {
                let branch = &name[start + 1..start + end];
                entries.push((path, branch.to_string()));
            }
        }
    }
    entries
}

/// Finds the SC shader cache directory for a specific game version.
///
/// Matches shader cache subdirectories to game versions by comparing the `Branch`
/// field from `build_manifest.id` with the branch name embedded in cache folder names.
/// E.g., LIVE has branch `sc-alpha-4.7.0` which matches folder `starcitizen_(sc-alpha-4.7.0)_hash_N`.
fn find_sc_shader_cache_for_version(
    install_path: &str,
    sc_version: &str,
) -> (Option<PathBuf>, Option<String>) {
    let base = match find_sc_shader_cache_base(install_path) {
        Some(b) => b,
        None => return (None, None),
    };

    let cache_entries = list_shader_cache_entries(&base);
    if cache_entries.is_empty() {
        return (None, None);
    }

    // Read the branch from this version's build_manifest.id
    let version_path = sc_game_version_path(install_path, sc_version);
    if let Some(branch) = read_branch_from_manifest(&version_path) {
        // Find cache entries whose branch matches this version's branch
        // The cache branch might be a prefix of the manifest branch or vice versa
        // e.g., cache "sc-alpha-4.7.0" matches manifest "sc-alpha-4.7.0"
        //        cache "sc-alpha-4.7.0" does NOT match "sc-alpha-4.7.0-hotfix"
        for (path, cache_branch) in &cache_entries {
            if *cache_branch == branch {
                return (Some(path.clone()), Some(cache_branch.clone()));
            }
        }
        // Try prefix match: cache branch is a prefix of the manifest branch
        // (e.g., a hotfix branch "sc-alpha-4.7.0-hotfix" might use cache "sc-alpha-4.7.0")
        // But NOT the other way around — don't match "sc-alpha-4.7.0" to "sc-alpha-4.7.0-hotfix"
    }

    (None, None)
}

/// Finds all `.dxvk-cache` files in a game version directory.
fn find_dxvk_caches(version_path: &Path) -> Vec<PathBuf> {
    let mut caches = Vec::new();
    if let Ok(entries) = fs::read_dir(version_path) {
        for entry in entries.flatten() {
            let p = entry.path();
            if p.is_file() {
                if let Some(ext) = p.extension() {
                    if ext == "dxvk-cache" {
                        caches.push(p);
                    }
                }
            }
        }
    }
    // Also check in Bin64 subdirectory where the executable lives
    let bin64 = version_path.join("Bin64");
    if bin64.is_dir() {
        if let Ok(entries) = fs::read_dir(&bin64) {
            for entry in entries.flatten() {
                let p = entry.path();
                if p.is_file() {
                    if let Some(ext) = p.extension() {
                        if ext == "dxvk-cache" {
                            caches.push(p);
                        }
                    }
                }
            }
        }
    }
    caches
}

/// Returns the path to the SC game version directory.
/// Example: `{install_path}/drive_c/Program Files/Roberts Space Industries/StarCitizen/LIVE`
fn sc_game_version_path(install_path: &str, sc_version: &str) -> PathBuf {
    Path::new(install_path)
        .join("drive_c/Program Files/Roberts Space Industries/StarCitizen")
        .join(sc_version)
}

/// Determines the recommendation for a shader cache entry.
fn compute_recommendation(
    sc_cache_exists: bool,
    sc_cache_size: u64,
    dxvk_cache_exists: bool,
    dxvk_cache_size: u64,
    is_stale: bool,
) -> (String, String) {
    const LARGE_THRESHOLD: u64 = 5 * 1024 * 1024 * 1024; // 5 GB

    if !sc_cache_exists && !dxvk_cache_exists {
        return (
            "missing".to_string(),
            "No shader cache found. Shaders will be compiled on next launch.".to_string(),
        );
    }

    if is_stale && sc_cache_exists {
        return (
            "stale".to_string(),
            "Shader cache may be outdated. Clearing is recommended after a game update.".to_string(),
        );
    }

    let total_size = sc_cache_size + dxvk_cache_size;
    if total_size > LARGE_THRESHOLD {
        return (
            "large".to_string(),
            "Shader cache is unusually large. Consider clearing it.".to_string(),
        );
    }

    (
        "ok".to_string(),
        "Shader cache is present.".to_string(),
    )
}

// ── Tauri Commands ──

/// Returns shader cache information for all installed SC versions.
#[tauri::command]
pub async fn get_shader_cache_info(
    install_path: String,
) -> Result<Vec<ShaderCacheInfo>, String> {
    let expanded = expand_tilde(&install_path);

    // Find installed SC versions by scanning the game directory
    let sc_base = Path::new(&expanded)
        .join("drive_c/Program Files/Roberts Space Industries/StarCitizen");

    let mut results = Vec::new();

    if !sc_base.is_dir() {
        // Try alternative paths (same logic as detect_sc_versions)
        let alt_paths = vec![
            Path::new(&expanded).join("StarCitizen"),
            Path::new(&expanded).to_path_buf(),
        ];

        for alt in alt_paths {
            if alt.is_dir() {
                if let Ok(infos) = collect_cache_info(&expanded, &alt) {
                    return Ok(infos);
                }
            }
        }
        return Ok(results);
    }

    results = collect_cache_info(&expanded, &sc_base)
        .map_err(|e| format!("Failed to scan shader caches: {}", e))?;

    Ok(results)
}

/// Collects shader cache info for all version directories under the given SC base path.
///
/// Maps shader cache subdirectories to game versions by matching the `Branch` field
/// from each version's `build_manifest.id` to the branch name in cache folder names.
fn collect_cache_info(
    install_path: &str,
    sc_base: &Path,
) -> Result<Vec<ShaderCacheInfo>, String> {
    let mut results = Vec::new();

    let entries = fs::read_dir(sc_base)
        .map_err(|e| format!("Failed to read {}: {}", sc_base.display(), e))?;

    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }

        let version_name = path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned();

        // SC shader cache — matched via build_manifest.id branch
        let (sc_cache_path, sc_cache_version) =
            find_sc_shader_cache_for_version(install_path, &version_name);
        let sc_cache_size = sc_cache_path.as_ref().map_or(0, |p| dir_size(p));

        // DXVK cache (per-version, in game directory)
        let dxvk_caches = find_dxvk_caches(&path);
        let dxvk_cache_size: u64 = dxvk_caches
            .iter()
            .filter_map(|p| p.metadata().ok())
            .map(|m| m.len())
            .sum();
        let dxvk_cache_path = dxvk_caches.first().cloned();
        let dxvk_cache_modified = dxvk_cache_path
            .as_ref()
            .and_then(|p| p.metadata().ok())
            .and_then(|m| m.modified().ok())
            .map(|t| {
                let dt: chrono::DateTime<chrono::Utc> = t.into();
                dt.to_rfc3339()
            });

        // Game build date (from Data.p4k modification time as proxy)
        let game_build_date = path
            .join("Data.p4k")
            .metadata()
            .ok()
            .and_then(|m| m.modified().ok())
            .map(|t| {
                let dt: chrono::DateTime<chrono::Utc> = t.into();
                dt.to_rfc3339()
            });

        let sc_cache_exists = sc_cache_path.is_some() && sc_cache_size > 0;
        let dxvk_cache_exists = !dxvk_caches.is_empty() && dxvk_cache_size > 0;

        // Stale detection: the cache is matched to this version via branch name.
        // If a match was found, the cache is for the correct game version → not stale.
        // The cache is only stale if no branch match exists but some unmatched cache
        // remains (handled by compute_recommendation as "missing").
        let is_stale = false;

        let (recommendation, recommendation_message) = compute_recommendation(
            sc_cache_exists,
            sc_cache_size,
            dxvk_cache_exists,
            dxvk_cache_size,
            is_stale,
        );

        results.push(ShaderCacheInfo {
            sc_version: version_name,
            sc_cache_path: sc_cache_path.map(|p| p.to_string_lossy().into_owned()),
            sc_cache_size_bytes: sc_cache_size,
            sc_cache_version,
            dxvk_cache_path: dxvk_cache_path.map(|p| p.to_string_lossy().into_owned()),
            dxvk_cache_size_bytes: dxvk_cache_size,
            dxvk_cache_modified,
            game_build_date,
            is_stale,
            recommendation,
            recommendation_message,
        });
    }

    // Sort: LIVE first, then PTU, HOTFIX, others
    results.sort_by_key(|v| match v.sc_version.as_str() {
        "LIVE" => 0,
        "PTU" => 1,
        "HOTFIX" => 2,
        "EPTU" => 3,
        _ => 4,
    });

    Ok(results)
}

/// Deletes shader cache files for one or all SC versions.
///
/// - `cache_type`: `"sc"` (SC shader cache only), `"dxvk"` (DXVK cache only), or `"all"` (both)
/// - `sc_version`: A specific version (e.g. `"LIVE"`) or `"all"` for all versions
#[tauri::command]
pub async fn delete_shader_cache(
    install_path: String,
    sc_version: String,
    cache_type: String,
) -> Result<DeleteResult, String> {
    let expanded = expand_tilde(&install_path);
    let mut freed_bytes: u64 = 0;
    let mut deleted_paths: Vec<String> = Vec::new();
    let mut failed_paths: Vec<String> = Vec::new();

    // Get all cache infos to find paths
    let infos = get_shader_cache_info(install_path).await?;

    let targets: Vec<&ShaderCacheInfo> = if sc_version == "all" {
        infos.iter().collect()
    } else {
        infos.iter().filter(|i| i.sc_version == sc_version).collect()
    };

    for info in targets {
        // Delete SC shader cache
        if cache_type == "sc" || cache_type == "all" {
            if let Some(ref path_str) = info.sc_cache_path {
                let path = Path::new(path_str);
                if path.is_dir() {
                    let size = dir_size(path);
                    if let Err(e) = fs::remove_dir_all(path) {
                        log::warn!("Failed to delete SC shader cache at {}: {}", path_str, e);
                        failed_paths.push(format!("{}: {}", path_str, e));
                    } else {
                        log::info!("Deleted SC shader cache: {} ({} bytes)", path_str, size);
                        freed_bytes += size;
                        deleted_paths.push(path_str.clone());
                    }
                }
            }
        }

        // Delete DXVK cache
        if cache_type == "dxvk" || cache_type == "all" {
            if let Some(ref path_str) = info.dxvk_cache_path {
                let path = Path::new(path_str);
                if path.is_file() {
                    let size = path.metadata().map(|m| m.len()).unwrap_or(0);
                    if let Err(e) = fs::remove_file(path) {
                        log::warn!("Failed to delete DXVK cache at {}: {}", path_str, e);
                        failed_paths.push(format!("{}: {}", path_str, e));
                    } else {
                        log::info!("Deleted DXVK cache: {} ({} bytes)", path_str, size);
                        freed_bytes += size;
                        deleted_paths.push(path_str.clone());
                    }
                }
            }

            // Also delete any additional DXVK caches in the version dir
            let version_path = sc_game_version_path(&expanded, &info.sc_version);
            for cache_file in find_dxvk_caches(&version_path) {
                let cache_str = cache_file.to_string_lossy().to_string();
                if deleted_paths.contains(&cache_str) {
                    continue;
                }
                if cache_file.is_file() {
                    let size = cache_file.metadata().map(|m| m.len()).unwrap_or(0);
                    if let Err(e) = fs::remove_file(&cache_file) {
                        log::warn!("Failed to delete DXVK cache at {}: {}", cache_str, e);
                        failed_paths.push(format!("{}: {}", cache_str, e));
                    } else {
                        log::info!("Deleted DXVK cache: {} ({} bytes)", cache_str, size);
                        freed_bytes += size;
                        deleted_paths.push(cache_str);
                    }
                }
            }
        }
    }

    Ok(DeleteResult {
        freed_bytes,
        deleted_paths,
        failed_paths,
    })
}

/// Checks whether any shader cache exists for a specific SC version.
///
/// Used by the launch page to show a warning when shaders need recompilation.
/// The SC shader cache is shared (not per-version), so we check the shared cache
/// plus any DXVK cache for the given version.
#[tauri::command]
pub async fn check_shader_cache_exists(
    install_path: String,
    sc_version: String,
) -> Result<bool, String> {
    let expanded = expand_tilde(&install_path);

    // Check SC shader cache matched via build_manifest.id branch
    let (sc_cache, _) = find_sc_shader_cache_for_version(&expanded, &sc_version);
    if let Some(path) = sc_cache {
        if dir_size(&path) > 0 {
            return Ok(true);
        }
    }

    // Check DXVK cache for the specific version
    let version_path = sc_game_version_path(&expanded, &sc_version);
    let dxvk_caches = find_dxvk_caches(&version_path);
    if !dxvk_caches.is_empty() {
        return Ok(true);
    }

    Ok(false)
}
