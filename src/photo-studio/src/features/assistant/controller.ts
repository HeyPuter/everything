// The Assistant's state and actions, apart from the panel's markup: one
// conversation per open document, asking the model, turning replies into
// checked plans, editing and running plans, and "Show me".
import type { Editor } from '../../editor';
import { commands, findCommand, menuContributions, panels, tools } from '../../app/registry';
import { menuSkeleton } from '../../app/menus';
import { chatWithTools, toAIError } from '../../imaging/ai/puter-ai';
import { Catalog, commandParams } from './catalog';
import { describeDocument, previewImage } from './describe';
import { converse, type ChatFn, type Turn } from './model';
import { buildPlan, planTranscript, setArgs, validatePlan, type Plan, type PlanEnv, type Step } from './plan';
import { needsSelectionNow, PlanRun, plainError } from './runner';
import { assistantSettings, modelLabel } from './settings';
import type { Param } from './params';

export type Pointer = { id: string; label: string; where: string };
export type Message =
  | { id: string; role: 'user'; text: string; image: boolean }
  | { id: string; role: 'assistant'; kind: 'text' | 'answer' | 'error'; text: string; pointers?: Pointer[] }
  | { id: string; role: 'assistant'; kind: 'plan'; text: string; plan: Plan; state: 'ready' | 'running' | 'stepping' | 'done' | 'stopped' | 'failed' | 'discarded'; outcome?: string };
export type PlanMessage = Extract<Message, { kind: 'plan' }>;
export type Conversation = { key: string; messages: Message[]; pending?: { abort: AbortController; status: string }; run?: { run: PlanRun; message: PlanMessage; lastDoc?: unknown } };

const conversations = new Map<string, Conversation>();
const listeners = new Set<() => void>();
export function onAssistantChange(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
let revision = 0;
export const assistantRevision = () => revision;
function changed() {
  revision++;
  for (const fn of listeners) fn();
}

/** The conversation of the active document (or of the empty workspace). */
export function conversation(e: Editor): Conversation {
  const key = e.session?.id ?? 'none';
  let c = conversations.get(key);
  if (!c) conversations.set(key, (c = { key, messages: [] }));
  return c;
}
export function clearConversation(e: Editor) {
  const c = conversation(e);
  if (c.run) return e.message('Stop the running plan first.');
  c.pending?.abort.abort();
  c.messages = [];
  c.pending = undefined;
  changed();
}
/** Conversations of closed documents are dropped. */
export function forgetSession(id: string) {
  conversations.delete(id);
}

let catalog: { size: number; value: Catalog } | undefined;
export function liveCatalog(e: Editor): Catalog {
  const size = commands.size + tools.size + panels.size;
  if (catalog?.size !== size)
    catalog = {
      size,
      value: new Catalog({
        commands,
        tools,
        panels,
        skeleton: menuSkeleton,
        contributions: menuContributions,
        panelMenu: (p) => p.menu?.(e) ?? [],
      }),
    };
  return catalog.value;
}

// Settings schemas of commands loaded for plans.
const paramCache = new Map<string, Param[] | undefined>();
async function preload(ids: string[]) {
  await Promise.all(ids.filter((id) => !paramCache.has(id)).map(async (id) => paramCache.set(id, await commandParams(id).catch(() => undefined))));
}
export function planEnv(e: Editor): PlanEnv {
  const cat = liveCatalog(e);
  const probe = new Map<string, boolean>();
  return {
    entry: (id) => cat.get(id),
    command: (id) => {
      const c = findCommand(id);
      return c && { id: c.id, label: c.label, hidden: c.hidden };
    },
    commands: () => commands.values(),
    params: (id) => paramCache.get(id),
    needsSelection: (id) => {
      if (!probe.has(id)) probe.set(id, needsSelectionNow(e, id));
      return probe.get(id)!;
    },
    hasDocument: e.hasDocument,
    hasSelection: e.hasDocument && !!e.doc.selection,
  };
}

const newId = () => crypto.randomUUID();
/** What earlier turns said, in plain text, for the model. */
function history(c: Conversation): Turn[] {
  const out: Turn[] = [];
  for (const m of c.messages) {
    if (m.role === 'user') out.push({ role: 'user', text: m.text });
    else if (m.kind === 'plan') out.push({ role: 'assistant', text: planTranscript(m.plan, m.outcome ?? (m.state === 'ready' ? 'not run yet' : m.state)) });
    else if (m.kind !== 'error') out.push({ role: 'assistant', text: m.text });
  }
  return out;
}

// Tests replace the chat function (the model never runs in tests).
let chat: ChatFn = (messages, opts) => chatWithTools(messages, opts);
export function setChat(fn: ChatFn) {
  chat = fn;
}

/** Ask the model about a request; adds the user's message and the reply. */
export async function ask(e: Editor, request: string) {
  const text = request.trim();
  if (!text) return;
  const c = conversation(e);
  if (c.pending) return e.message('The Assistant is still answering. Stop it first.');
  const seeImage = assistantSettings.seeImage && e.hasDocument;
  const prior = history(c);
  c.messages.push({ id: newId(), role: 'user', text, image: seeImage });
  const abort = new AbortController();
  c.pending = { abort, status: 'Connecting to Puter…' };
  changed();
  const status = (s: string) => {
    if (c.pending?.abort === abort) {
      c.pending.status = s;
      changed();
    }
  };
  try {
    const { ensureSignedIn } = await import('../retouch/ai');
    await ensureSignedIn();
    const image = seeImage ? await previewImage(e).catch(() => undefined) : undefined;
    status(`Thinking (${modelLabel(assistantSettings.model)})…`);
    const reply = await converse({
      request: text,
      history: prior,
      document: describeDocument(e),
      image,
      catalog: liveCatalog(e),
      chat,
      model: assistantSettings.model,
      signal: abort.signal,
      details: { needsSelection: (id) => needsSelectionNow(e, id), enabled: (id) => safeEnabled(e, id) },
      progress: status,
    });
    if (abort.signal.aborted) return;
    if (reply.imageDropped) {
      const u = [...c.messages].reverse().find((m) => m.role === 'user');
      if (u?.role === 'user') u.image = false;
      c.messages.push({ id: newId(), role: 'assistant', kind: 'text', text: 'The model did not accept the image preview, so it worked from the document description only.' });
    }
    if (reply.kind === 'plan') {
      const ids = (Array.isArray(reply.plan.steps) ? reply.plan.steps : []).map((s) => String((s as { action?: unknown })?.action ?? ''));
      await preload(ids.filter((id) => findCommand(id)).map((id) => findCommand(id)!.id));
      const plan = buildPlan(reply.plan, text, planEnv(e));
      if (!plan.steps.length) c.messages.push({ id: newId(), role: 'assistant', kind: 'text', text: reply.text || plan.summary || 'There is nothing to do for this request.' });
      else c.messages.push({ id: newId(), role: 'assistant', kind: 'plan', text: reply.text, plan, state: 'ready' });
    } else if (reply.kind === 'answer') c.messages.push({ id: newId(), role: 'assistant', kind: 'answer', text: reply.text, pointers: reply.pointers.map((p) => pointer(e, p)).filter((p): p is Pointer => !!p) });
    else c.messages.push({ id: newId(), role: 'assistant', kind: 'text', text: reply.text });
  } catch (error) {
    if (abort.signal.aborted) return;
    const err = toAIError(error);
    c.messages.push({ id: newId(), role: 'assistant', kind: 'error', text: err.code === 'unknown' && !(error as { code?: unknown })?.code ? plainError(error) : err.message + (err.retryable ? ' You can try again.' : '') });
  } finally {
    if (c.pending?.abort === abort) c.pending = undefined;
    changed();
  }
}
/** Stop waiting for the model (whatever arrives later is ignored). */
export function cancelAsk(e: Editor) {
  const c = conversation(e);
  if (!c.pending) return;
  c.pending.abort.abort();
  c.pending = undefined;
  c.messages.push({ id: newId(), role: 'assistant', kind: 'text', text: 'Stopped.' });
  changed();
}
function safeEnabled(e: Editor, id: string) {
  const c = findCommand(id);
  if (!c?.enabled) return undefined;
  try {
    return !!c.enabled(e);
  } catch {
    return false;
  }
}

/** A "Show me" target: a command, tool or panel by ID. */
export function pointer(e: Editor, id: string): Pointer | undefined {
  const cat = liveCatalog(e);
  const x = cat.get(id) ?? cat.get(id.startsWith('window.panel.') ? `panel.${id.slice(13)}` : '') ?? (findCommand(id) ? cat.get(findCommand(id)!.id) : undefined);
  if (!x || x.kind === 'op') return undefined;
  const where = x.kind === 'tool' ? `Tools panel${x.shortcut ? ` · key ${x.shortcut}` : ''}` : x.kind === 'panel' ? 'Window > Panels' : (x.path.join(' > ') || 'Edit > Search') + (x.shortcut ? ` · ${x.shortcut}` : '');
  return { id: x.id, label: x.label.replace(/…$/, ''), where };
}
/** Open the menu holding a command, select a tool or show a panel. */
export function showMe(e: Editor, id: string) {
  if (id.startsWith('tool.')) {
    const t = tools.get(id.slice(5));
    if (!t) return;
    e.setTool(t.id);
    const slot = e.root.querySelector<HTMLElement>(`.toolbar [data-tool="${CSS.escape(t.id)}"]`);
    if (slot) pulse(slot);
    e.message(`${t.label} selected${t.key ? ` (key ${t.key})` : ''}.`);
    return;
  }
  if (id.startsWith('panel.')) return e.dock.show(id.slice(6));
  if (id.startsWith('window.panel.') && panels.has(id.slice(13))) return e.dock.show(id.slice(13));
  if (e.menubar.reveal(id)) return;
  // Commands kept in a panel's own menu: show that panel.
  const x = liveCatalog(e).get(id);
  const owner = [...panels.values()].find((p) => x?.path[0] === `${p.title} panel menu`);
  if (owner) {
    e.dock.show(owner.id);
    e.message(`“${x!.label.replace(/…$/, '')}” is in the ${owner.title} panel’s menu.`);
  } else if (x) e.message(`“${x.label.replace(/…$/, '')}” has no menu entry; search for it with Edit → Search.`);
}
function pulse(el: HTMLElement) {
  el.classList.remove('reveal-pulse');
  void el.offsetWidth;
  el.classList.add('reveal-pulse');
  window.setTimeout(() => el.classList.remove('reveal-pulse'), 2400);
}

// ----- Plans -----
export function findPlan(e: Editor, id: string): PlanMessage | undefined {
  return conversation(e).messages.find((m): m is PlanMessage => m.role === 'assistant' && m.kind === 'plan' && m.id === id);
}
function revalidate(e: Editor, m: PlanMessage) {
  validatePlan(m.plan, planEnv(e));
  changed();
}
export function removeStep(e: Editor, m: PlanMessage, key: string) {
  if (m.state !== 'ready') return;
  m.plan.steps = m.plan.steps.filter((s) => s.key !== key);
  revalidate(e, m);
}
export function moveStep(e: Editor, m: PlanMessage, key: string, by: -1 | 1) {
  if (m.state !== 'ready') return;
  const i = m.plan.steps.findIndex((s) => s.key === key), j = i + by;
  if (i < 0 || j < 0 || j >= m.plan.steps.length) return;
  [m.plan.steps[i], m.plan.steps[j]] = [m.plan.steps[j], m.plan.steps[i]];
  revalidate(e, m);
}
export function editStep(e: Editor, m: PlanMessage, step: Step, args: Record<string, unknown>) {
  if (m.state !== 'ready') return;
  setArgs(step, args, planEnv(e));
  revalidate(e, m);
}
export function discardPlan(m: PlanMessage) {
  if (m.state !== 'ready') return;
  m.state = 'discarded';
  m.outcome = 'discarded by the user';
  changed();
}

/** Run a plan: all remaining steps, or the next one. */
export async function runPlan(e: Editor, m: PlanMessage, mode: 'all' | 'step') {
  const c = conversation(e);
  if (c.run && c.run.message !== m) return e.message('Another plan is running. Stop it first.');
  if (m.state !== 'ready' && m.state !== 'stepping') return;
  if (!c.run) {
    revalidate(e, m);
    const problems = m.plan.steps.flatMap((s) => s.problems);
    if (problems.length) return e.message(`Fix or remove the steps with problems first: ${problems[0]}`);
    if (!m.plan.steps.length) return;
    e.transform.apply();
    e.modal?.apply();
    c.run = { run: new PlanRun(e, m.plan), message: m };
  } else if (c.run.lastDoc !== undefined && c.run.lastDoc !== e.doc) {
    // The document was edited between steps: keep those edits a separate
    // undo step and continue the plan in a new one.
    c.run.run.finish();
    for (const s of m.plan.steps) if (s.status === 'skipped') s.status = 'pending';
    c.run.run = new PlanRun(e, m.plan);
  }
  const r = c.run;
  m.state = 'running';
  changed();
  try {
    await r.run.run(mode === 'step' ? 1 : Infinity);
    r.lastDoc = e.doc;
    if (r.run.done) end(e, c, m, r.run.stopped ? 'stopped' : 'done');
    else m.state = 'stepping';
  } catch {
    r.run.finish();
    end(e, c, m, 'failed');
  } finally {
    changed();
  }
}
/** Stop between steps (a step that waits in a dialog finishes first). */
export function stopPlan(e: Editor, m: PlanMessage) {
  const c = conversation(e);
  if (c.run?.message !== m) return;
  if (m.state === 'stepping') {
    c.run.run.stop();
    c.run.run.finish();
    end(e, c, m, 'stopped');
    changed();
  } else {
    c.run.run.stop();
    m.outcome = 'stopping';
    changed();
  }
}
function end(e: Editor, c: Conversation, m: PlanMessage, state: 'done' | 'stopped' | 'failed') {
  c.run = undefined;
  m.state = state;
  const ran = m.plan.steps.filter((s) => s.status === 'done').length, all = m.plan.steps.length;
  const failed = m.plan.steps.find((s) => s.status === 'failed');
  const undo = ran ? ' Undo removes the changes in one step.' : '';
  m.outcome =
    state === 'done'
      ? `Done: ${all} step${all === 1 ? '' : 's'} applied as one undo step.`
      : state === 'stopped'
        ? `Stopped after ${ran} of ${all} steps.${undo}`
        : `Step ${m.plan.steps.indexOf(failed!) + 1} failed: ${failed?.error ?? 'unknown error'}${ran ? ` The ${ran} step${ran === 1 ? '' : 's'} before it were applied.` : ''}${undo}`;
  e.message(m.outcome);
  e.update();
}
export const isRunning = (e: Editor) => !!conversation(e).run;
