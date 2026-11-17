import { describe, it, expect } from 'vitest';
import { normalizeMulticam, angleAt, segments, activeRanges, switchAngle, removeCut, moveCut, setAudioSource, angleTracks, angleName, visibleCuts, isMulticam } from '../src/model/multicam.js';
import { createMulticam, flattenMulticam } from '../src/model/multicam-edit.js';
import { addClip, mainTrack, findClip, allClips, splitClip, trimClip, pasteClips } from '../src/model/timeline.js';
import { normalizeProject, createProject, normalizeAsset, makeClip } from '../src/model/project.js';
import { EditorStore } from '../src/model/store.js';
import { deleteClips } from '../src/model/timeline.js';
import { evaluate, audibleClips, showsAt } from '../src/engine/scene.js';
import { expandProject } from '../src/engine/compound.js';
import { sliceProject } from '../src/model/slice.js';
import { fixture, clip, onMain, s, addAsset } from './helpers.js';

const RIPPLE = { ripple: true, linkOverlays: true };
const FREE = { ripple: false, linkOverlays: false };
const mc = (cuts, audio = 0) => ({ cuts: cuts.map(([t, angle]) => ({ t: s(t), angle })), audio });
const plain = (m) => m.cuts.map((c) => [c.t / 1e6, c.angle]);

describe('multi-camera cuts', () => {
  it('normalizes untrusted data: sorted, unique, in range, first at 0, runs merged', () => {
    const raw = { cuts: [{ t: s(5), angle: 1 }, { t: s(2), angle: 1 }, { t: s(2), angle: 2 }, { t: s(3), angle: 7 }, { t: 'x', angle: 0 }, null, { t: s(8), angle: 2 }, { t: s(50), angle: 0 }], audio: 9 };
    const n = normalizeMulticam(raw, 3, s(10));
    // 2 s becomes the first cut (moved to 0); the 5 s cut keeps showing 1 after 2 at 0.
    expect(plain(n)).toEqual([[0, 2], [5, 1], [8, 2], [9.999999, 0]]);
    expect(n.audio).toBe(0);
    expect(normalizeMulticam(null, 2)).toEqual({ cuts: [{ t: 0, angle: 0 }], audio: 0 });
    expect(normalizeMulticam({ cuts: [], audio: 'follow' }, 2).audio).toBe('follow');
    expect(normalizeMulticam({ audio: '1' }, 2).audio).toBe(0);
    expect(normalizeMulticam({ audio: 1 }, 2).audio).toBe(1);
  });

  it('merges neighbouring cuts that pick the same angle', () => {
    const n = normalizeMulticam(mc([[0, 0], [1, 0], [2, 1], [3, 1], [4, 0]]), 2);
    expect(plain(n)).toEqual([[0, 0], [2, 1], [4, 0]]);
  });

  it('finds the angle at a time and the runs of each angle', () => {
    const m = mc([[0, 0], [2, 1], [5, 0]]);
    expect(angleAt(m, 0)).toBe(0);
    expect(angleAt(m, s(2) - 1)).toBe(0);
    expect(angleAt(m, s(2))).toBe(1);
    expect(angleAt(m, s(9))).toBe(0);
    expect(segments(m, s(1), s(6)).map((g) => [g.a / 1e6, g.b / 1e6, g.angle])).toEqual([[1, 2, 0], [2, 5, 1], [5, 6, 0]]);
    expect(activeRanges(m, 0, 0, s(8)).map(([a, b]) => [a / 1e6, b / 1e6])).toEqual([[0, 2], [5, 8]]);
    expect(activeRanges(m, 2, 0, s(8))).toEqual([]);
  });

  it('switches angle from a time until the next cut', () => {
    let m = mc([[0, 0], [5, 1]]);
    m = switchAngle(m, s(2), 2, 3);
    expect(plain(m)).toEqual([[0, 0], [2, 2], [5, 1]]);
    // Replacing the cut at the same time.
    m = switchAngle(m, s(2), 1, 3);
    expect(plain(m)).toEqual([[0, 0], [2, 1]]);
    // Switching to the angle already showing changes nothing.
    expect(plain(switchAngle(m, s(3), 1, 3))).toEqual([[0, 0], [2, 1]]);
    // At 0 it changes the opening angle.
    expect(plain(switchAngle(m, 0, 2, 3))).toEqual([[0, 2], [2, 1]]);
    expect(plain(switchAngle(m, 0, 1, 3))).toEqual([[0, 1]]);
  });

  it('removes and moves cuts', () => {
    const m = mc([[0, 0], [2, 1], [5, 2]]);
    expect(plain(removeCut(m, s(2), 3))).toEqual([[0, 0], [5, 2]]);
    // Removing the middle one joins two runs of the same angle.
    expect(plain(removeCut(mc([[0, 0], [2, 1], [5, 0]]), s(2), 2))).toEqual([[0, 0]]);
    // The opening cut goes only when another follows; the next angle then opens.
    expect(plain(removeCut(m, 0, 3))).toEqual([[0, 1], [5, 2]]);
    expect(removeCut(mc([[0, 1]]), 0, 2)).toEqual(mc([[0, 1]]));
    expect(plain(moveCut(m, s(2), s(3), 3))).toEqual([[0, 0], [3, 1], [5, 2]]);
    // Kept a frame away from its neighbours, and the first cut stays put.
    expect(moveCut(m, s(2), s(9), 3).cuts[1].t).toBe(s(5) - 16_667);
    expect(moveCut(m, 0, s(1), 3)).toBe(m);
    expect(moveCut(m, s(4), s(1), 3)).toBe(m);
  });

  it('sets the sound source', () => {
    const m = mc([[0, 0]]);
    expect(setAudioSource(m, 'follow', 2).audio).toBe('follow');
    expect(setAudioSource(m, 1, 2).audio).toBe(1);
    expect(setAudioSource(m, 5, 2).audio).toBe(0);
  });
});

/** Three 10 s angles: the main one at 0, two overlays a little later. */
function threeAngles() {
  const p = fixture();
  addAsset(p, { id: 'vid2', kind: 'video', duration: s(20), hasAudio: true, width: 1920, height: 1080 });
  const [a] = onMain(p, clip('video', 0, 10, { name: 'Wide' }));
  const b = clip('video', 1, 8, { assetId: 'vid2', name: 'Close' });
  const c = clip('video', 2, 6, { assetId: 'silent' });
  addClip(p, b, FREE);
  addClip(p, c, FREE);
  return { p, a, b, c };
}

describe('creating and flattening multi-camera clips', () => {
  it('nests 2 to 9 video clips as angles, lined up by the given starts', () => {
    const { p, a, b, c } = threeAngles();
    const text = clip('text', 0, 2);
    addClip(p, text, FREE);
    // b is found to belong half a second later than it sits.
    const m = createMulticam(p, [c.id, b.id, a.id, text.id], { starts: { [b.id]: s(1.5) }, ...RIPPLE });
    expect(isMulticam(m)).toBe(true);
    expect(m.name).toBe('Multi-camera clip 1');
    expect(mainTrack(p).clips.map((x) => x.id)).toEqual([m.id]);
    expect(findClip(p, text.id)).not.toBeNull();
    expect(findClip(p, b.id)).toBeNull();
    expect(m.start).toBe(0);
    expect(m.duration).toBe(s(10));
    const tracks = angleTracks(m);
    expect(tracks.map((t) => t.clips[0].id)).toEqual([a.id, b.id, c.id]);
    expect(tracks.map((t) => t.clips[0].start / 1e6)).toEqual([0, 1.5, 2]);
    expect([0, 1, 2].map((i) => angleName(m, i))).toEqual(['Wide', 'Close', 'silent']);
    expect(tracks[0].main).toBe(true);
    expect(m.multicam).toEqual({ cuts: [{ t: 0, angle: 0 }], audio: 0 });
    expect(createMulticam(p, [text.id], RIPPLE)).toBeNull();
  });

  it('starts at the earliest angle and rejects too few or too many', () => {
    const p = fixture();
    const [a] = onMain(p, clip('video', 0, 4), clip('video', 4, 4));
    const b = clip('video', 2, 4);
    addClip(p, b, FREE);
    const m = createMulticam(p, [a.id, b.id], { starts: { [a.id]: s(3) }, ...FREE });
    expect(m.start).toBe(s(2));
    expect(m.duration).toBe(s(5));
    expect(angleTracks(m)[0].clips[0].start).toBe(s(1));
    const q = fixture();
    const many = Array.from({ length: 10 }, (_, i) => clip('video', i, 1));
    onMain(q, ...many);
    expect(createMulticam(q, many.map((x) => x.id), RIPPLE)).toBeNull();
    expect(createMulticam(q, [many[0].id], RIPPLE)).toBeNull();
    expect(createMulticam(q, many.slice(0, 9).map((x) => x.id), RIPPLE)).not.toBeNull();
  });

  it('survives saving and loading, cuts fitted to the angles', () => {
    const { p, a, b } = threeAngles();
    const m = createMulticam(p, [a.id, b.id], RIPPLE);
    m.multicam = { cuts: [{ t: s(2), angle: 1 }, { t: s(4), angle: 5 }, { t: s(6), angle: 0 }], audio: 'follow' };
    const n = normalizeProject(JSON.parse(JSON.stringify(p)));
    const nm = mainTrack(n).clips[0];
    expect(nm.multicam).toEqual({ cuts: [{ t: 0, angle: 1 }, { t: s(6), angle: 0 }], audio: 'follow' });
    expect(angleTracks(nm).map((t) => t.name)).toEqual(['Wide', 'Close']);
    // A plain compound stays plain; one without angle tracks loses its switches.
    const raw = JSON.parse(JSON.stringify(p));
    raw.tracks.find((t) => t.main).clips[0].sequence.tracks.forEach((t) => delete t.angle);
    expect(mainTrack(normalizeProject(raw)).clips[0].multicam).toBeUndefined();
  });

  it('flattens into the pieces that show, with the chosen sound on an audio clip', () => {
    const { p, a, b } = threeAngles();
    const m = createMulticam(p, [a.id, b.id], RIPPLE);
    m.multicam = mc([[0, 0], [3, 1], [6, 0]]);
    const made = flattenMulticam(p, m.id);
    expect(findClip(p, m.id)).toBeNull();
    const main = mainTrack(p).clips;
    expect(main.map((x) => [x.start / 1e6, x.duration / 1e6, x.assetId, x.in / 1e6, x.muted])).toEqual([
      [0, 3, 'vid', 0, true],
      [3, 3, 'vid2', 2, true],
      [6, 4, 'vid', 6, true],
    ]);
    const audio = allClips(p).filter((x) => x.type === 'audio');
    expect(audio.map((x) => [x.start / 1e6, x.duration / 1e6, x.assetId, x.muted])).toEqual([[0, 10, 'vid', false]]);
    expect(made.length).toBe(4);
  });

  it('flattens with the sound following the picture', () => {
    const { p, a, b } = threeAngles();
    const m = createMulticam(p, [a.id, b.id], RIPPLE);
    m.multicam = mc([[0, 0], [3, 1]], 'follow');
    m.in = s(1);
    m.duration = s(5);
    m.transform.scale = 0.5;
    flattenMulticam(p, m.id);
    const main = mainTrack(p).clips;
    expect(main.map((x) => [x.start / 1e6, x.duration / 1e6, x.in / 1e6, x.muted])).toEqual([[0, 2, 1, false], [2, 3, 2, false]]);
    expect(main[0].transform.scale).toBeCloseTo(0.5);
    expect(allClips(p).some((x) => x.type === 'audio')).toBe(false);
  });
});

describe('rendering multi-camera clips', () => {
  function made() {
    const { p, a, b, c } = threeAngles();
    const m = createMulticam(p, [a.id, b.id, c.id], RIPPLE);
    m.multicam = mc([[0, 0], [3, 1], [5, 2], [7, 0]]);
    p.modified++;
    return { p, m };
  }
  const shown = (p, t) => evaluate(p, s(t)).filter((l) => l.kind === 'media').map((l) => l.asset.id);

  it('shows only the active angle', () => {
    const { p } = made();
    expect(shown(p, 1)).toEqual(['vid']);
    expect(shown(p, 3.5)).toEqual(['vid2']);
    expect(shown(p, 5.5)).toEqual(['silent']);
    expect(shown(p, 9)).toEqual(['vid']);
    // Where the active angle has no footage nothing shows.
    const { p: q, m } = made();
    m.multicam = mc([[0, 2]]);
    expect(shown(q, 1)).toEqual([]);
    expect(shown(q, 4)).toEqual(['silent']);
  });

  it('keeps the sound angle whole and the others silent', () => {
    const { p } = made();
    const list = audibleClips(p);
    expect(list.map((x) => x.clip.assetId)).toEqual(['vid']);
    const whole = list[0].clip;
    expect(whole.duration).toBe(s(10));
    expect(showsAt(whole, s(4))).toBe(false);
    expect(showsAt(whole, s(8))).toBe(true);
    // Its picture shows at the source time of the whole clip.
    const layer = evaluate(p, s(8)).find((l) => l.kind === 'media');
    expect(layer.clip).toBe(whole);
    expect(layer.sourceTime).toBe(s(8));
  });

  it('plays the sound of the angle that shows when set to follow', () => {
    const { p, m } = made();
    m.multicam = { ...m.multicam, audio: 'follow' };
    const list = audibleClips(p);
    // silent has no sound track, so only the pieces of vid and vid2 are heard.
    const spans = list.map((x) => `${x.clip.assetId}:${x.clip.start / 1e6}-${(x.clip.start + x.clip.duration) / 1e6}`).sort();
    expect(spans).toEqual(['vid2:3-5', 'vid:0-3', 'vid:7-10']);
    // Picked by source time inside a piece.
    const layer = evaluate(p, s(4)).find((l) => l.kind === 'media');
    expect(layer.sourceTime).toBe(s(3));
  });

  it('keeps piece ids when a later cut is added, and re-expands when cuts change', () => {
    const { p, m } = made();
    const before = expandProject(p);
    const ids = before.tracks.flatMap((t) => t.clips).map((c) => c.id);
    m.multicam = switchAngle(m.multicam, s(4), 2, 3);
    const after = expandProject(p);
    expect(after).not.toBe(before);
    const ids2 = after.tracks.flatMap((t) => t.clips).map((c) => c.id);
    // The piece of angle 1 that starts at 3 s is still there, now shorter.
    const piece = after.tracks.flatMap((t) => t.clips).find((c) => c.assetId === 'vid2');
    expect(ids).toContain(piece.id);
    expect(piece.duration).toBe(s(1));
    expect(ids2.length).toBe(ids.length);
    expect(shown(p, 4.5)).toEqual(['silent']);
  });

  it('splits so that each half keeps showing the right angles', () => {
    const { p, m } = made();
    const right = splitClip(p, m.id, s(4));
    p.modified++;
    expect(right.multicam).toEqual(m.multicam);
    expect(visibleCuts(m).map((c) => c.t / 1e6)).toEqual([3]);
    expect(visibleCuts(right).map((c) => c.t / 1e6)).toEqual([5, 7]);
    expect(shown(p, 3.5)).toEqual(['vid2']);
    expect(shown(p, 4.5)).toEqual(['vid2']);
    expect(shown(p, 6)).toEqual(['silent']);
    expect(shown(p, 8)).toEqual(['vid']);
  });

  it('trims, copies and slices like any clip', () => {
    const { p, m } = made();
    trimClip(p, m.id, 'start', s(4), FREE);
    p.modified++;
    const c = findClip(p, m.id).clip;
    expect(c.in).toBe(s(4));
    expect(shown(p, 4.5)).toEqual(['vid2']);
    expect(shown(p, 6)).toEqual(['silent']);
    const [copy] = pasteClips(p, [{ ...structuredClone(c), _main: false }], s(20), FREE);
    expect(copy.multicam).toEqual(c.multicam);
    p.modified++;
    expect(shown(p, 21.5)).toEqual(['silent']);
    // Exporting a range keeps the switches.
    const part = sliceProject(p, s(4), s(6));
    expect(shown(part, 0.5)).toEqual(['vid2']);
    expect(shown(part, 1.5)).toEqual(['silent']);
  });

  it('renders a multi-camera clip nested in a compound clip', async () => {
    const { createCompound } = await import('../src/model/compound.js');
    const { p, m } = made();
    const outer = createCompound(p, [m.id], RIPPLE);
    outer.in = s(2);
    outer.duration = s(6);
    p.modified++;
    expect(shown(p, 0.5)).toEqual(['vid']);
    expect(shown(p, 1.5)).toEqual(['vid2']);
    expect(shown(p, 3.5)).toEqual(['silent']);
  });
});

describe('editing inside a multi-camera clip', () => {
  it('keeps cuts and the sound source on their angles when an angle is deleted inside', () => {
    const p = createProject();
    for (const id of ['camA', 'camB', 'camC']) p.assets[id] = normalizeAsset({ id, kind: 'video', name: id, duration: s(20), hasAudio: true });
    const store = new EditorStore(p, { toggles: { ripple: false } });
    const ids = [];
    store.update('Add', (pr) => {
      for (const [i, id] of ['camA', 'camB', 'camC'].entries()) ids.push(addClip(pr, makeClip('video', { assetId: id, start: 0, duration: s(10) }), { main: i === 0 }).clip.id);
    });
    let made;
    store.update('Multicam', (pr) => { made = createMulticam(pr, ids, store.opts); });
    const live = () => findClip(store.project, made.id).clip;
    store.update('Cuts', (pr) => {
      const c = findClip(pr, made.id).clip;
      c.multicam = switchAngle(c.multicam, s(3), 2, 3, s(10));
      c.multicam = switchAngle(c.multicam, s(6), 1, 3, s(10));
      c.multicam = setAudioSource(c.multicam, 2, 3);
    });
    const names = () => angleTracks(live()).map((t) => t.name);
    const shown = () => live().multicam.cuts.map((k) => [k.t / 1e6, names()[k.angle]]);
    expect(shown()).toEqual([[0, 'camA'], [3, 'camC'], [6, 'camB']]);

    store.openCompound(made.id);
    const gone = store.project.tracks.find((t) => t.angle && t.name === 'camB').clips[0];
    store.update('Delete', (pr) => deleteClips(pr, [gone.id], store.opts));
    store.closeCompound();

    expect(names()).toEqual(['camA', 'camC']);
    expect(shown()).toEqual([[0, 'camA'], [3, 'camC']]);
    expect(names()[live().multicam.audio]).toBe('camC');
    // The saved project says the same.
    const back = findClip(normalizeProject(JSON.parse(JSON.stringify(store.projectForSave()))), made.id).clip;
    expect(back.multicam).toEqual(live().multicam);
  });
});

