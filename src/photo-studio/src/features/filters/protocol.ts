// Messages between the UI and the filter worker.
import type { BlendMode } from '../../imaging/blend';
import type { IRect, RGBA8 } from '../../imaging/types';
import type { StackContext, StackEntry } from './stack';
import type { GridPayload, TileResult } from './tilepack';

// A region of a tile grid the worker keeps while a dialog is open, so slider
// changes only send parameters.
export type LoadMessage = { type: 'load'; key: string; rect: IRect; image: GridPayload; selection?: GridPayload; mask?: GridPayload };
// A pane view: a crop of the region reduced by 2^level (level coordinates).
export type View = { level: number; x: number; y: number; width: number; height: number };
export type RunMessage = {
  type: 'run';
  job: number;
  key: string;
  filters: StackEntry[];
  ctx: StackContext;
  useSelection: boolean;
  useMask: boolean;
  // The layer's transparency is locked: results keep the source alpha.
  keepAlpha?: boolean;
  view?: View;
  output: 'image' | 'tiles';
};
export type ThumbsMessage = { type: 'thumbs'; job: number; key: string; view: View; filters: StackEntry[][]; ctx: StackContext };
export type LiquifyMessage = {
  type: 'liquify';
  job: number;
  key: string;
  field: Uint8Array;
  useSelection: boolean;
  keepAlpha?: boolean;
};
export type FadeMessage = { type: 'fade'; job: number; beforeKey: string; afterKey: string; mode: BlendMode; opacity: number; view?: View; output: 'image' | 'tiles' };
export type DropMessage = { type: 'drop'; key: string };
export type ToWorker = LoadMessage | RunMessage | ThumbsMessage | LiquifyMessage | FadeMessage | DropMessage;

export type FromWorker =
  | { type: 'progress'; job: number; value: number }
  | { type: 'done'; job: number; image?: RGBA8; images?: RGBA8[]; tiles?: TileResult }
  | { type: 'error'; job: number; message: string; cancelled?: boolean };
