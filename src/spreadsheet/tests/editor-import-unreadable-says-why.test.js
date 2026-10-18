// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { editorView } from '../src/views/editor.js';
import { Doc } from '../src/lib/doc.js';
import { toast } from '../src/ui/toast.js';

vi.mock('../src/ui/toast.js', () => ({ toast: vi.fn() }));
const PASSWORD = 'This workbook is protected with a password. Remove the password in the program that set it, then open the file here';
vi.mock('../src/core/io.js', async (original) => ({
  ...(await original()),
  workbookFromFile: vi.fn(async () => { throw Object.assign(new Error(PASSWORD), { code: 'unreadable' }); }),
}));

// Import ▸ from a file said only "Could not read Payroll.xlsx" for a file locked with a password, cut short
// or too large, where opening the same file says what is wrong.
let view;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal('requestAnimationFrame', (fn) => setTimeout(fn, 0));
  vi.stubGlobal('cancelAnimationFrame', clearTimeout);
  Element.prototype.scrollIntoView = () => {}; Element.prototype.scrollTo = () => {};
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 800 });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 400 });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ measureText: (t) => ({ width: t.length * 7 }), font: '' });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  document.body.replaceChildren();
});
afterEach(() => { view?.destroy(); view = null; vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

it('says why the file could not be imported', async () => {
  const importFile = vi.fn();
  view = editorView({ doc: new Doc({ name: 'Import' }), goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile });
  document.body.append(view.el);
  await vi.advanceTimersByTimeAsync(1);
  const file = Object.assign(new File([new Uint8Array([1, 2, 3])], 'Payroll.xlsx'), { arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer });
  // Of the two spreadsheet pickers, Open hands the file to the router and Import reads it here.
  for (const input of [...view.el.querySelectorAll('input[type="file"]')].filter((i) => i.accept.includes('.xlsx'))) {
    Object.defineProperty(input, 'files', { configurable: true, value: [file] });
    input.dispatchEvent(new Event('change'));
    await vi.advanceTimersByTimeAsync(10);
  }
  expect(toast).toHaveBeenCalledWith(PASSWORD, expect.objectContaining({ icon: 'alert' }));
  expect(toast).not.toHaveBeenCalledWith('Could not read Payroll.xlsx', expect.anything());
});
