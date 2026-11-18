// File → File Info (editable document metadata) and File → Print.
import type { Editor } from '../../editor';
import { allLayers, type DocumentInfo } from '../../model/document';
import { escapeXML } from '../../model/assets';
import { modal, fieldValue } from './ui';
import { documentSource, exportContext } from './pipeline';
import type { ExportContext, SourceImage } from './encode';
import { convertToSrgb } from './color';
import { encodePng, rgba16To8 } from './png';

const infoFields: { key: keyof DocumentInfo; label: string; multiline?: boolean; hint?: string }[] = [
  { key: 'title', label: 'Document title' },
  { key: 'author', label: 'Author' },
  { key: 'copyright', label: 'Copyright notice', hint: '© 2026 Your Name' },
  { key: 'contact', label: 'Contact (email or website)' },
  { key: 'keywords', label: 'Keywords', hint: 'Separated by commas' },
  { key: 'description', label: 'Description', multiline: true },
];

/** Keep only non-empty, bounded strings. */
export function cleanInfo(values: Partial<Record<keyof DocumentInfo, string>>): DocumentInfo | undefined {
  const out: DocumentInfo = {};
  for (const { key } of infoFields) {
    const v = (values[key] ?? '').replace(/\u0000/g, '').trim().slice(0, key === 'description' ? 4000 : 400);
    if (v) out[key] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

export async function fileInfo(e: Editor) {
  const d = e.doc;
  const info = d.info ?? {};
  const r = d.resolution;
  const ppi = r ? (r.horizontalResolutionUnit === 'PPCM' ? r.horizontalResolution * 2.54 : r.horizontalResolution) : 72;
  const fields = infoFields
    .map((f) => {
      const v = escapeXML(info[f.key] ?? '');
      const control = f.multiline
        ? `<textarea name="${f.key}" rows="4">${v}</textarea>`
        : `<input name="${f.key}" type="text" value="${v}" ${f.hint ? `placeholder="${escapeXML(f.hint)}"` : ''}>`;
      return `<label class="dialog-field">${f.label}${control}</label>`;
    })
    .join('');
  const facts = `<div class="property-grid files-facts"><span>File</span><strong>${escapeXML(e.session.fileName ?? 'Not saved')}</strong><span>Location</span><strong>${escapeXML(e.storage.path ?? '—')}</strong><span>Dimensions</span><strong>${d.width} × ${d.height} px</strong><span>Resolution</span><strong>${Math.round(ppi * 100) / 100} px/in</strong><span>Print size</span><strong>${(d.width / ppi).toFixed(2)} × ${(d.height / ppi).toFixed(2)} in</strong><span>Bit depth</span><strong>${d.bitsPerChannel ?? 8} bits/channel</strong><span>Color profile</span><strong>${d.iccProfile && !d.iccUntaggedProfile ? 'Embedded ICC profile' : d.bitsPerChannel === 32 ? 'Linear sRGB' : 'sRGB'}</strong><span>Layers</span><strong>${allLayers(d.layers).length}</strong></div>`;
  const result = await modal({
    title: 'File Info',
    className: 'files-info-dialog',
    submit: 'OK',
    body: `<p>Title, author and copyright are written to exported PNG and JPEG files when metadata is included.</p>${fields}${facts}`,
  });
  if (!result) return;
  const values: Partial<Record<keyof DocumentInfo, string>> = {};
  for (const f of infoFields) values[f.key] = fieldValue(result.form, f.key);
  result.close();
  const next = cleanInfo(values);
  if (JSON.stringify(next ?? null) === JSON.stringify(d.info ?? null)) return;
  e.command('File Info', (doc) => {
    if (next) doc.info = next;
    else delete doc.info;
  });
}

/** The composite as 8-bit sRGB for printing. Colors are converted before the
 * samples are reduced to 8 bits: reducing linear (32-bit) samples first bands
 * the shadows. */
export function printPixels(src: SourceImage, ctx: ExportContext): Uint8ClampedArray {
  const data = src.data.slice();
  if (ctx.profile) convertToSrgb(data, ctx.profile);
  return data instanceof Uint16Array ? rgba16To8(data) : data;
}

/** Print the flattened image at its document resolution. */
export async function printImage(e: Editor) {
  const doc = e.doc;
  const src = await documentSource(e, doc);
  const ctx = exportContext(doc);
  const data = printPixels(src, ctx);
  const png = encodePng({ width: src.width, height: src.height, data, channels: 4 }, { level: 1 });
  const url = URL.createObjectURL(new Blob([png as Uint8Array<ArrayBuffer>], { type: 'image/png' }));
  const ppi = ctx.dpi && ctx.dpi > 0 ? ctx.dpi : 72;
  const w = doc.width / ppi,
    h = doc.height / ppi;
  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden';
  const title = escapeXML(doc.info?.title || doc.name);
  // Physical size from the resolution; images larger than the page shrink to fit.
  frame.srcdoc = `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>@page{margin:0.5in}html,body{margin:0;padding:0;background:#fff}img{display:block;margin:0 auto;width:${w}in;height:${h}in;max-width:100%;max-height:100vh;object-fit:contain}</style></head><body><img src="${url}" alt="${title}"></body></html>`;
  document.body.append(frame);
  await new Promise<void>((resolve) => frame.addEventListener('load', () => resolve(), { once: true }));
  const img = frame.contentDocument!.querySelector('img')!;
  await img.decode().catch(() => undefined);
  const cleanup = () => {
    frame.remove();
    URL.revokeObjectURL(url);
  };
  frame.contentWindow!.addEventListener('afterprint', () => setTimeout(cleanup, 0), { once: true });
  setTimeout(cleanup, 10 * 60_000);
  frame.contentWindow!.focus();
  frame.contentWindow!.print();
  e.message(`Printing at ${Math.round(ppi)} ppi (${w.toFixed(2)} × ${h.toFixed(2)} in)`);
}
