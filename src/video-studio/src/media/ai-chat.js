/**
 * One reply from Puter's AI to a conversation, as it arrives (the same
 * reading of puter.ai.chat's stream as the Spreadsheet app's assistant).
 * Yields { type: 'text', text }, { type: 'tool', id, name, input } (a
 * function the model calls) and last { type: 'cut' } when the reply was cut
 * off at maxTokens. A reply the SDK hands back whole, rather than streamed,
 * is yielded in the same pieces. A failure throws an Error whose message is
 * the service's own, as far as it gives one.
 */
export async function* aiChatStream(messages, { model, tools, maxTokens } = {}, sdk = globalThis.puter) {
  if (!sdk?.ai?.chat) throw new Error('AI is not available here');
  const options = { stream: true, ...(model ? { model } : {}), ...(tools?.length ? { tools } : {}), ...(maxTokens ? { max_tokens: maxTokens } : {}) };
  // Puter serves a request from the healthiest route for the model: after anyone's recent failure on Anthropic's,
  // a reseller with none of this chat in its prompt cache, which may drop pictures. Pinned, Anthropic serves first and
  // Puter still falls back when it fails.
  const claude = String(model || '').startsWith('claude-');
  if (claude) options.provider = 'claude';
  // Unasked, Puter lets the model call one tool a reply: "trim it, add a title and captions" took a round trip each.
  if (tools?.length) options.parallelToolCalls = true;
  let res;
  try {
    res = await sdk.ai.chat(claude ? withCacheBreakpoints(messages) : messages, options);
  } catch (e) {
    throw aiError(e);
  }
  if (res && typeof res[Symbol.asyncIterator] === 'function') {
    try {
      for await (const part of res) {
        if (!part) continue;
        if (part.type === 'error' || (part.success === false && part.error)) throw aiError(part.error || part);
        if (part.type === 'tool_use') yield { type: 'tool', id: part.id, name: part.name, input: toolInput(part.input) };
        else if (part.type === 'reasoning') yield { type: 'reasoning' };
        // A stream says nothing of why it ended; its closing token count is how a cut-off reply shows.
        else if (part.type === 'usage') {
          if (reachedLimit(part.usage, maxTokens)) yield { type: 'cut' };
        } else if (typeof part.text === 'string' && part.text) yield { type: 'text', text: part.text };
      }
    } catch (e) {
      throw aiError(e);
    }
    return;
  }
  if (res?.success === false) throw aiError(res.error || res);
  const message = res?.message || {};
  const content = typeof res === 'string' ? res : message.content;
  const text = typeof content === 'string' ? content : Array.isArray(content) ? content.map((c) => (typeof c === 'string' ? c : c?.type === 'text' ? c.text || '' : '')).join('') : '';
  if (text) yield { type: 'text', text };
  for (const call of message.tool_calls || []) yield { type: 'tool', id: call.id, name: call.function?.name, input: toolInput(call.function?.arguments) };
  if (Array.isArray(content)) for (const b of content) if (b?.type === 'tool_use') yield { type: 'tool', id: b.id, name: b.name, input: toolInput(b.input) };
  if (res?.finish_reason === 'length' || res?.stop_reason === 'max_tokens' || message.stop_reason === 'max_tokens' || reachedLimit(res?.usage, maxTokens)) yield { type: 'cut' };
}

const CACHE_LONG = { type: 'ephemeral', ttl: '1h' };
const CACHE = { type: 'ephemeral' };

/** Content as blocks with a cache breakpoint on the last one (an empty text block cannot take one), or null. */
function marked(content, cache) {
  const blocks = typeof content === 'string' ? (content ? [{ type: 'text', text: content }] : []) : Array.isArray(content) ? [...content] : [];
  const last = blocks.at(-1);
  if (!last || (last.type === 'text' && !last.text)) return null;
  blocks[blocks.length - 1] = { ...last, cache_control: cache };
  return blocks;
}

/**
 * The request with prompt-cache breakpoints. Puter caches nothing for Claude unless asked, so every round of every
 * message paid for the whole conversation again. Claude takes at most four:
 * - the instructions (the tools come before them), the same for everyone, kept for an hour;
 * - the end of the last finished turn, and on a turn's first request the end of the one before: earlier turns are
 *   sent shortened (no project state, results cut, see ai-agent.js requestMessages), so they read the same in every
 *   later request, and a new turn reads them from the cache the turn before wrote;
 * - the message that started the current turn, so rounds that add more than the cache looks back over still find it;
 * - the newest message, which the next round reads up to.
 * A tool result goes in Claude's own shape, which keeps its breakpoint: Puter rebuilds an OpenAI tool message
 * without it. The messages given are not changed.
 */
export function withCacheBreakpoints(messages) {
  const out = [...messages];
  const markAt = (i, cache) => {
    const m = messages[i];
    if (!m) return;
    if (m.role === 'tool') {
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
  // Where each turn starts: a message from the user after the instructions or a finished reply.
  const starts = [];
  for (let i = 1; i < messages.length; i++) {
    const prev = messages[i - 1];
    if (messages[i].role === 'user' && (prev.role === 'system' || (prev.role === 'assistant' && !prev.tool_calls?.length))) starts.push(i);
  }
  const turn = starts.at(-1) ?? -1;
  const last = messages.length - 1;
  if (turn === last && starts.length > 2) markAt(starts.at(-2) - 1, CACHE);
  if (starts.length > 1) markAt(turn - 1, CACHE);
  if (turn > 0 && turn < last) markAt(turn, CACHE);
  if (last > 0) markAt(last, CACHE);
  return out;
}

// Whether a reply's token count says it stopped at the limit (Anthropic's models count output_tokens, others completion_tokens).
const reachedLimit = (usage, maxTokens) => !!maxTokens && Number(usage?.output_tokens ?? usage?.completion_tokens) >= maxTokens;

/** A tool call's arguments, which may come as JSON text: what cannot be read is marked so, not taken for no arguments. */
export function toolInput(input) {
  if (typeof input !== 'string') return input ?? {};
  try {
    return input.trim() ? JSON.parse(input) : {};
  } catch {
    return { __unreadable: input };
  }
}

/** An Error for whatever the SDK threw (it often throws a plain { error: { message } } object). */
export function aiError(e) {
  if (e instanceof Error) return e;
  const inner = e?.error && typeof e.error === 'object' ? e.error : e;
  const message = inner?.message || (typeof e?.error === 'string' ? e.error : '') || (typeof e === 'string' ? e : '') || 'The AI did not answer';
  return Object.assign(new Error(message), { code: inner?.code || e?.code });
}

/** Whether a request failed for being longer than the model takes. */
export function tooLongForAi(error) {
  const said = `${String(error?.message || error || '').trim()} ${String(error?.code || '')}`;
  return /context.{0,24}(length|window|limit|size)|(?<!took )too long|too many tokens|maximum.*tokens|token limit/i.test(said);
}

/** A failed request in words that say what to do. */
export function friendlyAiError(error, { firstMessage = false } = {}) {
  const text = String(error?.message || error || '').trim();
  const code = String(error?.code || '');
  if (tooLongForAi(error)) return firstMessage ? 'This message is too long for the AI. Shorten it.' : 'This chat has grown too long for the AI. Start a new chat to carry on.';
  if (/rate.?limit|too many requests|\b429\b|overloaded|try again later/i.test(`${text} ${code}`)) return 'The AI service is busy. Wait a moment, then try again.';
  if (/insufficient.?(funds|credit|balance)|out of credit|quota|usage.?limit|allowance|billing|payment required|\b402\b/i.test(`${text} ${code}`)) return 'Your Puter AI allowance has run out for now.';
  if (/sign.?in|not signed|unauthori[sz]ed|\b401\b|auth(entication)? (required|failed)/i.test(`${text} ${code}`)) return 'Sign in to Puter to use the assistant.';
  if (/network|failed to fetch|offline|timed? ?out|took too long|deadline exceeded|context canceled|ECONN|connection/i.test(text)) return 'The AI service could not be reached. Check your connection.';
  return text ? `The AI service said: ${text.slice(0, 300)}` : 'The AI service did not answer.';
}
