import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import express from 'express';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

// ---------- Part A: Settings ----------
const PORT = Number(process.env.PORT ?? 3000);
const NOTES_FILE = process.env.NOTES_FILE ?? 'notes.json';

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
  writeFileSync(NOTES_FILE, JSON.stringify(notes, null, 2));
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
const app = express();
app.use(express.json());

app.get('/healthz', (_req, res) => {
  res.json({ status: 'ok' });
});

app.post('/mcp', async (req, res) => {
  const server = createServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on('close', () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

app.listen(PORT, () => {
  console.log(`notes-mcp listening on port ${PORT}, notes file: ${NOTES_FILE}`);
});
