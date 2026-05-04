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
 * Profile Wizard — single-step modal that helps a Windows-coming gamer
 * get from "I just installed this" to "I'm playing" in two clicks.
 *
 * The wizard creates a fresh launch profile with sensible defaults plus
 * the user's chosen Wine runner, makes it active, and either returns to
 * the dashboard (Save & Done) or jumps to the launch page for further
 * tweaks (Customize). It does NOT include performance toggles — those
 * remain on the launch page so the wizard stays brutally simple.
 */

import { invoke } from '@tauri-apps/api/core';
import { escapeHtml } from '../utils.js';
import { t } from '../i18n.js';
import { showNotification } from '../utils/dialogs.js';

/**
 * Picks a sensible recommended runner from the installed set.
 * Preference order:
 *   1. anything with "lug" in the name (LUG Helper builds — SC-tuned)
 *   2. anything with "ge-proton" or "proton-ge"
 *   3. alphabetically first installed runner
 * Returns null if no runners are installed.
 */
function pickRecommendedRunner(installedRunners) {
  if (!installedRunners || installedRunners.length === 0) return null;
  const sorted = [...installedRunners].sort();
  const lug = sorted.find((n) => n.toLowerCase().includes('lug'));
  if (lug) return lug;
  const ge = sorted.find((n) => {
    const low = n.toLowerCase();
    return low.includes('ge-proton') || low.includes('proton-ge');
  });
  if (ge) return ge;
  return sorted[0];
}

/**
 * Generates a non-conflicting default profile name. Tries the supplied
 * base, then "<base> 2", "<base> 3", etc. Used so the wizard can
 * pre-fill a name that won't immediately fail validation when the user
 * has already created one.
 */
function generateDefaultName(base, existingNames) {
  const taken = new Set(existingNames.map((n) => n.toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  for (let i = 2; i < 1000; i += 1) {
    const candidate = `${base} ${i}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return `${base} ${Date.now()}`;
}

/**
 * Opens the Profile Wizard modal.
 *
 * @param {Object} options
 * @param {(profile: Object, action: 'done'|'customize') => void} [options.onComplete]
 *        Called after a successful save. The caller decides what to do
 *        with the action — typically refresh the dashboard ('done') or
 *        navigate to the launch page ('customize').
 * @param {string} [options.defaultName='My Setup'] Pre-filled profile name.
 * @returns {Promise<void>} Resolves when the modal closes (any reason).
 */
export function showProfileWizard({
  onComplete = () => {},
  defaultName = 'My Setup',
} = {}) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';

    // Initial loading skeleton — replaced once installed runners + existing
    // profiles come back from the backend.
    overlay.innerHTML = renderShell(t('launchProfiles:wizard.loading', {
      defaultValue: 'Loading…',
    }));

    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add('show'));

    let cleanedUp = false;
    let saving = false;
    let installedRunners = [];
    let existingNames = [];
    let recommended = null;

    const cleanup = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      window.removeEventListener('keydown', onKey);
      overlay.classList.remove('show');
      setTimeout(() => {
        overlay.remove();
        resolve();
      }, 200);
    };

    const onKey = (e) => {
      if (e.key === 'Escape' && !saving) cleanup();
    };
    window.addEventListener('keydown', onKey);

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay && !saving) cleanup();
    });

    // Kick off the data load in parallel.
    (async () => {
      let basePath = '';
      try {
        const cfg = await invoke('load_config');
        if (cfg) {
          basePath = cfg.install_path || '';
          existingNames = (cfg.launch_profiles || []).map((p) => p.name);
        }
      } catch (_e) {
        /* fall through with empty profiles list */
      }

      try {
        const result = await invoke('scan_runners', { basePath });
        installedRunners = (result?.runners || []).map((r) => r.name);
      } catch (_e) {
        installedRunners = [];
      }

      recommended = pickRecommendedRunner(installedRunners);
      const initialName = generateDefaultName(defaultName, existingNames);

      overlay.innerHTML = installedRunners.length === 0
        ? renderEmptyRunners()
        : renderForm({
            installedRunners,
            recommended,
            initialName,
          });

      bindEvents();
    })();

    function bindEvents() {
      const closeBtn = overlay.querySelector('#wizard-close');
      if (closeBtn) closeBtn.addEventListener('click', () => cleanup());

      const cancelBtn = overlay.querySelector('#wizard-cancel');
      if (cancelBtn) cancelBtn.addEventListener('click', () => cleanup());

      // Empty-runners CTA: route the user to the runners page so they
      // can install one, and close the wizard.
      const goToRunners = overlay.querySelector('#wizard-goto-runners');
      if (goToRunners) {
        goToRunners.addEventListener('click', async () => {
          cleanup();
          const { router } = await import('../router.js');
          router.navigate('runners');
        });
      }

      const saveDone = overlay.querySelector('#wizard-save-done');
      if (saveDone) saveDone.addEventListener('click', () => save('done'));

      const saveCustomize = overlay.querySelector('#wizard-save-customize');
      if (saveCustomize) {
        saveCustomize.addEventListener('click', () => save('customize'));
      }

      // Inline name validation: turn the input red when the name collides
      // with an existing profile or is empty.
      const nameInput = overlay.querySelector('#wizard-name');
      if (nameInput) {
        nameInput.addEventListener('input', () => {
          const value = nameInput.value.trim();
          const taken = existingNames.some(
            (n) => n.toLowerCase() === value.toLowerCase()
          );
          const invalid = value.length === 0 || taken;
          nameInput.classList.toggle('input-invalid', invalid);
          // Disable save buttons whenever validation fails.
          const buttons = overlay.querySelectorAll('#wizard-save-done, #wizard-save-customize');
          buttons.forEach((b) => {
            b.disabled = invalid;
          });
        });
      }
    }

    async function save(action) {
      if (saving) return;
      const nameInput = overlay.querySelector('#wizard-name');
      const runnerInput = overlay.querySelector(
        'input[name="wizard-runner"]:checked'
      );
      if (!nameInput || !runnerInput) return;

      const name = nameInput.value.trim();
      const runnerName = runnerInput.value;

      if (!name) {
        nameInput.classList.add('input-invalid');
        return;
      }
      if (existingNames.some((n) => n.toLowerCase() === name.toLowerCase())) {
        nameInput.classList.add('input-invalid');
        return;
      }

      saving = true;
      // Disable both save buttons + the close button during the call so a
      // double-click doesn't fire create_and_activate twice.
      overlay
        .querySelectorAll('#wizard-save-done, #wizard-save-customize, #wizard-close, #wizard-cancel')
        .forEach((b) => {
          b.disabled = true;
        });

      try {
        // The backend fills PerformanceSettings::default() for the empty
        // performance object thanks to #[serde(default)] — we don't need
        // to spell out every field on the JS side.
        const profile = await invoke('create_and_activate_launch_profile', {
          name,
          body: {
            runner_name: runnerName,
            performance: {},
          },
        });
        cleanup();
        onComplete(profile, action);
      } catch (e) {
        saving = false;
        overlay
          .querySelectorAll('#wizard-save-done, #wizard-save-customize, #wizard-close, #wizard-cancel')
          .forEach((b) => {
            b.disabled = false;
          });
        showNotification(
          t('launchProfiles:wizard.errors.create', {
            defaultValue: 'Failed to create profile: ',
          }) + String(e),
          'error'
        );
      }
    }
  });
}

// ── Render helpers (return HTML strings; bind events after innerHTML) ───

function renderShell(bodyHtml) {
  const title = escapeHtml(
    t('launchProfiles:wizard.title', { defaultValue: 'Quick Profile Setup' })
  );
  return `
    <div class="modal-container modal-kind-info" role="dialog" aria-modal="true" aria-labelledby="wizard-title">
      <div class="modal-header">
        <div class="modal-title-wrap">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="modal-icon-info"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
          <h3 id="wizard-title">${title}</h3>
        </div>
        <button class="btn btn-ghost btn-sm modal-close-btn" id="wizard-close" aria-label="Close">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
      <div class="modal-body wizard-body">
        ${bodyHtml}
      </div>
    </div>
  `;
}

function renderEmptyRunners() {
  const subtitle = escapeHtml(
    t('launchProfiles:wizard.noRunners', {
      defaultValue: "You don't have any Wine runners installed yet.",
    })
  );
  const cta = escapeHtml(
    t('launchProfiles:wizard.installRecommended', {
      defaultValue: 'Install a recommended runner now',
    })
  );
  const cancel = escapeHtml(
    t('launchProfiles:wizard.cancel', { defaultValue: 'Cancel' })
  );
  return renderShell(`
    <p class="wizard-empty-msg">${subtitle}</p>
    <div class="modal-footer">
      <button class="btn btn-secondary" id="wizard-cancel">${cancel}</button>
      <button class="btn btn-primary" id="wizard-goto-runners">${cta}</button>
    </div>
  `);
}

function renderForm({ installedRunners, recommended, initialName }) {
  const subtitle = escapeHtml(
    t('launchProfiles:wizard.subtitle', {
      defaultValue: 'Get a working Star Citizen launch in about 30 seconds.',
    })
  );
  const runnerLabel = escapeHtml(
    t('launchProfiles:wizard.runnerLabel', { defaultValue: 'Wine Runner' })
  );
  const recommendedHint = escapeHtml(
    t('launchProfiles:wizard.runnerRecommendedHint', {
      defaultValue: 'most reliable for Star Citizen',
    })
  );
  const nameLabel = escapeHtml(
    t('launchProfiles:wizard.profileNameLabel', { defaultValue: 'Profile name' })
  );
  const cancel = escapeHtml(
    t('launchProfiles:wizard.cancel', { defaultValue: 'Cancel' })
  );
  const customize = escapeHtml(
    t('launchProfiles:wizard.customize', { defaultValue: 'Customize' })
  );
  const saveDone = escapeHtml(
    t('launchProfiles:wizard.saveAndDone', { defaultValue: 'Save & Done' })
  );

  const runnerOptions = installedRunners
    .map((name) => {
      const isRec = name === recommended;
      const checked = isRec ? 'checked' : '';
      return `
        <label class="wizard-runner-option${isRec ? ' wizard-runner-recommended' : ''}">
          <input type="radio" name="wizard-runner" value="${escapeHtml(name)}" ${checked} />
          <span class="wizard-runner-body">
            <span class="wizard-runner-name">
              ${isRec ? '★ ' : ''}<code>${escapeHtml(name)}</code>
            </span>
            ${isRec ? `<span class="wizard-runner-hint">${recommendedHint}</span>` : ''}
          </span>
        </label>
      `;
    })
    .join('');

  return renderShell(`
    <p class="wizard-subtitle">${subtitle}</p>

    <div class="wizard-section">
      <label class="wizard-section-label">${runnerLabel}</label>
      <div class="wizard-runner-list">
        ${runnerOptions}
      </div>
    </div>

    <div class="wizard-section">
      <label class="wizard-section-label" for="wizard-name">${nameLabel}</label>
      <input
        type="text"
        id="wizard-name"
        class="input"
        value="${escapeHtml(initialName)}"
        autocomplete="off"
        spellcheck="false"
      />
    </div>

    <div class="modal-footer">
      <button class="btn btn-secondary" id="wizard-cancel">${cancel}</button>
      <div class="wizard-footer-spacer"></div>
      <button class="btn btn-secondary" id="wizard-save-customize">⚙ ${customize}</button>
      <button class="btn btn-primary" id="wizard-save-done">${saveDone}</button>
    </div>
  `);
}
