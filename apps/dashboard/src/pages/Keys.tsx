import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, timeAgo, type ApiKey, type AppConfig, type NewKey } from '../api';

export function KeysPage({ config }: { config: AppConfig | null }) {
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [name, setName] = useState('laptop');
  const [created, setCreated] = useState<NewKey | null>(null);
  const [error, setError] = useState('');
  const mcpUrl = config?.mcpUrl ?? `${window.location.origin}/mcp`;

  const load = useCallback(() => {
    api<ApiKey[]>('GET', '/keys').then(setKeys).catch((err: Error) => setError(err.message));
  }, []);
  useEffect(load, [load]);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      setCreated(await api<NewKey>('POST', '/keys', { name }));
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const revoke = async (id: number) => {
    if (!confirm('Revoke this key? Clients using it stop working immediately.')) return;
    await api('DELETE', `/keys/${id}`).catch((err: Error) => setError(err.message));
    load();
  };

  const key = created?.key ?? '<your-key>';
  return (
    <section>
      <h2>My API keys</h2>
      <p className="muted">
        One gateway URL and your key give any MCP client the tools of every enabled server. You never need the upstream
        servers' credentials.
      </p>
      {error && <p className="error">{error}</p>}

      <form className="card row" onSubmit={create}>
        <label className="grow">
          Key name
          <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={60} />
        </label>
        <button type="submit">Generate key</button>
      </form>

      {created && (
        <div className="card highlight">
          <b>New key "{created.name}". Copy it now: it is shown only once.</b>
          <CopyBox text={created.key} />
        </div>
      )}

      <div className="card">
        <h3>Connect a client</h3>
        <p className="small">Gateway URL:</p>
        <CopyBox text={mcpUrl} />
        <p className="small">Claude Code:</p>
        <CopyBox text={`claude mcp add --transport http urumi ${mcpUrl} --header "Authorization: Bearer ${key}"`} />
        <p className="small">Cursor (~/.cursor/mcp.json) or any JSON-configured client:</p>
        <CopyBox text={JSON.stringify({ mcpServers: { urumi: { url: mcpUrl, headers: { Authorization: `Bearer ${key}` } } } }, null, 2)} />
        <p className="small">
          MCP Inspector: <code>npx @modelcontextprotocol/inspector</code>, transport "Streamable HTTP", URL above, header{' '}
          <code>Authorization: Bearer &lt;key&gt;</code>.
        </p>
      </div>

      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Key</th>
            <th>Created</th>
            <th>Last used</th>
            <th>Status</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {keys.map((k) => (
            <tr key={k.id}>
              <td>{k.name}</td>
              <td className="mono">{k.prefix}…</td>
              <td>{timeAgo(k.createdAt)}</td>
              <td>{timeAgo(k.lastUsedAt)}</td>
              <td>{k.revokedAt ? <span className="status disabled">Revoked</span> : <span className="status connected">Active</span>}</td>
              <td>
                {!k.revokedAt && (
                  <button className="danger" onClick={() => revoke(k.id)}>
                    Revoke
                  </button>
                )}
              </td>
            </tr>
          ))}
          {keys.length === 0 && (
            <tr>
              <td colSpan={6} className="muted">
                No keys yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </section>
  );
}

/**
 * navigator.clipboard only exists on HTTPS (and localhost), so on the local http:// domain fall
 * back to the older execCommand('copy') on a temporary textarea.
 */
async function copyText(text: string): Promise<boolean> {
  if (window.isSecureContext && navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // fall through to the fallback
    }
  }
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  const ok = document.execCommand('copy');
  document.body.removeChild(area);
  return ok;
}

export function CopyBox({ text }: { text: string }) {
  const [copied, setCopied] = useState<'' | 'ok' | 'fail'>('');
  return (
    <div className="copybox">
      <pre>{text}</pre>
      <button
        className="secondary"
        type="button"
        onClick={() => {
          void copyText(text).then((ok) => {
            setCopied(ok ? 'ok' : 'fail');
            setTimeout(() => setCopied(''), 1500);
          });
        }}
      >
        {copied === 'ok' ? 'Copied' : copied === 'fail' ? 'Select and Ctrl+C' : 'Copy'}
      </button>
    </div>
  );
}
