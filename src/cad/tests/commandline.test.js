// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { CommandLine } from '../src/ui/commandline.js';
import { buildRegistry } from '../src/editor/commands/index.js';

function setup() {
  const submitted = [];
  const ran = [];
  const editor = {
    spaceSubmits: true,
    request: null,
    submit: (t) => submitted.push(t),
    drawOverlay() {},
    cancel() {},
  };
  const app = {
    editor,
    commands: buildRegistry(),
    focusCanvas() {},
    run: (name) => ran.push(name),
  };
  const cl = new CommandLine(app);
  document.body.append(cl.el);
  const key = (key, init = {}) =>
    cl.input.dispatchEvent(
      new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }),
    );
  const enter = (text) => {
    cl.input.value = text;
    cl.input.dispatchEvent(new Event('input'));
    key('Enter');
    return ran.at(-1);
  };
  return { cl, key, enter, submitted };
}

describe('command line', () => {
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

  it('runs the command an alias names, not a longer command starting with it', () => {
    const { enter } = setup();
    expect(enter('C')).toBe('CIRCLE');
    expect(enter('o')).toBe('OFFSET');
    expect(enter('PL')).toBe('PLINE');
    expect(enter('LA')).toBe('LAYER');
    expect(enter('S')).toBe('STRETCH');
    expect(enter('H')).toBe('HATCH');
    expect(enter('LINE')).toBe('LINE');
    expect(enter('CIRC')).toBe('CIRCLE');
  });

  it('recalls a command run from the suggestions first, after browsing history', () => {
    const { cl, key, enter } = setup();
    enter('LINE');
    enter('CIRCLE');
    key('ArrowUp');
    expect(cl.input.value).toBe('CIRCLE');
    cl.input.value = 'ARC';
    cl.input.dispatchEvent(new Event('input'));
    key('Enter');
    cl.input.value = '';
    key('ArrowUp');
    expect(cl.input.value).toBe('ARC');
    key('ArrowUp');
    expect(cl.input.value).toBe('CIRCLE');
  });
});
