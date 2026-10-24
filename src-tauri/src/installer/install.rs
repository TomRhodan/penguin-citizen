use crate::config::AppConfig;
use crate::runners::resolve_wine_bin;
use crate::util::{ clean_appimage_env, expand_tilde, http_client };
use serde::Deserialize;
use std::path::Path;
use std::process::{ Command, Stdio };
use std::sync::atomic::Ordering;
use tauri::{ AppHandle, Emitter };

use super::{
    configure_wine_env, emit_progress, emit_progress_tick, is_cancelled, stream_command_output,
    GAME_PID, INSTALL_CANCEL, LAST_RUNNER_DIR,
};

/// Performs the full installation of Star Citizen.
///
/// The installation process consists of six phases:
/// - Phase 1 (0-5%):   Prepare environment, download Winetricks
/// - Phase 2 (5-45%):  Run Winetricks verbs (win11, fonts, PowerShell)
/// - Phase 3 (45-60%): Download and install DXVK from GitHub
/// - Phase 4 (60-65%): Configure Windows registry
/// - Phase 5 (65-95%): Download and install RSI Launcher (skipped in quick mode)
/// - Phase 6 (95-100%): Launch RSI Launcher
///
/// Can be cancelled at any time via `cancel_installation()`.
/// In "quick" mode only phases 1-4 + 6 are executed (launcher download is skipped).
#[tauri::command]
pub async fn run_installation(app: AppHandle, config: AppConfig) -> Result<(), String> {
    // Reset cancellation flag for a new installation
    INSTALL_CANCEL.store(false, Ordering::SeqCst);

    // The frontend may not pass all fields (e.g. github_token or install_mode).
    // In that case, load the missing values from the saved configuration file.
    let config = if config.github_token.is_none() || config.install_mode.is_empty() {
        if let Ok(Some(saved)) = crate::config::load_config().await {
            AppConfig {
                github_token: if config.github_token.is_none() {
                    saved.github_token
                } else {
                    config.github_token
                },
                install_mode: if config.install_mode.is_empty() {
                    saved.install_mode
                } else {
                    config.install_mode
                },
                ..config
            }
        } else {
            config
        }
    } else {
        config
    };

    let install_path = expand_tilde(&config.install_path);
    // In quick mode the RSI Launcher download is skipped (phases 4/5)
    let skip_launcher = config.install_mode == "quick";

    // In quick mode, verify that the RSI Launcher already exists
    if skip_launcher {
        let launcher_exe = Path::new(&install_path)
            .join("drive_c")
            .join("Program Files")
            .join("Roberts Space Industries")
            .join("RSI Launcher")
            .join("RSI Launcher.exe");
        if !launcher_exe.exists() {
            return Err(
                "Quick Install selected but RSI Launcher not found. Please use Full Installation.".into()
            );
        }
    }

    // Installation runs Wine via the active profile's runner. We don't honor
    // the global fallback here — installation is a deliberate setup step,
    // not a launch, and a missing runner should surface as an explicit error.
    if config.launch_working_state.runner_name.is_empty() {
        return Err("No runner selected. Pick a Wine runner on the Launch page first.".to_string());
    }
    let runner_name = config.launch_working_state.runner_name.as_str();

    let runner_dir = crate::runners::runner_dir(&install_path, runner_name);
    let wine = resolve_wine_bin(&runner_dir)
        .ok_or_else(|| format!("Wine binary not found in {}", runner_dir.display()))?;
    *LAST_RUNNER_DIR.lock().unwrap_or_else(|e| e.into_inner()) = Some(runner_dir.clone());
    let runner_bin = wine.parent()
        .ok_or_else(|| "Wine binary has no parent directory".to_string())?
        .to_path_buf();
    let wineserver = runner_bin.join("wineserver");

    // ── Phase 1: Prepare environment (0-5%) ──
    // Note: In quick mode phases 1-4 + 6 are executed, phases 4/5 (RSI Launcher) are skipped

    // Temporary directory for downloads and intermediate files
    let tmp_dir = Path::new(&install_path).join(".tmp");
    let client = http_client();

    emit_progress(&app, "prepare", "Preparing environment...", 0.0, "Starting installation...");

    // Create Wine prefix directory structure
    let live_dir = Path::new(&install_path).join("drive_c");

    std::fs
        ::create_dir_all(&install_path)
        .map_err(|e| format!("Failed to create install directory: {}", e))?;
    std::fs
        ::create_dir_all(&live_dir)
        .map_err(|e| format!("Failed to create drive_c directory: {}", e))?;
    std::fs
        ::create_dir_all(&tmp_dir)
        .map_err(|e| format!("Failed to create .tmp directory: {}", e))?;

    // Create marker file early so Winetricks skips the 64-bit warning
    let marker = Path::new(&install_path).join("no_win64_warnings");
    let _ = std::fs::write(&marker, "");

    // Kill remaining wineservers from previous installation attempts
    emit_progress(
        &app,
        "prepare",
        "Cleaning up old processes...",
        1.0,
        "Killing any lingering wineserver..."
    );
    let _ = Command::new(wineserver.to_string_lossy().as_ref())
        .arg("-k")
        .env("WINEPREFIX", &install_path)
        .output();

    emit_progress(&app, "prepare", "Downloading winetricks...", 2.0, "Downloading winetricks...");

    // Download pinned Winetricks version with SHA-256 integrity verification
    let winetricks_path = crate::util::download_winetricks(&tmp_dir).await?;

    // Ephemeral winetricks verb cache. Without it winetricks falls back to
    // ~/.cache/winetricks, where a stale entry keeps serving an outdated
    // PowerShell and fails the prefix with "SHA256 mismatch" or "no valid
    // cabinets found" (LUG knowledge base, Install & Update Problems).
    let winetricks_cache = tmp_dir.join("winetricks-cache");
    let _ = std::fs::remove_dir_all(&winetricks_cache);
    std::fs
        ::create_dir_all(&winetricks_cache)
        .map_err(|e| format!("Failed to create winetricks cache directory: {}", e))?;

    emit_progress(&app, "prepare", "Environment ready", 5.0, "Environment prepared successfully");

    if is_cancelled() {
        return Err("Installation cancelled".into());
    }

    // ── Phase 2: Run Winetricks verbs (5-45%) ──
    // DXVK is NOT installed via Winetricks (provides outdated versions).
    // Instead, DXVK is downloaded directly from GitHub in phase 3.
    // win11: Set Windows 11 compatibility mode
    // arial/tahoma: Fonts needed for display in the RSI Launcher
    // powershell: Required by the RSI Launcher for certain operations
    let verbs = ["win11", "arial", "tahoma", "powershell"];
    let verb_count = verbs.len() as f64;

    for (i, verb) in verbs.iter().enumerate() {
        if is_cancelled() {
            return Err("Installation cancelled".into());
        }

        let step_label = format!("Installing {}...", verb);
        let base_percent = 5.0 + ((i as f64) / verb_count) * 40.0;

        // Kill wineserver before each verb to avoid hangs from lingering processes
        let mut ws_cmd = Command::new(wineserver.to_string_lossy().as_ref());
        ws_cmd.arg("-k").env("WINEPREFIX", &install_path);
        clean_appimage_env(&mut ws_cmd);
        let _ = ws_cmd.output();

        emit_progress(
            &app,
            "winetricks",
            &step_label,
            base_percent,
            &format!("Running: winetricks -q {}", verb)
        );

        let mut wt_cmd = Command::new(winetricks_path.to_string_lossy().as_ref());
        wt_cmd
            .args(["-q", verb])
            .env("WINEPREFIX", &install_path)
            .env("WINE", wine.to_string_lossy().as_ref())
            .env("WINESERVER", wineserver.to_string_lossy().as_ref())
            .env("WINEDLLOVERRIDES", "winemenubuilder.exe=d;winedbg.exe=d")
            .env("WINEDEBUG", "-all")
            .env("W_CACHE", winetricks_cache.to_string_lossy().as_ref())
            // Winetricks prefers wget, which is missing inside our AppImage and
            // on immutable distros. curl is a hard dependency of this app.
            .env("WINETRICKS_DOWNLOADER", "curl")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        clean_appimage_env(&mut wt_cmd);
        let mut child = wt_cmd
            .spawn()
            .map_err(|e| format!("Failed to run winetricks {}: {}", verb, e))?;

        stream_command_output(&app, "winetricks", &step_label, base_percent, &mut child);

        let status = child
            .wait()
            .map_err(|e| format!("Failed to wait for winetricks {}: {}", verb, e))?;

        if !status.success() {
            emit_progress(
                &app,
                "error",
                &format!("winetricks {} failed", verb),
                base_percent,
                &format!("winetricks {} exited with code {:?}", verb, status.code())
            );
            return Err(format!("winetricks {} failed with exit code {:?}", verb, status.code()));
        }

        let done_percent = 5.0 + (((i + 1) as f64) / verb_count) * 40.0;
        emit_progress(
            &app,
            "winetricks",
            &format!("{} installed", verb),
            done_percent,
            &format!("Completed: {}", verb)
        );
    }

    if is_cancelled() {
        return Err("Installation cancelled".into());
    }

    // ── Phase 3: Install DXVK (45-60%) ──
    // DXVK translates Direct3D 9/10/11 calls to Vulkan - essential for
    // graphics performance on Linux since Vulkan communicates directly with the GPU.
    emit_progress(
        &app,
        "dxvk",
        "Installing DXVK...",
        45.0,
        "Fetching latest DXVK release from GitHub..."
    );

    // Kill wineserver before DXVK installation
    let _ = Command::new(wineserver.to_string_lossy().as_ref())
        .arg("-k")
        .env("WINEPREFIX", &install_path)
        .output();

    // Fetch latest DXVK version from the GitHub API
    let dxvk_url = "https://api.github.com/repos/doitsujin/dxvk/releases/latest";
    let mut dxvk_request = client.get(dxvk_url);

    // Use GitHub token if available (increases API rate limit from 60 to 5000/hour)
    if let Some(ref token) = config.github_token {
        dxvk_request = dxvk_request.header("Authorization", format!("Bearer {}", token));
    }

    let dxvk_resp = dxvk_request
        .send().await
        .map_err(|e| format!("Failed to fetch DXVK release: {}", e))?;

    let dxvk_status = dxvk_resp.status();
    if !dxvk_status.is_success() {
        if dxvk_status.as_u16() == 403 || dxvk_status.as_u16() == 429 {
            return Err("GitHub API rate limit reached. Add a GitHub token in Settings to increase the limit.".into());
        }
        return Err(format!("GitHub API returned {} for DXVK", dxvk_status));
    }

    /// A GitHub release object from the GitHub Releases API.
    #[derive(Deserialize)]
    struct GhRelease {
        /// Release tag (e.g. "v2.5.1"), used as the version identifier.
        tag_name: String,
        /// List of downloadable assets attached to this release.
        assets: Vec<GhAsset>,
    }
    /// A single downloadable asset within a GitHub release.
    #[derive(Deserialize)]
    struct GhAsset {
        /// Filename of the asset (e.g. "dxvk-2.5.1.tar.gz").
        name: String,
        /// Direct download URL for the asset.
        browser_download_url: String,
    }

    let release: GhRelease = dxvk_resp
        .json().await
        .map_err(|e| format!("Failed to parse DXVK release: {}", e))?;

    // Find the .tar.gz archive from the release assets (contains the DXVK DLLs)
    let dxvk_asset = release.assets
        .iter()
        .find(|a| a.name.ends_with(".tar.gz"))
        .ok_or("No .tar.gz asset found in DXVK release")?;

    let dxvk_version = release.tag_name.clone();
    emit_progress(
        &app,
        "dxvk",
        "Downloading DXVK...",
        47.0,
        &format!("Downloading DXVK {}...", dxvk_version)
    );

    // Download DXVK archive
    let mut dxvk_dl_request = client.get(&dxvk_asset.browser_download_url);
    if let Some(ref token) = config.github_token {
        dxvk_dl_request = dxvk_dl_request.header("Authorization", format!("Bearer {}", token));
    }
    let dxvk_dl_resp = dxvk_dl_request
        .send().await
        .map_err(|e| format!("Failed to download DXVK: {}", e))?;
    // Without this an error page would be written out as dxvk.tar.gz and only
    // fail later, during extraction, with an unrelated message.
    if !dxvk_dl_resp.status().is_success() {
        return Err(format!("DXVK download failed with status: {}", dxvk_dl_resp.status()));
    }
    let dxvk_bytes = dxvk_dl_resp
        .bytes().await
        .map_err(|e| format!("Failed to read DXVK download: {}", e))?;

    let dxvk_archive_path = tmp_dir.join("dxvk.tar.gz");
    std::fs
        ::write(&dxvk_archive_path, &dxvk_bytes)
        .map_err(|e| format!("Failed to save DXVK archive: {}", e))?;

    emit_progress(&app, "dxvk", "Extracting DXVK...", 52.0, "Extracting DXVK archive...");

    // Extract archive (tar.gz -> directory with x32/ and x64/ subdirectories)
    let extract_dir = tmp_dir.join("dxvk-extract");
    std::fs
        ::create_dir_all(&extract_dir)
        .map_err(|e| format!("Failed to create extract dir: {}", e))?;

    {
        let file = std::fs::File
            ::open(&dxvk_archive_path)
            .map_err(|e| format!("Failed to open DXVK archive: {}", e))?;
        let decoder = flate2::read::GzDecoder::new(file);
        let mut archive = tar::Archive::new(decoder);
        crate::util::safe_unpack(&mut archive, &extract_dir).map_err(|e| format!("Failed to extract DXVK: {}", e))?;
    }

    emit_progress(&app, "dxvk", "Installing DXVK DLLs...", 55.0, "Copying DLLs to Wine prefix...");

    // Find extracted directory (typically dxvk-X.Y.Z/ within the archive)
    let dxvk_inner = std::fs
        ::read_dir(&extract_dir)
        .map_err(|e| format!("Failed to read extract dir: {}", e))?
        .filter_map(|e| e.ok())
        .find(|e| e.path().is_dir())
        .map(|e| e.path())
        .unwrap_or(extract_dir.clone());

    // The four DXVK DLLs that replace Direct3D with Vulkan
    let dll_names = ["d3d9.dll", "d3d10core.dll", "d3d11.dll", "dxgi.dll"];

    // Copy 64-bit DLLs to system32 (Wine uses system32 for 64-bit libraries)
    let sys32 = Path::new(&install_path).join("drive_c").join("windows").join("system32");
    std::fs::create_dir_all(&sys32).ok();
    let x64_dir = dxvk_inner.join("x64");
    if x64_dir.is_dir() {
        for name in &dll_names {
            let src = x64_dir.join(name);
            if src.exists() {
                let _ = std::fs::copy(&src, sys32.join(name));
            }
        }
    }

    // Copy 32-bit DLLs to syswow64 (Wine uses syswow64 for 32-bit libraries in a 64-bit prefix)
    let syswow64 = Path::new(&install_path).join("drive_c").join("windows").join("syswow64");
    std::fs::create_dir_all(&syswow64).ok();
    let x32_dir = dxvk_inner.join("x32");
    if x32_dir.is_dir() {
        for name in &dll_names {
            let src = x32_dir.join(name);
            if src.exists() {
                let _ = std::fs::copy(&src, syswow64.join(name));
            }
        }
    }

    // Register DLL overrides in the Wine registry so Wine uses the native
    // DXVK DLLs instead of the built-in Wine implementations
    emit_progress(
        &app,
        "dxvk",
        "Registering DXVK DLLs...",
        57.0,
        "Setting DLL overrides in registry..."
    );
    for name in &["d3d9", "d3d10core", "d3d11", "dxgi"] {
        // The exit status was dropped entirely, so a DLL override that failed to
        // register left DXVK silently inactive with nothing in the log.
        let reg_status = Command::new(wine.to_string_lossy().as_ref())
            .args([
                "reg",
                "add",
                "HKEY_CURRENT_USER\\Software\\Wine\\DllOverrides",
                "/v",
                name,
                "/d",
                "native",
                "/f",
            ])
            .env("WINEPREFIX", &install_path)
            .env("WINEDLLOVERRIDES", "winemenubuilder.exe=d;winedbg.exe=d")
            .env("WINEDEBUG", "-all")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
        match reg_status {
            Ok(st) if st.success() => {}
            Ok(st) => log::warn!("DXVK DllOverride for {} returned {:?}", name, st.code()),
            Err(e) => log::warn!("DXVK DllOverride for {} could not be set: {}", name, e),
        }
    }

    // Write version marker so future installations can detect
    // which DXVK version is currently installed
    let dxvk_marker = Path::new(&install_path).join(".dxvk_version");
    let _ = std::fs::write(&dxvk_marker, &dxvk_version);

    // Clean up temporary DXVK files
    let _ = std::fs::remove_file(&dxvk_archive_path);
    let _ = std::fs::remove_dir_all(&extract_dir);

    emit_progress(
        &app,
        "dxvk",
        "DXVK installed",
        60.0,
        &format!("DXVK {} installed successfully", dxvk_version)
    );

    if is_cancelled() {
        return Err("Installation cancelled".into());
    }

    // ── Phase 4: Configure registry (60-65%) ──
    // Disable file associations so Wine doesn't create .desktop files
    // and MIME type associations on the Linux host
    emit_progress(&app, "registry", "Configuring registry...", 60.0, "Setting registry keys...");

    let mut reg_child = Command::new(wine.to_string_lossy().as_ref())
        .args([
            "reg",
            "add",
            "HKEY_CURRENT_USER\\Software\\Wine\\FileOpenAssociations",
            "/v",
            "Enable",
            "/d",
            "N",
            "/f",
        ])
        .env("WINEPREFIX", &install_path)
        .env("WINEDLLOVERRIDES", "winemenubuilder.exe=d;winedbg.exe=d")
        .env("WINEDEBUG", "-all")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to run wine reg: {}", e))?;

    stream_command_output(&app, "registry", "Setting registry keys...", 62.0, &mut reg_child);

    let reg_status = reg_child.wait().map_err(|e| format!("Failed to wait for wine reg: {}", e))?;

    if !reg_status.success() {
        emit_progress(
            &app,
            "registry",
            "Registry warning",
            63.0,
            "Registry key set returned non-zero (continuing anyway)"
        );
    }

    emit_progress(&app, "registry", "Registry configured", 64.0, "Registry configuration complete");

    // Kill wineserver after registry configuration so no
    // remaining Wine processes keep pipe handles open and
    // block the subsequent asynchronous download phase
    let _ = Command::new(wineserver.to_string_lossy().as_ref())
        .arg("-k")
        .env("WINEPREFIX", &install_path)
        .output();
    std::thread::sleep(std::time::Duration::from_secs(1));

    emit_progress(&app, "registry", "Registry complete", 65.0, "Wine processes cleaned up");

    if is_cancelled() {
        return Err("Installation cancelled".into());
    }

    // ── Phase 4 & 5: Download & install RSI Launcher (65-95%) ──
    // Skip in quick mode (RSI Launcher already exists)
    if skip_launcher {
        emit_progress(
            &app,
            "launcher_skip",
            "Skipping RSI Launcher...",
            65.0,
            "Quick Install: RSI Launcher already exists, skipping download and install"
        );
    } else {
        // ── Phase 4: Download RSI Launcher (65-85%) ──
        emit_progress(
            &app,
            "download",
            "Fetching launcher info...",
            65.0,
            "Downloading latest.yml..."
        );

        // Download latest.yml from RSI - names the current installer and its digest
        let latest_resp = client
            .get("https://install.robertsspaceindustries.com/rel/2/latest.yml")
            .send().await
            .map_err(|e| format!("Failed to fetch latest.yml: {}", e))?;
        // A 4xx/5xx body would otherwise be parsed as if it were the manifest.
        if !latest_resp.status().is_success() {
            return Err(format!("Fetching latest.yml failed with status: {}", latest_resp.status()));
        }
        let latest_yml = latest_resp
            .text().await
            .map_err(|e| format!("Failed to read latest.yml: {}", e))?;

        let manifest = parse_latest_yml(&latest_yml)?;
        let installer_filename = manifest.filename.clone();

        let download_url =
            format!("https://install.robertsspaceindustries.com/rel/2/{}", installer_filename);

        emit_progress(
            &app,
            "download",
            "Downloading RSI Launcher...",
            67.0,
            &format!("Downloading {}", installer_filename)
        );

        // Download RSI Launcher installer (~320 MB). Uses the shared helper with
        // automatic retry + Range-based resume so a transient CDN reset or stall
        // near the end of this long transfer no longer fails the install (#8).
        let installer_path = tmp_dir.join(&installer_filename);

        let mut last_emit = std::time::Instant::now();
        let dl_result = crate::util::download_to_file(
            &download_url,
            &installer_path,
            |downloaded, total_bytes| {
                // Limit progress messages to at most one per 500ms to avoid
                // flooding the frontend with events.
                let is_complete = total_bytes > 0 && downloaded >= total_bytes;
                if is_complete || last_emit.elapsed() >= std::time::Duration::from_millis(500) {
                    let dl_percent = if total_bytes > 0 {
                        65.0 + ((downloaded as f64) / (total_bytes as f64)) * 20.0
                    } else {
                        75.0
                    };
                    let status_msg = if total_bytes > 0 {
                        format!(
                            "Downloading... {:.1} MB / {:.1} MB",
                            (downloaded as f64) / 1_048_576.0,
                            (total_bytes as f64) / 1_048_576.0
                        )
                    } else {
                        format!("Downloading... {:.1} MB", (downloaded as f64) / 1_048_576.0)
                    };
                    // Tick: repeats twice a second, the byte counter adds
                    // nothing to a post-mortem log
                    emit_progress_tick(
                        &app,
                        "download",
                        "Downloading RSI Launcher...",
                        dl_percent,
                        &status_msg
                    );
                    last_emit = std::time::Instant::now();
                }
            },
            is_cancelled,
        ).await;

        match dl_result {
            Ok(()) => {}
            Err(crate::util::DownloadError::Cancelled) => {
                let _ = tokio::fs::remove_file(&installer_path).await;
                return Err("Installation cancelled".into());
            }
            Err(crate::util::DownloadError::Failed(msg)) => {
                let _ = tokio::fs::remove_file(&installer_path).await;
                return Err(format!("Download stream error: {}", msg));
            }
        }

        // Supply-chain check: the installer is executed under Wine right after
        // this, so it is verified against the digest RSI published for it before
        // it ever runs. A mismatched file is removed, not kept for a retry.
        emit_progress(
            &app,
            "download",
            "Verifying download...",
            84.0,
            "Checking the installer against RSI's SHA-512"
        );
        if let Err(e) = verify_sha512_base64(&installer_path, &manifest.sha512_base64) {
            let _ = tokio::fs::remove_file(&installer_path).await;
            log::error!("RSI Launcher installer verification failed: {}", e);
            return Err(e);
        }
        log::info!("RSI Launcher installer verified against latest.yml sha512");

        emit_progress(
            &app,
            "download",
            "Download complete",
            85.0,
            "RSI Launcher downloaded and verified"
        );

        if is_cancelled() {
            return Err("Installation cancelled".into());
        }

        // ── Phase 5: Install RSI Launcher (85-95%) ──
        emit_progress(
            &app,
            "install",
            "Installing RSI Launcher...",
            85.0,
            &format!("Running: wine {} /S", installer_filename)
        );

        // The NSIS installer with /S (Silent Mode) automatically launches the RSI Launcher
        // as a child process. Its output goes to a *file*, not a pipe: a pipe handle
        // would be inherited by the launcher the installer spawns and keep this
        // process waiting on it. Discarding it entirely (as this did until 0.5.16)
        // left a failed install with nothing at all in debug.log.
        // try_wait() with timeout is used because the NSIS process may not
        // exit until the RSI Launcher it spawned exits
        // (Wine keeps the parent process alive).
        //
        // dxwebsetup.exe and dotNetFx45_Full_setup.exe are the redistributable
        // sub-installers bundled inside the launcher setup. Disabling them
        // matches the LUG reference install (`lug-helper.sh`), which stops them
        // from running under Wine where they only stall the silent install.
        let installer_log_path = tmp_dir.join("rsi-installer-output.log");
        let (installer_out, installer_err) = match
            std::fs::File
                ::options()
                .create(true)
                .truncate(true)
                .write(true)
                .open(&installer_log_path)
        {
            // One file for both streams keeps the output chronologically ordered.
            Ok(file) => {
                let dup = file.try_clone().ok();
                match dup {
                    Some(d) => (Stdio::from(file), Stdio::from(d)),
                    None => (Stdio::from(file), Stdio::null()),
                }
            }
            Err(e) => {
                log::warn!(
                    "Could not open {} for installer output ({}); falling back to /dev/null",
                    installer_log_path.display(),
                    e
                );
                (Stdio::null(), Stdio::null())
            }
        };

        let mut install_child = Command::new(wine.to_string_lossy().as_ref())
            .arg(installer_path.to_string_lossy().as_ref())
            .arg("/S")
            .env("WINEPREFIX", &install_path)
            .env(
                "WINEDLLOVERRIDES",
                "dxwebsetup.exe,dotNetFx45_Full_setup.exe,winemenubuilder.exe=d;winedbg.exe=d"
            )
            .env("WINEDEBUG", "-all")
            .stdout(installer_out)
            .stderr(installer_err)
            .spawn()
            .map_err(|e| format!("Failed to run RSI Launcher installer: {}", e))?;

        emit_progress(
            &app,
            "install",
            "Installing RSI Launcher...",
            88.0,
            "Waiting for installer to finish..."
        );

        // Monitor installer with timeout - the NSIS installer may block
        // because it waits for its child process (RSI Launcher)
        let install_timeout = std::time::Duration::from_secs(120);
        let install_start = std::time::Instant::now();
        let mut timed_out = false;

        loop {
            match install_child.try_wait() {
                Ok(Some(status)) => {
                    if !status.success() {
                        emit_progress(
                            &app,
                            "install",
                            "Install warning",
                            92.0,
                            &format!(
                                "Installer exited with code {:?} (may be normal)",
                                status.code()
                            )
                        );
                    }
                    break;
                }
                Ok(None) => {
                    // Check whether the RSI Launcher .exe has already been installed
                    // (installer is done but hasn't exited the process yet)
                    let launcher_exe = Path::new(&install_path).join(
                        "drive_c/Program Files/Roberts Space Industries/RSI Launcher/RSI Launcher.exe"
                    );
                    if
                        install_start.elapsed() > std::time::Duration::from_secs(15) &&
                        launcher_exe.exists()
                    {
                        emit_progress(
                            &app,
                            "install",
                            "Installing RSI Launcher...",
                            92.0,
                            "RSI Launcher installed, stopping installer process..."
                        );
                        let _ = install_child.kill();
                        let _ = install_child.wait();
                        timed_out = true;
                        break;
                    }

                    if install_start.elapsed() > install_timeout {
                        emit_progress(
                            &app,
                            "install",
                            "Install timeout",
                            92.0,
                            "Installer timed out, killing process..."
                        );
                        let _ = install_child.kill();
                        let _ = install_child.wait();
                        timed_out = true;
                        break;
                    }

                    std::thread::sleep(std::time::Duration::from_secs(1));
                    let elapsed = install_start.elapsed().as_secs();
                    // Tick: one per second, and the wait duration is already
                    // visible from the surrounding log timestamps
                    emit_progress_tick(
                        &app,
                        "install",
                        "Installing RSI Launcher...",
                        88.0 + ((elapsed as f64) / 120.0) * 4.0,
                        &format!("Waiting for installer... ({}s)", elapsed)
                    );
                }
                Err(e) => {
                    emit_progress(
                        &app,
                        "install",
                        "Install warning",
                        92.0,
                        &format!("Could not check installer status: {}", e)
                    );
                    break;
                }
            }
        }

        log_installer_output(&installer_log_path);

        if timed_out {
            emit_progress(
                &app,
                "install",
                "Cleaning up...",
                93.0,
                "Killing Wine processes from installer..."
            );
        } else {
            emit_progress(
                &app,
                "install",
                "Cleaning up...",
                93.0,
                "Stopping installer-spawned processes..."
            );
        }

        // Kill wineserver to stop all processes automatically started by the installer
        let _ = Command::new(wineserver.to_string_lossy().as_ref())
            .arg("-k")
            .env("WINEPREFIX", &install_path)
            .output();

        // Give wineserver a moment to shut down all processes
        std::thread::sleep(std::time::Duration::from_secs(2));

        // The RSI Launcher sometimes fails to create its LIVE directory, which
        // then breaks the first game install. The LUG reference install works
        // around this the same way (`mkdir -p "${game_path}/LIVE"`).
        let live_dir = Path::new(&install_path)
            .join("drive_c")
            .join("Program Files")
            .join("Roberts Space Industries")
            .join("StarCitizen")
            .join("LIVE");
        if let Err(e) = std::fs::create_dir_all(&live_dir) {
            log::warn!("Could not create LIVE directory {}: {}", live_dir.display(), e);
        }

        emit_progress(
            &app,
            "install",
            "Installation complete",
            95.0,
            "RSI Launcher installed successfully"
        );
    } // End of non-quick mode (phases 4/5)

    // Clean up temporary directory (only relevant in non-quick mode
    // where installer and other temporary files were created)
    if !skip_launcher {
        let _ = std::fs::remove_dir_all(&tmp_dir);
    }

    if is_cancelled() {
        return Err("Installation cancelled".into());
    }

    // ── Phase 6: Launch game (95-100%) ──
    // After successful installation the RSI Launcher is started directly
    // so the user doesn't have to manually switch to the launch page
    emit_progress(
        &app,
        "launch",
        "Launching RSI Launcher...",
        95.0,
        "Preparing launch environment..."
    );

    let mut cmd = Command::new(wine.to_string_lossy().as_ref());
    cmd.arg("C:\\Program Files\\Roberts Space Industries\\RSI Launcher\\RSI Launcher.exe");

    let _ = configure_wine_env(&mut cmd, &install_path, &config.launch_working_state.performance, "info");

    cmd.stdout(Stdio::null()).stderr(Stdio::null());

    let mut child = cmd.spawn().map_err(|e| format!("Failed to launch RSI Launcher: {}", e))?;

    let pid = child.id();

    // Store PID so the launch page and stop_game know a process is running
    *GAME_PID.lock().unwrap_or_else(|e| e.into_inner()) = Some((pid, install_path.clone()));

    let _ = app.emit("launch-started", "RSI Launcher process started");
    let _ = app.emit("launch-log", &format!("> RSI Launcher started (PID: {})", pid));

    emit_progress(&app, "complete", "RSI Launcher started", 100.0, "RSI Launcher is now running");

    // Monitor child process in the background - send exit event when terminated
    let bg_app = app.clone();
    std::thread::spawn(move || {
        let status = child.wait();
        let code = status.ok().and_then(|s| s.code());

        *GAME_PID.lock().unwrap_or_else(|e| e.into_inner()) = None;

        let _ = bg_app.emit("launch-log", &format!("> RSI Launcher exited (code: {:?})", code));
        let _ = bg_app.emit("launch-exited", code.unwrap_or(-1));
    });

    Ok(())
}

/// Cancels the running installation.
/// Sets the global cancellation flag that is checked at multiple points in the
/// installation process. The installation will terminate cleanly at the next checkpoint.
#[tauri::command]
pub fn cancel_installation() -> bool {
    INSTALL_CANCEL.store(true, Ordering::SeqCst);
    true
}

/// Copies whatever the RSI Launcher installer wrote on stdout/stderr into
/// `debug.log`.
///
/// The silent NSIS install used to run with both streams on `/dev/null`, so a
/// failed install left no trace at all - which is precisely the case that ends
/// up in a bug report. The output is bounded: NSIS is terse, but a Wine build
/// that decides to be chatty must not fill the log, so only the last
/// `MAX_INSTALLER_LOG_LINES` lines are kept.
fn log_installer_output(path: &Path) {
    const MAX_INSTALLER_LOG_LINES: usize = 200;

    let text = match std::fs::read_to_string(path) {
        Ok(t) => t,
        Err(e) => {
            // Missing file is the normal case when the redirect fell back to null.
            log::debug!("No installer output at {}: {}", path.display(), e);
            return;
        }
    };

    let lines: Vec<&str> = text.lines().filter(|l| !l.trim().is_empty()).collect();
    if lines.is_empty() {
        log::info!("RSI Launcher installer produced no output");
        return;
    }

    let skipped = lines.len().saturating_sub(MAX_INSTALLER_LOG_LINES);
    if skipped > 0 {
        log::info!("RSI Launcher installer output ({} earlier lines omitted):", skipped);
    } else {
        log::info!("RSI Launcher installer output ({} lines):", lines.len());
    }
    for line in lines.iter().skip(skipped) {
        log::info!("  [installer] {}", line);
    }
}

/// The installer entry RSI publishes in `latest.yml`: the file to download and
/// the digest it must have.
///
/// RSI's `latest.yml` is an electron-builder manifest. It repeats the current
/// installer twice - once as a `files:` list entry and once as the top-level
/// `path:`/`sha512:` pair - and both carry the same digest:
///
/// ```text
/// version: 2.18.1
/// files:
///   - url: RSI Launcher-Setup-2.18.1.exe
///     sha512: bbZjaOiH0jVX...
///     size: 345452992
/// path: RSI Launcher-Setup-2.18.1.exe
/// sha512: bbZjaOiH0jVX...
/// ```
///
/// The digest is **base64**, not hex - electron-builder writes the raw 64 bytes
/// of the SHA-512 encoded with the standard alphabet.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct InstallerManifest {
    pub filename: String,
    pub sha512_base64: String,
}

/// Parses the installer filename and its SHA-512 out of RSI's `latest.yml`.
///
/// The top-level `path:`/`sha512:` pair wins; the `files:` entry is the fallback
/// for the day RSI drops the top-level keys. Both halves must be present - a
/// manifest that names a file but no digest is rejected rather than silently
/// installed unverified, because an unverifiable installer is exactly the case
/// this check exists for.
pub(crate) fn parse_latest_yml(yml: &str) -> Result<InstallerManifest, String> {
    // Top-level keys sit at column 0; the `files:` entry's keys are indented.
    let mut top_path: Option<String> = None;
    let mut top_sha: Option<String> = None;
    // First `files:` entry, used only if the top-level pair is incomplete.
    let mut entry_url: Option<String> = None;
    let mut entry_sha: Option<String> = None;

    for line in yml.lines() {
        let indented = line.starts_with(' ') || line.starts_with('\t') || line.trim_start().starts_with('-');
        let trimmed = line.trim();
        let bare = trimmed.strip_prefix('-').map(|s| s.trim()).unwrap_or(trimmed);

        if let Some(val) = bare.strip_prefix("url:") {
            if entry_url.is_none() {
                entry_url = Some(val.trim().to_string());
            }
        } else if let Some(val) = bare.strip_prefix("path:") {
            if !indented {
                top_path = Some(val.trim().to_string());
            }
        } else if let Some(val) = bare.strip_prefix("sha512:") {
            if indented {
                if entry_sha.is_none() {
                    entry_sha = Some(val.trim().to_string());
                }
            } else {
                top_sha = Some(val.trim().to_string());
            }
        }
    }

    // The top-level pair wins; otherwise fall back to the `files:` entry. The
    // two halves are resolved independently so a manifest that still names the
    // installer but has lost its digest reports *that*, rather than claiming the
    // filename is missing.
    let filename = top_path
        .or(entry_url)
        .ok_or("Could not find installer filename in latest.yml")?;
    let sha512_base64 = top_sha
        .or(entry_sha)
        .ok_or("latest.yml names an installer but carries no sha512 digest")?;

    if !filename.ends_with(".exe") {
        return Err(format!("latest.yml points at a non-executable installer: {}", filename));
    }
    if sha512_base64.is_empty() {
        return Err("latest.yml carries an empty sha512 digest".into());
    }

    Ok(InstallerManifest { filename, sha512_base64 })
}

/// Hashes `path` with SHA-512 and compares the result against the base64 digest
/// from `latest.yml`.
///
/// Reads in 1 MiB chunks - the installer is around 320 MB and must not be pulled
/// into memory in one piece.
fn verify_sha512_base64(path: &Path, expected_base64: &str) -> Result<(), String> {
    use base64::{ engine::general_purpose, Engine as _ };
    use sha2::{ Digest, Sha512 };
    use std::io::Read;

    let mut file = std::fs::File
        ::open(path)
        .map_err(|e| format!("Failed to open downloaded installer for verification: {}", e))?;
    let mut hasher = Sha512::new();
    let mut buf = vec![0u8; 1024 * 1024];
    loop {
        let read = file
            .read(&mut buf)
            .map_err(|e| format!("Failed to read downloaded installer: {}", e))?;
        if read == 0 {
            break;
        }
        hasher.update(&buf[..read]);
    }

    let actual = general_purpose::STANDARD.encode(hasher.finalize());
    if actual != expected_base64 {
        return Err(
            format!(
                "Checksum mismatch for the downloaded RSI Launcher installer. \
                 Expected {} but got {}. The file was discarded - retry the installation.",
                expected_base64,
                actual
            )
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Shape of the manifest RSI actually serves (fetched 2026-10-24).
    const REAL_YML: &str =
        "version: 2.18.1\n\
         files:\n  \
           - url: RSI Launcher-Setup-2.18.1.exe\n    \
             sha512: bbZjaOiH0jVXoy9yQgRm6nxCJdBKexMPBT6O5ChP0t/vO46GKItc4Rav7JxmL6nPxZho9CLDIS0u20QaFriBuw==\n    \
             size: 345452992\n\
         path: RSI Launcher-Setup-2.18.1.exe\n\
         sha512: bbZjaOiH0jVXoy9yQgRm6nxCJdBKexMPBT6O5ChP0t/vO46GKItc4Rav7JxmL6nPxZho9CLDIS0u20QaFriBuw==\n\
         releaseDate: '2026-10-05T16:51:50.791Z'\n";

    #[test]
    fn parses_filename_and_digest_from_the_real_manifest() {
        let m = parse_latest_yml(REAL_YML).unwrap();
        assert_eq!(m.filename, "RSI Launcher-Setup-2.18.1.exe");
        assert_eq!(
            m.sha512_base64,
            "bbZjaOiH0jVXoy9yQgRm6nxCJdBKexMPBT6O5ChP0t/vO46GKItc4Rav7JxmL6nPxZho9CLDIS0u20QaFriBuw=="
        );
    }

    #[test]
    fn falls_back_to_the_files_entry_when_the_top_level_pair_is_gone() {
        let yml =
            "version: 9.9.9\nfiles:\n  - url: RSI Launcher-Setup-9.9.9.exe\n    sha512: QUJD\n    size: 1\n";
        let m = parse_latest_yml(yml).unwrap();
        assert_eq!(m.filename, "RSI Launcher-Setup-9.9.9.exe");
        assert_eq!(m.sha512_base64, "QUJD");
    }

    /// An installer we cannot verify must not be installed unverified.
    #[test]
    fn rejects_a_manifest_without_a_digest() {
        let yml = "version: 9.9.9\npath: RSI Launcher-Setup-9.9.9.exe\n";
        let err = parse_latest_yml(yml).unwrap_err();
        assert!(err.contains("sha512"), "unexpected error: {}", err);
    }

    #[test]
    fn rejects_an_empty_digest() {
        let yml = "path: RSI Launcher-Setup-9.9.9.exe\nsha512:\n";
        assert!(parse_latest_yml(yml).is_err());
    }

    #[test]
    fn rejects_a_non_exe_payload() {
        let yml = "path: totally-not-an-installer.sh\nsha512: QUJD\n";
        let err = parse_latest_yml(yml).unwrap_err();
        assert!(err.contains("non-executable"), "unexpected error: {}", err);
    }

    /// A 404 body reaching the parser must fail here, not three steps later.
    #[test]
    fn rejects_an_error_page_instead_of_a_manifest() {
        assert!(parse_latest_yml("404: Not Found").is_err());
        assert!(parse_latest_yml("<html><body>Service Unavailable</body></html>").is_err());
    }

    #[test]
    fn verifies_a_file_against_its_digest() {
        use base64::{ engine::general_purpose, Engine as _ };
        use sha2::{ Digest, Sha512 };

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("payload.bin");
        // Larger than the 1 MiB read buffer, so the chunked loop is exercised.
        let payload = vec![0x5au8; 1024 * 1024 + 4242];
        std::fs::write(&path, &payload).unwrap();

        let expected = general_purpose::STANDARD.encode(Sha512::digest(&payload));
        assert!(verify_sha512_base64(&path, &expected).is_ok());

        let err = verify_sha512_base64(&path, "QUJD").unwrap_err();
        assert!(err.contains("Checksum mismatch"), "unexpected error: {}", err);
    }
}
