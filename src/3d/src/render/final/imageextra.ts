// More Image Editor operators: view pan / zoom by values, frame change, the cached render, picking
// a new file for an image, and editing an image in another application (written to a file the
// user picks, then reloaded whenever that file changes).
import { app, registerOperators, type OpContext } from '../../app/app';
import { addKeys } from '../../app/keymap';
import { pickFile } from '../../io/native';
import { imageCanvas } from '../images';
import type { ImageData as Img } from '../../data/types';
import { view2D } from './imageops';
import { renderResult } from './result';

/** Editors that can pan by screen pixels (image and UV editors). */
interface Pannable {
  panBy(dx: number, dy: number): void;
}
const pannable = (ctx: OpContext) => {
  const v = view2D(ctx) as unknown as Partial<Pannable> | null;
  return v && typeof v.panBy === 'function' ? (v as Pannable) : null;
};
const shownImage = (ctx: OpContext) => view2D(ctx)?.shownImage() ?? null;

/** Replace an image's pixels with an encoded file, keeping its users. */
export async function loadIntoImage(img: Img, bytes: Uint8Array, mime: string, name?: string): Promise<boolean> {
  try {
    const bmp = await createImageBitmap(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mime || 'image/png' }));
    const live = app.doc.images[img.id];
    if (!live) return false;
    live.bytes = bytes;
    live.mime = mime || 'image/png';
    live.width = bmp.width;
    live.height = bmp.height;
    live.source = 'FILE';
    if (name) live.filepath = name;
    live.revision = (live.revision ?? 0) + 1;
    bmp.close();
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// external editing: the image is written to a file; while the project is open, saving that file in
// another application brings the new pixels back

interface FileHandleLike {
  name: string;
  getFile(): Promise<File>;
  createWritable(): Promise<{ write(data: Blob): Promise<void>; close(): Promise<void> }>;
}
type SavePicker = (opts: { suggestedName: string; types: { description: string; accept: Record<string, string[]> }[] }) => Promise<FileHandleLike>;

const watched = new Map<string, { handle: FileHandleLike; last: number; timer: number }>();

/** Images being edited externally (id → file name). */
export function externalEdits(): Map<string, string> {
  return new Map([...watched].map(([id, w]) => [id, w.handle.name]));
}

function stopWatching(id: string) {
  const w = watched.get(id);
  if (w) clearInterval(w.timer);
  watched.delete(id);
}

function watch(img: Img, handle: FileHandleLike, last: number) {
  stopWatching(img.id);
  const entry = { handle, last, timer: 0 };
  let busy = false;
  entry.timer = window.setInterval(async () => {
    if (busy) return;
    const live = app.doc.images[img.id];
    if (!live) return stopWatching(img.id);
    busy = true;
    try {
      const f = await handle.getFile();
      if (f.lastModified > entry.last) {
        entry.last = f.lastModified;
        if (await loadIntoImage(live, new Uint8Array(await f.arrayBuffer()), f.type || 'image/png', handle.name)) {
          app.pushUndo('Reload Edited Image');
          app.changed('doc');
          app.report('INFO', `Reloaded "${live.name}" (changed in ${handle.name})`);
        }
      }
    } catch {
      // the file went away or permission was revoked: stop following it
      stopWatching(img.id);
    } finally {
      busy = false;
    }
  }, 1000);
  watched.set(img.id, entry);
}

const pngBlob = (img: Img) => new Promise<Blob | null>((res) => imageCanvas(img).toBlob((b) => res(b), 'image/png'));

registerOperators([
  {
    idname: 'image.view_pan',
    label: 'Pan View',
    description: 'Move the view of the image by an offset in screen pixels',
    props: [{ id: 'offset', label: 'Offset', type: 'vec2', default: [0, 0] }],
    poll: (ctx) => !!pannable(ctx),
    undo: false,
    exec: (ctx, p) => {
      const [dx, dy] = (p.offset as number[]) ?? [0, 0];
      pannable(ctx)!.panBy(Number(dx) || 0, Number(dy) || 0);
    },
  },
  {
    idname: 'image.view_zoom',
    label: 'Zoom View',
    description: 'Zoom the image view by a factor (around the pointer when Zoom to Mouse Position is on)',
    props: [
      { id: 'factor', label: 'Factor', type: 'float', default: 0, min: -Infinity, precision: 3 },
      { id: 'use_cursor_init', label: 'Use Mouse Position', type: 'bool', default: true },
    ],
    poll: (ctx) => !!view2D(ctx),
    undo: false,
    exec: (ctx, p) => {
      const v = view2D(ctx)!;
      const f = Number(p.factor) || 0;
      if (!f) return 'CANCELLED';
      if (p.use_cursor_init && ctx.event) {
        const r = v.el.getBoundingClientRect();
        v.zoomAt(f, ctx.event.x - r.left, ctx.event.y - r.top);
      } else v.zoomAt(f);
    },
  },
  {
    idname: 'image.change_frame',
    label: 'Change Frame',
    description: 'Go to a frame of the scene from the image editor',
    props: [{ id: 'frame', label: 'Frame', type: 'int', default: 0 }],
    poll: (ctx) => ctx.area?.type === 'IMAGE_EDITOR',
    undo: false,
    exec: (_c, p) => {
      app.setFrame(Math.round(Number(p.frame) || 0));
    },
  },
  {
    idname: 'image.read_viewlayers',
    label: 'Open Cached Render',
    description: 'Show the last render (kept in memory) in the image editor',
    poll: (ctx) => ctx.area?.type === 'IMAGE_EDITOR',
    undo: false,
    exec: (ctx) => {
      if (!renderResult.get()) {
        app.report('WARNING', 'No render in memory yet: render with F12 first');
        return 'CANCELLED';
      }
      (ctx.area!.editor as { showRenderResult(): void }).showRenderResult();
    },
  },
  {
    idname: 'image.file_browse',
    label: 'Browse Image',
    description: 'Pick another file for the image; everything using the image shows the new pixels',
    props: [{ id: 'filepath', label: 'File Path', type: 'string', default: '' }],
    poll: (ctx) => !!shownImage(ctx) && shownImage(ctx)!.source !== 'TILED',
    undo: false,
    invoke: (ctx) => {
      const img = shownImage(ctx)!;
      void pickFile('image/*').then(async (file) => {
        if (!file) return;
        if (!(await loadIntoImage(img, new Uint8Array(await file.arrayBuffer()), file.type, file.name))) return void app.report('ERROR', `Unsupported image format: ${file.name}`);
        app.pushUndo('Browse Image');
        app.changed('doc');
      });
      return 'CANCELLED';
    },
  },
  {
    idname: 'image.external_edit',
    label: 'Image Edit Externally',
    description: 'Write the image to a file to open in another application; saving the file there updates the image here',
    props: [{ id: 'filepath', label: 'File Path', type: 'string', default: '' }],
    poll: (ctx) => !!shownImage(ctx) && shownImage(ctx)!.source !== 'TILED',
    undo: false,
    invoke: (ctx) => {
      const img = shownImage(ctx)!;
      const picker = (window as unknown as { showSaveFilePicker?: SavePicker }).showSaveFilePicker;
      if (!picker) {
        app.report('ERROR', 'This browser cannot follow files on disk: save the image (Alt S), edit it, then use Image ▸ Replace');
        return 'CANCELLED';
      }
      const base = (img.filepath?.split(/[\\/]/).pop() ?? img.name).replace(/\.[a-z0-9]+$/i, '');
      void (async () => {
        let handle: FileHandleLike;
        try {
          handle = await picker({ suggestedName: `${base}.png`, types: [{ description: 'PNG image', accept: { 'image/png': ['.png'] } }] });
        } catch {
          return; // cancelled
        }
        try {
          const blob = await pngBlob(img);
          if (!blob) throw new Error('encode');
          const w = await handle.createWritable();
          await w.write(blob);
          await w.close();
          const f = await handle.getFile();
          watch(img, handle, f.lastModified);
          app.report('INFO', `Wrote ${handle.name}: open it in your image editor; saving it there updates "${img.name}"`);
        } catch {
          app.report('ERROR', `Could not write ${handle.name}`);
        }
      })();
      return 'CANCELLED';
    },
  },
]);

addKeys('Image Generic', [{ key: 'R', ctrl: true, op: 'image.read_viewlayers', when: () => (app.hoverArea ?? app.activeArea)?.type === 'IMAGE_EDITOR' }]);
