// The timeline panel in jsdom: there is no layout, so tests place the
// content box by hand (contentAt) to stand in for scrolling.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { EditorStore } from '../src/model/store.js';
import { createActions } from '../src/ui/actions.js';
import { createTimeline } from '../src/ui/timeline/timeline.js';
import * as T from '../src/model/timeline.js';
import { drawRuler } from '../src/ui/timeline/ruler.js';
import { createCompound } from '../src/model/compound.js';
import { fixture, clip, onMain, s } from './helpers.js';

function mountTimeline(p) {
  const store = new EditorStore(p);
  const ctx = {
    store,
    player: { playing: false, pause() {}, setPreview() {} },
    media: { on: () => () => {}, thumb: () => null, peaksNow: () => null, peaks() {} },
    commands: { keyFor: () => '', run() {} },
    assets: { show() {} },
  };
  ctx.actions = createActions(ctx);
  const tl = createTimeline(ctx);
  document.body.append(tl.el);
  tl.mounted();
  const content = tl.el.querySelector('.tl-content');
  const tracks = tl.el.querySelector('.tl-tracks');
  const scroller = tl.el.querySelector('.tl-scroll');
  // Where the content box starts on screen (it moves left as the view scrolls).
  const contentAt = (left) => {
    content.getBoundingClientRect = () => ({ left, top: 0, right: left + 5000, bottom: 400, width: 5000, height: 400, x: left, y: 0 });
  };
  contentAt(0);
  const node = (id) => tl.el.querySelector(`.tl-clip[data-id="${id}"]`);
  const pointer = (target, type, x, y = 0) => target.dispatchEvent(new PointerEvent(type, { bubbles: true, clientX: x, clientY: y, pointerId: 1, pointerType: 'mouse', button: 0, buttons: type === 'pointerup' ? 0 : 1 }));
  return { store, ctx, tl, content, tracks, scroller, contentAt, node, pointer };
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe('timeline drags', () => {
  it('keeps a dragged clip under the pointer while the view scrolls, and drops it there', () => {
    const p = fixture();
    const [a] = onMain(p, clip('video', 0, 2), clip('video', 2, 2));
    const title = clip('text', 0, 1);
    T.addClip(p, title, { ripple: false });
    const { store, tl, tracks, scroller, contentAt, node, pointer } = mountTimeline(p);
    store.setToggle('snap', false);
    const pps = tl.pps;
    const x0 = 16 + 10;
    pointer(node(title.id), 'pointerdown', x0);
    pointer(tracks, 'pointermove', x0 + pps); // 1 s to the right
    const el = node(title.id);
    expect(el.classList.contains('dragging')).toBe(true);
    const held = el.style.transform;
    // A render while the drag is held (scroll, selection) keeps the preview.
    tl.render();
    expect(el.style.transform).toBe(held);
    expect(el.classList.contains('dragging')).toBe(true);
    // The view scrolls 2 s further under the still pointer: the clip follows.
    contentAt(-2 * pps);
    scroller.dispatchEvent(new Event('scroll'));
    expect(el.style.transform).not.toBe(held);
    pointer(tracks, 'pointerup', x0 + pps);
    expect(T.findClip(store.project, title.id).clip.start).toBe(s(3));
    expect(T.findClip(store.project, a.id).clip.start).toBe(0);
    tl.dispose();
  });

  it('leaves a pressed clip alone while playback scrolls the view before a drag starts', () => {
    const p = fixture();
    onMain(p, clip('video', 0, 2), clip('video', 2, 2));
    const title = clip('text', 0, 1);
    T.addClip(p, title, { ripple: false });
    const { store, tl, tracks, scroller, contentAt, node, pointer } = mountTimeline(p);
    const steps = store.history.undoStack.length;
    const x0 = 16 + 10;
    pointer(node(title.id), 'pointerdown', x0);
    pointer(tracks, 'pointermove', x0 + 1); // a 1 px wobble: not a drag yet
    contentAt(-tl.pps); // the view follows the playhead
    scroller.dispatchEvent(new Event('scroll'));
    expect(node(title.id).classList.contains('dragging')).toBe(false);
    pointer(tracks, 'pointerup', x0 + 1);
    expect(T.findClip(store.project, title.id).clip.start).toBe(0);
    expect(store.history.undoStack.length).toBe(steps);
    tl.dispose();
  });

  it('trims to where the pointer is after the view scrolled', () => {
    const p = fixture();
    const [a] = onMain(p, clip('video', 0, 2));
    const { store, tl, tracks, scroller, contentAt, node, pointer } = mountTimeline(p);
    store.setToggle('snap', false);
    store.select(a.id);
    tl.render();
    const pps = tl.pps;
    const edge = node(a.id).querySelector('.clip-trim.r');
    const x0 = 16 + 2 * pps;
    pointer(edge, 'pointerdown', x0);
    pointer(tracks, 'pointermove', x0 - pps); // 1 s shorter
    tl.render();
    expect(node(a.id).style.width).toBe(`${pps}px`);
    contentAt(0.5 * pps); // scrolled back half a second
    scroller.dispatchEvent(new Event('scroll'));
    pointer(tracks, 'pointerup', x0 - pps);
    expect(T.findClip(store.project, a.id).clip.duration).toBe(s(0.5));
    tl.dispose();
  });
});

describe('opening compound clips', () => {
  it('opens a compound clip on a double-click, though the press captured the pointer to the lanes', () => {
    const p = fixture();
    const [a] = onMain(p, clip('video', 0, 2), clip('video', 2, 2));
    const { store, tl, tracks, node, pointer } = mountTimeline(p);
    store.update('Compound', (proj) => Boolean(createCompound(proj, [a.id], { ripple: true })));
    tl.render();
    const c = store.project.tracks.flatMap((t) => t.clips).find((x) => x.type === 'compound');
    // A real mouse press captures the pointer, so the clicks and the dblclick land on the lanes.
    for (let i = 0; i < 2; i++) {
      pointer(node(c.id), 'pointerdown', 20);
      pointer(tracks, 'pointerup', 20);
    }
    tracks.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, detail: 2 }));
    expect(store.nest.length).toBe(1);
    store.closeCompound();
    // A double-click that started on the empty lanes opens nothing.
    pointer(tracks, 'pointerdown', 3000, 300);
    pointer(tracks, 'pointerup', 3000, 300);
    tracks.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, detail: 2 }));
    expect(store.nest.length).toBe(0);
    tl.dispose();
  });
});

describe('timeline focus', () => {
  it('a click on empty track space keeps the view where it is; Tab brings the clip into view', async () => {
    const p = fixture();
    const [a] = onMain(p, clip('video', 0, 2), clip('video', 2, 2));
    const { tl, tracks, scroller, pointer, node } = mountTimeline(p);
    scroller.scrollLeft = 3000;
    // jsdom does not scroll on focus, so check that every focus asks not to.
    const focus = vi.spyOn(HTMLElement.prototype, 'focus');
    pointer(tracks, 'pointerdown', 3200, 300);
    tracks.dispatchEvent(new FocusEvent('focus')); // the browser focuses the lanes on mousedown
    pointer(tracks, 'pointerup', 3200, 300);
    expect(focus.mock.calls.length).toBeGreaterThan(0);
    for (const [opts] of focus.mock.calls) expect(opts?.preventScroll).toBe(true);
    expect(scroller.scrollLeft).toBe(3000);
    expect(document.activeElement).toBe(node(a.id));
    focus.mockRestore();
    await new Promise((r) => setTimeout(r));
    // Keyboard focus (no pointer involved) scrolls to the clip it lands on.
    document.activeElement.blur(); // focus comes from outside the timeline
    tracks.focus();
    expect(document.activeElement).toBe(node(a.id));
    expect(scroller.scrollLeft).toBe(0);
    tl.dispose();
  });
});

describe('timeline rendering', () => {
  it('only builds transition chips for the cuts in view', () => {
    const p = fixture();
    onMain(p, ...Array.from({ length: 300 }, (_, i) => clip('video', i, 1)));
    const { tl, scroller } = mountTimeline(p);
    const chips = () => tl.el.querySelectorAll('.tl-transition').length;
    const near = chips();
    expect(near).toBeGreaterThan(0);
    expect(near).toBeLessThan(60);
    expect(tl.el.querySelectorAll('.tl-clip').length).toBeLessThan(60);
    scroller.scrollLeft = 150 * tl.pps;
    tl.render();
    expect(chips()).toBeGreaterThan(0);
    expect(chips()).toBeLessThan(60);
    tl.dispose();
  });
});

describe('transition chips', () => {
  it('trim the edge under them when dragged', () => {
    const p = fixture();
    const [a, b] = onMain(p, clip('video', 0, 2), clip('video', 2, 2));
    const { store, tl, tracks, pointer } = mountTimeline(p);
    store.setToggle('snap', false);
    store.setToggle('ripple', false);
    const pps = tl.pps;
    const chip = () => tl.el.querySelector('.tl-transition');
    const cut = 16 + 2 * pps;
    // Just left of the cut: the first clip's end grip, under the chip.
    pointer(chip(), 'pointerdown', cut - 2);
    pointer(chip(), 'pointermove', cut - 2 - pps / 2);
    pointer(tracks, 'pointerup', cut - 2 - pps / 2);
    expect(T.findClip(store.project, a.id).clip.duration).toBe(s(1.5));
    expect(store.selectedIds).toEqual([a.id]);
    expect(T.findClip(store.project, b.id).clip.start).toBe(s(2));
    expect(T.findClip(store.project, a.id).clip.transition).toBe(null);
    tl.dispose();
  });

  it('let a click through to the transition', () => {
    const p = fixture();
    const [a] = onMain(p, clip('video', 0, 2), clip('video', 2, 2));
    const { store, tl, pointer } = mountTimeline(p);
    const chip = tl.el.querySelector('.tl-transition');
    const x = 16 + 2 * tl.pps + 1;
    pointer(chip, 'pointerdown', x);
    pointer(chip, 'pointerup', x);
    chip.click();
    expect(T.findClip(store.project, a.id).clip.transition?.id).toBe('mix');
    expect(T.findClip(store.project, a.id).clip.duration).toBe(s(2));
    tl.dispose();
  });

  it('trim the next clip\'s start when dragged from the right of the cut', () => {
    const p = fixture();
    const [a, b] = onMain(p, clip('video', 0, 2), clip('video', 2, 2, { in: s(1) }));
    const { store, tl, tracks, pointer } = mountTimeline(p);
    store.setToggle('snap', false);
    store.setToggle('ripple', false);
    const pps = tl.pps;
    const cut = 16 + 2 * pps;
    pointer(tl.el.querySelector('.tl-transition'), 'pointerdown', cut + 2);
    pointer(tl.el.querySelector('.tl-transition'), 'pointermove', cut + 2 + pps / 2);
    pointer(tracks, 'pointerup', cut + 2 + pps / 2);
    expect(T.findClip(store.project, b.id).clip.start).toBe(s(2.5));
    expect(T.findClip(store.project, a.id).clip.duration).toBe(s(2));
    tl.dispose();
  });
});

describe('timeline with big selections', () => {
  it('keeps only the clips in view in the page when many are selected, and still drags them all', () => {
    const p = fixture();
    const titles = Array.from({ length: 300 }, (_, i) => clip('text', i, 1));
    for (const c of titles) T.addClip(p, c, { ripple: false });
    const { store, tl, tracks, node, pointer } = mountTimeline(p);
    store.setToggle('snap', false);
    store.select(titles.map((c) => c.id));
    tl.render();
    const count = () => tl.el.querySelectorAll('.tl-clip').length;
    expect(count()).toBeLessThan(60);
    const x0 = 16 + 10;
    pointer(node(titles[0].id), 'pointerdown', x0);
    pointer(tracks, 'pointermove', x0 + tl.pps); // 1 s to the right
    // While dragged, the off-screen ones are there to move into view with the drag.
    expect(count()).toBe(300);
    expect(node(titles[299].id).classList.contains('dragging')).toBe(true);
    pointer(tracks, 'pointerup', x0 + tl.pps);
    expect(titles.map((c) => T.findClip(store.project, c.id).clip.start)).toEqual(titles.map((_, i) => s(i + 1)));
    tl.render();
    expect(count()).toBeLessThan(60);
    tl.dispose();
  });
});

describe('timeline on phones', () => {
  it('zoom to fit keeps the playhead where it is when scrolling seeks', () => {
    const p = fixture();
    onMain(p, clip('video', 0, 10), clip('video', 10, 10));
    const { store, tl, scroller } = mountTimeline(p);
    tl.setCentered(true);
    store.seek(s(12.5));
    scroller.dispatchEvent(new Event('scroll'));
    tl.zoomBy(3);
    scroller.dispatchEvent(new Event('scroll'));
    expect(store.time).toBe(s(12.5));
    tl.zoomToFit();
    scroller.dispatchEvent(new Event('scroll'));
    expect(store.time).toBe(s(12.5));
    tl.dispose();
  });
});

describe('scrubbing the ruler', () => {
  it('snaps to clip edges, with Alt flipping snapping either way', () => {
    const p = fixture();
    onMain(p, clip('video', 0, 2), clip('video', 2, 2));
    const { store, tl } = mountTimeline(p);
    const ruler = tl.el.querySelector('.tl-ruler');
    const near = 16 + 2 * tl.pps + 3; // 3 px past the cut at 2 s
    const scrub = (altKey) => {
      ruler.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: near, pointerId: 1, button: 0, altKey }));
      ruler.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: near, pointerId: 1 }));
      return store.time;
    };
    expect(scrub(false)).toBe(s(2));
    expect(scrub(true)).not.toBe(s(2));
    store.setToggle('snap', false);
    expect(scrub(false)).not.toBe(s(2));
    expect(scrub(true)).toBe(s(2));
    tl.dispose();
  });
});

describe('timeline keyboard focus', () => {
  it('stays in the timeline when the focused clip is deleted or undone away', () => {
    const p = fixture();
    const [a, b, c] = onMain(p, clip('video', 0, 2), clip('video', 2, 2), clip('video', 4, 2));
    const t = clip('text', 0, 1);
    T.addClip(p, t, { ripple: false });
    const { store, ctx, tl, node } = mountTimeline(p);
    store.select(b.id);
    tl.render();
    node(b.id).focus();
    ctx.actions.deleteSelected();
    tl.render();
    // The clip now in its place on the base track.
    expect(document.activeElement).toBe(node(c.id));
    // Deleting the only clip of a track (the track goes too) moves focus to the base track.
    store.select(t.id);
    tl.render();
    node(t.id).focus();
    ctx.actions.deleteSelected();
    tl.render();
    expect(document.activeElement?.dataset.id).toBe(a.id);
    tl.dispose();
  });
});

describe('the ruler', () => {
  it('starts the first time label clear of the playhead handle resting on 0', () => {
    const texts = [];
    const g = new Proxy({ fillText: (t, x) => texts.push([t, x]), measureText: () => ({ width: 10 }) }, { get: (o, k) => o[k] ?? (() => {}), set: () => true });
    const canvas = { clientHeight: 26, width: 0, height: 0, style: {}, getContext: () => g };
    const colors = { major: '#888', minor: '#444', text: '#888', marker: '#f5b83d' };
    drawRuler(canvas, { scrollLeft: 0, width: 400, pps: 100, pad: 16, fps: 30, colors, startLabelX: 10 });
    expect(texts[0]).toEqual(['00:00', 16 + 0.5 + 10]);
    // The others sit just after their tick, as before.
    expect(texts[1][1]).toBe(16 + 100 + 0.5 + 3);
  });
});

describe('spoken names', () => {
  it('start with the text shown on the clip and the Cover button', () => {
    const p = fixture();
    const [a] = onMain(p, clip('video', 0, 2, { speed: 0.5 }), clip('image', 2, 2));
    const { tl, node } = mountTimeline(p);
    const shown = (el) => el.textContent.replace(/\s+/g, ' ').trim();
    expect(shown(node(a.id))).toMatch(/^vid 00:00:02:00 0\.5x$/);
    for (const el of tl.el.querySelectorAll('.tl-clip, .tl-cover')) expect(el.getAttribute('aria-label').startsWith(shown(el))).toBe(true);
    tl.dispose();
  });
});

describe('timeline lanes', () => {
  it('are named like their track headers, renamed tracks included', () => {
    const p = fixture();
    onMain(p, clip('video', 0, 2));
    T.addClip(p, clip('text', 0, 1), { ripple: false });
    const { store, tl } = mountTimeline(p);
    const lanes = () => [...tl.el.querySelectorAll('.tl-lane')].map((l) => l.getAttribute('aria-label'));
    expect(lanes()).toEqual(['Text track 1', 'Base track']);
    store.update('Rename track', (pp) => T.renameTrack(pp, pp.tracks[0].id, 'Titles'), { structural: false });
    tl.render();
    expect(lanes()).toEqual(['Titles', 'Base track']);
    expect(tl.el.querySelector('.tl-header').getAttribute('aria-label')).toBe('Titles');
    tl.dispose();
  });
});

describe('timeline drops', () => {
  it('undoes media dropped above the tracks without leaving its new track behind', () => {
    const p = fixture();
    onMain(p, clip('video', 0, 2));
    const { store, tl } = mountTimeline(p);
    const before = store.project.tracks.length;
    const steps = store.history.undoStack.length;
    // Above the first row: a new overlay track there.
    tl.dropPayload(JSON.stringify({ kind: 'asset', assetId: 'img' }), { start: 0, y: 2 });
    expect(store.project.tracks.length).toBe(before + 1);
    expect(store.project.tracks[0].clips).toHaveLength(1);
    expect(store.history.undoStack.length).toBe(steps + 1);
    store.undo();
    expect(store.project.tracks.length).toBe(before);
    store.redo();
    expect(store.project.tracks[0].clips).toHaveLength(1);
    tl.dispose();
  });
});

describe('dropping files from the desktop', () => {
  it('puts them on the timeline one after another as one undo step', async () => {
    const p = fixture();
    const { store, ctx, tl, content } = mountTimeline(p);
    let n = 0;
    ctx.library = { importFile: async (file) => ({ id: `f${n++}`, kind: 'image', name: file.name, width: 100, height: 100 }) };
    const drop = new Event('drop', { bubbles: true, cancelable: true });
    Object.assign(drop, { clientX: 16, clientY: 60 });
    drop.dataTransfer = { files: [new File(['x'], 'a.png'), new File(['y'], 'b.png')], getData: () => '' };
    content.dispatchEvent(drop);
    await vi.waitFor(() => expect(T.allClips(store.project)).toHaveLength(2));
    const [a, b] = T.mainTrack(store.project).clips;
    expect(b.start).toBe(T.clipEnd(a));
    store.undo();
    expect(T.allClips(store.project)).toHaveLength(0);
    tl.dispose();
  });
});

describe('the first clip of a project', () => {
  it('names its one undo step on the Undo button, the matched frame rate included', () => {
    const p = fixture();
    p.settings.ratio = 'original';
    p.assets.vid.fps = 25;
    const { store, ctx, tl } = mountTimeline(p);
    ctx.actions.addAsset(p.assets.vid);
    expect(store.project.settings.fps).toBe(25);
    expect(store.history.undoStack.map((e) => e.label)).toEqual(['Add vid']);
    expect(tl.el.querySelector('[data-cmd=undo]').getAttribute('data-tip')).toBe('Undo Add vid');
    store.undo();
    expect(T.allClips(store.project)).toHaveLength(0);
    expect(store.project.settings.fps).not.toBe(25);
    tl.dispose();
  });
});

describe('adding several media files', () => {
  it('is one undo step even when the history is full', () => {
    const p = fixture();
    const { store, ctx, tl } = mountTimeline(p);
    for (let i = 0; i < store.history.limit + 5; i++) store.update('Rename', (pp) => void (pp.name = `n${i}`), { structural: false });
    ctx.actions.addAssets([p.assets.vid, p.assets.silent, p.assets.img]);
    expect(T.allClips(store.project)).toHaveLength(3);
    expect(store.history.undoLabel).toBe('Add 3 clips');
    store.undo();
    expect(T.allClips(store.project)).toHaveLength(0);
    tl.dispose();
  });
});

describe('timeline keyboard focus with Shift+Tab', () => {
  it('lets Shift+Tab leave a clip instead of sending focus back into the timeline', () => {
    const p = fixture();
    const [a] = onMain(p, clip('video', 0, 2), clip('video', 2, 2));
    const { tracks, node } = mountTimeline(p);
    // Tabbing in moves focus to a clip.
    tracks.focus();
    expect(document.activeElement).toBe(node(a.id));
    // Shift+Tab from the clip reaches the tracks group first: it stays there, so the next one leaves.
    tracks.focus();
    expect(document.activeElement).toBe(tracks);
  });
});
