// Hover previews animate a tile while it is hovered; a tile replaced under
// the pointer never gets pointerleave, so each loop must stop on its own once
// its canvas has left the page.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EditorStore } from '../src/model/store.js';
import { createProject, makeClip } from '../src/model/project.js';
import { createActions } from '../src/ui/actions.js';
import { createInspector } from '../src/ui/inspector/index.js';
import { hoverAnimateLook } from '../src/ui/text-thumbs.js';
import { textTab } from '../src/ui/panels/text.js';
import { hoverAnimate } from '../src/ui/panels/previews.js';
import * as T from '../src/model/timeline.js';
import { US } from '../src/lib/time.js';
import { mockContext } from './canvas-mock.js';

// jsdom has no WebGL: a stand-in compositor lets the effect/filter previews run.
vi.mock('../src/engine/compositor.js', () => ({
  Compositor: class {
    render() {}
    resize() {}
  },
}));

let queue;
let realRaf;
let realCancel;
const realGetContext = HTMLCanvasElement.prototype.getContext;

/** Run the queued animation frames once; returns how many ran. */
function runFrames() {
  const due = queue;
  queue = new Map();
  for (const fn of due.values()) fn(performance.now());
  return due.size;
}

beforeEach(() => {
  queue = new Map();
  let id = 0;
  realRaf = globalThis.requestAnimationFrame;
  realCancel = globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame = (fn) => {
    queue.set(++id, fn);
    return id;
  };
  globalThis.cancelAnimationFrame = (n) => queue.delete(n);
  HTMLCanvasElement.prototype.getContext = () => mockContext();
});

afterEach(() => {
  globalThis.requestAnimationFrame = realRaf;
  globalThis.cancelAnimationFrame = realCancel;
  HTMLCanvasElement.prototype.getContext = realGetContext;
  document.body.replaceChildren();
});

/**
 * Hover host, let the loop run, then drop it from the page while hovered:
 * the loop ends, and plays again when the tile is back (a cached tab) and hovered.
 */
function expectStopsWhenRemoved(host) {
  const parent = host.parentElement;
  host.dispatchEvent(new Event('pointerenter'));
  expect(runFrames()).toBe(1);
  expect(runFrames()).toBe(1);
  host.remove();
  runFrames();
  expect(queue.size).toBe(0);
  parent.append(host);
  host.dispatchEvent(new Event('pointerenter'));
  expect(runFrames()).toBe(1);
  expect(queue.size).toBe(1);
  host.dispatchEvent(new Event('pointerleave'));
  expect(queue.size).toBe(0);
}

describe('hover previews stop when their tile is replaced', () => {
  it('effect and filter tiles', () => {
    const tileEl = document.createElement('button');
    const canvas = document.createElement('canvas');
    tileEl.append(canvas);
    document.body.append(tileEl);
    hoverAnimate(tileEl, 'filter', 'vivid');
    expectStopsWhenRemoved(tileEl);
  });

  it('letter animation tiles', () => {
    const host = document.createElement('button');
    const canvas = document.createElement('canvas');
    host.append(canvas);
    document.body.append(host);
    hoverAnimateLook(host, canvas, { text: 'Text' }, 'letters-rise', 'in');
    expectStopsWhenRemoved(host);
  });

  it('title template tiles', () => {
    const store = new EditorStore(createProject());
    const ctx = { store };
    ctx.actions = createActions(ctx);
    const panel = textTab(ctx);
    document.body.append(panel.el);
    [...panel.el.querySelectorAll('.asset-cat')].find((b) => b.textContent === 'Templates').click();
    const t = [...panel.el.querySelectorAll('.tile')].find((x) => x.textContent.includes('Quote card'));
    expectStopsWhenRemoved(t);
  });

  it('motion animation tiles in the details panel', () => {
    const p = createProject();
    p.assets.a1 = { id: 'a1', kind: 'video', name: 'clip.mp4', duration: 20 * US, width: 1920, height: 1080, fps: 30, hasAudio: true, hasVideo: true };
    const v = makeClip('video', { assetId: 'a1', start: 0, duration: 5 * US });
    T.mainTrack(p).clips.push(v);
    const store = new EditorStore(p);
    const ctx = { store };
    ctx.actions = createActions(ctx);
    const insp = createInspector(ctx);
    document.body.append(insp.el);
    store.select(v.id);
    [...insp.el.querySelectorAll('[role=tab]')].find((x) => x.textContent === 'Animation').click();
    const t = [...insp.el.querySelectorAll('.anim-grid [role=radio]')].find((x) => x.textContent === 'Fade in');
    expectStopsWhenRemoved(t);
    insp.dispose();
  });
});
