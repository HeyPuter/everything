// Clip remix: the clip model, the background Remixer, saving, the Clip >
// Remix commands and dialog, and the remixed clip in the multitrack view
// (badge, seams, right-edge retargeting). The DSP is in remix-analysis.test.js.
import { describe, it, expect, beforeAll } from 'vitest';
import * as S from '../src/model/session-edits.js';
import { Session } from '../src/model/session.js';
import { Channel } from '../src/audio/channel.js';
import { clipPlan } from '../src/model/session-graph.js';
import { analyzeMusic } from '../src/multitrack/remix-analysis.js';
import { remixClip, unremixClip, remixKey, remixSeams, remixJoins, splitRemix, isRemixed, remixOrigin, revertRemixes } from '../src/model/clip-remix.js';
import { restretchClip, stretchOf } from '../src/model/clip-stretch.js';
import { Remixer, remixIdle } from '../src/multitrack/remix.js';
import { Stretcher } from '../src/multitrack/stretch.js';
import { serializeSession, parseSession } from '../src/model/session-io.js';
import { songAnalysis as cachedSong, MUSIC_RATE as RATE } from './helpers/music.js';

beforeAll(() => {
  HTMLCanvasElement.prototype.getContext = () => null;
  if (!globalThis.ResizeObserver) {
    globalThis.ResizeObserver = class {
      observe() {}
      disconnect() {}
    };
  }
});

const songAnalysis = () => cachedSong(analyzeMusic);

describe('clip remix model', () => {
  const clip = () => S.createClip({ trackId: 't', sourceId: 'orig', start: 300, offset: 100, length: 500, fadeIn: { length: 50, curve: 0 }, fadeOut: { length: 80, curve: 0 }, volumeEnv: [{ t: 0, v: 0 }, { t: 500, v: -6 }] });
  const segs = [
    [100, 400],
    [200, 500],
    [700, 1000],
  ];

  it('plays the derived source from its start and reverts to the original range', () => {
    const c = remixClip(clip(), { target: 900, edit: 0.25, balance: 0.75, maxJump: 0, xfade: 20, bpm: 120 }, segs, 'k');
    expect(c).toMatchObject({ sourceId: 'k', offset: 0, length: 900, start: 300, loop: false, stretch: null });
    expect(c.remix).toMatchObject({ sourceId: 'orig', offset: 100, length: 500, target: 900, edit: 0.25, balance: 0.75, xfade: 20, bpm: 120 });
    expect(isRemixed(c)).toBe(true);
    expect(c.volumeEnv[c.volumeEnv.length - 1].t).toBe(500);
    expect(remixJoins(c.remix)).toEqual([300, 600]);
    expect(remixSeams(c)).toEqual([300, 600]);
    // Remixing again keeps the original range.
    const again = remixClip(c, { target: 600 }, segs.slice(1), 'k2');
    expect(remixOrigin(again)).toEqual({ sourceId: 'orig', offset: 100, length: 500 });
    expect(again.remix.edit).toBe(0.25);
    const back = unremixClip(again);
    expect(back).toMatchObject({ sourceId: 'orig', offset: 100, length: 500, remix: null });
    expect(back.fadeIn.length).toBe(50);
  });

  it('starts from the unstretched audio of a stretched clip', () => {
    const st = restretchClip(clip(), { mode: 'realtime', ratio: 2 }, 'orig~x2');
    expect(remixOrigin(st)).toEqual({ sourceId: 'orig', offset: 100, length: 500 });
    const c = remixClip(st, { target: 900 }, segs, 'k');
    expect(c.stretch).toBe(null);
    expect(stretchOf(c).mode).toBe('off');
  });

  it('names derived sources by their segments', () => {
    expect(remixKey('a', segs, 20)).toBe(remixKey('a', segs.map((s) => s.slice()), 20));
    expect(remixKey('a', segs, 20)).not.toBe(remixKey('a', segs, 30));
    expect(remixKey('a', segs, 20)).not.toBe(remixKey('a', [segs[0], segs[2]], 20));
  });

  it('splits into plain clips that overlap and crossfade at the joins', () => {
    const c = remixClip(clip(), { target: 900, xfade: 20 }, segs, 'k');
    let n = 0;
    const parts = splitRemix(c, () => `p${++n}`, 1200);
    expect(parts.map((p) => [p.start, p.offset, p.length])).toEqual([
      [300, 100, 310],
      [590, 190, 320],
      [890, 690, 310],
    ]);
    expect(parts[0].id).toBe(c.id);
    expect(parts.every((p) => p.sourceId === 'orig' && !p.remix)).toBe(true);
    expect(parts[0].fadeIn.length).toBe(50);
    expect(parts[2].fadeOut.length).toBe(80);
    expect(parts[1].fadeIn.xf).toBe(true);
    let s = S.addClips(S.createSessionState({ sampleRate: 1000, tracks: 1 }), parts.map((p) => ({ ...p, trackId: 'x' })));
    s = { ...s, autoCrossfade: false };
    const plan = clipPlan(s);
    expect(plan.get(parts[1].id).fadeIn.length).toBe(20);
    expect(plan.get(parts[0].id).fadeOut.length).toBe(20);
    // A trimmed remixed clip splits only the part that plays.
    const trimmed = { ...c, offset: 350, length: 400 };
    const tparts = splitRemix(trimmed, () => 'q', 1200);
    expect(tparts.map((p) => [p.start, p.offset, p.length])).toEqual([
      [300, 250, 260],
      [540, 690, 160],
    ]);
  });

  it('splits a remixed clip at the session start without placing a piece before 0', () => {
    const c = { ...remixClip(clip(), { target: 900, xfade: 20 }, segs, 'k'), start: 0, offset: 295, length: 400 };
    const parts = splitRemix(c, () => 'q', 1200);
    expect(parts.map((p) => [p.start, p.offset, p.length])).toEqual([
      [0, 395, 15],
      [0, 195, 315],
      [295, 690, 105],
    ]);
    expect(parts.every((p) => p.start >= 0 && p.offset >= 0)).toBe(true);
  });

  it('copies remix settings in createClip, saves them and keeps the original audio', () => {
    const doc = new Session({ name: 'S.asesx', sampleRate: 1000, tracks: 1 });
    const orig = doc.addSource({ name: 'song.wav', channels: [Channel.fromSamples(new Float32Array(1200))] });
    const key = doc.addSource({ id: remixKey(orig, segs, 20), name: 'song (remix)', channels: [Channel.fromSamples(new Float32Array(900))] });
    const c = remixClip(S.createClip({ trackId: doc.state.tracks[0].id, sourceId: orig, offset: 100, length: 500 }), { target: 900, xfade: 20 }, segs, key);
    doc.apply('Insert', S.addClips(doc.state, [S.createClip(c)]));
    expect(S.findClip(doc.state, c.id).remix.segments).toEqual(segs);
    expect(doc.usedSources().has(orig)).toBe(true);
    const { text, media } = serializeSession(doc);
    expect(media.map((m) => m.id).sort()).toEqual([orig, key].sort());
    const parsed = parseSession(text);
    expect(parsed.state.clips[0].remix).toMatchObject({ sourceId: orig, target: 900, segments: segs });
    // Without the original, the clip keeps playing its remix but cannot remix again.
    const doc2 = JSON.parse(text);
    doc2.sources = doc2.sources.filter((x) => x.id !== orig);
    expect(parseSession(JSON.stringify(doc2)).state.clips[0].remix).toBe(null);
    // Without the remixed audio, the clip is kept to be remade from its original and plan.
    const doc3 = JSON.parse(text);
    doc3.sources = doc3.sources.filter((x) => x.id !== key);
    expect(parseSession(JSON.stringify(doc3)).state.clips[0]).toMatchObject({ sourceId: key });
  });

  it('reverts only remixed clips', () => {
    const c = remixClip(clip(), { target: 900 }, segs, 'k');
    const plain = S.createClip({ trackId: 't', sourceId: 'o2', length: 10 });
    const s = { ...S.createSessionState({ tracks: 1 }), clips: [c, plain] };
    const next = revertRemixes(s, [c.id, plain.id]);
    expect(next.clips[0].sourceId).toBe('orig');
    expect(next.clips[1]).toBe(plain);
    expect(revertRemixes(next, [plain.id])).toBe(next);
  });
});

/** A session with the synthetic song on one clip, and a Remixer reusing the cached analysis. */
async function sessionWithSong({ app = {} } = {}) {
  const { x, an } = await songAnalysis();
  const doc = new Session({ name: 'S.asesx', sampleRate: RATE, tracks: 2 });
  const src = doc.addSource({ name: 'song.wav', channels: [Channel.fromSamples(x)] });
  const c = S.createClip({ trackId: doc.state.tracks[0].id, sourceId: src, name: 'Song', start: RATE, length: 12 * RATE });
  doc.apply('Insert', S.addClips(doc.state, [c]));
  let analyses = 0;
  doc.remixer = new Remixer(app, doc, {
    analyze: async () => {
      analyses++;
      return an;
    },
  });
  return { doc, src, c, an, x, analyses: () => analyses };
}

describe('Remixer', () => {
  it('remixes at once with a spliced preview, then renders the crossfaded audio', async () => {
    const { doc, src, c, analyses } = await sessionWithSong();
    const plan = await doc.remixer.remix('Enable Remix', c.id, { target: 20 * RATE });
    const clip = S.findClip(doc.state, c.id);
    expect(clip.sourceId).toBe(remixKey(src, plan.segments, clip.remix.xfade));
    expect(clip.length).toBe(plan.length);
    expect(clip.remix.target).toBe(20 * RATE);
    expect(doc.history.undoLabel).toBe('Enable Remix');
    const entry = doc.pool.get(clip.sourceId);
    expect(entry.pending).toBe(true);
    expect(entry.channels[0].length).toBe(plan.length);
    const preview = entry.channels;
    await remixIdle(doc);
    expect(doc.pool.get(clip.sourceId).pending).toBe(false);
    expect(doc.pool.get(clip.sourceId).channels).not.toBe(preview);
    expect(doc.pool.get(clip.sourceId).channels[0].length).toBe(plan.length);
    // The analysis is reused for a new target.
    await doc.remixer.remix('Remix Clip Length', c.id, { target: 40 * RATE });
    expect(analyses()).toBe(1);
    expect(S.findClip(doc.state, c.id).remix.target).toBe(40 * RATE);
    doc.history.undo();
    expect(S.findClip(doc.state, c.id).remix.target).toBe(20 * RATE);
    doc.history.undo();
    expect(S.findClip(doc.state, c.id)).toMatchObject({ sourceId: src, length: 12 * RATE, remix: null });
    await remixIdle(doc);
  });

  it('turns clip stretching off when remixing, and remix off when stretching', async () => {
    const status = [];
    const app = { setStatus: (m) => status.push(m) };
    const { doc, src, c } = await sessionWithSong({ app });
    const st = new Stretcher(app, doc, { render: async ({ channels }) => channels });
    st.apply('Stretch', [c.id], { mode: 'realtime', ratio: 1.5 });
    expect(stretchOf(S.findClip(doc.state, c.id)).ratio).toBe(1.5);
    await doc.remixer.remix('Enable Remix', c.id, { target: 20 * RATE });
    let clip = S.findClip(doc.state, c.id);
    expect(clip.stretch).toBe(null);
    expect(clip.remix).toMatchObject({ sourceId: src, offset: 0, length: 12 * RATE });
    expect(status.some((m) => /stretching turned off/i.test(m))).toBe(true);
    // Mode Off leaves the remix alone; a stretch replaces it.
    expect(st.apply('Stretch Mode Off', [c.id], { mode: 'off' })).toBe(false);
    st.apply('Stretch Clip', [c.id], { mode: 'realtime', ratio: 2 });
    clip = S.findClip(doc.state, c.id);
    expect(clip.remix).toBe(null);
    expect(clip.length).toBe(24 * RATE);
    expect(status.some((m) => /remix turned off/i.test(m))).toBe(true);
    await st.whenIdle();
    await remixIdle(doc);
  });

  it('splits a remix into plain clips and reverts', async () => {
    const { doc, src, c } = await sessionWithSong();
    const plan = await doc.remixer.remix('Enable Remix', c.id, { target: 20 * RATE });
    const ids = doc.remixer.split('Split Remix into Segments', [c.id]);
    expect(ids).toHaveLength(plan.segments.length);
    const parts = ids.map((id) => S.findClip(doc.state, id));
    expect(parts.every((p) => p.sourceId === src && !p.remix)).toBe(true);
    expect(parts[0].start).toBe(RATE);
    expect(S.clipEnd(parts[parts.length - 1])).toBe(RATE + plan.length);
    expect([...doc.selectedClips].sort()).toEqual([...ids].sort());
    doc.history.undo();
    expect(doc.remixer.revert('Revert Remix', [c.id])).toBe(true);
    expect(S.findClip(doc.state, c.id)).toMatchObject({ sourceId: src, offset: 0, length: 12 * RATE });
    await remixIdle(doc);
  });

  it('remakes missing remixed media from the original and the plan', async () => {
    const { doc, c } = await sessionWithSong();
    await doc.remixer.remix('Enable Remix', c.id, { target: 20 * RATE });
    await remixIdle(doc);
    const key = S.findClip(doc.state, c.id).sourceId;
    doc.pool.delete(key);
    doc.remixer.sync();
    expect(doc.pool.get(key).pending).toBe(true);
    await remixIdle(doc);
    expect(doc.pool.get(key).channels[0].length).toBe(S.findClip(doc.state, c.id).length);
  });
});

async function appWithSong() {
  localStorage.clear();
  const { App } = await import('../src/app.js');
  const { installCore } = await import('../src/features/core.js');
  const { installMultitrack } = await import('../src/features/multitrack.js');
  const app = new App();
  installCore(app);
  installMultitrack(app);
  app.syncGraph = () => {};
  const made = await sessionWithSong({ app });
  app.addDocument(made.doc);
  return { app, ...made };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('remix commands', () => {
  it('enables, checks, splits and reverts from the Clip menu', async () => {
    const { app, doc, c } = await appWithSong();
    expect(app.commands.isEnabled('clip.remixEnable')).toBe(false);
    doc.selectClips([c.id]);
    expect(app.commands.isEnabled('clip.remixEnable')).toBe(true);
    expect(app.commands.isChecked('clip.remixEnable')).toBe(false);
    expect(app.commands.isEnabled('clip.remixRevert')).toBe(false);
    await app.commands.run('clip.remixEnable');
    const clip = S.findClip(doc.state, c.id);
    expect(isRemixed(clip)).toBe(true);
    // The first remix aims at the clip's length.
    expect(clip.remix.target).toBe(12 * RATE);
    expect(Math.abs(clip.length - 12 * RATE)).toBeLessThanOrEqual(0.55 * RATE);
    expect(app.commands.isChecked('clip.remixEnable')).toBe(true);
    expect(app.commands.isEnabled('clip.remixSplit')).toBe(true);
    await app.commands.run('clip.remixRevert');
    expect(S.findClip(doc.state, c.id).remix).toBe(null);
    expect(doc.history.undoLabel).toBe('Revert Remix');
    doc.history.undo();
    await app.commands.run('clip.remixSplit');
    expect(doc.history.undoLabel).toBe('Split Remix into Segments');
    expect(doc.state.clips.length).toBeGreaterThan(1);
    await remixIdle(doc);
  });

  it('refuses clips Sound Assistant calls something other than music', async () => {
    const { app, doc, c } = await appWithSong();
    doc.apply('Type', S.updateClips(doc.state, [c.id], { soundAssistant: { type: 'dialogue' } }));
    doc.selectClips([c.id]);
    expect(app.commands.isEnabled('clip.remixEnable')).toBe(false);
    expect(app.commands.isEnabled('clip.remixProperties')).toBe(false);
  });

  it('sets the target, edit length, balance and jump limit in Remix Properties', async () => {
    const { app, doc, c } = await appWithSong();
    doc.selectClips([c.id]);
    const run = app.commands.run('clip.remixProperties');
    const dlg = document.querySelector('.dialog');
    await tick();
    await tick();
    expect(dlg.querySelector('.remix-status').textContent).toMatch(/beats, 1[12]\d(\.\d)? BPM/);
    expect(dlg.querySelector('.remix-summary').textContent).toMatch(/segment/);
    const target = dlg.querySelector('[aria-label="Target duration"]');
    target.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageUp', bubbles: true }));
    expect(target.getValue()).toBeCloseTo(13, 3);
    const edit = dlg.querySelector('[aria-label="Edit length"]');
    edit.value = '10';
    edit.dispatchEvent(new Event('input'));
    const balance = dlg.querySelector('[aria-label="Features balance"]');
    balance.value = '80';
    balance.dispatchEvent(new Event('input'));
    dlg.querySelector('[aria-label="Longest jump in beats"]').value = '32';
    dlg.querySelector('.btn.primary').click();
    await run;
    const clip = S.findClip(doc.state, c.id);
    expect(clip.remix).toMatchObject({ target: 13 * RATE, edit: 0.1, balance: 0.8, maxJump: 32 });
    expect(doc.history.undoLabel).toBe('Remix Properties');
    await remixIdle(doc);
  });

  it('draws a remix badge and seam marks at the segment joins', async () => {
    const { app, doc, c } = await appWithSong();
    const plan = await doc.remixer.remix('Enable Remix', c.id, { target: 20 * RATE });
    const view = app.documentKinds.get('session').view(app, doc);
    document.body.replaceChildren(view.el);
    view.width = 1000;
    view.height = 600;
    view.computeRows();
    doc.setView(0, 30 * RATE);
    // A 2D context that records what is drawn.
    const calls = [];
    const ctx = new Proxy(
      { measureText: (t) => ({ width: t.length * 6 }) },
      {
        get: (o, k) => (k in o ? o[k] : (...args) => calls.push([k, ...args])),
        set: () => true,
      },
    );
    view.overlay.getContext = () => ctx;
    const draw = () => {
      calls.length = 0;
      for (const k of Object.keys(view.dirty)) view.dirty[k] = k === 'overlay';
      view.frame();
    };
    draw();
    const texts = calls.filter(([k]) => k === 'fillText').map(([, t]) => t);
    expect(texts.some((t) => t === 'remixing…' || t === 'remix')).toBe(true);
    await remixIdle(doc);
    draw();
    expect(calls.some(([k, t]) => k === 'fillText' && t === 'remix')).toBe(true);
    // Each join gets a dashed line; the stitches are two zig-zags of three strokes.
    const dashes = calls.filter(([k, a]) => k === 'setLineDash' && a.length === 2).length;
    expect(dashes).toBe(plan.segments.length - 1);
    view.destroy();
  });

  it('retargets a remix by dragging the clip’s right edge with the Move tool', async () => {
    const { app, doc, c } = await appWithSong();
    await doc.remixer.remix('Enable Remix', c.id, { target: 12 * RATE });
    const view = app.documentKinds.get('session').view(app, doc);
    document.body.replaceChildren(view.el);
    view.width = 1000;
    view.height = 600;
    view.computeRows();
    doc.setView(0, 50 * RATE);
    app.currentView = () => view;
    app.tool = 'move';
    // No stretch handles on a remixed clip: its corners are edges and fade handles.
    app.prefs.set('clipStretching', true);
    const r = view.clipRects().find((x) => x.clip.id === c.id);
    expect(view.hitTest(r.x0 + 3, r.y + 3).part).not.toBe('stretchIn');
    expect(view.hitTest(r.x1, r.y + 60).part).toBe('edgeOut');
    view.surface.setPointerCapture = () => {};
    const fire = (type, x, y) => view.surface.dispatchEvent(new MouseEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true }));
    const px = (8 * RATE) / view.fpp;
    fire('pointerdown', r.x1, r.y + 60);
    fire('pointermove', r.x1 + px, r.y + 60);
    const preview = doc.viewState.clips.find((x) => x.id === c.id);
    expect(preview.remixPreview).toBe(true);
    expect(Math.abs(preview.length - 20 * RATE)).toBeLessThan(RATE * 0.2);
    fire('pointerup', r.x1 + px, r.y + 60);
    await tick();
    await tick();
    const clip = S.findClip(doc.state, c.id);
    expect(Math.abs(clip.remix.target - 20 * RATE)).toBeLessThan(RATE * 0.2);
    expect(clip.remixPreview).toBeUndefined();
    expect(doc.history.undoLabel).toBe('Remix Clip Length');
    expect(Math.abs(clip.length - clip.remix.target)).toBeLessThanOrEqual(0.55 * RATE);
    expect(clip.remix.segments[clip.remix.segments.length - 1][1]).toBe(doc.sourceLength(clip.remix.sourceId));
    await remixIdle(doc);
    view.destroy();
  });
});
