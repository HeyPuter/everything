// Audio track and clip commands (loaded on first use): adding audio files,
// tracks (new, delete, rename, mute, solo, volume), clip edits (gain, fades,
// delete, duplicate, split and trim at the playhead, unlink, gestures from
// the panel) and muting the sound of video layers. Linked clips follow their
// video layer's clip, so edits of their timing change that clip.
import type { Editor } from '../../editor';
import { findLayer, type Layer, type PhotoDocument } from '../../model/document';
import { hasArtboards } from '../../model/artboard';
import { formDialog } from '../../ui/dialog';
import { artboardConflict, maxTimelineFrames, ownClip, type Clip, type VideoTimeline } from '../../model/video-timeline';
import { contentLength, moveClip, trimClipEnd, trimClipStart } from '../../model/video-timeline-ops';
import {
  clamp,
  clipSpan,
  findAudioClip,
  gainRange,
  maxAudioTracks,
  moveSpan,
  nextTrackName,
  ownTracks,
  splitAudioClip,
  trimSpanEnd,
  trimSpanStart,
  volumeRange,
  type AudioClip,
  type AudioTrack,
} from '../../model/audio-timeline';
import { addAudioFile, purgeAudioCache } from './audio-media';
import { editTimeline } from './video-frames';
import { prepareTimeline, splitAtPlayhead, trimToPlayhead } from './video-commands';
import { selectedAudioClips, selectedAudioTrack, timelineOf, videoLayerOf, videoView } from './video-state';

const tlOf = (e: Editor) => timelineOf(e)!;
const frame = (tl: VideoTimeline) => 1 / tl.fps;
/** Extend the timeline so it reaches `end` seconds. */
const fit = (tl: VideoTimeline, end: number) => (tl.duration = Math.min(maxTimelineFrames, Math.max(tl.duration, Math.ceil(end * tl.fps - 1e-6))));

function pickAudio(): Promise<File | undefined> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'audio/*,.wav,.mp3,.m4a,.aac,.ogg,.oga,.opus,.flac,.weba,.webm';
    input.onchange = () => resolve(input.files?.[0]);
    input.oncancel = () => resolve(undefined);
    input.click();
  });
}

/** Add an audio file as a clip at the playhead on the selected track (a
 * document without a timeline gets one that fits the sound). */
export async function addAudio(e: Editor, arg?: unknown) {
  const file = arg instanceof Blob ? arg : await pickAudio();
  if (!file) return;
  const name = file instanceof File ? file.name : 'Audio.wav';
  if (hasArtboards(e.doc)) throw new Error(artboardConflict);
  e.message(`Reading ${name}…`);
  const source = await addAudioFile(e.session, file, name);
  const view = videoView(e);
  const id = crypto.randomUUID();
  let track = '';
  const add = (d: PhotoDocument) => {
    const fresh = prepareTimeline(d, 30, Math.max(1, source.seconds));
    const tl = d.timeline!;
    const tracks = ownTracks(tl);
    const t = tracks.find((x) => x.id === view.audioTrack) ?? tracks[0];
    track = t.id;
    const start = fresh ? 0 : tl.current / tl.fps;
    t.clips.push({ id, start, in: 0, length: source.seconds, source });
    fit(tl, start + source.seconds);
  };
  if (timelineOf(e)) await editTimeline(e, 'Add Audio', add);
  else e.command('Add Audio', add);
  view.audioClips = [id];
  view.audioTrack = track;
  e.dock.show('timeline');
  e.update();
  e.message(`Audio clip added from ${name}.`);
}

// ----- Tracks -----

export function newTrack(e: Editor) {
  const id = crypto.randomUUID();
  return editTimeline(e, 'New Audio Track', (d) => {
    const tl = d.timeline!;
    const tracks = ownTracks(tl);
    if (tracks.length >= maxAudioTracks) return false;
    tracks.push({ id, name: nextTrackName(tl), clips: [] });
  }).then(() => {
    videoView(e).audioTrack = id;
    e.update();
  });
}
const trackArg = (e: Editor, arg: unknown) => (typeof arg === 'string' && arg ? arg : (selectedAudioTrack(e)?.id ?? ownTracksView(e)[0]?.id));
const ownTracksView = (e: Editor): AudioTrack[] => tlOf(e).audio ?? [];
/** The track to edit (the default track is created when it is the one shown). */
const editTrack = (tl: VideoTimeline, id: string) => ownTracks(tl).find((t) => t.id === id);

export function deleteTrack(e: Editor, arg?: unknown) {
  const id = trackArg(e, arg);
  if (!id) return;
  return editTimeline(e, 'Delete Audio Track', (d) => {
    const tl = d.timeline!;
    if (!tl.audio?.some((t) => t.id === id)) return false;
    tl.audio = tl.audio.filter((t) => t.id !== id);
    if (!tl.audio.length) delete tl.audio;
  });
}
export async function renameTrack(e: Editor, arg?: unknown) {
  const id = typeof arg === 'string' && arg ? arg : (selectedAudioTrack(e)?.id ?? 'audio-1');
  const tracks = tlOf(e).audio?.length ? tlOf(e).audio! : [{ id: 'audio-1', name: 'Audio 1', clips: [] }];
  const track = tracks.find((t) => t.id === id);
  if (!track) return;
  const v = await formDialog('Rename Audio Track', [{ name: 'name', label: 'Name', value: track.name }], 'Rename');
  const name = v?.name.trim().slice(0, 255);
  if (!name || name === track.name) return;
  return editTimeline(e, 'Rename Audio Track', (d) => {
    const t = editTrack(d.timeline!, id);
    if (!t) return false;
    t.name = name;
  });
}
export function toggleTrack(e: Editor, flag: 'muted' | 'solo', arg?: unknown) {
  const id = typeof arg === 'string' && arg ? arg : (selectedAudioTrack(e)?.id ?? 'audio-1');
  const on = !(tlOf(e).audio ?? []).find((t) => t.id === id)?.[flag];
  return editTimeline(e, `${on ? '' : 'Un'}${flag === 'muted' ? 'mute' : 'solo'} Audio Track`.replace(/^[a-z]/, (c) => c.toUpperCase()), (d) => {
    const t = editTrack(d.timeline!, id);
    if (!t) return false;
    if (on) t[flag] = true;
    else delete t[flag];
  });
}

// ----- Clip and track settings -----

export type AudioSettings = { clip?: string; track?: string; gain?: number; fadeIn?: number; fadeOut?: number; volume?: number };
/** Change clip gain or fades, or a track's volume (Timeline properties bar). */
export function setAudio(e: Editor, arg: unknown) {
  const a = (arg ?? {}) as AudioSettings;
  const tl = tlOf(e);
  const label = a.volume !== undefined ? 'Track Volume' : a.gain !== undefined ? 'Audio Clip Gain' : 'Audio Fades';
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  return editTimeline(e, label, (d) => {
    const t2 = d.timeline!;
    if (a.track && num(a.volume) !== undefined) {
      const t = editTrack(t2, a.track);
      if (!t) return false;
      const v = Math.round(clamp(a.volume!, volumeRange[0], volumeRange[1]) * 10) / 10;
      if (v) t.volume = v;
      else delete t.volume;
    }
    if (a.clip) {
      const hit = findAudioClip(t2, a.clip);
      const span = hit && clipSpan(d, hit.clip);
      if (!hit || !span) return false;
      const c = hit.clip;
      if (num(a.gain) !== undefined) {
        const g = Math.round(clamp(a.gain!, gainRange[0], gainRange[1]) * 10) / 10;
        if (g) c.gain = g;
        else delete c.gain;
      }
      for (const k of ['fadeIn', 'fadeOut'] as const) {
        const v = num(a[k]);
        if (v === undefined) continue;
        const s = Math.round(clamp(v, 0, span.length) * 1000) / 1000;
        if (s > 0) c[k] = s;
        else delete c[k];
      }
    }
    if (JSON.stringify(t2.audio) === JSON.stringify(tl.audio)) return false;
  });
}

/** Gain and fades of the selected clip in a dialog (context menu). */
export async function clipSettings(e: Editor) {
  const [id] = selectedAudioClips(e);
  const hit = id && findAudioClip(tlOf(e), id);
  const span = hit && clipSpan(e.doc, hit.clip);
  if (!hit || !span) return;
  const v = await formDialog(
    'Audio Clip Settings',
    [
      { name: 'gain', label: 'Gain (dB)', type: 'number', value: hit.clip.gain ?? 0, min: gainRange[0], max: gainRange[1], step: 0.5 },
      { name: 'fadeIn', label: 'Fade in (seconds)', type: 'number', value: hit.clip.fadeIn ?? 0, min: 0, max: Math.round(span.length * 1000) / 1000 },
      { name: 'fadeOut', label: 'Fade out (seconds)', type: 'number', value: hit.clip.fadeOut ?? 0, min: 0, max: Math.round(span.length * 1000) / 1000 },
    ],
    'OK',
    `${clipName(e.doc, hit.clip)}: ${span.length.toFixed(2)} s.`,
  );
  if (!v) return;
  return setAudio(e, { clip: id, gain: Number(v.gain), fadeIn: Number(v.fadeIn), fadeOut: Number(v.fadeOut) });
}
export function clipName(doc: PhotoDocument, c: AudioClip) {
  if (c.source) return c.source.name.replace(/\.[^.]+$/, '') || 'Audio';
  return (c.link && findLayer(doc.layers, c.link)?.name) || 'Video sound';
}

// ----- Clips -----

export function deleteClips(e: Editor) {
  const ids = new Set(selectedAudioClips(e));
  if (!ids.size) return;
  videoView(e).audioClips = [];
  return editTimeline(e, ids.size > 1 ? 'Delete Audio Clips' : 'Delete Audio Clip', (d) => {
    for (const t of d.timeline!.audio ?? []) t.clips = t.clips.filter((c) => !ids.has(c.id));
  });
}
/** An independent clip playing what `c` plays (linked clips become plain). */
function standalone(doc: PhotoDocument, c: AudioClip, id = c.id): AudioClip | undefined {
  const s = clipSpan(doc, c);
  if (!s?.source || s.length <= 0) return undefined;
  const out: AudioClip = { id, start: s.start, in: s.in, length: s.length, source: s.source };
  for (const k of ['gain', 'fadeIn', 'fadeOut'] as const) if (c[k] !== undefined) out[k] = c[k];
  return out;
}
/** Copies right after each selected clip, on the same track. */
export function duplicateClips(e: Editor) {
  const ids = selectedAudioClips(e);
  const made = ids.map(() => crypto.randomUUID());
  return editTimeline(e, ids.length > 1 ? 'Duplicate Audio Clips' : 'Duplicate Audio Clip', (d) => {
    const tl = d.timeline!;
    let changed = false;
    ids.forEach((id, i) => {
      const hit = findAudioClip(tl, id);
      const copy = hit && standalone(d, hit.clip, made[i]);
      if (!hit || !copy) return;
      copy.start += copy.length;
      hit.track.clips.splice(hit.index + 1, 0, copy);
      fit(tl, copy.start + copy.length);
      changed = true;
    });
    if (!changed) return false;
  }).then(() => {
    videoView(e).audioClips = made.filter((id) => findAudioClip(tlOf(e), id));
    e.update();
  });
}
/** Linked clips become independent clips of the footage's sound. */
export function unlinkClips(e: Editor) {
  const ids = selectedAudioClips(e).filter((id) => findAudioClip(tlOf(e), id)?.clip.link);
  return editTimeline(e, 'Unlink Audio', (d) => {
    let changed = false;
    for (const id of ids) {
      const hit = findAudioClip(d.timeline!, id);
      const plain = hit && standalone(d, hit.clip);
      if (!hit || !plain) continue;
      hit.track.clips[hit.index] = plain;
      changed = true;
    }
    if (!changed) return false;
  });
}
/** The video layers whose clips the selected linked clips follow. */
const linkedLayers = (e: Editor, ids: string[]) => [...new Set(ids.flatMap((id) => findAudioClip(tlOf(e), id)?.clip.link ?? []))].filter((id) => findLayer(e.doc.layers, id));

export async function splitAudio(e: Editor) {
  const tl = tlOf(e);
  const t = tl.current / tl.fps;
  const ids = selectedAudioClips(e);
  const plain = ids.filter((id) => !findAudioClip(tl, id)?.clip.link && splitAudioClip(findAudioClip(tl, id)!.clip, t, frame(tl) / 2));
  const layers = linkedLayers(e, ids);
  if (!plain.length && !layers.length) return e.message('Move the playhead inside a selected clip to split it.');
  const made: string[] = [];
  if (plain.length)
    await editTimeline(e, 'Split Audio at Playhead', (d) => {
      made.length = 0;
      for (const id of plain) {
        const hit = findAudioClip(d.timeline!, id);
        const parts = hit && splitAudioClip(hit.clip, t, frame(tl) / 2);
        if (!hit || !parts) continue;
        hit.track.clips.splice(hit.index, 1, ...parts);
        made.push(parts[1].id);
      }
    });
  // Linked sound splits with its video clip.
  if (layers.length) await splitAtPlayhead(e, layers);
  videoView(e).audioClips = made.length ? made : ids;
  e.update();
}
export async function trimAudio(e: Editor, edge: 'start' | 'end') {
  const tl = tlOf(e);
  const t = tl.current / tl.fps;
  const ids = selectedAudioClips(e);
  const plain = ids.filter((id) => findAudioClip(tl, id)?.clip.source);
  const layers = linkedLayers(e, ids);
  const label = edge === 'start' ? 'Trim Start to Playhead' : 'Trim End to Playhead';
  if (plain.length)
    await editTimeline(e, label, (d) => {
      const t2 = d.timeline!;
      let changed = false;
      for (const id of plain) {
        const hit = findAudioClip(t2, id)!;
        const c = hit.clip;
        const next = edge === 'start' ? trimSpanStart(c, t - c.start, frame(t2)) : trimSpanEnd(c, t + frame(t2) - (c.start + c.length), frame(t2), c.source!.seconds);
        if (next.start !== c.start || next.length !== c.length) changed = true;
        hit.track.clips[hit.index] = next;
      }
      if (!changed) return false;
    });
  // Linked sound trims with its video clip.
  if (layers.length) await trimToPlayhead(e, edge, layers);
}

export function toggleVideoMute(e: Editor) {
  const l = videoLayerOf(e);
  if (!l?.video.audio) return;
  return editTimeline(e, l.video.muted ? 'Unmute Video Sound' : 'Mute Video Sound', (d) => {
    const x = findLayer(d.layers, l.id)!;
    const v = { ...x.video! };
    if (v.muted) delete v.muted;
    else v.muted = true;
    x.video = v;
  });
}

// ----- Gestures from the panel -----

export type AudioDragMode = 'move' | 'start' | 'end';
/** What a drag by `d` seconds makes of a clip: a changed audio clip, or for
 * a linked clip the changed clip of its video layer (whole frames). */
export function dragResult(doc: PhotoDocument, c: AudioClip, mode: AudioDragMode, d: number): { audio?: AudioClip; video?: { id: string; clip: Clip } } | undefined {
  const tl = doc.timeline!;
  if (c.link) {
    const l = findLayer(doc.layers, c.link) as Layer | undefined;
    if (!l) return undefined;
    const v = tl.clips[l.id] ?? { start: 0, in: 0, length: tl.duration };
    const f = Math.round(d * tl.fps);
    const limit = contentLength(l, tl.fps);
    const clip = mode === 'move' ? moveClip(v, f, tl.duration) : mode === 'start' ? trimClipStart(v, f, limit) : trimClipEnd(v, f, limit);
    return { video: { id: l.id, clip } };
  }
  if (!c.source) return undefined;
  const min = frame(tl);
  return { audio: mode === 'move' ? moveSpan(c, d) : mode === 'start' ? trimSpanStart(c, d, min) : trimSpanEnd(c, d, min, c.source.seconds) };
}
/** Apply a drag of the panel to clips (one undo step); a moved clip can go
 * to another track. */
export function applyDrag(e: Editor, ids: string[], mode: AudioDragMode, d: number, toTrack?: string) {
  const label = mode === 'move' ? (ids.length > 1 ? 'Move Audio Clips' : 'Move Audio Clip') : 'Trim Audio Clip';
  const base = e.doc;
  return editTimeline(e, label, (doc) => {
    const tl = doc.timeline!;
    let changed = false;
    const moved: AudioClip[] = [];
    for (const id of ids) {
      const hit = findAudioClip(tl, id);
      const from = findAudioClip(base.timeline!, id);
      if (!hit || !from) continue;
      const r = dragResult(base, from.clip, mode, d);
      if (r?.audio) {
        hit.track.clips[hit.index] = r.audio;
        fit(tl, r.audio.start + r.audio.length);
        changed = true;
      } else if (r?.video) {
        const own = ownClip(tl, r.video.id);
        Object.assign(own, r.video.clip);
        changed = true;
      }
      if (mode === 'move' && toTrack && toTrack !== hit.track.id) moved.push(hit.track.clips[hit.index]);
    }
    if (moved.length) {
      const target = ownTracks(tl).find((t) => t.id === toTrack);
      if (target) {
        const gone = new Set(moved.map((c) => c.id));
        for (const t of tl.audio!) t.clips = t.clips.filter((c) => !gone.has(c.id));
        target.clips.push(...moved);
        changed = true;
      }
    }
    if (!changed) return false;
  });
}

export function purge() {
  purgeAudioCache();
}
