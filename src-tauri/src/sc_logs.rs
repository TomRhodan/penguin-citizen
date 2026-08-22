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

//! Collects the log files that matter when Star Citizen misbehaves.
//!
//! Troubleshooting a failed launch always starts with the same handful of
//! files, spread across the Wine prefix and our own config directory. Finding
//! them by hand is tedious - the Easy Anti-Cheat log in particular sits behind
//! two ids that have to be read out of a JSON file first.
//!
//! Mirrors the "Show Logs" menu lug-helper added in v4.14.

use serde::{ Deserialize, Serialize };
use std::path::{ Path, PathBuf };

use crate::util::expand_tilde;

/// One log file offered to the user.
#[derive(Serialize, Deserialize, Clone)]
pub struct LogEntry {
    /// Stable id, used by the frontend to pick a translated label
    pub id: String,
    /// Absolute path to the file
    pub path: String,
    /// Whether the file is present. Entries are returned either way so the UI
    /// can show that a log simply has not been written yet.
    pub exists: bool,
    /// Size in bytes, 0 when the file does not exist
    pub size_bytes: u64,
    /// Last modification as a Unix timestamp, `None` when unavailable
    pub modified: Option<u64>,
}

impl LogEntry {
    /// Builds an entry, filling in size and mtime when the file is there.
    fn new(id: &str, path: PathBuf) -> Self {
        let meta = std::fs::metadata(&path).ok();
        let exists = meta.is_some();
        let size_bytes = meta.as_ref().map(|m| m.len()).unwrap_or(0);
        let modified = meta
            .as_ref()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs());

        Self {
            id: id.to_string(),
            path: path.to_string_lossy().into_owned(),
            exists,
            size_bytes,
            modified,
        }
    }
}

/// Star Citizen release channels that can hold their own `Game.log`.
const SC_CHANNELS: &[&str] = &["LIVE", "PTU", "EPTU", "TECH-PREVIEW", "HOTFIX"];

/// Path of the RSI directory inside the prefix, where the game is installed.
const RSI_DIR: &str = "drive_c/Program Files/Roberts Space Industries";

/// The `AppData/Roaming` directory of the prefix's Wine user.
///
/// Wine names the directory after the Linux user, so the path cannot be
/// hardcoded. Falls back to scanning `drive_c/users` when `$USER` is unset or
/// the prefix was created under a different account.
fn appdata_roaming(prefix: &Path) -> Option<PathBuf> {
    let users = prefix.join("drive_c/users");

    if let Ok(user) = std::env::var("USER") {
        let candidate = users.join(&user).join("AppData/Roaming");
        if candidate.is_dir() {
            return Some(candidate);
        }
    }

    // Fall back to the first user directory that has an AppData/Roaming.
    // "public" is Wine's shared profile and never holds application data.
    std::fs
        ::read_dir(&users)
        .ok()?
        .flatten()
        .filter(|e| e.file_name().to_string_lossy() != "public")
        .map(|e| e.path().join("AppData/Roaming"))
        .find(|p| p.is_dir())
}

/// Resolves the Easy Anti-Cheat log path.
///
/// EAC writes below `AppData/Roaming/EasyAntiCheat/<productid>/<deploymentid>/`,
/// and both ids live in the game's `EasyAntiCheat/Settings.json`. Returns
/// `None` when the game has not been launched yet or CIG changed the format -
/// a missing EAC log is not an error worth failing the whole listing over.
fn eac_log_path(prefix: &Path, appdata: &Path) -> Option<PathBuf> {
    // The ids are per install, not per channel, but only channels that have
    // actually run have a Settings.json - take the first one we find.
    let settings = SC_CHANNELS.iter()
        .map(|channel|
            prefix
                .join(RSI_DIR)
                .join("StarCitizen")
                .join(channel)
                .join("EasyAntiCheat/Settings.json")
        )
        .find(|p| p.is_file())?;

    let contents = std::fs::read_to_string(&settings).ok()?;
    let json: serde_json::Value = serde_json::from_str(&contents).ok()?;
    let product_id = json.get("productid")?.as_str()?;
    let deployment_id = json.get("deploymentid")?.as_str()?;

    // Guard against a malformed Settings.json escaping the prefix
    if [product_id, deployment_id].iter().any(|id| id.is_empty() || id.contains('/') || id.contains("..")) {
        log::warn!("EAC Settings.json contains unusable ids, skipping the EAC log");
        return None;
    }

    Some(
        appdata
            .join("EasyAntiCheat")
            .join(product_id)
            .join(deployment_id)
            .join("anticheatlauncher.log")
    )
}

/// Lists the log files relevant for troubleshooting, present or not.
///
/// `base_path` is the Wine prefix. Entries that cannot exist on this system at
/// all - a `Game.log` for a channel that is not installed, the EAC log before
/// the game has ever run - are left out entirely; everything else is returned
/// with `exists` telling the UI whether there is anything to read.
#[tauri::command]
pub async fn list_sc_logs(base_path: String) -> Result<Vec<LogEntry>, String> {
    tokio::task
        ::spawn_blocking(move || {
            let prefix = PathBuf::from(expand_tilde(&base_path));
            let mut logs = Vec::new();

            // Our own logs, always listed: they exist independently of the prefix
            if let Some(config_dir) = dirs::config_dir() {
                let log_dir = config_dir.join("penguin-citizen").join("logs");
                logs.push(LogEntry::new("app", log_dir.join("debug.log")));
                // Only written while debug logging is on
                let wine_log = log_dir.join("wine.log");
                if wine_log.is_file() {
                    logs.push(LogEntry::new("wine", wine_log));
                }
            }

            // Launch script log, for prefixes created by the LUG Helper
            let lug_launch_log = prefix.join("sc-launch.log");
            if lug_launch_log.is_file() {
                logs.push(LogEntry::new("scLaunch", lug_launch_log));
            }

            if let Some(appdata) = appdata_roaming(&prefix) {
                logs.push(
                    LogEntry::new("rsiLauncher", appdata.join("rsilauncher/logs/log.log"))
                );

                if let Some(eac) = eac_log_path(&prefix, &appdata) {
                    logs.push(LogEntry::new("eac", eac));
                }
            }

            // One Game.log per installed channel
            let sc_dir = prefix.join(RSI_DIR).join("StarCitizen");
            for channel in SC_CHANNELS {
                let channel_dir = sc_dir.join(channel);
                if channel_dir.is_dir() {
                    logs.push(LogEntry::new(&format!("game:{}", channel), channel_dir.join("Game.log")));
                }
            }

            logs
        }).await
        .map_err(|e| format!("Task failed: {}", e))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// Builds a throwaway prefix under the system temp dir.
    fn temp_prefix(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("penguin-citizen-logs-test-{}", name));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn appdata_falls_back_to_the_only_user_directory() {
        let prefix = temp_prefix("appdata");
        // A profile that is not the current $USER, plus Wine's shared "public"
        fs::create_dir_all(prefix.join("drive_c/users/public")).unwrap();
        fs::create_dir_all(prefix.join("drive_c/users/steamuser/AppData/Roaming")).unwrap();

        let found = appdata_roaming(&prefix).expect("should find the steamuser profile");
        assert!(found.ends_with("steamuser/AppData/Roaming"), "{}", found.display());

        let _ = fs::remove_dir_all(&prefix);
    }

    #[test]
    fn appdata_returns_none_without_a_users_directory() {
        let prefix = temp_prefix("no-users");
        assert!(appdata_roaming(&prefix).is_none());
        let _ = fs::remove_dir_all(&prefix);
    }

    #[test]
    fn eac_path_is_built_from_the_settings_json_ids() {
        let prefix = temp_prefix("eac");
        let live = prefix.join(RSI_DIR).join("StarCitizen/LIVE/EasyAntiCheat");
        fs::create_dir_all(&live).unwrap();
        fs::write(
            live.join("Settings.json"),
            r#"{ "productid": "prod123", "deploymentid": "deploy456" }"#
        ).unwrap();

        let appdata = prefix.join("drive_c/users/tester/AppData/Roaming");
        let path = eac_log_path(&prefix, &appdata).expect("ids should resolve");
        assert!(
            path.ends_with("EasyAntiCheat/prod123/deploy456/anticheatlauncher.log"),
            "{}",
            path.display()
        );

        let _ = fs::remove_dir_all(&prefix);
    }

    #[test]
    fn eac_path_rejects_ids_that_would_escape_the_prefix() {
        let prefix = temp_prefix("eac-traversal");
        let live = prefix.join(RSI_DIR).join("StarCitizen/LIVE/EasyAntiCheat");
        fs::create_dir_all(&live).unwrap();
        fs::write(
            live.join("Settings.json"),
            r#"{ "productid": "../../..", "deploymentid": "x" }"#
        ).unwrap();

        let appdata = prefix.join("drive_c/users/tester/AppData/Roaming");
        assert!(eac_log_path(&prefix, &appdata).is_none());

        let _ = fs::remove_dir_all(&prefix);
    }

    #[test]
    fn eac_path_is_none_when_the_game_never_ran() {
        let prefix = temp_prefix("eac-missing");
        let appdata = prefix.join("drive_c/users/tester/AppData/Roaming");
        assert!(eac_log_path(&prefix, &appdata).is_none());
        let _ = fs::remove_dir_all(&prefix);
    }
}
