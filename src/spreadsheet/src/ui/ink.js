/**
 * The Draw tab: pens, a pencil and a highlighter that ink on the sheet, a stroke eraser, Lasso Select, Ink to Shape
 * and Draw with Touch. While a tool is chosen a layer over the cells takes the pointer (mouse, pen with pressure, or a
 * finger with Draw with Touch on); each stroke is added as a sheet object anchored to the cell under its corner, so it
 * scrolls, zooms, moves, resizes, deletes and undoes as pictures do, and is saved as a native freeform (core/ink.js).
 */
import { el } from './dom.js';
import { openMenu } from './menu.js';
import { icon } from './icons.js';
import { customColorRows } from './colorpicker.js';
import { appOption } from '../lib/app-options.js';
import {
  buildStroke, buildShape, recognizeShape, isInk, inkLines, touchesLines, sweep, insideLasso, nextName, penLabel, normalizePen, penStyle,
  DEFAULT_PENS, MAX_PENS, PEN_WIDTHS, HIGHLIGHTER_WIDTHS, PEN_COLORS, HIGHLIGHTER_COLORS, PEN_KINDS, SHAPE_NAMES, MM_PX,
} from '../core/ink.js';

const STORE = 'spreadsheet:pens';
const SVG = 'http://www.w3.org/2000/svg';
const KIND_LABELS = { pen: 'Pen', pencil: 'Pencil', highlighter: 'Highlighter' };
const KIND_GLYPHS = { pen: 'inkPen', pencil: 'inkPencil', highlighter: 'inkHighlighter' };
const attr = v => String(v).replace(/["\\]/g, '\\$&');
const svgUrl = svg => `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svg)))}`;
const svgNode = (name, attrs = {}) => {
  const n = document.createElementNS(SVG, name);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  return n;
};

function loadPens() {
  try {
    const list = JSON.parse(localStorage.getItem(STORE) || 'null');
    if (Array.isArray(list)) {
      const pens = list.map(normalizePen).filter(Boolean).slice(0, MAX_PENS);
      const seen = new Set();
      pens.forEach((p, i) => { if (!p.id || seen.has(p.id)) p.id = `pen-${100 + i}`; seen.add(p.id); });
      if (pens.length) return pens;
    }
  } catch { /* no storage */ }
  return DEFAULT_PENS.map(p => ({ ...p }));
}

export function createInk({ wb, grid, notify = () => {}, subscribe = null, refused = () => false, announce = () => {} }) {
  let tool = null; // null (Select) | 'lasso' | 'eraser' | a pen's id
  let pens = loadPens();
  let inkToShape = false, touch = false;
  let surface = null, live = null, gesture = null;
  let lassoed = null; // { ids, box } — several strokes chosen with the lasso
  let shownSheet = grid.sheetId;

  const save = () => { try { localStorage.setItem(STORE, JSON.stringify(pens)); } catch { /* no storage */ } };
  const pen = id => pens.find(p => p.id === id) || null;
  const sheet = () => wb.sheet(grid.sheetId);
  const canvas = () => grid.viewport.querySelector('.grid-canvas');
  const boxOf = id => grid.el.querySelector(`.chart-box[data-chart="${attr(id)}"]`);
  // Only the strokes shown: one hidden in the Selection Pane, or with every object hidden in Options, is out of the eraser's and lasso's reach.
  const inkObjects = () => (appOption('showObjects') ? sheet()?.charts || [] : []).filter(o => isInk(o) && !o.hidden);

  function setTool(next) {
    const wanted = next === 'select' ? null : next;
    if (wanted && wanted !== 'lasso' && refused('draw')) return;
    if (wanted && grid.editing && !grid.commitEdit()) return;
    tool = wanted;
    clearLasso();
    if (tool && grid.selectedChart) grid.selectChart(null);
    attach();
    notify();
  }

  /** The layer over the sheet that takes the pointer while a tool is chosen. */
  function attach() {
    const host = canvas();
    if (!tool || !host || sheet()?.kind === 'chart') { cancelGesture(); surface?.remove(); surface = null; return; }
    if (!surface) {
      surface = el('div.ink-surface', { 'aria-hidden': 'true' });
      surface.addEventListener('pointerdown', down);
      surface.addEventListener('pointermove', move);
      surface.addEventListener('pointerup', up);
      surface.addEventListener('pointercancel', cancelGesture);
      surface.addEventListener('contextmenu', e => e.preventDefault());
    }
    if (surface.parentNode !== host) host.append(surface);
    const p = pen(tool);
    surface.dataset.tool = p ? p.kind : tool;
  }

  /* ---------- Pointer ---------- */

  const at = e => {
    const p = grid.canvasPoint(e.clientX, e.clientY);
    return { x: p.x, y: p.y, pressure: e.pointerType === 'pen' ? e.pressure : undefined };
  };

  function down(e) {
    if (gesture || (e.pointerType === 'mouse' && e.button !== 0)) return;
    e.preventDefault(); e.stopPropagation();
    try { surface.setPointerCapture(e.pointerId); } catch { /* synthetic events */ }
    const p = at(e);
    // Without Draw with Touch a finger scrolls the sheet, as it does over the cells.
    if (e.pointerType === 'touch' && !touch) { gesture = { kind: 'pan', id: e.pointerId, x: e.clientX, y: e.clientY }; return; }
    if (lassoed && pointIn(p, lassoed.box)) { startMoveLassoed(e, p); return; }
    if (tool === 'eraser') startErase(e, p);
    else if (tool === 'lasso') startLasso(e, p);
    else if (pen(tool)) startStroke(e, p);
  }
  function move(e) {
    if (!gesture || e.pointerId !== gesture.id) return;
    e.preventDefault();
    const events = e.getCoalescedEvents?.().length ? e.getCoalescedEvents() : [e];
    if (gesture.kind === 'pan') {
      grid.viewport.scrollLeft -= e.clientX - gesture.x; grid.viewport.scrollTop -= e.clientY - gesture.y;
      gesture.x = e.clientX; gesture.y = e.clientY;
      return;
    }
    for (const ev of events) gesture.move(at(ev));
  }
  function up(e) {
    if (!gesture || e.pointerId !== gesture.id) return;
    e.preventDefault();
    const g = gesture;
    gesture = null;
    if (g.kind !== 'pan') g.end(at(e));
  }
  function cancelGesture() {
    const g = gesture;
    gesture = null;
    g?.cancel?.();
    live?.remove(); live = null;
  }
  const liveLayer = () => {
    live?.remove();
    live = svgNode('svg', { class: 'ink-live' });
    surface.append(live);
    return live;
  };

  /* ---------- Pens ---------- */

  function startStroke(e, p) {
    const chosen = pen(tool);
    const style = penStyle(chosen), zoom = grid.zoom;
    const layer = liveLayer();
    const path = svgNode('path', { fill: 'none', stroke: chosen.color, 'stroke-width': String(style.widthPx * zoom), 'stroke-linecap': style.cap === 'sq' ? 'square' : 'round',
      'stroke-linejoin': 'round', 'stroke-opacity': String(style.opacity) });
    layer.append(path);
    const points = [p];
    const draw = () => path.setAttribute('d', `M${points.map(q => `${q.x} ${q.y}`).join('L')}${points.length === 1 ? `l0.01 0` : ''}`);
    draw();
    gesture = { kind: 'stroke', id: e.pointerId, pointer: e.pointerType,
      move: q => { points.push(q); draw(); },
      end: q => { if (q.x !== points.at(-1).x || q.y !== points.at(-1).y) points.push(q); commitStroke(points, chosen, e.pointerType); },
      cancel: () => {} };
  }

  function commitStroke(points, chosen, pointer) {
    const zoom = grid.zoom, sid = grid.sheetId;
    const sheetPoints = points.map(q => ({ x: q.x / zoom, y: q.y / zoom, pressure: q.pressure }));
    const shape = inkToShape && chosen.kind !== 'highlighter' ? recognizeShape(sheetPoints) : null;
    const built = shape ? buildShape(shape, chosen) : buildStroke(sheetPoints, chosen, { pressure: pointer === 'pen' });
    const done = live;
    live = null;
    if (!built) { done?.remove(); return; }
    const place = grid.placeAt(built.box.x * zoom, built.box.y * zoom);
    const title = nextName(wb.sheet(sid)?.charts, shape ? SHAPE_NAMES[shape.kind] : 'Ink');
    let id = null;
    wb.transaction(shape ? 'Ink to Shape' : 'Draw', () => {
      id = wb.addChart(sid, { type: 'image', src: svgUrl(built.svg), title, ...place, w: built.box.w, h: built.box.h, border: false,
        drawingShape: true, nativeDrawing: built.nativeDrawing });
    });
    // The finished object is drawn on the next frame; the live line stays until then so the stroke never flickers.
    requestAnimationFrame(() => requestAnimationFrame(() => done?.remove()));
    if (!id) { done?.remove(); return; }
    if (shape) announce(`Converted to ${SHAPE_NAMES[shape.kind].replace('Freeform: Shape', 'a triangle').toLowerCase()}`);
  }

  /* ---------- Eraser ---------- */

  function startErase(e, p) {
    const zoom = grid.zoom, radius = 5 / zoom;
    const targets = inkObjects().map(o => ({ id: o.id, rect: grid.chartRect(o.id), lines: inkLines(o) })).filter(t => t.rect);
    const hit = new Set();
    let last = p;
    const test = q => {
      for (const t of targets) {
        if (hit.has(t.id)) continue;
        const { left, top, width, height } = t.rect;
        if (q.x < left - 8 || q.y < top - 8 || q.x > left + width + 8 || q.y > top + height + 8) continue;
        if (touchesLines(t.lines, { x: (q.x - left) / zoom, y: (q.y - top) / zoom }, radius)) {
          hit.add(t.id);
          const node = boxOf(t.id);
          if (node) node.style.visibility = 'hidden';
        }
      }
    };
    test(p);
    const restore = () => { for (const id of hit) { const node = boxOf(id); if (node) node.style.visibility = ''; } };
    gesture = { kind: 'erase', id: e.pointerId,
      move: q => { for (const s of sweep(last, q)) test(s); last = q; },
      end: q => {
        for (const s of sweep(last, q)) test(s);
        if (hit.size) {
          const sid = grid.sheetId;
          wb.transaction(hit.size === 1 ? 'Erase ink' : 'Erase ink strokes', () => { for (const id of hit) wb.deleteChart(sid, id); });
        }
        restore();
      },
      cancel: restore };
  }

  /* ---------- Lasso Select ---------- */

  function startLasso(e, p) {
    clearLasso();
    const layer = liveLayer();
    const path = svgNode('path', { class: 'ink-lasso-line' });
    layer.append(path);
    const points = [p];
    const draw = () => path.setAttribute('d', `M${points.map(q => `${q.x} ${q.y}`).join('L')}`);
    gesture = { kind: 'lasso', id: e.pointerId,
      move: q => { points.push(q); draw(); },
      end: () => {
        live?.remove(); live = null;
        const zoom = grid.zoom;
        const ids = inkObjects().filter(o => {
          const rect = grid.chartRect(o.id);
          if (!rect) return false;
          const lines = inkLines(o).map(l => ({ ...l, points: l.points.map(q => ({ x: rect.left + q.x * zoom, y: rect.top + q.y * zoom })) }));
          return insideLasso(lines, points);
        }).map(o => o.id);
        if (ids.length === 1) { setTool(null); grid.selectChart(ids[0]); return; }
        if (ids.length) showLassoed(ids);
        announce(ids.length ? `${ids.length} ink strokes selected. Drag to move them, Delete to remove them` : 'No ink inside the lasso');
      },
      cancel: () => {} };
  }

  function lassoBox(ids) {
    const rects = ids.map(id => grid.chartRect(id)).filter(Boolean);
    if (!rects.length) return null;
    const left = Math.min(...rects.map(r => r.left)), top = Math.min(...rects.map(r => r.top));
    return { left, top, width: Math.max(...rects.map(r => r.left + r.width)) - left, height: Math.max(...rects.map(r => r.top + r.height)) - top };
  }
  function showLassoed(ids) {
    const box = lassoBox(ids);
    if (!box || !surface) return;
    const frame = el('div.ink-lasso-box', { role: 'img', 'aria-label': `${ids.length} ink strokes selected` });
    surface.append(frame);
    lassoed = { ids, box, frame };
    placeFrame();
  }
  function placeFrame(dx = 0, dy = 0) {
    if (!lassoed) return;
    const { box, frame } = lassoed;
    Object.assign(frame.style, { transform: `translate(${box.left + dx - 3}px, ${box.top + dy - 3}px)`, width: `${box.width + 6}px`, height: `${box.height + 6}px` });
  }
  function clearLasso() {
    lassoed?.frame.remove();
    lassoed = null;
  }
  const pointIn = (p, b) => p.x >= b.left - 3 && p.y >= b.top - 3 && p.x <= b.left + b.width + 3 && p.y <= b.top + b.height + 3;

  function startMoveLassoed(e, start) {
    const items = lassoed.ids.map(id => ({ id, rect: grid.chartRect(id), node: boxOf(id) })).filter(i => i.rect);
    let dx = 0, dy = 0;
    const show = () => {
      placeFrame(dx, dy);
      for (const i of items) if (i.node) i.node.style.transform = `translate(${i.rect.left + dx}px, ${i.rect.top + dy}px)`;
    };
    gesture = { kind: 'move', id: e.pointerId,
      move: q => { dx = q.x - start.x; dy = q.y - start.y; show(); },
      end: () => {
        if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
        const sid = grid.sheetId;
        wb.transaction('Move ink', () => {
          for (const i of items) wb.updateChart(sid, i.id, grid.placeAt(Math.max(0, i.rect.left + dx), Math.max(0, i.rect.top + dy)), 'Move ink');
        });
        const ids = lassoed?.ids || [];
        requestAnimationFrame(() => { if (lassoed) { lassoed.box = lassoBox(ids) || lassoed.box; placeFrame(); } });
      },
      cancel: () => { dx = dy = 0; show(); } };
  }

  function deleteLassoed() {
    const ids = lassoed?.ids || [];
    clearLasso();
    const sid = grid.sheetId;
    wb.transaction('Delete ink', () => { for (const id of ids) wb.deleteChart(sid, id); });
  }

  /* ---------- Keys: Escape leaves drawing; Delete removes lassoed ink ---------- */

  function key(e) {
    if (!tool || e.defaultPrevented || e.isComposing) return;
    if (document.querySelector('.menu, .modal-backdrop, [role="dialog"]:not([hidden])')) return;
    const target = e.target;
    if (target?.closest?.('input, textarea, select, [contenteditable="true"]') || grid.editing) return;
    if (e.key === 'Escape') {
      e.preventDefault(); e.stopPropagation();
      if (gesture) cancelGesture();
      else if (lassoed) clearLasso();
      else setTool(null);
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && lassoed) {
      e.preventDefault(); e.stopPropagation();
      deleteLassoed();
    }
  }
  document.addEventListener('keydown', key, true);

  // Another sheet: the layer follows (a chart sheet has none), and a lasso choice on the sheet left is let go.
  const unsubscribe = subscribe?.(() => {
    if (grid.sheetId !== shownSheet) { shownSheet = grid.sheetId; cancelGesture(); clearLasso(); attach(); }
    else if (lassoed && lassoed.ids.some(id => !wb.chartById(grid.sheetId, id))) clearLasso();
  });

  /* ---------- Pen menus ---------- */

  function anchorFor(id) { return document.querySelector(`.ribbon [data-ink-pen="${attr(id)}"]`); }

  function update(id, patch) {
    const i = pens.findIndex(p => p.id === id);
    if (i < 0) return;
    pens[i] = { ...pens[i], ...patch };
    save(); notify();
  }

  function openPenMenu(id, anchor = anchorFor(id)) {
    const p = pen(id);
    if (!p) return null;
    const widths = p.kind === 'highlighter' ? HIGHLIGHTER_WIDTHS : PEN_WIDTHS;
    const colors = p.kind === 'highlighter' ? HIGHLIGHTER_COLORS : PEN_COLORS;
    const style = penStyle(p);
    let menu = null;
    const pick = patch => { menu?.close(); update(id, patch); };
    const thickness = el('div.ink-widths', { role: 'group', 'aria-label': 'Thickness' }, ...widths.map(mm => el('button.ink-width', {
      type: 'button', role: 'menuitemradio', 'aria-checked': String(p.width === mm), 'aria-label': `${mm} mm`, title: `${mm} mm`,
      onclick: () => pick({ width: mm }),
      html: `<svg viewBox="0 0 40 20" width="40" height="20" aria-hidden="true"><path d="M5 13c6-8 12-8 15-3s9 5 15-3" fill="none" stroke="${p.color}" stroke-opacity="${style.opacity}" stroke-width="${Math.min(12, Math.max(0.75, mm * MM_PX))}" stroke-linecap="${p.kind === 'highlighter' ? 'butt' : 'round'}"/></svg>`,
    })));
    const swatches = el('div.swatches', { role: 'group', 'aria-label': 'Colors', 'data-cols': 6 }, ...colors.map(([hex, name]) => el('button.swatch', {
      type: 'button', role: 'menuitemradio', 'aria-checked': String(p.color === hex), 'aria-label': name, title: name, style: { background: hex },
      onclick: () => pick({ color: hex }),
    })));
    const extra = customColorRows({ current: p.color, label: `${KIND_LABELS[p.kind].toLowerCase()} color`, onPick: hex => pick({ color: hex }) });
    menu = openMenu({ anchor, label: penLabel(p), minWidth: 236, items: [
      { header: 'Thickness' }, { custom: thickness },
      { header: 'Colors' }, { custom: swatches }, ...extra.map(custom => ({ custom })),
      ...(pens.length > 1 ? [{ separator: true }, { label: 'Delete Pen', icon: 'deleteItem', onSelect: () => removePen(id) }] : []),
    ] });
    (swatches.querySelector('[aria-checked="true"]') || thickness.querySelector('[aria-checked="true"]') || swatches.querySelector('button'))?.focus();
    return menu;
  }

  function addPen(kind) {
    if (!PEN_KINDS.includes(kind) || pens.length >= MAX_PENS) return null;
    let n = pens.length + 1;
    while (pens.some(p => p.id === `pen-${n}`)) n++;
    const p = { id: `pen-${n}`, kind, color: kind === 'highlighter' ? '#00ff00' : kind === 'pencil' ? '#000000' : '#0063b1', width: kind === 'highlighter' ? 6 : kind === 'pencil' ? 1 : 0.5 };
    pens.push(p);
    save();
    setTool(p.id);
    return p.id;
  }

  function removePen(id) {
    if (pens.length <= 1) return;
    pens = pens.filter(p => p.id !== id);
    save();
    if (tool === id) setTool(null); else notify();
  }

  /** The commands the ribbon and menus run. */
  function command(cmd, arg) {
    switch (cmd) {
      case 'drawTool':
        // A second press on the chosen pen opens its thickness and colours, as the ribbon's pens do.
        if (pen(arg) && tool === arg) { openPenMenu(arg); return; }
        setTool(arg ?? null);
        return;
      case 'drawPenMenu': openPenMenu(arg); return;
      case 'drawAddPen': addPen(arg); return;
      case 'drawInkToShape':
        inkToShape = !inkToShape;
        announce(inkToShape ? 'Ink to Shape on: shapes you draw become clean shapes' : 'Ink to Shape off');
        if (inkToShape && !pen(tool)) setTool(pens.find(p => p.kind !== 'highlighter')?.id || pens[0].id);
        notify();
        return;
      case 'drawTouch':
        touch = !touch;
        if (touch && !tool) setTool(pens[0].id);
        surface?.classList.toggle('ink-touch', touch);
        notify();
        return;
    }
  }

  return {
    get tool() { return tool; },
    get pens() { return pens.map(p => ({ ...p })); },
    get inkToShape() { return inkToShape; },
    get touch() { return touch; },
    get lassoed() { return lassoed ? [...lassoed.ids] : []; },
    setTool, command, openPenMenu, addPen, removePen, deleteLassoed,
    destroy() { cancelGesture(); surface?.remove(); surface = null; document.removeEventListener('keydown', key, true); unsubscribe?.(); },
  };
}

/* ---------- The Draw tab's groups (read by ribbon.js) ---------- */

const editing = ctx => !!ctx?.flags?.()?.editing;
const tool = (label, glyph, arg, isChecked) => ({ label, glyph, ariaLabel: label, large: true,
  resolve: (menus, ctx) => ({ label, cmd: 'drawTool', arg, disabled: !ctx?.ink || editing(ctx), checked: ctx?.ink ? isChecked(ctx.ink) : false }) });
const toggle = (label, glyph, cmd, key) => ({ label, glyph, ariaLabel: label, large: true,
  resolve: (menus, ctx) => ({ label, cmd, disabled: !ctx?.ink || editing(ctx), checked: !!ctx?.ink?.[key] }) });

/** A pen slot: the ribbon has room for every pen there can be; slots without a pen are hidden. */
const penSlot = i => ({ label: `Pen ${i + 1}`, glyph: 'inkPen', ariaLabel: `Pen ${i + 1}`, large: true,
  resolve: (menus, ctx) => {
    const p = ctx?.ink?.pens[i];
    return p ? { label: penLabel(p), cmd: 'drawTool', arg: p.id, disabled: editing(ctx), checked: ctx.ink.tool === p.id } : { label: `Pen ${i + 1}`, disabled: true };
  },
  decorate: (button, item, ctx) => {
    const p = ctx?.ink?.pens[i];
    button.hidden = !p;
    button.querySelector('.ribbon-button-label')?.setAttribute('hidden', '');
    if (!p) { delete button.dataset.inkPen; return; }
    button.dataset.inkPen = p.id;
    button.classList.add('ink-pen-button');
    if (button.dataset.inkKind !== p.kind) {
      button.dataset.inkKind = p.kind;
      button.querySelector('svg')?.remove();
      button.insertAdjacentHTML('afterbegin', icon(KIND_GLYPHS[p.kind], 32));
    }
    button.style.setProperty('--pen-color', p.color);
    const label = penLabel(p);
    button.setAttribute('aria-label', label);
    button.title = ctx.ink.tool === p.id ? `${label} (press again for thickness and color)` : label;
  } });

export function drawRibbonGroups() {
  return [
    ['Drawing Tools',
      tool('Select', 'inkSelect', 'select', ink => !ink.tool),
      tool('Lasso Select', 'lasso', 'lasso', ink => ink.tool === 'lasso'),
      tool('Eraser', 'inkEraser', 'eraser', ink => ink.tool === 'eraser'),
      ...Array.from({ length: MAX_PENS }, (_, i) => penSlot(i)),
      { label: 'Add Pen', glyph: 'addPen', ariaLabel: 'Add Pen', large: true, resolve: (menus, ctx) => ({ label: 'Add Pen', disabled: !ctx?.ink || editing(ctx),
        submenu: PEN_KINDS.map(kind => ({ label: KIND_LABELS[kind], icon: KIND_GLYPHS[kind], cmd: 'drawAddPen', arg: kind, disabled: !ctx?.ink || ctx.ink.pens.length >= MAX_PENS })) }) }],
    ['Touch', toggle('Draw with Touch', 'drawTouch', 'drawTouch', 'touch')],
    ['Convert', toggle('Ink to Shape', 'inkToShape', 'drawInkToShape', 'inkToShape')],
  ];
}
