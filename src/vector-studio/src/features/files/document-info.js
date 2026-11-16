/**
 * Document Info: a read-only summary of the active document (file,
 * artboards, objects by kind, fonts, images, swatches, size on disk).
 */
import { h } from '../../lib/dom.js';
import { formatLength, UNITS } from '../../lib/units.js';
import { openDialog } from '../../ui/dialogs/dialog.js';
import { serializeDocument, normalizeBleed } from './format.js';
import { formatBytes } from './naming.js';
import { documentStats } from './document-stats.js';

export { documentStats };

export async function documentInfoDialog(app, editor = app.editor) {
  if (!editor) return;
  const doc = editor.doc;
  const root = doc.root;
  const units = UNITS[root.units] ? root.units : 'pt';
  const s = documentStats(doc);
  const L = (v) => formatLength(v, units);
  const sizeEl = h('dd', 'Calculating...');
  const f = editor.file;
  const where = !f ? 'Not saved yet' : f.kind === 'puter' ? f.path : f.kind === 'local' ? 'This computer' : f.kind === 'download' ? 'Downloaded to this computer' : 'Imported, not saved yet';
  const bleed = normalizeBleed(root.bleed ?? 0);
  const dl = (rows) => h('dl.files-info-list', rows.flatMap(([k, v]) => [h('dt', k), v instanceof Node ? v : h('dd', String(v))]));
  const sec = (title, ...content) => h('section.files-info-sec', h('h3.form-heading', title), ...content);
  const body = h(
    'div.files-info',
    sec('Document', dl([
      ['Name', editor.name],
      ['Location', where],
      ['Units', UNITS[units].label],
      ['Color Mode', root.colorMode === 'RGB' || !root.colorMode ? 'RGB Color' : root.colorMode],
      ['Raster Effects', `${root.rasterResolution || 72} ppi`],
      ['Bleed', `${L(bleed.top)}, ${L(bleed.bottom)}, ${L(bleed.left)}, ${L(bleed.right)}`],
      ['Unsaved Changes', doc.dirty ? 'Yes' : 'No'],
      ['File Size', sizeEl],
    ])),
    sec('Artboards', h('ol.files-info-boards', root.artboards.map((a) => h('li', `${a.name || 'Artboard'}: ${L(a.w)} x ${L(a.h)}`)))),
    sec('Objects', dl([
      ['Layers', s.counts.layer],
      ['Paths', s.counts.path],
      ['Compound Paths', s.counts.compound],
      ['Groups', s.counts.group],
      ['Clip Groups', s.counts.clip],
      ['Type Objects', s.counts.text],
      ['Images', s.counts.image],
      ['Anchor Points', s.anchors],
      ['Hidden', s.counts.hidden],
      ['Locked', s.counts.locked],
    ])),
    sec('Fonts', s.fonts.length ? h('ul.files-info-fonts', s.fonts.map((x) => h('li', x))) : h('p.muted', 'None')),
    sec('Embedded Images and Swatches', dl([
      ['Embedded Images', `${s.images}${s.images ? ` (${formatBytes(s.imageBytes)})` : ''}`],
      ['Swatches', s.swatches],
    ])),
  );
  // The size Save would write now: the .ai file (pages and document), or the document alone without a file service.
  const write = app.files?.service?.write ? app.files.service.write(doc).then((file) => file.bytes) : serializeDocument(doc);
  write
    .then((bytes) => (sizeEl.textContent = formatBytes(bytes.length)))
    .catch(() => (sizeEl.textContent = 'Unknown'));
  await openDialog({ title: 'Document Info', className: 'files-info-dialog', body, buttons: [{ label: 'Close', value: true, primary: true }] });
}
