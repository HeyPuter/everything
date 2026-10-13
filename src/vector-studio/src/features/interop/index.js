/**
 * File format interoperability: opening and placing PDF (including
 * PDF-compatible .ai files), EPS/PostScript, DXF, TIFF, BMP and PSD files,
 * and exporting EPS, TIFF and DXF.
 *
 * Only the format detection and the hooks load with the app; the parsers,
 * writers and dialogs load on first use (lazy.js).
 *
 * Interfaces:
 *   app.importers.detect(name, headBytes) -> 'pdf'|'eps'|'dxf'|'raster'|null
 *   app.importers.open(bytes, { name, format }) -> Promise<VDocument|null>
 *   app.importers.openExtensions / openTypes  (File > Open pickers)
 *   io hooks: fileImporters.pdf|eps|dxf (Place, drag and drop, paste),
 *             imageDecoders (TIFF/BMP/PSD), exportFormats eps|tiff|dxf
 */
import { fileImporters, imageDecoders, exportFormats } from '../io/hooks.js';
import './styles.css';

let loading = null;
export function loadInterop() {
  if (!loading) {
    loading = import('./lazy.js');
    loading.catch(() => {
      loading = null;
    });
  }
  return loading;
}

const startsWith = (b, s) => [...s].every((c, i) => b[i] === c.charCodeAt(0));

/** The import format for a file name and its first bytes, or null. */
export function detectFormat(name, head) {
  const ext = (/\.([^./\\]+)$/.exec(String(name || '').toLowerCase()) || [])[1] || '';
  if (head && head.length >= 4) {
    // %PDF anywhere in the first KB (some writers put a header before it).
    for (let i = 0; i + 4 < Math.min(head.length, 1024); i++) if (head[i] === 0x25 && head[i + 1] === 0x50 && head[i + 2] === 0x44 && head[i + 3] === 0x46) return 'pdf';
    if (head[0] === 0xc5 && head[1] === 0xd0 && head[2] === 0xd3 && head[3] === 0xc6) return 'eps';
    if (startsWith(head, '%!')) return 'eps';
    if ((head[0] === 0x49 && head[1] === 0x49 && head[2] === 42) || (head[0] === 0x4d && head[1] === 0x4d && head[3] === 42)) return 'raster';
    if (startsWith(head, '8BPS')) return 'raster';
    if (startsWith(head, 'BM') && ['bmp', 'dib'].includes(ext)) return 'raster';
    if (head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) return 'raster';
    if (head[0] === 0xff && head[1] === 0xd8) return 'raster';
    if (startsWith(head, 'GIF8')) return 'raster';
    if (startsWith(head, 'RIFF') && head[8] === 0x57 && head[9] === 0x45) return 'raster';
    if (ext === 'dxf' || /^\s*(0|999)\s*\r?\n/.test(new TextDecoder().decode(head.subarray(0, 32)))) {
      const text = new TextDecoder().decode(head.subarray(0, 512));
      if (/SECTION/.test(text) || ext === 'dxf') return 'dxf';
    }
  }
  if (ext === 'pdf' || ext === 'ai') return 'pdf';
  if (ext === 'eps' || ext === 'epsf' || ext === 'ps') return 'eps';
  if (ext === 'dxf') return 'dxf';
  if (['tif', 'tiff', 'bmp', 'dib', 'psd', 'psb'].includes(ext)) return 'raster';
  return null;
}

const OPEN_EXTENSIONS = ['.pdf', '.ai', '.eps', '.epsf', '.ps', '.dxf', '.tif', '.tiff', '.bmp', '.psd', '.png', '.jpg', '.jpeg', '.webp', '.gif'];
const OPEN_TYPES = [
  { description: 'PDF, EPS and DXF files', accept: { 'application/pdf': ['.pdf', '.ai'], 'application/postscript': ['.eps', '.epsf', '.ps'], 'application/dxf': ['.dxf'] } },
  { description: 'Images', accept: { 'image/*': ['.tif', '.tiff', '.bmp', '.psd', '.png', '.jpg', '.jpeg', '.webp', '.gif'] } },
];

export function install(app) {
  for (const kind of ['pdf', 'eps', 'dxf']) {
    fileImporters[kind] = { place: async (a, editor, file, opts) => (await loadInterop()).placeForeign(app, editor, file, kind, opts) };
  }
  imageDecoders.push(async (bytes) => {
    const tiff = (bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 42) || (bytes[0] === 0x4d && bytes[1] === 0x4d && bytes[3] === 42);
    const psd = startsWith(bytes, '8BPS');
    const bmp = startsWith(bytes, 'BM');
    if (!tiff && !psd && !bmp) return null;
    return (await loadInterop()).rasterToPNG(bytes);
  });
  app.importers = {
    ...(app.importers || {}),
    detect: detectFormat,
    open: async (bytes, opts) => (await loadInterop()).openForeign(app, bytes, opts),
    report: async (warnings) => (await loadInterop()).report(app, warnings),
    openExtensions: OPEN_EXTENSIONS,
    openTypes: OPEN_TYPES,
  };
  const render = (key) => async (a, editor, region, options) => (await loadInterop()).renderExport(app, key, editor, region, options);
  const options = (key) => async (a, prefs, ui) => (await loadInterop()).exportOptions(app, key, prefs, ui);
  exportFormats.set('eps', { label: 'EPS (eps)', title: 'EPS', ext: 'eps', mime: 'application/postscript', defaults: { level: 3, colorMode: 'rgb', preview: 'tiff', textOutlines: true }, options: options('eps'), render: render('eps') });
  exportFormats.set('tiff', { label: 'TIFF (tif)', title: 'TIFF', ext: 'tif', mime: 'image/tiff', defaults: { ppi: 300, mode: 'rgb', compression: 'lzw', byteOrder: 'II', antialias: true, alpha: false }, options: options('tiff'), render: render('tiff') });
  exportFormats.set('dxf', { label: 'DXF (dxf)', title: 'DXF', ext: 'dxf', mime: 'application/dxf', defaults: { version: 'R2000', unit: 'mm', curves: 'splines', fills: true, textOutlines: false }, options: options('dxf'), render: render('dxf') });
}
