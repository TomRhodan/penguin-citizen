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
 * Penguin Citizen - Internationalization (i18n) Module
 *
 * Provides translation support using i18next:
 * - Auto-detects system locale via Rust backend
 * - Manual language override via config
 * - English as fallback language
 * - Namespace-based translation files (per page)
 * - Static HTML translation via data-i18n attributes
 *
 * @module i18n
 */

import i18next from 'i18next';
import { invoke } from '@tauri-apps/api/core';

// Load all locale JSON files at build time via Vite's import.meta.glob
const localeModules = import.meta.glob('./locales/*/*.json', { eager: true });

/**
 * Parses the glob-imported locale modules into an i18next-compatible resource object.
 * Transforms paths like './locales/en/common.json' into { en: { common: { ... } } }.
 *
 * @returns {Object} i18next resources object
 */
function buildResources() {
  const resources = {};
  for (const [path, module] of Object.entries(localeModules)) {
    // path format: './locales/{lang}/{namespace}.json'
    const parts = path.replace('./locales/', '').replace('.json', '').split('/');
    if (parts.length !== 2) continue;
    const [lang, namespace] = parts;
    if (!resources[lang]) resources[lang] = {};
    resources[lang][namespace] = module.default || module;
  }
  return resources;
}

/** Supported languages for the language selector */
export const SUPPORTED_LANGUAGES = [
  { code: 'en', name: 'English' },
  { code: 'de', name: 'Deutsch' },
];

/**
 * Initializes the i18n system.
 * Detects language from config (manual override) or system locale,
 * falls back to English. Must be called before any t() usage.
 */
export async function initI18n() {
  let language = 'en';

  try {
    // Check for manual override in config
    const config = await invoke('load_config').catch(() => null);
    if (config?.language) {
      language = config.language;
    } else {
      // Auto-detect from system locale
      const systemLocale = await invoke('get_system_locale').catch(() => 'en');
      language = systemLocale;
    }
  } catch {
    // Fallback to English on any error
  }

  const resources = buildResources();

  // If detected language has no resources, fall back to English
  if (!resources[language]) {
    language = 'en';
  }

  await i18next.init({
    lng: language,
    fallbackLng: 'en',
    resources,
    ns: Object.keys(resources.en || {}),
    defaultNS: 'common',
    interpolation: {
      escapeValue: false,
    },
  });

  // Set HTML lang attribute
  document.documentElement.lang = language;
}

/**
 * Translates a key using i18next.
 * Supports namespaced keys like 'about:title' or 'common:save'.
 *
 * @param {string} key - Translation key (optionally namespaced with ':')
 * @param {Object} [options] - i18next interpolation options
 * @returns {string} Translated string
 */
export function t(key, options) {
  return i18next.t(key, options);
}

/**
 * Changes the active language and updates the HTML lang attribute.
 *
 * @param {string} lang - Language code (e.g. 'en', 'de')
 */
export async function changeLanguage(lang) {
  await i18next.changeLanguage(lang);
  // Use resolved language (i18next falls back to 'en' for unknown codes)
  document.documentElement.lang = i18next.language;
}

/**
 * Returns the current active language code.
 *
 * @returns {string} Current language code
 */
export function getCurrentLanguage() {
  return i18next.language;
}

/**
 * Translates all static HTML elements with data-i18n attributes.
 * Supports:
 * - data-i18n="key" - sets textContent
 * - data-i18n-attr="attribute:key" - sets a specific attribute (e.g. placeholder, title)
 */
export function translateStaticHtml() {
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n');
    if (key) {
      el.textContent = t(key);
    }
  });

  document.querySelectorAll('[data-i18n-attr]').forEach(el => {
    const spec = el.getAttribute('data-i18n-attr');
    if (!spec) return;
    // Format: "attribute:key" e.g. "placeholder:common:searchPlaceholder"
    const colonIndex = spec.indexOf(':');
    if (colonIndex === -1) return;
    const attr = spec.substring(0, colonIndex);
    const key = spec.substring(colonIndex + 1);
    el.setAttribute(attr, t(key));
  });
}
