import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  isAllowedAssetUrl,
  matchAssetFormat,
  formatBytes,
  normalizeVersion,
} from '../download.js';

test('isAllowedAssetUrl: accepts canonical release URL', () => {
  assert.equal(
    isAllowedAssetUrl('https://github.com/TomRhodan/penguin-citizen/releases/download/v0.5.6-0/Penguin.Citizen_0.5.6_amd64.deb'),
    true,
  );
});

test('isAllowedAssetUrl: rejects different host', () => {
  assert.equal(isAllowedAssetUrl('https://evil.example.com/payload.deb'), false);
});

test('isAllowedAssetUrl: rejects different repo', () => {
  assert.equal(
    isAllowedAssetUrl('https://github.com/SomeoneElse/penguin-citizen/releases/download/v1/x.deb'),
    false,
  );
});

test('isAllowedAssetUrl: rejects http (must be https)', () => {
  assert.equal(
    isAllowedAssetUrl('http://github.com/TomRhodan/penguin-citizen/releases/download/v0.5.6-0/x.deb'),
    false,
  );
});

test('isAllowedAssetUrl: rejects garbage input', () => {
  assert.equal(isAllowedAssetUrl(null), false);
  assert.equal(isAllowedAssetUrl(''), false);
  assert.equal(isAllowedAssetUrl('javascript:alert(1)'), false);
});

test('matchAssetFormat: identifies .deb', () => {
  assert.equal(matchAssetFormat('Penguin.Citizen_0.5.6_amd64.deb'), 'deb');
});

test('matchAssetFormat: identifies .AppImage', () => {
  assert.equal(matchAssetFormat('Penguin.Citizen_0.5.6_amd64.AppImage'), 'appimage');
});

test('matchAssetFormat: identifies portable tar.gz', () => {
  assert.equal(matchAssetFormat('penguin-citizen_0.5.6_amd64_portable.tar.gz'), 'portable');
});

test('matchAssetFormat: returns null for unknown', () => {
  assert.equal(matchAssetFormat('something.iso'), null);
  assert.equal(matchAssetFormat(''), null);
});

test('formatBytes: under 1 MB returns KB', () => {
  assert.equal(formatBytes(512_000), '500 KB');
});

test('formatBytes: MB rounds to integer', () => {
  assert.equal(formatBytes(9_537_454), '9 MB');
  assert.equal(formatBytes(81_762_808), '78 MB');
});

test('formatBytes: 0 and tiny values', () => {
  assert.equal(formatBytes(0), '0 KB');
  assert.equal(formatBytes(100), '0 KB');
});

test('normalizeVersion: strips v prefix and -N suffix', () => {
  assert.equal(normalizeVersion('v0.5.6-0'), '0.5.6');
  assert.equal(normalizeVersion('v0.5.6'), '0.5.6');
  assert.equal(normalizeVersion('0.5.6'), '0.5.6');
  assert.equal(normalizeVersion('v1.2.3-42'), '1.2.3');
});

import { readCache, writeCache, CACHE_KEY, CACHE_TTL_MS } from '../download.js';

// Minimal localStorage shim for Node
function makeStorage() {
  const store = new Map();
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
  };
}

test('readCache: returns null when empty', () => {
  const ls = makeStorage();
  assert.equal(readCache(ls, Date.now()), null);
});

test('writeCache + readCache: round-trips fresh entry', () => {
  const ls = makeStorage();
  const payload = { version: '0.5.6', assets: { deb: 'https://x' } };
  const now = 1_700_000_000_000;
  writeCache(ls, payload, now);
  assert.deepEqual(readCache(ls, now), payload);
});

test('readCache: returns null when expired', () => {
  const ls = makeStorage();
  const payload = { version: '0.5.6' };
  const written = 1_700_000_000_000;
  writeCache(ls, payload, written);
  // 5 min + 1ms after write -> expired
  assert.equal(readCache(ls, written + CACHE_TTL_MS + 1), null);
});

test('readCache: returns payload at exact TTL boundary (still valid)', () => {
  const ls = makeStorage();
  const payload = { version: '0.5.6' };
  const written = 1_700_000_000_000;
  writeCache(ls, payload, written);
  assert.deepEqual(readCache(ls, written + CACHE_TTL_MS), payload);
});

test('readCache: handles malformed JSON', () => {
  const ls = makeStorage();
  ls.setItem(CACHE_KEY, 'not json {');
  assert.equal(readCache(ls, Date.now()), null);
});

test('readCache: handles missing timestamp', () => {
  const ls = makeStorage();
  ls.setItem(CACHE_KEY, JSON.stringify({ payload: { x: 1 } }));
  assert.equal(readCache(ls, Date.now()), null);
});

import { parseRelease, FALLBACK, fetchLatestRelease } from '../download.js';

const MOCK_RELEASE = {
  tag_name: 'v0.5.6-0',
  assets: [
    {
      name: 'Penguin.Citizen_0.5.6_amd64.deb',
      size: 9_537_454,
      browser_download_url: 'https://github.com/TomRhodan/penguin-citizen/releases/download/v0.5.6-0/Penguin.Citizen_0.5.6_amd64.deb',
    },
    {
      name: 'Penguin.Citizen_0.5.6_amd64.AppImage',
      size: 81_762_808,
      browser_download_url: 'https://github.com/TomRhodan/penguin-citizen/releases/download/v0.5.6-0/Penguin.Citizen_0.5.6_amd64.AppImage',
    },
    {
      name: 'penguin-citizen_0.5.6_amd64_portable.tar.gz',
      size: 97_204_144,
      browser_download_url: 'https://github.com/TomRhodan/penguin-citizen/releases/download/v0.5.6-0/penguin-citizen_0.5.6_amd64_portable.tar.gz',
    },
  ],
};

test('parseRelease: extracts version + 3 assets', () => {
  const out = parseRelease(MOCK_RELEASE);
  assert.equal(out.version, '0.5.6');
  assert.equal(out.assets.deb.url, MOCK_RELEASE.assets[0].browser_download_url);
  assert.equal(out.assets.deb.size, 9_537_454);
  assert.equal(out.assets.appimage.url, MOCK_RELEASE.assets[1].browser_download_url);
  assert.equal(out.assets.portable.url, MOCK_RELEASE.assets[2].browser_download_url);
});

test('parseRelease: drops asset with non-whitelisted URL', () => {
  const evil = {
    tag_name: 'v0.5.6-0',
    assets: [
      {
        name: 'Penguin.Citizen_0.5.6_amd64.deb',
        size: 1,
        browser_download_url: 'https://evil.example.com/x.deb',
      },
    ],
  };
  const out = parseRelease(evil);
  assert.equal(out.assets.deb, undefined);
});

test('parseRelease: drops asset with unknown format', () => {
  const out = parseRelease({
    tag_name: 'v0.5.6-0',
    assets: [
      {
        name: 'random.iso',
        size: 1,
        browser_download_url: 'https://github.com/TomRhodan/penguin-citizen/releases/download/v0.5.6-0/random.iso',
      },
    ],
  });
  assert.deepEqual(out.assets, {});
});

test('parseRelease: throws on missing tag_name', () => {
  assert.throws(() => parseRelease({ assets: [] }));
});

test('FALLBACK: shape is the same as parseRelease output', () => {
  assert.equal(typeof FALLBACK.version, 'string');
  assert.ok(FALLBACK.version.length > 0);
  assert.equal(typeof FALLBACK.assets, 'object');
  // Fallback URLs must pass our own whitelist
  for (const fmt of Object.keys(FALLBACK.assets)) {
    assert.equal(isAllowedAssetUrl(FALLBACK.assets[fmt].url), true, `fallback ${fmt} url should be allowed`);
  }
});

test('fetchLatestRelease: returns parsed payload on success', async () => {
  const fakeFetch = async (url) => ({
    ok: true,
    json: async () => MOCK_RELEASE,
  });
  const out = await fetchLatestRelease(fakeFetch);
  assert.equal(out.version, '0.5.6');
});

test('fetchLatestRelease: returns null on HTTP error', async () => {
  const fakeFetch = async () => ({ ok: false, status: 503, json: async () => ({}) });
  const out = await fetchLatestRelease(fakeFetch);
  assert.equal(out, null);
});

test('fetchLatestRelease: returns null on network throw', async () => {
  const fakeFetch = async () => { throw new Error('network down'); };
  const out = await fetchLatestRelease(fakeFetch);
  assert.equal(out, null);
});
