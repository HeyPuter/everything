// The conversation loop: runs read tools, turns propose_ calls into proposals the user approves or declines, and feeds
// each result back until the model answers in text. Every tool call gets a tool message, even a declined or stopped
// one, or the next request would be malformed.
import { createReader, clip } from './data.js';
import { BUDGET, capResult, encode, tripContext } from './budget.js';
import { requestMessages, userContent } from './prompt.js';
import { stepLabel, toolList, validateCall } from './tools.js';
import { applyProposal, planProposal } from './proposals.js';
import { toAssistantError } from './chat.js';

export const TURN_LIMITS = Object.freeze({ rounds: 10, calls: 24, reasks: 3, chars: 4000 });
const STOP = Symbol('stop');
let sequence = 0;
const callId = () => `call_${Date.now().toString(36)}_${(++sequence).toString(36)}`;
const isAbort = (error) => error?.name === 'AbortError';

/**
 * - `chat(messages, {model, tools, signal})`: async iterable of `{type: 'text', text}` and `{type: 'tool', id, name, input}`.
 * - `decide(step)`: resolves true to apply a proposal, false to decline it. Asked again with `step.changed` when the
 *   trip changed during review.
 * - `redate({start, end})`: optional hand-off of a date suggestion to the trip's own re-date flow.
 *
 * `send(text, onEvent)` reports `{type: 'text', text}`, `{type: 'step', step}` (read tools), `{type: 'proposal', step}`
 * (whenever its status changes), `{type: 'round'}`, `{type: 'empty'}` and `{type: 'limit'}`, and resolves to
 * `{stopped, error?, steps}`.
 */
export function createAssistant({
  space, uid, chat, decide, services = null, redate = null, model = () => undefined, units = () => null, focusDay = () => null,
  now, makeId, budget = BUDGET,
}) {
  const reader = createReader(space, { uid, now });
  let messages = [];
  let running = null;

  const environment = (signal) => ({ space, uid, reader, services, makeId, signal });

  async function readTool(tool, args, step, { emit, signal }) {
    emit({ type: 'step', step: { ...step } });
    try {
      const result = await tool.run(environment(signal), args);
      step.status = result?.error ? 'error' : 'done';
      emit({ type: 'step', step: { ...step } });
      return encode(capResult(result ?? {}, budget.result));
    } catch (error) {
      step.status = isAbort(error) ? 'skipped' : 'error';
      emit({ type: 'step', step: { ...step } });
      return encode({ error: 'failed', message: isAbort(error) ? 'Stopped by the user.' : `The lookup failed${error?.message ? `: ${clip(error.message, 120)}` : ''}.` });
    }
  }

  async function proposal(name, args, step, { emit, signal, stopped, run }) {
    const show = () => emit({ type: 'proposal', step: { ...step } });
    step.status = 'planning';
    show();
    let planned;
    try { planned = await planProposal(name, args, environment(signal)); } catch (error) {
      step.status = isAbort(error) ? 'skipped' : 'invalid';
      show();
      return encode({ status: 'not_proposed', message: isAbort(error) ? 'Stopped by the user.' : 'The change could not be prepared.' });
    }
    if (!planned.ok) {
      Object.assign(step, { status: 'invalid', error: planned.error });
      show();
      return encode({ status: 'not_proposed', error: planned.code, message: planned.error });
    }
    step.proposal = planned.proposal;
    for (let attempt = 0; attempt < TURN_LIMITS.reasks; attempt++) {
      step.status = 'waiting';
      show();
      const answer = await Promise.race([Promise.resolve().then(() => decide({ ...step })).then(Boolean, () => false), stopped]);
      if (answer === STOP || run.stopped) {
        step.status = 'skipped';
        show();
        return encode({ status: 'not_applied', message: 'The user stopped the assistant before deciding.' });
      }
      if (!answer) {
        step.status = 'declined';
        show();
        return encode({ status: 'declined', message: 'The user declined this change, so nothing changed. Do not try it another way; ask what they would like instead.' });
      }
      step.status = 'applying';
      show();
      let outcome;
      try { outcome = await applyProposal(step.proposal, environment(signal)); } catch (error) {
        Object.assign(step, { status: 'failed', error: error?.code ?? 'apply_failed' });
        show();
        return encode({ status: 'failed', message: `The change could not be saved (${clip(error?.code ?? error?.message ?? 'error', 60)}).` });
      }
      if (outcome.status === 'changed') { Object.assign(step, { proposal: outcome.proposal, changed: true }); continue; }
      if (outcome.status === 'failed') {
        Object.assign(step, { status: 'failed', error: outcome.error });
        show();
        return encode({ status: 'failed', error: outcome.code, message: outcome.error });
      }
      if (outcome.status === 'suggested') {
        let handed = false;
        if (redate) { try { await redate(outcome.suggestion); handed = true; } catch { handed = false; } }
        step.status = 'suggested';
        show();
        return encode(handed
          ? { status: 'handed_to_user', message: 'The date change opened for the user with these dates; they review the effect and confirm it there.' }
          : { status: 'shown', message: 'The user saw the suggestion; they change the trip dates in the trip settings themselves.' });
      }
      Object.assign(step, { status: 'applied', proposal: outcome.proposal, created: outcome.created });
      show();
      return encode({ status: 'applied', created: outcome.created });
    }
    Object.assign(step, { status: 'failed', error: 'changing' });
    show();
    return encode({ status: 'failed', message: 'The trip kept changing while the user reviewed this. Propose again if it is still wanted.' });
  }

  async function answerCall(call, context) {
    const step = { id: call.id, name: call.name, kind: 'read', label: safeLabel(call), status: 'running' };
    context.steps.push(step);
    if (context.run.stopped || ++context.count > TURN_LIMITS.calls) {
      step.status = 'skipped';
      context.emit({ type: 'step', step: { ...step } });
      return encode({ status: 'not_run', message: context.run.stopped ? 'Stopped by the user.' : 'Too many tool calls in one answer. Reply with what you have.' });
    }
    const checked = validateCall(call.name, call.input);
    if (!checked.ok) {
      step.status = 'error';
      context.emit({ type: 'step', step: { ...step } });
      return encode({ error: 'invalid_call', message: checked.error });
    }
    step.kind = checked.tool.kind;
    return checked.tool.kind === 'read' ? readTool(checked.tool, checked.value, step, context) : proposal(call.name, checked.value, step, context);
  }

  function safeLabel(call) {
    try { return stepLabel(call.name, call.input, reader); } catch { return { key: 'assistant.step.other', values: {} }; }
  }

  async function exchange(onEvent) {
    // A turn writes to the transcript it began on: after a reset it may still be winding down.
    const transcript = messages;
    const emit = (event) => { try { onEvent?.(event); } catch (error) { console.error(error); } };
    let resolveStop;
    const stopped = new Promise((resolve) => { resolveStop = resolve; });
    const controller = new AbortController();
    const run = { stopped: false, stop() { if (!this.stopped) { this.stopped = true; controller.abort(); resolveStop(STOP); } } };
    running = run;
    const context = { emit, run, stopped, signal: controller.signal, steps: [], count: 0 };
    try {
      for (let round = 0; round < TURN_LIMITS.rounds; round++) {
        if (round) emit({ type: 'round' });
        let text = '';
        const calls = [];
        const iterator = chat(requestMessages(transcript, { budget: budget.history }), { model: model(), tools: toolList({ space, services }), signal: controller.signal })[Symbol.asyncIterator]();
        for (;;) {
          const next = await Promise.race([iterator.next(), stopped]);
          if (next === STOP) { Promise.resolve(iterator.return?.()).catch(() => {}); break; }
          if (next.done) break;
          const part = next.value;
          if (part?.type === 'text' && typeof part.text === 'string') { text += part.text; emit({ type: 'text', text: part.text }); }
          else if (part?.type === 'tool') {
            const input = part.input && typeof part.input === 'object' && !Array.isArray(part.input) ? part.input : {};
            calls.push({ id: typeof part.id === 'string' && part.id ? part.id.slice(0, 120) : callId(), name: String(part.name ?? '').slice(0, 80), input });
          }
        }
        if (run.stopped) {
          if (text) transcript.push({ role: 'assistant', content: text });
          return { stopped: true, steps: context.steps };
        }
        const empty = !text && !calls.length;
        transcript.push({
          role: 'assistant', content: empty ? '(no reply)' : text || null,
          ...(calls.length ? { tool_calls: calls.map((call) => ({ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.input) } })) } : {}),
        });
        if (!calls.length) {
          if (empty) emit({ type: 'empty' });
          return { stopped: false, steps: context.steps };
        }
        for (const call of calls) transcript.push({ role: 'tool', tool_call_id: call.id, content: await answerCall(call, context) });
        if (run.stopped) return { stopped: true, steps: context.steps };
      }
      transcript.push({ role: 'assistant', content: '(Stopped after the step limit for one message.)' });
      emit({ type: 'limit' });
      return { stopped: false, steps: context.steps };
    } catch (error) {
      return { stopped: run.stopped, error: toAssistantError(error), steps: context.steps };
    } finally {
      if (running === run) running = null;
    }
  }

  return {
    reader,
    get busy() { return Boolean(running); },
    get messages() { return messages; },
    /** Sends what the user wrote with the trip as it is now. */
    send(text, onEvent) {
      if (running) throw new Error('assistant_busy');
      const value = String(text ?? '').trim().slice(0, TURN_LIMITS.chars);
      if (!value) return Promise.resolve({ stopped: false, steps: [] });
      // A reply that failed or was stopped leaves the turn open; close it, since two user messages in a row are refused.
      if (messages.length && messages.at(-1).role !== 'assistant') messages.push({ role: 'assistant', content: '(My previous reply did not finish.)' });
      const snapshot = tripContext(reader, { budget: budget.context, focusDay: focusDay() });
      const preferences = units();
      messages.push({ role: 'user', content: userContent(value, preferences ? { ...snapshot, units: preferences } : snapshot) });
      return exchange(onEvent);
    },
    /** Asks again after a reply that failed, from where it stopped. */
    retry(onEvent) {
      if (running) throw new Error('assistant_busy');
      if (!messages.length || messages.at(-1).role === 'assistant') return Promise.resolve({ stopped: false, steps: [] });
      return exchange(onEvent);
    },
    stop() { running?.stop(); },
    reset() { running?.stop(); running = null; messages = []; },
  };
}
