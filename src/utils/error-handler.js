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
 * Centralized error handling utilities.
 *
 * Provides consistent logging and user notification for errors across the app.
 * All errors are forwarded to the backend's debug.log via the app_log command.
 *
 * @module utils/error-handler
 */

import { invoke } from '@tauri-apps/api/core';
import { showNotification } from './dialogs.js';

/**
 * Logs an error to the backend debug.log without showing a notification.
 * Use for non-critical failures where the user doesn't need to know.
 *
 * @param {*} err - The error object or string
 * @param {string} context - Short description of what was attempted (e.g. "load_config")
 */
export function logError(err, context) {
  const message = `[${context}] ${String(err)}`;
  invoke('app_log', { level: 'error', category: 'frontend', message }).catch(() => {});
}

/**
 * Logs an error and shows a user-facing notification.
 * Use for failures that affect displayed data or user-visible operations.
 *
 * @param {*} err - The error object or string
 * @param {string} context - Short description of what was attempted
 * @param {string} [userMessage] - Optional user-friendly message. If omitted, context is used.
 */
export function notifyError(err, context, userMessage) {
  logError(err, context);
  showNotification(userMessage || context, 'error');
}

/**
 * Creates a catch handler that logs the error silently.
 * Shorthand for `.catch(err => logError(err, context))`.
 *
 * @param {string} context - Short description of what was attempted
 * @returns {function} A catch handler function
 */
export function silentCatch(context) {
  return (err) => logError(err, context);
}
