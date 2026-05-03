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
 * Penguin Citizen - Setup Wizard Page
 *
 * This module implements the initial setup wizard:
 * - Step 1: Welcome/disclaimer page with community credits
 * - Step 2: Path selection for the installation directory
 * - Detection of existing installations with mode selection (Quick/Full)
 * - Saving the final configuration
 *
 * @module pages/setup
 */

import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import madeByCommunityUrl from '../assets/logos/MadeByTheCommunity_White.png';
import { escapeHtml } from '../utils.js';
import { t } from '../i18n.js';

/** @type {string} Default installation path (suggested by the backend) */
let defaultPath = '';
/** @type {string} Currently entered/selected path by the user */
let currentPath = '';
/** @type {Object|null} Path validation result */
let validationResult = null;
/** @type {boolean} Locks the "Continue" button during processing */
let isCreating = false;
/** @type {number} Current wizard step (1 = Disclaimer, 2 = Path selection) */
let currentStep = 1;
/** @type {string} Installation mode: 'full' (complete) or 'quick' (DXVK/Wine only) */
let installMode = 'full';
/** @type {Object|null} Result of the existing installation check */
let detectedInstallation = null;
/** @type {number|null} Debounce timer for path validation */
let validateTimer = null;

/**
 * Entry point for the setup wizard.
 * Resets all state variables and starts with the disclaimer step.
 *
 * @param {HTMLElement} container - The container element to render into
 * @param {Object} options - Options
 * @param {string} options.defaultPath - Default installation path suggested by the backend
 * @param {Function} options.onComplete - Callback invoked after successful setup
 */
export function renderSetup(container, { defaultPath: defPath, onComplete }) {
  defaultPath = defPath;
  currentPath = defPath;
  validationResult = null;
  isCreating = false;
  currentStep = 1;

  renderDisclaimerStep(container, { onComplete });
}

/**
 * Renders the welcome/disclaimer step (Step 1).
 * Shows the community logo, a description of the app, and links to the
 * projects that make Penguin Citizen possible (LUG Wiki, LUG Helper, SC Launcher Configurator).
 *
 * @param {HTMLElement} container - The container element
 * @param {Object} options - Options with onComplete callback
 */
function renderDisclaimerStep(container, { onComplete }) {
  container.innerHTML = `
    <div class="setup-wizard">
      <div class="setup-card">
        <div class="setup-header">
          <img src="${madeByCommunityUrl}" alt="Penguin Citizen" class="setup-logo" />
          <h1 class="setup-title">${t('setup:title')}</h1>
          <p class="setup-subtitle">${t('setup:subtitle')}</p>
        </div>

        <div class="setup-body">
          <p class="setup-description">
            ${t('setup:desc.intro')}
          </p>

          <!-- Links to the community projects that serve as the foundation -->
          <div class="project-links">
            <a href="https://wiki.starcitizen-lug.org/" target="_blank" rel="noopener noreferrer" class="project-link">
              <span class="project-name">${t('setup:project.lugWiki')}</span>
              <span class="project-desc">${t('setup:project.lugWikiDesc')}</span>
            </a>
            <a href="https://github.com/starcitizen-lug/lug-helper" target="_blank" rel="noopener noreferrer" class="project-link">
              <span class="project-name">${t('setup:project.lugHelper')}</span>
              <span class="project-desc">${t('setup:project.lugHelperDesc')}</span>
            </a>
            <a href="https://luftwerft.com" target="_blank" rel="noopener noreferrer" class="project-link">
              <span class="project-name">${t('setup:project.scLauncher')}</span>
              <span class="project-desc">${t('setup:project.scLauncherDesc')}</span>
            </a>
          </div>

          <p class="setup-description" style="margin-top: 1.5rem;">
            ${t('setup:desc.interfaceOnly')}
          </p>
        </div>

        <div class="setup-footer">
          <button class="btn btn-primary" id="setup-btn-continue">${t('setup:button.continue')}</button>
        </div>
      </div>
    </div>
  `;

  // Continue to the next step (directory selection)
  document.getElementById('setup-btn-continue').addEventListener('click', () => {
    currentStep = 2;
    renderDirectoryStep(container, { onComplete });
  });
}

/**
 * Renders the directory selection step (Step 2).
 * The user can enter the installation path or select it via a
 * file dialog. The path is validated (existence, write permissions,
 * at least 100 GB free disk space).
 *
 * @param {HTMLElement} container - The container element
 * @param {Object} options - Options with onComplete callback
 */
function renderDirectoryStep(container, { onComplete }) {
  container.innerHTML = `
    <div class="setup-wizard">
      <div class="setup-card">
        <div class="setup-header">
          <img src="${madeByCommunityUrl}" alt="Penguin Citizen" class="setup-logo" />
          <h1 class="setup-title">${t('setup:title')}</h1>
          <p class="setup-subtitle">${t('setup:subtitle')}</p>
        </div>

        <div class="setup-body">
          <p class="setup-description">
            ${t('setup:desc.chooseDir')}
          </p>

          <div class="setup-field">
            <label class="setup-label">${t('setup:label.installDir')}</label>
            <div class="path-input-row">
              <input type="text" class="input" id="setup-path-input"
                     value="${escapeHtml(defaultPath)}"
                     placeholder="${t('setup:label.placeholder')}" />
              <button class="btn btn-secondary" id="setup-btn-browse">Browse</button>
            </div>
            <div id="setup-path-validation" class="path-validation-msg"></div>
          </div>
        </div>

        <div class="setup-footer">
          <button class="btn btn-secondary" id="setup-btn-back">${t('setup:button.back', { defaultValue: 'Back' })}</button>
          <div class="setup-continue-wrap">
            <button class="btn btn-primary" id="setup-btn-continue" disabled>${t('setup:button.continue')}</button>
            <span class="setup-continue-hint" id="setup-continue-hint">${t('setup:hint.validateFirst', { defaultValue: 'Please validate the path first' })}</span>
          </div>
        </div>
      </div>
    </div>
  `;

  const pathInput = document.getElementById('setup-path-input');
  const continueBtn = document.getElementById('setup-btn-continue');
  const continueHint = document.getElementById('setup-continue-hint');

  // Debounced validation on keystroke (300ms delay)
  pathInput.addEventListener('input', () => {
    currentPath = pathInput.value;
    clearTimeout(validateTimer);
    validateTimer = setTimeout(() => validateSetupPath(), 300);
  });

  // Immediate validation on blur or Enter
  pathInput.addEventListener('blur', () => {
    clearTimeout(validateTimer);
    validateSetupPath();
  });
  pathInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      clearTimeout(validateTimer);
      validateSetupPath();
    }
  });

  // Back button returns to the disclaimer step
  document.getElementById('setup-btn-back').addEventListener('click', () => {
    clearTimeout(validateTimer);
    currentStep = 1;
    renderDisclaimerStep(container, { onComplete });
  });

  // Open directory browser dialog via the Tauri dialog plugin
  document.getElementById('setup-btn-browse').addEventListener('click', async () => {
    try {
      const selected = await open({ directory: true, title: t('setup:label.selectDialog') });
      if (selected) {
        pathInput.value = selected;
        currentPath = selected;
        validateSetupPath();
      }
    } catch (err) {
      console.error('Browse dialog failed:', err);
    }
  });

  // "Continue" button: Checks for existing installation and creates the directory
  continueBtn.addEventListener('click', async () => {
    // Double-click protection: Prevents multiple executions
    if (isCreating) return;
    isCreating = true;
    continueBtn.disabled = true;
    continueBtn.textContent = t('setup:status.checking');

    try {
      // Step 1: Check if runners already exist at the selected path
      let existingRunnerName = null;
      try {
        const scanResult = await invoke('scan_runners', { basePath: currentPath });
        if (scanResult.runners && scanResult.runners.length > 0) {
          existingRunnerName = scanResult.runners[0].name;
        }
      } catch (e) {
        // Ignore scan errors - no problem if no runners are found
      }

      // Step 2: Check if an existing installation is present
      const existingConfig = {
        install_path: currentPath,
        launch_working_state: {
          runner_name: existingRunnerName ?? '',
          performance: {},
        },
      };

      try {
        detectedInstallation = await invoke('check_installation', { config: existingConfig });
      } catch (e) {
        // check_installation can fail - no problem
        detectedInstallation = null;
      }

      // Step 3: If RSI Launcher exists, show the installation mode dialog
      // (Quick Install vs. full reinstall)
      if (detectedInstallation && detectedInstallation.launcher_exe_exists) {
        continueBtn.textContent = t('setup:button.continue');
        continueBtn.disabled = false;
        isCreating = false;
        showInstallModeModal(container, { onComplete, continueBtn });
        return;
      }

      // Step 4: No existing launcher - normal flow (create directory + save config)
      continueBtn.textContent = t('setup:status.creating');

      await invoke('create_install_directory', { path: currentPath });

      // Save default configuration with sensible presets
      await invoke('save_config', {
        config: {
          install_path: currentPath,
          launch_working_state: {
            runner_name: '',
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
          },
          github_token: null,
          log_level: 'info',
          auto_backup_on_launch: null,
          install_mode: 'full',
        },
      });

      // Setup complete - invoke callback to switch to the main view
      onComplete();
    } catch (err) {
      // Show error and re-enable the button
      const msgEl = document.getElementById('setup-path-validation');
      msgEl.className = 'path-validation-msg validation-fail';
      msgEl.textContent = String(err);
      continueBtn.disabled = false;
      continueBtn.textContent = t('setup:button.continue');
      isCreating = false;
    }
  });

  // Perform initial validation of the pre-filled path
  validateSetupPath();
}

/**
 * Validates the currently entered installation path via the Rust backend.
 * Checks existence, write permissions, and available disk space.
 * Enables/disables the "Continue" button based on the result.
 */
async function validateSetupPath() {
  const msgEl = document.getElementById('setup-path-validation');
  const continueBtn = document.getElementById('setup-btn-continue');
  const continueHint = document.getElementById('setup-continue-hint');

  // Empty path is invalid
  if (!currentPath.trim()) {
    msgEl.className = 'path-validation-msg validation-fail';
    msgEl.textContent = t('setup:error.enterPath');
    continueBtn.disabled = true;
    if (continueHint) continueHint.style.display = '';
    return;
  }

  msgEl.className = 'path-validation-msg';
  msgEl.textContent = t('setup:status.validating');

  try {
    // Backend validation: Checks path existence, permissions, and free disk space
    const result = await invoke('validate_install_path', { path: currentPath });
    validationResult = result;

    if (result.valid) {
      msgEl.className = 'path-validation-msg validation-pass';
      msgEl.textContent = result.message;
      continueBtn.disabled = false;
      if (continueHint) continueHint.style.display = 'none';
    } else {
      msgEl.className = 'path-validation-msg validation-fail';
      msgEl.textContent = result.message;
      continueBtn.disabled = true;
      if (continueHint) continueHint.style.display = '';
    }
  } catch (err) {
    msgEl.className = 'path-validation-msg validation-fail';
    msgEl.textContent = t('setup:status.validationFailed');
    continueBtn.disabled = true;
    if (continueHint) continueHint.style.display = '';
  }
}



/**
 * Shows a modal dialog for selecting the installation mode.
 * Displayed when an existing RSI Launcher installation is detected.
 * The user can choose between Quick Install (only update DXVK/Wine)
 * and a complete reinstallation.
 *
 * @param {HTMLElement} container - The container element for the modal
 * @param {Object} options - Options
 * @param {Function} options.onComplete - Callback after successful setup
 * @param {HTMLElement} options.continueBtn - Reference to the Continue button (re-enabled on error)
 */
function showInstallModeModal(container, { onComplete, continueBtn }) {
  // Remove existing modal if one exists (double-call protection)
  const existing = container.querySelector('.modal-overlay');
  if (existing) existing.remove();

  const modal = document.createElement('div');
  modal.className = 'modal-overlay';
  modal.innerHTML = `
    <div class="modal-content">
      <h2 class="modal-title">${t('setup:modal.existingTitle')}</h2>
      <p class="modal-description">
        ${t('setup:modal.existingDesc')}
      </p>

      <!-- Show detected installation details (path and runner if available) -->
      <div class="detected-info">
        <div class="detected-row">
          <span class="detected-label">${t('setup:modal.path')}</span>
          <span class="detected-value">${escapeHtml(detectedInstallation.install_path)}</span>
        </div>
        ${detectedInstallation.runner_name ? `
        <div class="detected-row">
          <span class="detected-label">${t('setup:modal.runner')}</span>
          <span class="detected-value">${escapeHtml(detectedInstallation.runner_name)}</span>
        </div>
        ` : ''}
      </div>

      <!-- Choice between Quick Install and full reinstallation -->
      <div class="install-mode-options">
        <div class="mode-option" data-mode="quick">
          <div class="mode-option-header">
            <span class="mode-option-icon">⚡</span>
            <span class="mode-option-title">${t('setup:modal.quickTitle')}</span>
          </div>
          <p class="mode-option-desc">
            ${t('setup:modal.quickDesc')}
          </p>
        </div>

        <div class="mode-option" data-mode="full">
          <div class="mode-option-header">
            <span class="mode-option-icon">📦</span>
            <span class="mode-option-title">${t('setup:modal.reinstallTitle')}</span>
          </div>
          <p class="mode-option-desc">
            ${t('setup:modal.reinstallDesc')}
          </p>
        </div>
      </div>

      <div class="modal-actions">
        <button class="btn btn-secondary" id="modal-btn-cancel">${t('setup:modal.cancel')}</button>
        <button class="btn btn-primary" id="modal-btn-continue">${t('setup:modal.continue')}</button>
      </div>
    </div>
  `;

  container.appendChild(modal);

  // Trigger CSS transition: show modal overlay with fade-in
  requestAnimationFrame(() => modal.classList.add('show'));

  // Click handler for mode options: Highlights the selected option
  const options = modal.querySelectorAll('.mode-option');
  options.forEach(opt => {
    opt.addEventListener('click', () => {
      options.forEach(o => o.classList.remove('selected'));
      opt.classList.add('selected');
      installMode = opt.dataset.mode;
    });
  });

  // Pre-select "Quick Install" by default
  options[0].classList.add('selected');
  installMode = 'quick';

  // Cancel button closes the modal
  modal.querySelector('#modal-btn-cancel').addEventListener('click', () => {
    modal.remove();
  });

  // "Continue" button: Create directory, save config, and complete setup
  modal.querySelector('#modal-btn-continue').addEventListener('click', async () => {
    const btn = modal.querySelector('#modal-btn-continue');
    btn.disabled = true;
    btn.textContent = t('setup:status.saving');

    try {
      await invoke('create_install_directory', { path: currentPath });

      // Save config with detected runner and selected installation mode
      await invoke('save_config', {
        config: {
          install_path: currentPath,
          launch_working_state: {
            runner_name: detectedInstallation.runner_name ?? '',
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
          },
          github_token: null,
          log_level: 'info',
          auto_backup_on_launch: null,
          install_mode: installMode,
        },
      });

      modal.remove();
      onComplete();
    } catch (err) {
      btn.disabled = false;
      btn.textContent = t('setup:modal.continue');
      console.error('Failed to save config:', err);
    }
  });
}
