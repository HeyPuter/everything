import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EditorStore } from '../src/model/store.js';
import { createProject, makeClip } from '../src/model/project.js';
import { createActions } from '../src/ui/actions.js';
import { createInspector, tabsFor } from '../src/ui/inspector/index.js';
import { gainToDb, dbToGain } from '../src/ui/inspector/audio.js';
import { speedToPos, posToSpeed } from '../src/ui/inspector/speed.js';
import * as T from '../src/model/timeline.js';
import { US } from '../src/lib/time.js';

// jsdom has no canvas; previews fall back to blank tiles.
HTMLCanvasElement.prototype.getContext = () => null;

let env;

function setup() {
  const p = createProject();
  p.assets.a1 = { id: 'a1', kind: 'video', name: 'clip.mp4', duration: 20 * US, width: 1920, height: 1080, fps: 30, hasAudio: true, hasVideo: true };
  p.assets.a2 = { id: 'a2', kind: 'image', name: 'photo.jpg', duration: 0, width: 800, height: 600, fps: 0, hasAudio: false, hasVideo: false };
  p.assets.a3 = { id: 'a3', kind: 'audio', name: 'music.mp3', duration: 30 * US, width: 0, height: 0, fps: 0, hasAudio: true, hasVideo: false };
  const v1 = makeClip('video', { assetId: 'a1', start: 0, duration: 5 * US, name: 'One' });
  const v2 = makeClip('video', { assetId: 'a1', start: 5 * US, duration: 5 * US, name: 'Two' });
  T.mainTrack(p).clips.push(v1, v2);
  const img = makeClip('image', { assetId: 'a2', start: 0, duration: 5 * US });
  T.addClip(p, img, { main: false });
  const aud = makeClip('audio', { assetId: 'a3', start: 0, duration: 8 * US });
  T.addClip(p, aud);
  const text = makeClip('text', { start: 0, duration: 4 * US, text: 'Hello' });
  T.addClip(p, text);
  const fx = makeClip('effect', { start: 0, duration: 3 * US, effect: 'blur' });
  T.addClip(p, fx);
  const filt = makeClip('filter', { start: 0, duration: 3 * US, filter: 'vivid' });
  T.addClip(p, filt);
  const adj = makeClip('adjust', { start: 0, duration: 3 * US });
  T.addClip(p, adj);
  const store = new EditorStore(p);
  const ctx = { store };
  ctx.actions = createActions(ctx);
  const insp = createInspector(ctx);
  ctx.inspector = insp;
  document.body.append(insp.el);
  return { p, store, ctx, insp, el: insp.el, v1, v2, img, aud, text, fx, filt, adj };
}

const clip = (id) => T.findClip(env.store.project, id).clip;
const field = (label, root = env.el) => [...root.querySelectorAll('.field')].find((f) => f.querySelector('.field-label')?.textContent === label);
const range = (label) => field(label).querySelector('input[type=range]');
const tab = (name) => [...env.el.querySelectorAll('[role=tab]')].find((t) => t.textContent === name);

function drag(input, values) {
  for (const v of values) {
    input.value = String(v);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

function typeNumber(label, v) {
  const num = field(label).querySelector('.num-input');
  num.value = String(v);
  num.dispatchEvent(new Event('change', { bubbles: true }));
}

beforeEach(() => {
  env = setup();
});

afterEach(() => {
  env.insp.dispose();
  env.el.remove();
});

describe('inspector layout', () => {
  it('shows the project when nothing is selected and renames it', () => {
    expect(env.el.matches('section.panel.inspector')).toBe(true);
    expect(env.el.querySelector('.panel-head .panel-title').textContent).toBe('Details');
    const name = env.el.querySelector('.project-view input.input');
    name.value = 'My film';
    name.dispatchEvent(new Event('change'));
    expect(env.store.project.name).toBe('My film');
    env.store.undo();
    expect(name.value).toBe('Untitled project');
  });

  it('picks top tabs per clip type', () => {
    const p = env.store.project;
    expect(tabsFor(p, env.v1)).toEqual(['video', 'audio', 'speed', 'animation', 'clipfx', 'stylize', 'adjust']);
    expect(tabsFor(p, env.img)).toEqual(['video', 'animation', 'clipfx', 'stylize', 'adjust']);
    expect(tabsFor(p, env.aud)).toEqual(['audio', 'voice', 'speed']);
    expect(tabsFor(p, env.text)).toEqual(['text', 'animation', 'clipfx', 'speech']);
    env.store.select(env.v1.id);
    const names = [...env.el.querySelectorAll('.top-tabs [role=tab]')].map((t) => t.textContent);
    expect(names).toEqual(['Video', 'Audio', 'Speed', 'Animation', 'Effects', 'Style', 'Color']);
    const subs = [...env.el.querySelectorAll('.subtabs [role=tab]')].map((t) => t.textContent);
    expect(subs).toEqual(['Basic', 'Mask', 'Cutout', 'Remove', 'Retouch', 'Chroma key']);
    const panel = env.el.querySelector('[role=tabpanel]');
    expect(panel.getAttribute('aria-labelledby')).toBe(tab('Video').id);
    env.store.select(env.img.id);
    expect([...env.el.querySelectorAll('.top-tabs [role=tab]')].map((t) => t.textContent)).toEqual(['Image', 'Animation', 'Effects', 'Style', 'Color']);
  });

  it('remembers the tab per clip type', () => {
    env.store.select(env.v1.id);
    tab('Color').click();
    env.store.select(env.v2.id);
    expect(tab('Color').getAttribute('aria-selected')).toBe('true');
  });

  it('shows effect, filter and adjustment clips', () => {
    env.store.select(env.fx.id);
    const sel = field('Effect').querySelector('select');
    sel.value = 'glitch';
    sel.dispatchEvent(new Event('change'));
    expect(clip(env.fx.id).effect).toBe('glitch');
    drag(range('Strength'), [60, 70, 80]);
    expect(clip(env.fx.id).params.strength).toBe(80);
    env.store.select(env.filt.id);
    drag(range('Intensity'), [50, 40]);
    expect(clip(env.filt.id).intensity).toBe(40);
    env.store.select(env.adj.id);
    drag(range('Contrast'), [10, 30]);
    expect(clip(env.adj.id).adjust.contrast).toBe(30);
  });
});

describe('video basic', () => {
  beforeEach(() => env.store.select(env.v1.id));

  it('a scale drag is one undo step', () => {
    const before = env.store.history.undoStack.length;
    drag(range('Scale'), [110, 130, 150]);
    expect(clip(env.v1.id).transform.scale).toBeCloseTo(1.5);
    expect(env.store.history.undoStack.length).toBe(before + 1);
    env.store.undo();
    expect(clip(env.v1.id).transform.scale).toBe(1);
    expect(range('Scale').value).toBe('100');
  });

  it('two separate drags are two undo steps', () => {
    drag(range('Rotate'), [10, 20]);
    drag(range('Rotate'), [30, 45]);
    env.store.undo();
    expect(clip(env.v1.id).transform.rotation).toBe(20);
  });

  it('position is in pixels with Y up', () => {
    drag(range('Position X'), [192]);
    drag(range('Position Y'), [108]);
    expect(clip(env.v1.id).transform.x).toBeCloseTo(0.1);
    expect(clip(env.v1.id).transform.y).toBeCloseTo(-0.1);
  });

  it('flip, rotate 90, opacity, blend and reset', () => {
    env.el.querySelector('[aria-label="Flip horizontal"]').click();
    expect(clip(env.v1.id).transform.flipH).toBe(true);
    expect(env.el.querySelector('[aria-label="Flip horizontal"]').getAttribute('aria-pressed')).toBe('true');
    env.el.querySelector('[aria-label="Rotate 90 degrees clockwise"]').click();
    expect(clip(env.v1.id).transform.rotation).toBe(90);
    typeNumber('Opacity', 40);
    expect(clip(env.v1.id).opacity).toBeCloseTo(0.4);
    const mode = field('Mode').querySelector('select');
    mode.value = 'screen';
    mode.dispatchEvent(new Event('change'));
    expect(clip(env.v1.id).blend).toBe('screen');
    env.el.querySelector('[aria-label="Reset Transform"]').click();
    expect(clip(env.v1.id).transform).toMatchObject({ rotation: 0, flipH: false, scale: 1 });
  });

  it('crop keeps part of the picture', () => {
    drag(range('Left'), [60]);
    drag(range('Right'), [60]);
    const c = clip(env.v1.id).crop;
    expect(c.l).toBeCloseTo(0.6);
    expect(c.l + c.r).toBeLessThanOrEqual(0.95 + 1e-9);
  });

  it('keyframes: toggle, state, live values and prev/next', () => {
    const scaleField = field('Scale');
    const kf = scaleField.querySelector('.kf-btn');
    env.store.seek(1 * US);
    kf.click();
    expect(clip(env.v1.id).keyframes.scale).toHaveLength(1);
    expect(kf.getAttribute('aria-pressed')).toBe('true');
    env.store.seek(3 * US);
    expect(kf.getAttribute('aria-pressed')).toBe('false');
    expect(kf.classList.contains('has-keys')).toBe(true);
    // Editing with keys present adds a key at the playhead.
    drag(range('Scale'), [200]);
    expect(clip(env.v1.id).keyframes.scale).toHaveLength(2);
    expect(kf.getAttribute('aria-pressed')).toBe('true');
    // Values follow the playhead without rebuilding the DOM.
    const input = range('Scale');
    // A slider that only has focus still follows the playhead.
    input.focus();
    env.store.seek(2 * US);
    expect(range('Scale')).toBe(input);
    expect(Number(input.value)).toBe(150);
    scaleField.querySelector('[aria-label="Previous Scale keyframe"]').click();
    expect(env.store.time).toBe(1 * US);
    scaleField.querySelector('[aria-label="Next Scale keyframe"]').click();
    expect(env.store.time).toBe(3 * US);
  });

  it('applied filter shows intensity and can be removed', () => {
    expect(env.el.querySelector('.applied-filter-none').hidden).toBe(false);
    env.ctx.actions.addFilter('warm');
    expect(env.el.querySelector('.applied-filter-name').textContent).toBe('Warm');
    drag(range('Intensity'), [50]);
    expect(clip(env.v1.id).filter.intensity).toBe(50);
    env.el.querySelector('[aria-label="Remove filter"]').click();
    expect(clip(env.v1.id).filter).toBe(null);
  });

  it('undo and redo update controls in place', () => {
    drag(range('Rotate'), [33]);
    const input = range('Rotate');
    env.store.undo();
    expect(range('Rotate')).toBe(input);
    expect(input.value).toBe('0');
    env.store.redo();
    expect(input.value).toBe('33');
  });
});

describe('mask and chroma', () => {
  beforeEach(() => env.store.select(env.v1.id));

  it('adds, edits, keys, reorders and deletes masks', () => {
    tab('Mask').click();
    const tile = (id) => env.el.querySelector(`.mask-tile[data-shape=${id}]`);
    tile('ellipse').click();
    expect(clip(env.v1.id).masks).toHaveLength(1);
    // Round shapes start round on a 16:9 source.
    expect(clip(env.v1.id).masks[0]).toMatchObject({ type: 'ellipse', mode: 'add', h: 0.6 });
    expect(clip(env.v1.id).masks[0].w).toBeCloseTo(0.6 * (1080 / 1920));
    drag(range('Feather'), [20, 40]);
    expect(clip(env.v1.id).masks[0].feather).toBe(40);
    drag(range('Position X'), [25]);
    expect(clip(env.v1.id).masks[0].x).toBeCloseTo(0.25);
    field('Invert').querySelector('[role=switch]').click();
    expect(clip(env.v1.id).masks[0].invert).toBe(true);

    tile('rectangle').click();
    expect(clip(env.v1.id).masks.map((m) => m.type)).toEqual(['ellipse', 'rectangle']);
    const subtract = [...env.el.querySelectorAll('.mask-modes [role=radio]')].find((b) => b.textContent === 'Subtract');
    subtract.click();
    expect(clip(env.v1.id).masks[1].mode).toBe('subtract');
    drag(range('Round corners'), [30]);
    expect(clip(env.v1.id).masks[1].roundness).toBe(30);
    // Keyframe the rectangle's position, then move it to the top: its keys follow it.
    field('Position X').querySelector('.kf-btn').click();
    expect(clip(env.v1.id).keyframes['mask1.x']).toHaveLength(1);
    env.el.querySelector('[aria-label="Move up mask 2"]').click();
    expect(clip(env.v1.id).masks.map((m) => m.type)).toEqual(['rectangle', 'ellipse']);
    expect(clip(env.v1.id).keyframes['mask0.x']).toHaveLength(1);
    expect(clip(env.v1.id).keyframes['mask1.x']).toBeUndefined();

    env.el.querySelector('[aria-label="Delete mask 1"]').click();
    expect(clip(env.v1.id).masks.map((m) => m.type)).toEqual(['ellipse']);
    expect(clip(env.v1.id).keyframes['mask0.x']).toBeUndefined();
    env.store.undo();
    expect(clip(env.v1.id).masks).toHaveLength(2);
    env.el.querySelector('[aria-label="Delete mask 1"]').click();
    env.el.querySelector('[aria-label="Delete mask 1"]').click();
    expect(clip(env.v1.id).masks).toBeUndefined();
    expect(env.el.querySelector('.masks-tab .insp-empty').hidden).toBe(false);
  });

  it('limits masks and edits shape settings', () => {
    tab('Mask').click();
    for (const id of ['star', 'polygon', 'text', 'pen']) env.el.querySelector(`.mask-tile[data-shape=${id}]`).click();
    expect(clip(env.v1.id).masks.map((m) => m.type)).toEqual(['star', 'polygon', 'text', 'pen']);
    expect(env.el.querySelector('.mask-tile[data-shape=heart]').disabled).toBe(true);
    env.el.querySelector('[aria-label^="Mask 1,"]').click();
    drag(range('Points'), [7]);
    drag(range('Inner radius'), [30]);
    expect(clip(env.v1.id).masks[0]).toMatchObject({ count: 7, inner: 0.3 });
    env.el.querySelector('[aria-label^="Mask 3,"]').click();
    const text = env.el.querySelector('.mask-text-input');
    text.value = 'HELLO';
    text.dispatchEvent(new Event('input'));
    expect(clip(env.v1.id).masks[2].text).toBe('HELLO');
    const shape = field('Shape').querySelector('select');
    shape.value = 'heart';
    shape.dispatchEvent(new Event('change'));
    expect(clip(env.v1.id).masks[2]).toMatchObject({ type: 'heart', mode: 'add' });
    expect(clip(env.v1.id).masks[2].text).toBeUndefined();
  });

  it('turns chroma key on and tunes it', () => {
    tab('Chroma key').click();
    env.el.querySelector('[role=switch]').click();
    expect(clip(env.v1.id).chroma).toMatchObject({ color: '#00ff00', strength: 40 });
    drag(range('Strength'), [70]);
    expect(clip(env.v1.id).chroma.strength).toBe(70);
    env.el.querySelector('[role=switch]').click();
    expect(clip(env.v1.id).chroma).toBeUndefined();
    env.el.querySelector('[role=switch]').click();
    expect(clip(env.v1.id).chroma.strength).toBe(70);
  });
});

describe('audio and speed', () => {
  it('converts gain and dB', () => {
    expect(gainToDb(1)).toBe(0);
    expect(gainToDb(0)).toBe(-60);
    expect(dbToGain(-60)).toBe(0);
    expect(dbToGain(20)).toBeCloseTo(10);
    expect(posToSpeed(speedToPos(2))).toBe(2);
    expect(posToSpeed(0)).toBeCloseTo(0.1);
    expect(posToSpeed(300)).toBe(100);
  });

  it('volume, fades, mute and extract audio', () => {
    env.store.select(env.v1.id);
    tab('Audio').click();
    expect(range('Volume').value).toBe('0');
    drag(range('Volume'), [-3, -6]);
    expect(clip(env.v1.id).volume).toBeCloseTo(0.501, 2);
    drag(range('Fade in'), [1.5]);
    expect(clip(env.v1.id).fadeIn).toBe(1.5 * US);
    env.el.querySelector('[role=switch]').click();
    expect(clip(env.v1.id).muted).toBe(true);
    env.el.querySelector('[role=switch]').click();
    const extract = [...env.el.querySelectorAll('button')].find((b) => b.textContent === 'Detach audio');
    extract.click();
    expect(clip(env.v1.id).audioDetached).toBe(true);
    expect(extract.disabled).toBe(true);
    expect(T.allClips(env.store.project).filter((c) => c.type === 'audio')).toHaveLength(2);
  });

  it('speed slider changes duration in one undo step', () => {
    env.store.select(env.aud.id);
    tab('Speed').click();
    const r = env.el.querySelector('.speed-field input[type=range]');
    drag(r, [speedToPos(1.5), speedToPos(2)]);
    expect(clip(env.aud.id).speed).toBe(2);
    expect(clip(env.aud.id).duration).toBe(4 * US);
    expect(env.el.querySelector('.speed-dur').textContent).toBe('4.0s');
    env.store.undo();
    expect(clip(env.aud.id).speed).toBe(1);
    const preset = [...env.el.querySelectorAll('.chip')].find((b) => b.textContent === '0.5x');
    preset.click();
    expect(clip(env.aud.id).speed).toBe(0.5);
    expect(preset.getAttribute('aria-pressed')).toBe('true');
  });
});

describe('animation and color', () => {
  beforeEach(() => env.store.select(env.v1.id));

  it('applies, times and removes animations', () => {
    tab('Animation').click();
    const tiles = () => [...env.el.querySelectorAll('.anim-grid [role=radio]')];
    expect(tiles().some((t) => t.textContent === 'Typewriter')).toBe(false);
    tiles().find((t) => t.textContent === 'Fade in').click();
    expect(clip(env.v1.id).animIn).toMatchObject({ id: 'fade-in', duration: 500_000 });
    drag(range('Duration'), [1, 1.5]);
    expect(clip(env.v1.id).animIn.duration).toBe(1.5 * US);
    tiles().find((t) => t.textContent === 'None').click();
    expect(clip(env.v1.id).animIn).toBe(null);
    tab('Loop').click();
    tiles().find((t) => t.textContent === 'Pulse').click();
    expect(clip(env.v1.id).animLoop.id).toBe('pulse');
  });

  it('color sliders and reset all', () => {
    tab('Color').click();
    drag(range('Brightness'), [10, 25]);
    drag(range('Grain'), [30]);
    expect(clip(env.v1.id).adjust).toMatchObject({ brightness: 25, grain: 30 });
    expect(Number(range('Grain').min)).toBe(0);
    [...env.el.querySelectorAll('button')].find((b) => b.textContent === 'Reset all').click();
    expect(clip(env.v1.id).adjust.brightness).toBe(0);
    expect(range('Brightness').value).toBe('0');
  });
});

describe('text', () => {
  beforeEach(() => env.store.select(env.text.id));

  it('edits text with one undo step and keeps typing focus', () => {
    const ta = env.el.querySelector('.insp-textarea');
    expect(ta.value).toBe('Hello');
    ta.focus();
    for (const v of ['Hello w', 'Hello wo', 'Hello world']) {
      ta.value = v;
      ta.dispatchEvent(new Event('input'));
    }
    expect(clip(env.text.id).text).toBe('Hello world');
    expect(document.activeElement).toBe(ta);
    ta.dispatchEvent(new Event('change'));
    env.store.undo();
    expect(clip(env.text.id).text).toBe('Hello');
    ta.blur();
    env.store.redo();
    expect(ta.value).toBe('Hello world');
  });

  it('font picker, emphasis, presets and stroke', () => {
    const btn = env.el.querySelector('.font-button');
    btn.click();
    const list = env.el.querySelector('[role=listbox]');
    expect(list.hidden).toBe(false);
    [...list.querySelectorAll('[role=option]')].find((o) => o.textContent === 'Anton').click();
    expect(clip(env.text.id).style.font).toBe('Anton');
    expect(list.hidden).toBe(true);
    env.el.querySelector('[aria-label="Bold"]').click();
    expect(clip(env.text.id).style.bold).toBe(true);
    const stroke = env.el.querySelector('[aria-label="Show stroke"]');
    stroke.click();
    expect(clip(env.text.id).style.strokeWidth).toBe(4);
    stroke.click();
    expect(clip(env.text.id).style.strokeWidth).toBe(0);
    const neon = [...env.el.querySelectorAll('.preset-grid [role=radio]')].find((b) => b.textContent.includes('Neon'));
    neon.click();
    expect(clip(env.text.id).style.font).toBe('Pacifico');
    expect(clip(env.text.id).text).toBe('Hello');
    expect(neon.getAttribute('aria-checked')).toBe('true');
  });

  it('font picker works from the keyboard', () => {
    const btn = env.el.querySelector('.font-button');
    btn.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    const list = env.el.querySelector('[role=listbox]');
    expect(document.activeElement).toBe(list);
    list.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    list.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(clip(env.text.id).style.font).toBe('Poppins');
    expect(document.activeElement).toBe(btn);
  });

  it('focusText opens the Text tab and focuses the box', () => {
    tab('Animation').click();
    expect(env.ctx.inspector.focusText()).toBe(true);
    expect(document.activeElement.classList.contains('insp-textarea')).toBe(true);
    expect(tab('Text').getAttribute('aria-selected')).toBe('true');
  });

  it('text animations include typewriter', () => {
    tab('Animation').click();
    expect([...env.el.querySelectorAll('.anim-grid [role=radio]')].some((t) => t.textContent === 'Typewriter')).toBe(true);
  });
});

describe('transition and multi-selection', () => {
  it('edits the selected transition', () => {
    env.ctx.actions.applyTransition('mix', { clipId: env.v1.id });
    env.store.selectTransition(env.v1.id);
    expect(env.el.querySelector('.panel-title').textContent).toBe('Transition');
    expect(env.el.querySelector('.tr-name').textContent).toBe('Dissolve');
    const before = env.store.history.undoStack.length;
    drag(range('Duration'), [0.8, 1.2]);
    expect(clip(env.v1.id).transition.duration).toBe(1.2 * US);
    expect(env.store.history.undoStack.length).toBe(before + 1);
    [...env.el.querySelectorAll('.tr-grid [role=radio]')].find((b) => b.textContent === 'Blur').click();
    expect(clip(env.v1.id).transition).toMatchObject({ id: 'blur', duration: 1.2 * US });
    expect(env.el.querySelector('.tr-name').textContent).toBe('Blur');
    [...env.el.querySelectorAll('button')].find((b) => b.textContent === 'Remove').click();
    expect(clip(env.v1.id).transition).toBe(null);
    expect(env.el.querySelector('.project-view')).not.toBe(null);
  });

  it('shares opacity across selected clips', () => {
    env.store.select([env.v1.id, env.text.id]);
    expect(env.el.querySelector('.multi-count').textContent).toBe('2 clips selected');
    drag(range('Opacity'), [50]);
    expect(clip(env.v1.id).opacity).toBeCloseTo(0.5);
    expect(clip(env.text.id).opacity).toBeCloseTo(0.5);
    env.store.undo();
    expect(clip(env.v1.id).opacity).toBe(1);
  });
});

describe('video basic extras', () => {
  beforeEach(() => env.store.select(env.v1.id));

  it('switches to separate X and Y scale', () => {
    expect(field('Scale X').hidden).toBe(true);
    field('Uniform scale').querySelector('[role=switch]').click();
    expect(clip(env.v1.id).transform.uniform).toBe(false);
    expect(field('Scale X').hidden).toBe(false);
    drag(range('Scale X'), [150]);
    drag(range('Scale Y'), [80]);
    expect(clip(env.v1.id).transform).toMatchObject({ sx: 1.5, sy: 0.8 });
    field('Uniform scale').querySelector('[role=switch]').click();
    expect(clip(env.v1.id).transform.sx).toBeUndefined();
    expect(clip(env.v1.id).transform.uniform).toBeUndefined();
  });

  it('aligns the clip to the frame edges', () => {
    drag(range('Scale'), [50]);
    env.el.querySelector('[data-align=left]').click();
    expect(clip(env.v1.id).transform.x).toBeCloseTo(-0.25);
    env.el.querySelector('[data-align=bottom]').click();
    expect(clip(env.v1.id).transform.y).toBeCloseTo(0.25);
    env.el.querySelector('[data-align=hcenter]').click();
    expect(clip(env.v1.id).transform.x).toBe(0);
  });

  it('turns picture sections on and applies the canvas to all clips', () => {
    env.el.querySelector('[aria-label="Apply motion blur"]').click();
    expect(clip(env.v1.id).motionBlur).toEqual({ on: true, amount: 50 });
    env.el.querySelector('[aria-label="Apply motion blur"]').click();
    expect(clip(env.v1.id).motionBlur.on).toBe(false);
    env.el.querySelector('[aria-label="Apply relight"]').click();
    const relight = [...env.el.querySelectorAll('.extra-section')].find((x) => x.querySelector('.section-title').textContent === 'Relight');
    drag(field('Intensity', relight).querySelector('input[type=range]'), [80]);
    expect(clip(env.v1.id).relight).toMatchObject({ on: true, intensity: 80 });
    env.el.querySelector('[aria-label="Apply canvas"]').click();
    const grad = [...env.el.querySelectorAll('.extra-section [role=radio]')].find((b) => b.textContent === 'Gradient');
    grad.click();
    expect(clip(env.v1.id).canvas).toMatchObject({ on: true, type: 'gradient' });
    [...env.el.querySelectorAll('button')].find((b) => b.textContent === 'Apply to all').click();
    expect(clip(env.v2.id).canvas).toMatchObject({ on: true, type: 'gradient' });
    expect(clip(env.img.id).canvas).toMatchObject({ on: true, type: 'gradient' });
  });
});
