// Arrow keys on the focused preview: nudge the selected clip, else step frames.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Library } from '../src/storage/library.js';
import { memoryBackend } from '../src/storage/backends.js';
import { Editor } from '../src/ui/editor.js';
import { fixture, clip, onMain } from './helpers.js';

const settle = () => new Promise((r) => setTimeout(r, 20));

describe('arrow keys on the preview', () => {
  let editor;
  let stage;
  let v;
  beforeEach(async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    document.body.replaceChildren();
    const root = document.createElement('div');
    document.body.append(root, Object.assign(document.createElement('div'), { id: 'live-region' }));
    const p = fixture();
    [v] = onMain(p, clip('video', 0, 10));
    const lib = new Library(memoryBackend());
    await lib.saveProject(p);
    editor = new Editor(root, { library: lib, project: p, account: {}, onExit() {}, onNewProject() {} });
    await settle();
    stage = root.querySelector('.player-stage');
    stage.focus();
  });
  afterEach(() => {
    editor?.dispose();
    editor = null;
    vi.restoreAllMocks();
  });
  const press = (key) => stage.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));

  it('step frames when nothing is selected', () => {
    const { store } = editor.ctx;
    store.clearSelection();
    press('ArrowRight');
    press('ArrowRight');
    expect(store.time).toBe(66_667);
    press('ArrowLeft');
    expect(store.time).toBe(33_333);
  });

  it('nudge the selected clip instead', () => {
    const { store } = editor.ctx;
    store.select(v.id);
    press('ArrowRight');
    expect(store.time).toBe(0);
    expect(store.selected.clip.transform.x).toBeCloseTo(1 / store.project.settings.width, 9);
  });
});
