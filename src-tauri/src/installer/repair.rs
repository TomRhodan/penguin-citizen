use crate::runners::resolve_wine_bin;
use crate::util::expand_tilde;
use serde::{ Deserialize, Serialize };
use std::path::{ Path, PathBuf };
use std::process::Command;
use tauri::{ AppHandle, Emitter };

use super::is_game_running;

// ── Launcher Repair ──────────────────────────────────────────────────

/// Information about an existing repair backup.
#[derive(Serialize, Deserialize, Clone)]
pub struct RepairBackupInfo {
    /// Full path to the backup directory
    pub path: String,
    /// Total size in bytes (approximate, top-level only for speed)
    pub size_bytes: u64,
    /// Timestamp extracted from the folder name (e.g. "20260406_143022")
    pub created: String,
}

/// Prepares a repair by renaming the current Wine prefix to a timestamped backup.
///
/// After this, the frontend navigates the user through the normal installation
/// wizard (pick runner, install). Once installation completes, the frontend
/// calls `restore_sc_data` to move game data from the backup into the new prefix.
///
/// Returns the backup path on success.
#[tauri::command]
pub async fn repair_installation(app: AppHandle) -> Result<String, String> {
    let config = crate::config::load_config().await
        .map_err(|e| format!("Failed to load config: {}", e))?
        .ok_or("No configuration found")?;

    let install_path = expand_tilde(&config.install_path);

    if is_game_running() {
        return Err("Cannot repair while the game is running. Please stop it first.".into());
    }

    // Kill wineserver to clean up orphaned processes
    log::info!("Repair: killing wineserver...");
    let runner_name = config.selected_runner.as_deref();
    if let Some(name) = runner_name {
        let runner_dir = Path::new(&install_path).join("runners").join(name);
        if let Some(wine) = resolve_wine_bin(&runner_dir) {
            let wineserver = wine.with_file_name("wineserver");
            if wineserver.exists() {
                let _ = Command::new(wineserver.to_string_lossy().as_ref())
                    .arg("-k")
                    .env("WINEPREFIX", &install_path)
                    .output();
            }
        }
    }

    // Rename prefix to backup
    let timestamp = chrono::Local::now().format("%Y%m%d_%H%M%S").to_string();
    let install_dir = PathBuf::from(&install_path);
    let parent = install_dir.parent()
        .ok_or("Cannot determine parent directory of install path")?;
    let dir_name = install_dir.file_name()
        .ok_or("Cannot determine directory name of install path")?
        .to_string_lossy();
    let backup_name = format!("{}_repair_backup_{}", dir_name, timestamp);
    let backup_path = parent.join(&backup_name);

    log::info!("Repair: renaming {} -> {}", install_dir.display(), backup_path.display());
    std::fs::rename(&install_dir, &backup_path)
        .map_err(|e| format!("Failed to rename prefix to backup: {}", e))?;

    let _ = app.emit("repair-backup-created", backup_path.to_string_lossy().to_string());
    log::info!("Repair: prefix renamed to backup. User can now run a fresh installation.");

    Ok(backup_path.to_string_lossy().to_string())
}

/// Restores Star Citizen game data from a repair backup into the current installation.
///
/// Called by the frontend after a successful fresh installation completes.
/// Moves the `StarCitizen` folder from the backup's RSI directory into the
/// new installation's RSI directory.
#[tauri::command]
pub async fn restore_sc_data(backup_path: String, install_path: String) -> Result<(), String> {
    let install_path = expand_tilde(&install_path);
    let backup = PathBuf::from(&backup_path);
    let install_dir = PathBuf::from(&install_path);

    let sc_folder_name = "StarCitizen";
    let rsi_base = PathBuf::from("drive_c")
        .join("Program Files")
        .join("Roberts Space Industries");
    let sc_src = backup.join(&rsi_base).join(sc_folder_name);
    let sc_dst = install_dir.join(&rsi_base).join(sc_folder_name);

    if !sc_src.exists() {
        log::info!("No StarCitizen folder found in backup, skipping restore");
        return Ok(());
    }

    // Remove the empty SC dir in the new install if it exists
    if sc_dst.exists() {
        let _ = std::fs::remove_dir_all(&sc_dst);
    }

    log::info!("Restoring StarCitizen data: {} -> {}", sc_src.display(), sc_dst.display());
    std::fs::rename(&sc_src, &sc_dst)
        .map_err(|e| format!(
            "Failed to move StarCitizen folder: {}. Please copy manually from: {}",
            e, sc_src.display()
        ))?;

    Ok(())
}

/// Checks whether a repair backup exists next to the installation directory.
/// Returns info about the most recent backup if found.
#[tauri::command]
pub async fn check_repair_backup(install_path: String) -> Result<Option<RepairBackupInfo>, String> {
    let install_path = expand_tilde(&install_path);
    let install_dir = PathBuf::from(&install_path);
    let parent = install_dir.parent()
        .ok_or("Cannot determine parent directory")?;
    let dir_name = install_dir.file_name()
        .ok_or("Cannot determine directory name")?
        .to_string_lossy();

    let prefix = format!("{}_repair_backup_", dir_name);

    let mut best: Option<RepairBackupInfo> = None;

    if let Ok(entries) = std::fs::read_dir(parent) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if !name.starts_with(&prefix) {
                continue;
            }
            if !entry.path().is_dir() {
                continue;
            }
            let timestamp = name.strip_prefix(&prefix).unwrap_or("").to_string();

            // Calculate approximate size (non-recursive for speed)
            let size = dir_size_approx(&entry.path());

            let info = RepairBackupInfo {
                path: entry.path().to_string_lossy().to_string(),
                size_bytes: size,
                created: timestamp.clone(),
            };

            // Keep the most recent backup (lexicographic comparison on timestamp)
            if best.as_ref().is_none_or(|b| timestamp > b.created) {
                best = Some(info);
            }
        }
    }

    Ok(best)
}

/// Deletes a repair backup directory after validation.
/// Safety checks prevent misuse (path must contain `_repair_backup_`
/// and must be in the same parent directory as the install path).
#[tauri::command]
pub async fn delete_repair_backup(backup_path: String, install_path: String) -> Result<(), String> {
    let install_path = expand_tilde(&install_path);
    let backup = PathBuf::from(&backup_path);
    let install_dir = PathBuf::from(&install_path);

    // Validation: backup name must contain the marker
    let backup_name = backup.file_name()
        .ok_or("Invalid backup path")?
        .to_string_lossy();
    if !backup_name.contains("_repair_backup_") {
        return Err("Invalid backup path: does not look like a repair backup.".into());
    }

    // Validation: same parent directory
    let backup_parent = backup.parent().ok_or("Cannot determine backup parent")?;
    let install_parent = install_dir.parent().ok_or("Cannot determine install parent")?;
    if backup_parent != install_parent {
        return Err("Invalid backup path: not in the same directory as the installation.".into());
    }

    // Validation: must exist and be a directory
    if !backup.is_dir() {
        return Err("Backup directory does not exist.".into());
    }

    log::info!("Deleting repair backup: {}", backup.display());
    tokio::fs::remove_dir_all(&backup).await
        .map_err(|e| format!("Failed to delete backup: {}", e))?;

    Ok(())
}

/// Calculates the approximate size of a directory (recursive).
/// Returns 0 on errors rather than failing.
fn dir_size_approx(path: &Path) -> u64 {
    let mut total: u64 = 0;
    if let Ok(entries) = std::fs::read_dir(path) {
        for entry in entries.flatten() {
            let ft = entry.file_type();
            if let Ok(ft) = ft {
                if ft.is_file() {
                    total += entry.metadata().map(|m| m.len()).unwrap_or(0);
                } else if ft.is_dir() {
                    total += dir_size_approx(&entry.path());
                }
            }
        }
    }
    total
}
