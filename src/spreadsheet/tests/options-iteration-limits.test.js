// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openOptionsDialog } from '../src/ui/options-dialog.js';
import { closeAllModals } from '../src/ui/modal.js';
import { Workbook } from '../src/core/workbook.js';

vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
afterEach(() => { closeAllModals(); document.body.replaceChildren(); });

// Options ▸ Formulas ▸ Most iterations took 50000 (over Excel's limit of 32,767) or 2.5 as no number at all, and the
// workbook quietly went back to 100 iterations, the box with it: a user asking for more rounds got far fewer. Like the
// other number options, a number past the limits now stops at the nearest one it may be, and a fraction is rounded.
describe('the iteration limits in Options', () => {
  const open = () => {
    const wb = new Workbook();
    openOptionsDialog({ wb, run: vi.fn() }, { section: 'formulas' });
    const panel = document.querySelector('.modal-panel');
    const iterate = [...panel.querySelectorAll('.opt-check')].find((r) => /circular/.test(r.textContent)).querySelector('input');
    iterate.checked = true;
    iterate.dispatchEvent(new Event('change'));
    return { wb, count: panel.querySelector('[aria-label="Most iterations"]'), delta: panel.querySelector('[aria-label="Largest change"]') };
  };
  const type = (input, value) => { input.value = value; input.dispatchEvent(new Event('change')); };

  it('stops a count past the limits at the nearest one, and rounds a fraction', () => {
    const { wb, count } = open();
    type(count, '50000');
    expect(wb.iteration.iterateCount).toBe(32767);
    expect(count.value).toBe('32767');
    type(count, '0');
    expect(wb.iteration.iterateCount).toBe(1);
    type(count, '2.6');
    expect(wb.iteration.iterateCount).toBe(3);
    type(count, '250');
    expect(wb.iteration.iterateCount).toBe(250);
  });

  it('keeps the count when the box is left empty, and a negative change goes to none', () => {
    const { wb, count, delta } = open();
    type(count, '250');
    type(count, '');
    expect(wb.iteration.iterateCount).toBe(250);
    expect(count.value).toBe('250');
    type(delta, '-1');
    expect(wb.iteration.iterateDelta).toBe(0);
  });
});
