import { Fragment, useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, timeAgo, type ServerInfo, type User } from '../api';

interface FormState {
  name: string;
  url: string;
  authType: 'none' | 'bearer' | 'header';
  authHeader: string;
  credential: string;
}

const emptyForm: FormState = { name: '', url: '', authType: 'bearer', authHeader: 'X-API-Key', credential: '' };

export function ServersPage({ user }: { user: User }) {
  const isAdmin = user.role === 'admin';
  const [servers, setServers] = useState<ServerInfo[]>([]);
  const [error, setError] = useState('');
  const [open, setOpen] = useState<number | null>(null);
  /** null = closed, 0 = new server, id = editing that server. */
  const [editing, setEditing] = useState<number | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm);

  const load = useCallback(() => {
    api<ServerInfo[]>('GET', '/servers')
      .then((s) => {
        setServers(s);
        setError('');
      })
      .catch((err: Error) => setError(err.message));
  }, []);

  useEffect(() => {
    load();
    const timer = setInterval(load, 5000);
    return () => clearInterval(timer);
  }, [load]);

  const act = async (fn: () => Promise<unknown>) => {
    setError('');
    try {
      await fn();
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const startEdit = (s: ServerInfo) => {
    setEditing(s.id);
    setForm({ name: s.name, url: s.url, authType: s.authType, authHeader: s.authHeader ?? 'X-API-Key', credential: '' });
  };

  const save = (e: FormEvent) => {
    e.preventDefault();
    const body: Record<string, unknown> = {
      name: form.name,
      url: form.url,
      authType: form.authType,
      authHeader: form.authType === 'header' ? form.authHeader : null,
    };
    // Editing: an empty credential field keeps the stored one.
    if (form.credential || editing === 0) body.credential = form.credential;
    void act(async () => {
      if (editing === 0) await api('POST', '/servers', body);
      else await api('PATCH', `/servers/${editing}`, body);
      setEditing(null);
      setForm(emptyForm);
    });
  };

  return (
    <section>
      <div className="title-row">
        <h2>MCP servers</h2>
        {isAdmin && editing === null && (
          <button
            onClick={() => {
              setEditing(0);
              setForm(emptyForm);
            }}
          >
            + Add server
          </button>
        )}
      </div>
      <p className="muted">
        Every enabled server's tools are available through the one gateway endpoint as{' '}
        <code>&lt;server&gt;__&lt;tool&gt;</code>. Status refreshes every few seconds.
      </p>
      {error && <p className="error">{error}</p>}

      {editing !== null && (
        <form className="card" onSubmit={save}>
          <h3>{editing === 0 ? 'Add MCP server' : `Edit ${form.name}`}</h3>
          <div className="grid2">
            <label>
              Name (tool prefix)
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="notes" required />
            </label>
            <label>
              Streamable HTTP URL
              <input
                value={form.url}
                onChange={(e) => setForm({ ...form, url: e.target.value })}
                placeholder="http://urumi-notes-mcp/mcp"
                required
              />
            </label>
            <label>
              Credential type
              <select value={form.authType} onChange={(e) => setForm({ ...form, authType: e.target.value as FormState['authType'] })}>
                <option value="none">None</option>
                <option value="bearer">Bearer token</option>
                <option value="header">Custom header</option>
              </select>
            </label>
            {form.authType === 'header' && (
              <label>
                Header name
                <input value={form.authHeader} onChange={(e) => setForm({ ...form, authHeader: e.target.value })} />
              </label>
            )}
            {form.authType !== 'none' && (
              <label>
                {editing === 0 ? 'Credential' : 'New credential (leave empty to keep the current one)'}
                <input
                  type="password"
                  value={form.credential}
                  onChange={(e) => setForm({ ...form, credential: e.target.value })}
                  autoComplete="off"
                  required={editing === 0}
                />
              </label>
            )}
          </div>
          <p className="muted small">The credential is encrypted in the gateway database and is never sent back to any browser or client.</p>
          <div className="row">
            <button type="submit">{editing === 0 ? 'Add' : 'Save'}</button>
            <button type="button" className="secondary" onClick={() => setEditing(null)}>
              Cancel
            </button>
          </div>
        </form>
      )}

      <table>
        <thead>
          <tr>
            <th>Server</th>
            <th>Status</th>
            <th>Tools</th>
            <th>Credential</th>
            {isAdmin && <th />}
          </tr>
        </thead>
        <tbody>
          {servers.map((s) => (
            <Fragment key={s.id}>
              <tr>
                <td>
                  <b>{s.name}</b>
                  <div className="muted small mono">{s.url}</div>
                </td>
                <td>
                  <span className={`status ${s.status}`}>{label(s.status)}</span>
                  {s.error && <div className="error small">{s.error}</div>}
                  <div className="muted small">
                    checked {timeAgo(s.checkedAt)}
                    {s.latencyMs !== null && ` · ${s.latencyMs} ms`}
                  </div>
                </td>
                <td>
                  <button className="link" onClick={() => setOpen(open === s.id ? null : s.id)}>
                    {s.tools.length} tool{s.tools.length === 1 ? '' : 's'} {open === s.id ? '▲' : '▼'}
                  </button>
                </td>
                <td className="small">{s.authType === 'none' ? 'none' : `${s.authType}${s.hasCredential ? ' (set)' : ''}`}</td>
                {isAdmin && (
                  <td className="actions">
                    <button className="secondary" onClick={() => act(() => api('PATCH', `/servers/${s.id}`, { enabled: !s.enabled }))}>
                      {s.enabled ? 'Disable' : 'Enable'}
                    </button>
                    <button className="secondary" onClick={() => startEdit(s)}>
                      Edit
                    </button>
                    <button className="secondary" onClick={() => act(() => api('POST', `/servers/${s.id}/refresh`))}>
                      Check
                    </button>
                    <button
                      className="danger"
                      onClick={() => confirm(`Remove server '${s.name}'?`) && act(() => api('DELETE', `/servers/${s.id}`))}
                    >
                      Remove
                    </button>
                  </td>
                )}
              </tr>
              {open === s.id && (
                <tr className="sub">
                  <td colSpan={isAdmin ? 5 : 4}>
                    {s.tools.length === 0 && <span className="muted">No tools (server is not connected).</span>}
                    <ul className="tools">
                      {s.tools.map((t) => (
                        <li key={t.name}>
                          <code>{t.fullName}</code> <span className="muted">{t.description}</span>
                        </li>
                      ))}
                    </ul>
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function label(status: ServerInfo['status']): string {
  return { connected: 'Connected', unreachable: 'Unreachable', disabled: 'Disabled', unknown: 'Checking…' }[status];
}
