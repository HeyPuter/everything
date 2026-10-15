// Mask data-blocks: layers of closed or open bezier splines in frame space (0..1 on both
// axes, origin bottom-left), with per-point feather widths, animated by per-layer shape keys.
// Used by the clip editor (mask mode), the compositor (Mask node) and the sequencer (mask strips).
import type { ID } from '../data/types';

export type MaskHandleType = 'AUTO' | 'VECTOR' | 'ALIGNED' | 'FREE';

export type MaskBlend = 'MERGE_ADD' | 'MERGE_SUBTRACT' | 'ADD' | 'SUBTRACT' | 'LIGHTEN' | 'DARKEN' | 'MUL' | 'DIFFERENCE' | 'REPLACE';

export interface MaskPoint {
  co: [number, number];
  handle_left: [number, number];
  handle_right: [number, number];
  handle_type: MaskHandleType;
  /** feather width outside the curve, as a share of the frame width */
  weight: number;
  select: boolean;
  /** handle selection (dragging one handle) */
  select_left_handle?: boolean;
  select_right_handle?: boolean;
  hide?: boolean;
}

export interface MaskSpline {
  points: MaskPoint[];
  use_cyclic: boolean;
  use_fill: boolean;
}

/** Shape key: all point coordinates of a layer at a frame (7 numbers per point, splines in order). */
export interface MaskShapeKey {
  frame: number;
  data: number[];
}

export interface MaskLayer {
  name: string;
  splines: MaskSpline[];
  alpha: number;
  blend: MaskBlend;
  invert: boolean;
  falloff: 'LINEAR' | 'SMOOTH';
  hide: boolean;
  hide_render: boolean;
  hide_select: boolean;
  shape_keys: MaskShapeKey[];
  /** index of the active spline (new points go there) */
  active_spline: number;
  /** tracking marker the layer's splines follow: [clip id, track name] (optional) */
  parent?: { clip: ID; track: string; frame: number; co: [number, number] } | null;
}

export interface MaskData {
  id: ID;
  name: string;
  layers: MaskLayer[];
  active_layer_index: number;
  frame_start: number;
  frame_end: number;
}

declare module '../data/types' {
  interface DocumentData {
    masks?: Record<ID, MaskData>;
  }
}

export function maskTable(doc: { masks?: Record<ID, MaskData> }): Record<ID, MaskData> {
  return (doc.masks ??= {});
}

export function newLayer(name = 'MaskLayer'): MaskLayer {
  return { name, splines: [], alpha: 1, blend: 'MERGE_ADD', invert: false, falloff: 'SMOOTH', hide: false, hide_render: false, hide_select: false, shape_keys: [], active_spline: -1 };
}

export function newMask(id: ID, name = 'Mask'): MaskData {
  return { id, name, layers: [newLayer()], active_layer_index: 0, frame_start: 1, frame_end: 100 };
}

export function newPoint(x: number, y: number, type: MaskHandleType = 'AUTO'): MaskPoint {
  return { co: [x, y], handle_left: [x, y], handle_right: [x, y], handle_type: type, weight: 0, select: true };
}

export function activeLayer(m: MaskData): MaskLayer | null {
  return m.layers[m.active_layer_index] ?? null;
}
