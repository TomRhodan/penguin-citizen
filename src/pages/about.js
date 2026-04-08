/**
 * Penguin Citizen - About Page
 *
 * This module renders the about page, which displays the following information:
 * - Application version and description
 * - Author information
 * - Credits and inspiration sources
 * - License information
 * - Links to GitHub, Wiki, and other resources
 *
 * @module pages/about
 */

// Tauri plugin for opening external URLs in the default browser
import { invoke } from '@tauri-apps/api/core';
import { getVersion } from '@tauri-apps/api/app';
import { t } from '../i18n.js';
import { logError } from '../utils/error-handler.js';
// Static image assets for logo and community badge
import logoUrl from '../assets/logos/PenguinCitizen-Transparent-Logo-Image.png';
import madeByCommunityUrl from '../assets/logos/MadeByTheCommunity_White.png';

/**
 * Renders the about page into the provided container.
 * Creates a hero banner with logo and version, as well as a grid
 * with cards for app info, imprint, credits, and license.
 * All external links are opened via the Tauri openUrl plugin,
 * so they appear in the system browser instead of the WebView.
 *
 * @param {HTMLElement} container - The container element to render into
 */
export async function renderAbout(container) {
  const appVersion = await getVersion();
  container.innerHTML = `
    <div class="about-hero">
      <div class="about-hero-glow"></div>
      <div class="about-hero-icon">
        <img src="${logoUrl}" alt="Penguin Citizen Logo" />
      </div>
      <h1 class="about-hero-title">${t('about:title')}</h1>
      <p class="about-hero-version">v${appVersion}</p>
      <p class="about-hero-tagline">${t('about:tagline')}</p>
    </div>

    <div class="about-grid">
      <!-- Card: General app information (name, version, description, source code link) -->
      <div class="about-card">
        <h3>${t('about:section.appInfo')}</h3>
        <div class="about-info-row">
          <span class="about-info-label">${t('about:label.name')}</span>
          <span class="about-info-value">Penguin Citizen</span>
        </div>
        <div class="about-info-row">
          <span class="about-info-label">${t('about:label.version')}</span>
          <span class="about-info-value">v${appVersion}</span>
        </div>
        <div class="about-info-row">
          <span class="about-info-label">${t('about:label.description')}</span>
          <span class="about-info-value">${t('about:desc.app')}</span>
        </div>
        <div class="about-info-row">
          <span class="about-info-label">${t('about:label.source')}</span>
          <span class="about-info-value">
            <a href="#" class="about-link" data-url="https://github.com/TomRhodan/penguin-citizen">github.com/TomRhodan/penguin-citizen</a>
          </span>
        </div>
      </div>

      <!-- Card: Imprint with author and contact details -->
      <div class="about-card">
        <h3>${t('about:section.impressum')}</h3>
        <div class="about-info-row">
          <span class="about-info-label">${t('about:label.author')}</span>
          <span class="about-info-value">TomRhodan</span>
        </div>
        <div class="about-info-row">
          <span class="about-info-label">${t('about:label.email')}</span>
          <span class="about-info-value">
            <a href="#" class="about-link" data-url="mailto:tomrhodan@gmail.com">tomrhodan@gmail.com</a>
          </span>
        </div>
      </div>

      <!-- Card: Credits and acknowledgments to community projects -->
      <div class="about-card">
        <h3>${t('about:section.credits')}</h3>
        <div class="about-credits-layout">
          <!-- Community badge: "Made by the Community" -->
          <div class="about-community-badge">
            <img src="${madeByCommunityUrl}" alt="Made by the Community" />
          </div>
          <!-- Links to the projects that inspired Penguin Citizen -->
          <div class="about-credits-links">
            <div class="about-credit-item">
              <a href="#" class="about-link" data-url="https://github.com/starcitizen-lug/lug-helper">LUG Helper</a>
              <span class="about-credit-desc">${t('about:desc.lugHelper')}</span>
            </div>
            <div class="about-credit-item">
              <a href="#" class="about-link" data-url="https://luftwerft.com">luftwerft.com</a>
              <span class="about-credit-desc">${t('about:desc.luftwerft')}</span>
            </div>
            <div class="about-credit-item">
              <a href="#" class="about-link" data-url="https://wiki.starcitizen-lug.org/">Star Citizen LUG Wiki</a>
              <span class="about-credit-desc">${t('about:desc.lugWiki')}</span>
            </div>
          </div>
        </div>
        <!-- Legal disclaimer: Penguin Citizen is not affiliated with CIG -->
        <div class="about-disclaimer">
          ${t('about:desc.disclaimer')}
        </div>
      </div>

      <!-- Card: License information (GPL-3.0) -->
      <div class="about-card">
        <h3>${t('about:section.license')}</h3>
        <div class="about-info-row">
          <span class="about-info-label">${t('about:label.license')}</span>
          <span class="about-info-value">GPL-3.0-or-later</span>
        </div>
        <div class="about-info-row">
          <span class="about-info-label">${t('about:label.copyright')}</span>
          <span class="about-info-value">2024-2026 TomRhodan</span>
        </div>
        <div class="about-info-row">
          <span class="about-info-label">${t('about:label.details')}</span>
          <span class="about-info-value">
            <a href="#" class="about-link" data-url="https://www.gnu.org/licenses/gpl-3.0.html">${t('about:desc.gpl')}</a>
          </span>
        </div>
      </div>
    </div>
  `;

  // Intercept external links: Use open_browser instead of normal navigation,
  // so links open in the system browser (not in the Tauri WebView)
  container.querySelectorAll('.about-link[data-url]').forEach(link => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      invoke('open_browser', { url: link.dataset.url }).catch(err => logError(err, 'about:open_browser'));
    });
  });
}
