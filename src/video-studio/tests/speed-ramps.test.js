import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EditorStore } from '../src/model/store.js';
import { createProject, makeClip, makeTrack, normalizeProject } from '../src/model/project.js';
import { createActions } from '../src/ui/actions.js';
import { createInspector } from '../src/ui/inspector/index.js';
import { rampPreview } from '../src/ui/inspector/speed-ramps.js';
import { SPEED_RAMPS, findRamp, rampPoints, activeRamp, accentLabel, addRampAccents, stripRampAccents, normalizeSpeedRamp } from '../src/model/speed-ramps.js';
import { meanSpeed, sameCurve, curveTable, CURVE_MIN, CURVE_MAX } from '../src/model/speed-curve.js';
import * as T from '../src/model/timeline.js';
import { US } from '../src/lib/time.js';

HTMLCanvasElement.prototype.getContext = () => null;

function project() {
  const p = createProject();
  p.assets.a1 = { id: 'a1', kind: 'video', name: 'clip.mp4', duration: 20 * US, width: 1920, height: 1080, fps: 30, hasAudio: true, hasVideo: true };
  const v1 = makeClip('video', { assetId: 'a1', start: 0, duration: 4 * US, name: 'One' });
  const v2 = makeClip('video', { assetId: 'a1', start: 4 * US, duration: 4 * US, name: 'Two' });
  T.mainTrack(p).clips.push(v1, v2);
  return { p, v1, v2 };
}

describe('velocity ramp presets', () => {
  it('has about ten original ramps with valid curves and accents', () => {
    expect(SPEED_RAMPS.length).toBeGreaterThanOrEqual(10);
    expect(new Set(SPEED_RAMPS.map((r) => r.id)).size).toBe(SPEED_RAMPS.length);
    for (const r of SPEED_RAMPS) {
      expect(r.points[0].t).toBe(0);
      expect(r.points.at(-1).t).toBe(1);
      for (const q of r.points) expect(q.v >= CURVE_MIN && q.v <= CURVE_MAX).toBe(true);
      for (const a of r.accents) {
        expect(['flash', 'punch', 'blur']).toContain(a.kind);
        expect(a.at > 0 && a.at < 1).toBe(true);
      }
      expect(Number.isFinite(curveTable(r.points).total)).toBe(true);
      expect(r.hint.length).toBeGreaterThan(10);
    }
    expect(accentLabel(findRamp('launch'))).toBe('Flash, Motion blur');
    expect(accentLabel(findRamp('slow-reveal'))).toBe('');
  });

  it('applies curve and accent keys, keeping the footage; another ramp replaces them', () => {
    const { p, v1, v2 } = project();
    v1.keyframes.scale = [{ t: 0, v: 1, ease: 'linear' }, { t: 4 * US, v: 1.5, ease: 'linear' }];
    expect(T.applySpeedRamp(p, v1.id, 'punch-in', { ripple: true })).toBe(true);
    const c = T.findClip(p, v1.id).clip;
    expect(sameCurve(c.speedCurve, findRamp('punch-in').points)).toBe(true);
    expect(c.duration).toBe(Math.round((4 * US) / meanSpeed(c.speedCurve)));
    expect(T.findClip(p, v2.id).clip.start).toBe(c.duration);
    expect(c.speedRamp).toEqual({ id: 'punch-in', accent: true });
    const ramped = c.keyframes.scale.filter((k) => k.ramp);
    expect(ramped).toHaveLength(3);
    // The peak sits at the accent's fraction of the new length, above the user's own animation there.
    const peak = ramped[1];
    expect(peak.t).toBe(Math.round(0.46 * c.duration));
    expect(peak.v).toBeGreaterThan(1.1);
    expect(c.keyframes.scale.filter((k) => !k.ramp)).toHaveLength(2);
    expect(activeRamp(c)).toEqual({ ramp: findRamp('punch-in'), tweaked: false });

    T.applySpeedRamp(p, v1.id, 'flash-hit', { ripple: true });
    expect(c.keyframes.scale.every((k) => !k.ramp)).toBe(true);
    expect(c.keyframes['adjust.exposure'].filter((k) => k.ramp)).toHaveLength(3);
    expect(Math.max(...c.keyframes['adjust.exposure'].map((k) => k.v))).toBe(85);
  });

  it('a blur accent turns motion blur on and gives it back when removed', () => {
    const { p, v1 } = project();
    T.applySpeedRamp(p, v1.id, 'whip-through');
    const c = T.findClip(p, v1.id).clip;
    expect(c.motionBlur).toEqual({ on: true, amount: 70 });
    expect(c.speedRamp.blur).toBe('added');
    expect(c.keyframes.scale.some((k) => k.ramp)).toBe(true);
    T.applySpeedRamp(p, v1.id, null);
    expect(c.motionBlur).toBeUndefined();
    expect(c.speedCurve).toBeUndefined();
    expect(c.speedRamp).toBeUndefined();
    expect(c.keyframes.scale).toBeUndefined();
    // Motion blur that was there but off is switched back off, not removed.
    c.motionBlur = { on: false, amount: 30 };
    T.applySpeedRamp(p, v1.id, 'rush');
    expect(c.motionBlur).toEqual({ on: true, amount: 30 });
    T.setSpeed(p, v1.id, 2);
    expect(c.motionBlur).toEqual({ on: false, amount: 30 });
    expect(c.speedRamp).toBeUndefined();
  });

  it('without the accent only the curve changes; the accent can be toggled later', () => {
    const { p, v1 } = project();
    T.applySpeedRamp(p, v1.id, 'double-tap', { accent: false });
    const c = T.findClip(p, v1.id).clip;
    expect(c.speedRamp).toEqual({ id: 'double-tap', accent: false });
    expect(c.keyframes).toEqual({});
    expect(T.setRampAccent(p, v1.id, true)).toBe(true);
    expect(c.keyframes.scale.filter((k) => k.ramp)).toHaveLength(6);
    expect(T.setRampAccent(p, v1.id, true)).toBe(false);
    T.setRampAccent(p, v1.id, false);
    expect(c.keyframes.scale).toBeUndefined();
  });

  it('audio clips get the curve without accents', () => {
    const { p } = project();
    const a = makeClip('audio', { assetId: 'a1', start: 0, duration: 4 * US });
    p.tracks.push({ ...makeTrack('audio'), clips: [a] });
    expect(T.applySpeedRamp(p, a.id, 'flash-hit')).toBe(true);
    expect(a.speedCurve).toBeTruthy();
    expect(a.keyframes).toEqual({});
  });

  it('edits in Curve mode keep the ramp marked as edited; split halves too', () => {
    const { p, v1 } = project();
    T.applySpeedRamp(p, v1.id, 'hang-time');
    const c = T.findClip(p, v1.id).clip;
    const pts = c.speedCurve.map((q) => ({ ...q }));
    pts[2].v = 0.2;
    T.setSpeedCurve(p, v1.id, pts);
    expect(activeRamp(c)).toEqual({ ramp: findRamp('hang-time'), tweaked: true });
    // A different curve preset drops the ramp and its accents.
    T.setSpeedCurve(p, v1.id, [{ t: 0, v: 1 }, { t: 1, v: 2 }], { dropRamp: true });
    expect(c.speedRamp).toBeUndefined();
    expect(Object.values(c.keyframes).flat().some((k) => k.ramp)).toBe(false);
  });

  it('survives save and load', () => {
    const { p, v1 } = project();
    T.applySpeedRamp(p, v1.id, 'launch');
    const loaded = normalizeProject(JSON.parse(JSON.stringify(p)));
    const c = T.findClip(loaded, v1.id).clip;
    expect(c.speedRamp).toEqual({ id: 'launch', accent: true, blur: 'added' });
    expect(c.keyframes['adjust.exposure'].every((k) => k.ramp === true)).toBe(true);
    expect(normalizeSpeedRamp({ id: 'nope' })).toBeNull();
    expect(normalizeSpeedRamp({ id: 'rush', accent: false, blur: 'weird' })).toEqual({ id: 'rush', accent: false });
  });

  it('pure helpers leave clips without visuals or ramps alone', () => {
    const a = makeClip('audio', {});
    expect(addRampAccents(a, findRamp('punch-in'))).toBe(false);
    stripRampAccents(null);
    const v = makeClip('video', { duration: 2 * US });
    v.speedRamp = { id: 'punch-in', accent: true };
    addRampAccents(v, findRamp('punch-in'));
    // Keys stay inside the clip.
    for (const k of v.keyframes.scale) expect(k.t >= 0 && k.t <= v.duration).toBe(true);
    stripRampAccents(v);
    expect(v.keyframes).toEqual({});
    expect(rampPoints('punch-in')).not.toBe(findRamp('punch-in').points);
  });
});

describe('Ramps sub-tab', () => {
  let env;
  beforeEach(() => {
    const { p, v1, v2 } = project();
    const store = new EditorStore(p);
    const ctx = { store };
    ctx.actions = createActions(ctx);
    const insp = createInspector(ctx);
    document.body.append(insp.el);
    env = { store, insp, el: insp.el, v1, v2 };
    store.select(v1.id);
    tab('Speed').click();
    tab('Ramps').click();
  });
  afterEach(() => {
    env.insp.dispose();
    env.el.remove();
  });
  const clip = (id) => T.findClip(env.store.project, id).clip;
  const tab = (name) => [...env.el.querySelectorAll('[role=tab]')].find((t) => t.textContent === name);
  const tile = (label) => [...env.el.querySelectorAll('.speed-ramp-grid .choice')].find((b) => b.textContent === label);

  it('shows a tile with an animated-curve preview per ramp', () => {
    const labels = [...env.el.querySelectorAll('.speed-ramp-grid .choice-label')].map((x) => x.textContent);
    expect(labels).toEqual(['None', ...SPEED_RAMPS.map((r) => r.label)]);
    expect(tile('None').getAttribute('aria-checked')).toBe('true');
    for (const r of SPEED_RAMPS) {
      const el = rampPreview(r);
      expect(el.querySelector('.ramp-curve-line').getAttribute('d')).not.toMatch(/NaN/);
      expect(el.querySelectorAll('.ramp-curve-accent')).toHaveLength(r.accents.length);
    }
    expect(tile('Flash hit').title).toMatch(/Accent: Flash/);
  });

  it('applies a ramp in one undo step and marks it active', () => {
    tile('Snap and glide').click();
    const c = clip(env.v1.id);
    expect(c.speedRamp.id).toBe('snap-glide');
    expect(c.keyframes.scale.some((k) => k.ramp)).toBe(true);
    expect(tile('Snap and glide').getAttribute('aria-checked')).toBe('true');
    expect(env.el.querySelector('.speed-ramp-status').textContent).toMatch(/^Snap and glide:/);
    expect(env.el.querySelector('.speed-ramp-head').classList.contains('is-active')).toBe(true);
    env.store.undo();
    const u = clip(env.v1.id);
    expect(u.speedCurve).toBeUndefined();
    expect(u.speedRamp).toBeUndefined();
    expect(u.keyframes).toEqual({});
    expect(u.duration).toBe(4 * US);
    expect(tile('None').getAttribute('aria-checked')).toBe('true');
  });

  it('the accent switch applies the next ramp without the accent and toggles the active one', () => {
    const sw = env.el.querySelector('.speed-ramps-panel [role=switch]');
    sw.click();
    tile('Heartbeat').click();
    expect(clip(env.v1.id).keyframes).toEqual({});
    sw.click();
    expect(clip(env.v1.id).keyframes.scale.filter((k) => k.ramp)).toHaveLength(6);
    env.store.undo();
    expect(clip(env.v1.id).keyframes).toEqual({});
  });

  it('Tweak in Curve opens the curve editor with the ramp noted; edits show as edited', () => {
    tile('Rush').click();
    env.el.querySelector('.speed-ramp-tweak').click();
    expect(tab('Curve').getAttribute('aria-selected')).toBe('true');
    const origin = env.el.querySelector('.speed-ramp-origin');
    expect(origin.hidden).toBe(false);
    expect(origin.textContent).toBe('Rush ramp');
    const canvas = env.el.querySelector('.speed-curve-canvas');
    canvas.focus();
    canvas.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageDown', bubbles: true }));
    canvas.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageDown', bubbles: true }));
    canvas.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    canvas.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowUp', bubbles: true }));
    expect(origin.textContent).toBe('Rush ramp, edited');
    tab('Ramps').click();
    expect(tile('Rush').getAttribute('aria-checked')).toBe('true');
    expect(env.el.querySelector('.speed-ramp-status').textContent).toMatch(/edited in Curve/);
    // Re-selecting the clip opens where the user left off.
    env.store.select(env.v2.id);
    env.store.select(env.v1.id);
    expect(tab('Ramps').getAttribute('aria-selected')).toBe('true');
  });

  it('None removes the ramp and its accents', () => {
    tile('Launch').click();
    tile('None').click();
    const c = clip(env.v1.id);
    expect(c.speedCurve).toBeUndefined();
    expect(c.motionBlur).toBeUndefined();
    expect(c.keyframes).toEqual({});
  });
});
