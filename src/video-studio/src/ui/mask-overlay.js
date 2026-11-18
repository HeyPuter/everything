/**
 * On-canvas mask editor, shown over the selected clip in the player while
 * the Mask panel is open. Draws the selected mask's outline (others faintly)
 * through the clip's crop, flip and transform and the player's zoom and pan,
 * with handles to move, resize, rotate and feather it, shape handles (round
 * corners, star inner radius), pen points and bezier handles (click the
 * outline to add a point, double-click a point to delete it, Alt-click to
 * toggle a curve, Delete removes the selected point), click-to-place pen
 * drawing and brush painting. Edits go through the undoable store; a drag is
 * one undo step and keyed values get a key at the playhead.
 */
import '../styles/masks.css';
import { US } from '../lib/time.js';
import { announce } from '../lib/dom.js';
import { setMaskValues, fitPathBox, MASK_KEYED, maskProp } from '../model/masks.js';
import {
  maskOutline, maskHalf, maskToSource, sourceToMask, sourceToProject, projectToSource, starPoints, samplePath,
  nearestOnPolygon, insertPathPoint, clipLine,
} from '../engine/mask-shapes.js';
import { featherSigma } from '../engine/mask-raster.js';
import { maskEdit } from './mask-edit-state.js';
import { brushCursor } from './brush-preview.js';

const NS = 'http://www.w3.org/2000/svg';
const ROTATE_GAP = 26;
const FEATHER_GAP = 16;
const CLOSE_PX = 10;

function svg(tag, attrs = {}) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== null && v !== undefined) el.setAttribute(k, String(v));
  return el;
}

const pathD = (pts, closed = true) => (pts.length ? `M${pts.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('L')}${closed ? 'Z' : ''}` : '');

export function createMaskOverlay({ store, actions, stage }) {
  const root = svg('svg', { class: 'mask-svg', 'aria-hidden': 'true' });
  let cur = null; // { layer, box, k, SW, SH, m, i, geo }
  let drag = null;
  let lastPoint = null;

  const local = () => {
    const c = cur?.layer.clip;
    return c ? Math.round(store.time - c.start) : 0;
  };
  const tol = () => Math.round(US / store.fps / 2);
  const clipNow = () => {
    const id = cur?.layer.clip.id;
    for (const t of store.project.tracks) for (const c of t.clips) if (c.id === id) return c;
    return null;
  };

  /** Mapping helpers for the current draw. */
  function geometry(layer, box, k) {
    const SW = layer.width || 1;
    const SH = layer.height || 1;
    const srcToCss = (sx, sy) => {
      const [px, py] = sourceToProject(layer, box, SW, SH, sx, sy);
      return [px * k, py * k];
    };
    const cssToSrc = (cx, cy) => projectToSource(layer, box, SW, SH, cx / k, cy / k);
    return { SW, SH, srcToCss, cssToSrc };
  }

  function edit(label, patch, coalesce) {
    const i = cur.i;
    const t = local();
    actions.editClip(cur.layer.clip.id, label, (c) => setMaskValues(c, i, patch, t, tol()), coalesce ? { coalesce } : {});
  }

  /** End pen drawing; an unkeyed path gets its box fitted to it. */
  function closePath() {
    maskEdit.set({ drawing: false, point: -1 });
    const c = clipNow();
    const raw = c?.masks?.[cur.i];
    if (!raw || raw.type !== 'pen' || raw.path.length < 3) return;
    if (MASK_KEYED.some((k) => c.keyframes?.[maskProp(cur.i, k)]?.length)) return;
    const fit = fitPathBox(raw, cur.SW, cur.SH);
    actions.editClip(c.id, 'Close mask path', (clip) => {
      if (clip.masks?.[cur.i]) Object.assign(clip.masks[cur.i], { x: fit.x, y: fit.y, w: fit.w, h: fit.h, path: fit.path });
    });
    store.seal();
  }

  function rawMask() {
    return clipNow()?.masks?.[cur.i] || null;
  }

  // --- Drawing ----------------------------------------------------------------
  function draw(layer, box, k, cssW, cssH) {
    const i = Math.min(maskEdit.index, layer.masks.length - 1);
    const m = layer.masks[i];
    const g = geometry(layer, box, k);
    cur = { layer, box, k, i, m, ...g };
    root.setAttribute('width', cssW);
    root.setAttribute('height', cssH);
    root.setAttribute('viewBox', `0 0 ${cssW} ${cssH}`);
    root.classList.toggle('drawing', m.type === 'pen' && maskEdit.drawing);
    root.classList.toggle('painting', m.type === 'brush');
    const { SW, SH, srcToCss } = g;
    const L = (lx, ly, mm = m) => {
      const [sx, sy] = maskToSource(mm, SW, SH, lx, ly);
      return srcToCss(sx, sy);
    };
    const kids = [];
    // Clip bounds; dragging inside moves the mask (or paints / places points).
    const clipPoly = [[0, 0], [SW, 0], [SW, SH], [0, SH]].map(([x, y]) => {
      const crop = layer.crop || { l: 0, t: 0, r: 0, b: 0 };
      return srcToCss(crop.l * SW + (x / SW) * (1 - crop.l - crop.r) * SW, crop.t * SH + (y / SH) * (1 - crop.t - crop.b) * SH);
    });
    const catchMode = m.type === 'brush' ? 'paint' : m.type === 'pen' && maskEdit.drawing ? 'place' : 'move';
    kids.push(svg('path', { class: `mask-clip-bounds catch-${catchMode}`, d: pathD(clipPoly), 'data-mh': catchMode }));
    // Other masks, faint.
    layer.masks.forEach((o, j) => {
      if (j === i || o.hidden) return;
      for (const d of outlinePaths(o, L)) kids.push(svg('path', { class: 'mask-outline other', d: d.d }));
    });
    const { a, b } = maskHalf(m, SW, SH);
    const outlines = outlinePaths(m, L);
    for (const d of outlines) {
      kids.push(svg('path', { class: `mask-outline${m.invert ? ' inverted' : ''}`, d: d.d }));
      if (d.hit) kids.push(svg('path', { class: 'mask-hit', d: d.d, 'data-mh': m.type === 'pen' && !maskEdit.drawing ? 'segment' : 'move' }));
    }
    const handle = (name, [x, y], cls = '', extra = {}) => kids.push(svg('circle', { class: `mask-handle ${cls}`, cx: x, cy: y, r: cls.includes('small') ? 4 : 5.5, 'data-mh': name, ...extra }));
    const cssDir = (lx, ly, dx, dy) => {
      const p0 = L(lx, ly);
      const p1 = L(lx + dx, ly + dy);
      const len = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) || 1;
      return [(p1[0] - p0[0]) / len, (p1[1] - p0[1]) / len];
    };
    const off = (p, d, gap) => [p[0] + d[0] * gap, p[1] + d[1] * gap];
    const center = L(0, 0);
    // Rotate and feather handles go on a side that is in view (the stage clips the rest).
    const rr = root.getBoundingClientRect();
    const sr = stage?.getBoundingClientRect();
    const inView = ([x, y]) => !sr || !sr.width || (x >= sr.left - rr.left + 8 && x <= sr.right - rr.left - 8 && y >= sr.top - rr.top + 8 && y <= sr.bottom - rr.top - 8);
    const pick = (options) => options.find((o) => inView(o.at)) || options[0];
    const sig = featherSigma(m, SW, SH);
    const featherHandle = (edge, dirs) => {
      const f = pick(dirs.map(([dx, dy]) => {
        const e = [dx * edge, dy * edge];
        return { dx, dy, from: L(...e), at: off(L(e[0] + dx * 2 * sig, e[1] + dy * 2 * sig), cssDir(e[0], e[1], dx, dy), FEATHER_GAP) };
      }));
      kids.push(svg('line', { class: 'mask-arm', x1: f.from[0], y1: f.from[1], x2: f.at[0], y2: f.at[1] }));
      handle('feather', f.at, 'feather', { 'data-dx': f.dx, 'data-dy': f.dy });
    };
    const lineish = m.type === 'split' || m.type === 'band';
    const drawingPen = m.type === 'pen' && maskEdit.drawing;
    if (!drawingPen) {
      if (lineish) {
        const reach = Math.min(SW, SH) * 0.3;
        const rotAt = pick([{ at: L(reach, 0) }, { at: L(-reach, 0) }]).at;
        kids.push(svg('line', { class: 'mask-arm', x1: center[0], y1: center[1], x2: rotAt[0], y2: rotAt[1] }));
        handle('rotate', rotAt, 'rotate');
        if (m.type === 'band') {
          handle('n', L(0, -b));
          handle('s', L(0, b));
        }
        featherHandle(m.type === 'band' ? b : 0, [[0, 1], [0, -1]]);
        handle('move', center, 'center');
      } else {
        const corners = { nw: [-a, -b], ne: [a, -b], se: [a, b], sw: [-a, b] };
        kids.push(svg('path', { class: 'mask-box', d: pathD(Object.values(corners).map(([x, y]) => L(x, y))) }));
        for (const [name, [x, y]] of Object.entries(corners)) handle(name, L(x, y), 'corner');
        for (const [name, [x, y]] of Object.entries({ n: [0, -b], e: [a, 0], s: [0, b], w: [-a, 0] })) handle(name, L(x, y), 'edge small');
        const sides = [[0, -1], [1, 0], [-1, 0], [0, 1]].map(([dx, dy]) => {
          const from = L(dx * a, dy * b);
          return { dx, dy, from, at: off(from, cssDir(dx * a, dy * b, dx, dy), ROTATE_GAP) };
        });
        const rot = pick(sides);
        kids.push(svg('line', { class: 'mask-arm', x1: rot.from[0], y1: rot.from[1], x2: rot.at[0], y2: rot.at[1] }));
        handle('rotate', rot.at, 'rotate');
        // Feather on the bottom, or the next side in view that the rotate handle does not use.
        const fDirs = [[0, 1], [1, 0], [-1, 0], [0, -1]].filter(([dx, dy]) => dx !== rot.dx || dy !== rot.dy);
        const fEdge = (dx) => (dx ? a : b);
        const f = pick(fDirs.map(([dx, dy]) => {
          const e = [dx * fEdge(dx), dy * fEdge(dx)];
          return { dx, dy, from: L(...e), at: off(L(e[0] + dx * 2 * sig, e[1] + dy * 2 * sig), cssDir(e[0], e[1], dx, dy), FEATHER_GAP) };
        }));
        kids.push(svg('line', { class: 'mask-arm', x1: f.from[0], y1: f.from[1], x2: f.at[0], y2: f.at[1] }));
        handle('feather', f.at, 'feather', { 'data-dx': f.dx, 'data-dy': f.dy });
        if (m.type === 'rectangle') {
          const r = ((m.roundness || 0) / 100) * Math.min(a, b);
          handle('round', L(a - Math.max(r, Math.min(a, b) * 0.08), -b), 'shape small');
        }
        if (m.type === 'star') {
          const [ux, uy] = starPoints(m.count || 5, m.inner ?? 0.45)[1];
          handle('inner', L(ux * a, uy * b), 'shape small');
        }
        handle('move', center, 'center');
      }
    }
    if (m.type === 'pen') penHandles(m, L, a, b, kids, handle);
    if (m.type === 'brush' && maskEdit.cursor) {
      kids.push(brushCursor(srcToCss, maskEdit.cursor, maskEdit.brush.size * Math.min(SW, SH), maskEdit.brush.erase));
    }
    root.replaceChildren(...kids);
  }

  /** Outline paths of a mask (css), with hit flags. */
  function outlinePaths(m, L) {
    const { SW, SH } = cur;
    const { a, b } = maskHalf(m, SW, SH);
    if (m.type === 'split' || m.type === 'band') {
      const out = [];
      for (const y of m.type === 'band' ? [-b, b] : [0]) {
        const p0 = maskToSource(m, SW, SH, 0, y);
        const p1 = maskToSource(m, SW, SH, 1, y);
        const seg = clipLine(p0, [p1[0] - p0[0], p1[1] - p0[1]], 0, 0, SW, SH);
        if (seg) out.push({ d: pathD(seg.map(([x, yy]) => cur.srcToCss(x, yy)), false), hit: true });
      }
      return out;
    }
    if (m.type === 'text' || m.type === 'brush') return [{ d: pathD([[-a, -b], [a, -b], [a, b], [-a, b]].map(([x, y]) => L(x, y, m))), hit: false }];
    const poly = maskOutline(m, SW, SH);
    if (!poly?.length) return [];
    return [{ d: pathD(poly.map(([x, y]) => L(x, y, m)), m.type !== 'pen' || !maskEdit.drawing), hit: true }];
  }

  function penHandles(m, L, a, b, kids, handle) {
    const path = m.path || [];
    const P = (p, dx = 0, dy = 0) => L((p.x + dx) * 2 * a, (p.y + dy) * 2 * b);
    const selPt = maskEdit.point;
    path.forEach((p, j) => {
      const near = j === selPt || j === (selPt + 1) % path.length || j === (selPt - 1 + path.length) % path.length;
      if (selPt >= 0 && near && (p.ix || p.iy || p.ox || p.oy || j === selPt)) {
        for (const [hn, dx, dy] of [['hin', p.ix, p.iy], ['hout', p.ox, p.oy]]) {
          if (!dx && !dy && j !== selPt) continue;
          const at = P(p, dx, dy);
          const pt = P(p);
          if (dx || dy) {
            kids.push(svg('line', { class: 'mask-arm', x1: pt[0], y1: pt[1], x2: at[0], y2: at[1] }));
            handle(hn, at, 'bezier small', { 'data-i': j });
          }
        }
      }
    });
    path.forEach((p, j) => {
      const cls = `point${j === selPt ? ' selected' : ''}${j === 0 && maskEdit.drawing ? ' first' : ''}`;
      kids.push(svg('rect', { class: `mask-handle ${cls}`, x: P(p)[0] - 4.5, y: P(p)[1] - 4.5, width: 9, height: 9, 'data-mh': 'point', 'data-i': j }));
    });
  }

  // --- Interaction --------------------------------------------------------------
  function pointer(e) {
    const r = root.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  /** Mask-local pixels of a css point, for the mask as it was at drag start. */
  const toLocal = (m, css) => {
    const [sx, sy] = cur.cssToSrc(css[0], css[1]);
    return sourceToMask(m, cur.SW, cur.SH, sx, sy);
  };

  root.addEventListener('pointerdown', (e) => {
    const t = e.target.closest?.('[data-mh]');
    if (!t || !cur || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    stage?.focus({ preventScroll: true });
    const kind = t.dataset.mh;
    const idx = t.dataset.i !== undefined ? Number(t.dataset.i) : -1;
    const m = { ...cur.m };
    const raw = rawMask();
    if (!raw) return;
    const p0 = pointer(e);
    const coalesce = `mask:${cur.layer.clip.id}:${kind}:${Date.now()}`;
    const { SW, SH } = cur;
    const { a, b } = maskHalf(m, SW, SH);
    const l0 = toLocal(m, p0);
    drag = { kind, idx, m, raw: structuredClone(raw), p0, l0, a, b, coalesce, moved: false, dir: [Number(t.dataset.dx || 0), Number(t.dataset.dy ?? 1)] };

    if (kind === 'point') {
      // Pointer events do not count clicks, so a second press on the same point soon after is a double-click.
      const now = performance.now();
      const dbl = lastPoint && lastPoint.idx === idx && now - lastPoint.at < 400;
      lastPoint = dbl ? null : { idx, at: now };
      if (dbl) {
        // Double-click deletes the point.
        const path = raw.path.filter((_, j) => j !== idx);
        edit('Delete mask point', { path });
        maskEdit.set({ point: -1 });
        announce('Point deleted');
        drag = null;
        store.seal();
        return;
      }
      if (maskEdit.drawing && idx === 0 && raw.path.length >= 3) {
        closePath();
        announce('Path closed');
        drag = null;
        return;
      }
      if (e.altKey) {
        // Toggle between a corner and a smooth point.
        const p = raw.path[idx];
        const n = raw.path.length;
        const path = raw.path.map((q) => ({ ...q }));
        if (p.ix || p.iy || p.ox || p.oy) Object.assign(path[idx], { ix: 0, iy: 0, ox: 0, oy: 0 });
        else {
          const prev = raw.path[(idx - 1 + n) % n];
          const next = raw.path[(idx + 1) % n];
          const tx = (next.x - prev.x) / 4;
          const ty = (next.y - prev.y) / 4;
          Object.assign(path[idx], { ix: -tx, iy: -ty, ox: tx, oy: ty });
        }
        edit('Toggle curve', { path });
        maskEdit.set({ point: idx });
        drag = null;
        store.seal();
        return;
      }
      maskEdit.set({ point: idx });
    } else if (kind === 'segment') {
      // Insert a point where the outline was clicked.
      const lp = [l0[0] / (2 * a), l0[1] / (2 * b)];
      const { pts, at } = samplePath(raw.path);
      const near = nearestOnPolygon(pts, lp);
      if (near.index >= 0) {
        const src = at[near.index];
        const nextAt = at[(near.index + 1) % at.length];
        const sameSeg = nextAt.seg === src.seg && nextAt.t > src.t;
        const t = sameSeg ? src.t + (nextAt.t - src.t) * near.t : src.t + (1 - src.t) * near.t;
        const path = insertPathPoint(raw.path, src.seg, Math.min(0.999, Math.max(0.001, t)));
        edit('Add mask point', { path }, coalesce);
        maskEdit.set({ point: src.seg + 1 });
        drag = { ...drag, kind: 'point', idx: src.seg + 1, raw: { ...raw, path } };
        announce('Point added');
      }
    } else if (kind === 'place') {
      const lp = [l0[0] / (2 * a), l0[1] / (2 * b)];
      const first = raw.path[0];
      if (first && raw.path.length >= 3) {
        const fc = cur.srcToCss(...maskToSource(m, SW, SH, first.x * 2 * a, first.y * 2 * b));
        if (Math.hypot(fc[0] - p0[0], fc[1] - p0[1]) <= CLOSE_PX) {
          closePath();
          announce('Path closed');
          drag = null;
          return;
        }
      }
      const path = [...raw.path.map((q) => ({ ...q })), { x: lp[0], y: lp[1], ix: 0, iy: 0, ox: 0, oy: 0 }];
      edit('Add mask point', { path }, coalesce);
      drag = { ...drag, idx: path.length - 1, raw: { ...raw, path } };
      maskEdit.set({ point: path.length - 1 });
    } else if (kind === 'paint') {
      const unit = Math.min(2 * a, 2 * b) || 1;
      const size = (maskEdit.brush.size * Math.min(SW, SH)) / unit;
      const lp = [l0[0] / (2 * a), l0[1] / (2 * b)];
      const strokes = [...(raw.strokes || []), { size, erase: maskEdit.brush.erase, pts: lp }];
      edit(maskEdit.brush.erase ? 'Erase mask' : 'Paint mask', { strokes }, coalesce);
      drag = { ...drag, raw: { ...raw, strokes } };
    }
    root.setPointerCapture?.(e.pointerId);
    drag.pointerId = e.pointerId;
  });

  root.addEventListener('pointermove', (e) => {
    if (cur?.m?.type === 'brush' && !drag) {
      const p = pointer(e);
      maskEdit.cursor = p;
      const c = root.querySelector('.mask-brush-cursor');
      const cursor = brushCursor(cur.srcToCss, p, maskEdit.brush.size * Math.min(cur.SW, cur.SH), maskEdit.brush.erase, c);
      if (!c) root.append(cursor);
    }
    if (!drag || e.pointerId !== drag.pointerId) return;
    const p = pointer(e);
    if (!drag.moved && Math.hypot(p[0] - drag.p0[0], p[1] - drag.p0[1]) < 2) return;
    drag.moved = true;
    onDrag(p, e);
  });

  root.addEventListener('pointerleave', () => {
    if (!maskEdit.cursor) return;
    maskEdit.cursor = null;
    root.querySelector('.mask-brush-cursor')?.remove();
  });

  const end = (e) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    if (drag.kind === 'move' && !drag.moved && cur?.m?.type === 'pen') maskEdit.set({ point: -1 });
    drag = null;
    store.seal();
  };
  root.addEventListener('pointerup', end);
  root.addEventListener('pointercancel', end);

  function onDrag(p, e) {
    const { kind, m, l0, a, b, coalesce, raw } = drag;
    const { SW, SH } = cur;
    const l = toLocal(m, p);
    switch (kind) {
      case 'move': {
        const s0 = cur.cssToSrc(...drag.p0);
        const s1 = cur.cssToSrc(...p);
        let x = m.x + (s1[0] - s0[0]) / SW;
        let y = m.y + (s1[1] - s0[1]) / SH;
        if (!e.altKey) {
          // Snap the center to the middle of the picture.
          const pxPerSrc = Math.abs(cur.box.w) * cur.k / SW;
          if (Math.abs(x) * SW * pxPerSrc < 6) x = 0;
          if (Math.abs(y) * SH * pxPerSrc < 6) y = 0;
        }
        edit('Move mask', { x, y }, coalesce);
        break;
      }
      case 'nw': case 'ne': case 'se': case 'sw': case 'n': case 's': case 'e': case 'w': {
        let na = kind.includes('e') || kind.includes('w') ? Math.abs(l[0]) : a;
        let nb = kind.includes('n') || kind.includes('s') ? Math.abs(l[1]) : b;
        if (e.shiftKey && kind.length === 2) {
          const f = Math.max(na / (a || 1), nb / (b || 1));
          na = a * f;
          nb = b * f;
        }
        const patch = {};
        if (na !== a) patch.w = Math.max(0.005, (2 * na) / SW);
        if (nb !== b) patch.h = Math.max(0.005, (2 * nb) / SH);
        edit('Resize mask', patch, coalesce);
        break;
      }
      case 'rotate': {
        const c = maskToSource(m, SW, SH, 0, 0);
        const s0 = cur.cssToSrc(...drag.p0);
        const s1 = cur.cssToSrc(...p);
        let r = m.rotation + ((Math.atan2(s1[1] - c[1], s1[0] - c[0]) - Math.atan2(s0[1] - c[1], s0[0] - c[0])) * 180) / Math.PI;
        r = ((r + 540) % 360) - 180;
        if (e.shiftKey) r = Math.round(r / 15) * 15;
        else if (Math.abs(r - Math.round(r / 90) * 90) < 3) r = Math.round(r / 90) * 90;
        edit('Rotate mask', { rotation: Math.round(r * 100) / 100 }, coalesce);
        break;
      }
      case 'feather': {
        const [dx, dy] = drag.dir;
        const edge = m.type === 'split' ? 0 : m.type === 'band' || !dx ? b : a;
        // Css pixels per mask-local pixel along the handle's direction.
        const e0 = cur.srcToCss(...maskToSource(m, SW, SH, dx * edge, dy * edge));
        const e1 = cur.srcToCss(...maskToSource(m, SW, SH, dx * (edge + 1), dy * (edge + 1)));
        const gapLocal = FEATHER_GAP / Math.max(1e-6, Math.hypot(e1[0] - e0[0], e1[1] - e0[1]));
        const extra = Math.max(0, l[0] * dx + l[1] * dy - edge - gapLocal);
        const unit = 0.2 * Math.min(SW, SH);
        edit('Feather mask', { feather: Math.round(Math.min(100, (extra / 2 / unit) * 100)) }, coalesce);
        break;
      }
      case 'round': {
        const r = Math.max(0, Math.min(Math.min(a, b), a - l[0]));
        edit('Round mask corners', { roundness: Math.round((r / Math.min(a, b)) * 100) }, coalesce);
        break;
      }
      case 'inner': {
        const rr = Math.hypot(l[0] / (a || 1), l[1] / (b || 1));
        edit('Star inner radius', { inner: Math.round(Math.max(0.05, Math.min(0.95, rr)) * 100) / 100 }, coalesce);
        break;
      }
      case 'point': {
        const path = raw.path.map((q) => ({ ...q }));
        const pt = path[drag.idx];
        if (!pt) break;
        const start = raw.path[drag.idx];
        pt.x = start.x + (l[0] - l0[0]) / (2 * a);
        pt.y = start.y + (l[1] - l0[1]) / (2 * b);
        edit('Move mask point', { path }, coalesce);
        break;
      }
      case 'place': {
        // Dragging while placing a point pulls out symmetric curve handles.
        const path = raw.path.map((q) => ({ ...q }));
        const pt = path[drag.idx];
        const ox = (l[0] - l0[0]) / (2 * a);
        const oy = (l[1] - l0[1]) / (2 * b);
        Object.assign(pt, { ox, oy, ix: -ox, iy: -oy });
        edit('Curve mask point', { path }, coalesce);
        break;
      }
      case 'hin': case 'hout': {
        const path = raw.path.map((q) => ({ ...q }));
        const pt = path[drag.idx];
        if (!pt) break;
        const hx = l[0] / (2 * a) - pt.x;
        const hy = l[1] / (2 * b) - pt.y;
        const own = kind === 'hin' ? ['ix', 'iy'] : ['ox', 'oy'];
        const opp = kind === 'hin' ? ['ox', 'oy'] : ['ix', 'iy'];
        pt[own[0]] = hx;
        pt[own[1]] = hy;
        // Smooth points keep their handles in line; Alt breaks the tangent.
        if (!e.altKey && (pt[opp[0]] || pt[opp[1]])) {
          const len = Math.hypot(pt[opp[0]], pt[opp[1]]);
          const hl = Math.hypot(hx, hy) || 1;
          pt[opp[0]] = (-hx / hl) * len;
          pt[opp[1]] = (-hy / hl) * len;
        }
        edit('Curve mask point', { path }, coalesce);
        break;
      }
      case 'paint': {
        const strokes = raw.strokes.map((s) => s);
        const last = { ...strokes[strokes.length - 1] };
        const lp = [l[0] / (2 * a), l[1] / (2 * b)];
        const pts = last.pts;
        const px = pts[pts.length - 2];
        const py = pts[pts.length - 1];
        // Skip points closer than about a css pixel.
        const step = 1.5 / Math.max(1e-6, Math.abs(cur.box.w) * cur.k);
        if (Math.hypot(lp[0] - px, lp[1] - py) < step) break;
        last.pts = [...pts, Math.round(lp[0] * 10000) / 10000, Math.round(lp[1] * 10000) / 10000];
        strokes[strokes.length - 1] = last;
        drag.raw = { ...raw, strokes };
        edit(maskEdit.brush.erase ? 'Erase mask' : 'Paint mask', { strokes }, coalesce);
        break;
      }
      default:
        break;
    }
  }

  // Keys while editing: Delete removes the selected pen point, arrows nudge the mask, Escape ends drawing.
  const onKey = (e) => {
    if (!cur || !root.isConnected || e.target.closest?.('input, textarea, select, [contenteditable]')) return;
    const m = cur.m;
    if ((e.key === 'Delete' || e.key === 'Backspace') && m.type === 'pen' && maskEdit.point >= 0) {
      const raw = rawMask();
      if (!raw?.path?.[maskEdit.point]) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      edit('Delete mask point', { path: raw.path.filter((_, j) => j !== maskEdit.point) });
      maskEdit.set({ point: -1 });
      store.seal();
      announce('Point deleted');
      return;
    }
    if (e.key === 'Escape' && maskEdit.drawing) {
      e.preventDefault();
      e.stopImmediatePropagation();
      closePath();
      return;
    }
    const d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
    if (!d) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const step = e.shiftKey ? 10 : 1;
    edit('Move mask', { x: m.x + (d[0] * step) / cur.SW, y: m.y + (d[1] * step) / cur.SH }, `mask-nudge:${cur.layer.clip.id}`);
  };
  stage?.addEventListener('keydown', onKey, true);

  return {
    el: root,
    /** Whether a layer's masks are being edited on the canvas. */
    active(layer) {
      return Boolean(layer?.kind === 'media' && layer.masks?.length && maskEdit.active(layer.clip.id));
    },
    draw,
    clear() {
      cur = null;
      drag = null;
    },
    dispose() {
      stage?.removeEventListener('keydown', onKey, true);
    },
  };
}
