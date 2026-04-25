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
 * Storage and version management for Environments page.
 *
 * Handles Data.p4k file operations (copy, symlink), SC version folder
 * creation/deletion, profile import from other versions, and the
 * storage tab rendering.
 *
 * @module pages/environments/storage
 */

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { t } from '../../i18n.js';
import { escapeHtml } from '../../utils.js';
import { confirm, showNotification } from '../../utils/dialogs.js';
import { getState, setState } from './state.js';
import { debugLog, formatFileSize } from './utils.js';

// ── Storage Tab Rendering ──

/**
 * Renders the Storage tab with version information and the option
 * to delete an entire environment ("Danger Zone").
 */
export function renderStorageTab() {
  const { scVersions, activeScVersion } = getState();
  const vInfo = scVersions.find(v => v.version === activeScVersion);
  if (!vInfo) return '';

  const hasDataP4k = vInfo.has_data_p4k !== false;

  return `
    <div class="sc-section">
      <div class="sc-section-header">
        <h3>${t('environments:storage.title')}</h3>
      </div>

      <div class="profile-info-card">
        <div class="profile-info-row">
          <span class="profile-info-label">${t('environments:storage.environment')}</span>
          <span class="profile-info-value"><strong>${escapeHtml(activeScVersion)}</strong></span>
        </div>
        <div class="profile-info-row">
          <span class="profile-info-label">${t('environments:storage.path')}</span>
          <span class="profile-info-value"><code>${escapeHtml(vInfo.path || 'Unknown')}</code></span>
        </div>
        <div class="profile-info-row">
          <span class="profile-info-label">${t('environments:storage.dataP4k')}</span>
          <span class="profile-info-value">
            ${hasDataP4k
              ? `<span class="localization-installed-badge">${t('environments:storage.installedBadge')}</span>`
              : `<span class="text-muted">${t('environments:storage.missing')}</span>`}
          </span>
        </div>
      </div>

      <div class="storage-actions" style="margin-top: 2rem; display: flex; flex-direction: column; gap: 1rem;">
        <div style="padding: 1rem; border: 1px solid var(--border-color); border-radius: 8px; background: rgba(255, 50, 50, 0.05);">
          <h4 style="margin-top: 0; color: #ff6b6b; display: flex; align-items: center; gap: 0.5rem;">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>
            ${t('environments:storage.dangerZone')}
          </h4>
          <p style="color: var(--text-secondary); margin-bottom: 1rem; font-size: 0.9rem;">
            ${t('environments:storage.deleteDesc', { version: escapeHtml(activeScVersion) })}
          </p>
          <button class="btn btn-danger" id="btn-delete-version" data-version="${escapeHtml(activeScVersion)}">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-right: 6px;"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
            ${t('environments:storage.deleteButton', { version: escapeHtml(activeScVersion) })}
          </button>
        </div>
      </div>
    </div>
  `;
}

// ── Version Management ──

/**
 * Deletes a complete SC environment (folder + all data) after double confirmation.
 * Resets the active version if the deleted version was active.
 *
 * @param {string} version - Version name to delete
 * @param {Object} callbacks - { renderEnvironments }
 */
export async function deleteScVersion(version, callbacks = {}) {
  if (!version) return;

  const { config, activeScVersion } = getState();

  const confirmed = await confirm(t('environments:storage.deleteConfirm', { version }), {
    title: t('environments:storage.deleteTitle'),
    kind: 'warning',
  });

  if (!confirmed) return;
  if (!config?.install_path) {
    showNotification(t('environments:notification.noInstallPath'), 'error');
    return;
  }

  try {
    showNotification(t('environments:notification.deletingEnv', { version }), 'info');
    await invoke('delete_sc_version', { gp: config.install_path, version });

    // Clear active version if we just deleted it
    if (activeScVersion === version) {
      setState({
        activeScVersion: null,
        lastRestoredBackupId: null,
        activeProfileTab: 'profile',
      });
    }

    showNotification(t('environments:notification.envDeleted', { version }), 'success');

    // Reload environments
    if (callbacks.renderEnvironments) callbacks.renderEnvironments(document.getElementById('content'));
  } catch (err) {
    showNotification(t('environments:notification.envDeleteFailed', { error: err }), 'error');
  }
}

// ── Import from Another Version ──

/**
 * Shows the dialog for importing profiles/settings from another SC version.
 * Allows selecting the source version and a specific saved profile.
 *
 * @param {Object} callbacks - { renderEnvironments, loadBackups }
 */
export async function showImportVersionDialog(callbacks = {}) {
  const { config, activeScVersion } = getState();
  if (!config?.install_path || !activeScVersion) return;

  // Check if dialog already open
  if (document.getElementById('import-version-dialog')) return;

  try {
    const versions = await invoke('list_importable_versions', {
      gp: config.install_path,
      targetVersion: activeScVersion,
    });

    if (versions.length === 0) {
      showNotification(t('environments:notification.noImportableVersions'), 'info');
      return;
    }

    // Build dialog HTML
    const dialog = document.createElement('div');
    dialog.id = 'import-version-dialog';
    dialog.className = 'import-version-dialog';
    dialog.innerHTML = `
      <div class="import-version-dialog-header">
        <h4>${t('environments:import.dialogTitle')}</h4>
      </div>
      <div class="import-version-dialog-body">
        <label class="import-version-label">${t('environments:import.sourceVersion')}</label>
        <select class="input import-version-select" id="import-source-select">
          ${versions.map(v => `<option value="${escapeHtml(v.version)}" data-info="${escapeHtml(JSON.stringify(v))}">${escapeHtml(v.version)}</option>`).join('')}
        </select>
        <label class="import-version-label" style="margin-top: 8px;">${t('environments:import.source')}</label>
        <select class="input import-version-select" id="import-profile-select">
          <option value="__current__">${t('environments:import.currentScFiles')}</option>
        </select>
        <div class="import-version-summary" id="import-version-summary"></div>
      </div>
      <div class="import-version-dialog-footer">
        <button class="btn btn-sm" id="btn-import-cancel">${t('environments:profile.cancel')}</button>
        <button class="btn btn-sm btn-primary" id="btn-import-confirm">${t('environments:import.confirm')}</button>
      </div>
    `;

    // Insert dialog after section header
    const section = document.querySelector('.sc-section');
    if (section) {
      section.parentElement.insertBefore(dialog, section);
    } else {
      document.querySelector('.profile-tab-content')?.prepend(dialog);
    }

    // Load saved profiles for the selected source version
    async function loadSourceProfiles(sourceVersion) {
      const profileSelect = document.getElementById('import-profile-select');
      if (!profileSelect) return;
      profileSelect.innerHTML = `<option value="__current__">${t('environments:import.currentScFiles')}</option>`;
      try {
        const backupsList = await invoke('list_backups', { v: sourceVersion });
        for (const b of backupsList) {
          const label = b.label || b.id;
          const date = b.created_at ? ` (${b.created_at})` : '';
          const opt = document.createElement('option');
          opt.value = b.id;
          opt.textContent = t('environments:import.savedPrefix', { label, date });
          profileSelect.appendChild(opt);
        }
      } catch (e) {
        debugLog('profiles', 'warn', `Failed to load backups for ${sourceVersion}: ${e}`);
      }
    }

    // Update summary for selected version
    function updateSummary() {
      const sel = document.getElementById('import-source-select');
      const opt = sel?.selectedOptions[0];
      const summaryEl = document.getElementById('import-version-summary');
      if (!opt || !summaryEl) return;
      const { activeScVersion: currentVersion } = getState();
      const profileSel = document.getElementById('import-profile-select');
      const selectedProfile = profileSel?.value;
      if (selectedProfile && selectedProfile !== '__current__') {
        summaryEl.textContent = t('environments:import.willCreateProfile', { version: currentVersion });
        return;
      }
      try {
        const info = JSON.parse(opt.dataset.info);
        const parts = [];
        if (info.profile_file_count > 0) parts.push(t('environments:import.profileFiles', { count: info.profile_file_count }));
        if (info.controls_file_count > 0) parts.push(t('environments:import.controlMappings', { count: info.controls_file_count }));
        if (info.character_file_count > 0) parts.push(t('environments:import.characterPresets', { count: info.character_file_count }));
        summaryEl.textContent = parts.length > 0
          ? t('environments:import.willSaveAs', { parts: parts.join(', ') })
          : t('environments:import.noFilesFound');
      } catch { summaryEl.textContent = ''; }
    }

    // Initial load
    await loadSourceProfiles(versions[0].version);
    updateSummary();

    document.getElementById('import-source-select')?.addEventListener('change', async (e) => {
      await loadSourceProfiles(e.target.value);
      updateSummary();
    });

    document.getElementById('import-profile-select')?.addEventListener('change', updateSummary);

    document.getElementById('btn-import-cancel')?.addEventListener('click', () => dialog.remove());

    document.getElementById('btn-import-confirm')?.addEventListener('click', async () => {
      const { config: currentConfig, activeScVersion: currentVersion } = getState();
      const sourceVersion = document.getElementById('import-source-select')?.value;
      if (!sourceVersion) return;
      const selectedProfile = document.getElementById('import-profile-select')?.value;
      const isProfile = selectedProfile && selectedProfile !== '__current__';

      dialog.remove();
      try {
        const result = await invoke('import_version_as_profile', {
          gp: currentConfig.install_path,
          sourceVersion,
          targetVersion: currentVersion,
          bid: isProfile ? selectedProfile : null,
          label: null,
        });
        showNotification(t('environments:notification.importCreated', { label: escapeHtml(result.label), version: sourceVersion }), 'success');

        // Reload backups to show the new profile
        if (callbacks.loadBackups) await callbacks.loadBackups();
        if (callbacks.renderEnvironments) callbacks.renderEnvironments(document.getElementById('content'));
      } catch (e) {
        showNotification(t('environments:notification.importFailed', { error: e }), 'error');
      }
    });

  } catch (e) {
    showNotification(t('environments:notification.importVersionsFailed', { error: e }), 'error');
  }
}

// ── Data.p4k Copy Dropdown ──

/**
 * Shows a dropdown for selecting the source version for copying Data.p4k.
 * Displayed when clicking the copy button of a version without Data.p4k.
 *
 * @param {string} targetVersion - Version that needs Data.p4k
 * @param {Event} event - Click event from the copy button
 */
export async function showDataP4kCopyDropdown(targetVersion, event) {
  event.stopPropagation();

  // Remove any existing dropdown
  document.querySelector('.data-p4k-dropdown')?.remove();

  const { scVersions } = getState();

  // Find versions with Data.p4k
  const sourceVersions = scVersions.filter(v => v.has_data_p4k && v.version !== targetVersion);

  if (sourceVersions.length === 0) {
    showNotification(t('environments:notification.noDataP4kSource'), 'info');
    return;
  }

  // Build dropdown
  const dropdown = document.createElement('div');
  dropdown.className = 'data-p4k-dropdown';
  dropdown.innerHTML = `
    <div class="data-p4k-dropdown-header">${t('environments:dataP4k.dropdownHeader')}</div>
    ${sourceVersions.map(v => `
      <button class="data-p4k-dropdown-item" data-source="${escapeHtml(v.version)}">
        ${escapeHtml(v.version)}
      </button>
    `).join('')}
  `;

  // Position dropdown
  const btn = event.target.closest('.version-copy-btn') || event.target;
  const rect = btn.getBoundingClientRect();
  dropdown.style.position = 'fixed';
  dropdown.style.left = `${rect.right + 5}px`;
  dropdown.style.top = `${rect.top}px`;

  document.body.appendChild(dropdown);

  // Handle clicks
  dropdown.querySelectorAll('.data-p4k-dropdown-item').forEach(item => {
    item.addEventListener('click', async () => {
      const sourceVersion = item.dataset.source;
      dropdown.remove();

      // Show progress modal instead of starting copy immediately
      await showDataP4kCopyProgressModal(sourceVersion, targetVersion);
    });
  });

  // Close on outside click
  setTimeout(() => {
    document.addEventListener('click', function closeDropdown() {
      dropdown.remove();
      document.removeEventListener('click', closeDropdown);
    });
  }, 0);
}

// ── Data.p4k Copy Progress ──

/**
 * Shows a modal window with progress bar, speed, and ETA
 * for the Data.p4k file copy operation (~100+ GB).
 * Supports cancellation during copying.
 *
 * @param {string} sourceVersion - Version with original Data.p4k
 * @param {string} targetVersion - Version receiving the copy
 * @param {Object} callbacks - { renderEnvironments }
 */
export async function showDataP4kCopyProgressModal(sourceVersion, targetVersion, callbacks = {}) {
  // Remove existing modal
  document.querySelector('#data-p4k-copy-modal')?.remove();

  const { config } = getState();

  // Get file size
  let sizeBytes = 0;
  try {
    sizeBytes = await invoke('get_data_p4k_size', {
      gp: config.install_path,
      version: sourceVersion
    });
  } catch (e) {
    showNotification(`Error: ${e}`, 'error');
    return;
  }

  const modal = document.createElement('div');
  modal.id = 'data-p4k-copy-modal';
  modal.className = 'modal-overlay show';
  modal.innerHTML = `
    <div class="modal-content data-p4k-copy-modal">
      <div class="modal-header">
        <h3>${t('environments:dataP4k.copyTitle')}</h3>
        <button class="modal-close" id="btn-modal-close">\u00d7</button>
      </div>
      <div class="modal-body">
        <div class="copy-progress-info">
          <p>${t('environments:dataP4k.fromTo', { source: escapeHtml(sourceVersion), target: escapeHtml(targetVersion) })}</p>
          <p>${t('environments:dataP4k.size', { size: formatFileSize(sizeBytes) })}</p>
        </div>
        <div class="progress-bar-container" style="display: none;">
          <div class="progress-bar" id="copy-progress-bar">
            <span class="progress-bar-text" id="copy-progress-percent">0%</span>
          </div>
        </div>
        <div class="progress-stats" style="display: none;">
          <div class="speed">
            <div class="label">${t('environments:dataP4k.speed')}</div>
            <div class="value" id="copy-speed">-</div>
          </div>
          <div class="eta">
            <div class="label">${t('environments:dataP4k.remaining')}</div>
            <div class="value" id="copy-eta">-</div>
          </div>
        </div>
        <p class="progress-text" id="copy-progress-text" style="display: none;">
          ${t('environments:dataP4k.copied', { copied: `<span id="copied-bytes">0</span>`, total: `<span id="total-bytes">${formatFileSize(sizeBytes)}</span>` })}
        </p>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" id="btn-copy-cancel">${t('environments:dataP4k.cancelBtn')}</button>
        <button class="btn btn-primary" id="btn-copy-start">${t('environments:dataP4k.startBtn')}</button>
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  const progressBar = modal.querySelector('#copy-progress-bar');
  const progressPercent = modal.querySelector('#copy-progress-percent');
  const progressText = modal.querySelector('.progress-text');
  const progressStats = modal.querySelector('.progress-stats');
  const progressContainer = modal.querySelector('.progress-bar-container');
  const speedEl = modal.querySelector('#copy-speed');
  const etaEl = modal.querySelector('#copy-eta');
  const copiedBytesEl = modal.querySelector('#copied-bytes');

  // State
  let unlisten = null;

  // Helper to calculate ETA
  function calculateEta(speedBps, currentCopied) {
    if (speedBps < 1024 * 1024) return '-'; // Less than 1 MB/s
    const remaining = sizeBytes - currentCopied;
    const seconds = remaining / speedBps;
    if (seconds < 60) return t('environments:dataP4k.lessThan1Min');
    const mins = Math.ceil(seconds / 60);
    if (mins < 60) return t('environments:dataP4k.minutesEta', { mins });
    const hours = Math.floor(mins / 60);
    const remainingMins = mins % 60;
    return t('environments:dataP4k.hoursEta', { hours, mins: remainingMins });
  }

  let currentCopied = 0;

  // Close handlers
  const closeModal = async () => {
    if (unlisten) {
      unlisten();
      unlisten = null;
    }
    // If copying, send cancel
    const { config: currentConfig } = getState();
    try {
      await invoke('abort_copy_data_p4k', {
        gp: currentConfig.install_path,
        version: targetVersion
      });
    } catch (e) { /* ignore */ }
    modal.remove();
    setState({ copyingVersion: null });
    // Reload to reset state
    const scVersionsUpdated = await invoke('detect_sc_versions', { gp: currentConfig.install_path });
    setState({ scVersions: scVersionsUpdated });
    if (callbacks.renderEnvironments) callbacks.renderEnvironments(document.getElementById('content'));
  };

  modal.querySelector('#btn-modal-close').addEventListener('click', closeModal);
  modal.querySelector('#btn-copy-cancel').addEventListener('click', closeModal);

  // Start button
  modal.querySelector('#btn-copy-start').addEventListener('click', async () => {
    // Switch to progress mode
    modal.querySelector('#btn-copy-start').style.display = 'none';
    modal.querySelector('#btn-copy-cancel').textContent = t('environments:dataP4k.cancelBtn');
    progressContainer.style.display = 'block';
    progressText.style.display = 'block';
    progressStats.style.display = 'flex';

    // Setup progress listener
    unlisten = await listen('data-p4k-progress', (event) => {
      const { version, percent, copied_bytes, speed_bps } = event.payload;

      // Only handle our target version
      if (version !== targetVersion) return;

      currentCopied = copied_bytes;

      progressBar.style.width = percent + '%';
      progressPercent.textContent = percent + '%';
      copiedBytesEl.textContent = formatFileSize(copied_bytes);

      if (speed_bps > 0) {
        const speedMB = (speed_bps / (1024 * 1024)).toFixed(1);
        speedEl.textContent = speedMB + ' MB/s';
        etaEl.textContent = calculateEta(speed_bps, copied_bytes);
      }
    });

    // Set copying state
    setState({ copyingVersion: { version: targetVersion, startTime: Date.now() } });

    // Reload to show yellow "copying" state
    if (callbacks.renderEnvironments) callbacks.renderEnvironments(document.getElementById('content'));

    const { config: currentConfig } = getState();

    try {
      await invoke('copy_data_p4k', {
        gp: currentConfig.install_path,
        sourceVersion,
        targetVersion
      });

      // Success
      showNotification(t('environments:notification.dataP4kCopied'), 'success');
      if (unlisten) {
        unlisten();
        unlisten = null;
      }
      modal.remove();

      // Reload versions
      const scVersionsUpdated = await invoke('detect_sc_versions', { gp: currentConfig.install_path });
      setState({ scVersions: scVersionsUpdated });
      if (callbacks.renderEnvironments) callbacks.renderEnvironments(document.getElementById('content'));

    } catch (e) {
      if (e.includes('cancelled') || e.includes('aborted')) {
        showNotification(t('environments:notification.copyCancelled'), 'info');
      } else {
        showNotification(`Error: ${e}`, 'error');
      }
      if (unlisten) {
        unlisten();
        unlisten = null;
      }
      modal.remove();

      // Reload versions
      const scVersionsReloaded = await invoke('detect_sc_versions', { gp: currentConfig.install_path });
      setState({ scVersions: scVersionsReloaded });
      if (callbacks.renderEnvironments) callbacks.renderEnvironments(document.getElementById('content'));
    }

    setState({ copyingVersion: null });
  });
}

// ── Version Creation & Linking ──

/**
 * Creates a new SC version folder in the installation directory.
 * Reloads the environments view after creation.
 * @param {string} version - Version name to create (e.g. "PTU")
 * @param {Object} callbacks - { renderEnvironments }
 */
export async function createScVersion(version, callbacks = {}) {
  const { config } = getState();
  if (!version || !config?.install_path) return;

  try {
    showNotification(t('environments:notification.creatingFolder', { version }), 'info');
    await invoke('create_sc_version', { gp: config.install_path, version });
    showNotification(t('environments:notification.folderCreated', { version }), 'success');

    // Reload environments
    const scVersionsUpdated = await invoke('detect_sc_versions', { gp: config.install_path });
    setState({ scVersions: scVersionsUpdated });
    if (callbacks.renderEnvironments) callbacks.renderEnvironments(document.getElementById('content'));
  } catch (err) {
    showNotification(t('environments:notification.createFailed', { error: err }), 'error');
  }
}

/**
 * Creates a symlink for Data.p4k from one version to another.
 * This saves disk space by sharing the large game data file.
 * @param {string} sourceVersion - Version that has the original Data.p4k
 * @param {string} targetVersion - Version that will receive the symlink
 * @param {Object} callbacks - { renderEnvironments }
 */
export async function linkDataP4k(sourceVersion, targetVersion, callbacks = {}) {
  const { config } = getState();
  if (!sourceVersion || !targetVersion || !config?.install_path) return;

  try {
    showNotification(t('environments:notification.symlinking', { source: sourceVersion, target: targetVersion }), 'info');
    await invoke('link_data_p4k', { gp: config.install_path, src_version: sourceVersion, dst_version: targetVersion });
    showNotification(t('environments:notification.symlinkSuccess'), 'success');

    // Reload environments
    const scVersionsUpdated = await invoke('detect_sc_versions', { gp: config.install_path });
    setState({ scVersions: scVersionsUpdated });
    if (callbacks.renderEnvironments) callbacks.renderEnvironments(document.getElementById('content'));
  } catch (err) {
    showNotification(t('environments:notification.symlinkFailed', { error: err }), 'error');
  }
}

/**
 * Asks the user to confirm overwriting an existing Data.p4k in the target environment.
 * @param {string} targetVersion - Target environment name (e.g. "LIVE")
 * @param {number} sizeBytes - Size of the existing target file in bytes
 * @param {number|null} mtimeMs - Modification time of the target file in ms since epoch (or null)
 * @returns {Promise<boolean>} true if the user confirmed
 */
export async function confirmReplaceDataP4k(targetVersion, sizeBytes, mtimeMs) {
  const sizeStr = formatFileSize(sizeBytes);
  const dateStr = mtimeMs ? new Date(mtimeMs).toLocaleString() : '?';
  return await confirm(
    t('environments:storage.replaceMsg', { version: targetVersion, size: sizeStr, date: dateStr }),
    {
      title: t('environments:storage.replaceTitle'),
      kind: 'warning',
      okLabel: t('environments:storage.replaceConfirm'),
    }
  );
}

/**
 * Moves Data.p4k from `sourceVersion` to `targetVersion`, optionally replacing
 * an existing target file. Uses the `move_data_p4k` Tauri command:
 * same-filesystem moves are instant, cross-filesystem moves emit
 * `data-p4k-progress` events (caller may show a progress modal in the future).
 *
 * @param {string} sourceVersion - Version with the Data.p4k
 * @param {string} targetVersion - Version that will receive Data.p4k
 * @param {boolean} replaceExisting - If true, overwrite target's Data.p4k
 * @param {Object} callbacks - { renderEnvironments }
 */
export async function moveDataP4k(sourceVersion, targetVersion, replaceExisting, callbacks = {}) {
  const { config } = getState();
  if (!sourceVersion || !targetVersion || !config?.install_path) return;

  try {
    showNotification(t('environments:notification.moving', { src: sourceVersion, tgt: targetVersion }), 'info');
    await invoke('move_data_p4k', {
      gp: config.install_path,
      sourceVersion,
      targetVersion,
      replaceExisting,
    });
    showNotification(t('environments:notification.moveSuccess'), 'success');

    const scVersionsUpdated = await invoke('detect_sc_versions', { gp: config.install_path });
    setState({ scVersions: scVersionsUpdated });
    if (callbacks.renderEnvironments) callbacks.renderEnvironments(document.getElementById('content'));
  } catch (err) {
    showNotification(t('environments:notification.moveFailed', { error: err }), 'error');
  }
}

/**
 * Updates an existing profile with the current Star Citizen game files.
 * Overwrites the profile's stored files with the live SC files.
 * @param {string} backupId - ID of the profile to update
 * @param {Object} callbacks - { renderEnvironments, loadBackups, loadProfileStatus }
 */
export async function updateProfileFromSc(backupId, callbacks = {}) {
  const { activeScVersion, config } = getState();
  if (!backupId || !activeScVersion || !config?.install_path) return;

  try {
    showNotification(t('environments:notification.updatingProfile'), 'info');
    await invoke('update_backup_from_sc', { gp: config.install_path, v: activeScVersion, bid: backupId });
    showNotification(t('environments:notification.profileUpdated'), 'success');

    // Refresh UI
    if (callbacks.loadBackups) await callbacks.loadBackups();
    if (callbacks.loadProfileStatus) await callbacks.loadProfileStatus();
    if (callbacks.renderEnvironments) callbacks.renderEnvironments(document.getElementById('content'));
  } catch (err) {
    showNotification(t('environments:notification.profileUpdateFailed', { error: err }), 'error');
  }
}
