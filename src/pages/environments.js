/*
 * Penguin Citizen - Star Citizen Linux Manager
 * Copyright (C) 2024-2026 TomRhodan <tomrhodan@gmail.com>
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

/**
 * Penguin Citizen - Environments Page (formerly Profiles)
 *
 * This module manages Star Citizen configuration per environment (LIVE, PTU, etc.):
 * - USER.cfg editing (resolution, graphics, performance settings)
 * - Controller/actionmap management (edit, add, delete keybindings)
 * - Profile management: save, load, compare, transfer snapshots
 * - Joystick reordering via drag-and-drop
 * - Localization (install, update, remove community language packs)
 * - Version/storage management (copy Data.p4k, symlink, delete environments)
 *
 * @module pages/environments
 */

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { open } from '@tauri-apps/plugin-dialog';
import { confirm, prompt, showDiff, showNotification } from '../utils/dialogs.js';
import { logError } from '../utils/error-handler.js';
import { escapeHtml } from '../utils.js';
import { t } from '../i18n.js';

// ==================== Debug Logging ====================

/**
 * Centralized debug logging function.
 * Logs to both console and to file via Rust backend.
 * @param {string} category - Log category (e.g., 'BINDING', 'CAPTURE', 'UI')
 * @param {string} level - Log level: 'debug', 'info', 'warn', 'error'
 * @param {string} message - Log message
 */
function debugLog(category, level, message) {
    // Always log to console
    const prefix = `[${category}]`;
    switch (level) {
        case 'error':
            console.error(prefix, message);
            break;
        case 'warn':
            console.warn(prefix, message);
            break;
        case 'info':
            console.info(prefix, message);
            break;
        default:
            console.log(prefix, message);
    }

    // Also send to Rust logging system (file)
    invoke('app_log', { level, category, message }).catch(e => {
        console.error('Failed to send log to backend:', e);
    });
}

// ==================== State ====================

/** @type {Object|null} App configuration (install path, runner, etc.) */
let config = null;
/** @type {Object} Current USER.cfg settings as key-value pairs */
let userCfgSettings = {};
/** @type {string|null} Currently selected SC version (e.g., "LIVE", "PTU") */
let activeScVersion = null;
/** @type {Array} Detected SC versions with metadata (path, Data.p4k, etc.) */
let scVersions = [];

// Data.p4k copy state
/** @type {Object|null} Active copy operation: { version: string, startTime: number } */
let copyingVersion = null;

// Event listener cleanup (prevents memory leaks on page navigation and re-renders)
/** @type {Function|null} Unlisten function for Data.p4k copy progress events */
let unlistenProgress = null;
/** @type {Function|null} Unlisten function for Data.p4k copy-complete events */
let unlistenCopyComplete = null;
/** @type {Function|null} Unlisten function for launch-started event (post-game attribute sync) */
let unlistenLaunchStarted = null;
/** @type {Function|null} Unlisten function for launch-exited event (post-game attribute sync) */
let unlistenLaunchExited = null;

// Binding and profile state
/** @type {Object|null} Parsed actionmaps from actionmaps.xml */
let parsedActionMaps = null;
/** @type {Object|null} Action definitions from the backend (categories, display names) */
let actionDefinitions = null;
/** @type {Array} Complete list of all keybindings (default + custom) */
let completeBindingList = [];
/** @type {Array} Exported layout files */
let exportedLayouts = [];
/** @type {string|null} Selected binding source: null = active profile, string = layout filename */
let selectedBindingSource = null;
/** @type {Array} All saved profiles (backups) for the active version */
let backups = [];
/** @type {string} Current search term for binding filtering */
let bindingFilter = '';
/** @type {string} Active binding category filter */
let bindingCategory = 'all';
/** @type {Set<string>} Collapsed USER.cfg categories */
let collapsedCategories = new Set(['quality', 'shaders', 'textures', 'effects', 'clarity', 'lod', 'input', 'advanced']);
/** @type {Set<string>} Which binding categories are expanded (must be global for inline onclick) */
window.expandedBindingCategories = new Set();
// Active category in the new sidebar layout (replaces expandedBindingCategories)
let activeCategoryKey = null;
/** @type {number|null} Instance number of the joystick currently being dragged */
let draggedJoystickInstance = null;
/** @type {string} Active tab: 'profile' | 'usercfg' | 'localization' | 'storage' */
let activeProfileTab = 'profile';
/** @type {string|null} ID of the currently loaded/active profile */
let lastRestoredBackupId = null;
/** @type {Object} Mapping: SC version -> last active profile ID (per version) */
const lastRestoredPerVersion = {};
/** @type {Object|null} Profile status: { matched, files } - shows if profile is in sync with SC files */
let activeProfileStatus = null;
/** @type {boolean} Whether the changes detail panel is shown */
let showChangesPanel = false;
/** @type {Function|null} Delegated click handler stored for removal before re-registration */
let _profilesDelegatedClickHandler = null;
/** @type {Object} Snapshot of USER.cfg at last load/save (for change detection) */
let savedUserCfgSnapshot = {};
/** @type {string} Raw USER.cfg content at last load/save (for external change detection) */
let savedUserCfgRaw = '';
/** @type {string} SHA256 hash of attributes.xml at last load/save (for sync change detection) */
let savedAttributesHash = '';
/** @type {Object} Last known attribute values from attributes.xml (for conflict display) */
let savedAttributesValues = {};
/** @type {Array} Pending conflicts between our values and in-game changes */
let pendingConflicts = [];
/** @type {string} Pre-launch attributes hash (saved before game starts) */
let preLaunchAttributesHash = '';
/** @type {boolean} Whether the post-game listener has been registered */
let postGameListenerRegistered = false;
/** @type {Object|null} Localization status of the active version (installed language, commit, etc.) */
let localizationStatus = null;
/** @type {Object} HashMap: technical action ID -> translated label from localization data */
let localizationLabels = {};
/** @type {Array} Available language packs */
let availableLanguages = [];
/** @type {boolean} Whether the localization labels have already been loaded */
let localizationLoaded = false;
/** @type {Array} Remote information about language packs (last update, commit date) */
let remoteLanguageInfo = [];
/** @type {boolean} Whether a localization operation is currently running */
let localizationLoading = false;

// Binding editor state
/** @type {Object|null} The action currently being edited in the editor */
let bindingEditorAction = null;
/** @type {string} Selected device type in editor: 'keyboard' | 'mouse' | 'gamepad' | 'joystick' */
let bindingEditorDevice = 'keyboard';
/** @type {boolean} Filter: Only show user-customized bindings */
let customizedOnly = false;
/** @type {boolean} Filter: Only show essential bindings */
let essentialsOnly = true;
/** @type {boolean} Filter: Only show bindings that have at least one input (default or custom) */
let boundOnly = false;

const ESSENTIAL_ACTIONS = new Set([
  'v_flightready', 'v_gear_toggle', 'v_quantum_toggle', 'v_quantum_engage', 'v_weapon_group1', 'v_weapon_group2',
  'v_pitch', 'v_yaw', 'v_roll', 'v_strafe_vertical', 'v_strafe_lateral', 'v_strafe_longitudinal',
  'v_target_cycle_all_fwd', 'v_target_cycle_all_back', 'v_scan_toggle', 'v_scan_activate',
  'v_ifcs_mode_shift', 'v_ifcs_toggle_vector_decoupling', 'v_space_brake', 'v_boost'
]);

/** @type {boolean} Toggle: Human-readable input names (e.g., "Button #5") instead of raw format ("button5") */
let useHumanReadable = true;
/** @type {number} Monotonic counter for detecting stale render passes */
let renderGeneration = 0;
/** @type {boolean} Whether the one-time migration check has already been performed */
let migrationChecked = false;
/** @type {Array} Tuning data for all joystick devices (from get_device_tuning) */
let deviceTuningData = [];

/**
 * Resets ALL environment-scoped module state before switching to a new SC version.
 *
 * Call this before changing activeScVersion so the subsequent renderEnvironments()
 * starts completely fresh. Never scatter individual resets across the codebase —
 * always add new environment-scoped variables here.
 */
function resetEnvironmentState() {
  // Kill any running Wine helper and stop hardware capture
  invoke('stop_input_capture').catch(err => logError(err, 'environments:stop_input_capture'));

  // Close any modals that belong to the outgoing environment (binding editor,
  // tuning editor, diff viewer — anything appended to document.body)
  document.querySelectorAll(
    '#binding-editor-modal, #mouse-binding-editor-modal, .modal-overlay'
  ).forEach(m => m.remove());

  // Remove the delegated click handler so attachProfilesEventListeners() starts fresh
  if (_profilesDelegatedClickHandler) {
    document.removeEventListener('click', _profilesDelegatedClickHandler);
    _profilesDelegatedClickHandler = null;
  }

  // Data — sourced from the SC version; must be refetched for every env
  backups = [];
  completeBindingList = [];
  deviceTuningData = [];
  parsedActionMaps = null;
  exportedLayouts = [];
  activeProfileStatus = null;
  localizationStatus = null;
  localizationLabels = {};
  availableLanguages = [];
  localizationLoaded = false;
  remoteLanguageInfo = [];
  localizationLoading = false;
  userCfgSettings = {};
  savedUserCfgSnapshot = {};
  savedUserCfgRaw = '';
  savedAttributesHash = '';
  savedAttributesValues = {};
  pendingConflicts = [];

  // UI state — reset to defaults so filters from LIVE don't bleed into HOTFIX
  showChangesPanel = false;
  bindingFilter = '';
  bindingCategory = 'all';
  selectedBindingSource = null;
  bindingEditorAction = null;
  activeProfileTab = 'profile';
  activeCategoryKey = null;
  draggedJoystickInstance = null;
  customizedOnly = false;
  essentialsOnly = true;
  boundOnly = false;
}

// Which collapsible panels are open (persists within the session)
if (!window.expandedPanels) window.expandedPanels = { bindings: false, devices: false, tuning: false };

// ==================== Contextual Hints ====================

/**
 * Reads the IDs of already dismissed hints from localStorage.
 * @returns {string[]} Array of dismissed hint IDs
 */
function getDismissedHints() {
  try {
    return JSON.parse(localStorage.getItem('penguincitizen-dismissed-hints') || '[]');
  } catch { return []; }
}

/**
 * Permanently dismisses a hint and saves the decision in localStorage.
 * Also removes the hint banner from the DOM if present.
 * @param {string} id - Unique identifier of the hint to dismiss
 */
function dismissHint(id) {
  const dismissed = getDismissedHints();
  if (!dismissed.includes(id)) {
    dismissed.push(id);
    localStorage.setItem('penguincitizen-dismissed-hints', JSON.stringify(dismissed));
  }
  const el = document.querySelector(`.hint-banner[data-hint-id="${id}"]`);
  if (el) el.remove();
}

/**
 * Renders a hint banner that the user can permanently dismiss.
 * Returns an empty string if the hint has already been dismissed.
 * @param {string} id - Unique ID of the hint
 * @param {string} html - HTML content of the hint text
 * @returns {string} HTML string of the banner or empty string
 */
function renderHint(id, html) {
  if (getDismissedHints().includes(id)) return '';
  return `
    <div class="hint-banner" data-hint-id="${id}">
      <svg class="hint-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <circle cx="12" cy="12" r="10"></circle>
        <line x1="12" y1="16" x2="12" y2="12"></line>
        <line x1="12" y1="8" x2="12.01" y2="8"></line>
      </svg>
      <span class="hint-text">${html}</span>
      <button class="hint-dismiss" data-action="dismiss-hint" data-hint-id="${id}">${t('environments:hint.gotIt')}</button>
    </div>
  `;
}

/**
 * Default USER.cfg settings with metadata.
 * Each entry defines: default value, label, min/max, step size,
 * category, description, and detailed help text.
 * The categories control the grouping in the UI.
 */
const DEFAULT_SETTINGS = {
  // Essential settings (visible by default)
  _resolution: { value: '1920x1080', label: 'Resolution', category: 'essential', type: 'resolution', virtual: true,
    target: 'attributes', attrName: 'Width', attrNameHeight: 'Height',
    desc: 'Render resolution (width x height)',
    help: 'Sets the internal rendering resolution. Higher resolutions produce sharper images but significantly increase GPU load. Match your monitor\'s native resolution for best clarity; lower it for better performance on weaker GPUs.' },
  _windowMode: { value: 2, label: 'Window Mode', min: 0, max: 2, step: 1, category: 'essential', labels: ['Windowed', 'Fullscreen', 'Borderless'], virtual: true,
    target: 'attributes', attrName: 'WindowMode',
    desc: 'Windowed, Fullscreen, or Borderless mode',
    help: 'Controls how the game window is displayed. Fullscreen gives exclusive GPU access for best performance. Borderless allows easy Alt-Tab but may add slight input lag. Windowed mode is useful for multi-tasking but has the most overhead.' },
  'r.graphicsRenderer': { value: 0, label: 'Graphics Renderer', min: 0, max: 1, step: 1, category: 'essential', labels: ['Vulkan', 'DX11'],
    target: 'usercfg',
    desc: 'Graphics API: Vulkan (recommended) or DX11',
    help: 'Selects the graphics API. Vulkan is the default since 4.0 and pre-builds shaders to reduce stuttering. DX11 is a legacy fallback with generally worse performance. Only switch to DX11 if Vulkan causes crashes on your hardware.' },
  r_VSync: { value: 0, label: 'VSync', min: 0, max: 1, type: 'toggle', category: 'essential',
    target: 'attributes', attrName: 'VSync',
    desc: 'Sync frames to monitor refresh rate',
    help: 'Synchronizes rendered frames with your monitor\'s refresh rate to eliminate screen tearing. Adds input latency and can reduce FPS if your system can\'t maintain the refresh rate. Disable for lowest input lag; enable if tearing is distracting.' },
  r_VSync_disablePIAdjustment: { value: 1, label: 'VSync PI Fix', min: 0, max: 1, type: 'toggle', category: 'essential',
    target: 'usercfg',
    desc: 'Disable VSync time-step PI adjustment',
    help: 'Disables the proportional-integral adjustment for VSync frame timing. Can fix micro-judder when VSync is enabled. If you experience slight stuttering with VSync on, try toggling this. No effect when VSync is off.' },
  sys_MaxFPS: { value: 0, label: 'Max FPS', min: 0, max: 300, step: 5, category: 'essential',
    target: 'usercfg',
    desc: 'Frame rate cap (0 = unlimited)',
    help: 'Limits the maximum frames per second. Set to 0 for no limit, or cap at your monitor\'s refresh rate to reduce GPU heat and power usage. Capping slightly below your monitor\'s refresh rate (e.g. 141 for a 144Hz display) can smooth frame pacing.' },
  sys_MaxIdleFPS: { value: 30, label: 'Max Idle FPS', min: 5, max: 120, step: 5, category: 'essential',
    target: 'usercfg',
    desc: 'Frame rate cap when window is not focused',
    help: 'Limits FPS when Star Citizen is in the background or minimized. Reduces GPU/CPU usage and heat while Alt-Tabbed. Lower values save more power; 15-30 is recommended for background idle.' },
  'r.TSR': { value: 0, label: 'Upscaling', min: 0, max: 2, step: 1, category: 'essential', labels: ['Off', 'TSR', 'DLSS'],
    target: 'attributes', attrName: 'Upscaling',
    desc: 'Upscaling technique (Off, TSR, or DLSS)',
    help: 'Selects the upscaling method. TSR (Temporal Super Resolution) is CryEngine\'s built-in upscaler, rendering at lower resolution and reconstructing a sharper image. DLSS uses NVIDIA hardware for AI-based upscaling (requires RTX GPU). Off disables upscaling and temporal anti-aliasing.' },
  r_DisplayInfo: { value: 0, label: 'Debug HUD', min: 0, max: 4, step: 1, category: 'essential',
    target: 'usercfg',
    desc: 'Performance debug overlay (0=off, 1-4 detail)',
    help: 'Shows real-time performance metrics on screen. Level 1 shows basic FPS, level 2 adds frame timing, level 3 includes RAM/VRAM usage, and level 4 shows GPU load statistics. Useful for troubleshooting; disable for normal play.' },
  r_displayFrameGraph: { value: 0, label: 'Frame Graph', min: 0, max: 1, type: 'toggle', category: 'essential',
    target: 'usercfg',
    desc: 'Frame timing graph overlay',
    help: 'Shows a real-time frame timing graph for performance analysis. Helps identify stuttering patterns, frame spikes, and GPU/CPU bottlenecks. Enable temporarily for troubleshooting; disable for normal play.' },
  r_DisplaySessionInfo: { value: 0, label: 'Session Info QR', min: 0, max: 1, type: 'toggle', category: 'essential',
    target: 'usercfg', alwaysWrite: true,
    desc: 'QR code overlay for bug reports (PTU default: on)',
    help: 'Displays a QR code on screen containing session information for Star Citizen bug reports. PTU enables this by default - Penguin Citizen always writes this setting explicitly so the QR code stays off unless you enable it.' },
  // Graphics Quality (verified)
  sys_spec: { value: 3, label: 'Overall Quality', min: 1, max: 4, step: 1, category: 'quality',
    target: 'attributes', attrName: 'SysSpec',
    desc: 'Master quality preset (1=Low, 4=Very High)',
    help: 'Sets the global graphics quality preset, overriding all individual sys_spec settings. 1=Low, 2=Medium, 3=High, 4=Very High. Higher settings increase visual fidelity but require a more powerful GPU and CPU. Adjust individual settings below to fine-tune after choosing a base preset.' },
  sys_spec_GameEffects: { value: 3, label: 'Game Effects', min: 1, max: 4, step: 1, category: 'quality',
    target: 'usercfg', overrideWarning: true,
    desc: 'Quality of in-game visual effects',
    help: 'Controls the quality of gameplay visual effects such as explosions, energy weapons, shield impacts, and environmental effects. Lowering this can improve FPS in combat-heavy situations with many simultaneous effects on screen.' },
  sys_spec_ObjectDetail: { value: 3, label: 'Object Detail', min: 1, max: 4, step: 1, category: 'quality',
    target: 'usercfg', overrideWarning: true,
    desc: 'Geometric detail level of objects',
    help: 'Controls the polygon count and detail level of ships, stations, and props. Higher values show more detailed 3D models at greater distances. Lowering this reduces GPU vertex processing load and can help in crowded areas like landing zones.' },
  sys_spec_Particles: { value: 3, label: 'Particles', min: 1, max: 4, step: 1, category: 'quality',
    target: 'usercfg', overrideWarning: true,
    desc: 'Particle system quality and density',
    help: 'Controls the density, resolution, and complexity of particle effects (smoke, fire, exhaust, debris). Lower values reduce particle counts and simplify effects, which can significantly help FPS during explosions and atmospheric flight.' },
  sys_spec_Physics: { value: 3, label: 'Physics', min: 1, max: 4, step: 1, category: 'quality',
    target: 'usercfg', overrideWarning: true,
    desc: 'Physics simulation detail level',
    help: 'Controls the complexity of physics simulations including debris, ragdoll, and environmental interactions. Higher values allow more physics objects and more accurate collision. Lowering this is CPU-bound and helps on systems with weaker processors.' },
  sys_spec_Shading: { value: 3, label: 'Shading', min: 1, max: 4, step: 1, category: 'quality',
    target: 'usercfg', overrideWarning: true,
    desc: 'Material and lighting shading quality',
    help: 'Controls the complexity of surface shading, material rendering, and lighting calculations. Higher values produce more realistic materials and lighting at the cost of GPU shader performance. One of the most impactful settings for visual quality vs. performance.' },
  sys_spec_Shadows: { value: 3, label: 'Shadows', min: 1, max: 4, step: 1, category: 'quality',
    target: 'usercfg', overrideWarning: true,
    desc: 'Shadow map resolution and quality',
    help: 'Controls shadow map resolution, cascade distances, and filtering quality. Higher values produce sharper, more detailed shadows that extend further. Shadows are GPU-intensive; lowering this is one of the most effective ways to improve performance.' },
  sys_spec_Texture: { value: 3, label: 'Textures', min: 1, max: 4, step: 1, category: 'quality',
    target: 'usercfg', overrideWarning: true,
    desc: 'Texture filtering and quality level',
    help: 'Controls texture filtering quality and mipmap selection. Higher values produce sharper textures, especially at oblique angles. Depends heavily on available VRAM. If you see blurry textures, increase this or raise the Stream Pool Size.' },
  sys_spec_Water: { value: 3, label: 'Water', min: 1, max: 4, step: 1, category: 'quality',
    target: 'usercfg', overrideWarning: true,
    desc: 'Water surface rendering quality',
    help: 'Controls the quality of water rendering including reflections, refraction, tessellation, and wave simulation. Higher values produce more realistic water surfaces. Performance impact is mainly noticeable on planets with large bodies of water.' },
  // Shader Quality (verified) — all target: 'usercfg' (no in-game menu equivalent)
  q_ShaderFX: { value: 3, label: 'FX Shaders', min: 0, max: 3, step: 1, category: 'shaders', target: 'usercfg',
    desc: 'Visual effects shader complexity (0-3)',
    help: 'Controls the shader quality for special visual effects like explosions, energy beams, and quantum travel effects. 0=Low, 1=Medium, 2=High, 3=Very High. Lower values simplify effect rendering for better FPS during action sequences.' },
  q_ShaderGeneral: { value: 3, label: 'General', min: 0, max: 3, step: 1, category: 'shaders', target: 'usercfg',
    desc: 'General surface shader quality (0-3)',
    help: 'Controls the quality of general-purpose shaders used for most surfaces and objects. Affects overall material rendering complexity. This is a broad setting that impacts visual quality across the entire scene; lowering it can provide a noticeable FPS boost.' },
  q_ShaderPostProcess: { value: 3, label: 'Post Process', min: 0, max: 3, step: 1, category: 'shaders', target: 'usercfg',
    desc: 'Post-processing shader quality (0-3)',
    help: 'Controls the quality of post-processing effects such as tone mapping, color grading, and screen-space effects. Lower values use simplified post-processing passes. Moderate performance impact; lowering primarily affects visual polish rather than geometry detail.' },
  q_ShaderShadow: { value: 3, label: 'Shadow', min: 0, max: 3, step: 1, category: 'shaders', target: 'usercfg',
    desc: 'Shadow rendering shader quality (0-3)',
    help: 'Controls the complexity of shadow rendering shaders including filtering and soft shadow calculations. Lower values use simpler shadow techniques that render faster. Works in conjunction with sys_spec_Shadows for overall shadow quality.' },
  q_ShaderGlass: { value: 3, label: 'Glass', min: 0, max: 3, step: 1, category: 'shaders', target: 'usercfg',
    desc: 'Glass and transparency shader quality (0-3)',
    help: 'Controls the quality of glass and transparent surface rendering, including refraction, reflection, and multi-layer transparency. Visible on cockpit canopies, windows, and visor HUDs. Lower values simplify transparency calculations.' },
  q_ShaderParticle: { value: 3, label: 'Particle', min: 0, max: 3, step: 1, category: 'shaders', target: 'usercfg',
    desc: 'Particle effect shader quality (0-3)',
    help: 'Controls the shader complexity for particle effects. Unlike q_ShaderFX, this specifically affects how individual particles are rendered (lighting, soft edges, refraction). Not affected by the q_Quality master setting. Lower values can help in particle-heavy scenes.' },
  q_ShaderSky: { value: 3, label: 'Sky', min: 0, max: 3, step: 1, category: 'shaders', target: 'usercfg',
    desc: 'Sky and atmosphere shader quality (0-3)',
    help: 'Controls the quality of sky rendering, atmospheric scattering, and cloud shaders. Higher values produce more realistic planetary atmospheres and space skyboxes. Lower values simplify atmospheric calculations with minor visual differences in space.' },
  q_ShaderWater: { value: 3, label: 'Water', min: 0, max: 3, step: 1, category: 'shaders', target: 'usercfg',
    desc: 'Water surface shader quality (0-3)',
    help: 'Controls the shader complexity for water surfaces including wave simulation, caustics, and subsurface scattering. Works together with sys_spec_Water. Lower values use simplified water rendering that is less GPU-intensive near oceans and lakes.' },
  q_ShaderCompute: { value: 3, label: 'Compute', min: 0, max: 3, step: 1, category: 'shaders', target: 'usercfg',
    desc: 'GPU compute shader quality (0-3)',
    help: 'Controls the quality of GPU compute shaders used for general-purpose GPU calculations like cloth simulation, advanced lighting, and physics effects. Lower values reduce compute shader workload. Impact varies depending on scene complexity.' },
  // Textures (verified)
  r_TexturesStreamPoolSize: { value: 8192, label: 'Stream Pool Size (MB)', min: 2048, max: 16384, step: 1024, category: 'textures', target: 'usercfg',
    desc: 'VRAM allocated for texture streaming (MB)',
    help: 'Sets the amount of VRAM (in MB) reserved for streaming textures. Should be set based on your GPU\'s VRAM: 2048 for 4GB, 4096 for 6GB, 8192 for 8-12GB, 12288+ for 16GB+. Too high causes VRAM overflow and stuttering; too low causes blurry textures.' },
  // Visual Effects (verified)
  r_ssao: { value: 1, label: 'SSAO', min: 0, max: 1, type: 'toggle', category: 'effects', target: 'usercfg',
    desc: 'Screen Space Ambient Occlusion',
    help: 'Adds soft shadows in creases and corners where ambient light is occluded. SSAO is the simpler, older technique compared to SSDO. When SSDO is enabled, SSAO can be disabled (they are somewhat redundant). Disabling both removes ambient shadow detail but improves FPS.' },
  r_ssdo: { value: 2, label: 'Directional Occlusion', min: 0, max: 3, step: 1, category: 'effects', target: 'usercfg',
    desc: 'Screen Space Directional Occlusion quality', labels: ['Off', 'Fast', 'Optimized', 'Reference'],
    help: 'An advanced form of ambient occlusion that also calculates directional light blocking and subtle color bleeding. Produces more realistic lighting than SSAO alone. 0=Off, 1=Fast (local lights + sun), 2=Optimized (all lights + ambient), 3=Reference (debug, very slow). Level 2 is recommended for quality; 1 for performance.' },
  r_SSReflections: { value: 1, label: 'SS Reflections', min: 0, max: 1, type: 'toggle', category: 'effects', target: 'usercfg',
    desc: 'Screen Space Reflections on surfaces',
    help: 'Enables real-time reflections calculated from on-screen geometry. Adds realistic reflections on floors, wet surfaces, and metallic objects. Disabling may cause surfaces to look flat or washed out but can provide a few extra FPS. Most noticeable in interiors and landing zones.' },
  r_HDRDisplayOutput: { value: 0, label: 'HDR Output', min: 0, max: 1, type: 'toggle', category: 'effects', target: 'usercfg',
    desc: 'Enable HDR display output',
    help: 'Enables High Dynamic Range output for HDR-capable monitors. Provides wider color range and higher contrast for more vivid visuals. Only enable if your monitor supports HDR; on SDR monitors this will cause washed-out colors. No significant performance impact.' },
  r_HDRDisplayMaxNits: { value: 1500, label: 'HDR Max Nits', min: 400, max: 4000, step: 100, category: 'effects',
    target: 'attributes', attrName: 'HDRMaxBrightness',
    desc: 'Maximum HDR brightness in nits',
    help: 'Sets the maximum brightness for HDR output in nits. Match this to your monitor\'s peak HDR brightness (check your monitor specs). Too high causes clipping; too low wastes HDR range. Only has effect when HDR Output is enabled.' },
  r_HDRDisplayRefWhite: { value: 200, label: 'HDR Ref White', min: 80, max: 500, step: 10, category: 'effects',
    target: 'attributes', attrName: 'HDRRefWhite',
    desc: 'HDR reference white level in nits',
    help: 'Sets the reference white point for HDR content in nits. Controls the brightness of standard (non-highlight) content. 200 is a good starting point; increase if the image looks dim, decrease if it looks washed out. Only has effect when HDR Output is enabled.' },
  'r.GI.Specular.HalfRes': { value: 1, label: 'GI Specular Half-Res', min: 0, max: 1, type: 'toggle', category: 'effects', target: 'usercfg',
    desc: 'Render specular GI at half resolution',
    help: 'Renders specular global illumination at half resolution for better performance. Reduces the GPU cost of reflective GI calculations with minimal visual difference. Disable for full-resolution specular GI if you have GPU headroom.' },
  'r.GI.Specular.Temporal': { value: 1, label: 'GI Specular Temporal', min: 0, max: 1, type: 'toggle', category: 'effects', target: 'usercfg',
    desc: 'Temporal filtering for specular GI',
    help: 'Enables temporal filtering for specular global illumination, reducing noise by accumulating data across frames. Produces smoother, more stable reflections. Disable only if you notice ghosting artifacts on fast-moving reflective surfaces.' },
  'r.Shadows.ScreenSpace': { value: 1, label: 'Screen-Space Shadows', min: 0, max: 1, type: 'toggle', category: 'effects', target: 'usercfg',
    desc: 'Screen-space shadow rendering',
    help: 'Enables screen-space shadow calculations for fine contact shadows. Adds subtle shadow detail where objects meet surfaces, improving visual depth. Moderate GPU cost; disable for a few extra FPS if shadows aren\'t a priority.' },
  'r.Shadows.ScreenSpace.Quality': { value: 3, label: 'SS Shadow Quality', min: 0, max: 3, step: 1, category: 'effects', target: 'usercfg',
    desc: 'Screen-space shadow quality (0-3)',
    help: 'Controls the quality of screen-space shadows. 0=Low (fast, noisy), 3=Very High (smooth, detailed). Higher values produce cleaner contact shadows at more GPU cost. Only has effect when Screen-Space Shadows is enabled.' },
  // Visual Clarity (verified)
  r_DepthOfField: { value: 0, label: 'Depth of Field', min: 0, max: 1, type: 'toggle', category: 'clarity', target: 'usercfg',
    desc: 'Blur objects outside the focal point',
    help: 'Simulates camera focus by blurring objects at different distances. Creates a cinematic look but can reduce visual clarity, especially in gameplay. Most players disable this for clearer visibility. Minor performance impact when enabled.' },
  r_MotionBlur: { value: 0, label: 'Motion Blur', min: 0, max: 2, step: 1, category: 'clarity', labels: ['Off', 'Camera', 'Camera+Object'],
    target: 'attributes', attrName: 'MotionBlur',
    desc: 'Blur effect during camera/object movement',
    help: 'Adds blur when the camera or objects move quickly. 0=Off, 1=Camera motion blur only, 2=Camera and per-object motion blur. Can feel cinematic but reduces clarity during fast movement. Most competitive players disable this. Minor GPU cost at level 1, moderate at level 2.' },
  r_Sharpening: { value: 1, label: 'Sharpening', min: 0, max: 1, step: 0.05, category: 'clarity',
    target: 'attributes', attrName: 'Sharpening',
    desc: 'Post-process image sharpening (0.0-1.0)',
    help: 'Applies a post-processing sharpening filter to the final image. Higher values make edges and textures look crisper, but too much can cause shimmering and make jagged edges more visible. Values around 0.2-0.5 balance clarity with smoothness. Negligible performance cost.' },
  r_OpticsBloom: { value: 1, label: 'Bloom', min: 0, max: 1, type: 'toggle', category: 'clarity', target: 'usercfg',
    desc: 'Glow effect around bright light sources',
    help: 'Adds a soft glow around bright light sources like stars, engines, and explosions. Creates a more realistic lighting look but can reduce contrast. Disable for a cleaner, sharper image. Very low performance impact.' },
  r_ChromaticAberration: { value: 0, label: 'Chromatic Aberration', min: 0, max: 100, step: 5, category: 'clarity',
    target: 'attributes', attrName: 'ChromaticAberration',
    desc: 'Lens color fringing effect intensity',
    help: 'Simulates the color fringing that occurs in real camera lenses, splitting colors at screen edges. A purely cinematic effect that many players find distracting. Set to 0 for the cleanest image. No meaningful performance impact; purely a visual preference.' },
  r_filmgrain: { value: 1, label: 'Film Grain', min: 0, max: 1, type: 'toggle', category: 'clarity',
    target: 'attributes', attrName: 'FilmGrain',
    desc: 'Film grain visual noise effect',
    help: 'Adds a subtle film grain noise overlay to the image for a cinematic look. Many players disable this for a cleaner, sharper image. No performance impact; purely a visual preference.' },
  r_vignetteBlur: { value: 1, label: 'Vignette Blur', min: 0, max: 1, type: 'toggle', category: 'clarity', target: 'usercfg',
    desc: 'Screen edge darkening/blur effect',
    help: 'Darkens and slightly blurs the edges of the screen, mimicking a real camera lens vignette. Disable for a cleaner, more uniform image. No performance impact; purely a visual preference.' },
  r_Gamma: { value: 1.0, label: 'Gamma', min: 0.5, max: 1.5, step: 0.05, category: 'clarity', target: 'usercfg',
    desc: 'Display gamma correction',
    help: 'Adjusts the brightness curve of the display. Higher values brighten dark areas, lower values darken them. The default of 1.0 is usually correct for most monitors. Adjust if the game looks too dark or washed out. Affects HUD elements as well.' },
  r_Contrast: { value: 0.5, label: 'Contrast', min: 0.0, max: 1.0, step: 0.05, category: 'clarity', target: 'usercfg',
    desc: 'Display contrast adjustment',
    help: 'Adjusts the contrast between light and dark areas. Higher values increase the difference between bright and dark tones. Default of 0.5 is balanced; increase for punchier visuals, decrease if details are lost in shadows or highlights. No performance impact.' },
  // View Distance (verified) — all target: 'usercfg'
  e_ViewDistRatio: { value: 100, label: 'View Distance', min: 0, max: 255, step: 5, category: 'lod', target: 'usercfg',
    desc: 'Max draw distance for objects',
    help: 'Controls how far away objects remain visible before being culled. Higher values render objects at greater distances, improving the view of distant ships and stations but increasing draw calls. Default is around 60; values of 100+ provide excellent draw distance at some CPU/GPU cost.' },
  e_ViewDistRatioDetail: { value: 100, label: 'Detail Distance', min: 0, max: 255, step: 5, category: 'lod', target: 'usercfg',
    desc: 'Max draw distance for small detail objects',
    help: 'Controls the draw distance specifically for small detail objects like debris, small props, and surface clutter. Lower values cull fine details sooner, reducing draw calls in complex scenes. Reducing this is an effective way to improve FPS in detailed environments like landing zones.' },
  e_ViewDistRatioVegetation: { value: 100, label: 'Vegetation Distance', min: 0, max: 255, step: 5, category: 'lod', target: 'usercfg',
    desc: 'Max draw distance for vegetation',
    help: 'Controls how far vegetation (trees, grass, bushes) is rendered on planetary surfaces. Lower values cause vegetation to pop in closer to the player. Reducing this can significantly improve FPS on planets with dense vegetation like microTech and Hurston.' },
  e_LodRatio: { value: 4, label: 'LOD Ratio', min: 4, max: 40, step: 2, category: 'lod', target: 'usercfg',
    desc: 'Distance at which models switch to lower detail',
    help: 'Controls the distance at which objects transition to lower-detail LOD models. Higher values keep high-poly models visible longer, improving visual quality at a distance but increasing GPU load. Default ranges from 4 (Low) to 40 (Very High). Values of 6-20 are a good balance.' },
  // Input — all target: 'usercfg'
  i_Mouse_Accel: { value: 0, label: 'Mouse Acceleration', min: 0, max: 1, step: 0.1, category: 'input', target: 'usercfg',
    desc: 'Mouse movement acceleration (0=off)',
    help: 'Adds acceleration to mouse movement, making faster mouse motions move the cursor proportionally further. Most players prefer 0 (off) for consistent, predictable aiming. Enable only if you prefer acceleration-style mouse behavior.' },
  i_Mouse_Smooth: { value: 0, label: 'Mouse Smoothing', min: 0, max: 1, step: 0.1, category: 'input', target: 'usercfg',
    desc: 'Mouse input smoothing (0=off)',
    help: 'Smooths out mouse input by averaging recent movements, reducing jitter but adding slight input lag. Most players prefer 0 (off) for the most responsive, direct mouse input. Higher values make mouse movement feel floaty.' },
  // Advanced (unverified - may have no effect) — all target: 'usercfg'
  sys_budget_sysmem: { value: 16384, label: 'System RAM (MB)', min: 4096, max: 65536, step: 4096, category: 'advanced', target: 'usercfg',
    desc: 'System RAM budget hint for the engine (MB)',
    help: 'Tells the engine how much system RAM is available for budgeting. Set to your actual RAM in MB (16384=16GB, 32768=32GB, 65536=64GB). This is a hint for memory management, not a hard limit. Setting it too high on a system with less RAM may cause instability.' },
  sys_budget_videomem: { value: 8192, label: 'Video RAM (MB)', min: 2048, max: 24576, step: 2048, category: 'advanced', target: 'usercfg',
    desc: 'Video RAM budget hint for the engine (MB)',
    help: 'Tells the engine how much VRAM is available for budgeting. Match your GPU\'s VRAM (4096=4GB, 8192=8GB, 12288=12GB, 16384=16GB, 24576=24GB). Helps the engine make better streaming and quality decisions. Setting this too high can cause stuttering from VRAM overflow.' },
  sys_streaming_CPU: { value: 1, label: 'Streaming CPU', min: 0, max: 1, type: 'toggle', category: 'advanced', target: 'usercfg',
    desc: 'CPU-assisted texture streaming',
    help: 'Enables CPU-based texture streaming to help manage texture loading. When enabled, the CPU assists in scheduling and prioritizing texture streams. Should generally be left on. Disabling may cause more texture pop-in or loading delays.' },
  sys_limit_phys_thread_count: { value: 0, label: 'Physics Thread Limit', min: 0, max: 16, step: 1, category: 'advanced', target: 'usercfg',
    desc: 'Max physics threads (0 = automatic)',
    help: 'Limits the number of CPU threads used for physics calculations. 0 lets the engine decide automatically based on your CPU. Manually limiting this can help if physics processing causes stalls on CPUs with few cores, or to free up cores for other tasks.' },
  sys_PakStreamCache: { value: 1, label: 'Pak Stream Cache', min: 0, max: 1, type: 'toggle', category: 'advanced', target: 'usercfg',
    desc: 'Cache pak file data in memory',
    help: 'Enables caching of game data files (pak archives) in memory for faster repeated access. Reduces disk I/O and load times at the cost of some RAM usage. Should generally be left on, especially with SSDs. Disabling may increase loading times and stuttering.' },
  ca_thread: { value: 1, label: 'Animation Thread', min: 0, max: 1, type: 'toggle', category: 'advanced', target: 'usercfg',
    desc: 'Dedicated thread for character animations',
    help: 'Enables a separate thread for character animation processing. Improves performance by offloading animation calculations from the main thread. Should be left on for multi-core CPUs. Only disable for debugging purposes.' },
  e_ParticlesThread: { value: 1, label: 'Particles Thread', min: 0, max: 1, type: 'toggle', category: 'advanced', target: 'usercfg',
    desc: 'Dedicated thread for particle systems',
    help: 'Enables a separate thread for particle system updates. Offloads particle simulation from the main thread, improving FPS in particle-heavy scenes like battles. Should be left on for multi-core CPUs. Only disable for debugging purposes.' },
  sys_job_system_enable: { value: 1, label: 'Job System', min: 0, max: 1, type: 'toggle', category: 'advanced', target: 'usercfg',
    desc: 'Multi-threaded job scheduling system',
    help: 'Enables the engine\'s multi-threaded job system for distributing work across CPU cores. Critical for performance on modern multi-core CPUs. WARNING: Disabling makes the game nearly unusable and should only be done for debugging thread-safety issues.' },
  sys_spec_Light: { value: 3, label: 'Lighting', min: 1, max: 4, step: 1, category: 'advanced', target: 'usercfg', overrideWarning: true,
    desc: 'Dynamic lighting quality (1=Low, 4=Very High)',
    help: 'Controls the quality of dynamic lighting including light count, shadow-casting lights, and illumination calculations. Higher values allow more dynamic lights with better accuracy. Lowering can help FPS in scenes with many light sources like station interiors.' },
  sys_spec_PostProcessing: { value: 3, label: 'Post Processing', min: 1, max: 4, step: 1, category: 'advanced', target: 'usercfg', overrideWarning: true,
    desc: 'Post-processing effects quality (1-4)',
    help: 'Controls the quality of screen-space post-processing effects like color grading, tone mapping, and lens effects. Higher values use more complex post-processing passes. Moderate GPU impact; lowering affects visual polish but not geometry or texture detail.' },
  sys_spec_TextureResolution: { value: 3, label: 'Texture Resolution', min: 1, max: 4, step: 1, category: 'advanced', target: 'usercfg', overrideWarning: true,
    desc: 'Texture resolution multiplier (1-4)',
    help: 'Controls the maximum texture resolution scale. Higher values load larger texture mipmaps, producing sharper surfaces at the cost of more VRAM. Lower values force smaller mipmaps, reducing VRAM usage but making surfaces blurrier. Depends heavily on available VRAM.' },
  sys_spec_VolumetricEffects: { value: 3, label: 'Volumetric Effects', min: 1, max: 4, step: 1, category: 'advanced', target: 'usercfg', overrideWarning: true,
    desc: 'Volumetric fog, clouds, and light shafts (1-4)',
    help: 'Controls the quality of volumetric rendering including fog, god rays, cloud density, and atmospheric haze. Higher values produce more detailed volumetrics but are GPU-intensive. Lowering this can help FPS significantly in atmospheric environments and nebulae.' },
  sys_spec_Sound: { value: 3, label: 'Sound', min: 1, max: 4, step: 1, category: 'advanced', target: 'usercfg', overrideWarning: true,
    desc: 'Audio processing quality (1-4)',
    help: 'Controls the quality and complexity of audio processing including number of simultaneous sounds, reverb quality, and spatial audio. Higher values produce richer soundscapes. Lowering has minimal performance impact on most systems but can help on very CPU-limited setups.' },
  q_Quality: { value: 3, label: 'Shader Quality', min: 0, max: 3, step: 1, category: 'advanced', target: 'usercfg',
    desc: 'Master shader quality preset (0-3)',
    help: 'Sets all shader quality levels at once (except q_ShaderParticle and q_ShaderDecal). 0=Low, 1=Medium, 2=High, 3=Very High. Overrides individual q_Shader* settings when changed. Adjust individual shader settings after this for fine-tuning.' },
  q_Renderer: { value: 3, label: 'Renderer', min: 0, max: 3, step: 1, category: 'advanced', target: 'usercfg',
    desc: 'Renderer quality level (0-3)',
    help: 'Controls the overall renderer quality level affecting various internal rendering decisions. 0=Low, 1=Medium, 2=High, 3=Very High. Influences rendering paths and quality selections across the pipeline. Generally leave at the same level as q_Quality.' },
  r_TexturesStreamingResidencyEnabled: { value: 1, label: 'Texture Streaming', min: 0, max: 1, type: 'toggle', category: 'advanced', target: 'usercfg',
    desc: 'Dynamic texture streaming system',
    help: 'Enables the texture residency streaming system that dynamically loads and unloads textures based on visibility. Essential for managing VRAM usage efficiently. Disabling forces all textures to load fully, which can exceed VRAM and cause severe stuttering.' },
  e_VegetationMinSize: { value: 0.5, label: 'Vegetation Min Size', min: 0, max: 2, step: 0.1, category: 'advanced', target: 'usercfg',
    desc: 'Minimum rendered vegetation size threshold',
    help: 'Sets the minimum size for vegetation objects to be rendered. Higher values skip smaller plants and grass, reducing draw calls on planets. 0 renders all vegetation; values around 0.5-1.0 cull tiny plants for better FPS without visibly reducing foliage density.' },
  'pl_pit.forceSoftwareCursor': { value: 0, label: 'Software Cursor', min: 0, max: 1, type: 'toggle', category: 'advanced', target: 'usercfg',
    desc: 'Use software cursor instead of hardware',
    help: 'Forces a software-rendered cursor instead of the hardware cursor. Can fix cursor issues on multi-monitor setups or when the cursor disappears or appears on the wrong screen. Adds minimal overhead. Only enable if you experience cursor problems.' },
  Con_Restricted: { value: 1, label: 'Console Restricted', min: 0, max: 1, type: 'toggle', category: 'advanced', target: 'usercfg',
    desc: 'Restrict console commands (0=unlock all)',
    help: 'When set to 1 (default), only basic console commands are available. Set to 0 to unlock extended console commands for advanced debugging and configuration. Required for many debug CVars to take effect. No performance impact.' },
};

/** Display labels for graphics quality levels (1-4) */
function getQualityLevels() {
  return ['', t('environments:cfg.quality.low'), t('environments:cfg.quality.medium'), t('environments:cfg.quality.high'), t('environments:cfg.quality.veryHigh')];
}
/** Display labels for shader quality levels (0-3) */
function getShaderLevels() {
  return ['', t('environments:cfg.quality.low'), t('environments:cfg.quality.medium'), t('environments:cfg.quality.high')];
}

/**
 * Returns translated labels for CVar settings that use dropdown labels.
 * Called at render time so t() resolves to the current language.
 */
function getSettingLabels(key) {
  const map = {
    '_windowMode': () => [t('environments:cfg.windowMode.windowed'), t('environments:cfg.windowMode.fullscreen'), t('environments:cfg.windowMode.borderless')],
    'r.graphicsRenderer': () => [t('environments:cfg.renderer.vulkan'), t('environments:cfg.renderer.dx11')],
    'r_ssdo': () => [t('environments:cfg.ssdo.off'), t('environments:cfg.ssdo.fast'), t('environments:cfg.ssdo.optimized'), t('environments:cfg.ssdo.reference')],
    'r_MotionBlur': () => [t('environments:cfg.motionBlur.off'), t('environments:cfg.motionBlur.camera'), t('environments:cfg.motionBlur.cameraObject')],
  };
  return map[key]?.() || null;
}

// CVar keys that should display quality/shader level labels
const QUALITY_KEYS = new Set(['sys_spec', 'sys_spec_GameEffects', 'sys_spec_ObjectDetail', 'sys_spec_Particles', 'sys_spec_Physics', 'sys_spec_Shading', 'sys_spec_Shadows', 'sys_spec_Texture', 'sys_spec_Water', 'sys_spec_Light', 'sys_spec_PostProcessing', 'sys_spec_TextureResolution', 'sys_spec_VolumetricEffects', 'sys_spec_Sound']);
const SHADER_KEYS = new Set(['q_ShaderFX', 'q_ShaderGeneral', 'q_ShaderPostProcess', 'q_ShaderShadow', 'q_ShaderGlass', 'q_ShaderParticle', 'q_ShaderSky', 'q_ShaderWater', 'q_ShaderCompute', 'q_Quality', 'q_Renderer']);

/** Predefined resolution presets for the resolution dropdown */
const RESOLUTION_PRESETS = [
  { w: 1280, h: 720, label: '720p' },
  { w: 1600, h: 900, label: '900p' },
  { w: 1920, h: 1080, label: '1080p' },
  { w: 2560, h: 1080, label: 'UW 1080p' },
  { w: 2560, h: 1440, label: '1440p' },
  { w: 3440, h: 1440, label: 'UW 1440p' },
  { w: 3840, h: 2160, label: '4K' },
  { w: 5120, h: 2160, label: 'UW 4K' },
  { w: 7680, h: 4320, label: '8K' },
];

// ==================== Entry Point ====================

/**
 * Sets the active tab and renders the page.
 * Called by the navigation when a tab is directly targeted.
 * @param {string} tab - The tab to display: 'profile', 'usercfg', 'localization', 'storage'
 */
export function setActiveProfileTab(tab) {
  activeProfileTab = tab;
}

/** Cleans up all active event listeners (prevents memory leaks on page navigation) */
export function cleanupEnvironments() {
  if (unlistenProgress) { unlistenProgress(); unlistenProgress = null; }
  if (unlistenCopyComplete) { unlistenCopyComplete(); unlistenCopyComplete = null; }
  if (unlistenLaunchStarted) { unlistenLaunchStarted(); unlistenLaunchStarted = null; }
  if (unlistenLaunchExited) { unlistenLaunchExited(); unlistenLaunchExited = null; }
  postGameListenerRegistered = false;
}

/**
 * Main render function: Loads all data and renders the environments page.
 * Uses a generation counter so that with rapidly successive calls,
 * only the latest render is actually displayed.
 * @param {HTMLElement} container - DOM container for the page
 */
export async function renderEnvironments(container) {
  // Capture current scroll position for restoration after async load
  const scrollPos = container.scrollTop;

  // Increment generation to discard stale renders from parallel calls
  const thisGeneration = ++renderGeneration;


  // One-time migration: rename old binding_database.json to .bak
  if (!migrationChecked) {
    migrationChecked = true;
    try {
      const migrated = await invoke('migrate_binding_database');
      if (migrated) {
        showNotification(t('environments:notification.migrated'), 'info');
      }
    } catch (e) {
      console.warn('[profiles] binding_database migration failed:', e);
    }
  }

  try {
    config = await invoke('load_config');
  } catch (e) {
    config = { install_path: '', log_level: 'info' };
  }

  if (config?.install_path) {
    try {
      scVersions = await invoke('detect_sc_versions', { gp: config.install_path });
    } catch (e) {
      console.error('[profiles] detect_sc_versions error:', e);
      scVersions = [];
    }
  }

  if (scVersions.length > 0 && !activeScVersion) {
    activeScVersion = scVersions[0].version;
  }

  // Register post-game listener for attributes.xml sync detection (once)
  if (!postGameListenerRegistered && config?.install_path) {
    postGameListenerRegistered = true;
    listen('launch-started', async () => {
      if (config?.install_path && activeScVersion) {
        try {
          preLaunchAttributesHash = await invoke('get_attributes_hash', {
            gp: config.install_path, v: activeScVersion
          });
        } catch (e) { /* ignore */ }
      }
    }).then(fn => { unlistenLaunchStarted = fn; });
    listen('launch-exited', async () => {
      if (config?.install_path && activeScVersion && preLaunchAttributesHash) {
        try {
          const postHash = await invoke('get_attributes_hash', {
            gp: config.install_path, v: activeScVersion
          });
          if (postHash && postHash !== preLaunchAttributesHash) {
            const attrsMap = await invoke('read_attributes_map', {
              gp: config.install_path, v: activeScVersion
            });
            detectAttributeConflicts(attrsMap);
            savedAttributesHash = postHash;
            savedAttributesValues = attrsMap;
            if (pendingConflicts.length > 0) {
              showNotification(
                t('environments:notification.settingsChangedInGame', {
                  count: pendingConflicts.length,
                  defaultValue: `${pendingConflicts.length} setting(s) changed in-game`
                }),
                'info'
              );
            }
          }
        } catch (e) { /* ignore */ }
        preLaunchAttributesHash = '';
      }
    }).then(fn => { unlistenLaunchExited = fn; });
  }

  // Load localization labels in the background (for translated action names in bindings)
  if (config?.install_path && activeScVersion && !localizationLoaded && !localizationLoading) {
    loadLocalizationLabels().then((loaded) => {
      if (loaded) {
        // Re-render only if we're on the profile tab with actual binding data to display.
        // Skipping the re-render when bindings are empty (e.g. version has no Data.p4k)
        // avoids an unnecessary skeleton flash that swallows click events.
        const content = document.getElementById('content');
        if (content && activeProfileTab === 'profile' && lastRestoredBackupId) {
          loadCompleteBindingList().then(() => {
            if (completeBindingList.length > 0) {
              renderEnvironments(content);
            }
          });
        }
      }
    }).catch(e => console.error('Failed to load localization labels:', e));
  }

  // Show loading skeleton while data is being loaded.
  // config and scVersions are already available here, so we can render the version
  // selector immediately — the user can see (and click) version tabs during loading.
  container.innerHTML = `
    <div class="page-header">
      <h1>${t('environments:title')}</h1>
      <p class="page-subtitle">${t('environments:subtitle')}</p>
    </div>
    <div class="sc-settings">
      ${scVersions.length > 0 ? renderVersionSelector() : ''}
      <div class="profiles-loading-skeleton">
        <div class="dash-skeleton">
          <div class="dash-skeleton-line medium"></div>
          <div class="dash-skeleton-line short"></div>
          <div class="dash-skeleton-block" style="height: 120px;"></div>
          <div class="dash-skeleton-block" style="height: 200px;"></div>
        </div>
      </div>
    </div>
  `;
  // Attach version card listeners so tabs respond while content is loading.
  // Mirrors the full listener in attachProfilesEventListeners(), including the
  // unsaved-changes guard so USER.cfg edits are not silently discarded.
  document.querySelectorAll('.sc-version-card').forEach(card => {
    card.addEventListener('click', async () => {
      if (card.dataset.version === activeScVersion) return;
      if (hasUnsavedChanges()) {
        const proceed = await confirm(t('environments:notification.unsavedVersionSwitch'), {
          title: t('environments:notification.unsavedTitle'),
          kind: 'warning',
          okLabel: t('environments:notification.switchAnyway'),
          cancelLabel: t('environments:notification.stay'),
        });
        if (!proceed) return;
      }
      if (activeScVersion && lastRestoredBackupId) {
        lastRestoredPerVersion[activeScVersion] = lastRestoredBackupId;
      }
      resetEnvironmentState();
      activeScVersion = card.dataset.version;
      lastRestoredBackupId = lastRestoredPerVersion[activeScVersion] || null;
      renderEnvironments(document.getElementById('content'));
    });
  });

  // Load active profile per version from disk
  try {
    const saved = await invoke('load_active_profiles');
    Object.assign(lastRestoredPerVersion, saved);
    if (activeScVersion && saved[activeScVersion]) {
      lastRestoredBackupId = saved[activeScVersion];
    }
  } catch (e) { /* ignore */ }

  // Load all data in parallel (definitions, bindings, layouts, backups, etc.)
  await Promise.all([
    loadActionDefinitions(),
    loadDevicesAndBindings(),
    loadCompleteBindingList(),
    loadExportedLayouts(),
    loadBackups(),
    loadUserCfgSettings(),
    loadLocalizationData(),
    loadDeviceTuning(),
  ]);
  await loadProfileStatus();

  // Discard this render if a newer renderEnvironments call has been initiated
  if (thisGeneration !== renderGeneration) return;

  // Render
  let html = `
    <div class="page-header">
      <h1>${t('environments:title')}</h1>
      <p class="page-subtitle">${t('environments:subtitle')}</p>
    </div>
    <div class="sc-settings">
      ${renderVersionSelector()}
      ${renderMainContent()}
    </div>
  `;

  container.innerHTML = html;

  attachProfilesEventListeners();

  // Restore scroll position
  if (scrollPos > 0) {
    requestAnimationFrame(() => {
      container.scrollTop = scrollPos;
    });
  }
}


/**
 * Re-renders the page instantly from current module state without fetching new data.
 * Used for tab switches (Profile / UserCfg / Localization / Storage) where the
 * underlying data has not changed and no skeleton is needed.
 * @returns {void}
 */
function rerenderFromState() {
  const container = document.getElementById('content');
  if (!container) return;
  const scrollPos = container.scrollTop;
  container.innerHTML = `
    <div class="page-header">
      <h1>${t('environments:title')}</h1>
      <p class="page-subtitle">${t('environments:subtitle')}</p>
    </div>
    <div class="sc-settings">
      ${renderVersionSelector()}
      ${renderMainContent()}
    </div>
  `;
  attachProfilesEventListeners();
  if (scrollPos > 0) {
    requestAnimationFrame(() => {
      container.scrollTop = scrollPos;
    });
  }
}


// ==================== Load Data ====================

/**
 * Loads the action definitions (categories, display names) from the backend.
 * Populates the actionDefinitions state variable.
 */
async function loadActionDefinitions() {
  try {
    actionDefinitions = await invoke('get_action_definitions');
  } catch (e) {
    console.error('Failed to load action definitions:', e);
    actionDefinitions = null;
  }
}

/** @type {Object} Statistics: total binding count / custom binding count */
let bindingStats = { total: 0, custom: 0 };

/**
 * Loads the complete binding list for the active profile from the backend.
 * Contains both default and custom bindings.
 */
async function loadCompleteBindingList() {
  completeBindingList = [];
  bindingStats = { total: 0, custom: 0 };

  if (!config?.install_path || !activeScVersion || !lastRestoredBackupId) return;

  try {
    const result = await invoke('get_profile_bindings', {
      gp: config.install_path,
      v: activeScVersion,
      profileId: lastRestoredBackupId,
    });
    completeBindingList = result.bindings || [];
    bindingStats = result.stats || { total: 0, custom: 0 };
  } catch (e) {
    debugLog('BINDING', 'error', 'Failed to load profile bindings: ' + e);
    completeBindingList = [];
    bindingStats = { total: 0, custom: 0 };
  }
}


/**
 * Parses the actionmaps (actionmaps.xml) for the active version and source.
 * Populates parsedActionMaps with device and binding data.
 */
async function loadDevicesAndBindings() {
  if (!config?.install_path || !activeScVersion) {
    parsedActionMaps = null;
    return;
  }
  try {
    parsedActionMaps = await invoke('parse_actionmaps', {
      gp: config.install_path,
      v: activeScVersion,
      source: selectedBindingSource,
    });
  } catch (e) {
    parsedActionMaps = null;
  }
}

/**
 * Loads the list of exported keyboard/controller layouts
 * from the active SC version's directory.
 */
async function loadExportedLayouts() {
  if (!config?.install_path || !activeScVersion) {
    exportedLayouts = [];
    return;
  }
  try {
    exportedLayouts = await invoke('list_exported_layouts', {
      gamePath: config.install_path,
      version: activeScVersion,
    });
  } catch (e) {
    exportedLayouts = [];
  }
}


/**
 * Loads all saved profiles (backups) for the active SC version.
 * Populates the backups state array.
 */
async function loadBackups() {
  if (!activeScVersion) {
    backups = [];
    return;
  }
  try {
    backups = await invoke('list_backups', { v: activeScVersion });
  } catch (e) {
    backups = [];
  }
}

/**
 * Checks if the active profile is in sync with SC files.
 * Populates activeProfileStatus with match/changed file info.
 */
async function loadProfileStatus() {
  if (!config?.install_path || !activeScVersion || !lastRestoredBackupId) {
    activeProfileStatus = null;
    return;
  }
  try {
    activeProfileStatus = await invoke('check_profile_status', {
      gp: config.install_path, v: activeScVersion, bid: lastRestoredBackupId,
    });
  } catch (e) {
    activeProfileStatus = null;
  }
}

/**
 * Converts an attributes.xml string value to the frontend number type.
 * attributes.xml stores everything as strings; our settings use numbers.
 */
function convertAttrValue(key, attrStringValue) {
  if (attrStringValue === undefined || attrStringValue === null) return undefined;
  const num = parseFloat(attrStringValue);
  return isNaN(num) ? attrStringValue : num;
}

/**
 * Converts a frontend value to an attributes.xml string.
 */
function convertToAttrValue(_key, value) {
  return String(value);
}

/**
 * Reads the USER.cfg file and parses the settings into userCfgSettings.
 * Also stores a snapshot for external change detection.
 */
async function loadUserCfgSettings() {
  if (!config?.install_path || !activeScVersion) {
    userCfgSettings = {};
    return;
  }
  try {
    // Read both sources in parallel
    const [cfgContent, attrsMap, attrsHash] = await Promise.all([
      invoke('read_user_cfg', { gp: config.install_path, v: activeScVersion }),
      invoke('read_attributes_map', { gp: config.install_path, v: activeScVersion }),
      invoke('get_attributes_hash', { gp: config.install_path, v: activeScVersion }),
    ]);

    // 1. Parse USER.cfg for all settings (existing behavior)
    userCfgSettings = parseUserCfg(cfgContent);
    savedUserCfgRaw = cfgContent;

    // 2. Override attributes-target settings with values from attributes.xml
    for (const [key, setting] of Object.entries(DEFAULT_SETTINGS)) {
      if (setting.target !== 'attributes' || !setting.attrName) continue;
      if (setting.virtual) {
        // Handle virtual settings specially
        if (key === '_resolution') {
          const w = convertAttrValue(key, attrsMap[setting.attrName]);
          const h = convertAttrValue(key, attrsMap[setting.attrNameHeight]);
          if (w !== undefined) userCfgSettings.r_width = w;
          if (h !== undefined) userCfgSettings.r_height = h;
        } else if (key === '_windowMode') {
          const mode = convertAttrValue(key, attrsMap[setting.attrName]);
          if (mode !== undefined) userCfgSettings._windowMode = mode;
        }
      } else {
        const attrValue = convertAttrValue(key, attrsMap[setting.attrName]);
        if (attrValue !== undefined) userCfgSettings[key] = attrValue;
      }
    }

    // 3. Detect in-game changes via hash comparison
    if (savedAttributesHash && attrsHash && attrsHash !== savedAttributesHash) {
      detectAttributeConflicts(attrsMap);
    }
    savedAttributesHash = attrsHash;
    savedAttributesValues = { ...attrsMap };
  } catch (e) {
    userCfgSettings = {};
    savedUserCfgRaw = '';
  }
  savedUserCfgSnapshot = { ...userCfgSettings };
}

/**
 * Detects conflicts between our last known attribute values and the current ones.
 * Called when the attributes hash has changed since our last read.
 */
function detectAttributeConflicts(currentAttrsMap) {
  pendingConflicts = [];
  for (const [key, setting] of Object.entries(DEFAULT_SETTINGS)) {
    if (setting.target !== 'attributes' || !setting.attrName) continue;
    const ourValue = savedAttributesValues[setting.attrName];
    const scValue = currentAttrsMap[setting.attrName];
    if (ourValue !== undefined && scValue !== undefined && ourValue !== scValue) {
      pendingConflicts.push({
        key,
        label: setting.label,
        ourValue: convertAttrValue(key, ourValue),
        scValue: convertAttrValue(key, scValue),
        attrName: setting.attrName,
      });
    }
  }
}

/**
 * Loads the localization labels from Data.p4k (cached).
 * These labels are used for translated action names in the binding view.
 * @returns {boolean} true if successfully loaded, false otherwise
 */
async function loadLocalizationLabels() {
  if (!config?.install_path || !activeScVersion) {
    localizationLabels = {};
    localizationLoaded = false;
    return false; // Return whether we actually loaded anything
  }
  
  if (localizationLoading || localizationLoaded) return false;
  localizationLoading = true;
  
  try {
    // This uses the cached labels if available
    localizationLabels = await invoke('get_localization_labels', {
      gamePath: config.install_path,
      version: activeScVersion,
      language: localizationStatus?.language_name?.toLowerCase() || 'english'
    });
    console.log(`[Localization] Loaded ${Object.keys(localizationLabels).length} labels`);
    localizationLoaded = true;
    return true; // Successfully loaded
  } catch (e) {
    if (e !== "Localization loading already in progress") {
      console.error('Failed to load localization labels:', e);
    }
    return false;
  } finally {
    localizationLoading = false;
  }
}

/**
 * Loads the localization status and available languages.
 * Also fetches remote information about the language packs in the background
 * (last commit date, etc.) without blocking the UI.
 */
async function loadLocalizationData() {
  if (!config?.install_path || !activeScVersion) {
    localizationStatus = null;
    availableLanguages = [];
    return;
  }
  try {
    const [status, languages] = await Promise.all([
      invoke('get_localization_status', { gamePath: config.install_path, version: activeScVersion }),
      invoke('get_available_languages', { version: activeScVersion }),
    ]);
    localizationStatus = status;
    availableLanguages = languages;
  } catch (e) {
    localizationStatus = null;
    availableLanguages = [];
  }

  // Load remote info in background (non-blocking)
  invoke('fetch_remote_language_info', { forceRefresh: false })
    .then(info => {
      remoteLanguageInfo = info || [];
      // Re-render only the localization tab content if visible
      const tabEl = document.querySelector('.localization-tab');
      if (tabEl && activeProfileTab === 'localization') {
        tabEl.innerHTML = `${renderLocalizationStatus()}${renderLanguageSelector()}`;
      }
    })
    .catch(err => logError(err, 'environments:load_actionmaps'));
}

// Mapping of old/removed CVar names to their successors (for migration)
const LEGACY_CVAR_MAP = {
  sys_spec_Quality: 'sys_spec',
};

/**
 * Parses the content of a USER.cfg file into a key-value object.
 * Handles: comments, inline comments, legacy CVars, and
 * virtual settings (_windowMode from r_Fullscreen + r_FullscreenWindow).
 * @param {string} content - Raw content of USER.cfg
 * @returns {Object} Parsed settings
 */
function parseUserCfg(content) {
  const settings = {};
  const lines = content.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith(';') && !trimmed.startsWith('#')) {
      const match = trimmed.match(/^([\w.]+)\s*=\s*(.+)$/);
      if (match) {
        let key = match[1];
        let value = match[2].trim();
        // Strip inline comments
        const commentIdx = value.indexOf(';');
        if (commentIdx > 0) value = value.substring(0, commentIdx).trim();
        if (!isNaN(value) && value !== '') {
          value = parseFloat(value);
        }
        // Migrate legacy CVars
        if (LEGACY_CVAR_MAP[key]) key = LEGACY_CVAR_MAP[key];
        settings[key] = value;
      }
    }
  }

  // Calculate virtual _windowMode setting from r_Fullscreen + r_FullscreenWindow
  const rFullscreen = settings.r_Fullscreen;
  const rFullscreenWindow = settings.r_FullscreenWindow;
  if (rFullscreen !== undefined || rFullscreenWindow !== undefined) {
    const fs = (rFullscreen !== undefined) ? rFullscreen : 0;
    const fsw = (rFullscreenWindow !== undefined) ? rFullscreenWindow : 0;
    if (fs === 1) {
      settings._windowMode = 1; // Fullscreen
    } else if (fsw === 1) {
      settings._windowMode = 2; // Borderless
    } else if (fs === 2) {
      // Legacy: r_Fullscreen=2 was old borderless
      settings._windowMode = 2;
    } else {
      settings._windowMode = 0; // Windowed
    }
    // Remove raw CVars - they are managed by the virtual setting
    delete settings.r_Fullscreen;
    delete settings.r_FullscreenWindow;
  }

  return settings;
}

// ==================== Version Selector ====================

/** Standard SC versions that are always shown in the selector (even if not installed) */
const STANDARD_VERSIONS = ['LIVE', 'PTU', 'EPTU', 'TECH-PREVIEW', 'HOTFIX'];

/**
 * Renders the version selector as a card strip.
 * Detected and standard versions are shown, sorted by priority.
 * Each card displays the status (installed, missing, copying) via a colored dot.
 */
function renderVersionSelector() {
  if (scVersions.length === 0 || (!config?.install_path)) {
    return `
      <div class="sc-version-notice">
        <div class="notice-icon">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
          </svg>
        </div>
        <h3>${t('environments:version.noVersionsTitle')}</h3>
        <p>${t('environments:version.noVersionsDesc')}</p>
        <p class="notice-path">${escapeHtml(config?.install_path || t('environments:version.notSet'))}</p>
      </div>
    `;
  }

  // Combine detected versions and standard versions
  const allVersionNames = [...scVersions.map(v => v.version)];
  for (const sv of STANDARD_VERSIONS) {
    if (!allVersionNames.includes(sv)) {
      allVersionNames.push(sv);
    }
  }

  // Sort versions: LIVE first, then PTU, then others from STANDARD, then rest
  allVersionNames.sort((a, b) => {
    const order = { 'LIVE': 0, 'PTU': 1, 'EPTU': 2, 'TECH-PREVIEW': 3, 'HOTFIX': 4 };
    const aOrder = order[a] !== undefined ? order[a] : 99;
    const bOrder = order[b] !== undefined ? order[b] : 99;
    return aOrder - bOrder || a.localeCompare(b);
  });

  return `
    <div class="sc-version-selector">
      <label class="section-label">${t('environments:version.label')}</label>
      <div class="version-cards">
        ${allVersionNames.map(vName => {
          const v = scVersions.find(v => v.version === vName);
          const exists = !!v;
          const isActive = activeScVersion === vName;
          const hasDataP4k = exists && v.has_data_p4k !== false;
          const isCopying = copyingVersion && copyingVersion.version === vName;
          
          let statusClass = 'missing';
          if (exists) {
            statusClass = isCopying ? 'copying' : (hasDataP4k ? 'installed' : 'missing');
          } else {
            statusClass = 'not-installed';
          }
          
          return `
            <button class="sc-version-card ${isActive ? 'active' : ''} ${!exists ? 'sc-not-installed' : ''} ${exists && !hasDataP4k ? 'missing-data' : ''}"
                    data-version="${escapeHtml(vName)}">
              <div class="version-status-dot ${statusClass}"
                   title="${!exists ? t('environments:version.folderNotCreated') : (isCopying ? t('environments:version.copyingDataP4k') : (hasDataP4k ? t('environments:version.ready') : t('environments:version.dataP4kMissing')))}"></div>
              <span class="version-label">${escapeHtml(vName)}</span>
              ${exists && !hasDataP4k && !isCopying ? `<div class="version-copy-btn" data-version="${escapeHtml(vName)}" title="${t('environments:version.copyFromAnother')}">⤵</div>` : ''}
              ${isCopying ? `<div class="version-copy-progress" data-version="${escapeHtml(vName)}">0%</div>` : ''}
            </button>
          `;
        }).join('')}
      </div>
    </div>
  `;
}

// ==================== Main Content ====================

/**
 * Renders the main page content with tab navigation
 * (Profiles, USER.cfg, Localization, Storage).
 */
function renderMainContent() {
  if (scVersions.length === 0 || !activeScVersion) {
    return '';
  }

  const vInfo = scVersions.find(v => v.version === activeScVersion);
  if (!vInfo) {
    return renderEmptyVersionState();
  }

  const tabs = [
    { key: 'profile', label: t('environments:tab.profile'), tooltip: t('environments:tab.profileTooltip') },
    { key: 'usercfg', label: t('environments:tab.usercfg'), tooltip: t('environments:tab.usercfgTooltip') },
    { key: 'localization', label: t('environments:tab.localization'), tooltip: t('environments:tab.localizationTooltip') },
    { key: 'storage', label: t('environments:tab.storage'), tooltip: t('environments:tab.storageTooltip') },
  ];

  let tabContent = '';
  if (activeProfileTab === 'profile') {
    tabContent = renderProfileTab();
  } else if (activeProfileTab === 'localization') {
    tabContent = renderLocalizationTab();
  } else if (activeProfileTab === 'usercfg') {
    tabContent = renderUserCfgUI();
  } else if (activeProfileTab === 'storage') {
    tabContent = renderStorageTab();
  }

  return `
    <div class="profile-tabs">
      ${tabs.map(tb => `<button class="profile-tab ${activeProfileTab === tb.key ? 'active' : ''}" data-tab="${tb.key}" data-tooltip="${tb.tooltip}" data-tooltip-pos="bottom">${tb.label}</button>`).join('')}
    </div>
    <div class="profile-tab-content">
      ${tabContent}
    </div>
  `;
}

/**
 * Renders the view for a version that does not exist yet.
 * Offers options to create the folder or to symlink/copy the Data.p4k.
 */
function renderEmptyVersionState() {
  const versionsWithP4k = scVersions.filter(v => v.has_data_p4k !== false).map(v => v.version);
  
  return `
    <div class="sc-version-notice" style="margin-top: 2rem;">
      <div class="notice-icon">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
          <line x1="12" y1="11" x2="12" y2="17"></line>
          <line x1="9" y1="14" x2="15" y2="14"></line>
        </svg>
      </div>
      <h3>${t('environments:version.envNotFound', { version: escapeHtml(activeScVersion) })}</h3>
      <p>${t('environments:version.folderNotExist')}</p>
      
      <div class="empty-state-actions" style="display: flex; flex-direction: column; gap: 1rem; max-width: 400px; margin: 2rem auto;">
        <button class="btn btn-primary" id="btn-create-version" data-version="${escapeHtml(activeScVersion)}">
          ${t('environments:version.createEmptyFolder')}
        </button>
        
        ${versionsWithP4k.length > 0 ? `
          <div style="border-top: 1px solid var(--border); padding-top: 1rem; margin-top: 0.5rem;">
            <p style="font-size: 0.8rem; color: var(--text-muted); margin-bottom: 0.5rem;">${t('environments:version.initWithDataP4k')}</p>
            <div style="display: flex; gap: 0.5rem;">
              <select id="data-source-select" class="btn btn-sm" style="flex: 1; background: var(--bg-secondary);">
                ${versionsWithP4k.map(v => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join('')}
              </select>
              <button class="btn btn-sm" id="btn-link-p4k" data-version="${escapeHtml(activeScVersion)}" title="${t('environments:version.symlinkTooltip')}">${t('environments:version.symlink')}</button>
              <button class="btn btn-sm" id="btn-copy-p4k" data-version="${escapeHtml(activeScVersion)}" title="${t('environments:version.copyTooltip')}">${t('environments:version.copy')}</button>
            </div>
          </div>
        ` : ''}
      </div>
    </div>
  `;
}

/**
 * Renders the Storage tab with version information and the option
 * to delete an entire environment ("Danger Zone").
 */
function renderStorageTab() {
  const vInfo = scVersions.find(v => v.version === activeScVersion);
  if (!vInfo) return '';

  const hasDataP4k = vInfo.has_data_p4k !== false;
  
  return `
    <div class="sc-section">
      <div class="sc-section-header">
        <h3>${t('environments:storage.title')}</h3>
      </div>

      <div class="profile-info-card">
        <div class="profile-info-row">
          <span class="profile-info-label">${t('environments:storage.environment')}</span>
          <span class="profile-info-value"><strong>${escapeHtml(activeScVersion)}</strong></span>
        </div>
        <div class="profile-info-row">
          <span class="profile-info-label">${t('environments:storage.path')}</span>
          <span class="profile-info-value"><code>${escapeHtml(vInfo.path || 'Unknown')}</code></span>
        </div>
        <div class="profile-info-row">
          <span class="profile-info-label">${t('environments:storage.dataP4k')}</span>
          <span class="profile-info-value">
            ${hasDataP4k
              ? `<span class="localization-installed-badge">${t('environments:storage.installedBadge')}</span>`
              : `<span class="text-muted">${t('environments:storage.missing')}</span>`}
          </span>
        </div>
      </div>
      
      <div class="storage-actions" style="margin-top: 2rem; display: flex; flex-direction: column; gap: 1rem;">
        <div style="padding: 1rem; border: 1px solid var(--border-color); border-radius: 8px; background: rgba(255, 50, 50, 0.05);">
          <h4 style="margin-top: 0; color: #ff6b6b; display: flex; align-items: center; gap: 0.5rem;">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>
            ${t('environments:storage.dangerZone')}
          </h4>
          <p style="color: var(--text-secondary); margin-bottom: 1rem; font-size: 0.9rem;">
            ${t('environments:storage.deleteDesc', { version: escapeHtml(activeScVersion) })}
          </p>
          <button class="btn btn-danger" id="btn-delete-version" data-version="${escapeHtml(activeScVersion)}">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-right: 6px;"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
            ${t('environments:storage.deleteButton', { version: escapeHtml(activeScVersion) })}
          </button>
        </div>
      </div>
    </div>
  `;
}

/**
 * Renders the Profile tab: active profile, profile card grid, import banner.
 * Shows the sync status (in sync / changed / unsaved changes),
 * and when a profile is loaded, also the collapsible keybinding and joystick sections.
 */
function renderProfileTab() {
  const vInfo = scVersions.find(v => v.version === activeScVersion);
  const files = [];
  if (vInfo?.has_actionmaps) files.push('actionmaps.xml');
  if (vInfo?.has_attributes) files.push('attributes.xml');
  if (vInfo?.has_usercfg) files.push('USER.cfg');

  const activeBackup = lastRestoredBackupId ? backups.find(b => b.id === lastRestoredBackupId) : null;
  const hasScFiles = files.length > 0;
  const hasProfiles = backups.length > 0;
  const isDirty = activeBackup?.dirty === true;

  // Import banner for versions with no SC files
  const importBanner = !vInfo?.has_actionmaps && scVersions.length > 1 ? `
    <div class="import-banner" id="import-banner">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <circle cx="12" cy="12" r="10"></circle>
        <line x1="12" y1="16" x2="12" y2="12"></line>
        <line x1="12" y1="8" x2="12.01" y2="8"></line>
      </svg>
      <span>${t('environments:import.noProfilesFound', { version: escapeHtml(activeScVersion) })}</span>
      <button class="btn btn-sm btn-primary" id="btn-import-banner">${t('environments:profile.importFromVersion')}</button>
      <button class="btn-icon" id="btn-import-banner-dismiss" title="${t('environments:import.dismiss')}">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
      </button>
    </div>
  ` : '';

  // === Profiles Section (always at top) ===
  let profilesSection = '';
  if (hasScFiles && !hasProfiles) {
    // Empty state: first-time user
    profilesSection = `
      <div class="sc-section profiles-section">
        <div class="profile-empty-state">
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"></path>
            <polyline points="17 21 17 13 7 13 7 21"></polyline>
            <polyline points="7 3 7 8 15 8"></polyline>
          </svg>
          <div class="profile-empty-text">
            <p><strong>${t('environments:profile.saveTitle')}</strong></p>
            <p class="text-muted">${t('environments:profile.saveDesc')}</p>
          </div>
          <div class="profile-empty-actions">
            <button class="btn btn-primary" id="btn-save-first-profile">${t('environments:profile.saveCurrentSettings')}</button>
            ${scVersions.length > 1 ? `<button class="btn btn-sm" id="btn-import-version">${t('environments:profile.importFromVersion')}</button>` : ''}
          </div>
        </div>
      </div>
    `;
  } else if (hasProfiles) {
    // Active profile header + profile cards
    let activeHeader = '';
    if (activeBackup) {
      const displayLabel = escapeHtml(activeBackup.label || activeBackup.created_at);
      let statusText = '';
      let statusClass = '';
      const isOutOfSync = activeProfileStatus && activeProfileStatus.files.length > 0 && !activeProfileStatus.matched;
      const showApplyButton = isDirty || isOutOfSync;

      if (isDirty) {
        statusText = t('environments:profile.unsavedChanges');
        statusClass = 'profile-status-changed';
      } else if (activeProfileStatus && activeProfileStatus.files.length > 0) {
        if (activeProfileStatus.matched) {
          statusText = t('environments:profile.inSync');
          statusClass = 'profile-status-ok';
        } else {
          const changedCount = activeProfileStatus.files.filter(f => f.status !== 'unchanged').length;
          statusText = t('environments:profile.filesChanged', { count: changedCount });
          statusClass = 'profile-status-changed';
        }
      }

      activeHeader = `
        <div class="profile-active-header">
          <div class="profile-active-info">
            <span class="profile-active-label">
              <span class="profile-active-star">★</span>
              ${displayLabel}
            </span>
            ${statusText ? `<span class="${statusClass}" ${statusClass === 'profile-status-changed' ? 'id="btn-toggle-changes"' : ''}>${statusText}</span>` : ''}
          </div>
          <div class="profile-active-actions">
            ${isOutOfSync ? `
              <button class="btn btn-sm btn-ghost" id="btn-revert-changes" title="${t('environments:profile.revertTooltip')}">${t('environments:profile.revert')}</button>
              <button class="btn btn-sm" id="btn-update-profile" title="${t('environments:profile.updateProfileTooltip')}">${t('environments:profile.updateProfile')}</button>
            ` : ''}
            ${showApplyButton ? `<button class="btn btn-primary btn-sm" id="btn-apply-to-sc" title="${t('environments:profile.applyToScTooltip')}">${t('environments:profile.applyToSc', { version: escapeHtml(activeScVersion) })}</button>` : ''}
          </div>
        </div>
        ${showApplyButton ? renderHint('apply-explain', t('environments:hint.applyExplain')) : ''}
        ${showChangesPanel && activeProfileStatus && !activeProfileStatus.matched ? renderChangesPanel(activeProfileStatus.files) : ''}
      `;
    } else if (hasScFiles) {
      activeHeader = `
        <div class="profile-active-header profile-active-none">
          <div class="profile-active-info">
            <span class="text-muted">${t('environments:profile.noProfileLoaded')}</span>
          </div>
        </div>
      `;
    }

    profilesSection = `
      <div class="sc-section profiles-section">
        ${renderHint('profiles-intro', t('environments:hint.profilesIntro'))}
        ${activeHeader}
        <div class="profiles-card-grid">
          ${backups.map(b => {
            const isActive = lastRestoredBackupId === b.id;
            return `
              <div class="profile-card ${isActive ? 'active' : ''}" data-backup-id="${escapeHtml(b.id)}">
                <div class="profile-card-header">
                  <span class="profile-card-name">${escapeHtml(b.label || t('environments:profile.unnamedProfile'))}</span>
                  <div class="profile-card-actions">
                    <button class="btn-icon btn-icon-rename" data-action="rename-saved-profile" data-backup-id="${escapeHtml(b.id)}" title="${t('environments:profile.rename')}">
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>
                    </button>
                    <button class="btn-icon btn-icon-danger" data-action="delete-saved-profile" data-backup-id="${escapeHtml(b.id)}" title="${t('environments:profile.delete')}">
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
                    </button>
                  </div>
                </div>
                <div class="profile-card-meta">
                  <span class="profile-card-date">${escapeHtml(b.created_at)}</span>
                  <span class="backup-type-badge ${b.backup_type}">${escapeHtml(formatProfileTypeBadge(b.backup_type))}</span>
                  ${b.device_map?.length > 0 ? `<span class="backup-devices">${t('environments:profile.device', { count: b.device_map.length })}</span>` : ''}
                  ${b.dirty ? `<span class="backup-dirty-badge">${t('environments:profile.unsaved')}</span>` : ''}
                </div>
                ${!isActive ? `<button class="btn btn-sm profile-card-load" data-action="load-profile" data-backup-id="${escapeHtml(b.id)}">${t('environments:profile.load')}</button>` : `<span class="profile-card-active-badge">${t('environments:profile.active')}</span>`}
              </div>
            `;
          }).join('')}
          <div class="profile-card profile-card-add" id="btn-save-current" title="${t('environments:profile.saveCurrentTooltip')}">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="12" y1="5" x2="12" y2="19"></line>
              <line x1="5" y1="12" x2="19" y2="12"></line>
            </svg>
            <span>${t('environments:profile.saveCurrent')}</span>
          </div>
        </div>
        ${scVersions.length > 1 ? `<div class="profiles-section-footer"><button class="btn btn-sm" id="btn-import-version">${t('environments:profile.importFromVersion')}</button></div>` : ''}
      </div>
    `;
  }

  // === Collapsible Keybindings (only when a profile is loaded) ===
  const bindingsCollapsible = activeBackup ? renderBindingsCollapsible() : '';

  // === Collapsible Devices (only when a profile is loaded) ===
  const devicesCollapsible = activeBackup ? renderDeviceMapCollapsible() : '';

  return `
    <div class="sc-version-installed">
      ${importBanner}
      ${profilesSection}
      ${bindingsCollapsible}
      ${devicesCollapsible}
    </div>
  `;
}

/**
 * Renders the Localization tab: installation status + language selector.
 * @returns {string} HTML string for the tab content
 */
function renderLocalizationTab() {
  return `
    <div class="localization-tab">
      ${renderLocalizationStatus()}
      ${renderLanguageSelector()}
    </div>
  `;
}

/**
 * Renders the current localization status card.
 * Shows language, source, commit version, repository link, and file size.
 * Contains update and remove buttons.
 */
function renderLocalizationStatus() {
  const status = localizationStatus;

  if (!status || !status.installed) {
    return `
      <div class="profile-info-card">
        <div class="profile-info-row">
          <span class="profile-info-label">${t('environments:localization.language')}</span>
          <span class="profile-info-value">${t('environments:localization.englishDefault')}</span>
        </div>
        <div class="profile-info-row">
          <span class="profile-info-label">${t('environments:localization.status')}</span>
          <span class="profile-info-value"><span class="text-muted">${t('environments:localization.noTranslation')}</span></span>
        </div>
      </div>
    `;
  }

  const langName = status.language_name || status.language_code || 'Unknown';
  const sizeStr = status.file_size ? formatFileSize(status.file_size) : 'Unknown';
  const shortSha = status.commit_sha ? status.commit_sha.substring(0, 7) : null;
  const commitDateStr = status.commit_date ? formatCommitDate(status.commit_date) : null;

  return `
    <div class="profile-info-card">
      <div class="profile-info-row">
        <span class="profile-info-label">${t('environments:localization.language')}</span>
        <span class="profile-info-value localization-lang-active">${escapeHtml(langName)}</span>
      </div>
      ${status.language_code ? `
        <div class="profile-info-row">
          <span class="profile-info-label">${t('environments:localization.code')}</span>
          <span class="profile-info-value"><code>${escapeHtml(status.language_code)}</code></span>
        </div>
      ` : ''}
      ${status.source_label ? `
        <div class="profile-info-row">
          <span class="profile-info-label">${t('environments:localization.source')}</span>
          <span class="profile-info-value">${escapeHtml(status.source_label)}</span>
        </div>
      ` : ''}
      ${commitDateStr || shortSha ? `
        <div class="profile-info-row">
          <span class="profile-info-label">${t('environments:localization.translationVersion')}</span>
          <span class="profile-info-value">
            ${commitDateStr ? escapeHtml(commitDateStr) : ''}
            ${shortSha ? `<code class="localization-commit-hash">${escapeHtml(shortSha)}</code>` : ''}
          </span>
        </div>
      ` : ''}
      ${status.repo_url ? `
        <div class="profile-info-row">
          <span class="profile-info-label">${t('environments:localization.repository')}</span>
          <span class="profile-info-value">
            <a href="#" class="localization-repo-link" data-url="${escapeHtml(status.repo_url)}">
              ${escapeHtml(status.source_repo || status.repo_url)}
              <svg class="localization-repo-link-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>
                <polyline points="15 3 21 3 21 9"></polyline>
                <line x1="10" y1="14" x2="21" y2="3"></line>
              </svg>
            </a>
          </span>
        </div>
      ` : ''}
      ${status.installed_at ? `
        <div class="profile-info-row">
          <span class="profile-info-label">${t('environments:localization.installed')}</span>
          <span class="profile-info-value">${escapeHtml(status.installed_at)}</span>
        </div>
      ` : ''}
      <div class="profile-info-row">
        <span class="profile-info-label">${t('environments:localization.fileSize')}</span>
        <span class="profile-info-value">${sizeStr}</span>
      </div>
      <div class="profile-info-row">
        <span class="profile-info-label">${t('environments:localization.actionsLabel')}</span>
        <span class="profile-info-value">
          <button class="btn btn-sm btn-primary" id="btn-update-localization" ${localizationLoading ? 'disabled' : ''}>
            ${localizationLoading ? t('environments:localization.updating') : t('environments:localization.update')}
          </button>
          <button class="btn btn-sm btn-danger-sm" id="btn-remove-localization" ${localizationLoading ? 'disabled' : ''}>${t('environments:localization.remove')}</button>
        </span>
      </div>
    </div>
  `;
}

/**
 * Renders the table of available languages with install buttons.
 * Groups languages by language code (one language can have multiple sources).
 * Shows remote information (last update) when available.
 */
function renderLanguageSelector() {
  if (availableLanguages.length === 0) {
    return `<div class="sc-hint">${t('environments:localization.noLanguages')}</div>`;
  }

  // Group languages by code (one language can have multiple translation sources)
  const grouped = {};
  for (const lang of availableLanguages) {
    if (!grouped[lang.language_code]) {
      grouped[lang.language_code] = {
        language_code: lang.language_code,
        language_name: lang.language_name,
        flag: lang.flag,
        sources: [],
      };
    }
    grouped[lang.language_code].sources.push({
      source_repo: lang.source_repo,
      source_label: lang.source_label,
      repo_url: lang.repo_url,
    });
  }

  const languages = Object.values(grouped);
  const isInstalled = localizationStatus?.installed;
  const installedCode = localizationStatus?.language_code;
  const installedSource = localizationStatus?.source_label;

  // Flatten: one row per source (not per language)
  const rows = [];
  for (const lang of languages) {
    const isActive = isInstalled && installedCode === lang.language_code;
    for (const src of lang.sources) {
      rows.push({ lang, src, isActive, isSrcActive: isActive && installedSource === src.source_label });
    }
  }

  return `
    <div class="sc-section">
      <div class="sc-section-header">
        <h3>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10"></circle>
            <line x1="2" y1="12" x2="22" y2="12"></line>
            <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path>
          </svg>
          ${t('environments:localization.availableTitle')}
        </h3>
      </div>
      <div class="localization-table">
        <div class="localization-table-header">
          <span class="localization-col-lang">${t('environments:localization.colLanguage')}</span>
          <span class="localization-col-source">${t('environments:localization.colSource')}</span>
          <span class="localization-col-updated">${t('environments:localization.colUpdated')}</span>
          <span class="localization-col-action"></span>
        </div>
        ${rows.map(({ lang, src, isSrcActive }, idx) => {
          const remoteInfo = remoteLanguageInfo.find(
            r => r.source_repo === src.source_repo && r.language_code === lang.language_code
          );
          const lastUpdated = remoteInfo ? formatCommitDate(remoteInfo.commit_date) : '';
          const prevLang = idx > 0 ? rows[idx - 1].lang.language_code : null;
          const isNewGroup = prevLang !== null && prevLang !== lang.language_code;
          return `
          <div class="localization-table-row ${isSrcActive ? 'active' : ''} ${isNewGroup ? 'localization-group-first' : ''}">
            <span class="localization-col-lang">
              <span class="localization-lang-flag">${escapeHtml(lang.flag)}</span>
              <span class="localization-lang-name">${escapeHtml(lang.language_name)}</span>
            </span>
            <span class="localization-col-source">
              <span class="localization-source-label">${escapeHtml(src.source_label)}</span>
              ${src.repo_url ? `
                <a href="#" class="localization-repo-link-icon" data-url="${escapeHtml(src.repo_url)}" title="${t('environments:localization.openRepo')}">
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>
                    <polyline points="15 3 21 3 21 9"></polyline>
                    <line x1="10" y1="14" x2="21" y2="3"></line>
                  </svg>
                </a>
              ` : ''}
            </span>
            <span class="localization-col-updated">${escapeHtml(lastUpdated)}</span>
            <span class="localization-col-action">
              ${isSrcActive ? `<span class="localization-installed-badge">${t('environments:localization.installedBadge')}</span>` : `
                <button class="btn-install" data-action="install-lang"
                        data-lang-code="${escapeHtml(lang.language_code)}"
                        data-source-repo="${escapeHtml(src.source_repo)}"
                        data-lang-name="${escapeHtml(lang.language_name)}"
                        data-source-label="${escapeHtml(src.source_label)}"
                        ${localizationLoading ? 'disabled' : ''}>
                  ${t('environments:localization.install')}
                </button>
              `}
            </span>
          </div>
          `;
        }).join('')}
      </div>
      <div class="localization-hint">
        ${t('environments:localization.communityHint')}
      </div>
    </div>
  `;
}

/**
 * Formats bytes into human-readable file size (KB, MB, GB, etc.).
 * @param {number} bytes - Size in bytes
 * @returns {string} Formatted size string (e.g. "1.5 MB")
 */
function formatFileSize(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

/**
 * Formats an ISO date into German date format (e.g. "12. Mär. 2026").
 * @param {string} isoDate - ISO 8601 date string
 * @returns {string} Formatted date or original string on parse failure
 */
function formatCommitDate(isoDate) {
  if (!isoDate) return '';
  try {
    const date = new Date(isoDate);
    return date.toLocaleDateString('de-DE', { day: 'numeric', month: 'short', year: 'numeric' });
  } catch {
    return isoDate;
  }
}

// ==================== Localization Actions ====================

/**
 * Installs a language pack for the active SC version.
 * Shows a notification on success/error and updates the UI.
 */
async function installLocalization(langCode, sourceRepo, displayName, sourceLabel) {
  if (!config?.install_path || !activeScVersion) return;
  localizationLoading = true;
  renderEnvironments(document.getElementById('content'));

  try {
    await invoke('install_localization', {
      gamePath: config.install_path,
      version: activeScVersion,
      languageCode: langCode,
      sourceRepo: sourceRepo,
      languageName: displayName,
      sourceLabel: sourceLabel,
    });
    showNotification(t('environments:notification.translationInstalled', { language: displayName }), 'success');
    await Promise.all([loadLocalizationData(), loadUserCfgSettings()]);
  } catch (e) {
    showNotification(t('environments:notification.installFailed', { error: e }), 'error');
  }

  localizationLoading = false;
  renderEnvironments(document.getElementById('content'));
}

/**
 * Removes the installed localization after user confirmation.
 * Resets the language to English (default) and reloads the UI.
 */
async function removeLocalization() {
  if (!config?.install_path || !activeScVersion) return;

  const langName = localizationStatus?.language_name || 'translation';
  const confirmed = await confirm(t('environments:localization.removeConfirm', { language: langName }), { title: t('environments:localization.removeTitle'), kind: 'warning' });
  if (!confirmed) return;

  localizationLoading = true;
  renderEnvironments(document.getElementById('content'));

  try {
    await invoke('remove_localization', {
      gamePath: config.install_path,
      version: activeScVersion,
    });
    showNotification(t('environments:notification.translationRemoved'), 'success');
    await Promise.all([loadLocalizationData(), loadUserCfgSettings()]);
  } catch (e) {
    showNotification(t('environments:notification.removeFailed', { error: e }), 'error');
  }

  localizationLoading = false;
  renderEnvironments(document.getElementById('content'));
}

/**
 * Finds the source repository URL for the currently installed localization.
 * Matches against the available languages list by code and source label.
 * @returns {string|null} Repository identifier or null if not found
 */
function resolveSourceRepo() {
  if (!localizationStatus?.installed) return null;
  const code = localizationStatus.language_code;
  const label = localizationStatus.source_label;
  const match = availableLanguages.find(
    l => l.language_code === code && l.source_label === label
  );
  return match?.source_repo || null;
}

// ==================== Devices Section ====================

// ==================== Keybindings Section ====================

/**
 * Lightweight in-place update of the binding list.
 * Avoids a full page re-render and preserves the scroll position.
 * Called after binding changes (add, edit, delete).
 */
function refreshBindingsInPlace() {
  // Recompute categorized list
  const sourceList = completeBindingList.filter(b => {
    if (customizedOnly && !b.is_custom) return false;
    if (essentialsOnly && !ESSENTIAL_ACTIONS.has(b.action_name)) return false;
    if (boundOnly && !b.current_input) return false;
    return true;
  });

  const query = (bindingFilter || '').toLowerCase();

  const categorized = {};
  for (const b of sourceList) {
    // When a search is active, skip bindings whose action doesn't match
    if (query) {
      const inputText = (b.current_input || '').replace(/_/g, ' ');
      const searchable = [b.action_name, b.display_name, b.current_input || '', inputText].join(' ').toLowerCase();
      if (!searchable.includes(query)) continue;
    }
    const catKey = b.category || 'unknown';
    const catLabel = b.category_label || catKey;
    if (!categorized[catKey]) {
      categorized[catKey] = { label: catLabel, bindings: [], customCount: 0 };
    }
    categorized[catKey].bindings.push(b);
    if (b.is_custom) categorized[catKey].customCount++;
  }

  const categoryKeys = Object.keys(categorized).sort((a, b) =>
    (categorized[a].label || '').toLowerCase().localeCompare((categorized[b].label || '').toLowerCase())
  );

  // Ensure activeCategoryKey is valid
  if (!activeCategoryKey || !categorized[activeCategoryKey]) {
    activeCategoryKey = categoryKeys[0] || null;
  }

  // Re-render sidebar
  const sidebar = document.getElementById('bindings-sidebar');
  if (sidebar) sidebar.innerHTML = renderBindingSidebar(categorized, categoryKeys);

  // Build device columns
  const activeBackup = lastRestoredBackupId ? backups.find(b => b.id === lastRestoredBackupId) : null;
  const deviceMap = activeBackup?.device_map || [];
  const columns = [
    { id: 'keyboard', label: t('environments:device.keyboard', 'Keyboard'), prefix: 'kb', type: 'keyboard' },
    { id: 'mouse',    label: t('environments:device.mouse',    'Mouse'),    prefix: 'mo', type: 'mouse'    }
  ];
  deviceMap.filter(d => d.device_type === 'joystick')
    .sort((a, b) => parseInt(a.sc_instance) - parseInt(b.sc_instance))
    .forEach(d => columns.push({ id: `js${d.sc_instance}`, label: d.alias || d.product_name, prefix: `js${d.sc_instance}_`, type: 'joystick' }));

  // Re-render table body for active category
  const tbody = document.getElementById('bindings-tbody');
  const activeCat = activeCategoryKey ? categorized[activeCategoryKey] : null;
  if (tbody) {
    tbody.innerHTML = activeCat
      ? renderBindingRows(activeCat.bindings, activeCategoryKey, columns)
      : `<tr><td colspan="${columns.length + 1}" class="binding-empty-row">${t('environments:binding.noCategories', 'Keine Kategorien')}</td></tr>`;
  }

  // Update heading
  const titleEl = document.getElementById('bindings-cat-title');
  const subEl = document.getElementById('bindings-cat-sub');
  if (titleEl && activeCat) titleEl.textContent = activeCat.label;
  if (subEl && activeCat) subEl.textContent = `${activeCat.bindings.length} ${t('environments:binding.actions')}${activeCat.customCount ? ` · ${activeCat.customCount} ${t('environments:binding.customized', 'customized')}` : ''}`;

  // Update stats badge
  const badge = document.querySelector('.binding-stats-badge');
  if (badge) badge.textContent = t('environments:binding.customizedOfTotal', { custom: bindingStats.custom, total: bindingStats.total });

  // Sync toggles
  const customToggle = document.getElementById('customized-only-toggle');
  if (customToggle) customToggle.checked = customizedOnly;
  const essentialsToggle = document.getElementById('essentials-only-toggle');
  if (essentialsToggle) essentialsToggle.checked = essentialsOnly;
  const boundToggle = document.getElementById('bound-only-toggle');
  if (boundToggle) boundToggle.checked = boundOnly;

}

/**
 * Attaches binding-related event listeners using delegation on stable containers.
 * Must be called once after renderEnvironments() sets up the DOM — not after
 * every refreshBindingsInPlace() call, because delegated listeners survive
 * innerHTML updates to the sidebar and tbody.
 */
function attachBindingEventListeners() {
  // Sidebar: category selection (delegated — survives sidebar innerHTML updates)
  const sidebar = document.getElementById('bindings-sidebar');
  if (sidebar) {
    sidebar.addEventListener('click', (e) => {
      const item = e.target.closest('[data-action="select-binding-category"]');
      if (!item) return;
      activeCategoryKey = item.dataset.category;
      refreshBindingsInPlace();
    });
  }

  // Search input (attached once — refreshBindingsInPlace now updates both sidebar and table)
  document.getElementById('binding-search')?.addEventListener('input', (e) => {
    bindingFilter = e.target.value.toLowerCase().trim();
    refreshBindingsInPlace();
  });

  // Table actions (delegated — survives tbody innerHTML updates)
  const tbody = document.getElementById('bindings-tbody');
  if (!tbody) return;

  tbody.addEventListener('click', async (e) => {
    // remove-binding-direct — must be checked BEFORE matrix-assign because the remove
    // button lives inside a <td data-action="matrix-assign"> and would otherwise trigger
    // the cell-level assign handler instead of the per-pill remove handler.
    const removeDirectBtn = e.target.closest('[data-action="remove-binding-direct"]');
    if (removeDirectBtn) {
      e.stopPropagation();
      const actionName = removeDirectBtn.dataset.actionName;
      const category   = removeDirectBtn.dataset.category;
      const input      = removeDirectBtn.dataset.input || '';
      if (!lastRestoredBackupId) {
        showNotification(t('environments:notification.noProfileLoaded'), 'error');
        return;
      }
      const confirmed = await confirm(
        t('environments:binding.removeConfirm', { action: actionName }),
        { title: t('environments:binding.removeTitle'), kind: 'warning' }
      );
      if (confirmed) {
        try {
          await invoke('remove_profile_binding', {
            v: activeScVersion,
            profileId: lastRestoredBackupId,
            actionMap: category,
            actionName: actionName,
            input: input || null,
          });
          showNotification(t('environments:notification.bindingRemoved'), 'success');
          await loadProfileStatus();
          renderEnvironments(document.getElementById('content'));
        } catch (err) {
          showNotification(t('environments:notification.removeBindingFailed', { error: err }), 'error');
        }
      }
      return;
    }

    // add-binding
    const addBtn = e.target.closest('[data-action="add-binding"]');
    if (addBtn) {
      e.stopPropagation();
      openBindingEditor(addBtn.dataset.actionName, addBtn.dataset.category, null);
      return;
    }

    // matrix-assign — the <td> itself carries this data-action, so clicks on any child
    // (pill buttons: edit-binding, open-tuning) would match. Guard: skip if the click
    // originated inside a .binding-pill so pill-internal handlers get priority.
    const matrixBtn = e.target.closest('[data-action="matrix-assign"]');
    if (matrixBtn && !e.target.closest('.binding-pill')) {
      e.stopPropagation();
      const targetInstance = matrixBtn.dataset.targetInstance ? parseInt(matrixBtn.dataset.targetInstance, 10) : null;
      const deviceType = matrixBtn.dataset.deviceType || 'joystick';
      if (deviceType === 'mouse') {
        const existing = completeBindingList.find(b =>
          b.action_name === matrixBtn.dataset.actionName &&
          b.current_input &&
          b.current_input.startsWith('mo')
        );
        openMouseBindingEditor(matrixBtn.dataset.actionName, matrixBtn.dataset.category, existing?.current_input || '');
      } else {
        openBindingEditor(matrixBtn.dataset.actionName, matrixBtn.dataset.category, null, deviceType, targetInstance);
      }
      return;
    }

    // edit-binding
    const editBtn = e.target.closest('[data-action="edit-binding"]');
    if (editBtn) {
      e.stopPropagation();
      const cell = editBtn.closest('.binding-matrix-cell');
      const deviceType = cell?.dataset.deviceType || resolveDeviceType(editBtn.dataset.input) || 'joystick';
      const targetInstance = cell?.dataset.targetInstance ? parseInt(cell.dataset.targetInstance, 10) : null;
      if (deviceType === 'mouse') {
        openMouseBindingEditor(editBtn.dataset.actionName, editBtn.dataset.category, editBtn.dataset.input || '');
      } else {
        openBindingEditor(editBtn.dataset.actionName, editBtn.dataset.category, editBtn.dataset.input || '', deviceType, targetInstance);
      }
      return;
    }

    // open-tuning
    const tuningBtn = e.target.closest('[data-action="open-tuning"]');
    if (tuningBtn) {
      e.stopPropagation();
      const cell = tuningBtn.closest('.binding-matrix-cell');
      const targetInstance = cell?.dataset.targetInstance ? parseInt(cell.dataset.targetInstance, 10) : null;
      const deviceType = cell?.dataset.deviceType || 'joystick';
      console.log(`[TUNING-CLICK] Action: ${tuningBtn.dataset.actionName}, Input: ${tuningBtn.dataset.input}, Instance: ${targetInstance}`);
      openTuningEditor(tuningBtn.dataset.actionName, tuningBtn.dataset.category, tuningBtn.dataset.input, deviceType, targetInstance);
      return;
    }

    // add-alt-binding
    const addAltBtn = e.target.closest('[data-action="add-alt-binding"]');
    if (addAltBtn) {
      e.stopPropagation();
      openBindingEditor(addAltBtn.dataset.actionName, addAltBtn.dataset.category, null);
      return;
    }

    // remove-binding (modal delete button — remove-binding-direct is handled earlier)
    const removeBtn = e.target.closest('[data-action="remove-binding"]');
    if (removeBtn) {
      e.stopPropagation();
      const actionName = removeBtn.dataset.actionName;
      const category = removeBtn.dataset.category;
      const input = removeBtn.dataset.input || '';

      if (!lastRestoredBackupId) {
        showNotification(t('environments:notification.noProfileLoaded'), 'error');
        return;
      }

      const confirmed = await confirm(t('environments:binding.removeConfirm', { action: actionName }), {
        title: t('environments:binding.removeTitle'),
        kind: 'warning',
      });
      if (confirmed) {
        try {
          await invoke('remove_profile_binding', {
            v: activeScVersion,
            profileId: lastRestoredBackupId,
            actionMap: category,
            actionName: actionName,
            input: input || null,
          });
          showNotification(t('environments:notification.bindingRemoved'), 'success');
          await loadProfileStatus();
          renderEnvironments(document.getElementById('content'));
        } catch (err) {
          showNotification(t('environments:notification.removeBindingFailed', { error: err }), 'error');
        }
      }
    }
  });
}
/** SC tuning categories with human-readable labels */
const SC_TUNING_LABELS = {
  'master': 'Master',
  'flight_move_pitch': 'Pitch',
  'flight_move_yaw': 'Yaw',
  'flight_move_roll': 'Roll',
  'flight_move_strafe_vertical': 'Strafe Vertical',
  'flight_move_strafe_lateral': 'Strafe Lateral',
  'flight_move_strafe_longitudinal': 'Strafe Longitudinal',
  'flight_strafe_longitudinal': 'Strafe Longitudinal',
  'flight_strafe_forward': 'Strafe Forward',
  'flight_strafe_backward': 'Strafe Backward',
  'flight_throttle_abs': 'Throttle (Absolute)',
  'flight_throttle_rel': 'Throttle (Relative)',
  'flight_aim': 'Aim',
  'flight_view': 'Free Look',
  'turret_aim': 'Turret Aim',
  'mining_throttle': 'Mining Throttle',
  'mining_aim': 'Mining Aim',
  'flight_move_speed_range_abs': 'Speed Range (Abs)',
  'flight_move_speed_range_rel': 'Speed Range (Rel)',
  'flight_move_accel_range_abs': 'Accel Range (Abs)',
  'flight_move_accel_range_rel': 'Accel Range (Rel)',
  'throttle': 'Throttle',
  'viewaim': 'View / Aim',
};

/**
 * Mapping between Star Citizen action names (bindings) and their
 * internal tuning category names (options tags).
 */
const SC_ACTION_TO_TUNING_MAP = {
  'v_pitch': 'flight_move_pitch',
  'v_yaw': 'flight_move_yaw',
  'v_roll': 'flight_move_roll',
  'v_strafe_vertical': 'flight_move_strafe_vertical',
  'v_strafe_up': 'flight_move_strafe_vertical',
  'v_strafe_down': 'flight_move_strafe_vertical',
  'v_strafe_horizontal': 'flight_move_strafe_lateral',
  'v_strafe_lateral': 'flight_move_strafe_lateral',
  'v_strafe_left': 'flight_move_strafe_lateral',
  'v_strafe_right': 'flight_move_strafe_lateral',
  'v_strafe_longitudinal': 'flight_move_strafe_longitudinal',
  'v_strafe_forward': 'flight_strafe_forward',
  'v_strafe_backward': 'flight_strafe_backward',

  'v_ifcs_speed_limiter_abs': 'flight_move_speed_range_abs',
  'v_ifcs_speed_limiter_rel': 'flight_move_speed_range_rel',
  'v_ifcs_throttle_abs': 'flight_throttle_abs',
  'v_ifcs_throttle_rel': 'flight_throttle_rel',
  'v_throttle_abs': 'flight_throttle_abs',
  'v_throttle_rel': 'flight_throttle_rel',
  'v_view_pitch': 'flight_view',
  'v_view_yaw': 'flight_view',
  'v_mining_throttle': 'mining_throttle',
  'v_increase_mining_throttle': 'mining_throttle',
  'v_decrease_mining_throttle': 'mining_throttle',
  'v_aim_pitch': 'flight_aim',
  'v_aim_yaw': 'flight_aim',
  'turret_pitch': 'turret_aim',
  'turret_yaw': 'turret_aim',
  'v_ifcs_accel_limiter_abs': 'flight_move_accel_range_abs',
  'v_ifcs_accel_limiter_rel': 'flight_move_accel_range_rel',
};


/** All SC tuning categories that apply to joystick devices */
const SC_TUNING_DEFAULTS = [
  'flight_move_pitch', 'flight_move_yaw', 'flight_move_roll',
  'flight_move_strafe_vertical', 'flight_move_strafe_lateral', 'flight_move_strafe_longitudinal',
  'flight_strafe_forward', 'flight_strafe_backward', 'flight_strafe_longitudinal',
  'flight_throttle_abs', 'flight_throttle_rel',
  'flight_move_speed_range_abs', 'flight_move_speed_range_rel',
  'flight_move_accel_range_abs', 'flight_move_accel_range_rel',
  'flight_aim', 'flight_view', 'turret_aim', 'mining_throttle',
];

/**
 * Returns a human-readable label for a tuning category name.
 * Falls back to title-casing the technical name.
 */
function tuningLabel(name) {
  if (SC_TUNING_LABELS[name]) return SC_TUNING_LABELS[name];
  // Fallback: replace underscores, title case
  return name.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

/**
 * Loads tuning data from the backend for the active profile,
 * enriched with hardware axis info from connected devices.
 */
async function loadDeviceTuning() {
  if (!lastRestoredBackupId || !activeScVersion) {
    deviceTuningData = [];
    return;
  }
  try {
    // Load profile tuning data and connected hardware axes in parallel
    const [profileTuning, connectedAxes] = await Promise.all([
      invoke('get_device_tuning', {
        v: activeScVersion,
        profileId: lastRestoredBackupId,
      }),
      invoke('list_device_axes', { deviceMap: window.activeBackup?.device_map || [] }).catch(() => []),
    ]);

    // Enrich each device with hardware axes and default tuning entries
    for (const dev of profileTuning) {
      // Match connected hardware by product name (fuzzy: one contains the other)
      const hwMatch = connectedAxes.find(hw =>
        hw.product_name === dev.product ||
        dev.product.includes(hw.product_name) ||
        hw.product_name.includes(dev.product)
      );

      // Fill in missing axis_options from hardware detection
      if (hwMatch && dev.axis_options.length === 0) {
        dev.axis_options = hwMatch.axes.map(axis => ({
          input: axis.name,
          deadzone: 0.0,
          saturation: 1.0,
        }));
      }

      // Merge defaults: keep existing values, add missing categories
      const existingNames = new Set(dev.tuning.map(t => t.name));
      for (const name of SC_TUNING_DEFAULTS) {
        if (!existingNames.has(name)) {
          dev.tuning.push({
            name,
            invert: 0,
            exponent: 1.0,
            sensitivity: 1.0,
          });
        }
      }
      // Ensure existing entries have all fields with defaults
      for (const entry of dev.tuning) {
        if (entry.invert == null) entry.invert = 0;
        if (entry.exponent == null) entry.exponent = 1.0;
        if (entry.sensitivity == null) entry.sensitivity = 1.0;
      }
    }

    deviceTuningData = profileTuning;
  } catch (err) {
    debugLog('TUNING', 'error', `Failed to load tuning: ${err}`);
    deviceTuningData = [];
  }
}

/**
 * Resolves a binding action name to its corresponding Star Citizen tuning name.
 * Uses the mapping table and falls back to the original name if no match is found.
 * @param {string} actionName - Technical action name (e.g. "v_ifcs_speed_limiter_abs")
 * @returns {string} Tuning name (e.g. "flight_move_speed_range_abs")
 */
function resolveTuningName(actionName) {
  if (!actionName) return 'master';
  // Use mapping or fallback to original (which works for many movement axes)
  return SC_ACTION_TO_TUNING_MAP[actionName] || actionName;
}


/**
 * Saves tuning data for a specific device instance back to the profile.
 */
async function saveTuningForDevice(instance, deviceType) {
  const dev = deviceTuningData.find(d => d.instance === instance && d.device_type === deviceType);
  if (!dev || !lastRestoredBackupId || !activeScVersion) return;

  try {
    await invoke('update_device_tuning', {
      v: activeScVersion,
      profileId: lastRestoredBackupId,
      instance: dev.instance,
      deviceType: dev.device_type,
      axisOptions: dev.axis_options,
      tuning: dev.tuning,
    });
  } catch (err) {
    debugLog('TUNING', 'error', `Failed to save tuning: ${err}`);
    showNotification(t('environments:notification.tuningSaveFailed', { error: err }), 'error');
  }
}

/**
 * Renders the collapsible joystick section with drag-and-drop reordering.
 * Only joysticks are shown - keyboards/gamepads have fixed instance numbers.
 */
function renderDeviceMapCollapsible() {
  const activeBackup = lastRestoredBackupId ? backups.find(b => b.id === lastRestoredBackupId) : null;
  // Only show joysticks - keyboards/gamepads have fixed instance numbers
  const deviceMap = (activeBackup?.device_map || [])
    .filter(dm => dm.device_type === 'joystick')
    .sort((a, b) => a.sc_instance - b.sc_instance);
  if (deviceMap.length === 0) return '';

  const isExpanded = window.expandedPanels?.devices === true;

  return `
    <div class="sc-section collapsible-section">
      <div class="collapsible-header" data-panel="devices">
        <span class="collapsible-toggle ${isExpanded ? '' : 'collapsed'}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"></polyline></svg>
        </span>
        <h3>
          ${t('environments:device.title')}
          <span class="binding-stats-badge">${t('environments:binding.mapped', { count: deviceMap.length })}</span>
        </h3>
      </div>
      <div class="collapsible-content ${isExpanded ? '' : 'collapsed'}">
        ${renderHint('devices-intro', t('environments:hint.devicesIntro'))}
        <div class="device-map-list">
          ${deviceMap.map(dm => {
            return `
            <div class="device-card-v2 device-card draggable" data-product="${escapeHtml(dm.product_name)}" data-instance="${dm.sc_instance}" data-device-type="${escapeHtml(dm.device_type)}">
              <div class="device-card-v2-drag" title="${t('environments:device.dragToReorder')}">
                <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><circle cx="8" cy="4" r="2"/><circle cx="16" cy="4" r="2"/><circle cx="8" cy="12" r="2"/><circle cx="16" cy="12" r="2"/><circle cx="8" cy="20" r="2"/><circle cx="16" cy="20" r="2"/></svg>
              </div>
              <div class="device-card-v2-info">
                <div class="device-card-v2-top">
                  <span class="device-card-v2-instance">js${dm.sc_instance}</span>
                  <span class="device-card-v2-name" title="${escapeHtml(dm.product_name)}">${escapeHtml(dm.alias || dm.product_name)}</span>
                  <button class="device-card-v2-rename" data-product="${escapeHtml(dm.product_name)}" data-alias="${escapeHtml(dm.alias || '')}" title="${t('environments:device.setAlias')}">
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>
                  </button>
                </div>
              </div>
            </div>
          `}).join('')}
        </div>
      </div>
    </div>
  `;
}

/**
 * Renders the sidebar category list for the new sidebar+table binding layout.
 * @param {Object} categorized - { [catKey]: { label, bindings, customCount } }
 * @param {string[]} categoryKeys - sorted array of category keys
 * @returns {string} HTML string
 */
function renderBindingSidebar(categorized, categoryKeys) {
  if (categoryKeys.length === 0) {
    return `<div class="binding-sidebar-empty">${t('environments:binding.noCategories', 'No categories')}</div>`;
  }

  return categoryKeys.map(key => {
    const cat = categorized[key];
    const isActive = key === activeCategoryKey;
    const hasCustom = cat.customCount > 0;
    return `
      <div class="binding-sidebar-item ${isActive ? 'active' : ''}"
           data-action="select-binding-category"
           data-category="${escapeHtml(key)}"
           title="${escapeHtml(cat.label)}">
        <span class="binding-sidebar-dot ${hasCustom ? 'has-custom' : ''}"></span>
        <span class="binding-sidebar-label">${escapeHtml(cat.label)}</span>
        <span class="binding-sidebar-count">${cat.bindings.length}</span>
      </div>
    `;
  }).join('');
}

/**
 * Renders <tr> rows for the active category in the new sidebar layout.
 * @param {Object[]} items - bindings for this category
 * @param {string} categoryKey - the category key
 * @param {Object[]} columns - device columns: [{ id, label, prefix, type }]
 * @returns {string} HTML string of <tr> elements
 */
function renderBindingRows(items, categoryKey, columns) {
  // Group by action_name so we get 1 row per unique action
  const groupedActions = {};
  for (const b of items) {
    if (!groupedActions[b.action_name]) {
      groupedActions[b.action_name] = {
        action_name: b.action_name,
        display_name: b.display_name,
        category: b.category,
        bindings: []
      };
    }
    if (b.current_input) {
      groupedActions[b.action_name].bindings.push(b);
    }
  }

  const actionList = Object.values(groupedActions);
  const query = (bindingFilter || '').toLowerCase();

  const filteredGroups = !query ? actionList : actionList.filter(group => {
    let searchableText = [group.action_name, group.display_name, group.category].join(' ').toLowerCase();
    for (const b of group.bindings) {
      const inputDisplay = useHumanReadable ? formatInputDisplayText(b.current_input) : b.current_input;
      searchableText += ' ' + [b.current_input, inputDisplay].join(' ').toLowerCase();
      searchableText += ' ' + (b.current_input || '').replace(/_/g, ' ');
    }
    return searchableText.includes(query);
  });

  if (filteredGroups.length === 0) {
    return `<tr><td colspan="${columns.length + 1}" class="binding-empty-row">${t('environments:binding.noResults', 'Keine Ergebnisse')}</td></tr>`;
  }

  const isAxisInput = (input) => {
    if (!input) return false;
    const lower = input.toLowerCase();
    return lower.includes('_x') || lower.includes('_y') || lower.includes('_z') ||
           lower.includes('_rot') || lower.includes('_throttle') || lower.includes('_slider');
  };

  return filteredGroups.map(group => {
    let rowHtml = `
      <tr class="binding-row" data-action-name="${escapeHtml(group.action_name)}" data-display-name="${escapeHtml(group.display_name || '')}">
        <td class="binding-action-cell">
          <div class="binding-action-name">${escapeHtml(group.display_name || group.action_name)}</div>
          <div class="binding-action-key">${escapeHtml(group.action_name)}</div>
        </td>
    `;

    for (const col of columns) {
      // Exclude cleared-prefix placeholders (e.g. "js1_") from visible pills.
      // They are internal markers that suppress SC's defaults and must not
      // render as editable cells — the user should see a "+" button instead,
      // which triggers assign_profile_binding with old_input=null and the
      // backend replaces the placeholder rather than creating a duplicate.
      const colBindings = group.bindings.filter(b =>
        b.current_input.startsWith(col.prefix) && !b.current_input.endsWith('_')
      );
      const targetInstance = parseInt(col.id.replace(/\D/g, '')) || 0;

      rowHtml += `
        <td class="binding-matrix-cell"
            data-action="matrix-assign"
            data-action-name="${escapeHtml(group.action_name)}"
            data-category="${escapeHtml(categoryKey)}"
            data-device-type="${escapeHtml(col.type)}"
            data-target-instance="${targetInstance}">
          <div class="binding-cell-inner">
      `;

      if (colBindings.length > 0) {
        colBindings.forEach(b => {
          const inputDisplay = useHumanReadable ? formatInputDisplayText(b.current_input) : b.current_input;
          const isAxis = isAxisInput(b.current_input);
          const tuningName = resolveTuningName(b.action_name);
          const device = deviceTuningData.find(d => d.instance === targetInstance && d.device_type === col.type);

          let hasActiveTuning = false;
          if (device) {
            const tn = device.tuning.find(x => x.name === tuningName);
            if (tn && (tn.invert !== 0 || tn.exponent !== 1.0 || tn.sensitivity !== 1.0)) hasActiveTuning = true;
            if (!hasActiveTuning) {
              const axisInput = b.current_input.split('_').pop();
              const opt = device.axis_options.find(o => o.input === axisInput);
              if (opt && (opt.deadzone > 0 || opt.saturation < 1.0)) hasActiveTuning = true;
            }
          }

          rowHtml += `
            <div class="binding-pill ${b.is_custom ? 'custom' : 'default'}">
              <span class="binding-pill-label"
                    data-action="edit-binding"
                    data-action-name="${escapeHtml(b.action_name)}"
                    data-category="${escapeHtml(categoryKey)}"
                    data-input="${escapeHtml(b.current_input)}">${escapeHtml(inputDisplay)}</span>
              ${isAxis && col.type !== 'mouse' ? `
                <button class="binding-pill-tuning ${hasActiveTuning ? 'has-active-tuning' : ''}"
                        data-action="open-tuning"
                        data-action-name="${escapeHtml(b.action_name)}"
                        data-category="${escapeHtml(categoryKey)}"
                        data-input="${escapeHtml(b.current_input)}"
                        title="${hasActiveTuning ? t('environments:binding.hasTuning') : t('environments:binding.tuning')}">
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M3 19s4-15 9-15 9 15 9 15"/></svg>
                </button>
              ` : ''}
              <button class="binding-pill-remove"
                      data-action="remove-binding-direct"
                      data-action-name="${escapeHtml(b.action_name)}"
                      data-category="${escapeHtml(categoryKey)}"
                      data-input="${escapeHtml(b.current_input)}"
                      title="${t('environments:binding.remove')}">×</button>
            </div>
          `;
        });
      } else {
        rowHtml += `
          <button class="binding-cell-add"
                  data-action="matrix-assign"
                  data-action-name="${escapeHtml(group.action_name)}"
                  data-category="${escapeHtml(categoryKey)}"
                  data-device-type="${escapeHtml(col.type)}"
                  data-target-instance="${targetInstance}"
                  title="${t('environments:binding.clickToAssign', 'Zuweisen')}">+</button>
        `;
      }

      rowHtml += `</div></td>`;
    }

    rowHtml += `</tr>`;
    return rowHtml;
  }).join('');
}

/**
 * Renders the collapsible keybindings section with search field, filter toggle,
 * and category-based grouping of all bindings.
 */
function renderBindingsCollapsible() {
  const sourceList = completeBindingList.filter(b => {
    if (customizedOnly && !b.is_custom) return false;
    if (essentialsOnly && !ESSENTIAL_ACTIONS.has(b.action_name)) return false;
    if (boundOnly && !b.current_input) return false;
    return true;
  });

  const categorized = {};
  for (const b of sourceList) {
    const catKey = b.category || 'unknown';
    const catLabel = b.category_label || catKey;
    if (!categorized[catKey]) {
      categorized[catKey] = { label: catLabel, bindings: [], customCount: 0 };
    }
    categorized[catKey].bindings.push(b);
    if (b.is_custom) categorized[catKey].customCount++;
  }

  const categoryKeys = Object.keys(categorized).sort((a, b) =>
    (categorized[a].label || '').toLowerCase().localeCompare((categorized[b].label || '').toLowerCase())
  );

  // Set initial active category if not set or no longer valid
  if (!activeCategoryKey || !categorized[activeCategoryKey]) {
    activeCategoryKey = categoryKeys[0] || null;
  }

  const isExpanded = window.expandedPanels?.bindings === true;
  const activeCat = activeCategoryKey ? categorized[activeCategoryKey] : null;
  const activeBackup = lastRestoredBackupId ? backups.find(b => b.id === lastRestoredBackupId) : null;
  const deviceMap = activeBackup?.device_map || [];

  // Build device columns
  const columns = [
    { id: 'keyboard', label: t('environments:device.keyboard', 'Keyboard'), prefix: 'kb', type: 'keyboard' },
    { id: 'mouse',    label: t('environments:device.mouse',    'Mouse'),    prefix: 'mo', type: 'mouse'    }
  ];
  deviceMap.filter(d => d.device_type === 'joystick')
    .sort((a, b) => parseInt(a.sc_instance) - parseInt(b.sc_instance))
    .forEach(d => columns.push({
      id: `js${d.sc_instance}`,
      label: d.alias || d.product_name,
      prefix: `js${d.sc_instance}_`,
      type: 'joystick'
    }));

  // Device colour dots (first 2 fixed, rest yellow for joysticks)
  const deviceDotColors = ['#5bc4e8', '#b688f5', '#f5a623', '#f5a623', '#f5a623'];

  const tableBody = activeCat
    ? renderBindingRows(activeCat.bindings, activeCategoryKey, columns)
    : `<tr><td colspan="${columns.length + 1}" class="binding-empty-row">${t('environments:binding.noCategories', 'Keine Kategorien')}</td></tr>`;

  return `
    <div class="sc-section collapsible-section">
      <div class="collapsible-header" data-panel="bindings">
        <span class="collapsible-toggle ${isExpanded ? '' : 'collapsed'}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"></polyline></svg>
        </span>
        <h3>
          ${t('environments:binding.title')}
          <span class="binding-stats-badge">
            ${t('environments:binding.customizedOfTotal', { custom: bindingStats.custom, total: bindingStats.total })}
          </span>
          ${localizationLoading ? `<span class="loading-spinner-inline"></span>` : ''}
        </h3>
      </div>
      <div class="collapsible-content ${isExpanded ? '' : 'collapsed'}">
        ${renderHint('bindings-intro', t('environments:hint.bindingsIntro'))}

        <!-- Toolbar -->
        <div class="bindings-toolbar">
          <input type="text" class="input binding-search" id="binding-search"
                 placeholder="${t('environments:binding.searchPlaceholder')}"
                 value="${escapeHtml(bindingFilter)}"
                 aria-label="Search bindings" />
          <div class="bindings-filter-bar">
            <label class="filter-toggle" title="${t('environments:binding.customizedOnly')}">
              <span class="toggle-switch">
                <input type="checkbox" id="customized-only-toggle" ${customizedOnly ? 'checked' : ''}>
                <span class="toggle-slider"></span>
              </span>
              <span>${t('environments:binding.customizedOnly')}</span>
            </label>
            <label class="filter-toggle" title="${t('environments:binding.essentialsOnlyTooltip')}">
              <span class="toggle-switch">
                <input type="checkbox" id="essentials-only-toggle" ${essentialsOnly ? 'checked' : ''}>
                <span class="toggle-slider"></span>
              </span>
              <span>${t('environments:binding.essentialsOnly')}</span>
            </label>
            <label class="filter-toggle" title="${t('environments:binding.boundOnlyTooltip', 'Show only actions with at least one binding')}">
              <span class="toggle-switch">
                <input type="checkbox" id="bound-only-toggle" ${boundOnly ? 'checked' : ''}>
                <span class="toggle-slider"></span>
              </span>
              <span>${t('environments:binding.boundOnly', 'Bound only')}</span>
            </label>
          </div>
        </div>

        <!-- Sidebar + Table layout -->
        <div class="bindings-layout">
          <!-- Left: category sidebar -->
          <div class="bindings-sidebar" id="bindings-sidebar">
            ${renderBindingSidebar(categorized, categoryKeys)}
          </div>

          <!-- Right: active category table -->
          <div class="bindings-table-pane">
            <div class="bindings-cat-heading">
              <span class="bindings-cat-title" id="bindings-cat-title">
                ${activeCat ? escapeHtml(activeCat.label) : ''}
              </span>
              <span class="bindings-cat-sub" id="bindings-cat-sub">
                ${activeCat ? `${activeCat.bindings.length} ${t('environments:binding.actions')}${activeCat.customCount ? ` · ${activeCat.customCount} ${t('environments:binding.customized', 'customized')}` : ''}` : ''}
              </span>
            </div>
            <div class="bindings-col-header">
              <div class="bindings-col-th bindings-col-action">${t('environments:binding.columnAction')}</div>
              ${columns.map((col, i) => `
                <div class="bindings-col-th">
                  <span class="col-device-dot" style="background:${deviceDotColors[i] || '#f5a623'}"></span>
                  ${escapeHtml(col.label)}
                </div>
              `).join('')}
            </div>
            <div class="bindings-table-body" id="bindings-table-body">
              <table class="bindings-matrix-table">
                <colgroup>
                  <col style="width: 28%">
                  ${columns.map(() => `<col>`).join('')}
                </colgroup>
                <tbody id="bindings-tbody">
                  ${tableBody}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;
}


/**
 * Determines the device type based on the input prefix.
 * e.g. "kb1_w" -> 'keyboard', "js2_button5" -> 'joystick'
 * @param {string|null} input - Raw input string with device prefix
 * @returns {string} Device type: 'keyboard', 'mouse', 'gamepad', 'joystick', 'none', or 'unknown'
 */
function resolveDeviceType(input) {
  if (!input) return 'none';
  if (input.startsWith('kb')) return 'keyboard';
  if (input.startsWith('mo')) return 'mouse';
  if (input.startsWith('xi') || input.startsWith('gp')) return 'gamepad';
  if (input.startsWith('js')) return 'joystick';
  return 'unknown';
}

/**
 * Translates a device type key into a human-readable label.
 * @param {string} deviceType - Device type key (e.g. 'keyboard', 'joystick')
 * @returns {string} Human-readable label (e.g. "Keyboard", "Joystick")
 */
function formatDeviceType(deviceType) {
  const labels = {
    keyboard: t('environments:device.keyboard'),
    mouse: t('environments:device.mouse'),
    gamepad: t('environments:device.gamepad'),
    joystick: t('environments:device.joystick'),
    none: t('environments:device.none'),
    unknown: t('environments:device.unknown'),
  };
  return labels[deviceType] || deviceType;
}

/**
 * Resolve a concrete device name from the active profile's device_map.
 * E.g. "js1_button12" → "VKB Gladiator NXT" (via device_map sc_instance=1)
 * Falls back to generic type name if no device_map match.
 */
function resolveDeviceLabel(input) {
  if (!input) return 'Unbound';
  const deviceType = resolveDeviceType(input);

  // Extract instance number from input prefix (js1_, js2_, etc.)
  const instanceMatch = input.match(/^js(\d+)_/);
  if (instanceMatch) {
    const scInstance = parseInt(instanceMatch[1], 10);
    const activeBackup = lastRestoredBackupId ? backups.find(b => b.id === lastRestoredBackupId) : null;
    const deviceMap = activeBackup?.device_map || [];
    const dm = deviceMap.find(d => d.sc_instance === scInstance && d.device_type === 'joystick');
    if (dm) {
      return dm.alias || dm.product_name;
    }
    // Fallback: show instance number
    return `Joystick ${scInstance}`;
  }

  return formatDeviceType(deviceType);
}

/**
 * Generates an inline SVG icon wrapped in a span for the given device type.
 * @param {string} deviceType - Device type key (e.g. 'keyboard', 'mouse', 'joystick', 'gamepad')
 * @returns {string} HTML string containing the SVG icon
 */
function getDeviceIconSvg(deviceType) {
  const icons = {
    keyboard: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><line x1="6" y1="8" x2="6" y2="8"/><line x1="10" y1="8" x2="10" y2="8"/><line x1="14" y1="8" x2="14" y2="8"/><line x1="18" y1="8" x2="18" y2="8"/><line x1="6" y1="12" x2="6" y2="12"/><line x1="10" y1="12" x2="10" y2="12"/><line x1="14" y1="12" x2="14" y2="12"/><line x1="18" y1="12" x2="18" y2="12"/><line x1="8" y1="16" x2="16" y2="16"/></svg>`,
    mouse: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="2" width="12" height="20" rx="6"/><line x1="12" y1="6" x2="12" y2="10"/></svg>`,
    joystick: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3"/><line x1="12" y1="3" x2="12" y2="6"/><line x1="12" y1="18" x2="12" y2="21"/><line x1="3" y1="12" x2="6" y2="12"/><line x1="18" y1="12" x2="21" y2="12"/></svg>`,
    gamepad: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="6" width="20" height="12" rx="4"/><circle cx="6" cy="12" r="2"/><circle cx="10" cy="9" r="1"/><circle cx="14" cy="9" r="1"/><circle cx="18" cy="12" r="2"/></svg>`,
  };
  const icon = icons[deviceType] || icons.joystick;
  return `<span class="device-icon">${icon}</span>`;
}

/**
 * Converts a raw input format into human-readable text.
 * e.g. "button26" -> "Button #26", "x" -> "X-Axis", "hat1_up" -> "Hat #1 Up"
 * @param {string} input - Raw input string (without device prefix)
 * @returns {string} Human-readable representation
 */
function formatInputDisplayText(input) {
  if (!input) return '';

  // button26 → Button #26
  const btnMatch = input.match(/button(\d+)/i);
  if (btnMatch) return `Button #${btnMatch[1]}`;

  // POV/Hat without direction - treat as POV
  const povMatch = input.match(/pov(\d+)/i);
  if (povMatch) return `POV #${povMatch[1]}`;

  // Axes with optional neg/pos suffix
  const axisMap = {
    x: 'X-Axis', y: 'Y-Axis', z: 'Z-Axis',
    rotx: 'Rot X', roty: 'Rot Y', rotz: 'Rot Z',
    slider1: 'Slider 1', slider2: 'Slider 2'
  };
  const axisMatch = input.match(/(x|y|z|rotx|roty|rotz|slider1|slider2)(neg|pos)?/i);
  if (axisMatch) {
    const baseAxis = axisMap[axisMatch[1].toLowerCase()];
    if (baseAxis) {
      const suffix = axisMatch[2] ? (axisMatch[2].toLowerCase() === 'neg' ? ' (-)' : ' (+)') : '';
      return baseAxis + suffix;
    }
  }

  // Hats with direction: hat1_up, hat1_down, hat1_left, hat1_right
  const hatDirMatch = input.match(/hat(\d+)_(up|down|left|right)/i);
  if (hatDirMatch) {
    const hatNum = hatDirMatch[1];
    const dir = hatDirMatch[2].toLowerCase();
    const dirMap = { up: '↑ Up', down: '↓ Down', left: '← Left', right: '→ Right' };
    return `Hat #${hatNum} ${dirMap[dir] || dir}`;
  }

  // Hats without direction
  const hatMatch = input.match(/hat(\d+)/i);
  if (hatMatch) return `Hat #${hatMatch[1]}`;

  return input;
}

// ==================== Binding Editor ====================

/**
 * Strips the device prefix for display (e.g. "js2_x" -> "x", "kb1_w" -> "w").
 * @param {string|null} input - Raw input string with device prefix
 * @returns {string|null} Input without prefix, or original value if no prefix found
 */
function stripDevicePrefix(input) {
  if (!input) return input;
  return input.replace(/^(js|kb|mo)\d+_/, '');
}

/**
 * Opens the binding editor as a modal window.
 * Supports three input sources:
 * 1. Keyboard input via browser keydown events (local)
 * 2. Mouse buttons via browser mousedown events (local)
 * 3. Joystick/Gamepad via Rust backend hardware events (through Tauri listen)
 *
 * Joystick inputs are automatically remapped from Linux gilrs instance numbers
 * to SC instance numbers (via the profile's device map).
 *
 * @param {string} actionName - Name of the action to edit
 * @param {string} category - Actionmap category (e.g. "spaceship_movement")
 * @param {string|null} currentInput - Current binding (null for new binding)
 */
async function openBindingEditor(actionName, category, currentInput, defaultDeviceType = null, targetInstance = null) {
  bindingEditorAction = { actionName, category, currentInput };
  
  // If targetInstance is null, try to resolve it from the currentInput string (e.g. "js2_..." -> 2)
  if (targetInstance === null && currentInput) {
    const match = currentInput.match(/^(js|gp)(\d+)_/);
    if (match) targetInstance = parseInt(match[2], 10);
  }

  // Determine device type
  bindingEditorDevice = defaultDeviceType || resolveDeviceType(currentInput) || 'keyboard';
  
  // If targetInstance is still null but we're in a joystick/gamepad context,
  // we SHOULD NOT default to 1, because that blocks other instances.
  // We keep it as null to allow any device capture unless specifically locked by a column click.
  if (targetInstance === null) {
      console.log('[EDITOR] No target instance provided, defaulting to auto-detect (no filter)');
  }

  // Create modal
  const modal = document.createElement('div');
  modal.className = 'modal-overlay';
  modal.id = 'binding-editor-modal';

  const isEdit = currentInput && currentInput.length > 0;
  const title = isEdit ? t('environments:binding.editor.editTitle') : t('environments:binding.editor.addTitle');

  modal.innerHTML = `
    <div class="modal-content binding-editor-modal">
      <div class="modal-header">
        <h3>${title}</h3>
        <button class="modal-close" data-action="close-binding-editor">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18"></line>
            <line x1="6" y1="6" x2="18" y2="18"></line>
          </svg>
        </button>
      </div>
      <div class="modal-body">
        <div class="binding-editor-context">
          <span class="binding-editor-context-action">${escapeHtml(actionName)}</span>
          <span class="binding-editor-context-sep">/</span>
          <span class="binding-editor-context-category">${escapeHtml(category)}</span>
        </div>
        <div class="capture-zone" id="capture-container">
          <label class="capture-zone-label">${t('environments:binding.editor.pressKey')}</label>
          <div class="capture-zone-input-wrap">
            <input type="text" class="capture-input" id="binding-input-field"
                   value="${stripDevicePrefix(currentInput) || ''}"
                   placeholder="${t('environments:binding.editor.waitingForInput')}" readonly
                   aria-label="Captured input">
          </div>
        </div>
        <div class="binding-editor-device">
          <label>${t('environments:binding.editor.device')}</label>
          <select id="capture-device-select" class="capture-device-select" aria-label="${t('environments:binding.editor.device')}">
            <option value="">${t('environments:binding.editor.loadingDevices')}</option>
          </select>
        </div>
      </div>
      <div class="modal-footer">
        <div class="modal-footer-left">
          ${isEdit ? `<button class="btn btn-danger" id="btn-delete-binding">${t('environments:binding.editor.deleteBtn')}</button>` : ''}
          <button class="btn btn-secondary" id="btn-reset-binding" title="${t('environments:binding.editor.resetTooltip', 'Alle eigenen Änderungen entfernen und Default wiederherstellen')}">${t('environments:binding.editor.resetBtn', 'Reset to Default')}</button>
        </div>
        <div class="modal-footer-actions">
          <button class="btn btn-secondary" data-action="close-binding-editor">${t('environments:binding.editor.cancelBtn')}</button>
          <button class="btn btn-primary" id="btn-save-binding">${t('environments:binding.editor.saveBtn')}</button>
        </div>
      </div>
    </div>
  `;

  document.body.appendChild(modal);
  requestAnimationFrame(() => modal.classList.add('show'));

  // Get the active profile's device map for Linux->SC instance number mapping
  const activeBackup = lastRestoredBackupId ? backups.find(b => b.id === lastRestoredBackupId) : null;
  const profileDeviceMap = activeBackup?.device_map || [];

  // Load connected devices and display alongside the profile's device map
  const deviceSelect = modal.querySelector('#capture-device-select');
  let connectedDevices = [];

  const dmap = window.activeBackup?.device_map || [];
  invoke('list_connected_devices', { deviceMap: dmap }).then(devices => {
    connectedDevices = devices || [];
    console.log('[EDITOR] Connected devices:', connectedDevices);
    if (profileDeviceMap.length > 0) {
      // Show profile's SC devices with connection status
      deviceSelect.innerHTML = `
        <option value="">${t('environments:binding.editor.autoDetect')}</option>
        ${profileDeviceMap.map(dm => {
          const connected = connectedDevices.find(cd =>
            cd.product_name.toLowerCase() === dm.product_name.toLowerCase()
          );
          const alias = dm.alias || dm.product_name;
          const status = connected ? '●' : '○';
          return `
            <option value="${escapeHtml(dm.product_name)}" data-sc-instance="${dm.sc_instance}">
              ${status} ${escapeHtml(alias)} (SC js${dm.sc_instance})
            </option>
          `;
        }).join('')}
      `;
    } else if (connectedDevices.length > 0) {
      deviceSelect.innerHTML = `
        <option value="">${t('environments:binding.editor.autoDetect')}</option>
        ${connectedDevices.map(d => `
          <option value="${escapeHtml(d.product_name)}" data-instance="${d.instance}">
            ${escapeHtml(d.product_name)} (js${d.instance})
          </option>
        `).join('')}
      `;
    } else {
      deviceSelect.innerHTML = `<option value="">${t('environments:binding.editor.noDeviceDetected')}</option>`;
    }
  }).catch(err => {
    console.error('[EDITOR] Failed to list devices:', err);
    deviceSelect.innerHTML = `<option value="">${t('environments:binding.editor.errorLoadingDevices')}</option>`;
  });

  // Remapping is now handled by the backend (Binding Capture Rust module).
  // The backend uses the device_map to send correct jsN/gpN prefixes directly.
  
  const inputField = modal.querySelector('#binding-input-field');
  let inputCapturedUnlisten = null;
  let isLocked = false; // Jitter protection: prevents axis noise from overwriting button input
  let capturedDeviceUuid = '';
  let capturedDeviceName = '';
  let capturedRawCode = currentInput || ''; // Raw internal code for saving (with js{N}_ prefix)

  /**
   * Processes a captured input (keyboard, mouse, or joystick).
   * Locks for 1 second after capture to suppress axis noise.
   */
  const setCapturedInput = (captureData) => {
    if (isLocked) return;
    isLocked = true;

    // Support both formats: String (keyboard/mouse) and Object (joystick)
    let code = '';
    let deviceUuid = '';
    let deviceName = '';

    if (typeof captureData === 'string') {
      // Keyboard or mouse input (local)
      code = captureData;
      inputField.value = stripDevicePrefix(code);
    } else if (typeof captureData === 'object' && captureData !== null) {
      // Joystick input (backend handles remapping to SC instance automatically)
      code = captureData.input || '';
      deviceUuid = captureData.linux_uuid || '';
      deviceName = captureData.product_name || '';
      capturedDeviceUuid = deviceUuid;
      capturedDeviceName = deviceName;

      // Show human-readable input
      const displayCode = stripDevicePrefix(code);
      const dmEntry = profileDeviceMap.find(dm =>
        (dm.product_name || '').toLowerCase().includes((deviceName || '').toLowerCase())
        || (deviceName || '').toLowerCase().includes((dm.product_name || '').toLowerCase())
      );
      const displayName = dmEntry?.alias || deviceName;
      inputField.value = displayName ? `${displayCode} (${displayName})` : displayCode;
    }

    // Store raw code for saving (already has correct SC jsN_ prefix from backend)
    capturedRawCode = code;

    inputField.classList.add('captured-pulse');

    // 1-second lock after capture so axis noise doesn't overwrite button input
    setTimeout(() => {
      inputField.classList.remove('captured-pulse');
      isLocked = false;
    }, 1000);
  };

  // 1. Listen for backend hardware events (joysticks via Rust/gilrs)
  listen('input-captured', (event) => {
    console.log('[EDITOR] Hardware event received from Rust:', event.payload);
    setCapturedInput(event.payload);
  }).then(unlisten => {
    inputCapturedUnlisten = unlisten;
  });

  // 2. Local keyboard capture (browser keydown events)
  const handleKeyDownCapture = (e) => {
    e.preventDefault();
    if (['Control', 'Alt', 'Shift', 'Meta', 'AltGraph'].includes(e.key)) return;

    const parts = [];
    if (e.ctrlKey) parts.push('lctrl');
    if (e.altKey || e.key === 'AltGraph') parts.push('lalt');
    if (e.shiftKey) parts.push('lshift');

    let key = e.key.toLowerCase();
    const keyMap = { 'arrowup': 'up', 'arrowdown': 'down', 'arrowleft': 'left', 'arrowright': 'right', ' ': 'space', 'escape': 'esc', 'enter': 'return', 'backspace': 'backspace', 'tab': 'tab', 'insert': 'insert', 'delete': 'delete', 'home': 'home', 'end': 'end', 'pageup': 'pgup', 'pagedown': 'pgdn' };
    if (keyMap[key]) key = keyMap[key];

    if (key.length === 1 || key.startsWith('f') || keyMap[e.key.toLowerCase()]) {
        parts.push(key);
        setCapturedInput(`kb1_${parts.join('+')}`);
    }
  };

  // 3. Local mouse button capture (ignores left-click for UI interaction)
  const handleMouseDownCapture = (e) => {
    // Ignore left mouse button (0) so UI buttons like "Save" remain clickable
    if (e.button === 0) return;

    const btnMap = { 1: 'button3', 2: 'button2', 3: 'button4', 4: 'button5' };
    const btn = btnMap[e.button];
    if (btn) {
        setCapturedInput(`mo1_${btn}`);
    }
  };

  window.addEventListener('keydown', handleKeyDownCapture);
  window.addEventListener('mousedown', handleMouseDownCapture);


  // Start hardware capture in the backend (joystick events via gilrs).
  // We pass targetInstance and targetType to ensure the backend only listens to the device
  // corresponding to the column clicked (Rock-Solid Target Filtering).
  // installPath + selectedRunner enable the parallel Wine DirectInput helper for axis
  // name mapping (Linux name shown in UI, Wine name written to actionmaps.xml).
  console.log(`[EDITOR] Starting hardware capture: targetInstance=${targetInstance}, targetType=${bindingEditorDevice}`);
  invoke('load_config').catch(err => { logError(err, 'environments:load_config'); return null; }).then(cfg => {
    invoke('start_input_capture', {
      deviceMap: profileDeviceMap,
      targetInstance: targetInstance,
      targetType: bindingEditorDevice,
      installPath: cfg?.install_path ?? null,
      selectedRunner: cfg?.selected_runner ?? null,
    }).catch(err => {
      console.error('[EDITOR] Backend capture start failed:', err);
      showNotification(t('environments:notification.captureError', { error: err }), 'error');
    });
  });

  const cleanupAndClose = () => {
    invoke('stop_input_capture');
    // Persist any Wine axis name mappings learned during this capture session.
    // If the Wine helper was running and saw axis movements, we store the
    // Linux→Wine axis name mapping in the profile so future bindings are
    // written with the correct Wine axis name (e.g. "roty" instead of "slider1").
    if (lastRestoredBackupId && activeScVersion) {
      invoke('get_wine_axis_mappings').then(mappings => {
        if (Object.keys(mappings).length > 0) {
          invoke('update_profile_device_wine_maps', {
            v: activeScVersion,
            profileId: lastRestoredBackupId,
            instanceMappings: mappings,
          }).catch(e => console.warn('[WINE] Failed to persist axis mappings:', e));
        }
      }).catch(() => {});
    }
    if (inputCapturedUnlisten) inputCapturedUnlisten();
    window.removeEventListener('keydown', handleKeyDownCapture);
    window.removeEventListener('mousedown', handleMouseDownCapture);
    modal.classList.remove('show');
    setTimeout(() => modal.remove(), 200);
    bindingEditorAction = null;
  };

  modal.querySelectorAll('[data-action="close-binding-editor"]').forEach(btn => {
    btn.addEventListener('click', cleanupAndClose);
  });

  modal.addEventListener('click', (e) => { if (e.target === modal) cleanupAndClose(); });

  modal.querySelector('#btn-delete-binding')?.addEventListener('click', async () => {
    if (!lastRestoredBackupId) {
      showNotification(t('environments:notification.noProfileLoaded'), 'error');
      return;
    }

    try {
      await invoke('remove_profile_binding', {
        v: activeScVersion,
        profileId: lastRestoredBackupId,
        actionMap: category,
        actionName: actionName,
        input: currentInput || null,
      });

      showNotification(t('environments:notification.bindingRemoved'), 'success');
      if (bindingEditorAction?.category) {
        window.expandedBindingCategories.add(bindingEditorAction.category);
      }
      cleanupAndClose();
      await loadProfileStatus();
      renderEnvironments(document.getElementById('content'));
    } catch (err) {
      console.error('[EDITOR] Delete failed:', err);
      showNotification(t('environments:notification.deleteError', { error: err }), 'error');
    }
  });

  modal.querySelector('#btn-reset-binding')?.addEventListener('click', async () => {
    if (!lastRestoredBackupId) {
      showNotification(t('environments:notification.noProfileLoaded'), 'error');
      return;
    }

    try {
      await invoke('reset_profile_binding', {
        v: activeScVersion,
        profileId: lastRestoredBackupId,
        actionMap: category,
        actionName: actionName,
      });

      showNotification(t('environments:notification.bindingReset', 'Binding auf Default zurückgesetzt'), 'success');
      if (bindingEditorAction?.category) {
        window.expandedBindingCategories.add(bindingEditorAction.category);
      }
      cleanupAndClose();
      await loadProfileStatus();
      renderEnvironments(document.getElementById('content'));
    } catch (err) {
      console.error('[EDITOR] Reset failed:', err);
      showNotification(t('environments:notification.resetError', { error: err }), 'error');
    }
  });

  modal.querySelector('#btn-save-binding').addEventListener('click', async () => {
    // Use the raw captured code (preserves js{N}_ prefix needed internally)
    const newInput = capturedRawCode.trim();

    if (!newInput) {
      showNotification(t('environments:notification.noInputCaptured'), 'error');
      return;
    }

    // Check binding conflicts: same input on the same device?
    if (completeBindingList.length > 0) {
      const newInputBare = stripDevicePrefix(newInput);
      const newPrefix = (newInput.match(/^(js|kb|mo|gp|xi)\d+/) || [''])[0]; // e.g. "kb1", "js2"
      const captureDev = (capturedDeviceName || '').trim().toLowerCase();
      const conflicting = completeBindingList.find(b => {
        if (b.action_name === actionName || !b.current_input) return false;
        const existingBare = stripDevicePrefix(b.current_input);
        if (existingBare !== newInputBare) return false;
        // Match by device prefix (kb1, js2, mo1) — covers keyboard/mouse where capturedDeviceName is empty
        const existingPrefix = (b.current_input.match(/^(js|kb|mo|gp|xi)\d+/) || [''])[0];
        if (newPrefix && existingPrefix && newPrefix === existingPrefix) return true;
        // Fallback: match by device product name (for joysticks with same prefix but different devices)
        const existingDev = (b.device_type || '').trim().toLowerCase();
        return captureDev && existingDev && (captureDev.includes(existingDev) || existingDev.includes(captureDev));
      });
      if (conflicting) {
        const displayInput = stripDevicePrefix(newInput);
        const proceed = await confirm(
          t('environments:binding.editor.conflictMsg', { input: displayInput, action: conflicting.display_name || conflicting.action_name }),
          { title: t('environments:binding.editor.conflictTitle'), kind: 'warning' }
        );
        if (!proceed) return;
      }
    }

    if (!lastRestoredBackupId) {
      showNotification(t('environments:notification.noProfileForSave'), 'error');
      return;
    }

    try {
      // Determine which existing binding to replace:
      // - Edit mode (currentInput set): replace exactly this binding
      // - Add mode (currentInput null): check if same device type already bound -> replace
      let oldInput = currentInput || null;
      if (!oldInput) {
        const newPrefix = (newInput.match(/^(js|kb|mo|gp|xi)\d+_/) || [])[0];
        if (newPrefix) {
          const prefixType = newPrefix.replace(/\d+_$/, ''); // e.g. "js", "kb"
          const sameTypeBinding = completeBindingList.find(b =>
            b.action_name === actionName
            && b.category === category
            && b.current_input
            && b.current_input.startsWith(prefixType)
          );
          if (sameTypeBinding) {
            oldInput = sameTypeBinding.current_input;
          }
        }
      }

      const sessionWineMaps = await invoke('get_wine_axis_mappings').catch(() => ({}));

      await invoke('assign_profile_binding', {
        v: activeScVersion,
        profileId: lastRestoredBackupId,
        actionMap: category,
        actionName: actionName,
        newInput: newInput,
        oldInput,
        wineAxisMap: Object.keys(sessionWineMaps).length > 0 ? sessionWineMaps : null,
      });

      showNotification(t('environments:notification.bindingSaved'), 'success');
      if (bindingEditorAction?.category) {
        window.expandedBindingCategories.add(bindingEditorAction.category);
      }
      cleanupAndClose();
      await loadProfileStatus();
      renderEnvironments(document.getElementById('content'));
    } catch (err) {
      console.error('[EDITOR] Save failed. Error:', err);
      showNotification(t('environments:notification.saveError', { error: err }), 'error');
    }
  });

  document.body.appendChild(modal);
}

/**
 * Opens a mouse-specific binding dialog showing a static list of SC-compatible
 * mouse inputs. Does NOT use live input capture (the OS mouse is needed for UI).
 *
 * @param {string} actionName  - Technical action name, e.g. "v_pitch"
 * @param {string} category    - Action map name, e.g. "spaceship_movement"
 * @param {string} currentInput - Existing binding, e.g. "mo1_maxis_y" or ""
 */
async function openMouseBindingEditor(actionName, category, currentInput) {
  const displayName = (completeBindingList.find(b => b.action_name === actionName) || {}).display_name || actionName;

  // Static list of all SC-compatible mouse inputs
  const MOUSE_INPUTS = [
    // Section: axes
    { section: 'axes', icon: '↔', code: 'mo1_maxis_x',      labelKey: 'binding.mouse.axisX' },
    { section: 'axes', icon: '↕', code: 'mo1_maxis_y',      labelKey: 'binding.mouse.axisY' },
    // Section: scroll
    { section: 'scroll', icon: '▲', code: 'mo1_mwheel_up',    labelKey: 'binding.mouse.wheelUp' },
    { section: 'scroll', icon: '▼', code: 'mo1_mwheel_down',  labelKey: 'binding.mouse.wheelDown' },
    { section: 'scroll', icon: '►', code: 'mo1_mhwheel_right',labelKey: 'binding.mouse.hWheelRight' },
    { section: 'scroll', icon: '◄', code: 'mo1_mhwheel_left', labelKey: 'binding.mouse.hWheelLeft' },
    // Section: buttons
    { section: 'buttons', icon: '◉', code: 'mo1_mouse1', labelKey: 'binding.mouse.btn1' },
    { section: 'buttons', icon: '◉', code: 'mo1_mouse2', labelKey: 'binding.mouse.btn2' },
    { section: 'buttons', icon: '⊙', code: 'mo1_mouse3', labelKey: 'binding.mouse.btn3' },
    { section: 'buttons', icon: '◂', code: 'mo1_mouse4', labelKey: 'binding.mouse.btn4' },
    { section: 'buttons', icon: '▸', code: 'mo1_mouse5', labelKey: 'binding.mouse.btn5' },
  ];

  const SECTION_LABELS = {
    axes:    { key: 'binding.mouse.sectionAxes',    title: t('environments:binding.mouse.sectionAxes',    'Movement Axes') },
    scroll:  { key: 'binding.mouse.sectionScroll',  title: t('environments:binding.mouse.sectionScroll',  'Scroll Wheels') },
    buttons: { key: 'binding.mouse.sectionButtons', title: t('environments:binding.mouse.sectionButtons', 'Buttons') },
  };

  let selectedCode = currentInput || '';

  const renderRows = () => {
    return ['axes', 'scroll', 'buttons'].map(section => {
      const rows = MOUSE_INPUTS.filter(inp => inp.section === section).map(inp => {
        const isSelected = inp.code === selectedCode;
        return `
        <div class="mouse-binding-row ${isSelected ? 'selected' : ''}"
             data-action="mouse-input-select"
             data-code="${escapeHtml(inp.code)}">
          <div class="mouse-binding-icon">${escapeHtml(inp.icon)}</div>
          <div class="mouse-binding-info">
            <div class="mouse-binding-name">${escapeHtml(t(`environments:${inp.labelKey}`, inp.labelKey))}</div>
            <div class="mouse-binding-code">${escapeHtml(inp.code)}</div>
          </div>
          <div class="mouse-binding-radio ${isSelected ? 'on' : ''}"></div>
        </div>`;
      }).join('');
      return `<div class="mouse-binding-column">
        <div class="mouse-binding-section-title">${escapeHtml(SECTION_LABELS[section].title)}</div>
        ${rows}
      </div>`;
    }).join('');
  };

  const currentDisplay = currentInput
    ? `<span class="mouse-binding-current-val">${escapeHtml(currentInput)}</span>`
    : `<span class="mouse-binding-current-empty">${t('environments:binding.mouse.unbound', 'none')}</span>`;

  const modal = document.createElement('div');
  modal.className = 'modal-overlay';
  modal.id = 'mouse-binding-editor-modal';

  modal.innerHTML = `
    <div class="modal-content mouse-binding-modal">
      <div class="modal-header">
        <div>
          <h3>${t('environments:binding.mouse.title', 'Mouse Binding')}</h3>
          <div class="binding-editor-context">
            <span class="binding-editor-context-action">${escapeHtml(displayName)}</span>
            <span class="binding-editor-context-sep">·</span>
            <span class="binding-editor-context-category">${escapeHtml(actionName)}</span>
            <span class="binding-editor-context-sep">·</span>
            <span class="binding-editor-context-category">${escapeHtml(category)}</span>
          </div>
        </div>
        <button class="modal-close" id="btn-mouse-close">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line>
          </svg>
        </button>
      </div>
      <div class="mouse-binding-current">
        <span class="mouse-binding-current-label">${t('environments:binding.mouse.currentLabel', 'Current:')}</span>
        ${currentDisplay}
      </div>
      <div class="mouse-binding-columns" id="mouse-binding-list">
        ${renderRows()}
      </div>
      <div class="modal-footer">
        <div class="modal-footer-left">
          <button class="btn btn-secondary" id="btn-mouse-reset">${t('environments:binding.editor.resetBtn', 'Reset to Default')}</button>
        </div>
        <div class="modal-footer-actions">
          <button class="btn btn-secondary" id="btn-mouse-cancel">${t('environments:binding.editor.cancelBtn', 'Cancel')}</button>
          <button class="btn btn-primary" id="btn-mouse-save">${t('environments:binding.editor.saveBtn', 'Save')}</button>
        </div>
      </div>
    </div>
  `;

  document.body.appendChild(modal);
  requestAnimationFrame(() => modal.classList.add('show'));

  const cleanupAndClose = () => {
    modal.classList.remove('show');
    setTimeout(() => modal.remove(), 200);
  };

  // Row selection
  modal.querySelector('#mouse-binding-list').addEventListener('click', (e) => {
    const row = e.target.closest('[data-action="mouse-input-select"]');
    if (!row) return;
    selectedCode = row.dataset.code;
    // Re-render list with new selection
    modal.querySelector('#mouse-binding-list').innerHTML = renderRows();
    // Update current badge
    const badge = modal.querySelector('.mouse-binding-current');
    badge.innerHTML = `
      <span class="mouse-binding-current-label">${t('environments:binding.mouse.currentLabel', 'Current:')}</span>
      <span class="mouse-binding-current-val">${escapeHtml(selectedCode)}</span>
    `;
  });

  // Close / Cancel
  modal.querySelector('#btn-mouse-close').addEventListener('click', cleanupAndClose);
  modal.querySelector('#btn-mouse-cancel').addEventListener('click', cleanupAndClose);
  modal.addEventListener('click', (e) => { if (e.target === modal) cleanupAndClose(); });

  // Reset to Default
  modal.querySelector('#btn-mouse-reset').addEventListener('click', async () => {
    if (!lastRestoredBackupId) {
      showNotification(t('environments:notification.noProfileLoaded'), 'error');
      return;
    }
    try {
      await invoke('reset_profile_binding', {
        v: activeScVersion,
        profileId: lastRestoredBackupId,
        actionMap: category,
        actionName: actionName,
      });
      showNotification(t('environments:notification.bindingReset', 'Binding reset to default'), 'success');
      window.expandedBindingCategories?.add(category);
      cleanupAndClose();
      await loadProfileStatus();
      renderEnvironments(document.getElementById('content'));
    } catch (err) {
      showNotification(t('environments:notification.resetError', { error: err }), 'error');
    }
  });

  // Save
  modal.querySelector('#btn-mouse-save').addEventListener('click', async () => {
    if (!selectedCode) {
      showNotification(t('environments:notification.noInputCaptured', 'No input selected'), 'error');
      return;
    }
    if (!lastRestoredBackupId) {
      showNotification(t('environments:notification.noProfileForSave'), 'error');
      return;
    }
    try {
      const sessionWineMaps = await invoke('get_wine_axis_mappings').catch(() => ({}));

      await invoke('assign_profile_binding', {
        v: activeScVersion,
        profileId: lastRestoredBackupId,
        actionMap: category,
        actionName: actionName,
        newInput: selectedCode,
        oldInput: currentInput || null,
        wineAxisMap: Object.keys(sessionWineMaps).length > 0 ? sessionWineMaps : null,
      });
      showNotification(t('environments:notification.bindingSaved'), 'success');
      window.expandedBindingCategories?.add(category);
      cleanupAndClose();
      await loadProfileStatus();
      renderEnvironments(document.getElementById('content'));
    } catch (err) {
      showNotification(t('environments:notification.saveError', { error: err }), 'error');
    }
  });
}

// Make globally accessible (for inline onclick handlers)
window.openTuningEditor = openTuningEditor;
window.openMouseBindingEditor = openMouseBindingEditor;

/**
 * Opens a modal to configure tuning (curves, inversions, deadzones) for an axis.
 */
async function openTuningEditor(actionName, category, currentInput, deviceType, targetInstance) {

  const v = activeScVersion;
  const profileId = lastRestoredBackupId;
  
  if (!v || !profileId) {
    showNotification(t('environments:notification.noProfileLoaded', 'Kein Profil geladen'), 'error');
    return;
  }

  // Common mapping for SC internal tuning tags
  const tuningName = resolveTuningName(actionName);
  const axisInput = currentInput.split('_').pop(); // e.g. "js2_x" -> "x"
  const displayName = (completeBindingList.find(b => b.action_name === actionName) || {}).display_name || '';


  console.log(`[TUNING] Opening for: ${actionName} (${tuningName}), Input: ${currentInput} (Axis: ${axisInput})`);

  try {
    debugLog('TUNING', 'info', `Fetching tuning data: v=${v}, profile_id=${profileId}`);
    const devices = await invoke('get_device_tuning', { v, profileId });
    debugLog('TUNING', 'info', `Fetched ${devices.length} devices from profile`);
    
    // In Rust, fields are snake_case: device_type, instance, product
    const device = devices.find(d => d.instance === targetInstance && d.device_type === deviceType);
    if (!device) {
      debugLog('TUNING', 'warn', `Device not found: type=${deviceType}, instance=${targetInstance}`);
      showNotification(t('environments:notification.deviceNotFound', 'Gerät nicht im Profil gefunden'), 'error');
      return;
    }

    debugLog('TUNING', 'info', `Device found: ${device.product}`);
    const currentTuning = device.tuning.find(t => t.name === tuningName) || { name: tuningName, invert: 0, exponent: 1.0, sensitivity: 1.0 };
    const axisOption = device.axis_options.find(o => o.input === axisInput) || { input: axisInput, deadzone: 0.0, saturation: 1.0 };


    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.innerHTML = `
      <div class="modal-container tuning-editor-modal">
        <div class="modal-header">
          <div class="modal-title-wrap">
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="modal-icon-info"><path d="M12 20v-8m0-4h.01M22 12c0 5.523-4.477 10-10 10S2 17.523 2 12 6.477 2 12 2s10 4.477 10 10z"/></svg>
            <h3>${t('environments:tuning.title', 'Tuning Editor')}</h3>
          </div>
          <button class="btn-close modal-close-btn" data-action="close-tuning-editor">×</button>
        </div>
        <div class="modal-body">
          <div class="tuning-canvas-container">
            <div class="tuning-grid-overlay"></div>
            <div class="tuning-axis-labels">
              <div style="display: flex; justify-content: space-between; width: 100%;">
                <span>Output 1.0</span>
                <span>(In)</span>
              </div>
              <div style="display: flex; justify-content: space-between; align-items: flex-end; width: 100%; height: 100%;">
                <span>0.0</span>
                <span>1.0</span>
              </div>
            </div>
            <canvas id="tuningCurve" width="470" height="220" style="position: relative; z-index: 2;"></canvas>
          </div>

          <div class="tuning-info">
            <div class="tuning-device-name">${escapeHtml(device.product)}</div>
            <div class="tuning-action-name">${displayName ? escapeHtml(displayName) : actionName} <span class="text-muted">(${currentInput})</span></div>
          </div>

          <div class="tuning-grid">
            <label class="filter-toggle">
              <span class="toggle-switch">
                <input type="checkbox" id="tuningInvert" ${currentTuning.invert ? 'checked' : ''}>
                <span class="toggle-slider"></span>
              </span>
              <span>${t('environments:tuning.invert', 'Invert Axis')}</span>
            </label>

            <div class="tuning-section">
              <div class="tuning-slider-label">
                <span><svg style="vertical-align: middle; margin-right: 4px;" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m19 11-4-7-4 7h8Z"/><path d="M12 18v-7"/><path d="M4 22v-3a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v3"/><path d="m6 11 4-7 4 7H6Z"/></svg> ${t('environments:tuning.exponent', 'Curve Exponent')}</span>
                <span class="tuning-value-badge" id="valExponent">${(currentTuning.exponent || 1.0).toFixed(2)}</span>
              </div>
              <input type="range" class="tuning-range" id="tuningExponent" min="0.5" max="3.5" step="0.05" value="${currentTuning.exponent || 1.0}">
            </div>

            <div class="tuning-section">
              <div class="tuning-slider-label">
                <span><svg style="vertical-align: middle; margin-right: 4px;" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="20" height="8" x="2" y="4" rx="2"/><path d="M12 12v10"/><path d="m16 18-4 4-4-4"/></svg> ${t('environments:tuning.deadzone', 'Deadzone')}</span>
                <span class="tuning-value-badge" id="valDeadzone">${(axisOption.deadzone || 0.0).toFixed(2)}</span>
              </div>
              <input type="range" class="tuning-range" id="tuningDeadzone" min="0" max="0.5" step="0.01" value="${axisOption.deadzone || 0.0}">
            </div>

            <div class="tuning-section">
              <div class="tuning-slider-label">
                <span><svg style="vertical-align: middle; margin-right: 4px;" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 20h20"/><path d="M5 20v-4"/><path d="M9 20v-8"/><path d="M13 20v-12"/><path d="M17 20v-16"/></svg> ${t('environments:tuning.saturation', 'Saturation')}</span>
                <span class="tuning-value-badge" id="valSaturation">${(axisOption.saturation || 1.0).toFixed(2)}</span>
              </div>
              <input type="range" class="tuning-range" id="tuningSaturation" min="0.5" max="1.0" step="0.01" value="${axisOption.saturation || 1.0}">
            </div>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" data-action="close-tuning-editor">${t('common:cancel', 'Cancel')}</button>
          <button class="btn btn-primary" id="btn-save-tuning">
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-right: 6px;"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>
            ${t('common:save', 'Apply Settings')}
          </button>
        </div>
      </div>
    `;

    const closeTuning = () => { 
      modal.classList.remove('show');
      setTimeout(() => modal.remove(), 200); 
    };
    modal.querySelectorAll('[data-action="close-tuning-editor"]').forEach(btn => btn.addEventListener('click', closeTuning));
    
    // Live Visualizer Logic
    const canvas = modal.querySelector('#tuningCurve');
    const drawCurve = () => {
      const ctx = canvas.getContext('2d');
      const w = canvas.width;
      const h = canvas.height;
      const exp = parseFloat(modal.querySelector('#tuningExponent').value);
      const dz = parseFloat(modal.querySelector('#tuningDeadzone').value);
      const sat = parseFloat(modal.querySelector('#tuningSaturation').value);
      
      ctx.clearRect(0, 0, w, h);
      
      // Draw Grid Area Shade
      ctx.fillStyle = 'rgba(6, 182, 212, 0.02)';
      ctx.fillRect(0, 0, w, h);

      // Draw Curve
      ctx.beginPath();
      ctx.strokeStyle = '#06b6d4';
      ctx.lineWidth = 3;
      ctx.lineCap = 'round';
      ctx.shadowBlur = 12;
      ctx.shadowColor = 'rgba(6, 182, 212, 0.6)';
      
      for (let x = 0; x <= w; x++) {
        const input = x / w;
        let output = 0;
        
        if (input > dz) {
          const t = Math.max(0, Math.min(1, (input - dz) / (sat - dz)));
          output = Math.pow(t, exp);
        }
        
        const canvasY = h - (output * h);
        if (x === 0) ctx.moveTo(x, canvasY);
        else ctx.lineTo(x, canvasY);
      }
      ctx.stroke();
      ctx.shadowBlur = 0;
      
      // Draw Deadzone Visual (Red tint)
      if (dz > 0) {
        ctx.fillStyle = 'rgba(239, 68, 68, 0.1)';
        ctx.fillRect(0, 0, dz * w, h);
        ctx.strokeStyle = 'rgba(239, 68, 68, 0.4)';
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(dz * w, 0);
        ctx.lineTo(dz * w, h);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // Draw Saturation Line
      if (sat < 1.0) {
        ctx.strokeStyle = 'rgba(234, 179, 8, 0.4)';
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(sat * w, 0);
        ctx.lineTo(sat * w, h);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    };

    // Live update displays and canvas
    modal.querySelectorAll('.tuning-range').forEach(input => {
      input.addEventListener('input', (e) => {
        const id = e.target.id;
        const val = parseFloat(e.target.value).toFixed(2);
        if (id === 'tuningExponent') modal.querySelector('#valExponent').textContent = val;
        if (id === 'tuningDeadzone') modal.querySelector('#valDeadzone').textContent = val;
        if (id === 'tuningSaturation') modal.querySelector('#valSaturation').textContent = val;
        drawCurve();
      });
    });

    modal.querySelector('#btn-save-tuning').addEventListener('click', async () => {
      try {
        const exponent = parseFloat(modal.querySelector('#tuningExponent').value);
        const deadzone = parseFloat(modal.querySelector('#tuningDeadzone').value);
        const saturation = parseFloat(modal.querySelector('#tuningSaturation').value);
        const invert = modal.querySelector('#tuningInvert').checked ? 1 : 0;

        const updatedTuning = [...device.tuning.filter(t => t.name !== tuningName), { name: tuningName, invert, exponent, sensitivity: currentTuning.sensitivity || 1.0 }];
        const updatedDeadzones = [...device.axis_options.filter(o => o.input !== axisInput), { input: axisInput, deadzone, saturation }];

        await invoke('update_device_tuning', {
          v,
          profileId,
          instance: targetInstance,
          deviceType,
          axisOptions: updatedDeadzones,
          tuning: updatedTuning
        });

        showNotification(t('environments:notification.tuningSaved', 'Tuning saved successfully'), 'success');
        closeTuning();
        
        // Refresh all relevant state
        if (typeof loadBackups === 'function') await loadBackups();
        if (typeof loadProfileStatus === 'function') await loadProfileStatus();
        if (typeof loadDeviceTuning === 'function') await loadDeviceTuning();
        
        // Final re-render (scrolling is now handled by renderEnvironments)
        if (content) renderEnvironments(content);


      } catch (err) {
        console.error('[TUNING] Save failed:', err);
        showNotification(t('environments:notification.saveError', { error: err }), 'error');
      }
    });

    document.body.appendChild(modal);
    requestAnimationFrame(() => {
      modal.classList.add('show');
      drawCurve();
    });

  } catch (err) {
    console.error('[TUNING] Failed to open editor:', err);
    showNotification(t('environments:notification.fetchError', { error: err }), 'error');
  }
}

// Make globally accessible (for inline onclick handlers)
window.openBindingEditor = openBindingEditor;

/**
 * Formats a technical category name into a human-readable title.
 * Strips common prefixes and replaces underscores with spaces.
 * @param {string} name - Technical category name (e.g. "spaceship_movement")
 * @returns {string} Formatted title (e.g. "Movement")
 */
function formatCategoryName(name) {
  return name
    .replace(/^spaceship_/, '')
    .replace(/^vehicle_/, 'veh_')
    .replace(/^player_/, '')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());
}

// ==================== Changes Panel ====================

/**
 * Renders the detail panel showing changed files between profile and SC.
 * Clickable files (status: modified) open a diff dialog.
 */
function renderChangesPanel(files) {
  const statusOrder = { modified: 0, new: 1, deleted: 2, unchanged: 3 };
  const sorted = [...files].sort((a, b) => (statusOrder[a.status] ?? 4) - (statusOrder[b.status] ?? 4));

  return `
    <div class="profile-changes-panel">
      ${sorted.map(f => `
        <div class="profile-file-status${f.status === 'modified' ? ' file-clickable' : ''}"${f.status === 'modified' ? ` data-file="${escapeHtml(f.file)}"` : ''}>
          <span class="file-name">${escapeHtml(f.file)}</span>
          <span class="status-badge status-${f.status}">${f.status}</span>
        </div>
      `).join('')}
    </div>`;
}

// ==================== Profile/Backup Section ====================

/**
 * Formats the file list of a backup into a human-readable summary.
 * Counts profiles, mappings, and character presets separately.
 * @param {string[]} files - Array of file paths in the backup
 * @returns {string} Summary string (e.g. "2 profiles + 1 mapping")
 */
function formatBackupFiles(files) {
  let profiles = 0, mappings = 0, characters = 0;
  for (const f of files) {
    if (f.startsWith('controls_mappings/')) mappings++;
    else if (f.startsWith('custom_characters/')) characters++;
    else profiles++;
  }
  const parts = [];
  if (profiles > 0) parts.push(`${profiles} profile${profiles !== 1 ? 's' : ''}`);
  if (mappings > 0) parts.push(`${mappings} mapping${mappings !== 1 ? 's' : ''}`);
  if (characters > 0) parts.push(`${characters} character${characters !== 1 ? 's' : ''}`);
  return parts.join(' + ') || '0 files';
}

/**
 * Translates the technical backup type into a human-readable badge label.
 * Handles both current and legacy backup type names.
 * @param {string} backupType - Technical type (e.g. 'manual', 'pre-import', 'auto')
 * @returns {string} Display label (e.g. 'saved', 'pre-import', 'auto-save')
 */
function formatProfileTypeBadge(backupType) {
  const map = {
    'manual': t('environments:profile.type.saved'),
    'pre-import': t('environments:profile.type.preImport'),
    // Legacy types from older versions
    'auto': t('environments:profile.type.autoSave'),
    'auto-pre-restore': t('environments:profile.type.autoSave'),
    'auto-pre-import': t('environments:profile.type.preImport'),
    'auto-post-import': t('environments:profile.type.imported'),
  };
  return map[backupType] || backupType;
}

// ==================== USER.cfg UI ====================

/**
 * Counts the number of settings that differ from default values.
 * Resolution is counted as a single setting (width + height).
 * @returns {number} Number of changed settings
 */
function getChangedSettingsCount() {
  let count = 0;
  for (const [key, setting] of Object.entries(DEFAULT_SETTINGS)) {
    if (setting.type === 'resolution') {
      // Count resolution as changed if either dimension differs from default
      const w = userCfgSettings.r_width !== undefined ? userCfgSettings.r_width : 1920;
      const h = userCfgSettings.r_height !== undefined ? userCfgSettings.r_height : 1080;
      if (w !== 1920 || h !== 1080) count++;
      continue;
    }
    const currentValue = userCfgSettings[key] !== undefined ? userCfgSettings[key] : setting.value;
    if (currentValue !== setting.value) count++;
  }
  return count;
}

/**
 * Renders the complete USER.cfg settings UI.
 * Groups settings into categories (Essential, Quality, Shader, etc.).
 * Advanced categories are collapsed by default.
 */
/**
 * Renders the sync conflict bar if there are pending conflicts from in-game changes.
 */
function renderSyncBar() {
  if (pendingConflicts.length === 0) return '';
  const count = pendingConflicts.length;
  return `
    <div class="usercfg-sync-bar" id="usercfg-sync-bar">
      <span>${t('environments:cfg.syncConflicts', { count, defaultValue: `${count} setting(s) changed in-game` })}</span>
      <button id="btn-resolve-conflicts">${t('environments:cfg.syncResolve', { defaultValue: 'Resolve' })}</button>
    </div>
    <div class="usercfg-conflict-panel" id="usercfg-conflict-panel" style="display:none">
      ${pendingConflicts.map(c => {
        const setting = DEFAULT_SETTINGS[c.key];
        const labels = getSettingLabels(c.key) || setting?.labels;
        const ourDisplay = labels ? (labels[c.ourValue] || c.ourValue) : c.ourValue;
        const scDisplay = labels ? (labels[c.scValue] || c.scValue) : c.scValue;
        return `
          <div class="usercfg-conflict-row" data-key="${c.key}" data-attr="${c.attrName}">
            <span class="usercfg-conflict-label">${c.label}</span>
            <span class="usercfg-conflict-values">
              ${ourDisplay} <span class="usercfg-conflict-arrow">&rarr;</span> ${scDisplay}
            </span>
            <div class="usercfg-conflict-actions">
              <button class="conflict-keep" data-key="${c.key}">${t('environments:cfg.syncKeep', { defaultValue: 'Keep ours' })}</button>
              <button class="conflict-accept" data-key="${c.key}" data-value="${c.scValue}">${t('environments:cfg.syncAccept', { defaultValue: 'Accept SC' })}</button>
            </div>
          </div>`;
      }).join('')}
      <div class="usercfg-conflict-batch">
        <button id="btn-conflict-keep-all">${t('environments:cfg.syncKeepAll', { defaultValue: 'Keep all ours' })}</button>
        <button id="btn-conflict-accept-all">${t('environments:cfg.syncAcceptAll', { defaultValue: 'Accept all SC' })}</button>
      </div>
    </div>
  `;
}

function renderUserCfgUI() {
  const essentialCategory = { key: 'essential', label: t('environments:cfg.category.essential') };
  const advancedCategories = [
    { key: 'quality', label: t('environments:cfg.category.quality') },
    { key: 'shaders', label: t('environments:cfg.category.shaders') },
    { key: 'textures', label: t('environments:cfg.category.textures') },
    { key: 'effects', label: t('environments:cfg.category.effects') },
    { key: 'clarity', label: t('environments:cfg.category.clarity') },
    { key: 'lod', label: t('environments:cfg.category.lod') },
    { key: 'input', label: t('environments:cfg.category.input') },
    { key: 'advanced', label: t('environments:cfg.category.advanced'), hint: t('environments:cfg.category.advancedHint') },
  ];

  const changedCount = getChangedSettingsCount();

  return `
    <div class="sc-section usercfg-section">
      <div class="sc-section-header">
        <h3>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"></path>
            <circle cx="12" cy="12" r="3"></circle>
          </svg>
          ${t('environments:cfg.sectionTitle', { version: escapeHtml(activeScVersion) })}
        </h3>
        <div class="sc-section-actions">
          <span class="usercfg-unsaved" id="usercfg-unsaved" style="display:none">${t('environments:cfg.unsavedChanges')}</span>
          <button class="btn btn-sm btn-primary" id="btn-apply-usercfg">${t('environments:cfg.apply')}</button>
          <button class="btn btn-sm btn-secondary" id="btn-reset-usercfg">${t('environments:cfg.reset')}</button>
        </div>
      </div>
      <div class="usercfg-body">
        <div class="usercfg-header-info">
          <span class="usercfg-header-icon">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"></path>
              <polyline points="17 21 17 13 7 13 7 21"></polyline>
              <polyline points="7 3 7 8 15 8"></polyline>
            </svg>
          </span>
          <span>${t('environments:cfg.onlyChangedSaved')}</span>
          <span class="usercfg-header-count">${changedCount > 0 ? t('environments:cfg.countChanged', { count: changedCount }) : t('environments:cfg.allDefaults')}</span>
        </div>
        ${renderSyncBar()}
        <div class="usercfg-categories">
          ${renderCategorySettings(essentialCategory, false)}
          ${advancedCategories.map(cat => renderCategorySettings(cat, true)).join('')}
        </div>
      </div>
    </div>
  `;
}

/**
 * Renders a settings category with optional collapse/expand.
 * Shows a badge with the number of changed settings.
 */
function renderCategorySettings(category, collapsible) {
  const settings = Object.entries(DEFAULT_SETTINGS)
    .filter(([_, s]) => s.category === category.key)
    .map(([key, s]) => ({ key, ...s }));

  if (settings.length === 0) return '';

  const isCollapsed = collapsible && collapsedCategories.has(category.key);
  const changedInCategory = settings.filter(s => {
    if (s.type === 'resolution') {
      const w = userCfgSettings.r_width !== undefined ? userCfgSettings.r_width : 1920;
      const h = userCfgSettings.r_height !== undefined ? userCfgSettings.r_height : 1080;
      return w !== 1920 || h !== 1080;
    }
    const val = userCfgSettings[s.key] !== undefined ? userCfgSettings[s.key] : s.value;
    return val !== s.value;
  }).length;

  return `
    <div class="usercfg-category">
      <div class="usercfg-category-header ${collapsible ? 'collapsible' : ''}"
           ${collapsible ? `data-category-key="${escapeHtml(category.key)}"` : ''}>
        <span class="usercfg-category-label">${category.label}</span>
        ${changedInCategory > 0 ? `<span class="usercfg-category-badge">${t('environments:cfg.countChanged', { count: changedInCategory })}</span>` : ''}
        ${collapsible ? `
          <svg class="usercfg-category-toggle ${isCollapsed ? 'collapsed' : ''}" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="6 9 12 15 18 9"></polyline>
          </svg>
        ` : ''}
      </div>
      <div class="usercfg-settings ${isCollapsed ? 'collapsed' : ''}">
        ${category.hint ? `<div class="usercfg-category-hint">${escapeHtml(category.hint)}</div>` : ''}
        ${settings.map(s => renderSettingControl(s.key, s)).join('')}
      </div>
    </div>
  `;
}

/**
 * Renders an info icon button that shows help text as a popover on click.
 * Returns an empty string if the setting has no help text.
 * @param {Object} setting - Setting definition with optional help and desc fields
 * @returns {string} HTML string of the help button or empty string
 */
function renderHelpIcon(setting) {
  if (!setting.help) return '';
  return `<button class="usercfg-help-btn" data-help="${escapeHtml(setting.help)}" title="${escapeHtml(setting.desc)}">
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
  </button>`;
}

/**
 * Renders a single setting control (slider, toggle, number, resolution).
 * Shows the default value when the current value differs.
 * @param {string} key - CVar key
 * @param {Object} setting - Setting definition from DEFAULT_SETTINGS
 */
function renderTargetBadge(setting) {
  if (setting.target === 'attributes') {
    return `<span class="usercfg-target-badge attributes" title="${t('environments:cfg.badgeAttributesTooltip', { defaultValue: 'Synced with Star Citizen game settings' })}">SC</span>`;
  }
  return `<span class="usercfg-target-badge usercfg" title="${t('environments:cfg.badgeCfgTooltip', { defaultValue: 'Engine setting (USER.cfg)' })}">CFG</span>`;
}

function renderOverrideWarning(key, setting) {
  if (!setting.overrideWarning) return '';
  const value = userCfgSettings[key] !== undefined ? userCfgSettings[key] : setting.value;
  if (value === setting.value) return '';
  return `<div class="usercfg-override-warning">${t('environments:cfg.overrideWarning', { defaultValue: 'Overrides the in-game Quality preset on each launch' })}</div>`;
}

function renderSettingControl(key, setting) {
  const value = userCfgSettings[key] !== undefined ? userCfgSettings[key] : setting.value;
  const isChanged = value !== setting.value;
  const changedClass = isChanged ? 'usercfg-changed' : '';
  const helpIcon = renderHelpIcon(setting);
  const badge = renderTargetBadge(setting);
  const overrideWarning = renderOverrideWarning(key, setting);

  const resetBtn = isChanged
    ? `<button class="usercfg-reset" data-key="${key}" title="${t('environments:cfg.resetToDefault')}">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="1 4 1 10 7 10"></polyline><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"></path></svg>
      </button>`
    : '';

  if (setting.type === 'resolution') {
    const w = userCfgSettings.r_width !== undefined ? userCfgSettings.r_width : 1920;
    const h = userCfgSettings.r_height !== undefined ? userCfgSettings.r_height : 1080;
    const resIsChanged = w !== 1920 || h !== 1080;
    const resChangedClass = resIsChanged ? 'usercfg-changed' : '';
    const resResetBtn = resIsChanged
      ? `<button class="usercfg-reset" data-key="_resolution" title="${t('environments:cfg.resetToDefault')}">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="1 4 1 10 7 10"></polyline><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"></path></svg>
        </button>`
      : '';
    const currentRes = `${w}x${h}`;
    const presetMatch = RESOLUTION_PRESETS.find(p => p.w === w && p.h === h);
    const presetOptions = RESOLUTION_PRESETS.map(p => {
      const val = `${p.w}x${p.h}`;
      return `<option value="${val}" ${val === currentRes ? 'selected' : ''}>${p.w} × ${p.h}  (${p.label})</option>`;
    }).join('');
    return `
      <div class="usercfg-row ${resChangedClass}">
        <span class="usercfg-label">${helpIcon}${badge}Resolution${resIsChanged ? ` <span class="usercfg-default">(${t('environments:cfg.defaultPrefix', { value: '1920 × 1080' })})</span>` : ''}</span>
        <div class="usercfg-control-wrap">
          <div class="usercfg-resolution-wrap">
            <input type="number" class="usercfg-res-input" data-key="r_width" value="${w}" min="640" max="7680" aria-label="Width" />
            <span class="usercfg-res-sep">×</span>
            <input type="number" class="usercfg-res-input" data-key="r_height" value="${h}" min="480" max="4320" aria-label="Height" />
            <select class="usercfg-res-preset" data-key="_resolution" aria-label="Resolution preset">
              <option value="" ${!presetMatch ? 'selected' : ''}>${t('environments:cfg.custom')}</option>
              ${presetOptions}
            </select>
          </div>
          ${resResetBtn}
        </div>
      </div>
    `;
  }

  if (setting.type === 'toggle') {
    const defaultLabel = setting.value ? t('environments:cfg.on') : t('environments:cfg.off');
    return `
      <div class="usercfg-row ${changedClass}">
        <span class="usercfg-label">${helpIcon}${badge}${setting.label}${isChanged ? ` <span class="usercfg-default">(${t('environments:cfg.defaultPrefix', { value: defaultLabel })})</span>` : ''}</span>
        <div class="usercfg-control-wrap">
          <label class="toggle-switch">
            <input type="checkbox" class="usercfg-input" data-key="${key}" ${value ? 'checked' : ''} />
            <span class="toggle-slider"></span>
          </label>
          ${resetBtn}
        </div>
      </div>
    `;
  }

  if (setting.type === 'number') {
    return `
      <div class="usercfg-row ${changedClass}">
        <span class="usercfg-label">${helpIcon}${badge}${setting.label}${isChanged ? ` <span class="usercfg-default">(${t('environments:cfg.defaultPrefix', { value: setting.value })})</span>` : ''}</span>
        <div class="usercfg-control-wrap">
          <input type="number" class="usercfg-number-input" data-key="${key}"
                 min="${setting.min}" max="${setting.max}" step="${setting.step}" value="${value}"
                 aria-label="${escapeHtml(setting.label)}" />
          ${resetBtn}
        </div>
      </div>
    `;
  }

  let displayValue = value;
  const dlb = getSettingLabels(key) || setting.labels;
  if (dlb) displayValue = dlb[value] || value;
  else if (QUALITY_KEYS.has(key)) displayValue = getQualityLevels()[value] || value;
  else if (SHADER_KEYS.has(key)) displayValue = getShaderLevels()[value] || value;

  let defaultDisplay = setting.value;
  const deflb = getSettingLabels(key) || setting.labels;
  if (deflb) defaultDisplay = deflb[setting.value] || setting.value;
  else if (QUALITY_KEYS.has(key)) defaultDisplay = getQualityLevels()[setting.value] || setting.value;
  else if (SHADER_KEYS.has(key)) defaultDisplay = getShaderLevels()[setting.value] || setting.value;

  return `
    <div class="usercfg-row ${changedClass}">
      <span class="usercfg-label">${helpIcon}${badge}${setting.label}${isChanged ? ` <span class="usercfg-default">(${t('environments:cfg.defaultPrefix', { value: defaultDisplay })})</span>` : ''}</span>
      <div class="usercfg-control-wrap">
        <div class="usercfg-slider-wrap">
          <input type="range" class="usercfg-slider" data-key="${key}"
                 min="${setting.min}" max="${setting.max}" step="${setting.step}" value="${value}"
                 aria-label="${escapeHtml(setting.label)}" />
          <span class="usercfg-value">${displayValue}</span>
        </div>
        ${resetBtn}
      </div>
      ${overrideWarning}
    </div>
  `;
}

// ==================== Actions ====================

/** @type {boolean} Prevents double-saving of USER.cfg */
let isSavingUserCfg = false;

/**
 * Saves the USER.cfg settings to disk.
 * Checks for external changes beforehand (read-before-write) and
 * warns the user if the file was modified externally.
 */
async function applyUserCfg() {
  if (!config?.install_path || !activeScVersion) return;
  if (isSavingUserCfg) return;

  // Write guard - disable button during save
  isSavingUserCfg = true;
  const applyBtn = document.getElementById('btn-apply-usercfg');
  if (applyBtn) applyBtn.disabled = true;

  try {
    // Read-before-write: detect external changes via raw content comparison
    const diskContent = await invoke('read_user_cfg', { gp: config.install_path, v: activeScVersion });
    if (diskContent !== savedUserCfgRaw) {
      const proceed = await confirm(
        t('environments:cfg.externalChangeDetected'),
        { title: t('environments:cfg.externalChangeTitle'), kind: 'warning' }
      );
      if (!proceed) return;
    }

    // Collect current UI values
    document.querySelectorAll('.usercfg-slider').forEach(slider => {
      const val = parseFloat(slider.value);
      if (!isNaN(val)) userCfgSettings[slider.dataset.key] = val;
    });
    document.querySelectorAll('.usercfg-number-input').forEach(input => {
      const val = parseFloat(input.value);
      if (!isNaN(val)) userCfgSettings[input.dataset.key] = val;
    });
    document.querySelectorAll('.usercfg-input[type="checkbox"]').forEach(checkbox => {
      userCfgSettings[checkbox.dataset.key] = checkbox.checked ? 1 : 0;
    });
    document.querySelectorAll('.usercfg-res-input').forEach(input => {
      const val = parseInt(input.value, 10);
      if (!isNaN(val)) userCfgSettings[input.dataset.key] = val;
    });

    // Build attributes changes map for attributes-target settings
    const attrChanges = {};
    for (const [key, setting] of Object.entries(DEFAULT_SETTINGS)) {
      if (setting.target !== 'attributes' || !setting.attrName) continue;
      if (setting.virtual) {
        if (key === '_resolution') {
          const w = userCfgSettings.r_width !== undefined ? userCfgSettings.r_width : 1920;
          const h = userCfgSettings.r_height !== undefined ? userCfgSettings.r_height : 1080;
          attrChanges[setting.attrName] = convertToAttrValue(key, w);
          attrChanges[setting.attrNameHeight] = convertToAttrValue(key, h);
        } else if (key === '_windowMode') {
          const mode = userCfgSettings._windowMode !== undefined ? userCfgSettings._windowMode : setting.value;
          attrChanges[setting.attrName] = convertToAttrValue(key, mode);
        }
      } else {
        const val = userCfgSettings[key] !== undefined ? userCfgSettings[key] : setting.value;
        attrChanges[setting.attrName] = convertToAttrValue(key, val);
      }
    }

    // Generate USER.cfg (only usercfg-target settings) and write both in parallel
    const content = generateUserCfg();
    await Promise.all([
      invoke('write_user_cfg', { gp: config.install_path, v: activeScVersion, c: content }),
      Object.keys(attrChanges).length > 0
        ? invoke('write_attributes_partial', { gp: config.install_path, v: activeScVersion, changes: attrChanges })
        : Promise.resolve(),
    ]);

    // Update snapshots
    savedUserCfgSnapshot = { ...userCfgSettings };
    savedUserCfgRaw = content;
    savedAttributesHash = await invoke('get_attributes_hash', { gp: config.install_path, v: activeScVersion });
    const freshAttrs = await invoke('read_attributes_map', { gp: config.install_path, v: activeScVersion });
    savedAttributesValues = freshAttrs;
    pendingConflicts = [];
    showNotification(t('environments:notification.userCfgSaved'), 'success');
    updateChangedCounts();
  } catch (e) {
    showNotification(t('environments:notification.userCfgWriteFailed'), 'error');
  } finally {
    isSavingUserCfg = false;
    if (applyBtn) applyBtn.disabled = false;
  }
}

/**
 * Resets all USER.cfg settings to default values and clears the file.
 * Shows a confirmation dialog before proceeding.
 */
async function resetUserCfg() {
  if (!config?.install_path || !activeScVersion) return;
  const confirmed = await confirm(t('environments:cfg.resetConfirm'), { title: t('environments:cfg.resetTitle'), kind: 'warning' });
  if (!confirmed) return;
  userCfgSettings = {};
  try {
    // Reset both USER.cfg and attributes-target settings to defaults
    const attrDefaults = {};
    for (const [key, setting] of Object.entries(DEFAULT_SETTINGS)) {
      if (setting.target !== 'attributes' || !setting.attrName) continue;
      if (setting.virtual) {
        if (key === '_resolution') {
          attrDefaults[setting.attrName] = '1920';
          attrDefaults[setting.attrNameHeight] = '1080';
        } else if (key === '_windowMode') {
          attrDefaults[setting.attrName] = String(setting.value);
        }
      } else {
        attrDefaults[setting.attrName] = String(setting.value);
      }
    }
    await Promise.all([
      invoke('write_user_cfg', { gp: config.install_path, v: activeScVersion, c: '' }),
      Object.keys(attrDefaults).length > 0
        ? invoke('write_attributes_partial', { gp: config.install_path, v: activeScVersion, changes: attrDefaults })
        : Promise.resolve(),
    ]);
    pendingConflicts = [];
    showNotification(t('environments:notification.userCfgReset'), 'success');
    renderEnvironments(document.getElementById('content'));
  } catch (e) {
    showNotification(t('environments:notification.userCfgResetFailed'), 'error');
  }
}

/**
 * Generates the USER.cfg content from the current settings.
 * Only settings that differ from defaults are written.
 * Virtual settings (_windowMode, _resolution) are resolved into real CVars.
 * Unmanaged keys (e.g. g_language) are preserved under "Other".
 * @returns {string} Generated USER.cfg file content
 */
function generateUserCfg() {
  const lines = [
    '; Star Citizen USER.cfg Configuration',
    '; Generated by Penguin Citizen',
    '; Only non-default values are stored',
    '',
  ];

  const categoryOrder = ['essential', 'quality', 'shaders', 'textures', 'effects', 'clarity', 'lod', 'input', 'advanced'];

  // Virtual settings with target 'usercfg' are resolved into real CVars here.
  // Virtual settings with target 'attributes' are handled in applyUserCfg() via write_attributes_partial.
  const windowModeSetting = DEFAULT_SETTINGS._windowMode;
  let windowModeCVars = null;
  if (windowModeSetting.target === 'usercfg') {
    const windowMode = userCfgSettings._windowMode !== undefined ? userCfgSettings._windowMode : windowModeSetting.value;
    if (windowMode !== windowModeSetting.value) {
      if (windowMode === 0) {
        windowModeCVars = { r_Fullscreen: 0, r_FullscreenWindow: 0 };
      } else if (windowMode === 1) {
        windowModeCVars = { r_Fullscreen: 1, r_FullscreenWindow: 0 };
      } else {
        windowModeCVars = { r_Fullscreen: 0, r_FullscreenWindow: 1 };
      }
    }
  }

  const resSetting = DEFAULT_SETTINGS._resolution;
  let resChanged = false;
  let resW = 1920, resH = 1080;
  if (resSetting.target === 'usercfg') {
    resW = userCfgSettings.r_width !== undefined ? userCfgSettings.r_width : 1920;
    resH = userCfgSettings.r_height !== undefined ? userCfgSettings.r_height : 1080;
    resChanged = resW !== 1920 || resH !== 1080;
  }

  for (const cat of categoryOrder) {
    const catSettings = Object.entries(DEFAULT_SETTINGS).filter(([_, s]) => s.category === cat);
    const changedSettings = [];

    for (const [key, setting] of catSettings) {
      // Skip virtual settings - they are expanded separately
      if (setting.virtual) continue;
      // Skip attributes-target settings - they are written to attributes.xml
      if (setting.target === 'attributes') continue;
      const currentValue = userCfgSettings[key] !== undefined ? userCfgSettings[key] : setting.value;
      if (currentValue !== setting.value || setting.alwaysWrite) {
        const defaultStr = setting.type === 'toggle' ? (setting.value ? '1' : '0') : String(setting.value);
        changedSettings.push({ key, setting, value: currentValue, defaultValue: defaultStr });
      }
    }

    if (changedSettings.length > 0 || (cat === 'essential' && (windowModeCVars || resChanged))) {
      lines.push(`;--- ${cat.charAt(0).toUpperCase() + cat.slice(1)} ---`);

      // Emit resolution CVars in essential category (only if target is usercfg)
      if (cat === 'essential' && resChanged) {
        if (resW !== 1920) lines.push(`r_width = ${resW}  ; default: 1920`);
        if (resH !== 1080) lines.push(`r_height = ${resH}  ; default: 1080`);
      }

      // Emit window mode CVars in essential category (only if target is usercfg)
      if (cat === 'essential' && windowModeCVars) {
        lines.push(`r_Fullscreen = ${windowModeCVars.r_Fullscreen}  ; default: 0`);
        lines.push(`r_FullscreenWindow = ${windowModeCVars.r_FullscreenWindow}  ; default: 1`);
      }

      for (const { key, setting, value, defaultValue } of changedSettings) {
        if (setting.type === 'toggle') {
          lines.push(`${key} = ${value ? 1 : 0}  ; default: ${defaultValue}`);
        } else {
          lines.push(`${key} = ${value}  ; default: ${defaultValue}`);
        }
      }
      lines.push('');
    }
  }

  // Preserve unmanaged keys (e.g. g_language, custom CVars)
  const managedKeys = new Set(Object.keys(DEFAULT_SETTINGS));
  // Also exclude raw CVars managed by virtual settings
  managedKeys.add('r_Fullscreen');
  managedKeys.add('r_FullscreenWindow');
  managedKeys.add('r_width');
  managedKeys.add('r_height');
  const extraKeys = Object.keys(userCfgSettings).filter(k => !managedKeys.has(k));
  if (extraKeys.length > 0) {
    lines.push(';--- Other ---');
    for (const key of extraKeys) {
      const value = userCfgSettings[key];
      if (value !== undefined && value !== '') {
        lines.push(`${key} = ${value}`);
      }
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Creates a new profile from the current SC files.
 * Shows an inline input field for the profile name.
 */
async function saveProfile() {
  if (!config?.install_path || !activeScVersion) return;

  // Show inline label input
  const btn = document.getElementById('btn-save-current') || document.getElementById('btn-save-first-profile');
  if (!btn) return;
  const header = btn.closest('.sc-section-header') || btn.parentElement;
  if (!header) return;

  // Check if input already shown
  if (header.querySelector('.backup-label-input-wrap')) return;

  const wrap = document.createElement('div');
  wrap.className = 'backup-label-input-wrap';
  wrap.innerHTML = `
    <input type="text" class="input backup-label-input" placeholder="${t('environments:profile.nameOptional')}" maxlength="60" aria-label="${t('environments:profile.profileName')}" />
    <button class="btn btn-sm btn-primary" id="btn-backup-confirm">${t('environments:profile.save')}</button>
    <button class="btn btn-sm" id="btn-backup-cancel">${t('environments:profile.cancel')}</button>
  `;
  header.after(wrap);
  const input = wrap.querySelector('.backup-label-input');
  input.focus();

  async function doCreate() {
    const label = input.value.trim();
    wrap.remove();
    try {
      const created = await invoke('backup_profile', {
        gp: config.install_path,
        v: activeScVersion,
        bt: 'manual',
        l: label || '',
      });
      lastRestoredBackupId = created.id;
      lastRestoredPerVersion[activeScVersion] = created.id;
      invoke('save_active_profile', { v: activeScVersion, bid: created.id }).catch(err => logError(err, 'environments:save_active_profile'));
      showNotification(t('environments:notification.profileSaved'), 'success');
      await loadBackups();
      await loadProfileStatus();
      renderEnvironments(document.getElementById('content'));
    } catch (e) {
      showNotification(t('environments:notification.saveFailed', { error: e }), 'error');
    }
  }

  wrap.querySelector('#btn-backup-confirm').addEventListener('click', doCreate);
  wrap.querySelector('#btn-backup-cancel').addEventListener('click', () => wrap.remove());
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doCreate();
    if (e.key === 'Escape') wrap.remove();
  });
}

/**
 * Loads a saved profile into Star Citizen (replaces current SC files).
 * Shows a confirmation dialog with file list.
 */
async function loadProfile(backupId) {
  if (!config?.install_path || !activeScVersion) return;
  const backup = backups.find(b => b.id === backupId);
  const displayName = backup?.label || backupId;
  const filesInfo = backup ? formatBackupFiles(backup.files) : '';
  const confirmLoad = await confirm(
    t('environments:notification.loadConfirm', { name: displayName, version: activeScVersion, files: filesInfo }),
    { title: t('environments:notification.loadTitle'), kind: 'warning' }
  );
  if (!confirmLoad) return;
  try {
    await invoke('restore_profile', {
      gp: config.install_path,
      v: activeScVersion,
      bid: backupId,
    });
    lastRestoredBackupId = backupId;
    lastRestoredPerVersion[activeScVersion] = backupId;
    invoke('save_active_profile', { v: activeScVersion, bid: backupId }).catch(err => logError(err, 'environments:save_active_profile'));
    showNotification(t('environments:notification.profileLoaded'), 'success');
    await Promise.all([loadActionDefinitions(), loadDevicesAndBindings(), loadCompleteBindingList(), loadBackups(), loadUserCfgSettings()]);
    await loadProfileStatus();
    renderEnvironments(document.getElementById('content'));
  } catch (e) {
    showNotification(t('environments:notification.loadFailed', { error: e }), 'error');
  }
}

/**
 * Deletes a saved profile after confirmation.
 * If the deleted profile was active, clears the active profile state.
 * @param {string} backupId - Unique identifier of the profile to delete
 */
async function deleteProfile(backupId) {
  const backup = backups.find(b => b.id === backupId);
  const displayName = backup?.label || t('environments:profile.unnamedProfile');
  const confirmDelete = await confirm(t('environments:notification.deleteProfileConfirm', { name: displayName }), { title: t('environments:notification.deleteProfileTitle'), kind: 'warning' });
  if (!confirmDelete) return;
  try {
    await invoke('delete_backup', { v: activeScVersion, bid: backupId });
    if (lastRestoredBackupId === backupId) {
      lastRestoredBackupId = null;
      delete lastRestoredPerVersion[activeScVersion];
      activeProfileStatus = null;
      invoke('save_active_profile', { v: activeScVersion, bid: '' }).catch(err => logError(err, 'environments:save_active_profile'));
    }
    showNotification(t('environments:notification.profileDeleted'), 'success');
    await loadBackups();
    await loadProfileStatus();
    renderEnvironments(document.getElementById('content'));
  } catch (e) {
    showNotification(t('environments:notification.deleteFailed', { error: e }), 'error');
  }
}

/**
 * Deletes a complete SC environment (folder + all data) after double confirmation.
 * Resets the active version if the deleted version was active.
 */
async function deleteScVersion(version) {
  if (!version) return;

  const confirmed = await confirm(t('environments:storage.deleteConfirm', { version }), {
    title: t('environments:storage.deleteTitle'),
    kind: 'warning',
  });

  if (!confirmed) return;
  if (!config?.install_path) {
    showNotification(t('environments:notification.noInstallPath'), 'error');
    return;
  }

  try {
    showNotification(t('environments:notification.deletingEnv', { version }), 'info');
    await invoke('delete_sc_version', { gp: config.install_path, version });

    // Clear active version if we just deleted it
    if (activeScVersion === version) {
      activeScVersion = null;
      lastRestoredBackupId = null;
      activeProfileTab = 'profile';
    }

    showNotification(t('environments:notification.envDeleted', { version }), 'success');
    
    // Reload environments
    renderEnvironments(document.getElementById('content'));
  } catch (err) {
    showNotification(t('environments:notification.envDeleteFailed', { error: err }), 'error');
  }
}

/**
 * Handles a device swap after drag-and-drop.
 *
 * Only allows swaps within the same device type (joystick↔joystick, etc.)
 * because SC bindings use type-specific prefixes (js1_, kb1_, gp1_).
 *
 * Operates on the active backup's actionmaps.xml (not live SC files).
 * After success, reloads backups so the UI reflects the new device order.
 */
async function handleDeviceDrop(sourceInstance, targetInstance, sourceDeviceType, targetDeviceType) {
  if (sourceInstance === targetInstance && sourceDeviceType === targetDeviceType) return;
  if (!activeScVersion || !lastRestoredBackupId) return;

  // Only allow swaps within the same device type
  if (sourceDeviceType !== targetDeviceType) {
    showNotification(t('environments:notification.cannotSwapDeviceTypes', { typeA: sourceDeviceType, typeB: targetDeviceType }), 'warning');
    return;
  }

  // Both entries use the same device type since we only swap within a type
  const newOrder = [
    { oldInstance: sourceInstance, newInstance: targetInstance, deviceType: sourceDeviceType },
    { oldInstance: targetInstance, newInstance: sourceInstance, deviceType: sourceDeviceType },
  ];

  try {
    await invoke('reorder_profile_devices', {
      v: activeScVersion,
      bid: lastRestoredBackupId,
      newOrder,
    });
    showNotification(t('environments:notification.swapped', { type: sourceDeviceType, a: sourceInstance, b: targetInstance }), 'success');
    // Reload backups and profile status so the UI shows "out of sync"
    await loadBackups();
    await loadProfileStatus();
    renderEnvironments(document.getElementById('content'));
  } catch (e) {
    showNotification(t('environments:notification.reorderFailed', { error: e }), 'error');
  }
}

// ==================== Import from Another Version ====================

/**
 * Shows the dialog for importing profiles/settings from another SC version.
 * Allows selecting the source version and a specific saved profile.
 */
async function showImportVersionDialog() {
  if (!config?.install_path || !activeScVersion) return;

  // Check if dialog already open
  if (document.getElementById('import-version-dialog')) return;

  try {
    const versions = await invoke('list_importable_versions', {
      gp: config.install_path,
      targetVersion: activeScVersion,
    });

    if (versions.length === 0) {
      showNotification(t('environments:notification.noImportableVersions'), 'info');
      return;
    }

    // Build dialog HTML
    const dialog = document.createElement('div');
    dialog.id = 'import-version-dialog';
    dialog.className = 'import-version-dialog';
    dialog.innerHTML = `
      <div class="import-version-dialog-header">
        <h4>${t('environments:import.dialogTitle')}</h4>
      </div>
      <div class="import-version-dialog-body">
        <label class="import-version-label">${t('environments:import.sourceVersion')}</label>
        <select class="input import-version-select" id="import-source-select">
          ${versions.map(v => `<option value="${escapeHtml(v.version)}" data-info="${escapeHtml(JSON.stringify(v))}">${escapeHtml(v.version)}</option>`).join('')}
        </select>
        <label class="import-version-label" style="margin-top: 8px;">${t('environments:import.source')}</label>
        <select class="input import-version-select" id="import-profile-select">
          <option value="__current__">${t('environments:import.currentScFiles')}</option>
        </select>
        <div class="import-version-summary" id="import-version-summary"></div>
      </div>
      <div class="import-version-dialog-footer">
        <button class="btn btn-sm" id="btn-import-cancel">${t('environments:profile.cancel')}</button>
        <button class="btn btn-sm btn-primary" id="btn-import-confirm">${t('environments:import.confirm')}</button>
      </div>
    `;

    // Insert dialog after section header
    const section = document.querySelector('.sc-section');
    if (section) {
      section.parentElement.insertBefore(dialog, section);
    } else {
      document.querySelector('.profile-tab-content')?.prepend(dialog);
    }

    // Load saved profiles for the selected source version
    async function loadSourceProfiles(sourceVersion) {
      const profileSelect = document.getElementById('import-profile-select');
      if (!profileSelect) return;
      profileSelect.innerHTML = `<option value="__current__">${t('environments:import.currentScFiles')}</option>`;
      try {
        const backups = await invoke('list_backups', { v: sourceVersion });
        for (const b of backups) {
          const label = b.label || b.id;
          const date = b.created_at ? ` (${b.created_at})` : '';
          const opt = document.createElement('option');
          opt.value = b.id;
          opt.textContent = t('environments:import.savedPrefix', { label, date });
          profileSelect.appendChild(opt);
        }
      } catch (e) {
        debugLog('profiles', 'warn', `Failed to load backups for ${sourceVersion}: ${e}`);
      }
    }

    // Update summary for selected version
    function updateSummary() {
      const sel = document.getElementById('import-source-select');
      const opt = sel?.selectedOptions[0];
      const summaryEl = document.getElementById('import-version-summary');
      if (!opt || !summaryEl) return;
      const profileSel = document.getElementById('import-profile-select');
      const selectedProfile = profileSel?.value;
      if (selectedProfile && selectedProfile !== '__current__') {
        summaryEl.textContent = t('environments:import.willCreateProfile', { version: activeScVersion });
        return;
      }
      try {
        const info = JSON.parse(opt.dataset.info);
        const parts = [];
        if (info.profile_file_count > 0) parts.push(t('environments:import.profileFiles', { count: info.profile_file_count }));
        if (info.controls_file_count > 0) parts.push(t('environments:import.controlMappings', { count: info.controls_file_count }));
        if (info.character_file_count > 0) parts.push(t('environments:import.characterPresets', { count: info.character_file_count }));
        summaryEl.textContent = parts.length > 0
          ? t('environments:import.willSaveAs', { parts: parts.join(', ') })
          : t('environments:import.noFilesFound');
      } catch { summaryEl.textContent = ''; }
    }

    // Initial load
    await loadSourceProfiles(versions[0].version);
    updateSummary();

    document.getElementById('import-source-select')?.addEventListener('change', async (e) => {
      await loadSourceProfiles(e.target.value);
      updateSummary();
    });

    document.getElementById('import-profile-select')?.addEventListener('change', updateSummary);

    document.getElementById('btn-import-cancel')?.addEventListener('click', () => dialog.remove());

    document.getElementById('btn-import-confirm')?.addEventListener('click', async () => {
      const sourceVersion = document.getElementById('import-source-select')?.value;
      if (!sourceVersion) return;
      const selectedProfile = document.getElementById('import-profile-select')?.value;
      const isProfile = selectedProfile && selectedProfile !== '__current__';

      dialog.remove();
      try {
        const result = await invoke('import_version_as_profile', {
          gp: config.install_path,
          sourceVersion,
          targetVersion: activeScVersion,
          bid: isProfile ? selectedProfile : null,
          label: null,
        });
        showNotification(t('environments:notification.importCreated', { label: escapeHtml(result.label), version: sourceVersion }), 'success');

        // Reload backups to show the new profile
        await loadBackups();
        renderEnvironments(document.getElementById('content'));
      } catch (e) {
        showNotification(t('environments:notification.importFailed', { error: e }), 'error');
      }
    });

  } catch (e) {
    showNotification(t('environments:notification.importVersionsFailed', { error: e }), 'error');
  }
}

// ==================== Data.p4k Copy Dropdown ====================

/**
 * Shows a dropdown for selecting the source version for copying Data.p4k.
 * Displayed when clicking the copy button of a version without Data.p4k.
 */
async function showDataP4kCopyDropdown(targetVersion, event) {
  event.stopPropagation();

  // Remove any existing dropdown
  document.querySelector('.data-p4k-dropdown')?.remove();

  // Find versions with Data.p4k
  const sourceVersions = scVersions.filter(v => v.has_data_p4k && v.version !== targetVersion);

  if (sourceVersions.length === 0) {
    showNotification(t('environments:notification.noDataP4kSource'), 'info');
    return;
  }

  // Build dropdown
  const dropdown = document.createElement('div');
  dropdown.className = 'data-p4k-dropdown';
  dropdown.innerHTML = `
    <div class="data-p4k-dropdown-header">${t('environments:dataP4k.dropdownHeader')}</div>
    ${sourceVersions.map(v => `
      <button class="data-p4k-dropdown-item" data-source="${escapeHtml(v.version)}">
        ${escapeHtml(v.version)}
      </button>
    `).join('')}
  `;

  // Position dropdown
  const btn = event.target.closest('.version-copy-btn') || event.target;
  const rect = btn.getBoundingClientRect();
  dropdown.style.position = 'fixed';
  dropdown.style.left = `${rect.right + 5}px`;
  dropdown.style.top = `${rect.top}px`;

  document.body.appendChild(dropdown);

  // Handle clicks
  dropdown.querySelectorAll('.data-p4k-dropdown-item').forEach(item => {
    item.addEventListener('click', async () => {
      const sourceVersion = item.dataset.source;
      dropdown.remove();

      // Show progress modal instead of starting copy immediately
      await showDataP4kCopyProgressModal(sourceVersion, targetVersion);
    });
  });

  // Close on outside click
  setTimeout(() => {
    document.addEventListener('click', function closeDropdown() {
      dropdown.remove();
      document.removeEventListener('click', closeDropdown);
    });
  }, 0);
}

// ==================== Data.p4k Copy Progress ====================

/**
 * Shows a modal window with progress bar, speed, and ETA
 * for the Data.p4k file copy operation (~100+ GB).
 * Supports cancellation during copying.
 */
async function showDataP4kCopyProgressModal(sourceVersion, targetVersion) {
  // Remove existing modal
  document.querySelector('#data-p4k-copy-modal')?.remove();

  // Get file size
  let sizeBytes = 0;
  try {
    sizeBytes = await invoke('get_data_p4k_size', {
      gp: config.install_path,
      version: sourceVersion
    });
  } catch (e) {
    showNotification(`Error: ${e}`, 'error');
    return;
  }

  const modal = document.createElement('div');
  modal.id = 'data-p4k-copy-modal';
  modal.className = 'modal-overlay show';
  modal.innerHTML = `
    <div class="modal-content data-p4k-copy-modal">
      <div class="modal-header">
        <h3>${t('environments:dataP4k.copyTitle')}</h3>
        <button class="modal-close" id="btn-modal-close">×</button>
      </div>
      <div class="modal-body">
        <div class="copy-progress-info">
          <p>${t('environments:dataP4k.fromTo', { source: escapeHtml(sourceVersion), target: escapeHtml(targetVersion) })}</p>
          <p>${t('environments:dataP4k.size', { size: formatFileSize(sizeBytes) })}</p>
        </div>
        <div class="progress-bar-container" style="display: none;">
          <div class="progress-bar" id="copy-progress-bar">
            <span class="progress-bar-text" id="copy-progress-percent">0%</span>
          </div>
        </div>
        <div class="progress-stats" style="display: none;">
          <div class="speed">
            <div class="label">${t('environments:dataP4k.speed')}</div>
            <div class="value" id="copy-speed">-</div>
          </div>
          <div class="eta">
            <div class="label">${t('environments:dataP4k.remaining')}</div>
            <div class="value" id="copy-eta">-</div>
          </div>
        </div>
        <p class="progress-text" id="copy-progress-text" style="display: none;">
          ${t('environments:dataP4k.copied', { copied: `<span id="copied-bytes">0</span>`, total: `<span id="total-bytes">${formatFileSize(sizeBytes)}</span>` })}
        </p>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" id="btn-copy-cancel">${t('environments:dataP4k.cancelBtn')}</button>
        <button class="btn btn-primary" id="btn-copy-start">${t('environments:dataP4k.startBtn')}</button>
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  const progressBar = modal.querySelector('#copy-progress-bar');
  const progressPercent = modal.querySelector('#copy-progress-percent');
  const progressText = modal.querySelector('.progress-text');
  const progressStats = modal.querySelector('.progress-stats');
  const progressContainer = modal.querySelector('.progress-bar-container');
  const speedEl = modal.querySelector('#copy-speed');
  const etaEl = modal.querySelector('#copy-eta');
  const copiedBytesEl = modal.querySelector('#copied-bytes');
  const totalBytesEl = modal.querySelector('#total-bytes');

  // State
  let unlisten = null;

  // Helper to calculate ETA
  function calculateEta(speedBps, currentCopied) {
    if (speedBps < 1024 * 1024) return '-'; // Less than 1 MB/s
    const remaining = sizeBytes - currentCopied;
    const seconds = remaining / speedBps;
    if (seconds < 60) return t('environments:dataP4k.lessThan1Min');
    const mins = Math.ceil(seconds / 60);
    if (mins < 60) return t('environments:dataP4k.minutesEta', { mins });
    const hours = Math.floor(mins / 60);
    const remainingMins = mins % 60;
    return t('environments:dataP4k.hoursEta', { hours, mins: remainingMins });
  }

  let currentCopied = 0;

  // Close handlers
  const closeModal = async () => {
    if (unlisten) {
      unlisten();
      unlisten = null;
    }
    // If copying, send cancel
    try {
      await invoke('abort_copy_data_p4k', {
        gp: config.install_path,
        version: targetVersion
      });
    } catch (e) { /* ignore */ }
    modal.remove();
    copyingVersion = null;
    // Reload to reset state
    scVersions = await invoke('detect_sc_versions', { gp: config.install_path });
    renderEnvironments(document.getElementById('content'));
  };

  modal.querySelector('#btn-modal-close').addEventListener('click', closeModal);
  modal.querySelector('#btn-copy-cancel').addEventListener('click', closeModal);

  // Start button
  modal.querySelector('#btn-copy-start').addEventListener('click', async () => {
    // Switch to progress mode
    modal.querySelector('#btn-copy-start').style.display = 'none';
    modal.querySelector('#btn-copy-cancel').textContent = t('environments:dataP4k.cancelBtn');
    progressContainer.style.display = 'block';
    progressText.style.display = 'block';
    progressStats.style.display = 'flex';

    // Setup progress listener
    unlisten = await listen('data-p4k-progress', (event) => {
      console.log('[DEBUG] Progress event received:', event.payload);
      const { version, percent, copied_bytes, total_bytes, speed_bps } = event.payload;

      // Only handle our target version
      if (version !== targetVersion) return;

      currentCopied = copied_bytes;

      progressBar.style.width = percent + '%';
      progressPercent.textContent = percent + '%';
      copiedBytesEl.textContent = formatFileSize(copied_bytes);

      if (speed_bps > 0) {
        const speedMB = (speed_bps / (1024 * 1024)).toFixed(1);
        speedEl.textContent = speedMB + ' MB/s';
        etaEl.textContent = calculateEta(speed_bps, copied_bytes);
      }
    });

    // Set copying state
    copyingVersion = { version: targetVersion, startTime: Date.now() };

    // Reload to show yellow "copying" state
    renderEnvironments(document.getElementById('content'));

    try {
      await invoke('copy_data_p4k', {
        gp: config.install_path,
        sourceVersion,
        targetVersion
      });

      // Success
      showNotification(t('environments:notification.dataP4kCopied'), 'success');
      if (unlisten) {
        unlisten();
        unlisten = null;
      }
      modal.remove();

      // Reload versions
      scVersions = await invoke('detect_sc_versions', { gp: config.install_path });
      renderEnvironments(document.getElementById('content'));

    } catch (e) {
      if (e.includes('cancelled') || e.includes('aborted')) {
        showNotification(t('environments:notification.copyCancelled'), 'info');
      } else {
        showNotification(`Error: ${e}`, 'error');
      }
      if (unlisten) {
        unlisten();
        unlisten = null;
      }
      modal.remove();

      // Reload versions
      scVersions = await invoke('detect_sc_versions', { gp: config.install_path });
      renderEnvironments(document.getElementById('content'));
    }

    copyingVersion = null;
  });
}

// ==================== Event Listeners ====================

/**
 * Attaches all event listeners for the Environments page.
 * This central function is called after each render and connects
 * tab navigation, version selection, profile actions, binding editor,
 * drag-and-drop, USER.cfg controls, localization, and more.
 */
function attachProfilesEventListeners() {
  // Tab navigation — use rerenderFromState() to avoid full reload + skeleton flash
  document.querySelectorAll('.profile-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      activeProfileTab = tab.dataset.tab;
      rerenderFromState();
    });
  });

  // Hint dismiss buttons
  document.querySelectorAll('[data-action="dismiss-hint"]').forEach(btn => {
    btn.addEventListener('click', () => dismissHint(btn.dataset.hintId));
  });

  // Collapsible panel toggles (Bindings, Devices)
  document.querySelectorAll('.collapsible-header').forEach(header => {
    header.addEventListener('click', () => {
      const panel = header.dataset.panel;
      window.expandedPanels[panel] = !window.expandedPanels[panel];
      const toggle = header.querySelector('.collapsible-toggle');
      const content = header.nextElementSibling;
      if (toggle) toggle.classList.toggle('collapsed');
      if (content) content.classList.toggle('collapsed');
    });
  });

  // Version cards: switch SC version on click
  document.querySelectorAll('.sc-version-card').forEach(card => {
    card.addEventListener('click', async () => {
      // No-op if clicking the already-active version
      if (card.dataset.version === activeScVersion) return;
      // Warn about unsaved USER.cfg changes
      if (hasUnsavedChanges()) {
        const proceed = await confirm(t('environments:notification.unsavedVersionSwitch'), {
          title: t('environments:notification.unsavedTitle'),
          kind: 'warning',
          okLabel: t('environments:notification.switchAnyway'),
          cancelLabel: t('environments:notification.stay'),
        });
        if (!proceed) return;
      }
      // Save active profile for current version before switching
      if (activeScVersion && lastRestoredBackupId) {
        lastRestoredPerVersion[activeScVersion] = lastRestoredBackupId;
      }
      // Full state reset before switching — prevents outgoing-env data from
      // contaminating the incoming environment's view
      resetEnvironmentState();
      activeScVersion = card.dataset.version;
      lastRestoredBackupId = lastRestoredPerVersion[activeScVersion] || null;
      renderEnvironments(document.getElementById('content'));
    });
  });

  // Empty Version State actions
  document.getElementById('btn-create-version')?.addEventListener('click', async (e) => {
    const version = e.target.dataset.version;
    await createScVersion(version);
  });

  document.getElementById('btn-link-p4k')?.addEventListener('click', async (e) => {
    const version = e.currentTarget.dataset.version;
    const source = document.getElementById('data-source-select')?.value;
    if (source) await linkDataP4k(source, version);
  });

  document.getElementById('btn-copy-p4k')?.addEventListener('click', async (e) => {
    const version = e.currentTarget.dataset.version;
    const source = document.getElementById('data-source-select')?.value;
    if (source) showDataP4kCopyProgressModal(source, version);
  });

  // Device drag-and-drop (Pointer Events - works in WebKitGTK)
  // The entire card is draggable. Pointer Capture ensures smooth tracking,
  // even when the cursor leaves card boundaries during fast movements.
  document.querySelectorAll('.device-card.draggable').forEach(card => {
    card.addEventListener('pointerdown', (e) => {
      // Ignore clicks on buttons (alias button)
      if (e.target.closest('button')) return;
      e.preventDefault();
      if (!card.dataset.instance) return;

      const sourceInstance = parseInt(card.dataset.instance, 10);
      const sourceDeviceType = card.dataset.deviceType || 'joystick';
      const rect = card.getBoundingClientRect();
      // Offset from pointer to card top-left - keeps the clone anchored where you grabbed it
      const offsetX = e.clientX - rect.left;
      const offsetY = e.clientY - rect.top;

      // Pointer Capture: events keep flowing even when the cursor leaves the element
      card.setPointerCapture(e.pointerId);

      // Floating clone follows the cursor smoothly in both axes
      const clone = card.cloneNode(true);
      clone.classList.add('drag-clone');
      clone.style.cssText = `position:fixed;width:${rect.width}px;top:${rect.top}px;left:${rect.left}px;z-index:1000;pointer-events:none;will-change:transform;`;
      document.body.appendChild(clone);
      card.classList.add('dragging');

      function onMove(ev) {
        // Use transform for jank-free movement (GPU-accelerated)
        const dx = ev.clientX - offsetX - rect.left;
        const dy = ev.clientY - offsetY - rect.top;
        clone.style.transform = `translate(${dx}px, ${dy}px)`;

        // Highlight drop target via bounding box overlap check
        document.querySelectorAll('.device-card.draggable').forEach(c => {
          if (c === card) return;
          const r = c.getBoundingClientRect();
          const hit = ev.clientX >= r.left && ev.clientX <= r.right
                   && ev.clientY >= r.top && ev.clientY <= r.bottom;
          c.classList.toggle('drag-over', hit);
        });
      }

      function onUp() {
        card.removeEventListener('pointermove', onMove);
        card.removeEventListener('pointerup', onUp);
        clone.remove();
        card.classList.remove('dragging');

        // Find drop target (the card under the cursor)
        let targetInstance = null;
        let targetDeviceType = 'joystick';
        document.querySelectorAll('.device-card.draggable').forEach(c => {
          if (c.classList.contains('drag-over')) {
            targetInstance = parseInt(c.dataset.instance, 10);
            targetDeviceType = c.dataset.deviceType || 'joystick';
            c.classList.remove('drag-over');
          }
        });

        if (targetInstance !== null && targetInstance !== sourceInstance) {
          handleDeviceDrop(sourceInstance, targetInstance, sourceDeviceType, targetDeviceType);
        }
      }

      card.addEventListener('pointermove', onMove);
      card.addEventListener('pointerup', onUp);
    });
  });

  // Reload profile from disk
  document.getElementById('btn-reload-profile')?.addEventListener('click', async () => {
    await Promise.all([loadDevicesAndBindings(), loadCompleteBindingList(), loadExportedLayouts()]);
    renderEnvironments(document.getElementById('content'));
    showNotification(t('environments:notification.profileReloaded'), 'success');
  });

  document.getElementById('btn-update-profile')?.addEventListener('click', async () => {
    if (lastRestoredBackupId) {
      const confirmed = await confirm(t('environments:notification.updateConfirm'), {
        title: t('environments:notification.updateTitle'),
        kind: 'warning',
      });
      if (confirmed) await updateProfileFromSc(lastRestoredBackupId);
    }
  });

  document.getElementById('btn-revert-changes')?.addEventListener('click', async () => {
    if (lastRestoredBackupId) {
      const confirmed = await confirm(t('environments:notification.revertConfirm'), {
        title: t('environments:notification.revertTitle'),
        kind: 'warning',
      });
      if (confirmed) {
        try {
          await invoke('restore_profile', {
            gp: config.install_path,
            v: activeScVersion,
            bid: lastRestoredBackupId,
          });
          showNotification(t('environments:notification.profileReverted'), 'success');
          await Promise.all([loadActionDefinitions(), loadDevicesAndBindings(), loadCompleteBindingList(), loadBackups(), loadUserCfgSettings()]);
          await loadProfileStatus();
          renderEnvironments(document.getElementById('content'));
        } catch (e) {
          showNotification(t('environments:notification.revertFailed', { error: e }), 'error');
        }
      }
    }
  });

  // Binding source select
  document.getElementById('binding-source-select')?.addEventListener('change', async (e) => {
    selectedBindingSource = e.target.value || null;
    await loadDevicesAndBindings();
    await loadCompleteBindingList();
    renderEnvironments(document.getElementById('content'));
  });

  // Bindings specific listeners (Search, Matrix, Add/Edit/Delete)
  attachBindingEventListeners();

  // Profile save / load / delete
  document.getElementById('btn-save-current')?.addEventListener('click', saveProfile);
  document.getElementById('btn-save-first-profile')?.addEventListener('click', saveProfile);

  document.querySelectorAll('[data-action="load-profile"]').forEach(btn => {
    btn.addEventListener('click', () => loadProfile(btn.dataset.backupId));
  });

  document.querySelectorAll('[data-action="delete-saved-profile"]').forEach(btn => {
    btn.addEventListener('click', (e) => { e.stopPropagation(); deleteProfile(btn.dataset.backupId); });
  });

  // Storage tab actions
  document.getElementById('btn-delete-version')?.addEventListener('click', async (e) => {
    const version = e.target.closest('button').dataset.version;
    await deleteScVersion(version);
  });

  // Toggle changes detail panel + file diff — delegated on document so the listener
  // survives renderEnvironments() rebuilding the DOM (btn-toggle-changes and
  // .profile-changes-panel live inside #content which is fully replaced on each render).
  // Remove previous registration first to prevent accumulation across re-renders.
  if (_profilesDelegatedClickHandler) {
    document.removeEventListener('click', _profilesDelegatedClickHandler);
  }
  _profilesDelegatedClickHandler = async (e) => {
    if (e.target.closest('#btn-toggle-changes')) {
      showChangesPanel = !showChangesPanel;
      renderEnvironments(document.getElementById('content'));
      return;
    }
    const row = e.target.closest('.profile-changes-panel .file-clickable');
    if (!row) return;
    const file = row.dataset.file;
    if (!file || !config?.install_path || !activeScVersion || !lastRestoredBackupId) return;
    try {
      const lines = await invoke('get_file_diff', {
        file,
        gp: config.install_path,
        v: activeScVersion,
        bid: lastRestoredBackupId,
      });
      await showDiff(file, lines);
    } catch (err) {
      console.error('Failed to load diff:', err);
    }
  };
  document.addEventListener('click', _profilesDelegatedClickHandler);

  // Apply to SC button
  document.getElementById('btn-apply-to-sc')?.addEventListener('click', async () => {
    if (!config?.install_path || !activeScVersion || !lastRestoredBackupId) return;
    try {
      const corrections = await invoke('apply_profile_to_sc', {
        gp: config.install_path,
        v: activeScVersion,
        profileId: lastRestoredBackupId,
      });
      showNotification(t('environments:notification.profileApplied'), 'success');
      if (corrections > 0) {
        showNotification(
          t('environments:notification.bindingsSanitized', { count: corrections }),
          'warning'
        );
      }
      await loadBackups();
      await loadProfileStatus();
      renderEnvironments(document.getElementById('content'));
    } catch (e) {
      showNotification(t('environments:notification.applyFailed', { error: e }), 'error');
    }
  });

  // Customized only toggle
  document.getElementById('customized-only-toggle')?.addEventListener('change', (e) => {
    customizedOnly = e.target.checked;
    refreshBindingsInPlace();
  });

  // Essentials only toggle — mutually exclusive with bound-only
  document.getElementById('essentials-only-toggle')?.addEventListener('change', (e) => {
    essentialsOnly = e.target.checked;
    if (essentialsOnly) {
      boundOnly = false;
      const boundToggle = document.getElementById('bound-only-toggle');
      if (boundToggle) boundToggle.checked = false;
    }
    refreshBindingsInPlace();
  });

  // Bound only toggle — mutually exclusive with essentials-only
  document.getElementById('bound-only-toggle')?.addEventListener('change', (e) => {
    boundOnly = e.target.checked;
    if (boundOnly) {
      essentialsOnly = false;
      const essentialsToggle = document.getElementById('essentials-only-toggle');
      if (essentialsToggle) essentialsToggle.checked = false;
    }
    refreshBindingsInPlace();
  });

  // Human-readable toggle
  document.getElementById('use-human-readable')?.addEventListener('change', (e) => {
    useHumanReadable = e.target.checked;
    refreshBindingsInPlace();
  });

  // Device alias buttons
  document.querySelectorAll('.device-card-v2-rename').forEach(btn => {
    btn.addEventListener('click', async () => {
      const productName = btn.dataset.product;
      const currentAlias = btn.dataset.alias || productName;
      const newAlias = await prompt(t('environments:device.aliasPrompt', { name: productName }), { title: t('environments:device.aliasTitle'), defaultValue: currentAlias });
      if (newAlias === null) return; // cancelled
      try {
        await invoke('set_profile_device_alias', {
          v: activeScVersion,
          profileId: lastRestoredBackupId,
          productName,
          alias: newAlias,
        });
        await loadBackups();
        renderEnvironments(document.getElementById('content'));
      } catch (e) {
        showNotification(t('environments:notification.aliasSetFailed', { error: e }), 'error');
      }
    });
  });

  // Rename saved profile - click edit icon to show inline input
  document.querySelectorAll('[data-action="rename-saved-profile"]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation(); // prevent card click
      const backupId = btn.dataset.backupId;
      const wrap = btn.closest('.profile-card-header') || btn.closest('.backup-main');
      if (!wrap || wrap.querySelector('.backup-rename-input')) return;

      const labelEl = wrap.querySelector('.profile-card-name') || wrap.querySelector('.backup-label-display');
      const backup = backups.find(b => b.id === backupId);
      const currentLabel = backup?.label || '';

      // Hide label and icon, show input
      labelEl.style.display = 'none';
      btn.style.display = 'none';

      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'input backup-rename-input';
      input.value = currentLabel;
      input.placeholder = t('environments:profile.profileName');
      input.maxLength = 60;
      wrap.appendChild(input);
      input.focus();
      input.select();

      async function saveRename() {
        const newLabel = input.value.trim();
        input.remove();
        labelEl.style.display = '';
        btn.style.display = '';
        labelEl.textContent = newLabel || t('environments:profile.unnamedProfile');

        if (backup) backup.label = newLabel;

        try {
          await invoke('update_backup_label', {
            v: activeScVersion,
            bid: backupId,
            l: newLabel,
          });
        } catch (e) {
          showNotification(t('environments:notification.renameFailed', { error: e }), 'error');
        }
        // Update header if this is the active profile
        if (lastRestoredBackupId === backupId) {
          renderEnvironments(document.getElementById('content'));
        }
      }

      input.addEventListener('blur', saveRename);
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
        if (e.key === 'Escape') { input.value = currentLabel; input.blur(); }
      });
    });
  });

  // Import from version
  document.getElementById('btn-import-version')?.addEventListener('click', showImportVersionDialog);
  document.getElementById('btn-import-banner')?.addEventListener('click', showImportVersionDialog);
  document.getElementById('btn-import-banner-dismiss')?.addEventListener('click', () => {
    document.getElementById('import-banner')?.remove();
  });

  // Data.p4k Copy Button
  document.querySelectorAll('.version-copy-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const targetVersion = btn.dataset.version;
      showDataP4kCopyDropdown(targetVersion, e);
    });
  });

  // USER.cfg
  document.getElementById('btn-apply-usercfg')?.addEventListener('click', applyUserCfg);
  document.getElementById('btn-reset-usercfg')?.addEventListener('click', resetUserCfg);

  // Sync conflict resolution
  document.getElementById('btn-resolve-conflicts')?.addEventListener('click', () => {
    const panel = document.getElementById('usercfg-conflict-panel');
    if (panel) panel.style.display = panel.style.display === 'none' ? '' : 'none';
  });
  document.getElementById('btn-conflict-keep-all')?.addEventListener('click', async () => {
    // Keep our values: write them back to attributes.xml
    const changes = {};
    for (const c of pendingConflicts) {
      changes[c.attrName] = convertToAttrValue(c.key, c.ourValue);
    }
    try {
      await invoke('write_attributes_partial', { gp: config.install_path, v: activeScVersion, changes });
      savedAttributesHash = await invoke('get_attributes_hash', { gp: config.install_path, v: activeScVersion });
      savedAttributesValues = await invoke('read_attributes_map', { gp: config.install_path, v: activeScVersion });
    } catch (e) { /* ignore */ }
    pendingConflicts = [];
    rerenderFromState();
  });
  document.getElementById('btn-conflict-accept-all')?.addEventListener('click', async () => {
    // Accept SC values: update our UI state
    for (const c of pendingConflicts) {
      userCfgSettings[c.key] = c.scValue;
    }
    pendingConflicts = [];
    savedUserCfgSnapshot = { ...userCfgSettings };
    savedAttributesValues = await invoke('read_attributes_map', { gp: config.install_path, v: activeScVersion });
    savedAttributesHash = await invoke('get_attributes_hash', { gp: config.install_path, v: activeScVersion });
    rerenderFromState();
  });
  // Per-conflict buttons (delegated)
  document.getElementById('usercfg-conflict-panel')?.addEventListener('click', async (e) => {
    const keepBtn = e.target.closest('.conflict-keep');
    const acceptBtn = e.target.closest('.conflict-accept');
    if (keepBtn) {
      const key = keepBtn.dataset.key;
      const conflict = pendingConflicts.find(c => c.key === key);
      if (conflict) {
        try {
          await invoke('write_attributes_partial', {
            gp: config.install_path, v: activeScVersion,
            changes: { [conflict.attrName]: convertToAttrValue(key, conflict.ourValue) }
          });
        } catch (e) { /* ignore */ }
        pendingConflicts = pendingConflicts.filter(c => c.key !== key);
        rerenderFromState();
      }
    }
    if (acceptBtn) {
      const key = acceptBtn.dataset.key;
      const scValue = parseFloat(acceptBtn.dataset.value);
      const conflict = pendingConflicts.find(c => c.key === key);
      if (conflict) {
        userCfgSettings[key] = isNaN(scValue) ? acceptBtn.dataset.value : scValue;
        pendingConflicts = pendingConflicts.filter(c => c.key !== key);
        savedUserCfgSnapshot = { ...userCfgSettings };
        rerenderFromState();
      }
    }
  });

  // Accordion toggle for collapsible categories
  document.querySelectorAll('.usercfg-category-header.collapsible').forEach(header => {
    header.addEventListener('click', () => {
      const catKey = header.dataset.categoryKey;
      if (collapsedCategories.has(catKey)) {
        collapsedCategories.delete(catKey);
      } else {
        collapsedCategories.add(catKey);
      }
      const settingsDiv = header.nextElementSibling;
      const toggleIcon = header.querySelector('.usercfg-category-toggle');
      if (settingsDiv) settingsDiv.classList.toggle('collapsed');
      if (toggleIcon) toggleIcon.classList.toggle('collapsed');
    });
  });

  // Slider changes
  document.querySelectorAll('.usercfg-slider').forEach(slider => {
    slider.addEventListener('input', (e) => {
      const key = e.target.dataset.key;
      const value = parseFloat(e.target.value);
      const setting = DEFAULT_SETTINGS[key];

      let displayValue = value;
      const slb = getSettingLabels(key) || setting.labels;
      if (slb) displayValue = slb[value] || value;
      else if (QUALITY_KEYS.has(key)) displayValue = getQualityLevels()[value] || value;
      else if (SHADER_KEYS.has(key)) displayValue = getShaderLevels()[value] || value;

      e.target.parentElement.querySelector('.usercfg-value').textContent = displayValue;
      userCfgSettings[key] = value;
      updateSettingHighlight(e.target.closest('.usercfg-row'), key, setting, value);
    });
  });

  // Number input changes
  document.querySelectorAll('.usercfg-number-input').forEach(input => {
    input.addEventListener('change', (e) => {
      const key = e.target.dataset.key;
      const value = parseFloat(e.target.value);
      const setting = DEFAULT_SETTINGS[key];
      userCfgSettings[key] = value;
      updateSettingHighlight(e.target.closest('.usercfg-row'), key, setting, value);
    });
  });

  // Checkbox changes
  document.querySelectorAll('.usercfg-input[type="checkbox"]').forEach(checkbox => {
    checkbox.addEventListener('change', (e) => {
      const key = e.target.dataset.key;
      const value = e.target.checked ? 1 : 0;
      const setting = DEFAULT_SETTINGS[key];
      userCfgSettings[key] = value;
      updateSettingHighlight(e.target.closest('.usercfg-row'), key, setting, value);
    });
  });

  // Resolution inputs
  document.querySelectorAll('.usercfg-res-input').forEach(input => {
    input.addEventListener('change', (e) => {
      const key = e.target.dataset.key; // r_width or r_height
      const value = parseInt(e.target.value, 10);
      if (!isNaN(value)) {
        userCfgSettings[key] = value;
        // Update preset dropdown to match
        const preset = document.querySelector('.usercfg-res-preset');
        if (preset) {
          const w = userCfgSettings.r_width !== undefined ? userCfgSettings.r_width : 1920;
          const h = userCfgSettings.r_height !== undefined ? userCfgSettings.r_height : 1080;
          const match = RESOLUTION_PRESETS.find(p => p.w === w && p.h === h);
          preset.value = match ? `${w}x${h}` : '';
        }
        updateResolutionHighlight();
      }
    });
  });

  // Resolution preset dropdown
  document.querySelectorAll('.usercfg-res-preset').forEach(select => {
    select.addEventListener('change', (e) => {
      const val = e.target.value;
      if (!val) return; // "Custom" selected
      const [w, h] = val.split('x').map(Number);
      userCfgSettings.r_width = w;
      userCfgSettings.r_height = h;
      const wInput = document.querySelector('.usercfg-res-input[data-key="r_width"]');
      const hInput = document.querySelector('.usercfg-res-input[data-key="r_height"]');
      if (wInput) wInput.value = w;
      if (hInput) hInput.value = h;
      updateResolutionHighlight();
    });
  });

  // Localization: install language buttons
  document.querySelectorAll('[data-action="install-lang"]').forEach(btn => {
    btn.addEventListener('click', () => {
      installLocalization(
        btn.dataset.langCode,
        btn.dataset.sourceRepo,
        btn.dataset.langName,
        btn.dataset.sourceLabel,
      );
    });
  });

  // Help icon popovers (event delegation on the entire usercfg section)
  document.querySelector('.usercfg-section')?.addEventListener('click', (e) => {
    const helpBtn = e.target.closest('.usercfg-help-btn');
    if (!helpBtn) return;
    e.stopPropagation();

    // Remove any existing popover
    const existing = document.querySelector('.usercfg-help-popover');
    if (existing) {
      existing.remove();
      // If clicking the same button, just close
      if (existing._triggerBtn === helpBtn) return;
    }

    const helpText = helpBtn.dataset.help;
    if (!helpText) return;

    const popover = document.createElement('div');
    popover.className = 'usercfg-help-popover';
    popover._triggerBtn = helpBtn;
    popover.textContent = helpText;

    // Position near the button
    const rect = helpBtn.getBoundingClientRect();
    popover.style.top = `${rect.bottom + 6}px`;
    popover.style.left = `${Math.max(8, rect.left - 100)}px`;
    document.body.appendChild(popover);

    // Close on outside click
    const closeHandler = (ev) => {
      if (!popover.contains(ev.target) && ev.target !== helpBtn) {
        popover.remove();
        document.removeEventListener('click', closeHandler, true);
      }
    };
    setTimeout(() => document.addEventListener('click', closeHandler, true), 0);
  });

  // Localization: update button
  document.getElementById('btn-update-localization')?.addEventListener('click', () => {
    const repo = resolveSourceRepo();
    if (repo && localizationStatus) {
      installLocalization(
        localizationStatus.language_code,
        repo,
        localizationStatus.language_name || localizationStatus.language_code,
        localizationStatus.source_label || '',
      );
    }
  });

  // Localization: remove button
  document.getElementById('btn-remove-localization')?.addEventListener('click', removeLocalization);

  // Localization: repo links (event delegation)
  document.querySelectorAll('.localization-repo-link, .localization-repo-link-icon').forEach(link => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      const url = link.dataset.url;
      if (url) invoke('open_browser', { url }).catch(err => console.error(err));
    });
  });

  // Reset individual setting to default value (event delegation)
  document.querySelector('.usercfg-section')?.addEventListener('click', (e) => {
    const btn = e.target.closest('.usercfg-reset');
    if (!btn) return;

    const key = btn.dataset.key;

    // Special handling for resolution reset
    if (key === '_resolution') {
      delete userCfgSettings.r_width;
      delete userCfgSettings.r_height;
      const wInput = document.querySelector('.usercfg-res-input[data-key="r_width"]');
      const hInput = document.querySelector('.usercfg-res-input[data-key="r_height"]');
      const preset = document.querySelector('.usercfg-res-preset');
      if (wInput) wInput.value = 1920;
      if (hInput) hInput.value = 1080;
      if (preset) preset.value = '1920x1080';
      updateResolutionHighlight();
      return;
    }

    const setting = DEFAULT_SETTINGS[key];
    if (!setting) return;

    delete userCfgSettings[key];

    const row = btn.closest('.usercfg-row');
    if (!row) return;

    // Update the control value in the DOM
    const slider = row.querySelector('.usercfg-slider');
    const numberInput = row.querySelector('.usercfg-number-input');
    const checkbox = row.querySelector('.usercfg-input[type="checkbox"]');

    if (slider) {
      slider.value = setting.value;
      const valueSpan = row.querySelector('.usercfg-value');
      if (valueSpan) {
        let display = setting.value;
        const rlb = getSettingLabels(key) || setting.labels;
        if (rlb) display = rlb[setting.value] || setting.value;
        else if (QUALITY_KEYS.has(key)) display = getQualityLevels()[setting.value] || setting.value;
        else if (SHADER_KEYS.has(key)) display = getShaderLevels()[setting.value] || setting.value;
        valueSpan.textContent = display;
      }
    } else if (numberInput) {
      numberInput.value = setting.value;
    } else if (checkbox) {
      checkbox.checked = !!setting.value;
    }

    updateSettingHighlight(row, key, setting, setting.value);
  });

  // Data.p4k copy progress listener - clean up old listeners to prevent leaks
  if (unlistenProgress) { unlistenProgress(); unlistenProgress = null; }
  if (unlistenCopyComplete) { unlistenCopyComplete(); unlistenCopyComplete = null; }

  listen('data-p4k-progress', (event) => {
    const { version, percent, copied_bytes, total_bytes } = event.payload;
    // Update progress bar if this version is being copied
    const progressEl = document.querySelector(`.version-copy-progress[data-version="${version}"]`);
    if (progressEl) {
      progressEl.style.width = `${percent}%`;
      progressEl.textContent = `${percent}%`;
    }
  }).then(fn => { unlistenProgress = fn; });

  listen('data-p4k-copy-complete', async (event) => {
    const { version, success } = event.payload;
    if (success) {
      showNotification(t('environments:notification.dataP4kForVersion', { version }), 'success');
    }
    copyingVersion = null;
    // Reload versions
    scVersions = await invoke('detect_sc_versions', { gp: config.install_path });
    renderEnvironments(document.getElementById('content'));
  }).then(fn => { unlistenCopyComplete = fn; });
}

/**
 * Updates the resolution setting highlight (changed/default).
 * Adds or removes the changed class, default label, and reset button
 * based on whether the current resolution differs from 1920x1080.
 */
function updateResolutionHighlight() {
  const row = document.querySelector('.usercfg-res-input')?.closest('.usercfg-row');
  if (!row) return;
  const w = userCfgSettings.r_width !== undefined ? userCfgSettings.r_width : 1920;
  const h = userCfgSettings.r_height !== undefined ? userCfgSettings.r_height : 1080;
  const isChanged = w !== 1920 || h !== 1080;
  const label = row.querySelector('.usercfg-label');
  const controlWrap = row.querySelector('.usercfg-control-wrap');

  if (isChanged) {
    row.classList.add('usercfg-changed');
    if (label && !label.querySelector('.usercfg-default')) {
      const helpBtn = label.querySelector('.usercfg-help-btn');
      const helpHtml = helpBtn ? helpBtn.outerHTML : '';
      label.innerHTML = `${helpHtml}Resolution <span class="usercfg-default">(${t('environments:cfg.defaultPrefix', { value: '1920 × 1080' })})</span>`;
    }
    if (controlWrap && !controlWrap.querySelector('.usercfg-reset')) {
      const btn = document.createElement('button');
      btn.className = 'usercfg-reset';
      btn.dataset.key = '_resolution';
      btn.title = 'Reset to default';
      btn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="1 4 1 10 7 10"></polyline><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"></path></svg>';
      controlWrap.appendChild(btn);
    }
  } else {
    row.classList.remove('usercfg-changed');
    if (label) {
      const defaultSpan = label.querySelector('.usercfg-default');
      if (defaultSpan) defaultSpan.remove();
    }
    const resetBtn = controlWrap?.querySelector('.usercfg-reset');
    if (resetBtn) resetBtn.remove();
  }
  updateChangedCounts();
}

/**
 * Updates the visual highlight of a setting row based on whether
 * it differs from its default value. Manages the changed class,
 * default value label, and per-setting reset button.
 * @param {HTMLElement|null} row - The .usercfg-row element to update
 * @param {string} key - CVar key name
 * @param {Object} setting - Setting definition from DEFAULT_SETTINGS
 * @param {number|string} value - Current value of the setting
 */
function updateSettingHighlight(row, key, setting, value) {
  const isChanged = value !== setting.value;
  if (!row) return;

  const controlWrap = row.querySelector('.usercfg-control-wrap');

  if (isChanged) {
    row.classList.add('usercfg-changed');
    const label = row.querySelector('.usercfg-label');
    const defaultLabel = setting.type === 'toggle'
      ? (setting.value ? t('environments:cfg.on') : t('environments:cfg.off'))
      : ((getSettingLabels(key) || setting.labels)
        ? ((getSettingLabels(key) || setting.labels)[setting.value] || setting.value)
        : (QUALITY_KEYS.has(key)
          ? (getQualityLevels()[setting.value] || setting.value)
          : (SHADER_KEYS.has(key)
            ? (getShaderLevels()[setting.value] || setting.value)
            : setting.value)));
    if (!label.querySelector('.usercfg-default')) {
      // Preserve help icon if present
      const helpBtn = label.querySelector('.usercfg-help-btn');
      const helpHtml = helpBtn ? helpBtn.outerHTML : '';
      label.innerHTML = `${helpHtml}${setting.label} <span class="usercfg-default">(${t('environments:cfg.defaultPrefix', { value: defaultLabel })})</span>`;
    }
    // Add reset button if not present
    if (controlWrap && !controlWrap.querySelector('.usercfg-reset')) {
      const btn = document.createElement('button');
      btn.className = 'usercfg-reset';
      btn.dataset.key = key;
      btn.title = 'Reset to default';
      btn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="1 4 1 10 7 10"></polyline><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"></path></svg>';
      controlWrap.appendChild(btn);
    }
  } else {
    row.classList.remove('usercfg-changed');
    const label = row.querySelector('.usercfg-label');
    const defaultSpan = label.querySelector('.usercfg-default');
    if (defaultSpan) defaultSpan.remove();
    // Remove reset button
    const resetBtn = controlWrap?.querySelector('.usercfg-reset');
    if (resetBtn) resetBtn.remove();
  }

  // Update category badge and header count
  updateChangedCounts();
}

/**
 * Updates the changed-count badges on each category header and the
 * overall header count. Also toggles the unsaved changes indicator.
 */
function updateChangedCounts() {
  // Update each category badge
  document.querySelectorAll('.usercfg-category').forEach(cat => {
    const header = cat.querySelector('.usercfg-category-header');
    if (!header) return;
    const catKey = header.dataset?.categoryKey;
    const changedInCat = cat.querySelectorAll('.usercfg-row.usercfg-changed').length;
    let badge = header.querySelector('.usercfg-category-badge');
    if (changedInCat > 0) {
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'usercfg-category-badge';
        const label = header.querySelector('.usercfg-category-label');
        if (label) label.after(badge);
      }
      badge.textContent = t('environments:cfg.countChanged', { count: changedInCat });
    } else if (badge) {
      badge.remove();
    }
  });

  // Update header total count
  const totalChanged = getChangedSettingsCount();
  const headerCount = document.querySelector('.usercfg-header-count');
  if (headerCount) {
    headerCount.textContent = totalChanged > 0 ? t('environments:cfg.countChanged', { count: totalChanged }) : t('environments:cfg.allDefaults');
  }

  // Update unsaved indicator
  const unsavedEl = document.getElementById('usercfg-unsaved');
  if (unsavedEl) {
    const hasUnsaved = hasUnsavedChanges();
    unsavedEl.style.display = hasUnsaved ? '' : 'none';
  }
}

/**
 * Checks whether the current USER.cfg settings differ from the last saved state.
 * @returns {boolean} True if there are unsaved changes
 */
function hasUnsavedChanges() {
  // Compare current settings against saved snapshot
  const allKeys = new Set([
    ...Object.keys(userCfgSettings),
    ...Object.keys(savedUserCfgSnapshot),
  ]);
  for (const key of allKeys) {
    const current = userCfgSettings[key];
    const saved = savedUserCfgSnapshot[key];
    if (current !== saved) return true;
  }
  return false;
}

// ==================== Utilities ====================




// ==================== App Close Blocker ====================

/**
 * Initializes a window close blocker that prevents closing the app
 * while a Data.p4k copy operation is in progress. Shows a confirmation
 * dialog and aborts the copy if the user confirms.
 */
async function initCloseBlocker() {
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    const appWindow = getCurrentWindow();

    appWindow.onCloseRequested(async (event) => {
      if (copyingVersion) {
        // Prevent close
        event.preventDefault();

        // Show confirmation dialog (async custom dialog)
        const confirmed = await confirm(
          t('environments:closeBlocker.copyInProgress', { version: copyingVersion.version }),
          { title: t('environments:closeBlocker.title'), kind: 'warning', okLabel: t('environments:closeBlocker.okLabel'), cancelLabel: t('environments:closeBlocker.cancelLabel') }
        );

        if (confirmed) {
          // Abort copy and delete partial file
          try {
            await invoke('abort_copy_data_p4k', {
              gp: config.install_path,
              version: copyingVersion.version
            });
            showNotification(t('environments:notification.copyCancelledAndDeleted'), 'info');
          } catch (e) {
            console.error('Failed to abort copy:', e);
          }

          copyingVersion = null;

          // Reload and allow close
          scVersions = await invoke('detect_sc_versions', { gp: config.install_path });
          renderEnvironments(document.getElementById('content'));

          // Now close
          await appWindow.close();
        }
      }
    });
  } catch (e) {
    console.warn('Close blocker not available:', e);
  }
}

// Initialize close blocker when profiles module loads
initCloseBlocker();

/**
 * Creates a new SC version folder in the installation directory.
 * Reloads the environments view after creation.
 * @param {string} version - Version name to create (e.g. "PTU")
 */
async function createScVersion(version) {
  if (!version || !config?.install_path) return;
  
  try {
    showNotification(t('environments:notification.creatingFolder', { version }), 'info');
    await invoke('create_sc_version', { gp: config.install_path, version });
    showNotification(t('environments:notification.folderCreated', { version }), 'success');
    
    // Reload environments
    scVersions = await invoke('detect_sc_versions', { gp: config.install_path });
    renderEnvironments(document.getElementById('content'));
  } catch (err) {
    showNotification(t('environments:notification.createFailed', { error: err }), 'error');
  }
}

/**
 * Creates a symlink for Data.p4k from one version to another.
 * This saves disk space by sharing the large game data file.
 * @param {string} sourceVersion - Version that has the original Data.p4k
 * @param {string} targetVersion - Version that will receive the symlink
 */
async function linkDataP4k(sourceVersion, targetVersion) {
  if (!sourceVersion || !targetVersion || !config?.install_path) return;
  
  try {
    showNotification(t('environments:notification.symlinking', { source: sourceVersion, target: targetVersion }), 'info');
    await invoke('link_data_p4k', { gp: config.install_path, src_version: sourceVersion, dst_version: targetVersion });
    showNotification(t('environments:notification.symlinkSuccess'), 'success');
    
    // Reload environments
    scVersions = await invoke('detect_sc_versions', { gp: config.install_path });
    renderEnvironments(document.getElementById('content'));
  } catch (err) {
    showNotification(t('environments:notification.symlinkFailed', { error: err }), 'error');
  }
}

/**
 * Updates an existing profile with the current Star Citizen game files.
 * Overwrites the profile's stored files with the live SC files.
 * @param {string} backupId - ID of the profile to update
 */
async function updateProfileFromSc(backupId) {
  if (!backupId || !activeScVersion || !config?.install_path) return;
  
  try {
    showNotification(t('environments:notification.updatingProfile'), 'info');
    await invoke('update_backup_from_sc', { gp: config.install_path, v: activeScVersion, bid: backupId });
    showNotification(t('environments:notification.profileUpdated'), 'success');
    
    // Refresh UI
    await loadBackups();
    await loadProfileStatus();
    renderEnvironments(document.getElementById('content'));
  } catch (err) {
    showNotification(t('environments:notification.profileUpdateFailed', { error: err }), 'error');
  }
}
