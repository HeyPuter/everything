import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as S from '../src/engine/shaders.js';
import {
  EFFECTS, EFFECT_CATEGORIES, TRANSITIONS, TRANSITION_CATEGORIES, FILTERS, FILTER_CATEGORIES,
} from '../src/model/catalog.js';
import {
  EFFECT_PARAMS, effectParamDefs, effectDefaults, normalizeEffectParams, carryEffectParams, effectIsOff, effectUniforms, clampEffectParam,
} from '../src/model/effect-params.js';
import {
  MAX_CLIP_EFFECTS, canHaveEffects, normalizeClipEffects, addClipEffect, removeClipEffect, moveClipEffect, setClipEffectOn, setClipEffectParam, activeClipEffects,
} from '../src/model/clip-effects.js';
import { HSL_RANGES, CURVE_CHANNELS } from '../src/model/color.js';
import { normalizeClip, normalizeProject, makeClip, DEFAULT_ADJUST } from '../src/model/project.js';
import { splitClip, duplicateClip, findClip, addClip } from '../src/model/timeline.js';
import { sliceProject } from '../src/model/slice.js';
import { evaluate } from '../src/engine/scene.js';
import { gradeParams } from '../src/engine/compositor.js';
import { captureAttributes, applyAttributes } from '../src/ui/organize-actions.js';
import { EditorStore } from '../src/model/store.js';
import { createActions } from '../src/ui/actions.js';
import { createInspector } from '../src/ui/inspector/index.js';
import { matchesLook, lookPreview } from '../src/ui/panels/previews.js';
import { fixture, clip, onMain, s } from './helpers.js';

const ids = (list) => list.map((x) => x.id);
const dupes = (list) => list.filter((x, i) => list.indexOf(x) !== i);

describe('look catalog', () => {
  it('has the expanded counts with unique ids', () => {
    expect(EFFECTS.length).toBeGreaterThanOrEqual(65);
    expect(TRANSITIONS.length).toBeGreaterThanOrEqual(48);
    expect(FILTERS.length).toBeGreaterThanOrEqual(47);
    for (const list of [EFFECTS, TRANSITIONS, FILTERS, EFFECT_CATEGORIES, TRANSITION_CATEGORIES, FILTER_CATEGORIES]) expect(dupes(ids(list))).toEqual([]);
  });

  it('puts every look in a known category and leaves no category empty', () => {
    for (const [list, cats] of [[EFFECTS, EFFECT_CATEGORIES], [TRANSITIONS, TRANSITION_CATEGORIES], [FILTERS, FILTER_CATEGORIES]]) {
      const known = new Set(ids(cats));
      for (const x of list) expect(known.has(x.cat), `${x.id} in ${x.cat}`).toBe(true);
      for (const c of cats) expect(list.some((x) => x.cat === c.id), `category ${c.id}`).toBe(true);
      for (const x of list) expect(x.label.trim().length, x.id).toBeGreaterThan(0);
    }
  });

  it('defines parameters with sane ranges and defaults for every effect, and nothing else', () => {
    expect(Object.keys(EFFECT_PARAMS).sort()).toEqual(ids(EFFECTS).sort());
    for (const e of EFFECTS) {
      const defs = effectParamDefs(e.id);
      expect(defs.length, e.id).toBeGreaterThanOrEqual(1);
      expect(defs.length, e.id).toBeLessThanOrEqual(5);
      expect(dupes(defs.map((d) => d.key)), e.id).toEqual([]);
      for (const d of defs) {
        expect(d.label, `${e.id}.${d.key}`).toBeTruthy();
        expect(/^[a-z]+$/i.test(d.key), d.key).toBe(true);
        if (d.type === 'color') expect(d.def).toMatch(/^#[0-9a-f]{6}$/);
        else {
          expect(d.min).toBeLessThan(d.max);
          expect(d.def).toBeGreaterThanOrEqual(d.min);
          expect(d.def).toBeLessThanOrEqual(d.max);
        }
      }
      expect(defs.filter((d) => d.zeroOff).length, e.id).toBeLessThanOrEqual(1);
    }
  });

  it("uses every effect parameter in that effect's shader", () => {
    for (const e of EFFECTS) {
      const src = S.effectShader(e.id).replace(/\/\/[^\n]*/g, '');
      const body = S.EFFECT_SHADERS[e.id];
      for (const d of effectParamDefs(e.id)) {
        const used = d.key === 'speed' ? /\bu_speed\b|\brate\(\)/.test(body) : new RegExp(`\\bu_${d.key}\\b`).test(body);
        expect(used, `${e.id} uses ${d.key}`).toBe(true);
        // Effect-specific params declare their own uniform with the right type.
        if (!['speed', 'strength'].includes(d.key)) expect(src).toMatch(new RegExp(`uniform ${d.type === 'color' ? 'vec3' : 'float'}[^;]*\\bu_${d.key}\\b`));
      }
    }
  });

  it('gives every new transition its own shader with easing', () => {
    for (const t of TRANSITIONS) expect(S.TRANSITION_SHADERS[t.id], t.id).toBeTruthy();
    for (const id of ['cube', 'card-flip', 'page-turn', 'bounce-push', 'whip-pan']) expect(S.transitionShader(id)).toMatch(/ease|backInOut|easeIn/);
  });

  it('builds filters from grade values plus valid HSL and curve tables', () => {
    const known = new Set([...Object.keys(DEFAULT_ADJUST), 'mono', 'shadowTint', 'highlightTint', 'splitAmount']);
    const ranges = new Set(HSL_RANGES.map((r) => r.id));
    const channels = new Set(CURVE_CHANNELS.map((c) => c.id));
    for (const f of FILTERS) {
      for (const k of Object.keys(f.p)) expect(known.has(k), `${f.id}.${k}`).toBe(true);
      for (const [r, v] of Object.entries(f.hsl || {})) {
        expect(ranges.has(r), `${f.id} hsl ${r}`).toBe(true);
        for (const x of Object.values(v)) expect(Math.abs(x)).toBeLessThanOrEqual(100);
      }
      for (const [ch, pts] of Object.entries(f.curves || {})) {
        expect(channels.has(ch), `${f.id} curve ${ch}`).toBe(true);
        expect(pts.length).toBeGreaterThanOrEqual(2);
        pts.forEach(([x, y], i) => {
          expect(x >= 0 && x <= 1 && y >= 0 && y <= 1).toBe(true);
          if (i) expect(x).toBeGreaterThan(pts[i - 1][0]);
        });
      }
    }
  });
});

describe('look panels', () => {
  it('search by label or category name', () => {
    const snow = EFFECTS.find((e) => e.id === 'snow');
    expect(matchesLook(snow, '', EFFECT_CATEGORIES)).toBe(true);
    expect(matchesLook(snow, 'snowf', EFFECT_CATEGORIES)).toBe(true);
    expect(matchesLook(snow, 'weather', EFFECT_CATEGORIES)).toBe(true);
    expect(matchesLook(snow, 'glitch', EFFECT_CATEGORIES)).toBe(false);
    const hits = TRANSITIONS.filter((t) => matchesLook(t, '3d', TRANSITION_CATEGORIES)).map((t) => t.id);
    expect(hits).toEqual(expect.arrayContaining(['cube', 'card-flip', 'page-turn', 'swing-door']));
  });

  it('returns a canvas even without a drawing context', () => {
    const c = lookPreview('effect', 'snow');
    expect(c.tagName).toBe('CANVAS');
    expect(c.getAttribute('aria-hidden')).toBe('true');
  });
});

describe('effect parameters', () => {
  it('normalizes values against the effect definitions', () => {
    expect(normalizeEffectParams('duotone', { strength: 300, dark: '#ABCDEF', light: 'red', junk: 4 })).toEqual({ strength: 100, dark: '#abcdef', light: '#ff8a5c' });
    expect(normalizeEffectParams('rain', { angle: -90 })).toMatchObject({ angle: -45 });
    expect(normalizeEffectParams('snow', null)).toEqual(effectDefaults('snow'));
    expect(clampEffectParam('bloom', 'threshold', 150)).toBe(100);
    expect(clampEffectParam('bloom', 'nope', 1)).toBeUndefined();
  });

  it('keeps old speed and strength values where an effect uses them', () => {
    const old = { speed: 20, strength: 85 };
    expect(normalizeEffectParams('shake', old)).toEqual({ speed: 20, strength: 85 });
    expect(normalizeEffectParams('blur', old)).toEqual({ strength: 85 });
    // Ids this version does not know keep the legacy pair.
    expect(normalizeEffectParams('from-the-future', old)).toEqual(old);
  });

  it('carries shared values when switching effects', () => {
    expect(carryEffectParams('bloom', { strength: 33, speed: 70 })).toEqual({ strength: 33, threshold: 55 });
  });

  it('reports effects dialed to zero as off', () => {
    expect(effectIsOff('bloom', { strength: 0 })).toBe(true);
    expect(effectIsOff('bloom', { strength: 1 })).toBe(false);
    expect(effectIsOff('bloom', {})).toBe(false);
    // Effects whose strength 0 still does something are never skipped.
    expect(effectIsOff('black-white', { strength: 0 })).toBe(false);
    expect(effectIsOff('dither', {})).toBe(false);
  });

  it('turns params into shader uniforms', () => {
    const u = Object.fromEntries(effectUniforms('hearts', { strength: 50, speed: 20, color: '#ff0000' }));
    expect(u).toEqual({ u_strength: 0.5, u_speed: 0.2, u_color: [1, 0, 0] });
    expect(Object.fromEntries(effectUniforms('color-pop', { hue: 120 })).u_hue).toBe(120);
  });
});

describe('clip effect stacks', () => {
  it('adds up to the limit, reorders, toggles and removes', () => {
    const c = makeClip('video', { assetId: 'vid' });
    expect(canHaveEffects(c)).toBe(true);
    expect(canHaveEffects(makeClip('audio'))).toBe(false);
    expect(addClipEffect(c, 'no-such')).toBe(-1);
    for (const id of ['bloom', 'snow', 'crt', 'hearts', 'twirl']) addClipEffect(c, id);
    expect(addClipEffect(c, 'fog')).toBe(-1);
    expect(c.effects).toHaveLength(MAX_CLIP_EFFECTS);
    expect(c.effects[0]).toEqual({ id: 'bloom', params: effectDefaults('bloom') });
    expect(moveClipEffect(c, 0, 2)).toBe(true);
    expect(ids(c.effects)).toEqual(['snow', 'crt', 'bloom', 'hearts', 'twirl']);
    setClipEffectOn(c, 1, false);
    expect(c.effects[1].off).toBe(true);
    expect(setClipEffectParam(c, 0, 'strength', 500)).toBe(true);
    expect(c.effects[0].params.strength).toBe(100);
    expect(setClipEffectParam(c, 0, 'bogus', 1)).toBe(false);
    for (let i = 0; i < 5; i++) removeClipEffect(c, 0);
    expect('effects' in c).toBe(false);
  });

  it('renders only effects that are on, known and not at zero', () => {
    const c = makeClip('image', { assetId: 'img' });
    c.effects = [{ id: 'bloom', params: { strength: 0, threshold: 50 } }, { id: 'snow', params: effectDefaults('snow'), off: true }, { id: 'gone', params: {} }, { id: 'crt', params: effectDefaults('crt') }];
    expect(ids(activeClipEffects(c))).toEqual(['crt']);
  });

  it('normalizes untrusted stacks', () => {
    expect(normalizeClipEffects(null)).toBe(null);
    expect(normalizeClipEffects([])).toBe(null);
    const out = normalizeClipEffects([{ id: 'snow', params: { strength: 900 } }, { id: '__proto__' }, 7, { id: 'crt', off: 1 }, ...Array(10).fill({ id: 'fog' })]);
    expect(out).toHaveLength(MAX_CLIP_EFFECTS);
    expect(out[0]).toEqual({ id: 'snow', params: { ...effectDefaults('snow'), strength: 100 } });
    expect(out[1]).toEqual({ id: 'crt', params: effectDefaults('crt'), off: true });
  });
});

describe('project compatibility', () => {
  it('loads old effect clips and clips without effects unchanged', () => {
    const fx = normalizeClip({ id: 'e1', type: 'effect', start: 0, duration: 1e6, effect: 'zoom-pulse', params: { speed: 10, strength: 90 } });
    expect(fx.params).toEqual({ speed: 10, strength: 90 });
    const old = normalizeClip({ id: 'e2', type: 'effect', start: 0, duration: 1e6, effect: 'vignette' });
    expect(old.params).toEqual({ strength: 50 });
    const v = normalizeClip({ id: 'v1', type: 'video', start: 0, duration: 1e6, assetId: 'a' });
    expect('effects' in v).toBe(false);
    const a = normalizeClip({ id: 'a1', type: 'audio', start: 0, duration: 1e6, effects: [{ id: 'snow' }] });
    expect('effects' in a).toBe(false);
  });

  it('round-trips clip effects through save and load', () => {
    const p = fixture();
    const [v] = onMain(p, clip('video', 0, 4));
    addClipEffect(v, 'hearts', { color: '#00ff00' });
    addClipEffect(v, 'crt');
    setClipEffectOn(v, 1, false);
    const t = clip('text', 0, 2);
    addClipEffect(t, 'neon-border');
    addClip(p, t);
    const back = normalizeProject(JSON.parse(JSON.stringify(p)));
    const vb = findClip(back, v.id).clip;
    expect(vb.effects).toEqual(v.effects);
    expect(findClip(back, t.id).clip.effects[0].id).toBe('neon-border');
  });

  it('makes new effect clips with their own defaults', () => {
    expect(makeClip('effect', { effect: 'snow' }).params).toEqual(effectDefaults('snow'));
    expect(makeClip('effect').params).toEqual(effectDefaults('blur'));
  });
});

describe('editing keeps clip effects', () => {
  it('copies the stack on split, duplicate and slice', () => {
    const p = fixture();
    const [v] = onMain(p, clip('video', 0, 4));
    addClipEffect(v, 'bloom');
    const right = splitClip(p, v.id, s(2));
    expect(right.effects).toEqual(v.effects);
    expect(right.effects).not.toBe(v.effects);
    right.effects[0].params.strength = 5;
    expect(v.effects[0].params.strength).not.toBe(5);
    const dup = duplicateClip(p, v.id);
    expect(dup.effects).toEqual(v.effects);
    const cut = sliceProject(p, s(1), s(3));
    expect(cut.tracks[0].clips.every((c) => c.effects?.[0]?.id === 'bloom')).toBe(true);
  });

  it('copies clip effects as an attribute group', () => {
    const a = makeClip('video', { assetId: 'vid' });
    addClipEffect(a, 'snow');
    const b = makeClip('text');
    applyAttributes(b, captureAttributes(a), ['effects'], a.duration);
    expect(b.effects).toEqual(a.effects);
  });
});

describe('scene', () => {
  it('exposes a clip stack with its timing on the layer', () => {
    const p = fixture();
    const [v] = onMain(p, clip('video', 1, 4));
    addClipEffect(v, 'snow');
    addClipEffect(v, 'crt');
    setClipEffectOn(v, 1, false);
    const [layer] = evaluate(p, s(2));
    expect(ids(layer.effects)).toEqual(['snow']);
    expect(layer.fxTime).toBe(s(1));
    expect(layer.fxDur).toBe(s(4));
    v.effects = undefined;
    expect(evaluate(p, s(2))[0].effects).toBeUndefined();
  });

  it('gives effect track layers their clip length', () => {
    const p = fixture();
    onMain(p, clip('video', 0, 4));
    addClip(p, clip('effect', 0, 3, { effect: 'slow-push' }));
    expect(evaluate(p, s(1)).find((l) => l.kind === 'effect')).toMatchObject({ effect: 'slow-push', duration: s(3), local: s(1) });
  });

  it('keeps clip effects through transitions', () => {
    const p = fixture();
    const [a, b] = onMain(p, clip('video', 0, 4), clip('video', 4, 4));
    a.transition = { id: 'cube', duration: s(1) };
    addClipEffect(b, 'bloom');
    const tr = evaluate(p, s(4)).find((l) => l.kind === 'transition');
    expect(tr.to.effects[0].id).toBe('bloom');
    expect(tr.from.effects).toBeUndefined();
  });
});

describe('filter looks', () => {
  it('adds HSL and curve tables scaled by intensity', () => {
    const full = gradeParams(null, { id: 'autumn', intensity: 100 });
    const half = gradeParams(null, { id: 'autumn', intensity: 50 });
    expect(full.ext.hsl).toBeInstanceOf(Float32Array);
    expect(half.ext.hsl[9]).toBeCloseTo(full.ext.hsl[9] / 2); // green hue
    expect(gradeParams(null, { id: 'autumn', intensity: 0 }).ext).toBe(null);
    const curve = gradeParams(null, { id: 'cross-process', intensity: 50 }).ext;
    expect(curve.curves.blue[0]).toEqual([0, 0.07]);
    expect(curve.curvesKey).toBe('filter:cross-process:0.5');
  });

  it('lets the clip grade keep its own curves and adds HSL on top', () => {
    const grade = { curves: { master: [[0, 0.1], [1, 1]] }, hsl: { green: { s: 10 } } };
    const g = gradeParams(null, { id: 'autumn', intensity: 100 }, grade);
    expect(g.ext.curves.master).toEqual([[0, 0.1], [1, 1]]);
    const own = gradeParams(null, null, grade).ext.hsl[10];
    expect(g.ext.hsl[10]).toBeCloseTo(own + gradeParams(null, { id: 'autumn', intensity: 100 }).ext.hsl[10]);
  });
});

describe('clip effects in the editor', () => {
  let env;
  HTMLCanvasElement.prototype.getContext = () => null;

  beforeEach(() => {
    const p = fixture();
    const [v] = onMain(p, clip('video', 0, 5));
    const fx = clip('effect', 0, 3, { effect: 'blur' });
    addClip(p, fx);
    const store = new EditorStore(p);
    const ctx = { store };
    ctx.actions = createActions(ctx);
    const insp = createInspector(ctx);
    ctx.inspector = insp;
    document.body.append(insp.el);
    env = { store, ctx, insp, el: insp.el, v, fx };
  });
  afterEach(() => {
    env.insp.dispose();
    env.el.remove();
  });

  const live = (id) => findClip(env.store.project, id).clip;
  const field = (label) => [...env.el.querySelectorAll('.field')].find((f) => f.querySelector('.field-label')?.textContent === label);
  const drag = (input, values) => {
    for (const v of values) {
      input.value = String(v);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    input.dispatchEvent(new Event('change', { bubbles: true }));
  };

  it('adds effects to a clip as undoable steps and opens the Effects tab', () => {
    env.store.select(env.v.id);
    expect(env.ctx.actions.addClipEffect(env.v.id, 'bloom')).toBe(true);
    expect(live(env.v.id).effects.map((e) => e.id)).toEqual(['bloom']);
    const selected = env.el.querySelector('.top-tabs [aria-selected=true]');
    expect(selected.textContent).toBe('Effects');
    expect(env.el.querySelectorAll('.clipfx-item')).toHaveLength(1);
    env.store.undo();
    expect('effects' in live(env.v.id)).toBe(false);
    expect(env.el.querySelectorAll('.clipfx-item')).toHaveLength(0);
  });

  it('refuses a sixth effect', () => {
    for (let i = 0; i < MAX_CLIP_EFFECTS; i++) env.ctx.actions.addClipEffect(env.v.id, 'snow');
    expect(env.ctx.actions.addClipEffect(env.v.id, 'snow')).toBe(false);
    expect(live(env.v.id).effects).toHaveLength(MAX_CLIP_EFFECTS);
  });

  it('edits, reorders, toggles and removes effects from the tab', () => {
    env.store.select(env.v.id);
    env.ctx.actions.addClipEffect(env.v.id, 'bloom');
    env.ctx.actions.addClipEffect(env.v.id, 'snow');
    const before = env.store.history.undoStack.length;
    drag(field('Threshold').querySelector('input[type=range]'), [60, 70, 80]);
    expect(live(env.v.id).effects[0].params.threshold).toBe(80);
    expect(env.store.history.undoStack.length).toBe(before + 1);
    env.el.querySelector('[aria-label="Move Snowfall up"]').click();
    expect(live(env.v.id).effects.map((e) => e.id)).toEqual(['snow', 'bloom']);
    env.el.querySelector('[aria-label="Snowfall on"]').click();
    expect(live(env.v.id).effects[0].off).toBe(true);
    expect(env.el.querySelector('.clipfx-item').classList.contains('off')).toBe(true);
    env.el.querySelector('[aria-label="Remove Bloom"]').click();
    expect(live(env.v.id).effects.map((e) => e.id)).toEqual(['snow']);
  });

  it('adds from the picker in the tab', () => {
    env.store.select(env.v.id);
    env.ctx.inspector.showTab('clipfx');
    const sel = env.el.querySelector('.clipfx-add');
    sel.value = 'hearts';
    sel.dispatchEvent(new Event('change'));
    expect(live(env.v.id).effects[0].id).toBe('hearts');
    expect(field('Color')).toBeTruthy();
  });

  it('keeps keyboard focus when the picker fills up and after Remove all', () => {
    env.store.select(env.v.id);
    for (let i = 0; i < MAX_CLIP_EFFECTS - 1; i++) env.ctx.actions.addClipEffect(env.v.id, 'snow');
    env.ctx.inspector.showTab('clipfx');
    const sel = env.el.querySelector('.clipfx-add');
    sel.focus();
    sel.value = 'hearts';
    sel.dispatchEvent(new Event('change'));
    expect(live(env.v.id).effects).toHaveLength(MAX_CLIP_EFFECTS);
    // The picker turns off at the limit; focus goes to Browse.
    expect(sel.disabled).toBe(true);
    expect(document.activeElement.textContent).toBe('Browse');
    const all = env.el.querySelector('[aria-label="Remove all clip effects"]');
    all.focus();
    all.click();
    expect('effects' in live(env.v.id)).toBe(false);
    expect(all.hidden).toBe(true);
    expect(document.activeElement).toBe(sel);
  });

  it('shows each effect clip its own parameters and carries shared ones over', () => {
    env.store.select(env.fx.id);
    expect(field('Amount')).toBeTruthy();
    drag(field('Amount').querySelector('input[type=range]'), [70]);
    const sel = field('Effect').querySelector('select');
    sel.value = 'bloom';
    sel.dispatchEvent(new Event('change'));
    expect(live(env.fx.id).params).toEqual({ strength: 70, threshold: 55 });
    expect(field('Threshold')).toBeTruthy();
    expect(field('Amount')).toBeFalsy();
  });
});
