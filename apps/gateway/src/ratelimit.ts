// Rate limits per API key (MCP) and per user (chat). Fixed one-minute windows counted in
// PostgreSQL, so a limit holds across every gateway replica.
import type { Db } from './db.js';

export interface Hit {
  ok: boolean;
  /** Seconds until the current window ends. */
  retryAfter: number;
}

/** Counts one request in `bucket` and says whether it is within `limit` per minute (0 = no limit). */
export async function hit(db: Db, bucket: string, limit: number): Promise<Hit> {
  if (limit <= 0) return { ok: true, retryAfter: 0 };
  const { rows } = await db.query<{ count: number; retry: number }>(
    `INSERT INTO rate_limits (bucket, window_start, count) VALUES ($1, date_trunc('minute', now()), 1)
     ON CONFLICT (bucket, window_start) DO UPDATE SET count = rate_limits.count + 1
     RETURNING count, ceil(60 - extract(second FROM now()))::int AS retry`,
    [bucket],
  );
  return { ok: rows[0].count <= limit, retryAfter: Math.max(1, rows[0].retry) };
}

export async function pruneRateLimits(db: Db): Promise<void> {
  await db.query(`DELETE FROM rate_limits WHERE window_start < now() - interval '5 minutes'`);
}
