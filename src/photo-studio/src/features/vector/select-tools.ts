import type { Editor } from '../../editor';
import type { Tool } from '../../app/registry';
import type { CanvasPointer } from '../../app/pointer';
import type { VectorMask } from '../../model/vector';
import { allLayers, type Layer } from '../../model/document';
import { vectorBounds } from '../../model/vector';
import { vectorContains } from '../../ui/vector-hit';
import { svg } from '../../app/icons';
import {
  anchor, cloneMask, componentAt, componentGroups, componentOf, deleteKnots, dragSegment, hitAnchor, hitHandle, isLine, nearestSegment,
  segment, smoothKnot, translateMask, type KnotRef, type PathOp, type Pt,
} from './geometry';
import { activeKey, selectKnots, setActive, targetByKey, targetLocked, targetPath, vstate, type PathTarget } from './state';
import { commitPathEdit } from './masks';
import { previewEdit, endPreview } from './preview';

type Drag = {
  target: PathTarget;
  base: VectorMask;
  mask: VectorMask;
  start: Pt;
  moved: boolean;
  kind: 'paths' | 'knots' | 'handle' | 'segment' | 'marquee';
  paths?: Set<number>;
  knots?: KnotRef[];
  handle?: KnotRef & { side: 'in' | 'out' };
  breakLink?: boolean;
  segment?: { path: number; index: number; t: number };
  marqueeEnd?: Pt;
  additive?: boolean;
  duplicate?: boolean;
  label: string;
};
let drag: Drag | undefined;
let marquee: { a: Pt; b: Pt } | undefined;

import { selectHooks, type SelectHook } from './select-hooks';
export { selectHooks, type SelectHook } from './select-hooks';
let hooked: SelectHook | undefined;
function hookDown(e: Editor, p: CanvasPointer) {
  hooked = selectHooks.find((h) => h.down(e, p));
  return !!hooked;
}
function hookHover(e: Editor, p: CanvasPointer) {
  let c: string | undefined;
  for (const h of selectHooks) if ((c = h.hover?.(e, p))) break;
  e.el('#viewport').style.cursor = c ?? 'default';
}
const tol = (e: Editor) => 6 / e.zoom;

/** Topmost visible shape layer under a point (besides the current target). */
function shapeLayerAt(e: Editor, x: number, y: number): Layer | undefined {
  const layers = allLayers(e.doc.layers).filter((l) => l.kind === 'vector' && l.visible && l.vector);
  for (let i = layers.length - 1; i >= 0; i--) {
    const l = layers[i];
    try {
      if (vectorContains(l, x, y)) return l;
    } catch {
      /* Hit testing is best effort for unusual geometry. */
    }
  }
}
function selectedComponentPaths(m: VectorMask, paths: Set<number>) {
  const out = new Set<number>();
  for (const g of componentGroups(m)) if (g.some((i) => paths.has(i))) g.forEach((i) => out.add(i));
  return out;
}
function hitComponent(m: VectorMask, x: number, y: number, t: number): number | undefined {
  const s = nearestSegment(m, x, y);
  if (s && s.distance <= t) return s.path;
  return componentAt(m, x, y);
}

// ----- Path Selection -----
async function pathSelectDown(e: Editor, p: CanvasPointer) {
  if (hookDown(e, p)) return;
  let t = targetPath(e);
  const st = vstate(e);
  let hit = t ? hitComponent(t.mask, p.x, p.y, tol(e)) : undefined;
  if (hit === undefined) {
    const l = shapeLayerAt(e, p.x, p.y);
    if (l && (!t || t.id !== l.id)) {
      e.selectLayer(l.id);
      setActive(e, undefined);
      t = targetByKey(e, `layer:${l.id}`);
      if (t) hit = hitComponent(t.mask, p.x, p.y, tol(e)) ?? 0;
    }
  }
  if (!t) return;
  if (st.selectionKey !== activeKey(t)) selectKnots(e, t, []);
  if (hit === undefined) {
    if (!p.shift) st.paths = new Set();
    drag = { target: t, base: t.mask, mask: t.mask, start: [p.x, p.y], moved: false, kind: 'marquee', additive: p.shift, label: '' };
    marquee = { a: [p.x, p.y], b: [p.x, p.y] };
    e.overlay();
    return;
  }
  const comp = componentOf(t.mask, hit);
  if (p.shift) {
    const has = comp.every((i) => st.paths.has(i));
    for (const i of comp) has ? st.paths.delete(i) : st.paths.add(i);
  } else if (!comp.some((i) => st.paths.has(i))) st.paths = new Set(comp);
  st.knots = [];
  const paths = selectedComponentPaths(t.mask, st.paths);
  drag = { target: t, base: t.mask, mask: t.mask, start: [p.x, p.y], moved: false, kind: 'paths', paths, duplicate: p.alt, label: p.alt ? 'Duplicate Path' : 'Move Path' };
  e.overlay();
  e.update();
}
function pathSelectMove(e: Editor, p: CanvasPointer) {
  if (hooked) return hooked.move(e, p);
  const d = drag;
  if (!d) return;
  if (d.kind === 'marquee') {
    marquee = { a: d.start, b: [p.x, p.y] };
    e.overlay();
    return;
  }
  const [sx, sy] = e.clientPoint(d.start[0], d.start[1]);
  if (!d.moved && Math.hypot(p.clientX - sx, p.clientY - sy) < 3) return;
  d.moved = true;
  let dx = p.x - d.start[0], dy = p.y - d.start[1];
  if (p.shift) Math.abs(dx) > Math.abs(dy) ? (dy = 0) : (dx = 0);
  const mask = cloneMask(d.base);
  let only = d.paths!;
  if (d.duplicate) {
    // Alt-drag copies the selected components and moves the copies.
    const copies = [...only].sort((a, b) => a - b).map((i) => structuredClone(mask.paths[i]));
    const first = mask.paths.length;
    mask.paths.push(...copies);
    only = new Set(copies.map((_, i) => first + i));
    if (!mask.paths[first].operation) mask.paths[first].operation = 'combine';
  }
  translateMask(mask, dx, dy, only);
  d.mask = mask;
  previewEdit(e, d.target, mask);
}
export async function selectUp(e: Editor, p?: CanvasPointer) {
  if (hooked) {
    const h = hooked;
    hooked = undefined;
    if (p) await h.up(e, p);
    return;
  }
  const d = drag;
  drag = undefined;
  if (!d) return;
  if (d.kind === 'marquee') {
    const m = marquee;
    marquee = undefined;
    if (m) selectInRect(e, d, m);
    e.overlay();
    e.update();
    return;
  }
  if (!d.moved || targetLocked(e, d.target)) {
    endPreview(e);
    return;
  }
  const st = vstate(e);
  const before = d.base.paths.length;
  await commitPathEdit(e, d.target, d.mask, d.label);
  if (d.duplicate) st.paths = new Set(d.mask.paths.map((_, i) => i).slice(before));
  st.selectionKey = activeKey(d.target);
  endPreview(e);
  e.update();
}
function selectInRect(e: Editor, d: Drag, m: { a: Pt; b: Pt }) {
  const st = vstate(e);
  const x0 = Math.min(m.a[0], m.b[0]), x1 = Math.max(m.a[0], m.b[0]), y0 = Math.min(m.a[1], m.b[1]), y1 = Math.max(m.a[1], m.b[1]);
  if ((x1 - x0) * e.zoom < 3 && (y1 - y0) * e.zoom < 3) {
    if (!d.additive) {
      st.paths = new Set();
      st.knots = [];
    }
    return;
  }
  const mask = d.target.mask;
  if (d.kind === 'marquee' && e.tool === 'path-select') {
    mask.paths.forEach((_, i) => {
      const b = vectorBounds({ paths: [mask.paths[i]] });
      if (b && b.x <= x1 && b.x + b.width >= x0 && b.y <= y1 && b.y + b.height >= y0) componentOf(mask, i).forEach((j) => st.paths.add(j));
    });
    return;
  }
  const knots: KnotRef[] = d.additive ? [...st.knots] : [];
  mask.paths.forEach((sp, pi) =>
    sp.knots.forEach((k, ki) => {
      const [x, y] = anchor(k);
      if (x >= x0 && x <= x1 && y >= y0 && y <= y1 && !knots.some((r) => r.path === pi && r.knot === ki)) knots.push({ path: pi, knot: ki });
    }),
  );
  selectKnots(e, d.target, knots);
}

// ----- Direct Selection -----
export function directDown(e: Editor, p: CanvasPointer) {
  if (hookDown(e, p)) return;
  let t = targetPath(e);
  const st = vstate(e);
  if (!t) {
    const l = shapeLayerAt(e, p.x, p.y);
    if (!l) return;
    e.selectLayer(l.id);
    setActive(e, undefined);
    t = targetByKey(e, `layer:${l.id}`);
    if (!t) return;
  }
  if (st.selectionKey !== activeKey(t)) selectKnots(e, t, []);
  const tl = tol(e);
  const m = t.mask;
  // Handles of selected anchors and their neighbours are draggable (the
  // ones the overlay shows: an open path's ends have one neighbour).
  const visible: KnotRef[] = [];
  for (const r of st.knots) {
    const sp = m.paths[r.path];
    if (!sp) continue;
    const n = sp.knots.length;
    visible.push(r);
    if (!sp.open || r.knot < n - 1) visible.push({ path: r.path, knot: (r.knot + 1) % n });
    if (!sp.open || r.knot > 0) visible.push({ path: r.path, knot: (r.knot - 1 + n) % n });
  }
  const h = hitHandle(m, p.x, p.y, tl, visible);
  if (h) {
    drag = { target: t, base: m, mask: m, start: [p.x, p.y], moved: false, kind: 'handle', handle: h, breakLink: p.alt, label: 'Drag Handle' };
    return;
  }
  const a = hitAnchor(m, p.x, p.y, tl);
  if (a) {
    const selected = st.knots.some((r) => r.path === a.path && r.knot === a.knot);
    if (p.shift) selectKnots(e, t, selected ? st.knots.filter((r) => r.path !== a.path || r.knot !== a.knot) : [...st.knots, a]);
    else if (!selected) selectKnots(e, t, [a]);
    drag = { target: t, base: m, mask: m, start: [p.x, p.y], moved: false, kind: 'knots', knots: [...vstate(e).knots], label: 'Drag Anchor Point' };
    e.overlay();
    return;
  }
  const s = nearestSegment(m, p.x, p.y);
  if (s && s.distance <= tl) {
    const c = segment(m.paths[s.path], s.segment);
    const n = m.paths[s.path].knots.length;
    const ends: KnotRef[] = [{ path: s.path, knot: s.segment }, { path: s.path, knot: (s.segment + 1) % n }];
    if (isLine(c)) {
      selectKnots(e, t, p.shift ? [...st.knots, ...ends] : ends);
      drag = { target: t, base: m, mask: m, start: [p.x, p.y], moved: false, kind: 'knots', knots: [...vstate(e).knots], label: 'Drag Segment' };
    } else {
      if (!p.shift) selectKnots(e, t, []);
      drag = { target: t, base: m, mask: m, start: [p.x, p.y], moved: false, kind: 'segment', segment: { path: s.path, index: s.segment, t: s.t }, label: 'Drag Curve' };
    }
    e.overlay();
    return;
  }
  // Clicking inside a component shows its anchors; empty space starts a marquee.
  const inside = componentAt(m, p.x, p.y);
  if (!p.shift) selectKnots(e, t, []);
  if (inside !== undefined) st.paths = new Set(componentOf(m, inside));
  drag = { target: t, base: m, mask: m, start: [p.x, p.y], moved: false, kind: 'marquee', additive: p.shift, label: '' };
  marquee = { a: [p.x, p.y], b: [p.x, p.y] };
  e.overlay();
}
export function directMove(e: Editor, p: CanvasPointer) {
  if (hooked) return hooked.move(e, p);
  const d = drag;
  if (!d) return;
  if (d.kind === 'marquee') {
    marquee = { a: d.start, b: [p.x, p.y] };
    e.overlay();
    return;
  }
  const [sx, sy] = e.clientPoint(d.start[0], d.start[1]);
  if (!d.moved && Math.hypot(p.clientX - sx, p.clientY - sy) < 3) return;
  d.moved = true;
  let dx = p.x - d.start[0], dy = p.y - d.start[1];
  const mask = cloneMask(d.base);
  if (d.kind === 'knots') {
    if (p.shift) Math.abs(dx) > Math.abs(dy) ? (dy = 0) : (dx = 0);
    for (const r of d.knots!) {
      const k = mask.paths[r.path]?.knots[r.knot];
      if (k) for (let i = 0; i < 6; i += 2) (k.points[i] += dx), (k.points[i + 1] += dy);
    }
  } else if (d.kind === 'handle') {
    const h = d.handle!;
    const k = mask.paths[h.path].knots[h.knot];
    const o = h.side === 'in' ? 0 : 4, q = h.side === 'in' ? 4 : 0;
    const a = anchor(k);
    let hx = d.base.paths[h.path].knots[h.knot].points[o] + dx, hy = d.base.paths[h.path].knots[h.knot].points[o + 1] + dy;
    if (p.shift) {
      // Constrain the handle to 45 degree steps around its anchor.
      const ang = Math.round(Math.atan2(hy - a[1], hx - a[0]) / (Math.PI / 4)) * (Math.PI / 4), len = Math.hypot(hx - a[0], hy - a[1]);
      hx = a[0] + Math.cos(ang) * len;
      hy = a[1] + Math.sin(ang) * len;
    }
    k.points[o] = hx;
    k.points[o + 1] = hy;
    if (k.linked && !d.breakLink && !p.alt) {
      // A smooth point keeps its opposite handle collinear, preserving its length.
      const other = Math.hypot(k.points[q] - a[0], k.points[q + 1] - a[1]);
      const len = Math.hypot(hx - a[0], hy - a[1]) || 1;
      k.points[q] = a[0] - ((hx - a[0]) / len) * other;
      k.points[q + 1] = a[1] - ((hy - a[1]) / len) * other;
    } else k.linked = smoothKnot(k);
  } else if (d.kind === 'segment') {
    const s = d.segment!;
    const sp = mask.paths[s.path];
    const c = segment(d.base.paths[s.path], s.index);
    const [c1, c2] = dragSegment(c, s.t, dx, dy);
    const a = sp.knots[s.index], b = sp.knots[(s.index + 1) % sp.knots.length];
    a.points[4] = c1[0];
    a.points[5] = c1[1];
    b.points[0] = c2[0];
    b.points[1] = c2[1];
    // Keep smooth neighbours smooth by rotating their opposite handles.
    for (const [k, side] of [[a, 'out'], [b, 'in']] as const) {
      if (!k.linked) continue;
      const o = side === 'in' ? 0 : 4, q = side === 'in' ? 4 : 0, ax = k.points[2], ay = k.points[3];
      const other = Math.hypot(k.points[q] - ax, k.points[q + 1] - ay), len = Math.hypot(k.points[o] - ax, k.points[o + 1] - ay) || 1;
      k.points[q] = ax - ((k.points[o] - ax) / len) * other;
      k.points[q + 1] = ay - ((k.points[o + 1] - ay) / len) * other;
    }
  }
  d.mask = mask;
  previewEdit(e, d.target, mask);
}

// ----- Keyboard: delete and nudge -----
function selectionKeys(e: Editor, ev: KeyboardEvent): boolean {
  if (drag) {
    if (ev.key === 'Escape') {
      drag = undefined;
      marquee = undefined;
      endPreview(e);
      return true;
    }
    return false;
  }
  const t = targetPath(e);
  const st = vstate(e);
  if (!t) return false;
  if (st.selectionKey !== activeKey(t)) return ev.key === 'Backspace' || ev.key === 'Delete';
  const direct = e.tool === 'direct-select';
  const has = direct ? st.knots.length > 0 : st.paths.size > 0;
  // With nothing selected, Delete must not fall through to pixel clearing.
  if (!has) return ev.key === 'Backspace' || ev.key === 'Delete';
  if (ev.key === 'Escape') {
    selectKnots(e, t, []);
    e.overlay();
    return true;
  }
  if (ev.key === 'Backspace' || ev.key === 'Delete') {
    if (targetLocked(e, t)) return true;
    let mask = cloneMask(t.mask);
    if (direct) mask = deleteKnots(mask, st.knots);
    else {
      const drop = selectedComponentPaths(mask, st.paths);
      mask.paths = mask.paths.filter((_, i) => !drop.has(i));
      if (mask.paths.length && !mask.paths[0].operation) mask.paths[0].operation = 'combine';
    }
    selectKnots(e, t, []);
    void commitPathEdit(e, t, mask, direct ? 'Delete Anchor Point' : 'Delete Path').then(() => e.update());
    return true;
  }
  if (ev.key.startsWith('Arrow') && !ev.metaKey && !ev.ctrlKey) {
    if (targetLocked(e, t)) return true;
    const step = ev.shiftKey ? 10 : 1;
    const dx = ev.key === 'ArrowLeft' ? -step : ev.key === 'ArrowRight' ? step : 0, dy = ev.key === 'ArrowUp' ? -step : ev.key === 'ArrowDown' ? step : 0;
    const mask = cloneMask(t.mask);
    if (direct)
      for (const r of st.knots) {
        const k = mask.paths[r.path]?.knots[r.knot];
        if (k) for (let i = 0; i < 6; i += 2) (k.points[i] += dx), (k.points[i + 1] += dy);
      }
    else translateMask(mask, dx, dy, selectedComponentPaths(mask, st.paths));
    void commitPathEdit(e, t, mask, direct ? 'Nudge Anchor Point' : 'Nudge Path').then(() => e.update());
    return true;
  }
  return false;
}
function marqueeOverlay(e: Editor) {
  if (!marquee) return '';
  const [a, b] = [marquee.a, marquee.b];
  const z = e.zoom;
  return `<rect x="${Math.min(a[0], b[0])}" y="${Math.min(a[1], b[1])}" width="${Math.abs(b[0] - a[0])}" height="${Math.abs(b[1] - a[1])}" class="vec-marquee" stroke-width="${1 / z}" stroke-dasharray="${3 / z} ${3 / z}"/>`;
}

// ----- Options: operations, merge and align for selected components -----
export async function setComponentOperation(e: Editor, op: PathOp) {
  const t = targetPath(e);
  const st = vstate(e);
  if (!t || !st.paths.size || targetLocked(e, t)) return;
  const mask = cloneMask(t.mask);
  for (const g of componentGroups(mask)) if (g.some((i) => st.paths.has(i))) mask.paths[g[0]].operation = op;
  await commitPathEdit(e, t, mask, 'Change Path Operation');
}
export async function alignComponents(e: Editor, edge: 'left' | 'hcenter' | 'right' | 'top' | 'vcenter' | 'bottom') {
  const t = targetPath(e);
  const st = vstate(e);
  if (!t || !st.paths.size || targetLocked(e, t)) return;
  const mask = cloneMask(t.mask);
  const groups = componentGroups(mask).filter((g) => g.some((i) => st.paths.has(i)));
  const boxes = groups.map((g) => vectorBounds({ paths: g.map((i) => mask.paths[i]) })!);
  // A single component aligns to the canvas; several align to their union.
  const all = groups.length === 1 ? { x: 0, y: 0, width: e.doc.width, height: e.doc.height } : boxes.reduce((u, b) => {
    const x = Math.min(u.x, b.x), y = Math.min(u.y, b.y);
    return { x, y, width: Math.max(u.x + u.width, b.x + b.width) - x, height: Math.max(u.y + u.height, b.y + b.height) - y };
  });
  groups.forEach((g, i) => {
    const b = boxes[i];
    const dx = edge === 'left' ? all.x - b.x : edge === 'right' ? all.x + all.width - b.x - b.width : edge === 'hcenter' ? all.x + all.width / 2 - b.x - b.width / 2 : 0;
    const dy = edge === 'top' ? all.y - b.y : edge === 'bottom' ? all.y + all.height - b.y - b.height : edge === 'vcenter' ? all.y + all.height / 2 - b.y - b.height / 2 : 0;
    translateMask(mask, dx, dy, new Set(g));
  });
  await commitPathEdit(e, t, mask, 'Align Paths');
}
function selectOptions(e: Editor) {
  const st = vstate(e);
  const t = targetPath(e);
  const enabled = !!t && st.paths.size > 0 && st.selectionKey === activeKey(t);
  const dis = enabled ? '' : 'disabled';
  const ops: [PathOp, string, string][] = [['combine', 'Combine Shapes', 'path-op-combine'], ['subtract', 'Subtract Front Shape', 'path-op-subtract'], ['intersect', 'Intersect Shape Areas', 'path-op-intersect'], ['exclude', 'Exclude Overlapping Shapes', 'path-op-exclude']];
  const aligns: [string, string, string][] = [['left', 'Align left edges', 'align-start-vertical'], ['hcenter', 'Align horizontal centers', 'align-horizontal-justify-center'], ['right', 'Align right edges', 'align-end-vertical'], ['top', 'Align top edges', 'align-start-horizontal'], ['vcenter', 'Align vertical centers', 'align-vertical-justify-center'], ['bottom', 'Align bottom edges', 'align-end-horizontal']];
  return `<span class="vec-hint muted">${enabled ? `${st.paths.size} path component${st.paths.size > 1 ? 's' : ''} selected` : 'Click a path to select it'}</span><span class="divider"></span>${ops.map(([op, label, icon]) => `<button class="icon-button" data-path-op="${op}" title="${label}" aria-label="${label}" ${dis}>${svg(icon, 16)}</button>`).join('')}<button data-command="path.merge-components" ${dis} title="Merge the selected components into one outline">Merge Components</button><span class="divider"></span>${aligns.map(([a, label, icon]) => `<button class="icon-button" data-path-align="${a}" title="${label}" aria-label="${label}" ${dis}>${svg(icon, 16)}</button>`).join('')}`;
}
function bindSelectOptions(e: Editor, el: HTMLElement) {
  el.querySelectorAll<HTMLButtonElement>('[data-path-op]').forEach((b) => b.addEventListener('click', () => void setComponentOperation(e, b.dataset.pathOp as PathOp).then(() => e.update())));
  el.querySelectorAll<HTMLButtonElement>('[data-path-align]').forEach((b) => b.addEventListener('click', () => void alignComponents(e, b.dataset.pathAlign as never).then(() => e.update())));
}
export const pathSelectTool: Tool = {
  id: 'path-select',
  label: 'Path Selection Tool',
  key: 'A',
  icon: 'path-select',
  group: 'path-select',
  cursor: () => 'default',
  options: (e) => selectOptions(e),
  bindOptions: ({ e, el }) => bindSelectOptions(e, el),
  deactivate: () => {
    drag = undefined;
    marquee = undefined;
    hooked = undefined;
  },
  pointerDown: pathSelectDown,
  pointerMove: pathSelectMove,
  pointerUp: selectUp,
  hover: hookHover,
  keyDown: selectionKeys,
  overlay: marqueeOverlay,
};
export const directSelectTool: Tool = {
  id: 'direct-select',
  label: 'Direct Selection Tool',
  key: 'A',
  icon: 'direct-select',
  group: 'path-select',
  cursor: () => 'default',
  options: () => `<span class="vec-hint muted">Drag anchors, handles or curves. Shift adds to the selection, Alt breaks a smooth point's handles.</span>`,
  deactivate: () => {
    drag = undefined;
    marquee = undefined;
    hooked = undefined;
  },
  pointerDown: directDown,
  pointerMove: directMove,
  hover: hookHover,
  pointerUp: async (e, p) => {
    const d = drag;
    if (d && d.kind !== 'marquee' && d.moved && d.target.kind === 'shape') {
      const l = allLayers(e.doc.layers).find((x) => x.id === d.target.id);
      if (l?.vector?.live) e.message('The live shape is now a regular path.');
    }
    await selectUp(e, p);
  },
  keyDown: selectionKeys,
  overlay: marqueeOverlay,
};
