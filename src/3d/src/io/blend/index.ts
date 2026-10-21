// .blend import: File ▸ Open replaces the document, File ▸ Import appends the
// scene's objects and collections into the current scene.
import { app } from '../../app/app';
import { registerFormat } from '../files';
import { readBlend, type BlendImport } from './convert';
import { appendBlend } from './append';

async function load(file: File): Promise<BlendImport> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  return readBlend(bytes);
}

function reportWarnings(file: File, r: BlendImport) {
  for (const w of r.warnings) app.report('WARNING', `${file.name}: ${w}`);
  const extra = r.warnings.length ? ` (${r.warnings.length} warning${r.warnings.length > 1 ? 's' : ''}, see Info log)` : '';
  return extra;
}

registerFormat({
  id: 'blend',
  label: 'Blend File (.blend)',
  extensions: ['.blend'],
  description: 'Scenes saved in .blend files of versions 2.80–5.x (meshes, materials, lights, cameras, curves, armatures, modifiers, constraints, animation)',
  async open(file) {
    // the whole file is converted before the current document is touched
    const r = await load(file);
    app.setDocument(r.doc);
    app.filename = file.name.replace(/\.blend\d*$/i, '.p3d');
    const extra = reportWarnings(file, r);
    app.report('INFO', `Opened "${file.name}" (file version ${r.version}, scene "${r.sceneName}", ${r.stats.objects} objects)${extra}`);
  },
  async import(file) {
    const r = await load(file);
    const added = appendBlend(app.doc, r);
    const extra = reportWarnings(file, r);
    app.report('INFO', `Appended ${added.length} objects from "${file.name}" (file version ${r.version})${extra}`);
  },
});
