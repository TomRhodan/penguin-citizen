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

//! Dashboard module for RSI information.
//!
//! This module provides Tauri commands to fetch the following data:
//! - RSI news from the community Atom feed (leonick.se)
//! - Server status from status.robertsspaceindustries.com (RSS feed)
//! - Community statistics (funds, fans, vehicles) via the Star Citizen Wiki API
//!
//! All data is fetched asynchronously. The statistics history is
//! cached with a 1-hour TTL to avoid unnecessary API calls.

use chrono::{ DateTime, Utc };
use once_cell::sync::Lazy;
use quick_xml::events::Event;
use quick_xml::Reader; // XML parser for Atom/RSS feeds
use serde::{ Deserialize, Serialize };
use std::collections::HashMap;
use std::sync::Mutex; // For thread-safe access to the statistics cache

use crate::util::http_client;

// ── RSI News ──────────────────────────────────────────────────────────

/// A single RSI news article from the Atom feed.
///
/// Contains title, summary, link, category, publication date,
/// and a relative time label (e.g. "3h ago") for display in the dashboard.
#[derive(Serialize, Clone)]
pub struct RsiNewsItem {
    /// Title of the news article
    pub title: String,
    /// Short summary (max. 200 characters, truncated after that)
    pub summary: String,
    /// Direct link to the article on the RSI website
    pub link: String,
    /// Category of the article (e.g. "Patch Notes", "Comm-Link")
    pub category: String,
    /// Publication date in ISO format
    pub published: String,
    /// Human-readable relative time label (e.g. "2d ago", "5h ago")
    pub relative_time: String,
}

/// Result wrapper for the RSI news fetch.
///
/// Contains either the fetched news articles or an error message.
/// This pattern (data + optional error) is used consistently,
/// so that the frontend always receives a valid JSON object.
#[derive(Serialize)]
pub struct RsiNewsResult {
    pub items: Vec<RsiNewsItem>,
    pub error: Option<String>,
}

/// Tauri command: Fetches the latest RSI news.
///
/// Called by the frontend and delegates to the internal implementation.
/// Errors are caught and returned as a string in the `error` field,
/// so the frontend never receives an unhandled error.
#[tauri::command]
pub async fn fetch_rsi_news() -> RsiNewsResult {
    match fetch_rsi_news_inner().await {
        Ok(items) => RsiNewsResult { items, error: None },
        Err(e) =>
            RsiNewsResult {
                items: vec![],
                error: Some(e.to_string()),
            },
    }
}

/// Internal implementation of the news fetch.
///
/// Loads the Atom feed from leonick.se (a community mirror of RSI news)
/// and manually parses the XML structure with quick_xml. A maximum of 5
/// entries are extracted to keep the dashboard display compact.
async fn fetch_rsi_news_inner() -> Result<
    Vec<RsiNewsItem>,
    Box<dyn std::error::Error + Send + Sync>
> {
    // Fetch Atom feed from the community mirror
    let body = reqwest::get("https://leonick.se/feeds/rsi/atom").await?.text().await?;

    let mut reader = Reader::from_str(&body);
    // Safety: trim whitespace and disable DTD processing (XXE protection)
    reader.config_mut().trim_text(true);
    let mut items: Vec<RsiNewsItem> = Vec::new();
    // State variables for the XML parser: we are either
    // inside an <entry> element or not
    let mut in_entry = false;
    let mut current_title = String::new();
    let mut current_summary = String::new();
    let mut current_link = String::new();
    let mut current_category = String::new();
    let mut current_published = String::new();
    let mut current_tag = String::new(); // Current XML tag, to assign text to the right field

    // Main loop: process XML events sequentially.
    // The Atom feed has the structure: <feed> -> <entry> -> <title>, <summary>, <link>, etc.
    loop {
        match reader.read_event() {
            // Opening tag found (e.g. <entry>, <title>)
            Ok(Event::Start(ref e)) => {
                let name = String::from_utf8_lossy(e.name().as_ref()).to_string();
                if name == "entry" {
                    // Start a new entry - reset all fields
                    in_entry = true;
                    current_title.clear();
                    current_summary.clear();
                    current_link.clear();
                    current_category.clear();
                    current_published.clear();
                } else if in_entry {
                    // Inside an entry: remember the tag name for text assignment
                    current_tag = name.clone();
                    // Links are in the href attribute, not in the text content
                    if name == "link" {
                        for attr in e.attributes().flatten() {
                            if attr.key.as_ref() == b"href" {
                                current_link = String::from_utf8_lossy(&attr.value).to_string();
                            }
                        }
                    }
                }
            }
            // Self-closing tag (e.g. <link href="..." /> or <category term="..." />)
            Ok(Event::Empty(ref e)) => {
                if !in_entry {
                    continue;
                }
                let name = String::from_utf8_lossy(e.name().as_ref()).to_string();
                if name == "link" {
                    // Extract link URL from the href attribute
                    for attr in e.attributes().flatten() {
                        if attr.key.as_ref() == b"href" {
                            current_link = String::from_utf8_lossy(&attr.value).to_string();
                        }
                    }
                } else if name == "category" {
                    // Extract category from the term attribute
                    for attr in e.attributes().flatten() {
                        if attr.key.as_ref() == b"term" {
                            current_category = String::from_utf8_lossy(&attr.value).to_string();
                        }
                    }
                }
            }
            // Text content inside a tag
            Ok(Event::Text(ref e)) if in_entry => {
                let text = e.unescape().unwrap_or_default().to_string();
                // Assign text to the correct field based on the current tag
                match current_tag.as_str() {
                    "title" => current_title.push_str(&text),
                    "summary" => current_summary.push_str(&text),
                    "published" | "updated" if current_published.is_empty() => {
                        // Only take the first date (published preferred)
                        current_published = text;
                    }
                    _ => {}
                }
            }
            // CDATA sections can also contain titles or summaries
            Ok(Event::CData(ref e)) if in_entry => {
                let text = String::from_utf8_lossy(e.as_ref()).to_string();
                match current_tag.as_str() {
                    "title" => current_title.push_str(&text),
                    "summary" => current_summary.push_str(&text),
                    _ => {}
                }
            }
            // Closing tag - on </entry>, save the collected entry
            Ok(Event::End(ref e)) => {
                let name = String::from_utf8_lossy(e.name().as_ref()).to_string();
                if name == "entry" {
                    in_entry = false;
                    let relative = format_relative_time(&current_published);
                    // Truncate summary to ~200 characters (UTF-8 safe via char_indices)
                    let summary = if current_summary.len() > 200 {
                        let trimmed =
                            &current_summary
                                [
                                    ..current_summary
                                        .char_indices()
                                        .take(200)
                                        .last()
                                        .map(|(i, c)| i + c.len_utf8())
                                        .unwrap_or(200)
                                ];
                        format!("{}...", trimmed.trim())
                    } else {
                        current_summary.trim().to_string()
                    };
                    items.push(RsiNewsItem {
                        title: current_title.trim().to_string(),
                        summary,
                        link: current_link.trim().to_string(),
                        category: current_category.trim().to_string(),
                        published: current_published.trim().to_string(),
                        relative_time: relative,
                    });
                    // Maximum 5 entries for the dashboard
                    if items.len() >= 5 {
                        break;
                    }
                }
                // Reset tag name so that the next text is assigned correctly
                if in_entry {
                    current_tag.clear();
                }
            }
            Ok(Event::Eof) => {
                break;
            }
            // On parse errors, break - the entries collected so far are still returned
            Err(_) => {
                break;
            }
            _ => {}
        }
    }

    Ok(items)
}

/// Converts a date string into a relative time label (e.g. "3h ago", "2d ago").
///
/// Tries to parse various date formats (RFC 3339, RFC 2822),
/// since different feeds may use different formats.
/// On a parse error, an empty string is returned.
fn format_relative_time(date_str: &str) -> String {
    // Try multiple date formats until one succeeds
    let parsed = date_str
        .parse::<DateTime<Utc>>()
        .or_else(|_| DateTime::parse_from_rfc3339(date_str).map(|d| d.with_timezone(&Utc)))
        .or_else(|_| DateTime::parse_from_rfc2822(date_str).map(|d| d.with_timezone(&Utc)));

    match parsed {
        Ok(dt) => {
            let now = Utc::now();
            let diff = now.signed_duration_since(dt);
            let mins = diff.num_minutes();
            let hours = diff.num_hours();
            let days = diff.num_days();

            // Choose the appropriate unit based on the time difference
            if mins < 1 {
                "just now".to_string()
            } else if mins < 60 {
                format!("{}m ago", mins)
            } else if hours < 24 {
                format!("{}h ago", hours)
            } else if days < 30 {
                format!("{}d ago", days)
            } else {
                format!("{}mo ago", days / 30)
            }
        }
        // Date could not be parsed - return an empty string
        Err(_) => String::new(),
    }
}

// ── Server Status ─────────────────────────────────────────────────────

/// Information about a single RSI server component.
///
/// Each component (e.g. Platform, Persistent Universe, Arena Commander)
/// has a status sourced from the cState JSON API.
#[derive(Serialize, Clone)]
pub struct ServerComponent {
    /// Name of the server component (e.g. "Platform", "Persistent Universe")
    pub name: String,
    /// Current status: "operational", "degraded", "major_outage", or "maintenance"
    pub status: String,
}

/// Result wrapper for the server status fetch.
#[derive(Serialize)]
pub struct ServerStatusResult {
    pub components: Vec<ServerComponent>,
    pub error: Option<String>,
}

/// Tauri command: Fetches the current server status of RSI services.
///
/// Uses the cState JSON API (`index.json`) which provides explicit
/// per-component status values — no keyword guessing required.
#[tauri::command]
pub async fn fetch_server_status() -> ServerStatusResult {
    match fetch_server_status_inner().await {
        Ok(components) =>
            ServerStatusResult {
                components,
                error: None,
            },
        Err(e) =>
            ServerStatusResult {
                components: vec![],
                error: Some(e.to_string()),
            },
    }
}

/// Maps a cState status string to our internal status vocabulary.
fn map_cstate_status(cstate: &str) -> &'static str {
    match cstate {
        "operational" => "operational",
        "disrupted" => "degraded",
        "down" => "major_outage",
        "maintenance" => "maintenance",
        // "notice" is informational, not an outage
        "notice" => "operational",
        _ => "unknown",
    }
}

/// Internal implementation of the server status fetch.
///
/// Fetches the cState `index.json` API from the RSI status page,
/// which contains an explicit status field per system component.
async fn fetch_server_status_inner() -> Result<
    Vec<ServerComponent>,
    Box<dyn std::error::Error + Send + Sync>
> {
    let resp: serde_json::Value = reqwest
        ::get("https://status.robertsspaceindustries.com/index.json").await?
        .json().await?;

    let systems = resp.get("systems")
        .and_then(|s| s.as_array())
        .ok_or("missing 'systems' in status API response")?;

    let components = systems
        .iter()
        .filter_map(|sys| {
            let name = sys.get("name")?.as_str()?;
            let status = sys.get("status")?.as_str()?;
            Some(ServerComponent {
                name: name.to_string(),
                status: map_cstate_status(status).to_string(),
            })
        })
        .collect();

    Ok(components)
}

// ── Community Stats ───────────────────────────────────────────────────

/// API response from the Star Citizen Wiki Stats API (current statistics).
#[derive(Deserialize)]
struct StatsApiResponse {
    data: StatsData,
}

/// Data fields from the Stats API response.
#[derive(Deserialize)]
struct StatsData {
    /// Total funds raised as string (parsed to f64 later)
    funds: String,
    /// Total number of registered fans/backers
    fans: u64,
}

/// Paginated API response - only used to determine the total number
/// of vehicles via `meta.total`, without loading all vehicle data.
#[derive(Deserialize)]
struct PaginatedResponse {
    meta: PaginatedMeta,
}

#[derive(Deserialize)]
struct PaginatedMeta {
    /// Total number of available entries
    total: u64,
}

/// Community statistics for Star Citizen.
///
/// Contains both formatted strings (for display in the frontend)
/// and raw values (for potential calculations or charts).
#[derive(Serialize)]
pub struct CommunityStats {
    /// Formatted funds (e.g. "$700,123,456.78")
    pub funds: String,
    /// Raw value of funds in dollars
    pub funds_raw: f64,
    /// Formatted fan count (e.g. "4,567,890")
    pub fans: String,
    /// Raw value of the fan count
    pub fans_raw: u64,
    /// Formatted vehicle count (e.g. "189")
    pub vehicles: String,
    /// Raw value of the vehicle count
    pub vehicles_raw: u64,
}

/// Result wrapper for the community statistics fetch.
#[derive(Serialize)]
pub struct CommunityStatsResult {
    pub stats: Option<CommunityStats>,
    pub error: Option<String>,
}

/// Tauri command: Fetches the current community statistics.
///
/// Returns funds, fan count, and vehicle count
/// from the Star Citizen Wiki API.
#[tauri::command]
pub async fn fetch_community_stats() -> CommunityStatsResult {
    match fetch_community_stats_inner().await {
        Ok(stats) =>
            CommunityStatsResult {
                stats: Some(stats),
                error: None,
            },
        Err(e) =>
            CommunityStatsResult {
                stats: None,
                error: Some(e.to_string()),
            },
    }
}

/// Internal implementation of the community statistics fetch.
///
/// Fetches two API endpoints in parallel to minimize load time:
/// 1. Stats API: Returns funds and fan count
/// 2. Vehicles API: Returns the total number of vehicles via meta data
///    (limit=1, to transfer as little data as possible)
async fn fetch_community_stats_inner() -> Result<
    CommunityStats,
    Box<dyn std::error::Error + Send + Sync>
> {
    let client = http_client();

    // Prepare both API requests as futures
    let stats_fut = async {
        client
            .get("https://api.star-citizen.wiki/api/stats/latest")
            .send()
            .await?
            .json::<StatsApiResponse>()
            .await
    };
    let vehicles_fut = async {
        // limit=1: we only need meta.total, not the vehicle data itself
        client
            .get("https://api.star-citizen.wiki/api/v2/vehicles?page=1&limit=1")
            .send()
            .await?
            .json::<PaginatedResponse>()
            .await
    };

    // Execute both requests concurrently (parallel instead of sequential)
    let (stats_result, vehicles_result) = tokio::join!(stats_fut, vehicles_fut);

    let stats = stats_result?;
    // Vehicle fetch may fail - 0 is displayed in that case
    let vehicles_count = vehicles_result.map(|p| p.meta.total).unwrap_or(0);

    // Convert funds string to number
    let funds: f64 = stats.data.funds.parse().unwrap_or(0.0);
    let fans = stats.data.fans;

    // Return both formatted strings and raw values
    Ok(CommunityStats {
        funds: format_currency(funds),
        funds_raw: funds,
        fans: format_number(fans),
        fans_raw: fans,
        vehicles: format_number(vehicles_count),
        vehicles_raw: vehicles_count,
    })
}

/// Formats a monetary value as a USD string with thousands separators.
///
/// Example: 700123456.78 -> "$700,123,456.78"
/// Negative values are displayed with a leading minus sign.
/// The calculation via cents (integer) avoids floating-point rounding errors.
fn format_currency(val: f64) -> String {
    // Convert to cents to avoid floating-point inaccuracies
    let cents = (val * 100.0).round() as i64;
    let dollars = cents / 100;
    let remainder = (cents % 100).abs();

    let dollar_str = format_integer(dollars.unsigned_abs());
    if dollars < 0 {
        format!("-${}.{:02}", dollar_str, remainder)
    } else {
        format!("${}.{:02}", dollar_str, remainder)
    }
}

/// Formats an integer with thousands separators (comma).
///
/// Example: 4567890 -> "4,567,890"
fn format_number(val: u64) -> String {
    format_integer(val)
}

/// Helper function: Inserts thousands separators (comma) into an integer.
///
/// Works from right to left: a comma is inserted every 3 digits,
/// then the string is reversed to obtain the correct order.
fn format_integer(val: u64) -> String {
    let s = val.to_string();
    let mut result = String::new();
    for (i, c) in s.chars().rev().enumerate() {
        if i > 0 && i % 3 == 0 {
            result.push(',');
        }
        result.push(c);
    }
    result.chars().rev().collect()
}

// ── Community Stats History ──────────────────────────────────────────

/// A single data point in the statistics history.
///
/// Used for rendering charts in the dashboard
/// that show the progression of funds and fan counts over time.
#[derive(Serialize, Clone)]
pub struct StatsDataPoint {
    /// Funds at this point in time
    pub funds: f64,
    /// Fan count at this point in time
    pub fans: u64,
    /// Timestamp in ISO format
    pub timestamp: String,
}

/// API response from the Stats V2 API (paginated historical data).
#[derive(Deserialize)]
struct StatsV2Response {
    data: Vec<StatsV2Item>,
}

/// Single element from the Stats V2 API response.
#[derive(Deserialize)]
struct StatsV2Item {
    funds: String,
    fans: u64,
    timestamp: String,
}

/// Result wrapper for the statistics history fetch.
#[derive(Serialize)]
pub struct StatsHistoryResult {
    pub data_points: Vec<StatsDataPoint>,
    pub error: Option<String>,
}

/// Internal cache entry for the statistics history.
///
/// Stores the fetched data together with the time of retrieval,
/// to avoid unnecessary API requests (TTL: 1 hour).
struct CachedHistory {
    data: Vec<StatsDataPoint>,
    fetched_at: std::time::Instant,
}

/// Global, thread-safe cache for the statistics history.
/// Initialized on first access (Lazy) and protected by a Mutex.
static STATS_HISTORY_CACHE: Lazy<Mutex<Option<CachedHistory>>> = Lazy::new(|| Mutex::new(None));

/// Tauri command: Fetches historical community statistics.
///
/// The `days` parameter determines how many days into the past
/// should be displayed. The data is cached for 1 hour.
#[tauri::command]
pub async fn fetch_community_stats_history(days: u32) -> StatsHistoryResult {
    match fetch_stats_history_inner(days).await {
        Ok(data_points) => StatsHistoryResult {
            data_points,
            error: None,
        },
        Err(e) => StatsHistoryResult {
            data_points: vec![],
            error: Some(e.to_string()),
        },
    }
}

/// Internal implementation of the history fetch.
///
/// Uses a 1-hour cache since the statistics only change once per day.
/// The API pagination is broken (all pages return the same data),
/// so only page 1 is fetched.
///
/// Deduplication: The API may return multiple entries per day.
/// Only the last entry per day is kept.
async fn fetch_stats_history_inner(
    days: u32,
) -> Result<Vec<StatsDataPoint>, Box<dyn std::error::Error + Send + Sync>> {
    // Check cache - return immediately if cache is still valid (< 1 hour old)
    {
        let cache = STATS_HISTORY_CACHE.lock()
            .map_err(|e| format!("Cache lock poisoned: {}", e))?;
        if let Some(ref cached) = *cache {
            if cached.fetched_at.elapsed() < std::time::Duration::from_secs(3600) {
                // Cache is still valid - only trim to the requested time range
                let trimmed = trim_to_days(&cached.data, days);
                return Ok(trimmed);
            }
        }
    } // Mutex is released here before the network fetch starts

    // Fetch statistics history from the API (only page 1, since pagination is broken)
    let resp: StatsV2Response = reqwest::get(
        "https://api.star-citizen.wiki/api/v2/stats?page=1",
    )
    .await?
    .json()
    .await?;
    let all_items = resp.data;

    // Deduplication: keep only one entry per day.
    // `seen` maps the date (YYYY-MM-DD) to the index in `data_points`.
    let mut seen: HashMap<String, usize> = HashMap::new();
    let mut data_points: Vec<StatsDataPoint> = Vec::new();

    for item in all_items {
        let funds: f64 = item.funds.parse().unwrap_or(0.0);
        // Use only the date part (before 'T') to deduplicate by day
        let date_key = item.timestamp.split('T').next().unwrap_or(&item.timestamp).to_string();

        if let Some(&idx) = seen.get(&date_key) {
            // Date already seen - overwrite with the newer entry
            data_points[idx] = StatsDataPoint {
                funds,
                fans: item.fans,
                timestamp: item.timestamp,
            };
        } else {
            // New date - add entry and remember its position
            seen.insert(date_key, data_points.len());
            data_points.push(StatsDataPoint {
                funds,
                fans: item.fans,
                timestamp: item.timestamp,
            });
        }
    }

    // Sort chronologically (oldest first) for chart rendering
    data_points.sort_by(|a, b| a.timestamp.cmp(&b.timestamp));

    // Update cache with all available data
    {
        let mut cache = STATS_HISTORY_CACHE.lock()
            .map_err(|e| format!("Cache lock poisoned: {}", e))?;
        *cache = Some(CachedHistory {
            data: data_points.clone(),
            fetched_at: std::time::Instant::now(),
        });
    }

    // Return only the data points within the requested time range
    Ok(trim_to_days(&data_points, days))
}

/// Filters data points to a specific time range (last N days).
///
/// Calculates a cutoff date and keeps only entries whose date
/// is equal to or newer than the cutoff. The comparison is done as a string
/// comparison on the date part (YYYY-MM-DD), which works correctly for ISO formats.
fn trim_to_days(data: &[StatsDataPoint], days: u32) -> Vec<StatsDataPoint> {
    let cutoff = Utc::now() - chrono::Duration::days(days as i64);
    let cutoff_str = cutoff.format("%Y-%m-%d").to_string();
    data.iter()
        .filter(|dp| {
            // Compare only the date part (before 'T')
            let date = dp.timestamp.split('T').next().unwrap_or(&dp.timestamp);
            date >= cutoff_str.as_str()
        })
        .cloned()
        .collect()
}
