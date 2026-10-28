import { el, isComposing } from '../ui/dom.js';
import { iconEl } from '../ui/icons.js';
import { commandIconEl } from '../ui/ribbon.js';
import { drawingKind } from '../engine/drawing-format.js';
import { reorderDrawings } from '../engine/drawing-arrange.js';
import { isPositionedImage } from '../engine/images.js';

/**
 * The Selection pane: every picture, shape, group and chart of the story being edited, front to back,
 * with a visibility toggle for each. Click selects (Shift or Ctrl/Cmd+click adds to the selection),
 * double-click or F2 renames, drag or Alt+Up/Down restacks floating objects. Hidden objects stay in
 * the document (wp:docPr hidden) and can be shown again from here.
 */
const KIND_ICONS = { picture: 'pictures', shape: 'shapes', textBox: 'textBox', group: 'groupObjects', chart: 'chart', diagram: 'smartArt', other: 'shapes' };

export function createPane(context) {
  const { editor, ready, commands, onClose, runImages } = context;
  // A list of buttons rather than a listbox: a listbox's options cannot hold buttons, and each row holds two.
  // The selected objects are the list's current items.
  const list = el('ul.pic-selection-list', { 'aria-label': 'Objects on this page' });
  const status = el('p.pic-hint.pic-selection-status', { 'aria-live': 'polite' });
  const showAll = el('button.btn.btn-outline.btn-sm', { type: 'button', onclick: () => setAll(false) }, 'Show All');
  const hideAll = el('button.btn.btn-outline.btn-sm', { type: 'button', onclick: () => setAll(true) }, 'Hide All');
  const up = el('button.icon-btn', { type: 'button', 'aria-label': 'Bring Forward', title: 'Bring Forward', onclick: () => step(-1) }, commandIconEl('bringForward', 16));
  const down = el('button.icon-btn', { type: 'button', 'aria-label': 'Send Backward', title: 'Send Backward', onclick: () => step(1) }, commandIconEl('sendBackward', 16));
  const node = el('aside.pic-pane.pic-selection-pane', { 'aria-label': 'Selection pane' },
    el('div.canvas-panel-heading', {}, el('h2', {}, 'Selection'), el('button.icon-btn', { type: 'button', 'aria-label': 'Close Selection pane', onclick: () => { node.remove(); onClose(); } }, iconEl('x', 18))),
    el('div.pic-selection-tools', {}, showAll, hideAll, el('span.pic-spacer'), up, down),
    el('div.canvas-panel-scroll', {}, list, status));
  node.addEventListener('keydown', e => { if (e.key === 'Escape' && !isComposing(e) && !e.defaultPrevented && !e.target.matches('input')) { e.preventDefault(); node.remove(); onClose(); } });

  /** Drawings front to back: in-front floating, then behind-text floating, then inline in text order. */
  const ordered = () => {
    const engine = editor(); if (!engine) return [];
    const all = runImages(engine.model);
    const floating = all.filter(isPositionedImage), inline = all.filter(image => !isPositionedImage(image));
    const front = floating.filter(i => !i.anchor.behind).sort((a, b) => b.anchor.order - a.anchor.order);
    const behind = floating.filter(i => i.anchor.behind).sort((a, b) => b.anchor.order - a.anchor.order);
    return [...front, ...behind, ...inline];
  };
  const selectedSet = () => { const engine = editor(); const set = engine?.drawingSelection?.length ? engine.drawingSelection : engine?.model.selectedImage ? [engine.model.selectedImage] : []; return new Set(set.map(i => i.id)); };

  function select(image, additive) {
    const engine = ready(); if (!engine) return;
    const all = runImages(engine.model);
    if (additive && engine.setDrawingSelection) {
      const current = (engine.drawingSelection?.length ? engine.drawingSelection : engine.model.selectedImage ? [engine.model.selectedImage] : []).filter(i => all.includes(i));
      const next = current.some(i => i.id === image.id) ? current.filter(i => i.id !== image.id) : [...current, image];
      if (next.length) engine.setDrawingSelection(next);
    } else if (!engine.setDrawingSelection?.([image])) focusImage(engine, image);
    refresh(true);
  }
  function focusImage(engine, image) {
    let offset = 0;
    for (const [index, p] of engine.model.paragraphs.entries()) {
      for (const run of p.runs) { if (run.image === image) { engine.selectMatch({ start: offset, end: offset + 1 }); return; } offset += run.text.length; }
      if (index < engine.model.paragraphs.length - 1) offset += 1;
    }
  }
  function rename(row, image) {
    const label = row.querySelector('.pic-selection-name');
    const input = el('input.input.pic-selection-rename', { type: 'text', value: image.name, 'aria-label': `Rename ${image.name}`, maxLength: 255 });
    let finished = false;
    const finish = commit => {
      if (finished || !input.isConnected) return;
      finished = true;
      const value = input.value.trim();
      input.replaceWith(label);
      if (commit && value && value !== image.name) commands.rename(image, value).then(() => refresh(true));
      label.focus();
    };
    input.addEventListener('keydown', e => { if (isComposing(e)) return; if (e.key === 'Enter') { e.preventDefault(); finish(true); } else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); } });
    input.addEventListener('blur', () => finish(true));
    label.replaceWith(input); input.focus(); input.select();
  }
  async function setAll(hidden) {
    // One step for all of them: one Undo shows or hides them again.
    await commands.setHiddenAll(ordered(), hidden);
    refresh(true);
  }
  function restack(images) {
    const engine = ready(); if (!engine) return;
    engine.finishComposition();
    engine.execute(() => reorderDrawings(engine.model, images));
    refresh(true);
  }
  function step(delta) {
    const items = ordered(), ids = selectedSet();
    const image = items.find(i => ids.has(i.id));
    if (!image || !isPositionedImage(image)) return;
    const floating = items.filter(isPositionedImage), at = floating.indexOf(image), to = at + delta;
    if (to < 0 || to >= floating.length || !!floating[to].anchor.behind !== !!image.anchor.behind) return;
    const next = [...floating]; next.splice(at, 1); next.splice(to, 0, image);
    restack(next);
  }

  // Double-click renames; the list may have been redrawn by the first click, so look the row up here.
  list.addEventListener('dblclick', e => {
    const row = e.target.closest('li'), image = row && ordered().find(i => String(i.id) === row.dataset.id);
    if (image && ready()) rename(row, image);
  });
  let dragging = null, signature = '';
  function refresh(force = false) {
    const items = ordered(), ids = selectedSet();
    const next = JSON.stringify(items.map(i => [i.id, i.name, !!i.hidden, i.anchor?.order, i.anchor?.behind])) + [...ids].join();
    if (!force && next === signature) return;
    signature = next;
    const focused = list.contains(document.activeElement) ? document.activeElement.closest('li')?.dataset.id : null;
    list.replaceChildren(...items.map(image => {
      const kind = drawingKind(image), floating = isPositionedImage(image);
      const selected = ids.has(image.id);
      const name = el('button.pic-selection-name', { type: 'button', title: image.name, 'aria-current': selected ? 'true' : null, onclick: e => { if (e.detail < 2) select(image, e.shiftKey || e.ctrlKey || e.metaKey); },
        onkeydown: e => {
          if (isComposing(e)) return;
          if (e.key === 'F2') { e.preventDefault(); rename(row, image); }
          else if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) { e.preventDefault(); select(image, false); step(e.key === 'ArrowUp' ? -1 : 1); }
          else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); const rows = [...list.querySelectorAll('.pic-selection-name')], at = rows.indexOf(e.target); rows[Math.max(0, Math.min(rows.length - 1, at + (e.key === 'ArrowUp' ? -1 : 1)))]?.focus(); }
          else if (e.key === ' ') { e.preventDefault(); select(image, e.shiftKey || e.ctrlKey || e.metaKey); }
        } }, commandIconEl(KIND_ICONS[kind] || 'shapes', 16), el('span', {}, image.name || 'Object'), floating ? null : el('span.pic-hint', {}, ' · in line'));
      const eye = el('button.icon-btn.pic-selection-eye', { type: 'button', 'aria-pressed': String(!image.hidden), 'aria-label': `${image.hidden ? 'Show' : 'Hide'} ${image.name}`, title: image.hidden ? 'Show' : 'Hide',
        onclick: async () => { await commands.setHidden(image, !image.hidden); refresh(true); } }, iconEl('eye', 16));
      const row = el('li.pic-selection-row', { dataset: { id: String(image.id) }, draggable: floating ? 'true' : 'false', className: `pic-selection-row${image.hidden ? ' is-hidden' : ''}${selected ? ' is-selected' : ''}` }, name, eye);
      if (floating) {
        row.addEventListener('dragstart', e => { dragging = image; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(image.id)); row.classList.add('is-dragging'); });
        row.addEventListener('dragend', () => { dragging = null; row.classList.remove('is-dragging'); for (const r of list.children) r.classList.remove('drop-before', 'drop-after'); });
        row.addEventListener('dragover', e => {
          if (!dragging || dragging === image || !!dragging.anchor.behind !== !!image.anchor.behind) return;
          e.preventDefault(); const box = row.getBoundingClientRect(), before = e.clientY < box.top + box.height / 2;
          row.classList.toggle('drop-before', before); row.classList.toggle('drop-after', !before);
        });
        row.addEventListener('dragleave', () => row.classList.remove('drop-before', 'drop-after'));
        row.addEventListener('drop', e => {
          if (!dragging) return;
          e.preventDefault();
          const box = row.getBoundingClientRect(), before = e.clientY < box.top + box.height / 2;
          const floatingItems = ordered().filter(isPositionedImage).filter(i => i !== dragging);
          const at = floatingItems.indexOf(image) + (before ? 0 : 1);
          floatingItems.splice(at, 0, dragging);
          restack(floatingItems);
        });
      }
      return row;
    }));
    status.textContent = items.length ? `${items.length} ${items.length === 1 ? 'object' : 'objects'}${items.some(i => i.hidden) ? `, ${items.filter(i => i.hidden).length} hidden` : ''}` : 'There are no pictures or shapes in this part of the document.';
    const anySelected = items.some(i => ids.has(i.id) && isPositionedImage(i));
    up.disabled = down.disabled = !anySelected || !ready();
    showAll.disabled = hideAll.disabled = !items.length || !ready();
    if (focused) list.querySelector(`li[data-id="${focused}"] .pic-selection-name`)?.focus();
  }
  return { node, refresh: () => refresh(), show: () => queueMicrotask(() => list.querySelector('.pic-selection-name[aria-current="true"], .pic-selection-name')?.focus()), close: () => node.remove() };
}
