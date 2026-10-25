// Gateway backend: REST API for the dashboard (/api) and the team MCP endpoint (/mcp).
import express from 'express';
import { apiErrorHandler, apiRouter } from './api.js';
import { loadConfig } from './config.js';
import { createDb, migrateAndSeed } from './db.js';
import { mcpHandler } from './mcp.js';
import { Upstreams } from './upstreams.js';

const config = loadConfig();
const db = createDb(config);

// The database may still be starting on a fresh install: retry instead of crash-looping.
for (let attempt = 1; ; attempt++) {
  try {
    await migrateAndSeed(db, config);
    break;
  } catch (err) {
    if (attempt >= 30) throw err;
    console.log(`Database not ready (${(err as Error).message}), retrying in 2 s`);
    await new Promise((r) => setTimeout(r, 2_000));
  }
}

const upstreams = new Upstreams(db, config);
upstreams.start();

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);
app.use(express.json({ limit: '1mb' }));

app.get('/healthz', (_req, res) => {
  res.json({ status: 'ok' });
});

app.get('/readyz', async (_req, res) => {
  try {
    await db.query('SELECT 1');
    res.json({ status: 'ok' });
  } catch (err) {
    res.status(503).json({ status: 'error', error: (err as Error).message });
  }
});

app.post('/mcp', mcpHandler(db, upstreams));
// Stateless: no SSE stream to open (GET) and no session to delete (DELETE).
app.all('/mcp', (_req, res) => {
  res.status(405).set('allow', 'POST').json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null });
});

app.use('/api', apiRouter(db, config, upstreams));
app.use('/api', apiErrorHandler);

const httpServer = app.listen(config.port, () => {
  console.log(
    `gateway listening on :${config.port} (public ${config.publicUrl}, LLM ${config.llm.provider || 'not configured'})`,
  );
});

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    console.log(`${signal} received, shutting down`);
    upstreams.stop();
    httpServer.close(() => void db.end().finally(() => process.exit(0)));
    setTimeout(() => process.exit(0), 8_000).unref();
  });
}
