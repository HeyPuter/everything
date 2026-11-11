import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Frames come from the decoder in the app; here clip "Warm" is a warm, bright
// version of the same picture as clip "Plain".
vi.mock('../src/media/frame-sampler.js', async () => {
  const { gradePixels } = await import('../src/model/color-match.js');
  const plain = () => {
    const d = new Uint8ClampedArray(32 * 18 * 4);
    for (let i = 0; i < 32 * 18; i++) d.set([60 + (i % 32) * 3, 70 + (i % 18) * 4, 80 + ((i * 7) % 50), 255], i * 4);
    return { t: 0, data: d, width: 32, height: 18 };
  };
  return {
    clipFrames: async (blob, clip) => {
      const f = plain();
      return [clip.name === 'Warm' ? { ...f, data: gradePixels(f.data, { exposure: 25, temperature: 40 }) } : f];
    },
  };
});

const { EditorStore } = await import('../src/model/store.js');
const { createProject, makeClip } = await import('../src/model/project.js');
const { createActions } = await import('../src/ui/actions.js');
const { createInspector } = await import('../src/ui/inspector/index.js');
const { matchColor } = await import('../src/ui/color-tools.js');
const T = await import('../src/model/timeline.js');
const { US } = await import('../src/lib/time.js');

let env;

function setup() {
  const p = createProject();
  p.assets.a1 = { id: 'a1', kind: 'video', name: 'clip.mp4', duration: 20 * US, width: 1920, height: 1080, fps: 30, hasAudio: false, hasVideo: true };
  const warm = makeClip('video', { assetId: 'a1', start: 0, duration: 5 * US, name: 'Warm' });
  const plain = makeClip('video', { assetId: 'a1', start: 5 * US, duration: 5 * US, name: 'Plain' });
  T.mainTrack(p).clips.push(warm, plain);
  const adj = makeClip('adjust', { start: 0, duration: 3 * US });
  T.addClip(p, adj);
  const store = new EditorStore(p);
  const ctx = { store, library: { mediaBlob: async () => new Blob([]), listLuts: async () => [], on: () => () => {} } };
  ctx.actions = createActions(ctx);
  const insp = createInspector(ctx);
  document.body.append(insp.el);
  return { store, ctx, insp, el: insp.el, warm, plain, adj };
}

const clip = (id) => T.findClip(env.store.project, id).clip;
const tab = (name) => [...env.el.querySelectorAll('[role=tab]')].find((t) => t.textContent === name);
const button = (text) => [...env.el.querySelectorAll('button')].find((b) => b.textContent.trim() === text);
const until = async (fn) => {
  for (let i = 0; i < 50 && !fn(); i++) await new Promise((r) => setTimeout(r, 5));
};

beforeEach(() => {
  localStorage.clear();
  env = setup();
});

afterEach(() => {
  env.insp.dispose();
  env.el.remove();
});

describe('Match color', () => {
  it('lists the clip before and the other clips, and is not offered on a color layer', () => {
    env.store.select(env.plain.id);
    tab('Color').click();
    const sel = [...env.el.querySelectorAll('.insp-row')].find((r) => r.textContent.startsWith('Match to')).querySelector('select');
    const labels = [...sel.options].map((o) => o.textContent);
    expect(labels[0]).toBe('Clip before: Warm');
    expect(labels).toContain('Warm at 00:00');
    expect(sel.value).toBe(env.warm.id);
    env.store.select(env.adj.id);
    expect(button('Match')).toBeUndefined();
  });

  it('matches in one undo step, at the chosen strength', async () => {
    env.store.select(env.plain.id);
    tab('Color').click();
    const depth = env.store.history.undoStack.length;
    const go = button('Match');
    go.focus();
    go.click();
    // Disabled while matching; browsers then move focus to the page.
    expect(go.disabled).toBe(true);
    // Browsers move focus off a disabled control.
    {
      const b = document.activeElement;
      b.disabled = false;
      b.blur();
      b.disabled = true;
    }
    await until(() => clip(env.plain.id).adjust.temperature !== 0);
    await until(() => !go.disabled);
    expect(document.activeElement).toBe(go);
    const a = clip(env.plain.id).adjust;
    expect(a.temperature).toBeGreaterThan(25);
    expect(a.exposure + a.brightness + a.contrast).not.toBe(0);
    expect(env.store.history.undoStack.length).toBe(depth + 1);
    expect(env.store.history.undoLabel).toBe('Match color');
    env.store.undo();
    expect(clip(env.plain.id).adjust.temperature).toBe(0);
    const half = await matchColor(env.ctx, env.plain.id, env.warm.id, { strength: 50 });
    expect(clip(env.plain.id).adjust.temperature).toBe(half.adjust.temperature);
    expect(Math.abs(half.adjust.temperature - a.temperature / 2)).toBeLessThanOrEqual(1);
    expect(half.after).toBeLessThan(half.before);
  });

  it('refuses to match a clip to itself', async () => {
    expect(await matchColor(env.ctx, env.plain.id, env.plain.id)).toBe(null);
  });
});
