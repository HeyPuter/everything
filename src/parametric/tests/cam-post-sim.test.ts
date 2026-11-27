// Post processor, simulation and CAM data edge cases.
import { describe, expect, it } from 'vitest';
import { simulate } from '../src/cam/simulate';
import { postProcess, type PostJob } from '../src/cam/post';
import { TriIndex } from '../src/cam/dropcutter';
import { FEED, PLUNGE, RAPID, type Toolpath } from '../src/cam/toolpath';
import { type CamTool, newCamDoc, normalizeCam } from '../src/model/cam';

const tool = (extra: Partial<CamTool> = {}): CamTool => ({
  id: 'tt', number: 1, name: 'tool', type: 'flat', diameter: 6, fluteLength: 30, flutes: 2, rpm: 10000, feed: 1000, plunge: 300, coolant: true, ...extra,
});
const path = (m: number[], clearance = 20): Toolpath => ({ moves: Float64Array.from(m), cycles: [], clearance, warnings: [] });
const job = (setups: PostJob['setups'], extra: Partial<PostJob['post']> = {}, units: 'mm' | 'in' = 'mm'): PostJob => ({
  name: 'Part', units, post: { ...newCamDoc(() => 'x').post, ...extra }, setups,
});
const emptyPart = new TriIndex(new Float64Array(0));

describe('post processor', () => {
  it('positions the tool again in a new setup that keeps the tool', () => {
    const t = tool();
    const tp = path([RAPID, 10, 10, 20, RAPID, 10, 10, 2, FEED, 10, 10, -1, RAPID, 10, 10, 20]);
    const code = postProcess(job([
      { name: 'Setup1', workOffset: 54, ops: [{ name: 'A', tool: t, rpm: 1000, feed: 500, plunge: 100, toolpath: tp }] },
      { name: 'Setup2', workOffset: 55, ops: [{ name: 'B', tool: t, rpm: 1000, feed: 500, plunge: 100, toolpath: tp }] },
    ]));
    const second = code.slice(code.indexOf('G55'));
    expect(second).toMatch(/X10\. Y10\./);
    expect(second).toMatch(/Z20\./);
    expect(code).not.toContain('M0');
    // The same work offset: a stop to turn the part, then the tool comes back to it.
    const same = postProcess(job([
      { name: 'Setup1', workOffset: 54, ops: [{ name: 'A', tool: t, rpm: 1000, feed: 500, plunge: 100, toolpath: tp }] },
      { name: 'Setup2', workOffset: 54, ops: [{ name: 'B', tool: t, rpm: 1000, feed: 500, plunge: 100, toolpath: tp }] },
    ]));
    const after = same.slice(same.indexOf('(Setup2)'));
    expect(after).toMatch(/^\(Setup2\)\n\(B\)\nM9\nM5\nG28 G91 Z0\.\nG90\n\(Set up the part for Setup2\)\nM0\nS1000 M3\nG54\nM8\nG0 X10\. Y10\.\nG43 Z20\. H1\n/);
    const grbl = postProcess({ ...job([
      { name: 'Setup1', workOffset: 54, ops: [{ name: 'A', tool: t, rpm: 1000, feed: 500, plunge: 100, toolpath: tp }] },
      { name: 'Setup2', workOffset: 54, ops: [{ name: 'B', tool: tool({ number: 2 }), rpm: 1000, feed: 500, plunge: 100, toolpath: tp }] },
    ]), post: { ...newCamDoc(() => 'x').post, controller: 'grbl' } });
    // One stop for both the part and the tool.
    expect(grbl.match(/^M0$/gm)).toHaveLength(1);
  });

  it('keeps line numbers within five digits', () => {
    const m: number[] = [RAPID, 0, 0, 20];
    for (let i = 0; i < 12000; i++) m.push(FEED, i % 2 ? 10 : 0, i * 0.01, -1);
    const code = postProcess(job([{ name: 'S', workOffset: 54, ops: [{ name: 'A', tool: tool(), rpm: 1000, feed: 500, plunge: 100, toolpath: path(m) }] }], { lineNumbers: true, arcs: false }));
    const ns = [...code.matchAll(/^N(\d+) /gm)].map((x) => Number(x[1]));
    expect(ns.length).toBeGreaterThan(12000);
    expect(Math.max(...ns)).toBeLessThanOrEqual(99999);
  });
});

describe('simulation', () => {
  const stock = { min: [0, 0, 0] as [number, number, number], max: [40, 40, 10] as [number, number, number] };

  it('counts a rapid move through the stock once', () => {
    const sim = simulate({ stock, part: emptyPart, rapidFeed: 5000, steps: [{ tool: tool(), feed: 1000, plunge: 300, toolpath: path([RAPID, -10, 20, 5, RAPID, 50, 20, 5]) }] });
    expect(sim.rapidCuts[0]).toBe(1);
    // A slot 8 mm deep with 3 mm flutes: one feed move, one warning.
    const deep = simulate({ stock, part: emptyPart, rapidFeed: 5000, steps: [{ tool: tool({ fluteLength: 3 }), feed: 1000, plunge: 300, toolpath: path([RAPID, -10, 20, 20, RAPID, -10, 20, 2, FEED, 50, 20, 2]) }] });
    expect(deep.shankHits[0]).toBe(1);
    expect(deep.rapidCuts[0]).toBe(0);
  });

  it('does not count material removed below the bottom of the stock', () => {
    const sim = simulate({ stock, part: emptyPart, rapidFeed: 5000, cell: 0.5, steps: [{ tool: tool(), feed: 1000, plunge: 300, toolpath: path([RAPID, 20, 20, 20, PLUNGE, 20, 20, -5]) }] });
    // A 6 mm hole through 10 mm of stock.
    expect(sim.removed).toBeLessThan(Math.PI * 9 * 10 * 1.2);
    expect(Math.min(...sim.snapshots[sim.snapshots.length - 1].z)).toBeGreaterThanOrEqual(0);
  });

  it('starts each step on the timeline where its tool starts', () => {
    const a = path([RAPID, 0, 0, 20, RAPID, 0, 0, 12]);
    const b = path([RAPID, 30, 30, 20, RAPID, 30, 30, 12]);
    const sim = simulate({ stock, part: emptyPart, rapidFeed: 5000, steps: [{ tool: tool(), feed: 1000, plunge: 300, toolpath: a }, { tool: tool({ number: 2 }), feed: 1000, plunge: 300, toolpath: b }] });
    const tl = sim.timeline;
    const firstOfB = [...Array(tl.length / 6).keys()].find((i) => tl[i * 6 + 4] === 1)!;
    expect([tl[firstOfB * 6], tl[firstOfB * 6 + 1], tl[firstOfB * 6 + 2]]).toEqual([30, 30, 20]);
  });
});

describe('CAM data from files', () => {
  it('drops feeds and speeds that are not numbers', () => {
    const doc = newCamDoc((p) => `${p}9`);
    const raw = JSON.parse(JSON.stringify({ ...doc, setups: [{ id: 's1', ops: [{ id: 'o1', name: 'F', type: 'face', tool: doc.tools[0].id, feed: 'fast', rpm: -5, pattern: 'x' }] }] }));
    const n = normalizeCam(raw)!;
    const o = n.setups[0].ops[0];
    expect(o.feed).toBeUndefined();
    expect(o.rpm).toBeUndefined();
  });
});
