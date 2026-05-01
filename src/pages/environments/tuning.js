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
import { loadProfileStatus, refreshActiveProfileHeader } from './profiles.js';
import { refreshBindingsInPlace } from './bindings.js';

// ── Constants ──

/**
 * SC tuning category tag names with human-readable labels.
 * All tag names verified empirically by changing each slider in SC's in-game
 * Joystick Sensitivity Curves UI and observing the resulting actionmaps.xml.
 * SC organises curves into 7 modes: Flight, Turrets, On Foot, FPS EVA,
 * Ground Vehicle, Mining, Aiming and Weapons.
 */
export const SC_TUNING_LABELS = {
  // ── Generic ──
  'master': 'Master',
  'throttle': 'Throttle',
  'viewaim': 'View / Aim',
  // ── Flight ──
  'flight_move_pitch': 'Flight — Pitch',
  'flight_move_yaw': 'Flight — Yaw',
  'flight_move_roll': 'Flight — Roll',
  'flight_move_strafe_vertical': 'Flight — Strafe Vertical',
  'flight_move_strafe_lateral': 'Flight — Strafe Lateral',
  'flight_move_strafe_longitudinal': 'Flight — Strafe Longitudinal',
  'flight_strafe_longitudinal': 'Flight — Strafe Longitudinal',
  'flight_strafe_forward': 'Flight — Strafe Forward',
  'flight_strafe_backward': 'Flight — Strafe Backward',
  'flight_throttle_abs': 'Flight — Throttle (Absolute)',
  'flight_throttle_rel': 'Flight — Throttle (Relative)',
  'flight_move_speed_range_abs': 'Flight — Speed Range (Abs)',
  'flight_move_speed_range_rel': 'Flight — Speed Range (Rel)',
  'flight_move_accel_range_abs': 'Flight — Accel Range (Abs)',
  'flight_move_accel_range_rel': 'Flight — Accel Range (Rel)',
  'flight_aim': 'Flight — Aim',
  'flight_view': 'Flight — Free Look',
  // ── Turrets ──
  'turret_aim': 'Turret — Aim',
  // ── On Foot (verified) ──
  'fps_view': 'On Foot — View',
  'fps_move': 'On Foot — Movement',
  // ── FPS EVA (verified) ──
  // SC stores EVA's Roll under the fps_view_roll tag (shared with FPS view roll),
  // but the strafe axes have dedicated eva_move_strafe_* tags.
  'fps_view_roll': 'EVA — Roll',
  'eva_move_strafe_lateral': 'EVA — Strafe Lateral',
  'eva_move_strafe_longitudinal': 'EVA — Strafe Longitudinal',
  'eva_move_strafe_vertical': 'EVA — Strafe Vertical',
  // ── Ground Vehicle (verified) ──
  'mgv_view_pitch': 'Ground Vehicle — View Pitch',
  'mgv_view_yaw': 'Ground Vehicle — View Yaw',
  'mgv_move': 'Ground Vehicle — Move (Forward/Backward)',
  'mgv_move_forward': 'Ground Vehicle — Move Forward',
  'mgv_move_backward': 'Ground Vehicle — Move Backward',
  'mgv_move_pitch': 'Ground Vehicle — View Pitch (button)',
  'mgv_move_yaw': 'Ground Vehicle — View Yaw (button)',
  // ── Mining (verified) ──
  // SC's "Mining" + "Mining Throttle" sliders both write to the single `mining`
  // tag. The previously assumed `mining_throttle` tag is not used by current SC.
  'mining': 'Mining',
  'mining_throttle': 'Mining (legacy)',
  'mining_aim': 'Mining — Aim',
  // ── Aiming and Weapons (verified) ──
  'weapon_convergence_distance_rel': 'Weapon — Convergence Distance (rel.)',
  'weapon_convergence_distance_abs': 'Weapon — Convergence Distance (abs.)',
};

/**
 * Mapping between Star Citizen action names (bindings) and their internal
 * tuning category names (options tags). Used by the binding editor to surface
 * the relevant curve next to a given action. Tag names verified by reading
 * actionmaps.xml after toggling each slider in SC's in-game UI.
 */
export const SC_ACTION_TO_TUNING_MAP = {
  // ── Spaceship / Flight ──
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
  'v_aim_pitch': 'flight_aim',
  'v_aim_yaw': 'flight_aim',
  'v_ifcs_accel_limiter_abs': 'flight_move_accel_range_abs',
  'v_ifcs_accel_limiter_rel': 'flight_move_accel_range_rel',
  // ── Turret ──
  'turret_pitch': 'turret_aim',
  'turret_yaw': 'turret_aim',
  // ── EVA (verified) ──
  // EVA's view (pitch/yaw/roll) shares the fps_view_* tags with On Foot;
  // its strafe axes have dedicated eva_move_strafe_* tags.
  'eva_view_pitch': 'fps_view',
  'eva_view_pitch_up': 'fps_view',
  'eva_view_pitch_down': 'fps_view',
  'eva_view_pitch_mouse': 'fps_view',
  'eva_view_yaw': 'fps_view',
  'eva_view_yaw_left': 'fps_view',
  'eva_view_yaw_right': 'fps_view',
  'eva_view_yaw_mouse': 'fps_view',
  'eva_roll': 'fps_view_roll',
  'eva_roll_left': 'fps_view_roll',
  'eva_roll_right': 'fps_view_roll',
  'eva_strafe_lateral': 'eva_move_strafe_lateral',
  'eva_strafe_left': 'eva_move_strafe_lateral',
  'eva_strafe_right': 'eva_move_strafe_lateral',
  'eva_strafe_longitudinal': 'eva_move_strafe_longitudinal',
  'eva_strafe_forward': 'eva_move_strafe_longitudinal',
  'eva_strafe_back': 'eva_move_strafe_longitudinal',
  'eva_strafe_vertical': 'eva_move_strafe_vertical',
  'eva_strafe_up': 'eva_move_strafe_vertical',
  'eva_strafe_down': 'eva_move_strafe_vertical',
  // ── Mining (verified) ──
  // SC writes a single `mining` tag for the Mining and Mining Throttle sliders.
  // Older internal mappings used `mining_throttle`; we now write to `mining`.
  'v_mining_throttle': 'mining',
  'v_increase_mining_throttle': 'mining',
  'v_decrease_mining_throttle': 'mining',
};

/**
 * Full list of SC tuning category tags that the editor exposes for joystick
 * devices. Covers all 7 modes that SC's in-game Joystick Sensitivity Curves UI
 * exposes (Flight, Turrets, On Foot, FPS EVA, Ground Vehicle, Mining,
 * Aiming and Weapons). Tag names verified empirically.
 */
export const SC_TUNING_DEFAULTS = [
  // Flight
  'flight_move_pitch', 'flight_move_yaw', 'flight_move_roll',
  'flight_move_strafe_vertical', 'flight_move_strafe_lateral', 'flight_move_strafe_longitudinal',
  'flight_strafe_forward', 'flight_strafe_backward', 'flight_strafe_longitudinal',
  'flight_throttle_abs', 'flight_throttle_rel',
  'flight_move_speed_range_abs', 'flight_move_speed_range_rel',
  'flight_move_accel_range_abs', 'flight_move_accel_range_rel',
  'flight_aim', 'flight_view',
  // Turrets
  'turret_aim',
  // On Foot
  'fps_view', 'fps_move',
  // FPS EVA (Roll shared with FPS view; strafe axes are EVA-specific)
  'fps_view_roll',
  'eva_move_strafe_lateral', 'eva_move_strafe_longitudinal', 'eva_move_strafe_vertical',
  // Ground Vehicle
  'mgv_view_pitch', 'mgv_view_yaw',
  'mgv_move', 'mgv_move_forward', 'mgv_move_backward',
  'mgv_move_pitch', 'mgv_move_yaw',
  // Mining
  'mining',
  // Aiming and Weapons
  'weapon_convergence_distance_rel', 'weapon_convergence_distance_abs',
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
 * Derives a human-readable SC mode label from an action name and its resolved
 * tuning tag. The action-name prefix is checked first because some tags are
 * shared across modes (e.g. EVA roll writes to `fps_view_roll`, but conceptually
 * belongs to EVA, not to On Foot).
 */
export function deriveModeLabel(actionName, tuningTag) {
  const a = actionName || '';
  const tag = tuningTag || '';
  if (a.startsWith('eva_'))    return t('environments:tuning.mode.eva', 'EVA');
  if (a.startsWith('mgv_'))    return t('environments:tuning.mode.groundVehicle', 'Ground Vehicle');
  if (a.startsWith('player_')) return t('environments:tuning.mode.onFoot', 'On Foot');
  if (a.startsWith('turret_')) return t('environments:tuning.mode.turrets', 'Turrets');
  if (a.startsWith('weapon_')) return t('environments:tuning.mode.weapons', 'Weapons');
  if (a.includes('mining'))    return t('environments:tuning.mode.mining', 'Mining');
  if (tag.startsWith('flight_')) return t('environments:tuning.mode.flight', 'Flight');
  if (tag.startsWith('turret_')) return t('environments:tuning.mode.turrets', 'Turrets');
  if (tag.startsWith('mgv_'))    return t('environments:tuning.mode.groundVehicle', 'Ground Vehicle');
  if (tag.startsWith('fps_'))    return t('environments:tuning.mode.onFoot', 'On Foot');
  if (tag.startsWith('weapon_')) return t('environments:tuning.mode.weapons', 'Weapons');
  if (tag === 'mining')          return t('environments:tuning.mode.mining', 'Mining');
  return t('environments:tuning.mode.generic', 'Generic');
}

/**
 * Finds other bindings on the same hardware axis that resolve to a *different*
 * tuning tag — i.e. would be edited as separate SC curves. The input prefix
 * (e.g. `js1_`) implicitly identifies the device; same input + same tag means
 * the same curve, so those entries are filtered out.
 */
export function findRelatedBindingsOnAxis(allBindings, currentInput, currentAction, currentTag) {
  const found = [];
  for (const group of (allBindings || [])) {
    for (const b of (group.bindings || [])) {
      if (b.current_input !== currentInput) continue;
      if (group.action_name === currentAction) continue;
      const otherTag = resolveTuningName(group.action_name);
      if (otherTag === currentTag) continue;
      found.push({
        action_name: group.action_name,
        display_name: group.display_name || group.action_name,
        category: group.category,
        category_label: group.category_label,
        tag: otherTag,
        mode_label: deriveModeLabel(group.action_name, otherTag),
      });
    }
  }
  return found;
}

/**
 * Compares profile tuning/axis values to the live SC values for the same
 * action (via tuning tag + axis input). Returns one of "ok" | "differs" |
 * "missing" | null. Null means no live data was available — callers should
 * hide the badge entirely in that case.
 */
function compareLiveTuning(liveSettings, deviceType, instance, productName, tag, axisInput, profileTuning, profileAxisOpt) {
  if (!liveSettings || !Array.isArray(liveSettings.devices)) return null;
  const liveDevice = liveSettings.devices.find(d =>
    d.device_type === deviceType
    && d.instance === instance
    && (d.product === productName
        || (productName || '').includes(d.product || '')
        || (d.product || '').includes(productName || ''))
  );
  if (!liveDevice) return 'missing';
  const liveTuning = (liveDevice.tuning || []).find(tn => tn.name === tag);
  const liveAxisOpt = (liveDevice.axis_options || []).find(o => o.input === axisInput);
  if (!liveTuning && !liveAxisOpt) return 'missing';

  const eq = (a, b) => Math.abs((a ?? 0) - (b ?? 0)) < 1e-4;
  const tuningOk = !liveTuning || (
    (liveTuning.invert ?? 0) === (profileTuning.invert ?? 0)
    && eq(liveTuning.exponent ?? 1.0, profileTuning.exponent ?? 1.0)
    && eq(liveTuning.sensitivity ?? 1.0, profileTuning.sensitivity ?? 1.0)
  );
  const axisOk = !liveAxisOpt || (
    eq(liveAxisOpt.deadzone ?? 0.0, profileAxisOpt.deadzone ?? 0.0)
    && eq(liveAxisOpt.saturation ?? 1.0, profileAxisOpt.saturation ?? 1.0)
  );
  return (tuningOk && axisOk) ? 'ok' : 'differs';
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

/**
 * Opens a modal to configure tuning for a single axis binding. The dialog is
 * contextual: the SC mode (Flight, EVA, Ground Vehicle, …) is auto-derived
 * from the action name and resolved tuning tag — the user never picks a mode.
 *
 * The layout makes the *scope* of each control explicit:
 *   • Per Mode  (invert, sensitivity, exponent) — only this mode's curve
 *   • Per Axis  (deadzone, saturation)          — every binding on this input
 * It also surfaces related bindings on the same axis that resolve to a
 * different curve, and (best-effort) compares profile values to the live SC
 * installation via `read_live_sc_settings`.
 */
export async function openTuningEditor(actionName, category, currentInput, deviceType, targetInstance) {
  const state = getState();
  const { activeScVersion: v, lastRestoredBackupId: profileId, completeBindingList, config } = state;

  if (!v || !profileId) {
    showNotification(t('environments:notification.noProfileLoaded', 'Kein Profil geladen'), 'error');
    return;
  }

  const tuningName = resolveTuningName(actionName);
  const modeLabel = deriveModeLabel(actionName, tuningName);
  const axisInput = currentInput.split('_').pop();
  const displayName = (completeBindingList.find(b => b.action_name === actionName) || {}).display_name || '';
  const relatedBindings = findRelatedBindingsOnAxis(completeBindingList, currentInput, actionName, tuningName);

  try {
    debugLog('TUNING', 'info', `Fetching tuning data: v=${v}, profile_id=${profileId}`);
    const [devices, liveSettings] = await Promise.all([
      invoke('get_device_tuning', { v, profileId }),
      config?.install_path
        ? invoke('read_live_sc_settings', { gp: config.install_path, v }).catch(() => null)
        : Promise.resolve(null),
    ]);
    debugLog('TUNING', 'info', `Fetched ${devices.length} devices from profile`);

    const device = devices.find(d => d.instance === targetInstance && d.device_type === deviceType);
    if (!device) {
      debugLog('TUNING', 'warn', `Device not found: type=${deviceType}, instance=${targetInstance}`);
      showNotification(t('environments:notification.deviceNotFound', 'Gerät nicht im Profil gefunden'), 'error');
      return;
    }

    const currentTuning = device.tuning.find(tn => tn.name === tuningName)
      || { name: tuningName, invert: 0, exponent: 1.0, sensitivity: 1.0 };
    const axisOption = device.axis_options.find(o => o.input === axisInput)
      || { input: axisInput, deadzone: 0.0, saturation: 1.0 };

    const syncState = compareLiveTuning(
      liveSettings, deviceType, targetInstance, device.product,
      tuningName, axisInput, currentTuning, axisOption,
    );

    const relatedHtml = relatedBindings.length === 0 ? '' : `
      <div class="tuning-related">
        <div class="tuning-section-header tuning-section-header--neutral">
          ${t('environments:tuning.relatedBindings.header', { input: currentInput })}
        </div>
        <div class="tuning-related-list">
          ${relatedBindings.map(rb => `
            <div class="tuning-related-row">
              <span class="tuning-mode-pill tuning-mode-pill--alt">${escapeHtml(rb.mode_label)}</span>
              <span class="tuning-related-name">${escapeHtml(rb.display_name)}</span>
              <span class="tuning-related-tag">→ ${escapeHtml(rb.tag)} <span class="tuning-related-meta">(${t('environments:tuning.relatedBindings.separateCurve', 'separate curve')})</span></span>
              <button class="tuning-related-tune"
                      data-action="tune-related"
                      data-action-name="${escapeHtml(rb.action_name)}"
                      data-category="${escapeHtml(rb.category || '')}">
                ${t('environments:tuning.relatedBindings.tune', 'Tune ↗')}
              </button>
            </div>
          `).join('')}
        </div>
        <div class="tuning-related-note">${t('environments:tuning.relatedBindings.note')}</div>
      </div>
    `;

    const syncHtml = syncState === null ? '' : `
      <div class="tuning-sync tuning-sync--${syncState}">
        <span class="tuning-sync-pill">
          ${syncState === 'ok' ? '✓' : (syncState === 'differs' ? '⚠' : '·')}
          ${t(`environments:tuning.sync.${syncState}`)}
        </span>
        <span class="tuning-sync-desc">${t(`environments:tuning.sync.${syncState}Desc`)}</span>
      </div>
    `;

    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.innerHTML = `
      <div class="modal-container tuning-editor-modal">
        <div class="modal-header">
          <div class="modal-title-wrap">
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="modal-icon-info"><path d="M12 20v-8m0-4h.01M22 12c0 5.523-4.477 10-10 10S2 17.523 2 12 6.477 2 12 2s10 4.477 10 10z"/></svg>
            <h3>${t('environments:tuning.title', 'Tuning Editor')}</h3>
          </div>
          <button class="btn-close modal-close-btn" data-action="close-tuning-editor">×</button>
        </div>
        <div class="modal-body">

          <div class="tuning-mode-banner">
            <div class="tuning-mode-banner-label">${t('environments:tuning.modeBanner.label', 'MODE · auto-detected')}</div>
            <div class="tuning-mode-banner-name">${escapeHtml(modeLabel)}</div>
            <div class="tuning-mode-banner-tag">${escapeHtml(tuningName)}</div>
          </div>

          <div class="tuning-action-context">
            <div class="tuning-action-display">${escapeHtml(displayName || actionName)}</div>
            <div class="tuning-action-meta">
              <span class="tuning-action-meta-mono">${escapeHtml(actionName)}</span>
              <span class="tuning-action-meta-sep">·</span>
              <span>${escapeHtml(device.product || '')}</span>
              <span class="tuning-action-meta-sep">·</span>
              <span class="tuning-action-meta-mono">${escapeHtml(currentInput)}</span>
            </div>
          </div>

          <div class="tuning-canvas-container">
            <div class="tuning-grid-overlay"></div>
            <div class="tuning-axis-labels">
              <div style="display: flex; justify-content: space-between; width: 100%;">
                <span>Output 1.0</span>
                <span>(In)</span>
              </div>
              <div style="display: flex; justify-content: space-between; align-items: flex-end; width: 100%; height: 100%;">
                <span>0.0</span>
                <span>1.0</span>
              </div>
            </div>
            <canvas id="tuningCurve" width="470" height="220" style="position: relative; z-index: 2;"></canvas>
          </div>

          <div class="tuning-scope-block tuning-scope-block--per-mode">
            <div class="tuning-section-header tuning-section-header--per-mode">
              ⚡ ${t('environments:tuning.perMode.header', { mode: modeLabel })}
            </div>
            <label class="filter-toggle tuning-toggle-row">
              <span class="toggle-switch">
                <input type="checkbox" id="tuningInvert" ${currentTuning.invert ? 'checked' : ''}>
                <span class="toggle-slider"></span>
              </span>
              <span>${t('environments:tuning.invert', 'Invert axis')}</span>
            </label>
            <div class="tuning-section">
              <div class="tuning-slider-label">
                <span>${t('environments:tuning.sensitivity', 'Sensitivity')}</span>
                <span class="tuning-value-badge" id="valSensitivity">${(currentTuning.sensitivity || 1.0).toFixed(2)}</span>
              </div>
              <input type="range" class="tuning-range" id="tuningSensitivity" min="0.1" max="2.0" step="0.05" value="${currentTuning.sensitivity || 1.0}">
            </div>
            <div class="tuning-section">
              <div class="tuning-slider-label">
                <span>${t('environments:tuning.exponent', 'Curve Exponent')}</span>
                <span class="tuning-value-badge" id="valExponent">${(currentTuning.exponent || 1.0).toFixed(2)}</span>
              </div>
              <input type="range" class="tuning-range" id="tuningExponent" min="0.5" max="3.5" step="0.05" value="${currentTuning.exponent || 1.0}">
            </div>
          </div>

          <div class="tuning-scope-block tuning-scope-block--per-axis">
            <div class="tuning-section-header tuning-section-header--per-axis">
              ⚠ ${t('environments:tuning.perAxis.header', { input: currentInput })}
            </div>
            <div class="tuning-section">
              <div class="tuning-slider-label">
                <span>${t('environments:tuning.deadzone', 'Deadzone')}</span>
                <span class="tuning-value-badge" id="valDeadzone">${(axisOption.deadzone || 0.0).toFixed(2)}</span>
              </div>
              <input type="range" class="tuning-range" id="tuningDeadzone" min="0" max="0.5" step="0.01" value="${axisOption.deadzone || 0.0}">
            </div>
            <div class="tuning-section">
              <div class="tuning-slider-label">
                <span>${t('environments:tuning.saturation', 'Saturation')}</span>
                <span class="tuning-value-badge" id="valSaturation">${(axisOption.saturation || 1.0).toFixed(2)}</span>
              </div>
              <input type="range" class="tuning-range" id="tuningSaturation" min="0.5" max="1.0" step="0.01" value="${axisOption.saturation || 1.0}">
            </div>
          </div>

          ${relatedHtml}
          ${syncHtml}

        </div>
        <div class="modal-footer modal-footer--tuning">
          <button class="btn btn-secondary" id="btn-tuning-reset" title="${t('environments:tuning.reset', 'Reset to defaults')}">
            ↺ ${t('environments:tuning.reset', 'Reset to defaults')}
          </button>
          <span class="modal-footer-spacer"></span>
          <button class="btn btn-secondary" data-action="close-tuning-editor">${t('common:cancel', 'Cancel')}</button>
          <button class="btn btn-primary" id="btn-save-tuning">
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-right: 6px;"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>
            ${t('common:save', 'Apply Settings')}
          </button>
        </div>
      </div>
    `;

    const closeTuning = () => {
      modal.classList.remove('show');
      setTimeout(() => modal.remove(), 200);
    };
    modal.querySelectorAll('[data-action="close-tuning-editor"]').forEach(btn => btn.addEventListener('click', closeTuning));

    modal.querySelectorAll('[data-action="tune-related"]').forEach(btn => {
      btn.addEventListener('click', () => {
        const otherAction = btn.dataset.actionName;
        const otherCategory = btn.dataset.category;
        closeTuning();
        // Reopen for the related curve on the same hardware axis/device.
        setTimeout(() => openTuningEditor(otherAction, otherCategory, currentInput, deviceType, targetInstance), 220);
      });
    });

    const canvas = modal.querySelector('#tuningCurve');
    const drawCurve = () => {
      const ctx = canvas.getContext('2d');
      const w = canvas.width;
      const h = canvas.height;
      const exp = parseFloat(modal.querySelector('#tuningExponent').value);
      const dz = parseFloat(modal.querySelector('#tuningDeadzone').value);
      const sat = parseFloat(modal.querySelector('#tuningSaturation').value);

      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = 'rgba(6, 182, 212, 0.02)';
      ctx.fillRect(0, 0, w, h);

      ctx.beginPath();
      ctx.strokeStyle = '#06b6d4';
      ctx.lineWidth = 3;
      ctx.lineCap = 'round';
      ctx.shadowBlur = 12;
      ctx.shadowColor = 'rgba(6, 182, 212, 0.6)';

      for (let x = 0; x <= w; x++) {
        const input = x / w;
        let output = 0;
        if (input > dz) {
          const tn = Math.max(0, Math.min(1, (input - dz) / (sat - dz)));
          output = Math.pow(tn, exp);
        }
        const canvasY = h - (output * h);
        if (x === 0) ctx.moveTo(x, canvasY);
        else ctx.lineTo(x, canvasY);
      }
      ctx.stroke();
      ctx.shadowBlur = 0;

      if (dz > 0) {
        ctx.fillStyle = 'rgba(239, 68, 68, 0.1)';
        ctx.fillRect(0, 0, dz * w, h);
        ctx.strokeStyle = 'rgba(239, 68, 68, 0.4)';
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(dz * w, 0);
        ctx.lineTo(dz * w, h);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      if (sat < 1.0) {
        ctx.strokeStyle = 'rgba(234, 179, 8, 0.4)';
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(sat * w, 0);
        ctx.lineTo(sat * w, h);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    };

    modal.querySelectorAll('.tuning-range').forEach(input => {
      input.addEventListener('input', (e) => {
        const id = e.target.id;
        const val = parseFloat(e.target.value).toFixed(2);
        if (id === 'tuningSensitivity') modal.querySelector('#valSensitivity').textContent = val;
        if (id === 'tuningExponent')    modal.querySelector('#valExponent').textContent = val;
        if (id === 'tuningDeadzone')    modal.querySelector('#valDeadzone').textContent = val;
        if (id === 'tuningSaturation')  modal.querySelector('#valSaturation').textContent = val;
        drawCurve();
      });
    });

    modal.querySelector('#btn-tuning-reset').addEventListener('click', () => {
      // Reset only the controls in this dialog. Per-axis defaults (deadzone=0,
      // saturation=1) still affect every binding on this input — same scope
      // semantics as a manual edit.
      modal.querySelector('#tuningInvert').checked = false;
      const setRange = (id, value, badgeId) => {
        const el = modal.querySelector(`#${id}`);
        el.value = String(value);
        modal.querySelector(`#${badgeId}`).textContent = value.toFixed(2);
      };
      setRange('tuningSensitivity', 1.0, 'valSensitivity');
      setRange('tuningExponent',    1.0, 'valExponent');
      setRange('tuningDeadzone',    0.0, 'valDeadzone');
      setRange('tuningSaturation',  1.0, 'valSaturation');
      drawCurve();
    });

    modal.querySelector('#btn-save-tuning').addEventListener('click', async () => {
      try {
        const sensitivity = parseFloat(modal.querySelector('#tuningSensitivity').value);
        const exponent   = parseFloat(modal.querySelector('#tuningExponent').value);
        const deadzone   = parseFloat(modal.querySelector('#tuningDeadzone').value);
        const saturation = parseFloat(modal.querySelector('#tuningSaturation').value);
        const invert     = modal.querySelector('#tuningInvert').checked ? 1 : 0;

        const updatedTuning = [
          ...device.tuning.filter(tn => tn.name !== tuningName),
          { name: tuningName, invert, exponent, sensitivity },
        ];
        const updatedAxisOptions = [
          ...device.axis_options.filter(o => o.input !== axisInput),
          { input: axisInput, deadzone, saturation },
        ];

        await invoke('update_device_tuning', {
          v,
          profileId,
          instance: targetInstance,
          deviceType,
          axisOptions: updatedAxisOptions,
          tuning: updatedTuning,
        });

        showNotification(t('environments:notification.tuningSaved', 'Tuning saved successfully'), 'success');
        closeTuning();
        await Promise.all([loadDeviceTuning(), loadProfileStatus()]);
        // Scoped refreshes only — preserves matrix scroll, search filter, and
        // the active category. The matrix update repaints the per-binding
        // tuning indicator; the header update flips "Synchron" → "geändert".
        refreshBindingsInPlace();
        refreshActiveProfileHeader();
      } catch (err) {
        debugLog('TUNING', 'error', `Save failed: ${err}`);
        showNotification(t('environments:notification.saveError', { error: err }), 'error');
      }
    });

    document.body.appendChild(modal);
    requestAnimationFrame(() => {
      modal.classList.add('show');
      drawCurve();
    });
  } catch (err) {
    debugLog('TUNING', 'error', `Failed to open editor: ${err}`);
    showNotification(t('environments:notification.fetchError', { error: err }), 'error');
  }
}
