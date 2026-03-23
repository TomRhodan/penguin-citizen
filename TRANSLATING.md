# Translating Penguin Citizen

Penguin Citizen uses [i18next](https://www.i18next.com/) for internationalization. Translations are stored as JSON files and bundled at build time.

## File Structure

```
src/locales/
  en/                    # English (source language, fallback)
    common.json          # Navigation, shared buttons, status words
    dashboard.json       # Dashboard page
    launch.json          # Launch page
    installation.json    # Installation wizard
    runners.json         # Wine Runners page
    environments.json    # Environments page (profiles, bindings, cfg, localization, storage)
    settings.json        # Settings page
    setup.json           # First-time setup wizard
    about.json           # About page
    dialogs.json         # Shared dialog defaults
  de/                    # German
    ... (same structure)
```

## Adding a New Language

1. Copy the `src/locales/en/` folder to `src/locales/{code}/` (e.g. `src/locales/fr/` for French)
2. Translate all values in the JSON files (keep the keys unchanged)
3. Add the language to `SUPPORTED_LANGUAGES` in `src/i18n.js`:
   ```js
   export const SUPPORTED_LANGUAGES = [
     { code: 'en', name: 'English' },
     { code: 'de', name: 'Deutsch' },
     { code: 'fr', name: 'Fran\u00e7ais' },  // <-- add here
   ];
   ```
4. Build and test

## JSON Format

Files use flat key-value pairs with dot notation for grouping:

```json
{
  "title": "Settings",
  "section.paths": "Paths",
  "label.baseDir": "Base Directory",
  "notification.saved": "Settings saved"
}
```

### Interpolation

Dynamic values use `{{variable}}` syntax:

```json
{
  "status.downloading": "Downloading... {{downloaded}} / {{total}}",
  "notification.installFailed": "Installation failed: {{error}}"
}
```

### Pluralization

i18next supports plural forms via `_one` / `_other` suffixed keys:

```json
{
  "notification.localizationUpdated_one": "{{count}} translation updated.",
  "notification.localizationUpdated_other": "{{count}} translations updated."
}
```

In code, pass `count` as an interpolation option: `t('launch:notification.localizationUpdated', { count: 3 })`. i18next automatically selects the correct plural form based on the language rules.

### Namespaces

Each JSON file is a namespace. In code, keys are referenced as `namespace:key`:
- `t('settings:title')` - reads from `settings.json`
- `t('common:nav.dashboard')` - reads from `common.json`

## Translation Guidelines

- Keep translations concise - UI space is limited
- Preserve `{{variable}}` placeholders exactly as they appear
- Do not translate technical terms (e.g. "Wine", "DXVK", "ESync", "FSync", "MangoHUD")
- Do not translate brand names (e.g. "Star Citizen", "RSI Launcher", "Penguin Citizen")
- HTML tags like `<strong>` in values must be preserved
- Test your translations in the app to check for text overflow
- Some strings use `data-i18n` attributes in `src/index.html` (sidebar navigation, window buttons) - these are translated at startup

**Note:** The USER.cfg settings panel (labels, descriptions, help texts for graphics/performance CVars) is not yet translatable. These are Star Citizen engine-specific CVar names and descriptions that remain in English.

## Language Detection

Penguin Citizen detects the language in this order:
1. Manual override in Settings (stored in `config.json` as `language`)
2. System locale (via `LANGUAGE`, `LC_MESSAGES`, or `LANG` environment variables)
3. English fallback

## Weblate Compatibility

The JSON format is compatible with [Weblate](https://weblate.org/) JSON format. If community translation volume grows, a Weblate instance can be connected directly to the `src/locales/` directory.

## Contributing

1. Fork the repository
2. Create or update translation files
3. Test with `npm run tauri dev`
4. Submit a Pull Request

Thank you for helping make Penguin Citizen accessible to more people!
