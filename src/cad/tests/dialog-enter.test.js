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

describe('dialog focus return', () => {
  it('focuses the field again when the browser already returned focus to it', async () => {
    // Chromium returns focus itself as a modal dialog closes; after a click on
    // a dialog button that leaves a text field focused but unable to take
    // typing until it is focused anew.
    const field = document.createElement('input');
    document.body.append(field);
    field.focus();
    const close = HTMLDialogElement.prototype.close;
    HTMLDialogElement.prototype.close = function () {
      close.call(this);
      field.focus();
    };
    try {
      const p = openDialog({ title: 'T', body: document.createElement('p'), actions: [{ label: 'Cancel' }] });
      const events = [];
      field.addEventListener('blur', () => events.push('blur'));
      field.addEventListener('focus', () => events.push('focus'));
      [...document.querySelectorAll('dialog button')].find((b) => b.textContent === 'Cancel').click();
      expect(await p).toBe(null);
      expect(events.slice(-2)).toEqual(['blur', 'focus']);
      expect(document.activeElement).toBe(field);
    } finally {
      HTMLDialogElement.prototype.close = close;
      field.remove();
    }
  });
});
