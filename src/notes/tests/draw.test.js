import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Store } from '../src/data/store.js';
import { memoryBackend } from '../src/data/backend.js';
import { App } from '../src/ui/app.js';
import { closeAllMenus } from '../src/ui/menu.js';
import { setPref } from '../src/ui/prefs.js';

let app;
let ink;
let scrolled;

beforeEach(async () => {
  document.body.innerHTML = '<div id="app"></div><div id="live-region"></div>';
  localStorage.clear();
  setPref('zoom', 1); // pinching saves the zoom
  const store = new Store(memoryBackend(), { saveDelay: 0 });
  await store.load({ defaultName: "sam's Notebook" });
  app = new App(document.getElementById('app'), { store, user: { username: 'sam' }, env: 'web', onSignOut: () => {} });
  await app.start();
  ink = app.editor.ink;
  ink.overlay.setPointerCapture = () => {};
  scrolled = [0, 0];
  app.editor.scroller.scrollBy = (x, y) => {
    scrolled[0] += x;
    scrolled[1] += y;
  };
  app.setTool('pen');
});

afterEach(() => {
  closeAllMenus();
  app.destroy();
});

// jsdom has no PointerEvent: a mouse event carrying the pointer fields.
function pointer(type, id, pointerType, x, y, extra = {}) {
  const e = new MouseEvent(type, { clientX: x, clientY: y, bubbles: true, cancelable: true, button: extra.button ?? 0, buttons: extra.buttons ?? 0 });
  Object.defineProperties(e, { pointerId: { value: id }, pointerType: { value: pointerType }, pressure: { value: 0.5 } });
  ink.overlay.dispatchEvent(e);
}

describe('drawing with fingers and pens', () => {
  it('turns a two-finger touch into a scroll instead of two strokes', () => {
    pointer('pointerdown', 11, 'touch', 300, 300);
    pointer('pointermove', 11, 'touch', 305, 300);
    pointer('pointerdown', 12, 'touch', 400, 300);
    for (let i = 1; i <= 5; i++) {
      pointer('pointermove', 11, 'touch', 305, 300 - i * 10);
      pointer('pointermove', 12, 'touch', 400, 300 - i * 10);
    }
    pointer('pointerup', 11, 'touch', 305, 250);
    pointer('pointerup', 12, 'touch', 400, 250);
    expect(app.editor.page.ink.length).toBe(0);
    expect(ink.layer.querySelectorAll('path').length).toBe(0);
    expect(scrolled[1]).toBeGreaterThan(40);
  });

  it('pinches to zoom', () => {
    pointer('pointerdown', 11, 'touch', 300, 300);
    pointer('pointerdown', 12, 'touch', 400, 300);
    pointer('pointermove', 11, 'touch', 250, 300);
    pointer('pointermove', 12, 'touch', 450, 300);
    expect(app.editor.zoom).toBe(2);
  });

  it('ignores a palm resting on the screen while the pen writes', () => {
    pointer('pointerdown', 2, 'pen', 100, 100);
    pointer('pointerdown', 11, 'touch', 300, 300);
    pointer('pointermove', 11, 'touch', 320, 320);
    pointer('pointermove', 2, 'pen', 150, 120);
    pointer('pointerup', 11, 'touch', 320, 320);
    pointer('pointerup', 2, 'pen', 150, 120);
    expect(app.editor.page.ink.length).toBe(1);
    expect(ink.layer.querySelectorAll('path').length).toBe(1);
  });

  it('drops a palm stroke when the pen lands after it', () => {
    pointer('pointerdown', 11, 'touch', 300, 300);
    pointer('pointermove', 11, 'touch', 320, 320);
    pointer('pointerdown', 2, 'pen', 100, 100);
    pointer('pointermove', 2, 'pen', 150, 120);
    pointer('pointerup', 2, 'pen', 150, 120);
    pointer('pointerup', 11, 'touch', 320, 320);
    expect(app.editor.page.ink.length).toBe(1);
    expect(ink.layer.querySelectorAll('path').length).toBe(1);
  });

  it('still draws with one finger', () => {
    pointer('pointerdown', 11, 'touch', 300, 300);
    pointer('pointermove', 11, 'touch', 320, 320);
    pointer('pointerup', 11, 'touch', 320, 320);
    expect(app.editor.page.ink.length).toBe(1);
  });
});

describe('pen eraser', () => {
  it("erases with the pen's eraser end whatever the tool", () => {
    app.editor.page.ink.push({ id: 's1', type: 'stroke', color: '#000', width: 3, highlighter: false, points: [[0, 50, 0.5], [100, 50, 0.5]] });
    ink.render();
    pointer('pointerdown', 2, 'pen', 40, 30, { button: 5, buttons: 32 });
    pointer('pointermove', 2, 'pen', 40, 70, { buttons: 32 });
    pointer('pointerup', 2, 'pen', 40, 70, { button: 5 });
    expect(app.editor.page.ink.length).toBe(0);
  });
});
