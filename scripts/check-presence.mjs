/**
 * Minimal self-check for presence reconcile rules (node).
 * Run: node scripts/check-presence.mjs
 */
import assert from 'node:assert/strict';

const PRESENCE = new Set(['active', 'offline']);
const TIMEOUT_MS = 20 * 60 * 1000;

function reconcile(assets, now = Date.now()) {
  let markedOffline = 0;
  let markedActive = 0;
  for (const a of assets) {
    if (!PRESENCE.has(a.status)) continue;
    const seen = a.lastSeenAt ? new Date(a.lastSeenAt).getTime() : NaN;
    const fresh = !Number.isNaN(seen) && now - seen <= TIMEOUT_MS;
    if (fresh && a.status !== 'active') {
      a.status = 'active';
      markedActive++;
    } else if (!fresh && a.status === 'active') {
      a.status = 'offline';
      markedOffline++;
    }
  }
  return { markedOffline, markedActive };
}

const now = Date.now();
const assets = [
  { tag: 'A', status: 'active', lastSeenAt: new Date(now - 5 * 60_000).toISOString() },
  { tag: 'B', status: 'active', lastSeenAt: new Date(now - 60 * 60_000).toISOString() },
  { tag: 'C', status: 'offline', lastSeenAt: new Date(now - 2 * 60_000).toISOString() },
  { tag: 'D', status: 'retired', lastSeenAt: null },
  { tag: 'E', status: 'maintenance', lastSeenAt: new Date(now - 60_000).toISOString() },
  { tag: 'F', status: 'active', lastSeenAt: null },
  { tag: 'G', status: 'available', lastSeenAt: null },
];

const r = reconcile(assets, now);
assert.equal(assets.find((a) => a.tag === 'A').status, 'active');
assert.equal(assets.find((a) => a.tag === 'B').status, 'offline');
assert.equal(assets.find((a) => a.tag === 'C').status, 'active');
assert.equal(assets.find((a) => a.tag === 'D').status, 'retired');
assert.equal(assets.find((a) => a.tag === 'E').status, 'maintenance');
assert.equal(assets.find((a) => a.tag === 'F').status, 'offline');
assert.equal(assets.find((a) => a.tag === 'G').status, 'available');
assert.equal(r.markedOffline, 2);
assert.equal(r.markedActive, 1);

function normalizeMac(value) {
  return String(value || '').toLowerCase().replace(/[^a-f0-9]/g, '');
}
function matchByMac(assets, rowMac) {
  const n = normalizeMac(rowMac);
  return assets.find((a) => normalizeMac(a.macAddress) === n);
}
assert.equal(normalizeMac('AA:BB:CC:DD:EE:FF'), 'aabbccddeeff');
assert.equal(matchByMac([{ macAddress: 'aa-bb-cc-dd-ee-ff' }], 'AA:BB:CC:DD:EE:FF').macAddress, 'aa-bb-cc-dd-ee-ff');
assert.equal(matchByMac([{ macAddress: '111111111111' }], 'AA:BB:CC:DD:EE:FF'), undefined);

console.log('check-presence: ok');
