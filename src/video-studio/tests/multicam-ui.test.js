import { describe, it, expect, afterEach } from 'vitest';
import { EditorStore } from '../src/model/store.js';
import { createActions } from '../src/ui/actions.js';
import { createCommands } from '../src/ui/commands.js';
import { createInspector, tabsFor } from '../src/ui/inspector/index.js';
import { createMulticam } from '../src/model/multicam-edit.js';
import { mainTrack, allClips, addClip } from '../src/model/timeline.js';
import { fixture, clip, onMain, s } from './helpers.js';

// jsdom has no canvas; the angle pictures stay blank.
HTMLCanvasElement.prototype.getContext = () => null;

let env;
afterEach(() => {
  env?.insp.dispose();
  env?.insp.el.remove();
  env = null;
});

/** A store with a two-angle multi-camera clip selected, and the inspector showing it. */
function setup() {
  const p = fixture();
  const [a] = onMain(p, clip('video', 0, 10, { name: 'Wide' }));
  const b = clip('video', 0, 10, { assetId: 'silent', name: 'Close' });
  addClip(p, b, { ripple: false });
  const m = createMulticam(p, [a.id, b.id], { ripple: true, linkOverlays: true });
  const store = new EditorStore(p);
  const ctx = { store, player: null, library: null };
  ctx.actions = createActions(ctx);
  ctx.commands = createCommands(ctx);
  const insp = createInspector(ctx);
  document.body.append(insp.el);
  store.select(m.id);
  env = { store, ctx, insp, el: insp.el, id: m.id };
  return env;
}

const mc = () => mainTrack(env.store.project).clips[0].multicam;
const key = (n) => new KeyboardEvent('keydown', { code: `Digit${n}`, key: String(n) });

describe('multi-camera editing', () => {
  it('opens on the Angles tab with a card per angle', () => {
    const { el, store } = setup();
    expect(tabsFor(store.project, store.selected.clip)).toEqual(['multicam', 'compound', 'animation']);
    const cards = [...el.querySelectorAll('.mc-card')];
    expect(cards.map((c) => c.querySelector('.mc-card-name').textContent)).toEqual(['Wide', 'Close']);
    expect(cards[0].getAttribute('aria-pressed')).toBe('true');
  });

  it('switches angles from the playhead with a click or a number key, one undo step each', () => {
    const { el, store, ctx } = setup();
    store.seek(s(2));
    el.querySelectorAll('.mc-card')[1].click();
    expect(mc().cuts).toEqual([{ t: 0, angle: 0 }, { t: s(2), angle: 1 }]);
    expect(el.querySelectorAll('.mc-card')[1].getAttribute('aria-pressed')).toBe('true');
    store.seek(s(5));
    expect(ctx.commands.handleKey(key(1))).toBe(true);
    expect(mc().cuts.map((c) => c.angle)).toEqual([0, 1, 0]);
    // The cut list shows the opening angle and both cuts.
    expect(el.querySelectorAll('.mc-cut').length).toBe(3);
    store.undo();
    expect(mc().cuts.length).toBe(2);
    // A number past the last angle does nothing.
    ctx.commands.handleKey(key(3));
    expect(mc().cuts.length).toBe(2);
  });

  it('leaves the cuts alone on a locked track', () => {
    const { store, ctx } = setup();
    store.update('Lock track', (p) => void (mainTrack(p).locked = true), { structural: false });
    store.seek(s(2));
    expect(ctx.commands.handleKey(key(2))).toBe(true);
    expect(ctx.actions.setMulticamAudio('follow')).toBe(false);
    expect(mc()).toEqual({ cuts: [{ t: 0, angle: 0 }], audio: 0 });
  });

  it('deletes a cut from the list and sets the sound source', () => {
    const { el, store, ctx } = setup();
    store.seek(s(3));
    ctx.actions.switchAngle(1);
    el.querySelector('.mc-cut [aria-label^="Delete the cut"]').click();
    expect(mc().cuts).toEqual([{ t: 0, angle: 0 }]);
    const sel = el.querySelector('.mc-tab select');
    sel.value = 'follow';
    sel.dispatchEvent(new Event('change'));
    expect(mc().audio).toBe('follow');
    expect([...sel.options].map((o) => o.textContent)).toEqual(['The angle that shows', '1. Wide', '2. Close (no sound)']);
  });

  it('flattens into plain clips as one undo step', () => {
    const { store, ctx } = setup();
    store.seek(s(4));
    ctx.actions.switchAngle(1);
    ctx.actions.flattenMulticam();
    const main = mainTrack(store.project).clips;
    expect(main.map((c) => [c.assetId, c.start / 1e6, c.duration / 1e6])).toEqual([['vid', 0, 4], ['silent', 4, 6]]);
    expect(allClips(store.project).filter((c) => c.type === 'audio').length).toBe(1);
    store.undo();
    expect(mainTrack(store.project).clips[0].multicam).toBeTruthy();
  });

  it('asks for 2 to 9 video clips', async () => {
    const { store, ctx } = setup();
    store.select([env.id]);
    expect(await ctx.actions.createMulticam()).toBeNull();
    expect(document.body.textContent).toContain('Select 2 to 9 video clips');
  });
});
