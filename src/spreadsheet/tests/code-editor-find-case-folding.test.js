// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { createCodeEditor } from '../src/ui/code-editor.js';

globalThis.matchMedia ??= () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
afterEach(() => { document.body.replaceChildren(); });

// The script editor's Find, with Match case off, searched the code lowered with toLowerCase() and used those positions
// in the code itself. A letter that lowers to two characters (the Turkish İ becomes "i̇") put every match after it one
// place off: Find selected "et " for "let", and Replace all wrote over the wrong characters of the script.
describe('Find in the script editor, ignoring case', () => {
  const code = 'const city = "İstanbul";\nlet total = 1;\nlet LET = 2;';
  const find = (ed, text) => {
    const input = ed.el.querySelector('[aria-label="Find in script"] input, .ce-find-input');
    input.value = text;
    input.dispatchEvent(new Event('input'));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  };

  it('selects the match itself after a letter that changes length when lowered', () => {
    const ed = createCodeEditor({ value: code });
    document.body.append(ed.el);
    ed.openFind(false);
    find(ed, 'let');
    const ta = ed.textarea;
    expect(ta.value.slice(ta.selectionStart, ta.selectionEnd)).toBe('let');
    expect(ta.selectionStart).toBe(code.indexOf('let'));
  });

  it('replaces the matches and nothing else', () => {
    const ed = createCodeEditor({ value: code });
    document.body.append(ed.el);
    ed.openFind(true);
    find(ed, 'let');
    const replace = ed.el.querySelector('input[aria-label="Replace with"]');
    replace.value = 'var';
    [...ed.el.querySelectorAll('button')].find((b) => b.textContent === 'All').click();
    expect(ed.getValue()).toBe('const city = "İstanbul";\nvar total = 1;\nvar var = 2;');
  });
});
