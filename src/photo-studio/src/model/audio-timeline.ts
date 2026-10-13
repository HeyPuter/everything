// Audio on the video timeline: audio tracks under the video tracks, each
// holding audio clips. A clip plays part of an audio file kept in the
// document's assets, or the sound of a video layer's footage ("linked" clips,
// which follow the video layer's clip: moving or trimming one changes the
// other). Clip gain and fades, track volume, mute and solo shape the mix.
//
// Times here are seconds (not timeline frames) so audio keeps its place
// when the frame rate changes and mixing stays sample accurate; editing in
// the panel snaps to frames. Linked clips store no times of their own.
//
// This module holds the model (types, linked clip resolution, the mix plan,
// clip edits, validation and the history hook part); decoding, mixing,
// playback and encoding live with the timeline features and in
// imaging/audio.
import { allLayers, findLayer, type Layer, type PhotoDocument } from './document';
import type { VideoTimeline } from './video-timeline';

/** An audio file (or the sound of a footage file) stored as an asset. */
export type AudioSource = {
  asset: string;
  name: string;
  // Media type of the original file (the asset is stored as an opaque source).
  type: string;
  seconds: number;
  channels: number;
  sampleRate: number;
};
export type AudioClip = {
  id: string;
  // Seconds on the timeline, into the source, and long (absent on linked clips).
  start: number;
  in: number;
  length: number;
  source?: AudioSource;
  // Video layer whose footage sound plays, in step with its clip.
  link?: string;
  // Gain in dB.
  gain?: number;
  // Fade lengths in seconds.
  fadeIn?: number;
  fadeOut?: number;
};
export type AudioTrack = {
  id: string;
  name: string;
  // Volume in dB.
  volume?: number;
  muted?: true;
  solo?: true;
  clips: AudioClip[];
};

export const defaultTrackId = 'audio-1';
export const maxAudioTracks = 32;
export const maxAudioClips = 2000;
export const maxAudioSeconds = 4 * 3600;
export const gainRange: [number, number] = [-60, 24];
export const volumeRange: [number, number] = [-60, 12];
export const audioFileLimit = 256 * 1024 * 1024;

export const dbToGain = (db: number) => (db <= gainRange[0] ? 0 : Math.pow(10, db / 20));
export const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const defaultTrack = (): AudioTrack => ({ id: defaultTrackId, name: 'Audio 1', clips: [] });

/** The audio tracks to show: a timeline without any shows one empty track. */
export function audioTracks(tl: VideoTimeline): AudioTrack[] {
  return tl.audio?.length ? tl.audio : [defaultTrack()];
}
/** The audio tracks of a timeline being edited (the default track is created). */
export function ownTracks(tl: VideoTimeline): AudioTrack[] {
  if (!tl.audio?.length) tl.audio = [defaultTrack()];
  return tl.audio;
}
/** A name for a new track ("Audio 2", ...). */
export function nextTrackName(tl: VideoTimeline) {
  const used = new Set(audioTracks(tl).map((t) => t.name));
  let n = audioTracks(tl).length + 1;
  while (used.has(`Audio ${n}`)) n++;
  return `Audio ${n}`;
}
export function findAudioClip(tl: VideoTimeline, id: string): { track: AudioTrack; clip: AudioClip; index: number } | undefined {
  for (const track of tl.audio ?? []) {
    const index = track.clips.findIndex((c) => c.id === id);
    if (index >= 0) return { track, clip: track.clips[index], index };
  }
  return undefined;
}
export const hasAudio = (tl: VideoTimeline | undefined) => !!tl?.audio?.some((t) => t.clips.length);
export const allAudioClips = (tl: VideoTimeline) => (tl.audio ?? []).flatMap((t) => t.clips);

// ----- Linked clips -----

type VideoWithAudio = Layer & { video: NonNullable<Layer['video']> & { audio: AudioSource } };
const videoAudioLayer = (doc: PhotoDocument, id: string): VideoWithAudio | undefined => {
  const l = findLayer(doc.layers, id);
  return l?.kind === 'pixel' && l.video?.audio ? (l as VideoWithAudio) : undefined;
};

/** Where a clip plays: its own times, or for a linked clip the times of
 * the video layer's clip (cut to the footage sound: a clip of looping
 * footage extended before the footage's start is silent until it). */
export type ClipSpan = { start: number; in: number; length: number; source?: AudioSource; muted: boolean; linked: boolean };
export function clipSpan(doc: PhotoDocument, c: AudioClip): ClipSpan | undefined {
  if (!c.link) return { start: c.start, in: c.in, length: c.length, source: c.source, muted: false, linked: false };
  const tl = doc.timeline;
  const l = tl && videoAudioLayer(doc, c.link);
  if (!tl || !l) return undefined;
  const v = tl.clips[l.id] ?? { start: 0, in: 0, length: tl.duration };
  // Content before the footage's first frame (in < 0) has no sound.
  const lead = Math.max(0, -v.in / tl.fps);
  const start = v.start / tl.fps + lead,
    at = Math.max(0, v.in / tl.fps);
  const length = Math.min(v.length / tl.fps - lead, l.video.audio.seconds - at);
  return { start, in: at, length: Math.max(0, length), source: l.video.audio, muted: !!l.video.muted, linked: true };
}

/** A linked clip for a video layer with sound. */
export function linkedClip(layerId: string, like?: AudioClip): AudioClip {
  const c: AudioClip = { id: crypto.randomUUID(), start: 0, in: 0, length: 0, link: layerId };
  if (like?.gain !== undefined) c.gain = like.gain;
  return c;
}
/** Give a video layer with sound a linked clip (on the first track, or the
 * track of `like`). */
export function linkFootageAudio(tl: VideoTimeline, layerId: string, like?: { track: AudioTrack; clip: AudioClip }) {
  const tracks = ownTracks(tl);
  const track = (like && tracks.find((t) => t.id === like.track.id)) ?? tracks[0];
  track.clips.push(linkedClip(layerId, like?.clip));
}

/** Split the sound of video layer `from` with its clip (call once both
 * parts have their clips): the second part `to`, new in this edit, gets a
 * linked clip after the original's, on its track, with its gain and fade
 * out; the first part keeps the fade in. A layer whose sound was unlinked
 * or deleted splits into parts without sound. */
export function splitLinkedSound(doc: PhotoDocument, from: string, to: string) {
  const tl = doc.timeline!;
  for (const track of tl.audio ?? []) {
    const index = track.clips.findIndex((c) => c.link === from);
    if (index < 0) continue;
    const a = track.clips[index];
    const b = linkedClip(to, a);
    if (a.fadeOut) b.fadeOut = a.fadeOut;
    delete a.fadeOut;
    track.clips.splice(index + 1, 0, b);
    for (const [c, k] of [[a, 'fadeIn'], [b, 'fadeOut']] as const) {
      const length = clipSpan(doc, c)?.length ?? 0;
      if (c[k]) c[k] = Math.min(c[k], length);
      if (!c[k]) delete c[k];
    }
    return;
  }
  (tl.soundless ??= []).push(to);
}

/** History hook: linked clips of deleted layers (or of layers that lost
 * their sound) go; video layers with sound that are new in this edit
 * (imported, duplicated or pasted; split parts are linked by the split)
 * get a linked clip. */
export function syncAudio(after: PhotoDocument, before?: PhotoDocument) {
  const tl = after.timeline;
  if (!tl) return;
  const soundless = new Set(tl.soundless);
  delete tl.soundless;
  const layers = allLayers(after.layers);
  const sounding = new Map(layers.filter((l) => l.kind === 'pixel' && l.video?.audio).map((l) => [l.id, l]));
  if (tl.audio) for (const t of tl.audio) t.clips = t.clips.filter((c) => !c.link || sounding.has(c.link));
  if (!sounding.size) return;
  const linked = new Set(allAudioClips(tl).flatMap((c) => (c.link ? [c.link] : [])));
  const old = before?.timeline ? new Set(allLayers(before.layers).map((l) => l.id)) : new Set<string>();
  for (const [id, l] of sounding) {
    if (linked.has(id) || old.has(id) || soundless.has(id)) continue;
    // A copy of a layer keeps the track and gain of the original's clip.
    const twin = allAudioClips(tl).find((c) => c.link && sounding.get(c.link)?.video?.audio?.asset === l.video!.audio!.asset);
    const where = twin && findAudioClip(tl, twin.id);
    linkFootageAudio(tl, id, where);
    linked.add(id);
  }
}

// ----- Mix plan -----

/** One clip as the mixer plays it: `length` seconds of `source` from
 * `offset`, placed at `at` on the timeline, with a gain (linear, including
 * the track volume) and linear fades. */
export type PlanItem = { source: AudioSource; at: number; offset: number; length: number; gain: number; fadeIn: number; fadeOut: number; clip: string };
/** The clips that sound: muted tracks are silent; when any track is solo,
 * only solo tracks play. Clips of muted video layers are silent. */
export function audioPlan(doc: PhotoDocument): PlanItem[] {
  const tl = doc.timeline;
  if (!tl?.audio) return [];
  const solo = tl.audio.some((t) => t.solo);
  const out: PlanItem[] = [];
  for (const t of tl.audio) {
    if (t.muted || (solo && !t.solo)) continue;
    for (const c of t.clips) {
      const s = clipSpan(doc, c);
      if (!s?.source || s.muted || s.length <= 0) continue;
      const gain = dbToGain((c.gain ?? 0) + (t.volume ?? 0));
      if (gain <= 0) continue;
      const fadeIn = clamp(c.fadeIn ?? 0, 0, s.length),
        fadeOut = clamp(c.fadeOut ?? 0, 0, s.length);
      out.push({ source: s.source, at: s.start, offset: s.in, length: s.length, gain, fadeIn, fadeOut, clip: c.id });
    }
  }
  return out;
}

/** Fraction of the gain `t` seconds into a clip: linear fades, and fades
 * that overlap meet where their ramps cross (the lower ramp applies). */
export function fadeShape(t: number, fadeIn: number, fadeOut: number, length: number) {
  let f = 1;
  if (fadeIn > 0 && t < fadeIn) f = t / fadeIn;
  if (fadeOut > 0 && t > length - fadeOut) f = Math.min(f, (length - t) / fadeOut);
  return f;
}
/** Gain of a plan item at `t` seconds into the clip (see `fadeShape`). */
export function envelopeAt(p: Pick<PlanItem, 'gain' | 'fadeIn' | 'fadeOut' | 'length'>, t: number) {
  if (t < 0 || t > p.length) return 0;
  return p.gain * fadeShape(t, p.fadeIn, p.fadeOut, p.length);
}
/** The corners of the gain envelope, as [seconds into the clip, gain]:
 * straight lines between them trace `envelopeAt` exactly. */
export function envelopePoints(p: Pick<PlanItem, 'gain' | 'fadeIn' | 'fadeOut' | 'length'>): [number, number][] {
  const times = [0, p.fadeIn, p.length - p.fadeOut, p.length];
  // Overlapping fades: the point where the ramps cross.
  if (p.fadeIn > 0 && p.fadeOut > 0 && p.fadeIn + p.fadeOut > p.length) times.push((p.fadeIn * p.length) / (p.fadeIn + p.fadeOut));
  const inside = times.filter((t) => t >= 0 && t <= p.length).sort((a, b) => a - b);
  return [...new Set(inside)].map((t) => [t, envelopeAt(p, t)]);
}

// ----- Clip edits (seconds) -----

export type Span = { start: number; in: number; length: number };
/** Move a clip by `d` seconds (it cannot start before the timeline). */
export const moveSpan = <T extends Span>(c: T, d: number): T => ({ ...c, start: Math.max(0, c.start + d) });
/** Move the clip's start by `d` (positive trims, negative extends up to the
 * start of the source and of the timeline); `min` is the shortest length. */
export function trimSpanStart<T extends Span>(c: T, d: number, min: number): T {
  let start = Math.min(c.start + d, c.start + c.length - min);
  start = Math.max(start, 0, c.start - c.in);
  const by = start - c.start;
  return { ...c, start, in: c.in + by, length: c.length - by };
}
/** Move the clip's end by `d`, up to the end of the source (`limit` seconds). */
export function trimSpanEnd<T extends Span>(c: T, d: number, min: number, limit = Infinity): T {
  return { ...c, length: Math.max(min, Math.min(c.length + d, limit - c.in)) };
}
/** Split at timeline second `t`: the first part keeps the fade in, the
 * second the fade out. Null when `t` is not inside the clip. */
export function splitAudioClip(c: AudioClip, t: number, minLength = 1e-3): [AudioClip, AudioClip] | null {
  if (c.link || t <= c.start + minLength || t >= c.start + c.length - minLength) return null;
  const a: AudioClip = { ...c, length: t - c.start };
  delete a.fadeOut;
  const b: AudioClip = { ...c, id: crypto.randomUUID(), start: t, in: c.in + (t - c.start), length: c.start + c.length - t };
  delete b.fadeIn;
  if (a.fadeIn) a.fadeIn = Math.min(a.fadeIn, a.length);
  if (b.fadeOut) b.fadeOut = Math.min(b.fadeOut, b.length);
  return [a, b];
}
/** The nearest snapping time within `tolerance`, or `t`. */
export function snapTime(t: number, targets: number[], tolerance: number) {
  let best = t,
    dist = tolerance;
  for (const x of targets) {
    const d = Math.abs(x - t);
    if (d <= dist) {
      best = x;
      dist = d;
    }
  }
  return best;
}

// ----- Validation (projects) -----

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
const seconds = (n: unknown) => finite(n) && n >= 0 && n <= maxAudioSeconds;
export function validAudioSource(s: AudioSource | undefined) {
  return (
    !!s &&
    typeof s === 'object' &&
    typeof s.asset === 'string' &&
    !!s.asset &&
    typeof s.name === 'string' &&
    s.name.length <= 1024 &&
    typeof s.type === 'string' &&
    s.type.length <= 255 &&
    seconds(s.seconds) &&
    s.seconds > 0 &&
    Number.isInteger(s.channels) &&
    s.channels >= 1 &&
    s.channels <= 32 &&
    finite(s.sampleRate) &&
    s.sampleRate >= 1000 &&
    s.sampleRate <= 768000
  );
}
export function validateAudio(tracks: unknown) {
  const bad = () => new Error('Invalid audio tracks.');
  if (tracks === undefined) return;
  if (!Array.isArray(tracks) || tracks.length > maxAudioTracks) throw bad();
  const ids = new Set<string>();
  let clips = 0;
  for (const t of tracks as AudioTrack[]) {
    if (!t || typeof t !== 'object' || typeof t.id !== 'string' || !t.id || ids.has(t.id) || typeof t.name !== 'string' || t.name.length > 255 || !Array.isArray(t.clips)) throw bad();
    ids.add(t.id);
    if (t.volume !== undefined && !(finite(t.volume) && t.volume >= volumeRange[0] && t.volume <= volumeRange[1])) throw bad();
    if ((t.muted !== undefined && t.muted !== true) || (t.solo !== undefined && t.solo !== true)) throw bad();
    clips += t.clips.length;
    if (clips > maxAudioClips) throw bad();
    for (const c of t.clips) {
      if (!c || typeof c !== 'object' || typeof c.id !== 'string' || !c.id || ids.has(c.id)) throw bad();
      ids.add(c.id);
      if (![c.start, c.in, c.length].every(seconds)) throw bad();
      if (c.link !== undefined ? typeof c.link !== 'string' || c.source !== undefined : !validAudioSource(c.source) || c.length <= 0) throw bad();
      if (c.gain !== undefined && !(finite(c.gain) && c.gain >= gainRange[0] && c.gain <= gainRange[1])) throw bad();
      if ((c.fadeIn !== undefined && !seconds(c.fadeIn)) || (c.fadeOut !== undefined && !seconds(c.fadeOut))) throw bad();
    }
  }
}
