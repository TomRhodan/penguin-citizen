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

//! Launch Profiles — saved, switchable launch configurations.
//!
//! This module owns the CRUD operations for `LaunchProfile` records that
//! live inside `AppConfig`. Each pure mutation is exposed as a
//! `*_in(&mut AppConfig, …)` helper for direct unit testing; the matching
//! `#[tauri::command]` wrappers handle load → mutate → persist.
//!
//! ## Dirty model
//!
//! `AppConfig::launch_working_state` is the live edit buffer that
//! `launch_game` consumes. The active profile's `body` is a saved snapshot.
//! The two diverge whenever the user toggles a setting; the divergence is
//! the "dirty" state. This module never auto-commits — only an explicit
//! `update_launch_profile` call persists working_state into the active
//! profile.
//!
//! ## Switch semantics
//!
//! Switching profiles overwrites `launch_working_state`. To prevent silent
//! loss of unsaved tweaks, `switch_in` rejects with a `DIRTY:`-prefixed
//! error when the active profile is dirty and `force=false`. The frontend
//! is expected to surface a confirm dialog with three actions:
//! Save & Switch, Discard & Switch, Cancel.

use crate::config::{ensure_default_profile, AppConfig, LaunchProfile};
use crate::runners::resolve_wine_bin;
use crate::util::expand_tilde;
use serde::Serialize;
use std::path::Path;

/// Profile-and-fallback usage info for a given runner name.
///
/// Used by the Wine-Runner page to surface a meaningful "are you sure?"
/// confirm before letting the user delete a runner that is referenced by
/// existing profiles or by the global fallback.
#[derive(Serialize, Clone, Debug)]
pub struct RunnerUsageInfo {
    /// Names of profiles whose `body.runner_name` matches the queried runner.
    pub profiles: Vec<String>,
    /// Whether the queried runner is currently set as the global fallback.
    pub is_fallback: bool,
    /// Whether the queried runner is the live working-state runner
    /// (i.e. would be used on the very next launch).
    pub is_working_state: bool,
}

// ── Pure helpers (testable in-place mutations) ────────────────────────────

/// Returns whether the live working state diverges from the active profile.
///
/// Returns `false` if there is no active profile (cannot be dirty against
/// nothing). The comparison is structural via `PartialEq` derived on
/// `LaunchProfileBody` and its nested `PerformanceSettings`.
pub(crate) fn is_dirty(config: &AppConfig) -> bool {
    let Some(active) = config
        .launch_profiles
        .iter()
        .find(|p| p.id == config.active_launch_profile_id)
    else {
        return false;
    };
    active.body != config.launch_working_state
}

/// Validates a profile name. Returns the trimmed value on success.
///
/// Empty (after trim) → error. Conflicts with an existing profile of the
/// same name → error, except when `ignore_id` matches that profile (used
/// by rename to allow a no-op rename to the current name).
fn validate_profile_name(
    config: &AppConfig,
    name: &str,
    ignore_id: Option<&str>,
) -> Result<String, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("Profile name cannot be empty".to_string());
    }
    let conflict = config
        .launch_profiles
        .iter()
        .any(|p| p.name == trimmed && Some(p.id.as_str()) != ignore_id);
    if conflict {
        return Err(format!("A profile named '{}' already exists", trimmed));
    }
    Ok(trimmed.to_string())
}

/// Creates a new profile from the current `launch_working_state`.
pub(crate) fn create_profile_in(
    config: &mut AppConfig,
    name: &str,
) -> Result<LaunchProfile, String> {
    let name = validate_profile_name(config, name, None)?;
    let now = chrono::Utc::now().to_rfc3339();
    let profile = LaunchProfile {
        id: uuid::Uuid::new_v4().to_string(),
        name,
        description: None,
        created_at: now.clone(),
        updated_at: now,
        body: config.launch_working_state.clone(),
    };
    config.launch_profiles.push(profile.clone());
    Ok(profile)
}

/// Commits `launch_working_state` into the named profile. Updates `updated_at`.
pub(crate) fn update_profile_in(
    config: &mut AppConfig,
    id: &str,
) -> Result<LaunchProfile, String> {
    let working = config.launch_working_state.clone();
    let now = chrono::Utc::now().to_rfc3339();
    let profile = config
        .launch_profiles
        .iter_mut()
        .find(|p| p.id == id)
        .ok_or_else(|| format!("Profile '{}' not found", id))?;
    profile.body = working;
    profile.updated_at = now;
    Ok(profile.clone())
}

/// Discards working-state edits by copying the active profile's body back in.
pub(crate) fn revert_in(config: &mut AppConfig) -> Result<(), String> {
    let active_id = config.active_launch_profile_id.clone();
    let body = config
        .launch_profiles
        .iter()
        .find(|p| p.id == active_id)
        .ok_or_else(|| format!("Active profile '{}' not found", active_id))?
        .body
        .clone();
    config.launch_working_state = body;
    Ok(())
}

/// Switches the active profile and overwrites the working state.
///
/// If the previous profile was dirty AND `force=false`, returns an
/// `Err` whose message starts with `"DIRTY:"` so the frontend can detect
/// the case and prompt the user.
pub(crate) fn switch_in(
    config: &mut AppConfig,
    target_id: &str,
    force: bool,
) -> Result<(), String> {
    let target_body = config
        .launch_profiles
        .iter()
        .find(|p| p.id == target_id)
        .ok_or_else(|| format!("Profile '{}' not found", target_id))?
        .body
        .clone();
    if !force && is_dirty(config) {
        return Err(
            "DIRTY: Active profile has unsaved changes; pass force=true to discard."
                .to_string(),
        );
    }
    config.active_launch_profile_id = target_id.to_string();
    config.launch_working_state = target_body;
    Ok(())
}

/// Renames a profile. `new_name` must be unique except for self.
pub(crate) fn rename_in(
    config: &mut AppConfig,
    id: &str,
    new_name: &str,
) -> Result<(), String> {
    let validated = validate_profile_name(config, new_name, Some(id))?;
    let profile = config
        .launch_profiles
        .iter_mut()
        .find(|p| p.id == id)
        .ok_or_else(|| format!("Profile '{}' not found", id))?;
    profile.name = validated;
    profile.updated_at = chrono::Utc::now().to_rfc3339();
    Ok(())
}

/// Sets or clears a profile's free-text description.
///
/// Whitespace-only input is treated as `None`.
pub(crate) fn update_description_in(
    config: &mut AppConfig,
    id: &str,
    description: Option<String>,
) -> Result<(), String> {
    let profile = config
        .launch_profiles
        .iter_mut()
        .find(|p| p.id == id)
        .ok_or_else(|| format!("Profile '{}' not found", id))?;
    profile.description = description
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    profile.updated_at = chrono::Utc::now().to_rfc3339();
    Ok(())
}

/// Deletes a profile. Refuses to delete the active profile or the last one.
pub(crate) fn delete_in(config: &mut AppConfig, id: &str) -> Result<(), String> {
    if config.launch_profiles.len() <= 1 {
        return Err("Cannot delete the last profile; at least one is required".to_string());
    }
    if config.active_launch_profile_id == id {
        return Err("Cannot delete the active profile; switch to another profile first".to_string());
    }
    let initial = config.launch_profiles.len();
    config.launch_profiles.retain(|p| p.id != id);
    if config.launch_profiles.len() == initial {
        return Err(format!("Profile '{}' not found", id));
    }
    Ok(())
}

/// Creates a deep copy of an existing profile under a new name.
///
/// `id` and timestamps are fresh. The body is cloned, so post-copy
/// mutations on the source don't affect the duplicate.
pub(crate) fn duplicate_in(
    config: &mut AppConfig,
    id: &str,
    new_name: &str,
) -> Result<LaunchProfile, String> {
    let new_name = validate_profile_name(config, new_name, None)?;
    let source_body = config
        .launch_profiles
        .iter()
        .find(|p| p.id == id)
        .ok_or_else(|| format!("Profile '{}' not found", id))?
        .body
        .clone();
    let now = chrono::Utc::now().to_rfc3339();
    let profile = LaunchProfile {
        id: uuid::Uuid::new_v4().to_string(),
        name: new_name,
        description: None,
        created_at: now.clone(),
        updated_at: now,
        body: source_body,
    };
    config.launch_profiles.push(profile.clone());
    Ok(profile)
}

/// Sets or clears the global fallback runner.
///
/// If `runner` is `Some(name)` (after trim), the runner must be installed
/// under `<install_path>/runners/<name>`. Otherwise the field is cleared.
pub(crate) fn set_fallback_runner_in(
    config: &mut AppConfig,
    runner: Option<String>,
) -> Result<(), String> {
    let trimmed = runner.as_deref().map(|s| s.trim()).filter(|s| !s.is_empty());
    let Some(name) = trimmed else {
        config.fallback_runner = None;
        return Ok(());
    };
    let install_path = expand_tilde(&config.install_path);
    let dir = Path::new(&install_path).join("runners").join(name);
    if resolve_wine_bin(&dir).is_none() {
        return Err(format!("Runner '{}' is not installed", name));
    }
    config.fallback_runner = Some(name.to_string());
    Ok(())
}

/// Computes [`RunnerUsageInfo`] for the given runner name.
pub(crate) fn runner_usage_in(config: &AppConfig, runner_name: &str) -> RunnerUsageInfo {
    let profiles: Vec<String> = config
        .launch_profiles
        .iter()
        .filter(|p| p.body.runner_name == runner_name)
        .map(|p| p.name.clone())
        .collect();
    let is_fallback = config.fallback_runner.as_deref() == Some(runner_name);
    let is_working_state = config.launch_working_state.runner_name == runner_name;
    RunnerUsageInfo {
        profiles,
        is_fallback,
        is_working_state,
    }
}

// ── Tauri command wrappers ────────────────────────────────────────────────

/// Loads the AppConfig (or default if none) and ensures the profile invariants.
async fn load_or_default() -> Result<AppConfig, String> {
    let opt = crate::config::load_config()
        .await
        .map_err(|e| e.to_string())?;
    let mut config = opt.unwrap_or_default();
    ensure_default_profile(&mut config);
    Ok(config)
}

/// Persists the AppConfig via the existing `save_config` command (which
/// re-runs validation, merge, and `ensure_default_profile`).
async fn persist(config: AppConfig) -> Result<(), String> {
    crate::config::save_config(config)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn create_launch_profile(name: String) -> Result<LaunchProfile, String> {
    let mut config = load_or_default().await?;
    let profile = create_profile_in(&mut config, &name)?;
    persist(config).await?;
    Ok(profile)
}

#[tauri::command]
pub async fn update_launch_profile(id: String) -> Result<LaunchProfile, String> {
    let mut config = load_or_default().await?;
    let profile = update_profile_in(&mut config, &id)?;
    persist(config).await?;
    Ok(profile)
}

#[tauri::command]
pub async fn revert_launch_working_state() -> Result<(), String> {
    let mut config = load_or_default().await?;
    revert_in(&mut config)?;
    persist(config).await
}

#[tauri::command]
pub async fn switch_launch_profile(id: String, force: bool) -> Result<(), String> {
    let mut config = load_or_default().await?;
    switch_in(&mut config, &id, force)?;
    persist(config).await
}

#[tauri::command]
pub async fn rename_launch_profile(id: String, new_name: String) -> Result<(), String> {
    let mut config = load_or_default().await?;
    rename_in(&mut config, &id, &new_name)?;
    persist(config).await
}

#[tauri::command]
pub async fn update_profile_description(
    id: String,
    description: Option<String>,
) -> Result<(), String> {
    let mut config = load_or_default().await?;
    update_description_in(&mut config, &id, description)?;
    persist(config).await
}

#[tauri::command]
pub async fn delete_launch_profile(id: String) -> Result<(), String> {
    let mut config = load_or_default().await?;
    delete_in(&mut config, &id)?;
    persist(config).await
}

#[tauri::command]
pub async fn duplicate_launch_profile(
    id: String,
    new_name: String,
) -> Result<LaunchProfile, String> {
    let mut config = load_or_default().await?;
    let profile = duplicate_in(&mut config, &id, &new_name)?;
    persist(config).await?;
    Ok(profile)
}

#[tauri::command]
pub async fn set_fallback_runner(runner_name: Option<String>) -> Result<(), String> {
    let mut config = load_or_default().await?;
    set_fallback_runner_in(&mut config, runner_name)?;
    persist(config).await
}

#[tauri::command]
pub async fn get_runner_usage(runner_name: String) -> Result<RunnerUsageInfo, String> {
    let config = load_or_default().await?;
    Ok(runner_usage_in(&config, &runner_name))
}

// ── Tests ─────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn make_config_with_profile() -> AppConfig {
        let mut config = AppConfig::default();
        config.launch_working_state.runner_name = "wine-ge-8".into();
        ensure_default_profile(&mut config);
        config
    }

    // ── is_dirty ────────────────────────────────────────────────────────

    #[test]
    fn is_dirty_false_after_creation() {
        let config = make_config_with_profile();
        assert!(!is_dirty(&config));
    }

    #[test]
    fn is_dirty_true_after_change() {
        let mut config = make_config_with_profile();
        config.launch_working_state.performance.mangohud = true;
        assert!(is_dirty(&config));
    }

    #[test]
    fn is_dirty_false_when_no_active() {
        let mut config = AppConfig::default();
        config.launch_working_state.performance.mangohud = true;
        assert!(!is_dirty(&config));
    }

    // ── create_profile_in ────────────────────────────────────────────────

    #[test]
    fn create_profile_uniqueness() {
        let mut config = make_config_with_profile();
        let _ = create_profile_in(&mut config, "Test").unwrap();
        let err = create_profile_in(&mut config, "Test").unwrap_err();
        assert!(err.contains("already exists"));
    }

    #[test]
    fn create_profile_empty_name_rejected() {
        let mut config = make_config_with_profile();
        assert!(create_profile_in(&mut config, "").is_err());
        assert!(create_profile_in(&mut config, "   ").is_err());
    }

    #[test]
    fn create_profile_trims_name() {
        let mut config = make_config_with_profile();
        let p = create_profile_in(&mut config, "  Trimmed  ").unwrap();
        assert_eq!(p.name, "Trimmed");
    }

    #[test]
    fn create_profile_uses_working_state_as_body() {
        let mut config = make_config_with_profile();
        config.launch_working_state.performance.hdr = true;
        let p = create_profile_in(&mut config, "HDR").unwrap();
        assert!(p.body.performance.hdr);
        assert_eq!(p.body.runner_name, "wine-ge-8");
    }

    #[test]
    fn create_profile_appended_to_list() {
        let mut config = make_config_with_profile();
        let initial = config.launch_profiles.len();
        create_profile_in(&mut config, "New").unwrap();
        assert_eq!(config.launch_profiles.len(), initial + 1);
    }

    // ── update_profile_in ────────────────────────────────────────────────

    #[test]
    fn update_profile_sets_updated_at_and_body() {
        let mut config = make_config_with_profile();
        let id = config.launch_profiles[0].id.clone();
        let original_updated = config.launch_profiles[0].updated_at.clone();
        std::thread::sleep(std::time::Duration::from_millis(10));
        config.launch_working_state.performance.fsr = true;
        let updated = update_profile_in(&mut config, &id).unwrap();
        assert_ne!(updated.updated_at, original_updated);
        assert!(updated.body.performance.fsr);
    }

    #[test]
    fn update_profile_unknown_id_rejected() {
        let mut config = make_config_with_profile();
        assert!(update_profile_in(&mut config, "no-such-id").is_err());
    }

    // ── revert_in ────────────────────────────────────────────────────────

    #[test]
    fn revert_restores_active_body() {
        let mut config = make_config_with_profile();
        config.launch_working_state.performance.mangohud = true;
        revert_in(&mut config).unwrap();
        assert!(!config.launch_working_state.performance.mangohud);
    }

    #[test]
    fn revert_unknown_active_returns_err() {
        let mut config = make_config_with_profile();
        config.active_launch_profile_id = "no-such-id".into();
        assert!(revert_in(&mut config).is_err());
    }

    // ── switch_in ────────────────────────────────────────────────────────

    #[test]
    fn switch_with_dirty_no_force_rejects() {
        let mut config = make_config_with_profile();
        let other = create_profile_in(&mut config, "Other").unwrap();
        config.launch_working_state.performance.mangohud = true;
        let err = switch_in(&mut config, &other.id, false).unwrap_err();
        assert!(err.starts_with("DIRTY:"), "got: {}", err);
    }

    #[test]
    fn switch_with_force_overwrites_working() {
        let mut config = make_config_with_profile();
        let other = {
            let mut other_body = config.launch_working_state.clone();
            other_body.runner_name = "wine-ge-9".into();
            let now = chrono::Utc::now().to_rfc3339();
            let id = uuid::Uuid::new_v4().to_string();
            config.launch_profiles.push(LaunchProfile {
                id: id.clone(),
                name: "Other".into(),
                description: None,
                created_at: now.clone(),
                updated_at: now,
                body: other_body,
            });
            id
        };
        // dirty against original
        config.launch_working_state.performance.mangohud = true;
        switch_in(&mut config, &other, true).unwrap();
        assert_eq!(config.active_launch_profile_id, other);
        assert_eq!(config.launch_working_state.runner_name, "wine-ge-9");
        // mangohud was discarded by the switch
        assert!(!config.launch_working_state.performance.mangohud);
    }

    #[test]
    fn switch_without_dirty_does_not_require_force() {
        let mut config = make_config_with_profile();
        let other = create_profile_in(&mut config, "Other").unwrap();
        switch_in(&mut config, &other.id, false).unwrap();
        assert_eq!(config.active_launch_profile_id, other.id);
    }

    #[test]
    fn switch_to_nonexistent_id_rejected() {
        let mut config = make_config_with_profile();
        assert!(switch_in(&mut config, "no-such-id", true).is_err());
    }

    // ── rename_in ────────────────────────────────────────────────────────

    #[test]
    fn rename_to_same_name_is_no_op() {
        let mut config = make_config_with_profile();
        let id = config.launch_profiles[0].id.clone();
        let original_name = config.launch_profiles[0].name.clone();
        rename_in(&mut config, &id, &original_name).unwrap();
        assert_eq!(config.launch_profiles[0].name, original_name);
    }

    #[test]
    fn rename_to_existing_other_name_rejected() {
        let mut config = make_config_with_profile();
        let _ = create_profile_in(&mut config, "Other").unwrap();
        let first_id = config.launch_profiles[0].id.clone();
        let err = rename_in(&mut config, &first_id, "Other").unwrap_err();
        assert!(err.contains("already exists"));
    }

    #[test]
    fn rename_validates_empty() {
        let mut config = make_config_with_profile();
        let id = config.launch_profiles[0].id.clone();
        assert!(rename_in(&mut config, &id, "  ").is_err());
    }

    #[test]
    fn rename_unknown_id_rejected() {
        let mut config = make_config_with_profile();
        assert!(rename_in(&mut config, "no-id", "X").is_err());
    }

    // ── update_description_in ────────────────────────────────────────────

    #[test]
    fn update_description_set_and_clear() {
        let mut config = make_config_with_profile();
        let id = config.launch_profiles[0].id.clone();
        update_description_in(&mut config, &id, Some("hello".into())).unwrap();
        assert_eq!(
            config.launch_profiles[0].description.as_deref(),
            Some("hello")
        );
        update_description_in(&mut config, &id, None).unwrap();
        assert!(config.launch_profiles[0].description.is_none());
    }

    #[test]
    fn update_description_whitespace_treated_as_none() {
        let mut config = make_config_with_profile();
        let id = config.launch_profiles[0].id.clone();
        update_description_in(&mut config, &id, Some("   ".into())).unwrap();
        assert!(config.launch_profiles[0].description.is_none());
    }

    #[test]
    fn update_description_trims() {
        let mut config = make_config_with_profile();
        let id = config.launch_profiles[0].id.clone();
        update_description_in(&mut config, &id, Some("  hi  ".into())).unwrap();
        assert_eq!(config.launch_profiles[0].description.as_deref(), Some("hi"));
    }

    // ── delete_in ────────────────────────────────────────────────────────

    #[test]
    fn delete_active_profile_rejected() {
        let mut config = make_config_with_profile();
        let _ = create_profile_in(&mut config, "Other").unwrap();
        let active_id = config.active_launch_profile_id.clone();
        let err = delete_in(&mut config, &active_id).unwrap_err();
        assert!(err.contains("active"));
    }

    #[test]
    fn delete_last_profile_rejected() {
        let mut config = make_config_with_profile();
        assert_eq!(config.launch_profiles.len(), 1);
        let id = config.launch_profiles[0].id.clone();
        let err = delete_in(&mut config, &id).unwrap_err();
        assert!(err.contains("last"));
    }

    #[test]
    fn delete_non_active_succeeds() {
        let mut config = make_config_with_profile();
        let other = create_profile_in(&mut config, "Other").unwrap();
        delete_in(&mut config, &other.id).unwrap();
        assert_eq!(config.launch_profiles.len(), 1);
    }

    #[test]
    fn delete_unknown_id_rejected() {
        let mut config = make_config_with_profile();
        let _ = create_profile_in(&mut config, "Other").unwrap();
        assert!(delete_in(&mut config, "no-such-id").is_err());
    }

    // ── duplicate_in ─────────────────────────────────────────────────────

    #[test]
    fn duplicate_creates_independent_profile() {
        let mut config = make_config_with_profile();
        let id = config.launch_profiles[0].id.clone();
        let dup = duplicate_in(&mut config, &id, "Copy").unwrap();
        assert_ne!(dup.id, id);
        assert_eq!(dup.name, "Copy");

        // Modify duplicate; source must not change
        let dup_id = dup.id.clone();
        let dup_idx = config
            .launch_profiles
            .iter()
            .position(|p| p.id == dup_id)
            .unwrap();
        config.launch_profiles[dup_idx].body.performance.mangohud = true;
        let src_idx = config
            .launch_profiles
            .iter()
            .position(|p| p.id == id)
            .unwrap();
        assert!(!config.launch_profiles[src_idx].body.performance.mangohud);
    }

    #[test]
    fn duplicate_rejects_existing_name() {
        let mut config = make_config_with_profile();
        let id = config.launch_profiles[0].id.clone();
        let original_name = config.launch_profiles[0].name.clone();
        let err = duplicate_in(&mut config, &id, &original_name).unwrap_err();
        assert!(err.contains("already exists"));
    }

    #[test]
    fn duplicate_unknown_source_rejected() {
        let mut config = make_config_with_profile();
        assert!(duplicate_in(&mut config, "no-id", "X").is_err());
    }

    #[test]
    fn duplicate_resets_timestamps() {
        let mut config = make_config_with_profile();
        let id = config.launch_profiles[0].id.clone();
        let original_created = config.launch_profiles[0].created_at.clone();
        std::thread::sleep(std::time::Duration::from_millis(10));
        let dup = duplicate_in(&mut config, &id, "Copy").unwrap();
        assert_ne!(dup.created_at, original_created);
    }

    // ── set_fallback_runner_in ───────────────────────────────────────────

    #[test]
    fn set_fallback_runner_with_none_clears() {
        let mut config = make_config_with_profile();
        config.fallback_runner = Some("foo".into());
        set_fallback_runner_in(&mut config, None).unwrap();
        assert!(config.fallback_runner.is_none());
    }

    #[test]
    fn set_fallback_runner_validates_install() {
        let tmp = tempfile::tempdir().unwrap();
        let mut config = make_config_with_profile();
        config.install_path = tmp.path().to_string_lossy().into();
        let err =
            set_fallback_runner_in(&mut config, Some("nonexistent".into())).unwrap_err();
        assert!(err.contains("not installed"));
        assert!(config.fallback_runner.is_none());
    }

    #[test]
    fn set_fallback_runner_accepts_installed() {
        let tmp = tempfile::tempdir().unwrap();
        let runner = tmp
            .path()
            .join("runners")
            .join("good-runner")
            .join("bin");
        std::fs::create_dir_all(&runner).unwrap();
        std::fs::write(runner.join("wine"), "fake").unwrap();
        let mut config = make_config_with_profile();
        config.install_path = tmp.path().to_string_lossy().into();
        set_fallback_runner_in(&mut config, Some("good-runner".into())).unwrap();
        assert_eq!(config.fallback_runner.as_deref(), Some("good-runner"));
    }

    #[test]
    fn set_fallback_runner_empty_string_clears() {
        let mut config = make_config_with_profile();
        config.fallback_runner = Some("foo".into());
        set_fallback_runner_in(&mut config, Some("   ".into())).unwrap();
        assert!(config.fallback_runner.is_none());
    }
}
