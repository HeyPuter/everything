import { describe, it, expect } from 'vitest';
import { createPath, createText, createImage } from '../src/model/nodes.js';
import { rectangle } from '../src/model/shapes.js';
import { bootAppWithFeatures } from './helpers.js';
import { memoryBackend } from '../src/features/files/backends.js';
import { TemplateStore, VersionStore, versionKey, restoreDocumentContent, cleanInfo, splitList, fontsUsed, packageEntries } from '../src/features/panels/file-commands.js';
import { systemInfo, systemInfoText } from '../src/features/panels/help-commands.js';

const tick = () => new Promise((r) => setTimeout(r, 0));
async function openDialogEl() {
  for (let i = 0; i < 50 && !document.querySelector('dialog[open]'); i++) await new Promise((r) => setTimeout(r, 10));
  return document.querySelector('dialog[open]');
}
const PNG_1x1 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

async function setup() {
  const app = await bootAppWithFeatures();
  const ed = app.newDocument({ name: 'Poster', width: 200, height: 100 });
  const doc = ed.doc;
  const add = (node) => {
    doc.transact('Add', () => doc.insert(node, ed.targetLayer().id));
    return node.id;
  };
  return { app, ed, doc, add };
}

describe('Templates', () => {
  it('saves a document as a template and builds new documents from it', async () => {
    const { ed, add } = await setup();
    add(createPath(rectangle(10, 10, 50, 20), true));
    const store = new TemplateStore(memoryBackend());
    const entry = await store.save(ed.doc, 'Flyer');
    expect(entry).toMatchObject({ name: 'Flyer', width: 200, height: 100, artboards: 1 });
    expect((await store.list()).map((t) => t.name)).toEqual(['Flyer']);
    const doc = await store.load(entry.id, 'Untitled-9');
    expect(doc.root.name).toBe('Untitled-9');
    expect(doc.layers()[0].children.length).toBe(1);
    expect(doc.undoStack.length).toBe(0);
    await store.remove(entry.id);
    expect(await store.list()).toEqual([]);
  });

  it('File > New from Template lists My Templates', async () => {
    const { app, ed } = await setup();
    await app.userTemplates.save(ed.doc, 'Mine');
    const done = app.commands.run('file.newFromTemplate');
    const dlg = await openDialogEl();
    const cards = [...dlg.querySelectorAll('.newdoc-card')];
    const mine = cards.find((c) => c.textContent.includes('Mine'));
    expect(mine).toBeTruthy();
    mine.click();
    [...dlg.querySelectorAll('button')].find((b) => b.textContent === 'New').click();
    await done;
    expect(app.editors.length).toBe(2);
    expect(app.editor.doc.artboards[0]).toMatchObject({ w: 200, h: 100 });
  });
});

describe('Version history', () => {
  it('keeps the newest versions and restores one as an undoable step', async () => {
    const { ed, doc, add } = await setup();
    const store = new VersionStore(memoryBackend(), 3);
    const key = versionKey(ed);
    const first = await store.add(key, doc);
    const id = add(createPath(rectangle(0, 0, 10, 10), true));
    for (let i = 0; i < 3; i++) await store.add(key, doc);
    const list = await store.list(key);
    expect(list.length).toBe(3);
    expect(list.some((v) => v.id === first.id)).toBe(false);
    // Restore an older state.
    const empty = new VersionStore(memoryBackend());
    doc.transact('Remove', () => doc.remove(id));
    const v0 = await empty.add(key, doc);
    doc.undo();
    expect(doc.has(id)).toBe(true);
    const old = await empty.read(key, v0.id);
    restoreDocumentContent(ed, old);
    expect(doc.has(id)).toBe(false);
    expect(doc.root.name).toBe('Poster');
    expect(doc.undoLabel).toBe('Restore Version');
    doc.undo();
    expect(doc.has(id)).toBe(true);
  });

  it('saving a document keeps a version that the dialog lists', async () => {
    const { app, ed, doc } = await setup();
    doc.markSaved();
    await new Promise((r) => setTimeout(r, 400));
    const list = await app.versions.list(versionKey(ed));
    expect(list.length).toBe(1);
    const done = app.commands.run('file.versionHistory');
    const dlg = await openDialogEl();
    expect(dlg.querySelectorAll('.vh-row').length).toBe(1);
    dlg.querySelector('.dialog-close').click();
    await done;
  });
});

describe('Document color mode', () => {
  it('switches the mode (undoable) and the Color panel default', async () => {
    const { app, doc } = await setup();
    expect(app.commands.isChecked('file.colorMode.rgb')).toBe(true);
    await app.commands.run('file.colorMode.cmyk');
    expect(doc.root.colorMode).toBe('CMYK');
    expect(app.commands.isChecked('file.colorMode.cmyk')).toBe(true);
    expect(app.prefs.get('colorPanelMode')).toBe('cmyk');
    app.renderTabs();
    expect(document.querySelector('.doc-tab-btn').textContent).toContain('(CMYK/');
    doc.undo();
    expect(doc.root.colorMode).toBe('RGB');
  });
});

describe('File Info', () => {
  it('normalizes metadata', () => {
    expect(splitList('a; b, c\nd')).toEqual(['a', 'b', 'c', 'd']);
    const info = cleanInfo({ title: ' T ', author: 'Ada; Grace', keywords: 'x, y', copyrightStatus: 'unknown', copyrightUrl: 'example.com', description: '' });
    expect(info).toMatchObject({ title: 'T', author: ['Ada', 'Grace'], keywords: ['x', 'y'], copyrightUrl: 'https://example.com' });
    expect(info.copyrightStatus).toBeUndefined();
    expect(info.description).toBeUndefined();
    expect(info.created).toBeTypeOf('number');
  });

  it('is edited in a dialog and written to SVG and PDF', async () => {
    const { app, ed, doc, add } = await setup();
    add(createPath(rectangle(10, 10, 50, 20), true));
    const done = app.commands.run('file.info');
    await tick();
    const dlg = document.querySelector('dialog[open]');
    const set = (label, v) => {
      const l = [...dlg.querySelectorAll('label')].find((x) => x.textContent === label);
      const input = dlg.querySelector(`#${l.getAttribute('for')}`);
      input.value = v;
    };
    set('Document Title', 'Spring Poster');
    set('Author', 'Ada Lovelace');
    set('Keywords', 'spring, poster');
    set('Description', 'A poster & more');
    [...dlg.querySelectorAll('button')].find((b) => b.textContent === 'OK').click();
    await done;
    expect(doc.root.info).toMatchObject({ title: 'Spring Poster', author: ['Ada Lovelace'], keywords: ['spring', 'poster'] });
    const svg = await app.exporters.svg(ed, {});
    expect(svg).toContain('<title>Spring Poster</title>');
    expect(svg).toContain('<desc>A poster &amp; more</desc>');
    expect(svg).toContain('<dc:creator>Ada Lovelace</dc:creator>');
    expect(svg).toContain('<dc:subject>spring</dc:subject>');
    const pdf = new TextDecoder('latin1').decode(await app.exporters.pdf(ed, {}));
    expect(pdf).toContain('/Title (Spring Poster)');
    expect(pdf).toContain('/Author (Ada Lovelace)');
    expect(pdf).toContain('/Keywords (spring; poster)');
    doc.undo();
    expect(doc.root.info).toBeUndefined();
  });
});

describe('Package', () => {
  it('collects the document, its images and a fonts report', async () => {
    const { app, ed, doc, add } = await setup();
    doc.assets.set('img1', { mime: 'image/png', data: PNG_1x1, name: 'logo' });
    add(createImage('img1', 1, 1, [10, 0, 0, 10, 0, 0]));
    const t = createText('Hello', 0, 50);
    add({ ...t, char: { ...t.char, fontFamily: 'Inter', fontWeight: 700 } });
    expect(fontsUsed(doc)).toEqual([{ family: 'Inter', weight: 700, style: 'normal', count: 1 }]);
    const { entries, report } = await packageEntries(app, ed, { includeFonts: false });
    const names = entries.map((e) => e.name);
    expect(names).toContain('Poster/Poster.vstudio');
    expect(names).toContain('Poster/Links/logo.png');
    expect(names).toContain('Poster/Report.txt');
    expect(report).toMatch(/Inter 700/);
    expect(report).toMatch(/logo\.png/);
    // Package options: folder name, images at the top level or left out, no report.
    const flat = (await packageEntries(app, ed, { includeFonts: false, linksFolder: false, report: false, folder: 'Out' })).entries.map((e) => e.name);
    expect(flat).toEqual(['Out/Poster.vstudio', 'Out/logo.png']);
    const bare = (await packageEntries(app, ed, { includeFonts: false, copyLinks: false })).entries.map((e) => e.name);
    expect(bare).toEqual(['Poster/Poster.vstudio', 'Poster/Report.txt']);
  });
});

describe('Help', () => {
  it('shows the welcome screen', async () => {
    const { app } = await setup();
    await app.commands.run('help.welcome');
    expect(app.home.hidden).toBe(false);
  });

  it("opens What's New and System Info", async () => {
    const { app } = await setup();
    let done = app.commands.run('help.whatsNew');
    await tick();
    let dlg = document.querySelector('dialog[open]');
    expect(dlg.querySelectorAll('.whats-new-list li').length).toBeGreaterThan(3);
    dlg.querySelector('.dialog-close').click();
    await done;
    const sections = await systemInfo(app);
    expect(sections.map(([t]) => t)).toEqual(['Application', 'Browser', 'Display', 'Graphics', 'Hardware', 'Storage']);
    expect(systemInfoText(sections)).toMatch(/User agent: /);
    done = app.commands.run('help.systemInfo');
    dlg = await openDialogEl();
    expect([...dlg.querySelectorAll('button')].some((b) => b.textContent === 'Copy')).toBe(true);
    dlg.querySelector('.dialog-close').click();
    await done;
  });
});
