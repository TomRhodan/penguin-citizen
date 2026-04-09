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
 * Keybinding List + Editors module for the Environments page.
 *
 * Handles loading, rendering, filtering, and editing of Star Citizen
 * keybindings (keyboard, mouse, joystick) within the active profile.
 *
 * @module pages/environments/bindings
 */

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { confirm, showNotification } from '../../utils/dialogs.js';
import { logError } from '../../utils/error-handler.js';
import { escapeHtml } from '../../utils.js';
import { t } from '../../i18n.js';
import { getState, setState, ESSENTIAL_ACTIONS } from './state.js';
import { debugLog, renderHint, formatCategoryName } from './utils.js';

// ==================== Data Loading ====================

/**
 * Loads the action definitions (categories, display names) from the backend.
 * Populates the actionDefinitions state variable.
 */
export async function loadActionDefinitions() {
  try {
    const actionDefinitions = await invoke('get_action_definitions');
    setState({ actionDefinitions });
  } catch (e) {
    console.error('Failed to load action definitions:', e);
    setState({ actionDefinitions: null });
  }
}

/** @type {Object} Statistics: total binding count / custom binding count */
let bindingStats = { total: 0, custom: 0 };

/**
 * Returns the current binding stats (for external access).
 */
export function getBindingStats() {
  return bindingStats;
}

/**
 * Loads the complete binding list for the active profile from the backend.
 * Contains both default and custom bindings.
 */
export async function loadCompleteBindingList() {
  const s = getState();
  setState({ completeBindingList: [] });
  bindingStats = { total: 0, custom: 0 };

  if (!s.config?.install_path || !s.activeScVersion || !s.lastRestoredBackupId) return;

  try {
    const result = await invoke('get_profile_bindings', {
      gp: s.config.install_path,
      v: s.activeScVersion,
      profileId: s.lastRestoredBackupId,
    });
    setState({ completeBindingList: result.bindings || [] });
    bindingStats = result.stats || { total: 0, custom: 0 };
  } catch (e) {
    debugLog('BINDING', 'error', 'Failed to load profile bindings: ' + e);
    setState({ completeBindingList: [] });
    bindingStats = { total: 0, custom: 0 };
  }
}

/**
 * Parses the actionmaps (actionmaps.xml) for the active version and source.
 * Populates parsedActionMaps with device and binding data.
 */
export async function loadDevicesAndBindings() {
  const s = getState();
  if (!s.config?.install_path || !s.activeScVersion) {
    setState({ parsedActionMaps: null });
    return;
  }
  try {
    const parsedActionMaps = await invoke('parse_actionmaps', {
      gp: s.config.install_path,
      v: s.activeScVersion,
      source: s.selectedBindingSource,
    });
    setState({ parsedActionMaps });
  } catch (e) {
    setState({ parsedActionMaps: null });
  }
}

/**
 * Loads the list of exported keyboard/controller layouts
 * from the active SC version's directory.
 */
export async function loadExportedLayouts() {
  const s = getState();
  if (!s.config?.install_path || !s.activeScVersion) {
    setState({ exportedLayouts: [] });
    return;
  }
  try {
    const exportedLayouts = await invoke('list_exported_layouts', {
      gamePath: s.config.install_path,
      version: s.activeScVersion,
    });
    setState({ exportedLayouts });
  } catch (e) {
    setState({ exportedLayouts: [] });
  }
}

// ==================== In-Place Refresh ====================

/**
 * Lightweight in-place update of the binding list.
 * Avoids a full page re-render and preserves the scroll position.
 * Called after binding changes (add, edit, delete).
 */
export function refreshBindingsInPlace() {
  const s = getState();

  // Recompute categorized list
  const sourceList = s.completeBindingList.filter(b => {
    if (s.customizedOnly && !b.is_custom) return false;
    if (s.essentialsOnly && !ESSENTIAL_ACTIONS.has(b.action_name)) return false;
    if (s.boundOnly && !b.current_input) return false;
    return true;
  });

  const query = (s.bindingFilter || '').toLowerCase();

  const categorized = {};
  for (const b of sourceList) {
    if (query) {
      const inputText = (b.current_input || '').replace(/_/g, ' ');
      const searchable = [b.action_name, b.display_name, b.current_input || '', inputText].join(' ').toLowerCase();
      if (!searchable.includes(query)) continue;
    }
    const catKey = b.category || 'unknown';
    const catLabel = b.category_label || catKey;
    if (!categorized[catKey]) {
      categorized[catKey] = { label: catLabel, bindings: [], customCount: 0 };
    }
    categorized[catKey].bindings.push(b);
    if (b.is_custom) categorized[catKey].customCount++;
  }

  const categoryKeys = Object.keys(categorized).sort((a, b) =>
    (categorized[a].label || '').toLowerCase().localeCompare((categorized[b].label || '').toLowerCase())
  );

  // Ensure activeCategoryKey is valid
  let activeCategoryKey = s.activeCategoryKey;
  if (!activeCategoryKey || !categorized[activeCategoryKey]) {
    activeCategoryKey = categoryKeys[0] || null;
    setState({ activeCategoryKey });
  }

  // Re-render sidebar
  const sidebar = document.getElementById('bindings-sidebar');
  if (sidebar) sidebar.innerHTML = renderBindingSidebar(categorized, categoryKeys);

  // Build device columns
  const activeBackup = s.lastRestoredBackupId ? s.backups.find(b => b.id === s.lastRestoredBackupId) : null;
  const deviceMap = activeBackup?.device_map || [];
  const columns = [
    { id: 'keyboard', label: t('environments:device.keyboard', 'Keyboard'), prefix: 'kb', type: 'keyboard' },
    { id: 'mouse',    label: t('environments:device.mouse',    'Mouse'),    prefix: 'mo', type: 'mouse'    }
  ];
  deviceMap.filter(d => d.device_type === 'joystick')
    .sort((a, b) => parseInt(a.sc_instance) - parseInt(b.sc_instance))
    .forEach(d => columns.push({ id: `js${d.sc_instance}`, label: d.alias || d.product_name, prefix: `js${d.sc_instance}_`, type: 'joystick' }));

  // Re-render table body for active category
  const tbody = document.getElementById('bindings-tbody');
  const activeCat = activeCategoryKey ? categorized[activeCategoryKey] : null;
  if (tbody) {
    tbody.innerHTML = activeCat
      ? renderBindingRows(activeCat.bindings, activeCategoryKey, columns)
      : `<tr><td colspan="${columns.length + 1}" class="binding-empty-row">${t('environments:binding.noCategories', 'Keine Kategorien')}</td></tr>`;
  }

  // Update heading
  const titleEl = document.getElementById('bindings-cat-title');
  const subEl = document.getElementById('bindings-cat-sub');
  if (titleEl && activeCat) titleEl.textContent = activeCat.label;
  if (subEl && activeCat) subEl.textContent = `${activeCat.bindings.length} ${t('environments:binding.actions')}${activeCat.customCount ? ` · ${activeCat.customCount} ${t('environments:binding.customized', 'customized')}` : ''}`;

  // Update stats badge
  const badge = document.querySelector('.binding-stats-badge');
  if (badge) badge.textContent = t('environments:binding.customizedOfTotal', { custom: bindingStats.custom, total: bindingStats.total });

  // Sync toggles
  const customToggle = document.getElementById('customized-only-toggle');
  if (customToggle) customToggle.checked = s.customizedOnly;
  const essentialsToggle = document.getElementById('essentials-only-toggle');
  if (essentialsToggle) essentialsToggle.checked = s.essentialsOnly;
  const boundToggle = document.getElementById('bound-only-toggle');
  if (boundToggle) boundToggle.checked = s.boundOnly;
}

// ==================== Event Listeners ====================

/**
 * Attaches binding-related event listeners using delegation on stable containers.
 */
export function attachBindingEventListeners() {
  const s = getState();

  // Sidebar: category selection (delegated)
  const sidebar = document.getElementById('bindings-sidebar');
  if (sidebar) {
    sidebar.addEventListener('click', (e) => {
      const item = e.target.closest('[data-action="select-binding-category"]');
      if (!item) return;
      setState({ activeCategoryKey: item.dataset.category });
      refreshBindingsInPlace();
    });
  }

  // Search input
  document.getElementById('binding-search')?.addEventListener('input', (e) => {
    setState({ bindingFilter: e.target.value.toLowerCase().trim() });
    refreshBindingsInPlace();
  });

  // Table actions (delegated)
  const tbody = document.getElementById('bindings-tbody');
  if (!tbody) return;

  tbody.addEventListener('click', async (e) => {
    const s = getState();

    // remove-binding-direct
    const removeDirectBtn = e.target.closest('[data-action="remove-binding-direct"]');
    if (removeDirectBtn) {
      e.stopPropagation();
      const actionName = removeDirectBtn.dataset.actionName;
      const category   = removeDirectBtn.dataset.category;
      const input      = removeDirectBtn.dataset.input || '';
      if (!s.lastRestoredBackupId) {
        showNotification(t('environments:notification.noProfileLoaded'), 'error');
        return;
      }
      const confirmed = await confirm(
        t('environments:binding.removeConfirm', { action: actionName }),
        { title: t('environments:binding.removeTitle'), kind: 'warning' }
      );
      if (confirmed) {
        try {
          await invoke('remove_profile_binding', {
            v: s.activeScVersion,
            profileId: s.lastRestoredBackupId,
            actionMap: category,
            actionName: actionName,
            input: input || null,
          });
          showNotification(t('environments:notification.bindingRemoved'), 'success');
          // Cross-module: caller should trigger loadProfileStatus() + renderEnvironments()
        } catch (err) {
          showNotification(t('environments:notification.removeBindingFailed', { error: err }), 'error');
        }
      }
      return;
    }

    // add-binding
    const addBtn = e.target.closest('[data-action="add-binding"]');
    if (addBtn) {
      e.stopPropagation();
      openBindingEditor(addBtn.dataset.actionName, addBtn.dataset.category, null);
      return;
    }

    // matrix-assign
    const matrixBtn = e.target.closest('[data-action="matrix-assign"]');
    if (matrixBtn && !e.target.closest('.binding-pill')) {
      e.stopPropagation();
      const targetInstance = matrixBtn.dataset.targetInstance ? parseInt(matrixBtn.dataset.targetInstance, 10) : null;
      const deviceType = matrixBtn.dataset.deviceType || 'joystick';
      if (deviceType === 'mouse') {
        const existing = s.completeBindingList.find(b =>
          b.action_name === matrixBtn.dataset.actionName &&
          b.current_input &&
          b.current_input.startsWith('mo')
        );
        openMouseBindingEditor(matrixBtn.dataset.actionName, matrixBtn.dataset.category, existing?.current_input || '');
      } else {
        openBindingEditor(matrixBtn.dataset.actionName, matrixBtn.dataset.category, null, deviceType, targetInstance);
      }
      return;
    }

    // edit-binding
    const editBtn = e.target.closest('[data-action="edit-binding"]');
    if (editBtn) {
      e.stopPropagation();
      const cell = editBtn.closest('.binding-matrix-cell');
      const deviceType = cell?.dataset.deviceType || resolveDeviceType(editBtn.dataset.input) || 'joystick';
      const targetInstance = cell?.dataset.targetInstance ? parseInt(cell.dataset.targetInstance, 10) : null;
      if (deviceType === 'mouse') {
        openMouseBindingEditor(editBtn.dataset.actionName, editBtn.dataset.category, editBtn.dataset.input || '');
      } else {
        openBindingEditor(editBtn.dataset.actionName, editBtn.dataset.category, editBtn.dataset.input || '', deviceType, targetInstance);
      }
      return;
    }

    // open-tuning
    const tuningBtn = e.target.closest('[data-action="open-tuning"]');
    if (tuningBtn) {
      e.stopPropagation();
      const cell = tuningBtn.closest('.binding-matrix-cell');
      const targetInstance = cell?.dataset.targetInstance ? parseInt(cell.dataset.targetInstance, 10) : null;
      const deviceType = cell?.dataset.deviceType || 'joystick';
      console.log(`[TUNING-CLICK] Action: ${tuningBtn.dataset.actionName}, Input: ${tuningBtn.dataset.input}, Instance: ${targetInstance}`);
      // Cross-module: openTuningEditor is on window (from environments.js tuning section)
      if (typeof window.openTuningEditor === 'function') {
        window.openTuningEditor(tuningBtn.dataset.actionName, tuningBtn.dataset.category, tuningBtn.dataset.input, deviceType, targetInstance);
      }
      return;
    }

    // add-alt-binding
    const addAltBtn = e.target.closest('[data-action="add-alt-binding"]');
    if (addAltBtn) {
      e.stopPropagation();
      openBindingEditor(addAltBtn.dataset.actionName, addAltBtn.dataset.category, null);
      return;
    }

    // remove-binding (modal delete button)
    const removeBtn = e.target.closest('[data-action="remove-binding"]');
    if (removeBtn) {
      e.stopPropagation();
      const actionName = removeBtn.dataset.actionName;
      const category = removeBtn.dataset.category;
      const input = removeBtn.dataset.input || '';

      if (!s.lastRestoredBackupId) {
        showNotification(t('environments:notification.noProfileLoaded'), 'error');
        return;
      }

      const confirmed = await confirm(t('environments:binding.removeConfirm', { action: actionName }), {
        title: t('environments:binding.removeTitle'),
        kind: 'warning',
      });
      if (confirmed) {
        try {
          await invoke('remove_profile_binding', {
            v: s.activeScVersion,
            profileId: s.lastRestoredBackupId,
            actionMap: category,
            actionName: actionName,
            input: input || null,
          });
          showNotification(t('environments:notification.bindingRemoved'), 'success');
          // Cross-module: caller should trigger loadProfileStatus() + renderEnvironments()
        } catch (err) {
          showNotification(t('environments:notification.removeBindingFailed', { error: err }), 'error');
        }
      }
    }
  });
}

// ==================== Rendering ====================

/**
 * Renders the collapsible keybindings section with search field, filter toggle,
 * and category-based grouping of all bindings.
 */
export function renderBindingsCollapsible() {
  const s = getState();

  const sourceList = s.completeBindingList.filter(b => {
    if (s.customizedOnly && !b.is_custom) return false;
    if (s.essentialsOnly && !ESSENTIAL_ACTIONS.has(b.action_name)) return false;
    if (s.boundOnly && !b.current_input) return false;
    return true;
  });

  const categorized = {};
  for (const b of sourceList) {
    const catKey = b.category || 'unknown';
    const catLabel = b.category_label || catKey;
    if (!categorized[catKey]) {
      categorized[catKey] = { label: catLabel, bindings: [], customCount: 0 };
    }
    categorized[catKey].bindings.push(b);
    if (b.is_custom) categorized[catKey].customCount++;
  }

  const categoryKeys = Object.keys(categorized).sort((a, b) =>
    (categorized[a].label || '').toLowerCase().localeCompare((categorized[b].label || '').toLowerCase())
  );

  // Set initial active category if not set or no longer valid
  let activeCategoryKey = s.activeCategoryKey;
  if (!activeCategoryKey || !categorized[activeCategoryKey]) {
    activeCategoryKey = categoryKeys[0] || null;
    setState({ activeCategoryKey });
  }

  const isExpanded = window.expandedPanels?.bindings === true;
  const activeCat = activeCategoryKey ? categorized[activeCategoryKey] : null;
  const activeBackup = s.lastRestoredBackupId ? s.backups.find(b => b.id === s.lastRestoredBackupId) : null;
  const deviceMap = activeBackup?.device_map || [];

  // Build device columns
  const columns = [
    { id: 'keyboard', label: t('environments:device.keyboard', 'Keyboard'), prefix: 'kb', type: 'keyboard' },
    { id: 'mouse',    label: t('environments:device.mouse',    'Mouse'),    prefix: 'mo', type: 'mouse'    }
  ];
  deviceMap.filter(d => d.device_type === 'joystick')
    .sort((a, b) => parseInt(a.sc_instance) - parseInt(b.sc_instance))
    .forEach(d => columns.push({
      id: `js${d.sc_instance}`,
      label: d.alias || d.product_name,
      prefix: `js${d.sc_instance}_`,
      type: 'joystick'
    }));

  // Device colour dots
  const deviceDotColors = ['#5bc4e8', '#b688f5', '#f5a623', '#f5a623', '#f5a623'];

  const tableBody = activeCat
    ? renderBindingRows(activeCat.bindings, activeCategoryKey, columns)
    : `<tr><td colspan="${columns.length + 1}" class="binding-empty-row">${t('environments:binding.noCategories', 'Keine Kategorien')}</td></tr>`;

  return `
    <div class="sc-section collapsible-section">
      <div class="collapsible-header" data-panel="bindings">
        <span class="collapsible-toggle ${isExpanded ? '' : 'collapsed'}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"></polyline></svg>
        </span>
        <h3>
          ${t('environments:binding.title')}
          <span class="binding-stats-badge">
            ${t('environments:binding.customizedOfTotal', { custom: bindingStats.custom, total: bindingStats.total })}
          </span>
          ${s.localizationLoading ? `<span class="loading-spinner-inline"></span>` : ''}
        </h3>
      </div>
      <div class="collapsible-content ${isExpanded ? '' : 'collapsed'}">
        ${renderHint('bindings-intro', t('environments:hint.bindingsIntro'))}

        <!-- Toolbar -->
        <div class="bindings-toolbar">
          <input type="text" class="input binding-search" id="binding-search"
                 placeholder="${t('environments:binding.searchPlaceholder')}"
                 value="${escapeHtml(s.bindingFilter)}"
                 aria-label="Search bindings" />
          <div class="bindings-filter-bar">
            <label class="filter-toggle" title="${t('environments:binding.customizedOnly')}">
              <span class="toggle-switch">
                <input type="checkbox" id="customized-only-toggle" ${s.customizedOnly ? 'checked' : ''}>
                <span class="toggle-slider"></span>
              </span>
              <span>${t('environments:binding.customizedOnly')}</span>
            </label>
            <label class="filter-toggle" title="${t('environments:binding.essentialsOnlyTooltip')}">
              <span class="toggle-switch">
                <input type="checkbox" id="essentials-only-toggle" ${s.essentialsOnly ? 'checked' : ''}>
                <span class="toggle-slider"></span>
              </span>
              <span>${t('environments:binding.essentialsOnly')}</span>
            </label>
            <label class="filter-toggle" title="${t('environments:binding.boundOnlyTooltip', 'Show only actions with at least one binding')}">
              <span class="toggle-switch">
                <input type="checkbox" id="bound-only-toggle" ${s.boundOnly ? 'checked' : ''}>
                <span class="toggle-slider"></span>
              </span>
              <span>${t('environments:binding.boundOnly', 'Bound only')}</span>
            </label>
          </div>
        </div>

        <!-- Sidebar + Table layout -->
        <div class="bindings-layout">
          <!-- Left: category sidebar -->
          <div class="bindings-sidebar" id="bindings-sidebar">
            ${renderBindingSidebar(categorized, categoryKeys)}
          </div>

          <!-- Right: active category table -->
          <div class="bindings-table-pane">
            <div class="bindings-cat-heading">
              <span class="bindings-cat-title" id="bindings-cat-title">
                ${activeCat ? escapeHtml(activeCat.label) : ''}
              </span>
              <span class="bindings-cat-sub" id="bindings-cat-sub">
                ${activeCat ? `${activeCat.bindings.length} ${t('environments:binding.actions')}${activeCat.customCount ? ` · ${activeCat.customCount} ${t('environments:binding.customized', 'customized')}` : ''}` : ''}
              </span>
            </div>
            <div class="bindings-col-header">
              <div class="bindings-col-th bindings-col-action">${t('environments:binding.columnAction')}</div>
              ${columns.map((col, i) => `
                <div class="bindings-col-th">
                  <span class="col-device-dot" style="background:${deviceDotColors[i] || '#f5a623'}"></span>
                  ${escapeHtml(col.label)}
                </div>
              `).join('')}
            </div>
            <div class="bindings-table-body" id="bindings-table-body">
              <table class="bindings-matrix-table">
                <colgroup>
                  <col style="width: 28%">
                  ${columns.map(() => `<col>`).join('')}
                </colgroup>
                <tbody id="bindings-tbody">
                  ${tableBody}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;
}

/**
 * Renders the sidebar category list for the binding layout.
 */
export function renderBindingSidebar(categorized, categoryKeys) {
  const s = getState();
  if (categoryKeys.length === 0) {
    return `<div class="binding-sidebar-empty">${t('environments:binding.noCategories', 'No categories')}</div>`;
  }

  return categoryKeys.map(key => {
    const cat = categorized[key];
    const isActive = key === s.activeCategoryKey;
    const hasCustom = cat.customCount > 0;
    return `
      <div class="binding-sidebar-item ${isActive ? 'active' : ''}"
           data-action="select-binding-category"
           data-category="${escapeHtml(key)}"
           title="${escapeHtml(cat.label)}">
        <span class="binding-sidebar-dot ${hasCustom ? 'has-custom' : ''}"></span>
        <span class="binding-sidebar-label">${escapeHtml(cat.label)}</span>
        <span class="binding-sidebar-count">${cat.bindings.length}</span>
      </div>
    `;
  }).join('');
}

/**
 * Renders <tr> rows for the active category in the binding table.
 */
export function renderBindingRows(items, categoryKey, columns) {
  const s = getState();

  // Group by action_name
  const groupedActions = {};
  for (const b of items) {
    if (!groupedActions[b.action_name]) {
      groupedActions[b.action_name] = {
        action_name: b.action_name,
        display_name: b.display_name,
        category: b.category,
        bindings: []
      };
    }
    if (b.current_input) {
      groupedActions[b.action_name].bindings.push(b);
    }
  }

  const actionList = Object.values(groupedActions);
  const query = (s.bindingFilter || '').toLowerCase();

  const filteredGroups = !query ? actionList : actionList.filter(group => {
    let searchableText = [group.action_name, group.display_name, group.category].join(' ').toLowerCase();
    for (const b of group.bindings) {
      const inputDisplay = s.useHumanReadable ? formatInputDisplayText(b.current_input) : b.current_input;
      searchableText += ' ' + [b.current_input, inputDisplay].join(' ').toLowerCase();
      searchableText += ' ' + (b.current_input || '').replace(/_/g, ' ');
    }
    return searchableText.includes(query);
  });

  if (filteredGroups.length === 0) {
    return `<tr><td colspan="${columns.length + 1}" class="binding-empty-row">${t('environments:binding.noResults', 'Keine Ergebnisse')}</td></tr>`;
  }

  const isAxisInput = (input) => {
    if (!input) return false;
    const lower = input.toLowerCase();
    return lower.includes('_x') || lower.includes('_y') || lower.includes('_z') ||
           lower.includes('_rot') || lower.includes('_throttle') || lower.includes('_slider');
  };

  // Cross-module: needs deviceTuningData and resolveTuningName from environments.js tuning section
  const deviceTuningData = s.deviceTuningData || [];

  // Inline tuning name resolver (mirrors SC_ACTION_TO_TUNING_MAP from environments.js)
  const resolveTuningName = (actionName) => {
    if (!actionName) return 'master';
    const map = {
      'v_pitch': 'flight_move_pitch', 'v_yaw': 'flight_move_yaw', 'v_roll': 'flight_move_roll',
      'v_strafe_vertical': 'flight_move_strafe_vertical', 'v_strafe_up': 'flight_move_strafe_vertical',
      'v_strafe_down': 'flight_move_strafe_vertical', 'v_strafe_horizontal': 'flight_move_strafe_lateral',
      'v_strafe_lateral': 'flight_move_strafe_lateral', 'v_strafe_left': 'flight_move_strafe_lateral',
      'v_strafe_right': 'flight_move_strafe_lateral', 'v_strafe_longitudinal': 'flight_move_strafe_longitudinal',
      'v_strafe_forward': 'flight_strafe_forward', 'v_strafe_backward': 'flight_strafe_backward',
      'v_ifcs_speed_limiter_abs': 'flight_move_speed_range_abs', 'v_ifcs_speed_limiter_rel': 'flight_move_speed_range_rel',
      'v_ifcs_throttle_abs': 'flight_throttle_abs', 'v_ifcs_throttle_rel': 'flight_throttle_rel',
      'v_throttle_abs': 'flight_throttle_abs', 'v_throttle_rel': 'flight_throttle_rel',
      'v_view_pitch': 'flight_view', 'v_view_yaw': 'flight_view',
      'v_mining_throttle': 'mining_throttle', 'v_increase_mining_throttle': 'mining_throttle',
      'v_decrease_mining_throttle': 'mining_throttle', 'v_aim_pitch': 'flight_aim', 'v_aim_yaw': 'flight_aim',
      'turret_pitch': 'turret_aim', 'turret_yaw': 'turret_aim',
      'v_ifcs_accel_limiter_abs': 'flight_move_accel_range_abs', 'v_ifcs_accel_limiter_rel': 'flight_move_accel_range_rel',
    };
    return map[actionName] || actionName;
  };

  return filteredGroups.map(group => {
    let rowHtml = `
      <tr class="binding-row" data-action-name="${escapeHtml(group.action_name)}" data-display-name="${escapeHtml(group.display_name || '')}">
        <td class="binding-action-cell">
          <div class="binding-action-name">${escapeHtml(group.display_name || group.action_name)}</div>
          <div class="binding-action-key">${escapeHtml(group.action_name)}</div>
        </td>
    `;

    for (const col of columns) {
      const colBindings = group.bindings.filter(b =>
        b.current_input.startsWith(col.prefix) && !b.current_input.endsWith('_')
      );
      const targetInstance = parseInt(col.id.replace(/\D/g, '')) || 0;

      rowHtml += `
        <td class="binding-matrix-cell"
            data-action="matrix-assign"
            data-action-name="${escapeHtml(group.action_name)}"
            data-category="${escapeHtml(categoryKey)}"
            data-device-type="${escapeHtml(col.type)}"
            data-target-instance="${targetInstance}">
          <div class="binding-cell-inner">
      `;

      if (colBindings.length > 0) {
        colBindings.forEach(b => {
          const inputDisplay = s.useHumanReadable ? formatInputDisplayText(b.current_input) : b.current_input;
          const isAxis = isAxisInput(b.current_input);
          const tuningName = resolveTuningName(b.action_name);
          const device = deviceTuningData.find(d => d.instance === targetInstance && d.device_type === col.type);

          let hasActiveTuning = false;
          if (device) {
            const tn = device.tuning.find(x => x.name === tuningName);
            if (tn && (tn.invert !== 0 || tn.exponent !== 1.0 || tn.sensitivity !== 1.0)) hasActiveTuning = true;
            if (!hasActiveTuning) {
              const axisInput = b.current_input.split('_').pop();
              const opt = device.axis_options.find(o => o.input === axisInput);
              if (opt && (opt.deadzone > 0 || opt.saturation < 1.0)) hasActiveTuning = true;
            }
          }

          rowHtml += `
            <div class="binding-pill ${b.is_custom ? 'custom' : 'default'}">
              <span class="binding-pill-label"
                    data-action="edit-binding"
                    data-action-name="${escapeHtml(b.action_name)}"
                    data-category="${escapeHtml(categoryKey)}"
                    data-input="${escapeHtml(b.current_input)}">${escapeHtml(inputDisplay)}</span>
              ${isAxis && col.type !== 'mouse' ? `
                <button class="binding-pill-tuning ${hasActiveTuning ? 'has-active-tuning' : ''}"
                        data-action="open-tuning"
                        data-action-name="${escapeHtml(b.action_name)}"
                        data-category="${escapeHtml(categoryKey)}"
                        data-input="${escapeHtml(b.current_input)}"
                        title="${hasActiveTuning ? t('environments:binding.hasTuning') : t('environments:binding.tuning')}">
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M3 19s4-15 9-15 9 15 9 15"/></svg>
                </button>
              ` : ''}
              <button class="binding-pill-remove"
                      data-action="remove-binding-direct"
                      data-action-name="${escapeHtml(b.action_name)}"
                      data-category="${escapeHtml(categoryKey)}"
                      data-input="${escapeHtml(b.current_input)}"
                      title="${t('environments:binding.remove')}">×</button>
            </div>
          `;
        });
      } else {
        rowHtml += `
          <button class="binding-cell-add"
                  data-action="matrix-assign"
                  data-action-name="${escapeHtml(group.action_name)}"
                  data-category="${escapeHtml(categoryKey)}"
                  data-device-type="${escapeHtml(col.type)}"
                  data-target-instance="${targetInstance}"
                  title="${t('environments:binding.clickToAssign', 'Zuweisen')}">+</button>
        `;
      }

      rowHtml += `</div></td>`;
    }

    rowHtml += `</tr>`;
    return rowHtml;
  }).join('');
}

// ==================== Helper Functions ====================

/**
 * Determines the device type based on the input prefix.
 */
export function resolveDeviceType(input) {
  if (!input) return 'none';
  if (input.startsWith('kb')) return 'keyboard';
  if (input.startsWith('mo')) return 'mouse';
  if (input.startsWith('xi') || input.startsWith('gp')) return 'gamepad';
  if (input.startsWith('js')) return 'joystick';
  return 'unknown';
}

/**
 * Translates a device type key into a human-readable label.
 */
export function formatDeviceType(deviceType) {
  const labels = {
    keyboard: t('environments:device.keyboard'),
    mouse: t('environments:device.mouse'),
    gamepad: t('environments:device.gamepad'),
    joystick: t('environments:device.joystick'),
    none: t('environments:device.none'),
    unknown: t('environments:device.unknown'),
  };
  return labels[deviceType] || deviceType;
}

/**
 * Resolve a concrete device name from the active profile's device_map.
 */
export function resolveDeviceLabel(input) {
  if (!input) return 'Unbound';
  const s = getState();
  const deviceType = resolveDeviceType(input);

  const instanceMatch = input.match(/^js(\d+)_/);
  if (instanceMatch) {
    const scInstance = parseInt(instanceMatch[1], 10);
    const activeBackup = s.lastRestoredBackupId ? s.backups.find(b => b.id === s.lastRestoredBackupId) : null;
    const deviceMap = activeBackup?.device_map || [];
    const dm = deviceMap.find(d => d.sc_instance === scInstance && d.device_type === 'joystick');
    if (dm) {
      return dm.alias || dm.product_name;
    }
    return `Joystick ${scInstance}`;
  }

  return formatDeviceType(deviceType);
}

/**
 * Generates an inline SVG icon for the given device type.
 */
export function getDeviceIconSvg(deviceType) {
  const icons = {
    keyboard: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><line x1="6" y1="8" x2="6" y2="8"/><line x1="10" y1="8" x2="10" y2="8"/><line x1="14" y1="8" x2="14" y2="8"/><line x1="18" y1="8" x2="18" y2="8"/><line x1="6" y1="12" x2="6" y2="12"/><line x1="10" y1="12" x2="10" y2="12"/><line x1="14" y1="12" x2="14" y2="12"/><line x1="18" y1="12" x2="18" y2="12"/><line x1="8" y1="16" x2="16" y2="16"/></svg>`,
    mouse: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="2" width="12" height="20" rx="6"/><line x1="12" y1="6" x2="12" y2="10"/></svg>`,
    joystick: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3"/><line x1="12" y1="3" x2="12" y2="6"/><line x1="12" y1="18" x2="12" y2="21"/><line x1="3" y1="12" x2="6" y2="12"/><line x1="18" y1="12" x2="21" y2="12"/></svg>`,
    gamepad: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="6" width="20" height="12" rx="4"/><circle cx="6" cy="12" r="2"/><circle cx="10" cy="9" r="1"/><circle cx="14" cy="9" r="1"/><circle cx="18" cy="12" r="2"/></svg>`,
  };
  const icon = icons[deviceType] || icons.joystick;
  return `<span class="device-icon">${icon}</span>`;
}

/**
 * Converts a raw input format into human-readable text.
 */
export function formatInputDisplayText(input) {
  if (!input) return '';

  const btnMatch = input.match(/button(\d+)/i);
  if (btnMatch) return `Button #${btnMatch[1]}`;

  const povMatch = input.match(/pov(\d+)/i);
  if (povMatch) return `POV #${povMatch[1]}`;

  const axisMap = {
    x: 'X-Axis', y: 'Y-Axis', z: 'Z-Axis',
    rotx: 'Rot X', roty: 'Rot Y', rotz: 'Rot Z',
    slider1: 'Slider 1', slider2: 'Slider 2'
  };
  const axisMatch = input.match(/(x|y|z|rotx|roty|rotz|slider1|slider2)(neg|pos)?/i);
  if (axisMatch) {
    const baseAxis = axisMap[axisMatch[1].toLowerCase()];
    if (baseAxis) {
      const suffix = axisMatch[2] ? (axisMatch[2].toLowerCase() === 'neg' ? ' (-)' : ' (+)') : '';
      return baseAxis + suffix;
    }
  }

  const hatDirMatch = input.match(/hat(\d+)_(up|down|left|right)/i);
  if (hatDirMatch) {
    const hatNum = hatDirMatch[1];
    const dir = hatDirMatch[2].toLowerCase();
    const dirMap = { up: '↑ Up', down: '↓ Down', left: '← Left', right: '→ Right' };
    return `Hat #${hatNum} ${dirMap[dir] || dir}`;
  }

  const hatMatch = input.match(/hat(\d+)/i);
  if (hatMatch) return `Hat #${hatMatch[1]}`;

  return input;
}

/**
 * Strips the device prefix for display.
 */
export function stripDevicePrefix(input) {
  if (!input) return input;
  return input.replace(/^(js|kb|mo)\d+_/, '');
}

// ==================== Binding Editor ====================

/**
 * Opens the binding editor as a modal window.
 * Supports keyboard, mouse, and joystick/gamepad input capture.
 */
export async function openBindingEditor(actionName, category, currentInput, defaultDeviceType = null, targetInstance = null) {
  const s = getState();
  setState({ bindingEditorAction: { actionName, category, currentInput } });

  if (targetInstance === null && currentInput) {
    const match = currentInput.match(/^(js|gp)(\d+)_/);
    if (match) targetInstance = parseInt(match[2], 10);
  }

  const bindingEditorDevice = defaultDeviceType || resolveDeviceType(currentInput) || 'keyboard';
  setState({ bindingEditorDevice });

  if (targetInstance === null) {
    debugLog('editor', 'debug', 'No target instance provided, defaulting to auto-detect (no filter)');
  }

  // Create modal
  const modal = document.createElement('div');
  modal.className = 'modal-overlay';
  modal.id = 'binding-editor-modal';

  const isEdit = currentInput && currentInput.length > 0;
  const title = isEdit ? t('environments:binding.editor.editTitle') : t('environments:binding.editor.addTitle');

  modal.innerHTML = `
    <div class="modal-content binding-editor-modal">
      <div class="modal-header">
        <h3>${title}</h3>
        <button class="modal-close" data-action="close-binding-editor">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18"></line>
            <line x1="6" y1="6" x2="18" y2="18"></line>
          </svg>
        </button>
      </div>
      <div class="modal-body">
        <div class="binding-editor-context">
          <span class="binding-editor-context-action">${escapeHtml(actionName)}</span>
          <span class="binding-editor-context-sep">/</span>
          <span class="binding-editor-context-category">${escapeHtml(category)}</span>
        </div>
        <div class="capture-zone" id="capture-container">
          <label class="capture-zone-label">${t('environments:binding.editor.pressKey')}</label>
          <div class="capture-zone-input-wrap">
            <input type="text" class="capture-input" id="binding-input-field"
                   value="${stripDevicePrefix(currentInput) || ''}"
                   placeholder="${t('environments:binding.editor.waitingForInput')}" readonly
                   aria-label="Captured input">
          </div>
        </div>
        <div class="binding-editor-device">
          <label>${t('environments:binding.editor.device')}</label>
          <select id="capture-device-select" class="capture-device-select" aria-label="${t('environments:binding.editor.device')}">
            <option value="">${t('environments:binding.editor.loadingDevices')}</option>
          </select>
        </div>
      </div>
      <div class="modal-footer">
        <div class="modal-footer-left">
          ${isEdit ? `<button class="btn btn-danger" id="btn-delete-binding">${t('environments:binding.editor.deleteBtn')}</button>` : ''}
          <button class="btn btn-secondary" id="btn-reset-binding" title="${t('environments:binding.editor.resetTooltip', 'Alle eigenen Aenderungen entfernen und Default wiederherstellen')}">${t('environments:binding.editor.resetBtn', 'Reset to Default')}</button>
        </div>
        <div class="modal-footer-actions">
          <button class="btn btn-secondary" data-action="close-binding-editor">${t('environments:binding.editor.cancelBtn')}</button>
          <button class="btn btn-primary" id="btn-save-binding">${t('environments:binding.editor.saveBtn')}</button>
        </div>
      </div>
    </div>
  `;

  document.body.appendChild(modal);
  requestAnimationFrame(() => modal.classList.add('show'));

  const activeBackup = s.lastRestoredBackupId ? s.backups.find(b => b.id === s.lastRestoredBackupId) : null;
  const profileDeviceMap = activeBackup?.device_map || [];

  const deviceSelect = modal.querySelector('#capture-device-select');
  let connectedDevices = [];

  const dmap = window.activeBackup?.device_map || [];
  invoke('list_connected_devices', { deviceMap: dmap }).then(devices => {
    connectedDevices = devices || [];
    debugLog('editor', 'debug', `Connected devices: ${JSON.stringify(connectedDevices)}`);
    if (profileDeviceMap.length > 0) {
      deviceSelect.innerHTML = `
        <option value="">${t('environments:binding.editor.autoDetect')}</option>
        ${profileDeviceMap.map(dm => {
          const connected = connectedDevices.find(cd =>
            cd.product_name.toLowerCase() === dm.product_name.toLowerCase()
          );
          const alias = dm.alias || dm.product_name;
          const status = connected ? '●' : '○';
          return `
            <option value="${escapeHtml(dm.product_name)}" data-sc-instance="${dm.sc_instance}">
              ${status} ${escapeHtml(alias)} (SC js${dm.sc_instance})
            </option>
          `;
        }).join('')}
      `;
    } else if (connectedDevices.length > 0) {
      deviceSelect.innerHTML = `
        <option value="">${t('environments:binding.editor.autoDetect')}</option>
        ${connectedDevices.map(d => `
          <option value="${escapeHtml(d.product_name)}" data-instance="${d.instance}">
            ${escapeHtml(d.product_name)} (js${d.instance})
          </option>
        `).join('')}
      `;
    } else {
      deviceSelect.innerHTML = `<option value="">${t('environments:binding.editor.noDeviceDetected')}</option>`;
    }
  }).catch(err => {
    console.error('[EDITOR] Failed to list devices:', err);
    deviceSelect.innerHTML = `<option value="">${t('environments:binding.editor.errorLoadingDevices')}</option>`;
  });

  const inputField = modal.querySelector('#binding-input-field');
  let inputCapturedUnlisten = null;
  let isLocked = false;
  let capturedDeviceUuid = '';
  let capturedDeviceName = '';
  let capturedRawCode = currentInput || '';

  const setCapturedInput = (captureData) => {
    if (isLocked) return;
    isLocked = true;

    let code = '';
    let deviceUuid = '';
    let deviceName = '';

    if (typeof captureData === 'string') {
      code = captureData;
      inputField.value = stripDevicePrefix(code);
    } else if (typeof captureData === 'object' && captureData !== null) {
      code = captureData.input || '';
      deviceUuid = captureData.linux_uuid || '';
      deviceName = captureData.product_name || '';
      capturedDeviceUuid = deviceUuid;
      capturedDeviceName = deviceName;

      const displayCode = stripDevicePrefix(code);
      const dmEntry = profileDeviceMap.find(dm =>
        (dm.product_name || '').toLowerCase().includes((deviceName || '').toLowerCase())
        || (deviceName || '').toLowerCase().includes((dm.product_name || '').toLowerCase())
      );
      const displayName = dmEntry?.alias || deviceName;
      inputField.value = displayName ? `${displayCode} (${displayName})` : displayCode;
    }

    capturedRawCode = code;
    inputField.classList.add('captured-pulse');

    setTimeout(() => {
      inputField.classList.remove('captured-pulse');
      isLocked = false;
    }, 1000);
  };

  listen('input-captured', (event) => {
    debugLog('editor', 'debug', `Hardware event received from Rust: ${JSON.stringify(event.payload)}`);
    setCapturedInput(event.payload);
  }).then(unlisten => {
    inputCapturedUnlisten = unlisten;
  });

  const handleKeyDownCapture = (e) => {
    e.preventDefault();
    if (['Control', 'Alt', 'Shift', 'Meta', 'AltGraph'].includes(e.key)) return;

    const parts = [];
    if (e.ctrlKey) parts.push('lctrl');
    if (e.altKey || e.key === 'AltGraph') parts.push('lalt');
    if (e.shiftKey) parts.push('lshift');

    let key = e.key.toLowerCase();
    const keyMap = { 'arrowup': 'up', 'arrowdown': 'down', 'arrowleft': 'left', 'arrowright': 'right', ' ': 'space', 'escape': 'esc', 'enter': 'return', 'backspace': 'backspace', 'tab': 'tab', 'insert': 'insert', 'delete': 'delete', 'home': 'home', 'end': 'end', 'pageup': 'pgup', 'pagedown': 'pgdn' };
    if (keyMap[key]) key = keyMap[key];

    if (key.length === 1 || key.startsWith('f') || keyMap[e.key.toLowerCase()]) {
      parts.push(key);
      setCapturedInput(`kb1_${parts.join('+')}`);
    }
  };

  const handleMouseDownCapture = (e) => {
    if (e.button === 0) return;
    const btnMap = { 1: 'button3', 2: 'button2', 3: 'button4', 4: 'button5' };
    const btn = btnMap[e.button];
    if (btn) {
      setCapturedInput(`mo1_${btn}`);
    }
  };

  window.addEventListener('keydown', handleKeyDownCapture);
  window.addEventListener('mousedown', handleMouseDownCapture);

  console.log(`[EDITOR] Starting hardware capture: targetInstance=${targetInstance}, targetType=${bindingEditorDevice}`);
  invoke('load_config').catch(err => { logError(err, 'environments:load_config'); return null; }).then(cfg => {
    invoke('start_input_capture', {
      deviceMap: profileDeviceMap,
      targetInstance: targetInstance,
      targetType: bindingEditorDevice,
      installPath: cfg?.install_path ?? null,
      selectedRunner: cfg?.selected_runner ?? null,
    }).catch(err => {
      console.error('[EDITOR] Backend capture start failed:', err);
      showNotification(t('environments:notification.captureError', { error: err }), 'error');
    });
  });

  const cleanupAndClose = () => {
    invoke('stop_input_capture');
    if (s.lastRestoredBackupId && s.activeScVersion) {
      invoke('get_wine_axis_mappings').then(mappings => {
        if (Object.keys(mappings).length > 0) {
          invoke('update_profile_device_wine_maps', {
            v: s.activeScVersion,
            profileId: s.lastRestoredBackupId,
            instanceMappings: mappings,
          }).catch(e => console.warn('[WINE] Failed to persist axis mappings:', e));
        }
      }).catch(() => {});
    }
    if (inputCapturedUnlisten) inputCapturedUnlisten();
    window.removeEventListener('keydown', handleKeyDownCapture);
    window.removeEventListener('mousedown', handleMouseDownCapture);
    modal.classList.remove('show');
    setTimeout(() => modal.remove(), 200);
    setState({ bindingEditorAction: null });
  };

  modal.querySelectorAll('[data-action="close-binding-editor"]').forEach(btn => {
    btn.addEventListener('click', cleanupAndClose);
  });
  modal.addEventListener('click', (e) => { if (e.target === modal) cleanupAndClose(); });

  modal.querySelector('#btn-delete-binding')?.addEventListener('click', async () => {
    const s = getState();
    if (!s.lastRestoredBackupId) {
      showNotification(t('environments:notification.noProfileLoaded'), 'error');
      return;
    }
    try {
      await invoke('remove_profile_binding', {
        v: s.activeScVersion, profileId: s.lastRestoredBackupId,
        actionMap: category, actionName: actionName, input: currentInput || null,
      });
      showNotification(t('environments:notification.bindingRemoved'), 'success');
      if (s.bindingEditorAction?.category) {
        window.expandedBindingCategories.add(s.bindingEditorAction.category);
      }
      cleanupAndClose();
      // Cross-module: caller should trigger loadProfileStatus() + renderEnvironments()
    } catch (err) {
      console.error('[EDITOR] Delete failed:', err);
      showNotification(t('environments:notification.deleteError', { error: err }), 'error');
    }
  });

  modal.querySelector('#btn-reset-binding')?.addEventListener('click', async () => {
    const s = getState();
    if (!s.lastRestoredBackupId) {
      showNotification(t('environments:notification.noProfileLoaded'), 'error');
      return;
    }
    try {
      await invoke('reset_profile_binding', {
        v: s.activeScVersion, profileId: s.lastRestoredBackupId,
        actionMap: category, actionName: actionName,
      });
      showNotification(t('environments:notification.bindingReset', 'Binding auf Default zurueckgesetzt'), 'success');
      if (s.bindingEditorAction?.category) {
        window.expandedBindingCategories.add(s.bindingEditorAction.category);
      }
      cleanupAndClose();
      // Cross-module: caller should trigger loadProfileStatus() + renderEnvironments()
    } catch (err) {
      console.error('[EDITOR] Reset failed:', err);
      showNotification(t('environments:notification.resetError', { error: err }), 'error');
    }
  });

  modal.querySelector('#btn-save-binding').addEventListener('click', async () => {
    const s = getState();
    const newInput = capturedRawCode.trim();
    if (!newInput) {
      showNotification(t('environments:notification.noInputCaptured'), 'error');
      return;
    }

    if (s.completeBindingList.length > 0) {
      const newInputBare = stripDevicePrefix(newInput);
      const newPrefix = (newInput.match(/^(js|kb|mo|gp|xi)\d+/) || [''])[0];
      const captureDev = (capturedDeviceName || '').trim().toLowerCase();
      const conflicting = s.completeBindingList.find(b => {
        if (b.action_name === actionName || !b.current_input) return false;
        const existingBare = stripDevicePrefix(b.current_input);
        if (existingBare !== newInputBare) return false;
        const existingPrefix = (b.current_input.match(/^(js|kb|mo|gp|xi)\d+/) || [''])[0];
        if (newPrefix && existingPrefix && newPrefix === existingPrefix) return true;
        const existingDev = (b.device_type || '').trim().toLowerCase();
        return captureDev && existingDev && (captureDev.includes(existingDev) || existingDev.includes(captureDev));
      });
      if (conflicting) {
        const displayInput = stripDevicePrefix(newInput);
        const proceed = await confirm(
          t('environments:binding.editor.conflictMsg', { input: displayInput, action: conflicting.display_name || conflicting.action_name }),
          { title: t('environments:binding.editor.conflictTitle'), kind: 'warning' }
        );
        if (!proceed) return;
      }
    }

    if (!s.lastRestoredBackupId) {
      showNotification(t('environments:notification.noProfileForSave'), 'error');
      return;
    }

    try {
      let oldInput = currentInput || null;
      if (!oldInput) {
        const newPrefix = (newInput.match(/^(js|kb|mo|gp|xi)\d+_/) || [])[0];
        if (newPrefix) {
          const prefixType = newPrefix.replace(/\d+_$/, '');
          const sameTypeBinding = s.completeBindingList.find(b =>
            b.action_name === actionName
            && b.category === category
            && b.current_input
            && b.current_input.startsWith(prefixType)
          );
          if (sameTypeBinding) {
            oldInput = sameTypeBinding.current_input;
          }
        }
      }

      const sessionWineMaps = await invoke('get_wine_axis_mappings').catch(() => ({}));

      await invoke('assign_profile_binding', {
        v: s.activeScVersion, profileId: s.lastRestoredBackupId,
        actionMap: category, actionName: actionName,
        newInput: newInput, oldInput,
        wineAxisMap: Object.keys(sessionWineMaps).length > 0 ? sessionWineMaps : null,
      });

      showNotification(t('environments:notification.bindingSaved'), 'success');
      if (s.bindingEditorAction?.category) {
        window.expandedBindingCategories.add(s.bindingEditorAction.category);
      }
      cleanupAndClose();
      // Cross-module: caller should trigger loadProfileStatus() + renderEnvironments()
    } catch (err) {
      console.error('[EDITOR] Save failed. Error:', err);
      showNotification(t('environments:notification.saveError', { error: err }), 'error');
    }
  });

  document.body.appendChild(modal);
}

// ==================== Mouse Binding Editor ====================

/**
 * Opens a mouse-specific binding dialog showing a static list of SC-compatible
 * mouse inputs. Does NOT use live input capture.
 */
export async function openMouseBindingEditor(actionName, category, currentInput) {
  const s = getState();
  const displayName = (s.completeBindingList.find(b => b.action_name === actionName) || {}).display_name || actionName;

  const MOUSE_INPUTS = [
    { section: 'axes', icon: '↔', code: 'mo1_maxis_x',      labelKey: 'binding.mouse.axisX' },
    { section: 'axes', icon: '↕', code: 'mo1_maxis_y',      labelKey: 'binding.mouse.axisY' },
    { section: 'scroll', icon: '▲', code: 'mo1_mwheel_up',    labelKey: 'binding.mouse.wheelUp' },
    { section: 'scroll', icon: '▼', code: 'mo1_mwheel_down',  labelKey: 'binding.mouse.wheelDown' },
    { section: 'scroll', icon: '►', code: 'mo1_mhwheel_right',labelKey: 'binding.mouse.hWheelRight' },
    { section: 'scroll', icon: '◄', code: 'mo1_mhwheel_left', labelKey: 'binding.mouse.hWheelLeft' },
    { section: 'buttons', icon: '◉', code: 'mo1_mouse1', labelKey: 'binding.mouse.btn1' },
    { section: 'buttons', icon: '◉', code: 'mo1_mouse2', labelKey: 'binding.mouse.btn2' },
    { section: 'buttons', icon: '⊙', code: 'mo1_mouse3', labelKey: 'binding.mouse.btn3' },
    { section: 'buttons', icon: '◂', code: 'mo1_mouse4', labelKey: 'binding.mouse.btn4' },
    { section: 'buttons', icon: '▸', code: 'mo1_mouse5', labelKey: 'binding.mouse.btn5' },
  ];

  const SECTION_LABELS = {
    axes:    { key: 'binding.mouse.sectionAxes',    title: t('environments:binding.mouse.sectionAxes',    'Movement Axes') },
    scroll:  { key: 'binding.mouse.sectionScroll',  title: t('environments:binding.mouse.sectionScroll',  'Scroll Wheels') },
    buttons: { key: 'binding.mouse.sectionButtons', title: t('environments:binding.mouse.sectionButtons', 'Buttons') },
  };

  let selectedCode = currentInput || '';

  const renderRows = () => {
    return ['axes', 'scroll', 'buttons'].map(section => {
      const rows = MOUSE_INPUTS.filter(inp => inp.section === section).map(inp => {
        const isSelected = inp.code === selectedCode;
        return `
        <div class="mouse-binding-row ${isSelected ? 'selected' : ''}"
             data-action="mouse-input-select"
             data-code="${escapeHtml(inp.code)}">
          <div class="mouse-binding-icon">${escapeHtml(inp.icon)}</div>
          <div class="mouse-binding-info">
            <div class="mouse-binding-name">${escapeHtml(t(`environments:${inp.labelKey}`, inp.labelKey))}</div>
            <div class="mouse-binding-code">${escapeHtml(inp.code)}</div>
          </div>
          <div class="mouse-binding-radio ${isSelected ? 'on' : ''}"></div>
        </div>`;
      }).join('');
      return `<div class="mouse-binding-column">
        <div class="mouse-binding-section-title">${escapeHtml(SECTION_LABELS[section].title)}</div>
        ${rows}
      </div>`;
    }).join('');
  };

  const currentDisplay = currentInput
    ? `<span class="mouse-binding-current-val">${escapeHtml(currentInput)}</span>`
    : `<span class="mouse-binding-current-empty">${t('environments:binding.mouse.unbound', 'none')}</span>`;

  const modal = document.createElement('div');
  modal.className = 'modal-overlay';
  modal.id = 'mouse-binding-editor-modal';

  modal.innerHTML = `
    <div class="modal-content mouse-binding-modal">
      <div class="modal-header">
        <div>
          <h3>${t('environments:binding.mouse.title', 'Mouse Binding')}</h3>
          <div class="binding-editor-context">
            <span class="binding-editor-context-action">${escapeHtml(displayName)}</span>
            <span class="binding-editor-context-sep">·</span>
            <span class="binding-editor-context-category">${escapeHtml(actionName)}</span>
            <span class="binding-editor-context-sep">·</span>
            <span class="binding-editor-context-category">${escapeHtml(category)}</span>
          </div>
        </div>
        <button class="modal-close" id="btn-mouse-close">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line>
          </svg>
        </button>
      </div>
      <div class="mouse-binding-current">
        <span class="mouse-binding-current-label">${t('environments:binding.mouse.currentLabel', 'Current:')}</span>
        ${currentDisplay}
      </div>
      <div class="mouse-binding-columns" id="mouse-binding-list">
        ${renderRows()}
      </div>
      <div class="modal-footer">
        <div class="modal-footer-left">
          <button class="btn btn-secondary" id="btn-mouse-reset">${t('environments:binding.editor.resetBtn', 'Reset to Default')}</button>
        </div>
        <div class="modal-footer-actions">
          <button class="btn btn-secondary" id="btn-mouse-cancel">${t('environments:binding.editor.cancelBtn', 'Cancel')}</button>
          <button class="btn btn-primary" id="btn-mouse-save">${t('environments:binding.editor.saveBtn', 'Save')}</button>
        </div>
      </div>
    </div>
  `;

  document.body.appendChild(modal);
  requestAnimationFrame(() => modal.classList.add('show'));

  const cleanupAndClose = () => {
    modal.classList.remove('show');
    setTimeout(() => modal.remove(), 200);
  };

  modal.querySelector('#mouse-binding-list').addEventListener('click', (e) => {
    const row = e.target.closest('[data-action="mouse-input-select"]');
    if (!row) return;
    selectedCode = row.dataset.code;
    modal.querySelector('#mouse-binding-list').innerHTML = renderRows();
    const badge = modal.querySelector('.mouse-binding-current');
    badge.innerHTML = `
      <span class="mouse-binding-current-label">${t('environments:binding.mouse.currentLabel', 'Current:')}</span>
      <span class="mouse-binding-current-val">${escapeHtml(selectedCode)}</span>
    `;
  });

  modal.querySelector('#btn-mouse-close').addEventListener('click', cleanupAndClose);
  modal.querySelector('#btn-mouse-cancel').addEventListener('click', cleanupAndClose);
  modal.addEventListener('click', (e) => { if (e.target === modal) cleanupAndClose(); });

  modal.querySelector('#btn-mouse-reset').addEventListener('click', async () => {
    const s = getState();
    if (!s.lastRestoredBackupId) {
      showNotification(t('environments:notification.noProfileLoaded'), 'error');
      return;
    }
    try {
      await invoke('reset_profile_binding', {
        v: s.activeScVersion, profileId: s.lastRestoredBackupId,
        actionMap: category, actionName: actionName,
      });
      showNotification(t('environments:notification.bindingReset', 'Binding reset to default'), 'success');
      window.expandedBindingCategories?.add(category);
      cleanupAndClose();
      // Cross-module: caller should trigger loadProfileStatus() + renderEnvironments()
    } catch (err) {
      showNotification(t('environments:notification.resetError', { error: err }), 'error');
    }
  });

  modal.querySelector('#btn-mouse-save').addEventListener('click', async () => {
    const s = getState();
    if (!selectedCode) {
      showNotification(t('environments:notification.noInputCaptured', 'No input selected'), 'error');
      return;
    }
    if (!s.lastRestoredBackupId) {
      showNotification(t('environments:notification.noProfileForSave'), 'error');
      return;
    }
    try {
      const sessionWineMaps = await invoke('get_wine_axis_mappings').catch(() => ({}));
      await invoke('assign_profile_binding', {
        v: s.activeScVersion, profileId: s.lastRestoredBackupId,
        actionMap: category, actionName: actionName,
        newInput: selectedCode, oldInput: currentInput || null,
        wineAxisMap: Object.keys(sessionWineMaps).length > 0 ? sessionWineMaps : null,
      });
      showNotification(t('environments:notification.bindingSaved'), 'success');
      window.expandedBindingCategories?.add(category);
      cleanupAndClose();
      // Cross-module: caller should trigger loadProfileStatus() + renderEnvironments()
    } catch (err) {
      showNotification(t('environments:notification.saveError', { error: err }), 'error');
    }
  });
}
