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
 * Environments page entry point.
 *
 * Wires together all environment sub-modules and exports the three
 * functions expected by the router:
 *   - renderEnvironments(container)
 *   - cleanupEnvironments()
 *   - setActiveProfileTab(tab)
 *
 * Replaces the former monolithic environments.js.
 *
 * @module pages/environments/index
 */

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { confirm, showDiff, showNotification, prompt } from '../../utils/dialogs.js';
import { logError } from '../../utils/error-handler.js';
import { escapeHtml } from '../../utils.js';
import { t } from '../../i18n.js';

// ── Sub-module imports ──
import { getState, setState, resetState, lastRestoredPerVersion } from './state.js';
import { debugLog, dismissHint } from './utils.js';
import {
  loadLocalizationLabels, loadLocalizationData,
  renderLocalizationTab, renderLocalizationStatus, renderLanguageSelector,
  installLocalization, removeLocalization, resolveSourceRepo,
} from './localization.js';
import { loadDeviceTuning, renderDeviceMapCollapsible } from './tuning.js';
import {
  renderStorageTab, deleteScVersion, showImportVersionDialog,
  showDataP4kCopyDropdown, showDataP4kCopyProgressModal,
  createScVersion, linkDataP4k, updateProfileFromSc,
} from './storage.js';
import {
  loadUserCfgSettings, detectAttributeConflicts,
  renderUserCfgUI, applyUserCfg, resetUserCfg,
  updateResolutionHighlight, updateSettingHighlight, updateChangedCounts,
  hasUnsavedChanges, getChangedSettingsCount,
  DEFAULT_SETTINGS, QUALITY_KEYS, SHADER_KEYS, RESOLUTION_PRESETS,
  STANDARD_VERSIONS, convertAttrValue, convertToAttrValue,
  getQualityLevels, getShaderLevels, getSettingLabels,
} from './usercfg.js';
import {
  loadActionDefinitions, loadCompleteBindingList,
  loadDevicesAndBindings, loadExportedLayouts,
  refreshBindingsInPlace, attachBindingEventListeners,
  openBindingEditor, openMouseBindingEditor,
} from './bindings.js';
import {
  loadBackups, loadProfileStatus, renderProfileTab,
  saveProfile, loadProfile, deleteProfile, handleDeviceDrop,
} from './profiles.js';

// ── Globals expected by inline onclick handlers in rendered HTML ──
/** @type {Set<string>} Which binding categories are expanded */
window.expandedBindingCategories = new Set();
/** @type {Object} Which collapsible panels are open (persists within the session) */
if (!window.expandedPanels) window.expandedPanels = { bindings: false, devices: false, tuning: false };

// ==================== Version Selector ====================

/**
 * Renders the version selector as a card strip.
 * Detected and standard versions are shown, sorted by priority.
 * Each card displays the status (installed, missing, copying) via a colored dot.
 */
function renderVersionSelector() {
  const { scVersions, config, activeScVersion, copyingVersion } = getState();

  if (scVersions.length === 0 || (!config?.install_path)) {
    return `
      <div class="sc-version-notice">
        <div class="notice-icon">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
          </svg>
        </div>
        <h3>${t('environments:version.noVersionsTitle')}</h3>
        <p>${t('environments:version.noVersionsDesc')}</p>
        <p class="notice-path">${escapeHtml(config?.install_path || t('environments:version.notSet'))}</p>
      </div>
    `;
  }

  // Combine detected versions and standard versions
  const allVersionNames = [...scVersions.map(v => v.version)];
  for (const sv of STANDARD_VERSIONS) {
    if (!allVersionNames.includes(sv)) {
      allVersionNames.push(sv);
    }
  }

  // Sort versions: LIVE first, then PTU, then others from STANDARD, then rest
  allVersionNames.sort((a, b) => {
    const order = { 'LIVE': 0, 'PTU': 1, 'EPTU': 2, 'TECH-PREVIEW': 3, 'HOTFIX': 4 };
    const aOrder = order[a] !== undefined ? order[a] : 99;
    const bOrder = order[b] !== undefined ? order[b] : 99;
    return aOrder - bOrder || a.localeCompare(b);
  });

  return `
    <div class="sc-version-selector">
      <label class="section-label">${t('environments:version.label')}</label>
      <div class="version-cards">
        ${allVersionNames.map(vName => {
          const v = scVersions.find(v => v.version === vName);
          const exists = !!v;
          const isActive = activeScVersion === vName;
          const hasDataP4k = exists && v.has_data_p4k !== false;
          const isCopying = copyingVersion && copyingVersion.version === vName;

          let statusClass = 'missing';
          if (exists) {
            statusClass = isCopying ? 'copying' : (hasDataP4k ? 'installed' : 'missing');
          } else {
            statusClass = 'not-installed';
          }

          return `
            <button class="sc-version-card ${isActive ? 'active' : ''} ${!exists ? 'sc-not-installed' : ''} ${exists && !hasDataP4k ? 'missing-data' : ''}"
                    data-version="${escapeHtml(vName)}">
              <div class="version-status-dot ${statusClass}"
                   title="${!exists ? t('environments:version.folderNotCreated') : (isCopying ? t('environments:version.copyingDataP4k') : (hasDataP4k ? t('environments:version.ready') : t('environments:version.dataP4kMissing')))}"></div>
              <span class="version-label">${escapeHtml(vName)}</span>
              ${exists && !hasDataP4k && !isCopying ? `<div class="version-copy-btn" data-version="${escapeHtml(vName)}" title="${t('environments:version.copyFromAnother')}">⤵</div>` : ''}
              ${isCopying ? `<div class="version-copy-progress" data-version="${escapeHtml(vName)}">0%</div>` : ''}
            </button>
          `;
        }).join('')}
      </div>
    </div>
  `;
}

// ==================== Main Content ====================

/**
 * Renders the main page content with tab navigation
 * (Profiles, USER.cfg, Localization, Storage).
 */
function renderMainContent() {
  const { scVersions, activeScVersion, activeProfileTab } = getState();

  if (scVersions.length === 0 || !activeScVersion) {
    return '';
  }

  const vInfo = scVersions.find(v => v.version === activeScVersion);
  if (!vInfo) {
    return renderEmptyVersionState();
  }

  const tabs = [
    { key: 'profile', label: t('environments:tab.profile'), tooltip: t('environments:tab.profileTooltip') },
    { key: 'usercfg', label: t('environments:tab.usercfg'), tooltip: t('environments:tab.usercfgTooltip') },
    { key: 'localization', label: t('environments:tab.localization'), tooltip: t('environments:tab.localizationTooltip') },
    { key: 'storage', label: t('environments:tab.storage'), tooltip: t('environments:tab.storageTooltip') },
  ];

  let tabContent = '';
  if (activeProfileTab === 'profile') {
    tabContent = renderProfileTab(renderEnvironments);
  } else if (activeProfileTab === 'localization') {
    tabContent = renderLocalizationTab();
  } else if (activeProfileTab === 'usercfg') {
    tabContent = renderUserCfgUI();
  } else if (activeProfileTab === 'storage') {
    tabContent = renderStorageTab();
  }

  return `
    <div class="profile-tabs">
      ${tabs.map(tb => `<button class="profile-tab ${activeProfileTab === tb.key ? 'active' : ''}" data-tab="${tb.key}" data-tooltip="${tb.tooltip}" data-tooltip-pos="bottom">${tb.label}</button>`).join('')}
    </div>
    <div class="profile-tab-content">
      ${tabContent}
    </div>
  `;
}

// ==================== Empty Version State ====================

/**
 * Renders the view for a version that does not exist yet.
 * Offers options to create the folder or to symlink/copy the Data.p4k.
 */
function renderEmptyVersionState() {
  const { scVersions, activeScVersion } = getState();
  const versionsWithP4k = scVersions.filter(v => v.has_data_p4k !== false).map(v => v.version);

  return `
    <div class="sc-version-notice" style="margin-top: 2rem;">
      <div class="notice-icon">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
          <line x1="12" y1="11" x2="12" y2="17"></line>
          <line x1="9" y1="14" x2="15" y2="14"></line>
        </svg>
      </div>
      <h3>${t('environments:version.envNotFound', { version: escapeHtml(activeScVersion) })}</h3>
      <p>${t('environments:version.folderNotExist')}</p>

      <div class="empty-state-actions" style="display: flex; flex-direction: column; gap: 1rem; max-width: 400px; margin: 2rem auto;">
        <button class="btn btn-primary" id="btn-create-version" data-version="${escapeHtml(activeScVersion)}">
          ${t('environments:version.createEmptyFolder')}
        </button>

        ${versionsWithP4k.length > 0 ? `
          <div style="border-top: 1px solid var(--border); padding-top: 1rem; margin-top: 0.5rem;">
            <p style="font-size: 0.8rem; color: var(--text-muted); margin-bottom: 0.5rem;">${t('environments:version.initWithDataP4k')}</p>
            <div style="display: flex; gap: 0.5rem;">
              <select id="data-source-select" class="btn btn-sm" style="flex: 1; background: var(--bg-secondary);">
                ${versionsWithP4k.map(v => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join('')}
              </select>
              <button class="btn btn-sm" id="btn-link-p4k" data-version="${escapeHtml(activeScVersion)}" title="${t('environments:version.symlinkTooltip')}">${t('environments:version.symlink')}</button>
              <button class="btn btn-sm" id="btn-copy-p4k" data-version="${escapeHtml(activeScVersion)}" title="${t('environments:version.copyTooltip')}">${t('environments:version.copy')}</button>
            </div>
          </div>
        ` : ''}
      </div>
    </div>
  `;
}

// ==================== Re-render from State ====================

/**
 * Re-renders the page instantly from current module state without fetching new data.
 * Used for tab switches (Profile / UserCfg / Localization / Storage) where the
 * underlying data has not changed and no skeleton is needed.
 */
function rerenderFromState() {
  const container = document.getElementById('content');
  if (!container) return;
  const scrollPos = container.scrollTop;
  container.innerHTML = `
    <div class="page-header">
      <h1>${t('environments:title')}</h1>
      <p class="page-subtitle">${t('environments:subtitle')}</p>
    </div>
    <div class="sc-settings">
      ${renderVersionSelector()}
      ${renderMainContent()}
    </div>
  `;
  attachProfilesEventListeners();
  if (scrollPos > 0) {
    requestAnimationFrame(() => {
      container.scrollTop = scrollPos;
    });
  }
}

// ==================== Reset Environment State ====================

/**
 * Resets ALL environment-scoped module state before switching to a new SC version.
 * Calls resetState() from state.js plus performs cleanup side effects.
 */
function resetEnvironmentState() {
  const s = getState();

  // Kill any running Wine helper and stop hardware capture
  invoke('stop_input_capture').catch(err => logError(err, 'environments:stop_input_capture'));

  // Close any modals that belong to the outgoing environment
  document.querySelectorAll(
    '#binding-editor-modal, #mouse-binding-editor-modal, .modal-overlay'
  ).forEach(m => m.remove());

  // Remove the delegated click handler so attachProfilesEventListeners() starts fresh
  if (s._profilesDelegatedClickHandler) {
    document.removeEventListener('click', s._profilesDelegatedClickHandler);
    setState({ _profilesDelegatedClickHandler: null });
  }

  // Reset state to initial values (preserves cross-version fields)
  resetState();
}

// ==================== Event Hub ====================

/**
 * Attaches all event listeners for the Environments page.
 * This central function is called after each render and connects
 * tab navigation, version selection, profile actions, binding editor,
 * drag-and-drop, USER.cfg controls, localization, and more.
 */
function attachProfilesEventListeners() {
  const s = getState();
  const callbacks = {
    renderEnvironments,
    loadBackups,
    loadUserCfgSettings,
    confirm,
  };

  // Tab navigation — use rerenderFromState() to avoid full reload + skeleton flash
  document.querySelectorAll('.profile-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      setState({ activeProfileTab: tab.dataset.tab });
      rerenderFromState();
    });
  });

  // Hint dismiss buttons
  document.querySelectorAll('[data-action="dismiss-hint"]').forEach(btn => {
    btn.addEventListener('click', () => dismissHint(btn.dataset.hintId));
  });

  // Collapsible panel toggles (Bindings, Devices)
  document.querySelectorAll('.collapsible-header').forEach(header => {
    header.addEventListener('click', () => {
      const panel = header.dataset.panel;
      window.expandedPanels[panel] = !window.expandedPanels[panel];
      const toggle = header.querySelector('.collapsible-toggle');
      const content = header.nextElementSibling;
      if (toggle) toggle.classList.toggle('collapsed');
      if (content) content.classList.toggle('collapsed');
    });
  });

  // Version cards: switch SC version on click
  document.querySelectorAll('.sc-version-card').forEach(card => {
    card.addEventListener('click', async () => {
      const { activeScVersion, lastRestoredBackupId } = getState();
      if (card.dataset.version === activeScVersion) return;
      if (hasUnsavedChanges()) {
        const proceed = await confirm(t('environments:notification.unsavedVersionSwitch'), {
          title: t('environments:notification.unsavedTitle'),
          kind: 'warning',
          okLabel: t('environments:notification.switchAnyway'),
          cancelLabel: t('environments:notification.stay'),
        });
        if (!proceed) return;
      }
      if (activeScVersion && lastRestoredBackupId) {
        lastRestoredPerVersion[activeScVersion] = lastRestoredBackupId;
      }
      resetEnvironmentState();
      setState({ activeScVersion: card.dataset.version });
      const restoredId = lastRestoredPerVersion[card.dataset.version] || null;
      setState({ lastRestoredBackupId: restoredId });
      renderEnvironments(document.getElementById('content'));
    });
  });

  // Empty Version State actions
  document.getElementById('btn-create-version')?.addEventListener('click', async (e) => {
    const version = e.target.dataset.version;
    await createScVersion(version, callbacks);
  });

  document.getElementById('btn-link-p4k')?.addEventListener('click', async (e) => {
    const version = e.currentTarget.dataset.version;
    const source = document.getElementById('data-source-select')?.value;
    if (source) await linkDataP4k(source, version, callbacks);
  });

  document.getElementById('btn-copy-p4k')?.addEventListener('click', async (e) => {
    const version = e.currentTarget.dataset.version;
    const source = document.getElementById('data-source-select')?.value;
    if (source) showDataP4kCopyProgressModal(source, version, callbacks);
  });

  // Device drag-and-drop (Pointer Events - works in WebKitGTK)
  document.querySelectorAll('.device-card.draggable').forEach(card => {
    card.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button')) return;
      e.preventDefault();
      if (!card.dataset.instance) return;

      const sourceInstance = parseInt(card.dataset.instance, 10);
      const sourceDeviceType = card.dataset.deviceType || 'joystick';
      const rect = card.getBoundingClientRect();
      const offsetX = e.clientX - rect.left;
      const offsetY = e.clientY - rect.top;

      card.setPointerCapture(e.pointerId);

      const clone = card.cloneNode(true);
      clone.classList.add('drag-clone');
      clone.style.cssText = `position:fixed;width:${rect.width}px;top:${rect.top}px;left:${rect.left}px;z-index:1000;pointer-events:none;will-change:transform;`;
      document.body.appendChild(clone);
      card.classList.add('dragging');

      function onMove(ev) {
        const dx = ev.clientX - offsetX - rect.left;
        const dy = ev.clientY - offsetY - rect.top;
        clone.style.transform = `translate(${dx}px, ${dy}px)`;

        document.querySelectorAll('.device-card.draggable').forEach(c => {
          if (c === card) return;
          const r = c.getBoundingClientRect();
          const hit = ev.clientX >= r.left && ev.clientX <= r.right
                   && ev.clientY >= r.top && ev.clientY <= r.bottom;
          c.classList.toggle('drag-over', hit);
        });
      }

      function onUp() {
        card.removeEventListener('pointermove', onMove);
        card.removeEventListener('pointerup', onUp);
        clone.remove();
        card.classList.remove('dragging');

        let targetInstance = null;
        let targetDeviceType = 'joystick';
        document.querySelectorAll('.device-card.draggable').forEach(c => {
          if (c.classList.contains('drag-over')) {
            targetInstance = parseInt(c.dataset.instance, 10);
            targetDeviceType = c.dataset.deviceType || 'joystick';
            c.classList.remove('drag-over');
          }
        });

        if (targetInstance !== null && targetInstance !== sourceInstance) {
          handleDeviceDrop(sourceInstance, targetInstance, sourceDeviceType, targetDeviceType, renderEnvironments);
        }
      }

      card.addEventListener('pointermove', onMove);
      card.addEventListener('pointerup', onUp);
    });
  });

  // Reload profile from disk
  document.getElementById('btn-reload-profile')?.addEventListener('click', async () => {
    await Promise.all([loadDevicesAndBindings(), loadCompleteBindingList(), loadExportedLayouts()]);
    renderEnvironments(document.getElementById('content'));
    showNotification(t('environments:notification.profileReloaded'), 'success');
  });

  document.getElementById('btn-update-profile')?.addEventListener('click', async () => {
    const { lastRestoredBackupId } = getState();
    if (lastRestoredBackupId) {
      const confirmed = await confirm(t('environments:notification.updateConfirm'), {
        title: t('environments:notification.updateTitle'),
        kind: 'warning',
      });
      if (confirmed) await updateProfileFromSc(lastRestoredBackupId, callbacks);
    }
  });

  document.getElementById('btn-revert-changes')?.addEventListener('click', async () => {
    const { lastRestoredBackupId, config, activeScVersion } = getState();
    if (lastRestoredBackupId) {
      const confirmed = await confirm(t('environments:notification.revertConfirm'), {
        title: t('environments:notification.revertTitle'),
        kind: 'warning',
      });
      if (confirmed) {
        try {
          await invoke('restore_profile', {
            gp: config.install_path,
            v: activeScVersion,
            bid: lastRestoredBackupId,
          });
          showNotification(t('environments:notification.profileReverted'), 'success');
          await Promise.all([loadActionDefinitions(), loadDevicesAndBindings(), loadCompleteBindingList(), loadBackups(), loadUserCfgSettings()]);
          await loadProfileStatus();
          renderEnvironments(document.getElementById('content'));
        } catch (e) {
          showNotification(t('environments:notification.revertFailed', { error: e }), 'error');
        }
      }
    }
  });

  // Binding source select
  document.getElementById('binding-source-select')?.addEventListener('change', async (e) => {
    setState({ selectedBindingSource: e.target.value || null });
    await loadDevicesAndBindings();
    await loadCompleteBindingList();
    renderEnvironments(document.getElementById('content'));
  });

  // Bindings specific listeners (Search, Matrix, Add/Edit/Delete)
  attachBindingEventListeners();

  // Profile save / load / delete
  document.getElementById('btn-save-current')?.addEventListener('click', () => saveProfile(renderEnvironments));
  document.getElementById('btn-save-first-profile')?.addEventListener('click', () => saveProfile(renderEnvironments));

  document.querySelectorAll('[data-action="load-profile"]').forEach(btn => {
    btn.addEventListener('click', () => loadProfile(btn.dataset.backupId, renderEnvironments));
  });

  document.querySelectorAll('[data-action="delete-saved-profile"]').forEach(btn => {
    btn.addEventListener('click', (e) => { e.stopPropagation(); deleteProfile(btn.dataset.backupId, renderEnvironments); });
  });

  // Storage tab actions
  document.getElementById('btn-delete-version')?.addEventListener('click', async (e) => {
    const version = e.target.closest('button').dataset.version;
    await deleteScVersion(version, callbacks);
  });

  // Toggle changes detail panel + file diff — delegated on document so the listener
  // survives renderEnvironments() rebuilding the DOM.
  // Remove previous registration first to prevent accumulation across re-renders.
  if (s._profilesDelegatedClickHandler) {
    document.removeEventListener('click', s._profilesDelegatedClickHandler);
  }
  const delegatedHandler = async (e) => {
    if (e.target.closest('#btn-toggle-changes')) {
      const { showChangesPanel } = getState();
      setState({ showChangesPanel: !showChangesPanel });
      renderEnvironments(document.getElementById('content'));
      return;
    }
    const row = e.target.closest('.profile-changes-panel .file-clickable');
    if (!row) return;
    const file = row.dataset.file;
    const { config, activeScVersion, lastRestoredBackupId } = getState();
    if (!file || !config?.install_path || !activeScVersion || !lastRestoredBackupId) return;
    try {
      const lines = await invoke('get_file_diff', {
        file,
        gp: config.install_path,
        v: activeScVersion,
        bid: lastRestoredBackupId,
      });
      await showDiff(file, lines);
    } catch (err) {
      console.error('Failed to load diff:', err);
    }
  };
  setState({ _profilesDelegatedClickHandler: delegatedHandler });
  document.addEventListener('click', delegatedHandler);

  // Apply to SC button
  document.getElementById('btn-apply-to-sc')?.addEventListener('click', async () => {
    const { config, activeScVersion, lastRestoredBackupId } = getState();
    if (!config?.install_path || !activeScVersion || !lastRestoredBackupId) return;
    try {
      const corrections = await invoke('apply_profile_to_sc', {
        gp: config.install_path,
        v: activeScVersion,
        profileId: lastRestoredBackupId,
      });
      showNotification(t('environments:notification.profileApplied'), 'success');
      if (corrections > 0) {
        showNotification(
          t('environments:notification.bindingsSanitized', { count: corrections }),
          'warning'
        );
      }
      await loadBackups();
      await loadProfileStatus();
      renderEnvironments(document.getElementById('content'));
    } catch (e) {
      showNotification(t('environments:notification.applyFailed', { error: e }), 'error');
    }
  });

  // Customized only toggle
  document.getElementById('customized-only-toggle')?.addEventListener('change', (e) => {
    setState({ customizedOnly: e.target.checked });
    refreshBindingsInPlace();
  });

  // Essentials only toggle — mutually exclusive with bound-only
  document.getElementById('essentials-only-toggle')?.addEventListener('change', (e) => {
    const essentialsOnly = e.target.checked;
    const updates = { essentialsOnly };
    if (essentialsOnly) {
      updates.boundOnly = false;
      const boundToggle = document.getElementById('bound-only-toggle');
      if (boundToggle) boundToggle.checked = false;
    }
    setState(updates);
    refreshBindingsInPlace();
  });

  // Bound only toggle — mutually exclusive with essentials-only
  document.getElementById('bound-only-toggle')?.addEventListener('change', (e) => {
    const boundOnly = e.target.checked;
    const updates = { boundOnly };
    if (boundOnly) {
      updates.essentialsOnly = false;
      const essentialsToggle = document.getElementById('essentials-only-toggle');
      if (essentialsToggle) essentialsToggle.checked = false;
    }
    setState(updates);
    refreshBindingsInPlace();
  });

  // Human-readable toggle
  document.getElementById('use-human-readable')?.addEventListener('change', (e) => {
    setState({ useHumanReadable: e.target.checked });
    refreshBindingsInPlace();
  });

  // Device alias buttons
  document.querySelectorAll('.device-card-v2-rename').forEach(btn => {
    btn.addEventListener('click', async () => {
      const { activeScVersion, lastRestoredBackupId } = getState();
      const productName = btn.dataset.product;
      const currentAlias = btn.dataset.alias || productName;
      const newAlias = await prompt(t('environments:device.aliasPrompt', { name: productName }), { title: t('environments:device.aliasTitle'), defaultValue: currentAlias });
      if (newAlias === null) return;
      try {
        await invoke('set_profile_device_alias', {
          v: activeScVersion,
          profileId: lastRestoredBackupId,
          productName,
          alias: newAlias,
        });
        await loadBackups();
        renderEnvironments(document.getElementById('content'));
      } catch (e) {
        showNotification(t('environments:notification.aliasSetFailed', { error: e }), 'error');
      }
    });
  });

  // Rename saved profile - click edit icon to show inline input
  document.querySelectorAll('[data-action="rename-saved-profile"]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const { backups, activeScVersion, lastRestoredBackupId } = getState();
      const backupId = btn.dataset.backupId;
      const wrap = btn.closest('.profile-card-header') || btn.closest('.backup-main');
      if (!wrap || wrap.querySelector('.backup-rename-input')) return;

      const labelEl = wrap.querySelector('.profile-card-name') || wrap.querySelector('.backup-label-display');
      const backup = backups.find(b => b.id === backupId);
      const currentLabel = backup?.label || '';

      labelEl.style.display = 'none';
      btn.style.display = 'none';

      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'input backup-rename-input';
      input.value = currentLabel;
      input.placeholder = t('environments:profile.profileName');
      input.maxLength = 60;
      wrap.appendChild(input);
      input.focus();
      input.select();

      async function saveRename() {
        const newLabel = input.value.trim();
        input.remove();
        labelEl.style.display = '';
        btn.style.display = '';
        labelEl.textContent = newLabel || t('environments:profile.unnamedProfile');

        if (backup) backup.label = newLabel;

        try {
          await invoke('update_backup_label', {
            v: activeScVersion,
            bid: backupId,
            l: newLabel,
          });
        } catch (e) {
          showNotification(t('environments:notification.renameFailed', { error: e }), 'error');
        }
        if (lastRestoredBackupId === backupId) {
          renderEnvironments(document.getElementById('content'));
        }
      }

      input.addEventListener('blur', saveRename);
      input.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') { ev.preventDefault(); input.blur(); }
        if (ev.key === 'Escape') { input.value = currentLabel; input.blur(); }
      });
    });
  });

  // Import from version
  document.getElementById('btn-import-version')?.addEventListener('click', () => showImportVersionDialog(callbacks));
  document.getElementById('btn-import-banner')?.addEventListener('click', () => showImportVersionDialog(callbacks));
  document.getElementById('btn-import-banner-dismiss')?.addEventListener('click', () => {
    document.getElementById('import-banner')?.remove();
  });

  // Data.p4k Copy Button
  document.querySelectorAll('.version-copy-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const targetVersion = btn.dataset.version;
      showDataP4kCopyDropdown(targetVersion, e);
    });
  });

  // USER.cfg
  document.getElementById('btn-apply-usercfg')?.addEventListener('click', applyUserCfg);
  document.getElementById('btn-reset-usercfg')?.addEventListener('click', resetUserCfg);

  // Sync conflict resolution
  document.getElementById('btn-resolve-conflicts')?.addEventListener('click', () => {
    const panel = document.getElementById('usercfg-conflict-panel');
    if (panel) panel.style.display = panel.style.display === 'none' ? '' : 'none';
  });
  document.getElementById('btn-conflict-keep-all')?.addEventListener('click', async () => {
    const { config, activeScVersion, pendingConflicts } = getState();
    const changes = {};
    for (const c of pendingConflicts) {
      changes[c.attrName] = convertToAttrValue(c.key, c.ourValue);
    }
    try {
      await invoke('write_attributes_partial', { gp: config.install_path, v: activeScVersion, changes });
      const savedAttributesHash = await invoke('get_attributes_hash', { gp: config.install_path, v: activeScVersion });
      const savedAttributesValues = await invoke('read_attributes_map', { gp: config.install_path, v: activeScVersion });
      setState({ savedAttributesHash, savedAttributesValues });
    } catch (e) { /* ignore */ }
    setState({ pendingConflicts: [] });
    rerenderFromState();
  });
  document.getElementById('btn-conflict-accept-all')?.addEventListener('click', async () => {
    const { config, activeScVersion, pendingConflicts, userCfgSettings } = getState();
    for (const c of pendingConflicts) {
      userCfgSettings[c.key] = c.scValue;
    }
    const savedUserCfgSnapshot = { ...userCfgSettings };
    const savedAttributesValues = await invoke('read_attributes_map', { gp: config.install_path, v: activeScVersion });
    const savedAttributesHash = await invoke('get_attributes_hash', { gp: config.install_path, v: activeScVersion });
    setState({ pendingConflicts: [], savedUserCfgSnapshot, savedAttributesValues, savedAttributesHash });
    rerenderFromState();
  });
  // Per-conflict buttons (delegated)
  document.getElementById('usercfg-conflict-panel')?.addEventListener('click', async (e) => {
    const keepBtn = e.target.closest('.conflict-keep');
    const acceptBtn = e.target.closest('.conflict-accept');
    if (keepBtn) {
      const { config, activeScVersion, pendingConflicts } = getState();
      const key = keepBtn.dataset.key;
      const conflict = pendingConflicts.find(c => c.key === key);
      if (conflict) {
        try {
          await invoke('write_attributes_partial', {
            gp: config.install_path, v: activeScVersion,
            changes: { [conflict.attrName]: convertToAttrValue(key, conflict.ourValue) }
          });
        } catch (e) { /* ignore */ }
        setState({ pendingConflicts: pendingConflicts.filter(c => c.key !== key) });
        rerenderFromState();
      }
    }
    if (acceptBtn) {
      const { pendingConflicts, userCfgSettings } = getState();
      const key = acceptBtn.dataset.key;
      const scValue = parseFloat(acceptBtn.dataset.value);
      const conflict = pendingConflicts.find(c => c.key === key);
      if (conflict) {
        userCfgSettings[key] = isNaN(scValue) ? acceptBtn.dataset.value : scValue;
        setState({
          pendingConflicts: pendingConflicts.filter(c => c.key !== key),
          savedUserCfgSnapshot: { ...userCfgSettings },
        });
        rerenderFromState();
      }
    }
  });

  // Accordion toggle for collapsible categories
  document.querySelectorAll('.usercfg-category-header.collapsible').forEach(header => {
    header.addEventListener('click', () => {
      const { collapsedCategories } = getState();
      const catKey = header.dataset.categoryKey;
      if (collapsedCategories.has(catKey)) {
        collapsedCategories.delete(catKey);
      } else {
        collapsedCategories.add(catKey);
      }
      const settingsDiv = header.nextElementSibling;
      const toggleIcon = header.querySelector('.usercfg-category-toggle');
      if (settingsDiv) settingsDiv.classList.toggle('collapsed');
      if (toggleIcon) toggleIcon.classList.toggle('collapsed');
    });
  });

  // Slider changes
  document.querySelectorAll('.usercfg-slider').forEach(slider => {
    slider.addEventListener('input', (e) => {
      const { userCfgSettings } = getState();
      const key = e.target.dataset.key;
      const value = parseFloat(e.target.value);
      const setting = DEFAULT_SETTINGS[key];

      let displayValue = value;
      const slb = getSettingLabels(key) || setting.labels;
      if (slb) displayValue = slb[value] || value;
      else if (QUALITY_KEYS.has(key)) displayValue = getQualityLevels()[value] || value;
      else if (SHADER_KEYS.has(key)) displayValue = getShaderLevels()[value] || value;

      e.target.parentElement.querySelector('.usercfg-value').textContent = displayValue;
      userCfgSettings[key] = value;
      updateSettingHighlight(e.target.closest('.usercfg-row'), key, setting, value);
    });
  });

  // Number input changes
  document.querySelectorAll('.usercfg-number-input').forEach(input => {
    input.addEventListener('change', (e) => {
      const { userCfgSettings } = getState();
      const key = e.target.dataset.key;
      const value = parseFloat(e.target.value);
      const setting = DEFAULT_SETTINGS[key];
      userCfgSettings[key] = value;
      updateSettingHighlight(e.target.closest('.usercfg-row'), key, setting, value);
    });
  });

  // Checkbox changes
  document.querySelectorAll('.usercfg-input[type="checkbox"]').forEach(checkbox => {
    checkbox.addEventListener('change', (e) => {
      const { userCfgSettings } = getState();
      const key = e.target.dataset.key;
      const value = e.target.checked ? 1 : 0;
      const setting = DEFAULT_SETTINGS[key];
      userCfgSettings[key] = value;
      updateSettingHighlight(e.target.closest('.usercfg-row'), key, setting, value);
    });
  });

  // Resolution inputs
  document.querySelectorAll('.usercfg-res-input').forEach(input => {
    input.addEventListener('change', (e) => {
      const { userCfgSettings } = getState();
      const key = e.target.dataset.key;
      const value = parseInt(e.target.value, 10);
      if (!isNaN(value)) {
        userCfgSettings[key] = value;
        const preset = document.querySelector('.usercfg-res-preset');
        if (preset) {
          const w = userCfgSettings.r_width !== undefined ? userCfgSettings.r_width : 1920;
          const h = userCfgSettings.r_height !== undefined ? userCfgSettings.r_height : 1080;
          const match = RESOLUTION_PRESETS.find(p => p.w === w && p.h === h);
          preset.value = match ? `${w}x${h}` : '';
        }
        updateResolutionHighlight();
      }
    });
  });

  // Resolution preset dropdown
  document.querySelectorAll('.usercfg-res-preset').forEach(select => {
    select.addEventListener('change', (e) => {
      const { userCfgSettings } = getState();
      const val = e.target.value;
      if (!val) return;
      const [w, h] = val.split('x').map(Number);
      userCfgSettings.r_width = w;
      userCfgSettings.r_height = h;
      const wInput = document.querySelector('.usercfg-res-input[data-key="r_width"]');
      const hInput = document.querySelector('.usercfg-res-input[data-key="r_height"]');
      if (wInput) wInput.value = w;
      if (hInput) hInput.value = h;
      updateResolutionHighlight();
    });
  });

  // Localization: install language buttons
  document.querySelectorAll('[data-action="install-lang"]').forEach(btn => {
    btn.addEventListener('click', () => {
      installLocalization(
        btn.dataset.langCode,
        btn.dataset.sourceRepo,
        btn.dataset.langName,
        btn.dataset.sourceLabel,
        callbacks,
      );
    });
  });

  // Help icon popovers (event delegation on the entire usercfg section)
  document.querySelector('.usercfg-section')?.addEventListener('click', (e) => {
    const helpBtn = e.target.closest('.usercfg-help-btn');
    if (!helpBtn) return;
    e.stopPropagation();

    const existing = document.querySelector('.usercfg-help-popover');
    if (existing) {
      existing.remove();
      if (existing._triggerBtn === helpBtn) return;
    }

    const helpText = helpBtn.dataset.help;
    if (!helpText) return;

    const popover = document.createElement('div');
    popover.className = 'usercfg-help-popover';
    popover._triggerBtn = helpBtn;
    popover.textContent = helpText;

    const rect = helpBtn.getBoundingClientRect();
    popover.style.top = `${rect.bottom + 6}px`;
    popover.style.left = `${Math.max(8, rect.left - 100)}px`;
    document.body.appendChild(popover);

    const closeHandler = (ev) => {
      if (!popover.contains(ev.target) && ev.target !== helpBtn) {
        popover.remove();
        document.removeEventListener('click', closeHandler, true);
      }
    };
    setTimeout(() => document.addEventListener('click', closeHandler, true), 0);
  });

  // Localization: update button
  document.getElementById('btn-update-localization')?.addEventListener('click', () => {
    const { localizationStatus } = getState();
    const repo = resolveSourceRepo();
    if (repo && localizationStatus) {
      installLocalization(
        localizationStatus.language_code,
        repo,
        localizationStatus.language_name || localizationStatus.language_code,
        localizationStatus.source_label || '',
        callbacks,
      );
    }
  });

  // Localization: remove button
  document.getElementById('btn-remove-localization')?.addEventListener('click', () => {
    removeLocalization(callbacks);
  });

  // Localization: repo links (event delegation)
  document.querySelectorAll('.localization-repo-link, .localization-repo-link-icon').forEach(link => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      const url = link.dataset.url;
      if (url) invoke('open_browser', { url }).catch(err => console.error(err));
    });
  });

  // Reset individual setting to default value (event delegation)
  document.querySelector('.usercfg-section')?.addEventListener('click', (e) => {
    const btn = e.target.closest('.usercfg-reset');
    if (!btn) return;

    const { userCfgSettings } = getState();
    const key = btn.dataset.key;

    // Special handling for resolution reset
    if (key === '_resolution') {
      delete userCfgSettings.r_width;
      delete userCfgSettings.r_height;
      const wInput = document.querySelector('.usercfg-res-input[data-key="r_width"]');
      const hInput = document.querySelector('.usercfg-res-input[data-key="r_height"]');
      const preset = document.querySelector('.usercfg-res-preset');
      if (wInput) wInput.value = 1920;
      if (hInput) hInput.value = 1080;
      if (preset) preset.value = '1920x1080';
      updateResolutionHighlight();
      return;
    }

    const setting = DEFAULT_SETTINGS[key];
    if (!setting) return;

    delete userCfgSettings[key];

    const row = btn.closest('.usercfg-row');
    if (!row) return;

    const slider = row.querySelector('.usercfg-slider');
    const numberInput = row.querySelector('.usercfg-number-input');
    const checkbox = row.querySelector('.usercfg-input[type="checkbox"]');

    if (slider) {
      slider.value = setting.value;
      const valueSpan = row.querySelector('.usercfg-value');
      if (valueSpan) {
        let display = setting.value;
        const rlb = getSettingLabels(key) || setting.labels;
        if (rlb) display = rlb[setting.value] || setting.value;
        else if (QUALITY_KEYS.has(key)) display = getQualityLevels()[setting.value] || setting.value;
        else if (SHADER_KEYS.has(key)) display = getShaderLevels()[setting.value] || setting.value;
        valueSpan.textContent = display;
      }
    } else if (numberInput) {
      numberInput.value = setting.value;
    } else if (checkbox) {
      checkbox.checked = !!setting.value;
    }

    updateSettingHighlight(row, key, setting, setting.value);
  });

  // Data.p4k copy progress listener - clean up old listeners to prevent leaks
  const { unlistenProgress, unlistenCopyComplete } = getState();
  if (unlistenProgress) { unlistenProgress(); }
  if (unlistenCopyComplete) { unlistenCopyComplete(); }
  setState({ unlistenProgress: null, unlistenCopyComplete: null });

  listen('data-p4k-progress', (event) => {
    const { version, percent } = event.payload;
    const progressEl = document.querySelector(`.version-copy-progress[data-version="${version}"]`);
    if (progressEl) {
      progressEl.style.width = `${percent}%`;
      progressEl.textContent = `${percent}%`;
    }
  }).then(fn => { setState({ unlistenProgress: fn }); });

  listen('data-p4k-copy-complete', async (event) => {
    const { version, success } = event.payload;
    if (success) {
      showNotification(t('environments:notification.dataP4kForVersion', { version }), 'success');
    }
    setState({ copyingVersion: null });
    const { config } = getState();
    const scVersions = await invoke('detect_sc_versions', { gp: config.install_path });
    setState({ scVersions });
    renderEnvironments(document.getElementById('content'));
  }).then(fn => { setState({ unlistenCopyComplete: fn }); });
}

// ==================== App Close Blocker ====================

/**
 * Initializes a window close blocker that prevents closing the app
 * while a Data.p4k copy operation is in progress.
 */
async function initCloseBlocker() {
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    const appWindow = getCurrentWindow();

    appWindow.onCloseRequested(async (event) => {
      const { copyingVersion, config } = getState();
      if (copyingVersion) {
        event.preventDefault();

        const confirmed = await confirm(
          t('environments:closeBlocker.copyInProgress', { version: copyingVersion.version }),
          { title: t('environments:closeBlocker.title'), kind: 'warning', okLabel: t('environments:closeBlocker.okLabel'), cancelLabel: t('environments:closeBlocker.cancelLabel') }
        );

        if (confirmed) {
          try {
            await invoke('abort_copy_data_p4k', {
              gp: config.install_path,
              version: copyingVersion.version
            });
            showNotification(t('environments:notification.copyCancelledAndDeleted'), 'info');
          } catch (e) {
            console.error('Failed to abort copy:', e);
          }

          setState({ copyingVersion: null });

          const scVersions = await invoke('detect_sc_versions', { gp: config.install_path });
          setState({ scVersions });
          renderEnvironments(document.getElementById('content'));

          await appWindow.close();
        }
      }
    });
  } catch (e) {
    console.warn('Close blocker not available:', e);
  }
}

// Initialize close blocker when module loads
initCloseBlocker();

// ==================== Entry Point ====================

/**
 * Sets the active tab and renders the page.
 * Called by the navigation when a tab is directly targeted.
 * @param {string} tab - The tab to display: 'profile', 'usercfg', 'localization', 'storage'
 */
export function setActiveProfileTab(tab) {
  setState({ activeProfileTab: tab });
}

/** Cleans up all active event listeners (prevents memory leaks on page navigation) */
export function cleanupEnvironments() {
  const { unlistenProgress, unlistenCopyComplete, unlistenLaunchStarted, unlistenLaunchExited } = getState();
  if (unlistenProgress) { unlistenProgress(); }
  if (unlistenCopyComplete) { unlistenCopyComplete(); }
  if (unlistenLaunchStarted) { unlistenLaunchStarted(); }
  if (unlistenLaunchExited) { unlistenLaunchExited(); }
  setState({
    unlistenProgress: null,
    unlistenCopyComplete: null,
    unlistenLaunchStarted: null,
    unlistenLaunchExited: null,
    postGameListenerRegistered: false,
  });
}

/**
 * Main render function: Loads all data and renders the environments page.
 * Uses a generation counter so that with rapidly successive calls,
 * only the latest render is actually displayed.
 * @param {HTMLElement} container - DOM container for the page
 */
export async function renderEnvironments(container) {
  const scrollPos = container.scrollTop;

  // Increment generation to discard stale renders from parallel calls
  const s = getState();
  const thisGeneration = s.renderGeneration + 1;
  setState({ renderGeneration: thisGeneration });

  // One-time migration: rename old binding_database.json to .bak
  if (!s.migrationChecked) {
    setState({ migrationChecked: true });
    try {
      const migrated = await invoke('migrate_binding_database');
      if (migrated) {
        showNotification(t('environments:notification.migrated'), 'info');
      }
    } catch (e) {
      console.warn('[profiles] binding_database migration failed:', e);
    }
  }

  let config;
  try {
    config = await invoke('load_config');
  } catch (e) {
    config = { install_path: '', log_level: 'info' };
  }
  setState({ config });

  let scVersions = [];
  if (config?.install_path) {
    try {
      scVersions = await invoke('detect_sc_versions', { gp: config.install_path });
    } catch (e) {
      console.error('[profiles] detect_sc_versions error:', e);
      scVersions = [];
    }
  }
  setState({ scVersions });

  let { activeScVersion } = getState();
  if (scVersions.length > 0 && !activeScVersion) {
    activeScVersion = scVersions[0].version;
    setState({ activeScVersion });
  }

  // Register post-game listener for attributes.xml sync detection (once)
  if (!getState().postGameListenerRegistered && config?.install_path) {
    setState({ postGameListenerRegistered: true });
    listen('launch-started', async () => {
      const { config: cfg, activeScVersion: av } = getState();
      if (cfg?.install_path && av) {
        try {
          const preLaunchAttributesHash = await invoke('get_attributes_hash', {
            gp: cfg.install_path, v: av
          });
          setState({ preLaunchAttributesHash });
        } catch (e) { /* ignore */ }
      }
    }).then(fn => { setState({ unlistenLaunchStarted: fn }); });
    listen('launch-exited', async () => {
      const { config: cfg, activeScVersion: av, preLaunchAttributesHash } = getState();
      if (cfg?.install_path && av && preLaunchAttributesHash) {
        try {
          const postHash = await invoke('get_attributes_hash', {
            gp: cfg.install_path, v: av
          });
          if (postHash && postHash !== preLaunchAttributesHash) {
            const attrsMap = await invoke('read_attributes_map', {
              gp: cfg.install_path, v: av
            });
            detectAttributeConflicts(attrsMap);
            setState({ savedAttributesHash: postHash, savedAttributesValues: attrsMap });
            const { pendingConflicts } = getState();
            if (pendingConflicts.length > 0) {
              showNotification(
                t('environments:notification.settingsChangedInGame', {
                  count: pendingConflicts.length,
                  defaultValue: `${pendingConflicts.length} setting(s) changed in-game`
                }),
                'info'
              );
            }
          }
        } catch (e) { /* ignore */ }
        setState({ preLaunchAttributesHash: '' });
      }
    }).then(fn => { setState({ unlistenLaunchExited: fn }); });
  }

  // Load localization labels in the background (for translated action names in bindings)
  {
    const { localizationLoaded, localizationLoading, activeProfileTab } = getState();
    if (config?.install_path && activeScVersion && !localizationLoaded && !localizationLoading) {
      loadLocalizationLabels().then((loaded) => {
        if (loaded) {
          const { activeProfileTab: tab, lastRestoredBackupId: bid, completeBindingList } = getState();
          const content = document.getElementById('content');
          if (content && tab === 'profile' && bid) {
            loadCompleteBindingList().then(() => {
              const { completeBindingList: bl } = getState();
              if (bl.length > 0) {
                renderEnvironments(content);
              }
            });
          }
        }
      }).catch(e => console.error('Failed to load localization labels:', e));
    }
  }

  // Show loading skeleton while data is being loaded.
  container.innerHTML = `
    <div class="page-header">
      <h1>${t('environments:title')}</h1>
      <p class="page-subtitle">${t('environments:subtitle')}</p>
    </div>
    <div class="sc-settings">
      ${scVersions.length > 0 ? renderVersionSelector() : ''}
      <div class="profiles-loading-skeleton">
        <div class="dash-skeleton">
          <div class="dash-skeleton-line medium"></div>
          <div class="dash-skeleton-line short"></div>
          <div class="dash-skeleton-block" style="height: 120px;"></div>
          <div class="dash-skeleton-block" style="height: 200px;"></div>
        </div>
      </div>
    </div>
  `;
  // Attach version card listeners so tabs respond while content is loading.
  document.querySelectorAll('.sc-version-card').forEach(card => {
    card.addEventListener('click', async () => {
      const { activeScVersion, lastRestoredBackupId } = getState();
      if (card.dataset.version === activeScVersion) return;
      if (hasUnsavedChanges()) {
        const proceed = await confirm(t('environments:notification.unsavedVersionSwitch'), {
          title: t('environments:notification.unsavedTitle'),
          kind: 'warning',
          okLabel: t('environments:notification.switchAnyway'),
          cancelLabel: t('environments:notification.stay'),
        });
        if (!proceed) return;
      }
      if (activeScVersion && lastRestoredBackupId) {
        lastRestoredPerVersion[activeScVersion] = lastRestoredBackupId;
      }
      resetEnvironmentState();
      setState({ activeScVersion: card.dataset.version });
      const restoredId = lastRestoredPerVersion[card.dataset.version] || null;
      setState({ lastRestoredBackupId: restoredId });
      renderEnvironments(document.getElementById('content'));
    });
  });

  // Load active profile per version from disk
  try {
    const saved = await invoke('load_active_profiles');
    Object.assign(lastRestoredPerVersion, saved);
    if (activeScVersion && saved[activeScVersion]) {
      setState({ lastRestoredBackupId: saved[activeScVersion] });
    }
  } catch (e) { /* ignore */ }

  // Load all data in parallel
  await Promise.all([
    loadActionDefinitions(),
    loadDevicesAndBindings(),
    loadCompleteBindingList(),
    loadExportedLayouts(),
    loadBackups(),
    loadUserCfgSettings(),
    loadLocalizationData(),
    loadDeviceTuning(),
  ]);
  await loadProfileStatus();

  // Discard this render if a newer renderEnvironments call has been initiated
  if (thisGeneration !== getState().renderGeneration) return;

  // Render
  container.innerHTML = `
    <div class="page-header">
      <h1>${t('environments:title')}</h1>
      <p class="page-subtitle">${t('environments:subtitle')}</p>
    </div>
    <div class="sc-settings">
      ${renderVersionSelector()}
      ${renderMainContent()}
    </div>
  `;

  attachProfilesEventListeners();

  // Restore scroll position
  if (scrollPos > 0) {
    requestAnimationFrame(() => {
      container.scrollTop = scrollPos;
    });
  }
}
