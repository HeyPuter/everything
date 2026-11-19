// File → Export → Export for Web: optimized images per slice with Original,
// Optimized, 2-Up and 4-Up previews, encoded sizes and download times, saved
// as a ZIP with an optional HTML table that reassembles the slices.
import type { Editor } from '../../editor';
import { download } from '../../persistence/puter';
import { escapeXML } from '../../model/assets';
import type { Rect } from '../../model/document';
import { partitionSlices, pieceNames, sliceTableHtml, type Slice, type SliceFormat, type SlicePiece } from '../../model/slices';
import { formatInfo, type ExportContext, type ExportSettings, type SourceImage } from '../files/encode';
import { bytesBlob, documentSource, effectiveSettings, encodeOffThread, exportContext, formatBytes, loadSettings, prepareOffThread } from '../files/pipeline';
import { uniqueName, zipStore, type ZipEntry } from '../files/zip';

export type WebSettings = { format: SliceFormat; quality: number; colors: number; dither: boolean; transparency: boolean; matte: string };
export const defaultWebSettings: WebSettings = { format: 'png', quality: 80, colors: 256, dither: true, transparency: true, matte: '#ffffff' };
const formatNames: Record<SliceFormat, string> = { png: 'PNG', jpeg: 'JPEG', webp: 'WebP', gif: 'GIF' };
const lossy = (f: SliceFormat) => f === 'jpeg' || f === 'webp';

/** Short description of settings, e.g. "JPEG 80" or "GIF 128 colors". */
export function describeSettings(s: WebSettings) {
  return s.format === 'gif' ? `GIF ${s.colors} colors` : lossy(s.format) ? `${formatNames[s.format]} ${s.quality}` : 'PNG';
}
/** Two alternatives to compare against the current settings in 4-Up: the same
 * format at a lower quality (or fewer colors), and a different format. */
export function alternates(s: WebSettings): [WebSettings, WebSettings] {
  const lower: WebSettings =
    s.format === 'png'
      ? { ...s, format: 'gif', colors: 256 }
      : s.format === 'gif'
        ? { ...s, colors: Math.max(2, Math.round(s.colors / 4)) }
        : { ...s, quality: Math.max(1, Math.round(s.quality * 0.6)) };
  const other: WebSettings =
    s.format === 'webp' ? { ...s, format: 'jpeg', quality: s.quality } : s.format === 'jpeg' ? { ...s, format: 'webp' } : { ...s, format: 'webp', quality: 80 };
  return [lower, other];
}
/** Seconds to download `bytes` at `mbps` megabits per second. */
export const downloadSeconds = (bytes: number, mbps = 8) => (bytes * 8) / (mbps * 1e6);
export function formatSeconds(s: number) {
  return s < 0.1 ? '< 0.1 s' : s < 10 ? `${s.toFixed(1)} s` : `${Math.round(s)} s`;
}
/** Piece rectangles scaled to the output, on shared whole-pixel cut lines. */
export function scalePieces(pieces: SlicePiece[], k: number): SlicePiece[] {
  if (k === 1) return pieces;
  const r = (v: number) => Math.round(v * k);
  return pieces.map((p) => {
    const x = r(p.rect.x),
      y = r(p.rect.y);
    return { ...p, rect: { x, y, width: Math.max(1, r(p.rect.x + p.rect.width) - x), height: Math.max(1, r(p.rect.y + p.rect.height) - y) } };
  });
}
/** Settings key of a piece: its slice, or one shared key for automatic slices. */
const keyOf = (p: SlicePiece) => p.slice?.id ?? 'auto';
function fromSlice(s: Slice | undefined, base: WebSettings): WebSettings {
  if (!s?.format) return { ...base };
  const out = { ...base, format: s.format };
  if (s.quality !== undefined) {
    if (s.format === 'gif') out.colors = s.quality;
    else if (lossy(s.format)) out.quality = Math.min(100, s.quality);
  }
  return out;
}
function exportSettings(s: WebSettings): ExportSettings {
  return {
    ...loadSettings(),
    format: s.format,
    quality: s.quality,
    transparency: s.transparency,
    matte: s.matte,
    gifColors: s.colors,
    gifDither: s.dither,
    depth: 8,
    sizeMode: 'percent',
    scale: 100,
    canvasWidth: 0,
    canvasHeight: 0,
    // Pixels are already sRGB; the web output carries no profile or text.
    convertSrgb: false,
    embedIcc: true,
    metadata: 'none',
  };
}
function crop(src: SourceImage, r: Rect): SourceImage {
  const out = new Uint8ClampedArray(r.width * r.height * 4);
  const data = src.data as Uint8ClampedArray;
  for (let y = 0; y < r.height; y++) out.set(data.subarray(((r.y + y) * src.width + r.x) * 4, ((r.y + y) * src.width + r.x + r.width) * 4), y * r.width * 4);
  return { width: r.width, height: r.height, data: out };
}

const KEY = 'photo-studio-web-export';
type Remembered = { view: View; html: boolean; scale: number; auto: WebSettings };
type View = 'original' | 'optimized' | '2up' | '4up';
function remembered(): Remembered {
  const base: Remembered = { view: '2up', html: true, scale: 100, auto: { ...defaultWebSettings } };
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    if (v && typeof v === 'object') {
      if (['original', 'optimized', '2up', '4up'].includes(v.view)) base.view = v.view;
      if (typeof v.html === 'boolean') base.html = v.html;
      if (Number.isFinite(v.scale) && v.scale >= 1 && v.scale <= 400) base.scale = v.scale;
      if (v.auto && ['png', 'jpeg', 'webp', 'gif'].includes(v.auto.format)) base.auto = { ...defaultWebSettings, ...v.auto };
    }
  } catch {
    /* Optional. */
  }
  return base;
}
function remember(r: Remembered) {
  try {
    localStorage.setItem(KEY, JSON.stringify(r));
  } catch {
    /* Optional. */
  }
}

type Pane = { settings: Map<string, WebSettings>; encoded: Map<string, { bytes: Uint8Array; url: string }>; generation: number };

export async function exportForWeb(e: Editor) {
  const doc = e.doc;
  const memory = remembered();
  const allPieces = partitionSlices(doc);
  const keys = [...new Set(allPieces.map(keyOf))];
  const sliceById = new Map((doc.slices ?? []).map((s) => [s.id, s]));
  const first = new Map(keys.map((k) => [k, k === 'auto' ? { ...memory.auto } : fromSlice(sliceById.get(k), memory.auto)]));
  const vary = (i: 0 | 1) => new Map([...first].map(([k, s]) => [k, alternates(s)[i]]));
  const panes: Pane[] = [first, vary(0), vary(1)].map((settings) => ({ settings, encoded: new Map(), generation: 0 }));
  let active = 0;
  let view: View = memory.view;
  let scale = memory.scale;
  let scope = new Set<string>(); // empty: all slices
  let actual = false;
  const multi = allPieces.length > 1;

  const dialog = document.createElement('dialog');
  dialog.className = 'export-dialog web-export-dialog';
  dialog.setAttribute('aria-label', 'Export for Web');
  const tabs: [View, string][] = [['original', 'Original'], ['optimized', 'Optimized'], ['2up', '2-Up'], ['4up', '4-Up']];
  dialog.innerHTML = `<form method="dialog">
  <div class="web-head"><h2>Export for Web</h2><div class="web-tabs segmented" role="tablist" aria-label="Preview">${tabs.map(([v, l]) => `<button type="button" role="tab" data-view="${v}" aria-selected="false">${l}</button>`).join('')}</div><button type="button" class="web-zoom" title="Switch between fit and actual size">Fit</button></div>
  <div class="export-body web-body">
    <div class="web-panes"></div>
    <div class="export-settings web-settings">
      <section class="export-section"><h3>Settings for <span class="web-scope"></span></h3>
        <label class="export-row"><span>Format</span><select name="format">${(Object.keys(formatNames) as SliceFormat[]).map((f) => `<option value="${f}">${formatNames[f]}</option>`).join('')}</select></label>
        <label class="export-row" data-show="lossy"><span>Quality</span><span class="export-range"><input type="range" name="quality" min="1" max="100" step="1"><output data-for="quality"></output></span></label>
        <label class="export-row" data-show="gif"><span>Colors</span><input type="number" name="colors" min="2" max="256" step="1"></label>
        <label class="export-check" data-show="gif"><input type="checkbox" name="dither"><span>Dither</span></label>
        <label class="export-check" data-show="alpha"><input type="checkbox" name="transparency"><span>Transparency</span></label>
        <label class="export-row" data-show="matte"><span>Matte</span><input type="color" name="matte"></label>
        <p class="export-note web-mixed" hidden>These slices use different settings; a change applies to all of them.</p>
        <button type="button" class="web-all" ${multi ? '' : 'hidden'}>Apply to all slices</button>
      </section>
      <section class="export-section"><h3>Image Size</h3>
        <label class="export-row"><span>Scale %</span><input type="number" name="scale" min="1" max="400" step="any"></label>
        <p class="export-note web-dims"></p>
      </section>
      <section class="export-section"><h3>Slices</h3>
        <p class="export-note">${multi ? `${allPieces.length} slices. Click a slice in a preview to change its settings; Shift-click adds slices.` : 'The whole image is one slice. Draw slices with the Slice tool to export parts separately.'}</p>
        <button type="button" class="web-select-all" ${multi ? '' : 'hidden'}>Select all slices</button>
      </section>
      <section class="export-section"><h3>Output</h3>
        <label class="export-row"><span>Name</span><input type="text" name="base" value="${escapeXML((doc.info?.title?.trim() || doc.name).replace(/\.[a-z0-9]+$/i, ''))}"></label>
        <label class="export-check"><input type="checkbox" name="html" ${memory.html ? 'checked' : ''}><span>Include HTML table</span></label>
      </section>
    </div>
  </div>
  <div class="dialog-actions export-actions"><span class="web-total" aria-live="polite"></span><button type="button" data-act="cancel">Cancel</button><button type="submit" class="primary" data-act="export">Export…</button></div>
</form>`;
  e.root.append(dialog);
  const form = dialog.querySelector('form')!;
  const field = <T extends HTMLInputElement | HTMLSelectElement>(name: string) => form.elements.namedItem(name) as T;
  const panesEl = dialog.querySelector<HTMLElement>('.web-panes')!;

  // Composite once in sRGB at the output scale; slices are cut from it.
  let prepared: SourceImage | undefined;
  let preparedScale = 0;
  let originalUrl = '';
  let pieces = allPieces;
  const ctx: ExportContext = { profile: null };
  let preparing: { scale: number; job: Promise<SourceImage> } | undefined;
  const prepare = (): Promise<SourceImage> => {
    if (prepared && preparedScale === scale) return Promise.resolve(prepared);
    // Panes ask at the same time: they share one composite and conversion.
    if (preparing?.scale === scale) return preparing.job;
    const at = scale;
    const job = (async () => {
      const src = await documentSource(e, doc);
      const s = effectiveSettings(doc, { ...loadSettings(), format: 'png', transparency: true, depth: 8, sizeMode: 'percent', scale: at, canvasWidth: 0, canvasHeight: 0, convertSrgb: true });
      // Converting a large composite takes a while: the export worker does it.
      const ready = await prepareOffThread(src, s, exportContext(doc), true);
      prepared = ready;
      preparedScale = at;
      pieces = scalePieces(allPieces, ready.width / doc.width);
      const c = new OffscreenCanvas(ready.width, ready.height);
      c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(ready.data as Uint8ClampedArray), ready.width, ready.height), 0, 0);
      if (originalUrl) URL.revokeObjectURL(originalUrl);
      originalUrl = URL.createObjectURL(await c.convertToBlob({ type: 'image/png' }));
      // Closed while it was prepared: nothing shows it any more.
      if (closed) {
        URL.revokeObjectURL(originalUrl);
        originalUrl = '';
      }
      for (const p of panes) clearPane(p);
      return ready;
    })();
    preparing = { scale: at, job };
    const done = () => {
      if (preparing?.job === job) preparing = undefined;
    };
    job.then(done, done);
    return job;
  };
  const clearPane = (p: Pane) => {
    for (const x of p.encoded.values()) URL.revokeObjectURL(x.url);
    p.encoded.clear();
  };
  const cacheKey = (piece: SlicePiece, s: WebSettings) => JSON.stringify([piece.rect, s, scale]);
  const encodePane = async (p: Pane) => {
    const g = ++p.generation;
    const img = await prepare();
    const wanted = new Set(pieces.map((piece) => cacheKey(piece, p.settings.get(keyOf(piece))!)));
    for (const [k, v] of p.encoded)
      if (!wanted.has(k)) {
        URL.revokeObjectURL(v.url);
        p.encoded.delete(k);
      }
    for (const piece of pieces) {
      const s = p.settings.get(keyOf(piece))!;
      const k = cacheKey(piece, s);
      if (p.encoded.has(k)) continue;
      const { bytes } = await encodeOffThread(crop(img, piece.rect), exportSettings(s), ctx);
      if (g !== p.generation) return false;
      p.encoded.set(k, { bytes, url: URL.createObjectURL(bytesBlob(bytes, formatInfo[s.format].mime)) });
    }
    return true;
  };
  const paneBytes = (p: Pane) => pieces.reduce((sum, piece) => sum + (p.encoded.get(cacheKey(piece, p.settings.get(keyOf(piece))!))?.bytes.length ?? 0), 0);
  const paneComplete = (p: Pane) => pieces.every((piece) => p.encoded.has(cacheKey(piece, p.settings.get(keyOf(piece))!)));
  const paneLabel = (p: Pane) => {
    const kinds = [...new Set(pieces.map((piece) => describeSettings(p.settings.get(keyOf(piece))!)))];
    return kinds.length > 2 ? 'Mixed settings' : kinds.join(' + ');
  };
  const visiblePanes = (): number[] => (view === 'original' ? [-1] : view === 'optimized' ? [active] : view === '2up' ? [-1, active] : [-1, 0, 1, 2]);

  const outlines = () => {
    if (!multi || !prepared) return '';
    const W = prepared.width,
      H = prepared.height;
    return `<svg class="web-slices" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${pieces
      .map((piece) => {
        const r = piece.rect,
          k = keyOf(piece);
        const sel = scope.has(k);
        return `<rect data-key="${escapeXML(k)}" class="${piece.kind === 'auto' ? 'auto' : 'user'} ${sel ? 'selected' : ''}" x="${r.x}" y="${r.y}" width="${r.width}" height="${r.height}" vector-effect="non-scaling-stroke"/>`;
      })
      .join('')}</svg>${pieces.map((piece) => `<span class="web-slice-number ${piece.kind}" style="left:${(piece.rect.x / prepared!.width) * 100}%;top:${(piece.rect.y / prepared!.height) * 100}%">${String(piece.number).padStart(2, '0')}</span>`).join('')}`;
  };
  const render = () => {
    for (const b of dialog.querySelectorAll<HTMLButtonElement>('[data-view]')) b.setAttribute('aria-selected', String(b.dataset.view === view));
    for (const b of dialog.querySelectorAll<HTMLButtonElement>('[data-view]')) b.setAttribute('aria-pressed', String(b.dataset.view === view));
    dialog.querySelector('.web-zoom')!.textContent = actual ? '100%' : 'Fit';
    const list = visiblePanes();
    panesEl.dataset.count = String(list.length);
    panesEl.classList.toggle('actual', actual);
    const img = prepared;
    panesEl.innerHTML = list
      .map((i) => {
        const p = i >= 0 ? panes[i] : undefined;
        const body = !img
          ? ''
          : p
            ? pieces
                .map((piece) => {
                  const enc = p.encoded.get(cacheKey(piece, p.settings.get(keyOf(piece))!));
                  const r = piece.rect;
                  return enc ? `<img alt="" src="${enc.url}" style="left:${(r.x / img.width) * 100}%;top:${(r.y / img.height) * 100}%;width:${(r.width / img.width) * 100}%;height:${(r.height / img.height) * 100}%">` : '';
                })
                .join('')
            : `<img alt="" src="${originalUrl}" style="left:0;top:0;width:100%;height:100%">`;
        const bytes = p ? paneBytes(p) : 0;
        const done = p ? paneComplete(p) : !!img;
        const caption = p
          ? `<strong>${escapeXML(paneLabel(p))}</strong><span>${done ? `${formatBytes(bytes)} · ${formatSeconds(downloadSeconds(bytes))} at 8 Mbps` : 'Encoding…'}</span>`
          : `<strong>Original</strong><span>${img ? `${img.width} × ${img.height} px` : ''}</span>`;
        // Fit: the largest box of the image's aspect ratio inside the stage.
        const size = img ? `width:${actual ? `${img.width}px` : `min(100cqw, ${(img.width / img.height) * 100}cqh)`} !important;aspect-ratio:${img.width} / ${img.height}` : '';
        return `<figure class="web-pane ${p && i === active && view === '4up' ? 'active' : ''} ${p ? 'optimized' : 'original'}" data-pane="${i}"><div class="web-pane-stage"><div class="web-pane-image" style="${size}">${body}${outlines()}</div>${done ? '' : '<span class="export-busy">Encoding…</span>'}</div><figcaption>${caption}</figcaption></figure>`;
      })
      .join('');
    const p = panes[active];
    const total = dialog.querySelector('.web-total')!;
    total.textContent = paneComplete(p) ? `${pieces.length} file${pieces.length > 1 ? 's' : ''} · ${formatBytes(paneBytes(p))}` : 'Encoding…';
    dialog.querySelector('.web-dims')!.textContent = img ? `${img.width} × ${img.height} px` : '';
  };

  // ----- Settings panel -----
  const scopeKeys = () => (scope.size ? [...scope] : keys);
  const scopeLabel = () => {
    if (!multi) return 'the image';
    if (!scope.size) return 'all slices';
    const nums = pieces.filter((p) => scope.has(keyOf(p))).map((p) => String(p.number).padStart(2, '0'));
    const named = [...scope].map((k) => sliceById.get(k)?.name).filter(Boolean);
    return named.length === 1 && scope.size === 1 ? `${named[0]} (${nums.join(', ')})` : scope.has('auto') && scope.size === 1 ? 'automatic slices' : `slice${nums.length > 1 ? 's' : ''} ${nums.join(', ')}`;
  };
  const writeFields = () => {
    const s = panes[active].settings.get(scopeKeys()[0])!;
    field<HTMLSelectElement>('format').value = s.format;
    field<HTMLInputElement>('quality').value = String(s.quality);
    field<HTMLInputElement>('colors').value = String(s.colors);
    field<HTMLInputElement>('dither').checked = s.dither;
    field<HTMLInputElement>('transparency').checked = s.transparency;
    field<HTMLInputElement>('matte').value = s.matte;
    if (document.activeElement !== field('scale')) field<HTMLInputElement>('scale').value = String(scale);
    dialog.querySelector('.web-scope')!.textContent = scopeLabel();
    const mixed = new Set(scopeKeys().map((k) => JSON.stringify(panes[active].settings.get(k)))).size > 1;
    dialog.querySelector<HTMLElement>('.web-mixed')!.hidden = !mixed;
    visibility(s);
  };
  const visibility = (s: WebSettings) => {
    const tags = new Set<string>([s.format]);
    if (lossy(s.format)) tags.add('lossy');
    if (s.format !== 'jpeg') tags.add('alpha');
    if (s.format === 'jpeg' || !s.transparency) tags.add('matte');
    for (const el of dialog.querySelectorAll<HTMLElement>('.web-settings [data-show]')) el.hidden = !el.dataset.show!.split(' ').some((t) => tags.has(t));
    for (const o of dialog.querySelectorAll<HTMLOutputElement>('output[data-for]')) o.value = field<HTMLInputElement>(o.dataset.for!).value;
  };
  const readFields = (): WebSettings => ({
    format: field<HTMLSelectElement>('format').value as SliceFormat,
    quality: Math.max(1, Math.min(100, Math.round(Number(field<HTMLInputElement>('quality').value) || 80))),
    colors: Math.max(2, Math.min(256, Math.round(Number(field<HTMLInputElement>('colors').value) || 256))),
    dither: field<HTMLInputElement>('dither').checked,
    transparency: field<HTMLInputElement>('transparency').checked,
    matte: field<HTMLInputElement>('matte').value,
  });

  let timer = 0;
  let closed = false;
  // While Export encodes, previews wait: encoding a pane again would cancel
  // the export's own encoding of it.
  let exporting = false;
  const refresh = () => {
    clearTimeout(timer);
    timer = window.setTimeout(async () => {
      if (exporting) return;
      try {
        render();
        // The current pane first, so its numbers settle soonest.
        const order = [active, ...visiblePanes().filter((i) => i >= 0 && i !== active)];
        if (view === 'original') await prepare();
        for (const i of order) {
          if (closed || exporting) return;
          if (await encodePane(panes[i])) render();
        }
        render();
      } catch (error) {
        if (closed) return;
        dialog.querySelector('.web-total')!.textContent = error instanceof Error ? error.message : String(error);
      }
    }, 200);
  };
  const applyFields = () => {
    const s = readFields();
    for (const k of scopeKeys()) panes[active].settings.set(k, { ...s });
    // Alternates follow the current pane until one of them is chosen.
    if (active === 0)
      for (const k of scopeKeys()) {
        const [a, b] = alternates(s);
        panes[1].settings.set(k, a);
        panes[2].settings.set(k, b);
      }
    visibility(s);
    refresh();
  };
  form.addEventListener('input', (ev) => {
    const t = ev.target as HTMLInputElement;
    if (t.name === 'scale') {
      const v = Number(t.value);
      if (v >= 1 && v <= 400) {
        scale = v;
        refresh();
      }
    } else if (['format', 'quality', 'colors', 'dither', 'transparency', 'matte'].includes(t.name)) applyFields();
  });
  dialog.querySelector('.web-tabs')!.addEventListener('click', (ev) => {
    const b = (ev.target as HTMLElement).closest<HTMLElement>('[data-view]');
    if (!b) return;
    view = b.dataset.view as View;
    refresh();
  });
  dialog.querySelector('.web-zoom')!.addEventListener('click', () => {
    actual = !actual;
    render();
  });
  dialog.querySelector('.web-all')!.addEventListener('click', () => {
    scope = new Set();
    applyFields();
    writeFields();
    render();
  });
  dialog.querySelector('.web-select-all')!.addEventListener('click', () => {
    scope = new Set();
    writeFields();
    render();
  });
  panesEl.addEventListener('click', (ev) => {
    const t = ev.target as Element;
    const fig = t.closest<HTMLElement>('[data-pane]');
    if (!fig) return;
    const i = Number(fig.dataset.pane);
    const k = t.closest<SVGElement>('[data-key]')?.dataset.key ?? pieceKeyAt(fig, ev as MouseEvent);
    if (i >= 0) active = i;
    if (k && multi) {
      if ((ev as MouseEvent).shiftKey) {
        if (scope.has(k)) scope.delete(k);
        else scope.add(k);
      } else scope = new Set([k]);
    }
    writeFields();
    render();
  });
  // Clicks fall through the slice outlines' fill; find the piece by position.
  const pieceKeyAt = (fig: HTMLElement, ev: MouseEvent) => {
    const box = fig.querySelector('.web-pane-image')?.getBoundingClientRect();
    if (!box || !prepared || !multi) return undefined;
    const x = ((ev.clientX - box.left) / box.width) * prepared.width,
      y = ((ev.clientY - box.top) / box.height) * prepared.height;
    const piece = pieces.find((p) => x >= p.rect.x && y >= p.rect.y && x < p.rect.x + p.rect.width && y < p.rect.y + p.rect.height);
    return piece ? keyOf(piece) : undefined;
  };

  return new Promise<void>((resolve) => {
    const close = () => {
      closed = true;
      clearTimeout(timer);
      for (const p of panes) {
        p.generation++;
        clearPane(p);
      }
      if (originalUrl) URL.revokeObjectURL(originalUrl);
      dialog.close();
      dialog.remove();
      resolve();
    };
    dialog.addEventListener('cancel', (ev) => {
      ev.preventDefault();
      close();
    });
    dialog.querySelector('[data-act="cancel"]')!.addEventListener('click', close);
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      if (exporting) return;
      exporting = true;
      clearTimeout(timer);
      const buttons = dialog.querySelectorAll<HTMLButtonElement>('.export-actions button');
      buttons.forEach((b) => (b.disabled = true));
      const total = dialog.querySelector('.web-total')!;
      total.textContent = 'Encoding…';
      try {
        const p = panes[active];
        // A preview that was encoding this pane when Export was pressed
        // gives way to the export (its own result is dropped).
        if (!(await encodePane(p)) || !paneComplete(p)) await encodePane(p);
        if (closed) return;
        if (!paneComplete(p)) throw new Error('The images could not be encoded; try Export again.');
        const base = field<HTMLInputElement>('base').value.trim().replace(/[\\/:*?"<>|]+/g, '_') || 'image';
        const html = field<HTMLInputElement>('html').checked;
        const names = pieceNames(pieces, base);
        const used = new Set<string>();
        const files = pieces.map((piece, i) => `images/${uniqueName(`${names[i]}.${formatInfo[p.settings.get(keyOf(piece))!.format].ext}`, used)}`);
        const entries: ZipEntry[] = pieces.map((piece, i) => ({ name: files[i], data: p.encoded.get(cacheKey(piece, p.settings.get(keyOf(piece))!))!.bytes }));
        if (html) entries.push({ name: `${base}.html`, data: new TextEncoder().encode(sliceTableHtml(pieces, files, base, prepared!.width, prepared!.height)) });
        // Remember per-slice choices in the document (user and layer slices).
        const changed = (doc.slices ?? []).filter((s) => {
          const w = p.settings.get(s.id);
          if (!w) return false;
          const q = w.format === 'gif' ? w.colors : lossy(w.format) ? w.quality : undefined;
          return s.format !== w.format || s.quality !== q;
        });
        if (changed.length && e.doc === doc)
          e.command('Slice Export Settings', (d) => {
            d.slices = (d.slices ?? []).map((s) => {
              const w = p.settings.get(s.id);
              if (!w) return s;
              const next: Slice = { ...s, format: w.format };
              const q = w.format === 'gif' ? w.colors : lossy(w.format) ? w.quality : undefined;
              if (q === undefined) delete next.quality;
              else next.quality = q;
              return next;
            });
          });
        remember({ view, html, scale, auto: p.settings.get('auto') ?? p.settings.get(keys[0])! });
        const zip = zipStore(entries);
        close();
        download(bytesBlob(zip, 'application/zip'), `${base}-web.zip`);
        e.message(`Exported ${pieces.length} image${pieces.length > 1 ? 's' : ''}${html ? ' and an HTML page' : ''} (${formatBytes(zip.length)})`);
      } catch (error) {
        exporting = false;
        buttons.forEach((b) => (b.disabled = false));
        total.textContent = error instanceof Error ? error.message : String(error);
      }
    });
    writeFields();
    dialog.showModal();
    render();
    refresh();
  });
}
