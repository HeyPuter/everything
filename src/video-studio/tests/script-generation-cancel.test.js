import { afterEach, expect, it, vi } from 'vitest';
import { generateScenes } from '../src/media/script-video.js';
import { openScriptDialog } from '../src/ui/script-video.js';
import { createProject, normalizeAsset } from '../src/model/project.js';
import { EditorStore } from '../src/model/store.js';

const scenes = [{ narration: 'A bee visits the flowers.', picture: 'A bee' }];
const opts = { voice: 'polly', captions: 'clean-caption' };
const image = () => new Blob(['png'], { type: 'image/png' });
const sound = () => new Blob(['wav'], { type: 'audio/wav' });
const words = [{ text: 'A', start: 0, end: .1 }, { text: 'bee', start: .1, end: .3 }];
const defer = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
function services() {
  let n = 0;
  return {
    image: vi.fn(async () => image()), speech: vi.fn(async () => sound()), words: vi.fn(async () => words),
    music: vi.fn(async () => sound()), backdrop: vi.fn(async () => new File([image()], 'backdrop.png', { type: 'image/png' })),
    addMedia: vi.fn(async (file, origin) => normalizeAsset({ id: `a${++n}`, kind: file.type.startsWith('image/') ? 'image' : 'audio', name: file.name, duration: file.type.startsWith('image/') ? 0 : 2e6, hasAudio: !file.type.startsWith('image/'), width: 320, height: 180, origin })),
  };
}
afterEach(() => { document.querySelectorAll('dialog').forEach(d => d.remove()); document.body.replaceChildren(); });

it.each(['words', 'music'])('rejects cancellation while final %s resolves or rejects', async stage => {
  for (const fail of [false, true]) {
    const svc = services(), pending = defer(), controller = new AbortController(), progress = [];
    svc[stage].mockReturnValue(pending.promise);
    const result = generateScenes(scenes, { ...opts, music: stage === 'music' ? 'still-water' : '' }, svc, { signal: controller.signal, onProgress: p => progress.push(p.label) });
    await vi.waitFor(() => expect(svc[stage]).toHaveBeenCalledOnce());
    const oldProgress = [...progress];
    controller.abort();
    if (fail) pending.reject(new Error('Late provider failure')); else pending.resolve(stage === 'music' ? sound() : words);
    await expect(result).rejects.toMatchObject({ name: 'AbortError' });
    expect(progress).toEqual(oldProgress);
    expect(svc.addMedia).toHaveBeenCalledTimes(2);
  }
});

it.each(['speech', 'music'])('preserves cancellation after final %s import resolves or rejects', async origin => {
  for (const fail of [false, true]) {
    const svc = services(), controller = new AbortController(), pending = defer(), add = svc.addMedia.getMockImplementation();
    svc.addMedia.mockImplementation(async (file, source) => { if (source === origin) await pending.promise; return add(file, source); });
    const result = generateScenes(scenes, { ...opts, music: origin === 'music' ? 'still-water' : '' }, svc, { signal: controller.signal });
    await vi.waitFor(() => expect(svc.addMedia.mock.calls.some(c => c[1] === origin)).toBe(true));
    controller.abort();
    if (fail) pending.reject(new Error('Late storage failure')); else pending.resolve();
    await expect(result).rejects.toMatchObject({ name: 'AbortError' });
    if (origin === 'speech') expect(svc.words).not.toHaveBeenCalled();
  }
});

it('does not import a fallback backdrop or start speech after cancellation', async () => {
  const svc = services(), controller = new AbortController(), pending = defer();
  svc.image.mockRejectedValue(new Error('Image unavailable'));
  svc.backdrop.mockReturnValue(pending.promise);
  const result = generateScenes(scenes, opts, svc, { signal: controller.signal });
  await vi.waitFor(() => expect(svc.backdrop).toHaveBeenCalledOnce());
  controller.abort();
  pending.resolve(new File([image()], 'backdrop.png', { type: 'image/png' }));
  await expect(result).rejects.toMatchObject({ name: 'AbortError' });
  expect(svc.addMedia).not.toHaveBeenCalled();
  expect(svc.speech).not.toHaveBeenCalled();
});

it.each(['picture', 'done', 'Music added'])('honors cancellation by the %s progress callback', async stage => {
  const svc = services(), controller = new AbortController();
  const result = generateScenes(scenes, { ...opts, music: stage === 'Music added' ? 'still-water' : '' }, svc, { signal: controller.signal, onProgress: p => { if (p.label.endsWith(stage)) controller.abort(); } });
  await expect(result).rejects.toMatchObject({ name: 'AbortError' });
  if (stage === 'picture') expect(svc.image).not.toHaveBeenCalled();
});

it.each(['backdrop', 'backdrop import'])('preserves AbortError after a late %s failure', async stage => {
  const svc = services(), controller = new AbortController(), pending = defer();
  svc.image.mockRejectedValue(new Error('Image unavailable'));
  const target = stage === 'backdrop' ? svc.backdrop : svc.addMedia;
  target.mockReturnValue(pending.promise);
  const result = generateScenes(scenes, opts, svc, { signal: controller.signal });
  await vi.waitFor(() => expect(target).toHaveBeenCalledOnce());
  controller.abort(); pending.reject(new Error('Late fallback failure'));
  await expect(result).rejects.toMatchObject({ name: 'AbortError' });
  expect(svc.speech).not.toHaveBeenCalled();
});

it('keeps a late final speech error cancelled even with no music or captions', async () => {
  const svc = services(), controller = new AbortController(), pending = defer();
  svc.speech.mockReturnValue(pending.promise);
  const result = generateScenes(scenes, { ...opts, captions: '' }, svc, { signal: controller.signal });
  await vi.waitFor(() => expect(svc.speech).toHaveBeenCalledOnce());
  controller.abort(); pending.reject(new Error('Late voice failure'));
  await expect(result).rejects.toMatchObject({ name: 'AbortError' });
});

it.each(['image', 'speech', 'words'])('retains completed paid %s work for a retry after Stop', async stage => {
  const svc = services(), reuse = new Map(), controller = new AbortController(), pending = defer();
  svc[stage].mockReturnValueOnce(pending.promise);
  const result = generateScenes(scenes, opts, svc, { signal: controller.signal, reuse });
  await vi.waitFor(() => expect(svc[stage]).toHaveBeenCalledOnce());
  controller.abort(); pending.resolve(stage === 'image' ? image() : stage === 'speech' ? sound() : words);
  await expect(result).rejects.toMatchObject({ name: 'AbortError' });
  const retry = await generateScenes(scenes, opts, svc, { reuse });
  expect(retry.layout.pictures).toHaveLength(1);
  expect(retry.layout.voices).toHaveLength(1);
  expect(svc.image).toHaveBeenCalledOnce();
  expect(svc.speech).toHaveBeenCalledOnce();
  expect(svc.words).toHaveBeenCalledOnce();
  expect(svc.addMedia).toHaveBeenCalledTimes(2);
});

it('keeps genuine final-stage failures recoverable when not cancelled', async () => {
  const svc = services();
  svc.words.mockRejectedValue(new Error('Timing unavailable'));
  svc.music.mockRejectedValue(new Error('Music unavailable'));
  const result = await generateScenes(scenes, { ...opts, music: 'still-water' }, svc);
  expect(result.timing).toBe('estimate');
  expect(result.layout.voices).toHaveLength(1);
  expect(result.problems).toEqual([{ scene: 0, what: 'music', message: 'Music unavailable' }]);
});

it.each(['editor', 'home'])('Stop during music prevents %s application and retains retry media', async mode => {
  const store = new EditorStore(createProject()), svc = services(), pending = defer(), library = { saveProject: vi.fn(async () => {}) }, onProject = vi.fn();
  svc.music.mockReturnValueOnce(pending.promise);
  const d = openScriptDialog({ library, ...(mode === 'editor' ? { store } : {}) }, { services: svc, onProject });
  try {
    d.el.querySelector('.aic-script').value = scenes[0].narration;
    [...d.el.querySelectorAll('button')].find(b => b.textContent.startsWith('Next')).click();
    const before = structuredClone(store.project.tracks), result = d.run();
    await vi.waitFor(() => expect(svc.music).toHaveBeenCalledOnce());
    [...d.el.querySelectorAll('button')].find(b => b.textContent === 'Stop').click();
    pending.resolve(sound());
    await expect(result).resolves.toBeNull();
    expect(store.project.tracks).toEqual(before);
    expect(library.saveProject).not.toHaveBeenCalled();
    expect(onProject).not.toHaveBeenCalled();
    expect(d.el.dataset.step).toBe('scenes');
    await d.run();
    expect(svc.image).toHaveBeenCalledOnce();
    expect(svc.speech).toHaveBeenCalledOnce();
    if (mode === 'home') { expect(library.saveProject).toHaveBeenCalledOnce(); expect(onProject).toHaveBeenCalledOnce(); }
    else { expect(store.project.tracks.flatMap(t => t.clips).length).toBeGreaterThan(1); store.undo(); expect(store.project.tracks).toEqual(before); }
  } finally { d.close(); }
});
