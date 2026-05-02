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
export const FALLBACK = {
  version: '0.5.6',
  assets: {
    deb: {
      url: 'https://github.com/TomRhodan/penguin-citizen/releases/download/v0.5.6-0/Penguin.Citizen_0.5.6_amd64.deb',
      size: 9_536_646,
    },
    appimage: {
      url: 'https://github.com/TomRhodan/penguin-citizen/releases/download/v0.5.6-0/Penguin.Citizen_0.5.6_amd64.AppImage',
      size: 81_762_808,
    },
    portable: {
      url: 'https://github.com/TomRhodan/penguin-citizen/releases/download/v0.5.6-0/penguin-citizen_0.5.6_amd64_portable.tar.gz',
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
