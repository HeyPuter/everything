// What the assistant's tools work against: the document, the geometry of the
// last rebuild and a way to wait for the next one. The app implements it
// (app/assistant-host.ts); tests implement it with the kernel in Node, so
// every modeling tool can be checked against real geometry.

import type { EdgeInfo, FaceInfo, FeatureStatus, MassProperties, MeasureResult, MeasureTarget } from '../kernel/protocol';
import type { Frame, Vec3 } from '../math/vec';
import type { DocStore } from '../model/document';
import type { DrawingDoc, DrawingViewKind, Id } from '../model/types';
import type { ViewName } from '../render/camera';
import type { DisplayStyle } from '../render/renderer';
import type { SelItem } from '../app/selection';

export interface AssistantHost {
  readonly store: DocStore;
  /** Faces, edges, plane frames and bounding box of the last rebuild. */
  readonly faces: FaceInfo[];
  readonly edges: EdgeInfo[];
  readonly frames: Record<Id, Frame>;
  readonly bbox: { min: Vec3; max: Vec3 } | null;
  featureStatus(id: Id): FeatureStatus | null;
  /** Resolves once the geometry reflects the document. */
  settle(): Promise<void>;
  massProperties(): Promise<MassProperties | null>;
  measure(a: MeasureTarget, b: MeasureTarget): Promise<MeasureResult>;
  /** Leaves sketch and feature editing so changes apply to the whole model. */
  prepareForEdit(): void;
  /** The interface around the model; missing when running without one. */
  readonly ui?: AssistantUI;
}

export interface AssistantUI {
  selection(): SelItem[];
  /** Sketch being edited, PropertyManager title and whether the drawing sheet is shown. */
  mode(): { sketch: Id | null; panel: string | null; drawing: boolean };
  setView(o: { orientation?: ViewName; normalTo?: Frame; fit?: boolean; style?: DisplayStyle }): void;
  /** Screenshot of the graphics area (optionally from another orientation, restored after). */
  capture(o: { orientation?: ViewName; style?: DisplayStyle; size?: number }): string | null;
  select(items: SelItem[]): void;
  showDrawing(on: boolean): void;
  arrangeDrawing(): void;
  addDrawingView(kind: DrawingViewKind): void;
  /** Inside a document change: keeps the views on a sheet whose size, orientation or scale (from oldScale) changed. */
  fitDrawingViews(d: DrawingDoc, oldScale: number): void;
  runCommand(id: string): boolean;
  /** Renames the part and its saved file, as Rename Part does. */
  renamePart(name: string): Promise<void>;
}
