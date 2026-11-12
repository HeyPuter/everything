// Regression tests from the second shell review (keyboard, menus, focus, shortcuts).
import { describe, it, expect, afterEach } from 'vitest';

afterEach(() => {
  document.querySelectorAll('.menu, dialog').forEach((m) => m.remove());
});

async function appWithRect() {
  const { bootAppWithFeatures } = await import('./helpers.js');
  const { createPath } = await import('../src/model/nodes.js');
  const { rectangle } = await import('../src/model/shapes.js');
  const app = await bootAppWithFeatures();
  const ed = app.newDocument({ name: 'Keys' });
  let id;
  ed.doc.transact('Build', () => {
    const p = createPath(rectangle(100, 100, 80, 60), true);
    ed.doc.insert(p, ed.doc.layers()[0].id);
    id = p.id;
  });
  ed.select([id]);
  return { app, ed, id };
}

describe('arrow keys on sliders', () => {
  it('move the Navigator zoom slider instead of nudging the selection', async () => {
    const { app, ed, id } = await appWithRect();
    app.openPanel('navigator');
    const slider = document.querySelector('.panel-flyout input[type="range"]');
    expect(slider).toBeTruthy();
    slider.focus();
    const ev = new KeyboardEvent('keydown', {
      key: 'ArrowLeft',
      code: 'ArrowLeft',
      bubbles: true,
      cancelable: true,
    });
    slider.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
    expect(ed.doc.get(id).anchors[0].x).toBe(100);
    // On the canvas the arrow keys still nudge.
    app.canvasHost.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'ArrowLeft',
        code: 'ArrowLeft',
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(ed.doc.get(id).anchors[0].x).toBe(99);
  });
});

describe('popup menu Escape', () => {
  it('puts focus back on the button that opened a panel menu', async () => {
    const { app } = await appWithRect();
    const btn = document.createElement('button');
    btn.setAttribute('aria-haspopup', 'menu');
    document.body.append(btn);
    btn.focus();
    app.showMenuAt(btn, ['edit.copy', 'edit.paste'], 'Test menu');
    const item = document.querySelector('.menu .menu-item');
    expect(document.activeElement).toBe(item);
    item.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(document.querySelector('.menu')).toBe(null);
    expect(document.activeElement).toBe(btn);
    btn.remove();
  });

  it('puts focus back on the canvas after a context menu', async () => {
    const { app } = await appWithRect();
    app.canvasHost.focus();
    expect(document.activeElement).toBe(app.canvasHost);
    app.showContextMenu(200, 200);
    const item = document.querySelector('.menu .menu-item');
    expect(document.activeElement).toBe(item);
    item.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(document.activeElement).toBe(app.canvasHost);
  });
});

describe('submenus opened by hovering', () => {
  it('keep focus on their row, and Right moves into the open submenu', async () => {
    const { openMenu } = await import('../src/ui/menubar.js');
    const run = () => {};
    const items = [
      { type: 'cmd', label: 'One', enabled: true, run },
      { type: 'sub', label: 'More', items: [{ type: 'cmd', label: 'Inner', enabled: true, run }] },
    ];
    const m = openMenu({}, items, { x: 10, y: 10 });
    const row = m.el.querySelectorAll('.menu-item')[1];
    row.dispatchEvent(new Event('pointerenter'));
    const menus = document.querySelectorAll('.menu');
    expect(menus.length).toBe(2);
    expect(document.activeElement).toBe(row);
    row.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(document.querySelectorAll('.menu').length).toBe(2);
    expect(document.activeElement.textContent).toContain('Inner');
    m.close();
  });
});

describe('task bar width', () => {
  it('drops its button labels when it is wider than the canvas, and shows them again when it fits', async () => {
    const { app } = await appWithRect();
    const bar = app.taskbar;
    let room = 300;
    // Labelled buttons need 600px; icon-only ones 280px.
    Object.defineProperty(bar, 'scrollWidth', {
      configurable: true,
      get: () => (bar.classList.contains('compact') ? 280 : 600),
    });
    Object.defineProperty(bar, 'clientWidth', {
      configurable: true,
      get: () => Math.min(room, bar.scrollWidth),
    });
    window.dispatchEvent(new Event('resize'));
    await new Promise((r) => setTimeout(r, 40));
    expect(bar.hidden).toBe(false);
    expect(bar.classList.contains('compact')).toBe(true);
    const labelled = [...bar.querySelectorAll('.tb-btn')].find((b) =>
      b.querySelector('.icon + span'),
    );
    expect(labelled.dataset.tip).toBe(labelled.textContent.trim());
    room = 900;
    window.dispatchEvent(new Event('resize'));
    await new Promise((r) => setTimeout(r, 40));
    expect(bar.classList.contains('compact')).toBe(false);
    expect(labelled.dataset.tip).toBeUndefined();
  });
});
