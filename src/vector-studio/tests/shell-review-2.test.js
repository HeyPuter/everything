// Regression tests from the second shell review (keyboard, menus, focus, shortcuts).
import { describe, it, expect, afterEach } from 'vitest';

afterEach(() => {
  document.querySelectorAll('.menu, dialog').forEach((m) => m.remove());
});

async function appWithRect() {
  const { bootAppWithFeatures } = await import('./helpers.js');
  const { createPath } = await import('../src/model/nodes.js');
  const { rectangle } = await import('../src/model/shapes.js');
  const app = await bootAppWithFeatures();
  const ed = app.newDocument({ name: 'Keys' });
  let id;
  ed.doc.transact('Build', () => {
    const p = createPath(rectangle(100, 100, 80, 60), true);
    ed.doc.insert(p, ed.doc.layers()[0].id);
    id = p.id;
  });
  ed.select([id]);
  return { app, ed, id };
}

describe('arrow keys on sliders', () => {
  it('move the Navigator zoom slider instead of nudging the selection', async () => {
    const { app, ed, id } = await appWithRect();
    app.openPanel('navigator');
    const slider = document.querySelector('.panel-flyout input[type="range"]');
    expect(slider).toBeTruthy();
    slider.focus();
    const ev = new KeyboardEvent('keydown', {
      key: 'ArrowLeft',
      code: 'ArrowLeft',
      bubbles: true,
      cancelable: true,
    });
    slider.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
    expect(ed.doc.get(id).anchors[0].x).toBe(100);
    // On the canvas the arrow keys still nudge.
    app.canvasHost.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'ArrowLeft',
        code: 'ArrowLeft',
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(ed.doc.get(id).anchors[0].x).toBe(99);
  });
});
