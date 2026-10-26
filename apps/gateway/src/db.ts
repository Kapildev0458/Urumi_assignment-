// PostgreSQL: schema migration and first-start seeding. Every gateway replica shares one database.
import pg from 'pg';
import type { Config } from './config.js';
import { encrypt, hashPassword } from './security.js';

export type Db = pg.Pool;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('admin', 'member')),
  password_hash TEXT NOT NULL,
  disabled      BOOLEAN NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS invites (
  id          SERIAL PRIMARY KEY,
  email       TEXT NOT NULL,
  role        TEXT NOT NULL CHECK (role IN ('admin', 'member')),
  token_hash  TEXT NOT NULL UNIQUE,
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL,
  accepted_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS api_keys (
  id           SERIAL PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  prefix       TEXT NOT NULL,
  key_hash     TEXT NOT NULL UNIQUE,
  created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ,
  revoked_at   TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS servers (
  id             SERIAL PRIMARY KEY,
  name           TEXT NOT NULL UNIQUE,
  url            TEXT NOT NULL,
  auth_type      TEXT NOT NULL DEFAULT 'none' CHECK (auth_type IN ('none', 'bearer', 'header')),
  auth_header    TEXT,
  credential_enc TEXT,
  enabled        BOOLEAN NOT NULL DEFAULT true,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Tool permissions: a row makes one upstream tool (or every tool, with '*') admin-only.
CREATE TABLE IF NOT EXISTS tool_restrictions (
  server_id  INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  tool       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (server_id, tool)
);
-- Rate limits: one row per bucket ("key:<id>", "chat:<user id>") and minute, shared by all replicas.
CREATE TABLE IF NOT EXISTS rate_limits (
  bucket       TEXT NOT NULL,
  window_start TIMESTAMPTZ NOT NULL,
  count        INTEGER NOT NULL,
  PRIMARY KEY (bucket, window_start)
);
CREATE TABLE IF NOT EXISTS audit_log (
  id          BIGSERIAL PRIMARY KEY,
  at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  user_email  TEXT,
  via         TEXT NOT NULL,
  server_name TEXT,
  tool        TEXT NOT NULL,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  outcome     TEXT NOT NULL CHECK (outcome IN ('success', 'error', 'denied')),
  error       TEXT
);
CREATE INDEX IF NOT EXISTS audit_log_at ON audit_log (at DESC);
CREATE TABLE IF NOT EXISTS seeds (
  key        TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

export function createDb(config: Config): Db {
  return new pg.Pool({ connectionString: config.databaseUrl, max: 10, connectionTimeoutMillis: 5_000 });
}

/** Creates the schema and applies seeds once. An advisory lock keeps replicas from racing. */
export async function migrateAndSeed(db: Db, config: Config): Promise<void> {
  const client = await db.connect();
  try {
    await client.query('SELECT pg_advisory_lock(424242)');
    await client.query(SCHEMA);

    const { rows } = await client.query<{ n: number }>('SELECT count(*)::int AS n FROM users');
    if (rows[0].n === 0) {
      if (!config.seedAdminPassword) throw new Error('No users yet and SEED_ADMIN_PASSWORD is empty');
      await client.query(
        `INSERT INTO users (email, name, role, password_hash) VALUES ($1, 'Admin', 'admin', $2)`,
        [config.seedAdminEmail, await hashPassword(config.seedAdminPassword)],
      );
      console.log(`Seeded admin user ${config.seedAdminEmail}`);
    }

    // Each seed server is inserted only the first time, so an admin can later edit or remove it.
    for (const seed of config.seedServers) {
      const key = `server:${seed.name}`;
      const done = await client.query('SELECT 1 FROM seeds WHERE key = $1', [key]);
      if (done.rowCount) continue;
      const token = seed.tokenEnv ? (process.env[seed.tokenEnv] ?? '') : '';
      await client.query(
        `INSERT INTO servers (name, url, auth_type, credential_enc) VALUES ($1, $2, $3, $4)
         ON CONFLICT (name) DO NOTHING`,
        [seed.name, seed.url, token ? 'bearer' : 'none', token ? encrypt(token, config.credentialsKey) : null],
      );
      await client.query('INSERT INTO seeds (key) VALUES ($1)', [key]);
      console.log(`Seeded MCP server ${seed.name} -> ${seed.url}`);
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(424242)').catch(() => undefined);
    client.release();
  }
}
