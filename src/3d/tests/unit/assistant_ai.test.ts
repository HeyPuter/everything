import { describe, it, expect, afterEach } from 'vitest';
import { puterChat, withCacheBreakpoints, type ChatMessage } from '../../src/assistant/ai';
import { createAgent, requestMessages } from '../../src/assistant/agent';

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

  it('asks Anthropic first for Claude models', async () => {
    const calls = stubPuter();
    await drain([{ role: 'user', content: 'hi' }], { model: 'claude-opus-5-5' });
    // Unpinned, Puter may route to a reseller with none of the conversation in its prompt cache.
    expect(calls[0].options.provider).toBe('claude');
    await drain([{ role: 'user', content: 'hi' }], { model: 'gpt-5' });
    expect(calls[1].options.provider).toBeUndefined();
  });

  it('marks prompt-cache breakpoints on the instructions, finished turns and the newest message', async () => {
    const t: ChatMessage[] = [
      { role: 'system', content: 'S' },
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'one' },
      { role: 'user', content: 'second' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'a', type: 'function', function: { name: 'get_scene', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'a', content: 'scene' },
    ];
    const before = structuredClone(t);
    const calls = stubPuter();
    await drain(t);
    const sent = calls[0].messages as unknown[];
    // Puter caches nothing for Claude unless the messages ask, so every round paid for the whole conversation again.
    expect(t).toEqual(before);
    expect(JSON.stringify(sent).match(/cache_control/g)).toHaveLength(4);
    expect(sent[0]).toEqual({ role: 'system', content: [{ type: 'text', text: 'S', cache_control: { type: 'ephemeral', ttl: '1h' } }] });
    expect(sent[1]).toBe(t[1]);
    expect(sent[2]).toEqual({ role: 'assistant', content: [{ type: 'text', text: 'one', cache_control: { type: 'ephemeral' } }] });
    expect(sent[3]).toEqual({ role: 'user', content: [{ type: 'text', text: 'second', cache_control: { type: 'ephemeral' } }] });
    // A tool result in Claude's own shape: Puter rebuilds an OpenAI tool message without the breakpoint.
    expect(sent[5]).toEqual({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: 'scene', cache_control: { type: 'ephemeral' } }] });
    // A screenshot message is marked on its image.
    const shot: ChatMessage = { role: 'user', content: [{ type: 'text', text: 'shot' }, { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAAA' } }] };
    const out = withCacheBreakpoints([...t, shot]) as { content: { cache_control?: unknown }[] }[];
    expect(out[6].content[1].cache_control).toEqual({ type: 'ephemeral' });
    expect(out[6].content[0].cache_control).toBeUndefined();
    // The first message of a chat is both the turn's start and the newest; an empty result takes no breakpoint.
    expect(JSON.stringify(withCacheBreakpoints([{ role: 'system', content: 'S' }, { role: 'user', content: 'hi' }])).match(/cache_control/g)).toHaveLength(2);
    const empty: ChatMessage = { role: 'tool', tool_call_id: 'a', content: '' };
    expect(withCacheBreakpoints([...t.slice(0, 5), empty]).at(-1)).toBe(empty);
  });

  it('never sends half of a character cut from an earlier result', async () => {
    const t: ChatMessage[] = [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'a', type: 'function', function: { name: 'get_scene', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'a', content: `${'a'.repeat(1499)}😀 and more` },
      { role: 'assistant', content: 'done' },
      { role: 'user', content: 'second' },
    ];
    // An old result is cut to 1500 characters, which can split an emoji in two;
    // the API refuses the lone half as invalid JSON, in every later request.
    const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    const req = requestMessages(t, 'S');
    expect(lone.test(String(req[3].content))).toBe(true);
    const calls = stubPuter();
    await drain(req);
    const tool = (calls[0].messages as { content: unknown }[])[3];
    expect(lone.test(String(tool.content))).toBe(false);
    expect(String(tool.content)).toContain('a�\n[…cut');
  });

  it('drops old turns in steps, so a long conversation keeps one start across requests', () => {
    const t: ChatMessage[] = [];
    for (let i = 0; i < 40; i++) t.push({ role: 'user', content: `question ${i} `.padEnd(100, '.') }, { role: 'assistant', content: `answer ${i} `.padEnd(100, '.') });
    t.push({ role: 'user', content: 'build it' });
    const starts = new Set<string>();
    for (let round = 0; round < 10; round++) {
      t.push({ role: 'assistant', content: null, tool_calls: [{ id: `c${round}`, type: 'function', function: { name: 'get_scene', arguments: '{}' } }] }, { role: 'tool', tool_call_id: `c${round}`, content: 'x'.repeat(100) });
      const req = requestMessages(t, 'S', { budget: 4000 });
      expect(req.reduce((n, m) => n + (typeof m.content === 'string' ? m.content.length : 0), 0)).toBeLessThan(4600);
      starts.add(String(req[1].content));
    }
    // Dropping the oldest turn on every round changed where the request starts, and so every round rewrote the prompt cache.
    expect(starts.size).toBeLessThanOrEqual(3);
  });

  it('aborts the request when the user presses Stop', async () => {
    let signal: AbortSignal | undefined;
    let ended = false;
    (globalThis as G).puter = {
      ai: {
        chat: async (_m: unknown, o: Record<string, unknown>) => {
          signal = o.signal as AbortSignal;
          // A stream that sends nothing for a long while (a long tool call being written).
          return {
            [Symbol.asyncIterator]() { return this; },
            next: () => new Promise(() => {}),
            return: async () => { ended = true; return { done: true, value: undefined }; },
          };
        },
      },
    };
    const agent = createAgent({ chat: puterChat, tools: () => [], runTool: async () => ({ ok: true, content: '' }), system: 'S', snapshot: () => '', model: () => 'claude-opus-5-5' });
    const res = agent.send('build', () => {});
    while (!signal) await new Promise((r) => setTimeout(r, 1));
    expect(signal.aborted).toBe(false);
    agent.stop();
    expect((await res).stopped).toBe(true);
    // Puter's SDK aborts its HTTP request on the signal; the stream is ended too.
    expect(signal.aborted).toBe(true);
    expect(ended).toBe(true);
  });

  it('says when the account ran out of credits instead of passing a cut-off reply as finished', async () => {
    // The usage line Puter's driver ends such a stream with (AIChatStream.end with metadata.usage_limited).
    stubPuter((async function* () {
      yield { type: 'text', text: 'I will build the ' };
      yield { type: 'usage', usage: { output_tokens: 9 }, stopReason: 'max_tokens', finish_reason: 'length', metadata: { usage_limited: true } };
    })());
    const parts: unknown[] = [];
    const err = await (async () => {
      try {
        for await (const p of puterChat([{ role: 'user', content: 'hi' }], { maxTokens: 16000 })) parts.push(p);
      } catch (e) {
        return e as Error & { code?: string };
      }
    })();
    expect(parts).toEqual([{ type: 'text', text: 'I will build the ' }]);
    expect(err?.message).toMatch(/ran out of AI credits/);
    expect(err?.code).toBe('insufficient_funds');
  });
});
