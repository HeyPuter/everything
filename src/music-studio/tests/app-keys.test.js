// App-wide keyboard handling and the undo history window.
import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest';
import { App } from '../src/app.js';
import { newProject } from '../src/model/demo.js';
import * as E from '../src/model/edits.js';
import { openHistory } from '../src/dialogs/tools.js';
import { closeWindows } from '../src/ui/windows.js';

const memory = () => {
  const m = new Map();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k) };
};

function start() {
  document.body.innerHTML = '<div id="app"></div>';
  return new App(document.getElementById('app'), { project: newProject(), storage: memory() }).start([]);
}

// No frame loop (jsdom has no canvas) and no scrolling.
const raf = globalThis.requestAnimationFrame;
beforeAll(() => {
  globalThis.requestAnimationFrame = () => 0;
  Element.prototype.scrollIntoView ||= () => {};
});
afterAll(() => {
  globalThis.requestAnimationFrame = raf;
});

afterEach(() => {
  closeWindows();
  document.body.innerHTML = '';
});

describe('app keyboard', () => {
  it('keeps app shortcuts that would reload the page from reaching the browser while typing', () => {
    const app = start();
    const input = document.createElement('input');
    document.body.append(input);
    input.focus();
    const panel = app.activePanel;
    const ev = new KeyboardEvent('keydown', { key: 'F5', code: 'F5', bubbles: true, cancelable: true });
    input.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    // The command itself does not run while typing.
    expect(app.activePanel).toBe(panel);
    // Plain typing is untouched.
    const k = new KeyboardEvent('keydown', { key: 'a', code: 'KeyA', bubbles: true, cancelable: true });
    input.dispatchEvent(k);
    expect(k.defaultPrevented).toBe(false);
  });

  it('does not bind the metronome to Mod+M (minimize on macOS)', () => {
    const app = start();
    expect(app.commands.get('options.metronome').keys).toEqual(['Alt+M']);
    expect(app.commands.lookup('Mod+M', 'playlist')).toBeFalsy();
  });
});

describe('undo history window', () => {
  it('opening it again reuses the window without subscribing again', () => {
    const app = start();
    let active = 0;
    const on = app.store.on.bind(app.store);
    app.store.on = (type, fn) => {
      const off = on(type, fn);
      if (type !== 'change') return off;
      active++;
      return () => {
        active--;
        off();
      };
    };
    const count = () => active;
    const before = count();
    const a = openHistory(app);
    const after = count();
    const b = openHistory(app);
    expect(b).toBe(a);
    expect(count()).toBe(after);
    a.close();
    expect(count()).toBe(before);
    app.store.apply('Tempo', (p) => E.setProjectProps(p, { bpm: 99 }));
  });
});
