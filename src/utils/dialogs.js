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
 * Penguin Citizen - Custom Dialog Helper Functions
 *
 * Provides visually integrated replacement dialogs for native browser/Tauri dialogs.
 * All dialogs use a consistent modal design with overlay, animation,
 * and keyboard support (Escape to close, Enter to confirm).
 */

import { escapeHtml } from '../utils.js';
import { t } from '../i18n.js';

/**
 * Displays a custom confirmation dialog.
 *
 * Replaces the native `confirm()` dialog with a styled modal featuring
 * a configurable title, icon type, and button labels.
 * The modal can be dismissed by clicking the background overlay or
 * pressing the Escape key.
 *
 * @param {string} message - The message to display.
 * @param {Object} [options] - Configuration options.
 * @param {string} [options.title='Confirm'] - Modal title.
 * @param {string} [options.kind='info'] - Dialog type: 'info', 'warning', or 'danger'.
 * @param {string} [options.okLabel='Confirm'] - OK button label.
 * @param {string} [options.cancelLabel='Cancel'] - Cancel button label.
 * @returns {Promise<boolean>} Returns true on confirmation, false on cancel.
 */
export function confirm(message, options = {}) {
  const {
    title = t('dialogs:confirm.defaultTitle'),
    kind = 'info',
    okLabel = t('dialogs:confirm.defaultOk'),
    cancelLabel = t('dialogs:confirm.defaultCancel')
  } = options;

  return new Promise((resolve) => {
    // Create modal overlay (semi-transparent background)
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';

    // Select icon based on dialog type:
    // - warning/danger: triangle warning symbol
    // - info: circle with i symbol
    let icon = '';
    if (kind === 'warning' || kind === 'danger') {
      icon = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="modal-icon-${kind}"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`;
    } else {
      icon = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="modal-icon-info"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>`;
    }

    // Build modal HTML: header with icon+title, body with message, footer with buttons
    // For 'danger' type, the OK button is colored red (btn-danger)
    overlay.innerHTML = `
      <div class="modal-container modal-kind-${kind}">
        <div class="modal-header">
          <div class="modal-title-wrap">
            ${icon}
            <h3>${escapeHtml(title)}</h3>
          </div>
        </div>
        <div class="modal-body">
          <p>${escapeHtml(message).replace(/\n/g, '<br>')}</p>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" id="modal-cancel">${escapeHtml(cancelLabel)}</button>
          <button class="btn ${kind === 'danger' ? 'btn-danger' : 'btn-primary'}" id="modal-ok">${escapeHtml(okLabel)}</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    // Fade-in animation: add CSS class in the next frame
    // so the browser renders the initial state first
    requestAnimationFrame(() => {
      overlay.classList.add('show');
    });

    /**
     * Cleanup: fades out the modal and removes it from the DOM after
     * the fade-out animation (200ms). Resolves the promise.
     */
    const cleanup = (result) => {
      overlay.classList.remove('show');
      setTimeout(() => {
        overlay.remove();
        resolve(result);
      }, 200);
    };

    // Button event handlers
    overlay.querySelector('#modal-cancel').addEventListener('click', () => cleanup(false));
    overlay.querySelector('#modal-ok').addEventListener('click', () => cleanup(true));

    // Clicking the overlay background closes the dialog (= cancel)
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) cleanup(false);
    });

    // Escape key to cancel the dialog
    const handleEscape = (e) => {
      if (e.key === 'Escape') {
        window.removeEventListener('keydown', handleEscape);
        cleanup(false);
      }
    };
    window.addEventListener('keydown', handleEscape);
  });
}

/**
 * Displays a custom input dialog with a text field.
 *
 * Replaces the native `prompt()` dialog with a styled modal.
 * The input field is automatically focused and the default value
 * is pre-selected. Enter confirms the input, Escape cancels.
 *
 * @param {string} message - The message to display.
 * @param {Object} [options] - Configuration options.
 * @param {string} [options.title='Input'] - Modal title.
 * @param {string} [options.defaultValue=''] - Pre-filled default value.
 * @param {string} [options.placeholder=''] - Placeholder text in the input field.
 * @param {string} [options.okLabel='OK'] - OK button label.
 * @param {string} [options.cancelLabel='Cancel'] - Cancel button label.
 * @returns {Promise<string|null>} Returns the entered value, or null on cancel.
 */
export function prompt(message, options = {}) {
  const {
    title = t('dialogs:prompt.defaultTitle'),
    defaultValue = '',
    placeholder = '',
    okLabel = t('dialogs:prompt.defaultOk'),
    cancelLabel = t('dialogs:prompt.defaultCancel')
  } = options;

  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';

    // Info icon for input dialogs (always info type)
    const icon = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="modal-icon-info"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>`;

    // Modal HTML with input field in the body area
    overlay.innerHTML = `
      <div class="modal-container modal-kind-info">
        <div class="modal-header">
          <div class="modal-title-wrap">
            ${icon}
            <h3>${escapeHtml(title)}</h3>
          </div>
        </div>
        <div class="modal-body">
          <p>${escapeHtml(message).replace(/\n/g, '<br>')}</p>
          <input type="text" class="input modal-prompt-input" id="modal-prompt-input"
                 value="${escapeHtml(defaultValue)}" placeholder="${escapeHtml(placeholder)}"
                 style="width: 100%; margin-top: 8px;" />
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" id="modal-cancel">${escapeHtml(cancelLabel)}</button>
          <button class="btn btn-primary" id="modal-ok">${escapeHtml(okLabel)}</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    const input = overlay.querySelector('#modal-prompt-input');

    // Fade in and focus input field + pre-select text
    requestAnimationFrame(() => {
      overlay.classList.add('show');
      input.focus();
      input.select();
    });

    /** Cleanup with fade-out animation and promise resolution */
    const cleanup = (result) => {
      overlay.classList.remove('show');
      setTimeout(() => {
        overlay.remove();
        resolve(result);
      }, 200);
    };

    // Cancel returns null, OK returns the current input value
    overlay.querySelector('#modal-cancel').addEventListener('click', () => cleanup(null));
    overlay.querySelector('#modal-ok').addEventListener('click', () => cleanup(input.value));

    // Enter key in the input field confirms the input
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') cleanup(input.value);
    });

    // Click on overlay background = cancel
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) cleanup(null);
    });

    // Escape key = cancel
    const handleEscape = (e) => {
      if (e.key === 'Escape') {
        window.removeEventListener('keydown', handleEscape);
        cleanup(null);
      }
    };
    window.addEventListener('keydown', handleEscape);
  });
}

/**
 * Displays a file diff dialog with unified diff lines.
 *
 * Shows differences between two file versions in a clear view,
 * similar to Git diff tools. Each line is color-highlighted:
 * green for additions, red for removals.
 * Line numbers for the old and new versions are displayed in
 * separate gutter columns.
 *
 * @param {string} title - Dialog title (typically the file name).
 * @param {Array<{line_type: string, old_line_no: number|null, new_line_no: number|null, content: string}>} lines - Diff lines from the backend.
 * @returns {Promise<void>} Resolves when the dialog is closed.
 */
export function showDiff(title, lines) {
  return new Promise((resolve) => {
    // Guard against double closing (e.g. Escape + click simultaneously)
    let closed = false;
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';

    // Document icon for the diff dialog
    const icon = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="modal-icon-info"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>`;

    // X icon for the close button in the top right
    const closeIcon = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;

    // Build diff HTML: either empty display or line-by-line rendering
    let diffHtml;
    if (lines.length === 0) {
      diffHtml = `<div class="diff-empty">${t('dialogs:diff.noChanges')}</div>`;
    } else {
      // Each diff line consists of: old line number | new line number | content
      // line_type determines the color: 'add' = green, 'remove' = red, 'context' = neutral
      diffHtml = lines.map(l => {
        // Line numbers: null means the line does not exist in this version
        const oldNo = l.old_line_no != null ? l.old_line_no : '';
        const newNo = l.new_line_no != null ? l.new_line_no : '';
        const typeClass = `diff-line-${l.line_type}`;
        const contentClass = l.line_type === 'add' ? ' diff-content-add' : l.line_type === 'remove' ? ' diff-content-remove' : '';
        // Prefix character: + for additions, - (minus) for removals, space for context
        const prefix = l.line_type === 'add' ? '+' : l.line_type === 'remove' ? '\u2212' : ' ';
        return `<div class="diff-line ${typeClass}"><span class="diff-gutter">${oldNo}</span><span class="diff-gutter">${newNo}</span><span class="diff-content${contentClass}">${prefix} ${escapeHtml(l.content)}</span></div>`;
      }).join('');
    }

    // Wider modal (modal-wide) for better readability of diff content
    // No footer with buttons - only a close button in the header
    overlay.innerHTML = `
      <div class="modal-container modal-wide modal-kind-info">
        <div class="modal-header">
          <div class="modal-title-wrap">
            ${icon}
            <h3>${escapeHtml(title)}</h3>
          </div>
          <button class="btn btn-ghost btn-sm modal-close-btn" id="modal-close">${closeIcon}</button>
        </div>
        <div class="modal-body">
          <div class="diff-container">${diffHtml}</div>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    // Start fade-in animation
    requestAnimationFrame(() => {
      overlay.classList.add('show');
    });

    /**
     * Cleanup: closes the dialog with a fade-out animation.
     * The `closed` flag prevents double triggering from simultaneous events.
     */
    const cleanup = () => {
      if (closed) return;
      closed = true;
      window.removeEventListener('keydown', handleEscape);
      overlay.classList.remove('show');
      setTimeout(() => {
        overlay.remove();
        resolve();
      }, 200);
    };

    // Close button in the top right of the header
    overlay.querySelector('#modal-close').addEventListener('click', () => cleanup());

    // Click on overlay background closes the dialog
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) cleanup();
    });

    // Escape key closes the dialog
    const handleEscape = (e) => {
      if (e.key === 'Escape') cleanup();
    };
    window.addEventListener('keydown', handleEscape);
  });
}
