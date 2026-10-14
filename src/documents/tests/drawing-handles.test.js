import { describe, it, expect } from 'vitest';
import { resizeFromHandle, rotationUnits, pointerAngle, snapBox, pageGuideTargets, uncroppedRect, cropFromRects, dragCropRect, aspectRect, coverRect } from '../src/engine/drawing-handles.js';
import { resizeImageFrame } from '../src/engine/image-resize.js';

const frame = (rotation = 0) => ({ x: 100, y: 50, width: 96, height: 48, image: { width: 914400, height: 457200, rotation } });

describe('resizing from eight handles', () => {
  it('matches corner resizing and stretches one side from an edge', () => {
    const corner = resizeFromHandle(frame(), 'se', 12, 6, { preserveAspect: true });
    expect(corner).toEqual(resizeImageFrame(frame(), 'se', 12, 6, { preserveAspect: true }));
    const east = resizeFromHandle(frame(), 'e', 24, 30);
    expect(east.width).toBe(914400 + 24 * 9525); expect(east.height).toBe(457200);
    expect(east.frame.x).toBeCloseTo(100, 6); expect(east.frame.y).toBeCloseTo(50, 6);
    const north = resizeFromHandle(frame(), 'n', 5, -12);
    expect(north.width).toBe(914400); expect(north.frame.y).toBeCloseTo(38, 6); expect(north.frame.height).toBeCloseTo(60, 6);
    const west = resizeFromHandle(frame(), 'w', -10, 0, { preserveAspect: true });
    expect(west.height / west.width).toBeCloseTo(0.5, 4);
    expect(west.frame.x + west.frame.width).toBeCloseTo(196, 6);
    expect(west.frame.y + west.frame.height / 2).toBeCloseTo(74, 6);
  });
  it('resizes in a rotated drawing\'s own axes', () => {
    const turned = resizeFromHandle(frame(90 * 60000), 'e', 0, 20);
    expect(turned.width).toBe(914400 + 20 * 9525); expect(turned.height).toBe(457200);
  });
});

describe('rotation and guides', () => {
  it('measures clockwise from straight up and snaps', () => {
    expect(pointerAngle({ x: 0, y: 0 }, { x: 10, y: 0 })).toBeCloseTo(90, 6);
    expect(rotationUnits(37, 15)).toBe(30 * 60000);
    expect(rotationUnits(-10)).toBe(350 * 60000);
  });
  it('snaps the nearest edge or center and reports every guide it meets', () => {
    const targets = pageGuideTargets({ width: 816, height: 1056, left: 96, right: 96, top: 96, bottom: 96 }, [{ x: 300, y: 500, width: 100, height: 50 }]);
    const centered = snapBox({ x: 355, y: 200, width: 100, height: 40 }, targets, 6);
    expect(centered.dx).toBeCloseTo(3, 6);
    expect(centered.guides.map(g => g.kind)).toContain('center');
    const margin = snapBox({ x: 92, y: 497, width: 50, height: 20 }, targets, 6);
    expect(margin.dx).toBe(4); expect(margin.dy).toBe(3);
    expect(margin.guides.find(g => g.axis === 'y').kind).toBe('object');
    expect(snapBox({ x: 200, y: 200, width: 10, height: 10 }, targets, 6)).toEqual({ dx: 0, dy: 0, guides: [] });
  });
});

describe('crop rectangles', () => {
  it('round-trips the whole picture and srcRect offsets, with flips', () => {
    const shown = { x: 10, y: 20, width: 80, height: 50 }, crop = { left: 10000, right: 10000, top: 0, bottom: 50000 };
    const full = uncroppedRect(shown, crop);
    expect(full).toEqual({ x: 0, y: 20, width: 100, height: 100 });
    expect(cropFromRects(full, shown)).toEqual(crop);
    const flipped = uncroppedRect(shown, { left: 20000, right: 0, top: 0, bottom: 0 }, { flipH: true });
    expect(flipped.x).toBe(10);
    expect(cropFromRects(flipped, shown, { flipH: true })).toEqual({ left: 20000, right: 0, top: 0, bottom: 0 });
  });
  it('drags sides, keeps proportions, fits aspect ratios and fills or fits a frame', () => {
    const rect = { x: 0, y: 0, width: 100, height: 50 };
    expect(dragCropRect(rect, 'w', 30, 0)).toEqual({ x: 30, y: 0, width: 70, height: 50 });
    expect(dragCropRect(rect, 'e', -200, 0).width).toBe(4);
    const kept = dragCropRect(rect, 'se', -50, 0, { keepAspect: true });
    expect(kept.width / kept.height).toBeCloseTo(2, 6);
    expect(aspectRect(rect, 1)).toEqual({ x: 25, y: 0, width: 50, height: 50 });
    expect(coverRect({ x: 0, y: 0, width: 100, height: 100 }, { width: 200, height: 100 })).toEqual({ x: -50, y: 0, width: 200, height: 100 });
    expect(coverRect({ x: 0, y: 0, width: 100, height: 100 }, { width: 200, height: 100 }, true)).toEqual({ x: 0, y: 25, width: 100, height: 50 });
  });
});
