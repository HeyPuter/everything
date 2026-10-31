import './assistant.css';
import { el, uid } from '../../../ui/dom.js';
import { button, iconButton, spinner } from '../../../ui/bits.js';
import { markdown } from '../../../ui/md.js';
import { toast } from '../../../ui/toast.js';
import { t } from '../../../lib/i18n/index.js';
import { aiPrefs, prefs } from '../../../lib/prefs.js';
import { createAssistant, puterChat } from '../../../lib/ai/assistant/index.js';
import { proposalCard } from './preview.js';
import { icon } from './icons.js';

const MODEL_LABELS = { 'claude-sonnet-5-5': 'settings.modelSonnet', 'claude-opus-5-5': 'settings.modelOpus', 'claude-haiku-5-5': 'settings.modelHaiku' };
const RETRY = new Set(['usage', 'offline', 'failed']);
// One conversation per open trip, kept while the trip stays open so closing the panel does not lose it.
const sessions = new WeakMap();

const uidOf = (context) => context.account?.uuid ?? context.session?.account?.uuid ?? context.space?.store?.uid ?? null;
const sdkOf = (context) => context.puter ?? globalThis.puter;
const online = () => globalThis.navigator?.onLine !== false;
const toolButton = (name, label, onclick) => el('button.icon-btn', { type: 'button', title: label, 'aria-label': label, onclick }, icon(name));
const nextFrame = (fn) => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(fn) : setTimeout(fn, 16));

function sessionFor(context) {
  let session = sessions.get(context.space);
  if (session) { session.context = context; return session; }
  session = { context, log: [], notes: [], pending: new Map(), lastApplied: null };
  const chat = typeof context.assistantChat === 'function' ? context.assistantChat : puterChat(sdkOf(context));
  session.assistant = createAssistant({
    space: context.space, uid: uidOf(context), chat,
    services: context.session?.services ?? null,
    model: () => aiPrefs().model,
    units: () => { const value = prefs(); return { temperature: value.tempUnit, distance: value.distanceUnit, currency: value.currency ?? undefined }; },
    focusDay: () => session.context.plan?.get?.().day ?? null,
    redate: typeof context.redate === 'function' ? (dates) => session.context.redate(dates) : null,
    decide: (step) => new Promise((resolve) => { session.pending.set(step.id, resolve); }),
  });
  sessions.set(context.space, session);
  return session;
}

/**
 * The assistant panel for one trip. `embedded` fills `container`; otherwise it is a side panel over the page.
 * Returns `{element, focus, close}`.
 */
export function createPanel(context, { embedded = false, onClose = () => {} } = {}) {
  const session = sessionFor(context);
  const { space } = context;
  const { assistant } = session;
  const available = typeof context.assistantChat === 'function' || typeof sdkOf(context)?.ai?.chat === 'function';
  const canEdit = ['plan.edit', 'lists.edit'].some((action) => space.can(action));
  const titleId = uid('as-title');
  const inputId = uid('as-input');
  const nodes = new Map();
  const cleanups = [];
  let closed = false;

  const model = aiPrefs().model;
  const modelName = Object.hasOwn(MODEL_LABELS, model) ? t(MODEL_LABELS[model]) : model;
  const heading = el('h2.as-title', { id: titleId, tabIndex: -1 }, t('assistant.title'));
  const newChat = toolButton('newChat', t('assistant.newChat'), () => reset());
  const settingsButton = context.app?.navigate ? toolButton('settings', t('assistant.settings'), () => context.app.navigate('#/settings/ai')) : null;
  const head = el('header.as-head', {},
    icon('sparkles', 18),
    el('div.as-head-text', {}, heading, el('p.as-model', {}, t('assistant.model', { model: modelName ?? '' }))),
    el('div.as-head-actions', {}, newChat, settingsButton, iconButton('close', t('assistant.close'), { onclick: () => close() })));

  // Replies stream into the log, so it is not live; finished replies and status changes are announced through `live`.
  const log = el('div.as-log', { role: 'log', 'aria-labelledby': titleId, 'aria-live': 'off', tabIndex: 0 });
  const live = el('p.sr-only', { role: 'status' });
  const thinking = el('div.as-thinking', { hidden: true }, spinner(), el('span', {}, t('assistant.thinking')));
  const input = el('textarea.input.as-input', { id: inputId, rows: 1, maxLength: 4000, placeholder: t('assistant.placeholder'), autocomplete: 'off' });
  const sendButton = button(t('assistant.send'), { variant: 'primary', size: 'sm', type: 'submit' });
  sendButton.prepend(icon('send', 16));
  const stopButton = button(t('assistant.stop'), { variant: 'outline', size: 'sm', hidden: true, onclick: () => assistant.stop() });
  stopButton.prepend(icon('stop', 14));
  const hint = el('p.as-hint', { id: uid('as-hint') });
  const form = el('form.as-composer', { onsubmit: (event) => { event.preventDefault(); void send(input.value); } },
    el('label.sr-only', { htmlFor: inputId }, t('assistant.inputLabel')), input, el('div.as-composer-actions', {}, stopButton, sendButton), hint);
  input.setAttribute('aria-describedby', hint.id);
  const root = el(`aside.as-panel${embedded ? '.is-embedded' : ''}`, { 'aria-labelledby': titleId }, head, log, thinking, live, form);

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) { event.preventDefault(); void send(input.value); }
  });
  input.addEventListener('input', () => { grow(); updateComposer(); });
  root.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !embedded && !event.defaultPrevented) { event.preventDefault(); close(); }
  });

  function grow() {
    input.style.blockSize = 'auto';
    input.style.blockSize = `${Math.min(input.scrollHeight, 160)}px`;
  }
  const announce = (text) => { live.textContent = ''; live.textContent = text; };
  function updateComposer() {
    const busy = assistant.busy;
    const reason = !available ? 'assistant.unavailable' : !online() ? 'assistant.offline' : null;
    input.disabled = !available;
    sendButton.disabled = busy || Boolean(reason) || !input.value.trim();
    sendButton.hidden = busy;
    stopButton.hidden = !busy;
    thinking.hidden = !busy || !session.waitingForText;
    hint.textContent = reason ? t(reason) : canEdit ? t('assistant.hint') : t('assistant.viewerHint');
    hint.dataset.state = reason ? 'warn' : 'normal';
    newChat.disabled = !session.log.length && !busy;
  }

  // Entries are plain data kept in the session; nodes are rebuilt from them.
  function render(entry) {
    const old = nodes.get(entry);
    if (entry.type === 'bot' && old?.isConnected) {
      old.replaceChildren(markdown(entry.text));
      old.setAttribute('aria-busy', entry.streaming ? 'true' : 'false');
      return old;
    }
    const node = draw(entry);
    if (old?.isConnected) old.replaceWith(node); else log.append(node);
    nodes.set(entry, node);
    return node;
  }
  function draw(entry) {
    switch (entry.type) {
      case 'user': return el('div.as-msg.as-user', {}, entry.text);
      case 'bot': return el('div.as-msg.as-bot', { 'aria-busy': entry.streaming ? 'true' : 'false' }, markdown(entry.text));
      case 'steps': return el('ul.as-steps', { 'aria-label': t('assistant.steps') }, entry.steps.map((step) => el('li.as-step', { dataset: { status: step.status } },
        icon(step.status === 'done' ? 'done' : step.status === 'running' ? 'loading' : step.status === 'skipped' ? 'declined' : 'alert', 14),
        el('span', {}, t(step.label?.key ?? 'assistant.step.other', step.label?.values ?? {})))));
      case 'proposal': return proposalCard(entry.step, { onDecide: decideStep, onUndo: undoStep, undo: undoState(entry), handoff: typeof session.context.redate === 'function' });
      case 'error': return el('div.as-error', { role: 'alert' }, icon('alert', 16),
        el('div.as-error-body', {}, el('p', {}, t(`assistant.error.${entry.kind}`)), entry.detail && el('p.as-detail', {}, entry.detail),
          entry.retry && button(t('assistant.retry'), { size: 'sm', variant: 'outline', onclick: () => { entry.retry = false; render(entry); void run((onEvent) => assistant.retry(onEvent)); } })));
      case 'notice': return el('p.as-notice', {}, t(entry.key));
      default: return el('div');
    }
  }
  function renderAll() {
    nodes.clear();
    log.replaceChildren();
    if (!session.log.length) log.append(emptyView());
    for (const entry of session.log) render(entry);
    log.scrollTop = log.scrollHeight;
  }
  function push(entry) {
    if (!session.log.length) log.replaceChildren();
    session.log.push(entry);
    render(entry);
    scroll();
    return entry;
  }
  // Follows new output while the reader is at the bottom of the log.
  let pinned = true;
  log.addEventListener('scroll', () => { pinned = log.scrollHeight - log.scrollTop - log.clientHeight < 80; });
  function scroll() { if (pinned) log.scrollTop = log.scrollHeight; }

  function emptyView() {
    const ideas = canEdit
      ? ['assistant.suggest.day', 'assistant.suggest.unscheduled', 'assistant.suggest.packing', 'assistant.suggest.todos']
      : ['assistant.suggest.overview', 'assistant.suggest.unscheduled', 'assistant.suggest.weather'];
    return el('div.as-empty', {},
      el('div.as-empty-icon', {}, icon('sparkles', 26)),
      el('h3', {}, t('assistant.emptyTitle')),
      el('p', {}, t(available ? 'assistant.emptyBody' : 'assistant.unavailable')),
      available && el('div.as-suggestions', {}, ideas.map((key) => button(t(key), { variant: 'outline', size: 'sm', onclick: () => { void send(t(key)); } }))),
      el('p.as-cost', {}, t('assistant.cost')));
  }

  function undoState(entry) {
    if (entry.step.status !== 'applied') return null;
    if (entry.undone) return 'done';
    const last = session.lastApplied;
    return last?.id === entry.step.id && space.history.canUndo && space.history.label === last.label ? 'available' : null;
  }
  function decideStep(step, approved) {
    const resolve = session.pending.get(step.id);
    if (!resolve) return;
    session.pending.delete(step.id);
    const entry = session.log.find((item) => item.type === 'proposal' && item.step.id === step.id);
    if (entry) { entry.step = { ...entry.step, status: approved ? 'applying' : 'declined' }; render(entry); }
    input.focus({ preventScroll: true });
    resolve(approved);
  }
  async function undoStep(step) {
    const entry = session.log.find((item) => item.type === 'proposal' && item.step.id === step.id);
    if (!entry || undoState(entry) !== 'available') return;
    try {
      await space.history.undo();
      entry.undone = true;
      session.notes.push(`[App note: the user undid "${proposalTitle(entry.step)}".]`);
      announce(t('assistant.undone'));
    } catch { toast(t('assistant.undoFailed')); }
    render(entry);
  }
  const proposalTitle = (step) => nodes.get(session.log.find((item) => item.type === 'proposal' && item.step.id === step.id))?.querySelector('.as-card-title')?.textContent ?? step.name;

  async function send(text) {
    const value = String(text ?? '').trim();
    if (!value || assistant.busy || !available) return;
    if (!online()) { updateComposer(); return; }
    input.value = '';
    grow();
    pinned = true;
    push({ type: 'user', text: value });
    const notes = session.notes.splice(0);
    await run((onEvent) => assistant.send(notes.length ? `${notes.join('\n')}\n\n${value}` : value, onEvent));
  }

  async function run(start) {
    let bot = null;
    let steps = null;
    let frame = 0;
    const proposals = new Map();
    session.waitingForText = true;
    announce(t('assistant.thinking'));
    const flush = () => { frame = 0; if (bot) { render(bot); scroll(); } };
    // Text streamed before a tool call is drawn before the next entry takes over, or it would never render.
    const endBot = () => { if (!bot) return; bot.streaming = false; render(bot); bot = null; };
    let promise;
    try {
      promise = start((event) => {
        if (event.type === 'text') {
          session.waitingForText = false;
          if (!bot) { bot = push({ type: 'bot', text: '', streaming: true }); steps = null; }
          bot.text += event.text;
          if (!frame) frame = nextFrame(flush);
        } else if (event.type === 'step') {
          if (!steps) steps = push({ type: 'steps', steps: [] });
          const index = steps.steps.findIndex((step) => step.id === event.step.id);
          if (index < 0) steps.steps.push(event.step); else steps.steps[index] = event.step;
          render(steps);
          scroll();
        } else if (event.type === 'proposal') {
          if (event.step.status === 'invalid') {
            if (!steps) steps = push({ type: 'steps', steps: [] });
            steps.steps.push({ id: event.step.id, status: 'error', label: { key: 'assistant.step.invalid', values: {} } });
            render(steps);
            return;
          }
          let entry = proposals.get(event.step.id);
          if (!entry) { endBot(); entry = push({ type: 'proposal', step: event.step }); proposals.set(event.step.id, entry); steps = null; }
          entry.step = event.step;
          if (event.step.status === 'applied') {
            const previous = session.log.find((item) => item.type === 'proposal' && item.step.id === session.lastApplied?.id);
            session.lastApplied = { id: event.step.id, label: t(event.step.proposal.history) };
            if (previous && previous !== entry) render(previous);
            announce(t('assistant.applied'));
          } else if (event.step.status === 'waiting') announce(t('assistant.waiting'));
          render(entry);
          scroll();
        } else if (event.type === 'round') {
          endBot();
          session.waitingForText = true;
        } else if (event.type === 'empty') push({ type: 'notice', key: 'assistant.noReply' });
        else if (event.type === 'limit') push({ type: 'notice', key: 'assistant.limit' });
        updateComposer();
      });
      updateComposer();
      const result = await promise;
      if (bot) { bot.streaming = false; render(bot); announce(bot.text.slice(0, 500)); }
      if (result.error) push({ type: 'error', kind: result.error.kind ?? 'failed', detail: result.error.kind === 'failed' ? result.error.detail : '', retry: RETRY.has(result.error.kind) });
      else if (result.stopped) push({ type: 'notice', key: 'assistant.stopped' });
      if (result.error) announce(t(`assistant.error.${result.error.kind ?? 'failed'}`));
    } finally {
      session.waitingForText = false;
      session.pending.clear();
      if (!closed) updateComposer();
    }
  }

  function reset() {
    assistant.reset();
    session.log = [];
    session.notes = [];
    session.pending.clear();
    session.lastApplied = null;
    renderAll();
    updateComposer();
    input.focus();
  }

  function close() {
    if (closed) return;
    closed = true;
    // A proposal still waiting is answered as stopped, so nothing is applied unseen.
    assistant.stop();
    for (const cleanup of cleanups.splice(0)) cleanup();
    root.remove();
    onClose();
  }

  const onNetwork = () => updateComposer();
  window.addEventListener('online', onNetwork);
  window.addEventListener('offline', onNetwork);
  cleanups.push(() => { window.removeEventListener('online', onNetwork); window.removeEventListener('offline', onNetwork); });
  const offHistory = space.history?.subscribe?.(() => { for (const entry of session.log) if (entry.type === 'proposal' && entry.step.status === 'applied') render(entry); });
  if (offHistory) cleanups.push(offHistory);

  renderAll();
  updateComposer();
  return {
    element: root,
    close,
    focus() { if (globalThis.innerWidth >= 640 && !input.disabled) input.focus(); else heading.focus(); },
  };
}
