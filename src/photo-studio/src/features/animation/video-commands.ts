// Video timeline and video layer commands (loaded on first use): creating
// and converting timelines, video layers from files or blank, frame edits,
// footage replacement and interpretation, clip edits at the playhead,
// keyframes, transitions and timeline settings.
import type { Editor } from '../../editor';
import { allLayers, assertSize, findLayer, type Layer, type PhotoDocument } from '../../model/document';
import { hasArtboards } from '../../model/artboard';
import { newPixelLayer } from '../../model/pixel-layer';
import { formDialog } from '../../ui/dialog';
import { escapeXML } from '../../model/assets';
import type { TileGrid } from '../../model/tiles';
import { modal, fieldChecked, fieldValue } from '../files/ui';
import {
  blankVideo,
  deleteFrame,
  duplicateFrame,
  footageVideo,
  insertBlankFrame,
  videoAlphaModes,
  type VideoAlpha,
  type VideoLayerData,
} from '../../model/video-layer';
import {
  artboardConflict,
  clipEnd,
  clipStates,
  createTimeline,
  defaultTransitionFrames,
  frameRates,
  maxTimelineFrames,
  ownClip,
  transitionKinds,
  videoFrameAt,
  type Clip,
  type FrameLookup,
  type Key,
  type KeyProperty,
  type Transition,
  type VideoTimeline,
} from '../../model/video-timeline';
import {
  animationToTimeline,
  applyTime,
  contentLength,
  fpsLabel,
  keyTimes,
  moveKey,
  naturalClip,
  setInterpolation,
  setTimelineFps,
  splitClip,
  timecode,
  timelineToAnimation,
  toggleKeyAtCurrent,
  toggleStopwatch,
  trimClipEnd,
  trimClipStart,
  workArea,
  neededFrames,
} from '../../model/video-timeline-ops';
import { maxFrames } from '../../model/animation';
import { addFootage, editTimeline, footageGrid, placer, forgetFrames, purgeVideoCache, setTime } from './video-frames';
import { isVideoLayer, timelineOf, videoLayerOf, videoView, type VideoLayer } from './video-state';
import { setSelectedFrames } from './state';
import { footageSound, purgeAudioCache } from './audio-media';
import { allAudioClips, linkFootageAudio } from '../../model/audio-timeline';

const tlOf = (e: Editor) => timelineOf(e)!;
const clampTime = (tl: VideoTimeline, t: number) => Math.max(0, Math.min(tl.duration - 1, Math.round(t)));

function pickVideo(): Promise<File | undefined> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'video/*,.webm,.mp4,.mov,.m4v,.ogv,.mkv';
    input.onchange = () => resolve(input.files?.[0]);
    input.oncancel = () => resolve(undefined);
    input.click();
  });
}
const titleOf = (name: string) => name.replace(/\.[^.]+$/, '') || 'Video';

/** Give a document a video timeline (converting its frame animation).
 * Returns true when the timeline is new. */
export function prepareTimeline(d: PhotoDocument, fps: number, seconds = 5) {
  if (d.timeline) return false;
  if (hasArtboards(d)) throw new Error(artboardConflict);
  if (d.animation) animationToTimeline(d, fps);
  else d.timeline = createTimeline(fps, seconds);
  return true;
}
/** Insert a layer above the selected layer (or on top). */
function insertLayer(d: PhotoDocument, l: Layer, anchor: string) {
  const find = (layers: Layer[]): boolean => {
    const i = layers.findIndex((x) => x.id === anchor);
    if (i >= 0) {
      layers.splice(i + 1, 0, l);
      return true;
    }
    return layers.some((x) => !x.artboard && find(x.children));
  };
  if (!anchor || !find(d.layers)) d.layers.push(l);
}
/** Layer frame of a video layer at the current time. */
export function currentLayerFrame(doc: PhotoDocument, l: VideoLayer) {
  const tl = doc.timeline!;
  const content = clipStates(doc, tl.current).get(l.id)?.content ?? tl.current;
  return videoFrameAt(tl, l, content);
}

// ----- Timelines -----

export function createVideoTimeline(e: Editor) {
  if (hasArtboards(e.doc)) throw new Error(artboardConflict);
  e.command('Create Video Timeline', (d) => prepareTimeline(d, 30));
  e.dock.show('timeline');
}
export async function convertToVideo(e: Editor) {
  if (hasArtboards(e.doc)) throw new Error(artboardConflict);
  e.command('Convert to Video Timeline', (d) => {
    animationToTimeline(d, 30);
  });
  await setTime(e, tlOf(e).current);
}

/** Convert the timeline to frames sampled at a chosen rate over the work area or the whole timeline. */
export async function convertToFrames(e: Editor) {
  const tl = tlOf(e);
  const [ws, we] = workArea(tl);
  const v = await formDialog(
    'Convert to Frame Animation',
    [
      { name: 'fps', label: 'Frames per second', type: 'number', value: Math.min(10, Math.round(tl.fps)), min: 1, max: Math.round(tl.fps), step: 1 },
      { name: 'range', label: 'Range', type: 'select', value: tl.work ? 'work' : 'all', options: [['all', `Whole timeline (${timecode(tl.duration, tl.fps)})`], ['work', `Work area (${timecode(we - ws, tl.fps)})`]] },
    ],
    'Convert',
    'Each frame shows the timeline at its time. Video layers become one layer per frame.',
  );
  if (!v) return;
  const rate = Math.max(1, Math.min(tl.fps, Number(v.fps) || 10));
  const [a, b] = v.range === 'work' ? [ws, we] : [0, tl.duration];
  const step = tl.fps / rate;
  const times: number[] = [];
  for (let t = a; t < b - 1e-9 && times.length < maxFrames; t += step) times.push(Math.round(t));
  const unique = [...new Set(times)];
  const current = unique.reduce((best, t, i) => (Math.abs(t - tl.current) < Math.abs(unique[best] - tl.current) ? i : best), 0);
  // Decode every frame the conversion needs first (held here, so the cache
  // budget cannot drop them before they become layers).
  const s = e.session;
  const grids = new Map<string, TileGrid>();
  for (const [i, t] of unique.entries()) {
    if (i % 5 === 0) e.message(`Reading frame ${i + 1} of ${unique.length}…`);
    for (const n of neededFrames(e.doc, t)) grids.set(`${n.layer.id}:${n.source}`, await footageGrid(s, n.layer.video, n.source));
  }
  const lookup: FrameLookup = (l, _k, j) => grids.get(`${l.id}:${j}`);
  lookup.place = placer(s);
  e.command('Convert to Frame Animation', (d) => {
    applyTime(d, unique[current], lookup);
    timelineToAnimation(d, unique, current, Math.round(1000 / rate), lookup, (name, grid, from) => {
      const l = newPixelLayer(name, d, grid);
      for (const k of ['maskGrid', 'maskUnlinked', 'maskDisabled', 'clipped', 'blending', 'locked', 'protection'] as const) if (from[k] !== undefined) (l as unknown as Record<string, unknown>)[k] = structuredClone(from[k]);
      return l;
    });
  });
  setSelectedFrames(e, [current]);
  e.update();
  e.message(`Converted to ${unique.length} frames.`);
}

/** Remove the timeline; the layers keep what the current time shows and
 * video layers keep their current frame as pixels. */
export function deleteTimeline(e: Editor) {
  e.command('Delete Video Timeline', (d) => {
    const states = clipStates(d, d.timeline!.current);
    for (const l of allLayers(d.layers)) {
      const s = states.get(l.id);
      if (s && !s.shown) l.visible = false;
      delete l.video;
    }
    delete d.timeline;
  });
}

export async function timelineSettings(e: Editor) {
  const tl = tlOf(e);
  const rates = frameRates.includes(tl.fps) ? frameRates : [...frameRates, tl.fps].sort((a, b) => a - b);
  const v = await formDialog(
    'Timeline Settings',
    [
      { name: 'seconds', label: 'Duration (seconds)', type: 'number', value: Math.round((tl.duration / tl.fps) * 1000) / 1000, min: 1 / tl.fps, max: maxTimelineFrames / tl.fps, step: 'any' as unknown as number },
      { name: 'fps', label: 'Frame rate', type: 'select', value: String(tl.fps), options: rates.map((r) => [String(r), fpsLabel(r)]) },
    ],
    'OK',
    'Times keep their place in seconds when the frame rate changes.',
  );
  if (!v) return;
  const fps = Number(v.fps);
  const seconds = Number(v.seconds);
  if (!Number.isFinite(fps) || fps <= 0 || !Number.isFinite(seconds) || seconds <= 0) return;
  await editTimeline(e, 'Timeline Settings', (d) => {
    const t = d.timeline!;
    setTimelineFps(t, fps);
    t.duration = Math.max(1, Math.min(maxTimelineFrames, Math.round(seconds * fps)));
    t.current = Math.min(t.current, t.duration - 1);
    if (t.work) t.work = [Math.min(t.work[0], t.duration - 1), Math.min(t.work[1], t.duration)];
  });
}
export async function setFrameRate(e: Editor, fps: number) {
  if (!Number.isFinite(fps) || fps <= 0 || fps > 240) return;
  await editTimeline(e, 'Frame Rate', (d) => setTimelineFps(d.timeline!, fps));
}

// ----- Moving the playhead -----

export function goTo(e: Editor, t: number) {
  return setTime(e, t);
}
export function step(e: Editor, how: 'first' | 'previous' | 'next' | 'last') {
  const tl = tlOf(e);
  const [a, b] = workArea(tl);
  const t = how === 'first' ? (tl.current > a ? a : 0) : how === 'last' ? (tl.current < b - 1 ? b - 1 : tl.duration - 1) : tl.current + (how === 'next' ? 1 : -1);
  return setTime(e, clampTime(tl, t));
}
/** Move the playhead to the previous or next keyframe of the selected
 * layers (or of one layer's property). */
export function gotoKey(e: Editor, dir: 1 | -1, only?: { id: string; prop: KeyProperty }) {
  const tl = tlOf(e);
  const times = [...new Set(only ? keyTimes(tl, only.id, only.prop) : [...e.selectedIds].flatMap((id) => keyTimes(tl, id)))].sort((a, b) => a - b);
  const t = dir > 0 ? times.find((x) => x > tl.current) : times.reverse().find((x) => x < tl.current);
  if (t === undefined) return e.message(dir > 0 ? 'No keyframe after the playhead.' : 'No keyframe before the playhead.');
  return setTime(e, clampTime(tl, t));
}

// ----- Video layers -----

export async function newVideoLayerFromFile(e: Editor, arg?: unknown) {
  const file = arg instanceof Blob ? arg : await pickVideo();
  if (!file) return;
  const name = file instanceof File ? file.name : 'Video.webm';
  if (e.hasDocument && hasArtboards(e.doc)) throw new Error(artboardConflict);
  e.message(`Reading ${name}…`);
  if (!e.hasDocument) {
    // Without a document, the video opens as one at its own size.
    const s = e.sessionForOpen();
    const footage = await addFootage(s, file, name);
    assertSize(footage.width, footage.height);
    const video = footageVideo(footage);
    const sound = await footageSound(file, name, footage.type, footage.asset);
    if (sound) video.audio = sound;
    const grid = await footageGrid(s, video, 0);
    const doc: PhotoDocument = { ...s.doc, name: titleOf(name), width: footage.width, height: footage.height, layers: [], selection: null };
    const l = newPixelLayer(titleOf(name), doc, grid);
    l.video = video;
    doc.layers.push(l);
    doc.timeline = createTimeline(footage.fps, 1);
    const clip = naturalClip(doc.timeline, l);
    doc.timeline.clips[l.id] = clip;
    doc.timeline.duration = Math.min(maxTimelineFrames, clipEnd(clip));
    if (sound) linkFootageAudio(doc.timeline, l.id);
    s.history.reset(doc);
    s.hasDocument = true;
    s.storage.reset();
    s.saved = s.doc;
    e.selected = l.id;
    e.fit();
  } else {
    const s = e.session;
    const footage = await addFootage(s, file, name);
    const video = footageVideo(footage);
    // The footage's sound plays from a linked clip (added by the history hook).
    const sound = await footageSound(file, name, footage.type, footage.asset);
    if (sound) video.audio = sound;
    const grid = await footageGrid(s, video, 0);
    const x = Math.round((e.doc.width - footage.width) / 2),
      y = Math.round((e.doc.height - footage.height) / 2);
    const anchor = e.selected;
    let id = '';
    e.command('New Video Layer', (d) => {
      const fresh = prepareTimeline(d, footage.fps);
      const tl = d.timeline!;
      const l = newPixelLayer(titleOf(name), d, { ...grid, x, y });
      l.video = { ...video, x, y };
      id = l.id;
      insertLayer(d, l, anchor);
      const clip = naturalClip(tl, l, fresh ? 0 : tl.current);
      tl.clips[l.id] = clip;
      tl.duration = Math.min(maxTimelineFrames, fresh ? clipEnd(clip) : Math.max(tl.duration, clipEnd(clip)));
      applyTime(d, tl.current);
    });
    e.selected = id;
    await setTime(e, tlOf(e).current);
  }
  e.dock.show('timeline');
  e.update();
  e.message(`Video layer added from ${name}.`);
}

export function newBlankVideoLayer(e: Editor) {
  const anchor = e.selected;
  let id = '';
  e.command('New Blank Video Layer', (d) => {
    prepareTimeline(d, 30);
    const tl = d.timeline!;
    const frames = Math.max(1, tl.duration - tl.current);
    const l = newPixelLayer('Video Layer', d);
    l.video = blankVideo(d.width, d.height, frames, tl.fps);
    id = l.id;
    insertLayer(d, l, anchor);
    tl.clips[l.id] = naturalClip(tl, l, tl.current);
    applyTime(d, tl.current);
  });
  e.selected = id;
  e.dock.show('timeline');
  e.update();
}

/** Edit the selected video layer's frame sequence at the current frame. */
function frameEdit(e: Editor, label: string, edit: (v: VideoLayerData, k: number) => boolean) {
  const sel = videoLayerOf(e)!;
  return editTimeline(e, label, (d) => {
    const l = findLayer(d.layers, sel.id) as VideoLayer;
    const tl = d.timeline!;
    const k = currentLayerFrame(d, l);
    const before = contentLength(l, tl.fps);
    const clip = ownClip(tl, l.id);
    const wasFull = Number.isFinite(before) && clip.in + clip.length >= before;
    const v = structuredClone(l.video);
    if (!edit(v, k)) return false;
    l.video = v;
    // A clip that showed the whole sequence keeps showing all of it.
    const after = contentLength(l, tl.fps);
    if (wasFull && Number.isFinite(after)) clip.length = Math.max(1, after - clip.in);
  });
}
export const insertFrame = (e: Editor) => frameEdit(e, 'Insert Blank Frame', insertBlankFrame);
export const duplicateVideoFrame = (e: Editor) => frameEdit(e, 'Duplicate Frame', duplicateFrame);
export const deleteVideoFrame = (e: Editor) =>
  frameEdit(e, 'Delete Frame', (v, k) => {
    if (v.frames <= 1) {
      e.message('A video layer keeps at least one frame.');
      return false;
    }
    return deleteFrame(v, k);
  });

export function restoreFrame(e: Editor) {
  const sel = videoLayerOf(e)!;
  return editTimeline(e, 'Restore Frame', (d) => {
    const l = findLayer(d.layers, sel.id) as VideoLayer;
    const k = currentLayerFrame(d, l);
    if (!l.video.altered?.[k]) return false;
    const altered = { ...l.video.altered };
    delete altered[k];
    l.video = { ...l.video, altered };
    if (!Object.keys(altered).length) delete l.video.altered;
  });
}
export function restoreAllFrames(e: Editor) {
  const sel = videoLayerOf(e)!;
  return editTimeline(e, 'Restore All Frames', (d) => {
    const l = findLayer(d.layers, sel.id) as VideoLayer;
    if (!l.video.altered) return false;
    l.video = { ...l.video };
    delete l.video.altered;
  });
}
export function toggleShowAltered(e: Editor) {
  return editTimeline(e, 'Show Altered Video', (d) => {
    if (d.timeline!.hideAltered) delete d.timeline!.hideAltered;
    else d.timeline!.hideAltered = true;
  });
}
/** Decode the current frame from the footage again. */
export async function reloadFrame(e: Editor) {
  const l = videoLayerOf(e)!;
  if (!l.video.footage) return e.message('A blank video layer has no footage to reload.');
  const k = currentLayerFrame(e.doc, l);
  const { footageFrame } = await import('../../model/video-layer');
  const j = footageFrame(l.video, k);
  if (j >= 0) forgetFrames(e.session, l.video.footage.asset, j);
  await editTimeline(e, 'Reload Frame', () => {});
}
export function rasterizeVideo(e: Editor) {
  const ids = allLayers(e.selectedLayers).filter(isVideoLayer).map((l) => l.id);
  e.command('Rasterize Video', (d) => {
    for (const id of ids) delete findLayer(d.layers, id)!.video;
  });
}

export async function replaceFootage(e: Editor, arg?: unknown) {
  const sel = videoLayerOf(e)!;
  const file = arg instanceof Blob ? arg : await pickVideo();
  if (!file) return;
  const name = file instanceof File ? file.name : 'Video.webm';
  e.message(`Reading ${name}…`);
  const footage = await addFootage(e.session, file, name);
  const sound = await footageSound(file, name, footage.type, footage.asset);
  await editTimeline(e, 'Replace Footage', (d) => {
    const l = findLayer(d.layers, sel.id) as VideoLayer;
    const v: VideoLayerData = { ...footageVideo(footage, l.video.x, l.video.y), alpha: l.video.alpha, loops: l.video.loops };
    if (sound) {
      v.audio = sound;
      if (l.video.muted) v.muted = true;
      if (!allAudioClips(d.timeline!).some((c) => c.link === l.id)) linkFootageAudio(d.timeline!, l.id);
    }
    const altered = Object.fromEntries(Object.entries(l.video.altered ?? {}).filter(([k]) => Number(k) < v.frames));
    if (Object.keys(altered).length) v.altered = altered;
    l.video = v;
    l.name = titleOf(name);
  });
}

export async function interpretFootage(e: Editor) {
  const l = videoLayerOf(e)!;
  const v = l.video;
  const fileRate = v.footage?.fps;
  const rates = [...new Set([...frameRates, v.fps, ...(fileRate ? [fileRate] : [])])].sort((a, b) => a - b);
  const result = await modal({
    title: 'Interpret Footage',
    submit: 'OK',
    className: 'animation-export-dialog',
    body: `<p>${escapeXML(v.footage ? `${v.footage.name}: ${v.footage.width} × ${v.footage.height} px, ${v.footage.frames} frames at ${fpsLabel(v.footage.fps)}.` : `Blank video layer: ${v.frames} frames.`)}</p>
      <label class="dialog-field">Frame rate<select name="fps">${rates.map((r) => `<option value="${r}" ${r === v.fps ? 'selected' : ''}>${escapeXML(fpsLabel(r))}${r === fileRate ? ' (as in the file)' : ''}</option>`).join('')}</select></label>
      <label class="dialog-field">Alpha channel<select name="alpha">${videoAlphaModes.map(([m, label]) => `<option value="${m}" ${m === v.alpha ? 'selected' : ''}>${label}</option>`).join('')}</select></label>
      <label class="dialog-field">Play (times)<input name="loops" type="number" min="1" max="10000" step="1" value="${Math.max(1, v.loops)}"></label>
      <label class="dialog-field checkbox-field">Loop until the clip ends<input name="forever" type="checkbox" ${v.loops === 0 ? 'checked' : ''}></label>`,
  });
  if (!result) return;
  const fps = Number(fieldValue(result.form, 'fps'));
  const alpha = fieldValue(result.form, 'alpha') as VideoAlpha;
  const loops = fieldChecked(result.form, 'forever') ? 0 : Math.max(1, Math.min(10000, Math.round(Number(fieldValue(result.form, 'loops')) || 1)));
  result.close();
  if (!Number.isFinite(fps) || fps <= 0 || fps > 240 || !videoAlphaModes.some(([m]) => m === alpha)) return;
  await editTimeline(e, 'Interpret Footage', (d) => {
    const x = findLayer(d.layers, l.id) as VideoLayer;
    const tl = d.timeline!;
    const before = contentLength(x, tl.fps);
    const clip = ownClip(tl, x.id);
    const wasFull = Number.isFinite(before) && clip.in + clip.length >= before;
    x.video = { ...x.video, fps, alpha, loops };
    const after = contentLength(x, tl.fps);
    if (wasFull && Number.isFinite(after)) clip.length = Math.max(1, after - clip.in);
  });
}

export function purgeCache(e: Editor) {
  purgeVideoCache();
  purgeAudioCache();
  for (const s of e.sessions) s.collectTiles();
  e.message('Video cache purged.');
}

// ----- Clips at the playhead -----

const selectedClipIds = (e: Editor) => allLayers(e.selectedLayers).map((l) => l.id);

export function splitAtPlayhead(e: Editor, layerIds = selectedClipIds(e)) {
  const tl = tlOf(e);
  const t = tl.current;
  const ids = layerIds.filter((id) => splitClip(ownClipCopy(tl, id), t));
  if (!ids.length) return e.message('Move the playhead inside a selected clip to split it.');
  const made: string[] = [];
  return editTimeline(e, 'Split at Playhead', (d) => {
    made.length = 0;
    const t2 = d.timeline!;
    for (const id of ids) {
      const parts = splitClip(ownClip(t2, id), t);
      if (!parts) continue;
      const container = containerList(d.layers, id);
      if (!container) continue;
      const i = container.findIndex((l) => l.id === id);
      const copy = cloneLayer(container[i]);
      container.splice(i + 1, 0, copy);
      t2.clips[id] = parts[0];
      t2.clips[copy.id] = parts[1];
      made.push(copy.id);
    }
  }).then(() => {
    if (made.length) e.selectLayers(made);
    e.update();
  });
}
const ownClipCopy = (tl: VideoTimeline, id: string): Clip => structuredClone(tl.clips[id] ?? { start: 0, in: 0, length: tl.duration });
function containerList(layers: Layer[], id: string): Layer[] | undefined {
  if (layers.some((l) => l.id === id)) return layers;
  for (const l of layers) {
    const found = containerList(l.children, id);
    if (found) return found;
  }
  return undefined;
}
/** A copy of a layer (and its children) with new IDs; tiles are shared. */
function cloneLayer(l: Layer): Layer {
  const copy = structuredClone(l);
  const renew = (x: Layer) => {
    x.id = crypto.randomUUID();
    delete x.psdId;
    x.children.forEach(renew);
  };
  renew(copy);
  return copy;
}

export function trimToPlayhead(e: Editor, edge: 'start' | 'end', ids = selectedClipIds(e)) {
  const tl = tlOf(e);
  const t = tl.current;
  return editTimeline(e, edge === 'start' ? 'Trim Start to Playhead' : 'Trim End to Playhead', (d) => {
    const t2 = d.timeline!;
    let changed = false;
    for (const id of ids) {
      const l = findLayer(d.layers, id)!;
      const c = ownClip(t2, id);
      const limit = contentLength(l, t2.fps);
      const next = edge === 'start' ? trimClipStart(c, t - c.start, limit) : trimClipEnd(c, t + 1 - clipEnd(c), limit);
      if (JSON.stringify(next) !== JSON.stringify(c)) changed = true;
      t2.clips[id] = next;
    }
    if (!changed) return false;
  });
}
export function setWorkArea(e: Editor, edge: 'start' | 'end' | 'clear') {
  return editTimeline(e, edge === 'clear' ? 'Clear Work Area' : 'Work Area', (d) => {
    const tl = d.timeline!;
    if (edge === 'clear') {
      if (!tl.work) return false;
      delete tl.work;
      return;
    }
    const [a, b] = workArea(tl);
    tl.work = edge === 'start' ? [Math.min(tl.current, b - 1), b] : [Math.min(a, tl.current), tl.current + 1];
  });
}

/** Set the work area to [start, end) (the whole timeline clears it). */
export function changeWork(e: Editor, range: [number, number]) {
  return editTimeline(e, 'Work Area', (d) => {
    const tl = d.timeline!;
    const a = Math.max(0, Math.min(tl.duration - 1, Math.round(range[0])));
    const b = Math.max(a + 1, Math.min(tl.duration, Math.round(range[1])));
    if (a === 0 && b === tl.duration) {
      if (!tl.work) return false;
      delete tl.work;
    } else tl.work = [a, b];
  });
}

// ----- Keyframes -----

export function toggleStopwatchCommand(e: Editor, prop: KeyProperty, arg?: unknown) {
  const id = typeof arg === 'string' ? arg : e.selected;
  return editTimeline(e, `${toggleLabel(e, id, prop)} ${propLabel(prop)}`, (d) => {
    if (!toggleStopwatch(d, id, prop)) return false;
  });
}
const toggleLabel = (e: Editor, id: string, prop: KeyProperty) => (tlOf(e).clips[id]?.keys?.[prop] ? 'Stop Animating' : 'Animate');
export const propLabel = (p: KeyProperty) => (p === 'position' ? 'Position' : p === 'opacity' ? 'Opacity' : 'Style');
/** Add or remove a keyframe at the playhead; `arg` is "layer id|property"
 * (panel buttons) or { id, prop }. */
export function toggleKeyCommand(e: Editor, arg: unknown) {
  const { id, prop } = (typeof arg === 'string' ? { id: arg.split('|')[0], prop: arg.split('|')[1] as KeyProperty } : (arg ?? {})) as { id?: string; prop?: KeyProperty };
  const layerId = id ?? e.selected;
  if (!prop) return;
  return editTimeline(e, 'Keyframe', (d) => {
    if (!toggleKeyAtCurrent(d, layerId, prop)) return false;
  });
}
/** The selected keyframes that still exist. */
export function selectedKeys(e: Editor) {
  const tl = timelineOf(e);
  if (!tl) return [];
  return videoView(e).keys.filter((k) => tl.clips[k.id]?.keys?.[k.prop]?.some((x) => x.t === k.t));
}
export function setKeyInterpolation(e: Editor, hold: boolean) {
  const keys = selectedKeys(e);
  return editTimeline(e, hold ? 'Hold Interpolation' : 'Linear Interpolation', (d) => {
    for (const k of keys) {
      const c = d.timeline!.clips[k.id];
      const list = c?.keys?.[k.prop] as Key<unknown>[] | undefined;
      if (list) (c.keys as Record<string, Key<unknown>[]>)[k.prop] = setInterpolation(list, [k.t], hold);
    }
  });
}
export function deleteSelectedKeys(e: Editor) {
  const keys = selectedKeys(e);
  videoView(e).keys = [];
  return editTimeline(e, keys.length > 1 ? 'Delete Keyframes' : 'Delete Keyframe', (d) => {
    for (const k of keys) {
      const c = d.timeline!.clips[k.id];
      const list = c?.keys?.[k.prop] as Key<unknown>[] | undefined;
      if (!list) continue;
      const rest = list.filter((x) => x.t !== k.t);
      if (rest.length) (c.keys as Record<string, Key<unknown>[]>)[k.prop] = rest;
      else delete c.keys![k.prop];
      if (!Object.keys(c.keys!).length) delete c.keys;
    }
  });
}
/** Move keyframes by `d` content frames (drag in the panel). */
export function moveKeys(e: Editor, keys: { id: string; prop: KeyProperty; t: number }[], by: number) {
  if (!by) return;
  const view = videoView(e);
  return editTimeline(e, keys.length > 1 ? 'Move Keyframes' : 'Move Keyframe', (d) => {
    for (const k of [...keys].sort((a, b) => (by > 0 ? b.t - a.t : a.t - b.t))) {
      const c = d.timeline!.clips[k.id];
      const list = c?.keys?.[k.prop] as Key<unknown>[] | undefined;
      if (list) (c.keys as Record<string, Key<unknown>[]>)[k.prop] = moveKey(list, k.t, k.t + by);
    }
  }).then(() => {
    view.keys = keys.map((k) => ({ ...k, t: k.t + by }));
    e.update();
  });
}

// ----- Clip gestures (from the panel) -----

export function changeClip(e: Editor, id: string, label: string, next: (c: Clip, l: Layer, tl: VideoTimeline) => Clip) {
  return changeClips(e, [id], label, next);
}
/** Change several clips as one step (dragging a selection of clips). */
export function changeClips(e: Editor, ids: string[], label: string, next: (c: Clip, l: Layer, tl: VideoTimeline) => Clip) {
  return editTimeline(e, label, (d) => {
    const tl = d.timeline!;
    let changed = false;
    for (const id of ids) {
      const l = findLayer(d.layers, id);
      if (!l) continue;
      const c = ownClip(tl, id);
      const out = next(c, l, tl);
      if (JSON.stringify(out) !== JSON.stringify(c)) changed = true;
      tl.clips[id] = out;
    }
    if (!changed) return false;
  });
}

// ----- Transitions -----

export async function transitionsDialog(e: Editor) {
  const tl = tlOf(e);
  const id = e.selected;
  const l = e.layer;
  if (!l) return;
  const c = tl.clips[id] ?? { start: 0, in: 0, length: tl.duration };
  const seconds = (tr?: Transition) => Math.round(((tr?.duration ?? defaultTransitionFrames(tl.fps)) / tl.fps) * 100) / 100;
  const kinds = (edge: 'in' | 'out') =>
    [['none', 'None'] as [string, string], ...transitionKinds.filter(([k]) => edge === 'in' || k !== 'cross-fade').map(([k, label]) => [k, edge === 'in' && k === 'cross-fade' ? `${label} from the clip that ends here` : label] as [string, string])];
  const select = (name: string, edge: 'in' | 'out', tr?: Transition) =>
    `<select name="${name}">${kinds(edge).map(([k, label]) => `<option value="${k}" ${(tr?.kind ?? 'none') === k ? 'selected' : ''}>${escapeXML(label)}</option>`).join('')}</select>`;
  const color = c.fadeIn?.color ?? c.fadeOut?.color ?? '#000000';
  const result = await modal({
    title: 'Transitions',
    submit: 'OK',
    className: 'animation-export-dialog',
    body: `<p>${escapeXML(l.name)}: ${timecode(c.start, tl.fps)} to ${timecode(clipEnd(c), tl.fps)}.</p>
      <div class="processor-row"><label class="dialog-field">At the start${select('in', 'in', c.fadeIn)}</label>
      <label class="dialog-field">Duration (s)<input name="inSeconds" type="number" min="${(1 / tl.fps).toFixed(3)}" max="60" step="any" value="${seconds(c.fadeIn)}"></label></div>
      <div class="processor-row"><label class="dialog-field">At the end${select('out', 'out', c.fadeOut)}</label>
      <label class="dialog-field">Duration (s)<input name="outSeconds" type="number" min="${(1 / tl.fps).toFixed(3)}" max="60" step="any" value="${seconds(c.fadeOut)}"></label></div>
      <label class="dialog-field">Fade color<input name="color" type="color" value="${color}"></label>`,
  });
  if (!result) return;
  const f = result.form;
  const make = (edge: 'in' | 'out'): Transition | undefined => {
    const kind = fieldValue(f, edge);
    if (!transitionKinds.some(([k]) => k === kind)) return undefined;
    const duration = Math.max(1, Math.min(maxTimelineFrames, Math.round(Number(fieldValue(f, `${edge}Seconds`)) * tl.fps) || defaultTransitionFrames(tl.fps)));
    const colorValue = /^#[0-9a-f]{6}$/i.test(fieldValue(f, 'color')) ? fieldValue(f, 'color') : '#000000';
    return { kind: kind as Transition['kind'], duration, ...(kind === 'fade-color' ? { color: colorValue } : {}) };
  };
  const fadeIn = make('in'),
    fadeOut = make('out');
  result.close();
  await changeClip(e, id, 'Transitions', (clip) => {
    const out = { ...clip };
    if (fadeIn) out.fadeIn = fadeIn;
    else delete out.fadeIn;
    if (fadeOut) out.fadeOut = fadeOut;
    else delete out.fadeOut;
    return out;
  });
}

// ----- Onion skins -----

export async function videoOnionSettings(e: Editor) {
  const { defaultOnion, onionBlends } = await import('../../model/animation');
  const o = tlOf(e).onion ?? defaultOnion;
  const v = await formDialog(
    'Onion Skins',
    [
      { name: 'enabled', label: 'Show onion skins', type: 'checkbox', value: 'yes' },
      { name: 'before', label: 'Frames before', type: 'number', value: o.before, min: 0, max: 8, step: 1 },
      { name: 'after', label: 'Frames after', type: 'number', value: o.after, min: 0, max: 8, step: 1 },
      { name: 'opacity', label: 'Opacity (%)', type: 'number', value: Math.round(o.opacity * 100), min: 5, max: 100, step: 1 },
      { name: 'blend', label: 'Blend mode', type: 'select', value: o.blend ?? 'multiply', options: onionBlends.map((b) => [b, b[0].toUpperCase() + b.slice(1)]) },
    ],
    'OK',
    'Neighboring frames are drawn faintly over the canvas while the Timeline is open.',
  );
  if (!v) return;
  const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(Number.isFinite(n) ? n : lo)));
  e.command('Onion Skin Settings', (d) => {
    const blend = onionBlends.find((b) => b === v.blend) ?? 'multiply';
    d.timeline!.onion = { enabled: v.enabled === 'yes', before: clamp(Number(v.before), 0, 8), after: clamp(Number(v.after), 0, 8), opacity: clamp(Number(v.opacity), 5, 100) / 100, ...(blend === 'multiply' ? {} : { blend }) };
  });
}
export function toggleVideoOnion(e: Editor) {
  return import('../../model/animation').then(({ defaultOnion }) =>
    e.command('Onion Skins', (d) => (d.timeline!.onion = { ...(d.timeline!.onion ?? defaultOnion), enabled: !d.timeline!.onion?.enabled })),
  );
}
