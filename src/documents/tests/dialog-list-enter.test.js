// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { openDateTime } from '../src/views/insert-dialogs.js';
import { openStyleDialog } from '../src/views/format-misc-dialogs.js';
import { closeAllModals } from '../src/ui/modal.js';
import { el } from '../src/ui/dom.js';

// In a dialog that chooses from a list, Enter on the list takes the choice, as a double-click does.
describe('Enter in a dialog list', () => {
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
  const press = (node, key) => { const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }); node.dispatchEvent(event); return event; };

  it('inserts the date format Enter is pressed on', async () => {
    const onInsert = vi.fn();
    const modal = openDateTime({ onInsert });
    const options = [...modal.panel.querySelectorAll('[role="option"]')];
    options[0].focus();
    press(options[0], 'ArrowDown');
    expect(document.activeElement).toBe(options[1]);
    expect(press(options[1], 'Enter').defaultPrevented).toBe(true);
    await vi.runAllTimersAsync();
    expect(onInsert).toHaveBeenCalledTimes(1);
    expect(onInsert.mock.calls[0][0].picture).toBe(options[1].dataset.picture);
  });

  it('applies the style chosen in Format > Style', async () => {
    const apply = vi.fn(() => true);
    const styles = [{ id: 'Normal', name: 'Normal', type: 'paragraph' }, { id: 'Heading1', name: 'heading 1', type: 'paragraph' }];
    const modal = openStyleDialog({ styles: () => styles, describe: () => '', usage: () => new Map(), current: 'Normal',
      actions: { apply, create() {}, modify() {}, remove() {}, readOnly: () => false } });
    const list = modal.panel.querySelector('[role="listbox"]');
    press(list, 'ArrowDown');
    press(list, 'Enter');
    await vi.runAllTimersAsync();
    expect(apply).toHaveBeenCalledWith('Heading1');
  });
});
