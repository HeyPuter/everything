// The conversation loop: send the user's message with a snapshot of the part,
// stream the reply, run the tools it calls, send their results back, and
// repeat until the model answers without calling tools. Nothing here touches
// the page: the chat function, the tools and the snapshot come from the
// caller, so a whole exchange can be played out in a test with a scripted
// model.
//
// The transcript is in the shape Puter's AI takes (OpenAI's). Every tool call
// gets an answer, even one that was stopped, or the next request would be
// refused as malformed. Screenshots go in a user message after the tool
// results and only with the round that took them.

import { type ChatFn, type ChatMessage, type ChatPart, type ChatToolCall, isTransientError } from '../platform/ai';
import { ATTACHMENT_TURNS, type Attachment, type AttachmentMeta, attachmentMeta, attachmentWeight, attachmentsFit, attachmentsGone, attachmentsIntro } from './attach';
import type { ToolResult, ToolSpec } from './tools';

export const MAX_OUTPUT_TOKENS = 16000;
/** A tool result from an earlier message is cut to this much in later requests. */
const OLD_RESULT_CHARS = 1500;
/**
 * One tool result is cut to this much (about 20k tokens): a sketch of an
 * imported drawing or get_model on every feature can run to megabytes, and a
 * request that outgrows the model's context fails, again on every retry.
 */
const MAX_RESULT_CHARS = 80000;
/** Roughly how much transcript is sent at most (characters). */
const HISTORY_BUDGET = 300000;
/** A request that fails before anything arrived because the service was busy or the connection dropped is sent again this many times. */
export const MAX_RETRIES = 3;
/** Wait before retry n (1, 2, 4 s, give or take 15%). */
const backoff = (n: number) => 1000 * 2 ** (n - 1) * (0.85 + Math.random() * 0.3);
const STATE_OPEN = '<part_state>';
const STATE_CLOSE = '</part_state>';
const NO_IMAGE = '[A screenshot was shown here earlier.]';

export interface Step {
  id: string;
  name: string;
  args: Record<string, unknown>;
  status: 'running' | 'done' | 'error' | 'skipped';
  /** First line of the result (or the error). */
  summary?: string;
  changed?: boolean;
  image?: string;
}

export type AgentEvent =
  | { type: 'text'; text: string }
  | { type: 'step'; step: Step }
  | { type: 'round' }
  /** A request failed in a way that may pass: it is sent again after a wait. */
  | { type: 'retry'; attempt: number; error: Error };

export interface ExchangeResult {
  stopped: boolean;
  error?: Error;
  cut?: boolean;
  steps: Step[];
}

export interface AgentOptions {
  chat: ChatFn;
  tools: () => ToolSpec[];
  runTool: (name: string, args: Record<string, unknown>) => Promise<ToolResult>;
  system: string;
  snapshot: () => string;
  model: () => string;
  /** Whether a tool changes the part: after one fails, the reply's later ones are not run. */
  changes?: (name: string) => boolean;
  /** Milliseconds to wait before retry n (tests). */
  retryDelay?: (n: number) => number;
}

const STOP = Symbol('stop');
let seq = 0;
const newId = () => `call_${Date.now().toString(36)}_${(++seq).toString(36)}`;

/** The user's words without the snapshot sent with them. */
export function userText(content: ChatMessage['content']): string {
  const s = typeof content === 'string' ? content : Array.isArray(content) ? (content.find((p) => p.type === 'text') as { text?: string } | undefined)?.text ?? '' : '';
  const end = s.indexOf(STATE_CLOSE);
  return s.startsWith(STATE_OPEN) && end >= 0 ? s.slice(end + STATE_CLOSE.length).trim() : s;
}

const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}\n[…cut from an earlier turn; call the tool again if needed]` : s);
const NO_TEXT = '(The user sent the files below without a message.)';
type UserMessage = Extract<ChatMessage, { role: 'user' }>;
const isUser = (m: ChatMessage): m is UserMessage => m.role === 'user';
/** A message the user wrote (not the screenshots a tool took). */
const isTurn = (m: ChatMessage): m is UserMessage => isUser(m) && !m.screenshot;
const filesWeight = (m: UserMessage) => (m.attachments ?? []).reduce((n, a) => n + attachmentWeight(a), 0);

/** What the user wrote, with any files attached, as a message's content. */
export function userContent(text: string, snapshot: string, attachments: Attachment[] = []): string | ChatPart[] {
  const head = snapshot ? `${STATE_OPEN}\n${snapshot.replace(/<(\s*\/?\s*part_state)\b/gi, '‹$1')}\n${STATE_CLOSE}\n\n${text}` : text;
  if (!attachments.length) return head;
  return [{ type: 'text', text: head || NO_TEXT }, { type: 'text', text: attachmentsIntro(attachments) }, ...(attachments.flatMap((a) => a.blocks) as ChatPart[])];
}

/**
 * The transcript as sent: instructions first; earlier messages' snapshots,
 * long tool results and screenshots left out; files only with the latest few
 * messages that fit in one request (older ones are named instead); the oldest
 * turns dropped whole past the budget. The latest turn is sent as it is,
 * unless it alone outgrows the budget (a long build has no limit on rounds):
 * then its earlier tool results are cut, oldest first, and the newest round's
 * results, which the model is about to answer, stay whole.
 * noShots leaves out the current screenshot too (a route that refuses images).
 */
export function requestMessages(transcript: ChatMessage[], system: string, { budget = HISTORY_BUDGET, noShots = false } = {}): ChatMessage[] {
  let lastUser = -1;
  for (let i = transcript.length - 1; i >= 0; i--) if (isTurn(transcript[i])) { lastUser = i; break; }
  // Screenshots go only with the round that took them: the newest image message of the current turn.
  let lastImage = -1;
  for (let i = transcript.length - 1; i > lastUser; i--) { const m = transcript[i]; if (isUser(m) && m.screenshot) { lastImage = i; break; } }
  // Messages whose files are still sent: the latest few, newest first, while their files fit in one request together.
  const recent = new Set<number>();
  const carried: AttachmentMeta[] = [];
  const turns = transcript.map((m, i) => (isTurn(m) ? i : -1)).filter((i) => i >= 0).slice(-ATTACHMENT_TURNS).reverse();
  for (const i of turns) {
    const m = transcript[i] as UserMessage;
    if (!m.attachments?.length || !Array.isArray(m.content)) { recent.add(i); continue; }
    carried.push(...m.attachments);
    if (i !== lastUser && !attachmentsFit(carried)) break;
    recent.add(i);
  }
  const weights = new Map<number, number>();
  const out: ChatMessage[] = transcript.map((m, i) => {
    if (isUser(m)) {
      if (m.screenshot) {
        if (i !== lastImage) return { role: 'user', content: NO_IMAGE };
        if (noShots) return { role: 'user', content: '[A screenshot was taken but could not be sent to you; rely on the text results.]' };
        weights.set(i, 6400);
        return { role: 'user', content: m.content };
      }
      const text = userText(m.content);
      if (m.attachments?.length) {
        if (Array.isArray(m.content) && (i >= lastUser || recent.has(i))) {
          weights.set(i, filesWeight(m));
          if (i >= lastUser) return { role: 'user', content: m.content };
          return { role: 'user', content: [{ type: 'text', text: text || NO_TEXT }, ...m.content.slice(1)] };
        }
        const gone = attachmentsGone(m.attachments);
        return { role: 'user', content: text && text !== NO_TEXT ? `${text}\n\n${gone}` : gone };
      }
      return { role: 'user', content: i >= lastUser ? m.content : text };
    }
    if (i >= lastUser) return m;
    if (m.role === 'tool' && m.content.length > OLD_RESULT_CHARS) return { ...m, content: cut(m.content, OLD_RESULT_CHARS) };
    return m;
  });
  const size = (m: ChatMessage, i: number) => (typeof m.content === 'string' ? m.content.length : Array.isArray(m.content) ? ((m.content[0] as { text?: string })?.text?.length ?? 0) + (weights.get(i) ?? 0) : 0) + ('tool_calls' in m ? JSON.stringify(m.tool_calls ?? '').length : 0);
  let total = out.reduce((n, m, i) => n + size(m, i), 0);
  let start = 0;
  // Old turns go in steps of a quarter of the budget, not one at a time as the
  // conversation grows: where it starts then stays put for several requests,
  // which read it from the prompt cache instead of paying to write it all again.
  const step = budget / 4;
  const excess = total > budget ? Math.ceil((total - budget) / step) * step : 0;
  let dropped = 0;
  while (dropped < excess) {
    let next = -1;
    for (let i = start + 1; i < out.length; i++) if (isTurn(transcript[i])) { next = i; break; }
    if (next < 0 || next > lastUser) break;
    for (let i = start; i < next; i++) dropped += size(out[i], i);
    start = next;
  }
  total -= dropped;
  let newest = out.length;
  while (newest > lastUser + 1 && (out[newest - 1].role === 'tool' || isUser(transcript[newest - 1]))) newest--;
  for (let i = lastUser + 1; i < newest && total > budget; i++) {
    const m = out[i];
    if (m.role !== 'tool' || m.content.length <= OLD_RESULT_CHARS) continue;
    const shorter: ChatMessage = { ...m, content: `${m.content.slice(0, OLD_RESULT_CHARS)}\n[…cut to keep the conversation within the model's limit; call the tool again if needed]` };
    total -= size(m, i) - size(shorter, i);
    out[i] = shorter;
  }
  return [{ role: 'system', content: system }, ...out.slice(start)];
}

/** Drops the image data of screenshots already taken (requests show them as NO_IMAGE). */
function releaseShots(messages: ChatMessage[]) {
  for (const m of messages) if (isUser(m) && m.screenshot && m.content !== NO_IMAGE) m.content = NO_IMAGE;
}

export function createAgent(o: AgentOptions) {
  let transcript: ChatMessage[] = [];
  let running: { stopped: boolean; stop(): void } | null = null;

  async function exchange(onEvent: (e: AgentEvent) => void): Promise<ExchangeResult> {
    const messages = transcript;
    const emit = (e: AgentEvent) => { try { onEvent(e); } catch (err) { console.error(err); } };
    let stopResolve!: (v: typeof STOP) => void;
    const stopSignal = new Promise<typeof STOP>((r) => { stopResolve = r; });
    const run = { stopped: false, stop() { if (!this.stopped) { this.stopped = true; stopResolve(STOP); } } };
    running = run;
    const steps: Step[] = [];
    let imagesRefused = false;
    try {
      // No limit on rounds: the model works until it answers, or the user presses Stop.
      for (let round = 0; ; round++) {
        if (round) emit({ type: 'round' });
        let text = '';
        let wasCut = false;
        /** The reply's last part was a tool call: a cut there fell inside that call's arguments. */
        let endedInCall = false;
        const calls: { id: string; name: string; input: Record<string, unknown> }[] = [];
        let req = requestMessages(messages, o.system, { noShots: imagesRefused });
        let retries = 0;
        for (;;) {
          try {
            // Stop aborts the request: return() alone waits for the part the stream is waiting on.
            const abort = new AbortController();
            const iter = o.chat(req, { model: o.model(), tools: o.tools(), maxTokens: MAX_OUTPUT_TOKENS, signal: abort.signal })[Symbol.asyncIterator]();
            for (;;) {
              const next = await Promise.race([iter.next(), stopSignal]);
              if (next === STOP) { abort.abort(); Promise.resolve(iter.return?.()).catch(() => {}); break; }
              if (next.done) break;
              const part = next.value;
              if (part.type === 'text') { text += part.text; endedInCall = false; emit({ type: 'text', text: part.text }); }
              else if (part.type === 'tool') { calls.push({ id: part.id || newId(), name: part.name, input: part.input }); endedInCall = true; }
              else if (part.type === 'cut') wasCut = true;
            }
            break;
          } catch (e) {
            if (run.stopped) break;
            // What arrived before the failure is already on screen: such a reply is not sent again here.
            if (text || calls.length) throw e;
            // The service was busy or the connection dropped: the same request, after a wait Stop cuts short.
            if (retries < MAX_RETRIES && isTransientError(e)) {
              retries++;
              emit({ type: 'retry', attempt: retries, error: e as Error });
              let timer: ReturnType<typeof setTimeout> | undefined;
              const waited = await Promise.race([new Promise<void>((r) => { timer = setTimeout(r, (o.retryDelay ?? backoff)(retries)); }), stopSignal]);
              clearTimeout(timer);
              if (waited === STOP) break;
              continue;
            }
            // A request with a screenshot that fails before anything arrived: try once more without images.
            const hasShot = messages.some((m, i) => m.role === 'user' && m.screenshot && i > messages.findLastIndex((x) => x.role === 'user' && !x.screenshot));
            if (hasShot && !imagesRefused) { imagesRefused = true; req = requestMessages(messages, o.system, { noShots: true }); continue; }
            throw e;
          }
        }
        if (run.stopped) {
          if (text.trim()) messages.push({ role: 'assistant', content: text });
          return { stopped: true, steps };
        }
        const empty = !text.trim() && !calls.length;
        if (empty) text = 'I have nothing to add.';
        if (wasCut && !calls.length) text = `${text.trimEnd()}\n\n[My reply was cut off: it reached the length limit.]`;
        // Puter hands over a call whose JSON the limit cut off as {} (not as unreadable text),
        // so the call is judged by where the reply stopped: running it would act on no arguments.
        const last = calls.at(-1);
        const lastCut = wasCut && !!last && (endedInCall || last.input.__unreadable != null);
        messages.push({
          role: 'assistant', content: text.trim() ? text : null,
          ...(calls.length ? { tool_calls: calls.map((c): ChatToolCall => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.input) } })) } : {}),
        });
        if (!calls.length) {
          if (empty) emit({ type: 'text', text });
          return { stopped: false, cut: wasCut, steps };
        }
        const images: string[] = [];
        /** A change in this reply that failed: the later ones were written expecting it to work. */
        let failed: string | null = null;
        for (const call of calls) {
          const step: Step = { id: call.id, name: call.name, args: call.input, status: 'running' };
          steps.push(step);
          const changes = !!o.changes?.(call.name);
          let content: string;
          if (run.stopped) {
            step.status = 'skipped';
            content = 'Not run: the user stopped the assistant.';
          } else if (failed && changes) {
            step.status = 'skipped';
            step.summary = 'Not run: an earlier change in this reply failed.';
            content = `Not run: ${failed} earlier in this reply failed, and this change may depend on it. The part is as that error left it; call this again if it still applies.`;
          } else if (lastCut && call === last) {
            step.status = 'error';
            step.summary = 'The reply hit its length limit while writing this step.';
            content = `Error: not run. Your reply reached the output limit while writing this call, so its arguments were cut off. Split the work into smaller calls.`;
          } else if (call.input.__unreadable != null) {
            step.status = 'error';
            step.summary = 'The arguments could not be read.';
            content = 'Error: the arguments could not be read as JSON.';
          } else {
            emit({ type: 'step', step: { ...step } });
            // A tool cannot be interrupted: a Stop while it runs waits for it, so
            // its change lands inside this exchange (one undo step) and is reported.
            const result = await o.runTool(call.name, call.input).catch((e): ToolResult => ({ ok: false, content: `Error: ${(e as Error)?.message ?? String(e)}` }));
            step.status = result.ok ? 'done' : 'error';
            step.changed = !!result.changed;
            step.summary = result.content.replace(/^Error:\s*/, '').split('\n')[0].slice(0, 300);
            if (result.image) { step.image = result.image; images.push(result.image); }
            content = result.content.length > MAX_RESULT_CHARS
              ? `${result.content.slice(0, MAX_RESULT_CHARS)}\n[…cut: the result had ${result.content.length.toLocaleString('en-US')} characters. Ask for less at a time (fewer features, a filter or a limit).]`
              : result.content;
          }
          if (changes && step.status === 'error') failed ??= call.name;
          emit({ type: 'step', step: { ...step } });
          messages.push({ role: 'tool', tool_call_id: call.id, content });
        }
        if (images.length) {
          const parts: ChatPart[] = [{ type: 'text', text: images.length === 1 ? 'The screenshot from capture_view:' : `The ${images.length} screenshots from capture_view, in order:` }];
          for (const url of images) {
            const m = /^data:([^;,]+);base64,(.*)$/.exec(url);
            if (m) parts.push({ type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } });
          }
          // Only the newest screenshot is ever sent again: let the older ones' data go.
          releaseShots(messages);
          messages.push({ role: 'user', content: parts, screenshot: true });
        }
        if (run.stopped) return { stopped: true, steps };
      }
    } catch (error) {
      return { stopped: run.stopped, error: error as Error, steps };
    } finally {
      if (running === run) running = null;
    }
  }

  return {
    get busy() { return !!running; },
    get messages() { return transcript; },
    /** Sends what the user wrote, with the part's snapshot as it is now and any files they attached. */
    send(text: string, onEvent: (e: AgentEvent) => void, { attachments = [] as Attachment[] } = {}): Promise<ExchangeResult> {
      if (running) throw new Error('The assistant is still answering');
      // A turn that failed before the model answered is closed first, so roles keep alternating.
      const lastMsg = transcript.at(-1);
      if (lastMsg && lastMsg.role !== 'assistant') transcript.push({ role: 'assistant', content: '(My previous reply did not finish.)' });
      const content = userContent(text, o.snapshot(), attachments);
      transcript.push(attachments.length ? { role: 'user', content, attachments: attachments.map(attachmentMeta) } : { role: 'user', content });
      // A screenshot goes only with the round that took it.
      releaseShots(transcript);
      // Files older than the turns they go with are never sent again, only named: their data is let go.
      for (const m of transcript.filter((x): x is UserMessage => isTurn(x)).slice(0, -ATTACHMENT_TURNS)) {
        if (m.attachments && Array.isArray(m.content) && m.content.length > 1) m.content = [m.content[0]];
      }
      return exchange(onEvent);
    },
    /** Ask again after a reply that failed: the transcript is where the failure left it. */
    retry(onEvent: (e: AgentEvent) => void): Promise<ExchangeResult> {
      if (running) throw new Error('The assistant is still answering');
      return exchange(onEvent);
    },
    stop() { running?.stop(); },
    /** Starts over; an exchange still running ends at once, or when the step it is running finishes. */
    reset() { running?.stop(); transcript = []; },
  };
}

export type Agent = ReturnType<typeof createAgent>;
