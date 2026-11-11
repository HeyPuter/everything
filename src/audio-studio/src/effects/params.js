// Parameter schema helpers shared by effect dialogs, the Effects Rack and
// favorites: value sanitising, slider position mapping (linear and log),
// display formatting and parsing, and linked parameters.
//
// Param types (see registry.js): 'number' (default), 'bool', 'choice', plus
// the data types 'envelope' ([{ t: 0..1, v }], fade/gain envelopes, pitch
// bend), 'curve' ([{ f: Hz, g: dB }], FFT filter) and 'transfer' ([{ x, y }],
// input to output level in dB, Dynamics Processing), edited graphically,
// and 'text' (a short string, e.g. the name of a loaded impulse response).
//
// Linked sliders: a bool param with id 'linked' (or 'link') ties together the
// number params before it that share its group's unit and range (Amplify's
// left and right gain). While it is on, moving one moves the others by the
// same amount.

const typeOf = (p) => p.type || (p.options ? 'choice' : 'number');

export function paramType(p) {
  return typeOf(p);
}

function decimalsFor(step) {
  if (!step || step >= 1) return 0;
  return Math.min(6, Math.max(0, -Math.floor(Math.log10(step) + 1e-9)));
}

export function roundToStep(v, step, min = 0) {
  if (!step) return v;
  const base = Number.isFinite(min) ? min : 0;
  const r = base + Math.round((v - base) / step) * step;
  return Number(r.toFixed(decimalsFor(step)));
}

/** Clamps and rounds one value to its param's range, type and step. */
export function coerce(p, v) {
  const t = typeOf(p);
  if (t === 'bool') return typeof v === 'string' ? v === 'true' || v === '1' : Boolean(v);
  if (t === 'text') return typeof v === 'string' ? v.slice(0, 200) : (p.default ?? '');
  if (t === 'choice') {
    const opts = p.options || [];
    const hit = opts.find((o) => String(o.value) === String(v));
    return hit ? hit.value : (p.default ?? opts[0]?.value);
  }
  if (t === 'envelope') {
    if (!Array.isArray(v) || v.length < 2) return structuredClone(p.default);
    return v.map((pt) => ({ t: Math.min(1, Math.max(0, Number(pt.t) || 0)), v: Math.min(p.max ?? Infinity, Math.max(p.min ?? -Infinity, Number(pt.v) || 0)) })).sort((a, b) => a.t - b.t);
  }
  if (t === 'curve') {
    if (!Array.isArray(v) || !v.length) return structuredClone(p.default);
    return v.map((pt) => ({ f: Math.max(1, Number(pt.f) || 1), g: Math.min(p.max ?? Infinity, Math.max(p.min ?? -Infinity, Number(pt.g) || 0)) })).sort((a, b) => a.f - b.f);
  }
  if (t === 'transfer') {
    if (!Array.isArray(v) || v.length < 2) return structuredClone(p.default);
    const lo = p.min ?? -100;
    const hi = p.max ?? 0;
    const pts = v.map((pt) => ({ x: Math.min(hi, Math.max(lo, Number(pt.x) || 0)), y: Math.min(hi, Math.max(lo, Number(pt.y) || 0)) })).sort((a, b) => a.x - b.x);
    // `extendEnds`: a curve that starts above the bottom of the range continues
    // down at its first point's gain (curves drawn over a narrower range keep their shape).
    if (p.extendEnds && pts[0].x > lo) pts.unshift({ x: lo, y: Math.max(lo, pts[0].y + lo - pts[0].x) });
    // The ends span the whole input range so the curve is defined everywhere.
    pts[0] = { ...pts[0], x: lo };
    pts[pts.length - 1] = { ...pts[pts.length - 1], x: hi };
    return pts;
  }
  let n = Number(v);
  if (!Number.isFinite(n)) n = Number(p.default) || 0;
  const min = p.min ?? -Infinity;
  const max = p.max ?? Infinity;
  n = Math.min(max, Math.max(min, n));
  // `sig`: kept to that many significant digits instead of snapping to the step
  // (a Q of 0.7071); the step still sets how far keys and drags move it.
  if (p.sig) return Math.min(max, Math.max(min, Number(n.toPrecision(p.sig))));
  // Rounding to the step can leave the range when min is not a whole step (0.1 ms in 1 ms steps).
  return Math.min(max, Math.max(min, roundToStep(n, p.step, Number.isFinite(min) ? min : 0)));
}

/** Full, valid values for a definition from partial (or stale) values. Unknown keys are dropped. */
export function normalizeValues(def, values = {}) {
  const out = {};
  for (const p of def.params) out[p.id] = coerce(p, values?.[p.id] !== undefined ? values[p.id] : p.default);
  return out;
}

export function valuesEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

// --------------------------------------------------------- slider mapping

const isLog = (p) => p.scale === 'log' && p.min > 0 && p.max > p.min;

/** Slider position in [0, 1] for value v. */
export function toPosition(p, v) {
  const min = p.min ?? 0;
  const max = p.max ?? 1;
  if (max === min) return 0;
  v = Math.min(max, Math.max(min, v));
  if (isLog(p)) return Math.log(v / min) / Math.log(max / min);
  return (v - min) / (max - min);
}

/** Value for slider position x in [0, 1], rounded to the param step. */
export function fromPosition(p, x) {
  const min = p.min ?? 0;
  const max = p.max ?? 1;
  x = Math.min(1, Math.max(0, x));
  const v = isLog(p) ? min * Math.pow(max / min, x) : min + (max - min) * x;
  return coerce(p, isLog(p) ? roundLog(v, p.step) : v);
}

// Log-scaled values keep about three significant digits instead of snapping to the step.
function roundLog(v, step) {
  const mag = Math.pow(10, Math.floor(Math.log10(v)) - 2);
  const r = Math.round(v / mag) * mag;
  return step ? Math.max(step, r) : r;
}

// ------------------------------------------------------ format and parse

/** Display text for a value with its unit: "-3.0 dB", "1.25 kHz", "40 %", "4:1". */
export function formatValue(p, v) {
  const t = typeOf(p);
  if (t === 'bool') return v ? 'On' : 'Off';
  if (t === 'text') return String(v ?? '');
  if (t === 'choice') return (p.options || []).find((o) => String(o.value) === String(v))?.label ?? String(v);
  if (t === 'envelope' || t === 'curve' || t === 'transfer') return `${v?.length || 0} points`;
  if (!Number.isFinite(v)) return v === -Infinity ? '-inf' : String(v);
  const unit = p.unit || '';
  const d = decimalsFor(p.step);
  if (unit === 'Hz' && Math.abs(v) >= 1000) {
    const k = v / 1000;
    return `${k.toFixed(k >= 10 ? 1 : 2).replace(/\.?0+$/, '')} kHz`;
  }
  if (unit === 'ms' && Math.abs(v) >= 1000 && !p.keepUnit) return `${(v / 1000).toFixed(2)} s`;
  if (unit === ':1') return `${v.toFixed(d)}:1`;
  const sig = p.sig || (isLog(p) && !p.step ? 3 : 0);
  const text = sig ? String(Number(v.toPrecision(sig))) : v.toFixed(d);
  return unit ? `${text} ${unit}` : text;
}

/** Parses typed text ("2k", "2.5 kHz", "-3", "150ms", "1.5 s", "4:1") into a value in the param's unit. */
export function parseValue(p, text) {
  const s = String(text).trim().toLowerCase().replace(',', '.');
  if (s === '-inf' || s === '-infinity') return p.min ?? -Infinity;
  const m = s.match(/^([-+]?\d*\.?\d+(?:e[-+]?\d+)?)\s*([a-z%:]*)/);
  if (!m) return NaN;
  let v = Number(m[1]);
  const suffix = m[2] || '';
  const unit = (p.unit || '').toLowerCase();
  if (unit === 'hz' && (suffix === 'k' || suffix === 'khz')) v *= 1000;
  else if (unit === 'ms' && suffix === 's') v *= 1000;
  else if (unit === 's' && suffix === 'ms') v /= 1000;
  return v;
}

// --------------------------------------------------------- linked params

/** Ids of the params linked by `linked`/`link` bool params: [[id, id], ...]. */
export function linkGroups(def) {
  const groups = [];
  def.params.forEach((p, i) => {
    if (typeOf(p) !== 'bool' || !/^link(ed)?$/i.test(p.id)) return;
    const before = def.params.slice(0, i).filter((q) => typeOf(q) === 'number');
    const last = before[before.length - 1];
    if (!last) return;
    const ids = before.filter((q) => q.unit === last.unit && q.min === last.min && q.max === last.max).map((q) => q.id);
    if (ids.length > 1) groups.push({ link: p.id, ids });
  });
  return groups;
}

/**
 * Sets values[id] = v and moves linked params by the same delta while their
 * link is on. Returns a new values object.
 */
export function setLinked(def, values, id, v, groups = linkGroups(def)) {
  const p = def.params.find((q) => q.id === id);
  if (!p) return values;
  const next = { ...values, [id]: coerce(p, v) };
  const delta = next[id] - values[id];
  for (const g of groups) {
    if (!values[g.link] || !g.ids.includes(id) || !Number.isFinite(delta)) continue;
    for (const other of g.ids) {
      if (other === id) continue;
      const q = def.params.find((x) => x.id === other);
      next[other] = coerce(q, values[other] + delta);
    }
  }
  return next;
}

/** Display text split into the number and its unit: ["-3.0", "dB"], ["4.0", ":1"], ["1.25", "kHz"]. */
export function formatParts(p, v) {
  const text = formatValue(p, v);
  if (typeOf(p) !== 'number') return [text, ''];
  const m = text.match(/^(-?inf|[-+]?[\d.]+(?:e[-+]?\d+)?)\s*(.*)$/i);
  return m ? [m[1], m[2]] : [text, ''];
}

// ------------------------------------------------------------ slider scales

const NICE = [1, 2, 2.5, 5, 10];

function niceStep(span, count) {
  const raw = span / Math.max(1, count);
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  for (const n of NICE) if (n * mag >= raw - 1e-9) return n * mag;
  return 10 * mag;
}

// Steps tried in order of preference; the first that labels both ends wins.
const PREFERRED = [1, 2, 5, 2.5, 3, 1.5, 4, 6, 1.2, 8];

function linearStep(min, max, maxLabels) {
  const k = Math.floor(Math.log10(max - min));
  const isInt = (x) => Math.abs(x - Math.round(x)) < 1e-6;
  for (const n of PREFERRED) {
    for (const e of [k - 1, k]) {
      const step = n * Math.pow(10, e);
      const count = (max - min) / step + 1;
      if (isInt(min / step) && isInt(count) && count >= 4 && count <= maxLabels) return step;
    }
  }
  return niceStep(max - min, maxLabels - 1);
}

const tickLabel = (v, unit) => {
  const a = Math.abs(v);
  if (unit === 'Hz' && a >= 1000) return `${Number((v / 1000).toPrecision(3))}k`;
  return String(Number(v.toPrecision(4)));
};

/**
 * Tick marks for a number param's slider: { major: [{ v, x, label }], minor: [x] }
 * with x the slider position in [0, 1]. Linear scales get 4 to 7 labelled
 * steps on round values; log scales label 1-2-5 values per decade (thinned
 * when crowded) with a minor tick at every other integer multiple.
 */
export function scaleTicks(p, { maxLabels = 7 } = {}) {
  const min = p.min ?? 0;
  const max = p.max ?? 1;
  const major = [];
  const minor = [];
  if (!(max > min)) return { major, minor };
  if (isLog(p)) {
    const lo = Math.floor(Math.log10(min));
    const hi = Math.ceil(Math.log10(max));
    const all = [];
    for (let d = lo; d <= hi; d++) {
      const base = Math.pow(10, d);
      for (let k = 1; k <= 9; k++) {
        const v = Number((k * base).toPrecision(6));
        if (v < min * (1 - 1e-9) || v > max * (1 + 1e-9)) continue;
        all.push({ v, k });
      }
    }
    for (const sets of [[1, 2, 5], [1, 2], [1]]) {
      const picked = all.filter((t) => sets.includes(t.k));
      if (picked.length <= maxLabels || sets.length === 1) {
        for (const t of all) {
          const x = toPosition(p, t.v);
          if (sets.includes(t.k)) major.push({ v: t.v, x, label: tickLabel(t.v, p.unit) });
          else minor.push(x);
        }
        break;
      }
    }
    return { major, minor };
  }
  const step = linearStep(min, max, maxLabels);
  const sub = step / 2;
  const first = Math.ceil((min - 1e-9) / sub) * sub;
  for (let v = first; v <= max + 1e-9; v += sub) {
    const r = Number(v.toPrecision(10));
    const x = toPosition(p, r);
    const isMajor = Math.abs(r / step - Math.round(r / step)) < 1e-6;
    if (isMajor) major.push({ v: r, x, label: tickLabel(r, p.unit) });
    else minor.push(x);
  }
  return { major, minor };
}
