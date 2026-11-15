//! Extracts the mission → blueprint mapping from Star Citizen's own data files.
//!
//! Background: the mapping used to come from `rjcncpt/StarCitizen-Deutsch-INI`,
//! which deleted it on 2026-09-29. The data itself has always lived in the game,
//! so this reads it straight out of `Data.p4k` and depends on nobody's hosting.
//!
//! The chain inside the DataCore:
//!
//! ```text
//! ContractGenerator
//!   └─ generators[]                       (ContractGeneratorHandler_*)
//!        ├─ …rewards[] → BlueprintRewards { chance, blueprintPool → file:// }
//!        └─ contracts[] → Contract { paramOverrides.stringParamOverrides
//!                                      [{param:"Title",       value:"@<locKey>"},
//!                                       {param:"Description", value:"@<locKey>"}] }
//!
//! BlueprintPoolRecord
//!   └─ blueprintPool[] → BlueprintReward { weight, blueprintRecord → file:// }
//! ```
//!
//! The `@`-prefixed values are `global.ini` keys verbatim - the same thing
//! rjcncpt published as `titleLocKey` / `descriptionLocKey`.
//!
//! Rewards sit on the *handler* (the mission line), not on the individual
//! contract, which is why an in-game marker has to distinguish a guaranteed
//! blueprint from a chance one.
//!
//! Dev tool, not part of the app: it lives behind the `bp-extract` feature so
//! the DataCore dependency never reaches the shipped binary.
//!
//! ```text
//! cargo run --bin bp-extract --features bp-extract -- <install_path> [version] [out.json]
//! ```

use penguin_citizen_lib::sc_config::read_p4k_file;
use serde_json::Value;
use starbreaker_datacore::{export, Database};
use std::collections::{BTreeSet, HashMap};

/// Paths inside Data.p4k. The archive stores Windows-style separators.
const DCB_PATH: &str = "Data\\Game2.dcb";
const EN_GLOBAL_INI: &str = "Data\\Localization\\english\\global.ini";

/// One mission that can award blueprints.
#[derive(serde::Serialize)]
struct MissionEntry {
    /// `global.ini` key of the mission title (rjcncpt's `titleLocKey`).
    title_loc_key: String,
    /// `global.ini` key of the mission description.
    description_loc_key: Option<String>,
    /// Internal name, useful for cross-checking against scunpacked-data.
    debug_name: Option<String>,
    /// 1.0 = guaranteed, lower = a chance. Drives `[BP]` vs `[BP?]`.
    chance: f64,
    /// Record path of the reward pool this mission rolls from.
    pool: String,
    /// Blueprints in that pool.
    blueprints: Vec<BlueprintItem>,
    /// Record path of the generator this came from.
    source: String,
    /// Flagged notForRelease / workInProgress in the game data.
    unreleased: bool,
    /// Reputation granted on success, in XP.
    reputation_reward: Option<i64>,
    /// Faction the reputation belongs to.
    faction: Option<Faction>,
    /// Reputation rank the mission starts being offered at.
    min_standing: Option<Standing>,
    /// Reputation rank it stops being offered at.
    max_standing: Option<Standing>,
    /// Cooldown before the same player can take it again.
    cooldown: Option<Cooldown>,
}

/// One blueprint a pool can hand out.
#[derive(serde::Serialize, Clone)]
struct BlueprintItem {
    /// Record name, e.g. `BP_CRAFT_qrt_combat_medium_arms_01_01_15`.
    record: String,
    /// `global.ini` key of the item's name. The blueprint record itself only
    /// carries `@LOC_PLACEHOLDER`, so this comes from the entity it crafts.
    name_loc_key: Option<String>,
}

#[derive(serde::Serialize, Clone)]
struct Faction {
    record: String,
    /// `global.ini` key of the faction's display name.
    display_loc_key: Option<String>,
}

#[derive(serde::Serialize, Clone)]
struct Standing {
    record: String,
    /// Internal rank name, e.g. `FactionRep_Neutral_Rank0`.
    name: Option<String>,
    /// `global.ini` key of the rank's display name.
    display_loc_key: Option<String>,
    /// Reputation points needed to reach this rank.
    min_reputation: Option<i64>,
}

/// Cooldown comes from the handler's `defaultAvailability`, so every contract
/// under that mission line inherits the same values. Minutes.
#[derive(serde::Serialize, Clone)]
struct Cooldown {
    has_personal: bool,
    personal_minutes: Option<f64>,
    personal_variation: Option<f64>,
    abandoned_minutes: Option<f64>,
}

#[derive(serde::Serialize)]
struct Output {
    meta: Meta,
    entries: Vec<MissionEntry>,
}

#[derive(serde::Serialize)]
struct Meta {
    /// Build string from `build_manifest.id`, the stamp the data belongs to.
    game_build: Option<String>,
    generated: String,
    entry_count: usize,
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 2 {
        eprintln!("usage: bp-extract <install_path> [version] [out.json]");
        std::process::exit(2);
    }
    let install_path = &args[1];
    // Positional arguments only - a flag in slot 2 or 3 is not a version or an
    // output path, and treating it as one silently writes a file called
    // "--inject".
    let positional = |i: usize| args.get(i).filter(|a| !a.starts_with("--")).map(String::as_str);
    let version = positional(2).unwrap_or("LIVE");
    let out_path = positional(3);

    // Discovery helper: `--find <needle>` reports which records contain a given
    // string. Used to track down where a mission that the extractor misses is
    // actually defined.
    let find_needle = args.iter().position(|a| a == "--find").and_then(|i| args.get(i + 1)).cloned();
    // `--dump-path <substring>` prints the first record whose path matches, so
    // the shape of a referenced record can be inspected without guessing.
    let dump_path = args.iter().position(|a| a == "--dump-path").and_then(|i| args.get(i + 1)).cloned();
    // `--inject <in.ini> <out.ini>` writes a global.ini with the markers applied.
    let inject = args
        .iter()
        .position(|a| a == "--inject")
        .and_then(|i| Some((args.get(i + 1)?.clone(), args.get(i + 2)?.clone())));
    // `--block top` puts the blueprint block before the mission text instead of
    // after it. Appending works for short descriptions but some long ones never
    // show it, and the cause - truncation, scrolling, or the game assembling the
    // body from a different string - is not visible from the file alone.
    let block_at_top = args
        .iter()
        .position(|a| a == "--block")
        .and_then(|i| args.get(i + 1))
        .is_some_and(|v| v == "top");
    let lang = args
        .iter()
        .position(|a| a == "--lang")
        .and_then(|i| args.get(i + 1))
        .map(String::as_str)
        .unwrap_or("de")
        .to_string();

    let dcb = read_or_die(install_path, version, DCB_PATH, "DataCore");
    eprintln!("DataCore: {:.1} MiB", mib(dcb.len()));

    let db = match Database::from_bytes(&dcb) {
        Ok(db) => db,
        Err(e) => {
            eprintln!("Could not parse the DataCore: {e}");
            std::process::exit(1);
        }
    };
    eprintln!("Records:  {}", db.records().len());

    if let Some(frag) = &dump_path {
        let frag = frag.to_ascii_lowercase();
        for record in db.records() {
            let path = db.resolve_string(record.file_name_offset);
            if !path.to_ascii_lowercase().contains(&frag) {
                continue;
            }
            eprintln!("=== {path} ===");
            if let Ok(bytes) = export::to_json(&db, record) {
                eprintln!("{}", String::from_utf8_lossy(&bytes));
            }
            return;
        }
        eprintln!("no record path contains {frag:?}");
        return;
    }

    if let Some(needle) = &find_needle {
        eprintln!("\n=== records containing {needle:?} ===");
        let mut hits = 0usize;
        let mut by_struct: std::collections::BTreeMap<String, usize> =
            std::collections::BTreeMap::new();
        for record in db.records() {
            let Ok(bytes) = export::to_json(&db, record) else { continue };
            // Case-insensitive: the DataCore keeps the original casing while
            // global.ini comparisons are folded, and mixing the two silently
            // reports "not found" for records that are right there.
            if !String::from_utf8_lossy(&bytes)
                .to_ascii_lowercase()
                .contains(&needle.to_ascii_lowercase())
            {
                continue;
            }
            hits += 1;
            let sname = db.resolve_string2(db.struct_def(record.struct_index).name_offset);
            // First match is written out in full so the structure can be studied.
            if hits == 1 {
                if let Some(dir) = std::env::var_os("BP_DUMP_DIR") {
                    let out = std::path::Path::new(&dir).join("match.json");
                    let _ = std::fs::write(&out, &bytes);
                    eprintln!("  dumped first match to {}", out.display());
                }
            }
            *by_struct.entry(sname.to_string()).or_insert(0) += 1;
            if hits <= 3 {
                eprintln!("  {sname}  {}", db.resolve_string(record.file_name_offset));
            }
        }
        eprintln!("  total: {hits}");
        for (k, v) in &by_struct {
            eprintln!("    {v:5}  {k}");
        }
        return;
    }

    // Index every record by its path without extension, so a `file://…json`
    // reference resolves against the `.xml` paths the DataCore stores.
    let mut by_path: HashMap<String, usize> = HashMap::with_capacity(db.records().len());
    for (i, record) in db.records().iter().enumerate() {
        by_path.insert(strip_ext(db.resolve_string(record.file_name_offset)), i);
    }

    // The same pool is referenced by many missions - export it once.
    let mut json_cache: HashMap<usize, Value> = HashMap::new();

    let mut entries: Vec<MissionEntry> = Vec::new();
    let mut generators = 0usize;
    let mut contracts_with_rewards = 0usize;
    let mut unresolved_pools: BTreeSet<String> = BTreeSet::new();

    for record in db.records() {
        let sname = db.resolve_string2(db.struct_def(record.struct_index).name_offset);
        if sname != "ContractGenerator" {
            continue;
        }
        generators += 1;
        let Ok(bytes) = export::to_json(&db, record) else { continue };
        let Ok(value) = serde_json::from_slice::<Value>(&bytes) else { continue };
        let source = strip_ext(db.resolve_string(record.file_name_offset));

        for contract in collect_contracts(&value) {
            if contract.rewards.is_empty() {
                continue;
            }
            contracts_with_rewards += 1;

            // Resolve the reputation / faction / standing references once per
            // contract rather than per pool.
            // Sum every reputation award that fires on success.
            let mut reputation_reward: Option<i64> = None;
            for r in &contract.rep_reward_refs {
                if let Some(amount) = record_value(&db, r, &by_path, &mut json_cache)
                    .and_then(|v| v.get("reputationAmount")?.as_i64())
                {
                    reputation_reward = Some(reputation_reward.unwrap_or(0) + amount);
                }
            }
            let faction = contract.faction_ref.as_deref().and_then(|r| {
                let v = record_value(&db, r, &by_path, &mut json_cache)?;
                Some(Faction {
                    record: short_ref(r),
                    display_loc_key: loc_key(v.get("displayName")),
                })
            });
            let min_standing = standing(&db, contract.min_standing_ref.as_deref(), &by_path, &mut json_cache);
            let max_standing = standing(&db, contract.max_standing_ref.as_deref(), &by_path, &mut json_cache);

            for (chance, pool_ref) in &contract.rewards {
                let Some(pool_idx) = resolve_ref(pool_ref, &by_path) else {
                    unresolved_pools.insert(pool_ref.clone());
                    continue;
                };
                let blueprints = pool_items(&db, pool_idx, &by_path, &mut json_cache);
                let pool_path =
                    strip_ext(db.resolve_string(db.records()[pool_idx].file_name_offset));
                entries.push(MissionEntry {
                    title_loc_key: contract.title.clone(),
                    description_loc_key: contract.description.clone(),
                    debug_name: contract.debug_name.clone(),
                    chance: *chance,
                    pool: pool_path,
                    blueprints,
                    source: source.clone(),
                    unreleased: contract.unreleased,
                    reputation_reward,
                    faction: faction.clone(),
                    min_standing: min_standing.clone(),
                    max_standing: max_standing.clone(),
                    cooldown: contract.cooldown.clone(),
                });
            }
        }
    }

    entries.sort_by(|a, b| a.title_loc_key.cmp(&b.title_loc_key).then(a.pool.cmp(&b.pool)));
    entries.dedup_by(|a, b| a.title_loc_key == b.title_loc_key && a.pool == b.pool);

    eprintln!("\n=== extraction ===");
    eprintln!("  ContractGenerator records     : {generators}");
    eprintln!("  contracts with blueprints     : {contracts_with_rewards}");
    eprintln!("  mission entries               : {}", entries.len());
    let guaranteed = entries.iter().filter(|e| e.chance >= 1.0).count();
    eprintln!(
        "  guaranteed [BP] / chance [BP?]: {guaranteed} / {}",
        entries.len() - guaranteed
    );
    let with_bps = entries.iter().filter(|e| !e.blueprints.is_empty()).count();
    eprintln!("  entries with a resolved pool  : {with_bps}");
    if !unresolved_pools.is_empty() {
        eprintln!("  unresolved pool references    : {}", unresolved_pools.len());
        for p in unresolved_pools.iter().take(3) {
            eprintln!("      {p}");
        }
    }

    // Validation: every loc key must exist in the game's own English global.ini.
    // Both come from the same build, so anything below 100% is a real finding.
    let ini = read_or_die(install_path, version, EN_GLOBAL_INI, "English global.ini");
    if let Some(dir) = std::env::var_os("BP_DUMP_DIR") {
        let _ = std::fs::write(std::path::Path::new(&dir).join("english-global.ini"), &ini);
    }
    // A key may carry a CryEngine variant suffix - `Foo_Title_001,P` is the
    // plural form of `Foo_Title_001`. Indexing the raw text would make every
    // such mission look like a miss.
    let ini_keys: BTreeSet<String> = String::from_utf8_lossy(&ini)
        .lines()
        .filter_map(|l| l.split_once('='))
        .map(|(k, _)| {
            let k = k.trim();
            k.split_once(',').map(|(base, _)| base).unwrap_or(k).to_ascii_lowercase()
        })
        .collect();

    let unreleased = entries.iter().filter(|e| e.unreleased).count();
    eprintln!("  flagged unreleased/WIP        : {unreleased}");
    eprintln!(
        "  with reputation reward        : {}",
        entries.iter().filter(|e| e.reputation_reward.is_some()).count()
    );
    eprintln!(
        "  with faction                  : {}",
        entries.iter().filter(|e| e.faction.is_some()).count()
    );
    eprintln!(
        "  with min/max standing         : {} / {}",
        entries.iter().filter(|e| e.min_standing.is_some()).count(),
        entries.iter().filter(|e| e.max_standing.is_some()).count()
    );
    eprintln!(
        "  with cooldown                 : {}",
        entries.iter().filter(|e| e.cooldown.is_some()).count()
    );

    let titles: BTreeSet<&String> = entries.iter().map(|e| &e.title_loc_key).collect();
    // Unreleased contracts have no localized strings yet, so they are the
    // expected cause of any gap below - count the released ones separately.
    let released_titles: BTreeSet<&String> = entries
        .iter()
        .filter(|e| !e.unreleased)
        .map(|e| &e.title_loc_key)
        .collect();
    let missing: Vec<&&String> = titles
        .iter()
        .filter(|k| !ini_keys.contains(&k.to_ascii_lowercase()))
        .collect();
    eprintln!("\n=== validation against the English global.ini ===");
    eprintln!("  keys in global.ini            : {}", ini_keys.len());
    eprintln!("  distinct title keys           : {}", titles.len());
    eprintln!(
        "  found in global.ini           : {} ({:.1}%)",
        titles.len() - missing.len(),
        (titles.len() - missing.len()) as f64 / titles.len().max(1) as f64 * 100.0
    );
    let missing_released: Vec<&&String> = released_titles
        .iter()
        .filter(|k| !ini_keys.contains(&k.to_ascii_lowercase()))
        .collect();
    eprintln!(
        "  released only               : {} of {} ({:.1}%)",
        released_titles.len() - missing_released.len(),
        released_titles.len(),
        (released_titles.len() - missing_released.len()) as f64
            / released_titles.len().max(1) as f64
            * 100.0
    );
    for k in missing.iter().take(5) {
        eprintln!("      missing: {k}");
    }

    if let Some((in_ini, out_ini)) = &inject {
        run_injection(&entries, in_ini, out_ini, &lang, block_at_top);
    }

    let output = Output {
        meta: Meta {
            game_build: read_build_id(install_path, version),
            generated: chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string(),
            entry_count: entries.len(),
        },
        entries,
    };

    match out_path {
        Some(path) => {
            let json = serde_json::to_vec_pretty(&output).expect("serialize");
            if let Err(e) = std::fs::write(path, &json) {
                eprintln!("Could not write {path}: {e}");
                std::process::exit(1);
            }
            eprintln!("\nWrote {path} ({:.1} MiB)", mib(json.len()));
        }
        None => eprintln!("\n(no output path given - nothing written)"),
    }
}

// ─── helpers ────────────────────────────────────────────────────────────────

struct ContractInfo {
    title: String,
    description: Option<String>,
    debug_name: Option<String>,
    /// `(chance, pool reference)` straight from this contract's own results.
    rewards: Vec<(f64, String)>,
    /// CIG's own flags for content that is not live yet.
    unreleased: bool,
    /// Unresolved `file://` references, turned into values in `main`.
    ///
    /// A contract can grant reputation more than once for the same outcome -
    /// one record carries +100 and +60, which the game adds up to 160. Taking
    /// only the first would under-report every such mission.
    rep_reward_refs: Vec<String>,
    faction_ref: Option<String>,
    min_standing_ref: Option<String>,
    max_standing_ref: Option<String>,
    /// Inherited from the enclosing handler.
    cooldown: Option<Cooldown>,
}

/// Every contract in the tree, with its own loc keys and blueprint rewards.
///
/// Contracts are recognised by *shape*, not by type name: the DataCore uses
/// `Contract`, `CareerContract` and others, and keying on the names means
/// silently dropping whichever variant gets added next. A contract is any node
/// carrying both `paramOverrides` and `contractResults`.
///
/// Both the loc keys and the rewards are read from the node directly rather
/// than by descending into it, so a contract never picks up the rewards of the
/// sub-contracts nested beneath it.
fn collect_contracts(root: &Value) -> Vec<ContractInfo> {
    let mut out = Vec::new();
    descend(root, None, &mut out);
    out
}

/// Walks the tree carrying the cooldown down from the enclosing handler.
///
/// Cooldown is defined once per mission line, on the handler's
/// `defaultAvailability`, and every contract beneath inherits it. Passing it
/// down during the walk is what keeps that association correct - reading it
/// from the contract alone would always come up empty.
fn descend(node: &Value, inherited: Option<Cooldown>, out: &mut Vec<ContractInfo>) {
    match node {
        Value::Object(map) => {
            let cooldown = node
                .get("defaultAvailability")
                .and_then(read_cooldown)
                .or(inherited);

            if let Some(info) = contract_from(node, cooldown.clone()) {
                out.push(info);
            }
            for v in map.values() {
                descend(v, cooldown.clone(), out);
            }
        }
        Value::Array(items) => {
            for v in items {
                descend(v, inherited.clone(), out);
            }
        }
        _ => {}
    }
}

/// Applies a contract's own cooldown overrides on top of what it inherited.
///
/// The handler's `defaultAvailability` is only the baseline: a single contract
/// can override it through `paramOverrides`, which is how two missions from the
/// same generator end up 30 minutes and 7 days apart. Reading the handler alone
/// reports the same value for every contract in the line.
fn apply_cooldown_overrides(params: &Value, inherited: Option<Cooldown>) -> Option<Cooldown> {
    let mut cooldown = inherited;

    if let Some(ints) = params.get("intParamOverrides").and_then(Value::as_array) {
        for p in ints {
            let (Some(name), Some(value)) = (
                p.get("param").and_then(Value::as_str),
                p.get("value").and_then(Value::as_f64),
            ) else {
                continue;
            };
            if !name.contains("Cooldown") {
                continue;
            }
            let c = cooldown.get_or_insert(Cooldown {
                has_personal: true,
                personal_minutes: None,
                personal_variation: None,
                abandoned_minutes: None,
            });
            match name {
                "PersonalCooldownTime" => c.personal_minutes = Some(value),
                "PersonalCooldownTimeVariation" => c.personal_variation = Some(value),
                "AbandonedCooldownTime" => c.abandoned_minutes = Some(value),
                _ => {}
            }
        }
    }

    if let Some(bools) = params.get("boolParamOverrides").and_then(Value::as_array) {
        for p in bools {
            let (Some(name), Some(value)) = (
                p.get("param").and_then(Value::as_str),
                p.get("value").and_then(Value::as_bool),
            ) else {
                continue;
            };
            if name == "HasPersonalCooldown" {
                if let Some(c) = cooldown.as_mut() {
                    c.has_personal = value;
                }
            }
        }
    }

    cooldown
}

fn read_cooldown(availability: &Value) -> Option<Cooldown> {
    let has_personal = availability.get("hasPersonalCooldown").and_then(Value::as_bool)?;
    Some(Cooldown {
        has_personal,
        personal_minutes: availability.get("personalCooldownTime").and_then(Value::as_f64),
        personal_variation: availability
            .get("personalCooldownTimeVariation")
            .and_then(Value::as_f64),
        abandoned_minutes: availability.get("abandonedCooldownTime").and_then(Value::as_f64),
    })
}

/// Builds a [`ContractInfo`] if `n` is shaped like a contract.
///
/// Contracts are recognised by shape, not by type name: the DataCore uses
/// `Contract`, `CareerContract` and others, and keying on the names means
/// silently dropping whichever variant gets added next. A contract is any node
/// carrying both `paramOverrides` and `contractResults`.
///
/// Everything is read from the node directly rather than by descending into
/// it, so a contract never picks up the rewards of sub-contracts nested
/// beneath it.
fn contract_from(n: &Value, cooldown: Option<Cooldown>) -> Option<ContractInfo> {
    let params = n.get("paramOverrides")?;
    let results = n.get("contractResults")?;

    let mut title: Option<String> = None;
    let mut description: Option<String> = None;
    if let Some(overrides) = params.get("stringParamOverrides").and_then(Value::as_array) {
        for p in overrides {
            let (Some(param), Some(value)) = (
                p.get("param").and_then(Value::as_str),
                p.get("value").and_then(Value::as_str),
            ) else {
                continue;
            };
            // Loc keys are written as "@<key>" here.
            let Some(key) = value.strip_prefix('@') else { continue };
            match param {
                "Title" if title.is_none() => title = Some(key.to_string()),
                "Description" if description.is_none() => description = Some(key.to_string()),
                _ => {}
            }
        }
    }
    let title = title?;

    let mut rewards = Vec::new();
    let mut rep_reward_refs: Vec<String> = Vec::new();
    let mut faction_ref = None;
    if let Some(list) = results.get("contractResults").and_then(Value::as_array) {
        for r in list {
            match type_of(r) {
                Some("BlueprintRewards") => {
                    let chance = r.get("chance").and_then(Value::as_f64).unwrap_or(1.0);
                    if let Some(pool) = r.get("blueprintPool").and_then(Value::as_str) {
                        rewards.push((chance, pool.to_string()));
                    }
                }
                Some("ContractResult_LegacyReputation") => {
                    // missionResults[0] is the success outcome; the other slots
                    // are failure/abandon, which must not be added to the
                    // reputation a player can expect for completing it.
                    let on_success = r
                        .get("missionResults")
                        .and_then(Value::as_array)
                        .and_then(|a| a.first())
                        .and_then(Value::as_bool)
                        .unwrap_or(true);
                    if !on_success {
                        continue;
                    }
                    if let Some(amounts) = r.get("contractResultReputationAmounts") {
                        if let Some(reward) = amounts.get("reward").and_then(Value::as_str) {
                            rep_reward_refs.push(reward.to_string());
                        }
                        if faction_ref.is_none() {
                            faction_ref = amounts
                                .get("factionReputation")
                                .and_then(Value::as_str)
                                .map(str::to_string);
                        }
                    }
                }
                _ => {}
            }
        }
    }

    Some(ContractInfo {
        title,
        description,
        debug_name: n
            .get("debugName")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_string),
        rewards,
        unreleased: n.get("notForRelease").and_then(Value::as_bool).unwrap_or(false)
            || n.get("workInProgress").and_then(Value::as_bool).unwrap_or(false),
        rep_reward_refs,
        faction_ref,
        min_standing_ref: n.get("minStanding").and_then(Value::as_str).map(str::to_string),
        max_standing_ref: n.get("maxStanding").and_then(Value::as_str).map(str::to_string),
        cooldown: apply_cooldown_overrides(params, cooldown),
    })
}

/// Blueprints a reward pool can hand out, with the loc key of each item name.
///
/// The name is two hops away: a `CraftingBlueprintRecord` only carries
/// `@LOC_PLACEHOLDER`, and the real name sits on the entity it crafts
/// (`processSpecificData.entityClass` → `Localization.Name`).
fn pool_items(
    db: &Database,
    pool_idx: usize,
    by_path: &HashMap<String, usize>,
    cache: &mut HashMap<usize, Value>,
) -> Vec<BlueprintItem> {
    let Some(pool_json) = record_json(db, pool_idx, cache) else { return Vec::new() };
    let mut refs = Vec::new();
    walk(&pool_json, &mut |n| {
        if type_of(n) == Some("BlueprintReward") {
            if let Some(r) = n.get("blueprintRecord").and_then(Value::as_str) {
                refs.push(r.to_string());
            }
        }
    });

    let mut seen = BTreeSet::new();
    let mut items = Vec::new();
    for r in refs {
        let Some(idx) = resolve_ref(&r, by_path) else { continue };
        let name = db.resolve_string2(db.records()[idx].name_offset);
        let record = name
            .strip_prefix("CraftingBlueprintRecord.")
            .unwrap_or(name)
            .to_string();
        if !seen.insert(record.clone()) {
            continue;
        }
        let name_loc_key = record_json(db, idx, cache)
            .as_ref()
            .and_then(find_entity_class)
            .and_then(|entity_ref| record_value(db, &entity_ref, by_path, cache))
            .and_then(|entity| find_item_name_key(&entity));
        items.push(BlueprintItem { record, name_loc_key });
    }
    items.sort_by(|a, b| a.record.cmp(&b.record));
    items
}

/// `processSpecificData.entityClass` of a crafting blueprint, if it has one.
fn find_entity_class(blueprint: &Value) -> Option<String> {
    let mut found = None;
    walk(blueprint, &mut |n| {
        if found.is_none() {
            if let Some(e) = n.get("entityClass").and_then(Value::as_str) {
                found = Some(e.to_string());
            }
        }
    });
    found
}

/// `Localization.Name` on an item entity - the "@item_Name_…" key.
fn find_item_name_key(entity: &Value) -> Option<String> {
    let mut found = None;
    walk(entity, &mut |n| {
        if found.is_none() && type_of(n) == Some("SCItemLocalization") {
            found = loc_key(n.get("Name"));
        }
    });
    found
}

fn record_json(db: &Database, idx: usize, cache: &mut HashMap<usize, Value>) -> Option<Value> {
    if let Some(v) = cache.get(&idx) {
        return Some(v.clone());
    }
    let bytes = export::to_json(db, &db.records()[idx]).ok()?;
    let value: Value = serde_json::from_slice(&bytes).ok()?;
    cache.insert(idx, value.clone());
    Some(value)
}

/// Turns `file://./../../libs/foundry/records/x/y.json` into a record index.
fn resolve_ref(reference: &str, by_path: &HashMap<String, usize>) -> Option<usize> {
    let rest = reference.strip_prefix("file://")?;
    // The reference is relative and full of `..` hops, but it always contains
    // the absolute record path - anchor on that instead of resolving the hops.
    let anchored = rest.find("libs/foundry/records/").map(|i| &rest[i..])?;
    by_path.get(&strip_ext(anchored)).copied()
}

fn strip_ext(path: &str) -> String {
    let p = path.replace('\\', "/").to_ascii_lowercase();
    match p.rfind('.') {
        Some(i) if p.len() - i <= 6 => p[..i].to_string(),
        _ => p,
    }
}

fn type_of(node: &Value) -> Option<&str> {
    node.get("_Type_").and_then(Value::as_str)
}

/// Depth-first walk over every object in the tree.
fn walk<'a>(node: &'a Value, f: &mut impl FnMut(&'a Value)) {
    match node {
        Value::Object(map) => {
            f(node);
            for v in map.values() {
                walk(v, f);
            }
        }
        Value::Array(items) => {
            for v in items {
                walk(v, f);
            }
        }
        _ => {}
    }
}

fn read_or_die(install_path: &str, version: &str, path: &str, what: &str) -> Vec<u8> {
    match read_p4k_file(install_path, version, path) {
        Ok(b) => b,
        Err(e) => {
            eprintln!("Could not read the {what} ({path}): {e}");
            std::process::exit(1);
        }
    }
}

/// Build string from `build_manifest.id`, so the output says which patch it
/// belongs to.
fn read_build_id(install_path: &str, version: &str) -> Option<String> {
    let path = penguin_citizen_lib::sc_config::sc_base_dir(install_path, version)
        .ok()?
        .join("build_manifest.id");
    let text = std::fs::read_to_string(path).ok()?;
    let value: Value = serde_json::from_str(&text).ok()?;
    value.get("Data")?.get("Version")?.as_str().map(str::to_string)
}

fn mib(bytes: usize) -> f64 {
    bytes as f64 / 1024.0 / 1024.0
}

/// Resolves a `file://` reference and returns the record's `_RecordValue_`.
fn record_value(
    db: &Database,
    reference: &str,
    by_path: &HashMap<String, usize>,
    cache: &mut HashMap<usize, Value>,
) -> Option<Value> {
    let idx = resolve_ref(reference, by_path)?;
    record_json(db, idx, cache)?.get("_RecordValue_").cloned()
}

/// Resolves a standing reference into its rank name, display key and threshold.
fn standing(
    db: &Database,
    reference: Option<&str>,
    by_path: &HashMap<String, usize>,
    cache: &mut HashMap<usize, Value>,
) -> Option<Standing> {
    let reference = reference?;
    let v = record_value(db, reference, by_path, cache)?;
    Some(Standing {
        record: short_ref(reference),
        name: v.get("name").and_then(Value::as_str).map(str::to_string),
        display_loc_key: loc_key(v.get("displayName")),
        min_reputation: v.get("minReputation").and_then(Value::as_i64),
    })
}

/// `"@Adagio_RepUI_DisplayName"` → `"Adagio_RepUI_DisplayName"`.
///
/// Display names are themselves `global.ini` keys, so they are kept as keys:
/// that way the app can show them in whatever language the user runs.
fn loc_key(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .and_then(|s| s.strip_prefix('@'))
        .filter(|s| !s.is_empty() && *s != "blank_space")
        .map(str::to_string)
}

/// Trims a `file://…` reference down to the record path, for readable output.
fn short_ref(reference: &str) -> String {
    reference
        .find("libs/foundry/records/")
        .map(|i| strip_ext(&reference[i..]))
        .unwrap_or_else(|| reference.to_string())
}

// ─── injection ──────────────────────────────────────────────────────────────

/// Writes a `global.ini` with blueprint markers applied.
///
/// Mirrors what the removed `inject_blueprints_with_stats` did: the marker is
/// *prepended* to the mission title and the blueprint block *appended* to the
/// description, everything else stays byte-identical. Newlines inside a value
/// are the literal two characters `\` and `n` - Star Citizen's own parser turns
/// those into line breaks, a real newline would end the entry.
fn run_injection(
    entries: &[MissionEntry],
    in_path: &str,
    out_path: &str,
    lang: &str,
    block_at_top: bool,
) {
    let raw = match std::fs::read(in_path) {
        Ok(b) => b,
        Err(e) => {
            eprintln!("Could not read {in_path}: {e}");
            std::process::exit(1);
        }
    };
    let text = String::from_utf8_lossy(&raw).into_owned();

    // Keep every line as it was; only the values of matched keys change.
    let mut lines: Vec<String> = text.split('\n').map(str::to_string).collect();

    // key (lower-cased, variant suffix stripped) → every line holding it.
    // A key can appear as both `Foo_Title_001` and `Foo_Title_001,P`, and the
    // player may be shown either, so both get the marker.
    let mut index: HashMap<String, Vec<usize>> = HashMap::new();
    for (i, line) in lines.iter().enumerate() {
        let Some((key, _)) = line.split_once('=') else { continue };
        let key = key.trim();
        let base = key.split_once(',').map(|(b, _)| b).unwrap_or(key);
        index.entry(base.to_ascii_lowercase()).or_default().push(i);
    }

    // Values are needed to render rank and item names in the target language.
    let lookup: HashMap<String, String> = lines
        .iter()
        .filter_map(|l| l.split_once('='))
        .map(|(k, v)| {
            let k = k.trim();
            let base = k.split_once(',').map(|(b, _)| b).unwrap_or(k);
            (base.to_ascii_lowercase(), v.to_string())
        })
        .collect();
    // A resolved value can itself contain the literal "\\n" - the rank name
    // `RepScope_Contractor_Rank6` is "AUFTRAGNEHMER\\nELITE". Embedding that
    // verbatim would break the single line we are building, so it collapses
    // to a space.
    let resolve = |key: &Option<String>| -> Option<String> {
        let value = lookup.get(&key.as_ref()?.to_ascii_lowercase())?;
        let flattened = value.replace("\\n", " ");
        Some(flattened.split_whitespace().collect::<Vec<_>>().join(" "))
    };

    // A mission line usually has several description strings and the game picks
    // one at runtime - the contract declares `…_desc_ToRuinStation` while the
    // player is shown `…_desc_01`. Injecting only the declared key leaves those
    // missions marked in the title with nothing in the body, which is exactly
    // what rjcncpt's file did too.
    //
    // Siblings are keys sharing everything up to and including `_desc`. They
    // are only safe to fill when that prefix belongs to a single mission: for
    // difficulty tiers of one line (`…_Title_E_001` / `_H_` / `_M_`) the
    // siblings are shared, and filling them would show one tier's blueprints
    // on another's.
    let mut owners: HashMap<String, BTreeSet<&str>> = HashMap::new();
    for entry in entries {
        if let Some(base) = desc_base(entry.description_loc_key.as_deref()) {
            owners.entry(base).or_default().insert(entry.title_loc_key.as_str());
        }
    }
    let mut siblings: HashMap<String, Vec<usize>> = HashMap::new();
    for (key, rows) in &index {
        if let Some(base) = desc_base(Some(key)) {
            siblings.entry(base).or_default().extend(rows.iter().copied());
        }
    }

    let mut title_hits = 0usize;
    let mut title_misses = 0usize;
    let mut desc_hits = 0usize;
    let mut desc_misses = 0usize;
    let mut variant_rows = 0usize;
    let mut done: BTreeSet<&str> = BTreeSet::new();

    for entry in entries {
        // One entry per pool, but a mission's title is marked once.
        if !done.insert(entry.title_loc_key.as_str()) {
            continue;
        }
        // Collect every pool belonging to this mission.
        let pools: Vec<&MissionEntry> = entries
            .iter()
            .filter(|e| e.title_loc_key == entry.title_loc_key)
            .collect();

        let marker = marker_for(&pools);
        match index.get(&entry.title_loc_key.to_ascii_lowercase()) {
            Some(targets) => {
                for &i in targets {
                    if let Some((key, value)) = lines[i].clone().split_once('=') {
                        lines[i] = format!("{key}={marker}{value}");
                    }
                }
                title_hits += 1;
            }
            None => title_misses += 1,
        }

        let Some(desc_key) = &entry.description_loc_key else { continue };
        let block = render_block(&pools, lang, &resolve);

        let mut targets: Vec<usize> = index
            .get(&desc_key.to_ascii_lowercase())
            .cloned()
            .unwrap_or_default();
        if let Some(base) = desc_base(Some(desc_key)) {
            if owners.get(&base).is_some_and(|m| m.len() == 1) {
                if let Some(rows) = siblings.get(&base) {
                    targets.extend(rows.iter().copied());
                }
            }
        }
        targets.sort_unstable();
        targets.dedup();

        if targets.is_empty() {
            desc_misses += 1;
        } else {
            for &i in &targets {
                if block_at_top {
                    // Insert after the "key=" so the block leads the value.
                    // The block opens with two literal "\n" separators meant for
                    // appending; at the top they belong after it instead.
                    let body = block.trim_start_matches("\\n");
                    if let Some((key, value)) = lines[i].clone().split_once('=') {
                        lines[i] = format!("{key}={body}\\n\\n{value}");
                    }
                } else {
                    lines[i].push_str(&block);
                }
            }
            desc_hits += 1;
            variant_rows += targets.len();
        }
    }

    let out = lines.join("\n");
    if let Err(e) = std::fs::write(out_path, out.as_bytes()) {
        eprintln!("Could not write {out_path}: {e}");
        std::process::exit(1);
    }

    eprintln!(
        "\n=== injection ({lang}, block {}) ===",
        if block_at_top { "at top" } else { "appended" }
    );
    eprintln!("  source                      : {in_path}");
    eprintln!("  titles marked / not found   : {title_hits} / {title_misses}");
    eprintln!("  descriptions filled / missed: {desc_hits} / {desc_misses}");
    eprintln!("  description lines written   : {variant_rows} (text variants included)");
    eprintln!(
        "  size                        : {:.1} MiB → {:.1} MiB",
        mib(raw.len()),
        mib(out.len())
    );
    eprintln!("  wrote                       : {out_path}");
}

/// `[BP]` when every pool is guaranteed, `[BP?]` when any is a chance.
///
/// Worth being careful with: a guaranteed pool means the mission always rolls
/// *from that pool*, not that a specific blueprint drops. Pools are rank- and
/// region-gated, so the marker promises a category, not an item.
fn marker_for(pools: &[&MissionEntry]) -> String {
    let certain = pools.iter().all(|p| p.chance >= 1.0);
    let tag = if certain { "[BP]" } else { "[BP?]" };
    format!(" <EM4>{tag}</EM4>")
}

/// The block appended to a mission description, in `lang`.
fn render_block(
    pools: &[&MissionEntry],
    lang: &str,
    resolve: &impl Fn(&Option<String>) -> Option<String>,
) -> String {
    let de = lang == "de";
    let mut b = String::new();
    // Literal "\n" - see run_injection.
    let nl = "\\n";
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

    let first = pools[0];
    if let Some(faction) = first.faction.as_ref().and_then(|f| resolve(&f.display_loc_key)) {
        b.push_str(nl);
        b.push_str(&format!("# {}: {faction}", if de { "Fraktion" } else { "Faction" }));
    }
    for (standing, label_de, label_en) in [
        (&first.min_standing, "Min. Reputation", "Min. reputation"),
        (&first.max_standing, "Max. Reputation", "Max. reputation"),
    ] {
        if let Some(st) = standing {
            let name = resolve(&st.display_loc_key)
                .or_else(|| st.name.clone())
                .unwrap_or_default();
            let xp = st.min_reputation.unwrap_or(0);
            b.push_str(nl);
            b.push_str(&format!(
                "# {}: {name} ({xp} XP)",
                if de { label_de } else { label_en }
            ));
        }
    }
    if let Some(rep) = first.reputation_reward {
        b.push_str(nl);
        b.push_str(&format!(
            "# {}: {rep} XP",
            if de { "Rufpunkte" } else { "Reputation" }
        ));
    }
    if let Some(cd) = first.cooldown.as_ref().filter(|c| c.has_personal) {
        if let Some(min) = cd.personal_minutes {
            b.push_str(nl);
            b.push_str(&format!(
                "# Cooldown: {min:.0} {}",
                if de { "Minuten" } else { "minutes" }
            ));
        }
    }

    for pool in pools {
        if pool.blueprints.is_empty() {
            continue;
        }
        b.push_str(nl);
        b.push_str(nl);
        let chance = (pool.chance * 100.0).round();
        b.push_str(&format!(
            "# {} ({}: {chance:.0}%):",
            if de { "Baupläne" } else { "Blueprints" },
            if de { "Chance" } else { "chance" }
        ));
        for item in &pool.blueprints {
            let name = resolve(&item.name_loc_key).unwrap_or_else(|| item.record.clone());
            b.push_str(nl);
            b.push_str(&format!("    - {name}"));
        }
    }
    b
}

/// Everything up to and including `_desc`, lower-cased - the key a mission's
/// description variants share. `None` when the key has no `_desc` part.
fn desc_base(key: Option<&str>) -> Option<String> {
    let key = key?;
    let lower = key.to_ascii_lowercase();
    let at = lower.find("_desc")?;
    Some(lower[..at + "_desc".len()].to_string())
}
