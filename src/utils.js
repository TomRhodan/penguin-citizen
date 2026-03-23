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
