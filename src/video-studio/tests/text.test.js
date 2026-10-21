import { describe, it, expect, vi } from 'vitest';
import { normalizeClip, normalizeProject, makeClip, createProject, DEFAULT_TEXT_STYLE } from '../src/model/project.js';
import { normTextExtras, caseOf, applyCase, COLOR_KEYS, textColorAt, hexToRgb, rgbToHex, DECOR_KEYS } from '../src/model/text-style.js';
import { TEXT_PRESETS, TEXT_EFFECTS, applyTextEffect, findTextLook } from '../src/model/text-presets.js';
import { ANIMATIONS } from '../src/model/catalog.js';
import { BUBBLES, bubbleGeometry, drawBubble, hasBubble, shade } from '../src/engine/bubbles.js';
import { wrapLines, lineGlyphs, indexGlyphs, arcLayout, placedBounds, MAX_ARC } from '../src/engine/text-layout.js';
import { TEXT_ANIMS, stagger, glyphState, activeWord, animKey, scrambleChar, hash01, isGlyphAnim, animMargin } from '../src/engine/text-anim.js';
import { applyAnimations, clipLayer } from '../src/engine/scene.js';
import { TextCache } from '../src/engine/text.js';
import { mockContext } from './canvas-mock.js';
import { s } from './helpers.js';

const textClip = (fields = {}) => makeClip('text', { start: 0, duration: s(4), text: 'Hello big world', ...fields });

describe('text style normalization', () => {
  it('migrates the old uppercase switch to case', () => {
    const c = normalizeClip({ type: 'text', text: 'Hi', style: { uppercase: true, color: '#ABCDEF' } });
    expect(c.style.case).toBe('upper');
    expect('uppercase' in c.style).toBe(false);
    expect(c.style.color).toBe('#abcdef');
    expect(normalizeClip({ type: 'text', style: { uppercase: false } }).style.case).toBe('none');
    // An explicit case wins over the old switch.
    expect(normalizeClip({ type: 'text', style: { uppercase: true, case: 'title' } }).style.case).toBe('title');
  });

  it('fills every new field with a neutral default for old clips', () => {
    const c = normalizeClip({ type: 'text', text: 'Old', style: { font: 'Anton', size: 80 } });
    for (const [k, v] of Object.entries(normTextExtras({}))) expect(c.style[k]).toEqual(v);
    expect(c.style).toEqual({ ...DEFAULT_TEXT_STYLE, font: 'Anton', size: 80 });
  });

  it('clamps and cleans untrusted values', () => {
    const st = normTextExtras({ fillType: 'plaid', arc: 500, grad3: 'red', vAlign: 'sideways', boxWidth: -5, glowStrength: 1e9, bubble: '<b>x</b>', case: 'SHOUT', fillOpacity: 3 });
    expect(st).toMatchObject({ fillType: 'solid', arc: 100, grad3: '', vAlign: 'middle', boxWidth: 0, glowStrength: 100, bubble: 'bxb', case: 'none', fillOpacity: 1 });
  });

  it('is idempotent', () => {
    const once = normalizeClip({ type: 'text', style: { uppercase: true, fillType: 'linear', grad3: '#123456', arc: -20, bubble: 'pill' } });
    expect(normalizeClip(once).style).toEqual(once.style);
  });

  it('keeps uploaded fonts on projects and drops bad entries', () => {
    const p = createProject();
    expect(normalizeProject(p).fonts).toBeUndefined();
    const raw = { ...p, fonts: [{ family: 'My Font abc123', name: 'My Font', hash: 'abc123', ext: 'WOFF2', size: 10 }, { family: '', hash: 'x' }, null, { family: 'My Font abc123', hash: 'dup' }] };
    const n = normalizeProject(raw);
    expect(n.fonts).toHaveLength(1);
    expect(n.fonts[0]).toMatchObject({ family: 'My Font abc123', name: 'My Font', hash: 'abc123', ext: 'woff2' });
  });

  it('applies case changes', () => {
    expect(applyCase('hello wORLD-wide "quote"', 'title')).toBe('Hello World-Wide "Quote"');
    expect(applyCase('MiXed', 'lower')).toBe('mixed');
    expect(applyCase('MiXed', 'upper')).toBe('MIXED');
    expect(applyCase('MiXed', 'none')).toBe('MiXed');
    expect(caseOf({ case: 'none', uppercase: true })).toBe('upper');
  });

  it('interpolates keyed text color channel by channel', () => {
    const c = textClip();
    expect(textColorAt(c, 0)).toBe(null);
    c.keyframes[COLOR_KEYS[0]] = [{ t: 0, v: 255, ease: 'linear' }, { t: s(2), v: 0, ease: 'linear' }];
    c.keyframes[COLOR_KEYS[1]] = [{ t: 0, v: 0, ease: 'linear' }, { t: s(2), v: 0, ease: 'linear' }];
    c.keyframes[COLOR_KEYS[2]] = [{ t: 0, v: 0, ease: 'linear' }, { t: s(2), v: 255, ease: 'linear' }];
    expect(textColorAt(c, 0)).toBe('#ff0000');
    expect(textColorAt(c, s(1))).toBe('#800080');
    expect(textColorAt(c, s(3))).toBe('#0000ff');
    expect(clipLayer(null, c, s(1), 0).textColor).toBe('#800080');
    expect(rgbToHex(...hexToRgb('#12ab9f'))).toBe('#12ab9f');
  });
});

describe('text presets and effects', () => {
  it('has about thirty unique presets including the original ones', () => {
    expect(TEXT_PRESETS.length).toBeGreaterThanOrEqual(30);
    expect(new Set(TEXT_PRESETS.map((p) => p.id)).size).toBe(TEXT_PRESETS.length);
    for (const id of ['plain', 'title-bold', 'outline', 'subtitle', 'yellow-caption', 'neon', 'serif', 'label', 'marker', 'script', 'mono', 'lower-third']) {
      expect(TEXT_PRESETS.some((p) => p.id === id)).toBe(true);
    }
  });

  it('has unique effects whose values survive normalization', () => {
    expect(TEXT_EFFECTS.length).toBeGreaterThanOrEqual(24);
    expect(new Set(TEXT_EFFECTS.map((e) => e.id)).size).toBe(TEXT_EFFECTS.length);
    for (const fx of [...TEXT_EFFECTS, ...TEXT_PRESETS]) {
      const n = normalizeClip({ type: 'text', text: 'x', style: { ...DEFAULT_TEXT_STYLE, ...fx.style } });
      expect(n.style).toMatchObject(fx.style);
    }
  });

  it('replaces the previous decorations and keeps layout', () => {
    const glitch = TEXT_EFFECTS.find((e) => e.id === 'glitch');
    const gold = TEXT_EFFECTS.find((e) => e.id === 'gold');
    const base = { ...DEFAULT_TEXT_STYLE, size: 140, boxWidth: 900, align: 'left', letterSpacing: 3 };
    const a = applyTextEffect(base, glitch);
    expect(a).toMatchObject({ glitch: 5, effect: 'glitch', size: 140, boxWidth: 900, align: 'left' });
    const b = applyTextEffect(a, gold);
    expect(b).toMatchObject({ glitch: 0, fillType: 'linear', effect: 'gold', size: 140, letterSpacing: 3 });
    const none = applyTextEffect(b, null);
    for (const k of DECOR_KEYS) expect(none[k]).toEqual(DEFAULT_TEXT_STYLE[k]);
    expect(none.effect).toBe('');
  });

  it('finds presets and effects as looks', () => {
    expect(findTextLook('neon')).toMatchObject({ kind: 'preset', label: 'Neon' });
    expect(findTextLook('chrome')).toMatchObject({ kind: 'effect', style: { effect: 'chrome', size: 110 } });
    expect(findTextLook('nope')).toBe(null);
  });
});

/** A 2D context stand-in that records every coordinate a path touches. */
function recorder() {
  const pts = [];
  const add = (x, y) => pts.push([x, y]);
  const ctx = {
    pts,
    moveTo: add,
    lineTo: add,
    quadraticCurveTo: (cx, cy, x, y) => {
      add(cx, cy);
      add(x, y);
    },
    bezierCurveTo: (a, b, c, d, x, y) => {
      add(a, b);
      add(c, d);
      add(x, y);
    },
    arc: (x, y, r, a0 = 0, a1 = Math.PI * 2, ccw = false) => {
      // Sample the swept part of the circle only.
      let sweep = ccw ? a0 - a1 : a1 - a0;
      if (sweep < 0) sweep += Math.PI * 2;
      if (sweep === 0) sweep = Math.PI * 2;
      for (let i = 0; i <= 32; i++) {
        const a = a0 + (ccw ? -1 : 1) * (sweep * i) / 32;
        add(x + Math.cos(a) * r, y + Math.sin(a) * r);
      }
    },
    ellipse: (x, y, rx, ry) => {
      add(x - rx, y - ry);
      add(x + rx, y + ry);
    },
    fillRect: (x, y, w, hh) => {
      add(x, y);
      add(x + w, y + hh);
    },
    rect: (x, y, w, hh) => {
      add(x, y);
      add(x + w, y + hh);
    },
    translate(x, y) {
      this.tx = x;
      this.ty = y;
    },
    beginPath() {},
    closePath() {},
    fill() {},
    stroke() {},
    save() {},
    restore() {},
    rotate() {},
    setLineDash() {},
  };
  return ctx;
}

describe('bubbles', () => {
  it('has about twenty unique original shapes', () => {
    expect(BUBBLES.length).toBeGreaterThanOrEqual(20);
    expect(new Set(BUBBLES.map((b) => b.id)).size).toBe(BUBBLES.length);
    expect(hasBubble('speech')).toBe(true);
    expect(hasBubble('')).toBe(false);
    expect(hasBubble('constructor')).toBe(false);
  });

  it('pads the text and reaches past it on every side', () => {
    for (const b of BUBBLES) {
      const g = bubbleGeometry(b.id, 300, 80, 64, 4);
      expect(g.body.x).toBeLessThan(0);
      expect(g.body.y).toBeLessThan(0);
      expect(g.body.w).toBeGreaterThan(300);
      expect(g.body.h).toBeGreaterThan(80);
      for (const v of Object.values(g.reach)) {
        expect(Number.isFinite(v)).toBe(true);
        expect(v).toBeGreaterThan(0);
      }
    }
  });

  it('grows with the text box', () => {
    for (const b of BUBBLES) {
      const small = bubbleGeometry(b.id, 100, 60, 64);
      const big = bubbleGeometry(b.id, 600, 200, 64);
      expect(big.body.w).toBeGreaterThan(small.body.w);
      expect(big.body.h).toBeGreaterThan(small.body.h);
    }
  });

  it('draws inside the room it declares', () => {
    for (const b of BUBBLES) {
      for (const [w, hh] of [[300, 80], [60, 60], [900, 300]]) {
        const ctx = recorder();
        const rect = { x: 500, y: 400, w, h: hh };
        drawBubble(ctx, b.id, rect, { size: 64, fill: '#ffffff', stroke: '#000000', lineWidth: 4 });
        const g = bubbleGeometry(b.id, w, hh, 64, 4);
        expect(ctx.pts.length).toBeGreaterThan(0);
        const eps = 1;
        for (const [x, y] of ctx.pts) {
          if (ctx.tx !== undefined && b.id === 'sticky') continue; // tape is drawn in a translated frame
          expect(Number.isFinite(x) && Number.isFinite(y), b.id).toBe(true);
          if (y > rect.y + hh + g.reach.b + eps || x > rect.x + w + g.reach.r + eps || x < rect.x - g.reach.l - eps || y < rect.y - g.reach.t - eps) throw new Error(`${b.id} ${w}x${hh} draws at ${x},${y}`);
          expect(x).toBeGreaterThanOrEqual(rect.x - g.reach.l - eps);
          expect(x).toBeLessThanOrEqual(rect.x + w + g.reach.r + eps);
          expect(y).toBeGreaterThanOrEqual(rect.y - g.reach.t - eps);
          expect(y).toBeLessThanOrEqual(rect.y + hh + g.reach.b + eps);
        }
      }
    }
  });

  it('ignores unknown shapes and shades colors', () => {
    expect(() => drawBubble(recorder(), 'nope', { x: 0, y: 0, w: 10, h: 10 }, { size: 10 })).not.toThrow();
    expect(bubbleGeometry('nope', 1, 1, 1)).toBe(null);
    expect(shade('#808080', -0.5)).toBe('#404040');
    expect(shade('#000000', 1)).toBe('#ffffff');
  });
});

describe('text layout', () => {
  const measure = (str) => str.length * 10;

  it('wraps words to a box width and keeps explicit lines', () => {
    expect(wrapLines('one two three', 0, measure)).toEqual(['one two three']);
    expect(wrapLines('one two three', 75, measure)).toEqual(['one two', 'three']);
    expect(wrapLines('a\nb c', 1000, measure)).toEqual(['a', 'b c']);
    // A word wider than the box breaks between letters.
    expect(wrapLines('abcdefghij xy', 40, measure)).toEqual(['abcd', 'efgh', 'ij', 'xy']);
    for (const line of wrapLines('the quick brown fox jumps over the lazy dog', 120, measure)) expect(measure(line)).toBeLessThanOrEqual(120);
  });

  it('places glyphs by prefix width and indexes letters and words', () => {
    const g = lineGlyphs('ab c', (str) => str.length * 12, () => 10);
    expect(g.map((x) => x.x)).toEqual([0, 12, 24, 36]);
    expect(g.every((x) => x.adv === 12 && x.w === 10)).toBe(true);
    const lines = [{ glyphs: lineGlyphs('hi you', measure, () => 10) }, { glyphs: lineGlyphs('ok', measure, () => 10) }];
    const t = indexGlyphs(lines);
    expect(t).toEqual({ chars: 7, words: 3, wordLens: [2, 3, 2] });
    expect(lines[0].glyphs[2]).toMatchObject({ ci: -1, wi: -1 });
    expect(lines[1].glyphs[0]).toMatchObject({ ci: 5, wi: 2 });
  });

  const line = (n, y = 0, step = 20) => ({ y, glyphs: Array.from({ length: n }, (_, i) => ({ cx: (i - (n - 1) / 2) * step, w: 16 })) });

  it('leaves text flat without a curve', () => {
    const r = arcLayout([line(5)], 0, 100, 40);
    expect(r.radius).toBe(Infinity);
    expect(r.lines[0].map((p) => p.x)).toEqual([-40, -20, 0, 20, 40]);
    expect(r.lines[0].every((p) => p.y === 0 && p.rot === 0)).toBe(true);
  });

  it('bends lines symmetrically around a circle', () => {
    const up = arcLayout([line(5)], 50, 100, 40).lines[0];
    expect(up[2]).toMatchObject({ x: 0, y: 0, rot: 0 });
    // Ends fall away from the middle and lean outward.
    expect(up[0].y).toBeGreaterThan(0);
    expect(up[0].y).toBeCloseTo(up[4].y, 9);
    expect(up[0].x).toBeCloseTo(-up[4].x, 9);
    expect(up[4].rot).toBeGreaterThan(0);
    expect(up[0].rot).toBeCloseTo(-up[4].rot, 9);
    // Arc length is kept: points sit on the radius at their distance along the line.
    const r = arcLayout([line(5)], 50, 100, 40).radius;
    expect(r).toBeCloseTo(100 / ((50 / 100) * MAX_ARC), 9);
    expect(Math.hypot(up[4].x, up[4].y - r)).toBeCloseTo(r, 9);
    expect(up[4].rot * r).toBeCloseTo(40, 9);
    const down = arcLayout([line(5)], -50, 100, 40).lines[0];
    expect(down[0].y).toBeCloseTo(-up[0].y, 9);
    expect(down[4].rot).toBeCloseTo(-up[4].rot, 9);
  });

  it('spans half a circle at full curve and stacks lines on concentric circles', () => {
    const full = arcLayout([line(2, 0, 100)], 100, 100, 40).lines[0];
    expect(full[1].rot - full[0].rot).toBeCloseTo(Math.PI, 9);
    const two = arcLayout([line(3, 0), line(3, 40)], 40, 600, 40);
    const r = two.radius;
    const center = { x: 0, y: r };
    expect(Math.hypot(two.lines[1][0].x - center.x, two.lines[1][0].y - center.y)).toBeCloseTo(r - 40, 9);
  });

  it('measures rotated glyph bounds', () => {
    const b = placedBounds([{ x: 0, y: 0, rot: 0, hw: 10, hh: 5 }, { x: 100, y: 0, rot: Math.PI / 2, hw: 10, hh: 5 }]);
    expect(b.minX).toBeCloseTo(-10);
    expect(b.maxX).toBeCloseTo(105);
    expect(b.minY).toBeCloseTo(-10);
    expect(b.maxY).toBeCloseTo(10);
  });
});

describe('letter and word animations', () => {
  const totals = { chars: 13, words: 3, wordLens: [5, 3, 5] };
  const glyph = (ci, wi, ch = 'a') => ({ ch, ci, wi, cx: ci * 10, lineCx: 60 });

  it('are listed for text clips only, with a matching engine definition', () => {
    for (const kind of ['in', 'out', 'loop']) {
      for (const a of ANIMATIONS[kind].filter((x) => x.glyph)) {
        expect(a.textOnly).toBe(true);
        expect(isGlyphAnim(a.id)).toBe(true);
        expect(TEXT_ANIMS[a.id].phase).toBe(kind);
      }
    }
    expect(Object.keys(TEXT_ANIMS).every((id) => ANIMATIONS[TEXT_ANIMS[id].phase].some((a) => a.id === id))).toBe(true);
    expect(isGlyphAnim('fade-in')).toBe(false);
  });

  it('staggers units so they start in order and all finish', () => {
    for (const n of [1, 3, 10, 40]) {
      for (let k = 0; k < n; k++) {
        expect(stagger(0, k, n)).toBe(0);
        expect(stagger(1, k, n)).toBe(1);
        if (k) expect(stagger(0.3, k, n)).toBeLessThanOrEqual(stagger(0.3, k - 1, n));
      }
    }
  });

  it('hides letters before they rise and leaves them untouched at the end', () => {
    for (const id of Object.keys(TEXT_ANIMS).filter((x) => TEXT_ANIMS[x].phase === 'in')) {
      const end = glyphState([{ id, phase: 'in', p: 1 }], glyph(12, 2), totals, { size: 64 });
      expect(end?.alpha ?? 1).toBeCloseTo(1);
      expect(end?.dx ?? 0).toBeCloseTo(0);
      expect(end?.dy ?? 0).toBeCloseTo(0);
      expect(end?.scale ?? 1).toBeCloseTo(1);
      expect(end?.ch ?? null).toBe(null);
    }
    expect(glyphState([{ id: 'letters-rise', phase: 'in', p: 0 }], glyph(0, 0), totals).alpha).toBe(0);
    expect(glyphState([{ id: 'letters-fade-out', phase: 'out', p: 1 }], glyph(12, 2), totals).alpha).toBeCloseTo(0);
    expect(glyphState([{ id: 'letters-fade-out', phase: 'out', p: 0 }], glyph(12, 2), totals).alpha).toBeCloseTo(1);
  });

  it('is deterministic', () => {
    for (const id of Object.keys(TEXT_ANIMS)) {
      const en = [{ id, phase: TEXT_ANIMS[id].phase, p: 0.37 }];
      expect(glyphState(en, glyph(4, 1, 'q'), totals, { size: 50 })).toEqual(glyphState(en, glyph(4, 1, 'q'), totals, { size: 50 }));
    }
    expect(scrambleChar('a', 3, 5)).toBe(scrambleChar('a', 3, 5));
    expect(scrambleChar('a', 3, 5)).toMatch(/[a-z0-9#%&*+<>?]/);
    expect(hash01(1, 2)).toBe(hash01(1, 2));
    expect(hash01(1, 2)).not.toBe(hash01(2, 1));
  });

  it('highlights sung words over the clip (karaoke)', () => {
    expect(activeWord(0, [5, 3, 5])).toBe(0);
    expect(activeWord(0.5, [5, 3, 5])).toBe(1);
    expect(activeWord(1, [5, 3, 5])).toBe(2);
    const at = (p, wi) => glyphState([{ id: 'karaoke', phase: 'loop', p }], glyph(0, wi), totals, { highlight: '#ff0000' })?.color ?? null;
    expect(at(0.1, 0)).toBe('#ff0000');
    expect(at(0.1, 2)).toBe(null);
    expect(at(0.95, 2)).toBe('#ff0000');
    expect(animKey([{ id: 'karaoke', phase: 'loop', p: 0.1 }], totals)).toBe(animKey([{ id: 'karaoke', phase: 'loop', p: 0.2 }], totals));
    expect(animKey([{ id: 'karaoke', phase: 'loop', p: 0.1 }], totals)).not.toBe(animKey([{ id: 'karaoke', phase: 'loop', p: 0.9 }], totals));
    expect(animKey([{ id: 'letters-rise', phase: 'in', p: 1 }], totals)).toBe('letters-rise:end');
  });

  it('come from the clip animations in scene evaluation', () => {
    const c = textClip({ animIn: { id: 'letters-rise', duration: s(1) }, animOut: { id: 'word-shrink', duration: s(1) } });
    const st = (local) => applyAnimations(c, local, { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1, blur: 0, reveal: 1 });
    expect(st(s(0.5)).textAnim).toEqual([{ id: 'letters-rise', phase: 'in', p: 0.5 }]);
    expect(st(s(0.5))).toMatchObject({ x: 0, y: 0, scale: 1, opacity: 1 });
    expect(st(s(2)).textAnim).toBeUndefined();
    expect(st(s(3.5)).textAnim).toEqual([{ id: 'word-shrink', phase: 'out', p: 0.5 }]);
    const k = textClip({ animLoop: { id: 'karaoke', duration: s(1) } });
    const l = clipLayer(null, k, s(3), 0);
    expect(l.textAnim).toEqual([{ id: 'karaoke', phase: 'loop', p: 0.75 }]);
    expect(clipLayer(null, textClip(), s(1), 0).textAnim).toBe(null);
    expect(animMargin([{ id: 'letters-drop' }])).toBeGreaterThan(animMargin([{ id: 'wave' }]));
  });
});

describe('text raster cache', () => {
  it('drops rasters of clips that are no longer drawn', () => {
    const spy = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => mockContext());
    try {
      const cache = new TextCache();
      const clips = Array.from({ length: 30 }, (_, i) => makeClip('text', { text: `Caption ${i}`, start: s(i), duration: s(1) }));
      const layer = (clip) => ({ kind: 'text', clip, scale: 1, reveal: 1 });
      // Play through every caption, then keep showing only the last one.
      for (const c of clips) {
        cache.get(layer(c), 0.5);
        cache.sweep();
      }
      expect(cache.entries.size).toBe(30);
      const last = clips.at(-1);
      for (let i = 0; i < 400; i++) {
        cache.get(layer(last), 0.5);
        cache.sweep();
      }
      expect([...cache.entries.keys()]).toEqual([last.id]);
    } finally {
      spy.mockRestore();
    }
  });

  it('never repeats a version for a raster made again after it was dropped', () => {
    const spy = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => mockContext());
    try {
      const cache = new TextCache();
      const title = makeClip('text', { text: 'Title', start: 0, duration: s(1) });
      const layer = (clip) => ({ kind: 'text', clip, scale: 1, reveal: 1 });
      const first = cache.get(layer(title), 0.5).version;
      cache.drop(title.id);
      // Changed while it was off screen: the compositor must see a new version, not the old one again.
      title.style = { ...title.style, color: '#00ff00' };
      expect(cache.get(layer(title), 0.5).version).not.toBe(first);
    } finally {
      spy.mockRestore();
    }
  });
});
