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

//! Centralized error type for all Tauri commands.
//!
//! `AppError` replaces the ad-hoc `Result<T, String>` pattern used across
//! the application. It provides:
//!
//! - Typed error variants for different failure domains
//! - Automatic `From` conversions so `?` works without `.map_err()`
//! - Serialization as a plain string to maintain frontend compatibility
//!
//! ## Usage
//!
//! ```rust,ignore
//! use crate::error::AppError;
//!
//! #[tauri::command]
//! async fn my_command() -> Result<String, AppError> {
//!     let data = std::fs::read_to_string("file.txt")?;  // Io variant
//!     let parsed: MyStruct = serde_json::from_str(&data)?;  // Json variant
//!     Ok(parsed.name)
//! }
//! ```

use serde::Serialize;

/// Application-wide error type for Tauri IPC commands.
///
/// Serializes as a plain string so the frontend receives the same format
/// as the previous `Result<T, String>` pattern. Backend code benefits from
/// structured variants and automatic `From` conversions.
#[derive(Debug)]
#[allow(dead_code)]
pub enum AppError {
    /// I/O errors (file read/write, directory operations)
    Io(std::io::Error),
    /// Network errors (HTTP requests, downloads)
    Network(reqwest::Error),
    /// JSON serialization/deserialization errors
    Json(serde_json::Error),
    /// XML parsing errors
    Xml(String),
    /// Configuration errors (invalid paths, missing fields)
    Config(String),
    /// Wine/Proton related errors
    Wine(String),
    /// Validation errors (invalid input from user)
    Validation(String),
    /// Resource not found (file, runner, version)
    NotFound(String),
    /// Operation was cancelled by the user
    Cancelled,
    /// Async task join/spawn errors
    Task(String),
    /// Catch-all for errors that don't fit other categories
    Other(String),
}

impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AppError::Io(e) => write!(f, "{}", e),
            AppError::Network(e) => write!(f, "{}", e),
            AppError::Json(e) => write!(f, "{}", e),
            AppError::Xml(msg) => write!(f, "{}", msg),
            AppError::Config(msg) => write!(f, "{}", msg),
            AppError::Wine(msg) => write!(f, "{}", msg),
            AppError::Validation(msg) => write!(f, "{}", msg),
            AppError::NotFound(msg) => write!(f, "{}", msg),
            AppError::Cancelled => write!(f, "Operation cancelled"),
            AppError::Task(msg) => write!(f, "Task failed: {}", msg),
            AppError::Other(msg) => write!(f, "{}", msg),
        }
    }
}

impl std::error::Error for AppError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            AppError::Io(e) => Some(e),
            AppError::Network(e) => Some(e),
            AppError::Json(e) => Some(e),
            _ => None,
        }
    }
}

// Serialize as a plain string so the frontend receives the same format
// as the previous Result<T, String> pattern.
impl Serialize for AppError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

// ── From implementations for automatic ? conversion ──

impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        AppError::Io(e)
    }
}

impl From<reqwest::Error> for AppError {
    fn from(e: reqwest::Error) -> Self {
        AppError::Network(e)
    }
}

impl From<serde_json::Error> for AppError {
    fn from(e: serde_json::Error) -> Self {
        AppError::Json(e)
    }
}

impl From<quick_xml::Error> for AppError {
    fn from(e: quick_xml::Error) -> Self {
        AppError::Xml(e.to_string())
    }
}

/// Allows existing `String` errors to be converted seamlessly during migration.
/// New code should prefer specific variants over `AppError::Other`.
impl From<String> for AppError {
    fn from(s: String) -> Self {
        AppError::Other(s)
    }
}

impl From<&str> for AppError {
    fn from(s: &str) -> Self {
        AppError::Other(s.to_string())
    }
}

/// Convenience alias used throughout the application.
#[allow(dead_code)]
pub type AppResult<T> = Result<T, AppError>;

/// Runs a blocking closure on the Tokio blocking thread pool and converts errors.
///
/// Used during incremental migration of modules to `AppError`.
///
/// This replaces the common pattern:
/// ```ignore
/// tokio::task::spawn_blocking(|| { ... })
///     .await
///     .map_err(|e| format!("Task failed: {}", e))?
///     // ... further error mapping
/// ```
///
/// The closure can return either `T` directly or `Result<T, AppError>`.
#[allow(dead_code)]
pub async fn blocking<T, F>(f: F) -> AppResult<T>
where
    F: FnOnce() -> AppResult<T> + Send + 'static,
    T: Send + 'static,
{
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| AppError::Task(e.to_string()))?
}
