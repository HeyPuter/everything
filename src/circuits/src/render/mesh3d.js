// Builds triangle meshes for the 3D board view from a board document. Pure
// and synchronous, so it runs in tests and could move to a worker. Output is
// in millimetres with z = 0 at the bottom of the board and z = thickness at
// the top. Geometry is merged by material so the viewer issues one draw call
// per material.

import earcut from 'earcut';
import { arcToPoints, rotate, apply, polyArea, bboxEmpty, bboxAdd } from '../core/geom.js';
import { placeFootprint } from '../model/place.js';

const NM = 1e-6;
const SEG_CIRCLE = 20;

// Small z offsets keep coplanar layers apart without depth fighting.
const Z_TINT = 0.006;
const Z_HOLE = 0.012;
const Z_PAD = 0.02;
const Z_SILK = 0.03;
const BODY_STANDOFF = 0.05;

const FINISH_COLORS = { ENIG: '#d4a84a', HASL: '#c8c8c8', OSP: '#c87a4a', IMMAG: '#d0d0d0' };

export function hexToRgb(hex, fallback = '#808080') {
  let h = String(hex || fallback).trim().replace(/^#/, '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (!/^[0-9a-f]{6}$/i.test(h)) return hexToRgb(fallback);
  const n = parseInt(h, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

class Group {
  constructor(name, color, { metal = 0, roughness = 0.6, side } = {}) {
    this.name = name;
    this.color = color;
    this.metal = metal;
    this.roughness = roughness;
    this.side = side;
    this.p = [];
    this.n = [];
    this.i = [];
  }

  vert(x, y, z, nx, ny, nz) {
    this.p.push(x, y, z);
    this.n.push(nx, ny, nz);
    return this.p.length / 3 - 1;
  }

  tri(a, b, c) { this.i.push(a, b, c); }

  /** Flat polygon (mm) with optional holes, facing +z or -z. */
  polygon(outer, holes, z, nz) {
    const data = outer.slice();
    const holeIdx = [];
    for (const h of holes || []) {
      holeIdx.push(data.length / 2);
      for (const v of h) data.push(v);
    }
    const tris = earcut(data, holeIdx.length ? holeIdx : undefined);
    if (!tris.length) return;
    const base = this.p.length / 3;
    for (let k = 0; k < data.length; k += 2) this.vert(data[k], data[k + 1], z, 0, 0, nz);
    for (let k = 0; k < tris.length; k += 3) this.tri(base + tris[k], base + tris[k + 1], base + tris[k + 2]);
  }

  disc(cx, cy, r, z, nz, segs = SEG_CIRCLE) {
    const c = this.vert(cx, cy, z, 0, 0, nz);
    const first = this.p.length / 3;
    for (let k = 0; k < segs; k++) {
      const a = (k / segs) * Math.PI * 2;
      this.vert(cx + r * Math.cos(a), cy + r * Math.sin(a), z, 0, 0, nz);
    }
    for (let k = 0; k < segs; k++) this.tri(c, first + k, first + ((k + 1) % segs));
  }

  /** Flat stroke along a polyline (mm), round joints and caps. */
  ribbon(pts, width, z, nz, closed = false) {
    const hw = Math.max(width, 0.05) / 2;
    const n = pts.length / 2;
    if (n < 2) {
      if (n === 1) this.disc(pts[0], pts[1], hw, z, nz, 8);
      return;
    }
    const segCount = closed ? n : n - 1;
    for (let k = 0; k < segCount; k++) {
      const ax = pts[2 * k], ay = pts[2 * k + 1];
      const j = (k + 1) % n;
      const bx = pts[2 * j], by = pts[2 * j + 1];
      const dx = bx - ax, dy = by - ay;
      const len = Math.hypot(dx, dy);
      if (len < 1e-9) continue;
      const ox = (-dy / len) * hw, oy = (dx / len) * hw;
      const v0 = this.vert(ax + ox, ay + oy, z, 0, 0, nz);
      const v1 = this.vert(ax - ox, ay - oy, z, 0, 0, nz);
      const v2 = this.vert(bx - ox, by - oy, z, 0, 0, nz);
      const v3 = this.vert(bx + ox, by + oy, z, 0, 0, nz);
      this.tri(v0, v1, v2);
      this.tri(v0, v2, v3);
    }
    const joints = closed ? n : n;
    for (let k = 0; k < joints; k++) this.disc(pts[2 * k], pts[2 * k + 1], hw, z, nz, 8);
  }

  /** Vertical wall along a closed ring (mm) with normals pointing right of travel. */
  wall(ring, z0, z1) {
    const n = ring.length / 2;
    for (let k = 0; k < n; k++) {
      const ax = ring[2 * k], ay = ring[2 * k + 1];
      const j = (k + 1) % n;
      const bx = ring[2 * j], by = ring[2 * j + 1];
      const dx = bx - ax, dy = by - ay;
      const len = Math.hypot(dx, dy);
      if (len < 1e-12) continue;
      const nx = dy / len, ny = -dx / len;
      const v0 = this.vert(ax, ay, z0, nx, ny, 0);
      const v1 = this.vert(bx, by, z0, nx, ny, 0);
      const v2 = this.vert(bx, by, z1, nx, ny, 0);
      const v3 = this.vert(ax, ay, z1, nx, ny, 0);
      this.tri(v0, v1, v2);
      this.tri(v0, v2, v3);
    }
  }

  toMesh() {
    return {
      name: this.name,
      positions: new Float32Array(this.p),
      normals: new Float32Array(this.n),
      indices: new Uint32Array(this.i),
      color: this.color,
      metal: this.metal,
      roughness: this.roughness,
      ...(this.side ? { side: this.side } : {}),
    };
  }
}

class Materials {
  constructor() { this.groups = new Map(); }

  get(name, color, opts) {
    let g = this.groups.get(name);
    if (!g) this.groups.set(name, (g = new Group(name, color, opts)));
    return g;
  }

  meshes() {
    return [...this.groups.values()].filter((g) => g.i.length).map((g) => g.toMesh());
  }
}

const toMm = (flat) => flat.map((v) => v * NM);

/** Makes a flat ring counter-clockwise (positive area). */
function ccw(ring) {
  if (polyArea(ring) >= 0) return ring;
  const out = [];
  for (let k = ring.length - 2; k >= 0; k -= 2) out.push(ring[k], ring[k + 1]);
  return out;
}

const cw = (ring) => {
  const r = ccw(ring);
  const out = [];
  for (let k = r.length - 2; k >= 0; k -= 2) out.push(r[k], r[k + 1]);
  return out;
};

function circlePts(cx, cy, r, segs = SEG_CIRCLE) {
  const out = [];
  for (let k = 0; k < segs; k++) {
    const a = (k / segs) * Math.PI * 2;
    out.push(cx + r * Math.cos(a), cy + r * Math.sin(a));
  }
  return out;
}

/** Pad outline in nm, world space. */
export function padOutline(pad) {
  const { w, h } = pad;
  const local = [];
  const shape = pad.shape || 'rect';
  if (shape === 'round') {
    local.push(...circlePts(0, 0, w / 2));
  } else if (shape === 'oval' || shape === 'roundrect') {
    const r = shape === 'oval' ? Math.min(w, h) / 2 : Math.min(Math.max(pad.radius ?? 0.25, 0), 0.5) * Math.min(w, h);
    const hx = w / 2 - r, hy = h / 2 - r;
    const steps = 5;
    const corners = [[hx, hy, 0], [-hx, hy, 90], [-hx, -hy, 180], [hx, -hy, 270]];
    for (const [cx, cy, a0] of corners) {
      for (let k = 0; k <= steps; k++) {
        const a = ((a0 + (90 * k) / steps) * Math.PI) / 180;
        local.push(cx + r * Math.cos(a), cy + r * Math.sin(a));
      }
    }
  } else {
    local.push(-w / 2, -h / 2, w / 2, -h / 2, w / 2, h / 2, -w / 2, h / 2);
  }
  const out = new Array(local.length);
  for (let k = 0; k < local.length; k += 2) {
    const [rx, ry] = rotate(local[k], local[k + 1], pad.rot || 0);
    out[k] = pad.x + rx;
    out[k + 1] = pad.y + ry;
  }
  return out;
}

/** Converts a graphic primitive (nm, world) to polylines in mm: [{pts, closed, fill}]. */
function graphicPaths(g, textStrokes) {
  switch (g.t) {
    case 'line': return [{ pts: toMm([g.x1, g.y1, g.x2, g.y2]) }];
    case 'polyline': return [{ pts: toMm(g.pts) }];
    case 'poly': return [{ pts: toMm(g.pts), closed: true, fill: !!g.fill }];
    case 'rect': return [{ pts: toMm([g.x1, g.y1, g.x2, g.y1, g.x2, g.y2, g.x1, g.y2]), closed: true, fill: !!g.fill }];
    case 'circle': return [{ pts: toMm(circlePts(g.cx, g.cy, g.r + (g.fill ? (g.w || 0) / 2 : 0), 32)), closed: true, fill: !!g.fill }];
    case 'arc': return [{ pts: toMm(arcToPoints(g.cx, g.cy, g.r, g.a0, g.sweep, Math.max(g.r * 0.01, 2000))) }];
    case 'text': {
      if (!textStrokes || !g.text) return [];
      const lines = textStrokes(g.text, g.x, g.y, g.size, g.rot || 0, g.align, !!g.mirror) || [];
      return lines.map((pts) => ({ pts: toMm(pts), stroke: g.size * 0.12 * NM }));
    }
    default: return [];
  }
}

const overlaySide = (layer) => (layer === 'topOverlay' ? 'top' : layer === 'bottomOverlay' ? 'bottom' : null);
const copperSide = (layer) => (layer === 'top' ? 'top' : layer === 'bottom' ? 'bottom' : null);

/**
 * @param {object} boardDoc  BoardDoc (see model/schema.js)
 * @param {Record<string, object>} library  component definitions by id
 * @param {{pourFills?: Map<string, number[][][]>, textStrokes?: Function}} [opts]
 */
export function buildBoardScene(boardDoc, library = {}, opts = {}) {
  const board = boardDoc.board || {};
  const objects = boardDoc.objects || [];
  const T = (board.thickness || 1_600_000) * NM;
  const copper = board.copper || 2;
  const { pourFills, textStrokes } = opts;

  const maskRgb = hexToRgb(board.maskColor, '#1f5f3a');
  const silkRgb = hexToRgb(board.silkColor, '#f2f2f2');
  const finishRgb = hexToRgb(FINISH_COLORS[String(board.finish || 'ENIG').toUpperCase()] || FINISH_COLORS.ENIG);
  const tintRgb = mix(maskRgb, [0.55, 0.8, 0.45], 0.25);

  const mats = new Materials();
  const zTop = (dz) => T + dz;
  const zBot = (dz) => -dz;
  const zFor = (side, dz) => (side === 'bottom' ? zBot(dz) : zTop(dz));
  const nzFor = (side) => (side === 'bottom' ? -1 : 1);

  // Substrate: edges in FR4 color, caps in solder mask color.
  const outline = board.outline && board.outline.length >= 6 ? ccw(toMm(board.outline)) : null;
  if (outline) {
    const cutouts = (board.cutouts || []).filter((c) => c && c.length >= 6).map((c) => cw(toMm(c)));
    const edge = mats.get('substrate', hexToRgb('#c2b280'), { roughness: 0.85 });
    edge.wall(outline, 0, T);
    for (const c of cutouts) edge.wall(c, 0, T);
    const mask = mats.get('mask', maskRgb, { roughness: 0.35 });
    mask.polygon(outline, cutouts, T, 1);
    mask.polygon(outline, cutouts, 0, -1);
  }

  const holeMat = mats.get('holes', hexToRgb('#141414'), { roughness: 0.95 });
  const pad = (side) => mats.get(`pads:${side}`, finishRgb, { metal: 1, roughness: 0.32, side });
  const silk = (side) => mats.get(`silk:${side}`, silkRgb, { roughness: 0.85, side });
  const tint = (side) => mats.get(`copper:${side}`, tintRgb, { roughness: 0.35, side });

  const drawHole = (x, y, drill) => {
    const r = (drill / 2) * NM;
    holeMat.disc(x * NM, y * NM, r, zTop(Z_HOLE), 1);
    holeMat.disc(x * NM, y * NM, r, zBot(Z_HOLE), -1);
  };

  const drawPad = (p) => {
    const ring = toMm(padOutline(p));
    if (p.side === 'thru') {
      const hole = p.drill ? [circlePts(p.x * NM, p.y * NM, (p.drill / 2) * NM)] : [];
      if (p.plated !== false) {
        pad('top').polygon(ring, hole, zTop(Z_PAD), 1);
        pad('bottom').polygon(ring, hole, zBot(Z_PAD), -1);
      }
      if (p.drill) drawHole(p.x, p.y, p.drill);
    } else {
      const side = p.side === 'bottom' ? 'bottom' : 'top';
      pad(side).polygon(ring, null, zFor(side, Z_PAD), nzFor(side));
    }
  };

  const drawSilkPaths = (paths, side, defaultWidth) => {
    const g = silk(side);
    const z = zFor(side, Z_SILK), nz = nzFor(side);
    for (const path of paths) {
      if (path.fill && path.pts.length >= 6) g.polygon(path.pts, null, z, nz);
      else g.ribbon(path.pts, path.stroke ?? defaultWidth, z, nz, !!path.closed);
    }
  };

  const drawText = (text, x, y, size, rot, align, mirror, side, width) => {
    if (!textStrokes || !text) return;
    const lines = textStrokes(text, x, y, size, rot, align, mirror) || [];
    const g = silk(side);
    for (const pts of lines) g.ribbon(toMm(pts), (width || size * 0.12) * NM, zFor(side, Z_SILK), nzFor(side));
  };

  for (const obj of objects) {
    switch (obj.t) {
      case 'comp': {
        const def = library[obj.comp];
        if (!def) break;
        const placed = placeFootprint(def, obj, copper);
        for (const p of placed.pads) drawPad(p);
        for (const g of placed.graphics) {
          const side = overlaySide(g.layer);
          if (!side) continue;
          drawSilkPaths(graphicPaths(g, textStrokes), side, (g.w || 120_000) * NM);
        }
        const compSide = obj.side === 'bottom' ? 'bottom' : 'top';
        const f = obj.fields?.designator;
        if (obj.designator && !f?.hidden) {
          let x = obj.x, y = obj.y;
          const h = f?.h || 1_000_000;
          if (f) { x += f.dx; y += f.dy; } else if (placed.courtyard) {
            let maxY = -Infinity;
            for (let k = 1; k < placed.courtyard.length; k += 2) maxY = Math.max(maxY, placed.courtyard[k]);
            y = maxY + h * 0.8;
          }
          drawText(obj.designator, x, y, h, f?.rot ?? 0, { h: 'center', v: 'middle' }, compSide === 'bottom', compSide);
        }
        if (placed.body) drawBody(mats, def, obj, placed, T);
        break;
      }
      case 'via': {
        const side = 'top';
        const r = (obj.d / 2) * NM;
        tint(side).disc(obj.x * NM, obj.y * NM, r, zTop(Z_TINT), 1);
        tint('bottom').disc(obj.x * NM, obj.y * NM, r, zBot(Z_TINT), -1);
        drawHole(obj.x, obj.y, obj.drill);
        break;
      }
      case 'pad': drawPad({ ...obj, side: obj.side || 'top' }); break;
      case 'track': case 'arc': {
        const pts = obj.t === 'track'
          ? toMm([obj.x1, obj.y1, obj.x2, obj.y2])
          : toMm(arcToPoints(obj.cx, obj.cy, obj.r, obj.a0, obj.sweep, Math.max(obj.r * 0.01, 2000)));
        const cs = copperSide(obj.layer), os = overlaySide(obj.layer);
        if (cs) tint(cs).ribbon(pts, obj.w * NM, zFor(cs, Z_TINT), nzFor(cs));
        else if (os) silk(os).ribbon(pts, obj.w * NM, zFor(os, Z_SILK), nzFor(os));
        break;
      }
      case 'fill': {
        const cs = copperSide(obj.layer);
        if (cs) tint(cs).polygon(toMm([obj.x1, obj.y1, obj.x2, obj.y1, obj.x2, obj.y2, obj.x1, obj.y2]), null, zFor(cs, Z_TINT), nzFor(cs));
        break;
      }
      case 'region': {
        const cs = copperSide(obj.layer);
        if (cs && obj.pts?.length >= 6) tint(cs).polygon(toMm(obj.pts), null, zFor(cs, Z_TINT), nzFor(cs));
        break;
      }
      case 'pour': {
        const cs = copperSide(obj.layer);
        const polys = pourFills?.get(obj.id);
        if (!cs || !polys) break;
        for (const [outer, ...holes] of polys) {
          if (!outer || outer.length < 6) continue;
          tint(cs).polygon(toMm(outer), holes.map(toMm), zFor(cs, Z_TINT), nzFor(cs));
        }
        break;
      }
      case 'text': {
        const os = overlaySide(obj.layer);
        if (os) drawText(obj.text, obj.x, obj.y, obj.h, obj.rot || 0, { h: 'left', v: 'bottom' }, !!obj.mirror, os, obj.w);
        break;
      }
      default: break;
    }
  }

  const meshes = mats.meshes();
  const b = bboxEmpty();
  let zMin = Infinity, zMax = -Infinity;
  for (const m of meshes) {
    const p = m.positions;
    for (let k = 0; k < p.length; k += 3) {
      bboxAdd(b, p[k], p[k + 1]);
      if (p[k + 2] < zMin) zMin = p[k + 2];
      if (p[k + 2] > zMax) zMax = p[k + 2];
    }
  }
  const bounds = meshes.length
    ? { min: [b.minX, b.minY, zMin], max: [b.maxX, b.maxY, zMax] }
    : { min: [0, 0, 0], max: [0, 0, 0] };
  return { meshes, bounds, thickness: T };
}

function drawBody(mats, def, comp, placed, T) {
  const body = placed.body;
  if (!(body.w > 0 && body.h > 0 && body.height > 0)) return;
  const color = body.color || '#2b2b2b';
  const g = mats.get(`body:${color}`, hexToRgb(color), { roughness: 0.6 });
  const t = placed.t;
  const bx = body.x || 0, by = body.y || 0;
  const bottom = comp.side === 'bottom';
  const height = body.height * NM;
  const z0 = bottom ? -BODY_STANDOFF - height : T + BODY_STANDOFF;
  const z1 = z0 + height;
  const toWorld = (x, y) => apply(t, x, y).map((v) => v * NM);

  let ring;
  if (body.shape === 'cylinder') {
    ring = [];
    for (let k = 0; k < 28; k++) {
      const a = (k / 28) * Math.PI * 2;
      ring.push(...toWorld(bx + (body.w / 2) * Math.cos(a), by + (body.h / 2) * Math.sin(a)));
    }
    ring = ccw(ring);
    const [cx, cy] = toWorld(bx, by);
    const n = ring.length / 2;
    for (let k = 0; k < n; k++) {
      const j = (k + 1) % n;
      const ax = ring[2 * k], ay = ring[2 * k + 1], qx = ring[2 * j], qy = ring[2 * j + 1];
      const na = norm2(ax - cx, ay - cy), nb = norm2(qx - cx, qy - cy);
      const v0 = g.vert(ax, ay, z0, na[0], na[1], 0);
      const v1 = g.vert(qx, qy, z0, nb[0], nb[1], 0);
      const v2 = g.vert(qx, qy, z1, nb[0], nb[1], 0);
      const v3 = g.vert(ax, ay, z1, na[0], na[1], 0);
      g.tri(v0, v1, v2);
      g.tri(v0, v2, v3);
    }
  } else {
    const hw = body.w / 2, hh = body.h / 2;
    ring = ccw([...toWorld(bx - hw, by - hh), ...toWorld(bx + hw, by - hh), ...toWorld(bx + hw, by + hh), ...toWorld(bx - hw, by + hh)]);
    g.wall(ring, z0, z1);
  }
  g.polygon(ring, null, z1, 1);
  g.polygon(ring, null, z0, -1);

  // Pin 1 marker on the visible face of multi-pin packages.
  const pads = def.footprint?.pads || [];
  if (pads.length >= 3) {
    const p1 = pads.find((p) => p.num === '1') || pads[0];
    const m = Math.min(body.w, body.h) * 0.22;
    const lx = bx + Math.max(-(body.w / 2 - m), Math.min(body.w / 2 - m, p1.x - bx));
    const ly = by + Math.max(-(body.h / 2 - m), Math.min(body.h / 2 - m, p1.y - by));
    const [dx, dy] = toWorld(lx, ly);
    const dot = mats.get('body:marker', hexToRgb('#8c8c8c'), { roughness: 0.5 });
    const r = Math.min(body.w, body.h) * 0.07 * NM;
    if (bottom) dot.disc(dx, dy, r, z0 - 0.005, -1, 14);
    else dot.disc(dx, dy, r, z1 + 0.005, 1, 14);
  }
}

function norm2(x, y) {
  const l = Math.hypot(x, y) || 1;
  return [x / l, y / l];
}
