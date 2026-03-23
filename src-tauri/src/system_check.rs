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

//! Module for checking system requirements.
//!
//! This module performs various system checks to ensure
//! the system meets the prerequisites for Star Citizen:
//! - Memory (RAM + Swap)
//! - CPU AVX support
//! - vm.max_map_count (system limit for memory mappings)
//! - File descriptor limit
//! - Vulkan support
//! - Disk space
//!
//! Additionally, fix commands are provided for configurable system settings,
//! which are executed via pkexec (graphical password prompt).

use serde::{ Deserialize, Serialize };
use std::fs;
use std::path::Path;
use std::process::Command;

/// Status result for individual system checks.
///
/// Three levels: Pass (passed), Warn (warning), Fail (failed).
/// Displayed with colors in the frontend (green/yellow/red).
#[derive(Serialize, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum CheckStatus {
    Pass,
    Warn,
    Fail,
}

/// Result of an individual system check.
#[derive(Serialize, Deserialize, Clone)]
pub struct CheckResult {
    /// Unique ID of the check (e.g. "memory", "avx")
    id: String,
    /// Display name for the frontend
    name: String,
    /// Result status (Pass/Warn/Fail)
    status: CheckStatus,
    /// Detailed description of the result
    detail: String,
    /// Whether the issue can be fixed automatically
    fixable: bool,
}

/// Overall result of all system checks.
#[derive(Serialize, Deserialize)]
pub struct SystemCheckResult {
    /// List of all performed checks
    checks: Vec<CheckResult>,
    /// Whether all checks passed (no Fail)
    all_passed: bool,
    /// Whether there are warnings
    has_warnings: bool,
}

/// Result of a fix attempt for a system setting.
#[derive(Serialize, Deserialize)]
pub struct FixResult {
    success: bool,
    message: String,
}

// --- Individual checks ---

/// Checks the memory (RAM + Swap) against the requirements.
///
/// Star Citizen requires at least 16 GiB RAM (otherwise Fail).
/// For optimal performance, a total of 40 GiB (RAM + Swap) is recommended (otherwise Warn).
/// The values are read from /proc/meminfo.
fn check_memory() -> CheckResult {
    let mut ram_kb: u64 = 0;
    let mut swap_kb: u64 = 0;

    if let Ok(contents) = fs::read_to_string("/proc/meminfo") {
        for line in contents.lines() {
            if line.starts_with("MemTotal:") {
                ram_kb = parse_meminfo_value(line);
            } else if line.starts_with("SwapTotal:") {
                swap_kb = parse_meminfo_value(line);
            }
        }
    }

    // Convert from kilobytes to gibibytes (1 GiB = 1,048,576 KB)
    let ram_gib = (ram_kb as f64) / 1_048_576.0;
    let swap_gib = (swap_kb as f64) / 1_048_576.0;
    let combined_gib = ram_gib + swap_gib;

    let status = if ram_gib < 16.0 {
        // Less than 16 GiB RAM -- Star Citizen will not run stably
        CheckStatus::Fail
    } else if combined_gib < 40.0 {
        // RAM sufficient, but RAM+Swap combined under 40 GiB -- warning
        CheckStatus::Warn
    } else {
        CheckStatus::Pass
    };

    let detail = format!(
        "{:.0} GiB RAM + {:.0} GiB Swap = {:.0} GiB total",
        ram_gib,
        swap_gib,
        combined_gib
    );

    CheckResult {
        id: "memory".into(),
        name: "Memory".into(),
        status,
        detail,
        fixable: false,
    }
}

/// Parses a numeric value from a line of /proc/meminfo.
///
/// Format: "MemTotal:     16384000 kB"
/// Extracts the second word (the numeric value) and returns it as u64.
fn parse_meminfo_value(line: &str) -> u64 {
    line.split_whitespace()
        .nth(1)
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(0)
}

/// Checks whether the CPU supports AVX instructions.
///
/// Star Citizen requires AVX support. This is read from /proc/cpuinfo,
/// where the CPU flags are listed.
fn check_avx() -> CheckResult {
    let has_avx = fs
        ::read_to_string("/proc/cpuinfo")
        .map(|contents| {
            contents.lines().any(|line| line.starts_with("flags") && line.contains(" avx"))
        })
        .unwrap_or(false);

    CheckResult {
        id: "avx".into(),
        name: "AVX Support".into(),
        status: if has_avx {
            CheckStatus::Pass
        } else {
            CheckStatus::Fail
        },
        detail: if has_avx {
            "CPU supports AVX instructions".into()
        } else {
            "CPU does not support AVX - required by Star Citizen".into()
        },
        fixable: false,
    }
}

/// Checks the system limit vm.max_map_count.
///
/// Star Citizen requires at least 16,777,216 memory mappings.
/// The current value is read from /proc/sys/vm/max_map_count.
/// If the value is too low, it can be automatically fixed via `fix_mapcount()`.
fn check_mapcount() -> CheckResult {
    let required: u64 = 16_777_216;

    let current = fs
        ::read_to_string("/proc/sys/vm/max_map_count")
        .ok()
        .and_then(|s| s.trim().parse::<u64>().ok())
        .unwrap_or(0);

    let status = if current >= required { CheckStatus::Pass } else { CheckStatus::Fail };

    let detail = format!(
        "Current: {} (required: {})",
        format_number(current),
        format_number(required)
    );

    // Only mark as fixable if the value is too low
    let fixable = status == CheckStatus::Fail;

    CheckResult {
        id: "mapcount".into(),
        name: "vm.max_map_count".into(),
        status,
        detail,
        fixable,
    }
}

/// Checks the file descriptor limit (hard limit) of the system.
///
/// Star Citizen opens many files simultaneously and requires at least
/// 524,288 file descriptors. The current hard limit is determined via
/// the libc function getrlimit().
fn check_filelimit() -> CheckResult {
    let required: u64 = 524_288;

    let mut rlim = libc::rlimit {
        rlim_cur: 0,
        rlim_max: 0,
    };

    // SAFETY: rlim is initialized with zeros and getrlimit only writes to it on success.
    // Reading the hard limit is a safe operation.
    let hard_limit = unsafe {
        if libc::getrlimit(libc::RLIMIT_NOFILE, &mut rlim) == 0 { rlim.rlim_max } else { 0 }
    };

    let status = if hard_limit >= required { CheckStatus::Pass } else { CheckStatus::Fail };

    let detail = format!(
        "Hard limit: {} (required: {})",
        format_number(hard_limit),
        format_number(required)
    );

    // Only mark as fixable if the limit is too low
    let fixable = status == CheckStatus::Fail;

    CheckResult {
        id: "filelimit".into(),
        name: "File Descriptor Limit".into(),
        status,
        detail,
        fixable,
    }
}

/// Checks whether Vulkan support is available on the system.
///
/// Vulkan is required for DXVK and therefore for Star Citizen on Linux.
/// Searches for the vulkaninfo tool and the libvulkan library at the common
/// paths (supports different Linux distributions).
fn check_vulkan() -> CheckResult {
    let has_vulkaninfo = Path::new("/usr/bin/vulkaninfo").exists();
    // Different paths for libvulkan depending on distribution/architecture
    let has_libvulkan =
        Path::new("/usr/lib/libvulkan.so.1").exists() ||
        Path::new("/usr/lib64/libvulkan.so.1").exists() ||
        Path::new("/usr/lib/x86_64-linux-gnu/libvulkan.so.1").exists();

    let detected = has_vulkaninfo || has_libvulkan;

    CheckResult {
        id: "vulkan".into(),
        name: "Vulkan Support".into(),
        status: if detected {
            CheckStatus::Pass
        } else {
            CheckStatus::Fail
        },
        detail: if has_vulkaninfo {
            "vulkaninfo found".into()
        } else if has_libvulkan {
            "libvulkan.so.1 found (vulkaninfo not installed)".into()
        } else {
            "No Vulkan runtime detected - install your GPU's Vulkan driver".into()
        },
        fixable: false,
    }
}

/// Checks the available disk space at the installation path.
///
/// Star Citizen requires at least 100 GB of free space.
/// If the specified path does not exist yet, the next existing
/// parent directory is used to determine the free space.
fn check_disk_space(install_path: &str) -> CheckResult {
    let required_gb: u64 = 100;

    let path = if install_path.is_empty() {
        get_default_install_path_inner()
    } else {
        install_path.to_string()
    };

    // If the path does not exist yet, find the next existing parent path
    let check_path = find_existing_parent(&path);

    let free_gb = get_free_space_gb(&check_path);

    let status = if free_gb >= required_gb { CheckStatus::Pass } else { CheckStatus::Fail };

    let detail = format!("{} GB free at {} (required: {} GB)", free_gb, check_path, required_gb);

    CheckResult {
        id: "diskspace".into(),
        name: "Disk Space".into(),
        status,
        detail,
        fixable: false,
    }
}

/// Finds the first existing parent directory of a path.
///
/// Walks up the path until an existing directory is found.
/// Needed to determine disk space when the installation path
/// has not been created yet.
fn find_existing_parent(path: &str) -> String {
    let mut p = Path::new(path);
    while !p.exists() {
        match p.parent() {
            Some(parent) => {
                p = parent;
            }
            None => {
                return "/".into();
            }
        }
    }
    p.to_string_lossy().into_owned()
}

/// Determines the free disk space in gigabytes via the libc function statvfs().
///
/// Uses f_bavail (blocks available to non-root users) instead of f_bfree,
/// since some blocks may be reserved for root.
fn get_free_space_gb(path: &str) -> u64 {
    use std::ffi::CString;

    let c_path = match CString::new(path) {
        Ok(p) => p,
        Err(_) => {
            return 0;
        }
    };

    // SAFETY: c_path is a valid, NUL-terminated CString. stat is initialized with zeros
    // and only read after a successful statvfs() call.
    unsafe {
        let mut stat: libc::statvfs = std::mem::zeroed();
        if libc::statvfs(c_path.as_ptr(), &mut stat) == 0 {
            let free_bytes = stat.f_bavail * stat.f_frsize;
            free_bytes / (1024 * 1024 * 1024)
        } else {
            0
        }
    }
}

/// Formats a number with thousands separators (comma).
///
/// Example: 16777216 -> "16,777,216"
fn format_number(n: u64) -> String {
    let s = n.to_string();
    let mut result = String::new();
    for (i, c) in s.chars().rev().enumerate() {
        if i > 0 && i % 3 == 0 {
            result.push(',');
        }
        result.push(c);
    }
    result.chars().rev().collect()
}

/// Returns the default installation path.
///
/// On Linux: `$HOME/Games/star-citizen`
/// Fallback if HOME is not set: `/tmp/star-citizen`
fn get_default_install_path_inner() -> String {
    if let Ok(home) = std::env::var("HOME") {
        format!("{}/Games/star-citizen", home)
    } else {
        "/tmp/star-citizen".into()
    }
}

/// Information about a connected monitor.
///
/// Used for monitor selection in the launch dialog
/// to start Star Citizen on the correct display.
#[derive(Serialize, Deserialize, Clone)]
pub struct MonitorInfo {
    /// Device name (e.g. "DP-1", "HDMI-A-1")
    pub name: String,
    /// Current resolution (e.g. "2560x1440")
    pub resolution: String,
    /// Whether this is the primary monitor
    pub primary: bool,
    /// Scale factor (if available, e.g. 1.0, 1.5, 2.0)
    pub scale: Option<f64>,
}

// --- Tauri commands ---

/// Detects all connected monitors.
///
/// Uses different detection methods depending on the display server:
/// - Wayland: KDE kscreen-doctor -> GNOME gnome-monitor-config -> wlr-randr
/// - X11/XWayland: xrandr (fallback for all systems)
///
/// The methods are tried in order until one returns results.
#[tauri::command]
pub async fn detect_monitors() -> Result<Vec<MonitorInfo>, String> {
    tokio::task
        ::spawn_blocking(move || {
            // Check if a Wayland session is active
            let is_wayland = std::env
                ::var("XDG_SESSION_TYPE")
                .map(|v| v == "wayland")
                .unwrap_or(false);

            if is_wayland {
                // Try Wayland-native detection (KDE -> GNOME -> wlroots -> xrandr)
                if let Some(monitors) = detect_monitors_kscreen() {
                    if !monitors.is_empty() {
                        return monitors;
                    }
                }
                if let Some(monitors) = detect_monitors_gnome() {
                    if !monitors.is_empty() {
                        return monitors;
                    }
                }
                if let Some(monitors) = detect_monitors_wlr_randr() {
                    if !monitors.is_empty() {
                        return monitors;
                    }
                }
            }

            // Fallback: xrandr works on X11 and via XWayland
            detect_monitors_xrandr()
        }).await
        .map_err(|e| format!("Task failed: {}", e))
}

/// KDE Plasma Wayland: Monitor detection via `kscreen-doctor --outputs`.
///
/// Parses the output of kscreen-doctor, which may contain ANSI escape sequences.
/// Only enabled and connected outputs are considered.
fn detect_monitors_kscreen() -> Option<Vec<MonitorInfo>> {
    let output = Command::new("kscreen-doctor").arg("--outputs").env("LANG", "C").output().ok()?;

    if !output.status.success() {
        return None;
    }

    // Remove ANSI escape sequences (kscreen-doctor produces colored output)
    let raw = String::from_utf8_lossy(&output.stdout);
    let stdout = strip_ansi(&raw);
    let lines: Vec<&str> = stdout.lines().collect();
    let mut monitors = Vec::new();

    let mut i = 0;
    while i < lines.len() {
        let line = lines[i].trim();

        // Each output begins with "Output: <Nr> <Name> <UUID>"
        if line.starts_with("Output:") {
            let parts: Vec<&str> = line.split_whitespace().collect();
            if parts.len() >= 3 {
                let name = parts[2].to_string();
                let mut enabled = false;
                let mut connected = false;
                let mut primary = false;
                let mut resolution = String::new();
                let mut scale: Option<f64> = None;

                // Parse subsequent indented lines that contain properties of the output
                i += 1;
                while i < lines.len() {
                    let sub = lines[i].trim();
                    // Next output block begins -- end loop
                    if sub.starts_with("Output:") {
                        break;
                    }
                    if sub == "enabled" {
                        enabled = true;
                    } else if sub == "connected" {
                        connected = true;
                    } else if sub.starts_with("priority") {
                        // priority 1 = primary monitor
                        if let Some(val) = sub.split_whitespace().nth(1) {
                            primary = val == "1";
                        }
                    } else if sub.starts_with("Geometry:") {
                        // "Geometry: 2560,0 2560x1440" -- the second element is the resolution
                        if let Some(geom) = sub.split_whitespace().nth(2) {
                            resolution = geom.to_string();
                        }
                    } else if sub.starts_with("Scale:") {
                        if let Some(val) = sub.split_whitespace().nth(1) {
                            scale = val.parse().ok();
                        }
                    }
                    i += 1;
                }

                // Only include enabled and connected monitors
                if enabled && connected {
                    monitors.push(MonitorInfo {
                        name,
                        resolution,
                        primary,
                        scale,
                    });
                }
                continue; // Don't increment i again, as it already points to the next block
            }
        }
        i += 1;
    }

    Some(monitors)
}

/// GNOME Wayland: Monitor detection via `gnome-monitor-config list`.
///
/// Parst die Ausgabe im Format:
/// ```text
/// Logical monitor 0: x=0 y=0 scale=1 transform=normal PRIMARY
///   DP-1 []: 2560x1440@143.91 ...
/// ```
fn detect_monitors_gnome() -> Option<Vec<MonitorInfo>> {
    let output = Command::new("gnome-monitor-config").arg("list").output().ok()?;

    if !output.status.success() {
        return None;
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let lines: Vec<&str> = stdout.lines().collect();
    let mut monitors = Vec::new();

    let mut current_primary;
    let mut i = 0;
    while i < lines.len() {
        let line = lines[i];
        if line.starts_with("Logical monitor") {
            // "PRIMARY" at the end of the line marks the main monitor
            current_primary = line.contains("PRIMARY");
            // Subsequent indented lines are the physical outputs
            i += 1;
            while i < lines.len() {
                let sub = lines[i].trim();
                if sub.is_empty() || lines[i].starts_with("Logical monitor") {
                    break;
                }
                // Format: "DP-1 [LG Electronics ...]: 2560x1440@143.91 ..."
                let parts: Vec<&str> = sub.splitn(2, ' ').collect();
                if !parts.is_empty() {
                    let name = parts[0].to_string();
                    // Find resolution in "WxH@rate" format and strip the @rate part
                    let mut resolution = String::new();
                    if let Some(rest) = parts.get(1) {
                        for token in rest.split_whitespace() {
                            if token.contains('x') && token.contains('@') {
                                if let Some(res) = token.split('@').next() {
                                    resolution = res.to_string();
                                }
                                break;
                            }
                        }
                    }
                    monitors.push(MonitorInfo {
                        name,
                        resolution,
                        primary: current_primary,
                        scale: None,
                    });
                }
                i += 1;
            }
            continue;
        }
        i += 1;
    }

    Some(monitors)
}

/// wlroots compositor detection (Sway, Hyprland) via `wlr-randr`.
///
/// Parses the output where monitor names appear at the beginning of lines (not indented)
/// and mode lines are indented. The active resolution is marked with "(current)".
fn detect_monitors_wlr_randr() -> Option<Vec<MonitorInfo>> {
    let output = Command::new("wlr-randr").output().ok()?;

    if !output.status.success() {
        return None;
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let lines: Vec<&str> = stdout.lines().collect();
    let mut monitors = Vec::new();

    let mut current_name = String::new();
    let mut current_resolution = String::new();

    for line in &lines {
        let trimmed = line.trim();
        // Non-indented, non-empty lines are monitor names
        if !line.starts_with(' ') && !line.starts_with('\t') && !trimmed.is_empty() {
            // Save previous monitor (if any)
            if !current_name.is_empty() {
                monitors.push(MonitorInfo {
                    name: current_name.clone(),
                    resolution: current_resolution.clone(),
                    // The first monitor is considered primary (wlr-randr has no primary flag)
                    primary: monitors.is_empty(),
                    scale: None,
                });
            }
            current_name = trimmed.split_whitespace().next().unwrap_or("").to_string();
            current_resolution = String::new();
        } else if current_resolution.is_empty() && trimmed.contains("current") {
            // Indented line with "current" contains the active resolution
            // Format: "  2560x1440 px, 59.951 Hz (current)"
            if let Some(res) = trimmed.split_whitespace().next() {
                current_resolution = res.to_string();
            }
        }
    }

    // Don't forget the last monitor
    if !current_name.is_empty() {
        monitors.push(MonitorInfo {
            name: current_name,
            resolution: current_resolution,
            primary: monitors.is_empty(),
            scale: None,
        });
    }

    Some(monitors)
}

/// X11/XWayland fallback: Monitor detection via `xrandr --query`.
///
/// Searches for lines with " connected" and finds the active resolution
/// (marked with *) in the subsequent mode lines.
fn detect_monitors_xrandr() -> Vec<MonitorInfo> {
    let output = match Command::new("xrandr").arg("--query").output() {
        Ok(o) => o,
        Err(_) => {
            return Vec::new();
        }
    };

    if !output.status.success() {
        return Vec::new();
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let lines: Vec<&str> = stdout.lines().collect();
    let mut monitors = Vec::new();

    for (i, line) in lines.iter().enumerate() {
        // Only consider connected monitors
        if !line.contains(" connected") {
            continue;
        }

        let name = match line.split_whitespace().next() {
            Some(n) => n.to_string(),
            None => {
                continue;
            }
        };

        // "primary" in the line identifies the main monitor
        let primary = line.contains(" primary ");

        // Search for active resolution in the subsequent lines (marked with *)
        let mut resolution = String::new();
        for mode_line in lines
            .iter()
            .skip(i + 1)
            .map(|l| l.trim()) {
            // Stop at the next monitor
            if mode_line.contains(" connected") || mode_line.contains(" disconnected") {
                break;
            }
            // * marks the active mode
            if mode_line.contains('*') {
                if let Some(res) = mode_line.split_whitespace().next() {
                    resolution = res.to_string();
                }
                break;
            }
        }

        monitors.push(MonitorInfo {
            name,
            resolution,
            primary,
            scale: None,
        });
    }

    monitors
}

/// Removes ANSI escape sequences from a string.
///
/// ANSI escape sequences start with ESC (0x1b) and end with an
/// ASCII letter. Needed for the kscreen-doctor output,
/// which contains colored terminal output.
fn strip_ansi(s: &str) -> String {
    let mut result = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\x1b' {
            // Skip the escape sequence until the terminating letter
            while let Some(&next) = chars.peek() {
                chars.next();
                if next.is_ascii_alphabetic() {
                    break;
                }
            }
        } else {
            result.push(c);
        }
    }
    result
}

/// Runs all system checks and returns the overall result.
///
/// The checks include: memory, AVX, max_map_count,
/// file descriptor limit, Vulkan, and disk space.
/// Executed in a blocking thread since some checks
/// require filesystem access.
#[tauri::command]
pub async fn run_system_check(install_path: String) -> Result<SystemCheckResult, String> {
    tokio::task
        ::spawn_blocking(move || {
            let checks = vec![
                check_memory(),
                check_avx(),
                check_mapcount(),
                check_filelimit(),
                check_vulkan(),
                check_disk_space(&install_path)
            ];

            // Calculate overall status: all_passed if no Fail, has_warnings if at least one Warn
            let all_passed = checks.iter().all(|c| c.status != CheckStatus::Fail);
            let has_warnings = checks.iter().any(|c| c.status == CheckStatus::Warn);

            SystemCheckResult {
                checks,
                all_passed,
                has_warnings,
            }
        }).await
        .map_err(|e| format!("Task failed: {}", e))
}

/// Fixes a too-low vm.max_map_count by creating a sysctl configuration file.
///
/// Creates `/etc/sysctl.d/99-starcitizen-max_map_count.conf` with the value 16,777,216
/// and applies the setting immediately. The change persists across reboots.
/// Uses pkexec for the graphical password prompt (root privileges required).
#[tauri::command]
pub async fn fix_mapcount() -> Result<FixResult, String> {
    tokio::task
        ::spawn_blocking(move || {
            // Check if pkexec (graphical sudo alternative) is available
            if !Path::new("/usr/bin/pkexec").exists() {
                return FixResult {
                    success: false,
                    message: "pkexec not found. Manually run: sudo sysctl -w vm.max_map_count=16777216 && echo 'vm.max_map_count = 16777216' | sudo tee /etc/sysctl.d/99-starcitizen-max_map_count.conf".into(),
                };
            }

            // Create sysctl configuration file and reload settings
            let result = Command::new("pkexec")
                .arg("sh")
                .arg("-c")
                .arg(
                    "printf 'vm.max_map_count = 16777216\\n' > /etc/sysctl.d/99-starcitizen-max_map_count.conf && sysctl --quiet --system"
                )
                .output();

            match result {
                Ok(output) => {
                    if output.status.success() {
                        FixResult {
                            success: true,
                            message: "vm.max_map_count set to 16,777,216 (persistent)".into(),
                        }
                    } else {
                        let code = output.status.code().unwrap_or(-1);
                        // Exit code 126/127: User cancelled authentication
                        if code == 126 || code == 127 {
                            FixResult {
                                success: false,
                                message: "Authentication cancelled".into(),
                            }
                        } else {
                            let stderr = String::from_utf8_lossy(&output.stderr).to_string();
                            FixResult {
                                success: false,
                                message: format!("Failed (exit {}): {}", code, stderr.trim()),
                            }
                        }
                    }
                }
                Err(e) =>
                    FixResult {
                        success: false,
                        message: format!("Failed to execute pkexec: {}", e),
                    },
            }
        }).await
        .map_err(|e| format!("Task failed: {}", e))
}

/// Fixes a too-low file descriptor limit by creating a systemd configuration file.
///
/// Creates `/etc/systemd/system.conf.d/99-starcitizen-filelimit.conf` with the value 524,288
/// and runs `systemctl daemon-reexec`. The change only takes effect after re-login
/// or a reboot.
/// Uses pkexec for the graphical password prompt (root privileges required).
#[tauri::command]
pub async fn fix_filelimit() -> Result<FixResult, String> {
    tokio::task
        ::spawn_blocking(move || {
            if !Path::new("/usr/bin/pkexec").exists() {
                return FixResult {
                    success: false,
                    message: "pkexec not found. Manually create /etc/systemd/system.conf.d/99-starcitizen-filelimit.conf with:\n[Manager]\nDefaultLimitNOFILE=524288".into(),
                };
            }

            // Create systemd configuration directory, write file, and reload daemon
            let result = Command::new("pkexec")
                .arg("sh")
                .arg("-c")
                .arg(
                    "mkdir -p /etc/systemd/system.conf.d && printf '[Manager]\\nDefaultLimitNOFILE=524288\\n' > /etc/systemd/system.conf.d/99-starcitizen-filelimit.conf && systemctl daemon-reexec"
                )
                .output();

            match result {
                Ok(output) => {
                    if output.status.success() {
                        FixResult {
                            success: true,
                            message: "File descriptor limit set to 524,288 (persistent, effective after re-login)".into(),
                        }
                    } else {
                        let code = output.status.code().unwrap_or(-1);
                        // Exit code 126/127: User cancelled authentication
                        if code == 126 || code == 127 {
                            FixResult {
                                success: false,
                                message: "Authentication cancelled".into(),
                            }
                        } else {
                            let stderr = String::from_utf8_lossy(&output.stderr).to_string();
                            FixResult {
                                success: false,
                                message: format!("Failed (exit {}): {}", code, stderr.trim()),
                            }
                        }
                    }
                }
                Err(e) =>
                    FixResult {
                        success: false,
                        message: format!("Failed to execute pkexec: {}", e),
                    },
            }
        }).await
        .map_err(|e| format!("Task failed: {}", e))
}

/// Returns the default installation path for Star Citizen.
///
/// Used by the frontend when the user has not specified a custom path.
#[tauri::command]
pub async fn get_default_install_path() -> String {
    get_default_install_path_inner()
}
