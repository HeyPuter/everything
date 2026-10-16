// Adding strips: media files (movie + its sound, sound, image / image sequence), generators
// (colour, text, adjustment layer), scene strips and effect strips.
import { connect } from './connect';
import { app } from '../app/app';
import { sceneById } from '../scenes/scenes';
import type { Strip, StripType, MediaFile } from './types';
import { newStrip, uniqueName, freeChannel, inputCount, finalStart, finalEnd, updateEffectRanges } from './strips';
import { seqEditor, seqList, setActive, toolSettings, sceneFps, afterEdit } from './context';
import { getMovie, loadImage, loadSound, mediaKind, mimeFor } from './media';

export const DEFAULT_LENGTH = 25;

/** Scale so an image of w×h fits the render frame per the tool setting's fit method. */
export function fitScale(w: number, h: number, W: number, H: number, method = toolSettings().fit_method): [number, number] {
  if (!w || !h) return [1, 1];
  switch (method) {
    case 'FILL': {
      const k = Math.max(W / w, H / h);
      return [k, k];
    }
    case 'STRETCH':
      return [W / w, H / h];
    case 'ORIGINAL':
      return [1, 1];
    default: {
      const k = Math.min(W / w, H / h);
      return [k, k];
    }
  }
}

function renderRes(): [number, number] {
  const r = app.doc.scene.render;
  return [r.resolution_x, r.resolution_y];
}

function deselectAll() {
  for (const s of seqList()) {
    s.select = false;
    s.select_left_handle = s.select_right_handle = false;
  }
}

/** Insert strips into the edited list on the first free channel at/above `channel`. */
function place(strips: Strip[], channel: number) {
  const list = seqList();
  const ed = seqEditor();
  const taken = new Set<string>();
  for (const s of strips) {
    s.name = uniqueName(ed, s.name, new Set([...list.map((x) => x.name), ...allNames(), ...taken]));
    taken.add(s.name);
  }
  // keep the group's relative channels; find the lowest channel where all fit
  const base = Math.min(...strips.map((s) => s.channel));
  for (let c = Math.max(1, channel); c < 128; c++) {
    const d = c - base;
    if (strips.every((s) => freeChannel(list, finalStart(s), finalEnd(s), s.channel + d) === s.channel + d)) {
      for (const s of strips) s.channel += d;
      break;
    }
  }
  deselectAll();
  list.push(...strips);
  for (const s of strips) s.select = true;
  setActive(strips[strips.length - 1]);
  afterEdit();
}

function allNames() {
  const out: string[] = [];
  const walk = (l: Strip[]) => l.forEach((s) => (out.push(s.name), s.strips && walk(s.strips)));
  walk(seqEditor().strips);
  return out;
}

export async function fileBytes(f: File): Promise<MediaFile> {
  return { filepath: f.name, mime: mimeFor(f.name, f.type), bytes: new Uint8Array(await f.arrayBuffer()) };
}

/** Add a movie strip (and its sound strip below it when the file has audio). */
export async function addMovie(file: File, frame: number, channel: number): Promise<Strip[]> {
  const media = await fileBytes(file);
  const movie = getMovie(media.bytes, media.mime);
  const info = await movie.info;
  const fps = sceneFps();
  const len = Math.max(1, Math.round(info.duration * fps));
  const [W, H] = renderRes();
  const m = newStrip('MOVIE', file.name, channel + 1, frame, len);
  m.media = media;
  m.orig_width = info.width;
  m.orig_height = info.height;
  m.fps = info.fps || fps;
  const [sx, sy] = fitScale(info.width, info.height, W, H);
  m.transform.scale_x = sx;
  m.transform.scale_y = sy;
  // the movie keeps the file name, its sound strip gets the next unique name (below the movie)
  const out: Strip[] = [m];
  const buf = await loadSound(media.bytes);
  if (buf && buf.length > 0 && hasSignal(buf)) {
    const s = newStrip('SOUND', file.name, channel, frame, Math.max(1, Math.round(buf.duration * fps)));
    s.media = media;
    out.push(s);
  } else m.channel = channel;
  place(out, channel);
  // picture and sound move together (names are final after placing)
  if (out.length > 1) connect(out, out);
  // the movie strip is the active one
  setActive(m);
  return out;
}

function hasSignal(buf: AudioBuffer) {
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < d.length; i += 97) if (Math.abs(d[i]) > 1e-5) return true;
  }
  return false;
}

export async function addSound(file: File, frame: number, channel: number): Promise<Strip[]> {
  const media = await fileBytes(file);
  const buf = await loadSound(media.bytes);
  if (!buf) throw new Error(`Cannot decode sound "${file.name}"`);
  const s = newStrip('SOUND', file.name, channel, frame, Math.max(1, Math.round(buf.duration * sceneFps())));
  s.media = media;
  place([s], channel);
  return [s];
}

/** One image → still strip of `length` frames; several images → an image sequence (one per frame). */
export async function addImages(files: File[], frame: number, channel: number, length = DEFAULT_LENGTH): Promise<Strip[]> {
  if (!files.length) return [];
  const sorted = [...files].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  const elements = await Promise.all(sorted.map(async (f) => ({ filename: f.name, mime: mimeFor(f.name, f.type), bytes: new Uint8Array(await f.arrayBuffer()) })));
  const first = await loadImage(elements[0].bytes, elements[0].mime);
  const [W, H] = renderRes();
  const s = newStrip('IMAGE', sorted[0].name, channel, frame, elements.length > 1 ? elements.length : length);
  s.elements = elements;
  s.orig_width = first.width;
  s.orig_height = first.height;
  const [sx, sy] = fitScale(first.width, first.height, W, H);
  s.transform.scale_x = sx;
  s.transform.scale_y = sy;
  place([s], channel);
  return [s];
}

/** Generators and effects (effect_strip_add). Effects use the selected strips as inputs. */
export function addEffect(type: StripType, frame: number, channel: number, length = DEFAULT_LENGTH, color?: number[]): Strip | string {
  const n = inputCount(type);
  const list = seqList();
  let inputs: Strip[] = [];
  if (n) {
    const ed = seqEditor();
    const act = list.find((s) => s.name === ed.active_strip && s.select && s.type !== 'SOUND');
    const sel = list.filter((s) => s.select && s.type !== 'SOUND').sort((a, b) => a.channel - b.channel);
    if (sel.length < n) return n === 1 ? 'Need one selected strip' : 'Need two selected strips';
    // input order: lower channel first; the active strip goes last for 2-input effects
    inputs = sel.slice(0, n);
    if (n === 2 && act && sel.includes(act) && inputs[1] !== act) inputs = [sel.find((s) => s !== act)!, act];
  }
  const s = newStrip(type, typeName(type), channel, frame, length);
  if (color) s.color = [...color];
  if (inputs.length) {
    s.input_1 = inputs[0].name;
    s.input_2 = inputs[1]?.name ?? null;
    s.channel = Math.max(...inputs.map((i) => i.channel)) + 1;
    updateEffectRanges([...list, s]);
  }
  place([s], inputs.length ? s.channel : channel);
  if (inputs.length) afterEdit();
  return s;
}

function typeName(t: StripType): string {
  switch (t) {
    case 'ADJUSTMENT':
      return 'Adjustment Layer';
    case 'GAMMA_CROSS':
      return 'Gamma Cross';
    case 'ALPHA_OVER':
      return 'Alpha Over';
    case 'ALPHA_UNDER':
      return 'Alpha Under';
    case 'COLORMIX':
      return 'Color Mix';
    case 'GAUSSIAN_BLUR':
      return 'Gaussian Blur';
    case 'SPEED':
      return 'Speed';
    case 'MULTICAM':
      return 'Multicam';
    default:
      return t.charAt(0) + t.slice(1).toLowerCase();
  }
}

export function addScene(frame: number, channel: number, cameraId: string | null = null, sceneId: string | null = null): Strip {
  const sc = sceneById(app.doc, sceneId) ?? app.doc.scene;
  const len = Math.max(1, sc.frame_end - sc.frame_start + 1);
  const s = newStrip('SCENE', sc.name || 'Scene', channel, frame, len);
  s.scene = sc.name;
  s.scene_camera = cameraId;
  place([s], channel);
  return s;
}

/** Add any dropped/picked files (kinds detected from their type). */
export async function addFiles(files: File[], frame: number, channel: number): Promise<Strip[]> {
  const images = files.filter((f) => mediaKind(f.name, f.type) === 'image');
  const out: Strip[] = [];
  let ch = channel;
  for (const f of files) {
    const k = mediaKind(f.name, f.type);
    try {
      if (k === 'movie') out.push(...(await addMovie(f, frame, ch)));
      else if (k === 'sound') out.push(...(await addSound(f, frame, ch)));
      else continue;
      ch = Math.max(...out.map((s) => s.channel)) + 1;
    } catch (e) {
      app.report('ERROR', `Cannot add "${f.name}": ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (images.length) out.push(...(await addImages(images, frame, ch)));
  return out;
}

export function pickFiles(accept: string, multiple = true): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = multiple;
    input.style.display = 'none';
    document.body.append(input);
    let done = false;
    input.addEventListener('change', () => {
      done = true;
      resolve(input.files ? [...input.files] : []);
      input.remove();
    });
    input.addEventListener('cancel', () => {
      if (!done) resolve([]);
      input.remove();
    });
    input.click();
  });
}

export const ACCEPT = {
  movie: 'video/*,.mp4,.webm,.mov,.mkv,.m4v,.ogv',
  sound: 'audio/*,.wav,.mp3,.ogg,.flac,.m4a,.aac,.opus',
  image: 'image/*,.png,.jpg,.jpeg,.webp,.gif,.bmp,.avif',
};
