use super::*;

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
    let p4k = sc_base_dir(&gp, &v)?.join("Data.p4k");
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
