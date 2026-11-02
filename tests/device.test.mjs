// Client device identity (client/src/lib/device.js): the random device secret (created once, kept, accepted by the
// server), the descriptive computer info the administrator sees, and the legacy fingerprint: characteristics of the
// computer only — no IP or other network address, no window size — and stable for one computer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deviceFingerprint, deviceSecret, storedDeviceSecret, forgetDeviceSecret, deviceInfo, deviceCredential, DEVICE_KEY } from '../client/src/lib/device.js';
import { hashDevice, sameDevice, deviceSecretHash, deviceInfo as storedInfo, DEVICE_HARDWARE, DEVICE_SOFT, DEVICE_INFO } from '../server/services/auth.js';

const nav = { platform: 'Linux x86_64', hardwareConcurrency: 8, deviceMemory: 8, maxTouchPoints: 0, language: 'en-US' };
const scr = (w, h) => ({ width: w, height: h, colorDepth: 24 });

const memoryStorage = () => {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), m };
};
const CHROME = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

test('the device secret: 256 random bits created on first use, then the same one from storage; the server accepts it', () => {
  const store = memoryStorage();
  assert.equal(storedDeviceSecret(store), null);
  const s = deviceSecret(store);
  assert.match(s, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(store.m.get(DEVICE_KEY), s);
  assert.equal(deviceSecret(store), s, 'kept');
  assert.equal(storedDeviceSecret(store), s);
  assert.notEqual(deviceSecret(memoryStorage()), s, 'another browser, another secret');
  assert.match(deviceSecretHash({ secret: s }), /^[0-9a-f]{64}$/);
  store.setItem(DEVICE_KEY, 'tampered!');
  assert.equal(storedDeviceSecret(store), null, 'a malformed stored value is not used');
  assert.notEqual(deviceSecret(store), 'tampered!');
  const kept = storedDeviceSecret(store);
  forgetDeviceSecret(store);
  assert.equal(storedDeviceSecret(store), null, 'an unrecognised secret is forgotten');
  assert.notEqual(deviceSecret(store), kept, 'the next sign-up makes a new one');
  forgetDeviceSecret(undefined); // no storage: no throw
  const broken = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  assert.match(deviceSecret(broken), /^[A-Za-z0-9_-]{43}$/, 'no storage: still a secret for this page');
});

test('the computer info: OS, browser, platform, user agent, screen and a derived label, stored as sent by the server', () => {
  const info = deviceInfo({ ...nav, userAgent: CHROME }, scr(1920, 1080));
  assert.equal(info.label, 'Chrome on Linux');
  assert.deepEqual([info.os, info.browser, info.platform, info.screen, info.userAgent], ['Linux', 'Chrome', 'Linux x86_64', '1920x1080', CHROME]);
  assert.deepEqual(Object.keys(info).sort(), [...DEVICE_INFO].sort());
  assert.deepEqual(storedInfo({ info }), info, 'the server keeps all of it');
  assert.ok(JSON.stringify(info).length < 1024);
  assert.equal(deviceInfo({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 Edg/130.0' }, scr(1, 1)).label, 'Edge on Windows');
  assert.equal(deviceInfo({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15' }, scr(1, 1)).label, 'Safari on macOS');
  assert.doesNotMatch(JSON.stringify({ ...info, userAgent: '' }), /\b\d{1,3}(\.\d{1,3}){3}\b/, 'no IPv4 (the user agent holds version numbers)');
  const cred = deviceCredential({ ...nav, userAgent: CHROME }, scr(1920, 1080), memoryStorage());
  assert.deepEqual(Object.keys(cred).sort(), ['info', 'secret']);
});

test('the fingerprint holds exactly the components the server knows, none of them a network address', () => {
  const fp = deviceFingerprint(nav, scr(1920, 1080));
  assert.deepEqual(Object.keys(fp).sort(), [...DEVICE_HARDWARE, ...DEVICE_SOFT].sort());
  const text = JSON.stringify(fp);
  assert.doesNotMatch(text, /\b\d{1,3}(\.\d{1,3}){3}\b/, 'no IPv4');
  assert.doesNotMatch(text, /[0-9a-f]{1,4}(:[0-9a-f]{0,4}){3,}/i, 'no IPv6');
  assert.ok(!/ip|address|window|inner|outer/i.test(Object.keys(fp).join(' ')));
});

test('one computer gives one device: the same reading twice, a rotated screen, and a resized window do not change it', () => {
  const a = deviceFingerprint(nav, scr(1920, 1080));
  assert.deepEqual(deviceFingerprint(nav, scr(1920, 1080)), a);
  assert.equal(deviceFingerprint(nav, scr(1080, 1920)).screen, a.screen);
  globalThis.innerWidth = 800; // window size is never read
  assert.deepEqual(deviceFingerprint(nav, scr(1920, 1080)), a);
  assert.equal(sameDevice(hashDevice(a), hashDevice(deviceFingerprint(nav, scr(2560, 1440)))), true, 'another monitor');
  assert.equal(sameDevice(hashDevice(a), hashDevice(deviceFingerprint({ ...nav, hardwareConcurrency: 16, deviceMemory: 32 }, scr(1920, 1080)))), false, 'another computer');
});
