/**
 * The AI sidebar: a chat docked at the right of the editor in which Puter AI
 * makes video clips, pictures and voiceovers and edits the timeline with the
 * editor's own tools (media/ai-tools.js, performed by ui/ai-tool-runner.js).
 * Built after the Spreadsheet app's assistant panel.
 *
 * What it shows as it works is what it does: every tool call is a line in
 * the reply ("Generate a video (5.0s)", "Trim clip c1"), with what it is
 * doing while it runs ("Generating 5s of video with Wan 2.7… 0:42") and a
 * link to the clips it touched. Making video costs Puter credits, so by
 * default each video waits for the user's Allow, with the prompt it would
 * send (the approval mode in the panel's menu decides what asks). Each reply
 * that changed the project ends with an Undo that takes back its changes,
 * and only those: not once something else has been done since.
 *
 * Pictures, videos and sound can go with a message: picked with the
 * paperclip, pasted or dropped on the panel. They are imported into the
 * project's media when the message is sent, so the assistant can animate
 * a photo or cut a clip in by its media id; pictures are also shown to it.
 *
 * Collapsed, the panel leaves a thin strip at the window's edge. On phones it
 * opens as a sheet.
 */
import { h, announce } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { shortcutLabel } from '../lib/platform.js';
import { US } from '../lib/time.js';
import * as T from '../model/timeline.js';
import { assistState, secs } from '../media/edit-assistant.js';
import { aiAvailable } from '../media/tts.js';
import { createAgent, suggestions, userText, APPROVAL_MODES, DEFAULT_APPROVAL } from '../media/ai-agent.js';
import { describeCall, changesProject, projectSnapshot } from '../media/ai-tools.js';
import { VIDEO_MODELS, DEFAULT_VIDEO_MODEL, modelSummary } from '../media/ai-video.js';
import { IMAGE_MODELS, DEFAULT_IMAGE_MODEL, imageModel } from '../media/imagegen.js';
import { aiChatStream, friendlyAiError, tooLongForAi } from '../media/ai-chat.js';
import { attachmentProblem, attachmentKind, attachmentsTooLarge, formatSize, ATTACH_ACCEPT, MAX_ATTACHMENTS } from '../media/ai-attach.js';
import { readAttachment } from './ai-attachments.js';
import { renderMarkdown } from './ai-markdown.js';
import { createAiToolRunner } from './ai-tool-runner.js';
import { showMenu } from './menu.js';
import { createSheet } from './sheet.js';
import { toast } from './dialog.js';
import { emptyState } from './panels/common.js';
import '../styles/ai-panel.css';

const SETTINGS_KEY = 'video-studio:ai';
export const MIN_WIDTH = 300;
export const MAX_WIDTH = 640;
const DEFAULT_WIDTH = 380;
const TEXT_PAUSE_MS = 700;
const PAINT_BUDGET_MS = 8;
// The widest the panel is drawn: its limit, or half the window, whichever is less.
const widest = () => Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.floor((globalThis.innerWidth || Infinity) * 0.5)));
// Open at first only where the window leaves the player room beside it: the editor already has two side panels.
const roomy = () => (globalThis.innerWidth || 0) >= 1600;

export function loadAiSettings() {
  let raw = null;
  try {
    raw = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null');
  } catch {
    /* no storage */
  }
  const s = raw && typeof raw === 'object' ? raw : {};
  return {
    approval: APPROVAL_MODES.some((m) => m.id === s.approval) ? s.approval : DEFAULT_APPROVAL,
    videoModel: VIDEO_MODELS.some((m) => m.id === s.videoModel) ? s.videoModel : DEFAULT_VIDEO_MODEL,
    imageModel: IMAGE_MODELS.some((m) => m.id === s.imageModel) ? s.imageModel : DEFAULT_IMAGE_MODEL,
    width: Number.isFinite(s.width) ? Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, s.width)) : DEFAULT_WIDTH,
    open: typeof s.open === 'boolean' ? s.open : roomy(),
  };
}

function saveAiSettings(settings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    /* no storage */
  }
}

/** Times in a reply ("12.5s", "1:05") that the playhead can go to. */
const TIME_RE = /(?<![\w.:])(?:(\d{1,2}):([0-5]\d)(?:\.(\d))?|(\d{1,5}(?:\.\d{1,2})?)s)(?![\w:])/g;
/** Words that may be clip ids. */
const ID_RE = /(?<![\w-])[a-z0-9]{8,12}(?![\w-])/g;

/**
 * createAiPanel(ctx, { chat, services, readFile, onToggle })
 * chat(messages, options) replaces Puter's streamed chat (tests); services go
 * to the tool runner (generation stand-ins); readFile replaces the reading of
 * attachments. Returns { el, rail, sheet, open(),
 * close(), toggle(), send(text), attach(files), isOpen, busy, dispose() }.
 */
export function createAiPanel(ctx, { chat = null, services = {}, readFile = readAttachment, onToggle } = {}) {
  const { store } = ctx;
  const settings = loadAiSettings();
  let isOpen = false;
  let destroyed = false;

  // Development builds take a stand-in chat from globalThis.__vsAiChat for browser checks.
  const devChat = () => (import.meta.env?.DEV && typeof globalThis.__vsAiChat === 'function' ? globalThis.__vsAiChat : null);
  const chatFn = () => chat || ctx.aiChat || devChat() || ((m, o) => aiChatStream(m, o));
  const available = () => Boolean(chat || ctx.aiChat || devChat()) || aiAvailable(ctx);

  const runner = createAiToolRunner(ctx, {
    videoModel: () => settings.videoModel,
    imageModel: () => settings.imageModel,
    testMode: () => Boolean(ctx.aiTestMode),
    ...services,
  });

  const agent = createAgent({
    chat: (messages, options) => chatFn()(messages, options),
    runTool: (name, args, control) => runner.run(name, args, control),
    describe: (name, args) => describeCall(name, args, { videoModel: settings.videoModel, seconds: runner.videoSeconds(name, args) }),
    approve: (step) => askApproval(step),
    snapshot: () => projectSnapshot(assistState(store), { videoModel: modelSummary(settings.videoModel), imageModel: imageModel(settings.imageModel).label }),
    settings: () => settings,
  });

  /* ---------- Frame ---------- */

  const status = h('div.sr-only', { role: 'status', 'aria-live': 'polite' });
  const say = (text) => {
    status.textContent = '';
    requestAnimationFrame(() => (status.textContent = text));
  };
  const keyLabel = () => shortcutLabel(ctx.commands?.keyFor?.('assistant') || 'Mod+K');

  const newChatBtn = h('button.icon-btn.small', { type: 'button', 'aria-label': 'New chat', 'data-tip': 'New chat', onclick: () => newChat() }, icon('newChat', 16));
  const menuBtn = h('button.icon-btn.small', { type: 'button', 'aria-label': 'Assistant settings', 'data-tip': 'Assistant settings', 'aria-haspopup': 'menu', onclick: (e) => openSettings(e.currentTarget) }, icon('more', 16));
  const closeBtn = h('button.icon-btn.small.ai-close', { type: 'button', 'aria-label': 'Collapse the assistant', 'data-tip': `Collapse (${keyLabel()})`, onclick: () => close() }, icon('panelRightClose', 16));
  const head = h('header.ai-head', h('span.ai-head-mark', icon('effects', 15)), h('h2.ai-title', { id: 'ai-panel-title' }, 'AI assistant'), newChatBtn, menuBtn, closeBtn);

  const log = h('div.ai-log', { role: 'log', 'aria-labelledby': 'ai-panel-title', tabindex: '-1' });
  const empty = h('div.ai-empty', { 'aria-live': 'off' });
  const signedOut = h('div.ai-signin', { hidden: true });
  log.append(empty);

  const input = h('textarea.ai-input', { rows: 2, spellcheck: true, placeholder: 'Describe a video to make, or an edit…', 'aria-label': 'Message the assistant', enterKeyHint: 'send' });
  const sendBtn = h('button.ai-send', { type: 'submit', 'aria-label': 'Send', 'data-tip': 'Send (Enter)' }, icon('arrowUp', 17));
  const fileInput = h('input.sr-only', {
    type: 'file', multiple: true, accept: ATTACH_ACCEPT, tabindex: '-1', 'aria-hidden': 'true',
    onchange: () => {
      const files = [...(fileInput.files || [])];
      fileInput.value = '';
      attach(files);
      input.focus();
    },
  });
  const attachBtn = h('button.ai-attach', { type: 'button', 'aria-label': 'Attach files', 'data-tip': 'Attach pictures, videos or sound', onclick: () => fileInput.click() }, icon('attach', 16));
  const tray = h('ul.ai-tray', { 'aria-label': 'Attached files', hidden: true });
  // What goes with a message: the selection and the playhead, a label, not a control.
  const contextChip = h('div.ai-context', { title: 'Sent with your message, with the tracks and clips of this timeline.' });
  const inputWrap = h('div.ai-input-wrap', {
    onpointerdown: (e) => {
      if (e.target === inputWrap || (e.target.closest('.ai-input-bar') && !e.target.closest('button'))) {
        e.preventDefault();
        input.focus();
      }
    },
  }, tray, input, h('div.ai-input-bar', attachBtn, contextChip, sendBtn), fileInput);
  const form = h('form.ai-composer', {
    onsubmit: (e) => {
      e.preventDefault();
      if (agent.busy) stop();
      else submit();
    },
  }, inputWrap, h('p.ai-disclaimer', 'The assistant can make mistakes. Generated video uses Puter credits.'));
  const body = h('div.ai-body', log, signedOut, form);

  const resizer = h('div.ai-resize', { role: 'separator', 'aria-orientation': 'vertical', 'aria-label': 'Resize the assistant', tabindex: '0', 'aria-valuemin': MIN_WIDTH });
  const root = h('aside.ai-panel', { id: 'ai-panel', 'aria-labelledby': 'ai-panel-title', hidden: true }, resizer, head, body, status);
  const rail = h('button.ai-rail', { type: 'button', 'aria-label': 'Expand the AI assistant', 'data-tip': `AI assistant (${keyLabel()})`, 'aria-controls': 'ai-panel', 'aria-expanded': 'false', onclick: () => open() },
    h('span.ai-rail-icon', icon('panelRightOpen', 16)), h('span.ai-rail-mark', icon('effects', 16)));
  root.style.setProperty('--ai-w', `${settings.width}px`);
  sendBtn.disabled = true;

  // On phones the chat opens as a sheet; its tools ride above the log there.
  const phoneTools = h('div.ai-phone-tools',
    h('button.btn.small', { type: 'button', onclick: () => newChat() }, icon('newChat', 14), 'New chat'),
    h('button.btn.small', { type: 'button', 'aria-haspopup': 'menu', onclick: (e) => openSettings(e.currentTarget) }, icon('settings', 14), 'Settings'));
  const sheet = createSheet({ title: 'AI assistant', host: ctx.editor?.el || document.body, className: 'ai-sheet', onClose: () => sheetClosed() });
  const phone = () => ctx.mobile?.mode === 'phone';

  // Keys typed in the panel stay here (Delete on a suggestion must not delete clips); shortcuts with a modifier still work.
  const keepKeys = (e) => {
    if (e.key === 'Escape' && !e.defaultPrevented && !e.target.closest?.('.menu')) {
      e.preventDefault();
      e.stopPropagation();
      if (pendingApproval && e.target.closest?.('.ai-approve')) answer(false);
      else if (agent.busy) stop();
      else if (phone()) sheet.close();
      else focusEditor();
      return;
    }
    if (!e.metaKey && !e.ctrlKey) e.stopPropagation();
  };
  root.addEventListener('keydown', keepKeys);
  body.addEventListener('keydown', (e) => {
    // In the sheet the panel is not an ancestor.
    if (!root.contains(body)) keepKeys(e);
  });
  const focusEditor = () => document.getElementById('main')?.focus({ preventScroll: true });

  /* ---------- Settings ---------- */

  function openSettings(anchor) {
    showMenu(anchor, [
      { heading: 'Changes to the project' },
      ...APPROVAL_MODES.map((m) => ({ label: m.label, radio: true, checked: settings.approval === m.id, onSelect: () => { settings.approval = m.id; saveAiSettings(settings); } })),
      'separator',
      { heading: 'Video model' },
      ...VIDEO_MODELS.map((m) => ({ label: m.label, hint: m.hint, radio: true, checked: settings.videoModel === m.id, onSelect: () => { settings.videoModel = m.id; saveAiSettings(settings); announce(`Video model: ${m.label}`); } })),
      'separator',
      { heading: 'Picture model' },
      ...IMAGE_MODELS.map((m) => ({ label: m.label, hint: m.hint, radio: true, checked: settings.imageModel === m.id, onSelect: () => { settings.imageModel = m.id; saveAiSettings(settings); announce(`Picture model: ${m.label}`); } })),
      'separator',
      { label: 'New chat', icon: 'newChat', onSelect: () => newChat() },
    ], { align: 'end', label: 'Assistant settings' });
  }

  /* ---------- Width ---------- */

  function syncResizer() {
    resizer.setAttribute('aria-valuenow', String(Math.min(settings.width, widest())));
    resizer.setAttribute('aria-valuemax', String(widest()));
  }
  syncResizer();
  const onResize = () => {
    syncResizer();
    if (input.value) fitInput();
  };
  globalThis.addEventListener?.('resize', onResize);

  function setWidth(w, save = true) {
    const width = Math.round(Math.min(widest(), Math.max(MIN_WIDTH, w)));
    settings.width = width;
    root.style.setProperty('--ai-w', `${width}px`);
    syncResizer();
    if (input.value) fitInput();
    ctx.playerView?.relayout?.();
    if (save) saveAiSettings(settings);
  }
  resizer.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const right = root.getBoundingClientRect().right || e.clientX + Math.min(settings.width, widest());
    resizer.setPointerCapture?.(e.pointerId);
    root.classList.add('resizing');
    const move = (ev) => setWidth(right - ev.clientX, false);
    const up = () => {
      resizer.removeEventListener('pointermove', move);
      resizer.removeEventListener('pointerup', up);
      resizer.removeEventListener('pointercancel', up);
      root.classList.remove('resizing');
      saveAiSettings(settings);
    };
    resizer.addEventListener('pointermove', move);
    resizer.addEventListener('pointerup', up);
    resizer.addEventListener('pointercancel', up);
  });
  resizer.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 64 : 16;
    const now = Math.min(settings.width, widest());
    if (e.key === 'ArrowLeft') setWidth(now + step);
    else if (e.key === 'ArrowRight') setWidth(now - step);
    else if (e.key === 'Home') setWidth(MIN_WIDTH);
    else if (e.key === 'End') setWidth(MAX_WIDTH);
    else return;
    e.preventDefault();
    e.stopPropagation();
  });

  /* ---------- Context chip and empty state ---------- */

  function refreshChip() {
    if (!isOpen) return;
    const sel = store.selectedIds.map((id) => T.findClip(store.project, id)?.clip).filter(Boolean);
    const what = sel.length === 1 ? T.clipLabel(store.project, sel[0]) : sel.length ? `${sel.length} clips` : `Playhead ${secs(store.time)}`;
    contextChip.replaceChildren(h('span.ai-context-icon', icon(sel.length ? 'select' : 'clock', 12)), h('span.sr-only', 'Sent with your message: '), h('span.ai-context-label', what));
  }

  let lastSuggestionKey = '';
  function renderEmpty() {
    if (!isOpen || log.querySelector('.ai-msg')) return;
    const list = suggestions(assistState(store));
    const key = list.join('|');
    if (key === lastSuggestionKey && empty.childNodes.length) return;
    lastSuggestionKey = key;
    empty.replaceChildren(
      h('div.ai-empty-mark', icon('effects', 22)),
      h('p.ai-empty-title', 'Make videos, or have this one edited'),
      h('p.ai-empty-text', 'Describe a shot to generate, attach a photo to animate, or ask for an edit. Every change can be undone.'),
      h('ul.ai-suggestions', { 'aria-label': 'Suggestions' }, list.map((text) => h('li', h('button.ai-suggestion', { type: 'button', onclick: () => submit(text) }, text)))),
    );
  }

  function renderAvailability() {
    const ok = available();
    signedOut.hidden = ok;
    log.hidden = !ok;
    form.hidden = !ok;
    if (!ok && !signedOut.childElementCount) {
      const btn = ctx.account?.onSignIn ? h('button.btn.primary', { type: 'button', onclick: () => ctx.account.onSignIn() }, icon('cloud', 16), 'Sign in to Puter') : null;
      signedOut.append(emptyState('user', 'Sign in to use the AI assistant', 'The assistant makes videos and edits with Puter AI, so it needs a Puter account.', btn));
    }
  }

  const offs = [
    store.on('select', () => refreshChip()),
    store.on('time', () => {
      if (!store.selectedIds.length) refreshChip();
    }),
    store.on('change', () => {
      refreshUndos();
      if (!agent.busy) renderEmpty();
    }),
    store.on('history', () => refreshUndos()),
  ];

  /* ---------- Messages ---------- */

  let stick = true;
  const nearBottom = () => log.scrollHeight - log.scrollTop - log.clientHeight < 48;
  log.addEventListener('scroll', () => (stick = nearBottom()), { passive: true });
  const scrollDown = (force = false) => {
    if (force || stick) log.scrollTop = log.scrollHeight;
  };

  /** Times and clip ids in a reply's text, as references the playhead and selection can follow. */
  function refs(text) {
    const out = [];
    const p = store.project;
    const end = store.duration + 5 * US;
    for (const m of text.matchAll(TIME_RE)) {
      const t = m[4] !== undefined ? Number(m[4]) * US : (Number(m[1]) * 60 + Number(m[2]) + (m[3] ? Number(m[3]) / 10 : 0)) * US;
      if (!Number.isFinite(t) || t > end) continue;
      out.push({ start: m.index, end: m.index + m[0].length, target: { time: Math.round(t) } });
    }
    for (const m of text.matchAll(ID_RE)) {
      const f = T.findClip(p, m[0]);
      if (!f) continue;
      out.push({ start: m.index, end: m.index + m[0].length, target: { ids: [m[0]], time: f.clip.start } });
    }
    return out.sort((a, b) => a.start - b.start);
  }
  const refTitle = (target) => (target.ids?.length ? 'Select the clip' : `Go to ${secs(target.time)}`);

  /** Follow a reference or a step's link: select its clips (that still exist) and move the playhead. */
  function follow(target) {
    const ids = (target.ids || []).filter((id) => T.findClip(store.project, id));
    if (target.ids?.length && !ids.length) {
      toast('That clip is no longer in the project.', { kind: 'info' });
      return;
    }
    if (ids.length) store.select(ids);
    if (Number.isFinite(target.time)) store.seek(Math.max(0, Math.min(target.time, store.duration)));
  }
  const mdOptions = { refs, onRef: follow, refTitle };

  function removeKeepingFocus(node) {
    const had = node.contains(document.activeElement);
    node.remove();
    if (had) input.focus({ preventScroll: true });
  }

  const shownUrls = new Set();
  function userBubble(text, items = []) {
    removeKeepingFocus(empty);
    const files = items.length ? h('ul.ai-user-files', { 'aria-label': 'Attached files' }, items.map((item) => {
      if (item.url) shownUrls.add(item.url);
      return h('li.ai-user-file', { title: item.name },
        item.url ? h('img.ai-user-thumb', { src: item.url, alt: item.name }) : h('span.ai-user-chip', icon(item.kind === 'video' ? 'fileVideo' : 'fileAudio', 13), h('span.ai-user-chip-name', item.name)));
    })) : null;
    const msg = h('div.ai-msg.ai-user', h('span.sr-only', 'You said:'), files, text ? h('div.ai-bubble', { dir: 'auto' }, text) : null);
    log.append(msg);
    stick = true;
    scrollDown(true);
    return msg;
  }

  /** One reply, as it arrives: text blocks and tool steps in the order they came. */
  function assistantMessage() {
    const parts = h('div.ai-parts');
    const foot = h('div.ai-foot', { hidden: true });
    const msg = h('div.ai-msg.ai-assistant', { 'aria-busy': 'true' }, h('span.sr-only', 'The assistant said:'), parts, foot);
    const typing = h('div.ai-typing', { 'aria-hidden': 'true' }, h('span'), h('span'), h('span'));
    parts.append(typing);
    log.append(msg);
    scrollDown();
    let block = null;
    let queued = false;
    let fullText = '';
    let paintCost = 0;
    const paint = () => {
      queued = false;
      if (!block) return;
      const t0 = performance.now();
      try {
        block.node.replaceChildren(renderMarkdown(block.text, mdOptions));
      } catch (e) {
        console.error(e);
        block.node.textContent = block.text;
      }
      paintCost = performance.now() - t0;
      scrollDown();
    };
    const queuePaint = () => {
      if (queued) return;
      queued = true;
      if (paintCost <= PAINT_BUDGET_MS) requestAnimationFrame(paint);
      else setTimeout(() => requestAnimationFrame(paint), Math.min(paintCost * 3, 500));
    };
    const steps = new Map();
    let pause = null;
    let done = false;
    const quiet = () => {
      clearTimeout(pause);
      pause = null;
    };
    const waitAfterText = () => {
      quiet();
      pause = setTimeout(() => {
        pause = null;
        if (!done && agent.busy && !typing.isConnected) {
          parts.append(typing);
          scrollDown();
        }
      }, TEXT_PAUSE_MS);
    };
    return {
      msg,
      foot,
      parts,
      get fullText() {
        return fullText;
      },
      append(delta) {
        typing.remove();
        waitAfterText();
        if (!block) {
          block = { node: h('div.ai-text.md', { dir: 'auto' }), text: '' };
          parts.append(block.node);
          if (fullText) fullText = `${fullText.trimEnd()}\n\n`;
        }
        block.text += delta;
        fullText += delta;
        queuePaint();
      },
      round() {
        quiet();
        paint();
        block = null;
        parts.append(typing);
        scrollDown();
      },
      step(step) {
        quiet();
        typing.remove();
        if (block) {
          paint();
          block = null;
        }
        let row = steps.get(step.id);
        if (!row) {
          row = h('div.ai-step');
          steps.set(step.id, row);
          parts.append(row);
        }
        renderStep(row, step);
        if (['done', 'error', 'declined', 'skipped'].includes(step.status) && agent.busy) parts.append(typing);
        scrollDown();
      },
      finish() {
        done = true;
        quiet();
        paint();
        typing.remove();
        msg.removeAttribute('aria-busy');
      },
    };
  }

  const STATUS_ICONS = { running: 'refresh', waiting: 'clock', done: 'check', error: 'alert', declined: 'declined', skipped: 'minus' };
  const STATUS_WORDS = { running: 'running', waiting: 'waiting for your answer', done: 'done', error: 'failed', declined: 'not allowed', skipped: 'not run' };
  function renderStep(row, step) {
    row.className = `ai-step ai-step-${step.status}${changesProject(step.name) ? ' ai-step-change' : ''}${step.costly ? ' ai-step-costly' : ''}`;
    const ic = h('span.ai-step-icon', icon(STATUS_ICONS[step.status] || 'info', 13));
    if (step.status === 'running') ic.classList.add('spin');
    const target = step.target;
    const label = target && step.status === 'done'
      ? h('button.ai-step-label.linkish', { type: 'button', title: refTitle(target), onclick: () => follow(target) }, step.label)
      : h('span.ai-step-label', step.label);
    row.replaceChildren(ic, label, h('span.sr-only', `, ${STATUS_WORDS[step.status] || step.status}`));
    if (step.status === 'running' && step.note) row.append(h('div.ai-step-note', step.note));
    if (step.status === 'error' && step.error) row.append(h('div.ai-step-note', step.error));
    if (step.status === 'declined') row.append(h('div.ai-step-note', 'Not allowed, so not done.'));
    if (step.status === 'waiting') row.append(approvalCard(step));
  }

  /* ---------- Approval ---------- */

  let pendingApproval = null;
  let lastCard = null;
  function approvalCard(step) {
    const allow = h('button.btn.small.primary', { type: 'button', onclick: () => answer(true) }, step.costly ? 'Generate' : 'Allow');
    const deny = h('button.btn.small', { type: 'button', onclick: () => answer(false) }, 'Don’t allow');
    const card = h('div.ai-approve', { role: 'group', 'aria-label': 'Allow this step?' },
      step.detail ? h('p.ai-approve-detail', step.detail) : null,
      h('div.ai-approve-actions', allow, deny));
    lastCard = card;
    // The question takes the focus only from within the panel, never off the message box being typed in.
    const takesFocus = () => (root.contains(document.activeElement) || body.contains(document.activeElement)) && document.activeElement !== input;
    if (takesFocus()) requestAnimationFrame(() => card.isConnected && takesFocus() && allow.focus());
    return card;
  }
  function askApproval(step) {
    return new Promise((resolve) => {
      pendingApproval = { resolve, card: lastCard };
      say(`The assistant wants to ${step.label.charAt(0).toLowerCase()}${step.label.slice(1)}. ${step.detail || ''} Allow or don’t allow.`);
      if (!isOpen) open({ focus: false });
      stick = true;
      scrollDown(true);
    });
  }
  function answer(ok) {
    const p = pendingApproval;
    pendingApproval = null;
    const hadFocus = p?.card?.contains(document.activeElement);
    p?.resolve(ok);
    if (hadFocus) input.focus();
  }

  /* ---------- Attachments ---------- */

  let pending = []; // { file, name, kind, url, ready: Promise<read|null>, node }

  function attach(files) {
    let over = 0;
    const added = [];
    for (const file of files || []) {
      if (pending.length >= MAX_ATTACHMENTS) {
        over++;
        continue;
      }
      const problem = attachmentProblem(file, pending.length);
      if (problem) {
        toast(problem, { kind: 'info', duration: 4500 });
        continue;
      }
      const kind = attachmentKind(file);
      const item = { file, kind, name: file.name || (kind === 'image' ? 'Pasted image' : 'File') };
      item.ready = Promise.resolve().then(() => readFile(file)).catch((e) => {
        if (pending.includes(item)) {
          toast(e?.message || `${item.name} could not be read`, { kind: 'error' });
          removePending(item);
        }
        return null;
      });
      pending.push(item);
      added.push(item.name);
      tray.append(trayItem(item));
    }
    if (added.length) say(`${added.length === 1 ? added[0] : `${added.length} files`} attached`);
    if (over) toast(`Up to ${MAX_ATTACHMENTS} files can go with one message, so ${over === 1 ? '1 was' : `${over} were`} left out.`, { kind: 'info' });
    if (added.length && !isOpen) open();
    syncTray();
  }

  function trayItem(item) {
    const remove = h('button.ai-tray-remove', {
      type: 'button', 'aria-label': `Remove ${item.name}`, title: 'Remove',
      onclick: () => {
        const next = item.node.nextElementSibling || item.node.previousElementSibling;
        removePending(item);
        say(`${item.name} removed`);
        (next?.querySelector('.ai-tray-remove') || input).focus({ preventScroll: true });
      },
    }, icon('close', 11));
    const preview = h('span.ai-tray-icon', icon(item.kind === 'image' ? 'image' : item.kind === 'video' ? 'fileVideo' : 'fileAudio', 15));
    item.node = h('li.ai-tray-item.reading', { title: `${item.name} · ${formatSize(item.file.size)}`, 'aria-busy': 'true' }, preview, h('span.ai-tray-name', item.name), remove);
    item.ready.then((read) => {
      item.node.classList.remove('reading');
      item.node.removeAttribute('aria-busy');
      if (!read?.thumb || !pending.includes(item)) return;
      try {
        item.url = URL.createObjectURL(read.thumb);
      } catch {
        return;
      }
      preview.replaceWith(h('img.ai-tray-thumb', { src: item.url, alt: '' }));
    });
    return item.node;
  }

  function removePending(item) {
    pending = pending.filter((p) => p !== item);
    item.node?.remove();
    if (item.url) URL.revokeObjectURL(item.url);
    syncTray();
  }

  function syncTray() {
    tray.hidden = !pending.length;
    syncSend();
  }

  input.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (!files.length || e.clipboardData?.getData?.('text/plain')?.trim()) return;
    e.preventDefault();
    attach(files);
  });
  for (const zone of [root, rail, body]) {
    zone.addEventListener('dragover', (e) => {
      if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
      e.preventDefault();
      root.classList.add('ai-drop');
      rail.classList.add('ai-drop');
    });
    zone.addEventListener('dragleave', (e) => {
      if (zone.contains(e.relatedTarget)) return;
      root.classList.remove('ai-drop');
      rail.classList.remove('ai-drop');
    });
    zone.addEventListener('drop', (e) => {
      root.classList.remove('ai-drop');
      rail.classList.remove('ai-drop');
      const files = [...(e.dataTransfer?.files || [])];
      if (!files.length) return;
      e.preventDefault();
      e.stopPropagation();
      attach(files);
    });
  }

  /** Bring a message's files into the project's media: the attachments the agent is given. */
  async function importAttachments(items, reads) {
    const out = [];
    for (let i = 0; i < items.length; i++) {
      const read = reads[i];
      try {
        const asset = await ctx.library.importFile(items[i].file, { origin: 'assistant' });
        ctx.actions.registerAsset(asset);
        out.push({ ...read, assetId: asset.id, width: asset.width || read.width, height: asset.height || read.height, seconds: asset.kind !== 'image' && asset.duration ? asset.duration / US : undefined });
      } catch (err) {
        toast(err?.message || `Couldn't add ${items[i].name} to the media`, { kind: 'error' });
      }
    }
    return out;
  }

  /* ---------- Sending ---------- */

  let current = null;
  let sending = false;
  function setBusy(busy) {
    root.classList.toggle('busy', busy);
    sendBtn.replaceChildren(icon(busy ? 'stop' : 'arrowUp', busy ? 14 : 17));
    sendBtn.setAttribute('aria-label', busy ? 'Stop' : 'Send');
    sendBtn.dataset.tip = busy ? 'Stop (Esc)' : 'Send (Enter)';
    sendBtn.classList.toggle('stopping', busy);
    const had = document.activeElement === sendBtn;
    syncSend();
    if (had && sendBtn.disabled) input.focus({ preventScroll: true });
    rail.classList.toggle('busy', busy);
  }
  function syncSend() {
    sendBtn.disabled = !root.classList.contains('busy') && (sending || (!input.value.trim() && !pending.length));
  }

  async function submit(text = null) {
    let message = String(text ?? input.value).trim();
    if ((!message && !pending.length) || agent.busy || sending) return;
    if (!available()) {
      renderAvailability();
      return;
    }
    if (!isOpen) open({ focus: false });
    let items = [];
    let files = [];
    if (pending.length) {
      const waiting = pending;
      sending = true;
      syncSend();
      let read;
      try {
        read = await Promise.all(waiting.map((item) => item.ready));
      } finally {
        sending = false;
      }
      if (destroyed || agent.busy) {
        syncSend();
        return;
      }
      items = waiting.filter((item, i) => read[i] && pending.includes(item));
      const reads = items.map((item) => read[waiting.indexOf(item)]);
      const tooLarge = attachmentsTooLarge(reads);
      if (tooLarge) {
        toast(tooLarge, { kind: 'info', duration: 6000 });
        syncSend();
        return;
      }
      pending = pending.filter((item) => !waiting.includes(item));
      for (const item of items) item.node?.remove();
      syncTray();
      if (text == null) message = input.value.trim();
      if (text == null) {
        input.value = '';
        autoGrow();
      }
      userBubble(message, items);
      sending = true;
      syncSend();
      try {
        files = await importAttachments(items, reads);
      } finally {
        sending = false;
      }
      if (destroyed || agent.busy) return;
      if (!message && !files.length) return;
    } else {
      if (text == null) {
        input.value = '';
        autoGrow();
      }
      userBubble(message);
    }
    for (const button of log.querySelectorAll('.ai-retry, .ai-new-chat')) button.remove();
    exchange((onEvent) => agent.send(message, onEvent, { attachments: files }));
  }

  async function exchange(start) {
    const reply = assistantMessage();
    current = reply;
    setBusy(true);
    say('The assistant is working…');
    const onEvent = (e) => {
      if (destroyed || current !== reply) return;
      if (e.type === 'text') reply.append(e.text);
      else if (e.type === 'round') reply.round();
      else if (e.type === 'step') reply.step(e.step);
    };
    let outcome;
    try {
      outcome = await start(onEvent);
    } catch (error) {
      outcome = { error, steps: [] };
    }
    if (destroyed || current !== reply) return;
    current = null;
    reply.finish();
    setBusy(false);
    renderEmpty();
    if (outcome.error) {
      const firstMessage = agent.messages.filter((m) => m.role === 'user').length <= 1;
      const message = friendlyAiError(outcome.error, { firstMessage });
      const tooLong = tooLongForAi(outcome.error);
      const action = !tooLong
        ? h('button.btn.small.ai-retry', {
          type: 'button',
          onclick: (e) => {
            const failure = e.currentTarget.closest('.ai-error');
            const foot = failure.parentElement;
            removeKeepingFocus(failure);
            foot.hidden = !foot.childElementCount;
            retry();
          },
        }, 'Try again')
        : !firstMessage ? h('button.btn.small.ai-new-chat', { type: 'button', onclick: () => newChat() }, 'New chat') : null;
      reply.foot.hidden = false;
      reply.foot.replaceChildren(h('div.ai-error', { role: 'alert' }, h('span.ai-error-icon', icon('alert', 13)), h('span.ai-error-text', message), action));
      say(`The assistant could not answer: ${message}`);
    } else {
      const cutNote = 'The reply reached its length limit and was cut off. Say "continue" for the rest.';
      say(outcome.stopped ? 'Stopped.' : outcome.cut ? `The assistant has answered. ${cutNote}` : 'The assistant has answered.');
      if (outcome.stopped) reply.parts.append(h('p.ai-stopped', 'Stopped.'));
      else if (outcome.cut) reply.parts.append(h('p.ai-stopped', cutNote));
    }
    if (!isOpen && !outcome.stopped) {
      toast(outcome.error ? 'The assistant could not answer' : 'The assistant has answered', { kind: outcome.error ? 'error' : 'info', action: { label: 'Open', onClick: () => open() } });
    }
    renderFoot(reply, outcome);
  }

  function retry() {
    if (agent.busy) return;
    exchange((onEvent) => agent.retry(onEvent));
  }

  /* ---------- A reply's foot: copy, and Undo for its changes ---------- */

  const undos = new Set();
  function refreshUndos() {
    for (const fn of undos) fn();
  }

  function renderFoot(reply, outcome) {
    const items = [];
    const text = reply.fullText;
    if (text && !outcome.error) {
      items.push(h('button.ai-foot-btn', {
        type: 'button', title: 'Copy the reply', 'aria-label': 'Copy the reply',
        onclick: async () => {
          try {
            await navigator.clipboard.writeText(text);
            toast('Reply copied', { kind: 'success', duration: 1500 });
          } catch {
            toast('Could not copy', { kind: 'info' });
          }
        },
      }, icon('copy', 13)));
    }
    const entries = (outcome.steps || []).filter((st) => st.status === 'done' && st.entry).map((st) => st.entry);
    if (entries.length) {
      const counted = `${entries.length} change${entries.length === 1 ? '' : 's'}`;
      const summary = h('span.ai-foot-summary', `${counted} made`);
      const undoBtn = h('button.btn.small.ai-undo', { type: 'button', onclick: () => undoTurn() }, icon('undo', 13), 'Undo');
      let undone = false;
      // Only this reply's steps, all still on top of the history: anything else and Undo would take other edits too.
      const intact = () => {
        const stack = store.history.undoStack;
        return stack.length >= entries.length && entries.every((e, i) => stack[stack.length - entries.length + i] === e);
      };
      const refresh = () => {
        const ok = !undone && intact();
        summary.textContent = `${counted} ${undone ? 'undone' : 'made'}`;
        summary.classList.toggle('ai-foot-undone', undone);
        undoBtn.hidden = undone;
        undoBtn.disabled = !ok;
        undoBtn.title = ok ? 'Undo the changes in this reply' : 'Other changes came after this reply. Use Undo in the Edit menu or the history panel.';
      };
      const undoTurn = () => {
        if (!intact()) {
          toast('The project has changed since. Use Undo in the Edit menu to go back step by step.', { kind: 'info', duration: 4000 });
          refresh();
          return;
        }
        const had = undoBtn.contains(document.activeElement);
        for (let i = 0; i < entries.length; i++) store.undo();
        undone = true;
        undos.delete(refresh);
        refresh();
        agent.note('(The user then undid the changes in this reply.)');
        announce('Assistant changes undone');
        if (had) input.focus({ preventScroll: true });
      };
      undos.add(refresh);
      refresh();
      items.unshift(summary, undoBtn);
    }
    if (!items.length) return;
    reply.foot.hidden = false;
    reply.foot.prepend(...items);
  }

  function stop() {
    if (!agent.busy) return;
    if (pendingApproval) answer(false);
    agent.stop();
  }

  function newChat() {
    if (agent.busy) stop();
    agent.reset();
    current = null;
    pendingApproval = null;
    undos.clear();
    for (const node of [...log.children]) if (node !== empty) node.remove();
    lastSuggestionKey = '';
    for (const url of shownUrls) URL.revokeObjectURL(url);
    shownUrls.clear();
    log.append(empty);
    renderEmpty();
    setBusy(false);
    input.focus();
    say('New chat');
  }

  /* ---------- Composer ---------- */

  function autoGrow() {
    fitInput();
    syncSend();
  }
  function fitInput() {
    if (!isOpen) return;
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 180)}px`;
  }
  input.addEventListener('input', autoGrow);
  input.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter' && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      if (!agent.busy) submit();
    }
  });

  /* ---------- Open and close ---------- */

  function open({ focus = true, prompt = null } = {}) {
    if (!isOpen) {
      isOpen = true;
      renderAvailability();
      if (phone()) {
        sheet.setContent(phoneTools, body);
        sheet.open(rail.isConnected ? rail : null);
      } else {
        if (body.parentNode !== root) head.after(body);
        root.hidden = false;
        rail.hidden = true;
      }
      rail.setAttribute('aria-expanded', 'true');
      if (input.value) fitInput();
      if (stick) scrollDown(true);
      settings.open = true;
      saveAiSettings(settings);
      refreshChip();
      renderEmpty();
      onToggle?.(true);
      ctx.playerView?.relayout?.();
    }
    if (prompt) {
      input.value = prompt;
      autoGrow();
    }
    if (focus) requestAnimationFrame(() => (available() ? input : signedOut.querySelector('button') || closeBtn).focus({ preventScroll: true }));
  }

  function close({ focus = true } = {}) {
    if (!isOpen) return;
    // A question waiting on the user goes unanswered with the panel shut: the reply stops there.
    if (pendingApproval) stop();
    isOpen = false;
    const had = root.contains(document.activeElement);
    if (sheet.isOpen) sheet.close();
    root.hidden = true;
    rail.hidden = false;
    rail.setAttribute('aria-expanded', 'false');
    settings.open = false;
    saveAiSettings(settings);
    onToggle?.(false);
    ctx.playerView?.relayout?.();
    if (focus && had) rail.focus({ preventScroll: true });
  }

  function sheetClosed() {
    if (!isOpen) return;
    if (pendingApproval) stop();
    isOpen = false;
    rail.setAttribute('aria-expanded', 'false');
    onToggle?.(false);
  }

  /** The layout changed (phone and back): an open panel moves between the side and the sheet. */
  function relayout() {
    if (!isOpen) {
      rail.hidden = false;
      return;
    }
    if (phone() && !sheet.isOpen) {
      root.hidden = true;
      rail.hidden = false;
      sheet.setContent(phoneTools, body);
      sheet.open();
    } else if (!phone() && sheet.isOpen) {
      isOpen = false;
      sheet.close();
      open({ focus: false });
    }
  }

  if (settings.open && !phone()) open({ focus: false });
  else rail.hidden = false;

  return {
    el: root,
    rail,
    sheet,
    open,
    close,
    toggle(force) {
      if (force ?? !isOpen) open();
      else close();
    },
    relayout,
    send: (text) => submit(text),
    attach,
    stop,
    newChat,
    get isOpen() {
      return isOpen;
    },
    get busy() {
      return agent.busy;
    },
    get settings() {
      return settings;
    },
    /** The transcript as the model has it (tests). */
    get messages() {
      return agent.messages;
    },
    get sent() {
      return agent.messages.filter((m) => m.role === 'user').map((m) => userText(m.content));
    },
    dispose() {
      destroyed = true;
      runner.close();
      agent.reset();
      offs.forEach((f) => f?.());
      globalThis.removeEventListener?.('resize', onResize);
      sheet.dispose();
      root.remove();
      rail.remove();
      for (const item of pending) if (item.url) URL.revokeObjectURL(item.url);
      for (const url of shownUrls) URL.revokeObjectURL(url);
    },
  };
}
