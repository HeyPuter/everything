// USD registration: File ▸ Import / Export ▸ Universal Scene Description (.usd*)
import { zipSync } from 'three/examples/jsm/libs/fflate.module.js';
import { commitToApp, defineFormat, encodeImagePng, exportSceneFromApp, reportWarnings, APPLY_MODIFIERS } from '../glue';
import { baseName } from '../common';
import { readUsd, usdExternalFiles } from './read';
import { packUsdz, writeUsda } from './write';
import { app } from '../../../app/app';

defineFormat({
  id: 'usd',
  label: 'Universal Scene Description (.usd*)',
  extensions: ['.usd', '.usda', '.usdc', '.usdz'],
  description: 'USD text (.usda), binary crate (.usdc) and packages (.usdz)',
  importOptions: [
    { id: 'scale', label: 'Scale', type: 'float', default: 1, min: 0.0001, max: 10000 },
    { id: 'import_animation', label: 'Animation', type: 'bool', default: true },
    { id: 'set_frame_range', label: 'Set Frame Range', type: 'bool', default: true, description: 'Use the file\'s time range as the scene frame range' },
    {
      id: 'shading',
      label: 'Shading',
      type: 'enum',
      default: 'NORMALS',
      items: [
        ['NORMALS', 'Use Normal Data'],
        ['FLAT', 'Flat Shading'],
        ['SMOOTH', 'Smooth Shading'],
      ],
    },
  ],
  exportOptions: [
    {
      id: 'format',
      label: 'Format',
      type: 'enum',
      default: 'USDZ',
      items: [
        ['USDZ', 'USDZ package (.usdz)'],
        ['USDA', 'USD text (.usda)'],
        ['USDA_ZIP', 'USDA + textures (.zip)'],
      ],
    },
    {
      id: 'up_axis',
      label: 'Up Axis',
      type: 'enum',
      default: 'Z',
      items: [
        ['Z', 'Z'],
        ['Y', 'Y'],
      ],
    },
    APPLY_MODIFIERS,
    { id: 'export_armatures', label: 'Armatures (UsdSkel)', type: 'bool', default: true },
    { id: 'export_shapekeys', label: 'Shape Keys', type: 'bool', default: true },
    { id: 'export_animation', label: 'Animation', type: 'bool', default: false, description: 'Write the animation of the scene frame range as time samples' },
  ],
  importOps: ['wm.usd_import'],
  exportOps: ['wm.usd_export'],
  importOpLabel: 'Import USD',
  exportOpLabel: 'Export USD',
  selectionProp: 'selected_objects_only',
  multiFile: true,
  companions(src, have) {
    const missing = usdExternalFiles(src.bytes).filter((n) => !have.has(baseName(n)));
    return missing.length ? { title: 'USD Dependencies', message: `"${src.name}" references other files (textures, layers). Select them to include them:`, names: missing, accept: '.usd,.usda,.usdc,image/*' } : null;
  },
  importData(src, o) {
    const ir = readUsd(src.bytes, { resources: src.resources });
    ir.unitScale *= Number(o.scale) || 1;
    if (!o.import_animation) ir.animations = [];
    commitToApp(ir, { shading: o.shading as 'NORMALS', setFrameRange: !!o.set_frame_range });
  },
  exportData(o, target) {
    const scene = exportSceneFromApp({
      selectedOnly: o.selectedOnly,
      objectIds: o.objectIds,
      applyModifiers: !!o.apply_modifiers,
      skins: !!o.export_armatures,
      shapeKeys: !!o.export_shapekeys,
      animation: !!o.export_animation,
    });
    const out = writeUsda(scene, { upAxis: o.up_axis as 'Z', animation: !!o.export_animation, encodeImage: encodeImagePng });
    reportWarnings(out.warnings);
    const base = target.base;
    // a written path picks the variant by its extension
    const ext = target.path ? (/\.(usdz|usda|usdc|usd)$/i.exec(target.path)?.[1]?.toLowerCase() ?? '') : '';
    let format = String(o.format);
    if (ext === 'usdz') format = 'USDZ';
    else if (ext === 'usda' || ext === 'usd') format = 'USDA';
    else if (ext === 'usdc') {
      app.report('WARNING', 'Binary crate (.usdc) writing is not available; the file holds USD text');
      format = 'USDA';
    }
    if (format === 'USDA' || (format === 'USDA_ZIP' && target.toFiles)) {
      if (target.toFiles) return { bytes: out.usda, mime: 'text/plain', ext: ext ? `.${ext}` : '.usda', extra: out.textures.map((t) => ({ name: t.path, bytes: t.bytes, mime: 'application/octet-stream' })) };
      if (out.textures.length) app.report('WARNING', `${out.textures.length} texture(s) are referenced but not included; use USDZ or "USDA + textures" to keep them`);
      return { bytes: out.usda, mime: 'text/plain', ext: '.usda' };
    }
    if (format === 'USDA_ZIP') {
      const files: Record<string, Uint8Array> = { [`${base}.usda`]: new TextEncoder().encode(out.usda) };
      for (const t of out.textures) files[t.path] = t.bytes;
      return { bytes: zipSync(files, { level: 6 }), mime: 'application/zip', ext: '.usda.zip' };
    }
    return { bytes: packUsdz(out, `${base}.usda`), mime: 'model/vnd.usdz+zip', ext: '.usdz' };
  },
});
