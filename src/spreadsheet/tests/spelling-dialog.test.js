// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { editorView } from '../src/views/editor.js';
import { Doc } from '../src/lib/doc.js';
import { closeMenu } from '../src/ui/menu.js';
import { closeAllModals } from '../src/ui/modal.js';
import { customWords } from '../src/ui/spelling.js';
import { autoCorrectSettings, resetAutoCorrectCache } from '../src/ui/autocorrect.js';
import { createLanguagePane } from '../src/ui/language-pane.js';
import { parseThesaurus, replaceInText, lookupWord, matchCase } from '../src/core/thesaurus.js';
import { Workbook } from '../src/core/workbook.js';
import { menubarMenus, menuLeaves } from '../src/ui/menubar.js';

function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), clear: () => m.clear(), key: (i) => [...m.keys()][i], get length() { return m.size; } };
}

beforeEach(() => {
  Object.defineProperty(globalThis, 'localStorage', { value: memoryStorage(), configurable: true });
  resetAutoCorrectCache();
  Element.prototype.scrollIntoView = () => {};
  Element.prototype.scrollTo = () => {};
});
afterEach(() => { closeMenu(); closeAllModals(); document.body.replaceChildren(); });

describe('the Spelling dialog', () => {
  let view;
  beforeEach(() => {
    vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
    vi.stubGlobal('requestAnimationFrame', (fn) => setTimeout(fn, 0));
    vi.stubGlobal('cancelAnimationFrame', clearTimeout);
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ measureText: (t) => ({ width: t.length * 7 }), font: '' });
    document.body.innerHTML = '<div id="app"></div>';
  });
  afterEach(() => { view?.destroy(); view = null; vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  async function mount(cells) {
    const doc = new Doc({ name: 'Notes', path: 'Spreadsheets/Notes.xlsx' });
    const wb = doc.wb;
    const id = wb.activeSheetId;
    for (const [ref, text] of Object.entries(cells)) { const c = ref.charCodeAt(0) - 65, r = Number(ref.slice(1)) - 1; wb.setInput(id, r, c, text); }
    wb.clearHistory();
    view = editorView({ doc, goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn() });
    document.querySelector('#app').append(view.el);
    await new Promise((r) => setTimeout(r, 5));
    await view.run('spelling');
    const dialog = document.querySelector('.modal-panel[aria-label="Spelling"]');
    const button = (label) => [...dialog.querySelectorAll('button')].find((b) => b.textContent === label);
    const word = () => dialog.querySelector('.spell-word')?.textContent ?? null;
    return { wb, id, dialog, button, word };
  }

  it('is reached from the Tools menu and F7', () => {
    const leaf = menuLeaves(menubarMenus({}).find((m) => m.id === 'tools').items).find((it) => it.cmd === 'spelling');
    expect(leaf.shortcut).toBe('F7');
  });

  it('walks the misspelt words, changing one and ignoring another', async () => {
    const { wb, id, dialog, button, word } = await mount({ A1: 'Please recieve teh goods', A2: 'all good', A3: 'a wierd idea' });
    expect(word()).toBe('recieve');
    expect(dialog.querySelector('.spell-where').textContent).toBe('Sheet1!A1');
    expect(dialog.querySelector('input[aria-label="Change to"]').value).toBe('receive');
    button('Change').click();
    expect(wb.getValue(id, 0, 0)).toBe('Please receive teh goods');
    expect(word()).toBe('teh');
    button('Ignore Once').click();
    expect(word()).toBe('wierd');
    expect(dialog.querySelector('.spell-sentence').textContent).toBe('a wierd idea');
    button('Ignore Once').click();
    expect(dialog.querySelector('.spell-status').textContent).toMatch(/complete/);
    expect(wb.undoLabels()).toEqual(['Spelling']);
  });

  it('changes every occurrence at once with Change All, as one step', async () => {
    const { wb, id, button } = await mount({ A1: 'teh cat', B2: 'teh dog and teh bird' });
    button('Change All').click();
    expect(wb.getValue(id, 0, 0)).toBe('the cat');
    expect(wb.getValue(id, 1, 1)).toBe('the dog and the bird');
    expect(wb.undoLabels()).toEqual(['Spelling']);
  });

  it('adds a word to the person’s dictionary and a fix to AutoCorrect', async () => {
    const { button, word, dialog } = await mount({ A1: 'Puterly recieve' });
    expect(word()).toBe('Puterly');
    button('Add to Dictionary').click();
    expect(customWords()).toContain('Puterly');
    expect(word()).toBe('recieve');
    dialog.querySelector('input[aria-label="Change to"]').value = 'receive';
    button('AutoCorrect').click();
    expect(autoCorrectSettings().replacements).toContainEqual({ from: 'recieve', to: 'receive' });
  });

  it('says when there is nothing to check', async () => {
    const { dialog } = await mount({ A1: '=1+1', A2: '12' });
    expect(dialog.querySelector('.spell-status').textContent).toMatch(/no text to check/);
  });
});

describe('the thesaurus answer', () => {
  it('is read from JSON, even wrapped in prose or a code fence', () => {
    const reply = 'Here you go:\n```json\n{"senses":[{"pos":"Adjective","meaning":"feeling joy","synonyms":["glad","cheerful","glad"],"antonyms":["sad"]},{"pos":"noun","meaning":"x","synonyms":[],"antonyms":[]}]}\n```';
    expect(parseThesaurus(reply)).toEqual([{ pos: 'adjective', meaning: 'feeling joy', synonyms: ['glad', 'cheerful'], antonyms: ['sad'] }]);
    expect(parseThesaurus('no idea')).toEqual([]);
  });

  it('puts a word in place of another, cased the same', () => {
    expect(replaceInText('Happy', 'happy', 'glad')).toBe('Glad');
    expect(replaceInText('We are HAPPY today', 'happy', 'glad')).toBe('We are GLAD today');
    expect(replaceInText('unhappy', 'happy', 'glad')).toBeNull();
    expect(matchCase('Big', 'large')).toBe('Large');
    expect(lookupWord('  quick  ')).toBe('quick');
    expect(lookupWord('This is a long sentence about many things')).toBe('This');
  });
});

describe('the language pane', () => {
  function setup({ ai = null, translate = null } = {}) {
    const wb = new Workbook();
    const id = wb.activeSheetId;
    let active = { r: 0, c: 0 };
    let ranges = [{ r1: 0, c1: 0, r2: 0, c2: 0 }];
    const ctx = {
      wb, sheetId: () => id, active: () => active, ranges: () => ranges, activeCell: () => wb.getCell(id, active.r, active.c),
      grid: { focus() {} }, announce() {}, ai, translate,
    };
    const pane = createLanguagePane(ctx);
    document.body.append(pane.el);
    return { wb, id, pane, select: (r1, c1, r2 = r1, c2 = c1) => { active = { r: r1, c: c1 }; ranges = [{ r1, c1, r2, c2 }]; } };
  }
  const settle = () => new Promise((r) => setTimeout(r, 0));

  it('looks up the active cell’s word and puts a synonym in its place', async () => {
    const ai = vi.fn(async () => JSON.stringify({ senses: [{ pos: 'adjective', meaning: 'large in size', synonyms: ['large', 'huge'], antonyms: ['small'] }] }));
    const { wb, id, pane } = setup({ ai });
    wb.setInput(id, 0, 0, 'Big');
    pane.show('thesaurus', { fromCell: true });
    await settle();
    expect(ai).toHaveBeenCalledWith(expect.stringContaining('Big'));
    const words = [...pane.el.querySelectorAll('.thesaurus-word')].map((b) => b.textContent);
    expect(words).toEqual(['large', 'huge', 'small']);
    pane.el.querySelector('[aria-label="Insert huge"]').click();
    expect(wb.getValue(id, 0, 0)).toBe('Huge');
    expect(wb.undoLabels()[0]).toBe('Thesaurus');
  });

  it('says so when there is no AI', () => {
    const { pane } = setup();
    pane.show('thesaurus');
    pane.lookup('word');
    expect(pane.el.querySelector('.lang-status').textContent).toMatch(/needs Puter/);
  });

  it('translates the selected cells and puts each translation back in its cell, as one step', async () => {
    const translate = vi.fn(async (text, from, to) => `${text} (${to})`);
    const { wb, id, pane, select } = setup({ translate });
    wb.setInput(id, 0, 0, 'hello');
    wb.setInput(id, 1, 0, 'world');
    wb.setInput(id, 2, 0, '=1');
    wb.clearHistory();
    select(0, 0, 2, 0);
    const to = pane.el.querySelector('select[aria-label="To"]');
    to.value = 'French';
    to.dispatchEvent(new Event('change'));
    pane.show('translate', { fromCell: true });
    await settle(); await settle();
    expect(translate).toHaveBeenCalledWith('hello', '', 'French');
    expect(pane.el.querySelector('.lang-output').textContent).toBe('hello (French)world (French)');
    const replace = [...pane.el.querySelectorAll('button')].find((b) => b.textContent === 'Replace cells');
    replace.click();
    expect(wb.getValue(id, 0, 0)).toBe('hello (French)');
    expect(wb.getValue(id, 1, 0)).toBe('world (French)');
    expect(wb.undoLabels()).toEqual(['Translate']);
  });

  it('translates typed text into the active cell', async () => {
    const translate = vi.fn(async () => 'hola');
    const { wb, id, pane } = setup({ translate });
    pane.show('translate');
    const source = pane.el.querySelector('textarea');
    source.value = 'hello';
    source.dispatchEvent(new Event('input'));
    [...pane.el.querySelectorAll('button')].find((b) => b.textContent === 'Translate').click();
    await settle(); await settle();
    [...pane.el.querySelectorAll('button')].find((b) => b.textContent === 'Insert').click();
    expect(wb.getValue(id, 0, 0)).toBe('hola');
  });
});
