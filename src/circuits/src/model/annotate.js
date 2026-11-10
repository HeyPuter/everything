// Designator annotation: numbers parts per prefix (R1, R2, C1...) in reading
// order across sheets. Existing numbers are kept unless reset is requested.

const parseDes = (d) => {
  const m = /^([A-Za-z_]+)(\d+)$/.exec(d || '');
  return m ? { prefix: m[1], n: Number(m[2]) } : null;
};

/**
 * Plans designator changes.
 * @param {Array<{id:string, objects:object[]}>} sheets  in project order
 * @param {Record<string, object>} lib
 * @param {{ order?: 'across'|'down', reset?: boolean }} opts
 * @returns {Array<{sheetId:string, id:string, from:string, to:string}>}
 */
export function planAnnotation(sheets, lib, { order = 'across', reset = false } = {}) {
  const used = new Map();
  const kept = new Set();
  const pending = [];
  // The designator's own leading letters ('R?' -> R, 'U1A' -> U), else the library's.
  const prefixOf = (o) => {
    const p = parseDes(o.designator)?.prefix || /^[A-Za-z_]+/.exec(o.designator || '')?.[0];
    return p || lib[o.comp]?.prefix || 'U';
  };
  sheets.forEach((s, si) => {
    for (const o of s.objects) {
      if (o.t !== 'part') continue;
      const d = parseDes(o.designator);
      if (!reset && d) {
        let set = used.get(d.prefix);
        if (!set) used.set(d.prefix, (set = new Set()));
        if (!set.has(d.n)) { set.add(d.n); continue; }
      } else if (!reset && o.designator && !/\?$/.test(o.designator) && !kept.has(o.designator)) {
        // A unique custom designator (U1A, J_PWR) is annotated already.
        kept.add(o.designator);
        continue;
      }
      pending.push({ sheetIndex: si, sheetId: s.id, o, prefix: prefixOf(o) });
    }
  });
  // Reading order: sheet, then rows top to bottom (or columns left to right).
  const band = 2_540_000 * 5;
  pending.sort((a, b) => {
    if (a.sheetIndex !== b.sheetIndex) return a.sheetIndex - b.sheetIndex;
    if (order === 'down') return Math.round(a.o.x / band) - Math.round(b.o.x / band) || b.o.y - a.o.y;
    return Math.round(b.o.y / band) - Math.round(a.o.y / band) || a.o.x - b.o.x;
  });
  const out = [];
  for (const p of pending) {
    let set = used.get(p.prefix);
    if (!set) used.set(p.prefix, (set = new Set()));
    let n = 1;
    while (set.has(n)) n++;
    set.add(n);
    const to = `${p.prefix}${n}`;
    if (to !== p.o.designator) out.push({ sheetId: p.sheetId, id: p.o.id, from: p.o.designator, to });
  }
  return out;
}

/** Next free designator for a prefix across the given sheets ('R' -> 'R4'). */
export function nextDesignator(sheets, prefix) {
  const set = new Set();
  for (const s of sheets) for (const o of s.objects) {
    if (o.t !== 'part') continue;
    const d = parseDes(o.designator);
    if (d && d.prefix === prefix) set.add(d.n);
  }
  let n = 1;
  while (set.has(n)) n++;
  return `${prefix}${n}`;
}

/**
 * Hands out free designators for many new parts with one pass over the
 * sheets: each call returns the next free one for its prefix and reserves it.
 */
export function designatorAllocator(sheets) {
  const used = new Map();
  const entry = (prefix) => {
    let e = used.get(prefix);
    if (!e) used.set(prefix, (e = { set: new Set(), n: 1 }));
    return e;
  };
  for (const s of sheets) for (const o of s.objects) {
    if (o.t !== 'part') continue;
    const d = parseDes(o.designator);
    if (d) entry(d.prefix).set.add(d.n);
  }
  return (prefix) => {
    const e = entry(prefix);
    while (e.set.has(e.n)) e.n++;
    e.set.add(e.n);
    return `${prefix}${e.n}`;
  };
}
