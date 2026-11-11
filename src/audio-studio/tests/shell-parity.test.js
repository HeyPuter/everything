// App shell: built-in workspaces, toolbar workspace tabs and the migration of
// layouts saved against older built-in arrangements.
import { describe, it, expect } from 'vitest';
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
