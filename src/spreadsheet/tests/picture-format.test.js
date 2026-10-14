import { describe, expect, it } from 'vitest';
import * as X from '../src/vendor/xlsx.mjs';
import { Workbook } from '../src/core/workbook.js';
import { workbookFromFile, workbookToXlsx } from '../src/core/io.js';
import { normalizeChart } from '../src/core/charts.js';
import {
  CROP_MIN, PICTURE_STYLES, RESET_PICTURE, applyPictureFilter, aspectCrop, clampCrop, cropOf, cropPatch, dragCrop, normalizePictureFormat,
  pictureFrameCss, pictureIsPlain, pictureStyleOf, resetPictureAndSize, sizePatch, toneCurve, uncroppedSize,
} from '../src/core/picture-format.js';
import { pictureFormatXml } from '../src/core/xlsx-export-drawings.js';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const close = (a, b) => expect(a).toBeCloseTo(b, 6);
const picture = (extra = {}) => ({ type: 'image', src: PNG, anchor: { r: 1, c: 1 }, dx: 10, dy: 20, w: 200, h: 100, ...extra });

describe('crop', () => {
  it('reads the crop as the part of the source kept, and the size the whole picture is shown at', () => {
    const obj = picture({ srcRect: { l: 0.25, r: 0.25, t: 0.1, b: 0.4 } });
    expect(cropOf(obj)).toEqual({ x: 0.25, y: 0.1, w: 0.5, h: 0.5 });
    expect(uncroppedSize(obj)).toEqual({ w: 400, h: 200 });
    expect(cropOf(picture())).toEqual({ x: 0, y: 0, w: 1, h: 1 });
  });

  it('cuts sides away keeping the scale and the place of what is left', () => {
    const patch = cropPatch(picture(), { x: 0.25, y: 0, w: 0.5, h: 0.5 });
    expect(patch.srcRect).toEqual({ l: 0.25, r: 0.25, b: 0.5 });
    expect(patch).toMatchObject({ w: 100, h: 50, dx: 60, dy: 20 });
    // Cropping the cropped picture again starts from the whole picture, not the part shown.
    const twice = cropPatch(picture(patch), { x: 0, y: 0, w: 1, h: 1 });
    expect(twice).toMatchObject({ srcRect: null, w: 200, h: 100, dx: 10, dy: 20 });
  });

  it('keeps the frame within the picture and no smaller than the minimum', () => {
    expect(clampCrop({ x: -0.2, y: 0.9, w: 0.5, h: 0.5 })).toEqual({ x: 0, y: 0.5, w: 0.5, h: 0.5 });
    expect(clampCrop({ x: 0, y: 0, w: 0, h: 2 }).w).toBe(CROP_MIN);
  });

  it('fits the largest frame of an aspect ratio about the centre of the crop', () => {
    const square = aspectCrop(picture(), 1);
    close(square.w, 0.5); close(square.h, 1); close(square.x, 0.25); close(square.y, 0);
    const wide = aspectCrop(picture({ w: 100, h: 100 }), 16 / 9);
    close(wide.w, 1); close(wide.h, 9 / 16); close(wide.y, (1 - 9 / 16) / 2);
    const patch = cropPatch(picture(), square);
    expect(patch.w).toBe(patch.h);
  });

  it('drags handles, the frame, and corners in proportion when a ratio is held', () => {
    const start = { x: 0, y: 0, w: 1, h: 1 };
    expect(dragCrop(start, 'w', 0.2, 0)).toEqual({ x: 0.2, y: 0, w: 0.8, h: 1 });
    expect(dragCrop(start, 'n', 0, 0.3)).toEqual({ x: 0, y: 0.3, w: 1, h: 0.7 });
    const moved = dragCrop({ x: 0.1, y: 0.1, w: 0.5, h: 0.5 }, 'move', 0.9, -0.5);
    expect(moved).toEqual({ x: 0.5, y: 0, w: 0.5, h: 0.5 });
    // A 200 × 100 picture held at 2:1 (its own shape): the corner keeps width twice the height in pixels.
    const corner = dragCrop(start, 'se', -0.5, -0.1, { ratio: 2, full: { w: 200, h: 100 } });
    close(corner.w, 0.5); close(corner.h, 0.5);
    // A drag past the far edge stops at the minimum.
    expect(dragCrop(start, 'e', -2, 0).w).toBeCloseTo(CROP_MIN, 9);
  });
});

describe('corrections, color and transparency', () => {
  it('maps brightness and contrast to a tone curve', () => {
    expect(toneCurve(null)).toEqual({ slope: 1, intercept: 0 });
    expect(toneCurve({ brightness: 0.2, contrast: 0 })).toEqual({ slope: 1, intercept: 0.2 });
    const high = toneCurve({ brightness: 0, contrast: 0.5 });
    expect(high.slope).toBe(2); close(high.intercept, -0.5);
    expect(toneCurve({ brightness: 0, contrast: -0.4 }).slope).toBeCloseTo(0.6, 9);
  });

  it('draws them into pixels for copies and cell pictures', () => {
    const data = new Uint8ClampedArray([100, 150, 200, 255, 0, 0, 0, 128]);
    applyPictureFilter(data, { adjust: { brightness: 0.2, contrast: 0 }, transparency: 0.5 });
    expect([...data]).toEqual([151, 201, 251, 128, 51, 51, 51, 64]);
    const gray = new Uint8ClampedArray([255, 0, 0, 255]);
    applyPictureFilter(gray, { recolor: 'grayscale' });
    expect(gray[0]).toBe(gray[1]); expect(gray[1]).toBe(gray[2]); expect(gray[0]).toBe(54);
    expect(pictureIsPlain(picture())).toBe(true);
    expect(pictureIsPlain(picture({ transparency: 0.3 }))).toBe(false);
  });

  it('normalizes what the picture keeps, dropping what is out of range', () => {
    expect(normalizePictureFormat({ adjust: { brightness: 3, contrast: -0.2 }, transparency: 0.25, recolor: 'grayscale', shadow: true, shape: 'ellipse', lockAspect: false,
      outline: { width: 4, color: '#FFAA00' } })).toEqual({ adjust: { brightness: 1, contrast: -0.2 }, transparency: 0.25, recolor: 'grayscale', shadow: true, shape: 'ellipse',
      lockAspect: false, outline: { width: 4, color: '#ffaa00' } });
    expect(normalizePictureFormat({ adjust: { brightness: 0, contrast: 0 }, transparency: 0, outline: { width: 2, color: 'red' }, shape: 'star' })).toEqual({});
    const obj = normalizeChart(picture({ adjust: { brightness: 0.4, contrast: 0.2 }, pictureRef: '=Sheet1!$A$1:$B$2' }));
    expect(obj).toMatchObject({ adjust: { brightness: 0.4, contrast: 0.2 }, pictureRef: 'Sheet1!$A$1:$B$2' });
  });
});

describe('styles, size and reset', () => {
  it('recognizes the gallery style a picture wears and draws its frame', () => {
    for (const style of PICTURE_STYLES) expect(pictureStyleOf(picture(normalizePictureFormat(style.patch)))).toBe(style.id);
    expect(pictureStyleOf(picture({ shadow: true, shape: 'ellipse' }))).toBeNull();
    const css = pictureFrameCss(picture({ outline: { width: 6, color: '#ffffff' }, shape: 'roundRect', shadow: true }), 2);
    expect(css.border).toBe('12px solid #ffffff');
    expect(css.borderRadius).toBe('24px');
    expect(css.boxShadow).toMatch(/rgba/);
    expect(pictureFrameCss(picture({ shape: 'ellipse' })).borderRadius).toBe('50%');
  });

  it('keeps proportions when one side is typed, unless unlocked', () => {
    expect(sizePatch(picture(), { w: 300 })).toEqual({ w: 300, h: 150 });
    expect(sizePatch(picture(), { h: 50 })).toEqual({ w: 100, h: 50 });
    expect(sizePatch(picture({ lockAspect: false }), { h: 50 })).toEqual({ w: 200, h: 50 });
  });

  it('resets formatting, or formatting, crop and size', () => {
    const wb = new Workbook(), id = wb.activeSheetId;
    const pid = wb.addChart(id, picture({ adjust: { brightness: 0.2, contrast: 0 }, transparency: 0.5, shadow: true, srcRect: { l: 0.5 }, rotation: 90 }));
    wb.updateChart(id, pid, { ...RESET_PICTURE }, 'Reset picture');
    let obj = wb.chartById(id, pid);
    expect(obj.adjust).toBeUndefined(); expect(obj.transparency).toBeUndefined(); expect(obj.shadow).toBeUndefined();
    expect(obj.srcRect).toEqual({ l: 0.5 }); expect(obj.rotation).toBe(90);
    wb.updateChart(id, pid, resetPictureAndSize({ w: 64, h: 32 }), 'Reset picture and size');
    obj = wb.chartById(id, pid);
    expect(obj.srcRect).toBeUndefined(); expect(obj.rotation).toBeUndefined(); expect([obj.w, obj.h]).toEqual([64, 32]);
    wb.undo(); wb.undo();
    expect(wb.chartById(id, pid).transparency).toBe(0.5);
  });
});

describe('Picture Format in the file', () => {
  const xml = (z, p) => new TextDecoder().decode(X.CFB.find(z, p)?.content);
  it('writes corrections, color, transparency and style as DrawingML', () => {
    const out = pictureFormatXml(picture({ adjust: { brightness: 0.2, contrast: -0.4 }, transparency: 0.25, recolor: 'grayscale', shape: 'roundRect', outline: { width: 2, color: '#112233' }, shadow: true }));
    expect(out.blip).toContain('<a:alphaModFix amt="75000"/>');
    expect(out.blip).toContain('<a:grayscl/>');
    expect(out.blip).toContain('<a:lum bright="20000" contrast="-40000"/>');
    expect(out.shape).toContain('prst="roundRect"');
    expect(out.shape).toContain('<a:ln w="19050"><a:solidFill><a:srgbClr val="112233"/></a:solidFill></a:ln>');
    expect(out.shape).toContain('<a:outerShdw');
  });

  it('round trips through .xlsx, natively and with the app record', async () => {
    const wb = new Workbook(), id = wb.activeSheetId;
    wb.addChart(id, picture({ adjust: { brightness: 0.2, contrast: 0.4 }, transparency: 0.3, recolor: 'grayscale', shape: 'ellipse', outline: { width: 3, color: '#ff0000' }, shadow: true,
      srcRect: { l: 0.1, r: 0.1 }, description: 'A logo' }));
    const bytes = new Uint8Array(await (await workbookToXlsx(wb)).arrayBuffer());
    const back = await workbookFromFile(bytes, 'pictures.xlsx');
    const expected = { adjust: { brightness: 0.2, contrast: 0.4 }, transparency: 0.3, recolor: 'grayscale', shape: 'ellipse', outline: { width: 3, color: '#ff0000' }, shadow: true, srcRect: { l: 0.1, r: 0.1 } };
    expect(back.sheets[0].charts[0]).toMatchObject(expected);
    // Without this app's own record the drawing alone carries the same picture.
    const z = X.CFB.read(bytes, { type: 'array' });
    X.CFB.utils.cfb_add(z, '/xl/workbook.xml', new TextEncoder().encode(xml(z, '/xl/workbook.xml').replace(/<sheet\b[^>]*name="_puter_meta\d*"[^>]*\/>/g, '')));
    const native = await workbookFromFile(X.CFB.write(z, { type: 'array', fileType: 'zip' }), 'native.xlsx');
    const obj = native.sheets[0].charts[0];
    expect(obj.adjust.brightness).toBeCloseTo(0.2, 6); expect(obj.adjust.contrast).toBeCloseTo(0.4, 6);
    expect(obj.transparency).toBeCloseTo(0.3, 6);
    expect(obj).toMatchObject({ recolor: 'grayscale', shape: 'ellipse', outline: { width: 3, color: '#ff0000' }, shadow: true });
  });
});
