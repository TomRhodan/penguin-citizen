/*
 * Penguin Citizen - Star Citizen Linux Manager
 * Copyright (C) 2024-2026 TomRhodan <tomrhodan@gmail.com>
 * Licensed under GPL-3.0-or-later
 */

/**
 * Shared utilities for the Environments page modules.
 *
 * Contains debug logging, contextual hints, and formatting helpers
 * used across multiple environment sub-modules.
 *
 * @module pages/environments/utils
 */

import { invoke } from '@tauri-apps/api/core';
import { t } from '../../i18n.js';

// ── Debug Logging ──

/**
 * Centralized debug logging function.
 * Logs to both console and to file via Rust backend.
 * @param {string} category - Log category (e.g., 'BINDING', 'CAPTURE', 'UI')
 * @param {string} level - Log level: 'debug', 'info', 'warn', 'error'
 * @param {string} message - Log message
 */
export function debugLog(category, level, message) {
  const prefix = `[${category}]`;
  switch (level) {
    case 'error': console.error(prefix, message); break;
    case 'warn':  console.warn(prefix, message); break;
    case 'info':  console.info(prefix, message); break;
    default:      console.log(prefix, message);
  }
  invoke('app_log', { level, category, message }).catch(() => {});
}

// ── Contextual Hints ──

/**
 * Reads the IDs of already dismissed hints from localStorage.
 * @returns {string[]} Array of dismissed hint IDs
 */
export function getDismissedHints() {
  try {
    return JSON.parse(localStorage.getItem('penguincitizen-dismissed-hints') || '[]');
  } catch { return []; }
}

/**
 * Permanently dismisses a hint and saves the decision in localStorage.
 * @param {string} id - Unique identifier of the hint to dismiss
 */
export function dismissHint(id) {
  const dismissed = getDismissedHints();
  if (!dismissed.includes(id)) {
    dismissed.push(id);
    localStorage.setItem('penguincitizen-dismissed-hints', JSON.stringify(dismissed));
  }
  const el = document.querySelector(`.hint-banner[data-hint-id="${id}"]`);
  if (el) el.remove();
}

/**
 * Renders a dismissible hint banner.
 * @param {string} id - Unique ID of the hint
 * @param {string} html - HTML content of the hint text
 * @returns {string} HTML string of the banner or empty string if dismissed
 */
export function renderHint(id, html) {
  if (getDismissedHints().includes(id)) return '';
  return `
    <div class="hint-banner" data-hint-id="${id}">
      <svg class="hint-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <circle cx="12" cy="12" r="10"></circle>
        <line x1="12" y1="16" x2="12" y2="12"></line>
        <line x1="12" y1="8" x2="12.01" y2="8"></line>
      </svg>
      <span class="hint-text">${html}</span>
      <button class="hint-dismiss" data-action="dismiss-hint" data-hint-id="${id}">${t('environments:hint.gotIt')}</button>
    </div>
  `;
}

// ── Formatting Helpers ──

/**
 * Formats bytes to human-readable file size.
 * @param {number} bytes
 * @returns {string} e.g., "4.2 GB"
 */
export function formatFileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(1)} MB`;
  return `${(bytes / 1073741824).toFixed(1)} GB`;
}

/**
 * Formats ISO date string to localized display format.
 * @param {string} dateStr - ISO date string
 * @returns {string} Formatted date
 */
export function formatCommitDate(dateStr) {
  if (!dateStr) return '—';
  try {
    const d = new Date(dateStr);
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  } catch { return dateStr; }
}

/**
 * Converts a category key to a human-readable label.
 * @param {string} key - Category key (e.g., 'spaceship_movement')
 * @returns {string} Human-readable label
 */
export function formatCategoryName(key) {
  return key
    .replace(/_/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());
}
