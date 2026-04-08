use super::*;

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
        Some(f) => sc_base_dir(&exp, &v)?.join("user/client/0/controls/mappings").join(f),
        None => sc_base_dir(&exp, &v)?.join("user/client/0/Profiles/default/actionmaps.xml"),
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
    let user_p = sc_base_dir(&expand_tilde(&gp), &v)?.join(
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

/// Assigns a new input binding to an action in the user's actionmaps.xml.
/// If the file does not exist, a new one with default values is created.
/// If old_input is specified, the existing binding is replaced; otherwise a new one is added.
#[tauri::command]
pub async fn assign_binding(args: AssignBindingArgs) -> Result<(), String> {
    let p = sc_base_dir(&expand_tilde(&args.game_path), &args.version)?.join(
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

/// Removes a specific input binding of an action from the user's actionmaps.xml.
#[tauri::command]
pub async fn remove_binding(args: RemoveBindingArgs) -> Result<(), String> {
    let p = sc_base_dir(&expand_tilde(&args.game_path), &args.version)?.join(
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
