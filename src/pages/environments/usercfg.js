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
 * USER.cfg Editor module for the Environments page.
 *
 * Handles parsing, rendering, editing, saving, and resetting of
 * Star Citizen's USER.cfg and attributes.xml settings.
 *
 * @module pages/environments/usercfg
 */

import { invoke } from '@tauri-apps/api/core';
import { confirm, confirmApplyTarget, showNotification } from '../../utils/dialogs.js';
import { escapeHtml } from '../../utils.js';
import { t } from '../../i18n.js';
import { getState, setState } from './state.js';

// ==================== Data / Constants ====================

/**
 * Default USER.cfg settings with metadata.
 * Each entry defines: default value, label, min/max, step size,
 * category, description, and detailed help text.
 * The categories control the grouping in the UI.
 */
export const DEFAULT_SETTINGS = {
  // Essential settings (visible by default)
  _resolution: { value: '1920x1080', label: 'Resolution', category: 'essential', type: 'resolution', virtual: true,
    target: 'attributes', attrName: 'Width', attrNameHeight: 'Height',
    desc: 'Render resolution (width x height)',
    help: 'Sets the internal rendering resolution. Higher resolutions produce sharper images but significantly increase GPU load. Match your monitor\'s native resolution for best clarity; lower it for better performance on weaker GPUs.' },
  _windowMode: { value: 1, label: 'Window Mode', min: 0, max: 2, step: 1, category: 'essential', labels: ['Windowed', 'Borderless', 'Fullscreen'], virtual: true,
    target: 'attributes', attrName: 'WindowMode',
    desc: 'Windowed, Borderless, or Fullscreen mode',
    help: 'Controls how the game window is displayed. Borderless allows easy Alt-Tab but may add slight input lag. Fullscreen gives exclusive GPU access for best performance. Windowed mode is useful for multi-tasking but has the most overhead.' },
  'r.graphicsRenderer': { value: 0, label: 'Graphics Renderer', min: 0, max: 1, step: 1, category: 'essential', labels: ['Vulkan', 'DX11'],
    target: 'usercfg',
    desc: 'Graphics API: Vulkan (recommended) or DX11',
    help: 'Selects the graphics API. Vulkan is the default since 4.0 and pre-builds shaders to reduce stuttering. DX11 is a legacy fallback with generally worse performance. Only switch to DX11 if Vulkan causes crashes on your hardware.' },
  // VSync — verified empirically: SC default is ON (1); the attribute is only
  // serialised when the user turns it off. We default to 1 so a fresh app state
  // matches SC and use alwaysWrite to make sure our preference is sent through
  // even when it equals SC's default.
  r_VSync: { value: 1, label: 'VSync', min: 0, max: 1, type: 'toggle', category: 'essential',
    target: 'attributes', attrName: 'VSync', alwaysWrite: true,
    desc: 'Sync frames to monitor refresh rate (default: on)',
    help: 'Synchronises rendered frames with your monitor\'s refresh rate to eliminate screen tearing. Adds input latency and can reduce FPS if your system can\'t maintain the refresh rate. Disable for lowest input lag.' },
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
  // Upscaling is split into TWO attributes in SC: the Quality Mode (Off/Quality/
  // Balanced/Performance/Ultra Performance) goes into "Upscaling", the algorithm
  // (TSR/DLSS/FSR) goes into "UpscalingTechnique". Values are 1-indexed in
  // attributes.xml (verified empirically: Upscaling=3 displayed as "Balanced").
  Upscaling: { value: 1, label: 'Upscaling Mode', min: 1, max: 5, step: 1, category: 'essential',
    labels: ['', 'Off', 'Quality', 'Balanced', 'Performance', 'Ultra Performance'],
    target: 'attributes', attrName: 'Upscaling',
    desc: 'Render-resolution scaling preset',
    help: 'Selects how aggressively the renderer downscales the image before upscaling it. Higher quality modes render at a higher internal resolution (e.g. Quality ≈ 66%, Balanced ≈ 57%, Performance ≈ 50%, Ultra Performance ≈ 33%). Off disables upscaling. Pair with an Upscaling Technique below.' },
  // UpscalingTechnique mapping verified empirically: value=1 corresponds to "AMD FSR"
  // in SC's in-game UI. Best guess for the rest based on common SC ordering:
  // 0=CIG TSR (the original / default), 1=AMD FSR, 2=NVIDIA DLSS. To verify the
  // remaining values, switch the technique in SC and re-read with the Compare tab.
  UpscalingTechnique: { value: 0, label: 'Upscaling Technique', min: 0, max: 2, step: 1, category: 'essential',
    labels: ['CIG TSR', 'AMD FSR', 'NVIDIA DLSS'],
    target: 'attributes', attrName: 'UpscalingTechnique',
    desc: 'Which upscaling algorithm to use',
    help: 'Selects the upscaling algorithm. CIG TSR (Temporal Super Resolution) is CryEngine\'s built-in upscaler. AMD FSR runs on most modern GPUs. NVIDIA DLSS uses RTX hardware acceleration. Verify the value in SC\'s UI matches your selection here — the index ordering was reverse-engineered and may need correction for one of the other techniques.' },
  r_DisplayInfo: { value: 0, label: 'Debug HUD', min: 0, max: 4, step: 1, category: 'essential',
    target: 'usercfg',
    desc: 'Performance debug overlay (0=off, 1-4 detail)',
    help: 'Shows real-time performance metrics on screen. Level 1 shows basic FPS, level 2 adds frame timing, level 3 includes RAM/VRAM usage, and level 4 shows GPU load statistics. Useful for troubleshooting; disable for normal play.' },
  r_displayFrameGraph: { value: 0, label: 'Frame Graph', min: 0, max: 1, type: 'toggle', category: 'essential',
    target: 'usercfg',
    desc: 'Frame timing graph overlay',
    help: 'Shows a real-time frame timing graph for performance analysis. Helps identify stuttering patterns, frame spikes, and GPU/CPU bottlenecks. Enable temporarily for troubleshooting; disable for normal play.' },
  // Session Info QR — verified empirically: SC stores this as the "QRCode"
  // attribute in attributes.xml, NOT as the legacy r_DisplaySessionInfo cvar in
  // USER.cfg. SC's default is ON (=1), and SC only writes the attribute when it
  // differs from default. We force-write it (alwaysWrite) so PTU does not silently
  // re-enable the QR overlay every time SC starts.
  QRCode: { value: 0, label: 'Session Info QR', min: 0, max: 1, type: 'toggle', category: 'essential',
    target: 'attributes', attrName: 'QRCode', alwaysWrite: true,
    desc: 'QR code overlay for bug reports (SC default: on, especially in PTU)',
    help: 'Displays a QR code on screen containing session information for Star Citizen bug reports. SC enables this by default (especially in PTU). Penguin Citizen writes the value explicitly on every Apply so the QR code stays off unless you enable it.' },
  IgnoreWindowFocus: { value: 1, label: 'Ignore Window Focus', min: 0, max: 1, type: 'toggle', category: 'essential',
    target: 'attributes', attrName: 'IgnoreWindowFocus',
    desc: 'Keep playing audio when window loses focus',
    help: 'When enabled, Star Citizen continues running and playing audio at full speed even when the window is not focused (e.g. you Alt-Tab to another app). Disable to throttle when minimized — useful if you want to save power while in the background.' },
  AutoDetect: { value: 1, label: 'Auto-Detect Quality', min: 0, max: 1, type: 'toggle', category: 'essential',
    target: 'attributes', attrName: 'AutoDetect',
    desc: 'Auto-detect graphics quality on first launch',
    help: 'When enabled, Star Citizen tries to auto-detect the best graphics preset for your hardware on the next launch. Penguin Citizen sets this to 1 by default; SC turns it off after the first auto-detection. Set back to 1 to force a re-detect on the next start.' },
  // ── Graphics Quality (verified against SC's in-game UI) ──
  // Settings with an in-game menu equivalent are routed to attributes.xml so
  // the user's SC-side choices and our App stay in sync. CryEngine cvar names
  // (sys_spec_*) and SC's profile attribute names (SysSpec_*) differ in case
  // and granularity — we use the attribute name as source of truth because
  // SC's UI writes to attributes.xml, and USER.cfg cvars would just override
  // and undo those changes on every launch (flip-flop). See
  // docs/superpowers/specs/2026-04-08-unified-settings-routing-design.md.
  sys_spec: { value: 3, label: 'Overall Quality', min: 1, max: 5, step: 1, category: 'quality',
    target: 'attributes', attrName: 'SysSpec',
    desc: 'Master quality preset (1=Low, 5=Ultra)',
    help: 'Sets the global graphics quality preset. 1=Low, 2=Medium, 3=High, 4=Very High, 5=Ultra. Star Citizen UI labels this as "Overall Quality Preset". Adjust individual settings below to fine-tune after choosing a base preset.' },
  sys_spec_ObjectDetail: { value: 3, label: 'Object Detail', min: 1, max: 5, step: 1, category: 'quality',
    target: 'attributes', attrName: 'SysSpec_ObjectDetail',
    desc: 'Geometric detail level of objects',
    help: 'Controls the polygon count and detail level of ships, stations, and props. Higher values show more detailed 3D models at greater distances. SC menu: "Object Detail".' },
  SysSpec_ObjectViewDistance: { value: 3, label: 'Object View Distance', min: 1, max: 5, step: 1, category: 'quality',
    target: 'attributes', attrName: 'SysSpec_ObjectViewDistance',
    desc: 'How far away objects remain visible',
    help: 'Controls the maximum distance at which objects are rendered. Higher values keep ships, stations, and props visible from further away. SC menu: "Object View Distance".' },
  sys_spec_Texture: { value: 3, label: 'Texture Quality', min: 1, max: 5, step: 1, category: 'quality',
    target: 'attributes', attrName: 'SysSpec_TextureQuality',
    desc: 'Overall texture quality',
    help: 'Master texture quality setting. Higher values produce sharper textures. Depends on available VRAM. SC menu: "Textures Quality".' },
  SysSpec_TextureDetail: { value: 3, label: 'Detail Textures', min: 1, max: 5, step: 1, category: 'quality',
    target: 'attributes', attrName: 'SysSpec_TextureDetail',
    desc: 'Close-up texture detail',
    help: 'Controls the detail of close-up surface textures (decals, fine surface details). SC menu: "Detail Textures".' },
  SysSpec_TextureGround: { value: 3, label: 'Ground Textures', min: 1, max: 5, step: 1, category: 'quality',
    target: 'attributes', attrName: 'SysSpec_TextureGround',
    desc: 'Ground / terrain texture quality',
    help: 'Controls the resolution of ground and terrain textures on planets and stations. SC menu: "Ground Textures".' },
  SysSpec_TextureFiltering: { value: 3, label: 'Texture Filtering', min: 1, max: 5, step: 1, category: 'quality',
    target: 'attributes', attrName: 'SysSpec_TextureFiltering',
    desc: 'Anisotropic filtering quality',
    help: 'Controls anisotropic texture filtering quality (sharpness of textures viewed at oblique angles). SC menu: "Texture Filtering".' },
  sys_spec_Shadows: { value: 3, label: 'Shadow Maps', min: 1, max: 5, step: 1, category: 'quality',
    target: 'attributes', attrName: 'SysSpec_ShadowMaps',
    desc: 'Shadow map resolution and quality',
    help: 'Controls shadow map resolution, cascade distances, and filtering. Higher values produce sharper, more detailed shadows that extend further. SC menu: "Shadow Maps".' },
  SysSpec_ShadowScreenSpace: { value: 3, label: 'Screen Space Shadows', min: 1, max: 5, step: 1, category: 'quality',
    target: 'attributes', attrName: 'SysSpec_ShadowScreenSpace',
    desc: 'Screen-space shadow quality',
    help: 'Controls the quality of screen-space contact shadows (small shadows from nearby geometry). SC menu: "Screen Space Shadows".' },
  SysSpec_PlanetVolumetricClouds: { value: 4, label: 'Planet Volumetric Clouds', min: 1, max: 5, step: 1, category: 'quality',
    target: 'attributes', attrName: 'SysSpec_PlanetVolumetricClouds',
    desc: 'Volumetric cloud quality on planets',
    help: 'Controls the quality of volumetric clouds on planet surfaces. High GPU impact during atmospheric flight. SC menu: "Planet Volumetric Clouds Quality".' },
  SysSpec_GasCloud: { value: 4, label: 'Gas Clouds', min: 1, max: 5, step: 1, category: 'quality',
    target: 'attributes', attrName: 'SysSpec_GasCloud',
    desc: 'Gas cloud rendering quality',
    help: 'Controls the rendering quality of gas clouds in space (e.g. inside nebulae, asteroid clusters). SC menu: "Gas Clouds".' },
  SysSpec_Fog: { value: 4, label: 'Fog', min: 1, max: 5, step: 1, category: 'quality',
    target: 'attributes', attrName: 'SysSpec_Fog',
    desc: 'Atmospheric fog quality',
    help: 'Controls the rendering of atmospheric fog and haze on planet surfaces. SC menu: "Fog".' },
  sys_spec_Water: { value: 3, label: 'Water Simulation', min: 1, max: 5, step: 1, category: 'quality',
    target: 'attributes', attrName: 'SysSpec_WaterSim',
    desc: 'Water surface simulation quality',
    help: 'Controls the simulation quality of water surfaces (waves, reflections). SC menu: "Water Simulation".' },
  SysSpec_WaterCaustics: { value: 4, label: 'Water Caustics', min: 1, max: 5, step: 1, category: 'quality',
    target: 'attributes', attrName: 'SysSpec_WaterCaustics',
    desc: 'Underwater light caustics quality',
    help: 'Controls the rendering of underwater light caustics (the light patterns refracted by water). SC menu: "Water Caustics".' },
  sys_spec_Particles: { value: 3, label: 'Particles', min: 1, max: 5, step: 1, category: 'quality',
    target: 'attributes', attrName: 'SysSpec_Particles',
    desc: 'Particle system quality and density',
    help: 'Controls the density and complexity of particle effects (smoke, fire, exhaust, debris). SC menu: "Particles".' },
  sys_spec_Shading: { value: 3, label: 'Shader Quality', min: 1, max: 5, step: 1, category: 'quality',
    target: 'attributes', attrName: 'SysSpec_Shading',
    desc: 'Material shading quality',
    help: 'Controls the complexity of surface shading, material rendering, and lighting calculations. SC menu: "Shader Quality".' },
  SysSpec_PostProcessingAttr: { value: 3, label: 'Post Effects', min: 1, max: 5, step: 1, category: 'quality',
    target: 'attributes', attrName: 'SysSpec_PostProcessing',
    desc: 'Post-processing effects quality',
    help: 'Controls the quality of screen-space post-processing effects (bloom, motion blur, depth of field). SC menu: "Post Effects".' },
  SysSpec_VideoComms: { value: 3, label: 'Video Comms', min: 1, max: 5, step: 1, category: 'quality',
    target: 'attributes', attrName: 'SysSpec_VideoComms',
    desc: 'In-game video call quality',
    help: 'Controls the rendering quality of in-game video communication overlays (mobiGlas calls). SC menu: "Video Comms".' },
  // Engine-only quality sub-settings (no SC in-game menu equivalent — stay in USER.cfg)
  sys_spec_GameEffects: { value: 3, label: 'Game Effects (engine)', min: 1, max: 5, step: 1, category: 'quality',
    target: 'usercfg', overrideWarning: true,
    desc: 'Engine-level quality of gameplay visual effects',
    help: 'CryEngine cvar with no in-game UI equivalent. Controls gameplay visual effect engine quality. Written to USER.cfg only — overrides whatever the engine derives from the Overall Quality preset on every launch.' },
  sys_spec_Physics: { value: 3, label: 'Physics (engine)', min: 1, max: 5, step: 1, category: 'quality',
    target: 'usercfg', overrideWarning: true,
    desc: 'Engine physics simulation detail',
    help: 'CryEngine cvar with no in-game UI equivalent. Controls physics simulation complexity. Written to USER.cfg only — overrides whatever the engine derives from the Overall Quality preset on every launch.' },
  // Shader Quality (verified) -- all target: 'usercfg' (no in-game menu equivalent)
  q_ShaderFX: { value: 3, label: 'FX Shaders', min: 0, max: 4, step: 1, category: 'shaders', target: 'usercfg',
    desc: 'Visual effects shader complexity (0-3)',
    help: 'Controls the shader quality for special visual effects like explosions, energy beams, and quantum travel effects. 0=Low, 1=Medium, 2=High, 3=Very High. Lower values simplify effect rendering for better FPS during action sequences.' },
  q_ShaderGeneral: { value: 3, label: 'General', min: 0, max: 4, step: 1, category: 'shaders', target: 'usercfg',
    desc: 'General surface shader quality (0-3)',
    help: 'Controls the quality of general-purpose shaders used for most surfaces and objects. Affects overall material rendering complexity. This is a broad setting that impacts visual quality across the entire scene; lowering it can provide a noticeable FPS boost.' },
  q_ShaderPostProcess: { value: 3, label: 'Post Process', min: 0, max: 4, step: 1, category: 'shaders', target: 'usercfg',
    desc: 'Post-processing shader quality (0-3)',
    help: 'Controls the quality of post-processing effects such as tone mapping, color grading, and screen-space effects. Lower values use simplified post-processing passes. Moderate performance impact; lowering primarily affects visual polish rather than geometry detail.' },
  q_ShaderShadow: { value: 3, label: 'Shadow', min: 0, max: 4, step: 1, category: 'shaders', target: 'usercfg',
    desc: 'Shadow rendering shader quality (0-3)',
    help: 'Controls the complexity of shadow rendering shaders including filtering and soft shadow calculations. Lower values use simpler shadow techniques that render faster. Works in conjunction with sys_spec_Shadows for overall shadow quality.' },
  q_ShaderGlass: { value: 3, label: 'Glass', min: 0, max: 4, step: 1, category: 'shaders', target: 'usercfg',
    desc: 'Glass and transparency shader quality (0-3)',
    help: 'Controls the quality of glass and transparent surface rendering, including refraction, reflection, and multi-layer transparency. Visible on cockpit canopies, windows, and visor HUDs. Lower values simplify transparency calculations.' },
  q_ShaderParticle: { value: 3, label: 'Particle', min: 0, max: 4, step: 1, category: 'shaders', target: 'usercfg',
    desc: 'Particle effect shader quality (0-3)',
    help: 'Controls the shader complexity for particle effects. Unlike q_ShaderFX, this specifically affects how individual particles are rendered (lighting, soft edges, refraction). Not affected by the q_Quality master setting. Lower values can help in particle-heavy scenes.' },
  q_ShaderSky: { value: 3, label: 'Sky', min: 0, max: 4, step: 1, category: 'shaders', target: 'usercfg',
    desc: 'Sky and atmosphere shader quality (0-3)',
    help: 'Controls the quality of sky rendering, atmospheric scattering, and cloud shaders. Higher values produce more realistic planetary atmospheres and space skyboxes. Lower values simplify atmospheric calculations with minor visual differences in space.' },
  q_ShaderWater: { value: 3, label: 'Water', min: 0, max: 4, step: 1, category: 'shaders', target: 'usercfg',
    desc: 'Water surface shader quality (0-3)',
    help: 'Controls the shader complexity for water surfaces including wave simulation, caustics, and subsurface scattering. Works together with sys_spec_Water. Lower values use simplified water rendering that is less GPU-intensive near oceans and lakes.' },
  q_ShaderCompute: { value: 3, label: 'Compute', min: 0, max: 4, step: 1, category: 'shaders', target: 'usercfg',
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
  // HDR settings — attribute names verified directly from attributes.xml
  // (HDRMaxBrightness, HDRRefWhite). r_HDRDisplayOutput stays in USER.cfg as it
  // does not appear in attributes.xml — likely engine-only.
  r_HDRDisplayOutput: { value: 0, label: 'HDR Output (engine)', min: 0, max: 1, type: 'toggle', category: 'effects', target: 'usercfg',
    desc: 'Enable HDR display output',
    help: 'Enables High Dynamic Range output for HDR-capable monitors. Engine cvar only — does not appear in attributes.xml. The HDR brightness/white-level settings below are stored in attributes.xml and may control HDR independently.' },
  HDRMaxBrightness: { value: 1500, label: 'HDR Max Brightness (nits)', min: 400, max: 4000, step: 100, category: 'effects',
    target: 'attributes', attrName: 'HDRMaxBrightness',
    desc: 'Maximum HDR brightness in nits',
    help: 'Sets the maximum brightness for HDR output in nits. Match this to your monitor\'s peak HDR brightness (check your monitor specs). Too high causes clipping; too low wastes HDR range.' },
  HDRRefWhite: { value: 200, label: 'HDR Ref White (nits)', min: 80, max: 500, step: 10, category: 'effects',
    target: 'attributes', attrName: 'HDRRefWhite',
    desc: 'HDR reference white level in nits',
    help: 'Sets the reference white point for HDR content in nits. Controls the brightness of standard (non-highlight) content. 200 is a good starting point; increase if the image looks dim, decrease if it looks washed out.' },
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
  // Motion Blur — verified empirically: SC's UI exposes this as a Yes/No toggle
  // with default ON (1). The attribute is only serialised when the user turns it
  // off (=0). We use alwaysWrite so our preference (off) survives a fresh install
  // where SC would otherwise default it back on.
  r_MotionBlur: { value: 1, label: 'Motion Blur', min: 0, max: 1, type: 'toggle', category: 'clarity',
    target: 'attributes', attrName: 'MotionBlur', alwaysWrite: true,
    desc: 'Blur during fast camera/object movement (default: on)',
    help: 'Adds blur when the camera or objects move quickly. SC enables this by default; many players turn it off for clearer fast-motion visibility.' },
  r_Sharpening: { value: 1, label: 'Sharpening', min: 0, max: 1, step: 0.05, category: 'clarity',
    target: 'attributes', attrName: 'Sharpening',
    desc: 'Post-process image sharpening (0.0-1.0)',
    help: 'Applies a post-processing sharpening filter to the final image. Higher values make edges and textures look crisper, but too much can cause shimmering and make jagged edges more visible. Values around 0.2-0.5 balance clarity with smoothness. Negligible performance cost.' },
  r_OpticsBloom: { value: 1, label: 'Bloom', min: 0, max: 1, type: 'toggle', category: 'clarity', target: 'usercfg',
    desc: 'Glow effect around bright light sources',
    help: 'Adds a soft glow around bright light sources like stars, engines, and explosions. Creates a more realistic lighting look but can reduce contrast. Disable for a cleaner, sharper image. Very low performance impact.' },
  // Chromatic Aberration — verified empirically: SC's UI is a 0–100 slider that
  // maps linearly to 0.0–1.0 in attributes.xml (e.g. slider 50 → 0.5). The
  // previous range of 0–100 was wrong.
  r_ChromaticAberration: { value: 0, label: 'Chromatic Aberration', min: 0.0, max: 1.0, step: 0.01, category: 'clarity',
    target: 'attributes', attrName: 'ChromaticAberration',
    desc: 'Lens colour-fringing intensity (0=off, 1=max)',
    help: 'Simulates the colour fringing that occurs in real camera lenses, splitting colours at screen edges. A purely cinematic effect that many players find distracting. Set to 0 for the cleanest image.' },
  // Film Grain — verified empirically: SC default is ON (1); attribute is only
  // serialised when the user turns it off. alwaysWrite so our preference sticks
  // through fresh installs.
  r_filmgrain: { value: 1, label: 'Film Grain', min: 0, max: 1, type: 'toggle', category: 'clarity',
    target: 'attributes', attrName: 'FilmGrain', alwaysWrite: true,
    desc: 'Film-grain noise overlay (default: on)',
    help: 'Adds a subtle film-grain noise overlay to the image for a cinematic look. Many players disable this for a cleaner, sharper image.' },
  r_vignetteBlur: { value: 1, label: 'Vignette Blur', min: 0, max: 1, type: 'toggle', category: 'clarity', target: 'usercfg',
    desc: 'Screen edge darkening/blur effect',
    help: 'Darkens and slightly blurs the edges of the screen, mimicking a real camera lens vignette. Disable for a cleaner, more uniform image. No performance impact; purely a visual preference.' },
  // Gamma / Brightness / Contrast — verified empirically by changing each
  // slider in SC and reading attributes.xml. Gamma's storage range (0.5–1.5)
  // differs from Brightness and Contrast (0.0–1.0). SC's UI shows all three as
  // 0–100 sliders; the values stored in attributes.xml are linearly scaled.
  r_Gamma: { value: 1.0, label: 'Gamma', min: 0.5, max: 1.5, step: 0.01, category: 'clarity',
    target: 'attributes', attrName: 'Gamma',
    desc: 'Display gamma correction (0.5=darkest, 1.5=brightest)',
    help: 'Adjusts the brightness curve of the display. Higher values brighten dark areas, lower values darken them. SC\'s in-game slider 0–100 maps linearly to 0.5–1.5 in attributes.xml; default 1.0 corresponds to slider 50.' },
  Brightness: { value: 0.5, label: 'Brightness', min: 0.0, max: 1.0, step: 0.01, category: 'clarity',
    target: 'attributes', attrName: 'Brightness',
    desc: 'Overall display brightness (0=darkest, 1=brightest)',
    help: 'Adjusts overall display brightness. SC\'s in-game slider 0–100 maps directly to 0.0–1.0 in attributes.xml; default 0.5 corresponds to slider 50.' },
  r_Contrast: { value: 0.5, label: 'Contrast', min: 0.0, max: 1.0, step: 0.01, category: 'clarity',
    target: 'attributes', attrName: 'Contrast',
    desc: 'Display contrast adjustment (0=flat, 1=high)',
    help: 'Adjusts the contrast between light and dark areas. SC\'s in-game slider 0–100 maps directly to 0.0–1.0 in attributes.xml; default 0.5 corresponds to slider 50.' },
  FOV: { value: 67.6727, label: 'Field of View', min: 30, max: 120, step: 1, category: 'clarity',
    target: 'attributes', attrName: 'FOV',
    desc: 'First-person field of view in degrees',
    help: 'Controls the first-person camera field of view in degrees. Higher values show more of the scene at once but distort objects at the edges. SC defaults to ~67.67. Most players use 70–100 depending on monitor size and personal preference.' },
  AspectModifier: { value: 0, label: 'Visor / Lens Aspect Modifier', min: -1.0, max: 1.0, step: 0.05, category: 'clarity',
    target: 'attributes', attrName: 'AspectModifier',
    desc: 'Adjusts visor and lens aspect ratio',
    help: 'Subtle aspect-ratio adjustment for the visor and lens overlay. Default is 0 (no modification). Use only if you notice stretching of the helmet visor or other lens elements.' },
  // ── Audio ── all target: 'attributes'
  AudioMasterVolume: { value: 1.0, label: 'Master Volume', min: 0.0, max: 1.0, step: 0.05, category: 'audio',
    target: 'attributes', attrName: 'AudioMasterVolume',
    desc: 'Overall master audio volume',
    help: 'Master volume for all in-game audio. 0 = silent, 1 = full volume.' },
  AudioMusicVolume: { value: 0.0, label: 'Music Volume', min: 0.0, max: 1.0, step: 0.05, category: 'audio',
    target: 'attributes', attrName: 'AudioMusicVolume',
    desc: 'Background music volume',
    help: 'Volume for in-game music tracks. 0 disables music entirely.' },
  AudioSfxVolume: { value: 1.0, label: 'SFX Volume', min: 0.0, max: 1.0, step: 0.05, category: 'audio',
    target: 'attributes', attrName: 'AudioSfxVolume',
    desc: 'Sound effects volume',
    help: 'Volume for sound effects (weapons, engines, environment).' },
  AudioSpeechVolume: { value: 1.0, label: 'Speech Volume', min: 0.0, max: 1.0, step: 0.05, category: 'audio',
    target: 'attributes', attrName: 'AudioSpeechVolume',
    desc: 'Character / NPC speech volume',
    help: 'Volume for spoken dialog from NPCs and characters.' },
  AudioShipComputerSpeechVolume: { value: 1.0, label: 'Ship Computer Voice Volume', min: 0.0, max: 1.0, step: 0.05, category: 'audio',
    target: 'attributes', attrName: 'AudioShipComputerSpeechVolume',
    desc: 'Ship computer voice line volume',
    help: 'Volume for ship-AI / computer voice announcements (e.g. quantum spool warnings).' },
  AudioSimulationAnnouncerVolume: { value: 1.0, label: 'Announcer Volume', min: 0.0, max: 1.0, step: 0.05, category: 'audio',
    target: 'attributes', attrName: 'AudioSimulationAnnouncerVolume',
    desc: 'Arena Commander announcer volume',
    help: 'Volume for the Arena Commander / Star Marine match announcer.' },
  VideoVolume: { value: 1.0, label: 'Video Volume', min: 0.0, max: 1.0, step: 0.05, category: 'audio',
    target: 'attributes', attrName: 'VideoVolume',
    desc: 'In-game video playback volume',
    help: 'Volume for cut-scene videos and in-game video screens.' },
  // ── Combat & HUD ── all target: 'attributes'
  // Mirror SC's in-game Game/Controls UI tweaks: ESP, crosshair, aim-sensitivity,
  // ship feedback (G-force, shake), flight-decoupled sensitivity, salvage, weapon.
  ADSMouseSensitivity: { value: 1.0, label: 'ADS Mouse Sensitivity', min: 0.1, max: 3.0, step: 0.05, category: 'combat',
    target: 'attributes', attrName: 'ADSMouseSensitivity',
    desc: 'Mouse sensitivity multiplier when aiming down sight',
    help: 'Multiplier applied to mouse sensitivity while aiming down sight. 1.0 keeps the same speed as hipfire; lower values slow it down for more precise aim.' },
  AutoZoomOnSelectedTargetStrength: { value: 1.0, label: 'Auto-Zoom on Target', min: 0.0, max: 2.0, step: 0.05, category: 'combat',
    target: 'attributes', attrName: 'AutoZoomOnSelectedTargetStrength',
    desc: 'Strength of automatic zoom on selected target',
    help: 'Controls how strongly the camera auto-zooms onto a selected target. 0 disables it, higher values zoom more aggressively.' },
  CrosshairOpacity: { value: 1.0, label: 'Crosshair Opacity', min: 0.0, max: 1.0, step: 0.05, category: 'combat',
    target: 'attributes', attrName: 'CrosshairOpacity',
    desc: 'Crosshair transparency',
    help: 'Opacity of the on-screen crosshair. 0 hides the crosshair entirely, 1 is fully opaque.' },
  PilotEspStrength: { value: 1.0, label: 'Pilot ESP Strength', min: 0.0, max: 2.0, step: 0.05, category: 'combat',
    target: 'attributes', attrName: 'PilotEspStrength',
    desc: 'Pilot ESP (predictive aim) strength',
    help: 'Strength of the pilot Enhanced Stick Precision lead/aim assist. 0 disables it; higher values increase the assist effect.' },
  PilotEspDampening: { value: 1.0, label: 'Pilot ESP Dampening', min: 0.0, max: 2.0, step: 0.05, category: 'combat',
    target: 'attributes', attrName: 'PilotEspDampening',
    desc: 'How smoothly Pilot ESP applies',
    help: 'Smoothing factor for pilot ESP — higher values produce more gradual aim assist.' },
  TurretsEspStrength: { value: 1.0, label: 'Turret ESP Strength', min: 0.0, max: 2.0, step: 0.05, category: 'combat',
    target: 'attributes', attrName: 'TurretsEspStrength',
    desc: 'Turret ESP (predictive aim) strength',
    help: 'Strength of the turret ESP lead/aim assist. 0 disables it.' },
  TurretsEspDampening: { value: 1.0, label: 'Turret ESP Dampening', min: 0.0, max: 2.0, step: 0.05, category: 'combat',
    target: 'attributes', attrName: 'TurretsEspDampening',
    desc: 'How smoothly Turret ESP applies',
    help: 'Smoothing factor for turret ESP.' },
  FlightCoreDisabledSensitivityRotation: { value: 2.0, label: 'Decoupled Rotation Sensitivity', min: 0.1, max: 5.0, step: 0.1, category: 'combat',
    target: 'attributes', attrName: 'FlightCoreDisabledSensitivityRotation',
    desc: 'Rotation sensitivity when Flight Core is decoupled',
    help: 'Sensitivity multiplier for rotation inputs when Flight Core is in decoupled mode.' },
  FlightCoreDisabledSensitivityTranslation: { value: 2.0, label: 'Decoupled Translation Sensitivity', min: 0.1, max: 5.0, step: 0.1, category: 'combat',
    target: 'attributes', attrName: 'FlightCoreDisabledSensitivityTranslation',
    desc: 'Translation sensitivity when Flight Core is decoupled',
    help: 'Sensitivity multiplier for translation/strafe inputs when Flight Core is in decoupled mode.' },
  GForceBoostZoomScale: { value: 1.0, label: 'G-Force Boost Zoom', min: 0.0, max: 2.0, step: 0.05, category: 'combat',
    target: 'attributes', attrName: 'GForceBoostZoomScale',
    desc: 'How much the camera zooms during boost',
    help: 'Scales the boost-induced camera zoom. 0 disables the effect, 1 is the default.' },
  GForceHeadBobScale: { value: 1.0, label: 'G-Force Head Bob', min: 0.0, max: 2.0, step: 0.05, category: 'combat',
    target: 'attributes', attrName: 'GForceHeadBobScale',
    desc: 'Strength of head bob from G-forces',
    help: 'Multiplier for the head-bobbing effect caused by G-forces. 0 disables head bob, 1 is the default.' },
  SalvageAimNudgeSensitivity: { value: 1.0, label: 'Salvage Aim Nudge', min: 0.0, max: 2.0, step: 0.05, category: 'combat',
    target: 'attributes', attrName: 'SalvageAimNudgeSensitivity',
    desc: 'Sensitivity of salvage tool aim nudging',
    help: 'Sensitivity for fine-aim adjustments when using the salvage tool.' },
  SpeedThrottleDefaultFixedSpeed: { value: 5.58, label: 'Default Throttle Speed (m/s)', min: 0.0, max: 100.0, step: 0.1, category: 'combat',
    target: 'attributes', attrName: 'SpeedThrottleDefaultFixedSpeed',
    desc: 'Default fixed-speed throttle target',
    help: 'Default target speed (m/s) when using fixed-speed throttle mode.' },
  Weapon_Setting_FallbackConvergenceDistance: { value: 1500, label: 'Fallback Convergence Distance (m)', min: 100, max: 5000, step: 100, category: 'combat',
    target: 'attributes', attrName: 'Weapon_Setting_FallbackConvergenceDistance',
    desc: 'Default weapon convergence distance',
    help: 'Distance (in meters) at which weapons converge when no target lock is active.' },
  // ── Camera Lead ── all target: 'attributes'
  // 16 LookAheadStrength* attributes — each scales camera lead-ahead for a specific
  // input/scenario. SC exposes some of these in the Game / Controls UI; advanced users
  // may want to tweak them all individually.
  LookAheadStrengthForward: { value: 1.0, label: 'Look Ahead — Forward', min: 0.0, max: 2.0, step: 0.05, category: 'cameralead',
    target: 'attributes', attrName: 'LookAheadStrengthForward', desc: 'Forward look-ahead strength', help: 'Camera lead-ahead strength for forward motion.' },
  LookAheadStrengthRoll: { value: 1.0, label: 'Look Ahead — Roll', min: 0.0, max: 2.0, step: 0.05, category: 'cameralead',
    target: 'attributes', attrName: 'LookAheadStrengthRoll', desc: 'Roll look-ahead strength', help: 'Camera lead-ahead strength when rolling.' },
  LookAheadStrengthYawPitch: { value: 1.0, label: 'Look Ahead — Yaw / Pitch', min: 0.0, max: 2.0, step: 0.05, category: 'cameralead',
    target: 'attributes', attrName: 'LookAheadStrengthYawPitch', desc: 'Yaw/pitch look-ahead strength', help: 'Camera lead-ahead strength for yaw and pitch.' },
  LookAheadStrengthHorizonAlignment: { value: 1.0, label: 'Look Ahead — Horizon Align', min: 0.0, max: 2.0, step: 0.05, category: 'cameralead',
    target: 'attributes', attrName: 'LookAheadStrengthHorizonAlignment', desc: 'Horizon-alignment look-ahead', help: 'Camera lead-ahead strength when aligning to the horizon.' },
  LookAheadStrengthHorizonLookAt: { value: 1.0, label: 'Look Ahead — Horizon Look-At', min: 0.0, max: 2.0, step: 0.05, category: 'cameralead',
    target: 'attributes', attrName: 'LookAheadStrengthHorizonLookAt', desc: 'Horizon look-at strength', help: 'Camera lead-ahead strength when looking at the horizon.' },
  LookAheadStrengthVelocityVector: { value: 1.0, label: 'Look Ahead — Velocity Vector', min: 0.0, max: 2.0, step: 0.05, category: 'cameralead',
    target: 'attributes', attrName: 'LookAheadStrengthVelocityVector', desc: 'Velocity-vector look-ahead', help: 'Camera lead-ahead strength toward the current velocity vector.' },
  LookAheadStrengthQuantumBoostTarget: { value: 1.0, label: 'Look Ahead — Quantum Target', min: 0.0, max: 2.0, step: 0.05, category: 'cameralead',
    target: 'attributes', attrName: 'LookAheadStrengthQuantumBoostTarget', desc: 'Quantum boost target look-ahead', help: 'Camera lead-ahead toward a quantum target during quantum travel.' },
  LookAheadStrengthJumpPointSpline: { value: 1.0, label: 'Look Ahead — Jump Point', min: 0.0, max: 2.0, step: 0.05, category: 'cameralead',
    target: 'attributes', attrName: 'LookAheadStrengthJumpPointSpline', desc: 'Jump-point spline look-ahead', help: 'Camera lead-ahead along the jump-point spline during jumps.' },
  LookAheadStrengthTargetSoft: { value: 1.0, label: 'Look Ahead — Soft Target', min: 0.0, max: 2.0, step: 0.05, category: 'cameralead',
    target: 'attributes', attrName: 'LookAheadStrengthTargetSoft', desc: 'Soft-target look-ahead', help: 'Camera lead-ahead when softly tracking a target.' },
  LookAheadStrengthVJoy: { value: 1.0, label: 'Look Ahead — Virtual Joystick', min: 0.0, max: 2.0, step: 0.05, category: 'cameralead',
    target: 'attributes', attrName: 'LookAheadStrengthVJoy', desc: 'Virtual joystick look-ahead', help: 'Camera lead-ahead when using a virtual joystick.' },
  LookAheadStrengthMgvVJoy: { value: 1.0, label: 'Look Ahead — MGV VJoy', min: 0.0, max: 2.0, step: 0.05, category: 'cameralead',
    target: 'attributes', attrName: 'LookAheadStrengthMgvVJoy', desc: 'Ground vehicle VJoy look-ahead', help: 'Camera lead-ahead for ground vehicles using a virtual joystick.' },
  LookAheadStrengthMgvForward: { value: 1.0, label: 'Look Ahead — MGV Forward', min: 0.0, max: 2.0, step: 0.05, category: 'cameralead',
    target: 'attributes', attrName: 'LookAheadStrengthMgvForward', desc: 'Ground vehicle forward look-ahead', help: 'Camera lead-ahead for ground vehicles moving forward.' },
  LookAheadStrengthMgvHorizonAlignment: { value: 1.0, label: 'Look Ahead — MGV Horizon Align', min: 0.0, max: 2.0, step: 0.05, category: 'cameralead',
    target: 'attributes', attrName: 'LookAheadStrengthMgvHorizonAlignment', desc: 'Ground vehicle horizon-align look-ahead', help: 'Camera lead-ahead for ground vehicles when aligning to the horizon.' },
  LookAheadStrengthMgvPitchYaw: { value: 1.0, label: 'Look Ahead — MGV Pitch / Yaw', min: 0.0, max: 2.0, step: 0.05, category: 'cameralead',
    target: 'attributes', attrName: 'LookAheadStrengthMgvPitchYaw', desc: 'Ground vehicle pitch/yaw look-ahead', help: 'Camera lead-ahead for ground vehicles for pitch and yaw.' },
  LookAheadStrengthTurretForward: { value: 1.0, label: 'Look Ahead — Turret Forward', min: 0.0, max: 2.0, step: 0.05, category: 'cameralead',
    target: 'attributes', attrName: 'LookAheadStrengthTurretForward', desc: 'Turret forward look-ahead', help: 'Camera lead-ahead when controlling a turret moving forward.' },
  LookAheadStrengthTurretPitchYaw: { value: 1.0, label: 'Look Ahead — Turret Pitch / Yaw', min: 0.0, max: 2.0, step: 0.05, category: 'cameralead',
    target: 'attributes', attrName: 'LookAheadStrengthTurretPitchYaw', desc: 'Turret pitch/yaw look-ahead', help: 'Camera lead-ahead for turret pitch and yaw.' },
  LookAheadStrengthTurretVJoy: { value: 1.0, label: 'Look Ahead — Turret VJoy', min: 0.0, max: 2.0, step: 0.05, category: 'cameralead',
    target: 'attributes', attrName: 'LookAheadStrengthTurretVJoy', desc: 'Turret VJoy look-ahead', help: 'Camera lead-ahead for turrets using a virtual joystick.' },
  // ── Tracking (HMD/VR/Eye-Tracking/Faceware) ── all target: 'attributes'
  // Hardware-specific settings, only meaningful if you have the corresponding peripherals.
  HmdVisorEnabled: { value: 1, label: 'HMD Visor', min: 0, max: 1, type: 'toggle', category: 'tracking',
    target: 'attributes', attrName: 'HmdVisorEnabled',
    desc: 'Show the HMD visor overlay',
    help: 'Enables the head-mounted display visor overlay (only relevant when an HMD is connected).' },
  HmdCursorFollowsHead: { value: 0, label: 'HMD Cursor Follows Head', min: 0, max: 1, type: 'toggle', category: 'tracking',
    target: 'attributes', attrName: 'HmdCursorFollowsHead',
    desc: 'Cursor moves with head tracking',
    help: 'When enabled, the cursor follows head movements (HMD only).' },
  HmdCursorSensitivity: { value: 2.0, label: 'HMD Cursor Sensitivity', min: 0.1, max: 5.0, step: 0.1, category: 'tracking',
    target: 'attributes', attrName: 'HmdCursorSensitivity',
    desc: 'HMD cursor movement sensitivity',
    help: 'Sensitivity multiplier for cursor movement when controlled via the HMD.' },
  HmdCursorSize: { value: 1.0, label: 'HMD Cursor Size', min: 0.1, max: 3.0, step: 0.05, category: 'tracking',
    target: 'attributes', attrName: 'HmdCursorSize',
    desc: 'Size of the HMD cursor',
    help: 'Visual size multiplier for the HMD cursor.' },
  HmdCursorUseEyeTracking: { value: 0, label: 'HMD Cursor Eye-Tracking', min: 0, max: 1, type: 'toggle', category: 'tracking',
    target: 'attributes', attrName: 'HmdCursorUseEyeTracking',
    desc: 'Use eye tracking for HMD cursor',
    help: 'When enabled, the HMD cursor follows your eye gaze instead of head movement.' },
  EnableFacewareSystemLive: { value: 0, label: 'Faceware System Live', min: 0, max: 1, type: 'toggle', category: 'tracking',
    target: 'attributes', attrName: 'EnableFacewareSystemLive',
    desc: 'Enable Faceware face-tracking integration',
    help: 'Enables the Faceware Live face-tracking integration. Requires the Faceware Live software and a compatible camera.' },
  HeadTrackingFacewarePitchMultiplier: { value: 8.0, label: 'Faceware Pitch Multiplier', min: 0.0, max: 20.0, step: 0.5, category: 'tracking',
    target: 'attributes', attrName: 'HeadTrackingFacewarePitchMultiplier',
    desc: 'Faceware pitch sensitivity multiplier',
    help: 'How strongly Faceware pitch movements are mapped to in-game head pitch.' },
  HeadTrackingFacewareYawMultiplier: { value: 8.0, label: 'Faceware Yaw Multiplier', min: 0.0, max: 20.0, step: 0.5, category: 'tracking',
    target: 'attributes', attrName: 'HeadTrackingFacewareYawMultiplier',
    desc: 'Faceware yaw sensitivity multiplier',
    help: 'How strongly Faceware yaw movements are mapped to in-game head yaw.' },
  HeadTrackingFaceWareDeadzoneRotationPitch: { value: 10.0, label: 'Faceware Pitch Deadzone', min: 0.0, max: 45.0, step: 1.0, category: 'tracking',
    target: 'attributes', attrName: 'HeadTrackingFaceWareDeadzoneRotationPitch',
    desc: 'Faceware pitch deadzone (degrees)',
    help: 'Deadzone in degrees before pitch movement is registered.' },
  HeadTrackingFaceWareDeadzoneRotationYaw: { value: 10.0, label: 'Faceware Yaw Deadzone', min: 0.0, max: 45.0, step: 1.0, category: 'tracking',
    target: 'attributes', attrName: 'HeadTrackingFaceWareDeadzoneRotationYaw',
    desc: 'Faceware yaw deadzone (degrees)',
    help: 'Deadzone in degrees before yaw movement is registered.' },
  HeadTrackingFaceWareDeadzoneRotationRoll: { value: 2.0, label: 'Faceware Roll Deadzone', min: 0.0, max: 45.0, step: 0.5, category: 'tracking',
    target: 'attributes', attrName: 'HeadTrackingFaceWareDeadzoneRotationRoll',
    desc: 'Faceware roll deadzone (degrees)',
    help: 'Deadzone in degrees before roll movement is registered.' },
  HeadtrackingGlobalSmoothingPosition: { value: 0.0, label: 'Head Tracking — Position Smoothing', min: 0.0, max: 1.0, step: 0.05, category: 'tracking',
    target: 'attributes', attrName: 'HeadtrackingGlobalSmoothingPosition',
    desc: 'Smoothing for head-tracking position',
    help: 'Global smoothing factor applied to head-tracking position. Higher values reduce jitter at the cost of input lag.' },
  HeadtrackingGlobalSmoothingRotation: { value: 0.0, label: 'Head Tracking — Rotation Smoothing', min: 0.0, max: 1.0, step: 0.05, category: 'tracking',
    target: 'attributes', attrName: 'HeadtrackingGlobalSmoothingRotation',
    desc: 'Smoothing for head-tracking rotation',
    help: 'Global smoothing factor applied to head-tracking rotation.' },
  HeadtrackingInactivityTime: { value: 2.0, label: 'Head Tracking — Inactivity Timeout', min: 0.0, max: 30.0, step: 0.5, category: 'tracking',
    target: 'attributes', attrName: 'HeadtrackingInactivityTime',
    desc: 'Seconds of inactivity before head tracking re-centres',
    help: 'Time in seconds without input before head tracking automatically recentres.' },
  TobiiHeadPositionScale: { value: 1.0, label: 'Tobii Head Position Scale', min: 0.0, max: 5.0, step: 0.1, category: 'tracking',
    target: 'attributes', attrName: 'TobiiHeadPositionScale',
    desc: 'Tobii head-position scale multiplier',
    help: 'Scales head position translation as reported by Tobii eye-tracker.' },
  TobiiHeadSensitivityPitch_Profile0: { value: 2.0, label: 'Tobii Pitch (Profile 0)', min: 0.0, max: 10.0, step: 0.1, category: 'tracking',
    target: 'attributes', attrName: 'TobiiHeadSensitivityPitch_Profile0',
    desc: 'Tobii pitch sensitivity (profile 0)',
    help: 'Pitch sensitivity for Tobii eye-tracking, profile 0.' },
  TobiiHeadSensitivityPitch_Profile1: { value: 2.0, label: 'Tobii Pitch (Profile 1)', min: 0.0, max: 10.0, step: 0.1, category: 'tracking',
    target: 'attributes', attrName: 'TobiiHeadSensitivityPitch_Profile1',
    desc: 'Tobii pitch sensitivity (profile 1)',
    help: 'Pitch sensitivity for Tobii eye-tracking, profile 1.' },
  TobiiHeadSensitivityYaw_Profile0: { value: 2.0, label: 'Tobii Yaw (Profile 0)', min: 0.0, max: 10.0, step: 0.1, category: 'tracking',
    target: 'attributes', attrName: 'TobiiHeadSensitivityYaw_Profile0',
    desc: 'Tobii yaw sensitivity (profile 0)',
    help: 'Yaw sensitivity for Tobii eye-tracking, profile 0.' },
  TobiiHeadSensitivityYaw_Profile1: { value: 2.0, label: 'Tobii Yaw (Profile 1)', min: 0.0, max: 10.0, step: 0.1, category: 'tracking',
    target: 'attributes', attrName: 'TobiiHeadSensitivityYaw_Profile1',
    desc: 'Tobii yaw sensitivity (profile 1)',
    help: 'Yaw sensitivity for Tobii eye-tracking, profile 1.' },
  TobiiHeadSensitivityRoll_Profile0: { value: 1.0, label: 'Tobii Roll (Profile 0)', min: 0.0, max: 10.0, step: 0.1, category: 'tracking',
    target: 'attributes', attrName: 'TobiiHeadSensitivityRoll_Profile0',
    desc: 'Tobii roll sensitivity (profile 0)',
    help: 'Roll sensitivity for Tobii eye-tracking, profile 0.' },
  TobiiHeadSensitivityRoll_Profile1: { value: 1.0, label: 'Tobii Roll (Profile 1)', min: 0.0, max: 10.0, step: 0.1, category: 'tracking',
    target: 'attributes', attrName: 'TobiiHeadSensitivityRoll_Profile1',
    desc: 'Tobii roll sensitivity (profile 1)',
    help: 'Roll sensitivity for Tobii eye-tracking, profile 1.' },
  // Text input timing — found in attributes.xml; lives logically in the input category
  TextInputRepeatDelay: { value: 1.0, label: 'Text Input Repeat Delay', min: 0.1, max: 5.0, step: 0.1, category: 'input',
    target: 'attributes', attrName: 'TextInputRepeatDelay',
    desc: 'Delay before key repeat starts (seconds)',
    help: 'Time in seconds a key must be held before it starts repeating in chat / text fields.' },
  TextInputRepeatRate: { value: 25, label: 'Text Input Repeat Rate', min: 1, max: 100, step: 1, category: 'input',
    target: 'attributes', attrName: 'TextInputRepeatRate',
    desc: 'Key repeat rate (chars/sec)',
    help: 'How many characters per second a held key produces in chat / text fields.' },
  // View Distance (verified) -- all target: 'usercfg'
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
  // Input -- all target: 'usercfg'
  i_Mouse_Accel: { value: 0, label: 'Mouse Acceleration', min: 0, max: 1, step: 0.1, category: 'input', target: 'usercfg',
    desc: 'Mouse movement acceleration (0=off)',
    help: 'Adds acceleration to mouse movement, making faster mouse motions move the cursor proportionally further. Most players prefer 0 (off) for consistent, predictable aiming. Enable only if you prefer acceleration-style mouse behavior.' },
  i_Mouse_Smooth: { value: 0, label: 'Mouse Smoothing', min: 0, max: 1, step: 0.1, category: 'input', target: 'usercfg',
    desc: 'Mouse input smoothing (0=off)',
    help: 'Smooths out mouse input by averaging recent movements, reducing jitter but adding slight input lag. Most players prefer 0 (off) for the most responsive, direct mouse input. Higher values make mouse movement feel floaty.' },
  // Advanced (unverified - may have no effect) -- all target: 'usercfg'
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
  sys_spec_Light: { value: 3, label: 'Lighting', min: 1, max: 5, step: 1, category: 'advanced', target: 'usercfg', overrideWarning: true,
    desc: 'Dynamic lighting quality (1=Low, 4=Very High)',
    help: 'Controls the quality of dynamic lighting including light count, shadow-casting lights, and illumination calculations. Higher values allow more dynamic lights with better accuracy. Lowering can help FPS in scenes with many light sources like station interiors.' },
  sys_spec_PostProcessing: { value: 3, label: 'Post Processing', min: 1, max: 5, step: 1, category: 'advanced', target: 'usercfg', overrideWarning: true,
    desc: 'Post-processing effects quality (1-4)',
    help: 'Controls the quality of screen-space post-processing effects like color grading, tone mapping, and lens effects. Higher values use more complex post-processing passes. Moderate GPU impact; lowering affects visual polish but not geometry or texture detail.' },
  sys_spec_TextureResolution: { value: 3, label: 'Texture Resolution', min: 1, max: 5, step: 1, category: 'advanced', target: 'usercfg', overrideWarning: true,
    desc: 'Texture resolution multiplier (1-4)',
    help: 'Controls the maximum texture resolution scale. Higher values load larger texture mipmaps, producing sharper surfaces at the cost of more VRAM. Lower values force smaller mipmaps, reducing VRAM usage but making surfaces blurrier. Depends heavily on available VRAM.' },
  sys_spec_VolumetricEffects: { value: 3, label: 'Volumetric Effects', min: 1, max: 5, step: 1, category: 'advanced', target: 'usercfg', overrideWarning: true,
    desc: 'Volumetric fog, clouds, and light shafts (1-4)',
    help: 'Controls the quality of volumetric rendering including fog, god rays, cloud density, and atmospheric haze. Higher values produce more detailed volumetrics but are GPU-intensive. Lowering this can help FPS significantly in atmospheric environments and nebulae.' },
  sys_spec_Sound: { value: 3, label: 'Sound', min: 1, max: 5, step: 1, category: 'advanced', target: 'usercfg', overrideWarning: true,
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
  OverscanBorderX: { value: 0, label: 'Overscan Border X', min: 0, max: 0.2, step: 0.01, category: 'advanced',
    target: 'attributes', attrName: 'OverscanBorderX',
    desc: 'Horizontal overscan crop',
    help: 'Crops the image horizontally by the given fraction of the screen. Useful on TVs that overscan the image. Default 0 = no crop.' },
  OverscanBorderY: { value: 0, label: 'Overscan Border Y', min: 0, max: 0.2, step: 0.01, category: 'advanced',
    target: 'attributes', attrName: 'OverscanBorderY',
    desc: 'Vertical overscan crop',
    help: 'Crops the image vertically by the given fraction of the screen. Useful on TVs that overscan the image. Default 0 = no crop.' },
  ShakeScale: { value: 1, label: 'Camera Shake Scale', min: 0, max: 2, step: 0.05, category: 'advanced',
    target: 'attributes', attrName: 'ShakeScale',
    desc: 'Camera shake intensity multiplier',
    help: 'Multiplier for camera shake effects (impacts, explosions, turbulence). 0 disables shake entirely; 1 is the default; values > 1 amplify it. Useful for motion-sickness-sensitive players.' },
};

/** CVar keys that should display quality level labels (1-4) */
export const QUALITY_KEYS = new Set([
  // Master + USER.cfg cvars (kept for engine-only fine-tuning settings)
  'sys_spec', 'sys_spec_GameEffects', 'sys_spec_ObjectDetail', 'sys_spec_Particles',
  'sys_spec_Physics', 'sys_spec_Shading', 'sys_spec_Shadows', 'sys_spec_Texture',
  'sys_spec_Water', 'sys_spec_Light', 'sys_spec_PostProcessing',
  'sys_spec_TextureResolution', 'sys_spec_VolumetricEffects', 'sys_spec_Sound',
  // attributes.xml-routed settings added during the unified-routing migration
  'SysSpec_ObjectViewDistance', 'SysSpec_TextureDetail', 'SysSpec_TextureGround',
  'SysSpec_TextureFiltering', 'SysSpec_ShadowScreenSpace',
  'SysSpec_PlanetVolumetricClouds', 'SysSpec_GasCloud', 'SysSpec_Fog',
  'SysSpec_WaterCaustics', 'SysSpec_PostProcessingAttr', 'SysSpec_VideoComms',
]);

/** CVar keys that should display shader level labels (0-3) */
export const SHADER_KEYS = new Set(['q_ShaderFX', 'q_ShaderGeneral', 'q_ShaderPostProcess', 'q_ShaderShadow', 'q_ShaderGlass', 'q_ShaderParticle', 'q_ShaderSky', 'q_ShaderWater', 'q_ShaderCompute', 'q_Quality', 'q_Renderer']);

/** Predefined resolution presets for the resolution dropdown */
export const RESOLUTION_PRESETS = [
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

/** Mapping of old/removed CVar names to their successors (for migration) */
export const LEGACY_CVAR_MAP = {
  sys_spec_Quality: 'sys_spec',
};

/** Standard SC versions that are always shown in the selector (even if not installed) */
export const STANDARD_VERSIONS = ['LIVE', 'PTU', 'EPTU', 'TECH-PREVIEW', 'HOTFIX'];

// ==================== Helper Functions ====================

/** Display labels for graphics quality levels (1-5). Index 0 unused; SC's UI exposes Low → Ultra. */
export function getQualityLevels() {
  return [
    '',
    t('environments:cfg.quality.low'),
    t('environments:cfg.quality.medium'),
    t('environments:cfg.quality.high'),
    t('environments:cfg.quality.veryHigh'),
    t('environments:cfg.quality.ultra', { defaultValue: 'Ultra' }),
  ];
}

/** Display labels for shader quality levels (0-4). Same Low → Ultra scale as quality but zero-indexed. */
export function getShaderLevels() {
  return [
    t('environments:cfg.quality.low'),
    t('environments:cfg.quality.medium'),
    t('environments:cfg.quality.high'),
    t('environments:cfg.quality.veryHigh'),
    t('environments:cfg.quality.ultra', { defaultValue: 'Ultra' }),
  ];
}

/**
 * Returns translated labels for CVar settings that use dropdown labels.
 * Called at render time so t() resolves to the current language.
 */
export function getSettingLabels(key) {
  const map = {
    '_windowMode': () => [t('environments:cfg.windowMode.windowed'), t('environments:cfg.windowMode.borderless'), t('environments:cfg.windowMode.fullscreen')],
    'r.graphicsRenderer': () => [t('environments:cfg.renderer.vulkan'), t('environments:cfg.renderer.dx11')],
    'r_ssdo': () => [t('environments:cfg.ssdo.off'), t('environments:cfg.ssdo.fast'), t('environments:cfg.ssdo.optimized'), t('environments:cfg.ssdo.reference')],
    // r_MotionBlur is now a Yes/No toggle — labels not used for toggles
  };
  return map[key]?.() || null;
}

// ==================== Data Loading ====================

/**
 * Converts an attributes.xml string value to the frontend number type.
 * attributes.xml stores everything as strings; our settings use numbers.
 */
export function convertAttrValue(key, attrStringValue) {
  if (attrStringValue === undefined || attrStringValue === null) return undefined;
  const num = parseFloat(attrStringValue);
  return isNaN(num) ? attrStringValue : num;
}

/**
 * Converts a frontend value to an attributes.xml string.
 */
export function convertToAttrValue(_key, value) {
  return String(value);
}

/**
 * Reads the USER.cfg file and parses the settings into userCfgSettings.
 * Also stores a snapshot for external change detection.
 */
export async function loadUserCfgSettings() {
  const s = getState();
  if (!s.config?.install_path || !s.activeScVersion) {
    setState({ userCfgSettings: {} });
    return;
  }
  try {
    // Read both sources in parallel
    const [cfgContent, attrsMap, attrsHash] = await Promise.all([
      invoke('read_user_cfg', { gp: s.config.install_path, v: s.activeScVersion }),
      invoke('read_attributes_map', { gp: s.config.install_path, v: s.activeScVersion }),
      invoke('get_attributes_hash', { gp: s.config.install_path, v: s.activeScVersion }),
    ]);

    // 1. Parse USER.cfg for all settings (existing behavior)
    const userCfgSettings = parseUserCfg(cfgContent);
    const savedUserCfgRaw = cfgContent;

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
    if (s.savedAttributesHash && attrsHash && attrsHash !== s.savedAttributesHash) {
      detectAttributeConflicts(attrsMap);
    }
    setState({
      userCfgSettings,
      savedUserCfgRaw,
      savedAttributesHash: attrsHash,
      savedAttributesValues: { ...attrsMap },
    });
  } catch (e) {
    setState({ userCfgSettings: {}, savedUserCfgRaw: '' });
  }
  setState({ savedUserCfgSnapshot: { ...getState().userCfgSettings } });
}

/**
 * Returns true when two attribute values represent the same setting. SC
 * reformats floats on game exit ("1.4" ↔ "1.40000" ↔ "1.3999999") and
 * sometimes pads/strips trailing zeros — those are not user-intent changes
 * and shouldn't surface as sync conflicts. Numeric values are compared with a
 * small tolerance; everything else falls back to string equality.
 */
function attrValuesEqual(a, b) {
  if (a === b) return true;
  if (a == null || b == null) return false;
  const sa = String(a).trim();
  const sb = String(b).trim();
  if (sa === sb) return true;
  const fa = parseFloat(sa);
  const fb = parseFloat(sb);
  if (Number.isFinite(fa) && Number.isFinite(fb)
      && /^-?\d*\.?\d+(?:[eE][+-]?\d+)?$/.test(sa)
      && /^-?\d*\.?\d+(?:[eE][+-]?\d+)?$/.test(sb)) {
    return Math.abs(fa - fb) < 1e-4;
  }
  return false;
}

/**
 * Detects conflicts between our last known attribute values and the current ones.
 * Called when the attributes hash has changed since our last read.
 */
export function detectAttributeConflicts(currentAttrsMap) {
  const s = getState();
  const pendingConflicts = [];
  for (const [key, setting] of Object.entries(DEFAULT_SETTINGS)) {
    if (setting.target !== 'attributes' || !setting.attrName) continue;
    const ourValue = s.savedAttributesValues[setting.attrName];
    const scValue = currentAttrsMap[setting.attrName];
    if (ourValue !== undefined && scValue !== undefined && !attrValuesEqual(ourValue, scValue)) {
      pendingConflicts.push({
        key,
        label: setting.label,
        ourValue: convertAttrValue(key, ourValue),
        scValue: convertAttrValue(key, scValue),
        attrName: setting.attrName,
      });
    }
  }
  setState({ pendingConflicts });
}

/**
 * Parses the content of a USER.cfg file into a key-value object.
 * Handles: comments, inline comments, legacy CVars, and
 * virtual settings (_windowMode from r_Fullscreen + r_FullscreenWindow).
 * @param {string} content - Raw content of USER.cfg
 * @returns {Object} Parsed settings
 */
export function parseUserCfg(content) {
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

  // Calculate virtual _windowMode setting from r_Fullscreen + r_FullscreenWindow.
  // Mapping is verified against SC's in-game UI: WindowMode=1 displays as "Borderless"
  // and WindowMode=2 displays as "Fullscreen". The CVar pair follows the standard
  // CryEngine convention: r_Fullscreen=1 = exclusive fullscreen,
  // r_FullscreenWindow=1 = borderless windowed.
  const rFullscreen = settings.r_Fullscreen;
  const rFullscreenWindow = settings.r_FullscreenWindow;
  if (rFullscreen !== undefined || rFullscreenWindow !== undefined) {
    const fs = (rFullscreen !== undefined) ? rFullscreen : 0;
    const fsw = (rFullscreenWindow !== undefined) ? rFullscreenWindow : 0;
    if (fs === 1) {
      settings._windowMode = 2; // Fullscreen
    } else if (fsw === 1 || fs === 2) {
      settings._windowMode = 1; // Borderless (fs===2 is legacy)
    } else {
      settings._windowMode = 0; // Windowed
    }
    // Remove raw CVars - they are managed by the virtual setting
    delete settings.r_Fullscreen;
    delete settings.r_FullscreenWindow;
  }

  return settings;
}

// ==================== Rendering ====================

/**
 * Detects whether the active environment looks like a fresh SC install where
 * Penguin Citizen's settings have never been applied. Heuristic: USER.cfg is
 * absent or contains nothing besides comments/whitespace. SC's runtime defaults
 * (e.g. r_DisplaySessionInfo=1 in PTU) win unless we explicitly write our values.
 */
export function isFreshInstallEnv() {
  const s = getState();
  const raw = s.savedUserCfgRaw || '';
  const meaningful = raw
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith(';') && !l.startsWith('#'));
  return meaningful.length === 0;
}

/**
 * Banner shown above the settings UI when the active env appears to be a fresh
 * install. Offers a one-click "apply Penguin Citizen settings" action so the
 * user does not have to remember to do it manually after each new env install.
 */
export function renderFreshInstallBanner() {
  const s = getState();
  if (!isFreshInstallEnv()) return '';
  return `
    <div class="usercfg-fresh-banner" id="usercfg-fresh-banner">
      <div class="usercfg-fresh-banner-text">
        <strong>${t('environments:cfg.freshInstall.title', { env: s.activeScVersion, defaultValue: 'Fresh {{env}} install detected' })}</strong>
        <span>${t('environments:cfg.freshInstall.body', { defaultValue: 'Penguin Citizen has never written settings to this environment. Star Citizen is using its own defaults (e.g. Session Info QR is on in PTU). Apply your settings now to override them.' })}</span>
      </div>
      <button class="btn btn-primary" id="btn-apply-fresh-install">${t('environments:cfg.freshInstall.apply', { defaultValue: 'Apply settings' })}</button>
    </div>
  `;
}

/**
 * Renders an "import settings from another environment" panel: dropdown of other
 * envs that have a non-empty USER.cfg, and a Copy button. Lets the user push
 * e.g. their LIVE settings into a freshly installed PTU without retyping.
 */
export function renderImportFromEnvUI() {
  const s = getState();
  const others = (s.scVersions || []).filter(v =>
    v.version !== s.activeScVersion && v.has_usercfg
  );
  if (others.length === 0) return '';
  return `
    <div class="usercfg-import-row">
      <span class="usercfg-import-label">${t('environments:cfg.importFromEnv.label', { defaultValue: 'Copy settings from another environment:' })}</span>
      <select id="usercfg-import-source" class="input input-sm">
        ${others.map(v => `<option value="${escapeHtml(v.version)}">${escapeHtml(v.version)}</option>`).join('')}
      </select>
      <button class="btn btn-sm btn-secondary" id="btn-import-from-env">${t('environments:cfg.importFromEnv.button', { defaultValue: 'Copy here' })}</button>
    </div>
  `;
}

/**
 * Renders the sync conflict bar if there are pending conflicts from in-game changes.
 */
export function renderSyncBar() {
  const s = getState();
  if (s.pendingConflicts.length === 0) return '';
  const count = s.pendingConflicts.length;
  return `
    <div class="usercfg-sync-bar" id="usercfg-sync-bar">
      <span>${t('environments:cfg.syncConflicts', { count, defaultValue: `${count} setting(s) changed in-game` })}</span>
      <button id="btn-resolve-conflicts">${t('environments:cfg.syncResolve', { defaultValue: 'Resolve' })}</button>
    </div>
    <div class="usercfg-conflict-panel" id="usercfg-conflict-panel" style="display:none">
      ${s.pendingConflicts.map(c => {
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

/**
 * Renders the complete USER.cfg settings UI.
 * Groups settings into categories (Essential, Quality, Shader, etc.).
 * Advanced categories are collapsed by default.
 */
export function renderUserCfgUI() {
  const s = getState();
  const essentialCategory = { key: 'essential', label: t('environments:cfg.category.essential') };
  const advancedCategories = [
    { key: 'quality', label: t('environments:cfg.category.quality') },
    { key: 'shaders', label: t('environments:cfg.category.shaders') },
    { key: 'textures', label: t('environments:cfg.category.textures') },
    { key: 'effects', label: t('environments:cfg.category.effects') },
    { key: 'clarity', label: t('environments:cfg.category.clarity') },
    { key: 'audio', label: t('environments:cfg.category.audio', { defaultValue: 'Audio' }) },
    { key: 'combat', label: t('environments:cfg.category.combat', { defaultValue: 'Combat & HUD' }) },
    { key: 'cameralead', label: t('environments:cfg.category.cameralead', { defaultValue: 'Camera Lead (advanced)' }) },
    { key: 'tracking', label: t('environments:cfg.category.tracking', { defaultValue: 'Head / Eye Tracking (HMD · Tobii · Faceware)' }) },
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
          ${t('environments:cfg.sectionTitle', { version: escapeHtml(s.activeScVersion) })}
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
        ${renderFreshInstallBanner()}
        ${renderImportFromEnvUI()}
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
export function renderCategorySettings(category, collapsible) {
  const s = getState();
  const settings = Object.entries(DEFAULT_SETTINGS)
    .filter(([_, st]) => st.category === category.key)
    .map(([key, st]) => ({ key, ...st }));

  if (settings.length === 0) return '';

  const isCollapsed = collapsible && s.collapsedCategories.has(category.key);
  const changedInCategory = settings.filter(st => {
    if (st.type === 'resolution') {
      const w = s.userCfgSettings.r_width !== undefined ? s.userCfgSettings.r_width : 1920;
      const h = s.userCfgSettings.r_height !== undefined ? s.userCfgSettings.r_height : 1080;
      return w !== 1920 || h !== 1080;
    }
    const val = s.userCfgSettings[st.key] !== undefined ? s.userCfgSettings[st.key] : st.value;
    return val !== st.value;
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
        ${settings.map(st => renderSettingControl(st.key, st)).join('')}
      </div>
    </div>
  `;
}

/**
 * Renders an info icon button that shows help text as a popover on click.
 */
export function renderHelpIcon(setting) {
  if (!setting.help) return '';
  return `<button class="usercfg-help-btn" data-help="${escapeHtml(setting.help)}" title="${escapeHtml(setting.desc)}">
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
  </button>`;
}

/**
 * Renders the target badge (SC or CFG) for a setting.
 */
export function renderTargetBadge(setting) {
  if (setting.target === 'attributes') {
    return `<span class="usercfg-target-badge attributes" title="${t('environments:cfg.badgeAttributesTooltip', { defaultValue: 'Synced with Star Citizen game settings' })}">SC</span>`;
  }
  return `<span class="usercfg-target-badge usercfg" title="${t('environments:cfg.badgeCfgTooltip', { defaultValue: 'Engine setting (USER.cfg)' })}">CFG</span>`;
}

/**
 * Renders the override warning for settings that override in-game presets.
 */
export function renderOverrideWarning(key, setting) {
  if (!setting.overrideWarning) return '';
  const s = getState();
  const value = s.userCfgSettings[key] !== undefined ? s.userCfgSettings[key] : setting.value;
  if (value === setting.value) return '';
  return `<div class="usercfg-override-warning">${t('environments:cfg.overrideWarning', { defaultValue: 'Overrides the in-game Quality preset on each launch' })}</div>`;
}

/**
 * Renders a single setting control (slider, toggle, number, resolution).
 */
export function renderSettingControl(key, setting) {
  const s = getState();
  const value = s.userCfgSettings[key] !== undefined ? s.userCfgSettings[key] : setting.value;
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
    const w = s.userCfgSettings.r_width !== undefined ? s.userCfgSettings.r_width : 1920;
    const h = s.userCfgSettings.r_height !== undefined ? s.userCfgSettings.r_height : 1080;
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
 * Checks for external changes beforehand (read-before-write).
 */
export async function applyUserCfg() {
  const s = getState();
  if (!s.config?.install_path || !s.activeScVersion) return;
  if (isSavingUserCfg) return;

  // Write guard - disable button during save
  isSavingUserCfg = true;
  const applyBtn = document.getElementById('btn-apply-usercfg');
  if (applyBtn) applyBtn.disabled = true;

  try {
    // Confirm the target environment so settings can't land in the wrong env by mistake
    const proceedTarget = await confirmApplyTarget(s.activeScVersion, { skipScope: 'usercfg' });
    if (!proceedTarget) return;

    // Read-before-write: detect external changes via raw content comparison
    const diskContent = await invoke('read_user_cfg', { gp: s.config.install_path, v: s.activeScVersion });
    if (diskContent !== s.savedUserCfgRaw) {
      const proceed = await confirm(
        t('environments:cfg.externalChangeDetected'),
        { title: t('environments:cfg.externalChangeTitle'), kind: 'warning' }
      );
      if (!proceed) return;
    }

    // Collect current UI values
    const userCfgSettings = { ...s.userCfgSettings };
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

    setState({ userCfgSettings });

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
      invoke('write_user_cfg', { gp: s.config.install_path, v: s.activeScVersion, c: content }),
      Object.keys(attrChanges).length > 0
        ? invoke('write_attributes_partial', { gp: s.config.install_path, v: s.activeScVersion, changes: attrChanges })
        : Promise.resolve(),
    ]);

    // Update snapshots
    const newHash = await invoke('get_attributes_hash', { gp: s.config.install_path, v: s.activeScVersion });
    const freshAttrs = await invoke('read_attributes_map', { gp: s.config.install_path, v: s.activeScVersion });
    setState({
      savedUserCfgSnapshot: { ...userCfgSettings },
      savedUserCfgRaw: content,
      savedAttributesHash: newHash,
      savedAttributesValues: freshAttrs,
      pendingConflicts: [],
    });
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
export async function resetUserCfg() {
  const s = getState();
  if (!s.config?.install_path || !s.activeScVersion) return;
  const confirmed = await confirm(t('environments:cfg.resetConfirm'), { title: t('environments:cfg.resetTitle'), kind: 'warning' });
  if (!confirmed) return;
  setState({ userCfgSettings: {} });
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
      invoke('write_user_cfg', { gp: s.config.install_path, v: s.activeScVersion, c: '' }),
      Object.keys(attrDefaults).length > 0
        ? invoke('write_attributes_partial', { gp: s.config.install_path, v: s.activeScVersion, changes: attrDefaults })
        : Promise.resolve(),
    ]);
    setState({ pendingConflicts: [] });
    showNotification(t('environments:notification.userCfgReset'), 'success');
    // Cross-module: caller should trigger renderEnvironments() after this
  } catch (e) {
    showNotification(t('environments:notification.userCfgResetFailed'), 'error');
  }
}

/**
 * Copies USER.cfg + attributes.xml from one Star Citizen environment into the
 * currently active one. Used to seed a fresh install (e.g. PTU just patched)
 * with the user's existing customisations from another env (e.g. LIVE).
 *
 * Reuses existing read/write Tauri commands — no new backend code required.
 *
 * @param {string} sourceVersion - Name of the source env (e.g. "LIVE")
 * @param {Function} reloadFn - Callback to refresh the page after import
 */
export async function importSettingsFromEnv(sourceVersion, reloadFn) {
  const s = getState();
  if (!s.config?.install_path || !s.activeScVersion) return;
  if (sourceVersion === s.activeScVersion) return;

  const confirmed = await confirmApplyTarget(s.activeScVersion, {
    title: t('environments:cfg.importFromEnv.confirmTitle', { defaultValue: 'Copy settings between environments' }),
    message: t('environments:cfg.importFromEnv.confirmBody', {
      src: sourceVersion,
      dst: s.activeScVersion,
      defaultValue: 'Copy USER.cfg and attributes.xml from {{src}} to this environment? Existing settings here will be overwritten.',
    }),
    okLabel: t('environments:cfg.importFromEnv.confirmOk', {
      src: sourceVersion,
      dst: s.activeScVersion,
      defaultValue: 'Copy {{src}} → {{dst}}',
    }),
    skipScope: null, // never auto-skip — destructive cross-env copy must be explicit each time
  });
  if (!confirmed) return;

  try {
    const [srcCfg, srcAttrs] = await Promise.all([
      invoke('read_user_cfg', { gp: s.config.install_path, v: sourceVersion }),
      invoke('read_attributes_map', { gp: s.config.install_path, v: sourceVersion }),
    ]);
    await Promise.all([
      invoke('write_user_cfg', { gp: s.config.install_path, v: s.activeScVersion, c: srcCfg }),
      Object.keys(srcAttrs).length > 0
        ? invoke('write_attributes_partial', { gp: s.config.install_path, v: s.activeScVersion, changes: srcAttrs })
        : Promise.resolve(),
    ]);
    showNotification(t('environments:notification.importSettingsSuccess', { src: sourceVersion, defaultValue: `Settings copied from ${sourceVersion}` }), 'success');
    if (reloadFn) await reloadFn();
  } catch (e) {
    showNotification(t('environments:notification.importSettingsFailed', { error: String(e), defaultValue: `Failed to copy settings: ${String(e)}` }), 'error');
  }
}

/**
 * Generates the USER.cfg content from the current settings.
 * Only settings that differ from defaults are written.
 */
export function generateUserCfg() {
  const s = getState();
  const lines = [
    '; Star Citizen USER.cfg Configuration',
    '; Generated by Penguin Citizen',
    '; Only non-default values are stored',
    '',
  ];

  const categoryOrder = ['essential', 'quality', 'shaders', 'textures', 'effects', 'clarity', 'audio', 'combat', 'cameralead', 'tracking', 'lod', 'input', 'advanced'];

  // _windowMode and _resolution are 'target: attributes' settings — they are NOT
  // written to USER.cfg. CryEngine loads USER.cfg AFTER attributes.xml on every
  // launch, so any CVars in USER.cfg (r_Fullscreen, r_width, ...) would override
  // and undo the user's in-game choices, creating a flip-flop. These settings
  // are written exclusively to attributes.xml in applyUserCfg() via attrChanges.
  // See docs/superpowers/specs/2026-04-08-unified-settings-routing-design.md.

  for (const cat of categoryOrder) {
    const catSettings = Object.entries(DEFAULT_SETTINGS).filter(([_, st]) => st.category === cat);
    const changedSettings = [];

    for (const [key, setting] of catSettings) {
      if (setting.virtual) continue;
      if (setting.target === 'attributes') continue;
      const currentValue = s.userCfgSettings[key] !== undefined ? s.userCfgSettings[key] : setting.value;
      if (currentValue !== setting.value || setting.alwaysWrite) {
        const defaultStr = setting.type === 'toggle' ? (setting.value ? '1' : '0') : String(setting.value);
        changedSettings.push({ key, setting, value: currentValue, defaultValue: defaultStr });
      }
    }

    if (changedSettings.length > 0) {
      lines.push(`;--- ${cat.charAt(0).toUpperCase() + cat.slice(1)} ---`);

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
  managedKeys.add('r_Fullscreen');
  managedKeys.add('r_FullscreenWindow');
  managedKeys.add('r_width');
  managedKeys.add('r_height');
  const extraKeys = Object.keys(s.userCfgSettings).filter(k => !managedKeys.has(k));
  if (extraKeys.length > 0) {
    lines.push(';--- Other ---');
    for (const key of extraKeys) {
      const value = s.userCfgSettings[key];
      if (value !== undefined && value !== '') {
        lines.push(`${key} = ${value}`);
      }
    }
    lines.push('');
  }

  return lines.join('\n');
}

// ==================== Highlight / Change Detection ====================

/**
 * Updates the resolution setting highlight (changed/default).
 */
export function updateResolutionHighlight() {
  const s = getState();
  const row = document.querySelector('.usercfg-res-input')?.closest('.usercfg-row');
  if (!row) return;
  const w = s.userCfgSettings.r_width !== undefined ? s.userCfgSettings.r_width : 1920;
  const h = s.userCfgSettings.r_height !== undefined ? s.userCfgSettings.r_height : 1080;
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
 * Updates the visual highlight of a setting row.
 */
export function updateSettingHighlight(row, key, setting, value) {
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
      const helpBtn = label.querySelector('.usercfg-help-btn');
      const helpHtml = helpBtn ? helpBtn.outerHTML : '';
      label.innerHTML = `${helpHtml}${setting.label} <span class="usercfg-default">(${t('environments:cfg.defaultPrefix', { value: defaultLabel })})</span>`;
    }
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
    const resetBtn = controlWrap?.querySelector('.usercfg-reset');
    if (resetBtn) resetBtn.remove();
  }

  updateChangedCounts();
}

/**
 * Updates the changed-count badges on each category header and the
 * overall header count. Also toggles the unsaved changes indicator.
 */
export function updateChangedCounts() {
  document.querySelectorAll('.usercfg-category').forEach(cat => {
    const header = cat.querySelector('.usercfg-category-header');
    if (!header) return;
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

  const totalChanged = getChangedSettingsCount();
  const headerCount = document.querySelector('.usercfg-header-count');
  if (headerCount) {
    headerCount.textContent = totalChanged > 0 ? t('environments:cfg.countChanged', { count: totalChanged }) : t('environments:cfg.allDefaults');
  }

  const unsavedEl = document.getElementById('usercfg-unsaved');
  if (unsavedEl) {
    const hasUnsaved = hasUnsavedChanges();
    unsavedEl.style.display = hasUnsaved ? '' : 'none';
  }
}

/**
 * Counts the number of settings that differ from default values.
 */
export function getChangedSettingsCount() {
  const s = getState();
  let count = 0;
  for (const [key, setting] of Object.entries(DEFAULT_SETTINGS)) {
    if (setting.type === 'resolution') {
      const w = s.userCfgSettings.r_width !== undefined ? s.userCfgSettings.r_width : 1920;
      const h = s.userCfgSettings.r_height !== undefined ? s.userCfgSettings.r_height : 1080;
      if (w !== 1920 || h !== 1080) count++;
      continue;
    }
    const currentValue = s.userCfgSettings[key] !== undefined ? s.userCfgSettings[key] : setting.value;
    if (currentValue !== setting.value) count++;
  }
  return count;
}

/**
 * Checks whether the current USER.cfg settings differ from the last saved state.
 * @returns {boolean} True if there are unsaved changes
 */
export function hasUnsavedChanges() {
  const s = getState();
  const allKeys = new Set([
    ...Object.keys(s.userCfgSettings),
    ...Object.keys(s.savedUserCfgSnapshot),
  ]);
  for (const key of allKeys) {
    const current = s.userCfgSettings[key];
    const saved = s.savedUserCfgSnapshot[key];
    if (current !== saved) return true;
  }
  return false;
}
