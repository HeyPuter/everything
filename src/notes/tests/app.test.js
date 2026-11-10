import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Store } from '../src/data/store.js';
import { memoryBackend } from '../src/data/backend.js';
import { App } from '../src/ui/app.js';
import { RIBBON_TABS } from '../src/ui/ribbon-def.js';
import { buildCommands } from '../src/ui/commands.js';
import { closeAllMenus } from '../src/ui/menu.js';
import { setTheme } from '../src/ui/prefs.js';
import { icon } from '../src/lib/icons.js';

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

let mounted = [];

async function mount({ env = 'web' } = {}) {
  document.body.innerHTML = '<div id="app"></div><div id="live-region"></div>';
  localStorage.clear();
  const store = new Store(memoryBackend(), { saveDelay: 0 });
  await store.load({ defaultName: "sam's Notebook" });
  const app = new App(document.getElementById('app'), { store, user: { username: 'sam' }, env, onSignOut: () => {} });
  await app.start();
  mounted.push(app);
  return { app, store };
}

function key(code, { ctrl = false, alt = false, shift = false, k } = {}) {
  const e = new KeyboardEvent('keydown', { code, key: k || code.replace(/^Key|^Digit/, '').toLowerCase(), ctrlKey: ctrl, altKey: alt, shiftKey: shift, bubbles: true, cancelable: true });
  document.body.dispatchEvent(e);
  return e;
}

describe('commands and ribbon definition', () => {
  it('every ribbon item points at a real command', () => {
    const commands = buildCommands();
    const ids = [];
    const walk = (items) => items.forEach((i) => {
      if (i.cmd) ids.push(i.cmd);
      if (i.stack) i.stack.forEach(walk);
    });
    for (const tab of RIBBON_TABS) for (const g of tab.groups) walk(g.items);
    expect(ids.filter((id) => !commands.has(id))).toEqual([]);
  });

  it('no two commands claim the same shortcut', () => {
    const seen = new Map();
    const dupes = [];
    for (const c of buildCommands().values()) {
      if (!c.key) continue;
      // The To Do button and the To Do tag are the same action.
      if (c.id === 'todo') continue;
      if (seen.has(c.key)) dupes.push(`${c.key}: ${seen.get(c.key)} / ${c.id}`);
      seen.set(c.key, c.id);
    }
    expect(dupes).toEqual([]);
  });
});

describe('App', () => {
  let app;
  let store;
  beforeEach(async () => {
    ({ app, store } = await mount());
  });
  afterEach(() => {
    closeAllMenus();
    for (const a of mounted) a.destroy();
    mounted = [];
  });

  it('opens the starter notebook on its first page', () => {
    expect(document.title).toBe('Untitled Page - Notes');
    expect(app.nav.nbButton.textContent).toContain("sam's Notebook");
    const sections = [...app.nav.sectionsList.querySelectorAll('.row')].map((r) => r.textContent);
    expect(sections).toEqual(['Quick Notes', 'New Section 1']);
    expect(app.nav.sectionsList.querySelector('[aria-selected="true"]').textContent).toBe('Quick Notes');
    expect(app.editor.page).toBeTruthy();
  });

  it('renders every ribbon tab without errors', () => {
    for (const tab of RIBBON_TABS.filter((t) => !t.contextual)) {
      app.ribbon.select(tab.id);
      expect(document.querySelector('#ribbon-panel [role="toolbar"]').getAttribute('aria-label')).toBe(`${tab.label} commands`);
    }
    expect(document.querySelectorAll('[role="tab"]').length).toBe(5);
  });

  it('adds pages and subpages from shortcuts', async () => {
    key('KeyN', { ctrl: true, alt: true });
    await tick();
    key('KeyN', { ctrl: true, alt: true, shift: true });
    await tick();
    const section = store.section(app.state.sectionId);
    expect(section.pages.map((p) => p.level)).toEqual([0, 0, 1]);
    expect(app.state.pageId).toBe(section.pages[2].id);
    expect(app.nav.pagesList.querySelectorAll('.row')).toHaveLength(3);
  });

  it('types a title, which renames the page everywhere', async () => {
    app.editor.titleEl.textContent = 'Groceries';
    app.editor.titleEl.dispatchEvent(new Event('input', { bubbles: true }));
    app.editor.commit();
    await tick();
    expect(store.findPage(app.state.pageId).meta.title).toBe('Groceries');
    expect(app.nav.pagesList.textContent).toContain('Groceries');
    expect(document.title).toBe('Groceries - Notes');
  });

  it('creates a note container by clicking the canvas and saves its text', async () => {
    const el = app.editor.createOutlineAt(100, 200);
    const body = el.querySelector('.outline-body');
    body.innerHTML = '<p>Milk</p>';
    body.dispatchEvent(new Event('input', { bubbles: true }));
    app.editor.commit();
    expect(app.editor.page.outlines).toHaveLength(1);
    expect(app.editor.page.outlines[0].html).toBe('<p>Milk</p>');
    await store.flush();
    const saved = JSON.parse(store.backend.files.get(`pages/${app.state.pageId}.json`));
    expect(saved.outlines[0].html).toBe('<p>Milk</p>');
  });

  it('undoes and redoes container edits', async () => {
    const el = app.editor.createOutlineAt(100, 200);
    const body = el.querySelector('.outline-body');
    body.innerHTML = '<p>one</p>';
    body.dispatchEvent(new Event('input', { bubbles: true }));
    app.editor.commit();
    body.innerHTML = '<p>two</p>';
    body.dispatchEvent(new Event('input', { bubbles: true }));
    app.editor.commit();
    await app.editor.undo();
    expect(app.editor.page.outlines[0].html).toBe('<p>one</p>');
    await app.editor.redo();
    expect(app.editor.page.outlines[0].html).toBe('<p>two</p>');
  });

  it('deletes a page to Deleted Notes and undoes it from the toast', async () => {
    const id = app.state.pageId;
    app.deletePage(id);
    expect(store.findPage(id)).toBeNull();
    expect(store.trash[0].kind).toBe('page');
    const undo = [...document.querySelectorAll('.toast-action')].find((b) => b.textContent === 'Undo');
    undo.click();
    await tick();
    expect(store.findPage(id)).toBeTruthy();
  });

  it('adds a section and starts renaming it', async () => {
    app.newSection();
    await tick(20);
    const input = app.nav.sectionsList.querySelector('input.row-rename');
    expect(input).toBeTruthy();
    input.value = 'Recipes';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect([...store.sectionsOf(store.notebooks[0])].map((s) => s.name)).toContain('Recipes');
  });

  it('moves the selection through pages with the arrow keys', async () => {
    app.newPage();
    await tick();
    const rows = () => [...app.nav.pagesList.querySelectorAll('.row')];
    rows()[1].focus();
    rows()[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    await tick();
    expect(app.state.pageId).toBe(store.section(app.state.sectionId).pages[0].id);
    expect(rows()[0].getAttribute('aria-selected')).toBe('true');
  });

  it('searches every notebook from the Search pane', async () => {
    const section = store.section(app.state.sectionId);
    store.createPage(section.id, { title: 'Garden', outlines: [{ id: 'o', x: 0, y: 0, html: '<p>Plant tulips in October</p>' }] });
    app.setRailView('search');
    app.search.input.value = 'tulips';
    await app.search.run();
    const results = [...app.search.results.querySelectorAll('.result')];
    expect(results).toHaveLength(1);
    expect(results[0].textContent).toContain('Garden');
    expect(results[0].querySelector('mark').textContent).toBe('tulips');
  });

  it('offers Sign Out on the web but never inside a Puter app', async () => {
    expect(app.accountItems().some((i) => i.label === 'Sign Out')).toBe(true);
    const inApp = await mount({ env: 'app' });
    expect(inApp.app.accountItems().some((i) => i.label === 'Sign Out')).toBe(false);
  });

  it('disables text commands until there is a caret', () => {
    app.updateFormatState();
    const bold = document.querySelector('#ribbon-panel button[aria-label="Bold"]');
    expect(bold.disabled).toBe(true);
    const findTags = document.querySelector('#ribbon-panel button[aria-label="Find Tags"]');
    expect(findTags.disabled).toBe(false);
  });

  it('shows the font and size of the caret in both ribbon combos', () => {
    const values = () => [...document.querySelectorAll('#ribbon-panel .rb-combo input')].map((i) => i.value);
    app.format = { editable: true, inBody: true, fontName: 'Georgia', fontSize: 14 };
    app.refreshCombos();
    expect(values()).toEqual(['Georgia', '14']);
    app.ribbon.select('insert');
    app.ribbon.select('home');
    app.format = { editable: true, inBody: true, fontName: 'Arial', fontSize: 9 };
    app.refreshCombos();
    expect(values()).toEqual(['Arial', '9']);
  });

  it('keeps text commands available while typing in Tell Me', () => {
    const el = app.editor.createOutlineAt(100, 200);
    const body = el.querySelector('.outline-body');
    body.innerHTML = '<p>Milk</p>';
    const r = document.createRange();
    r.selectNodeContents(body.querySelector('p'));
    body.focus();
    document.getSelection().removeAllRanges();
    document.getSelection().addRange(r);
    app.editor.lastRange = r.cloneRange();
    app.updateFormatState();
    const bold = () => document.querySelector('#ribbon-panel button[aria-label="Bold"]');
    expect(bold().disabled).toBe(false);
    app.tellMeInput.focus();
    document.getSelection().removeAllRanges();
    app.updateFormatState();
    expect(bold().disabled).toBe(false);
    app.tellMeInput.blur();
    app.updateFormatState();
    expect(bold().disabled).toBe(true);
  });

  it('opens the notebook switcher as an accessible menu', () => {
    app.nav.nbButton.click();
    const menu = document.querySelector('.menu[role="menu"]');
    expect(menu).toBeTruthy();
    expect([...menu.querySelectorAll('[role="menuitemradio"]')].map((m) => m.textContent)).toEqual(["sam's Notebook"]);
    expect(app.nav.nbButton.getAttribute('aria-expanded')).toBe('true');
  });

  it('applies page color and rule lines from the View tab', () => {
    app.setRules('college');
    app.setPageColor('blue');
    expect(app.editor.page.rules).toBe('college');
    expect(app.editor.pageEl.style.backgroundImage).toContain('data:image/svg+xml');
    expect(app.editor.scroller.style.getPropertyValue('--page-bg')).toBe('#dce9f8');
  });
});

describe('App: keyboard and layout regressions', () => {
  let app;
  let store;
  beforeEach(async () => {
    ({ app, store } = await mount());
  });
  afterEach(() => {
    closeAllMenus();
    document.querySelectorAll('dialog, .reader').forEach((d) => d.remove());
    for (const a of mounted) a.destroy();
    mounted = [];
  });

  it('keeps focus on the pages list while arrowing through it', async () => {
    app.newPage();
    app.newPage();
    await tick();
    const rows = () => [...app.nav.pagesList.querySelectorAll('.row')];
    rows()[2].focus();
    rows()[2].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    await tick();
    expect(document.activeElement.classList.contains('row')).toBe(true);
    expect(document.activeElement.dataset.id).toBe(app.state.pageId);
  });

  it('ignores app shortcuts while Immersive Reader is open', async () => {
    app.runCommand('reader');
    const before = store.section(app.state.sectionId).pages.length;
    key('KeyN', { ctrl: true, alt: true });
    await tick();
    expect(store.section(app.state.sectionId).pages.length).toBe(before);
    // Close it so its Escape handler doesn't outlive the test.
    key('Escape', { k: 'Escape' });
    expect(document.querySelector('.reader')).toBeNull();
  });

  it('moves off a subpage that is deleted with its collapsed parent', async () => {
    const parent = app.state.pageId;
    app.newPage({ sub: true });
    await tick();
    const child = app.state.pageId;
    store.togglePageCollapsed(parent);
    app.deletePage(parent);
    await tick();
    expect(app.state.pageId).not.toBe(child);
  });

  it('keeps empty trees valid', async () => {
    const section = store.createSection(store.notebooks[0].id, { name: 'Empty' });
    await app.selectSection(section.id);
    expect(app.nav.pagesList.getAttribute('role')).toBeNull();
    expect(app.nav.pagesList.textContent).toContain('No pages');
  });

  it('keeps a dialog open when a drag ends on its backdrop', () => {
    app.runCommand('newNotebook');
    const dialog = document.querySelector('dialog');
    dialog.querySelector('input').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    dialog.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(dialog.isConnected).toBe(true);
    dialog.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    dialog.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(dialog.isConnected).toBe(false);
  });

  it('shows an exit button in Full Page View', () => {
    app.toggleFullPage();
    expect(app.exitFullBtn.hidden).toBe(false);
    app.exitFullBtn.click();
    expect(app.state.fullPage).toBe(false);
  });

  it('returns focus to the tab when Escape closes the collapsed ribbon', () => {
    app.ribbon.toggleCollapsed(true);
    const home = document.getElementById('tab-home');
    home.focus();
    home.click();
    expect(app.ribbon.el.classList.contains('peek')).toBe(true);
    // jsdom has no layout, so focus a toolbar button directly.
    app.ribbon.panel.querySelector('.rb-btn').focus();
    expect(app.ribbon.panel.contains(document.activeElement)).toBe(true);
    key('Escape', { k: 'Escape' });
    expect(app.ribbon.el.classList.contains('peek')).toBe(false);
    expect(document.activeElement.id).toBe('tab-home');
    app.ribbon.toggleCollapsed(false);
  });

  it('opens a ribbon dropdown with Down Arrow', () => {
    app.ribbon.select('view');
    const theme = document.querySelector('#ribbon-panel button[aria-label="App Theme"]');
    theme.focus();
    theme.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
    expect(theme.getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement.closest('[role="menu"]')).toBeTruthy();
  });

  it('returns focus to Tell Me when Escape closes its results', () => {
    const input = app.tellMeInput;
    input.focus();
    input.value = 'bold';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
    expect(document.activeElement.closest('[role="menu"]')).toBeTruthy();
    document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe('bold');
  });

  it('returns focus to the Font box when Escape closes its list', () => {
    const body = app.editor.createOutlineAt(100, 200).querySelector('.outline-body');
    body.innerHTML = '<p>Milk</p>';
    body.focus();
    document.getSelection().collapse(body.querySelector('p').firstChild, 2);
    app.updateFormatState();
    const input = document.querySelector('#ribbon-panel .rb-combo input');
    input.focus();
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true, bubbles: true, cancelable: true }));
    expect(document.activeElement.closest('.font-menu')).toBeTruthy();
    document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(document.querySelector('.font-menu')).toBeNull();
    expect(document.activeElement).toBe(input);
  });

  it('shows the current theme on the Theme menu items', () => {
    setTheme('dark');
    app.fileBtn.click();
    const item = [...document.querySelectorAll('.menu-item')].find((b) => b.textContent === 'Theme');
    expect(item.querySelector('.icon').innerHTML).toBe(icon('moon').innerHTML);
    closeAllMenus();
    setTheme('system');
  });

  it('names the sync button with its status and action as separate sentences', () => {
    const names = ['saved', 'saving', 'error'].map((s) => {
      app.updateSync(s);
      return app.syncBtn.getAttribute('aria-label');
    });
    expect(names).toEqual([
      'All changes saved. Sync now',
      'Saving changes. Sync now',
      "Can't save right now. Your changes are kept and will be retried. Sync now",
    ]);
  });

  it('moves to the command search from its key hint', () => {
    app.keytips.start();
    expect([...document.querySelectorAll('.keytip')].map((t) => t.textContent)).toContain('Q');
    key('KeyQ');
    expect(app.keytips.active).toBe(false);
    expect(document.activeElement).toBe(app.tellMeInput);
  });

  it('names ribbon shortcuts with valid aria-keyshortcuts key values', () => {
    const keys = (label) => document.querySelector(`#ribbon-panel button[aria-label="${label}"]`).getAttribute('aria-keyshortcuts');
    expect(keys('Bold')).toBe('Control+B');
    expect(keys('Strikethrough')).toBe('Control+-');
    expect(keys('Increase Font Size')).toBe('Control+Shift+.');
    expect(keys('Numbering')).toBe('Control+/');
    expect(keys('Decrease Indent Position')).toBe('Alt+Shift+ArrowLeft');
  });

  it('scrolls a contextual tab into view in a narrow tab row', () => {
    const list = app.ribbon.tabList;
    Object.defineProperty(list, 'scrollWidth', { configurable: true, get: () => 400 });
    Object.defineProperty(list, 'clientWidth', { configurable: true, get: () => 300 });
    list.getBoundingClientRect = () => ({ left: 0, right: 300 });
    const proto = HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect = function () {
      return this.id === 'tab-table' ? { left: 330, right: 390 } : proto.call(this);
    };
    try {
      app.ribbon.setContextual('table');
      expect(list.scrollLeft).toBe(90);
    } finally {
      HTMLElement.prototype.getBoundingClientRect = proto;
    }
  });

  it('keeps focus on a ribbon tab after activating it', () => {
    const view = document.getElementById('tab-view');
    view.focus();
    view.click();
    expect(document.activeElement.id).toBe('tab-view');
    expect(document.activeElement.getAttribute('aria-selected')).toBe('true');
  });
});

describe('App: section passwords', () => {
  afterEach(() => {
    closeAllMenus();
    document.querySelectorAll('dialog').forEach((d) => d.remove());
    document.querySelector('.toasts')?.replaceChildren();
    for (const a of mounted) a.destroy();
    mounted = [];
  });

  it('does not report a password change that did not happen', async () => {
    const { passwordDialog } = await import('../src/ui/features.js');
    const { app, store } = await mount();
    const section = store.section(app.state.sectionId);
    await store.protectSection(section.id, 'first one');
    passwordDialog(app, section);
    const dialog = document.querySelector('dialog[open]');
    // The section locks again (ten idle minutes) while the dialog is open.
    await store.lockSection(section.id);
    const [a, b] = dialog.querySelectorAll('input');
    a.value = 'second one';
    b.value = 'second one';
    dialog.querySelector('.btn.primary').click();
    await tick(20);
    expect(document.querySelector('.toasts')?.textContent || '').not.toContain('Password changed');
    expect(dialog.isConnected).toBe(true);
    expect(dialog.querySelector('.field-error').textContent).toContain('locked');
    expect(await store.unlockSection(section.id, 'second one')).toBe(false);
    expect(await store.unlockSection(section.id, 'first one')).toBe(true);
  });
});
