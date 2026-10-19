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
  const openPath = vi.fn();
  view = editorView({ doc, goHome: vi.fn(), openPath, newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn(), openLive: vi.fn() });
  document.getElementById('app').append(view.el);
  return { env, room, mine, doc, join, openPath };
}

it('opens Share for someone a shared workbook was shared with: who is in it, and its link', async () => {
  await sharedEditor(editor);
  view.run('share');
  await until(() => document.querySelector('.modal-panel .collab-share'), 2000, 'the dialog');
  const dialog = document.querySelector('.modal-panel');
  expect(dialog.getAttribute('aria-label')).toBe('Share "Plan"');
  expect(dialog.textContent).toMatch(/Its owner decides who has access/);
  await until(() => dialog.querySelectorAll('.collab-members .share-row').length === 2, 2000, 'the members');
  expect([...dialog.querySelectorAll('.collab-members .version-when')].map((n) => n.textContent)).toEqual(['alice', 'bob (you)']);
  expect([...dialog.querySelectorAll('.share-dialog button')].map((b) => b.textContent.trim())).toEqual(['Copy link', 'Done']);
  // Nothing about the owner's file, which is not theirs to share.
  expect(dialog.querySelector('.share-add')).toBe(null);
  expect(dialog.querySelector('.collab-share').textContent).not.toMatch(/false/);
  expect(toast).not.toHaveBeenCalledWith(expect.stringMatching(/Save the spreadsheet first/), expect.anything());
});

it('says where a shared workbook\'s version history is kept, for someone it was shared with', async () => {
  await sharedEditor(editor);
  view.run('versions');
  await until(() => toast.mock.calls.length, 2000, 'the notice');
  expect(toast.mock.calls.map(([text]) => text)).toEqual(['Version history is kept with the owner’s file. Ask the owner to restore an earlier version']);
  expect(document.querySelector('.modal-panel')).toBe(null);
});
