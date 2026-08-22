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
use std::process::{Command, Stdio};
use std::time::Duration;

/// Status result for individual system checks.
///
/// Three levels: Pass (passed), Warn (warning), Fail (failed).
/// Displayed with colors in the frontend (green/yellow/red).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
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

/// Minimum physical RAM in GiB. Below this Star Citizen crashes no matter how
/// much swap is configured.
const MEMORY_REQUIRED_GIB: u64 = 16;

/// Recommended combined RAM + swap in GiB, matching lug-helper's
/// `memory_combined_required`.
const MEMORY_COMBINED_REQUIRED_GIB: u64 = 48;

/// At or above this much physical RAM the system passes without any swap
/// requirement. 62 rather than 64 to absorb the gap between installed RAM and
/// what the kernel reports as available.
const MEMORY_PLENTY_GIB: u64 = 62;

/// Tolerance in GiB applied to threshold comparisons, mirroring lug-helper.
/// Absorbs the rounding between the kernel's KiB values and whole GiB.
const MEMORY_TOLERANCE_GIB: u64 = 2;

/// Memory configuration as reported by the kernel, in whole GiB.
///
/// zram is tracked separately from ordinary swap: it lives in RAM and is listed
/// in `/proc/swaps`, so counting it as swap - which `SwapTotal` in
/// `/proc/meminfo` does - reports backing store that does not exist.
#[derive(Debug, Clone, Copy, PartialEq)]
struct MemoryFacts {
    ram_gib: u64,
    swap_gib: u64,
    zram_gib: u64,
    zswap_enabled: bool,
}

/// Converts KiB to whole GiB, rounding to nearest.
fn kib_to_gib(kib: u64) -> u64 {
    (kib + 512 * 1024) / (1024 * 1024)
}

/// Reads RAM, swap, zram and zswap state from /proc and /sys.
fn read_memory_facts() -> MemoryFacts {
    let mut ram_kib: u64 = 0;
    if let Ok(contents) = fs::read_to_string("/proc/meminfo") {
        for line in contents.lines() {
            if line.starts_with("MemTotal:") {
                ram_kib = parse_meminfo_value(line);
                break;
            }
        }
    }

    // /proc/swaps lists one device per line after a header:
    //   Filename        Type        Size    Used    Priority
    //   /dev/zram0      partition   8388604 0       100
    // Sizes are in KiB. zram devices are told apart by their filename.
    let mut swap_kib: u64 = 0;
    let mut zram_kib: u64 = 0;
    if let Ok(contents) = fs::read_to_string("/proc/swaps") {
        for line in contents.lines().skip(1) {
            let mut fields = line.split_whitespace();
            let (Some(name), Some(_kind), Some(size)) = (
                fields.next(),
                fields.next(),
                fields.next(),
            ) else {
                continue;
            };
            let Ok(size) = size.parse::<u64>() else {
                continue;
            };
            if name.contains("zram") {
                zram_kib += size;
            } else {
                swap_kib += size;
            }
        }
    }

    // zswap compresses pages on their way out to swap. It is a different
    // mechanism than zram and the two get in each other's way when both run.
    let zswap_enabled = fs
        ::read_to_string("/sys/module/zswap/parameters/enabled")
        .map(|s| matches!(s.trim(), "Y" | "y" | "1"))
        .unwrap_or(false);

    MemoryFacts {
        ram_gib: kib_to_gib(ram_kib),
        swap_gib: kib_to_gib(swap_kib),
        zram_gib: kib_to_gib(zram_kib),
        zswap_enabled,
    }
}

/// The zram size recommended for a given amount of RAM, following the LUG
/// Performance-Tuning guide: `ram` on small systems, `ram / 2` once the machine
/// is close to the combined target, `ram / 4` at 64 GiB and above.
fn recommended_zram_gib(ram_gib: u64) -> u64 {
    if ram_gib >= MEMORY_PLENTY_GIB {
        ram_gib / 4
    } else if ram_gib >= MEMORY_COMBINED_REQUIRED_GIB - MEMORY_TOLERANCE_GIB {
        ram_gib / 2
    } else {
        ram_gib
    }
}

/// Turns memory facts into a check status and a human-readable detail text.
///
/// Kept free of I/O so the branch tree can be unit tested.
///
/// Only insufficient physical RAM fails - it is the one condition that stops
/// the game from running at all, and `all_passed` gates the install wizard.
/// A swap shortfall or a zram/zswap conflict warns; a missing zram
/// configuration is a note that leaves the status untouched, matching how
/// lug-helper reports it.
fn evaluate_memory(f: &MemoryFacts) -> (CheckStatus, String) {
    let mut lines: Vec<String> = vec![
        format!("{} GiB RAM, {} GiB zram, {} GiB swap", f.ram_gib, f.zram_gib, f.swap_gib)
    ];

    // Not enough physical RAM: nothing else can compensate for it.
    if f.ram_gib < MEMORY_REQUIRED_GIB - MEMORY_TOLERANCE_GIB {
        lines.push(
            format!("At least {} GiB RAM is required to avoid crashes.", MEMORY_REQUIRED_GIB)
        );
        return (CheckStatus::Fail, lines.join("\n"));
    }

    let mut warn = false;

    // zram and zswap both active: they work against each other.
    if f.zram_gib > 0 && f.zswap_enabled {
        lines.push(
            "zram and zswap are both enabled - disable zswap to get the full benefit of zram.".into()
        );
        warn = true;
    }

    let zram_recommended = recommended_zram_gib(f.ram_gib);
    let zram_ok = f.zram_gib + MEMORY_TOLERANCE_GIB >= zram_recommended;

    // Plenty of physical RAM: swap is no longer load-bearing, so only the
    // soft zram recommendation remains.
    if f.ram_gib >= MEMORY_PLENTY_GIB {
        if !zram_ok {
            lines.push(
                format!("{} GiB zram is recommended to improve performance.", zram_recommended)
            );
        }
        return (if warn { CheckStatus::Warn } else { CheckStatus::Pass }, lines.join("\n"));
    }

    let swap_recommended = MEMORY_COMBINED_REQUIRED_GIB.saturating_sub(f.ram_gib);
    if swap_recommended > 0 && f.swap_gib < swap_recommended {
        lines.push(
            format!(
                "At least {} GiB swap is recommended to avoid out-of-memory crashes.",
                swap_recommended
            )
        );
        warn = true;
    }

    if !zram_ok {
        if f.zram_gib == 0 && f.zswap_enabled {
            lines.push(
                format!(
                    "Switching from zswap to {} GiB zram is recommended to improve performance.",
                    zram_recommended
                )
            );
        } else {
            lines.push(
                format!("{} GiB zram is recommended to improve performance.", zram_recommended)
            );
        }
    }

    (if warn { CheckStatus::Warn } else { CheckStatus::Pass }, lines.join("\n"))
}

/// Checks RAM, swap and zram against the LUG recommendations.
///
/// Star Citizen needs at least 16 GiB of physical RAM; below that the check
/// fails. Beyond that the recommendation is a combined 48 GiB of RAM + swap
/// plus a zram configuration sized to the machine - see `evaluate_memory`.
fn check_memory() -> CheckResult {
    let facts = read_memory_facts();
    let (status, detail) = evaluate_memory(&facts);

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

/// Minimum `vm.max_map_count` Star Citizen needs. See `check_mapcount` for why
/// this is 1,048,576 and not the 16,777,216 that older guides recommend.
const MAPCOUNT_REQUIRED: u64 = 1_048_576;

/// Checks the system limit vm.max_map_count.
///
/// Star Citizen needs at least 1,048,576 memory mappings. The value matches
/// what the LUG wiki lists as a prerequisite and what Fedora, Arch and Ubuntu
/// 24.04+ already ship by default. It replaces the 16,777,216 this app used to
/// demand: the game peaks at roughly 52,000 mappings, and a limit that high
/// lets a runaway process exhaust kernel memory (lug-helper issue #121).
///
/// The current value is read from /proc/sys/vm/max_map_count.
/// If the value is too low, it can be automatically fixed via `fix_mapcount()`.
fn check_mapcount() -> CheckResult {
    let required: u64 = MAPCOUNT_REQUIRED;

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

/// Parses the glibc version out of `ldd --version` output.
///
/// The version is the last field of the first line, in every packaging variant
/// seen in the wild:
///   `ldd (GNU libc) 2.41`
///   `ldd (Ubuntu GLIBC 2.39-0ubuntu8.3) 2.39`
fn parse_glibc_version(stdout: &str) -> Option<String> {
    let last = stdout.lines().next()?.split_whitespace().last()?;
    // Guard against unexpected formats - the version has to start with a digit.
    last.chars().next().filter(char::is_ascii_digit)?;
    Some(last.to_string())
}

/// Returns the system's glibc version, or `None` if `ldd` is unavailable or
/// prints something unexpected.
///
/// Wine runners are dynamically linked against glibc; running one built for a
/// newer glibc fails with `could not load ntdll.so ... GLIBC_x.xx not found`,
/// which looks like a broken runner rather than a system mismatch.
pub fn system_glibc() -> Option<String> {
    let output = Command::new("ldd").arg("--version").env("LC_ALL", "C").output().ok()?;
    parse_glibc_version(&String::from_utf8_lossy(&output.stdout))
}

/// Path of the udev rules file that grants raw HID access to HOTAS devices.
const JOYSTICK_RULES_PATH: &str = "/etc/udev/rules.d/40-starcitizen-joystick-uaccess.rules";

/// USB vendor IDs of HOTAS manufacturers, with the label written into the rule file.
///
/// lug-helper covers the first three; the rest come from the workaround in its
/// issue #137, which found Logitech/Saitek and WinWing sticks equally affected.
const JOYSTICK_VENDORS: &[(&str, &str)] = &[
    ("231d", "VKB"),
    ("3344", "Virpil"),
    ("044f", "Thrustmaster"),
    ("06a3", "Saitek"),
    ("046d", "Logitech"),
    ("4098", "WinWing"),
];

/// Builds the contents of the joystick udev rules file.
///
/// One line per vendor instead of lug-helper's `"231d|3344|044f"` alternation:
/// easier to read and independent of the systemd version that started
/// supporting alternation inside `ATTRS{}`.
///
/// The vendor name goes on its own comment line above each rule. udev has no
/// inline comments - a trailing `# VKB` makes it reject the whole rule, which
/// is how a file can look correct and do nothing (lug-helper issue #137).
fn joystick_rules_content() -> String {
    let mut out = String::from(
        "# Created by Penguin Citizen\n\
         # Tag HOTAS devices with uaccess so Wine can read them through hidraw\n"
    );
    for (vendor_id, label) in JOYSTICK_VENDORS {
        out.push_str(
            &format!(
                "\n# {}\nKERNEL==\"hidraw*\", ATTRS{{idVendor}}==\"{}\", MODE=\"0660\", TAG+=\"uaccess\"\n",
                label,
                vendor_id
            )
        );
    }
    out
}

/// Returns true if the given rules file body contains a usable hidraw rule.
///
/// The file existing is not enough: lug-helper v4.13 shipped a bug that wrote
/// only the comment header, leaving users with a file that looked correct and
/// did nothing (its issue #137).
fn has_hidraw_rule(contents: &str) -> bool {
    contents.lines().any(|line| {
        let line = line.trim_start();
        !line.starts_with('#') && line.contains("hidraw")
    })
}

/// Checks whether the joystick hidraw udev rules are installed.
///
/// Star Citizen reads HOTAS devices through `hidraw`, which a normal user
/// cannot open unless udev tags the device with `uaccess`. Without the rules
/// the sticks are simply invisible in-game (lug-helper issues #119, #124, #137).
///
/// Reports Warn rather than Fail: a system without a HOTAS does not need the
/// rules, and a missing rule must not block the install wizard.
fn check_joystick_rules() -> CheckResult {
    let contents = fs::read_to_string(JOYSTICK_RULES_PATH).unwrap_or_default();

    let (status, detail) = if has_hidraw_rule(&contents) {
        (CheckStatus::Pass, format!("udev rules installed at {}", JOYSTICK_RULES_PATH))
    } else if contents.trim().is_empty() {
        (
            CheckStatus::Warn,
            "No hidraw udev rules found. Joysticks (VKB, Virpil, Thrustmaster, ...) may not be detected in-game.".into(),
        )
    } else {
        (
            CheckStatus::Warn,
            format!("{} exists but contains no hidraw rule.", JOYSTICK_RULES_PATH),
        )
    };

    let fixable = status == CheckStatus::Warn;

    CheckResult {
        id: "joystick".into(),
        name: "Joystick Permissions".into(),
        status,
        detail,
        fixable,
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
/// Example: 1048576 -> "1,048,576"
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
/// Synchronous version of the monitor detection cascade.
/// Used by `load_config` to migrate stale `primary_monitor` values at app startup.
pub fn detect_monitors_sync() -> Vec<MonitorInfo> {
    let session_type = std::env::var("XDG_SESSION_TYPE").unwrap_or_default();
    let is_wayland = session_type == "wayland";
    log::info!(
        "[detect_monitors] XDG_SESSION_TYPE={:?}, is_wayland={}",
        session_type,
        is_wayland
    );

    if is_wayland {
        match detect_monitors_kscreen() {
            Some(m) if !m.is_empty() => {
                log::info!(
                    "[detect_monitors] kscreen-doctor returned {} monitors: {:?}",
                    m.len(),
                    m.iter().map(|x| &x.name).collect::<Vec<_>>()
                );
                return m;
            }
            Some(_) => log::info!("[detect_monitors] kscreen-doctor returned 0 monitors"),
            None => log::info!("[detect_monitors] kscreen-doctor unavailable or failed"),
        }
        match detect_monitors_gnome() {
            Some(m) if !m.is_empty() => {
                log::info!("[detect_monitors] gnome-monitor-config returned {} monitors", m.len());
                return m;
            }
            Some(_) => log::info!("[detect_monitors] gnome-monitor-config returned 0 monitors"),
            None => log::info!("[detect_monitors] gnome-monitor-config unavailable or failed"),
        }
        match detect_monitors_wlr_randr() {
            Some(m) if !m.is_empty() => {
                log::info!("[detect_monitors] wlr-randr returned {} monitors", m.len());
                return m;
            }
            Some(_) => log::info!("[detect_monitors] wlr-randr returned 0 monitors"),
            None => log::info!("[detect_monitors] wlr-randr unavailable or failed"),
        }
    }

    // Fallback: xrandr works on X11 and via XWayland
    let xr = detect_monitors_xrandr();
    log::info!("[detect_monitors] xrandr returned {} monitors", xr.len());
    xr
}

#[tauri::command]
pub async fn detect_monitors() -> Result<Vec<MonitorInfo>, String> {
    tokio::task::spawn_blocking(detect_monitors_sync)
        .await
        .map_err(|e| format!("Task failed: {}", e))
}

/// Maximum time to wait for a monitor detection subprocess.
const MONITOR_DETECT_TIMEOUT: Duration = Duration::from_secs(5);

/// Runs a command with a timeout. Returns `None` if the command is not found,
/// fails to start, times out, or exits with a non-zero status.
fn run_with_timeout(mut cmd: Command) -> Option<std::process::Output> {
    let program = format!("{:?}", cmd.get_program());
    // Pipe stdout/stderr so wait_with_output() can capture them. Without this
    // the default is Stdio::inherit() and wait_with_output returns empty buffers,
    // so the parser sees nothing even when the command succeeded.
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped()).stdin(Stdio::null());
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            log::warn!("[detect_monitors] spawn {} failed: {}", program, e);
            return None;
        }
    };
    let start = std::time::Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_status)) => {
                let result = child.wait_with_output().ok();
                if let Some(ref o) = result {
                    if !o.status.success() {
                        log::info!(
                            "[detect_monitors] {} exited with {:?}, stderr: {}",
                            program,
                            o.status.code(),
                            String::from_utf8_lossy(&o.stderr).trim()
                        );
                    }
                }
                return result.filter(|o| o.status.success());
            }
            Ok(None) => {
                if start.elapsed() >= MONITOR_DETECT_TIMEOUT {
                    log::warn!("[detect_monitors] {} timed out, killing process", program);
                    let _ = child.kill();
                    let _ = child.wait();
                    return None;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(_) => return None,
        }
    }
}

/// KDE Plasma Wayland: Monitor detection via `kscreen-doctor --outputs`.
///
/// Parses the output of kscreen-doctor, which may contain ANSI escape sequences.
/// Only enabled and connected outputs are considered.
fn detect_monitors_kscreen() -> Option<Vec<MonitorInfo>> {
    let mut cmd = Command::new("kscreen-doctor");
    cmd.arg("--outputs").env("LANG", "C");
    let output = run_with_timeout(cmd)?;

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
    let mut cmd = Command::new("gnome-monitor-config");
    cmd.arg("list");
    let output = run_with_timeout(cmd)?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let lines: Vec<&str> = stdout.lines().collect();
    let mut monitors = Vec::new();

    let mut current_primary;
    let mut current_scale: Option<f64>;
    let mut i = 0;
    while i < lines.len() {
        let line = lines[i];
        if line.starts_with("Logical monitor") {
            // "PRIMARY" at the end of the line marks the main monitor
            current_primary = line.contains("PRIMARY");
            // Parse scale from "scale=X" (e.g., "scale=1.5")
            current_scale = line.split_whitespace()
                .find(|token| token.starts_with("scale="))
                .and_then(|token| token.strip_prefix("scale="))
                .and_then(|val| val.parse::<f64>().ok());
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
                        scale: current_scale,
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
    let output = run_with_timeout(Command::new("wlr-randr"))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let lines: Vec<&str> = stdout.lines().collect();
    let mut monitors = Vec::new();

    let mut current_name = String::new();
    let mut current_resolution = String::new();
    let mut current_scale: Option<f64> = None;

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
                    scale: current_scale,
                });
            }
            current_name = trimmed.split_whitespace().next().unwrap_or("").to_string();
            current_resolution = String::new();
            current_scale = None;
        } else if current_resolution.is_empty() && trimmed.contains("current") {
            // Indented line with "current" contains the active resolution
            // Format: "  2560x1440 px, 59.951 Hz (current)"
            if let Some(res) = trimmed.split_whitespace().next() {
                current_resolution = res.to_string();
            }
        } else if trimmed.starts_with("Scale:") {
            // Format: "  Scale: 1.500000"
            current_scale = trimmed.strip_prefix("Scale:")
                .and_then(|val| val.trim().parse::<f64>().ok());
        }
    }

    // Don't forget the last monitor
    if !current_name.is_empty() {
        monitors.push(MonitorInfo {
            name: current_name,
            resolution: current_resolution,
            primary: monitors.is_empty(),
            scale: current_scale,
        });
    }

    Some(monitors)
}

/// X11/XWayland fallback: Monitor detection via `xrandr --query`.
///
/// Searches for lines with " connected" and finds the active resolution
/// (marked with *) in the subsequent mode lines.
fn detect_monitors_xrandr() -> Vec<MonitorInfo> {
    let output = match run_with_timeout({
        let mut cmd = Command::new("xrandr");
        cmd.arg("--query");
        cmd
    }) {
        Some(o) => o,
        None => return Vec::new(),
    };

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
/// The checks include: memory, AVX, max_map_count, file descriptor limit,
/// Vulkan, joystick udev rules, and disk space.
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
                check_joystick_rules(),
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

/// Runs a root shell command through pkexec and turns the outcome into a
/// `FixResult`.
///
/// Shared by every automatic fix: they all write one config file as root and
/// reload the corresponding subsystem, and they all have to tell an
/// authentication cancel apart from a real failure.
///
/// `manual_hint` is what the user is told when pkexec is not installed - it
/// should contain the equivalent commands to run by hand.
fn run_pkexec_fix(script: &str, manual_hint: &str, success_message: &str) -> FixResult {
    // pkexec is the graphical sudo alternative; without it there is no way to
    // ask for a password from a GUI app.
    if !Path::new("/usr/bin/pkexec").exists() {
        return FixResult {
            success: false,
            message: manual_hint.into(),
        };
    }

    match Command::new("pkexec").arg("sh").arg("-c").arg(script).output() {
        Ok(output) if output.status.success() =>
            FixResult {
                success: true,
                message: success_message.into(),
            },
        Ok(output) => {
            let code = output.status.code().unwrap_or(-1);
            // Exit code 126/127: user dismissed the authentication dialog
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
        Err(e) =>
            FixResult {
                success: false,
                message: format!("Failed to execute pkexec: {}", e),
            },
    }
}

/// Fixes a too-low vm.max_map_count by creating a sysctl configuration file.
///
/// Creates `/etc/sysctl.d/99-starcitizen-max_map_count.conf` with the value 1,048,576
/// and applies the setting immediately. The change persists across reboots.
/// Uses pkexec for the graphical password prompt (root privileges required).
#[tauri::command]
pub async fn fix_mapcount() -> Result<FixResult, String> {
    tokio::task
        ::spawn_blocking(move || {
            run_pkexec_fix(
                "printf 'vm.max_map_count = 1048576\\n' > /etc/sysctl.d/99-starcitizen-max_map_count.conf && sysctl --quiet --system",
                "pkexec not found. Manually run: sudo sysctl -w vm.max_map_count=1048576 && echo 'vm.max_map_count = 1048576' | sudo tee /etc/sysctl.d/99-starcitizen-max_map_count.conf",
                "vm.max_map_count set to 1,048,576 (persistent)"
            )
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
            run_pkexec_fix(
                "mkdir -p /etc/systemd/system.conf.d && printf '[Manager]\\nDefaultLimitNOFILE=524288\\n' > /etc/systemd/system.conf.d/99-starcitizen-filelimit.conf && systemctl daemon-reexec",
                "pkexec not found. Manually create /etc/systemd/system.conf.d/99-starcitizen-filelimit.conf with:\n[Manager]\nDefaultLimitNOFILE=524288",
                "File descriptor limit set to 524,288 (persistent, effective after re-login)"
            )
        }).await
        .map_err(|e| format!("Task failed: {}", e))
}

/// Installs the joystick hidraw udev rules and reloads udev.
///
/// Writes the vendor list from `JOYSTICK_VENDORS` to `JOYSTICK_RULES_PATH`,
/// then reloads the rules and re-triggers matching devices so the change takes
/// effect without a reboot. Devices that are already plugged in still need to
/// be reconnected for the ACL to be applied - the returned message says so.
/// Uses pkexec for the graphical password prompt (root privileges required).
#[tauri::command]
pub async fn fix_joystick_rules() -> Result<FixResult, String> {
    tokio::task
        ::spawn_blocking(move || {
            // The rules are written through a quoted heredoc so nothing in the
            // body is expanded by the root shell.
            let script = format!(
                "mkdir -p /etc/udev/rules.d && cat > {path} <<'PENGUIN_CITIZEN_EOF'\n\
                 {body}\
                 PENGUIN_CITIZEN_EOF\n\
                 udevadm control --reload-rules && udevadm trigger --subsystem-match=hidraw",
                path = JOYSTICK_RULES_PATH,
                body = joystick_rules_content()
            );

            run_pkexec_fix(
                &script,
                &format!(
                    "pkexec not found. Manually create {} with:\n\n{}",
                    JOYSTICK_RULES_PATH,
                    joystick_rules_content()
                ),
                "Joystick udev rules installed. Unplug and replug your devices for the change to take effect."
            )
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

/// GPU vendor and device information.
#[derive(Serialize, Deserialize, Clone)]
pub struct GpuInfo {
    /// GPU vendor: "nvidia", "amd", "intel", or "unknown"
    pub vendor: String,
    /// Human-readable GPU name (e.g. "NVIDIA GeForce RTX 4070")
    pub name: String,
}

/// Reads the PCI vendor and device id of the first discrete-capable GPU,
/// formatted as sysfs reports them (e.g. `("0x10de", "0x2704")`).
///
/// The Mesa VRAM report layer needs both to know which device to limit.
/// Returns `None` when sysfs has no usable entry, in which case the caller
/// applies the limit without a device filter.
pub fn primary_gpu_pci_ids() -> Option<(String, String)> {
    let entries = std::fs::read_dir("/sys/class/drm").ok()?;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        // Skip connectors ("card0-DP-1") and non-card entries
        if !name.starts_with("card") || name.contains('-') {
            continue;
        }
        let device_dir = entry.path().join("device");
        let vendor = std::fs::read_to_string(device_dir.join("vendor")).ok()?;
        let device = std::fs::read_to_string(device_dir.join("device")).ok()?;
        let vendor = vendor.trim();
        // Only the three GPU vendors we know how to interpret
        if !matches!(vendor, "0x10de" | "0x1002" | "0x8086") {
            continue;
        }
        return Some((vendor.to_string(), device.trim().to_string()));
    }
    None
}

/// Detects the primary GPU vendor by reading /sys/class/drm/.
/// Falls back to `lspci` if sysfs is not available.
#[tauri::command]
pub async fn detect_gpu_vendor() -> Result<GpuInfo, String> {
    tokio::task::spawn_blocking(|| {
        // Try sysfs first: /sys/class/drm/card*/device/vendor
        if let Ok(entries) = std::fs::read_dir("/sys/class/drm") {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                if !name.starts_with("card") || name.contains('-') {
                    continue;
                }
                let vendor_path = entry.path().join("device/vendor");
                if let Ok(vendor_id) = std::fs::read_to_string(&vendor_path) {
                    let vendor_id = vendor_id.trim();
                    let vendor = match vendor_id {
                        "0x10de" => "nvidia",
                        "0x1002" => "amd",
                        "0x8086" => "intel",
                        _ => continue,
                    };
                    let gpu_name = get_gpu_name_lspci().unwrap_or_else(|| vendor.to_uppercase());
                    return Ok(GpuInfo {
                        vendor: vendor.to_string(),
                        name: gpu_name,
                    });
                }
            }
        }

        // Fallback: lspci
        if let Ok(output) = std::process::Command::new("lspci").output() {
            let stdout = String::from_utf8_lossy(&output.stdout);
            for line in stdout.lines() {
                if line.contains("VGA") || line.contains("3D controller") {
                    let lower = line.to_lowercase();
                    let vendor = if lower.contains("nvidia") {
                        "nvidia"
                    } else if lower.contains("amd") || lower.contains("radeon") {
                        "amd"
                    } else if lower.contains("intel") {
                        "intel"
                    } else {
                        continue
                    };
                    let name = line.split(':').nth(2).unwrap_or(line).trim().to_string();
                    return Ok(GpuInfo {
                        vendor: vendor.to_string(),
                        name,
                    });
                }
            }
        }

        Ok(GpuInfo {
            vendor: "unknown".to_string(),
            name: "Unknown GPU".to_string(),
        })
    })
    .await
    .map_err(|e| format!("GPU detection failed: {}", e))?
}

/// Helper: Extracts the GPU device name from lspci output.
fn get_gpu_name_lspci() -> Option<String> {
    let output = std::process::Command::new("lspci").output().ok()?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    for line in stdout.lines() {
        if line.contains("VGA") || line.contains("3D controller") {
            return Some(line.split(':').nth(2)?.trim().to_string());
        }
    }
    None
}

/// Returns a list of Vulkan device names from `vulkaninfo --summary`.
/// Used to populate the GPU device filter dropdown.
#[tauri::command]
pub async fn detect_vulkan_devices() -> Result<Vec<String>, String> {
    tokio::task::spawn_blocking(|| {
        let output = std::process::Command::new("vulkaninfo")
            .arg("--summary")
            .output()
            .map_err(|e| format!("vulkaninfo not found: {}", e))?;

        let stdout = String::from_utf8_lossy(&output.stdout);
        let devices: Vec<String> = stdout
            .lines()
            .filter(|line| line.contains("deviceName"))
            .filter_map(|line| {
                line.split('=').nth(1).map(|s| s.trim().to_string())
            })
            .collect();

        Ok(devices)
    })
    .await
    .map_err(|e| format!("Vulkan device detection failed: {}", e))?
}

/// Checks whether gamescope is installed and available in $PATH.
#[tauri::command]
pub async fn check_gamescope_installed() -> bool {
    std::process::Command::new("which")
        .arg("gamescope")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Checks whether gamemoderun (Feral GameMode) is installed and available in $PATH.
#[tauri::command]
pub async fn check_gamemode_installed() -> bool {
    std::process::Command::new("which")
        .arg("gamemoderun")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn facts(ram: u64, swap: u64, zram: u64, zswap: bool) -> MemoryFacts {
        MemoryFacts { ram_gib: ram, swap_gib: swap, zram_gib: zram, zswap_enabled: zswap }
    }

    // --- memory ---

    #[test]
    fn memory_fails_below_minimum_ram() {
        // 8 GiB cannot be rescued by any amount of swap
        let (status, detail) = evaluate_memory(&facts(8, 64, 8, false));
        assert_eq!(status, CheckStatus::Fail);
        assert!(detail.contains("16 GiB RAM is required"), "{detail}");
    }

    #[test]
    fn memory_tolerates_two_gib_of_rounding() {
        // 15 GiB reported for a 16 GiB machine still passes the minimum
        let (status, _) = evaluate_memory(&facts(15, 34, 15, false));
        assert_eq!(status, CheckStatus::Pass);
    }

    #[test]
    fn memory_passes_with_plenty_of_ram_and_no_swap() {
        // 64 GiB: swap is no longer load-bearing, zram sized ram/4
        let (status, detail) = evaluate_memory(&facts(64, 0, 16, false));
        assert_eq!(status, CheckStatus::Pass);
        assert!(!detail.contains("recommended"), "{detail}");
    }

    #[test]
    fn memory_notes_missing_zram_but_still_passes_with_plenty_of_ram() {
        let (status, detail) = evaluate_memory(&facts(64, 0, 0, false));
        assert_eq!(status, CheckStatus::Pass);
        assert!(detail.contains("16 GiB zram is recommended"), "{detail}");
    }

    #[test]
    fn memory_warns_when_zram_and_zswap_are_both_enabled() {
        let (status, detail) = evaluate_memory(&facts(64, 0, 16, true));
        assert_eq!(status, CheckStatus::Warn);
        assert!(detail.contains("disable zswap"), "{detail}");
    }

    #[test]
    fn memory_passes_with_sufficient_zram_and_swap() {
        // 32 GiB RAM: 16 GiB swap reaches the 48 GiB combined target, and the
        // wiki recommends zram = ram below 48 GiB
        let (status, detail) = evaluate_memory(&facts(32, 16, 32, false));
        assert_eq!(status, CheckStatus::Pass);
        assert!(!detail.contains("recommended"), "{detail}");
    }

    #[test]
    fn memory_warns_on_insufficient_swap() {
        let (status, detail) = evaluate_memory(&facts(32, 4, 16, false));
        assert_eq!(status, CheckStatus::Warn);
        assert!(detail.contains("16 GiB swap is recommended"), "{detail}");
    }

    #[test]
    fn memory_notes_missing_zram_without_warning() {
        // Swap alone reaches the target, so this is a pass with a tuning note
        let (status, detail) = evaluate_memory(&facts(32, 16, 0, false));
        assert_eq!(status, CheckStatus::Pass);
        assert!(detail.contains("32 GiB zram is recommended"), "{detail}");
    }

    #[test]
    fn memory_suggests_replacing_zswap_with_zram() {
        let (status, detail) = evaluate_memory(&facts(32, 16, 0, true));
        assert_eq!(status, CheckStatus::Pass);
        assert!(detail.contains("Switching from zswap"), "{detail}");
    }

    #[test]
    fn memory_detail_lists_ram_zram_and_swap_separately() {
        let (_, detail) = evaluate_memory(&facts(32, 16, 8, false));
        assert!(detail.starts_with("32 GiB RAM, 8 GiB zram, 16 GiB swap"), "{detail}");
    }

    #[test]
    fn zram_recommendation_scales_with_ram() {
        assert_eq!(recommended_zram_gib(16), 16); // small: ram
        assert_eq!(recommended_zram_gib(32), 32); // still below the combined target
        assert_eq!(recommended_zram_gib(48), 24); // at the target: ram/2
        assert_eq!(recommended_zram_gib(64), 16); // plenty: ram/4
    }

    #[test]
    fn kib_rounds_to_nearest_gib() {
        assert_eq!(kib_to_gib(0), 0);
        assert_eq!(kib_to_gib(16 * 1024 * 1024), 16);
        // 15.7 GiB, what the kernel reports for a 16 GiB machine
        assert_eq!(kib_to_gib(16_384_000), 16);
    }

    // --- glibc ---

    #[test]
    fn glibc_version_parses_common_ldd_formats() {
        assert_eq!(
            parse_glibc_version("ldd (GNU libc) 2.41\nCopyright ...\n").as_deref(),
            Some("2.41")
        );
        assert_eq!(
            parse_glibc_version("ldd (Ubuntu GLIBC 2.39-0ubuntu8.3) 2.39\n").as_deref(),
            Some("2.39")
        );
    }

    #[test]
    fn glibc_version_rejects_unexpected_output() {
        assert_eq!(parse_glibc_version(""), None);
        assert_eq!(parse_glibc_version("musl libc (x86_64)\n"), None);
    }

    // --- joystick udev rules ---

    #[test]
    fn hidraw_rule_detection_ignores_comments() {
        // The exact file lug-helper v4.13 produced: header only, no rule
        assert!(
            !has_hidraw_rule(
                "# Set the uaccess tag for raw HID access for VKB/Virpil/Thrustmaster devices in Wine\n"
            )
        );
        assert!(!has_hidraw_rule(""));
        assert!(
            has_hidraw_rule(
                "# comment\nKERNEL==\"hidraw*\", ATTRS{idVendor}==\"3344\", TAG+=\"uaccess\"\n"
            )
        );
    }

    /// The generated file has to satisfy udev itself, not just our own parser.
    /// This is the check that caught an inline `# VKB` comment behind each rule
    /// making udev discard all of them - a file that looks right and does
    /// nothing, exactly the failure mode of lug-helper issue #137.
    #[test]
    fn generated_rules_pass_udevadm_verify() {
        let Ok(dir) = std::env::var("CARGO_TARGET_TMPDIR").map(std::path::PathBuf::from).or_else(
            |_| Ok::<_, std::env::VarError>(std::env::temp_dir())
        ) else {
            return;
        };
        let path = dir.join("40-penguin-citizen-joystick-test.rules");
        if std::fs::write(&path, joystick_rules_content()).is_err() {
            return;
        }

        let output = match Command::new("udevadm").arg("verify").arg(&path).output() {
            Ok(o) => o,
            // No udevadm on this machine (containers, non-systemd): nothing to check
            Err(_) => {
                let _ = std::fs::remove_file(&path);
                return;
            }
        };
        let _ = std::fs::remove_file(&path);

        assert!(
            output.status.success(),
            "udevadm rejected the generated rules:\n{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[test]
    fn generated_rules_cover_every_vendor_and_parse_back() {
        let content = joystick_rules_content();
        assert!(has_hidraw_rule(&content));
        for (vendor_id, _) in JOYSTICK_VENDORS {
            assert!(content.contains(vendor_id), "missing vendor {vendor_id} in:\n{content}");
        }
        // One rule line per vendor, plus the two comment header lines
        assert_eq!(content.lines().filter(|l| l.starts_with("KERNEL==")).count(), JOYSTICK_VENDORS.len());
    }
}
