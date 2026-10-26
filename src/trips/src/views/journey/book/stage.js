// The editing stage: one sheet at a zoom, selection with move and resize handles, snapping, drops from the rail,
// keyboard nudges and other people's live cursors and selections.
import { el } from '../../../ui/dom.js';
import { makeDropZone } from '../../../ui/dnd.js';
import { t } from '../../../lib/i18n/index.js';
import { SAFE_MM } from '../../../lib/book/formats.js';
import { clampBox, elementsOf, round } from '../../../lib/book/model.js';
import { elementLabel } from './elements.js';
import { createSheet } from './sheet.js';

const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
const SNAP_PX = 6;
const NUDGE = 0.005;
const NUDGE_COMMIT_MS = 450;
const pct = (value) => `${(value * 100).toFixed(3)}%`;

/**
 * `opts`: `{book(), canEdit(), ctx(), palette, selected(), select(id), commit(changes, label), drop(payload, point, targetId),
 * pointer(point|null), dragging(box|null), activate(id), remove(id), key(event)}`. Returns the stage API.
 */
export function createStage(opts) {
  const viewport = el('div.bk-stage', { tabIndex: -1, 'aria-label': t('book.stage') });
  const inner = el('div.bk-stage-inner');
  viewport.append(inner);
  const live = el('div.sr-only', { 'aria-live': 'polite' });
  const overlay = el('div.bk-overlay');
  const guides = el('div.bk-snaps', { 'aria-hidden': 'true' });
  const peersLayer = el('div.bk-peers', { 'aria-hidden': 'true' });
  let sheet = null;
  let zoom = 1;
  let gesture = null;
  let nudge = null;
  let peers = [];
  let lastPointer = null;
  let destroyed = false;

  const page = () => sheet?.page ?? null;
  const item = (id) => (page()?.els?.[id] ? { ...page().els[id], id } : null);

  function decorate(node, value) {
    const editable = opts.canEdit();
    node.tabIndex = editable ? 0 : -1;
    node.setAttribute('role', editable ? 'button' : 'img');
    node.setAttribute('aria-label', elementLabel(value));
    if (editable) node.setAttribute('aria-pressed', String(opts.selected() === value.id)); else node.removeAttribute('aria-pressed');
  }

  function setPage(next) {
    if (!next) { sheet?.destroy(); sheet = null; inner.replaceChildren(); return; }
    if (!sheet || sheet.page.id !== next.id || sheet.page.kind !== next.kind) {
      sheet?.destroy();
      sheet = createSheet({ book: opts.book(), page: next, mode: 'edit', ctx: opts.ctx, palette: opts.palette(), decorate });
      sheet.element.append(overlay, guides, peersLayer);
      inner.replaceChildren(sheet.element);
      fit();
    } else sheet.update(next, { overrides: overridesNow() });
    drawSelection();
    drawPeers();
  }

  function overridesNow() {
    if (!gesture?.moved && !nudge) return null;
    const box = gesture?.box ?? nudge?.box;
    const id = gesture?.id ?? nudge?.id;
    return new Map([[id, box]]);
  }

  // ---- zoom
  function fit() {
    if (!sheet) return;
    const pad = 48;
    const width = Math.max(120, viewport.clientWidth - pad * 2);
    const height = Math.max(120, viewport.clientHeight - pad * 2);
    const aspect = sheet.size.w / sheet.size.h;
    const base = Math.min(width, height * aspect) || 600;
    sheet.element.style.width = `${Math.round(base * zoom)}px`;
  }
  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(() => fit()) : null;
  observer?.observe(viewport);

  // ---- selection and peers
  function boxOf(id) {
    if (gesture?.id === id && gesture.moved) return gesture.box;
    if (nudge?.id === id) return nudge.box;
    return item(id);
  }
  function drawSelection() {
    overlay.replaceChildren();
    const id = opts.selected();
    const value = id ? item(id) : null;
    if (!value || !sheet) return;
    const box = boxOf(id);
    const frame = el('div.bk-select', { style: { insetInlineStart: pct(box.x), insetBlockStart: pct(box.y), width: pct(box.w), height: pct(box.h) } });
    if (opts.canEdit() && !value.lock) for (const dir of HANDLES) frame.append(el('span.bk-handle', { dataset: { dir }, 'aria-hidden': 'true' }));
    if (value.lock) frame.classList.add('is-locked');
    overlay.append(frame);
  }
  function drawPeers() {
    peersLayer.replaceChildren();
    const current = page();
    if (!current) return;
    for (const peer of peers) {
      if (peer.page !== current.id) continue;
      const style = { '--peer': peer.color };
      if (peer.sel && current.els?.[peer.sel]) {
        const value = peer.drag?.id === peer.sel ? peer.drag : current.els[peer.sel];
        peersLayer.append(el('div.bk-peer-select', { style: { ...style, insetInlineStart: pct(value.x), insetBlockStart: pct(value.y), width: pct(value.w), height: pct(value.h) } },
          el('span.bk-peer-tag', {}, peer.name)));
      }
      if (Number.isFinite(peer.x) && Number.isFinite(peer.y)) {
        peersLayer.append(el('div.bk-cursor', { style: { ...style, insetInlineStart: pct(peer.x), insetBlockStart: pct(peer.y) } }, el('span.bk-cursor-dot'), el('span.bk-peer-tag', {}, peer.name)));
      }
    }
  }

  // ---- geometry helpers
  const rect = () => sheet.element.getBoundingClientRect();
  function pointAt(clientX, clientY) {
    const box = rect();
    return { x: (clientX - box.left) / box.width, y: (clientY - box.top) / box.height };
  }
  function snapTargets(id) {
    const size = sheet.size;
    const xs = [0, 0.5, 1, SAFE_MM / size.w, 1 - SAFE_MM / size.w];
    if (page().kind === 'spread') xs.push(0.25, 0.75, 0.5 - SAFE_MM / size.w, 0.5 + SAFE_MM / size.w);
    const ys = [0, 0.5, 1, SAFE_MM / size.h, 1 - SAFE_MM / size.h];
    for (const other of elementsOf(page())) {
      if (other.id === id) continue;
      xs.push(other.x, other.x + other.w / 2, other.x + other.w);
      ys.push(other.y, other.y + other.h / 2, other.y + other.h);
    }
    return { xs, ys };
  }
  function snap(box, edges, targets, threshold) {
    let best = null;
    for (const [edge, offset] of edges) {
      for (const target of targets) {
        const distance = Math.abs(edge - target);
        if (distance <= threshold && (!best || distance < best.distance)) best = { distance, delta: target - edge, line: target, offset };
      }
    }
    return best;
  }
  function showSnaps(lines) {
    guides.replaceChildren(...lines.map(({ axis, value }) => el(`span.bk-snap.${axis}`, { style: axis === 'x' ? { insetInlineStart: pct(value) } : { insetBlockStart: pct(value) } })));
  }

  // ---- pointer gestures
  function down(event) {
    if (event.button !== 0 || !sheet || destroyed) return;
    const handle = event.target.closest('.bk-handle');
    const node = event.target.closest('.bk-el');
    if (!opts.canEdit()) return;
    if (!handle && !node) {
      if (sheet.element.contains(event.target) || event.target === viewport || event.target === inner) { opts.select(null); }
      return;
    }
    const id = handle ? opts.selected() : node.dataset.id;
    const value = item(id);
    if (!value) return;
    if (opts.selected() !== id) opts.select(id);
    if (value.lock) return;
    event.preventDefault();
    node?.focus({ preventScroll: true });
    const box = rect();
    gesture = { id, dir: handle?.dataset.dir ?? null, start: { x: value.x, y: value.y, w: value.w, h: value.h }, box: { x: value.x, y: value.y, w: value.w, h: value.h },
      px: event.clientX, py: event.clientY, width: box.width, height: box.height, moved: false, pointerId: event.pointerId, targets: snapTargets(id) };
    try { viewport.setPointerCapture(event.pointerId); } catch { /* gone */ }
  }
  function move(event) {
    if (sheet && !gesture) {
      const point = pointAt(event.clientX, event.clientY);
      opts.pointer(point.x >= -0.05 && point.x <= 1.05 && point.y >= -0.05 && point.y <= 1.05 ? point : null);
    }
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    const dx = (event.clientX - gesture.px) / gesture.width;
    const dy = (event.clientY - gesture.py) / gesture.height;
    if (!gesture.moved && Math.hypot(event.clientX - gesture.px, event.clientY - gesture.py) < 3) return;
    gesture.moved = true;
    const { start, dir } = gesture;
    let next = { ...start };
    const tx = SNAP_PX / gesture.width;
    const ty = SNAP_PX / gesture.height;
    const lines = [];
    if (!dir) {
      next.x = start.x + dx; next.y = start.y + dy;
      if (!event.altKey) {
        const sx = snap(next, [[next.x, 0], [next.x + next.w / 2, 0], [next.x + next.w, 0]], gesture.targets.xs, tx);
        if (sx) { next.x += sx.delta; lines.push({ axis: 'x', value: sx.line }); }
        const sy = snap(next, [[next.y, 0], [next.y + next.h / 2, 0], [next.y + next.h, 0]], gesture.targets.ys, ty);
        if (sy) { next.y += sy.delta; lines.push({ axis: 'y', value: sy.line }); }
      }
    } else {
      if (dir.includes('e')) next.w = start.w + dx;
      if (dir.includes('w')) { next.x = start.x + dx; next.w = start.w - dx; }
      if (dir.includes('s')) next.h = start.h + dy;
      if (dir.includes('n')) { next.y = start.y + dy; next.h = start.h - dy; }
      if (event.shiftKey && dir.length === 2) {
        // Keep the aspect ratio in mm, anchored at the opposite corner.
        const ratio = (start.w * sheet.size.w) / (start.h * sheet.size.h);
        const h = (next.w * sheet.size.w) / ratio / sheet.size.h;
        if (dir.includes('n')) next.y = start.y + start.h - h;
        next.h = h;
      }
      if (!event.altKey && !event.shiftKey) {
        if (dir.includes('e')) { const s = snap(next, [[next.x + next.w, 0]], gesture.targets.xs, tx); if (s) { next.w += s.delta; lines.push({ axis: 'x', value: s.line }); } }
        if (dir.includes('w')) { const s = snap(next, [[next.x, 0]], gesture.targets.xs, tx); if (s) { next.x += s.delta; next.w -= s.delta; lines.push({ axis: 'x', value: s.line }); } }
        if (dir.includes('s')) { const s = snap(next, [[next.y + next.h, 0]], gesture.targets.ys, ty); if (s) { next.h += s.delta; lines.push({ axis: 'y', value: s.line }); } }
        if (dir.includes('n')) { const s = snap(next, [[next.y, 0]], gesture.targets.ys, ty); if (s) { next.y += s.delta; next.h -= s.delta; lines.push({ axis: 'y', value: s.line }); } }
      }
    }
    next = clampBox(next);
    gesture.box = next;
    showSnaps(lines);
    const node = sheet.nodes.get(gesture.id);
    if (node) Object.assign(node.style, { insetInlineStart: pct(next.x), insetBlockStart: pct(next.y), width: pct(next.w), height: pct(next.h) });
    drawSelection();
    opts.dragging({ id: gesture.id, ...next });
    opts.pointer(pointAt(event.clientX, event.clientY));
  }
  function up(event) {
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    const done = gesture;
    gesture = null;
    showSnaps([]);
    opts.dragging(null);
    try { viewport.releasePointerCapture(event.pointerId); } catch { /* released */ }
    if (!done.moved) return;
    const changes = {};
    for (const key of ['x', 'y', 'w', 'h']) if (round(done.box[key]) !== round(done.start[key])) changes[key] = round(done.box[key]);
    if (Object.keys(changes).length) opts.commit({ [done.id]: changes }, t(done.dir ? 'book.history.resize' : 'book.history.move'));
    else setPage(page());
  }
  function cancelGesture() {
    if (!gesture) return;
    gesture = null;
    showSnaps([]);
    opts.dragging(null);
    setPage(page());
  }

  // ---- keyboard
  function flushNudge() {
    if (!nudge) return;
    clearTimeout(nudge.timer);
    const done = nudge;
    nudge = null;
    const changes = {};
    for (const key of ['x', 'y']) if (round(done.box[key]) !== round(done.start[key])) changes[key] = round(done.box[key]);
    if (Object.keys(changes).length) opts.commit({ [done.id]: changes }, t('book.history.move'));
  }
  function keydown(event) {
    if (opts.key?.(event)) return;
    const id = opts.selected();
    if (event.key === 'Escape') {
      if (gesture) { cancelGesture(); event.preventDefault(); return; }
      if (id) { opts.select(null); viewport.focus({ preventScroll: true }); event.preventDefault(); }
      return;
    }
    const target = event.target.closest?.('.bk-el');
    if (target && event.key === 'Enter') { event.preventDefault(); if (opts.selected() === target.dataset.id) opts.activate(target.dataset.id); else opts.select(target.dataset.id); return; }
    if (target && event.key === ' ' && opts.canEdit()) { event.preventDefault(); opts.select(target.dataset.id); return; }
    if (!id || !opts.canEdit()) return;
    const value = item(id);
    if (!value) return;
    if (['Delete', 'Backspace'].includes(event.key)) { event.preventDefault(); flushNudge(); opts.remove(id); return; }
    const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    if (!arrows[event.key] || value.lock || event.altKey || event.ctrlKey || event.metaKey) return;
    event.preventDefault();
    const step = event.shiftKey ? NUDGE * 10 : NUDGE;
    if (!nudge || nudge.id !== id) { flushNudge(); nudge = { id, start: { ...value }, box: { x: value.x, y: value.y, w: value.w, h: value.h }, timer: 0 }; }
    nudge.box = clampBox({ ...nudge.box, x: nudge.box.x + arrows[event.key][0] * step, y: nudge.box.y + arrows[event.key][1] * step });
    clearTimeout(nudge.timer);
    nudge.timer = setTimeout(flushNudge, NUDGE_COMMIT_MS);
    const node = sheet.nodes.get(id);
    if (node) Object.assign(node.style, { insetInlineStart: pct(nudge.box.x), insetBlockStart: pct(nudge.box.y) });
    drawSelection();
    live.textContent = t('book.moved', { x: Math.round(nudge.box.x * sheet.size.w), y: Math.round(nudge.box.y * sheet.size.h) });
  }
  function dblclick(event) {
    const node = event.target.closest('.bk-el');
    if (node && opts.canEdit()) opts.activate(node.dataset.id);
  }
  function focusin(event) {
    const node = event.target.closest?.('.bk-el');
    if (node && opts.canEdit() && opts.selected() !== node.dataset.id && !gesture) opts.select(node.dataset.id);
  }

  // ---- drops from the rail (pointer position tracked while a kit drag is active)
  const track = (event) => { if (document.body.classList.contains('dnd-active')) lastPointer = { x: event.clientX, y: event.clientY }; };
  document.addEventListener('pointermove', track, true);
  const zone = makeDropZone(inner, { area: viewport, placeholder: false, accepts: (data) => opts.canEdit() && Boolean(data?.type), onDrop: ({ data }) => {
    if (!sheet || !lastPointer) return;
    const under = document.elementsFromPoint?.(lastPointer.x, lastPointer.y) ?? [];
    const target = under.map((node) => node.closest?.('.bk-el')).find((node) => node && sheet.element.contains(node));
    opts.drop(data, pointAt(lastPointer.x, lastPointer.y), target?.dataset.id ?? null);
  } });

  viewport.addEventListener('pointerdown', down);
  viewport.addEventListener('pointermove', move);
  viewport.addEventListener('pointerup', up);
  viewport.addEventListener('pointercancel', cancelGesture);
  viewport.addEventListener('pointerleave', () => { if (!gesture) opts.pointer(null); });
  viewport.addEventListener('keydown', keydown);
  viewport.addEventListener('dblclick', dblclick);
  viewport.addEventListener('focusin', focusin);

  return {
    element: el('div.bk-stage-wrap', {}, viewport, live),
    viewport,
    setPage,
    get sheet() { return sheet; },
    refresh() { if (sheet) sheet.update(page(), { overrides: overridesNow() }); drawSelection(); drawPeers(); },
    setPalette(value) { sheet?.setPalette(value); },
    setPeers(list) { peers = list; drawPeers(); },
    preview(id, fields) { if (!sheet) return; sheet.update(page(), { overrides: new Map([[id, fields]]) }); drawSelection(); },
    focusElement(id) { sheet?.nodes.get(id)?.focus({ preventScroll: false }); },
    announce(text) { live.textContent = text; },
    zoomBy(factor) { zoom = Math.min(4, Math.max(0.25, zoom * factor)); fit(); },
    zoomFit() { zoom = 1; fit(); },
    get zoom() { return zoom; },
    flush: flushNudge,
    destroy() {
      destroyed = true;
      flushNudge();
      observer?.disconnect();
      zone.destroy();
      document.removeEventListener('pointermove', track, true);
      sheet?.destroy();
    },
  };
}
