import { describe, it, expect } from 'vitest';
import { Dock, normalize } from '../src/ui/dock.js';
import { WORKSPACES, PHONE, TABLET } from '../src/ui/workspaces.js';

const registry = (ids) => new Map(ids.map((id) => [id, { id, title: id.toUpperCase(), create: () => ({ el: document.createElement('div') }) }]));

describe('dock layout', () => {
  it('drops unknown panels and collapses empty frames and single-child splits', () => {
    const tree = { t: 'row', c: [{ t: 'group', tabs: ['x'] }, { t: 'col', c: [{ t: 'group', tabs: ['a', 'a', 'b'], a: 'z' }] }], s: [1, 2] };
    const out = normalize(tree, registry(['a', 'b']));
    expect(out).toEqual({ t: 'group', tabs: ['a', 'b'], a: 'a' });
  });

  it('flattens nested splits of the same direction keeping proportions', () => {
    const tree = { t: 'row', c: [{ t: 'group', tabs: ['a'] }, { t: 'row', c: [{ t: 'group', tabs: ['b'] }, { t: 'group', tabs: ['c'] }], s: [1, 3] }], s: [1, 1] };
    const out = normalize(tree, registry(['a', 'b', 'c']));
    expect(out.c.length).toBe(3);
    expect(out.s).toEqual([1, 0.25, 0.75]);
  });

  it('builds every workspace and opens, closes and maximizes panels', () => {
    const ids = ['editor', 'mixer', 'files', 'favorites', 'media', 'effects', 'markers', 'history', 'levels', 'selection', 'properties', 'assistant', 'frequency', 'amplitude', 'phase', 'loudness'];
    const root = document.createElement('div');
    document.body.append(root);
    const app = { openMenu() {} };
    const dock = new Dock(app, root, registry(ids));
    for (const make of [...Object.values(WORKSPACES), PHONE, TABLET]) {
      dock.setLayout(make());
      expect(dock.isOpen('editor')).toBe(true);
    }
    dock.setLayout(WORKSPACES.Default());
    expect(root.querySelectorAll('.panel-group').length).toBe(dock.groups().length);
    dock.closePanel('history');
    expect(dock.isOpen('history')).toBe(false);
    dock.openPanel('history', { focus: false });
    expect(dock.isVisible('history')).toBe(true);
    // A panel opened from a menu command outlines its frame for a moment.
    dock.openPanel('loudness', { focus: false, attention: true });
    expect(dock.instances.get('loudness').el.closest('.panel-group').classList.contains('panel-attention')).toBe(true);
    const g = dock.groupOf('editor');
    dock.toggleMaximize(g);
    expect(root.querySelectorAll('.panel-group').length).toBe(1);
    dock.toggleMaximize(g);
    expect(root.querySelectorAll('.panel-group').length).toBe(dock.groups().length);
    const tab = root.querySelector('#tab-mixer');
    tab.click();
    expect(dock.isVisible('mixer')).toBe(true);
  });
});

describe('dock keyboard focus', () => {
  const make = () => {
    const root = document.createElement('div');
    document.body.append(root);
    const ids = ['editor', 'files', 'history', 'video'];
    const reg = new Map(ids.map((id) => [id, { id, title: id, create: () => ({ el: Object.assign(document.createElement('div'), { tabIndex: -1 }) }) }]));
    const app = { openMenu() {}, focusTarget: () => root.querySelector('[data-panel="editor"]') };
    const dock = new Dock(app, root, reg);
    dock.setLayout({ t: 'row', c: [{ t: 'group', tabs: ['files', 'history', 'video'], a: 'history' }, { t: 'group', tabs: ['editor'], a: 'editor' }], s: [1, 3] });
    return { root, dock };
  };

  it('keeps focus in a panel when its frame is maximized and restored', () => {
    const { root, dock } = make();
    const editor = root.querySelector('[data-panel="editor"]');
    editor.focus();
    dock.toggleMaximize(dock.groupOf('editor'));
    expect(document.activeElement).toBe(editor);
    dock.toggleMaximize();
    expect(document.activeElement).toBe(editor);
    root.remove();
  });

  it('moves focus to the frame’s current tab when the focused panel menu button goes away', () => {
    const { root, dock } = make();
    root.querySelector('[data-panel="history"]').closest('.panel-group').querySelector('.panel-menu-btn').focus();
    dock.closePanel('history');
    expect(document.activeElement.id).toBe('tab-files');
    // Closing the last panel of a frame hands focus to the editor.
    dock.closePanel('files');
    root.querySelector('#tab-video').focus();
    dock.closePanel('video');
    expect(document.activeElement).toBe(root.querySelector('[data-panel="editor"]'));
    root.remove();
  });
});

describe('panel menu', () => {
  it('shows the current key of Maximize Frame after it is remapped', () => {
    const root = document.createElement('div');
    document.body.append(root);
    let items = null;
    const app = { openMenu: (list) => (items = list), commands: { shortcutLabel: (id) => (id === 'window.maximize' ? 'F5' : '') } };
    const dock = new Dock(app, root, registry(['editor', 'files']));
    dock.setLayout({ t: 'group', tabs: ['editor', 'files'], a: 'editor' });
    root.querySelector('.panel-menu-btn').click();
    expect(items.find((it) => it.label === 'Maximize Frame').shortcut).toBe('F5');
    root.remove();
  });
});

describe('tab drag', () => {
  it('cancels with Escape, leaving the panel where it was', () => {
    const root = document.createElement('div');
    document.body.replaceChildren(root);
    const dock = new Dock({ openMenu() {} }, root, registry(['editor', 'files', 'history']));
    const files = { t: 'group', tabs: ['files', 'history'] };
    dock.setLayout({ t: 'row', c: [files, { t: 'group', tabs: ['editor'] }], s: [1, 3] });
    const before = JSON.stringify(dock.layout());
    // jsdom has no layout: give the editor frame a box to drop onto.
    const frame = root.querySelector('#tab-editor').closest('.panel-group');
    const box = { left: 200, top: 0, right: 600, bottom: 400, width: 400, height: 400 };
    frame.getBoundingClientRect = () => box;
    const at = (type, x, y) => {
      const e = new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 });
      Object.defineProperty(e, 'pointerType', { value: 'mouse' });
      return e;
    };
    const tab = root.querySelector('#tab-history');
    tab.dispatchEvent(at('pointerdown', 10, 10));
    window.dispatchEvent(at('pointermove', 400, 200));
    expect(document.querySelector('.dock-ghost')).not.toBe(null);
    const esc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    window.dispatchEvent(esc);
    expect(esc.defaultPrevented).toBe(true);
    expect(document.querySelector('.dock-ghost')).toBe(null);
    window.dispatchEvent(at('pointerup', 400, 200));
    expect(JSON.stringify(dock.layout())).toBe(before);
    // Without Escape the same drag moves the panel.
    tab.dispatchEvent(at('pointerdown', 10, 10));
    window.dispatchEvent(at('pointermove', 400, 200));
    window.dispatchEvent(at('pointerup', 400, 200));
    expect(dock.groupOf('history').tabs).toContain('editor');
  });

  it('reorders tabs dropped on a tab strip, with an insertion bar between tabs', () => {
    const root = document.createElement('div');
    document.body.replaceChildren(root);
    const dock = new Dock({ openMenu() {} }, root, registry(['editor', 'files', 'history', 'markers']));
    dock.setLayout({ t: 'row', c: [{ t: 'group', tabs: ['files', 'history', 'markers'] }, { t: 'group', tabs: ['editor'] }], s: [1, 3] });
    // jsdom has no layout: give the frames, strips and tabs boxes.
    const box = (left, top, width, height) => ({ left, top, width, height, right: left + width, bottom: top + height });
    const layoutBoxes = () => {
      const frames = [...root.querySelectorAll('.panel-group')];
      frames.forEach((f, i) => {
        f.getBoundingClientRect = () => box(i * 300, 0, 300, 400);
        const strip = f.querySelector('.panel-tabs');
        strip.getBoundingClientRect = () => box(i * 300, 0, 300, 30);
        Object.defineProperty(strip, 'offsetHeight', { value: 30, configurable: true });
        [...strip.querySelectorAll('.panel-tab')].forEach((t, j) => (t.getBoundingClientRect = () => box(i * 300 + j * 80, 0, 70, 30)));
      });
    };
    layoutBoxes();
    const at = (type, x, y) => {
      const e = new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 });
      Object.defineProperty(e, 'pointerType', { value: 'mouse' });
      return e;
    };
    // Markers to before Files.
    root.querySelector('#tab-markers').dispatchEvent(at('pointerdown', 170, 10));
    window.dispatchEvent(at('pointermove', 20, 12));
    const bar = document.querySelector('.dock-drop');
    expect(bar.classList.contains('zone-tabs')).toBe(true);
    expect(bar.style.width).toBe('2px');
    window.dispatchEvent(at('pointerup', 20, 12));
    expect(dock.groupOf('files').tabs).toEqual(['markers', 'files', 'history']);
    expect(dock.groupOf('files').a).toBe('markers');
    // Files into the editor's strip, after Editor.
    layoutBoxes();
    root.querySelector('#tab-files').dispatchEvent(at('pointerdown', 90, 10));
    window.dispatchEvent(at('pointermove', 360, 12));
    window.dispatchEvent(at('pointerup', 360, 12));
    expect(dock.groupOf('editor').tabs).toEqual(['editor', 'files']);
    expect(dock.groupOf('markers').tabs).toEqual(['markers', 'history']);
    // Dropping a tab next to itself changes nothing.
    layoutBoxes();
    const before = JSON.stringify(dock.layout());
    root.querySelector('#tab-markers').dispatchEvent(at('pointerdown', 10, 10));
    window.dispatchEvent(at('pointermove', 60, 12));
    window.dispatchEvent(at('pointerup', 60, 12));
    expect(JSON.stringify(dock.layout())).toBe(before);
  });

  it('maximizes a frame when its tab is double-clicked, and restores it', () => {
    const root = document.createElement('div');
    document.body.replaceChildren(root);
    const dock = new Dock({ openMenu() {} }, root, registry(['editor', 'files', 'history']));
    dock.setLayout({ t: 'row', c: [{ t: 'group', tabs: ['files', 'history'] }, { t: 'group', tabs: ['editor'] }], s: [1, 3] });
    root.querySelector('#tab-files').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect(root.querySelectorAll('.panel-group')).toHaveLength(1);
    expect(dock.maximized).toBe(dock.groupOf('files'));
    // The panel menu button is not a tab: double-clicking it leaves the frame alone.
    root.querySelector('.panel-menu-btn').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect(dock.maximized).toBe(dock.groupOf('files'));
    root.querySelector('#tab-files').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect(root.querySelectorAll('.panel-group')).toHaveLength(2);
  });

  it('opens a panel menu when its tab is right-clicked', () => {
    const root = document.createElement('div');
    document.body.replaceChildren(root);
    let label = null;
    const dock = new Dock({ openMenu: (items, o) => (label = o.label) }, root, registry(['editor', 'files', 'history']));
    dock.setLayout({ t: 'row', c: [{ t: 'group', tabs: ['files', 'history'] }, { t: 'group', tabs: ['editor'] }], s: [1, 3] });
    const e = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    root.querySelector('#tab-history').dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
    expect(label).toBe('HISTORY panel menu');
  });

  it('docks a dragged tab along a whole workspace edge', () => {
    const root = document.createElement('div');
    document.body.replaceChildren(root);
    const dock = new Dock({ openMenu() {} }, root, registry(['editor', 'files', 'history']));
    dock.setLayout({ t: 'col', c: [{ t: 'group', tabs: ['files', 'history'] }, { t: 'group', tabs: ['editor'] }], s: [1, 3] });
    root.getBoundingClientRect = () => ({ left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600 });
    const at = (type, x, y) => {
      const e = new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 });
      Object.defineProperty(e, 'pointerType', { value: 'mouse' });
      return e;
    };
    root.querySelector('#tab-history').dispatchEvent(at('pointerdown', 50, 10));
    window.dispatchEvent(at('pointermove', 795, 300));
    const zone = document.querySelector('.dock-drop');
    expect(zone.style.left).toBe('600px');
    expect(zone.style.height).toBe('600px');
    window.dispatchEvent(at('pointerup', 795, 300));
    const tree = dock.layout();
    expect(tree.t).toBe('row');
    expect(tree.c[1]).toMatchObject({ t: 'group', tabs: ['history'] });
    expect(tree.c[0].t).toBe('col');
    expect(dock.groupOf('files').tabs).toEqual(['files']);
  });
});

describe('floating frames', () => {
  const make = () => {
    const root = document.createElement('div');
    document.body.replaceChildren(root);
    let items = null;
    const app = { openMenu: (list) => (items = list), layoutMode: 'desktop' };
    const dock = new Dock(app, root, registry(['editor', 'files', 'history', 'markers']));
    dock.setLayout({ t: 'row', c: [{ t: 'group', tabs: ['files', 'history', 'markers'] }, { t: 'group', tabs: ['editor'] }], s: [1, 3] });
    return { root, dock, menu: () => items };
  };

  it('undocks a panel into a floating frame, keeps it with the layout and docks it back', () => {
    const { root, dock, menu } = make();
    root.querySelector('#tab-history').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    const undock = menu().find((i) => i.label === 'Undock Panel');
    expect(menu().find((i) => i.label === 'Undock Frame').enabled).toBe(true);
    undock.run();
    expect(dock.floats).toHaveLength(1);
    expect(dock.groupOf('files').tabs).toEqual(['files', 'markers']);
    expect(dock.isVisible('history')).toBe(true);
    const float = root.querySelector('.dock-float');
    expect(float.querySelector('#tab-history')).not.toBe(null);
    expect(float.querySelector('.panel-group.floating')).not.toBe(null);
    // Saved with the layout and restored from it.
    const saved = dock.layout();
    expect(saved.floats).toEqual([expect.objectContaining({ tabs: ['history'], a: 'history' })]);
    dock.setLayout({ t: 'group', tabs: ['editor'] });
    expect(dock.floats).toHaveLength(0);
    dock.setLayout(saved);
    expect(dock.floatOf(dock.groupOf('history'))).not.toBe(null);
    // Its menu docks it back (and floating frames do not maximize).
    root.querySelector('.dock-float #tab-history').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    expect(menu().find((i) => /Maximize/.test(i.label)).enabled).toBe(false);
    menu().find((i) => i.label === 'Dock Frame').run();
    expect(dock.floats).toHaveLength(0);
    expect(dock.groupOf('files').tabs).toEqual(['files', 'markers', 'history']);
    expect(dock.layout().floats).toBeUndefined();
  });

  it('keeps the editor docked and drops floats whose panels are already docked', () => {
    const { root, dock, menu } = make();
    root.querySelector('#tab-editor').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    expect(menu().find((i) => i.label === 'Undock Panel').enabled).toBe(false);
    dock.setLayout({ t: 'group', tabs: ['editor', 'files'], floats: [{ tabs: ['files', 'history'], x: 10, y: 10, w: 300, h: 200 }] });
    expect(dock.floats.map((f) => f.node.tabs)).toEqual([['history']]);
  });

  it('closing a floating frame’s last panel removes the frame', () => {
    const { dock } = make();
    dock.undock('markers');
    expect(dock.floats).toHaveLength(1);
    dock.closePanel('markers');
    expect(dock.floats).toHaveLength(0);
    expect(dock.isOpen('markers')).toBe(false);
    // Reopening docks it again.
    dock.openPanel('markers', { focus: false });
    expect(dock.floats).toHaveLength(0);
    expect(dock.groupOf('files').tabs).toContain('markers');
  });
});

describe('floating windows with splits', () => {
  const at = (type, x, y, extra = {}) => {
    const e = new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0, ...extra });
    Object.defineProperty(e, 'pointerType', { value: 'mouse' });
    return e;
  };
  const make = () => {
    const root = document.createElement('div');
    document.body.replaceChildren(root);
    const dock = new Dock({ openMenu() {}, layoutMode: 'desktop' }, root, registry(['editor', 'files', 'history', 'markers']));
    dock.setLayout({ t: 'row', c: [{ t: 'group', tabs: ['files', 'history', 'markers'] }, { t: 'group', tabs: ['editor'] }], s: [1, 3] });
    root.getBoundingClientRect = () => ({ left: 0, top: 40, right: 800, bottom: 600, width: 800, height: 560 });
    return { root, dock };
  };

  it('a tab dragged out of the workspace (or with Ctrl) floats in a new window there', () => {
    const { root, dock } = make();
    root.querySelector('#tab-history').dispatchEvent(at('pointerdown', 50, 50));
    window.dispatchEvent(at('pointermove', 400, 10));
    const zone = document.querySelector('.dock-drop');
    expect(zone.classList.contains('zone-float')).toBe(true);
    expect(zone.textContent).toBe('Float in a window');
    window.dispatchEvent(at('pointerup', 400, 10));
    expect(dock.floats).toHaveLength(1);
    expect(dock.floats[0].node.tabs).toEqual(['history']);
    // Ctrl over the workspace floats too; the editor never floats.
    root.querySelector('#tab-markers').dispatchEvent(at('pointerdown', 120, 50));
    window.dispatchEvent(at('pointermove', 300, 300, { ctrlKey: true }));
    window.dispatchEvent(at('pointerup', 300, 300, { ctrlKey: true }));
    expect(dock.floats).toHaveLength(2);
    root.querySelector('#tab-editor').dispatchEvent(at('pointerdown', 400, 50));
    window.dispatchEvent(at('pointermove', 400, 5));
    window.dispatchEvent(at('pointerup', 400, 5));
    expect(dock.floatOf(dock.groupOf('editor'))).toBe(null);
  });

  it('splits a floating window, saves the split and restores it', () => {
    const { root, dock } = make();
    dock.undock('history');
    const frame = root.querySelector('.dock-float .panel-group');
    frame.getBoundingClientRect = () => ({ left: 100, top: 100, right: 500, bottom: 400, width: 400, height: 300 });
    root.querySelector('#tab-markers').dispatchEvent(at('pointerdown', 120, 50));
    window.dispatchEvent(at('pointermove', 300, 390));
    expect(document.querySelector('.dock-drop').textContent).toBe('Split below');
    window.dispatchEvent(at('pointerup', 300, 390));
    const f = dock.floats[0];
    expect(f.node.t).toBe('col');
    expect(dock.groups(f.node).map((g) => g.tabs)).toEqual([['history'], ['markers']]);
    expect(root.querySelectorAll('.dock-float .panel-group')).toHaveLength(2);
    const saved = dock.layout();
    expect(saved.floats[0].node.t).toBe('col');
    dock.setLayout(saved);
    expect(dock.groups(dock.floats[0].node)).toHaveLength(2);
    // Docking one frame back leaves the other in the window.
    dock.dockFloat(dock.groupOf('markers'));
    expect(dock.floats[0].node).toMatchObject({ t: 'group', tabs: ['history'] });
    expect(dock.floatOf(dock.groupOf('markers'))).toBe(null);
  });

  it('pulls floating windows back into view when the window shrinks', () => {
    const { root, dock } = make();
    Object.defineProperty(window, 'innerWidth', { value: 1600, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: 1000, configurable: true });
    dock.setLayout({ t: 'group', tabs: ['editor'], floats: [{ tabs: ['history'], x: 1400, y: 900, w: 300, h: 200 }] });
    expect(dock.floats[0]).toMatchObject({ x: 1400, y: 900 });
    Object.defineProperty(window, 'innerWidth', { value: 800, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: 600, configurable: true });
    window.dispatchEvent(new Event('resize'));
    expect(dock.floats[0]).toMatchObject({ x: 720, y: 560 });
    expect(root.querySelector('.dock-float').style.left).toBe('720px');
  });
});

describe('floating window title bar', () => {
  it('names the window’s panels and docks or closes all of them', () => {
    const root = document.createElement('div');
    document.body.replaceChildren(root);
    const dock = new Dock({ openMenu() {}, layoutMode: 'desktop' }, root, registry(['editor', 'files', 'history', 'markers']));
    dock.setLayout({ t: 'row', c: [{ t: 'group', tabs: ['files'] }, { t: 'group', tabs: ['editor'] }], s: [1, 3], floats: [{ node: { t: 'col', c: [{ t: 'group', tabs: ['history'] }, { t: 'group', tabs: ['markers'] }], s: [1, 1] }, x: 10, y: 10, w: 300, h: 300 }] });
    const bar = root.querySelector('.dock-float-bar');
    expect(bar.querySelector('.dock-float-title').textContent).toBe('HISTORY, MARKERS');
    bar.querySelector('[title="Dock this window"]').click();
    expect(dock.floats).toHaveLength(0);
    expect(dock.groupOf('files').tabs).toEqual(['files', 'history', 'markers']);
    dock.undock('history');
    root.querySelector('.dock-float-bar [title="Close this window"]').click();
    expect(dock.floats).toHaveLength(0);
    expect(dock.isOpen('history')).toBe(false);
  });
});

describe('panel switch motion', () => {
  it('fades in a panel chosen by its tab, not frames drawn for the first time', () => {
    const root = document.createElement('div');
    document.body.replaceChildren(root);
    const dock = new Dock({ openMenu() {} }, root, registry(['editor', 'files', 'history']));
    dock.setLayout({ t: 'row', c: [{ t: 'group', tabs: ['files', 'history'] }, { t: 'group', tabs: ['editor'] }], s: [1, 3] });
    expect(root.querySelector('.panel-enter')).toBe(null);
    root.querySelector('#tab-history').click();
    expect(root.querySelector('#body-history').classList.contains('panel-enter')).toBe(true);
    expect(root.querySelector('#body-editor').classList.contains('panel-enter')).toBe(false);
  });
});
