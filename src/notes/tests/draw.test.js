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

describe('lost pointer', () => {
  it('finishes the stroke when the overlay loses the pointer', () => {
    pointer('pointerdown', 1, 'mouse', 100, 100);
    pointer('pointermove', 1, 'mouse', 150, 120);
    pointer('lostpointercapture', 1, 'mouse', 150, 120);
    expect(app.editor.page.ink.length).toBe(1);
    // The next press starts a new stroke instead of extending the old one.
    pointer('pointerdown', 1, 'mouse', 100, 300);
    pointer('pointermove', 1, 'mouse', 150, 320);
    pointer('pointerup', 1, 'mouse', 150, 320);
    expect(app.editor.page.ink.length).toBe(2);
  });
});

describe('restyling selected ink', () => {
  const stroke = (id, y) => ({ id, type: 'stroke', color: '#1f1f1f', width: 2.5, highlighter: false, points: [[0, y, 0.5], [100, y, 0.5]] });

  it('recolors and re-widths selected ink as one undo step each, keeping the tool and selection', async () => {
    const ed = app.editor;
    ed.page.ink.push(stroke('a', 10), stroke('b', 40), { id: 'c', type: 'shape', kind: 'rect', color: '#1f1f1f', width: 2, x1: 0, y1: 100, x2: 50, y2: 150 });
    ed.changed();
    ink.render();
    app.setTool('lasso');
    ink.select(['a', 'c']);
    const steps = ed.history.index;
    app.setPen({ ...ink.pen, color: '#c42b1c', id: 'custom' }, { color: '#c42b1c' });
    expect(ed.page.ink.map((i) => i.color)).toEqual(['#c42b1c', '#1f1f1f', '#c42b1c']);
    expect(ed.page.ink.map((i) => i.width)).toEqual([2.5, 2.5, 2]);
    app.setPen({ ...ink.pen, width: 24, id: 'custom' }, { width: 24 });
    expect(ed.page.ink.map((i) => i.width)).toEqual([24, 2.5, 8]); // shapes keep their limit
    expect(ink.tool).toBe('lasso');
    expect([...ink.selected]).toEqual(['a', 'c']);
    expect(ink.layer.querySelector('[data-id="a"]').getAttribute('fill')).toBe('#c42b1c');
    expect(ed.history.index).toBe(steps + 2);
    await ed.undo();
    expect(ed.page.ink.map((i) => i.width)).toEqual([2.5, 2.5, 2]);
    expect(ed.page.ink[0].color).toBe('#c42b1c');
  });

  it('applies a whole pen from the gallery, and just picks the pen with nothing selected', () => {
    const ed = app.editor;
    ed.page.ink.push(stroke('a', 10));
    ink.render();
    ink.select(['a']);
    app.setPen({ id: 'hl-yellow', color: '#ffe500', width: 16, highlighter: true });
    expect(ed.page.ink[0]).toMatchObject({ color: '#ffe500', width: 16, highlighter: true });
    expect(ink.pen.id).toBe('hl-yellow');
    ink.clearSelection();
    app.setTool('type');
    app.setPen({ id: 'pen-blue', color: '#1c5fd4', width: 2.5, highlighter: false });
    expect(ink.tool).toBe('pen');
    expect(ed.page.ink[0].color).toBe('#ffe500');
  });
});

describe('page size', () => {
  it('shrinks the page again after erasing the ink that grew it', () => {
    const ed = app.editor;
    ed.page.ink.push({ id: 'far', type: 'stroke', color: '#000', width: 3, highlighter: false, points: [[100, 2000, 0.5], [100, 2100, 0.5]] });
    ink.render();
    ed.layout();
    expect(parseFloat(ed.pageEl.style.height)).toBeGreaterThan(2100);
    app.setTool('eraser');
    pointer('pointerdown', 1, 'mouse', 80, 2050);
    pointer('pointermove', 1, 'mouse', 120, 2050);
    pointer('pointerup', 1, 'mouse', 120, 2050);
    expect(ed.page.ink).toHaveLength(0);
    expect(parseFloat(ed.pageEl.style.height)).toBeLessThan(1000);
  });
});

describe('moving selected ink with the keyboard', () => {
  it('moves selected ink with the arrow keys like containers, as one undo step', async () => {
    const ed = app.editor;
    ed.page.ink.push({ id: 'a', type: 'stroke', color: '#000', width: 2, highlighter: false, points: [[100, 200, 0.5], [150, 200, 0.5]] }, { id: 'b', type: 'shape', kind: 'line', color: '#000', width: 2, x1: 300, y1: 300, x2: 350, y2: 300 });
    ed.changed();
    ink.render();
    app.setTool('lasso');
    ink.select(['a']);
    ed.scroller.focus();
    const steps = ed.history.index;
    const key = (k, shift = false) => ed.scroller.dispatchEvent(new KeyboardEvent('keydown', { key: k, shiftKey: shift, bubbles: true, cancelable: true }));
    key('ArrowRight');
    key('ArrowDown', true);
    expect(ed.page.ink[0].points[0]).toEqual([110, 201, 0.5]);
    expect(ed.page.ink[1].x1).toBe(300);
    expect(ink.layer.querySelector('[data-id="a"]').classList.contains('ink-selected')).toBe(true);
    await new Promise((r) => setTimeout(r, 450));
    expect(ed.history.index).toBe(steps + 1);
    // Stops at the page's left edge instead of moving off it.
    for (let i = 0; i < 20; i++) key('ArrowLeft');
    expect(ed.page.ink[0].points[0][0]).toBeGreaterThanOrEqual(0);
  });
});
