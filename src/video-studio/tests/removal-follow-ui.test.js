// Follow motion in the Remove panel, with tracking replaced by a promise the test settles.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeClip, createProject } from '../src/model/project.js';
import { EditorStore } from '../src/model/store.js';
import { createActions } from '../src/ui/actions.js';
import { createInspector } from '../src/ui/inspector/index.js';
import { setKey } from '../src/model/keyframes.js';
import * as T from '../src/model/timeline.js';
import { US } from '../src/lib/time.js';

const track = vi.hoisted(() => ({ settle: null }));
vi.mock('../src/ui/removal-track.js', () => ({
  followRegion: (ctx, clipId, i, { signal }) => new Promise((resolve, reject) => {
    track.settle = (keys) => {
      if (keys) {
        ctx.store.update('Follow', (p) => {
          const c = T.findClip(p, clipId).clip;
          setKey(c.keyframes, `remove${i}.x`, 0, 0.1, 'linear', 1);
          setKey(c.keyframes, `remove${i}.x`, US, 0.2, 'linear', 1);
        }, { structural: false });
      }
      resolve(keys ? 2 : 0);
    };
    signal.addEventListener('abort', () => reject(Object.assign(new Error('Stopped'), { name: 'AbortError' })));
  }),
}));

/** Browsers move focus off a control that is disabled or hidden; jsdom keeps it there. */
function browserFocusFixup() {
  const a = document.activeElement;
  if (a && a !== document.body && (a.disabled || a.closest('[hidden]'))) {
    const d = a.disabled;
    a.disabled = false;
    a.blur();
    a.disabled = d;
  }
}

let env;
beforeEach(() => {
  HTMLCanvasElement.prototype.getContext = () => null;
  const p = createProject();
  p.assets.v = { id: 'v', kind: 'video', name: 'v.mp4', duration: 4 * US, width: 640, height: 360, fps: 30, hasVideo: true, hasAudio: false };
  const c = makeClip('video', { assetId: 'v', duration: 2 * US });
  T.mainTrack(p).clips.push(c);
  const store = new EditorStore(p);
  const ctx = { store };
  ctx.actions = createActions(ctx);
  const insp = createInspector(ctx);
  document.body.append(insp.el);
  store.select(c.id);
  insp.showVideoSub('remove');
  env = { store, el: insp.el };
  [...insp.el.querySelectorAll('button')].find((b) => b.textContent.trim() === 'New painted region').click();
});
afterEach(() => env.el.remove());

const button = (text) => [...env.el.querySelectorAll('button')].find((b) => b.textContent.trim() === text && !b.hidden);

describe('follow motion keyboard focus', () => {
  it('moves to Stop while tracking and back to Follow motion when done', async () => {
    const follow = button('Follow motion');
    follow.focus();
    follow.click();
    browserFocusFixup();
    expect(document.activeElement).toBe(button('Stop'));
    track.settle(true);
    await new Promise((r) => setTimeout(r, 0));
    // The settings rebuilt for the new keys show the finished state.
    expect(button('Follow motion').disabled).toBe(false);
    expect(button('Stop')).toBeUndefined();
    expect(env.el.querySelector('.removal-settings .progress').hidden).toBe(true);
    expect(button('Keep still')).toBeTruthy();
    browserFocusFixup();
    expect(document.activeElement).toBe(button('Follow motion'));
  });

  it('goes back to Follow motion after Stop', async () => {
    const follow = button('Follow motion');
    follow.focus();
    follow.click();
    browserFocusFixup();
    const stop = button('Stop');
    stop.click();
    await new Promise((r) => setTimeout(r, 0));
    browserFocusFixup();
    expect(document.activeElement).toBe(button('Follow motion'));
    expect(env.el.textContent).toMatch(/Stopped\./);
  });
});
