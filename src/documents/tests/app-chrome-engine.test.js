import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { documentContexts } from '../src/views/document-context-menu.js';
import { createDocx } from '../src/engine/docx.js';
import { TextDocument } from '../src/engine/model.js';
import { documentHtml, documentMarkdown, documentPlainText, headingLevel } from '../src/lib/document-export.js';
import { createEditCommands } from '../src/views/edit-commands.js';

vi.mock('../src/ui/toast.js', () => ({ toast: vi.fn(), announce: vi.fn() }));
vi.mock('../src/ui/modal.js', () => ({ openModal: vi.fn() }));

let dom;
beforeAll(() => { dom = new JSDOM(); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => dom.window.close());

function editor(text) {
  const pkg = createDocx();
  const model = new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets);
  model.replace(text);
  const engine = { model, session: { future: [], history: [], path: null }, viewOnly: false,
    execute(fn) { return fn() !== false; }, finishComposition() {}, focus() {}, redo: vi.fn(), selectMatch(m) { model.select(m.start, m.end); } };
  return { engine, pkg };
}

describe('Edit menu commands', () => {
  it('copies and pastes formatting, and Repeat runs the recorded command', () => {
    const { engine, pkg } = editor('Source target');
    const commands = createEditCommands({ editor: () => engine, pkg: () => pkg });
    engine.model.select(0, 6); engine.model.setRunFormat({ bold: true });
    commands.copyFormat();
    expect(commands.hasCopiedFormat()).toBe(true);
    engine.model.select(7, 13);
    expect(commands.pasteFormat()).toBe(true);
    expect(engine.model.runFormatting.bold).toBe(true);
    expect(commands.repeatLabel()).toBe('Paste Formatting');
    const run = vi.fn();
    commands.recordRepeat('Italic', run);
    expect(commands.canRepeat()).toBe(true);
    commands.redoOrRepeat();
    expect(run).toHaveBeenCalled();
    engine.session.future.push({});
    commands.redoOrRepeat();
    expect(engine.redo).toHaveBeenCalled();
  });
  it('clears formatting and contents, and finds the next match', () => {
    const { engine, pkg } = editor('one two one');
    const commands = createEditCommands({ editor: () => engine, pkg: () => pkg, searchQuery: () => 'one' });
    engine.model.select(0, 3); engine.model.setRunFormat({ italic: true });
    commands.clearFormatting();
    expect(engine.model.runFormatting.italic).toBe(false);
    engine.model.select(0, 3);
    expect(commands.findNext(1)).toBe(true);
    expect(engine.model.range).toEqual([8, 11]);
    expect(commands.findNext(-1)).toBe(true);
    expect(engine.model.range).toEqual([0, 3]);
    commands.clearContents();
    expect(engine.model.text).toBe(' two one');
  });
  it('refuses to change a view-only document', () => {
    const { engine, pkg } = editor('abc');
    engine.viewOnly = true;
    const commands = createEditCommands({ editor: () => engine, pkg: () => pkg });
    engine.model.select(0, 3);
    commands.clearContents();
    expect(engine.model.text).toBe('abc');
  });
});

describe('document context', () => {
  it('names where the caret is, most specific first', () => {
    const { engine } = editor('Plain text');
    expect(documentContexts(engine)).toEqual(['text']);
    engine.model.select(0, 5); engine.model.toggleList('bullet');
    expect(documentContexts(engine)).toEqual(['list', 'text']);
    expect(documentContexts(engine, { shapeSelected: true })).toEqual(['shape']);
  });
});

describe('text exports', () => {
  it('writes headings, lists, emphasis, links and tables', () => {
    const { engine } = editor('Title line\nFirst point\nSecond point\nBody with bold');
    const m = engine.model;
    m.select(0, 1); m.setParagraphStyle('Heading1');
    m.select(12, 30); m.toggleList('bullet');
    m.select(m.text.length - 4, m.text.length); m.setRunFormat({ bold: true });
    expect(headingLevel(m.paragraphs[0], m.styles)).toBe(1);
    const md = documentMarkdown(m);
    expect(md).toContain('# Title line');
    expect(md).toContain('- First point\n- Second point');
    expect(md).toContain('Body with **bold**');
    const html = documentHtml(m, { title: 'T <x>' });
    expect(html).toContain('<title>T &lt;x&gt;</title>');
    expect(html).toContain('<h1>Title line</h1>');
    expect(html).toContain('<ul><li>First point</li><li>Second point</li></ul>');
    expect(html).toContain('<strong>bold</strong>');
    expect(documentPlainText(m)).toBe('Title line\n•\tFirst point\n•\tSecond point\nBody with bold\n');
    m.select(m.text.length); m.insertTable(2, 2);
    expect(documentHtml(m)).toContain('<table><tr><td>');
    expect(documentMarkdown(m)).toContain('| --- | --- |');
  });
});
