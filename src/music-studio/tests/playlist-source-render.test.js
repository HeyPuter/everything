import { afterEach, expect, it, vi } from 'vitest';
import { createProject, colorAt } from '../src/model/project.js';
import { parseProject, serializeProject } from '../src/model/serialize.js';
import { Viewport } from '../src/render/timeline.js';
import { drawCanvas, resetColors } from '../src/playlist/render.js';
import { trackLayout } from '../src/playlist/geometry.js';
import { clipsByTrack } from '../src/playlist/clips.js';
import { parseColor } from '../src/ui/theme.js';
import { TITLE_H } from '../src/playlist/constants.js';

afterEach(resetColors);

function arrangement(order) {
  const p = createProject();
  p.channels = [{ id: 'shared', type: 'audio', name: 'Audio source', color: '#00ff00' }];
  p.patterns = [{ id: 'shared', name: 'Pattern source', color: '#ff0000', notes: { shared: [{ id: 'note', key: 60, pos: 20, len: 20, vel: 1 }] } }];
  p.automation = { shared: { id: 'shared', name: 'Automation source', color: '#0000ff', target: { kind: 'tempo' }, points: [{ t: 0, v: 0.5 }] } };
  p.tracks = p.tracks.slice(0, 3);
  p.clips = order.map((kind, track) => ({ id: `clip-${kind}`, kind, ref: 'shared', track, start: 0, len: 192, offset: 0, mute: false }));
  // Exercise the actual file boundary: these IDs are valid in separate collections.
  return parseProject(serializeProject(p));
}

function draw(project) {
  const vp = new Viewport({ pxPerTick: 0.5 });
  vp.width = 200;
  const d = { w: 200, h: 168, clear: vi.fn(), rect: vi.fn(), text: vi.fn() };
  drawCanvas({ store: { project }, vp, layout: trackLayout(project.tracks), scrollY: 0,
    byTrack: clipsByTrack(project.clips), selection: new Set(), selectedTrack: -1,
    app: { samples: new Map() } }, d);
  return d;
}

it.each([
  ['pattern', 'audio', 'auto'],
  ['audio', 'auto', 'pattern'],
  ['auto', 'pattern', 'audio'],
])('draws each source independently when %s is encountered first', (...order) => {
  const p = arrangement(order);
  expect(p.clips.map((c) => c.ref)).toEqual(['shared', 'shared', 'shared']);
  for (let pass = 0; pass < 2; pass++) {
    const d = draw(p);
    const names = { pattern: 'Pattern source', audio: 'Audio source', auto: 'Automation source' };
    const colors = { pattern: '#ff0000', audio: '#00ff00', auto: '#0000ff' };
    order.forEach((kind, track) => {
      expect(d.text.mock.calls.find((call) => call[2] === track * 56 + 1 + TITLE_H / 2 + 0.5)?.[0]).toBe(names[kind]);
      expect(d.rect.mock.calls.find((call) => call[1] === track * 56 + 1 && call[3] === TITLE_H)?.[4]).toEqual(parseColor(colors[kind]));
    });
    // A preceding audio/automation source must not suppress the pattern miniature.
    expect(d.rect.mock.calls.filter((call) => call[0] === 10 && call[2] === 9)).toHaveLength(1);
  }
});

it('refreshes source labels and colors after an immutable edit and theme reset', () => {
  const p = arrangement(['pattern', 'audio', 'auto']);
  draw(p);
  const changed = { ...p, patterns: [{ ...p.patterns[0], name: 'Renamed', color: '#abcdef' }] };
  for (let pass = 0; pass < 2; pass++) {
    const d = draw(changed);
    expect(d.text.mock.calls[0][0]).toBe('Renamed');
    expect(d.rect.mock.calls.find((call) => call[1] === 1 && call[3] === TITLE_H)?.[4]).toEqual(parseColor('#abcdef'));
    resetColors();
  }
});

function manyPatterns(count, color = null) {
  const p = createProject();
  p.patterns = Array.from({ length: count }, (_, i) => ({ id: `p${i}`, name: `Pattern ${i}`, color, notes: {} }));
  p.clips = p.patterns.map((pat, i) => ({ id: `clip${i}`, kind: 'pattern', ref: pat.id, track: 0, start: 0, len: 192, offset: 0, mute: false }));
  return p;
}

function countPatternReads(p) {
  let reads = 0;
  for (const pat of p.patterns) {
    const id = pat.id;
    Object.defineProperty(pat, 'id', { get() { reads++; return id; } });
  }
  return () => reads;
}

it.each([null, '#abcdef'])('resolves visible patterns with linear work (color %s)', (color) => {
  const p = manyPatterns(100, color);
  const reads = countPatternReads(p);
  const d = draw(p);
  expect(d.text.mock.calls.map((call) => call[0])).toEqual(Array.from({ length: 100 }, (_, i) => `Pattern ${i}`));
  expect(d.rect.mock.calls.filter((call) => call[1] === 1 && call[3] === TITLE_H).map((call) => call[4]))
    .toEqual(Array.from({ length: 100 }, (_, i) => parseColor(color || colorAt(i + 6))));
  expect(reads()).toBeLessThanOrEqual(400);
  const before = reads();
  draw(p);
  expect(reads()).toBe(before);
});

it('does not scan unused trailing patterns for a small visible selection', () => {
  const p = manyPatterns(100);
  p.clips = [p.clips[0]];
  const reads = countPatternReads(p);
  expect(draw(p).text.mock.calls.map((call) => call[0])).toEqual(['Pattern 0']);
  expect(reads()).toBeLessThanOrEqual(5);
});

it('preserves fallback colors after reorder and resolves earlier patterns after a later one', () => {
  const p = manyPatterns(3);
  p.clips = [p.clips[2], p.clips[0], { ...p.clips[0], id: 'repeat' }];
  for (const project of [p, { ...p, patterns: [p.patterns[2], p.patterns[0], p.patterns[1]] }, p]) {
    const d = draw(project);
    expect(d.text.mock.calls.map((call) => call[0])).toEqual(['Pattern 2', 'Pattern 0', 'Pattern 0']);
    const indices = project === p ? [2, 0, 0] : [0, 1, 1];
    expect(d.rect.mock.calls.filter((call) => call[1] === 1 && call[3] === TITLE_H).map((call) => call[4]))
      .toEqual(indices.map((index) => parseColor(colorAt(index + 6))));
  }
});

it('resolves valid sources after a missing pattern and refreshes when that pattern appears', () => {
  const p = manyPatterns(3);
  p.clips = [{ ...p.clips[0], ref: 'missing' }, p.clips[2], p.clips[0]];
  expect(draw(p).text.mock.calls.map((call) => call[0])).toEqual(['Missing pattern', 'Pattern 2', 'Pattern 0']);
  const changed = { ...p, patterns: [...p.patterns, { id: 'missing', name: 'Recovered', color: null, notes: {} }] };
  expect(draw(changed).text.mock.calls.map((call) => call[0])).toEqual(['Recovered', 'Pattern 2', 'Pattern 0']);
});
