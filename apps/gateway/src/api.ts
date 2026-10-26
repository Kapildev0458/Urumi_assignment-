// REST API for the dashboard (/api). Cookie sessions; admins manage servers and members.
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import express, { type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { requireAdmin, requireSameOrigin, requireUser, SESSION_COOKIE, sessionAuth, sessionToken, type User } from './auth.js';
import { llmConfigured, runChat } from './chat.js';
import type { Config } from './config.js';
import type { Db } from './db.js';
import { hit } from './ratelimit.js';
import { encrypt, hashPassword, newApiKey, newToken, sha256, verifyPassword } from './security.js';
import { allowed, GATEWAY, SEPARATOR, SERVER_NAME, type Restrictions, type ServerRow, type Upstreams } from './upstreams.js';

class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

function parse<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const result = schema.safeParse(data);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new HttpError(400, `${issue.path.join('.') || 'body'}: ${issue.message}`);
  }
  return result.data;
}

function id(req: Request): number {
  const value = Number(req.params.id);
  if (!Number.isInteger(value)) throw new HttpError(400, 'Bad id');
  return value;
}

/**
 * SSRF guard for admin-entered URLs. Cluster-internal names must stay allowed (upstreams are
 * ClusterIP services), but link-local / cloud metadata addresses never are.
 */
async function checkUpstreamUrl(raw: string): Promise<string> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new HttpError(400, 'url: not a valid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new HttpError(400, 'url: must be http(s)');
  if (url.username || url.password) throw new HttpError(400, 'url: put credentials in the credential field');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const blocked = (addr: string) => /^169\.254\./.test(addr) || /^fe80:/i.test(addr) || addr === 'fd00:ec2::254';
  if (host === 'metadata.google.internal' || (isIP(host) && blocked(host))) {
    throw new HttpError(400, 'url: link-local and metadata addresses are not allowed');
  }
  if (!isIP(host)) {
    const addrs = await lookup(host, { all: true }).catch(() => []);
    if (addrs.some((a) => blocked(a.address))) throw new HttpError(400, 'url: resolves to a link-local address');
  }
  return url.toString();
}

const serverInput = z.object({
  name: z
    .string()
    .regex(SERVER_NAME, 'lowercase letters, digits and "-", starting with a letter (max 30)')
    .refine((n) => n !== GATEWAY, `"${GATEWAY}" is reserved for the gateway's own tools`),
  url: z.string().min(1),
  authType: z.enum(['none', 'bearer', 'header']).default('none'),
  authHeader: z.string().regex(/^[A-Za-z0-9-]{1,64}$/, 'invalid header name').optional().nullable(),
  credential: z.string().max(4096).optional(),
  enabled: z.boolean().default(true),
});

/**
 * Never includes the credential: only whether one is set. Members only see the tools they may
 * use; admins see every tool with its adminOnly flag.
 */
function publicServer(row: ServerRow, upstreams: Upstreams, restrictions: Restrictions, role: User['role']) {
  const snap = upstreams.snapshot(row);
  const set = restrictions.get(row.id);
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    authType: row.auth_type,
    authHeader: row.auth_header,
    hasCredential: !!row.credential_enc,
    enabled: row.enabled,
    status: snap.status,
    error: snap.error,
    checkedAt: snap.checkedAt,
    latencyMs: snap.latencyMs,
    adminOnly: !!set?.has('*'),
    tools: snap.tools
      .filter((t) => allowed(restrictions, role, row.id, t.name))
      .map((t) => ({
        name: t.name,
        fullName: `${row.name}${SEPARATOR}${t.name}`,
        description: t.description ?? '',
        adminOnly: !!set && (set.has('*') || set.has(t.name)),
      })),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function apiRouter(db: Db, config: Config, upstreams: Upstreams): express.Router {
  const api = express.Router();
  api.use(sessionAuth(db));
  api.use(requireSameOrigin);

  const startSession = async (res: Response, userId: number) => {
    const { token, hash } = newToken();
    await db.query(`INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, now() + $3 * interval '1 hour')`, [
      hash,
      userId,
      config.sessionHours,
    ]);
    res.cookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: config.cookieSecure,
      path: '/',
      maxAge: config.sessionHours * 3_600_000,
    });
  };

  // ---------- Public ----------
  api.get('/config', (_req, res) => {
    res.json({
      mcpUrl: `${config.publicUrl}/mcp`,
      llm: { configured: llmConfigured(config), provider: config.llm.provider || null, model: config.llm.model || null },
    });
  });

  api.post('/auth/login', async (req, res) => {
    const body = parse(z.object({ email: z.string(), password: z.string() }), req.body);
    const { rows } = await db.query<User & { password_hash: string; disabled: boolean }>(
      'SELECT id, email, name, role, password_hash, disabled FROM users WHERE email = $1',
      [body.email.trim().toLowerCase()],
    );
    const user = rows[0];
    if (!user || user.disabled || !(await verifyPassword(body.password, user.password_hash))) {
      throw new HttpError(401, 'Wrong email or password');
    }
    await startSession(res, user.id);
    res.json({ id: user.id, email: user.email, name: user.name, role: user.role });
  });

  api.post('/auth/logout', async (req, res) => {
    const token = sessionToken(req);
    if (token) await db.query('DELETE FROM sessions WHERE token_hash = $1', [sha256(token)]);
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    res.json({ ok: true });
  });

  const findInvite = async (token: string) => {
    const { rows } = await db.query<{ id: number; email: string; role: 'admin' | 'member' }>(
      'SELECT id, email, role FROM invites WHERE token_hash = $1 AND accepted_at IS NULL AND expires_at > now()',
      [sha256(token)],
    );
    if (!rows[0]) throw new HttpError(404, 'This invite link is invalid, used or expired');
    return rows[0];
  };

  api.get('/invites/:token', async (req, res) => {
    const invite = await findInvite(String(req.params.token));
    res.json({ email: invite.email, role: invite.role });
  });

  api.post('/invites/:token/accept', async (req, res) => {
    const invite = await findInvite(String(req.params.token));
    const body = parse(z.object({ name: z.string().trim().min(1).max(80), password: z.string().min(8).max(200) }), req.body);
    const exists = await db.query('SELECT 1 FROM users WHERE email = $1', [invite.email]);
    if (exists.rowCount) throw new HttpError(409, 'A user with this email already exists');
    const { rows } = await db.query<User>(
      `INSERT INTO users (email, name, role, password_hash) VALUES ($1, $2, $3, $4) RETURNING id, email, name, role`,
      [invite.email, body.name, invite.role, await hashPassword(body.password)],
    );
    await db.query('UPDATE invites SET accepted_at = now() WHERE id = $1', [invite.id]);
    await startSession(res, rows[0].id);
    res.json(rows[0]);
  });

  // ---------- Logged in ----------
  api.use(requireUser);
  const me = (req: Request) => req.user as User;

  api.get('/me', (req, res) => {
    res.json(me(req));
  });

  /** One server as the caller may see it (admin-only routes pass an admin). */
  const serverView = async (row: ServerRow, user: User) => publicServer(row, upstreams, await upstreams.restrictions(), user.role);

  api.get('/servers', async (req, res) => {
    // Show the newest health check of any replica, so every replica reports the same status.
    const [rows, restrictions] = await Promise.all([upstreams.servers(), upstreams.restrictions(), upstreams.sync()]);
    res.json(rows.map((r) => publicServer(r, upstreams, restrictions, me(req).role)));
  });

  api.get('/tools', async (req, res) => {
    const tools = await upstreams.listTools(me(req));
    res.json(tools.map((t) => ({ name: t.name, description: t.description ?? '' })));
  });

  // Personal API keys (any user). The plain key is returned exactly once.
  const createKey = async (userId: number, createdBy: number, name: string) => {
    const { key, prefix, hash } = newApiKey();
    const { rows } = await db.query<{ id: number; created_at: Date }>(
      'INSERT INTO api_keys (user_id, name, prefix, key_hash, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING id, created_at',
      [userId, name, prefix, hash, createdBy],
    );
    return { id: rows[0].id, name, prefix, key, createdAt: rows[0].created_at };
  };
  const keyName = z.object({ name: z.string().trim().min(1).max(60).default('default') });
  const keyColumns = 'id, user_id AS "userId", name, prefix, created_at AS "createdAt", last_used_at AS "lastUsedAt", revoked_at AS "revokedAt"';

  api.get('/keys', async (req, res) => {
    const { rows } = await db.query(`SELECT ${keyColumns} FROM api_keys WHERE user_id = $1 ORDER BY id DESC`, [me(req).id]);
    res.json(rows);
  });

  api.post('/keys', async (req, res) => {
    const body = parse(keyName, req.body ?? {});
    res.status(201).json(await createKey(me(req).id, me(req).id, body.name));
  });

  api.delete('/keys/:id', async (req, res) => {
    const user = me(req);
    const { rowCount } = await db.query(
      `UPDATE api_keys SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL AND (user_id = $2 OR $3)`,
      [id(req), user.id, user.role === 'admin'],
    );
    if (!rowCount) throw new HttpError(404, 'No such active key');
    res.json({ ok: true });
  });

  api.get('/audit', async (req, res) => {
    const user = me(req);
    const q = parse(
      z.object({
        limit: z.coerce.number().int().min(1).max(500).default(100),
        userId: z.coerce.number().int().optional(),
        server: z.string().optional(),
        outcome: z.enum(['success', 'error', 'denied']).optional(),
      }),
      req.query,
    );
    // Members only ever see their own calls.
    const userId = user.role === 'admin' ? q.userId : user.id;
    const { rows } = await db.query(
      `SELECT id, at, user_id AS "userId", user_email AS "userEmail", via, server_name AS "server", tool,
              duration_ms AS "durationMs", outcome, error
       FROM audit_log
       WHERE ($1::int IS NULL OR user_id = $1) AND ($2::text IS NULL OR server_name = $2) AND ($3::text IS NULL OR outcome = $3)
       ORDER BY id DESC LIMIT $4`,
      [userId ?? null, q.server ?? null, q.outcome ?? null, q.limit],
    );
    res.json(rows);
  });

  // Observability: call volume, error rate and latency per server, from the audit log (so it covers
  // every replica). Members get their own calls only, like the audit log itself.
  api.get('/stats', async (req, res) => {
    const user = me(req);
    const q = parse(z.object({ hours: z.coerce.number().int().min(1).max(720).default(24) }), req.query);
    const { rows } = await db.query(
      `SELECT COALESCE(server_name, '(gateway)') AS server,
              count(*)::int AS calls,
              (count(*) FILTER (WHERE outcome = 'error'))::int AS errors,
              (count(*) FILTER (WHERE outcome = 'denied'))::int AS denied,
              (percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms) FILTER (WHERE outcome <> 'denied'))::int AS "p50Ms",
              (percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms) FILTER (WHERE outcome <> 'denied'))::int AS "p95Ms",
              max(at) AS "lastCallAt"
       FROM audit_log
       WHERE at > now() - $1 * interval '1 hour' AND ($2::int IS NULL OR user_id = $2)
       GROUP BY 1 ORDER BY calls DESC`,
      [q.hours, user.role === 'admin' ? null : user.id],
    );
    res.json({ hours: q.hours, servers: rows });
  });

  api.post('/chat', async (req, res) => {
    if (!llmConfigured(config)) {
      throw new HttpError(503, 'The chat agent has no LLM configured yet (set the LLM Secret, see README).');
    }
    const body = parse(
      z.object({
        messages: z
          .array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().min(1).max(20_000) }))
          .min(1)
          .max(40),
        // Omitted: search mode is chosen automatically above TOOL_SEARCH_THRESHOLD tools.
        toolMode: z.enum(['all', 'search']).optional(),
      }),
      req.body,
    );
    if (body.messages[body.messages.length - 1].role !== 'user') throw new HttpError(400, 'Last message must be from the user');
    const limit = await hit(db, `chat:${me(req).id}`, config.chatRateLimit);
    if (!limit.ok) {
      throw new HttpError(429, `Chat rate limit: ${config.chatRateLimit} messages per minute. Try again in ${limit.retryAfter} s.`);
    }
    try {
      res.json(await runChat(config, upstreams, me(req), body.messages, body.toolMode));
    } catch (err) {
      console.error('Chat failed:', err);
      throw new HttpError(502, `LLM request failed: ${(err as Error).message.slice(0, 300)}`);
    }
  });

  // ---------- Admin ----------
  api.use(requireAdmin);

  api.post('/servers', async (req, res) => {
    const body = parse(serverInput, req.body);
    const url = await checkUpstreamUrl(body.url);
    if (body.authType !== 'none' && !body.credential) throw new HttpError(400, 'credential: required for this auth type');
    const { rows } = await db
      .query<ServerRow>(
        `INSERT INTO servers (name, url, auth_type, auth_header, credential_enc, enabled) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [
          body.name,
          url,
          body.authType,
          body.authType === 'header' ? (body.authHeader ?? 'X-API-Key') : null,
          body.authType !== 'none' && body.credential ? encrypt(body.credential, config.credentialsKey) : null,
          body.enabled,
        ],
      )
      .catch((err: { code?: string }) => {
        if (err.code === '23505') throw new HttpError(409, `A server named '${body.name}' already exists`);
        throw err;
      });
    await upstreams.check(rows[0]);
    res.status(201).json(await serverView(rows[0], me(req)));
  });

  api.patch('/servers/:id', async (req, res) => {
    const serverId = id(req);
    const current = (await db.query<ServerRow>('SELECT * FROM servers WHERE id = $1', [serverId])).rows[0];
    if (!current) throw new HttpError(404, 'No such server');
    // credential: omitted = keep, "" = remove, text = replace.
    const body = parse(serverInput.partial().extend({ authType: z.enum(['none', 'bearer', 'header']).optional(), enabled: z.boolean().optional() }), req.body);
    const authType = body.authType ?? current.auth_type;
    let credential = current.credential_enc;
    if (body.credential !== undefined) credential = body.credential ? encrypt(body.credential, config.credentialsKey) : null;
    if (authType === 'none') credential = null;
    if (authType !== 'none' && !credential) throw new HttpError(400, 'credential: required for this auth type');
    const { rows } = await db
      .query<ServerRow>(
        `UPDATE servers SET name = $2, url = $3, auth_type = $4, auth_header = $5, credential_enc = $6, enabled = $7, updated_at = now()
         WHERE id = $1 RETURNING *`,
        [
          serverId,
          body.name ?? current.name,
          body.url !== undefined ? await checkUpstreamUrl(body.url) : current.url,
          authType,
          authType === 'header' ? (body.authHeader ?? current.auth_header ?? 'X-API-Key') : null,
          credential,
          body.enabled ?? current.enabled,
        ],
      )
      .catch((err: { code?: string }) => {
        if (err.code === '23505') throw new HttpError(409, `A server named '${body.name}' already exists`);
        throw err;
      });
    await upstreams.check(rows[0]);
    res.json(await serverView(rows[0], me(req)));
  });

  // Tool permissions: make one tool (or '*' = the whole server) admin-only, or allow it again.
  api.put('/servers/:id/permissions', async (req, res) => {
    const serverId = id(req);
    const body = parse(z.object({ tool: z.string().min(1).max(128), adminOnly: z.boolean() }), req.body);
    const row = (await db.query<ServerRow>('SELECT * FROM servers WHERE id = $1', [serverId])).rows[0];
    if (!row) throw new HttpError(404, 'No such server');
    if (body.adminOnly) {
      await db.query('INSERT INTO tool_restrictions (server_id, tool) VALUES ($1, $2) ON CONFLICT DO NOTHING', [serverId, body.tool]);
    } else {
      await db.query('DELETE FROM tool_restrictions WHERE server_id = $1 AND tool = $2', [serverId, body.tool]);
    }
    res.json(await serverView(row, me(req)));
  });

  api.delete('/servers/:id', async (req, res) => {
    const { rowCount } = await db.query('DELETE FROM servers WHERE id = $1', [id(req)]);
    if (!rowCount) throw new HttpError(404, 'No such server');
    upstreams.forget(id(req));
    res.json({ ok: true });
  });

  api.post('/servers/:id/refresh', async (req, res) => {
    const row = (await db.query<ServerRow>('SELECT * FROM servers WHERE id = $1', [id(req)])).rows[0];
    if (!row) throw new HttpError(404, 'No such server');
    await upstreams.check(row);
    res.json(await serverView(row, me(req)));
  });

  api.get('/users', async (_req, res) => {
    const { rows } = await db.query(
      `SELECT u.id, u.email, u.name, u.role, u.disabled, u.created_at AS "createdAt",
              COALESCE(json_agg(json_build_object('id', k.id, 'name', k.name, 'prefix', k.prefix, 'createdAt', k.created_at,
                'lastUsedAt', k.last_used_at, 'revokedAt', k.revoked_at) ORDER BY k.id DESC) FILTER (WHERE k.id IS NOT NULL), '[]') AS keys
       FROM users u LEFT JOIN api_keys k ON k.user_id = u.id GROUP BY u.id ORDER BY u.id`,
    );
    res.json(rows);
  });

  api.patch('/users/:id', async (req, res) => {
    const userId = id(req);
    const body = parse(z.object({ role: z.enum(['admin', 'member']).optional(), disabled: z.boolean().optional() }), req.body);
    if (userId === me(req).id && (body.role === 'member' || body.disabled)) {
      throw new HttpError(400, 'You cannot demote or disable yourself');
    }
    const { rows } = await db.query(
      `UPDATE users SET role = COALESCE($2, role), disabled = COALESCE($3, disabled) WHERE id = $1 RETURNING id, email, name, role, disabled`,
      [userId, body.role ?? null, body.disabled ?? null],
    );
    if (!rows[0]) throw new HttpError(404, 'No such user');
    if (body.disabled) await db.query('DELETE FROM sessions WHERE user_id = $1', [userId]);
    res.json(rows[0]);
  });

  api.post('/users/:id/keys', async (req, res) => {
    const userId = id(req);
    const exists = await db.query('SELECT 1 FROM users WHERE id = $1', [userId]);
    if (!exists.rowCount) throw new HttpError(404, 'No such user');
    const body = parse(keyName, req.body ?? {});
    res.status(201).json(await createKey(userId, me(req).id, body.name));
  });

  api.get('/invites', async (_req, res) => {
    const { rows } = await db.query(
      `SELECT id, email, role, created_at AS "createdAt", expires_at AS "expiresAt" FROM invites
       WHERE accepted_at IS NULL AND expires_at > now() ORDER BY id DESC`,
    );
    res.json(rows);
  });

  api.post('/invites', async (req, res) => {
    const body = parse(z.object({ email: z.email(), role: z.enum(['admin', 'member']).default('member') }), req.body);
    const email = body.email.toLowerCase();
    const exists = await db.query('SELECT 1 FROM users WHERE email = $1', [email]);
    if (exists.rowCount) throw new HttpError(409, 'This person already has an account');
    const { token, hash } = newToken();
    const { rows } = await db.query<{ id: number }>(
      `INSERT INTO invites (email, role, token_hash, created_by, expires_at) VALUES ($1, $2, $3, $4, now() + interval '7 days') RETURNING id`,
      [email, body.role, hash, me(req).id],
    );
    // No mail server: the admin copies the one-time link and sends it to the person.
    res.status(201).json({ id: rows[0].id, email, role: body.role, link: `${config.publicUrl}/#/invite/${token}` });
  });

  api.delete('/invites/:id', async (req, res) => {
    await db.query('DELETE FROM invites WHERE id = $1 AND accepted_at IS NULL', [id(req)]);
    res.json({ ok: true });
  });

  return api;
}

export function apiErrorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  if ((err as { type?: string }).type === 'entity.parse.failed') {
    res.status(400).json({ error: 'Body is not valid JSON' });
    return;
  }
  console.error('API error:', err);
  res.status(500).json({ error: 'Internal server error' });
}
