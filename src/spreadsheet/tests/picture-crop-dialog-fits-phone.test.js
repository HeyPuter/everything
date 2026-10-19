// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { openCropDialog } from '../src/ui/picture-crop.js';
import { closeAllModals } from '../src/ui/modal.js';

const picture = { id: 'p', type: 'image', src: 'data:image/png;base64,iVBORw0KGgo=', w: 320, h: 200, anchor: { r: 0, c: 0 }, dx: 0, dy: 0 };
let width;
beforeEach(() => { width = window.innerWidth; vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} })); });
afterEach(() => { closeAllModals(); window.innerWidth = width; vi.unstubAllGlobals(); document.body.replaceChildren(); });
const stageWidth = () => parseFloat(document.querySelector('.crop-stage').style.width);

it('fits the crop stage, and its side handles, inside a phone\'s screen', () => {
  window.innerWidth = 390;
  openCropDialog({ picture });
  expect(stageWidth()).toBeLessThanOrEqual(390 - 64);
  expect(stageWidth()).toBeGreaterThan(200);
});

it('keeps the full-size stage on a desktop screen', () => {
  window.innerWidth = 1440;
  openCropDialog({ picture });
  expect(stageWidth()).toBe(544);
});
