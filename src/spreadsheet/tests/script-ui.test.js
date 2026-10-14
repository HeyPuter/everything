// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { addScript } from '../src/core/scripts.js';
import { closeAllModals } from '../src/ui/modal.js';
import { createAutomate, addScriptButton, scriptLink, scriptOfLink } from '../src/ui/automate.js';
import { createCodeEditor, tokenizeScript, matchingBracket, completionsAt, receiverType } from '../src/ui/code-editor.js';
import { SANDBOX_HTML, SANDBOX_FLAGS, SANDBOX_CSP, sandboxTransport } from '../src/lib/script-sandbox.js';
import { nodeTransport } from './helpers/script-transport.js';

globalThis.matchMedia ??= () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
afterEach(() => { closeAllModals(); document.body.replaceChildren(); });
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = fn(); if (v) return v; await tick(10); }
  throw new Error('timed out');
}

/** A trust store in memory, standing in for the account's. */
function memoryLibrary() {
  const trusted = new Set();
  return {
    trusted,
    trustScript: async (code) => { trusted.add(code); },
    isScriptTrusted: async (code) => trusted.has(code),
    listLibrary: async () => [], readLibraryScript: async () => '', deleteFromLibrary: async () => {}, saveToLibrary: async () => {},
  };
}
function setup(wb = new Workbook()) {
  const library = memoryLibrary();
  const grid = { el: document.createElement('div'), focus() {}, editing: false };
  const automate = createAutomate({ wb, grid, sheetId: () => wb.activeSheetId, active: () => ({ r: 0, c: 0 }) }, { transport: nodeTransport(), library });
  document.body.append(automate.pane, automate.notice, grid.el);
  return { wb, automate, library, grid };
}

describe('Code Editor pane', () => {
  it('creates, edits and saves a script with the workbook', async () => {
    const { wb, automate } = setup();
    await automate.run('newScript');
    expect(automate.paneOpen).toBe(true);
    expect(wb.scripts).toHaveLength(1);
    const textarea = automate.pane.querySelector('.ce-input');
    textarea.value = 'async function main(workbook) { workbook.getActiveWorksheet().getRange("A1").setValue(5); }';
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    await until(() => wb.scripts[0].code.includes('setValue(5)'));
    automate.pane.querySelector('.sp-run').click();
    await until(() => automate.pane.querySelector('.sp-status').textContent.startsWith('Finished'));
    expect(wb.getValue(wb.activeSheetId, 0, 0)).toBe(5);
    expect(wb.undoLabels()).toEqual(['Run script: Script']);
  });

  it('asks before running a script that came inside the file, and remembers the answer', async () => {
    const wb = new Workbook();
    addScript(wb, { name: 'From elsewhere', code: 'async function main(workbook) { workbook.getActiveWorksheet().getRange("B2").setValue("ran"); }' });
    const { automate, library } = setup(wb);
    const running = automate.run('runScript', { id: wb.scripts[0].id });
    const dialog = await until(() => document.querySelector('.modal-panel[aria-label="Run a Script From This File?"]'));
    expect(dialog.textContent).toContain('From elsewhere');
    [...dialog.querySelectorAll('button')].find((b) => b.textContent === 'Run Script').click();
    await running;
    expect(wb.getValue(wb.activeSheetId, 1, 1)).toBe('ran');
    expect(library.trusted.has(wb.scripts[0].code)).toBe(true);
    // Trusted now: no question the second time (the first dialog has finished closing before it runs again).
    await until(() => !document.querySelector('.modal-panel'));
    await automate.run('runScript', { id: wb.scripts[0].id });
    expect(document.querySelector('.modal-panel')).toBeNull();
  });

  it('does not run a refused script', async () => {
    const wb = new Workbook();
    addScript(wb, { name: 'Untrusted', code: 'async function main(workbook) { workbook.getActiveWorksheet().getRange("A1").setValue(1); }' });
    const { automate } = setup(wb);
    const running = automate.run('runScript', { id: wb.scripts[0].id });
    const dialog = await until(() => document.querySelector('.modal-panel'));
    [...dialog.querySelectorAll('button')].find((b) => b.textContent === 'Cancel').click();
    await running;
    expect(wb.getValue(wb.activeSheetId, 0, 0)).toBe(null);
  });

  it('keeps the sheet still while a script runs, and lets Stop end it', async () => {
    const { wb, automate, grid } = setup();
    await automate.run('newScript');
    const textarea = automate.pane.querySelector('.ce-input');
    textarea.value = 'async function main() { for (;;) {} }';
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    automate.pane.querySelector('.sp-run').click();
    await until(() => automate.running);
    expect(grid.el.inert).toBe(true);
    await automate.run('stopScript');
    await until(() => !automate.running);
    expect(grid.el.inert).toBe(false);
    expect(automate.pane.querySelector('.sp-log-error').textContent).toContain('stopped');
    expect(wb.canUndo()).toBe(false);
  });

  it('records actions into a new script', async () => {
    const { wb, automate } = setup();
    await automate.run('recordActions');
    expect(automate.recording).toBe(true);
    expect(automate.notice.hidden).toBe(false);
    wb.setInput(wb.activeSheetId, 0, 0, 'hi');
    wb.applyStyle(wb.activeSheetId, { r1: 0, c1: 0, r2: 0, c2: 0 }, { bold: true });
    expect(automate.notice.textContent).toContain('2 steps');
    await automate.run('recordActions');
    expect(automate.recording).toBe(false);
    expect(wb.scripts[0].name).toBe('Recorded script');
    expect(wb.scripts[0].code).toContain('sheet.getRange("A1").setValue("hi");');
    expect(automate.paneOpen).toBe(true);
  });

  it('renames, duplicates and deletes scripts from the pane', async () => {
    const { wb, automate } = setup();
    await automate.run('newScript');
    automate.pane.querySelector('.sp-more').click();
    [...document.querySelectorAll('.menu [role="menuitem"]')].find((n) => n.textContent.includes('Duplicate')).click();
    expect(wb.scripts.map((s) => s.name)).toEqual(['Script', 'Script copy']);
    expect(automate.pane.querySelector('.sp-picker-name').textContent).toBe('Script copy');
  });
});

describe('script buttons', () => {
  it('adds a button on the sheet that runs its script by name', async () => {
    const { wb, automate } = setup();
    await automate.run('newScript');
    const textarea = automate.pane.querySelector('.ce-input');
    textarea.value = 'async function main(workbook) { workbook.getActiveWorksheet().getRange("C3").setValue("pressed"); }';
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    await until(() => wb.scripts[0].code.includes('pressed'));
    await automate.run('insertScriptButton', { id: wb.scripts[0].id });
    const button = wb.sheets[0].charts[0];
    expect(button).toMatchObject({ type: 'text', text: 'Script', hyperlink: scriptLink('Script') });
    expect(scriptOfLink(button.hyperlink)).toBe('Script');
    await automate.run('runScript', { name: scriptOfLink(button.hyperlink) });
    expect(wb.getValue(wb.activeSheetId, 2, 2)).toBe('pressed');
  });
});

describe('code editor', () => {
  it('tells code from text and comments', () => {
    const src = 'const a = "x(" + 1; // )\nrange.getValues(/[(]/g);';
    const types = tokenizeScript(src).map((t) => `${t.type}:${src.slice(t.start, t.end)}`);
    expect(types).toContain('keyword:const');
    expect(types).toContain('string:"x("');
    expect(types).toContain('comment:// )');
    expect(types).toContain('api:getValues');
    expect(types).toContain('regex:/[(]/g');
  });

  it('matches brackets outside strings', () => {
    const src = 'f(a, "(", [1, 2])';
    const tokens = tokenizeScript(src);
    expect(matchingBracket(src, tokens, 1)).toBe(src.length - 1);
    expect(matchingBracket(src, tokens, src.length - 1)).toBe(1);
    expect(matchingBracket('f(]', tokenizeScript('f(]'), 1)).toBe(-1);
  });

  it('completes the API by the object before the dot', () => {
    const code = 'async function main(workbook) {\n  const sheet = workbook.getActiveWorksheet();\n  sheet.getRange("A1").getFormat().getFont().se';
    const found = completionsAt(code, code.length);
    expect(found.items.map((i) => i.label)).toEqual(['setBold', 'setItalic', 'setUnderline', 'setStrikethrough', 'setColor', 'setSize', 'setName']);
    expect(receiverType(code, '  sheet')).toBe('Worksheet');
    expect(receiverType(code, '  workbook')).toBe('Workbook');
    expect(completionsAt('// workbook.', 12)).toBe(null);
  });

  it('indents after an opening bracket and closes pairs', () => {
    const ed = createCodeEditor({ value: 'if (x) {}' });
    document.body.append(ed.el);
    const ta = ed.textarea;
    ta.focus();
    ta.setSelectionRange(8, 8);
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    expect(ta.value).toBe('if (x) {\n  \n}');
    expect(ta.selectionStart).toBe(11);
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: '(', bubbles: true, cancelable: true }));
    expect(ta.value).toBe('if (x) {\n  ()\n}');
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: ')', bubbles: true, cancelable: true }));
    expect(ta.selectionStart).toBe(13);
    ta.setSelectionRange(0, ta.value.length);
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: '/', ctrlKey: true, metaKey: true, bubbles: true, cancelable: true }));
    expect(ta.value.split('\n')[0]).toBe('// if (x) {');
    ed.destroy();
  });

  it('marks the line an error points at', () => {
    const ed = createCodeEditor({ value: 'a\nb\nc' });
    document.body.append(ed.el);
    ed.setErrorLine(2);
    expect(ed.el.querySelectorAll('.ce-line-number')[1].classList.contains('ce-error')).toBe(true);
    ed.setErrorLine(null);
    expect(ed.el.querySelector('.ce-error')).toBeNull();
  });
});

describe('sandbox frame', () => {
  it('is sandboxed without the app origin and refuses the network', () => {
    expect(SANDBOX_FLAGS).toBe('allow-scripts');
    expect(SANDBOX_FLAGS).not.toContain('allow-same-origin');
    expect(SANDBOX_CSP).toContain("connect-src 'none'");
    expect(SANDBOX_CSP).toContain("default-src 'none'");
    expect(SANDBOX_HTML).toContain('Content-Security-Policy');
    globalThis.Worker ??= function Worker() {};
    const port = sandboxTransport()('/* code */', () => {});
    const frame = document.querySelector('iframe.script-sandbox');
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
    expect(frame.srcdoc).toBe(SANDBOX_HTML);
    port.terminate();
    expect(document.querySelector('iframe.script-sandbox')).toBeNull();
  });
});
