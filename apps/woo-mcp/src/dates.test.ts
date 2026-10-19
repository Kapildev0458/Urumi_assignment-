import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveDay } from './dates.js';

const now = new Date('2026-10-15T20:30:00Z');

test('today in UTC', () => {
  assert.deepEqual(resolveDay('today', 0, now), {
    day: '2026-10-15',
    after: '2026-10-14T23:59:59',
    before: '2026-10-16T00:00:00',
  });
});

test('today uses the store offset, not the pod clock', () => {
  // 20:30 UTC is already 02:00 on the 16th in India (+5.5).
  assert.equal(resolveDay('today', 5.5, now).day, '2026-10-16');
  assert.equal(resolveDay('today', -7, now).day, '2026-10-15');
});

test('yesterday and explicit dates', () => {
  assert.equal(resolveDay('Yesterday', 0, now).day, '2026-10-14');
  assert.equal(resolveDay('2026-03-01', 0, now).after, '2026-02-28T23:59:59');
});

test('rejects garbage', () => {
  assert.throws(() => resolveDay('last week', 0, now));
});
