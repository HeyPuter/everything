// glTF 2.0 registration: File ▸ Import / Export ▸ glTF 2.0 (.glb/.gltf)
import { commitToApp, defineFormat, encodeImagePng, exportSceneFromApp, packMetallicRoughnessPng, reportWarnings, APPLY_MODIFIERS } from '../glue';
import { externalUris, parseContainer, readGltf } from './read';
import { writeGltf } from './write';
import { baseName } from '../common';

defineFormat({
  id: 'gltf',
  label: 'glTF 2.0 (.glb/.gltf)',
  extensions: ['.glb', '.gltf'],
  description: 'Khronos glTF 2.0 binary or JSON (embedded or with external .bin/textures)',
  importOptions: [
    { id: 'merge_vertices', label: 'Merge Vertices', type: 'bool', default: false, description: 'Weld vertices with identical positions (sharp edges are kept where normals differ)' },
    {
      id: 'shading',
      bpy: 'import_shading',
      label: 'Shading',
      type: 'enum',
      default: 'NORMALS',
      items: [
        ['NORMALS', 'Use Normal Data'],
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
        ['Y', 'glTF (keep joint axes)'],
      ],
      bpyItems: { BLENDER: 'Y', TEMPERANCE: 'AUTO', FORTUNE: 'AUTO' },
    },
  ],
  exportOptions: [
    {
      id: 'format',
      bpy: 'export_format',
      label: 'Format',
      type: 'enum',
      default: 'GLB',
      bpyItems: { GLTF_SEPARATE: 'GLTF_EMBEDDED' },
      items: [
        ['GLB', 'glTF Binary (.glb)'],
        ['GLTF_EMBEDDED', 'glTF Embedded (.gltf)'],
      ],
    },
    { id: 'y_up', bpy: 'export_yup', label: '+Y Up', type: 'bool', default: true },
    { ...APPLY_MODIFIERS, bpy: 'export_apply' },
    { id: 'skins', bpy: 'export_skins', label: 'Skinning', type: 'bool', default: true, description: 'Export armatures as skins (armature modifiers are not applied)' },
    { id: 'shape_keys', bpy: 'export_morph', label: 'Shape Keys', type: 'bool', default: true, description: 'Export shape keys as morph targets' },
    { id: 'animation', bpy: 'export_animations', label: 'Animation', type: 'bool', default: true, description: 'Sample object, bone and shape key animation every frame' },
    {
      id: 'animation_mode',
      bpy: 'export_animation_mode',
      label: 'Animation Mode',
      type: 'enum',
      default: 'ACTIONS',
      items: [
        ['ACTIONS', 'Actions'],
        ['SCENE', 'Scene (single animation)'],
      ],
      bpyItems: { ACTIVE_ACTIONS: 'ACTIONS', BROADCAST: 'ACTIONS', NLA_TRACKS: 'ACTIONS' },
      showIf: (v) => !!v.animation,
    },
    { id: 'scene_range', label: 'Use Scene Frame Range', type: 'bool', default: false, showIf: (v) => !!v.animation },
    { id: 'extras', bpy: 'export_extras', label: 'Custom Properties', type: 'bool', default: true },
  ],
  importOps: ['import_scene.gltf'],
  exportOps: ['export_scene.gltf'],
  importOpLabel: 'Import glTF 2.0',
  exportOpLabel: 'Export glTF 2.0',
  selectionProp: 'use_selection',
  multiFile: true,
  companions(src, have) {
    if (src.name.toLowerCase().endsWith('.glb')) return null;
    const { json } = parseContainer(src.bytes);
    const missing = externalUris(json).filter((u) => !have.has(baseName(decodeURIComponent(u))));
    if (!missing.length) return null;
    return {
      title: 'External glTF Resources',
      message: `"${src.name}" references external files. Select them (they can be chosen together) to import buffers and textures:`,
      names: missing.map((u) => decodeURIComponent(u)),
      accept: [...new Set(missing.map((m) => `.${m.split('.').pop()}`))].join(','),
    };
  },
  importData(src, o) {
    const ir = readGltf(src.bytes, { resources: src.resources });
    commitToApp(ir, { mergeVertices: !!o.merge_vertices, shading: o.shading as 'NORMALS', boneDirection: o.bone_heuristic as 'AUTO' });
  },
  exportData(o, target) {
    const scene = exportSceneFromApp({
      selectedOnly: o.selectedOnly,
      objectIds: o.objectIds,
      applyModifiers: !!o.apply_modifiers,
      skins: !!o.skins,
      shapeKeys: !!o.shape_keys,
      animation: !!o.animation,
      sceneFrameRange: !!o.scene_range,
    });
    // a written path ending in .gltf asks for the JSON variant
    const glb = target.path && /\.gltf$/i.test(target.path) ? false : o.format !== 'GLTF_EMBEDDED';
    const res = writeGltf(scene, {
      format: glb ? 'GLB' : 'GLTF_EMBEDDED',
      yUp: !!o.y_up,
      extras: !!o.extras,
      encodeImage: encodeImagePng,
      packMetallicRoughness: packMetallicRoughnessPng,
      animationMode: o.animation_mode as 'ACTIONS',
      generator: 'Puter 3D glTF exporter',
    });
    reportWarnings(res.warnings);
    return { bytes: res.bytes, mime: glb ? 'model/gltf-binary' : 'model/gltf+json', ext: glb ? '.glb' : '.gltf' };
  },
});
