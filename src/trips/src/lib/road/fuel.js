import { rangeKm, refillTypes } from './prefs.js';

const EPSILON = 1e-6;

/**
 * Range along the chain. The trip starts full; a stop whose place is a matching service stop (`place.stop`) fills to
 * its `fill` (else the vehicle's fill-up percent), and picking up a hire car starts full. Only drive legs use range.
 *
 * Where the range falls to the reserve, a band starts that ends where it would run out. Later bands assume a fill-up
 * at the start of the previous one, so they show where each next stop is needed.
 *
 * `legTime(leg)` gives `{meters}`. Returns `{range, reserve, refills: [{node, before, after}], bands: [{id, startKm,
 * endKm, start: {leg, fraction}, end: {leg, fraction}|null, pieces: [{leg, from, to}]}], totalKm, left}` with leg keys
 * and fractions along each leg.
 */
export function planFuel({ chain, legTime, prefs }) {
  const range = rangeKm(prefs);
  const reserve = range * prefs.reserve / 100;
  const fillTo = (fraction) => range * Math.max(0.1, Math.min(1, fraction ?? prefs.fill / 100));
  const refillsWith = refillTypes(prefs);
  const legFrom = new Map(chain.legs.map((leg) => [leg.from, leg]));
  const spans = []; const refills = []; const marks = [];
  let level = range; let km = 0;

  chain.nodes.forEach((node, index) => {
    if (node.kind === 'pickup') { refills.push({ node: node.key, before: level, after: range, rental: true }); level = range; }
    else if (node.service && refillsWith.includes(node.service)) {
      const after = Math.max(level, fillTo(node.fill));
      refills.push({ node: node.key, before: level, after });
      level = after;
    }
    const leg = legFrom.get(index);
    if (!leg || leg.kind !== 'drive') return;
    const length = Math.max(0, (legTime(leg)?.meters ?? 0) / 1000);
    spans.push({ leg: leg.key, start: km, length });
    let pos = 0;
    // Each pass reaches the reserve once; a fill-up that cannot clear the reserve stops the loop.
    for (let guard = 0; guard < 1000; guard++) {
      if (level - reserve >= length - pos - EPSILON) { level -= length - pos; break; }
      const low = pos + Math.max(0, level - reserve);
      marks.push({ startKm: km + low, endKm: km + pos + Math.max(0, level) });
      pos = low;
      const refilled = fillTo();
      if (refilled - reserve <= EPSILON) { level = Math.max(0, level - (length - pos)); break; }
      level = refilled;
    }
    km += length;
  });

  const locate = (value) => {
    if (!spans.length) return null;
    const span = spans.find((item) => value <= item.start + item.length + EPSILON) ?? null;
    if (!span) return null;
    return { leg: span.leg, fraction: span.length > 0 ? Math.max(0, Math.min(1, (value - span.start) / span.length)) : 0 };
  };
  const bands = marks.map((mark, index) => ({
    id: `band-${index}`, startKm: mark.startKm, endKm: mark.endKm,
    start: locate(mark.startKm), end: mark.endKm <= km + EPSILON ? locate(mark.endKm) : null,
    pieces: spans.filter((span) => span.start + span.length > mark.startKm + EPSILON && span.start < mark.endKm - EPSILON).map((span) => ({
      leg: span.leg,
      from: span.length > 0 ? Math.max(0, (mark.startKm - span.start) / span.length) : 0,
      to: span.length > 0 ? Math.min(1, (mark.endKm - span.start) / span.length) : 1,
    })),
  }));
  return { range, reserve, refills, bands, totalKm: km, left: level };
}
