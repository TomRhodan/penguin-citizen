// Penguin Citizen - Star Citizen Linux Manager
// Copyright (C) 2024-2026 TomRhodan <tomrhodan@gmail.com>
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.

//! Startup workaround for the Tauri/WebKitGTK + NVIDIA + Wayland crash.
//!
//! Affected setup: WebKitGTK's DMABUF renderer is incompatible with NVIDIA's
//! Wayland driver, leading to `Gdk-Message: Error 71 (Protocol error)
//! dispatching to Wayland display` and an immediate crash before the main
//! window is shown. Setting `WEBKIT_DISABLE_DMABUF_RENDERER=1` in the
//! process environment **before** WebKitGTK initializes forces the safer
//! GL renderer path and avoids the crash.
//!
//! References:
//! - <https://github.com/TomRhodan/penguin-citizen/issues/5>
//! - <https://github.com/tauri-apps/tauri/issues/10702>
//!
//! The workaround is applied conditionally so AMD/Intel users keep the
//! faster DMABUF path. Two override env vars are honored for support cases:
//!
//! - `PENGUIN_FORCE_DMABUF=1`   — never apply (force-keep DMABUF on NVIDIA)
//! - `PENGUIN_DISABLE_DMABUF=1` — always apply (force-disable DMABUF)
//!
//! NOTE: `std::env::set_var` is safe in Rust edition 2021 (used here). If
//! this crate is ever migrated to edition 2024 the calls below must be
//! wrapped in `unsafe { }`.

use serde::Serialize;
use std::sync::OnceLock;

/// Reason key matching the i18n suffixes in `locales/{de,en}/about.json`
/// under `about:webkit.reason.*`. The frontend translates these on render.
pub mod reason_key {
    pub const NVIDIA_WAYLAND: &str = "nvidiaWayland";
    pub const NOT_NEEDED: &str = "notNeeded";
    pub const FORCE_OFF: &str = "forceOff";
    pub const FORCE_ON: &str = "forceOn";
}

#[derive(Serialize, Clone, Debug)]
pub struct WebKitWorkaroundStatus {
    /// Whether `WEBKIT_DISABLE_DMABUF_RENDERER=1` was set at startup.
    pub applied: bool,
    /// One of the keys from [`reason_key`]; frontend looks up the
    /// localized string under `about:webkit.reason.<reason>`.
    pub reason: String,
    /// "nvidia" | "amd" | "intel" | "unknown"
    pub gpu_vendor: String,
    /// Whether `WAYLAND_DISPLAY` was non-empty at startup.
    pub wayland: bool,
}

static STATUS: OnceLock<WebKitWorkaroundStatus> = OnceLock::new();

/// Reads `/sys/class/drm/card*/device/vendor` and maps the PCI vendor ID to a
/// short string. Unlike [`crate::system_check::detect_gpu_vendor`] there is
/// no `lspci` fallback — startup-critical code cannot afford to spawn a
/// subprocess. Returns `"unknown"` if no GPU could be identified.
fn detect_gpu_vendor_sync() -> &'static str {
    let Ok(entries) = std::fs::read_dir("/sys/class/drm") else {
        return "unknown";
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        // Skip connector entries like "card0-DP-1"; we only want the cards.
        if !name.starts_with("card") || name.contains('-') {
            continue;
        }
        let vendor_path = entry.path().join("device/vendor");
        let Ok(vendor_id) = std::fs::read_to_string(&vendor_path) else {
            continue;
        };
        match vendor_id.trim() {
            "0x10de" => return "nvidia",
            "0x1002" => return "amd",
            "0x8086" => return "intel",
            _ => continue,
        }
    }
    "unknown"
}

/// Applies the WebKit DMABUF workaround if the running environment matches
/// the known-broken setup (NVIDIA + Wayland), honoring user overrides.
///
/// Must be called **after** `init_logging()` (so the decision is logged) and
/// **before** `tauri::Builder::default()` (so WebKitGTK reads the env var
/// before initialization).
pub fn apply() {
    let wayland = !std::env::var("WAYLAND_DISPLAY").unwrap_or_default().is_empty();
    let vendor = detect_gpu_vendor_sync();
    let force_off = env_is_one("PENGUIN_FORCE_DMABUF");
    let force_on = env_is_one("PENGUIN_DISABLE_DMABUF");

    let (applied, reason) = if force_off {
        (false, reason_key::FORCE_OFF)
    } else if force_on {
        (true, reason_key::FORCE_ON)
    } else if vendor == "nvidia" && wayland {
        (true, reason_key::NVIDIA_WAYLAND)
    } else {
        (false, reason_key::NOT_NEEDED)
    };

    log::info!(
        "WebKit workaround decision: gpu={} wayland={} force_off={} force_on={} applied={} reason={}",
        vendor, wayland, force_off, force_on, applied, reason
    );

    if applied {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
        log::info!(
            "Set WEBKIT_DISABLE_DMABUF_RENDERER=1 \
             (see https://github.com/tauri-apps/tauri/issues/10702)"
        );
    }

    let _ = STATUS.set(WebKitWorkaroundStatus {
        applied,
        reason: reason.to_string(),
        gpu_vendor: vendor.to_string(),
        wayland,
    });
}

/// Returns the decision made by [`apply`]. If `apply` was never called
/// (shouldn't happen in production, only in tests), returns a sentinel
/// "unknown" status with `applied=false`.
pub fn status() -> WebKitWorkaroundStatus {
    STATUS
        .get()
        .cloned()
        .unwrap_or_else(|| WebKitWorkaroundStatus {
            applied: false,
            reason: reason_key::NOT_NEEDED.to_string(),
            gpu_vendor: "unknown".to_string(),
            wayland: false,
        })
}

fn env_is_one(key: &str) -> bool {
    std::env::var(key).ok().as_deref() == Some("1")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detect_gpu_vendor_sync_returns_known_string() {
        // We can't assert a specific vendor (CI may have no GPU at all), but
        // the result must always be one of the documented values.
        let v = detect_gpu_vendor_sync();
        assert!(
            matches!(v, "nvidia" | "amd" | "intel" | "unknown"),
            "unexpected vendor string: {v}"
        );
    }
}
