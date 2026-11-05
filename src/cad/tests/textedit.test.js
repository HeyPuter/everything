// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { TextEditor } from '../src/ui/textedit.js';

globalThis.requestAnimationFrame ??= (cb) => setTimeout(cb, 0);

function openEditor(opts = {}, at = { x: 10, y: 10 }) {
  const canvasWrap = document.createElement('div');
  canvasWrap.getBoundingClientRect = () => ({ left: 0, top: 0, width: 390, height: 700 });
  const overlay = document.createElement('canvas');
  canvasWrap.append(overlay);
  document.body.append(canvasWrap);
  const app = {
    shell: { canvasWrap, overlay },
    camera: { toScreen: () => at },
    focusCanvas: () => {},
  };
  const done = [];
  new TextEditor(app).open({ anchor: { x: 0, y: 0 }, onDone: (v) => done.push(v), ...opts });
  const field = canvasWrap.querySelector('.te-field');
  const key = (k, extra = {}) =>
    field.dispatchEvent(
      new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...extra }),
    );
  const el = canvasWrap.querySelector('.text-editor');
  return { el, field, key, done };
}

describe('in-place text editor', () => {
  it('finishes on Enter and cancels on Escape', () => {
    const a = openEditor();
    a.field.value = 'Hello';
    a.key('Enter');
    expect(a.done).toEqual(['Hello']);
    const b = openEditor();
    b.key('Escape');
    expect(b.done).toEqual([null]);
  });

  it('leaves Enter and Escape to an IME that is composing', () => {
    const a = openEditor();
    a.field.value = 'にほん';
    a.key('Enter', { isComposing: true });
    a.key('Escape', { isComposing: true });
    a.key('Enter', { keyCode: 229 });
    expect(a.done).toEqual([]);
    a.key('Enter');
    expect(a.done).toEqual(['にほん']);
  });

  it('stays on screen when the insertion point is off screen', () => {
    for (const at of [
      { x: -200, y: -80 },
      { x: 900, y: 1200 },
    ]) {
      const { el } = openEditor({}, at);
      const x = parseFloat(el.style.left),
        y = parseFloat(el.style.top);
      expect(x).toBeGreaterThanOrEqual(8);
      expect(x).toBeLessThanOrEqual(390 - 8);
      expect(y).toBeGreaterThanOrEqual(8);
      expect(y).toBeLessThanOrEqual(700 - 8);
    }
  });
});
