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
