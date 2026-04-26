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
 * Localization management for Environments page.
 *
 * Handles language pack installation, removal, status display,
 * and localization label loading for translated action names.
 *
 * @module pages/environments/localization
 */

import { invoke } from '@tauri-apps/api/core';
import { t } from '../../i18n.js';
import { escapeHtml } from '../../utils.js';
import { showNotification } from '../../utils/dialogs.js';
import { logError } from '../../utils/error-handler.js';
import { getState, setState } from './state.js';
import { debugLog, formatFileSize, formatCommitDate } from './utils.js';

// ── Localization Data Loading ──

/**
 * Loads the localization labels from Data.p4k (cached).
 * These labels are used for translated action names in the binding view.
 * @returns {boolean} true if successfully loaded, false otherwise
 */
export async function loadLocalizationLabels() {
  const { config, activeScVersion, localizationStatus, localizationLoading, localizationLoaded } = getState();
  if (!config?.install_path || !activeScVersion) {
    setState({ localizationLabels: {}, localizationLoaded: false });
    return false; // Return whether we actually loaded anything
  }

  if (localizationLoading || localizationLoaded) return false;
  setState({ localizationLoading: true });

  try {
    // This uses the cached labels if available
    const localizationLabels = await invoke('get_localization_labels', {
      gamePath: config.install_path,
      version: activeScVersion,
      language: localizationStatus?.language_name?.toLowerCase() || 'english'
    });
    console.log(`[Localization] Loaded ${Object.keys(localizationLabels).length} labels`);
    setState({ localizationLabels, localizationLoaded: true });
    return true; // Successfully loaded
  } catch (e) {
    if (e !== "Localization loading already in progress") {
      console.error('Failed to load localization labels:', e);
    }
    return false;
  } finally {
    setState({ localizationLoading: false });
  }
}

/**
 * Loads the localization status and available languages.
 * Also fetches remote information about the language packs in the background
 * (last commit date, etc.) without blocking the UI.
 */
export async function loadLocalizationData() {
  const { config, activeScVersion } = getState();
  if (!config?.install_path || !activeScVersion) {
    setState({ localizationStatus: null, availableLanguages: [] });
    return;
  }
  try {
    const [status, languages] = await Promise.all([
      invoke('get_localization_status', { gamePath: config.install_path, version: activeScVersion }),
      invoke('get_available_languages', { version: activeScVersion }),
    ]);
    setState({ localizationStatus: status, availableLanguages: languages });
  } catch (e) {
    setState({ localizationStatus: null, availableLanguages: [] });
  }

  // Load remote info in background (non-blocking)
  invoke('fetch_remote_language_info', { forceRefresh: false })
    .then(info => {
      setState({ remoteLanguageInfo: info || [] });
      // Re-render only the localization tab content if visible
      const { activeProfileTab } = getState();
      const tabEl = document.querySelector('.localization-tab');
      if (tabEl && activeProfileTab === 'localization') {
        tabEl.innerHTML = `${renderLocalizationStatus()}${renderLanguageSelector()}`;
      }
    })
    .catch(err => logError(err, 'environments:load_actionmaps'));
}

// ── Localization Tab Rendering ──

/**
 * Renders the Localization tab: installation status + language selector.
 * @returns {string} HTML string for the tab content
 */
export function renderLocalizationTab() {
  return `
    <div class="localization-tab">
      ${renderLocalizationStatus()}
      ${renderLanguageSelector()}
    </div>
  `;
}

/**
 * Renders the current localization status card.
 * Shows language, source, commit version, repository link, and file size.
 * Contains update and remove buttons.
 */
export function renderLocalizationStatus() {
  const { localizationStatus: status, localizationLoading } = getState();

  if (!status || !status.installed) {
    return `
      <div class="profile-info-card">
        <div class="profile-info-row">
          <span class="profile-info-label">${t('environments:localization.language')}</span>
          <span class="profile-info-value">${t('environments:localization.englishDefault')}</span>
        </div>
        <div class="profile-info-row">
          <span class="profile-info-label">${t('environments:localization.status')}</span>
          <span class="profile-info-value"><span class="text-muted">${t('environments:localization.noTranslation')}</span></span>
        </div>
      </div>
    `;
  }

  const langName = status.language_name || status.language_code || 'Unknown';
  const sizeStr = status.file_size ? formatFileSize(status.file_size) : 'Unknown';
  const shortSha = status.commit_sha ? status.commit_sha.substring(0, 7) : null;
  const commitDateStr = status.commit_date ? formatCommitDate(status.commit_date) : null;

  return `
    <div class="profile-info-card">
      <div class="profile-info-row">
        <span class="profile-info-label">${t('environments:localization.language')}</span>
        <span class="profile-info-value localization-lang-active">${escapeHtml(langName)}</span>
      </div>
      ${status.language_code ? `
        <div class="profile-info-row">
          <span class="profile-info-label">${t('environments:localization.code')}</span>
          <span class="profile-info-value"><code>${escapeHtml(status.language_code)}</code></span>
        </div>
      ` : ''}
      ${status.source_label ? `
        <div class="profile-info-row">
          <span class="profile-info-label">${t('environments:localization.source')}</span>
          <span class="profile-info-value">${escapeHtml(status.source_label)}</span>
        </div>
      ` : ''}
      ${commitDateStr || shortSha ? `
        <div class="profile-info-row">
          <span class="profile-info-label">${t('environments:localization.translationVersion')}</span>
          <span class="profile-info-value">
            ${commitDateStr ? escapeHtml(commitDateStr) : ''}
            ${shortSha ? `<code class="localization-commit-hash">${escapeHtml(shortSha)}</code>` : ''}
          </span>
        </div>
      ` : ''}
      ${status.repo_url ? `
        <div class="profile-info-row">
          <span class="profile-info-label">${t('environments:localization.repository')}</span>
          <span class="profile-info-value">
            <a href="#" class="localization-repo-link" data-url="${escapeHtml(status.repo_url)}">
              ${escapeHtml(status.source_repo || status.repo_url)}
              <svg class="localization-repo-link-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>
                <polyline points="15 3 21 3 21 9"></polyline>
                <line x1="10" y1="14" x2="21" y2="3"></line>
              </svg>
            </a>
          </span>
        </div>
      ` : ''}
      ${status.installed_at ? `
        <div class="profile-info-row">
          <span class="profile-info-label">${t('environments:localization.installed')}</span>
          <span class="profile-info-value">${escapeHtml(status.installed_at)}</span>
        </div>
      ` : ''}
      ${status.variant ? `
        <div class="profile-info-row">
          <span class="profile-info-label">${t('environments:localization.variant')}</span>
          <span class="profile-info-value">${escapeHtml(status.variant === 'full' ? t('environments:localization.variantFull') : t('environments:localization.variantHybrid'))}</span>
        </div>
      ` : ''}
      ${status.blueprints_installed != null ? `
        <div class="profile-info-row">
          <span class="profile-info-label">${t('environments:localization.blueprintsRow')}</span>
          <span class="profile-info-value">
            ${status.blueprints_installed
              ? t('environments:localization.blueprintsActive', { patch: escapeHtml(status.blueprints_version || '?') })
              : t('environments:localization.blueprintsInactive')}
          </span>
        </div>
      ` : ''}
      <div class="profile-info-row">
        <span class="profile-info-label">${t('environments:localization.fileSize')}</span>
        <span class="profile-info-value">${sizeStr}</span>
      </div>
      <div class="profile-info-row">
        <span class="profile-info-label">${t('environments:localization.actionsLabel')}</span>
        <span class="profile-info-value">
          <button class="btn btn-sm btn-primary" id="btn-update-localization" ${localizationLoading ? 'disabled' : ''}>
            ${localizationLoading ? t('environments:localization.updating') : t('environments:localization.update')}
          </button>
          <button class="btn btn-sm btn-danger-sm" id="btn-remove-localization" ${localizationLoading ? 'disabled' : ''}>${t('environments:localization.remove')}</button>
        </span>
      </div>
    </div>
  `;
}

/**
 * Renders the table of available languages with install buttons.
 * Groups languages by language code (one language can have multiple sources).
 * Shows remote information (last update) when available.
 */
export function renderLanguageSelector() {
  const { availableLanguages, localizationStatus, remoteLanguageInfo, localizationLoading } = getState();

  if (availableLanguages.length === 0) {
    return `<div class="sc-hint">${t('environments:localization.noLanguages')}</div>`;
  }

  // Group languages by code (one language can have multiple translation sources)
  const grouped = {};
  for (const lang of availableLanguages) {
    if (!grouped[lang.language_code]) {
      grouped[lang.language_code] = {
        language_code: lang.language_code,
        language_name: lang.language_name,
        flag: lang.flag,
        sources: [],
      };
    }
    grouped[lang.language_code].sources.push({
      source_repo: lang.source_repo,
      source_label: lang.source_label,
      repo_url: lang.repo_url,
      variant: lang.variant || null,
    });
  }

  const languages = Object.values(grouped);
  const isInstalled = localizationStatus?.installed;
  const installedCode = localizationStatus?.language_code;
  const installedSource = localizationStatus?.source_label;

  // Flatten: one row per source (not per language)
  const rows = [];
  for (const lang of languages) {
    const isActive = isInstalled && installedCode === lang.language_code;
    for (const src of lang.sources) {
      rows.push({ lang, src, isActive, isSrcActive: isActive && installedSource === src.source_label });
    }
  }

  return `
    <div class="sc-section">
      <div class="sc-section-header">
        <h3>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10"></circle>
            <line x1="2" y1="12" x2="22" y2="12"></line>
            <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path>
          </svg>
          ${t('environments:localization.availableTitle')}
        </h3>
      </div>
      <div class="localization-table">
        <div class="localization-table-header">
          <span class="localization-col-lang">${t('environments:localization.colLanguage')}</span>
          <span class="localization-col-source">${t('environments:localization.colSource')}</span>
          <span class="localization-col-updated">${t('environments:localization.colUpdated')}</span>
          <span class="localization-col-action"></span>
        </div>
        ${rows.map(({ lang, src, isSrcActive }, idx) => {
          const remoteInfo = remoteLanguageInfo.find(
            r => r.source_repo === src.source_repo && r.language_code === lang.language_code
          );
          const lastUpdated = remoteInfo ? formatCommitDate(remoteInfo.commit_date) : '';
          const prevLang = idx > 0 ? rows[idx - 1].lang.language_code : null;
          const isNewGroup = prevLang !== null && prevLang !== lang.language_code;
          return `
          <div class="localization-table-row ${isSrcActive ? 'active' : ''} ${isNewGroup ? 'localization-group-first' : ''}">
            <span class="localization-col-lang">
              <span class="localization-lang-flag">${escapeHtml(lang.flag)}</span>
              <span class="localization-lang-name">${escapeHtml(lang.language_name)}</span>
            </span>
            <span class="localization-col-source">
              <span class="localization-source-label">${escapeHtml(src.source_label)}</span>
              ${src.repo_url ? `
                <a href="#" class="localization-repo-link-icon" data-url="${escapeHtml(src.repo_url)}" title="${t('environments:localization.openRepo')}">
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>
                    <polyline points="15 3 21 3 21 9"></polyline>
                    <line x1="10" y1="14" x2="21" y2="3"></line>
                  </svg>
                </a>
              ` : ''}
            </span>
            <span class="localization-col-updated">${escapeHtml(lastUpdated)}</span>
            <span class="localization-col-action">
              ${isSrcActive ? `<span class="localization-installed-badge">${t('environments:localization.installedBadge')}</span>` : `
                <button class="btn-install" data-action="install-lang"
                        data-lang-code="${escapeHtml(lang.language_code)}"
                        data-source-repo="${escapeHtml(src.source_repo)}"
                        data-lang-name="${escapeHtml(lang.language_name)}"
                        data-source-label="${escapeHtml(src.source_label)}"
                        data-variant="${escapeHtml(src.variant || '')}"
                        ${localizationLoading ? 'disabled' : ''}>
                  ${t('environments:localization.install')}
                </button>
              `}
            </span>
          </div>
          `;
        }).join('')}
      </div>
      <div class="localization-hint">
        ${t('environments:localization.communityHint')}
      </div>
    </div>
  `;
}

// ── Localization Actions ──

/**
 * Installs a language pack for the active SC version.
 * Shows a notification on success/error and updates the UI.
 *
 * NOTE: Calls renderEnvironments() and loadUserCfgSettings() which live in
 * the parent environments.js module. These will be wired up when this module
 * is integrated. For now they are accessed via the onRender/onReload callbacks.
 *
 * @param {string} langCode - Language code to install
 * @param {string} sourceRepo - Source repository identifier
 * @param {string} displayName - Human-readable language name
 * @param {string} sourceLabel - Source label for the translation
 * @param {Object} callbacks - { renderEnvironments, loadUserCfgSettings }
 * @param {Object} [extra] - Optional extra args: { variant, injectBlueprints }
 */
export async function installLocalization(langCode, sourceRepo, displayName, sourceLabel, callbacks = {}, extra = {}) {
  const { config, activeScVersion } = getState();
  if (!config?.install_path || !activeScVersion) return;
  setState({ localizationLoading: true });
  if (callbacks.renderEnvironments) callbacks.renderEnvironments(document.getElementById('content'));

  try {
    const result = await invoke('install_localization', {
      gamePath: config.install_path,
      version: activeScVersion,
      languageCode: langCode,
      sourceRepo: sourceRepo,
      languageName: displayName,
      sourceLabel: sourceLabel,
      variant: extra.variant || null,
      injectBlueprints: extra.injectBlueprints || false,
    });
    showNotification(t('environments:notification.translationInstalled', { language: displayName }), 'success');
    // Surface non-fatal BP warning (e.g. low hit rate against installed SC build)
    if (result?.bp_warning) {
      showNotification(result.bp_warning, 'warning');
    }
    const reloads = [loadLocalizationData()];
    if (callbacks.loadUserCfgSettings) reloads.push(callbacks.loadUserCfgSettings());
    await Promise.all(reloads);
  } catch (e) {
    showNotification(t('environments:notification.installFailed', { error: e }), 'error');
  }

  setState({ localizationLoading: false });
  if (callbacks.renderEnvironments) callbacks.renderEnvironments(document.getElementById('content'));
}

/**
 * Removes the installed localization after user confirmation.
 * Resets the language to English (default) and reloads the UI.
 *
 * @param {Object} callbacks - { renderEnvironments, loadUserCfgSettings, confirm }
 */
export async function removeLocalization(callbacks = {}) {
  const { config, activeScVersion, localizationStatus } = getState();
  if (!config?.install_path || !activeScVersion) return;

  const confirmFn = callbacks.confirm || (async () => true);
  const langName = localizationStatus?.language_name || 'translation';
  const confirmed = await confirmFn(t('environments:localization.removeConfirm', { language: langName }), { title: t('environments:localization.removeTitle'), kind: 'warning' });
  if (!confirmed) return;

  setState({ localizationLoading: true });
  if (callbacks.renderEnvironments) callbacks.renderEnvironments(document.getElementById('content'));

  try {
    await invoke('remove_localization', {
      gamePath: config.install_path,
      version: activeScVersion,
    });
    showNotification(t('environments:notification.translationRemoved'), 'success');
    const reloads = [loadLocalizationData()];
    if (callbacks.loadUserCfgSettings) reloads.push(callbacks.loadUserCfgSettings());
    await Promise.all(reloads);
  } catch (e) {
    showNotification(t('environments:notification.removeFailed', { error: e }), 'error');
  }

  setState({ localizationLoading: false });
  if (callbacks.renderEnvironments) callbacks.renderEnvironments(document.getElementById('content'));
}

/**
 * Opens a modal for installing a localization variant (currently German only).
 * Shows the variant name and an experimental Blueprint-injection toggle.
 * On confirm, calls install_localization with the chosen options via installLocalization().
 *
 * @param {Object} options
 * @param {string} options.languageCode - Star Citizen language code
 * @param {string} options.languageName - Display name (e.g. "Deutsch" or "Deutsch+")
 * @param {string} options.sourceRepo - GitHub repo path (e.g. "rjcncpt/StarCitizen-Deutsch-INI")
 * @param {string} options.sourceLabel - Human-readable source label
 * @param {string} options.variant - "hybrid" or "full"
 * @param {Object} callbacks - { renderEnvironments, loadUserCfgSettings } - forwarded to installLocalization
 */
export async function openInstallModal({ languageCode, languageName, sourceRepo, sourceLabel, variant }, callbacks = {}) {
  const variantLabel = variant === 'full'
    ? t('environments:localization.variantFull')
    : t('environments:localization.variantHybrid');

  const modal = document.createElement('div');
  modal.className = 'modal-overlay';
  modal.innerHTML = `
    <div class="modal-container">
      <div class="modal-header">
        <h3>${t('environments:localization.installModalTitle', { language: escapeHtml(languageName) })}</h3>
        <button class="btn-close modal-close-btn" data-action="close-install-modal">×</button>
      </div>
      <div class="modal-body">
        <p style="color: var(--text-secondary); margin-bottom: 1rem;">
          ${t('environments:localization.installModalSubtitle', { variant: escapeHtml(variantLabel) })}
        </p>
        <label class="filter-toggle" style="margin-bottom: 0.5rem;">
          <span class="toggle-switch">
            <input type="checkbox" id="inject-blueprints-cb">
            <span class="toggle-slider"></span>
          </span>
          <span>
            ${t('environments:localization.injectBlueprintsLabel')}
            <span class="localization-installed-badge" style="margin-left: 0.5rem; background: rgba(255, 165, 0, 0.15); color: #ffaa00;">
              ${t('environments:localization.experimentalBadge')}
            </span>
          </span>
        </label>
        <div id="bp-detail-block" style="display: none; padding: 0.75rem; margin-top: 0.5rem; background: rgba(255, 165, 0, 0.05); border-left: 3px solid rgba(255, 165, 0, 0.5); border-radius: 4px;">
          <p style="color: var(--text-secondary); font-size: 0.85rem; margin-bottom: 0.5rem;">
            ${t('environments:localization.blueprintsExperimentalNote')}
          </p>
          <p id="bp-version-info" style="color: var(--text-secondary); font-size: 0.85rem; margin: 0;">
            ${t('environments:localization.blueprintsLoadingPatch')}
          </p>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" data-action="close-install-modal">${t('environments:localization.installBtnCancel')}</button>
        <button class="btn btn-primary" id="btn-install-confirm">${t('environments:localization.installBtnConfirm')}</button>
      </div>
    </div>
  `;

  const closeModal = () => {
    modal.classList.remove('show');
    setTimeout(() => modal.remove(), 200);
  };

  modal.querySelectorAll('[data-action="close-install-modal"]').forEach(btn =>
    btn.addEventListener('click', closeModal)
  );

  // Reveal detail block + lazy-fetch BP version when checkbox is checked
  const cb = modal.querySelector('#inject-blueprints-cb');
  const detailBlock = modal.querySelector('#bp-detail-block');
  const bpVersionInfo = modal.querySelector('#bp-version-info');
  let bpCompatLoaded = false;
  cb.addEventListener('change', async () => {
    if (cb.checked) {
      detailBlock.style.display = 'block';
      if (!bpCompatLoaded) {
        bpCompatLoaded = true;
        try {
          const compat = await invoke('check_blueprints_compat');
          if (compat.bp_patch) {
            bpVersionInfo.innerHTML = t('environments:localization.blueprintsVersionMismatch', { bpPatch: escapeHtml(compat.bp_patch) });
          } else {
            bpVersionInfo.textContent = '';
          }
        } catch (_e) {
          bpVersionInfo.textContent = '';
        }
      }
    } else {
      detailBlock.style.display = 'none';
    }
  });

  modal.querySelector('#btn-install-confirm').addEventListener('click', () => {
    const injectBlueprints = cb.checked;
    closeModal();
    installLocalization(languageCode, sourceRepo, languageName, sourceLabel, callbacks, { variant, injectBlueprints });
  });

  document.body.appendChild(modal);
  requestAnimationFrame(() => modal.classList.add('show'));
}

/**
 * Finds the source repository URL for the currently installed localization.
 * Matches against the available languages list by code and source label.
 * @returns {string|null} Repository identifier or null if not found
 */
export function resolveSourceRepo() {
  const { localizationStatus, availableLanguages } = getState();
  if (!localizationStatus?.installed) return null;
  const code = localizationStatus.language_code;
  const label = localizationStatus.source_label;
  const match = availableLanguages.find(
    l => l.language_code === code && l.source_label === label
  );
  return match?.source_repo || null;
}
