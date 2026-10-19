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

const key = (target, k) => target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
const type = (editorEl, text) => {
  for (const ch of text) {
    const at = editorEl.selectionStart;
    editorEl.value = editorEl.value.slice(0, at) + ch + editorEl.value.slice(editorEl.selectionEnd);
    editorEl.setSelectionRange(at + 1, at + 1);
    editorEl.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: ch, bubbles: true }));
  }
};

it('puts what this person is typing in the cell they started in when someone inserts rows above it meanwhile', async () => {
  const { mine, join } = await sharedEditor();
  const bob = await join(editor);
  const s = mine.wb.sheets[0].id;
  bob.wb.setInput(s, 4, 1, 'B5 before');
  await until(() => mine.wb.getValue(s, 4, 1) === 'B5 before', 4000, 'the first edit');
  view.goTo('Plan!B5');
  const viewport = view.el.querySelector('.grid-viewport');
  const cellEditor = view.el.querySelector('.grid-editor');
  viewport.focus();
  key(viewport, 'F2');
  cellEditor.value = '';
  type(cellEditor, 'typed');
  bob.wb.insertRows(s, 1, 2);
  await until(() => mine.replica.rev === bob.replica.rev && mine.wb.getValue(s, 6, 1) === 'B5 before', 4000, 'insertion');
  key(cellEditor, 'Enter');
  await until(() => bob.wb.getValue(s, 6, 1) === 'typed' || bob.wb.getValue(s, 4, 1) === 'typed', 4000, 'the entry to arrive');
  // The entry replaced the cell it was typed in (now B7), not the empty one that moved under the editor.
  expect(mine.wb.getValue(s, 6, 1)).toBe('typed');
  expect(mine.wb.getValue(s, 4, 1)).toBe(null);
  // Enter went on from there, to the cell below it.
  expect(document.querySelector('input.name-box')?.value).toBe('B8');
});
