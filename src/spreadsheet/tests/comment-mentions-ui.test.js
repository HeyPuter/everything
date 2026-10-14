// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { editorView } from '../src/views/editor.js';
import { Doc } from '../src/lib/doc.js';
import { getThread, addComment } from '../src/core/comments.js';
import { findMentions } from '../src/core/mentions.js';
import { closeAllModals } from '../src/ui/modal.js';
import * as P from '../src/lib/puter.js';

// A comment box lists people on @, the posted comment keeps whom it mentions and can assign the thread, the
// people mentioned are offered a share and told by email, and the card shows the mentions and the assignment.
function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), clear: () => m.clear() };
}
Object.defineProperty(globalThis, 'localStorage', { value: memoryStorage(), configurable: true });

let view;
let exec;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal('requestAnimationFrame', (fn) => setTimeout(fn, 0));
  vi.stubGlobal('cancelAnimationFrame', clearTimeout);
  Element.prototype.scrollIntoView = () => {};
  Element.prototype.scrollTo = () => {};
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 800 });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 400 });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ measureText: (t) => ({ width: t.length * 7 }), font: '' });
  // The email worker, as puter.workers.exec reaches it: every request is recorded and answered as sent.
  exec = vi.fn(async (url, init) => {
    const body = JSON.parse(init.body);
    return new Response(JSON.stringify({ ok: true, sent: body.recipients.length, failed: 0, results: body.recipients.map((r) => ({ email: r.email, status: 'sent' })) }));
  });
  vi.stubGlobal('puter', { workers: { exec }, fs: { share() {}, getShares() {} }, auth: { isSignedIn: () => true } });
  vi.spyOn(P, 'shareAccess').mockResolvedValue([{ who: 'user', recipient: 'ana', label: 'ana', mode: 'read' }]);
  vi.spyOn(P, 'shareFile').mockResolvedValue({});
  document.body.innerHTML = '<div id="app"></div>';
});
afterEach(() => { closeAllModals(); view?.destroy(); view = null; vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

const tick = () => vi.advanceTimersByTimeAsync(20);
const typeAt = (area, text) => {
  area.focus();
  area.value += text;
  area.setSelectionRange(area.value.length, area.value.length);
  area.dispatchEvent(new Event('input', { bubbles: true }));
};
const key = (area, k) => area.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));

it('mentions, assigns, shares with and emails the people named in a new comment', async () => {
  const doc = new Doc({ name: 'Budget', path: 'Spreadsheets/Budget.xlsx' });
  doc.uid = 'uid-3';
  const wb = doc.wb, id = wb.activeSheetId;
  view = editorView({ doc, goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn() });
  document.querySelector('#app').append(view.el);
  await tick();
  view.goTo('B2');
  view.run('newComment');
  await tick();
  const area = document.querySelector('.comment-card textarea');
  typeAt(area, 'Please check @');
  await tick();
  const options = [...document.querySelectorAll('.mention-list [role="option"]')].map((o) => o.querySelector('.mention-name').textContent);
  expect(options).toEqual(['ana']);
  key(area, 'Enter');
  typeAt(area, 'and @kim@example.org');
  await tick();
  key(area, 'Escape');
  // The box offers to assign the thread to the first person mentioned.
  const assign = document.querySelector('.comment-card .cmt-assign');
  expect(assign.hidden).toBe(false);
  expect(assign.textContent).toBe('Assign to ana');
  assign.querySelector('input').checked = true;
  [...document.querySelectorAll('.comment-card button')].find((b) => b.textContent === 'Post').click();
  await tick();

  const thread = getThread(wb, id, 1, 1);
  expect(thread.items[0].text).toBe('Please check @ana and @kim@example.org');
  expect(thread.items[0].mentions.map((m) => [m.name, m.user || m.email])).toEqual([['ana', 'ana'], ['kim@example.org', 'kim@example.org']]);
  expect(thread.assignee).toEqual({ name: 'ana', user: 'ana' });
  // One undo takes back the comment and its assignment together.
  expect(document.querySelectorAll('.comment-card .cmt-mention')).toHaveLength(2);
  expect(document.querySelector('.comment-card .cmt-assigned').textContent).toBe('Assigned to ana');

  // kim cannot open the file: the user is asked, and shares.
  await vi.waitFor(() => expect(document.querySelector('.mention-share')).toBeTruthy());
  [...document.querySelectorAll('.mention-share button')].find((b) => b.textContent === 'Share and notify').click();
  await vi.waitFor(() => expect(exec).toHaveBeenCalledTimes(2));
  expect(P.shareFile).toHaveBeenCalledWith('Spreadsheets/Budget.xlsx', 'kim@example.org', 'read');
  const bodies = exec.mock.calls.map(([url, init]) => [url, JSON.parse(init.body)]);
  expect(bodies.map(([url, b]) => [url, b.recipients.map((r) => r.email), !!b.assigned])).toEqual([
    ['https://spreadsheet-email.puter.work/mentions', ['kim@example.org'], false],
    ['https://spreadsheet-email.puter.work/mentions', ['ana@puter.email'], true],
  ]);
  expect(bodies[0][1].link).toMatch(/#\/file\/uid-3\?range=Sheet1!B2$/);
  expect(bodies[0][1].comment.cell).toBe('Sheet1!B2');

  wb.undo();
  await tick();
  expect(getThread(wb, id, 1, 1)).toBeNull();
});

it('keeps a mention through a reply and does not ask again for people who were told', async () => {
  const doc = new Doc({ name: 'Budget', path: 'Spreadsheets/Budget.xlsx' });
  doc.uid = 'uid-3';
  const wb = doc.wb, id = wb.activeSheetId;
  addComment(wb, id, 0, 0, '@ana first', 'demo', null, { mentions: findMentions('@ana first', [{ name: 'ana', user: 'ana' }]) });
  view = editorView({ doc, goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn() });
  document.querySelector('#app').append(view.el);
  await tick();
  view.goTo('A1');
  view.run('newComment');
  await tick();
  const reply = document.querySelector('.comment-card .cmt-reply');
  typeAt(reply, 'Thanks @an');
  await tick();
  key(reply, 'Enter');
  document.querySelector('.comment-card .cmt-post').click();
  await tick();
  await vi.waitFor(() => expect(exec).toHaveBeenCalledTimes(1));
  expect(document.querySelector('.mention-share')).toBeNull();
  expect(getThread(wb, id, 0, 0).items[1].mentions).toEqual([expect.objectContaining({ name: 'ana', user: 'ana', start: 7 })]);
});
