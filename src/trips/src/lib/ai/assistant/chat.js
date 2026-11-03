// `puter.ai.chat` as the assistant's chat function: an async iterable of `{type: 'text', text}` and
// `{type: 'tool', id, name, input}`, whether the SDK streams or answers whole. Failures become `AssistantError`s with
// a `kind` the panel explains.

const CREDIT_CODES = new Set(['insufficient_funds', 'not_enough_funds', 'payment_required', 'insufficient_credit', 'credit_required']);
const USAGE_CODES = new Set(['rate_limited', 'rate_limit_exceeded', 'too_many_requests', 'usage_limit', 'usage_limit_exceeded', 'monthly_limit', 'limit_exceeded', 'quota_exceeded']);

export class AssistantError extends Error {
  constructor(kind, { status = 0, code = '', detail = '' } = {}) {
    super(kind);
    this.name = 'AssistantError';
    this.kind = kind;
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

/** `credit|usage|auth|offline|unavailable|failed` for anything the SDK throws, returns or streams as an error. */
export function toAssistantError(error, { online = globalThis.navigator?.onLine !== false } = {}) {
  if (error instanceof AssistantError) return error;
  const inner = error?.error && typeof error.error === 'object' ? error.error : error;
  const status = Number(inner?.status ?? inner?.statusCode ?? error?.status ?? 0) || 0;
  const code = String(inner?.code ?? error?.code ?? '').toLowerCase();
  const message = String(inner?.message || (typeof error?.error === 'string' ? error.error : '') || (typeof error === 'string' ? error : '')).slice(0, 300);
  const detail = message.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  let kind = 'failed';
  if (status === 402 || CREDIT_CODES.has(code) || /insufficient (funds|credit)|out of credit|payment required/i.test(message)) kind = 'credit';
  else if (status === 429 || USAGE_CODES.has(code) || /usage limit|rate limit|too many requests|quota/i.test(message)) kind = 'usage';
  else if (status === 401 || status === 403 || code === 'token_auth_failed' || code === 'unauthorized') kind = 'auth';
  else if (!online || (error instanceof TypeError && /fetch|network/i.test(error.message))) kind = 'offline';
  return new AssistantError(kind, { status, code, detail });
}

/** The chat function for `createAssistant`. `testMode` uses Puter's free test mode (automated tests only). */
export function puterChat(puter, { testMode = false } = {}) {
  return async function* chat(messages, { model, tools, maxTokens = 1500, signal } = {}) {
    const ai = puter?.ai;
    if (typeof ai?.chat !== 'function') throw new AssistantError('unavailable');
    const options = { stream: true, ...(model ? { model } : {}), ...(tools?.length ? { tools } : {}), max_tokens: maxTokens };
    let response;
    try { response = testMode ? await ai.chat(messages, true, options) : await ai.chat(messages, options); } catch (error) { throw toAssistantError(error); }
    if (signal?.aborted) return;
    if (response && typeof response[Symbol.asyncIterator] === 'function') {
      try {
        for await (const part of response) {
          if (signal?.aborted) return;
          if (!part) continue;
          if (part.type === 'error' || (part.success === false && part.error)) throw toAssistantError(part.error ?? part);
          if (part.type === 'tool_use') yield { type: 'tool', id: part.id, name: part.name, input: part.input ?? {} };
          else if (typeof part.text === 'string' && part.text && part.type !== 'reasoning') yield { type: 'text', text: part.text };
        }
      } catch (error) { throw toAssistantError(error); }
      return;
    }
    if (response?.success === false) throw toAssistantError(response.error ?? response);
    const message = response?.message ?? {};
    const content = typeof response === 'string' ? response : message.content;
    const text = typeof content === 'string' ? content
      : Array.isArray(content) ? content.map((part) => (typeof part === 'string' ? part : part?.type === 'text' ? part.text ?? '' : '')).join('') : '';
    if (text) yield { type: 'text', text };
    for (const call of message.tool_calls ?? []) {
      let input = call.function?.arguments ?? {};
      if (typeof input === 'string') {
        try { input = input.trim() ? JSON.parse(input) : {}; } catch { input = { __unreadable: input.slice(0, 200) }; }
      }
      yield { type: 'tool', id: call.id, name: call.function?.name, input };
    }
    if (Array.isArray(content)) {
      for (const part of content) if (part?.type === 'tool_use') yield { type: 'tool', id: part.id, name: part.name, input: part.input ?? {} };
    }
  };
}
