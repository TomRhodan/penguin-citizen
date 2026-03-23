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

//! Penguin Citizen -- Main entry point of the Tauri application.
//!
//! This is the binary entry point for the Penguin Citizen application.
//! In release builds on Windows, the console window is hidden via
//! `windows_subsystem`.
//!
//! The actual application logic resides in the `penguin_citizen_lib` crate (lib.rs).

// Suppress the Windows console window in release builds
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

/// Entry point of the application.
/// Delegates all initialization and execution to the library.
fn main() {
    penguin_citizen_lib::run()
}
