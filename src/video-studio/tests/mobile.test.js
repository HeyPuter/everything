import { describe, it, expect, afterEach, vi } from 'vitest';
import { h } from '../src/lib/dom.js';
import { createMobileChrome, layoutMode, PHONE_QUERY, TABLET_QUERY, CATEGORIES } from '../src/ui/mobile.js';
import { createPinch, longPress } from '../src/lib/gestures.js';

/** matchMedia stub: a fake screen whose kind can change at runtime. */
function fakeScreen(kind) {
  const lists = new Map();
  const state = { kind };
  const matches = (q) => (q === PHONE_QUERY ? state.kind === 'phone' : q === TABLET_QUERY ? state.kind === 'phone' || state.kind === 'tablet' : false);
  const mm = (q) => {
    if (!lists.has(q)) {
      const listeners = new Set();
      lists.set(q, {
        get matches() {
          return matches(q);
        },
        addEventListener: (t, fn) => listeners.add(fn),
        removeEventListener: (t, fn) => listeners.delete(fn),
        listeners,
      });
    }
    return lists.get(q);
  };
  mm.set = (next) => {
    state.kind = next;
    for (const l of lists.values()) for (const fn of [...l.listeners]) fn({ matches: l.matches });
  };
  mm.listenerCount = () => [...lists.values()].reduce((n, l) => n + l.listeners.size, 0);
  return mm;
}

function fakeStore() {
  const handlers = {};
  const video = { id: 'v1', type: 'video', start: 0, duration: 5e6, speed: 1, volume: 1, transform: { x: 0, y: 0, scale: 1, rotation: 0 }, animIn: null, assetId: 'a1' };
  const audio = { id: 'm1', type: 'audio', start: 0, duration: 5e6, speed: 1, volume: 1, assetId: 'a2' };
  const store = {
    time: 0,
    project: {
      tracks: [{ id: 't1', main: true, kind: 'video', clips: [video] }, { id: 't2', kind: 'audio', clips: [audio] }],
      assets: { a1: { hasAudio: true }, a2: {} },
      settings: { ratio: '16:9' },
      markers: [],
    },
    selection: new Set(),
    history: { canUndo: () => true, canRedo: () => false },
    on(ev, fn) {
      (handlers[ev] ||= new Set()).add(fn);
      return () => handlers[ev].delete(fn);
    },
    emit(ev, data) {
      for (const fn of handlers[ev] || []) fn(data);
    },
    get selected() {
      const id = [...this.selection][0];
      if (!id) return null;
      for (const track of this.project.tracks) {
        const clip = track.clips.find((c) => c.id === id);
        if (clip) return { clip, track };
      }
      return null;
    },
    select(id) {
      this.selection = new Set([id]);
      this.emit('select', { ids: [id] });
    },
    clearSelection() {
      this.selection = new Set();
      this.emit('select', { ids: [] });
    },
  };
  return store;
}

function fakeEditor(kind) {
  const store = fakeStore();
  const assets = { el: h('section.panel.assets-panel', h('div.asset-tabs-wrap', h('button.tab', h('span.tab-label', 'Media')))), show: vi.fn() };
  const inspector = { el: h('section.panel.inspector', h('div.panel-head', 'Details')) };
  const playerView = { el: h('section.panel.player-panel', h('div.player-bar', h('div.player-bar-right', h('button.icon-btn', { 'aria-label': 'Full screen' })))), relayout: vi.fn(), setRatio: vi.fn() };
  const timeline = { el: h('section.panel.timeline-panel', h('div.tl-toolbar', h('div.tl-tools'), h('div.tl-tools.right'))), setCentered: vi.fn() };
  const root = h('div.editor',
    h('header.topbar', h('div.topbar-left'), h('div.topbar-center'), h('div.topbar-right')),
    h('main.workspace', h('div.upper', assets.el, h('div.resizer.v'), playerView.el, h('div.resizer.v'), inspector.el), timeline.el),
  );
  document.body.append(root);
  const ctx = {
    store,
    assets,
    inspector,
    playerView,
    timeline,
    actions: { split: vi.fn(), deleteSelected: vi.fn(), duplicate: vi.fn(), freeze: vi.fn(), mirror: vi.fn(), detachAudio: vi.fn(), setSpeed: vi.fn(), setAnimatable: vi.fn(), toggleClipMute: vi.fn(), applyAnimation: vi.fn() },
    commands: { run: vi.fn(), get: vi.fn() },
    exitToHome: vi.fn(),
    openProjectSettings: vi.fn(),
  };
  const mm = fakeScreen(kind);
  const mobile = createMobileChrome(ctx, root, { matchMedia: mm });
  return { ctx, root, mm, mobile, store };
}

const upperOrder = (root) => [...root.querySelector('.upper').children].map((c) => c.className.split(' ').pop());

describe('layoutMode', () => {
  it('picks phone, tablet or desktop from the media queries', () => {
    expect(layoutMode((q) => q === PHONE_QUERY || q === TABLET_QUERY)).toBe('phone');
    expect(layoutMode((q) => q === TABLET_QUERY)).toBe('tablet');
    expect(layoutMode(() => false)).toBe('desktop');
  });
});

describe('mobile chrome', () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it('leaves the desktop layout alone', () => {
    const { root, ctx } = fakeEditor('desktop');
    expect(root.dataset.layout).toBe('desktop');
    expect(upperOrder(root)).toEqual(['assets-panel', 'v', 'player-panel', 'v', 'inspector']);
    expect(root.querySelector('.m-dock').hidden).toBe(true);
    expect(root.querySelector('.m-close, .m-details-btn, .m-more, .m-undo')).toBe(null);
    expect(ctx.timeline.setCentered).toHaveBeenLastCalledWith(false);
  });

  it('moves panels into sheets on phones and adds the bottom toolbar', () => {
    const { root, ctx, mobile } = fakeEditor('phone');
    expect(root.dataset.layout).toBe('phone');
    expect(mobile.sheets.assets.body.contains(ctx.assets.el)).toBe(true);
    expect(mobile.sheets.details.body.contains(ctx.inspector.el)).toBe(true);
    expect(root.querySelector('.m-dock').hidden).toBe(false);
    const labels = [...root.querySelectorAll('.m-toolbar:not(.m-clipbar) .m-tool')].map((b) => b.textContent);
    expect(labels).toEqual(CATEGORIES.map((c) => c.label));
    expect(root.querySelector('.topbar-left .m-close')).not.toBe(null);
    expect(root.querySelector('.player-bar-right .m-undo')).not.toBe(null);
    expect(ctx.timeline.setCentered).toHaveBeenLastCalledWith(true);
  });

  it('opens the matching assets tab in a bottom sheet from the toolbar', () => {
    const { root, ctx, mobile } = fakeEditor('phone');
    root.querySelector('.m-tool[data-cat="filters"]').click();
    expect(ctx.assets.show).toHaveBeenCalledWith('filters');
    expect(mobile.sheets.assets.isOpen).toBe(true);
    expect(mobile.sheets.assets.el.querySelector('.sheet-title').textContent).toBe('Filters');
  });

  it('swaps to the clip toolbar on selection with tools for that clip type', () => {
    const { root, store, ctx } = fakeEditor('phone');
    const main = root.querySelector('.m-toolbar:not(.m-clipbar)');
    const clipBar = root.querySelector('.m-clipbar');
    expect(clipBar.hidden).toBe(true);
    root.querySelector('.m-tool[data-cat="edit"]').click(); // selects the base-track clip at the playhead
    expect(store.selection.has('v1')).toBe(true);
    expect(main.hidden).toBe(true);
    expect(clipBar.hidden).toBe(false);
    expect(clipBar.querySelector('[data-tool="freeze"]').hidden).toBe(false);
    expect(clipBar.querySelector('[data-tool="extract"]').hidden).toBe(false);
    clipBar.querySelector('[data-tool="split"]').click();
    expect(ctx.actions.split).toHaveBeenCalled();
    store.select('m1');
    expect(clipBar.querySelector('[data-tool="freeze"]').hidden).toBe(true);
    expect(clipBar.querySelector('[data-tool="mirror"]').hidden).toBe(true);
    expect(clipBar.querySelector('[data-tool="volume"]').hidden).toBe(false);
    clipBar.querySelector('.m-back').click();
    expect(store.selection.size).toBe(0);
    expect(main.hidden).toBe(false);
  });

  it('opens the details panel in a sheet from Edit details', () => {
    const { root, store, mobile } = fakeEditor('phone');
    store.select('v1');
    root.querySelector('[data-tool="details"]').click();
    expect(mobile.sheets.details.isOpen).toBe(true);
    expect(mobile.sheets.details.side).toBe('bottom');
  });

  it('a speed drag keeps the footage it began with when a neighbor cuts the clip short', () => {
    const { root, ctx, store } = fakeEditor('phone');
    const clip = store.project.tracks[0].clips[0];
    // Stand-in for the timeline: the next clip at 5 s limits how long this one can get.
    ctx.actions.setSpeed = vi.fn((id, v, { span } = {}) => {
      const keep = span ?? clip.duration * clip.speed;
      clip.speed = v;
      clip.duration = Math.min(5e6, Math.round(keep / v));
    });
    store.select('v1');
    root.querySelector('[data-tool="speed"]').click();
    const range = document.querySelector('.tool-sheet input[type=range]');
    for (const v of [0.7, 0.5, 0.7, 1]) {
      range.value = String(v);
      range.dispatchEvent(new Event('input', { bubbles: true }));
    }
    range.dispatchEvent(new Event('change', { bubbles: true }));
    expect(clip.speed).toBe(1);
    expect(clip.duration).toBe(5e6);
    // A new drag starts from what the clip shows now.
    range.value = '0.5';
    range.dispatchEvent(new Event('input', { bubbles: true }));
    range.dispatchEvent(new Event('change', { bubbles: true }));
    range.value = '1';
    range.dispatchEvent(new Event('input', { bubbles: true }));
    range.dispatchEvent(new Event('change', { bubbles: true }));
    expect(clip.duration).toBe(2.5e6);
  });

  it('follows the screen between phone, tablet and desktop', () => {
    const { root, ctx, mm, mobile } = fakeEditor('phone');
    mm.set('tablet');
    expect(root.dataset.layout).toBe('tablet');
    expect(upperOrder(root)).toEqual(['assets-panel', 'v', 'player-panel', 'v']);
    expect(mobile.sheets.details.body.contains(ctx.inspector.el)).toBe(true);
    expect(mobile.sheets.details.side).toBe('end');
    expect(root.querySelector('.topbar-right .m-details-btn')).not.toBe(null);
    expect(root.querySelector('.tl-tools.right .m-more')).not.toBe(null);
    expect(root.querySelector('.m-close, .m-undo')).toBe(null);
    expect(root.querySelector('.m-dock').hidden).toBe(true);
    expect(ctx.timeline.setCentered).toHaveBeenLastCalledWith(false);

    root.querySelector('.m-details-btn').click();
    expect(mobile.sheets.details.isOpen).toBe(true);
    expect(root.querySelector('.m-details-btn').getAttribute('aria-expanded')).toBe('true');

    mm.set('desktop');
    expect(root.dataset.layout).toBe('desktop');
    expect(mobile.sheets.details.isOpen).toBe(false);
    expect(upperOrder(root)).toEqual(['assets-panel', 'v', 'player-panel', 'v', 'inspector']);
    expect(root.querySelector('.m-details-btn, .m-more')).toBe(null);

    mm.set('phone');
    expect(root.dataset.layout).toBe('phone');
    expect(mobile.sheets.assets.body.contains(ctx.assets.el)).toBe(true);
  });

  it('uses the tablet layout on a desktop screen whose workspace is too narrow for both side panels', () => {
    const { root, mm, mobile, ctx } = fakeEditor('desktop');
    mobile.setNarrowWorkspace(true);
    expect(root.dataset.layout).toBe('tablet');
    expect(mobile.sheets.details.body.contains(ctx.inspector.el)).toBe(true);
    mobile.setNarrowWorkspace(false);
    expect(root.dataset.layout).toBe('desktop');
    // Phones stay phones, and a forced layout wins.
    mobile.setNarrowWorkspace(true);
    mm.set('phone');
    expect(root.dataset.layout).toBe('phone');
    mm.set('desktop');
    mobile.setMode('desktop');
    expect(root.dataset.layout).toBe('desktop');
  });

  it('can be forced into a layout and releases its listeners on dispose', () => {
    const { root, mm, mobile } = fakeEditor('desktop');
    mobile.setMode('phone');
    expect(root.dataset.layout).toBe('phone');
    mobile.setMode(null);
    expect(root.dataset.layout).toBe('desktop');
    expect(mm.listenerCount()).toBe(2);
    mobile.dispose();
    expect(mm.listenerCount()).toBe(0);
    expect(root.querySelector('.m-dock')).toBe(null);
  });
});

describe('gestures', () => {
  const pe = (id, x, y) => ({ pointerId: id, clientX: x, clientY: y });

  it('reports pinch scale steps and totals', () => {
    const onChange = vi.fn();
    const onEnd = vi.fn();
    const p = createPinch({ onChange, onEnd });
    expect(p.down(pe(1, 100, 0))).toBe(false);
    expect(p.down(pe(2, 200, 0))).toBe(true);
    p.move(pe(2, 300, 0));
    expect(onChange).toHaveBeenLastCalledWith(2, 2, { x: 200, y: 0 });
    p.move(pe(1, 0, 0));
    expect(onChange.mock.calls[1][0]).toBeCloseTo(1.5);
    expect(onChange.mock.calls[1][1]).toBeCloseTo(3);
    p.up(pe(1, 0, 0));
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(p.active).toBe(false);
  });

  it('fires a long press only when the finger stays still', () => {
    vi.useFakeTimers();
    try {
      const onPress = vi.fn();
      const still = longPress(pe(1, 10, 10), { onPress });
      still.move(pe(1, 14, 12));
      vi.advanceTimersByTime(360);
      expect(onPress).toHaveBeenCalledTimes(1);
      expect(still.fired).toBe(true);

      const onPress2 = vi.fn();
      const scroll = longPress(pe(1, 10, 10), { onPress: onPress2 });
      expect(scroll.move(pe(1, 40, 10))).toBe(false);
      vi.advanceTimersByTime(400);
      expect(onPress2).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
