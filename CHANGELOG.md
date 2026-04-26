# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.3] - 2026-04-26

### Added
- **Data.p4k recycling between environments** — New "Verschieben" (move) action alongside Symlink and Copy. The Storage tab on a populated environment now offers a "Data.p4k mit anderem Environment teilen" panel: pick a target env, then move/copy/symlink with a replace-existing confirmation when the target already has a Data.p4k. Same-filesystem moves use `fs::rename` (instant, atomic). Cross-filesystem moves fall back to copy+delete with progress events. Backed by a new `move_data_p4k` Tauri command and a `replace_existing` flag on `copy_data_p4k`/`link_data_p4k`. Useful for the Hotfix↔Live recycling workflow: minimize re-downloads when both channels share content.
- **Localization variants for rjcncpt German** — Two German entries instead of one: "Deutsch (Hybrid)" (mission titles in English) and "Deutsch+ (Volle Übersetzung)" (mission titles translated). The install modal lets you pick between the two and optionally enable Blueprint Integration.
- **Blueprint injection (experimental)** — Optional client-side merge of rjcncpt's `bp-contracts_short.json` into `global.ini`, prepending `[BP]` markers to mission titles and appending blueprint info blocks to descriptions. Opt-in via toggle in the install modal. Includes a hit-rate sanity check that warns after install when the BP data fits poorly with the installed SC build, plus a pre-check command to display the BP version.
- **HOTFIX support for rjcncpt translation** — German translation can now be installed on HOTFIX environments (treated as LIVE). Previously incorrectly blocked.
- **Tuning editor for joystick axes** — Restored the modal for configuring per-axis tuning (curve exponent, deadzone, saturation, invert) that was lost during the environments.js split in 0.5.1.
- **Helper scripts** — `dev.sh` (dev mode for UI iteration) and `sc.sh` (release build for actual SC launches; the Tauri dev build triggers EAC 70003).

### Changed
- **Localization sources** — Removed Dymerz/StarCitizen-Localization as a German source (no longer maintained). Dymerz remains for French, Spanish, Italian, and Portuguese.
- **Atomic write for `global.ini`** — Translation install now writes to `global.ini.tmp` and renames over the target, preventing the SC client from observing a half-written file during install.
- **`ScVersionInfo` extended** — Adds `data_p4k_size`, `data_p4k_mtime`, `data_p4k_is_symlink`, `data_p4k_symlink_target` so the Storage tab can show file sizes and symlink targets in the share-section dropdown.

### Fixed
- **Starten-page toggles not persisted** — Wayland, ESync, FSync, DXVK Async, MangoHUD, monitor selection, GPU device filter, and Gamescope sub-options now save to disk immediately on change. Previously, navigating away from the Starten page silently discarded toggle changes.
- **`link_data_p4k` invocation** — JS frontend was sending snake_case keys that Tauri 2's auto-conversion didn't accept, causing the Symlink button to fail with "missing required key srcVersion". Fixed to camelCase to match the convention used by the other p4k commands.

### Security
- **rustls-webpki bumped to 0.103.12** (RUSTSEC-2026-0098/0099) — Patches two advisories where name constraints were incorrectly accepted for URI names and certificates asserting a wildcard name.

## [0.5.2] - 2026-04-12

### Added
- **Shader cache management** — New dashboard widget shows shader cache sizes per installed SC version (LIVE, PTU, HOTFIX, EPTU), with one-click clearing for SC shader caches and DXVK pipeline caches. Caches are matched to the correct SC version via the `Branch` field from `build_manifest.id`.
- **Launch page shader warning** — Non-blocking yellow banner appears when the shader cache is missing, alerting that the next launch will take longer due to shader compilation.

## [0.5.1] - 2026-04-09

### Security
- **Config file permissions** — All config, cache, and window-state files are now written with `0o600` (owner-only) permissions instead of inheriting the default umask, preventing other users from reading the GitHub token.
- **Winetricks integrity verification** — Winetricks is now downloaded from a pinned release tag (`20250102`) instead of `master`, with SHA-256 hash verification before execution.
- **Double-launch guard** — `launch_game` now rejects concurrent launches, preventing orphaned Wine processes from a second click.
- **PID reuse protection** — `stop_game` verifies the process still exists via `/proc/{pid}/comm` before sending signals, and uses `libc::kill()` directly instead of spawning `Command::new("kill")`.
- **Stricter Wine PID verification** — Wine helper process termination now uses exact process name matching (`WINE_NAMES.contains()`) instead of substring `contains()`, preventing accidental kills of unrelated processes.
- **GitHub rate limit handling** — HTTP 403/429 responses from the GitHub API now show a clear message suggesting to add a token, instead of a generic error.
- **Async runtime safety** — `stop_game` replaced `std::thread::sleep` with `tokio::time::sleep` to avoid blocking the Tokio worker thread.
- **Mutex poisoning recovery** — All `GAME_PID` lock acquisitions now use `unwrap_or_else(|e| e.into_inner())` instead of silently ignoring lock failures.

### Fixed
- **Memory leak** — `Gilrs::new()` was called on every version switch, spawning udev/inotify threads that accumulated (90+ zombie threads, 200+ MB growth). Now uses a single shared Gilrs instance across all device queries and capture sessions.
- **Double render** — Each version switch triggered `renderEnvironments()` twice due to localization labels being unnecessarily reloaded. Eliminated by preserving game-wide data across version resets.
- **Tauri listener race conditions** — `listen()` subscriptions used fire-and-forget `.then()` patterns that raced with re-renders, causing duplicate IPC subscriptions. Replaced with synchronous `await`.
- **Event listener cleanup** — Added page lifecycle system to the router; each page now exports a `cleanup()` function called before navigation to release Tauri event subscriptions.
- **Silent error swallowing** — 30+ `.catch(() => null)` blocks now log to the backend debug.log via centralized error handler.
- **Dashboard cards** — Cards now grow with content at any UI scale instead of showing scrollbars.
- **PID validation** — Wine helper SIGTERM now verifies the process via `/proc/{pid}/comm` before killing, preventing accidental termination of unrelated processes after PID reuse.

### Added
- **AppError type system** — Structured error enum replacing ad-hoc `Result<T, String>` with typed variants (Io, Network, Config, Validation, etc.) and automatic `From` conversions.
- **Shared HTTP client** — Global `http_client()` with connection pooling replacing 10 separate `reqwest::Client` instances.
- **Network offline detection** — Dashboard shows a warning banner when disconnected and auto-reloads data on reconnect.
- **Setup wizard improvements** — Back button, debounced path validation on keystroke, hint explaining disabled Continue button.
- **Accessibility** — `:focus-visible` styles, `aria-label` on navigation, `aria-current="page"`, `aria-live` on content area, `role="dialog"` and `role="alert"` on modals/notifications.
- **Debounce utility** — Reusable `debounce()` function with `flush()` and `cancel()` methods.
- **Unit tests** — 22 new tests for util.rs and config.rs (21 → 43 total).

### Changed
- **Architecture: environments.js** (5,921 lines) split into 9 focused modules with central state store (`getState`/`setState`/`resetState`).
- **Architecture: sc_config.rs** (4,691 lines) split into 6 submodules (versions, bindings, profiles, p4k, localization).
- **Architecture: installer.rs** (1,810 lines) split into 4 submodules (launch, install, repair).
- **Architecture: pages.css** (8,247 lines) split into 9 per-page stylesheets.
- **Destructive actions** — App reset now shows explicit "cannot be undone" warning.
- **Debug logs** — Replaced `console.log('[DEBUG]...')` with `debugLog()` backend logging.

### Security
- **Archive bomb protection** — `safe_unpack()` enforces 50 GB extraction size limit.
- **Environment variable blocklist** — Extended with Wine/Proton internals (WINEPREFIX, WINEARCH, etc.) and XDG paths.
- **Content Security Policy** — Added CSP to `tauri.conf.json` restricting scripts, styles, and image origins.
- **XSS audit** — Verified `escapeHtml()` is used consistently across all innerHTML assignments.

## [0.5.0] - 2026-04-08

### Added
- **Unified Settings Routing** — Star Citizen settings are now routed to the correct config file based on whether they have an in-game menu equivalent. Settings like VSync, Quality, Motion Blur, and Resolution write to `attributes.xml` (synced with the game), while engine-only tweaks (threads, shaders, view distance) stay in `USER.cfg`. Eliminates the flip-flop where `USER.cfg` would override in-game changes on every restart.
- **Bidirectional Sync** — Detects in-game settings changes after game exit and shows a conflict resolution UI (keep ours / accept in-game per setting).
- **Per-Setting Badge** — Each setting now shows a badge (SC/CFG) indicating where it is stored.
- **TSR Dropdown** — `r.TSR` expanded from toggle to 3-option dropdown (Off / TSR / DLSS) matching the in-game Upscaling attribute.
- **Monitor Detection Cache** — Monitor detection results are cached across page navigations with a manual refresh button (↻) for re-detection.

### Changed
- Settings tab renamed from "USER.cfg" to "Settings" / "Einstellungen".
- Automatic migration: overlapping settings removed from `USER.cfg` on first Apply.
- Binding editor modal widened from 440 px to 540 px.

### Fixed
- **Server Status Display** — Replaced fragile RSS keyword-matching with the structured cState JSON API (`index.json`), which provides explicit per-component status. Adds "Maintenance" as a new status type with blue indicator. Previously, maintenance windows were never detected because incident titles didn't match component keywords.
- **Monitor Detection Timeout** — CLI tools (`kscreen-doctor`, `gnome-monitor-config`, `wlr-randr`, `xrandr`) now have a 5-second timeout to prevent hangs in sandboxed environments. Falls back to Tauri's built-in monitor API when all CLI tools fail.

### Security
- Devtools disabled in production builds.
- Path traversal protection added to `sc_base_dir()` via `validate_version()`.
- Custom env var keys re-validated at launch time, not only on save.
- Unused `zip` dependency removed to reduce attack surface.
- `Mutex .lock().unwrap()` replaced with proper error propagation in dashboard.
- `wine.parent().unwrap()` replaced with fallible error handling.
- `escapeAttr()` centralized in `utils.js`, removing duplicate from `dashboard.js`.
- `cargo audit` step added to CI pipeline.

## [0.4.9] - 2026-04-06

### Added
- **Launcher Repair** — One-click repair for broken RSI Launcher installations. Renames the Wine prefix, guides through a fresh installation wizard, and automatically restores Star Citizen game data from the backup. Includes backup management with size display and cleanup option on the dashboard.

## [0.4.8] - 2026-04-06

### Added
- **Advanced Launch Options** — GPU-aware start options sourced from the LUG wiki: NVIDIA DLSS 4.0, Smooth Motion, G-Sync; AMD radv_zero_vram and RADV nogttspill fixes; `--in-process-gpu` for black/white launcher window; Vulkan Mailbox Mode; HDR WSI Layer; CPU Topology; GPU device filter for hybrid systems.
- **Gamescope integration** — Full Gamescope compositor support with resolution, HDR, cursor grab, and keyboard grab options.
- **GameMode support** — `gamemoderun` launch prefix toggle.
- **GPU auto-detection** — Automatically detects NVIDIA/AMD/Intel GPU and greys out irrelevant options.

### Changed
- **Launch page redesign** — Compact launch bar replaces the large play button. Options organized in a collapsible 3-column card grid with active-option badges. Log output gets remaining space via flex-grow.

## [0.4.7] - 2026-03-30

### Fixed
- **Environments freeze on HOTFIX tab** — The page skeleton no longer blocks all interaction during loading. The version selector is rendered immediately from already-loaded data, and version-tab clicks are handled even while content is still fetching.
- **Copy modal invisible** — The Data.p4k copy progress modal was being added to the DOM but never shown because the required `.show` CSS class was missing from `modal-overlay`.
- **Spurious "No P4K" error on HOTFIX** — `get_profile_bindings` now returns empty bindings gracefully when a version has no `Data.p4k` (e.g. a freshly created empty environment with a previously saved profile), instead of propagating an error and logging noise on every page load.
- **Extra skeleton flash after version switch** — The localization-labels background callback no longer triggers a full re-render when there are no bindings to display with the new labels.
- **Unsaved USER.cfg changes silently discarded** — Version-card click listeners attached during the skeleton loading phase now include the unsaved-changes confirmation dialog, matching the behavior of the full post-render listeners.
- **Panic on malformed master bindings** — `get_profile_bindings` now returns a clean error instead of panicking when `defaultprofile.xml` in `Data.p4k` parses to zero profiles.

### Changed
- **Redundant double data-loading removed** — The version card click handler no longer pre-loads all data before calling `renderEnvironments`; the render function handles the load itself, halving the number of backend calls per tab switch.
- **Profile-tab switches are now instant** — Switching between Profile / UserCfg / Localization / Storage tabs uses `rerenderFromState()` (synchronous, no skeleton, no backend calls) instead of a full async `renderEnvironments`.
- **Log noise reduced** — File logger (`debug.log`) is now at Info level. Terminal logger suppresses `reqwest::connect`, `reqwest::async_impl::client`, `gilrs_core`, and `gilrs::gamepad` debug spam while preserving warn/error output from all modules. Binding-capture `[CAPTURE]` messages downgraded to trace.
- **`detect_sc_versions` debug logging removed** — The function previously emitted 9+ lines per call on every page render; all intermediate debug lines removed.

### Added
- **`penguin-citizen-helper.exe` documented** — `CONTRIBUTING.md` now explains what the Wine DirectInput helper is, why it must be committed to the repository (CI cannot cross-compile it), and how to rebuild it after changes to `dinput_helper.c`. `README.md` mentions the helper in the Controller & Bindings feature description. The release workflow (`release.yml`) now fails fast with a clear message if the binary is missing.

## [0.4.6] - 2026-03-28

### Added
- **Mouse Binding Dialog** — Dedicated static-selection dialog for mouse inputs instead of live capture. Clicking a Mouse column cell opens a 3-column dialog (Axes / Scroll Wheels / Buttons) with all 11 SC-compatible mouse inputs. Save/Reset/Cancel work via the same Tauri commands as the existing binding editor.

### Fixed
- Tuning button (^) no longer appears on mouse axis bindings (mouse devices have no tuning data in SC profiles).

## [0.4.5] - 2026-03-27

## [0.4.0] - 2026-03-18

### Added
- **Internationalization (i18n)** - Full localization system using i18next with English and German support. All ~880 UI strings across the app are now translatable.
- **Language Selector** - New dropdown in Settings to switch the UI language instantly. Supports "Auto (System)" detection and manual override.
- **System Locale Detection** - New `get_system_locale` Rust command reads LANGUAGE/LC_MESSAGES/LANG environment variables to auto-detect the user's preferred language.
- **Translation Guide** - New `TRANSLATING.md` with step-by-step instructions for community translators. Weblate-compatible JSON format.
- **Locale Files** - 10 namespace files per language (common, dashboard, launch, installation, runners, environments, settings, setup, about, dialogs) in `src/locales/{lang}/`.

### Changed
- Static HTML elements (sidebar navigation, window buttons) now use `data-i18n` attributes for translation at startup.
- Module-level constants with UI strings (`LAUNCH_OPTIONS`, `CHECK_ITEMS`, `INSTALL_PHASES`, `QUALITY_LEVELS`, `SHADER_LEVELS`) converted to functions for deferred translation resolution.
- USER.cfg dropdown labels (Window Mode, Renderer, SSDO, Motion Blur) are now translatable via locale keys.
- `AppConfig` extended with optional `language` field (backward-compatible via serde default).

## [0.3.6] - 2026-03-17

### Fixed
- AppImage-safe folder opening using D-Bus XDG Portal with fallback to xdg-open.
- Browser launch in new window mode to prevent blocking the main app.

## [0.3.5] - 2026-03-16

### Fixed
- Set CLOEXEC on all inherited fds (3-1023) at startup, not just fd 1023, to prevent any child process from keeping the AppImage FUSE mount busy.
- Use `_exit()` instead of `exit()` to bypass GTK/WebKitGTK atexit handlers that can deadlock during shutdown.

## [0.3.4] - 2026-03-16

### Fixed
- AppImage FUSE keepalive fd marked CLOEXEC at startup so child processes (wine, wineserver) never inherit it, ensuring clean exit.

## [0.3.3] - 2026-03-16

### Fixed
- UI scale slider now uses pixel-based font sizing instead of percentage, fixing the bug where 90% made the UI larger instead of smaller.
- All CSS font sizes converted from px to rem so UI scale setting affects all text uniformly.
- Removed hard 1280x900 window size clamp that prevented saving larger window sizes; now clamps only to monitor bounds.
- XWayland/AppImage font size compensation so that 100% UI scale matches native Wayland appearance.
- AppImage process no longer lingers after closing the window (close fd 1023 to signal the FUSE daemon).
- Clean shutdown of all child processes (game, wineserver) when the app is closed.

## [0.3.1] - 2026-03-15

### Added
- Integrated automated screenshot bot for website and documentation assets.
- New Rust command for system-level window capture supporting multiple Linux backends (KDE, GNOME, Wayland).

### Fixed
- Improved external link robustness in AppImage builds via D-Bus XDG Portal escape.
- Removed various compiler warnings and deprecated API usage in the backend.

## [0.3.0] - 2026-03-15

### Added
- Robust external link handling for AppImage via D-Bus XDG Desktop Portal escape.

### Changed
- Refactored `openUrl` to a custom Rust-based `open_browser` command for increased reliability in sandboxed environments.
- Version bump to v0.3.0.

## [0.2.6] - 2026-03-14

### Fixed
- Built-in `xdg-open` handling in AppImage.

## [0.2.4] - 2026-03-14

### Fixed
- **RSI Launcher in AppImage** - Fixed RSI Launcher window not appearing in AppImage builds by setting LD_LIBRARY_PATH with system paths first for Vulkan, and adding XDG_RUNTIME_DIR fallback for X11/Wayland connections

### Changed
- Version bump to v0.2.4

## [0.2.1] - 2026-03-12

### Changed
- Version bump to v0.2.1

## [0.2.0] - 2026-03-11

### Added
- **Multi-Device Bindings** - New "+" button on keybindings to add bindings for additional devices (e.g., add a joystick binding alongside an existing keyboard binding)
- **Auto-Select New Profile** - Newly created profiles are now immediately set as the active profile

### Fixed
- **Binding Editor Dialog** - Fixed invisible binding editor modal (missing `.show` class for CSS opacity transition)
- **Remove Binding** - Removing a binding no longer deletes all bindings for that action; only the specific device binding is removed
- **Version Selector Highlight** - Active version card now uses a visible cyan accent instead of blending into the background

### Changed
- **Device Reordering** - Swap logic now operates on profile backups instead of live SC files, scoped by device type
- **Version Selector** - Improved empty state detection

## [0.1.9] - 2026-03-08

### Added
- **Environment Management** - Renamed "Profiles" page to "Environments" to better reflect its role in managing game versions, storage, and settings
- **Empty State UI** - New setup screen for missing versions with options to "Create Folder", "Symlink Data.p4k" (space-saving), or "Copy Data.p4k"
- **Git-style Profile Actions** - Added "Update Profile" (save current game files back to profile) and "Revert" (discard local game changes) buttons to the active profile header
- **Environment Deletion** - Safe deletion of Star Citizen version folders with safety whitelist

### Fixed
- **Profile Metadata Error** - Fixed path logic in profile update command
- **Character File Backup** - Profile updates now correctly include `.chf` character files
- **UI Consistency** - Segmented control styling for version selector and underlined tabs for better visual hierarchy

## [0.1.8] - 2026-03-07

### Changed
- **Data.p4k Copy Buffer** - Increased from 1MB to 8MB for faster copy speeds on SSDs

### Added
- **Data.p4k Copy Progress Modal** - Shows progress, speed, and ETA during copy operation

### Fixed
- Improved UI padding for profile cards and footer

## [0.1.7] - 2026-03-05

### Changed
- **Unified Binding System** - Merged Controller tab into Profiles; bindings are now managed directly within saved profiles
- **Import from Version** - Non-destructive import that creates a saved profile instead of overwriting SC files
- **Profile Cards** - Wider card layout (340px min) so profile names are fully readable
- **Contextual Hints** - Dismissible guidance hints for profiles, bindings, and devices sections

### Added
- Profile-scoped binding commands (get/assign/remove bindings per profile)
- Cross-version profile import with saved profile selection
- Device name resolution in binding list via device map

### Removed
- Separate Controller tab and binding_database system
- Direct SC file overwrite on cross-version import

### Fixed
- Launch page log output formatting (no longer collapsed into single line)

## [0.1.6] - 2026-03-03

### Changed
- **Launch Page** - Separated Wayland into a dedicated experimental section with clearer documentation

### Fixed
- **Device Identity** - Corrected device identity resolution to properly match controllers using product name instead of instance numbers
- **Binding UI** - Improved binding display and interaction on the Controllers page

## [0.1.5] - 2026-03-02

### Fixed
- **Binding Export** - Fixed v_pitch and other bindings not appearing in exported actionmaps.xml when they didn't exist in the original SC bindings
- **Device Instance Mapping** - Fixed bindings being exported to wrong joystick instances by properly matching devices via product name and GUID

### Added
- **Device Reconciliation** - New "Reconcile Devices" button on Profiles page that syncs device instances with current SC actionmaps.xml configuration. This handles cases where device order changes (e.g., input-remapper changes joystick assignments)

## [0.1.4] - 2026-03-02

### Changed
- **Controllers Page** - Separated controller and binding management into a dedicated "Controllers" page accessible from the sidebar. The Profiles page now focuses on backups and USER.cfg settings only.

## [0.1.3] - 2026-02-22

### Added
- **Quick Install Detection** - Automatically detects existing RSI Launcher installations and offers Quick Install (skip RSI Launcher download) or Full Reinstall options
- **Launch Log Transfer** - Installation logs are now displayed on the Launch page when navigating from installation completion
- **Dynamic Runner Sources** - Installation page now dynamically loads runner sources from LUG-Helper and displays tabs based on configured sources
- **Loading State** - Added loading spinner while fetching available Wine runners

## [0.1.2] - 2026-02-21

### Added
- Version bump to v0.1.2

## [0.1.1] - 2026-02-21

### Added
- **Fractional Scaling Support** - Window size and position now adapt correctly when moving between monitors with different DPI scaling (e.g., 100% ↔ 150%)
- **Wine Runner Sources** - Added LUG Experimental to available Wine runner sources
- **Wine Shell** - New prefix tool to launch a Wine command prompt in a terminal
- **About Page** - New About page with version info, links, and credits

### Updated
- Screenshots for dashboard, launch, wine runners, profiles, and about pages
- Default Wine runner sources configuration

## [0.1.0] - 2026-02-20

### Added
- **Command Center** - Live dashboard with RSI news, server status, and community funding stats
- **Installation Wizard** - System compatibility check, automated Wine prefix setup, and RSI Launcher installation
- **Launch Manager** - One-click launch with configurable performance options (ESync, FSync, DXVK Async, Wayland, HDR, FSR, MangoHUD)
- **Wine Runner Management** - Download and manage Wine/Proton runners from multiple community sources (LUG, Kron4ek, RawFox, Mactan)
- **DXVK Management** - Install and update DXVK versions with automatic DLL deployment
- **Profile Management** - Backup and restore Star Citizen profiles (actionmaps.xml, attributes.xml, USER.cfg)
- **Controller Configuration** - View connected devices, keybindings, and reorder joystick instances
- **USER.cfg Editor** - Visual editor for all Star Citizen graphics, performance, and quality settings
- **Localization** - Install community translations with one click, with automatic update detection
- **Prefix Tools** - Winecfg, DPI scaling, PowerShell installation via winetricks
- **Multi-version Support** - Manage LIVE, PTU, EPTU, and other Star Citizen channels

[0.5.3]: https://github.com/TomRhodan/penguin-citizen/compare/v0.5.2-0...v0.5.3-0
[0.5.2]: https://github.com/TomRhodan/penguin-citizen/compare/v0.5.1-0...v0.5.2-0
[0.5.1]: https://github.com/TomRhodan/penguin-citizen/compare/v0.5.0-2...v0.5.1
[0.5.0]: https://github.com/TomRhodan/penguin-citizen/compare/v0.4.9-0...v0.5.0-2
[0.4.9]: https://github.com/TomRhodan/penguin-citizen/compare/v0.4.8-0...v0.4.9-0
[0.4.8]: https://github.com/TomRhodan/penguin-citizen/compare/v0.4.7-1...v0.4.8-0
[0.4.7]: https://github.com/TomRhodan/penguin-citizen/compare/v0.4.6...v0.4.7-1
[0.4.6]: https://github.com/TomRhodan/penguin-citizen/compare/v0.4.5...v0.4.6
[0.4.5]: https://github.com/TomRhodan/penguin-citizen/compare/v0.4.0...v0.4.5
[0.4.0]: https://github.com/TomRhodan/penguin-citizen/compare/v0.3.6...v0.4.0
[0.3.6]: https://github.com/TomRhodan/penguin-citizen/compare/v0.3.5...v0.3.6
[0.3.5]: https://github.com/TomRhodan/penguin-citizen/compare/v0.3.4...v0.3.5
[0.3.4]: https://github.com/TomRhodan/penguin-citizen/compare/v0.3.3...v0.3.4
[0.3.3]: https://github.com/TomRhodan/penguin-citizen/compare/v0.3.2...v0.3.3
[0.3.2]: https://github.com/TomRhodan/penguin-citizen/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/TomRhodan/penguin-citizen/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/TomRhodan/penguin-citizen/compare/v0.2.6...v0.3.0
[0.2.6]: https://github.com/TomRhodan/penguin-citizen/compare/v0.2.4...v0.2.6
[0.2.4]: https://github.com/TomRhodan/penguin-citizen/compare/v0.2.1...v0.2.4
[0.2.1]: https://github.com/TomRhodan/penguin-citizen/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/TomRhodan/penguin-citizen/compare/v0.1.9...v0.2.0
[0.1.9]: https://github.com/TomRhodan/penguin-citizen/compare/v0.1.8...v0.1.9
[0.1.8]: https://github.com/TomRhodan/penguin-citizen/compare/v0.1.7...v0.1.8
[0.1.7]: https://github.com/TomRhodan/penguin-citizen/compare/v0.1.6...v0.1.7
[0.1.6]: https://github.com/TomRhodan/penguin-citizen/compare/v0.1.5...v0.1.6
[0.1.5]: https://github.com/TomRhodan/penguin-citizen/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/TomRhodan/penguin-citizen/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/TomRhodan/penguin-citizen/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/TomRhodan/penguin-citizen/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/TomRhodan/penguin-citizen/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/TomRhodan/penguin-citizen/releases/tag/v0.1.0
