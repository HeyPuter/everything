/**
 * The SmartArt Text Pane (SmartArt Design ▸ Text Pane): the selected diagram's outline as a bulleted list to
 * type into. Each line is an item; Enter starts a new one, Tab and Shift+Tab demote and promote it, Alt+Shift
 * with the up or down arrow moves it, Backspace at the start of a line joins it to the line before, and the
 * arrow keys go from line to line. The line the cursor is in is the shape selected in the diagram. Typing
 * into one line is one undo step.
 */
import { el, isComposing } from './dom.js';
import { icon } from './icons.js';
import { activeSmartArt } from './smartart.js';
import { layoutById, smartArtTree, splitSmartArtItem, mergeSmartArtItem, removeSmartArtItem, setSmartArtItemText,
  promoteSmartArtItem, demoteSmartArtItem, moveSmartArtItem, addSmartArtItem, smartArtItemsFromText, SMARTART_MAX_ITEMS } from '../core/smartart.js';

export function createSmartArtPane(ctx) {
  const { wb } = ctx;
  let shownId = null, lastKey = null, pendingFocus = null;
  const title = el('span.selpane-title', {}, 'Text Pane');
  const close = el('button.icon-btn', { type: 'button', 'aria-label': 'Close Text Pane', html: icon('x', 16), onclick: () => api.hide() });
  const tool = (label, glyph, action, extra = {}) => el('button.btn.btn-ghost.selpane-tool', { type: 'button', title: `${label}${extra.keys ? ` (${extra.keys})` : ''}`, 'aria-label': label,
    onmousedown: (e) => e.preventDefault(), // the cursor stays in the line it acts on
    onclick: () => act(action) }, el('span', { html: icon(glyph, 16) }));
  const tools = el('div.selpane-tools.sa-pane-tools', { role: 'toolbar', 'aria-label': 'Outline' },
    tool('Add item after', 'addShape', 'add'), tool('Promote', 'indentLess', 'promote', { keys: 'Shift+Tab' }), tool('Demote', 'indentMore', 'demote', { keys: 'Tab' }),
    tool('Move up', 'arrowUp', 'moveUp', { keys: 'Alt+Shift+Up' }), tool('Move down', 'arrowDown', 'moveDown', { keys: 'Alt+Shift+Down' }));
  const list = el('div.sa-pane-list', { role: 'list', 'aria-label': 'Diagram text' });
  const note = el('p.sa-pane-note', { hidden: true, role: 'status' });
  const empty = el('p.selpane-empty', {}, 'Select a SmartArt graphic on the sheet to type its text here.');
  const layoutName = el('strong.sa-pane-layout');
  const layoutText = el('p.sa-pane-desc');
  const foot = el('div.sa-pane-foot', {}, layoutName, layoutText);
  const root = el('section.selpane.sa-pane', { role: 'region', 'aria-label': 'SmartArt Text Pane', hidden: true },
    el('div.selpane-head', {}, title, close), tools, el('div.selpane-body.sa-pane-body', {}, list, note, empty), foot);

  const sheetId = () => ctx.sheetId();
  const diagram = () => activeSmartArt(ctx);
  const inputs = () => [...list.querySelectorAll('.sa-pane-input')];

  /** Apply an outline edit to the diagram, then put the cursor where it says. */
  function commit(obj, res, label, focusAt, offset = 0, merge = null) {
    if (!res) return false;
    wb.updateSmartArt(sheetId(), obj.id, { items: res.items }, label, merge ? { merge } : undefined);
    pendingFocus = { index: focusAt ?? res.at, offset };
    ctx.smartArt?.select(obj.id, [pendingFocus.index]);
    render(true);
    ctx.notify?.();
    return true;
  }

  function act(action, at = currentIndex()) {
    const obj = diagram();
    if (!obj || ctx.refused?.('change the SmartArt graphic')) return;
    if (action === 'add') {
      const res = addSmartArtItem(obj.items, at ?? obj.items.length - 1, 'after');
      commit(obj, res, 'Add Shape After');
      return;
    }
    if (at == null) return;
    const caret = inputs()[at]?.selectionStart ?? 0;
    const res = action === 'promote' ? promoteSmartArtItem(obj.items, at) : action === 'demote' ? demoteSmartArtItem(obj.items, at)
      : moveSmartArtItem(obj.items, at, action === 'moveUp' ? -1 : 1);
    if (!res) { ctx.announce?.({ promote: 'Already at the top level', demote: 'Cannot demote this item further', moveUp: 'Already first', moveDown: 'Already last' }[action]); return; }
    commit(obj, res, { promote: 'Promote', demote: 'Demote', moveUp: 'Move Up', moveDown: 'Move Down' }[action], res.at, caret);
    ctx.announce?.(`Level ${res.items[res.at].level + 1}`);
  }

  const currentIndex = () => {
    const i = inputs().indexOf(document.activeElement);
    if (i >= 0) return i;
    const obj = diagram(), picked = obj ? [...(ctx.smartArt?.selected(obj.id) || [])] : [];
    return picked.length ? picked.at(-1) : null;
  };

  function onKey(e) {
    if (isComposing(e)) return;
    const input = e.currentTarget, at = inputs().indexOf(input), obj = diagram();
    if (!obj || at < 0) return;
    const start = input.selectionStart, end = input.selectionEnd, value = input.value;
    if (e.key === 'Enter' && !e.altKey && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      if (obj.items.length >= SMARTART_MAX_ITEMS) return;
      const items = setSmartArtItemText(obj.items, at, value.slice(0, start) + value.slice(end))?.items || obj.items;
      commit(obj, splitSmartArtItem(items, at, start), 'New item');
    } else if (e.key === 'Tab' && !e.altKey && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      act(e.shiftKey ? 'promote' : 'demote', at);
    } else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && e.altKey && e.shiftKey) {
      e.preventDefault();
      act(e.key === 'ArrowUp' ? 'moveUp' : 'moveDown', at);
    } else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.altKey && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
      const next = inputs()[at + (e.key === 'ArrowUp' ? -1 : 1)];
      if (next) { e.preventDefault(); next.focus(); const k = Math.min(start, next.value.length); next.setSelectionRange(k, k); }
    } else if (e.key === 'Backspace' && start === 0 && end === 0 && at > 0) {
      e.preventDefault();
      if (!value && obj.items.length > 1) {
        const res = removeSmartArtItem(obj.items, at);
        commit(obj, res, 'Delete item', at - 1, inputs()[at - 1]?.value.length ?? 0);
      } else {
        const res = mergeSmartArtItem(obj.items, at);
        commit(obj, res, 'Join items', res?.at, res?.offset ?? 0);
      }
    } else if (e.key === 'Delete' && start === value.length && end === value.length && at < obj.items.length - 1) {
      e.preventDefault();
      const res = mergeSmartArtItem(obj.items, at + 1);
      commit(obj, res, 'Join items', at, value.length);
    } else if (e.key === 'Escape') {
      e.preventDefault(); e.stopPropagation();
      ctx.grid?.focus?.();
    }
  }

  function onInput(e) {
    const input = e.currentTarget, at = inputs().indexOf(input), obj = diagram();
    if (!obj || at < 0) return;
    if (ctx.refused?.('change the SmartArt graphic')) { input.value = obj.items[at]?.text ?? ''; return; }
    const res = setSmartArtItemText(obj.items, at, input.value);
    if (!res) return;
    wb.updateSmartArt(sheetId(), obj.id, { items: res.items }, 'Type SmartArt text', { merge: `text${at}` });
    ctx.notify?.();
  }

  /** Several lines pasted into a line become items, their indentation their levels. */
  function onPaste(e) {
    const text = e.clipboardData?.getData('text/plain') || '';
    if (!/\n/.test(text.trim())) return;
    e.preventDefault();
    const input = e.currentTarget, at = inputs().indexOf(input), obj = diagram();
    if (!obj || at < 0) return;
    const pasted = smartArtItemsFromText(text);
    const base = obj.items[at].level, here = input.value.slice(0, input.selectionStart) + pasted[0].text;
    const tail = input.value.slice(input.selectionEnd);
    const rest = pasted.slice(1).map((it) => ({ ...it, level: base + it.level - pasted[0].level }));
    const items = [...obj.items.slice(0, at), { ...obj.items[at], text: here }, ...rest, ...obj.items.slice(at + 1)];
    if (tail) items.splice(at + 1 + rest.length, 0, { text: tail, level: base });
    commit(obj, { items: items.slice(0, SMARTART_MAX_ITEMS), at: at + rest.length }, 'Paste items', at + rest.length, (rest.at(-1)?.text ?? here).length);
  }

  function render(force = false) {
    if (root.hidden) return;
    const obj = diagram();
    const key = obj ? `${obj.id}|${JSON.stringify(obj.items)}|${obj.layout}` : 'none';
    if (!force && key === lastKey) { syncSelection(); return; }
    lastKey = key;
    empty.hidden = !!obj;
    list.hidden = tools.hidden = foot.hidden = !obj;
    if (!obj) { list.replaceChildren(); note.hidden = true; shownId = null; return; }
    const focused = inputs().indexOf(document.activeElement);
    const caret = focused >= 0 ? document.activeElement.selectionStart : 0;
    const layout = layoutById(obj.layout), roots = smartArtTree(obj.items);
    const shown = new Set();
    const mark = (n) => { shown.add(n.i); n.children.forEach(mark); };
    (layout.maxRoots ? roots.slice(0, layout.maxRoots) : roots).forEach(mark);
    const rows = inputs();
    const same = shownId === obj.id && rows.length === obj.items.length;
    if (!same) {
      list.replaceChildren(...obj.items.map((it, i) => {
        const input = el('input.input.sa-pane-input', { type: 'text', value: it.text, spellcheck: true, autocomplete: 'off', placeholder: '[Text]', maxLength: 1000,
          onkeydown: onKey, oninput: onInput, onpaste: onPaste,
          onfocus: () => { const o = diagram(); if (o) ctx.smartArt?.select(o.id, [inputs().indexOf(input)]); } });
        return el('div.sa-pane-row', { role: 'listitem' }, el('span.sa-pane-bullet', { 'aria-hidden': 'true' }), input);
      }));
    }
    inputs().forEach((input, i) => {
      const it = obj.items[i], row = input.parentElement;
      if (input.value !== it.text && document.activeElement !== input) input.value = it.text;
      if (same && input.value !== it.text && document.activeElement === input && pendingFocus) input.value = it.text;
      row.style.setProperty('--level', String(it.level));
      row.classList.toggle('not-shown', !shown.has(i));
      input.setAttribute('aria-label', `Item ${i + 1} of ${obj.items.length}, level ${it.level + 1}${shown.has(i) ? '' : ', not shown in this layout'}`);
      row.title = shown.has(i) ? '' : 'Kept in the text, but this layout does not show it';
    });
    const hidden = obj.items.length - shown.size;
    note.hidden = !hidden;
    note.textContent = hidden ? `${layout.name} shows ${layout.maxRoots} top-level item${layout.maxRoots === 1 ? '' : 's'}. The ${hidden} item${hidden === 1 ? '' : 's'} marked × ${hidden === 1 ? 'is' : 'are'} kept in the text and come${hidden === 1 ? 's' : ''} back with another layout.` : '';
    layoutName.textContent = layout.name;
    layoutText.textContent = layout.description;
    shownId = obj.id;
    if (pendingFocus) {
      const target = inputs()[Math.min(pendingFocus.index, obj.items.length - 1)];
      const k = Math.min(pendingFocus.offset, target?.value.length ?? 0);
      pendingFocus = null;
      if (target) { target.value = obj.items[inputs().indexOf(target)].text; target.focus(); target.setSelectionRange(k, k); }
    } else if (!same && focused >= 0) {
      const target = inputs()[Math.min(focused, obj.items.length - 1)];
      target?.focus(); target?.setSelectionRange(caret, caret);
    }
    syncSelection();
  }

  /** The rows of the shapes selected in the diagram are marked. */
  function syncSelection() {
    const obj = diagram();
    const picked = obj ? ctx.smartArt?.selected(obj.id) || new Set() : new Set();
    inputs().forEach((input, i) => input.parentElement.classList.toggle('picked', picked.has(i)));
  }

  const unsubscribe = ctx.subscribe(() => render());
  const api = {
    el: root,
    get open() { return !root.hidden; },
    show({ focus = true } = {}) {
      root.hidden = false;
      render(true);
      if (focus) {
        const obj = diagram(), picked = obj ? [...(ctx.smartArt?.selected(obj.id) || [])] : [];
        const target = inputs()[picked.length ? picked.at(-1) : 0];
        if (target) { target.focus(); target.setSelectionRange(target.value.length, target.value.length); }
      }
      ctx.notify?.();
    },
    hide() { root.hidden = true; ctx.grid?.focus?.(); ctx.notify?.(); },
    toggle() { if (root.hidden) api.show(); else api.hide(); },
    refresh: () => render(),
    syncSelection,
    focusItem(i) {
      if (root.hidden) return;
      pendingFocus = { index: i, offset: Infinity };
      render(true);
    },
    destroy() { unsubscribe(); root.remove(); },
  };
  return api;
}
