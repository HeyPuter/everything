// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { CommandLine } from '../src/ui/commandline.js';

vi.mock('../src/io/storage.js', () => ({ recovery: {} }));
const { App } = await import('../src/app.js');

function setup() {
  const ran = [];
  const app = Object.create(App.prototype);
  app.editor = { spaceSubmits: true, request: null, drawOverlay() {}, cancel() {}, find: () => null };
  app.commands = new Map();
  app.run = (name) => ran.push(name);
  app.focusCanvas = () => {};
  app.cmdline = new CommandLine(app);
  const canvas = document.createElement('canvas');
  app.shell = { overlay: canvas };
  document.body.append(app.cmdline.el, canvas);
  app.cmdline.log('Distance = 123.4567');
  const copy = () => {
    const e = new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, bubbles: true, cancelable: true });
    Object.defineProperty(e, 'target', { value: document.body });
    app.onKey(e);
    return e.defaultPrevented;
  };
  const selectLine = () => {
    const range = document.createRange();
    range.selectNodeContents(app.cmdline.history.lastChild);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
  };
  return { app, ran, canvas, copy, selectLine };
}

describe('copying text from the command history', () => {
  it('leaves Ctrl+C to the browser while history text is selected', () => {
    const { ran, copy, selectLine } = setup();
    selectLine();
    expect(copy()).toBe(false);
    expect(ran).toEqual([]);
  });

  it('copies objects again once a press elsewhere dropped the text selection', () => {
    const { app, ran, canvas, copy, selectLine } = setup();
    selectLine();
    app.cmdline.history.lastChild.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(app.cmdline.textSelected()).toBe(true);
    canvas.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(app.cmdline.textSelected()).toBe(false);
    expect(copy()).toBe(true);
    expect(ran).toEqual(['COPYCLIP']);
  });
});
