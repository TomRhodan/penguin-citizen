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
    /// Blueprint record names in that pool.
    blueprints: Vec<String>,
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
    let version = args.get(2).map(String::as_str).unwrap_or("LIVE");
    let out_path = args.get(3).map(String::as_str);

    // Discovery helper: `--find <needle>` reports which records contain a given
    // string. Used to track down where a mission that the extractor misses is
    // actually defined.
    let find_needle = args.iter().position(|a| a == "--find").and_then(|i| args.get(i + 1)).cloned();
    // `--dump-path <substring>` prints the first record whose path matches, so
    // the shape of a referenced record can be inspected without guessing.
    let dump_path = args.iter().position(|a| a == "--dump-path").and_then(|i| args.get(i + 1)).cloned();

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
                let blueprints = pool_item_names(&db, pool_idx, &by_path, &mut json_cache);
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

/// Blueprint record names a reward pool can hand out.
fn pool_item_names(
    db: &Database,
    pool_idx: usize,
    by_path: &HashMap<String, usize>,
    cache: &mut HashMap<usize, Value>,
) -> Vec<String> {
    let Some(pool_json) = record_json(db, pool_idx, cache) else { return Vec::new() };
    let mut refs = Vec::new();
    walk(&pool_json, &mut |n| {
        if type_of(n) == Some("BlueprintReward") {
            if let Some(r) = n.get("blueprintRecord").and_then(Value::as_str) {
                refs.push(r.to_string());
            }
        }
    });

    let mut names = BTreeSet::new();
    for r in refs {
        let Some(idx) = resolve_ref(&r, by_path) else { continue };
        let name = db.resolve_string2(db.records()[idx].name_offset);
        let label = name.strip_prefix("CraftingBlueprintRecord.").unwrap_or(name);
        names.insert(label.to_string());
    }
    names.into_iter().collect()
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
