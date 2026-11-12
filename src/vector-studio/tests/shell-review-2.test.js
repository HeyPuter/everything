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

describe('keyboard shortcuts dialog', () => {
  it('refuses keys the app keeps for itself, which a tool or command could never use', async () => {
    const { app } = await appWithRect();
    const { reservedKey } = await import('../src/features/shortcuts/sets.js');
    expect(reservedKey('D')).toBe('Default Fill and Stroke');
    expect(reservedKey('Shift+X')).toBe('Swap Fill and Stroke');
    expect(reservedKey('Shift+,')).toBeTruthy();
    expect(reservedKey('Space')).toBeTruthy();
    expect(reservedKey('Alt+ArrowLeft')).toBeTruthy();
    expect(reservedKey('Tab')).toBeTruthy();
    expect(reservedKey('Alt+D')).toBe(null);
    expect(reservedKey('Mod+D')).toBe(null);
    expect(reservedKey('Q')).toBe(null);

    const { keyboardShortcutsDialog } = await import('../src/features/shortcuts/dialog.js');
    const done = keyboardShortcutsDialog(app);
    const dialog = document.querySelector('dialog.keyboard-shortcuts');
    const row = [...dialog.querySelectorAll('.ks-row')].find(
      (r) => r.dataset.key === 'tools:rectangle',
    );
    const key = row.querySelector('.ks-key');
    key.click();
    key.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'd', code: 'KeyD', bubbles: true, cancelable: true }),
    );
    expect(dialog.querySelector('.ks-status').textContent).toMatch(/Default Fill and Stroke/);
    // Still waiting for keys; nothing was assigned.
    expect(key.textContent).toMatch(/Type keys/);
    key.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Escape',
        code: 'Escape',
        bubbles: true,
        cancelable: true,
      }),
    );
    [...dialog.querySelectorAll('.dialog-footer .btn')].find((b) => b.textContent === 'OK').click();
    await done;
    expect(app.toolKeys.get('d')).toBeUndefined();
  });
});

describe('color picker hex field', () => {
  it('Escape in the hex field closes the paint popover and returns to its button', async () => {
    const { installCanvasStub } = await import('./helpers.js');
    installCanvasStub();
    const { openPopover, closePopover } = await import('../src/ui/popover.js');
    const { createColorPicker } = await import('../src/ui/color-picker.js');
    const anchor = document.createElement('button');
    document.body.append(anchor);
    const picker = createColorPicker({ value: '#ff0000' });
    openPopover(anchor, picker.el, { label: 'Fill color' });
    const hex = picker.el.querySelector('.cp-hex');
    hex.focus();
    hex.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(document.querySelector('.popover')).toBe(null);
    expect(document.activeElement).toBe(anchor);
    closePopover();
    anchor.remove();
  });
});

describe('color picker hex field input', () => {
  it('goes back to the current color when the text is not a color', async () => {
    const { installCanvasStub } = await import('./helpers.js');
    installCanvasStub();
    const { createColorPicker } = await import('../src/ui/color-picker.js');
    const seen = [];
    const picker = createColorPicker({ value: '#ff0000', onInput: (v) => seen.push(v) });
    const hex = picker.el.querySelector('.cp-hex');
    hex.value = 'zzz';
    hex.dispatchEvent(new Event('change'));
    expect(hex.value).toBe('FF0000');
    expect(seen).toEqual([]);
    hex.value = ' 00ff00 ';
    hex.dispatchEvent(new Event('change'));
    expect(seen).toEqual(['#00ff00']);
  });
});

describe('theme color', () => {
  it("the browser's theme color follows a chosen interface brightness, not just the system's mode", async () => {
    const { applyTheme } = await import('../src/theme.js');
    const style = document.createElement('style');
    style.textContent =
      ":root { --bg-panel: #f3f3f3; } :root[data-brightness='dark'] { --bg-panel: #2c2c2c; }";
    document.head.append(style);
    const meta = document.createElement('meta');
    meta.name = 'theme-color';
    meta.content = '#f3f3f3';
    meta.media = '(prefers-color-scheme: light)';
    document.head.append(meta);
    applyTheme('dark');
    expect(meta.content).toBe('#2c2c2c');
    applyTheme('light');
    expect(meta.content).toBe('#f3f3f3');
    meta.remove();
    style.remove();
  });
});

describe('dialog dragging', () => {
  it('keeps the title bar on screen', async () => {
    const { installCanvasStub } = await import('./helpers.js');
    installCanvasStub();
    const { openDialog } = await import('../src/ui/dialogs/dialog.js');
    const p = openDialog({
      title: 'Drag me',
      body: document.createElement('p'),
      buttons: [{ label: 'OK', value: true, primary: true }],
    });
    const dialog = document.querySelector('dialog.dialog');
    const header = dialog.querySelector('.dialog-header');
    header.setPointerCapture = () => {};
    Object.defineProperty(header, 'offsetHeight', { configurable: true, value: 40 });
    const pe = (type, x, y) => {
      const e = new MouseEvent(type, { clientX: x, clientY: y, bubbles: true });
      Object.defineProperty(e, 'pointerId', { value: 1 });
      header.dispatchEvent(e);
    };
    pe('pointerdown', 10, 10);
    pe('pointermove', 5000, 5000);
    pe('pointerup', 5000, 5000);
    expect(parseFloat(dialog.style.left)).toBe(window.innerWidth - 80);
    expect(parseFloat(dialog.style.top)).toBe(window.innerHeight - 40);
    dialog.querySelector('.btn.primary').click();
    expect(await p).toBe(true);
  });
});

describe('workspace dock tab', () => {
  it('a saved workspace opens on the dock tab used last, not its default tab', async () => {
    const { installCanvasStub } = await import('./helpers.js');
    const { App } = await import('../src/app.js');
    const { Prefs } = await import('../src/prefs.js');
    const { installFeatures } = await import('../src/features.js');
    installCanvasStub();
    const store = new Map([
      ['vector-studio:prefs', JSON.stringify({ workspace: 'typography', dockTab: 'paragraph' })],
    ]);
    const storage = {
      getItem: (k) => store.get(k) ?? null,
      setItem: (k, v) => store.set(k, String(v)),
    };
    document.body.innerHTML = '<div id="app" class="app"></div>';
    const app = new App(document.getElementById('app'), {
      prefs: new Prefs(storage),
      onSignOut: () => {},
    });
    installFeatures(app);
    app.start();
    expect(app.dock.getLayout().dock).toContain('character');
    expect(app.dock.getLayout().active).toBe('paragraph');
    expect(app.prefs.get('dockTab')).toBe('paragraph');
  });
});

describe('submenus on touch screens', () => {
  it('open with the tap, not as the finger lands', async () => {
    const { openMenu } = await import('../src/ui/menubar.js');
    const run = () => {};
    const items = [
      { type: 'sub', label: 'More', items: [{ type: 'cmd', label: 'Inner', enabled: true, run }] },
    ];
    const m = openMenu({}, items, { x: 10, y: 10 });
    const row = m.el.querySelector('.menu-item');
    const enter = new Event('pointerenter');
    enter.pointerType = 'touch';
    row.dispatchEvent(enter);
    expect(document.querySelectorAll('.menu').length).toBe(1);
    row.click();
    expect(document.querySelectorAll('.menu').length).toBe(2);
    expect(document.activeElement.textContent).toContain('Inner');
    m.close();
  });
});

describe('menu bar on touch screens', () => {
  it('tapping another menu title while a menu is open opens that menu', async () => {
    const { app } = await appWithRect();
    const titles = [...document.querySelectorAll('.menubar-item')];
    titles[0].click();
    expect(document.querySelector('.menu').getAttribute('aria-label')).toBe('File');
    const enter = new Event('pointerenter');
    enter.pointerType = 'touch';
    titles[1].dispatchEvent(enter);
    titles[1].click();
    const menus = [...document.querySelectorAll('.menu')];
    expect(menus.map((m) => m.getAttribute('aria-label'))).toEqual(['Edit']);
    menus[0]
      .querySelector('.menu-item')
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(app.root.contains(document.activeElement)).toBe(true);
  });
});

describe('number field scrubbing', () => {
  it('a cancelled pointer ends the scrub, so later pointer moves leave the value alone', async () => {
    const { numberField } = await import('../src/ui/widgets.js');
    const seen = [];
    const f = numberField({
      label: 'X',
      kind: 'number',
      value: 100,
      onCommit: (v) => seen.push(v),
    });
    document.body.append(f.el);
    const lab = f.el.querySelector('.num-label');
    lab.setPointerCapture = () => {};
    const pe = (type, x) => {
      const e = new MouseEvent(type, { clientX: x, clientY: 5, bubbles: true, cancelable: true });
      Object.defineProperty(e, 'pointerId', { value: 1 });
      lab.dispatchEvent(e);
    };
    pe('pointerdown', 10);
    pe('pointermove', 30);
    expect(seen).toEqual([110]);
    pe('pointercancel', 30);
    pe('pointermove', 60);
    expect(seen).toEqual([110]);
    expect(document.activeElement).not.toBe(f.input);
    f.el.remove();
  });
});

describe('panels hidden with Tab', () => {
  it('come back from Window > Show Panels, the Panels button or opening a panel', async () => {
    const { app } = await appWithRect();
    const tab = () => {
      app.canvasHost.focus();
      app.canvasHost.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Tab', code: 'Tab', bubbles: true, cancelable: true }),
      );
    };
    tab();
    expect(app.root.classList.contains('hide-panels')).toBe(true);
    expect(app.commands.label('window.toggleDock')).toBe('Show Panels');
    expect(document.querySelector('.status-panels').getAttribute('aria-pressed')).toBe('false');
    await app.commands.run('window.toggleDock');
    expect(app.root.classList.contains('hide-panels')).toBe(false);
    expect(app.dockOpen).toBe(true);
    tab();
    document.querySelector('.status-panels').click();
    expect(app.root.classList.contains('hide-panels')).toBe(false);
    tab();
    app.openPanel('color');
    expect(app.root.classList.contains('hide-panels')).toBe(false);
    expect(app.dock.flyoutId).toBe('color');
  });
});

describe('imported settings', () => {
  it('apply an imported shortcut set right away', async () => {
    const { app } = await appWithRect();
    const { applySettings } = await import('../src/features/panels/edit-commands.js');
    applySettings(app, {
      shortcutSets: {
        active: 'Mine',
        sets: { Mine: { commands: { 'object.group': 'Mod+Alt+Shift+9' }, tools: { pen: 'Q' } } },
      },
    });
    expect(app.commands.get('object.group').shortcut).toBe('Mod+Alt+Shift+9');
    expect(app.toolKeys.get('q')).toBe('pen');
  });
});

describe('imported settings and the workspace', () => {
  it('apply an imported workspace and tool set right away', async () => {
    const { app } = await appWithRect();
    const { applySettings } = await import('../src/features/panels/edit-commands.js');
    expect(app.dock.getLayout().dock).not.toContain('character');
    applySettings(app, { workspace: 'typography', toolbarSet: 'basic' });
    expect(app.dock.getLayout().dock).toContain('character');
    expect(app.toolbarFilter?.('magic-wand')).toBe(true);
    expect(app.toolbarFilter?.('knife')).toBe(false);
  });
});
