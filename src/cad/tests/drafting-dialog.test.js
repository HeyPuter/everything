// @vitest-environment jsdom
import { describe, it, expect, beforeAll } from 'vitest';
import { draftingDialog } from '../src/ui/dialogs.js';

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open');
  };
});

async function setSpacing(snap, grid) {
  const settings = { osnapModes: [], snapSpacing: 10, gridSpacing: 20, polarInc: 90, pickbox: 5, aperture: 10 };
  const p = draftingDialog({ settings, setSetting: (k, v) => (settings[k] = v) });
  const dlg = document.querySelector('dialog[open]');
  [...dlg.querySelectorAll('[role=tab]')][1].click();
  const [s, g] = dlg.querySelectorAll('input[type=number]');
  s.value = snap;
  g.value = grid;
  [...dlg.querySelectorAll('button')].find((b) => b.textContent.trim() === 'OK').click();
  await p;
  dlg.remove();
  return settings;
}

describe('drafting settings', () => {
  it('keeps the current snap and grid spacing for values that are not positive', async () => {
    for (const bad of ['-5', '0', '', 'x']) expect(await setSpacing(bad, bad)).toMatchObject({ snapSpacing: 10, gridSpacing: 20 });
  });
  it('takes positive spacings', async () => {
    expect(await setSpacing('2.5', '50')).toMatchObject({ snapSpacing: 2.5, gridSpacing: 50 });
  });
  it('names the tab panel after the selected tab', async () => {
    const settings = { osnapModes: [], snapSpacing: 10, gridSpacing: 20, polarInc: 90, pickbox: 5, aperture: 10 };
    const p = draftingDialog({ settings, setSetting() {} });
    const dlg = document.querySelector('dialog[open]');
    const panel = dlg.querySelector('[role=tabpanel]');
    const name = () => document.getElementById(panel.getAttribute('aria-labelledby'))?.textContent;
    expect(name()).toBe('Object snap');
    [...dlg.querySelectorAll('[role=tab]')][2].click();
    expect(name()).toBe('Polar tracking');
    [...dlg.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Cancel').click();
    await p;
    dlg.remove();
  });
});
