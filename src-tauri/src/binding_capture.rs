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

//! Input device capture for binding configuration.
//!
//! Uses the gilrs library to listen for joystick/gamepad input events
//! in a background thread. Captured button presses and axis movements
//! are sent to the frontend to assign key bindings.

use tauri::{ AppHandle, Emitter };
use gilrs::{ Gilrs, Event, EventType, Button, Axis, GamepadId };
use std::sync::atomic::{ AtomicBool, Ordering };
use std::sync::Arc;
use std::thread;
use once_cell::sync::Lazy;
use chrono::Local;
use serde::{ Deserialize, Serialize };

/// Global atomic flag indicating whether input capture is currently running.
/// Initialized as a lazy static so it can be shared across multiple Tauri commands
/// (start/stop from the frontend).
static IS_CAPTURING: Lazy<Arc<AtomicBool>> = Lazy::new(|| Arc::new(AtomicBool::new(false)));

/// Helper function for logging capture messages with a timestamp.
/// Uses the Rust logging framework at debug level.
fn log_capture(msg: &str) {
    let now = Local::now();
    log::debug!("[CAPTURE {}] {}", now.format("%H:%M:%S%.3f"), msg);
}

/// Converts a gilrs UUID (16-byte array) into a hex string.
/// The UUID serves as a stable, hardware-based device identifier
/// that does not change on reconnection (unlike the instance number).
fn uuid_to_hex(uuid: [u8; 16]) -> String {
    uuid.iter()
        .map(|b| format!("{:02x}", b))
        .collect()
}

/// Information about a connected input device for the UI display.
/// Serialized as JSON for the frontend.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectedDevice {
    /// Linux UUID from gilrs - unique per physical device
    pub linux_uuid: String,
    /// Human-readable product name (e.g. "VKB Gladiator NXT")
    pub product_name: String,
    /// Device type: "joystick", "gamepad", "keyboard", "mouse"
    pub device_type: String,
    /// Current joystick instance number (js1, js2, etc.) - may change on reconnection
    pub instance: u32,
}

/// Structure for a captured input event with full device information.
/// Sent to the frontend via Tauri event so the user can assign
/// the captured input to a binding.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CapturedInput {
    /// Linux UUID from gilrs - primary device identifier
    pub linux_uuid: String,
    /// Human-readable product name
    pub product_name: String,
    /// Device type
    pub device_type: String,
    /// Current joystick instance number
    pub instance: u32,
    /// Input identifier in SC format (e.g. "js1_button5", "js2_x")
    pub input: String,
    /// Input type: "button", "axis", or "hat"
    pub input_type: String,
}

/// Lists all currently connected gamepad/joystick devices.
/// Called by the frontend to display a device list to the user.
/// Creates a new gilrs instance and iterates over all detected gamepads.
#[tauri::command]
pub fn list_connected_devices() -> Result<Vec<ConnectedDevice>, String> {
    let gilrs = Gilrs::new().map_err(|e| e.to_string())?;

    let mut devices = Vec::new();

    for (id, gamepad) in gilrs.gamepads() {
        // Convert gilrs internal ID to a 1-based instance number
        // to match the SC format (js1, js2, ...)
        let js_id: usize = id.into();
        let instance = (js_id + 1) as u32;

        devices.push(ConnectedDevice {
            linux_uuid: uuid_to_hex(gamepad.uuid()),
            product_name: gamepad.name().to_string(),
            device_type: "joystick".to_string(),
            instance,
        });
    }

    log_capture(&format!("Found {} connected devices", devices.len()));
    Ok(devices)
}

/// Information about a device axis for the tuning UI.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceAxis {
    /// Axis name in SC format (e.g. "x", "y", "z", "rotx", "slider1")
    pub name: String,
    /// Human-readable label
    pub label: String,
}

/// Information about a connected device and its axes.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectedDeviceWithAxes {
    pub product_name: String,
    pub instance: u32,
    pub axes: Vec<DeviceAxis>,
}

/// Lists all connected devices with their available axes.
/// Used by the tuning UI to show axis-level deadzone/saturation controls.
#[tauri::command]
pub fn list_device_axes() -> Result<Vec<ConnectedDeviceWithAxes>, String> {
    let gilrs = Gilrs::new().map_err(|e| e.to_string())?;
    let mut results = Vec::new();

    for (id, gamepad) in gilrs.gamepads() {
        let js_id: usize = id.into();
        let instance = (js_id + 1) as u32;

        let mut axes = Vec::new();
        let mut seen = std::collections::HashSet::new();

        // Iterate over the gamepad's axis state to find supported axes
        for (axis, _data) in gamepad.state().axes() {
            let native_code = axis.into_u32();
            let sc: Option<(String, String)> = match native_code {
                0 => Some(("x".into(), "X".into())),
                1 => Some(("y".into(), "Y".into())),
                2 => Some(("z".into(), "Z".into())),
                3 => Some(("rotx".into(), "Rot X".into())),
                4 => Some(("roty".into(), "Rot Y".into())),
                5 => Some(("rotz".into(), "Rot Z".into())),
                6 => Some(("slider1".into(), "Slider 1".into())),
                7 => Some(("slider2".into(), "Slider 2".into())),
                _ => None,
            };

            if let Some((name, label)) = sc {
                if seen.insert(name.clone()) {
                    axes.push(DeviceAxis { name, label });
                }
            }
        }

        // Sort axes by a logical order
        axes.sort_by_key(|a| match a.name.as_str() {
            "x" => 0, "y" => 1, "z" => 2,
            "rotx" => 3, "roty" => 4, "rotz" => 5,
            "slider1" => 6, "slider2" => 7,
            _ => 8,
        });

        results.push(ConnectedDeviceWithAxes {
            product_name: gamepad.name().to_string(),
            instance,
            axes,
        });
    }

    Ok(results)
}

/// Starts input capture in a background thread.
/// The thread listens for all joystick/gamepad events via gilrs
/// and sends detected inputs as "input-captured" events to the frontend.
///
/// Prevents double start via the global IS_CAPTURING flag.
/// The thread runs until `stop_input_capture()` is called.
#[tauri::command]
pub fn start_input_capture(app: AppHandle) {
    // Prevent double start - if already capturing, return immediately
    if IS_CAPTURING.load(Ordering::SeqCst) {
        return;
    }
    IS_CAPTURING.store(true, Ordering::SeqCst);
    log_capture(">>> HARDWARE CAPTURE ENABLED <<<");

    // Clone AppHandle and capture flag for the new thread,
    // as the thread needs its own ownership
    let app_clone = app.clone();
    let capturing = IS_CAPTURING.clone();

    thread::spawn(move || {
        match Gilrs::new() {
            Ok(mut gilrs) => {
                log_capture(&format!("Gilrs active. Found {} devices.", gilrs.gamepads().count()));

                // Build a map at startup: GamepadId -> (UUID, Name, Instance).
                // This avoids re-querying the gamepad on every event,
                // which speeds up processing in the main loop.
                let mut device_info_map: std::collections::HashMap<
                    GamepadId,
                    (String, String, u32)
                > = std::collections::HashMap::new();
                for (id, gamepad) in gilrs.gamepads() {
                    let js_id: usize = id.into();
                    let instance = (js_id + 1) as u32;
                    device_info_map.insert(id, (
                        uuid_to_hex(gamepad.uuid()),
                        gamepad.name().to_string(),
                        instance,
                    ));
                }

                // Main capture loop - runs until IS_CAPTURING is set to false
                while capturing.load(Ordering::SeqCst) {
                    // Process all pending events from the gilrs queue
                    while let Some(Event { id, event, .. }) = gilrs.next_event() {
                        // Look up device information - if the device is not in the map
                        // (e.g. because it was connected after capture started), it is
                        // queried now and added to the map
                        let (linux_uuid, product_name, instance) = if
                            let Some(info) = device_info_map.get(&id)
                        {
                            info.clone()
                        } else {
                            // Device may have been added after capture started
                            let gamepad = gilrs.gamepad(id);
                            let js_id: usize = id.into();
                            let inst = (js_id + 1) as u32;
                            let info = (
                                uuid_to_hex(gamepad.uuid()),
                                gamepad.name().to_string(),
                                inst,
                            );
                            device_info_map.insert(id, info.clone());
                            info
                        };

                        // Convert event to SC-compatible input format.
                        // Only ButtonPressed and significant axis movements are processed.
                        let sc_input = match event {
                            // Process button press events
                            EventType::ButtonPressed(button, code) => {
                                let btn_name = if button != Button::Unknown {
                                    // Known button - convert to SC format via the mapping function
                                    format_gilrs_button(button)
                                } else {
                                    // Unknown button - evaluate the hardware code directly.
                                    // Gilrs does not recognize all buttons on specialized joysticks,
                                    // so we need to parse the raw code and map it manually.
                                    let code_str = format!("{:?}", code);

                                    // Special cases for known hardware codes that gilrs does not recognize
                                    if code_str.contains("code: 288") {
                                        "button1".to_string()
                                    } else if code_str.contains("code: 713") {
                                        "button26".to_string()
                                    } else if code_str.contains("code: 708") {
                                        "button21".to_string()
                                    } else {
                                        // Generic conversion: convert hardware code to button number.
                                        // Linux event codes use different ranges:
                                        // 288-303: Standard joystick buttons (BTN_JOYSTICK + N)
                                        // 704+:    Trigger/special buttons (BTN_TRIGGER_HAPPY + N)
                                        code_str
                                            .split("code: ")
                                            .nth(1)
                                            .and_then(|s| s.split(' ').next())
                                            .and_then(|s| s.parse::<u32>().ok())
                                            .map(|c|
                                                format!("button{}", if c >= 704 {
                                                    // BTN_TRIGGER_HAPPY range: starting at button 17
                                                    c - 704 + 17
                                                } else if c >= 288 {
                                                    // BTN_JOYSTICK range: starting at button 1
                                                    c - 288 + 1
                                                } else {
                                                    // Unknown range: use code directly
                                                    c
                                                })
                                            )
                                            .unwrap_or_else(|| "unknown".to_string())
                                    }
                                };

                                // Mark hat buttons (D-Pad) as their own type,
                                // since SC distinguishes between buttons and hats
                                let itype = if btn_name.starts_with("hat") {
                                    "hat"
                                } else {
                                    "button"
                                };
                                Some((btn_name, itype.to_string()))
                            }

                            // Only process axis movements when deflection exceeds 80%.
                            // The high threshold prevents accidental captures
                            // from slight wobble or deadzone noise.
                            EventType::AxisChanged(axis, val, code) if val.abs() > 0.8 => {
                                let code_str = format!("{:?}", code);

                                // Convert gilrs axes to SC axis names
                                let axis_name = match axis {
                                    Axis::LeftStickX => "x".to_string(),
                                    Axis::LeftStickY => "y".to_string(),
                                    Axis::LeftZ => "z".to_string(),
                                    Axis::RightStickX => "rotx".to_string(),
                                    Axis::RightStickY => "roty".to_string(),
                                    Axis::RightZ => "rotz".to_string(),
                                    _ => {
                                        // Detect non-standard axes via hardware code.
                                        // Codes 6 and 7 are typically slider/throttle axes
                                        // on HOTAS systems.
                                        if code_str.contains("code: 6") {
                                            "slider1".to_string()
                                        } else if code_str.contains("code: 7") {
                                            "slider2".to_string()
                                        } else {
                                            // Fallback: gilrs axis name in lowercase
                                            format!("{:?}", axis).to_lowercase()
                                        }
                                    }
                                };
                                Some((axis_name, "axis".to_string()))
                            }

                            // Ignore all other events (ButtonReleased, small axis movements, etc.)
                            _ => None,
                        };

                        // If a valid input event was detected, send it to the frontend
                        if let Some((input, input_type)) = sc_input {
                            // Build the full input string in SC format: "js{N}_{input}"
                            let full_input = format!("js{}_{}", instance, input);

                            log_capture(
                                &format!(
                                    "CAPTURED: {} - {} ({}) -> {}",
                                    product_name,
                                    input,
                                    input_type,
                                    full_input
                                )
                            );

                            // Create CapturedInput structure and emit as Tauri event.
                            // The frontend listens for "input-captured" and presents
                            // the detected input to the user for assignment.
                            let captured = CapturedInput {
                                linux_uuid,
                                product_name,
                                device_type: "joystick".to_string(),
                                instance,
                                input: full_input,
                                input_type,
                            };

                            let _ = app_clone.emit("input-captured", captured);
                        }
                    }
                    // Short pause to reduce CPU load when no events are pending.
                    // 10ms yields an effective polling rate of ~100Hz.
                    thread::sleep(std::time::Duration::from_millis(10));
                }
            }
            // Gilrs could not be initialized (e.g. missing permissions)
            Err(e) => log_capture(&format!("ERROR: {:?}", e)),
        }
    });
}

/// Stops input capture by setting the global IS_CAPTURING flag
/// to false. The background thread will then terminate on its own
/// during the next loop iteration.
#[tauri::command]
pub fn stop_input_capture() {
    IS_CAPTURING.store(false, Ordering::SeqCst);
    log_capture(">>> HARDWARE CAPTURE DISABLED <<<");
}

/// Converts a known gilrs button to the corresponding
/// Star Citizen input name.
///
/// The mapping follows the standard gamepad layout.
/// For specialized joysticks (e.g. VKB, Virpil), buttons are
/// often detected as Unknown and must be mapped via the hardware code
/// in `start_input_capture`.
fn format_gilrs_button(btn: Button) -> String {
    match btn {
        Button::South => "button1".to_string(),
        Button::East => "button2".to_string(),
        Button::North => "button3".to_string(),
        Button::West => "button4".to_string(),
        Button::LeftTrigger => "button5".to_string(),
        Button::RightTrigger => "button6".to_string(),
        Button::Select => "button7".to_string(),
        Button::Start => "button8".to_string(),
        // D-Pad directions are treated as hat inputs,
        // since Star Citizen manages hats separately from buttons
        Button::DPadUp => "hat1_up".to_string(),
        Button::DPadDown => "hat1_down".to_string(),
        Button::DPadLeft => "hat1_left".to_string(),
        Button::DPadRight => "hat1_right".to_string(),
        // Unknown/unmapped buttons: debug name as fallback
        _ => format!("button{:?}", btn).to_lowercase(),
    }
}
