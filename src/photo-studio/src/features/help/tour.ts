// Guided tutorials: the step model, completion checks and the step state
// machine. Pure (no DOM, no editor), so tests can drive it with plain
// objects; tour-ui.ts connects it to the workspace.
import { allLayers, type Layer, type PhotoDocument } from '../../model/document';
import type { Activity } from '../../app/activity';
import type { SampleId } from './samples';

/** What a step's check sees: the parts of the workspace steps react to. */
export type TourView = { doc: PhotoDocument; tool: string; zoom: number; selected: string; hasDocument: boolean };
/** True once the step is done, comparing the workspace now with when the step began. */
export type Check = (now: TourView, base: TourView) => boolean;

/** Where a step card points: a CSS selector, a toolbar tool, a panel, a
 * top-level menu (by its label), a command button, or the canvas. */
export type Anchor = { selector: string } | { tool: string } | { panel: string } | { menu: string } | { command: string } | { canvas: true };

export type Step = {
  title: string;
  text: string;
  anchor?: Anchor;
  // Show this panel when the step starts, so its anchor is on screen.
  panel?: string;
  // The step completes when one of these commands finishes, when this tool
  // becomes active, or when `check` holds. A step with none of them is read
  // and continued with Next.
  commands?: string[];
  tool?: string;
  check?: Check;
};
export type Tutorial = { id: string; title: string; summary: string; minutes: number; sample: SampleId; steps: Step[] };

/** Whether a step needs the user to do something (else it shows Next). */
export const isAction = (s: Step) => !!(s.commands?.length || s.tool || s.check);

/** Has the user completed the step? `activity` is the event that triggered
 * the evaluation, if any (commands only count as they happen). */
export function stepDone(step: Step, now: TourView, base: TourView, activity?: Activity): boolean {
  if (activity?.kind === 'command' && step.commands?.includes(activity.id)) return true;
  if (step.tool && now.tool === step.tool) return true;
  if (step.check) {
    try {
      return step.check(now, base);
    } catch {
      return false;
    }
  }
  return false;
}

// ----- Checks used by the tutorials -----
const layersOf = (v: TourView) => allLayers(v.doc.layers);
const byId = (v: TourView, id: string) => layersOf(v).find((l) => l.id === id);
const count = (v: TourView, f: (l: Layer) => boolean) => layersOf(v).filter(f).length;
const hasLayerMask = (l: Layer | undefined) => !!(l?.maskGrid || l?.maskAsset || l?.pixelMask);

export const checks = {
  /** More layers than when the step began. */
  layerAdded: ((now, base) => layersOf(now).length > layersOf(base).length) as Check,
  /** More layers of this kind than when the step began. */
  kindAdded: (kind: Layer['kind']): Check => (now, base) => count(now, (l) => l.kind === kind) > count(base, (l) => l.kind === kind),
  /** The selected layer's pixels changed (painting, healing, filters). */
  pixelsChanged: ((now, base) => {
    const l = byId(now, now.selected),
      before = byId(base, now.selected);
    return !!l?.pixels && !!before && l.pixels !== before.pixels;
  }) as Check,
  /** Some layer gained a layer mask. */
  maskAdded: ((now, base) => layersOf(now).some((l) => hasLayerMask(l) && !hasLayerMask(byId(base, l.id)))) as Check,
  /** A layer mask that existed was painted or edited. */
  maskEdited: ((now, base) =>
    layersOf(now).some((l) => {
      const before = byId(base, l.id);
      return hasLayerMask(l) && hasLayerMask(before) && (l.maskGrid !== before!.maskGrid || l.maskAsset !== before!.maskAsset || l.pixelMask !== before!.pixelMask);
    })) as Check,
  /** There is a selection that was not there (or was different) before. */
  selectionMade: ((now, base) => !!now.doc.selection && (now.doc.selection !== base.doc.selection || now.doc.selectionMask !== base.doc.selectionMask)) as Check,
  /** Some layer's opacity was lowered. */
  opacityLowered: ((now, base) => layersOf(now).some((l) => l.opacity < (byId(base, l.id)?.opacity ?? 1) - 1e-6)) as Check,
  /** Some layer that was visible is hidden. */
  layerHidden: ((now, base) => layersOf(now).some((l) => !l.visible && byId(base, l.id)?.visible === true)) as Check,
  /** An adjustment layer that existed has different settings. */
  adjustmentEdited: ((now, base) =>
    layersOf(now).some((l) => {
      const before = byId(base, l.id);
      return l.kind === 'adjustment' && !!before && JSON.stringify(l.adjustment) !== JSON.stringify(before.adjustment);
    })) as Check,
  /** Some layer gained effects. */
  styleAdded: ((now, base) => layersOf(now).some((l) => !!l.style && JSON.stringify(l.style) !== JSON.stringify(byId(base, l.id)?.style))) as Check,
  /** The view was zoomed in. */
  zoomedIn: ((now, base) => now.zoom > base.zoom * 1.05) as Check,
  /** Any of the checks. */
  any: (...list: Check[]): Check => (now, base) => list.some((c) => c(now, base)),
};

// ----- Step state machine -----
export type TourState = { index: number; done: boolean[]; finished: boolean };

/** Steps of one tutorial: complete, skip, go back, restart. */
export class TourMachine {
  state: TourState;
  constructor(readonly count: number) {
    this.state = { index: 0, done: new Array(count).fill(false), finished: count === 0 };
  }
  get index() {
    return this.state.index;
  }
  get finished() {
    return this.state.finished;
  }
  /** "Step n of m" numbers (1-based). */
  progress() {
    return { step: Math.min(this.count, this.state.index + 1), of: this.count, completed: this.state.done.filter(Boolean).length };
  }
  /** The current step was performed: mark it and move on. */
  complete() {
    if (this.state.finished) return;
    this.state.done[this.state.index] = true;
    this.next();
  }
  /** Move on without doing the step (Skip, or Next on a reading step). */
  next() {
    if (this.state.finished) return;
    if (this.state.index < this.count - 1) this.state.index++;
    else this.state.finished = true;
  }
  back() {
    if (this.state.finished) this.state.finished = false;
    else if (this.state.index > 0) this.state.index--;
  }
  restart() {
    this.state = { index: 0, done: new Array(this.count).fill(false), finished: this.count === 0 };
  }
}
