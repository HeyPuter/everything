// @vitest-environment jsdom
import { describe, it, expect, beforeAll } from 'vitest';
import { openDialog } from '../src/ui/dialog.js';

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open');
  };
});

describe('dialog Enter key', () => {
  it('leaves the field (committing it) before confirming', async () => {
    const inp = Object.assign(document.createElement('input'), { type: 'number' });
    const events = [];
    // Browsers fire 'change' on blur when the value changed; not all do when a dialog closes.
    inp.addEventListener('blur', () => events.push('blur'));
    const p = openDialog({ title: 'T', body: inp, actions: [{ label: 'Cancel' }, { label: 'OK', primary: true, value: true, onClick: () => (events.push('ok'), true) }] });
    inp.focus();
    inp.value = '7';
    inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    expect(await p).toBe(true);
    expect(events).toEqual(['blur', 'ok']);
  });
});
