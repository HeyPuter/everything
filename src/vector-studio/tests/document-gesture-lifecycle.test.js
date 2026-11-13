import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { bootApp } from './helpers.js';
import { createPath } from '../src/model/nodes.js';
import { rectangle } from '../src/model/shapes.js';

let app, first, second, clock = 1000;
const ptr = (x, y, extra = {}) => ({ pointerId: 1, pointerType: 'mouse', button: 0,
  clientX: x, clientY: y, timeStamp: clock += 1000, ...extra });
beforeEach(() => {
  app = bootApp();
  first = app.newDocument();
  second = app.newDocument();
  app.activate(first);
  for (const ed of [first, second]) ed.view.set({ zoom: 1, panX: 0, panY: 0, rotation: 0, width: 1000, height: 800 });
});
afterEach(async () => {
  vi.useRealTimers();
  for (const ed of [...app.editors]) await app.closeDocument(ed, { force: true });
});

it('cancels an unfinished selection drag before changing documents', () => {
  const shape = createPath(rectangle(100, 100, 100, 100), true, { fill: { type: 'solid', color: '#f00' } });
  first.doc.transact('Shape', () => first.doc.insert(shape, first.targetLayer().id));
  first.select([shape.id]);
  app.input.down(ptr(150, 150));
  app.input.move(ptr(180, 180));
  app.input.move(ptr(200, 200));
  expect(first.doc.tx).toBeTruthy();
  app.activate(second);
  expect(first.doc.tx).toBeFalsy();
  expect(first.doc.get(shape.id).anchors).toEqual(shape.anchors);
  expect(app.input.active).toBeNull();
  app.input.move(ptr(240, 240));
  app.input.up(ptr(240, 240));
  expect(second.doc.leaves()).toHaveLength(0);
  expect(second.doc.tx).toBeFalsy();
});

it('drops a deferred touch and its hold timer when changing documents', () => {
  vi.useFakeTimers();
  app.setTool('rectangle');
  app.input.down(ptr(100, 100, { pointerType: 'touch' }));
  expect(app.input.pendingTouch).toBeTruthy();
  app.activate(second);
  vi.advanceTimersByTime(100);
  expect(app.input.active).toBeNull();
  vi.advanceTimersByTime(500);
  expect(app.input.active).toBeNull();
  expect(app.input.pointers.size).toBe(0);
  app.input.move(ptr(200, 200, { pointerType: 'touch' }));
  app.input.up(ptr(200, 200, { pointerType: 'touch' }));
  expect(second.doc.leaves()).toHaveLength(0);
});

it('ends a middle-button pan before changing documents', () => {
  app.input.down(ptr(100, 100, { button: 1 }));
  app.input.move(ptr(150, 150, { button: 1 }));
  app.activate(second);
  const pan = [second.view.panX, second.view.panY];
  app.input.move(ptr(300, 300, { button: 1 }));
  expect([second.view.panX, second.view.panY]).toEqual(pan);
});

it('finishes a lone Pen anchor in its document before closing the active window', async () => {
  const sibling = app.addDocument(first.doc, { activate: false });
  app.setTool('pen');
  app.input.down(ptr(100, 100));
  app.input.up(ptr(100, 100));
  expect(first.doc.leaves()).toHaveLength(1);
  await app.closeDocument(first, { force: true });
  expect(sibling.doc.leaves()).toHaveLength(0);
  expect(sibling.doc.tx).toBeFalsy();
  expect(app.input.active).toBeNull();
});

it('clears pinch and temporary Hand state before changing documents', () => {
  const touch = { pointerType: 'touch' };
  app.input.down(ptr(100, 100, touch));
  app.input.down(ptr(200, 200, { ...touch, pointerId: 2 }));
  expect(app.input.gesture).toBeTruthy();
  app.activate(second);
  app.input.move(ptr(400, 400, touch));
  expect(second.view.zoom).toBe(1);
  expect(app.input.gesture).toBeNull();
  app.input.spaceDown = true;
  app.input.setTempTool(app.getTool('hand'));
  app.input.down(ptr(100, 100));
  app.input.move(ptr(150, 150));
  app.activate(first);
  const pan = [first.view.panX, first.view.panY];
  app.input.move(ptr(300, 300));
  app.input.up(ptr(300, 300));
  expect([first.view.panX, first.view.panY]).toEqual(pan);
  expect(app.input.tempTool).toBeNull();
  expect(app.input.spaceDown).toBe(false);
});

it('preserves completed Pen segments and keeps the next document editable', () => {
  app.setTool('pen');
  for (const [x, y] of [[100, 100], [200, 200]]) {
    app.input.down(ptr(x, y));
    app.input.up(ptr(x, y));
  }
  app.activate(second);
  expect(first.doc.leaves()[0].anchors).toHaveLength(2);
  expect(first.doc.tx).toBeFalsy();
  app.setTool('rectangle');
  app.input.down(ptr(100, 100));
  app.input.move(ptr(200, 200));
  app.input.up(ptr(200, 200));
  expect(second.doc.leaves()).toHaveLength(1);
  second.doc.undo();
  expect(second.doc.leaves()).toHaveLength(0);
});

it('keeps the active document editable after cancelling its close prompt', async () => {
  app.setTool('rectangle');
  app.input.down(ptr(100, 100));
  app.input.move(ptr(200, 200));
  app.input.up(ptr(200, 200));
  const closing = app.closeDocument(first);
  const dialog = document.querySelector('dialog[open]');
  expect(dialog).toBeTruthy();
  [...dialog.querySelectorAll('button')].find((b) => b.textContent === 'Cancel').click();
  expect(await closing).toBe(false);
  expect(app.editor).toBe(first);
  app.input.down(ptr(300, 300));
  app.input.move(ptr(400, 400));
  app.input.up(ptr(400, 400));
  expect(first.doc.leaves()).toHaveLength(2);
});

it('closing an inactive document does not interrupt the active drawing', async () => {
  app.setTool('rectangle');
  app.input.down(ptr(100, 100));
  app.input.move(ptr(200, 200));
  await app.closeDocument(second, { force: true });
  expect(app.input.active).toBeTruthy();
  app.input.up(ptr(200, 200));
  expect(first.doc.leaves()).toHaveLength(1);
  expect(first.doc.tx).toBeFalsy();
});
