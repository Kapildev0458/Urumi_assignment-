// Who is calling: dashboard users carry a session cookie, MCP clients carry a personal API key.
import type { NextFunction, Request, Response } from 'express';
import type { Db } from './db.js';
import { sha256 } from './security.js';

export interface User {
  id: number;
  email: string;
  name: string;
  role: 'admin' | 'member';
}

export const SESSION_COOKIE = 'urumi_session';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: User;
    }
  }
}

function readCookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return undefined;
}

export function sessionAuth(db: Db) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const token = readCookie(req, SESSION_COOKIE);
    if (token) {
      const { rows } = await db.query<User>(
        `SELECT u.id, u.email, u.name, u.role FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = $1 AND s.expires_at > now() AND NOT u.disabled`,
        [sha256(token)],
      );
      req.user = rows[0];
    }
    next();
  };
}

export function sessionToken(req: Request): string | undefined {
  return readCookie(req, SESSION_COOKIE);
}

export function requireUser(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: 'Not logged in' });
    return;
  }
  next();
}

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (req.user?.role !== 'admin') {
    res.status(403).json({ error: 'Admins only' });
    return;
  }
  next();
}

/**
 * Cross-site request protection for the cookie-authenticated API: browsers only send this custom
 * header from same-origin scripts (cross-origin would need a CORS preflight that we never allow).
 */
export function requireSameOrigin(req: Request, res: Response, next: NextFunction): void {
  if (req.method === 'GET' || req.method === 'HEAD' || req.headers['x-requested-with'] === 'urumi') return next();
  res.status(403).json({ error: 'Missing X-Requested-With header' });
}

export type KeyCheck =
  | { ok: true; user: User; keyId: number }
  | { ok: false; reason: string; user?: User };

/** Validates "Authorization: Bearer ugw_..." against the hashed keys. */
export async function checkApiKey(db: Db, header: string | undefined): Promise<KeyCheck> {
  const match = /^Bearer\s+(\S+)$/i.exec(header ?? '');
  if (!match) return { ok: false, reason: 'Missing API key (Authorization: Bearer <key>)' };
  const { rows } = await db.query<User & { key_id: number; revoked_at: Date | null; disabled: boolean }>(
    `SELECT k.id AS key_id, k.revoked_at, u.id, u.email, u.name, u.role, u.disabled
     FROM api_keys k JOIN users u ON u.id = k.user_id WHERE k.key_hash = $1`,
    [sha256(match[1])],
  );
  const row = rows[0];
  if (!row) return { ok: false, reason: 'Invalid API key' };
  const user: User = { id: row.id, email: row.email, name: row.name, role: row.role };
  if (row.revoked_at) return { ok: false, reason: 'API key has been revoked', user };
  if (row.disabled) return { ok: false, reason: 'User is disabled', user };
  void db.query('UPDATE api_keys SET last_used_at = now() WHERE id = $1', [row.key_id]).catch(() => undefined);
  return { ok: true, user, keyId: row.key_id };
}
