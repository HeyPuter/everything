// Brush cursor state shared by the stroke driver and the cursor overlay (no DOM dependencies).
import type { Vector3 } from 'three';
import type { View3D } from '../editors/view3d/view3d';

export const cursorState = {
  x: 0,
  y: 0,
  inside: false,
  view: null as View3D | null,
  /** world hit point and normal under the cursor (sculpt mode surface cursor) */
  hit: null as { point: Vector3; normal: Vector3; radius: number } | null,
  /** brush radius in pixels at the cursor (scene-locked sizes vary with depth) */
  radiusPx: 0,
  /** last face hovered in Sculpt Mode (face set tools run from menus use it) */
  lastFace: -1,
  lastFaceMesh: '',
  /** radial control in progress */
  radial: null as null | {
    cx: number;
    cy: number;
    data: 'size' | 'strength' | 'weight' | 'angle';
    value: number;
  },
};
