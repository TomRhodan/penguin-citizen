// Penguin Citizen — homepage download section logic.
// Hydrates the four format cards from the latest GitHub release,
// caches the response in localStorage (5min), and toggles the AUR modal.

const REPO = 'TomRhodan/penguin-citizen';
const ALLOWED_PREFIX = `https://github.com/${REPO}/releases/download/`;

export function isAllowedAssetUrl(url) {
  if (typeof url !== 'string' || url.length === 0) return false;
  return url.startsWith(ALLOWED_PREFIX);
}

export function matchAssetFormat(filename) {
  if (typeof filename !== 'string') return null;
  if (filename.endsWith('_portable.tar.gz')) return 'portable';
  if (filename.endsWith('.AppImage')) return 'appimage';
  if (filename.endsWith('.deb')) return 'deb';
  return null;
}

export function formatBytes(bytes) {
  if (typeof bytes !== 'number' || bytes < 1_048_576) {
    const kb = Math.round((bytes ?? 0) / 1024);
    return `${kb} KB`;
  }
  const mb = Math.round(bytes / 1_048_576);
  return `${mb} MB`;
}

export function normalizeVersion(tag) {
  if (typeof tag !== 'string') return '';
  return tag.replace(/^v/, '').replace(/-\d+$/, '');
}

export const CACHE_KEY = 'pc_latest_release_v1';
export const CACHE_TTL_MS = 5 * 60 * 1000;

export function readCache(storage, nowMs) {
  const raw = storage.getItem(CACHE_KEY);
  if (!raw) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  if (typeof parsed.ts !== 'number') return null;
  if (nowMs - parsed.ts > CACHE_TTL_MS) return null;
  return parsed.payload ?? null;
}

export function writeCache(storage, payload, nowMs) {
  try {
    storage.setItem(CACHE_KEY, JSON.stringify({ ts: nowMs, payload }));
  } catch {
    // Quota exceeded or storage unavailable — ignore, app still works
  }
}

const RELEASES_API = `https://api.github.com/repos/${REPO}/releases/latest`;

// Hardcoded fallback. Update at release time only if the URL pattern changes.
// Sizes are best-guess until the actual v0.5.8-1 artifacts are uploaded; the
// runtime hydrator will replace them with the real bytes from the GitHub
// API on page load.
export const FALLBACK = {
  version: '0.5.8',
  assets: {
    deb: {
      url: 'https://github.com/TomRhodan/penguin-citizen/releases/download/v0.5.8-1/Penguin.Citizen_0.5.8_amd64.deb',
      size: 9_536_646,
    },
    appimage: {
      url: 'https://github.com/TomRhodan/penguin-citizen/releases/download/v0.5.8-1/Penguin.Citizen_0.5.8_amd64.AppImage',
      size: 81_762_808,
    },
    portable: {
      url: 'https://github.com/TomRhodan/penguin-citizen/releases/download/v0.5.8-1/penguin-citizen_0.5.8_amd64_portable.tar.gz',
      size: 97_204_144,
    },
  },
};

export function parseRelease(json) {
  if (!json || typeof json.tag_name !== 'string') {
    throw new Error('Invalid release JSON: missing tag_name');
  }
  const out = { version: normalizeVersion(json.tag_name), assets: {} };
  for (const asset of json.assets ?? []) {
    const fmt = matchAssetFormat(asset.name);
    if (!fmt) continue;
    if (!isAllowedAssetUrl(asset.browser_download_url)) continue;
    out.assets[fmt] = {
      url: asset.browser_download_url,
      size: asset.size,
    };
  }
  return out;
}

export async function fetchLatestRelease(fetcher) {
  try {
    const res = await fetcher(RELEASES_API);
    if (!res.ok) return null;
    const json = await res.json();
    return parseRelease(json);
  } catch {
    return null;
  }
}

function hydrateCards(payload) {
  for (const fmt of ['deb', 'appimage', 'portable']) {
    const card = document.querySelector(`.download-card[data-format="${fmt}"]`);
    if (!card) continue;
    const asset = payload.assets[fmt];
    if (!asset) {
      card.setAttribute('aria-disabled', 'true');
      card.removeAttribute('href');
      const ctaText = card.querySelector('.download-cta-text');
      if (ctaText) ctaText.textContent = 'unavailable';
      continue;
    }
    if (isAllowedAssetUrl(asset.url)) {
      card.setAttribute('href', asset.url);
    }
    const versionSpan = card.querySelector('[data-version]');
    if (versionSpan) versionSpan.textContent = payload.version;
    const sizeSpan = card.querySelector('[data-size]');
    if (sizeSpan) sizeSpan.textContent = formatBytes(asset.size);
  }
}

async function init() {
  bindModalEvents();
  bindCopyButtons();
  const browserFetch = (url) => fetch(url);
  let payload = readCache(window.localStorage, Date.now());
  if (!payload) {
    payload = await fetchLatestRelease(browserFetch);
    if (payload) {
      writeCache(window.localStorage, payload, Date.now());
    } else {
      payload = FALLBACK;
    }
  }
  hydrateCards(payload);
}

if (typeof window !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
}

let lastFocusedBeforeModal = null;

function openModal(id) {
  const modal = document.getElementById(id);
  if (!modal) return;
  // Guard against double-open: rapid double-click would otherwise overwrite
  // lastFocusedBeforeModal with the close button (focused by the first open).
  if (!modal.hidden) return;
  lastFocusedBeforeModal = document.activeElement;
  modal.hidden = false;
  const closeBtn = modal.querySelector('.modal-close');
  if (closeBtn) closeBtn.focus();
}

function closeModal(modal) {
  if (!modal || modal.hidden) return;
  modal.hidden = true;
  if (lastFocusedBeforeModal && typeof lastFocusedBeforeModal.focus === 'function') {
    lastFocusedBeforeModal.focus();
  }
  lastFocusedBeforeModal = null;
}

function bindModalEvents() {
  document.addEventListener('click', (e) => {
    const opener = e.target.closest('[data-modal-open]');
    if (opener) {
      // Only prevent navigation on anchors with an href (e.g. the AUR card's no-JS fallback link).
      if (opener.tagName === 'A' && opener.hasAttribute('href')) {
        e.preventDefault();
      }
      const targetId = opener.getAttribute('data-modal-open') === 'aur'
        ? 'aur-modal'
        : opener.getAttribute('data-modal-open');
      openModal(targetId);
      return;
    }
    const closer = e.target.closest('[data-modal-close]');
    if (closer) {
      const modal = closer.closest('.modal');
      closeModal(modal);
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const visibleModal = document.querySelector('.modal:not([hidden])');
    if (visibleModal) closeModal(visibleModal);
  });

  // Focus trap
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    const modal = document.querySelector('.modal:not([hidden])');
    if (!modal) return;
    const focusables = modal.querySelectorAll(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    );
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  });
}

async function copyTextToClipboard(text) {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // permission denied or browser refused — fall through to selection fallback
    }
  }
  return false;
}

function bindCopyButtons() {
  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('.modal-copy');
    if (!btn) return;
    const targetId = btn.getAttribute('data-copy-target');
    const targetEl = document.getElementById(targetId);
    if (!targetEl) return;
    const text = targetEl.textContent;
    const ok = await copyTextToClipboard(text);
    const isDE = document.documentElement.lang === 'de';
    const originalLabel = btn.dataset.originalLabel || btn.textContent;
    btn.dataset.originalLabel = originalLabel;
    if (ok) {
      btn.textContent = isDE ? 'Kopiert!' : 'Copied!';
      btn.classList.add('is-copied');
    } else {
      // Selection fallback so the user can Ctrl+C manually
      const range = document.createRange();
      range.selectNodeContents(targetEl);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      btn.textContent = isDE ? 'Markiert' : 'Selected';
    }
    setTimeout(() => {
      btn.textContent = originalLabel;
      btn.classList.remove('is-copied');
    }, 1500);
  });
}
