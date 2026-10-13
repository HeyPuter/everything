// Video timeline state that menus, the panel and hooks read at any time
// (kept apart from the implementation, which loads on first use): the
// document's timeline, the selected video layer, per-document Timeline view
// settings (zoom, selected keyframes, expanded tracks) and playback.
import type { Editor } from '../../editor';
import type { DocumentSession } from '../../app/session';
import type { Layer } from '../../model/document';
import type { VideoLayerData } from '../../model/video-layer';
import type { KeyProperty } from '../../model/video-timeline';

export type VideoLayer = Layer & { video: VideoLayerData };
export const timelineOf = (e: Editor) => (e.hasDocument ? e.doc.timeline : undefined);
export const hasTimeline = (e: Editor) => !!timelineOf(e);
export const isVideoLayer = (l: Layer | undefined): l is VideoLayer => !!l?.video && l.kind === 'pixel';
/** The selected video layer (one layer selected). */
export const videoLayerOf = (e: Editor): VideoLayer | undefined => {
  if (!hasTimeline(e) || e.selectedIds.size !== 1) return undefined;
  const l = e.layer;
  return isVideoLayer(l) ? l : undefined;
};
export const hasVideoLayers = (e: Editor) => e.hasDocument && hasVideo(e.doc.layers);
const hasVideo = (layers: Layer[]): boolean => layers.some((l) => isVideoLayer(l) || hasVideo(l.children));

/** A selected keyframe: layer, property and content frame. */
export type KeyRef = { id: string; prop: KeyProperty; t: number };
export type VideoView = {
  // Pixels per timeline frame.
  zoom: number;
  keys: KeyRef[];
  // Layers whose keyframe lanes are open.
  expanded: Set<string>;
  // Playback loops over the work area.
  loop: boolean;
  // Selected audio clips (clip commands act on them while any is selected)
  // and the audio track that receives new clips.
  audioClips: string[];
  audioTrack: string;
  // Play short snippets of sound while scrubbing.
  scrubAudio: boolean;
};
const views = new WeakMap<DocumentSession, VideoView>();
export function videoView(e: Editor): VideoView {
  let v = views.get(e.session);
  if (!v) views.set(e.session, (v = { zoom: 0, keys: [], expanded: new Set(), loop: true, audioClips: [], audioTrack: '', scrubAudio: false }));
  return v;
}
/** The selected audio clips that still exist. */
export function selectedAudioClips(e: Editor) {
  const tl = timelineOf(e);
  if (!tl?.audio) return [];
  const ids = new Set(tl.audio.flatMap((t) => t.clips.map((c) => c.id)));
  return videoView(e).audioClips.filter((id) => ids.has(id));
}
/** The selected audio track (the first track when none is selected). */
export function selectedAudioTrack(e: Editor) {
  const tl = timelineOf(e);
  if (!tl) return undefined;
  const tracks = tl.audio?.length ? tl.audio : undefined;
  if (!tracks) return undefined;
  const id = videoView(e).audioTrack;
  return tracks.find((t) => t.id === id) ?? tracks.find((t) => t.clips.some((c) => videoView(e).audioClips.includes(c.id))) ?? tracks[0];
}

// Playback (set by the playback module while a timeline plays).
export const videoPlayback: { session?: DocumentSession; frame: number } = { frame: 0 };
export const isVideoPlaying = (e?: Editor) => !!videoPlayback.session && (!e || videoPlayback.session === e.session);
