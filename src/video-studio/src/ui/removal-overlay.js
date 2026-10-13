/**
 * On-canvas object removal editor, shown over the selected clip in the
 * player while the Remove panel is open. Paint over what should go (brush),
 * drag a box around it (box), or paint parts of a painted region back
 * (erase); regions are drawn through the clip's crop, flip and transform and
 * the player's zoom and pan, tinted while "Show regions" is on. The selected
 * box has corner handles; any selected region moves with its center handle
 * (a key at the playhead when its position is keyed). Edits go through the
 * undoable store; a stroke or drag is one undo step.
 */
import '../styles/masks.css';
import { US } from '../lib/time.js';
import { announce } from '../lib/dom.js';
import {
  evaluateRegions, defaultRegion, addRegion, setRegionValues, regionBounds, regionHasShape, MAX_REGIONS, REMOVAL_DEFAULT,
} from '../model/removal.js';
import { maskHalf, maskToSource, sourceToMask, sourceToProject, projectToSource } from '../engine/mask-shapes.js';
import { removeEdit } from './remove-edit-state.js';
import { toast } from './dialog.js';

const NS = 'http://www.w3.org/2000/svg';
let maskSeq = 0;

function svg(tag, attrs = {}) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== null && v !== undefined) el.setAttribute(k, String(v));
  return el;
}

const pathD = (pts, closed = true) => (pts.length ? `M${pts.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('L')}${closed ? 'Z' : ''}` : '');
const q4 = (v) => Math.round(v * 10000) / 10000;

export function createRemovalOverlay({ store, actions, stage }) {
  const root = svg('svg', { class: 'mask-svg removal-svg', 'aria-hidden': 'true' });
  const uidBase = `rmv${++maskSeq}`;
  let cur = null; // { layer, box, k, SW, SH, regions, srcToCss, cssToSrc, cssPerSrc }
  let drag = null;

  const local = () => {
    const c = cur?.layer.clip;
    return c ? Math.round(store.time - c.start) : 0;
  };
  const tol = () => Math.round(US / store.fps / 2);

  function geometry(layer, box, k) {
    const SW = layer.width || 1;
    const SH = layer.height || 1;
    const crop = layer.crop || { l: 0, t: 0, r: 0, b: 0 };
    const srcToCss = (sx, sy) => {
      const [px, py] = sourceToProject(layer, box, SW, SH, sx, sy);
      return [px * k, py * k];
    };
    const cssToSrc = (cx, cy) => projectToSource(layer, box, SW, SH, cx / k, cy / k);
    const cssPerSrc = (Math.abs(box.w) * k) / Math.max(1e-6, SW * (1 - crop.l - crop.r));
    return { SW, SH, srcToCss, cssToSrc, cssPerSrc };
  }

  /** Css points of a region-local point (pixels from its center). */
  const L = (r, lx, ly) => {
    const [sx, sy] = maskToSource(r, cur.SW, cur.SH, lx, ly);
    return cur.srcToCss(sx, sy);
  };

  /** Path data of a painted region's strokes: { paint: [{ d, w }], erase: [{ d, w }] }. */
  function strokePaths(r) {
    const { a, b } = maskHalf(r, cur.SW, cur.SH);
    const unit = Math.min(2 * a, 2 * b);
    const out = { paint: [], erase: [] };
    for (const s of r.strokes || []) {
      const pts = [];
      for (let i = 0; i < s.pts.length; i += 2) pts.push(L(r, s.pts[i] * 2 * a, s.pts[i + 1] * 2 * b));
      if (pts.length === 1) pts.push([pts[0][0] + 0.01, pts[0][1]]);
      (s.erase ? out.erase : out.paint).push({ d: pathD(pts, false), w: Math.max(1, s.size * unit * cur.cssPerSrc) });
    }
    return out;
  }

  // --- Drawing ----------------------------------------------------------------
  function draw(layer, box, k, cssW, cssH) {
    const clip = layer.clip;
    const regions = evaluateRegions(clip, Math.round(store.time - clip.start));
    const g = geometry(layer, box, k);
    cur = { layer, box, k, regions, ...g };
    root.setAttribute('width', cssW);
    root.setAttribute('height', cssH);
    root.setAttribute('viewBox', `0 0 ${cssW} ${cssH}`);
    const tool = removeEdit.tool;
    root.classList.toggle('painting', tool !== 'box');
    const sel = Math.min(removeEdit.index, regions.length - 1);
    const off = clip.removal && !clip.removal.on;
    const kids = [];
    const defs = svg('defs');
    kids.push(defs);
    const { SW, SH, srcToCss } = g;
    const crop = layer.crop || { l: 0, t: 0, r: 0, b: 0 };
    const clipPoly = [[0, 0], [1, 0], [1, 1], [0, 1]].map(([x, y]) => srcToCss((crop.l + x * (1 - crop.l - crop.r)) * SW, (crop.t + y * (1 - crop.t - crop.b)) * SH));
    kids.push(svg('path', { class: `mask-clip-bounds catch-${tool === 'box' ? 'place' : 'paint'}`, d: pathD(clipPoly), 'data-rh': tool === 'box' ? 'box' : 'paint' }));
    const tintClass = `removal-tint${off ? ' off' : ''}`;
    regions.forEach((r, i) => {
      if (r.hidden) return;
      const selected = i === sel;
      if (r.type === 'brush') {
        const { paint, erase } = strokePaths(r);
        if (!paint.length) return;
        if (removeEdit.show) {
          const id = `${uidBase}-m${i}`;
          const m = svg('mask', { id, maskUnits: 'userSpaceOnUse', x: 0, y: 0, width: cssW, height: cssH });
          for (const p of paint) m.append(svg('path', { d: p.d, fill: 'none', stroke: '#fff', 'stroke-width': p.w, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
          for (const p of erase) m.append(svg('path', { d: p.d, fill: 'none', stroke: '#000', 'stroke-width': p.w, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
          defs.append(m);
          kids.push(svg('rect', { class: `${tintClass}${selected ? ' selected' : ''}`, x: 0, y: 0, width: cssW, height: cssH, mask: `url(#${id})` }));
        }
        if (selected) {
          const bnd = regionBounds(r, SW / SH);
          if (bnd) {
            const corners = [[bnd.x, bnd.y], [bnd.x + bnd.w, bnd.y], [bnd.x + bnd.w, bnd.y + bnd.h], [bnd.x, bnd.y + bnd.h]].map(([x, y]) => srcToCss(x * SW, y * SH));
            kids.push(svg('path', { class: 'mask-box', d: pathD(corners) }));
            const c = srcToCss((bnd.x + bnd.w / 2) * SW, (bnd.y + bnd.h / 2) * SH);
            kids.push(svg('circle', { class: 'mask-handle center', cx: c[0], cy: c[1], r: 6, 'data-rh': 'move', 'data-i': i }));
          }
        }
        return;
      }
      const { a, b } = maskHalf(r, SW, SH);
      const corners = { nw: [-a, -b], ne: [a, -b], se: [a, b], sw: [-a, b] };
      const poly = Object.values(corners).map(([x, y]) => L(r, x, y));
      if (removeEdit.show) kids.push(svg('path', { class: `${tintClass}${selected ? ' selected' : ''}`, d: pathD(poly) }));
      kids.push(svg('path', { class: `mask-outline${selected ? '' : ' other'}`, d: pathD(poly) }));
      // In box mode a box body picks and moves that region.
      if (tool === 'box') kids.push(svg('path', { class: 'removal-hit', d: pathD(poly), 'data-rh': 'move', 'data-i': i }));
      if (selected) {
        for (const [name, [x, y]] of Object.entries(corners)) {
          const [cx, cy] = L(r, x, y);
          kids.push(svg('circle', { class: `mask-handle corner${name === 'ne' || name === 'sw' ? ' nesw' : ''}`, cx, cy, r: 5.5, 'data-rh': name, 'data-i': i }));
        }
        const c = L(r, 0, 0);
        kids.push(svg('circle', { class: 'mask-handle center', cx: c[0], cy: c[1], r: 6, 'data-rh': 'move', 'data-i': i }));
      }
    });
    if (tool !== 'box' && removeEdit.cursor) {
      const [cx, cy, r] = removeEdit.cursor;
      kids.push(svg('circle', { class: `mask-brush-cursor${tool === 'erase' ? ' erase' : ''}`, cx, cy, r }));
    }
    root.replaceChildren(...kids);
  }

  // --- Editing ------------------------------------------------------------------
  function pointer(e) {
    const r = root.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  function edit(label, fn, coalesce) {
    return actions.editClip(cur.layer.clip.id, label, fn, coalesce ? { coalesce } : {});
  }

  /** The painted region strokes go into: the selected one, or a new one (null when full). */
  function paintTarget(erase) {
    const list = cur.regions;
    const sel = Math.min(removeEdit.index, list.length - 1);
    if (list[sel]?.type === 'brush' && !list[sel].hidden) return sel;
    if (erase) {
      for (let i = list.length - 1; i >= 0; i--) if (list[i].type === 'brush' && !list[i].hidden && regionHasShape(list[i])) return i;
      return -1;
    }
    return list.length >= MAX_REGIONS ? -2 : list.length;
  }

  root.addEventListener('pointerdown', (e) => {
    const t = e.target.closest?.('[data-rh]');
    if (!t || !cur || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    stage?.focus({ preventScroll: true });
    const kind = t.dataset.rh;
    const p0 = pointer(e);
    const s0 = cur.cssToSrc(...p0);
    const coalesce = `removal:${cur.layer.clip.id}:${kind}:${Date.now()}`;
    const time = local();
    if (kind === 'paint') {
      const erase = removeEdit.tool === 'erase' || e.altKey;
      const index = paintTarget(erase);
      if (index === -1) {
        toast('Paint a region first; the eraser takes parts of it back.', { kind: 'info' });
        return;
      }
      if (index === -2) {
        toast(`A clip can have up to ${MAX_REGIONS} regions. Select a painted one to add to it.`, { kind: 'info' });
        return;
      }
      const r = cur.regions[index] || defaultRegion('brush');
      const { a, b } = maskHalf(r, cur.SW, cur.SH);
      const l = sourceToMask(r, cur.SW, cur.SH, s0[0], s0[1]);
      const stroke = { size: removeEdit.size, erase, pts: [q4(l[0] / (2 * a)), q4(l[1] / (2 * b))] };
      edit(erase ? 'Erase removal region' : 'Paint removal region', (c) => {
        if (index >= (c.removal?.regions?.length || 0)) {
          c.removal ||= { ...REMOVAL_DEFAULT, regions: [] };
          c.removal.on = true;
          if (addRegion(c, { ...defaultRegion('brush'), id: r.id }) < 0) return false;
        }
        const reg = c.removal.regions[index];
        reg.strokes = [...(reg.strokes || []), stroke];
      }, coalesce);
      if (removeEdit.index !== index) removeEdit.set({ index });
      drag = { kind, index, region: r, a, b, coalesce, pts: stroke.pts.slice(), erase };
    } else if (kind === 'box') {
      if (cur.regions.length >= MAX_REGIONS) {
        toast(`A clip can have up to ${MAX_REGIONS} regions.`, { kind: 'info' });
        return;
      }
      drag = { kind, s0, coalesce, index: -1, id: defaultRegion('rectangle').id, p0 };
    } else if (kind === 'move' || ['nw', 'ne', 'se', 'sw'].includes(kind)) {
      const index = Number(t.dataset.i);
      const r = cur.regions[index];
      if (!r) return;
      if (removeEdit.index !== index) removeEdit.set({ index });
      drag = { kind, index, region: { ...r }, s0, coalesce, time };
    }
    if (!drag) return;
    drag.pointerId = e.pointerId;
    try {
      root.setPointerCapture?.(e.pointerId);
    } catch {
      // Synthetic or already released pointers cannot be captured; the drag still works over the picture.
    }
  });

  root.addEventListener('pointermove', (e) => {
    if (cur && removeEdit.tool !== 'box') {
      const p = pointer(e);
      const r = (removeEdit.size * Math.min(cur.SW, cur.SH) * cur.cssPerSrc) / 2;
      removeEdit.cursor = [p[0], p[1], r];
      const c = root.querySelector('.mask-brush-cursor');
      if (c) {
        c.setAttribute('cx', p[0]);
        c.setAttribute('cy', p[1]);
        c.setAttribute('r', r);
        c.classList.toggle('erase', removeEdit.tool === 'erase' || e.altKey);
      } else root.append(svg('circle', { class: `mask-brush-cursor${removeEdit.tool === 'erase' ? ' erase' : ''}`, cx: p[0], cy: p[1], r }));
    }
    if (!drag || e.pointerId !== drag.pointerId) return;
    onDrag(pointer(e), e);
  });

  root.addEventListener('pointerleave', () => {
    if (!removeEdit.cursor) return;
    removeEdit.cursor = null;
    root.querySelector('.mask-brush-cursor')?.remove();
  });

  const end = (e) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    if (drag.kind === 'paint') announce(drag.erase ? 'Part of the region taken back' : 'Region painted');
    if (drag.kind === 'box' && drag.index >= 0) announce('Box added');
    drag = null;
    store.seal();
  };
  root.addEventListener('pointerup', end);
  root.addEventListener('pointercancel', end);

  function onDrag(p, e) {
    const { SW, SH } = cur;
    const s = cur.cssToSrc(...p);
    switch (drag.kind) {
      case 'paint': {
        const { region: r, a, b, index } = drag;
        const l = sourceToMask(r, SW, SH, s[0], s[1]);
        const lp = [q4(l[0] / (2 * a)), q4(l[1] / (2 * b))];
        const pts = drag.pts;
        // Skip points closer than about a css pixel.
        const step = 1.5 / Math.max(1e-6, 2 * a * cur.cssPerSrc);
        if (Math.hypot(lp[0] - pts[pts.length - 2], lp[1] - pts[pts.length - 1]) < step) return;
        pts.push(lp[0], lp[1]);
        const copy = pts.slice();
        edit(drag.erase ? 'Erase removal region' : 'Paint removal region', (c) => {
          const reg = c.removal?.regions?.[index];
          const last = reg?.strokes?.[reg.strokes.length - 1];
          if (!last) return false;
          reg.strokes[reg.strokes.length - 1] = { ...last, pts: copy };
        }, drag.coalesce);
        break;
      }
      case 'box': {
        if (Math.hypot(p[0] - drag.p0[0], p[1] - drag.p0[1]) < 3) return;
        const x0 = Math.max(0, Math.min(drag.s0[0], s[0]) / SW);
        const x1 = Math.min(1, Math.max(drag.s0[0], s[0]) / SW);
        const y0 = Math.max(0, Math.min(drag.s0[1], s[1]) / SH);
        const y1 = Math.min(1, Math.max(drag.s0[1], s[1]) / SH);
        const box = { x: q4((x0 + x1) / 2 - 0.5), y: q4((y0 + y1) / 2 - 0.5), w: q4(Math.max(0.002, x1 - x0)), h: q4(Math.max(0.002, y1 - y0)) };
        let index = drag.index;
        edit('Add removal box', (c) => {
          const list = c.removal?.regions || [];
          const at = list.findIndex((r) => r.id === drag.id);
          if (at >= 0) {
            Object.assign(list[at], box);
            index = at;
            return;
          }
          c.removal ||= { ...REMOVAL_DEFAULT, regions: [] };
          c.removal.on = true;
          index = addRegion(c, { ...defaultRegion('rectangle', box), id: drag.id });
          return index >= 0;
        }, drag.coalesce);
        if (index >= 0 && drag.index !== index) {
          drag.index = index;
          removeEdit.set({ index });
        }
        break;
      }
      case 'move': {
        const r = drag.region;
        let x = r.x + (s[0] - drag.s0[0]) / SW;
        let y = r.y + (s[1] - drag.s0[1]) / SH;
        if (e.shiftKey) {
          // Shift keeps to one axis.
          if (Math.abs(x - r.x) * SW > Math.abs(y - r.y) * SH) y = r.y;
          else x = r.x;
        }
        const i = drag.index;
        edit('Move removal region', (c) => setRegionValues(c, i, { x: q4(x), y: q4(y) }, drag.time, tol()), drag.coalesce);
        break;
      }
      default: {
        // Corner: the opposite corner stays put.
        const r = drag.region;
        const { a, b } = maskHalf(r, SW, SH);
        const sx = drag.kind.includes('e') ? -1 : 1;
        const sy = drag.kind.includes('s') ? -1 : 1;
        const anchor = maskToSource(r, SW, SH, sx * a, sy * b);
        const l = sourceToMask(r, SW, SH, s[0], s[1]);
        const la = sourceToMask(r, SW, SH, anchor[0], anchor[1]);
        const w = Math.max(2, Math.abs(l[0] - la[0]));
        const hgt = Math.max(2, Math.abs(l[1] - la[1]));
        const mid = maskToSource(r, SW, SH, (l[0] + la[0]) / 2, (l[1] + la[1]) / 2);
        const i = drag.index;
        edit('Resize removal box', (c) => {
          const reg = c.removal?.regions?.[i];
          if (!reg) return false;
          reg.w = q4(w / SW);
          reg.h = q4(hgt / SH);
          return setRegionValues(c, i, { x: q4(mid[0] / SW - 0.5), y: q4(mid[1] / SH - 0.5) }, drag.time, tol());
        }, drag.coalesce);
        break;
      }
    }
  }

  // Arrows nudge the selected region (Shift: 10 pixels).
  const onKey = (e) => {
    if (!cur || !root.isConnected || e.target.closest?.('input, textarea, select, [contenteditable]')) return;
    const d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
    if (!d) return;
    const i = Math.min(removeEdit.index, cur.regions.length - 1);
    const r = cur.regions[i];
    if (!r) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const step = e.shiftKey ? 10 : 1;
    const time = local();
    edit('Move removal region', (c) => setRegionValues(c, i, { x: q4(r.x + (d[0] * step) / cur.SW), y: q4(r.y + (d[1] * step) / cur.SH) }, time, tol()), `removal-nudge:${cur.layer.clip.id}`);
  };
  stage?.addEventListener('keydown', onKey, true);

  return {
    el: root,
    /** Whether a layer's removal regions are being edited on the canvas. */
    active(layer) {
      return Boolean(layer?.kind === 'media' && layer.clip && removeEdit.active(layer.clip.id));
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
