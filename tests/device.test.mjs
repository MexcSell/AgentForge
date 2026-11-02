// Client device fingerprint (client/src/lib/device.js): characteristics of the computer only — no IP or other network
// address, no window size — and stable for one computer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deviceFingerprint } from '../client/src/lib/device.js';
import { hashDevice, sameDevice, DEVICE_HARDWARE, DEVICE_SOFT } from '../server/services/auth.js';

const nav = { platform: 'Linux x86_64', hardwareConcurrency: 8, deviceMemory: 8, maxTouchPoints: 0, language: 'en-US' };
const scr = (w, h) => ({ width: w, height: h, colorDepth: 24 });

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
