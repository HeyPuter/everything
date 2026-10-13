import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../src/media/segmenter.js', () => ({
  SEG_SIZE: 256,
  segment: () => null,
  ready: vi.fn(() => Promise.resolve(false)),
  segmenterState: () => 'idle',
  segmenterError: () => '',
  onSegmenterChange: () => () => {},
}));
vi.mock('../src/media/face-landmarks.js', () => ({
  MAX_FACES: 3,
  FACE_POINTS: 478,
  detectFaces: () => null,
  faceModelReady: vi.fn(() => Promise.resolve(false)),
  faceModelState: () => 'idle',
  faceModelError: () => '',
  onFaceModelChange: () => () => {},
}));
vi.mock('../src/media/pose-landmarks.js', () => ({
  MAX_POSES: 3,
  POSE_POINTS: 33,
  detectPoses: () => null,
  poseModelReady: vi.fn(() => Promise.resolve(false)),
  poseModelState: () => 'idle',
  poseModelError: () => '',
  onPoseModelChange: () => () => {},
}));
vi.mock('../src/media/hair-segmenter.js', () => ({
  HAIR_SIZE: 512,
  segmentHair: () => null,
  hairModelReady: vi.fn(() => Promise.resolve(false)),
  hairModelState: () => 'idle',
  hairModelError: () => '',
  onHairModelChange: () => () => {},
}));

import {
  RETOUCH_DEFAULT, LIP_COLOR_DEFAULT, normalizeRetouch, retouchAmounts, skinFixAmounts, normalizeFaceShape, faceShapeAmounts,
  normalizeHairColor, hairColorOn, faceModelsFor, HAIR_SWATCHES, LIP_SWATCHES, MAKEUP_PARTS, normalizeBodyShape, bodyShapeAmounts,
  normalizeMakeup, makeupAmounts,
} from '../src/model/retouch.js';
import { RETOUCH_LOOKS } from '../src/model/retouch-looks.js';
import { userLooks } from '../src/ui/retouch-looks.js';
import { setPref } from '../src/ui/prefs.js';
import { faceModelReady } from '../src/media/face-landmarks.js';
import { poseModelReady } from '../src/media/pose-landmarks.js';
import { hairModelReady } from '../src/media/hair-segmenter.js';
import { normalizeClip, makeClip, createProject } from '../src/model/project.js';
import { usesCutout, ensureCutout } from '../src/engine/cutout.js';
import { evaluate } from '../src/engine/scene.js';
import { LAYER_FS } from '../src/engine/shaders.js';
import { attributeGroupsFor, captureAttributes, applyAttributes } from '../src/ui/organize-actions.js';
import { EditorStore } from '../src/model/store.js';
import { createActions } from '../src/ui/actions.js';
import { createInspector } from '../src/ui/inspector/index.js';
import * as T from '../src/model/timeline.js';
import { US } from '../src/lib/time.js';

describe('retouch model', () => {
  it('normalizes values to 0..100', () => {
    expect(normalizeRetouch({ smooth: 140, even: -3, brighten: '20', sharpen: null })).toEqual({ smooth: 100, even: 0, brighten: 20, sharpen: 0 });
    const v = normalizeClip({ ...makeClip('video', { assetId: 'a', duration: US }), retouch: { smooth: 30 } });
    expect(v.retouch).toEqual({ smooth: 30, even: 0, brighten: 0, sharpen: 0 });
  });

  it('only turns the shader on when something is set', () => {
    expect(retouchAmounts(null)).toBeNull();
    expect(retouchAmounts({ smooth: 0, even: 0, brighten: 0, sharpen: 0 })).toBeNull();
    expect(retouchAmounts(RETOUCH_DEFAULT)).toEqual([0.4, 0.2, 0.1, 0]);
  });

  it('needs the person matte, reaches the layer, and is its own attribute group', () => {
    const p = createProject();
    p.assets.a = { id: 'a', kind: 'video', name: 'v.mp4', duration: 5 * US, width: 640, height: 360, fps: 30, hasVideo: true };
    const c = makeClip('video', { assetId: 'a', duration: 2 * US });
    T.mainTrack(p).clips.push(c);
    c.retouch = { smooth: 0, even: 0, brighten: 0, sharpen: 0 };
    expect(usesCutout(p)).toBe(false);
    c.retouch.smooth = 50;
    expect(usesCutout(p)).toBe(true);
    expect(evaluate(p, US / 2).find((l) => l.clip?.id === c.id).retouch).toEqual(c.retouch);
    expect(attributeGroupsFor(c).map((g) => g.id)).toContain('retouch');
    expect(LAYER_FS).toMatch(/if \(u_retouchOn == 1\) c\.rgb = retouch\(uv, c\.rgb\)/);
  });

  it('keeps skin fixes only when set, with a lip color once lips are tinted', () => {
    expect(normalizeRetouch({ smooth: 10, blemishes: 30, darkCircles: 0, teeth: 120, lips: -5 })).toEqual({ smooth: 10, even: 0, brighten: 0, sharpen: 0, blemishes: 30, teeth: 100 });
    expect(normalizeRetouch({ lips: 40 })).toMatchObject({ lips: 40, lipColor: LIP_COLOR_DEFAULT });
    expect(normalizeRetouch({ lips: 40, lipColor: '#AA0011' }).lipColor).toBe('#aa0011');
    // A picked shade survives turning the tint down to nothing; junk does not.
    expect(normalizeRetouch({ lips: 0, lipColor: '#123456' })).toMatchObject({ lipColor: '#123456' });
    expect(normalizeRetouch({ lipColor: 'red' }).lipColor).toBeUndefined();
    expect(skinFixAmounts({ smooth: 50 })).toBeNull();
    expect(skinFixAmounts({ blemishes: 50, lips: 100 })).toEqual([0.5, 0, 0, 1]);
    // Skin fixes alone do not need the person matte.
    expect(retouchAmounts({ smooth: 0, even: 0, brighten: 0, sharpen: 0, teeth: 40 })).toBeNull();
  });

  it('normalizes face shape and hair color', () => {
    expect(normalizeFaceShape({ slim: 150, eyes: -30, nose: 'x', smile: '12', faces: 'everyone' })).toEqual({ slim: 100, eyes: -30, nose: 0, smile: 12, chin: 0, faces: 'all' });
    expect(normalizeFaceShape({ chin: -200, faces: 'largest' })).toEqual({ slim: 0, eyes: 0, nose: 0, smile: 0, chin: -100, faces: 'largest' });
    expect(faceShapeAmounts(normalizeFaceShape({}))).toBeNull();
    expect(faceShapeAmounts({ slim: 50, eyes: -100 })).toEqual({ slim: 0.5, eyes: -1, nose: 0, smile: 0, chin: 0 });
    expect(normalizeHairColor({ color: '#ABCDEF', strength: 140 })).toEqual({ color: '#abcdef', strength: 100 });
    expect(normalizeHairColor({ color: 'blue' }).strength).toBe(0);
    expect(hairColorOn({ color: '#abcdef', strength: 0 })).toBe(false);
    expect(hairColorOn({ color: '#abcdef', strength: 5 })).toBe(true);
    expect(HAIR_SWATCHES.every((s) => /^#[0-9a-f]{6}$/.test(s.color) && s.label)).toBe(true);
    const v = normalizeClip({ ...makeClip('video', { assetId: 'a', duration: US }), faceShape: { eyes: 20 }, hairColor: { color: '#112233', strength: 50 } });
    expect(v.faceShape).toEqual({ slim: 0, eyes: 20, nose: 0, smile: 0, chin: 0, faces: 'all' });
    expect(v.hairColor).toEqual({ color: '#112233', strength: 50 });
  });

  it('asks for the face model for face tools and hair, and the hair model for hair', () => {
    expect(faceModelsFor({ retouch: { smooth: 40 } })).toEqual({ face: false, hair: false, pose: false });
    expect(faceModelsFor({ retouch: { teeth: 40 } })).toEqual({ face: true, hair: false, pose: false });
    expect(faceModelsFor({ faceShape: { slim: -10 } })).toEqual({ face: true, hair: false, pose: false });
    expect(faceModelsFor({ hairColor: { color: '#112233', strength: 50 } })).toEqual({ face: true, hair: true, pose: false });
    expect(faceModelsFor({ makeup: { blush: 20 } })).toEqual({ face: true, hair: false, pose: false });
    expect(faceModelsFor({ makeup: { blushColor: '#aa3344' } })).toEqual({ face: false, hair: false, pose: false });
    expect(faceModelsFor({ bodyShape: { waist: 20 } })).toEqual({ face: false, hair: false, pose: true });
    expect(faceModelsFor({ disabled: true, faceShape: { slim: 10 } })).toEqual({ face: false, hair: false, pose: false });
  });

  it('reaches the layer, tells the exporter to load the models, and is pasted with the retouch group', async () => {
    const p = createProject();
    p.assets.a = { id: 'a', kind: 'video', name: 'v.mp4', duration: 5 * US, width: 640, height: 360, fps: 30, hasVideo: true };
    const c = makeClip('video', { assetId: 'a', duration: 2 * US });
    const d = makeClip('video', { assetId: 'a', duration: 2 * US, start: 2 * US });
    T.mainTrack(p).clips.push(c, d);
    expect(usesCutout(p)).toBe(false);
    c.faceShape = normalizeFaceShape({ slim: 30 });
    expect(usesCutout(p)).toBe(true);
    c.hairColor = { color: '#5e3424', strength: 70 };
    const layer = evaluate(p, US / 2).find((l) => l.clip?.id === c.id);
    expect(layer.faceShape).toEqual(c.faceShape);
    expect(layer.hairColor).toEqual(c.hairColor);
    faceModelReady.mockClear();
    hairModelReady.mockClear();
    expect(await ensureCutout(p)).toBe(false);
    expect(faceModelReady).toHaveBeenCalled();
    expect(hairModelReady).toHaveBeenCalled();
    const got = captureAttributes(c);
    expect(Object.keys(got.groups.retouch.values)).toEqual(['faceShape', 'hairColor']);
    applyAttributes(d, got, ['retouch'], c.duration);
    expect(d.faceShape).toEqual(c.faceShape);
    expect(d.hairColor).toEqual(c.hairColor);
    expect(LAYER_FS).toMatch(/vec2 uv = warped\(v_uv\);/);
    expect(LAYER_FS).toMatch(/return u_warpFaces > 0 \? warpUv\(uv\) : uv;/);
    expect(LAYER_FS).toMatch(/if \(u_faceFixOn == 1\) c\.rgb = faceFix\(uv, c\.rgb\)/);
    expect(LAYER_FS).toMatch(/if \(u_hairOn == 1\) c\.rgb = hairRecolor\(uv, c\.rgb\)/);
  });
});


describe('body shape and makeup model', () => {
  it('normalizes body shape (legs only lengthen) and its warp amounts', () => {
    expect(normalizeBodyShape({ slim: 150, waist: '-30', legs: -40, head: 'x', shoulders: 20, arms: -200, people: 'crowd' }))
      .toEqual({ slim: 100, waist: -30, legs: 0, head: 0, shoulders: 20, arms: -100, people: 'all' });
    expect(normalizeBodyShape({ people: 'largest' }).people).toBe('largest');
    expect(bodyShapeAmounts(normalizeBodyShape({}))).toBeNull();
    expect(bodyShapeAmounts({ legs: 50, head: -100 })).toEqual({ slim: 0, waist: 0, legs: 0.5, head: -1, shoulders: 0, arms: 0 });
    expect(bodyShapeAmounts({ legs: -50 })).toBeNull();
  });

  it('keeps makeup parts only when set, with a color once set or picked', () => {
    expect(normalizeMakeup({ blush: 140, eyeliner: 0, brows: -5, eyeshadowColor: '#ABCDEF', contourColor: 'brown', junk: 4 }))
      .toEqual({ blush: 100, blushColor: MAKEUP_PARTS.find((p) => p.key === 'blush').color, eyeshadowColor: '#abcdef' });
    expect(makeupAmounts({ eyeshadowColor: '#abcdef' })).toBeNull();
    const m = makeupAmounts({ blush: 50, highlight: 100, highlightColor: '#ffeedd' });
    // Shader order: blush, eyeshadow, eyeliner, brows, contour, highlight.
    expect(m.amounts).toEqual([0.5, 0, 0, 0, 0, 1]);
    expect(m.colors[5]).toBe('#ffeedd');
    expect(m.colors).toHaveLength(6);
    for (const p of MAKEUP_PARTS) {
      expect(p.swatches.length).toBeGreaterThan(3);
      expect(p.swatches.every((s) => /^#[0-9a-f]{6}$/.test(s.color) && s.label)).toBe(true);
    }
    expect(LIP_SWATCHES.every((s) => /^#[0-9a-f]{6}$/.test(s.color))).toBe(true);
  });

  it('is kept by project files, reaches the layer, loads the pose model for export and is pasted with retouch', async () => {
    const v = normalizeClip({ ...makeClip('video', { assetId: 'a', duration: US }), bodyShape: { legs: 30 }, makeup: { blush: 20 } });
    expect(v.bodyShape).toEqual({ slim: 0, waist: 0, legs: 30, head: 0, shoulders: 0, arms: 0, people: 'all' });
    expect(v.makeup).toEqual({ blush: 20, blushColor: MAKEUP_PARTS.find((p) => p.key === 'blush').color });
    const p = createProject();
    p.assets.a = { id: 'a', kind: 'video', name: 'v.mp4', duration: 5 * US, width: 640, height: 360, fps: 30, hasVideo: true };
    const c = makeClip('video', { assetId: 'a', duration: 2 * US });
    const d = makeClip('video', { assetId: 'a', duration: 2 * US, start: 2 * US });
    T.mainTrack(p).clips.push(c, d);
    c.bodyShape = normalizeBodyShape({ waist: 25 });
    expect(usesCutout(p)).toBe(true);
    c.makeup = normalizeMakeup({ eyeliner: 60 });
    const layer = evaluate(p, US / 2).find((l) => l.clip?.id === c.id);
    expect(layer.bodyShape).toEqual(c.bodyShape);
    expect(layer.makeup).toEqual(c.makeup);
    poseModelReady.mockClear();
    faceModelReady.mockClear();
    expect(await ensureCutout(p)).toBe(false);
    expect(poseModelReady).toHaveBeenCalled();
    expect(faceModelReady).toHaveBeenCalled();
    applyAttributes(d, captureAttributes(c), ['retouch'], c.duration);
    expect(d.bodyShape).toEqual(c.bodyShape);
    expect(d.makeup).toEqual(c.makeup);
    expect(LAYER_FS).toMatch(/if \(u_bodyOn == 1\) uv = pxUv\(bodyWarpPx\(srcPx\(uv\)\)\);/);
    expect(LAYER_FS).toMatch(/if \(u_makeupOn == 1\) c\.rgb = makeup\(uv, c\.rgb\);/);
  });
});

describe('retouch panel', () => {
  let env;
  beforeEach(() => {
    HTMLCanvasElement.prototype.getContext = () => null;
    setPref('retouchLooks', []);
    const p = createProject();
    p.assets.a = { id: 'a', kind: 'image', name: 'p.jpg', duration: 0, width: 800, height: 1000, fps: 0, hasVideo: false, hasAudio: false };
    const c = makeClip('image', { assetId: 'a', duration: 2 * US });
    T.mainTrack(p).clips.push(c);
    const store = new EditorStore(p);
    const ctx = { store };
    ctx.actions = createActions(ctx);
    const insp = createInspector(ctx);
    document.body.append(insp.el);
    store.select(c.id);
    insp.showVideoSub('retouch');
    env = { store, el: insp.el, id: c.id };
    segment('Face');
  });
  afterEach(() => {
    env.el.remove();
    document.querySelectorAll('dialog').forEach((d) => d.remove());
  });
  const clip = () => T.findClip(env.store.project, env.id).clip;
  const field = (label) => [...env.el.querySelectorAll('.field')].find((f) => f.querySelector('.field-label')?.textContent === label);
  const drag = (label, v) => {
    const input = field(label).querySelector('input[type=range]');
    input.value = String(v);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const tabs = () => [...env.el.querySelectorAll('.retouch-segs [role=tab]')];
  function segment(name) {
    tabs().find((t) => t.textContent.startsWith(name)).click();
  }
  const titles = () => [...env.el.querySelectorAll('.section-title')].map((t) => t.textContent);
  const button = (text) => [...env.el.querySelectorAll('button')].find((b) => b.textContent === text);

  it('shows Face, Body, Makeup, Hair and Looks segments, each with its own sections', () => {
    expect(tabs().map((t) => t.textContent.trim())).toEqual(['Face', 'Body', 'Makeup', 'Hair', 'Looks']);
    expect(titles()).toEqual(['Skin', 'Face shape']);
    segment('Body');
    expect(tabs()[1].getAttribute('aria-selected')).toBe('true');
    expect(titles()).toEqual(['Body shape']);
    segment('Makeup');
    expect(titles()).toEqual(['Lips', 'Eyes', 'Cheeks']);
    segment('Hair');
    expect(titles()).toEqual(['Hair']);
    segment('Looks');
    expect(titles()).toEqual(['Looks', 'Your looks']);
  });

  it('edits one skin slider, resets, and marks the segment in use', () => {
    const dot = tabs()[0].querySelector('.retouch-seg-dot');
    expect(dot.hidden).toBe(true);
    drag('Sharpen', 35);
    expect(clip().retouch.sharpen).toBe(35);
    expect(dot.hidden).toBe(false);
    expect(tabs()[0].textContent).toContain('(in use)');
    env.el.querySelector('[aria-label="Reset Skin"]').click();
    expect(clip().retouch).toBeUndefined();
    expect(dot.hidden).toBe(true);
    env.store.undo();
    expect(clip().retouch.sharpen).toBe(35);
  });

  it('sets skin fixes; resetting skin keeps the lip color', () => {
    faceModelReady.mockClear();
    drag('Blemishes', 60);
    expect(clip().retouch).toMatchObject({ blemishes: 60 });
    expect(faceModelReady).toHaveBeenCalled();
    segment('Makeup');
    const hex = field('Lip shade').querySelector('.hex-input');
    hex.value = '#7a2f4a';
    hex.dispatchEvent(new Event('change', { bubbles: true }));
    expect(clip().retouch).toMatchObject({ blemishes: 60, lips: 50, lipColor: '#7a2f4a' });
    segment('Face');
    env.el.querySelector('[aria-label="Reset Skin"]').click();
    expect(clip().retouch).toMatchObject({ lips: 50, lipColor: '#7a2f4a' });
    expect(clip().retouch.blemishes).toBeUndefined();
  });

  it('reshapes faces, picks which faces, and resets', () => {
    drag('Slimmer face', -40);
    expect(clip().faceShape).toEqual({ slim: -40, eyes: 0, nose: 0, smile: 0, chin: 0, faces: 'all' });
    [...env.el.querySelectorAll('[role=radio]')].find((b) => b.textContent === 'Largest face').click();
    expect(clip().faceShape.faces).toBe('largest');
    drag('Eye size', 25);
    expect(clip().faceShape).toMatchObject({ slim: -40, eyes: 25, faces: 'largest' });
    env.el.querySelector('[aria-label="Reset Face shape"]').click();
    expect(clip().faceShape).toBeUndefined();
    env.store.undo();
    expect(clip().faceShape.eyes).toBe(25);
  });

  it('reshapes the body, loading the pose model, picks which people, and resets', () => {
    segment('Body');
    poseModelReady.mockClear();
    drag('Slimmer waist', 30);
    expect(clip().bodyShape).toEqual({ slim: 0, waist: 30, legs: 0, head: 0, shoulders: 0, arms: 0, people: 'all' });
    expect(poseModelReady).toHaveBeenCalled();
    expect(field('Longer legs').querySelector('input[type=range]').min).toBe('0');
    drag('Shoulder width', -20);
    drag('Longer legs', 45);
    [...env.el.querySelectorAll('[role=radio]')].find((b) => b.textContent === 'Largest person').click();
    expect(clip().bodyShape).toMatchObject({ waist: 30, shoulders: -20, legs: 45, people: 'largest' });
    expect(tabs()[1].querySelector('.retouch-seg-dot').hidden).toBe(false);
    env.el.querySelector('[aria-label="Reset Body shape"]').click();
    expect(clip().bodyShape).toBeUndefined();
    env.store.undo();
    expect(clip().bodyShape.legs).toBe(45);
  });

  it('applies makeup: a shade starts at a medium amount, sliders set amounts, and each group resets on its own', () => {
    segment('Makeup');
    faceModelReady.mockClear();
    const plum = MAKEUP_PARTS.find((p) => p.key === 'eyeshadow').swatches[2];
    const sw = env.el.querySelector(`[aria-label="Eyeshadow shades"] [aria-label="${plum.label}"]`);
    sw.click();
    expect(clip().makeup).toEqual({ eyeshadow: 50, eyeshadowColor: plum.color });
    expect(sw.getAttribute('aria-checked')).toBe('true');
    expect(faceModelReady).toHaveBeenCalled();
    drag('Blush', 35);
    drag('Eyeliner', 70);
    const custom = env.el.querySelector('[aria-label="Highlight custom color"]');
    custom.value = '#ffe0c0';
    custom.dispatchEvent(new Event('change', { bubbles: true }));
    expect(clip().makeup).toMatchObject({ eyeshadow: 50, blush: 35, eyeliner: 70, highlight: 50, highlightColor: '#ffe0c0' });
    env.el.querySelector('[aria-label="Reset Eyes"]').click();
    expect(clip().makeup).toEqual({ blush: 35, blushColor: MAKEUP_PARTS.find((p) => p.key === 'blush').color, highlight: 50, highlightColor: '#ffe0c0' });
    env.el.querySelector('[aria-label="Reset Cheeks"]').click();
    expect(clip().makeup).toBeUndefined();
  });

  it('tints lips from the makeup segment with a shade swatch', () => {
    segment('Makeup');
    env.el.querySelector(`[aria-label="Lip color shades"] [aria-label="${LIP_SWATCHES[2].label}"]`).click();
    expect(clip().retouch).toMatchObject({ lips: 50, lipColor: LIP_SWATCHES[2].color });
    drag('Lip color', 80);
    expect(clip().retouch.lips).toBe(80);
    env.el.querySelector('[aria-label="Reset Lips"]').click();
    expect(clip().retouch).toBeUndefined();
  });

  it('picks a hair swatch at a medium strength, edits the strength, and resets', () => {
    segment('Hair');
    hairModelReady.mockClear();
    const sw = env.el.querySelector(`[aria-label="${HAIR_SWATCHES[1].label}"]`);
    sw.click();
    expect(clip().hairColor).toEqual({ color: HAIR_SWATCHES[1].color, strength: 60 });
    expect(sw.getAttribute('aria-checked')).toBe('true');
    expect(hairModelReady).toHaveBeenCalled();
    drag('Strength', 85);
    expect(clip().hairColor.strength).toBe(85);
    env.el.querySelector('[aria-label="Reset Hair"]').click();
    expect(clip().hairColor).toBeUndefined();
  });

  it('applies a look in one click (one undo step), checks its tile, and None clears it', () => {
    segment('Looks');
    poseModelReady.mockClear();
    const tile = (label) => [...env.el.querySelectorAll('.look-grid .choice')].find((b) => b.textContent === label);
    expect(tile('None').getAttribute('aria-checked')).toBe('true');
    tile('Athletic').click();
    expect(clip().bodyShape).toMatchObject({ shoulders: 35, waist: 30 });
    expect(clip().retouch.sharpen).toBe(25);
    expect(poseModelReady).toHaveBeenCalled();
    expect(tile('Athletic').getAttribute('aria-checked')).toBe('true');
    tile('Soft glam').click();
    expect(clip().bodyShape).toBeUndefined();
    expect(clip().makeup.eyeshadow).toBe(40);
    expect(tile('Soft glam').getAttribute('aria-checked')).toBe('true');
    env.store.undo();
    expect(clip().bodyShape.shoulders).toBe(35);
    tile('None').click();
    expect(clip().retouch).toBeUndefined();
    expect(clip().makeup).toBeUndefined();
    expect(RETOUCH_LOOKS.map((l) => l.label)).toEqual(expect.arrayContaining(['Natural', 'Fresh', 'Soft glam', 'Sculpted', 'Athletic']));
  });

  it('saves the clip as a look, applies, renames and deletes it', async () => {
    segment('Looks');
    const save = button('Save as look');
    expect(save.disabled).toBe(true);
    segment('Body');
    drag('Slimmer arms', 40);
    segment('Looks');
    button('Save as look').click();
    const dialog = document.querySelector('dialog');
    dialog.querySelector('input').value = 'Gym day';
    dialog.querySelector('button.btn.primary').click();
    await vi.waitFor(() => expect(userLooks().map((l) => l.name)).toEqual(['Gym day']));
    await vi.waitFor(() => expect(env.el.querySelector('.look-apply')?.textContent).toBe('Gym day'));
    expect(env.el.querySelector('.look-apply').getAttribute('aria-pressed')).toBe('true');
    [...env.el.querySelectorAll('.look-grid .choice')].find((b) => b.textContent === 'None').click();
    expect(clip().bodyShape).toBeUndefined();
    expect(env.el.querySelector('.look-apply').getAttribute('aria-pressed')).toBe('false');
    env.el.querySelector('.look-apply').click();
    expect(clip().bodyShape.arms).toBe(40);
    env.el.querySelector('[aria-label="Rename Gym day"]').click();
    const rename = document.querySelector('dialog[open]') || [...document.querySelectorAll('dialog')].pop();
    rename.querySelector('input').value = 'Leg day';
    rename.querySelector('button.btn.primary').click();
    await vi.waitFor(() => expect(env.el.querySelector('.look-apply')?.textContent).toBe('Leg day'));
    env.el.querySelector('[aria-label="Delete Leg day"]').click();
    const confirm = [...document.querySelectorAll('dialog')].pop();
    [...confirm.querySelectorAll('button')].find((b) => b.textContent === 'Delete').click();
    await vi.waitFor(() => expect(userLooks()).toEqual([]));
    await vi.waitFor(() => expect(env.el.querySelector('.look-apply')).toBeNull());
  });
});
