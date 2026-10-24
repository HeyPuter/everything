import { prefs } from '../app/prefs';
import type { ChatFn, ChatMessage, ChatOptions, StreamPart } from './ai';

const BRIDGE = 'http://127.0.0.1:4174';

export interface CopilotStatus {
  available: boolean;
  authenticated?: boolean;
}

export async function copilotStatus(): Promise<CopilotStatus> {
  try {
    const response = await fetch(`${BRIDGE}/health`);
    if (!response.ok) return { available: false };
    const status = (await response.json()) as { authenticated?: boolean };
    return { available: true, authenticated: status.authenticated === true };
  } catch {
    return { available: false };
  }
}

function eventData(block: string): { event: string; data: string } {
  let event = 'message';
  const data: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
  }
  return { event, data: data.join('\n') };
}

export const copilotChat: ChatFn = async function* (messages: ChatMessage[], opts: ChatOptions = {}): AsyncIterable<StreamPart> {
  if (!prefs.use_online_access) throw new Error('Copilot needs internet access. Turn on Allow Online Access in Preferences ▸ System ▸ Network.');

  let response: Response;
  try {
    response = await fetch(`${BRIDGE}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages, tools: opts.tools, model: opts.model, maxTokens: opts.maxTokens }),
      signal: opts.signal,
    });
  } catch (e) {
    if (opts.signal?.aborted) return;
    throw new Error(`Cannot connect to the local Copilot bridge. Start it with \`npm run copilot:bridge\`. ${(e as Error).message}`);
  }
  if (!response.ok) {
    const body = await response.text();
    throw new Error(body || `The local Copilot bridge returned HTTP ${response.status}.`);
  }
  if (!response.body) throw new Error('The local Copilot bridge did not provide a response stream.');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let complete = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      let boundary: number;
      while ((boundary = buffer.search(/\r?\n\r?\n/)) >= 0) {
        const block = buffer.slice(0, boundary);
        const separator = /^\r?\n\r?\n/.exec(buffer.slice(boundary))?.[0].length ?? 2;
        buffer = buffer.slice(boundary + separator);
        const { event, data } = eventData(block);
        if (!data) continue;
        const payload = JSON.parse(data) as Record<string, unknown>;
        if (event === 'text' && typeof payload.text === 'string') {
          yield { type: 'text', text: payload.text };
        } else if (event === 'tool') {
          const call = {
            id: String(payload.toolCallId ?? ''),
            name: String(payload.toolName ?? ''),
            input: (payload.arguments && typeof payload.arguments === 'object' ? payload.arguments : {}) as Record<string, unknown>,
          };
          if (!opts.onToolCall) throw new Error(`The Copilot bridge requested ${call.name}, but the app cannot run tools in this context.`);
          const result = await opts.onToolCall(call);
          const toolResponse = await fetch(`${BRIDGE}/tool-result`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ requestId: payload.requestId, result }),
            signal: opts.signal,
          });
          if (!toolResponse.ok) throw new Error((await toolResponse.text()) || 'The Copilot bridge could not accept the tool result.');
        } else if (event === 'error') {
          throw new Error(String(payload.message ?? 'The Copilot bridge failed.'));
        } else if (event === 'done') {
          complete = true;
          return;
        }
      }
      if (done) break;
    }
  } finally {
    reader.releaseLock();
  }
  if (!complete && !opts.signal?.aborted) throw new Error('The local Copilot bridge closed before completing the response.');
};
