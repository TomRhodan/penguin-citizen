# Contributing to Penguin Citizen

Thank you for your interest in contributing to Penguin Citizen, a Linux desktop application for managing Star Citizen installations. This guide will help you get started.

## Prerequisites

- **Rust toolchain** (stable): Install via [rustup](https://rustup.rs/)
- **Node.js** (v18+) and npm
- **Tauri system dependencies** for Linux:

```bash
# Debian/Ubuntu
sudo apt install libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf libgtk-3-dev libsoup-3.0-dev libjavascriptcoregtk-4.1-dev

# Fedora
sudo dnf install webkit2gtk4.1-devel libappindicator-gtk3-devel librsvg2-devel patchelf gtk3-devel libsoup3-devel javascriptcoregtk4.1-devel

# Arch Linux
sudo pacman -S --needed base-devel webkit2gtk-4.1 libappindicator-gtk3 librsvg patchelf gtk3 libsoup3
```

- **Tauri CLI**: `cargo install tauri-cli`

## Development Setup

1. Clone the repository:

   ```bash
   git clone https://github.com/TomRhodan/penguin-citizen.git
   cd penguin-citizen
   ```

2. Install frontend dependencies:

   ```bash
   npm install
   ```

3. Run in development mode:

   ```bash
   cargo tauri dev
   ```

   This starts both the Vite dev server (frontend) and the Rust backend with hot-reload.

## Project Structure

```
penguin-citizen/
  src/                    # Frontend (JS/HTML)
    pages/                # Page-specific JavaScript
    styles/               # CSS stylesheets
  src-tauri/
    src/                  # Rust backend
      main.rs             # Application entry point
      lib.rs              # Library root, Tauri command definitions
    helper/
      dinput_helper.c     # Source for the Wine DirectInput axis helper (see below)
    resources/
      penguin-citizen-helper.exe  # Pre-built Windows binary (committed to repo)
    Cargo.toml            # Rust dependencies
    tauri.conf.json       # Tauri configuration
  package.json            # Node.js dependencies & scripts
```

### The Wine DirectInput Helper

`src-tauri/resources/penguin-citizen-helper.exe` is a small Windows console program that
runs **inside Wine** to enumerate joystick axes via the DirectInput 8 API. It reports each
axis movement to stdout in a format the Rust backend can parse.

**Why a `.exe`?** Linux kernel joystick devices expose raw axis indices, but not the semantic
names that Star Citizen uses in `actionmaps.xml` (`x`, `y`, `rotx`, `roty`, etc.). The only
reliable cross-vendor way to get that mapping is to ask DirectInput directly -- which requires
running a Windows binary inside the same Wine environment as the game.

**Why is the binary committed to the repository?** The GitHub Actions release workflow runs on
Ubuntu and has no MinGW cross-compiler available, so the `.exe` cannot be built during CI.
**Do not add `*.exe` to `.gitignore`.** The pre-built binary in `src-tauri/resources/` must be
present for the Tauri build to succeed.

**Rebuilding the helper** (only needed after changes to `dinput_helper.c`):

```bash
# Requires mingw-w64 cross-compiler
sudo apt install gcc-mingw-w64-x86-64   # Debian/Ubuntu

x86_64-w64-mingw32-gcc -o src-tauri/resources/penguin-citizen-helper.exe \
  src-tauri/helper/dinput_helper.c \
  -ldinput8 -ldxguid -lole32 -Wall -O2

# Commit the updated binary together with your source change
git add src-tauri/resources/penguin-citizen-helper.exe src-tauri/helper/dinput_helper.c
```

## Code Style

### General

- Use `--` (double hyphen) instead of em dashes in all text and comments.
- All code comments and documentation must be in English.

### Rust

- Run `cargo fmt` before committing.
- Run `cargo clippy` and resolve all warnings.
- Avoid `unwrap()` in error paths -- use proper error handling (`?`, `Result`, `.unwrap_or_default()`, etc.).
- All public and private functions must have `///` doc comments.
- Structs and enums should have field-level `///` comments where the purpose is not obvious.

### JavaScript / HTML / CSS

- Use 2-space indentation.
- Keep frontend code in the appropriate `src/pages/` or `src/styles/` directory.
- All functions must have JSDoc comments with `@param` and `@returns` annotations.
- Module-scope state variables should have `@type` annotations.

## Commit Messages

Use [Conventional Commits](https://www.conventionalcommits.org/) format:

- `feat:` -- new feature
- `fix:` -- bug fix
- `docs:` -- documentation changes
- `chore:` -- maintenance tasks (deps, CI, etc.)
- `refactor:` -- code restructuring without behavior change
- `style:` -- formatting, whitespace (no logic change)
- `test:` -- adding or updating tests

Example: `feat: add Wine version selection dropdown`

## Reporting Issues

Please use our [GitHub Issue Templates](https://github.com/TomRhodan/penguin-citizen/issues/new/choose) for bug reports and feature requests. The templates guide you through providing the information we need to investigate.

## Pull Request Process

1. Create a feature branch from `main`.
2. Make your changes and ensure they compile without warnings (`cargo clippy`).
3. **Test manually** by running `cargo tauri dev` and verifying the following areas still work:
   - Dashboard (status overview, launch)
   - SC Versions (install/manage Star Citizen versions)
   - Bindings (import, view, and export controller bindings)
   - Settings (configuration options)
4. Write a clear PR description explaining what changed and why. Use the [PR template](.github/PULL_REQUEST_TEMPLATE.md) as a guide.
5. Submit the PR against `main`.

## CI / Release Builds

The release workflow (`.github/workflows/release.yml`) builds `.deb`, `.AppImage`, and a portable `.tar.gz` on Ubuntu 24.04.

**Important:** The `libwebkit2gtk-4.1` packages are pinned to version **2.44.0-2**. Newer versions cause `EGL_BAD_PARAMETER` crashes when the AppImage runs on other distributions. Do not remove the version pins without testing the resulting AppImage on multiple distros. See [zmk-studio PR #92](https://github.com/zmkfirmware/zmk-studio/pull/92) for background.

You can test the release build locally with Docker:

```bash
./test-build-docker.sh
```

## Code of Conduct

This project follows the [Contributor Covenant Code of Conduct](CODE_OF_CONDUCT.md). By participating, you are expected to uphold this code.

## License

By contributing to Penguin Citizen, you agree that your contributions will be licensed under the [GPL-3.0-or-later](LICENSE) license.
