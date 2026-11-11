import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EditorStore } from '../src/model/store.js';
import { createProject, makeClip } from '../src/model/project.js';
import { createActions } from '../src/ui/actions.js';
import { createInspector } from '../src/ui/inspector/index.js';
import { adjustTab as colorAssets } from '../src/ui/panels/adjust.js';
import { savePreset, applyPreset, colorPresets, removePreset, applyLut } from '../src/ui/color-tools.js';
import * as T from '../src/model/timeline.js';
import { US } from '../src/lib/time.js';

let env;

function setup() {
  const p = createProject();
  p.assets.a1 = { id: 'a1', kind: 'video', name: 'clip.mp4', duration: 20 * US, width: 1920, height: 1080, fps: 30, hasAudio: false, hasVideo: true };
  const v1 = makeClip('video', { assetId: 'a1', start: 0, duration: 5 * US, name: 'One' });
  const v2 = makeClip('video', { assetId: 'a1', start: 5 * US, duration: 5 * US, name: 'Two' });
  T.mainTrack(p).clips.push(v1, v2);
  const adj = makeClip('adjust', { start: 0, duration: 3 * US });
  T.addClip(p, adj);
  const store = new EditorStore(p);
  const ctx = { store };
  ctx.actions = createActions(ctx);
  const insp = createInspector(ctx);
  document.body.append(insp.el);
  return { p, store, ctx, insp, el: insp.el, v1, v2, adj };
}

const clip = (id) => T.findClip(env.store.project, id).clip;
const field = (label) => [...env.el.querySelectorAll('.field')].find((f) => f.querySelector('.field-label')?.textContent === label);
const range = (label) => field(label).querySelector('input[type=range]');
const tab = (name) => [...env.el.querySelectorAll('[role=tab]')].find((t) => t.textContent === name);
const button = (text) => [...env.el.querySelectorAll('button')].find((b) => b.textContent.trim() === text);
const drag = (input, values) => {
  for (const v of values) {
    input.value = String(v);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }
  input.dispatchEvent(new Event('change', { bubbles: true }));
};
const key = (el, k, extra = {}) => el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, ...extra }));

beforeEach(() => {
  localStorage.clear();
  env = setup();
  env.store.select(env.v1.id);
  tab('Color').click();
});

afterEach(() => {
  env.insp.dispose();
  env.el.remove();
});

describe('Color tab', () => {
  it('has Basic, HSL, Curves and Wheels sub-tabs and remembers the choice', () => {
    expect([...env.el.querySelectorAll('.subtabs [role=tab]')].map((t) => t.textContent)).toEqual(['Basic', 'HSL', 'Curves', 'Wheels']);
    tab('Curves').click();
    env.store.select(env.v2.id);
    expect(tab('Curves').getAttribute('aria-selected')).toBe('true');
    expect(env.el.querySelector('.curve-canvas')).toBeTruthy();
  });

  it('groups the sliders into Color, Light and Detail sections with the new controls', () => {
    const titles = [...env.el.querySelectorAll('.grade-section .section-toggle')].map((b) => b.textContent);
    expect(titles).toEqual(['LUT', 'Color', 'Light', 'Detail and finish']);
    for (const l of ['Vibrance', 'Whites', 'Blacks', 'Brilliance', 'Clarity']) expect(field(l), l).toBeTruthy();
  });

  it('keyframes any color slider and edits the key at the playhead', () => {
    env.store.seek(US);
    field('Exposure').querySelector('.kf-btn').click();
    expect(clip(env.v1.id).keyframes['adjust.exposure']).toEqual([{ t: US, v: 0, ease: 'linear' }]);
    env.store.seek(3 * US);
    const before = env.store.history.undoStack.length;
    drag(range('Exposure'), [10, 30, 50]);
    expect(env.store.history.undoStack.length).toBe(before + 1);
    expect(clip(env.v1.id).keyframes['adjust.exposure'].map((k) => k.v)).toEqual([0, 50]);
    expect(clip(env.v1.id).adjust.exposure).toBe(0);
    env.store.seek(2 * US);
    expect(field('Exposure').querySelector('.num-input').value).toBe('25');
    // Removing the last key keeps its value as the plain setting.
    env.store.seek(US);
    field('Exposure').querySelector('.kf-btn').click();
    env.store.seek(3 * US);
    field('Exposure').querySelector('.kf-btn').click();
    expect(clip(env.v1.id).keyframes['adjust.exposure']).toBeUndefined();
    expect(clip(env.v1.id).adjust.exposure).toBe(50);
  });

  it('keyframes color layer clips too', () => {
    env.store.select(env.adj.id);
    env.store.seek(US);
    field('Saturation').querySelector('.kf-btn').click();
    expect(clip(env.adj.id).keyframes['adjust.saturation']).toHaveLength(1);
  });

  it('turns a section off and on, and resets it', () => {
    drag(range('Whites'), [40]);
    const box = [...env.el.querySelectorAll('.section-check')][2];
    expect(box.getAttribute('aria-label')).toBe('Apply light');
    box.checked = false;
    box.dispatchEvent(new Event('change'));
    expect(clip(env.v1.id).grade.off.light).toBe(true);
    expect(clip(env.v1.id).adjust.whites).toBe(40);
    expect(box.closest('.prop-section').querySelector('.section-body').classList.contains('is-off')).toBe(true);
    env.store.undo();
    expect(box.checked).toBe(true);
    box.closest('.prop-section').querySelector('.section-reset').click();
    expect(clip(env.v1.id).adjust.whites).toBe(0);
  });

  it('reset all clears the adjust values, color keyframes and grade', () => {
    drag(range('Clarity'), [20]);
    applyLut(env.ctx, env.v1.id, { id: 'lut1', name: 'Look' });
    button('Reset all').click();
    expect(clip(env.v1.id).adjust.clarity).toBe(0);
    expect(clip(env.v1.id).grade).toBeUndefined();
  });

  it('applies and clears a LUT', () => {
    applyLut(env.ctx, env.v1.id, { id: 'lut1', name: 'Look' });
    expect(clip(env.v1.id).grade.lut).toEqual({ id: 'lut1', name: 'Look', intensity: 100 });
    drag(range('Intensity'), [40]);
    expect(clip(env.v1.id).grade.lut.intensity).toBe(40);
    expect(env.el.querySelector('select').value).toBe('lut1');
    applyLut(env.ctx, env.v1.id, null);
    expect(clip(env.v1.id).grade.lut).toBe(null);
  });
});

describe('HSL', () => {
  beforeEach(() => tab('HSL').click());

  it('edits the selected hue range', () => {
    env.el.querySelector('.hsl-swatch[data-id=blue]').click();
    drag(range('Saturation'), [-20, -60]);
    expect(clip(env.v1.id).grade.hsl.blue).toEqual({ h: 0, s: -60, l: 0 });
    expect(env.el.querySelector('.hsl-swatch[data-id=blue]').classList.contains('changed')).toBe(true);
    env.el.querySelector('.hsl-swatch[data-id=green]').click();
    expect(range('Saturation').value).toBe('0');
    env.el.querySelector('.hsl-swatch[data-id=blue]').click();
    expect(range('Saturation').value).toBe('-60');
  });

  it('moves between ranges with arrow keys', () => {
    const group = env.el.querySelector('.hsl-swatches');
    env.el.querySelector('.hsl-swatch[data-id=red]').focus();
    key(group, 'ArrowRight');
    expect(env.el.querySelector('.hsl-swatch[aria-checked=true]').dataset.id).toBe('orange');
    key(group, 'ArrowLeft');
    key(group, 'ArrowLeft');
    expect(env.el.querySelector('.hsl-swatch[aria-checked=true]').dataset.id).toBe('magenta');
  });

  it('the eyedropper stops when the HSL panel goes away', () => {
    const canvas = document.createElement('canvas');
    const stage = document.createElement('div');
    stage.className = 'player-stage';
    stage.append(canvas);
    document.body.append(stage);
    env.ctx.player = { canvas };
    env.el.querySelector('.hsl-picker').click();
    expect(stage.classList.contains('eyedropper-active')).toBe(true);
    // Another clip selected: the next click on the player is an ordinary click.
    env.store.select(env.v2.id);
    expect(stage.classList.contains('eyedropper-active')).toBe(false);
    const down = new MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 });
    canvas.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(false);
    // Another tab of the same clip: the same.
    tab('HSL').click();
    env.el.querySelector('.hsl-picker').click();
    tab('Basic').click();
    const again = new MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 });
    canvas.dispatchEvent(again);
    expect(again.defaultPrevented).toBe(false);
    expect(stage.classList.contains('eyedropper-active')).toBe(false);
    stage.remove();
  });
});

describe('Curves', () => {
  beforeEach(() => tab('Curves').click());

  it('adds and moves points from the keyboard as one undo step per move', () => {
    const canvas = env.el.querySelector('.curve-canvas');
    key(canvas, '+');
    expect(clip(env.v1.id).grade.curves.master).toEqual([[0, 0], [0.5, 0.5], [1, 1]]);
    key(canvas, 'ArrowUp', { shiftKey: true });
    key(canvas, 'ArrowUp', { shiftKey: true });
    canvas.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowUp' }));
    expect(clip(env.v1.id).grade.curves.master[1][1]).toBeCloseTo(0.6);
    expect(env.el.querySelector('.curve-readout').textContent).toBe('Point 2 of 3: input 128, output 153');
    env.store.undo();
    expect(clip(env.v1.id).grade.curves.master[1][1]).toBeCloseTo(0.5);
    key(canvas, 'Delete');
    expect(clip(env.v1.id).grade.curves.master).toBeUndefined();
  });

  it('edits each channel separately and resets one curve', () => {
    env.el.querySelector('.curve-channels [data-ch=red]').click();
    const canvas = env.el.querySelector('.curve-canvas');
    key(canvas, '+');
    key(canvas, 'ArrowDown', { shiftKey: true });
    expect(clip(env.v1.id).grade.curves.red[1][1]).toBeCloseTo(0.45);
    expect(clip(env.v1.id).grade.curves.master).toBeUndefined();
    env.el.querySelector('.curve-head .icon-btn').click();
    expect(clip(env.v1.id).grade.curves.red).toBeUndefined();
  });
});

describe('Wheels', () => {
  beforeEach(() => tab('Wheels').click());

  it('a double-click centers a wheel in one undo step', () => {
    const [shadows] = env.el.querySelectorAll('.wheel-disk');
    key(shadows, 'ArrowRight', { shiftKey: true });
    shadows.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowRight' }));
    expect(clip(env.v1.id).grade.wheels.shadows).toEqual({ x: 0.05, y: 0, l: 0 });
    const steps = env.store.history.undoStack.length;
    // jsdom has no layout: the wheel is 0 px, so any click lands on its edge.
    const ptr = (type, detail) => shadows.dispatchEvent(new MouseEvent(type, { bubbles: true, button: 0, detail, clientX: 1, clientY: -1 }));
    ptr('pointerdown', 1);
    ptr('pointerup', 1);
    expect(clip(env.v1.id).grade.wheels.shadows.y).toBe(1);
    ptr('pointerdown', 2);
    ptr('pointerup', 2);
    shadows.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, detail: 2 }));
    expect(clip(env.v1.id).grade.wheels.shadows).toEqual({ x: 0, y: 0, l: 0 });
    expect(env.store.history.undoStack.length).toBe(steps + 1);
    env.store.undo();
    expect(clip(env.v1.id).grade.wheels.shadows).toEqual({ x: 0.05, y: 0, l: 0 });
    // A single click still moves the puck as its own step.
    ptr('pointerdown', 1);
    ptr('pointerup', 1);
    expect(clip(env.v1.id).grade.wheels.shadows.y).toBe(1);
    env.store.undo();
    expect(clip(env.v1.id).grade.wheels.shadows).toEqual({ x: 0.05, y: 0, l: 0 });
  });

  it('nudges a wheel with the keyboard and resets it', () => {
    const [shadows] = env.el.querySelectorAll('.wheel-disk');
    key(shadows, 'ArrowRight', { shiftKey: true });
    key(shadows, 'ArrowRight', { shiftKey: true });
    expect(clip(env.v1.id).grade.wheels.shadows).toEqual({ x: 0.1, y: 0, l: 0 });
    expect(shadows.getAttribute('aria-valuetext')).toBe('hue 0 degrees, strength 10 percent');
    const level = env.el.querySelectorAll('.wheel-level')[2];
    drag(level, [20]);
    expect(clip(env.v1.id).grade.wheels.highlights.l).toBe(20);
    expect(env.el.querySelectorAll('.wheel-val')[6].textContent).toBe('+0.10');
    env.el.querySelector('.wheel-card .icon-btn').click();
    expect(clip(env.v1.id).grade.wheels.shadows).toEqual({ x: 0, y: 0, l: 0 });
    drag(range('Intensity'), [50]);
    expect(clip(env.v1.id).grade.wheels.intensity).toBe(50);
  });
});

describe('wheel brightness', () => {
  it('follows undo while it has focus', () => {
    tab('Wheels').click();
    const level = env.el.querySelectorAll('.wheel-level')[0];
    level.focus();
    drag(level, [30]);
    expect(clip(env.v1.id).grade.wheels.shadows.l).toBe(30);
    env.store.undo();
    expect(level.value).toBe('0');
  });
});

describe('presets and the Color assets tab', () => {
  it('saves a clip look, applies it to another clip and lists it', () => {
    drag(range('Contrast'), [25]);
    applyLut(env.ctx, env.v1.id, { id: 'lut1', name: 'Look' });
    const preset = savePreset('Punchy', clip(env.v1.id));
    expect(colorPresets()[0]).toMatchObject({ name: 'Punchy', adjust: { contrast: 25 }, grade: { lut: { id: 'lut1' } } });
    clip(env.v2.id).keyframes['adjust.contrast'] = [{ t: 0, v: 5, ease: 'linear' }];
    applyPreset(env.ctx, env.v2.id, preset);
    expect(clip(env.v2.id).adjust.contrast).toBe(25);
    expect(clip(env.v2.id).grade.lut.id).toBe('lut1');
    expect(clip(env.v2.id).keyframes['adjust.contrast']).toBeUndefined();
    const panel = colorAssets(env.ctx);
    [...panel.el.querySelectorAll('.asset-cat')].find((b) => b.textContent === 'Your presets').click();
    expect([...panel.el.querySelectorAll('.tile-label')].map((t) => t.textContent)).toEqual(['Punchy']);
    // Nothing selected: the preset becomes a color layer.
    env.store.clearSelection();
    panel.el.querySelector('.tile').click();
    const layer = env.store.selected.clip;
    expect(layer).toMatchObject({ type: 'adjust', name: 'Punchy', adjust: { contrast: 25 }, grade: { lut: { id: 'lut1' } } });
    removePreset(preset.id);
    expect(panel.el.querySelectorAll('.tile-label')).toHaveLength(0);
    panel.dispose();
  });

  it('shows the LUT the selected clip uses after undo and edits elsewhere', async () => {
    const luts = [{ id: 'lut1', name: 'Warm', kind: '3d', size: 33 }, { id: 'lut2', name: 'Cool', kind: '3d', size: 33 }];
    env.ctx.library = { listLuts: async () => luts, on: () => () => {} };
    const panel = colorAssets(env.ctx);
    document.body.append(panel.el);
    await Promise.resolve();
    await Promise.resolve();
    [...panel.el.querySelectorAll('.asset-cat')].find((b) => b.textContent === 'LUTs').click();
    const pressed = () => [...panel.el.querySelectorAll('.tile[aria-pressed=true] .tile-label')].map((t) => t.textContent);
    expect(pressed()).toEqual([]);
    const warm = panel.el.querySelector('.tile[aria-label="Apply LUT Warm to clip"]');
    warm.focus();
    warm.click();
    expect(clip(env.v1.id).grade.lut.id).toBe('lut1');
    expect(pressed()).toEqual(['Warm']);
    env.store.undo();
    expect(pressed()).toEqual([]);
    // Focus stays on the same tile while the grid is redrawn.
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Apply LUT Warm to clip');
    // Picked in the details panel.
    applyLut(env.ctx, env.v1.id, luts[1]);
    expect(pressed()).toEqual(['Cool']);
    panel.dispose();
    panel.el.remove();
  });

  it('adds color layers from drag data, validating it', () => {
    env.ctx.actions.addAdjustment({ start: 6 * US, name: 'Dropped', adjust: { exposure: 500, nope: 3 }, grade: { lut: { id: 'bad id!' }, hsl: { red: { h: 5 } } } });
    const c = env.store.selected.clip;
    expect(c.adjust.exposure).toBe(100);
    expect('nope' in c.adjust).toBe(false);
    expect(c.grade).toEqual({ hsl: { red: { h: 5, s: 0, l: 0 } } });
  });
});

describe('reset buttons and keyboard focus', () => {
  const press = (b) => {
    b.focus();
    b.click();
  };

  it('a wheel reset moves focus to its wheel', () => {
    tab('Wheels').click();
    const [shadows] = env.el.querySelectorAll('.wheel-disk');
    key(shadows, 'ArrowRight', { shiftKey: true });
    const reset = env.el.querySelector('.wheel-card .icon-btn');
    press(reset);
    expect(reset.disabled).toBe(true);
    expect(document.activeElement).toBe(shadows);
  });

  it('an HSL range reset moves focus to the range', () => {
    tab('HSL').click();
    env.el.querySelector('.hsl-swatch[data-id=blue]').click();
    drag(range('Saturation'), [-20]);
    const reset = env.el.querySelector('.hsl-foot .btn');
    press(reset);
    expect(reset.disabled).toBe(true);
    expect(document.activeElement).toBe(env.el.querySelector('.hsl-swatch[data-id=blue]'));
  });

  it('a curve reset moves focus to the curve', () => {
    tab('Curves').click();
    const canvas = env.el.querySelector('.curve-canvas');
    key(canvas, '+');
    const reset = env.el.querySelector('.curve-head .icon-btn');
    press(reset);
    expect(reset.disabled).toBe(true);
    expect(document.activeElement).toBe(canvas);
  });
});
