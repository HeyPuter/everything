// Messages between the Portrait & Restore workspace and its worker.
import type { RestoreFilterId, RestoreParams } from '../../imaging/restore/defs';
import type { Mask8, RGBA8 } from '../../imaging/types';

export type ToRestoreWorker =
  // The region being filtered (full resolution) and the selection coverage.
  | { type: 'load'; image: RGBA8; selection?: Mask8 }
  // Named extra pixels at full resolution (AI results, depth layers); null drops one.
  | { type: 'aux'; name: string; image: RGBA8 | null }
  | {
      type: 'run';
      job: number;
      params: RestoreParams;
      // Pyramid level: the source halved `level` times.
      level: number;
      overlay?: RestoreFilterId;
      affected?: boolean;
      // Also return the unfiltered source at this level (the "before" image).
      source?: boolean;
    };

export type FromRestoreWorker =
  | { type: 'progress'; job: number; value: number }
  | { type: 'done'; job: number; image: RGBA8; overlay?: Mask8; affected?: Mask8; source?: RGBA8 }
  | { type: 'error'; job: number; message: string; cancelled?: boolean };
