import { expect, it } from 'vitest';
import { bootAppWithFeatures } from './helpers.js';
import { setArrangement } from '../src/features/workspace/window.js';

function pointer(target, type, x, y) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y });
  Object.defineProperty(event, 'pointerId', { value: 1 });
  target.dispatchEvent(event);
}

it.each(['pointerup', 'pointercancel', 'lostpointercapture'])('stops dragging a floating window after %s', async (ending) => {
  const app = await bootAppWithFeatures();
  const ed = app.newDocument();
  setArrangement(app, null, { float: true });
  const host = app.views.get(ed).host;
  const head = host.querySelector('.float-head');
  try {
    pointer(head, 'pointerdown', 10, 10);
    pointer(head, 'pointermove', 50, 60);
    expect([host.style.left, host.style.top]).toEqual(['40px', '50px']);
    pointer(head, ending, 50, 60);
    pointer(head, 'pointermove', 200, 200);
    expect([host.style.left, host.style.top]).toEqual(['40px', '50px']);
    // A fresh drag still works and ends normally.
    pointer(head, 'pointerdown', 60, 70);
    pointer(head, 'pointermove', 80, 100);
    expect([host.style.left, host.style.top]).toEqual(['20px', '30px']);
    pointer(head, 'pointerup', 80, 100);
    pointer(head, 'pointermove', 300, 300);
    expect([host.style.left, host.style.top]).toEqual(['20px', '30px']);
  } finally {
    await app.closeDocument(ed, { force: true });
  }
});
