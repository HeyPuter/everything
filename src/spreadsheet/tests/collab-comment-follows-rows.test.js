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
import { addComment, getThread } from '../src/core/comments.js';

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
  const openPath = vi.fn();
  view = editorView({ doc, goHome: vi.fn(), openPath, newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn(), openLive: vi.fn() });
  document.getElementById('app').append(view.el);
  return { env, room, mine, doc, join, openPath };
}

const typeIn = (area, text) => { area.focus(); area.value = text; area.dispatchEvent(new Event('input')); };

it('posts a comment being written on its cell when someone inserts rows above it meanwhile', async () => {
  const { mine, join } = await sharedEditor();
  const bob = await join(editor);
  const s = mine.wb.sheets[0].id;
  mine.wb.setInput(s, 4, 1, 'Budget');
  await until(() => bob.wb.getValue(s, 4, 1) === 'Budget', 4000, 'the cell to reach bob');
  view.goTo('Plan!B5');
  view.run('newComment');
  await until(() => document.querySelector('.comment-card textarea'), 2000, 'the card');
  typeIn(document.querySelector('.comment-card textarea'), 'Is this the final budget?');
  bob.wb.insertRows(s, 1, 2);
  await until(() => mine.wb.getValue(s, 6, 1) === 'Budget', 4000, 'the insertion');
  [...document.querySelectorAll('.comment-card button')].find((b) => b.textContent === 'Post').click();
  expect(getThread(mine.wb, s, 6, 1)?.items[0].text).toBe('Is this the final budget?');
  expect(getThread(mine.wb, s, 4, 1)).toBe(null);
});

it('keeps a reply being written on a thread when someone inserts rows above it meanwhile', async () => {
  const { mine, join } = await sharedEditor();
  const bob = await join(editor);
  const s = mine.wb.sheets[0].id;
  addComment(mine.wb, s, 4, 1, 'Is this final?', 'alice');
  await until(() => getThread(bob.wb, s, 4, 1), 4000, 'the thread to reach bob');
  view.goTo('Plan!B5');
  view.run('newComment');
  await until(() => document.querySelector('.comment-card .cmt-reply'), 2000, 'the card');
  typeIn(document.querySelector('.comment-card .cmt-reply'), 'Yes, signed off');
  bob.wb.insertRows(s, 1, 2);
  await until(() => getThread(mine.wb, s, 6, 1), 4000, 'the insertion');
  const reply = document.querySelector('.comment-card .cmt-reply');
  expect(reply?.value).toBe('Yes, signed off');
  document.querySelector('.comment-card .cmt-post').click();
  expect(getThread(mine.wb, s, 6, 1).items.map((i) => i.text)).toEqual(['Is this final?', 'Yes, signed off']);
});

it('keeps a reply being written in the Comments pane when someone inserts rows above its thread', async () => {
  const { mine, join } = await sharedEditor();
  const bob = await join(editor);
  const s = mine.wb.sheets[0].id;
  addComment(mine.wb, s, 4, 1, 'Is this final?', 'alice');
  await until(() => getThread(bob.wb, s, 4, 1), 4000, 'the thread to reach bob');
  view.run('toggleComments');
  await until(() => document.querySelector('.comments-pane .cmt-reply'), 2000, 'the pane');
  typeIn(document.querySelector('.comments-pane .cmt-reply'), 'Yes, signed off');
  bob.wb.insertRows(s, 1, 2);
  await until(() => getThread(mine.wb, s, 6, 1), 4000, 'the insertion');
  expect(document.querySelector('.comments-pane .cmt-reply').value).toBe('Yes, signed off');
});
