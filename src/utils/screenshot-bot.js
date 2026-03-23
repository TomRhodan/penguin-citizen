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

import { invoke } from '@tauri-apps/api/core';
import { router } from '../router.js';
import { setActiveProfileTab, renderEnvironments } from '../pages/environments.js';
import { confirm } from './dialogs.js';

/**
 * Penguin Citizen - Integrated Screenshot Bot
 * 
 * Automatically navigates the app and triggers system-level screenshots.
 */

export async function initScreenshotBot() {
  const isMode = await invoke('is_screenshot_mode');
  if (!isMode) return;

  // Inject UI Button into Sidebar
  const sidebarFooter = document.querySelector('.sidebar-footer');
  if (!sidebarFooter) return;

  const botBtn = document.createElement('a');
  botBtn.id = 'bot-capture-btn';
  botBtn.href = '#';
  botBtn.className = 'nav-link';
  botBtn.style.color = 'var(--accent-primary)';
  botBtn.style.marginTop = '1rem';
  botBtn.innerHTML = `
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"></path><circle cx="12" cy="13" r="4"></circle></svg>
    <span>Capture Website Assets</span>
  `;

  botBtn.addEventListener('click', async (e) => {
    e.preventDefault();
    
    const start = await confirm(
      'Start automated screenshot capture?\n\n' +
      'IMPORTANT:\n' +
      '1. Do NOT leave this window.\n' +
      '2. Do NOT click anywhere else.\n' +
      '3. Ensure the window is fully visible.\n\n' +
      'The app will now navigate and capture all views.',
      { title: 'Screenshot Bot', okLabel: 'Start Capture', kind: 'warning' }
    );

    if (start) {
      await runCaptureSequence(botBtn);
    }
  });

  sidebarFooter.insertBefore(botBtn, sidebarFooter.firstChild);
}

async function runCaptureSequence(btn) {
  const originalText = btn.querySelector('span').textContent;
  btn.style.pointerEvents = 'none';
  btn.style.opacity = '0.5';

  const steps = [
    { id: 'dashboard', file: 'dashboard.png' },
    { id: 'launch', file: 'launch.png' },
    { id: 'runners', file: 'wine-runners.png' },
    { id: 'environments', file: 'environments.png', tab: 'profile' },
    { id: 'environments', file: 'usercfg-editor.png', tab: 'usercfg' },
    { id: 'environments', file: 'localization.png', tab: 'localization' },
    { id: 'installation', file: 'installation.png' },
    { id: 'installation', file: 'system-check.png', action: () => document.getElementById('install-btn-check')?.click() },
    { id: 'installation', file: 'installation-progress.png', action: () => document.getElementById('install-btn-main')?.click() },
    { id: 'settings', file: 'settings.png' },
    { id: 'about', file: 'about.png' },
    // Handbook-specific screenshots (tabs not covered above)
    { id: 'environments', file: 'handbook/keybindings.png', tab: 'keybinding' },
    { id: 'environments', file: 'handbook/storage.png', tab: 'storage' },
    { id: 'environments', file: 'handbook/profiles-detail.png', tab: 'profile' }
  ];

  // Initial wait to ensure the confirm dialog is completely gone and UI settled
  await new Promise(r => setTimeout(r, 1000));

  for (const step of steps) {
    btn.querySelector('span').textContent = `Capturing ${step.file}...`;

    // Navigate
    await router.navigate(step.id);
    
    // Handle specific tabs
    if (step.tab) {
      setActiveProfileTab(step.tab);
      const content = document.getElementById('content');
      await renderEnvironments(content);
    }

    // Handle extra actions (like opening modals)
    if (step.action) {
      await new Promise(r => setTimeout(r, 500));
      step.action();
    }

    // Wait for UI to stabilize and data to load
    await new Promise(r => setTimeout(r, 2500));

    // HIDE INDICATOR before capture
    btn.style.visibility = 'hidden';
    await new Promise(r => setTimeout(r, 500));

    // Trigger Rust Screenshot
    try {
      await invoke('capture_app_window', { filename: step.file });
    } catch (err) {
      console.error(`[BOT] Capture failed for ${step.file}:`, err);
    }

    // Close any open modals before next step
    if (step.file === 'system-check.png') {
      const closeBtn = document.querySelector('.modal-close-btn') || document.querySelector('#modal-ok');
      if (closeBtn) closeBtn.click();
    }

    // SHOW INDICATOR again
    btn.style.visibility = 'visible';
    await new Promise(r => setTimeout(r, 200));
  }

  btn.querySelector('span').textContent = originalText;
  btn.style.pointerEvents = '';
  btn.style.opacity = '1';
  
  await confirm(
    'Screenshot capture complete!\n\n' +
    'All images have been saved to:\n' +
    'docs/penguin-citizen.de/assets/screenshots/',
    { title: 'Success', okLabel: 'Done', cancelLabel: '', kind: 'info' }
  );
}
