import { describe, it, expect, beforeEach } from 'vitest';
import { RETOUCH_LOOKS, applyLook, lookMatches, lookFromClip, normalizeLook, hasRetouch, lookValues } from '../src/model/retouch-looks.js';
import { normalizeRetouch, normalizeMakeup, MAKEUP_PARTS } from '../src/model/retouch.js';
import { userLooks, saveLook, renameLook, removeLook, onLooksChanged, MAX_LOOKS } from '../src/ui/retouch-looks.js';
import { setPref, prefs } from '../src/ui/prefs.js';

const look = (id) => RETOUCH_LOOKS.find((l) => l.id === id);

describe('built-in looks', () => {
  it('have original names, hints and only values the model keeps', () => {
    expect(RETOUCH_LOOKS.map((l) => l.label)).toEqual(['Natural', 'Fresh', 'Soft glam', 'Sculpted', 'Athletic', 'Evening']);
    for (const l of RETOUCH_LOOKS) {
      expect(l.hint.length).toBeGreaterThan(5);
      expect(l.accent).toMatch(/^#[0-9a-f]{6}$/);
      // Cleaning a look's values changes nothing but filling in defaults.
      const clean = lookValues(l.values);
      expect(Object.keys(clean).sort()).toEqual(Object.keys(l.values).sort());
      if (l.values.makeup) expect(clean.makeup).toEqual(normalizeMakeup(l.values.makeup));
      if (l.values.retouch) expect(clean.retouch).toEqual(normalizeRetouch(l.values.retouch));
      for (const [k, v] of Object.entries(l.values.makeup || {})) {
        if (k.endsWith('Color')) expect(v).toMatch(/^#[0-9a-f]{6}$/);
        else expect(MAKEUP_PARTS.some((p) => p.key === k)).toBe(true);
      }
    }
  });
});

describe('applying looks', () => {
  it('sets several parts at once and replaces, not stacks, the previous look', () => {
    const clip = { type: 'video' };
    applyLook(clip, look('athletic'));
    expect(clip.bodyShape).toMatchObject({ shoulders: 35, waist: 30, people: 'all' });
    expect(clip.retouch).toMatchObject({ smooth: 15, sharpen: 25 });
    expect(clip.makeup).toMatchObject({ contour: 20 });
    applyLook(clip, look('soft-glam'));
    expect(clip.bodyShape).toBeUndefined();
    expect(clip.retouch).toMatchObject({ smooth: 55, sharpen: 0, lips: 55, lipColor: '#a3616f' });
    expect(clip.faceShape).toMatchObject({ slim: 10, eyes: 10, faces: 'all' });
    expect(clip.makeup.eyeshadow).toBe(40);
  });

  it('keeps which faces and people the clip works on, and its hair color', () => {
    const clip = { faceShape: { slim: 40, eyes: 0, nose: 0, smile: 0, chin: 0, faces: 'largest' }, bodyShape: { slim: 0, waist: 0, legs: 0, head: 0, shoulders: 0, arms: 0, people: 'largest' }, hairColor: { color: '#112233', strength: 60 } };
    applyLook(clip, look('athletic'));
    expect(clip.bodyShape.people).toBe('largest');
    expect(clip.faceShape).toEqual({ slim: 0, eyes: 0, nose: 0, smile: 0, chin: 0, faces: 'largest' });
    expect(clip.hairColor).toEqual({ color: '#112233', strength: 60 });
    applyLook(clip, null);
    expect(clip.retouch).toBeUndefined();
    expect(clip.makeup).toBeUndefined();
    expect(clip.bodyShape.people).toBe('largest');
    expect(clip.hairColor.strength).toBe(60);
    expect(hasRetouch(clip)).toBe(false);
  });

  it('knows which look a clip shows', () => {
    const clip = {};
    expect(lookMatches(clip, look('natural'))).toBe(false);
    applyLook(clip, look('natural'));
    expect(lookMatches(clip, look('natural'))).toBe(true);
    expect(lookMatches(clip, look('fresh'))).toBe(false);
    clip.retouch.smooth += 1;
    expect(lookMatches(clip, look('natural'))).toBe(false);
    clip.retouch.smooth -= 1;
    // A zeroed part counts as absent.
    clip.bodyShape = { slim: 0, waist: 0, legs: 0, head: 0, shoulders: 0, arms: 0, people: 'all' };
    expect(lookMatches(clip, look('natural'))).toBe(true);
  });

  it('round-trips a clip through a saved look, hair included', () => {
    const src = {};
    applyLook(src, look('evening'));
    src.bodyShape = { slim: 20, waist: 0, legs: 10, head: 0, shoulders: 0, arms: 0, people: 'largest' };
    src.hairColor = { color: '#6a4aa8', strength: 70 };
    const values = lookFromClip(src);
    expect(values.bodyShape.people).toBeUndefined();
    const saved = normalizeLook({ id: 'lk1', name: 'Night out', values });
    const dst = { hairColor: { color: '#000000', strength: 10 } };
    applyLook(dst, saved);
    expect(dst.makeup).toEqual(src.makeup);
    expect(dst.retouch).toEqual(src.retouch);
    expect(dst.bodyShape).toEqual({ ...src.bodyShape, people: 'all' });
    expect(dst.hairColor).toEqual(src.hairColor);
    expect(lookMatches(dst, saved)).toBe(true);
    expect(normalizeLook({ id: 'x', name: 'Empty', values: { retouch: { smooth: 0 } } })).toBeNull();
    expect(normalizeLook(null)).toBeNull();
    expect(normalizeLook({ id: 'y', values: { makeup: { blush: 10 } } }).name).toBe('My look');
  });
});

describe('your looks', () => {
  beforeEach(() => setPref('retouchLooks', []));

  it('saves, lists, renames and removes looks in preferences', () => {
    let changes = 0;
    const off = onLooksChanged(() => changes++);
    const clip = {};
    applyLook(clip, look('fresh'));
    expect(saveLook('Morning', {})).toBeNull();
    const a = saveLook('  Morning  ', clip);
    expect(a.name).toBe('Morning');
    const b = saveLook('', clip);
    expect(b.name).toBe('My look');
    expect(userLooks().map((l) => l.name)).toEqual(['My look', 'Morning']);
    renameLook(a.id, 'Daylight');
    expect(userLooks().find((l) => l.id === a.id).name).toBe('Daylight');
    removeLook(b.id);
    expect(userLooks().map((l) => l.id)).toEqual([a.id]);
    expect(changes).toBe(4);
    off();
    // Junk in preferences is skipped.
    setPref('retouchLooks', [null, { id: 'z', name: 'Bad', values: {} }, ...prefs().retouchLooks]);
    expect(userLooks().map((l) => l.name)).toEqual(['Daylight']);
    for (let i = 0; i < MAX_LOOKS + 5; i++) saveLook(`L${i}`, clip);
    expect(prefs().retouchLooks.length).toBe(MAX_LOOKS);
  });
});
