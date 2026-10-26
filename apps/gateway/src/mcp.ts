// The gateway's own MCP endpoint (POST /mcp, Streamable HTTP, stateless). It authenticates the
// caller's API key, lists the tools of every enabled upstream and routes each call to its server.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Request, Response } from 'express';
import { writeAudit } from './audit.js';
import { checkApiKey, type User } from './auth.js';
import type { Config } from './config.js';
import type { Db } from './db.js';
import { hit } from './ratelimit.js';
import { META_TOOLS, SEPARATOR, type Upstreams } from './upstreams.js';

/** "search": only gateway__search_tools + gateway__call_tool (for clients facing many tools). */
type ToolMode = 'all' | 'search';

function gatewayServer(user: User, upstreams: Upstreams, mode: ToolMode): Server {
  // Low-level Server (not McpServer): tools are passed through with their upstream JSON schemas.
  const server = new Server(
    { name: 'urumi-gateway', version: '0.1.0' },
    {
      capabilities: { tools: {} },
      instructions:
        `Team MCP gateway. Tools from every enabled upstream server, named <server>${SEPARATOR}<tool> ` +
        '(e.g. woo__list_orders, notes__add_note). Calls run as the API key owner and are audited.',
    },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: mode === 'search' ? META_TOOLS : await upstreams.listTools(user),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) =>
    upstreams.callTool(request.params.name, request.params.arguments, user, 'mcp'),
  );
  return server;
}

/** A rejected request is still attributed to the key's owner in the audit log. */
async function auditRejected(db: Db, req: Request, user: User, reason: string): Promise<void> {
  const body = req.body as { method?: string; params?: { name?: string } } | undefined;
  const name = body?.method === 'tools/call' ? (body.params?.name ?? 'tools/call') : (body?.method ?? 'request');
  const cut = name.indexOf(SEPARATOR);
  await writeAudit(db, {
    userId: user.id,
    userEmail: user.email,
    via: 'mcp',
    serverName: cut > 0 ? name.slice(0, cut) : null,
    tool: cut > 0 ? name.slice(cut + SEPARATOR.length) : name,
    durationMs: 0,
    outcome: 'denied',
    error: reason,
  });
}

export function mcpHandler(db: Db, upstreams: Upstreams, config: Config) {
  return async (req: Request, res: Response) => {
    const check = await checkApiKey(db, req.headers.authorization);
    if (!check.ok) {
      if (check.user) await auditRejected(db, req, check.user, check.reason);
      res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: check.reason }, id: null });
      return;
    }
    const limit = await hit(db, `key:${check.keyId}`, config.mcpRateLimit);
    if (!limit.ok) {
      const reason = `Rate limit exceeded (${config.mcpRateLimit} requests per minute per key)`;
      await auditRejected(db, req, check.user, reason);
      res.status(429).set('retry-after', String(limit.retryAfter)).json({ jsonrpc: '2.0', error: { code: -32002, message: reason }, id: null });
      return;
    }

    // Connect with /mcp?tools=search to get the two meta-tools instead of every tool.
    const server = gatewayServer(check.user, upstreams, req.query.tools === 'search' ? 'search' : 'all');
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error('Gateway MCP request failed:', err);
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
      }
    }
  };
}
