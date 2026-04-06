# Wayland Section Robustness Overhaul

**Date:** 2026-04-06
**Status:** Draft

## Context

The Wayland section on the Launch page has three intermittent bugs that stem from race conditions in async monitor detection, incomplete scale-factor parsing, and an overly broad fractional-scaling check:

1. **Wayland checkbox unchecks itself** when "Starten" is pressed — caused by `detect_monitors()` resolving late and calling `renderPage()` with `wayland = false` due to fractional scaling logic.
2. **Monitor selector renders as text input** instead of dropdown — the initial render happens before `detect_monitors()` completes, and subsequent `renderPage()` calls from other async detections (GPU, Vulkan) can overwrite the patched dropdown.
3. **Fractional scaling disables Wayland too aggressively** — blocks integer scaling (2.0x) which works fine; also only detects scale on KDE (kscreen-doctor), leaving GNOME/wlroots unprotected.

## Design

### 1. Eliminate Race Conditions: Skeleton Until Monitors Ready

**Problem:** `renderWaylandCardBody()` renders immediately with stale data. Async `detect_monitors()` calls `updateMonitorSelect()` or `renderPage()` later, causing UI state corruption.

**Solution:** Wayland card body shows a skeleton placeholder until monitor detection completes. All other cards render normally.

- Add module-level flag: `let monitorsReady = false`
- `renderWaylandCardBody()` returns skeleton HTML when `!monitorsReady`
- `detect_monitors()` callback sets `monitorsReady = true` and calls `renderPage()` once
- No more `updateMonitorSelect()` — single render path eliminates the patching race
- Remove `updateMonitorSelect()` and `bindMonitorSelectListener()` — bind events in `bindEvents()` like all other controls

**Files:** `src/pages/launch.js`

### 2. Fix Fractional Scaling Detection

**Problem:** `hasFractionalScaling()` uses `Math.abs(m.scale - 1.0) > 0.01` which catches integer scales like 2.0x. Also, `scale` is only populated by `kscreen-doctor` (KDE).

**Solution:** Two changes:

**a) Fix the check — only block true fractional values:**
```js
function hasFractionalScaling() {
  return detectedMonitors.some(m => {
    if (m.scale == null || m.scale <= 0) return false;
    // Integer scales (1.0, 2.0, 3.0) are fine; fractional (1.25, 1.5) are not
    return Math.abs(m.scale - Math.round(m.scale)) > 0.01;
  });
}
```

**b) Parse scale from all compositors (backend):**

- **GNOME** (`detect_monitors_gnome`): The `Logical monitor` line already contains `scale=X`. Parse it and assign to all outputs under that logical monitor.
  ```
  Logical monitor 0: x=0 y=0 scale=1.5 transform=normal PRIMARY
  ```
  Extract the number after `scale=`.

- **wlroots** (`detect_monitors_wlr_randr`): `wlr-randr` outputs `Scale: X.XXXXXX` as an indented line per monitor. Parse it.
  ```
  DP-1 "Monitor Name"
    ...
    Scale: 1.500000
  ```

- **xrandr fallback**: No scale info available — leave as `None` (safe default: Wayland not blocked).

**Files:** `src-tauri/src/system_check.rs` (functions `detect_monitors_gnome`, `detect_monitors_wlr_randr`)

### 3. UI-Only Blocking (Don't Mutate Config)

**Problem:** Current code sets `launchConfig.performance.wayland = false` when fractional scaling is detected ([launch.js:211-213](src/pages/launch.js#L211-L213)). This mutates the saved config, so Wayland stays off even after the user changes their scaling.

**Solution:**
- Remove the config mutation in the `detect_monitors` callback
- `renderWaylandCardBody()` already handles the visual blocking (disabled + `toggle-blocked` class) — keep that
- At launch time (`configure_wine_env` in Rust), the backend should respect `wayland = true` from config as-is. The frontend is responsible for showing the user that it's effectively blocked. However, as a safety net, the backend can also check for fractional scaling and log a warning if Wayland is enabled with fractional scaling.
- When user disables fractional scaling later, the saved `wayland = true` kicks in immediately — no manual re-enable needed

**Files:** `src/pages/launch.js` (remove lines 210-215 from `loadAndCheck`)

### 4. Monitor Dropdown Always (No Silent Text Input Fallback)

**Problem:** When `detectedMonitors.length === 0`, a text input is silently rendered. Users don't know why they're typing instead of selecting.

**Solution:**
- When monitors detected: dropdown with primary monitor pre-selected
- Pre-selection logic: if `perf.primary_monitor` matches a detected monitor, select that. Otherwise, select the first monitor with `primary: true`. If none is primary, select the first monitor.
- When no monitors detected AND `monitorsReady === true`: show a disabled dropdown with a single option "Erkennung fehlgeschlagen" and a small fallback text input below with explanation
- The monitor-enable checkbox stays — unchecking it means "let the runner auto-detect" (no `primary_monitor` env var set)

**Files:** `src/pages/launch.js` (`renderMonitorSelect`)

### 5. Add `PROTON_WAYLAND_MONITOR` Support

**Problem:** The backend only sets `WAYLANDDRV_PRIMARY_MONITOR`. Newer GE-Proton (10-34+) uses `PROTON_WAYLAND_MONITOR`.

**Solution:** Set both env vars when a primary monitor is configured:
```rust
if let Some(ref monitor) = perf.primary_monitor {
    env.insert("WAYLANDDRV_PRIMARY_MONITOR".into(), monitor.clone());
    env.insert("PROTON_WAYLAND_MONITOR".into(), monitor.clone());
}
```

Also add `PROTON_WAYLAND_MONITOR` to the `BUILTIN_ENV_VARS` set in the frontend.

**Files:** `src-tauri/src/installer.rs`, `src/pages/launch.js` (BUILTIN_ENV_VARS)

## Files to Modify

| File | Changes |
|------|---------|
| `src/pages/launch.js` | Skeleton rendering, remove config mutation, fix `hasFractionalScaling()`, always-dropdown, remove `updateMonitorSelect()`/`bindMonitorSelectListener()`, add `PROTON_WAYLAND_MONITOR` to BUILTIN_ENV_VARS |
| `src-tauri/src/system_check.rs` | Parse scale from GNOME (`scale=X`) and wlroots (`Scale: X.XX`) |
| `src-tauri/src/installer.rs` | Set `PROTON_WAYLAND_MONITOR` alongside `WAYLANDDRV_PRIMARY_MONITOR` |

## Verification

1. **KDE + fractional scaling (1.5x):** Wayland checkbox disabled + greyed out, config value preserved as `true`
2. **KDE + integer scaling (2.0x):** Wayland checkbox enabled and functional
3. **GNOME + fractional scaling:** Same blocking behavior as KDE
4. **wlroots + no scaling:** Wayland checkbox enabled, dropdown shows monitors
5. **No monitors detected:** Skeleton → fallback UI with explanation
6. **Click "Starten":** Wayland checkbox state unchanged, correct env vars in launch log
7. **Monitor dropdown:** Primary pre-selected, change persists across page re-renders
8. **Check `PROTON_WAYLAND_MONITOR` and `WAYLANDDRV_PRIMARY_MONITOR`** both appear in launch env when monitor is set
