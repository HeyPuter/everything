// FBX registration: File ▸ Import / Export ▸ FBX (.fbx)
import { commitToApp, defineFormat, encodeImagePng, exportSceneFromApp, reportWarnings, APPLY_MODIFIERS } from '../glue';
import { fbxExternalTextures, readFbx } from './read';
import { writeFbx } from './write';
import { AXIS_ITEMS, baseName, type AxisId } from '../common';

defineFormat({
  id: 'fbx',
  label: 'FBX (.fbx)',
  extensions: ['.fbx'],
  description: 'Autodesk FBX (binary 7.x or ASCII): meshes, materials, skeletons, shape keys and animation',
  importOptions: [
    { id: 'global_scale', label: 'Scale', type: 'float', default: 1, min: 0.0001, max: 10000 },
    { id: 'use_anim', label: 'Animation', type: 'bool', default: true },
    {
      id: 'shading',
      label: 'Shading',
      type: 'enum',
      default: 'NORMALS',
      items: [
        ['NORMALS', 'Use Normal / Smoothing Data'],
        ['FLAT', 'Flat Shading'],
        ['SMOOTH', 'Smooth Shading'],
      ],
    },
    {
      id: 'bone_heuristic',
      label: 'Bone Dir',
      type: 'enum',
      default: 'AUTO',
      items: [
        ['AUTO', 'Best Fit (point at children)'],
        ['Y', 'Keep Joint Axes'],
      ],
    },
  ],
  exportOptions: [
    { id: 'forward_axis', bpy: 'axis_forward', label: 'Forward', type: 'enum', default: '-Z', items: AXIS_ITEMS },
    { id: 'up_axis', bpy: 'axis_up', label: 'Up', type: 'enum', default: 'Y', items: AXIS_ITEMS },
    { id: 'global_scale', label: 'Scale', type: 'float', default: 1, min: 0.0001, max: 10000 },
    {
      id: 'apply_scale_options',
      label: 'Apply Scalings',
      type: 'enum',
      default: 'CM',
      items: [
        ['CM', 'FBX Units (cm, scale on roots)'],
        ['M', 'Meters (UnitScaleFactor 100)'],
      ],
      bpyItems: { FBX_SCALE_NONE: 'CM', FBX_SCALE_ALL: 'CM', FBX_SCALE_UNITS: 'M', FBX_SCALE_CUSTOM: 'M' },
    },
    { ...APPLY_MODIFIERS, bpy: 'use_mesh_modifiers' },
    { id: 'skins', label: 'Armatures & Skinning', type: 'bool', default: true },
    { id: 'shape_keys', label: 'Shape Keys', type: 'bool', default: true },
    { id: 'embed_textures', label: 'Embed Textures', type: 'bool', default: true },
    { id: 'bake_anim', label: 'Baked Animation', type: 'bool', default: true },
  ],
  importOps: ['wm.fbx_import', 'import_scene.fbx'],
  exportOps: ['export_scene.fbx'],
  importOpLabel: 'Import FBX',
  exportOpLabel: 'Export FBX',
  selectionProp: 'use_selection',
  multiFile: true,
  companions(src, have) {
    const missing = fbxExternalTextures(src.bytes).filter((n) => !have.has(baseName(n)));
    return missing.length ? { title: 'FBX Textures', message: `"${src.name}" references texture files that are not embedded. Select them to import the textures:`, names: missing, accept: 'image/*,.tga,.tif,.tiff,.dds' } : null;
  },
  importData(src, o) {
    const ir = readFbx(src.bytes, { resources: src.resources });
    ir.unitScale *= Number(o.global_scale) || 1;
    if (!o.use_anim) ir.animations = [];
    commitToApp(ir, { shading: o.shading as 'NORMALS', boneDirection: o.bone_heuristic as 'AUTO' });
  },
  exportData(o) {
    const scene = exportSceneFromApp({ selectedOnly: o.selectedOnly, objectIds: o.objectIds, applyModifiers: !!o.apply_modifiers, skins: !!o.skins, shapeKeys: !!o.shape_keys, animation: !!o.bake_anim });
    const res = writeFbx(scene, {
      forward: o.forward_axis as AxisId,
      up: o.up_axis as AxisId,
      scale: Number(o.global_scale) || 1,
      units: o.apply_scale_options as 'CM',
      embedTextures: !!o.embed_textures,
      animation: !!o.bake_anim,
      encodeImage: encodeImagePng,
    });
    reportWarnings(res.warnings);
    return { bytes: res.bytes, mime: 'application/octet-stream', ext: '.fbx' };
  },
});
