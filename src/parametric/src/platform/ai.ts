// Puter AI chat with tool calling, streamed. Messages are in the OpenAI shape
// Puter takes (system, user, assistant with tool_calls, tool); replies come
// back as text pieces and tool calls as they arrive.

import type { AttachmentMeta } from '../assistant/attach';

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
  /** Aborting it ends the request and its stream (Stop). */
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

/**
 * Whether a failed request is worth sending again unchanged: the service was
 * busy, rate limited, timed out or the connection dropped. Only these are
 * retried; anything else (no funds, a refused request, a prompt too long)
 * would fail the same way again.
 */
export function isTransientError(e: unknown): boolean {
  const err = e as { name?: string; code?: unknown; message?: unknown } | null;
  if (!err || err.name === 'AbortError') return false;
  const code = String(err.code ?? '');
  if (['upstream_provider_unavailable', 'upstream_failed', 'upstream_timeout', 'upstream_rate_limited', 'network_error', 'request_timeout'].includes(code)) return true;
  if (['upstream_bad_request', 'upstream_credits_exhausted', 'upstream_auth_failed', 'permission_denied', 'insufficient_funds', 'auth_canceled', 'auth_required', 'puter_unavailable'].includes(code)) return false;
  const text = String(err.message ?? '').toLowerCase();
  if (/insufficient|credit|funds|balance|too long|context|invalid|not supported|unsupported/.test(text)) return false;
  // Status codes stand alone: a token count such as 5000 is not a 500.
  if (/\b(408|429|500|502|503|504|529)\b/.test(text)) return true;
  return ['overloaded', 'rate limit', 'too many requests', 'service unavailable', 'provider unavailable', 'all ai providers failed', 'bad gateway', 'gateway timeout', 'internal server error',
    'timeout', 'timed out', 'failed to fetch', 'network', 'connection', 'socket hang up', 'econnreset', 'did not answer'].some((k) => text.includes(k));
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
/** Whether a stream's closing usage line says the reply stopped at the output limit. */
const stoppedAtLimit = (part: Record<string, unknown>, max?: number) =>
  part.stopReason === 'max_tokens' || part.finish_reason === 'length' || reachedLimit(part.usage as never, max);

let callSeq = 0;
const newCallId = () => `call_${Date.now().toString(36)}_${(++callSeq).toString(36)}`;

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
 * caches nothing unless asked): the instructions, which the tools come
 * before; the message that started the current turn; and the newest message.
 * Each round of a reply then reads everything before it from the cache
 * instead of paying for it again, the turn's start anchoring rounds that add
 * more blocks than the cache looks back over. A tool result goes in Claude's
 * own shape, which keeps the breakpoint: Puter rebuilds an OpenAI tool
 * message without it. The messages given are not changed.
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
    if (m.role === 'assistant') return;
    const content = marked(m.content, cache);
    if (content) out[i] = { ...m, content };
  };
  if (messages[0]?.role === 'system') markAt(0, CACHE_LONG);
  let turn = -1;
  for (let i = messages.length - 1; i > 0 && turn < 0; i--) {
    const prev = messages[i - 1];
    if (messages[i].role === 'user' && (prev.role === 'system' || (prev.role === 'assistant' && !prev.tool_calls?.length))) turn = i;
  }
  if (turn > 0) markAt(turn, CACHE);
  if (messages.length > 1) markAt(messages.length - 1, CACHE);
  return out;
}

/** puter.ai.chat, streamed. A reply the SDK hands back whole is yielded in the same pieces. */
export async function* puterChat(messages: ChatMessage[], opts: ChatOptions = {}): AsyncIterable<StreamPart> {
  const p = (globalThis as unknown as { puter?: PuterAI }).puter;
  if (!p?.ai?.chat) throw Object.assign(new Error('The assistant needs Puter, which is not available right now. Check your connection and reload.'), { code: 'puter_unavailable' });
  const options: Record<string, unknown> = { stream: true };
  if (opts.model) options.model = opts.model;
  if (opts.tools?.length) options.tools = opts.tools;
  if (opts.maxTokens) options.max_tokens = opts.maxTokens;
  // The SDK aborts its request on the signal. The stream is also ended
  // directly: a generator's return() waits for the part it is waiting on, and
  // a long tool call can stream nothing for a minute.
  if (opts.signal) options.signal = opts.signal;
  let res: unknown;
  try {
    res = await p.ai.chat(withCacheBreakpoints(messages), options);
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
        else if (part.type === 'usage') { if (stoppedAtLimit(part, opts.maxTokens)) yield { type: 'cut' }; }
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
