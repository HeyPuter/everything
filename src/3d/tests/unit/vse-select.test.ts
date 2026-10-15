import { describe, it, expect } from 'vitest';
import * as S from '../../src/sequencer/strips';
import * as L from '../../src/sequencer/selection';
import { connect, disconnect, connectedOf, withConnected, remapConnections } from '../../src/sequencer/connect';
import type { Strip } from '../../src/sequencer/types';

const ed = () => S.newSequenceEditor();
function add(e: ReturnType<typeof ed>, type: Strip['type'], channel: number, start: number, dur: number, name?: string) {
  const s = S.newStrip(type, S.uniqueName(e, name ?? S.STRIP_LABELS[type]), channel, start, dur);
  s.select = false;
  e.strips.push(s);
  return s;
}
const names = (l: Strip[]) => l.filter((s) => s.select).map((s) => s.name).sort();

describe('timeline selection rules', () => {
  it('finds touching neighbours on the same channel only', () => {
    const e = ed();
    const a = add(e, 'COLOR', 1, 1, 10, 'a');
    const b = add(e, 'COLOR', 1, 11, 10, 'b');
    const c = add(e, 'COLOR', 1, 25, 10, 'c');
    add(e, 'COLOR', 2, 21, 4, 'd');
    expect(L.neighbor(e.strips, b, 'LEFT')).toBe(a);
    expect(L.neighbor(e.strips, b, 'RIGHT')).toBeNull();
    expect(L.neighbor(e.strips, c, 'LEFT')).toBeNull();
  });

  it('selects handles, including the neighbours of an edit point', () => {
    const e = ed();
    const a = add(e, 'COLOR', 1, 1, 10, 'a');
    const b = add(e, 'COLOR', 1, 11, 10, 'b');
    b.select = true;
    L.selectHandles(e.strips, 'LEFT');
    expect([b.select_left_handle, b.select_right_handle]).toEqual([true, false]);
    L.selectHandles(e.strips, 'BOTH');
    expect([b.select_left_handle, b.select_right_handle]).toEqual([true, true]);
    L.selectHandles(e.strips, 'LEFT_NEIGHBOR');
    expect(a.select && a.select_right_handle && !a.select_left_handle).toBe(true);
    expect([b.select_left_handle, b.select_right_handle]).toEqual([true, false]);
  });

  it('grows, shrinks and chains the selection along touching strips', () => {
    const e = ed();
    const a = add(e, 'COLOR', 1, 1, 10, 'a');
    add(e, 'COLOR', 1, 11, 10, 'b');
    add(e, 'COLOR', 1, 21, 10, 'c');
    add(e, 'COLOR', 1, 40, 10, 'd');
    a.select = true;
    expect(L.selectMoreLess(e.strips, true)).toBe(true);
    expect(names(e.strips)).toEqual(['a', 'b']);
    expect(L.selectMoreLess(e.strips, false)).toBe(true);
    expect(names(e.strips)).toEqual(['a']);
    expect(L.linkedChain(e.strips, a).map((s) => s.name).sort()).toEqual(['a', 'b', 'c']);
  });

  it('selects the strips beside the selection in its channels', () => {
    const e = ed();
    add(e, 'COLOR', 1, 1, 10, 'a');
    const b = add(e, 'COLOR', 1, 20, 10, 'b');
    add(e, 'COLOR', 1, 40, 10, 'c');
    add(e, 'COLOR', 2, 1, 10, 'other');
    b.select = true;
    L.selectChannelSide(e.strips, 'LEFT');
    expect(names(e.strips)).toEqual(['a', 'b']);
    L.selectChannelSide(e.strips, 'BOTH');
    expect(names(e.strips)).toEqual(['a', 'b', 'c']);
  });

  it('matches strips with the same range on other channels', () => {
    const e = ed();
    const m = add(e, 'MOVIE', 2, 1, 50, 'movie');
    add(e, 'SOUND', 1, 1, 50, 'sound');
    add(e, 'SOUND', 3, 1, 40, 'short');
    expect(L.sameTime(e.strips, m).map((s) => s.name)).toEqual(['sound']);
  });

  it('box selection with handles picks the edge the box covers', () => {
    expect(L.boxHit(100, 200, 90, 105, 8)).toBe('LEFT');
    expect(L.boxHit(100, 200, 195, 260, 8)).toBe('RIGHT');
    expect(L.boxHit(100, 200, 50, 260, 8)).toBe('STRIP');
    expect(L.boxHit(100, 200, 140, 150, 8)).toBe('STRIP');
    expect(L.boxHit(100, 200, 210, 260, 8)).toBeNull();
  });

  it('tests rectangles against circles and lassos', () => {
    const r = { x0: 0, y0: 0, x1: 10, y1: 10 };
    expect(L.rectCircle(r, 15, 5, 5)).toBe(true);
    expect(L.rectCircle(r, 16, 5, 5)).toBe(false);
    const tri: [number, number][] = [
      [-5, -5],
      [30, -5],
      [-5, 30],
    ];
    expect(L.rectLasso(r, tri)).toBe(true);
    expect(L.rectLasso({ x0: 40, y0: 40, x1: 50, y1: 50 }, tri)).toBe(false);
  });
});

describe('connected strips', () => {
  it('connects a group, finds members and disconnects', () => {
    const e = ed();
    const a = add(e, 'MOVIE', 2, 1, 50, 'a');
    const b = add(e, 'SOUND', 1, 1, 50, 'b');
    const c = add(e, 'COLOR', 3, 1, 50, 'c');
    connect(e.strips, [a, b, c]);
    expect(connectedOf(e.strips, a).map((s) => s.name).sort()).toEqual(['b', 'c']);
    expect(withConnected(e.strips, [b]).length).toBe(3);
    // reconnecting a subset leaves the old group
    connect(e.strips, [a, b]);
    expect(connectedOf(e.strips, c)).toEqual([]);
    disconnect(e.strips, [a]);
    expect(a.connections).toBeUndefined();
    expect(b.connections).toBeUndefined();
  });

  it('keeps connections between copies and drops the rest', () => {
    const e = ed();
    const a = add(e, 'MOVIE', 2, 1, 50, 'a');
    const b = add(e, 'SOUND', 1, 1, 50, 'b');
    connect(e.strips, [a, b]);
    const ca = S.cloneStrip(a, 'a.001');
    const cb = S.cloneStrip(b, 'b.001');
    remapConnections([ca, cb], new Map([['a', 'a.001'], ['b', 'b.001']]));
    expect(ca.connections).toEqual(['b.001']);
    const lone = S.cloneStrip(a, 'a.002');
    remapConnections([lone], new Map([['a', 'a.002']]));
    expect(lone.connections).toBeUndefined();
  });

  it('splitting connected strips connects the right halves', () => {
    const e = ed();
    const a = add(e, 'MOVIE', 2, 1, 50, 'a');
    const b = add(e, 'SOUND', 1, 1, 50, 'b');
    connect(e.strips, [a, b]);
    const right = S.splitStrips(e, e.strips, [a, b], 20, 'SOFT');
    expect(right.length).toBe(2);
    const [ra, rb] = right;
    expect(connectedOf(e.strips, ra)).toEqual([rb]);
    expect(connectedOf(e.strips, a)).toEqual([b]);
  });
});

import { boxBlade } from '../../src/sequencer/blade';

describe('box blade', () => {
  it('cuts strips in the box, removes the middle and closes the gap', () => {
    const e = ed();
    const a = add(e, 'COLOR', 1, 1, 100, 'a');
    const b = add(e, 'COLOR', 2, 1, 100, 'b');
    const r = boxBlade(e, e.strips, [a, b], 41, 61, 1, 2, true);
    expect(r.closed).toBe(20);
    const ranges = e.strips.map((s) => [s.channel, S.finalStart(s), S.finalEnd(s)]).sort((x, y) => x[0] - y[0] || x[1] - y[1]);
    expect(ranges).toEqual([
      [1, 1, 41],
      [1, 41, 81],
      [2, 1, 41],
      [2, 41, 81],
    ]);
  });

  it('keeps the gap when something else fills the range or when asked to', () => {
    const e = ed();
    const a = add(e, 'COLOR', 1, 1, 100, 'a');
    add(e, 'COLOR', 3, 1, 100, 'other');
    const r = boxBlade(e, e.strips, [a], 41, 61, 1, 1, true);
    expect(r.closed).toBe(0);
    expect(e.strips.filter((s) => s.channel === 1).map((s) => [S.finalStart(s), S.finalEnd(s)])).toEqual([
      [1, 41],
      [61, 101],
    ]);
  });
});
