// All configuration comes from the environment (the Helm chart wires it from values and Secrets).

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  if (Number.isNaN(value)) throw new Error(`${name} must be an integer, got '${raw}'`);
  return value;
}

/** A server registered on first start: its bearer token comes from the env var named in tokenEnv. */
export interface SeedServer {
  name: string;
  url: string;
  tokenEnv?: string;
}

export interface Config {
  port: number;
  databaseUrl: string;
  /** 32-byte key that encrypts upstream credentials at rest (AES-256-GCM). */
  credentialsKey: Buffer;
  /** Public base URL of the dashboard and gateway, e.g. http://app.127.0.0.1.nip.io */
  publicUrl: string;
  cookieSecure: boolean;
  sessionHours: number;
  listTimeoutMs: number;
  callTimeoutMs: number;
  refreshIntervalMs: number;
  seedAdminEmail: string;
  seedAdminPassword: string;
  seedServers: SeedServer[];
  llm: {
    /** "anthropic", "openai" (any OpenAI-compatible API), or "" when no key is configured. */
    provider: string;
    model: string;
    baseUrl: string;
    apiKey: string;
  };
}

export function loadConfig(): Config {
  const key = Buffer.from(required('CREDENTIALS_KEY'), 'base64');
  if (key.length !== 32) throw new Error('CREDENTIALS_KEY must be 32 bytes, base64-encoded');
  const provider = (process.env.LLM_PROVIDER ?? '').trim().toLowerCase();
  const apiKey = process.env.LLM_API_KEY ?? '';
  return {
    port: int('PORT', 3000),
    databaseUrl: required('DATABASE_URL'),
    credentialsKey: key,
    publicUrl: (process.env.PUBLIC_URL ?? 'http://localhost:3000').replace(/\/+$/, ''),
    cookieSecure: process.env.COOKIE_SECURE === 'true',
    sessionHours: int('SESSION_HOURS', 12),
    listTimeoutMs: int('UPSTREAM_LIST_TIMEOUT_MS', 5_000),
    callTimeoutMs: int('UPSTREAM_CALL_TIMEOUT_MS', 30_000),
    refreshIntervalMs: int('UPSTREAM_REFRESH_INTERVAL_MS', 15_000),
    seedAdminEmail: (process.env.SEED_ADMIN_EMAIL ?? 'admin@example.com').toLowerCase(),
    seedAdminPassword: process.env.SEED_ADMIN_PASSWORD ?? '',
    seedServers: JSON.parse(process.env.SEED_SERVERS ?? '[]') as SeedServer[],
    llm: {
      provider: apiKey ? provider : '',
      model: process.env.LLM_MODEL || (provider === 'anthropic' ? 'claude-opus-5-5' : ''),
      baseUrl: (process.env.LLM_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, ''),
      apiKey,
    },
  };
}
