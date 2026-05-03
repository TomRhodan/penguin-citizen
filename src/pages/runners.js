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
 * Penguin Citizen - Runner Management Page
 *
 * This module manages Wine/Proton runners:
 * - Display of installed runners with selection and deletion
 * - Fetching and installing new runners from GitHub sources
 * - Source management (import LUG sources, add custom ones)
 * - DXVK version management (detection, installation, updates)
 * - Wine prefix tools (Winecfg, Wine Shell, PowerShell installation)
 *
 * The page uses an incremental rendering pattern:
 * First a skeleton with loading indicators is rendered, then
 * individual sections (slots) are asynchronously populated with data.
 *
 * @module pages/runners
 */

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { escapeHtml } from '../utils.js';
import { t } from '../i18n.js';
import { prompt as customPrompt, showNotification } from '../utils/dialogs.js';
import { logError } from '../utils/error-handler.js';

/**
 * Sorts runner sources: LUG sources first (sorted by name length),
 * then all others alphabetically. This ensures the official LUG sources
 * always appear at the top of the tab bar.
 *
 * @param {string[]} sources - Array of source names
 * @returns {string[]} Sorted source names
 */
function sortSources(sources) {
  const lugSources = sources.filter(s => s.includes('LUG')).sort((a, b) => a.length - b.length);
  const otherSources = sources.filter(s => !s.includes('LUG')).sort();
  return [...lugSources, ...otherSources];
}

// --- State variables ---

/** @type {Object|null} Current app configuration */
let config = null;
/** @type {Array} List of locally installed runners */
let installedRunners = [];
/** @type {Array} List of online available runners */
let availableRunners = [];
/** @type {Array} Error messages from fetching the runner list */
let fetchErrors = [];
/** @type {string[]} Available sources (tabs), dynamically populated from config */
let availableSources = ['LUG'];
/** @type {string} Currently selected source tab */
let selectedSource = 'LUG';
/** @type {boolean} Locks further installations during a runner installation */
let isInstallingRunner = false;
/** @type {Function|null} Unlisten function for runner download progress events */
let unlistenRunnerProgress = null;
/** @type {boolean} Indicates whether a runner is currently being activated */
let isActivatingRunner = false;
/** @type {string} Name of the runner currently being activated */
let activatingRunnerName = '';

/** @type {Array} List of available DXVK releases from GitHub */
let dxvkReleases = [];
/** @type {Object|null} Currently installed DXVK status (version, found DLLs) */
let dxvkStatus = null;
/** @type {boolean} Locks during a DXVK installation */
let isInstallingDxvk = false;
/** @type {Function|null} Unlisten function for DXVK progress events */
let unlistenDxvkProgress = null;

/** @type {number} Current DPI setting in the Wine prefix (default: 96) */
let currentDpi = 96;
/** @type {Array} Log output for prefix tools (e.g. PowerShell installation) */
let prefixToolLog = [];
/** @type {boolean} Indicates whether a prefix tool is currently running */
let isRunningPrefixTool = false;
/** @type {Function|null} Unlisten function for prefix tool log events */
let unlistenPrefixLog = null;
/** @type {boolean} Whether PowerShell is installed in the Wine prefix */
let powershellInstalled = false;

/** @type {{installed: boolean, available: boolean, dxvk: boolean, dxvkReleases: boolean, dpi: boolean}} Tracks which sections are still loading */
let loadingFlags = { installed: true, available: true, dxvk: true, dxvkReleases: true, dpi: true };

/** @type {{runners: Array, cached_at: number}} Cached runner data (max. 1 hour) */
let runnerCache = { runners: [], cached_at: 0 };
/** @type {{releases: Array, cached_at: number}} Cached DXVK release data (max. 1 hour) */
let dxvkCache = { releases: [], cached_at: 0 };

/** @type {HTMLElement|null} Reference to the current container for incremental DOM updates */
let activeContainer = null;

// --- Main rendering ---

/**
 * Entry point: Renders the runner page.
 * Resets all state variables, immediately shows a loading state,
 * and starts asynchronous data loading in the next macrotask,
 * so the loading indicator is visible right away.
 *
 * @param {HTMLElement} container - The container element to render into
 */
/** Cleans up all active event listeners (prevents memory leaks on page navigation) */
export function cleanupRunners() {
  if (unlistenRunnerProgress) { unlistenRunnerProgress(); unlistenRunnerProgress = null; }
  if (unlistenDxvkProgress) { unlistenDxvkProgress(); unlistenDxvkProgress = null; }
  if (unlistenPrefixLog) { unlistenPrefixLog(); unlistenPrefixLog = null; }
}

export function renderRunners(container) {
  // Fully reset state on every page visit
  config = null;
  installedRunners = [];
  availableRunners = [];
  fetchErrors = [];
  dxvkReleases = [];
  dxvkStatus = null;
  currentDpi = 96;
  loadingFlags = { installed: true, available: true, dxvk: true, dxvkReleases: true, dpi: true };
  activeContainer = container;

  // Immediately render a loading skeleton so the user gets feedback
  container.innerHTML = `
    <div class="page-header">
      <h1>${t('runners:title')}</h1>
      <p class="page-subtitle">${t('runners:subtitle')}</p>
    </div>
    <div class="card">
      <div class="runners-loading-state">
        <div class="runners-loading-spinner"></div>
        <span>${t('runners:status.loadingConfig')}</span>
      </div>
    </div>
  `;

  // Start data loading in the next macrotask so the spinner is painted first
  setTimeout(() => loadData(container), 0);
}

/**
 * Loads configuration and cache data in parallel.
 * Uses cached data immediately if they are less than 1 hour old.
 * Then renders the page skeleton and starts loading fresh data.
 *
 * @param {HTMLElement} container - The container element
 */
function loadData(container) {
  // Load config and both caches in parallel
  Promise.all([
    invoke('load_config').catch(err => { logError(err, 'runners:load_config'); return null; }),
    invoke('load_runner_cache').catch(err => { logError(err, 'runners:load_runner_cache'); return { runners: [], cached_at: 0 }; }),
    invoke('load_dxvk_cache').catch(err => { logError(err, 'runners:load_dxvk_cache'); return { releases: [], cached_at: 0 }; }),
  ]).then(([cfg, runnerCacheData, dxvkCacheData]) => {
    config = cfg;
    runnerCache = runnerCacheData;
    dxvkCache = dxvkCacheData;

    // Guard against stale callbacks: Check if we're still on the same page
    if (activeContainer !== container) return;

    if (!config) {
      renderNoConfig(container);
      return;
    }

    // Use cache data if less than 1 hour (3600s) old
    // The "installed" flags will be synchronized later after scan_runners
    const cacheAge = Date.now() / 1000 - (runnerCache.cached_at || 0);
    const dxvkCacheAge = Date.now() / 1000 - (dxvkCache.cached_at || 0);

    // Populate runner sources from config or cache
    if (cfg && cfg.runner_sources && cfg.runner_sources.length > 0) {
      availableSources = sortSources(cfg.runner_sources.map(s => s.name));
      if (runnerCache.runners && runnerCache.runners.length > 0 && cacheAge < 3600) {
        availableRunners = runnerCache.runners.map(r => ({ ...r, installed: false }));
        loadingFlags.available = false;
      }
    } else if (runnerCache.runners && runnerCache.runners.length > 0 && cacheAge < 3600) {
      // Fallback: Extract sources from cached runners
      availableRunners = runnerCache.runners.map(r => ({ ...r, installed: false }));
      const sources = [...new Set(availableRunners.map(r => r.source))].sort();
      if (sources.length > 0) {
        availableSources = sortSources(sources);
      }
      loadingFlags.available = false;
    }
    // Use DXVK cache if available and not expired
    if (dxvkCache.releases && dxvkCache.releases.length > 0 && dxvkCacheAge < 3600) {
      dxvkReleases = dxvkCache.releases;
      loadingFlags.dxvkReleases = false;
    }

    // Render skeleton - give the browser a frame to paint
    renderPageSkeleton(container);

    // Double requestAnimationFrame: Only load data after the actual paint,
    // so the skeleton becomes visible before network requests start
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (activeContainer !== container) return;
        fireDataFetches(container);
      });
    });
  });
}

/**
 * Synchronizes the list of available runners with the backend.
 * Distinguishes between cache usage (if fresh enough) and re-fetching.
 * After fetching, the "installed" flags are reconciled with the locally found runners.
 *
 * @param {HTMLElement} container - The container element
 * @param {boolean} forceRefresh - Forces a re-fetch even if the cache is current
 */
function syncAvailableRunners(container, forceRefresh) {
  const cacheAge = Date.now() / 1000 - (runnerCache.cached_at || 0);

  // Only fetch from GitHub if cache is empty, expired, or refresh is forced
  if (forceRefresh || !runnerCache.runners || runnerCache.runners.length === 0 || cacheAge >= 3600) {
    invoke('fetch_available_runners', { basePath: config.install_path }).then(result => {
      if (activeContainer !== container) return;
      availableRunners = result.runners || [];
      fetchErrors = result.errors || [];

      // Update source tabs from the available runners
      const sources = [...new Set(availableRunners.map(r => r.source))].sort();
      if (sources.length > 0) {
        availableSources = sortSources(sources);
        if (!selectedSource || !availableSources.includes(selectedSource)) {
          selectedSource = availableSources[0];
        }
      }

      // Reconcile "installed" flags with locally present runners
      const installedNames = new Set(installedRunners.map(r => r.name));
      availableRunners = availableRunners.map(r => ({ ...r, installed: installedNames.has(r.name) }));
      loadingFlags.available = false;

      // Save new cache
      const nowCached = Math.floor(Date.now() / 1000);
      runnerCache = { runners: availableRunners, cached_at: nowCached };
      invoke('save_runner_cache', { runners: availableRunners }).catch(err => logError(err, 'runners:save_runner_cache'));

      // Update cache time display in the header
      const cacheTimeEl = container.querySelector('.card-header-info');
      if (cacheTimeEl) {
        cacheTimeEl.textContent = t('runners:label.cached', { time: formatCacheTime(nowCached) });
      }

      // Update download section with new data
      patchSection('download-runners-slot', renderDownloadRunnersContent());
      bindDownloadRunnerEvents(container);

      // Re-enable refresh button
      const refreshAvailableBtn = document.getElementById('btn-refresh-available');
      if (refreshAvailableBtn) {
        refreshAvailableBtn.disabled = false;
        refreshAvailableBtn.textContent = t('runners:button.refresh');
      }
    }).catch(err => {
      fetchErrors = [String(err)];
      loadingFlags.available = false;

      // Re-enable refresh button even on error
      const refreshAvailableBtn = document.getElementById('btn-refresh-available');
      if (refreshAvailableBtn) {
        refreshAvailableBtn.disabled = false;
        refreshAvailableBtn.textContent = t('runners:button.refresh');
      }

      // Fall back to cache data on error, if available
      if (runnerCache.runners && runnerCache.runners.length > 0) {
        availableRunners = runnerCache.runners;
        const installedNames = new Set(installedRunners.map(r => r.name));
        availableRunners = availableRunners.map(r => ({ ...r, installed: installedNames.has(r.name) }));
      }
      patchSection('download-runners-slot', renderDownloadRunnersContent());
    });
  } else {
    // Cache is current - use cached data directly
    if (config && config.runner_sources && config.runner_sources.length > 0) {
      availableSources = sortSources(config.runner_sources.map(s => s.name));
      availableRunners = runnerCache.runners.map(r => ({ ...r, installed: false }));
    } else {
      const sources = [...new Set(runnerCache.runners.map(r => r.source))].sort();
      if (sources.length > 0) {
        availableSources = sortSources(sources);
      }
      availableRunners = runnerCache.runners.map(r => ({ ...r, installed: false }));
    }
    if (!selectedSource || !availableSources.includes(selectedSource)) {
      selectedSource = availableSources[0] || 'LUG';
    }
    loadingFlags.available = false;

    // Synchronize "installed" flags if local runners have already been scanned
    if (installedRunners.length > 0) {
      const installedNames = new Set(installedRunners.map(r => r.name));
      availableRunners = availableRunners.map(r => ({ ...r, installed: installedNames.has(r.name) }));
    }

    patchSection('download-runners-slot', renderDownloadRunnersContent());
    bindDownloadRunnerEvents(container);
  }
}

/**
 * Starts all parallel data fetches:
 * - Scan local runners (scan_runners)
 * - Detect DXVK version (detect_dxvk_version)
 * - Fetch DXVK releases (fetch_dxvk_releases)
 * - Load DPI setting (get_dpi)
 * - Detect PowerShell status (detect_powershell)
 *
 * After each completed fetch, the corresponding section in the DOM is updated.
 *
 * @param {HTMLElement} container - The container element
 * @param {boolean} forceRefresh - Forces re-fetching of online data
 */
function fireDataFetches(container, forceRefresh = false) {
  // Scan installed runners - must complete first,
  // so the "installed" flags for online runners can be set correctly
  invoke('scan_runners', { basePath: config.install_path }).then(result => {
    if (activeContainer !== container) return;
    installedRunners = result.runners || [];
    loadingFlags.installed = false;

    // Re-enable refresh button
    const refreshInstalledBtn = document.getElementById('btn-refresh-installed');
    if (refreshInstalledBtn) {
      refreshInstalledBtn.disabled = false;
      refreshInstalledBtn.textContent = t('runners:button.refresh');
    }

    // Display installed runners
    patchSection('installed-runners-slot', renderInstalledRunnersContent());
    bindInstalledRunnerEvents(container);

    // Update "installed" flags for cached available runners
    if (availableRunners.length > 0) {
      const installedNames = new Set(installedRunners.map(r => r.name));
      availableRunners = availableRunners.map(r => ({ ...r, installed: installedNames.has(r.name) }));
      patchSection('download-runners-slot', renderDownloadRunnersContent());
      bindDownloadRunnerEvents(container);
    }

    // After the scan, synchronize available runners
    syncAvailableRunners(container, forceRefresh);
  }).catch(err => {
    logError(err, 'runners:scan_runners');
    loadingFlags.installed = false;

    const refreshInstalledBtn = document.getElementById('btn-refresh-installed');
    if (refreshInstalledBtn) {
      refreshInstalledBtn.disabled = false;
      refreshInstalledBtn.textContent = t('runners:button.refresh');
    }

    patchSection('installed-runners-slot', renderInstalledRunnersContent());
    // Try to load available runners even on scan error
    syncAvailableRunners(container, forceRefresh);
  });

  // Start DXVK detection in parallel - checks which DXVK version is installed
  invoke('detect_dxvk_version', { basePath: config.install_path }).then(result => {
    if (activeContainer !== container) return;
    dxvkStatus = result;
    loadingFlags.dxvk = false;
    patchSection('dxvk-status-slot', renderDxvkStatusContent());
    // Update release list after detection to correctly display "Current" badge
    patchSection('dxvk-releases-slot', renderDxvkReleasesContent());
    bindDxvkEvents(container);
  }).catch(err => {
    logError(err, 'runners:detect_dxvk_version');
    loadingFlags.dxvk = false;
    patchSection('dxvk-status-slot', renderDxvkStatusContent());
    patchSection('dxvk-releases-slot', renderDxvkReleasesContent());
    bindDxvkEvents(container);
  });

  // Only fetch DXVK releases if cache is empty/expired or refresh is forced
  const dxvkCacheAge = Date.now() / 1000 - (dxvkCache.cached_at || 0);
  if (forceRefresh || !dxvkReleases.length || dxvkCacheAge >= 3600) {
    invoke('fetch_dxvk_releases').then(result => {
      if (activeContainer !== container) return;
      dxvkReleases = result || [];
      loadingFlags.dxvkReleases = false;

      // Save new cache
      invoke('save_dxvk_cache', { releases: dxvkReleases }).catch(err => logError(err, 'runners:save_dxvk_cache'));

      patchSection('dxvk-releases-slot', renderDxvkReleasesContent());
      bindDxvkEvents(container);
    }).catch(err => {
      logError(err, 'runners:fetch_dxvk_releases');
      loadingFlags.dxvkReleases = false;
      // Fall back to cache data on error
      if (dxvkCache.releases && dxvkCache.releases.length > 0) {
        dxvkReleases = dxvkCache.releases;
      }
      patchSection('dxvk-releases-slot', renderDxvkReleasesContent());
    });
  } else {
    // Cache is current - display directly
    loadingFlags.dxvkReleases = false;
    patchSection('dxvk-releases-slot', renderDxvkReleasesContent());
    bindDxvkEvents(container);
  }

  // Only load DPI setting and PowerShell status if a runner is selected
  if (config.launch_working_state.runner_name) {
    invoke('get_dpi', { basePath: config.install_path, runnerName: config.launch_working_state.runner_name }).then(result => {
      if (activeContainer !== container) return;
      currentDpi = result || 96;
      loadingFlags.dpi = false;
      patchSection('prefix-tools-slot', renderPrefixToolsContent());
      bindPrefixToolEvents(container);
    }).catch(err => {
      logError(err, 'runners:get_dpi');
      loadingFlags.dpi = false;
      patchSection('prefix-tools-slot', renderPrefixToolsContent());
      bindPrefixToolEvents(container);
    });

    // PowerShell detection is optional - errors are ignored
    invoke('detect_powershell', { basePath: config.install_path }).then(result => {
      if (activeContainer !== container) return;
      powershellInstalled = result;
      patchSection('prefix-tools-slot', renderPrefixToolsContent());
      bindPrefixToolEvents(container);
    }).catch(err => logError(err, 'runners:detect_powershell'));
  } else {
    loadingFlags.dpi = false;
  }
}

// --- DOM Patching ---

/**
 * Updates the content of a slot element in the DOM.
 * Used to incrementally update individual page sections
 * without re-rendering the entire page.
 *
 * @param {string} slotId - The ID of the element to update
 * @param {string} html - The new HTML for the slot
 */
function patchSection(slotId, html) {
  const slot = document.getElementById(slotId);
  if (slot) slot.innerHTML = html;
}

// --- Page skeleton ---

/**
 * Shows a notice that the configuration is missing and the user
 * needs to run the installation wizard first.
 *
 * @param {HTMLElement} container - The container element
 */
function renderNoConfig(container) {
  container.innerHTML = `
    <div class="page-header">
      <h1>${t('runners:title')}</h1>
      <p class="page-subtitle">${t('runners:subtitle')}</p>
    </div>
    <div class="card">
      <div class="runners-guard-notice">
        <div class="runners-guard-icon">\u2699</div>
        <h3>${t('runners:notification.configRequired')}</h3>
        <p>${t('runners:notification.configRequiredDesc')}</p>
        <button class="btn btn-primary" id="btn-goto-install">${t('runners:button.goToInstallation')}</button>
      </div>
    </div>
  `;
  const gotoBtn = document.getElementById('btn-goto-install');
  if (gotoBtn) {
    gotoBtn.addEventListener('click', () => {
      const link = document.querySelector('.nav-link[data-page="installation"]');
      if (link) link.click();
    });
  }
}

/**
 * Renders the page skeleton with all sections and loading indicators.
 * The actual content is loaded asynchronously via patchSection().
 * Structure: Installed Runners | Download Runners | DXVK + Prefix Tools (Grid)
 *
 * @param {HTMLElement} container - The container element
 */
function renderPageSkeleton(container) {
  const hasRunner = !!config.launch_working_state.runner_name;
  const hasPrefix = !!config.install_path;
  const spinner = `<div class="runners-loading-state"><div class="runners-loading-spinner"></div><span>${t('runners:status.loading')}</span></div>`;

  container.innerHTML = `
    <div class="page-header">
      <h1>${t('runners:title')}</h1>
      <p class="page-subtitle">${t('runners:subtitle')}</p>
    </div>

    <!-- Section: Installed runners with selection and deletion actions -->
    <div class="card">
      <div class="card-header-row">
        <h3 data-tooltip="${t('runners:tooltip.installedRunners')}" data-tooltip-pos="right">${t('runners:section.installedRunners')}</h3>
        <div class="card-header-actions">
          <button class="btn-sm" id="btn-refresh-installed" data-tooltip="${t('runners:tooltip.refreshInstalled')}" data-tooltip-pos="left">${t('runners:button.refresh')}</button>
        </div>
      </div>
      <div id="installed-runners-slot">${spinner}</div>
    </div>

    <!-- Section: Download runners with source tabs and installation overlay -->
    <div class="card">
      <div class="card-header-row">
        <h3 data-tooltip="${t('runners:tooltip.downloadRunners')}" data-tooltip-pos="right">${t('runners:section.downloadRunners')}</h3>
        <div class="card-header-actions">
          <span class="card-header-info">${t('runners:label.cached', { time: formatCacheTime(runnerCache.cached_at) })}</span>
          <button class="btn-sm" id="btn-get-lug-sources" data-tooltip="${t('runners:tooltip.getLugSources')}" data-tooltip-pos="left">${t('runners:button.getLugSources')}</button>
          <button class="btn-sm" id="btn-refresh-available" data-tooltip="${t('runners:tooltip.refreshAvailable')}" data-tooltip-pos="left">${t('runners:button.refresh')}</button>
        </div>
      </div>
      <!-- Source tabs: Each source has its own tab -->
      <div class="runner-source-tabs-row">
        <div class="runner-source-tabs" id="source-tabs">
          ${availableSources.map(s => `
            <button class="source-tab ${selectedSource === s ? 'active' : ''}" data-source="${s}">${s}</button>
          `).join('')}
        </div>
        <button class="btn-sm" id="btn-add-source" title="${t('runners:tooltip.addSource')}">${t('runners:button.addSource')}</button>
      </div>
      <div id="download-runners-slot">${spinner}</div>
      <!-- Progress overlay: Shown during a runner installation -->
      <div class="runner-install-overlay" id="runner-install-overlay" style="display:none">
        <div class="runner-install-name" id="install-runner-name"></div>
        <div class="progress-bar-track">
          <div class="progress-bar-fill" id="install-progress-fill"></div>
        </div>
        <div class="runner-install-status" id="install-status">${t('runners:status.preparing')}</div>
        <button class="btn-sm" id="btn-cancel-runner-install">${t('runners:button.cancel')}</button>
      </div>
    </div>

    <!-- Grid: DXVK management and prefix tools side by side -->
    <div class="runners-tools-grid">
      <!-- DXVK section: Version detection and release list -->
      <div class="card">
        <div class="card-header-row">
          <h3 data-tooltip="${t('runners:tooltip.dxvk')}" data-tooltip-pos="right">${t('runners:section.dxvk')}</h3>
          <div class="card-header-actions">
            <button class="btn-sm" id="btn-refresh-dxvk" data-tooltip="${t('runners:tooltip.refreshDxvk')}" data-tooltip-pos="left">${t('runners:button.refresh')}</button>
          </div>
        </div>
        ${hasPrefix
          ? `<div id="dxvk-status-slot">${spinner}</div>
             <div id="dxvk-releases-slot">${spinner}</div>
             <div class="runner-install-overlay" id="dxvk-install-overlay" style="display:none">
               <div class="runner-install-name" id="dxvk-install-name"></div>
               <div class="progress-bar-track">
                 <div class="progress-bar-fill" id="dxvk-progress-fill"></div>
               </div>
               <div class="runner-install-status" id="dxvk-install-status">${t('runners:status.preparing')}</div>
             </div>`
          : `<div class="runners-guard-notice-inline">${t('runners:notification.runInstallationDxvk')}</div>`
        }
      </div>

      <!-- Prefix tools: Winecfg, Wine Shell, PowerShell -->
      <div class="card">
        <h3 data-tooltip="${t('runners:tooltip.prefixTools')}" data-tooltip-pos="right">${t('runners:section.prefixTools')}</h3>
        <div id="prefix-tools-slot">
          ${hasRunner && hasPrefix
            ? spinner
            : `<div class="runners-guard-notice-inline">${!hasRunner ? t('runners:notification.selectRunnerFirst') : t('runners:notification.runInstallationPrefix')}</div>`
          }
        </div>
      </div>
    </div>
  `;

  // Bind skeleton events (refresh buttons, tabs, etc.)
  bindSkeletonEvents(container);
}

// --- Section content renderers (only the inner content, not the card wrapper) ---

/**
 * Renders the content of the "Installed Runners" section.
 * Displays the active runner prominently, as well as a list of all
 * other installed runners with select and delete buttons.
 *
 * @returns {string} HTML string for the section
 */
function renderInstalledRunnersContent() {
  if (installedRunners.length === 0) {
    return `<div class="runner-empty-notice">${t('runners:notification.noRunnersInstalled')}</div>`;
  }

  // Filter out the active runner and display it separately
  const activeRunner = installedRunners.find(r => config.launch_working_state.runner_name === r.name);
  const otherRunners = installedRunners.filter(r => config.launch_working_state.runner_name !== r.name);

  // Display of the active runner (or notice that none is selected)
  let activeHtml;
  if (activeRunner) {
    activeHtml = `
      <div class="active-runner-display">
        <div class="active-runner-label">${t('runners:label.activeRunner')}</div>
        <div class="active-runner-name">
          <span class="installed-runner-indicator active"></span>
          ${escapeHtml(activeRunner.name)}
        </div>
      </div>
    `;
  } else {
    activeHtml = `
      <div class="active-runner-display empty">
        <div class="active-runner-label">${t('runners:label.activeRunner')}</div>
        <div class="active-runner-name-empty">${t('runners:label.noRunnerSelected')}</div>
      </div>
    `;
  }

  // Overlay during runner activation (shows spinner + name)
  let activatingHtml = '';
  if (isActivatingRunner) {
    activatingHtml = `
      <div class="runner-activating-overlay">
        <div class="runners-loading-spinner"></div>
        <span>${t('runners:status.activating', { name: escapeHtml(activatingRunnerName) })}</span>
      </div>
    `;
  }

  // List of other installed runners with select/delete actions
  let listHtml = '';
  if (otherRunners.length > 0) {
    listHtml = `
      <div class="installed-runners-list">
        ${otherRunners.map(r => `
          <div class="installed-runner-item">
            <div class="installed-runner-info">
              <span class="installed-runner-indicator"></span>
              <span class="installed-runner-name">${escapeHtml(r.name)}</span>
            </div>
            <div class="installed-runner-actions">
              <button class="btn-sm btn-select-runner" data-name="${escapeHtml(r.name)}" ${isActivatingRunner ? 'disabled' : ''}>${t('runners:button.select')}</button>
              <button class="btn-sm btn-danger-sm btn-delete-runner" data-name="${escapeHtml(r.name)}" ${isActivatingRunner ? 'disabled' : ''}>${t('runners:button.delete')}</button>
            </div>
          </div>
        `).join('')}
      </div>
    `;
  }

  return activeHtml + activatingHtml + listHtml;
}

/**
 * Renders the content of the "Download Runners" section.
 * Filters the available runners by the currently selected source
 * and displays them as a list with install buttons.
 *
 * @returns {string} HTML string for the section
 */
function renderDownloadRunnersContent() {
  // Only show runners from the currently selected source
  const filtered = availableRunners.filter(r => r.source === selectedSource);

  // Display error messages from the last fetch
  const errorsHtml = fetchErrors.length > 0
    ? fetchErrors.map(e => `<div class="runner-fetch-error">${escapeHtml(e)}</div>`).join('')
    : '';

  let listHtml;
  if (filtered.length === 0 && fetchErrors.length === 0) {
    listHtml = `<div class="runner-empty-notice">${t('runners:notification.noRunnersAvailable')}</div>`;
  } else if (filtered.length === 0) {
    listHtml = '';
  } else {
    listHtml = `
      <div class="runner-available-list" id="runner-available-list">
        ${filtered.map(r => `
          <div class="runner-available-item ${r.installed ? 'installed' : ''}">
            <div class="runner-item-info">
              <span class="runner-item-name" style="white-space: normal !important; word-break: break-word !important; overflow: visible !important;">${escapeHtml(r.name)}</span>
              <span class="runner-item-meta">
                <span class="runner-source-badge">${escapeHtml(r.source)}</span>
                <span class="runner-item-size">${formatSize(r.size_bytes)}</span>
              </span>
            </div>
            ${r.installed
              ? `<span class="runner-installed-badge">${t('runners:badge.installed')}</span>`
              : `<button class="btn-sm btn-install" data-url="${escapeHtml(r.download_url)}" data-file="${escapeHtml(r.file_name)}" data-name="${escapeHtml(r.name)}">${t('runners:button.install')}</button>`
            }
          </div>
        `).join('')}
      </div>
    `;
  }

  return errorsHtml + listHtml;
}

/**
 * Renders the DXVK status (currently installed version and found DLLs).
 *
 * @returns {string} HTML-String für den Status-Bereich
 */
function renderDxvkStatusContent() {
  if (dxvkStatus && dxvkStatus.installed) {
    return `
      <div class="dxvk-current">
        <span class="dxvk-current-label">${t('runners:label.dxvkCurrent')}</span>
        <span class="dxvk-current-version">${escapeHtml(dxvkStatus.version || t('runners:label.dxvkUnknownVersion'))}</span>
      </div>
      <div class="dxvk-dll-badges">
        ${dxvkStatus.dlls_found.map(dll => `<span class="dxvk-dll-badge">${escapeHtml(dll)}</span>`).join('')}
      </div>
    `;
  }
  return `<div class="dxvk-current"><span class="dxvk-current-label">${t('runners:label.dxvkNotInstalled')}</span></div>`;
}

/**
 * Renders the list of available DXVK releases.
 * The currently installed version is marked with a "Current" badge.
 *
 * @returns {string} HTML-String für die Release-Liste
 */
function renderDxvkReleasesContent() {
  if (dxvkReleases.length === 0) {
    return `<div class="runner-empty-notice">${t('runners:notification.noReleasesFound')}</div>`;
  }

  return `
    <div class="dxvk-releases-list">
      ${dxvkReleases.map(r => {
        const isCurrent = dxvkStatus && dxvkStatus.version === r.version;
        return `
          <div class="runner-available-item ${isCurrent ? 'installed' : ''}">
            <div class="runner-item-info">
              <span class="runner-item-name">${escapeHtml(r.version)}</span>
              <span class="runner-item-meta">
                <span class="runner-item-size">${formatSize(r.size_bytes)}</span>
              </span>
            </div>
            ${isCurrent
              ? `<span class="runner-installed-badge">${t('runners:badge.current')}</span>`
              : `<button class="btn-sm btn-install btn-install-dxvk" data-url="${escapeHtml(r.download_url)}" data-version="${escapeHtml(r.version)}">${t('runners:button.install')}</button>`
            }
          </div>
        `;
      }).join('')}
    </div>
  `;
}

/**
 * Renders the content of the "Prefix Tools" section.
 * Shows Winecfg launcher, Wine Shell, and PowerShell installation option.
 * If no runner is selected or no prefix exists,
 * a notice is displayed instead.
 *
 * @returns {string} HTML string for the section
 */
function renderPrefixToolsContent() {
  const hasRunner = !!config.launch_working_state.runner_name;

  // Guard clause: Tools cannot be used without a runner or prefix
  if (!config.launch_working_state.runner_name || !config.install_path) {
    const msg = !config.launch_working_state.runner_name
      ? t('runners:notification.selectRunnerFirst')
      : t('runners:notification.runInstallationPrefix');
    return `<div class="runners-guard-notice-inline">${msg}</div>`;
  }

  // Log output for running or completed prefix tool operations
  const logHtml = prefixToolLog.length > 0
    ? `<div class="prefix-tool-log" id="prefix-tool-log"><code>${escapeHtml(prefixToolLog.join('\n'))}</code></div>`
    : '';

  return `
    <!-- Winecfg: Opens the Wine configuration window -->
    <div class="prefix-tool-row">
      <div class="prefix-tool-info">
        <span class="prefix-tool-name">${t('runners:label.winecfg')}</span>
        <span class="prefix-tool-hint">${t('runners:desc.winecfg')}</span>
      </div>
      <button class="btn-sm btn-install" id="btn-winecfg">${t('runners:button.launch')}</button>
    </div>

    <div class="prefix-tool-divider"></div>

    <!-- Wine Shell: Opens a terminal with preconfigured Wine environment -->
    <div class="prefix-tool-row">
      <div class="prefix-tool-info">
        <span class="prefix-tool-name">${t('runners:label.wineShell')}</span>
        <span class="prefix-tool-hint">${t('runners:desc.wineShell')}</span>
      </div>
      <button class="btn-sm btn-install" id="btn-wine-shell" ${!hasRunner || isRunningPrefixTool ? 'disabled' : ''}>
        ${isRunningPrefixTool ? t('runners:status.starting') : t('runners:button.launch')}
      </button>
    </div>

    <div class="prefix-tool-divider"></div>

    <!-- PowerShell: Install via Winetricks (takes several minutes) -->
    <div class="prefix-tool-row">
      <div class="prefix-tool-info">
        <span class="prefix-tool-name">${t('runners:label.powershell')}</span>
        <span class="prefix-tool-hint">${powershellInstalled ? t('runners:desc.powershellInstalled') : t('runners:desc.powershellNotInstalled')}</span>
      </div>
      ${powershellInstalled
        ? `<span class="runner-installed-badge">${t('runners:badge.installed')}</span>`
        : `<button class="btn-sm btn-install" id="btn-install-powershell" ${isRunningPrefixTool ? 'disabled' : ''}>
            ${isRunningPrefixTool ? t('runners:status.installing') : t('runners:button.install')}
          </button>`
      }
    </div>

    ${logHtml}
  `;
}

// --- Event binding ---

/**
 * Binds event listeners at the skeleton level (persist across section updates):
 * - Refresh buttons for installed/available runners and DXVK
 * - Source tab switching
 * - Add new source / import LUG sources
 * - Cancel runner installation
 *
 * @param {HTMLElement} container - The container element
 */
function bindSkeletonEvents(container) {
  // Re-scan installed runners
  const refreshInstalledBtn = document.getElementById('btn-refresh-installed');
  if (refreshInstalledBtn) {
    refreshInstalledBtn.addEventListener('click', () => {
      console.log('Refresh installed clicked');
      loadingFlags.installed = true;
      const installedSlot = document.getElementById('installed-runners-slot');
      if (installedSlot) {
        installedSlot.innerHTML = `<div class="runners-loading-state"><div class="runners-loading-spinner"></div><span>${t('runners:status.scanningRunners')}</span></div>`;
      }
      refreshInstalledBtn.disabled = true;
      refreshInstalledBtn.textContent = '...';
      fireDataFetches(container, false);
    });
  }

  // Re-fetch available runners from GitHub (forces cache refresh)
  const refreshAvailableBtn = document.getElementById('btn-refresh-available');
  if (refreshAvailableBtn) {
    refreshAvailableBtn.addEventListener('click', () => {
      console.log('Refresh clicked');
      loadingFlags.available = true;
      const downloadSlot = document.getElementById('download-runners-slot');
      if (downloadSlot) {
        downloadSlot.innerHTML = `<div class="runners-loading-state"><div class="runners-loading-spinner"></div><span>${t('runners:status.refreshingRunners')}</span></div>`;
      }
      refreshAvailableBtn.disabled = true;
      refreshAvailableBtn.textContent = '...';
      fireDataFetches(container, true);
    });
  }

  // Add new runner source via dialog
  const addSourceBtn = document.getElementById('btn-add-source');
  if (addSourceBtn) {
    addSourceBtn.addEventListener('click', () => showAddSourceDialog(container));
  }

  // Import LUG Helper sources from the GitHub repository
  const getLugSourcesBtn = document.getElementById('btn-get-lug-sources');
  if (getLugSourcesBtn) {
    getLugSourcesBtn.addEventListener('click', () => importLugHelperSources(container));
  }

  // Re-fetch DXVK releases
  const refreshDxvkBtn = document.getElementById('btn-refresh-dxvk');
  if (refreshDxvkBtn) {
    refreshDxvkBtn.addEventListener('click', () => {
      loadingFlags.dxvkReleases = true;
      patchSection('dxvk-releases-slot', `<div class="runners-loading-state"><div class="runners-loading-spinner"></div><span>${t('runners:status.refreshing')}</span></div>`);
      fireDataFetches(container, true);
    });
  }

  // Tab switch: Shows runners from the selected source
  container.querySelectorAll('#source-tabs .source-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      selectedSource = tab.dataset.source;
      container.querySelectorAll('#source-tabs .source-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      patchSection('download-runners-slot', renderDownloadRunnersContent());
      bindDownloadRunnerEvents(container);
    });
  });

  // Cancel running runner installation
  const cancelBtn = document.getElementById('btn-cancel-runner-install');
  if (cancelBtn) {
    cancelBtn.addEventListener('click', async () => {
      try { await invoke('cancel_runner_install'); } catch { /* ignore */ }
    });
  }
}

/**
 * Binds event listeners for the installed runners list
 * (select and delete buttons).
 *
 * @param {HTMLElement} container - The container element
 */
function bindInstalledRunnerEvents(container) {
  const slot = document.getElementById('installed-runners-slot');
  if (!slot) return;

  slot.querySelectorAll('.btn-select-runner').forEach(btn => {
    btn.addEventListener('click', () => selectRunner(btn.dataset.name, container));
  });

  slot.querySelectorAll('.btn-delete-runner').forEach(btn => {
    btn.addEventListener('click', () => deleteRunner(btn.dataset.name, container));
  });
}

/**
 * Binds event listeners for the download runners list (install buttons).
 *
 * @param {HTMLElement} container - The container element
 */
function bindDownloadRunnerEvents(container) {
  const slot = document.getElementById('download-runners-slot');
  if (!slot) return;

  slot.querySelectorAll('.btn-install').forEach(btn => {
    btn.addEventListener('click', () => {
      installRunner(btn.dataset.url, btn.dataset.file, btn.dataset.name, container);
    });
  });
}

/**
 * Binds event listeners for the DXVK release list (install buttons).
 *
 * @param {HTMLElement} container - The container element
 */
function bindDxvkEvents(container) {
  const slot = document.getElementById('dxvk-releases-slot');
  if (!slot) return;

  slot.querySelectorAll('.btn-install-dxvk').forEach(btn => {
    btn.addEventListener('click', () => {
      installDxvk(btn.dataset.url, btn.dataset.version, container);
    });
  });
}

/**
 * Binds event listeners for prefix tools (Winecfg, Wine Shell, PowerShell).
 * Also scrolls the log window to the bottom.
 *
 * @param {HTMLElement} container - The container element
 */
function bindPrefixToolEvents(container) {
  const winecfgBtn = document.getElementById('btn-winecfg');
  if (winecfgBtn) {
    winecfgBtn.addEventListener('click', launchWinecfg);
  }

  const wineShellBtn = document.getElementById('btn-wine-shell');
  if (wineShellBtn) {
    wineShellBtn.addEventListener('click', () => launchWineShell(container));
  }

  const psBtn = document.getElementById('btn-install-powershell');
  if (psBtn) {
    psBtn.addEventListener('click', () => installPowershell(container));
  }

  // Scroll log window to the end (for running operations)
  scrollPrefixLog();
}

// --- Actions ---

/**
 * Activates a runner: Saves the selection to the configuration and
 * reads the DPI setting of the new runner. Shows an overlay with
 * spinner during activation.
 *
 * @param {string} name - Name of the runner to activate
 * @param {HTMLElement} container - The container element
 */
async function selectRunner(name, container) {
  if (isActivatingRunner) return;
  isActivatingRunner = true;
  activatingRunnerName = name;

  // Immediately show the activation state (spinner)
  patchSection('installed-runners-slot', renderInstalledRunnersContent());
  bindInstalledRunnerEvents(container);

  config.launch_working_state.runner_name = name;
  try {
    await invoke('save_config', { config });
    // Load DPI value for the new runner
    try {
      currentDpi = await invoke('get_dpi', { basePath: config.install_path, runnerName: name });
    } catch {
      currentDpi = 96;
    }
  } catch (err) {
    console.error('Failed to save config:', err);
  }

  isActivatingRunner = false;
  activatingRunnerName = '';

  // Update installed runners and prefix tools
  patchSection('installed-runners-slot', renderInstalledRunnersContent());
  bindInstalledRunnerEvents(container);
  patchSection('prefix-tools-slot', renderPrefixToolsContent());
  bindPrefixToolEvents(container);
}

/**
 * Shows a dialog for adding a new runner source.
 * The user enters a name and GitHub API URL.
 * After adding, the tabs and runner list are updated.
 *
 * @param {HTMLElement} container - The container element
 */
async function showAddSourceDialog(container) {
  const name = await customPrompt(t('runners:dialog.addSourceName'), {
    title: t('runners:dialog.addSourceTitle'),
    placeholder: t('runners:dialog.addSourceNamePlaceholder')
  });
  if (!name || !name.trim()) return;

  const apiUrl = await customPrompt(t('runners:dialog.addSourceUrl'), {
    title: t('runners:dialog.addSourceUrlTitle'),
    placeholder: t('runners:dialog.addSourceUrlPlaceholder')
  });
  if (!apiUrl || !apiUrl.trim()) return;

  try {
    const result = await invoke('add_runner_source_from_github', {
      name: name.trim(),
      apiUrl: apiUrl.trim()
    });

    if (result.success) {
      showNotification(result.message, 'success');

      // Reload config to get updated runner_sources
      const cfg = await invoke('load_config');
      if (cfg && cfg.runner_sources && cfg.runner_sources.length > 0) {
        config = cfg;
        availableSources = sortSources(cfg.runner_sources.map(s => s.name));
        if (!selectedSource || !availableSources.includes(selectedSource)) {
          selectedSource = availableSources[0] || 'LUG';
        }
        // Re-render source tabs and bind event listeners
        const tabsContainer = container.querySelector('#source-tabs');
        if (tabsContainer) {
          tabsContainer.innerHTML = availableSources.map(s => `
            <button class="source-tab ${selectedSource === s ? 'active' : ''}" data-source="${s}">${s}</button>
          `).join('');

          tabsContainer.querySelectorAll('.source-tab').forEach(tab => {
            tab.addEventListener('click', () => {
              selectedSource = tab.dataset.source;
              tabsContainer.querySelectorAll('.source-tab').forEach(t => t.classList.remove('active'));
              tab.classList.add('active');
              patchSection('download-runners-slot', renderDownloadRunnersContent());
              bindDownloadRunnerEvents(container);
            });
          });
        }
      }

      // Reload runner list with forced refresh
      loadingFlags.available = true;
      patchSection('download-runners-slot', `<div class="runners-loading-state"><div class="runners-loading-spinner"></div><span>${t('runners:status.refreshing')}</span></div>`);
      fireDataFetches(container, true);
    } else {
      showNotification(result.message, 'error');
    }
  } catch (err) {
    showNotification(t('runners:error.failedAddSource', { error: err }), 'error');
  }
}

/**
 * Imports runner sources from the LUG Helper GitHub repository.
 * Updates the source tabs and reloads the runner list.
 *
 * @param {HTMLElement} container - The container element
 */
async function importLugHelperSources(container) {
  try {
    const result = await invoke('import_lug_helper_sources');

    showNotification(result.message, 'success');

    // Reload config for updated runner_sources
    const cfg = await invoke('load_config');
    if (cfg && cfg.runner_sources && cfg.runner_sources.length > 0) {
      config = cfg;
      availableSources = sortSources(cfg.runner_sources.map(s => s.name));
      if (!selectedSource || !availableSources.includes(selectedSource)) {
        selectedSource = availableSources[0] || 'LUG';
      }
      // Update source tabs
      const tabsContainer = container.querySelector('#source-tabs');
      if (tabsContainer) {
        tabsContainer.innerHTML = availableSources.map(s => `
          <button class="source-tab ${selectedSource === s ? 'active' : ''}" data-source="${s}">${s}</button>
        `).join('');

        tabsContainer.querySelectorAll('.source-tab').forEach(tab => {
          tab.addEventListener('click', () => {
            selectedSource = tab.dataset.source;
            tabsContainer.querySelectorAll('.source-tab').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            patchSection('download-runners-slot', renderDownloadRunnersContent());
            bindDownloadRunnerEvents(container);
          });
        });
      }
    }

    // Force reload runner list
    loadingFlags.available = true;
    patchSection('download-runners-slot', `<div class="runners-loading-state"><div class="runners-loading-spinner"></div><span>${t('runners:status.refreshing')}</span></div>`);
    fireDataFetches(container, true);
  } catch (err) {
    showNotification(t('runners:error.failedImportLug', { error: err }), 'error');
  }
}

/**
 * Deletes an installed runner from the file system.
 * The currently active runner cannot be deleted.
 * After deletion, both lists (installed/available) are updated.
 *
 * @param {string} name - Name of the runner to delete
 * @param {HTMLElement} container - The container element
 */
async function deleteRunner(name, container) {
  // Cannot delete the active runner
  if (config.launch_working_state.runner_name === name) return;

  try {
    await invoke('delete_runner', { runnerName: name, basePath: config.install_path });
    // Remove from the local list
    installedRunners = installedRunners.filter(r => r.name !== name);
    // Reset "installed" flag in the available list
    availableRunners = availableRunners.map(r =>
      r.name === name ? { ...r, installed: false } : r
    );
  } catch (err) {
    console.error('Failed to delete runner:', err);
  }
  // Update both sections
  patchSection('installed-runners-slot', renderInstalledRunnersContent());
  bindInstalledRunnerEvents(container);
  patchSection('download-runners-slot', renderDownloadRunnersContent());
  bindDownloadRunnerEvents(container);
}

/**
 * Installs a runner: Downloads the archive and extracts it.
 * Shows a progress overlay with download percentage and extraction status.
 * Receives progress events via the Tauri event listener 'runner-download-progress'.
 *
 * @param {string} downloadUrl - Download URL of the runner archive
 * @param {string} fileName - File name of the archive
 * @param {string} displayName - Display name of the runner
 * @param {HTMLElement} container - The container element
 */
async function installRunner(downloadUrl, fileName, displayName, container) {
  if (isInstallingRunner) return;
  isInstallingRunner = true;

  // Show and initialize progress overlay
  const overlay = document.getElementById('runner-install-overlay');
  const nameEl = document.getElementById('install-runner-name');
  const fillEl = document.getElementById('install-progress-fill');
  const statusEl = document.getElementById('install-status');

  if (overlay) overlay.style.display = '';
  if (nameEl) nameEl.textContent = displayName;
  if (fillEl) { fillEl.style.width = '0%'; fillEl.classList.remove('extracting'); }
  if (statusEl) statusEl.textContent = t('runners:status.startingDownload');

  // Clean up previous listener
  if (unlistenRunnerProgress) { unlistenRunnerProgress(); unlistenRunnerProgress = null; }

  try {
    // Receive progress events from the Rust backend and update the UI
    unlistenRunnerProgress = await listen('runner-download-progress', (event) => {
      const p = event.payload;
      const fill = document.getElementById('install-progress-fill');
      const status = document.getElementById('install-status');
      if (!fill || !status) return;

      if (p.phase === 'downloading') {
        // Download phase: Update progress bar and size display
        fill.classList.remove('extracting');
        fill.style.width = `${p.percent.toFixed(1)}%`;
        status.textContent = t('runners:status.downloading', { downloaded: formatSize(p.bytes_downloaded), total: formatSize(p.total_bytes) });
      } else if (p.phase === 'extracting') {
        // Extraction phase: Pulsing progress bar
        fill.style.width = '100%';
        fill.classList.add('extracting');
        status.textContent = t('runners:status.extracting');
      } else if (p.phase === 'complete') {
        fill.style.width = '100%';
        fill.classList.remove('extracting');
        status.textContent = t('runners:status.installComplete');
      } else if (p.phase === 'error') {
        fill.classList.remove('extracting');
        status.textContent = p.message;
      }
    });
  } catch { /* listen failed */ }

  try {
    await invoke('install_runner', { downloadUrl, fileName, basePath: config.install_path });
  } catch (err) {
    if (statusEl) statusEl.textContent = t('runners:error.prefix', { message: err });
  }

  // Clean up: Remove listener and release installation lock
  if (unlistenRunnerProgress) { unlistenRunnerProgress(); unlistenRunnerProgress = null; }
  isInstallingRunner = false;

  // Hide overlay after a short delay (so "Complete" remains visible)
  await delay(1200);
  if (overlay) overlay.style.display = 'none';

  // Re-scan installed runners and update "installed" flags
  try {
    const scanResult = await invoke('scan_runners', { basePath: config.install_path });
    installedRunners = scanResult.runners || [];
    const installedNames = new Set(installedRunners.map(r => r.name));
    availableRunners = availableRunners.map(r => ({ ...r, installed: installedNames.has(r.name) }));
  } catch { /* ignore */ }

  // Update both lists
  patchSection('installed-runners-slot', renderInstalledRunnersContent());
  bindInstalledRunnerEvents(container);
  patchSection('download-runners-slot', renderDownloadRunnersContent());
  bindDownloadRunnerEvents(container);
}

/**
 * Installs a DXVK version: Downloads the archive, extracts it,
 * and copies the DLLs into the Wine prefix. Shows a progress overlay.
 *
 * @param {string} downloadUrl - Download URL of the DXVK archive
 * @param {string} version - Version number (e.g. "2.3")
 * @param {HTMLElement} container - The container element
 */
async function installDxvk(downloadUrl, version, container) {
  if (isInstallingDxvk) return;
  isInstallingDxvk = true;

  // Show DXVK installation overlay
  const overlay = document.getElementById('dxvk-install-overlay');
  const nameEl = document.getElementById('dxvk-install-name');
  const fillEl = document.getElementById('dxvk-progress-fill');
  const statusEl = document.getElementById('dxvk-install-status');

  if (overlay) overlay.style.display = '';
  if (nameEl) nameEl.textContent = `DXVK ${version}`;
  if (fillEl) fillEl.style.width = '0%';
  if (statusEl) statusEl.textContent = t('runners:status.startingDownload');

  if (unlistenDxvkProgress) { unlistenDxvkProgress(); unlistenDxvkProgress = null; }

  try {
    // Receive progress events for DXVK installation
    unlistenDxvkProgress = await listen('dxvk-progress', (event) => {
      const p = event.payload;
      const fill = document.getElementById('dxvk-progress-fill');
      const status = document.getElementById('dxvk-install-status');
      if (!fill || !status) return;

      fill.style.width = `${p.percent.toFixed(1)}%`;
      status.textContent = p.message;

      // Extraction phase: Pulsing bar
      if (p.phase === 'extracting') {
        fill.classList.add('extracting');
      } else {
        fill.classList.remove('extracting');
      }
    });
  } catch { /* listen failed */ }

  try {
    await invoke('install_dxvk', { downloadUrl, version, basePath: config.install_path });
  } catch (err) {
    if (statusEl) statusEl.textContent = t('runners:error.prefix', { message: err });
  }

  if (unlistenDxvkProgress) { unlistenDxvkProgress(); unlistenDxvkProgress = null; }
  isInstallingDxvk = false;

  await delay(1200);

  // Re-detect DXVK version after installation
  try {
    dxvkStatus = await invoke('detect_dxvk_version', { basePath: config.install_path });
  } catch { /* ignore */ }

  // Update status and release list
  patchSection('dxvk-status-slot', renderDxvkStatusContent());
  patchSection('dxvk-releases-slot', renderDxvkReleasesContent());
  bindDxvkEvents(container);
  if (overlay) overlay.style.display = 'none';
}

/**
 * Launches the Winecfg window for the currently selected runner.
 * Winecfg is the standard configuration tool for Wine.
 */
async function launchWinecfg() {
  if (!config || !config.launch_working_state.runner_name) return;
  try {
    await invoke('run_winecfg', {
      basePath: config.install_path,
      runnerName: config.launch_working_state.runner_name,
    });
  } catch (err) {
    console.error('Failed to launch winecfg:', err);
  }
}

/**
 * Opens a terminal with a preconfigured Wine shell.
 * The shell has all necessary environment variables (WINEPREFIX, PATH) set.
 *
 * @param {HTMLElement} container - The container element
 */
async function launchWineShell(container) {
  if (!config || !config.launch_working_state.runner_name) return;
  isRunningPrefixTool = true;
  patchSection('prefix-tools-slot', renderPrefixToolsContent());
  bindPrefixToolEvents(container);

  try {
    await invoke('launch_wine_shell', {
      basePath: config.install_path,
      runnerName: config.launch_working_state.runner_name,
    });
  } catch (err) {
    console.error('Failed to launch wine shell:', err);
    showNotification(t('runners:error.failedLaunchWineShell', { error: err }), 'error');
  } finally {
    isRunningPrefixTool = false;
    patchSection('prefix-tools-slot', renderPrefixToolsContent());
    bindPrefixToolEvents(container);
  }
}

/**
 * Sets the DPI setting in the Wine prefix (affects scaling of Wine windows).
 *
 * @param {number} dpi - The desired DPI value (e.g. 96, 120, 144)
 * @param {HTMLElement} container - The container element
 */
async function setDpi(dpi, container) {
  if (!config || !config.launch_working_state.runner_name) return;
  try {
    await invoke('set_dpi', {
      basePath: config.install_path,
      runnerName: config.launch_working_state.runner_name,
      dpi,
    });
    currentDpi = dpi;
  } catch (err) {
    console.error('Failed to set DPI:', err);
  }
  patchSection('prefix-tools-slot', renderPrefixToolsContent());
  bindPrefixToolEvents(container);
}

/**
 * Installs PowerShell via Winetricks in the Wine prefix.
 * This process takes several minutes. Progress is displayed via
 * Tauri events ('prefix-tool-log') in a log window.
 *
 * @param {HTMLElement} container - The container element
 */
async function installPowershell(container) {
  if (isRunningPrefixTool || !config || !config.launch_working_state.runner_name) return;
  isRunningPrefixTool = true;
  prefixToolLog = [];
  patchSection('prefix-tools-slot', renderPrefixToolsContent());
  bindPrefixToolEvents(container);

  if (unlistenPrefixLog) { unlistenPrefixLog(); unlistenPrefixLog = null; }

  try {
    // Receive log lines from the backend and append to the display
    unlistenPrefixLog = await listen('prefix-tool-log', (event) => {
      const line = event.payload;
      prefixToolLog.push(line);
      appendPrefixLogLine(line);
    });
  } catch { /* listen failed */ }

  try {
    await invoke('install_powershell', {
      basePath: config.install_path,
      runnerName: config.launch_working_state.runner_name,
    });
    prefixToolLog.push(t('runners:status.done'));

    // Update PowerShell status after installation
    try {
      powershellInstalled = await invoke('detect_powershell', { basePath: config.install_path });
    } catch { /* ignore */ }
  } catch (err) {
    prefixToolLog.push(t('runners:error.powershellError', { error: err }));
  }

  if (unlistenPrefixLog) { unlistenPrefixLog(); unlistenPrefixLog = null; }
  isRunningPrefixTool = false;
  patchSection('prefix-tools-slot', renderPrefixToolsContent());
  bindPrefixToolEvents(container);
}

/**
 * Appends a new log line to the prefix tool log window.
 *
 * @param {string} text - The log line to append
 */
function appendPrefixLogLine(text) {
  const logEl = document.getElementById('prefix-tool-log');
  if (!logEl) return;
  const code = logEl.querySelector('code');
  if (code) {
    code.textContent += (code.textContent ? '\n' : '') + text;
  }
  scrollPrefixLog();
}

/**
 * Scrolls the prefix tool log window to the end,
 * so the latest output is visible.
 */
function scrollPrefixLog() {
  const logEl = document.getElementById('prefix-tool-log');
  if (logEl) logEl.scrollTop = logEl.scrollHeight;
}

// --- Helper functions ---

/**
 * Formats a file size in bytes into a human-readable representation (KB, MB, GB).
 *
 * @param {number} bytes - The size in bytes
 * @returns {string} Formatted size (e.g. "42.5 MB")
 */
function formatSize(bytes) {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const val = bytes / Math.pow(1024, i);
  return `${val.toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
}

/**
 * Formats a Unix timestamp into a human-readable date/time format.
 *
 * @param {number} timestamp - Unix timestamp in seconds
 * @returns {string} Formatted date (e.g. "12.03.26, 14:30") or "Never"
 */
function formatCacheTime(timestamp) {
  if (!timestamp) return t('runners:label.cachedNever');
  const date = new Date(timestamp * 1000);
  return date.toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' });
}



/**
 * Creates a Promise that resolves after the specified time.
 * Used for short UI delays (e.g. so "Complete" remains visible).
 *
 * @param {number} ms - Delay in milliseconds
 * @returns {Promise<void>}
 */
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
