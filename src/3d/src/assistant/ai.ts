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

/** puter.ai.chat, streamed. A reply the SDK hands back whole is yielded in the same pieces. */
export async function* puterChat(messages: ChatMessage[], opts: ChatOptions = {}): AsyncIterable<StreamPart> {
  if (!prefs.use_online_access) throw new Error('The assistant works online, but online access is turned off (Preferences ▸ System ▸ Network).');
  const p = (globalThis as unknown as { puter?: PuterAI }).puter;
  if (!p?.ai?.chat) throw new Error('The assistant needs Puter, which is not available right now. Check your connection and reload.');
  const options: Record<string, unknown> = { stream: true };
  if (opts.model) options.model = opts.model;
  if (opts.tools?.length) options.tools = opts.tools;
  if (opts.maxTokens) options.max_tokens = opts.maxTokens;
  let res: unknown;
  try {
    res = await p.ai.chat(messages, options);
  } catch (e) {
    throw aiError(e);
  }
  if (res && typeof (res as AsyncIterable<unknown>)[Symbol.asyncIterator] === 'function') {
    try {
      for await (const part of res as AsyncIterable<Record<string, unknown>>) {
        if (!part) continue;
        if (part.type === 'error' || (part.success === false && part.error)) throw aiError(part.error ?? part);
        if (part.type === 'tool_use') yield { type: 'tool', id: String(part.id ?? newCallId()), name: String(part.name ?? ''), input: toolInput(part.input) };
        else if (part.type === 'usage') { if (reachedLimit(part.usage as never, opts.maxTokens)) yield { type: 'cut' }; }
        else if (part.type !== 'reasoning' && typeof part.text === 'string' && part.text) yield { type: 'text', text: part.text };
      }
    } catch (e) {
      throw aiError(e);
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
