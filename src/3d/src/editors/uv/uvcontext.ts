// App-facing helpers for the UV editor: edited meshes, select mode, the 2D cursor, the active
// UV editor and writing UVs/selection back.
import { app, type OpContext } from '../../app/app';
import type { MeshData, ObjectData, ImageData } from '../../data/types';
import { UVTopo, SelEdit, selReader, visibleFaces, type UVLayer, type StickyMode, type UVSelectMode } from './uvcore';
import { materialSlots } from '../view3d/draw';

/** What operators need from a UV editor view. */
export interface UVView {
  el: HTMLElement;
  zoom: number;
  pan: { x: number; y: number };
  toPx(u: number, v: number): { x: number; y: number };
  toUV(x: number, y: number): { u: number; v: number };
  /** pixels per UV unit */
  scale(): number;
  /** spacing of the grid lines shown (UV units) */
  gridStep(): number;
  draw(): void;
  pivot: 'BOUNDING_BOX_CENTER' | 'CURSOR' | 'INDIVIDUAL_ORIGINS' | 'MEDIAN_POINT';
  image(): ImageData | null;
  local(e: { clientX: number; clientY: number }): { x: number; y: number };
}

/** The 2D cursor in UV space. */
export const uvCursor = { u: 0, v: 0 };

export function activeUVEditor(area = app.hoverArea ?? app.activeArea): UVView | null {
  return area && area.type === 'UV' && area.editor ? (area.editor as UVView) : null;
}

export function ctxUVEditor(ctx: OpContext): UVView | null {
  return ctx.area?.type === 'UV' ? (ctx.area.editor as UVView) : activeUVEditor();
}

export interface EditLayer extends UVLayer {
  ob: ObjectData;
}

/**
 * Meshes being UV edited. Outside the UV editor (e.g. from the 3D Viewport) only selected faces
 * count, like unwrapping.
 */
export function uvLayers(fromView3D = false): EditLayer[] {
  if (app.doc.mode !== 'EDIT') return [];
  const sync = !fromView3D && app.doc.scene.tool_settings.use_uv_select_sync;
  return app
    .editObjects()
    .filter((o) => o.type === 'MESH' && o.data && app.doc.meshes[o.data])
    .map((ob) => {
      const me = app.doc.meshes[ob.data!];
      return { ob, me, faces: visibleFaces(me, sync), sync, objectId: ob.id };
    });
}

export function inUVEditor(ctx: OpContext) {
  return ctx.area?.type === 'UV';
}

export const uvEditPoll = () => app.doc.mode === 'EDIT' && app.editObjects().some((o) => o.type === 'MESH');
export const uvEditorPoll = (ctx: OpContext) => uvEditPoll() && (ctx.area?.type === 'UV' || !!activeUVEditor());

export function stickyMode(): StickyMode {
  const ts = app.doc.scene.tool_settings;
  return ts.use_uv_select_sync ? 'SHARED_VERTEX' : ts.uv_sticky_select_mode ?? 'SHARED_LOCATION';
}

/** UV select mode; with sync selection it follows the mesh select mode. */
export function uvSelectMode(): UVSelectMode {
  const ts = app.doc.scene.tool_settings;
  if (ts.use_uv_select_sync) {
    const m = ts.mesh_select_mode;
    return m[0] ? 'VERTEX' : m[1] ? 'EDGE' : 'FACE';
  }
  return ts.uv_select_mode ?? 'VERTEX';
}

/** Topology, a selection reader and a selection writer for each layer. */
export function layerTopos(layers = uvLayers()) {
  return layers.map((l) => ({ layer: l, t: new UVTopo(l), sel: selReader(l) }));
}

export function editSel(l: UVLayer) {
  return new SelEdit(l);
}

/** Write new UVs to a mesh. */
export function setUVs(me: MeshData, uvs: Float32Array) {
  me.uvs = uvs;
}

/** Notify after UV or selection edits. */
export function uvChanged(select = false) {
  app.changed(select ? 'select' : 'geometry', 'doc');
}

/** Image the UV editor shows when none was picked: the active material's first image texture. */
export function autoImage(ob: ObjectData): ImageData | null {
  const slots = materialSlots(app.doc, ob);
  const ma = slots[ob.active_material_index] ?? slots[0];
  const mat = ma ? app.doc.materials[ma] : undefined;
  const node = mat?.tree.nodes.find((n) => n.type === 'ShaderNodeTexImage' && n.props.image);
  const id = node?.props.image as string | undefined;
  return id ? (app.doc.images[id] ?? null) : null;
}

/** Pick radius in UV units (12 px in the active editor). */
export function pickRadius(view: UVView | null, px = 12) {
  return view ? px / view.scale() : 0.02;
}
