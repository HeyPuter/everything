// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { openZoomDialog, parseZoomPercent } from '../src/ui/zoomdialog.js';
import { closeAllModals } from '../src/ui/modal.js';

beforeEach(() => { vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} })); });
afterEach(() => { closeAllModals(); document.body.replaceChildren(); vi.unstubAllGlobals(); });
// A closed dialog lingers a moment while it fades: the one open is the last that is not closing.
const dialog = () => [...document.querySelectorAll('.modal-root:not(.closing) .zoom-dialog')].at(-1);
const submit = () => dialog().dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
const choose = value => { const input = dialog().querySelector(`input[value="${value}"]`); input.checked = true; return input; };

it('reads typed percentages from 10 to 400', () => {
  expect(parseZoomPercent('85')).toBe(85);
  expect(parseZoomPercent(' 120 % ')).toBe(120);
  for (const bad of ['', '9', '401', '12.5', 'abc']) expect(parseZoomPercent(bad)).toBeNull();
});

it('applies a preset, fits the selection, or applies a custom percentage', () => {
  const apply = vi.fn(), fit = vi.fn();
  openZoomDialog({ zoom: 0.75, apply, fit });
  // The zoom in force starts chosen.
  expect(dialog().querySelector('input[value="75"]').checked).toBe(true);
  choose('200'); submit();
  expect(apply).toHaveBeenLastCalledWith(2);
  openZoomDialog({ zoom: 1.33, apply, fit });
  expect(dialog().querySelector('input[value="custom"]').checked).toBe(true);
  expect(dialog().querySelector('[aria-label="Zoom percentage"]').value).toBe('133');
  choose('fit'); submit();
  expect(fit).toHaveBeenCalledTimes(1);
  openZoomDialog({ zoom: 1, apply, fit, canFit: false });
  expect(dialog().querySelector('input[value="fit"]').disabled).toBe(true);
  const custom = dialog().querySelector('[aria-label="Zoom percentage"]');
  custom.value = '64'; custom.dispatchEvent(new Event('input', { bubbles: true }));
  submit();
  expect(apply).toHaveBeenLastCalledWith(0.64);
});
