/**
 * Swatch storage and global swatches.
 *
 * doc.root.swatches is a flat list of { id, name, paint, global?, spot?,
 * mode?, group? } (group = id of a color group; spot = a spot ink, which
 * is global too). Color groups live in
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
  if (!next.global) delete next.global;
  if (!next.spot || !next.global) delete next.spot;
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
export function rewriteSwatchRefs(doc, test, paintFor) {
  for (const node of doc.nodes.values()) {
    if (node.type !== 'path' && node.type !== 'compound' && node.type !== 'text') continue;
    const patch = {};
    for (const key of ['fill', 'stroke']) {
      const p = node[key];
      if (!p) continue;
      const next = rewritePaint(p, test, paintFor);
      if (next !== p) patch[key] = next;
    }
    // Styled characters in type can link to swatches too.
    if (node.type === 'text' && node.runs) {
      let changed = false;
      const runs = node.runs.map((r) => {
        let out = r;
        for (const key of ['fill', 'stroke']) {
          if (!r[key]) continue;
          const next = rewritePaint(r[key], test, paintFor);
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

function rewritePaint(p, test, paintFor) {
  if (p.type === 'solid' && p.swatchId && test(p.swatchId)) {
    const src = paintFor(p.swatchId);
    if (!src) {
      const out = { ...p };
      delete out.swatchId;
      return out;
    }
    if (src.type === 'solid') return { ...p, color: src.color, swatchId: p.swatchId };
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
        return src.type === 'solid' ? { ...s, color: src.color } : s;
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
