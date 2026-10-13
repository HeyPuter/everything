/**
 * Edit assistant: a docked chat panel where you describe an edit in plain
 * words ("trim the first 2 seconds", "make the title bigger") and Puter AI
 * performs it with the editor's own tools. Each request is one undo step,
 * with an Undo button in the reply. Opened from a pill at the bottom right
 * of the timeline, the Edit menu or Mod+K; on phones it opens as a sheet.
 */
import { h, announce } from '../lib/dom.js';
import { shortcutLabel } from '../lib/platform.js';
import { icon } from '../lib/icons.js';
import * as T from '../model/timeline.js';
import { aiAvailable } from '../media/tts.js';
import { errorMessage } from '../media/transcribe.js';
import { askForEdits, assistState, stepLabel, REQUEST_MAX } from '../media/edit-assistant.js';
import { createAssistantRunner } from './assistant-actions.js';
import { createSheet } from './sheet.js';
import { emptyState } from './panels/common.js';
import '../styles/assistant.css';

/**
 * Up to five requests that fit the project and selection right now.
 * state is assistState(store).
 */
export function suggestionsFor(state) {
  const p = state.project;
  const all = T.allClips(p);
  const sel = state.selection.map((id) => T.findClip(p, id)?.clip).filter(Boolean);
  const main = T.mainTrack(p)?.clips || [];
  const hasSound = all.some((c) => (c.type === 'video' && p.assets?.[c.assetId]?.hasAudio !== false) || c.type === 'audio');
  const texts = all.filter((c) => c.type === 'text' && !c.caption);
  const captions = all.some((c) => c.type === 'text' && c.caption);
  const visual = all.some((c) => c.type === 'video' || c.type === 'image');
  const out = [];
  if (!all.length) return ['Add a title that says Hello', 'Change the frame to 9:16', 'Add a marker at 5 seconds'];
  if (sel.length === 1 && (sel[0].type === 'video' || sel[0].type === 'audio')) out.push('Speed up the selected clip 2x');
  if (sel.length && sel.every((c) => c.type === 'text')) out.push('Make the selected text bigger', 'Make it yellow with a black outline');
  else if (texts.length) out.push('Make the title bigger');
  if (hasSound) out.push(captions ? 'Make the captions bigger' : 'Add captions', 'Remove silences');
  out.push('Trim the first 2 seconds');
  if (visual) out.push('Apply a warm look to all clips');
  out.push('Add a fade out at the end');
  if (main.length > 1) out.push('Add a dissolve between all clips');
  if (!texts.length) out.push('Add a title at the start');
  return [...new Set(out)].slice(0, 5);
}

/**
 * createEditAssistant(ctx, { chat, deps })
 * chat(messages, options) replaces puter.ai.chat (tests); deps go to the
 * runner (captions and silence analysis stand-ins).
 * Returns { el, launcher, open(), close(), toggle(), send(text), isOpen, dispose() }.
 */
export function createEditAssistant(ctx, { chat = null, deps } = {}) {
  const { store } = ctx;
  const runner = createAssistantRunner(ctx, deps);
  // Development builds take a stand-in chat from globalThis.__vsAssistantChat for browser checks.
  const devChat = () => (import.meta.env.DEV && typeof globalThis.__vsAssistantChat === 'function' ? globalThis.__vsAssistantChat : null);
  const chatFn = () => chat || ctx.assistantChat || devChat() || ((m, o) => (o ? puter.ai.chat(m, o) : puter.ai.chat(m)));
  const available = () => Boolean(chat || ctx.assistantChat || devChat()) || aiAvailable(ctx);

  let open = false;
  let busy = null; // AbortController while a request runs
  let convo = []; // { role, content } sent with follow-ups
  const undoButtons = []; // { btn, entry, msg }

  // ---- Pieces --------------------------------------------------------------
  const log = h('div.assist-log', { role: 'log', 'aria-live': 'polite', 'aria-label': 'Conversation' });
  const chips = h('div.assist-chips', { role: 'group', 'aria-label': 'Suggestions' });
  const input = h('textarea.input.assist-input', { rows: 1, maxlength: REQUEST_MAX, placeholder: 'Describe an edit...', 'aria-label': 'Describe an edit' });
  const sendBtn = h('button.icon-btn.assist-send', { type: 'button', 'aria-label': 'Send', 'data-tip': 'Send (Enter)' }, icon('send', 16));
  const form = h('div.assist-form', input, sendBtn);
  const signedOut = h('div.assist-signin', { hidden: true });
  const inner = h('div.assist-inner', log, signedOut, chips, form);

  const resetBtn = h('button.icon-btn.small', { type: 'button', 'aria-label': 'New conversation', 'data-tip': 'New conversation' }, icon('refresh', 14));
  const closeBtn = h('button.icon-btn.small', { type: 'button', 'aria-label': 'Close edit assistant', 'data-tip': 'Close' }, icon('close', 14));
  const el = h('aside.assist-panel', { hidden: true, id: 'edit-assistant', 'aria-label': 'Edit assistant' },
    h('div.history-head.assist-head', icon('magic', 14), h('span', 'Edit assistant'), h('span.spacer'), resetBtn, closeBtn),
    inner);
  const launcher = h('button.assist-pill', { type: 'button', 'aria-expanded': 'false', 'aria-controls': 'edit-assistant', 'data-tip': `Edit assistant (${shortcutLabel(ctx.commands?.keyFor?.('assistant') || 'Mod+K')})` },
    icon('magic', 15), h('span.assist-pill-label', 'Edit assistant'));
  const sheet = createSheet({ title: 'Edit assistant', host: ctx.editor?.el || document.body, className: 'assist-sheet', onClose: () => sheetClosed() });

  launcher.addEventListener('click', () => toggle());
  closeBtn.addEventListener('click', () => close());
  resetBtn.addEventListener('click', () => reset());
  sendBtn.addEventListener('click', () => (busy ? cancel() : send(input.value)));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      if (!busy) send(input.value);
    }
  });
  input.addEventListener('input', fit);
  // Keys typed in the panel stay here (Delete on a chip must not delete clips); shortcuts with a modifier still work.
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (busy) cancel();
      else close();
      return;
    }
    if (!e.metaKey && !e.ctrlKey) e.stopPropagation();
  });

  function fit() {
    input.style.height = 'auto';
    input.style.height = `${Math.min(140, input.scrollHeight + 2)}px`;
  }

  // ---- Rendering -------------------------------------------------------------
  function renderChips() {
    const list = available() && !busy ? suggestionsFor(assistState(store)) : [];
    chips.hidden = !list.length;
    chips.replaceChildren(...list.map((text) => {
      const b = h('button.chip.assist-chip', { type: 'button' }, text);
      b.addEventListener('click', () => send(text));
      return b;
    }));
  }

  function renderAvailability() {
    const ok = available();
    signedOut.hidden = ok;
    log.hidden = !ok;
    form.hidden = !ok;
    if (!ok && !signedOut.childElementCount) {
      const btn = ctx.account?.onSignIn ? h('button.btn.primary', { type: 'button', onclick: () => ctx.account.onSignIn() }, icon('cloud', 16), 'Sign in to Puter') : null;
      signedOut.append(emptyState('user', 'Sign in to use the edit assistant', 'The edit assistant uses Puter AI to understand what you ask for, so it needs a Puter account.', btn));
    }
    if (ok && !log.childElementCount) intro();
    renderChips();
  }

  function intro() {
    log.append(h('div.assist-intro',
      h('p.assist-intro-title', 'What should change?'),
      h('p', 'Describe an edit in your own words, like "cut the first 3 seconds" or "make the title red". Each request is one step you can undo.'),
    ));
  }

  const scrollDown = () => {
    log.scrollTop = log.scrollHeight;
  };

  function userMsg(text) {
    log.querySelector('.assist-intro')?.remove();
    log.append(h('div.assist-msg.user', h('p', text)));
    scrollDown();
  }

  function thinkingMsg() {
    const line = h('span', 'Thinking...');
    const stop = h('button.btn.small.ghost', { type: 'button' }, 'Cancel');
    stop.addEventListener('click', () => cancel());
    const m = h('div.assist-msg.bot.thinking', { 'aria-busy': 'true' }, h('span.spinner.small', { 'aria-hidden': 'true' }), line, stop);
    log.append(m);
    scrollDown();
    return { set: (text) => (line.textContent = text), remove: () => m.remove() };
  }

  function botMsg({ text = '', summary = null, entry = null, kind = '' }) {
    const body = [];
    if (text) body.push(h('p', text));
    if (summary?.lines.length) {
      body.push(h('ul.assist-steps', summary.lines.map((l) => h(`li.${l.ok ? 'ok' : 'skip'}`, icon(l.ok ? 'check' : 'info', 13), h('span', l.text)))));
    }
    const m = h(`div.assist-msg.bot${kind ? `.${kind}` : ''}`, body);
    if (entry) {
      const btn = h('button.btn.small.assist-undo', { type: 'button' }, icon('undo', 14), 'Undo');
      btn.addEventListener('click', () => {
        if (!runner.undo(entry)) return;
        btn.replaceChildren(icon('undo', 14), 'Undone');
        btn.disabled = true;
        btn.dataset.undone = '';
        // The model learns the edit is gone, so "do it again but red" works.
        const last = convo.findLast((x) => x.role === 'assistant' && x.entry === entry);
        if (last) last.content += ' (The user then undid this edit.)';
        announce('Assistant edit undone');
        syncUndo();
      });
      undoButtons.push({ btn, entry });
      m.append(h('div.assist-actions', btn));
    }
    log.append(m);
    scrollDown();
    syncUndo();
    return m;
  }

  /** Undo stays available only while the request's step is the latest. */
  function syncUndo() {
    for (const u of undoButtons) {
      if (u.btn.dataset.undone !== undefined) continue;
      const ok = runner.canUndo(u.entry);
      u.btn.disabled = !ok;
      u.btn.title = ok ? '' : 'Later edits came after this one. Use Undo in the Edit menu or the history panel.';
    }
  }

  // ---- Requests ---------------------------------------------------------------
  async function send(raw) {
    const text = String(raw || '').trim().slice(0, REQUEST_MAX);
    if (!text || busy) return;
    if (!available()) {
      renderAvailability();
      return;
    }
    if (!open) show();
    input.value = '';
    fit();
    userMsg(text);
    const ac = new AbortController();
    busy = ac;
    setBusy(true);
    const thinking = thinkingMsg();
    try {
      const { calls, text: reply } = await askForEdits({ request: text, state: assistState(store), history: convo.map(({ role, content }) => ({ role, content })), chat: chatFn(), signal: ac.signal });
      if (!calls.length) {
        thinking.remove();
        const answer = reply || "I couldn't turn that into an edit. Try naming what to change and how, for example \"make the first clip 2x faster\".";
        botMsg({ text: answer });
        convo.push({ role: 'user', content: text }, { role: 'assistant', content: answer });
        announce(answer);
        return;
      }
      thinking.set('Editing...');
      ctx.player?.pause?.();
      const { summary, entry } = await runner.run(calls, { label: stepLabel(text), signal: ac.signal, onProgress: (t) => thinking.set(t) });
      thinking.remove();
      const head = summary.done ? reply : reply || 'Nothing was changed.';
      botMsg({ text: head, summary, entry });
      convo.push({ role: 'user', content: text }, { role: 'assistant', content: [reply, summary.note].filter(Boolean).join('\n'), entry });
      announce(summary.done ? `Done. ${summary.lines.filter((l) => l.ok).map((l) => l.text).join('. ')}` : 'Nothing was changed');
    } catch (err) {
      thinking.remove();
      if (err?.name === 'AbortError') {
        botMsg({ text: 'Stopped.', kind: 'muted' });
        announce('Stopped');
      } else {
        console.error(err);
        botMsg({ text: errorMessage(err, "The assistant couldn't be reached. Check your connection and try again."), kind: 'error' });
      }
    } finally {
      busy = null;
      setBusy(false);
      // Keep the conversation short: the model only needs the recent part.
      if (convo.length > 40) convo = convo.slice(-40);
    }
  }

  function setBusy(on) {
    sendBtn.replaceChildren(icon(on ? 'stop' : 'send', 16));
    sendBtn.setAttribute('aria-label', on ? 'Stop' : 'Send');
    sendBtn.dataset.tip = on ? 'Stop (Esc)' : 'Send (Enter)';
    el.classList.toggle('busy', on);
    sheet.panel.classList.toggle('busy', on);
    renderChips();
  }

  function cancel() {
    busy?.abort();
  }

  function reset() {
    cancel();
    convo = [];
    undoButtons.length = 0;
    log.replaceChildren();
    renderAvailability();
    input.focus();
    announce('New conversation');
  }

  // ---- Open and close -----------------------------------------------------------
  const phone = () => ctx.mobile?.mode === 'phone';

  function show() {
    if (open) return;
    open = true;
    renderAvailability();
    launcher.setAttribute('aria-expanded', 'true');
    if (phone()) {
      sheet.setContent(inner);
      sheet.open(launcher);
    } else {
      if (inner.parentNode !== el) el.append(inner);
      el.hidden = false;
      launcher.hidden = true;
    }
    (available() ? input : signedOut.querySelector('button') || closeBtn).focus({ preventScroll: true });
    scrollDown();
  }

  function close() {
    if (!open) return;
    open = false;
    launcher.setAttribute('aria-expanded', 'false');
    if (sheet.isOpen) sheet.close();
    const had = el.contains(document.activeElement);
    el.hidden = true;
    launcher.hidden = false;
    if (had) launcher.focus({ preventScroll: true });
  }

  function sheetClosed() {
    if (!open) return;
    open = false;
    launcher.setAttribute('aria-expanded', 'false');
  }

  function toggle(on = !open) {
    if (on) show();
    else close();
  }

  const offs = [
    store.on('select', () => open && renderChips()),
    store.on('change', () => {
      if (!open) return;
      syncUndo();
      if (!busy) renderChips();
    }),
    store.on('history', syncUndo),
  ];

  return {
    el,
    launcher,
    sheet,
    open: show,
    close,
    toggle,
    send,
    cancel,
    get isOpen() {
      return open;
    },
    get busy() {
      return Boolean(busy);
    },
    dispose() {
      cancel();
      offs.forEach((f) => f?.());
      sheet.dispose();
      el.remove();
      launcher.remove();
    },
  };
}
