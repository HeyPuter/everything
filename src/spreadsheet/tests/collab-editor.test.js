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

async function sharedEditor(user = owner, role = 'editor') {
  const env = environment();
  const wb = new Workbook({ sheets: [{ name: 'Plan' }] });
  wb.setInput(wb.sheets[0].id, 0, 0, 'Task');
  const room = await RoomClient.create({ puter: env.sdk(owner), server: SERVER, wb, name: 'Plan' });
  const join = async (u) => {
    const token = u.uuid === owner.uuid ? undefined : (await call(env.sdk(owner), SERVER, { op: 'invite', room, role: u === viewer ? 'viewer' : role })).token;
    const client = new RoomClient({ puter: env.sdk(u), server: SERVER, room, token, store: memoryOutbox(), poll: 50, noPeers: true });
    clients.push(client);
    await client.open();
    return client;
  };
  const mine = await join(user);
  const doc = Doc.forRoom(mine);
  view = editorView({ doc, goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn(), openLive: vi.fn() });
  document.getElementById('app').append(view.el);
  return { env, room, mine, doc, join };
}

it('shows who is here beside Share, their selections on the grid and their sheet on the tabs', async () => {
  const { mine, join } = await sharedEditor();
  const bob = await join(editor);
  const sheet = bob.wb.sheets[0].id;
  bob.setPresence({ sheet, sel: { r1: 1, c1: 1, r2: 3, c2: 2 }, active: { r: 1, c: 1 } });
  await bob.checkIn();
  await mine.checkIn();
  await until(() => document.querySelector('.collab-avatar'), 4000, 'avatar');
  const avatar = document.querySelector('.collab-avatar');
  expect(avatar.textContent).toBe('B');
  expect(avatar.getAttribute('aria-label')).toMatch(/^bob, can edit, at Plan!B2:C4/);
  await until(() => document.querySelector('.peer-sel'), 4000, 'outline');
  expect(document.querySelector('.peer-flag').textContent).toBe('bob');
  expect(document.querySelector('.tab-peers')?.getAttribute('aria-label')).toBe('Here: bob');
  expect(document.querySelector('.save-status').textContent).toMatch(/Live/);
  // A click on the avatar goes to bob's selection.
  avatar.click();
  expect(document.querySelector('.formula-bar, .namebox, input[aria-label="Name Box"]')).toBeTruthy();
});

it('shows a remote edit and undoes only this person\'s', async () => {
  const { mine, join } = await sharedEditor();
  const bob = await join(editor);
  const s = mine.wb.sheets[0].id;
  mine.wb.setInput(s, 2, 0, 'mine');
  bob.wb.setInput(s, 3, 0, 'theirs');
  await until(() => mine.wb.getValue(s, 3, 0) === 'theirs' && bob.wb.getValue(s, 2, 0) === 'mine', 4000, 'edits');
  mine.wb.undo();
  await until(() => bob.wb.getValue(s, 2, 0) === null, 4000, 'undo to arrive');
  expect(mine.wb.getValue(s, 3, 0)).toBe('theirs');
});

it('takes back a viewer\'s edit and says why', async () => {
  const { mine } = await sharedEditor(viewer);
  expect(document.querySelector('.save-status').textContent).toMatch(/View only/);
  mine.wb.setInput(mine.wb.sheets[0].id, 4, 4, 'nope');
  expect(mine.wb.getValue(mine.wb.sheets[0].id, 4, 4)).toBe(null);
  await until(() => toast.mock.calls.some(([text]) => /view this shared workbook/.test(text)), 2000, 'notice');
});

it('keeps this person\'s selection on its cells when someone inserts rows above it', async () => {
  const { mine, join } = await sharedEditor();
  const bob = await join(editor);
  const s = mine.wb.sheets[0].id;
  view.goTo('Plan!B5:C6');
  bob.wb.insertRows(s, 1, 2);
  await until(() => mine.replica.rev === bob.replica.rev && mine.replica.rev > 0, 4000, 'insertion');
  // The name box shows the selection, two rows further down now.
  await until(() => document.querySelector('input.name-box')?.value === 'B7:C8', 4000, 'selection to follow');
  expect(mine.wb.getValue(s, 0, 0)).toBe('Task');
});
