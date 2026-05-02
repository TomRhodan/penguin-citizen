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
