// Arrow keys on the focused preview: nudge the selected clip, else step frames.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Library } from '../src/storage/library.js';
import { memoryBackend } from '../src/storage/backends.js';
import { Editor } from '../src/ui/editor.js';
import { fixture, clip, onMain } from './helpers.js';
import { createCompound } from '../src/model/compound.js';

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

  it('nudge a keyframed clip from where it shows, not from its base position', () => {
    const { store } = editor.ctx;
    store.update('keys', (p) => {
      p.tracks.find((t) => t.clips.length).clips[0].keyframes = { x: [{ t: 0, v: 0, ease: 'linear' }, { t: 2_000_000, v: 0.3, ease: 'linear' }] };
    });
    store.seek(2_000_000);
    store.select(v.id);
    press('ArrowRight');
    const keys = store.selected.clip.keyframes.x;
    expect(keys[1].v).toBeCloseTo(0.3 + 1 / store.project.settings.width, 9);
    expect(store.selected.clip.transform.x).toBe(0);
  });

  it('do not pick a clip on a locked base track that also holds a compound clip', () => {
    const { store, player, playerView } = editor.ctx;
    store.update('nest', (p) => {
      const main = p.tracks.find((t) => t.main);
      main.clips = [clip('video', 0, 2), clip('video', 2, 2), clip('video', 4, 2)];
      createCompound(p, [main.clips[1].id], { ripple: true, linkOverlays: true });
      main.locked = true;
    });
    store.clearSelection();
    store.seek(500_000);
    // A laid-out 640 x 360 preview where every clip covers the frame.
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, x: 0, y: 0, width: 640, height: 360, right: 640, bottom: 360 });
    vi.spyOn(player, 'layout').mockReturnValue({ cssW: 640, cssH: 360 });
    vi.spyOn(player, 'boxFor').mockReturnValue({ cx: 960, cy: 540, w: 1920, h: 1080 });
    playerView.relayout();
    const overlay = stage.querySelector('.player-overlay');
    overlay.dispatchEvent(new PointerEvent('pointerdown', { button: 0, clientX: 320, clientY: 180, bubbles: true, cancelable: true }));
    expect(store.selectedIds).toEqual([]);
  });
});

