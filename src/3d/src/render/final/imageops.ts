// Image operators shared by the Image Editor and the UV Editor: view (frame, zoom ratios, zoom
// border, cursor), image editing (invert, flip, rotate, resize), replace/reload/save, clipboard,
// render slots, and the "Image Generic" / "Image" keymaps.
import { Euler, Matrix4, Quaternion, Vector3 } from 'three';
import { app, registerOperators, operators, type OpContext } from '../../app/app';
import { addKeys } from '../../app/keymap';
import { openPie, promptText } from '../../ui/menu';
import type { ImageData as Img } from '../../data/types';
import { imageCanvas, imageReady, primeImage, generatedPixels } from '../images';
import { uid } from '../../data/defaults';
import { uniqueName, deleteObjects } from '../../ops/object';
import { pickFile } from '../../io/native';
import { download, renderResult } from './result';
import { operatorDialog } from '../../editors/uv/dialog';

/** What the view operators need from an image-like editor. */
export interface View2D {
  el: HTMLElement;
  frameAll(fit?: boolean): void;
  zoomAt(factor: number, x?: number, y?: number): void;
  setRatio(ratio: number): void;
  zoomToRect(x0: number, y0: number, x1: number, y1: number): void;
  frameSelected?(): boolean;
  centerCursor?(): void;
  cursorToCenter?(): void;
  /** the image data-block shown (not render results) */
  shownImage(): Img | null;
  showImage(id: string | null): void;
  /** Render Result shown */
  showsRender?(): boolean;
  /** the editor's New Image / Open Image flows (shows the result) */
  newImage?(): void;
  openImage?(): void;
  draw(): void;
}

export function view2D(ctx: OpContext | { area: OpContext['area'] }): View2D | null {
  const a = ctx.area ?? app.hoverArea ?? app.activeArea;
  if (!a || (a.type !== 'IMAGE_EDITOR' && a.type !== 'UV')) return null;
  const ed = a.editor as Partial<View2D>;
  return ed && typeof ed.zoomAt === 'function' ? (ed as View2D) : null;
}

const viewPoll = (ctx: OpContext) => !!view2D(ctx);
const imagePoll = (ctx: OpContext) => !!view2D(ctx)?.shownImage();

// ---------------------------------------------------------------------------
// pixels

/** Pixels of an image keyed by its byte buffer, so edits re-run identically after undo. */
const pixelMemo = new WeakMap<object, globalThis.ImageData>();
/** Images changed since they were last saved. */
export const modifiedImages = new Set<string>();

/** Current pixels of an image (null while it is still decoding). */
export function readPixels(img: Img): globalThis.ImageData | null {
  if (img.bytes && pixelMemo.has(img.bytes)) {
    const m = pixelMemo.get(img.bytes)!;
    return new ImageData(new Uint8ClampedArray(m.data), m.width, m.height);
  }
  let data: globalThis.ImageData;
  if (!img.bytes || !img.bytes.length) {
    const c = document.createElement('canvas');
    c.width = Math.max(1, img.width);
    c.height = Math.max(1, img.height);
    const g = c.getContext('2d', { willReadFrequently: true })!;
    generatedPixels(img, g);
    data = g.getImageData(0, 0, c.width, c.height);
  } else {
    if (!imageReady(img)) return null;
    const c = imageCanvas(img);
    data = c.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, c.width, c.height);
  }
  if (img.bytes) pixelMemo.set(img.bytes, new ImageData(new Uint8ClampedArray(data.data), data.width, data.height));
  return data;
}

/** Store edited pixels in the image (encoded as PNG, synchronously). */
export function writePixels(img: Img, data: globalThis.ImageData) {
  const c = document.createElement('canvas');
  c.width = data.width;
  c.height = data.height;
  c.getContext('2d')!.putImageData(data, 0, 0);
  const url = c.toDataURL('image/png');
  const bin = atob(url.slice(url.indexOf(',') + 1));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  img.bytes = bytes;
  img.mime = 'image/png';
  img.width = data.width;
  img.height = data.height;
  if (img.source === 'GENERATED') img.source = 'FILE';
  img.revision = (img.revision ?? 0) + 1;
  pixelMemo.set(bytes, new ImageData(new Uint8ClampedArray(data.data), data.width, data.height));
  primeImage(img, data);
  modifiedImages.add(img.id);
  app.changed('doc');
}

/** Pixel transforms (pure; exported for tests). */
export function invertPixels(d: globalThis.ImageData, r: boolean, g: boolean, b: boolean, a: boolean) {
  const p = d.data;
  for (let i = 0; i < p.length; i += 4) {
    if (r) p[i] = 255 - p[i];
    if (g) p[i + 1] = 255 - p[i + 1];
    if (b) p[i + 2] = 255 - p[i + 2];
    if (a) p[i + 3] = 255 - p[i + 3];
  }
  return d;
}

export function flipPixels(d: globalThis.ImageData, x: boolean, y: boolean): globalThis.ImageData {
  const { width: w, height: h } = d;
  const out = new ImageData(w, h);
  const s = new Uint32Array(d.data.buffer),
    o = new Uint32Array(out.data.buffer);
  for (let j = 0; j < h; j++)
    for (let i = 0; i < w; i++) o[j * w + i] = s[(y ? h - 1 - j : j) * w + (x ? w - 1 - i : i)];
  return out;
}

/** Rotate clockwise by 90, 180 or 270 degrees. */
export function rotatePixels(d: globalThis.ImageData, degrees: 90 | 180 | 270): globalThis.ImageData {
  const { width: w, height: h } = d;
  if (degrees === 180) return flipPixels(d, true, true);
  const out = new ImageData(h, w);
  const s = new Uint32Array(d.data.buffer),
    o = new Uint32Array(out.data.buffer);
  // output is h wide, w high
  for (let j = 0; j < h; j++)
    for (let i = 0; i < w; i++) {
      const px = s[j * w + i];
      if (degrees === 90) o[i * h + (h - 1 - j)] = px;
      else o[(w - 1 - i) * h + j] = px;
    }
  return out;
}

export function resizePixels(d: globalThis.ImageData, w: number, h: number): globalThis.ImageData {
  const src = document.createElement('canvas');
  src.width = d.width;
  src.height = d.height;
  src.getContext('2d')!.putImageData(d, 0, 0);
  const dst = document.createElement('canvas');
  dst.width = w;
  dst.height = h;
  const g = dst.getContext('2d', { willReadFrequently: true })!;
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'high';
  g.drawImage(src, 0, 0, w, h);
  return g.getImageData(0, 0, w, h);
}

function editPixels(ctx: OpContext, fn: (d: globalThis.ImageData) => globalThis.ImageData) {
  const img = view2D(ctx)?.shownImage();
  if (!img) return 'CANCELLED' as const;
  const d = readPixels(img);
  if (!d) {
    app.report('WARNING', 'The image is still loading');
    return 'CANCELLED' as const;
  }
  writePixels(img, fn(d));
  view2D(ctx)?.draw();
  return 'FINISHED' as const;
}

// ---------------------------------------------------------------------------
// saving

function encodePNG(img: Img): Promise<Blob | null> {
  const c = imageCanvas(img);
  return new Promise((res) => c.toBlob((b) => res(b), img.mime === 'image/jpeg' ? 'image/jpeg' : img.mime === 'image/webp' ? 'image/webp' : 'image/png', 0.92));
}

function fileName(img: Img) {
  const ext = img.mime === 'image/jpeg' ? 'jpg' : img.mime === 'image/webp' ? 'webp' : 'png';
  const base = (img.filepath ?? img.name).replace(/^.*[\\/]/, '').replace(/\.[a-z0-9]+$/i, '');
  return `${base}.${ext}`;
}

async function saveImage(img: Img, name = fileName(img)) {
  const blob = await encodePNG(img);
  if (!blob) {
    app.report('ERROR', `Could not encode "${img.name}"`);
    return;
  }
  download(blob, name);
  modifiedImages.delete(img.id);
  app.report('INFO', `Saved "${name}"`);
}

/** Editors with their own save behaviour (render results with color management). */
interface SavingEditor {
  save?(): Promise<void> | void;
  saveAsDialog?(anchor?: HTMLElement): void;
  imageId?: string | null;
}

// ---------------------------------------------------------------------------
// operators

let lastShown: View2D | null = null;

function showNew(ctx: OpContext, id: string) {
  const v = view2D(ctx) ?? lastShown;
  v?.showImage(id);
}

registerOperators([
  // view
  {
    idname: 'image.view_all',
    label: 'Frame All',
    description: 'Show the whole image',
    props: [{ id: 'fit_view', label: 'Fit View', type: 'bool', default: false }],
    poll: viewPoll,
    undo: false,
    exec: (ctx, p) => void view2D(ctx)!.frameAll(!!p.fit_view),
  },
  {
    idname: 'image.view_selected',
    label: 'Frame Selected',
    description: 'Center the view on the selection',
    poll: viewPoll,
    undo: false,
    exec: (ctx) => {
      const v = view2D(ctx)!;
      if (v.frameSelected) return v.frameSelected() ? 'FINISHED' : 'CANCELLED';
      v.frameAll();
    },
  },
  {
    idname: 'image.view_zoom_in',
    label: 'Zoom In',
    poll: viewPoll,
    undo: false,
    exec: (ctx) => void view2D(ctx)!.zoomAt(1.25),
  },
  {
    idname: 'image.view_zoom_out',
    label: 'Zoom Out',
    poll: viewPoll,
    undo: false,
    exec: (ctx) => void view2D(ctx)!.zoomAt(0.8),
  },
  {
    idname: 'image.view_zoom_ratio',
    label: 'View Zoom Ratio',
    description: 'Zoom so image pixels have an exact size on screen',
    props: [{ id: 'ratio', label: 'Ratio', type: 'float', default: 1, min: 1 / 64, max: 64 }],
    poll: viewPoll,
    undo: false,
    exec: (ctx, p) => void view2D(ctx)!.setRatio(p.ratio as number),
  },
  {
    idname: 'image.view_center_cursor',
    label: 'Center View to Cursor',
    poll: (ctx) => !!view2D(ctx)?.centerCursor,
    undo: false,
    exec: (ctx) => void view2D(ctx)!.centerCursor!(),
  },
  {
    idname: 'image.view_cursor_center',
    label: 'Cursor to Center View',
    description: 'Move the 2D cursor to the center of the view',
    props: [{ id: 'fit_view', label: 'Fit View', type: 'bool', default: false }],
    poll: (ctx) => !!view2D(ctx)?.cursorToCenter,
    undo: false,
    exec: (ctx, p) => {
      const v = view2D(ctx)!;
      if (p.fit_view) v.frameAll(true);
      v.cursorToCenter!();
    },
  },
  {
    idname: 'image.view_zoom_border',
    label: 'Zoom to Border',
    description: 'Drag a rectangle to zoom into',
    poll: viewPoll,
    undo: false,
    invoke: (ctx) => {
      const v = view2D(ctx)!;
      const r = v.el.getBoundingClientRect();
      let start: { x: number; y: number } | null = null;
      const box = document.createElement('div');
      box.className = 'zoom-border-box';
      Object.assign(box.style, { position: 'absolute', border: '1px dashed #ffffff', pointerEvents: 'none', display: 'none' });
      v.el.append(box);
      app.startModal({
        label: 'Zoom to Border',
        cursor: 'crosshair',
        header: () => 'Drag a rectangle to zoom into',
        onPointerDown(e) {
          if (e.button !== 0) return 'CANCELLED';
          start = { x: e.clientX - r.left, y: e.clientY - r.top };
          return undefined;
        },
        onPointerMove(e) {
          if (!start) return;
          const x = e.clientX - r.left,
            y = e.clientY - r.top;
          Object.assign(box.style, { display: 'block', left: `${Math.min(x, start.x)}px`, top: `${Math.min(y, start.y)}px`, width: `${Math.abs(x - start.x)}px`, height: `${Math.abs(y - start.y)}px` });
        },
        onPointerUp(e) {
          if (!start) return undefined;
          const x = e.clientX - r.left,
            y = e.clientY - r.top;
          box.remove();
          if (Math.abs(x - start.x) > 3 && Math.abs(y - start.y) > 3) v.zoomToRect(Math.min(x, start.x), Math.min(y, start.y), Math.max(x, start.x), Math.max(y, start.y));
          return 'CANCELLED';
        },
        onKey(e) {
          return e.type === 'keydown' && e.key === 'Escape' ? 'CANCELLED' : true;
        },
        cancel() {
          box.remove();
        },
      });
      return 'RUNNING_MODAL';
    },
  },
  // editing pixels
  {
    idname: 'image.invert',
    label: 'Invert Channels',
    description: 'Invert the chosen channels of the image',
    props: [
      { id: 'invert_r', label: 'Red', type: 'bool', default: false },
      { id: 'invert_g', label: 'Green', type: 'bool', default: false },
      { id: 'invert_b', label: 'Blue', type: 'bool', default: false },
      { id: 'invert_a', label: 'Alpha', type: 'bool', default: false },
    ],
    poll: imagePoll,
    exec: (ctx, p) => {
      if (!p.invert_r && !p.invert_g && !p.invert_b && !p.invert_a) return 'CANCELLED';
      return editPixels(ctx, (d) => invertPixels(d, !!p.invert_r, !!p.invert_g, !!p.invert_b, !!p.invert_a));
    },
  },
  {
    idname: 'image.flip',
    label: 'Flip Image',
    description: 'Mirror the image horizontally and/or vertically',
    props: [
      { id: 'use_flip_x', label: 'Horizontal', type: 'bool', default: false },
      { id: 'use_flip_y', label: 'Vertical', type: 'bool', default: false },
    ],
    poll: imagePoll,
    exec: (ctx, p) => {
      if (!p.use_flip_x && !p.use_flip_y) return 'CANCELLED';
      return editPixels(ctx, (d) => flipPixels(d, !!p.use_flip_x, !!p.use_flip_y));
    },
  },
  {
    idname: 'image.rotate_orthogonal',
    label: 'Rotate Image Orthogonal',
    description: 'Rotate the image by a multiple of 90 degrees (clockwise)',
    props: [{ id: 'degrees', label: 'Degrees', type: 'enum', default: '90', items: [['90', '90 Degrees'], ['180', '180 Degrees'], ['270', '270 Degrees']] }],
    poll: imagePoll,
    exec: (ctx, p) => editPixels(ctx, (d) => rotatePixels(d, Number(p.degrees) as 90)),
  },
  {
    idname: 'image.resize',
    label: 'Resize Image',
    description: 'Scale the image to a new size in pixels',
    props: [{ id: 'size', label: 'Size', type: 'vec2', default: [0, 0], subtype: 'pixel' }],
    poll: imagePoll,
    invoke: (ctx) => {
      const img = view2D(ctx)!.shownImage()!;
      operatorDialog('image.resize', { title: 'Resize Image', props: { size: [img.width, img.height] }, area: ctx.area });
      return 'CANCELLED';
    },
    exec: (ctx, p) => {
      const [w, h] = (p.size as number[]).map((x) => Math.round(x));
      if (!(w >= 1 && h >= 1 && w <= 16384 && h <= 16384)) return 'CANCELLED';
      return editPixels(ctx, (d) => (d.width === w && d.height === h ? d : resizePixels(d, w, h)));
    },
  },
  // files
  {
    idname: 'image.reload',
    label: 'Reload Image',
    description: 'Show the stored image again, dropping unsaved changes in the display',
    poll: imagePoll,
    undo: false,
    exec: (ctx) => {
      const img = view2D(ctx)!.shownImage()!;
      if (img.source === 'GENERATED') {
        const c = imageCanvas(img);
        const g = c.getContext('2d')!;
        g.clearRect(0, 0, c.width, c.height);
        generatedPixels(img, g);
      }
      img.revision = (img.revision ?? 0) + 1;
      app.changed('doc');
      view2D(ctx)!.draw();
      app.report('INFO', `Reloaded image "${img.name}"`);
    },
  },
  {
    idname: 'image.replace',
    label: 'Replace Image',
    description: 'Replace the pixels of the image with another file, keeping everything that uses it',
    poll: imagePoll,
    undo: false,
    invoke: (ctx) => {
      const img = view2D(ctx)!.shownImage()!;
      void pickFile('image/*').then(async (file) => {
        if (!file) return;
        const bytes = new Uint8Array(await file.arrayBuffer());
        try {
          const bmp = await createImageBitmap(new Blob([bytes], { type: file.type || 'image/png' }));
          const live = app.doc.images[img.id];
          if (!live) return;
          live.bytes = bytes;
          live.mime = file.type || 'image/png';
          live.width = bmp.width;
          live.height = bmp.height;
          live.source = 'FILE';
          live.filepath = file.name;
          live.revision = (live.revision ?? 0) + 1;
          bmp.close();
          app.pushUndo('Replace Image');
          app.changed('doc');
          app.report('INFO', `Replaced "${live.name}" with "${file.name}"`);
        } catch {
          app.report('ERROR', `Unsupported image format: ${file.name}`);
        }
      });
      return 'CANCELLED';
    },
  },
  {
    idname: 'image.save',
    label: 'Save Image',
    description: 'Download the image',
    poll: (ctx) => imagePoll(ctx) || !!view2D(ctx)?.showsRender?.(),
    undo: false,
    exec: (ctx) => {
      const v = view2D(ctx)!;
      const ed = v as unknown as SavingEditor;
      if (ed.save) void ed.save();
      else void saveImage(v.shownImage()!);
    },
  },
  {
    idname: 'image.save_as',
    label: 'Save As Image',
    description: 'Download the image under a new name or format',
    props: [{ id: 'copy', label: 'Copy', type: 'bool', default: false }],
    poll: (ctx) => imagePoll(ctx) || !!view2D(ctx)?.showsRender?.(),
    undo: false,
    exec: (ctx) => {
      const v = view2D(ctx)!;
      const ed = v as unknown as SavingEditor;
      if (ed.saveAsDialog) return void ed.saveAsDialog();
      const img = v.shownImage()!;
      promptText('Save As Image', fileName(img), (name) => name && void saveImage(img, name));
    },
  },
  {
    idname: 'image.save_all_modified',
    label: 'Save All Images',
    description: 'Download every image changed since it was last saved',
    undo: false,
    exec: () => {
      const imgs = [...modifiedImages].map((id) => app.doc.images[id]).filter(Boolean);
      if (!imgs.length) {
        app.report('INFO', 'No images have unsaved changes');
        return 'CANCELLED';
      }
      for (const img of imgs) void saveImage(img);
    },
  },
  {
    idname: 'image.clipboard_copy',
    label: 'Copy Image',
    description: 'Copy the image to the system clipboard',
    poll: imagePoll,
    undo: false,
    exec: (ctx) => {
      const img = view2D(ctx)!.shownImage()!;
      const c = imageCanvas(img);
      c.toBlob(async (b) => {
        if (!b) return;
        try {
          await navigator.clipboard.write([new ClipboardItem({ 'image/png': b })]);
          app.report('INFO', `Copied "${img.name}"`);
        } catch (e) {
          app.report('ERROR', `Could not copy the image: ${e instanceof Error ? e.message : String(e)}`);
        }
      }, 'image/png');
    },
  },
  {
    idname: 'image.clipboard_paste',
    label: 'Paste Image',
    description: 'Create an image from the system clipboard',
    undo: false,
    exec: (ctx) => {
      lastShown = view2D(ctx);
      void (async () => {
        try {
          const items = await navigator.clipboard.read();
          for (const it of items) {
            const type = it.types.find((t) => t.startsWith('image/'));
            if (!type) continue;
            const blob = await it.getType(type);
            const bytes = new Uint8Array(await blob.arrayBuffer());
            const bmp = await createImageBitmap(blob);
            const id = uid('im');
            app.doc.images[id] = { id, name: uniqueName(app.doc, 'Clipboard', 'images'), mime: type, bytes, width: bmp.width, height: bmp.height, source: 'FILE', colorspace: 'sRGB', revision: 0 };
            bmp.close();
            app.pushUndo('Paste Image');
            showNew(ctx, id);
            app.changed('doc');
            return;
          }
          app.report('WARNING', 'The clipboard holds no image');
        } catch (e) {
          app.report('ERROR', `Could not read the clipboard: ${e instanceof Error ? e.message : String(e)}`);
        }
      })();
    },
  },
  // render slots
  {
    idname: 'image.cycle_render_slot',
    label: 'Cycle Render Slot',
    description: 'Show the next render slot that holds a render',
    props: [{ id: 'reverse', label: 'Cycle in Reverse', type: 'bool', default: false }],
    poll: (ctx) => !!view2D(ctx)?.showsRender?.(),
    undo: false,
    exec: (_ctx, p) => {
      const next = renderResult.cycle(!!p.reverse);
      if (next === renderResult.slot) return 'CANCELLED';
      renderResult.setSlot(next);
      app.changed('ui');
    },
  },
  {
    idname: 'image.clear_render_slot',
    label: 'Clear Render Slot',
    description: 'Remove the render in the current slot',
    poll: (ctx) => !!view2D(ctx)?.showsRender?.() && !!renderResult.get(),
    undo: false,
    exec: () => {
      renderResult.clearSlot();
      app.changed('ui');
    },
  },
]);

/** Set the render slot shown (keys 1–9 over a Render Result). */
function setSlot(i: number) {
  renderResult.setSlot(i);
  app.changed('ui');
}

const overView = () => !!view2D({ area: app.hoverArea ?? app.activeArea });
const overRender = () => !!view2D({ area: app.hoverArea ?? app.activeArea })?.showsRender?.();
const overImageEditor = () => (app.hoverArea ?? app.activeArea)?.type === 'IMAGE_EDITOR';

const hovered = () => view2D({ area: app.hoverArea ?? app.activeArea });

function viewPie() {
  const v = hovered();
  if (!v) return;
  openPie(
    'View',
    [
      { label: 'Frame All', op: 'image.view_all', props: { fit_view: false } },
      { label: 'Frame All Fit', op: 'image.view_all', props: { fit_view: true } },
      { label: 'Zoom 1:1', op: 'image.view_zoom_ratio', props: { ratio: 1 } },
      { label: 'Frame Selected', op: 'image.view_selected' },
      v.centerCursor ? { label: 'Center View to Cursor', op: 'image.view_center_cursor' } : null,
      null,
      null,
      null,
    ],
    app.pointer.x,
    app.pointer.y,
    'ACCENT_GRAVE',
  );
}

addKeys('Image Generic', [
  { key: 'ACCENT_GRAVE', action: viewPie, when: overView },
  { key: 'N', alt: true, action: () => (hovered()?.newImage ? hovered()!.newImage!() : void app.run('image.new')), when: overView },
  { key: 'O', alt: true, action: () => (hovered()?.openImage ? hovered()!.openImage!() : void app.run('image.open')), when: overView },
  { key: 'R', alt: true, op: 'image.reload', when: overView },
  { key: 'S', alt: true, op: 'image.save', when: overView },
  { key: 'S', shift: true, alt: true, op: 'image.save_as', when: overView },
  { key: 'J', op: 'image.cycle_render_slot', when: overRender },
  { key: 'J', alt: true, op: 'image.cycle_render_slot', props: { reverse: true }, when: overRender },
]);

addKeys('Image', [
  { key: 'HOME', op: 'image.view_all', when: overView },
  { key: 'HOME', shift: true, op: 'image.view_all', props: { fit_view: true }, when: overView },
  { key: 'NUMPAD_PERIOD', op: 'image.view_selected', when: overView },
  { key: 'C', shift: true, op: 'image.view_cursor_center', when: overView },
  { key: 'NUMPAD_PLUS', op: 'image.view_zoom_in', when: overView },
  { key: 'NUMPAD_MINUS', op: 'image.view_zoom_out', when: overView },
  { key: 'EQUAL', op: 'image.view_zoom_in', when: overView },
  { key: 'MINUS', op: 'image.view_zoom_out', when: overView },
  { key: 'B', shift: true, op: 'image.view_zoom_border', when: overView },
  ...([1, 2, 4, 8] as const).flatMap((n) => [
    { key: `NUMPAD_${n}`, op: 'image.view_zoom_ratio', props: { ratio: 1 / n }, when: overView },
    { key: `NUMPAD_${n}`, ctrl: true, op: 'image.view_zoom_ratio', props: { ratio: n }, when: overView },
    { key: `NUMPAD_${n}`, shift: true, op: 'image.view_zoom_ratio', props: { ratio: n }, when: overView },
  ]),
  ...['ONE', 'TWO', 'THREE', 'FOUR', 'FIVE', 'SIX', 'SEVEN', 'EIGHT'].map((key, i) => ({ key, action: () => setSlot(i), when: () => overRender() && overImageEditor() })),
]);

// ---------------------------------------------------------------------------
// image empties → mesh planes

registerOperators([
  {
    idname: 'image.convert_to_mesh_plane',
    label: 'Convert Image Empty to Mesh Plane',
    description: 'Replace the selected image empties with textured mesh planes in the same place',
    props: [
      { id: 'shader', label: 'Shader', type: 'enum', default: 'PRINCIPLED', items: [['PRINCIPLED', 'Principled'], ['SHADELESS', 'Shadeless'], ['EMISSION', 'Emit']] },
      { id: 'name_from', label: 'Name After', type: 'enum', default: 'OBJECT', items: [['OBJECT', 'Source Object'], ['IMAGE', 'Source Image']] },
      { id: 'delete_ref', label: 'Delete Reference Object', type: 'bool', default: true },
    ],
    poll: (ctx) => ctx.doc.mode === 'OBJECT' && imageEmpties().length > 0,
    exec: (ctx, p) => {
      const doc = ctx.doc;
      const importOp = operators.get('image.import_as_mesh_planes');
      if (!importOp?.exec) return 'CANCELLED';
      const empties = imageEmpties();
      const made: string[] = [];
      for (const em of empties) {
        const img = doc.images[em.data!];
        const size = em.empty_display_size ?? 1;
        const big = Math.max(img.width, img.height, 1);
        const w = (size * img.width) / big,
          h = (size * img.height) / big;
        const world = app.graph.get(em.id)?.world?.clone() ?? new Matrix4().compose(new Vector3(...em.location), new Quaternion().setFromEuler(new Euler(...em.rotation_euler, 'XYZ')), new Vector3(...em.scale));
        const off = em.empty_image_offset ?? [-0.5, -0.5];
        world.multiply(new Matrix4().makeTranslation((off[0] + 0.5) * w, (off[1] + 0.5) * h, 0));
        const before = new Set(Object.keys(doc.objects));
        importOp.exec(ctx, { image: img.id, height: h, shader: p.shader, align_view: false });
        const ob = Object.values(doc.objects).find((o) => !before.has(o.id));
        if (!ob) continue;
        const pos = new Vector3(),
          q = new Quaternion(),
          sc = new Vector3();
        world.decompose(pos, q, sc);
        const e = new Euler().setFromQuaternion(q, 'XYZ');
        ob.location = [pos.x, pos.y, pos.z];
        ob.rotation_mode = 'XYZ';
        ob.rotation_euler = [e.x, e.y, e.z];
        ob.scale = [sc.x, sc.y, sc.z];
        ob.name = uniqueName(doc, p.name_from === 'IMAGE' ? img.name.replace(/\.[a-z0-9]+$/i, '') : em.name);
        made.push(ob.id);
      }
      if (!made.length) return 'CANCELLED';
      if (p.delete_ref) deleteObjects(doc, new Set(empties.map((o) => o.id)));
      for (const o of Object.values(doc.objects)) o.select = made.includes(o.id);
      doc.scene.active_object = made[made.length - 1];
      app.changed('doc', 'select');
    },
  },
]);

function imageEmpties() {
  return app.doc.object_order.map((id) => app.doc.objects[id]).filter((o) => o?.select).filter((o) => o.type === 'EMPTY' && o.empty_display_type === 'IMAGE' && !!o.data && !!app.doc.images[o.data]);
}
