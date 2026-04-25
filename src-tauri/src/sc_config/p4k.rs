use super::*;

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
    let p = sc_base_dir(&game_path, &version)?.join("Data.p4k");
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
///
/// When `replace_existing` is true and the target already has a Data.p4k,
/// it is removed first.
///
/// **Partial-failure note:** When `replace_existing` is true, the existing target
/// is removed before the new file is copied. If the copy then fails, the original
/// target is NOT restored. Callers should ask the user to confirm the replace
/// before invoking with `replace_existing = true`.
#[tauri::command]
pub async fn copy_data_p4k(
    gp: String,
    source_version: String,
    target_version: String,
    replace_existing: bool,
    _window: tauri::Window,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    let base = get_sc_base_path(&gp)?;

    let source = base.join(&source_version).join("Data.p4k");
    let target = base.join(&target_version).join("Data.p4k");

    if !source.exists() {
        return Err(format!("Source Data.p4k not found at {}", source.display()));
    }

    let target_present = std::fs::symlink_metadata(&target).is_ok();
    if target_present {
        if !replace_existing {
            return Err("Target already has Data.p4k".to_string());
        }
        fs::remove_file(&target)
            .map_err(|e| format!("Failed to remove existing target: {}", e))?;
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

/// Outcome of attempting an in-place move.
///
/// `Renamed` means `fs::rename` succeeded (same-filesystem, atomic, instant).
/// `CrossFilesystem` means the rename failed because the paths are on
/// different filesystems and the caller must fall back to copy + delete.
#[derive(Debug)]
#[allow(dead_code)] // pub API consumed by move_data_p4k Tauri command (Task 4)
pub enum MoveOutcome {
    Renamed,
    CrossFilesystem,
}

/// Moves a Data.p4k file from `source` to `target`, optionally replacing an
/// existing target. Pure filesystem logic — no Tauri events, no progress.
///
/// Returns `MoveOutcome::Renamed` on same-filesystem success, or
/// `MoveOutcome::CrossFilesystem` if the caller must fall back to copy-with-progress.
///
/// The source is left intact when this returns `CrossFilesystem` — the caller
/// is responsible for deleting it after a successful copy.
#[allow(dead_code)] // called by move_data_p4k Tauri command (Task 4)
pub fn move_data_p4k_inner(
    source: &Path,
    target: &Path,
    replace_existing: bool,
) -> Result<MoveOutcome, String> {
    // Use symlink_metadata so symlinks are detected without following them
    if std::fs::symlink_metadata(source).is_err() {
        return Err(format!("Source Data.p4k not found at {}", source.display()));
    }

    let target_present = std::fs::symlink_metadata(target).is_ok();
    if target_present {
        if !replace_existing {
            return Err("Target already has Data.p4k".to_string());
        }
        fs::remove_file(target)
            .map_err(|e| format!("Failed to remove existing target: {}", e))?;
    }

    if let Some(parent) = target.parent() {
        if !parent.exists() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create target parent: {}", e))?;
        }
    }

    match fs::rename(source, target) {
        Ok(()) => Ok(MoveOutcome::Renamed),
        // EXDEV = 18 on Linux: cross-device rename not permitted
        Err(e) if e.raw_os_error() == Some(18) => Ok(MoveOutcome::CrossFilesystem),
        Err(e) => Err(format!("Failed to move Data.p4k: {}", e)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::tempdir;

    fn make_p4k(path: &Path, contents: &[u8]) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let mut f = std::fs::File::create(path).unwrap();
        f.write_all(contents).unwrap();
    }

    #[test]
    fn move_inner_same_fs_succeeds_when_target_empty() {
        let dir = tempdir().unwrap();
        let src = dir.path().join("LIVE/Data.p4k");
        let dst = dir.path().join("PTU/Data.p4k");
        make_p4k(&src, b"payload");
        std::fs::create_dir_all(dst.parent().unwrap()).unwrap();

        let outcome = move_data_p4k_inner(&src, &dst, false).unwrap();

        assert!(matches!(outcome, MoveOutcome::Renamed));
        assert!(!src.exists(), "source should be gone");
        assert!(dst.exists(), "target should exist");
        assert_eq!(std::fs::read(&dst).unwrap(), b"payload");
    }

    #[test]
    fn move_inner_rejects_when_target_exists_without_replace() {
        let dir = tempdir().unwrap();
        let src = dir.path().join("LIVE/Data.p4k");
        let dst = dir.path().join("PTU/Data.p4k");
        make_p4k(&src, b"new");
        make_p4k(&dst, b"old");

        let err = move_data_p4k_inner(&src, &dst, false).unwrap_err();

        assert!(err.contains("already"), "error: {}", err);
        assert_eq!(std::fs::read(&src).unwrap(), b"new", "source untouched");
        assert_eq!(std::fs::read(&dst).unwrap(), b"old", "target untouched");
    }

    #[test]
    fn move_inner_replaces_when_flag_set() {
        let dir = tempdir().unwrap();
        let src = dir.path().join("LIVE/Data.p4k");
        let dst = dir.path().join("PTU/Data.p4k");
        make_p4k(&src, b"new");
        make_p4k(&dst, b"old");

        let outcome = move_data_p4k_inner(&src, &dst, true).unwrap();

        assert!(matches!(outcome, MoveOutcome::Renamed));
        assert!(!src.exists());
        assert_eq!(std::fs::read(&dst).unwrap(), b"new");
    }

    #[test]
    fn move_inner_rejects_missing_source() {
        let dir = tempdir().unwrap();
        let src = dir.path().join("LIVE/Data.p4k");
        let dst = dir.path().join("PTU/Data.p4k");

        let err = move_data_p4k_inner(&src, &dst, false).unwrap_err();
        assert!(err.contains("not found"), "error: {}", err);
    }

    #[test]
    fn move_inner_creates_target_parent_dir() {
        let dir = tempdir().unwrap();
        let src = dir.path().join("LIVE/Data.p4k");
        let dst = dir.path().join("BRAND_NEW/Data.p4k");
        make_p4k(&src, b"payload");

        move_data_p4k_inner(&src, &dst, false).unwrap();

        assert!(dst.exists());
    }

    #[cfg(unix)]
    #[test]
    fn move_inner_moves_symlink_without_following() {
        let dir = tempdir().unwrap();
        let real = dir.path().join("real.p4k");
        let src = dir.path().join("LIVE/Data.p4k");
        let dst = dir.path().join("PTU/Data.p4k");
        make_p4k(&real, b"underlying");
        std::fs::create_dir_all(src.parent().unwrap()).unwrap();
        std::os::unix::fs::symlink(&real, &src).unwrap();

        move_data_p4k_inner(&src, &dst, false).unwrap();

        assert!(!std::fs::symlink_metadata(&src).is_ok(), "source symlink gone");
        assert!(std::fs::symlink_metadata(&dst).unwrap().file_type().is_symlink(), "target is symlink");
        assert!(real.exists(), "underlying file untouched");
        assert_eq!(std::fs::read(&dst).unwrap(), b"underlying", "symlink resolves");
    }
}
