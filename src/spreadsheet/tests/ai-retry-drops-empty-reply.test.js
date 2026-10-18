// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { createAiPanel } from '../src/ui/aipanel.js';
import * as P from '../src/lib/puter.js';
import { memoryStorage } from './helpers/memory-storage.js';

// A reply that failed before it said anything (the service busy, say) stayed in the chat once Try again was
// pressed: an empty message above the reply tried again, a blank gap on screen and a lone "The assistant said:"
// read out with nothing after it. It goes now; a failed reply that had said or done something stays.
Object.defineProperty(globalThis, 'localStorage', { value: memoryStorage(), configurable: true });
vi.mock('../src/ui/toast.js', () => ({ toast: vi.fn() }));

let panel;
const stream = (parts) => (async function* s() { for (const p of parts) yield p; })();
const failing = () => (async function* fail() { throw new Error('The AI service is busy'); })();
const settle = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0)); };

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', (fn) => setTimeout(fn, 0));
  vi.stubGlobal('plausible', vi.fn());
  vi.spyOn(P, 'canAI').mockReturnValue(true);
  localStorage.clear();
  document.body.innerHTML = '';
  const wb = new Workbook();
  const id = wb.activeSheetId;
  const env = { sheetId: () => id, selection: () => ({ sheetId: id, range: { r1: 0, c1: 0, r2: 0, c2: 0 } }), select: vi.fn(() => true) };
  panel = createAiPanel({ wb, doc: { name: 'Test' }, subscribe: () => () => {}, grid: { focus() {}, editing: false }, run: vi.fn() }, env);
  document.body.append(panel.el);
  panel.open();
});
afterEach(() => { panel.destroy(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function send(text) {
  const input = panel.el.querySelector('textarea');
  input.value = text;
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await settle();
}

it('drops a reply that failed before saying anything when it is tried again', async () => {
  let n = 0;
  vi.spyOn(P, 'aiChatStream').mockImplementation(() => (n++ === 0 ? failing() : stream([{ type: 'text', text: 'Here it is.' }])));
  await send('summarize');
  expect(panel.el.querySelectorAll('.ai-assistant')).toHaveLength(1);
  panel.el.querySelector('.ai-retry').click();
  await settle();
  const replies = [...panel.el.querySelectorAll('.ai-assistant')];
  expect(replies).toHaveLength(1);
  expect(replies[0].textContent).toContain('Here it is.');
});

it('keeps a failed reply that had said something', async () => {
  let n = 0;
  vi.spyOn(P, 'aiChatStream').mockImplementation(() => (n++ === 0
    ? (async function* partly() { yield { type: 'text', text: 'Let me look' }; throw new Error('The AI service is busy'); })()
    : stream([{ type: 'text', text: 'Here it is.' }])));
  await send('summarize');
  panel.el.querySelector('.ai-retry').click();
  await settle();
  const replies = [...panel.el.querySelectorAll('.ai-assistant')];
  expect(replies).toHaveLength(2);
  expect(replies[0].textContent).toContain('Let me look');
  expect(replies[0].querySelector('.ai-error')).toBeNull();
});
