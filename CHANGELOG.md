# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
