// All configuration comes from the environment (the Helm chart wires it from values and Secrets).

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  if (Number.isNaN(value)) throw new Error(`${name} must be an integer, got '${raw}'`);
  return value;
}

export interface Config {
  port: number;
  /** In-cluster address of WordPress, e.g. http://urumi-store-wordpress */
  wooUrl: string;
  /** The store's public home URL (WP_HOME). WooCommerce signs OAuth requests against it. */
  wooPublicUrl: string;
  consumerKey: string;
  consumerSecret: string;
  wooTimeoutMs: number;
  /** Optional shared bearer token the gateway must send. Empty = no check. */
  authToken: string;
}

export function loadConfig(): Config {
  return {
    port: int('PORT', 3000),
    wooUrl: required('WOO_URL').replace(/\/+$/, ''),
    wooPublicUrl: required('WOO_PUBLIC_URL').replace(/\/+$/, ''),
    consumerKey: required('WOO_CONSUMER_KEY'),
    consumerSecret: required('WOO_CONSUMER_SECRET'),
    wooTimeoutMs: int('WOO_TIMEOUT_MS', 10_000),
    authToken: process.env.MCP_AUTH_TOKEN ?? '',
  };
}
