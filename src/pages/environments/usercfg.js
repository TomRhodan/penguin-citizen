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
import { confirm, showNotification } from '../../utils/dialogs.js';
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
  // Shader Quality (verified) -- all target: 'usercfg' (no in-game menu equivalent)
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

/** CVar keys that should display quality level labels (1-4) */
export const QUALITY_KEYS = new Set(['sys_spec', 'sys_spec_GameEffects', 'sys_spec_ObjectDetail', 'sys_spec_Particles', 'sys_spec_Physics', 'sys_spec_Shading', 'sys_spec_Shadows', 'sys_spec_Texture', 'sys_spec_Water', 'sys_spec_Light', 'sys_spec_PostProcessing', 'sys_spec_TextureResolution', 'sys_spec_VolumetricEffects', 'sys_spec_Sound']);

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

/** Display labels for graphics quality levels (1-4) */
export function getQualityLevels() {
  return ['', t('environments:cfg.quality.low'), t('environments:cfg.quality.medium'), t('environments:cfg.quality.high'), t('environments:cfg.quality.veryHigh')];
}

/** Display labels for shader quality levels (0-3) */
export function getShaderLevels() {
  return ['', t('environments:cfg.quality.low'), t('environments:cfg.quality.medium'), t('environments:cfg.quality.high')];
}

/**
 * Returns translated labels for CVar settings that use dropdown labels.
 * Called at render time so t() resolves to the current language.
 */
export function getSettingLabels(key) {
  const map = {
    '_windowMode': () => [t('environments:cfg.windowMode.windowed'), t('environments:cfg.windowMode.fullscreen'), t('environments:cfg.windowMode.borderless')],
    'r.graphicsRenderer': () => [t('environments:cfg.renderer.vulkan'), t('environments:cfg.renderer.dx11')],
    'r_ssdo': () => [t('environments:cfg.ssdo.off'), t('environments:cfg.ssdo.fast'), t('environments:cfg.ssdo.optimized'), t('environments:cfg.ssdo.reference')],
    'r_MotionBlur': () => [t('environments:cfg.motionBlur.off'), t('environments:cfg.motionBlur.camera'), t('environments:cfg.motionBlur.cameraObject')],
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

// ==================== Rendering ====================

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

  const categoryOrder = ['essential', 'quality', 'shaders', 'textures', 'effects', 'clarity', 'lod', 'input', 'advanced'];

  // Virtual settings with target 'usercfg' are resolved into real CVars here.
  const windowModeSetting = DEFAULT_SETTINGS._windowMode;
  let windowModeCVars = null;
  if (windowModeSetting.target === 'usercfg') {
    const windowMode = s.userCfgSettings._windowMode !== undefined ? s.userCfgSettings._windowMode : windowModeSetting.value;
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
    resW = s.userCfgSettings.r_width !== undefined ? s.userCfgSettings.r_width : 1920;
    resH = s.userCfgSettings.r_height !== undefined ? s.userCfgSettings.r_height : 1080;
    resChanged = resW !== 1920 || resH !== 1080;
  }

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

    if (changedSettings.length > 0 || (cat === 'essential' && (windowModeCVars || resChanged))) {
      lines.push(`;--- ${cat.charAt(0).toUpperCase() + cat.slice(1)} ---`);

      if (cat === 'essential' && resChanged) {
        if (resW !== 1920) lines.push(`r_width = ${resW}  ; default: 1920`);
        if (resH !== 1080) lines.push(`r_height = ${resH}  ; default: 1080`);
      }

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
