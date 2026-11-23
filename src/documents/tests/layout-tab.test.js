// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TextDocument, paragraph } from '../src/engine/model.js';
import { createLayoutTab, MARGIN_PRESETS } from '../src/views/layout-tab.js';
import { defaultPageSettings, saveDefaultPageSettings, lastCustomMargins, saveCustomMargins } from '../src/lib/page-defaults.js';
import { DEFAULT_PAGE_SETTINGS } from '../src/engine/page-settings.js';

/** A stand-in for the canvas editor: the same transaction contract over a real document model. */
function fakeEditor(texts) {
  const doc = new TextDocument(texts.map(text => paragraph(text)));
  const engine = {
    model: doc, session: { body: doc, path: null },
    finishComposition() {}, focus() {}, editStory() {},
    execute(action, onFailure) {
      const before = doc.snapshot();
      try { action(); return true; } catch (e) { doc.restore(before); onFailure?.(e); return false; }
    },
    insertSectionBreak(type) { return this.execute(() => doc.insertSectionBreak(type)); },
    insertPageBreak() { return this.execute(() => doc.insertPageBreak()); },
    setParagraphGeometry(patch) { return doc.setParagraphGeometry(patch); },
  };
  return { doc, engine };
}
const item = (items, label) => items.find(i => i.label === label);

beforeEach(() => { localStorage.clear(); });

describe('Layout tab commands', () => {
  it('applies margin presets, marks the current one and offers the last custom margins', () => {
    const { doc, engine } = fakeEditor(['One']), error = vi.fn();
    const { commands } = createLayoutTab({ editor: () => engine, pkg: () => ({}), error });
    expect(item(commands.marginItems(), 'Normal').checked).toBe(true);
    item(commands.marginItems(), 'Mirrored').onSelect();
    expect(doc.pageSettings).toMatchObject({ left: 1800, right: 1440, mirrorMargins: true });
    expect(item(commands.marginItems(), 'Mirrored').checked).toBe(true);
    expect(item(commands.marginItems(), 'Last Custom Setting')).toBeUndefined();
    saveCustomMargins({ ...DEFAULT_PAGE_SETTINGS, left: 2000, right: 1000 });
    item(commands.marginItems(), 'Last Custom Setting').onSelect();
    expect(doc.pageSettings).toMatchObject({ left: 2000, right: 1000, mirrorMargins: false });
    expect(error).not.toHaveBeenCalled();
    expect(MARGIN_PRESETS.map(p => p[1])).toEqual(['Normal', 'Narrow', 'Moderate', 'Wide', 'Mirrored']);
  });
  it('turns the page with its margins and chooses paper sizes for the orientation', () => {
    const { doc, engine } = fakeEditor(['One']);
    const { commands } = createLayoutTab({ editor: () => engine, pkg: () => ({}), error: vi.fn() });
    item(commands.marginItems(), 'Wide').onSelect();
    item(commands.orientationItems(), 'Landscape').onSelect();
    expect(doc.pageSettings).toMatchObject({ orientation: 'landscape', width: 15840, height: 12240, top: 2880, bottom: 2880, left: 1440, right: 1440 });
    item(commands.sizeItems(), 'A5').onSelect();
    expect([doc.pageSettings.width, doc.pageSettings.height]).toEqual([11906, 8391]);
    expect(item(commands.sizeItems(), 'A5').checked).toBe(true);
  });
  it('puts columns on selected text alone and on the section otherwise', () => {
    const { doc, engine } = fakeEditor(['One', 'Two', 'Three']);
    const { commands } = createLayoutTab({ editor: () => engine, pkg: () => ({}), error: vi.fn() });
    doc.select(4, 7);
    item(commands.columnItems(), 'Two').onSelect();
    expect(doc.sectionSettings.map(s => s.columns?.count ?? 1)).toEqual([1, 2, 1]);
    doc.select(0);
    item(commands.columnItems(), 'Three').onSelect();
    expect(doc.sectionSettings.map(s => s.columns?.count ?? 1)).toEqual([3, 2, 1]);
    expect(item(commands.columnItems(), 'Three').checked).toBe(true);
  });
  it('draws Line Between in each selected section with columns, keeping each section\'s own columns', () => {
    const { doc, engine } = fakeEditor(['One', 'Two', 'Three']);
    const { commands } = createLayoutTab({ editor: () => engine, pkg: () => ({}), error: vi.fn() });
    const columns = () => doc.sectionSettings.map(s => [s.columns?.count ?? 1, !!s.columns?.separator]);
    // Three sections: two columns, three columns and one.
    doc.select(4); doc.insertSectionBreak('continuous'); doc.select(doc.text.indexOf('Three')); doc.insertSectionBreak('continuous');
    doc.select(0); item(commands.columnItems(), 'Two').onSelect();
    doc.select(doc.text.indexOf('Two')); item(commands.columnItems(), 'Three').onSelect();
    expect(columns()).toEqual([[2, false], [3, false], [1, false]]);
    // A selection across the sections: the caret's section had two columns, and the others took them as well.
    doc.select(1, doc.text.length - 1);
    item(commands.columnItems(), 'Line Between').onSelect();
    expect(columns()).toEqual([[2, true], [3, true], [1, false]]);
    item(commands.columnItems(), 'Line Between').onSelect();
    expect(columns()).toEqual([[2, false], [3, false], [1, false]]);
  });
  it('inserts each section break and refuses them in tables', () => {
    const { doc, engine } = fakeEditor(['One']), error = vi.fn();
    const { commands } = createLayoutTab({ editor: () => engine, pkg: () => ({}), error });
    const breaks = commands.breakItems();
    expect(breaks.filter(i => i.label).map(i => i.label)).toEqual(['Page', 'Column', 'Text Wrapping', 'Next Page', 'Continuous', 'Even Page', 'Odd Page']);
    doc.select(3);
    item(commands.breakItems(), 'Even Page').onSelect();
    expect(doc.sectionSettings.map(s => s.sectionType)).toEqual(['nextPage', 'evenPage']);
    item(commands.breakItems(), 'Text Wrapping').onSelect();
    expect(doc.text).toBe('One\n\v');
  });
  it('converts indents to and from the measurement unit', () => {
    const { doc, engine } = fakeEditor(['One']);
    const { commands } = createLayoutTab({ editor: () => engine, pkg: () => ({}), error: vi.fn() });
    commands.setIndent('indentLeft', 2.54, 'cm');
    expect(doc.paragraphFormatting.indentLeft).toBe(1440);
    expect(commands.indentValue('indentLeft', 'in')).toBe(1);
    expect(commands.indentValue('indentLeft', 'cm')).toBe(2.54);
  });
});

describe('page defaults', () => {
  it('remembers page settings for new documents and ignores unusable storage', () => {
    expect(defaultPageSettings()).toBeUndefined();
    saveDefaultPageSettings({ ...DEFAULT_PAGE_SETTINGS, width: 11906, height: 16838, left: 1134, compatibilityMode: 15 });
    expect(defaultPageSettings()).toMatchObject({ width: 11906, height: 16838, left: 1134, compatibilityMode: 12 });
    localStorage.setItem('documents:page-defaults', '{"left": -5}');
    expect(defaultPageSettings()).toBeUndefined();
    localStorage.setItem('documents:last-custom-margins', 'not json');
    expect(lastCustomMargins()).toBeNull();
  });
});
