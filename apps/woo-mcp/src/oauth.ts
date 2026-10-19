// OAuth 1.0a one-legged signing, as WooCommerce requires for REST calls over plain HTTP
// (Basic auth with the consumer key/secret is only accepted over HTTPS). See
// WC_REST_Authentication::check_oauth_signature in WooCommerce for the server side.
import { createHmac, randomBytes } from 'node:crypto';

/** rawurlencode() from PHP: RFC 3986, unlike encodeURIComponent which leaves !'()* alone. */
export function rfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

export interface SignOptions {
  method: string;
  /** Absolute URL without query string, as WooCommerce reconstructs it from the home URL. */
  baseUrl: string;
  /** Query parameters that will be sent with the request (they are part of the signature). */
  params: Record<string, string>;
  consumerKey: string;
  consumerSecret: string;
  timestamp?: number;
  nonce?: string;
  algorithm?: 'HMAC-SHA1' | 'HMAC-SHA256';
}

/** Returns the request's query parameters plus the oauth_* parameters, including the signature. */
export function signOAuth1(opts: SignOptions): Record<string, string> {
  const algorithm = opts.algorithm ?? 'HMAC-SHA256';
  const params: Record<string, string> = {
    ...opts.params,
    oauth_consumer_key: opts.consumerKey,
    oauth_nonce: opts.nonce ?? randomBytes(16).toString('hex'),
    oauth_signature_method: algorithm,
    oauth_timestamp: String(opts.timestamp ?? Math.floor(Date.now() / 1000)),
    oauth_version: '1.0',
  };

  const normalized = Object.entries(params)
    .map(([k, v]) => [rfc3986(k), rfc3986(v)] as const)
    .sort(([a, av], [b, bv]) => (a === b ? cmp(av, bv) : cmp(a, b)))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');

  const base = [opts.method.toUpperCase(), rfc3986(opts.baseUrl), rfc3986(normalized)].join('&');
  // One-legged: there is no token secret, so the key is "<consumer secret>&".
  const hash = algorithm === 'HMAC-SHA1' ? 'sha1' : 'sha256';
  const signature = createHmac(hash, `${opts.consumerSecret}&`).update(base).digest('base64');

  return { ...params, oauth_signature: signature };
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
