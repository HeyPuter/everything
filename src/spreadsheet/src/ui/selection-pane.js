/**
 * The Selection Pane (Page Layout ▸ Arrange ▸ Selection Pane): every drawing object on the sheet, the front
 * one first, each with an eye that shows or hides it. A click selects an object on the sheet (Shift or
 * Cmd/Ctrl adds it to those selected), a double-click or F2 renames it, and dragging a row moves the object
 * through the stacking order; Show All and Hide All act on the whole sheet, the arrows on the selection, and
 * Delete removes the objects picked.
 */
import { el } from './dom.js';
import { icon } from './icons.js';
import { objectNames } from '../core/arrange.js';
import { t } from '../i18n/index.js';

export function createSelectionPane(ctx) {
  const { wb } = ctx;
  let lastKey = null, renaming = null, dragId = null;
  // The row the arrow keys move from: the one last picked, from the keyboard or with a click.
  let cursor = null;
  const list = el('div.selpane-list', { role: 'listbox', 'aria-label': t('selectionPane.objects'), 'aria-multiselectable': 'true', tabindex: 0 });
  const empty = el('p.selpane-empty', {}, t('selectionPane.empty'));
  const close = el('button.icon-btn', { type: 'button', 'aria-label': t('selectionPane.close'), html: icon('x', 16), onclick: () => api.hide() });
  const tool = (label, glyph, onclick, title = label) => el('button.btn.btn-ghost.selpane-tool', { type: 'button', title, 'aria-label': title, onclick }, glyph ? el('span', { html: icon(glyph, 16) }) : null, glyph ? null : label);
  const showAll = tool(t('selectionPane.showAll'), null, () => ctx.run('objectsVisible', { ids: sheetObjects().map((o) => o.id), hidden: false }));
  const hideAll = tool(t('selectionPane.hideAll'), null, () => ctx.run('objectsVisible', { ids: sheetObjects().map((o) => o.id), hidden: true }));
  const forward = tool('', 'chevU', () => ctx.run('orderObject', { where: 'forward' }), t('selectionPane.bringForward'));
  const backward = tool('', 'chevD', () => ctx.run('orderObject', { where: 'backward' }), t('selectionPane.sendBackward'));
  const root = el('section.selpane', { role: 'region', 'aria-label': t('selectionPane.title'), hidden: true },
    el('div.selpane-head', {}, el('span.selpane-title', {}, t('selectionPane.title')), close),
    el('div.selpane-tools', {}, showAll, hideAll, el('span.selpane-gap'), forward, backward),
    el('div.selpane-body', {}, list, empty));

  const sheetObjects = () => wb.sheet(ctx.sheetId())?.charts || [];
  const selected = () => new Set(ctx.grid.selectedCharts || []);

  /** One row: the name (an input while renaming), and the eye. */
  function row(obj, name, { member = false, groupId = null, ids = [obj?.id] } = {}) {
    const id = groupId || obj.id, hidden = ids.every((x) => wb.chartById(ctx.sheetId(), x)?.hidden);
    const picked = ids.every((x) => selected().has(x));
    const eye = el('button.selpane-eye', { type: 'button', tabindex: -1, 'aria-pressed': String(!hidden),
      'aria-label': hidden ? t('selectionPane.showObject', { name }) : t('selectionPane.hideObject', { name }), title: hidden ? t('common.show') : t('common.hide'), html: icon(hidden ? 'eyeOff' : 'eye', 15),
      onclick: (e) => { e.stopPropagation(); ctx.run('objectsVisible', { ids, hidden: !hidden }); } });
    const label = renaming === id
      ? el('input.input.selpane-rename', { type: 'text', value: name, 'aria-label': t('selectionPane.objectName'), maxLength: 255,
        onkeydown: (e) => {
          if (e.key === 'Enter') { e.preventDefault(); finishRename(e.target.value); }
          else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finishRename(null); }
        }, onblur: (e) => finishRename(e.target.value) })
      : el('span.selpane-name', {}, name);
    const node = el(`div.selpane-row${member ? '.member' : ''}${groupId ? '.group' : ''}${hidden ? '.is-hidden' : ''}`, {
      role: 'option', id: `selpane-${id}`, 'aria-selected': String(picked), dataset: { id, ids: ids.join(' ') }, draggable: renaming !== id,
      onclick: (e) => { cursor = id; pick(ids, e.shiftKey || e.metaKey || e.ctrlKey); },
      ondblclick: () => { if (!groupId) startRename(id); },
      ondragstart: (e) => { dragId = ids[0]; e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', name); } catch { /* old engines */ } },
      ondragend: () => { dragId = null; list.querySelector('.drop-before, .drop-after')?.classList.remove('drop-before', 'drop-after'); },
    }, member ? el('span.selpane-indent') : null, groupId ? el('span.selpane-group', { html: icon('groupObjects', 15) }) : null, label, eye);
    return node;
  }

  function render(force = false) {
    if (root.hidden) return;
    const objects = sheetObjects();
    const rowsKey = `${ctx.sheetId()}|${wb.version}|${renaming}`;
    const key = `${rowsKey}|${[...selected()].join(',')}`;
    if (!force && key === lastKey) return;
    // Only the selection changed (an arrow key, a click): the rows stay and are marked again. Drawn afresh, a
    // sheet of a thousand objects took a tenth of a second for each press of an arrow.
    const rowsSame = lastKey?.startsWith(`${rowsKey}|`) && list.childElementCount;
    lastKey = key;
    if (rowsSame) { mark(); return; }
    const names = objectNames(objects);
    const rows = [];
    // Front first: the list runs back to front, so it is read from its end.
    for (let i = objects.length - 1; i >= 0; i--) {
      const o = objects[i];
      if (o.group) {
        const members = [];
        while (i >= 0 && objects[i].group === o.group) members.push(objects[i--]);
        i++;
        rows.push(row(null, names.get(o.group), { groupId: o.group, ids: members.map((m) => m.id) }));
        for (const m of members) rows.push(row(m, names.get(m.id), { member: true }));
      } else rows.push(row(o, names.get(o.id)));
    }
    list.replaceChildren(...rows);
    list.hidden = !objects.length;
    empty.hidden = !!objects.length;
    showAll.disabled = hideAll.disabled = !objects.length;
    mark();
    if (renaming) { const input = list.querySelector('.selpane-rename'); input?.focus(); input?.select(); }
  }

  /** The rows of the objects selected marked so, and the tools and the list's active row following the selection. */
  function mark() {
    const now = selected();
    for (const node of list.children) node.setAttribute('aria-selected', String(node.dataset.ids.split(' ').every((x) => now.has(x))));
    const sel = ctx.grid.selectedCharts || [];
    forward.disabled = backward.disabled = !sel.length;
    const at = (key) => list.querySelector(`[data-id="${CSS.escape(key || '')}"][aria-selected="true"]`);
    const active = at(cursor) || at(sel[0]);
    if (active) list.setAttribute('aria-activedescendant', active.id); else list.removeAttribute('aria-activedescendant');
  }

  /** Select the row's objects on the sheet, or with `add` add them to the selection (or take them out). The pane keeps the keyboard. */
  function pick(ids, add) {
    const now = selected();
    if (add) {
      const all = ids.every((i) => now.has(i));
      for (const i of ids) { if (all) now.delete(i); else now.add(i); }
      ctx.grid.selectCharts(all ? [...now] : [...ids, ...[...now].filter((x) => !ids.includes(x))], { focus: false });
    } else ctx.grid.selectCharts(ids, { focus: false });
    ctx.notify?.();
    render(true);
  }
  function startRename(id) { renaming = id; render(true); }
  function finishRename(value) {
    const id = renaming;
    if (!id) return;
    renaming = null;
    if (value != null) ctx.run('renameObject', { id, name: value });
    render(true);
    list.focus();
  }

  // Drag a row to move its object through the stacking order; the drop line shows where it will land.
  const dropAt = (e) => {
    const rowNode = e.target.closest?.('.selpane-row');
    if (!rowNode) return null;
    const box = rowNode.getBoundingClientRect(), after = e.clientY > box.top + box.height / 2;
    return { rowNode, after };
  };
  list.addEventListener('dragover', (e) => {
    if (!dragId) return;
    const at = dropAt(e);
    if (!at) return;
    e.preventDefault();
    list.querySelector('.drop-before, .drop-after')?.classList.remove('drop-before', 'drop-after');
    at.rowNode.classList.add(at.after ? 'drop-after' : 'drop-before');
  });
  list.addEventListener('drop', (e) => {
    const at = dropAt(e);
    if (!dragId || !at) return;
    e.preventDefault();
    const objects = sheetObjects(), target = at.rowNode.dataset.ids.split(' ');
    // The row's place in the stacking order (counted from the back); a drop below a row goes behind it.
    const indices = target.map((x) => objects.findIndex((o) => o.id === x)).filter((n) => n >= 0);
    if (!indices.length) return;
    const moving = new Set(objects.filter((o) => o.id === dragId || (o.group && o.group === objects.find((m) => m.id === dragId)?.group)).map((o) => o.id));
    const before = objects.filter((o) => !moving.has(o.id));
    const anchor = at.after ? Math.min(...indices) : Math.max(...indices) + 1;
    const to = before.filter((o) => objects.indexOf(o) < anchor).length;
    ctx.run('moveObjectInOrder', { id: dragId, to });
    dragId = null;
  });

  list.addEventListener('keydown', (e) => {
    if (e.target !== list) return;
    // A group's members are picked with the group, so the arrows step over them from one group or object to
    // the next, from the row last picked; Shift adds the next one to those selected.
    const rows = [...list.querySelectorAll('.selpane-row:not(.member)')];
    const isPicked = (r) => r.getAttribute('aria-selected') === 'true';
    let at = rows.findIndex((r) => r.dataset.id === cursor && isPicked(r));
    if (at < 0) at = rows.findIndex(isPicked);
    const step = { ArrowDown: 1, ArrowUp: -1 }[e.key];
    if (step && rows.length) {
      e.preventDefault();
      const next = rows[Math.max(0, Math.min(rows.length - 1, at < 0 ? 0 : at + step))];
      cursor = next.dataset.id;
      if (!e.shiftKey || !isPicked(next)) pick(next.dataset.ids.split(' '), e.shiftKey);
      else render(true);
      list.querySelector(`[data-id="${CSS.escape(cursor)}"]`)?.scrollIntoView?.({ block: 'nearest' });
    } else if ((e.key === ' ' || e.key === 'Enter') && at >= 0) {
      e.preventDefault();
      rows[at].querySelector('.selpane-eye')?.click();
    } else if (e.key === 'F2' && at >= 0 && !rows[at].classList.contains('group')) {
      e.preventDefault();
      startRename(rows[at].dataset.id);
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && selected().size) {
      // Delete removes the objects picked in the list, as the key does on the sheet; the pane keeps the keyboard.
      e.preventDefault();
      const ids = [...selected()];
      if (ids.length > 1) ctx.run('deleteObjects', ids); else ctx.run('deleteChart', ids[0]);
      cursor = null;
      render(true);
      list.focus();
    }
  });

  const unsubscribe = ctx.subscribe(() => render());
  const api = {
    el: root,
    get open() { return !root.hidden; },
    show() { root.hidden = false; render(true); list.focus(); },
    hide() { root.hidden = true; renaming = null; ctx.grid.focus(); ctx.notify?.(); },
    toggle() { if (root.hidden) api.show(); else api.hide(); },
    refresh: () => render(),
    destroy() { unsubscribe(); root.remove(); },
  };
  return api;
}
