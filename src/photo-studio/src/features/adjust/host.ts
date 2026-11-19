// The contract between an adjustment editor (the controls for one kind) and
// where it is shown: the Properties panel for adjustment layers, or a modal
// dialog for destructive Image > Adjustments.
import type { Editor } from '../../editor';
import type { AdjustmentKind, AdjustmentParamsMap } from '../../imaging/adjust';
import type { SourceImage } from './source';

export interface AdjustHost<K extends AdjustmentKind = AdjustmentKind> {
  e: Editor;
  kind: K;
  // Working copy; editors mutate it and then call `change`.
  params: AdjustmentParamsMap[K];
  // Live preview while a gesture runs (commit = false), one history step or
  // final value when it ends (commit = true). `label` names the history step.
  change(commit: boolean, label?: string): void;
  // The adjustment layer being edited (absent in destructive dialogs).
  layerId?: string;
  // Pixels the adjustment applies to, with their histograms.
  source(): Promise<SourceImage | null>;
  // One-shot eyedropper: the source color under a canvas click.
  pick(): Promise<[number, number, number] | null>;
  // Re-mount the editor body after a wholesale change (Auto, presets).
  rerender(): void;
  // Editor-local UI state (selected channel, range...) that survives re-mounts.
  ui: Record<string, unknown>;
  dialog: boolean;
}

export type KindEditor<K extends AdjustmentKind = AdjustmentKind> = (body: HTMLElement, host: AdjustHost<K>) => void;
export type KindEditors = { [K in AdjustmentKind]: KindEditor<K> };
