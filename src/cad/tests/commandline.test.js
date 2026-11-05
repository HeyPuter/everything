// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { CommandLine } from '../src/ui/commandline.js';

function setup() {
  const submitted = [];
  const editor = {
    spaceSubmits: true,
    request: null,
    submit: (t) => submitted.push(t),
    drawOverlay() {},
    cancel() {},
  };
  const app = { editor, commands: new Map(), focusCanvas() {}, run() {} };
  const cl = new CommandLine(app);
  document.body.append(cl.el);
  const key = (key, init = {}) =>
    cl.input.dispatchEvent(
      new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }),
    );
  return { cl, key, submitted };
}

describe('command line keys', () => {
  it('leaves Enter and Space to the input method while composing', () => {
    const { cl, key, submitted } = setup();
    cl.input.value = 'にほん';
    key(' ', { isComposing: true });
    key('Enter', { isComposing: true });
    expect(submitted).toEqual([]);
    expect(cl.input.value).toBe('にほん');
    key('Enter');
    expect(submitted).toEqual(['にほん']);
  });
});
