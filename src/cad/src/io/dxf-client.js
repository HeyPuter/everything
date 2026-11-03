/**
 * DXF and DWG import and export through a worker, so large files never
 * block the interface. Dimension geometry is computed here (it needs the text and
 * dimension modules) and handed to the writer as anonymous blocks.
 */
import { buildDimension, buildLeader } from '../core/dims.js';
import { getPattern } from '../core/hatch/patterns.js';

let worker = null;
let seq = 0;
const pending = new Map();

function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('./dxf/worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = (e) => {
    const { id, ok, result, error } = e.data || {};
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    ok ? p.resolve(result) : p.reject(new Error(error || 'DXF worker failed'));
  };
  worker.onerror = (e) => {
    for (const p of pending.values()) p.reject(new Error(e.message || 'DXF worker crashed'));
    pending.clear();
    worker?.terminate();
    worker = null;
  };
  return worker;
}

function call(msg, transfer) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    getWorker().postMessage({ id, ...msg }, transfer || []);
  });
}

/** Parse DXF or DWG bytes. Returns { drawing, warnings, stats, release? }. */
export function importDxf(buffer) {
  const copy = buffer.slice(0);
  return call({ op: 'parse', buffer: copy }, [copy]);
}

/** Plain entities that draw a dimension or leader (for the DXF anonymous block). */
function dimParts(drawing, e) {
  const ds = drawing.dimStyles.get(e.style) ?? drawing.dimStyles.get('Standard');
  const g = e.type === 'leader' ? buildLeader(e, ds, drawing.header) : buildDimension(e, ds, drawing.header);
  if (!g) return [];
  const base = { layer: '0', color: 0, linetype: 'ByBlock', lineweight: -2, ltscale: 1 };
  const out = [];
  let id = 1;
  for (const l of g.lines) {
    if (l.pts.length === 4 && !l.closed) out.push({ ...base, id: id++, type: 'line', x1: l.pts[0], y1: l.pts[1], x2: l.pts[2], y2: l.pts[3] });
    else {
      const pts = [];
      for (let i = 0; i < l.pts.length; i += 2) pts.push(l.pts[i], l.pts[i + 1], 0);
      out.push({ ...base, id: id++, type: 'polyline', pts, closed: !!l.closed, width: 0 });
    }
  }
  for (const f of g.fills) {
    const loops = f.map((r) => {
      const l = [];
      for (let i = 0; i < r.length; i += 2) l.push(r[i], r[i + 1], 0);
      return l;
    });
    out.push({ ...base, id: id++, type: 'hatch', pattern: 'SOLID', scale: 1, angle: 0, loops });
  }
  if (g.text && g.text.value) out.push({ ...base, id: id++, type: 'text', widthFactor: 1, oblique: 0, style: ds?.textStyle || 'Standard', ...g.text });
  return out;
}

/**
 * The writer input for a Drawing: its plain data plus the dimension geometry
 * and hatch pattern definitions, which only the main thread can compute.
 */
export function exportPayload(drawing, extents) {
  const data = drawing.toJSON();
  const dimBlocks = {};
  for (const e of data.entities) if (e.type === 'dimension') dimBlocks[e.id] = dimParts(drawing, e);
  for (const b of data.blocks) for (const e of b.entities) if (e.type === 'dimension') dimBlocks[`${b.name}/${e.id}`] = dimParts(drawing, e);
  const hatchPatterns = {};
  const used = new Set();
  for (const e of data.entities) if (e.type === 'hatch' && e.pattern && e.pattern !== 'SOLID') used.add(e.pattern);
  for (const b of data.blocks) for (const e of b.entities) if (e.type === 'hatch' && e.pattern && e.pattern !== 'SOLID') used.add(e.pattern);
  for (const name of used) {
    const p = getPattern(name);
    if (p) hatchPatterns[name] = p.families;
  }
  return { drawing: data, opts: { dimBlocks, hatchPatterns, extents } };
}

/** Serialize a Drawing to DXF text (in the worker). Returns { text, warnings }. */
export async function exportDxf(drawing, extents) {
  return call({ op: 'write', ...exportPayload(drawing, extents) });
}

/** Serialize a Drawing to a DWG file (in the worker). Returns { bytes, warnings }. */
export async function exportDwg(drawing, extents) {
  return call({ op: 'writeDwg', ...exportPayload(drawing, extents) });
}
