// The conversation loop (ported from Parametric's assistant): send the user's message with a snapshot of the scene,
// stream the reply, run the tools it calls, send their results back, and
// repeat until the model answers without calling tools. Nothing here touches
// the page: the chat function, the tools and the snapshot come from the
// caller, so a whole exchange can be played out in a test with a scripted
// model.
//
// The transcript is in the OpenAI chat shape. Every tool call
// gets an answer, even one that was stopped, or the next request would be
// refused as malformed. Screenshots go in a user message after the tool
// results and only with the round that took them.

import type { ChatFn, ChatMessage, ChatPart, ChatToolCall, ChatToolResult } from './ai';
import { ATTACHMENT_TURNS, type Attachment, type AttachmentMeta, attachmentMeta, attachmentWeight, attachmentsFit, attachmentsGone, attachmentsIntro } from './attach';
import type { ToolResult, ToolSpec } from './tools';

export const MAX_OUTPUT_TOKENS = 16000;
/** A tool result from an earlier message is cut to this much in later requests. */
const OLD_RESULT_CHARS = 1500;
/** Roughly how much transcript is sent at most (characters). */
const HISTORY_BUDGET = 300000;
const STATE_OPEN = '<scene_state>';
const STATE_CLOSE = '</scene_state>';
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
  | { type: 'round' };

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
  const head = snapshot ? `${STATE_OPEN}\n${snapshot.replace(/<(\s*\/?\s*scene_state)\b/gi, '‹$1')}\n${STATE_CLOSE}\n\n${text}` : text;
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
  while (total > budget) {
    let next = -1;
    for (let i = start + 1; i < out.length; i++) if (isTurn(transcript[i])) { next = i; break; }
    if (next < 0 || next > lastUser) break;
    for (let i = start; i < next; i++) total -= size(out[i], i);
    start = next;
  }
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

export function createAgent(o: AgentOptions) {
  let transcript: ChatMessage[] = [];
  let running: { stopped: boolean; stop(): void } | null = null;

  async function exchange(onEvent: (e: AgentEvent) => void): Promise<ExchangeResult> {
    const messages = transcript;
    const emit = (e: AgentEvent) => { try { onEvent(e); } catch (err) { console.error(err); } };
    let stopResolve!: (v: typeof STOP) => void;
    const stopSignal = new Promise<typeof STOP>((r) => { stopResolve = r; });
    let activeController: AbortController | null = null;
    const run = {
      stopped: false,
      stop() {
        if (!this.stopped) {
          this.stopped = true;
          activeController?.abort();
          stopResolve(STOP);
        }
      },
    };
    running = run;
    const steps: Step[] = [];
    let imagesRefused = false;
    try {
      // No limit on rounds: the model works until it answers, or the user presses Stop.
      for (let round = 0; ; round++) {
        if (round) emit({ type: 'round' });
        let text = '';
        let wasCut = false;
        const calls: { id: string; name: string; input: Record<string, unknown> }[] = [];
        const handled: { id: string; name: string; input: Record<string, unknown>; result: ChatToolResult }[] = [];
        const onToolCall = async (call: { id: string; name: string; input: Record<string, unknown> }): Promise<ChatToolResult> => {
          const step: Step = { id: call.id || newId(), name: call.name, args: call.input, status: 'running' };
          steps.push(step);
          emit({ type: 'step', step: { ...step } });
          const result = await Promise.race([o.runTool(call.name, call.input), stopSignal]);
          let handledResult: ChatToolResult;
          if (result === STOP) {
            step.status = 'skipped';
            handledResult = { ok: false, content: 'Stopped by the user while running; its effect may or may not have been applied. Check the scene before continuing.' };
          } else {
            step.status = result.ok ? 'done' : 'error';
            step.changed = !!result.changed;
            step.summary = result.content.replace(/^Error:\s*/, '').split('\n')[0].slice(0, 300);
            step.image = result.image;
            handledResult = { ok: result.ok, content: result.content, image: result.image };
          }
          emit({ type: 'step', step: { ...step } });
          handled.push({ ...call, result: handledResult });
          return handledResult;
        };
        let req = requestMessages(messages, o.system, { noShots: imagesRefused });
        let attempt = 0;
        for (;;) {
          try {
            activeController = new AbortController();
            const iter = o.chat(req, { model: o.model(), tools: o.tools(), maxTokens: MAX_OUTPUT_TOKENS, signal: activeController.signal, onToolCall })[Symbol.asyncIterator]();
            for (;;) {
              const next = await Promise.race([iter.next(), stopSignal]);
              if (next === STOP) { Promise.resolve(iter.return?.()).catch(() => {}); break; }
              if (next.done) break;
              const part = next.value;
              if (part.type === 'text') { text += part.text; emit({ type: 'text', text: part.text }); }
              else if (part.type === 'tool') calls.push({ id: part.id || newId(), name: part.name, input: part.input });
              else if (part.type === 'cut') wasCut = true;
            }
            activeController = null;
            break;
          } catch (e) {
            activeController = null;
            // A request with a screenshot that fails before anything arrived: try once more without images.
            let turnStart = -1;
            for (let i = messages.length - 1; i >= 0; i--) {
              const x = messages[i];
              if (x.role === 'user' && !x.screenshot) { turnStart = i; break; }
            }
            const hasShot = messages.some((m, i) => m.role === 'user' && m.screenshot && i > turnStart);
            if (hasShot && !imagesRefused && !text && !calls.length && !handled.length && attempt === 0) { attempt++; imagesRefused = true; req = requestMessages(messages, o.system, { noShots: true }); continue; }
            throw e;
          }
        }
        if (run.stopped) {
          if (text.trim()) messages.push({ role: 'assistant', content: text });
          return { stopped: true, steps };
        }
        const allCalls = [...handled, ...calls.map((call) => ({ ...call, result: undefined }))];
        const empty = !text.trim() && !allCalls.length;
        if (empty) text = 'I have nothing to add.';
        if (wasCut && !allCalls.length) text = `${text.trimEnd()}\n\n[My reply was cut off: it reached the length limit.]`;
        const last = calls.at(-1);
        const lastCut = wasCut && !!last && last.input.__unreadable != null;
        messages.push({
          role: 'assistant', content: text.trim() ? text : null,
          ...(allCalls.length ? { tool_calls: allCalls.map((c): ChatToolCall => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.input) } })) } : {}),
        });
        for (const call of handled) messages.push({ role: 'tool', tool_call_id: call.id, content: call.result.content });
        const handledImages = handled.flatMap((call) => call.result.image ? [call.result.image] : []);
        if (handledImages.length) {
          const parts: ChatPart[] = [{ type: 'text', text: handledImages.length === 1 ? 'The screenshot from capture_view:' : `The ${handledImages.length} screenshots from capture_view, in order:` }];
          for (const url of handledImages) {
            const m = /^data:([^;,]+);base64,(.*)$/.exec(url);
            if (m) parts.push({ type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } });
          }
          messages.push({ role: 'user', content: parts, screenshot: true });
        }
        if (!calls.length) {
          if (empty) emit({ type: 'text', text });
          return { stopped: false, cut: wasCut, steps };
        }
        const images: string[] = [];
        for (const call of calls) {
          const step: Step = { id: call.id, name: call.name, args: call.input, status: 'running' };
          steps.push(step);
          let content: string;
          if (run.stopped) {
            step.status = 'skipped';
            content = 'Not run: the user stopped the assistant.';
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
            const result = await Promise.race([o.runTool(call.name, call.input), stopSignal]);
            if (result === STOP) {
              step.status = 'skipped';
              content = 'Stopped by the user while running; its effect may or may not have been applied. Check the scene before continuing.';
            } else {
              step.status = result.ok ? 'done' : 'error';
              step.changed = !!result.changed;
              step.summary = result.content.replace(/^Error:\s*/, '').split('\n')[0].slice(0, 300);
              if (result.image) { step.image = result.image; images.push(result.image); }
              content = result.content;
            }
          }
          emit({ type: 'step', step: { ...step } });
          messages.push({ role: 'tool', tool_call_id: call.id, content });
        }
        if (images.length) {
          const parts: ChatPart[] = [{ type: 'text', text: images.length === 1 ? 'The screenshot from capture_view:' : `The ${images.length} screenshots from capture_view, in order:` }];
          for (const url of images) {
            const m = /^data:([^;,]+);base64,(.*)$/.exec(url);
            if (m) parts.push({ type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } });
          }
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
    /** Sends what the user wrote, with the scene's snapshot as it is now and any files they attached. */
    send(text: string, onEvent: (e: AgentEvent) => void, { attachments = [] as Attachment[] } = {}): Promise<ExchangeResult> {
      if (running) throw new Error('The assistant is still answering');
      // A turn that failed before the model answered is closed first, so roles keep alternating.
      const lastMsg = transcript.at(-1);
      if (lastMsg && lastMsg.role !== 'assistant') transcript.push({ role: 'assistant', content: '(My previous reply did not finish.)' });
      const content = userContent(text, o.snapshot(), attachments);
      transcript.push(attachments.length ? { role: 'user', content, attachments: attachments.map(attachmentMeta) } : { role: 'user', content });
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
    reset() { running?.stop(); running = null; transcript = []; },
  };
}

export type Agent = ReturnType<typeof createAgent>;
