// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { openLayoutDialog } from '../src/views/size-position.js';
import { closeAllModals } from '../src/ui/modal.js';

beforeEach(() => { vi.useFakeTimers(); vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} })); });
afterEach(() => { closeAllModals(); vi.runAllTimers(); vi.useRealTimers(); document.body.replaceChildren(); vi.unstubAllGlobals(); });

const IN = 914400;
const open = (image, assets, images) => openLayoutDialog({ engine: { model: { assets, paragraphs: [] }, images }, image, describe: () => ({ kind: 'picture', frame: { inline: true } }), tab: 'size', kind: 'picture',
  apply: vi.fn(), frameOf: () => null, offsetsFor: () => ({ x: 0, y: 0 }), place: () => ({ x: 0, y: 0 }) });
const originalText = () => [...document.querySelectorAll('form.pic-layout-dialog legend')].find(l => l.textContent === 'Original size')?.parentElement.querySelector('span')?.textContent ?? null;

it('shows the decoded picture’s size as the original size of a picture with a style (outline, shadow or 3D frame)', () => {
  // A styled picture is a retained drawing whose scene holds the picture; the scene has no bitmap of its own.
  const images = new Map([['media/image1.png', { width: 192, height: 96 }]]);
  for (const scene of [{ type: 'group', children: [{ type: 'picture', image: { assetId: 'media/image1.png' } }] }, { type: 'picture3d', image: { assetId: 'media/image1.png' } }]) {
    open({ kind: 'drawing', retainedDrawing: true, assetId: 'drawing:7', width: 3 * IN, height: 1.5 * IN }, { 'drawing:7': { scene, width: 288, height: 144 } }, images);
    expect(originalText()).toBe('Height: 1″   Width: 2″');
    const reset = [...document.querySelectorAll('button')].find(b => b.textContent === 'Reset');
    expect(reset.disabled).toBe(false);
    reset.click();
    const field = label => document.querySelector(`[aria-label="${label}"]`).value;
    expect([field('Height (in)'), field('Width (in)')]).toEqual(['1', '2']);
    closeAllModals(); vi.runAllTimers(); document.body.replaceChildren();
  }
});

it('keeps the original size of a plain picture', () => {
  open({ kind: 'image', assetId: 'media/image1.png', width: IN, height: IN }, {}, new Map([['media/image1.png', { width: 96, height: 48 }]]));
  expect(originalText()).toBe('Height: 0.5″   Width: 1″');
});
