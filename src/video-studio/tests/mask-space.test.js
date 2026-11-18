import { describe, it, expect, vi } from 'vitest';
import { composeMaskCrop, normalizeMaskSpace, retainMaskSpace, maskLayer, defaultMaskInSpace } from '../src/model/mask-space.js';
import { defaultMask, addMask, removeMask } from '../src/model/masks.js';
import { makeClip, normalizeClip } from '../src/model/project.js';
import { captureAttributes, applyAttributes } from '../src/ui/organize-actions.js';
import { bindLayerMask } from '../src/engine/layer-extras.js';
import { Compositor } from '../src/engine/compositor.js';
import { sourceToProject, projectToSource } from '../src/engine/mask-shapes.js';

const crop = { l: 0.1, r: 0.2, t: 0.05, b: 0.15 };
const space = { width: 800, height: 600, crop };
const zero = { l: 0, r: 0, t: 0, b: 0 };

describe('retained mask source coordinates', () => {
  it('composes successive crops without rewriting masks and reuses results idempotently', () => {
    const c = makeClip('image', { masks: [defaultMask('brush')], keyframes: { 'mask0.w': [{ t: 0, v: 20 }] } });
    const original = structuredClone(c);
    retainMaskSpace(c, { width: 800, height: 600 }, crop);
    const source = { width: 560, height: 480, maskSpace: structuredClone(c.maskSpace) };
    const next = { l: 0.2, r: 0, t: 0, b: 0.1 };
    retainMaskSpace(c, source, next);
    const expected = { width: 800, height: 600, crop: composeMaskCrop(crop, next) };
    expect(c.maskSpace).toEqual(expected);
    retainMaskSpace(c, source, next);
    expect(c.maskSpace).toEqual(expected);
    expect(c.masks).toEqual(original.masks);
    expect(c.keyframes).toEqual(original.keyframes);
    expect(normalizeClip(c).maskSpace).toEqual(expected);
  });

  it('rejects invalid saved frames and drops frames with no masks', () => {
    for (const raw of [null, { ...space, width: Infinity }, { ...space, height: 0 }, { ...space, crop: { ...crop, l: 0.9 } }, { ...space, crop: { ...crop, t: NaN } }]) expect(normalizeMaskSpace(raw)).toBeNull();
    expect(normalizeMaskSpace(space)).toEqual(space);
    expect(normalizeMaskSpace(space).crop).not.toBe(crop);
    expect(normalizeClip(makeClip('image', { maskSpace: space })).maskSpace).toBeUndefined();
  });

  it('preserves project-space geometry and inverse pointer mapping through crop and reflections', () => {
    const original = { kind: 'media', width: 800, height: 600, crop, x: 0.1, y: -0.2, scale: 0.8, sx: 0.7, sy: 1.3, rotation: 37, flipH: true };
    const replacement = { ...original, width: 560, height: 480, crop: zero, maskSpace: space };
    const box = layer => Compositor.prototype.layerBox.call({ projW: 1080, projH: 1920 }, layer);
    const frame = maskLayer(replacement);
    for (const point of [[80, 30], [640, 510], [400, 300], [0, 600]]) {
      const before = sourceToProject(original, box(original), 800, 600, ...point);
      const after = sourceToProject(frame, box(replacement), frame.width, frame.height, ...point);
      after.forEach((v, i) => expect(v).toBeCloseTo(before[i], 9));
      projectToSource(frame, box(replacement), frame.width, frame.height, ...after).forEach((v, i) => expect(v).toBeCloseTo(point[i], 9));
    }
  });

  it('rasterizes in the original frame and resets texture mapping for ordinary layers', () => {
    const comp = { gl: { TEXTURE0: 0, activeTexture: vi.fn() }, width: 100, projW: 100, _set: vi.fn(), _seti: vi.fn(), _texture: vi.fn(() => ({})), _maskRaster: { get: vi.fn(() => ({ canvas: {}, key: 'a', width: 800, height: 600 })) } };
    const layer = { kind: 'media', clip: { id: 'a' }, masks: [defaultMask('ellipse')], maskSpace: space, width: 560, height: 480, crop: zero };
    bindLayerMask(comp, {}, layer, { w: 56, h: 48 });
    expect(comp._maskRaster.get.mock.lastCall.slice(2, 4)).toEqual([800, 600]);
    expect(comp._set.mock.lastCall[1]).toBe('u_maskRect');
    comp._set.mock.lastCall[2].forEach((v, i) => expect(v).toBeCloseTo([0.1, 0.15, 0.7, 0.8][i]));
    bindLayerMask(comp, {}, { ...layer, maskSpace: null }, { w: 56, h: 48 });
    expect(comp._set.mock.lastCall[2]).toEqual([0, 0, 1, 1]);
  });

  it('copies mask coordinates with presets and removes stale frames when pasting ordinary masks', () => {
    const source = makeClip('image', { masks: [defaultMask('ellipse')], maskSpace: space });
    const target = makeClip('image');
    applyAttributes(target, captureAttributes(source), ['mask'], source.duration);
    expect(target.maskSpace).toEqual(space);
    expect(target.maskSpace).not.toBe(space);
    delete source.maskSpace;
    applyAttributes(target, captureAttributes(source), ['mask'], source.duration);
    expect(target.maskSpace).toBeUndefined();
  });

  it('starts new masks in the visible source window and releases the frame after the last removal', () => {
    const mask = defaultMaskInSpace(defaultMask('ellipse', 560 / 480), space);
    expect((mask.x + 0.5 - crop.l) / 0.7).toBeCloseTo(0.5);
    expect((mask.y + 0.5 - crop.t) / 0.8).toBeCloseTo(0.5);
    expect(mask.w * 800).toBeCloseTo(mask.h * 600);
    const c = makeClip('image', { masks: [mask], maskSpace: space });
    removeMask(c, 0);
    expect(c.maskSpace).toBeUndefined();
    c.maskSpace = space;
    addMask(c, defaultMask('rectangle'));
    expect(c.maskSpace).toBeUndefined();
  });
});
