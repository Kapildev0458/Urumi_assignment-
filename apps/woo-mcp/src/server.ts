// WooCommerce MCP server over Streamable HTTP. Stateless: every POST /mcp gets a fresh server and
// transport, so any replica can answer any request and restarts lose nothing.
import { timingSafeEqual } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express, { type NextFunction, type Request, type Response } from 'express';
import { loadConfig } from './config.js';
import { registerTools } from './tools.js';
import { WooClient } from './woo.js';

const config = loadConfig();
const woo = new WooClient(config);

function createServer(): McpServer {
  const server = new McpServer(
    { name: 'woocommerce', version: '0.1.0' },
    {
      instructions:
        'Tools for one WooCommerce store: products (list/create) and orders (list/get/update status). ' +
        'Dates are in the store timezone.',
    },
  );
  registerTools(server, woo);
  return server;
}

/** Optional shared secret between the gateway and this server (registered as its credential). */
function requireToken(req: Request, res: Response, next: NextFunction): void {
  if (!config.authToken) return next();
  const expected = Buffer.from(`Bearer ${config.authToken}`);
  const given = Buffer.from(req.headers.authorization ?? '');
  if (given.length === expected.length && timingSafeEqual(given, expected)) return next();
  res.status(401).json({
    jsonrpc: '2.0',
    error: { code: -32001, message: 'Unauthorized' },
    id: null,
  });
}

const app = express();
app.use(express.json({ limit: '1mb' }));

app.get('/healthz', (_req, res) => {
  res.json({ status: 'ok' });
});

// Ready = the process can serve MCP. Store health is reported separately so a store outage shows
// up as tool errors instead of the gateway marking this server unreachable.
app.get('/readyz', async (_req, res) => {
  try {
    await woo.storeGmtOffset();
    res.json({ status: 'ok', store: 'reachable' });
  } catch (err) {
    res.json({ status: 'ok', store: `unreachable: ${(err as Error).message}` });
  }
});

app.post('/mcp', requireToken, async (req, res) => {
  const server = createServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on('close', () => {
    void transport.close();
    void server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error('MCP request failed:', err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal server error' },
        id: null,
      });
    }
  }
});

// Stateless server: no SSE stream to resume and no session to delete.
app.all('/mcp', (_req, res) => {
  res.status(405).set('allow', 'POST').json({
    jsonrpc: '2.0',
    error: { code: -32000, message: 'Method not allowed' },
    id: null,
  });
});

const httpServer = app.listen(config.port, () => {
  console.log(
    `woo-mcp listening on :${config.port} (store ${config.wooUrl}, auth ${config.authToken ? 'on' : 'off'})`,
  );
});

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    console.log(`${signal} received, shutting down`);
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5_000).unref();
  });
}
