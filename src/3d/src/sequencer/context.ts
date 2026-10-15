// Shared context helpers: the sequence editor data being edited and the hovered Sequencer editor.
import { app } from '../app/app';
import type { SeqChannel, SequenceEditor, SequencerToolSettings, Strip } from './types';
import { ensureEditor, editList, editChannels, findStrip, defaultToolSettings, updateEffectRanges, updateMetaBounds, channelLocked } from './strips';

export type SeqRegion = 'timeline' | 'channels' | 'preview' | 'sidebar' | 'toolbar' | 'other';
export type ViewType = 'SEQUENCER' | 'PREVIEW' | 'SEQUENCER_PREVIEW';

/** What operators need from a Sequencer editor instance (implemented by editor.ts). */
export interface SeqEditorLike {
  readonly isSequencer: true;
  view: ViewType;
  hover: SeqRegion | null;
  /** pixels per frame / per channel of the timeline */
  ppf: number;
  chH: number;
  /** timeline frame / channel under the pointer (null outside the timeline) */
  pointerFrame(clientX: number): number;
  pointerChannel(clientY: number): number;
  viewAll(): void;
  viewSelected(): void;
  viewFrame(): void;
  setView(v: ViewType): void;
  toggleSidebar(): void;
  toggleToolbar(): void;
  redraw(): void;
  requestPreview(): void;
  /** preview: client px → output (render) px, and display px per render px */
  previewToFrame(clientX: number, clientY: number): [number, number];
  previewScale(): number;
  previewFit(): void;
  previewZoom(factor: number): void;
  startBoxSelect(e: { clientX: number; clientY: number }, mode?: 'SET' | 'ADD' | 'SUB', startNow?: boolean, opts?: { includeHandles?: boolean; ignoreConnections?: boolean }): void;
  startCircle(mode?: 'SET' | 'ADD' | 'SUB'): void;
  startLasso(e: { clientX: number; clientY: number }, mode?: 'SET' | 'ADD' | 'SUB'): void;
  /** strip under a client point (timeline or preview, by the hovered region) */
  pickStrip(clientX: number, clientY: number): Strip | null;
  /** strips flagged as overlapping during a transform (drawn red) */
  invalid: Set<Strip>;
  showSeconds: boolean;
}

export function hoverSeq(): SeqEditorLike | null {
  const ed = (app.hoverArea ?? app.activeArea)?.editor as unknown as Partial<SeqEditorLike> | undefined;
  return ed?.isSequencer ? (ed as SeqEditorLike) : null;
}

export const overTimeline = () => {
  const h = hoverSeq()?.hover;
  return h === 'timeline' || h === 'toolbar';
};
export const overPreview = () => hoverSeq()?.hover === 'preview';
export const overChannels = () => hoverSeq()?.hover === 'channels';

export function seqEditor(): SequenceEditor {
  return ensureEditor(app.doc.scene);
}
export function hasEditor() {
  return !!app.doc.scene.sequence_editor;
}
/** Strips of the level being edited (top level or inside the current meta). */
export function seqList(): Strip[] {
  return editList(seqEditor());
}
export function seqChannels(): SeqChannel[] {
  return editChannels(seqEditor());
}
export function selectedStrips(): Strip[] {
  return seqList().filter((s) => s.select);
}
export function activeStrip(): Strip | null {
  const ed = app.doc.scene.sequence_editor;
  return ed ? findStrip(ed.strips, ed.active_strip) : null;
}
export function setActive(s: Strip | null) {
  seqEditor().active_strip = s ? s.name : null;
}
export function isLocked(s: Strip) {
  return s.lock || channelLocked(seqChannels(), s);
}
export function toolSettings(): SequencerToolSettings {
  const ts = app.doc.scene.tool_settings;
  ts.sequencer_tool_settings ??= defaultToolSettings();
  ts.use_snap_sequencer ??= true;
  return ts.sequencer_tool_settings;
}
export function sceneFps() {
  const r = app.doc.scene.render;
  return r.fps / (r.fps_base || 1);
}

/** After structural edits: effect ranges follow inputs, the edited meta follows its children. */
export function afterEdit() {
  const ed = seqEditor();
  updateEffectRanges(ed.strips);
  // metas along the edit path grow/shrink with their content
  const path: Strip[] = [];
  let list = ed.strips;
  for (const n of ed.meta_stack) {
    const m = list.find((s) => s.name === n && s.type === 'META');
    if (!m) break;
    path.push(m);
    list = m.strips ?? [];
  }
  for (let i = path.length - 1; i >= 0; i--) updateMetaBounds(path[i]);
}

/** Notify a document change that affects the sequencer (preview re-render + redraw). */
export function seqChanged() {
  app.changed('doc');
}
