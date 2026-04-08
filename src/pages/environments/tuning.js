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
 * Device tuning management for Environments page.
 *
 * Handles joystick/controller tuning data: loading from the backend,
 * saving changes, resolving tuning names from action bindings,
 * and rendering the collapsible device map section.
 *
 * @module pages/environments/tuning
 */

import { invoke } from '@tauri-apps/api/core';
import { t } from '../../i18n.js';
import { escapeHtml } from '../../utils.js';
import { showNotification } from '../../utils/dialogs.js';
import { getState, setState } from './state.js';
import { debugLog, renderHint } from './utils.js';

// ── Constants ──

/** SC tuning categories with human-readable labels */
export const SC_TUNING_LABELS = {
  'master': 'Master',
  'flight_move_pitch': 'Pitch',
  'flight_move_yaw': 'Yaw',
  'flight_move_roll': 'Roll',
  'flight_move_strafe_vertical': 'Strafe Vertical',
  'flight_move_strafe_lateral': 'Strafe Lateral',
  'flight_move_strafe_longitudinal': 'Strafe Longitudinal',
  'flight_strafe_longitudinal': 'Strafe Longitudinal',
  'flight_strafe_forward': 'Strafe Forward',
  'flight_strafe_backward': 'Strafe Backward',
  'flight_throttle_abs': 'Throttle (Absolute)',
  'flight_throttle_rel': 'Throttle (Relative)',
  'flight_aim': 'Aim',
  'flight_view': 'Free Look',
  'turret_aim': 'Turret Aim',
  'mining_throttle': 'Mining Throttle',
  'mining_aim': 'Mining Aim',
  'flight_move_speed_range_abs': 'Speed Range (Abs)',
  'flight_move_speed_range_rel': 'Speed Range (Rel)',
  'flight_move_accel_range_abs': 'Accel Range (Abs)',
  'flight_move_accel_range_rel': 'Accel Range (Rel)',
  'throttle': 'Throttle',
  'viewaim': 'View / Aim',
};

/**
 * Mapping between Star Citizen action names (bindings) and their
 * internal tuning category names (options tags).
 */
export const SC_ACTION_TO_TUNING_MAP = {
  'v_pitch': 'flight_move_pitch',
  'v_yaw': 'flight_move_yaw',
  'v_roll': 'flight_move_roll',
  'v_strafe_vertical': 'flight_move_strafe_vertical',
  'v_strafe_up': 'flight_move_strafe_vertical',
  'v_strafe_down': 'flight_move_strafe_vertical',
  'v_strafe_horizontal': 'flight_move_strafe_lateral',
  'v_strafe_lateral': 'flight_move_strafe_lateral',
  'v_strafe_left': 'flight_move_strafe_lateral',
  'v_strafe_right': 'flight_move_strafe_lateral',
  'v_strafe_longitudinal': 'flight_move_strafe_longitudinal',
  'v_strafe_forward': 'flight_strafe_forward',
  'v_strafe_backward': 'flight_strafe_backward',

  'v_ifcs_speed_limiter_abs': 'flight_move_speed_range_abs',
  'v_ifcs_speed_limiter_rel': 'flight_move_speed_range_rel',
  'v_ifcs_throttle_abs': 'flight_throttle_abs',
  'v_ifcs_throttle_rel': 'flight_throttle_rel',
  'v_throttle_abs': 'flight_throttle_abs',
  'v_throttle_rel': 'flight_throttle_rel',
  'v_view_pitch': 'flight_view',
  'v_view_yaw': 'flight_view',
  'v_mining_throttle': 'mining_throttle',
  'v_increase_mining_throttle': 'mining_throttle',
  'v_decrease_mining_throttle': 'mining_throttle',
  'v_aim_pitch': 'flight_aim',
  'v_aim_yaw': 'flight_aim',
  'turret_pitch': 'turret_aim',
  'turret_yaw': 'turret_aim',
  'v_ifcs_accel_limiter_abs': 'flight_move_accel_range_abs',
  'v_ifcs_accel_limiter_rel': 'flight_move_accel_range_rel',
};

/** All SC tuning categories that apply to joystick devices */
export const SC_TUNING_DEFAULTS = [
  'flight_move_pitch', 'flight_move_yaw', 'flight_move_roll',
  'flight_move_strafe_vertical', 'flight_move_strafe_lateral', 'flight_move_strafe_longitudinal',
  'flight_strafe_forward', 'flight_strafe_backward', 'flight_strafe_longitudinal',
  'flight_throttle_abs', 'flight_throttle_rel',
  'flight_move_speed_range_abs', 'flight_move_speed_range_rel',
  'flight_move_accel_range_abs', 'flight_move_accel_range_rel',
  'flight_aim', 'flight_view', 'turret_aim', 'mining_throttle',
];

// ── Tuning Functions ──

/**
 * Returns a human-readable label for a tuning category name.
 * Falls back to title-casing the technical name.
 */
export function tuningLabel(name) {
  if (SC_TUNING_LABELS[name]) return SC_TUNING_LABELS[name];
  // Fallback: replace underscores, title case
  return name.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

/**
 * Loads tuning data from the backend for the active profile,
 * enriched with hardware axis info from connected devices.
 */
export async function loadDeviceTuning() {
  const { lastRestoredBackupId, activeScVersion } = getState();
  if (!lastRestoredBackupId || !activeScVersion) {
    setState({ deviceTuningData: [] });
    return;
  }
  try {
    // Load profile tuning data and connected hardware axes in parallel
    const [profileTuning, connectedAxes] = await Promise.all([
      invoke('get_device_tuning', {
        v: activeScVersion,
        profileId: lastRestoredBackupId,
      }),
      invoke('list_device_axes', { deviceMap: window.activeBackup?.device_map || [] }).catch(() => []),
    ]);

    // Enrich each device with hardware axes and default tuning entries
    for (const dev of profileTuning) {
      // Match connected hardware by product name (fuzzy: one contains the other)
      const hwMatch = connectedAxes.find(hw =>
        hw.product_name === dev.product ||
        dev.product.includes(hw.product_name) ||
        hw.product_name.includes(dev.product)
      );

      // Fill in missing axis_options from hardware detection
      if (hwMatch && dev.axis_options.length === 0) {
        dev.axis_options = hwMatch.axes.map(axis => ({
          input: axis.name,
          deadzone: 0.0,
          saturation: 1.0,
        }));
      }

      // Merge defaults: keep existing values, add missing categories
      const existingNames = new Set(dev.tuning.map(t => t.name));
      for (const name of SC_TUNING_DEFAULTS) {
        if (!existingNames.has(name)) {
          dev.tuning.push({
            name,
            invert: 0,
            exponent: 1.0,
            sensitivity: 1.0,
          });
        }
      }
      // Ensure existing entries have all fields with defaults
      for (const entry of dev.tuning) {
        if (entry.invert == null) entry.invert = 0;
        if (entry.exponent == null) entry.exponent = 1.0;
        if (entry.sensitivity == null) entry.sensitivity = 1.0;
      }
    }

    setState({ deviceTuningData: profileTuning });
  } catch (err) {
    debugLog('TUNING', 'error', `Failed to load tuning: ${err}`);
    setState({ deviceTuningData: [] });
  }
}

/**
 * Resolves a binding action name to its corresponding Star Citizen tuning name.
 * Uses the mapping table and falls back to the original name if no match is found.
 * @param {string} actionName - Technical action name (e.g. "v_ifcs_speed_limiter_abs")
 * @returns {string} Tuning name (e.g. "flight_move_speed_range_abs")
 */
export function resolveTuningName(actionName) {
  if (!actionName) return 'master';
  // Use mapping or fallback to original (which works for many movement axes)
  return SC_ACTION_TO_TUNING_MAP[actionName] || actionName;
}

/**
 * Saves tuning data for a specific device instance back to the profile.
 */
export async function saveTuningForDevice(instance, deviceType) {
  const { deviceTuningData, lastRestoredBackupId, activeScVersion } = getState();
  const dev = deviceTuningData.find(d => d.instance === instance && d.device_type === deviceType);
  if (!dev || !lastRestoredBackupId || !activeScVersion) return;

  try {
    await invoke('update_device_tuning', {
      v: activeScVersion,
      profileId: lastRestoredBackupId,
      instance: dev.instance,
      deviceType: dev.device_type,
      axisOptions: dev.axis_options,
      tuning: dev.tuning,
    });
  } catch (err) {
    debugLog('TUNING', 'error', `Failed to save tuning: ${err}`);
    showNotification(t('environments:notification.tuningSaveFailed', { error: err }), 'error');
  }
}

/**
 * Renders the collapsible joystick section with drag-and-drop reordering.
 * Only joysticks are shown - keyboards/gamepads have fixed instance numbers.
 */
export function renderDeviceMapCollapsible() {
  const { lastRestoredBackupId, backups } = getState();
  const activeBackup = lastRestoredBackupId ? backups.find(b => b.id === lastRestoredBackupId) : null;
  // Only show joysticks - keyboards/gamepads have fixed instance numbers
  const deviceMap = (activeBackup?.device_map || [])
    .filter(dm => dm.device_type === 'joystick')
    .sort((a, b) => a.sc_instance - b.sc_instance);
  if (deviceMap.length === 0) return '';

  const isExpanded = window.expandedPanels?.devices === true;

  return `
    <div class="sc-section collapsible-section">
      <div class="collapsible-header" data-panel="devices">
        <span class="collapsible-toggle ${isExpanded ? '' : 'collapsed'}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"></polyline></svg>
        </span>
        <h3>
          ${t('environments:device.title')}
          <span class="binding-stats-badge">${t('environments:binding.mapped', { count: deviceMap.length })}</span>
        </h3>
      </div>
      <div class="collapsible-content ${isExpanded ? '' : 'collapsed'}">
        ${renderHint('devices-intro', t('environments:hint.devicesIntro'))}
        <div class="device-map-list">
          ${deviceMap.map(dm => {
            return `
            <div class="device-card-v2 device-card draggable" data-product="${escapeHtml(dm.product_name)}" data-instance="${dm.sc_instance}" data-device-type="${escapeHtml(dm.device_type)}">
              <div class="device-card-v2-drag" title="${t('environments:device.dragToReorder')}">
                <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><circle cx="8" cy="4" r="2"/><circle cx="16" cy="4" r="2"/><circle cx="8" cy="12" r="2"/><circle cx="16" cy="12" r="2"/><circle cx="8" cy="20" r="2"/><circle cx="16" cy="20" r="2"/></svg>
              </div>
              <div class="device-card-v2-info">
                <div class="device-card-v2-top">
                  <span class="device-card-v2-instance">js${dm.sc_instance}</span>
                  <span class="device-card-v2-name" title="${escapeHtml(dm.product_name)}">${escapeHtml(dm.alias || dm.product_name)}</span>
                  <button class="device-card-v2-rename" data-product="${escapeHtml(dm.product_name)}" data-alias="${escapeHtml(dm.alias || '')}" title="${t('environments:device.setAlias')}">
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>
                  </button>
                </div>
              </div>
            </div>
          `}).join('')}
        </div>
      </div>
    </div>
  `;
}
