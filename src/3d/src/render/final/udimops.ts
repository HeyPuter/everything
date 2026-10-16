// UDIM tile operators (image.tile_add / tile_remove / tile_fill), converting images to and from
// tiled ones, opening a set of tile files as one image and saving every tile with the <UDIM> name
// token.
import { app, registerOperators, operators, onAppReady, type OpContext } from '../../app/app';
import type { ImageData as Img, UdimTile } from '../../data/types';
import { isTiled, tileView, nextFreeTile, detectUdimSets, udimFileName, tileCanvas, encodeTilePixels, makeTiled, makeSingle, addTile, removeTile } from '../udim';

export { makeTiled, makeSingle, addTile, removeTile };
import { touchImage } from '../images';
import { view2D } from './imageops';
import { download } from './result';
import { ZipWriter } from './zip';
import { importImageFile } from '../../ops/data';
import { uid } from '../../data/defaults';
import { uniqueName } from '../../ops/object';

const shown = (ctx: OpContext): Img | null => view2D(ctx)?.shownImage() ?? null;
const tiledPoll = (ctx: OpContext) => isTiled(shown(ctx));

/** Replace tile `i` with generated content. */
export function fillTile(img: Img, i: number, opts: { width: number; height: number; color: [number, number, number, number]; generated_type: UdimTile['generated_type'] }) {
  const t = img.tiles![i];
  if (i === 0) {
    img.bytes = null;
    img.width = opts.width;
    img.height = opts.height;
    img.generated_type = opts.generated_type;
    img.generated_color = opts.color;
    img.revision = (img.revision ?? 0) + 1;
    t.width = opts.width;
    t.height = opts.height;
  } else img.tiles![i] = { ...t, bytes: null, width: opts.width, height: opts.height, generated_type: opts.generated_type, generated_color: opts.color, revision: (t.revision ?? 0) + 1 };
}

/** Store pixels into tile `i`. */
export function writeTile(img: Img, i: number, data: globalThis.ImageData) {
  const bytes = encodeTilePixels(data);
  if (i === 0) {
    img.bytes = bytes;
    img.mime = 'image/png';
    img.width = data.width;
    img.height = data.height;
    img.revision = (img.revision ?? 0) + 1;
    img.tiles![0] = { ...img.tiles![0], width: data.width, height: data.height };
  } else {
    const t = img.tiles![i];
    img.tiles![i] = { ...t, bytes, mime: 'image/png', width: data.width, height: data.height, revision: (t.revision ?? 0) + 1 };
  }
  touchImage(img);
}

/** Pixels of tile `i` (null while decoding). */
export function readTile(img: Img, i: number): globalThis.ImageData | null {
  const tc = tileCanvas(img, i);
  if (!tc.ready) return null;
  return tc.canvas.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, tc.canvas.width, tc.canvas.height);
}

const GEN: [string, string][] = [
  ['BLANK', 'Blank'],
  ['UV_GRID', 'UV Grid'],
  ['COLOR_GRID', 'Color Grid'],
];

function firstSize(img: Img) {
  const v = tileView(img, 0);
  return [v.width, v.height];
}

registerOperators([
  {
    idname: 'image.tile_add',
    label: 'Add Tile',
    description: 'Add UDIM tiles to the image',
    props: [
      { id: 'number', label: 'Number', type: 'int', default: 1002, min: 1001, max: 2000 },
      { id: 'count', label: 'Count', type: 'int', default: 1, min: 1, max: 999 },
      { id: 'label', label: 'Label', type: 'string', default: '' },
      { id: 'fill', label: 'Fill', type: 'bool', default: true },
      { id: 'color', label: 'Color', type: 'color', default: [0, 0, 0, 1], showIf: (p) => !!p.fill },
      { id: 'generated_type', label: 'Generated Type', type: 'enum', default: 'BLANK', items: GEN, showIf: (p) => !!p.fill },
      { id: 'width', label: 'Width', type: 'int', default: 1024, min: 1, max: 16384, subtype: 'pixel', showIf: (p) => !!p.fill },
      { id: 'height', label: 'Height', type: 'int', default: 1024, min: 1, max: 16384, subtype: 'pixel', showIf: (p) => !!p.fill },
    ],
    poll: tiledPoll,
    invoke: (ctx, p) => {
      // start after the last tile, with the size of the first one
      const img = shown(ctx)!;
      const [w, h] = firstSize(img);
      const props = { ...p, number: nextFreeTile(img.tiles!.map((t) => t.number), Math.max(...img.tiles!.map((t) => t.number)) + 1), width: w, height: h };
      return operators.get('image.tile_add')!.exec!(ctx, props);
    },
    exec: (ctx, p) => {
      const img = shown(ctx)!;
      const count = Math.max(1, Math.round(Number(p.count) || 1));
      let added = 0,
        last = -1;
      const [w0, h0] = firstSize(img);
      for (let k = 0; k < count; k++) {
        const n = Math.round(Number(p.number)) + k;
        const i = addTile(img, n, { label: count === 1 ? String(p.label ?? '') : '', width: p.fill ? Number(p.width) : w0, height: p.fill ? Number(p.height) : h0, color: p.fill ? (p.color as [number, number, number, number]) : [0, 0, 0, 0], generated_type: p.fill ? (p.generated_type as 'BLANK') : 'BLANK' });
        if (i >= 0) (added++, (last = i));
      }
      if (!added) {
        app.report('WARNING', 'No tile added: the numbers are taken or outside 1001–2000');
        return 'CANCELLED';
      }
      img.active_tile_index = last;
      touchImage(img);
      app.changed('doc');
    },
  },
  {
    idname: 'image.tile_remove',
    label: 'Remove Tile',
    description: 'Remove the active UDIM tile',
    poll: (ctx) => tiledPoll(ctx) && shown(ctx)!.tiles!.length > 1,
    exec: (ctx) => {
      const img = shown(ctx)!;
      if (!removeTile(img, img.active_tile_index ?? 0)) return 'CANCELLED';
      touchImage(img);
      app.changed('doc');
    },
  },
  {
    idname: 'image.tile_fill',
    label: 'Fill Tile',
    description: 'Fill the active UDIM tile with a color or pattern',
    props: [
      { id: 'color', label: 'Color', type: 'color', default: [0, 0, 0, 1] },
      { id: 'generated_type', label: 'Generated Type', type: 'enum', default: 'BLANK', items: GEN },
      { id: 'width', label: 'Width', type: 'int', default: 1024, min: 1, max: 16384, subtype: 'pixel' },
      { id: 'height', label: 'Height', type: 'int', default: 1024, min: 1, max: 16384, subtype: 'pixel' },
    ],
    poll: tiledPoll,
    invoke: (ctx, p) => {
      const img = shown(ctx)!;
      const v = tileView(img, img.active_tile_index ?? 0);
      return operators.get('image.tile_fill')!.exec!(ctx, { ...p, width: v.width, height: v.height });
    },
    exec: (ctx, p) => {
      const img = shown(ctx)!;
      fillTile(img, img.active_tile_index ?? 0, { width: Number(p.width), height: Number(p.height), color: p.color as [number, number, number, number], generated_type: p.generated_type as 'BLANK' });
      touchImage(img);
      app.changed('doc');
    },
  },
  {
    idname: 'image.open_images',
    label: 'Open Images',
    description: 'Open several image files; files named like name.1001.png, name.1002.png become one UDIM image',
    undo: false,
    invoke: () => {
      const input = document.createElement('input');
      input.type = 'file';
      input.multiple = true;
      input.accept = 'image/png,image/jpeg,image/webp,image/gif,image/bmp';
      input.onchange = () => void openImageFiles(Array.from(input.files ?? []));
      input.click();
      return 'CANCELLED';
    },
  },
]);

/** Open files: UDIM sets (two or more tiles of one pattern) become tiled images, the rest single images. */
export async function openImageFiles(files: File[]): Promise<string[]> {
  const ids: string[] = [];
  let tiled = 0;
  const sets = detectUdimSets(files.map((f) => f.name)).filter((s) => s.files.length > 1);
  const inSet = new Set(sets.flatMap((s) => s.files.map((f) => f.index)));
  for (const set of sets) {
    const tiles: { number: number; bytes: Uint8Array; mime: string; width: number; height: number }[] = [];
    for (const f of set.files) {
      const file = files[f.index];
      const bytes = new Uint8Array(await file.arrayBuffer());
      try {
        const bmp = await createImageBitmap(new Blob([bytes], { type: file.type || 'image/png' }));
        tiles.push({ number: f.number, bytes, mime: file.type || 'image/png', width: bmp.width, height: bmp.height });
        bmp.close();
      } catch {
        app.report('WARNING', `"${file.name}" could not be read as an image`);
      }
    }
    if (!tiles.length) continue;
    const doc = app.doc;
    const id = uid('im');
    const first = tiles[0];
    const name = set.pattern.replace(/[._-]?<UDIM>/, '');
    doc.images[id] = {
      id,
      name: uniqueName(doc, name, 'images'),
      mime: first.mime,
      bytes: first.bytes,
      width: first.width,
      height: first.height,
      source: 'TILED',
      colorspace: 'sRGB',
      filepath: set.pattern,
      revision: 0,
      tiles: tiles.map((t, i) => (i === 0 ? { number: t.number, width: t.width, height: t.height } : { number: t.number, bytes: t.bytes, mime: t.mime, width: t.width, height: t.height })),
      active_tile_index: 0,
    };
    ids.push(id);
    tiled++;
    app.report('INFO', `Loaded UDIM image "${doc.images[id].name}" with ${tiles.length} tiles`);
  }
  for (let i = 0; i < files.length; i++) {
    if (inSet.has(i)) continue;
    const id = await importImageFile(files[i]);
    if (id) ids.push(id);
  }
  // single images push their own undo step
  if (tiled) {
    app.pushUndo('Open Images');
    app.changed('doc');
  }
  return ids;
}

/** Encode every tile as PNG named after the image's UDIM pattern; one zip download. */
export async function saveTiles(img: Img): Promise<void> {
  const zip = new ZipWriter();
  const pattern = img.filepath?.includes('<UDIM>') ? img.filepath.replace(/^.*[\\/]/, '').replace(/\.[a-z0-9]+$/i, '.png') : `${img.name.replace(/\.[a-z0-9]+$/i, '')}.<UDIM>.png`;
  for (let i = 0; i < img.tiles!.length; i++) {
    const tc = tileCanvas(img, i);
    const blob = await new Promise<Blob | null>((res) => tc.canvas.toBlob(res, 'image/png'));
    if (blob) zip.add(udimFileName(pattern, img.tiles![i].number), new Uint8Array(await blob.arrayBuffer()));
  }
  const data = new Blob(zip.finish() as BlobPart[]);
  download(data, pattern.replace('<UDIM>', 'tiles').replace(/\.png$/, '.zip'));
  app.report('INFO', `Saved ${img.tiles!.length} tiles of "${img.name}" (${pattern})`);
}

onAppReady(() => {
  // image.new: an optional UDIM image; image.save / save_as: every tile of a UDIM image
  const nw = operators.get('image.new');
  if (nw?.exec && !nw.props?.some((p) => p.id === 'tiled')) {
    nw.props = [...(nw.props ?? []), { id: 'tiled', label: 'Tiled', type: 'bool', default: false }];
    const exec = nw.exec;
    nw.exec = (ctx, p) => {
      const before = new Set(Object.keys(ctx.doc.images));
      const r = exec(ctx, p);
      if (p.tiled) for (const id of Object.keys(ctx.doc.images)) if (!before.has(id)) makeTiled(ctx.doc.images[id]);
      return r;
    };
  }
  for (const id of ['image.save', 'image.save_as']) {
    const op = operators.get(id);
    if (!op?.exec) continue;
    const exec = op.exec;
    op.exec = (ctx, p) => {
      const img = shown(ctx);
      if (isTiled(img)) {
        void saveTiles(img);
        return;
      }
      return exec(ctx, p);
    };
  }
});
