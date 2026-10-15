// Sound strip playback (Web Audio, follows timeline playback) and offline mixdown.
import { app } from '../app/app';
import type { SequenceEditor, Strip, SeqChannel } from './types';
import { finalStart, finalEnd } from './strips';
import { loadSound, MIX_RATE } from './media';
import { soundSegment, panGains } from './wav';
import { keysOf, keyValue } from './fades';
import { hasRetiming, retimedPieces } from './retime';

interface Voice {
  s: Strip;
  /** clip range (meta strips limit their children) */
  from: number;
  to: number;
}

/** Audible sound strips (recursing into metas, honouring mute and channel mute). */
export function soundVoices(ed: SequenceEditor): Voice[] {
  const out: Voice[] = [];
  const walk = (list: Strip[], channels: SeqChannel[] | undefined, from: number, to: number) => {
    for (const s of list) {
      if (s.mute || channels?.[s.channel]?.mute) continue;
      if (s.type === 'SOUND' && s.media) out.push({ s, from, to });
      else if (s.type === 'META' && s.strips) walk(s.strips, s.channels, Math.max(from, finalStart(s)), Math.min(to, finalEnd(s)));
    }
  };
  walk(ed.strips, ed.channels, -Infinity, Infinity);
  return out;
}

function schedule(ctx: BaseAudioContext, dest: AudioNode, buf: AudioBuffer, v: Voice, fps: number, from: number, t0: number, to = Infinity): AudioBufferSourceNode[] {
  const lo = Math.max(from, v.from),
    hi = Math.min(to, v.to);
  // constant-rate pieces: one for plain strips, one per speed segment for retimed strips
  const pieces: { delay: number; offset: number; duration: number; rate: number }[] = [];
  if (hasRetiming(v.s)) {
    for (const p of retimedPieces(v.s, lo, hi)) {
      if (p.rate < 0.01) continue; // frozen: silence
      pieces.push({ delay: (p.start - from) / fps, offset: (v.s.animation_offset_start + p.content) / fps + (v.s.sound_offset ?? 0), duration: ((p.end - p.start) * p.rate) / fps, rate: p.rate });
    }
  } else {
    const seg = soundSegment(v.s, fps, lo, hi);
    if (seg) pieces.push({ delay: seg.delay + (lo - from) / fps, offset: seg.offset, duration: seg.duration, rate: 1 });
  }
  const live = pieces.filter((p) => p.offset < buf.duration);
  if (!live.length) return [];
  const gain = ctx.createGain();
  gain.gain.value = Math.max(0, v.s.volume ?? 1);
  const keys = keysOf(v.s, 'volume');
  if (keys) {
    // fade keys: ramp the gain between them on the audio clock (frame f plays at t0 + (f - from) / fps)
    const at = (f: number) => t0 + (f - from) / fps;
    gain.gain.setValueAtTime(Math.max(0, keyValue(keys, from)), t0);
    for (const [f, val] of keys) if (f > from) gain.gain.linearRampToValueAtTime(Math.max(0, val), at(f));
  }
  let node: AudioNode = gain;
  const pan = v.s.pan ?? 0;
  if (pan) {
    // explicit linear pan (matches panGains used in tests)
    const split = ctx.createChannelSplitter(2);
    const merge = ctx.createChannelMerger(2);
    const [l, r] = panGains(pan);
    const gl = ctx.createGain(),
      gr = ctx.createGain();
    gl.gain.value = l;
    gr.gain.value = r;
    if (buf.numberOfChannels === 1) {
      gain.connect(gl);
      gain.connect(gr);
    } else {
      gain.connect(split);
      split.connect(gl, 0);
      split.connect(gr, 1);
    }
    gl.connect(merge, 0, 0);
    gr.connect(merge, 0, 1);
    node = merge;
  }
  node.connect(dest);
  return live.map((p) => {
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = p.rate;
    src.connect(gain);
    src.start(t0 + p.delay, p.offset, Math.min(p.duration, buf.duration - p.offset));
    return src;
  });
}

// ---------------------------------------------------------------------------
// live playback

let ctx: AudioContext | null = null;
let voices: AudioBufferSourceNode[] = [];
let master: GainNode | null = null;
let startFrame = 0;
let startTime = 0;
let active = false;
let starting = false;
let generation = 0;

function stopAll() {
  for (const v of voices)
    try {
      v.stop();
      v.disconnect();
    } catch {
      /* already stopped */
    }
  voices = [];
  active = false;
  generation++;
}

async function startAt(frame: number) {
  stopAll();
  const ed = app.doc.scene.sequence_editor;
  if (!ed) return;
  const list = soundVoices(ed);
  if (!list.length) return;
  ctx ??= new AudioContext({ latencyHint: 'interactive' });
  if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
  master ??= ctx.createGain();
  master.connect(ctx.destination);
  const gen = ++generation;
  const fps = app.doc.scene.render.fps / (app.doc.scene.render.fps_base || 1);
  const bufs = await Promise.all(list.map((v) => loadSound(v.s.media!.bytes)));
  if (gen !== generation || !app.playing) return;
  void frame;
  // start from where the timeline is now (decoding may have taken a moment)
  startTime = ctx.currentTime + 0.03;
  const from = app.doc.scene.frame_current;
  startFrame = from;
  for (let i = 0; i < list.length; i++) {
    const b = bufs[i];
    if (!b) continue;
    voices.push(...schedule(ctx, master, b, list[i], fps, from, startTime));
  }
  active = true;
}

/** Keep audio in step with timeline playback (called on every app update). */
export function syncPlayback() {
  const s = app.doc.scene;
  if (app.playing !== 'forward') {
    if (active || voices.length) stopAll();
    return;
  }
  const fps = s.render.fps / (s.render.fps_base || 1);
  if (!active) {
    if (!starting) {
      starting = true;
      void startAt(s.frame_current).finally(() => (starting = false));
    }
    return;
  }
  const expected = startFrame + (ctx!.currentTime - startTime) * fps;
  // loops and jumps restart the voices
  if (Math.abs(s.frame_current - expected) > Math.max(3, fps * 0.25)) void startAt(s.frame_current);
}

/** Restart audio after edits during playback (strip moved, volume changed…). */
export function restartPlayback() {
  if (app.playing === 'forward') void startAt(app.doc.scene.frame_current);
}

// ---------------------------------------------------------------------------
// mixdown

/** Render the timeline's audio for frames [from, to) into an AudioBuffer. */
export async function mixdown(ed: SequenceEditor, fps: number, from: number, to: number, rate = MIX_RATE, channels = 2): Promise<AudioBuffer> {
  const len = Math.max(1, Math.ceil(((to - from) / fps) * rate));
  const off = new OfflineAudioContext(channels, len, rate);
  const list = soundVoices(ed);
  const bufs = await Promise.all(list.map((v) => loadSound(v.s.media!.bytes)));
  for (let i = 0; i < list.length; i++) {
    const b = bufs[i];
    if (b) schedule(off, off.destination, b, list[i], fps, from, 0, to);
  }
  return off.startRendering();
}

export function hasSound(ed: SequenceEditor | null | undefined) {
  return !!ed && soundVoices(ed).length > 0;
}

/** Playback state (for diagnostics and tests). */
export function playbackState() {
  return { active, voices: voices.length, context: ctx?.state ?? 'none' };
}
