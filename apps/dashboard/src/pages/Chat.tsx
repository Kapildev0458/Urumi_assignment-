import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api, type AppConfig, type ChatStep } from '../api';

interface Message {
  role: 'user' | 'assistant';
  content: string;
  steps?: ChatStep[];
  error?: boolean;
}

const examples = [
  'Create a product called "Blue Mug" priced at 12.50',
  'What orders came in today?',
  'Save a note with a summary of today\'s orders, then tell me the time in Asia/Kolkata',
];

export function ChatPage({ config }: { config: AppConfig | null }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [tools, setTools] = useState<{ name: string }[]>([]);
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api<{ name: string }[]>('GET', '/tools').then(setTools).catch(() => undefined);
  }, []);
  // Block body: an effect's return value is its cleanup, and newer browsers return a Promise here.
  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, busy]);

  const send = async (e?: FormEvent, text = input) => {
    e?.preventDefault();
    if (!text.trim() || busy) return;
    const history: Message[] = [...messages, { role: 'user', content: text.trim() }];
    setMessages(history);
    setInput('');
    setBusy(true);
    try {
      // Only text turns are sent back; the tool loop of each turn runs on the gateway.
      const payload = history.filter((m) => !m.error).map(({ role, content }) => ({ role, content }));
      const res = await api<{ reply: string; steps: ChatStep[] }>('POST', '/chat', { messages: payload });
      setMessages([...history, { role: 'assistant', content: res.reply, steps: res.steps }]);
    } catch (err) {
      setMessages([...history, { role: 'assistant', content: (err as Error).message, error: true }]);
    } finally {
      setBusy(false);
    }
  };

  const configured = config?.llm.configured;
  return (
    <section className="chat">
      <div className="title-row">
        <h2>Chat agent</h2>
        <span className="muted small">
          {configured ? `${config?.llm.provider} · ${config?.llm.model}` : 'LLM not configured'} · {tools.length} tools ·
          calls run as you and appear in the audit log
        </span>
      </div>
      {config && !configured && (
        <p className="card highlight">
          No LLM API key is configured, so the agent cannot answer yet. An admin sets one in the <code>urumi-gateway-llm</code>{' '}
          Secret (see README, "Chat agent").
        </p>
      )}

      <div className="messages">
        {messages.length === 0 && (
          <div className="muted">
            Try:
            {examples.map((ex) => (
              <button key={ex} className="example" onClick={() => send(undefined, ex)} disabled={!configured}>
                {ex}
              </button>
            ))}
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`msg ${m.role} ${m.error ? 'err' : ''}`}>
            {m.steps && m.steps.length > 0 && (
              <div className="steps">
                {m.steps.map((s, j) => (
                  <details key={j} className={s.ok ? 'ok' : 'fail'}>
                    <summary>
                      {s.ok ? '✓' : '✗'} <code>{s.tool}</code> <span className="muted small">{s.durationMs} ms</span>
                    </summary>
                    <div className="small">Arguments</div>
                    <pre>{JSON.stringify(s.arguments, null, 2)}</pre>
                    <div className="small">Result</div>
                    <pre>{s.result}</pre>
                  </details>
                ))}
              </div>
            )}
            <div className="text">{m.content}</div>
          </div>
        ))}
        {busy && <div className="msg assistant muted">Thinking and calling tools…</div>}
        <div ref={bottom} />
      </div>

      <form className="composer" onSubmit={send}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={configured ? 'Ask about products, orders, notes, time…' : 'Chat is disabled until an LLM key is configured'}
          disabled={busy || !configured}
          autoFocus
        />
        <button type="submit" disabled={busy || !configured || !input.trim()}>
          Send
        </button>
        {messages.length > 0 && (
          <button type="button" className="secondary" onClick={() => setMessages([])} disabled={busy}>
            Clear
          </button>
        )}
      </form>
    </section>
  );
}
