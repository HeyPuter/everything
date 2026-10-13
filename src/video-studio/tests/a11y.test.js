// Accessibility smoke tests: render the home screen and the editor shell in
// jsdom and run axe-core over them.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import axe from 'axe-core';
import { Library } from '../src/storage/library.js';
import { memoryBackend } from '../src/storage/backends.js';
import { Home } from '../src/ui/home.js';
import { Editor } from '../src/ui/editor.js';
import { fixture, clip, onMain } from './helpers.js';

/** Serious and critical axe violations in root, as readable strings. */
async function violations(root) {
  const result = await axe.run(root, {
    resultTypes: ['violations'],
    rules: {
      // jsdom does no layout or painting, so these cannot be judged here.
      'color-contrast': { enabled: false },
      'scrollable-region-focusable': { enabled: false },
    },
  });
  return result.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
}

const settle = () => new Promise((r) => setTimeout(r, 20));

let root;
beforeEach(() => {
  document.body.replaceChildren();
  root = document.createElement('div');
  root.id = 'app';
  document.body.append(root, Object.assign(document.createElement('div'), { id: 'live-region' }));
});

describe('home screen', () => {
  it('has no serious accessibility problems with projects listed', async () => {
    const lib = new Library(memoryBackend());
    await lib.createProject({ name: 'Holiday', ratio: '9:16' });
    await lib.createProject({ name: 'Interview' });
    const home = new Home(root, { library: lib, account: { user: { username: 'sam' } }, onOpen() {}, onCreate() {}, onImportFiles() {} });
    await settle();
    expect(root.textContent).toContain('Holiday');
    expect(await violations(root)).toEqual([]);
    expect(home).toBeTruthy();
  });

  it('has no serious accessibility problems in the Templates and Trash views', async () => {
    const lib = new Library(memoryBackend());
    const p = await lib.createProject({ name: 'Old cut' });
    await lib.trashProject(p.id);
    const home = new Home(root, { library: lib, account: {}, onOpen() {}, onCreate() {}, onImportFiles() {} });
    await settle();
    home.show('templates');
    expect(await violations(root)).toEqual([]);
    home.show('trash');
    expect(root.textContent).toContain('Old cut');
    expect(await violations(root)).toEqual([]);
    home.dispose();
    history.replaceState(null, '', '/');
  });

  it('has no serious accessibility problems when empty', async () => {
    new Home(root, { library: new Library(memoryBackend()), account: {}, onOpen() {}, onCreate() {}, onImportFiles() {} });
    await settle();
    expect(await violations(root)).toEqual([]);
  });
});

describe('editor shell', () => {
  let editor;
  afterEach(() => {
    editor?.dispose();
    editor = null;
    vi.restoreAllMocks();
  });

  it('mounts without WebGL and has no serious accessibility problems', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const p = fixture();
    onMain(p, clip('video', 0, 4), clip('image', 4, 2));
    const lib = new Library(memoryBackend());
    await lib.saveProject(p);
    editor = new Editor(root, { library: lib, project: p, account: { user: { username: 'sam' } }, onExit() {}, onNewProject() {} });
    await settle();
    expect(editor.ctx.player.supported).toBe(false);
    expect(root.querySelector('.editor')).toBeTruthy();
    expect(await violations(root)).toEqual([]);
  });

  it('has no serious problems in the new dialogs and panels', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const p = fixture();
    const [v] = onMain(p, clip('video', 0, 4), clip('image', 4, 2));
    v.keyframes = { x: [{ t: 0, v: 0, ease: 'linear' }, { t: 2_000_000, v: 0.2, ease: 'easeOut' }] };
    p.markers.push({ id: 'm1', time: 1_000_000, color: '#f5b83d', label: 'Beat' });
    p.range = { in: 0, out: 3_000_000 };
    const lib = new Library(memoryBackend());
    await lib.saveProject(p);
    editor = new Editor(root, { library: lib, project: p, account: { user: { username: 'sam' } }, onExit() {}, onNewProject() {} });
    await settle();
    const { ctx } = editor;
    ctx.store.select([v.id]);
    ctx.timeline.toggleKeyframePanel();
    ctx.history.toggle(true);
    await settle();
    expect(await violations(document.body)).toEqual([]);
    const dialogs = [() => ctx.openShortcuts(), () => ctx.openPreferences(), () => ctx.actions.editMarker('m1')];
    for (const open of dialogs) {
      open();
      await settle();
      const d = document.querySelector('dialog[open]');
      expect(d).toBeTruthy();
      expect(await violations(d)).toEqual([]);
      d.querySelector('.dialog-close').click();
    }
  });

  it('has no serious problems in the people, retouch, caption and recording panels', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const p = fixture();
    const [v] = onMain(p, clip('video', 0, 4));
    v.cutout = { feather: 25, shrink: 0, smooth: 40, strokes: [{ keep: true, size: 0.1, pts: [[0.5, 0.5]] }] };
    v.retouch = { smooth: 40, even: 20, brighten: 10, sharpen: 0 };
    v.colorTarget = 'person';
    const lib = new Library(memoryBackend());
    await lib.saveProject(p);
    editor = new Editor(root, { library: lib, project: p, account: { user: { username: 'sam' } }, onExit() {}, onNewProject() {} });
    await settle();
    const { ctx } = editor;
    ctx.store.select([v.id]);
    for (const sub of ['cutout', 'retouch']) {
      ctx.inspector.showVideoSub(sub);
      await settle();
      expect(await violations(document.body), sub).toEqual([]);
    }
    // Every retouch segment: sliders, shade swatches with a custom color well, look tiles.
    for (const seg of ['Body', 'Makeup', 'Hair', 'Looks']) {
      [...document.querySelectorAll('.retouch-segs [role=tab]')].find((t) => t.textContent.startsWith(seg)).click();
      await settle();
      expect(await violations(document.querySelector('.retouch-tab')), `retouch ${seg}`).toEqual([]);
    }
    ctx.inspector.showTab('adjust');
    await settle();
    expect(await violations(document.body), 'color').toEqual([]);
    const { openRecordDialog } = await import('../src/ui/record-dialog.js');
    const d = openRecordDialog(ctx, { mode: 'screen' });
    await settle();
    const dlg = document.querySelector('dialog[open]');
    dlg.querySelector('.tp-controls [role=switch], .tp-controls input[type=checkbox]')?.click();
    await settle();
    expect(await violations(dlg), 'record').toEqual([]);
    d.close();
  });
});
