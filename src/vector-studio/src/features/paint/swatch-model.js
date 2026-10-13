/**
 * Swatch storage and global swatches.
 *
 * doc.root.swatches is a flat list of { id, name, paint, global?, mode?,
 * group? } (group = id of a color group). Color groups live in
 * doc.root.swatchGroups as [{ id, name }]; the Swatches panel lists
 * ungrouped swatches first, then each group as a folder row followed by its
 * swatches. Keeping swatches flat means simple consumers (the fill/stroke
 * popover) can still list every swatch without knowing about groups.
 *
 * Global swatches: a paint applied from a global swatch keeps
 * `swatchId` (solid paints, and gradient stops via stop.swatchId). Editing
 * the swatch rewrites every paint that references it, in the same undo step.
 */
import { uid } from '../../lib/ids.js';

export function swatchesOf(doc) {
  return doc.root.swatches || [];
}

export function groupsOf(doc) {
  return doc.root.swatchGroups || [];
}

export function findSwatch(doc, id) {
  return swatchesOf(doc).find((s) => s.id === id) || null;
}

export function newSwatchId() {
  return uid('sw');
}

/** Paint to apply from a swatch: a copy, linked to it when the swatch is global. */
export function paintFromSwatch(sw) {
  const p = structuredClone(sw.paint);
  if (!p) return null;
  delete p.swatchId;
  if (sw.global && p.type === 'solid') p.swatchId = sw.id;
  return p;
}

/** Insert a swatch (inside a transaction). Returns its id. */
export function addSwatch(doc, swatch, index = Infinity) {
  const list = swatchesOf(doc).slice();
  const sw = { id: swatch.id || newSwatchId(), name: swatch.name || 'Swatch', paint: swatch.paint, ...(swatch.global || swatch.spot ? { global: true } : {}), ...(swatch.spot ? { spot: true } : {}), ...(swatch.mode ? { mode: swatch.mode } : {}), ...(swatch.group ? { group: swatch.group } : {}) };
  list.splice(Math.max(0, Math.min(list.length, index)), 0, sw);
  doc.updateRoot({ swatches: list });
  return sw.id;
}

/** Remove swatches and groups; paints linked to removed global swatches keep their color. */
export function removeSwatches(doc, ids) {
  const set = new Set(ids);
  const removedGroups = new Set(groupsOf(doc).filter((g) => set.has(g.id)).map((g) => g.id));
  const keep = swatchesOf(doc).filter((s) => !set.has(s.id) && !removedGroups.has(s.group));
  const removed = swatchesOf(doc).filter((s) => !keep.includes(s));
  const patch = { swatches: keep };
  if (removedGroups.size) patch.swatchGroups = groupsOf(doc).filter((g) => !removedGroups.has(g.id));
  doc.updateRoot(patch);
  const unlink = new Set(removed.filter((s) => s.global).map((s) => s.id));
  if (unlink.size) rewriteSwatchRefs(doc, (id) => unlink.has(id), () => null);
}

/** Update a swatch; when it is global, every paint linked to it follows. */
export function updateSwatch(doc, id, patch) {
  const list = swatchesOf(doc);
  const i = list.findIndex((s) => s.id === id);
  if (i < 0) return;
  const prev = list[i];
  const next = { ...prev, ...patch };
  // Spot colors are always global.
  if (next.spot) next.global = true;
  else delete next.spot;
  if (!next.global) delete next.global;
  const copy = list.slice();
  copy[i] = next;
  doc.updateRoot({ swatches: copy });
  if (prev.global && !next.global) rewriteSwatchRefs(doc, (sid) => sid === id, () => null);
  else if (next.global && patch.paint) rewriteSwatchRefs(doc, (sid) => sid === id, () => next.paint);
}

/**
 * Walk every paintable node and rewrite paints linked to swatches that
 * match `test`. `paintFor(swatchId)` returns the swatch's new paint, or null
 * to just unlink (keep the current color).
 */
export function rewriteSwatchRefs(doc, test, paintFor, relinkTo) {
  for (const node of doc.nodes.values()) {
    if (node.type !== 'path' && node.type !== 'compound' && node.type !== 'text') continue;
    const patch = {};
    for (const key of ['fill', 'stroke']) {
      const p = node[key];
      if (!p) continue;
      const next = rewritePaint(p, test, paintFor, relinkTo);
      if (next !== p) patch[key] = next;
    }
    // Styled characters in type can link to swatches too.
    if (node.type === 'text' && node.runs) {
      let changed = false;
      const runs = node.runs.map((r) => {
        let out = r;
        for (const key of ['fill', 'stroke']) {
          if (!r[key]) continue;
          const next = rewritePaint(r[key], test, paintFor, relinkTo);
          if (next !== r[key]) {
            if (out === r) out = { ...r };
            out[key] = next;
            changed = true;
          }
        }
        return out;
      });
      if (changed) patch.runs = runs;
    }
    if (Object.keys(patch).length) doc.update(node.id, patch);
  }
}

/** `relinkTo` (when given) moves the link to that swatch id, or drops it when null. */
function relink(out, relinkTo) {
  if (relinkTo === undefined) return out;
  if (relinkTo) out.swatchId = relinkTo;
  else delete out.swatchId;
  return out;
}

function rewritePaint(p, test, paintFor, relinkTo) {
  if (p.type === 'solid' && p.swatchId && test(p.swatchId)) {
    const src = paintFor(p.swatchId);
    if (!src) {
      const out = { ...p };
      delete out.swatchId;
      return out;
    }
    if (src.type === 'solid') return relink({ ...p, color: tinted(src.color, p.tint), swatchId: p.swatchId }, relinkTo);
    return p;
  }
  if ((p.type === 'linear' || p.type === 'radial') && p.stops.some((s) => s.swatchId && test(s.swatchId))) {
    return {
      ...p,
      stops: p.stops.map((s) => {
        if (!s.swatchId || !test(s.swatchId)) return s;
        const src = paintFor(s.swatchId);
        if (!src) {
          const out = { ...s };
          delete out.swatchId;
          return out;
        }
        return src.type === 'solid' ? relink({ ...s, color: src.color }, relinkTo) : s;
      }),
    };
  }
  return p;
}

/** Count objects using a global swatch. */
export function swatchUsage(doc, id) {
  let n = 0;
  const uses = (p) => p && (p.swatchId === id || ((p.type === 'linear' || p.type === 'radial') && p.stops.some((s) => s.swatchId === id)));
  for (const node of doc.nodes.values()) {
    if (uses(node.fill) || uses(node.stroke) || (node.type === 'text' && node.runs?.some((r) => uses(r.fill) || uses(r.stroke)))) n++;
  }
  return n;
}

/**
 * Move swatches to a position in the flat list (before `beforeId`, or the
 * end when null) and into a group (null = ungrouped).
 */
export function moveSwatches(doc, ids, beforeId, group = null) {
  const set = new Set(ids);
  const list = swatchesOf(doc);
  const moving = list.filter((s) => set.has(s.id)).map((s) => {
    const out = { ...s };
    if (group) out.group = group;
    else delete out.group;
    return out;
  });
  const rest = list.filter((s) => !set.has(s.id));
  let at = beforeId ? rest.findIndex((s) => s.id === beforeId) : rest.length;
  if (at < 0) at = rest.length;
  rest.splice(at, 0, ...moving);
  doc.updateRoot({ swatches: rest });
}

/** New color group holding copies of the given paints (or moving existing swatch ids). */
export function addGroup(doc, name, { paints = [], swatchIds = [] } = {}) {
  const gid = uid('swg');
  doc.updateRoot({ swatchGroups: [...groupsOf(doc), { id: gid, name: name || 'Color Group' }] });
  if (swatchIds.length) moveSwatches(doc, swatchIds, null, gid);
  for (const p of paints) addSwatch(doc, { name: p.name, paint: p.paint, group: gid });
  return gid;
}

export function renameGroup(doc, id, name) {
  doc.updateRoot({ swatchGroups: groupsOf(doc).map((g) => (g.id === id ? { ...g, name } : g)) });
}

/**
 * Display order for the panel: [{ kind: 'swatch', swatch } | { kind: 'group', group }]
 * filtered by kind ('all' | 'color' | 'gradient' | 'pattern') and a search string.
 */
export function swatchRows(doc, { show = 'all', query = '' } = {}) {
  const q = query.trim().toLowerCase();
  const match = (s) => {
    if (!s.paint) return false;
    if (show === 'color' && s.paint.type !== 'solid') return false;
    if (show === 'gradient' && s.paint.type !== 'linear' && s.paint.type !== 'radial') return false;
    if (show === 'pattern' && s.paint.type !== 'pattern') return false;
    if (q && !(s.name || '').toLowerCase().includes(q) && !(s.paint.color || '').toLowerCase().includes(q)) return false;
    return true;
  };
  const groups = groupsOf(doc);
  const gids = new Set(groups.map((g) => g.id));
  const rows = [];
  for (const s of swatchesOf(doc)) if ((!s.group || !gids.has(s.group)) && match(s)) rows.push({ kind: 'swatch', swatch: s });
  for (const g of groups) {
    const kids = swatchesOf(doc).filter((s) => s.group === g.id && match(s));
    if (q && !kids.length && !g.name.toLowerCase().includes(q)) continue;
    rows.push({ kind: 'group', group: g });
    for (const s of kids) rows.push({ kind: 'swatch', swatch: s });
  }
  return rows;
}

/** A readable name for a new color swatch, like "R=237 G=28 B=36". */
export function colorName(hex) {
  const n = parseInt(hex.slice(1), 16);
  return `R=${(n >> 16) & 255} G=${(n >> 8) & 255} B=${n & 255}`;
}

/**
 * A tint of a global color: `tint` 0..1 mixes the color toward white
 * (1 = the full color). Paints linked to a global swatch may carry a tint.
 */
export function tinted(hex, tint) {
  if (tint == null || tint >= 1) return hex;
  const t = Math.max(0, Math.min(1, tint));
  const n = parseInt(hex.slice(1), 16);
  const ch = (v) => Math.round(255 - (255 - v) * t).toString(16).padStart(2, '0');
  return `#${ch((n >> 16) & 255)}${ch((n >> 8) & 255)}${ch(n & 255)}`;
}

/** Copies of swatches placed right after each original, named "<name> copy". Returns the new ids. */
export function duplicateSwatches(doc, ids) {
  const set = new Set(ids);
  const out = [];
  const list = [];
  for (const s of swatchesOf(doc)) {
    list.push(s);
    if (!set.has(s.id)) continue;
    const copy = { ...structuredClone(s), id: newSwatchId(), name: `${s.name} copy` };
    list.push(copy);
    out.push(copy.id);
  }
  doc.updateRoot({ swatches: list });
  return out;
}

/**
 * Merge swatches into the first one: the others are removed, and objects
 * linked to them link to (and take the color of) the first, or just keep
 * its color when it is not global.
 */
export function mergeSwatches(doc, ids) {
  const list = swatchesOf(doc);
  const ordered = list.filter((s) => ids.includes(s.id));
  if (ordered.length < 2) return null;
  const [keep, ...rest] = ordered;
  const gone = new Set(rest.map((s) => s.id));
  doc.updateRoot({ swatches: list.filter((s) => !gone.has(s.id)) });
  if (keep.paint?.type === 'solid') rewriteSwatchRefs(doc, (id) => gone.has(id), () => keep.paint, keep.global ? keep.id : null);
  else rewriteSwatchRefs(doc, (id) => gone.has(id), () => null);
  return keep.id;
}

/** Dissolve color groups; their swatches stay, ungrouped, in place. */
export function ungroupGroups(doc, gids) {
  const set = new Set(gids);
  if (!groupsOf(doc).some((g) => set.has(g.id))) return;
  doc.updateRoot({
    swatchGroups: groupsOf(doc).filter((g) => !set.has(g.id)),
    swatches: swatchesOf(doc).map((s) => {
      if (!set.has(s.group)) return s;
      const out = { ...s };
      delete out.group;
      return out;
    }),
  });
}

const KIND_ORDER = { process: 0, global: 1, spot: 2, gradient: 3, pattern: 4, other: 5 };

/** Kind of a swatch for sorting and display. */
export function swatchKind(s) {
  const t = s.paint?.type;
  if (t === 'solid') return s.spot ? 'spot' : s.global ? 'global' : 'process';
  if (t === 'linear' || t === 'radial' || t === 'freeform') return 'gradient';
  if (t === 'pattern') return 'pattern';
  return 'other';
}

/** Sort swatches by name or by kind (then name), within each color group. */
export function sortSwatches(doc, by = 'name') {
  const gIndex = new Map(groupsOf(doc).map((g, i) => [g.id, i + 1]));
  const coll = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  const list = swatchesOf(doc).map((s, i) => ({ s, i }));
  list.sort((a, b) => {
    const ga = gIndex.get(a.s.group) || 0;
    const gb = gIndex.get(b.s.group) || 0;
    if (ga !== gb) return ga - gb;
    if (by === 'kind') {
      const k = KIND_ORDER[swatchKind(a.s)] - KIND_ORDER[swatchKind(b.s)];
      if (k) return k;
    }
    return coll.compare(a.s.name || '', b.s.name || '') || a.i - b.i;
  });
  doc.updateRoot({ swatches: list.map((x) => x.s) });
}

/** Every paint the document uses (fills, strokes and styled characters). */
function usedPaints(doc) {
  const out = [];
  for (const node of doc.nodes.values()) {
    for (const key of ['fill', 'stroke']) if (node[key]) out.push(node[key]);
    if (node.type === 'text' && node.runs) for (const r of node.runs) for (const key of ['fill', 'stroke']) if (r[key]) out.push(r[key]);
  }
  return out;
}

/** Swatches nothing in the document uses (by link or by an identical paint). */
export function unusedSwatchIds(doc) {
  const linked = new Set();
  const colors = new Set();
  const patterns = new Set();
  const gradients = new Set();
  for (const p of usedPaints(doc)) {
    if (p.swatchId) linked.add(p.swatchId);
    if (p.type === 'solid') colors.add(String(p.color).toLowerCase());
    else if (p.type === 'pattern') patterns.add(p.id);
    else if (p.stops) {
      for (const st of p.stops) if (st.swatchId) linked.add(st.swatchId);
      gradients.add(gradientKey(p));
    }
  }
  return swatchesOf(doc)
    .filter((s) => {
      if (linked.has(s.id)) return false;
      const p = s.paint;
      if (!p) return false;
      if (p.type === 'solid') return !colors.has(String(p.color).toLowerCase());
      if (p.type === 'pattern') return !patterns.has(p.id);
      if (p.stops) return !gradients.has(gradientKey(p));
      return true;
    })
    .map((s) => s.id);
}

function gradientKey(p) {
  return JSON.stringify([p.type, p.stops.map((s) => [s.offset, String(s.color).toLowerCase(), s.opacity ?? 1, s.midpoint ?? 0.5])]);
}

/** Solid colors the document uses that no swatch has yet, in first-use order. */
export function usedColorsMissing(doc) {
  const have = new Set(swatchesOf(doc).filter((s) => s.paint?.type === 'solid').map((s) => s.paint.color.toLowerCase()));
  const out = [];
  for (const p of usedPaints(doc)) {
    if (p.type !== 'solid' || p.swatchId) continue;
    const c = String(p.color).toLowerCase();
    if (have.has(c)) continue;
    have.add(c);
    out.push(c);
  }
  return out;
}
