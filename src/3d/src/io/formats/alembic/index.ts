// Alembic registration: File ▸ Import / Export ▸ Alembic (.abc) (Ogawa archives).
import { app } from '../../../app/app';
import { commitToApp, defineFormat, reportWarnings } from '../glue';
import { readAlembic } from './read';
import { sampleAlembicScene } from './sample';
import { writeAlembicScene } from './write';

defineFormat({
  id: 'abc',
  label: 'Alembic (.abc)',
  extensions: ['.abc'],
  description: 'Alembic Ogawa archives: meshes, transforms (animated), cameras, vertex caches as shape keys',
  importOptions: [
    { id: 'scale', label: 'Scale', type: 'float', default: 1, min: 0.0001, max: 10000 },
    { id: 'set_frame_range', label: 'Set Frame Range', type: 'bool', default: true, description: "Use the archive's time range as the scene frame range" },
    { id: 'import_animation', label: 'Animation', type: 'bool', default: true, description: 'Animated transforms and vertex caches (as per-frame shape keys)' },
  ],
  exportOptions: [
    { id: 'start', label: 'Start', type: 'int', default: 1, min: -1048574, max: 1048574, dynamicDefault: () => app.doc.scene.frame_start, description: 'First frame to write (the scene start by default)' },
    { id: 'end', label: 'End', type: 'int', default: 250, min: -1048574, max: 1048574, dynamicDefault: () => app.doc.scene.frame_end, description: 'Last frame to write (the scene end by default)' },
    { id: 'global_scale', label: 'Scale', type: 'float', default: 1, min: 0.0001, max: 1000 },
    { id: 'flatten', label: 'Flatten Hierarchy', type: 'bool', default: false, description: 'Write every object at the top level with its world transform' },
    { id: 'uvs', label: 'UV Coordinates', type: 'bool', default: true },
    { id: 'normals', label: 'Normals', type: 'bool', default: true },
    { id: 'face_sets', label: 'Face Sets', type: 'bool', default: false, description: 'Write the faces of each material as a named face set' },
    { id: 'apply_modifiers', label: 'Apply Modifiers', type: 'bool', default: true, description: 'Write the evaluated meshes (viewport modifier settings)' },
  ],
  importOps: ['wm.alembic_import'],
  exportOps: ['wm.alembic_export'],
  importOpLabel: 'Import Alembic',
  exportOpLabel: 'Export Alembic',
  selectionProp: 'selected',
  multiFile: true,
  importData(src, o) {
    const ir = readAlembic(src.bytes);
    ir.unitScale *= Number(o.scale) || 1;
    if (!o.import_animation) ir.animations = [];
    commitToApp(ir, { setFrameRange: !!o.set_frame_range });
  },
  exportData(o) {
    const start = Number(o.start);
    const end = Math.max(start, Number(o.end));
    const res = sampleAlembicScene(app.doc, {
      frameStart: start,
      frameEnd: end,
      selectedOnly: o.selectedOnly,
      objectIds: o.objectIds,
      flatten: !!o.flatten,
      uvs: !!o.uvs,
      normals: !!o.normals,
      faceSets: !!o.face_sets,
      applyModifiers: !!o.apply_modifiers,
      scale: Number(o.global_scale) || 1,
    });
    reportWarnings(res.warnings);
    const bytes = writeAlembicScene({ roots: res.roots, fps: res.fps, frameStart: start, frames: res.frames });
    return { bytes, mime: 'application/octet-stream', ext: '.abc' };
  },
});
