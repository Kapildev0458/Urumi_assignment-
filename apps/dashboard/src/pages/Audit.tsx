import { useCallback, useEffect, useState } from 'react';
import { api, timeAgo, type AuditRow, type ServerStats, type User } from '../api';

export function AuditPage({ user }: { user: User }) {
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [stats, setStats] = useState<ServerStats[]>([]);
  const [server, setServer] = useState('');
  const [outcome, setOutcome] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(() => {
    const q = new URLSearchParams({ limit: '200' });
    if (server) q.set('server', server);
    if (outcome) q.set('outcome', outcome);
    api<AuditRow[]>('GET', `/audit?${q}`)
      .then((r) => {
        setRows(r);
        setError('');
      })
      .catch((err: Error) => setError(err.message));
    api<{ servers: ServerStats[] }>('GET', '/stats?hours=24')
      .then((s) => setStats(s.servers))
      .catch(() => undefined);
  }, [server, outcome]);

  useEffect(() => {
    load();
    const timer = setInterval(load, 5000);
    return () => clearInterval(timer);
  }, [load]);

  return (
    <section>
      <div className="title-row">
        <h2>Audit log</h2>
        <div className="row">
          <input placeholder="server" value={server} onChange={(e) => setServer(e.target.value.trim())} />
          <select value={outcome} onChange={(e) => setOutcome(e.target.value)}>
            <option value="">all outcomes</option>
            <option value="success">success</option>
            <option value="error">error</option>
            <option value="denied">denied</option>
          </select>
        </div>
      </div>
      <p className="muted">
        {user.role === 'admin' ? 'Every tool call through the gateway, by every user.' : 'Your own tool calls.'} "chat" =
        dashboard chat agent, "mcp" = external client with an API key.
      </p>
      {error && <p className="error">{error}</p>}
      {stats.length > 0 && (
        <>
          <h3>Last 24 hours per server</h3>
          <table className="stats">
            <thead>
              <tr>
                <th>Server</th>
                <th>Calls</th>
                <th>Error rate</th>
                <th>Denied</th>
                <th>p50</th>
                <th>p95</th>
                <th>Last call</th>
              </tr>
            </thead>
            <tbody>
              {stats.map((s) => (
                <tr key={s.server}>
                  <td>
                    <button className="link" onClick={() => setServer(s.server === '(gateway)' ? '' : s.server)}>
                      {s.server}
                    </button>
                  </td>
                  <td>{s.calls}</td>
                  <td className={s.errors ? 'error' : ''}>
                    {s.calls - s.denied > 0 ? `${Math.round((100 * s.errors) / (s.calls - s.denied))}%` : '—'}
                    {s.errors > 0 && <span className="muted small"> ({s.errors})</span>}
                  </td>
                  <td>{s.denied}</td>
                  <td className="small">{s.p50Ms ?? '—'} ms</td>
                  <td className="small">{s.p95Ms ?? '—'} ms</td>
                  <td className="small">{timeAgo(s.lastCallAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <h3>Calls</h3>
        </>
      )}
      <table>
        <thead>
          <tr>
            <th>Time</th>
            <th>User</th>
            <th>Via</th>
            <th>Server</th>
            <th>Tool</th>
            <th>Duration</th>
            <th>Outcome</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td className="small">{new Date(r.at).toLocaleString()}</td>
              <td className="small">{r.userEmail ?? '—'}</td>
              <td>
                <span className="badge">{r.via}</span>
              </td>
              <td>{r.server ?? '—'}</td>
              <td className="mono">{r.tool}</td>
              <td className="small">{r.durationMs} ms</td>
              <td>
                <span className={`status ${r.outcome === 'success' ? 'connected' : r.outcome === 'denied' ? 'disabled' : 'unreachable'}`}>
                  {r.outcome}
                </span>
                {r.error && <div className="error small">{r.error}</div>}
              </td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={7} className="muted">
                No tool calls yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </section>
  );
}
