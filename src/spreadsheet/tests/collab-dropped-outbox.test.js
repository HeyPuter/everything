// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { editorView } from '../src/views/editor.js';
import { Doc } from '../src/lib/doc.js';
import { Workbook } from '../src/core/workbook.js';
import { RoomClient } from '../src/collab/client.js';
import { memoryOutbox } from '../src/collab/outbox.js';
import { call } from '../src/collab/api.js';
import { closeMenu } from '../src/ui/menu.js';
import { toast } from '../src/ui/toast.js';

vi.mock('../src/ui/toast.js', async (original) => { const m = await original(); return { ...m, toast: vi.fn(() => ({ dismiss() {} })) }; });
import { environment, owner, editor, viewer, SERVER, until } from './collab-helpers.js';

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

it('says that changes kept from an earlier visit could not be shared once the person may only view', async () => {
  const env = environment();
  const wb = new Workbook({ sheets: [{ name: 'Plan' }] });
  const room = await RoomClient.create({ puter: env.sdk(owner), server: SERVER, wb, name: 'Plan' });
  const token = (await call(env.sdk(owner), SERVER, { op: 'invite', room, role: 'editor' })).token;
  const store = memoryOutbox();
  const first = new RoomClient({ puter: env.sdk(editor), server: SERVER, room, token, store, poll: 50, noPeers: true });
  clients.push(first);
  await first.open();
  // Offline, Bob changes a cell and closes the tab: the change waits in this browser.
  env.offlineUsers.add(editor.uuid);
  first.wb.setInput(first.wb.sheets[0].id, 0, 0, 'offline edit');
  await until(async () => (await store.get(first.outboxKey))?.pending?.length === 1, 4000, 'the outbox');
  first.close();
  // Meanwhile the owner made Bob a viewer.
  await call(env.sdk(owner), SERVER, { op: 'role', room, uuid: editor.uuid, role: 'viewer' });
  env.offlineUsers.delete(editor.uuid);
  const again = new RoomClient({ puter: env.sdk(editor), server: SERVER, room, store, poll: 50, noPeers: true });
  clients.push(again);
  await again.open();
  expect(again.dropped).toBe(1);
  expect(again.wb.getValue(again.wb.sheets[0].id, 0, 0)).toBe(null);
  view = editorView({ doc: Doc.forRoom(again), goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn(), openLive: vi.fn() });
  document.getElementById('app').append(view.el);
  expect(toast).toHaveBeenCalledWith('A change you made here earlier could not be shared: you can only view this workbook now. Ask its owner for edit access', expect.anything());
});
