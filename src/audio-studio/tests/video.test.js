import { describe, it, expect, beforeAll } from 'vitest';
import { Channel } from '../src/audio/channel.js';
import * as S from '../src/model/session-edits.js';
import { Session } from '../src/model/session.js';
import { buildSessionGraph } from '../src/model/session-graph.js';
import { serializeSession, parseSession } from '../src/model/session-io.js';
import * as V from '../src/model/session-video.js';
import { mp4FrameRate, webmFrameRate, roundFrameRate, maybeVideo } from '../src/video/probe.js';
import { insertVideoHook, setVideoOfDoc, linkVideo } from '../src/video/media.js';
import { sessionZip } from '../src/multitrack/storage.js';
import { prepareVideoBytes, loadSessionVideo } from '../src/video/session-media.js';
import { unzipStore } from '../src/lib/zip.js';
import { App } from '../src/app.js';
import { installCore } from '../src/features/core.js';
import { installMultitrack } from '../src/features/multitrack.js';
import { installVideo, videoPropertySection } from '../src/features/video.js';
import { WORKSPACES } from '../src/ui/workspaces.js';
import { MENUS, commandMenuPaths } from '../src/ui/menus.js';

const RATE = 1000;

beforeAll(() => {
  HTMLCanvasElement.prototype.getContext = () => null;
  if (!globalThis.ResizeObserver) {
    globalThis.ResizeObserver = class {
      observe() {}
      disconnect() {}
    };
  }
});

function sessionWithVideo(o = {}) {
  const doc = new Session({ name: 'Film.asesx', sampleRate: RATE, tracks: 2 });
  const blob = new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'video/webm' });
  const sourceId = V.addVideoSource(doc, { name: 'Scene 1.webm', blob, width: 320, height: 180, duration: 8, fps: 25, ...o });
  doc.apply('Insert File', V.setVideoClip(doc.state, V.createVideoClip({ sourceId, name: 'Scene 1', start: 500, length: 8000 })));
  return { doc, sourceId, blob };
}

describe('video clip edits', () => {
  const base = () => V.setVideoClip(S.createSessionState({ sampleRate: RATE, tracks: 1 }), { sourceId: 'v1', name: 'V', start: 1000, offset: 0, length: 4000 });

  it('sets, updates and removes the clip without touching the input', () => {
    const s0 = S.createSessionState({ sampleRate: RATE, tracks: 1 });
    expect(V.videoClip(s0)).toBeNull();
    expect(V.setVideoClip(s0, null)).toBe(s0);
    const s1 = base();
    expect(s0.video).toBeUndefined();
    expect(V.videoClip(s1)).toMatchObject({ sourceId: 'v1', start: 1000, length: 4000, locked: false });
    expect(V.videoEnd(s1)).toBe(5000);
    expect(V.updateVideoClip(s1, { start: 1000 })).toBe(s1);
    const s2 = V.setVideoClip(s1, null);
    expect('video' in s2).toBe(false);
    expect(s2.tracks).toBe(s1.tracks);
  });

  it('moves (not before 0) and keeps locked clips in place', () => {
    const s = base();
    expect(V.videoClip(V.moveVideoClip(s, 250)).start).toBe(1250);
    expect(V.videoClip(V.moveVideoClip(s, -5000)).start).toBe(0);
    expect(V.moveVideoClip(s, 0)).toBe(s);
    const locked = V.updateVideoClip(s, { locked: true });
    expect(V.moveVideoClip(locked, 100)).toBe(locked);
    expect(V.trimVideoClip(locked, 'in', 1500)).toBe(locked);
  });

  it('trims within the media and keeps at least one frame', () => {
    const s = base();
    const a = V.videoClip(V.trimVideoClip(s, 'in', 1500, 4000));
    expect(a).toMatchObject({ start: 1500, offset: 500, length: 3500 });
    // The in point cannot go before the start of the media.
    const b = V.videoClip(V.trimVideoClip(V.trimVideoClip(s, 'in', 1500, 4000), 'in', 0, 4000));
    expect(b).toMatchObject({ start: 1000, offset: 0, length: 4000 });
    expect(V.videoClip(V.trimVideoClip(s, 'out', 3000, 4000)).length).toBe(2000);
    expect(V.videoClip(V.trimVideoClip(s, 'out', 99999, 4000)).length).toBe(4000);
    expect(V.videoClip(V.trimVideoClip(s, 'out', 0, 4000)).length).toBe(1);
    // Unknown media length: the out point is free.
    expect(V.videoClip(V.trimVideoClip(s, 'out', 9000)).length).toBe(8000);
  });

  it('maps timeline frames to media time inside the clip only', () => {
    const clip = V.createVideoClip({ sourceId: 'v', start: 1000, offset: 500, length: 2000 });
    expect(V.videoTimeAt(clip, 999, RATE)).toBeNull();
    expect(V.videoTimeAt(clip, 1000, RATE)).toBe(0.5);
    expect(V.videoTimeAt(clip, 2500, RATE)).toBe(2);
    expect(V.videoTimeAt(clip, 3000, RATE)).toBeNull();
    expect(V.videoTimeAt(null, 0, RATE)).toBeNull();
  });

  it('is one undo step in a session and extends the timeline, not the mix length', () => {
    const { doc } = sessionWithVideo();
    expect(doc.length).toBe(0);
    expect(doc.extent).toBeGreaterThanOrEqual(8500 + RATE * 30);
    doc.apply('Move Video Clip', V.moveVideoClip(doc.state, 100));
    expect(V.videoClip(doc.state).start).toBe(600);
    doc.history.undo();
    expect(V.videoClip(doc.state).start).toBe(500);
    // Other edits keep the video clip.
    const t = S.createTrack({ name: 'X' });
    doc.apply('Add Track', S.addTrack(doc.state, t));
    expect(V.videoClip(doc.state).start).toBe(500);
  });
});

describe('video sync', () => {
  it('seeks when stopped and off the frame, otherwise leaves it', () => {
    expect(V.syncStep({ current: 1, target: 1.01, playing: false, fps: 25 })).toBeNull();
    expect(V.syncStep({ current: 1, target: 1.05, playing: false, fps: 25 })).toEqual({ seek: 1.05 });
    expect(V.syncStep({ current: 1, target: 1.03, playing: false })).toEqual({ seek: 1.03 });
  });

  it('nudges the speed for small drift and seeks for large drift while playing', () => {
    expect(V.syncStep({ current: 2, target: 2.01, playing: true })).toEqual({ rate: 1 });
    const behind = V.syncStep({ current: 2, target: 2.1, playing: true });
    expect(behind.rate).toBeGreaterThan(1);
    expect(behind.rate).toBeLessThanOrEqual(1.1);
    const ahead = V.syncStep({ current: 2.1, target: 2, playing: true });
    expect(ahead.rate).toBeLessThan(1);
    expect(ahead.rate).toBeGreaterThanOrEqual(0.9);
    expect(V.syncStep({ current: 2, target: 3, playing: true })).toEqual({ seek: 3, rate: 1 });
  });
});

describe('video thumbnails', () => {
  const clip = V.createVideoClip({ sourceId: 'v', start: 1000, offset: 0, length: 10000 });

  it('lays tiles from the clip start across the visible part only', () => {
    // 10 frames per px: a 100 px tile covers 1000 frames (1 s).
    const { tiles, step } = thumbnailTilesAt(0);
    expect(step).toBe(1);
    expect(tiles[0]).toEqual({ x: 100, time: 0 });
    expect(tiles[1]).toEqual({ x: 200, time: 1 });
    expect(tiles.length).toBe(9);
    // Scrolled into the clip: the first tile starts left of the view, on the same grid.
    const r = thumbnailTilesAt(3500);
    expect(r.tiles[0]).toEqual({ x: -50, time: 2 });
    expect(r.tiles.every((t) => Number.isInteger(t.time))).toBe(true);
  });

  it('rounds times to a power-of-two step and stays inside the media', () => {
    const { tiles, step } = V.thumbnailTiles({ clip, viewStart: 0, fpp: 7, width: 1000, tileWidth: 100, rate: RATE, duration: 5 });
    expect(step).toBe(0.5);
    for (const t of tiles) expect((t.time / 0.5) % 1 === 0 || t.time === 5 - 1 / 60).toBe(true);
    expect(Math.max(...tiles.map((t) => t.time))).toBeLessThan(5);
    expect(V.thumbnailTiles({ clip: null, viewStart: 0, fpp: 1, width: 10, tileWidth: 10, rate: RATE }).tiles).toEqual([]);
  });

  function thumbnailTilesAt(viewStart) {
    return V.thumbnailTiles({ clip, viewStart, fpp: 10, width: 1000, tileWidth: 100, rate: RATE, duration: 10 });
  }
});

describe('video frame rate from headers', () => {
  const box = (type, ...payload) => {
    const body = concat(payload);
    const out = new Uint8Array(8 + body.length);
    new DataView(out.buffer).setUint32(0, out.length);
    out.set([...type].map((c) => c.charCodeAt(0)), 4);
    out.set(body, 8);
    return out;
  };
  const u32 = (...v) => {
    const out = new Uint8Array(v.length * 4);
    v.forEach((x, i) => new DataView(out.buffer).setUint32(i * 4, x));
    return out;
  };
  const ascii = (s) => new Uint8Array([...s].map((c) => c.charCodeAt(0)));
  const trak = (handler, timescale, entries) =>
    box(
      'trak',
      box(
        'mdia',
        box('mdhd', u32(0, 0, 0, timescale, 0)),
        box('hdlr', u32(0, 0), ascii(handler), u32(0, 0, 0)),
        box('minf', box('stbl', box('stts', u32(0, entries.length, ...entries.flat())))),
      ),
    );

  it('reads the video track of an MP4, skipping audio tracks', () => {
    const file = concat([box('ftyp', ascii('isom')), box('moov', trak('soun', 48000, [[100, 1024]]), trak('vide', 24000, [[240, 1001]]))]);
    expect(mp4FrameRate(file)).toBe(23.976);
    const vfr = concat([box('moov', trak('vide', 600, [[10, 20], [10, 30]]))]);
    expect(mp4FrameRate(vfr)).toBe(24);
    expect(mp4FrameRate(box('ftyp', ascii('isom')))).toBe(0);
  });

  it('reads DefaultDuration of the WebM video track', () => {
    const el = (id, body) => concat([id, new Uint8Array([0x80 | body.length]), body]);
    const track = (type, dur) => el(new Uint8Array([0xae]), concat([el(new Uint8Array([0x83]), new Uint8Array([type])), ...(dur ? [el(new Uint8Array([0x23, 0xe3, 0x83]), u32(dur))] : [])]));
    const tracks = el(new Uint8Array([0x16, 0x54, 0xae, 0x6b]), concat([track(2, 0), track(1, 40000000)]));
    // A segment of unknown size, as recorders write it.
    const segment = concat([new Uint8Array([0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]), tracks]);
    const header = el(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]), new Uint8Array([0x42, 0x86, 0x81, 0x01]));
    expect(webmFrameRate(concat([header, segment]))).toBe(25);
    const noRate = el(new Uint8Array([0x16, 0x54, 0xae, 0x6b]), track(1, 0));
    expect(webmFrameRate(concat([header, new Uint8Array([0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]), noRate]))).toBe(0);
  });

  it('rounds to nominal rates and recognizes video names', () => {
    expect(roundFrameRate(29.97002997)).toBe(29.97);
    expect(roundFrameRate(12.5)).toBe(12.5);
    expect(roundFrameRate(Infinity)).toBe(0);
    expect(maybeVideo('a.MOV')).toBe(true);
    expect(maybeVideo('a.wav')).toBe(false);
    expect(maybeVideo('noext', 'video/mp4')).toBe(true);
  });
});

describe('video in session files', () => {
  it('references a video on Puter by path and round-trips the clip', () => {
    const { doc, sourceId } = sessionWithVideo({ path: '/me/Videos/Scene 1.webm' });
    const { text, video } = serializeSession(doc);
    expect(video).toBeNull();
    const json = JSON.parse(text);
    expect(json.video).toMatchObject({ id: sourceId, path: '/me/Videos/Scene 1.webm', width: 320, height: 180, fps: 25, duration: 8 });
    const parsed = parseSession(text);
    expect(parsed.video.id).toBe(sourceId);
    expect(V.videoClip(parsed.state)).toMatchObject({ sourceId, start: 500, length: 8000 });
  });

  it('writes a local video into the media folder (and always into ZIPs)', () => {
    const { doc, blob } = sessionWithVideo();
    const { text, video } = serializeSession(doc);
    expect(video).toMatchObject({ file: 'Film_Media/Scene 1.webm', blob });
    expect(JSON.parse(text).video.file).toBe('Film_Media/Scene 1.webm');
    V.videoPool(doc).get(video.id).path = '/me/Film_Media/Scene 1.webm';
    expect(serializeSession(doc, { embedVideo: true }).video.file).toBe('Film_Media/Scene 1.webm');
  });

  it('drops a video clip whose media entry is missing; sessions without video stay as they were', () => {
    const { doc } = sessionWithVideo();
    const json = JSON.parse(serializeSession(doc).text);
    delete json.video;
    expect(parseSession(JSON.stringify(json)).state.video).toBeUndefined();
    const plain = serializeSession(new Session({ tracks: 1 }));
    expect(JSON.parse(plain.text).video).toBeUndefined();
    expect(parseSession(plain.text).video).toBeNull();
  });

  it('stores the video bytes in session ZIPs', async () => {
    const { doc } = sessionWithVideo();
    await prepareVideoBytes(doc);
    const files = unzipStore(await sessionZip(doc).arrayBuffer());
    expect([...files.get('Film_Media/Scene 1.webm')]).toEqual([1, 2, 3, 4]);
    // Without reading ahead the ZIP still opens, with the video offline.
    const again = unzipStore(await sessionZip(doc).arrayBuffer());
    expect(again.has('Film_Media/Scene 1.webm')).toBe(false);
  });

  it('opens a missing video offline, keeping its details', async () => {
    const { doc } = sessionWithVideo();
    const parsed = parseSession(serializeSession(doc).text);
    const next = new Session({ state: parsed.state });
    const found = await loadSessionVideo(next, parsed.video, { source: { type: 'local' }, loadMedia: async () => null });
    expect(found).toBe(false);
    const src = V.videoSourceOf(next);
    expect(src).toMatchObject({ offline: true, blob: null, width: 320, fps: 25 });
  });

  it('leaves the mix untouched', () => {
    const { doc } = sessionWithVideo();
    const src = doc.addSource({ name: 'a', channels: [Channel.fromSamples(new Float32Array(100).fill(0.5))] });
    const st = S.addClips(doc.state, [S.createClip({ trackId: doc.state.tracks[0].id, sourceId: src, start: 0, length: 100 })]);
    const a = buildSessionGraph(st, doc.pool).graph;
    const b = buildSessionGraph(V.setVideoClip(st, null), doc.pool).graph;
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe('video insert and commands', () => {
  function setup() {
    localStorage.clear();
    const app = new App();
    installCore(app);
    installMultitrack(app);
    installVideo(app);
    app.syncGraph = () => {};
    const doc = new Session({ name: 'Film.asesx', sampleRate: RATE, tracks: 2 });
    app.addDocument(doc);
    const audio = { kind: 'audio', id: 'a1', name: 'Scene 1.webm', length: 8000, sampleRate: RATE, channelCount: 2, state: { channels: [Channel.fromSamples(new Float32Array(8000)), Channel.fromSamples(new Float32Array(8000))] }, source: { type: 'local' } };
    return { app, doc, audio };
  }

  it('puts an inserted video file on the video track in the same undo step as its audio', async () => {
    const { app, doc, audio } = setup();
    setVideoOfDoc(audio, { blob: new Blob([new Uint8Array(4)], { type: 'video/webm' }), name: 'Scene 1.webm', width: 320, height: 180, duration: 8, fps: 25 });
    const ids = await app.multitrack.insertDocs(doc, [audio], { at: 2000 });
    const clip = S.findClip(doc.state, ids[0]);
    expect(V.videoClip(doc.state)).toMatchObject({ name: 'Scene 1', start: 2000, offset: 0, length: 8000 });
    expect(clip.start).toBe(2000);
    expect(doc.history.entries[doc.history.index].label).toBe('Insert File');
    doc.history.undo();
    expect(V.videoClip(doc.state)).toBeNull();
    expect(doc.state.clips).toHaveLength(0);
  });

  it('asks before replacing the video, and keeps it when declined', async () => {
    const { doc } = setup();
    const first = { blob: new Blob([new Uint8Array(1)]), name: 'One.mp4', width: 2, height: 2, duration: 8 };
    const second = { blob: new Blob([new Uint8Array(2)]), name: 'Two.mp4', width: 2, height: 2, duration: 8 };
    const sourceId = linkVideo(doc, first);
    let state = V.setVideoClip(doc.state, { sourceId, name: 'One', start: 0, length: 8000 });
    const audio = { kind: 'audio', name: 'Two.mp4' };
    setVideoOfDoc(audio, second);
    const clip = S.createClip({ trackId: doc.state.tracks[0].id, sourceId: 's', start: 100, length: 8000 });
    const pending = insertVideoHook(null, doc, state, [{ doc: audio, clip }]);
    await Promise.resolve();
    const dialog = document.querySelector('.dialog, [role="dialog"]');
    expect(dialog?.textContent).toMatch(/Replace/);
    const cancel = [...dialog.querySelectorAll('button')].find((b) => /Cancel/.test(b.textContent));
    cancel.click();
    expect(await pending).toBeNull();
    // The same file again leaves the video where it is.
    setVideoOfDoc(audio, first);
    expect(await insertVideoHook(null, doc, state, [{ doc: audio, clip }])).toBeNull();
  });

  it('removes, moves and locks the video through commands, and shows it in Properties', () => {
    const { app, doc } = setup();
    const sourceId = linkVideo(doc, { blob: new Blob([new Uint8Array(1)]), name: 'One.mp4', width: 1920, height: 1080, duration: 8, fps: 29.97 });
    doc.apply('Insert File', V.setVideoClip(doc.state, { sourceId, name: 'One', start: 300, length: 8000 }));
    doc.setCursor(1200);
    app.commands.run('video.toPlayhead');
    expect(V.videoClip(doc.state).start).toBe(1200);
    app.commands.run('video.lock');
    expect(V.videoClip(doc.state).locked).toBe(true);
    expect(app.commands.isEnabled('video.toStart')).toBe(false);
    const section = videoPropertySection(app, doc);
    expect(section.textContent).toMatch(/1920 × 1080/);
    expect(section.textContent).toMatch(/29\.97 fps/);
    app.commands.run('video.remove');
    expect(V.videoClip(doc.state)).toBeNull();
    expect(videoPropertySection(app, doc)).toBeNull();
    expect(app.commands.isEnabled('video.remove')).toBe(false);
    doc.history.undo();
    expect(V.videoClip(doc.state)).not.toBeNull();
  });

  it('sets the Video Display scaling and lists the panel, menus and workspace', () => {
    const { app } = setup();
    app.dock = { isOpen: () => true, isVisible: () => true, openPanel() {}, closePanel() {} };
    app.commands.run('view.video50');
    expect(app.prefs.get('videoZoom')).toBe('50');
    expect(app.commands.isChecked('view.video50')).toBe(true);
    expect(app.commands.isChecked('view.videoFit')).toBe(false);
    expect(app.panels.has('video')).toBe(true);
    const paths = commandMenuPaths(MENUS);
    expect(paths.get('view.videoFit')).toEqual(['Video Display']);
    expect(paths.get('window.video')).toEqual([]);
    const ids = JSON.stringify(WORKSPACES['Edit Audio to Video']());
    for (const id of ['editor', 'video', 'files', 'levels', 'properties']) expect(ids).toContain(`"${id}"`);
  });

  it('shows the video lane above the tracks only when the session has a video', () => {
    const { app, doc } = setup();
    const view = app.documentKinds.get('session').view(app, doc);
    document.body.replaceChildren(view.el);
    view.width = 800;
    view.height = 400;
    const lane = view.el.querySelector('.mt-video-row');
    expect(lane.hidden).toBe(true);
    const sourceId = linkVideo(doc, { blob: new Blob([new Uint8Array(1)]), name: 'One.mp4', width: 2, height: 2, duration: 8 });
    doc.apply('Insert File', V.setVideoClip(doc.state, { sourceId, name: 'One', start: 0, length: 8000 }));
    view.videoLane.frame();
    expect(lane.hidden).toBe(false);
    expect(view.el.classList.contains('has-video')).toBe(true);
    expect(lane.nextElementSibling.classList.contains('mt-main')).toBe(true);
    doc.history.undo();
    view.videoLane.frame();
    expect(lane.hidden).toBe(true);
    view.destroy();
  });
});

function concat(parts) {
  const n = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
