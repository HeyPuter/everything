// Image pixels for scripts: `img.pixels` is a flat list of RGBA floats (0–1), rows from the bottom
// up, read and written through foreach_get / foreach_set, assignment or slices. Writing stores the
// image as PNG bytes (so it saves with the file and undoes like any edit). Needs the browser's
// canvas; an image that is still decoding can't be read yet.
import { app } from '../app/app';
import type { ImageData as Img } from '../data/types';
import { imageCanvas, imageReady, primeImage, touchImage } from '../render/images';
import { ID_MIXINS } from './api';
import { PropCollection, pyError, toPlain, touched } from './rna';

const imgOf = (id: string) => {
  const im = app.doc.images[id];
  if (!im) throw pyError('ReferenceError', 'Image has been removed');
  return im;
};

function canvasOrThrow(img: Img) {
  if (typeof document === 'undefined') throw pyError('RuntimeError', 'Error: image pixels need a browser canvas');
  const c = imageCanvas(img);
  if (!imageReady(img)) throw pyError('RuntimeError', `Error: image "${img.name}" is still loading; read its pixels in a later script`);
  return c;
}

function readPixels(img: Img): Float32Array {
  const c = canvasOrThrow(img);
  const w = c.width,
    h = c.height;
  const src = c.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, w, h).data;
  const out = new Float32Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const row = (h - 1 - y) * w * 4;
    for (let i = 0; i < w * 4; i++) out[y * w * 4 + i] = src[row + i] / 255;
  }
  return out;
}

function writePixels(img: Img, values: ArrayLike<number>) {
  const w = img.width,
    h = img.height;
  if (values.length !== w * h * 4) throw pyError('ValueError', `pixels: expected ${w * h * 4} values (${w}×${h} RGBA), got ${values.length}`);
  if (typeof document === 'undefined') throw pyError('RuntimeError', 'Error: image pixels need a browser canvas');
  const data = new globalThis.ImageData(w, h);
  for (let y = 0; y < h; y++) {
    const row = (h - 1 - y) * w * 4;
    for (let i = 0; i < w * 4; i++) data.data[row + i] = Math.round(Math.max(0, Math.min(1, Number(values[y * w * 4 + i]))) * 255);
  }
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  canvas.getContext('2d')!.putImageData(data, 0, 0);
  const url = canvas.toDataURL('image/png');
  const bin = atob(url.slice(url.indexOf(',') + 1));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  img.bytes = bytes;
  img.mime = 'image/png';
  if (img.source === 'GENERATED') img.source = 'FILE';
  primeImage(img, data);
  touchImage(img);
  touched();
}

/** img.pixels: a float array view (len, index, iteration, slices, foreach_get / foreach_set). */
class PixelArray extends PropCollection<number> {
  constructor(readonly imgId: string) {
    super(`bpy.data.images[${JSON.stringify(app.doc.images[imgId]?.name ?? '?')}].pixels`);
  }
  override get length() {
    const im = imgOf(this.imgId);
    return im.width * im.height * 4;
  }
  list() {
    return Array.from(readPixels(imgOf(this.imgId)));
  }
  nameOf() {
    return '';
  }
  override getItem(key: number | string) {
    if (typeof key !== 'number') throw pyError('TypeError', 'bpy_prop_array: index must be an int');
    const a = readPixels(imgOf(this.imgId));
    const k = key < 0 ? a.length + key : key;
    if (k < 0 || k >= a.length) throw pyError('IndexError', 'bpy_prop_array[index]: index out of range');
    return a[k];
  }
  setItem(i: number, v: number) {
    const a = readPixels(imgOf(this.imgId));
    a[i < 0 ? a.length + i : i] = Number(v);
    writePixels(imgOf(this.imgId), a);
  }
  /** Replaces values start…stop (Python slice assignment). */
  set_slice(start: number | null, stop: number | null, values: unknown) {
    const v = (toPlain(values) as number[]).flat() as number[];
    const total = this.length;
    const s = start ?? 0,
      e = stop ?? total;
    if (s === 0 && e >= total) return writePixels(imgOf(this.imgId), v);
    const a = readPixels(imgOf(this.imgId));
    a.set(v.slice(0, e - s), s);
    writePixels(imgOf(this.imgId), a);
  }
  /** foreach_get([buffer]) fills and returns the values (an attribute name first is accepted too). */
  foreach_get(a?: unknown, b?: unknown) {
    const seq = typeof a === 'string' ? b : a;
    const out = this.list();
    if (Array.isArray(seq)) for (let i = 0; i < out.length && i < seq.length; i++) seq[i] = out[i];
    return out;
  }
  foreach_set(a: unknown, b?: unknown) {
    const seq = typeof a === 'string' ? b : a;
    writePixels(imgOf(this.imgId), (toPlain(seq) as number[]).flat() as number[]);
  }
}

class ImagePixels {
  get pixels() {
    return new PixelArray((this as unknown as { __id: string }).__id);
  }
  set pixels(v: unknown) {
    writePixels(imgOf((this as unknown as { __id: string }).__id), (toPlain(v) as number[]).flat() as number[]);
  }
  get channels() {
    return 4;
  }
  get depth() {
    return 32;
  }
  /** Redraw users of the image (pixels written by scripts are already live). */
  update() {
    touched();
  }
  /** Resizes the image (its pixels are scaled). */
  scale(width: number, height: number) {
    const im = imgOf((this as unknown as { __id: string }).__id);
    const w = Math.max(1, Math.round(Number(width))),
      h = Math.max(1, Math.round(Number(height)));
    if (typeof document === 'undefined' || (!im.bytes && im.source === 'GENERATED')) {
      im.width = w;
      im.height = h;
      touched();
      return;
    }
    const src = canvasOrThrow(im);
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d')!;
    ctx.drawImage(src, 0, 0, w, h);
    const data = ctx.getImageData(0, 0, w, h).data;
    im.width = w;
    im.height = h;
    const flat = new Float32Array(w * h * 4);
    for (let y = 0; y < h; y++) for (let i = 0; i < w * 4; i++) flat[y * w * 4 + i] = data[(h - 1 - y) * w * 4 + i] / 255;
    writePixels(im, flat);
  }
  pack() {
    /* images are always stored in the project */
  }
  reload() {
    touched();
  }
}
(ID_MIXINS.images ??= []).push(ImagePixels);
