// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/io/storage.js', () => ({ recovery: {} }));
const { App } = await import('../src/app.js');

function setup(busy) {
  const ran = [];
  const app = Object.create(App.prototype);
  const canvas = document.createElement('canvas');
  canvas.tabIndex = 0;
  const input = document.createElement('input');
  document.body.append(canvas, input);
  canvas.focus();
  app.editor = { busy };
  app.cmdline = { input, value: () => input.value, textSelected: () => false };
  app.shell = { overlay: canvas };
  app.run = (name) => ran.push(name);
  const paste = (target = canvas) => {
    const e = new KeyboardEvent('keydown', { key: 'v', ctrlKey: true, bubbles: true, cancelable: true });
    Object.defineProperty(e, 'target', { value: target });
    app.onKey(e);
    return e.defaultPrevented;
  };
  return { ran, paste, input };
}

describe('Ctrl+V', () => {
  it('at a prompt brings clipboard text to the command line and keeps the command', () => {
    const { ran, paste, input } = setup(true);
    // Left to the browser, which pastes into the field that now has focus.
    expect(paste()).toBe(false);
    expect(document.activeElement).toBe(input);
    expect(ran).toEqual([]);
    expect(paste(input)).toBe(false);
    expect(ran).toEqual([]);
  });

  it('pastes objects when no command is waiting', () => {
    const { ran, paste } = setup(false);
    expect(paste()).toBe(true);
    expect(ran).toEqual(['PASTECLIP']);
  });
});
