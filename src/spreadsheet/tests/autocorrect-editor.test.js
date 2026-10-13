// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { editorView } from '../src/views/editor.js';
import { Doc } from '../src/lib/doc.js';
import { closeMenu } from '../src/ui/menu.js';
import { closeAllModals } from '../src/ui/modal.js';
import { autoCorrectSettings, resetAutoCorrectCache, saveAutoCorrectSettings, createAutoCorrector } from '../src/ui/autocorrect.js';
import { DEFAULT_AUTOCORRECT } from '../src/core/autocorrect.js';
import { menubarMenus, menuLeaves } from '../src/ui/menubar.js';

function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), clear: () => m.clear(), key: (i) => [...m.keys()][i], get length() { return m.size; } };
}

let view;
beforeEach(() => {
  Object.defineProperty(globalThis, 'localStorage', { value: memoryStorage(), configurable: true });
  resetAutoCorrectCache();
  vi.useFakeTimers();
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal('requestAnimationFrame', (fn) => setTimeout(fn, 0));
  vi.stubGlobal('cancelAnimationFrame', clearTimeout);
  Element.prototype.scrollIntoView = () => {};
  Element.prototype.scrollTo = () => {};
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ measureText: (t) => ({ width: t.length * 7 }), font: '' });
  document.body.innerHTML = '<div id="app"></div>';
});
afterEach(() => { closeMenu(); closeAllModals(); view?.destroy(); view = null; vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

async function mount() {
  const doc = new Doc({ name: 'Notes', path: 'Spreadsheets/Notes.xlsx' });
  view = editorView({ doc, goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn() });
  document.querySelector('#app').append(view.el);
  await vi.advanceTimersByTimeAsync(1);
  const wb = doc.wb;
  const id = wb.activeSheetId;
  const editor = view.el.querySelector('.grid-editor');
  const viewport = view.el.querySelector('.grid-viewport');
  /** Type `text` into the open editor one character at a time, as input events. */
  const type = (text) => {
    for (const ch of text) {
      const at = editor.selectionStart;
      editor.value = editor.value.slice(0, at) + ch + editor.value.slice(editor.selectionEnd);
      editor.setSelectionRange(at + 1, at + 1);
      editor.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: ch, bubbles: true }));
    }
  };
  const key = (target, k, extra = {}) => target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...extra }));
  const begin = async () => { viewport.focus(); key(viewport, 'F2'); await vi.advanceTimersByTimeAsync(1); };
  return { wb, id, editor, type, key, begin };
}

describe('AutoCorrect while typing in a cell', () => {
  it('corrects a word as it ends, and Ctrl/Cmd+Z right after puts it back', async () => {
    const { editor, type, key, begin } = await mount();
    await begin();
    type('teh ');
    expect(editor.value).toBe('the ');
    key(editor, 'z', { ctrlKey: true, metaKey: true });
    expect(editor.value).toBe('teh ');
    type('cat');
    expect(editor.value).toBe('teh cat');
  });

  it('leaves formulas alone', async () => {
    const { editor, type, begin } = await mount();
    await begin();
    type('=teh ');
    expect(editor.value).toBe('=teh ');
  });

  it('corrects the last word on Enter as a step of its own, so one undo brings back what was typed', async () => {
    const { wb, id, editor, type, key, begin } = await mount();
    await begin();
    type('see you monday');
    key(editor, 'Enter');
    await vi.advanceTimersByTimeAsync(1);
    expect(wb.getValue(id, 0, 0)).toBe('see you Monday');
    expect(wb.undoLabels(2)).toEqual(['AutoCorrect', 'Edit cell']);
    wb.undo();
    expect(wb.getValue(id, 0, 0)).toBe('see you monday');
  });

  it('follows the settings: a rule switched off does nothing', async () => {
    saveAutoCorrectSettings({ ...DEFAULT_AUTOCORRECT, replaceText: false });
    const { editor, type, begin } = await mount();
    await begin();
    type('teh ');
    expect(editor.value).toBe('teh ');
  });
});

describe('AutoCorrect Options dialog', () => {
  it('is in the Tools menu', () => {
    expect(menuLeaves(menubarMenus({}).find((m) => m.id === 'tools').items).some((it) => it.cmd === 'autoCorrectOptions')).toBe(true);
  });

  it('adds a replacement and switches a rule, kept for the person', async () => {
    await mount();
    await view.run('autoCorrectOptions');
    const dialog = document.querySelector('.modal-panel[aria-label="AutoCorrect"]');
    const [from, to] = dialog.querySelectorAll('.autocorrect-fields input');
    from.value = 'btw';
    from.dispatchEvent(new Event('input', { bubbles: true }));
    to.value = 'by the way';
    to.dispatchEvent(new Event('input', { bubbles: true }));
    const add = [...dialog.querySelectorAll('button')].find((b) => b.textContent === 'Add');
    expect(add.disabled).toBe(false);
    add.click();
    expect(dialog.querySelector('.autocorrect-row[aria-selected="true"]').textContent).toContain('by the way');
    const days = [...dialog.querySelectorAll('label.check')].find((l) => l.textContent.includes('names of days')).querySelector('input');
    days.checked = false;
    dialog.querySelector('form').dispatchEvent(new Event('submit', { cancelable: true }));
    resetAutoCorrectCache();
    const saved = autoCorrectSettings();
    expect(saved.replacements).toContainEqual({ from: 'btw', to: 'by the way' });
    expect(saved.dayNames).toBe(false);
  });

  it('picks an existing entry as its name is typed, and deletes it', async () => {
    await mount();
    await view.run('autoCorrectOptions');
    const dialog = document.querySelector('.modal-panel[aria-label="AutoCorrect"]');
    const [from, to] = dialog.querySelectorAll('.autocorrect-fields input');
    from.value = 'teh';
    from.dispatchEvent(new Event('input', { bubbles: true }));
    expect(to.value).toBe('the');
    [...dialog.querySelectorAll('button')].find((b) => b.textContent === 'Delete').click();
    dialog.querySelector('form').dispatchEvent(new Event('submit', { cancelable: true }));
    expect(autoCorrectSettings().replacements.some((e) => e.from === 'teh')).toBe(false);
  });
});

describe('the corrector', () => {
  it('does not correct again a word put back in the same entry when the entry is committed', () => {
    const input = document.createElement('textarea');
    document.body.append(input);
    const corrector = createAutoCorrector({ settings: () => DEFAULT_AUTOCORRECT });
    input.value = 'teh ';
    input.setSelectionRange(4, 4);
    expect(corrector.input(input, ' ')).toBe(true);
    expect(corrector.undo(input)).toBe(true);
    expect(corrector.tail('teh ')).toBe('teh ');
    corrector.reset();
    expect(corrector.tail('teh ')).toBe('the ');
  });
});
