// Prometheus metrics in the text exposition format, kept in memory per replica (Prometheus sums
// replicas). Served on GET /metrics on the pod port only: the Ingress routes just /api and /mcp,
// so the endpoint is not public.
import type { AuditEntry } from './audit.js';
import type { Upstreams } from './upstreams.js';

const BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30];

interface Histogram {
  counts: number[];
  sum: number;
  count: number;
}

const calls = new Map<string, number>();
const durations = new Map<string, Histogram>();

const esc = (v: string) => v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
const labels = (l: Record<string, string>) =>
  `{${Object.entries(l)
    .map(([k, v]) => `${k}="${esc(v)}"`)
    .join(',')}}`;

/** Called for every audited call, so metrics and the audit log always agree. */
export function recordCall(entry: AuditEntry): void {
  const server = entry.serverName ?? '';
  const key = labels({ server, tool: entry.tool, via: entry.via, outcome: entry.outcome });
  calls.set(key, (calls.get(key) ?? 0) + 1);
  if (entry.outcome === 'denied') return;
  const h = durations.get(server) ?? { counts: BUCKETS.map(() => 0), sum: 0, count: 0 };
  const seconds = entry.durationMs / 1000;
  BUCKETS.forEach((b, i) => {
    if (seconds <= b) h.counts[i]++;
  });
  h.sum += seconds;
  h.count++;
  durations.set(server, h);
}

export async function renderMetrics(upstreams: Upstreams): Promise<string> {
  const out: string[] = [];
  out.push('# HELP urumi_tool_calls_total Tool calls through the gateway.', '# TYPE urumi_tool_calls_total counter');
  for (const [key, n] of calls) out.push(`urumi_tool_calls_total${key} ${n}`);

  out.push(
    '# HELP urumi_tool_call_duration_seconds Upstream tool call latency (denied calls excluded).',
    '# TYPE urumi_tool_call_duration_seconds histogram',
  );
  for (const [server, h] of durations) {
    BUCKETS.forEach((b, i) =>
      out.push(`urumi_tool_call_duration_seconds_bucket${labels({ server, le: String(b) })} ${h.counts[i]}`),
    );
    out.push(`urumi_tool_call_duration_seconds_bucket${labels({ server, le: '+Inf' })} ${h.count}`);
    out.push(`urumi_tool_call_duration_seconds_sum${labels({ server })} ${h.sum}`);
    out.push(`urumi_tool_call_duration_seconds_count${labels({ server })} ${h.count}`);
  }

  out.push('# HELP urumi_upstream_up 1 if the last health check connected.', '# TYPE urumi_upstream_up gauge');
  out.push('# HELP urumi_upstream_tools Tools the upstream exposes.', '# TYPE urumi_upstream_tools gauge');
  for (const row of await upstreams.servers()) {
    const snap = upstreams.snapshot(row);
    const l = labels({ server: row.name, status: snap.status });
    out.push(`urumi_upstream_up${l} ${snap.status === 'connected' ? 1 : 0}`);
    out.push(`urumi_upstream_tools${l} ${snap.tools.length}`);
  }
  return out.join('\n') + '\n';
}
