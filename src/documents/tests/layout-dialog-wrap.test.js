// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { openLayoutDialog } from '../src/views/size-position.js';
import { closeAllModals } from '../src/ui/modal.js';

beforeEach(() => { vi.useFakeTimers(); vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} })); });
afterEach(() => { closeAllModals(); vi.runAllTimers(); vi.useRealTimers(); document.body.replaceChildren(); vi.unstubAllGlobals(); });

const IN = 914400;
it('keeps a picture where it is when the Layout dialog switches it to a wrapping measured from the column', () => {
  // In front of the text at 3 in, 5 in from the page's corner; the column and paragraph start 1 in in.
  const image = { anchor: { horizontal: 'page', vertical: 'page', x: 3 * IN, y: 5 * IN, wrap: 'none', behind: false }, width: IN, height: IN };
  const describe = () => ({ kind: 'picture', width: IN, height: IN, frame: { inline: false, horizontal: { relativeFrom: 'page', offset: 3 * IN }, vertical: { relativeFrom: 'page', offset: 5 * IN }, wrap: { type: 'none', side: 'bothSides', distances: { T: 0, B: 0, L: 114300, R: 114300 } }, behind: false, order: 1, layoutInCell: true, allowOverlap: true } });
  const offsetsFor = (f, x, y) => { const a = f.image.anchor, from = side => a[side] === 'page' ? 0 : 96; return { x: Math.round((x - from('horizontal')) * 9525), y: Math.round((y - from('vertical')) * 9525) }; };
  openLayoutDialog({ engine: { model: {}, images: new Map() }, image, describe, tab: 'wrapping', kind: 'picture', apply: vi.fn(), frameOf: () => ({ x: 3 * 96, y: 5 * 96, image }), offsetsFor, place: () => ({ x: 0, y: 0 }) });
  const square = document.querySelector('form.pic-layout-dialog input[type=radio][value="square"]');
  square.checked = true; square.dispatchEvent(new Event('change', { bubbles: true }));
  const field = label => document.querySelector(`[aria-label="${label}"]`).value;
  expect([field('Horizontal position to the right of'), field('Vertical position below')]).toEqual(['column', 'paragraph']);
  expect(Number(field('Horizontal absolute position (in)'))).toBeCloseTo(2, 2);
  expect(Number(field('Vertical absolute position (in)'))).toBeCloseTo(4, 2);
});
