/*
 * Penguin Citizen - Star Citizen Linux Manager
 * Copyright (C) 2024-2026 TomRhodan <tomrhodan@gmail.com>
 * Licensed under GPL-3.0-or-later
 */

/**
 * Central state store for the Environments page.
 *
 * All environment-scoped state lives here as a single object.
 * Modules access state via getState() and mutate via setState().
 * This replaces 77+ module-level let variables with one explicit,
 * inspectable source of truth.
 *
 * @module pages/environments/state
 */

/**
 * Initial state values. Used on first load and by resetState().
 * Grouped by domain for readability.
 */
const INITIAL_STATE = Object.freeze({
  // ── General ──
  config: null,
  activeScVersion: null,
  scVersions: [],
  renderGeneration: 0,
  migrationChecked: false,

  // ── Tab navigation ──
  activeProfileTab: 'profile',

  // ── Event listener handles (cleanup) ──
  unlistenProgress: null,
  unlistenCopyComplete: null,
  unlistenLaunchStarted: null,
  unlistenLaunchExited: null,
  postGameListenerRegistered: false,

  // ── Data.p4k / Versions ──
  copyingVersion: null,

  // ── USER.cfg ──
  userCfgSettings: {},
  savedUserCfgSnapshot: {},
  savedUserCfgRaw: '',
  collapsedCategories: null, // Set — initialized in createState()

  // ── Attributes sync ──
  savedAttributesHash: '',
  savedAttributesValues: {},
  pendingConflicts: [],
  preLaunchAttributesHash: '',

  // ── Bindings / Keybindings ──
  parsedActionMaps: null,
  actionDefinitions: null,
  completeBindingList: [],
  exportedLayouts: [],
  selectedBindingSource: null,
  bindingFilter: '',
  bindingCategory: 'all',
  activeCategoryKey: null,
  bindingEditorAction: null,
  bindingEditorDevice: 'keyboard',
  customizedOnly: false,
  essentialsOnly: true,
  boundOnly: false,
  useHumanReadable: true,

  // ── Profiles / Backups ──
  backups: [],
  lastRestoredBackupId: null,
  activeProfileStatus: null,
  showChangesPanel: false,
  draggedJoystickInstance: null,
  _profilesDelegatedClickHandler: null,

  // ── Localization ──
  localizationStatus: null,
  localizationLabels: {},
  availableLanguages: [],
  localizationLoaded: false,
  remoteLanguageInfo: [],
  localizationLoading: false,

  // ── Tuning ──
  deviceTuningData: [],
});

/** Live state — the single mutable source of truth */
let state = createState();

/** Per-version profile tracking (persists across version switches) */
export const lastRestoredPerVersion = {};

/** Essential actions set (constant, never changes) */
export const ESSENTIAL_ACTIONS = new Set([
  'v_flightready', 'v_gear_toggle', 'v_quantum_toggle', 'v_quantum_engage',
  'v_weapon_group1', 'v_weapon_group2',
  'v_pitch', 'v_yaw', 'v_roll', 'v_strafe_vertical', 'v_strafe_lateral',
  'v_strafe_longitudinal', 'v_target_cycle_all_fwd', 'v_target_cycle_all_back',
  'v_scan_toggle', 'v_scan_activate', 'v_ifcs_mode_shift',
  'v_ifcs_toggle_vector_decoupling', 'v_space_brake', 'v_boost',
]);

/**
 * Creates a fresh state object from INITIAL_STATE.
 * Handles non-primitive defaults (Set, etc.) that can't be in Object.freeze.
 */
function createState() {
  return {
    ...INITIAL_STATE,
    collapsedCategories: new Set(['quality', 'shaders', 'textures', 'effects', 'clarity', 'lod', 'input', 'advanced']),
  };
}

/**
 * Returns the current state. Modules read state via this function.
 * @returns {Object} The live state object
 */
export function getState() {
  return state;
}

/**
 * Updates state properties. Merges the updates into the current state.
 * @param {Object} updates - Key-value pairs to merge into state
 */
export function setState(updates) {
  Object.assign(state, updates);
}

/**
 * Resets ALL environment-scoped state to initial values.
 * Called before switching SC versions to prevent state contamination.
 * Does NOT reset cross-version state (lastRestoredPerVersion, ESSENTIAL_ACTIONS).
 */
export function resetState() {
  // Preserve fields that persist across version switches:
  // - App-level: config, render tracking, migration flag
  // - Tauri listeners: launch event handles (registered once)
  // - Localization labels: game-wide, not version-specific — reloading
  //   on every switch causes a wasteful double-render cycle
  const { config, renderGeneration, migrationChecked, postGameListenerRegistered,
          unlistenLaunchStarted, unlistenLaunchExited,
          localizationLoaded, localizationLabels, actionDefinitions } = state;

  state = createState();

  state.config = config;
  state.renderGeneration = renderGeneration;
  state.migrationChecked = migrationChecked;
  state.postGameListenerRegistered = postGameListenerRegistered;
  state.unlistenLaunchStarted = unlistenLaunchStarted;
  state.unlistenLaunchExited = unlistenLaunchExited;
  state.localizationLoaded = localizationLoaded;
  state.localizationLabels = localizationLabels;
  state.actionDefinitions = actionDefinitions;
}
