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

//! Action definitions and binding data structures.
//!
//! This module defines the types used for categorized action definitions
//! (e.g. spaceship, vehicle, and on-foot controls) as well as the
//! complete binding list that merges default master bindings with
//! user-defined customizations.
//!
//! The structures serve as the data model between the Rust backend and the
//! JavaScript frontend - they are serialized as JSON via Tauri commands.

use serde::{ Deserialize, Serialize };
use std::collections::HashMap;

/// All known action definitions, grouped by category.
///
/// Each category (e.g. "spaceship_general", "vehicle_general", "on_foot")
/// contains a list of `ActionInfo` entries that describe which
/// actions the player can bind in that category.
///
/// The HashMap uses the technical category name as key.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ActionDefinitions {
    /// Mapping from category names to their available actions
    pub categories: HashMap<String, Vec<ActionInfo>>,
}

/// Metadata for a single bindable action.
///
/// Describes an action that the user can assign to an input device
/// (e.g. "Flight Ready", "Landing Gear Toggle"). The information originates
/// from the Star Citizen actionmap definitions.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActionInfo {
    /// Technical action name from the actionmap (e.g. "v_flightready")
    pub name: String,
    /// Translated display name for the user interface (e.g. "Flight Ready")
    pub display_name: String,
    /// Optional description of the action for tooltips etc.
    pub description: Option<String>,
    /// Optional default device type on which this action is normally bound
    pub default_device: Option<String>,
}

impl ActionDefinitions {
    /// Creates a new, empty action definitions collection.
    ///
    /// Used before the definitions are read and populated from
    /// the Star Citizen actionmap files.
    pub fn new() -> Self {
        Self { categories: HashMap::new() }
    }
}

/// A fully resolved binding entry that merges master defaults
/// with user customizations.
///
/// This structure represents the final result of binding resolution:
/// For each action it is checked whether the user has set a custom key binding
/// (is_custom = true), or whether the default binding applies.
/// The frontend displays this data in the binding overview table.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompleteBinding {
    /// Technical category name (e.g. "spaceship_general")
    pub category: String,
    /// Display name of the category (e.g. "Space Ship - General")
    pub category_label: String,
    /// Technical action name (e.g. "v_flightready")
    pub action_name: String,
    /// Translated display name of the action (e.g. "Flight Ready")
    pub display_name: String,
    /// Current input assignment (e.g. "js1_button3", "kb1_f")
    pub current_input: String,
    /// Device type of the input (e.g. "joystick", "keyboard", "gamepad")
    pub device_type: String,
    /// Optional description of the action
    pub description: Option<String>,
    /// Whether this binding was customized by the user (true) or is default (false)
    pub is_custom: bool,
}

/// Summary statistics for the binding list.
///
/// Passed to the frontend so it can show the user how many bindings
/// exist in total and how many of them have been customized.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BindingStats {
    /// Total number of all resolved bindings
    pub total: usize,
    /// Number of user-customized bindings
    pub custom: usize,
}

/// Response structure containing all bindings and their statistics.
///
/// Sent as a JSON response from the Tauri command to the frontend.
/// Contains both the complete list of all resolved bindings
/// and the summary (statistics) in a single object.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BindingListResponse {
    /// List of all resolved binding entries
    pub bindings: Vec<CompleteBinding>,
    /// Statistical summary of the bindings
    pub stats: BindingStats,
}

/// Mapping of a physical device to its Star Citizen identity within a profile.
///
/// Star Citizen identifies devices via a combination of GUID and instance number.
/// This structure bridges the real hardware device (product name) and the
/// SC-internal representation. Important: The instance number in SC can differ
/// from the Linux gilrs instance number - therefore device identity is always
/// determined via `product_name` and `device_type`, not via the js{N} prefix.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceMapping {
    /// Name of the hardware device (e.g. "T.16000M", "Gladiator NXT EVO")
    pub product_name: String,
    /// Device type (e.g. "joystick", "gamepad")
    pub device_type: String,
    /// Optional GUID assigned to the device by Star Citizen
    pub sc_guid: Option<String>,
    /// SC-internal instance number (determines the js{N} prefix in bindings)
    pub sc_instance: u32,
    /// Optional user-defined alias for display in the frontend
    #[serde(default)]
    pub alias: Option<String>,
}
