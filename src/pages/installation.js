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
 * Penguin Citizen - Installation Page
 *
 * This module implements the installation wizard with three steps:
 * - Step 1: System compatibility check (RAM, AVX, mapcount, Vulkan, etc.)
 * - Step 2: Configuration (install path, runner selection, performance options)
 * - Step 3: Actual installation (Wine prefix, DXVK, RSI Launcher)
 *
 * Progress events are received via Tauri events from the Rust backend
 * and displayed in real-time in the UI.
 *
 * @module pages/installation
 */

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { open } from '@tauri-apps/plugin-dialog';
import { confirm } from '../utils/dialogs.js';
import { router } from '../router.js';
import { escapeHtml } from '../utils.js';
import { t } from '../i18n.js';

/**
 * System check items: Each entry defines a test performed in Step 1.
 * @returns {Array<{id: string, name: string, icon: string, tooltip: string}>}
 */
function getCheckItems() {
  return [
    { id: 'memory', name: t('installation:check.memory.name'), icon: '', tooltip: t('installation:check.memory.tooltip') },
    { id: 'avx', name: t('installation:check.avx.name'), icon: '', tooltip: t('installation:check.avx.tooltip') },
    { id: 'mapcount', name: t('installation:check.mapcount.name'), icon: '', tooltip: t('installation:check.mapcount.tooltip') },
    { id: 'filelimit', name: t('installation:check.filelimit.name'), icon: '', tooltip: t('installation:check.filelimit.tooltip') },
    { id: 'vulkan', name: t('installation:check.vulkan.name'), icon: '', tooltip: t('installation:check.vulkan.tooltip') },
    { id: 'diskspace', name: t('installation:check.diskspace.name'), icon: '', tooltip: t('installation:check.diskspace.tooltip') },
  ];
}

// --- Repair mode ---

/** @type {string|null} When set, holds the backup path from repair_installation. Null = normal mode. */
let repairBackupPath = null;

/**
 * Sets repair mode. Pass the backup path to activate, or null to deactivate.
 * Called from the dashboard after repair_installation renames the prefix.
 * @param {string|null} backupPath
 */
export function setRepairMode(backupPath) {
  repairBackupPath = backupPath;
}

// --- Wizard state ---

/** @type {number} Current wizard step (1-3) */
let currentStep = 1;
/** @type {boolean} Whether the system check passed */
let systemCheckPassed = false;
/** @type {boolean} Whether the system check has run at least once */
let hasRun = false;
/** @type {Object|null} Result of the last system check (for restoration on back-navigation) */
let lastCheckResult = null;

/** Configuration state for Step 2 (path, runner, performance options) */
let configState = {
  installPath: '',
  selectedRunner: null,
  runners: [],
  performance: {
    esync: true,
    fsync: true,
    dxvk_async: true,
    mangohud: false,
    dxvk_hud: false,
    wayland: true,
    hdr: false,
    fsr: false,
    primary_monitor: null,
  },
  pathValidation: null,
  installMode: 'full',
};

/** @type {Array} List of detected monitors for Wayland monitor selection */
let detectedMonitors = [];
/** @type {boolean} Whether fractional scaling was detected (blocks Wayland option) */
let fractionalScaling = false;

// --- Runner download state ---

/** @type {Array} Runners available from GitHub */
let availableRunners = [];
/** @type {Array} Errors from fetching the runner list */
let fetchErrors = [];
/** @type {boolean} Locks during a runner installation */
let isInstallingRunner = false;
/** @type {string} Currently selected runner source */
let selectedSource = 'LUG';
/** @type {string[]} Available source tabs (populated from config) */
let availableSources = ['LUG'];
/** @type {boolean} Whether the runner list is currently loading */
let isLoadingRunners = true;
/** @type {Function|null} Unlisten function for download progress */
let unlistenProgress = null;

// Loading spinner HTML snippet
function getSpinnerHtml() {
  return `<div class="runners-loading-state"><div class="runners-loading-spinner"></div><span>${t('installation:status.loading')}</span></div>`;
}

// --- Installation state ---

/** @type {string|null} Current installation phase: null | "running" | "complete" | "error" */
let installPhase = null;
/** @type {Array} Collected log lines of the installation */
let installLog = [];
/** @type {Function|null} Unlisten function for installation progress */
let unlistenInstall = null;
/** @type {string|null} Error message on installation failure */
let installError = null;
/** @type {Array} Buffered log lines to be written to the DOM in the next frame */
let pendingLogLines = [];
/** @type {boolean} Whether a requestAnimationFrame for log output is already pending */
let logRafPending = false;

/**
 * Installation phase definitions: Each phase has an ID and a label.
 * These are displayed as a progress list in Step 3.
 * @returns {Array<{id: string, label: string}>}
 */
function getInstallPhases() {


  return [
    { id: 'prepare', label: t('installation:phase.prepare') },
    { id: 'winetricks', label: t('installation:phase.winetricks') },
    { id: 'dxvk', label: t('installation:phase.dxvk') },
    { id: 'registry', label: t('installation:phase.registry') },
    { id: 'download', label: t('installation:phase.download') },
    { id: 'install', label: t('installation:phase.install') },
    { id: 'launch', label: t('installation:phase.launch') },
  ];
}

// --- Main rendering ---

/**
 * Entry point: Renders the installation page.
 * First imports the latest LUG Helper sources, then loads the
 * saved configuration and renders the current wizard step.
 *
 * @param {HTMLElement} container - The container element to render into
 */
/** Cleans up all active event listeners (prevents memory leaks on page navigation) */
export function cleanupInstallation() {
  if (unlistenProgress) { unlistenProgress(); unlistenProgress = null; }
  if (unlistenInstall) { unlistenInstall(); unlistenInstall = null; }
}

export async function renderInstallation(container) {
  // Import LUG Helper sources (for current runner URLs)
  try {
    await invoke('import_lug_helper_sources');
  } catch (e) {
    // Ignore errors - we use cached/default sources
  }

  // Load saved configuration (must complete before rendering)
  try {
    const config = await invoke('load_config');
    if (config) {
      configState.installPath = config.install_path;
      configState.selectedRunner = config.selected_runner;
      configState.performance = config.performance;
      configState.installMode = config.install_mode || 'full';

      // Populate available sources from the configuration
      if (config.runner_sources && config.runner_sources.length > 0) {
        availableSources = config.runner_sources
          .filter(s => s.enabled)
          .map(s => s.name);
        if (!availableSources.includes(selectedSource)) {
          selectedSource = availableSources[0];
        }
      }
    }
  } catch (e) {
    // Ignore config load errors
  }

  renderCurrentStep(container);

  // If no install path is set, load the default from the backend
  if (!configState.installPath) {
    invoke('get_default_install_path').then(path => {
      configState.installPath = path;
    }).catch(e => console.error('Failed to load default install path:', e));
  }
}

/**
 * Renders the current wizard step (1, 2, or 3).
 * Creates the page layout with wizard step indicator and delegates
 * to the corresponding step render function.
 *
 * @param {HTMLElement} container - The container element
 */
function renderCurrentStep(container) {
  container.innerHTML = `
    <div class="page-header">
      <h1>${t('installation:title')}</h1>
      <p class="page-subtitle">${t('installation:subtitle')}</p>
    </div>
    <div class="wizard">
      ${renderWizardSteps()}
      <div class="wizard-content card" id="wizard-body"></div>
    </div>
  `;

  const body = document.getElementById('wizard-body');

  if (currentStep === 1) {
    renderStep1(body);
  } else if (currentStep === 2) {
    renderStep2(body);
  } else if (currentStep === 3) {
    renderStep3(body);
  }
}

/**
 * Renders the wizard step indicator (progress bar at the top).
 * Each step shows a number or a checkmark, depending on progress.
 *
 * @returns {string} HTML string of the step indicator
 */
function renderWizardSteps() {
  const steps = [
    { num: 1, label: t('installation:step.systemCheck'), tooltip: t('installation:step.systemCheckTooltip') },
    { num: 2, label: t('installation:step.configuration'), tooltip: t('installation:step.configurationTooltip') },
    { num: 3, label: t('installation:step.installation'), tooltip: t('installation:step.installationTooltip') },
  ];

  return `
    <div class="wizard-steps">
      ${steps.map((s, i) => {
        let cls = '';
        if (s.num === currentStep) cls = 'active';
        else if (s.num < currentStep || (s.num === 1 && systemCheckPassed)) cls = 'completed';

        // Completed steps show a checkmark instead of the number
        const icon = cls === 'completed'
          ? '<span class="step-number completed">\u2713</span>'
          : `<span class="step-number">${s.num}</span>`;

        return `
          <div class="wizard-step ${cls}">
            ${icon}
            <span class="step-label" ${s.tooltip ? `data-tooltip="${s.tooltip}" data-tooltip-pos="bottom"` : ''}>${s.label}</span>
          </div>
          ${i < steps.length - 1 ? '<div class="wizard-divider"></div>' : ''}
        `;
      }).join('')}
    </div>
  `;
}

// --- Step 1: System check ---

/**
 * Renders the system check page (Step 1).
 * Shows a list of all check items with pending status and buttons
 * for starting the check and proceeding.
 * On revisit, previous results are restored.
 *
 * @param {HTMLElement} body - The wizard body element
 */
function renderStep1(body) {
  body.innerHTML = `
    <h3>${t('installation:section.systemCheck')}</h3>
    <div class="check-list" id="check-list">
      ${getCheckItems().map(item => renderCheckItem(item.id, item.name, item.tooltip)).join('')}
    </div>
    <div id="summary-bar"></div>
    <div class="wizard-actions">
      <button class="btn btn-primary" id="btn-run-check">${hasRun ? t('installation:button.rerunCheck') : t('installation:button.runCheck')}</button>
      <button class="btn btn-secondary" id="btn-next-step" ${!systemCheckPassed ? 'disabled' : ''}>${t('installation:button.nextStep')}</button>
    </div>
  `;

  // Start system check
  document.getElementById('btn-run-check').addEventListener('click', () => runChecks(body));
  // Navigate to the next step (only possible when check passed)
  document.getElementById('btn-next-step').addEventListener('click', () => {
    if (systemCheckPassed) {
      currentStep = 2;
      renderCurrentStep(body.closest('#content') || body.parentElement.parentElement);
    }
  });

  // Restore previous results when the user navigates back
  if (hasRun && lastCheckResult) {
    lastCheckResult.checks.forEach(check => updateCheckItem(check));
    showSummary(lastCheckResult);
  }
}

/**
 * Renders a single check item with icon, name, and status text.
 * Restores the previous status if the check has already run.
 *
 * @param {string} id - Unique ID of the check item
 * @param {string} name - Display name of the check item
 * @param {string} tooltip - Tooltip text with explanation
 * @returns {string} HTML string of the check item
 */
function renderCheckItem(id, name, tooltip) {
  const status = hasRun && lastCheckResult
    ? lastCheckResult.checks.find(c => c.id === id)?.status || 'pending'
    : 'pending';

  return `
    <div class="check-item ${hasRun ? 'revealed' : ''}" id="check-${id}" data-status="${status}">
      <div class="check-icon-wrap">
        <span class="check-icon pending">\u25CB</span>
      </div>
      <div class="check-info">
        <span class="check-name" ${tooltip ? `data-tooltip="${tooltip}" data-tooltip-pos="right"` : ''}>${name}</span>
        <span class="check-detail">${t('installation:check.status.waiting')}</span>
      </div>
    </div>
  `;
}

/**
 * Runs all system checks via the Rust backend.
 * Results are sequentially revealed with a small delay (150ms)
 * animation, to give the user visual feedback.
 *
 * @param {HTMLElement} body - The wizard body element
 */
async function runChecks(body) {
  const btn = document.getElementById('btn-run-check');
  const nextBtn = document.getElementById('btn-next-step');
  btn.disabled = true;
  btn.textContent = t('installation:status.checking');
  nextBtn.disabled = true;

  // Reset all check items to "running"
  getCheckItems().forEach(item => {
    const el = document.getElementById(`check-${item.id}`);
    if (el) {
      el.dataset.status = 'running';
      el.classList.remove('revealed');
      const icon = el.querySelector('.check-icon');
      icon.className = 'check-icon running';
      icon.innerHTML = '';
      el.querySelector('.check-detail').textContent = t('installation:check.status.checking');
      // Remove previous fix buttons
      const existingFix = el.querySelector('.btn-fix');
      if (existingFix) existingFix.remove();
    }
  });

  // Remove previous summary
  document.getElementById('summary-bar').innerHTML = '';

  try {
    // Backend runs all checks at once and returns results
    const result = await invoke('run_system_check', { installPath: configState.installPath });

    // Reveal results sequentially with animation
    for (let i = 0; i < result.checks.length; i++) {
      await delay(150);
      updateCheckItem(result.checks[i]);
    }

    // Show summary after a short delay
    await delay(200);
    showSummary(result);
    lastCheckResult = result;

    if (result.all_passed) {
      systemCheckPassed = true;
      nextBtn.disabled = false;
    }
  } catch (err) {
    showSummary({ all_passed: false, has_warnings: false, checks: [] });
    console.error('System check failed:', err);
  }

  hasRun = true;
  btn.disabled = false;
  btn.textContent = t('installation:button.rerunCheck');
}

/**
 * Updates a single check item in the DOM with the result.
 * Sets icon (checkmark/warning/cross), status text, and adds a
 * "Fix" button for fixable failures.
 *
 * @param {Object} check - Check result with id, status, detail, and fixable fields
 */
function updateCheckItem(check) {
  const el = document.getElementById(`check-${check.id}`);
  if (!el) return;

  el.dataset.status = check.status;

  // Set icon based on status
  const icon = el.querySelector('.check-icon');
  icon.className = `check-icon ${check.status}`;

  if (check.status === 'pass') {
    icon.innerHTML = '\u2713';  // Checkmark
  } else if (check.status === 'warn') {
    icon.innerHTML = '\u26A0';  // Warning triangle
  } else {
    icon.innerHTML = '\u2717';  // Cross
  }

  el.querySelector('.check-detail').textContent = check.detail;

  // Add a fix button for fixable failures
  if (check.fixable && check.status === 'fail') {
    const existing = el.querySelector('.btn-fix');
    if (!existing) {
      const fixBtn = document.createElement('button');
      fixBtn.className = 'btn btn-fix';
      fixBtn.textContent = t('installation:button.fix');
      fixBtn.addEventListener('click', () => applyFix(check.id, fixBtn));
      el.appendChild(fixBtn);
    }
  }

  // Trigger CSS animation for reveal
  el.classList.add('revealed');
}

/**
 * Applies a system fix (e.g. vm.max_map_count or file descriptor limit).
 * Requires root privileges via pkexec. Shows a confirmation dialog
 * and automatically re-runs the checks on success.
 *
 * @param {string} checkId - ID of the check item to fix
 * @param {HTMLElement} btn - The fix button (for status updates)
 */
async function applyFix(checkId, btn) {
  // Mapping from check IDs to Rust backend commands
  const commandMap = {
    mapcount: 'fix_mapcount',
    filelimit: 'fix_filelimit',
  };

  const command = commandMap[checkId];
  if (!command) return;

  // Descriptions for the confirmation dialog
  const descriptions = {
    mapcount: t('installation:fix.mapcount.desc'),
    filelimit: t('installation:fix.filelimit.desc'),
  };

  const confirmed = await confirm(
    descriptions[checkId] || t('installation:fix.default.desc'),
    { title: t('installation:fix.confirmTitle'), kind: 'warning' }
  );
  if (!confirmed) return;

  btn.disabled = true;
  btn.textContent = t('installation:status.fixing');

  try {
    const result = await invoke(command);
    if (result.success) {
      btn.textContent = t('installation:status.fixed');
      btn.classList.add('fixed');
      // After a short delay, automatically re-run all checks
      await delay(500);
      const body = document.getElementById('wizard-body');
      if (body) runChecks(body);
    } else {
      btn.textContent = t('installation:status.failed');
      btn.title = result.message;
      const el = document.getElementById(`check-${checkId}`);
      if (el) {
        el.querySelector('.check-detail').textContent = result.message;
      }
      // Re-enable button after 2 seconds
      setTimeout(() => {
        btn.disabled = false;
        btn.textContent = t('installation:button.retryFix');
      }, 2000);
    }
  } catch (err) {
    btn.textContent = t('installation:status.error');
    btn.disabled = false;
    setTimeout(() => { btn.textContent = t('installation:button.retryFix'); }, 2000);
  }
}

/**
 * Shows the summary bar below the check results.
 * Three possible states: All passed, passed with warnings, failed.
 *
 * @param {Object} result - Overall result with all_passed, has_warnings, and checks
 */
function showSummary(result) {
  const bar = document.getElementById('summary-bar');
  if (!bar) return;

  let cls, text;
  if (result.all_passed && !result.has_warnings) {
    cls = 'summary-pass';
    text = t('installation:summary.allPassed');
  } else if (result.all_passed && result.has_warnings) {
    cls = 'summary-warn';
    text = t('installation:summary.passedWithWarnings');
  } else {
    const failCount = result.checks.filter(c => c.status === 'fail').length;
    cls = 'summary-fail';
    text = t('installation:summary.failed', { count: failCount });
  }

  bar.innerHTML = `<div class="summary-bar ${cls}">${text}</div>`;
}

// --- Step 2: Configuration ---

/**
 * Renders the configuration page (Step 2).
 * Contains three sections:
 * - Installation path with validation
 * - Runner selection (locally installed + download option)
 * - Performance options (ESync, FSync, DXVK Async, Wayland, HDR, FSR, Overlays)
 *
 * @param {HTMLElement} body - The wizard body element
 */
function renderStep2(body) {
  body.innerHTML = `
    <h3>${t('installation:section.configuration')}</h3>

    <!-- Installation path with browse dialog and validation -->
    <div class="config-section">
      <h4 class="config-section-title">${t('installation:section.installDir')}</h4>
      <div class="path-input-row">
        <input type="text" class="input" id="install-path-input"
               value="${escapeHtml(configState.installPath)}"
               placeholder="${t('installation:label.installPathPlaceholder')}"
               aria-label="${t('installation:label.installPath')}" />
        <button class="btn btn-secondary" id="btn-browse">${t('installation:button.browse')}</button>
      </div>
      <div id="path-validation" class="path-validation-msg"></div>
    </div>

    <!-- Runner selection: Dropdown for local runners + download panel -->
    <div class="config-section">
      <h4 class="config-section-title">${t('installation:section.wineRunner')}</h4>
      <div id="runner-section">
        <div class="runner-loading">${t('installation:status.scanningRunners')}</div>
      </div>
    </div>

    <!-- Performance options: Grouped into Performance, Display, and Overlays -->
    <div class="config-section config-section-last">
      <h4 class="config-section-title">${t('installation:section.perfOptions')}</h4>
      <div class="perf-options">
        ${renderPerfGroup(t('installation:perfGroup.performance'), [
          renderToggle('esync', t('installation:label.esync'), t('installation:tooltip.esync'), configState.performance.esync),
          renderToggle('fsync', t('installation:label.fsync'), t('installation:tooltip.fsync'), configState.performance.fsync),
          renderToggle('dxvk_async', t('installation:label.dxvkAsync'), t('installation:tooltip.dxvkAsync'), configState.performance.dxvk_async),
        ])}
        ${renderPerfGroup(t('installation:perfGroup.display'), [
          // Wayland is blocked when fractional scaling is detected
          fractionalScaling
            ? renderBlockedToggle('wayland', t('installation:label.wayland'), t('installation:tooltip.waylandBlocked'))
            : renderToggle('wayland', t('installation:label.wayland'), t('installation:tooltip.wayland'), configState.performance.wayland),
          renderToggle('hdr', t('installation:label.hdr'), t('installation:tooltip.hdr'), configState.performance.hdr),
          renderToggle('fsr', t('installation:label.fsr'), t('installation:tooltip.fsr'), configState.performance.fsr),
          // Only show monitor dropdown when no fractional scaling is present
          fractionalScaling ? '' : renderMonitorDropdown(),
        ])}
        ${renderPerfGroup(t('installation:perfGroup.overlays'), [
          renderToggle('mangohud', t('installation:label.mangohud'), t('installation:tooltip.mangohud'), configState.performance.mangohud),
          renderToggle('dxvk_hud', t('installation:label.dxvkHud'), t('installation:tooltip.dxvkHud'), configState.performance.dxvk_hud),
        ])}
      </div>
    </div>

    <div class="wizard-actions">
      <button class="btn btn-secondary" id="btn-back">${t('installation:button.back')}</button>
      <button class="btn btn-primary" id="btn-next-step2" disabled>${t('installation:button.nextStep')}</button>
    </div>
  `;

  // --- Event listeners for Step 2 ---

  // Path validation on blur or Enter
  const pathInput = document.getElementById('install-path-input');
  pathInput.addEventListener('blur', () => validatePath(pathInput.value));
  pathInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') validatePath(pathInput.value);
  });

  // Directory browser dialog
  document.getElementById('btn-browse').addEventListener('click', async () => {
    try {
      const selected = await open({ directory: true, title: t('installation:runner.selectDialog') });
      if (selected) {
        pathInput.value = selected;
        configState.installPath = selected;
        validatePath(selected);
      }
    } catch (err) {
      console.error('Browse dialog failed:', err);
    }
  });

  // Back to Step 1
  document.getElementById('btn-back').addEventListener('click', () => {
    currentStep = 1;
    renderCurrentStep(body.closest('#content') || body.parentElement.parentElement);
  });

  // Continue to Step 3 (config is saved beforehand)
  document.getElementById('btn-next-step2').addEventListener('click', async () => {
    await saveCurrentConfig();
    currentStep = 3;
    renderCurrentStep(body.closest('#content') || body.parentElement.parentElement);
  });

  // Performance toggle checkboxes: Update value in state
  document.querySelectorAll('.perf-toggle input[type="checkbox"]').forEach(cb => {
    if (!cb.dataset.key) return;
    cb.addEventListener('change', () => {
      configState.performance[cb.dataset.key] = cb.checked;
      // Show/hide monitor dropdown when Wayland toggle changes
      if (cb.dataset.key === 'wayland') {
        const monitorRow = document.getElementById('monitor-select-row');
        if (monitorRow) monitorRow.style.display = cb.checked ? '' : 'none';
      }
    });
  });

  // Monitor enabled checkbox: Enables/disables the monitor selection
  const monitorEnabledCb = document.getElementById('monitor-enabled');
  if (monitorEnabledCb) {
    monitorEnabledCb.addEventListener('change', () => {
      const container = document.getElementById('monitor-select-container');
      if (monitorEnabledCb.checked) {
        // Enable: Set first detected monitor as default
        const select = document.getElementById('monitor-select');
        const input = document.getElementById('monitor-input');
        if (container) container.classList.remove('disabled');
        if (select) { select.disabled = false; configState.performance.primary_monitor = select.value || (detectedMonitors[0]?.name ?? null); select.value = configState.performance.primary_monitor || ''; }
        if (input) { input.disabled = false; configState.performance.primary_monitor = input.value.trim() || null; }
      } else {
        // Disable: Reset value
        configState.performance.primary_monitor = null;
        if (container) container.classList.add('disabled');
        const select = document.getElementById('monitor-select');
        const input = document.getElementById('monitor-input');
        if (select) select.disabled = true;
        if (input) input.disabled = true;
      }
    });
  }

  // Detect monitors and check for fractional scaling
  invoke('detect_monitors').then(monitors => {
    detectedMonitors = monitors;
    const wasFractional = fractionalScaling;
    // Fractional scaling: When a monitor has scaling other than 100%
    fractionalScaling = monitors.some(m => m.scale != null && Math.abs(m.scale - 1.0) > 0.01);

    // With fractional scaling: Automatically disable Wayland (not compatible)
    if (fractionalScaling && configState.performance.wayland) {
      configState.performance.wayland = false;
    }

    if (fractionalScaling !== wasFractional) {
      // Targeted DOM update instead of full re-render to avoid destroying
      // in-flight async work (runner fetch chain, path validation)
      applyFractionalScalingBlock();
    } else {
      updateMonitorDropdown();
    }
  }).catch(e => {
    console.error('Failed to detect monitors:', e);
    detectedMonitors = [];
    updateMonitorDropdown();
  });

  // Start initial path validation and runner scan
  if (configState.installPath) {
    validatePath(configState.installPath);
  } else {
    renderRunnerSection();
  }
}

/**
 * Patches the Wayland toggle and monitor dropdown in-place when fractional
 * scaling is detected for the first time. Replaces the normal toggle with
 * the blocked variant and removes the monitor selection row.
 *
 * This avoids a full re-render of Step 2 via renderCurrentStep(), which
 * would destroy in-flight async work (runner fetch chain, path validation).
 */
function applyFractionalScalingBlock() {
  const waylandCb = document.querySelector('input[data-key="wayland"]');
  if (!waylandCb) return;
  const label = waylandCb.closest('.perf-toggle');
  if (!label) return;

  const temp = document.createElement('div');
  temp.innerHTML = renderBlockedToggle(
    'wayland',
    t('installation:label.wayland'),
    t('installation:tooltip.waylandBlocked')
  );
  label.replaceWith(temp.firstElementChild);

  const monitorRow = document.getElementById('monitor-select-row');
  if (monitorRow) monitorRow.remove();
}

/**
 * Renders a single performance toggle checkbox with label and hint text.
 *
 * @param {string} key - Key in the performance state (e.g. 'esync')
 * @param {string} label - Display name (e.g. 'ESync')
 * @param {string} hint - Explanation text
 * @param {boolean} checked - Whether the checkbox is checked
 * @returns {string} HTML string
 */
function renderToggle(key, label, hint, checked) {
  return `
    <label class="perf-toggle">
      <input type="checkbox" data-key="${key}" ${checked ? 'checked' : ''} />
      <span class="toggle-label">${label}</span>
      <span class="toggle-hint">${hint}</span>
    </label>
  `;
}

/**
 * Renders a blocked toggle checkbox (disabled, with tooltip explanation).
 * Used when an option is unavailable (e.g. Wayland with fractional scaling).
 *
 * @param {string} key - Key in the performance state
 * @param {string} label - Display name
 * @param {string} hint - Explanation of why the option is blocked
 * @returns {string} HTML string
 */
function renderBlockedToggle(key, label, hint) {
  return `
    <label class="perf-toggle toggle-blocked" data-tooltip="${hint}" data-tooltip-pos="right">
      <input type="checkbox" data-key="${key}" disabled />
      <span class="toggle-label">${label}</span>
      <span class="toggle-hint">${hint}</span>
    </label>
  `;
}

/**
 * Renders a group of performance toggles with a group title.
 *
 * @param {string} title - Title of the group (e.g. 'Performance', 'Display', 'Overlays')
 * @param {string[]} toggles - Array of toggle HTML strings
 * @returns {string} HTML string of the group
 */
function renderPerfGroup(title, toggles) {
  return `
    <div class="perf-group">
      <div class="perf-group-title">${title}</div>
      ${toggles.join('')}
    </div>
  `;
}

/**
 * Renders the Wayland monitor dropdown.
 * Only shown when Wayland is enabled.
 * Contains a checkbox to enable and a select/input for the monitor name.
 *
 * @returns {string} HTML string of the dropdown
 */
function renderMonitorDropdown() {
  const hidden = !configState.performance.wayland ? 'style="display:none"' : '';
  const enabled = !!configState.performance.primary_monitor;

  return `
    <label class="perf-toggle" id="monitor-select-row" ${hidden}>
      <input type="checkbox" id="monitor-enabled" ${enabled ? 'checked' : ''} />
      <span class="toggle-label">${t('installation:label.waylandMonitor')}</span>
      <span class="toggle-hint monitor-hint-row">
        <span class="monitor-env-name">WAYLANDDRV_PRIMARY_MONITOR</span>
        <span class="monitor-select-container ${!enabled ? 'disabled' : ''}" id="monitor-select-container">
          <select class="input monitor-select-input" id="monitor-select" ${!enabled ? 'disabled' : ''} aria-label="Wayland monitor">
            <option value="">${t('installation:label.detecting')}</option>
          </select>
        </span>
      </span>
    </label>
  `;
}

/**
 * Updates the monitor dropdown with the detected monitors.
 * If no monitors were detected, a text field is shown instead,
 * where the user can manually enter the monitor name (e.g. "DP-1").
 */
function updateMonitorDropdown() {
  const container = document.getElementById('monitor-select-container');
  if (!container) return;

  const enabled = !!configState.performance.primary_monitor;
  const currentValue = configState.performance.primary_monitor || '';

  if (detectedMonitors.length > 0) {
    // Monitors detected: Show dropdown with all monitors
    const options = detectedMonitors.map(m => {
      const label = `${m.name}${m.resolution ? ' (' + m.resolution : ''}${m.primary ? ', primary)' : m.resolution ? ')' : ''}`;
      const selected = currentValue === m.name ? 'selected' : '';
      return `<option value="${escapeHtml(m.name)}" ${selected}>${escapeHtml(label)}</option>`;
    }).join('');

    container.innerHTML = `
      <select class="input monitor-select-input" id="monitor-select" ${!enabled ? 'disabled' : ''} aria-label="Wayland monitor">
        ${options}
      </select>
    `;
  } else {
    // No monitors detected: Free-text input field as fallback
    container.innerHTML = `
      <input type="text" class="input monitor-select-input" id="monitor-input"
             value="${escapeHtml(currentValue)}"
             placeholder="${t('installation:label.monitorPlaceholder')}"
             ${!enabled ? 'disabled' : ''}
             aria-label="Wayland monitor name" />
    `;
  }

  if (!enabled) container.classList.add('disabled');
  else container.classList.remove('disabled');

  bindMonitorInputListeners();
}

/**
 * Binds event listeners for the monitor select/input element.
 * Updates the configState on changes.
 */
function bindMonitorInputListeners() {
  const select = document.getElementById('monitor-select');
  if (select) {
    select.addEventListener('change', (e) => {
      configState.performance.primary_monitor = e.target.value || null;
    });
  }
  const input = document.getElementById('monitor-input');
  if (input) {
    input.addEventListener('input', (e) => {
      configState.performance.primary_monitor = e.target.value.trim() || null;
    });
  }
}

/**
 * Updates the state of the "Next Step" button.
 * The button is only active when both the path is valid and a runner is selected.
 */
function updateNextButton() {
  const nextBtn = document.getElementById('btn-next-step2');
  if (!nextBtn) return;
  const pathValid = configState.pathValidation && configState.pathValidation.valid;
  const hasRunner = !!configState.selectedRunner;
  nextBtn.disabled = !(pathValid && hasRunner);
}

/**
 * Validates the installation path via the Rust backend.
 * Updates the validation display and the Next button.
 * On success, also triggers a runner scan and auto-save.
 *
 * @param {string} path - The path to validate
 */
async function validatePath(path) {
  configState.installPath = path;
  const msgEl = document.getElementById('path-validation');

  if (!path.trim()) {
    msgEl.className = 'path-validation-msg validation-fail';
    msgEl.textContent = t('installation:error.pleaseEnterPath');
    configState.pathValidation = null;
    updateNextButton();
    return;
  }

  msgEl.className = 'path-validation-msg';
  msgEl.textContent = t('installation:status.validating');

  try {
    const result = await invoke('validate_install_path', { path });
    configState.pathValidation = result;

    if (result.valid) {
      msgEl.className = 'path-validation-msg validation-pass';
      msgEl.textContent = result.message;
    } else {
      msgEl.className = 'path-validation-msg validation-fail';
      msgEl.textContent = result.message;
    }

    updateNextButton();

    // On path change: Re-scan runners and auto-save on valid path
    renderRunnerSection();
    if (result.valid) saveCurrentConfig();
  } catch (err) {
    msgEl.className = 'path-validation-msg validation-fail';
    msgEl.textContent = t('installation:status.validationFailed');
    configState.pathValidation = null;
    updateNextButton();
  }
}

/**
 * Renders the runner selection section in Step 2.
 * Shows a dropdown with locally installed runners and a collapsible
 * download panel for downloading new runners from GitHub sources.
 */
async function renderRunnerSection() {
  const section = document.getElementById('runner-section');
  if (!section) return;

  if (!configState.installPath.trim()) {
    section.innerHTML = `<div class="runner-empty-notice">${t('installation:runner.setPathFirst')}</div>`;
    return;
  }

  section.innerHTML = `<div class="runner-loading">${t('installation:status.scanningRunners')}</div>`;

  // Scan local runners in the installation directory
  let localRunners = [];
  try {
    const result = await invoke('scan_runners', { basePath: configState.installPath });
    configState.runners = result?.runners ?? [];
    localRunners = configState.runners;
  } catch (err) {
    // Ignore scan errors
  }

  let html = '';

  // Dropdown for local runners (only when some are available)
  if (localRunners.length > 0) {
    const options = localRunners.map(r => {
      const selected = configState.selectedRunner === r.name ? 'selected' : '';
      return `<option value="${escapeHtml(r.name)}" ${selected}>${escapeHtml(r.name)}</option>`;
    }).join('');

    html += `
      <select class="input" id="runner-select" aria-label="Wine runner">
        <option value="">${t('installation:label.selectRunner')}</option>
        ${options}
      </select>
    `;
  }

  // Download panel: Collapsed when local runners exist,
  // otherwise directly visible (so the user can download one)
  html += `
    <div class="runner-download-panel ${localRunners.length > 0 ? 'has-local' : ''}">
      ${localRunners.length > 0 ? `<div class="runner-download-toggle" id="toggle-download-panel">${t('installation:runner.downloadMore')}</div>` : ''}
      <div class="runner-download-content" id="runner-download-content" ${localRunners.length > 0 ? 'style="display:none"' : ''}>
        <div class="runner-source-tabs" id="source-tabs">
          ${availableSources.map(s => `<button class="source-tab ${selectedSource === s ? 'active' : ''}" data-source="${s}">${s}</button>`).join('')}
        </div>
        <div id="fetch-errors"></div>
        <div class="runner-available-list" id="runner-available-list">
          <div class="runner-loading">${t('installation:status.fetchingRunners')}</div>
        </div>
      </div>
    </div>

    <!-- Progress overlay for runner download/installation -->
    <div class="runner-install-overlay" id="runner-install-overlay" style="display:none">
      <div class="runner-install-name" id="install-runner-name"></div>
      <div class="progress-bar-track">
        <div class="progress-bar-fill" id="install-progress-fill"></div>
      </div>
      <div class="runner-install-status" id="install-status">${t('installation:status.preparing')}</div>
      <button class="btn btn-sm btn-secondary" id="btn-cancel-install">${t('installation:button.cancel')}</button>
    </div>
  `;

  section.innerHTML = html;

  // Event: Local runner selected from dropdown
  const selectEl = document.getElementById('runner-select');
  if (selectEl) {
    selectEl.addEventListener('change', (e) => {
      configState.selectedRunner = e.target.value || null;
      updateNextButton();
    });
  }

  // Event: Toggle download panel
  const toggleEl = document.getElementById('toggle-download-panel');
  if (toggleEl) {
    toggleEl.addEventListener('click', () => {
      const content = document.getElementById('runner-download-content');
      if (content) {
        const visible = content.style.display !== 'none';
        content.style.display = visible ? 'none' : '';
        toggleEl.textContent = visible ? t('installation:runner.downloadMore') : t('installation:runner.hideDownload');
      }
    });
  }

  // Event: Source tab switch
  document.querySelectorAll('#source-tabs .source-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      selectedSource = tab.dataset.source;
      document.querySelectorAll('#source-tabs .source-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      renderAvailableRunnersList();
    });
  });

  // Event: Cancel running installation
  const cancelBtn = document.getElementById('btn-cancel-install');
  if (cancelBtn) {
    cancelBtn.addEventListener('click', async () => {
      try { await invoke('cancel_runner_install'); } catch (e) { /* ignore */ }
    });
  }

  // Fetch online runner list
  fetchAvailableRunners();
}

/**
 * Fetches the list of available runners from GitHub.
 * Shows a spinner during loading and then updates the list.
 */
async function fetchAvailableRunners() {
  isLoadingRunners = true;

  const list = document.getElementById('runner-available-list');
  if (list) list.innerHTML = getSpinnerHtml();

  try {
    const result = await invoke('fetch_available_runners', { basePath: configState.installPath });
    availableRunners = result?.runners ?? [];
    fetchErrors = result?.errors ?? [];
  } catch (err) {
    availableRunners = [];
    fetchErrors = [String(err)];
  }

  isLoadingRunners = false;
  renderAvailableRunnersList();
  renderFetchErrors();
}

/**
 * Renders error messages from the runner fetch.
 */
function renderFetchErrors() {
  const el = document.getElementById('fetch-errors');
  if (!el || fetchErrors.length === 0) return;
  el.innerHTML = fetchErrors.map(e =>
    `<div class="runner-fetch-error">${escapeHtml(e)}</div>`
  ).join('');
}

/**
 * Renders the list of runners available for download.
 * Filters by the currently selected source and shows install buttons
 * for non-installed runners.
 */
function renderAvailableRunnersList() {
  const list = document.getElementById('runner-available-list');
  if (!list) return;

  const filtered = availableRunners.filter(r => r.source === selectedSource);

  if (filtered.length === 0) {
    list.innerHTML = `<div class="runner-empty-notice">${t('installation:runner.noRunnersAvailable')}</div>`;
    return;
  }

  list.innerHTML = filtered.map(r => `
    <div class="runner-available-item ${r.installed ? 'installed' : ''}">
      <div class="runner-item-info">
        <span class="runner-item-name">${escapeHtml(r.name)}</span>
        <span class="runner-item-meta">
          <span class="runner-source-badge">${escapeHtml(r.source)}</span>
          <span class="runner-item-size">${formatSize(r.size_bytes)}</span>
        </span>
      </div>
      ${r.installed
        ? `<span class="runner-installed-badge">${t('installation:runner.installedBadge')}</span>`
        : `<button class="btn btn-sm btn-install" data-url="${escapeHtml(r.download_url)}" data-file="${escapeHtml(r.file_name)}" data-name="${escapeHtml(r.name)}">${t('installation:button.install')}</button>`
      }
    </div>
  `).join('');

  // Bind install button listeners for each runner
  list.querySelectorAll('.btn-install').forEach(btn => {
    btn.addEventListener('click', () => {
      installRunner(btn.dataset.url, btn.dataset.file, btn.dataset.name);
    });
  });
}

/**
 * Installs a runner in the installation page context (Step 2).
 * Similar to runners.js, but with automatic selection of the
 * newly installed runner if none is selected yet.
 *
 * @param {string} downloadUrl - Download URL of the runner archive
 * @param {string} fileName - File name of the archive
 * @param {string} displayName - Display name of the runner
 */
async function installRunner(downloadUrl, fileName, displayName) {
  if (isInstallingRunner) return;
  isInstallingRunner = true;

  // Show progress overlay
  const overlay = document.getElementById('runner-install-overlay');
  const nameEl = document.getElementById('install-runner-name');
  const fillEl = document.getElementById('install-progress-fill');
  const statusEl = document.getElementById('install-status');

  if (overlay) overlay.style.display = '';
  if (nameEl) nameEl.textContent = displayName;
  if (fillEl) { fillEl.style.width = '0%'; fillEl.classList.remove('extracting'); }
  if (statusEl) statusEl.textContent = t('installation:status.startingDownload');

  // Clean up previous progress listener
  if (unlistenProgress) { unlistenProgress(); unlistenProgress = null; }

  try {
    // Receive progress events from the Rust backend
    unlistenProgress = await listen('runner-download-progress', (event) => {
      const p = event.payload;
      const fill = document.getElementById('install-progress-fill');
      const status = document.getElementById('install-status');
      if (!fill || !status) return;

      if (p.phase === 'downloading') {
        fill.classList.remove('extracting');
        fill.style.width = `${p.percent.toFixed(1)}%`;
        status.textContent = t('installation:status.downloading', { downloaded: formatSize(p.bytes_downloaded), total: formatSize(p.total_bytes) });
      } else if (p.phase === 'extracting') {
        fill.style.width = '100%';
        fill.classList.add('extracting');
        status.textContent = t('installation:status.extracting');
      } else if (p.phase === 'complete') {
        fill.style.width = '100%';
        fill.classList.remove('extracting');
        status.textContent = t('installation:status.installComplete');
      } else if (p.phase === 'error') {
        fill.classList.remove('extracting');
        status.textContent = p.message;
      }
    });
  } catch (e) {
    // listen failed
  }

  try {
    await invoke('install_runner', {
      downloadUrl,
      fileName,
      basePath: configState.installPath,
    });
  } catch (err) {
    if (statusEl) statusEl.textContent = t('installation:status.installError', { error: String(err) });
  }

  // Clean up
  if (unlistenProgress) { unlistenProgress(); unlistenProgress = null; }
  isInstallingRunner = false;

  // Hide overlay after a short delay
  await delay(1200);
  if (overlay) overlay.style.display = 'none';

  // Automatically select the newly installed runner if none is selected yet
  if (!configState.selectedRunner) {
    try {
      const result = await invoke('scan_runners', { basePath: configState.installPath });
      if (result.runners.length > 0) {
        // Select the most recently installed runner
        configState.selectedRunner = result.runners[result.runners.length - 1].name;
      }
    } catch (_) {}
  }

  // Update runner section and Next button
  renderRunnerSection();
  updateNextButton();
}

/**
 * Formats a file size in bytes into a human-readable representation.
 *
 * @param {number} bytes - Size in bytes
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
 * Saves the current configuration state via the Rust backend.
 * Called on path changes and before switching to Step 3.
 */
async function saveCurrentConfig() {
  const config = {
    install_path: configState.installPath,
    selected_runner: configState.selectedRunner,
    performance: configState.performance,
  };

  try {
    await invoke('save_config', { config });
  } catch (err) {
    console.error('Failed to save config:', err);
  }
}

// --- Step 3: Installation ---

/** @type {string|null} ID of the currently running installation phase */
let currentPhaseId = null;
/** @type {number} Current progress in percent */
let currentPercent = 0;
/** @type {Set<string>} IDs of already completed phases */
let completedPhases = new Set();

/**
 * Renders Step 3: Installation summary or process view.
 * If no installation is running yet, a configuration summary
 * with a "Start Installation" button is displayed.
 * If the installation is already running/complete/errored,
 * the process view with phase list and log is shown.
 *
 * @param {HTMLElement} body - The wizard body element
 */
function renderStep3(body) {
  // Cannot install without a selected runner
  if (!configState.selectedRunner) {
    body.innerHTML = `
      <h3>${t('installation:step.installation')}</h3>
      <div class="step3-placeholder">
        <p>${t('installation:error.noRunner')}</p>
      </div>
      <div class="wizard-actions">
        <button class="btn btn-secondary" id="btn-back3">${t('installation:button.back')}</button>
      </div>
    `;
    document.getElementById('btn-back3').addEventListener('click', () => {
      currentStep = 2;
      renderCurrentStep(body.closest('#content') || body.parentElement.parentElement);
    });
    return;
  }

  // If installation is already running or finished, show process view
  if (installPhase === 'running' || installPhase === 'complete' || installPhase === 'error') {
    renderStep3Process(body);
    return;
  }

  // Configuration summary before installation
  const perf = configState.performance;
  const enabledOptions = [];
  if (perf.esync) enabledOptions.push('ESync');
  if (perf.fsync) enabledOptions.push('FSync');
  if (perf.dxvk_async) enabledOptions.push('DXVK Async');
  if (perf.wayland) enabledOptions.push('Wayland');
  if (perf.hdr) enabledOptions.push('HDR');
  if (perf.fsr) enabledOptions.push('FSR');
  if (perf.mangohud) enabledOptions.push('MangoHUD');
  if (perf.dxvk_hud) enabledOptions.push('DXVK HUD');

  body.innerHTML = `
    <h3>${t('installation:step.installation')}</h3>

    <!-- Summary of selected settings -->
    <div class="install-summary">
      <div class="install-summary-row">
        <span class="install-summary-label">${t('installation:label.installPathSummary')}</span>
        <span class="install-summary-value mono">${escapeHtml(configState.installPath)}</span>
      </div>
      <div class="install-summary-row">
        <span class="install-summary-label">${t('installation:label.wineRunnerSummary')}</span>
        <span class="install-summary-value">${escapeHtml(configState.selectedRunner)}</span>
      </div>
      <div class="install-summary-row">
        <span class="install-summary-label">${t('installation:label.performanceSummary')}</span>
        <span class="install-summary-value">
          ${enabledOptions.length > 0
            ? enabledOptions.map(o => `<span class="install-summary-badge">${o}</span>`).join('')
            : `<span class="text-muted">${t('installation:label.performanceNone')}</span>`}
        </span>
      </div>
      ${perf.primary_monitor ? `
      <div class="install-summary-row">
        <span class="install-summary-label">${t('installation:label.primaryMonitorSummary')}</span>
        <span class="install-summary-value mono">${escapeHtml(perf.primary_monitor)}</span>
      </div>
      ` : ''}
    </div>

    <div class="install-summary-hint">
      ${t('installation:desc.installHint')}
    </div>

    <div class="wizard-actions">
      <button class="btn btn-secondary" id="btn-back3">${t('installation:button.back')}</button>
      <button class="btn btn-primary" id="btn-start-install">${t('installation:button.startInstall')}</button>
    </div>
  `;

  // Back to Step 2
  document.getElementById('btn-back3').addEventListener('click', () => {
    currentStep = 2;
    renderCurrentStep(body.closest('#content') || body.parentElement.parentElement);
  });

  // Start installation
  document.getElementById('btn-start-install').addEventListener('click', () => {
    renderStep3Process(body);
    startInstallation();
  });
}

/**
 * Renders the installation process view with phase list, log window,
 * and progress bar. Used both at the start and when revisiting
 * the page during a running installation.
 *
 * @param {HTMLElement} body - The wizard body element
 */
function renderStep3Process(body) {
  body.innerHTML = `
    <h3>${t('installation:step.installation')}</h3>

    <!-- Phase list: Shows progress through the installation steps -->
    <div class="install-phases" id="install-phases">
      ${getInstallPhases().map(p => `
        <div class="install-phase" id="phase-${p.id}" data-phase="${p.id}">
          <span class="install-phase-icon">\u25CB</span>
          <span class="install-phase-label">${p.label}</span>
        </div>
      `).join('')}
    </div>

    <!-- Scrollable log window for installation output -->
    <div class="install-log-container" id="install-log-container">
      <div class="install-log" id="install-log"></div>
    </div>

    <!-- Error message (initially hidden) -->
    <div id="install-error-msg" class="install-error-msg" style="display:none"></div>

    <!-- Action bar: Back, Progress, Cancel, Retry -->
    <div class="wizard-actions">
      <button class="btn btn-secondary" id="btn-back3" disabled>${t('installation:button.back')}</button>
      <div class="install-progress-wrapper" id="install-progress-wrapper">
        <div class="progress-bar-track">
          <div class="progress-bar-fill" id="install-progress-fill"></div>
        </div>
        <span class="install-percent" id="install-percent">0%</span>
      </div>
      <button class="btn btn-secondary" id="btn-cancel-install">${t('installation:button.cancel')}</button>
      <button class="btn btn-primary" id="btn-retry-install" style="display:none">${t('installation:button.retry')}</button>
    </div>
  `;

  // Back button (only active when installation is not running)
  document.getElementById('btn-back3').addEventListener('click', () => {
    if (installPhase === 'running') return;
    currentStep = 2;
    renderCurrentStep(body.closest('#content') || body.parentElement.parentElement);
  });

  // Cancel installation
  document.getElementById('btn-cancel-install').addEventListener('click', async () => {
    try { await invoke('cancel_installation'); } catch (e) { /* ignore */ }
  });

  // Retry: Resets the installation state and shows the summary
  document.getElementById('btn-retry-install').addEventListener('click', () => {
    installPhase = null;
    installLog = [];
    installError = null;
    currentPhaseId = null;
    currentPercent = 0;
    completedPhases.clear();
    renderStep3(body);
  });

  // Restore UI state if the page is revisited
  if (installPhase === 'running' || installPhase === 'complete' || installPhase === 'error') {
    restoreInstallUI();
  }
}

/**
 * Starts the actual installation process.
 * Resets all state variables, binds the event listener for
 * progress events, and invokes the Rust backend.
 */
async function startInstallation() {
  installPhase = 'running';
  installLog = [];
  pendingLogLines = [];
  logRafPending = false;
  installError = null;
  currentPhaseId = null;
  currentPercent = 0;
  completedPhases.clear();

  // Adjust UI elements for running installation
  const startBtn = document.getElementById('btn-start-install');
  const cancelBtn = document.getElementById('btn-cancel-install');
  const backBtn = document.getElementById('btn-back3');
  const progressWrapper = document.getElementById('install-progress-wrapper');
  const logContainer = document.getElementById('install-log-container');

  if (startBtn) startBtn.style.display = 'none';
  if (cancelBtn) cancelBtn.style.display = '';
  if (backBtn) backBtn.disabled = true;
  if (progressWrapper) progressWrapper.style.display = '';
  if (logContainer) logContainer.style.display = '';

  // Receive progress events from the Rust backend
  if (unlistenInstall) { unlistenInstall(); unlistenInstall = null; }

  try {
    unlistenInstall = await listen('install-progress', (event) => {
      handleInstallProgress(event.payload);
    });
  } catch (e) {
    // listen failed
  }

  try {
    // Start installation via the Rust backend
    await invoke('run_installation', {
      config: {
        install_path: configState.installPath,
        selected_runner: configState.selectedRunner,
        performance: configState.performance,
        install_mode: configState.installMode,
      },
    });
    onInstallComplete();
  } catch (err) {
    onInstallError(String(err));
  }

  // Clean up listener
  if (unlistenInstall) { unlistenInstall(); unlistenInstall = null; }
}

/**
 * Processes a single installation progress event.
 * Tracks phase transitions, updates the progress bar, and
 * buffers log lines for efficient DOM updates.
 *
 * @param {Object} payload - The event payload with phase, step, percent, and log_line
 */
function handleInstallProgress(payload) {
  const { phase, step, percent, log_line } = payload;

  // Track phase transitions: Mark previous phase as completed
  if (phase !== 'error' && phase !== 'complete' && phase !== currentPhaseId) {
    if (currentPhaseId) {
      completedPhases.add(currentPhaseId);
    }
    currentPhaseId = phase;
  }

  // Store launch logs globally so the launch page can access them
  if ((phase === 'launch' || phase === 'complete') && log_line) {
    if (!window._starControlLaunchLogs) {
      window._starControlLaunchLogs = [];
    }
    window._starControlLaunchLogs.push(log_line);
  }

  currentPercent = percent;

  // Update phase list in the DOM (active, completed, pending)
  updatePhaseList();

  // Update progress bar
  const fill = document.getElementById('install-progress-fill');
  const percentLabel = document.getElementById('install-percent');
  if (fill) fill.style.width = `${percent.toFixed(1)}%`;
  if (percentLabel) percentLabel.textContent = `${Math.round(percent)}%`;

  // Bundle log lines via requestAnimationFrame to avoid UI flooding
  // (Installation can produce many log lines in a short time)
  if (log_line) {
    installLog.push(log_line);
    pendingLogLines.push(log_line);
    if (!logRafPending) {
      logRafPending = true;
      requestAnimationFrame(flushPendingLogLines);
    }
  }
}

/**
 * Writes all buffered log lines to the DOM at once.
 * Uses a DocumentFragment for efficient batch insert.
 * Called via requestAnimationFrame to avoid impacting the frame rate.
 */
function flushPendingLogLines() {
  logRafPending = false;
  const logEl = document.getElementById('install-log');
  if (!logEl || pendingLogLines.length === 0) return;

  // DocumentFragment for efficient batch DOM update
  const fragment = document.createDocumentFragment();
  for (const text of pendingLogLines) {
    const line = document.createElement('div');
    line.className = 'install-log-line';
    line.textContent = `> ${text}`;
    fragment.appendChild(line);
  }
  pendingLogLines = [];
  logEl.appendChild(fragment);
  // Auto-scroll to bottom
  logEl.scrollTop = logEl.scrollHeight;
}

/**
 * Updates the phase list in the DOM.
 * Each phase has one of three states: completed (checkmark),
 * active (spinner), or pending (empty circle).
 */
function updatePhaseList() {
  getInstallPhases().forEach(p => {
    const el = document.getElementById(`phase-${p.id}`);
    if (!el) return;

    const icon = el.querySelector('.install-phase-icon');
    el.className = 'install-phase';

    if (completedPhases.has(p.id)) {
      // Completed: Checkmark icon
      el.classList.add('done');
      if (icon) { icon.className = 'install-phase-icon'; icon.textContent = '\u2713'; }
    } else if (p.id === currentPhaseId) {
      // Active: Spinning spinner
      el.classList.add('active');
      if (icon) { icon.textContent = ''; icon.className = 'install-phase-icon spinning'; }
    } else {
      // Pending: Empty circle
      if (icon) { icon.textContent = '\u25CB'; icon.className = 'install-phase-icon'; }
    }
  });
}

/**
 * Called when the installation completes successfully.
 * Marks all phases as completed, updates the sidebar,
 * and automatically navigates to the launch page.
 */
async function onInstallComplete() {
  installPhase = 'complete';
  if (currentPhaseId) completedPhases.add(currentPhaseId);
  getInstallPhases().forEach(p => completedPhases.add(p.id));
  currentPhaseId = null;

  // If in repair mode, restore Star Citizen game data from the backup
  if (repairBackupPath) {
    try {
      await invoke('restore_sc_data', {
        backupPath: repairBackupPath,
        installPath: configState.installPath,
      });
    } catch (e) {
      console.warn('Failed to restore SC data:', e);
    }
    repairBackupPath = null;
  }

  router.updateSidebar(true);
  router.navigate('launch');
}

/**
 * Called when the installation fails with an error.
 * Displays the error message and enables retry or back navigation.
 *
 * @param {string} error - The error message
 */
function onInstallError(error) {
  installPhase = 'error';
  installError = error;

  // Toggle buttons: Hide Cancel, show Retry, enable Back
  const cancelBtn = document.getElementById('btn-cancel-install');
  const retryBtn = document.getElementById('btn-retry-install');
  const backBtn = document.getElementById('btn-back3');
  const startBtn = document.getElementById('btn-start-install');
  const errorMsg = document.getElementById('install-error-msg');

  if (cancelBtn) cancelBtn.style.display = 'none';
  if (retryBtn) retryBtn.style.display = '';
  if (backBtn) backBtn.disabled = false;
  if (startBtn) startBtn.style.display = 'none';
  if (errorMsg) {
    errorMsg.style.display = '';
    errorMsg.textContent = error;
  }

  appendLog(`ERROR: ${error}`);
}

/**
 * Appends a single log line to the installation log.
 * Used for manual log entries (e.g., error messages).
 *
 * @param {string} text - The log line
 */
function appendLog(text) {
  installLog.push(text);
  const logEl = document.getElementById('install-log');
  if (logEl) {
    const line = document.createElement('div');
    line.className = 'install-log-line';
    line.textContent = `> ${text}`;
    logEl.appendChild(line);
    logEl.scrollTop = logEl.scrollHeight;
  }
}

/**
 * Restores the installation UI state.
 * Called when the user returns to the installation page during
 * a running or completed installation.
 * Restores log, progress, phase list, and button states.
 */
function restoreInstallUI() {
  const logContainer = document.getElementById('install-log-container');
  const progressWrapper = document.getElementById('install-progress-wrapper');
  const startBtn = document.getElementById('btn-start-install');

  if (logContainer) logContainer.style.display = '';
  if (progressWrapper) progressWrapper.style.display = '';
  if (startBtn) startBtn.style.display = 'none';

  // Restore accumulated log
  const logEl = document.getElementById('install-log');
  if (logEl) {
    logEl.innerHTML = installLog.map(l => `<div class="install-log-line">> ${escapeHtml(l)}</div>`).join('');
    logEl.scrollTop = logEl.scrollHeight;
  }

  // Restore progress bar
  const fill = document.getElementById('install-progress-fill');
  const percentLabel = document.getElementById('install-percent');
  if (fill) fill.style.width = `${currentPercent.toFixed(1)}%`;
  if (percentLabel) percentLabel.textContent = `${Math.round(currentPercent)}%`;

  // Restore phase list
  updatePhaseList();

  // Restore button states based on the installation phase
  if (installPhase === 'complete') {
    onInstallComplete();
  } else if (installPhase === 'error') {
    const cancelBtn = document.getElementById('btn-cancel-install');
    const retryBtn = document.getElementById('btn-retry-install');
    const backBtn = document.getElementById('btn-back3');
    const errorMsg = document.getElementById('install-error-msg');
    if (cancelBtn) cancelBtn.style.display = 'none';
    if (retryBtn) retryBtn.style.display = '';
    if (backBtn) backBtn.disabled = false;
    if (errorMsg && installError) {
      errorMsg.style.display = '';
      errorMsg.textContent = installError;
    }
  } else if (installPhase === 'running') {
    const cancelBtn = document.getElementById('btn-cancel-install');
    const backBtn = document.getElementById('btn-back3');
    if (cancelBtn) cancelBtn.style.display = '';
    if (backBtn) backBtn.disabled = true;
  }
}

// --- Helper functions ---

/**
 * Creates a Promise that resolves after the specified time.
 *
 * @param {number} ms - Delay in milliseconds
 * @returns {Promise<void>}
 */
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
