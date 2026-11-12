// The every-line composer reuses the plans of paragraphs whose inputs did not
// change: layouts must come out exactly as they do without the cache, over
// random edits, styles, paragraph settings, frame shapes, wraps and threads.
import { describe, it, expect, afterEach } from 'vitest';
import { createText } from '../src/model/nodes.js';
import {
  layoutText,
  editLayout,
  textHooks,
  setComposeCache,
  invalidateTextLayout,
} from '../src/model/text-layout.js';
import { replaceRange, applyRunStyle } from '../src/model/text-runs.js';

const insertText = (node, at, t) => ({ ...node, ...replaceRange(node, at, at, t) });
const deleteRange = (node, a, b) => ({ ...node, ...replaceRange(node, a, b, '') });
const setCharStyle = (node, a, b, patch) => ({ ...node, runs: applyRunStyle(node, a, b, patch) });

const CHAR = { fontFamily: 'Approx Sans', fontWeight: 400, fontStyle: 'normal', fontSize: 10 };
const WORDS =
  'typography internationalization the quick brown fox jumps over a lazy dog characteristically responsibilities hyphenation is a balancing act — well-known e.g. 1234'.split(
    ' ',
  );

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const pick = (r, list) => list[Math.floor(r() * list.length)];

function story(r, paras) {
  const out = [];
  for (let p = 0; p < paras; p++) {
    const n = 3 + Math.floor(r() * 40);
    const w = [];
    for (let k = 0; k < n; k++) w.push(pick(r, WORDS));
    out.push(w.join(' '));
  }
  return out.join('\n');
}

function randomPara(r) {
  return {
    align: pick(r, ['left', 'justify', 'justify', 'center', 'justify-all', 'right']),
    composer: 'every',
    hyphenate: r() < 0.7,
    hyphenation:
      r() < 0.3 ? { minWord: 4, limit: pick(r, [0, 1, 3]), zone: pick(r, [0, 12, 36]) } : undefined,
    justification:
      r() < 0.3
        ? {
            wordMin: 70,
            wordDesired: 100,
            wordMax: 160,
            letterMin: -5,
            letterDesired: 0,
            letterMax: 10,
          }
        : undefined,
    spaceBefore: r() < 0.3 ? 4 : 0,
    indentFirst: r() < 0.3 ? 12 : 0,
  };
}

const TRI = [
  { x: 0, y: 0 },
  { x: 260, y: 0 },
  { x: 40, y: 400 },
];
const CIRCLE = Array.from({ length: 40 }, (_, k) => ({
  x: 130 + 130 * Math.cos((k / 40) * 2 * Math.PI),
  y: 130 + 130 * Math.sin((k / 40) * 2 * Math.PI),
}));

function snapshot(lay) {
  return {
    overflow: lay.overflow,
    visibleEnd: lay.visibleEnd,
    lines: lay.lines.map((l) => ({
      start: l.start,
      end: l.end,
      y: l.y,
      x: l.x,
      width: l.width,
      xs: l.xs,
      hyphen: l.hyphen,
      frame: l.frame,
      cell: l.cell,
      text: l.text,
    })),
  };
}

function mutate(r, node) {
  const len = node.text.length;
  const op = r();
  const at = Math.floor(r() * (len + 1));
  if (op < 0.45)
    return insertText(node, at, pick(r, ['x', ' ', 'word ', '\n', 'internationalization ']));
  if (op < 0.65 && len > 2)
    return deleteRange(node, Math.min(at, len - 1), Math.min(len, at + 1 + Math.floor(r() * 12)));
  if (op < 0.8 && len > 2) {
    const a = Math.min(at, len - 1);
    const b = Math.min(len, a + 1 + Math.floor(r() * 30));
    const patch = pick(r, [
      { fontSize: 14 },
      { tracking: 40 },
      { kerning: -20 },
      { noBreak: true },
      { language: 'fi-FI' },
      { fill: { type: 'solid', color: '#c00' } },
      { horizontalScale: 120 },
    ]);
    return setCharStyle(node, a, b, patch);
  }
  if (op < 0.9) {
    const paras = node.text.split('\n').map(() => null);
    paras[Math.floor(r() * paras.length)] = randomPara(r);
    return { ...node, paras };
  }
  if (op < 0.95) return { ...node, width: 150 + Math.floor(r() * 250) };
  return { ...node, para: { ...node.para, ...randomPara(r) } };
}

afterEach(() => {
  setComposeCache(true);
  textHooks.story = null;
  textHooks.wraps = null;
});

describe('every-line composer cache', () => {
  it('lays out exactly as without the cache over random edits, styles and frame shapes', () => {
    const shapes = [null, TRI, CIRCLE];
    for (let seed = 1; seed <= 12; seed++) {
      const r = rng(seed);
      const shape = shapes[seed % 3];
      let node = createText(story(r, 6 + Math.floor(r() * 6)), 0, 0, {
        kind: 'area',
        width: 260,
        height: 900,
        char: { ...CHAR },
        para: randomPara(r),
      });
      if (shape) node = { ...node, areaPath: shape, height: 400 };
      if (seed % 4 === 0) {
        const square = [
          { x: 60, y: 60 },
          { x: 140, y: 60 },
          { x: 140, y: 160 },
          { x: 60, y: 160 },
        ];
        textHooks.wraps = () => ({
          deps: [square],
          list: [{ polys: [square], offset: 4, invert: false }],
        });
      } else textHooks.wraps = null;
      setComposeCache(true);
      const versions = [];
      for (let step = 0; step < 40; step++) {
        node = mutate(r, node);
        versions.push({ node, lay: snapshot(layoutText(node)) });
      }
      setComposeCache(false);
      invalidateTextLayout();
      for (const [i, v] of versions.entries())
        expect(snapshot(layoutText(v.node)), `seed ${seed} step ${i}`).toEqual(v.lay);
    }
  });

  it('lays out threaded stories exactly as without the cache', () => {
    for (let seed = 20; seed < 26; seed++) {
      const r = rng(seed);
      let head = createText(story(r, 10), 0, 0, {
        kind: 'area',
        width: 200,
        height: 160,
        char: { ...CHAR },
        para: randomPara(r),
      });
      let second = createText('', 0, 300, {
        kind: 'area',
        width: 120,
        height: 300,
        char: { ...CHAR },
      });
      second = { ...second, areaPath: TRI };
      const third = createText('', 300, 0, {
        kind: 'area',
        width: 240,
        height: 200,
        char: { ...CHAR },
      });
      let frames = [head, second, third];
      textHooks.story = (node) =>
        frames.some((f) => f.id === node.id)
          ? frames.map((f) => (f.id === node.id ? node : f))
          : null;
      setComposeCache(true);
      const versions = [];
      for (let step = 0; step < 30; step++) {
        head = mutate(r, head);
        if (step % 7 === 3) second = { ...second, width: 100 + Math.floor(r() * 100) };
        frames = [head, second, third];
        versions.push({
          frames,
          lays: frames.map((f) => snapshot(layoutText(f))),
          edit: snapshot(editLayout(head)),
        });
      }
      setComposeCache(false);
      invalidateTextLayout();
      for (const [i, v] of versions.entries()) {
        frames = v.frames;
        expect(
          frames.map((f) => snapshot(layoutText(f))),
          `seed ${seed} step ${i}`,
        ).toEqual(v.lays);
        expect(snapshot(editLayout(frames[0]))).toEqual(v.edit);
      }
    }
  });

  it('reuses unchanged paragraphs and recomposes the edited one', () => {
    const r = rng(7);
    const node = createText(story(r, 30), 0, 0, {
      kind: 'area',
      width: 260,
      height: 5000,
      char: { ...CHAR },
      para: { align: 'justify', composer: 'every', hyphenate: true },
    });
    setComposeCache(true);
    const before = layoutText(node);
    const at = node.text.indexOf('\n', node.text.length >> 1);
    const edited = insertText(node, at, ' extra words');
    const after = layoutText(edited);
    // Lines of paragraphs other than the edited one are the same, shifted by the edit.
    const pi = before.lines.find((l) => l.end > at).para;
    const keep = (lay, shift) =>
      lay.lines
        .filter((l) => l.para !== pi)
        .map((l) => [
          l.start - (l.start > at ? shift : 0),
          l.end - (l.end > at ? shift : 0),
          l.hyphen,
        ]);
    expect(keep(after, ' extra words'.length).slice(0, 10)).toEqual(keep(before, 0).slice(0, 10));
  });
});
