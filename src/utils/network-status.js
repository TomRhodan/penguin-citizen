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
 * Network status detection utility.
 *
 * Monitors internet connectivity and notifies listeners when the status changes.
 * Uses the browser's navigator.onLine API supplemented by periodic connectivity
 * checks to detect when the connection is restored.
 *
 * @module utils/network-status
 */

/** @type {boolean} Current online status */
let isOnline = navigator.onLine;

/** @type {Set<Function>} Registered status change listeners */
const listeners = new Set();

/** @type {number|null} Polling interval ID for re-checking when offline */
let pollTimer = null;

/**
 * Returns the current network status.
 * @returns {boolean} true if online
 */
export function getNetworkStatus() {
  return isOnline;
}

/**
 * Registers a listener for network status changes.
 * The listener is called with `true` (online) or `false` (offline).
 *
 * @param {Function} fn - Callback: (online: boolean) => void
 * @returns {Function} Unsubscribe function
 */
export function onNetworkChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function notifyListeners(online) {
  if (online === isOnline) return;
  isOnline = online;
  for (const fn of listeners) {
    try { fn(online); } catch (_) { /* listener error must not break others */ }
  }
}

// Browser events for immediate detection
window.addEventListener('online', () => {
  stopPolling();
  notifyListeners(true);
});

window.addEventListener('offline', () => {
  notifyListeners(false);
  startPolling();
});

/**
 * When offline, poll periodically to detect reconnection faster than
 * the browser's native 'online' event (which can be slow or unreliable).
 */
function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(async () => {
    try {
      // HEAD request to a fast, reliable endpoint
      const resp = await fetch('https://api.github.com', {
        method: 'HEAD',
        mode: 'no-cors',
        cache: 'no-store',
      });
      // If fetch succeeds, we're back online
      stopPolling();
      notifyListeners(true);
    } catch (_) {
      // Still offline
    }
  }, 15000); // Check every 15 seconds
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

// Start polling if we begin offline
if (!isOnline) startPolling();
