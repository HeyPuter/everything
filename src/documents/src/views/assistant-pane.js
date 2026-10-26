/**
 * The Assistant pane: a conversation with Puter's AI beside the pages, about
 * and for this document. Above the box the person chooses what goes with a
 * message, the selected text or the whole document, and the chip says how
 * much that is; nothing else is sent. Replies that are text for the document
 * show what they would insert or replace, and land only when the person
 * applies them, as one change Undo takes back (the reply offers Undo too).
 *
 * The pane, its button on the Home tab and the floating button beside the
 * pages are offered only where Puter's AI is available.
 */
import { el, isComposing, MOD_KEY, shortcutCode } from '../ui/dom.js';
import { toast } from '../ui/toast.js';
import * as P from '../lib/puter.js';
import { aiActionById, askAi, answerParagraphs } from '../lib/ai.js';
import { assistantPrompt, readReply, assistantError, SUGGESTIONS, MAX_ASSISTANT_CHARS } from '../lib/assistant.js';
import { sidePane, hint } from './review-ui.js';
import { commandIconEl } from '../ui/ribbon.js';

const words = text => (String(text).trim().match(/\S+/gu) || []).length;
const plural = (n, one, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

export function createAssistantPane({ editor, pkg, error, available = () => P.canUseAi(), chat = prompt => P.aiChat(prompt) }) {
  let scope = 'selection', history = [], busy = false, stopped = null;
  const pane = sidePane({ title: 'Assistant', label: 'Assistant pane', className: 'as-pane', onOpen: () => { renderContext(); renderEmpty(); fab.setAttribute('aria-expanded', 'true'); titleButton.setAttribute('aria-pressed', 'true'); }, onClose: () => { fab.setAttribute('aria-expanded', 'false'); titleButton.setAttribute('aria-pressed', 'false'); editor()?.focus(); } });
  pane.heading.prepend(el('span.as-mark', { 'aria-hidden': 'true' }, commandIconEl('assistant', 16)));
  const newChat = el('button.btn.btn-ghost.btn-sm.as-new', { type: 'button', onclick: () => { stopped = null; busy = false; send.disabled = false; history = []; log.replaceChildren(); renderEmpty(); input.focus(); } }, 'New chat');
  pane.heading.after(newChat);

  const log = el('div.as-log', { role: 'log', 'aria-label': 'Conversation with the assistant', tabIndex: -1 });
  const empty = el('div.as-empty');
  const scopeSelection = el('button.as-scope-option', { type: 'button', role: 'radio', onclick: () => setScope('selection') }, 'Selection');
  const scopeDocument = el('button.as-scope-option', { type: 'button', role: 'radio', onclick: () => setScope('document') }, 'Whole document');
  const scopeGroup = el('div.as-scope', { role: 'radiogroup', 'aria-label': 'Send with your message' }, scopeSelection, scopeDocument);
  const context = el('p.as-context', { 'aria-live': 'polite' });
  const input = el('textarea.input.as-input', { rows: 3, placeholder: 'Ask about this document, or ask for a draft or a rewrite…', 'aria-label': 'Message the assistant', enterKeyHint: 'send' });
  const send = el('button.btn.btn-primary.as-send', { type: 'submit', 'aria-label': 'Send', title: 'Send (Enter)' }, 'Send');
  const form = el('form.as-form', { onsubmit: e => { e.preventDefault(); submit(input.value); } }, scopeGroup, context, el('div.as-box', {}, input, send), el('p.as-disclaimer', {}, 'Only the text shown above is sent to Puter’s AI. Replies can be wrong: check them before you use them.'));
  input.addEventListener('keydown', e => {
    if (isComposing(e)) return;
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(input.value); }
  });
  pane.body.append(log, form);

  // A small button at the edge of the pages opens the pane (where Puter's AI is available).
  // In the title bar beside Comments, as the other apps' assistants sit in their top bars.
  const titleButton = el('button.ed-pill.as-title-button', { type: 'button', 'aria-label': 'Assistant', title: `Assistant (${MOD_KEY}+Shift+I)`, 'aria-pressed': 'false', hidden: true, onclick: () => toggle() }, commandIconEl('assistant', 16));
  titleButton.addEventListener('mousedown', e => e.preventDefault());
  const fab = el('button.as-fab', { type: 'button', 'aria-label': 'Assistant', title: `Assistant (${MOD_KEY}+Shift+I)`, 'aria-expanded': 'false', hidden: true, onclick: () => toggle() }, commandIconEl('assistant', 20));
  fab.addEventListener('mousedown', e => e.preventDefault());
  // Mod+Shift+I opens and closes the pane from anywhere in the editor.
  const keys = new AbortController();
  window.addEventListener('keydown', e => {
    if (e.defaultPrevented || isComposing(e) || !(e.ctrlKey || e.metaKey) || !e.shiftKey || e.altKey || shortcutCode(e) !== 'KeyI' || !editor()) return;
    e.preventDefault(); toggle();
  }, { signal: keys.signal });

  /* ---- What goes with a message ---- */
  function selection() {
    const engine = editor(); if (!engine) return null;
    if (engine.session.path !== null) return null;
    const [start, end] = engine.model.range;
    if (start === end) return null;
    return { start, end, text: engine.model.text.slice(start, end) };
  }
  function payload() {
    const engine = editor(); if (!engine) return null;
    if (scope === 'selection') { const s = selection(); return s ? { scope, ...s } : null; }
    return { scope, text: engine.session.body.text };
  }
  function setScope(next) { scope = next; renderContext(); renderEmpty(); input.focus(); }
  function renderContext() {
    const s = selection();
    if (scope === 'selection' && !s) scope = 'document';
    scopeSelection.setAttribute('aria-checked', String(scope === 'selection'));
    scopeDocument.setAttribute('aria-checked', String(scope === 'document'));
    scopeSelection.disabled = !s;
    const p = payload();
    const count = p ? words(p.text) : 0;
    context.textContent = !p ? 'Nothing selected.' : scope === 'selection' ? `Sends the ${plural(count, 'word')} you selected.` : `Sends the whole document (${plural(count, 'word')}).`;
    context.classList.toggle('is-over', !!p && p.text.length > MAX_ASSISTANT_CHARS);
  }
  function renderEmpty() {
    if (log.querySelector('.as-message')) { empty.remove(); return; }
    const list = scope === 'selection' && selection() ? SUGGESTIONS.selection : SUGGESTIONS.document;
    empty.replaceChildren(el('p.as-empty-title', {}, 'How can I help with this document?'),
      el('div.as-suggestions', {}, ...list.map(s => el('button.as-suggestion', { type: 'button', onclick: () => (s.id ? runAction(s.id, s.label) : submit(s.ask)) }, s.label))),
      hint('The assistant sees only the selection or the whole document, as you choose below.'));
    log.append(empty);
  }

  /* ---- Messages ---- */
  const message = (who, ...children) => { empty.remove(); const node = el(`div.as-message.is-${who}`, {}, ...children); log.append(node); node.scrollIntoView?.({ block: 'nearest' }); return node; };

  async function submit(text) {
    const request = String(text || '').trim();
    if (!request || busy) return;
    const p = payload();
    if (!p) { toast('Select some text, or choose Whole document.', { icon: 'info' }); return; }
    if (p.text.length > MAX_ASSISTANT_CHARS) { toast('That is more text than the assistant takes at once. Select a shorter passage.', { icon: 'alert' }); return; }
    input.value = '';
    message('me', el('p', {}, request), el('p.as-sent', {}, scope === 'selection' ? `With ${plural(words(p.text), 'selected word')}` : 'With the whole document'));
    await reply(() => chat(assistantPrompt({ request, text: p.text, scope: p.scope, history })).then(readReply), p, request);
  }

  /** One of the writing assistant's actions on the selection (Improve, Shorten, …). */
  async function runAction(id, label) {
    const action = aiActionById(id); const p = payload();
    if (!action || !p || busy) return;
    message('me', el('p', {}, label), el('p.as-sent', {}, scope === 'selection' ? `With ${plural(words(p.text), 'selected word')}` : 'With the whole document'));
    await reply(async () => { const text = await askAi(action, p.text, { chat }); return { kind: 'text', text, paragraphs: answerParagraphs(text), mode: action.mode }; }, p, label);
  }

  async function reply(ask, p, request) {
    busy = true; send.disabled = true;
    const token = stopped = {};
    const waiting = message('assistant', el('p.as-thinking', {}, 'Thinking…'));
    try {
      const answer = await ask();
      if (stopped !== token) return;
      history.push({ request, reply: answer.text });
      waiting.replaceChildren(...answerView(answer, p));
    } catch (e) {
      if (stopped !== token) return;
      waiting.classList.add('is-error');
      waiting.replaceChildren(el('p', {}, e?.message && !/AI service|could not answer/i.test(e.message) && e.message.length < 140 ? e.message : assistantError(e)));
    } finally {
      // A reply that New chat left behind no longer holds the conversation up.
      if (stopped === token) { busy = false; send.disabled = false; }
    }
  }

  function answerView(answer, p) {
    const body = el('div.as-answer', {}, ...answer.paragraphs.map(t => el('p', {}, t)));
    if (answer.kind !== 'text') return [body, actions(answer, p, false)];
    const replacing = p.scope === 'selection' && answer.mode !== 'append';
    const original = replacing ? el('p.as-replaces', {}, `Replaces “${p.text.length > 140 ? `${p.text.slice(0, 140).trim()}…` : p.text}”`) : null;
    return [el('p.as-kind', {}, replacing ? 'Suggested replacement' : 'Suggested text'), body, original, actions(answer, p, true)];
  }

  function actions(answer, p, insertable) {
    const row = el('div.as-actions');
    const copy = el('button.btn.btn-ghost.btn-sm', { type: 'button', onclick: () => navigator.clipboard?.writeText(answer.text).then(() => toast('Copied')).catch(() => error(new Error('The clipboard is not available.'))) }, 'Copy');
    const canEdit = () => { const engine = editor(); return !!engine && !pkg()?.readOnly && !engine.viewOnly; };
    const apply = (label, how) => el(`button.btn.btn-sm${how === 'replace' ? '.btn-primary' : '.btn-outline'}`, { type: 'button', disabled: !canEdit(), onclick: e => insert(answer, p, how, row, e.currentTarget) }, label);
    if (insertable) {
      if (p.scope === 'selection' && p.start !== undefined && answer.mode !== 'append') row.append(apply('Replace Selection', 'replace'), apply('Insert Below', 'below'));
      else if (p.scope === 'selection' && p.start !== undefined) row.append(apply('Insert After Selection', 'after'));
      else row.append(apply('Insert at Cursor', 'cursor'));
    } else row.append(apply('Insert at Cursor', 'cursor'));
    row.append(copy);
    return row;
  }

  /** Apply a reply as one undoable change, where the person said. */
  function insert(answer, p, how, row, button) {
    const engine = editor(); if (!engine) return;
    engine.finishComposition();
    if (engine.session.path !== null) engine.editStory(null);
    const model = engine.model;
    if (p.start !== undefined && (how === 'replace' || how === 'below' || how === 'after') && model.text.slice(p.start, p.end) !== p.text) {
      error(new Error('The selected text changed since you asked. Select it again and ask once more.')); return;
    }
    const text = answer.paragraphs.join('\n');
    const ok = engine.execute(() => {
      const m = engine.model;
      if (how === 'replace') m.select(p.start, p.end);
      else if (how === 'below' || how === 'after') {
        // After the selection's last paragraph, as new paragraphs.
        const end = how === 'after' ? p.end : (() => { const at = m.text.indexOf('\n', p.end); return at < 0 ? m.text.length : at; })();
        m.select(end, end);
        return m.replace(how === 'after' ? ` ${text}` : `\n${text}`);
      }
      return m.replace(text);
    });
    if (!ok) return;
    engine.focus();
    button.disabled = true;
    const undo = el('button.btn.btn-ghost.btn-sm', { type: 'button', onclick: () => { editor()?.undo(); undo.disabled = true; applied.textContent = 'Undone'; } }, 'Undo');
    const applied = el('span.as-applied', { role: 'status' }, how === 'replace' ? 'Replaced' : 'Inserted');
    row.replaceChildren(applied, undo);
  }

  function toggle() { if (!available()) return; pane.toggle(); if (pane.isOpen) queueMicrotask(() => input.focus()); }

  return {
    pane, fab, titleButton,
    get available() { return available(); },
    open() { if (!available()) return; pane.open(); queueMicrotask(() => input.focus()); },
    toggle,
    /** The editor's selection moved: what goes with a message follows it. */
    refresh() {
      fab.hidden = titleButton.hidden = !available() || !editor();
      if (pane.isOpen && !busy) { renderContext(); if (!log.querySelector('.as-message')) renderEmpty(); }
    },
    commands: {
      assistant: () => toggle(),
      assistantAvailable: () => available(),
    },
    extendMenu(id) {
      if (!['tools', 'view'].includes(id) || !available()) return [];
      return [{ separator: true }, { label: 'Assistant', icon: 'assistant', shortcut: `${MOD_KEY}+Shift+I`, checked: id === 'view' ? pane.isOpen : undefined, disabled: !editor(), onSelect: () => toggle() }];
    },
    destroy() { stopped = null; keys.abort(); pane.destroy(); },
  };
}
