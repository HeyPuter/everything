// Movies and image sequences shown by the Image Editor. The image data-block keeps its first frame
// as its own pixels (so materials and the rest of the app see a normal image) and the footage in
// `media`; the editor shows the frame for the current scene frame (start frame, offset, length,
// cyclic), decoded with the movie clip frame sources.
import { app, registerOperators, type OpContext } from '../../app/app';
import type { ImageData as Img } from '../../data/types';
import { uid } from '../../data/defaults';
import { uniqueName } from '../../ops/object';
import { clipSource, readySource, type FrameSource } from '../../tracking/source';
import type { MovieClipData } from '../../tracking/types';
import { view2D } from './imageops';
import { download } from './result';
import { ZipWriter, concatBytes } from './zip';

export interface ImageMedia {
  kind: 'MOVIE' | 'SEQUENCE';
  movie?: { mime: string; bytes: Uint8Array } | null;
  sequence?: { mime: string; bytes: Uint8Array; name: string }[] | null;
  /** frames in the footage, and its frame rate */
  frames: number;
  fps: number;
  /** image user: scene frame of the first frame, frames skipped, frames shown, looping */
  frame_start: number;
  frame_offset: number;
  frame_duration: number;
  use_cyclic: boolean;
}

export const imageMedia = (img: Img | null | undefined): ImageMedia | null => ((img as unknown as { media?: ImageMedia } | null)?.media ?? null);

/** The footage as the clip frame sources expect it. */
const asClip = (m: ImageMedia) => ({ source: m.kind, movie: m.movie, sequence: m.sequence }) as unknown as MovieClipData;

export const mediaSource = (m: ImageMedia): Promise<FrameSource> | null => clipSource(asClip(m));
export const mediaReady = (m: ImageMedia): FrameSource | null => readySource(asClip(m));

/**
 * Footage frame (0-based) shown at a scene frame, or null when the image user shows nothing there
 * (before the start or past the length without Cyclic).
 */
export function mediaFrameIndex(m: ImageMedia, sceneFrame: number): number | null {
  const len = Math.max(1, m.frame_duration);
  let local = sceneFrame - m.frame_start;
  if (m.use_cyclic) local = ((local % len) + len) % len;
  else if (local < 0 || local >= len) return null;
  const idx = local + m.frame_offset;
  return idx >= 0 && idx < m.frames ? idx : null;
}

const isVideo = (f: File) => f.type.startsWith('video/') || /\.(mp4|m4v|mov|webm|mkv|ogv)$/i.test(f.name);

/** PNG bytes of a decoded frame (the image's own pixels). */
async function framePng(bmp: ImageBitmap): Promise<Uint8Array> {
  const c = document.createElement('canvas');
  c.width = bmp.width;
  c.height = bmp.height;
  c.getContext('2d')!.drawImage(bmp, 0, 0);
  const blob = await new Promise<Blob | null>((r) => c.toBlob(r, 'image/png'));
  return new Uint8Array(await (blob ?? new Blob()).arrayBuffer());
}

/** Load a movie file or several images (an image sequence, in name order) as one image. */
export async function openMediaFiles(files: File[]): Promise<string | null> {
  if (!files.length) return null;
  const movie = files.find(isVideo);
  const m: ImageMedia = { kind: movie ? 'MOVIE' : 'SEQUENCE', frames: 0, fps: app.doc.scene.render.fps || 24, frame_start: 1, frame_offset: 0, frame_duration: 1, use_cyclic: false };
  if (movie) m.movie = { mime: movie.type || 'video/mp4', bytes: new Uint8Array(await movie.arrayBuffer()) };
  else {
    const sorted = [...files].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    m.sequence = await Promise.all(sorted.map(async (f) => ({ mime: f.type || 'image/png', bytes: new Uint8Array(await f.arrayBuffer()), name: f.name })));
  }
  const src = await mediaSource(m);
  if (!src || !src.width) {
    app.report('ERROR', `Cannot read ${movie ? movie.name : files[0].name}`);
    return null;
  }
  m.frames = src.frameCount;
  m.fps = src.fps || m.fps;
  m.frame_duration = src.frameCount;
  const first = await src.get(0);
  const name = movie ? movie.name : files[0].name;
  const bytes = movie ? (first ? await framePng(first) : new Uint8Array()) : m.sequence![0].bytes;
  const mime = movie ? 'image/png' : m.sequence![0].mime;
  const doc = app.doc;
  const id = uid('im');
  const img = { id, name: uniqueName(doc, name, 'images'), mime, bytes, width: src.width, height: src.height, source: 'FILE', colorspace: 'sRGB', filepath: name, revision: 0, media: m } as unknown as Img;
  doc.images[id] = img;
  app.pushUndo(movie ? 'Open Movie' : 'Open Image Sequence');
  app.changed('doc');
  app.report('INFO', `Loaded ${movie ? 'movie' : 'image sequence'} "${name}" (${m.frames} frames)`);
  return id;
}

const shownMedia = (ctx: OpContext) => {
  const img = view2D(ctx)?.shownImage() ?? null;
  const m = imageMedia(img);
  return m ? { img: img!, m } : null;
};

registerOperators([
  {
    idname: 'image.match_movie_length',
    label: 'Match Movie Length',
    description: 'Show every frame of the movie or sequence: set the frame count to its length',
    poll: (ctx) => !!shownMedia(ctx),
    exec: (ctx) => {
      const { m } = shownMedia(ctx)!;
      m.frame_duration = Math.max(1, m.frames - m.frame_offset);
      app.changed('doc');
    },
  },
  {
    idname: 'image.save_sequence',
    label: 'Save Sequence',
    description: 'Download the frames of the image sequence (as one zip file)',
    poll: (ctx) => shownMedia(ctx)?.m.kind === 'SEQUENCE',
    undo: false,
    exec: (ctx) => {
      const { img, m } = shownMedia(ctx)!;
      const z = new ZipWriter();
      for (const f of m.sequence ?? []) z.add(f.name, f.bytes);
      download(concatBytes(z.finish()), `${img.name.replace(/\.[a-z0-9]+$/i, '')}.zip`, 'application/zip');
      app.report('INFO', `Saved ${m.sequence?.length ?? 0} frames of "${img.name}"`);
    },
  },
]);
