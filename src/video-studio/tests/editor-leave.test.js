// Leaving the editor: edits and media that could not be saved are not
// dropped without asking.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Library } from '../src/storage/library.js';
import { memoryBackend } from '../src/storage/backends.js';
import { Editor } from '../src/ui/editor.js';
import { fixture, clip, onMain } from './helpers.js';

const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const dialog = () => document.querySelector('dialog[open]');
const button = (label) => [...(dialog()?.querySelectorAll('button') || [])].find((b) => b.textContent === label);

let root;
let editor;
beforeEach(() => {
  document.body.replaceChildren();
  root = document.createElement('div');
  root.id = 'app';
  document.body.append(root, Object.assign(document.createElement('div'), { id: 'live-region' }));
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  if (editor && !editor._disposed) editor.dispose();
  editor = null;
  vi.restoreAllMocks();
});

async function open() {
  const backend = memoryBackend();
  const library = new Library(backend);
  const p = fixture();
  onMain(p, clip('video', 0, 4));
  await library.saveProject(p);
  const onExit = vi.fn();
  editor = new Editor(root, { library, project: p, account: {}, onExit, onNewProject() {} });
  await settle();
  return { backend, library, onExit, p };
}

const rename = (name) => editor.store.update('Rename', (x) => { x.name = name; }, { structural: false });

describe('leaving the editor', () => {
  it('saves and leaves when the save works', async () => {
    const { library, onExit, p } = await open();
    rename('Saved name');
    await editor.exit();
    expect(onExit).toHaveBeenCalled();
    expect((await library.openProject(p.id)).name).toBe('Saved name');
  });

  it('stays open after a failed save when the user chooses to stay, and keeps retrying', async () => {
    const { backend, library, onExit, p } = await open();
    rename('Unsaved name');
    backend.failNext = 1;
    const leaving = editor.exit();
    await settle();
    expect(dialog()?.textContent).toContain("Couldn't save your changes");
    button('Stay').click();
    expect(await leaving).toBe(false);
    expect(onExit).not.toHaveBeenCalled();
    expect(editor._disposed).toBeFalsy();
    expect(editor.saver.timer).toBeTruthy();
    // Leaving again once the connection is back saves without asking.
    await editor.exit();
    expect(dialog()).toBeFalsy();
    expect(onExit).toHaveBeenCalled();
    expect((await library.openProject(p.id)).name).toBe('Unsaved name');
  });

  it('leaves after a failed save only when the user confirms', async () => {
    const { backend, onExit } = await open();
    rename('Lost name');
    backend.failNext = 1;
    const leaving = editor.exit();
    await settle();
    button('Leave anyway').click();
    await leaving;
    expect(onExit).toHaveBeenCalled();
    expect(editor._disposed).toBe(true);
  });

  it('asks once when leaving is requested twice', async () => {
    const { backend, onExit } = await open();
    rename('x');
    backend.failNext = 1;
    const a = editor.exit();
    const b = editor.exit();
    await settle();
    expect(document.querySelectorAll('dialog[open]').length).toBe(1);
    button('Leave anyway').click();
    await Promise.all([a, b]);
    expect(onExit).toHaveBeenCalledTimes(1);
  });
});
