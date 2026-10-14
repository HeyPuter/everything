/**
 * The Selection Pane (Page Layout ▸ Arrange ▸ Selection Pane): every drawing object on the sheet, the front
 * one first, each with an eye that shows or hides it. A click selects an object on the sheet (Shift or
 * Cmd/Ctrl adds it to those selected), a double-click or F2 renames it, and dragging a row moves the object
 * through the stacking order; Show All and Hide All act on the whole sheet, the arrows on the selection.
 */
import { el } from './dom.js';
import { icon } from './icons.js';
import { objectNames } from '../core/arrange.js';

export function createSelectionPane(ctx) {
  const { wb } = ctx;
  let lastKey = null, renaming = null, dragId = null;
  const list = el('div.selpane-list', { role: 'listbox', 'aria-label': 'Objects on this sheet', 'aria-multiselectable': 'true', tabindex: 0 });
  const empty = el('p.selpane-empty', {}, 'There are no charts, pictures, shapes or text boxes on this sheet.');
  const close = el('button.icon-btn', { type: 'button', 'aria-label': 'Close Selection Pane', html: icon('x', 16), onclick: () => api.hide() });
  const tool = (label, glyph, onclick, title = label) => el('button.btn.btn-ghost.selpane-tool', { type: 'button', title, 'aria-label': title, onclick }, glyph ? el('span', { html: icon(glyph, 16) }) : null, glyph ? null : label);
  const showAll = tool('Show All', null, () => ctx.run('objectsVisible', { ids: sheetObjects().map((o) => o.id), hidden: false }));
  const hideAll = tool('Hide All', null, () => ctx.run('objectsVisible', { ids: sheetObjects().map((o) => o.id), hidden: true }));
  const forward = tool('', 'chevU', () => ctx.run('orderObject', { where: 'forward' }), 'Bring Forward');
  const backward = tool('', 'chevD', () => ctx.run('orderObject', { where: 'backward' }), 'Send Backward');
  const root = el('section.selpane', { role: 'region', 'aria-label': 'Selection', hidden: true },
    el('div.selpane-head', {}, el('span.selpane-title', {}, 'Selection'), close),
    el('div.selpane-tools', {}, showAll, hideAll, el('span.selpane-gap'), forward, backward),
    el('div.selpane-body', {}, list, empty));

  const sheetObjects = () => wb.sheet(ctx.sheetId())?.charts || [];
  const selected = () => new Set(ctx.grid.selectedCharts || []);

  /** One row: the name (an input while renaming), and the eye. */
  function row(obj, name, { member = false, groupId = null, ids = [obj?.id] } = {}) {
    const id = groupId || obj.id, hidden = ids.every((x) => wb.chartById(ctx.sheetId(), x)?.hidden);
    const picked = ids.every((x) => selected().has(x));
    const eye = el('button.selpane-eye', { type: 'button', tabindex: -1, 'aria-pressed': String(!hidden),
      'aria-label': `${hidden ? 'Show' : 'Hide'} ${name}`, title: hidden ? 'Show' : 'Hide', html: icon(hidden ? 'eyeOff' : 'eye', 15),
      onclick: (e) => { e.stopPropagation(); ctx.run('objectsVisible', { ids, hidden: !hidden }); } });
    const label = renaming === id
      ? el('input.input.selpane-rename', { type: 'text', value: name, 'aria-label': 'Object name', maxLength: 255,
        onkeydown: (e) => {
          if (e.key === 'Enter') { e.preventDefault(); finishRename(e.target.value); }
          else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finishRename(null); }
        }, onblur: (e) => finishRename(e.target.value) })
      : el('span.selpane-name', {}, name);
    const node = el(`div.selpane-row${member ? '.member' : ''}${groupId ? '.group' : ''}${hidden ? '.is-hidden' : ''}`, {
      role: 'option', id: `selpane-${id}`, 'aria-selected': String(picked), dataset: { id, ids: ids.join(' ') }, draggable: renaming !== id,
      onclick: (e) => pick(ids, e.shiftKey || e.metaKey || e.ctrlKey),
      ondblclick: () => { if (!groupId) startRename(id); },
      ondragstart: (e) => { dragId = ids[0]; e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', name); } catch { /* old engines */ } },
      ondragend: () => { dragId = null; list.querySelector('.drop-before, .drop-after')?.classList.remove('drop-before', 'drop-after'); },
    }, member ? el('span.selpane-indent') : null, groupId ? el('span.selpane-group', { html: icon('groupObjects', 15) }) : null, label, eye);
    return node;
  }

  function render(force = false) {
    if (root.hidden) return;
    const objects = sheetObjects();
    const key = `${ctx.sheetId()}|${wb.version}|${[...selected()].join(',')}|${renaming}`;
    if (!force && key === lastKey) return;
    lastKey = key;
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
    const sel = ctx.grid.selectedCharts || [];
    showAll.disabled = hideAll.disabled = !objects.length;
    forward.disabled = backward.disabled = !sel.length;
    const active = list.querySelector(`[data-id="${CSS.escape(sel[0] || '')}"]`);
    if (active) list.setAttribute('aria-activedescendant', active.id); else list.removeAttribute('aria-activedescendant');
    if (renaming) { const input = list.querySelector('.selpane-rename'); input?.focus(); input?.select(); }
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
    const rows = [...list.querySelectorAll('.selpane-row')];
    const at = rows.findIndex((r) => r.getAttribute('aria-selected') === 'true');
    const step = { ArrowDown: 1, ArrowUp: -1 }[e.key];
    if (step && rows.length) {
      e.preventDefault();
      const next = rows[Math.max(0, Math.min(rows.length - 1, at < 0 ? 0 : at + step))];
      pick(next.dataset.ids.split(' '), e.shiftKey);
      next.scrollIntoView?.({ block: 'nearest' });
    } else if ((e.key === ' ' || e.key === 'Enter') && at >= 0) {
      e.preventDefault();
      rows[at].querySelector('.selpane-eye')?.click();
    } else if (e.key === 'F2' && at >= 0 && !rows[at].classList.contains('group')) {
      e.preventDefault();
      startRename(rows[at].dataset.id);
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
