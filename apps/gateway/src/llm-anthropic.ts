// Claude via the official Anthropic SDK: a manual tool-use loop (tools come from the gateway at
// runtime, and every call must be recorded for the chat UI).
import Anthropic from '@anthropic-ai/sdk';
import type { Provider } from './chat.js';
import type { Config } from './config.js';

export function anthropicProvider(config: Config): Provider {
  const client = new Anthropic({ apiKey: config.llm.apiKey, timeout: 180_000 });

  return async ({ system, history, runner, maxSteps }) => {
    const tools: Anthropic.Beta.BetaTool[] = runner.tools.map((t) => ({
      name: t.name,
      description: t.description ?? '',
      input_schema: t.inputSchema as Anthropic.Beta.BetaTool.InputSchema,
    }));
    const messages: Anthropic.Beta.BetaMessageParam[] = history.map((t) => ({ role: t.role, content: t.content }));

    for (let step = 0; step <= maxSteps; step++) {
      const response = await client.beta.messages.create({
        model: config.llm.model,
        max_tokens: 16000,
        // Re-run a declined request on Anthropic's recommended fallback model, server side.
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        output_config: { effort: 'medium' },
        system,
        tools,
        messages,
      });

      if (response.stop_reason === 'refusal') return 'The model declined to answer this request.';
      // Keep the full content (thinking and fallback blocks included) so the next turn is valid.
      messages.push({ role: 'assistant', content: response.content });
      const text = response.content
        .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim();

      if (response.stop_reason === 'pause_turn') continue;
      if (response.stop_reason !== 'tool_use') return text || '(no answer)';

      const calls = response.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use');
      // Run parallel tool calls together and return all results in one user message.
      const results = await Promise.all(
        calls.map(async (call): Promise<Anthropic.Beta.BetaToolResultBlockParam> => {
          const out = await runner.run(call.name, (call.input ?? {}) as Record<string, unknown>);
          return { type: 'tool_result', tool_use_id: call.id, content: out.text, is_error: out.isError };
        }),
      );
      messages.push({ role: 'user', content: results });
    }
    return 'Stopped after too many tool calls.';
  };
}
