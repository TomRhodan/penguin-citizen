use super::*;

/// Reads the USER.cfg file for the given game path and version.
/// Returns an empty string if the file does not exist.
#[tauri::command]
pub async fn read_user_cfg(gp: String, v: String) -> Result<String, String> {
    let p = sc_base_dir(&expand_tilde(&gp), &v)?.join("USER.cfg");
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
    let p = sc_base_dir(&expand_tilde(&gp), &v)?.join("USER.cfg");
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
    let exp = expand_tilde(&gp);

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
        if base.exists() && base.is_dir() {
            if let Ok(entries) = fs::read_dir(base) {
                let entry_names: Vec<String> = entries
                    .flatten()
                    .map(|e| e.file_name().to_string_lossy().to_string())
                    .take(10)
                    .collect();

                let has_version_folders: bool = entry_names.iter().any(|name| {
                    let n = name.to_lowercase();
                    n == "live" || n == "ptu" || n == "eptu" || n == "hotfix"
                });

                if has_version_folders {
                    return detect_sc_versions_from_path(base);
                }
            }
        }
    }

    Err(format!("StarCitizen directory not found. Game path: '{}'", gp))
}

/// Reads version folders from a confirmed SC base directory
/// and checks for each one which files (USER.cfg, actionmaps.xml, etc.) are present.
/// Results are sorted by priority: LIVE > PTU > HOTFIX > other.
fn detect_sc_versions_from_path(base: &Path) -> Result<Vec<ScVersionInfo>, String> {
    let mut res = vec![];

    match fs::read_dir(base) {
        Ok(es) => {
            for e in es.flatten() {
                let path = e.path();
                if !path.is_dir() {
                    continue;
                }
                let n = path.file_name().unwrap_or_default().to_string_lossy().into_owned();

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
            log::warn!("detect_sc_versions: failed to read {}: {}", base.display(), e);
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
    Ok(res)
}
/// Lists available user profiles for an SC version.
/// Reads the "lastPlayed" timestamp from the respective attributes.xml.
/// The "frontend" profile is skipped as it is an SC-internal profile.
#[tauri::command]
pub async fn list_profiles(gp: String, v: String) -> Result<Vec<ScProfile>, String> {
    let p = sc_base_dir(&expand_tilde(&gp), &v)?.join("user/client/0/Profiles");
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
    let src = sc_base_dir(&expand_tilde(&gp), &v)?.join("user/client/0/Profiles/default");
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
    let dest = sc_base_dir(&expand_tilde(&gp), &v)?.join("user/client/0/Profiles/default");
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
    let p = sc_base_dir(&expand_tilde(&gp), &v)?.join(
        "user/client/0/Profiles/default/attributes.xml"
    );
    if !p.exists() {
        return Ok(ScAttributes::default());
    }
    let c = fs::read_to_string(p).map_err(|e| e.to_string())?;
    Ok(parse_attributes_str(&c))
}

/// Writes attributes back to the attributes.xml of the default profile.
#[tauri::command]
pub async fn write_attributes(gp: String, v: String, attrs: ScAttributes) -> Result<(), String> {
    let p = sc_base_dir(&expand_tilde(&gp), &v)?.join(
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

/// Returns all attributes from attributes.xml as a flat key-value map.
/// Used by the frontend settings tab to read attributes-target settings.
#[tauri::command]
pub async fn read_attributes_map(gp: String, v: String) -> Result<HashMap<String, String>, String> {
    let p = sc_base_dir(&expand_tilde(&gp), &v)?.join(
        "user/client/0/Profiles/default/attributes.xml"
    );
    if !p.exists() {
        return Ok(HashMap::new());
    }
    let c = fs::read_to_string(&p).map_err(|e| e.to_string())?;
    let attrs = parse_attributes_str(&c);
    Ok(attrs.attrs.into_iter().map(|a| (a.name, a.value)).collect())
}

/// Merges changed attributes into the existing attributes.xml.
/// Only the attributes present in `changes` are updated or added;
/// all other existing attributes are preserved.
#[tauri::command]
pub async fn write_attributes_partial(
    gp: String, v: String, changes: HashMap<String, String>
) -> Result<(), String> {
    let p = sc_base_dir(&expand_tilde(&gp), &v)?.join(
        "user/client/0/Profiles/default/attributes.xml"
    );
    if let Some(parent) = p.parent() {
        fs::create_dir_all(parent).ok();
    }
    let mut attrs = if p.exists() {
        let c = fs::read_to_string(&p).map_err(|e| e.to_string())?;
        parse_attributes_str(&c)
    } else {
        ScAttributes { version: "1".into(), attrs: Vec::new() }
    };
    for (name, value) in changes {
        if let Some(existing) = attrs.attrs.iter_mut().find(|a| a.name == name) {
            existing.value = value;
        } else {
            attrs.attrs.push(ScAttribute { name, value });
        }
    }
    let mut xml = format!("<Attributes Version=\"{}\">\n", attrs.version);
    for a in &attrs.attrs {
        xml.push_str(&format!(" <Attr name=\"{}\" value=\"{}\"/>\n", a.name, a.value));
    }
    xml.push_str("</Attributes>\n");
    // Atomic write via temp file + rename
    let tmp = p.with_extension("xml.tmp");
    fs::write(&tmp, &xml).map_err(|e| format!("Failed to write temp attributes: {}", e))?;
    fs::rename(&tmp, &p).map_err(|e| format!("Failed to rename temp attributes: {}", e))?;
    Ok(())
}

/// Returns a SHA256 hash of the non-volatile attributes for change detection.
/// Volatile fields (lastPlayed, window position, etc.) are filtered out
/// so that only meaningful setting changes affect the hash.
#[tauri::command]
pub async fn get_attributes_hash(gp: String, v: String) -> Result<String, String> {
    let p = sc_base_dir(&expand_tilde(&gp), &v)?.join(
        "user/client/0/Profiles/default/attributes.xml"
    );
    if !p.exists() {
        return Ok(String::new());
    }
    let c = fs::read_to_string(&p).map_err(|e| e.to_string())?;
    let mut attrs = parse_attributes_str(&c);
    attrs.canonicalize();
    let json = serde_json::to_string(&attrs.attrs)
        .map_err(|e| format!("Failed to serialize attributes: {}", e))?;
    Ok(format!("{:x}", Sha256::digest(json.as_bytes())))
}

/// Lists exported controller layout XML files from the controls/mappings directory.
/// Sorted by modification date (newest first).
#[tauri::command]
pub async fn list_exported_layouts(
    game_path: String,
    version: String
) -> Result<Vec<ExportedLayout>, String> {
    let d = sc_base_dir(&expand_tilde(&game_path), &version)?.join(
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
///
/// When `replace_existing` is true and the target already has a Data.p4k,
/// it is removed first (works for both regular files and existing symlinks).
///
/// **Partial-failure note:** When `replace_existing` is true, the existing target
/// is removed before the new symlink is created. If the symlink creation then
/// fails, the original target is NOT restored. Callers should ask the user to
/// confirm the replace before invoking with `replace_existing = true`.
#[tauri::command]
pub async fn link_data_p4k(
    gp: String,
    src_version: String,
    dst_version: String,
    replace_existing: bool,
) -> Result<(), String> {
    let base = get_sc_base_path(&gp)?;
    let source = base.join(&src_version).join("Data.p4k");
    let target = base.join(&dst_version).join("Data.p4k");

    if !source.exists() {
        return Err(format!("Source Data.p4k not found in {}", src_version));
    }
    // symlink_metadata so we detect symlinks too (exists() follows symlinks)
    let target_present = std::fs::symlink_metadata(&target).is_ok();
    if target_present {
        if !replace_existing {
            return Err(format!("Destination already has Data.p4k in {}", dst_version));
        }
        fs::remove_file(&target)
            .map_err(|e| format!("Failed to remove existing target: {}", e))?;
    }

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
    result.sort_by_key(|b| std::cmp::Reverse(b.score));
    Ok(result)
}

/// Imports profile, controls, and character data from one SC version to another.
/// Automatically creates a "pre-import" backup of the target version before overwriting.
#[tauri::command]
pub async fn import_from_version(gp: String, source_version: String, target_version: String) -> Result<ImportResult, String> {
    let expanded = expand_tilde(&gp);
    let source_base = sc_base_dir(&expanded, &source_version)?.join("user/client/0");
    let target_base = sc_base_dir(&expanded, &target_version)?.join("user/client/0");

    // Save existing settings before they get overwritten by import
    let target_profiles = target_base.join("Profiles/default");
    if target_profiles.join("actionmaps.xml").exists() {
        let _ = super::profiles::backup_profile(gp.clone(), target_version.clone(), Some("pre-import".into()), Some(format!("Before import from {}", source_version))).await;
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
