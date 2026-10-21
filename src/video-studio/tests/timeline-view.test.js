// The timeline panel in jsdom: there is no layout, so tests place the
// content box by hand (contentAt) to stand in for scrolling.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { EditorStore } from '../src/model/store.js';
import { createActions } from '../src/ui/actions.js';
import { createTimeline } from '../src/ui/timeline/timeline.js';
import * as T from '../src/model/timeline.js';
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
    document.body.focus();
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
