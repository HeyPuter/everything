// Dialogs move by their title bar and reopen where they were left.
import { describe, it, expect } from 'vitest';
import { openDialog } from '../src/ui/dialog.js';

const at = (type, x, y) => {
  const e = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 });
  Object.defineProperty(e, 'pointerId', { value: 1 });
  return e;
};

function layOut(dialog) {
  // jsdom has no layout: a 400 x 300 dialog centered in a 1024 x 768 window, moved by its translate.
  dialog.getBoundingClientRect = () => {
    const [x, y] = (dialog.style.translate || '0px 0px').split(' ').map((v) => parseFloat(v) || 0);
    const left = 312 + x;
    const top = 234 + y;
    return { left, top, width: 400, height: 300, right: left + 400, bottom: top + 300 };
  };
}

describe('movable dialogs', () => {
  it('drags by the title bar, keeps the bar on screen and reopens in the same place', async () => {
    Object.defineProperty(window, 'innerWidth', { value: 1024, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: 768, configurable: true });
    const done = openDialog({ title: 'Move Me', body: 'x' });
    let dialog = document.querySelector('.dialog');
    layOut(dialog);
    const head = dialog.querySelector('.dialog-head');
    head.dispatchEvent(at('pointerdown', 500, 250));
    head.dispatchEvent(at('pointermove', 400, 300));
    expect(dialog.style.translate).toBe('-100px 50px');
    // Far up and left: the title bar stays reachable.
    head.dispatchEvent(at('pointermove', -2000, -2000));
    expect(dialog.style.translate).toBe(`${80 - (312 + 400)}px -234px`);
    head.dispatchEvent(at('pointermove', 450, 280));
    head.dispatchEvent(at('pointerup', 450, 280));
    expect(dialog.style.translate).toBe('-50px 30px');
    // The close button is not a drag handle.
    head.querySelector('button').dispatchEvent(at('pointerdown', 700, 250));
    head.dispatchEvent(at('pointermove', 100, 100));
    expect(dialog.style.translate).toBe('-50px 30px');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(await done).toBe(null);

    const again = openDialog({ title: 'Move Me', body: 'x' });
    dialog = document.querySelector('.dialog');
    // Restored at open (before this test could give it a box, jsdom measures 0 x 0 at the origin).
    expect(dialog.style.translate).not.toBe('');
    layOut(dialog);
    dialog.querySelector('.dialog-head').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect(dialog.style.translate).toBe('');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await again;
  });
});
