//! `sc-watch` — interactive watcher for Star Citizen's USER.cfg, attributes.xml
//! and actionmaps.xml. Detects every change while SC is running, proposes a
//! likely mapping (based on what Penguin Citizen's `DEFAULT_SETTINGS` already
//! knows), and prompts the user to confirm or correct it. Output is a Markdown
//! mapping table per session — re-usable for future SC versions and for
//! updating the app's empirical mappings in `usercfg.js`.

use chrono::Local;
use clap::Parser;
use notify::{event::ModifyKind, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use penguin_citizen_lib::sc_config::{parse_attributes_str, sc_base_dir};
use serde::Serialize;
use std::collections::{BTreeMap, HashMap, VecDeque};
use std::fs;
use std::io::{self, BufRead, Write};
use std::path::{Path, PathBuf};
use std::sync::mpsc::channel;
use std::time::{Duration, Instant};

// ============================================================================
// CLI
// ============================================================================

#[derive(Parser, Debug)]
#[command(name = "sc-watch", about = "Empirically map Star Citizen settings by watching its config files in real time")]
struct Args {
    /// SC environment to watch. If omitted, prompts interactively.
    #[arg(short, long)]
    env: Option<String>,

    /// Append the Markdown mapping log to this path (default: ./sc-mapping-<ENV>-<timestamp>.md).
    #[arg(short, long)]
    log: Option<PathBuf>,

    /// Don't ask Y/n prompts — just print detected changes.
    #[arg(long)]
    no_prompt: bool,

    /// Disable ANSI colors (for pipes / CI).
    #[arg(long)]
    no_color: bool,

    /// Print current state of all three files and exit, no watcher.
    #[arg(long)]
    baseline_only: bool,

    /// SC tab the user is currently working on (e.g. "Game Settings",
    /// "Controls", "Graphics"). When set, every new/updated mapping in this
    /// session is tagged with this tab. Speeds up category assignment when
    /// the user goes tab by tab.
    #[arg(short, long)]
    tab: Option<String>,
}

const KNOWN_ENVS: &[&str] = &["LIVE", "PTU", "EPTU", "TECH-PREVIEW", "HOTFIX"];

// ============================================================================
// Knowledge base — what we already think we know
// ============================================================================

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Confidence {
    Verified,
    Conflicting,
    Unknown,
}

impl Confidence {
    fn badge(&self) -> &'static str {
        match self {
            Confidence::Verified => "📚 verified",
            Confidence::Conflicting => "⚠ conflicting",
            Confidence::Unknown => "❓ unknown",
        }
    }
}

#[derive(Debug, Clone, Copy)]
struct KnownMapping {
    attr: &'static str,
    ui_label: &'static str,
    value_hints: &'static [(&'static str, &'static str)],
    confidence: Confidence,
    notes: &'static str,
}

/// Mappings extracted from penguin-citizen-app/src/pages/environments/usercfg.js
/// `DEFAULT_SETTINGS`. Subset of ~50 most-relevant attributes.
#[rustfmt::skip]
const KNOWN_ATTR_MAPPINGS: &[KnownMapping] = &[
    // Display / Graphics
    KnownMapping { attr: "Width", ui_label: "Resolution Width", value_hints: &[], confidence: Confidence::Verified, notes: "numeric pixel width" },
    KnownMapping { attr: "Height", ui_label: "Resolution Height", value_hints: &[], confidence: Confidence::Verified, notes: "numeric pixel height" },
    KnownMapping { attr: "Resolution", ui_label: "(unknown — possibly preset index)", value_hints: &[], confidence: Confidence::Unknown, notes: "F4 open audit; in app-user's XML: value=12 at 2560x1440" },
    KnownMapping { attr: "WindowMode", ui_label: "Window Mode", value_hints: &[("0","LUG:Windowed / NOMAN:Fullscreen"),("1","Borderless"),("2","Fullscreen (LUG)")], confidence: Confidence::Conflicting, notes: "F3 unresolved: LUG-Wiki vs NOMAN's Space disagree on 0/2" },
    KnownMapping { attr: "VSync", ui_label: "VSync", value_hints: &[("0","Off"),("1","On")], confidence: Confidence::Verified, notes: "default on; SC only writes when off" },
    KnownMapping { attr: "Upscaling", ui_label: "Upscaling Mode", value_hints: &[("1","Off"),("2","Quality"),("3","Balanced"),("4","Performance"),("5","Ultra Performance")], confidence: Confidence::Verified, notes: "1-indexed; verified value=3=Balanced" },
    KnownMapping { attr: "UpscalingTechnique", ui_label: "Upscaling Technique", value_hints: &[("0","CIG TSR"),("1","AMD FSR"),("2","NVIDIA DLSS")], confidence: Confidence::Conflicting, notes: "value=1=FSR verified; 0 and 2 best-guess" },
    KnownMapping { attr: "AutoDetect", ui_label: "Auto-Detect Quality", value_hints: &[("0","Off"),("1","On")], confidence: Confidence::Verified, notes: "" },
    KnownMapping { attr: "QRCode", ui_label: "Session Info QR", value_hints: &[("0","Off"),("1","On")], confidence: Confidence::Verified, notes: "default on (esp. PTU)" },
    KnownMapping { attr: "IgnoreWindowFocus", ui_label: "Ignore Window Focus", value_hints: &[("0","Off"),("1","On")], confidence: Confidence::Verified, notes: "keep audio when window loses focus" },

    // Quality presets (SysSpec_*)
    KnownMapping { attr: "SysSpec", ui_label: "Overall Quality", value_hints: &[("1","Low"),("2","Medium"),("3","High"),("4","Very High")], confidence: Confidence::Verified, notes: "SC has no Ultra (Chadarius)" },
    KnownMapping { attr: "SysSpec_ObjectDetail", ui_label: "Object Detail", value_hints: &[], confidence: Confidence::Verified, notes: "1-4 quality scale" },
    KnownMapping { attr: "SysSpec_ObjectViewDistance", ui_label: "Object View Distance", value_hints: &[], confidence: Confidence::Verified, notes: "1-4 quality scale" },
    KnownMapping { attr: "SysSpec_TextureQuality", ui_label: "Textures Quality", value_hints: &[], confidence: Confidence::Verified, notes: "1-4 quality scale" },
    KnownMapping { attr: "SysSpec_TextureDetail", ui_label: "Detail Textures", value_hints: &[], confidence: Confidence::Verified, notes: "1-4 quality scale" },
    KnownMapping { attr: "SysSpec_TextureGround", ui_label: "Ground Textures", value_hints: &[], confidence: Confidence::Verified, notes: "1-4 quality scale" },
    KnownMapping { attr: "SysSpec_TextureFiltering", ui_label: "Texture Filtering", value_hints: &[], confidence: Confidence::Verified, notes: "1-4 quality scale" },
    KnownMapping { attr: "SysSpec_ShadowMaps", ui_label: "Shadow Maps", value_hints: &[], confidence: Confidence::Verified, notes: "1-4 quality scale" },
    KnownMapping { attr: "SysSpec_ShadowScreenSpace", ui_label: "Screen Space Shadows", value_hints: &[], confidence: Confidence::Verified, notes: "1-4 quality scale" },
    KnownMapping { attr: "SysSpec_PlanetVolumetricClouds", ui_label: "Planet Volumetric Clouds Quality", value_hints: &[], confidence: Confidence::Verified, notes: "1-4 quality scale" },
    KnownMapping { attr: "SysSpec_GasCloud", ui_label: "Gas Clouds", value_hints: &[], confidence: Confidence::Verified, notes: "1-4 quality scale" },
    KnownMapping { attr: "SysSpec_Fog", ui_label: "Fog", value_hints: &[], confidence: Confidence::Verified, notes: "1-4 quality scale" },
    KnownMapping { attr: "SysSpec_WaterSim", ui_label: "Water Simulation", value_hints: &[], confidence: Confidence::Verified, notes: "1-4 quality scale" },
    KnownMapping { attr: "SysSpec_WaterCaustics", ui_label: "Water Caustics", value_hints: &[], confidence: Confidence::Verified, notes: "1-4 quality scale" },
    KnownMapping { attr: "SysSpec_Particles", ui_label: "Particles", value_hints: &[], confidence: Confidence::Verified, notes: "1-4 quality scale" },
    KnownMapping { attr: "SysSpec_Shading", ui_label: "Shader Quality", value_hints: &[], confidence: Confidence::Verified, notes: "1-4 quality scale" },
    KnownMapping { attr: "SysSpec_PostProcessing", ui_label: "Post Effects", value_hints: &[], confidence: Confidence::Verified, notes: "1-4 quality scale" },
    KnownMapping { attr: "SysSpec_VideoComms", ui_label: "Video Comms", value_hints: &[], confidence: Confidence::Verified, notes: "1-4 quality scale" },

    // Image clarity
    KnownMapping { attr: "MotionBlur", ui_label: "Motion Blur", value_hints: &[("0","Off"),("1","On")], confidence: Confidence::Verified, notes: "default on; only written when off" },
    KnownMapping { attr: "Sharpening", ui_label: "Sharpening", value_hints: &[], confidence: Confidence::Verified, notes: "0.0-1.0 slider" },
    KnownMapping { attr: "ChromaticAberration", ui_label: "Chromatic Aberration", value_hints: &[], confidence: Confidence::Verified, notes: "0.0-1.0 (SC UI maps 0-100 to this)" },
    KnownMapping { attr: "FilmGrain", ui_label: "Film Grain", value_hints: &[("0","Off"),("1","On")], confidence: Confidence::Verified, notes: "default on" },
    KnownMapping { attr: "Gamma", ui_label: "Gamma", value_hints: &[], confidence: Confidence::Verified, notes: "0.5-1.5; SC UI 0-100 maps linearly" },
    KnownMapping { attr: "Brightness", ui_label: "Brightness", value_hints: &[], confidence: Confidence::Unknown, notes: "F5 open: never seen in user's XML; attrName not verified" },
    KnownMapping { attr: "Contrast", ui_label: "Contrast", value_hints: &[], confidence: Confidence::Unknown, notes: "F5 open: never seen in user's XML; attrName not verified" },
    KnownMapping { attr: "FOV", ui_label: "Field of View", value_hints: &[], confidence: Confidence::Verified, notes: "degrees; default ~67.67" },
    KnownMapping { attr: "AspectModifier", ui_label: "Visor/Lens Aspect Modifier", value_hints: &[], confidence: Confidence::Verified, notes: "-1.0..1.0" },
    KnownMapping { attr: "HDRMaxBrightness", ui_label: "HDR Max Brightness (nits)", value_hints: &[], confidence: Confidence::Unknown, notes: "attrName best-guess" },
    KnownMapping { attr: "HDRRefWhite", ui_label: "HDR Reference White (nits)", value_hints: &[], confidence: Confidence::Unknown, notes: "attrName best-guess" },

    // Audio
    KnownMapping { attr: "AudioMasterVolume", ui_label: "Master Volume", value_hints: &[], confidence: Confidence::Verified, notes: "0-1" },
    KnownMapping { attr: "AudioMusicVolume", ui_label: "Music Volume", value_hints: &[], confidence: Confidence::Verified, notes: "0-1" },
    KnownMapping { attr: "AudioSfxVolume", ui_label: "SFX Volume", value_hints: &[], confidence: Confidence::Verified, notes: "0-1" },
    KnownMapping { attr: "AudioSpeechVolume", ui_label: "Speech Volume", value_hints: &[], confidence: Confidence::Verified, notes: "0-1" },
    KnownMapping { attr: "AudioShipComputerSpeechVolume", ui_label: "Ship Computer Voice", value_hints: &[], confidence: Confidence::Verified, notes: "0-1" },
    KnownMapping { attr: "AudioSimulationAnnouncerVolume", ui_label: "Announcer Volume", value_hints: &[], confidence: Confidence::Verified, notes: "0-1; Arena Commander" },
    KnownMapping { attr: "VideoVolume", ui_label: "Video Volume", value_hints: &[], confidence: Confidence::Verified, notes: "0-1; cut-scenes" },

    // Combat / HUD
    KnownMapping { attr: "ADSMouseSensitivity", ui_label: "ADS Mouse Sensitivity", value_hints: &[], confidence: Confidence::Verified, notes: "" },
    KnownMapping { attr: "AutoZoomOnSelectedTargetStrength", ui_label: "Auto-Zoom on Target", value_hints: &[], confidence: Confidence::Verified, notes: "" },
    KnownMapping { attr: "CrosshairOpacity", ui_label: "Crosshair Opacity", value_hints: &[], confidence: Confidence::Verified, notes: "0-1" },
    KnownMapping { attr: "PilotEspStrength", ui_label: "Pilot ESP Strength", value_hints: &[], confidence: Confidence::Verified, notes: "" },
    KnownMapping { attr: "PilotEspDampening", ui_label: "Pilot ESP Dampening", value_hints: &[], confidence: Confidence::Verified, notes: "" },
    KnownMapping { attr: "TurretsEspStrength", ui_label: "Turret ESP Strength", value_hints: &[], confidence: Confidence::Verified, notes: "" },
    KnownMapping { attr: "TurretsEspDampening", ui_label: "Turret ESP Dampening", value_hints: &[], confidence: Confidence::Verified, notes: "" },
    KnownMapping { attr: "FlightCoreDisabledSensitivityRotation", ui_label: "Decoupled Rotation Sens", value_hints: &[], confidence: Confidence::Verified, notes: "" },
    KnownMapping { attr: "FlightCoreDisabledSensitivityTranslation", ui_label: "Decoupled Translation Sens", value_hints: &[], confidence: Confidence::Verified, notes: "" },
    KnownMapping { attr: "GForceBoostZoomScale", ui_label: "G-Force Boost Zoom", value_hints: &[], confidence: Confidence::Verified, notes: "" },
    KnownMapping { attr: "GForceHeadBobScale", ui_label: "G-Force Head Bob", value_hints: &[], confidence: Confidence::Verified, notes: "" },
    KnownMapping { attr: "ShakeScale", ui_label: "Camera Shake Scale", value_hints: &[], confidence: Confidence::Verified, notes: "" },
    KnownMapping { attr: "SalvageAimNudgeSensitivity", ui_label: "Salvage Aim Nudge", value_hints: &[], confidence: Confidence::Verified, notes: "" },
    KnownMapping { attr: "SpeedThrottleDefaultFixedSpeed", ui_label: "Default Throttle Speed", value_hints: &[], confidence: Confidence::Verified, notes: "m/s" },
    KnownMapping { attr: "Weapon_Setting_FallbackConvergenceDistance", ui_label: "Fallback Convergence", value_hints: &[], confidence: Confidence::Verified, notes: "meters" },

    // Overscan
    KnownMapping { attr: "OverscanBorderX", ui_label: "Overscan Border X", value_hints: &[], confidence: Confidence::Verified, notes: "" },
    KnownMapping { attr: "OverscanBorderY", ui_label: "Overscan Border Y", value_hints: &[], confidence: Confidence::Verified, notes: "" },

    // Text input
    KnownMapping { attr: "TextInputRepeatDelay", ui_label: "Text Input Repeat Delay", value_hints: &[], confidence: Confidence::Verified, notes: "seconds" },
    KnownMapping { attr: "TextInputRepeatRate", ui_label: "Text Input Repeat Rate", value_hints: &[], confidence: Confidence::Verified, notes: "chars/sec" },

    // Common internal / runtime (not in our app)
    KnownMapping { attr: "FoIPCameraSelection", ui_label: "(internal — FoIP Camera id)", value_hints: &[], confidence: Confidence::Unknown, notes: "runtime device id, not a user setting" },
    KnownMapping { attr: "PilotEspDampening_DEPRECATED", ui_label: "(deprecated)", value_hints: &[], confidence: Confidence::Unknown, notes: "legacy attribute; ignore" },
];

const KNOWN_USERCFG_MAPPINGS: &[KnownMapping] = &[
    KnownMapping { attr: "r.graphicsRenderer", ui_label: "Graphics Renderer", value_hints: &[("0", "DX11"), ("1", "Vulkan")], confidence: Confidence::Verified, notes: "LUG-Wiki" },
    KnownMapping { attr: "r_VSync", ui_label: "VSync (USER.cfg)", value_hints: &[("0", "Off"), ("1", "On")], confidence: Confidence::Verified, notes: "LUG-Wiki" },
    KnownMapping { attr: "r_WindowMode", ui_label: "Window Mode (USER.cfg)", value_hints: &[("0","Windowed"),("1","Borderless"),("2","Fullscreen")], confidence: Confidence::Verified, notes: "LUG-Wiki — note: attributes.xml mapping may differ (see F3)" },
    KnownMapping { attr: "r_DisplayInfo", ui_label: "Debug HUD", value_hints: &[("0", "Off"), ("1", "L1"), ("2", "L2"), ("3", "L3")], confidence: Confidence::Verified, notes: "LUG-Wiki: only 0-3" },
    KnownMapping { attr: "sys_MaxFPS", ui_label: "Max FPS", value_hints: &[], confidence: Confidence::Verified, notes: "0 = unlimited" },
    KnownMapping { attr: "sys_MaxIdleFPS", ui_label: "Max Idle FPS (background)", value_hints: &[], confidence: Confidence::Verified, notes: "" },
    KnownMapping { attr: "r.TSR", ui_label: "(advanced) Disable TSR + AA", value_hints: &[("0", "off")], confidence: Confidence::Verified, notes: "LUG-Wiki engine override" },
    KnownMapping { attr: "pl_pit.forceSoftwareCursor", ui_label: "Software Cursor", value_hints: &[("0", "Hardware"), ("1", "Software")], confidence: Confidence::Verified, notes: "LUG-Wiki" },
];

fn lookup_attr(attr: &str) -> Option<&'static KnownMapping> {
    KNOWN_ATTR_MAPPINGS.iter().find(|m| m.attr.eq_ignore_ascii_case(attr))
}

fn lookup_usercfg(key: &str) -> Option<&'static KnownMapping> {
    KNOWN_USERCFG_MAPPINGS.iter().find(|m| m.attr.eq_ignore_ascii_case(key))
}

// ============================================================================
// Diff
// ============================================================================

#[derive(Debug, Clone)]
enum Change {
    Modified { key: String, old: String, new: String },
    Added { key: String, new: String },
    Removed { key: String, was: String },
}

impl Change {
    fn key(&self) -> &str {
        match self {
            Change::Modified { key, .. } | Change::Added { key, .. } | Change::Removed { key, .. } => key,
        }
    }
}

fn diff_maps(old: &HashMap<String, String>, new: &HashMap<String, String>) -> Vec<Change> {
    let mut out = Vec::new();
    for (k, v_new) in new {
        match old.get(k) {
            Some(v_old) if v_old != v_new => out.push(Change::Modified { key: k.clone(), old: v_old.clone(), new: v_new.clone() }),
            None => out.push(Change::Added { key: k.clone(), new: v_new.clone() }),
            _ => {}
        }
    }
    for (k, v_old) in old {
        if !new.contains_key(k) {
            out.push(Change::Removed { key: k.clone(), was: v_old.clone() });
        }
    }
    out.sort_by(|a, b| a.key().cmp(b.key()));
    out
}

// ============================================================================
// Snapshot loaders
// ============================================================================

fn load_attributes(path: &Path) -> Result<HashMap<String, String>, String> {
    if !path.exists() {
        return Ok(HashMap::new());
    }
    let content = fs::read_to_string(path).map_err(|e| format!("read attributes.xml: {e}"))?;
    let parsed = parse_attributes_str(&content);
    Ok(parsed.attrs.into_iter().map(|a| (a.name, a.value)).collect())
}

fn load_user_cfg(path: &Path) -> Result<HashMap<String, String>, String> {
    if !path.exists() {
        return Ok(HashMap::new());
    }
    let content = fs::read_to_string(path).map_err(|e| format!("read USER.cfg: {e}"))?;
    let mut out = HashMap::new();
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with(';') || trimmed.starts_with('#') {
            continue;
        }
        if let Some(eq) = trimmed.find('=') {
            let key = trimmed[..eq].trim().to_string();
            let mut val = trimmed[eq + 1..].trim().to_string();
            if let Some(c) = val.find(';') {
                val = val[..c].trim().to_string();
            }
            out.insert(key, val);
        }
    }
    Ok(out)
}

/// actionmaps.xml is huge and nested — we don't semantic-diff it. We just
/// compute a content hash and a line count so we can say "something changed".
fn load_actionmaps_signature(path: &Path) -> Result<(u64, usize), String> {
    if !path.exists() {
        return Ok((0, 0));
    }
    let content = fs::read_to_string(path).map_err(|e| format!("read actionmaps.xml: {e}"))?;
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    content.hash(&mut hasher);
    Ok((hasher.finish(), content.lines().count()))
}

// ============================================================================
// Environment discovery
// ============================================================================

fn read_install_path() -> Result<String, String> {
    let cfg_path = dirs::config_dir()
        .ok_or("config dir not found")?
        .join("penguin-citizen/config.json");
    let content = fs::read_to_string(&cfg_path).map_err(|e| format!("read {}: {e}", cfg_path.display()))?;
    let v: serde_json::Value = serde_json::from_str(&content).map_err(|e| format!("parse config.json: {e}"))?;
    v.get("install_path")
        .and_then(|x| x.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .ok_or_else(|| "install_path missing or empty in config.json".to_string())
}

#[derive(Debug)]
struct EnvPaths {
    env: String,
    attributes: PathBuf,
    user_cfg: PathBuf,
    actionmaps: PathBuf,
}

fn env_paths(install_path: &str, env: &str) -> Result<EnvPaths, String> {
    let base = sc_base_dir(install_path, env)?;
    Ok(EnvPaths {
        env: env.to_string(),
        attributes: base.join("user/client/0/Profiles/default/attributes.xml"),
        user_cfg: base.join("USER.cfg"),
        actionmaps: base.join("user/client/0/Profiles/default/actionmaps.xml"),
    })
}

fn detect_existing_envs(install_path: &str) -> Vec<String> {
    KNOWN_ENVS
        .iter()
        .filter(|e| sc_base_dir(install_path, e).map(|p| p.exists()).unwrap_or(false))
        .map(|s| s.to_string())
        .collect()
}

fn pick_env_interactive(available: &[String]) -> Result<String, String> {
    if available.is_empty() {
        return Err("No SC environments found under install_path".into());
    }
    println!("Available SC environments:");
    for (i, e) in available.iter().enumerate() {
        println!("  [{}] {}", i + 1, e);
    }
    print!("Pick one (1-{}): ", available.len());
    io::stdout().flush().ok();
    let mut buf = String::new();
    io::stdin().read_line(&mut buf).map_err(|e| e.to_string())?;
    let idx: usize = buf.trim().parse().map_err(|_| "not a number".to_string())?;
    available
        .get(idx.saturating_sub(1))
        .cloned()
        .ok_or_else(|| "out of range".into())
}

// ============================================================================
// Pretty-print + user prompt
// ============================================================================

struct Style {
    color: bool,
}

impl Style {
    fn cyan(&self, s: &str) -> String {
        if self.color { format!("\x1b[36m{s}\x1b[0m") } else { s.into() }
    }
    fn yellow(&self, s: &str) -> String {
        if self.color { format!("\x1b[33m{s}\x1b[0m") } else { s.into() }
    }
    fn green(&self, s: &str) -> String {
        if self.color { format!("\x1b[32m{s}\x1b[0m") } else { s.into() }
    }
    fn red(&self, s: &str) -> String {
        if self.color { format!("\x1b[31m{s}\x1b[0m") } else { s.into() }
    }
    fn bold(&self, s: &str) -> String {
        if self.color { format!("\x1b[1m{s}\x1b[0m") } else { s.into() }
    }
}

fn format_change(change: &Change, style: &Style) -> String {
    match change {
        Change::Modified { key, old, new } => format!(
            "{} {} {} → {}",
            style.yellow("~"),
            style.bold(key),
            style.red(old),
            style.green(new)
        ),
        Change::Added { key, new } => format!("{} {} = {}", style.green("+"), style.bold(key), new),
        Change::Removed { key, was } => format!("{} {} (was: {})", style.red("-"), style.bold(key), was),
    }
}

fn value_hint(mapping: Option<&KnownMapping>, val: &str) -> Option<&'static str> {
    let m = mapping?;
    m.value_hints.iter().find(|(k, _)| *k == val).map(|(_, label)| *label)
}

#[derive(Debug)]
struct UserAnswer {
    confirmed: bool,
    label_override: Option<String>,
    note: Option<String>,
}

/// Returns None if user wanted to skip-all the rest of the current batch.
/// `overlay_label` wins over `mapping`: if the user has labeled this attr in
/// this or a previous session, that label is the primary suggestion and the
/// prompt defaults to Enter = keep it.
fn prompt_user(
    file: &str,
    change: &Change,
    mapping: Option<&KnownMapping>,
    overlay_label: Option<&str>,
    style: &Style,
) -> Result<Option<UserAnswer>, String> {
    // Bell
    print!("\x07");
    println!();
    println!(
        "{} {}: {}",
        style.cyan(&Local::now().format("[%H:%M:%S]").to_string()),
        style.bold(file),
        format_change(change, style)
    );

    // Compute heuristic suggestion ONCE — used if no overlay and no mapping.
    let heuristic = heuristic_label(change.key());

    // Four prompt variants in priority order: overlay > mapping > heuristic > unknown.
    let mode = if let Some(lbl) = overlay_label {
        println!(
            "  {} bereits gelabelt als \"{}\" (aus früherer Antwort)",
            style.green("📝 known"),
            lbl
        );
        if let Some(m) = mapping {
            if let Change::Modified { new, .. } | Change::Added { new, .. } = change {
                if let Some(hint) = value_hint(Some(m), new) {
                    println!("  ↪ Wert {new} ≈ \"{hint}\" (App-Mapping)");
                }
            }
        }
        print!("  Behalten? [Y/n/freitext-korrektur/skip-all]: ");
        PromptMode::Overlay
    } else if let Some(m) = mapping {
        println!("  {} App-Mapping: \"{}\"  ({})", m.confidence.badge(), m.ui_label, m.notes);
        if let Change::Modified { new, .. } | Change::Added { new, .. } = change {
            if let Some(hint) = value_hint(Some(m), new) {
                println!("  ↪ Wert {new} ≈ \"{hint}\"");
            }
        }
        if m.confidence == Confidence::Verified {
            print!("  Bestätigt das SC's UI? [Y/n/freitext/skip-all]: ");
            PromptMode::KnownVerified
        } else {
            print!("  Wie heißt das im SC-Menü? [label / skip / skip-all]: ");
            PromptMode::KnownTentative
        }
    } else if let Some(ref h) = heuristic {
        println!("  {} Auto-Vorschlag: \"{}\" (aus Attributname abgeleitet)", style.yellow("💡 heuristic"), h);
        print!("  Übernehmen? [Y/n/freitext/skip-all]: ");
        PromptMode::Heuristic
    } else {
        println!("  ❓ Unbekannt — kein App-Mapping");
        print!("  Wie heißt das im SC-Menü? [label / skip / skip-all]: ");
        PromptMode::Unknown
    };
    io::stdout().flush().ok();

    let mut buf = String::new();
    io::stdin().lock().read_line(&mut buf).map_err(|e| e.to_string())?;
    let input = buf.trim().to_string();
    let lower = input.to_lowercase();
    if lower == "skip-all" {
        return Ok(None);
    }
    if input.is_empty() || lower == "y" || lower == "yes" || lower == "j" || lower == "ja" {
        match mode {
            PromptMode::Overlay => {
                // Empty / Y → keep the prior label, no override.
                return Ok(Some(UserAnswer {
                    confirmed: true,
                    label_override: None,
                    note: Some("(re-confirmed from overlay)".into()),
                }));
            }
            PromptMode::KnownVerified => {
                return Ok(Some(UserAnswer { confirmed: true, label_override: None, note: None }));
            }
            PromptMode::Heuristic => {
                // Accept the auto-suggested label as the user's choice.
                return Ok(Some(UserAnswer {
                    confirmed: false,
                    label_override: heuristic,
                    note: Some("(accepted heuristic)".into()),
                }));
            }
            PromptMode::KnownTentative | PromptMode::Unknown => {
                // No label given for an unknown/tentative entry = skip.
                return Ok(Some(UserAnswer {
                    confirmed: false,
                    label_override: None,
                    note: Some("(skipped)".into()),
                }));
            }
        }
    }
    if lower == "n" || lower == "no" || lower == "nein" {
        return Ok(Some(UserAnswer {
            confirmed: false,
            label_override: None,
            note: Some("(disputed — user said no but did not provide a correction)".into()),
        }));
    }
    if lower == "skip" || lower == "s" {
        return Ok(Some(UserAnswer { confirmed: false, label_override: None, note: Some("(skipped)".into()) }));
    }
    // Free text → label override (in Overlay mode this corrects a typo)
    Ok(Some(UserAnswer { confirmed: false, label_override: Some(input), note: None }))
}

#[derive(Debug, Clone, Copy)]
enum PromptMode {
    Overlay,
    KnownVerified,
    KnownTentative,
    Heuristic,
    Unknown,
}

// ============================================================================
// Markdown log writing
// ============================================================================

struct LogWriter {
    path: PathBuf,
    /// Authoritative source for the Final Mapping Table.
    /// Updated from every user answer AND seeded at startup from any existing
    /// "## Final Mapping Table" section in the log file (resume mode).
    mappings: HashMap<(String, String), MappingRow>,
    new_in_session: usize,
}

#[derive(Debug, Clone)]
struct JournalEntry {
    timestamp: String,
    file: String,
    change_text: String,
    attr_key: String,
    new_value: String,
    app_mapping: Option<String>,
    user_answer: String,
    final_label: String,
    /// Tab from --tab flag at the time of capture; empty when unset.
    tab: String,
}

#[derive(Debug, Clone, Serialize)]
struct MappingRow {
    file: String,
    attr: String,
    label: String,
    last_value: String,
    last_seen: String,
    /// SC tab the user assigned this mapping to (e.g. "Game Settings").
    /// Empty if the mapping was captured before --tab was used.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    tab: String,
}

impl LogWriter {
    /// Opens an existing log file (resume mode — loads prior mappings + appends)
    /// or creates a new one with header. Resume mode is automatic: if the file
    /// exists, its last "## Final Mapping Table" is parsed and used as the
    /// in-memory overlay.
    fn open(path: PathBuf, env: &str) -> Result<Self, String> {
        let exists = path.exists();
        let mappings = if exists {
            parse_final_table_from_file(&path)?
        } else {
            // New file — write header with timestamp.
            let header = format!(
                "# SC Settings Empirical Mapping — {env} — {}\n\n## Setup\n- Tool: sc-watch (Penguin Citizen)\n- Started: {}\n\n## Detected Changes (chronological)\n\n",
                Local::now().format("%Y-%m-%d %H:%M:%S"),
                Local::now().format("%Y-%m-%d %H:%M:%S"),
            );
            fs::write(&path, header).map_err(|e| format!("write log header: {e}"))?;
            HashMap::new()
        };
        // No resume marker is written: the journal `### [HH:MM:SS]` headers
        // already reveal session boundaries by timestamp.
        Ok(LogWriter { path, mappings, new_in_session: 0 })
    }

    /// Look up an attribute the user has already labeled (this session or a
    /// previous one loaded from the file).
    fn lookup_overlay(&self, file: &str, attr: &str) -> Option<&MappingRow> {
        self.mappings.get(&(file.to_string(), attr.to_string()))
    }

    fn append_journal(&mut self, e: JournalEntry) -> Result<(), String> {
        // Update the overlay map first so future detections see this label.
        // Tab logic: if the current entry provides a tab, use it (overrides
        // prior). Else keep the existing tab from a prior session.
        let existing_tab = self
            .mappings
            .get(&(e.file.clone(), e.attr_key.clone()))
            .map(|r| r.tab.clone())
            .unwrap_or_default();
        let row = MappingRow {
            file: e.file.clone(),
            attr: e.attr_key.clone(),
            label: e.final_label.clone(),
            last_value: e.new_value.clone(),
            last_seen: e.timestamp.clone(),
            tab: if e.tab.is_empty() { existing_tab } else { e.tab.clone() },
        };
        self.mappings.insert((e.file.clone(), e.attr_key.clone()), row);
        self.new_in_session += 1;

        // Append a journal entry. Header now includes the attr key for
        // readability and easier parsing.
        let tab_part = if !e.tab.is_empty() {
            format!(" [tab: {}]", e.tab)
        } else {
            String::new()
        };
        let block = format!(
            "### [{}] {} — {} — {}{}\n- App-Mapping: {}\n- User answer: {}\n- Final label: {}\n\n",
            e.timestamp,
            e.file,
            e.attr_key,
            e.change_text,
            tab_part,
            e.app_mapping.clone().unwrap_or_else(|| "(unknown)".into()),
            e.user_answer,
            e.final_label,
        );
        let mut f = fs::OpenOptions::new().append(true).open(&self.path).map_err(|err| format!("open log: {err}"))?;
        f.write_all(block.as_bytes()).map_err(|err| format!("append log: {err}"))?;
        Ok(())
    }

    /// Replaces the last "## Final Mapping Table" section in the file (or
    /// appends a fresh one if none exists). The table is regenerated from the
    /// in-memory overlay map, so it always reflects the latest label per
    /// (file, attr) pair across all resume cycles.
    fn write_final_table(&self) -> Result<(), String> {
        let content = fs::read_to_string(&self.path).map_err(|e| format!("read for final table: {e}"))?;
        let truncated = if let Some(idx) = content.rfind("\n## Final Mapping Table") {
            content[..idx].trim_end().to_string()
        } else {
            content.trim_end().to_string()
        };

        let mut table = String::from("\n\n## Final Mapping Table\n\n");
        table.push_str(&format!(
            "_Last updated: {} — {} mappings total ({} new this session)_\n\n",
            Local::now().format("%Y-%m-%d %H:%M:%S"),
            self.mappings.len(),
            self.new_in_session,
        ));
        // Tab column added at the end so old 5-column rows still parse cleanly.
        table.push_str("| File | Attribute | SC UI Label | Last Value | Last Seen | Tab |\n|---|---|---|---|---|---|\n");
        let mut rows: Vec<&MappingRow> = self.mappings.values().collect();
        rows.sort_by(|a, b| (a.file.as_str(), a.attr.as_str()).cmp(&(b.file.as_str(), b.attr.as_str())));
        for r in rows {
            table.push_str(&format!(
                "| {} | {} | {} | {} | {} | {} |\n",
                r.file, r.attr, r.label, r.last_value, r.last_seen, r.tab,
            ));
        }
        table.push('\n');

        fs::write(&self.path, format!("{}{}", truncated, table)).map_err(|e| format!("write final table: {e}"))?;
        Ok(())
    }

    /// Writes a machine-readable JSON snapshot next to the .md log (same
    /// basename + ".json"). The app can import this directly to override
    /// hardcoded labels in DEFAULT_SETTINGS at runtime.
    fn write_json_export(&self, env: &str, sc_version: Option<&str>) -> Result<PathBuf, String> {
        let json_path = self.path.with_extension("json");
        // Group by file (attributes.xml / USER.cfg / actionmaps.xml) with attr → row.
        let mut by_file: BTreeMap<String, BTreeMap<String, JsonRow>> = BTreeMap::new();
        for row in self.mappings.values() {
            by_file
                .entry(row.file.clone())
                .or_default()
                .insert(
                    row.attr.clone(),
                    JsonRow {
                        label: row.label.clone(),
                        tab: row.tab.clone(),
                        last_value: row.last_value.clone(),
                    },
                );
        }
        let export = JsonExport {
            sc_version: sc_version.unwrap_or("unknown").to_string(),
            env: env.to_string(),
            last_updated: Local::now().format("%Y-%m-%dT%H:%M:%S%:z").to_string(),
            files: by_file,
        };
        let pretty = serde_json::to_string_pretty(&export).map_err(|e| format!("serialize JSON: {e}"))?;
        // Atomic write: write to .tmp then rename.
        let tmp = json_path.with_extension("json.tmp");
        fs::write(&tmp, pretty).map_err(|e| format!("write json: {e}"))?;
        fs::rename(&tmp, &json_path).map_err(|e| format!("rename json: {e}"))?;
        Ok(json_path)
    }
}

#[derive(Serialize)]
struct JsonExport {
    sc_version: String,
    env: String,
    last_updated: String,
    /// Outer key = source file (attributes.xml / USER.cfg / actionmaps.xml).
    /// Inner key = attribute / cvar name.
    files: BTreeMap<String, BTreeMap<String, JsonRow>>,
}

#[derive(Serialize)]
struct JsonRow {
    label: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    tab: String,
    last_value: String,
}

/// Parse the LAST "## Final Mapping Table" section of a previously-written
/// sc-watch log. Returns one MappingRow per (file, attr). Used to seed the
/// overlay map for resume mode. Accepts both the old 5-column format (no Tab)
/// and the new 6-column format (with Tab as last column).
fn parse_final_table_from_file(path: &Path) -> Result<HashMap<(String, String), MappingRow>, String> {
    let content = fs::read_to_string(path).map_err(|e| format!("read for parsing: {e}"))?;
    let mut out = HashMap::new();
    let Some(idx) = content.rfind("## Final Mapping Table") else {
        return Ok(out);
    };
    for line in content[idx..].lines() {
        let trimmed = line.trim();
        if !trimmed.starts_with('|') {
            continue;
        }
        // Header / separator
        if trimmed.starts_with("| File ") || trimmed.starts_with("|---") || trimmed.contains("---|") {
            continue;
        }
        let cells: Vec<String> = trimmed
            .split('|')
            .map(|s| s.trim().to_string())
            .collect();
        // After split: ["", file, attr, label, last_value, last_seen, (tab,) ""]
        // Old format: 7 cells (5 data columns + 2 empty)
        // New format: 8 cells (6 data columns + 2 empty)
        if cells.len() < 7 {
            continue;
        }
        let file = cells[1].clone();
        let attr = cells[2].clone();
        let label = cells[3].clone();
        let last_value = cells[4].clone();
        let last_seen = cells.get(5).cloned().unwrap_or_default();
        let tab = cells.get(6).cloned().unwrap_or_default();
        // Last cell might be the trailing empty — only treat cells[6] as a tab
        // if cells.len() is 8 (the new format).
        let tab = if cells.len() >= 8 { tab } else { String::new() };
        if file.is_empty() || attr.is_empty() {
            continue;
        }
        out.insert(
            (file.clone(), attr.clone()),
            MappingRow { file, attr, label, last_value, last_seen, tab },
        );
    }
    Ok(out)
}

// ============================================================================
// Heuristic label suggestion
// ============================================================================

/// Generate a probable user-facing label from an attribute name. Used to
/// pre-fill the prompt for unknown attrs so the user can usually just press
/// Enter. Best-effort; the user can always type a correction.
fn heuristic_label(attr: &str) -> Option<String> {
    // Order matters — longest matching prefix wins.
    let prefixes: &[(&str, &str)] = &[
        ("LightGroupController_Setting_", "Defaults - Light - "),
        ("FlightController_Setting_", "Defaults - HUD - "),
        ("IFCS_Setting_", "Defaults - Flight - "),
        ("Weapon_Setting_", "Defaults - Weapons - "),
        ("Turret_Setting_", "Turret - "),
        ("Engineering_", "Engineering - "),
        ("HeadTracking", "Head Tracking - "),
        ("Headtracking", "Head Tracking - "),
        ("Tobii", "Tobii - "),
        ("Hmd", "HMD - "),
        ("VJoy", "VJoy - "),
        ("LookAheadStrength", "Look Ahead - "),
    ];

    let mut rest = attr;
    let mut prefix_part = String::new();
    for (p, replacement) in prefixes {
        if let Some(stripped) = attr.strip_prefix(p) {
            rest = stripped;
            prefix_part = replacement.to_string();
            break;
        }
    }

    // Mark deprecated attrs explicitly.
    let (rest_owned, dep_suffix) = if let Some(r) = rest.strip_suffix("_DEPRECATED") {
        (r.to_string(), " (deprecated)")
    } else {
        (rest.to_string(), "")
    };

    // Replace remaining underscores with spaces.
    let underscored = rest_owned.replace('_', " ");

    // Split CamelCase, preserving uppercase clusters (acronyms like IFCS, HUD, FoIP).
    let split = camel_case_split(&underscored);

    let label = format!("{}{}{}", prefix_part, split, dep_suffix);
    if label.trim().is_empty() {
        None
    } else {
        Some(label)
    }
}

/// Insert a space before each uppercase letter that's preceded by a lowercase
/// letter. Preserves consecutive uppercase letters (e.g. "IFCS", "HUD") and
/// existing spaces. Examples:
/// - "SubtitlesEnabled" → "Subtitles Enabled"
/// - "GSafeEnabled" → "G Safe Enabled"
/// - "VJoyAnglePilots" → "VJoy Angle Pilots"
/// - "IFCS Setting GSafeEnabled" → "IFCS Setting G Safe Enabled"
fn camel_case_split(s: &str) -> String {
    let mut out = String::new();
    let chars: Vec<char> = s.chars().collect();
    for (i, c) in chars.iter().enumerate() {
        if i > 0 && c.is_uppercase() {
            let prev = chars[i - 1];
            // Insert space if transitioning from lowercase OR digit to uppercase.
            if prev.is_lowercase() || prev.is_ascii_digit() {
                out.push(' ');
            }
            // Also handle ACRONYMs followed by a CamelCase word, e.g. "VJoyAngle"
            // → after "VJoy" comes "A" (upper) preceded by "y" (lower) — covered.
        }
        out.push(*c);
    }
    out
}

// ============================================================================
// Watcher loop
// ============================================================================

struct Snapshots {
    attributes: HashMap<String, String>,
    user_cfg: HashMap<String, String>,
    actionmaps_sig: (u64, usize),
}

fn load_snapshots(paths: &EnvPaths) -> Result<Snapshots, String> {
    Ok(Snapshots {
        attributes: load_attributes(&paths.attributes)?,
        user_cfg: load_user_cfg(&paths.user_cfg)?,
        actionmaps_sig: load_actionmaps_signature(&paths.actionmaps)?,
    })
}

fn print_baseline(paths: &EnvPaths, snaps: &Snapshots, style: &Style) {
    println!("{}", style.bold(&format!("=== sc-watch baseline — {} ===", paths.env)));
    println!("  attributes.xml: {}  ({} attrs)", paths.attributes.display(), snaps.attributes.len());
    println!("  USER.cfg:       {}  ({} keys)", paths.user_cfg.display(), snaps.user_cfg.len());
    println!("  actionmaps.xml: {}  ({} lines, hash {:016x})", paths.actionmaps.display(), snaps.actionmaps_sig.1, snaps.actionmaps_sig.0);
    println!();
}

fn classify_event(path: &Path, paths: &EnvPaths) -> Option<&'static str> {
    if path == paths.attributes { Some("attributes.xml") }
    else if path == paths.user_cfg { Some("USER.cfg") }
    else if path == paths.actionmaps { Some("actionmaps.xml") }
    else { None }
}

fn handle_event(
    label: &'static str,
    paths: &EnvPaths,
    snaps: &mut Snapshots,
    style: &Style,
    log: &mut Option<LogWriter>,
    no_prompt: bool,
    tab: &str,
) -> Result<(), String> {
    match label {
        "attributes.xml" => {
            let new = load_attributes(&paths.attributes)?;
            let diff = diff_maps(&snaps.attributes, &new);
            if diff.is_empty() {
                return Ok(());
            }
            println!("\n{} {} change(s):", style.cyan(&Local::now().format("[%H:%M:%S]").to_string()), style.bold(label));
            for c in &diff { println!("  {}", format_change(c, style)); }
            if !no_prompt {
                let mut queue: VecDeque<Change> = diff.iter().cloned().collect();
                while let Some(change) = queue.pop_front() {
                    let mapping = lookup_attr(change.key());
                    let overlay = log.as_ref().and_then(|l| l.lookup_overlay(label, change.key())).map(|r| r.label.clone());
                    match prompt_user(label, &change, mapping, overlay.as_deref(), style)? {
                        None => {
                            println!("  (skipping rest of batch)");
                            break;
                        }
                        Some(ans) => {
                            if let Some(l) = log.as_mut() {
                                let entry = build_journal_entry(label, &change, mapping, overlay.as_deref(), tab, &ans);
                                l.append_journal(entry).ok();
                            }
                        }
                    }
                }
            } else if let Some(l) = log.as_mut() {
                for change in diff {
                    let mapping = lookup_attr(change.key());
                    let overlay = l.lookup_overlay(label, change.key()).map(|r| r.label.clone());
                    let entry = build_journal_entry(label, &change, mapping, overlay.as_deref(), tab, &UserAnswer { confirmed: false, label_override: None, note: Some("(--no-prompt)".into()) });
                    l.append_journal(entry).ok();
                }
            }
            snaps.attributes = new;
        }
        "USER.cfg" => {
            let new = load_user_cfg(&paths.user_cfg)?;
            let diff = diff_maps(&snaps.user_cfg, &new);
            if diff.is_empty() { return Ok(()); }
            println!("\n{} {} change(s):", style.cyan(&Local::now().format("[%H:%M:%S]").to_string()), style.bold(label));
            for c in &diff { println!("  {}", format_change(c, style)); }
            if !no_prompt {
                let mut queue: VecDeque<Change> = diff.iter().cloned().collect();
                while let Some(change) = queue.pop_front() {
                    let mapping = lookup_usercfg(change.key());
                    let overlay = log.as_ref().and_then(|l| l.lookup_overlay(label, change.key())).map(|r| r.label.clone());
                    match prompt_user(label, &change, mapping, overlay.as_deref(), style)? {
                        None => { println!("  (skipping rest of batch)"); break; }
                        Some(ans) => {
                            if let Some(l) = log.as_mut() {
                                let entry = build_journal_entry(label, &change, mapping, overlay.as_deref(), tab, &ans);
                                l.append_journal(entry).ok();
                            }
                        }
                    }
                }
            } else if let Some(l) = log.as_mut() {
                for change in diff {
                    let mapping = lookup_usercfg(change.key());
                    let overlay = l.lookup_overlay(label, change.key()).map(|r| r.label.clone());
                    let entry = build_journal_entry(label, &change, mapping, overlay.as_deref(), tab, &UserAnswer { confirmed: false, label_override: None, note: Some("(--no-prompt)".into()) });
                    l.append_journal(entry).ok();
                }
            }
            snaps.user_cfg = new;
        }
        "actionmaps.xml" => {
            let new_sig = load_actionmaps_signature(&paths.actionmaps)?;
            if new_sig != snaps.actionmaps_sig {
                println!(
                    "\n{} {} modified ({} → {} lines, hash {:016x} → {:016x})",
                    style.cyan(&Local::now().format("[%H:%M:%S]").to_string()),
                    style.bold(label),
                    snaps.actionmaps_sig.1, new_sig.1,
                    snaps.actionmaps_sig.0, new_sig.0,
                );
                if let Some(l) = log.as_mut() {
                    let entry = JournalEntry {
                        timestamp: Local::now().format("%H:%M:%S").to_string(),
                        file: label.to_string(),
                        change_text: format!("hash {:016x} → {:016x}, lines {} → {}", snaps.actionmaps_sig.0, new_sig.0, snaps.actionmaps_sig.1, new_sig.1),
                        attr_key: "(file-level change)".into(),
                        new_value: "(see file)".into(),
                        app_mapping: None,
                        user_answer: "(not prompted — bindings file)".into(),
                        final_label: "(bindings change)".into(),
                        tab: tab.to_string(),
                    };
                    l.append_journal(entry).ok();
                }
                snaps.actionmaps_sig = new_sig;
            }
        }
        _ => {}
    }
    Ok(())
}

fn build_journal_entry(
    file: &str,
    change: &Change,
    mapping: Option<&KnownMapping>,
    overlay_label: Option<&str>,
    tab: &str,
    ans: &UserAnswer,
) -> JournalEntry {
    let (new_value, change_text) = match change {
        Change::Modified { old, new, .. } => (new.clone(), format!("{} → {}", old, new)),
        Change::Added { new, .. } => (new.clone(), format!("(new) → {}", new)),
        Change::Removed { was, .. } => (String::from("(removed)"), format!("{} → (removed)", was)),
    };
    let app_mapping = mapping.map(|m| format!("\"{}\" ({:?}, {})", m.ui_label, m.confidence, m.notes));

    // Priority for final_label: explicit override > overlay (prior user label) > static mapping > placeholder.
    let final_label = if let Some(ref l) = ans.label_override {
        l.clone()
    } else if let Some(o) = overlay_label {
        // Whether confirmed or not, if the user already labeled it, that label wins for the table.
        o.to_string()
    } else if ans.confirmed {
        mapping.map(|m| m.ui_label.to_string()).unwrap_or_else(|| "(no app mapping)".into())
    } else {
        mapping.map(|m| m.ui_label.to_string()).unwrap_or_else(|| "(unknown — skipped)".into())
    };

    let user_answer = if let Some(ref l) = ans.label_override {
        format!("corrected to \"{}\"", l)
    } else if ans.confirmed {
        if overlay_label.is_some() { "re-confirmed (overlay)".into() } else { "confirmed".into() }
    } else {
        ans.note.clone().unwrap_or_else(|| "(no note)".into())
    };

    JournalEntry {
        timestamp: Local::now().format("%H:%M:%S").to_string(),
        file: file.to_string(),
        change_text,
        attr_key: change.key().to_string(),
        new_value,
        app_mapping,
        user_answer,
        final_label,
        tab: tab.to_string(),
    }
}

// ============================================================================
// Main
// ============================================================================

fn run() -> Result<(), String> {
    let args = Args::parse();
    let style = Style { color: !args.no_color && atty_stdout() };

    let install_path = read_install_path()?;
    let available = detect_existing_envs(&install_path);

    let env_name = match args.env {
        Some(e) => {
            let up = e.to_uppercase();
            if !KNOWN_ENVS.iter().any(|k| k.eq_ignore_ascii_case(&up)) {
                return Err(format!("Unknown env '{e}'. Allowed: {}", KNOWN_ENVS.join(", ")));
            }
            up
        }
        None => pick_env_interactive(&available)?,
    };

    let paths = env_paths(&install_path, &env_name)?;
    let mut snaps = load_snapshots(&paths)?;
    print_baseline(&paths, &snaps, &style);

    if args.baseline_only {
        return Ok(());
    }

    // Log file
    let log_path = args.log.unwrap_or_else(|| {
        let ts = Local::now().format("%Y%m%d-%H%M%S");
        PathBuf::from(format!("sc-mapping-{env_name}-{ts}.md"))
    });
    let resume = log_path.exists();
    let log_inner = LogWriter::open(log_path.clone(), &env_name)?;
    let resumed_count = log_inner.mappings.len();
    let mut log = Some(log_inner);
    if resume {
        println!("📝 Resuming log: {} ({} prior mappings loaded)", log_path.display(), resumed_count);
    } else {
        println!("📝 New log: {}", log_path.display());
    }
    if let Some(t) = args.tab.as_deref() {
        println!("🏷  Current tab: {}", t);
    }
    println!();

    // Watcher
    let (tx, rx) = channel::<notify::Result<notify::Event>>();
    let mut watcher: RecommendedWatcher = notify::recommended_watcher(tx).map_err(|e| format!("create watcher: {e}"))?;
    for p in [&paths.attributes, &paths.user_cfg, &paths.actionmaps] {
        if let Some(parent) = p.parent() {
            if parent.exists() {
                watcher.watch(parent, RecursiveMode::NonRecursive).map_err(|e| format!("watch {}: {e}", parent.display()))?;
            }
        }
    }
    println!("👀 Watching... (Ctrl+C to stop and write Final Mapping Table)\n");

    // SIGINT → atomic flag, main loop checks it and exits cleanly.
    let shutdown = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    install_sigint_handler(&shutdown);

    // Event loop with debounce
    let mut pending: HashMap<&'static str, Instant> = HashMap::new();
    let debounce = Duration::from_millis(150);

    loop {
        if shutdown.load(std::sync::atomic::Ordering::SeqCst) {
            println!("\n[sc-watch] Shutting down, writing Final Mapping Table + JSON export...");
            if let Some(l) = log.as_ref() {
                if let Err(e) = l.write_final_table() {
                    eprintln!("[warn] final table write failed: {e}");
                } else {
                    println!("✓ Final table written to {}", l.path.display());
                }
                match l.write_json_export(&env_name, None) {
                    Ok(p) => println!("✓ JSON export written to {}", p.display()),
                    Err(e) => eprintln!("[warn] JSON export failed: {e}"),
                }
            }
            break;
        }
        match rx.recv_timeout(Duration::from_millis(200)) {
            Ok(Ok(event)) => {
                if matches!(event.kind, EventKind::Modify(_) | EventKind::Create(_) | EventKind::Other) {
                    for p in &event.paths {
                        if let Some(label) = classify_event(p, &paths) {
                            pending.insert(label, Instant::now());
                        } else if matches!(event.kind, EventKind::Modify(ModifyKind::Name(_))) {
                            // rename target: re-check all
                            for known in ["attributes.xml", "USER.cfg", "actionmaps.xml"] {
                                pending.insert(known, Instant::now());
                            }
                        }
                    }
                }
            }
            Ok(Err(_)) | Err(_) => { /* timeout — process pending */ }
        }
        let now = Instant::now();
        let due: Vec<&'static str> = pending.iter().filter(|(_, t)| now.duration_since(**t) >= debounce).map(|(k, _)| *k).collect();
        for label in due {
            pending.remove(label);
            if let Err(e) = handle_event(label, &paths, &mut snaps, &style, &mut log, args.no_prompt, args.tab.as_deref().unwrap_or("")) {
                eprintln!("[error] {label}: {e}");
            }
        }
    }
    Ok(())
}

fn atty_stdout() -> bool {
    use std::io::IsTerminal;
    io::stdout().is_terminal()
}

fn install_sigint_handler(flag: &std::sync::Arc<std::sync::atomic::AtomicBool>) {
    use std::sync::atomic::Ordering;
    use std::sync::OnceLock;
    // Stash the Arc in a OnceLock so the C-callable handler can flip it.
    // Async-signal-safe: AtomicBool::store with Relaxed/SeqCst is allowed in signal handlers.
    static FLAG: OnceLock<std::sync::Arc<std::sync::atomic::AtomicBool>> = OnceLock::new();
    let _ = FLAG.set(flag.clone());
    unsafe extern "C" fn raw_handler(_sig: libc::c_int) {
        if let Some(f) = FLAG.get() {
            f.store(true, Ordering::SeqCst);
        }
    }
    unsafe {
        libc::signal(libc::SIGINT, raw_handler as *const () as libc::sighandler_t);
    }
}

fn main() {
    if let Err(e) = run() {
        eprintln!("sc-watch: error: {e}");
        std::process::exit(1);
    }
}
