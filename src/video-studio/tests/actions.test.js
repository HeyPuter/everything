import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EditorStore } from '../src/model/store.js';
import { createActions } from '../src/ui/actions.js';
import { mainTrack, findClip, allClips } from '../src/model/timeline.js';
import { TEXT_PRESETS } from '../src/model/catalog.js';
import { fixture, clip, onMain, spans, kinds, trackOf, s } from './helpers.js';

vi.mock('../src/media/reverse.js', () => ({ reverseFile: async () => new File(['x'], 'clip (reversed).mp4', { type: 'video/mp4' }) }));

/** A real store and the shared actions, with no player or library behind them. */
function setup(...mainClips) {
  const p = fixture();
  onMain(p, ...mainClips);
  const store = new EditorStore(p);
  const ctx = { store, player: null, library: null };
  ctx.actions = createActions(ctx);
  return { store, actions: ctx.actions, p: () => store.project, main: () => mainTrack(store.project) };
}

const toasts = () => [...document.querySelectorAll('.toast')].map((t) => t.textContent);

// The toast host stays in the body; only old toasts are cleared.
beforeEach(() => document.querySelectorAll('.toast').forEach((t) => t.remove()));

describe('split, delete and trim actions', () => {
  it('splits every clip under the playhead in one undo step', () => {
    const { store, actions, main, p } = setup(clip('video', 0, 4));
    actions.addText('plain', { start: s(1) });
    store.seek(s(2));
    store.clearSelection();
    actions.split();
    expect(allClips(p())).toHaveLength(4);
    store.undo();
    expect(allClips(p())).toHaveLength(2);
    expect(main().clips).toHaveLength(1);
  });

  it('splits only the selected clips when there is a selection', () => {
    const { store, actions, main } = setup(clip('video', 0, 4));
    const text = actions.addText('plain', { start: 0 });
    store.select(text.id);
    store.seek(s(1));
    actions.split();
    expect(main().clips).toHaveLength(1);
    expect(trackOf(store.project, text.id).clips).toHaveLength(2);
  });

  it('explains when there is nothing to split', () => {
    const { store, actions } = setup(clip('video', 0, 4));
    store.seek(s(4));
    actions.split();
    expect(toasts().join()).toMatch(/Move the playhead over a clip/);
    expect(store.history.canUndo()).toBe(false);
  });

  it('deletes the selection with ripple closing the gap and clears the selection', () => {
    const { store, actions, main } = setup(clip('video', 0, 2), clip('video', 2, 2));
    store.select(main().clips[0].id);
    actions.deleteSelected();
    expect(spans(main())).toEqual([[0, 2]]);
    expect(store.selectedIds).toEqual([]);
    store.setToggle('ripple', false);
    store.undo();
    store.select(main().clips[0].id);
    actions.deleteSelected();
    expect(spans(main())).toEqual([[2, 2]]);
  });

  it('deletes left of the playhead and moves the playhead to where the clip now starts', () => {
    const { store, actions, main } = setup(clip('video', 0, 2), clip('video', 2, 4));
    store.seek(s(3));
    store.select(main().clips[1].id);
    actions.deleteLeft();
    expect(spans(main())).toEqual([[0, 2], [2, 3]]);
    expect(store.time).toBe(s(2));
  });

  it('deletes right of the playhead on the base clip under it', () => {
    const { store, actions, main } = setup(clip('video', 0, 4));
    store.seek(s(1));
    actions.deleteRight();
    expect(spans(main())).toEqual([[0, 1]]);
  });
});

describe('clipboard actions', () => {
  it('duplicates the selection and selects the copies', () => {
    const { store, actions, main } = setup(clip('video', 0, 2), clip('video', 2, 2));
    const [a] = main().clips;
    store.select(a.id);
    actions.duplicate();
    expect(main().clips).toHaveLength(3);
    expect(store.selectedIds).toHaveLength(1);
    expect(store.selectedIds[0]).toBe(main().clips[1].id);
    expect(main().clips[1].assetId).toBe(a.assetId);
  });

  it('copies and pastes at the playhead, keeping base-track clips on the base track', () => {
    const { store, actions, main } = setup(clip('video', 0, 2));
    const text = actions.addText('plain', { start: s(0.5) });
    store.select([main().clips[0].id, text.id]);
    expect(actions.copy()).toBe(true);
    store.seek(s(2));
    actions.paste();
    expect(main().clips).toHaveLength(2);
    const pasted = store.selectedIds.map((id) => findClip(store.project, id));
    expect(pasted).toHaveLength(2);
    expect(pasted.find((f) => f.clip.type === 'text').clip.start).toBe(s(2.5));
    expect(pasted.find((f) => f.clip.type === 'video').track.main).toBe(true);
  });

  it('cuts by copying then deleting', () => {
    const { store, actions, main } = setup(clip('video', 0, 2));
    store.select(main().clips[0].id);
    actions.cut();
    expect(main().clips).toHaveLength(0);
    expect(actions.hasClipboard()).toBe(true);
    actions.paste();
    expect(main().clips).toHaveLength(1);
  });

  it('does nothing without a selection or clipboard', () => {
    const { store, actions } = setup(clip('video', 0, 2));
    expect(actions.copy()).toBe(false);
    actions.paste();
    actions.duplicate();
    expect(store.history.canUndo()).toBe(false);
  });
});

describe('frame actions', () => {
  it('freezes the frame under the playhead of the selected video and selects the still', () => {
    const { store, actions, main } = setup(clip('video', 0, 4));
    store.select(main().clips[0].id);
    store.seek(s(1));
    actions.freeze();
    expect(spans(main())).toEqual([[0, 1], [1, 3], [4, 3]]);
    expect(store.selected.clip.freeze).toBe(true);
  });

  it('asks for a video clip before freezing', () => {
    const { store, actions } = setup(clip('image', 0, 4));
    store.select(store.project.tracks[0].clips[0].id);
    actions.freeze();
    expect(toasts().join()).toMatch(/Select a video clip/);
  });

  it('extracts audio onto its own track, once', () => {
    const { store, actions, main, p } = setup(clip('video', 0, 4));
    store.select(main().clips[0].id);
    actions.detachAudio();
    expect(kinds(p())).toEqual(['main', 'audio']);
    actions.detachAudio();
    expect(toasts().join()).toMatch(/no audio to extract/);
    expect(p().tracks[1].clips).toHaveLength(1);
  });
});

describe('adding things', () => {
  it('adds text from a preset at the playhead and selects it', () => {
    const { store, actions, p } = setup(clip('video', 0, 4));
    store.seek(s(1));
    const preset = TEXT_PRESETS.find((x) => x.id === 'outline');
    const t = actions.addText('outline');
    expect(t).toMatchObject({ type: 'text', start: s(1), text: preset.text, preset: 'outline' });
    expect(t.style).toMatchObject(preset.style);
    expect(store.selectedIds).toEqual([t.id]);
    expect(kinds(p())).toEqual(['text', 'main']);
  });

  it('adds effects on their own track above everything', () => {
    const { actions, p } = setup(clip('video', 0, 4));
    actions.addText();
    const fx = actions.addEffect('glitch');
    expect(fx).toMatchObject({ type: 'effect', effect: 'glitch', name: 'Glitch' });
    expect(kinds(p())).toEqual(['effect', 'text', 'main']);
  });

  it('applies a filter to the selected visual clip, keeping its intensity', () => {
    const { store, actions, main, p } = setup(clip('video', 0, 4, { filter: { id: 'warm', intensity: 40 } }));
    store.select(main().clips[0].id);
    expect(actions.addFilter('noir')).toBe(null);
    expect(main().clips[0].filter).toEqual({ id: 'noir', intensity: 40 });
    expect(kinds(p())).toEqual(['main']);
    actions.addFilter(null);
    expect(main().clips[0].filter).toBe(null);
  });

  it('adds a filter as its own track when nothing visual is selected or when asked to', () => {
    const { store, actions, main, p } = setup(clip('video', 0, 4));
    const f = actions.addFilter('noir');
    expect(f).toMatchObject({ type: 'filter', filter: 'noir', intensity: 100 });
    store.select(main().clips[0].id);
    actions.addFilter('mono', { asTrack: true });
    expect(main().clips[0].filter).toBe(null);
    expect(kinds(p()).filter((k) => k === 'filter')).toHaveLength(2);
  });

  it('makes the first visual media set the frame for "original" projects, undone with the add', () => {
    const { store, actions } = setup();
    store.project.settings.ratio = 'original';
    const asset = { ...store.project.assets.silent, fps: 24.2 };
    actions.addAsset(asset);
    expect(store.project.settings).toMatchObject({ width: 1280, height: 720, fps: 24 });
    expect(store.history.undoStack).toHaveLength(1);
    store.undo();
    expect(store.project.settings).toMatchObject({ width: 1920, height: 1080, fps: 30 });
    expect(allClips(store.project)).toEqual([]);
  });
});

describe('transitions and animations', () => {
  it('applies a transition after the selected clip', () => {
    const { store, actions, main } = setup(clip('video', 0, 2), clip('video', 2, 2), clip('video', 4, 2));
    store.select(main().clips[1].id);
    expect(actions.applyTransition('mix')).toBe(true);
    expect(main().clips[1].transition).toEqual({ id: 'mix', duration: s(0.5) });
    expect(main().clips[0].transition).toBe(null);
  });

  it('otherwise uses the base-track cut nearest the playhead', () => {
    const { store, actions, main } = setup(clip('video', 0, 2), clip('video', 2, 2), clip('video', 4, 2));
    store.seek(s(3.9));
    actions.applyTransition('wipe-left', { duration: s(1) });
    expect(main().clips[1].transition).toEqual({ id: 'wipe-left', duration: s(1) });
  });

  it('explains when there is no cut to put a transition on', () => {
    const { actions } = setup(clip('video', 0, 2));
    expect(actions.applyTransition('mix')).toBe(false);
    expect(toasts().join()).toMatch(/two clips that touch/);
  });

  it('applies a transition to every cut', () => {
    const { actions, main } = setup(clip('video', 0, 2), clip('video', 2, 2), clip('video', 4, 2));
    actions.applyTransitionToAll('mix');
    expect(main().clips.map((c) => c.transition?.id ?? null)).toEqual(['mix', 'mix', null]);
  });

  it('sets in, out and loop animations, keeping loops and in/out exclusive', () => {
    const { store, actions } = setup(clip('video', 0, 1));
    const c = () => store.selected.clip;
    store.select(store.project.tracks[0].clips[0].id);
    actions.applyAnimation('in', 'fade-in');
    actions.applyAnimation('out', 'zoom-out', s(3));
    expect(c().animIn).toEqual({ id: 'fade-in', duration: s(0.5) });
    expect(c().animOut).toEqual({ id: 'zoom-out', duration: s(1) }); // capped at the clip length
    actions.applyAnimation('loop', 'sway');
    expect([c().animIn, c().animOut, c().animLoop?.id]).toEqual([null, null, 'sway']);
    actions.applyAnimation('in', 'pop-in');
    expect(c().animLoop).toBe(null);
    actions.applyAnimation('in', null);
    expect(c().animIn).toBe(null);
  });

  it('asks for a visual clip before animating', () => {
    const { actions } = setup();
    expect(actions.applyAnimation('in', 'fade-in')).toBe(false);
  });
});

describe('keyframes', () => {
  it('toggles a key at the playhead with the current value', () => {
    const { store, actions, main } = setup(clip('image', 0, 4, { transform: { x: 0.3, y: 0, scale: 1, rotation: 0, flipH: false, flipV: false } }));
    const id = main().clips[0].id;
    store.seek(s(1));
    actions.toggleKeyframe(id, 'x');
    expect(main().clips[0].keyframes.x).toEqual([{ t: s(1), v: 0.3, ease: 'linear' }]);
    // Within half a frame of the key counts as the same key.
    store.seek(s(1) + 10_000);
    actions.toggleKeyframe(id, 'x');
    expect(main().clips[0].keyframes.x).toBeUndefined();
  });

  it('sets values as keys once a property is keyed, otherwise changes the base value', () => {
    const { store, actions, main } = setup(clip('image', 0, 4));
    const id = main().clips[0].id;
    actions.setAnimatable(id, 'scale', 2);
    expect(main().clips[0].transform.scale).toBe(2);
    store.seek(0);
    actions.toggleKeyframe(id, 'scale');
    store.seek(s(2));
    actions.setAnimatable(id, 'scale', 3);
    expect(main().clips[0].keyframes.scale.map((k) => [k.t, k.v])).toEqual([[0, 2], [s(2), 3]]);
    expect(main().clips[0].transform.scale).toBe(2);
  });

  it('keys every transform property at once from the toolbar', () => {
    const { store, actions, main } = setup(clip('image', 0, 4));
    store.select(main().clips[0].id);
    store.seek(s(1));
    actions.addKeyframeAll();
    expect(Object.keys(main().clips[0].keyframes).sort()).toEqual(['opacity', 'rotation', 'scale', 'x', 'y']);
  });

  it('rotates 90 degrees through a key when rotation is keyed, and the base value otherwise', () => {
    const { store, actions, main } = setup(clip('image', 0, 4), clip('image', 4, 4));
    const [a, b] = main().clips;
    a.keyframes.rotation = [{ t: 0, v: 0, ease: 'linear' }, { t: s(4), v: 180, ease: 'linear' }];
    store.select([a.id, b.id]);
    store.seek(s(2));
    actions.rotate();
    // The keyed value at the playhead was 90: a key of 180 lands there and the base stays.
    expect(main().clips[0].keyframes.rotation.map((k) => [k.t, k.v])).toEqual([[0, 0], [s(2), 180], [s(4), 180]]);
    expect(main().clips[0].transform.rotation).toBe(0);
    expect(main().clips[1].transform.rotation).toBe(90);
  });

  it('refuses keys while the playhead is outside the clip', () => {
    const { store, actions, main } = setup(clip('image', 0, 1), clip('image', 1, 1));
    store.seek(s(1.5));
    actions.toggleKeyframe(main().clips[0].id, 'x');
    expect(main().clips[0].keyframes).toEqual({});
    expect(toasts().join()).toMatch(/Move the playhead over the clip/);
  });
});

describe('importing files', () => {
  it('names the file in an import error that does not', async () => {
    const { store } = setup();
    const library = {
      importFile: async (file) => {
        if (file.name === 'odd.mkv') throw new Error('This file type is not supported by your browser.');
        throw new Error(`${file.name} is not a video, audio or image file.`);
      },
    };
    const ctx = { store, player: null, library };
    ctx.actions = createActions(ctx);
    const quiet = console.error;
    console.error = () => {};
    try {
      expect(await ctx.actions.importFiles([new File(['x'], 'odd.mkv'), new File(['y'], 'notes.txt')])).toEqual([]);
    } finally {
      console.error = quiet;
    }
    expect(toasts()).toEqual(['odd.mkv: This file type is not supported by your browser.', 'notes.txt is not a video, audio or image file.']);
  });
});

describe('reverse', () => {
  it('closes the progress dialog when the reversed file cannot be saved', async () => {
    const p = fixture();
    const [a] = onMain(p, clip('video', 0, 4));
    const store = new EditorStore(p);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const library = { mediaBlob: async () => new Blob(['v']), importFile: async () => { throw new Error('Your Puter storage is full.'); } };
    const ctx = { store, player: null, library };
    ctx.actions = createActions(ctx);
    await ctx.actions.reverseClip(a.id);
    expect(document.querySelectorAll('dialog')).toHaveLength(0);
    expect([...document.querySelectorAll('.toast')].map((t) => t.textContent).join()).toMatch(/storage is full/);
    expect(findClip(store.project, a.id).clip.reversed).toBeFalsy();
    err.mockRestore();
    document.body.replaceChildren();
  });
});
