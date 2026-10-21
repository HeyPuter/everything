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
import { addComment } from '../src/core/comments.js';
import { session } from '../src/lib/session.js';
import { findMentions } from '../src/core/mentions.js';

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

// Someone who joined a shared workbook through its link has no file of it (the file is its owner's): the editor kept
// the mentions this person had seen by the file's id or address, and with neither it never looked. A comment from a
// co-author that mentioned them arrived without a word, and the co-author had been told they would see it here.
it('tells someone who joined a shared workbook when a co-author mentions them in a comment', async () => {
  const env = environment();
  const wb = new Workbook({ sheets: [{ name: 'Plan' }] });
  const room = await RoomClient.create({ puter: env.sdk(owner), server: SERVER, wb, name: 'Plan' });
  const join = async (u, token) => {
    const client = new RoomClient({ puter: env.sdk(u), server: SERVER, room, token, store: memoryOutbox(), poll: 50, noPeers: true });
    clients.push(client);
    await client.open();
    return client;
  };
  const alice = await join(owner);
  const bob = await join(editor, (await call(env.sdk(owner), SERVER, { op: 'invite', room, role: 'editor' })).token);
  const saved = session.user;
  session.user = { username: 'bob' };
  try {
    view = editorView({ doc: Doc.forRoom(bob), goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn(), openLive: vi.fn() });
    document.getElementById('app').append(view.el);
    const s = alice.wb.sheets[0].id;
    addComment(alice.wb, s, 1, 1, '@bob can you check this?', 'alice', null, { mentions: findMentions('@bob can you check this?', [{ name: 'bob', user: 'bob' }]) });
    await until(() => toast.mock.calls.some(([text]) => /alice mentioned you on Plan!B2/.test(text)), 6000, 'the mention to be told');
  } finally { session.user = saved; }
});
