// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { TextEditor } from '../src/ui/textedit.js';

globalThis.requestAnimationFrame ??= (cb) => setTimeout(cb, 0);

function openEditor(opts = {}) {
  const canvasWrap = document.createElement('div');
  const overlay = document.createElement('canvas');
  canvasWrap.append(overlay);
  document.body.append(canvasWrap);
  const app = {
    shell: { canvasWrap, overlay },
    camera: { toScreen: () => ({ x: 10, y: 10 }) },
    focusCanvas: () => {},
  };
  const done = [];
  new TextEditor(app).open({ anchor: { x: 0, y: 0 }, onDone: (v) => done.push(v), ...opts });
  const field = canvasWrap.querySelector('.te-field');
  const key = (k, extra = {}) =>
    field.dispatchEvent(
      new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...extra }),
    );
  return { field, key, done };
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
});
