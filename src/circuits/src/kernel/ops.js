// Encodes requests for the geometry kernel and decodes its answers. The same
// code runs in the worker (via client.js) and in-process (createKernel), so
// tests exercise exactly what the app runs.

import { buildShapes, writePrefix, pourOrder, F64Writer, LAYER_BIT, COURTYARD_BIT, maskLayers, layerMask } from './shapes.js';
import { copperLayers, COPPER_ORDER } from '../model/layers.js';
import { placeFootprint } from '../model/place.js';
import { formatLength } from '../core/units.js';
import { silkChecks } from './silk.js';

const RULES = { 1: 'clearance', 2: 'short', 3: 'edge', 4: 'keepout', 5: 'courtyard', 6: 'edge' };

/** Raw access to the compiled kernel: f64 buffer in, f64 buffer out. */
export class RawKernel {
  constructor(instance) {
    this.x = instance.exports;
  }

  _withInput(input, fn) {
    const n = input.length;
    const ptr = this.x.k_alloc(n);
    new Float64Array(this.x.memory.buffer, ptr, n).set(input);
    try {
      return fn(ptr, n);
    } finally {
      this.x.k_free(ptr, n);
    }
  }

  _result() {
    const ptr = this.x.k_result_ptr();
    const len = this.x.k_result_len();
    const out = new Float64Array(this.x.memory.buffer, ptr, len).slice();
    return out;
  }

  pours(input) {
    this._withInput(input, (p, n) => this.x.k_pours(p, n));
    return this._result();
  }

  drc(input) {
    this._withInput(input, (p, n) => this.x.k_drc(p, n));
    return this._result();
  }

  routeInit(input) {
    return this._withInput(input, (p, n) => this.x.k_route_init(p, n));
  }

  routeStep(budget) {
    return this.x.k_route_step(budget);
  }

  routeProgress() {
    this.x.k_route_progress();
    const [total, done, routed] = this._result();
    return { total: Math.max(total, done), done, routed };
  }

  routeResult() {
    this.x.k_route_result();
    return this._result();
  }

  reset() {
    this.x.k_reset();
  }
}

export async function instantiate(source) {
  const imports = {};
  if (source instanceof WebAssembly.Module) return new RawKernel(await WebAssembly.instantiate(source, imports));
  const { instance } = await WebAssembly.instantiate(source, imports);
  return new RawKernel(instance);
}

// ---------------------------------------------------------------- pours

export function encodePours(doc, library, { ids = null } = {}) {
  const shapes = buildShapes(doc, library);
  const rules = doc.rules || {};
  const thermal = rules.thermal || { spoke: 300_000, gap: 250_000, count: 4 };
  let pours = pourOrder(doc);
  // Pours that later ones depend on still have to be filled, so a subset keeps
  // every pour up to the last requested one.
  if (ids) {
    const want = new Set(ids);
    let last = -1;
    pours.forEach((p, i) => { if (want.has(p.id)) last = i; });
    pours = pours.slice(0, last + 1);
  }
  const w = new F64Writer(shapes.records.length + 1024);
  writePrefix(w, shapes);
  // The kernel offsets the board outline with round joins drawn as chords,
  // which cut up to 0.12% of the distance into the clearance around cutouts
  // and inside corners; a small margin keeps the full clearance DRC checks.
  const edge = rules.edgeClearance || 0;
  w.push(edge > 0 ? edge * 1.002 + 10 : 0, thermal.gap, thermal.spoke, thermal.count || 4, pours.length);
  pours.forEach((p, i) => {
    const net = p.net ? shapes.netIndex.get(p.net) ?? -1 : -1;
    const clr = Math.max(p.clearance ?? rules.pourClearance ?? 0, p.net ? shapes.rulesFor(p.net).clearance : rules.clearance || 0);
    w.push(i, LAYER_BIT[p.layer], net, clr, p.minWidth || 0, p.removeIslands === false ? 0 : 1, p.thermals === false ? 0 : 1, p.pts.length / 2);
    w.pushArray(p.pts);
  });
  return { input: w.result(), pours, ids: ids ? new Set(ids) : null };
}

export function decodePours(out, ctx) {
  const map = new Map();
  let i = 0;
  const n = out[i++];
  for (let k = 0; k < n; k++) {
    const idx = out[i++];
    const nPolys = out[i++];
    const polys = [];
    for (let a = 0; a < nPolys; a++) {
      const nRings = out[i++];
      const rings = [];
      for (let b = 0; b < nRings; b++) {
        const m = out[i++];
        rings.push(Array.from(out.subarray(i, i + 2 * m)));
        i += 2 * m;
      }
      polys.push(rings);
    }
    const pour = ctx.pours[idx];
    if (!ctx.ids || ctx.ids.has(pour.id)) map.set(pour.id, polys);
  }
  return map;
}

// ---------------------------------------------------------------- drc

export function encodeDrc(doc, library, { pourFills = null, maxViolations = 5000 } = {}) {
  const shapes = buildShapes(doc, library, { pourFills });
  const w = new F64Writer(shapes.records.length + 64);
  writePrefix(w, shapes);
  w.push(doc.rules?.edgeClearance || 0, maxViolations);
  return { input: w.result(), refs: shapes.refs, maxViolations };
}

const fmt = (nm) => formatLength(nm, 'mm');
const firstLayer = (mask) => {
  if (mask & (1 << COURTYARD_BIT.top)) return 'courtyard';
  if (mask & (1 << COURTYARD_BIT.bottom)) return 'courtyard';
  return maskLayers(mask)[0] || null;
};
const describe = (ref) => (ref.net ? `${ref.label} (${ref.net})` : ref.label);

export function decodeDrc(out, ctx) {
  const list = [];
  let i = 0;
  const n = out[i++];
  for (let k = 0; k < n; k++) {
    const [code, a, b, x, y, mask, actual, required] = out.subarray(i, i + 8);
    i += 8;
    const rule = RULES[code];
    const ra = ctx.refs[a], rb = b >= 0 ? ctx.refs[b] : null;
    const ids = [...new Set([ra?.id, rb?.id].filter(Boolean))];
    let message;
    switch (code) {
      case 1: message = `Clearance ${fmt(actual)} is less than ${fmt(required)} between ${describe(ra)} and ${describe(rb)}`; break;
      case 2: message = `Short circuit between ${describe(ra)} and ${describe(rb)}`; break;
      case 3: message = `${describe(ra)} is ${fmt(actual)} from the board edge (minimum ${fmt(required)})`; break;
      case 4: message = `${describe(ra.kind === 'keepout' ? rb : ra)} is inside a keep-out area`; break;
      case 5: message = `Courtyards of ${ra.label} and ${rb.label} overlap`; break;
      case 6: message = `${describe(ra)} is outside the board`; break;
      default: message = 'Rule violation';
    }
    list.push({
      rule, severity: code === 5 ? 'warning' : 'error', message,
      x: Math.round(x), y: Math.round(y), layer: firstLayer(mask), ids,
      actual: Math.round(actual), required: Math.round(required),
    });
  }
  return list;
}

/** Checks that need no geometry kernel: widths, holes and annular rings. */
export function ruleChecks(doc, library) {
  const rules = doc.rules || {};
  const copper = doc.board?.copper || 2;
  const out = [];
  const minW = rules.minTrackWidth || 0, minDrill = rules.minDrill || 0, minRing = rules.minAnnularRing || 0;
  const hole = (o, drill, size, x, y, label) => {
    if (drill > 0 && drill < minDrill) {
      out.push({ rule: 'hole', severity: 'error', message: `${label} hole ${fmt(drill)} is smaller than ${fmt(minDrill)}`, x, y, layer: 'multi', ids: [o.id], actual: drill, required: minDrill });
    }
    if (drill > 0 && size > 0) {
      const ring = (size - drill) / 2;
      if (ring < minRing) {
        out.push({ rule: 'annular', severity: 'error', message: `${label} annular ring ${fmt(ring)} is less than ${fmt(minRing)}`, x, y, layer: 'multi', ids: [o.id], actual: Math.round(ring), required: minRing });
      }
    }
  };
  for (const o of doc.objects || []) {
    if ((o.t === 'track' || o.t === 'arc') && COPPER_ORDER.includes(o.layer) && o.w < minW) {
      const x = o.t === 'track' ? Math.round((o.x1 + o.x2) / 2) : o.cx + o.r;
      const y = o.t === 'track' ? Math.round((o.y1 + o.y2) / 2) : o.cy;
      out.push({ rule: 'width', severity: 'error', message: `${o.t === 'track' ? 'Track' : 'Arc'} width ${fmt(o.w)} is less than ${fmt(minW)}${o.net ? ` (${o.net})` : ''}`, x, y, layer: o.layer, ids: [o.id], actual: o.w, required: minW });
    } else if (o.t === 'via') {
      hole(o, o.drill, o.d, o.x, o.y, 'Via');
    } else if (o.t === 'pad' && o.side === 'thru') {
      hole(o, o.drill, Math.min(o.w, o.h || o.w), o.x, o.y, 'Pad');
    } else if (o.t === 'comp') {
      for (const p of placeFootprint(library[o.comp], o, copper).pads) {
        if (p.side === 'thru') hole(o, p.drill, p.shape === 'round' ? p.w : Math.min(p.w, p.h), p.x, p.y, `Pad ${o.designator}-${p.num}`);
      }
    }
  }
  out.push(...silkChecks(doc, library));
  return out;
}

// ---------------------------------------------------------------- autoroute

export function encodeRoute(doc, library, opts = {}) {
  const shapes = buildShapes(doc, library, { pourFills: opts.pourFills || null });
  const rules = doc.rules || {};
  const copper = shapes.copper;
  const layers = copperLayers(copper);
  const allowed = layerMask(opts.layers?.length ? opts.layers.filter((l) => layers.includes(l)) : layers);
  const tw = rules.trackWidth || 250_000, clr = rules.clearance || 200_000;
  const grid = opts.grid || Math.round((tw + clr) / 2);
  let viaD = rules.viaDiameter || 600_000;
  for (const cls of Object.values(rules.netClasses || {})) if (cls.viaDiameter) viaD = Math.max(viaD, cls.viaDiameter);
  const netHw = shapes.nets.map((n) => shapes.rulesFor(n).width / 2);
  const want = opts.nets?.length ? opts.nets.map((n) => shapes.netIndex.get(n)).filter((v) => v !== undefined) : [];
  const w = new F64Writer(shapes.records.length + netHw.length + 64);
  writePrefix(w, shapes);
  w.push(grid, layers.length, ...layers.map((l) => LAYER_BIT[l]), allowed, clr, viaD / 2, opts.viaCost ?? 6, rules.edgeClearance || 0, tw / 2);
  w.push(netHw.length);
  w.pushArray(netHw);
  w.push(want.length);
  w.pushArray(want);
  w.push(opts.maxNodes || 3_000_000);
  // Connection order; runRoute rewrites this last value between passes.
  w.push(0);
  return { input: w.result(), nets: shapes.nets, rulesFor: shapes.rulesFor };
}

export function decodeRoute(out, ctx) {
  let i = 0;
  const total = out[i++], processed = out[i++], routed = out[i++], grid = out[i++];
  const byBit = Object.fromEntries(Object.entries(LAYER_BIT).map(([k, v]) => [v, k]));
  const tracks = [];
  const nt = out[i++];
  for (let k = 0; k < nt; k++) {
    const [layer, x1, y1, x2, y2, w, net] = out.subarray(i, i + 7);
    i += 7;
    const t = { layer: byBit[layer], x1: Math.round(x1), y1: Math.round(y1), x2: Math.round(x2), y2: Math.round(y2), w: Math.round(w), net: ctx.nets[net] || '' };
    if (t.x1 !== t.x2 || t.y1 !== t.y2) tracks.push(t);
  }
  const vias = [];
  const nv = out[i++];
  for (let k = 0; k < nv; k++) {
    const [x, y, net] = out.subarray(i, i + 3);
    i += 3;
    const name = ctx.nets[net] || '';
    const r = ctx.rulesFor(name);
    vias.push({ x: Math.round(x), y: Math.round(y), d: r.viaDiameter, drill: r.viaDrill, from: 'top', to: 'bottom', net: name });
  }
  const failed = [];
  const nf = out[i++];
  for (let k = 0; k < nf; k++) {
    const [net, ax, ay, bx, by] = out.subarray(i, i + 5);
    i += 5;
    failed.push({ net: ctx.nets[net] || '', from: { x: Math.round(ax), y: Math.round(ay) }, to: { x: Math.round(bx), y: Math.round(by) } });
  }
  return { tracks, vias, routed, failed, total, processed, grid };
}

/**
 * Runs the router loop on a raw kernel. Used by the worker and in-process.
 * shouldStop() is polled between batches.
 */
export function runRoute(raw, input, { timeLimitMs = 20000, onProgress = null, shouldStop = null, passes = 6 } = {}) {
  const start = Date.now();
  let best = null, bestScore = -Infinity, timedOut = false;
  // A sequential router depends on the order connections are routed in, so
  // several orders are tried while time allows and the best result is kept.
  for (let pass = 0; pass < passes; pass++) {
    input[input.length - 1] = pass;
    let remaining = raw.routeInit(input);
    let lastReport = 0;
    let stopped = false;
    if (onProgress) onProgress({ ...raw.routeProgress(), pass: pass + 1, passes });
    while (remaining > 0) {
      remaining = raw.routeStep(2);
      const now = Date.now();
      if (onProgress && (remaining === 0 || now - lastReport > 50)) {
        lastReport = now;
        onProgress({ ...raw.routeProgress(), pass: pass + 1, passes });
      }
      if (remaining > 0 && (now - start > timeLimitMs || shouldStop?.())) { stopped = true; break; }
    }
    const out = raw.routeResult();
    raw.reset();
    // Result layout: total, processed, routed, grid, tracks (7 each), vias (3 each), failed (5 each).
    const routed = out[2];
    const nTracks = out[4], nVias = out[5 + nTracks * 7], nFailed = out[6 + nTracks * 7 + nVias * 3];
    // Score: connections routed, then fewer vias and less copper.
    const score = routed * 1e6 - nVias * 100 - nTracks;
    if (score > bestScore) { bestScore = score; best = out; }
    if (stopped) { timedOut = true; break; }
    if (nFailed === 0) break;
    if (Date.now() - start > timeLimitMs * 0.6) break;
  }
  return { out: best, timedOut };
}

/**
 * In-process kernel with the same API as KernelClient, for tests and for
 * environments without workers. source: wasm bytes, a Module or a Response.
 */
export async function createKernel(source) {
  const isResponse = typeof Response !== 'undefined' && source instanceof Response;
  const raw = await instantiate(isResponse ? await source.arrayBuffer() : source);
  return {
    raw,
    async pours(doc, library, opts = {}) {
      const ctx = encodePours(doc, library, opts);
      return decodePours(raw.pours(ctx.input), ctx);
    },
    async drc(doc, library, opts = {}) {
      const ctx = encodeDrc(doc, library, opts);
      return [...ruleChecks(doc, library), ...decodeDrc(raw.drc(ctx.input), ctx)];
    },
    async autoroute(doc, library, opts = {}, onProgress = null) {
      const ctx = encodeRoute(doc, library, opts);
      const { out, timedOut } = runRoute(raw, ctx.input, { timeLimitMs: opts.timeLimitMs ?? 20000, onProgress });
      return { ...decodeRoute(out, ctx), timedOut };
    },
    cancel() {},
    dispose() {},
  };
}
