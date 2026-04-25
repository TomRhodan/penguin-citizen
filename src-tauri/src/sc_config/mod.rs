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

//! Star Citizen configuration and profile management.
//!
//! This module handles reading and writing Star Citizen configuration files,
//! including user profiles, action maps (key bindings), attributes, and
//! localization data. It also provides access to P4K archives (ZIP64 format)
//! to read default bindings and localization from game data.
//!
//! Core features:
//! - Detection of installed SC versions (LIVE, PTU, EPTU, HOTFIX)
//! - Parsing and writing `actionmaps.xml` (custom key bindings)
//! - Reading CryXmlB binary XML from P4K archives (master bindings)
//! - Extraction of localization labels from `global.ini`
//! - Profile backup and restoration

pub(crate) mod versions;
pub(crate) mod bindings;
pub(crate) mod profiles;
pub(crate) mod p4k;
pub(crate) mod localization;

// Re-export for cross-submodule usage (called from bindings + profiles)
pub(super) use localization::get_localization_labels;


use std::collections::{ HashMap, HashSet };
use std::time::UNIX_EPOCH;
use std::fs::{ self, File };
use std::io::{ Cursor, Read as IoRead, Seek, SeekFrom };
use sha2::{ Sha256, Digest };
use similar::{ ChangeTag, TextDiff };
use std::path::{ Path, PathBuf };
use chrono::Local;
use serde::{ Deserialize, Serialize };
use quick_xml::Reader;
use quick_xml::events::{ Event, BytesStart };
use tokio::sync::Mutex;
use tauri::Emitter;
use once_cell::sync::Lazy;
use quick_xml::writer::Writer;
use encoding_rs::UTF_16LE;
use crate::action_definitions::{
    CompleteBinding,
    BindingStats,
    BindingListResponse,
    ActionDefinitions,
    DeviceMapping,
};

/// Device options for an input device (e.g. joystick axis settings).
/// Contains the device name and a list of options per axis/input.
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct ScDeviceOptions {
    pub name: String,
    pub options: Vec<ScDeviceOption>,
}

/// A single option for a device input (e.g. deadzone or saturation of an axis).
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ScDeviceOption {
    /// Input identifier (e.g. "x" for X-axis)
    pub input: String,
    /// Deadzone - range around the center position where no input is registered
    pub deadzone: Option<f64>,
    /// Saturation - maximum deflection of the axis
    pub saturation: Option<f64>,
}

/// Tuning option for a device (response curve, inversion, sensitivity).
/// Parsed from child elements of `<options>` in actionmaps.xml.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ScOptionsTuning {
    /// Element name, e.g. "flight_move_pitch", "master", "throttle"
    pub name: String,
    /// Inversion flag (0 or 1)
    pub invert: Option<u8>,
    /// Response curve exponent (typically 1.0-3.0)
    pub exponent: Option<f64>,
    /// Sensitivity multiplier
    pub sensitivity: Option<f64>,
}

/// Represents a connected input device from the actionmaps.xml.
/// The combination of device_type + instance uniquely identifies a device in SC.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ScDevice {
    /// Device type: "joystick", "keyboard", "mouse" or "gamepad"
    pub device_type: String,
    /// SC instance number - determines the prefix in bindings (e.g. js1_, js2_)
    pub instance: u32,
    /// Product name of the device (e.g. "VPC Constellation ALPHA-R")
    pub product: String,
    /// Optional GUID for device identification
    pub guid: Option<String>,
    /// Per-device tuning (inversion, curves, sensitivity) from options children
    #[serde(default)]
    pub tuning: Vec<ScOptionsTuning>,
}

/// A single key binding: links an action to one or more input strings.
/// SC allows multiple <rebind> tags per action (e.g. keyboard and joystick).
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ScBinding {
    /// Name of the action (e.g. "v_attack1")
    pub action_name: String,
    /// List of input strings in SC format (e.g. "js1_button5", "kb1_f")
    pub inputs: Vec<String>,
}

/// An action within an action map with an optional localization label.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ScAction {
    pub name: String,
    /// Reference to a localization key (e.g. "@ui_CIFirePrimaryWeapon")
    pub label: Option<String>,
}

/// An action map groups related actions and bindings into a category
/// (e.g. "spaceship_movement", "vehicle_turret").
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ScActionMap {
    pub name: String,
    pub bindings: Vec<ScBinding>,
    pub actions: Vec<ScAction>,
}

/// An action profile contains all devices, device options, and action maps.
/// Corresponds to the `<ActionProfiles>` element in actionmaps.xml.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ScActionProfile {
    /// Profile name - usually "default"
    pub profile_name: String,
    pub version: String,
    pub options_version: String,
    pub rebind_version: String,
    /// List of input devices registered in the profile
    pub devices: Vec<ScDevice>,
    /// Device-specific options (deadzones, saturations)
    pub device_options: Vec<ScDeviceOptions>,
    /// Raw modifiers block content (currently preserved as-is)
    pub modifiers: Option<String>,
    /// All action maps with their bindings
    pub action_maps: Vec<ScActionMap>,
}


/// Parsed representation of a complete actionmaps.xml file.
/// Contains a version number and one or more profiles.
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct ParsedActionMaps {
    pub version: String,
    pub profiles: Vec<ScActionProfile>,
}
/// Information about an installed SC version (e.g. LIVE, PTU).
/// Used to show the frontend which files/folders are present.
#[derive(Serialize, Deserialize, Clone)]
pub struct ScVersionInfo {
    /// Version name (e.g. "LIVE", "PTU", "EPTU")
    pub version: String,
    /// Absolute path to the version folder
    pub path: String,
    /// Whether a USER.cfg exists
    pub has_usercfg: bool,
    /// Whether an attributes.xml exists in the default profile
    pub has_attributes: bool,
    /// Whether an actionmaps.xml exists in the default profile
    pub has_actionmaps: bool,
    /// Whether exported controller layouts are present
    pub has_exported_layouts: bool,
    /// Whether custom characters (.chf files) are present
    pub has_custom_characters: bool,
    /// Whether the Data.p4k archive file exists (and is readable — false for missing or dangling symlinks)
    pub has_data_p4k: bool,
    /// Size of Data.p4k in bytes (None if not present)
    pub data_p4k_size: Option<u64>,
    /// Unix timestamp (seconds since epoch) of Data.p4k last-modified time (None if not present)
    pub data_p4k_mtime: Option<u64>,
    /// Whether Data.p4k is a symlink (None if not present)
    pub data_p4k_is_symlink: Option<bool>,
    /// Symlink target path if Data.p4k is a symlink (None otherwise)
    pub data_p4k_symlink_target: Option<String>,
}
/// A single attribute from the attributes.xml (name-value pair).
#[derive(Serialize, Deserialize, Default, Clone)]
pub struct ScAttribute {
    pub name: String,
    pub value: String,
}

/// Parsed attributes.xml - contains game settings like graphics options and control parameters.
#[derive(Serialize, Deserialize, Default, Clone)]
pub struct ScAttributes {
    pub version: String,
    pub attrs: Vec<ScAttribute>,
}
/// Metadata for a profile backup.
/// Stored as backup_meta.json in the backup folder.
#[derive(Serialize, Deserialize, Clone)]
pub struct BackupInfo {
    /// Unique ID (timestamp format: "2025-03-12T14-30-00")
    pub id: String,
    /// Human-readable creation timestamp
    pub created_at: String,
    /// Unix timestamp of creation
    pub timestamp: u64,
    /// SC version this backup belongs to
    pub version: String,
    /// Type of backup: "manual", "pre-import", "imported"
    pub backup_type: String,
    /// List of backed-up files (relative paths)
    pub files: Vec<String>,
    /// User-defined label for the backup
    pub label: String,
    /// SHA256 hashes of backed-up files for change detection
    #[serde(default)]
    pub file_hashes: HashMap<String, String>,
    /// Device mapping from actionmaps.xml (product -> instance)
    #[serde(default)]
    pub device_map: Vec<DeviceMapping>,
    /// Whether the profile has been edited since it was last applied to SC
    #[serde(default)]
    pub dirty: bool,
}
/// Information about an SC version from which data can be imported.
/// The score weights available data (profiles > controls > characters).
#[derive(Serialize, Deserialize, Clone)]
pub struct VersionImportInfo {
    pub version: String,
    pub has_profiles: bool,
    pub has_controls_mappings: bool,
    pub has_custom_characters: bool,
    pub profile_file_count: u32,
    pub controls_file_count: u32,
    pub character_file_count: u32,
    /// Weighted score: profiles x 3 + controls x 2 + characters x 1
    pub score: u32,
}

/// Result of a version import - counts the copied files per category.
#[derive(Serialize, Deserialize, Clone)]
pub struct ImportResult {
    pub profiles_copied: u32,
    pub controls_copied: u32,
    pub characters_copied: u32,
}

/// An exported controller layout from the controls/mappings folder.
#[derive(Serialize, Deserialize, Clone)]
pub struct ExportedLayout {
    pub filename: String,
    /// Display name (filename without .xml, underscores replaced by spaces)
    pub label: String,
    /// Last modification time as Unix timestamp
    pub modified: u64,
}

/// Entry for reordering device instance numbers.
/// Sent from the frontend when the user rearranges devices.
#[derive(Serialize, Deserialize, Clone)]
pub struct DeviceReorderEntry {
    #[serde(rename = "deviceType")] pub device_type: String,
    #[serde(rename = "oldInstance")] pub old_instance: u32,
    #[serde(rename = "newInstance")] pub new_instance: u32,
}

/// An SC user profile (folder under user/client/0/Profiles/).
#[derive(Serialize, Deserialize, Clone)]
pub struct ScProfile {
    pub name: String,
    /// Last played timestamp from the attributes.xml
    pub last_played: u64,
}

/// Cached localization data from the P4K archive.
/// The cache is invalidated based on file size and modification time of the P4K.
#[derive(Serialize, Deserialize)]
pub(super) struct CachedLocalization {
    pub(super) p4k_size: u64,
    pub(super) p4k_modified: u64,
    pub(super) labels: HashMap<String, String>,
}

/// Cached master bindings (default key bindings) from the P4K archive.
/// Same cache invalidation strategy as CachedLocalization.
#[derive(Serialize, Deserialize)]
pub(super) struct CachedMasterBindings {
    pub(super) p4k_size: u64,
    pub(super) p4k_modified: u64,
    pub(super) data: ParsedActionMaps,
}

/// Arguments for assigning a key binding.
#[derive(Deserialize)]
pub struct AssignBindingArgs {
    pub game_path: String,
    pub version: String,
    pub action_name: String,
    pub category: String,
    /// New input string (e.g. "js1_button5")
    pub input: String,
    /// If set, only the binding with this input is replaced (instead of adding a new one)
    pub old_input: Option<String>,
}
/// Arguments for removing a key binding.
#[derive(Deserialize)]
pub struct RemoveBindingArgs {
    pub game_path: String,
    pub version: String,
    pub action_name: String,
    pub input: String,
    #[allow(dead_code)] pub category: String,
}

/// Status of a single file comparing backup and current SC state.
#[derive(Serialize, Deserialize, Clone)]
pub struct FileStatus {
    pub file: String,
    /// Status: "unchanged", "modified", "deleted" or "new"
    pub status: String,
}

/// Result of the profile status comparison.
#[derive(Serialize, Deserialize, Clone)]
pub struct ProfileStatus {
    /// true if all files match the backup
    pub matched: bool,
    /// Detailed status of each file
    pub files: Vec<FileStatus>,
}

/// Combined tuning data for a single device (hardware axis options + response/inversion tuning).
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct DeviceTuningResponse {
    pub product: String,
    pub device_type: String,
    pub instance: u32,
    pub axis_options: Vec<ScDeviceOption>,
    pub tuning: Vec<ScOptionsTuning>,
}

/// A single line in a file diff.
#[derive(Serialize, Deserialize, Clone)]
pub struct DiffLine {
    /// "context" (unchanged), "add" (added) or "remove" (removed)
    pub line_type: String,
    /// Line number in the old file (backup)
    pub old_line_no: Option<usize>,
    /// Line number in the new file (current SC file)
    pub new_line_no: Option<usize>,
    pub content: String,
}

// Async mutexes prevent concurrent requests from overwriting the same cache file
// or reading the P4K archive twice.
pub(super) static LOCALIZATION_LOCK: Lazy<Mutex<()>> = Lazy::new(|| Mutex::new(()));
pub(super) static MASTER_BINDINGS_LOCK: Lazy<Mutex<()>> = Lazy::new(|| Mutex::new(()));

pub(crate) use crate::util::expand_tilde;

/// Validates a version string to prevent path traversal attacks.
/// Blocks empty strings, path separators, and parent directory references.
pub(super) fn validate_version(v: &str) -> Result<(), String> {
    if v.is_empty() || v.contains('/') || v.contains('\\') || v.contains("..") {
        return Err("Invalid version ID".into());
    }
    Ok(())
}

/// Constructs the base path to an SC version folder within the Wine prefix.
/// Example: /path/to/prefix/drive_c/Program Files/Roberts Space Industries/StarCitizen/LIVE
///
/// Returns an error if the version string contains path traversal characters.
pub fn sc_base_dir(gp: &str, v: &str) -> Result<PathBuf, String> {
    validate_version(v)?;
    Ok(Path::new(gp).join("drive_c/Program Files/Roberts Space Industries/StarCitizen").join(v))
}

/// Returns the path to the Data.p4k archive file, if it exists.
pub(super) fn sc_p4k_path(gp: &str, v: &str) -> Result<PathBuf, String> {
    let p = sc_base_dir(gp, v)?.join("Data.p4k");
    if p.exists() {
        Ok(p)
    } else {
        Err("No P4K".into())
    }
}
/// Path to the cache file for master bindings of an SC version.
/// Located at ~/.config/penguin-citizen/cache/master_bindings_{version}.json
pub(super) fn master_bindings_cache_path(v: &str) -> Result<PathBuf, String> {
    Ok(
        dirs
            ::config_dir()
            .ok_or("No config dir")?
            .join("penguin-citizen/cache")
            .join(format!("master_bindings_{}.json", v))
    )
}

/// Path to the cache file for localization data of an SC version.
pub(super) fn localization_cache_path(v: &str) -> Result<PathBuf, String> {
    Ok(
        dirs
            ::config_dir()
            .ok_or("No config dir")?
            .join("penguin-citizen/cache")
            .join(format!("localization_{}.json", v))
    )
}

/// Path to the backup folder for a specific SC version.
/// All profile backups for this version are stored here as subfolders.
pub(super) fn backup_version_dir(v: &str) -> Result<PathBuf, String> {
    if v.is_empty() || v.contains('/') || v.contains('\\') || v.contains("..") {
        return Err("Invalid version ID".into());
    }
    Ok(dirs::config_dir().ok_or("No config dir")?.join("penguin-citizen/backups").join(v))
}
/// Validates a backup ID to prevent path traversal attacks.
/// Blocks empty IDs as well as characters like `/`, `\` and `..`.
pub(super) fn validate_backup_id(bid: &str) -> Result<(), String> {
    if bid.is_empty()
        || bid.contains('/')
        || bid.contains('\\')
        || bid.contains("..")
    {
        return Err("Invalid backup ID".into());
    }
    Ok(())
}

/// Finds a subdirectory matching one of the given path variants.
/// Needed because folder case can vary depending on the system.
pub(super) fn find_dir_case_insensitive(base: &Path, variants: &[&str]) -> Option<PathBuf> {
    for v in variants {
        let p = base.join(v);
        if p.is_dir() {
            return Some(p);
        }
    }
    None
}

/// Reads the value of an XML attribute by its name from an XML start tag.
pub(super) fn get_attr(e: &BytesStart, n: &[u8]) -> Option<String> {
    for a in e.attributes().flatten() {
        if a.key.as_ref() == n {
            return Some(String::from_utf8_lossy(&a.value).into_owned());
        }
    }
    None
}
/// Parses a global.ini localization file into a HashMap.
/// Format: Each line contains `key=value`. Lines starting with `;` are comments.
/// A leading `@` in the key is removed (SC convention for label references).
pub(super) fn parse_global_ini(c: &str) -> HashMap<String, String> {
    let mut m = HashMap::new();
    for l in c.lines() {
        let t = l.trim();
        if t.is_empty() || t.starts_with(';') {
            continue;
        }
        if let Some(p) = t.find('=') {
            let mut k = t[..p].trim().to_string();
            if k.starts_with('@') {
                k = k[1..].to_string();
            }
            m.insert(k, t[p + 1..].trim().to_string());
        }
    }
    m
}

/// Parses an actionmaps.xml file (user key bindings) into a structured representation.
///
/// The XML structure is hierarchical:
/// `<ActionMaps>` -> `<ActionProfiles>` -> `<options>` (devices), `<deviceoptions>`,
/// `<actionmap>` -> `<action>` -> `<rebind>`.
///
/// Variables: cp = current profile, cm = current action map, ca = current action.
pub(super) fn parse_actionmaps_xml(c: &str) -> Result<ParsedActionMaps, String> {
    let mut r = Reader::from_str(c.trim().trim_matches('\0'));
    r.config_mut().trim_text(true);
    let mut res = ParsedActionMaps::default();
    let mut current_device_options: Option<ScDeviceOptions> = None;
    // Index into cp.devices for the current <options> block (to attach tuning children)
    let mut current_device_index: Option<usize> = None;
    // cp = current profile, cm = current map, ca = current action name
    let (mut cp, mut cm, mut ca) = (None, None, None);
    let mut buf = Vec::new();
    loop {
        let event = r.read_event_into(&mut buf);
        // Track whether this is a Start (has children) or Empty (self-closing) event
        let is_start_event = matches!(&event, Ok(Event::Start(_)));
        match event {
            Ok(Event::Eof) => {
                break;
            }
            Ok(Event::Start(ref e)) | Ok(Event::Empty(ref e)) => {
                let tag = String::from_utf8_lossy(e.name().as_ref()).to_lowercase();
                match tag.as_str() {
                    "actionmaps" => {
                        res.version = get_attr(e, b"version").unwrap_or("1".into());
                    }
                    "actionprofiles" => {
                        cp = Some(ScActionProfile {
                            profile_name: get_attr(e, b"profileName")
                                .or(get_attr(e, b"profile_name"))
                                .unwrap_or_default(),
                            version: get_attr(e, b"version").unwrap_or("1".into()),
                            options_version: get_attr(e, b"optionsVersion").unwrap_or("2".into()),
                            rebind_version: get_attr(e, b"rebindVersion").unwrap_or("2".into()),
                            devices: vec![],
                            device_options: vec![],
                            modifiers: None,
                            action_maps: vec![],
                        });

                    }
                    "options" => {
                        // <options> tags define input devices with type, instance, and product name.
                        // The GUID is embedded in the Product attribute: "DeviceName {GUID}"
                        if let Some(ref mut p) = cp {
                            let mut product = get_attr(e, b"Product").unwrap_or_default();
                            // Extract GUID from product name (format: "Name {GUID}")
                            let guid = if product.contains('{') {
                                product
                                    .split('{')
                                    .nth(1)
                                    .and_then(|s| s.strip_suffix('}'))
                                    .map(|s| s.to_string())
                            } else {
                                None
                            };
                            // Remove GUID from product name: "Device {GUID}" -> "Device"
                            if let Some(ref g) = guid {
                                let pattern = format!("{{{}}}", g);
                                if let Some(start) = product.find(&pattern) {
                                    let end_pos = start + pattern.len();
                                    if end_pos <= product.len() {
                                        product = format!(
                                            "{}{}",
                                            &product[..start].trim_end(),
                                            &product[end_pos..]
                                        );
                                    } else {
                                        product = product[..start].trim_end().to_string();
                                    }
                                }
                            }
                            p.devices.push(ScDevice {
                                device_type: get_attr(e, b"type").unwrap_or_default(),
                                instance: get_attr(e, b"instance")
                                    .and_then(|v| v.parse().ok())
                                    .unwrap_or(0),
                                product: product.trim().to_string(),
                                guid,
                                tuning: vec![],
                            });
                            // If <options> has children (Start event), track index for tuning
                            if is_start_event {
                                current_device_index = Some(p.devices.len() - 1);
                            }
                        }
                    }
                    "deviceoptions" => {
                        let name = get_attr(e, b"name").unwrap_or_default();
                        current_device_options = Some(ScDeviceOptions {
                            name,
                            options: vec![],
                        });
                    }
                    "option" => {
                        if let Some(ref mut do_opts) = current_device_options {
                            let input = get_attr(e, b"input").unwrap_or_default();
                            let deadzone = get_attr(e, b"deadzone").and_then(|v| v.parse().ok());
                            let saturation = get_attr(e, b"saturation").and_then(|v|
                                v.parse().ok()
                            );
                            do_opts.options.push(ScDeviceOption {
                                input: input.clone(),
                                deadzone,
                                saturation,
                            });
                        }
                    }
                    "actionmap" => {
                        cm = Some(ScActionMap {
                            name: get_attr(e, b"name").unwrap_or_default(),
                            bindings: vec![],
                            actions: vec![],
                        });
                    }
                    "action" => {
                        let n = get_attr(e, b"name").unwrap_or_default();
                        ca = Some(n.clone());
                        if let Some(ref mut m) = cm {
                            m.actions.push(ScAction { name: n, label: get_attr(e, b"label") });
                        }
                    }
                    "rebind" => {
                        if let (Some(ref mut m), Some(ref a)) = (cm.as_mut(), ca.as_ref()) {
                            // Find existing binding for this action in this map, or create new
                            if let Some(existing) = m.bindings.iter_mut().find(|b| &b.action_name == *a) {

                                let input = get_attr(e, b"input").unwrap_or_default();
                                if !existing.inputs.contains(&input) {
                                    existing.inputs.push(input);
                                }
                            } else {
                                m.bindings.push(ScBinding {
                                    action_name: a.to_string(),
                                    inputs: vec![get_attr(e, b"input").unwrap_or_default()],
                                });
                            }
                        }
                    }
                    "modifiers" => {
                        // Just track that the tag exists for now to preserve it on write
                        if let Some(ref mut p) = cp {
                            p.modifiers = Some("".to_string());
                        }
                    }

                    _ => {
                        // Inside an <options> block: parse unknown children as tuning entries
                        if let Some(dev_idx) = current_device_index {
                            if let Some(ref mut p) = cp {
                                if let Some(dev) = p.devices.get_mut(dev_idx) {
                                    let invert = get_attr(e, b"invert").and_then(|v| v.parse().ok());
                                    let exponent = get_attr(e, b"exponent").and_then(|v| v.parse().ok());
                                    let sensitivity = get_attr(e, b"sensitivity").and_then(|v| v.parse().ok());
                                    if invert.is_some() || exponent.is_some() || sensitivity.is_some() {
                                        dev.tuning.push(ScOptionsTuning {
                                            name: tag.clone(),
                                            invert,
                                            exponent,
                                            sensitivity,
                                        });
                                    }
                                }
                            }
                        }
                    }
                }
            }
            Ok(Event::End(ref e)) => {
                let tag = String::from_utf8_lossy(e.name().as_ref()).to_lowercase();
                match tag.as_str() {
                    "options" => {
                        current_device_index = None;
                    }
                    "actionmap" => {
                        if let (Some(m), Some(ref mut p)) = (cm.take(), cp.as_mut()) {
                            p.action_maps.push(m);
                        }
                    }
                    "actionprofiles" => {
                        if let Some(p) = cp.take() {
                            res.profiles.push(p);
                        }
                    }
                    "action" => {
                        ca = None;
                    }
                    "deviceoptions" => {
                        if let Some(do_opts) = current_device_options.take() {
                            if let Some(ref mut p) = cp {
                                p.device_options.push(do_opts);
                            }
                        }
                    }
                    _ => {}
                }
            }
            _ => {}
        }
        buf.clear();
    }
    Ok(res)
}

/// Writes a ParsedActionMaps structure back as an XML file.
/// Produces valid XML in SC actionmaps format with proper indentation.
/// Correctly formats a device name and optional GUID for Star Citizen's XML.
/// SC on Wine/Windows expects exactly TWO spaces between the name and the GUID.
pub(super) fn format_sc_device_name(name: &str, guid: Option<&str>) -> String {
    if let Some(g) = guid {
        // SC format: "Name  {GUID}"
        format!("{}  {{{}}}", name.trim(), g)
    } else {
        name.to_string()
    }
}

pub fn write_actionmaps_xml(path: &Path, res: &ParsedActionMaps) -> Result<(), String> {
    use quick_xml::events::{ BytesDecl, BytesEnd, BytesStart, Event };

    // Use a cursor to capture the XML in memory first for post-processing
    let mut w = Writer::new_with_indent(Cursor::new(Vec::new()), b' ', 1);

    // Write XML declaration: Star Citizen uses lowercase encoding="utf-8"
    w.write_event(Event::Decl(BytesDecl::new("1.0", Some("utf-8"), None))).ok();

    // <ActionMaps version="1">
    let mut root = BytesStart::new("ActionMaps");
    root.push_attribute(("version", res.version.as_str()));
    w.write_event(Event::Start(root)).ok();

    for po in &res.profiles {
        // <ActionProfiles profileName="default" version="1" optionsVersion="2" rebindVersion="2">
        let mut p_tag = BytesStart::new("ActionProfiles");
        p_tag.push_attribute(("profileName", po.profile_name.as_str()));
        p_tag.push_attribute(("version", po.version.as_str()));
        p_tag.push_attribute(("optionsVersion", po.options_version.as_str()));
        p_tag.push_attribute(("rebindVersion", po.rebind_version.as_str()));
        w.write_event(Event::Start(p_tag)).ok();

        // Write devices with GUID in Product attribute (sorted by instance for consistency)
        let mut devices = po.devices.clone();
        devices.sort_by_key(|d| d.instance);

        for d in &devices {
            let mut d_tag = BytesStart::new("options");
            d_tag.push_attribute(("type", d.device_type.as_str()));
            d_tag.push_attribute(("instance", d.instance.to_string().as_str()));
            if !d.product.is_empty() {
                let product_with_guid = format_sc_device_name(&d.product, d.guid.as_deref());
                d_tag.push_attribute(("Product", product_with_guid.as_str()));
            }

            if d.tuning.is_empty() {
                w.write_event(Event::Empty(d_tag)).ok();
            } else {
                w.write_event(Event::Start(d_tag)).ok();
                for t in &d.tuning {
                    let mut t_tag = BytesStart::new(t.name.as_str());

                    // SC always writes 'invert' if it exists (even if 0)
                    t_tag.push_attribute(("invert", t.invert.unwrap_or(0).to_string().as_str()));

                    // SC only writes exponent/sensitivity if they are NOT 1.0
                    if let Some(exp) = t.exponent {
                        if (exp - 1.0).abs() > 0.000001 {
                            t_tag.push_attribute(("exponent", format!("{:.9}", exp).trim_end_matches('0').trim_end_matches('.').to_string().as_str()));
                        }
                    }

                    if let Some(sens) = t.sensitivity {
                        if (sens - 1.0).abs() > 0.000001 {
                            t_tag.push_attribute(("sensitivity", format!("{:.9}", sens).trim_end_matches('0').trim_end_matches('.').to_string().as_str()));
                        }
                    }

                    w.write_event(Event::Empty(t_tag)).ok();
                }
                w.write_event(Event::End(BytesEnd::new("options"))).ok();
            }
        }

        // Write device options (deadzone, saturation)
        for do_opts in &po.device_options {
            let mut do_tag = BytesStart::new("deviceoptions");

            let normalized_name = if let Some(idx) = do_opts.name.find('{') {
                let name = do_opts.name[..idx].trim();
                let guid = &do_opts.name[idx + 1..do_opts.name.len() - 1];
                format_sc_device_name(name, Some(guid))
            } else {
                do_opts.name.clone()
            };

            do_tag.push_attribute(("name", normalized_name.as_str()));
            w.write_event(Event::Start(do_tag)).ok();

            for opt in &do_opts.options {
                let mut o_tag = BytesStart::new("option");
                o_tag.push_attribute(("input", opt.input.as_str()));
                if let Some(dz) = opt.deadzone {
                    o_tag.push_attribute(("deadzone", format!("{:.9}", dz).trim_end_matches('0').trim_end_matches('.').to_string().as_str()));
                }
                if let Some(sat) = opt.saturation {
                    o_tag.push_attribute(("saturation", format!("{:.9}", sat).trim_end_matches('0').trim_end_matches('.').to_string().as_str()));
                }
                w.write_event(Event::Empty(o_tag)).ok();
            }

            w.write_event(Event::End(BytesEnd::new("deviceoptions"))).ok();
        }

        if po.modifiers.is_some() {
            w.write_event(Event::Empty(BytesStart::new("modifiers"))).ok();
        }

        for am in &po.action_maps {
            let mut am_tag = BytesStart::new("actionmap");
            am_tag.push_attribute(("name", am.name.as_str()));
            w.write_event(Event::Start(am_tag)).ok();

            for b in &am.bindings {
                let mut a_tag = BytesStart::new("action");
                a_tag.push_attribute(("name", b.action_name.as_str()));
                w.write_event(Event::Start(a_tag)).ok();

                for input in &b.inputs {
                    let mut r_tag = BytesStart::new("rebind");
                    r_tag.push_attribute(("input", input.as_str()));
                    w.write_event(Event::Empty(r_tag)).ok();
                }

                w.write_event(Event::End(BytesEnd::new("action"))).ok();
            }

            w.write_event(Event::End(BytesEnd::new("actionmap"))).ok();
        }

        w.write_event(Event::End(BytesEnd::new("ActionProfiles"))).ok();
    }

    w.write_event(Event::End(BytesEnd::new("ActionMaps"))).ok();

    // Final processing: Take the XML buffer and convert LF to CRLF for Star Citizen compatibility
    let buffered = w.into_inner().into_inner();
    let xml_str = String::from_utf8(buffered).map_err(|e| e.to_string())?;

    // Replace LF with CRLF and ensure trailing CRLF (Star Citizen style)
    let final_xml = xml_str.replace("\n", "\r\n").trim_end().to_string() + "\r\n";

    fs::write(path, final_xml).map_err(|e| e.to_string())?;

    Ok(())
}


/// Finds the ZIP64 Central Directory in a P4K archive file.
///
/// Searches backwards from the end of the file for the ZIP64 End-of-Central-Directory locator
/// (signature `PK\x06\x07`), then reads the offset to the EOCD64 record and extracts
/// the position and size of the Central Directory from it.
///
/// The Central Directory is the table of contents of the ZIP archive and contains
/// the metadata of all contained files.
///
/// # Returns
/// Tuple of `(central_directory_offset, central_directory_size)`.
pub(super) fn find_central_directory(file: &mut File, file_length: u64) -> Result<(u64, u64), String> {
    let search_size = (65536u64).min(file_length) as usize;
    file
        .seek(SeekFrom::End(-(search_size as i64)))
        .map_err(|e| format!("Failed to seek to end of P4K: {}", e))?;

    let mut buffer = vec![0u8; search_size];
    file.read_exact(&mut buffer).map_err(|e| format!("Failed to read P4K tail: {}", e))?;

    for i in (0..search_size.saturating_sub(4)).rev() {
        if &buffer[i..i + 4] == b"PK\x06\x07" {
            // Found ZIP64 EOCD locator - read offset to EOCD64 record
            file
                .seek(SeekFrom::Start(file_length - (search_size as u64) + (i as u64) + 8))
                .map_err(|e| format!("Failed to seek to EOCD64 locator: {}", e))?;

            let mut offset_bytes = [0u8; 8];
            file
                .read_exact(&mut offset_bytes)
                .map_err(|e| format!("Failed to read EOCD64 offset: {}", e))?;
            let eocd_offset = u64::from_le_bytes(offset_bytes);

            // Read central directory size and offset from EOCD64 record
            file
                .seek(SeekFrom::Start(eocd_offset + 40))
                .map_err(|e| format!("Failed to seek to EOCD64 record: {}", e))?;

            let mut size_bytes = [0u8; 8];
            file
                .read_exact(&mut size_bytes)
                .map_err(|e| format!("Failed to read central directory size: {}", e))?;

            let mut cd_offset_bytes = [0u8; 8];
            file
                .read_exact(&mut cd_offset_bytes)
                .map_err(|e| format!("Failed to read central directory offset: {}", e))?;

            return Ok((u64::from_le_bytes(cd_offset_bytes), u64::from_le_bytes(size_bytes)));
        }
    }

    Err("No ZIP64 end-of-central-directory locator found in P4K".into())
}

/// Reads and decompresses a single file from a Star Citizen P4K archive (ZIP64).
///
/// P4K files use the ZIP64 format with zstd-compressed entries.
/// This function searches for the file in the Central Directory, reads the compressed
/// data, and decompresses it as needed (methods 93/100 = zstd).
///
/// The process:
/// 1. Find the Central Directory (contains all file entries)
/// 2. Search for the target filename in the Central Directory (case-insensitive)
/// 3. Handle ZIP64 extra fields for large files
/// 4. Read the Local File Header to determine the actual data offset
/// 5. Read compressed data and decompress with zstd
pub fn read_p4k_file(game_path: &str, version: &str, file_path: &str) -> Result<Vec<u8>, String> {
    let p4k_path = sc_p4k_path(game_path, version)?;
    let mut file = File::open(&p4k_path).map_err(|e| e.to_string())?;
    let file_length = file
        .metadata()
        .map_err(|e| e.to_string())?
        .len();

    let (cd_offset, cd_size) = find_central_directory(&mut file, file_length)?;

    file
        .seek(SeekFrom::Start(cd_offset))
        .map_err(|e| format!("Failed to seek to central directory: {}", e))?;
    let mut central_dir = vec![0u8; cd_size as usize];
    file
        .read_exact(&mut central_dir)
        .map_err(|e| format!("Failed to read central directory: {}", e))?;

    let search_name = file_path.replace('/', "\\");
    let mut pos = 0;

    while pos + 46 <= central_dir.len() {
        if &central_dir[pos..pos + 4] != b"PK\x01\x02" {
            pos += 1;
            continue;
        }

        let name_length = u16::from_le_bytes([
            central_dir[pos + 28],
            central_dir[pos + 29],
        ]) as usize;
        let extra_length = u16::from_le_bytes([
            central_dir[pos + 30],
            central_dir[pos + 31],
        ]) as usize;
        let comment_length = u16::from_le_bytes([
            central_dir[pos + 32],
            central_dir[pos + 33],
        ]) as usize;

        if pos + 46 + name_length > central_dir.len() {
            break;
        }

        let entry_name = String::from_utf8_lossy(&central_dir[pos + 46..pos + 46 + name_length]);

        if entry_name.eq_ignore_ascii_case(&search_name) {
            let mut compressed_size = u32::from_le_bytes([
                central_dir[pos + 20],
                central_dir[pos + 21],
                central_dir[pos + 22],
                central_dir[pos + 23],
            ]) as u64;
            let mut local_header_offset = u32::from_le_bytes([
                central_dir[pos + 42],
                central_dir[pos + 43],
                central_dir[pos + 44],
                central_dir[pos + 45],
            ]) as u64;

            // Check ZIP64 extra field for large files
            if extra_length >= 28 {
                let extra_start = pos + 46 + name_length;
                if
                    extra_start + 28 <= central_dir.len() &&
                    u16::from_le_bytes([central_dir[extra_start], central_dir[extra_start + 1]]) ==
                        0x0001
                {
                    compressed_size = u64::from_le_bytes(
                        central_dir[extra_start + 12..extra_start + 20]
                            .try_into()
                            .map_err(|_| "Invalid ZIP64 compressed size field")?
                    );
                    local_header_offset = u64::from_le_bytes(
                        central_dir[extra_start + 20..extra_start + 28]
                            .try_into()
                            .map_err(|_| "Invalid ZIP64 offset field")?
                    );
                }
            }

            let compression_method = u16::from_le_bytes([
                central_dir[pos + 10],
                central_dir[pos + 11],
            ]);

            // Read local file header to find actual data offset
            file
                .seek(SeekFrom::Start(local_header_offset))
                .map_err(|e| format!("Failed to seek to local header: {}", e))?;
            let mut local_header = [0u8; 30];
            file
                .read_exact(&mut local_header)
                .map_err(|e| format!("Failed to read local header: {}", e))?;

            let local_name_len = u16::from_le_bytes([local_header[26], local_header[27]]) as u64;
            let local_extra_len = u16::from_le_bytes([local_header[28], local_header[29]]) as u64;
            let data_offset = local_header_offset + 30 + local_name_len + local_extra_len;

            file
                .seek(SeekFrom::Start(data_offset))
                .map_err(|e| format!("Failed to seek to file data: {}", e))?;
            let mut compressed_data = vec![0u8; compressed_size as usize];
            file
                .read_exact(&mut compressed_data)
                .map_err(|e| format!("Failed to read file data: {}", e))?;

            // Decompress zstd (compression methods 93 and 100)
            if compression_method == 100 || compression_method == 93 {
                let mut decoder = zstd::Decoder
                    ::new(Cursor::new(compressed_data))
                    .map_err(|e| format!("zstd init error: {}", e))?;
                let mut decompressed = vec![];
                decoder
                    .read_to_end(&mut decompressed)
                    .map_err(|e| format!("zstd decode error: {}", e))?;
                return Ok(decompressed);
            }

            return Ok(compressed_data);
        }

        pos += 46 + name_length + extra_length + comment_length;
    }

    Err("File not found in P4K archive".into())
}

/// Reads a null-terminated C string from a byte buffer starting at the given offset.
/// Used to read strings from the CryXmlB string table.
/// Extracts the device prefix type from an SC input string.
/// e.g. "kb1_w" -> "kb", "js2_button5" -> "js", "mo1_mouse1" -> "mo"
pub(super) fn device_prefix(input: &str) -> &str {
    let s = input.trim();
    if s.len() >= 2 {
        let prefix = &s[..2];
        match prefix {
            "kb" | "mo" | "js" | "gp" | "xi" => return prefix,
            _ => {}
        }
    }
    ""
}

pub(super) fn read_c_string(string_table: &[u8], offset: usize) -> String {
    if offset >= string_table.len() {
        return String::new();
    }
    let length = string_table[offset..]
        .iter()
        .position(|&b| b == 0)
        .unwrap_or(string_table.len() - offset);
    String::from_utf8_lossy(&string_table[offset..offset + length]).into_owned()
}

/// Recursively traverses the CryXmlB binary XML node tree and extracts action maps.
///
/// Searches for `actionmap`, `action`, and `rebind` elements that define Star Citizen's
/// default key bindings. Xbox/Gamepad nodes are skipped since only PC bindings are relevant.
///
/// Each node has:
/// - A tag name (offset into the string table)
/// - Attributes (key-value pairs, also via string table offsets)
/// - Child nodes (indices into the child table)
#[allow(clippy::too_many_arguments)]
pub(super) fn traverse_xml_node(
    data: &[u8],
    node_table_offset: usize,
    attr_table_offset: usize,
    string_table: &[u8],
    child_table: &[u8],
    node_index: usize,
    profile: &mut ScActionProfile,
    mut current_map_index: Option<usize>
) {
    let node_start = node_table_offset + node_index * 28;
    if node_start + 28 > data.len() {
        return;
    }

    let node_data = &data[node_start..node_start + 28];
    let tag_offset = u32::from_le_bytes(node_data[0..4].try_into().unwrap_or_default()) as usize;
    let tag = read_c_string(string_table, tag_offset).to_lowercase();

    // Skip Xbox/Gamepad nodes - only PC bindings are relevant
    if tag == "xboxone" || tag == "gamepad" {
        return;
    }

    let attr_count = u16::from_le_bytes(node_data[8..10].try_into().unwrap_or_default()) as usize;
    let child_count = u16::from_le_bytes(node_data[10..12].try_into().unwrap_or_default()) as usize;
    let first_attr_index = u32::from_le_bytes(
        node_data[16..20].try_into().unwrap_or_default()
    ) as usize;
    let first_child_index = u32::from_le_bytes(
        node_data[20..24].try_into().unwrap_or_default()
    ) as usize;

    // Collect attributes for this node
    let mut attrs = HashMap::new();
    for i in 0..attr_count {
        let attr_offset = attr_table_offset + (first_attr_index + i) * 8;
        if attr_offset + 8 > data.len() {
            continue;
        }
        let key_offset = u32::from_le_bytes(
            data[attr_offset..attr_offset + 4].try_into().unwrap_or_default()
        ) as usize;
        let value_offset = u32::from_le_bytes(
            data[attr_offset + 4..attr_offset + 8].try_into().unwrap_or_default()
        ) as usize;
        let key = read_c_string(string_table, key_offset).to_lowercase();
        let value = read_c_string(string_table, value_offset);
        attrs.insert(key, value);
    }

    // Build action maps from recognized tags
    if tag == "actionmap" {
        if let Some(name) = attrs.get("name") {
            current_map_index = Some(profile.action_maps.len());
            profile.action_maps.push(ScActionMap {
                name: name.clone(),
                bindings: vec![],
                actions: vec![],
            });
        }
    } else if tag == "action" {
        if let (Some(idx), Some(name)) = (current_map_index, attrs.get("name").or(attrs.get("id"))) {
            profile.action_maps[idx].actions.push(ScAction {
                name: name.clone(),
                label: attrs.get("label").or(attrs.get("uilabel")).cloned(),
            });

            // In CryXmlB defaultProfile, default bindings are stored as attributes
            // on the action element: keyboard="w", mouse="mouse1", joystick=" ", gamepad="dpad_up"
            // A single space " " means no binding for that device.
            let mut inputs = vec![];
            for (device_prefix, attr_key) in [("kb1_", "keyboard"), ("mo1_", "mouse"), ("js1_", "joystick"), ("gp1_", "gamepad")] {
                if let Some(raw) = attrs.get(attr_key) {
                    let trimmed = raw.trim();
                    if !trimmed.is_empty() {
                        inputs.push(format!("{}{}", device_prefix, trimmed));
                    }
                }
            }
            if !inputs.is_empty() {
                profile.action_maps[idx].bindings.push(ScBinding {
                    action_name: name.clone(),
                    inputs,
                });
            }
        }
    } else if tag == "rebind" {
        // User actionmaps.xml uses <rebind input="..."/> children
        if let (Some(idx), Some(input)) = (current_map_index, attrs.get("input")) {
            if let Some(last_action) = profile.action_maps[idx].actions.last() {
                let action_name = last_action.name.clone();
                profile.action_maps[idx].bindings.push(ScBinding {
                    action_name,
                    inputs: vec![input.clone()],
                });
            }
        }
    }

    // Recurse into child nodes
    for i in 0..child_count {
        let child_offset = (first_child_index + i) * 4;
        if child_offset + 4 <= child_table.len() {
            let child_node_index = u32::from_le_bytes(
                child_table[child_offset..child_offset + 4].try_into().unwrap_or_default()
            ) as usize;
            traverse_xml_node(
                data,
                node_table_offset,
                attr_table_offset,
                string_table,
                child_table,
                child_node_index,
                profile,
                current_map_index
            );
        }
    }
}

/// Parses a CryXmlB binary XML file containing Star Citizen's default action maps.
///
/// CryXmlB is Star Citizen's proprietary binary XML format. The header starting at byte 12
/// contains offsets to four tables:
/// - Node table: tree structure of XML nodes (28 bytes each)
/// - Attribute table: key-value pairs (8 bytes each, offsets into string table)
/// - Child table: indices of child nodes (4 bytes each)
/// - String table: null-terminated strings for all tag/attribute names and values
///
/// The file must start with the magic bytes `CryXmlB`.
/// Returns a ParsedActionMaps with a "master" profile.
pub(super) fn parse_cryxmlb_full(data: &[u8]) -> Result<ParsedActionMaps, String> {
    if !data.starts_with(b"CryXmlB") {
        return Err("Not a CryXmlB file".into());
    }
    if data.len() < 44 {
        return Err("CryXmlB header too short".into());
    }

    let node_table_offset = u32::from_le_bytes(
        data[12..16].try_into().map_err(|_| "Invalid node table offset")?
    ) as usize;
    let attr_table_offset = u32::from_le_bytes(
        data[20..24].try_into().map_err(|_| "Invalid attr table offset")?
    ) as usize;
    let child_table_offset = u32::from_le_bytes(
        data[28..32].try_into().map_err(|_| "Invalid child table offset")?
    ) as usize;
    let child_table_count = u32::from_le_bytes(
        data[32..36].try_into().map_err(|_| "Invalid child table count")?
    ) as usize;
    let string_table_offset = u32::from_le_bytes(
        data[36..40].try_into().map_err(|_| "Invalid string table offset")?
    ) as usize;
    let string_table_size = u32::from_le_bytes(
        data[40..44].try_into().map_err(|_| "Invalid string table size")?
    ) as usize;

    if string_table_offset + string_table_size > data.len() {
        return Err("String table extends beyond file boundary".into());
    }
    if child_table_offset + child_table_count * 4 > data.len() {
        return Err("Child table extends beyond file boundary".into());
    }

    let string_table = &data[string_table_offset..string_table_offset + string_table_size];
    let child_table = &data[child_table_offset..child_table_offset + child_table_count * 4];

    let mut profile = ScActionProfile {
        profile_name: "master".into(),
        version: "1".into(),
        options_version: "2".into(),
        rebind_version: "2".into(),
        devices: vec![],
        device_options: vec![],
        modifiers: None,
        action_maps: vec![],
    };


    traverse_xml_node(
        data,
        node_table_offset,
        attr_table_offset,
        string_table,
        child_table,
        0,
        &mut profile,
        None
    );

    Ok(ParsedActionMaps {
        version: "1".into(),
        profiles: vec![profile],
    })
}

/// Simple string-based attributes.xml parser.
pub fn parse_attributes_str(c: &str) -> ScAttributes {
    let mut attrs = ScAttributes::default();
    if let Some(s) = c.find("Version=\"").or(c.find("version=\"")) {
        let st = s + 9;
        if let Some(e) = c[st..].find('"') {
            attrs.version = c[st..st + e].to_string();
        }
    }
    let mut pos = 0;
    while let Some(s) = c[pos..].find("<Attr ") {
        let st = pos + s;
        if let Some(ns) = c[st..].find("name=\"") {
            let nst = st + ns + 6;
            if let Some(ne) = c[nst..].find('"') {
                let n = c[nst..nst + ne].to_string();
                if let Some(vs) = c[nst + ne..].find("value=\"") {
                    let vst = nst + ne + vs + 7;
                    if let Some(ve) = c[vst..].find('"') {
                        attrs.attrs.push(ScAttribute {
                            name: n,
                            value: c[vst..vst + ve].to_string(),
                        });
                    }
                }
            }
        }
        pos = st + 1;
    }
    attrs
}

/// Derives a device mapping from the `<options>` tags of a parsed actionmaps.xml.
/// Used to populate the device_map in backup_meta.json.
pub(super) fn derive_device_map(parsed: &ParsedActionMaps) -> Vec<DeviceMapping> {
    let mut map = vec![];
    for profile in &parsed.profiles {
        for dev in &profile.devices {
            if dev.product.is_empty() { continue; }
            map.push(DeviceMapping {
                product_name: dev.product.clone(),
                device_type: dev.device_type.clone(),
                sc_guid: dev.guid.clone(),
                sc_instance: dev.instance,
                alias: None,
                axis_wine_map: std::collections::HashMap::new(),
            });
        }
    }
    map
}

/// Saves the backup metadata as JSON to the backup folder.
pub(super) fn save_backup_meta(bdir: &Path, info: &BackupInfo) -> Result<(), String> {
    let json = serde_json::to_string_pretty(info).map_err(|e| e.to_string())?;
    fs::write(bdir.join("backup_meta.json"), json).map_err(|e| e.to_string())
}

/// Computes the SHA256 hash of a file. Used for change detection in backups.
/// Calculates a stable, logical hash for a file.
/// For actionmaps.xml and attributes.xml, it uses a canonicalized data-driven
/// representation that ignores formatting and noise.
/// For other files, it falls back to a raw SHA-256 byte hash.
pub(super) fn hash_file(path: &Path) -> Option<String> {
    let filename = path.file_name()?.to_string_lossy();

    if filename == "actionmaps.xml" {
        if let Ok(data) = fs::read_to_string(path) {
            if let Ok(mut parsed) = parse_actionmaps_xml(&data) {
                // Canonicalize: Sort everything alphabetically and normalize numbers
                parsed.canonicalize();
                if let Ok(json) = serde_json::to_string(&parsed) {
                    return Some(format!("{:x}", Sha256::digest(json.as_bytes())));
                }
            }
        }
    } else if filename == "attributes.xml" {
        if let Ok(data) = fs::read_to_string(path) {
            let mut parsed: ScAttributes = parse_attributes_str(&data);
            // Canonicalize: Filter out noise (timestamps, versions) and sort
            parsed.canonicalize();
            if let Ok(json) = serde_json::to_string(&parsed) {
                return Some(format!("{:x}", Sha256::digest(json.as_bytes())));
            }
        }
    } else if filename == "profile.xml" {
        if let Ok(data) = fs::read_to_string(path) {
            // Simple string filter for LastPlayed="..." attribute
            let mut filtered = data.clone();
            if let Some(st) = filtered.find("LastPlayed=\"") {
                if let Some(en) = filtered[st + 12..].find('"') {
                    filtered.replace_range(st..st + 12 + en + 1, "");
                }
            }
            return Some(format!("{:x}", Sha256::digest(filtered.as_bytes())));
        }
    }

    // Default: Raw byte hash for other files
    let data = fs::read(path).ok()?;
    let hash = Sha256::digest(&data);
    Some(format!("{:x}", hash))
}

/// Helper function: sets the dirty flag and recalculates the hash of actionmaps.xml.
/// Called after every change to a profile backup so the frontend can detect
/// that the profile has not yet been applied to SC.
pub(super) fn mark_backup_dirty(bdir: &Path) -> Result<(), String> {
    let meta_path = bdir.join("backup_meta.json");
    let meta_json = fs::read_to_string(&meta_path).map_err(|e| e.to_string())?;
    let mut meta: BackupInfo = serde_json::from_str(&meta_json).map_err(|e| e.to_string())?;
    meta.dirty = true;
    let actionmaps_path = bdir.join("actionmaps.xml");
    if let Some(h) = hash_file(&actionmaps_path) {
        meta.file_hashes.insert("actionmaps.xml".into(), h);
    }
    save_backup_meta(bdir, &meta)
}

/// Translates a Linux/gilrs axis name in an SC input string to its Wine/DirectInput
/// equivalent using the device's `axis_wine_map`. Returns the input unchanged if
/// no mapping exists (buttons, hats, keyboard, or no entry found).
///
/// Examples:
///   "js2_slider1"    -> "js2_roty"    (mapping: slider1 -> roty)
///   "js2_slider1neg" -> "js2_rotyneg" (direction suffix preserved)
///   "js2_button5"    -> "js2_button5" (buttons are not translated)
///   "kb1_w"          -> "kb1_w"       (keyboard inputs are not translated)
pub(super) fn translate_wine_axis(input: &str, device_map: &[DeviceMapping]) -> String {
    let under = match input.find('_') {
        Some(i) => i,
        None => return input.to_string(),
    };
    let prefix = &input[..under];       // "js2"
    let axis_part = &input[under + 1..]; // "slider1" or "slider1neg"

    // Only translate joystick inputs
    if !prefix.starts_with("js") {
        return input.to_string();
    }
    let instance: u32 = match prefix[2..].parse() {
        Ok(n) => n,
        Err(_) => return input.to_string(),
    };

    // Strip optional neg/pos direction suffix
    let (base_axis, suffix) = if let Some(base) = axis_part.strip_suffix("neg") {
        (base, "neg")
    } else if let Some(base) = axis_part.strip_suffix("pos") {
        (base, "pos")
    } else {
        (axis_part, "")
    };

    // Only translate known SC axis names (not buttons, hats, or composites)
    const AXIS_NAMES: &[&str] = &["x", "y", "z", "rotx", "roty", "rotz", "slider1", "slider2"];
    if !AXIS_NAMES.contains(&base_axis) {
        return input.to_string();
    }

    // Only match joystick devices -- keyboards and gamepads share instance numbers
    // but never have axis mappings.
    if let Some(dm) = device_map.iter().find(|d| {
        d.sc_instance == instance && d.device_type == "joystick"
    }) {
        if let Some(wine_axis) = dm.axis_wine_map.get(base_axis) {
            return format!("{}_{}{}", prefix, wine_axis, suffix);
        }
    }
    input.to_string()
}

/// Sanitises a parsed actionmaps in place, fixing two known malformation classes.
/// Returns the number of distinct actions that had any issue fixed.
///
/// Rule 1 -- Merge duplicate `<action>` entries within the same actionmap:
///   Multiple `ScBinding` entries with the same `action_name` are collapsed into
///   one; duplicate inputs are dropped.
///
/// Rule 2 -- Strip orphaned cleared-prefix inputs:
///   Within a `ScBinding.inputs`, a cleared-prefix entry (e.g. `"js1_"`) that
///   coexists with at least one real input is removed. A lone cleared-prefix entry
///   is kept -- SC needs it to suppress the default binding.
#[allow(dead_code)]
pub fn sanitize_actionmaps(parsed: &mut ParsedActionMaps) -> usize {
    let mut fixed_actions: std::collections::HashSet<String> = std::collections::HashSet::new();

    for profile in &mut parsed.profiles {
        for am in &mut profile.action_maps {
            // Rule 1: merge duplicate ScBinding entries by action_name
            let mut merged: Vec<ScBinding> = Vec::new();
            for binding in am.bindings.drain(..) {
                if let Some(existing) = merged.iter_mut()
                    .find(|b| b.action_name == binding.action_name)
                {
                    fixed_actions.insert(existing.action_name.clone());
                    for input in binding.inputs {
                        if !existing.inputs.contains(&input) {
                            existing.inputs.push(input);
                        }
                    }
                } else {
                    merged.push(binding);
                }
            }
            am.bindings = merged;

            // Rule 2: remove orphaned cleared-prefix inputs
            for binding in &mut am.bindings {
                let has_real = binding.inputs.iter().any(|x| !x.ends_with('_'));
                if has_real {
                    let before = binding.inputs.len();
                    binding.inputs.retain(|x| !x.ends_with('_'));
                    if before > binding.inputs.len() {
                        fixed_actions.insert(binding.action_name.clone());
                    }
                }
            }
        }
    }

    fixed_actions.len()
}

/// Returns the SC input prefix for a device type (e.g. "joystick" -> "js").
/// These prefixes are used in `<rebind input="js1_button5"/>` references.
pub(super) fn device_type_to_input_prefix(device_type: &str) -> &str {
    match device_type {
        "joystick" => "js",
        "keyboard" => "kb",
        "gamepad" => "gp",
        "mouse" => "mo",
        _ => "js",
    }
}

/// Collects SHA256 hashes of all current SC profile files for comparison with a backup.
pub(super) fn collect_current_sc_hashes(user_base: &Path) -> HashMap<String, String> {
    let mut current = HashMap::new();
    let pdir = user_base.join("Profiles/default");
    for f in &["actionmaps.xml", "attributes.xml", "profile.xml"] {
        let src = pdir.join(f);
        if src.exists() {
            if let Some(h) = hash_file(&src) { current.insert(f.to_string(), h); }
        }
    }
    if let Some(controls_dir) = find_dir_case_insensitive(user_base, &["Controls/Mappings", "controls/mappings", "controls/Mappings"]) {
        if let Ok(entries) = fs::read_dir(&controls_dir) {
            for e in entries.flatten() {
                let path = e.path();
                if path.extension().is_some_and(|ext| ext.eq_ignore_ascii_case("xml")) {
                    if let Some(name) = path.file_name() {
                        let key = format!("controls_mappings/{}", name.to_string_lossy());
                        if let Some(h) = hash_file(&path) { current.insert(key, h); }
                    }
                }
            }
        }
    }
    if let Some(chars_dir) = find_dir_case_insensitive(user_base, &["CustomCharacters", "customcharacters"]) {
        if let Ok(entries) = fs::read_dir(&chars_dir) {
            for e in entries.flatten() {
                let path = e.path();
                if path.extension().is_some_and(|ext| ext.eq_ignore_ascii_case("chf")) {
                    if let Some(name) = path.file_name() {
                        let key = format!("custom_characters/{}", name.to_string_lossy());
                        if let Some(h) = hash_file(&path) { current.insert(key, h); }
                    }
                }
            }
        }
    }
    current
}

/// Path to active_profiles.json - stores which profile is active per SC version.
pub(super) fn active_profiles_path() -> Result<std::path::PathBuf, String> {
    Ok(dirs::config_dir().ok_or("No config dir")?.join("penguin-citizen/active_profiles.json"))
}

/// Helper function: determines the SC base directory from a general path string.
/// Tries Wine prefix, direct directory, and the path itself.
pub(super) fn get_sc_base_path(gp: &str) -> Result<PathBuf, String> {
    let exp = expand_tilde(gp);
    let base_paths: Vec<PathBuf> = vec![
        Path::new(&exp).join("drive_c/Program Files/Roberts Space Industries/StarCitizen"),
        Path::new(&exp).join("StarCitizen"),
        Path::new(&exp).to_path_buf()
    ];

    for p in &base_paths {
        if p.exists() && p.is_dir() {
            return Ok(p.clone());
        }
    }
    Err("StarCitizen directory not found".to_string())
}

/// Reads the master bindings (default key bindings) from the P4K archive.
///
/// Uses a filesystem-based cache: if the P4K file has not changed since the last
/// call (same size + modification time), the cache is used.
/// Otherwise, the defaultProfile.xml is extracted from the P4K and parsed as CryXmlB.
///
/// A mutex prevents multiple concurrent requests from overwriting the cache.
pub async fn get_master_bindings(gp: String, v: String) -> Result<ParsedActionMaps, String> {
    let pp = sc_p4k_path(&gp, &v)?;
    let cp = master_bindings_cache_path(&v)?;
    let meta = fs::metadata(&pp).map_err(|e| e.to_string())?;
    let sz = meta.len();
    let modif = meta
        .modified()
        .map_err(|e| e.to_string())?
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();

    if cp.exists() {
        if let Ok(c) = fs::read_to_string(&cp) {
            if let Ok(cached) = serde_json::from_str::<CachedMasterBindings>(&c) {
                if cached.p4k_size == sz && cached.p4k_modified == modif {
                    return Ok(cached.data);
                }
            }
        }
    }

    let _g = MASTER_BINDINGS_LOCK.lock().await;
    let res: Result<ParsedActionMaps, String> = tokio::task
        ::spawn_blocking(move || {
            let p4k = sc_base_dir(&gp, &v)?.join("Data.p4k");
            if !p4k.exists() {
                return Err("No P4K file found".into());
            }

            let mut file = File::open(&p4k).map_err(|e| e.to_string())?;
            let file_length = file
                .metadata()
                .map_err(|e| e.to_string())?
                .len();
            let (cd_offset, cd_size) = find_central_directory(&mut file, file_length)?;

            file
                .seek(SeekFrom::Start(cd_offset))
                .map_err(|e| format!("Failed to seek to central directory: {}", e))?;
            let mut central_dir = vec![0u8; cd_size as usize];
            file
                .read_exact(&mut central_dir)
                .map_err(|e| format!("Failed to read central directory: {}", e))?;

            let pattern = "defaultprofile.xml";
            let mut found_files = vec![];
            let mut pos = 0;
            while pos + 46 <= central_dir.len() {
                if &central_dir[pos..pos + 4] != b"PK\x01\x02" {
                    pos += 1;
                    continue;
                }
                let name_length = u16::from_le_bytes([
                    central_dir[pos + 28],
                    central_dir[pos + 29],
                ]) as usize;
                if pos + 46 + name_length > central_dir.len() {
                    break;
                }
                let name = String::from_utf8_lossy(&central_dir[pos + 46..pos + 46 + name_length]);
                if name.to_lowercase().contains(pattern) {
                    found_files.push(name.to_string());
                }
                let extra_length = u16::from_le_bytes([
                    central_dir[pos + 30],
                    central_dir[pos + 31],
                ]) as usize;
                let comment_length = u16::from_le_bytes([
                    central_dir[pos + 32],
                    central_dir[pos + 33],
                ]) as usize;
                pos += 46 + name_length + extra_length + comment_length;
            }

            let master_path = found_files
                .iter()
                .find(|f| f.ends_with("defaultProfile.xml"))
                .ok_or("No master bindings file found in P4K")?;

            let master_raw = read_p4k_file(&gp, &v, master_path)?;
            let data = parse_cryxmlb_full(&master_raw)?;

            let cached = CachedMasterBindings {
                p4k_size: sz,
                p4k_modified: modif,
                data: data.clone(),
            };
            let cp_path = master_bindings_cache_path(&v)?;
            if let Some(parent) = cp_path.parent() {
                fs::create_dir_all(parent).ok();
            }
            if let Ok(json) = serde_json::to_string(&cached) {
                fs::write(cp_path, json).ok();
            }

            Ok(data)
        }).await
        .map_err(|e| format!("Task failed: {}", e))?;
    res
}

impl ParsedActionMaps {
    pub fn canonicalize(&mut self) {
        self.profiles.sort_by(|a, b| a.profile_name.cmp(&b.profile_name));
        for p in &mut self.profiles {
            p.canonicalize();
        }
    }
}

impl ScActionProfile {
    pub fn canonicalize(&mut self) {
        // Sort sub-collections alphabetically by name/instance
        self.action_maps.sort_by(|a, b| a.name.cmp(&b.name));
        for am in &mut self.action_maps {
            am.canonicalize();
        }
        self.devices.sort_by_key(|a| a.instance);
        for d in &mut self.devices {
            d.canonicalize();
        }
        self.device_options.sort_by(|a, b| a.name.cmp(&b.name));
        for do_opt in &mut self.device_options {
            do_opt.canonicalize();
        }
    }
}

impl ScActionMap {
    pub fn canonicalize(&mut self) {
        self.actions.sort_by(|a, b| a.name.cmp(&b.name));
        self.bindings.sort_by(|a, b| a.action_name.cmp(&b.action_name));
        for b in &mut self.bindings {
            b.inputs.sort();
        }
    }
}

impl ScDevice {
    pub fn canonicalize(&mut self) {
        self.tuning.sort_by(|a, b| a.name.cmp(&b.name));
        // Normalize float precision for hashing (ignore minimal diffs)
        for t in &mut self.tuning {
            if let Some(ref mut exp) = t.exponent { *exp = (*exp * 1000000.0).round() / 1000000.0; }
            if let Some(ref mut sens) = t.sensitivity { *sens = (*sens * 1000000.0).round() / 1000000.0; }
        }
    }
}

impl ScDeviceOptions {
    pub fn canonicalize(&mut self) {
        self.options.sort_by(|a, b| a.input.cmp(&b.input));
        // Normalize float precision
        for o in &mut self.options {
            if let Some(ref mut dz) = o.deadzone { *dz = (*dz * 1000000.0).round() / 1000000.0; }
            if let Some(ref mut sat) = o.saturation { *sat = (*sat * 1000000.0).round() / 1000000.0; }
        }
    }
}

impl ScAttributes {
    pub fn canonicalize(&mut self) {
        // Filter out "noisy" volatile session data
        self.attrs.retain(|a| {
            !matches!(a.name.as_str(),
                "Version" | "lastPlayed" | "WindowPositionX" | "WindowPositionY" |
                "WindowWidth" | "WindowHeight" | "WindowMode" | "UIVolume" | "Focus"
            )
        });
        // Sort alphabetically to be invariant of XML order
        self.attrs.sort_by(|a, b| a.name.cmp(&b.name));
        // Ignore the header version if possible (SC updates it slightly)
        self.version = "1".into();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn test_semantic_actionmaps_hashing() {
        let temp = std::env::temp_dir();
        let file1 = temp.join("actionmaps_test1.xml");
        let file2 = temp.join("actionmaps.xml"); // Must be named exactly for hash_file branch

        let xml1 = r#"<ActionMaps version="1">
    <ActionProfiles profileName="default" version="1" optionsVersion="2" rebindVersion="2">
        <actionmap name="spaceship_movement">
            <action name="v_pitch"><rebind input="js1_x"/></action>
            <action name="v_yaw"><rebind input="js1_y"/></action>
        </actionmap>
    </ActionProfiles>
</ActionMaps>"#;

        // Swapped order of pitch and yaw
        let xml2 = r#"<ActionMaps version="1">
    <ActionProfiles profileName="default" version="1" optionsVersion="2" rebindVersion="2">
        <actionmap name="spaceship_movement">
            <action name="v_yaw"><rebind input="js1_y"/></action>
            <action name="v_pitch"><rebind input="js1_x"/></action>
        </actionmap>
    </ActionProfiles>
</ActionMaps>"#;

        // Test 1: file1 name is different, should use raw hash (different)
        fs::write(&file1, xml1).unwrap();
        let h_raw1 = hash_file(&file1).unwrap();
        fs::write(&file1, xml2).unwrap();
        let h_raw2 = hash_file(&file1).unwrap();
        assert_ne!(h_raw1, h_raw2, "Raw hashes should differ for changed byte order");

        // Test 2: file name is actionmaps.xml, should use logical hash (same)
        fs::write(&file2, xml1).unwrap();
        let h_log1 = hash_file(&file2).unwrap();
        fs::write(&file2, xml2).unwrap();
        let h_log2 = hash_file(&file2).unwrap();
        assert_eq!(h_log1, h_log2, "Logical hashes must match despite node order changes");

        fs::remove_file(&file1).ok();
        fs::remove_file(&file2).ok();
    }

    #[test]
    fn test_semantic_attributes_hashing() {
        let temp = std::env::temp_dir();
        let file1 = temp.join("attributes.xml");

        let xml1 = r#"<Attributes Version="1">
    <Attr name="lastPlayed" value="12345678"/>
    <Attr name="VSync" value="1"/>
</Attributes>"#;

        // Changed lastPlayed, Version and swapped order
        let xml2 = r#"<Attributes Version="2">
    <Attr name="VSync" value="1"/>
    <Attr name="lastPlayed" value="87654321"/>
</Attributes>"#;

        fs::write(&file1, xml1).unwrap();
        let h1 = hash_file(&file1).unwrap();

        fs::write(&file1, xml2).unwrap();
        let h2 = hash_file(&file1).unwrap();

        assert_eq!(h1, h2, "Hashes must match despite session noise in attributes.xml");
        fs::remove_file(&file1).ok();
    }

    #[test]
    fn test_semantic_profile_hashing() {
        let temp = std::env::temp_dir();
        let file1 = temp.join("profile.xml");

        let xml1 = r#"<Profile Name="default" LastPlayed="1774630092" LastTimeQRCodeDisabled="139638949847072"/>"#;
        let xml2 = r#"<Profile Name="default" LastPlayed="1774630895" LastTimeQRCodeDisabled="139638949847072"/>"#;

        fs::write(&file1, xml1).unwrap();
        let h1 = hash_file(&file1).unwrap();

        fs::write(&file1, xml2).unwrap();
        let h2 = hash_file(&file1).unwrap();

        assert_eq!(h1, h2, "Hashes must match despite changing LastPlayed in profile.xml");
        fs::remove_file(&file1).ok();
    }
}

#[cfg(test)]
mod wine_axis_tests {
    use super::*;
    use crate::action_definitions::DeviceMapping;
    use std::collections::HashMap;

    fn device_map(instance: u32, linux: &str, wine: &str) -> Vec<DeviceMapping> {
        let mut axis_wine_map = HashMap::new();
        axis_wine_map.insert(linux.to_string(), wine.to_string());
        vec![DeviceMapping {
            product_name: "Test".to_string(),
            device_type: "joystick".to_string(),
            sc_guid: None,
            sc_instance: instance,
            alias: None,
            axis_wine_map,
        }]
    }

    #[test]
    fn test_translate_basic() {
        let dm = device_map(2, "slider1", "roty");
        assert_eq!(translate_wine_axis("js2_slider1", &dm), "js2_roty");
    }

    #[test]
    fn test_translate_with_neg_suffix() {
        let dm = device_map(2, "slider1", "roty");
        assert_eq!(translate_wine_axis("js2_slider1neg", &dm), "js2_rotyneg");
    }

    #[test]
    fn test_translate_with_pos_suffix() {
        let dm = device_map(2, "slider1", "roty");
        assert_eq!(translate_wine_axis("js2_slider1pos", &dm), "js2_rotypos");
    }

    #[test]
    fn test_no_mapping_returns_unchanged() {
        let dm = device_map(2, "slider1", "roty");
        assert_eq!(translate_wine_axis("js2_x", &dm), "js2_x");
    }

    #[test]
    fn test_button_unchanged() {
        let dm = device_map(2, "slider1", "roty");
        assert_eq!(translate_wine_axis("js2_button5", &dm), "js2_button5");
    }

    #[test]
    fn test_hat_unchanged() {
        let dm = device_map(2, "slider1", "roty");
        assert_eq!(translate_wine_axis("js2_hat1_up", &dm), "js2_hat1_up");
    }

    #[test]
    fn test_wrong_instance_unchanged() {
        let dm = device_map(2, "slider1", "roty");
        assert_eq!(translate_wine_axis("js3_slider1", &dm), "js3_slider1");
    }

    #[test]
    fn test_keyboard_unchanged() {
        let dm = device_map(2, "slider1", "roty");
        assert_eq!(translate_wine_axis("kb1_w", &dm), "kb1_w");
    }

    #[test]
    fn test_empty_device_map_unchanged() {
        assert_eq!(translate_wine_axis("js2_slider1", &[]), "js2_slider1");
    }

    #[test]
    fn test_non_joystick_same_instance_not_matched() {
        // keyboard and gamepad with same instance must not block joystick mapping
        let mut axis_wine_map = HashMap::new();
        axis_wine_map.insert("slider1".to_string(), "roty".to_string());
        let dm = vec![
            DeviceMapping {
                product_name: "Wine Keyboard".to_string(),
                device_type: "keyboard".to_string(),
                sc_guid: None,
                sc_instance: 1,
                alias: None,
                axis_wine_map: HashMap::new(),
            },
            DeviceMapping {
                product_name: "Controller".to_string(),
                device_type: "gamepad".to_string(),
                sc_guid: None,
                sc_instance: 1,
                alias: None,
                axis_wine_map: HashMap::new(),
            },
            DeviceMapping {
                product_name: "Warthog Throttle".to_string(),
                device_type: "joystick".to_string(),
                sc_guid: None,
                sc_instance: 1,
                alias: None,
                axis_wine_map,
            },
        ];
        assert_eq!(translate_wine_axis("js1_slider1", &dm), "js1_roty");
    }
}

#[cfg(test)]
mod sanitize_tests {
    use super::*;

    fn xml_with_bindings(entries: &[(&str, &str)]) -> String {
        let rebinds: String = entries.iter().map(|(action, input)| {
            format!(
                r#"<action name="{}"><rebind input="{}"/></action>"#,
                action, input
            )
        }).collect::<Vec<_>>().join("\n      ");
        format!(r#"<?xml version="1.0" encoding="utf-8"?>
<ActionMaps version="1">
  <ActionProfiles profileName="default" version="1" optionsVersion="2" rebindVersion="2">
    <actionmap name="spaceship_movement">
      {}
    </actionmap>
  </ActionProfiles>
</ActionMaps>"#, rebinds)
    }

    fn bindings_for(parsed: &ParsedActionMaps, action: &str) -> Vec<String> {
        parsed.profiles[0].action_maps[0].bindings.iter()
            .filter(|b| b.action_name == action)
            .flat_map(|b| b.inputs.iter().cloned())
            .collect()
    }

    #[test]
    fn merges_duplicate_action_entries_and_removes_prefix() {
        let xml = xml_with_bindings(&[
            ("v_abc", "js1_"),
            ("v_abc", "js1_slider1"),
        ]);
        let mut parsed = parse_actionmaps_xml(&xml).unwrap();
        let n = sanitize_actionmaps(&mut parsed);

        assert!(n > 0, "Expected corrections");
        let count = parsed.profiles[0].action_maps[0].bindings.iter()
            .filter(|b| b.action_name == "v_abc").count();
        assert_eq!(count, 1, "Should collapse to one ScBinding");
        let inputs = bindings_for(&parsed, "v_abc");
        assert_eq!(inputs, vec!["js1_slider1"]);
    }

    #[test]
    fn merges_duplicate_entries_reversed_order() {
        // Real input comes first, cleared-prefix second — same result must hold
        let xml = xml_with_bindings(&[
            ("v_abc", "js1_slider1"),
            ("v_abc", "js1_"),
        ]);
        let mut parsed = parse_actionmaps_xml(&xml).unwrap();
        let n = sanitize_actionmaps(&mut parsed);

        assert!(n > 0, "Expected corrections");
        let count = parsed.profiles[0].action_maps[0].bindings.iter()
            .filter(|b| b.action_name == "v_abc").count();
        assert_eq!(count, 1, "Should collapse to one ScBinding");
        let inputs = bindings_for(&parsed, "v_abc");
        assert_eq!(inputs, vec!["js1_slider1"]);
    }

    #[test]
    fn removes_orphaned_cleared_prefix_in_single_entry() {
        let xml = r#"<?xml version="1.0" encoding="utf-8"?>
<ActionMaps version="1">
  <ActionProfiles profileName="default" version="1" optionsVersion="2" rebindVersion="2">
    <actionmap name="spaceship_movement">
      <action name="v_abc">
        <rebind input="js1_"/>
        <rebind input="js1_roty"/>
      </action>
    </actionmap>
  </ActionProfiles>
</ActionMaps>"#;
        let mut parsed = parse_actionmaps_xml(xml).unwrap();
        let n = sanitize_actionmaps(&mut parsed);
        assert_eq!(n, 1);
        let inputs = bindings_for(&parsed, "v_abc");
        assert_eq!(inputs, vec!["js1_roty"]);
    }

    #[test]
    fn keeps_lone_cleared_prefix() {
        let xml = xml_with_bindings(&[("v_abc", "js1_")]);
        let mut parsed = parse_actionmaps_xml(xml.as_str()).unwrap();
        let n = sanitize_actionmaps(&mut parsed);
        assert_eq!(n, 0, "Lone cleared prefix must be kept");
        let inputs = bindings_for(&parsed, "v_abc");
        assert_eq!(inputs, vec!["js1_"]);
    }

    #[test]
    fn no_changes_on_clean_input() {
        let xml = xml_with_bindings(&[
            ("v_abc", "js1_roty"),
            ("v_xyz", "kb1_w"),
        ]);
        let mut parsed = parse_actionmaps_xml(xml.as_str()).unwrap();
        let n = sanitize_actionmaps(&mut parsed);
        assert_eq!(n, 0);
    }
}
