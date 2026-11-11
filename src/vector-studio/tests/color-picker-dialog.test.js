import { describe, it, expect } from 'vitest';
import { bootAppWithFeatures } from './helpers.js';
import { openColorPickerDialog } from '../src/features/paint/color-dialog.js';

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('Color Picker dialog', () => {
  it('puts a channel field back when its text is not a number', async () => {
    const app = await bootAppWithFeatures();
    // The color field and strip draw pixels, which the jsdom canvas stub cannot hold.
    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = () => null;
    let done;
    try {
      done = openColorPickerDialog(app, { value: '#336699' });
    } finally {
      HTMLCanvasElement.prototype.getContext = getContext;
    }
    await tick();
    const dlg = document.querySelector('dialog[open]');
    const field = (label) => dlg.querySelector(`input[aria-label="${label}"]`);
    for (const [label, text] of [
      ['R', 'abc'],
      ['H', ''],
      ['C', 'x%'],
    ]) {
      field(label).value = text;
      field(label).dispatchEvent(new Event('change'));
    }
    expect(field('R').value).toBe('51');
    expect(field('H').value).toBe('210');
    expect(dlg.querySelector('.cpd-hex').value).toBe('336699');
    // Numbers still apply, clamped to the channel's range.
    field('R').value = '300';
    field('R').dispatchEvent(new Event('change'));
    expect(dlg.querySelector('.cpd-hex').value).toBe('FF6699');
    [...dlg.querySelectorAll('button')].find((b) => b.textContent === 'OK').click();
    expect(await done).toBe('#ff6699');
  });
});
