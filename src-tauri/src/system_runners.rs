// Penguin Citizen - Star Citizen Linux Manager
// Copyright (C) 2024-2026 TomRhodan <tomrhodan@gmail.com>
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.
//
// You should have received a copy of the GNU General Public License
// along with this program.  If not, see <https://www.gnu.org/licenses/>.

//! Discovery of Wine/Proton runners that are already present on the system.
//!
//! Besides the runners Penguin Citizen downloads into `<install_path>/runners/`,
//! a Linux system often carries perfectly usable builds installed by something
//! else: the CachyOS packages `wine-cachyos-opt` and `proton-cachyos-slr`, or
//! whatever ProtonPlus / protonup-qt dropped into a Steam
//! `compatibilitytools.d` directory.
//!
//! This module only *finds* them. They are never written to and never deleted -
//! updates are the package manager's job. Resolution of a runner name to its
//! directory lives in [`crate::runners::runner_dir`], which consults this module
//! after the local `runners/` directory.

use std::collections::HashSet;
use std::path::{ Path, PathBuf };

use crate::runners::resolve_wine_bin;

/// Badge label for runners coming from a CachyOS package.
pub const ORIGIN_CACHYOS: &str = "CachyOS";
/// Badge label for runners installed system-wide by a package manager.
pub const ORIGIN_SYSTEM: &str = "System";
/// Badge label for runners found in a Steam compatibility-tools directory.
pub const ORIGIN_STEAM: &str = "Steam";

/// Whether a root path *is* a runner or *contains* runner directories.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum RootKind {
    /// The path itself is a runner directory (e.g. `/opt/wine-cachyos`).
    SingleRunner,
    /// The path holds one directory per runner (e.g. `compatibilitytools.d`).
    RunnerDir,
}

/// A location that may hold runners installed outside of Penguin Citizen.
#[derive(Clone, Debug)]
pub struct Root {
    pub path: PathBuf,
    pub kind: RootKind,
    /// Default badge label for runners found here.
    pub origin: &'static str,
}

/// A runner that exists on the system without Penguin Citizen having installed it.
#[derive(Clone, Debug)]
pub struct SystemRunner {
    /// Directory name, used as the runner name throughout the app.
    pub name: String,
    /// Absolute path of the runner directory.
    pub path: PathBuf,
    /// Where it came from - shown as a badge in the UI.
    pub origin: &'static str,
}

/// Locations scanned for system runners.
///
/// Paths are probed, not required: a missing directory is simply skipped, so the
/// same list works on CachyOS, Arch and any other distribution that happens to
/// ship these packages.
fn default_roots() -> Vec<Root> {
    let mut roots = vec![
        // CachyOS `wine-cachyos-opt` - a plain Wine build under /opt
        Root {
            path: PathBuf::from("/opt/wine-cachyos"),
            kind: RootKind::SingleRunner,
            origin: ORIGIN_CACHYOS,
        },
        // System-wide Steam compatibility tools: `proton-cachyos-slr`,
        // `proton-ge-custom-bin`, ...
        Root {
            path: PathBuf::from("/usr/share/steam/compatibilitytools.d"),
            kind: RootKind::RunnerDir,
            origin: ORIGIN_SYSTEM,
        }
    ];

    if let Some(home) = dirs::home_dir() {
        for relative in [
            ".steam/root/compatibilitytools.d",
            ".local/share/Steam/compatibilitytools.d",
            ".var/app/com.valvesoftware.Steam/.local/share/Steam/compatibilitytools.d",
        ] {
            roots.push(Root {
                path: home.join(relative),
                kind: RootKind::RunnerDir,
                origin: ORIGIN_STEAM,
            });
        }
    }

    roots
}

/// Refines the badge label: CachyOS builds keep their identity even when they
/// were installed into a Steam compatibility-tools directory.
fn origin_for(name: &str, root_origin: &'static str) -> &'static str {
    let lower = name.to_lowercase();
    if lower.starts_with("proton-cachyos") || lower.starts_with("wine-cachyos") {
        ORIGIN_CACHYOS
    } else {
        root_origin
    }
}

/// Turns a directory into a [`SystemRunner`] if it holds a usable wine binary.
fn candidate(path: &Path, root_origin: &'static str) -> Option<SystemRunner> {
    let name = path.file_name()?.to_string_lossy().into_owned();
    // Staging leftovers of other tools (e.g. `.protonplus-previous-...`)
    if name.starts_with('.') {
        return None;
    }
    // The same rule the rest of the app uses to call something a runner
    resolve_wine_bin(path)?;
    Some(SystemRunner {
        origin: origin_for(&name, root_origin),
        name,
        path: path.to_path_buf(),
    })
}

/// Scans the default locations for usable system runners.
pub(crate) fn scan() -> Vec<SystemRunner> {
    scan_in(&default_roots())
}

/// Scans the given roots, sorted by name and free of duplicates.
///
/// Duplicates are real: `~/.steam/root` and `~/.local/share/Steam` are usually
/// the same directory, so candidates are deduplicated by their canonical path.
pub(crate) fn scan_in(roots: &[Root]) -> Vec<SystemRunner> {
    let mut found: Vec<SystemRunner> = Vec::new();
    let mut seen_paths: HashSet<PathBuf> = HashSet::new();
    let mut seen_names: HashSet<String> = HashSet::new();

    for root in roots {
        match root.kind {
            RootKind::SingleRunner => {
                if let Some(runner) = candidate(&root.path, root.origin) {
                    push_unique(&mut found, &mut seen_paths, &mut seen_names, runner);
                }
            }
            RootKind::RunnerDir => {
                let Ok(entries) = std::fs::read_dir(&root.path) else {
                    continue;
                };
                let mut in_root: Vec<SystemRunner> = entries
                    .flatten()
                    .filter(|e| e.path().is_dir())
                    .filter_map(|e| candidate(&e.path(), root.origin))
                    .collect();
                // Stable order per root before deduplication decides a winner
                in_root.sort_by(|a, b| a.name.cmp(&b.name));
                for runner in in_root {
                    push_unique(&mut found, &mut seen_paths, &mut seen_names, runner);
                }
            }
        }
    }

    found.sort_by(|a, b| a.name.cmp(&b.name));
    found
}

/// Adds `runner` unless its canonical path or its name was already taken.
fn push_unique(
    found: &mut Vec<SystemRunner>,
    seen_paths: &mut HashSet<PathBuf>,
    seen_names: &mut HashSet<String>,
    runner: SystemRunner
) {
    let canonical = std::fs::canonicalize(&runner.path).unwrap_or_else(|_| runner.path.clone());
    if !seen_paths.insert(canonical) {
        return;
    }
    // Two different paths with the same name would be indistinguishable by the
    // runner name the rest of the app passes around - first root wins.
    if !seen_names.insert(runner.name.clone()) {
        return;
    }
    found.push(runner);
}

/// Looks up a system runner by name.
pub(crate) fn find(name: &str) -> Option<SystemRunner> {
    scan().into_iter().find(|r| r.name == name)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Creates `dir/<relative wine path>` so the directory counts as a runner.
    fn make_runner(dir: &Path, wine_relative: &str) {
        let wine = dir.join(wine_relative);
        std::fs::create_dir_all(wine.parent().unwrap()).unwrap();
        std::fs::write(wine, "fake").unwrap();
    }

    #[test]
    fn finds_wine_and_proton_layouts_and_skips_everything_else() {
        let tmp = tempfile::tempdir().unwrap();
        let compat = tmp.path().join("compatibilitytools.d");

        make_runner(&compat.join("plain-wine"), "bin/wine");
        make_runner(&compat.join("GE-Proton10-34"), "files/bin/wine");
        make_runner(&compat.join("old-proton"), "dist/bin/wine");
        // No wine at all (e.g. SteamTinkerLaunch)
        std::fs::create_dir_all(compat.join("SteamTinkerLaunch")).unwrap();
        // Staging leftover of another tool
        make_runner(&compat.join(".protonplus-stage"), "files/bin/wine");
        // arm64 layout - not a layout this app can run
        make_runner(&compat.join("proton-cachyos-arm64"), "files/bin-arm64/wine");

        let roots = vec![Root {
            path: compat,
            kind: RootKind::RunnerDir,
            origin: ORIGIN_STEAM,
        }];

        let names: Vec<String> = scan_in(&roots)
            .into_iter()
            .map(|r| r.name)
            .collect();
        assert_eq!(names, vec!["GE-Proton10-34", "old-proton", "plain-wine"]);
    }

    #[test]
    fn single_runner_root_is_the_runner_itself() {
        let tmp = tempfile::tempdir().unwrap();
        let wine_cachyos = tmp.path().join("wine-cachyos");
        make_runner(&wine_cachyos, "bin/wine");

        let roots = vec![Root {
            path: wine_cachyos,
            kind: RootKind::SingleRunner,
            origin: ORIGIN_CACHYOS,
        }];

        let found = scan_in(&roots);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].name, "wine-cachyos");
        assert_eq!(found[0].origin, ORIGIN_CACHYOS);
    }

    #[test]
    fn cachyos_builds_keep_their_origin_in_a_steam_directory() {
        let tmp = tempfile::tempdir().unwrap();
        let compat = tmp.path().join("compatibilitytools.d");
        make_runner(&compat.join("proton-cachyos-11.0-slr-x86_64"), "files/bin/wine");
        make_runner(&compat.join("GE-Proton10-34"), "files/bin/wine");

        let roots = vec![Root {
            path: compat,
            kind: RootKind::RunnerDir,
            origin: ORIGIN_STEAM,
        }];

        let found = scan_in(&roots);
        let cachyos = found.iter().find(|r| r.name.starts_with("proton-cachyos")).unwrap();
        let ge = found.iter().find(|r| r.name.starts_with("GE-")).unwrap();
        assert_eq!(cachyos.origin, ORIGIN_CACHYOS);
        assert_eq!(ge.origin, ORIGIN_STEAM);
    }

    #[test]
    fn symlinked_root_is_reported_once() {
        let tmp = tempfile::tempdir().unwrap();
        let real = tmp.path().join("real/compatibilitytools.d");
        make_runner(&real.join("GE-Proton10-34"), "files/bin/wine");
        let link = tmp.path().join("linked");
        std::os::unix::fs::symlink(tmp.path().join("real"), &link).unwrap();

        let roots = vec![
            Root {
                path: real,
                kind: RootKind::RunnerDir,
                origin: ORIGIN_SYSTEM,
            },
            Root {
                path: link.join("compatibilitytools.d"),
                kind: RootKind::RunnerDir,
                origin: ORIGIN_STEAM,
            }
        ];

        let found = scan_in(&roots);
        assert_eq!(found.len(), 1);
        // The first root wins, so the label stays the system one
        assert_eq!(found[0].origin, ORIGIN_SYSTEM);
    }

    #[test]
    fn missing_roots_are_skipped() {
        let roots = vec![
            Root {
                path: PathBuf::from("/definitely/not/here"),
                kind: RootKind::RunnerDir,
                origin: ORIGIN_SYSTEM,
            },
            Root {
                path: PathBuf::from("/definitely/not/here/either"),
                kind: RootKind::SingleRunner,
                origin: ORIGIN_CACHYOS,
            }
        ];
        assert!(scan_in(&roots).is_empty());
    }

    #[test]
    fn default_roots_cover_cachyos_and_steam() {
        let roots = default_roots();
        assert!(roots.iter().any(|r| r.path == Path::new("/opt/wine-cachyos")));
        assert!(
            roots.iter().any(|r| r.path == Path::new("/usr/share/steam/compatibilitytools.d"))
        );
    }
}
