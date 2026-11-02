// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { openTableProperties } from '../src/views/table-properties.js';
import { closeAllModals } from '../src/ui/modal.js';

beforeEach(() => { vi.useFakeTimers(); vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {} })); });
afterEach(() => { closeAllModals(); vi.runAllTimers(); vi.useRealTimers(); document.body.replaceChildren(); vi.unstubAllGlobals(); });

const table = patch => ({ id: 't1', layout: 'fixed', width: { type: 'dxa', value: 4000 }, alignment: 'left', indent: 0, grid: [2000, 2000], margins: { top: 0, right: 108, bottom: 0, left: 108 },
  rows: [{ id: 'r1', cells: [{ id: 'c1' }, { id: 'c2' }] }], ...patch });
/** Open Table Properties, choose Text wrapping: Around and apply: the changes the dialog sends. */
function aroundChanges(source) {
  const apply = vi.fn(() => true);
  openTableProperties(source, [2000, 2000], 0, apply, { wrap: 'none', altText: { title: '', description: '' } });
  const wrap = document.querySelector('[aria-label="Text wrapping"]');
  wrap.value = 'around'; wrap.dispatchEvent(new Event('change'));
  document.querySelector('form.table-properties').requestSubmit();
  closeAllModals(); vi.runAllTimers(); document.body.replaceChildren();
  return apply.mock.calls[0][0];
}

it('starts a table that begins to float where it stands: at its alignment or indent', () => {
  // Only Around was chosen: the positioning it sends must not move a centered or indented table to the margin.
  expect(aroundChanges(table({ alignment: 'center' }))).toMatchObject({ wrap: 'around', positioning: { x: 'center', horzAnchor: 'text' } });
  expect(aroundChanges(table({ alignment: 'right' })).positioning.x).toBe('right');
  expect(aroundChanges(table({ indent: 720 })).positioning.x).toBe(720);
  expect(aroundChanges(table()).positioning.x).toBe(0);
});
