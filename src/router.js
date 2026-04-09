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
 * Penguin Citizen - Router Module
 *
 * This module handles client-side navigation of the application.
 * It manages page transitions, sidebar visibility based on installation
 * state, and the first-time setup wizard for new users.
 *
 * @module router
 */

// Tauri invoke API for calls to the Rust backend
import { invoke } from '@tauri-apps/api/core';

// Import all page render functions and cleanup handlers
import { renderDashboard } from './pages/dashboard.js';
import { renderInstallation, cleanupInstallation } from './pages/installation.js';
import { renderRunners, cleanupRunners } from './pages/runners.js';
import { renderLaunch, flushPendingSave, cleanupLaunch } from './pages/launch.js';
import { renderEnvironments, cleanupEnvironments } from './pages/environments/index.js';
import { renderSettings } from './pages/settings.js';
import { renderAbout } from './pages/about.js';
import { renderSetup } from './pages/setup.js';

/**
 * Route mapping: Maps page names to their render function and optional cleanup handler.
 * Cleanup is called before navigating away from a page to release event listeners
 * and other resources, preventing memory leaks.
 * @constant {Object<string, {render: function, cleanup?: function}>}
 */
const routes = {
  dashboard: { render: renderDashboard },
  installation: { render: renderInstallation, cleanup: cleanupInstallation },
  runners: { render: renderRunners, cleanup: cleanupRunners },
  launch: { render: renderLaunch, cleanup: cleanupLaunch },
  environments: { render: renderEnvironments, cleanup: cleanupEnvironments },
  settings: { render: renderSettings },
  about: { render: renderAbout },
};

// Pages visible when NO Star Citizen instance is installed
const PRE_INSTALL_PAGES = ['dashboard', 'installation', 'settings'];

// Pages visible when an instance IS installed
const POST_INSTALL_PAGES = ['dashboard', 'launch', 'runners', 'environments', 'settings'];

// State variables: Is the setup wizard active? Is SC installed? Which page is active?
let setupActive = false;
let installed = false;
/** @type {string|null} Currently active page name (for cleanup on navigation) */
let currentPage = null;

/**
 * Navigates to a specific page.
 * Blocks navigation while the setup wizard is active.
 * Clears the content area and calls the appropriate render function.
 * Also updates the active state of the sidebar links.
 *
 * @param {string} page - The name of the target page (e.g. 'dashboard', 'launch').
 */
async function navigate(page) {
  // Navigation is not allowed while the setup wizard is active
  if (setupActive) return;

  // Flush any pending debounced saves from the launch page
  flushPendingSave();

  const content = document.getElementById('content');
  const route = routes[page];
  if (!route) return;

  // Clean up the current page's event listeners and resources before leaving
  if (currentPage && routes[currentPage]?.cleanup) {
    routes[currentPage].cleanup();
  }
  currentPage = page;

  // Remove old page content and render the new page
  content.innerHTML = '';
  route.render(content);

  // Highlight the active sidebar link and set ARIA current page
  document.querySelectorAll('.nav-link').forEach((link) => {
    const isActive = link.dataset.page === page;
    link.classList.toggle('active', isActive);
    if (isActive) {
      link.setAttribute('aria-current', 'page');
    } else {
      link.removeAttribute('aria-current');
    }
  });
}

/**
 * Updates the visibility of sidebar entries based on the installation state.
 * Before installation, only Dashboard, Installation, and Settings are shown.
 * After installation, Launch, Runners, and Environments are added,
 * while Installation is hidden.
 *
 * @param {boolean} isInstalled - Whether Star Citizen is installed.
 */
function updateSidebar(isInstalled) {
  installed = isInstalled;
  const visiblePages = isInstalled ? POST_INSTALL_PAGES : PRE_INSTALL_PAGES;

  // Show/hide navigation links in the main list
  document.querySelectorAll('.nav-links .nav-link').forEach((link) => {
    const page = link.dataset.page;
    if (!page) return;
    link.closest('li').style.display = visiblePages.includes(page) ? '' : 'none';
  });

  // Footer links (e.g. "About") are always visible, regardless of installation state
  document.querySelectorAll('.sidebar-footer .nav-link').forEach((link) => {
    link.style.display = '';
  });
}

/**
 * Checks whether Star Citizen is installed by loading the configuration
 * and querying the installation status via the Rust backend.
 *
 * @returns {Promise<boolean>} True if installed, false otherwise.
 */
async function checkInstallationState() {
  try {
    const config = await invoke('load_config');
    if (config) {
      const status = await invoke('check_installation', { config });
      return status.installed;
    }
  } catch (e) {
    // Configuration not found or check failed
  }
  return false;
}

/**
 * Displays the first-time setup wizard.
 * Hides the sidebar and shows the setup page in the content area.
 * After setup completion, normal navigation is restored
 * and the user is navigated to the installation page.
 *
 * @param {string} defaultPath - Suggested default installation path.
 */
function showSetup(defaultPath) {
  setupActive = true;

  const sidebar = document.getElementById('sidebar');
  const content = document.getElementById('content');

  // Hide sidebar and adjust content for the setup view
  sidebar.classList.add('sidebar-hidden');
  content.classList.add('content-setup');
  content.innerHTML = '';

  renderSetup(content, {
    defaultPath,
    // Callback after setup wizard completion
    onComplete: () => {
      setupActive = false;
      sidebar.classList.remove('sidebar-hidden');
      content.classList.remove('content-setup');
      // Set sidebar to "not installed" state and switch to the installation page
      updateSidebar(false);
      navigate('installation');
    },
  });
}

/**
 * Initializes the router and the application state.
 * Sets up click handlers for all navigation links, checks whether a
 * first-time setup is needed (setup wizard), and then loads
 * the dashboard page as the start page.
 */
async function init() {
  // Register click handlers for all navigation links in the sidebar
  document.querySelectorAll('.nav-link').forEach((link) => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      navigate(link.dataset.page);
    });
  });

  // Check if first-time setup is needed (e.g. no config.json exists yet)
  try {
    const check = await invoke('check_needs_setup');
    if (check.needs_setup) {
      showSetup(check.default_path);
      return;
    }
  } catch (err) {
    console.error('Setup check failed:', err);
  }

  // Determine installation state and update sidebar accordingly
  const isInstalled = await checkInstallationState();
  updateSidebar(isInstalled);

  // Load dashboard as the start page
  currentPage = 'dashboard';
  navigate('dashboard');
}

// Public router API: init to start, navigate for page transitions,
// updateSidebar to update the sidebar after installation changes
export const router = { init, navigate, updateSidebar };
