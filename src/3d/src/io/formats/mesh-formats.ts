// Registration of the mesh-centric formats: Wavefront OBJ (+MTL), STL and Stanford PLY.
import { zipSync } from 'three/examples/jsm/libs/fflate.module.js';
import { commitToApp, defineFormat, encodeImagePng, exportSceneFromApp, reportWarnings, APPLY_MODIFIERS } from './glue';
import type { FormatOption } from './ui';
import { mtlTextureFiles, objMaterialLibraries, readObj, writeObj } from './obj';
import { readStl, writeStl } from './stl';
import { readPly, writePly } from './ply';
import { AXIS_ITEMS, baseName, stripExt, type AxisId } from './common';
import { app } from '../../app/app';

// scripting spells negative axes NEGATIVE_X…
const AXIS_BPY = { NEGATIVE_X: '-X', NEGATIVE_Y: '-Y', NEGATIVE_Z: '-Z' };
const axisOptions = (forward: AxisId, up: AxisId): FormatOption[] => [
  { id: 'forward_axis', label: 'Forward Axis', type: 'enum', default: forward, items: AXIS_ITEMS, bpyItems: AXIS_BPY },
  { id: 'up_axis', label: 'Up Axis', type: 'enum', default: up, items: AXIS_ITEMS, bpyItems: AXIS_BPY },
];
const scaleOption = (label = 'Scale'): FormatOption => ({ id: 'global_scale', label, type: 'float', default: 1, min: 0.0001, max: 10000, step: 0.01 });
const axisArgs = (o: Record<string, unknown>) => ({ forward: o.forward_axis as AxisId, up: o.up_axis as AxisId, scale: Number(o.global_scale) || 1 });

// ---------------------------------------------------------------------------- OBJ
defineFormat({
  id: 'obj',
  label: 'Wavefront (.obj)',
  extensions: ['.obj'],
  description: 'Wavefront OBJ with MTL materials',
  importOptions: [
    ...axisOptions('-Z', 'Y'),
    scaleOption(),
    { id: 'use_split_objects', label: 'Split By Object', type: 'bool', default: true },
    { id: 'use_split_groups', label: 'Split By Group', type: 'bool', default: false },
  ],
  exportOptions: [
    ...axisOptions('-Z', 'Y'),
    scaleOption(),
    APPLY_MODIFIERS,
    { id: 'export_uv', label: 'UV Coordinates', type: 'bool', default: true },
    { id: 'export_normals', label: 'Normals', type: 'bool', default: true },
    { id: 'export_colors', label: 'Colors', type: 'bool', default: false },
    { id: 'export_triangulated_mesh', label: 'Triangulated Mesh', type: 'bool', default: false },
    { id: 'export_smooth_groups', label: 'Smooth Groups', type: 'bool', default: true },
    { id: 'export_object_groups', label: 'Object Groups (g)', type: 'bool', default: false },
    { id: 'export_materials', label: 'Export Materials', type: 'bool', default: true },
    {
      id: 'packaging',
      label: 'Output',
      type: 'enum',
      default: 'ZIP',
      items: [
        ['ZIP', 'ZIP (OBJ + MTL + textures)'],
        ['FILES', 'Separate downloads'],
      ],
      showIf: (v) => !!v.export_materials,
    },
  ],
  importOps: ['wm.obj_import'],
  exportOps: ['wm.obj_export'],
  importOpLabel: 'Import Wavefront OBJ',
  exportOpLabel: 'Export Wavefront OBJ',
  selectionProp: 'export_selected_objects',
  multiFile: true,
  companions(src, have) {
    const text = new TextDecoder().decode(src.bytes);
    const libs = objMaterialLibraries(text);
    if (!libs.length) return null;
    const mtls = [...have.entries()].filter(([n]) => n.toLowerCase().endsWith('.mtl'));
    if (!mtls.length) return { title: 'Materials', message: `"${src.name}" uses material libraries. Select the .mtl file(s) and their texture images together:`, names: libs, accept: '.mtl,image/*,.tga,.tif,.tiff' };
    // textures referenced by the libraries that are not known yet
    const missing = mtls
      .flatMap(([, b]) => mtlTextureFiles(new TextDecoder().decode(b)))
      .filter((n) => ![...have.keys()].some((k) => k.toLowerCase() === baseName(n).toLowerCase()));
    return missing.length ? { title: 'Textures', message: 'The material library references these images:', names: [...new Set(missing)], accept: 'image/*,.tga,.tif,.tiff' } : null;
  },
  importData(src, o) {
    const ir = readObj(new TextDecoder().decode(src.bytes), { ...axisArgs(o), splitByObject: !!o.use_split_objects, splitByGroup: !!o.use_split_groups, resources: src.resources });
    commitToApp(ir, { setFrameRange: false });
  },
  exportData(o, target) {
    const scene = exportSceneFromApp({ selectedOnly: o.selectedOnly, objectIds: o.objectIds, applyModifiers: !!o.apply_modifiers, skins: false, shapeKeys: false, animation: false, types: ['MESH', 'CURVE', 'FONT'] });
    const base = target.base;
    const res = writeObj(scene, {
      ...axisArgs(o),
      uvs: !!o.export_uv,
      normals: !!o.export_normals,
      colors: !!o.export_colors,
      triangulate: !!o.export_triangulated_mesh,
      smoothGroups: !!o.export_smooth_groups,
      groups: !!o.export_object_groups,
      materials: !!o.export_materials,
      mtlName: `${base}.mtl`,
    });
    reportWarnings(res.warnings);
    if (!res.mtl) return { bytes: res.obj, mime: 'text/plain', ext: '.obj' };
    const textures: { name: string; bytes: Uint8Array }[] = [];
    for (const t of res.textures) {
      const bytes = t.bytes ?? encodeImagePng(app.doc.images[t.imageId])?.bytes ?? null;
      if (bytes) textures.push({ name: t.name, bytes });
      else app.report('WARNING', `Texture "${t.name}" could not be written`);
    }
    if (target.toFiles || o.packaging === 'FILES')
      return { bytes: res.obj, mime: 'text/plain', ext: '.obj', extra: [{ name: `${base}.mtl`, bytes: res.mtl, mime: 'text/plain' }, ...textures.map((t) => ({ ...t, mime: 'application/octet-stream' }))] };
    const enc = new TextEncoder();
    const files: Record<string, Uint8Array> = { [`${base}.obj`]: enc.encode(res.obj), [`${base}.mtl`]: enc.encode(res.mtl) };
    for (const t of textures) files[t.name] = t.bytes;
    return { bytes: zipSync(files, { level: 6 }), mime: 'application/zip', ext: '.obj.zip' };
  },
});

// ---------------------------------------------------------------------------- PLY
defineFormat({
  id: 'ply',
  label: 'Stanford PLY (.ply)',
  extensions: ['.ply'],
  description: 'Stanford polygon file (ASCII or binary) with normals, UVs and vertex colors',
  importOptions: [
    ...axisOptions('Y', 'Z'),
    scaleOption(),
    { id: 'merge_verts', label: 'Merge Vertices', type: 'bool', default: false },
    {
      id: 'import_colors',
      label: 'Vertex Colors',
      type: 'enum',
      default: 'SRGB',
      items: [
        ['NONE', 'None'],
        ['SRGB', 'sRGB'],
        ['LINEAR', 'Linear'],
      ],
    },
  ],
  exportOptions: [
    { id: 'ascii_format', label: 'ASCII', type: 'bool', default: false },
    ...axisOptions('Y', 'Z'),
    scaleOption(),
    APPLY_MODIFIERS,
    { id: 'export_normals', label: 'Normals', type: 'bool', default: false },
    { id: 'export_uv', label: 'UV Coordinates', type: 'bool', default: true },
    {
      id: 'export_colors',
      label: 'Vertex Colors',
      type: 'enum',
      default: 'SRGB',
      items: [
        ['NONE', 'None'],
        ['SRGB', 'sRGB'],
        ['LINEAR', 'Linear'],
      ],
    },
    { id: 'export_triangulated_mesh', label: 'Triangulated Mesh', type: 'bool', default: false },
  ],
  importOps: ['wm.ply_import'],
  exportOps: ['wm.ply_export'],
  importOpLabel: 'Import PLY',
  exportOpLabel: 'Export PLY',
  selectionProp: 'export_selected_objects',
  multiFile: true,
  importData(src, o) {
    const ir = readPly(src.bytes, { ...axisArgs(o), name: stripExt(src.name), colorSpace: o.import_colors as 'SRGB' });
    commitToApp(ir, { mergeVertices: !!o.merge_verts, setFrameRange: false });
  },
  exportData(o) {
    const scene = exportSceneFromApp({ selectedOnly: o.selectedOnly, objectIds: o.objectIds, applyModifiers: !!o.apply_modifiers, skins: false, shapeKeys: false, animation: false, types: ['MESH', 'CURVE', 'FONT'] });
    const res = writePly(scene, {
      ...axisArgs(o),
      ascii: !!o.ascii_format,
      normals: !!o.export_normals,
      uvs: !!o.export_uv,
      colors: o.export_colors as 'SRGB',
      triangulate: !!o.export_triangulated_mesh,
    });
    reportWarnings(res.warnings);
    return { bytes: res.bytes, mime: 'application/octet-stream', ext: '.ply' };
  },
});

// ---------------------------------------------------------------------------- STL
defineFormat({
  id: 'stl',
  label: 'STL (.stl)',
  extensions: ['.stl'],
  description: 'Stereolithography triangles (binary or ASCII)',
  importOptions: [
    ...axisOptions('Y', 'Z'),
    scaleOption(),
    { id: 'merge_verts', label: 'Merge Vertices', type: 'bool', default: true, description: 'Weld coincident triangle corners into connected geometry' },
  ],
  exportOptions: [{ id: 'ascii_format', label: 'ASCII', type: 'bool', default: false }, ...axisOptions('Y', 'Z'), scaleOption(), APPLY_MODIFIERS],
  importOps: ['wm.stl_import'],
  exportOps: ['wm.stl_export'],
  importOpLabel: 'Import STL',
  exportOpLabel: 'Export STL',
  selectionProp: 'export_selected_objects',
  multiFile: true,
  importData(src, o) {
    const ir = readStl(src.bytes, { ...axisArgs(o), name: stripExt(src.name), mergeVertices: !!o.merge_verts });
    commitToApp(ir, { setFrameRange: false });
  },
  exportData(o, target) {
    const scene = exportSceneFromApp({ selectedOnly: o.selectedOnly, objectIds: o.objectIds, applyModifiers: !!o.apply_modifiers, skins: false, shapeKeys: false, animation: false, types: ['MESH', 'CURVE', 'FONT'] });
    const res = writeStl(scene, { ...axisArgs(o), ascii: !!o.ascii_format, name: target.base });
    reportWarnings(res.warnings);
    return { bytes: res.bytes, mime: 'model/stl', ext: '.stl' };
  },
});
