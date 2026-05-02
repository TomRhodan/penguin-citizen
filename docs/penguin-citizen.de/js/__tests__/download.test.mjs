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
