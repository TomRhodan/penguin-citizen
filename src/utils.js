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
 * Escapes HTML special characters to prevent Cross-Site Scripting (XSS).
 *
 * Used wherever user input or backend data is inserted into HTML
 * (e.g. in dialogs, tables, tooltips). Also replaces line breaks
 * (both literal and escaped) with spaces so they don't interfere
 * in single-line contexts.
 *
 * @param {string} str - The string to escape.
 * @returns {string} The escaped string, safe for HTML output.
 */
export function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')       // & → &amp; (must be first)
    .replace(/</g, '&lt;')        // < → &lt;
    .replace(/>/g, '&gt;')        // > → &gt;
    .replace(/"/g, '&quot;')      // " → &quot;
    .replace(/'/g, '&#039;')      // ' → &#039;
    .replace(/\\n/g, ' ')         // Escaped line breaks (\n as literal) → spaces
    .replace(/\n/g, ' ');          // Actual line breaks → spaces
}

/**
 * Escapes a string for safe use in HTML attributes (prevents XSS).
 *
 * @param {string} str - The string to escape.
 * @returns {string} The escaped string, safe for HTML attribute output.
 */
export function escapeAttr(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Creates a debounced version of a function.
 * The function is only called after `delay` milliseconds of inactivity.
 *
 * @param {Function} fn - The function to debounce
 * @param {number} delay - Delay in milliseconds
 * @returns {Function & { flush: Function, cancel: Function }} Debounced function with flush() and cancel()
 */
export function debounce(fn, delay) {
  let timer = null;
  const debounced = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
  debounced.flush = () => {
    if (timer) {
      clearTimeout(timer);
      fn();
    }
  };
  debounced.cancel = () => clearTimeout(timer);
  return debounced;
}

/**
 * Builds a lookup of runner name -> origin label from a `scan_runners` result,
 * containing only the runners the system provides (CachyOS packages, Steam
 * compatibility tools). Runners installed by Penguin Citizen are absent.
 *
 * @param {Array<{name: string, system?: boolean, origin?: string}>} runners
 * @returns {Record<string, string>} Map of runner name to origin label
 */
export function buildRunnerOrigins(runners) {
  const origins = {};
  for (const runner of runners || []) {
    if (runner?.system && runner.name) {
      origins[runner.name] = runner.origin || 'System';
    }
  }
  return origins;
}

/**
 * Label for a runner in a dropdown: system runners carry their origin so a
 * package-provided build is distinguishable from one we installed.
 *
 * @param {string} name - Runner name
 * @param {Record<string, string>} origins - Map from `buildRunnerOrigins`
 * @returns {string} Plain-text label, still needs escaping for HTML output
 */
export function runnerOptionLabel(name, origins) {
  const origin = origins?.[name];
  return origin ? `${name} (${origin})` : name;
}
