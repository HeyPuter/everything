import { describe, it, expect } from 'vitest';
import {
  createProject, makeClip, normalizeProject, normalizeClip, FORMAT, VERSION, RATIOS, FPS_OPTIONS,
  TRACK_KIND_FOR, DEFAULT_TRANSFORM, DEFAULT_TEXT_STYLE, projectSummary,
} from '../src/model/project.js';
import { maxTransition, nextAdjacent } from '../src/model/timeline.js';
import { fixture, clip, onMain, s } from './helpers.js';

const TRACK_KINDS = ['video', 'audio', 'text', 'effect', 'filter', 'adjust'];
const ASSET_KINDS_FOR = { video: ['video'], image: ['image'], audio: ['audio', 'video'] };

/** Every invariant the editor relies on. Returns a list of problems (empty when valid). */
function problems(p) {
  const out = [];
  const bad = (msg) => out.push(msg);
  if (p.format !== FORMAT || p.version !== VERSION) bad('format');
  if (typeof p.id !== 'string' || !p.id) bad('id');
  if (typeof p.name !== 'string' || !p.name) bad('name');
  const st = p.settings;
  if (!(st.width >= 16 && st.width <= 8192 && st.width % 2 === 0)) bad('width');
  if (!(st.height >= 16 && st.height <= 8192 && st.height % 2 === 0)) bad('height');
  if (!FPS_OPTIONS.includes(st.fps)) bad('fps');
  if (![...RATIOS.map((r) => r.id), 'custom', 'original'].includes(st.ratio)) bad('ratio');
  for (const [key, a] of Object.entries(p.assets)) {
    if (a.id !== key) bad(`asset key ${key}`);
    if (!/^[A-Za-z0-9_-]*$/.test(a.hash)) bad(`asset hash ${a.hash}`);
  }
  if (Object.getPrototypeOf(p.assets) !== Object.prototype) bad('assets prototype');
  const trackIds = new Set();
  const clipIds = new Set();
  const mains = p.tracks.filter((t) => t.main);
  if (mains.length !== 1 || mains[0].kind !== 'video') bad('base track');
  for (const t of p.tracks) {
    if (!TRACK_KINDS.includes(t.kind)) bad(`track kind ${t.kind}`);
    if (trackIds.has(t.id)) bad(`duplicate track ${t.id}`);
    trackIds.add(t.id);
    let prevEnd = -Infinity;
    for (const c of t.clips) {
      if (clipIds.has(c.id)) bad(`duplicate clip ${c.id}`);
      clipIds.add(c.id);
      if (TRACK_KIND_FOR[c.type] !== t.kind) bad(`clip ${c.type} on ${t.kind}`);
      if (!Number.isInteger(c.start) || c.start < 0) bad('clip start');
      if (!Number.isInteger(c.duration) || c.duration < 1000) bad('clip duration');
      if (c.start < prevEnd - 1) bad(`overlap on ${t.kind}${t.main ? ' (main)' : ''}`);
      prevEnd = c.start + c.duration;
      if ('assetId' in c && c.assetId !== null) {
        if (!Object.hasOwn(p.assets, c.assetId)) bad(`missing asset ${c.assetId}`);
        else if (!ASSET_KINDS_FOR[c.type].includes(p.assets[c.assetId].kind)) bad(`${c.type} clip on ${p.assets[c.assetId].kind} asset`);
      }
      for (const prop of Object.keys(c.keyframes || {})) if (['__proto__', 'constructor', 'prototype'].includes(prop)) bad('keyframe prop');
      if (Object.getPrototypeOf(c.keyframes || {}) !== Object.prototype) bad('keyframes prototype');
      if (c.transition) {
        if (!nextAdjacent(p, c.id)) bad('transition without a neighbor');
        else if (c.transition.duration > maxTransition(p, c)) bad('transition too long');
      }
    }
  }
  const walk = (v, path) => {
    if (typeof v === 'number' && !Number.isFinite(v)) bad(`non-finite ${path}`);
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, `${path}.${k}`);
  };
  walk(p, 'project');
  return out;
}

/** Deterministic pseudo random numbers so fuzz failures reproduce. */
function rng(seed) {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return (x >>> 0) / 4294967296;
  };
}

function garbage(r, depth = 0) {
  const pick = (list) => list[Math.floor(r() * list.length)];
  const leaves = [null, undefined, NaN, Infinity, -Infinity, -1, 0, 1e15, 0.5, '', 'x', '12', '#zzzzzz', '#00FF00', true, false, '__proto__', 'constructor'];
  if (depth > 2 || r() < 0.5) return pick(leaves);
  return r() < 0.5 ? [garbage(r, depth + 1), garbage(r, depth + 1)] : { a: garbage(r, depth + 1), id: garbage(r, depth + 1) };
}

/** A project-shaped object with random corruption sprinkled in. */
function fuzzProject(seed) {
  const r = rng(seed);
  const pick = (list) => list[Math.floor(r() * list.length)];
  const maybe = (good) => (r() < 0.75 ? good : garbage(r));
  const ids = ['a', 'b', 'c', '__proto__', 'constructor', 'toString', 'dup'];
  const assets = {};
  for (let i = 0; i < 4; i++) {
    const id = pick(ids);
    assets[`k${i}`] = maybe({ id, kind: maybe(pick(['video', 'audio', 'image', 'gif'])), name: maybe('n'), hash: maybe(pick(['abc123', '../../etc/passwd', 'ok'])), ext: maybe('mp4'), duration: maybe(r() * 2e7), width: maybe(1920), height: maybe(1080), hasAudio: maybe(r() < 0.5) });
  }
  const tracks = [];
  for (let i = 0; i < 1 + Math.floor(r() * 5); i++) {
    const kind = maybe(pick([...TRACK_KINDS, 'video', 'bogus']));
    const clips = [];
    for (let j = 0; j < Math.floor(r() * 6); j++) {
      const type = maybe(pick(['video', 'image', 'audio', 'text', 'sticker', 'effect', 'filter', 'adjust', 'html']));
      clips.push(maybe({
        id: maybe(pick(['c1', 'c2', 'c3', `c${seed}-${i}-${j}`])),
        type,
        start: maybe(Math.floor(r() * 1e7)),
        duration: maybe(Math.floor(r() * 5e6)),
        assetId: maybe(pick(ids)),
        speed: maybe(pick([0, 1, 2, 1e9, -3])),
        transition: maybe({ id: 'mix', duration: maybe(pick([0, 5e5, 1e12])) }),
        keyframes: maybe({ x: [{ t: maybe(0), v: maybe(1) }, { t: 1e6, v: 'NaN' }], __proto__: [] }),
        transform: maybe({ x: maybe(0.1), scale: maybe(0) }),
        style: maybe({ color: maybe('#123456'), size: maybe(1e9) }),
        text: maybe('hello'),
      }));
    }
    tracks.push(maybe({ id: maybe(pick(['t1', 't2', `t${i}`])), kind, main: maybe(r() < 0.5), clips: maybe(clips) }));
  }
  return {
    format: r() < 0.9 ? FORMAT : undefined,
    id: maybe('p1'),
    name: maybe('Fuzz'),
    settings: maybe({ width: maybe(1921), height: maybe(1081), fps: maybe(pick([24, 29.97, '30', 60])), ratio: maybe(pick(['9:16', 'weird'])), background: maybe({ type: 'blur', color: '#ABCDEF', blur: 7 }) }),
    assets: maybe(assets),
    tracks: maybe(tracks),
    markers: maybe([{ time: maybe(5), color: maybe('#fff'), label: maybe('m') }, garbage(r)]),
    cover: maybe({ time: maybe(3) }),
  };
}

describe('createProject and makeClip', () => {
  it('creates a valid empty project with only a main video track', () => {
    const p = createProject({ name: 'Trip', ratio: '9:16' });
    expect(problems(p)).toEqual([]);
    expect(p.name).toBe('Trip');
    expect(p.settings).toMatchObject({ width: 1080, height: 1920, fps: 30, ratio: '9:16' });
    expect(p.tracks).toHaveLength(1);
    expect(p.tracks[0]).toMatchObject({ kind: 'video', main: true, clips: [] });
  });

  it('starts "original" projects as 16:9 and remembers the choice', () => {
    expect(createProject({ ratio: 'original' }).settings).toMatchObject({ width: 1920, height: 1080, ratio: 'original' });
  });

  it('gives each clip type sensible defaults without sharing objects', () => {
    const a = makeClip('video');
    const b = makeClip('video');
    expect(a.id).not.toBe(b.id);
    a.transform.x = 1;
    expect(b.transform).toEqual(DEFAULT_TRANSFORM);
    expect(makeClip('text').style).toEqual(DEFAULT_TEXT_STYLE);
    expect(makeClip('text').duration).toBe(s(3));
    expect(makeClip('audio')).toMatchObject({ speed: 1, volume: 1, in: 0, fadeIn: 0 });
    expect(makeClip('filter', { intensity: 40 }).intensity).toBe(40);
    expect(() => makeClip('hologram')).toThrow();
  });
});

describe('normalizeProject', () => {
  it('rejects things that are not Video Studio projects', () => {
    expect(() => normalizeProject(null)).toThrow();
    expect(() => normalizeProject('{}')).toThrow();
    expect(() => normalizeProject({ format: 'some-other-app' })).toThrow(/Not a Video Studio project/);
  });

  it('turns an empty object into a valid empty project', () => {
    const p = normalizeProject({});
    expect(problems(p)).toEqual([]);
    expect(p.tracks).toEqual([expect.objectContaining({ main: true, kind: 'video' })]);
  });

  it('keeps a well-formed project unchanged through a JSON round trip', () => {
    const p = fixture();
    onMain(p, clip('video', 0, 4, { transition: { id: 'mix', duration: s(0.5) }, keyframes: { x: [{ t: 0, v: 0, ease: 'easeIn' }, { t: s(1), v: 1, ease: 'linear' }] }, filter: { id: 'vivid', intensity: 60 } }), clip('image', 4, 2));
    p.tracks.unshift({ id: 'tt', kind: 'text', main: false, locked: true, hidden: false, muted: false, clips: [clip('text', 1, 2, { text: 'Hi', caption: true })] });
    p.tracks.push({ id: 'ta', kind: 'audio', main: false, locked: false, hidden: false, muted: true, clips: [clip('audio', 0, 3, { fadeOut: s(1) })] });
    p.markers.push({ id: 'm1', time: s(2), color: '#3ec6e0', label: 'Beat' });
    const back = normalizeProject(JSON.parse(JSON.stringify(p)));
    expect(back).toEqual(p);
    expect(normalizeProject(JSON.parse(JSON.stringify(back)))).toEqual(back);
  });

  it('reads loop animations from projects saved under the older field name', () => {
    const c = normalizeClip({ id: 'c', type: 'text', start: 0, duration: s(2), animCombo: { id: 'sway', duration: s(2) } });
    expect(c.animLoop).toEqual({ id: 'sway', duration: s(2) });
    expect('animCombo' in c).toBe(false);
  });

  it('drops unknown track kinds, unknown clip types and clips on the wrong kind of track', () => {
    const p = normalizeProject({
      tracks: [
        { id: 'x', kind: 'hologram', clips: [] },
        { id: 'v', kind: 'video', main: true, clips: [{ id: 'c1', type: 'html', start: 0, duration: 1e6 }, { id: 'c2', type: 'text', start: 0, duration: 1e6 }, { id: 'c3', type: 'text' }] },
        { id: 't', kind: 'text', clips: [{ id: 'c4', type: 'sticker', start: 0, duration: 1e6 }] },
      ],
    });
    expect(problems(p)).toEqual([]);
    expect(p.tracks.map((t) => t.id)).toEqual(['v', 't']);
    expect(p.tracks[0].clips).toEqual([]);
    expect(p.tracks[1].clips.map((c) => c.id)).toEqual(['c4']);
  });

  it('drops clips whose media is missing or of the wrong kind', () => {
    const p = normalizeProject({
      assets: { a: { id: 'a', kind: 'audio', duration: 1e6 }, v: { id: 'v', kind: 'video', duration: 1e6 } },
      tracks: [
        { id: 'main', kind: 'video', main: true, clips: [{ id: 'ok', type: 'video', assetId: 'v', duration: 1e6 }, { id: 'gone', type: 'video', assetId: 'nope', start: 2e6 }, { id: 'wrong', type: 'video', assetId: 'a', start: 4e6 }] },
        { id: 'aud', kind: 'audio', clips: [{ id: 'detached', type: 'audio', assetId: 'v', duration: 1e6 }] },
      ],
    });
    expect(problems(p)).toEqual([]);
    expect(p.tracks.flatMap((t) => t.clips.map((c) => c.id))).toEqual(['ok', 'detached']);
  });

  it('does not treat built-in object keys as asset ids', () => {
    const p = normalizeProject({
      assets: { x: { id: '__proto__', kind: 'video' }, y: { id: 'constructor', kind: 'video' } },
      tracks: [{ id: 'm', kind: 'video', main: true, clips: [{ id: 'c', type: 'video', assetId: 'toString' }, { id: 'd', type: 'video', assetId: 'hasOwnProperty', start: 6e6 }] }],
    });
    expect(problems(p)).toEqual([]);
    expect(p.tracks[0].clips).toEqual([]);
  });

  it('keeps media file names inside the media folder', () => {
    const p = normalizeProject({ assets: { a: { id: 'a', kind: 'image', hash: '../../projects/other', ext: '.json/../x' } } });
    expect(p.assets.a.hash).not.toContain('/');
    expect(p.assets.a.ext).toBe('jsonx');
  });

  it('makes clip and track ids unique', () => {
    const p = normalizeProject({
      tracks: [
        { id: 'same', kind: 'video', main: true, clips: [{ id: 'c', type: 'image', start: 0, duration: 1e6 }] },
        { id: 'same', kind: 'text', clips: [{ id: 'c', type: 'text', start: 0, duration: 1e6 }, { id: 'd', type: 'text', start: 2e6, duration: 1e6 }] },
      ],
    });
    expect(problems(p)).toEqual([]);
    expect(p.tracks.flatMap((t) => t.clips).map((c) => c.id)).toEqual(['c', 'd']);
  });

  it('keeps exactly one base track, and it is a video track', () => {
    const many = normalizeProject({ tracks: [{ id: 'a', kind: 'video', main: true }, { id: 'b', kind: 'video', main: true }, { id: 'c', kind: 'audio', main: true }] });
    expect(many.tracks.filter((t) => t.main).map((t) => t.id)).toEqual(['a']);
    const none = normalizeProject({ tracks: [{ id: 'au', kind: 'audio' }, { id: 'v', kind: 'video' }] });
    expect(none.tracks.find((t) => t.main).id).toBe('v');
    const noVideo = normalizeProject({ tracks: [{ id: 'au', kind: 'audio' }] });
    expect(problems(noVideo)).toEqual([]);
  });

  it('separates overlapping clips so every track plays one clip at a time', () => {
    const p = normalizeProject({
      tracks: [
        { id: 'm', kind: 'video', main: true, clips: [{ id: 'a', type: 'image', start: 0, duration: 4e6 }, { id: 'b', type: 'image', start: 1e6, duration: 2e6 }] },
        { id: 't', kind: 'text', clips: [{ id: 'x', type: 'text', start: 0, duration: 4e6 }, { id: 'y', type: 'text', start: 1e6, duration: 2e6 }] },
      ],
    });
    expect(problems(p)).toEqual([]);
    expect(p.tracks.flatMap((t) => t.clips)).toHaveLength(4);
  });

  it('drops transitions that do not sit on a cut and shortens ones that are too long', () => {
    const p = normalizeProject({
      tracks: [{ id: 'm', kind: 'video', main: true, clips: [
        { id: 'a', type: 'image', start: 0, duration: 2e6, transition: { id: 'mix', duration: 1e12 } },
        { id: 'b', type: 'image', start: 2e6, duration: 1e6, transition: { id: 'mix', duration: 5e5 } },
      ] }],
    });
    expect(problems(p)).toEqual([]);
    expect(p.tracks[0].clips[0].transition).toEqual({ id: 'mix', duration: 1e6 });
    expect(p.tracks[0].clips[1].transition).toBe(null);
  });

  it('drops a transition into a compound clip, which never played', () => {
    const p = normalizeProject({
      tracks: [{ id: 'm', kind: 'video', main: true, clips: [
        { id: 'a', type: 'image', start: 0, duration: 2e6, transition: { id: 'mix', duration: 5e5 } },
        { id: 'k', type: 'compound', start: 2e6, duration: 2e6, sequence: { tracks: [{ id: 'n', kind: 'video', main: true, clips: [{ id: 'i', type: 'image', start: 0, duration: 2e6 }] }] } },
      ] }],
    });
    expect(p.tracks[0].clips.map((c) => c.type)).toEqual(['image', 'compound']);
    expect(p.tracks[0].clips[0].transition).toBe(null);
  });

  it('clamps settings and clip values into range', () => {
    const p = normalizeProject({
      settings: { width: 99999, height: 'tall', fps: 29.97, ratio: 'weird', background: { type: 'blur', color: 'red', blur: 5 } },
      tracks: [{ id: 'm', kind: 'video', main: true, clips: [{ id: 'c', type: 'image', start: -5, duration: 0, opacity: 7, transform: { scale: 0, x: 'left' }, crop: { l: 2 }, adjust: { brightness: 1e9 } }] }],
      markers: [{ time: -1, color: 'blue' }, { time: 'soon' }, null],
    });
    expect(problems(p)).toEqual([]);
    expect(p.settings).toEqual({ width: 8192, height: 1080, fps: 30, ratio: '16:9', background: { type: 'blur', color: '#000000', blur: 1 } });
    const c = p.tracks[0].clips[0];
    expect(c).toMatchObject({ start: 0, duration: 1000, opacity: 1, crop: { l: 0.95, t: 0, r: 0, b: 0 } });
    expect(c.transform).toMatchObject({ scale: 0.01, x: 0 });
    expect(c.adjust.brightness).toBe(100);
    expect(p.markers).toEqual([expect.objectContaining({ time: 0, color: '#3ec6e0' })]);
  });

  it('sanitizes keyframes', () => {
    const c = normalizeClip({ type: 'text', keyframes: { x: [{ t: 2e6, v: 1 }, { t: -5, v: '3' }, { t: 'x', v: 1 }, null], y: 'nope', scale: [] } });
    expect(c.keyframes).toEqual({ x: [{ t: 0, v: 3, ease: 'linear' }, { t: 2e6, v: 1, ease: 'linear' }] });
  });

  it('turns any random corruption into a valid project', () => {
    for (let seed = 1; seed <= 500; seed++) {
      const raw = fuzzProject(seed);
      let p;
      try {
        p = normalizeProject(raw);
      } catch (err) {
        expect(err.message, `seed ${seed}`).toMatch(/project/i);
        continue;
      }
      expect(problems(p), `seed ${seed}`).toEqual([]);
      expect(normalizeProject(JSON.parse(JSON.stringify(p))), `seed ${seed} round trip`).toEqual(p);
    }
  });
});

describe('projectSummary', () => {
  it('lists what the home screen shows', () => {
    const p = createProject({ name: 'Short', ratio: '1:1' });
    expect(projectSummary(p, s(3))).toMatchObject({ id: p.id, name: 'Short', duration: s(3), ratio: '1:1', width: 1080, height: 1080 });
  });
});
