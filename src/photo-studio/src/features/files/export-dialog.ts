// File → Export → Export As: format, quality, size, canvas, metadata and color
// options with a live preview of the encoded result and its file size.
import type { PhotoDocument } from '../../model/document';
import type { Editor } from '../../editor';
import { download } from '../../persistence/puter';
import { canEncodeAvif, exportFileName, formatInfo, outputSize, type ExportFormat, type ExportSettings, type SourceImage } from './encode';
import { rgba16To8 } from './png';
import { bytesBlob, documentSource, encodeDocument, formatBytes, isDeep, loadSettings, mustConvert, saveSettings } from './pipeline';
import { cloudSaveAs } from './cloud';
import { emitAppEvent } from '../../app/app-events';

const formats: ExportFormat[] = ['png', 'jpeg', 'webp', 'avif', 'gif', 'tiff', 'bmp', 'tga', 'ico', 'svg'];
// Formats an <img> cannot show: preview their prepared pixels instead.
const undisplayable = new Set<ExportFormat>(['tiff', 'tga']);

function sectionHtml(title: string, body: string) {
  return `<section class="export-section"><h3>${title}</h3>${body}</section>`;
}
const row = (label: string, control: string, show = '') => `<label class="export-row" ${show ? `data-show="${show}"` : ''}><span>${label}</span>${control}</label>`;
const check = (name: string, label: string, show = '') => `<label class="export-check" ${show ? `data-show="${show}"` : ''}><input type="checkbox" name="${name}"><span>${label}</span></label>`;

// `subject` exports a derived document (for example selected layers only).
export async function exportAsDialog(e: Editor, initial: Partial<ExportSettings> = {}, subject: PhotoDocument = e.doc) {
  const doc = subject;
  const s: ExportSettings = { ...loadSettings(), ...initial };
  const avif = await canEncodeAvif();
  if (s.format === 'avif' && !avif) s.format = 'png';
  const deep = isDeep(doc);
  if (!deep) s.depth = 8;
  const forced = mustConvert(doc);
  const hasProfile = !!doc.iccProfile && !doc.iccUntaggedProfile;
  const dialog = document.createElement('dialog');
  dialog.className = 'export-dialog';
  dialog.setAttribute('aria-label', 'Export As');
  const formatOptions = formats.filter((f) => f !== 'avif' || avif).map((f) => `<option value="${f}">${formatInfo[f].label}</option>`).join('');
  dialog.innerHTML = `<form method="dialog">
  <h2>Export As</h2>
  <div class="export-body">
    <div class="export-preview">
      <div class="export-stage" title="Click to switch between fit and actual size"><img alt="Export preview" hidden><canvas hidden></canvas><span class="export-busy">Preparing preview…</span></div>
      <div class="export-preview-bar"><span class="export-dims"></span><span class="export-size" aria-live="polite"></span></div>
    </div>
    <div class="export-settings">
      ${sectionHtml('File Settings', `
        ${row('Format', `<select name="format" autofocus>${formatOptions}</select>`)}
        ${row('Quality', `<span class="export-range"><input type="range" name="quality" min="1" max="100" step="1"><output data-for="quality"></output></span>`, 'lossy')}
        ${check('transparency', 'Transparency', 'alpha')}
        ${row('Compression', `<span class="export-range"><input type="range" name="pngLevel" min="0" max="9" step="1"><output data-for="pngLevel"></output></span>`, 'png tiff-deflate')}
        ${row('TIFF compression', `<select name="tiffCompression"><option value="none">None</option><option value="lzw">LZW</option><option value="deflate">ZIP (Deflate)</option></select>`, 'tiff')}
        ${deep ? row('Bit depth', `<select name="depth"><option value="8">8 bits/channel</option><option value="16">16 bits/channel</option></select>`, 'deep') : ''}
        ${row('Colors', `<input type="number" name="gifColors" min="2" max="256" step="1">`, 'gif')}
        ${check('gifDither', 'Dither', 'gif')}
        ${row('Matte', `<input type="color" name="matte">`, 'matte')}
      `)}
      ${sectionHtml('Image Size', `
        <div class="export-size-grid">
          ${row('Width', `<input type="number" name="outWidth" min="1" max="8192" step="1">`)}
          ${row('Height', `<input type="number" name="outHeight" min="1" max="8192" step="1">`)}
          ${row('Scale %', `<input type="number" name="scale" min="1" max="1000" step="any">`)}
        </div>
        ${row('Resample', `<select name="resample"><option value="bicubic">Bicubic</option><option value="lanczos">Lanczos (sharper)</option><option value="bilinear">Bilinear</option><option value="nearest">Nearest neighbor (hard edges)</option></select>`)}
      `)}
      <div data-show="raster">${sectionHtml('Canvas Size', `
        <div class="export-size-grid">
          ${row('Width', `<input type="number" name="canvasWidth" min="1" max="8192" step="1">`)}
          ${row('Height', `<input type="number" name="canvasHeight" min="1" max="8192" step="1">`)}
          <button type="button" class="export-reset-canvas">Reset</button>
        </div>
      `)}</div>
      <div data-show="text">${sectionHtml('Metadata', row('Include', `<select name="metadata"><option value="none">None</option><option value="copyright">Copyright and contact info</option><option value="all">All file info</option></select>`))}</div>
      <div data-show="prov">${sectionHtml('Provenance', `
        ${row('Attach', `<select name="provenance"><option value="none">Nothing</option><option value="record">How it was made (record)</option><option value="signed">Record and signed manifest</option></select>`)}
        <p class="export-note" data-show="prov-unsigned">This format gets the record only; signed manifests go into PNG and JPEG.</p>
      `)}</div>
      <div data-show="color">${sectionHtml('Color Space', `
        ${check('convertSrgb', forced ? 'Convert to sRGB (required for this document)' : 'Convert to sRGB')}
        ${check('embedIcc', 'Embed color profile', 'icc')}
        <p class="export-note">${hasProfile ? 'The document has an embedded ICC profile.' : forced ? 'This 32-bit document uses linear sRGB.' : 'The document uses sRGB.'}</p>
      `)}</div>
    </div>
  </div>
  <div class="dialog-actions export-actions">
    <button type="button" data-act="cancel">Cancel</button>
    <button type="button" data-act="puter">Save to Puter…</button>
    <button type="submit" class="primary" data-act="export">Export</button>
  </div>
</form>`;
  e.root.append(dialog);
  const form = dialog.querySelector('form')!;
  const field = <T extends HTMLInputElement | HTMLSelectElement>(name: string) => form.elements.namedItem(name) as T | null;
  const img = dialog.querySelector('img')!,
    canvas = dialog.querySelector('canvas')!,
    busy = dialog.querySelector<HTMLElement>('.export-busy')!;
  const dims = dialog.querySelector<HTMLElement>('.export-dims')!,
    size = dialog.querySelector<HTMLElement>('.export-size')!;
  const [baseW, baseH] = [doc.width, doc.height];
  // Provenance to attach (Preferences → Export sets the default).
  let provenance: 'none' | 'record' | 'signed' = e.preferences.provenanceAttach;

  const write = () => {
    field<HTMLSelectElement>('format')!.value = s.format;
    field<HTMLInputElement>('quality')!.value = String(s.quality);
    field<HTMLInputElement>('transparency')!.checked = s.transparency;
    field<HTMLInputElement>('pngLevel')!.value = String(s.pngLevel);
    field<HTMLSelectElement>('tiffCompression')!.value = s.tiffCompression;
    if (deep) field<HTMLSelectElement>('depth')!.value = String(s.depth);
    field<HTMLInputElement>('gifColors')!.value = String(s.gifColors);
    field<HTMLInputElement>('gifDither')!.checked = s.gifDither;
    field<HTMLInputElement>('matte')!.value = /^#[0-9a-f]{6}$/i.test(s.matte) ? s.matte : '#ffffff';
    field<HTMLSelectElement>('resample')!.value = s.resample;
    field<HTMLSelectElement>('metadata')!.value = s.metadata;
    field<HTMLInputElement>('convertSrgb')!.checked = forced || s.convertSrgb;
    field<HTMLInputElement>('convertSrgb')!.disabled = forced || !hasProfile;
    field<HTMLInputElement>('embedIcc')!.checked = s.embedIcc;
    field<HTMLSelectElement>('provenance')!.value = provenance;
    syncSize();
  };
  const syncSize = () => {
    const [w, h] = outputSize(baseW, baseH, s);
    const active = document.activeElement;
    if (active !== field('outWidth')) field<HTMLInputElement>('outWidth')!.value = String(w);
    if (active !== field('outHeight')) field<HTMLInputElement>('outHeight')!.value = String(h);
    if (active !== field('scale')) field<HTMLInputElement>('scale')!.value = String(Math.round((w / baseW) * 10000) / 100);
    if (active !== field('canvasWidth')) field<HTMLInputElement>('canvasWidth')!.value = String(s.canvasWidth || w);
    if (active !== field('canvasHeight')) field<HTMLInputElement>('canvasHeight')!.value = String(s.canvasHeight || h);
  };
  const visibility = () => {
    const info = formatInfo[s.format];
    const tags = new Set<string>([s.format]);
    if (info.lossy) tags.add('lossy');
    if (info.alpha) tags.add('alpha');
    if (info.deep && deep) tags.add('deep');
    if (!info.alpha || !s.transparency) tags.add('matte');
    if (s.format === 'tiff' && s.tiffCompression === 'deflate') tags.add('tiff-deflate');
    if (s.format !== 'svg') tags.add('raster');
    if (info.text) tags.add('text');
    if (s.format !== 'svg' && s.format !== 'ico') tags.add('color');
    if (info.icc) tags.add('icc');
    if (['png', 'jpeg', 'webp', 'tiff'].includes(s.format)) tags.add('prov');
    if (provenance === 'signed' && (s.format === 'webp' || s.format === 'tiff')) tags.add('prov-unsigned');
    for (const el of dialog.querySelectorAll<HTMLElement>('[data-show]')) el.hidden = !el.dataset.show!.split(' ').some((t) => tags.has(t));
    for (const o of dialog.querySelectorAll<HTMLOutputElement>('output[data-for]')) o.value = field<HTMLInputElement>(o.dataset.for!)!.value;
  };
  const read = (changed?: string) => {
    s.format = field<HTMLSelectElement>('format')!.value as ExportFormat;
    s.quality = Number(field<HTMLInputElement>('quality')!.value);
    s.transparency = field<HTMLInputElement>('transparency')!.checked;
    s.pngLevel = Number(field<HTMLInputElement>('pngLevel')!.value);
    s.tiffCompression = field<HTMLSelectElement>('tiffCompression')!.value as ExportSettings['tiffCompression'];
    if (deep) s.depth = Number(field<HTMLSelectElement>('depth')!.value) as 8 | 16;
    s.gifColors = Math.max(2, Math.min(256, Math.round(Number(field<HTMLInputElement>('gifColors')!.value) || 256)));
    s.gifDither = field<HTMLInputElement>('gifDither')!.checked;
    s.matte = field<HTMLInputElement>('matte')!.value;
    s.resample = field<HTMLSelectElement>('resample')!.value as ExportSettings['resample'];
    s.metadata = field<HTMLSelectElement>('metadata')!.value as ExportSettings['metadata'];
    if (!forced && hasProfile) s.convertSrgb = field<HTMLInputElement>('convertSrgb')!.checked;
    s.embedIcc = field<HTMLInputElement>('embedIcc')!.checked;
    provenance = field<HTMLSelectElement>('provenance')!.value as typeof provenance;
    const num = (name: string) => Number(field<HTMLInputElement>(name)!.value);
    const prev = outputSize(baseW, baseH, s);
    if (changed === 'outWidth' && num('outWidth') >= 1) Object.assign(s, { sizeMode: 'width', width: Math.min(8192, Math.round(num('outWidth'))) });
    if (changed === 'outHeight' && num('outHeight') >= 1) Object.assign(s, { sizeMode: 'height', height: Math.min(8192, Math.round(num('outHeight'))) });
    if (changed === 'scale' && num('scale') > 0) Object.assign(s, { sizeMode: 'percent', scale: num('scale') });
    if (changed === 'canvasWidth' && num('canvasWidth') >= 1) s.canvasWidth = Math.min(8192, Math.round(num('canvasWidth')));
    if (changed === 'canvasHeight' && num('canvasHeight') >= 1) s.canvasHeight = Math.min(8192, Math.round(num('canvasHeight')));
    // A canvas that tracked the image size keeps tracking it.
    const next = outputSize(baseW, baseH, s);
    if (s.canvasWidth === prev[0] && s.canvasHeight === prev[1] && (next[0] !== prev[0] || next[1] !== prev[1])) s.canvasWidth = s.canvasHeight = 0;
    syncSize();
    visibility();
    schedule();
  };

  let source: SourceImage | undefined;
  let generation = 0,
    timer = 0,
    url = '';
  let last: { key: string; bytes: Uint8Array; mime: string } | undefined;
  const key = () => JSON.stringify(s);
  const schedule = () => {
    clearTimeout(timer);
    timer = window.setTimeout(() => void refresh(), 220);
  };
  const encode = async () => {
    const k = key();
    if (last?.key === k) return last;
    source ??= await documentSource(e, doc);
    const out = await encodeDocument(e, { ...s }, doc, source);
    last = { key: k, bytes: out.bytes, mime: out.mime };
    return { ...last, prepared: out.prepared, width: out.width, height: out.height };
  };
  const refresh = async () => {
    const g = ++generation;
    busy.hidden = false;
    busy.textContent = 'Updating preview…';
    try {
      const out = await encode();
      if (g !== generation) return;
      const [w, h] = outputSize(baseW, baseH, s);
      const cw = s.format === 'svg' ? w : s.canvasWidth || w,
        ch = s.format === 'svg' ? h : s.canvasHeight || h;
      dims.textContent = s.format === 'ico' ? `${Math.min(256, Math.max(cw, ch))} px icon` : `${cw} × ${ch} px`;
      size.textContent = `${formatInfo[s.format].label} · ${formatBytes(out.bytes.length)}`;
      if (url) URL.revokeObjectURL(url);
      url = '';
      if (undisplayable.has(s.format) && 'prepared' in out && out.prepared) {
        const p = out.prepared;
        canvas.width = p.width;
        canvas.height = p.height;
        const data = p.data instanceof Uint16Array ? rgba16To8(p.data) : p.data;
        canvas.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(data), p.width, p.height), 0, 0);
        canvas.hidden = false;
        img.hidden = true;
      } else {
        url = URL.createObjectURL(bytesBlob(out.bytes, out.mime));
        img.src = url;
        img.hidden = false;
        canvas.hidden = true;
      }
      busy.hidden = true;
    } catch (error) {
      if (g !== generation) return;
      busy.hidden = false;
      busy.textContent = error instanceof Error ? error.message : String(error);
      size.textContent = '';
    }
  };

  form.addEventListener('input', (ev) => read((ev.target as HTMLInputElement).name));
  form.addEventListener('change', (ev) => read((ev.target as HTMLInputElement).name));
  dialog.querySelector('.export-reset-canvas')!.addEventListener('click', () => {
    s.canvasWidth = s.canvasHeight = 0;
    syncSize();
    schedule();
  });
  dialog.querySelector('.export-stage')!.addEventListener('click', (ev) => (ev.currentTarget as HTMLElement).classList.toggle('actual'));

  return new Promise<void>((resolve) => {
    const close = () => {
      clearTimeout(timer);
      generation++;
      dialog.close();
      dialog.remove();
      if (url) URL.revokeObjectURL(url);
      resolve();
    };
    dialog.addEventListener('cancel', (ev) => {
      ev.preventDefault();
      close();
    });
    dialog.querySelector('[data-act="cancel"]')!.addEventListener('click', close);
    const finish = async (puter: boolean) => {
      const buttons = dialog.querySelectorAll<HTMLButtonElement>('.export-actions button');
      buttons.forEach((b) => (b.disabled = true));
      busy.hidden = false;
      busy.textContent = 'Encoding…';
      try {
        const out = await encode();
        saveSettings(s);
        const name = exportFileName(doc.info?.title?.trim() || doc.name, s.format);
        // The export is noted in the document's provenance record either way.
        const { withProvenance } = await import('../provenance/export');
        const [w, h] = outputSize(baseW, baseH, s);
        const bytes = await withProvenance(e.session, out.bytes, name, provenance, { prompts: e.preferences.provenancePrompts, width: s.canvasWidth || w, height: s.canvasHeight || h });
        const blob = bytesBlob(bytes, out.mime);
        close();
        if (puter) {
          // The picker never settles when dismissed, so it is not awaited.
          void cloudSaveAs(blob, name)
            .then((item) => {
              e.message(`Saved ${item.name} to Puter`);
              void emitAppEvent('export', e.session);
            })
            .catch((error) => e.message(String(error instanceof Error ? error.message : error)));
        } else {
          download(blob, name);
          e.message(`Exported ${name} (${formatBytes(bytes.length)})${provenance !== 'none' && bytes !== out.bytes ? ' with provenance' : ''}`);
          void emitAppEvent('export', e.session);
        }
      } catch (error) {
        buttons.forEach((b) => (b.disabled = false));
        busy.textContent = error instanceof Error ? error.message : String(error);
      }
    };
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      void finish(false);
    });
    dialog.querySelector('[data-act="puter"]')!.addEventListener('click', () => void finish(true));
    write();
    visibility();
    dialog.showModal();
    void refresh();
  });
}
