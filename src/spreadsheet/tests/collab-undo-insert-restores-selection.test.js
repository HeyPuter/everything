// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { editorView } from '../src/views/editor.js';
import { Doc } from '../src/lib/doc.js';
import { Workbook } from '../src/core/workbook.js';
import { RoomClient } from '../src/collab/client.js';
import { memoryOutbox } from '../src/collab/outbox.js';
import { closeMenu } from '../src/ui/menu.js';
import { environment, owner, SERVER } from './collab-helpers.js';

// Undoing Insert rows puts back the cells selected before it, and Redo selects the inserted rows again. In a
// shared workbook the history makes each step it takes back or brings again anew, so the selection is kept
// with the step through its Undo and Redo, not only with the step first recorded.
function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), clear: () => m.clear() };
}
Object.defineProperty(globalThis, 'localStorage', { value: memoryStorage(), configurable: true });

let view;
const clients = [];
beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal('requestAnimationFrame', (fn) => setTimeout(fn, 0));
  vi.stubGlobal('cancelAnimationFrame', clearTimeout);
  Element.prototype.scrollIntoView = () => {};
  Element.prototype.scrollTo = () => {};
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 800 });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 400 });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ measureText: (t) => ({ width: t.length * 7 }), font: '' });
  document.body.innerHTML = '<div id="app"></div>';
});
afterEach(() => {
  closeMenu();
  view?.destroy();
  view = null;
  for (const c of clients.splice(0)) c.close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

it('puts the selection back on Undo and on the inserted rows on Redo, again and again, in a shared workbook', async () => {
  const env = environment();
  const wb = new Workbook({ sheets: [{ name: 'Plan' }] });
  for (let r = 0; r < 6; r++) wb.setInput(wb.sheets[0].id, r, 1, String(r + 1));
  const room = await RoomClient.create({ puter: env.sdk(owner), server: SERVER, wb, name: 'Plan' });
  const mine = new RoomClient({ puter: env.sdk(owner), server: SERVER, room, store: memoryOutbox(), poll: 50, noPeers: true });
  clients.push(mine);
  await mine.open();
  const doc = Doc.forRoom(mine);
  view = editorView({ doc, goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn(), openLive: vi.fn() });
  document.getElementById('app').append(view.el);
  await new Promise((r) => setTimeout(r, 5));
  const s = mine.wb.sheets[0].id;
  const settle = () => new Promise((r) => setTimeout(r, 5));
  const selected = () => view.el.querySelector('.status-left .status-item').textContent;
  view.goTo('Plan!B3:B4');
  await new Promise((r) => setTimeout(r, 5));
  const before = selected();
  await view.run('insertRows', 'above');
  await settle();
  expect(mine.wb.getValue(s, 2, 1)).toBeNull();
  const after = selected();
  expect(after).not.toBe(before);
  for (let i = 0; i < 2; i++) {
    await view.run('undo');
    await settle();
    expect(mine.wb.getValue(s, 2, 1)).toBe(3);
    expect(selected()).toBe(before);
    await view.run('redo');
    await settle();
    expect(mine.wb.getValue(s, 2, 1)).toBeNull();
    expect(selected()).toBe(after);
  }
});
