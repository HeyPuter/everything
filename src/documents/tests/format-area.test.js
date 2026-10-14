// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { emptyStyles } from '../src/engine/styles.js';
import { TextDocument, paragraph } from '../src/engine/model.js';
import { lineChoice, lineSetting } from '../src/views/paragraph-dialog.js';
import { spokenText, joinDictation, createDictation } from '../src/views/dictate.js';
import { shadingValue } from '../src/views/borders-shading.js';
import { fontCondition } from '../src/views/find-replace.js';
import { splitLevelText } from '../src/views/list-dialogs.js';
import { openChangeCase, describeStyle } from '../src/views/format-misc-dialogs.js';
import { createFormatArea } from '../src/views/format-area.js';
import { closeAllModals } from '../src/ui/modal.js';

vi.mock('../src/ui/toast.js', () => ({ toast: vi.fn(), announce: vi.fn() }));
beforeEach(() => { vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {} })); document.body.replaceChildren(el('div', 'app')); });
// Closing dialogs finishes after their exit animation; let those timers run before the DOM goes away.
afterEach(async () => { closeAllModals(); await new Promise(resolve => setTimeout(resolve, 250)); document.body.replaceChildren(); vi.unstubAllGlobals(); });
function el(tag, id) { const node = document.createElement(tag); if (id) node.id = id; return node; }

// jsdom's typed arrays come from another realm, so these documents are built without a DOCX package.
function documentWith(lines) {
  const styles = emptyStyles();
  styles.definitions.Normal = { id: 'Normal', type: 'paragraph', name: 'Normal', basedOn: null, next: null, properties: {}, reference: {}, run: {} };
  styles.definitions.Heading1 = { id: 'Heading1', type: 'paragraph', name: 'heading 1', basedOn: 'Normal', next: 'Normal', properties: { keepNext: true, outlineLevel: 0 }, reference: {}, run: { bold: true, fontSize: 20 } };
  styles.defaultParagraph = 'Normal';
  return new TextDocument(lines.map(line => paragraph(line)), undefined, undefined, styles);
}
/** An engine stand-in with the surface the format area uses. */
function fakeEngine(model) {
  return { model, session: { revision: 0, path: null }, input: el('textarea'), finishComposition() {}, focus() {}, execute(action, fail) { try { action(); this.session.revision++; return true; } catch (e) { fail?.(e); return false; } },
    setParagraphStyle(id) { this.execute(() => model.setParagraphStyle(id)); }, setCharacterStyle(id) { this.execute(() => model.setCharacterStyle(id)); }, selectMatch(m) { model.select(m.start, m.end); }, setFindHighlights() {}, pasteData() {} };
}

it('maps line spacing choices to rules and amounts and back', () => {
  expect(lineChoice('auto', 1)).toEqual(['single', '']);
  expect(lineChoice('auto', 1.5)).toEqual(['oneHalf', '']);
  expect(lineChoice('auto', 2.25)).toEqual(['multiple', 2.25]);
  expect(lineChoice('exact', 18)).toEqual(['exact', 18]);
  expect(lineChoice(null, null)).toEqual(['', '']);
  expect(lineSetting('double')).toEqual({ lineRule: 'auto', lineSpacing: 2 });
  expect(lineSetting('multiple', '1.333')).toEqual({ lineRule: 'auto', lineSpacing: 320 / 240 });
  expect(lineSetting('atLeast', '13.02')).toEqual({ lineRule: 'atLeast', lineSpacing: 13 });
});

it('turns spoken punctuation into text and joins dictation to the text before the caret', () => {
  expect(spokenText('hello comma world period new paragraph next')).toBe('hello, world.\nnext');
  expect(joinDictation('Start', 'hello')).toBe(' hello');
  expect(joinDictation('Done. ', 'next one')).toBe('Next one');
  expect(joinDictation('', 'first')).toBe('First');
  expect(joinDictation('word', '.')).toBe('.');
  const off = createDictation({ editor: () => null, readOnly: () => false, host: () => null });
  expect(off.supported).toBe(false);
  expect(off.start()).toBe(false);
});

it('flattens shading patterns as the importer paints them', () => {
  expect(shadingValue('FFFFFF', 'clear', 'auto')).toBe('FFFFFF');
  expect(shadingValue('auto', 'solid', 'auto')).toBe('foreground');
  expect(shadingValue('auto', 'pct25', 'auto')).toBe('BFBFBF');
  expect(shadingValue('FF0000', 'pct50', '0000FF')).toBe('7F0080');
});

it('reads Find conditions from a Font dialog patch and list text around the number', () => {
  expect(fontCondition({ fontAscii: 'Arial', fontHAnsi: 'Arial', bold: true, boldCs: true, underlineStyle: 'double', underlineColor: 'auto' })).toEqual({ fontAscii: 'Arial', bold: true, underline: true });
  expect(splitLevelText('Step %1:', 0)).toEqual({ before: 'Step ', after: ':' });
  expect(splitLevelText('%1.%2)', 1)).toEqual({ before: '.', after: ')' });
});

it('describes styles and changes case through the Change Case dialog', async () => {
  const doc = documentWith(['text']);
  expect(describeStyle(doc.styles, 'Heading1')).toMatch(/Bold.*Keep with next.*Level 1.*Based on: Normal/);
  const apply = vi.fn(() => true);
  openChangeCase({ apply });
  document.querySelector('input[value="upper"]').checked = true;
  document.querySelector('.fmt-dialog').dispatchEvent(new Event('submit', { cancelable: true }));
  await Promise.resolve(); await Promise.resolve();
  expect(apply).toHaveBeenCalledWith('upper');
});

it('contributes Format, Edit and View menu items and text/list context items', () => {
  const doc = documentWith(['One', 'Two']);
  doc.select(0, doc.text.length); doc.toggleList('number');
  const engine = fakeEngine(doc);
  const area = createFormatArea({ editor: () => engine, pkg: () => ({ readOnly: false }), error: e => { throw e; }, host: () => document.body });
  const labels = id => area.commands.extendMenu(id).filter(i => !i.separator).map(i => i.label);
  expect(labels('format')).toEqual(['Font…', 'Text Effects…', 'Paragraph…', 'Bullets and Numbering…', 'Borders and Shading…', 'Tabs…', 'Change Case…', 'Style…']);
  expect(labels('edit')).toEqual(expect.arrayContaining(['Paste Special…', 'Paste and Match Formatting', 'Select']));
  expect(labels('view')).toEqual(['Styles Pane', 'Reveal Formatting', 'Style Inspector']);
  expect(area.commands.extendMenu('table')).toEqual([]);
  expect(area.commands.contextMenuItems('text').map(i => i.label)).toEqual(['Font…', 'Paragraph…', 'Bullets and Numbering…', 'Styles', 'Select Text with Similar Formatting']);
  expect(area.commands.contextMenuItems('list').map(i => i.label)).toEqual(['Continue Numbering', 'Set Numbering Value…', 'Adjust List Indents…']);
  // Menu commands open their dialogs.
  area.commands.extendMenu('format').find(i => i.label === 'Paragraph…').onSelect();
  expect(document.querySelector('[role="dialog"]').getAttribute('aria-label')).toBe('Paragraph');
  closeAllModals();
  area.commands.extendMenu('format').find(i => i.label === 'Tabs…').onSelect();
  expect(document.querySelector('.modal-root:last-child [role="dialog"]').getAttribute('aria-label')).toBe('Tabs');
  // Restart at 1 is one transaction on the list.
  doc.select(doc.text.indexOf('Two'));
  const before = engine.session.revision;
  area.commands.restartNumberingAtOne();
  expect(engine.session.revision).toBe(before + 1);
  // Installing on the full command set extends the multilevel and effects menus.
  const all = { multilevelItems: () => [{ label: 'Library' }], textEffectItems: () => [{ label: 'Outline' }] };
  area.install(all);
  expect(all.multilevelItems().map(i => i.label)).toEqual(['Library', undefined, 'Define New Multilevel List…']);
  expect(all.textEffectItems().at(-1).label).toBe('Text Effects…');
  area.destroy();
});

it('applies a style from the styles pane and selects contiguous instances in one selection', () => {
  const doc = documentWith(['Head', 'Body one', 'Body two']);
  const engine = fakeEngine(doc);
  const area = createFormatArea({ editor: () => engine, pkg: () => ({ readOnly: false }), error: e => { throw e; }, host: () => document.body });
  document.body.append(area.pane.node);
  area.commands.stylesPane();
  expect(area.pane.visible).toBe(true);
  doc.select(1);
  area.pane.node.querySelector('[aria-label^="Apply Heading 1"]').click();
  expect(doc.paragraphStyle).toBe('Heading1');
  area.refresh();
  expect(area.pane.node.querySelector('.styles-pane-current-name').textContent).toBe('Heading 1');
  // Normal: the two body paragraphs are adjacent, so they become one selection.
  doc.select(doc.text.indexOf('Body one'));
  area.refresh();
  area.pane.node.querySelector('.styles-pane-actions .btn').click();
  expect(doc.text.slice(...doc.range)).toBe('Body one\nBody two');
  area.destroy();
});
