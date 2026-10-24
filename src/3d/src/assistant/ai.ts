import type { AttachmentMeta } from './attach';

/** Message parts. Images and PDFs use the blocks the model receives. */
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

export interface ChatToolResult {
  content: string;
  ok: boolean;
  image?: string;
}

export interface ChatOptions {
  model?: string;
  tools?: unknown[];
  maxTokens?: number;
  signal?: AbortSignal;
  onToolCall?: (call: { id: string; name: string; input: Record<string, unknown> }) => Promise<ChatToolResult>;
}

export type ChatFn = (messages: ChatMessage[], opts: ChatOptions) => AsyncIterable<StreamPart>;

/** An Error for whatever an SDK throws (it often throws a plain object). */
export function aiError(e: unknown): Error {
  if (e instanceof Error) return e;
  const o = e as { error?: unknown; code?: string; message?: string } | string | null;
  const inner = o && typeof o === 'object' && o.error && typeof o.error === 'object' ? (o.error as { message?: string; code?: string }) : (o as { message?: string; code?: string } | null);
  const message = (inner && typeof inner === 'object' && inner.message) || (o && typeof o === 'object' && typeof o.error === 'string' ? o.error : '') || (typeof o === 'string' ? o : '') || 'The AI service did not answer';
  return Object.assign(new Error(message), { code: (inner && typeof inner === 'object' && inner.code) || (o && typeof o === 'object' ? o.code : undefined) });
}
