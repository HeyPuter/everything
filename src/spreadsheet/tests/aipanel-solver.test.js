// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { createAiPanel } from '../src/ui/aipanel.js';
import * as P from '../src/lib/puter.js';
import { memoryStorage } from './helpers/memory-storage.js';

Object.defineProperty(globalThis, 'localStorage', { value: memoryStorage(), configurable: true });
vi.mock('../src/ui/toast.js', () => ({ toast: vi.fn() }));

// The Solver works over several frames and hands back a promise: the panel waits for it, and the model reads its result.
describe('the assistant running the Solver', () => {
  let wb, id, panel;
  const stream = (parts) => (async function* s() { for (const p of parts) yield p; })();

  beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', (fn) => setTimeout(fn, 0));
    vi.stubGlobal('plausible', vi.fn());
    vi.spyOn(P, 'canAI').mockReturnValue(true);
    localStorage.clear();
    document.body.innerHTML = '';
    wb = new Workbook();
    id = wb.activeSheetId;
    // max 3x + 5y with x <= 4, 2y <= 12, 3x + 2y <= 18, from blank variable cells B1:B2.
    wb.setInput(id, 0, 2, '=2*B2');
    wb.setInput(id, 1, 2, '=3*B1+2*B2');
    wb.setInput(id, 3, 1, '=3*B1+5*B2');
    wb.clearHistory();
    const env = { sheetId: () => id, selection: () => ({ sheetId: id, range: { r1: 0, c1: 0, r2: 0, c2: 0 } }), select: vi.fn(() => true) };
    const ctx = { wb, doc: { name: 'Test' }, subscribe: () => () => {}, grid: { focus() {}, editing: false }, run: vi.fn() };
    panel = createAiPanel(ctx, env);
    document.body.append(panel.el);
    panel.open();
  });
  afterEach(() => { panel.destroy(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it('waits for the solve and gives the model its result', async () => {
    let n = 0;
    vi.spyOn(P, 'aiChatStream').mockImplementation(() => stream(n++ === 0
      ? [{ type: 'tool', id: 's', name: 'solve', input: { objective: 'B4', variables: 'B1:B2', method: 'simplex', constraints: [{ cell: 'B1', relation: '<=', value: 4 }, { cell: 'C1', relation: '<=', value: 12 }, { cell: 'C2', relation: '<=', value: 18 }] } }]
      : [{ type: 'text', text: 'The best profit is 36.' }]));
    const input = panel.el.querySelector('textarea');
    input.value = 'Maximize the profit';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    for (let i = 0; i < 40 && P.aiChatStream.mock.calls.length < 2; i++) await new Promise((r) => setTimeout(r, 5));
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
    expect(wb.getValue(id, 3, 1)).toBeCloseTo(36, 9);
    const result = P.aiChatStream.mock.calls[1][0].find((m) => m.role === 'tool');
    expect(JSON.parse(result.content).status).toBe('optimal');
    const step = panel.el.querySelector('.ai-step');
    expect(step.textContent).toContain('Solve: maximize Sheet1!B4 by changing Sheet1!B1:B2');
    expect(step.querySelector('button.ai-step-label').title).toBe('Select Sheet1!B1:B2');
    expect(step.classList.contains('ai-step-done')).toBe(true);
  });
});
