import { accessSync, constants, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import express, { type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

// ---------- Part A: Settings ----------
const PORT = Number(process.env.PORT ?? 3000);
const NOTES_FILE = process.env.NOTES_FILE ?? 'notes.json';
// Shared bearer token the gateway must send. Empty = no check (local testing).
const AUTH_TOKEN = process.env.MCP_AUTH_TOKEN ?? '';

// ---------- Part B: Where notes are kept (a JSON file) ----------
interface Note {
  id: string;
  title: string;
  text: string;
  createdAt: string;
}

function loadNotes(): Note[] {
  if (!existsSync(NOTES_FILE)) return [];
  return JSON.parse(readFileSync(NOTES_FILE, 'utf8')) as Note[];
}

function saveNotes(notes: Note[]): void {
  // Write a temp file and rename it, so a crash mid-write never leaves a half-written notes file.
  const tmp = `${NOTES_FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(notes, null, 2));
  renameSync(tmp, NOTES_FILE);
}

/** Every tool answer must look like this: a list of content pieces. */
function reply(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

// ---------- Part C: The tools the AI can call ----------
function createServer(): McpServer {
  const server = new McpServer({ name: 'notes', version: '0.1.0' });

  server.registerTool(
    'add_note',
    {
      title: 'Add note',
      description: 'Save a new note with a title and text.',
      inputSchema: {
        title: z.string().min(1).describe('Short title of the note'),
        text: z.string().min(1).describe('The note content'),
      },
    },
    async ({ title, text }) => {
      const notes = loadNotes();
      const note: Note = {
        id: randomUUID().slice(0, 8),
        title,
        text,
        createdAt: new Date().toISOString(),
      };
      notes.push(note);
      saveNotes(notes);
      return reply({ saved: note });
    },
  );

  server.registerTool(
    'list_notes',
    {
      title: 'List notes',
      description: 'List saved notes, newest first. Optionally search by a word.',
      inputSchema: {
        search: z.string().optional().describe('Only notes containing this word'),
      },
    },
    async ({ search }) => {
      let notes = loadNotes().reverse();
      if (search) {
        const word = search.toLowerCase();
        notes = notes.filter((n) => (n.title + ' ' + n.text).toLowerCase().includes(word));
      }
      return reply({ count: notes.length, notes });
    },
  );

  server.registerTool(
    'delete_note',
    {
      title: 'Delete note',
      description: 'Delete a note by its id.',
      inputSchema: {
        id: z.string().describe('The id of the note to delete'),
      },
    },
    async ({ id }) => {
      const notes = loadNotes();
      const remaining = notes.filter((n) => n.id !== id);
      if (remaining.length === notes.length) {
        return { ...reply(`No note with id ${id}`), isError: true };
      }
      saveNotes(remaining);
      return reply({ deleted: id });
    },
  );

  return server;
}

// ---------- Part D: The web server ----------

/** Only callers with the right token (the gateway) may use /mcp. */
function requireToken(req: Request, res: Response, next: NextFunction): void {
  if (!AUTH_TOKEN) return next();
  const expected = Buffer.from(`Bearer ${AUTH_TOKEN}`);
  const given = Buffer.from(req.headers.authorization ?? '');
  if (given.length === expected.length && timingSafeEqual(given, expected)) return next();
  res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized' }, id: null });
}

const app = express();
app.use(express.json({ limit: '1mb' }));

app.get('/healthz', (_req, res) => {
  res.json({ status: 'ok' });
});

// Ready = the notes folder is writable (the volume is mounted) and the notes file is valid JSON.
app.get('/readyz', (_req, res) => {
  try {
    accessSync(dirname(NOTES_FILE), constants.W_OK);
    const count = loadNotes().length;
    res.json({ status: 'ok', notes: count });
  } catch (err) {
    res.status(503).json({ status: 'error', error: (err as Error).message });
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
      res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
    }
  }
});

// Stateless server: no SSE stream (GET) and no session to delete (DELETE).
app.all('/mcp', (_req, res) => {
  res.status(405).set('allow', 'POST').json({
    jsonrpc: '2.0',
    error: { code: -32000, message: 'Method not allowed' },
    id: null,
  });
});

const httpServer = app.listen(PORT, () => {
  console.log(`notes-mcp listening on port ${PORT}, notes file: ${NOTES_FILE}, auth ${AUTH_TOKEN ? 'on' : 'off'}`);
});

// Kubernetes sends SIGTERM before stopping a pod: finish open requests, then exit.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    console.log(`${signal} received, shutting down`);
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5_000).unref();
  });
}
