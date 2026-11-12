// App shell: built-in workspaces, toolbar workspace tabs and the migration of
// layouts saved against older built-in arrangements.
import { describe, it, expect, vi } from 'vitest';
import { WORKSPACES, DEFAULT_TABS, LAYOUT_VERSION } from '../src/ui/workspaces.js';

const groups = (node, out = []) => {
  if (node.t === 'group') out.push(node);
  else for (const c of node.c) groups(c, out);
  return out;
};
const groupWith = (tree, id) => groups(tree).find((g) => g.tabs.includes(id));

async function makeApp(stored) {
  HTMLCanvasElement.prototype.getContext = () => null;
  globalThis.ResizeObserver ??= class {
    observe() {}
    disconnect() {}
  };
  localStorage.clear();
  if (stored) localStorage.setItem('audio-studio:prefs', JSON.stringify(stored));
  const { App } = await import('../src/app.js');
  const { installCore } = await import('../src/features/core.js');
  const app = new App();
  installCore(app);
  app.syncGraph = () => {};
  return app;
}

describe('Default workspace', () => {
  const tree = WORKSPACES.Default();

  it('groups the panels like a desktop audio editor', () => {
    expect(groupWith(tree, 'files').tabs).toEqual(['files', 'favorites']);
    expect(groupWith(tree, 'media').tabs).toEqual(['media', 'effects', 'markers', 'properties']);
    expect(groupWith(tree, 'history').tabs).toEqual(['history', 'video']);
    expect(groupWith(tree, 'editor').tabs).toEqual(['editor', 'mixer']);
    expect(groupWith(tree, 'assistant').tabs).toEqual(['assistant']);
    // Levels has a frame of its own, showing on first launch.
    expect(groupWith(tree, 'levels')).toMatchObject({ tabs: ['levels'], a: 'levels' });
    expect(groupWith(tree, 'selection').tabs).toEqual(['selection']);
    expect(groupWith(tree, 'phase')).toBeUndefined();
  });

  it('puts the meters under the editor and the browsers in the left column', () => {
    expect(tree.t).toBe('row');
    const [left, right] = tree.c;
    expect(left.t).toBe('col');
    expect(left.c.map((g) => g.a)).toEqual(['files', 'media', 'history']);
    const [top, bottom] = right.c;
    expect(top.c.map((g) => g.a)).toEqual(['editor', 'assistant']);
    expect(bottom.c.map((g) => g.a)).toEqual(['levels', 'selection']);
    // The editor row takes most of the height.
    expect(right.s[0] / right.s[1]).toBeGreaterThan(5);
  });
});

describe('workspace tabs and saved layouts', () => {
  it('shows Default, Edit Audio to Video and Radio Production as toolbar tabs by default', async () => {
    const app = await makeApp();
    const { tabNames } = await import('../src/ui/workspace-manager.js');
    expect(DEFAULT_TABS.every((n) => WORKSPACES[n])).toBe(true);
    expect(tabNames(app)).toEqual(DEFAULT_TABS);
    const labels = app.workspaceMenuItems().filter((i) => i.type === 'cmd').map((i) => i.label);
    expect(labels.slice(0, 11)).toEqual(Object.keys(WORKSPACES));
  });

  it('drops layouts arranged on top of older built-in workspaces', async () => {
    const custom = { t: 'group', tabs: ['editor'], a: 'editor' };
    const app = await makeApp({
      workspace: 'Minimal Edit',
      layouts: { Default: { t: 'group', tabs: ['phase'], a: 'phase' }, Classic: custom, Mine: custom },
      savedLayouts: { Classic: custom },
      customWorkspaces: { Mine: custom },
    });
    expect(app.prefs.get('layoutVersion')).toBe(LAYOUT_VERSION);
    expect(Object.keys(app.prefs.get('layouts')).sort()).toEqual(['Classic', 'Mine']);
    // A workspace that no longer exists falls back to Default.
    expect(app.prefs.get('workspace')).toBe('Default');
    app.layoutMode = 'desktop';
    expect(groupWith(app.currentLayout(), 'levels').a).toBe('levels');
  });

  it('keeps arrangements made against the current version', async () => {
    const mine = { t: 'group', tabs: ['editor', 'levels'], a: 'levels' };
    const app = await makeApp({ layoutVersion: LAYOUT_VERSION, layouts: { Default: mine } });
    expect(app.prefs.get('layouts').Default).toEqual(mine);
  });
});

describe('status bar', async () => {
  const { statusParts } = await import('../src/ui/status-fields.js');
  const { setVideoOfDoc } = await import('../src/video/media.js');
  const { Prefs } = await import('../src/lib/prefs.js');
  const app = { prefs: new Prefs({ getItem: () => null, setItem: () => {} }), formatTime: (f, rate) => `${(f / rate).toFixed(3)}`, recording: false };
  const doc = { kind: 'audio', sampleRate: 48000, channelCount: 2, length: 48000 * 12, info: { bitDepth: 16 }, dirty: false, source: { type: 'local' } };

  it('sizes uncompressed audio at the file bit depth and shows free space', () => {
    expect(statusParts(app, doc, { cursor: null, freeBytes: 2 * 1024 ** 3 })).toEqual(['48000 Hz • 16-bit • Stereo', '2.20 MB', '12.000', '2.00 GB free']);
  });

  it('shows only the free space while no file is open', () => {
    expect(statusParts(app, null, { cursor: null, freeBytes: 1024 ** 3 })).toEqual(['1.00 GB free']);
    expect(statusParts(app, null, { cursor: null, freeBytes: null })).toEqual([]);
  });

  it('shows the frame rate of the video a file came with', () => {
    const withVideo = { ...doc };
    setVideoOfDoc(withVideo, { fps: 29.97 });
    expect(statusParts(app, withVideo, { cursor: null, freeBytes: null })[0]).toBe('29.97 fps');
    app.prefs.set('statusFields', { frameRate: false });
    expect(statusParts(app, withVideo, { cursor: null, freeBytes: null })).not.toContain('29.97 fps');
  });
});

describe('View menu', () => {
  it('lists the time display formats with SMPTE rates in descending order and names the custom rate', async () => {
    const app = await makeApp();
    app.prefs.set('customFps', 15);
    const labels = app.timeFormatMenuItems().map((i) => i.label);
    expect(labels.slice(0, 13)).toEqual([
      'Decimal (mm:ss.ddd)',
      'Compact (hh:mm:ss.ddd)',
      'SMPTE 59.94 fps',
      'SMPTE 59.94 fps Drop',
      'SMPTE 30 fps',
      'SMPTE 29.97 fps',
      'SMPTE 29.97 fps Drop',
      'SMPTE 25 fps (EBU)',
      'SMPTE 24 fps (Film)',
      'SMPTE 23.976 fps',
      'Samples',
      'Bars and Beats',
      'Custom (15 fps)',
    ]);
    app.timeFormatMenuItems().find((i) => i.label === 'SMPTE 59.94 fps Drop').run();
    expect(app.prefs.get('timeFormat')).toBe('smpte5994df');
  });

  it('has the status bar fields, waveform channel options and editor panel controls', async () => {
    const { MENUS, commandMenuPaths } = await import('../src/ui/menus.js');
    const app = await makeApp();
    const paths = commandMenuPaths(MENUS);
    for (const id of ['status.cursor', 'status.frameRate', 'status.dropped']) expect(paths.get(id)).toEqual(['Status Bar']);
    expect(paths.get('view.waveLayered')).toEqual(['Waveform Channels']);
    expect(app.commands.label('status.frameRate')).toBe('Video Frame Rate');
    expect(app.commands.label('status.dropped')).toBe('Detect Dropped Samples');
    expect(app.commands.label('view.editorControls')).toBe('Show Editor Panel Controls');
    app.commands.run('view.editorControls');
    expect(document.documentElement.dataset.editorControls).toBe('off');
  });
});

describe('toolbar workspace tabs', () => {
  it('puts a workspace menu beside the current workspace tab', async () => {
    const app = await makeApp();
    const { createShell } = await import('../src/ui/shell.js');
    let menu = null;
    app.openMenu = (items) => (menu = items);
    const root = document.createElement('div');
    document.body.replaceChildren(root);
    Object.defineProperty(window, 'innerWidth', { value: 1600, configurable: true });
    createShell(app, root);
    await new Promise((r) => requestAnimationFrame(r));
    const tabs = [...root.querySelectorAll('.workspace-tab')].map((b) => b.textContent);
    expect(tabs).toEqual(DEFAULT_TABS);
    const btn = root.querySelector('.workspace-menu-btn');
    expect(btn.previousElementSibling.getAttribute('aria-selected')).toBe('true');
    btn.click();
    const items = [...document.querySelectorAll('[role=menu] [role^=menuitem]')].map((e) => e.textContent);
    expect(items.some((t) => t.includes('Save as New Workspace'))).toBe(true);
    expect(items.some((t) => t.includes('Edit Workspaces'))).toBe(true);
    expect(menu).toBe(null);
  });
});

describe('command search', () => {
  it('keeps focus in the search field while results show, so typing goes on', async () => {
    const app = await makeApp();
    const { createShell } = await import('../src/ui/shell.js');
    const root = document.createElement('div');
    document.body.replaceChildren(root);
    createShell(app, root);
    const input = root.querySelector('.command-search');
    input.focus();
    input.value = 'n';
    input.dispatchEvent(new Event('input'));
    expect(document.querySelector('[role=menu][aria-label="Command results"]')).not.toBe(null);
    expect(document.activeElement).toBe(input);
    input.value = 'new';
    input.dispatchEvent(new Event('input'));
    expect(document.activeElement).toBe(input);
    expect(document.querySelectorAll('[role=menu]')).toHaveLength(1);
    // Down moves into the results; Escape there closes them and returns to the field.
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(document.activeElement.closest('[aria-label="Command results"]')).not.toBe(null);
    document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(document.querySelector('[role=menu]')).toBe(null);
    expect(document.activeElement).toBe(input);
  });
});

describe('shortcuts while typing', () => {
  it('leaves select all, clipboard and undo keys to a focused text field', async () => {
    const app = await makeApp();
    const { createShell } = await import('../src/ui/shell.js');
    const { IS_MAC, CommandRegistry } = await import('../src/commands/registry.js');
    const root = document.createElement('div');
    document.body.replaceChildren(root);
    createShell(app, root);
    // Earlier tests' shells are still listening too, so watch every registry.
    const ran = [];
    const spy = vi.spyOn(CommandRegistry.prototype, 'run').mockImplementation((id) => ran.push(id));
    const field = document.createElement('input');
    field.type = 'text';
    root.append(field);
    const press = (target, key, extra = {}) => {
      const e = new KeyboardEvent('keydown', { key, code: `Key${key.toUpperCase()}`, bubbles: true, cancelable: true, metaKey: IS_MAC, ctrlKey: !IS_MAC, ...extra });
      target.dispatchEvent(e);
      return e.defaultPrevented;
    };
    for (const k of ['a', 'c', 'v', 'x', 'z', 'y']) expect(press(field, k)).toBe(false);
    expect(press(field, 'z', { shiftKey: true })).toBe(false);
    expect(ran).toEqual([]);
    // Other command shortcuts (Save) still work from a field, and Select All works elsewhere.
    expect(press(field, 's')).toBe(true);
    expect(press(document.body, 'a')).toBe(true);
    expect(ran).toEqual(['file.save', 'edit.selectAll']);
    spy.mockRestore();
  });
});

describe('toolbar and panel buttons', () => {
  it('hides the workspace button outside the desktop layout, honours a hidden status bar and sizes panel menus for touch', async () => {
    const app = await makeApp();
    const { createShell } = await import('../src/ui/shell.js');
    const root = document.createElement('div');
    document.body.replaceChildren(root);
    Object.defineProperty(window, 'innerWidth', { value: 820, configurable: true });
    createShell(app, root);
    await new Promise((r) => requestAnimationFrame(r));
    const more = root.querySelector('[aria-label="All workspaces"]');
    expect(more.hidden).toBe(true);
    // .icon-btn sets display, which would override the hidden attribute (jsdom does not cascade it).
    const fs = await import('node:fs');
    const css = fs.readFileSync(`${import.meta.dirname}/../src/styles/shell.css`, 'utf8');
    expect(css).toMatch(/\.toolbar \.icon-btn\[hidden\] \{\s*display: none;/);
    // Every component's hidden elements stay hidden whatever display its class sets
    // (Files > Show Preview Transport, Media Browser's Add Folder without folder access).
    const base = fs.readFileSync(`${import.meta.dirname}/../src/styles/base.css`, 'utf8');
    expect(base).toMatch(/\[hidden\] \{\s*display: none !important;/);
    // View > Status Bar hides the bar with the hidden attribute, which .statusbar's display overrides.
    expect(css).toMatch(/\.statusbar\[hidden\] \{\s*display: none;/);
    // Panel menu buttons take taps over a larger transparent area on coarse pointers.
    expect(css).toMatch(/@media \(pointer: coarse\) \{\s*\.panel-menu-btn \{\s*position: relative;\s*\}\s*\.panel-menu-btn::before \{\s*content: '';\s*position: absolute;\s*inset: -9px -8px -9px -6px;/);
    Object.defineProperty(window, 'innerWidth', { value: 1600, configurable: true });
  });
});

describe('workspace tabs and keyboard focus', () => {
  it('keeps focus on a workspace tab through status messages, playback and workspace changes', async () => {
    const app = await makeApp();
    const { createShell } = await import('../src/ui/shell.js');
    const root = document.createElement('div');
    document.body.replaceChildren(root);
    Object.defineProperty(window, 'innerWidth', { value: 1600, configurable: true });
    createShell(app, root);
    const frame = () => new Promise((r) => requestAnimationFrame(r));
    await frame();
    const tab = (name) => [...root.querySelectorAll('.workspace-tab')].find((t) => t.textContent === name);
    const radio = tab('Radio Production');
    radio.focus();
    app.setStatus('Saved');
    app.emit('transport', 'playing');
    await frame();
    expect(document.activeElement).toBe(radio);
    radio.click();
    await frame();
    expect(app.prefs.get('workspace')).toBe('Radio Production');
    expect(document.activeElement).toBe(tab('Radio Production'));
    expect(document.activeElement.getAttribute('aria-selected')).toBe('true');
    root.querySelector('.workspace-menu-btn').focus();
    app.setWorkspace('Default');
    await frame();
    expect(document.activeElement.getAttribute('aria-label')).toBe('Default workspace menu');
  });
});

describe('shortcut keys in button labels', () => {
  it('names the current key of each tool and transport button, also after a remap', async () => {
    const app = await makeApp();
    const { createShell } = await import('../src/ui/shell.js');
    const { transportButtons } = await import('../src/panels/transport-controls.js');
    const root = document.createElement('div');
    document.body.replaceChildren(root);
    createShell(app, root);
    const frame = () => new Promise((r) => requestAnimationFrame(r));
    const move = root.querySelector('[data-tool="move"]');
    expect(move.getAttribute('aria-label')).toBe('Move Tool (V)');
    const transport = transportButtons(app);
    const play = transport.byCmd['transport.play'];
    expect(play.title).toBe('Play (Space)');
    app.commands.setShortcuts('tool.move', ['Shift+V']);
    app.commands.setShortcuts('transport.toggle', ['K']);
    await frame();
    transport.update();
    expect(move.getAttribute('aria-label')).toBe('Move Tool (Shift+V)');
    expect(move.title).toBe('Move Tool (Shift+V)');
    expect(play.getAttribute('aria-label')).toBe('Play (K)');
    // Without a key the label stands alone.
    app.commands.setShortcuts('tool.move', []);
    await frame();
    expect(move.getAttribute('aria-label')).toBe('Move Tool');
    const waveform = root.querySelector('.mode-btn[data-kind="audio"]');
    expect(waveform.title).toBe('Waveform (9)');
  });
});

describe('forced colors', () => {
  it('redraws focus, current tabs and selected items with system colors', async () => {
    const fs = await import('node:fs');
    const css = fs.readFileSync(`${import.meta.dirname}/../src/styles/base.css`, 'utf8');
    const block = css.slice(css.indexOf('@media (forced-colors: active) {'));
    expect(block).toMatch(/\.menu-item:focus,\s*\.menu-item:hover \{\s*forced-color-adjust: none;\s*background: Highlight;/);
    expect(block).toMatch(/\.menu-item\[aria-disabled='true'\],[^{]*\{\s*color: GrayText;/);
    expect(block).toMatch(/\.panel-tab\[aria-selected='true'\]::after \{\s*forced-color-adjust: none;\s*background: Highlight;/);
    expect(block).toMatch(/\.icon-btn\[aria-pressed='true'\],[^{]*\.data-table tbody tr\[aria-selected='true'\] \{\s*forced-color-adjust: none;\s*background: SelectedItem;/);
  });
});

describe('theme contrast', () => {
  it('keeps faint text readable (4.5:1) on panels in both themes', async () => {
    const fs = await import('node:fs');
    const css = fs.readFileSync(`${import.meta.dirname}/../src/styles/tokens.css`, 'utf8');
    const block = (sel) => css.slice(css.indexOf(sel), css.indexOf('}', css.indexOf(sel)));
    const token = (b, name) => b.match(new RegExp(`${name}: (#[0-9a-f]{6});`))[1];
    const lum = (hex) => {
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const ratio = (a, b) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
    for (const sel of [":root[data-theme-resolved='dark']", ":root[data-theme-resolved='light']"]) {
      const b = block(sel);
      for (const bg of ['--bg-panel', '--bg-panel-alt']) expect(ratio(token(b, '--text-faint'), token(b, bg))).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe('popup menu focus', () => {
  it('returns focus to the opening button or the previous focus on Escape and Tab', async () => {
    const app = await makeApp();
    const { openMenu } = await import('../src/ui/menubar.js');
    const btn = document.createElement('button');
    const field = document.createElement('input');
    document.body.replaceChildren(btn, field);
    const items = [{ type: 'cmd', label: 'One', enabled: true, run: () => {} }, { type: 'sub', label: 'More', items: [{ type: 'cmd', label: 'Two', enabled: true, run: () => {} }] }];
    const key = (key) => document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
    btn.focus();
    openMenu(app, items, { x: 0, y: 0, anchor: btn });
    expect(document.activeElement.textContent).toContain('One');
    key('Escape');
    expect(document.querySelector('.menu')).toBe(null);
    expect(document.activeElement).toBe(btn);
    // Tab from a submenu closes the whole menu and goes back to the button too.
    openMenu(app, items, { x: 0, y: 0, anchor: btn });
    key('ArrowDown');
    key('ArrowRight');
    expect(document.activeElement.textContent).toContain('Two');
    key('Tab');
    expect(document.querySelector('.menu')).toBe(null);
    expect(document.activeElement).toBe(btn);
    // A context menu (no button) goes back to what had focus.
    field.focus();
    openMenu(app, items, { x: 0, y: 0 });
    key('Escape');
    expect(document.activeElement).toBe(field);
  });
});

describe('dialog initial focus', () => {
  it('skips an initial focus target that cannot take focus', async () => {
    const { openDialog } = await import('../src/ui/dialog.js');
    document.body.replaceChildren();
    const tab = document.createElement('button');
    tab.className = 'tab';
    tab.disabled = true; // like page tabs hidden on a phone
    const pick = document.createElement('select');
    pick.className = 'pick';
    const field = document.createElement('input');
    const body = document.createElement('div');
    body.append(field, pick, tab);
    const done = openDialog({ title: 'T', body, initialFocus: ['.tab', '.pick'] });
    expect(document.activeElement).toBe(pick);
    document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await done;
    // Nothing in the selector can take focus: the usual first field.
    pick.remove();
    const again = openDialog({ title: 'T', body, initialFocus: '.tab' });
    expect(document.activeElement).toBe(field);
    document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await again;
  });
});

describe('Space on focused controls', () => {
  it('toggles a focused checkbox or radio instead of starting playback', async () => {
    const app = await makeApp();
    const { createShell } = await import('../src/ui/shell.js');
    const { CommandRegistry } = await import('../src/commands/registry.js');
    const root = document.createElement('div');
    document.body.replaceChildren(root);
    createShell(app, root);
    const ran = [];
    const spy = vi.spyOn(CommandRegistry.prototype, 'run').mockImplementation((id) => ran.push(id));
    const space = (target) => {
      const e = new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true, cancelable: true });
      target.dispatchEvent(e);
      return e.defaultPrevented;
    };
    for (const type of ['checkbox', 'radio']) {
      const input = document.createElement('input');
      input.type = type;
      root.append(input);
      expect(space(input)).toBe(false);
    }
    expect(ran).toEqual([]);
    // Elsewhere Space still plays.
    expect(space(document.body)).toBe(true);
    expect(ran).toEqual(['transport.toggle']);
    spy.mockRestore();
  });
});
