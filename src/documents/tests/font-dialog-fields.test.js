// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { openFontDialog } from '../src/views/font-dialog.js';
import { closeAllModals } from '../src/ui/modal.js';
import { el } from '../src/ui/dom.js';

const FORMAT = { fontAscii: 'Noto Sans', fontHAnsi: 'Noto Sans', fontSize: 12, bold: false, italic: false, color: 'auto', underlineStyle: 'none', underlineColor: 'auto',
  strikethrough: 'none', capitalization: 'normal', verticalAlign: 'baseline', vanish: false, textScale: 100, characterSpacing: 0, baselineShift: 0, kerning: 0 };

describe('Font dialog fields', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    document.body.replaceChildren(el('div', { id: 'app' }));
  });
  afterEach(() => {
    closeAllModals();
    vi.runAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  const field = (modal, label) => modal.panel.querySelector(`[aria-label="${label}"]`);
  const type = (input, value) => { input.value = value; input.dispatchEvent(new Event('input', { bubbles: true })); };
  const submit = async modal => { modal.panel.querySelector('form').requestSubmit(); await vi.runAllTimersAsync(); };

  it('leaves the size and scale alone when their fields are emptied after typing', async () => {
    const apply = vi.fn(() => true);
    const modal = openFontDialog({ format: FORMAT, apply });
    type(field(modal, 'Size'), '20');
    type(field(modal, 'Size'), '');
    type(field(modal, 'Scale (%)'), '150');
    type(field(modal, 'Scale (%)'), '');
    field(modal, 'Font style').value = 'bold';
    field(modal, 'Font style').dispatchEvent(new Event('change'));
    await submit(modal);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply.mock.calls[0][0]).toEqual({ bold: true, italic: false });
  });
});
