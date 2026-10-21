// The live preview's playback of media elements (jsdom: elements are stand-ins).
import { describe, it, expect, afterEach } from 'vitest';
import { EditorStore } from '../src/model/store.js';
import { Player } from '../src/engine/player.js';
import { evaluate } from '../src/engine/scene.js';
import { fixture, clip, onMain, s } from './helpers.js';

const players = [];
afterEach(() => {
  for (const p of players.splice(0)) p.dispose();
});

/** A player whose pool hands out fake elements: { el, gain } per clip id. */
function setup(project) {
  const store = new EditorStore(project);
  const player = new Player({ store, library: { mediaURL: () => 'blob:x' }, canvas: document.createElement('canvas') });
  players.push(player);
  const entries = new Map();
  const pool = player.pool;
  pool.audioCtx = { currentTime: 0, close: () => Promise.resolve() };
  pool.claim = (c) => {
    let e = entries.get(c.id);
    if (!e) {
      const el = {
        paused: true, currentTime: 0, playbackRate: 1, readyState: 4, seeking: false, plays: 0, seeks: 0,
        play() { this.paused = false; this.plays++; return Promise.resolve(); },
        pause() { this.paused = true; },
      };
      let t = 0;
      Object.defineProperty(el, 'currentTime', { get: () => t, set: (v) => { t = v; el.seeks++; } });
      e = { el, clipId: c.id, gain: { gain: { value: 0, setTargetAtTime(v) { this.value = v; } } } };
      entries.set(c.id, e);
    }
    return e;
  };
  pool.seek = (e, sec) => (e.el.currentTime = sec);
  pool.endFrame = () => {};
  player.playing = true;
  const frame = (t) => player._syncMedia(t, evaluate(store.project, t));
  return { player, entries, frame };
}

describe('preview playback through transitions', () => {
  it('silences the outgoing clip once its cut has passed, as the export does', () => {
    const p = fixture();
    const [a, b] = onMain(p, clip('video', 0, 5, { transition: { id: 'mix', duration: s(2) } }), clip('video', 5, 5, { in: s(2) }));
    const { entries, frame } = setup(p);
    frame(s(4.5));
    expect(entries.get(a.id).gain.gain.value).toBe(1);
    expect(entries.get(b.id).gain.gain.value).toBe(0);
    frame(s(5.5));
    // A is still drawn (fading out) but no longer heard.
    expect(entries.get(a.id).el.paused).toBe(false);
    expect(entries.get(a.id).gain.gain.value).toBe(0);
    expect(entries.get(b.id).gain.gain.value).toBe(1);
  });

  it('holds the first frame of an incoming clip without a head handle instead of looping it', () => {
    const p = fixture();
    const [, b] = onMain(p, clip('video', 0, 5, { transition: { id: 'mix', duration: s(2) } }), clip('video', 5, 5));
    const { entries, frame } = setup(p);
    for (const t of [4.1, 4.3, 4.5, 4.7, 4.9]) frame(s(t));
    const el = entries.get(b.id).el;
    expect(el.paused).toBe(true);
    expect(el.plays).toBe(0);
    expect(el.currentTime).toBe(0);
    frame(s(5.05));
    expect(el.paused).toBe(false);
  });

  it('plays the head handle of an incoming clip that has one', () => {
    const p = fixture();
    const [, b] = onMain(p, clip('video', 0, 5, { transition: { id: 'mix', duration: s(2) } }), clip('video', 5, 5, { in: s(3) }));
    const { entries, frame } = setup(p);
    frame(s(4.2));
    const el = entries.get(b.id).el;
    expect(el.paused).toBe(false);
    expect(el.currentTime).toBeCloseTo(2.2, 5);
  });

  it('holds the last frame of an outgoing clip that ends with its media', () => {
    const p = fixture(); // 'vid' is 10 s long
    const [a] = onMain(p, clip('video', 0, 5, { in: s(5), transition: { id: 'wipe-left', duration: s(2) } }), clip('video', 5, 5));
    const { entries, frame } = setup(p);
    frame(s(4.9));
    for (const t of [5.1, 5.3, 5.5, 5.7, 5.9]) frame(s(t));
    const e = entries.get(a.id);
    expect(e.el.paused).toBe(true);
    expect(e.el.currentTime).toBeCloseTo(9.999, 3);
    expect(e.gain.gain.value).toBe(0);
  });
});

describe('pausing', () => {
  it('stops on a whole frame, the one the timecode shows', () => {
    const p = fixture();
    onMain(p, clip('video', 0, 5));
    const { player } = setup(p);
    player.store.seek(1_234_567); // 37.04 frames at 30 fps
    player.pause();
    expect(player.store.time).toBe(1_233_333);
    player.playing = true;
    player.store.seek(1_250_000); // 37.5: the next frame is nearest
    player.pause();
    expect(player.store.time).toBe(1_266_667);
  });
});

describe('preview quality', () => {
  it('renders Full at the project size, within the pixel budget', () => {
    const p = fixture();
    const { player } = setup(p);
    player.layout(552, 311, 1);
    expect(player.renderScale).toBeCloseTo(0.2875, 4);
    player.quality = 'half';
    player.layout(552, 311, 1);
    expect(player.renderScale).toBeCloseTo(0.14375, 4);
    player.quality = 'full';
    player.layout(552, 311, 1);
    expect(player.renderScale).toBe(1);
    player.store.project.settings.width = 3840;
    player.store.project.settings.height = 2160;
    player.layout(552, 311, 1);
    expect(3840 * 2160 * player.renderScale ** 2).toBeCloseTo(2_200_000, -3);
  });
});
