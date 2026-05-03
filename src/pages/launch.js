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
 * Layout: Compact launch bar + collapsible 3-column card grid + log output
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
let monitorsReady = false;
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
/** @type {boolean} Whether the shader cache is missing (triggers a warning banner) */
let shaderCacheMissing = false;
/** @type {Set<string>} Tracks which option cards are currently expanded */
const expandedCards = new Set();
/** @type {boolean} Whether the custom env vars section is expanded */
let envVarsExpanded = false;

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
 * Card definitions for the 3x3 grid layout.
 * Maps card keys to their display properties and content sources.
 */
function getCardDefinitions() {
  const options = getLaunchOptions();
  return [
    // Row 1
    { key: 'performance', title: t('launch:option.group.performance'), source: options[0] },
    { key: 'display', title: t('launch:option.group.display'), source: options[1] },
    { key: 'overlays', title: t('launch:option.group.overlays'), source: options[2] },
    // Row 2
    { key: 'nvidia', title: t('launch:option.group.nvidia'), source: options[3], gpuVendor: 'nvidia' },
    { key: 'amd', title: t('launch:option.group.amd'), source: options[4], gpuVendor: 'amd' },
    { key: 'troubleshooting', title: t('launch:option.group.troubleshooting'), source: options[5] },
    // Row 3
    { key: 'wayland', title: t('launch:section.wayland'), special: 'wayland' },
    { key: 'gamescope', title: t('launch:section.gamescope'), special: 'gamescope' },
    { key: 'gpu_cpu', title: t('launch:card.gpuCpu'), special: 'gpu_cpu' },
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
  'PROTON_ENABLE_WAYLAND', 'WAYLANDDRV_PRIMARY_MONITOR', 'PROTON_WAYLAND_MONITOR',
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
  // Keep monitorsReady true if we already have cached monitor data
  if (detectedMonitors.length === 0) monitorsReady = false;
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
  // Reuse cached monitor data if available (survives page re-navigation).
  // Only re-detect on first load or after app restart.
  if (detectedMonitors.length > 0) {
    monitorsReady = true;
    maybeMigrateMonitorConfig();
  } else {
    // Detect monitors in parallel (does not block the main flow).
    invoke('detect_monitors').then(async (monitors) => {
      detectedMonitors = monitors || [];
      if (detectedMonitors.length === 0) {
        detectedMonitors = await detectMonitorsFallback();
      }
      monitorsReady = true;
      maybeMigrateMonitorConfig();
      renderPage(container);
    }).catch(async (err) => {
      console.warn('Monitor detection failed:', err);
      detectedMonitors = await detectMonitorsFallback();
      monitorsReady = true;
      maybeMigrateMonitorConfig();
      renderPage(container);
    });
  }

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
    // Re-run migration in case detect_monitors finished before launchConfig was set
    maybeMigrateMonitorConfig();
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

      // Check shader cache existence (non-blocking)
      checkShaderCacheStatus(config).then(() => renderPage(container)).catch(() => {});
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
  cleanupLaunch();
  listen('launch-exited', () => {
    launchStatus = 'ready';
    renderPage(container);
    cleanupLaunch();
  }).then(fn => { unlistenLaunchExited = fn; }).catch(() => { });

  listen('launch-log', (event) => {
    launchLog.push(event.payload);
    appendLogLine(event.payload);
  }).then(fn => { unlistenLaunchLog = fn; }).catch(() => { });
}

/**
 * Re-renders the entire launch page:
 * Compact launch bar, collapsible card grid, custom env vars, and log output.
 * Then binds all event listeners and scrolls the log to the bottom.
 */
function renderPage(container) {
  const disabled = launchStatus === 'launching' || launchStatus === 'running' || launchStatus === 'not_installed' || launchStatus === 'checking';

  container.innerHTML = `
    <div class="page-header">
      <h1>${t('launch:title')}</h1>
    </div>
    ${renderLaunchBar()}
    ${renderLaunchStatusMessages()}
    <div class="launch-card-grid">
      ${renderOptionCards(disabled)}
    </div>
    ${renderCustomEnvVarsCard(disabled)}
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

// ── Launch Bar ────────────────────────────────────

/**
 * Renders the compact launch bar with button, runner, prefix, and status.
 */
function renderLaunchBar() {
  const spinning = launchStatus === 'launching';
  const running = launchStatus === 'running';
  const disabled = launchStatus !== 'ready';

  const runner = launchConfig?.selected_runner || t('launch:label.none');
  const prefix = launchConfig?.install_path || '?';
  const showInfo = launchConfig && installStatus?.installed;

  // Button
  let buttonHtml;
  if (running) {
    buttonHtml = `
      <button class="launch-bar-btn launch-bar-btn-stop" id="btn-stop">
        <svg class="launch-bar-icon" viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>
        <span>${t('launch:button.stop')}</span>
      </button>`;
  } else {
    let label = t('launch:button.launch');
    if (spinning) label = t('launch:button.launching');
    if (launchStatus === 'checking') label = t('launch:button.checking');

    const iconSvg = spinning
      ? '<div class="launch-bar-spinner"></div>'
      : '<svg class="launch-bar-icon" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>';

    buttonHtml = `
      <button class="launch-bar-btn launch-bar-btn-play" id="btn-launch" ${disabled ? 'disabled' : ''}>
        ${iconSvg}
        <span>${label}</span>
      </button>`;
  }

  // Status label
  let statusLabel = t('launch:status.ready');
  let statusClass = 'ready';
  if (running) { statusLabel = t('launch:status.runningShort'); statusClass = 'running'; }
  else if (spinning) { statusLabel = t('launch:button.launching'); statusClass = 'launching'; }
  else if (launchStatus === 'checking') { statusLabel = t('launch:status.checking'); statusClass = 'checking'; }
  else if (launchStatus === 'not_installed') { statusLabel = t('launch:error.notInstalled'); statusClass = 'error'; }
  else if (launchStatus === 'error') { statusLabel = t('launch:error.generic'); statusClass = 'error'; }

  return `
    <div class="launch-bar">
      ${buttonHtml}
      ${showInfo ? `
        <div class="launch-bar-info">
          <div class="launch-bar-meta">
            <span class="launch-bar-label">${t('launch:label.runner')}</span>
            <span class="launch-bar-value">${escapeHtml(runner)}</span>
          </div>
          <div class="launch-bar-meta">
            <span class="launch-bar-label">${t('launch:label.prefix')}</span>
            <span class="launch-bar-value launch-bar-mono">${escapeHtml(prefix)}</span>
          </div>
        </div>
      ` : ''}
      <div class="launch-bar-status launch-bar-status-${statusClass}">${escapeHtml(statusLabel)}</div>
    </div>
  `;
}

/**
 * Renders status messages (not-installed, error) that need action buttons.
 * Displayed between launch bar and card grid.
 */
function renderLaunchStatusMessages() {
  let html = '';

  // Shader cache warning banner
  if (shaderCacheMissing && launchStatus === 'ready') {
    html += `
      <div class="launch-shader-warning">
        <span class="launch-shader-warning-icon">&#9888;</span>
        <div>
          <strong>${t('launch:shader.missingTitle', { defaultValue: 'Shader cache missing' })}</strong>
          <p>${t('launch:shader.missingMessage', { defaultValue: 'The next launch will take significantly longer (up to 10 min) while shaders are compiled. Wait 2\u20133 minutes at the login menu for optimal performance.' })}</p>
        </div>
      </div>`;
  }

  if (launchStatus === 'not_installed') {
    const msg = installStatus?.message || t('launch:error.notInstalled');
    html += `
      <div class="launch-status-message launch-status-not-installed">
        <p>${escapeHtml(msg)}</p>
        <button class="btn btn-primary btn-sm" id="btn-goto-install">${t('launch:button.gotoInstall')}</button>
      </div>
    `;
  }

  if (launchStatus === 'error') {
    const msg = installStatus?.message || t('launch:error.generic');
    html += `
      <div class="launch-status-message launch-status-error">
        <p>${escapeHtml(msg)}</p>
        <button class="btn btn-sm" id="btn-retry-check">${t('launch:button.retry')}</button>
      </div>
    `;
  }

  return html;
}

// ── Collapsible Card Grid ─────────────────────────

/**
 * Renders the 3x3 card grid. Each card is collapsible: shows badges when
 * collapsed and full options when expanded.
 * @param {boolean} disabled - Whether inputs should be disabled
 */
function renderOptionCards(disabled) {
  const cards = getCardDefinitions();
  return cards.map(card => renderCard(card, disabled)).join('');
}

/**
 * Renders a single card (collapsed or expanded).
 * @param {Object} card - Card definition
 * @param {boolean} disabled - Whether inputs should be disabled
 */
function renderCard(card, disabled) {
  const isExpanded = expandedCards.has(card.key);
  const gpuMismatch = card.gpuVendor && detectedGpuVendor !== card.gpuVendor;
  const arrow = isExpanded ? '\u25BC' : '\u25B6';

  let cardClass = 'launch-card';
  if (isExpanded) cardClass += ' expanded';
  if (gpuMismatch) cardClass += ' gpu-disabled';

  return `
    <div class="${cardClass}" data-card="${card.key}">
      <div class="launch-card-header" data-card="${card.key}">
        <span class="launch-card-arrow">${arrow}</span>
        <span class="launch-card-title">${escapeHtml(card.title)}</span>
        ${card.gpuVendor && !gpuMismatch && detectedGpuName ? `<span class="launch-card-gpu-hint">${escapeHtml(detectedGpuName)}</span>` : ''}
        ${gpuMismatch ? `<span class="launch-card-gpu-miss">${t('launch:label.noGpuDetected', { vendor: card.gpuVendor.toUpperCase() })}</span>` : ''}
      </div>
      ${isExpanded
    ? `<div class="launch-card-body">${renderCardBody(card, disabled)}</div>`
    : `<div class="launch-card-badges">${renderCardBadges(card)}</div>`
}
    </div>
  `;
}

/**
 * Generates badge HTML for a collapsed card. Shows active options or "keine aktiv".
 * @param {Object} card - Card definition
 * @returns {string} HTML string of badges
 */
function renderCardBadges(card) {
  const perf = launchConfig?.performance || {};
  const badges = [];

  if (card.source) {
    // Standard toggle group
    for (const opt of card.source.options) {
      if (perf[opt.key]) {
        badges.push(`<span class="launch-card-badge">${escapeHtml(opt.label)}</span>`);
      }
    }
  } else if (card.special === 'wayland') {
    if (perf.wayland) {
      badges.push(`<span class="launch-card-badge">${t('launch:badge.active')}</span>`);
      if (perf.primary_monitor) {
        badges.push(`<span class="launch-card-badge">${escapeHtml(perf.primary_monitor)}</span>`);
      }
    }
    if (hasFractionalScaling()) {
      badges.push(`<span class="launch-card-badge launch-card-badge-warn">${t('launch:badge.fractionalBlocked')}</span>`);
    }
  } else if (card.special === 'gamescope') {
    if (perf.gamescope?.enabled) {
      badges.push(`<span class="launch-card-badge">${t('launch:badge.active')}</span>`);
      if (perf.gamescope?.hdr) badges.push(`<span class="launch-card-badge">HDR</span>`);
      if (perf.gamescope?.width && perf.gamescope?.height) {
        badges.push(`<span class="launch-card-badge">${perf.gamescope.width}x${perf.gamescope.height}</span>`);
      }
    } else {
      badges.push(`<span class="launch-card-badge launch-card-badge-muted">${t('launch:badge.disabled')}</span>`);
    }
    if (!gamescopeInstalled) {
      badges.push(`<span class="launch-card-badge launch-card-badge-warn">${t('launch:badge.notInstalled')}</span>`);
    }
  } else if (card.special === 'gpu_cpu') {
    if (perf.gpu_device_filter) {
      badges.push(`<span class="launch-card-badge">${escapeHtml(perf.gpu_device_filter)}</span>`);
    }
    if (perf.wine_cpu_topology) {
      badges.push(`<span class="launch-card-badge">CPU: ${escapeHtml(perf.wine_cpu_topology)}</span>`);
    }
  }

  if (badges.length === 0) {
    return `<span class="launch-card-inactive">${t('launch:badge.noneActive')}</span>`;
  }
  return badges.join('');
}

/**
 * Renders the expanded body content for a card.
 * @param {Object} card - Card definition
 * @param {boolean} disabled - Whether inputs should be disabled
 * @returns {string} HTML for the card body
 */
function renderCardBody(card, disabled) {
  const perf = launchConfig?.performance || {};

  if (card.source) {
    // Standard toggle group
    const gpuMismatch = card.gpuVendor && detectedGpuVendor !== card.gpuVendor;
    return card.source.options.map(opt => {
      const isGpuDisabled = gpuMismatch;
      const isToolMissing = opt.requiresTool === 'gamemode' && !gamemodeInstalled;
      const isDisabled = disabled || isGpuDisabled || isToolMissing;
      let tooltip = opt.tooltip || '';
      if (isToolMissing) tooltip = t('launch:label.gamemodeNotInstalled');
      return `
        <label class="toggle-option${isToolMissing ? ' toggle-tool-missing' : ''}" ${tooltip ? `data-tooltip="${tooltip}"` : ''}>
          <input type="checkbox" data-key="${opt.key}"
            ${perf[opt.key] ? 'checked' : ''}
            ${isDisabled ? 'disabled' : ''} />
          <span>${opt.label}</span>
        </label>
      `;
    }).join('');
  }

  if (card.special === 'wayland') {
    return renderWaylandCardBody(disabled, perf);
  }

  if (card.special === 'gamescope') {
    return renderGamescopeCardBody(disabled, perf);
  }

  if (card.special === 'gpu_cpu') {
    return renderGpuCpuCardBody(disabled, perf);
  }

  return '';
}

/**
 * Renders the Wayland card body content.
 */
function renderWaylandCardBody(disabled, perf) {
  if (!monitorsReady) {
    return `
      <div class="dash-skeleton">
        <div class="dash-skeleton-line medium"></div>
        <div class="dash-skeleton-line short"></div>
      </div>
    `;
  }

  const fractional = hasFractionalScaling();
  const waylandTooltip = fractional
    ? t('launch:tooltip.waylandFractional')
    : t('launch:tooltip.wayland');

  return `
    <p class="launch-card-desc">${t('launch:desc.waylandWarning')}</p>
    <label class="toggle-option ${fractional ? 'toggle-blocked' : ''}" data-tooltip="${waylandTooltip}">
      <input type="checkbox" data-key="wayland"
        ${!fractional && perf.wayland ? 'checked' : ''}
        ${disabled || fractional ? 'disabled' : ''} />
      <span>${t('launch:label.enableWayland')}</span>
    </label>
    ${renderMonitorSelect(disabled, perf)}
    ${fractional ? `<div class="launch-scaling-warning">${t('launch:desc.fractionalScalingWarning')}</div>` : ''}
  `;
}

/**
 * Renders the Gamescope card body content.
 */
function renderGamescopeCardBody(disabled, perf) {
  return `
    ${gamescopeInstalled
    ? `<span class="badge-installed">${t('launch:badge.installed')}</span>`
    : `<span class="badge-not-installed">${t('launch:badge.notInstalled')}</span>`}
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
  `;
}

/**
 * Renders the GPU & CPU card body content.
 */
function renderGpuCpuCardBody(disabled, perf) {
  return `
    <div class="launch-card-field">
      <label class="launch-card-field-label">${t('launch:option.group.gpuSelection')}</label>
      <select class="input launch-gpu-filter-select" id="launch-gpu-filter" ${disabled ? 'disabled' : ''}>
        <option value="">${t('launch:label.gpuAutomatic')}</option>
        ${vulkanDevices.map(d => `<option value="${escapeHtml(d)}" ${perf.gpu_device_filter === d ? 'selected' : ''}>${escapeHtml(d)}</option>`).join('')}
      </select>
      <span class="launch-card-hint">${t('launch:label.gpuFilterHint')}</span>
    </div>
    <div class="launch-card-field">
      <label class="launch-card-field-label">${t('launch:label.cpuTopology')}</label>
      <input type="text" class="input launch-cpu-topology-input" id="launch-cpu-topology"
        value="${escapeHtml(perf.wine_cpu_topology || '')}"
        placeholder="${t('launch:label.cpuTopologyPlaceholder')}"
        ${disabled ? 'disabled' : ''} />
    </div>
  `;
}

// ── Monitor Select ────────────────────────────────

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
    // Pre-select: saved value > primary monitor > first monitor
    let preselected = perf.primary_monitor;
    if (!preselected || !detectedMonitors.some(m => m.name === preselected)) {
      const primary = detectedMonitors.find(m => m.primary);
      preselected = primary ? primary.name : detectedMonitors[0].name;
    }
    const options = detectedMonitors.map(m => {
      const label = `${m.name}${m.resolution ? ' (' + m.resolution : ''}${m.primary ? ', ' + t('launch:monitor.primary') + ')' : m.resolution ? ')' : ''}`;
      const selected = preselected === m.name ? 'selected' : '';
      return `<option value="${escapeHtml(m.name)}" ${selected}>${escapeHtml(label)}</option>`;
    }).join('');
    selectHtml = `<select class="input launch-monitor-input" id="launch-monitor-select" ${!hasMonitor || disabled ? 'disabled' : ''}>${options}</select>`;
  } else {
    // No monitors detected — disabled dropdown with explanation + fallback input
    selectHtml = `
      <select class="input launch-monitor-input" disabled>
        <option>${t('launch:label.monitorDetectionFailed')}</option>
      </select>
      <input type="text" class="input launch-monitor-input launch-monitor-fallback" id="launch-monitor-input"
        value="${escapeHtml(perf.primary_monitor || '')}"
        placeholder="${t('launch:placeholder.monitorInput')}"
        ${!hasMonitor || disabled ? 'disabled' : ''} />
    `;
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
      <button class="btn-icon btn-monitor-refresh" id="btn-monitor-refresh"
        ${disabled ? 'disabled' : ''}
        data-tooltip="${t('launch:tooltip.monitorRefresh')}" data-tooltip-pos="bottom"
        title="${t('launch:tooltip.monitorRefresh')}">&#x21bb;</button>
    </div>
  `;
}

/** Binds change events to the monitor dropdown or fallback input field.
 * Called from bindEvents() after each render. */
function bindMonitorListeners() {
  const select = document.getElementById('launch-monitor-select');
  if (select) {
    select.addEventListener('change', () => {
      if (launchConfig) {
        launchConfig.performance.primary_monitor = select.value || null;
        saveConfigNow();
      }
    });
  }
  const input = document.getElementById('launch-monitor-input');
  if (input) {
    input.addEventListener('input', () => {
      if (launchConfig) {
        launchConfig.performance.primary_monitor = input.value.trim() || null;
        debouncedSaveConfig();
      }
    });
  }
  const refreshBtn = document.getElementById('btn-monitor-refresh');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', () => refreshMonitors(refreshBtn));
  }
}

// ── Custom Env Vars Card ──────────────────────────

/**
 * Renders the custom env vars as a collapsible row below the card grid.
 * @param {boolean} disabled - Whether inputs should be disabled
 */
function renderCustomEnvVarsCard(disabled) {
  const vars = launchConfig?.performance?.custom_env_vars || [];
  const activeCount = vars.filter(v => v.enabled && v.key).length;
  const arrow = envVarsExpanded ? '\u25BC' : '\u25B6';

  let body = '';
  if (envVarsExpanded) {
    const rows = vars.map((v, i) => {
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

    body = `
      <div class="launch-envvars-body">
        <p class="custom-env-hint">${t('launch:desc.customEnvHint')}</p>
        ${rows}
        <button class="btn btn-sm btn-add-env" id="btn-add-env" ${disabled ? 'disabled' : ''}>${t('launch:button.addVariable')}</button>
      </div>
    `;
  }

  return `
    <div class="launch-envvars-card${envVarsExpanded ? ' expanded' : ''}">
      <div class="launch-envvars-header" id="envvars-header">
        <span class="launch-card-arrow">${arrow}</span>
        <span class="launch-card-title">${t('launch:section.customEnvVars')}</span>
        <span class="launch-envvars-count">${activeCount > 0 ? `${activeCount} ${t('launch:badge.activeCount')}` : ''}</span>
      </div>
      ${body}
    </div>
  `;
}

// ── Event Handlers ────────────────────────────────

/**
 * Binds all event listeners for the launch page:
 * - Launch/stop buttons
 * - "Go to installation" button when SC is missing
 * - Retry button on errors
 * - Card header clicks for expand/collapse
 * - Toggle checkboxes for launch options
 * - Monitor selection for Wayland
 * - Gamescope options
 * - GPU filter, CPU topology
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

  // Card header click → toggle expanded state
  container.querySelectorAll('.launch-card-header').forEach(header => {
    header.addEventListener('click', () => {
      const cardKey = header.dataset.card;
      const cardEl = header.closest('.launch-card');
      // Don't expand GPU-disabled cards
      if (cardEl && cardEl.classList.contains('gpu-disabled')) return;

      if (expandedCards.has(cardKey)) {
        expandedCards.delete(cardKey);
      } else {
        expandedCards.add(cardKey);
      }
      renderPage(container);
    });
  });

  // Env vars header click → toggle expanded
  const envHeader = document.getElementById('envvars-header');
  if (envHeader) {
    envHeader.addEventListener('click', () => {
      envVarsExpanded = !envVarsExpanded;
      renderPage(container);
    });
  }

  // Toggle listener: Updates the performance options in the configuration
  // (works for both card-body checkboxes and wayland checkbox)
  container.querySelectorAll('.launch-card-body input[type="checkbox"][data-key]').forEach(cb => {
    cb.addEventListener('change', () => {
      if (launchConfig) {
        launchConfig.performance[cb.dataset.key] = cb.checked;
        saveConfigNow();
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
      if (launchConfig) saveConfigNow();
    });
  }

  // Monitor dropdown / fallback input listeners
  bindMonitorListeners();

  // GPU device filter dropdown
  const gpuFilter = document.getElementById('launch-gpu-filter');
  if (gpuFilter) {
    gpuFilter.addEventListener('change', () => {
      if (launchConfig) {
        launchConfig.performance.gpu_device_filter = gpuFilter.value || null;
        saveConfigNow();
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
        saveConfigNow();
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
        saveConfigNow();
      }
    });
  }
  const gsGrabCursor = document.getElementById('gamescope-grab-cursor');
  if (gsGrabCursor) {
    gsGrabCursor.addEventListener('change', () => {
      if (launchConfig?.performance?.gamescope) {
        launchConfig.performance.gamescope.force_grab_cursor = gsGrabCursor.checked;
        saveConfigNow();
      }
    });
  }
  const gsKeyboard = document.getElementById('gamescope-keyboard');
  if (gsKeyboard) {
    gsKeyboard.addEventListener('change', () => {
      if (launchConfig?.performance?.gamescope) {
        launchConfig.performance.gamescope.keyboard_grab = gsKeyboard.checked;
        saveConfigNow();
      }
    });
  }

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
            badge.textContent = '\u26A0 ' + t('launch:badge.override');
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

// ── Launch / Stop ─────────────────────────────────

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
  cleanupLaunch();

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
      cleanupLaunch();
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
    cleanupLaunch();
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

/** Cleans up all active event listeners (prevents memory leaks on page navigation) */
export function cleanupLaunch() {
  if (unlistenLaunchLog) { unlistenLaunchLog(); unlistenLaunchLog = null; }
  if (unlistenLaunchStarted) { unlistenLaunchStarted(); unlistenLaunchStarted = null; }
  if (unlistenLaunchExited) { unlistenLaunchExited(); unlistenLaunchExited = null; }
}

// --- Monitor Refresh ---

/**
 * Re-runs monitor detection (clears cache) and re-renders the Wayland card.
 * Triggered by the refresh button next to the monitor dropdown.
 * @param {HTMLElement} btn - The refresh button element (for spinner feedback)
 */
async function refreshMonitors(btn) {
  const container = document.getElementById('content');
  btn.disabled = true;
  btn.classList.add('spinning');
  try {
    let monitors = [];
    try {
      monitors = await invoke('detect_monitors') || [];
    } catch (_) { /* ignore */ }
    if (monitors.length === 0) {
      monitors = await detectMonitorsFallback();
    }
    detectedMonitors = monitors;
    monitorsReady = true;
    if (container) renderPage(container);
  } finally {
    btn.disabled = false;
    btn.classList.remove('spinning');
  }
}

// --- Monitor Detection Fallback ---

/**
 * Fallback for the monitor selection.
 *
 * Tauri's `available_monitors()` returns the display *model* (e.g. "LG HDR 4K")
 * as the monitor name on Linux — that is NOT a valid Wayland connector and
 * therefore unusable for WAYLANDDRV_PRIMARY_MONITOR / PROTON_WAYLAND_MONITOR.
 * Returning an empty array makes `renderMonitorSelect()` show the free-text
 * input where the user can manually enter the connector name (DP-1, etc.).
 * @returns {Promise<Array>} Always empty
 */
async function detectMonitorsFallback() {
  return [];
}

/**
 * If the persisted `primary_monitor` does not match any detected connector
 * (e.g. it's a stale display model name like "LG HDR 4K" written by an older
 * version of the Tauri-based fallback), replace it with the primary connector
 * and persist the new value. Idempotent — safe to call multiple times.
 */
function maybeMigrateMonitorConfig() {
  if (!launchConfig?.performance) return;
  const saved = launchConfig.performance.primary_monitor;
  if (!saved) return;
  if (detectedMonitors.length === 0) return;
  if (detectedMonitors.some(m => m.name === saved)) return;
  const primary = detectedMonitors.find(m => m.primary) || detectedMonitors[0];
  console.warn(
    `primary_monitor "${saved}" does not match any detected connector — migrating to "${primary.name}"`
  );
  launchConfig.performance.primary_monitor = primary.name;
  saveConfigNow();
}

// --- Fractional Scaling ---

/**
 * Checks if any detected monitor uses fractional scaling (e.g., 1.25x, 1.5x).
 * Wayland mode is not compatible with fractional scaling and is automatically disabled.
 * @returns {boolean} true if at least one monitor uses fractional scaling
 */
function hasFractionalScaling() {
  return detectedMonitors.some(m => {
    if (m.scale == null || m.scale <= 0) return false;
    // Integer scales (1.0, 2.0, 3.0) are fine; only fractional values (1.25, 1.5) block Wayland
    return Math.abs(m.scale - Math.round(m.scale)) > 0.01;
  });
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

/**
 * Checks whether the shader cache exists for the primary SC version.
 * Detects installed versions and checks the first one (LIVE is sorted first).
 * Sets `shaderCacheMissing` flag for the warning banner.
 * @param {Object} config - App configuration with install_path
 */
async function checkShaderCacheStatus(config) {
  if (!config?.install_path) return;
  try {
    const versions = await invoke('detect_sc_versions', { gp: config.install_path });
    if (!versions || versions.length === 0) return;
    const primaryVersion = versions[0].version; // LIVE is sorted first
    const exists = await invoke('check_shader_cache_exists', {
      installPath: config.install_path,
      scVersion: primaryVersion,
    });
    shaderCacheMissing = !exists;
  } catch {
    shaderCacheMissing = false;
  }
}
