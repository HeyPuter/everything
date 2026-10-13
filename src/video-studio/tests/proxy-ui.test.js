import { describe, it, expect, vi, afterEach } from 'vitest';
import { EditorStore } from '../src/model/store.js';
import { createProject, normalizeAsset, makeClip } from '../src/model/project.js';
import { mainTrack } from '../src/model/timeline.js';
import { createActions } from '../src/ui/actions.js';
import { createInspector } from '../src/ui/inspector/index.js';
import { proxySummary } from '../src/ui/inspector/project.js';
import { mediaTab, proxyBadgeState } from '../src/ui/panels/media.js';
import { openPreferences } from '../src/ui/preferences-dialog.js';
import { ProxyManager } from '../src/media/proxy-manager.js';
import { memoryBackend } from '../src/storage/backends.js';
import { proxyFileName } from '../src/model/proxy.js';
import { Player } from '../src/engine/player.js';
import { s } from './helpers.js';

// jsdom has no media playback; the player pauses and unloads elements when it closes.
HTMLMediaElement.prototype.pause = function pause() {};
HTMLMediaElement.prototype.load = function load() {};

const vid = (id, fields = {}) => normalizeAsset({ id, kind: 'video', name: `${id}.mp4`, hash: `h${id}`, ext: 'mp4', width: 3840, height: 2160, duration: s(10), fps: 30, size: 50e6, hasAudio: true, ...fields });
const flush = async (n = 4) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
};

/** A project with a 4K video (proxy ready), an HD video and a photo, and a manager that never finishes encoding. */
async function setup({ ready = true } = {}) {
  const p = createProject();
  const big = vid('big');
  const hd = vid('hd', { width: 1920, height: 1080, size: 10e6 });
  p.assets.big = big;
  p.assets.hd = hd;
  p.assets.img = normalizeAsset({ id: 'img', kind: 'image', name: 'pic.png', hash: 'himg', width: 800, height: 600 });
  mainTrack(p).clips.push(makeClip('video', { assetId: 'big', start: 0, duration: s(5) }));
  const seed = ready ? { [`proxies/${proxyFileName(big.hash, 'mp4')}`]: new Blob(['proxy']) } : {};
  const generate = vi.fn(({ signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('Canceled'), { code: 'canceled' })))));
  const library = { backend: { kind: 'memory' }, mediaBlob: vi.fn(async () => new Blob(['original'])), mediaURL: vi.fn(async () => 'blob:original') };
  // The memory backend lists no sizes; report them like OPFS does.
  const cache = memoryBackend(seed);
  const list = cache.list;
  cache.list = async (dir) => (await list(dir)).map((f) => ({ ...f, size: cache.files.get(`${dir}/${f.name}`)?.size || 0 }));
  const proxies = new ProxyManager({ library, cache, generate });
  await proxies.init();
  const store = new EditorStore(p);
  const ctx = { store, library, proxies, player: null, media: { poster: () => Promise.resolve(null) } };
  ctx.actions = createActions(ctx);
  return { ctx, store, proxies, generate, library, big, hd };
}

let cleanup = [];
afterEach(() => {
  cleanup.forEach((f) => f());
  cleanup = [];
  document.body.replaceChildren();
});

describe('proxy setting in the project details', () => {
  it('switches the mode as one undoable step and explains it', async () => {
    const { ctx, store, proxies } = await setup();
    const insp = createInspector(ctx);
    cleanup.push(insp.dispose);
    document.body.append(insp.el);
    const group = insp.el.querySelector('.proxy-mode');
    expect(group.getAttribute('aria-label')).toBe('Proxy media');
    const radio = (label) => [...group.querySelectorAll('[role=radio]')].find((b) => b.textContent === label);
    expect(radio('Auto').getAttribute('aria-checked')).toBe('true');
    expect(insp.el.querySelector('.proxy-status').textContent).toBe('Proxies: 1 ready (5 B).');
    expect(insp.el.textContent).toMatch(/exports always use the original files/);

    radio('Off').click();
    expect(store.project.settings.proxy).toBe('off');
    expect(insp.el.textContent).toMatch(/always plays the original files/);
    radio('On').click();
    expect(store.project.settings.proxy).toBe('on');
    radio('Auto').click();
    expect(store.project.settings).not.toHaveProperty('proxy');
    store.undo();
    expect(store.project.settings.proxy).toBe('on');
    expect(radio('On').getAttribute('aria-checked')).toBe('true');

    // Progress shows as it changes.
    proxies.create(store.project.assets.hd);
    await flush();
    expect(insp.el.querySelector('.proxy-status').textContent).toBe('Proxies: 1 ready (5 B), 1 being made (0%).');
  });

  it('summarizes each file once', async () => {
    const { store, proxies } = await setup({ ready: false });
    expect(proxySummary(store.project, proxies)).toBe('No proxies yet.');
    expect(proxySummary(createProject(), proxies)).toBe('No videos in this project.');
    expect(proxySummary(store.project, null)).toBe('');
  });
});

describe('proxy status in the media panel', () => {
  it('describes each state', async () => {
    const { proxies, big, hd } = await setup();
    expect(proxyBadgeState(big, proxies)).toMatchObject({ state: 'ready', text: 'Proxy', label: 'Plays from a proxy in the preview (4K or larger)' });
    expect(proxyBadgeState(big, proxies, 'off').label).toMatch(/not used/);
    expect(proxyBadgeState(hd, proxies).state).toBe('none');
    expect(proxyBadgeState(normalizeAsset({ id: 'i', kind: 'image', hash: 'x' }), proxies).state).toBe('none');
    proxies.create(hd);
    expect(proxyBadgeState(hd, proxies)).toMatchObject({ state: 'queued', label: 'Waiting to make a proxy' });
    await flush();
    proxies.entries.get(hd.hash).progress = 0.42;
    expect(proxyBadgeState(hd, proxies)).toMatchObject({ state: 'generating', text: 'Proxy 42%', progress: 0.42 });
    proxies.entries.get(hd.hash).state = 'error';
    proxies.entries.get(hd.hash).error = 'No encoder';
    expect(proxyBadgeState(hd, proxies).label).toBe('Proxy failed: No encoder');
  });

  it('shows badges, updates them live and offers create, stop and delete', async () => {
    const { ctx, proxies, generate } = await setup();
    const tab = mediaTab(ctx);
    cleanup.push(tab.dispose);
    document.body.append(tab.el);
    tab.el.querySelector('[data-cat="project"]').click();
    const badge = (id) => tab.el.querySelector(`[data-proxy-asset="${id}"]`);
    expect(badge('big').dataset.state).toBe('ready');
    expect(badge('big').hidden).toBe(false);
    expect(badge('big').closest('[data-asset]').getAttribute('aria-description')).toMatch(/proxy/);
    expect(badge('hd').hidden).toBe(true);
    expect(badge('img')).toBeNull();

    const menuFor = (id) => {
      const t = tab.el.querySelector(`.tile[data-asset="${id}"]`);
      t.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
      const items = [...document.querySelectorAll('[role=menuitem]')];
      return { labels: items.map((x) => x.textContent.trim()), pick: (label) => items.find((x) => x.textContent.trim() === label).click() };
    };
    let m = menuFor('hd');
    expect(m.labels).toContain('Create proxy');
    m.pick('Create proxy');
    await flush();
    expect(generate).toHaveBeenCalledTimes(1);
    expect(badge('hd').dataset.state).toBe('generating');
    expect(badge('hd').textContent).toBe('Proxy 0%');

    m = menuFor('hd');
    expect(m.labels).toContain('Stop making proxy');
    m.pick('Stop making proxy');
    await flush();
    expect(badge('hd').hidden).toBe(true);

    m = menuFor('big');
    expect(m.labels).toContain('Delete proxy');
    m.pick('Delete proxy');
    await flush();
    expect(proxies.isReady(ctx.store.project.assets.big)).toBe(false);
    expect(badge('big').hidden).toBe(true);
    expect(menuFor('img').labels.some((l) => /proxy/i.test(l))).toBe(false);
  });

  it('cancels a proxy being made when its media is deleted', async () => {
    const { ctx, store, proxies, generate } = await setup({ ready: false });
    proxies.sync(store.project);
    await flush();
    const { signal } = generate.mock.calls[0][0];
    // The editor syncs on every change; do the same here.
    store.on('change', () => proxies.sync(store.project));
    ctx.actions.removeAsset('big');
    await flush();
    expect(signal.aborted).toBe(true);
    expect(proxies.status(vid('big')).state).toBe('none');
  });
});

describe('proxy storage in preferences', () => {
  it('shows the space used and deletes every proxy', async () => {
    const { ctx, proxies } = await setup();
    const d = openPreferences(ctx);
    await flush();
    const usage = d.el.querySelector('.proxy-usage');
    expect(usage.textContent).toBe('1 proxy, 5 B');
    const del = [...d.el.querySelectorAll('button')].find((b) => b.textContent === 'Delete all proxies');
    expect(del.disabled).toBe(false);
    del.click();
    await flush();
    const confirm = [...document.querySelectorAll('dialog button')].find((b) => b.textContent === 'Delete');
    confirm.click();
    await flush(8);
    expect(proxies.isReady(ctx.store.project.assets.big)).toBe(false);
    expect(usage.textContent).toBe('No proxies on this device.');
    expect(del.disabled).toBe(true);
    d.close();
  });

  it('has no proxy row without a proxy manager', () => {
    const store = new EditorStore(createProject());
    const d = openPreferences({ store });
    expect(d.el.querySelector('.proxy-usage')).toBeNull();
    d.close();
  });
});

describe('preview source', () => {
  async function playerSetup(opts) {
    const env = await setup(opts);
    env.proxies.url = vi.fn(async () => 'blob:proxy');
    const player = new Player({ store: env.store, library: env.library, canvas: document.createElement('canvas'), proxies: env.proxies });
    cleanup.push(() => player.dispose());
    return { ...env, player };
  }

  it('plays the proxy when it is ready and proxies are on', async () => {
    const { player, store, big, hd } = await playerSetup();
    const src = player.previewAsset(big);
    expect(src.proxyOf).toBe(big);
    expect(src.id).not.toBe(big.id);
    // Laid out at the original size, with the original timing.
    expect([src.width, src.height, src.duration]).toEqual([big.width, big.height, big.duration]);
    expect(player.previewAsset(big)).toBe(src);
    expect(player.previewAsset(hd)).toBe(hd);
    store.update('Off', (p) => {
      p.settings.proxy = 'off';
    }, { structural: false });
    expect(player.previewAsset(big)).toBe(big);
  });

  it('compares with the original and switches media elements', async () => {
    const { player, store, big, library, proxies } = await playerSetup();
    const clip = mainTrack(store.project).clips[0];
    const onProxy = player.pool.claim(clip, player.previewAsset(big), 'video', 1);
    await flush();
    expect(proxies.url).toHaveBeenCalledWith(big);
    expect(onProxy.el.getAttribute('src')).toBe('blob:proxy');
    const seen = [];
    player.on('proxy', (e) => seen.push(e.original));
    player.setShowOriginal(true);
    expect(seen).toEqual([true]);
    player.pool.beginFrame();
    const onOriginal = player.pool.claim(clip, player.previewAsset(big), 'video', 1);
    await flush();
    expect(onOriginal).not.toBe(onProxy);
    expect(library.mediaURL).toHaveBeenCalledWith(big);
    expect(onOriginal.el.getAttribute('src')).toBe('blob:original');
    player.setShowOriginal(false);
    expect(player.previewAsset(big).proxyOf).toBe(big);
  });

  it('keeps the choice steady while playing', async () => {
    const { player, big, proxies, hd } = await playerSetup({ ready: false });
    player.playing = true;
    expect(player.previewAsset(big)).toBe(big);
    proxies.entries.set(big.hash, { state: 'ready', name: proxyFileName(big.hash, 'mp4'), size: 1 });
    expect(player.previewAsset(big)).toBe(big);
    player.playing = false;
    expect(player.previewAsset(big).proxyOf).toBe(big);
    expect(player.previewAsset(hd)).toBe(hd);
  });

  it('reports media that keeps missing frames while playing', async () => {
    const { player, proxies, hd } = await playerSetup();
    const mark = vi.spyOn(proxies, 'markSlow');
    player.clockStart = performance.now() - 5000;
    for (let i = 0; i < 119; i++) player._noteDecode(hd, i % 2 === 0);
    expect(mark).not.toHaveBeenCalled();
    player._noteDecode(hd, true);
    expect(mark).toHaveBeenCalledWith(hd);
    // A healthy file is never reported.
    const ok = vid('ok', { width: 1920, height: 1080 });
    for (let i = 0; i < 300; i++) player._noteDecode(ok, i % 10 === 0);
    expect(mark).toHaveBeenCalledTimes(1);
  });
});
