// Playing the video timeline on the canvas in real time. Each displayed
// frame is a preview of the document at that time (nothing enters history);
// frames whose video is still decoding are skipped, so playback keeps time
// on slow machines. Playback loops over the work area until stopped (or
// plays it once with looping off); stopping shows the frame on screen as
// the current time. Edits and document switches stop it. Sound plays along
// (audio-playback.ts); while it does, its clock drives the frame shown.
import type { Editor } from '../../editor';
import type { DocumentSession } from '../../app/session';
import type { PhotoDocument } from '../../model/document';
import { neededFrames, timeDocument, workArea } from '../../model/video-timeline-ops';
import { cacheLookup, prefetchFrames, setTime } from './video-frames';
import { videoPlayback, videoView } from './video-state';
import { audioElapsed, startAudio, stopAudio } from './audio-playback';

type Playing = { session: DocumentSession; doc: PhotoDocument; t0: number; from: number; range: [number, number]; shown: number; raf: number; loop: boolean; last?: PhotoDocument };
let playing: Playing | undefined;
const listeners = new Set<() => void>();
/** Called whenever the frame on screen changes or playback starts or stops. */
export function onVideoPlayback(fn: () => void) {
  listeners.add(fn);
}
const notify = () => listeners.forEach((fn) => fn());
const ahead = 6;

export function playVideo(e: Editor) {
  const tl = e.doc.timeline;
  if (!tl || playing) return;
  const range = workArea(tl);
  const from = tl.current >= range[1] - 1 || tl.current < range[0] ? range[0] : tl.current;
  playing = { session: e.session, doc: e.doc, t0: performance.now(), from, range, shown: -1, raf: 0, loop: videoView(e).loop !== false };
  videoPlayback.session = e.session;
  videoPlayback.frame = from;
  notify();
  const p = playing;
  void startAudio(e.session, e.doc, from / tl.fps, [range[0] / tl.fps, range[1] / tl.fps], p.loop, () => (performance.now() - p.t0) / 1000).catch(() => {});
  tick(e);
}

function tick(e: Editor) {
  const p = playing;
  const tl = p?.doc.timeline;
  if (!p || !tl) return;
  const [a, b] = p.range;
  const elapsed = audioElapsed() ?? (performance.now() - p.t0) / 1000;
  let f = p.from + Math.max(0, Math.floor(elapsed * tl.fps + 1e-6));
  if (f >= b) {
    if (!p.loop) {
      showFrame(e, p, b - 1);
      return stopVideo(e);
    }
    f = a + ((f - a) % (b - a));
  }
  if (f !== p.shown) showFrame(e, p, f);
  p.raf = requestAnimationFrame(() => tick(e));
}

function showFrame(e: Editor, p: Playing, f: number) {
  const lookup = cacheLookup(p.session);
  const ready = neededFrames(p.doc, f).every((n) => lookup(n.layer, n.k, n.source));
  // Decode the next frames while this one shows.
  for (let k = 0; k <= ahead; k++) prefetchFrames(p.session, p.doc, wrap(p, f + k));
  if (!ready) return;
  p.last = timeDocument(p.doc, f, lookup);
  p.shown = f;
  videoPlayback.frame = f;
  e.preview(p.last);
  notify();
}
const wrap = (p: Playing, f: number) => (f < p.range[1] ? f : p.range[0] + ((f - p.range[0]) % (p.range[1] - p.range[0])));

/** Stop playing; with `select`, the frame on screen becomes the current time. */
export function stopVideo(e: Editor, select = true) {
  const p = playing;
  if (!p) return;
  cancelAnimationFrame(p.raf);
  playing = undefined;
  stopAudio();
  videoPlayback.session = undefined;
  notify();
  if (select && e.session === p.session && e.doc === p.doc && p.shown >= 0) void setTime(e, p.shown);
  else e.update();
}
export function toggleVideo(e: Editor) {
  if (playing) stopVideo(e);
  else playVideo(e);
}

/** Keep playback in step with the editor: edits and tab switches stop it;
 * other updates keep showing the playing frame. */
export function videoPlaybackUpdate(e: Editor) {
  const p = playing;
  if (!p) return;
  if (p.session !== e.session || p.doc !== e.doc) {
    cancelAnimationFrame(p.raf);
    playing = undefined;
    stopAudio();
    videoPlayback.session = undefined;
    notify();
    return;
  }
  // The update loop previews the document after its hooks; show the frame after it.
  queueMicrotask(() => {
    if (playing === p && p.last) e.preview(p.last);
  });
}
