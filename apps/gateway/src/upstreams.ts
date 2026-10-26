// Upstream MCP servers: the registry rows, a cached health/tool snapshot per server, aggregated
// tool listing and routed tool calls. Upstreams are stateless Streamable HTTP servers, so every
// check and call opens a short-lived client; a dead upstream only ever costs its own timeout.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import { writeAudit } from './audit.js';
import type { Config } from './config.js';
import type { Db } from './db.js';
import { decrypt } from './security.js';

/**
 * Collision scheme: every tool is exposed as "<server name>__<tool name>". Server names are
 * unique slugs ([a-z0-9-], no "__"), so the first "__" always splits a name unambiguously, and two
 * servers that both have e.g. "search" become "notes__search" and "docs__search".
 */
export const SEPARATOR = '__';
export const SERVER_NAME = /^[a-z][a-z0-9-]{0,29}$/;

export interface ServerRow {
  id: number;
  name: string;
  url: string;
  auth_type: 'none' | 'bearer' | 'header';
  auth_header: string | null;
  credential_enc: string | null;
  enabled: boolean;
  created_at: Date;
  updated_at: Date;
}

export type Status = 'connected' | 'unreachable' | 'disabled' | 'unknown';

export interface Snapshot {
  status: Status;
  error: string | null;
  tools: Tool[];
  checkedAt: Date | null;
  latencyMs: number | null;
}

export interface Caller {
  id: number;
  email: string;
  role: 'admin' | 'member';
}

/** Admin-only tools per server id: upstream tool names, or '*' for the whole server. */
export type Restrictions = Map<number, Set<string>>;

/** Tool permissions: admins may use everything, members only what is not restricted. */
export function allowed(restrictions: Restrictions, role: Caller['role'], serverId: number, tool: string): boolean {
  if (role === 'admin') return true;
  const set = restrictions.get(serverId);
  return !set || !(set.has('*') || set.has(tool));
}

export class Upstreams {
  private snapshots = new Map<number, Snapshot>();
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private db: Db,
    private config: Config,
  ) {}

  async servers(): Promise<ServerRow[]> {
    const { rows } = await this.db.query<ServerRow>('SELECT * FROM servers ORDER BY id');
    return rows;
  }

  /** Read on every list and call (like `enabled`), so a change applies at once on every replica. */
  async restrictions(): Promise<Restrictions> {
    const { rows } = await this.db.query<{ server_id: number; tool: string }>('SELECT server_id, tool FROM tool_restrictions');
    const map: Restrictions = new Map();
    for (const r of rows) map.set(r.server_id, (map.get(r.server_id) ?? new Set()).add(r.tool));
    return map;
  }

  snapshot(row: ServerRow): Snapshot {
    if (!row.enabled) return { status: 'disabled', error: null, tools: [], checkedAt: null, latencyMs: null };
    return (
      this.snapshots.get(row.id) ?? { status: 'unknown', error: null, tools: [], checkedAt: null, latencyMs: null }
    );
  }

  forget(id: number): void {
    this.snapshots.delete(id);
  }

  /** The static credential stays here: it is decrypted only to build the upstream request. */
  private headers(row: ServerRow): Record<string, string> {
    if (row.auth_type === 'none' || !row.credential_enc) return {};
    const secret = decrypt(row.credential_enc, this.config.credentialsKey);
    if (row.auth_type === 'bearer') return { Authorization: `Bearer ${secret}` };
    return { [row.auth_header || 'X-API-Key']: secret };
  }

  private async connect(row: ServerRow, timeoutMs: number): Promise<Client> {
    const client = new Client({ name: 'urumi-gateway', version: '0.1.0' });
    const transport = new StreamableHTTPClientTransport(new URL(row.url), {
      requestInit: { headers: this.headers(row) },
    });
    await client.connect(transport, { timeout: timeoutMs, signal: AbortSignal.timeout(timeoutMs) });
    return client;
  }

  /** Connects, lists tools and stores the result as the server's snapshot. */
  async check(row: ServerRow): Promise<Snapshot> {
    if (!row.enabled) {
      this.snapshots.delete(row.id);
      return this.snapshot(row);
    }
    const started = Date.now();
    const timeout = this.config.listTimeoutMs;
    let client: Client | undefined;
    let snap: Snapshot;
    try {
      client = await this.connect(row, timeout);
      const tools: Tool[] = [];
      let cursor: string | undefined;
      do {
        const page = await client.listTools(cursor ? { cursor } : {}, { timeout, signal: AbortSignal.timeout(timeout) });
        tools.push(...page.tools);
        cursor = page.nextCursor;
      } while (cursor && tools.length < 500);
      snap = { status: 'connected', error: null, tools, checkedAt: new Date(), latencyMs: Date.now() - started };
    } catch (err) {
      snap = { status: 'unreachable', error: describeError(err, timeout), tools: [], checkedAt: new Date(), latencyMs: null };
    } finally {
      await client?.close().catch(() => undefined);
    }
    this.snapshots.set(row.id, snap);
    return snap;
  }

  async refreshAll(): Promise<void> {
    const rows = await this.servers();
    const ids = new Set(rows.map((r) => r.id));
    for (const id of this.snapshots.keys()) if (!ids.has(id)) this.snapshots.delete(id);
    await Promise.allSettled(rows.map((row) => this.check(row)));
  }

  start(): void {
    void this.refreshAll().catch((err) => console.error('Upstream refresh failed:', err));
    this.timer = setInterval(() => {
      void this.refreshAll().catch((err) => console.error('Upstream refresh failed:', err));
    }, this.config.refreshIntervalMs);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
  }

  /**
   * Aggregated tool list for one caller. The enabled flag and tool permissions are read from the
   * database on every call, so a change applies immediately on every gateway replica; tools come
   * from the snapshot. Tools the caller's role may not use are left out.
   */
  async listTools(caller: Pick<Caller, 'role'>): Promise<Tool[]> {
    const rows = (await this.servers()).filter((r) => r.enabled);
    const restrictions = await this.restrictions();
    // A server added on another replica has no snapshot here yet: check it now (bounded by timeout).
    await Promise.allSettled(rows.filter((r) => !this.snapshots.has(r.id)).map((r) => this.check(r)));
    const tools: Tool[] = [];
    for (const row of rows) {
      const snap = this.snapshot(row);
      if (snap.status !== 'connected') continue;
      for (const tool of snap.tools) {
        if (!allowed(restrictions, caller.role, row.id, tool.name)) continue;
        tools.push({
          ...tool,
          name: `${row.name}${SEPARATOR}${tool.name}`,
          title: tool.title ? `${tool.title} (${row.name})` : undefined,
          description: `[${row.name}] ${tool.description ?? ''}`.trim(),
        });
      }
    }
    return tools;
  }

  /** Routes "<server>__<tool>" to its server, with a timeout, and writes the audit row. */
  async callTool(
    fullName: string,
    args: Record<string, unknown> | undefined,
    caller: Caller,
    via: 'mcp' | 'chat',
  ): Promise<CallToolResult> {
    const started = Date.now();
    const cut = fullName.indexOf(SEPARATOR);
    const serverName = cut > 0 ? fullName.slice(0, cut) : null;
    const tool = cut > 0 ? fullName.slice(cut + SEPARATOR.length) : fullName;
    const audit = (outcome: 'success' | 'error' | 'denied', error?: string) =>
      writeAudit(this.db, {
        userId: caller.id,
        userEmail: caller.email,
        via,
        serverName,
        tool,
        durationMs: Date.now() - started,
        outcome,
        error,
      });

    const row = serverName
      ? (await this.db.query<ServerRow>('SELECT * FROM servers WHERE name = $1', [serverName])).rows[0]
      : undefined;
    if (!row || !row.enabled) {
      const message = !row
        ? `Unknown tool '${fullName}'. Tool names look like <server>${SEPARATOR}<tool>.`
        : `Server '${row.name}' is disabled.`;
      await audit('error', message);
      return errorResult(message);
    }
    // Hidden tools are also rejected when called by name.
    if (!allowed(await this.restrictions(), caller.role, row.id, tool)) {
      const message = `Tool '${fullName}' is restricted to admins.`;
      await audit('denied', message);
      return errorResult(message);
    }

    const timeout = this.config.callTimeoutMs;
    let client: Client | undefined;
    try {
      try {
        client = await this.connect(row, Math.min(timeout, this.config.listTimeoutMs));
      } catch (err) {
        const message = `Server '${row.name}' is unreachable: ${describeError(err, this.config.listTimeoutMs)}`;
        const prev = this.snapshots.get(row.id);
        this.snapshots.set(row.id, { ...(prev ?? emptySnapshot()), status: 'unreachable', error: message, checkedAt: new Date() });
        await audit('error', message);
        return errorResult(message);
      }
      const result = (await client.callTool({ name: tool, arguments: args ?? {} }, undefined, {
        timeout,
        signal: AbortSignal.timeout(timeout),
      })) as CallToolResult;
      await audit(result.isError ? 'error' : 'success', result.isError ? textOf(result) : undefined);
      return result;
    } catch (err) {
      const message = `Call to '${fullName}' failed: ${describeError(err, timeout)}`;
      await audit('error', message);
      return errorResult(message);
    } finally {
      await client?.close().catch(() => undefined);
    }
  }
}

function emptySnapshot(): Snapshot {
  return { status: 'unknown', error: null, tools: [], checkedAt: null, latencyMs: null };
}

function errorResult(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

export function textOf(result: CallToolResult): string {
  return result.content
    .map((c) => (c.type === 'text' ? c.text : `[${c.type}]`))
    .join('\n')
    .slice(0, 1000);
}

/** Short, human-readable reason (shown in the dashboard and returned to clients). */
export function describeError(err: unknown, timeoutMs: number): string {
  const e = err as { name?: string; message?: string; code?: number; cause?: { code?: string; message?: string } };
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError' || e?.code === -32001) {
    return `timed out after ${timeoutMs} ms`;
  }
  if (e?.cause?.code) return `${e.cause.code}${e.cause.message ? ` (${e.cause.message})` : ''}`;
  return (e?.message ?? String(err)).slice(0, 300);
}
