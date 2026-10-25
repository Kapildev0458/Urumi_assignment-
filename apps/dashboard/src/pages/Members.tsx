import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, timeAgo, type Invite, type Member, type NewKey, type User } from '../api';
import { CopyBox } from './Keys';

export function MembersPage({ user }: { user: User }) {
  const [members, setMembers] = useState<Member[]>([]);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'member' | 'admin'>('member');
  const [newInvite, setNewInvite] = useState<Invite | null>(null);
  const [issued, setIssued] = useState<{ email: string; key: NewKey } | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    api<Member[]>('GET', '/users').then(setMembers).catch((err: Error) => setError(err.message));
    api<Invite[]>('GET', '/invites').then(setInvites).catch(() => undefined);
  }, []);
  useEffect(load, [load]);

  const act = async (fn: () => Promise<unknown>) => {
    setError('');
    try {
      await fn();
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const invite = (e: FormEvent) => {
    e.preventDefault();
    void act(async () => {
      setNewInvite(await api<Invite>('POST', '/invites', { email, role }));
      setEmail('');
    });
  };

  return (
    <section>
      <h2>Members</h2>
      {error && <p className="error">{error}</p>}

      <form className="card row" onSubmit={invite}>
        <label className="grow">
          Invite by email
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="bob@example.com" required />
        </label>
        <label>
          Role
          <select value={role} onChange={(e) => setRole(e.target.value as 'member' | 'admin')}>
            <option value="member">member</option>
            <option value="admin">admin</option>
          </select>
        </label>
        <button type="submit">Create invite</button>
      </form>

      {newInvite?.link && (
        <div className="card highlight">
          <b>Invite link for {newInvite.email}</b> (valid 7 days, single use). Send it to them:
          <CopyBox text={newInvite.link} />
        </div>
      )}
      {issued && (
        <div className="card highlight">
          <b>API key for {issued.email}. Shown only once:</b>
          <CopyBox text={issued.key.key} />
        </div>
      )}

      <table>
        <thead>
          <tr>
            <th>User</th>
            <th>Role</th>
            <th>API keys</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {members.map((m) => (
            <tr key={m.id} className={m.disabled ? 'dim' : ''}>
              <td>
                <b>{m.name}</b>
                <div className="muted small">{m.email}</div>
                {m.disabled && <span className="status disabled">Disabled</span>}
              </td>
              <td>
                <span className={`badge ${m.role}`}>{m.role}</span>
              </td>
              <td>
                {m.keys.length === 0 && <span className="muted small">none</span>}
                {m.keys.map((k) => (
                  <div key={k.id} className="small keyline">
                    <span className="mono">{k.prefix}…</span> {k.name} · used {timeAgo(k.lastUsedAt)}{' '}
                    {k.revokedAt ? (
                      <span className="status disabled">revoked</span>
                    ) : (
                      <button
                        className="link danger-text"
                        onClick={() => confirm(`Revoke ${m.name}'s key "${k.name}"?`) && act(() => api('DELETE', `/keys/${k.id}`))}
                      >
                        revoke
                      </button>
                    )}
                  </div>
                ))}
              </td>
              <td className="actions">
                <button
                  className="secondary"
                  onClick={() =>
                    act(async () => setIssued({ email: m.email, key: await api<NewKey>('POST', `/users/${m.id}/keys`, { name: 'issued-by-admin' }) }))
                  }
                >
                  Issue key
                </button>
                {m.id !== user.id && (
                  <>
                    <button
                      className="secondary"
                      onClick={() => act(() => api('PATCH', `/users/${m.id}`, { role: m.role === 'admin' ? 'member' : 'admin' }))}
                    >
                      Make {m.role === 'admin' ? 'member' : 'admin'}
                    </button>
                    <button className="secondary" onClick={() => act(() => api('PATCH', `/users/${m.id}`, { disabled: !m.disabled }))}>
                      {m.disabled ? 'Enable' : 'Disable'}
                    </button>
                  </>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {invites.length > 0 && (
        <>
          <h3>Pending invites</h3>
          <table>
            <tbody>
              {invites.map((i) => (
                <tr key={i.id}>
                  <td>{i.email}</td>
                  <td>{i.role}</td>
                  <td className="muted small">expires {new Date(i.expiresAt).toLocaleDateString()}</td>
                  <td>
                    <button className="link danger-text" onClick={() => act(() => api('DELETE', `/invites/${i.id}`))}>
                      cancel
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}
