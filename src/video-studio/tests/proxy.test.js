import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { normalizeAsset, normalizeProject, createProject, makeClip } from '../src/model/project.js';
import { mainTrack } from '../src/model/timeline.js';
import {
  proxyMode, normalizeProxyMode, canProxy, bitrateOf, heavyReason, proxyWorthwhile, wantsProxy, previewSource, proxyPlan,
  proxyFileName, parseProxyName, isCurrentProxy, durationTolerance, PROXY_VERSION, PROXY_SHORT, PROXY_KEYFRAME,
} from '../src/model/proxy.js';
import { generateProxy, checkProxy, proxySize, pickCodec } from '../src/media/proxy.js';
import { ProxyManager } from '../src/media/proxy-manager.js';
import { memoryBackend } from '../src/storage/backends.js';
import { Library } from '../src/storage/library.js';
import { exportProjectBundle } from '../src/storage/bundle.js';
import { readZip } from '../src/storage/zip.js';
import { s } from './helpers.js';

/** A video asset; 4K, 10 s, 50 MB unless overridden. */
const vid = (id, fields = {}) => normalizeAsset({ id, kind: 'video', name: `${id}.mp4`, hash: `h${id}`, ext: 'mp4', width: 3840, height: 2160, duration: s(10), fps: 30, size: 50e6, hasAudio: true, ...fields });
const flush = async (n = 4) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
};

describe('proxy rules', () => {
  it('reads and stores the project mode, auto by default', () => {
    const p = createProject();
    expect(proxyMode(p)).toBe('auto');
    expect(normalizeProxyMode('auto')).toBeUndefined();
    expect(normalizeProject({ ...p, settings: { ...p.settings, proxy: 'on' } }).settings.proxy).toBe('on');
    expect(normalizeProject({ ...p, settings: { ...p.settings, proxy: 'off' } }).settings.proxy).toBe('off');
    expect(normalizeProject({ ...p, settings: { ...p.settings, proxy: 'bogus' } }).settings).not.toHaveProperty('proxy');
    expect(proxyMode({ settings: { proxy: 'bogus' } })).toBe('auto');
  });

  it('only proxies stored videos with a picture', () => {
    expect(canProxy(vid('a'))).toBe(true);
    expect(canProxy(vid('a', { hash: '' }))).toBe(false);
    expect(canProxy(vid('a', { hasVideo: false }))).toBe(false);
    expect(canProxy(normalizeAsset({ id: 'i', kind: 'image', hash: 'x' }))).toBe(false);
    expect(canProxy(normalizeAsset({ id: 'm', kind: 'audio', hash: 'x' }))).toBe(false);
  });

  it('calls 4K, very high bitrate and high frame rate media heavy', () => {
    expect(bitrateOf(vid('a', { size: 10e6, duration: s(8) }))).toBe(10e6);
    expect(heavyReason(vid('a'))).toBe('4k');
    expect(heavyReason(vid('a', { width: 2160, height: 3840 }))).toBe('4k');
    expect(heavyReason(vid('a', { width: 4096, height: 2160 }))).toBe('4k');
    const hd = { width: 1920, height: 1080, size: 20e6 }; // 16 Mbit/s
    expect(heavyReason(vid('a', hd))).toBeNull();
    expect(heavyReason(vid('a', { ...hd, size: 40e6 }))).toBe('bitrate');
    expect(heavyReason(vid('a', { width: 2560, height: 1440, size: 20e6, fps: 60 }))).toBe('fps');
    expect(heavyReason(vid('a', { ...hd, fps: 60 }))).toBeNull();
  });

  it('picks what each mode makes proxies for', () => {
    const big = vid('big');
    const hd = vid('hd', { width: 1920, height: 1080, size: 20e6 });
    const small = vid('small', { width: 1280, height: 720, size: 5e6 });
    expect(proxyWorthwhile(hd)).toBe(true);
    expect(proxyWorthwhile(small)).toBe(false);
    expect(proxyWorthwhile(vid('dense', { width: 1280, height: 720, size: 20e6 }))).toBe(true);
    expect([big, hd, small].map((a) => wantsProxy(a, 'auto'))).toEqual([true, false, false]);
    expect([big, hd, small].map((a) => wantsProxy(a, 'on'))).toEqual([true, true, false]);
    expect([big, hd, small].map((a) => wantsProxy(a, 'off'))).toEqual([false, false, false]);
    // Media that decoded slowly on this device gets one in auto too, but never when off.
    expect(wantsProxy(hd, 'auto', { slow: true })).toBe(true);
    expect(wantsProxy(small, 'on', { slow: true })).toBe(true);
    expect(wantsProxy(hd, 'off', { slow: true })).toBe(false);
  });

  it('uses the proxy only when it is ready, proxies are not off and the original is not being compared', () => {
    expect(previewSource({ mode: 'auto', state: 'ready' })).toBe('proxy');
    expect(previewSource({ mode: 'on', state: 'ready' })).toBe('proxy');
    expect(previewSource({ mode: 'off', state: 'ready' })).toBe('original');
    expect(previewSource({ mode: 'on', state: 'generating' })).toBe('original');
    expect(previewSource({ mode: 'on', state: 'none' })).toBe('original');
    expect(previewSource({ mode: 'on', state: 'ready', original: true })).toBe('original');
  });

  it('plans a 720p proxy keeping the shape and the timing', () => {
    const p = proxyPlan(vid('a'));
    expect(p).toMatchObject({ width: 1280, height: 720, shortSide: PROXY_SHORT, keyFrameInterval: PROXY_KEYFRAME, duration: 10, fps: 30, hasAudio: true });
    expect(p.bitrate).toBeGreaterThanOrEqual(1e6);
    expect(p.bitrate).toBeLessThanOrEqual(5e6);
    expect(proxyPlan(vid('a', { width: 2160, height: 3840 }))).toMatchObject({ width: 720, height: 1280 });
    expect(proxyPlan(vid('a', { width: 1280, height: 720 }))).toMatchObject({ width: 1280, height: 720 });
    expect(proxyPlan(vid('a', { width: 4096, height: 2160 }))).toMatchObject({ width: 1366, height: 720 });
    expect(proxyPlan(vid('a', { width: 0, height: 0 })).height).toBe(PROXY_SHORT);
    expect(durationTolerance({ fps: 30 })).toBeCloseTo(0.1, 5);
  });

  it('names proxy files by content hash and format, and spots stale ones', () => {
    const name = proxyFileName('abc_1-2', 'mp4');
    expect(name).toBe(`abc_1-2.v${PROXY_VERSION}.${PROXY_SHORT}.mp4`);
    expect(parseProxyName(name)).toEqual({ hash: 'abc_1-2', version: PROXY_VERSION, short: PROXY_SHORT, ext: 'mp4' });
    expect(isCurrentProxy(name)).toBe(true);
    expect(isCurrentProxy(proxyFileName('abc', 'webm'))).toBe(true);
    expect(isCurrentProxy(proxyFileName('abc', 'mp4', { version: PROXY_VERSION - 1 || 99 }))).toBe(false);
    expect(isCurrentProxy(proxyFileName('abc', 'mp4', { short: 540 }))).toBe(false);
    expect(isCurrentProxy(`${name}.part`)).toBe(false);
    expect(parseProxyName('../evil.mp4')).toBeNull();
  });
});

/* Encoding with stand-in Mediabunny pieces ---------------------------------- */

function fakeMb({ codecs = ['avc', 'vp9'], dw = 3840, dh = 2160, audio = true, keepAudio = true, duration = 10, canDecode = true, valid = true } = {}) {
  const calls = { disposed: 0 };
  class Input {
    async getPrimaryVideoTrack() {
      return { canDecode: async () => canDecode, getDisplayWidth: async () => dw, getDisplayHeight: async () => dh };
    }
    async getPrimaryAudioTrack() {
      return audio ? { type: 'audio' } : null;
    }
    async computeDuration() {
      return duration;
    }
    dispose() {
      calls.disposed++;
    }
  }
  class BlobSource {}
  class BufferTarget {
    buffer = new Uint8Array([1, 2, 3, 4]).buffer;
  }
  class StreamTarget {
    constructor(writable, opts) {
      calls.stream = { writable, opts };
    }
  }
  class Mp4OutputFormat {
    kind = 'mp4';
  }
  class WebMOutputFormat {
    kind = 'webm';
  }
  class Output {
    constructor(o) {
      calls.output = o;
    }
  }
  const Conversion = {
    async init(opts) {
      calls.options = opts;
      const conv = {
        isValid: valid,
        utilizedTracks: [{ type: 'video' }, ...(audio && keepAudio && !opts.audio.discard ? [{ type: 'audio' }] : [])],
        async execute() {
          conv.onProgress?.(0.5, 5);
          if (calls.hold) await calls.hold;
          conv.onProgress?.(1, 10);
        },
        async cancel() {
          calls.canceled = true;
        },
      };
      return conv;
    },
  };
  const mb = { Input, BlobSource, ALL_FORMATS: [], BufferTarget, StreamTarget, Mp4OutputFormat, WebMOutputFormat, Output, Conversion, getFirstEncodableVideoCodec: async (list) => list.find((c) => codecs.includes(c)) || null };
  return { mb, calls };
}

describe('proxy encoding', () => {
  const plan = proxyPlan(vid('a'));

  it('sizes by the short side without enlarging', () => {
    expect(proxySize(3840, 2160, 720)).toEqual({ width: 1280, height: 720, scaled: true });
    expect(proxySize(1080, 1920, 720)).toEqual({ width: 720, height: 1280, scaled: true });
    expect(proxySize(640, 360, 720)).toEqual({ width: 640, height: 360, scaled: false });
  });

  it('prefers H.264 in MP4 and falls back to VP9 in WebM', async () => {
    expect(await pickCodec(fakeMb().mb, { width: 1280, height: 720 })).toEqual({ codec: 'avc', ext: 'mp4' });
    expect(await pickCodec(fakeMb({ codecs: ['vp9'] }).mb, { width: 1280, height: 720 })).toEqual({ codec: 'vp9', ext: 'webm' });
    expect(await pickCodec(fakeMb({ codecs: [] }).mb, {})).toBeNull();
  });

  it('keeps timestamps, bakes rotation, scales the short side and keeps the sound', async () => {
    const { mb, calls } = fakeMb();
    const progress = [];
    const out = await generateProxy({ blob: new Blob(['x']), plan, mb, onProgress: (p) => progress.push(p) });
    expect(out).toMatchObject({ ext: 'mp4', codec: 'avc', width: 1280, height: 720 });
    expect(out.blob.type).toBe('video/mp4');
    expect(calls.output.format.kind).toBe('mp4');
    const o = calls.options;
    expect(o.trim).toEqual({ start: 0 });
    expect(o.video).toMatchObject({ height: 720, codec: 'avc', keyFrameInterval: PROXY_KEYFRAME, forceTranscode: true, allowTransformationMetadata: false, bitrate: plan.bitrate });
    expect(o.video).not.toHaveProperty('width');
    expect(o.video).not.toHaveProperty('frameRate');
    expect(o.audio).toEqual({});
    expect(progress).toEqual([0.5, 1]);
    expect(calls.disposed).toBe(1);
  });

  it('gives the width for portrait video and drops sound when there is none', async () => {
    const { mb, calls } = fakeMb({ dw: 2160, dh: 3840, audio: false, codecs: ['vp9'] });
    const out = await generateProxy({ blob: new Blob(['x']), plan: { ...plan, hasAudio: false }, mb });
    expect(out).toMatchObject({ ext: 'webm', width: 720, height: 1280 });
    expect(calls.options.video.width).toBe(720);
    expect(calls.options.video).not.toHaveProperty('height');
    expect(calls.options.audio).toEqual({ discard: true });
  });

  it('streams into a file when one is opened for the container', async () => {
    const { mb, calls } = fakeMb();
    const writable = {};
    const open = vi.fn(async () => writable);
    const out = await generateProxy({ blob: new Blob(['x']), plan, mb, open });
    expect(open).toHaveBeenCalledWith('mp4');
    expect(calls.stream.writable).toBe(writable);
    expect(out.blob).toBeUndefined();
  });

  it('fails clearly when it cannot decode, encode or keep the sound', async () => {
    await expect(generateProxy({ blob: new Blob(['x']), plan, mb: fakeMb({ canDecode: false }).mb })).rejects.toMatchObject({ code: 'decode' });
    await expect(generateProxy({ blob: new Blob(['x']), plan, mb: fakeMb({ codecs: [] }).mb })).rejects.toMatchObject({ code: 'encode' });
    await expect(generateProxy({ blob: new Blob(['x']), plan, mb: fakeMb({ keepAudio: false }).mb })).rejects.toMatchObject({ code: 'audio' });
    await expect(generateProxy({ blob: new Blob(['x']), plan, mb: fakeMb({ valid: false }).mb })).rejects.toMatchObject({ code: 'invalid' });
  });

  it('cancels the conversion when aborted', async () => {
    const { mb, calls } = fakeMb();
    let release;
    calls.hold = new Promise((r) => (release = r));
    const ctrl = new AbortController();
    const run = generateProxy({ blob: new Blob(['x']), plan, mb, signal: ctrl.signal });
    await flush();
    ctrl.abort();
    release();
    await expect(run).rejects.toMatchObject({ code: 'canceled' });
    expect(calls.canceled).toBe(true);
  });

  it('rejects a proxy whose length differs from the original', async () => {
    expect(await checkProxy(fakeMb({ duration: 10.03 }).mb, new Blob(['x']), plan, durationTolerance(plan))).toBe(10.03);
    await expect(checkProxy(fakeMb({ duration: 9.5 }).mb, new Blob(['x']), plan, durationTolerance(plan))).rejects.toMatchObject({ code: 'duration' });
  });
});

/* The manager ------------------------------------------------------------------ */

/** A stand-in encoder: each call waits until the test finishes or fails it. */
function fakeGenerate() {
  const jobs = [];
  const gen = vi.fn(({ base, signal, onProgress, blob }) => new Promise((resolve, reject) => {
    const job = {
      base,
      blob,
      signal,
      onProgress,
      done: (size = 10) => resolve({ name: `${base}.mp4`, size, blob: new Blob([new Uint8Array(size)]) }),
      fail: (msg) => reject(new Error(msg)),
    };
    signal.addEventListener('abort', () => reject(Object.assign(new Error('Canceled'), { code: 'canceled' })));
    jobs.push(job);
  }));
  gen.jobs = jobs;
  return gen;
}

function managerSetup({ seed = {}, memory } = {}) {
  const cache = memoryBackend(seed);
  const generate = fakeGenerate();
  const library = { mediaBlob: vi.fn(async (a) => new Blob([`original ${a.id}`])) };
  const proxies = new ProxyManager({ library, cache, generate, memory });
  return { cache, generate, library, proxies };
}

function projectWith(...assets) {
  const p = createProject();
  for (const a of assets) p.assets[a.id] = a;
  return p;
}

describe('proxy manager', () => {
  it('makes proxies one at a time for what the mode asks for', async () => {
    const { proxies, generate, cache, library } = managerSetup();
    await proxies.init();
    const big = vid('big');
    const big2 = vid('big2');
    const hd = vid('hd', { width: 1920, height: 1080, size: 10e6 });
    const events = [];
    proxies.on('change', (e) => events.push(e));
    proxies.sync(projectWith(big, big2, hd));
    await flush();
    expect(generate).toHaveBeenCalledTimes(1);
    expect(proxies.status(big).state).toBe('generating');
    expect(proxies.status(big2).state).toBe('queued');
    expect(proxies.status(hd).state).toBe('none');
    // It encodes from the original file.
    expect(library.mediaBlob).toHaveBeenCalledWith(big);
    generate.jobs[0].onProgress(0.4);
    expect(proxies.status(big).progress).toBe(0.4);
    generate.jobs[0].done(42);
    await flush();
    expect(proxies.status(big)).toMatchObject({ state: 'ready', size: 42 });
    expect(proxies.isReady(big)).toBe(true);
    const name = proxyFileName(big.hash, 'mp4');
    expect(cache.files.has(`proxies/${name}`)).toBe(true);
    expect((await proxies.blob(big)).size).toBe(42);
    expect(generate).toHaveBeenCalledTimes(2);
    expect(events.some((e) => e.hash === big.hash)).toBe(true);
  });

  it('stops work for media removed from the project or no longer wanted', async () => {
    const { proxies, generate } = managerSetup();
    await proxies.init();
    const a = vid('a');
    const b = vid('b');
    const p = projectWith(a, b);
    proxies.sync(p);
    await flush();
    const first = generate.jobs[0];
    delete p.assets.a;
    proxies.sync(p);
    await flush();
    expect(first.signal.aborted).toBe(true);
    expect(proxies.status(a).state).toBe('none');
    // The next one starts.
    expect(proxies.status(b).state).toBe('generating');
    // Turning proxies off stops automatic work...
    p.settings.proxy = 'off';
    proxies.sync(p);
    await flush();
    expect(generate.jobs[1].signal.aborted).toBe(true);
    expect(proxies.status(b).state).toBe('none');
    // ...but not proxies asked for by hand.
    proxies.create(b);
    await flush();
    proxies.sync(p);
    expect(proxies.status(b).state).toBe('generating');
    expect(generate.jobs[2].signal.aborted).toBe(false);
  });

  it('remembers deleted proxies so auto does not make them again', async () => {
    const memory = { value: null, get() { return this.value; }, set(v) { this.value = v; } };
    const { proxies, generate, cache } = managerSetup({ memory });
    await proxies.init();
    const a = vid('a');
    const p = projectWith(a);
    proxies.sync(p);
    await flush();
    generate.jobs[0].done();
    await flush();
    await proxies.remove(a);
    expect(proxies.status(a).state).toBe('none');
    expect([...cache.files.keys()].filter((k) => k.startsWith('proxies/'))).toEqual([]);
    expect(memory.value.skip).toEqual([a.hash]);
    proxies.sync(p);
    await flush();
    expect(generate).toHaveBeenCalledTimes(1);
    // A new manager (next session) still skips it; asking by hand makes it again.
    const again = new ProxyManager({ library: { mediaBlob: async () => new Blob(['x']) }, cache, generate, memory });
    await again.init();
    again.sync(p);
    await flush();
    expect(generate).toHaveBeenCalledTimes(1);
    again.create(a);
    await flush();
    expect(generate).toHaveBeenCalledTimes(2);
    expect(memory.value.skip).toEqual([]);
  });

  it('keeps a failure until asked again', async () => {
    const { proxies, generate } = managerSetup();
    await proxies.init();
    const a = vid('a');
    const p = projectWith(a);
    proxies.sync(p);
    await flush();
    generate.jobs[0].fail('Encoder crashed');
    await flush();
    expect(proxies.status(a)).toMatchObject({ state: 'error', error: 'Encoder crashed' });
    proxies.sync(p);
    await flush();
    expect(generate).toHaveBeenCalledTimes(1);
    proxies.create(a);
    await flush();
    expect(proxies.status(a).state).toBe('generating');
  });

  it('finds proxies already on the device and clears stale and partial files', async () => {
    const a = vid('a');
    const current = `proxies/${proxyFileName(a.hash, 'mp4')}`;
    const stale = `proxies/${proxyFileName('hold', 'mp4', { version: PROXY_VERSION + 1 })}`;
    const part = `proxies/${proxyFileName('hpart', 'mp4')}.part`;
    const { proxies, cache, generate } = managerSetup({ seed: { [current]: new Blob(['p']), [stale]: new Blob(['s']), [part]: new Blob(['x']) } });
    await proxies.init();
    expect(proxies.isReady(a)).toBe(true);
    expect(cache.files.has(stale)).toBe(false);
    expect(cache.files.has(part)).toBe(false);
    proxies.sync(projectWith(a));
    await flush();
    expect(generate).not.toHaveBeenCalled();
    expect(await proxies.usage()).toMatchObject({ files: 1 });
  });

  it('keys proxies by content: a replaced file gets its own proxy', async () => {
    const { proxies, generate } = managerSetup();
    await proxies.init();
    const a = vid('a');
    const p = projectWith(a);
    proxies.sync(p);
    await flush();
    generate.jobs[0].done();
    await flush();
    p.assets.a = { ...a, hash: 'hnewcontent' };
    expect(proxies.isReady(p.assets.a)).toBe(false);
    proxies.sync(p);
    await flush();
    expect(generate.jobs[1].base).toContain('hnewcontent');
  });

  it('deletes every proxy and does not remake them this session', async () => {
    const { proxies, generate, cache } = managerSetup();
    await proxies.init();
    const a = vid('a');
    const b = vid('b');
    const p = projectWith(a, b);
    proxies.sync(p);
    await flush();
    generate.jobs[0].done();
    await flush();
    expect(proxies.status(b).state).toBe('generating');
    const n = await proxies.removeAll();
    expect(n).toBe(1);
    expect(generate.jobs[1].signal.aborted).toBe(true);
    expect([...cache.files.keys()].some((k) => k.startsWith('proxies/'))).toBe(false);
    proxies.sync(p);
    await flush();
    expect(generate).toHaveBeenCalledTimes(2);
    expect(await proxies.usage()).toEqual({ files: 0, bytes: 0 });
  });

  it('makes a proxy in auto for media the preview found slow', async () => {
    const memory = { value: null, get() { return this.value; }, set(v) { this.value = v; } };
    const { proxies, generate } = managerSetup({ memory });
    await proxies.init();
    const hd = vid('hd', { width: 1920, height: 1080, size: 10e6 });
    const p = projectWith(hd);
    proxies.sync(p);
    await flush();
    expect(generate).not.toHaveBeenCalled();
    expect(proxies.markSlow(hd)).toBe(true);
    expect(proxies.markSlow(hd)).toBe(false);
    expect(memory.value.slow).toEqual([hd.hash]);
    proxies.sync(p);
    await flush();
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('stops everything when closed', async () => {
    const { proxies, generate } = managerSetup();
    await proxies.init();
    proxies.sync(projectWith(vid('a'), vid('b')));
    await flush();
    proxies.dispose();
    await flush();
    expect(generate.jobs[0].signal.aborted).toBe(true);
    expect(generate).toHaveBeenCalledTimes(1);
  });
});

/* Export and project files never see proxies ------------------------------------- */

describe('proxies stay out of exports', () => {
  it('leaves the library, project files and the original media untouched', async () => {
    const backend = memoryBackend();
    const lib = new Library(backend);
    const original = new Blob([new Uint8Array([1, 2, 3, 4, 5])], { type: 'video/mp4' });
    const asset = await lib.addMediaBlob({ kind: 'video', name: 'big.mp4', ext: 'mp4', mime: 'video/mp4', duration: s(4), width: 3840, height: 2160, hasAudio: true }, original);
    const project = createProject({ name: 'Heavy' });
    project.assets[asset.id] = asset;
    mainTrack(project).clips.push(makeClip('video', { assetId: asset.id, start: 0, duration: s(4) }));
    await lib.saveProject(project);

    const cache = memoryBackend();
    const generate = fakeGenerate();
    const proxies = new ProxyManager({ library: lib, cache, generate });
    await proxies.init();
    proxies.sync(project);
    await flush();
    generate.jobs[0].done(3);
    await flush();
    expect(proxies.isReady(asset)).toBe(true);

    // The library still hands out the original file (exports and tools read from it).
    expect(await lib.mediaBlob(asset)).toBe(original);
    expect([...backend.files.keys()].some((k) => k.includes('proxies'))).toBe(false);
    const { blob } = await exportProjectBundle(lib, project.id);
    const names = (await readZip(blob)).map((e) => e.name);
    expect(names).toContain(`media/${asset.hash}.mp4`);
    expect(names.some((n) => n.includes('prox'))).toBe(false);
  });

  it('export and project file code never reach for proxies', () => {
    for (const file of ['src/engine/exporter.js', 'src/storage/bundle.js', 'src/storage/library.js', 'src/ui/export-dialog.js']) {
      const src = readFileSync(resolve(__dirname, '..', file), 'utf8');
      expect(src, file).not.toMatch(/prox/i);
    }
  });
});
