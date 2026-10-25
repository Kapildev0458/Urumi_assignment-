import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError, type AppConfig, type User } from './api';
import { AuditPage } from './pages/Audit';
import { ChatPage } from './pages/Chat';
import { KeysPage } from './pages/Keys';
import { MembersPage } from './pages/Members';
import { ServersPage } from './pages/Servers';

/** Hash routes (#/servers, #/invite/<token>) so nginx only has to serve index.html. */
function useRoute(): string {
  const [route, setRoute] = useState(() => window.location.hash.slice(1) || '/servers');
  useEffect(() => {
    const onHash = () => setRoute(window.location.hash.slice(1) || '/servers');
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  return route;
}

export function App() {
  const route = useRoute();
  const [user, setUser] = useState<User | null | undefined>(undefined);
  const [config, setConfig] = useState<AppConfig | null>(null);

  useEffect(() => {
    api<AppConfig>('GET', '/config').then(setConfig).catch(() => undefined);
    api<User>('GET', '/me')
      .then(setUser)
      .catch(() => setUser(null));
  }, []);

  if (route.startsWith('/invite/')) {
    return <InvitePage token={route.slice('/invite/'.length)} onDone={setUser} />;
  }
  if (user === undefined) return <div className="center muted">Loading…</div>;
  if (user === null) return <LoginPage onLogin={setUser} />;

  const logout = async () => {
    await api('POST', '/auth/logout').catch(() => undefined);
    setUser(null);
  };

  const pages: { path: string; label: string; admin?: boolean }[] = [
    { path: '/servers', label: 'Servers' },
    { path: '/chat', label: 'Chat' },
    { path: '/keys', label: 'My API keys' },
    { path: '/members', label: 'Members', admin: true },
    { path: '/audit', label: 'Audit log' },
  ];
  const page = pages.find((p) => route.startsWith(p.path) && (!p.admin || user.role === 'admin')) ?? pages[0];

  return (
    <div className="layout">
      <header>
        <div className="brand">Urumi <span>MCP Gateway</span></div>
        <nav>
          {pages
            .filter((p) => !p.admin || user.role === 'admin')
            .map((p) => (
              <a key={p.path} href={`#${p.path}`} className={p === page ? 'active' : ''}>
                {p.label}
              </a>
            ))}
        </nav>
        <div className="who">
          {user.name} <span className={`badge ${user.role}`}>{user.role}</span>
          <button className="link" onClick={logout}>
            Log out
          </button>
        </div>
      </header>
      <main>
        {page.path === '/servers' && <ServersPage user={user} />}
        {page.path === '/chat' && <ChatPage config={config} />}
        {page.path === '/keys' && <KeysPage config={config} />}
        {page.path === '/members' && <MembersPage user={user} />}
        {page.path === '/audit' && <AuditPage user={user} />}
      </main>
    </div>
  );
}

function LoginPage({ onLogin }: { onLogin: (u: User) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      onLogin(await api<User>('POST', '/auth/login', { email, password }));
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div className="center">
      <form className="card narrow" onSubmit={submit}>
        <h1>Urumi MCP Gateway</h1>
        <label>
          Email
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus required />
        </label>
        <label>
          Password
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </label>
        {error && <p className="error">{error}</p>}
        <button type="submit">Log in</button>
      </form>
    </div>
  );
}

function InvitePage({ token, onDone }: { token: string; onDone: (u: User) => void }) {
  const [invite, setInvite] = useState<{ email: string; role: string } | null>(null);
  const [error, setError] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');

  useEffect(() => {
    api<{ email: string; role: string }>('GET', `/invites/${token}`)
      .then(setInvite)
      .catch((err: ApiError) => setError(err.message));
  }, [token]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      const user = await api<User>('POST', `/invites/${token}/accept`, { name, password });
      onDone(user);
      window.location.hash = '/keys';
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div className="center">
      <form className="card narrow" onSubmit={submit}>
        <h1>Join the team</h1>
        {!invite && !error && <p className="muted">Checking invite…</p>}
        {invite && (
          <>
            <p>
              You were invited as <b>{invite.role}</b> with <b>{invite.email}</b>.
            </p>
            <label>
              Your name
              <input value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
            </label>
            <label>
              Choose a password (8+ characters)
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} minLength={8} required />
            </label>
            <button type="submit">Create account</button>
          </>
        )}
        {error && <p className="error">{error}</p>}
        <p className="muted small">
          <a href="#/servers">Back to login</a>
        </p>
      </form>
    </div>
  );
}
