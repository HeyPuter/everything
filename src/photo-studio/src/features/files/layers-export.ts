// Export Layers to Files (zip or Puter folder), animated GIF from layers and
// layered SVG.
import type { Editor } from '../../editor';
import type { Layer } from '../../model/document';
import { download, preferredFileName } from '../../persistence/puter';
import { formatInfo, prepareExport, type ExportFormat, type SourceImage } from './encode';
import { encodeGifOffThread, encodeOffThread, bytesBlob, documentSource, effectiveSettings, exportContext, formatBytes, layerSource, loadSettings } from './pipeline';
import { exportSvg } from './svg-export';
import { uniqueName, zipStore, type ZipEntry } from './zip';
import { modal, fieldChecked, fieldValue } from './ui';
import { cloudWrite, joinPath, pickCloudFolder } from './cloud';
import { rgba16To8 } from './png';

const layerFormats: ExportFormat[] = ['png', 'jpeg', 'webp', 'tiff', 'bmp', 'tga', 'gif'];

/** Crop to pixels with alpha; undefined when the layer is empty. */
export function trimTransparent(src: SourceImage): SourceImage | undefined {
  const { width: w, height: h, data } = src;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    const row = y * w * 4;
    for (let x = 0; x < w; x++)
      if (data[row + x * 4 + 3]) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        y1 = y;
      }
  }
  if (x1 < 0) return;
  const cw = x1 - x0 + 1,
    ch = y1 - y0 + 1;
  const Ctor = data.constructor as { new (n: number): typeof data };
  const out = new Ctor(cw * ch * 4);
  for (let y = 0; y < ch; y++) out.set(data.subarray(((y + y0) * w + x0) * 4, ((y + y0) * w + x1 + 1) * 4), y * cw * 4);
  return { width: cw, height: ch, data: out };
}

export async function exportLayers(e: Editor) {
  const doc = e.doc;
  const remembered = loadSettings();
  const start = layerFormats.includes(remembered.format) ? remembered.format : 'png';
  const result = await modal({
    title: 'Export Layers to Files',
    submit: 'Export',
    body: `<p>Each top-level layer (groups as one image) is saved as its own file, using the quality, metadata and color settings from Export As.</p>
      <label class="dialog-field">Format<select name="format">${layerFormats.map((f) => `<option value="${f}" ${f === start ? 'selected' : ''}>${formatInfo[f].label}</option>`).join('')}</select></label>
      <label class="dialog-field">File name prefix<input name="prefix" type="text" value="${doc.name.replace(/"/g, '&quot;')}_"></label>
      <label class="dialog-field checkbox-field">Visible layers only<input name="visible" type="checkbox" checked></label>
      <label class="dialog-field checkbox-field">Trim transparent pixels<input name="trim" type="checkbox"></label>
      <label class="dialog-field">Destination<select name="dest"><option value="zip">Download as ZIP archive</option><option value="puter">Save to a Puter folder…</option></select></label>`,
  });
  if (!result) return;
  const format = fieldValue(result.form, 'format') as ExportFormat;
  const prefix = fieldValue(result.form, 'prefix');
  const visibleOnly = fieldChecked(result.form, 'visible');
  const trim = fieldChecked(result.form, 'trim');
  const dest = fieldValue(result.form, 'dest');
  result.close();
  const layers = doc.layers.filter((l) => !visibleOnly || l.visible);
  if (!layers.length) throw new Error('There are no layers to export.');
  const settings = effectiveSettings(doc, { ...remembered, format, sizeMode: 'percent', scale: 100, canvasWidth: 0, canvasHeight: 0 });
  const ctx = exportContext(doc);
  const used = new Set<string>();
  const entries: ZipEntry[] = [];
  let index = 0;
  // Top-down numbering matches the Layers panel order.
  for (const l of [...layers].reverse()) {
    index++;
    e.message(`Exporting layer ${index} of ${layers.length}…`);
    let src: SourceImage | undefined = await layerSource(e, l);
    if (trim) src = trimTransparent(src);
    if (!src) continue;
    const { bytes } = await encodeOffThread(src, settings, ctx);
    const name = uniqueName(`${prefix}${String(index).padStart(4, '0')}_${l.name}.${formatInfo[format].ext}`, used);
    entries.push({ name, data: bytes });
  }
  if (!entries.length) throw new Error('All selected layers are empty.');
  if (dest === 'puter') {
    saveToCloudFolder(e, entries.map((x) => ({ name: x.name, blob: bytesBlob(x.data, formatInfo[format].mime) })));
    return;
  }
  const zip = zipStore(entries);
  download(bytesBlob(zip, 'application/zip'), `${doc.name}-layers.zip`);
  e.message(`Exported ${entries.length} layers (${formatBytes(zip.length)})`);
}

/** Animated GIF where each top-level layer is a frame (bottom layer first),
 * the inverse of opening an animated GIF as layers. */
export async function exportGif(e: Editor) {
  const doc = e.doc;
  const remembered = loadSettings();
  const frames: Layer[] = doc.layers.filter((l) => l.visible);
  const result = await modal({
    title: 'Export GIF',
    submit: 'Export',
    body: `<label class="dialog-field">Content<select name="mode"><option value="flat">Flattened image</option><option value="frames" ${frames.length > 1 ? 'selected' : ''}>Each visible layer as an animation frame</option></select></label>
      <label class="dialog-field">Frame delay (ms)<input name="delay" type="number" min="10" max="60000" step="10" value="100"></label>
      <label class="dialog-field">Looping<select name="loop"><option value="0">Forever</option><option value="-1">Once</option><option value="2">3 times</option></select></label>
      <label class="dialog-field">Colors<input name="colors" type="number" min="2" max="256" step="1" value="${remembered.gifColors}"></label>
      <label class="dialog-field checkbox-field">Dither<input name="dither" type="checkbox" ${remembered.gifDither ? 'checked' : ''}></label>
      <label class="dialog-field checkbox-field">Transparency<input name="transparency" type="checkbox" ${remembered.transparency ? 'checked' : ''}></label>`,
  });
  if (!result) return;
  const f = result.form;
  const mode = fieldValue(f, 'mode');
  const delay = Math.max(10, Number(fieldValue(f, 'delay')) || 100);
  const loop = Number(fieldValue(f, 'loop'));
  const colors = Math.max(2, Math.min(256, Math.round(Number(fieldValue(f, 'colors')) || 256)));
  const dither = fieldChecked(f, 'dither');
  const transparency = fieldChecked(f, 'transparency');
  result.close();
  const settings = effectiveSettings(doc, { ...remembered, format: 'gif', transparency, sizeMode: 'percent', scale: 100, canvasWidth: 0, canvasHeight: 0 });
  const ctx = exportContext(doc);
  // Renders run one at a time; the compositor is a single shared resource.
  const sources: SourceImage[] = [];
  if (mode === 'frames') for (const l of frames) sources.push(await layerSource(e, l));
  else sources.push(await documentSource(e, doc));
  const images = sources.map((src) => {
    const p = prepareExport(src, settings, ctx);
    return { rgba: { width: p.width, height: p.height, data: p.data instanceof Uint16Array ? rgba16To8(p.data) : p.data }, delayMs: delay };
  });
  e.message(`Encoding ${images.length} GIF frame${images.length > 1 ? 's' : ''}…`);
  const bytes = await encodeGifOffThread(images, { colors, dither, loop, palette: images.length > 1 ? 'local' : 'global' });
  download(bytesBlob(bytes, 'image/gif'), `${doc.name}.gif`);
  e.message(`GIF exported: ${images.length} frame${images.length > 1 ? 's' : ''}, ${formatBytes(bytes.length)}`);
}

export async function exportSvgFile(e: Editor) {
  const text = await exportSvg(e, e.doc, { sizeMode: 'percent', scale: 100, width: 0, height: 0 });
  download(new Blob([text], { type: 'image/svg+xml' }), `${e.doc.name}.svg`);
  e.message(`SVG exported (${formatBytes(text.length)})`);
}

/** Ask for a Puter folder and write the files there (names deduplicated).
 * The picker never settles when dismissed, so the editor is not held busy. */
export function saveToCloudFolder(e: Editor, files: { name: string; blob: Blob }[]) {
  e.release();
  void pickCloudFolder()
    .then((folder) =>
      e.run(async () => {
        let n = 0;
        for (const f of files) {
          e.message(`Saving ${++n} of ${files.length} to ${folder.path}…`);
          await cloudWrite(joinPath(folder.path, preferredFileName(f.name)), f.blob, { dedupeName: true });
        }
        e.message(`Saved ${files.length} files to ${folder.path}`);
      }),
    )
    .catch((error) => e.message(error instanceof Error ? error.message : String(error)));
}
