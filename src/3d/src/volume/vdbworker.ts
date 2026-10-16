// Worker parsing OpenVDB files off the main thread (see ops.ts).
import { readVdb } from './vdb/reader';

self.onmessage = (e: MessageEvent<Uint8Array>) => {
  try {
    const r = readVdb(e.data);
    const transfer = [...new Set(r.grids.map((g) => g.values.buffer as ArrayBuffer))];
    (self as unknown as Worker).postMessage({ ok: true, grids: r.grids, warnings: r.warnings }, transfer);
  } catch (err) {
    (self as unknown as Worker).postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};
