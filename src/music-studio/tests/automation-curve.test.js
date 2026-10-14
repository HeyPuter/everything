// Automation curve tension: the shape function, point edits that carry the
// curve, and the engine evaluating compiled curves exactly like the playlist.
import { describe, it, expect } from 'vitest';
import { curveShape, evaluateAutomation, CURVE_K } from '../src/automation/evaluate.js';
import { addPoint, movePoint, normalizePoints, setCurve, segmentAt, dragCurve, CURVE_PRESETS } from '../src/automation/points.js';
import { automationValue } from '../src/engine/sequencer.js';
import { compileSequence } from '../src/engine/compile.js';
import { createProject, createChannel } from '../src/model/project.js';
import { serializeProject, parseProject } from '../src/model/serialize.js';

describe('curveShape', () => {
  it('is linear at 0 and keeps the end points for every tension', () => {
    for (const x of [0, 0.1, 0.5, 0.9, 1]) expect(curveShape(x, 0)).toBe(x);
    for (const c of [-1, -0.5, -0.01, 0.01, 0.3, 1]) {
      expect(curveShape(0, c)).toBeCloseTo(0, 12);
      expect(curveShape(1, c)).toBeCloseTo(1, 12);
    }
  });

  it('is monotonic, bounded and point-symmetric between c and -c', () => {
    for (const c of [-1, -0.7, -0.2, 0.2, 0.7, 1]) {
      let prev = -1;
      for (let x = 0; x <= 1.0000001; x += 0.01) {
        const y = curveShape(x, c);
        expect(y).toBeGreaterThanOrEqual(prev);
        expect(y).toBeGreaterThanOrEqual(0);
        expect(y).toBeLessThanOrEqual(1 + 1e-12);
        expect(curveShape(x, -c)).toBeCloseTo(1 - curveShape(1 - x, c), 12);
        prev = y;
      }
    }
  });

  it('bends positive tension late (ease in) and negative early (ease out)', () => {
    expect(curveShape(0.5, 0.5)).toBeLessThan(0.5);
    expect(curveShape(0.5, -0.5)).toBeGreaterThan(0.5);
    // At full tension the midpoint is (e^(K/2) - 1) / (e^K - 1).
    expect(curveShape(0.5, 1)).toBeCloseTo(Math.expm1(CURVE_K / 2) / Math.expm1(CURVE_K), 12);
    expect(curveShape(0.5, 1)).toBeLessThan(0.05);
    // Out-of-range tensions are clamped; tiny ones stay continuous.
    expect(curveShape(0.3, 5)).toBe(curveShape(0.3, 1));
    expect(curveShape(0.3, 1e-9)).toBeCloseTo(0.3, 6);
  });
});

describe('evaluateAutomation with curves', () => {
  const pts = [{ t: 0, v: 0, c: 0.8 }, { t: 100, v: 1, c: -0.8 }, { t: 200, v: 0.2 }];
  it('shapes each segment by its start point', () => {
    expect(evaluateAutomation(pts, 50)).toBeCloseTo(curveShape(0.5, 0.8), 12);
    expect(evaluateAutomation(pts, 150)).toBeCloseTo(1 - 0.8 * curveShape(0.5, -0.8), 12);
    expect(evaluateAutomation(pts, 100)).toBe(1);
    expect(evaluateAutomation(pts, 250)).toBe(0.2);
    expect(evaluateAutomation([{ t: 0, v: 0.5, c: 1 }, { t: 10, v: 0.5 }], 5)).toBe(0.5);
  });
});

describe('point edits keep curves', () => {
  it('sets, clamps, rounds and clears curves', () => {
    const a = [{ t: 0, v: 0 }, { t: 100, v: 1 }];
    const b = setCurve(a, 0, 0.42);
    expect(b[0]).toEqual({ t: 0, v: 0, c: 0.42 });
    expect(a[0].c).toBeUndefined();
    expect(setCurve(b, 0, 7)[0].c).toBe(1);
    expect(setCurve(b, 0, 0)[0]).toEqual({ t: 0, v: 0 });
    expect(setCurve(b, 0, 0.42)).toBe(b);
    expect(setCurve(b, 5, 0.3)).toBe(b);
    expect(movePoint(b, 0, { t: 10, v: 0.5 })[0]).toEqual({ t: 10, v: 0.5, c: 0.42 });
    expect(normalizePoints([{ t: 5, v: 2, c: -3 }, { t: 1, v: 0 }])).toEqual([{ t: 1, v: 0 }, { t: 5, v: 1, c: -1 }]);
  });

  it('splits a curved segment into two curved halves', () => {
    const a = [{ t: 0, v: 0, c: 0.5 }, { t: 100, v: 1 }];
    const r = addPoint(a, { t: 50, v: 0.3 });
    expect(r.points[1]).toEqual({ t: 50, v: 0.3, c: 0.5 });
    expect(addPoint(a, { t: 150, v: 0.3 }).points[2]).toEqual({ t: 150, v: 0.3 });
  });

  it('finds segments and maps drags so up bends the curve up', () => {
    const a = [{ t: 0, v: 0 }, { t: 100, v: 1 }, { t: 100, v: 0 }, { t: 200, v: 0.5 }];
    expect(segmentAt(a, 50)).toBe(0);
    expect(segmentAt(a, 100)).toBe(2);
    expect(segmentAt(a, 250)).toBe(-1);
    // Rising segment: dragging up means a quick start (negative tension).
    const up = dragCurve(0, 0, 1, 0.2);
    expect(up).toBeLessThan(0);
    expect(curveShape(0.5, up)).toBeGreaterThan(0.5);
    // Falling segment: dragging up delays the fall (positive tension).
    const down = dragCurve(0, 1, 0, 0.2);
    expect(down).toBeGreaterThan(0);
    expect(1 - curveShape(0.5, down)).toBeGreaterThan(0.5);
    expect(dragCurve(0.3, 0.5, 0.5, 0.4)).toBe(0);
    expect(dragCurve(0.9, 0, 1, -1)).toBe(1);
    expect(CURVE_PRESETS.find((p) => p.id === 'linear').c).toBe(0);
  });

  it('survives saving and loading', () => {
    const p = createProject();
    p.automation = { a: { id: 'a', name: 'A', target: { kind: 'tempo' }, points: [{ t: 0, v: 0.2, c: -0.35 }, { t: 96, v: 0.9 }] } };
    const back = parseProject(serializeProject(p));
    expect(back.automation.a.points).toEqual([{ t: 0, v: 0.2, c: -0.35 }, { t: 96, v: 0.9 }]);
  });
});

describe('engine curve evaluation', () => {
  it('compiles curves and evaluates them exactly like evaluateAutomation', () => {
    const p = createProject();
    const ch = createChannel({ type: 'synth' });
    p.channels = [ch];
    const points = [{ t: 0, v: 0.1, c: 0.9 }, { t: 96, v: 0.8, c: -0.4 }, { t: 192, v: 0.3 }, { t: 192, v: 0.6, c: 0.25 }, { t: 384, v: 1 }];
    p.automation = { a: { id: 'a', name: 'Cutoff', target: { kind: 'channel', id: ch.id, param: 'cutoff' }, points } };
    p.clips = [{ id: 'c', kind: 'auto', track: 0, start: 384, len: 384, offset: 24, ref: 'a', mute: false }];
    const seq = compileSequence(p, { mode: 'song', slotOf: () => 0 });
    const seg = seq.auto[0].segs[0];
    expect(seg.cs).toBeInstanceOf(Float64Array);
    expect([...seg.cs]).toEqual([0.9, -0.4, 0, 0.25, 0]);
    for (let tick = 384; tick < 768; tick += 3.5) {
      const local = tick - 384 + 24;
      expect(automationValue(seg.pts, tick, seg.cs)).toBeCloseTo(evaluateAutomation(points, local), 12);
    }
    // Linear automations carry no curve array.
    p.automation.a = { ...p.automation.a, points: points.map(({ t, v }) => ({ t, v })) };
    expect(compileSequence(p, { mode: 'song', slotOf: () => 0 }).auto[0].segs[0].cs).toBe(null);
  });
});

describe('playlist curve keyboard model', () => {
  async function setup() {
    const { Store } = await import('../src/model/store.js');
    const { installCurves, describeCurve } = await import('../src/playlist/curves.js');
    const C = await import('../src/playlist/clips.js');
    const p = createProject();
    p.automation = { a: { id: 'a', name: 'Tempo', target: { kind: 'tempo' }, points: [{ t: 0, v: 0.2 }, { t: 96, v: 0.8 }, { t: 192, v: 0.8 }] } };
    p.clips = [{ id: 'c', kind: 'auto', track: 0, start: 384, len: 384, offset: 0, ref: 'a', mute: false }];
    const store = new Store(p);
    const hints = [];
    const V = { store, app: { hint: (t) => hints.push(t) }, selection: new Set(['c']), cursor: { track: 0, tick: 0 }, markDirty() {}, revealTick() {} };
    V.byTrack = C.clipsByTrack(p.clips, p.tracks.length);
    installCurves(V);
    return { V, store, hints, describeCurve };
  }

  it('steps through points and bends the active segment in one undo step per key', async () => {
    const { V, store, hints, describeCurve } = await setup();
    V.stepPoint(1);
    expect(V.activePoint).toEqual({ clip: 'c', index: 0 });
    expect(hints.at(-1)).toMatch(/Tempo point 1 of 3: 2:01:00, 76 BPM, curve linear/);
    V.bendCurve(1);
    const c = store.project.automation.a.points[0].c;
    expect(c).toBeLessThan(0); // a rising segment bent up eases out
    expect(store.undoLabel).toBe('Change curve');
    V.bendCurve(1);
    expect(store.project.automation.a.points[0].c).toBeLessThan(c);
    V.resetCurve();
    expect(store.project.automation.a.points[0].c).toBeUndefined();
    store.undo();
    expect(store.project.automation.a.points[0].c).toBeCloseTo(2 * c, 9);
    // The flat segment after point 2 takes no curve.
    V.stepPoint(1);
    V.bendCurve(1);
    expect(store.project.automation.a.points[1].c).toBeUndefined();
    expect(V.curveItems(store.project.clips[0], 0).find((i) => i.label === 'Linear').checked).toBe(false);
    V.curveItems(store.project.clips[0], 0).find((i) => i.label.startsWith('Ease in')).run();
    expect(store.project.automation.a.points[0].c).toBe(0.5);
    expect(describeCurve(0.5)).toBe('ease in 50%');
    expect(describeCurve(-0.25)).toBe('ease out 25%');
    expect(describeCurve(0)).toBe('linear');
  });
});
