/// <reference lib="webworker" />
// Heavy retouching and segmentation jobs run here so the canvas stays
// responsive. Buffers arrive and leave as transferables. Cancelling terminates
// the worker (a running synchronous job cannot see messages), so jobs are
// stateless except the Quick Selection graph, which the client rebuilds.
import { contextFill, heal, spotHeal, type ContextFillOptions, type SpotHealMode } from '../../imaging/retouch';
import { QuickSelector, selectSky, selectSubject, type QuickStroke } from '../../imaging/segment';
import type { Mask8, Progress, RGBA8 } from '../../imaging/types';
import { focusAreaMask, type FocusAreaOptions } from '../../imaging/segment/focus-area';
import { enhanceEdge } from '../../imaging/segment/enhance-edge';
import { colorRangeMulti, prefillHole, refineComposite, type ColorRangeSettings, type RefineSettings } from './logic';

const scope = self as unknown as DedicatedWorkerGlobalScope;
let selector: { key: string; qs: QuickSelector; existing?: Mask8 } | undefined;

type Args = Record<string, unknown>;
const jobs: Record<string, (a: Args, p: Progress) => unknown> = {
  'context-fill': (a, p) => contextFill(prefillHole(a.img as RGBA8, a.hole as Mask8), a.hole as Mask8, a.opts as ContextFillOptions, p),
  'spot-heal': (a) => spotHeal(a.img as RGBA8, a.mask as Mask8, a.mode as SpotHealMode, (a.seed as number) ?? 1, { inPlace: true }),
  heal: (a) => heal(a.dst as RGBA8, a.src as RGBA8, a.mask as Mask8, a.offset as { x: number; y: number }, { inPlace: true }),
  subject: (a, p) => selectSubject(a.img as RGBA8, { progress: p }),
  sky: (a, p) => selectSky(a.img as RGBA8, { progress: p }),
  refine: (a) => refineComposite(a.img as RGBA8, a.mask as Mask8, a.settings as RefineSettings, a.brushed as Mask8 | null, a.brushRadius as number),
  'enhance-edge': (a, p) => enhanceEdge(a.img as RGBA8, a.mask as Mask8, { canvas: a.canvas as { width: number; height: number } }, p),
  'color-range': (a) => colorRangeMulti(a.img as RGBA8, a.settings as ColorRangeSettings),
  'focus-area': (a, p) => focusAreaMask(a.img as RGBA8, a.opts as FocusAreaOptions, p),
  'qs-init': (a) => {
    selector = { key: a.key as string, qs: new QuickSelector(a.img as RGBA8) };
    return true;
  },
  'qs-begin': (a) => {
    if (!selector || selector.key !== a.key) return false;
    selector.existing = (a.existing as Mask8 | undefined) ?? undefined;
    return true;
  },
  'qs-update': (a) => {
    if (!selector || selector.key !== a.key) throw new Error('Quick Selection lost its image; try the stroke again.');
    return selector.qs.update(a.strokes as QuickStroke[], selector.existing, a.brushSize as number);
  },
};

function transferables(v: unknown, out: Transferable[] = []): Transferable[] {
  if (!v || typeof v !== 'object') return out;
  if (ArrayBuffer.isView(v)) {
    if (!out.includes(v.buffer as ArrayBuffer)) out.push(v.buffer as ArrayBuffer);
    return out;
  }
  for (const x of Object.values(v)) transferables(x, out);
  return out;
}

scope.onmessage = (ev: MessageEvent<{ id: number; op: string; args: Args }>) => {
  const { id, op, args } = ev.data;
  let last = 0;
  const progress: Progress = {
    report: (f) => {
      const now = performance.now();
      if (now - last < 60 && f < 1) return;
      last = now;
      scope.postMessage({ id, progress: f });
    },
  };
  try {
    const job = jobs[op];
    if (!job) throw new Error(`Unknown job: ${op}`);
    const result = job(args, progress);
    scope.postMessage({ id, result }, transferables(result));
  } catch (error) {
    scope.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
};
