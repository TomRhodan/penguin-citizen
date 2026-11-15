//! Blueprint markers for Star Citizen mission texts.
//!
//! Missions that reward blueprints get a `[BP]` tag in their title and a block
//! in their description listing what they can drop, the reputation needed and
//! the cooldown. The data comes from
//! [penguin-citizen-blueprints](https://github.com/TomRhodan/penguin-citizen-blueprints),
//! which is generated from the game's own files by the `bp-extract` dev tool.
//!
//! Two things this module is deliberately careful about, both of them lessons
//! from the previous implementation (issue #9):
//!
//! 1. **A failed blueprint step never fails the translation install.** The old
//!    code fed a `404` body straight into `serde_json` and the `?` took the
//!    whole install down with it. Blueprints are an optional extra and are
//!    treated as one.
//! 2. **Names are resolved against the installed translation**, not baked in.
//!    Ranks, factions and item names arrive as `global.ini` keys, so a German
//!    file yields German text and an English one English.

use crate::util::http_client;
use serde::{ Deserialize, Serialize };
use std::collections::{ HashMap, HashSet };

/// Where the data lives. The repository is ours, which is the point: the
/// feature died last time because someone else's files went away.
const BASE_URL: &str =
    "https://raw.githubusercontent.com/TomRhodan/penguin-citizen-blueprints/master";

/// Schema this build understands. A newer file is refused rather than
/// misread - the app can be months older than the data.
const SUPPORTED_SCHEMA: u32 = 1;

/// Guards against a redirect or error page being parsed as data.
const MAX_SIZE: usize = 32 * 1024 * 1024;

// ─── the published file ─────────────────────────────────────────────────────

/// Lists which game builds have data, per channel.
#[derive(Deserialize, Clone)]
pub struct Index {
    pub schema: u32,
    pub channels: HashMap<String, ChannelIndex>,
}

#[derive(Deserialize, Clone)]
pub struct ChannelIndex {
    pub latest: String,
    pub builds: Vec<BuildEntry>,
}

#[derive(Deserialize, Clone)]
pub struct BuildEntry {
    pub build: String,
    pub path: String,
    pub mission_count: usize,
    pub generated: String,
}

#[derive(Deserialize, Serialize, Clone)]
pub struct Publication {
    pub schema: u32,
    /// Game environment the data belongs to: LIVE, PTU, EPTU, TECH-PREVIEW.
    pub channel: String,
    /// Star Citizen build the data was extracted from.
    pub game_build: Option<String>,
    pub game_branch: Option<String>,
    pub generated: String,
    pub mission_count: usize,
    pub missions: Vec<Mission>,
}

#[derive(Deserialize, Serialize, Clone)]
pub struct Mission {
    /// Key whose value gets the marker prepended.
    pub title_key: String,
    /// Keys whose values get the block appended.
    pub description_keys: Vec<String>,
    /// False when any pool is a chance rather than a certainty.
    pub guaranteed: bool,
    pub reputation_reward: Option<i64>,
    pub faction_key: Option<String>,
    pub min_standing: Option<Standing>,
    pub max_standing: Option<Standing>,
    pub cooldown_minutes: Option<f64>,
    pub pools: Vec<Pool>,
}

#[derive(Deserialize, Serialize, Clone)]
pub struct Standing {
    pub name_key: Option<String>,
    pub reputation: Option<i64>,
}

#[derive(Deserialize, Serialize, Clone)]
pub struct Pool {
    pub chance: f64,
    pub blueprints: Vec<Blueprint>,
}

#[derive(Deserialize, Serialize, Clone)]
pub struct Blueprint {
    pub name_key: Option<String>,
    /// Shown when the player's file has no name for the key.
    pub record: String,
}

/// What the install reports back about the blueprint step.
#[derive(Serialize, Clone, Default)]
pub struct InjectStats {
    /// Missions whose title was marked.
    pub titles: usize,
    /// Description lines that received a block.
    pub descriptions: usize,
    /// Missions in the data that this game build does not have.
    pub unknown_missions: usize,
}

/// Summary for the install dialog, so the user sees what they are about to get.
/// What the install dialog needs to decide whether to offer the option.
#[derive(Serialize, Clone)]
pub struct BlueprintSource {
    /// Build of the player's installation, from `build_manifest.id`.
    pub installed_build: Option<String>,
    /// Channel asked for: LIVE, PTU, …
    pub channel: String,
    /// True when data exists for exactly this build.
    pub matches: bool,
    /// Newest build published for the channel, if any.
    pub available_build: Option<String>,
    pub mission_count: usize,
    pub generated: Option<String>,
}

// ─── fetching ───────────────────────────────────────────────────────────────

/// Build string of the player's own installation.
///
/// This is what ties the data to a game version. Without it the app cannot
/// tell whether the blueprints it downloaded describe the missions actually
/// installed, and localisation keys do drift between patches.
pub fn installed_build(game_path: &str, version: &str) -> Option<String> {
    let path = crate::sc_config::sc_base_dir(game_path, version).ok()?.join("build_manifest.id");
    let text = std::fs::read_to_string(path).ok()?;
    let value: serde_json::Value = serde_json::from_str(&text).ok()?;
    value.get("Data")?.get("Version")?.as_str().map(str::to_string)
}

/// Reads the index of published builds.
pub async fn fetch_index() -> Result<Index, String> {
    let index: Index = fetch_json(&format!("{BASE_URL}/index.json")).await?;
    if index.schema != SUPPORTED_SCHEMA {
        return Err(
            format!(
                "Blueprint data uses schema {} but this version of Penguin Citizen understands {}. Update the app.",
                index.schema,
                SUPPORTED_SCHEMA
            )
        );
    }
    Ok(index)
}

/// Downloads and parses the blueprint data for one build.
///
/// Checks the HTTP status before touching the body: a `404` page parsed as JSON
/// is what broke this feature last time, and the error it produced
/// (`invalid type: integer 404`) told nobody anything.
pub async fn fetch_publication(path: &str) -> Result<Publication, String> {
    let publication: Publication = fetch_json(&format!("{BASE_URL}/{path}")).await?;
    if publication.schema != SUPPORTED_SCHEMA {
        return Err(
            format!(
                "Blueprint data uses schema {} but this version of Penguin Citizen understands {}. Update the app.",
                publication.schema,
                SUPPORTED_SCHEMA
            )
        );
    }
    Ok(publication)
}

async fn fetch_json<T: serde::de::DeserializeOwned>(url: &str) -> Result<T, String> {
    let response = http_client()
        .get(url)
        .send().await
        .map_err(|e| format!("Blueprint data could not be reached: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("Blueprint data returned HTTP {}", response.status()));
    }

    let bytes = response
        .bytes().await
        .map_err(|e| format!("Blueprint data could not be read: {}", e))?;
    if bytes.len() > MAX_SIZE {
        return Err(format!("Blueprint data is implausibly large ({} bytes)", bytes.len()));
    }

    serde_json
        ::from_slice(&bytes)
        .map_err(|e| format!("Blueprint data is not in the expected format: {}", e))
}

/// Finds the entry for a build, or the newest one the channel has.
///
/// Returns `(entry, matches)` - `matches` is false when the newest available
/// data was built from a different patch than the one installed.
pub fn resolve_build<'a>(
    index: &'a Index,
    channel: &str,
    installed: Option<&str>,
) -> Option<(&'a BuildEntry, bool)> {
    let channel = index.channels.get(channel)?;
    if let Some(installed) = installed {
        if let Some(exact) = channel.builds.iter().find(|b| b.build == installed) {
            return Some((exact, true));
        }
    }
    let latest = channel.builds.iter().find(|b| b.build == channel.latest)?;
    Some((latest, false))
}

/// Read-only summary for the install dialog: is there data for this build?
#[tauri::command]
pub async fn check_blueprints_source(
    game_path: String,
    version: String
) -> Result<BlueprintSource, String> {
    let installed = installed_build(&game_path, &version);
    let index = fetch_index().await?;
    let resolved = resolve_build(&index, &version, installed.as_deref());

    Ok(BlueprintSource {
        installed_build: installed,
        channel: version,
        matches: resolved.as_ref().is_some_and(|(_, m)| *m),
        available_build: resolved.as_ref().map(|(e, _)| e.build.clone()),
        mission_count: resolved.as_ref().map(|(e, _)| e.mission_count).unwrap_or(0),
        generated: resolved.as_ref().map(|(e, _)| e.generated.clone()),
    })
}

// ─── injection ──────────────────────────────────────────────────────────────

/// An ini reduced to base key → value.
///
/// A key may carry a CryEngine variant suffix: `Foo_Title_001,P` is the plural
/// of `Foo_Title_001`, and the player may be shown either, so both fold into
/// one entry and both get marked.
fn index_lines(lines: &[String]) -> HashMap<String, Vec<usize>> {
    let mut index: HashMap<String, Vec<usize>> = HashMap::new();
    for (i, line) in lines.iter().enumerate() {
        let Some((key, _)) = line.split_once('=') else { continue };
        let key = key.trim();
        let base = key.split_once(',').map(|(b, _)| b).unwrap_or(key);
        index.entry(base.to_ascii_lowercase()).or_default().push(i);
    }
    index
}

/// Adds the markers and blocks to a `global.ini`.
///
/// Pure: no network, no filesystem. Everything outside the matched values is
/// returned byte for byte, including the literal `\n` sequences Star Citizen
/// uses for line breaks - a real newline would end the entry.
pub fn inject(ini_text: &str, publication: &Publication, lang: &str) -> (String, InjectStats) {
    let mut lines: Vec<String> = ini_text.split('\n').map(str::to_string).collect();
    let index = index_lines(&lines);

    // Values, for rendering ranks and item names in the installed language.
    let lookup: HashMap<String, String> = lines
        .iter()
        .filter_map(|l| l.split_once('='))
        .map(|(k, v)| {
            let k = k.trim();
            let base = k.split_once(',').map(|(b, _)| b).unwrap_or(k);
            (base.to_ascii_lowercase(), v.to_string())
        })
        .collect();

    let mut stats = InjectStats::default();
    // One block per line even when two missions share a description.
    let mut written: HashSet<usize> = HashSet::new();

    for mission in &publication.missions {
        let Some(title_rows) = index.get(&mission.title_key.to_ascii_lowercase()) else {
            stats.unknown_missions += 1;
            continue;
        };

        let marker = format!(
            " <EM4>[{}]</EM4>",
            if mission.guaranteed { "BP" } else { "BP?" }
        );
        for &i in title_rows {
            if let Some((key, value)) = lines[i].clone().split_once('=') {
                lines[i] = format!("{}={}{}", key, marker, value);
            }
        }
        stats.titles += 1;

        let block = render_block(mission, lang, &lookup);
        for key in &mission.description_keys {
            let Some(rows) = index.get(&key.to_ascii_lowercase()) else { continue };
            for &i in rows {
                if written.insert(i) {
                    lines[i].push_str(&block);
                    stats.descriptions += 1;
                }
            }
        }
    }

    (lines.join("\n"), stats)
}

/// Resolves a key against the installed translation.
///
/// A value can itself contain the literal `\n` - the rank
/// `RepScope_Contractor_Rank6` reads "AUFTRAGNEHMER\nELITE" - which would split
/// the single line being built, so it collapses to a space.
fn resolve(lookup: &HashMap<String, String>, key: Option<&String>) -> Option<String> {
    let value = lookup.get(&key?.to_ascii_lowercase())?;
    let flattened = value.replace("\\n", " ");
    let cleaned = flattened.split_whitespace().collect::<Vec<_>>().join(" ");
    (!cleaned.is_empty()).then_some(cleaned)
}

/// The block appended to a mission description.
fn render_block(mission: &Mission, lang: &str, lookup: &HashMap<String, String>) -> String {
    let de = lang.starts_with("de");
    // Literal backslash-n: Star Citizen's own parser turns these into breaks.
    let nl = "\\n";
    let mut b = String::new();

    b.push_str(nl);
    b.push_str(nl);
    b.push_str("---------------------------------------------------------");
    b.push_str(nl);
    b.push_str(nl);
    b.push_str(if de {
        "MÖGLICHE BAUPLÄNE FÜR DIESEN MISSIONSTYP"
    } else {
        "POSSIBLE BLUEPRINTS FOR THIS MISSION TYPE"
    });
    b.push_str(nl);

    if let Some(faction) = resolve(lookup, mission.faction_key.as_ref()) {
        b.push_str(nl);
        b.push_str(&format!("# {}: {}", if de { "Fraktion" } else { "Faction" }, faction));
    }
    for (standing, label) in [
        (&mission.min_standing, if de { "Min. Reputation" } else { "Min. reputation" }),
        (&mission.max_standing, if de { "Max. Reputation" } else { "Max. reputation" }),
    ] {
        let Some(standing) = standing else { continue };
        let name = resolve(lookup, standing.name_key.as_ref()).unwrap_or_default();
        let xp = standing.reputation.unwrap_or(0);
        b.push_str(nl);
        b.push_str(&format!("# {}: {} ({} XP)", label, name, xp));
    }
    if let Some(rep) = mission.reputation_reward {
        b.push_str(nl);
        b.push_str(&format!("# {}: {} XP", if de { "Rufpunkte" } else { "Reputation" }, rep));
    }
    if let Some(minutes) = mission.cooldown_minutes {
        b.push_str(nl);
        b.push_str(
            &format!("# Cooldown: {:.0} {}", minutes, if de { "Minuten" } else { "minutes" })
        );
    }

    for pool in &mission.pools {
        if pool.blueprints.is_empty() {
            continue;
        }
        b.push_str(nl);
        b.push_str(nl);
        b.push_str(
            &format!(
                "# {} ({}: {:.0}%):",
                if de { "Baupläne" } else { "Blueprints" },
                if de { "Chance" } else { "chance" },
                pool.chance * 100.0
            )
        );
        for item in &pool.blueprints {
            let name = resolve(lookup, item.name_key.as_ref()).unwrap_or_else(||
                item.record.clone()
            );
            b.push_str(nl);
            b.push_str(&format!("    - {}", name));
        }
    }

    b
}

#[cfg(test)]
mod tests {
    use super::*;

    fn publication(mission: Mission) -> Publication {
        Publication {
            schema: 1,
            channel: "LIVE".into(),
            game_build: Some("4.10.200.58746".into()),
            game_branch: None,
            generated: "2026-11-15T00:00:00Z".into(),
            mission_count: 1,
            missions: vec![mission],
        }
    }

    fn mission() -> Mission {
        Mission {
            title_key: "Test_Title_001".into(),
            description_keys: vec!["test_desc_001".into()],
            guaranteed: true,
            reputation_reward: Some(150),
            faction_key: Some("Faction_Name".into()),
            min_standing: Some(Standing {
                name_key: Some("Rank_Low".into()),
                reputation: Some(100),
            }),
            max_standing: None,
            cooldown_minutes: Some(30.0),
            pools: vec![Pool {
                chance: 1.0,
                blueprints: vec![
                    Blueprint { name_key: Some("Item_A".into()), record: "BP_A".into() },
                    Blueprint { name_key: None, record: "BP_B".into() },
                ],
            }],
        }
    }

    const INI: &str = "Test_Title_001=Clear the outpost\n\
                       Test_Desc_001=Some briefing text\n\
                       Faction_Name=Foxwell Enforcement\n\
                       Rank_Low=Contractor\n\
                       Item_A=Atzkav Sniper Rifle\n\
                       Unrelated_Key=leave me alone\n";

    #[test]
    fn marks_the_title_and_fills_the_description() {
        let (out, stats) = inject(INI, &publication(mission()), "de");
        assert_eq!(stats.titles, 1);
        assert_eq!(stats.descriptions, 1);
        assert!(out.contains("Test_Title_001= <EM4>[BP]</EM4>Clear the outpost"));
        assert!(out.contains("MÖGLICHE BAUPLÄNE"));
    }

    /// Keys differ in case between the data and the player's file.
    #[test]
    fn matches_keys_case_insensitively() {
        let (out, stats) = inject(INI, &publication(mission()), "de");
        assert_eq!(stats.descriptions, 1, "Test_Desc_001 vs test_desc_001");
        assert!(out.contains("Test_Desc_001=Some briefing text\\n"));
    }

    /// `Foo,P` is the plural variant of `Foo`; the player may see either.
    #[test]
    fn marks_variant_suffixed_keys_too() {
        let ini = "Test_Title_001,P=Clear the outposts\nTest_Desc_001,P=Briefing\n";
        let (out, stats) = inject(ini, &publication(mission()), "de");
        assert_eq!(stats.titles, 1);
        assert!(out.contains("Test_Title_001,P= <EM4>[BP]</EM4>"));
        assert!(out.contains("MÖGLICHE BAUPLÄNE"));
    }

    #[test]
    fn renders_names_from_the_installed_translation() {
        let (out, _) = inject(INI, &publication(mission()), "de");
        assert!(out.contains("Foxwell Enforcement"), "faction resolved");
        assert!(out.contains("Contractor (100 XP)"), "rank resolved");
        assert!(out.contains("Atzkav Sniper Rifle"), "item resolved");
        assert!(out.contains("BP_B"), "falls back to the record name");
    }

    #[test]
    fn switches_language_without_changing_the_data() {
        let (de, _) = inject(INI, &publication(mission()), "de");
        let (en, _) = inject(INI, &publication(mission()), "en");
        assert!(de.contains("# Fraktion:") && de.contains("Cooldown: 30 Minuten"));
        assert!(en.contains("# Faction:") && en.contains("Cooldown: 30 minutes"));
    }

    #[test]
    fn a_chance_pool_is_marked_differently() {
        let mut m = mission();
        m.guaranteed = false;
        m.pools[0].chance = 0.25;
        let (out, _) = inject(INI, &publication(m), "de");
        assert!(out.contains("<EM4>[BP?]</EM4>"));
        assert!(out.contains("Chance: 25%"));
    }

    /// The game's parser ends an entry at a real newline.
    #[test]
    fn never_writes_a_real_newline_into_a_value() {
        let (out, _) = inject(INI, &publication(mission()), "de");
        assert_eq!(out.lines().count(), INI.lines().count());
        for line in out.lines() {
            assert!(!line.trim_end().is_empty() || line.is_empty());
        }
    }

    #[test]
    fn leaves_untouched_lines_byte_identical() {
        let (out, _) = inject(INI, &publication(mission()), "de");
        assert!(out.contains("Unrelated_Key=leave me alone"));
    }

    /// Two missions sharing a description must not stack two blocks on it.
    #[test]
    fn writes_one_block_per_line() {
        let mut a = mission();
        a.title_key = "Test_Title_001".into();
        let mut b = mission();
        b.title_key = "Other_Title".into();
        let p = Publication {
            schema: 1,
            channel: "LIVE".into(),
            game_build: None,
            game_branch: None,
            generated: String::new(),
            mission_count: 2,
            missions: vec![a, b],
        };
        let ini = format!("{}Other_Title=Another mission\n", INI);
        let (out, stats) = inject(&ini, &p, "de");
        assert_eq!(stats.descriptions, 1, "the shared line is written once");
        assert_eq!(out.matches("MÖGLICHE BAUPLÄNE").count(), 1);
    }

    /// Data may describe missions a given build does not have.
    #[test]
    fn counts_missions_the_game_does_not_have() {
        let mut m = mission();
        m.title_key = "Not_In_This_Build".into();
        let (out, stats) = inject(INI, &publication(m), "de");
        assert_eq!(stats.unknown_missions, 1);
        assert_eq!(stats.titles, 0);
        assert_eq!(out, INI, "nothing touched");
    }

    #[test]
    fn missing_description_keys_are_skipped_quietly() {
        let mut m = mission();
        m.description_keys = vec!["no_such_key".into(), "test_desc_001".into()];
        let (_, stats) = inject(INI, &publication(m), "de");
        assert_eq!(stats.descriptions, 1);
    }

    fn index() -> Index {
        let mut channels = HashMap::new();
        channels.insert(
            "LIVE".to_string(),
            ChannelIndex {
                latest: "4.10.200.58746".into(),
                builds: vec![
                    BuildEntry {
                        build: "4.10.200.58746".into(),
                        path: "LIVE/4.10.200.58746.json".into(),
                        mission_count: 352,
                        generated: "2026-11-15T11:30:39Z".into(),
                    },
                    BuildEntry {
                        build: "4.10.100.11111".into(),
                        path: "LIVE/4.10.100.11111.json".into(),
                        mission_count: 340,
                        generated: "2026-10-01T00:00:00Z".into(),
                    },
                ],
            },
        );
        Index { schema: 1, channels }
    }

    #[test]
    fn an_installed_build_with_data_is_an_exact_match() {
        let index = index();
        let (entry, exact) = resolve_build(&index, "LIVE", Some("4.10.100.11111")).unwrap();
        assert!(exact);
        assert_eq!(entry.build, "4.10.100.11111");
    }

    /// After a patch the app must say so rather than quietly marking the wrong
    /// missions - loc keys drift between builds.
    #[test]
    fn an_unknown_build_falls_back_and_reports_the_mismatch() {
        let index = index();
        let (entry, exact) = resolve_build(&index, "LIVE", Some("4.11.0.99999")).unwrap();
        assert!(!exact, "a newer game than the data is not a match");
        assert_eq!(entry.build, "4.10.200.58746", "offers the newest it has");
    }

    /// PTU data must never be served for a LIVE install.
    #[test]
    fn a_channel_without_data_resolves_to_nothing() {
        let index = index();
        assert!(resolve_build(&index, "PTU", Some("4.10.200.58746")).is_none());
    }

    #[test]
    fn without_a_build_manifest_the_latest_is_offered_as_a_mismatch() {
        let index = index();
        let (entry, exact) = resolve_build(&index, "LIVE", None).unwrap();
        assert!(!exact);
        assert_eq!(entry.build, "4.10.200.58746");
    }
}
