/**
 * 3D export entry points: OBJ and glTF Binary in Export As (export
 * formats), and the 3D and Materials panel menu (the selected 3D objects).
 * The writers load on first use (export-3d.js).
 */
import { exportFormats } from '../io/hooks.js';
import { UserError } from '../../lib/errors.js';

const ORIENTATIONS = [
  { value: 'view', label: 'As shown (with the 3D rotation)' },
  { value: 'model', label: 'Unturned (front view)' },
];
const OBJ_UNITS = [
  { value: 'mm', label: 'Millimeters', perPt: 25.4 / 72 },
  { value: 'cm', label: 'Centimeters', perPt: 2.54 / 72 },
  { value: 'in', label: 'Inches', perPt: 1 / 72 },
  { value: 'pt', label: 'Points', perPt: 1 },
  { value: 'm', label: 'Meters', perPt: 0.0254 / 72 },
];

const stem = (s) => String(s || 'Untitled').replace(/\.[a-z0-9]+$/i, '').replace(/[\\/:*?"<>|]+/g, '-').trim() || 'Untitled';

/** A Blob for the given 3D objects: GLB bytes, or a ZIP with the OBJ file and its materials. */
export async function exportThreeD(doc, nodes, format, options = {}) {
  const { collectSolids, writeOBJ, writeGLB, PT_M } = await import('./export-3d.js');
  const solids = collectSolids(doc, nodes, { orientation: options.orientation || 'view' });
  if (!solids.length) throw new UserError('There are no 3D objects to export.');
  const name = stem(options.title || doc.name);
  if (format === 'glb') return new Blob([writeGLB(solids, { scale: PT_M, name })], { type: 'model/gltf-binary' });
  const unit = OBJ_UNITS.find((u) => u.value === options.units) || OBJ_UNITS[0];
  const { obj, mtl } = writeOBJ(solids, { scale: unit.perPt, name });
  const { createZip } = await import('../io/zip.js');
  const safe = name.replace(/\s+/g, '_').replace(/[^\w.-]/g, '') || 'Object';
  const zip = await createZip([
    { name: `${name}.obj`, data: obj.replace(/^mtllib .*$/m, `mtllib ${safe}.mtl`) },
    { name: `${safe}.mtl`, data: mtl },
  ]);
  zip.fileExt = 'zip';
  return zip;
}

async function render(app, editor, region, options, format) {
  const { exportRegion } = await import('../io/raster.js');
  const { threeDObjects } = await import('./export-3d.js');
  const { rect, ids } = exportRegion(editor, region.rects ? { rect: region.rects[0] } : region);
  const nodes = threeDObjects(editor.doc, ids, ids ? null : rect);
  return exportThreeD(editor.doc, nodes, format, options);
}

function optionsUI(format) {
  return (app, o, { row, select }) => {
    const orient = select(ORIENTATIONS, o.orientation || 'view');
    const fields = [row('Orientation', orient)];
    let units = null;
    if (format === 'obj') {
      units = select(OBJ_UNITS.map(({ value, label }) => ({ value, label })), o.units || 'mm');
      fields.push(row('One unit is', units, { help: 'The file also gets a material library (.mtl); both come in a ZIP archive.' }));
    } else fields.push(row('Units', select([{ value: 'm', label: 'Meters (real size)' }], 'm')));
    return { fields, read: () => ({ orientation: orient.value, ...(units ? { units: units.value } : {}) }) };
  };
}

export function installThreeDExport(app) {
  exportFormats.set('obj', { label: 'Wavefront OBJ (obj)', title: 'OBJ', ext: 'obj', mime: 'model/obj', defaults: { orientation: 'view', units: 'mm' }, options: optionsUI('obj'), render: (a, ed, region, options) => render(app, ed, region, options, 'obj') });
  exportFormats.set('glb', { label: 'glTF Binary (glb)', title: 'glTF', ext: 'glb', mime: 'model/gltf-binary', defaults: { orientation: 'view' }, options: optionsUI('glb'), render: (a, ed, region, options) => render(app, ed, region, options, 'glb') });
}

/** Panel menu: export the selected 3D objects and download (or save) the file. */
export async function exportSelection(app, nodes, format) {
  const doc = app.editor?.doc;
  if (!doc || !nodes.length) return false;
  try {
    const blob = await exportThreeD(doc, nodes, format, { title: doc.name, orientation: 'view', units: 'mm' });
    const { deliverFiles } = await import('../io/deliver.js');
    const msg = await deliverFiles(app, [{ name: `${stem(doc.name)}.${blob.fileExt || format}`, blob }]);
    if (msg) app.notify?.(msg);
    return true;
  } catch (err) {
    app.notify?.(err?.message || 'The 3D export failed.', { error: true });
    return false;
  }
}
