// Live sound for timeline playback (loaded with playback): the clips of the
// mix plan are scheduled on a Web Audio context as buffer sources with gain
// envelopes, in segments of timeline time (the stretch from the playhead to
// the end of the range, then the range again for every loop, scheduled a
// little ahead). While sound plays, the audio clock drives the playback
// clock, so pictures follow the sound and dropped frames never shift it.
import type { DocumentSession } from '../../app/session';
import type { PhotoDocument } from '../../model/document';
import { audioPlan, envelopeAt, envelopePoints, type PlanItem } from '../../model/audio-timeline';
import { audioPcm, loadAll } from './audio-media';
import type { Pcm } from '../../imaging/audio/mix';

let ctx: AudioContext | undefined;
const buffers = new WeakMap<Pcm, AudioBuffer>();
function context() {
  if (!ctx) ctx = new AudioContext({ latencyHint: 'interactive' });
  return ctx;
}
function bufferOf(c: BaseAudioContext, pcm: Pcm) {
  let b = buffers.get(pcm);
  if (!b) {
    b = c.createBuffer(pcm.channels.length, pcm.channels[0].length, pcm.sampleRate);
    pcm.channels.forEach((ch, i) => b!.copyToChannel(ch as Float32Array<ArrayBuffer>, i));
    buffers.set(pcm, b);
  }
  return b;
}

/** Schedule the part of `items` inside timeline seconds [from, to) to start
 * at context time `when`, into `out`. Returns the sources started. */
export function scheduleSegment(c: BaseAudioContext, out: AudioNode, items: PlanItem[], from: number, to: number, when: number): AudioBufferSourceNode[] {
  const started: AudioBufferSourceNode[] = [];
  for (const item of items) {
    const a = Math.max(item.at, from),
      b = Math.min(item.at + item.length, to);
    if (b - a < 1e-4) continue;
    const pcm = audioPcm(item.source);
    const local0 = a - item.at,
      local1 = b - item.at;
    const offset = item.offset + local0;
    if (!pcm || offset >= pcm.channels[0].length / pcm.sampleRate) continue;
    const src = c.createBufferSource();
    src.buffer = bufferOf(c, pcm);
    const gain = c.createGain();
    // The envelope from the segment start: its value there, then its corners.
    const at = (local: number) => when + (item.at + local - from);
    gain.gain.setValueAtTime(envelopeAt(item, local0), Math.max(0, at(local0)));
    for (const [t, g] of envelopePoints(item)) if (t > local0 && t <= local1) gain.gain.linearRampToValueAtTime(g, at(t));
    src.connect(gain).connect(out);
    src.start(Math.max(0, at(local0)), offset, b - a);
    started.push(src);
  }
  return started;
}

type Playing = {
  session: DocumentSession;
  doc: PhotoDocument;
  items: PlanItem[];
  master: GainNode;
  sources: AudioBufferSourceNode[];
  // Context time at which playback started at timeline second `from`.
  t0: number;
  from: number;
  range: [number, number];
  loop: boolean;
  // Loops scheduled so far (0: only the first stretch).
  loops: number;
  timer: number;
  ready: boolean;
};
let playing: Playing | undefined;

/** Start the sound of `doc` at timeline second `from`, `elapsed` seconds
 * after playback started (sound joins late when it is still decoding). */
export async function startAudio(session: DocumentSession, doc: PhotoDocument, from: number, range: [number, number], loop: boolean, elapsed: () => number) {
  stopAudio();
  const items = audioPlan(doc);
  if (!items.length) return;
  const c = context();
  const master = c.createGain();
  master.connect(c.destination);
  const p: Playing = { session, doc, items, master, sources: [], t0: 0, from, range, loop, loops: 0, timer: 0, ready: false };
  playing = p;
  if (c.state !== 'running') void c.resume().catch(() => {});
  await loadAll(session, items.map((i) => i.source));
  if (playing !== p) return;
  // Line the audio clock up with the playback clock.
  p.t0 = c.currentTime - elapsed();
  p.ready = true;
  topUp(p, c);
  p.timer = window.setInterval(() => topUp(p, c), 200);
}
/** Schedule the stretches that start within the next moments: stretch 0 is
 * [from, end of range), every further one the whole range (when looping).
 * A stretch already under way starts where the clock is now. */
function topUp(p: Playing, c: AudioContext) {
  if (playing !== p) return;
  const [a, b] = p.range;
  const len = b - a;
  const lead = 0.03;
  for (;;) {
    const k = p.loops;
    if (k > 0 && (!p.loop || len <= 0)) break;
    const from = k === 0 ? p.from : a;
    const begins = p.t0 + (k === 0 ? 0 : b - p.from + (k - 1) * len);
    if (begins - c.currentTime > 1.5) break;
    const now = c.currentTime + lead;
    const skip = Math.max(0, now - begins);
    if (from + skip < b) p.sources.push(...scheduleSegment(c, p.master, p.items, from + skip, b, begins + skip));
    p.loops++;
    // Forget sources that have finished.
    if (p.sources.length > 512) p.sources = p.sources.slice(-256);
  }
}

/** Seconds since playback started by the audio clock, while sound plays. */
export function audioElapsed(): number | undefined {
  const p = playing;
  if (!p?.ready || !ctx || ctx.state !== 'running') return undefined;
  // What is heard now was scheduled one output latency ago.
  return ctx.currentTime - p.t0 - (ctx.outputLatency || 0);
}
export const isAudioPlaying = () => !!playing;

export function stopAudio() {
  const p = playing;
  if (!p) return;
  playing = undefined;
  clearInterval(p.timer);
  const c = ctx!;
  // A short release avoids a click.
  p.master.gain.setValueAtTime(p.master.gain.value, c.currentTime);
  p.master.gain.linearRampToValueAtTime(0, c.currentTime + 0.015);
  for (const s of p.sources)
    try {
      s.stop(c.currentTime + 0.02);
    } catch {
      /* Not started yet. */
    }
  setTimeout(() => p.master.disconnect(), 60);
}

let snippet: { master: GainNode } | undefined;
/** Play a short snippet of the mix at timeline second `t` (scrubbing). */
export function scrubAudio(session: DocumentSession, doc: PhotoDocument, t: number, seconds = 0.09) {
  if (playing) return;
  const items = audioPlan(doc).filter((i) => i.at < t + seconds && i.at + i.length > t);
  if (!items.length) return;
  const c = context();
  if (c.state !== 'running') void c.resume().catch(() => {});
  if (items.some((i) => !audioPcm(i.source))) {
    void loadAll(session, items.map((i) => i.source));
    return;
  }
  snippet?.master.disconnect();
  const master = c.createGain();
  const now = c.currentTime + 0.01;
  master.gain.setValueAtTime(0, now);
  master.gain.linearRampToValueAtTime(1, now + 0.008);
  master.gain.setValueAtTime(1, now + seconds - 0.012);
  master.gain.linearRampToValueAtTime(0, now + seconds);
  master.connect(c.destination);
  scheduleSegment(c, master, items, t, t + seconds, now);
  snippet = { master };
  setTimeout(() => {
    master.disconnect();
    if (snippet?.master === master) snippet = undefined;
  }, (seconds + 0.1) * 1000);
}
