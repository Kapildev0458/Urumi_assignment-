// The gateway's own MCP endpoint (POST /mcp, Streamable HTTP, stateless). It authenticates the
// caller's API key, lists the tools of every enabled upstream and routes each call to its server.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Request, Response } from 'express';
import { writeAudit } from './audit.js';
import { checkApiKey, type User } from './auth.js';
import type { Db } from './db.js';
import { SEPARATOR, type Upstreams } from './upstreams.js';

function gatewayServer(user: User, upstreams: Upstreams): Server {
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
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: await upstreams.listTools() }));
  server.setRequestHandler(CallToolRequestSchema, async (request) =>
    upstreams.callTool(request.params.name, request.params.arguments, user, 'mcp'),
  );
  return server;
}

export function mcpHandler(db: Db, upstreams: Upstreams) {
  return async (req: Request, res: Response) => {
    const check = await checkApiKey(db, req.headers.authorization);
    if (!check.ok) {
      // A known-but-revoked key is still attributed to its owner in the audit log.
      if (check.user) {
        const body = req.body as { method?: string; params?: { name?: string } } | undefined;
        const name = body?.method === 'tools/call' ? (body.params?.name ?? 'tools/call') : (body?.method ?? 'request');
        const cut = name.indexOf(SEPARATOR);
        await writeAudit(db, {
          userId: check.user.id,
          userEmail: check.user.email,
          via: 'mcp',
          serverName: cut > 0 ? name.slice(0, cut) : null,
          tool: cut > 0 ? name.slice(cut + SEPARATOR.length) : name,
          durationMs: 0,
          outcome: 'denied',
          error: check.reason,
        });
      }
      res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: check.reason }, id: null });
      return;
    }

    const server = gatewayServer(check.user, upstreams);
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
