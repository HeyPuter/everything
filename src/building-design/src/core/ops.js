/**
 * Modeling operations. They edit the document and expect to run inside a
 * transaction (the caller names the undo step).
 */
import { add, sub, scale, dot, rotate, reflect, dist, norm, perp, lineIntersect, closestOnLine, angleOf, len } from './geom.js';
import { wallAxis } from './model.js';
import { isView } from './doc.js';

/** Point-valued fields of elements. */
const POINT_FIELDS = ['a', 'b', 'at', 'origin', 'line', 'tagAt', 'c', 'leader'];
const POLY_FIELDS = ['boundary', 'path', 'leaders'];

/** Kinds whose `rotation` (degrees) turns with them. */
const ROTATING = new Set(['component', 'column', 'text', 'group', 'symbol', 'detailItem', 'image', 'link']);

// Deleting ----------------------------------------------------------------------------

/**
 * Delete elements and whatever depends on them: hosted doors and windows,
 * tags, dimension references, views of deleted levels and their content.
 * Returns the set of deleted ids.
 */
export function deleteElements(doc, ids, { keepEmptyGroups = false } = {}) {
  const gone = new Set();
  const queue = [...ids];
  while (queue.length) {
    const id = queue.pop();
    if (gone.has(id) || !doc.has(id) || id === 'project') continue;
    gone.add(id);
    const el = doc.get(id);
    for (const other of doc.items.values()) {
      if (gone.has(other.id)) continue;
      if (other.hostId === id || other.targetId === id || other.viewId === id || other.placedId === id || other.groupId === id || other.wallId === id || other.stairId === id) queue.push(other.id);
      else if (el.kind === 'level' && (other.levelId === id || (isView(other) && other.levelId === id))) queue.push(other.id);
    }
  }
  const emptied = new Set([...gone].map((id) => doc.get(id)?.groupId).filter(Boolean));
  for (const id of gone) doc.remove(id);
  // A group whose last member is gone goes too.
  if (emptied.size && !keepEmptyGroups) {
    for (const el of doc.items.values()) if (el.groupId) emptied.delete(el.groupId);
    for (const g of emptied) doc.remove(g);
  }
  // Clean up references held by survivors.
  for (const other of [...doc.items.values()]) {
    if (other.kind === 'dimension' && other.refs?.some((r) => gone.has(r.id))) {
      const refs = other.refs.map((r) => (gone.has(r.id) ? { at: r.at } : r));
      doc.update(other.id, { refs });
    } else if (other.kind === 'sheet' && other.viewports?.some((v) => gone.has(v.viewId))) {
      doc.update(other.id, { viewports: other.viewports.filter((v) => !gone.has(v.viewId)) });
    } else if ((other.kind === 'wall' || other.kind === 'column' || other.kind === 'stair') && gone.has(other.topLevelId)) {
      doc.update(other.id, { topLevelId: null });
    }
  }
  return gone;
}

// Transforms ---------------------------------------------------------------------------

/**
 * Patch applying a plan transform to an element's geometry.
 * xf: { point(p), angle (radians added to rotations), mirror (bool) }
 */
export function transformPatch(el, xf) {
  const patch = {};
  for (const f of POINT_FIELDS) if (Array.isArray(el[f]) && typeof el[f][0] === 'number') patch[f] = xf.point(el[f]);
  for (const f of POLY_FIELDS) if (Array.isArray(el[f])) patch[f] = el[f].map(xf.point);
  if (Array.isArray(el.holes)) patch.holes = el.holes.map((h) => h.map(xf.point));
  if (el.kind === 'topo' && Array.isArray(el.points)) patch.points = el.points.map((p) => [...xf.point(p), p[2]]);
  if (el.crop && el.calloutOf) {
    const p = xf.point([el.crop.x0, el.crop.y0]);
    const q = xf.point([el.crop.x1, el.crop.y1]);
    patch.crop = { x0: Math.min(p[0], q[0]), y0: Math.min(p[1], q[1]), x1: Math.max(p[0], q[0]), y1: Math.max(p[1], q[1]) };
  }
  if (el.kind === 'dimension') {
    if (el.refs) patch.refs = el.refs.map((r) => ({ ...r, at: xf.point(r.at) }));
    if (el.dir) patch.dir = norm(sub(xf.point(add(el.line, el.dir)), xf.point(el.line)));
  }
  const deg = ((xf.angle || 0) * 180) / Math.PI;
  if (ROTATING.has(el.kind)) {
    let r = +el.rotation || 0;
    if (xf.mirror) r = xf.mirrorAngle(r);
    else r += deg;
    patch.rotation = normalizeDeg(r);
  }
  // Angles in radians: arcs and angular dimensions keep their sweep, which a mirror reverses.
  const rad = (a) => (xf.mirror ? (xf.mirrorAngle((a * 180) / Math.PI) * Math.PI) / 180 : a + (xf.angle || 0));
  if (el.kind === 'detailArc' || el.kind === 'angularDim') {
    if (xf.mirror) {
      patch.a0 = rad(el.a1);
      patch.a1 = rad(el.a0);
      while (patch.a1 <= patch.a0) patch.a1 += Math.PI * 2;
    } else {
      patch.a0 = rad(el.a0);
      patch.a1 = rad(el.a1);
    }
  }
  if (el.kind === 'radialDim') patch.angle = rad(+el.angle || 0);
  if (xf.scale && (el.kind === 'detailArc' || el.kind === 'angularDim' || el.kind === 'radialDim') && el.r) patch.r = el.r * xf.scale;
  if (el.kind === 'elevation') {
    const look = [Math.cos(el.look), Math.sin(el.look)];
    const p0 = xf.point(el.origin);
    const p1 = xf.point(add(el.origin, look));
    patch.look = angleOf(sub(p1, p0));
  }
  if (xf.mirror) {
    if (el.kind === 'wall') patch.flipped = !el.flipped;
    if (el.kind === 'section') patch.flip = !el.flip;
    if (el.kind === 'door' || el.kind === 'window') patch.flipHand = !el.flipHand;
  }
  return patch;
}

function normalizeDeg(d) {
  let r = d % 360;
  if (r > 180) r -= 360;
  if (r <= -180) r += 360;
  return Math.round(r * 1e6) / 1e6;
}

export function translation(d) {
  return { point: (p) => [p[0] + d[0], p[1] + d[1]], angle: 0 };
}

export function rotation(center, angle) {
  return { point: (p) => rotate(p, angle, center), angle };
}

/** Uniform scaling about a base point (positions and lengths; sizes of types stay). */
export function scaling(base, k) {
  return { point: (p) => [base[0] + (p[0] - base[0]) * k, base[1] + (p[1] - base[1]) * k], angle: 0, scale: k };
}

export function mirrorAcross(a, b) {
  const axisDeg = (angleOf(sub(b, a)) * 180) / Math.PI;
  return { point: (p) => reflect(p, a, b), mirror: true, mirrorAngle: (r) => 2 * axisDeg - r };
}

/** Ids plus the members of any groups among them. */
export function expandGroups(doc, ids) {
  const set = new Set(ids);
  const groups = new Set([...set].filter((id) => doc.get(id)?.kind === 'group'));
  if (groups.size) for (const el of doc.items.values()) if (groups.has(el.groupId)) set.add(el.id);
  return set;
}

/** Elements that move with their hosts are skipped when their host moves too. */
function movable(doc, ids) {
  const set = expandGroups(doc, ids);
  return [...set].map((id) => doc.get(id)).filter((el) => el && el.id !== 'project' && !(el.hostId && set.has(el.hostId)) && el.kind !== 'level' && !el.pinned);
}

export function transformElements(doc, ids, xf) {
  for (const el of movable(doc, ids)) {
    if (el.hostId) {
      // A hosted element alone: slide along its host.
      const host = doc.get(el.hostId);
      if (!host) continue;
      const ax = wallAxis(doc, host);
      const p = add(ax.a, scale(ax.dir, el.t));
      const q = xf.point(p);
      const patch = { t: Math.max(0, Math.min(ax.length, dot(sub(q, ax.a), ax.dir))) };
      if (xf.mirror) patch.flipHand = !el.flipHand;
      doc.update(el.id, patch);
      continue;
    }
    const patch = transformPatch(el, xf);
    if (Object.keys(patch).length) doc.update(el.id, patch);
  }
}

export function moveElements(doc, ids, d) {
  transformElements(doc, ids, translation(d));
}

/**
 * Copy elements with a transform. Hosted elements of copied walls come
 * along. Returns the ids of the new elements (top-level copies first).
 */
export function copyElements(doc, ids, xf, { levelId = null } = {}) {
  const set = expandGroups(doc, ids);
  const map = new Map();
  const out = [];
  const levelElev = levelId ? doc.get(levelId)?.elevation ?? 0 : 0;
  for (const el of [...set].map((id) => doc.get(id)).filter(Boolean)) {
    if (el.kind === 'level' || el.id === 'project' || isView(el)) continue;
    if (el.hostId && set.has(el.hostId)) continue;
    const { id: _id, ...rest } = el;
    void _id;
    const patch = el.hostId ? {} : transformPatch(el, xf);
    const extra = {};
    if (levelId && el.levelId) {
      extra.levelId = levelId;
      // Keep the top constraint relative when pasting to another level.
      if (el.topLevelId) {
        const above = doc.levels().find((l) => l.elevation > levelElev + 1);
        extra.topLevelId = above ? above.id : null;
        if (!above) extra.height = (doc.get(el.topLevelId)?.elevation ?? 0) - (doc.get(el.levelId)?.elevation ?? 0) || el.height;
      }
    }
    if (el.mark) extra.mark = nextMark(doc, el.kind);
    if (el.kind === 'room') extra.number = nextRoomNumber(doc);
    if (el.kind === 'grid') extra.name = nextGridName(doc, el.name);
    let copy;
    if (el.hostId) {
      const host = doc.get(el.hostId);
      if (!host) continue;
      const ax = wallAxis(doc, host);
      const q = xf.point(add(ax.a, scale(ax.dir, el.t)));
      copy = doc.add({ ...rest, ...extra, t: Math.max(0, Math.min(ax.length, dot(sub(q, ax.a), ax.dir))) });
    } else copy = doc.add({ ...rest, ...patch, ...extra });
    map.set(el.id, copy.id);
    out.push(copy.id);
  }
  // Hosted elements of copied hosts.
  for (const [oldId, newId] of [...map]) {
    const old = doc.get(oldId);
    if (old?.kind !== 'wall') continue;
    for (const k of ['door', 'window', 'opening']) {
      for (const h of doc.all(k)) {
        if (h.hostId !== oldId || map.has(h.id)) continue;
        const { id: _hid, ...hr } = h;
        void _hid;
        const c = doc.add({ ...hr, hostId: newId, mark: h.mark ? nextMark(doc, h.kind) : h.mark, ...(h.kind === 'window' && levelId ? {} : {}) });
        map.set(h.id, c.id);
        out.push(c.id);
      }
    }
  }
  // Copied members belong to the copied group; members copied alone leave their group.
  for (const [oldId, newId] of map) {
    const g = doc.get(oldId)?.groupId;
    if (g) doc.update(newId, { groupId: map.get(g) ?? doc.addDefaults?.fields?.groupId ?? null });
  }
  return out;
}

// Walls ---------------------------------------------------------------------------------

/**
 * Split a line-like element (wall, line, beam...) at the point nearest p,
 * leaving a gap of `gap` millimetres centred there. Returns the new piece.
 */
export function splitLinear(doc, el, p, gap = 0) {
  const L = dist(el.a, el.b);
  const d = norm(sub(el.b, el.a));
  const t = dot(sub(p, el.a), d);
  const g = Math.max(0, gap) / 2;
  if (t - g <= 10 || t + g >= L - 10) return null;
  if (el.kind === 'wall') {
    const second = splitWall(doc, el, p);
    if (!second || !g) return second;
    doc.update(el.id, { b: sub(doc.get(el.id).b, scale(d, g)) });
    doc.update(second.id, { a: add(second.a, scale(d, g)) });
    for (const h of doc.all('door', 'window', 'opening')) if (h.hostId === second.id) doc.update(h.id, { t: h.t - g });
    return doc.get(second.id);
  }
  const m = add(el.a, scale(d, t));
  const { id: _id, ...rest } = el;
  void _id;
  doc.update(el.id, { b: sub(m, scale(d, g)) });
  return doc.add({ ...rest, a: add(m, scale(d, g)) });
}

/** Split a wall at the point nearest p; hosted elements go with their half. */
export function splitWall(doc, wall, p) {
  const ax = wallAxis(doc, wall);
  const t = dot(sub(p, wall.a), norm(sub(wall.b, wall.a)));
  const L = dist(wall.a, wall.b);
  if (t < 10 || t > L - 10) return null;
  const m = add(wall.a, scale(norm(sub(wall.b, wall.a)), t));
  doc.update(wall.id, { b: m });
  const { id: _id, ...rest } = doc.get(wall.id);
  void _id;
  const second = doc.add({ ...rest, a: m, b: wall.b, mark: '' });
  void ax;
  for (const k of ['door', 'window', 'opening']) {
    for (const h of doc.all(k)) {
      if (h.hostId !== wall.id) continue;
      if (h.t > t) doc.update(h.id, { hostId: second.id, t: h.t - t });
    }
  }
  return second;
}

/**
 * Trim or extend two walls to meet at the intersection of their location
 * lines. pickA/pickB tell which side of the intersection to keep.
 */
export function cornerWalls(doc, wa, pickA, wb, pickB) {
  const hit = lineIntersect(wa.a, sub(wa.b, wa.a), wb.a, sub(wb.b, wb.a));
  if (!hit) return false;
  const x = hit.point;
  const fix = (w, pick) => {
    // Keep the part of the wall that was picked; its other end moves to the intersection.
    const d = sub(w.b, w.a);
    const l2 = dot(d, d) || 1;
    const s = dot(sub(x, w.a), d) / l2;
    const sp = dot(sub(pick, w.a), d) / l2;
    if (sp < s) doc.update(w.id, { b: x });
    else doc.update(w.id, { a: x });
  };
  fix(wa, pickA);
  fix(wb, pickB);
  return true;
}

/** Extend or trim one element's nearest end to a reference line. */
export function extendToLine(doc, el, pick, refA, refB) {
  const hit = lineIntersect(el.a, sub(el.b, el.a), refA, sub(refB, refA));
  if (!hit) return false;
  const x = hit.point;
  // Keep the end that lies on the picked side of the reference.
  const side = (p) => Math.sign((refB[0] - refA[0]) * (p[1] - refA[1]) - (refB[1] - refA[1]) * (p[0] - refA[0]));
  const sp = side(pick);
  if (side(el.a) === sp && side(el.b) !== sp) doc.update(el.id, { b: x });
  else if (side(el.b) === sp && side(el.a) !== sp) doc.update(el.id, { a: x });
  else if (dist(el.a, x) < dist(el.b, x)) doc.update(el.id, { a: x });
  else doc.update(el.id, { b: x });
  return true;
}

/** Copy a wall (or line) parallel at a distance on the side of `toward`. */
export function offsetElement(doc, el, distance, toward) {
  const d = norm(sub(el.b, el.a));
  const n = perp(d);
  const s = dot(sub(toward, el.a), n) >= 0 ? 1 : -1;
  const off = scale(n, s * distance);
  const { id: _id, ...rest } = el;
  void _id;
  return doc.add({ ...rest, a: add(el.a, off), b: add(el.b, off), mark: el.mark ? '' : el.mark });
}

/** Linear array: count total items (including the original) spaced by d. */
export function arrayLinear(doc, ids, d, count) {
  const out = [];
  for (let i = 1; i < count; i++) out.push(...copyElements(doc, ids, translation(scale(d, i))));
  return out;
}

// Naming ------------------------------------------------------------------------------------

export function nextMark(doc, kind) {
  let max = 0;
  const prefix = kind === 'window' ? 'W' : '';
  for (const el of doc.all(kind)) {
    const m = /(\d+)$/.exec(String(el.mark || ''));
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `${prefix}${max + 1}`;
}

export function nextRoomNumber(doc, levelId) {
  let max = 0;
  for (const r of doc.all('room')) {
    const n = parseInt(r.number, 10);
    if (Number.isFinite(n)) max = Math.max(max, n);
  }
  if (!max && levelId) {
    const idx = doc.levels().findIndex((l) => l.id === levelId);
    return String((idx + 1) * 100 + 1);
  }
  return String(max ? max + 1 : 101);
}

/** Next grid name: numbers continue numbers, letters continue letters. */
export function nextGridName(doc, after) {
  const names = new Set(doc.all('grid').map((g) => g.name));
  const isLetter = after != null ? /^[A-Z]+$/i.test(after) : false;
  let candidate = after;
  if (candidate == null) {
    candidate = '1';
    while (names.has(candidate)) candidate = String(+candidate + 1);
    return candidate;
  }
  for (let i = 0; i < 1000; i++) {
    candidate = isLetter ? incLetters(candidate.toUpperCase()) : /^\d+$/.test(candidate) ? String(+candidate + 1) : `${candidate}'`;
    if (!names.has(candidate)) return candidate;
  }
  return `${after}-1`;
}

function incLetters(s) {
  const chars = s.split('');
  let i = chars.length - 1;
  while (i >= 0) {
    if (chars[i] === 'Z') {
      chars[i] = 'A';
      i--;
    } else {
      chars[i] = String.fromCharCode(chars[i].charCodeAt(0) + 1);
      return chars.join('');
    }
  }
  return `A${chars.join('')}`;
}

export function uniqueName(existing, base) {
  const names = new Set(existing);
  if (!names.has(base)) return base;
  const m = /^(.*?)(\s*)(\d+)$/.exec(base);
  let stem = base;
  let n = 2;
  if (m) {
    stem = m[1] + m[2];
    n = parseInt(m[3], 10) + 1;
  } else stem = `${base} `;
  while (names.has(`${stem}${n}`)) n++;
  return `${stem}${n}`;
}

/** Nearest point on a wall's location line, with the parameter along it. */
export function wallParamAt(doc, wall, p) {
  const ax = wallAxis(doc, wall);
  const c = closestOnLine(p, ax.a, ax.b);
  return { t: Math.max(0, Math.min(ax.length, c.t * ax.length)), point: c.point, axis: ax, offset: dot(sub(p, ax.a), ax.n) };
}

export function segmentLength(a, b) {
  return len(sub(b, a));
}
