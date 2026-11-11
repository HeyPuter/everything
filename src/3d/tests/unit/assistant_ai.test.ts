import { describe, it, expect, afterEach } from 'vitest';
import { puterChat, type ChatMessage } from '../../src/assistant/ai';

type G = { puter?: unknown };

/** Stands in for window.puter; records the options of each chat request. */
function stubPuter(reply: unknown = { message: { content: 'ok' } }) {
  const calls: { messages: unknown; options: Record<string, unknown> }[] = [];
  (globalThis as G).puter = { ai: { chat: async (messages: unknown, options: Record<string, unknown>) => { calls.push({ messages, options }); return reply; } } };
  return calls;
}

async function drain(messages: ChatMessage[], opts: Parameters<typeof puterChat>[1] = {}) {
  const parts = [];
  for await (const p of puterChat(messages, opts)) parts.push(p);
  return parts;
}

afterEach(() => {
  delete (globalThis as G).puter;
});

describe('Puter AI requests', () => {
  it('lets the model call several tools in one reply', async () => {
    const calls = stubPuter();
    await drain([{ role: 'user', content: 'hi' }], { model: 'claude-opus-5-5', tools: [{ type: 'function' }] });
    // Unset, Puter allows one tool call per reply: every scene read costs a round trip.
    expect(calls[0].options.parallelToolCalls).toBe(true);
  });
});
