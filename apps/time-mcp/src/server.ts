// Time and date MCP server over Streamable HTTP. Stateless and dependency-free: the third upstream
// server of the platform, so "what's the time in Tokyo and which orders came in today?" needs two.
import { timingSafeEqual } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express, { type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';

const PORT = Number(process.env.PORT ?? 3000);
const AUTH_TOKEN = process.env.MCP_AUTH_TOKEN ?? '';
const DEFAULT_TZ = process.env.DEFAULT_TIMEZONE ?? 'UTC';

function reply(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

function fail(message: string) {
  return { ...reply({ error: message }), isError: true };
}

function validZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** "2026-10-20 14:05:09" plus weekday and UTC offset of `date` in `zone`. */
function describe(date: Date, zone: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hourCycle: 'h23', weekday: 'long', timeZoneName: 'longOffset',
    }).formatToParts(date).map((p) => [p.type, p.value]),
  );
  return {
    timezone: zone,
    local: `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`,
    weekday: parts.weekday,
    utcOffset: (parts.timeZoneName as string).replace('GMT', '') || '+00:00',
    iso: date.toISOString(),
  };
}

function createServer(): McpServer {
  const server = new McpServer({ name: 'time', version: '0.1.0' });
  const zoneSchema = z.string().optional().describe(`IANA timezone, e.g. Asia/Kolkata (default ${DEFAULT_TZ})`);

  server.registerTool(
    'current_time',
    {
      title: 'Current time',
      description: 'The current date and time in a timezone.',
      inputSchema: { timezone: zoneSchema },
    },
    async ({ timezone }) => {
      const zone = timezone ?? DEFAULT_TZ;
      if (!validZone(zone)) return fail(`Unknown timezone '${zone}'`);
      return reply(describe(new Date(), zone));
    },
  );

  server.registerTool(
    'convert_time',
    {
      title: 'Convert time',
      description: 'Show one moment (ISO 8601 timestamp, e.g. 2026-10-20T09:30:00Z) in other timezones.',
      inputSchema: {
        time: z.string().describe('ISO 8601 timestamp with offset or Z'),
        timezones: z.array(z.string()).min(1).max(10).describe('Target IANA timezones'),
      },
    },
    async ({ time, timezones }) => {
      const date = new Date(time);
      if (Number.isNaN(date.getTime())) return fail(`Not a valid ISO 8601 time: '${time}'`);
      const bad = timezones.filter((z) => !validZone(z));
      if (bad.length) return fail(`Unknown timezone(s): ${bad.join(', ')}`);
      return reply(timezones.map((z) => describe(date, z)));
    },
  );

  server.registerTool(
    'date_diff',
    {
      title: 'Date difference',
      description: 'Days, hours and minutes between two ISO 8601 dates or timestamps.',
      inputSchema: {
        from: z.string().describe('Start, e.g. 2026-10-20 or 2026-10-20T09:00:00Z'),
        to: z.string().describe('End'),
      },
    },
    async ({ from, to }) => {
      const a = new Date(from);
      const b = new Date(to);
      if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return fail('from and to must be ISO 8601 dates');
      const minutes = Math.round((b.getTime() - a.getTime()) / 60_000);
      return reply({
        totalMinutes: minutes,
        totalHours: +(minutes / 60).toFixed(2),
        totalDays: +(minutes / 1440).toFixed(2),
      });
    },
  );

  return server;
}

function requireToken(req: Request, res: Response, next: NextFunction): void {
  if (!AUTH_TOKEN) return next();
  const expected = Buffer.from(`Bearer ${AUTH_TOKEN}`);
  const given = Buffer.from(req.headers.authorization ?? '');
  if (given.length === expected.length && timingSafeEqual(given, expected)) return next();
  res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized' }, id: null });
}

const app = express();
app.use(express.json({ limit: '256kb' }));

app.get(['/healthz', '/readyz'], (_req, res) => {
  res.json({ status: 'ok' });
});

app.post('/mcp', requireToken, async (req, res) => {
  const server = createServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
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
      res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
    }
  }
});

app.all('/mcp', (_req, res) => {
  res.status(405).set('allow', 'POST').json({
    jsonrpc: '2.0',
    error: { code: -32000, message: 'Method not allowed' },
    id: null,
  });
});

const httpServer = app.listen(PORT, () => {
  console.log(`time-mcp listening on :${PORT} (default timezone ${DEFAULT_TZ}, auth ${AUTH_TOKEN ? 'on' : 'off'})`);
});

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5_000).unref();
  });
}
