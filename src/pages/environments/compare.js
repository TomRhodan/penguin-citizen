/*
 * Penguin Citizen - Star Citizen Linux Manager
 * Copyright (C) 2024-2026 TomRhodan <tomrhodan@gmail.com>
 * Licensed under GPL-3.0-or-later
 */

/**
 * Compare-with-SC diagnose panel.
 *
 * Reads the live state of USER.cfg, attributes.xml, and actionmaps.xml from
 * the active environment and shows a per-setting diff against what the app
 * has currently saved. Lets the user verify mappings without launching SC.
 *
 * @module pages/environments/compare
 */

import { invoke } from '@tauri-apps/api/core';
import { t } from '../../i18n.js';
import { escapeHtml } from '../../utils.js';
import { getState, setState } from './state.js';
import { DEFAULT_SETTINGS, parseUserCfg, getSettingLabels } from './usercfg.js';

/**
 * Fetches live SC settings for the active environment and stores them in state.
 * Should be called when the Compare tab becomes visible or the user clicks refresh.
 */
export async function loadLiveSettings() {
  const { config, activeScVersion } = getState();
  if (!config?.install_path || !activeScVersion) {
    setState({ liveSettings: null });
    return;
  }
  try {
    const live = await invoke('read_live_sc_settings', {
      gp: config.install_path,
      v: activeScVersion,
    });
    setState({ liveSettings: live, liveSettingsLoadedAt: Date.now() });
  } catch (e) {
    setState({ liveSettings: null, liveSettingsError: String(e) });
  }
}

/**
 * Builds an array of diff rows comparing the app's saved snapshot to live SC state.
 * Each row is a single known DEFAULT_SETTINGS key, plus rows for unknown CVars
 * and unknown attributes that exist on disk but are not in our model.
 *
 * @returns {Array<{key, label, source, attrName, appValue, scValue, status, displayApp, displayScx}>}
 */
function buildSettingsDiff() {
  const s = getState();
  const live = s.liveSettings;
  if (!live) return [];

  const liveCfg = parseUserCfg(live.user_cfg_raw || '');
  const liveAttrs = live.attributes || {};

  const rows = [];
  const knownAttrNames = new Set();
  const knownCfgKeys = new Set();

  for (const [key, setting] of Object.entries(DEFAULT_SETTINGS)) {
    const target = setting.target;
    const attrName = setting.attrName;

    let appValue;
    let scValue;
    let source;

    if (target === 'attributes' && attrName) {
      knownAttrNames.add(attrName);
      if (key === '_resolution') knownAttrNames.add(setting.attrNameHeight);

      const appAttrs = s.savedAttributesValues || {};
      if (key === '_resolution') {
        const aw = appAttrs.Width, ah = appAttrs.Height;
        const sw = liveAttrs.Width, sh = liveAttrs.Height;
        appValue = aw && ah ? `${aw}x${ah}` : undefined;
        scValue = sw && sh ? `${sw}x${sh}` : undefined;
      } else if (key === '_windowMode') {
        appValue = appAttrs.WindowMode;
        scValue = liveAttrs.WindowMode;
      } else {
        appValue = appAttrs[attrName];
        scValue = liveAttrs[attrName];
      }
      source = 'attributes.xml';
    } else if (target === 'usercfg') {
      knownCfgKeys.add(key);
      // virtual cvar settings (none currently) would need special handling
      const appCfg = s.savedUserCfgSnapshot || {};
      appValue = appCfg[key];
      scValue = liveCfg[key];
      source = 'USER.cfg';
    } else {
      continue;
    }

    const status = computeStatus(appValue, scValue);
    const labels = getSettingLabels(key) || setting.labels;
    // Flag if SC has a numeric value outside our known labels range — that means
    // SC supports a value (e.g. FSR=3 for Upscaling) that our labels[] doesn't
    // cover, so the user is seeing a confusing display.
    const outOfRange = labels && scValue !== undefined && scValue !== null && scValue !== ''
      && Number.isInteger(Number(scValue))
      && (Number(scValue) < 0 || Number(scValue) >= labels.length);
    rows.push({
      key,
      label: setting.label || key,
      source,
      attrName: attrName || key,
      appValue,
      scValue,
      status,
      outOfRange,
      labelCount: labels ? labels.length : null,
      displayApp: formatValue(appValue, labels),
      displaySc: formatValue(scValue, labels),
    });
  }

  // _windowMode also has an indirect representation in USER.cfg via r_Fullscreen + r_FullscreenWindow.
  // Add a synthetic row so the user can spot the asymmetric read/write bug.
  knownCfgKeys.add('r_Fullscreen');
  knownCfgKeys.add('r_FullscreenWindow');
  const winRow = buildWindowModeCfgRow(s, liveCfg);
  if (winRow) rows.push(winRow);

  // Unknown attributes: present on disk but not in our model. Several patterns
  // are intentionally hidden because they are not user-tweakable settings — SC
  // saves them automatically (entitlement IDs, controller-layout paths, last-
  // played timestamps, window position). Showing them as "differences" is just
  // noise that buries real mismatches.
  const volatileAttrs = new Set([
    'lastPlayed', 'WindowPosX', 'WindowPosY', 'WindowWidth', 'WindowHeight',
    'UIVolume', 'Focus',
    // Controller layout file paths — managed by the bindings/profiles tab
    'Preset0', 'Preset1', 'Preset2', 'Preset3', 'Preset4',
    // Cryptic internal index, not the actual resolution (Width/Height carry that)
    'Resolution',
    // FoIP camera selection has a giant signed integer that looks like an internal
    // handle, not a user-facing setting
    'FoIPCameraSelection',
  ]);
  // Hide attribute name prefixes that represent data SC writes automatically and
  // is not exposed as a tweakable setting in the UI.
  const noisePrefixes = ['selectedShipURN'];
  for (const [name, value] of Object.entries(liveAttrs)) {
    if (knownAttrNames.has(name) || volatileAttrs.has(name)) continue;
    if (noisePrefixes.some(p => name.startsWith(p))) continue;
    rows.push({
      key: `__attr:${name}`,
      label: name,
      source: 'attributes.xml',
      attrName: name,
      appValue: undefined,
      scValue: value,
      status: 'only-in-sc',
      displayApp: '—',
      displaySc: String(value),
    });
  }

  // Unknown CVars: present in USER.cfg on disk but not in our model.
  for (const [key, value] of Object.entries(liveCfg)) {
    if (knownCfgKeys.has(key) || key === '_windowMode') continue;
    rows.push({
      key: `__cvar:${key}`,
      label: key,
      source: 'USER.cfg',
      attrName: key,
      appValue: undefined,
      scValue: value,
      status: 'only-in-sc',
      displayApp: '—',
      displaySc: String(value),
    });
  }

  return rows;
}

/**
 * Builds the synthetic row that exposes the Window Mode CVar pair (r_Fullscreen,
 * r_FullscreenWindow) alongside the attribute. Highlights the read/write asymmetry.
 */
function buildWindowModeCfgRow(s, liveCfg) {
  const fs = liveCfg.r_Fullscreen;
  const fsw = liveCfg.r_FullscreenWindow;
  // Determine sc-side mode from cfg cvars
  let cfgMode;
  if (fs === 1) cfgMode = 2;          // Fullscreen
  else if (fsw === 1 || fs === 2) cfgMode = 1;  // Borderless (fs===2 legacy)
  else if (fs === 0 && fsw === 0) cfgMode = 0;  // Windowed

  if (cfgMode === undefined && fs === undefined && fsw === undefined) {
    return null; // no mention in USER.cfg at all
  }
  const labels = ['Windowed', 'Borderless', 'Fullscreen'];
  const appCfg = s.savedUserCfgSnapshot || {};
  const appMode = appCfg._windowMode;
  const status = computeStatus(appMode, cfgMode);
  return {
    key: '_windowMode_cfg',
    label: t('environments:compare.windowModeCfg', { defaultValue: 'Window Mode (USER.cfg cvars)' }),
    source: 'USER.cfg',
    attrName: 'r_Fullscreen + r_FullscreenWindow',
    appValue: appMode,
    scValue: cfgMode,
    status,
    displayApp: appMode !== undefined ? labels[appMode] || String(appMode) : '—',
    displaySc: cfgMode !== undefined ? labels[cfgMode] || String(cfgMode) : '—',
  };
}

function computeStatus(appValue, scValue) {
  const appUndef = appValue === undefined || appValue === null || appValue === '';
  const scUndef = scValue === undefined || scValue === null || scValue === '';
  if (appUndef && scUndef) return 'unset';
  if (appUndef) return 'only-in-sc';
  if (scUndef) return 'only-in-app';
  // Loose equality: both could be number vs string from different sources
  // eslint-disable-next-line eqeqeq
  if (String(appValue) === String(scValue)) return 'match';
  return 'diff';
}

function formatValue(value, labels) {
  if (value === undefined || value === null || value === '') return '—';
  const num = Number(value);
  if (labels && Number.isInteger(num) && labels[num] !== undefined) {
    return `${labels[num]} (${num})`;
  }
  return String(value);
}

/**
 * Builds rows for each device's tuning entries from the live actionmaps.xml.
 */
function buildTuningRows() {
  const s = getState();
  const live = s.liveSettings;
  if (!live || !live.devices) return [];

  const rows = [];
  for (const dev of live.devices) {
    const tuning = dev.tuning || [];
    for (const t of tuning) {
      // Skip entries that are pure defaults (no curve effect). Surfaces only
      // entries SC actually wrote -- that's what tells us which mode-tags exist.
      const isDefault =
        (t.invert === 0 || t.invert === undefined) &&
        (t.exponent === undefined || t.exponent === 1.0) &&
        (t.sensitivity === undefined || t.sensitivity === 1.0);
      rows.push({
        device: dev.product,
        deviceType: dev.device_type,
        instance: dev.instance,
        tag: t.name,
        invert: t.invert ?? 0,
        exponent: t.exponent ?? 1.0,
        sensitivity: t.sensitivity ?? 1.0,
        isDefault,
      });
    }
  }
  return rows;
}

/**
 * Renders the Compare tab content.
 */
export function renderCompareTab() {
  const s = getState();
  const live = s.liveSettings;
  const filter = s.compareFilter || 'diff-only';

  if (!live) {
    return `
      <div class="compare-panel">
        <div class="compare-header">
          <h2>${t('environments:compare.title', { defaultValue: 'Compare with Star Citizen' })}</h2>
          <button class="btn btn-primary" id="btn-compare-refresh">${t('environments:compare.refresh', { defaultValue: 'Read SC files' })}</button>
        </div>
        <p class="compare-empty">${t('environments:compare.empty', { defaultValue: 'Click "Read SC files" to compare app values with the live Star Citizen state.' })}</p>
      </div>
    `;
  }

  const rows = buildSettingsDiff();
  const tuningRows = buildTuningRows();

  const counts = {
    total: rows.length,
    diff: rows.filter(r => r.status === 'diff').length,
    onlySc: rows.filter(r => r.status === 'only-in-sc').length,
    onlyApp: rows.filter(r => r.status === 'only-in-app').length,
    match: rows.filter(r => r.status === 'match').length,
  };

  const search = (s.compareSearch || '').trim().toLowerCase();
  const filteredRows = rows.filter(r => {
    if (filter === 'diff-only' && !(r.status === 'diff' || r.status === 'only-in-sc' || r.status === 'only-in-app')) return false;
    if (filter === 'tuning') return false;
    if (search && !`${r.label} ${r.attrName} ${r.key}`.toLowerCase().includes(search)) return false;
    return true;
  });

  const showTuning = filter === 'tuning' || filter === 'all';

  const loadedAt = s.liveSettingsLoadedAt
    ? new Date(s.liveSettingsLoadedAt).toLocaleTimeString()
    : '—';

  return `
    <div class="compare-panel">
      <div class="compare-header">
        <div>
          <h2>${t('environments:compare.title', { defaultValue: 'Compare with Star Citizen' })}</h2>
          <p class="compare-meta">
            ${t('environments:compare.lastRead', { defaultValue: 'Last read' })}: ${loadedAt} ·
            ${t('environments:compare.env', { defaultValue: 'Environment' })}: <strong>${escapeHtml(s.activeScVersion || '—')}</strong>
          </p>
        </div>
        <button class="btn btn-primary" id="btn-compare-refresh">↻ ${t('environments:compare.refresh', { defaultValue: 'Re-read SC files' })}</button>
      </div>

      <div class="compare-files">
        ${fileBadge('USER.cfg', live.user_cfg_exists)}
        ${fileBadge('attributes.xml', live.attributes_exists)}
        ${fileBadge('actionmaps.xml', live.actionmaps_exists)}
      </div>

      <div class="compare-summary">
        <span class="compare-pill mismatch" title="${t('environments:compare.mismatchTip', { defaultValue: 'App and SC disagree on the same attribute — these are real conflicts to resolve.' })}">${counts.diff} ${t('environments:compare.mismatches', { defaultValue: 'mismatches' })}</span>
        <span class="compare-pill match">${counts.match} ${t('environments:compare.matches', { defaultValue: 'matches' })}</span>
        <span class="compare-pill only-sc" title="${t('environments:compare.onlyScTip', { defaultValue: 'Settings SC writes that the app does not manage — informational, not a problem.' })}">${counts.onlySc} ${t('environments:compare.onlyInSc', { defaultValue: 'unmanaged in SC' })}</span>
        ${counts.onlyApp > 0 ? `<span class="compare-pill only-app">${counts.onlyApp} ${t('environments:compare.onlyInApp', { defaultValue: 'only in app' })}</span>` : ''}
        <span class="compare-pill tuning" data-filter="tuning">${tuningRows.length} ${t('environments:compare.tuningEntries', { defaultValue: 'tuning entries' })}</span>
      </div>

      <div class="compare-filters">
        <button class="compare-filter-btn ${filter === 'diff-only' ? 'active' : ''}" data-filter="diff-only">${t('environments:compare.filterDiff', { defaultValue: 'Differences only' })}</button>
        <button class="compare-filter-btn ${filter === 'all' ? 'active' : ''}" data-filter="all">${t('environments:compare.filterAll', { defaultValue: 'All settings' })}</button>
        <button class="compare-filter-btn ${filter === 'tuning' ? 'active' : ''}" data-filter="tuning">${t('environments:compare.filterTuning', { defaultValue: 'Tuning only' })}</button>
        <input type="text" id="compare-search" class="compare-search-input" placeholder="${t('environments:compare.searchPlaceholder', { defaultValue: 'Search setting name or attribute…' })}" value="${escapeHtml(s.compareSearch || '')}">
      </div>

      ${!showTuning || filter === 'all' ? renderSettingsTable(filteredRows) : ''}
      ${showTuning ? renderTuningTable(tuningRows) : ''}
    </div>
  `;
}

function fileBadge(name, exists) {
  const cls = exists ? 'present' : 'missing';
  const icon = exists ? '✓' : '✗';
  return `<span class="compare-file-badge ${cls}">${icon} ${escapeHtml(name)}</span>`;
}

function renderSettingsTable(rows) {
  if (rows.length === 0) {
    return `<p class="compare-empty">${t('environments:compare.noRows', { defaultValue: 'No rows match the current filter.' })}</p>`;
  }
  return `
    <table class="compare-table">
      <thead>
        <tr>
          <th>${t('environments:compare.colSetting', { defaultValue: 'Setting' })}</th>
          <th>${t('environments:compare.colApp', { defaultValue: 'App (saved)' })}</th>
          <th>${t('environments:compare.colSc', { defaultValue: 'SC (live)' })}</th>
          <th>${t('environments:compare.colSource', { defaultValue: 'Source' })}</th>
          <th>${t('environments:compare.colStatus', { defaultValue: 'Status' })}</th>
        </tr>
      </thead>
      <tbody>
        ${rows.map(r => `
          <tr class="compare-row status-${r.status} ${r.outOfRange ? 'out-of-range' : ''}" data-search="${escapeHtml(`${r.label} ${r.attrName} ${r.key}`)}">
            <td>
              <div class="compare-label">${escapeHtml(r.label)}${r.outOfRange ? ` <span class="compare-warn-tag" title="${t('environments:compare.outOfRangeTip', { count: r.labelCount, defaultValue: `SC value is outside our known labels (we only have ${r.labelCount} entries). A label is missing.` })}">label gap</span>` : ''}</div>
              <div class="compare-attr">${escapeHtml(r.attrName)}</div>
            </td>
            <td class="compare-value">${escapeHtml(r.displayApp)}</td>
            <td class="compare-value">${escapeHtml(r.displaySc)}</td>
            <td class="compare-source">${escapeHtml(r.source)}</td>
            <td class="compare-status">${statusIcon(r.status)}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
}

function renderTuningTable(rows) {
  if (rows.length === 0) {
    return `<p class="compare-empty">${t('environments:compare.noTuning', { defaultValue: 'No tuning entries in live actionmaps.xml.' })}</p>`;
  }
  // Group by device
  const byDevice = new Map();
  for (const r of rows) {
    const k = `${r.deviceType}#${r.instance}: ${r.device}`;
    if (!byDevice.has(k)) byDevice.set(k, []);
    byDevice.get(k).push(r);
  }
  return `
    <div class="compare-tuning">
      ${[...byDevice.entries()].map(([devKey, devRows]) => `
        <div class="compare-tuning-device">
          <h3>${escapeHtml(devKey)}</h3>
          <table class="compare-table compare-table-tuning">
            <thead>
              <tr>
                <th>${t('environments:compare.colTag', { defaultValue: 'Options tag' })}</th>
                <th>Invert</th>
                <th>Exponent</th>
                <th>Sensitivity</th>
                <th>${t('environments:compare.colDefault', { defaultValue: 'Default?' })}</th>
              </tr>
            </thead>
            <tbody>
              ${devRows.map(r => `
                <tr class="${r.isDefault ? 'tuning-default' : 'tuning-customized'}">
                  <td><code>${escapeHtml(r.tag)}</code></td>
                  <td>${r.invert}</td>
                  <td>${r.exponent}</td>
                  <td>${r.sensitivity}</td>
                  <td>${r.isDefault ? '✓' : '·'}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      `).join('')}
    </div>
  `;
}

function statusIcon(status) {
  switch (status) {
    case 'match': return `<span class="status-icon match" title="App and SC match">✓</span>`;
    case 'diff': return `<span class="status-icon diff" title="App and SC differ">⚠</span>`;
    case 'only-in-sc': return `<span class="status-icon only-sc" title="Only in SC">SC</span>`;
    case 'only-in-app': return `<span class="status-icon only-app" title="Only in App">APP</span>`;
    case 'unset': return `<span class="status-icon unset" title="Unset">·</span>`;
    default: return status;
  }
}

/**
 * Wires up the Compare tab event listeners. Called after rendering.
 */
export function attachCompareEventListeners(rerender) {
  const refreshBtn = document.getElementById('btn-compare-refresh');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', async () => {
      refreshBtn.disabled = true;
      refreshBtn.textContent = t('environments:compare.reading', { defaultValue: 'Reading…' });
      await loadLiveSettings();
      rerender();
    });
  }

  document.querySelectorAll('.compare-filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      setState({ compareFilter: btn.dataset.filter });
      rerender();
    });
  });

  document.querySelectorAll('.compare-pill[data-filter]').forEach(pill => {
    pill.addEventListener('click', () => {
      setState({ compareFilter: pill.dataset.filter });
      rerender();
    });
  });

  // Search input: filter rows in-place to keep input focused while typing.
  // Stores value in state so it survives re-renders triggered by other actions.
  const searchInput = document.getElementById('compare-search');
  if (searchInput) {
    searchInput.addEventListener('input', () => {
      const q = searchInput.value.trim().toLowerCase();
      setState({ compareSearch: searchInput.value });
      document.querySelectorAll('.compare-row').forEach(row => {
        const haystack = (row.dataset.search || '').toLowerCase();
        row.style.display = !q || haystack.includes(q) ? '' : 'none';
      });
    });
  }
}
