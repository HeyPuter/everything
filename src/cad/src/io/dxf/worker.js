/**
 * DXF and DWG module worker. Keeps parsing and writing of large files off
 * the main thread.
 *
 * Messages in:
 *   { id, op: 'parse', buffer: ArrayBuffer | Uint8Array | string, opts? }
 *     DWG files are recognised by their signature, anything else is DXF.
 *   { id, op: 'write', drawing, opts? }
 *   { id, op: 'writeDwg', drawing, opts? }
 *     Callbacks cannot cross the worker boundary, so for dimensions pass
 *     opts.dimBlocks ({ [entityId]: Entity[] }) and for hatch patterns pass
 *     opts.hatchPatterns ({ [name]: PatternLine[] }).
 *
 * Messages out:
 *   { id, ok: true, result }   parse: { drawing, warnings, stats, version? }
 *                              write: { text, warnings }
 *                              writeDwg: { bytes: Uint8Array, warnings }
 *   { id, ok: false, error }
 */
import { parseDxf } from './reader.js';
import { writeDxf } from './writer.js';
import { parseDwg } from '../dwg/import.js';
import { writeDwg } from '../dwg/writer.js';
import { dwgVersion } from '../dwg/container.js';

function bytesOf(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  return null;
}

/** Handle one request and return the reply message. */
export function handleMessage(data) {
  const id = data?.id;
  try {
    if (data?.op === 'parse') {
      const bytes = bytesOf(data.buffer);
      if (bytes && dwgVersion(bytes)) return { id, ok: true, result: parseDwg(bytes, data.opts || {}) };
      return { id, ok: true, result: parseDxf(data.buffer, data.opts || {}) };
    }
    if (data?.op === 'writeDwg') {
      const warnings = [];
      const bytes = writeDwg(data.drawing, { ...(data.opts || {}), warnings });
      return { id, ok: true, result: { bytes, warnings } };
    }
    if (data?.op === 'write') {
      const warnings = [];
      const opts = { ...(data.opts || {}), warnings };
      delete opts.dimensionEntities;
      delete opts.hatchPattern;
      const text = writeDxf(data.drawing, opts);
      return { id, ok: true, result: { text, warnings } };
    }
    return { id, ok: false, error: `Unknown operation '${data?.op}'` };
  } catch (err) {
    return { id, ok: false, error: err?.message ?? String(err) };
  }
}

if (typeof self !== 'undefined' && typeof self.postMessage === 'function' && typeof window === 'undefined') {
  self.onmessage = (ev) => {
    const reply = handleMessage(ev.data);
    const buf = reply.result?.bytes?.buffer;
    self.postMessage(reply, buf ? [buf] : []);
  };
}
