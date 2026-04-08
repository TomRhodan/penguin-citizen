use super::*;

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

    // Get master bindings and localization labels.
    // If Data.p4k is missing (version has no game data yet), return empty bindings
    // instead of propagating an error — same behaviour as "no actionmaps.xml".
    let labels = get_localization_labels(gp.clone(), v.clone(), None).await.unwrap_or_default();
    let master = match get_master_bindings(gp, v.clone()).await {
        Ok(m) => m,
        Err(e) => {
            log::warn!("[get_profile_bindings] Master bindings unavailable for {}: {}", v, e);
            return Ok(BindingListResponse {
                bindings: vec![],
                stats: BindingStats { total: 0, custom: 0 },
            });
        }
    };
    if master.profiles.is_empty() {
        return Err(format!("Master bindings for {} contain no profiles", v));
    }
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

/// Updates the Wine axis name mappings in a profile's backup_meta.json.
/// Called by the frontend after a binding capture session to persist
/// the Linux->Wine axis name mappings learned during simultaneous capture.
///
/// `instance_mappings`: JSON object keys are sc_instance as string (e.g. "2"),
/// values map Linux axis name -> Wine axis name (e.g. "slider1" -> "roty").
#[tauri::command]
pub async fn update_profile_device_wine_maps(
    v: String,
    profile_id: String,
    instance_mappings: std::collections::HashMap<
        String,
        std::collections::HashMap<String, String>,
    >,
) -> Result<(), String> {
    validate_backup_id(&profile_id)?;
    let bdir = backup_version_dir(&v)?.join(&profile_id);
    let meta_path = bdir.join("backup_meta.json");
    let meta_json = fs::read_to_string(&meta_path).map_err(|e| e.to_string())?;
    let mut info: BackupInfo = serde_json::from_str(&meta_json).map_err(|e| e.to_string())?;

    for dm in &mut info.device_map {
        // Only joystick devices can have axis mappings — skip keyboards, gamepads, etc.
        if dm.device_type != "joystick" {
            continue;
        }
        let key = dm.sc_instance.to_string();
        if let Some(mappings) = instance_mappings.get(&key) {
            for (linux_axis, wine_axis) in mappings {
                dm.axis_wine_map.insert(linux_axis.clone(), wine_axis.clone());
                log::info!(
                    "[WINE MAP] Device '{}' (js{}): {} -> {}",
                    dm.product_name,
                    dm.sc_instance,
                    linux_axis,
                    wine_axis
                );
            }
        }
    }

    save_backup_meta(&bdir, &info)
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
    wine_axis_map: Option<std::collections::HashMap<String, std::collections::HashMap<String, String>>>,
) -> Result<(), String> {
    let bdir = backup_version_dir(&v)?.join(&profile_id);

    // Load device_map from backup_meta.json to apply Wine axis name translation.
    // Falls back to empty vec (no translation) if metadata is unavailable.
    let mut device_map: Vec<DeviceMapping> = fs
        ::read_to_string(bdir.join("backup_meta.json"))
        .ok()
        .and_then(|s| serde_json::from_str::<BackupInfo>(&s).ok())
        .map(|info| info.device_map)
        .unwrap_or_default();

    // Merge in session-level wine mappings (these take priority over stored ones,
    // and are available even on the first binding before update_profile_device_wine_maps is called)
    if let Some(ref wam) = wine_axis_map {
        for dm in &mut device_map {
            if dm.device_type != "joystick" { continue; }
            let key = dm.sc_instance.to_string();
            if let Some(mappings) = wam.get(&key) {
                for (linux_axis, wine_axis) in mappings {
                    dm.axis_wine_map.insert(linux_axis.clone(), wine_axis.clone());
                }
            }
        }
    }

    // Fallback: if the profile has no device assignments (device_map is empty) but the
    // Wine helper learned axis-name mappings during this capture session, create synthetic
    // DeviceMapping entries so translate_wine_axis can still apply the translation.
    // This handles the common case where the user hasn't gone through the Device Setup page.
    if !device_map.iter().any(|d| d.device_type == "joystick") {
        if let Some(ref wam) = wine_axis_map {
            for (instance_str, mappings) in wam {
                if let Ok(instance) = instance_str.parse::<u32>() {
                    device_map.push(DeviceMapping {
                        sc_instance: instance,
                        device_type: "joystick".to_string(),
                        product_name: String::new(),
                        sc_guid: None,
                        alias: None,
                        axis_wine_map: mappings.clone(),
                    });
                }
            }
        }
    }

    let original_input = new_input.clone();
    let new_input = translate_wine_axis(&new_input, &device_map);
    log::info!(
        "[ASSIGN] wine_map_provided={} device_map_joystick_count={} input: {} -> {}",
        wine_axis_map.is_some(),
        device_map.iter().filter(|d| d.device_type == "joystick").count(),
        original_input,
        new_input
    );

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
            // If a binding for this action already exists (e.g. a cleared-prefix placeholder
            // like "js1_"), replace the placeholder instead of creating a duplicate <action>.
            if let Some(existing) = am.bindings.iter_mut().find(|b| b.action_name == action_name) {
                if let Some(pos) = existing.inputs.iter().position(|x| x.ends_with('_')) {
                    // Replace the cleared-prefix slot with the new real input
                    existing.inputs[pos] = new_input;
                } else if !existing.inputs.contains(&new_input) {
                    // No cleared placeholder — append as an additional alternative binding
                    existing.inputs.push(new_input);
                }
            } else {
                am.bindings.push(ScBinding {
                    action_name: action_name.clone(),
                    inputs: vec![new_input],
                });
            }
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


    sanitize_actionmaps(&mut parsed);
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
/// Sanitizes actionmaps.xml first, then copies via restore_profile, resets the
/// dirty flag, and saves the active profile assignment. Returns the number of
/// sanitization corrections made so the frontend can show user feedback.
#[tauri::command]
pub async fn apply_profile_to_sc(
    gp: String,
    v: String,
    profile_id: String,
) -> Result<usize, String> {
    let bdir = backup_version_dir(&v)?.join(&profile_id);

    // Sanitize the profile's actionmaps.xml before copying to SC so the game
    // receives a clean file. Record the correction count for user feedback.
    let actionmaps_path = bdir.join("actionmaps.xml");
    let corrections = if actionmaps_path.exists() {
        let xml = fs::read_to_string(&actionmaps_path).map_err(|e| e.to_string())?;
        let mut parsed = parse_actionmaps_xml(&xml)?;
        let n = sanitize_actionmaps(&mut parsed);
        if n > 0 {
            write_actionmaps_xml(&actionmaps_path, &parsed)?;
        }
        n
    } else {
        0
    };

    // Copy sanitized profile to the SC game directory
    restore_profile(gp, v.clone(), profile_id.clone()).await?;

    // Clear dirty flag
    let meta_path = bdir.join("backup_meta.json");
    if meta_path.exists() {
        let meta_json = fs::read_to_string(&meta_path).map_err(|e| e.to_string())?;
        let mut meta: BackupInfo = serde_json::from_str(&meta_json).map_err(|e| e.to_string())?;
        meta.dirty = false;
        save_backup_meta(&bdir, &meta)?;
    }

    save_active_profile(v, profile_id).await?;
    Ok(corrections)
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
        log::info!("Migrated binding_database.json -> .bak");
        Ok(true)
    } else {
        Ok(false)
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

        // Swap <options type="joystick" instance="2"> -> placeholder
        let options_orig = format!(
            "type=\"{}\" instance=\"{}\"",
            entry.device_type, entry.old_instance
        );
        let options_placeholder = format!(
            "type=\"{}\" instance=\"__REMAP_{}__\"",
            entry.device_type, entry.new_instance
        );
        xml = xml.replace(&options_orig, &options_placeholder);

        // Swap input references: js2_ -> __JS_REMAP_3__
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

        // Preserve aliases and Wine axis mappings from the existing device_map before re-deriving
        let aliases: HashMap<String, String> = meta.device_map.iter()
            .filter_map(|dm| dm.alias.as_ref().map(|a| (dm.product_name.clone(), a.clone())))
            .collect();
        let wine_maps: HashMap<(String, String), std::collections::HashMap<String, String>> =
            meta.device_map.iter()
                .filter(|dm| !dm.axis_wine_map.is_empty())
                .map(|dm| ((dm.product_name.clone(), dm.device_type.clone()), dm.axis_wine_map.clone()))
                .collect();

        // Re-derive device_map from the modified actionmaps.xml
        let parsed = parse_actionmaps_xml(&xml)?;
        let mut new_map = derive_device_map(&parsed);

        // Restore aliases and Wine axis mappings by matching product_name + device_type
        for dm in &mut new_map {
            if let Some(alias) = aliases.get(&dm.product_name) {
                dm.alias = Some(alias.clone());
            }
            if let Some(wm) = wine_maps.get(&(dm.product_name.clone(), dm.device_type.clone())) {
                dm.axis_wine_map = wm.clone();
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
        let source_base = sc_base_dir(&expanded, &source_version)?.join("user/client/0");
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

    // Derive device_map from the updated actionmaps.xml, preserving existing Wine axis mappings
    let wine_maps: HashMap<(String, String), std::collections::HashMap<String, String>> =
        info.device_map.iter()
            .filter(|dm| !dm.axis_wine_map.is_empty())
            .map(|dm| ((dm.product_name.clone(), dm.device_type.clone()), dm.axis_wine_map.clone()))
            .collect();
    let device_map = if target.join("actionmaps.xml").exists() {
        if let Ok(xml) = fs::read_to_string(target.join("actionmaps.xml")) {
            if let Ok(parsed) = parse_actionmaps_xml(&xml) {
                let mut new_map = derive_device_map(&parsed);
                for dm in &mut new_map {
                    if let Some(wm) = wine_maps.get(&(dm.product_name.clone(), dm.device_type.clone())) {
                        dm.axis_wine_map = wm.clone();
                    }
                }
                new_map
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
