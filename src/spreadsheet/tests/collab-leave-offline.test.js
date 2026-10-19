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

// The outbox stands for IndexedDB here, which outlasts the page.
async function sharedEditor(user = owner, role = 'editor') {
  const env = environment();
  const wb = new Workbook({ sheets: [{ name: 'Plan' }] });
  wb.setInput(wb.sheets[0].id, 0, 0, 'Task');
  const room = await RoomClient.create({ puter: env.sdk(owner), server: SERVER, wb, name: 'Plan' });
  const join = async (u) => {
    const token = u.uuid === owner.uuid ? undefined : (await call(env.sdk(owner), SERVER, { op: 'invite', room, role: u === viewer ? 'viewer' : role })).token;
    const client = new RoomClient({ puter: env.sdk(u), server: SERVER, room, token, store: { ...memoryOutbox(), durable: true }, poll: 50, noPeers: true });
    clients.push(client);
    await client.open();
    return client;
  };
  const mine = await join(user);
  const doc = Doc.forRoom(mine);
  const openPath = vi.fn();
  view = editorView({ doc, goHome: vi.fn(), openPath, newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn(), openLive: vi.fn() });
  document.getElementById('app').append(view.el);
  return { env, room, mine, doc, join, openPath };
}

it('leaving a shared workbook while offline says the changes wait in this browser, not that they are lost', async () => {
  const { env, mine } = await sharedEditor();
  env.offline = true;
  mine.wb.setInput(mine.wb.sheets[0].id, 3, 1, 'offline edit');
  await until(() => mine.status.state === 'offline', 4000, 'offline');
  const leaving = view.flush();
  await until(() => document.querySelector('.modal-panel[aria-label="Could not save"]'), 4000, 'the question');
  const dialog = document.querySelector('.modal-panel[aria-label="Could not save"]');
  expect(dialog.textContent).toMatch(/kept in this browser, and sent to the shared workbook when you open it here again/);
  expect(dialog.textContent).not.toMatch(/discards them/);
  expect([...dialog.querySelectorAll('button')].map((b) => b.textContent.trim())).toContain('Leave');
  [...dialog.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Leave').click();
  expect(await leaving).toBe(true);
  // They are in the outbox, to be sent when the workbook is next opened.
  expect((await mine.o.store.get(mine.outboxKey))?.pending?.length).toBe(1);
});

it('leaving a shared workbook its owner stopped sharing says the changes made since cannot be kept', async () => {
  const { env, mine, room } = await sharedEditor(editor);
  await call(env.sdk(owner), SERVER, { op: 'stop', room });
  mine.wb.setInput(mine.wb.sheets[0].id, 3, 1, 'too late');
  await until(() => mine.status.state === 'error', 4000, 'the room to close');
  const leaving = view.flush();
  await until(() => document.querySelector('.modal-panel[aria-label="Could not save"]'), 4000, 'the question');
  expect(document.querySelector('.modal-panel[aria-label="Could not save"]').textContent).toMatch(/Leaving now discards them/);
  document.querySelector('.modal-panel[aria-label="Could not save"] .btn-ghost').click();
  expect(await leaving).toBe(false);
});

it('leaves a shared workbook untouched since it was opened without asking, though the connection dropped', async () => {
  const { env, mine } = await sharedEditor();
  env.offline = true;
  await mine.checkIn().catch(() => {});
  await until(() => mine.status.state === 'offline', 4000, 'offline');
  const asked = until(() => document.querySelector('.modal-panel'), 4000, 'a question').then(() => document.querySelector('.modal-panel').textContent, () => 'quiet');
  expect(await Promise.race([view.flush(), asked])).toBe(true);
  expect(document.querySelector('.modal-panel')).toBe(null);
});
