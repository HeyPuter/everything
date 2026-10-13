// Type panel options menus and the dialogs behind them: Character,
// Paragraph, OpenType, Glyphs, Character/Paragraph Styles and Tabs, plus
// Hyphenation, Justification, Area Type Options and Find/Replace Font.
import { describe, it, expect, beforeEach } from 'vitest';
import { bootAppWithFeatures } from './helpers.js';
import { resolveItems } from '../src/ui/menubar.js';
import { createText } from '../src/model/nodes.js';
import { paraAt, styleAt } from '../src/model/text-runs.js';
import { layoutText } from '../src/model/text-layout.js';
import { styleLists } from '../src/features/type/text-styles.js';
import { MENUS } from '../src/ui/menus.js';

const tick = () => new Promise((r) => setTimeout(r, 0));
const CHAR = { fontFamily: 'Approx Sans', fontWeight: 400, fontStyle: 'normal', fontSize: 10 };

let app;
let doc;

beforeEach(async () => {
  app = await bootAppWithFeatures();
  if (!app.editor) app.newDocument();
  doc = app.editor.doc;
});

function add(text, extra = {}) {
  const t = createText(text, 0, 0, { ...extra, char: { ...createText('', 0, 0).char, ...CHAR, ...(extra.char || {}) } });
  doc.transact('Add', () => doc.insert(t, app.editor.targetLayer().id));
  app.editor.select([t.id]);
  return t.id;
}

/** The resolved menu of a panel: [{ label, enabled, checked, run | id, items }]. */
function panelMenu(id) {
  app.openPanel(id);
  const p = app.dock.panels.get(id);
  p.ensureBuilt();
  return resolveItems(app, p.menu());
}

const find = (items, label) => items.find((i) => i.label === label);

/** Run a resolved menu item the way the menu does. */
async function choose(item) {
  expect(item, 'menu item').toBeTruthy();
  if (item.run) await item.run(app);
  else await app.commands.run(item.id);
}

const dialog = () => document.querySelector('dialog[open]');
const button = (label) => [...dialog().querySelectorAll('button')].find((b) => b.textContent === label);
const field = (label) => {
  const lab = [...dialog().querySelectorAll('label')].find((l) => l.textContent === label);
  return lab ? dialog().querySelector(`#${CSS.escape(lab.htmlFor)}`) || lab.querySelector('input') : null;
};
function setField(label, value) {
  const el = field(label);
  expect(el, label).toBeTruthy();
  if (el.type === 'checkbox') el.checked = value;
  else el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

describe('Character panel menu', () => {
  it('lists the character options and runs them on the selected type', async () => {
    const id = add('Hello');
    const items = panelMenu('character');
    const labels = items.filter((i) => i.type !== 'sep').map((i) => i.label);
    for (const l of ['Hide Options', 'All Caps', 'Small Caps', 'Superscript', 'Subscript', 'Underline', 'Strikethrough', 'Kerning', 'Fractional Widths', 'No Break', 'Snap to Glyph', 'Character Edit Tool', 'Reset Panel']) expect(labels).toContain(l);
    await choose(find(items, 'All Caps'));
    expect(doc.get(id).char.caps).toBe('all');
    expect(find(panelMenu('character'), 'All Caps').checked).toBe(true);
    await choose(find(items, 'Small Caps'));
    expect(doc.get(id).char.caps).toBe('small');
    await choose(find(items, 'Subscript'));
    expect(doc.get(id).char.position).toBe('sub');
    await choose(find(items, 'No Break'));
    expect(doc.get(id).char.noBreak).toBe(true);
    await choose(find(items, 'Fractional Widths'));
    expect(doc.get(id).char.fractionalWidths).toBe(false);
    const kern = find(items, 'Kerning').items;
    expect(kern.map((k) => k.label)).toEqual(['Auto Kerning', 'Optical Kerning', 'No Automatic Kerning']);
    await choose(kern[1]);
    expect(doc.get(id).char.kernMode).toBe('optical');
    // Reset Panel brings every character attribute back.
    await choose(find(items, 'Reset Panel'));
    const c = doc.get(id).char;
    expect([c.caps, c.position, c.noBreak, c.fractionalWidths, c.kernMode]).toEqual(['normal', 'normal', false, true, 'metrics']);
  });

  it('has shortcuts for case and lines', async () => {
    const id = add('Hello');
    expect(app.commands.get('type.allCaps').shortcut).toBe('Shift+Mod+K');
    await app.commands.run('type.underline');
    await app.commands.run('type.strikethrough');
    expect(doc.get(id).char.underline).toBe(true);
    expect(doc.get(id).char.strike).toBe(true);
    await app.commands.run('type.underline');
    expect(doc.get(id).char.underline).toBe(false);
  });

  it('Hide Options collapses the optional rows and is remembered', async () => {
    add('Hello');
    const items = panelMenu('character');
    const panel = app.dock.panels.get('character');
    expect(panel.el.classList.contains('ty-options-hidden')).toBe(false);
    await choose(find(items, 'Hide Options'));
    expect(panel.el.classList.contains('ty-options-hidden')).toBe(true);
    expect(app.prefs.get('characterOptions')).toBe(false);
    expect(find(panelMenu('character'), 'Show Options')).toBeTruthy();
  });

  it('the kerning field takes the automatic modes by name', () => {
    const id = add('Hello');
    app.openPanel('character');
    const panel = app.dock.panels.get('character');
    panel.update();
    const input = panel.el.querySelector('input[aria-label^="Kerning"]');
    expect(input.value).toBe('Auto');
    input.value = 'optical';
    input.dispatchEvent(new Event('change'));
    expect(doc.get(id).char.kernMode).toBe('optical');
    panel.update();
    expect(input.value).toBe('Optical');
    input.value = '0';
    input.dispatchEvent(new Event('change'));
    input.value = 'None';
    input.dispatchEvent(new Event('change'));
    expect(doc.get(id).char.kernMode).toBe('none');
  });
});

describe('Paragraph panel menu and dialogs', () => {
  it('lists the paragraph options; composers and hanging punctuation toggle', async () => {
    const id = add('one two', { kind: 'area', width: 100, height: 100 });
    const items = panelMenu('paragraph');
    const labels = items.filter((i) => i.type !== 'sep').map((i) => i.label);
    for (const l of ['Hide Options', 'Hanging Punctuation', 'Optical Margin Alignment', 'Justification...', 'Hyphenation...', 'Single-line Composer', 'Every-line Composer', 'Reset Panel']) expect(labels).toContain(l);
    expect(find(items, 'Single-line Composer').checked).toBe(true);
    await choose(find(items, 'Every-line Composer'));
    expect(doc.get(id).para.composer).toBe('every');
    await choose(find(items, 'Hanging Punctuation'));
    expect(doc.get(id).para.hangingPunctuation).toBe(true);
    const again = panelMenu('paragraph');
    expect(find(again, 'Every-line Composer').checked).toBe(true);
    expect(find(again, 'Hanging Punctuation').checked).toBe(true);
    await choose(find(again, 'Reset Panel'));
    expect(doc.get(id).para.composer).toBe('single');
    expect(doc.get(id).para.hangingPunctuation).toBe(false);
  });

  it('the Hyphenate box in the panel turns hyphenation on', () => {
    const id = add('one', { kind: 'area', width: 100, height: 100 });
    app.openPanel('paragraph');
    const box = [...app.dock.panels.get('paragraph').el.querySelectorAll('label')].find((l) => l.textContent === 'Hyphenate').control;
    box.checked = true;
    box.dispatchEvent(new Event('change'));
    expect(doc.get(id).para.hyphenate).toBe(true);
  });

  it('Hyphenation previews live, commits as one step and cancels cleanly', async () => {
    // The test canvas measures every character 6 wide at 100pt.
    const id = add('xx hyphenation', { kind: 'area', width: 60, height: 300, char: { fontSize: 100 } });
    const before = doc.undoStack.length;
    let done = app.commands.run('type.hyphenation');
    await tick();
    setField('Hyphenate', true);
    expect(doc.get(id).para.hyphenate).toBe(true);
    expect(layoutText(doc.get(id)).lines[0].hyphen).toBe(true);
    button('Cancel').click();
    await done;
    expect(doc.get(id).para.hyphenate).toBe(false);
    expect(doc.undoStack.length).toBe(before);

    done = app.commands.run('type.hyphenation');
    await tick();
    setField('Hyphenate', true);
    setField('Letters After a Hyphen', '5');
    button('OK').click();
    // The dialog changes the paragraphs it opened on, whatever happens to the selection meanwhile.
    app.editor.select([]);
    await done;
    const p = doc.get(id).para;
    expect(p.hyphenate).toBe(true);
    expect(p.hyphenation.minAfter).toBe(5);
    expect(doc.undoStack.length).toBe(before + 1);
    doc.undo();
    expect(doc.get(id).para.hyphenate).toBe(false);
  });

  it('Justification checks its values and stores them on the paragraphs', async () => {
    const id = add('aa aa', { kind: 'area', width: 100, height: 100 });
    const done = app.commands.run('type.justification');
    await tick();
    const input = (l) => dialog().querySelector(`input[aria-label="${l}"]`);
    input('Word Spacing minimum').value = '120%';
    button('OK').click();
    await tick();
    expect(dialog().querySelector('.form-error').textContent).toMatch(/minimum/);
    input('Word Spacing minimum').value = '90%';
    input('Word Spacing desired').value = '110%';
    input('Word Spacing desired').dispatchEvent(new Event('input', { bubbles: true }));
    // The preview shows at once.
    expect(doc.get(id).para.justification.wordDesired).toBe(110);
    dialog().querySelector('select').value = 'center';
    button('OK').click();
    await done;
    const J = doc.get(id).para.justification;
    expect([J.wordMin, J.wordDesired, J.wordMax, J.singleWord]).toEqual([90, 110, 133, 'center']);
  });
});

describe('Area Type Options', () => {
  it('auto size makes the frame as tall as its text and keeps it so while typing', async () => {
    const id = add('a', { kind: 'area', width: 100, height: 300 });
    const done = app.commands.run('type.areaOptions');
    await tick();
    setField('Auto Size Height to Fit the Text', true);
    expect(doc.get(id).height).toBeLessThan(30);
    button('OK').click();
    await done;
    const h1 = doc.get(id).height;
    expect(doc.get(id).areaOptions.autoSize).toBe(true);
    app.setTool('type');
    const s = app.getTool('type').editText(id, null);
    s.setSelection(1, 1);
    const steps = doc.undoStack.length;
    s.insert('\nb\nc', 'paste');
    expect(doc.get(id).height).toBeGreaterThan(h1 + 20);
    expect(layoutText(doc.get(id)).overflow).toBe(false);
    // The height change is part of the edit's undo step.
    expect(doc.undoStack.length).toBe(steps + 1);
    doc.undo();
    expect(doc.get(id).height).toBeCloseTo(h1);
  });

  it('aligns lines vertically and cancels its preview', async () => {
    const id = add('a', { kind: 'area', width: 100, height: 100 });
    const top = layoutText(doc.get(id)).lines[0].y;
    let done = app.commands.run('type.areaOptions');
    await tick();
    setField('Align Vertically', 'bottom');
    expect(layoutText(doc.get(id)).lines[0].y).toBeGreaterThan(top + 50);
    button('Cancel').click();
    await done;
    expect(doc.get(id).areaOptions?.verticalAlign).toBeUndefined();
    done = app.commands.run('type.areaOptions');
    await tick();
    setField('Align Vertically', 'center');
    button('OK').click();
    await done;
    expect(doc.get(id).areaOptions.verticalAlign).toBe('center');
  });

  it('is a direct Type menu entry', () => {
    expect(MENUS.find((m) => m.label === 'Type').submenu).toContain('type.areaOptions');
    expect(app.commands.label('type.areaOptions')).toBe('Area Type Options...');
  });
});

describe('OpenType and Glyphs panel menus', () => {
  it('OpenType menu toggles features and picks figure styles and positions', async () => {
    const id = add('1st');
    const items = panelMenu('openType');
    for (const l of ['Standard Ligatures', 'Discretionary Ligatures', 'Swash', 'Ordinals', 'Fractions', 'Figure', 'Position', 'Stylistic Sets', 'Reset OpenType Features']) expect(find(items, l), l).toBeTruthy();
    expect(find(items, 'Standard Ligatures').checked).toBe(true);
    await choose(find(items, 'Discretionary Ligatures'));
    expect(doc.get(id).char.discretionary).toBe(true);
    await choose(find(find(items, 'Figure').items, 'Tabular Oldstyle'));
    expect(doc.get(id).char.figures).toBe('tabular-oldstyle');
    await choose(find(find(items, 'Position').items, 'Numerator'));
    expect(doc.get(id).char.otPosition).toBe('numr');
    await choose(find(find(items, 'Stylistic Sets').items, 'Set 3'));
    expect(doc.get(id).char.stylisticSets).toEqual([3]);
    await choose(find(panelMenu('openType'), 'Reset OpenType Features'));
    const c = doc.get(id).char;
    expect([c.discretionary, c.figures, c.otPosition, c.stylisticSets]).toEqual([false, 'default', 'default', null]);
  });

  it('Glyphs menu filters, zooms and clears recent glyphs', async () => {
    app.prefs.set('glyphsRecent', [{ family: 'Inter', weight: 400, style: 'normal', glyph: 5 }]);
    const items = panelMenu('glyphs');
    const panel = app.dock.panels.get('glyphs');
    await choose(find(find(items, 'Show').items, 'Numbers'));
    expect(panel.filter).toBe('numbers');
    expect(find(find(panelMenu('glyphs'), 'Show').items, 'Numbers').checked).toBe(true);
    const z = panel.zoom;
    await choose(find(items, 'Larger Glyphs'));
    expect(panel.zoom).toBeGreaterThan(z);
    await choose(find(items, 'Clear Recently Used Glyphs'));
    expect(app.prefs.get('glyphsRecent')).toEqual([]);
    expect(find(panelMenu('glyphs'), 'Clear Recently Used Glyphs').enabled).toBe(false);
  });
});

describe('Styles panel menus', () => {
  it('holds the style commands and switches list row size', async () => {
    add('Hello');
    doc.transact('Styles', () => doc.updateRoot({ charStyles: [{ id: 'c-strong', name: 'Strong', basedOn: null, attrs: { fontFamily: 'Lora', fontWeight: 700 } }] }));
    const items = panelMenu('characterStyles');
    for (const l of ['New Character Style...', 'Duplicate Character Style', 'Delete Character Style', 'Redefine Style', 'Clear Overrides', 'Character Style Options...', 'Select All Unused', 'Sort by Name', 'Load Character Styles', 'Small List Rows', 'Large List Rows']) expect(find(items, l), l).toBeTruthy();
    await choose(find(items, 'Large List Rows'));
    const panel = app.dock.panels.get('characterStyles');
    expect(panel.el.classList.contains('st-large')).toBe(true);
    expect(find(panelMenu('characterStyles'), 'Large List Rows').checked).toBe(true);
    const row = panel.el.querySelector('[data-id="c-strong"] .st-name');
    expect(row.style.fontFamily).toMatch(/Lora/);
    expect(row.style.fontWeight).toBe('700');
  });

  it('loads styles from another open document; same names take the loaded definition', async () => {
    const id = add('Hello');
    const target = app.editor;
    const lists = styleLists(doc);
    doc.transact('Styles', () =>
      doc.updateRoot({
        paraStyles: [{ id: 'p-local', name: 'Body', basedOn: null, attrs: { fontSize: 10 } }],
        charStyles: lists.char.filter((s) => s.id !== 'normal'),
      }),
    );
    doc.transact('Apply', () => doc.update(id, { para: { ...doc.get(id).para, paraStyle: 'p-local' } }));
    // A second document with a Body and a Heading style.
    app.newDocument();
    const other = app.editor;
    other.doc.transact('Styles', () =>
      other.doc.updateRoot({
        paraStyles: [
          { id: 'p-a', name: 'Body', basedOn: null, attrs: { fontSize: 14 } },
          { id: 'p-b', name: 'Heading', basedOn: 'p-a', attrs: { fontWeight: 700 } },
        ],
      }),
    );
    app.activate(target);
    doc = target.doc;
    const items = panelMenu('paragraphStyles');
    const load = find(items, 'Load Paragraph Styles').items;
    expect(load.some((i) => i.label === 'From a File...')).toBe(true);
    await choose(load[0]);
    const para = styleLists(doc).para;
    const body = para.find((s) => s.name === 'Body');
    const heading = para.find((s) => s.name === 'Heading');
    expect(body.id).toBe('p-local');
    expect(body.attrs.fontSize).toBe(14);
    expect(heading.basedOn).toBe('p-local');
    // Text using Body follows the loaded definition.
    expect(styleAt(doc.get(id), 0).fontSize).toBe(14);
    doc.undo();
    expect(styleLists(doc).para.some((s) => s.name === 'Heading')).toBe(false);
  });
});

describe('Tabs panel menu', () => {
  it('clears, repeats and toggles snapping and the on-canvas ruler', async () => {
    const id = add('a\tb\tc', { kind: 'area', width: 300, height: 100 });
    app.openPanel('tabs');
    const panel = app.dock.panels.get('tabs');
    panel.update();
    panel.addTab(36);
    let items = panelMenu('tabs');
    await choose(find(items, 'Repeat Tab'));
    expect(paraAt(doc.get(id), 0).tabs.length).toBeGreaterThan(3);
    const snap = panel.snapOn();
    await choose(find(items, 'Snap to Ruler Ticks'));
    expect(panel.snapOn()).toBe(!snap);
    const above = panel.canvasOn();
    await choose(find(items, 'Show Ruler Above the Text'));
    expect(panel.canvasOn()).toBe(!above);
    items = panelMenu('tabs');
    await choose(find(items, 'Clear All'));
    expect(paraAt(doc.get(id), 0).tabs).toBeNull();
    expect(find(panelMenu('tabs'), 'Clear All').enabled).toBe(false);
  });
});

describe('Find/Replace Font', () => {
  it('is named for both jobs and can save the font list', async () => {
    add('Hello');
    expect(app.commands.label('type.findFont')).toBe('Find/Replace Font...');
    const done = app.commands.run('type.findFont');
    await tick();
    expect(dialog().querySelector('.dialog-title').textContent).toBe('Find/Replace Font');
    expect(button('Save List').disabled).toBe(false);
    button('Done').click();
    await done;
  });
});
