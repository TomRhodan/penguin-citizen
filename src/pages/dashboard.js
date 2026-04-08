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
 * Penguin Citizen - Dashboard Page
 *
 * This module renders the main overview (Command Center) with:
 * - Star Citizen installation status
 * - Wine runner status
 * - RSI news feed
 * - Server status (instances, platform)
 * - Community statistics (funding, players, vehicles)
 *
 * @module pages/dashboard
 */

import { invoke } from '@tauri-apps/api/core';
import { router } from '../router.js';
import { requestAutoLaunch } from './launch.js';
import { setRepairMode } from './installation.js';
import { escapeHtml, escapeAttr } from '../utils.js';
import { confirm } from '../utils/dialogs.js';
import { t } from '../i18n.js';

// ── Module-wide State ──────────────────────────────

/** @type {Object|null} Loaded app configuration (install path, runner, etc.) */
let dashConfig = null;
/** @type {Object|null} Installation check result: { installed, has_runner, ... } */
let dashInstallStatus = null;
/** @type {Object|null} Localization status (installed language, commit SHA, etc.) */
let dashLocStatus = null;
/** @type {Object|null} Check result whether a localization update is available */
let dashLocUpdate = null;
/** @type {string|null} Detected SC version (e.g., "LIVE", "PTU") */
let dashScVersion = null;
/** @type {Object|null} Repair backup info: { path, size_bytes, created } */
let dashRepairBackup = null;

/** @type {Array|null} Full community statistics history from backend (up to 30 days) */
let statsHistoryData = null;
/** @type {number} Currently selected time period for sparkline charts (in days) */
let statsCurrentPeriod = 7;
/** @type {Object|null} Current community statistics values for display */
let statsCurrent = null;

// ── Dashboard Cache ──────────────────────────────────
// Stale-while-revalidate: localStorage cache for sections that tolerate
// brief staleness. Server Status is intentionally excluded.
// Cache is replaced only on a successful fetch — no TTL.

const DashboardCache = {
  get(key) {
    try { return JSON.parse(localStorage.getItem(`penguin:dashboard:${key}`)); } catch { return null; }
  },
  set(key, value) {
    try { localStorage.setItem(`penguin:dashboard:${key}`, JSON.stringify(value)); } catch {}
  },
};

/**
 * Renders the entire dashboard page into the provided container.
 * Shows skeleton placeholders first, then loads all data in parallel.
 * @param {HTMLElement} container - The DOM element to render the page into
 */
export function renderDashboard(container) {
  container.innerHTML = `
    <div class="page-header">
      <h1>${t('dashboard:title')}</h1>
      <p class="page-subtitle">${t('dashboard:subtitle')}</p>
    </div>
    <div id="dash-repair-banner"></div>
    <div class="dash-status-row" id="dash-status-row">
      ${renderStatusSkeleton()}
    </div>
    <div class="dash-main">
      <div class="dash-panel" id="dash-news-panel">
        <div class="dash-panel-title"><span class="dash-panel-title-icon">&#9783;</span> ${t('dashboard:section.news')}</div>
        <div id="dash-news-content">${renderNewsSkeleton()}</div>
      </div>
      <div class="dash-right-col">
        <div class="dash-panel" id="dash-status-panel">
          <div class="dash-panel-title"><span class="dash-panel-title-icon">&#9673;</span> ${t('dashboard:section.serverStatus')}</div>
          <div id="dash-server-content">${renderServerSkeleton()}</div>
        </div>
        <div class="dash-panel" id="dash-stats-panel">
          <div class="dash-panel-title"><span class="dash-panel-title-icon">&#9734;</span> ${t('dashboard:section.community')}</div>
          <div id="dash-stats-content">${renderStatsSkeleton()}</div>
        </div>
      </div>
    </div>
  `;

  // Render cached data immediately (stale-while-revalidate).
  // Intentionally synchronous — skip requestAnimationFrame so cached content
  // replaces the skeleton in the same paint, avoiding a visible skeleton flash.
  renderFromCache();

  // Load fresh data in parallel — updates display on success
  loadAll();
}

/** Creates the skeleton placeholder for the status cards (SC, Runner, Launch) */
function renderStatusSkeleton() {
  return `
    <div class="dash-card dash-card--neutral">
      <div class="dash-card-header"><span class="dash-card-title">${t('dashboard:label.starCitizen')}</span><span class="badge badge-neutral">${t('dashboard:status.loading')}</span></div>
      <div class="dash-card-body"><div class="dash-skeleton dash-skeleton-line medium"></div><div class="dash-skeleton dash-skeleton-line short"></div></div>
    </div>
    <div class="dash-card dash-card--neutral">
      <div class="dash-card-header"><span class="dash-card-title">${t('dashboard:label.wineRunner')}</span><span class="badge badge-neutral">${t('dashboard:status.loading')}</span></div>
      <div class="dash-card-body"><div class="dash-skeleton dash-skeleton-line medium"></div></div>
    </div>
    <div class="dash-card dash-card--launch">
      <div class="dash-card-launch-inner"><span class="dash-card-launch-label">${t('dashboard:status.checking')}</span><button class="btn btn-primary btn-lg" disabled>${t('dashboard:button.launchStarCitizen')}</button></div>
    </div>
  `;
}

/** Creates the skeleton placeholder for the news list (4 entries) */
function renderNewsSkeleton() {
  let html = '<div class="dash-news-list">';
  for (let i = 0; i < 4; i++) {
    html += `
      <div style="padding: 12px;">
        <div class="dash-skeleton dash-skeleton-line" style="width:${70 + i * 5}%"></div>
        <div class="dash-skeleton dash-skeleton-line short"></div>
      </div>`;
  }
  html += '</div>';
  return html;
}

/** Creates the skeleton placeholder for the server status display */
function renderServerSkeleton() {
  let html = '<div class="dash-server-list">';
  for (let i = 0; i < 3; i++) {
    html += '<div class="dash-skeleton dash-skeleton-block"></div>';
  }
  html += '</div>';
  return html;
}

/** Creates the skeleton placeholder for the community statistics */
function renderStatsSkeleton() {
  let html = '<div class="dash-stats-grid">';
  for (let i = 0; i < 3; i++) {
    html += '<div class="dash-skeleton dash-skeleton-block"></div>';
  }
  html += '</div>';
  return html;
}

/**
 * Loads all dashboard data in parallel.
 * Uses Promise.allSettled so that an error in one source
 * does not block the others.
 */
async function loadAll() {
  const localPromise = loadLocalStatus();
  const newsPromise = loadNews();
  const serverPromise = loadServerStatus();
  const statsPromise = loadCommunityStats();

  await Promise.allSettled([localPromise, newsPromise, serverPromise, statsPromise]);
}

/**
 * Synchronously renders any sections that have data in localStorage cache.
 * Called before loadAll() so the user sees content immediately on revisit.
 * Module-level state variables are populated from cache so subsequent renders
 * (triggered by successful fetches) produce correct diffs.
 */
function renderFromCache() {
  // Local status cards
  const localCache = DashboardCache.get('local');
  if (localCache) {
    dashConfig = localCache.config;
    dashInstallStatus = localCache.installStatus;
    dashLocStatus = localCache.locStatus;
    dashLocUpdate = localCache.locUpdate;
    dashScVersion = localCache.scVersion;
    renderStatusCards();
  }

  // News
  const newsCache = DashboardCache.get('news');
  if (newsCache) {
    const el = document.getElementById('dash-news-content');
    if (el) renderNewsItems(el, newsCache.items);
  }

  // Community stats (numbers only first, then sparklines if history cached too)
  const statsCache = DashboardCache.get('stats');
  if (statsCache) {
    const el = document.getElementById('dash-stats-content');
    if (el) {
      statsCurrent = statsCache;
      const historyCache = DashboardCache.get('stats_history');
      if (historyCache && historyCache.data_points.length >= 2) {
        statsHistoryData = historyCache.data_points;
        renderStatsWithSparklines();
      } else {
        renderStats(el, statsCache);
      }
    }
  }
}

// ── Local Status Cards ──────────────────────────────

/**
 * Loads the local installation status:
 * 1. Load configuration
 * 2. Check installation status (SC + Runner present?)
 * 3. Detect SC versions and retrieve localization status
 * 4. Check whether an update for the installed translation is available
 * At the end, the status cards are re-rendered.
 */
async function loadLocalStatus() {
  try {
    dashConfig = await invoke('load_config');
  } catch {
    dashConfig = null;
  }

  if (dashConfig) {
    try {
      dashInstallStatus = await invoke('check_installation', { config: dashConfig });
    } catch {
      dashInstallStatus = null;
    }

    if (dashConfig.install_path) {
      try {
        const versions = await invoke('detect_sc_versions', { gamePath: dashConfig.install_path });
        if (versions.length > 0) {
          // Use first detected version for localization status
          dashScVersion = versions[0].version;
          dashLocStatus = await invoke('get_localization_status', {
            gamePath: dashConfig.install_path,
            version: dashScVersion,
          });
          // Only check for updates if a localization is installed
          if (dashLocStatus?.installed) {
            try {
              dashLocUpdate = await invoke('check_localization_update', {
                gamePath: dashConfig.install_path,
                version: dashScVersion,
              });
            } catch {
              dashLocUpdate = null;
            }
          }
        }
      } catch {
        dashLocStatus = null;
      }
    }
  }

  // Check for repair backups
  if (dashConfig?.install_path) {
    try {
      dashRepairBackup = await invoke('check_repair_backup', { installPath: dashConfig.install_path });
    } catch {
      dashRepairBackup = null;
    }
  }

  renderStatusCards();
  renderRepairBanner();

  // Cache local state when config loaded successfully — skip on failure
  if (dashConfig) {
    DashboardCache.set('local', {
      config: dashConfig,
      installStatus: dashInstallStatus,
      locStatus: dashLocStatus,
      locUpdate: dashLocUpdate,
      scVersion: dashScVersion,
    });
  }
}

/**
 * Renders the three status cards (SC, Runner, Launch) into the status row
 * and binds their event listeners.
 */
function renderStatusCards() {
  const grid = document.getElementById('dash-status-row');
  if (!grid) return;

  const installed = dashInstallStatus?.installed === true;
  const hasRunner = dashInstallStatus?.has_runner === true;
  const runnerName = dashConfig?.selected_runner || null;
  const installPath = dashConfig?.install_path || null;

  grid.innerHTML =
    renderScCard({ installed, installPath }) +
    renderRunnerCard({ hasRunner, runnerName }) +
    renderLaunchCard({ installed });

  bindStatusCardEvents({ installed, installPath, runnerName });
}

/**
 * Renders the repair backup banner if a backup exists.
 * Shows the backup path, size, and a delete button.
 */
function renderRepairBanner() {
  const banner = document.getElementById('dash-repair-banner');
  if (!banner) return;

  if (!dashRepairBackup) {
    banner.innerHTML = '';
    return;
  }

  const sizeGB = (dashRepairBackup.size_bytes / (1024 * 1024 * 1024)).toFixed(1);
  const msg = t('dashboard:repair.backupBanner', {
    path: dashRepairBackup.path,
    size: `${sizeGB} GB`,
  });

  banner.innerHTML = `
    <div class="dash-repair-banner">
      <span class="dash-repair-banner-icon">&#9432;</span>
      <span class="dash-repair-banner-text">${escapeHtml(msg)}</span>
      <button class="btn btn-sm btn-danger" id="dash-delete-backup">${t('dashboard:button.deleteBackup')}</button>
    </div>
  `;

  const deleteBtn = document.getElementById('dash-delete-backup');
  if (deleteBtn) {
    deleteBtn.addEventListener('click', async () => {
      const ok = await confirm(t('dashboard:repair.deleteConfirm'), {
        title: t('dashboard:button.deleteBackup'),
        kind: 'danger',
        okLabel: t('dashboard:button.deleteBackup'),
      });
      if (!ok) return;
      deleteBtn.disabled = true;
      try {
        await invoke('delete_repair_backup', {
          backupPath: dashRepairBackup.path,
          installPath: dashConfig.install_path,
        });
        dashRepairBackup = null;
        renderRepairBanner();
      } catch (e) {
        deleteBtn.disabled = false;
      }
    });
  }
}

/**
 * Renders the Star Citizen installation status card.
 * Shows install path, localization language, and optionally an update button.
 * @param {Object} data
 * @param {boolean} data.installed - Whether SC is fully installed
 * @param {string|null} data.installPath - Path to the SC installation directory
 * @returns {string} HTML string of the card
 */
function renderScCard({ installed, installPath }) {
  // Determine badge status: not configured / installed / incomplete
  let scBadge;
  if (!dashConfig) {
    scBadge = `<span class="badge badge-neutral">${t('dashboard:status.notConfigured')}</span>`;
  } else if (installed) {
    scBadge = `<span class="badge badge-ok">${t('dashboard:status.installed')}</span>`;
  } else {
    scBadge = `<span class="badge badge-warn">${t('dashboard:status.incomplete')}</span>`;
  }

  // Determine CSS class for card color
  let statusClass;
  if (!dashConfig) {
    statusClass = 'neutral';
  } else if (installed) {
    statusClass = 'ok';
  } else {
    statusClass = 'warn';
  }

  // Localization display: language name and update indicator (green/yellow)
  const locLang = dashLocStatus?.language_name || dashLocStatus?.language_code || null;
  const locDot = dashLocUpdate?.update_available
    ? '<span class="dash-card-dot dot-warn"></span>'
    : '<span class="dash-card-dot dot-ok"></span>';

  return `
    <div class="dash-card dash-card--${statusClass}">
      <div class="dash-card-header">
        <span class="dash-card-title">${t('dashboard:label.starCitizen')}</span>
        ${scBadge}
      </div>
      <div class="dash-card-body">
        <div class="dash-card-row">
          <span class="dash-card-label">${t('dashboard:label.path')}</span>
          <span class="dash-card-value mono">${escapeHtml(installPath || t('dashboard:status.notConfigured'))}</span>
        </div>
        ${dashLocStatus?.installed ? `
        <div class="dash-card-row">
          <span class="dash-card-label">${t('dashboard:label.language')}</span>
          <span class="dash-card-value">${escapeHtml(locLang)} ${locDot}</span>
        </div>` : ''}
      </div>
      <div class="dash-card-actions">
        ${installPath ? `<button class="btn btn-sm" id="dash-open-folder">${t('dashboard:button.openFolder')}</button>` : ''}
        ${dashLocUpdate?.update_available ? `<button class="btn btn-sm dash-btn-update" id="dash-loc-update">${t('dashboard:button.updateTranslation')}</button>` : ''}
        ${installed ? `<button class="btn btn-sm" id="dash-repair-install" title="${escapeHtml(t('dashboard:repair.tooltip'))}">${t('dashboard:button.repairInstallation')}</button>` : ''}
      </div>
    </div>`;
}

/**
 * Renders the Wine runner status card.
 * Shows whether a runner is configured and present.
 * @param {Object} data
 * @param {boolean} data.hasRunner - Whether the configured runner exists on disk
 * @param {string|null} data.runnerName - Name of the selected runner (e.g., "GE-Proton9-20")
 * @returns {string} HTML string of the card
 */
function renderRunnerCard({ hasRunner, runnerName }) {
  let runnerBadge;
  if (!runnerName) {
    runnerBadge = `<span class="badge badge-neutral">${t('dashboard:status.notConfigured')}</span>`;
  } else if (hasRunner) {
    runnerBadge = `<span class="badge badge-ok">${t('dashboard:status.ready')}</span>`;
  } else {
    runnerBadge = `<span class="badge badge-warn">${t('dashboard:status.missing')}</span>`;
  }

  let statusClass;
  if (!runnerName) {
    statusClass = 'neutral';
  } else if (hasRunner) {
    statusClass = 'ok';
  } else {
    statusClass = 'warn';
  }

  let displayName;
  if (!runnerName) {
    displayName = t('dashboard:status.runnerNone');
  } else if (hasRunner) {
    displayName = runnerName;
  } else {
    displayName = `${runnerName} ${t('dashboard:status.runnerNotFound')}`;
  }

  return `
    <div class="dash-card dash-card--${statusClass}">
      <div class="dash-card-header">
        <span class="dash-card-title">${t('dashboard:label.wineRunner')}</span>
        ${runnerBadge}
      </div>
      <div class="dash-card-body">
        <div class="dash-card-row">
          <span class="dash-card-label">${t('dashboard:label.runner')}</span>
          <span class="dash-card-value mono">${escapeHtml(displayName)}</span>
        </div>
      </div>
      <div class="dash-card-actions"><button class="btn btn-sm" id="dash-manage-runners">${t('dashboard:button.manageRunners')}</button></div>
    </div>`;
}

/**
 * Renders the launch card with the large start button.
 * The button is disabled when SC is not fully installed.
 * @param {Object} data
 * @param {boolean} data.installed - Whether SC is ready to launch
 * @returns {string} HTML string of the card
 */
function renderLaunchCard({ installed }) {
  const launchText = installed ? t('dashboard:status.readyToLaunch') : t('dashboard:status.completeInstallFirst');
  const launchDisabled = !installed;

  return `
    <div class="dash-card dash-card--launch">
      <div class="dash-card-launch-inner">
        <span class="dash-card-launch-label">${escapeHtml(launchText)}</span>
        <button class="btn btn-primary btn-lg" id="dash-launch-btn" ${launchDisabled ? 'disabled' : ''}>${t('dashboard:button.launchStarCitizen')}</button>
      </div>
    </div>`;
}

/**
 * Binds event listeners for all interactive elements of the status cards:
 * - Launch button: Navigates to the launch page and triggers auto-launch
 * - Open folder button: Opens the SC install path in the file manager
 * - Manage runners button: Navigates to runner management
 * - Update localization button: Updates the installed translation
 * @param {Object} data
 * @param {boolean} data.installed - Whether SC is ready to launch
 * @param {string|null} data.installPath - Path to the SC directory
 */
function bindStatusCardEvents({ installed, installPath }) {
  // Launch button: Sets the auto-launch flag and switches to the launch page
  const launchBtn = document.getElementById('dash-launch-btn');
  if (launchBtn && installed) {
    launchBtn.addEventListener('click', () => {
      requestAutoLaunch();
      router.navigate('launch');
    });
  }

  // Open folder in file manager
  const folderBtn = document.getElementById('dash-open-folder');
  if (folderBtn && installPath) {
    folderBtn.addEventListener('click', () => invoke('open_browser', { url: installPath }));
  }

  // Navigate to runner management page
  const runnersBtn = document.getElementById('dash-manage-runners');
  if (runnersBtn) {
    runnersBtn.addEventListener('click', () => router.navigate('runners'));
  }

  // Repair installation: confirm, rename prefix, then navigate to installation wizard
  const repairBtn = document.getElementById('dash-repair-install');
  if (repairBtn && installed) {
    repairBtn.addEventListener('click', async () => {
      const ok = await confirm(t('dashboard:repair.confirmMessage'), {
        title: t('dashboard:repair.confirmTitle'),
        kind: 'warning',
        okLabel: t('dashboard:repair.confirmTitle'),
      });
      if (!ok) return;

      repairBtn.disabled = true;
      try {
        const backupPath = await invoke('repair_installation');
        setRepairMode(backupPath);
        router.navigate('installation');
      } catch (e) {
        repairBtn.disabled = false;
        await confirm(String(e), { title: 'Error', kind: 'danger', okLabel: 'OK' });
      }
    });
  }

  // Perform localization update directly from the dashboard
  const updateBtn = document.getElementById('dash-loc-update');
  if (updateBtn && dashLocStatus && dashScVersion) {
    updateBtn.addEventListener('click', async () => {
      updateBtn.disabled = true;
      updateBtn.textContent = t('dashboard:status.updating');
      try {
        // Fetch available languages and find the matching source
        const languages = await invoke('get_available_languages');
        const source = languages.find(l => l.language_code === dashLocStatus.language_code);
        if (source) {
          await invoke('install_localization', {
            gamePath: dashConfig.install_path,
            version: dashScVersion,
            languageCode: source.language_code,
            sourceRepo: source.source_repo,
            languageName: source.language_name,
            sourceLabel: source.source_label,
          });
          // Reset update status and reload status cards
          dashLocUpdate = null;
          await loadLocalStatus();
        }
      } catch {
        updateBtn.textContent = t('dashboard:status.updateFailed');
        updateBtn.disabled = false;
      }
    });
  }
}

// ── RSI News ──────────────────────────────────────

/**
 * Loads the RSI news from the backend and renders them into the news panel.
 * On error, a retry button is displayed.
 */
async function loadNews() {
  const el = document.getElementById('dash-news-content');
  if (!el) return;

  try {
    const result = await invoke('fetch_rsi_news');
    if (result.error && result.items.length === 0) {
      if (!DashboardCache.get('news')) {
        el.innerHTML = renderError(t('dashboard:error.couldNotLoadNews'), () => loadNews());
      }
      return;
    }
    renderNewsItems(el, result.items);
    DashboardCache.set('news', { items: result.items });
  } catch {
    if (!DashboardCache.get('news')) {
      el.innerHTML = renderError(t('dashboard:error.couldNotLoadNews'), () => loadNews());
    }
  }
}

/**
 * Renders the news list and binds click events
 * that open the respective article in the browser.
 * @param {HTMLElement} el - Container element for the news
 * @param {Array} items - Array of news entries from the backend
 */
function renderNewsItems(el, items) {
  if (items.length === 0) {
    el.innerHTML = `<div class="dash-error"><span class="dash-error-msg">${t('dashboard:news.noNewsAvailable')}</span></div>`;
    return;
  }

  let html = '<div class="dash-news-list">';
  for (const item of items) {
    const category = item.category
      ? `<span class="dash-news-category">${escapeHtml(item.category)}</span>`
      : '';
    html += `
      <div class="dash-news-item" data-url="${escapeAttr(item.link)}">
        <div class="dash-news-header">
          <span class="dash-news-title">${escapeHtml(item.title)}</span>
          <span class="dash-news-meta">${escapeHtml(item.relative_time)}</span>
        </div>
        <div class="dash-news-summary">${category}${escapeHtml(item.summary)}</div>
      </div>`;
  }
  html += '</div>';
  el.innerHTML = html;

  el.querySelectorAll('.dash-news-item').forEach(item => {
    item.addEventListener('click', () => {
      const url = item.dataset.url;
      if (url) invoke('open_browser', { url }).catch(err => console.error(err));
    });
  });
}

// ── Server Status ──────────────────────────────────

/**
 * Loads the server status (SC instances, platform) from the backend
 * and displays the components with their respective status.
 */
async function loadServerStatus() {
  const el = document.getElementById('dash-server-content');
  if (!el) return;

  try {
    const result = await invoke('fetch_server_status');
    if (result.error && result.components.length === 0) {
      el.innerHTML = renderError(t('dashboard:error.couldNotLoadServerStatus'), () => loadServerStatus());
      return;
    }
    renderServerComponents(el, result.components);
  } catch {
    el.innerHTML = renderError(t('dashboard:error.couldNotLoadServerStatus'), () => loadServerStatus());
  }
}

/**
 * Renders the server components with colored status dots.
 * Each component shows its name and current state.
 * @param {HTMLElement} el - Container element
 * @param {Array} components - Server components from the backend
 */
function renderServerComponents(el, components) {
  if (components.length === 0) {
    el.innerHTML = `<div class="dash-error"><span class="dash-error-msg">${t('dashboard:server.noStatusData')}</span></div>`;
    return;
  }

  // Mapping of backend status keys to i18n translation keys
  const statusLabels = {
    operational: t('dashboard:server.operational'),
    degraded: t('dashboard:server.degraded'),
    major_outage: t('dashboard:server.majorOutage'),
    maintenance: t('dashboard:server.maintenance'),
    unknown: t('dashboard:server.unknown'),
  };

  const VALID_STATUSES = ['operational', 'degraded', 'major_outage', 'maintenance', 'unknown'];
  let html = '<div class="dash-server-list">';
  for (const comp of components) {
    const safeStatus = VALID_STATUSES.includes(comp.status) ? comp.status : 'unknown';
    const label = statusLabels[safeStatus] || t('dashboard:server.unknown');
    html += `
      <div class="dash-server-row">
        <span class="dash-server-name">${escapeHtml(comp.name)}</span>
        <span class="dash-server-badge">
          <span class="dash-status-dot ${safeStatus}"></span>
          <span class="${safeStatus}">${label}</span>
        </span>
      </div>`;
  }
  html += '</div>';
  el.innerHTML = html;
}

// ── Community Statistics ──────────────────────────────────

/**
 * Loads the current community statistics (funding, player count, vehicles).
 * After the initial render, statistics history is loaded asynchronously
 * to display sparkline charts with trends.
 */
async function loadCommunityStats() {
  const el = document.getElementById('dash-stats-content');
  if (!el) return;

  try {
    const result = await invoke('fetch_community_stats');
    if (result.error || !result.stats) {
      if (!DashboardCache.get('stats')) {
        el.innerHTML = renderError(t('dashboard:error.couldNotLoadCommunityStats'), () => loadCommunityStats());
      }
      return;
    }
    statsCurrent = result.stats;
    DashboardCache.set('stats', result.stats);
    // If history is already loaded (from cache or a previous fetch), render sparklines
    if (statsHistoryData) {
      renderStatsWithSparklines();
    } else {
      renderStats(el, result.stats);
    }
    // Load fresh history in background
    loadStatsHistory();
  } catch {
    if (!DashboardCache.get('stats')) {
      el.innerHTML = renderError(t('dashboard:error.couldNotLoadCommunityStats'), () => loadCommunityStats());
    }
  }
}

/**
 * Loads the historical community data (up to 30 days) for the sparkline charts.
 * Errors are silently ignored - in that case, stats are displayed without charts.
 */
async function loadStatsHistory() {
  try {
    const result = await invoke('fetch_community_stats_history', { days: 30 });
    if (!result.error && result.data_points.length >= 2) {
      statsHistoryData = result.data_points;
      DashboardCache.set('stats_history', { data_points: result.data_points });
      renderStatsWithSparklines();
    }
  } catch {
    // On failure, fall back to cached history if not already rendered
    if (!statsHistoryData) {
      const historyCache = DashboardCache.get('stats_history');
      if (historyCache && historyCache.data_points.length >= 2 && statsCurrent) {
        statsHistoryData = historyCache.data_points;
        renderStatsWithSparklines();
      }
    }
  }
}

/** Renders the community statistics without sparklines (initial simple view) */
function renderStats(el, stats) {
  el.innerHTML = `
    <div class="dash-stats-grid">
      <div class="dash-stat-item">
        <div class="dash-stat-value">${escapeHtml(stats.funds)}</div>
        <div class="dash-stat-label">${t('dashboard:label.totalFunding')}</div>
      </div>
      <div class="dash-stat-item">
        <div class="dash-stat-value">${escapeHtml(stats.fans)}</div>
        <div class="dash-stat-label">${t('dashboard:label.starCitizens')}</div>
      </div>
      <div class="dash-stat-item">
        <div class="dash-stat-value">${escapeHtml(stats.vehicles)}</div>
        <div class="dash-stat-label">${t('dashboard:label.vehiclesInGame')}</div>
      </div>
    </div>
  `;
}

/**
 * Renders the community statistics with sparkline charts and delta display.
 * Trims the history data to the selected time period and calculates
 * the percentage change for each metric.
 */
function renderStatsWithSparklines() {
  const el = document.getElementById('dash-stats-content');
  if (!el || !statsCurrent || !statsHistoryData) return;

  // Use only the data points from the selected time period
  const periodData = statsHistoryData.slice(-statsCurrentPeriod);
  if (periodData.length < 2) return;

  // Metrics for which historical data and sparklines are available
  const historyMetrics = [
    { key: 'funds', label: t('dashboard:label.totalFunding'), value: statsCurrent.funds },
    { key: 'fans', label: t('dashboard:label.starCitizens'), value: statsCurrent.fans },
  ];

  let html = renderPeriodToggle();
  html += '<div class="dash-stats-grid">';

  for (const m of historyMetrics) {
    const values = periodData.map(d => d[m.key]);
    const sparkSvg = generateSparklineSVG(values, m.key);
    // Delta calculation: difference between first and last data point
    const first = values[0];
    const last = values[values.length - 1];
    const delta = last - first;
    const pct = first !== 0 ? (delta / first) * 100 : 0;
    const deltaStr = formatDelta(delta, m.key);
    const pctStr = `(${delta >= 0 ? '+' : ''}${pct.toFixed(2)}%)`;
    // CSS class for color: positive=green, negative=red, neutral=gray
    const cls = delta > 0 ? 'positive' : delta < 0 ? 'negative' : 'neutral';

    html += `
      <div class="dash-stat-item">
        ${sparkSvg}
        <div class="dash-stat-value">${escapeHtml(m.value)}</div>
        <div class="dash-stat-label">${escapeHtml(m.label)}</div>
        <div class="dash-stat-delta ${cls}">${deltaStr} ${pctStr}</div>
      </div>`;
  }

  // Vehicles - no history available, static display
  html += `
    <div class="dash-stat-item">
      <div class="dash-stat-value">${escapeHtml(statsCurrent.vehicles)}</div>
      <div class="dash-stat-label">${t('dashboard:label.vehiclesInGame')}</div>
    </div>`;

  html += '</div>';
  el.innerHTML = html;
  bindPeriodToggle();
}

/** Renders the time period toggle buttons (7 days / 30 days) for the sparklines */
function renderPeriodToggle() {
  return `<div class="dash-stats-period">
    <button class="dash-stats-period-btn${statsCurrentPeriod === 7 ? ' active' : ''}" data-days="7">${t('dashboard:button.period7d')}</button>
    <button class="dash-stats-period-btn${statsCurrentPeriod === 30 ? ' active' : ''}" data-days="30">${t('dashboard:button.period30d')}</button>
  </div>`;
}

/** Binds click events to the time period buttons to switch between 7d and 30d */
function bindPeriodToggle() {
  document.querySelectorAll('.dash-stats-period-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      statsCurrentPeriod = parseInt(btn.dataset.days, 10);
      renderStatsWithSparklines();
    });
  });
}

/**
 * Generates an SVG sparkline chart for a series of values.
 * The chart consists of a line and a semi-transparent fill area underneath.
 * @param {number[]} values - Array of data values
 * @param {string} metricId - Unique ID for the SVG gradient (e.g., "funds")
 * @returns {string} SVG HTML string
 */
function generateSparklineSVG(values, metricId) {
  const w = 200, h = 60;
  const pad = h * 0.1; // Vertical padding top/bottom
  let min = Math.min(...values);
  let max = Math.max(...values);

  // For constant values, create artificial distance to prevent division by zero
  if (min === max) {
    min -= 1;
    max += 1;
  }

  // Distribute X coordinates evenly across width, normalize Y to value range
  const xStep = w / (values.length - 1);
  const points = values.map((v, i) => {
    const x = i * xStep;
    const y = h - pad - ((v - min) / (max - min)) * (h - 2 * pad);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });

  const gradId = `sparkGrad-${metricId}`;
  const polylineStr = points.join(' ');
  // Polygon for the fill area: line points + bottom-right corner + bottom-left corner
  const polygonStr = `${polylineStr} ${w},${h} 0,${h}`;

  return `<svg class="dash-sparkline" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
    <defs>
      <linearGradient id="${gradId}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="var(--accent)" stop-opacity="0.4"/>
        <stop offset="100%" stop-color="var(--accent)" stop-opacity="0.05"/>
      </linearGradient>
    </defs>
    <polygon points="${polygonStr}" fill="url(#${gradId})"/>
    <polyline points="${polylineStr}" fill="none" stroke="var(--accent)" stroke-width="1.5"/>
  </svg>`;
}

/**
 * Formats a delta value for display with sign and appropriate unit.
 * - Funding: short format with $, K, M (e.g., "+$1.5M")
 * - Fans/Fleet: with thousands separators (e.g., "+12,345")
 * @param {number} delta - The difference between start and end value
 * @param {string} key - Metric key ("funds", "fans", etc.)
 * @returns {string} Formatted delta string
 */
function formatDelta(delta, key) {
  const sign = delta >= 0 ? '+' : '';
  const abs = Math.abs(delta);

  if (key === 'funds') {
    if (abs >= 1_000_000) return `${sign}$${(delta / 1_000_000).toFixed(1)}M`;
    if (abs >= 1_000) return `${sign}$${(delta / 1_000).toFixed(1)}K`;
    return `${sign}$${delta.toFixed(0)}`;
  }

  // Fans/Fleet - format with thousands separators
  const formatted = Math.round(abs).toLocaleString('en-US');
  return `${sign}${delta < 0 ? '-' : ''}${formatted}`;
}

// ── Helper Functions ──────────────────────────────────────────

/**
 * Renders an error message with a retry button.
 * The retry button is bound asynchronously via setTimeout,
 * because innerHTML only creates the element after assignment.
 * @param {string} message - Error message
 * @param {Function} retryFn - Function called when retry is clicked
 * @returns {string} HTML string of the error display
 */
function renderError(message, retryFn) {
  const id = 'retry-' + Math.random().toString(36).slice(2, 8);
  setTimeout(() => {
    const btn = document.getElementById(id);
    if (btn) btn.addEventListener('click', retryFn);
  }, 0);
  return `
    <div class="dash-error">
      <span class="dash-error-msg">${escapeHtml(message)}</span>
      <button class="dash-retry-btn" id="${id}">${t('dashboard:button.retry')}</button>
    </div>`;
}

