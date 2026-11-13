import { expect, it } from 'vitest';
import { bootAppWithFeatures } from './helpers.js';
import { setArrangement } from '../src/features/workspace/window.js';

function pointer(target, type, id, x, y, button = 0) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button });
  Object.defineProperty(event, 'pointerId', { value: id });
  target.dispatchEvent(event);
}

it.each([1, 2])('does not drag floating windows with mouse button %s', async (button) => {
  const app = await bootAppWithFeatures();
  const ed = app.newDocument();
  setArrangement(app, null, { float: true });
  const host = app.views.get(ed).host;
  const head = host.querySelector('.float-head');
  const original = [host.style.left, host.style.top];
  try {
    pointer(head, 'pointerdown', 1, 10, 10, button);
    pointer(head, 'pointermove', 1, 70, 80, button);
    expect([host.style.left, host.style.top]).toEqual(original);
  } finally {
    await app.closeDocument(ed, { force: true });
  }
});

it.each(['pointerup', 'pointercancel', 'lostpointercapture'])('ignores another pointer’s movement and %s during a floating drag', async (ending) => {
  const app = await bootAppWithFeatures();
  const ed = app.newDocument();
  setArrangement(app, null, { float: true });
  const host = app.views.get(ed).host;
  const head = host.querySelector('.float-head');
  try {
    pointer(head, 'pointerdown', 1, 10, 10);
    pointer(head, 'pointermove', 1, 50, 60);
    expect([host.style.left, host.style.top]).toEqual(['40px', '50px']);
    pointer(head, 'pointerdown', 2, 100, 100);
    pointer(head, 'pointermove', 2, 200, 200);
    expect.soft([host.style.left, host.style.top]).toEqual(['40px', '50px']);
    pointer(head, ending, 2, 200, 200);
    pointer(head, 'pointermove', 1, 70, 90);
    expect.soft([host.style.left, host.style.top]).toEqual(['60px', '80px']);
    pointer(head, 'pointerup', 1, 70, 90);
    pointer(head, 'pointermove', 1, 300, 300);
    expect([host.style.left, host.style.top]).toEqual(['60px', '80px']);
  } finally {
    await app.closeDocument(ed, { force: true });
  }
});
