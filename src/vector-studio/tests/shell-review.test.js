// Regression tests from the shell review (menus, dialogs, dock, home screen).
import { describe, it, expect, afterEach } from 'vitest';

describe('menu placement', () => {
  const desc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');
  afterEach(() => {
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', desc);
    document.querySelectorAll('.menu').forEach((m) => m.remove());
  });
  const tallMenus = (h) =>
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
      configurable: true,
      get() {
        return this.classList?.contains('menu') ? h : 0;
      },
    });
  const anchorAt = (top, bottom) => {
    const a = document.createElement('button');
    document.body.append(a);
    a.getBoundingClientRect = () => ({ left: 100, right: 160, top, bottom, width: 60, height: bottom - top });
    return a;
  };
  const items = [{ type: 'cmd', label: 'One', enabled: true, run: () => {} }];

  it('a menu taller than the window stays below its menu bar button and scrolls', async () => {
    const { openMenu } = await import('../src/ui/menubar.js');
    tallMenus(2000);
    const anchor = anchorAt(6, 34);
    const m = openMenu({}, items, { x: 100, y: 36, anchor });
    // Moved up to the top edge, it covered the menu bar: the row under the pointer opened its submenu.
    expect(m.el.style.top).toBe('36px');
    expect(m.el.style.maxHeight).toBe(`${window.innerHeight - 36 - 4}px`);
    m.close();
  });

  it('a menu from a button near the bottom opens above the button', async () => {
    const { openMenu } = await import('../src/ui/menubar.js');
    tallMenus(200);
    const vh = window.innerHeight;
    const anchor = anchorAt(vh - 40, vh - 10);
    const m = openMenu({}, items, { x: 100, y: vh - 6, anchor });
    expect(parseFloat(m.el.style.top)).toBe(vh - 40 - 4 - 200);
    expect(m.el.style.maxHeight).toBe('');
    m.close();
  });

  it('a context menu at a point still moves up to fit', async () => {
    const { openMenu } = await import('../src/ui/menubar.js');
    tallMenus(300);
    const vh = window.innerHeight;
    const m = openMenu({}, items, { x: 100, y: vh - 50 });
    expect(parseFloat(m.el.style.top)).toBe(vh - 300 - 4);
    m.close();
  });
});

describe('dialog initial focus', () => {
  it('a confirmation whose action is destructive starts on Cancel, not the close button', async () => {
    const { installCanvasStub } = await import('./helpers.js');
    const { confirmDialog, openDialog } = await import('../src/ui/dialogs/dialog.js');
    installCanvasStub();
    const p = confirmDialog({ title: 'Delete Set?', message: 'This cannot be undone.', okLabel: 'Delete', danger: true });
    expect(document.activeElement.textContent).toBe('Cancel');
    document.activeElement.click();
    expect(await p).toBe(false);
    // The Save As "Replace File?" confirmation lists Cancel and a danger button only.
    const q = openDialog({ title: 'Replace File?', body: document.createElement('p'), buttons: [{ label: 'Cancel', value: false }, { label: 'Replace', value: true, danger: true }] });
    expect(document.activeElement.textContent).toBe('Cancel');
    document.activeElement.click();
    expect(await q).toBe(false);
    // A safe primary button still takes focus.
    const r = confirmDialog({ title: 'Continue?', message: 'Go on?' });
    expect(document.activeElement.textContent).toBe('OK');
    document.activeElement.click();
    expect(await r).toBe(true);
  });
});

describe('form dialog validation', () => {
  it('names the allowed range, marks the field invalid and clears once fixed', async () => {
    const { installCanvasStub } = await import('./helpers.js');
    const { formDialog } = await import('../src/ui/dialogs/dialog.js');
    installCanvasStub();
    const p = formDialog(null, {
      title: 'Test',
      fields: [
        { key: 'n', label: 'Copies', type: 'number', value: 5, min: 1, max: 10 },
        { key: 'a', label: 'Angle', type: 'angle', value: 0, min: -360 },
      ],
    });
    const dlg = document.querySelector('dialog[open]');
    const [n] = dlg.querySelectorAll('input');
    const ok = dlg.querySelector('.btn.primary');
    const err = dlg.querySelector('.form-error');
    n.value = '0';
    ok.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(err.textContent).toBe('Copies must be between 1 and 10.');
    expect(n.getAttribute('aria-invalid')).toBe('true');
    expect(document.activeElement).toBe(n);
    n.value = 'abc';
    ok.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(err.textContent).toBe('Enter a number for Copies.');
    n.value = '3';
    n.dispatchEvent(new Event('input', { bubbles: true }));
    expect(err.textContent).toBe('');
    expect(n.hasAttribute('aria-invalid')).toBe(false);
    ok.click();
    expect(await p).toEqual({ n: 3, a: 0 });
  });
});

describe('layers panel rename', () => {
  async function setup() {
    const { bootApp } = await import('./helpers.js');
    const { createPath } = await import('../src/model/nodes.js');
    const { rectangle } = await import('../src/model/shapes.js');
    const app = bootApp();
    const ed = app.newDocument({ name: 'Rename' });
    const doc = ed.doc;
    const layer = doc.layers()[0];
    let id;
    doc.transact('Build', () => {
      const p = createPath(rectangle(0, 0, 10, 10), true);
      doc.insert(p, layer.id);
      id = p.id;
    });
    const panel = app.dock.panels.get('layers');
    app.dock.showTab('layers');
    panel.ensureBuilt();
    panel.setOpen(layer.id, true);
    panel.update();
    return { app, doc, id, panel };
  }
  const startRename = (panel, id) => {
    const row = () => panel.tree.querySelector(`#lrow-${CSS.escape(id)}`);
    row().click();
    row().querySelector('.lr-name').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    // The panel refresh that follows the click's selection change.
    panel.update();
    return panel.tree.querySelector('.lr-rename');
  };
  const key = (el, k) => el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));

  it('keeps the name field through the refresh after the double-click and commits once on Enter', async () => {
    const { doc, id, panel } = await setup();
    const input = startRename(panel, id);
    expect(input?.isConnected).toBe(true);
    expect(document.activeElement).toBe(input);
    input.value = 'Alpha';
    key(input, 'Enter');
    input.dispatchEvent(new Event('blur'));
    expect(doc.get(id).name).toBe('Alpha');
    expect(doc.undoLabel).toBe('Rename');
    doc.undo();
    expect(doc.get(id).name || '').toBe('');
    expect(doc.undoLabel).toBe('Build');
  });

  it('Escape cancels even when the field then loses focus', async () => {
    const { doc, id, panel } = await setup();
    const input = startRename(panel, id);
    input.value = 'Beta';
    key(input, 'Escape');
    input.dispatchEvent(new Event('blur'));
    expect(doc.get(id).name || '').toBe('');
    expect(doc.undoLabel).toBe('Build');
    expect(panel.tree.querySelector('.lr-rename')).toBe(null);
  });
});

describe('status bar view rotation', () => {
  it('shows an angle set with the Rotate View tool instead of going blank', async () => {
    const { bootApp } = await import('./helpers.js');
    const app = bootApp();
    const ed = app.newDocument();
    const sel = app.statusbar.el.querySelector('.status-select.rot');
    ed.view.rotateView(37);
    app.statusbar.refresh();
    expect(sel.value).toBe('37');
    expect(sel.selectedOptions[0].textContent).toBe('37°');
    ed.view.rotateView(-20);
    app.statusbar.refresh();
    expect(sel.selectedOptions[0].textContent).toBe('-20°');
    // Back on a preset, the extra entry goes away.
    ed.view.rotateView(-15);
    app.statusbar.refresh();
    expect(sel.value).toBe('345');
    expect(sel.selectedOptions[0].textContent).toBe('-15°');
    expect(sel.querySelector('option.custom')).toBe(null);
  });
});

describe('tool flyouts on phones', () => {
  it('open above the tool row instead of over it', async () => {
    const { bootApp } = await import('./helpers.js');
    const app = bootApp();
    app.newDocument();
    const mm = window.matchMedia;
    const desc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');
    try {
      window.matchMedia = (q) => ({ matches: q.includes('max-width: 760px'), addEventListener() {}, removeEventListener() {} });
      Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get() { return this.classList?.contains('tool-flyout') ? 150 : 0; } });
      const btn = [...document.querySelectorAll('.toolbar .tool-btn')].find((b) => b._ids?.length > 1);
      const vh = window.innerHeight;
      btn.getBoundingClientRect = () => ({ left: 160, right: 200, top: vh - 50, bottom: vh - 10, width: 40, height: 40 });
      btn.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
      const fly = document.querySelector('.tool-flyout');
      expect(parseFloat(fly.style.top)).toBe(vh - 50 - 150 - 4);
      expect(parseFloat(fly.style.left)).toBe(160);
      fly.remove();
    } finally {
      window.matchMedia = mm;
      Object.defineProperty(HTMLElement.prototype, 'offsetHeight', desc);
    }
  });
});

describe('home recent files', () => {
  it('removing a recent file with the keyboard keeps focus in the list', async () => {
    const { bootAppWithFeatures } = await import('./helpers.js');
    const app = await bootAppWithFeatures();
    const items = [{ name: 'a.vstudio' }, { name: 'b.vstudio' }, { name: 'c.vstudio' }];
    app.recentFiles = async () => items;
    app.removeRecent = async () => {};
    app.showHome();
    await new Promise((r) => setTimeout(r, 0));
    const removes = () => [...app.home.querySelectorAll('.recent-remove')];
    removes()[1].focus();
    removes()[1].click();
    await new Promise((r) => setTimeout(r, 0));
    expect(document.activeElement).toBe(removes()[1]);
    expect(document.activeElement.getAttribute('aria-label')).toBe('Remove c.vstudio from recent');
    // The last one: focus moves to the one before it, then to New file when the list is empty.
    removes()[1].click();
    await new Promise((r) => setTimeout(r, 0));
    expect(document.activeElement.getAttribute('aria-label')).toBe('Remove a.vstudio from recent');
    removes()[0].click();
    await new Promise((r) => setTimeout(r, 0));
    expect(document.activeElement.textContent).toBe('New file');
  });
});

describe('ruler guides', () => {
  it('dragging a guide out and releasing it off the canvas (over the panels) adds no guide', async () => {
    const { bootApp } = await import('./helpers.js');
    const app = bootApp();
    const ed = app.newDocument();
    ed.setViewOption('rulers', true);
    app.canvasHost.getBoundingClientRect = () => ({ left: 100, top: 90, right: 1000, bottom: 800, width: 900, height: 710 });
    const ruler = document.querySelector('.ruler-top');
    ruler.setPointerCapture = () => {};
    const ev = (type, x, y) => {
      const e = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y });
      e.pointerId = 1;
      ruler.dispatchEvent(e);
    };
    const drag = (x, y) => {
      ev('pointerdown', 300, 80);
      ev('pointermove', 300, 300);
      ev('pointermove', x, y);
      ev('pointerup', x, y);
    };
    drag(1200, 400);
    expect(ed.doc.root.guides || []).toHaveLength(0);
    drag(300, 850);
    expect(ed.doc.root.guides || []).toHaveLength(0);
    drag(300, 300);
    expect(ed.doc.root.guides).toHaveLength(1);
    expect(ed.alignmentGuides).toBe(null);
  });
});
