/**
 * The AI assistant's side panel: a chat beside the sheet in which Puter's AI answers questions about
 * the workbook and changes it through the tools in core/aitools.js.
 *
 * What it shows as it works is what it does: every tool call is a line in the reply ("Read
 * Sheet1!A1:F40", "Write 12 cells to Summary!B2:D5"), linked to the cells it touched. A change that
 * replaces or deletes data waits for the user's Allow (the approval mode in the panel's menu decides
 * which changes ask), and each reply that changed the workbook ends with an Undo that takes back its
 * changes, and only those: not once the user has edited since.
 *
 * The panel says which cells go with a message (the selection chip above the box) and that the
 * replies can be wrong. Cell references in a reply select their cells when clicked.
 *
 * Files can go with a message too: images, PDFs and text files, picked with the paperclip, pasted into
 * the box or dropped on the panel. They wait in a tray over the box until it is sent (core/aiattach.js
 * says what is taken, ui/aiattachments.js reads it for the model).
 */

import { el, isComposing, MOD_KEY } from './dom.js';
import { icon } from './icons.js';
import { openMenu } from './menu.js';
import { toast } from './toast.js';
import { renderMarkdown } from './markdown.js';
import * as P from '../lib/puter.js';
import { trackEvent } from '../lib/analytics.js';
import { createAgent, workbookSnapshot, suggestions, userText, APPROVAL_MODES, DEFAULT_APPROVAL } from '../core/aiagent.js';
import { runTool, describeCall, callTarget, changesWorkbook, qualified } from '../core/aitools.js';
import { attachmentProblem, attachmentKind, attachmentsTooLarge, formatSize, ATTACH_ACCEPT, MAX_ATTACHMENTS } from '../core/aiattach.js';
import { readAttachment } from './aiattachments.js';

const SETTINGS_KEY = 'spreadsheet:ai';
export const MIN_WIDTH = 300;
export const MAX_WIDTH = 720;
const DEFAULT_WIDTH = 380;
const TEXT_PAUSE_MS = 700;
const PAINT_BUDGET_MS = 8; // half a frame: a paint of the reply that takes longer spaces out the next
// The widest the panel is drawn: its limit, or 60% of the window (the stylesheet's max-width), whichever is less.
// A drag or a key stops there, so there is no stretch of the drag that moves nothing on the way back.
const widest = () => Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.floor((globalThis.innerWidth || Infinity) * 0.6)));

/** The sheet keeps less than 640px beside the panel at its usual width: a phone, or a tablet held upright (768px). */
const tooNarrowBeside = () => { try { return !!globalThis.matchMedia?.(`(max-width: ${DEFAULT_WIDTH + 639}px)`).matches; } catch { return false; } };

export function loadAiSettings() {
  let raw = null;
  try { raw = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null'); } catch { /* no storage */ }
  const s = raw && typeof raw === 'object' ? raw : {};
  return {
    approval: APPROVAL_MODES.some((m) => m.id === s.approval) ? s.approval : DEFAULT_APPROVAL,
    width: Number.isFinite(s.width) ? Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, s.width)) : DEFAULT_WIDTH,
    // Open unless the user closed it: beside a wide sheet it takes no cells from view. On a phone it would cover
    // most of the grid, and on an upright tablet half of it, leaving the sheet a phone's width, so there it waits
    // to be asked for, until it has been left open there. Each layout keeps its own choice: the panel left open in a
    // wide window (where it opens by itself) must not come up over the whole grid when the app opens on a phone.
    open: tooNarrowBeside() ? s.openNarrow === true : (typeof s.open === 'boolean' ? s.open : true),
    openWide: typeof s.open === 'boolean' ? s.open : null,
    openNarrow: typeof s.openNarrow === 'boolean' ? s.openNarrow : null,
  };
}

/** Note the panel open or closed, for the layout the window has now. */
function setOpenSetting(settings, on) {
  settings.open = on;
  if (tooNarrowBeside()) settings.openNarrow = on; else settings.openWide = on;
}

function saveAiSettings({ approval, width, openWide, openNarrow }) {
  const kept = { approval, width, ...(openWide != null ? { open: openWide } : {}), ...(openNarrow != null ? { openNarrow } : {}) };
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(kept)); } catch { /* no storage */ }
}

/**
 * Whether a request failed for being longer than the model takes. The model's context by its length, window or limit:
 * a bare "context" is as often a request's ("context deadline exceeded", "context canceled"), a timeout, not a long chat.
 * Asked again, the same request fails the same way.
 */
export function tooLongForAi(error) {
  const said = `${String(error?.message || error || '').trim()} ${String(error?.code || '')}`;
  return /context.{0,24}(length|window|limit|size)|(?<!took )too long|too many tokens|maximum.*tokens|token limit/i.test(said);
}

/**
 * A failed request in words that say what to do. Each kind is matched on what the service says of it: a
 * conversation too long for the model, requests coming too fast, an allowance used up, no session, no
 * connection. Anything else is quoted. `firstMessage`: the chat holds only the message that failed, which a new chat
 * would not make any shorter.
 */
export function friendlyAiError(error, { firstMessage = false } = {}) {
  const text = String(error?.message || error || '').trim();
  const code = String(error?.code || '');
  if (tooLongForAi(error)) {
    return firstMessage
      ? 'This message is too long for the AI. Shorten it, or ask about a smaller range.'
      : 'This chat has grown too long for the AI. Start a new chat to carry on.';
  }
  if (/rate.?limit|too many requests|\b429\b|overloaded|try again later/i.test(`${text} ${code}`)) return 'The AI service is busy. Wait a moment, then try again.';
  if (/insufficient.?(funds|credit|balance)|out of credit|quota|usage.?limit|allowance|billing|payment required|\b402\b/i.test(`${text} ${code}`)) return 'Your Puter AI allowance has run out for now.';
  if (/sign.?in|not signed|unauthori[sz]ed|\b401\b|auth(entication)? (required|failed)/i.test(`${text} ${code}`)) return 'Sign in to Puter to use the assistant.';
  if (/network|failed to fetch|offline|timed? ?out|took too long|deadline exceeded|context canceled|ECONN|connection/i.test(text)) return 'The AI service could not be reached. Check your connection.';
  return text ? `The AI service said: ${text.slice(0, 300)}` : 'The AI service did not answer.';
}

/**
 * Cell references in a reply's text: Sheet1!B2:C9, 'Q1 Data'!A1, B2:B20, whole columns (C:C, Sheet1!A:D), and single
 * cells near the data. Whole rows ("3:1") are left alone: in prose they are ratios and times.
 */
const REF_RE = /(?<![\p{L}\p{N}_$.!'])((?:'(?:[^']|'')+'|[\p{L}_][\p{L}\p{N}_.]*)!)?(\$?[A-Z]{1,3}\$?[1-9]\d{0,6}(?::\$?[A-Z]{1,3}\$?[1-9]\d{0,6})?|\$?[A-Z]{1,3}:\$?[A-Z]{1,3})(?![\p{L}\p{N}_(])/gu;

/**
 * The panel for the editor's `ctx`. `env` is what the tools need of the editor (see runTool);
 * `env.whenIdle()` is null, or a promise that settles when the entry the user is typing ends. `onToggle`
 * hears the panel open and close, for the editor's layout; `onBusy` hears a reply begin and end.
 */
export function createAiPanel(ctx, env, { onToggle, onBusy } = {}) {
  const { wb } = ctx;
  const settings = loadAiSettings();
  let isOpen = false;
  let destroyed = false;

  // The sheet a range without a sheet name means to the assistant: the one the user was on when they sent the message,
  // moved on only by the assistant's own steps (adding or showing a sheet, selecting a range elsewhere). The user may
  // look at other sheets while it works; its "A2" still means the A2 it was writing about, and that it asked about.
  let aiSheet = null;
  const withSheet = (sheetId) => Object.assign(Object.create(env), { sheetId });
  const aiEnv = withSheet(() => (aiSheet != null && wb.sheet(aiSheet) ? aiSheet : env.sheetId()));
  const runPinned = async (name, args, control) => {
    const live = env.sheetId();
    // Once a step has moved the user's view, the sheet it moved to is the assistant's (and the step says so). A tool
    // that takes a while (the Solver) moves no view: the sheets the user looks at meanwhile are their own. It hears a
    // stop, and gives up changing nothing.
    let pinned = null;
    const toolEnv = withSheet(() => pinned ?? (env.sheetId() !== live ? env.sheetId() : aiEnv.sheetId()));
    toolEnv.stopped = () => !!control?.stopped?.();
    toolEnv.waiting = (note) => control?.waiting?.(note);
    const pending = runTool(wb, name, args, toolEnv);
    if (typeof pending?.then === 'function') pinned = toolEnv.sheetId();
    const result = await pending;
    // Showing a sheet or selecting on it points the assistant there, even when the user was already looking at it.
    if (pinned == null && (env.sheetId() !== live || (result.ok && (name === 'select_range' || (name === 'manage_sheet' && args?.action === 'activate'))))) aiSheet = env.sheetId();
    return result;
  };

  const agent = createAgent({
    chat: (messages, options) => P.aiChatStream(messages, options),
    runTool: async (name, args, control) => {
      // A change waits for the entry the user is typing to end: committing it for them would cut their typing
      // short, and the keys they press next would start a new entry over the cell. So does a selection, which
      // commits the entry when it goes to another sheet.
      const idle = changesWorkbook(name) || name === 'select_range' ? env.whenIdle?.() : null;
      if (idle) {
        control?.waiting?.('Waiting for you to finish the cell you are typing in');
        await idle;
        if (control?.stopped?.()) return { skipped: true };
      }
      return runPinned(name, args, control);
    },
    // The wait comes first, before the change is weighed and asked about: a value the user commits meanwhile into the
    // cells it writes is data it replaces. (It waits again if an entry was begun while its question was open.)
    ready: (name, args, control) => {
      const idle = env.whenIdle?.();
      if (idle) control?.waiting?.('Waiting for you to finish the cell you are typing in');
      return idle;
    },
    // With the cells it is about, which its line links to while it runs and while it asks to be allowed: the user can
    // look at what a change would replace before they answer.
    describe: (name, args) => {
      const described = describeCall(wb, name, args, aiEnv);
      let target = null;
      try { target = callTarget(wb, name, args || {}, aiEnv); } catch { /* it names no cells */ }
      return target ? { ...described, target } : described;
    },
    approve: (step) => askApproval(step),
    snapshot: () => workbookSnapshot(wb, { sheetId: env.sheetId(), selection: env.selection(), docName: ctx.doc?.name }),
    settings: () => settings,
  });

  /* ---------- Frame ---------- */

  const status = el('div.visually-hidden', { role: 'status', 'aria-live': 'polite' });
  const say = (text) => { status.textContent = ''; requestAnimationFrame(() => { status.textContent = text; }); };

  const newChatBtn = el('button.icon-btn', { type: 'button', html: icon('newChat', 18), 'aria-label': 'New chat', title: 'New chat', onclick: () => newChat() });
  const menuBtn = el('button.icon-btn', { type: 'button', html: icon('moreV', 18), 'aria-label': 'Assistant settings', title: 'Assistant settings', 'aria-haspopup': 'menu', onclick: (e) => openSettings(e.currentTarget) });
  // Beside the sheet the panel folds away to the right; on a phone it is a sheet over the grid, which goes down. The
  // stylesheet shows the icon for the layout in use.
  const closeBtn = el('button.icon-btn.ai-close', { type: 'button', 'aria-label': 'Collapse the assistant', title: `Collapse (${MOD_KEY}+J)`, onclick: () => close() },
    el('span.ai-close-side', { html: icon('panelCollapse', 18), 'aria-hidden': 'true' }),
    el('span.ai-close-down', { html: icon('chevD', 18), 'aria-hidden': 'true' }));
  const title = el('h2.ai-title', { id: 'ai-panel-title' }, 'Assistant');
  const head = el('header.ai-head', {},
    el('span.ai-head-mark', { html: icon('sparkle', 16, 2), 'aria-hidden': 'true' }),
    title,
    newChatBtn, menuBtn, closeBtn);

  const log = el('div.ai-log', { role: 'log', 'aria-labelledby': 'ai-panel-title', tabIndex: -1 });
  // Not announced as the log's messages are: it is redrawn as the sheet changes (and on each switch between an empty
  // sheet and one with data), and a screen reader would read out the whole introduction each time.
  const empty = el('div.ai-empty', { 'aria-live': 'off' });
  log.append(empty);

  const input = el('textarea.ai-input', {
    rows: 3, spellcheck: true, placeholder: 'Ask about or change this spreadsheet…', 'aria-label': 'Message the assistant',
    enterKeyHint: 'send',
  });
  const sendBtn = el('button.ai-send', { type: 'submit', html: icon('arrowUp', 18, 2.2), 'aria-label': 'Send', title: 'Send (Enter)' });
  // Files to go with the next message: picked, pasted into the box, or dropped on the panel.
  const fileInput = el('input.visually-hidden', {
    type: 'file', multiple: true, accept: ATTACH_ACCEPT, tabIndex: -1, 'aria-hidden': 'true',
    onchange: () => { const files = [...(fileInput.files || [])]; fileInput.value = ''; attach(files); input.focus(); },
  });
  const attachBtn = el('button.ai-attach', {
    type: 'button', html: icon('attach', 17, 2), 'aria-label': 'Attach files', title: 'Attach images, PDFs or text files',
    onclick: () => fileInput.click(),
  });
  const tray = el('ul.ai-tray', { 'aria-label': 'Attached files', hidden: true });
  // What goes with a message: a label, not a control. As a button it re-selected the selection's first range,
  // which threw away the rest of a selection made of several.
  const contextChip = el('div.ai-context', { title: 'Sent with your message, with the sheet names and the first rows of this sheet. Select other cells to send those instead.' });
  // The selection rides in the box, beside Send: one frame for all that goes with the message. A press on the box's
  // empty space puts the caret in it, as it would in a field that size.
  const inputWrap = el('div.ai-input-wrap', { onpointerdown: (e) => { if (e.target === inputWrap || (e.target.closest('.ai-input-bar') && !e.target.closest('button'))) { e.preventDefault(); input.focus(); } } },
    tray,
    input,
    el('div.ai-input-bar', {}, attachBtn, contextChip, sendBtn),
    fileInput);
  const form = el('form.ai-composer', { onsubmit: (e) => { e.preventDefault(); if (agent.busy) stop(); else submit(); } },
    inputWrap,
    el('p.ai-disclaimer', {}, 'The assistant can make mistakes. Check important figures.'));

  const resizer = el('div.ai-resize', {
    role: 'separator', 'aria-orientation': 'vertical', 'aria-label': 'Resize the assistant', tabIndex: 0,
    'aria-valuemin': MIN_WIDTH,
  });
  const root = el('aside.ai-panel', { id: 'ai-panel', 'aria-labelledby': 'ai-panel-title', hidden: true }, resizer, head, log, form, status);
  // Collapsed, the panel leaves a thin strip at the window's edge that says it is there and opens it again.
  const rail = el('button.ai-rail', {
    type: 'button', 'aria-label': 'Expand the assistant', title: `Expand the assistant (${MOD_KEY}+J)`,
    'aria-controls': 'ai-panel', 'aria-expanded': 'false', onclick: () => open(),
  },
  el('span.ai-rail-icon', { html: icon('panelExpand', 18), 'aria-hidden': 'true' }),
  el('span.ai-rail-mark', { html: icon('sparkle', 16, 2), 'aria-hidden': 'true' }));
  // The saved width is kept as it is (a larger window shows it all); the stylesheet draws what fits now.
  root.style.setProperty('--ai-w', `${settings.width}px`);
  sendBtn.disabled = true;

  /* ---------- Settings ---------- */

  function openSettings(anchor) {
    openMenu({
      anchor, align: 'end', label: 'Assistant settings',
      items: [
        { header: 'Changes to the sheet' },
        ...APPROVAL_MODES.map((m) => ({ label: m.label, checked: settings.approval === m.id, radio: true, onSelect: () => { settings.approval = m.id; saveAiSettings(settings); } })),
        { separator: true },
        { label: 'New chat', icon: 'newChat', onSelect: () => newChat() },
      ],
    });
  }

  /* ---------- Width ---------- */

  // The handle's value is the width drawn, which a narrower window holds under the saved one.
  function syncResizer() {
    resizer.setAttribute('aria-valuenow', String(Math.min(settings.width, widest())));
    resizer.setAttribute('aria-valuemax', String(widest()));
  }
  syncResizer();
  const onResize = () => { syncResizer(); if (input.value) fitInput(); };
  globalThis.addEventListener?.('resize', onResize);

  function setWidth(w, save = true) {
    const width = Math.round(Math.min(widest(), Math.max(MIN_WIDTH, w)));
    settings.width = width;
    root.style.setProperty('--ai-w', `${width}px`);
    syncResizer();
    if (input.value) fitInput();
    if (save) saveAiSettings(settings);
  }
  resizer.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    // The panel's edge follows the pointer: its width is what lies between the pointer and the panel's right side.
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
    if (e.key === 'ArrowLeft') { e.preventDefault(); setWidth(now + step); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); setWidth(now - step); }
    else if (e.key === 'Home') { e.preventDefault(); setWidth(MIN_WIDTH); }
    else if (e.key === 'End') { e.preventDefault(); setWidth(MAX_WIDTH); }
  });

  /* ---------- Selection chip ---------- */

  function refreshChip() {
    if (!isOpen) return;
    const sel = env.selection();
    // A chart sheet has no cells: nothing selected goes with the message there.
    if (!sel || !wb.sheet(sel.sheetId) || wb.sheet(sel.sheetId).kind === 'chart') { contextChip.hidden = true; return; }
    contextChip.hidden = false;
    const cells = (sel.range.r2 - sel.range.r1 + 1) * (sel.range.c2 - sel.range.c1 + 1);
    const text = qualified(wb, sel.sheetId, sel.range);
    contextChip.replaceChildren(el('span.ai-context-icon', { html: icon('borders', 13, 2), 'aria-hidden': 'true' }),
      el('span.visually-hidden', {}, 'Sent with your message: the selection, '),
      el('span.ai-context-label', {}, text),
      ...(cells > 1 ? [el('span.ai-context-count', {}, `${cells.toLocaleString()} cells`)] : []));
  }
  const unsubscribe = ctx.subscribe?.(() => { refreshChip(); if (!log.querySelector('.ai-msg')) renderEmpty(); }) || (() => {});

  /* ---------- Empty state ---------- */

  // What the sheet holds changes with the workbook, not with the selection: the suggestions are worked out once per
  // edit and sheet, not on each move of the selection.
  const memo = (compute) => { let key = null, value; return (sheetId) => { const k = `${sheetId}:${wb.version}`; if (k !== key) { key = k; value = compute(sheetId); } return value; }; };
  const suggestionsFor = memo((sheetId) => suggestions(wb, sheetId));

  let lastSuggestionKey = '';
  function renderEmpty() {
    if (!isOpen) return;
    const list = suggestionsFor(env.sheetId());
    const key = list.join('|');
    if (key === lastSuggestionKey && empty.childNodes.length) return;
    lastSuggestionKey = key;
    empty.replaceChildren(
      el('div.ai-empty-mark', { html: icon('sparkle', 22, 1.8), 'aria-hidden': 'true' }),
      el('p.ai-empty-title', {}, 'Ask about your data, or have it changed'),
      // Buttons in list items: a button given the listitem role stops being announced as something to press.
      el('ul.ai-suggestions', { 'aria-label': 'Suggestions' }, ...list.map((text) => el('li', {}, el('button.ai-suggestion', { type: 'button', onclick: () => submit(text) }, text)))));
  }

  /* ---------- Messages ---------- */

  const nearBottom = () => log.scrollHeight - log.scrollTop - log.clientHeight < 48;
  function scrollDown(force = false) {
    if (force || stick) log.scrollTop = log.scrollHeight;
  }
  let stick = true;
  log.addEventListener('scroll', () => { stick = nearBottom(); }, { passive: true });

  function refs(text) {
    const out = [];
    // A reply's "B2" is on the sheet the assistant is working on, whichever the user is looking at.
    const sheetId = aiEnv.sheetId();
    // How far the data reaches, which the workbook keeps: a reply that writes cells changes it at each step, and a
    // scan for where the data begins (some 15 ms on a sheet of 200,000 cells) would come with the next paint.
    const used = wb.usedRange(sheetId);
    for (const m of text.matchAll(REF_RE)) {
      let found = null;
      try { found = wb.rangeFromText(sheetId, m[0].replace(/\$/g, '')); } catch { found = null; }
      if (!found || !wb.sheet(found.sheetId) || wb.sheet(found.sheetId).kind === 'chart') continue;
      const single = !m[1] && !m[2].includes(':');
      // A lone "Q1" or "FY2024" in prose is a cell only where the sheet has data near it.
      if (single && (!used || found.range.r1 > used.r2 + 2 || found.range.c1 > used.c2 + 2)) continue;
      // So is a pair of letters ("TL:DR"): columns without a sheet named are the sheet's own only beside its data.
      if (!m[1] && !/\d/.test(m[2]) && (!used || found.range.c2 > used.c2 + 2)) continue;
      out.push({ start: m.index, end: m.index + m[0].length, target: found });
    }
    return out;
  }
  // A reference or step keeps the sheet it named; that sheet may have been deleted since, which is what is said.
  const follow = (t) => {
    if (!wb.sheet(t.sheetId)) { toast('That sheet is no longer in the workbook', { icon: 'info' }); return; }
    env.select?.(t.sheetId, t.range);
  };
  const mdOptions = { refs, onRef: follow };

  // A button that goes once pressed (a suggestion, Undo, Try again) hands the keyboard to the message box: left
  // to fall to the page, the focus would leave the panel, and with it Escape and the focus a question takes.
  function removeKeepingFocus(node) {
    const had = node.contains(document.activeElement);
    node.remove();
    if (had) input.focus({ preventScroll: true });
  }

  function userBubble(text, items = []) {
    removeKeepingFocus(empty);
    // Who said what is otherwise only where a message sits and how it is drawn: a screen reader is told in words.
    const msg = el('div.ai-msg.ai-user', {},
      el('span.visually-hidden', {}, 'You said:'),
      items.length ? sentFiles(items) : null,
      text ? el('div.ai-bubble', { dir: 'auto' }, text) : null);
    log.append(msg);
    stick = true;
    scrollDown(true);
    return msg;
  }

  /** One reply, as it arrives: text blocks and tool steps in the order they came. */
  function assistantMessage() {
    const parts = el('div.ai-parts');
    const foot = el('div.ai-foot', { hidden: true });
    const msg = el('div.ai-msg.ai-assistant', { 'aria-busy': 'true' }, el('span.visually-hidden', {}, 'The assistant said:'), parts, foot);
    const typing = el('div.ai-typing', { 'aria-hidden': 'true' }, el('span'), el('span'), el('span'));
    parts.append(typing);
    log.append(msg);
    scrollDown();
    let block = null; // { node, text }
    let queued = false;
    let fullText = '';
    // A paint draws the whole run of text again, which for a long one takes much of a frame (some 35 ms for 60,000
    // characters): drawn every frame, it would hold the page as the reply streams, the sheet and the box with it.
    // Past half a frame, the next paint waits a few times as long as the last took; a short reply paints every frame.
    let paintCost = 0;
    const paint = () => {
      queued = false;
      if (!block) return;
      const t0 = performance.now();
      // A reply the renderer cannot draw still shows, as its plain text: a paint that threw would leave the reply
      // unfinished, the panel busy and Stop doing nothing.
      try { block.node.replaceChildren(renderMarkdown(block.text, mdOptions)); } catch (e) { console.error(e); block.node.textContent = block.text; }
      paintCost = performance.now() - t0;
      scrollDown();
    };
    const queuePaint = () => {
      if (queued) return;
      queued = true;
      if (paintCost <= PAINT_BUDGET_MS) requestAnimationFrame(paint);
      else setTimeout(() => requestAnimationFrame(paint), Math.min(paintCost * 3, 500));
    };
    const steps = new Map(); // call id → row
    // Text that stops while the reply goes on is the model at work unseen (a tool call arrives only once it is
    // written whole, which for a large block of cells takes a while): the dots come back after a pause.
    let pause = null;
    let done = false;
    const quiet = () => { clearTimeout(pause); pause = null; };
    const waitAfterText = () => {
      quiet();
      pause = setTimeout(() => { pause = null; if (!done && agent.busy && !typing.isConnected) { parts.append(typing); scrollDown(); } }, TEXT_PAUSE_MS);
    };
    return {
      msg, foot,
      get fullText() { return fullText; },
      append(delta) {
        typing.remove();
        waitAfterText();
        if (!block) {
          block = { node: el('div.ai-text.md', { dir: 'auto' }), text: '' };
          parts.append(block.node);
          // Each run of text is a paragraph of its own, as on screen: the copied reply keeps them apart.
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
        if (block) { paint(); block = null; }
        let row = steps.get(step.id);
        if (!row) { row = el('div.ai-step'); steps.set(step.id, row); parts.append(row); }
        renderStep(row, step);
        if (step.status === 'done' || step.status === 'error' || step.status === 'declined' || step.status === 'skipped') {
          // The model answers again after its calls; the dots say it is working meanwhile.
          if (agent.busy) parts.append(typing);
        }
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

  const STATUS_ICONS = { running: 'spinner', waiting: 'clock', done: 'check', error: 'alert', declined: 'declined', skipped: 'minus' };
  function renderStep(row, step) {
    row.className = `ai-step ai-step-${step.status}${changesWorkbook(step.name) ? ' ai-step-change' : ''}`;
    const ic = el('span.ai-step-icon', { html: icon(STATUS_ICONS[step.status] || 'info', 14, 2), 'aria-hidden': 'true' });
    if (step.status === 'running') ic.classList.add('spin');
    const target = step.target;
    const label = target && step.status !== 'declined' && step.status !== 'skipped'
      ? el('button.ai-step-label.linkish', { type: 'button', title: `Select ${qualified(wb, target.sheetId, target.range)}`, onclick: () => follow(target) }, step.label)
      : el('span.ai-step-label', {}, step.label);
    const statusWord = { running: 'running', waiting: 'waiting for your answer', done: 'done', error: 'failed', declined: 'not allowed', skipped: 'not run' }[step.status];
    const children = [ic, label, el('span.visually-hidden', {}, `, ${statusWord}`)];
    row.replaceChildren(...children);
    if (step.status === 'running' && step.note) row.append(el('div.ai-step-note', {}, step.note));
    if (step.status === 'error' && step.error) row.append(el('div.ai-step-note', {}, step.error));
    if (step.status === 'declined') row.append(el('div.ai-step-note', {}, 'Not allowed, so not changed.'));
    if (step.status === 'waiting') row.append(approvalCard(step));
  }

  /* ---------- Approval ---------- */

  let pendingApproval = null; // { resolve, card }
  let lastCard = null;
  function approvalCard(step) {
    const allow = el('button.btn.btn-sm.btn-primary', { type: 'button', onclick: () => answer(true) }, 'Allow');
    const deny = el('button.btn.btn-sm', { type: 'button', onclick: () => answer(false) }, 'Don’t allow');
    const card = el('div.ai-approve', { role: 'group', 'aria-label': 'Allow this change?' },
      step.detail && el('p.ai-approve-detail', {}, step.detail),
      el('div.ai-approve-actions', {}, allow, deny));
    card.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); answer(false); } });
    lastCard = card;
    // The question takes the focus only from within the panel: it never pulls the keyboard off a cell being typed in,
    // nor off the message box, where the next message may be under way: a space typed there would press Allow. It is
    // announced, and Shift+Tab from the box reaches it.
    const takesFocus = () => root.contains(document.activeElement) && document.activeElement !== input;
    if (takesFocus()) requestAnimationFrame(() => { if (card.isConnected && takesFocus()) allow.focus(); });
    return card;
  }
  function askApproval(step) {
    return new Promise((resolve) => {
      pendingApproval = { resolve, card: lastCard };
      say(`The assistant wants to ${step.label.charAt(0).toLowerCase()}${step.label.slice(1)}. ${step.detail || ''} Allow or don’t allow.`);
      if (!isOpen) open({ focus: false });
      // The reply waits on the question at its end: scrolled up out of sight of it, the user would see only a reply that
      // has stopped moving.
      stick = true;
      scrollDown(true);
    });
  }
  function answer(ok) {
    const p = pendingApproval;
    pendingApproval = null;
    const hadFocus = p?.card && p.card.contains(document.activeElement);
    p?.resolve(ok);
    if (hadFocus) input.focus();
  }

  /* ---------- Attachments ---------- */

  let pending = []; // { file, name, kind, url (an image's thumbnail, once read), ready: Promise<attachment|null>, node }
  const shownUrls = new Set(); // the thumbnails of images in sent messages, let go with the chat

  /** Take files for the next message. Each is read as it comes, so Send does not wait on it; one that cannot go is said why. */
  function attach(files) {
    let over = 0; // past the limit: said once for all of them, not once a file
    const added = [];
    for (const file of files || []) {
      if (pending.length >= MAX_ATTACHMENTS) { over++; continue; }
      const problem = attachmentProblem(file, pending.length);
      if (problem) { toast(problem, { icon: 'info', duration: 4500 }); continue; }
      const kind = attachmentKind(file);
      const item = { file, kind, name: file.name || (kind === 'image' ? 'Pasted image' : 'File') };
      item.ready = new Promise((resolve, reject) => readQueue.push({ item, resolve, reject })).catch((e) => {
        if (pending.includes(item)) {
          toast(e?.message || `${item.name} could not be read`, { icon: 'alert', duration: 4500 });
          removePending(item);
        }
        return null;
      });
      pending.push(item);
      added.push(item.name);
      tray.append(trayItem(item));
    }
    // Picked in a dialog or pasted, a file shows only in the tray: a screen reader is told it is there.
    if (added.length) say(`${added.length === 1 ? added[0] : `${added.length} files`} attached`);
    if (over) toast(`Up to ${MAX_ATTACHMENTS} files can go with one message, so ${over === 1 ? '1 was' : `${over} were`} left out.`, { icon: 'info', duration: 4500 });
    readNext();
    syncTray();
  }

  // Files are read a couple at a time: a photo decodes to its full size (some 48 MB for 12 megapixels) before it is
  // fitted, and ten at once could run a phone out of memory. One taken off the tray before its turn is not read.
  const READ_AT_ONCE = 2;
  const readQueue = [];
  let reading = 0;
  function readNext() {
    while (reading < READ_AT_ONCE && readQueue.length) {
      const { item, resolve, reject } = readQueue.shift();
      if (!pending.includes(item)) { resolve(null); continue; }
      reading++;
      readAttachment(item.file).then(resolve, reject).finally(() => { reading--; readNext(); });
    }
  }

  function trayItem(item) {
    const remove = el('button.ai-tray-remove', { type: 'button', html: icon('x', 12, 2.4), 'aria-label': `Remove ${item.name}`, title: 'Remove', onclick: () => {
      const next = item.node.nextElementSibling || item.node.previousElementSibling;
      removePending(item);
      say(`${item.name} removed`);
      (next?.querySelector('.ai-tray-remove') || input).focus({ preventScroll: true });
    } });
    // Marked as being read until it is: Send waits on it.
    const spinner = el('span.ai-tray-spinner', { 'aria-hidden': 'true' }, el('span.spin', { html: icon('spinner', 14, 2.2) }));
    // An image shows as its thumbnail once read (see fitImageForVision), an icon until then.
    const preview = el('span.ai-tray-icon', { html: icon(item.kind === 'image' ? 'image' : 'fileText', 16, 1.8), 'aria-hidden': 'true' });
    item.node = el('li.ai-tray-item.reading', { title: `${item.name} · ${formatSize(item.file.size)}`, 'aria-busy': 'true' },
      preview,
      spinner,
      el('span.ai-tray-name', {}, item.name),
      remove);
    item.ready.then((read) => {
      item.node.classList.remove('reading');
      item.node.removeAttribute('aria-busy');
      spinner.remove();
      if (!read || read.kind !== 'image' || !pending.includes(item)) return;
      // Where no thumbnail could be drawn, the file itself.
      try { item.url = URL.createObjectURL(read.thumb || item.file); } catch { return; }
      preview.replaceWith(el('img.ai-tray-thumb', { src: item.url, alt: '' }));
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

  /** The files a sent message carried, above its text: thumbnails for images, names for the rest. */
  function sentFiles(items) {
    return el('ul.ai-user-files', { 'aria-label': 'Attached files' }, ...items.map((item) => {
      if (item.url) shownUrls.add(item.url);
      return el('li.ai-user-file', { title: item.name },
        item.url ? el('img.ai-user-thumb', { src: item.url, alt: item.name }) : el('span.ai-user-chip', {}, el('span', { html: icon('fileText', 14, 1.8), 'aria-hidden': 'true' }), el('span.ai-user-chip-name', {}, item.name)));
    }));
  }

  // A file pasted into the box (a screenshot, a copied image) is attached; pasted text stays the box's.
  input.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (!files.length || copiedText(e.clipboardData, files)) return;
    e.preventDefault();
    attach(files);
  });
  // Cells or text copied from Excel, Word or Numbers come with a picture of themselves, which the browser offers as a
  // file: the text is what was copied. A copied image has no text beside it, or only its <img> tag as HTML.
  function copiedText(data, files) {
    if (!files.every((f) => String(f.type).startsWith('image/'))) return false;
    const read = (type) => { try { return data.getData?.(type) || ''; } catch { return ''; } };
    if (!read('text/plain').trim()) return false;
    if ([...(data.types || [])].includes('text/rtf')) return true;
    return !!read('text/html').replace(/<(style|script|title)\b[\s\S]*?<\/\1>|<[^>]*>|&nbsp;/gi, ' ').trim();
  }

  /* ---------- Sending ---------- */

  let current = null; // the reply under way
  function setBusy(busy) {
    root.classList.toggle('busy', busy);
    sendBtn.innerHTML = busy ? icon('stop', 14, 2.2) : icon('arrowUp', 18, 2.2);
    sendBtn.setAttribute('aria-label', busy ? 'Stop' : 'Send');
    sendBtn.title = busy ? 'Stop' : 'Send (Enter)';
    sendBtn.classList.toggle('stopping', busy);
    // Send pressed as a button (or Stop) is disabled when the reply ends, the box being empty: the focus it had would
    // fall to the page, out of the panel and its keys.
    const had = document.activeElement === sendBtn;
    syncSend();
    if (had && sendBtn.disabled) input.focus({ preventScroll: true });
    // A reply under way while the panel is collapsed shows on the strip.
    rail.classList.toggle('busy', busy);
    rail.title = busy ? `Expand the assistant, working (${MOD_KEY}+J)` : `Expand the assistant (${MOD_KEY}+J)`;
    onBusy?.(busy);
  }
  // Send has nothing to send until something is written; while a reply runs it is Stop, always there to press.
  function syncSend() { sendBtn.disabled = !root.classList.contains('busy') && (sending || (!input.value.trim() && !pending.length)); }

  // `text`: a suggestion sent as it is. What the user was writing in the box stays there for them; the files waiting
  // to be sent go with it.
  let sending = false; // the message's files are still being read
  async function submit(text = null) {
    let message = String(text ?? input.value).trim();
    if ((!message && !pending.length) || agent.busy || sending) return;
    if (!P.canAI()) { toast('AI is not available here', { icon: 'info' }); return; }
    // The tray's files as read: one that could not be read was taken out of the tray, and said so, as it failed.
    let items = [];
    let files = [];
    if (pending.length) {
      const waiting = pending;
      sending = true;
      syncSend();
      let read;
      try { read = await Promise.all(waiting.map((item) => item.ready)); } finally { sending = false; }
      if (destroyed || agent.busy) { syncSend(); return; }
      items = waiting.filter((item, i) => read[i] && pending.includes(item));
      files = items.map((item) => read[waiting.indexOf(item)]);
      // Too much for one request: nothing is sent, and the tray and the text stay for the user to take some off.
      const tooLarge = attachmentsTooLarge(files);
      if (tooLarge) { toast(tooLarge, { icon: 'info', duration: 6000 }); syncSend(); return; }
      // The tray empties into the message (files added while these were read wait for the next one).
      pending = pending.filter((item) => !waiting.includes(item));
      for (const item of items) item.node?.remove();
      syncTray();
      // The message goes as the box holds it now: what was typed while the files were read is part of it.
      if (text == null) message = input.value.trim();
      if (!message && !files.length) return;
    }
    if (text == null) {
      input.value = '';
      autoGrow();
    }
    // A failed reply can be tried again only until the chat moves on: asked later, it would answer after the newer reply.
    // (A failure's New chat goes with it: the chat has moved on without one.)
    for (const button of log.querySelectorAll('.ai-retry, .ai-new-chat')) button.remove();
    userBubble(message, items);
    exchange((onEvent) => agent.send(message, onEvent, { attachments: files }));
  }

  async function exchange(start, { resume = false } = {}) {
    const reply = assistantMessage();
    current = reply;
    setBusy(true);
    say('The assistant is working…');
    const markBefore = wb.historyTop;
    const aiSteps = new Set();
    const topAtStart = new Map();
    const selectionBefore = JSON.stringify(env.selection());
    // A new message starts on the sheet the user sent it from. A reply tried again goes on where the failed one left
    // off: the model was told of the sheets its steps moved it to, not of any the user has looked at since.
    if (!resume || aiSheet == null || !wb.sheet(aiSheet)) aiSheet = env.sheetId();
    const onEvent = (e) => {
      if (destroyed || current !== reply) return;
      if (e.type === 'text') reply.append(e.text);
      else if (e.type === 'round') reply.round();
      else if (e.type === 'step') {
        // The step's own undo entry: the one on top once it is done, if it was not there when it started
        // (a step that changed nothing undoable, such as showing a sheet, must not claim an edit of the user's).
        if (e.step.status === 'running') topAtStart.set(e.step.id, wb.historyTop);
        else if (e.step.changed && e.step.status === 'done' && wb.historyTop && wb.historyTop !== topAtStart.get(e.step.id)) aiSteps.add(wb.historyTop);
        reply.step(e.step);
      }
    };
    let outcome;
    try { outcome = await start(onEvent); } catch (error) { outcome = { error, steps: [] }; }
    if (destroyed || current !== reply) return;
    current = null;
    reply.finish();
    setBusy(false);
    const changed = (outcome.steps || []).filter((s) => s.changed && s.status === 'done');
    const deliveredValue = (!outcome.empty && !!reply.fullText.trim()) || (outcome.steps || []).some(s => s.status === 'done');
    if (!outcome.error && !outcome.stopped && !outcome.cut && deliveredValue) {
      trackEvent('AI Interaction', { feature: 'assistant', changed: changed.length > 0 });
    }
    if (outcome.error) {
      const firstMessage = agent.messages.filter((m) => m.role === 'user').length <= 1;
      const message = friendlyAiError(outcome.error, { firstMessage });
      // Asked again, a request too long for the model fails again: a long chat is offered the new chat its failure
      // names, and a message too long of itself nothing, as what helps is a shorter one.
      const tooLong = tooLongForAi(outcome.error);
      const action = !tooLong
        // Only the failure goes: the reply's Undo for what it changed before it failed stays beside it.
        ? el('button.btn.btn-sm.ai-retry', { type: 'button', onclick: (e) => {
          const failure = e.currentTarget.closest('.ai-error');
          const foot = failure.parentElement;
          removeKeepingFocus(failure);
          foot.hidden = !foot.childElementCount;
          // A reply that failed before it said or did anything leaves nothing behind: kept, it was an empty message
          // in the chat, a gap on screen and a lone "The assistant said:" to a screen reader, above the reply tried again.
          if (foot.hidden && !reply.msg.querySelector('.ai-parts').childElementCount) reply.msg.remove();
          retry();
        } }, 'Try again')
        : !firstMessage ? el('button.btn.btn-sm.ai-new-chat', { type: 'button', onclick: () => newChat() }, 'New chat') : null;
      reply.foot.hidden = false;
      reply.foot.replaceChildren(el('div.ai-error', { role: 'alert' },
        el('span.ai-error-icon', { html: icon('alert', 14, 2), 'aria-hidden': 'true' }),
        el('span.ai-error-text', {}, message),
        action));
      say(`The assistant could not answer: ${message}`);
    } else {
      // A reply that ran into the length limit ends mid-sentence: said so, and how to have the rest.
      const cutNote = 'The reply reached its length limit and was cut off. Say "continue" for the rest.';
      say(outcome.stopped ? 'Stopped.' : outcome.cut ? `The assistant has answered. ${cutNote}` : 'The assistant has answered.');
      if (outcome.stopped) reply.msg.querySelector('.ai-parts').append(el('p.ai-stopped', {}, 'Stopped.'));
      else if (outcome.cut) reply.msg.querySelector('.ai-parts').append(el('p.ai-stopped', {}, cutNote));
    }
    // Closed while it worked, the panel would keep the end of the reply (and its failure) to itself.
    if (!isOpen && !outcome.stopped) {
      toast(outcome.error ? 'The assistant could not answer' : 'The assistant has answered', {
        icon: outcome.error ? 'alert' : 'sparkle', action: { label: 'Open', onClick: () => open() },
      });
    }
    renderFoot(reply, { changed, markBefore, markAfter: wb.historyTop, aiSteps, error: !!outcome.error });
    // Show what changed, unless the user has moved on to other cells meanwhile. A change on a hidden sheet cannot
    // be shown: selecting it would only have the user told, unasked, to unhide the sheet.
    const last = [...changed].reverse().find((s) => s.target && wb.sheet(s.target.sheetId) && !wb.sheet(s.target.sheetId).hidden);
    if (last && JSON.stringify(env.selection()) === selectionBefore && !ctx.grid?.editing) env.select?.(last.target.sheetId, last.target.range);
  }

  function retry() {
    if (agent.busy) return;
    exchange((onEvent) => agent.retry(onEvent), { resume: true });
  }

  function renderFoot(reply, { changed, markBefore, markAfter, aiSteps, error }) {
    const items = [];
    const text = reply.fullText;
    if (text && !error) {
      items.push(el('button.ai-foot-btn', { type: 'button', title: 'Copy the reply', 'aria-label': 'Copy the reply', html: icon('copy', 14, 2), onclick: async () => {
        try { await navigator.clipboard.writeText(text); toast('Reply copied', { icon: 'check', duration: 1500 }); } catch { toast('Could not copy', { icon: 'info' }); }
      } }));
    }
    if (changed.length) {
      const counted = `${changed.length} change${changed.length === 1 ? '' : 's'}`;
      const summary = el('span.ai-foot-summary', {}, `${counted} made`);
      const undoBtn = el('button.btn.btn-sm.ai-undo', { type: 'button', onclick: () => undoTurn() }, el('span', { html: icon('undo', 14, 2), 'aria-hidden': 'true' }), 'Undo');
      // Only the steps this reply made, all still on top of the history: anything else and Undo would take the user's own edits too.
      const intact = () => {
        const since = wb.historySince(markBefore);
        return wb.historyTop === markAfter && !!since?.length && since.every((entry) => aiSteps.has(entry));
      };
      const undoTurn = () => {
        if (!intact()) {
          toast('The sheet has changed since. Use Undo in the Edit menu to go back step by step', { icon: 'info', duration: 4000 });
          refreshUndo();
          return;
        }
        // Undo waits for a cell being typed in, as it does from the Edit menu: said so, not reported as done.
        if (ctx.grid?.editing) { toast('Finish the cell you are typing in first, then Undo', { icon: 'info', duration: 3000 }); return; }
        // The editor's undo hands the keyboard to the sheet; pressed here, it stays in the panel.
        const had = undoBtn.contains(document.activeElement);
        ctx.run('undoSteps', wb.historySince(markBefore).length);
        refreshUndo();
        if (had) (undoBtn.hidden || undoBtn.disabled ? input : undoBtn).focus({ preventScroll: true });
      };
      // What the reply's changes are now, however the history moved (this Undo, or undo and redo from the Edit menu):
      // there to take back; taken back (the history back where the reply began, its steps to redo), which they stay
      // through the edits that follow until they are all redone; or neither.
      let undone = false;
      const refreshUndo = () => {
        const ok = intact();
        undone = !ok && (undone || (wb.historyTop === markBefore && wb.canRedo()));
        summary.textContent = `${counted} ${undone ? 'undone' : 'made'}`;
        summary.classList.toggle('ai-foot-undone', undone);
        undoBtn.hidden = undone;
        undoBtn.disabled = !ok;
        undoBtn.title = ok ? 'Undo the changes in this reply' : 'The sheet has changed since this reply';
      };
      reply.refreshUndo = refreshUndo;
      undos.add(refreshUndo);
      refreshUndo();
      items.unshift(summary, undoBtn);
    }
    if (!items.length) return;
    reply.foot.hidden = false;
    reply.foot.prepend(...items);
  }
  const undos = new Set();
  const onWbChange = (e) => { if (e.detail?.type === 'history' || e.detail?.type === 'load') for (const fn of undos) fn(); };
  wb.addEventListener('change', onWbChange);

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
  // The box is as tall as its lines, which a change of width rewraps. Hidden, it has no lines to measure.
  function fitInput() {
    if (root.hidden) return;
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 180)}px`;
  }
  input.addEventListener('input', autoGrow);
  input.addEventListener('keydown', (e) => {
    if (isComposing(e)) return;
    if (e.key === 'Enter' && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      if (!agent.busy) submit();
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      if (agent.busy) stop();
      else ctx.grid?.focus?.();
    }
  });
  root.addEventListener('keydown', (e) => {
    // Escape from anywhere else in the panel goes back to the sheet; the panel stays open.
    if (e.key === 'Escape' && !e.defaultPrevented && e.target !== input && !e.target.closest?.('.menu')) { e.preventDefault(); ctx.grid?.focus?.(); }
  });

  /* ---------- Open and close ---------- */

  // Whether the assistant is offered (Options ▸ Privacy ▸ Offer AI features): while it is not, neither the panel nor
  // its strip shows, and nothing opens it.
  let available = true;
  let reopen = false; // open when AI features were turned off: it opens again when they are turned back on
  function setAvailable(on) {
    if (!!on === available) return;
    available = !!on;
    if (!available) {
      reopen = isOpen;
      if (agent.busy) stop();
      if (isOpen) close({ focusGrid: root.contains(document.activeElement) });
    }
    root.hidden = !available || !isOpen;
    rail.hidden = !available || isOpen;
    if (available && reopen) { reopen = false; open({ focus: false }); }
  }

  function open({ focus = true, prompt = null } = {}) {
    if (!available) return;
    if (!isOpen) {
      isOpen = true;
      root.hidden = false;
      rail.hidden = true;
      // A window resized while it was closed has rewrapped what waits in the box.
      if (input.value) fitInput();
      // What arrived while it was closed (a reply, a question to allow a change) could not be scrolled to then.
      if (stick) scrollDown(true);
      setOpenSetting(settings, true);
      saveAiSettings(settings);
      refreshChip();
      if (!log.querySelector('.ai-msg')) renderEmpty();
      onToggle?.(true);
    }
    if (prompt) { input.value = prompt; autoGrow(); }
    if (focus) requestAnimationFrame(() => { input.focus(); if (prompt) input.setSelectionRange(input.value.length, input.value.length); });
  }

  function close({ focusGrid = true } = {}) {
    if (!isOpen) return;
    // A question waiting on the user goes unanswered with the panel shut: the reply stops there, its change not made.
    // Declined alone, the reply would go on to its next change and open the panel again to ask about that.
    if (pendingApproval) stop();
    isOpen = false;
    root.hidden = true;
    rail.hidden = !available;
    // Put away because AI features were turned off, it is left as the user had it, to come back that way.
    if (available) { setOpenSetting(settings, false); saveAiSettings(settings); }
    onToggle?.(false);
    if (focusGrid) ctx.grid?.focus?.();
  }

  return {
    el: root,
    /** The strip shown in the panel's place while it is collapsed. */
    rail,
    /** Take files for the next message (a drop on the panel). */
    attach,
    /** Mark the panel, or its strip, as where a file being dragged would go. */
    setDropTarget(on) { root.classList.toggle('ai-drop', !!on); rail.classList.toggle('ai-drop', !!on); },
    get isOpen() { return isOpen; },
    /** Open as the sheet over the grid a phone's width makes it (see aipanel.css), where nothing under it shows. */
    get coversGrid() { try { return isOpen && !!globalThis.matchMedia?.('(max-width: 640px)').matches; } catch { return false; } },
    get busy() { return agent.busy; },
    open,
    close,
    setAvailable,
    toggle(force) { if (force ?? !isOpen) open(); else close(); },
    focus() { input.focus(); },
    /** The transcript as the model has it (for tests). */
    get messages() { return agent.messages; },
    /** What the user sent, message by message (the snapshots left out). */
    get sent() { return agent.messages.filter((m) => m.role === 'user').map((m) => userText(m.content)); },
    destroy() {
      destroyed = true;
      agent.reset();
      unsubscribe();
      wb.removeEventListener('change', onWbChange);
      globalThis.removeEventListener?.('resize', onResize);
      root.remove();
      rail.remove();
      for (const item of pending) if (item.url) URL.revokeObjectURL(item.url);
      for (const url of shownUrls) URL.revokeObjectURL(url);
    },
  };
}
