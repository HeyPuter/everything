/**
 * The drawing surface over the document's pages: routes pen, mouse and touch input (Pointer Events,
 * with pressure where the device reports it) to the active Draw tool, and paints live ink at display
 * rate on overlay canvases laid over the page canvases, then hands each finished gesture to the Draw
 * tab to commit. It also holds the on-page ruler. Nothing here changes the document.
 *
 * Overlay layers per page: strokes standing in for hidden drawings (being erased, moved or replayed),
 * strokes waiting to be committed, the stroke being drawn, the lasso loop and the selection frame.
 */
import { el, isComposing } from '../ui/dom.js';
import { filterPoints, strokeOutline, rulerEdge, snapToEdge, unionBounds, strokeBounds, widthAt } from '../engine/ink-geometry.js';

const TAU = Math.PI * 2;
const RULER_LENGTH = 560, RULER_THICKNESS = 64;

/** Fill a stroke's outline on a 2D context (page pixel coordinates). */
export function paintStroke(ctx, stroke, { alpha = 1, glow = null } = {}) {
  const outline = strokeOutline(stroke);
  if (outline.length < 3) return;
  const path = new Path2D();
  path.moveTo(outline[0].x, outline[0].y);
  for (const p of outline.slice(1)) path.lineTo(p.x, p.y);
  path.closePath();
  ctx.save();
  if (glow) { ctx.strokeStyle = glow; ctx.lineWidth = 4; ctx.lineJoin = 'round'; ctx.stroke(path); }
  ctx.globalAlpha = alpha * (stroke.tool === 'highlighter' ? 0.5 : stroke.tool === 'pencil' ? 0.85 : 1);
  ctx.fillStyle = `#${stroke.color}`;
  ctx.fill(path);
  ctx.restore();
}

export function createDrawSurface({ editor, handlers }) {
  let mode = null, touch = true, attached = null, frame = 0, current = null, penUntil = 0;
  const pending = new Map(), scenes = new Map();
  let lasso = null, selection = null, cursor = null, eraserRadius = 6, rulerState = null;
  const layer = el('div.draw-layer', { 'aria-hidden': 'true' });
  const overlays = new Map();
  const abort = new AbortController();

  /* ---- Geometry ---- */
  const engine = () => editor();
  const pageCanvas = (e, page = null) => {
    const ed = engine(); if (!ed) return null;
    if (page !== null) return ed.canvases?.[page] || null;
    const target = e.target?.closest?.('canvas.canvas-page');
    return target && ed.pages.contains(target) ? target : null;
  };
  const toPage = (e, canvas) => { const r = canvas.getBoundingClientRect(), zoom = engine().zoom || 1; return { x: (e.clientX - r.left) / zoom, y: (e.clientY - r.top) / zoom }; };
  const pressure = e => e.pointerType === 'pen' && e.pressure > 0 ? e.pressure : 0.5;

  /* ---- Overlays ---- */
  function overlay(page) {
    const ed = engine(), canvas = ed?.canvases?.[page]; if (!canvas) return null;
    let node = overlays.get(page);
    if (!node) { node = el('canvas.draw-overlay'); overlays.set(page, node); layer.append(node); }
    const ratio = window.devicePixelRatio || 1, width = canvas.offsetWidth, height = canvas.offsetHeight;
    Object.assign(node.style, { left: `${canvas.offsetLeft}px`, top: `${canvas.offsetTop}px`, width: `${width}px`, height: `${height}px` });
    if (node.width !== Math.round(width * ratio) || node.height !== Math.round(height * ratio)) { node.width = Math.round(width * ratio); node.height = Math.round(height * ratio); }
    return node;
  }
  /** Repaint every overlay that has anything to show; clear the rest. */
  function render() {
    frame = 0;
    const ed = engine(); if (!ed) return;
    const zoom = ed.zoom || 1, ratio = window.devicePixelRatio || 1;
    const pages = new Set([...pending.keys(), ...scenes.keys(), ...overlays.keys()]);
    if (current?.page != null) pages.add(current.page);
    if (lasso) pages.add(lasso.page); if (selection) pages.add(selection.page); if (cursor) pages.add(cursor.page);
    for (const page of pages) {
      const node = overlay(page); if (!node) continue;
      const ctx = node.getContext('2d');
      ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, node.width, node.height);
      ctx.setTransform(zoom * ratio, 0, 0, zoom * ratio, 0, 0);
      // Highlighter ink multiplies with the page beneath; it is drawn on its own blended layer.
      node.classList.toggle('has-highlighter', [...(scenes.get(page) || []), ...(pending.get(page) || []), ...(current?.page === page && current.stroke ? [current.stroke] : [])].some(s => s.tool === 'highlighter'));
      for (const stroke of scenes.get(page) || []) paintStroke(ctx, stroke, { alpha: stroke.alpha ?? 1 });
      for (const stroke of pending.get(page) || []) paintStroke(ctx, stroke);
      if (current?.page === page && current.stroke) paintStroke(ctx, current.stroke);
      if (selection?.page === page) paintSelection(ctx, selection, zoom);
      if (lasso?.page === page && lasso.polygon.length > 1) paintLasso(ctx, lasso.polygon, zoom);
      if (cursor?.page === page) { ctx.beginPath(); ctx.arc(cursor.x, cursor.y, cursor.r, 0, TAU); ctx.lineWidth = 1 / zoom; ctx.strokeStyle = '#3b6fd6'; ctx.fillStyle = 'rgba(59,111,214,.08)'; ctx.fill(); ctx.stroke(); }
    }
  }
  const schedule = () => { if (!frame) frame = requestAnimationFrame(render); };
  function paintLasso(ctx, polygon, zoom) {
    ctx.save(); ctx.beginPath(); ctx.moveTo(polygon[0].x, polygon[0].y); for (const p of polygon.slice(1)) ctx.lineTo(p.x, p.y);
    ctx.setLineDash([5 / zoom, 4 / zoom]); ctx.lineWidth = 1.25 / zoom; ctx.strokeStyle = '#3b6fd6'; ctx.stroke();
    ctx.fillStyle = 'rgba(59,111,214,.06)'; ctx.fill(); ctx.restore();
  }
  function paintSelection(ctx, sel, zoom) {
    for (const stroke of sel.strokes) paintStroke(ctx, { ...stroke, color: '3B6FD6', width: widthAt(stroke.width, 0.5, stroke.tool) + 3 / zoom, tool: 'highlighter' }, { alpha: 0.5 });
    const b = sel.bounds;
    ctx.save(); ctx.setLineDash([4 / zoom, 3 / zoom]); ctx.lineWidth = 1 / zoom; ctx.strokeStyle = '#3b6fd6';
    ctx.strokeRect(b.left - 4, b.top - 4, b.width + 8, b.height + 8); ctx.restore();
  }

  /* ---- Ruler ---- */
  const rulerNode = el('div.draw-ruler', { tabindex: 0, role: 'slider', 'aria-label': 'Ruler', 'aria-valuemin': 0, 'aria-valuemax': 359, hidden: true, title: 'Drag to move · scroll or Alt+arrow keys to turn · two fingers turn on touch' });
  const rulerScale = el('canvas.draw-ruler-scale', { 'aria-hidden': 'true' });
  const rulerAngle = el('span.draw-ruler-angle', { 'aria-hidden': 'true' });
  rulerNode.append(rulerScale, rulerAngle);
  layer.append(rulerNode);
  function placeRuler() {
    if (!rulerState) { rulerNode.hidden = true; return; }
    const { x, y, angle } = rulerState, degrees = Math.round(((angle * 180 / Math.PI) % 360 + 360) % 360);
    Object.assign(rulerNode.style, { left: `${x - RULER_LENGTH / 2}px`, top: `${y - RULER_THICKNESS / 2}px`, width: `${RULER_LENGTH}px`, height: `${RULER_THICKNESS}px`, transform: `rotate(${angle}rad)` });
    rulerNode.hidden = false;
    rulerNode.setAttribute('aria-valuenow', String(degrees)); rulerNode.setAttribute('aria-valuetext', `${degrees} degrees`);
    rulerAngle.textContent = `${degrees}°`;
    rulerAngle.style.transform = `translate(-50%, -50%) rotate(${-angle}rad)`;
    drawScale();
  }
  function drawScale() {
    const zoom = engine()?.zoom || 1, ratio = window.devicePixelRatio || 1;
    const key = `${zoom}:${ratio}`; if (rulerScale.dataset.key === key) return; rulerScale.dataset.key = key;
    rulerScale.width = RULER_LENGTH * ratio; rulerScale.height = RULER_THICKNESS * ratio;
    const ctx = rulerScale.getContext('2d'); ctx.scale(ratio, ratio);
    ctx.strokeStyle = 'rgba(32,33,36,.75)'; ctx.fillStyle = 'rgba(32,33,36,.8)'; ctx.lineWidth = 1; ctx.font = '9px system-ui, sans-serif'; ctx.textAlign = 'center';
    // Inch marks at the document's zoom: a long tick per inch, shorter ones per half, quarter and eighth.
    const inch = 96 * zoom, count = Math.floor(RULER_LENGTH / (inch / 8));
    for (let i = 0; i <= count; i++) {
      const x = 8 + i * inch / 8; if (x > RULER_LENGTH - 8) break;
      const size = i % 8 === 0 ? 14 : i % 4 === 0 ? 10 : i % 2 === 0 ? 7 : 4;
      ctx.beginPath(); ctx.moveTo(Math.round(x) + .5, 0); ctx.lineTo(Math.round(x) + .5, size); ctx.moveTo(Math.round(x) + .5, RULER_THICKNESS); ctx.lineTo(Math.round(x) + .5, RULER_THICKNESS - size); ctx.stroke();
      if (i % 8 === 0 && i) ctx.fillText(String(i / 8), x, 25);
    }
  }
  function showRuler(visible) {
    const ed = engine(); if (!ed) return;
    if (!visible) { rulerState = null; placeRuler(); return; }
    const host = ed.host;
    rulerState = rulerState || { x: host.scrollLeft + host.clientWidth / 2, y: host.scrollTop + host.clientHeight / 2, angle: -Math.PI / 12 };
    placeRuler();
  }
  /** The ruler in a page's coordinates, for snapping strokes on that page. */
  function rulerOnPage(canvas) {
    if (!rulerState) return null;
    const zoom = engine().zoom || 1;
    return { x: (rulerState.x - canvas.offsetLeft) / zoom, y: (rulerState.y - canvas.offsetTop) / zoom, angle: rulerState.angle, length: RULER_LENGTH / zoom, thickness: RULER_THICKNESS / zoom };
  }
  const rulerPointers = new Map();
  let rulerGesture = null;
  rulerNode.addEventListener('pointerdown', e => {
    e.preventDefault(); e.stopPropagation(); rulerNode.focus({ preventScroll: true });
    rulerNode.setPointerCapture(e.pointerId);
    rulerPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    rulerGesture = { start: { ...rulerState }, pointers: new Map([...rulerPointers].map(([id, p]) => [id, { ...p }])) };
  });
  rulerNode.addEventListener('pointermove', e => {
    if (!rulerPointers.has(e.pointerId) || !rulerGesture) return;
    rulerPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const ids = [...rulerGesture.pointers.keys()].filter(id => rulerPointers.has(id));
    if (ids.length >= 2) {
      // Two fingers: the ruler turns with the line between them and follows their midpoint.
      const [a0, b0] = ids.slice(0, 2).map(id => rulerGesture.pointers.get(id)), [a1, b1] = ids.slice(0, 2).map(id => rulerPointers.get(id));
      const turn = Math.atan2(b1.y - a1.y, b1.x - a1.x) - Math.atan2(b0.y - a0.y, b0.x - a0.x);
      rulerState = { ...rulerGesture.start, angle: rulerGesture.start.angle + turn, x: rulerGesture.start.x + ((a1.x + b1.x) - (a0.x + b0.x)) / 2, y: rulerGesture.start.y + ((a1.y + b1.y) - (a0.y + b0.y)) / 2 };
    } else {
      const p0 = rulerGesture.pointers.get(ids[0]), p1 = rulerPointers.get(ids[0]);
      rulerState = { ...rulerGesture.start, x: rulerGesture.start.x + p1.x - p0.x, y: rulerGesture.start.y + p1.y - p0.y };
    }
    placeRuler();
  });
  const endRulerPointer = e => { rulerPointers.delete(e.pointerId); rulerGesture = rulerPointers.size ? { start: { ...rulerState }, pointers: new Map([...rulerPointers].map(([id, p]) => [id, { ...p }])) } : null; };
  rulerNode.addEventListener('pointerup', endRulerPointer); rulerNode.addEventListener('pointercancel', endRulerPointer);
  rulerNode.addEventListener('wheel', e => { e.preventDefault(); const step = (e.shiftKey ? 1 : 5) * Math.PI / 180; rulerState = { ...rulerState, angle: rulerState.angle + Math.sign(e.deltaY || e.deltaX) * step }; placeRuler(); }, { passive: false });
  rulerNode.addEventListener('keydown', e => {
    if (isComposing(e) || !rulerState) return;
    const turn = { ArrowLeft: -1, ArrowRight: 1 }[e.key], move = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
    if (e.altKey && turn) rulerState = { ...rulerState, angle: rulerState.angle + turn * (e.shiftKey ? 15 : 1) * Math.PI / 180 };
    else if (move) rulerState = { ...rulerState, x: rulerState.x + move[0] * (e.shiftKey ? 40 : 8), y: rulerState.y + move[1] * (e.shiftKey ? 40 : 8) };
    else if (e.key === 'Escape') { engine()?.focus(); }
    else return;
    e.preventDefault(); e.stopPropagation(); placeRuler();
  });

  /* ---- Input ---- */
  const wantsPointer = e => {
    if (!mode) return false;
    if (e.pointerType === 'touch') { if (!touch || Date.now() < penUntil) return false; }
    if (e.pointerType === 'pen') penUntil = Date.now() + 600;
    return e.button === 0 || e.pointerType === 'pen' && e.button === -1 || e.pointerType === 'touch';
  };
  function down(e) {
    if (!wantsPointer(e)) return;
    const canvas = pageCanvas(e); if (!canvas) return;
    // A pen coming down cancels a touch stroke already started by the hand resting on the screen.
    if (current && current.type === 'touch' && e.pointerType === 'pen') { current = null; }
    if (current) { e.preventDefault(); e.stopPropagation(); return; }
    e.preventDefault(); e.stopPropagation();
    const page = Number(canvas.dataset.page), point = { ...toPage(e, canvas), p: pressure(e) };
    engine().pages.setPointerCapture?.(e.pointerId);
    current = { pointerId: e.pointerId, type: e.pointerType, page, canvas, raw: [point], start: point, mode };
    if (mode === 'pen') {
      const ruler = rulerOnPage(canvas), edge = ruler && rulerEdge(ruler, point, 28 / (engine().zoom || 1));
      current.edge = edge;
      current.stroke = handlers.strokeStyle?.() ? { ...handlers.strokeStyle(), points: [point] } : null;
      handlers.strokeStart?.(current);
    } else if (mode === 'eraser') handlers.eraseStart?.(page, point);
    else if (mode === 'lasso') {
      if (selection && selection.page === page && inside(selection.bounds, point)) current.moving = true;
      else { lasso = { page, polygon: [point] }; handlers.lassoStart?.(); }
    }
    schedule();
  }
  const inside = (b, p, pad = 6) => p.x >= b.left - pad && p.x <= b.right + pad && p.y >= b.top - pad && p.y <= b.bottom + pad;
  function move(e) {
    if (!current) {
      // Eraser hover: show its size under the pointer.
      if (mode === 'eraser' && e.pointerType !== 'touch') {
        const canvas = pageCanvas(e);
        cursor = canvas ? { page: Number(canvas.dataset.page), ...toPage(e, canvas), r: eraserRadius } : null; schedule();
      }
      return;
    }
    if (e.pointerId !== current.pointerId) { e.stopPropagation(); return; }
    e.preventDefault(); e.stopPropagation();
    const samples = e.getCoalescedEvents?.().length ? e.getCoalescedEvents() : [e];
    for (const sample of samples) {
      const point = { ...toPage(sample, current.canvas), p: pressure(sample) };
      const previous = current.raw.at(-1);
      current.raw.push(point);
      if (current.mode === 'pen' && current.stroke) {
        const filtered = filterPoints(current.raw);
        current.stroke.points = current.edge ? snapToEdge(filtered, current.edge, current.stroke.width / 2) : filtered;
      } else if (current.mode === 'eraser') { cursor = { page: current.page, ...point, r: eraserRadius }; handlers.eraseMove?.(current.page, previous, point); }
      else if (current.mode === 'lasso') {
        if (current.moving) handlers.selectionDrag?.(point.x - current.start.x, point.y - current.start.y);
        else lasso?.polygon.push(point);
      }
    }
    schedule();
  }
  function up(e) {
    if (!current || e.pointerId !== current.pointerId) return;
    e.preventDefault(); e.stopPropagation();
    const gesture = current; current = null;
    if (e.type === 'pointercancel') { if (gesture.mode === 'pen') handlers.strokeCancel?.(); if (gesture.mode === 'lasso') lasso = null; render(); return; }
    if (gesture.mode === 'pen' && gesture.stroke) {
      const stroke = gesture.stroke;
      if (stroke.points.length) { add(pending, gesture.page, stroke); handlers.strokeEnd?.(gesture.page, stroke); }
    } else if (gesture.mode === 'eraser') handlers.eraseEnd?.(gesture.page);
    else if (gesture.mode === 'lasso') {
      if (gesture.moving) handlers.selectionDrop?.(gesture.raw.at(-1).x - gesture.start.x, gesture.raw.at(-1).y - gesture.start.y);
      else { const polygon = lasso?.polygon || []; lasso = null; handlers.lassoEnd?.(gesture.page, polygon); }
    }
    render();
    engine()?.focus();
  }
  const add = (map, page, stroke) => { if (!map.has(page)) map.set(page, []); map.get(page).push(stroke); };
  const swallow = e => { if (mode && current) { e.preventDefault(); e.stopPropagation(); } };

  function attach() {
    const ed = engine(); if (!ed || attached === ed) return;
    detach();
    attached = ed;
    const options = { capture: true, signal: abort.signal };
    ed.pages.addEventListener('pointerdown', down, options);
    ed.pages.addEventListener('pointermove', move, options);
    ed.pages.addEventListener('pointerup', up, options);
    ed.pages.addEventListener('pointercancel', up, options);
    ed.pages.addEventListener('click', swallow, options);
    ed.pages.addEventListener('pointerleave', () => { if (cursor && !current) { cursor = null; schedule(); } }, { signal: abort.signal });
    ed.host.append(layer);
    applyMode();
  }
  function detach() {
    if (!attached) return;
    attached.pages.removeEventListener('pointerdown', down, true);
    attached.pages.removeEventListener('pointermove', move, true);
    attached.pages.removeEventListener('pointerup', up, true);
    attached.pages.removeEventListener('pointercancel', up, true);
    attached.pages.removeEventListener('click', swallow, true);
    attached.pages.classList.remove('is-inking', 'is-erasing', 'is-lassoing', 'draws-with-touch');
    attached = null;
  }
  function applyMode() {
    const ed = engine(); if (!ed) return;
    ed.pages.classList.toggle('is-inking', mode === 'pen');
    ed.pages.classList.toggle('is-erasing', mode === 'eraser');
    ed.pages.classList.toggle('is-lassoing', mode === 'lasso');
    ed.pages.classList.toggle('draws-with-touch', !!mode && touch);
  }

  return {
    layer,
    attach,
    get mode() { return mode; },
    setMode(next) {
      attach();
      if (current) { if (current.mode === 'pen') handlers.strokeCancel?.(); current = null; }
      mode = next; cursor = null; lasso = null;
      applyMode(); render();
    },
    get touch() { return touch; },
    setTouch(value) { touch = !!value; applyMode(); },
    setEraserRadius(r) { eraserRadius = r; },
    get drawing() { return !!current; },
    /** Strokes drawn but not yet in the document. */
    settle(page, stroke) { const list = pending.get(page); if (list) { const i = list.indexOf(stroke); if (i >= 0) list.splice(i, 1); if (!list.length) pending.delete(page); } render(); },
    /** Strokes painted on the overlay in place of hidden drawings: page → strokes. */
    setScene(page, strokes) { if (strokes?.length) scenes.set(page, strokes); else scenes.delete(page); schedule(); },
    clearScenes() { scenes.clear(); render(); },
    setSelection(next) { selection = next ? { ...next, bounds: unionBounds(next.strokes.map(strokeBounds)) } : null; render(); },
    get selection() { return selection; },
    rulerVisible: () => !!rulerState,
    showRuler,
    render, schedule,
    reposition() { placeRuler(); render(); },
    destroy() { detach(); abort.abort(); if (frame) cancelAnimationFrame(frame); layer.remove(); },
  };
}
