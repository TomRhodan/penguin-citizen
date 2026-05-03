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
 * Launch Profiles management page — Card-Grid for create/rename/duplicate/
 * delete/set-active/edit-description, plus the global Wine Runner Fallback
 * setting.
 *
 * Quick-switch (dropdown directly on the launch page) and dirty
 * indicator come from launch.js — this file owns the heavy CRUD UI.
 */

import { invoke } from '@tauri-apps/api/core';
import i18next from 'i18next';

const t = (key, opts) => i18next.t(key, opts);

/**
 * Cached AppConfig from the most recent load. Populated by `load()`,
 * mutated by callbacks before save_config, refreshed after each command.
 * @type {Object|null}
 */
let cachedConfig = null;

/**
 * Cached list of installed runner names — populated once per render so
 * the fallback dropdown and per-profile runner badges can show whether
 * a runner is still present.
 * @type {string[]}
 */
let installedRunners = [];

/**
 * Reference to the active container for re-rendering after mutations.
 * @type {HTMLElement|null}
 */
let activeContainer = null;

// ── HTML escape ────────────────────────────────────────────────────────

function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

// ── Public render entry point ──────────────────────────────────────────

export async function renderLaunchProfiles(container) {
  activeContainer = container;
  container.innerHTML = `
    <div class="page-header">
      <h1>${escapeHtml(t('launchProfiles:title', { defaultValue: 'Launch Profiles' }))}</h1>
      <p class="page-subtitle">${escapeHtml(
        t('launchProfiles:subtitle', {
          defaultValue:
            'Save and switch between named launch configurations. Each profile remembers all toggles and the Wine runner.',
        })
      )}</p>
    </div>
    <div class="launch-profiles-skeleton">${escapeHtml(
      t('launchProfiles:loading', { defaultValue: 'Loading…' })
    )}</div>
  `;

  await load();
  paint();
}

export function cleanupLaunchProfiles() {
  activeContainer = null;
}

// ── Data loading ───────────────────────────────────────────────────────

async function load() {
  cachedConfig = await invoke('load_config');
  if (!cachedConfig) {
    cachedConfig = {};
  }
  // Discover installed runners under <install_path>/runners
  try {
    const result = await invoke('scan_runners', {
      basePath: cachedConfig.install_path || '',
    });
    installedRunners = (result?.runners || []).map((r) => r.name);
  } catch (_e) {
    installedRunners = [];
  }
}

// ── Render ─────────────────────────────────────────────────────────────

function paint() {
  if (!activeContainer) return;
  const profiles = cachedConfig?.launch_profiles || [];
  const activeId = cachedConfig?.active_launch_profile_id || '';
  const fallback = cachedConfig?.fallback_runner || '';

  activeContainer.innerHTML = `
    <div class="page-header">
      <h1>${escapeHtml(t('launchProfiles:title', { defaultValue: 'Launch Profiles' }))}</h1>
      <p class="page-subtitle">${escapeHtml(
        t('launchProfiles:subtitle', {
          defaultValue:
            'Save and switch between named launch configurations. Each profile remembers all toggles and the Wine runner.',
        })
      )}</p>
    </div>

    <div class="launch-profiles-toolbar">
      <button class="btn btn-primary" id="btn-create-profile">
        + ${escapeHtml(
          t('launchProfiles:createButton', {
            defaultValue: 'Create new profile from current settings',
          })
        )}
      </button>
    </div>

    <div class="launch-profiles-grid">
      ${profiles.map((p) => renderCard(p, p.id === activeId, profiles.length === 1)).join('')}
    </div>

    <div class="card launch-profiles-fallback-card">
      <h3>${escapeHtml(
        t('launchProfiles:fallback.title', { defaultValue: 'Wine Runner Fallback' })
      )}</h3>
      <p>${escapeHtml(
        t('launchProfiles:fallback.hint', {
          defaultValue:
            "Used when a profile's chosen runner is no longer installed. Leave empty to disable.",
        })
      )}</p>
      <div class="launch-profiles-fallback-row">
        <select id="fallback-runner-select">
          <option value="">${escapeHtml(
            t('launchProfiles:fallback.none', { defaultValue: '— none —' })
          )}</option>
          ${installedRunners
            .map(
              (name) =>
                `<option value="${escapeHtml(name)}"${
                  name === fallback ? ' selected' : ''
                }>${escapeHtml(name)}</option>`
            )
            .join('')}
        </select>
        ${
          fallback && !installedRunners.includes(fallback)
            ? `<span class="warning-pill">${escapeHtml(
                t('launchProfiles:fallback.notInstalled', {
                  defaultValue: 'Configured fallback is not installed',
                })
              )}: ${escapeHtml(fallback)}</span>`
            : ''
        }
      </div>
    </div>
  `;

  bindEvents();
}

function renderCard(profile, isActive, isOnly) {
  const body = profile.body || {};
  const runner = body.runner_name || '';
  const runnerInstalled = runner && installedRunners.includes(runner);
  const runnerWarning =
    runner && !runnerInstalled
      ? `<span class="warning-pill">${escapeHtml(
          t('launchProfiles:card.runnerNotInstalled', {
            defaultValue: 'Runner not installed',
          })
        )}</span>`
      : '';

  return `
    <div class="launch-profile-card${isActive ? ' active' : ''}" data-profile-id="${escapeHtml(profile.id)}">
      <div class="launch-profile-card-header">
        <h3 class="launch-profile-card-name" data-rename-target>
          ${isActive ? '★ ' : ''}${escapeHtml(profile.name)}
        </h3>
        ${
          isActive
            ? `<span class="profile-card-active-badge">${escapeHtml(
                t('launchProfiles:card.activeBadge', { defaultValue: 'Active' })
              )}</span>`
            : ''
        }
      </div>
      ${
        profile.description
          ? `<p class="launch-profile-card-description">${escapeHtml(profile.description)}</p>`
          : ''
      }
      <div class="launch-profile-card-meta">
        <div>
          <span class="meta-label">${escapeHtml(
            t('launchProfiles:card.runner', { defaultValue: 'Runner:' })
          )}</span>
          <span class="meta-value">${escapeHtml(runner || '—')}</span>
          ${runnerWarning}
        </div>
        <div>
          <span class="meta-label">${escapeHtml(
            t('launchProfiles:card.created', { defaultValue: 'Created:' })
          )}</span>
          <span class="meta-value">${escapeHtml((profile.created_at || '').slice(0, 10))}</span>
        </div>
        <div>
          <span class="meta-label">${escapeHtml(
            t('launchProfiles:card.updated', { defaultValue: 'Updated:' })
          )}</span>
          <span class="meta-value">${escapeHtml((profile.updated_at || '').slice(0, 10))}</span>
        </div>
      </div>
      <div class="launch-profile-card-actions">
        ${
          !isActive
            ? `<button class="btn btn-primary" data-action="set-active">${escapeHtml(
                t('launchProfiles:card.setActive', { defaultValue: 'Set Active' })
              )}</button>`
            : ''
        }
        <button class="btn" data-action="rename">${escapeHtml(
          t('launchProfiles:card.rename', { defaultValue: 'Rename' })
        )}</button>
        <button class="btn" data-action="edit-description">${escapeHtml(
          t('launchProfiles:card.editDescription', {
            defaultValue: 'Edit description',
          })
        )}</button>
        <button class="btn" data-action="duplicate">${escapeHtml(
          t('launchProfiles:card.duplicate', { defaultValue: 'Duplicate' })
        )}</button>
        <button
          class="btn btn-danger"
          data-action="delete"
          ${isActive || isOnly ? 'disabled' : ''}
          title="${
            isActive
              ? escapeHtml(
                  t('launchProfiles:card.cannotDeleteActive', {
                    defaultValue: 'Switch first to delete',
                  })
                )
              : isOnly
              ? escapeHtml(
                  t('launchProfiles:card.cannotDeleteLast', {
                    defaultValue: 'At least one profile is required',
                  })
                )
              : ''
          }"
        >${escapeHtml(t('launchProfiles:card.delete', { defaultValue: 'Delete' }))}</button>
      </div>
    </div>
  `;
}

// ── Events ─────────────────────────────────────────────────────────────

function bindEvents() {
  if (!activeContainer) return;
  const createBtn = activeContainer.querySelector('#btn-create-profile');
  if (createBtn) createBtn.addEventListener('click', handleCreate);

  activeContainer.querySelectorAll('.launch-profile-card').forEach((card) => {
    const id = card.dataset.profileId;
    card.querySelectorAll('button[data-action]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        handleCardAction(id, btn.dataset.action);
      });
    });
  });

  const fallbackSelect = activeContainer.querySelector('#fallback-runner-select');
  if (fallbackSelect) {
    fallbackSelect.addEventListener('change', async () => {
      const value = fallbackSelect.value || null;
      try {
        await invoke('set_fallback_runner', { runnerName: value });
      } catch (e) {
        alert(
          t('launchProfiles:error.setFallback', {
            defaultValue: 'Failed to set fallback runner: ',
          }) + String(e)
        );
      }
      await refresh();
    });
  }
}

async function handleCardAction(id, action) {
  const profile = (cachedConfig?.launch_profiles || []).find((p) => p.id === id);
  if (!profile) return;

  switch (action) {
    case 'set-active':
      await handleSetActive(profile);
      break;
    case 'rename':
      await handleRename(profile);
      break;
    case 'edit-description':
      await handleEditDescription(profile);
      break;
    case 'duplicate':
      await handleDuplicate(profile);
      break;
    case 'delete':
      await handleDelete(profile);
      break;
  }
}

async function handleCreate() {
  const name = window.prompt(
    t('launchProfiles:prompt.create', {
      defaultValue: "Name the new profile (saved from current launch settings):",
    })
  );
  if (!name || !name.trim()) return;
  try {
    await invoke('create_launch_profile', { name: name.trim() });
  } catch (e) {
    alert(
      t('launchProfiles:error.create', { defaultValue: 'Failed to create profile: ' }) +
        String(e)
    );
    return;
  }
  await refresh();
}

async function handleRename(profile) {
  const next = window.prompt(
    t('launchProfiles:prompt.rename', { defaultValue: 'New profile name:' }),
    profile.name
  );
  if (!next || !next.trim() || next.trim() === profile.name) return;
  try {
    await invoke('rename_launch_profile', { id: profile.id, newName: next.trim() });
  } catch (e) {
    alert(
      t('launchProfiles:error.rename', { defaultValue: 'Failed to rename: ' }) + String(e)
    );
    return;
  }
  await refresh();
}

async function handleEditDescription(profile) {
  const next = window.prompt(
    t('launchProfiles:prompt.description', {
      defaultValue: 'Description (leave empty to clear):',
    }),
    profile.description || ''
  );
  if (next === null) return; // cancelled
  try {
    await invoke('update_profile_description', {
      id: profile.id,
      description: next.trim() === '' ? null : next.trim(),
    });
  } catch (e) {
    alert(
      t('launchProfiles:error.description', {
        defaultValue: 'Failed to update description: ',
      }) + String(e)
    );
    return;
  }
  await refresh();
}

async function handleDuplicate(profile) {
  const suggested = `${profile.name} (copy)`;
  const newName = window.prompt(
    t('launchProfiles:prompt.duplicate', { defaultValue: 'Name for the duplicate:' }),
    suggested
  );
  if (!newName || !newName.trim()) return;
  try {
    await invoke('duplicate_launch_profile', {
      id: profile.id,
      newName: newName.trim(),
    });
  } catch (e) {
    alert(
      t('launchProfiles:error.duplicate', { defaultValue: 'Failed to duplicate: ' }) +
        String(e)
    );
    return;
  }
  await refresh();
}

async function handleDelete(profile) {
  const confirmed = window.confirm(
    t('launchProfiles:confirm.delete', {
      defaultValue: `Delete profile "${profile.name}"? This cannot be undone.`,
      name: profile.name,
    })
  );
  if (!confirmed) return;
  try {
    await invoke('delete_launch_profile', { id: profile.id });
  } catch (e) {
    alert(
      t('launchProfiles:error.delete', { defaultValue: 'Failed to delete: ' }) + String(e)
    );
    return;
  }
  await refresh();
}

async function handleSetActive(profile) {
  let force = false;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await invoke('switch_launch_profile', { id: profile.id, force });
      break;
    } catch (e) {
      const msg = String(e);
      if (!force && msg.startsWith('DIRTY:')) {
        const choice = window.confirm(
          t('launchProfiles:confirm.discardDirty', {
            defaultValue:
              'The active profile has unsaved changes. Discard them and switch?',
          })
        );
        if (!choice) return;
        force = true;
        continue;
      }
      alert(
        t('launchProfiles:error.switch', { defaultValue: 'Failed to switch: ' }) +
          msg
      );
      return;
    }
  }
  await refresh();
}

async function refresh() {
  await load();
  paint();
}
