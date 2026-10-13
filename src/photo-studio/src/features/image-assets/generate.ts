// Image Assets generation: render each asset-named layer alone, trim it to its
// visible pixels, resample and encode it in the export worker (palette PNG
// and SVG on the main thread), then write the files beside the document on
// Puter or keep them for Download Image Assets (.zip). Unchanged layers reuse
// their encoded files; a newer edit cancels a generation in progress.
import { deflate } from 'pako';
import type { Editor } from '../../editor';
import type { DocumentSession } from '../../app/session';
import { allLayers, findLayer, type Layer, type PhotoDocument } from '../../model/document';
import { escapeXML } from '../../model/assets';
import { svg } from '../../app/icons';
import { download } from '../../persistence/puter';
import { buildPng } from '../../imaging/codecs/png-chunks';
import { buildPalette, mapToPalette } from '../../imaging/codecs/quantize';
import { defaultSettings, prepareExport, type ExportSettings, type SourceImage } from '../files/encode';
import { bytesBlob, effectiveSettings, encodeOffThread, exportContext, formatBytes, layerSource } from '../files/pipeline';
import { rgba16To8 } from '../files/png';
import { exportSvg } from '../files/svg-export';
import { zipStore } from '../files/zip';
import { cloudWrite, joinPath } from '../files/cloud';
import { outputDims } from './names';
import { assetsFolder, planAssets, type AssetIssue, type PlannedAsset } from './plan';
import { assetListeners, assetState, notifyAssets, type AssetFile, type AssetState } from './state';

const MIME: Record<PlannedAsset['format'], string> = { png: 'image/png', png8: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', svg: 'image/svg+xml' };
// Puter writes that take longer than this are reported, not waited on forever.
export const PUTER_TIMEOUT_MS = 30_000;

/** Crop to pixels with any alpha, keeping the offset of the crop. */
export function trimWithOffset(src: SourceImage): { x: number; y: number; image: SourceImage } | undefined {
  const { width: w, height: h, data } = src;
  let x0 = w,
    y0 = h,
    x1 = -1,
    y1 = -1;
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
  if (cw === w && ch === h) return { x: 0, y: 0, image: src };
  const Ctor = data.constructor as { new (n: number): typeof data };
  const out = new Ctor(cw * ch * 4);
  for (let y = 0; y < ch; y++) out.set(data.subarray(((y + y0) * w + x0) * 4, ((y + y0) * w + x1 + 1) * 4), y * cw * 4);
  return { x: x0, y: y0, image: { width: cw, height: ch, data: out } };
}

/** 8-bit palette PNG (color type 3) with binary transparency through tRNS. */
export function encodePalettePng(img: { width: number; height: number; data: Uint8ClampedArray }): Uint8Array {
  const { width, height, data } = img;
  let transparent = false;
  for (let i = 3; i < data.length; i += 4)
    if (data[i] < 128) {
      transparent = true;
      break;
    }
  let palette = buildPalette([img], { maxColors: transparent ? 255 : 256 });
  if (!palette.length) palette = new Uint8Array(3);
  const count = palette.length / 3;
  const tIndex = transparent ? count : 0;
  const indices = mapToPalette(img, palette, { dither: true, transparentIndex: tIndex });
  const plte = new Uint8Array((count + (transparent ? 1 : 0)) * 3);
  plte.set(palette);
  const raw = new Uint8Array((width + 1) * height);
  for (let y = 0; y < height; y++) raw.set(indices.subarray(y * width, (y + 1) * width), y * (width + 1) + 1);
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr[8] = 8;
  ihdr[9] = 3;
  const chunks = [{ type: 'IHDR', data: ihdr }, { type: 'PLTE', data: plte }];
  if (transparent) {
    const trns = new Uint8Array(count + 1).fill(255);
    trns[count] = 0;
    chunks.push({ type: 'tRNS', data: trns });
  }
  chunks.push({ type: 'IDAT', data: deflate(raw, { level: 9 }) }, { type: 'IEND', data: new Uint8Array() });
  return buildPng(chunks);
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer = 0;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<never>((_, reject) => (timer = window.setTimeout(() => reject(new Error(`${what} did not finish in ${Math.round(ms / 1000)} s.`)), ms))),
  ]);
}

/** What a layer's pixels depend on besides the layer itself. */
function layerKey(doc: PhotoDocument, l: Layer) {
  return JSON.stringify([l, doc.globalLight ?? null, doc.iccProfile?.length ?? 0, doc.iccUntaggedProfile ?? false, doc.bitsPerChannel ?? 8, (doc.patterns ?? []).map((p) => p.id), doc.width, doc.height]);
}
const assetKey = (base: string, a: PlannedAsset) => `${base}|${JSON.stringify([a.path, a.format, a.quality ?? null, a.size ?? null, a.scale])}`;

async function encodeAsset(e: Editor, doc: PhotoDocument, l: Layer, a: PlannedAsset, trimmed: { x: number; y: number; image: SourceImage }): Promise<{ bytes: Uint8Array; width: number; height: number }> {
  const [w, h] = outputDims(trimmed.image.width, trimmed.image.height, a.size, a.scale);
  if (a.format === 'svg') {
    const leaves = l.kind === 'group' ? allLayers(l.children).filter((c) => c.kind !== 'group' && c.visible) : [l];
    const sub: PhotoDocument = { ...doc, layers: leaves.map((c) => ({ ...c, visible: true, clipped: false })) };
    const text = (await exportSvg(e, sub, { sizeMode: 'percent', scale: 100, width: 0, height: 0 })).replace(
      /<svg ([^>]*?)width="[^"]*" height="[^"]*" viewBox="[^"]*"/,
      `<svg $1width="${w}" height="${h}" viewBox="${trimmed.x} ${trimmed.y} ${trimmed.image.width} ${trimmed.image.height}" preserveAspectRatio="none"`,
    );
    return { bytes: new TextEncoder().encode(text), width: w, height: h };
  }
  const format = a.format === 'png8' ? 'png' : a.format;
  const settings: ExportSettings = effectiveSettings(doc, {
    ...defaultSettings,
    format,
    quality: a.quality ?? 90,
    transparency: true,
    depth: 8,
    sizeMode: 'exact',
    width: w,
    height: h,
    canvasWidth: 0,
    canvasHeight: 0,
    resample: 'bicubic',
    metadata: 'none',
  });
  const ctx = exportContext(doc);
  if (a.format === 'png8') {
    const p = prepareExport(trimmed.image, settings, ctx);
    const data = p.data instanceof Uint16Array ? rgba16To8(p.data) : p.data;
    return { bytes: encodePalettePng({ width: p.width, height: p.height, data }), width: w, height: h };
  }
  const { bytes } = await encodeOffThread(trimmed.image, settings, ctx);
  return { bytes, width: w, height: h };
}

export type GenerateOptions = { background: boolean; reschedule?: () => void };

/** Generate the session's assets. Resolves to the state, or undefined when a
 * newer edit (or a busy workspace in the background) cancelled the run. */
export async function generateAssets(e: Editor, s: DocumentSession, opts: GenerateOptions): Promise<AssetState | undefined> {
  const st = assetState(s);
  const token = ++st.token;
  const doc = s.doc;
  const plan = planAssets(doc);
  st.status = 'working';
  notifyAssets();
  const issues: AssetIssue[] = [...plan.issues];
  const files: AssetFile[] = [];
  const cache = new Map<string, AssetFile>();
  // Stop when superseded, when the document is no longer the active one (the
  // compositor reads the active document's assets) or, in the background,
  // while the user works.
  const stale = () => token !== st.token || e.session !== s || s.doc !== doc;
  const interrupted = () => stale() || (opts.background && (e.busy || e.toolBusy));
  const byLayer = new Map<string, PlannedAsset[]>();
  for (const a of plan.assets) byLayer.set(a.layerId, [...(byLayer.get(a.layerId) ?? []), a]);
  try {
    for (const [id, list] of byLayer) {
      const l = findLayer(doc.layers, id);
      if (!l) continue;
      const base = layerKey(doc, l);
      let trimmed: { x: number; y: number; image: SourceImage } | undefined | null = null;
      for (const a of list) {
        const key = assetKey(base, a);
        const hit = st.cache.get(key) ?? cache.get(key);
        if (hit) {
          files.push(hit);
          cache.set(key, hit);
          continue;
        }
        if (trimmed === null) {
          if (interrupted()) return cancel(st, token, opts);
          trimmed = trimWithOffset(await layerSource(e, l, doc));
          if (interrupted()) return cancel(st, token, opts);
          if (!trimmed) issues.push({ layerId: l.id, layerName: l.name, message: 'The layer is empty; nothing was written.' });
        }
        if (!trimmed) break;
        try {
          const out = await encodeAsset(e, doc, l, a, trimmed);
          if (interrupted()) return cancel(st, token, opts);
          const file: AssetFile = { path: a.path, bytes: out.bytes, mime: MIME[a.format], width: out.width, height: out.height, layerId: l.id, key };
          files.push(file);
          cache.set(key, file);
        } catch (error) {
          if (interrupted()) return cancel(st, token, opts);
          issues.push({ layerId: l.id, layerName: l.name, message: `“${a.path}” could not be encoded: ${error instanceof Error ? error.message : String(error)}` });
        }
      }
    }
    st.cache = cache;
    st.files = files;
    st.issues = issues;
    st.doc = doc;
    st.error = undefined;
    if (doc.imageAssets && s.storage.path && files.length) await writeToPuter(st, s, files, token);
    if (token !== st.token) return;
    st.status = 'ready';
    notifyAssets();
    return st;
  } catch (error) {
    if (stale()) return cancel(st, token, opts);
    st.status = 'error';
    st.error = error instanceof Error ? error.message : String(error);
    notifyAssets();
    return st;
  }
}
function cancel(st: AssetState, token: number, opts: GenerateOptions): undefined {
  // Only the run that is still current asks to be tried again.
  if (token === st.token && opts.background) opts.reschedule?.();
  return undefined;
}

async function writeToPuter(st: AssetState, s: DocumentSession, files: AssetFile[], token: number) {
  const folder = assetsFolder(s.storage.path!);
  try {
    for (const f of files) {
      const target = joinPath(folder, f.path);
      if (st.written.get(target) === f.key) continue;
      await withTimeout(cloudWrite(target, bytesBlob(f.bytes, f.mime)), PUTER_TIMEOUT_MS, `Writing ${f.path} to Puter`);
      if (token !== st.token) return;
      st.written.set(target, f.key);
    }
    st.folder = folder;
  } catch (error) {
    st.error = `Could not write to ${folder}: ${error instanceof Error ? error.message : String(error)}`;
  }
}

const zipName = (s: DocumentSession) => `${(s.fileName ?? s.doc.name).replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|]+/g, '_') || 'Untitled'}-assets.zip`;

/** File → Generate → Download Image Assets (.zip). */
export async function downloadAssets(e: Editor) {
  const s = e.session;
  const st = await generateAssets(e, s, { background: false });
  if (!st) throw new Error('Image Assets were interrupted. Try again.');
  const problems = st.issues.length;
  if (!st.files.length) {
    e.message(problems ? `No image assets were written: ${st.issues[0].layerName}: ${st.issues[0].message}` : 'No layer names ask for image assets.');
    return;
  }
  const zip = zipStore(st.files.map((f) => ({ name: f.path, data: f.bytes })));
  download(bytesBlob(zip, 'application/zip'), zipName(s));
  e.message(`Downloaded ${st.files.length} image asset${st.files.length === 1 ? '' : 's'} (${formatBytes(zip.length)})${problems ? `; ${problems} problem${problems === 1 ? '' : 's'} in layer names (see the Assets item on the status bar)` : ''}.`);
}

// ----- Status popover -----
let popover: { el: HTMLElement; button: HTMLElement; close: () => void } | undefined;

function popoverHtml(e: Editor): string {
  const st = assetState(e.session);
  const where = st.folder && e.session.storage.path ? `Written to ${escapeXML(st.folder)}` : e.session.storage.path ? 'Written beside the document on Puter' : 'Kept for download (save the document to Puter to write a folder beside it)';
  const issues = st.issues
    .map(
      (i) =>
        `<li><button type="button" class="ia-issue" data-layer="${escapeXML(i.layerId)}" title="Select the layer"><span class="ia-mark" aria-hidden="true">${svg('ban', 13)}</span><span><strong>${escapeXML(i.layerName)}</strong><span class="ia-message">${escapeXML(i.message)}</span></span></button></li>`,
    )
    .join('');
  const files = st.files
    .slice()
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((f) => `<li class="ia-file"><span class="ia-path">${escapeXML(f.path)}</span><span class="ia-meta">${f.width} × ${f.height} · ${formatBytes(f.bytes.length)}</span></li>`)
    .join('');
  const status = st.status === 'working' ? 'Updating…' : st.status === 'idle' ? 'Waiting for the first update…' : `${st.files.length} file${st.files.length === 1 ? '' : 's'}`;
  return `<header class="ia-head"><h2>Image Assets</h2><span class="ia-status" aria-live="polite">${status}</span></header>
<p class="ia-where">${where}</p>
${st.error ? `<p class="ia-error" role="alert">${escapeXML(st.error)}</p>` : ''}
${issues ? `<h3>Problems</h3><ul class="ia-issues">${issues}</ul>` : ''}
${files ? `<h3>Files</h3><ul class="ia-files">${files}</ul>` : st.status === 'ready' && !issues ? '<p class="ia-empty">No layer names ask for files yet. Name a layer like “icon.png”, “200% hero.jpg80” or “icons/close.svg”.</p>' : ''}
<div class="ia-actions"><button type="button" data-ia="download" ${st.files.length ? '' : 'disabled'}>${svg('download', 13)}Download (.zip)</button><button type="button" data-ia="off">Turn Off</button></div>`;
}

export function togglePopover(e: Editor, button: HTMLElement) {
  if (popover) return popover.close();
  const el = document.createElement('div');
  el.className = 'context-menu image-assets-pop';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', 'Image Assets');
  el.tabIndex = -1;
  const place = () => {
    const r = button.getBoundingClientRect(),
      m = el.getBoundingClientRect();
    el.style.left = `${Math.max(4, Math.min(r.left, innerWidth - m.width - 4))}px`;
    el.style.top = `${Math.max(4, r.top - m.height - 4)}px`;
  };
  const render = () => {
    const focused = document.activeElement && el.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.ia ?? '' : '';
    el.innerHTML = popoverHtml(e);
    place();
    if (focused) el.querySelector<HTMLElement>(`[data-ia="${focused}"]`)?.focus();
  };
  const outside = (ev: Event) => {
    if (!el.contains(ev.target as Node) && !button.contains(ev.target as Node)) close();
  };
  const close = () => {
    el.remove();
    button.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', outside, true);
    document.removeEventListener('keydown', escape, true);
    const i = assetListeners.indexOf(render);
    if (i >= 0) assetListeners.splice(i, 1);
    popover = undefined;
  };
  document.body.append(el);
  render();
  button.setAttribute('aria-expanded', 'true');
  assetListeners.push(render);
  document.addEventListener('pointerdown', outside, true);
  const escape = (ev: KeyboardEvent) => {
    if (ev.key !== 'Escape') return;
    ev.preventDefault();
    ev.stopPropagation();
    close();
    button.focus();
  };
  document.addEventListener('keydown', escape, true);
  el.addEventListener('click', (ev) => {
    const t = ev.target as HTMLElement;
    const issue = t.closest<HTMLElement>('[data-layer]');
    if (issue) {
      const id = issue.dataset.layer!;
      close();
      if (findLayer(e.doc.layers, id)) {
        e.selectLayers([id]);
        e.update();
      }
      return;
    }
    const act = t.closest<HTMLElement>('[data-ia]')?.dataset.ia;
    if (act === 'download') {
      close();
      void e.runCommand('file.download-image-assets');
    } else if (act === 'off') {
      close();
      void e.runCommand('file.image-assets');
    }
  });
  popover = { el, button, close };
  (el.querySelector<HTMLElement>('button:not(:disabled)') ?? el).focus();
}
