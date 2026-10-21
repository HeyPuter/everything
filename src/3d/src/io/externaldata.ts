// File ▸ External Data: list images whose pixels are missing (e.g. from imported files that
// referenced pictures on another computer), find them among files the user picks, and
// unpack the images stored in the project into a zip download.
import { app, registerOperators } from '../app/app';
import type { ImageData } from '../data/types';
import { download } from './native';
import { ZipWriter } from '../render/final/zip';

const EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/bmp': 'bmp', 'image/x-exr': 'exr', 'image/vnd.radiance': 'hdr', 'image/tiff': 'tif' };

export const baseName = (p: string) => p.split(/[\\/]/).pop()!.toLowerCase();

/** Images that should come from a file but have no pixels. */
export function missingImages(images: Record<string, ImageData>): ImageData[] {
  return Object.values(images).filter((im) => im.source === 'FILE' && !im.bytes?.length);
}

/** Pair missing images with picked files by file name (path, then data-block name). */
export function matchMissing(missing: ImageData[], files: { name: string }[]): Map<ImageData, number> {
  const byName = new Map(files.map((f, i) => [f.name.toLowerCase(), i] as const));
  const out = new Map<ImageData, number>();
  for (const im of missing) {
    const i = byName.get(baseName(im.filepath ?? '')) ?? byName.get(baseName(im.name));
    if (i !== undefined) out.set(im, i);
  }
  return out;
}

// File ▸ External Data menu: io/fileops.ts
export { externalDataMenu } from './fileops';

registerOperators([
  {
    idname: 'file.report_missing_files',
    label: 'Report Missing Files',
    description: 'List images whose files could not be loaded',
    undo: false,
    exec: (ctx) => {
      const list = missingImages(ctx.doc.images);
      if (!list.length) app.report('INFO', 'No missing files');
      for (const im of list) app.report('WARNING', `Missing image "${im.name}"${im.filepath ? ` (${im.filepath})` : ''}`);
    },
  },
  {
    idname: 'file.find_missing_files',
    label: 'Find Missing Files',
    description: 'Pick image files; missing images with the same file name are loaded from them',
    undo: false,
    poll: (ctx) => missingImages(ctx.doc.images).length > 0,
    invoke: () => {
      const input = document.createElement('input');
      input.type = 'file';
      input.multiple = true;
      input.accept = 'image/*,.exr,.hdr,.tga,.tif,.tiff';
      input.onchange = async () => {
        const files = Array.from(input.files ?? []);
        const pairs = matchMissing(missingImages(app.doc.images), files);
        let n = 0;
        for (const [im, i] of pairs) {
          const f = files[i];
          try {
            const bytes = new Uint8Array(await f.arrayBuffer());
            const mime = f.type || im.mime || 'image/png';
            const bmp = await createImageBitmap(new Blob([bytes], { type: mime }));
            Object.assign(im, { bytes, mime, width: bmp.width, height: bmp.height, revision: (im.revision ?? 0) + 1 });
            bmp.close();
            n++;
          } catch {
            app.report('WARNING', `"${f.name}" could not be read as an image`);
          }
        }
        if (n) {
          app.pushUndo('Find Missing Files');
          app.changed('doc');
        }
        app.report(n ? 'INFO' : 'WARNING', n ? `Found ${n} missing file${n === 1 ? '' : 's'}` : 'None of the picked files match a missing image');
      };
      input.click();
      return 'CANCELLED';
    },
  },
  {
    idname: 'file.unpack_all',
    label: 'Unpack Resources',
    description: 'Save the images stored in the project as files (one zip download)',
    props: [{ id: 'method', label: 'Method', type: 'enum', default: 'USE_LOCAL', items: [['USE_LOCAL', 'Use Local File'], ['WRITE_LOCAL', 'Write Local File'], ['USE_ORIGINAL', 'Use Original File'], ['WRITE_ORIGINAL', 'Write Original File']], hidden: true }],
    undo: false,
    poll: (ctx) => Object.values(ctx.doc.images).some((im) => im.bytes?.length),
    exec: (ctx) => {
      const zip = new ZipWriter();
      const used = new Set<string>();
      let n = 0;
      for (const im of Object.values(ctx.doc.images)) {
        if (!im.bytes?.length) continue;
        const ext = EXT[im.mime] ?? 'bin';
        let name = baseName(im.filepath || im.name).replace(/[^\w.\- ]/g, '_') || 'image';
        if (!/\.[a-z0-9]+$/i.test(name)) name += `.${ext}`;
        for (let i = 1; used.has(name); i++) name = name.replace(/(\.\d+)?(\.[a-z0-9]+)$/i, `.${i}$2`);
        used.add(name);
        zip.add(`textures/${name}`, im.bytes);
        n++;
      }
      const base = app.filename.replace(/\.[^.]+$/, '') || 'project';
      void new Blob(zip.finish() as BlobPart[]).arrayBuffer().then((buf) => download(new Uint8Array(buf), `${base}_resources.zip`, 'application/zip'));
      app.report('INFO', `Unpacked ${n} image${n === 1 ? '' : 's'}`);
    },
  },
]);
