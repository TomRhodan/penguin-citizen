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
 * Penguin Citizen - Launch Page
 *
 * This module manages the launching of Star Citizen with configurable options:
 * - Start/stop of the RSI Launcher via Wine/Proton
 * - Performance options (ESync, FSync, DXVK Async)
 * - Display options (Wayland, HDR, FSR)
 * - Overlay options (MangoHUD, DXVK HUD)
 * - Monitor selection for Wayland mode
 * - Custom environment variables
 * - Real-time log output of the launch process
 *
 * @module pages/launch
 */

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { escapeHtml } from '../utils.js';
import { t } from '../i18n.js';

// ── Module-wide State ──────────────────────────────

/**
 * Current launch status of the launch page.
 * Possible values: 'idle' | 'checking' | 'ready' | 'launching' | 'running' | 'error' | 'not_installed'
 */
let launchStatus = 'idle';
/** @type {Object|null} Loaded app configuration (install path, runner, performance options) */
let launchConfig = null;
/** @type {string[]} Log lines collected during launch */
let launchLog = [];
/** @type {Object|null} Installation check result */
let installStatus = null;
/** @type {Array} Detected monitors for the Wayland monitor selection */
let detectedMonitors = [];
/** @type {Function|null} Unlisten function for log events from the backend */
let unlistenLaunchLog = null;
/** @type {Function|null} Unlisten function for the "game started" event */
let unlistenLaunchStarted = null;
/** @type {Function|null} Unlisten function for the "game exited" event */
let unlistenLaunchExited = null;
/** @type {string} Detected GPU vendor: 'nvidia', 'amd', 'intel', or 'unknown' */
let detectedGpuVendor = 'unknown';
/** @type {string} Detected GPU name for display */
let detectedGpuName = '';
/** @type {string[]} Vulkan device names for the GPU filter dropdown */
let vulkanDevices = [];
/** @type {boolean} Whether gamescope is installed on the system */
let gamescopeInstalled = false;
/** @type {boolean} Whether gamemoderun is installed on the system */
let gamemodeInstalled = false;

/**
 * Returns available launch options, grouped by category.
 * Each option has an internal key, a label, and a tooltip.
 * The keys correspond to the fields in launchConfig.performance.
 * Must be a function so that t() calls resolve at render time, not at import time.
 */
function getLaunchOptions() {
  return [
    { group: t('launch:option.group.performance'), options: [
      { key: 'esync', label: t('launch:option.esync'), tooltip: t('launch:tooltip.esync') },
      { key: 'fsync', label: t('launch:option.fsync'), tooltip: t('launch:tooltip.fsync') },
      { key: 'dxvk_async', label: t('launch:option.dxvkAsync'), tooltip: t('launch:tooltip.dxvkAsync') },
      { key: 'gamemode', label: t('launch:option.gamemode'), tooltip: t('launch:tooltip.gamemode'), requiresTool: 'gamemode' },
    ]},
    { group: t('launch:option.group.display'), options: [
      { key: 'hdr', label: t('launch:option.hdr'), tooltip: t('launch:tooltip.hdr') },
      { key: 'fsr', label: t('launch:option.fsr'), tooltip: t('launch:tooltip.fsr') },
    ]},
    { group: t('launch:option.group.overlays'), options: [
      { key: 'mangohud', label: t('launch:option.mangohud'), tooltip: t('launch:tooltip.mangohud') },
      { key: 'dxvk_hud', label: t('launch:option.dxvkHud'), tooltip: t('launch:tooltip.dxvkHud') },
    ]},
    { group: t('launch:option.group.nvidia'), gpuVendor: 'nvidia', options: [
      { key: 'nvidia_dlss', label: t('launch:option.nvidiaDlss'), tooltip: t('launch:tooltip.nvidiaDlss') },
      { key: 'nvidia_smooth_motion', label: t('launch:option.nvidiaSmoothMotion'), tooltip: t('launch:tooltip.nvidiaSmoothMotion') },
      { key: 'nvidia_gsync', label: t('launch:option.nvidiaGsync'), tooltip: t('launch:tooltip.nvidiaGsync') },
    ]},
    { group: t('launch:option.group.amd'), gpuVendor: 'amd', options: [
      { key: 'amd_radv_zero_vram', label: t('launch:option.amdRadv'), tooltip: t('launch:tooltip.amdRadv') },
      { key: 'amd_nogttspill', label: t('launch:option.amdNogttspill'), tooltip: t('launch:tooltip.amdNogttspill') },
    ]},
    { group: t('launch:option.group.troubleshooting'), options: [
      { key: 'in_process_gpu', label: t('launch:option.inProcessGpu'), tooltip: t('launch:tooltip.inProcessGpu') },
      { key: 'vulkan_mailbox', label: t('launch:option.vulkanMailbox'), tooltip: t('launch:tooltip.vulkanMailbox') },
      { key: 'enable_hdr_wsi', label: t('launch:option.enableHdrWsi'), tooltip: t('launch:tooltip.enableHdrWsi') },
    ]},
  ];
}

/**
 * Built-in environment variables set by the Rust backend (configure_wine_env()).
 * Used for conflict detection: if a user defines a custom variable with the same
 * name, a warning indicator is displayed.
 */
const BUILTIN_ENV_VARS = new Set([
  'WINEESYNC', 'WINEFSYNC', 'DXVK_ASYNC',
  'PROTON_ENABLE_HDR', 'DXVK_HDR', 'PROTON_FSR4_UPGRADE',
  'MANGOHUD', 'DXVK_HUD',
  'PROTON_ENABLE_WAYLAND', 'WAYLANDDRV_PRIMARY_MONITOR',
  'WINEPREFIX', 'WINEDLLOVERRIDES', 'WINEDEBUG', 'DISPLAY',
  '__GL_SHADER_DISK_CACHE', '__GL_SHADER_DISK_CACHE_SIZE',
  '__GL_SHADER_DISK_CACHE_PATH', '__GL_SHADER_DISK_CACHE_SKIP_CLEANUP',
  'MESA_SHADER_CACHE_DIR', 'MESA_SHADER_CACHE_MAX_SIZE',
  // Advanced launch options
  'PROTON_ENABLE_NGX_UPDATER',
  'DXVK_NVAPI_DRS_NGX_DLSS_SR_OVERRIDE', 'DXVK_NVAPI_DRS_NGX_DLSS_RR_OVERRIDE',
  'DXVK_NVAPI_DRS_NGX_DLSS_FG_OVERRIDE',
  'DXVK_NVAPI_DRS_NGX_DLSS_SR_OVERRIDE_RENDER_PRESET_SELECTION',
  'DXVK_NVAPI_DRS_NGX_DLSS_RR_OVERRIDE_RENDER_PRESET_SELECTION',
  'NVPRESENT_ENABLE_SMOOTH_MOTION', 'NVPRESENT_QUEUE_FAMILY',
  '__GL_GSYNC_ALLOWED', '__GL_MaxFramesAllowed',
  'radv_zero_vram', 'RADV_PERFTEST',
  'DXVK_FILTER_DEVICE_NAME', 'MESA_VK_WSI_PRESENT_MODE',
  'ENABLE_HDR_WSI', 'WINE_CPU_TOPOLOGY',
]);

// --- Auto-Launch-Flag ---

/**
 * When true, the game is automatically launched once the page is ready.
 * Set by the dashboard when the user clicks "Launch".
 */
let pendingAutoLaunch = false;

/**
 * Sets the auto-launch flag so that on the next render of the launch page,
 * the game is automatically started (e.g., from dashboard quick-launch).
 */
export function requestAutoLaunch() {
  pendingAutoLaunch = true;
}

// --- Main Render ---

/**
 * Entry point: Renders the launch page and starts the installation check.
 * Optionally carries over log lines from a previous installation process.
 * @param {HTMLElement} container - DOM container for the page
 */
export function renderLaunch(container) {
  launchStatus = 'checking';
  // Carry over logs from the installation process, if available
  launchLog = window._starControlLaunchLogs ? [...window._starControlLaunchLogs] : [];
  // Clear stored logs after loading
  window._starControlLaunchLogs = [];
  renderPage(container);
  loadAndCheck(container);
}

/**
 * Loads the configuration, checks the installation status, and determines the launch status.
 * Detects available monitors for the Wayland selection in parallel.
 * If auto-launch was requested and everything is ready, the launch is triggered.
 * @param {HTMLElement} container - DOM container for re-rendering
 */
async function loadAndCheck(container) {
  // Detect monitors in parallel (does not block the main flow)
  invoke('detect_monitors').then(monitors => {
    detectedMonitors = monitors || [];
    updateMonitorSelect();
    // Automatically disable Wayland when fractional scaling is detected
    if (hasFractionalScaling()) {
      if (launchConfig?.performance?.wayland) {
        launchConfig.performance.wayland = false;
      }
      renderPage(container);
    }
  }).catch(err => { console.warn('Monitor detection failed:', err); detectedMonitors = []; });

  // Detect GPU vendor for section greying
  invoke('detect_gpu_vendor').then(gpu => {
    detectedGpuVendor = gpu.vendor || 'unknown';
    detectedGpuName = gpu.name || '';
    renderPage(container);
  }).catch(() => {});

  // Detect Vulkan devices for GPU filter dropdown
  invoke('detect_vulkan_devices').then(devices => {
    vulkanDevices = devices || [];
  }).catch(() => {});

  // Check gamescope availability
  invoke('check_gamescope_installed').then(installed => {
    gamescopeInstalled = installed;
  }).catch(() => {});

  // Check gamemode availability
  invoke('check_gamemode_installed').then(installed => {
    gamemodeInstalled = installed;
  }).catch(() => {});

  try {
    const config = await invoke('load_config');
    if (!config) {
      launchStatus = 'not_installed';
      installStatus = { installed: false, message: t('launch:error.noConfig') };
      renderPage(container);
      return;
    }

    launchConfig = config;
    const status = await invoke('check_installation', { config });
    installStatus = status;

    if (status.installed) {
      // Check if the game process is already running (e.g., started by the installer)
      const running = await invoke('is_game_running');
      if (running) {
        launchStatus = 'running';
        listenForExit(container);
      } else {
        launchStatus = 'ready';
      }
    } else {
      launchStatus = 'not_installed';
    }
  } catch (err) {
    launchStatus = 'error';
    installStatus = { installed: false, message: String(err) };
  }

  renderPage(container);

  // Execute auto-launch if requested from the dashboard
  if (pendingAutoLaunch && launchStatus === 'ready') {
    pendingAutoLaunch = false;
    onLaunch(container);
  } else {
    pendingAutoLaunch = false;
  }
}

/**
 * Registers event listeners for the case when the game is already running.
 * Listens for "launch-exited" (game ended) and "launch-log" (log lines).
 */
function listenForExit(container) {
  cleanup();
  listen('launch-exited', () => {
    launchStatus = 'ready';
    renderPage(container);
    cleanup();
  }).then(fn => { unlistenLaunchExited = fn; }).catch(() => { });

  listen('launch-log', (event) => {
    launchLog.push(event.payload);
    appendLogLine(event.payload);
  }).then(fn => { unlistenLaunchLog = fn; }).catch(() => { });
}

/**
 * Re-renders the entire launch page:
 * Launch button, status display, info card, options grid, and log output.
 * Then binds all event listeners and scrolls the log to the bottom.
 */
function renderPage(container) {
  container.innerHTML = `
    <div class="page-header">
      <h1>${t('launch:title')}</h1>
      <p class="page-subtitle">${t('launch:subtitle')}</p>
    </div>
    <div class="launch-section">
      <div class="launch-center">
        ${renderLaunchButton()}
        ${renderLaunchStatus()}
        ${renderLaunchInfo()}
      </div>
      <div class="launch-options card">
        <h3>${t('launch:section.launchOptions')}</h3>
        ${renderOptionsGrid()}
      </div>
    </div>
    <div class="card log-panel-flex">
      <h3>${t('launch:section.logOutput')}</h3>
      <pre class="log-output log-output-flex" id="launch-log-output"><code>${t('launch:status.waitingForLaunch')}</code></pre>
    </div>
  `;

  // Populate log via textContent (preserves newlines, auto-escapes HTML)
  if (launchLog.length > 0) {
    const code = container.querySelector('#launch-log-output code');
    if (code) code.textContent = launchLog.join('\n');
  }

  bindEvents(container);
  scrollLog();
}

// --- Launch-Button ---

/**
 * Renders the launch/stop button depending on the current status.
 * In running state, a stop button is shown;
 * during launch, a spinner; otherwise a play icon.
 */
function renderLaunchButton() {
  const spinning = launchStatus === 'launching';
  const running = launchStatus === 'running';

  if (running) {
    return `
      <button class="btn-launch stop" id="btn-stop">
        <svg class="launch-icon" viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>
        <span>${t('launch:button.stop')}</span>
      </button>
    `;
  }

  const disabled = launchStatus !== 'ready';

  let label = t('launch:button.launch');
  if (spinning) label = t('launch:button.launching');
  if (launchStatus === 'checking') label = t('launch:button.checking');

  const iconSvg = spinning
    ? '<div class="launch-spinner"></div>'
    : '<svg class="launch-icon" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>';

  return `
    <button class="btn-launch" id="btn-launch" ${disabled ? 'disabled' : ''}>
      ${iconSvg}
      <span>${label}</span>
    </button>
  `;
}

// --- Status Display ---

/**
 * Renders the context-dependent status message below the launch button.
 * Shows depending on state: installation hint, error message, running hint, or nothing.
 */
function renderLaunchStatus() {
  if (launchStatus === 'not_installed') {
    const msg = installStatus?.message || t('launch:error.notInstalled');
    return `
      <div class="launch-not-installed">
        <p>${escapeHtml(msg)}</p>
        <button class="btn btn-primary btn-sm" id="btn-goto-install">${t('launch:button.gotoInstall')}</button>
      </div>
    `;
  }

  if (launchStatus === 'error') {
    const msg = installStatus?.message || t('launch:error.generic');
    return `
      <div class="launch-status error">
        <p>${escapeHtml(msg)}</p>
        <button class="btn btn-sm" id="btn-retry-check">${t('launch:button.retry')}</button>
      </div>
    `;
  }

  if (launchStatus === 'running') {
    return `<div class="launch-status running">${t('launch:status.running')}</div>`;
  }

  if (launchStatus === 'checking') {
    return `<div class="launch-status checking">${t('launch:status.checking')}</div>`;
  }

  return '';
}

// --- Info Card ---

/**
 * Renders the info card with active configuration (runner name, prefix path).
 * Only displayed when SC is installed and configured.
 */
function renderLaunchInfo() {
  if (!launchConfig || !installStatus?.installed) return '';

  const runner = launchConfig.selected_runner || t('launch:label.none');
  const prefix = launchConfig.install_path || '?';

  const runnerIcon = `<svg class="launch-runner-badge-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>`;

  return `
    <div class="launch-info">
      <div class="launch-info-card">
        <div class="launch-info-card-title">${t('launch:label.infoCardTitle')}</div>
        <div class="launch-info-row">
          <span class="launch-info-label">${t('launch:label.runner')}</span>
          <span class="launch-runner-badge">
            ${runnerIcon}
            ${escapeHtml(runner)}
          </span>
        </div>
        <div class="launch-info-row">
          <span class="launch-info-label">${t('launch:label.prefix')}</span>
          <span class="launch-prefix-value">${escapeHtml(prefix)}</span>
        </div>
      </div>
    </div>
  `;
}

// --- Options Grid ---

/**
 * Renders the complete options grid with performance, display, overlay toggles,
 * Wayland settings, and custom environment variables.
 * All options are disabled when the game is currently running or launching.
 */
function renderOptionsGrid() {
  // Disable all options when not in "ready" state
  const disabled = launchStatus === 'launching' || launchStatus === 'running' || launchStatus === 'not_installed' || launchStatus === 'checking';
  const perf = launchConfig?.performance || {};
  const fractional = hasFractionalScaling();

  const waylandTooltip = fractional
    ? t('launch:tooltip.waylandFractional')
    : t('launch:tooltip.wayland');

  return `
    <div class="launch-options-grid">
      ${getLaunchOptions().map(group => {
    const isGpuGroup = !!group.gpuVendor;
    const gpuMismatch = isGpuGroup && detectedGpuVendor !== group.gpuVendor;
    const groupClass = gpuMismatch ? 'launch-option-group gpu-disabled' : 'launch-option-group';

    return `
        <div class="${groupClass}">
          <div class="launch-option-group-title">
            ${group.group}
            ${isGpuGroup && !gpuMismatch && detectedGpuName ? `<span class="gpu-detected-label">${t('launch:label.gpuDetected', { name: escapeHtml(detectedGpuName) })}</span>` : ''}
            ${gpuMismatch ? `<span class="gpu-not-detected-label">${t('launch:label.noGpuDetected', { vendor: group.gpuVendor.toUpperCase() })}</span>` : ''}
          </div>
          ${group.options.map(opt => {
      const isGpuDisabled = gpuMismatch;
      const isToolMissing = opt.requiresTool === 'gamemode' && !gamemodeInstalled;
      const isDisabled = disabled || isGpuDisabled || isToolMissing;
      let tooltip = opt.tooltip || '';
      if (isToolMissing) tooltip = t('launch:label.gamemodeNotInstalled');
      return `
              <label class="toggle-option${isGpuDisabled ? ' toggle-gpu-disabled' : ''}${isToolMissing ? ' toggle-tool-missing' : ''}" ${tooltip ? `data-tooltip="${tooltip}"` : ''}>
                <input type="checkbox" data-key="${opt.key}"
                  ${perf[opt.key] ? 'checked' : ''}
                  ${isDisabled ? 'disabled' : ''} />
                <span>${opt.label}</span>
              </label>
            `;
    }).join('')}
        </div>
      `;
  }).join('')}
    </div>

    <div class="launch-gpu-selection-area">
      <div class="launch-option-group-title">${t('launch:option.group.gpuSelection')}</div>
      <div class="launch-gpu-filter-row">
        <select class="input launch-gpu-filter-select" id="launch-gpu-filter" ${disabled ? 'disabled' : ''}>
          <option value="">${t('launch:label.gpuAutomatic')}</option>
          ${vulkanDevices.map(d => `<option value="${escapeHtml(d)}" ${perf.gpu_device_filter === d ? 'selected' : ''}>${escapeHtml(d)}</option>`).join('')}
        </select>
        <span class="launch-gpu-filter-hint">${t('launch:label.gpuFilterHint')}</span>
      </div>
    </div>

    <div class="launch-troubleshooting-extras">
      <div class="launch-option-group-title">${t('launch:label.cpuTopology')}</div>
      <input type="text" class="input launch-cpu-topology-input" id="launch-cpu-topology"
        value="${escapeHtml(perf.wine_cpu_topology || '')}"
        placeholder="${t('launch:label.cpuTopologyPlaceholder')}"
        ${disabled ? 'disabled' : ''} />
    </div>

    <div class="launch-wayland-area">
      <div class="launch-wayland-header">
        <h4>${t('launch:section.wayland')} <span class="badge-experimental">${t('launch:badge.experimental')}</span></h4>
        <p class="wayland-warning-text">${t('launch:desc.waylandWarning')}</p>
      </div>
      <div class="launch-wayland-content">
        <label class="toggle-option ${fractional ? 'toggle-blocked' : ''}" data-tooltip="${waylandTooltip}">
          <input type="checkbox" data-key="wayland"
            ${!fractional && perf.wayland ? 'checked' : ''}
            ${disabled || fractional ? 'disabled' : ''} />
          <span>${t('launch:label.enableWayland')}</span>
        </label>
        ${renderMonitorSelect(disabled, perf)}
      </div>
      ${fractional ? `<div class="launch-scaling-warning">${t('launch:desc.fractionalScalingWarning')}</div>` : ''}
    </div>

    <div class="launch-gamescope-area">
      <div class="launch-gamescope-header">
        <h4>${t('launch:section.gamescope')}
          ${gamescopeInstalled
    ? `<span class="badge-installed">${t('launch:badge.installed')}</span>`
    : `<span class="badge-not-installed">${t('launch:badge.notInstalled')}</span>`}
        </h4>
      </div>
      <div class="launch-gamescope-content">
        <label class="toggle-option" data-tooltip="${t('launch:tooltip.gamescopeEnable')}">
          <input type="checkbox" id="gamescope-enabled"
            ${perf.gamescope?.enabled ? 'checked' : ''}
            ${disabled || !gamescopeInstalled ? 'disabled' : ''} />
          <span>${t('launch:option.gamescopeEnable')}</span>
        </label>
        <div class="launch-gamescope-options ${!perf.gamescope?.enabled ? 'gamescope-disabled' : ''}">
          <div class="launch-gamescope-resolution">
            <label>
              <span>${t('launch:label.gamescopeWidth')}</span>
              <input type="number" class="input gamescope-input" id="gamescope-width"
                value="${perf.gamescope?.width || ''}" placeholder="2560"
                ${disabled || !perf.gamescope?.enabled ? 'disabled' : ''} />
            </label>
            <label>
              <span>${t('launch:label.gamescopeHeight')}</span>
              <input type="number" class="input gamescope-input" id="gamescope-height"
                value="${perf.gamescope?.height || ''}" placeholder="1440"
                ${disabled || !perf.gamescope?.enabled ? 'disabled' : ''} />
            </label>
          </div>
          <label class="toggle-option" data-tooltip="${t('launch:tooltip.gamescopeHdr')}">
            <input type="checkbox" id="gamescope-hdr"
              ${perf.gamescope?.hdr ? 'checked' : ''}
              ${disabled || !perf.gamescope?.enabled ? 'disabled' : ''} />
            <span>${t('launch:option.gamescopeHdr')}</span>
          </label>
          <label class="toggle-option" data-tooltip="${t('launch:tooltip.gamescopeGrabCursor')}">
            <input type="checkbox" id="gamescope-grab-cursor"
              ${perf.gamescope?.force_grab_cursor ? 'checked' : ''}
              ${disabled || !perf.gamescope?.enabled ? 'disabled' : ''} />
            <span>${t('launch:option.gamescopeGrabCursor')}</span>
          </label>
          <label class="toggle-option" data-tooltip="${t('launch:tooltip.gamescopeKeyboard')}">
            <input type="checkbox" id="gamescope-keyboard"
              ${perf.gamescope?.keyboard_grab ? 'checked' : ''}
              ${disabled || !perf.gamescope?.enabled ? 'disabled' : ''} />
            <span>${t('launch:option.gamescopeKeyboard')}</span>
          </label>
        </div>
        ${!gamescopeInstalled ? `<div class="launch-tool-not-installed">${t('launch:label.gamescopeNotInstalled')}</div>` : ''}
      </div>
    </div>

    ${renderCustomEnvVars(disabled)}
  `;
}

/**
 * Renders the list of custom environment variables.
 * Each variable has an on/off toggle, KEY=value input fields,
 * a delete button, and optionally a conflict warning indicator.
 * @param {boolean} disabled - Whether the inputs should be disabled
 */
function renderCustomEnvVars(disabled) {
  const vars = launchConfig?.performance?.custom_env_vars || [];
  const rows = vars.map((v, i) => {
    // Check if the variable name overrides a built-in variable
    const isConflict = v.key && BUILTIN_ENV_VARS.has(v.key);
    const disabledClass = !v.enabled ? ' env-var-disabled' : '';
    return `
      <div class="env-var-row${disabledClass}" data-env-index="${i}">
        <input type="checkbox" class="env-var-toggle" data-env-index="${i}"
          ${v.enabled ? 'checked' : ''} ${disabled ? 'disabled' : ''} />
        <input type="text" class="input env-var-key" data-env-index="${i}"
          value="${escapeHtml(v.key)}" placeholder="${t('launch:placeholder.envKey')}" ${disabled ? 'disabled' : ''} />
        <span class="env-var-equals">=</span>
        <input type="text" class="input env-var-value" data-env-index="${i}"
          value="${escapeHtml(v.value)}" placeholder="${t('launch:placeholder.envValue')}" ${disabled ? 'disabled' : ''} />
        ${isConflict ? `<span class="env-var-conflict" data-tooltip="${t('launch:tooltip.envVarConflict')}">⚠ ${t('launch:badge.override')}</span>` : ''}
        <button class="btn-env-delete" data-env-index="${i}" ${disabled ? 'disabled' : ''} title="${t('launch:tooltip.removeVariable')}">✕</button>
      </div>
    `;
  }).join('');

  return `
    <div class="launch-custom-env-area">
      <div class="launch-custom-env-header">
        <h4>${t('launch:section.customEnvVars')}</h4>
        <p class="custom-env-hint">${t('launch:desc.customEnvHint')}</p>
      </div>
      <div class="launch-custom-env-content">
        ${rows}
        <button class="btn btn-sm btn-add-env" id="btn-add-env" ${disabled ? 'disabled' : ''}>${t('launch:button.addVariable')}</button>
      </div>
    </div>
  `;
}

/**
 * Renders the Wayland monitor selection.
 * If monitors were detected, a dropdown is shown;
 * otherwise a free-text input field (e.g., "DP-1").
 * @param {boolean} disabled - Whether the input should be disabled
 * @param {Object} perf - Performance configuration with primary_monitor
 */
function renderMonitorSelect(disabled, perf) {
  const hasMonitor = !!perf.primary_monitor;

  let selectHtml;
  if (detectedMonitors.length > 0) {
    const options = detectedMonitors.map(m => {
      const label = `${m.name}${m.resolution ? ' (' + m.resolution : ''}${m.primary ? ', ' + t('launch:monitor.primary') + ')' : m.resolution ? ')' : ''}`;
      const selected = perf.primary_monitor === m.name ? 'selected' : '';
      return `<option value="${escapeHtml(m.name)}" ${selected}>${escapeHtml(label)}</option>`;
    }).join('');
    selectHtml = `<select class="input launch-monitor-input" id="launch-monitor-select" ${!hasMonitor || disabled ? 'disabled' : ''}>${options}</select>`;
  } else {
    selectHtml = `<input type="text" class="input launch-monitor-input" id="launch-monitor-input" value="${escapeHtml(perf.primary_monitor || '')}" placeholder="${t('launch:placeholder.monitorInput')}" ${!hasMonitor || disabled ? 'disabled' : ''} />`;
  }

  return `
    <div class="launch-monitor-row">
      <label class="toggle-option" data-tooltip="${t('launch:tooltip.waylandMonitor')}" data-tooltip-pos="bottom">
        <input type="checkbox" id="launch-monitor-enabled" ${hasMonitor ? 'checked' : ''} ${disabled ? 'disabled' : ''} />
        <span>${t('launch:label.waylandMonitor')}</span>
      </label>
      <div class="launch-monitor-select-wrap ${!hasMonitor ? 'disabled' : ''}" id="launch-monitor-wrap">
        ${selectHtml}
      </div>
    </div>
  `;
}

/**
 * Updates the monitor dropdown after asynchronous monitor detection.
 * Replaces the wrap content with the detected monitors.
 */
function updateMonitorSelect() {
  const wrap = document.getElementById('launch-monitor-wrap');
  if (!wrap || detectedMonitors.length === 0) return;

  const perf = launchConfig?.performance || {};
  const hasMonitor = !!perf.primary_monitor;
  const disabled = launchStatus === 'launching' || launchStatus === 'running' || launchStatus === 'not_installed' || launchStatus === 'checking';

  const options = detectedMonitors.map(m => {
    const label = `${m.name}${m.resolution ? ' (' + m.resolution : ''}${m.primary ? ', ' + t('launch:monitor.primary') + ')' : m.resolution ? ')' : ''}`;
    const selected = perf.primary_monitor === m.name ? 'selected' : '';
    return `<option value="${escapeHtml(m.name)}" ${selected}>${escapeHtml(label)}</option>`;
  }).join('');

  wrap.innerHTML = `<select class="input launch-monitor-input" id="launch-monitor-select" ${!hasMonitor || disabled ? 'disabled' : ''}>${options}</select>`;
  bindMonitorSelectListener();
}

/** Binds change events to the monitor dropdown or input field */
function bindMonitorSelectListener() {
  const select = document.getElementById('launch-monitor-select');
  if (select) {
    select.addEventListener('change', () => {
      if (launchConfig) launchConfig.performance.primary_monitor = select.value || null;
    });
  }
  const input = document.getElementById('launch-monitor-input');
  if (input) {
    input.addEventListener('input', () => {
      if (launchConfig) launchConfig.performance.primary_monitor = input.value.trim() || null;
    });
  }
}

// --- Event-Handler ---

/**
 * Binds all event listeners for the launch page:
 * - Launch/stop buttons
 * - "Go to installation" button when SC is missing
 * - Retry button on errors
 * - Toggle checkboxes for launch options (performance, display, overlays)
 * - Monitor selection for Wayland
 * - Custom environment variables
 */
function bindEvents(container) {
  const launchBtn = document.getElementById('btn-launch');
  if (launchBtn) {
    launchBtn.addEventListener('click', () => onLaunch(container));
  }

  const stopBtn = document.getElementById('btn-stop');
  if (stopBtn) {
    stopBtn.addEventListener('click', () => onStop(container));
  }

  const gotoBtn = document.getElementById('btn-goto-install');
  if (gotoBtn) {
    gotoBtn.addEventListener('click', () => {
      const link = document.querySelector('.nav-link[data-page="installation"]');
      if (link) link.click();
    });
  }

  const retryBtn = document.getElementById('btn-retry-check');
  if (retryBtn) {
    retryBtn.addEventListener('click', () => {
      launchStatus = 'checking';
      renderPage(container);
      loadAndCheck(container);
    });
  }

  // Toggle listener: Updates the performance options in the configuration
  container.querySelectorAll('.launch-options-grid input[type="checkbox"]').forEach(cb => {
    if (!cb.dataset.key) return;
    cb.addEventListener('change', () => {
      if (launchConfig) {
        launchConfig.performance[cb.dataset.key] = cb.checked;
      }
    });
  });

  // Monitor enable checkbox: Toggles the monitor selector on/off
  const monitorCb = document.getElementById('launch-monitor-enabled');
  if (monitorCb) {
    monitorCb.addEventListener('change', () => {
      const wrap = document.getElementById('launch-monitor-wrap');
      if (monitorCb.checked) {
        if (wrap) wrap.classList.remove('disabled');
        const select = document.getElementById('launch-monitor-select');
        const input = document.getElementById('launch-monitor-input');
        if (select) { select.disabled = false; if (launchConfig) launchConfig.performance.primary_monitor = select.value || (detectedMonitors[0]?.name ?? null); }
        if (input) { input.disabled = false; if (launchConfig) launchConfig.performance.primary_monitor = input.value.trim() || null; }
      } else {
        if (launchConfig) launchConfig.performance.primary_monitor = null;
        if (wrap) wrap.classList.add('disabled');
        const select = document.getElementById('launch-monitor-select');
        const input = document.getElementById('launch-monitor-input');
        if (select) select.disabled = true;
        if (input) input.disabled = true;
      }
    });
  }

  // GPU device filter dropdown
  const gpuFilter = document.getElementById('launch-gpu-filter');
  if (gpuFilter) {
    gpuFilter.addEventListener('change', () => {
      if (launchConfig) {
        launchConfig.performance.gpu_device_filter = gpuFilter.value || null;
      }
    });
  }

  // CPU topology input
  const cpuTopology = document.getElementById('launch-cpu-topology');
  if (cpuTopology) {
    cpuTopology.addEventListener('input', () => {
      if (launchConfig) {
        launchConfig.performance.wine_cpu_topology = cpuTopology.value.trim() || null;
        debouncedSaveConfig();
      }
    });
  }

  // Gamescope enable toggle
  const gsEnabled = document.getElementById('gamescope-enabled');
  if (gsEnabled) {
    gsEnabled.addEventListener('change', () => {
      if (launchConfig) {
        if (!launchConfig.performance.gamescope) {
          launchConfig.performance.gamescope = { enabled: false, hdr: false, force_grab_cursor: false, keyboard_grab: false };
        }
        launchConfig.performance.gamescope.enabled = gsEnabled.checked;
        renderPage(container);
      }
    });
  }

  // Gamescope sub-options
  const gsWidth = document.getElementById('gamescope-width');
  if (gsWidth) {
    gsWidth.addEventListener('input', () => {
      if (launchConfig?.performance?.gamescope) {
        const val = parseInt(gsWidth.value, 10);
        launchConfig.performance.gamescope.width = isNaN(val) ? null : val;
        debouncedSaveConfig();
      }
    });
  }
  const gsHeight = document.getElementById('gamescope-height');
  if (gsHeight) {
    gsHeight.addEventListener('input', () => {
      if (launchConfig?.performance?.gamescope) {
        const val = parseInt(gsHeight.value, 10);
        launchConfig.performance.gamescope.height = isNaN(val) ? null : val;
        debouncedSaveConfig();
      }
    });
  }
  const gsHdr = document.getElementById('gamescope-hdr');
  if (gsHdr) {
    gsHdr.addEventListener('change', () => {
      if (launchConfig?.performance?.gamescope) {
        launchConfig.performance.gamescope.hdr = gsHdr.checked;
      }
    });
  }
  const gsGrabCursor = document.getElementById('gamescope-grab-cursor');
  if (gsGrabCursor) {
    gsGrabCursor.addEventListener('change', () => {
      if (launchConfig?.performance?.gamescope) {
        launchConfig.performance.gamescope.force_grab_cursor = gsGrabCursor.checked;
      }
    });
  }
  const gsKeyboard = document.getElementById('gamescope-keyboard');
  if (gsKeyboard) {
    gsKeyboard.addEventListener('change', () => {
      if (launchConfig?.performance?.gamescope) {
        launchConfig.performance.gamescope.keyboard_grab = gsKeyboard.checked;
      }
    });
  }

  bindMonitorSelectListener();
  bindEnvVarEvents(container);
}

/**
 * Binds event listeners for the custom environment variables:
 * - Toggle: Enables/disables a variable
 * - Key input: Only [A-Z0-9_] allowed, auto-uppercase, conflict detection
 * - Value input: Free text input
 * - Delete: Removes the variable from the list
 * - Add: Adds a new empty variable
 */
function bindEnvVarEvents(container) {
  // Toggle: Enable/disable variable
  container.querySelectorAll('.env-var-toggle').forEach(cb => {
    cb.addEventListener('change', () => {
      const i = parseInt(cb.dataset.envIndex, 10);
      if (launchConfig?.performance?.custom_env_vars?.[i] != null) {
        launchConfig.performance.custom_env_vars[i].enabled = cb.checked;
        saveConfigNow();
        renderPage(container);
      }
    });
  });

  // Key input: Only letters, numbers, and underscores allowed, auto-uppercase
  container.querySelectorAll('.env-var-key').forEach(input => {
    input.addEventListener('input', () => {
      const i = parseInt(input.dataset.envIndex, 10);
      const cleaned = input.value.replace(/[^A-Za-z0-9_]/g, '').toUpperCase();
      if (input.value !== cleaned) {
        const pos = input.selectionStart - (input.value.length - cleaned.length);
        input.value = cleaned;
        input.setSelectionRange(pos, pos);
      }
      if (launchConfig?.performance?.custom_env_vars?.[i] != null) {
        launchConfig.performance.custom_env_vars[i].key = cleaned;
        debouncedSaveConfig();
        // Update conflict badge inline without full re-rendering
        const row = input.closest('.env-var-row');
        if (row) {
          const existing = row.querySelector('.env-var-conflict');
          const isConflict = cleaned && BUILTIN_ENV_VARS.has(cleaned);
          if (isConflict && !existing) {
            const badge = document.createElement('span');
            badge.className = 'env-var-conflict';
            badge.setAttribute('data-tooltip', t('launch:tooltip.envVarConflict'));
            badge.textContent = '⚠ ' + t('launch:badge.override');
            const delBtn = row.querySelector('.btn-env-delete');
            row.insertBefore(badge, delBtn);
          } else if (!isConflict && existing) {
            existing.remove();
          }
        }
      }
    });
  });

  // Value input: Free text input for the variable value
  container.querySelectorAll('.env-var-value').forEach(input => {
    input.addEventListener('input', () => {
      const i = parseInt(input.dataset.envIndex, 10);
      if (launchConfig?.performance?.custom_env_vars?.[i] != null) {
        launchConfig.performance.custom_env_vars[i].value = input.value;
        debouncedSaveConfig();
      }
    });
  });

  // Delete: Remove variable from the list and update UI
  container.querySelectorAll('.btn-env-delete').forEach(btn => {
    btn.addEventListener('click', () => {
      const i = parseInt(btn.dataset.envIndex, 10);
      if (launchConfig?.performance?.custom_env_vars) {
        launchConfig.performance.custom_env_vars.splice(i, 1);
        saveConfigNow();
        renderPage(container);
      }
    });
  });

  // Add: Create new empty variable and focus the key field
  const addBtn = document.getElementById('btn-add-env');
  if (addBtn) {
    addBtn.addEventListener('click', () => {
      if (!launchConfig) return;
      if (!launchConfig.performance.custom_env_vars) {
        launchConfig.performance.custom_env_vars = [];
      }
      launchConfig.performance.custom_env_vars.push({ key: '', value: '', enabled: true });
      saveConfigNow();
      renderPage(container);
      // Focus the new key input
      const inputs = container.querySelectorAll('.env-var-key');
      if (inputs.length > 0) inputs[inputs.length - 1].focus();
    });
  }
}

/**
 * Starts the game process:
 * 1. Save configuration (in case toggles were changed)
 * 2. Check localization and automatically update if needed
 * 3. Register event listeners for logs, start, and exit events
 * 4. Trigger game launch via the Rust backend
 * @param {HTMLElement} container - DOM container for re-rendering
 */
async function onLaunch(container) {
  if (launchStatus !== 'ready' || !launchConfig) return;

  launchStatus = 'launching';
  launchLog = [];
  renderPage(container);

  // Save configuration in case toggle values have changed
  try {
    await invoke('save_config', { config: launchConfig });
  } catch (e) {
    // Not critical - game can still start
  }

  // Check localization before launch and automatically update if needed
  await checkAndUpdateLocalization(container);

  // Clean up old event listeners and register new ones
  cleanup();

  try {
    unlistenLaunchLog = await listen('launch-log', (event) => {
      const line = event.payload;
      launchLog.push(line);
      appendLogLine(line);
    });

    unlistenLaunchStarted = await listen('launch-started', () => {
      launchStatus = 'running';
      renderPage(container);
    });

    unlistenLaunchExited = await listen('launch-exited', () => {
      launchStatus = 'ready';
      renderPage(container);
      cleanup();
    });
  } catch (e) {
    console.error('Failed to register launch event listeners:', e);
  }

  try {
    await invoke('launch_game', { config: launchConfig });
    if (launchStatus === 'launching') {
      launchStatus = 'running';
      renderPage(container);
    }
  } catch (err) {
    launchStatus = 'error';
    installStatus = { installed: true, message: String(err) };
    launchLog.push(`ERROR: ${err}`);
    renderPage(container);
    cleanup();
  }
}

/**
 * Stops the running game process via the Rust backend.
 * Errors are written to the log.
 */
async function onStop(container) {
  if (launchStatus !== 'running') return;

  try {
    await invoke('stop_game');
  } catch (err) {
    launchLog.push(`ERROR stopping: ${err}`);
    appendLogLine(`ERROR stopping: ${err}`);
  }
}

/**
 * Appends a new line to the log output.
 * Replaces the placeholder text "Waiting for launch..." on the first entry.
 */
function appendLogLine(text) {
  const logEl = document.getElementById('launch-log-output');
  if (!logEl) return;

  const code = logEl.querySelector('code');
  if (code) {
    if (launchLog.length === 1 && code.textContent === t('launch:status.waitingForLaunch')) {
      code.textContent = '';
    }
    code.textContent += (code.textContent ? '\n' : '') + text;
  }

  scrollLog();
}

/** Automatically scrolls the log output field to the end */
function scrollLog() {
  const logEl = document.getElementById('launch-log-output');
  if (logEl) {
    logEl.scrollTop = logEl.scrollHeight;
  }
}

/** Cleans up all active event listeners (prevents memory leaks on re-renders) */
function cleanup() {
  if (unlistenLaunchLog) { unlistenLaunchLog(); unlistenLaunchLog = null; }
  if (unlistenLaunchStarted) { unlistenLaunchStarted(); unlistenLaunchStarted = null; }
  if (unlistenLaunchExited) { unlistenLaunchExited(); unlistenLaunchExited = null; }
}

// --- Fractional Scaling ---

/**
 * Checks if any detected monitor uses fractional scaling (e.g., 1.25x, 1.5x).
 * Wayland mode is not compatible with fractional scaling and is automatically disabled.
 * @returns {boolean} true if at least one monitor uses fractional scaling
 */
function hasFractionalScaling() {
  return detectedMonitors.some(m => m.scale != null && Math.abs(m.scale - 1.0) > 0.01);
}

// --- Pre-launch Localization Check ---

/**
 * Shows an overlay with spinner and message while
 * localization is checked/updated before game launch.
 * @param {Array<{text: string, bold?: boolean}>} parts - Message parts to display
 * @returns {HTMLElement} The created overlay element
 */
function showPreLaunchOverlay(parts) {
  let overlay = document.getElementById('pre-launch-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'pre-launch-overlay';
    overlay.className = 'pre-launch-overlay';
    document.body.appendChild(overlay);
  }
  overlay.innerHTML = `
    <div class="pre-launch-dialog">
      <div class="pre-launch-spinner"></div>
      <span class="pre-launch-message"></span>
    </div>
  `;
  updatePreLaunchMessage(parts);
  return overlay;
}

/**
 * Updates the message in the pre-launch overlay using safe DOM construction.
 * @param {Array<{text: string, bold?: boolean}>} parts - Message parts to display
 */
function updatePreLaunchMessage(parts) {
  const el = document.querySelector('.pre-launch-message');
  if (!el) return;
  el.textContent = '';
  for (const part of parts) {
    if (part.bold) {
      const strong = document.createElement('strong');
      strong.textContent = part.text;
      el.appendChild(strong);
    } else {
      el.appendChild(document.createTextNode(part.text));
    }
  }
}

/** Removes the pre-launch overlay from the DOM */
function removePreLaunchOverlay() {
  const overlay = document.getElementById('pre-launch-overlay');
  if (overlay) overlay.remove();
}

/**
 * Checks before game launch whether installed translations need updates,
 * and performs them automatically. Shows an overlay with progress.
 * Iterates through all detected SC versions and updates each that is outdated.
 * @param {HTMLElement} container - DOM container (not currently used directly)
 */
async function checkAndUpdateLocalization(container) {
  if (!launchConfig?.install_path) return;

  let versions;
  try {
    versions = await invoke('detect_sc_versions', { gp: launchConfig.install_path });
  } catch { return; }

  if (!versions || versions.length === 0) return;

  // Find versions with installed localizations
  const installed = [];
  for (const v of versions) {
    try {
      const status = await invoke('get_localization_status', {
        gamePath: launchConfig.install_path,
        version: v.version,
      });
      if (status?.installed) {
        installed.push({ version: v.version, status });
      }
    } catch { /* skip */ }
  }

  if (installed.length === 0) return;

  // Show overlay and wait for actual rendering (double rAF)
  showPreLaunchOverlay([{ text: t('launch:notification.localizationChecking') }]);
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

  let updatedCount = 0;
  for (const { version, status } of installed) {
    const langName = status.language_name || status.language_code || 'Unknown';

    let needsUpdate = false;
    try {
      const check = await invoke('check_localization_update', {
        gamePath: launchConfig.install_path,
        version,
      });
      needsUpdate = check?.update_available === true;
    } catch { /* skip */ }

    if (!needsUpdate) continue;

    updatePreLaunchMessage([
      { text: t('launch:notification.localizationUpdating', { langName, version }) },
    ]);

    try {
      const languages = await invoke('get_available_languages', { version });
      const source = languages.find(
        l => l.language_code === status.language_code && l.source_label === status.source_label
      ) || languages.find(l => l.language_code === status.language_code);

      if (source) {
        await invoke('install_localization', {
          gamePath: launchConfig.install_path,
          version,
          languageCode: source.language_code,
          sourceRepo: source.source_repo,
          languageName: source.language_name,
          sourceLabel: source.source_label,
        });
        launchLog.push(`[Localization] Updated ${langName} for ${version}`);
        updatedCount++;
      }
    } catch (e) {
      launchLog.push(`[Localization] Update failed for ${version}: ${e}`);
    }
  }

  // Show brief result message before closing the overlay
  if (updatedCount > 0) {
    updatePreLaunchMessage([{ text: t('launch:notification.localizationUpdated', { count: updatedCount }) }]);
    await new Promise(r => setTimeout(r, 1200));
  } else {
    updatePreLaunchMessage([{ text: t('launch:notification.localizationUpToDate') }]);
    await new Promise(r => setTimeout(r, 800));
  }

  removePreLaunchOverlay();
}

// --- Helper Functions ---

/**
 * Delayed saving of the configuration (400ms debounce).
 * Used for keyboard input in environment variables
 * to avoid writing to disk on every keystroke.
 */
let _saveConfigTimer = null;
function debouncedSaveConfig() {
  if (!launchConfig) return;
  clearTimeout(_saveConfigTimer);
  _saveConfigTimer = setTimeout(() => {
    invoke('save_config', { config: launchConfig }).catch(err => console.warn('Config save failed:', err));
  }, 400);
}

/**
 * Flushes any pending debounced config save immediately.
 * Called on page navigation to prevent data loss.
 */
export function flushPendingSave() {
  if (_saveConfigTimer) {
    clearTimeout(_saveConfigTimer);
    _saveConfigTimer = null;
    if (launchConfig) {
      invoke('save_config', { config: launchConfig }).catch(err => console.warn('Flush save failed:', err));
    }
  }
}

/** Immediate save (for add/delete, where the UI re-renders immediately) */
function saveConfigNow() {
  if (!launchConfig) return;
  clearTimeout(_saveConfigTimer);
  invoke('save_config', { config: launchConfig }).catch(err => console.warn('Config save failed:', err));
}


