// Content filters of the import / export options ("Cameras", "Lights", "Materials", "UV
// Coordinates", …): pure edits of an imported IR scene or of the scene about to be written.
import type { IRScene } from './ir';
import type { ExportScene } from './scene-builder';

export interface ContentFilter {
  cameras?: boolean;
  lights?: boolean;
  meshes?: boolean;
  materials?: boolean;
  uvs?: boolean;
  normals?: boolean;
  colors?: boolean;
  animation?: boolean;
}

/** Drop what the import options leave out (in place); nodes that lose everything stay as empties. */
export function filterImport(ir: IRScene, f: ContentFilter): IRScene {
  for (const n of ir.nodes) {
    if (f.cameras === false && n.camera) {
      delete n.camera;
      delete n.attachCorrection;
    }
    if (f.lights === false && n.light) {
      delete n.light;
      delete n.attachCorrection;
    }
    if (f.meshes === false && n.mesh !== undefined) {
      delete n.mesh;
      delete n.skin;
    }
  }
  for (const m of ir.meshes) {
    if (f.materials === false) {
      m.materials = [];
      m.materialIndex = undefined;
    }
    if (f.uvs === false) m.uvs = undefined;
    if (f.colors === false) m.colors = undefined;
    if (f.normals === false) m.normals = undefined;
  }
  if (f.materials === false) ir.materials = [];
  if (f.animation === false) ir.animations = [];
  return ir;
}

/** Drop what the export options leave out from a scene about to be written (in place). */
export function filterExport(scene: ExportScene, f: ContentFilter): ExportScene {
  for (const eo of scene.objects) {
    const m = eo.mesh;
    if (!m) continue;
    if (f.uvs === false) m.uvs = null;
    if (f.colors === false) m.colors = [];
    if (f.materials === false) m.materials = m.materials.map(() => null);
  }
  if (f.materials === false) scene.materials.clear();
  if (f.animation === false) {
    scene.tracks = [];
    scene.frames = [];
  }
  return scene;
}

/** Object types an export keeps, from per-type toggles (unset = kept). */
export function exportTypes(f: { meshes?: boolean; lights?: boolean; cameras?: boolean; curves?: boolean; armatures?: boolean; empties?: boolean }) {
  const t: ('MESH' | 'CURVE' | 'FONT' | 'EMPTY' | 'LIGHT' | 'CAMERA' | 'ARMATURE')[] = [];
  if (f.meshes !== false) t.push('MESH');
  if (f.curves !== false) t.push('CURVE', 'FONT');
  if (f.empties !== false) t.push('EMPTY');
  if (f.lights !== false) t.push('LIGHT');
  if (f.cameras !== false) t.push('CAMERA');
  if (f.armatures !== false) t.push('ARMATURE');
  return t;
}
