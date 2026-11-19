// Runs exact adjustments off the main thread: adjustment kinds through the
// engine's reference path and the other Image > Adjustments operations by ID.
import { adjustmentOperations, applyAdjustment, histograms, type Adjustment, type Histograms, type SpatialContext } from '../../imaging/adjust';
import type { Mask8, OperationContext, ParamValues, RGBA8 } from '../../imaging/types';

export type AdjustJob =
  | { id: number; type: 'adjust'; adjustment: Adjustment; image: RGBA8; ctx?: SpatialContext }
  | { id: number; type: 'operation'; operation: string; values: ParamValues; context: OperationContext; image: RGBA8 }
  | { id: number; type: 'histograms'; image: RGBA8; selection?: Mask8 };
export type AdjustReply = { id: number; image?: RGBA8; hist?: Histograms; error?: string; ms?: number };

const scope = self as unknown as { onmessage: ((ev: MessageEvent<AdjustJob>) => void) | null; postMessage: (m: AdjustReply, t?: Transferable[]) => void };
scope.onmessage = async (ev) => {
  const job = ev.data;
  const t0 = performance.now();
  try {
    if (job.type === 'histograms') {
      scope.postMessage({ id: job.id, hist: histograms(job.image, job.selection) });
      return;
    }
    let out: RGBA8;
    if (job.type === 'adjust') out = applyAdjustment(job.image, job.adjustment, undefined, undefined, job.ctx);
    else {
      const op = adjustmentOperations.find((o) => o.id === job.operation);
      if (!op) throw new Error(`Unknown adjustment ${job.operation}.`);
      out = await op.apply(job.image, job.values, job.context);
    }
    scope.postMessage({ id: job.id, image: out, ms: performance.now() - t0 }, [out.data.buffer]);
  } catch (error) {
    scope.postMessage({ id: job.id, error: error instanceof Error ? error.message : String(error) });
  }
};
