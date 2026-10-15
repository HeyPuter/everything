// Edit Mode context helpers: the edited objects, select mode, active element.
import { app } from '../../app/app';
import type { MeshData, ObjectData } from '../../data/types';
import { MeshEdit } from './meshedit';
import { Matrix4 } from 'three';

export type SelMode = 'VERT' | 'EDGE' | 'FACE';

export function selectMode(): SelMode {
  const m = app.doc.scene.tool_settings.mesh_select_mode;
  return m[2] && !m[0] && !m[1] ? 'FACE' : m[1] && !m[0] ? 'EDGE' : 'VERT';
}

export function selectModes(): [boolean, boolean, boolean] {
  return app.doc.scene.tool_settings.mesh_select_mode;
}

/** Active element for highlighting (white) — not part of the document. */
export const active = { objectId: '' as string, kind: '' as '' | 'VERT' | 'EDGE' | 'FACE', index: -1, edge: [-1, -1] as [number, number] };

/** Recently clicked elements (newest last), for Next/Previous Active and Shortest Path. */
export const selectHistory: { objectId: string; kind: 'VERT' | 'EDGE' | 'FACE'; index: number; edge: [number, number] }[] = [];

export function pushSelectHistory() {
  if (!active.kind) return;
  const last = selectHistory[selectHistory.length - 1];
  const entry = { objectId: active.objectId, kind: active.kind, index: active.index, edge: [active.edge[0], active.edge[1]] as [number, number] };
  if (last && last.objectId === entry.objectId && last.kind === entry.kind && last.index === entry.index && last.edge.join() === entry.edge.join()) return;
  selectHistory.push(entry);
  if (selectHistory.length > 32) selectHistory.shift();
}

export function editMeshObjects(): { ob: ObjectData; me: MeshData }[] {
  if (app.doc.mode !== 'EDIT') return [];
  return app
    .editObjects()
    .filter((o) => o.type === 'MESH' && o.data && app.doc.meshes[o.data])
    .map((ob) => ({ ob, me: app.doc.meshes[ob.data!] }));
}

export function inMeshEdit() {
  return app.doc.mode === 'EDIT' && app.activeObject?.type === 'MESH';
}

/** Run an edit on every edited mesh via MeshEdit, writing the result back. */
export function withEdit(fn: (m: MeshEdit, ob: ObjectData, me: MeshData) => boolean | void): boolean {
  let changed = false;
  for (const { ob, me } of editMeshObjects()) {
    const m = MeshEdit.from(me);
    if (fn(m, ob, me) === false) continue;
    m.write(me);
    changed = true;
  }
  if (changed) app.changed('doc', 'geometry');
  return changed;
}

export function worldMatrix(ob: ObjectData): Matrix4 {
  return app.graph.get(ob.id)?.world ?? new Matrix4();
}

/** Ensure select_vert exists for a mesh. */
export function ensureSelection(me: MeshData) {
  if (!me.select_vert || me.select_vert.length !== me.positions.length / 3) me.select_vert = new Uint8Array(me.positions.length / 3);
}
