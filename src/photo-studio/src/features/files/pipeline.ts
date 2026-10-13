// Editor glue for the export pipeline: read document/layer pixels back from
// the compositor, build the color/metadata context and remember settings.
import type { Editor } from '../../editor';
import type { Layer, PhotoDocument } from '../../model/document';
import { decodeIccProfile } from '../../model/psd-resources';
import { download, preferredFileName } from '../../persistence/puter';
import { emitAppEvent } from '../../app/app-events';
import { documentProfile, floatTo16 } from './color';
import { defaultSettings, encodeExport, exportFileName, formatInfo, prepareExport, type ExportContext, type ExportSettings, type SourceImage } from './encode';
import { exportSvg } from './svg-export';
import { encodeGif, type GifEncodeFrame, type GifEncodeOptions } from '../../imaging/codecs/gif';

const KEY = 'photo-studio-export';
export function loadSettings(): ExportSettings {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    const s = { ...defaultSettings, ...(saved && typeof saved === 'object' ? saved : {}) } as ExportSettings;
    if (!(s.format in formatInfo)) s.format = 'png';
    return s;
  } catch {
    return { ...defaultSettings };
  }
}
export function saveSettings(s: ExportSettings) {
  try {
    // Canvas size is specific to one document.
    localStorage.setItem(KEY, JSON.stringify({ ...s, canvasWidth: 0, canvasHeight: 0 }));
  } catch {
    /* Optional. */
  }
}

export function isDeep(doc: PhotoDocument) {
  return (doc.bitsPerChannel ?? 8) > 8;
}
// Untagged float documents are linear; their pixels must be encoded for export.
export function mustConvert(doc: PhotoDocument) {
  return doc.bitsPerChannel === 32 && !(doc.iccProfile && !doc.iccUntaggedProfile);
}

/** Composite pixels (document color space): 8-bit, or 16-bit for deep documents. */
export async function documentSource(e: Editor, doc: PhotoDocument = e.doc): Promise<SourceImage> {
  const samples = await e.renderer.documentPixels({ ...doc, selection: null }, e.assets);
  return samplesToSource(samples, doc.width, doc.height);
}
export function samplesToSource(samples: Uint8Array | Float32Array, width: number, height: number): SourceImage {
  if (samples instanceof Float32Array) return { width, height, data: floatTo16(samples) };
  return { width, height, data: new Uint8ClampedArray(samples.buffer, samples.byteOffset, samples.length) };
}
/** One top-level layer composited alone (keeping its opacity and blend). */
export async function layerSource(e: Editor, l: Layer, doc: PhotoDocument = e.doc): Promise<SourceImage> {
  return documentSource(e, { ...doc, layers: [{ ...l, visible: true, clipped: false }] });
}

export function exportContext(doc: PhotoDocument): ExportContext {
  const profile = documentProfile(doc);
  const icc = doc.iccProfile && !doc.iccUntaggedProfile && profile ? decodeIccProfile(doc.iccProfile) : undefined;
  const r = doc.resolution;
  const dpi = r ? (r.horizontalResolutionUnit === 'PPCM' ? r.horizontalResolution * 2.54 : r.horizontalResolution) : undefined;
  return { profile, icc, dpi, info: doc.info };
}
export function effectiveSettings(doc: PhotoDocument, s: ExportSettings): ExportSettings {
  return mustConvert(doc) ? { ...s, convertSrgb: true } : s;
}

/** Encode a document with the settings. `source` may be cached by callers. */
export async function encodeDocument(e: Editor, settings: ExportSettings, doc: PhotoDocument = e.doc, source?: SourceImage) {
  const s = effectiveSettings(doc, settings);
  const ctx = exportContext(doc);
  if (s.format === 'svg') {
    const text = await exportSvg(e, doc, s);
    const bytes = new TextEncoder().encode(text);
    return { bytes, width: 0, height: 0, mime: formatInfo.svg.mime, prepared: undefined };
  }
  const src = source ?? (await documentSource(e, doc));
  const { bytes, prepared } = await encodeOffThread(src, s, ctx, true);
  return { bytes, width: prepared!.width, height: prepared!.height, mime: formatInfo[s.format].mime, prepared };
}

export function bytesBlob(bytes: Uint8Array, mime: string) {
  return new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mime });
}
/** Quick export with the last Export As settings in the format and to the
 * place chosen in Preferences → Export. */
export async function quickExport(e: Editor, format: ExportSettings['format'] = e.preferences.quickExportFormat) {
  const s = { ...loadSettings(), format };
  const out = await encodeDocument(e, s);
  const name = preferredFileName(exportFileName(e.doc.name, format));
  const { withProvenance } = await import('../provenance/export');
  out.bytes = await withProvenance(e.session, out.bytes, name, e.preferences.provenanceAttach, { prompts: e.preferences.provenancePrompts, width: out.width, height: out.height });
  const blob = bytesBlob(out.bytes, out.mime);
  const where = e.preferences.quickExportLocation;
  const docPath = e.session.storage.path;
  if (where === 'download' || (where === 'beside' && !docPath)) {
    download(blob, name);
    e.message(`${formatInfo[format].label} exported (${formatBytes(out.bytes.length)})`);
    void emitAppEvent('export', e.session);
    return;
  }
  const { cloudWrite, joinPath, pickCloudFolder } = await import('./cloud');
  let dir: string;
  if (where === 'beside') dir = docPath!.replace(/\/[^/]*$/, '') || '/';
  else {
    // The Puter picker never settles when dismissed: do not hold the editor busy.
    e.release();
    dir = (await pickCloudFolder()).path;
  }
  const item = await cloudWrite(joinPath(dir, name), blob, { dedupeName: true });
  e.message(`${formatInfo[format].label} exported to ${item.path} (${formatBytes(out.bytes.length)})`);
  void emitAppEvent('export', e.session);
}
export function formatBytes(n: number) {
  return n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(2)} MB`;
}

// One shared export worker; jobs are matched by ID. Falls back to the main
// thread where module workers are unavailable.
let worker: Worker | undefined;
let jobId = 0;
const pending = new Map<number, { resolve: (v: { bytes: Uint8Array; prepared?: SourceImage }) => void; reject: (e: Error) => void }>();
function exportWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('./encode.worker.ts', import.meta.url), { type: 'module', name: 'export' });
  worker.onmessage = (ev: MessageEvent<{ id: number; bytes?: Uint8Array; prepared?: SourceImage; error?: string }>) => {
    const job = pending.get(ev.data.id);
    if (!job) return;
    pending.delete(ev.data.id);
    if (ev.data.error !== undefined) job.reject(new Error(ev.data.error));
    else job.resolve({ bytes: ev.data.bytes!, prepared: ev.data.prepared });
  };
  worker.onerror = (ev) => {
    for (const job of pending.values()) job.reject(new Error(ev.message || 'The export worker failed.'));
    pending.clear();
    worker?.terminate();
    worker = undefined;
  };
  return worker;
}
/** prepareExport + encodeExport in the export worker. */
export async function encodeOffThread(src: SourceImage, s: ExportSettings, ctx: ExportContext, keepPrepared = false): Promise<{ bytes: Uint8Array; prepared?: SourceImage }> {
  let w: Worker;
  try {
    w = exportWorker();
  } catch {
    const prepared = prepareExport(src, s, ctx);
    return { bytes: await encodeExport(prepared, s, ctx), prepared };
  }
  const id = ++jobId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    w.postMessage({ id, src, settings: s, ctx, keepPrepared });
  });
}
/** Animated GIF encoding in the export worker. */
export async function encodeGifOffThread(frames: GifEncodeFrame[], options: GifEncodeOptions): Promise<Uint8Array> {
  let w: Worker;
  try {
    w = exportWorker();
  } catch {
    return encodeGif(frames, options);
  }
  const id = ++jobId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve: (v) => resolve(v.bytes), reject });
    w.postMessage({ id, gif: { frames, options } });
  });
}
