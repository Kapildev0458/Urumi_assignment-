// Audit log: one row per tool call (or rejected request), attributed to a user.
import type { Db } from './db.js';
import { recordCall } from './metrics.js';

export interface AuditEntry {
  userId: number | null;
  userEmail: string | null;
  /** "mcp" (external MCP client with an API key) or "chat" (dashboard chat agent). */
  via: 'mcp' | 'chat';
  serverName: string | null;
  tool: string;
  durationMs: number;
  outcome: 'success' | 'error' | 'denied';
  error?: string | null;
}

export async function writeAudit(db: Db, entry: AuditEntry): Promise<void> {
  recordCall(entry);
  try {
    await db.query(
      `INSERT INTO audit_log (user_id, user_email, via, server_name, tool, duration_ms, outcome, error)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        entry.userId,
        entry.userEmail,
        entry.via,
        entry.serverName,
        entry.tool,
        Math.round(entry.durationMs),
        entry.outcome,
        entry.error ? entry.error.slice(0, 1000) : null,
      ],
    );
  } catch (err) {
    // Never fail a tool call because the audit insert failed, but make it loud in the logs.
    console.error('Audit write failed:', err, entry);
  }
}
