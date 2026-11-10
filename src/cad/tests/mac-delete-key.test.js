// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';

const platform = vi.hoisted(() => ({ mod: 'Cmd' }));
vi.mock('../src/io/storage.js', () => ({ recovery: {} }));
vi.mock('../src/ui/dom.js', async (original) => {
  const dom = await original();
  return {
    ...dom,
    get MOD() {
      return platform.mod;
    },
  };
});
const { App } = await import('../src/app.js');

function setup({ typed = '', busy = false } = {}) {
  const ran = [];
  const app = Object.create(App.prototype);
  const canvas = document.createElement('canvas');
  const input = document.createElement('input');
  document.body.append(canvas, input);
  app.editor = { busy, cancel() {} };
  app.cmdline = { input, value: () => typed, textSelected: () => false, setValue() {} };
  app.ribbon = { flyoutOpen: false };
  app.shell = { overlay: canvas };
  app.doc = { selection: new Set(['a']) };
  app.run = (name) => ran.push(name);
  const press = (key, target = canvas) => {
    const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
    Object.defineProperty(e, 'target', { value: target });
    app.onKey(e);
    return ran.slice();
  };
  return { app, press, input };
}

describe('erasing the selection from the keyboard', () => {
  it('uses the delete key of a Mac keyboard (Backspace)', () => {
    platform.mod = 'Cmd';
    expect(setup().press('Backspace')).toEqual(['ERASE']);
    expect(setup().press('Delete')).toEqual(['ERASE']);
  });

  it('leaves Backspace alone while typing, during a command and with nothing selected', () => {
    platform.mod = 'Cmd';
    const typing = setup();
    expect(typing.press('Backspace', typing.input)).toEqual([]);
    expect(setup({ typed: 'LIN' }).press('Backspace')).toEqual([]);
    expect(setup({ busy: true }).press('Backspace')).toEqual([]);
    const none = setup();
    none.app.doc.selection.clear();
    expect(none.press('Backspace')).toEqual([]);
  });

  it('keeps Backspace out of it on other keyboards, which have a Delete key', () => {
    platform.mod = 'Ctrl';
    expect(setup().press('Backspace')).toEqual([]);
    expect(setup().press('Delete')).toEqual(['ERASE']);
  });
});
