// File > Export > Data Sets as Files…: one output per data set (PNG, JPEG,
// layered PSD or a .photo project), named by number, set name or a
// variable's value, written to a ZIP archive with a progress dialog.

import type { Editor } from '../../editor';
import { escapeXML } from '../../model/assets';
import { gridDocBounds, readRGBA } from '../../model/tiles';
import { outputName, variablesOf, type DataSet } from '../../model/variables';
import type { PhotoDocument } from '../../model/document';
import { serialize } from '../../model/serialization';
import type { Renderer } from '../../renderer/renderer';
import { createOffscreenRenderer } from '../offscreen-renderer';
import { download } from '../../persistence/puter';
import { bytesBlob, documentSource, effectiveSettings, encodeOffThread, exportContext, formatBytes, loadSettings } from '../files/pipeline';
import { uniqueName, zipStore, type ZipEntry } from '../files/zip';
import { fieldValue, modal } from '../files/ui';
import { maskGridPlane } from '../files/psd-export';
import { documentWithSet, imageFolderLabel } from './apply';

type Format = 'png' | 'jpeg' | 'psd' | 'photo';
const FORMATS: [Format, string, string][] = [
  ['png', 'PNG', 'png'],
  ['jpeg', 'JPEG', 'jpg'],
  ['psd', 'PSD (layered)', 'psd'],
  ['photo', 'Photo Studio project (.photo)', 'photo'],
];
const MIME: Record<Format, string> = { png: 'image/png', jpeg: 'image/jpeg', psd: 'image/vnd.adobe.photoshop', photo: 'application/octet-stream' };

export async function exportDataSets(e: Editor) {
  const doc = e.doc;
  const v = doc.variables;
  if (!v?.sets.length) return;
  const vars = variablesOf(doc).filter((x) => x.kind !== 'visibility');
  const remembered = loadSettings();
  const esc = (s: string) => escapeXML(s);
  const pixel = vars.some((x) => x.kind === 'pixel');
  const result = await modal({
    title: 'Export Data Sets as Files',
    submit: 'Export',
    className: 'ds-export',
    body: `<p>Each data set is applied to a copy of the document and saved as its own file, collected in a ZIP archive.${pixel && !imageFolderLabel() ? ' Choose the image folder in Data Sets… first to include replacement images.' : ''}</p>
<label class="dialog-field">Data sets<select name="which"><option value="all">All (${v.sets.length})</option><option value="current">Selected: ${esc(v.sets[Math.min(v.current ?? 0, v.sets.length - 1)].name)}</option></select></label>
<label class="dialog-field">Format<select name="format">${FORMATS.map(([f, l]) => `<option value="${f}" ${f === (remembered.format === 'jpeg' ? 'jpeg' : 'png') ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
<label class="dialog-field" data-lossy>Quality<span class="export-range"><input type="range" name="quality" min="1" max="100" step="1" value="${remembered.quality}"><output>${remembered.quality}</output></span></label>
<label class="dialog-field">File names<select name="naming"><option value="number">Data set number (001, 002, …)</option><option value="name">Data set name</option>${vars.map((x) => `<option value="${esc(x.name)}">Value of ${esc(x.name)}</option>`).join('')}</select></label>
<label class="dialog-field">Prefix<input type="text" name="prefix" value="${esc(doc.name.replace(/\.[^.]+$/, ''))}_"></label>`,
    bind: (dialog) => {
      const format = dialog.querySelector<HTMLSelectElement>('[name=format]')!;
      const quality = dialog.querySelector<HTMLInputElement>('[name=quality]')!;
      const sync = () => {
        dialog.querySelector<HTMLElement>('[data-lossy]')!.hidden = format.value !== 'jpeg';
        quality.nextElementSibling!.textContent = quality.value;
      };
      format.addEventListener('change', sync);
      quality.addEventListener('input', sync);
      sync();
    },
  });
  if (!result) return;
  const f = result.form;
  const format = fieldValue(f, 'format') as Format;
  const quality = Number(fieldValue(f, 'quality')) || 85;
  const naming = fieldValue(f, 'naming');
  const prefix = fieldValue(f, 'prefix');
  const which = fieldValue(f, 'which');
  result.close();
  const indices = which === 'current' ? [Math.min(v.current ?? 0, v.sets.length - 1)] : v.sets.map((_, i) => i);
  await runExport(e, doc, indices.map((i) => [i, v.sets[i]] as const), { format, quality, naming, prefix });
}

type Options = { format: Format; quality: number; naming: string; prefix: string };

async function runExport(e: Editor, doc: PhotoDocument, sets: (readonly [number, DataSet])[], o: Options) {
  // Progress with a working Cancel button.
  const dialog = document.createElement('dialog');
  dialog.className = 'files-dialog ds-progress';
  dialog.setAttribute('aria-label', 'Exporting data sets');
  dialog.innerHTML = `<h2>Exporting Data Sets</h2><progress max="${sets.length}" value="0"></progress><p class="ds-progress-text" aria-live="polite">Preparing…</p><div class="dialog-actions"><button type="button" data-act="cancel">Cancel</button></div>`;
  document.body.append(dialog);
  let cancelled = false;
  dialog.querySelector('[data-act=cancel]')!.addEventListener('click', () => (cancelled = true));
  dialog.addEventListener('cancel', (ev) => {
    ev.preventDefault();
    cancelled = true;
  });
  dialog.showModal();
  const bar = dialog.querySelector('progress')!;
  const text = dialog.querySelector('.ds-progress-text')!;
  const used = new Set<string>();
  const entries: ZipEntry[] = [];
  const missing = new Set<string>();
  const ext = FORMATS.find((x) => x[0] === o.format)![2];
  let renderer: Renderer | undefined;
  try {
    for (const [k, [index, set]] of sets.entries()) {
      if (cancelled) break;
      text.textContent = `${set.name} (${k + 1} of ${sets.length})`;
      const r = await documentWithSet(e, doc, set);
      r.missing.forEach((m) => missing.add(m));
      const page = { ...r.doc, name: outputName(set, index, o.naming, o.prefix), selection: null, selectionMask: null };
      let bytes: Uint8Array;
      if (o.format === 'png' || o.format === 'jpeg') {
        const settings = effectiveSettings(page, { ...loadSettings(), format: o.format, quality: o.quality, transparency: o.format === 'png', sizeMode: 'percent', scale: 100, canvasWidth: 0, canvasHeight: 0 });
        const src = await documentSource(e, page);
        bytes = (await encodeOffThread(src, settings, exportContext(page))).bytes;
      } else if (o.format === 'photo') {
        bytes = new Uint8Array(await (await serialize(page, e.assets)).arrayBuffer());
      } else {
        renderer ??= await createOffscreenRenderer(e.engine);
        bytes = await psdBytes(e, page, renderer);
      }
      entries.push({ name: uniqueName(`${page.name}.${ext}`, used), data: bytes });
      bar.value = k + 1;
    }
  } finally {
    renderer?.dispose();
    dialog.close();
    dialog.remove();
  }
  if (cancelled) {
    e.message('Export cancelled.');
    return;
  }
  if (entries.length === 1) download(bytesBlob(entries[0].data, MIME[o.format]), entries[0].name);
  else {
    const zip = zipStore(entries);
    download(bytesBlob(zip, 'application/zip'), `${doc.name.replace(/\.[^.]+$/, '')}-data-sets.zip`);
  }
  const size = entries.reduce((n, x) => n + x.data.length, 0);
  e.message(`Exported ${entries.length} data set${entries.length === 1 ? '' : 's'} (${formatBytes(size)})${missing.size ? `; missing images: ${[...missing].join(', ')}` : ''}.`);
}

// A layered PSD of a document (as File > Export > PSD writes it).
async function psdBytes(e: Editor, doc: PhotoDocument, renderer: Renderer): Promise<Uint8Array> {
  const { savePsd } = await import('../../model/psd');
  const depth = doc.bitsPerChannel ?? 8;
  const snapshot = structuredClone({ ...doc, psdOriginal: undefined });
  const blob = await savePsd(
    snapshot,
    async (s) => {
      await renderer.render(s, e.assets);
      return renderer.rawPixels();
    },
    async (l) => {
      if (l.kind !== 'pixel' || !l.pixels) return renderer.rawSourcePixels(l, e.assets);
      const b = gridDocBounds(l.pixels)!;
      const px = readRGBA(e.assets.tiles, l.pixels, b).data;
      const data = depth === 16 ? Uint16Array.from(px, (x) => x * 257) : depth === 32 ? Float32Array.from(px, (x) => x / 255) : new Uint8Array(px.buffer, px.byteOffset, px.length);
      return { width: b.width, height: b.height, data };
    },
    (id) => e.assets.blob(id),
    (l) => maskGridPlane(e, l),
  );
  return new Uint8Array(await blob.arrayBuffer());
}
