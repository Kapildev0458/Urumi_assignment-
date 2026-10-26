// Tiny client for the gateway REST API. The session lives in an httpOnly cookie; the custom header
// is the gateway's cross-site request check.

export interface User {
  id: number;
  email: string;
  name: string;
  role: 'admin' | 'member';
}

export interface ServerInfo {
  id: number;
  name: string;
  url: string;
  authType: 'none' | 'bearer' | 'header';
  authHeader: string | null;
  hasCredential: boolean;
  enabled: boolean;
  status: 'connected' | 'unreachable' | 'disabled' | 'unknown';
  error: string | null;
  checkedAt: string | null;
  latencyMs: number | null;
  /** Every tool of this server is admin-only. */
  adminOnly: boolean;
  /** Members only receive the tools they may use. */
  tools: { name: string; fullName: string; description: string; adminOnly: boolean }[];
}

export interface ApiKey {
  id: number;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export interface NewKey {
  id: number;
  name: string;
  prefix: string;
  key: string;
}

export interface Member extends User {
  disabled: boolean;
  createdAt: string;
  keys: ApiKey[];
}

export interface Invite {
  id: number;
  email: string;
  role: string;
  createdAt: string;
  expiresAt: string;
  link?: string;
}

export interface AuditRow {
  id: string;
  at: string;
  userId: number | null;
  userEmail: string | null;
  via: 'mcp' | 'chat';
  server: string | null;
  tool: string;
  durationMs: number;
  outcome: 'success' | 'error' | 'denied';
  error: string | null;
}

export interface ChatStep {
  tool: string;
  arguments: unknown;
  ok: boolean;
  durationMs: number;
  result: string;
}

export interface AppConfig {
  mcpUrl: string;
  llm: { configured: boolean; provider: string | null; model: string | null };
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', 'x-requested-with': 'urumi' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new ApiError(res.status, data.error ?? `Request failed (${res.status})`);
  return data as T;
}

export function timeAgo(iso: string | null): string {
  if (!iso) return 'never';
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
}
