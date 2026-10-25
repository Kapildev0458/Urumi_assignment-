// Any OpenAI-compatible Chat Completions API (OpenAI, OpenRouter, Groq, Gemini's OpenAI endpoint,
// Ollama): LLM_BASE_URL + LLM_MODEL + LLM_API_KEY.
import type { Provider } from './chat.js';
import type { Config } from './config.js';

interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

/** Some providers reject JSON Schema keywords they do not use. */
function cleanSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(cleanSchema);
  if (schema && typeof schema === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(schema)) if (k !== '$schema') out[k] = cleanSchema(v);
    return out;
  }
  return schema;
}

export function openaiProvider(config: Config): Provider {
  return async ({ system, history, runner, maxSteps }) => {
    const tools = runner.tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description ?? '', parameters: cleanSchema(t.inputSchema) },
    }));
    const messages: Message[] = [{ role: 'system', content: system }, ...history];

    for (let step = 0; step <= maxSteps; step++) {
      const res = await fetch(`${config.llm.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${config.llm.apiKey}` },
        body: JSON.stringify({ model: config.llm.model, messages, tools: tools.length ? tools : undefined }),
        signal: AbortSignal.timeout(120_000),
      });
      if (!res.ok) throw new Error(`LLM API returned ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const data = (await res.json()) as { choices: { message: Message; finish_reason: string }[] };
      const message = data.choices[0]?.message;
      if (!message) throw new Error('LLM API returned no choices');
      messages.push({ role: 'assistant', content: message.content ?? null, tool_calls: message.tool_calls });

      if (!message.tool_calls?.length) return (message.content ?? '').trim() || '(no answer)';
      for (const call of message.tool_calls) {
        let args: Record<string, unknown> = {};
        try {
          args = call.function.arguments ? (JSON.parse(call.function.arguments) as Record<string, unknown>) : {};
        } catch {
          messages.push({ role: 'tool', tool_call_id: call.id, content: 'Error: arguments were not valid JSON' });
          continue;
        }
        const out = await runner.run(call.function.name, args);
        messages.push({ role: 'tool', tool_call_id: call.id, content: out.isError ? `Error: ${out.text}` : out.text });
      }
    }
    return 'Stopped after too many tool calls.';
  };
}
