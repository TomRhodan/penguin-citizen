/*
 * Penguin Citizen - Star Citizen Linux Manager
 * Copyright (C) 2024-2026 TomRhodan <tomrhodan@gmail.com>
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

/**
 * Profiles / Backup domain module for the Environments page.
 *
 * Manages saved profiles (backups): listing, status checks, saving,
 * loading, deleting, import banners, changes panel, and joystick
 * drag-and-drop reordering.
 *
 * @module pages/environments/profiles
 */

import { invoke } from '@tauri-apps/api/core';
import { t } from '../../i18n.js';
import { escapeHtml } from '../../utils.js';
import { confirm, showNotification } from '../../utils/dialogs.js';
import { logError } from '../../utils/error-handler.js';
import { getState, setState, lastRestoredPerVersion } from './state.js';
import { renderHint } from './utils.js';

// Cross-module imports
import { renderBindingsCollapsible, loadActionDefinitions, loadDevicesAndBindings, loadCompleteBindingList, loadExportedLayouts } from './bindings.js';
import { renderDeviceMapCollapsible } from './tuning.js';
import { loadUserCfgSettings } from './usercfg.js';

// Re-export getChangedSettingsCount from usercfg (this function logically
// belongs to the USER.cfg domain but is referenced by profile callers).
export { getChangedSettingsCount } from './usercfg.js';

// ==================== Data Loading ====================

/**
 * Loads all saved profiles (backups) for the active SC version.
 * Populates the backups state array.
 */
export async function loadBackups() {
  const { activeScVersion } = getState();
  if (!activeScVersion) {
    setState({ backups: [] });
    return;
  }
  try {
    const backups = await invoke('list_backups', { v: activeScVersion });
    setState({ backups });
  } catch (e) {
    setState({ backups: [] });
  }
}

/**
 * Checks if the active profile is in sync with SC files.
 * Populates activeProfileStatus with match/changed file info.
 */
export async function loadProfileStatus() {
  const { config, activeScVersion, lastRestoredBackupId } = getState();
  if (!config?.install_path || !activeScVersion || !lastRestoredBackupId) {
    setState({ activeProfileStatus: null });
    return;
  }
  try {
    const activeProfileStatus = await invoke('check_profile_status', {
      gp: config.install_path, v: activeScVersion, bid: lastRestoredBackupId,
    });
    setState({ activeProfileStatus });
  } catch (e) {
    setState({ activeProfileStatus: null });
  }
}

// ==================== Rendering ====================

/**
 * Builds the HTML for the active-profile header banner: profile name, sync
 * status pill, action buttons (Revert / Update Profile / Apply-to-SC), the
 * "apply explain" hint, and the changes-panel if expanded.
 *
 * Extracted so the banner can be re-rendered in place after a binding/tuning
 * mutation changes profile-vs-SC sync state, without triggering a full page
 * rebuild that would reset scroll and filters.
 */
export function buildActiveProfileHeaderHtml(activeBackup, activeProfileStatus, isDirty, activeScVersion, showChangesPanel) {
  if (!activeBackup) return '';
  const displayLabel = escapeHtml(activeBackup.label || activeBackup.created_at);
  let statusText = '';
  let statusClass = '';
  const isOutOfSync = activeProfileStatus && activeProfileStatus.files.length > 0 && !activeProfileStatus.matched;
  const showApplyButton = isDirty || isOutOfSync;

  if (isDirty) {
    statusText = t('environments:profile.unsavedChanges');
    statusClass = 'profile-status-changed';
  } else if (activeProfileStatus && activeProfileStatus.files.length > 0) {
    if (activeProfileStatus.matched) {
      statusText = t('environments:profile.inSync');
      statusClass = 'profile-status-ok';
    } else {
      const changedCount = activeProfileStatus.files.filter(f => f.status !== 'unchanged').length;
      statusText = t('environments:profile.filesChanged', { count: changedCount });
      statusClass = 'profile-status-changed';
    }
  }

  return `
    <div class="profile-active-header">
      <div class="profile-active-info">
        <span class="profile-active-label">
          <span class="profile-active-star">★</span>
          ${displayLabel}
        </span>
        ${statusText ? `<span class="${statusClass}" ${statusClass === 'profile-status-changed' ? 'id="btn-toggle-changes"' : ''}>${statusText}</span>` : ''}
      </div>
      <div class="profile-active-actions">
        ${isOutOfSync ? `
          <button class="btn btn-sm btn-ghost" id="btn-revert-changes" title="${t('environments:profile.revertTooltip')}">${t('environments:profile.revert')}</button>
          <button class="btn btn-sm" id="btn-update-profile" title="${t('environments:profile.updateProfileTooltip')}">${t('environments:profile.updateProfile')}</button>
        ` : ''}
        ${showApplyButton ? `<button class="btn btn-primary btn-sm" id="btn-apply-to-sc" title="${t('environments:profile.applyToScTooltip')}">${t('environments:profile.applyToSc', { version: escapeHtml(activeScVersion) })}</button>` : ''}
      </div>
    </div>
    ${showApplyButton ? renderHint('apply-explain', t('environments:hint.applyExplain')) : ''}
    ${showChangesPanel && activeProfileStatus && !activeProfileStatus.matched ? renderChangesPanel(activeProfileStatus.files) : ''}
  `;
}

/**
 * Re-renders the active-profile header in place, scoped to its DOM region so
 * scroll and filter state elsewhere on the page stay intact. The wrapper
 * element is identified by `data-profile-header-slot`; everything inside is
 * replaced with a fresh banner built from current state.
 *
 * Returns true if the slot was found and updated, false if the page is in a
 * state where there's nothing to refresh (no active profile, slot missing).
 */
export function refreshActiveProfileHeader() {
  const slot = document.querySelector('[data-profile-header-slot]');
  if (!slot) return false;
  const { activeScVersion, backups, lastRestoredBackupId, activeProfileStatus, showChangesPanel } = getState();
  const activeBackup = lastRestoredBackupId ? backups.find(b => b.id === lastRestoredBackupId) : null;
  const isDirty = activeBackup?.dirty === true;
  slot.innerHTML = buildActiveProfileHeaderHtml(activeBackup, activeProfileStatus, isDirty, activeScVersion, showChangesPanel);
  return true;
}


/**
 * Renders the Profile tab: active profile, profile card grid, import banner.
 * Shows the sync status (in sync / changed / unsaved changes),
 * and when a profile is loaded, also the collapsible keybinding and joystick sections.
 *
 * @param {Function} renderEnvironments - Full re-render callback (provided by caller)
 * @returns {string} HTML string for the profile tab
 */
export function renderProfileTab(renderEnvironments) {
  const {
    activeScVersion, backups, lastRestoredBackupId, activeProfileStatus,
    showChangesPanel, scVersions,
  } = getState();

  const vInfo = scVersions.find(v => v.version === activeScVersion);
  const files = [];
  if (vInfo?.has_actionmaps) files.push('actionmaps.xml');
  if (vInfo?.has_attributes) files.push('attributes.xml');
  if (vInfo?.has_usercfg) files.push('USER.cfg');

  const activeBackup = lastRestoredBackupId ? backups.find(b => b.id === lastRestoredBackupId) : null;
  const hasScFiles = files.length > 0;
  const hasProfiles = backups.length > 0;
  const isDirty = activeBackup?.dirty === true;

  // Import banner for versions with no SC files
  const importBanner = !vInfo?.has_actionmaps && scVersions.length > 1 ? `
    <div class="import-banner" id="import-banner">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <circle cx="12" cy="12" r="10"></circle>
        <line x1="12" y1="16" x2="12" y2="12"></line>
        <line x1="12" y1="8" x2="12.01" y2="8"></line>
      </svg>
      <span>${t('environments:import.noProfilesFound', { version: escapeHtml(activeScVersion) })}</span>
      <button class="btn btn-sm btn-primary" id="btn-import-banner">${t('environments:profile.importFromVersion')}</button>
      <button class="btn-icon" id="btn-import-banner-dismiss" title="${t('environments:import.dismiss')}">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
      </button>
    </div>
  ` : '';

  // === Profiles Section (always at top) ===
  let profilesSection = '';
  if (hasScFiles && !hasProfiles) {
    // Empty state: first-time user
    profilesSection = `
      <div class="sc-section profiles-section">
        <div class="profile-empty-state">
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"></path>
            <polyline points="17 21 17 13 7 13 7 21"></polyline>
            <polyline points="7 3 7 8 15 8"></polyline>
          </svg>
          <div class="profile-empty-text">
            <p><strong>${t('environments:profile.saveTitle')}</strong></p>
            <p class="text-muted">${t('environments:profile.saveDesc')}</p>
          </div>
          <div class="profile-empty-actions">
            <button class="btn btn-primary" id="btn-save-first-profile">${t('environments:profile.saveCurrentSettings')}</button>
            ${scVersions.length > 1 ? `<button class="btn btn-sm" id="btn-import-version">${t('environments:profile.importFromVersion')}</button>` : ''}
          </div>
        </div>
      </div>
    `;
  } else if (hasProfiles) {
    // Active profile header + profile cards
    let activeHeader;
    if (activeBackup) {
      activeHeader = buildActiveProfileHeaderHtml(activeBackup, activeProfileStatus, isDirty, activeScVersion, showChangesPanel);
    } else if (hasScFiles) {
      activeHeader = `
        <div class="profile-active-header profile-active-none">
          <div class="profile-active-info">
            <span class="text-muted">${t('environments:profile.noProfileLoaded')}</span>
          </div>
        </div>
      `;
    } else {
      activeHeader = '';
    }

    profilesSection = `
      <div class="sc-section profiles-section">
        ${renderHint('profiles-intro', t('environments:hint.profilesIntro'))}
        <div data-profile-header-slot>${activeHeader}</div>
        <div class="profiles-card-grid">
          ${backups.map(b => {
            const isActive = lastRestoredBackupId === b.id;
            return `
              <div class="profile-card ${isActive ? 'active' : ''}" data-backup-id="${escapeHtml(b.id)}">
                <div class="profile-card-header">
                  <span class="profile-card-name">${escapeHtml(b.label || t('environments:profile.unnamedProfile'))}</span>
                  <div class="profile-card-actions">
                    <button class="btn-icon btn-icon-rename" data-action="rename-saved-profile" data-backup-id="${escapeHtml(b.id)}" title="${t('environments:profile.rename')}">
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>
                    </button>
                    <button class="btn-icon btn-icon-danger" data-action="delete-saved-profile" data-backup-id="${escapeHtml(b.id)}" title="${t('environments:profile.delete')}">
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
                    </button>
                  </div>
                </div>
                <div class="profile-card-meta">
                  <span class="profile-card-date">${escapeHtml(b.created_at)}</span>
                  <span class="backup-type-badge ${b.backup_type}">${escapeHtml(formatProfileTypeBadge(b.backup_type))}</span>
                  ${b.device_map?.length > 0 ? `<span class="backup-devices">${t('environments:profile.device', { count: b.device_map.length })}</span>` : ''}
                  ${b.dirty ? `<span class="backup-dirty-badge">${t('environments:profile.unsaved')}</span>` : ''}
                </div>
                ${!isActive ? `<button class="btn btn-sm profile-card-load" data-action="load-profile" data-backup-id="${escapeHtml(b.id)}">${t('environments:profile.load')}</button>` : `<span class="profile-card-active-badge">${t('environments:profile.active')}</span>`}
              </div>
            `;
          }).join('')}
          <div class="profile-card profile-card-add" id="btn-save-current" title="${t('environments:profile.saveCurrentTooltip')}">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="12" y1="5" x2="12" y2="19"></line>
              <line x1="5" y1="12" x2="19" y2="12"></line>
            </svg>
            <span>${t('environments:profile.saveCurrent')}</span>
          </div>
        </div>
        ${scVersions.length > 1 ? `<div class="profiles-section-footer"><button class="btn btn-sm" id="btn-import-version">${t('environments:profile.importFromVersion')}</button></div>` : ''}
      </div>
    `;
  }

  // === Collapsible Keybindings (only when a profile is loaded) ===
  const bindingsCollapsible = activeBackup ? renderBindingsCollapsible() : '';

  // === Collapsible Devices (only when a profile is loaded) ===
  const devicesCollapsible = activeBackup ? renderDeviceMapCollapsible() : '';

  return `
    <div class="sc-version-installed">
      ${importBanner}
      ${profilesSection}
      ${bindingsCollapsible}
      ${devicesCollapsible}
    </div>
  `;
}

// ==================== Changes Panel ====================

/**
 * Renders the detail panel showing changed files between profile and SC.
 * Clickable files (status: modified) open a diff dialog.
 * @param {Array} files - Array of { file, status } objects
 * @returns {string} HTML string for the changes panel
 */
export function renderChangesPanel(files) {
  const statusOrder = { modified: 0, new: 1, deleted: 2, unchanged: 3 };
  const sorted = [...files].sort((a, b) => (statusOrder[a.status] ?? 4) - (statusOrder[b.status] ?? 4));

  return `
    <div class="profile-changes-panel">
      ${sorted.map(f => `
        <div class="profile-file-status${f.status === 'modified' ? ' file-clickable' : ''}"${f.status === 'modified' ? ` data-file="${escapeHtml(f.file)}"` : ''}>
          <span class="file-name">${escapeHtml(f.file)}</span>
          <span class="status-badge status-${f.status}">${f.status}</span>
        </div>
      `).join('')}
    </div>`;
}

// ==================== Profile/Backup Formatting ====================

/**
 * Formats the file list of a backup into a human-readable summary.
 * Counts profiles, mappings, and character presets separately.
 * @param {string[]} files - Array of file paths in the backup
 * @returns {string} Summary string (e.g. "2 profiles + 1 mapping")
 */
export function formatBackupFiles(files) {
  let profiles = 0, mappings = 0, characters = 0;
  for (const f of files) {
    if (f.startsWith('controls_mappings/')) mappings++;
    else if (f.startsWith('custom_characters/')) characters++;
    else profiles++;
  }
  const parts = [];
  if (profiles > 0) parts.push(`${profiles} profile${profiles !== 1 ? 's' : ''}`);
  if (mappings > 0) parts.push(`${mappings} mapping${mappings !== 1 ? 's' : ''}`);
  if (characters > 0) parts.push(`${characters} character${characters !== 1 ? 's' : ''}`);
  return parts.join(' + ') || '0 files';
}

/**
 * Translates the technical backup type into a human-readable badge label.
 * Handles both current and legacy backup type names.
 * @param {string} backupType - Technical type (e.g. 'manual', 'pre-import', 'auto')
 * @returns {string} Display label (e.g. 'saved', 'pre-import', 'auto-save')
 */
export function formatProfileTypeBadge(backupType) {
  const map = {
    'manual': t('environments:profile.type.saved'),
    'pre-import': t('environments:profile.type.preImport'),
    // Legacy types from older versions
    'auto': t('environments:profile.type.autoSave'),
    'auto-pre-restore': t('environments:profile.type.autoSave'),
    'auto-pre-import': t('environments:profile.type.preImport'),
    'auto-post-import': t('environments:profile.type.imported'),
  };
  return map[backupType] || backupType;
}

// ==================== Profile Actions ====================

/**
 * Creates a new profile from the current SC files.
 * Shows an inline input field for the profile name.
 * @param {Function} renderEnvironments - Full re-render callback (provided by caller)
 */
export async function saveProfile(renderEnvironments) {
  const { config, activeScVersion } = getState();
  if (!config?.install_path || !activeScVersion) return;

  // Show inline label input
  const btn = document.getElementById('btn-save-current') || document.getElementById('btn-save-first-profile');
  if (!btn) return;
  const header = btn.closest('.sc-section-header') || btn.parentElement;
  if (!header) return;

  // Check if input already shown
  if (header.querySelector('.backup-label-input-wrap')) return;

  const wrap = document.createElement('div');
  wrap.className = 'backup-label-input-wrap';
  wrap.innerHTML = `
    <input type="text" class="input backup-label-input" placeholder="${t('environments:profile.nameOptional')}" maxlength="60" aria-label="${t('environments:profile.profileName')}" />
    <button class="btn btn-sm btn-primary" id="btn-backup-confirm">${t('environments:profile.save')}</button>
    <button class="btn btn-sm" id="btn-backup-cancel">${t('environments:profile.cancel')}</button>
  `;
  header.after(wrap);
  const input = wrap.querySelector('.backup-label-input');
  input.focus();

  async function doCreate() {
    const label = input.value.trim();
    wrap.remove();
    try {
      const created = await invoke('backup_profile', {
        gp: config.install_path,
        v: activeScVersion,
        bt: 'manual',
        l: label || '',
      });
      setState({ lastRestoredBackupId: created.id });
      lastRestoredPerVersion[activeScVersion] = created.id;
      invoke('save_active_profile', { v: activeScVersion, bid: created.id }).catch(err => logError(err, 'environments:save_active_profile'));
      showNotification(t('environments:notification.profileSaved'), 'success');
      await loadBackups();
      await loadProfileStatus();
      renderEnvironments(document.getElementById('content'));
    } catch (e) {
      showNotification(t('environments:notification.saveFailed', { error: e }), 'error');
    }
  }

  wrap.querySelector('#btn-backup-confirm').addEventListener('click', doCreate);
  wrap.querySelector('#btn-backup-cancel').addEventListener('click', () => wrap.remove());
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doCreate();
    if (e.key === 'Escape') wrap.remove();
  });
}

/**
 * Loads a saved profile into Star Citizen (replaces current SC files).
 * Shows a confirmation dialog with file list.
 * @param {string} backupId - Unique identifier of the profile to load
 * @param {Function} renderEnvironments - Full re-render callback (provided by caller)
 */
export async function loadProfile(backupId, renderEnvironments) {
  const { config, activeScVersion, backups } = getState();
  if (!config?.install_path || !activeScVersion) return;
  const backup = backups.find(b => b.id === backupId);
  const displayName = backup?.label || backupId;
  const filesInfo = backup ? formatBackupFiles(backup.files) : '';
  const confirmLoad = await confirm(
    t('environments:notification.loadConfirm', { name: displayName, version: activeScVersion, files: filesInfo }),
    { title: t('environments:notification.loadTitle'), kind: 'warning' }
  );
  if (!confirmLoad) return;
  try {
    await invoke('restore_profile', {
      gp: config.install_path,
      v: activeScVersion,
      bid: backupId,
    });
    setState({ lastRestoredBackupId: backupId });
    lastRestoredPerVersion[activeScVersion] = backupId;
    invoke('save_active_profile', { v: activeScVersion, bid: backupId }).catch(err => logError(err, 'environments:save_active_profile'));
    showNotification(t('environments:notification.profileLoaded'), 'success');
    await Promise.all([loadActionDefinitions(), loadDevicesAndBindings(), loadCompleteBindingList(), loadBackups(), loadUserCfgSettings()]);
    await loadProfileStatus();
    renderEnvironments(document.getElementById('content'));
  } catch (e) {
    showNotification(t('environments:notification.loadFailed', { error: e }), 'error');
  }
}

/**
 * Deletes a saved profile after confirmation.
 * If the deleted profile was active, clears the active profile state.
 * @param {string} backupId - Unique identifier of the profile to delete
 * @param {Function} renderEnvironments - Full re-render callback (provided by caller)
 */
export async function deleteProfile(backupId, renderEnvironments) {
  const { backups, activeScVersion, lastRestoredBackupId } = getState();
  const backup = backups.find(b => b.id === backupId);
  const displayName = backup?.label || t('environments:profile.unnamedProfile');
  const confirmDelete = await confirm(t('environments:notification.deleteProfileConfirm', { name: displayName }), { title: t('environments:notification.deleteProfileTitle'), kind: 'warning' });
  if (!confirmDelete) return;
  try {
    await invoke('delete_backup', { v: activeScVersion, bid: backupId });
    if (lastRestoredBackupId === backupId) {
      setState({ lastRestoredBackupId: null, activeProfileStatus: null });
      delete lastRestoredPerVersion[activeScVersion];
      invoke('save_active_profile', { v: activeScVersion, bid: '' }).catch(err => logError(err, 'environments:save_active_profile'));
    }
    showNotification(t('environments:notification.profileDeleted'), 'success');
    await loadBackups();
    await loadProfileStatus();
    renderEnvironments(document.getElementById('content'));
  } catch (e) {
    showNotification(t('environments:notification.deleteFailed', { error: e }), 'error');
  }
}

// ==================== Device Drag & Drop ====================

/**
 * Handles a device swap after drag-and-drop.
 *
 * Only allows swaps within the same device type (joystick<->joystick, etc.)
 * because SC bindings use type-specific prefixes (js1_, kb1_, gp1_).
 *
 * Operates on the active backup's actionmaps.xml (not live SC files).
 * After success, reloads backups so the UI reflects the new device order.
 *
 * @param {number} sourceInstance - Instance number of the dragged device
 * @param {number} targetInstance - Instance number of the drop target device
 * @param {string} sourceDeviceType - Device type of the dragged device
 * @param {string} targetDeviceType - Device type of the drop target device
 * @param {Function} renderEnvironments - Full re-render callback (provided by caller)
 */
export async function handleDeviceDrop(sourceInstance, targetInstance, sourceDeviceType, targetDeviceType, renderEnvironments) {
  if (sourceInstance === targetInstance && sourceDeviceType === targetDeviceType) return;

  const { activeScVersion, lastRestoredBackupId } = getState();
  if (!activeScVersion || !lastRestoredBackupId) return;

  // Only allow swaps within the same device type
  if (sourceDeviceType !== targetDeviceType) {
    showNotification(t('environments:notification.cannotSwapDeviceTypes', { typeA: sourceDeviceType, typeB: targetDeviceType }), 'warning');
    return;
  }

  // Both entries use the same device type since we only swap within a type
  const newOrder = [
    { oldInstance: sourceInstance, newInstance: targetInstance, deviceType: sourceDeviceType },
    { oldInstance: targetInstance, newInstance: sourceInstance, deviceType: sourceDeviceType },
  ];

  try {
    await invoke('reorder_profile_devices', {
      v: activeScVersion,
      bid: lastRestoredBackupId,
      newOrder,
    });
    showNotification(t('environments:notification.swapped', { type: sourceDeviceType, a: sourceInstance, b: targetInstance }), 'success');
    // Reload backups and profile status so the UI shows "out of sync"
    await loadBackups();
    await loadProfileStatus();
    renderEnvironments(document.getElementById('content'));
  } catch (e) {
    showNotification(t('environments:notification.reorderFailed', { error: e }), 'error');
  }
}
