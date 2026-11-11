// Puter AI chat with tool calling, streamed. Messages are in the OpenAI shape
// Puter takes (system, user, assistant with tool_calls, tool); replies come
// back as text pieces and tool calls as they arrive.

import { prefs } from '../app/prefs';
import type { AttachmentMeta } from './attach';

/** Message parts. Images and PDFs use the blocks Puter passes to the model as they are (Anthropic's shape). */
export type ChatPart =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  | { type: 'document'; source: { type: 'base64'; media_type: 'application/pdf'; data: string } };
export type ChatToolCall = { id: string; type: 'function'; function: { name: string; arguments: string } };
export type ChatMessage =
  | { role: 'system'; content: string }
  | {
    role: 'user';
    content: string | ChatPart[];
    /** Kept in the transcript only (never sent): the files this message carried. */
    attachments?: AttachmentMeta[];
    /** Kept in the transcript only: this message holds screenshots taken by a tool. */
    screenshot?: boolean;
  }
  | { role: 'assistant'; content: string | null; tool_calls?: ChatToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

export type StreamPart =
  | { type: 'text'; text: string }
  | { type: 'tool'; id: string; name: string; input: Record<string, unknown> }
  /** The reply stopped at the output token limit. */
  | { type: 'cut' };

export interface ChatOptions {
  model?: string;
  tools?: unknown[];
  maxTokens?: number;
  /** Aborts the request (Stop): Puter's SDK cancels its HTTP request on it. */
  signal?: AbortSignal;
}

export type ChatFn = (messages: ChatMessage[], opts: ChatOptions) => AsyncIterable<StreamPart>;

interface PuterAI {
  ai?: { chat: (messages: unknown, opts?: Record<string, unknown>) => Promise<unknown> };
}

/** An Error for whatever the SDK threw (it often throws a plain { error: { message } } object). */
export function aiError(e: unknown): Error {
  if (e instanceof Error) return e;
  const o = e as { error?: unknown; code?: string; message?: string } | string | null;
  const inner = o && typeof o === 'object' && o.error && typeof o.error === 'object' ? (o.error as { message?: string; code?: string }) : (o as { message?: string; code?: string } | null);
  const message = (inner && typeof inner === 'object' && inner.message) || (o && typeof o === 'object' && typeof o.error === 'string' ? o.error : '') || (typeof o === 'string' ? o : '') || 'The AI service did not answer';
  return Object.assign(new Error(message), { code: (inner && typeof inner === 'object' && inner.code) || (o && typeof o === 'object' ? o.code : undefined) });
}

/** A tool call's arguments, which may come as JSON text; unreadable text is marked, not taken for no arguments. */
function toolInput(input: unknown): Record<string, unknown> {
  if (typeof input !== 'string') return (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  try {
    const v = input.trim() ? JSON.parse(input) : {};
    return v && typeof v === 'object' ? v : {};
  } catch {
    return { __unreadable: input };
  }
}

const reachedLimit = (usage: { output_tokens?: number; completion_tokens?: number } | undefined, max?: number) =>
  !!max && Number(usage?.output_tokens ?? usage?.completion_tokens) >= max;

let callSeq = 0;
const newCallId = () => `call_${Date.now().toString(36)}_${(++callSeq).toString(36)}`;

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const LONE_SURROGATES = new RegExp(LONE_SURROGATE.source, 'g');

/**
 * The value with half characters replaced by U+FFFD. Text cut to a length
 * (old tool results, long files, names) can end in half of an emoji, and the
 * API refuses a request holding one as invalid JSON; the cut message stays
 * in the conversation, so every later request would fail the same way.
 * Unchanged parts are returned as they are.
 */
export function wellFormed<T>(value: T): T {
  if (typeof value === 'string') return (LONE_SURROGATE.test(value) ? value.replace(LONE_SURROGATES, '\uFFFD') : value) as T;
  if (Array.isArray(value)) {
    let out: unknown[] | null = null;
    value.forEach((v, i) => { const w = wellFormed(v); if (w !== v) (out ??= [...value])[i] = w; });
    return (out ?? value) as T;
  }
  if (value && typeof value === 'object') {
    let out: Record<string, unknown> | null = null;
    for (const [k, v] of Object.entries(value)) { const w = wellFormed(v); if (w !== v) (out ??= { ...(value as Record<string, unknown>) })[k] = w; }
    return (out ?? value) as T;
  }
  return value;
}

/** The instructions and tools are the same for everyone: cached for an hour. */
const CACHE_LONG = { type: 'ephemeral', ttl: '1h' } as const;
const CACHE = { type: 'ephemeral' } as const;
type Block = Record<string, unknown>;

/** Content as blocks with a cache breakpoint on the last one (an empty text block cannot take one). */
function marked(content: string | ChatPart[] | null, cache: Block): Block[] | null {
  const blocks: Block[] = typeof content === 'string' ? (content ? [{ type: 'text', text: content }] : []) : [...(content ?? [])];
  const last = blocks.at(-1);
  if (!last || (last.type === 'text' && !last.text)) return null;
  blocks[blocks.length - 1] = { ...last, cache_control: cache };
  return blocks;
}

/**
 * The request with prompt-cache breakpoints (Puter passes them to Claude, and
 * caches nothing unless asked; Claude takes at most four):
 * - the instructions, which the tools come before;
 * - the end of the last finished turn, and on a turn's first request the end
 *   of the one before. Earlier turns are sent shortened (no snapshot, results
 *   cut), so they read the same in every later request; a new turn reads them
 *   from the cache written by the turn before, instead of paying to write the
 *   whole conversation again;
 * - the message that started the current turn, anchoring rounds that add more
 *   blocks than the cache looks back over;
 * - the newest message, which the next round reads up to.
 * A tool result goes in Claude's own shape, which keeps the breakpoint: Puter
 * rebuilds an OpenAI tool message without it. The messages given are not changed.
 */
export function withCacheBreakpoints(messages: ChatMessage[]): unknown[] {
  const out: unknown[] = [...messages];
  const markAt = (i: number, cache: Block) => {
    const m = messages[i];
    if (!m) return;
    if (m.role === 'tool') {
      // Like an empty text block, an empty result is not given a breakpoint.
      if (!m.content) return;
      out[i] = { role: 'user', content: [{ type: 'tool_result', tool_use_id: m.tool_call_id, content: m.content, cache_control: cache }] };
      return;
    }
    // A breakpoint on a reply's text would sit before its tool calls, not at its end.
    if (m.role === 'assistant' && m.tool_calls?.length) return;
    const content = marked(m.content, cache);
    if (content) out[i] = { ...m, content };
  };
  if (messages[0]?.role === 'system') markAt(0, CACHE_LONG);
  // Where each turn starts: a message the user wrote, after the instructions or a finished reply.
  const starts: number[] = [];
  for (let i = 1; i < messages.length; i++) {
    const prev = messages[i - 1];
    if (messages[i].role === 'user' && (prev.role === 'system' || (prev.role === 'assistant' && !prev.tool_calls?.length))) starts.push(i);
  }
  const turn = starts.at(-1) ?? -1;
  const last = messages.length - 1;
  // A finished turn ends with the reply before the next turn's start.
  if (turn === last && starts.length > 2) markAt(starts.at(-2)! - 1, CACHE);
  if (starts.length > 1) markAt(turn - 1, CACHE);
  if (turn > 0 && turn < last) markAt(turn, CACHE);
  if (last > 0) markAt(last, CACHE);
  return out;
}

/** puter.ai.chat, streamed. A reply the SDK hands back whole is yielded in the same pieces. */
export async function* puterChat(messages: ChatMessage[], opts: ChatOptions = {}): AsyncIterable<StreamPart> {
  if (!prefs.use_online_access) throw new Error('The assistant works online, but online access is turned off (Preferences ▸ System ▸ Network).');
  const p = (globalThis as unknown as { puter?: PuterAI }).puter;
  if (!p?.ai?.chat) throw new Error('The assistant needs Puter, which is not available right now. Check your connection and reload.');
  const options: Record<string, unknown> = { stream: true };
  if (opts.model) options.model = opts.model;
  // Puter starts a request on the healthiest route that serves the model: after
  // anyone's recent failure on Anthropic's, that is a reseller, which has none of
  // this conversation in its prompt cache and may drop images. Pinned, Anthropic
  // serves first, and Puter still falls back when it fails.
  if (opts.model?.startsWith('claude-')) options.provider = 'claude';
  if (opts.tools?.length) {
    options.tools = opts.tools;
    // Puter lets the model call one tool per reply unless asked: independent
    // reads (the scene, an object, a material) would each cost a round trip.
    options.parallelToolCalls = true;
  }
  if (opts.maxTokens) options.max_tokens = opts.maxTokens;
  // The SDK aborts its request on the signal (puter-js sendOnce). The stream is also
  // ended directly: a generator's return() waits for the part it is waiting on,
  // and a long tool call can stream nothing for a minute.
  if (opts.signal) options.signal = opts.signal;
  let res: unknown;
  try {
    res = await p.ai.chat(wellFormed(withCacheBreakpoints(messages)), options);
  } catch (e) {
    throw aiError(e);
  }
  if (res && typeof (res as AsyncIterable<unknown>)[Symbol.asyncIterator] === 'function') {
    const end = () => { Promise.resolve((res as AsyncIterator<unknown>).return?.()).catch(() => {}); };
    if (opts.signal?.aborted) end();
    else opts.signal?.addEventListener('abort', end, { once: true });
    try {
      for await (const part of res as AsyncIterable<Record<string, unknown>>) {
        if (!part) continue;
        if (part.type === 'error' || (part.success === false && part.error)) throw aiError(part.error ?? part);
        if (part.type === 'tool_use') yield { type: 'tool', id: String(part.id ?? newCallId()), name: String(part.name ?? ''), input: toolInput(part.input) };
        else if (part.type === 'usage') {
          // Puter ends a reply the account's credits ran out during like one that reached the length limit,
          // marked metadata.usage_limited (ChatCompletionDriver ranOutOfFunds); the reply did not finish.
          if ((part.metadata as { usage_limited?: boolean } | undefined)?.usage_limited) {
            throw Object.assign(new Error('Your Puter account ran out of AI credits, so the reply stopped.'), { code: 'insufficient_funds' });
          }
          if (reachedLimit(part.usage as never, opts.maxTokens)) yield { type: 'cut' };
        }
        else if (part.type !== 'reasoning' && typeof part.text === 'string' && part.text) yield { type: 'text', text: part.text };
      }
    } catch (e) {
      throw aiError(e);
    } finally {
      opts.signal?.removeEventListener('abort', end);
    }
    return;
  }
  const r = res as { success?: boolean; error?: unknown; message?: { content?: unknown; tool_calls?: { id?: string; function?: { name?: string; arguments?: unknown } }[]; stop_reason?: string }; finish_reason?: string; stop_reason?: string; usage?: never } | string;
  if (typeof r === 'object' && r?.success === false) throw aiError(r.error ?? r);
  const message = typeof r === 'object' ? r?.message ?? {} : {};
  const content = typeof r === 'string' ? r : message.content;
  const text = typeof content === 'string' ? content : Array.isArray(content) ? content.map((c) => (typeof c === 'string' ? c : (c as { text?: string })?.text ?? '')).join('') : '';
  if (text) yield { type: 'text', text };
  for (const call of message.tool_calls ?? []) yield { type: 'tool', id: call.id ?? newCallId(), name: String(call.function?.name ?? ''), input: toolInput(call.function?.arguments) };
  if (typeof r === 'object' && (r.finish_reason === 'length' || r.stop_reason === 'max_tokens' || message.stop_reason === 'max_tokens' || reachedLimit(r.usage, opts.maxTokens))) yield { type: 'cut' };
}
