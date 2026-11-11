import { describe, it, expect } from 'vitest';
import { Channel } from '../src/audio/channel.js';
import * as S from '../src/model/session-edits.js';
import { Session } from '../src/model/session.js';
import { buildSessionGraph, clipPlan, dbEnvelopeToGain, metronomeBar } from '../src/model/session-graph.js';
import { serializeSession, parseSession, safeFileName, mediaFolderName } from '../src/model/session-io.js';
import { createMarker } from '../src/model/markers.js';
import { zipStore, unzipStore, crc32 } from '../src/lib/zip.js';

const RATE = 1000;

function base(tracks = 2) {
  return S.createSessionState({ sampleRate: RATE, tracks });
}

function withClip(state, o) {
  const clip = S.createClip({ trackId: state.tracks[0].id, sourceId: 'src', name: 'A', start: 0, length: 100, ...o });
  return [S.addClips(state, [clip]), clip];
}

describe('session tracks', () => {
  it('creates tracks with a master and unique ids', () => {
    const s = base(6);
    expect(s.tracks).toHaveLength(6);
    expect(s.master.type).toBe('master');
    expect(new Set(s.tracks.map((t) => t.id)).size).toBe(6);
    expect(s.tracks[1].name).toBe('Track 2');
  });

  it('adds, moves, duplicates and removes tracks; removing a bus reroutes its inputs', () => {
    let s = base(2);
    const bus = S.createTrack({ type: 'bus', name: 'Bus A' });
    s = S.addTrack(s, bus);
    s = S.updateTrack(s, s.tracks[0].id, { output: bus.id });
    s = S.moveTrack(s, bus.id, -1);
    expect(s.tracks[1].id).toBe(bus.id);
    let [s2, clip] = withClip(s, {});
    s2 = S.duplicateTrack(s2, s.tracks[0].id);
    expect(s2.tracks).toHaveLength(4);
    expect(s2.tracks[1].name).toMatch(/Copy$/);
    expect(s2.clips).toHaveLength(2);
    expect(s2.clips[1].id).not.toBe(clip.id);
    const s3 = S.removeTracks(s2, [bus.id]);
    expect(s3.tracks.every((t) => t.output === 'master')).toBe(true);
    const s4 = S.removeTracks(s3, [s3.tracks[0].id, s3.master.id]);
    expect(s4.master).toBeTruthy();
    expect(s4.clips.every((c) => c.trackId !== s3.tracks[0].id)).toBe(true);
  });

  it('detects routing cycles through buses', () => {
    let s = base(1);
    const a = S.createTrack({ type: 'bus', name: 'A' });
    const b = S.createTrack({ type: 'bus', name: 'B', output: a.id });
    s = S.addTrack(S.addTrack(s, a), b);
    expect(S.wouldCycle(s, a.id, b.id)).toBe(true);
    expect(S.wouldCycle(s, s.tracks[0].id, b.id)).toBe(false);
  });

  it('removes empty audio tracks only', () => {
    let s = base(3);
    s = S.addTrack(s, S.createTrack({ type: 'bus' }));
    [s] = withClip(s, {});
    const out = S.removeEmptyTracks(s);
    expect(out.tracks.map((t) => t.type)).toEqual(['audio', 'bus']);
  });
});

describe('clip edits', () => {
  it('moves clips in time and across tracks, clamping at zero and the last track', () => {
    let [s, c] = withClip(base(3), { start: 50 });
    s = S.moveClips(s, [c.id], -500, 1);
    expect(S.findClip(s, c.id).start).toBe(0);
    expect(S.findClip(s, c.id).trackId).toBe(s.tracks[1].id);
    s = S.moveClips(s, [c.id], 10, 5);
    expect(S.findClip(s, c.id).trackId).toBe(s.tracks[2].id);
  });

  it('copies clips with Alt-drag semantics and leaves locked clips in place', () => {
    let [s, c] = withClip(base(2), { start: 10 });
    const copied = S.moveClips(s, [c.id], 200, 0, { copy: true });
    expect(copied.clips).toHaveLength(2);
    expect(copied.clips[1].start).toBe(210);
    s = S.updateClips(s, [c.id], { locked: true });
    expect(S.moveClips(s, [c.id], 50)).toBe(s);
  });

  it('splits a clip with envelopes and fades divided between the parts', () => {
    let [s, c] = withClip(base(1), { start: 100, offset: 20, length: 100, fadeIn: { length: 30, curve: 0 }, fadeOut: { length: 40, curve: 2 }, volumeEnv: [{ t: 0, v: 0 }, { t: 100, v: -10 }] });
    s = S.splitClips(s, [c.id], 150);
    expect(s.clips).toHaveLength(2);
    const [l, r] = s.clips;
    expect(l).toMatchObject({ start: 100, offset: 20, length: 50 });
    expect(l.fadeOut.length).toBe(0);
    expect(l.fadeIn.length).toBe(30);
    expect(r).toMatchObject({ start: 150, offset: 70, length: 50 });
    expect(r.fadeIn.length).toBe(0);
    expect(r.fadeOut).toEqual({ length: 40, curve: 2 });
    expect(r.volumeEnv[0]).toEqual({ t: 0, v: -5 });
    expect(l.volumeEnv[l.volumeEnv.length - 1]).toEqual({ t: 50, v: -5 });
    // Splitting outside a clip changes nothing.
    expect(S.splitClips(s, null, 5)).toBe(s);
  });

  it('trims clip edges within the source and shifts the offset', () => {
    let [s, c] = withClip(base(1), { start: 100, offset: 10, length: 50 });
    let t = S.trimClip(s, c.id, 'in', 50, 1000);
    expect(S.findClip(t, c.id)).toMatchObject({ start: 90, offset: 0, length: 60 });
    t = S.trimClip(s, c.id, 'in', 120, 1000);
    expect(S.findClip(t, c.id)).toMatchObject({ start: 120, offset: 30, length: 30 });
    t = S.trimClip(s, c.id, 'out', 5000, 200);
    expect(S.findClip(t, c.id).length).toBe(190);
    t = S.trimClip(s, c.id, 'out', 0, 200);
    expect(S.findClip(t, c.id).length).toBe(1);
    const looped = S.updateClips(s, [c.id], { loop: true });
    expect(S.findClip(S.trimClip(looped, c.id, 'out', 5000, 200), c.id).length).toBe(4900);
  });

  it('slips the audio inside a clip within the source bounds', () => {
    const [s, c] = withClip(base(1), { offset: 50, length: 100 });
    expect(S.findClip(S.slipClip(s, c.id, 20, 300), c.id).offset).toBe(30);
    expect(S.findClip(S.slipClip(s, c.id, -500, 300), c.id).offset).toBe(200);
    expect(S.findClip(S.slipClip(s, c.id, 500, 300), c.id).offset).toBe(0);
  });

  it('ripple deletes clips, time on all tracks, time on one track and gaps', () => {
    let s = base(2);
    const t0 = s.tracks[0].id;
    const t1 = s.tracks[1].id;
    const a = S.createClip({ trackId: t0, sourceId: 'x', start: 0, length: 100 });
    const b = S.createClip({ trackId: t0, sourceId: 'x', start: 200, length: 100 });
    const c = S.createClip({ trackId: t1, sourceId: 'x', start: 250, length: 100 });
    s = { ...S.addClips(s, [a, b, c]), markers: [createMarker({ start: 400 })] };
    const r1 = S.rippleDeleteClips(s, [a.id]);
    expect(S.findClip(r1, b.id).start).toBe(100);
    expect(S.findClip(r1, c.id).start).toBe(250);

    const r2 = S.rippleDeleteTime(s, 50, 220);
    expect(r2.clips.filter((x) => x.trackId === t0).map((x) => [x.start, x.length])).toEqual([[0, 50], [50, 80]]);
    expect(S.findClip(r2, c.id).start).toBe(80);
    expect(r2.markers[0].start).toBe(230);

    const r3 = S.rippleDeleteTime(s, 50, 220, { trackIds: [t0] });
    expect(S.findClip(r3, c.id).start).toBe(250);
    expect(r3.markers[0].start).toBe(400);

    expect(S.gapAt(s, t0, 150)).toEqual([100, 200]);
    const r4 = S.rippleDeleteGap(s, t0, 150);
    expect(S.findClip(r4, b.id).start).toBe(100);
  });

  it('trimming either edge keeps both fades inside the clip', () => {
    const [s, c] = withClip(base(), { fadeIn: { length: 80, curve: 0 }, fadeOut: { length: 70, curve: 2 } });
    const out = S.findClip(S.trimClip(s, c.id, 'out', 50, 1000), c.id);
    expect(out.fadeIn).toEqual({ length: 50, curve: 0 });
    expect(out.fadeOut).toEqual({ length: 50, curve: 2 });
    const inn = S.findClip(S.trimClip(s, c.id, 'in', 60, 1000), c.id);
    expect(inn.fadeIn.length).toBe(40);
    expect(inn.fadeOut).toEqual({ length: 40, curve: 2 });
  });

  it('adds clips on top of the clips there, keeping their own order', () => {
    let s = base(1);
    const t0 = s.tracks[0].id;
    const a = S.createClip({ trackId: t0, sourceId: 'x', start: 0, length: 100, z: 4 });
    s = S.addClips(s, [a]);
    const b = S.createClip({ trackId: t0, sourceId: 'x', start: 10, length: 20, z: 2 });
    const c = S.createClip({ trackId: t0, sourceId: 'x', start: 20, length: 20, z: 3 });
    const r = S.addClipsOnTop(s, [b, c]);
    expect(S.findClip(r, b.id).z).toBe(5);
    expect(S.findClip(r, c.id).z).toBe(6);
    expect(S.addClipsOnTop(s, [])).toBe(s);
  });

  it('ripple deleting overlapping clips closes the time they cover only once', () => {
    let s = base(1);
    const t0 = s.tracks[0].id;
    const a = S.createClip({ trackId: t0, sourceId: 'x', start: 0, length: 200 });
    const b = S.createClip({ trackId: t0, sourceId: 'x', start: 100, length: 200 });
    const c = S.createClip({ trackId: t0, sourceId: 'x', start: 400, length: 100 });
    const d = S.createClip({ trackId: t0, sourceId: 'x', start: 600, length: 50 });
    const e = S.createClip({ trackId: t0, sourceId: 'x', start: 700, length: 50 });
    s = S.addClips(s, [a, b, c, d, e]);
    // [0, 300) and [600, 650) are removed: 300 + 50 frames.
    const r = S.rippleDeleteClips(s, [a.id, b.id, d.id]);
    expect(S.findClip(r, c.id).start).toBe(100);
    expect(S.findClip(r, e.id).start).toBe(350);
  });

  it('removes a time range from selected clips without moving others', () => {
    let s = base(1);
    const a = S.createClip({ trackId: s.tracks[0].id, sourceId: 'x', start: 0, length: 100 });
    s = S.addClips(s, [a]);
    const out = S.removeTimeFromClips(s, 20, 40, { ids: [a.id] });
    expect(out.clips.map((c) => [c.start, c.offset, c.length])).toEqual([[0, 0, 20], [40, 40, 60]]);
    const trimmed = S.trimClipsToRange(s, [a.id], 10, 30);
    expect(S.findClip(trimmed, a.id)).toMatchObject({ start: 10, length: 20, offset: 10 });
  });

  it('sets fades clamped to the clip length', () => {
    const [s, c] = withClip(base(1), { length: 100 });
    const out = S.setFade(s, [c.id], 'in', { length: 500, curve: 2 });
    expect(S.findClip(out, c.id).fadeIn).toEqual({ length: 100, curve: 2 });
  });

  it('inserts envelope keyframes with implicit end points and writes automation ranges', () => {
    const { points, index } = S.insertEnvelopePoint([], 50, -6, 100, 0);
    expect(points).toEqual([{ t: 0, v: 0 }, { t: 50, v: -6 }, { t: 100, v: 0 }]);
    expect(index).toBe(1);
    expect(S.envelopeValue(points, 25)).toBe(-3);
    const written = S.writeEnvelopeRange([{ t: 0, v: 0 }, { t: 10, v: 1 }, { t: 30, v: 2 }], 5, 20, [{ t: 6, v: 5 }, { t: 19, v: 6 }]);
    expect(written.map((p) => p.t)).toEqual([0, 6, 19, 30]);
  });

  it('groups clips and expands selections to whole groups; z-order', () => {
    let s = base(1);
    const a = S.createClip({ trackId: s.tracks[0].id, sourceId: 'x', start: 0, length: 10 });
    const b = S.createClip({ trackId: s.tracks[0].id, sourceId: 'x', start: 20, length: 10 });
    s = S.groupClips(S.addClips(s, [a, b]), [a.id, b.id]);
    expect(S.expandGroups(s, [a.id]).sort()).toEqual([a.id, b.id].sort());
    expect(S.ungroupClips(s, [a.id]).clips.every((c) => !c.groupId)).toBe(true);
    const front = S.bringToFront(s, [a.id]);
    expect(S.findClip(front, a.id).z).toBeGreaterThan(S.findClip(front, b.id).z);
  });
});

describe('crossfades and playback plan', () => {
  it('detects partial overlaps on the same track but not containment or other tracks', () => {
    let s = base(2);
    const t0 = s.tracks[0].id;
    const a = S.createClip({ trackId: t0, sourceId: 'x', start: 0, length: 100 });
    const b = S.createClip({ trackId: t0, sourceId: 'x', start: 80, length: 100 });
    const inner = S.createClip({ trackId: t0, sourceId: 'x', start: 10, length: 20 });
    const other = S.createClip({ trackId: s.tracks[1].id, sourceId: 'x', start: 50, length: 100 });
    s = S.addClips(s, [a, b, inner, other]);
    const x = S.crossfades(s);
    expect(x).toEqual([{ trackId: t0, out: a.id, in: b.id, start: 80, end: 100 }]);
  });

  it('crossfades overlapping clips (symmetric) and hides rear clips when crossfades are off', () => {
    let s = base(1);
    const t0 = s.tracks[0].id;
    const a = S.createClip({ trackId: t0, sourceId: 'x', start: 0, length: 100, fadeOut: { length: 5, curve: -0.5 } });
    const b = S.createClip({ trackId: t0, sourceId: 'x', start: 80, length: 100, fadeIn: { length: 0, curve: 2 } });
    s = S.addClips(s, [a, b]);
    const plan = clipPlan(s);
    expect(plan.get(a.id).parts).toEqual([[0, 100]]);
    expect(plan.get(a.id).fadeOut).toEqual({ length: 20, curve: 2 });
    expect(plan.get(b.id).fadeIn).toEqual({ length: 20, curve: 2 });
    const asym = clipPlan(S.updateClips(s, [b.id], { crossfade: 'asymmetric' }));
    expect(asym.get(a.id).fadeOut.curve).toBe(-0.5);
    const off = clipPlan({ ...s, autoCrossfade: false });
    expect(off.get(a.id).parts).toEqual([[0, 80]]);
    expect(off.get(b.id).parts).toEqual([[80, 180]]);
  });

  it('plans many overlapping clips like a clip-by-clip comparison, and reuses the plan', () => {
    // The plan as every clip against every other clip on its track.
    const naive = (st) => {
      const order = S.frontOrder(st);
      const zones = new Map(S.activeCrossfades(st).flatMap((x) => [[`${x.out}|${x.in}`, [x.start, x.end]], [`${x.in}|${x.out}`, [x.start, x.end]]]));
      const out = new Map();
      for (const c of st.clips) {
        if (c.mute) continue;
        let parts = [[c.start, S.clipEnd(c)]];
        const cut = (x, y) => (parts = parts.flatMap(([p, q]) => (y <= p || x >= q ? [[p, q]] : [[p, Math.min(x, q)], [Math.max(y, p), q]].filter(([u, v]) => v > u))));
        for (const o of st.clips) {
          if (o === c || o.mute || o.trackId !== c.trackId || order.get(o.id) < order.get(c.id)) continue;
          if (o.start >= S.clipEnd(c) || S.clipEnd(o) <= c.start) continue;
          const zone = zones.get(`${c.id}|${o.id}`);
          if (!zone) cut(o.start, S.clipEnd(o));
          else {
            if (zone[0] > o.start) cut(o.start, zone[0]);
            if (zone[1] < S.clipEnd(o)) cut(zone[1], S.clipEnd(o));
          }
        }
        out.set(c.id, parts);
      }
      return out;
    };
    let seed = 7;
    const rnd = (n) => ((seed = (seed * 1103515245 + 12345) % 2147483648) % n);
    for (let round = 0; round < 20; round++) {
      let st = base(3);
      const clips = [];
      for (let i = 0; i < 40; i++) clips.push(S.createClip({ trackId: st.tracks[rnd(3)].id, sourceId: 'x', start: rnd(2000), length: 1 + rnd(round % 4 ? 300 : 1500), z: rnd(3), mute: rnd(10) === 0 }));
      st = { ...S.addClips(st, clips), autoCrossfade: round % 2 === 0 };
      const plan = clipPlan(st);
      const want = naive(st);
      for (const [id, parts] of want) expect(plan.get(id).parts).toEqual(parts);
      expect(clipPlan(st)).toBe(plan);
      // An edit on one track: the other tracks reuse their plans, the edited one is planned again.
      const moved = S.moveClips(st, [st.clips[rnd(40)].id], rnd(400) - 200, rnd(3) - 1);
      const next = clipPlan(moved);
      for (const [id, parts] of naive(moved)) expect(next.get(id).parts).toEqual(parts);
    }
  });
});

describe('session graph', () => {
  const pool = (frames = 1000, ch = 2) => new Map([['src', { channels: Array.from({ length: ch }, () => Channel.fromSamples(new Float32Array(frames).fill(0.5))) }]]);

  it('builds tracks with dB gain, pan, mute/solo, fx power and clip fields', () => {
    let s = base(2);
    const slot = { id: 'a', effect: 'amplify', values: { left: -3, right: -3, linked: true }, enabled: true };
    s = S.updateTrack(s, s.tracks[0].id, { volume: -6, pan: 50, fx: [slot, null], fxPower: false });
    s = S.updateTrack(s, s.tracks[1].id, { fx: [null, slot, { ...slot, id: 'b', enabled: false }] });
    let c;
    [s, c] = withClip(s, { start: 10, offset: 5, length: 200, gain: 6 });
    const { graph, sources } = buildSessionGraph(s, pool());
    expect(sources.size).toBe(1);
    const t = graph.tracks[0];
    expect(t.gain).toBeCloseTo(0.501, 2);
    expect(t.pan).toBe(0.5);
    expect(t.fx).toEqual([]);
    expect(graph.tracks[1].fx).toHaveLength(1);
    expect(graph.tracks[1].fx[0]).toMatchObject({ key: `trk:${s.tracks[1].id}:a`, kind: 1 });
    expect(t.clips[0]).toMatchObject({ id: c.id, start: 10, offset: 5, length: 200, base: 0, full: 200 });
    expect(t.clips[0].gain).toBeCloseTo(1.995, 2);
    expect(graph.master.gain).toBe(1);
  });

  it('routes tracks to buses and drops routes to missing buses', () => {
    let s = base(2);
    const bus = S.createTrack({ type: 'bus' });
    s = S.addTrack(s, bus);
    s = S.updateTrack(s, s.tracks[0].id, { output: bus.id });
    s = S.updateTrack(s, s.tracks[1].id, { output: 'nope' });
    const { graph } = buildSessionGraph(s, pool());
    expect(graph.tracks[0].output).toBe(bus.id);
    expect(graph.tracks[1].output).toBeUndefined();
    expect(graph.tracks[2].bus).toBe(true);
  });

  it('applies automation in Read mode and ignores it when Off or while writing', () => {
    let s = base(1);
    const id = s.tracks[0].id;
    s = S.setAutomation(s, id, 'volume', [{ t: 0, v: 0 }, { t: 100, v: -12 }]);
    s = S.setAutomation(s, id, 'pan', [{ t: 0, v: -100 }]);
    let g = buildSessionGraph(s, pool()).graph.tracks[0];
    expect(g.gain).toBe(1);
    expect(g.volumeEnv[0]).toEqual({ t: 0, v: 1 });
    expect(g.volumeEnv[g.volumeEnv.length - 1].v).toBeCloseTo(0.251, 2);
    expect(g.volumeEnv.length).toBeGreaterThan(2); // subdivided dB ramp
    expect(g.panEnv).toEqual([{ t: 0, v: -1 }]);
    g = buildSessionGraph(S.updateTrack(s, id, { mode: 'off', volume: -6 }), pool()).graph.tracks[0];
    expect(g.volumeEnv).toBeUndefined();
    expect(g.gain).toBeCloseTo(0.501, 2);
    g = buildSessionGraph(s, pool(), { overrides: { [id]: { volume: 0 } } }).graph.tracks[0];
    expect(g.volumeEnv).toBeUndefined();
    expect(g.panEnv).toBeTruthy();
  });

  it('expands looped clips into source segments with base offsets', () => {
    let [s] = withClip(base(1), { start: 0, offset: 50, length: 250, loop: true, fadeOut: { length: 10, curve: 0 } });
    const clips = buildSessionGraph(s, pool(100)).graph.tracks[0].clips;
    expect(clips.map((c) => [c.start, c.offset, c.length, c.base])).toEqual([[0, 50, 50, 0], [50, 0, 100, 50], [150, 0, 100, 150]]);
    expect(clips.every((c) => c.full === 250 && c.fadeOut === 10)).toBe(true);
    // A non-looped clip longer than its source stops at the source end.
    [s] = withClip(base(1), { start: 0, offset: 50, length: 250 });
    expect(buildSessionGraph(s, pool(100)).graph.tracks[0].clips[0].length).toBe(50);
  });

  it('skips muted clips, clips without media, and clips outside a clip filter; adds the metronome', () => {
    let s = base(1);
    const a = S.createClip({ trackId: s.tracks[0].id, sourceId: 'src', start: 0, length: 10 });
    const b = S.createClip({ trackId: s.tracks[0].id, sourceId: 'src', start: 20, length: 10, mute: true });
    const c = S.createClip({ trackId: s.tracks[0].id, sourceId: 'gone', start: 40, length: 10 });
    s = { ...S.addClips(s, [a, b, c]), metronome: true };
    const bar = metronomeBar(Channel, { sampleRate: RATE, tempo: 120, beatsPerBar: 4 });
    expect(bar[0].length).toBe(2000);
    let g = buildSessionGraph(s, pool(), { metronome: bar, metronomeEnd: 5000 }).graph;
    expect(g.tracks[0].clips.map((x) => x.id)).toEqual([a.id]);
    expect(g.tracks[1].id).toBe('__metronome');
    expect(g.tracks[1].clips).toHaveLength(3);
    g = buildSessionGraph(s, pool(), { clipIds: new Set([b.id]) }).graph;
    expect(g.tracks[0].clips).toHaveLength(0);
  });

  it('converts dB envelopes to gains with the silent floor', () => {
    expect(dbEnvelopeToGain([{ t: 0, v: S.SILENT_DB }])).toEqual([{ t: 0, v: 0 }]);
    expect(dbEnvelopeToGain([{ t: 0, v: 0 }, { t: 10, v: -1 }])).toHaveLength(2);
  });
});

describe('Session document', () => {
  it('records one undo step per apply and coalesces gestures', () => {
    const doc = new Session({ name: 'Test.asesx', sampleRate: RATE, tracks: 2 });
    const id = doc.state.tracks[0].id;
    doc.apply('Volume', S.updateTrack(doc.state, id, { volume: -1 }), { coalesce: 'vol' });
    doc.apply('Volume', S.updateTrack(doc.state, id, { volume: -2 }), { coalesce: 'vol' });
    doc.endGesture();
    doc.apply('Volume', S.updateTrack(doc.state, id, { volume: -3 }), { coalesce: 'vol' });
    expect(doc.history.entries).toHaveLength(3);
    doc.history.undo();
    expect(S.findTrack(doc.state, id).volume).toBe(-2);
    expect(doc.dirty).toBe(true);
  });

  it('keeps previews out of history and selects whole groups', () => {
    const doc = new Session({ sampleRate: RATE, tracks: 1 });
    const a = S.createClip({ trackId: doc.state.tracks[0].id, sourceId: 'x', start: 0, length: 10 });
    const b = S.createClip({ trackId: doc.state.tracks[0].id, sourceId: 'x', start: 30, length: 10 });
    doc.apply('Add', S.groupClips(S.addClips(doc.state, [a, b]), [a.id, b.id]));
    const moved = S.moveClips(doc.state, [a.id], 5);
    doc.preview(moved);
    expect(doc.viewState).toBe(moved);
    expect(doc.history.entries).toHaveLength(2);
    doc.apply('Move', moved);
    expect(doc.previewState).toBe(null);
    doc.selectClips([a.id]);
    expect([...doc.selectedClips].sort()).toEqual([a.id, b.id].sort());
    doc.apply('Delete', S.removeClips(doc.state, [a.id]));
    expect([...doc.selectedClips]).toEqual([b.id]);
    expect(doc.length).toBe(40);
    expect(doc.extent).toBeGreaterThanOrEqual(60 * RATE);
  });
});

describe('session files', () => {
  it('round-trips a session through JSON with media references', () => {
    const doc = new Session({ name: 'My Song.asesx', sampleRate: RATE, tracks: 2 });
    const src = doc.addSource({ name: 'Take: 1.wav', channels: [Channel.fromSamples(new Float32Array(500))] });
    const unused = doc.addSource({ name: 'Unused', channels: [Channel.fromSamples(new Float32Array(5))] });
    const bus = S.createTrack({ type: 'bus', name: 'Bus' });
    let s = S.addTrack(doc.state, bus);
    s = S.updateTrack(s, s.tracks[0].id, { output: bus.id, automation: { volume: [{ t: 0, v: -3 }], pan: [] } });
    s = S.addClips(s, [S.createClip({ trackId: s.tracks[0].id, sourceId: src, start: 10, length: 100, volumeEnv: [{ t: 0, v: -6 }] })]);
    s = { ...s, markers: [createMarker({ start: 20, name: 'Verse' })] };
    doc.apply('Setup', s);
    const { text, media } = serializeSession(doc);
    expect(media).toHaveLength(1);
    expect(media[0].file).toBe('My Song_Media/Take_ 1.wav');
    expect(unused).toBeTruthy();
    const parsed = parseSession(text);
    expect(parsed.state.tracks.map((t) => t.id)).toEqual(s.tracks.map((t) => t.id));
    expect(parsed.state.tracks[0].output).toBe(bus.id);
    expect(parsed.state.clips[0]).toEqual(s.clips[0]);
    expect(parsed.state.markers[0].name).toBe('Verse');
    expect(parsed.sources[0]).toMatchObject({ id: src, frames: 500, channels: 1 });
  });

  it('rejects files that are not sessions and sanitizes names', () => {
    expect(() => parseSession('nope')).toThrow(/damaged/);
    expect(() => parseSession('{"format":"x"}')).toThrow(/not an Audio Studio session/);
    expect(safeFileName('a/b:c.wav')).toBe('a_b_c');
    expect(mediaFolderName('Song.asesx')).toBe('Song_Media');
  });

  it('writes and reads stored zip archives', async () => {
    const enc = new TextEncoder();
    expect(crc32(enc.encode('123456789'))).toBe(0xcbf43926);
    const blob = zipStore([{ name: 'a.txt', data: enc.encode('hello') }, { name: 'dir/b.bin', data: new Uint8Array([1, 2, 3]) }]);
    const files = unzipStore(await blob.arrayBuffer());
    expect(new TextDecoder().decode(files.get('a.txt'))).toBe('hello');
    expect([...files.get('dir/b.bin')]).toEqual([1, 2, 3]);
  });
});

describe('track rack levels and polarity in the graph', () => {
  it('adds rack gains, the dry/wet split and polarity to tracks and the master', async () => {
    const { trackRackSpecs } = await import('../src/model/session-graph.js');
    const { makeSlot } = await import('../src/effects/rack.js');
    const doc = { sampleRate: 48000 };
    const t = S.createTrack({ id: 'tA', fx: [makeSlot('amplify', { left: 1, right: 1 })], fxIn: 6, fxOut: -3, fxMix: 0.4 });
    const r = trackRackSpecs(t, doc);
    expect(r.fx.map((x) => x.key)).toEqual(['trk:tA:in', `trk:tA:${t.fx[0].id}`, 'trk:tA:out']);
    expect(r.fxWet).toBe(2);
    expect(r.fxMix).toBeCloseTo(0.4);
    expect(r.fxDry).toBeCloseTo(Math.pow(10, 6 / 20));
    // Gains need effects to run; power off bypasses everything.
    expect(trackRackSpecs({ ...t, fx: [] }, doc)).toEqual({ fx: [] });
    expect(trackRackSpecs({ ...t, fxPower: false }, doc)).toEqual({ fx: [] });
    expect(trackRackSpecs({ ...t, fxIn: 0, fxOut: 0, fxMix: 1 }, doc).fx).toHaveLength(1);

    let s = S.createSessionState({ sampleRate: 48000, tracks: 1 });
    s = S.updateTrack(s, s.tracks[0].id, { invert: true });
    s = { ...s, master: { ...s.master, invert: true } };
    const { graph } = buildSessionGraph(s, new Map());
    expect(graph.tracks[0].invert).toBe(true);
    expect(graph.master.invert).toBe(true);
    // New fields survive a save.
    const back = S.createTrack(JSON.parse(JSON.stringify(t)));
    expect([back.fxIn, back.fxOut, back.fxMix, back.invert]).toEqual([6, -3, 0.4, false]);
  });
});
