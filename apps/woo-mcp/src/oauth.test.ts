import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { rfc3986, signOAuth1 } from './oauth.js';

test('rfc3986 encodes like PHP rawurlencode', () => {
  assert.equal(rfc3986("a b!*'()~"), 'a%20b%21%2A%27%28%29~');
});

test('signature is HMAC over the normalized base string WooCommerce builds', () => {
  const signed = signOAuth1({
    method: 'get',
    baseUrl: 'http://store.example.com/wp-json/wc/v3/orders',
    params: { after: '2026-10-15T00:00:00', status: 'any', per_page: '20' },
    consumerKey: 'ck_abc',
    consumerSecret: 'cs_def',
    timestamp: 1700000000,
    nonce: 'nonce1',
    algorithm: 'HMAC-SHA1',
  });

  // Sorted by key, each key=value RFC 3986-encoded, then the whole string encoded again.
  const expectedBase =
    'GET&http%3A%2F%2Fstore.example.com%2Fwp-json%2Fwc%2Fv3%2Forders&' +
    'after%3D2026-10-15T00%253A00%253A00' +
    '%26oauth_consumer_key%3Dck_abc' +
    '%26oauth_nonce%3Dnonce1' +
    '%26oauth_signature_method%3DHMAC-SHA1' +
    '%26oauth_timestamp%3D1700000000' +
    '%26oauth_version%3D1.0' +
    '%26per_page%3D20' +
    '%26status%3Dany';
  const expected = createHmac('sha1', 'cs_def&').update(expectedBase).digest('base64');

  assert.equal(signed.oauth_signature, expected);
  assert.equal(signed.after, '2026-10-15T00:00:00');
});

test('signature changes with every parameter', () => {
  const base = {
    method: 'GET',
    baseUrl: 'http://store.example.com/wp-json/wc/v3/orders',
    consumerKey: 'ck_x',
    consumerSecret: 'cs_y',
    timestamp: 1,
    nonce: 'n',
  };
  const a = signOAuth1({ ...base, params: { status: 'processing' } }).oauth_signature;
  const b = signOAuth1({ ...base, params: { status: 'completed' } }).oauth_signature;
  assert.notEqual(a, b);
});
