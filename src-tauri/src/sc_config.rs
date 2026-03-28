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
    /// Whether the Data.p4k archive file exists
    pub has_data_p4k: bool,
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
struct CachedLocalization {
    p4k_size: u64,
    p4k_modified: u64,
    labels: HashMap<String, String>,
}

/// Cached master bindings (default key bindings) from the P4K archive.
/// Same cache invalidation strategy as CachedLocalization.
#[derive(Serialize, Deserialize)]
struct CachedMasterBindings {
    p4k_size: u64,
    p4k_modified: u64,
    data: ParsedActionMaps,
}

// Async mutexes prevent concurrent requests from overwriting the same cache file
// or reading the P4K archive twice.
static LOCALIZATION_LOCK: Lazy<Mutex<()>> = Lazy::new(|| Mutex::new(()));
static MASTER_BINDINGS_LOCK: Lazy<Mutex<()>> = Lazy::new(|| Mutex::new(()));

pub(crate) use crate::util::expand_tilde;

/// Constructs the base path to an SC version folder within the Wine prefix.
/// Example: /path/to/prefix/drive_c/Program Files/Roberts Space Industries/StarCitizen/LIVE
pub fn sc_base_dir(gp: &str, v: &str) -> PathBuf {
    Path::new(gp).join("drive_c/Program Files/Roberts Space Industries/StarCitizen").join(v)
}

/// Returns the path to the Data.p4k archive file, if it exists.
fn sc_p4k_path(gp: &str, v: &str) -> Result<PathBuf, String> {
    let p = sc_base_dir(gp, v).join("Data.p4k");
    if p.exists() {
        Ok(p)
    } else {
        Err("No P4K".into())
    }
}
/// Path to the cache file for master bindings of an SC version.
/// Located at ~/.config/penguin-citizen/cache/master_bindings_{version}.json
fn master_bindings_cache_path(v: &str) -> Result<PathBuf, String> {
    Ok(
        dirs
            ::config_dir()
            .ok_or("No config dir")?
            .join("penguin-citizen/cache")
            .join(format!("master_bindings_{}.json", v))
    )
}

/// Path to the cache file for localization data of an SC version.
fn localization_cache_path(v: &str) -> Result<PathBuf, String> {
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
fn backup_version_dir(v: &str) -> Result<PathBuf, String> {
    Ok(dirs::config_dir().ok_or("No config dir")?.join("penguin-citizen/backups").join(v))
}
/// Validates a backup ID to prevent path traversal attacks.
/// Blocks empty IDs as well as characters like `/`, `\` and `..`.
fn validate_backup_id(bid: &str) -> Result<(), String> {
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
fn find_dir_case_insensitive(base: &Path, variants: &[&str]) -> Option<PathBuf> {
    for v in variants {
        let p = base.join(v);
        if p.is_dir() {
            return Some(p);
        }
    }
    None
}

/// Reads the value of an XML attribute by its name from an XML start tag.
fn get_attr(e: &BytesStart, n: &[u8]) -> Option<String> {
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
fn parse_global_ini(c: &str) -> HashMap<String, String> {
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
fn parse_actionmaps_xml(c: &str) -> Result<ParsedActionMaps, String> {
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
fn format_sc_device_name(name: &str, guid: Option<&str>) -> String {
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
fn find_central_directory(file: &mut File, file_length: u64) -> Result<(u64, u64), String> {
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
fn device_prefix(input: &str) -> &str {
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

fn read_c_string(string_table: &[u8], offset: usize) -> String {
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
fn traverse_xml_node(
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
fn parse_cryxmlb_full(data: &[u8]) -> Result<ParsedActionMaps, String> {
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

/// Reads the USER.cfg file for the given game path and version.
/// Returns an empty string if the file does not exist.
#[tauri::command]
pub async fn read_user_cfg(gp: String, v: String) -> Result<String, String> {
    let p = sc_base_dir(&expand_tilde(&gp), &v).join("USER.cfg");
    if !p.exists() {
        return Ok("".into());
    }
    fs::read_to_string(p).map_err(|e| e.to_string())
}
/// Writes content to the USER.cfg file.
/// Uses atomic writing (temporary file + rename) to prevent corruption
/// during crashes while writing.
#[tauri::command]
pub async fn write_user_cfg(gp: String, v: String, c: String) -> Result<(), String> {
    let p = sc_base_dir(&expand_tilde(&gp), &v).join("USER.cfg");
    if let Some(parent) = p.parent() {
        fs::create_dir_all(parent).ok();
    }
    let tmp = p.with_extension("cfg.tmp");
    fs::write(&tmp, &c).map_err(|e| format!("Failed to write temp file: {}", e))?;
    fs::rename(&tmp, &p).map_err(|e| {
        // Clean up temp file on rename failure
        let _ = fs::remove_file(&tmp);
        format!("Failed to rename temp file: {}", e)
    })
}
/// Detects installed Star Citizen versions (LIVE, PTU, EPTU, HOTFIX) at the given path.
/// Tries multiple possible paths (Wine prefix, direct installation, direct path),
/// as the folder structure can vary depending on the installation method.
#[tauri::command]
pub async fn detect_sc_versions(gp: String) -> Result<Vec<ScVersionInfo>, String> {
    log::debug!("[detect_sc_versions] ========== START ==========");
    log::debug!("[detect_sc_versions] Input game_path: '{}'", gp);

    let exp = expand_tilde(&gp);
    log::debug!("[detect_sc_versions] Expanded path: '{}'", exp);

    // Try multiple possible paths
    let paths_to_try: Vec<PathBuf> = vec![
        // Wine prefix path (standard)
        Path::new(&exp).join("drive_c/Program Files/Roberts Space Industries/StarCitizen"),
        // Direct Linux installation
        Path::new(&exp).join("StarCitizen"),
        // The game path itself might be the StarCitizen folder
        Path::new(&exp).to_path_buf()
    ];

    for base in paths_to_try.iter() {
        log::debug!("[detect_sc_versions] Checking path: {}", base.display());
        log::debug!("[detect_sc_versions]   Exists: {}, IsDir: {}", base.exists(), base.is_dir());

        if base.exists() && base.is_dir() {
            // List contents of directory for debugging
            if let Ok(entries) = fs::read_dir(base) {
                let entry_names: Vec<String> = entries
                    .flatten()
                    .map(|e| e.file_name().to_string_lossy().to_string())
                    .take(10)
                    .collect();
                log::debug!("[detect_sc_versions]   First 10 entries: {:?}", entry_names);

                let has_version_folders: bool = entry_names.iter().any(|name| {
                    let n = name.to_lowercase();
                    n == "live" || n == "ptu" || n == "eptu" || n == "hotfix"
                });

                if has_version_folders {
                    log::debug!(
                        "[detect_sc_versions] Found valid SC installation at: {}",
                        base.display()
                    );
                    return detect_sc_versions_from_path(base);
                } else {
                    log::debug!(
                        "[detect_sc_versions]   No version folders found in this directory"
                    );
                }
            }
        }
    }

    // Return error with path info for debugging
    log::debug!("[detect_sc_versions] ========== END - NOT FOUND ==========");
    Err(format!("StarCitizen directory not found. Game path: '{}'", gp))
}

/// Reads version folders from a confirmed SC base directory
/// and checks for each one which files (USER.cfg, actionmaps.xml, etc.) are present.
/// Results are sorted by priority: LIVE > PTU > HOTFIX > other.
fn detect_sc_versions_from_path(base: &Path) -> Result<Vec<ScVersionInfo>, String> {
    let mut res = vec![];
    log::debug!("[detect_sc_versions] Reading directory: {}", base.display());

    match fs::read_dir(base) {
        Ok(es) => {
            for e in es.flatten() {
                let path = e.path();
                if !path.is_dir() {
                    continue;
                }
                let n = path.file_name().unwrap_or_default().to_string_lossy().into_owned();
                log::debug!("[detect_sc_versions] Found version folder: {}", n);

                // Check profiles path
                let profiles_path = path.join("user/client/0/Profiles/default");
                let has_usercfg = path.join("USER.cfg").exists();
                let has_attributes = profiles_path.join("attributes.xml").exists();
                let has_actionmaps = profiles_path.join("actionmaps.xml").exists();
                let has_exported_layouts = path.join("user/client/0/controls/mappings").is_dir();
                let user_base = path.join("user/client/0");
                let has_custom_characters = find_dir_case_insensitive(&user_base, &["CustomCharacters", "customcharacters"]).is_some_and(|d| {
                    fs::read_dir(&d).is_ok_and(|mut es| es.any(|e| e.ok().is_some_and(|e| e.path().extension().is_some_and(|ext| ext.eq_ignore_ascii_case("chf")))))
                });
                let has_data_p4k = path.join("Data.p4k").exists();
                log::debug!(
                    "[detect_sc_versions]   has_usercfg: {}, has_attributes: {}, has_actionmaps: {}",
                    has_usercfg,
                    has_attributes,
                    has_actionmaps
                );
                res.push(ScVersionInfo {
                    version: n,
                    path: path.to_string_lossy().into_owned(),
                    has_usercfg,
                    has_attributes,
                    has_actionmaps,
                    has_exported_layouts,
                    has_custom_characters,
                    has_data_p4k,
                });
            }
        }
        Err(e) => {
            log::debug!(
                "[detect_sc_versions] Failed to read directory: {} - Error: {}",
                base.display(),
                e
            );
        }
    }

    res.sort_by_key(|v| {
        match v.version.as_str() {
            "LIVE" => 0,
            "PTU" => 1,
            "HOTFIX" => 2,
            _ => 3,
        }
    });
    log::debug!("[detect_sc_versions] Returning {} versions", res.len());
    Ok(res)
}
/// Lists available user profiles for an SC version.
/// Reads the "lastPlayed" timestamp from the respective attributes.xml.
/// The "frontend" profile is skipped as it is an SC-internal profile.
#[tauri::command]
pub async fn list_profiles(gp: String, v: String) -> Result<Vec<ScProfile>, String> {
    let p = sc_base_dir(&expand_tilde(&gp), &v).join("user/client/0/Profiles");
    if !p.is_dir() {
        return Ok(vec![]);
    }
    let mut res = vec![];
    if let Ok(es) = fs::read_dir(p) {
        for e in es.flatten() {
            let path = e.path();
            if !path.is_dir() || path.file_name().unwrap_or_default() == "frontend" {
                continue;
            }
            let n = path.file_name().unwrap_or_default().to_string_lossy().into_owned();
            let mut last = 0;
            if let Ok(c) = fs::read_to_string(path.join("attributes.xml")) {
                if let Some(s) = c.find("lastPlayed=\"") {
                    if let Some(e) = c[s + 12..].find('"') {
                        last = c[s + 12..s + 12 + e].parse().unwrap_or(0);
                    }
                }
            }
            res.push(ScProfile { name: n, last_played: last });
        }
    }
    res.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(res)
}
/// Exports the default profile (actionmaps, attributes, profile) to a target directory.
#[tauri::command]
pub async fn export_profile(gp: String, v: String, dp: String) -> Result<(), String> {
    let src = sc_base_dir(&expand_tilde(&gp), &v).join("user/client/0/Profiles/default");
    let dest = Path::new(&dp);
    if !dest.is_absolute() {
        return Err("Destination path must be absolute".into());
    }
    fs::create_dir_all(dest).map_err(|e| e.to_string())?;
    for f in &["actionmaps.xml", "attributes.xml", "profile.xml"] {
        if src.join(f).exists() {
            fs::copy(src.join(f), dest.join(f)).ok();
        }
    }
    Ok(())
}
/// Imports profile files from a source directory into the default profile.
#[tauri::command]
pub async fn import_profile(gp: String, v: String, sp: String) -> Result<(), String> {
    let dest = sc_base_dir(&expand_tilde(&gp), &v).join("user/client/0/Profiles/default");
    let src = Path::new(&sp);
    if !src.is_absolute() {
        return Err("Source path must be absolute".into());
    }
    fs::create_dir_all(&dest).map_err(|e| e.to_string())?;
    for f in &["actionmaps.xml", "attributes.xml", "profile.xml"] {
        if src.join(f).exists() {
            fs::copy(src.join(f), dest.join(f)).ok();
        }
    }
    Ok(())
}
/// Reads and parses the attributes.xml from the default profile.
/// Uses simple string parsing instead of an XML parser,
/// since the file structure is very simple and predictable.
#[tauri::command]
pub async fn read_attributes(gp: String, v: String) -> Result<ScAttributes, String> {
    let p = sc_base_dir(&expand_tilde(&gp), &v).join(
        "user/client/0/Profiles/default/attributes.xml"
    );
    if !p.exists() {
        return Ok(ScAttributes::default());
    }
    let c = fs::read_to_string(p).map_err(|e| e.to_string())?;
    Ok(parse_attributes_str(&c))
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
/// Writes attributes back to the attributes.xml of the default profile.
#[tauri::command]
pub async fn write_attributes(gp: String, v: String, attrs: ScAttributes) -> Result<(), String> {
    let p = sc_base_dir(&expand_tilde(&gp), &v).join(
        "user/client/0/Profiles/default/attributes.xml"
    );
    if let Some(parent) = p.parent() {
        fs::create_dir_all(parent).ok();
    }
    let mut xml = format!("<Attributes Version=\"{}\">\n", attrs.version);
    for a in attrs.attrs {
        xml.push_str(&format!(" <Attr name=\"{}\" value=\"{}\"/>\n", a.name, a.value));
    }
    xml.push_str("</Attributes>\n");
    fs::write(p, xml).map_err(|e| e.to_string())
}
/// Parses the actionmaps.xml of the default profile, or an exported layout file
/// if `source` is specified.
#[tauri::command]
pub async fn parse_actionmaps(
    gp: String,
    v: String,
    source: Option<String>
) -> Result<ParsedActionMaps, String> {
    let exp = expand_tilde(&gp);
    let p = match source {
        Some(f) => sc_base_dir(&exp, &v).join("user/client/0/controls/mappings").join(f),
        None => sc_base_dir(&exp, &v).join("user/client/0/Profiles/default/actionmaps.xml"),
    };
    if !p.exists() {
        return Err("Not found".into());
    }
    parse_actionmaps_xml(&fs::read_to_string(p).map_err(|e| e.to_string())?)
}
/// Returns the built-in action definitions (categories and their actions).
#[tauri::command]
pub fn get_action_definitions() -> ActionDefinitions {
    ActionDefinitions::new()
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
            let p4k = sc_base_dir(&gp, &v).join("Data.p4k");
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
/// Extracts localization labels from the P4K archive for UI display.
///
/// Labels are cached to avoid re-reading the P4K on every call.
/// The cache is invalidated when the size or modification time of the P4K changes.
///
/// The global.ini may be UTF-16LE encoded (with BOM 0xFF 0xFE) - in that case
/// it is converted before parsing. Without BOM, UTF-8 is assumed.
///
/// Returns a map of localization keys to translated strings.
#[tauri::command]
pub async fn get_localization_labels(
    game_path: String,
    version: String,
    language: Option<String>
) -> Result<HashMap<String, String>, String> {
    let pp = sc_p4k_path(&game_path, &version)?;
    let cp = localization_cache_path(&version)?;
    let meta = fs::metadata(&pp).map_err(|e| e.to_string())?;
    let sz = meta.len();
    let modif = meta
        .modified()
        .map_err(|e| e.to_string())?
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();

    if cp.exists() {
        if let Ok(s) = fs::read_to_string(&cp) {
            if let Ok(cached) = serde_json::from_str::<CachedLocalization>(&s) {
                if cached.p4k_size == sz && cached.p4k_modified == modif {
                    return Ok(cached.labels);
                }
            }
        }
    }

    let _g = LOCALIZATION_LOCK.lock().await;
    let lang = language.unwrap_or_else(|| "english".into());

    let res: Result<HashMap<String, String>, String> = tokio::task
        ::spawn_blocking(move || {
            let bytes = read_p4k_file(
                &game_path,
                &version,
                &format!("Localization/{}/global.ini", lang)
            ).or_else(|_|
                read_p4k_file(
                    &game_path,
                    &version,
                    &format!("Data/Localization/{}/global.ini", lang)
                )
            )?;

            let content = if bytes.starts_with(&[0xff, 0xfe]) {
                UTF_16LE.decode(&bytes[2..]).0.into_owned()
            } else {
                String::from_utf8_lossy(&bytes).into_owned()
            };

            let labels = parse_global_ini(&content);
            let cached = CachedLocalization {
                p4k_size: sz,
                p4k_modified: modif,
                labels: labels.clone(),
            };
            let cp_path = localization_cache_path(&version)?;
            if let Some(parent) = cp_path.parent() {
                fs::create_dir_all(parent).ok();
            }
            if let Ok(json) = serde_json::to_string(&cached) {
                fs::write(cp_path, json).ok();
            }
            Ok(labels)
        }).await
        .map_err(|e| format!("Task failed: {}", e))?;
    res
}
/// Returns all bindings merged from master defaults and user customizations.
///
/// The merge works as follows:
/// 1. All master bindings (defaults) are loaded as the base
/// 2. User bindings override/supplement the master bindings
/// 3. Localized display names are resolved via the label map
/// 4. Results are sorted alphabetically by category and display name
#[tauri::command]
pub async fn get_complete_binding_list(
    gp: String,
    v: String
) -> Result<BindingListResponse, String> {
    let labels = get_localization_labels(gp.clone(), v.clone(), None).await.unwrap_or_default();
    let master = get_master_bindings(gp.clone(), v.clone()).await?;
    let master_profile = &master.profiles[0];
    let user_p = sc_base_dir(&expand_tilde(&gp), &v).join(
        "user/client/0/Profiles/default/actionmaps.xml"
    );
    let user_parsed = if user_p.exists() {
        parse_actionmaps_xml(&fs::read_to_string(user_p).unwrap_or_default()).ok()
    } else {
        None
    };
    let user_profile = user_parsed
        .as_ref()
        .and_then(|up|
            up.profiles.iter().find(|p| p.profile_name == "default" || p.profile_name.is_empty())
        );
    // MergedActions: action_name -> (input_list with is_custom flag, label)
    type MergedActions = HashMap<String, (Vec<(String, bool)>, Option<String>)>;
    let mut merged: HashMap<String, MergedActions> = HashMap::new();
    // First, insert all master bindings as the base
    for am in &master_profile.action_maps {
        let map = merged.entry(am.name.clone()).or_default();
        for a in &am.actions {
            map.entry(a.name.clone()).or_insert_with(|| (vec![], a.label.clone()));
        }
        for b in &am.bindings {
            let entry = map.entry(b.action_name.clone()).or_insert_with(|| (vec![], None));
            for input in &b.inputs {
                if !entry.0.iter().any(|(i, _)| i == input) {
                    entry.0.push((input.clone(), false));
                }
            }
        }
    }
    // Then overlay user bindings — replace defaults for the same device type
    if let Some(up) = user_profile {
        for am in &up.action_maps {
            let map = merged.entry(am.name.clone()).or_default();
            for b in &am.bindings {
                let entry = map
                    .entry(b.action_name.clone())
                    .or_insert_with(|| (vec![], None));
                let user_prefixes: Vec<&str> = b.inputs.iter()
                    .map(|i| device_prefix(i))
                    .filter(|p| !p.is_empty())
                    .collect();
                entry.0.retain(|(existing_input, is_custom)| {
                    if *is_custom { return true; }
                    let ep = device_prefix(existing_input);
                    !user_prefixes.contains(&ep)
                });
                for input in &b.inputs {
                    let trimmed = input.trim();
                    if trimmed.is_empty() || trimmed.ends_with('_') { continue; }
                    if !entry.0.iter().any(|(i, _)| i == input) {
                        entry.0.push((input.clone(), true));
                    }
                }
            }
        }
    }

    // Convert merged data into the final list with localized names
    let mut results = vec![];
    let mut stats = BindingStats { total: 0, custom: 0 };
    for (cat_name, actions) in merged {
        let cat_label = labels
            .get(&format!("ui_Control{}", cat_name))
            .or(labels.get(&cat_name))
            .cloned()
            .unwrap_or_else(|| cat_name.replace('_', " "));
        for (an, (inputs, alabel)) in actions {
            let has_custom = inputs.iter().any(|(_, c)| *c);
            stats.total += 1;
            if has_custom {
                stats.custom += 1;
            }
            let dn = alabel
                .as_ref()
                .and_then(|l| labels.get(l.strip_prefix('@').unwrap_or(l)))
                .or(labels.get(&format!("ui_Control{}", an)))
                .or(labels.get(&an))
                .cloned()
                .unwrap_or_else(|| an.replace('_', " "));
            if inputs.is_empty() {
                results.push(CompleteBinding {
                    category: cat_name.clone(),
                    category_label: cat_label.clone(),
                    action_name: an.clone(),
                    display_name: dn.clone(),
                    current_input: "".into(),
                    device_type: "none".into(),
                    description: None,
                    is_custom: false,
                });
            } else {
                for (input, is_custom) in inputs {
                    results.push(CompleteBinding {
                        category: cat_name.clone(),
                        category_label: cat_label.clone(),
                        action_name: an.clone(),
                        display_name: dn.clone(),
                        current_input: input,
                        device_type: "none".into(),
                        description: None,
                        is_custom,
                    });
                }
            }
        }
    }
    results.sort_by(|a, b|
        a.category_label
            .to_lowercase()
            .cmp(&b.category_label.to_lowercase())
            .then(a.display_name.to_lowercase().cmp(&b.display_name.to_lowercase()))
    );
    Ok(BindingListResponse { bindings: results, stats })
}

/// Derives a device mapping from the `<options>` tags of a parsed actionmaps.xml.
/// Used to populate the device_map in backup_meta.json.
fn derive_device_map(parsed: &ParsedActionMaps) -> Vec<DeviceMapping> {
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
            });
        }
    }
    map
}

/// Saves the backup metadata as JSON to the backup folder.
fn save_backup_meta(bdir: &Path, info: &BackupInfo) -> Result<(), String> {
    let json = serde_json::to_string_pretty(info).map_err(|e| e.to_string())?;
    fs::write(bdir.join("backup_meta.json"), json).map_err(|e| e.to_string())
}

/// Returns all bindings of a saved profile, merged with master defaults.
/// Similar to get_complete_binding_list, but operates on a backup instead of live SC files.
/// If the device_map is missing from the backup metadata, it is automatically derived and saved.
#[tauri::command]
pub async fn get_profile_bindings(
    gp: String,
    v: String,
    profile_id: String
) -> Result<BindingListResponse, String> {
    let bdir = backup_version_dir(&v)?.join(&profile_id);
    let actionmaps_path = bdir.join("actionmaps.xml");

    if !actionmaps_path.exists() {
        return Ok(BindingListResponse {
            bindings: vec![],
            stats: BindingStats { total: 0, custom: 0 },
        });
    }

    // Parse profile's actionmaps.xml
    let user_xml = fs::read_to_string(&actionmaps_path).map_err(|e| e.to_string())?;
    let user_parsed = parse_actionmaps_xml(&user_xml)?;

    // Derive and persist device_map if missing from backup_meta
    let meta_path = bdir.join("backup_meta.json");
    if meta_path.exists() {
        let meta_json = fs::read_to_string(&meta_path).map_err(|e| e.to_string())?;
        let mut meta: BackupInfo = serde_json::from_str(&meta_json).map_err(|e| e.to_string())?;
        if meta.device_map.is_empty() {
            meta.device_map = derive_device_map(&user_parsed);
            save_backup_meta(&bdir, &meta)?;
        }
    }

    // Get master bindings and localization labels
    let labels = get_localization_labels(gp.clone(), v.clone(), None).await.unwrap_or_default();
    let master = get_master_bindings(gp, v).await?;
    let master_profile = &master.profiles[0];

    let user_profile = user_parsed.profiles.iter()
        .find(|p| p.profile_name == "default" || p.profile_name.is_empty());

    // Build merged binding list
    // Each input is tagged: (input_string, is_custom)
    type MergedActions = HashMap<String, (Vec<(String, bool)>, Option<String>)>;
    let mut merged: HashMap<String, MergedActions> = HashMap::new();

    // Step 1: Load master (default) bindings
    for am in &master_profile.action_maps {
        let map = merged.entry(am.name.clone()).or_default();
        for a in &am.actions {
            map.entry(a.name.clone()).or_insert_with(|| (vec![], a.label.clone()));
        }
        for b in &am.bindings {
            let entry = map.entry(b.action_name.clone()).or_insert_with(|| (vec![], None));
            for input in &b.inputs {
                if !entry.0.iter().any(|(i, _)| i == input) {
                    entry.0.push((input.clone(), false)); // false = default
                }
            }
        }
    }

    // Step 2: Overlay user bindings — replace defaults for the same device type
    if let Some(up) = user_profile {
        for am in &up.action_maps {
            let map = merged.entry(am.name.clone()).or_default();
            for b in &am.bindings {
                let entry = map.entry(b.action_name.clone()).or_insert_with(|| (vec![], None));

                // Collect device prefixes the user has overridden
                let user_prefixes: Vec<&str> = b.inputs.iter()
                    .map(|i| device_prefix(i))
                    .filter(|p| !p.is_empty())
                    .collect();

                // Remove default inputs for device types that the user has overridden
                entry.0.retain(|(existing_input, is_custom)| {
                    if *is_custom { return true; } // keep previous user inputs
                    let ep = device_prefix(existing_input);
                    !user_prefixes.contains(&ep)
                });

                // Add user inputs
                // Skip empty strings and prefix-only markers (e.g. "kb1_") —
                // they signal "default removed" and aren't real bindings
                for input in &b.inputs {
                    let trimmed = input.trim();
                    if trimmed.is_empty() || trimmed.ends_with('_') { continue; }
                    if !entry.0.iter().any(|(i, _)| i == input) {
                        entry.0.push((input.clone(), true)); // true = custom
                    }
                }
            }
        }
    }

    let mut results = vec![];
    let mut stats = BindingStats { total: 0, custom: 0 };
    for (cat_name, actions) in merged {
        let cat_label = labels
            .get(&format!("ui_Control{}", cat_name))
            .or(labels.get(&cat_name))
            .cloned()
            .unwrap_or_else(|| cat_name.replace('_', " "));
        for (an, (inputs, alabel)) in actions {
            let has_custom = inputs.iter().any(|(_, c)| *c);
            stats.total += 1;
            if has_custom { stats.custom += 1; }
            let dn = alabel.as_ref()
                .and_then(|l| labels.get(l.strip_prefix('@').unwrap_or(l)))
                .or(labels.get(&format!("ui_Control{}", an)))
                .or(labels.get(&an))
                .cloned()
                .unwrap_or_else(|| an.replace('_', " "));
            if inputs.is_empty() {
                results.push(CompleteBinding {
                    category: cat_name.clone(),
                    category_label: cat_label.clone(),
                    action_name: an.clone(),
                    display_name: dn.clone(),
                    current_input: "".into(),
                    device_type: "none".into(),
                    description: None,
                    is_custom: false,
                });
            } else {
                for (input, is_custom) in inputs {
                    results.push(CompleteBinding {
                        category: cat_name.clone(),
                        category_label: cat_label.clone(),
                        action_name: an.clone(),
                        display_name: dn.clone(),
                        current_input: input,
                        device_type: "none".into(),
                        description: None,
                        is_custom,
                    });
                }
            }
        }
    }
    results.sort_by(|a, b|
        a.category_label.to_lowercase().cmp(&b.category_label.to_lowercase())
            .then(a.display_name.to_lowercase().cmp(&b.display_name.to_lowercase()))
    );
    Ok(BindingListResponse { bindings: results, stats })
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
/// Assigns a new input binding to an action in the user's actionmaps.xml.
/// If the file does not exist, a new one with default values is created.
/// If old_input is specified, the existing binding is replaced; otherwise a new one is added.
#[tauri::command]
pub async fn assign_binding(args: AssignBindingArgs) -> Result<(), String> {
    let p = sc_base_dir(&expand_tilde(&args.game_path), &args.version).join(
        "user/client/0/Profiles/default/actionmaps.xml"
    );
    let mut parsed = if p.exists() {
        parse_actionmaps_xml(&fs::read_to_string(&p).map_err(|e| e.to_string())?)?
    } else {
        ParsedActionMaps {
            version: "1".into(),
            profiles: vec![ScActionProfile {
                profile_name: "default".into(),
                version: "1".into(),
                options_version: "2".into(),
                rebind_version: "2".into(),
                devices: vec![],
                device_options: vec![],
                modifiers: None,
                action_maps: vec![],
            }],
        }
    };

    let profile = parsed.profiles
        .iter_mut()
        .find(|pr| pr.profile_name == "default" || pr.profile_name.is_empty())
        .ok_or("No profile")?;
    let mut found = false;
    for am in &mut profile.action_maps {
        if am.name == args.category {
            if let Some(ref old) = args.old_input {
                if let Some(b) = am.bindings.iter_mut()
                    .find(|b| b.action_name == args.action_name && b.inputs.contains(old))
                {
                    if let Some(pos) = b.inputs.iter().position(|x| x == old) {
                        b.inputs[pos] = args.input.clone();
                    }
                    found = true;
                    break;
                }
            } else if let Some(b) = am.bindings.iter_mut()
                .find(|b| b.action_name == args.action_name)
            {
                // If no specific old_input, we replace ALL existing inputs for this action
                b.inputs = vec![args.input.clone()];
                found = true;
                break;
            }
        }
    }

    if !found {
        if let Some(am) = profile.action_maps.iter_mut().find(|am| am.name == args.category) {
            am.bindings.push(ScBinding {
                action_name: args.action_name.clone(),
                inputs: vec![args.input],
            });
        } else {
            profile.action_maps.push(ScActionMap {
                name: args.category.clone(),
                bindings: vec![ScBinding {
                    action_name: args.action_name.clone(),
                    inputs: vec![args.input],
                }],
                actions: vec![ScAction { name: args.action_name, label: None }],
            });
        }
    }

    write_actionmaps_xml(&p, &parsed)
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
/// Removes a specific input binding of an action from the user's actionmaps.xml.
#[tauri::command]
pub async fn remove_binding(args: RemoveBindingArgs) -> Result<(), String> {
    let p = sc_base_dir(&expand_tilde(&args.game_path), &args.version).join(
        "user/client/0/Profiles/default/actionmaps.xml"
    );
    if !p.exists() {
        return Err("Not found".into());
    }
    let mut parsed = parse_actionmaps_xml(&fs::read_to_string(&p).map_err(|e| e.to_string())?)?;
    let profile = parsed.profiles
        .iter_mut()
        .find(|pr| pr.profile_name == "default" || pr.profile_name.is_empty())
        .ok_or("No profile")?;
    for am in &mut profile.action_maps {
        for b in &mut am.bindings {
            if b.action_name == args.action_name {
                b.inputs.retain(|x| x != &args.input);
            }
        }
        am.bindings.retain(|b| !b.inputs.is_empty());
    }
    write_actionmaps_xml(&p, &parsed)

}

/// Helper function: sets the dirty flag and recalculates the hash of actionmaps.xml.
/// Called after every change to a profile backup so the frontend can detect
/// that the profile has not yet been applied to SC.
fn mark_backup_dirty(bdir: &Path) -> Result<(), String> {
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

/// Assigns a binding to an action in the actionmaps.xml of a saved profile.
/// Operates on the backup folder, not on live SC files.
/// Marks the profile as "dirty" afterwards.
#[tauri::command]
pub async fn assign_profile_binding(
    v: String,
    profile_id: String,
    action_map: String,
    action_name: String,
    new_input: String,
    old_input: Option<String>,
) -> Result<(), String> {
    let bdir = backup_version_dir(&v)?.join(&profile_id);
    let actionmaps_path = bdir.join("actionmaps.xml");
    if !actionmaps_path.exists() {
        return Err("Profile has no actionmaps.xml".into());
    }

    let mut parsed = parse_actionmaps_xml(
        &fs::read_to_string(&actionmaps_path).map_err(|e| e.to_string())?
    )?;

    let profile = parsed.profiles.iter_mut()
        .find(|pr| pr.profile_name == "default" || pr.profile_name.is_empty())
        .ok_or("No profile")?;

    let mut found = false;
    if let Some(ref old) = old_input {
        for am in &mut profile.action_maps {
            if am.name == action_map {
                if let Some(b) = am.bindings.iter_mut()
                    .find(|b| b.action_name == action_name && b.inputs.contains(old))
                {
                    if let Some(pos) = b.inputs.iter().position(|x| x == old) {
                        b.inputs[pos] = new_input.clone();
                    }
                    found = true;
                    break;
                }
            }
        }
    }


    if !found {
        if let Some(am) = profile.action_maps.iter_mut().find(|am| am.name == action_map) {
            am.bindings.push(ScBinding {
                action_name: action_name.clone(),
                inputs: vec![new_input],
            });
        } else {
            profile.action_maps.push(ScActionMap {
                name: action_map,
                bindings: vec![ScBinding {
                    action_name: action_name.clone(),
                    inputs: vec![new_input],
                }],
                actions: vec![ScAction { name: action_name, label: None }],
            });
        }
    }


    write_actionmaps_xml(&actionmaps_path, &parsed)?;
    mark_backup_dirty(&bdir)
}

/// Removes a binding from the actionmaps.xml of a saved profile.
/// If `input` is specified, only the specific binding is removed;
/// otherwise all bindings of the action in the action map are removed.
#[tauri::command]
pub async fn remove_profile_binding(
    v: String,
    profile_id: String,
    action_map: String,
    action_name: String,
    input: Option<String>,
) -> Result<(), String> {
    validate_backup_id(&profile_id)?;
    let bdir = backup_version_dir(&v)?.join(&profile_id);
    let actionmaps_path = bdir.join("actionmaps.xml");
    if !actionmaps_path.exists() {
        return Err("Profile has no actionmaps.xml".into());
    }

    let mut parsed = parse_actionmaps_xml(
        &fs::read_to_string(&actionmaps_path).map_err(|e| e.to_string())?
    )?;

    let profile = parsed.profiles.iter_mut()
        .find(|pr| pr.profile_name == "default" || pr.profile_name.is_empty())
        .ok_or("No profile")?;

    // Helper: compute a "cleared" prefix marker from an input string
    // e.g. "kb1_w" -> "kb1_", "mo1_maxis_x" -> "mo1_"
    let cleared_prefix = |inp: &str| -> String {
        inp.find('_')
            .map(|i| inp[..=i].to_string())
            .unwrap_or_default()
    };

    let mut found_action_map = false;
    for am in &mut profile.action_maps {
        if am.name == action_map {
            found_action_map = true;
            if let Some(ref inp) = input {
                // Check if this action already exists in the user's bindings
                let existing = am.bindings.iter_mut().find(|b| b.action_name == action_name);

                if let Some(b) = existing {
                    // Action exists in user XML — replace or add the prefix marker
                    if let Some(pos) = b.inputs.iter().position(|x| x == inp) {
                        let prefix = cleared_prefix(inp);
                        if prefix.is_empty() {
                            b.inputs.remove(pos);
                        } else {
                            b.inputs[pos] = prefix;
                        }
                    } else {
                        // Input not in user bindings (it's a default) — add prefix marker
                        let prefix = cleared_prefix(inp);
                        if !prefix.is_empty() && !b.inputs.contains(&prefix) {
                            b.inputs.push(prefix);
                        }
                    }
                    // Clean up duplicate prefixes
                    let mut seen_prefixes: Vec<String> = vec![];
                    b.inputs.retain(|x| {
                        if x.ends_with('_') {
                            if seen_prefixes.contains(x) { return false; }
                            seen_prefixes.push(x.clone());
                        }
                        true
                    });
                } else {
                    // Action doesn't exist in user XML at all (pure default).
                    // Create a new binding entry with just the prefix marker.
                    let prefix = cleared_prefix(inp);
                    if !prefix.is_empty() {
                        am.bindings.push(ScBinding {
                            action_name: action_name.clone(),
                            inputs: vec![prefix],
                        });
                    }
                }
            } else {
                // Fallback: remove all bindings for the action
                am.bindings.retain(|b| b.action_name != action_name);
            }
        }
    }

    // If the action map doesn't exist in the user XML yet, create it
    if !found_action_map {
        if let Some(ref inp) = input {
            let prefix = cleared_prefix(inp);
            if !prefix.is_empty() {
                profile.action_maps.push(ScActionMap {
                    name: action_map.clone(),
                    bindings: vec![ScBinding {
                        action_name: action_name.clone(),
                        inputs: vec![prefix],
                    }],
                    actions: vec![],
                });
            }
        }
    }


    write_actionmaps_xml(&actionmaps_path, &parsed)?;
    mark_backup_dirty(&bdir)
}

/// Resets a binding to its default by removing all user overrides for the action.
/// After reset, the merge logic will show the master (default) bindings again.
#[tauri::command]
pub async fn reset_profile_binding(
    v: String,
    profile_id: String,
    action_map: String,
    action_name: String,
) -> Result<(), String> {
    validate_backup_id(&profile_id)?;
    let bdir = backup_version_dir(&v)?.join(&profile_id);
    let actionmaps_path = bdir.join("actionmaps.xml");
    if !actionmaps_path.exists() {
        return Err("Profile has no actionmaps.xml".into());
    }

    let mut parsed = parse_actionmaps_xml(
        &fs::read_to_string(&actionmaps_path).map_err(|e| e.to_string())?
    )?;

    let profile = parsed.profiles.iter_mut()
        .find(|pr| pr.profile_name == "default" || pr.profile_name.is_empty())
        .ok_or("No profile")?;

    for am in &mut profile.action_maps {
        if am.name == action_map {
            am.bindings.retain(|b| b.action_name != action_name);
        }
    }

    write_actionmaps_xml(&actionmaps_path, &parsed)?;
    mark_backup_dirty(&bdir)
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

/// Returns tuning data (deadzones, curves, inversion, sensitivity) for all joystick devices
/// in a saved profile. Correlates `<deviceoptions>` (axis settings) with `<options>` (tuning).
#[tauri::command]
pub async fn get_device_tuning(
    v: String,
    profile_id: String,
) -> Result<Vec<DeviceTuningResponse>, String> {
    validate_backup_id(&profile_id)?;
    let bdir = backup_version_dir(&v)?.join(&profile_id);
    let actionmaps_path = bdir.join("actionmaps.xml");
    if !actionmaps_path.exists() {
        return Ok(vec![]);
    }

    let parsed = parse_actionmaps_xml(
        &fs::read_to_string(&actionmaps_path).map_err(|e| e.to_string())?
    )?;

    let profile = parsed.profiles.first().ok_or("No profile")?;
    let mut results = Vec::new();

    for d in &profile.devices {
        if d.device_type != "joystick" {
            continue;
        }
        // Skip empty joystick slots (SC reserves 8 slots, most are unused)
        if d.product.is_empty() && d.tuning.is_empty() {
            continue;
        }
        // Correlate deviceoptions by matching "ProductName {GUID}" format
        let full_product = if let Some(ref guid) = d.guid {
            format!("{} {{{}}}", d.product.trim(), guid)
        } else {
            d.product.clone()
        };
        let axis_options = profile.device_options.iter()
            .find(|do_opts| do_opts.name == full_product)
            .map(|do_opts| do_opts.options.clone())
            .unwrap_or_default();

        results.push(DeviceTuningResponse {
            product: d.product.clone(),
            device_type: d.device_type.clone(),
            instance: d.instance,
            axis_options,
            tuning: d.tuning.clone(),
        });
    }

    Ok(results)
}

/// Updates tuning data for a specific joystick device in a saved profile.
/// Modifies both `<deviceoptions>` (axis settings) and `<options>` children (tuning).
#[tauri::command]
pub async fn update_device_tuning(
    v: String,
    profile_id: String,
    instance: u32,
    device_type: String,
    axis_options: Vec<ScDeviceOption>,
    tuning: Vec<ScOptionsTuning>,
) -> Result<(), String> {
    validate_backup_id(&profile_id)?;
    let bdir = backup_version_dir(&v)?.join(&profile_id);
    let actionmaps_path = bdir.join("actionmaps.xml");
    if !actionmaps_path.exists() {
        return Err("Profile has no actionmaps.xml".into());
    }

    let mut parsed = parse_actionmaps_xml(
        &fs::read_to_string(&actionmaps_path).map_err(|e| e.to_string())?
    )?;

    let profile = parsed.profiles.iter_mut()
        .find(|pr| pr.profile_name == "default" || pr.profile_name.is_empty())
        .ok_or("No profile")?;

    // Find the device by instance + type and update tuning
    let dev = profile.devices.iter_mut()
        .find(|d| d.instance == instance && d.device_type == device_type)
        .ok_or("Device not found")?;
    dev.tuning = tuning;

    // Update deviceoptions (axis deadzones/saturations)
    let full_product = if let Some(ref guid) = dev.guid {
        format!("{} {{{}}}", dev.product.trim(), guid)
    } else {
        dev.product.clone()
    };

    if !axis_options.is_empty() {
        if let Some(do_opts) = profile.device_options.iter_mut()
            .find(|do_opts| do_opts.name == full_product)
        {
            do_opts.options = axis_options;
        } else {
            // Create new deviceoptions entry if none existed
            profile.device_options.push(ScDeviceOptions {
                name: full_product,
                options: axis_options,
            });
        }
    }

    write_actionmaps_xml(&actionmaps_path, &parsed)?;
    mark_backup_dirty(&bdir)
}

/// Applies the files of a saved profile to the live SC directory.
/// Copies profile files via restore_profile and then resets the dirty flag.
/// Also saves the active profile assignment in active_profiles.json.
#[tauri::command]
pub async fn apply_profile_to_sc(
    gp: String,
    v: String,
    profile_id: String,
) -> Result<(), String> {
    // Reuse existing restore_profile logic
    restore_profile(gp, v.clone(), profile_id.clone()).await?;

    // Clear dirty flag
    let bdir = backup_version_dir(&v)?.join(&profile_id);
    let meta_path = bdir.join("backup_meta.json");
    if meta_path.exists() {
        let meta_json = fs::read_to_string(&meta_path).map_err(|e| e.to_string())?;
        let mut meta: BackupInfo = serde_json::from_str(&meta_json).map_err(|e| e.to_string())?;
        meta.dirty = false;
        save_backup_meta(&bdir, &meta)?;
    }

    // Update active_profiles.json
    save_active_profile(v, profile_id).await
}

/// Sets a custom alias for a device in the device_map of a profile.
/// Allows the user to give devices descriptive names (e.g. "Left Stick").
#[tauri::command]
pub async fn set_profile_device_alias(
    v: String,
    profile_id: String,
    product_name: String,
    alias: String,
) -> Result<(), String> {
    let bdir = backup_version_dir(&v)?.join(&profile_id);
    let meta_path = bdir.join("backup_meta.json");
    if !meta_path.exists() {
        return Err("Profile metadata not found".into());
    }

    let meta_json = fs::read_to_string(&meta_path).map_err(|e| e.to_string())?;
    let mut meta: BackupInfo = serde_json::from_str(&meta_json).map_err(|e| e.to_string())?;

    let alias_val = if alias.trim().is_empty() { None } else { Some(alias) };
    if let Some(dm) = meta.device_map.iter_mut().find(|dm| dm.product_name == product_name) {
        dm.alias = alias_val;
    } else {
        return Err(format!("Device '{}' not found in profile device map", product_name));
    }

    save_backup_meta(&bdir, &meta)
}

/// Migrates the old binding_database.json by renaming it to .bak.
/// Called at app startup since the old format is no longer used.
/// Returns true if a migration was performed.
#[tauri::command]
pub async fn migrate_binding_database() -> Result<bool, String> {
    let config_dir = dirs::config_dir().ok_or("No config dir")?;
    let db_path = config_dir.join("penguin-citizen/bindings/binding_database.json");
    if db_path.exists() {
        let bak_path = config_dir.join("penguin-citizen/bindings/binding_database.json.bak");
        fs::rename(&db_path, &bak_path).map_err(|e| e.to_string())?;
        log::info!("Migrated binding_database.json → .bak");
        Ok(true)
    } else {
        Ok(false)
    }
}

/// Reads a text file from the Data.p4k archive and returns the content as a string.
#[tauri::command]
pub async fn read_p4k(
    game_path: String,
    version: String,
    file_path: String
) -> Result<String, String> {
    Ok(String::from_utf8_lossy(&read_p4k_file(&game_path, &version, &file_path)?).into_owned())
}
/// Lists files in the P4K archive, optionally filtered by a pattern.
/// Searches the Central Directory and returns all filenames
/// that contain the filter pattern (case-insensitive).
#[tauri::command]
pub async fn list_p4k(
    game_path: String,
    version: String,
    pattern: Option<String>
) -> Result<Vec<String>, String> {
    let p = sc_base_dir(&game_path, &version).join("Data.p4k");
    if !p.exists() {
        return Err("No P4K".into());
    }

    let mut file = File::open(&p).map_err(|e| e.to_string())?;
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

    let filter = pattern.unwrap_or_default().to_lowercase();
    let mut results = vec![];
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
        if name.to_lowercase().contains(&filter) {
            results.push(name.to_string());
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

    Ok(results)
}
/// Reads the global.ini localization file for the specified language from the P4K archive.
#[tauri::command]
pub async fn get_localization_ini(
    gp: String,
    v: String,
    lang: Option<String>
) -> Result<String, String> {
    let b = read_p4k_file(
        &gp,
        &v,
        &format!("Data/Localization/{}/global.ini", lang.unwrap_or("english".into()))
    )?;
    Ok(String::from_utf8_lossy(&b).into_owned())
}
/// Lists available localization languages by searching the P4K archive.
/// Looks for folders under "Data\Localization\" and extracts the language names.
#[tauri::command]
pub async fn list_localization_languages(gp: String, v: String) -> Result<Vec<String>, String> {
    let p4k = sc_base_dir(&gp, &v).join("Data.p4k");
    if !p4k.exists() {
        return Err("No P4K".into());
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

    let mut localization_files = vec![];
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
        if name.to_lowercase().contains("localization/") {
            localization_files.push(name.to_string());
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

    let mut languages = HashSet::new();
    for entry in localization_files {
        if
            let Some(rest) = entry
                .strip_prefix("Data\\Localization\\")
                .or(entry.strip_prefix("Localization\\"))
        {
            if let Some(sep) = rest.find('\\') {
                let lang = rest[..sep].to_string();
                if !lang.is_empty() {
                    languages.insert(lang);
                }
            }
        }
    }

    let mut result: Vec<String> = languages.into_iter().collect();
    result.sort();
    Ok(result)
}
/// Returns the SC input prefix for a device type (e.g. "joystick" -> "js").
/// These prefixes are used in `<rebind input="js1_button5"/>` references.
fn device_type_to_input_prefix(device_type: &str) -> &str {
    match device_type {
        "joystick" => "js",
        "keyboard" => "kb",
        "gamepad" => "gp",
        "mouse" => "mo",
        _ => "js",
    }
}

/// Reorders device instance numbers within a saved profile (backup).
///
/// Operates on the backup's own `actionmaps.xml` snapshot, NOT on live SC files.
/// After swapping instance numbers in the XML, the `device_map` in
/// `backup_meta.json` is re-derived so the UI immediately reflects the change.
/// Device aliases are preserved via `product_name`.
///
/// Device identity = (type, instance). A keyboard with instance 1 and a joystick
/// with instance 1 are different devices. The swap is scoped to the device type:
///   - `<options type="joystick" instance="2">` attributes
///   - `<rebind input="js2_button5"/>` input references (prefix is type-specific)
///
/// The two-phase replacement (original -> placeholder -> final value) avoids collisions
/// when swapping instance numbers (e.g. js2<->js3 without js2->js3->js3 happening).
#[tauri::command]
pub async fn reorder_profile_devices(
    v: String,
    bid: String,
    new_order: Vec<DeviceReorderEntry>,
) -> Result<(), String> {
    validate_backup_id(&bid)?;
    let bdir = backup_version_dir(&v)?.join(&bid);
    let actionmaps_path = bdir.join("actionmaps.xml");

    if !actionmaps_path.exists() {
        return Err("Profile has no actionmaps.xml".into());
    }

    let mut xml = fs::read_to_string(&actionmaps_path).map_err(|e| e.to_string())?;

    // Phase 1: Replace originals with unique placeholders (scoped by device type)
    for entry in &new_order {
        let prefix = device_type_to_input_prefix(&entry.device_type);

        // Swap <options type="joystick" instance="2"> → placeholder
        let options_orig = format!(
            "type=\"{}\" instance=\"{}\"",
            entry.device_type, entry.old_instance
        );
        let options_placeholder = format!(
            "type=\"{}\" instance=\"__REMAP_{}__\"",
            entry.device_type, entry.new_instance
        );
        xml = xml.replace(&options_orig, &options_placeholder);

        // Swap input references: js2_ → __JS_REMAP_3__
        let input_orig = format!("{}{}_", prefix, entry.old_instance);
        let input_placeholder = format!(
            "__{}_REMAP_{}_",
            prefix.to_uppercase(),
            entry.new_instance
        );
        xml = xml.replace(&input_orig, &input_placeholder);
    }

    // Phase 2: Replace placeholders with final values
    for entry in &new_order {
        let prefix = device_type_to_input_prefix(&entry.device_type);

        let options_placeholder = format!(
            "type=\"{}\" instance=\"__REMAP_{}__\"",
            entry.device_type, entry.new_instance
        );
        let options_final = format!(
            "type=\"{}\" instance=\"{}\"",
            entry.device_type, entry.new_instance
        );
        xml = xml.replace(&options_placeholder, &options_final);

        let input_placeholder = format!(
            "__{}_REMAP_{}_",
            prefix.to_uppercase(),
            entry.new_instance
        );
        let input_final = format!("{}{}_", prefix, entry.new_instance);
        xml = xml.replace(&input_placeholder, &input_final);
    }

    fs::write(&actionmaps_path, &xml)
        .map_err(|e| format!("Failed to write actionmaps.xml: {}", e))?;

    // Phase 3: Re-derive device_map from the updated XML and persist to backup_meta.json
    let meta_path = bdir.join("backup_meta.json");
    if meta_path.exists() {
        let meta_json = fs::read_to_string(&meta_path).map_err(|e| e.to_string())?;
        let mut meta: BackupInfo = serde_json::from_str(&meta_json).map_err(|e| e.to_string())?;

        // Save existing aliases keyed by (product_name) before re-deriving
        let aliases: HashMap<String, String> = meta.device_map.iter()
            .filter_map(|dm| dm.alias.as_ref().map(|a| (dm.product_name.clone(), a.clone())))
            .collect();

        // Re-derive device_map from the modified actionmaps.xml
        let parsed = parse_actionmaps_xml(&xml)?;
        let mut new_map = derive_device_map(&parsed);

        // Restore aliases by matching product_name
        for dm in &mut new_map {
            if let Some(alias) = aliases.get(&dm.product_name) {
                dm.alias = Some(alias.clone());
            }
        }

        meta.device_map = new_map;

        // Update the stored hash for actionmaps.xml so check_profile_status
        // correctly detects that the profile is now out of sync with SC files
        if let Some(new_hash) = hash_file(&actionmaps_path) {
            meta.file_hashes.insert("actionmaps.xml".to_string(), new_hash);
        }

        save_backup_meta(&bdir, &meta)?;
    }

    Ok(())
}
/// Computes the SHA256 hash of a file. Used for change detection in backups.
/// Calculates a stable, logical hash for a file.
/// For actionmaps.xml and attributes.xml, it uses a canonicalized data-driven 
/// representation that ignores formatting and noise.
/// For other files, it falls back to a raw SHA-256 byte hash.
fn hash_file(path: &Path) -> Option<String> {
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
        self.devices.sort_by(|a, b| a.instance.cmp(&b.instance));
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

/// Creates a manual backup of the default profile with a user-defined label.
#[tauri::command]
pub async fn backup_profile_manual(gp: String, v: String, l: String) -> Result<BackupInfo, String> {
    backup_profile(gp, v, Some("manual".into()), Some(l)).await
}
/// Creates a backup of the default profile with a timestamp.
/// Backs up profile files (actionmaps, attributes, profile), controls/mappings, and
/// custom characters into a backup folder with a unique ID.
/// Computes SHA256 hashes of all files for later change detection.
#[tauri::command]
pub async fn backup_profile(
    gp: String,
    v: String,
    bt: Option<String>,
    l: Option<String>
) -> Result<BackupInfo, String> {
    let now = Local::now();
    let id = now.format("%Y-%m-%dT%H-%M-%S").to_string();
    let bdir = backup_version_dir(&v)?;
    let target = bdir.join(&id);
    fs::create_dir_all(&target).map_err(|e| format!("Failed to create backup dir: {}", e))?;

    let expanded = expand_tilde(&gp);
    let user_base = get_sc_base_path(&expanded)?.join(&v).join("user/client/0");
    let pdir = user_base.join("Profiles/default");
    let mut fs_list = vec![];
    let mut hashes = HashMap::new();
    for f in &["actionmaps.xml", "attributes.xml", "profile.xml"] {
        let src = pdir.join(f);
        if src.exists() {
            if let Some(h) = hash_file(&src) { hashes.insert(f.to_string(), h); }
            if let Err(e) = fs::copy(&src, target.join(f)) {
                log::warn!("Failed to backup {}: {}", f, e);
            } else {
                fs_list.push(f.to_string());
            }
        }
    }

    // Backup Controls/Mappings
    if let Some(controls_dir) = find_dir_case_insensitive(&user_base, &["Controls/Mappings", "controls/mappings", "controls/Mappings"]) {
        let target_controls = target.join("controls_mappings");
        fs::create_dir_all(&target_controls).map_err(|e| format!("Failed to create controls backup dir: {}", e))?;
        if let Ok(entries) = fs::read_dir(&controls_dir) {
            for e in entries.flatten() {
                let path = e.path();
                if path.extension().is_some_and(|ext| ext.eq_ignore_ascii_case("xml")) {
                    if let Some(name) = path.file_name() {
                        let key = format!("controls_mappings/{}", name.to_string_lossy());
                        if let Some(h) = hash_file(&path) { hashes.insert(key.clone(), h); }
                        if let Err(e) = fs::copy(&path, target_controls.join(name)) {
                            log::warn!("Failed to backup {}: {}", key, e);
                        } else {
                            fs_list.push(key);
                        }
                    }
                }
            }
        }
    }

    // Backup CustomCharacters
    if let Some(chars_dir) = find_dir_case_insensitive(&user_base, &["CustomCharacters", "customcharacters"]) {
        let target_chars = target.join("custom_characters");
        fs::create_dir_all(&target_chars).map_err(|e| format!("Failed to create chars backup dir: {}", e))?;
        if let Ok(entries) = fs::read_dir(&chars_dir) {
            for e in entries.flatten() {
                let path = e.path();
                if path.extension().is_some_and(|ext| ext.eq_ignore_ascii_case("chf")) {
                    if let Some(name) = path.file_name() {
                        let key = format!("custom_characters/{}", name.to_string_lossy());
                        if let Some(h) = hash_file(&path) { hashes.insert(key.clone(), h); }
                        if let Err(e) = fs::copy(&path, target_chars.join(name)) {
                            log::warn!("Failed to backup {}: {}", key, e);
                        } else {
                            fs_list.push(key);
                        }
                    }
                }
            }
        }
    }

    // Derive device_map from the backed-up actionmaps.xml
    let device_map = if target.join("actionmaps.xml").exists() {
        if let Ok(xml) = fs::read_to_string(target.join("actionmaps.xml")) {
            if let Ok(parsed) = parse_actionmaps_xml(&xml) {
                derive_device_map(&parsed)
            } else { vec![] }
        } else { vec![] }
    } else { vec![] };

    let info = BackupInfo {
        id,
        created_at: now.format("%Y-%m-%d %H:%M:%S").to_string(),
        timestamp: now.timestamp() as u64,
        version: v,
        backup_type: bt.unwrap_or("manual".into()),
        files: fs_list,
        label: l.unwrap_or_default(),
        file_hashes: hashes,
        device_map,
        dirty: false,
    };

    let json = serde_json::to_string_pretty(&info).map_err(|e| format!("Failed to serialize backup meta: {}", e))?;
    fs::write(target.join("backup_meta.json"), json).map_err(|e| format!("Failed to write backup meta: {}", e))?;

    Ok(info)
}
/// Restores a profile from a previously created backup.
/// Copies all profile files, controls/mappings, and custom characters
/// from the backup folder back into the SC directory.
#[tauri::command]
pub async fn restore_profile(gp: String, v: String, bid: String) -> Result<(), String> {
    validate_backup_id(&bid)?;
    let bdir = backup_version_dir(&v)?.join(&bid);
    let expanded = expand_tilde(&gp);
    let user_base = get_sc_base_path(&expanded)?.join(&v).join("user/client/0");
    let pdir = user_base.join("Profiles/default");
    fs::create_dir_all(&pdir).map_err(|e| format!("Failed to create profile dir: {}", e))?;
    for f in &["actionmaps.xml", "attributes.xml", "profile.xml"] {
        if bdir.join(f).exists() {
            if let Err(e) = fs::copy(bdir.join(f), pdir.join(f)) {
                log::warn!("Failed to restore {}: {}", f, e);
            }
        }
    }

    // Restore Controls/Mappings
    if bdir.join("controls_mappings").is_dir() {
        let target_controls = find_dir_case_insensitive(&user_base, &["Controls/Mappings", "controls/mappings", "controls/Mappings"])
            .unwrap_or_else(|| user_base.join("Controls/Mappings"));
        fs::create_dir_all(&target_controls).map_err(|e| format!("Failed to create controls dir: {}", e))?;
        if let Ok(entries) = fs::read_dir(bdir.join("controls_mappings")) {
            for e in entries.flatten() {
                let path = e.path();
                if let Some(name) = path.file_name() {
                    if let Err(e) = fs::copy(&path, target_controls.join(name)) {
                        log::warn!("Failed to restore control mapping {}: {}", name.to_string_lossy(), e);
                    }
                }
            }
        }
    }

    // Restore CustomCharacters
    if bdir.join("custom_characters").is_dir() {
        let target_chars = find_dir_case_insensitive(&user_base, &["CustomCharacters", "customcharacters"])
            .unwrap_or_else(|| user_base.join("CustomCharacters"));
        fs::create_dir_all(&target_chars).map_err(|e| format!("Failed to create chars dir: {}", e))?;
        if let Ok(entries) = fs::read_dir(bdir.join("custom_characters")) {
            for e in entries.flatten() {
                let path = e.path();
                if let Some(name) = path.file_name() {
                    if let Err(e) = fs::copy(&path, target_chars.join(name)) {
                        log::warn!("Failed to restore character {}: {}", name.to_string_lossy(), e);
                    }
                }
            }
        }
    }

    Ok(())
}

/// Imports settings from another SC version as a new saved profile.
/// If `bid` is specified, copies from the saved profile;
/// otherwise from the live SC files of the source version.
/// Does NOT overwrite SC files - only creates a new profile that the user can then load.
#[tauri::command]
pub async fn import_version_as_profile(
    gp: String,
    source_version: String,
    target_version: String,
    bid: Option<String>,
    label: Option<String>,
) -> Result<BackupInfo, String> {
    let now = Local::now();
    let id = now.format("%Y-%m-%dT%H-%M-%S").to_string();
    let bdir = backup_version_dir(&target_version)?;
    let target = bdir.join(&id);
    fs::create_dir_all(&target).ok();

    let auto_label = label.unwrap_or_else(|| format!("Imported from {}", source_version));
    let mut fs_list = vec![];
    let mut hashes = HashMap::new();

    if let Some(ref backup_id) = bid {
        // Copy from a saved profile in the source version
        let src_backup = backup_version_dir(&source_version)?.join(backup_id);
        if !src_backup.is_dir() {
            return Err(format!("Backup {} not found in version {}", backup_id, source_version));
        }
        for f in &["actionmaps.xml", "attributes.xml", "profile.xml"] {
            let src = src_backup.join(f);
            if src.exists() {
                if let Some(h) = hash_file(&src) { hashes.insert(f.to_string(), h); }
                fs::copy(&src, target.join(f)).ok();
                fs_list.push(f.to_string());
            }
        }
        if src_backup.join("controls_mappings").is_dir() {
            let tc = target.join("controls_mappings");
            fs::create_dir_all(&tc).ok();
            if let Ok(entries) = fs::read_dir(src_backup.join("controls_mappings")) {
                for e in entries.flatten() {
                    let path = e.path();
                    if let Some(name) = path.file_name() {
                        let key = format!("controls_mappings/{}", name.to_string_lossy());
                        if let Some(h) = hash_file(&path) { hashes.insert(key.clone(), h); }
                        fs::copy(&path, tc.join(name)).ok();
                        fs_list.push(key);
                    }
                }
            }
        }
        if src_backup.join("custom_characters").is_dir() {
            let tc = target.join("custom_characters");
            fs::create_dir_all(&tc).ok();
            if let Ok(entries) = fs::read_dir(src_backup.join("custom_characters")) {
                for e in entries.flatten() {
                    let path = e.path();
                    if let Some(name) = path.file_name() {
                        let key = format!("custom_characters/{}", name.to_string_lossy());
                        if let Some(h) = hash_file(&path) { hashes.insert(key.clone(), h); }
                        fs::copy(&path, tc.join(name)).ok();
                        fs_list.push(key);
                    }
                }
            }
        }
    } else {
        // Copy from the source version's live SC files
        let expanded = expand_tilde(&gp);
        let source_base = sc_base_dir(&expanded, &source_version).join("user/client/0");
        let pdir = source_base.join("Profiles/default");
        for f in &["actionmaps.xml", "attributes.xml", "profile.xml"] {
            let src = pdir.join(f);
            if src.exists() {
                if let Some(h) = hash_file(&src) { hashes.insert(f.to_string(), h); }
                fs::copy(&src, target.join(f)).ok();
                fs_list.push(f.to_string());
            }
        }
        if let Some(controls_dir) = find_dir_case_insensitive(&source_base, &["Controls/Mappings", "controls/mappings", "controls/Mappings"]) {
            let tc = target.join("controls_mappings");
            fs::create_dir_all(&tc).ok();
            if let Ok(entries) = fs::read_dir(&controls_dir) {
                for e in entries.flatten() {
                    let path = e.path();
                    if path.extension().is_some_and(|ext| ext.eq_ignore_ascii_case("xml")) {
                        if let Some(name) = path.file_name() {
                            let key = format!("controls_mappings/{}", name.to_string_lossy());
                            if let Some(h) = hash_file(&path) { hashes.insert(key.clone(), h); }
                            fs::copy(&path, tc.join(name)).ok();
                            fs_list.push(key);
                        }
                    }
                }
            }
        }
        if let Some(chars_dir) = find_dir_case_insensitive(&source_base, &["CustomCharacters", "customcharacters"]) {
            let tc = target.join("custom_characters");
            fs::create_dir_all(&tc).ok();
            if let Ok(entries) = fs::read_dir(&chars_dir) {
                for e in entries.flatten() {
                    let path = e.path();
                    if path.extension().is_some_and(|ext| ext.eq_ignore_ascii_case("chf")) {
                        if let Some(name) = path.file_name() {
                            let key = format!("custom_characters/{}", name.to_string_lossy());
                            if let Some(h) = hash_file(&path) { hashes.insert(key.clone(), h); }
                            fs::copy(&path, tc.join(name)).ok();
                            fs_list.push(key);
                        }
                    }
                }
            }
        }
    }

    if fs_list.is_empty() {
        // Clean up empty backup dir
        fs::remove_dir_all(&target).ok();
        return Err("No files found to import.".into());
    }

    // Derive device_map from actionmaps.xml if present
    let device_map = if target.join("actionmaps.xml").exists() {
        if let Ok(xml) = fs::read_to_string(target.join("actionmaps.xml")) {
            if let Ok(parsed) = parse_actionmaps_xml(&xml) {
                derive_device_map(&parsed)
            } else { vec![] }
        } else { vec![] }
    } else { vec![] };

    let info = BackupInfo {
        id,
        created_at: now.format("%Y-%m-%d %H:%M:%S").to_string(),
        timestamp: now.timestamp() as u64,
        version: target_version,
        backup_type: "imported".into(),
        files: fs_list,
        label: auto_label,
        file_hashes: hashes,
        device_map,
        dirty: false,
    };

    let json = serde_json::to_string_pretty(&info).map_err(|e| format!("Failed to serialize backup meta: {}", e))?;
    fs::write(target.join("backup_meta.json"), json).map_err(|e| format!("Failed to write backup meta: {}", e))?;

    Ok(info)
}

/// Lists all profile backups for an SC version, sorted by creation time (newest first).
#[tauri::command]
pub async fn list_backups(v: String) -> Result<Vec<BackupInfo>, String> {
    let d = backup_version_dir(&v)?;
    if !d.is_dir() {
        return Ok(vec![]);
    }
    let mut res = vec![];
    if let Ok(es) = fs::read_dir(d) {
        for e in es.flatten() {
            if let Ok(c) = fs::read_to_string(e.path().join("backup_meta.json")) {
                if let Ok(i) = serde_json::from_str::<BackupInfo>(&c) {
                    res.push(i);
                }
            }
        }
    }
    res.sort_by_key(|b| std::cmp::Reverse(b.timestamp));
    Ok(res)
}
/// Deletes a profile backup by its ID.
#[tauri::command]
pub async fn delete_backup(v: String, bid: String) -> Result<(), String> {
    validate_backup_id(&bid)?;
    let p = backup_version_dir(&v)?.join(&bid);
    if p.is_dir() {
        fs::remove_dir_all(p).ok();
    }
    Ok(())
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

/// Collects SHA256 hashes of all current SC profile files for comparison with a backup.
fn collect_current_sc_hashes(user_base: &Path) -> HashMap<String, String> {
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

/// Compares current SC files with the stored hashes of a backup.
/// Detects modified, deleted, and new files since the backup.
#[tauri::command]
pub async fn check_profile_status(gp: String, v: String, bid: String) -> Result<ProfileStatus, String> {
    validate_backup_id(&bid)?;
    let bdir = backup_version_dir(&v)?.join(&bid);
    let meta_path = bdir.join("backup_meta.json");
    let meta: BackupInfo = serde_json::from_str(
        &fs::read_to_string(&meta_path).map_err(|e| e.to_string())?
    ).map_err(|e| e.to_string())?;

    if meta.file_hashes.is_empty() {
        return Ok(ProfileStatus { matched: false, files: vec![] });
    }

    let expanded = expand_tilde(&gp);
    let user_base = get_sc_base_path(&expanded)?.join(&v).join("user/client/0");
    let current = collect_current_sc_hashes(&user_base);

    let mut files = vec![];
    let mut all_match = true;

    // Check files from backup
    for (file, saved_hash) in &meta.file_hashes {
        let status = match current.get(file) {
            Some(cur_hash) if cur_hash == saved_hash => "unchanged",
            Some(_) => { all_match = false; "modified" },
            None => { all_match = false; "deleted" },
        };
        files.push(FileStatus { file: file.clone(), status: status.into() });
    }

    // Check for new files not in backup
    for file in current.keys() {
        if !meta.file_hashes.contains_key(file) {
            all_match = false;
            files.push(FileStatus { file: file.clone(), status: "new".into() });
        }
    }

    files.sort_by(|a, b| a.file.cmp(&b.file));

    Ok(ProfileStatus { matched: all_match, files })
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

/// Computes a line-by-line diff between a backup file and the current SC file.
/// Uses the `similar` library for comparison.
#[tauri::command]
pub async fn get_file_diff(file: String, gp: String, v: String, bid: String) -> Result<Vec<DiffLine>, String> {
    validate_backup_id(&bid)?;

    // Read backup file
    let bdir = backup_version_dir(&v)?.join(&bid);
    let backup_path = bdir.join(&file);
    let backup_content = fs::read_to_string(&backup_path)
        .map_err(|e| format!("Cannot read backup file: {}", e))?;

    // Read current SC file
    let expanded = expand_tilde(&gp);
    let user_base = get_sc_base_path(&expanded)?.join(&v).join("user/client/0");
    let current_path = if file.starts_with("controls_mappings/") {
        let controls_dir = find_dir_case_insensitive(
            &user_base,
            &["Controls/Mappings", "controls/mappings", "controls/Mappings"],
        ).ok_or("Controls/Mappings directory not found")?;
        controls_dir.join(file.strip_prefix("controls_mappings/")
            .ok_or_else(|| "Invalid controls_mappings path".to_string())?)
    } else {
        user_base.join("Profiles/default").join(&file)
    };
    let current_content = fs::read_to_string(&current_path)
        .map_err(|e| format!("Cannot read current file: {}", e))?;

    // Compute diff
    let diff = TextDiff::from_lines(&backup_content, &current_content);
    let mut lines = Vec::new();
    let mut old_no: usize = 0;
    let mut new_no: usize = 0;

    for change in diff.iter_all_changes() {
        let (line_type, old_line_no, new_line_no) = match change.tag() {
            ChangeTag::Equal => {
                old_no += 1;
                new_no += 1;
                ("context", Some(old_no), Some(new_no))
            }
            ChangeTag::Delete => {
                old_no += 1;
                ("remove", Some(old_no), None)
            }
            ChangeTag::Insert => {
                new_no += 1;
                ("add", None, Some(new_no))
            }
        };

        lines.push(DiffLine {
            line_type: line_type.into(),
            old_line_no,
            new_line_no,
            content: change.to_string_lossy().trim_end_matches('\n').to_string(),
        });
    }

    Ok(lines)
}

/// Path to active_profiles.json - stores which profile is active per SC version.
fn active_profiles_path() -> Result<std::path::PathBuf, String> {
    Ok(dirs::config_dir().ok_or("No config dir")?.join("penguin-citizen/active_profiles.json"))
}

/// Loads the mapping of active profiles (version -> backup ID).
#[tauri::command]
pub async fn load_active_profiles() -> Result<HashMap<String, String>, String> {
    let path = active_profiles_path()?;
    if !path.exists() { return Ok(HashMap::new()); }
    let data = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&data).map_err(|e| e.to_string())
}

/// Saves or removes the active profile assignment for an SC version.
/// An empty bid removes the assignment.
#[tauri::command]
pub async fn save_active_profile(v: String, bid: String) -> Result<(), String> {
    let path = active_profiles_path()?;
    let mut map: HashMap<String, String> = if path.exists() {
        serde_json::from_str(&fs::read_to_string(&path).unwrap_or_default()).unwrap_or_default()
    } else {
        HashMap::new()
    };
    if bid.is_empty() {
        map.remove(&v);
    } else {
        map.insert(v, bid);
    }
    if let Some(parent) = path.parent() { fs::create_dir_all(parent).ok(); }
    fs::write(path, serde_json::to_string_pretty(&map).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}

/// Updates the label of an existing backup.
#[tauri::command]
pub async fn update_backup_label(v: String, bid: String, l: String) -> Result<(), String> {
    validate_backup_id(&bid)?;
    let p = backup_version_dir(&v)?.join(&bid).join("backup_meta.json");
    let mut i: BackupInfo = serde_json
        ::from_str(&fs::read_to_string(&p).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    i.label = l;
    fs::write(p, serde_json::to_string_pretty(&i).map_err(|e| e.to_string())?).map_err(|e|
        e.to_string()
    )
}

/// Lists other SC version folders that contain importable profile/control/character data.
/// Scores each version to suggest the best import source.
#[tauri::command]
pub async fn list_importable_versions(gp: String, target_version: String) -> Result<Vec<VersionImportInfo>, String> {
    let base = Path::new(&expand_tilde(&gp)).join("drive_c/Program Files/Roberts Space Industries/StarCitizen");
    let mut result = vec![];
    let entries = fs::read_dir(&base).map_err(|e| e.to_string())?;
    for e in entries.flatten() {
        let path = e.path();
        if !path.is_dir() { continue; }
        let version = path.file_name().unwrap_or_default().to_string_lossy().into_owned();
        if version == target_version { continue; }

        let user_base = path.join("user/client/0");
        let profiles_dir = user_base.join("Profiles/default");

        let profile_file_count = ["actionmaps.xml", "attributes.xml", "profile.xml"]
            .iter()
            .filter(|f| profiles_dir.join(f).exists())
            .count() as u32;

        let (controls_dir, controls_file_count) = match find_dir_case_insensitive(&user_base, &["Controls/Mappings", "controls/mappings", "controls/Mappings"]) {
            Some(d) => {
                let count = fs::read_dir(&d).map_or(0, |es| es.flatten().filter(|e| e.path().extension().is_some_and(|ext| ext.eq_ignore_ascii_case("xml"))).count()) as u32;
                (true, count)
            }
            None => (false, 0)
        };

        let (chars_dir, character_file_count) = match find_dir_case_insensitive(&user_base, &["CustomCharacters", "customcharacters"]) {
            Some(d) => {
                let count = fs::read_dir(&d).map_or(0, |es| es.flatten().filter(|e| e.path().extension().is_some_and(|ext| ext.eq_ignore_ascii_case("chf"))).count()) as u32;
                (true, count)
            }
            None => (false, 0)
        };

        let score = profile_file_count * 3 + controls_file_count * 2 + character_file_count;
        if score == 0 { continue; }

        result.push(VersionImportInfo {
            version,
            has_profiles: profile_file_count > 0,
            has_controls_mappings: controls_dir,
            has_custom_characters: chars_dir,
            profile_file_count,
            controls_file_count,
            character_file_count,
            score,
        });
    }
    result.sort_by(|a, b| b.score.cmp(&a.score));
    Ok(result)
}

/// Imports profile, controls, and character data from one SC version to another.
/// Automatically creates a "pre-import" backup of the target version before overwriting.
#[tauri::command]
pub async fn import_from_version(gp: String, source_version: String, target_version: String) -> Result<ImportResult, String> {
    let expanded = expand_tilde(&gp);
    let source_base = sc_base_dir(&expanded, &source_version).join("user/client/0");
    let target_base = sc_base_dir(&expanded, &target_version).join("user/client/0");

    // Save existing settings before they get overwritten by import
    let target_profiles = target_base.join("Profiles/default");
    if target_profiles.join("actionmaps.xml").exists() {
        let _ = backup_profile(gp.clone(), target_version.clone(), Some("pre-import".into()), Some(format!("Before import from {}", source_version))).await;
    }

    // Copy profiles
    let mut profiles_copied = 0u32;
    let source_profiles = source_base.join("Profiles/default");
    if source_profiles.is_dir() {
        fs::create_dir_all(&target_profiles).map_err(|e| e.to_string())?;
        for f in &["actionmaps.xml", "attributes.xml", "profile.xml"] {
            let src = source_profiles.join(f);
            if src.exists() {
                fs::copy(&src, target_profiles.join(f)).map_err(|e| e.to_string())?;
                profiles_copied += 1;
            }
        }
    }

    // Copy Controls/Mappings
    let mut controls_copied = 0u32;
    if let Some(source_controls) = find_dir_case_insensitive(&source_base, &["Controls/Mappings", "controls/mappings", "controls/Mappings"]) {
        let target_controls = find_dir_case_insensitive(&target_base, &["Controls/Mappings", "controls/mappings", "controls/Mappings"])
            .unwrap_or_else(|| target_base.join("Controls/Mappings"));
        fs::create_dir_all(&target_controls).map_err(|e| e.to_string())?;
        if let Ok(entries) = fs::read_dir(&source_controls) {
            for e in entries.flatten() {
                let path = e.path();
                if path.extension().is_some_and(|ext| ext.eq_ignore_ascii_case("xml")) {
                    if let Some(name) = path.file_name() {
                        fs::copy(&path, target_controls.join(name)).map_err(|e| e.to_string())?;
                        controls_copied += 1;
                    }
                }
            }
        }
    }

    // Copy CustomCharacters
    let mut characters_copied = 0u32;
    if let Some(source_chars) = find_dir_case_insensitive(&source_base, &["CustomCharacters", "customcharacters"]) {
        let target_chars = find_dir_case_insensitive(&target_base, &["CustomCharacters", "customcharacters"])
            .unwrap_or_else(|| target_base.join("CustomCharacters"));
        fs::create_dir_all(&target_chars).map_err(|e| e.to_string())?;
        if let Ok(entries) = fs::read_dir(&source_chars) {
            for e in entries.flatten() {
                let path = e.path();
                if path.extension().is_some_and(|ext| ext.eq_ignore_ascii_case("chf")) {
                    if let Some(name) = path.file_name() {
                        fs::copy(&path, target_chars.join(name)).map_err(|e| e.to_string())?;
                        characters_copied += 1;
                    }
                }
            }
        }
    }

    Ok(ImportResult { profiles_copied, controls_copied, characters_copied })
}

/// Lists exported controller layout XML files from the controls/mappings directory.
/// Sorted by modification date (newest first).
#[tauri::command]
pub async fn list_exported_layouts(
    game_path: String,
    version: String
) -> Result<Vec<ExportedLayout>, String> {
    let d = sc_base_dir(&expand_tilde(&game_path), &version).join(
        "user/client/0/controls/mappings"
    );
    if !d.is_dir() {
        return Ok(vec![]);
    }
    let mut res = vec![];
    if let Ok(es) = fs::read_dir(d) {
        for e in es.flatten() {
            let path = e.path();
            if path.extension().is_some_and(|ext| ext == "xml") {
                let f = path.file_name().unwrap_or_default().to_string_lossy().into_owned();
                let m = path
                    .metadata()
                    .ok()
                    .and_then(|m| m.modified().ok())
                    .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                    .map(|d| d.as_secs())
                    .unwrap_or(0);
                res.push(ExportedLayout {
                    label: f.trim_end_matches(".xml").replace('_', " "),
                    filename: f,
                    modified: m,
                });
            }
        }
    }
    res.sort_by_key(|l| std::cmp::Reverse(l.modified));
    Ok(res)
}

/// Returns the file size of Data.p4k for an SC version.
/// Tries multiple possible base paths.
#[tauri::command]
pub async fn get_data_p4k_size(gp: String, version: String) -> Result<u64, String> {
    let exp = expand_tilde(&gp);

    // Try multiple possible paths
    let base_paths: Vec<PathBuf> = vec![
        Path::new(&exp).join("drive_c/Program Files/Roberts Space Industries/StarCitizen"),
        Path::new(&exp).join("StarCitizen"),
        Path::new(&exp).to_path_buf()
    ];

    let mut base = None;
    for p in &base_paths {
        if p.exists() && p.is_dir() {
            base = Some(p.clone());
            break;
        }
    }

    let base = base.ok_or_else(|| "StarCitizen directory not found".to_string())?;

    let data_p4k_path = base.join(&version).join("Data.p4k");

    if !data_p4k_path.exists() {
        return Err("Data.p4k not found".to_string());
    }

    let metadata = fs::metadata(&data_p4k_path).map_err(|e| e.to_string())?;
    Ok(metadata.len())
}

/// Copies Data.p4k from a source version to a target version with progress reporting.
/// Sends "data-p4k-progress" events to the frontend (percent, copied bytes, speed).
/// At the end, a "data-p4k-copy-complete" event is sent.
#[tauri::command]
pub async fn copy_data_p4k(
    gp: String,
    source_version: String,
    target_version: String,
    _window: tauri::Window,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    let exp = expand_tilde(&gp);

    // Try multiple possible paths
    let base_paths: Vec<PathBuf> = vec![
        Path::new(&exp).join("drive_c/Program Files/Roberts Space Industries/StarCitizen"),
        Path::new(&exp).join("StarCitizen"),
        Path::new(&exp).to_path_buf()
    ];

    let mut base = None;
    for p in &base_paths {
        if p.exists() && p.is_dir() {
            base = Some(p.clone());
            break;
        }
    }

    let base = base.ok_or_else(|| "StarCitizen directory not found".to_string())?;

    let source = base.join(&source_version).join("Data.p4k");
    let target = base.join(&target_version).join("Data.p4k");

    if !source.exists() {
        return Err(format!("Source Data.p4k not found at {}", source.display()));
    }

    if target.exists() {
        return Err("Target already has Data.p4k".to_string());
    }

    // Get file size for progress calculation
    let metadata = fs::metadata(&source).map_err(|e| e.to_string())?;
    let total_size = metadata.len();

    // Create parent dir if needed
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    // Copy with progress using tokio (runs in background thread)
    let source_clone = source.clone();
    let target_clone = target.clone();
    let target_version_for_emit = target_version.clone();
    let app_handle_clone = app_handle.clone();
    let start_time = std::time::Instant::now();

    tokio::task::spawn_blocking(move || {
        copy_with_progress(&source_clone, &target_clone, total_size, move |copied, total| {
            let elapsed = start_time.elapsed().as_secs_f64();
            let speed_bps = if elapsed > 0.0 { (copied as f64 / elapsed) as u64 } else { 0 };
            let percent = (copied as f64 / total as f64 * 100.0) as u32;
            log::debug!("Emitting progress: {} bytes", copied);
            let _ = app_handle_clone.emit("data-p4k-progress", serde_json::json!({
                "version": target_version_for_emit,
                "percent": percent,
                "copied_bytes": copied,
                "total_bytes": total,
                "speed_bps": speed_bps
            }));
        })
    })
    .await
    .map_err(|e| format!("Task error: {}", e))??;

    log::info!("Copied Data.p4k from {} to {}", source_version, target_version);

    // Emit completion event
    let _ = app_handle.emit("data-p4k-copy-complete", serde_json::json!({
        "version": target_version,
        "success": true
    }));

    Ok(())
}

/// Copies a file with progress tracking (synchronous, for spawn_blocking).
/// Reads in 8MB chunks and reports progress every 10MB via the callback.
fn copy_with_progress<F>(from: &Path, to: &Path, total_size: u64, mut progress_callback: F) -> Result<u64, String>
where
    F: FnMut(u64, u64) + Send,
{
    use std::io::{BufReader, BufWriter, Read, Write};

    let input = BufReader::new(
        fs::File::open(from).map_err(|e| e.to_string())?
    );
    let mut input: Box<dyn Read> = Box::new(input);

    let output = BufWriter::new(
        fs::File::create(to).map_err(|e| e.to_string())?
    );
    let mut output: Box<dyn Write> = Box::new(output);

    let mut written: u64 = 0;
    let mut last_reported: u64 = 0;
    let report_interval: u64 = 10 * 1024 * 1024; // 10MB
    let mut buffer = vec![0u8; 8 * 1024 * 1024]; // 8MB buffer on heap

    loop {
        let bytes_read = input.read(&mut buffer).map_err(|e| e.to_string())?;
        if bytes_read == 0 {
            break;
        }

        output.write_all(&buffer[..bytes_read]).map_err(|e| e.to_string())?;
        written += bytes_read as u64;

        if written - last_reported >= report_interval {
            progress_callback(written, total_size);
            last_reported = written;
        }
    }

    output.flush().map_err(|e| e.to_string())?;
    progress_callback(written, total_size);

    Ok(written)
}

/// Aborts an ongoing copy by deleting the incomplete file.
#[tauri::command]
pub async fn abort_copy_data_p4k(gp: String, version: String) -> Result<(), String> {
    let exp = expand_tilde(&gp);

    let base_paths: Vec<PathBuf> = vec![
        Path::new(&exp).join("drive_c/Program Files/Roberts Space Industries/StarCitizen"),
        Path::new(&exp).join("StarCitizen"),
        Path::new(&exp).to_path_buf()
    ];

    let mut base = None;
    for p in &base_paths {
        if p.exists() && p.is_dir() {
            base = Some(p.clone());
            break;
        }
    }

    let base = base.ok_or_else(|| "StarCitizen directory not found".to_string())?;
    let target = base.join(&version).join("Data.p4k");

    if target.exists() {
        fs::remove_file(&target).map_err(|e| e.to_string())?;
        log::info!("Aborted copy - removed partial Data.p4k for {}", version);
    }

    Ok(())
}

/// Deletes an entire Star Citizen version folder.
/// For security reasons, only known version names are accepted
/// (LIVE, PTU, EPTU, TECH-PREVIEW, HOTFIX).
#[tauri::command]
pub async fn delete_sc_version(gp: String, version: String) -> Result<(), String> {
    let exp = expand_tilde(&gp);

    let base_paths: Vec<PathBuf> = vec![
        Path::new(&exp).join("drive_c/Program Files/Roberts Space Industries/StarCitizen"),
        Path::new(&exp).join("StarCitizen"),
        Path::new(&exp).to_path_buf()
    ];

    let mut base = None;
    for p in &base_paths {
        if p.exists() && p.is_dir() {
            base = Some(p.clone());
            break;
        }
    }

    let base = base.ok_or_else(|| "StarCitizen directory not found".to_string())?;
    let target = base.join(&version);

    if target.exists() && target.is_dir() {
        // Double check we are not deleting random things
        let is_version_folder = matches!(version.to_lowercase().as_str(),
            "live" | "ptu" | "eptu" | "tech-preview" | "hotfix"
        );
        
        if !is_version_folder {
            return Err("Invalid version folder name for deletion".to_string());
        }

        fs::remove_dir_all(&target).map_err(|e| format!("Failed to delete version folder: {}", e))?;
        log::info!("Deleted SC version folder: {}", version);
    } else {
        return Err("Version folder not found".to_string());
    }

    Ok(())
}

/// Helper function: determines the SC base directory from a general path string.
/// Tries Wine prefix, direct directory, and the path itself.
fn get_sc_base_path(gp: &str) -> Result<PathBuf, String> {
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

/// Creates a new, empty Star Citizen version folder.
/// Only accepts valid standard version names.
#[tauri::command]
pub async fn create_sc_version(gp: String, version: String) -> Result<(), String> {
    let base = get_sc_base_path(&gp)?;
    let target = base.join(&version);
    if target.exists() {
        return Err(format!("Version {} already exists", version));
    }
    
    // Check if it's a valid standard version name
    let is_valid = matches!(version.to_uppercase().as_str(),
        "LIVE" | "PTU" | "EPTU" | "TECH-PREVIEW" | "HOTFIX"
    );
    if !is_valid {
        return Err("Invalid version name. Use LIVE, PTU, EPTU, etc.".to_string());
    }

    fs::create_dir_all(&target).map_err(|e| format!("Failed to create folder: {}", e))?;
    log::info!("Created new SC version folder: {}", version);
    Ok(())
}

/// Creates a symlink for Data.p4k from one version to another.
/// Saves disk space when multiple versions use the same P4K file.
/// Only supported on Unix/Linux.
#[tauri::command]
pub async fn link_data_p4k(gp: String, src_version: String, dst_version: String) -> Result<(), String> {
    let base = get_sc_base_path(&gp)?;
    let source = base.join(&src_version).join("Data.p4k");
    let target = base.join(&dst_version).join("Data.p4k");

    if !source.exists() {
        return Err(format!("Source Data.p4k not found in {}", src_version));
    }
    if target.exists() {
        return Err(format!("Destination already has Data.p4k in {}", dst_version));
    }

    // Ensure destination version folder exists
    if let Some(parent) = target.parent() {
        if !parent.exists() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
    }

    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(&source, &target).map_err(|e| format!("Failed to create symlink: {}", e))?;
        log::info!("Created symlink for Data.p4k from {} to {}", src_version, dst_version);
        Ok(())
    }
    #[cfg(windows)]
    {
        Err("Symlinking not yet supported on Windows".to_string())
    }
}

/// Overwrites an existing backup with the current Star Citizen files.
/// Updates all files, hashes, the device_map, and the timestamp.
/// Resets the dirty flag since the backup now matches the current state.
#[tauri::command]
pub async fn update_backup_from_sc(
    gp: String,
    v: String,
    bid: String
) -> Result<(), String> {
    validate_backup_id(&bid)?;
    let bdir = backup_version_dir(&v)?;
    let target = bdir.join(&bid);
    if !target.exists() {
        return Err("Profile not found".into());
    }

    let meta_path = target.join("backup_meta.json");
    if !meta_path.exists() {
        return Err("Profile metadata not found".into());
    }

    // Load existing metadata
    let mut info: BackupInfo = serde_json::from_str(&fs::read_to_string(&meta_path).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;

    let expanded = expand_tilde(&gp);
    let user_base = get_sc_base_path(&expanded)?.join(&v).join("user/client/0");
    let pdir = user_base.join("Profiles/default");

    let mut fs_list = vec![];
    let mut hashes = HashMap::new();
    
    // 1. Base files
    for f in &["actionmaps.xml", "attributes.xml", "profile.xml"] {
        let src = pdir.join(f);
        if src.exists() {
            if let Some(h) = hash_file(&src) { hashes.insert(f.to_string(), h); }
            fs::copy(&src, target.join(f)).ok();
            fs_list.push(f.to_string());
        }
    }

    // 2. Controls/Mappings
    if let Some(controls_dir) = find_dir_case_insensitive(&user_base, &["Controls/Mappings", "controls/mappings", "controls/Mappings"]) {
        let target_controls = target.join("controls_mappings");
        fs::create_dir_all(&target_controls).ok();
        if let Ok(entries) = fs::read_dir(&controls_dir) {
            for e in entries.flatten() {
                let path = e.path();
                if path.extension().is_some_and(|ext| ext.eq_ignore_ascii_case("xml")) {
                    if let Some(name) = path.file_name() {
                        let key = format!("controls_mappings/{}", name.to_string_lossy());
                        if let Some(h) = hash_file(&path) { hashes.insert(key.clone(), h); }
                        fs::copy(&path, target_controls.join(name)).ok();
                        fs_list.push(key);
                    }
                }
            }
        }
    }

    // 3. CustomCharacters
    if let Some(chars_dir) = find_dir_case_insensitive(&user_base, &["CustomCharacters", "customcharacters"]) {
        let target_chars = target.join("custom_characters");
        fs::create_dir_all(&target_chars).ok();
        if let Ok(entries) = fs::read_dir(&chars_dir) {
            for e in entries.flatten() {
                let path = e.path();
                if path.extension().is_some_and(|ext| ext.eq_ignore_ascii_case("chf")) {
                    if let Some(name) = path.file_name() {
                        let key = format!("custom_characters/{}", name.to_string_lossy());
                        if let Some(h) = hash_file(&path) { hashes.insert(key.clone(), h); }
                        fs::copy(&path, target_chars.join(name)).ok();
                        fs_list.push(key);
                    }
                }
            }
        }
    }

    // Derive device_map from the updated actionmaps.xml
    let device_map = if target.join("actionmaps.xml").exists() {
        if let Ok(xml) = fs::read_to_string(target.join("actionmaps.xml")) {
            if let Ok(parsed) = parse_actionmaps_xml(&xml) {
                derive_device_map(&parsed)
            } else { vec![] }
        } else { vec![] }
    } else { vec![] };

    // Update metadata
    info.files = fs_list;
    info.file_hashes = hashes;
    info.device_map = device_map;
    info.timestamp = Local::now().timestamp() as u64;
    info.dirty = false;

    fs::write(&meta_path, serde_json::to_string_pretty(&info).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;

    log::info!("Updated profile {} from current SC files", bid);
    Ok(())
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

