import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { decrypt, encrypt, hashPassword, newApiKey, sha256, verifyPassword } from './security.js';
import { allowed, describeError, rankTools } from './upstreams.js';

test('credentials round-trip through AES-256-GCM and fail with the wrong key', () => {
  const key = randomBytes(32);
  const stored = encrypt('upstream-token', key);
  assert.notEqual(stored, 'upstream-token');
  assert.equal(decrypt(stored, key), 'upstream-token');
  assert.throws(() => decrypt(stored, randomBytes(32)));
});

test('passwords are salted and verified', async () => {
  const a = await hashPassword('correct horse');
  const b = await hashPassword('correct horse');
  assert.notEqual(a, b);
  assert.equal(await verifyPassword('correct horse', a), true);
  assert.equal(await verifyPassword('wrong', a), false);
});

test('API keys are stored only as a hash and keep a display prefix', () => {
  const { key, prefix, hash } = newApiKey();
  assert.match(key, /^ugw_[A-Za-z0-9_-]{43}$/);
  assert.ok(key.startsWith(prefix));
  assert.equal(hash, sha256(key));
});

test('upstream errors are described briefly', () => {
  assert.equal(describeError(Object.assign(new Error('x'), { name: 'TimeoutError' }), 5000), 'timed out after 5000 ms');
  assert.equal(describeError(Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } }), 1), 'ECONNREFUSED');
});

test('tool permissions: admins use everything, members not restricted tools or servers', () => {
  const restrictions = new Map([
    [1, new Set(['create_product'])],
    [2, new Set(['*'])],
  ]);
  assert.equal(allowed(restrictions, 'admin', 1, 'create_product'), true);
  assert.equal(allowed(restrictions, 'member', 1, 'create_product'), false);
  assert.equal(allowed(restrictions, 'member', 1, 'list_orders'), true);
  assert.equal(allowed(restrictions, 'member', 2, 'anything'), false);
  assert.equal(allowed(restrictions, 'member', 3, 'anything'), true);
});

test('tool search ranks by name first, then description', () => {
  const tools = [
    { name: 'notes__add_note', description: '[notes] Save a note', inputSchema: { type: 'object' as const } },
    { name: 'woo__list_orders', description: '[woo] List store orders, optionally for one day', inputSchema: { type: 'object' as const } },
    { name: 'woo__get_order', description: '[woo] One order with its items', inputSchema: { type: 'object' as const } },
    { name: 'time__current_time', description: '[time] Current time in a timezone', inputSchema: { type: 'object' as const } },
  ];
  assert.equal(rankTools(tools, 'orders today', 8)[0].name, 'woo__list_orders');
  assert.deepEqual(rankTools(tools, 'note', 8).map((t) => t.name), ['notes__add_note']);
  assert.equal(rankTools(tools, 'zzz', 8).length, 0);
  assert.equal(rankTools(tools, '', 2).length, 2);
});
