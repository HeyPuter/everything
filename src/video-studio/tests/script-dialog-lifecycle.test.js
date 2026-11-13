import { afterEach, expect, it, vi } from 'vitest';
import { openScriptDialog } from '../src/ui/script-video.js';
import { createProject, makeClip, normalizeAsset } from '../src/model/project.js';
import { EditorStore } from '../src/model/store.js';
import { addTimeline } from '../src/model/timelines.js';
import { createCompound } from '../src/model/compound.js';

const dialogs = [];
const defer = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const image = () => new Blob(['png'], { type: 'image/png' });
const sound = () => new Blob(['wav'], { type: 'audio/wav' });
const button = (d, text) => [...d.el.querySelectorAll('button')].find(b => b.textContent.startsWith(text));
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
afterEach(() => { for (const d of dialogs.splice(0)) d.close(); document.body.replaceChildren(); vi.restoreAllMocks(); });
function setup({ home = false, step = 'scenes' } = {}) {
  const p = createProject(), nested = makeClip('text', { text: 'Nested', duration: 1e6 });
  p.tracks[0].clips.push(nested);
  const compound = createCompound(p, [nested.id]), target = addTimeline(p), original = p.timelineId;
  const store = new EditorStore(p), library = { saveProject: vi.fn(async () => {}) }, onProject = vi.fn();
  let n = 0;
  const services = { chat: vi.fn(async () => 'A bee visits the flowers.'), image: vi.fn(async () => image()), speech: vi.fn(async () => sound()), words: vi.fn(async () => null), music: vi.fn(async () => sound()), backdrop: vi.fn(async () => new File([image()], 'backdrop.png', { type: 'image/png' })), addMedia: vi.fn(async (file, origin) => normalizeAsset({ id: `a${++n}`, kind: file.type.startsWith('image/') ? 'image' : 'audio', name: file.name, duration: file.type.startsWith('image/') ? 0 : 2e6, hasAudio: !file.type.startsWith('image/'), width: 320, height: 180, origin })) };
  const opener = document.createElement('button'); document.body.append(opener); opener.focus();
  const d = openScriptDialog({ library, ...(!home ? { store } : {}) }, { services, onProject }); dialogs.push(d);
  d.el.querySelector('.aic-script').value = 'A bee visits the flowers.';
  if (step === 'scenes') button(d, 'Next').click();
  return { d, store, library, services, onProject, target, original, compound, opener };
}

it.each(['timeline', 'return', 'compound', 'project'])('closes and cancels generation when the editing context changes: %s', async kind => {
  const e = setup(), pending = defer(); e.services.image.mockReturnValue(pending.promise);
  const run = e.d.run();
  if (kind === 'timeline' || kind === 'return') { e.store.openTimeline(e.target); if (kind === 'return') e.store.openTimeline(e.original); }
  if (kind === 'compound') e.store.openCompound(e.compound.id);
  if (kind === 'project') e.store.load(createProject());
  const before = structuredClone(e.store.project);
  const closed = !e.d.el.isConnected;
  pending.resolve(image()); await run;
  expect(e.store.project).toEqual(before);
  expect(closed).toBe(true);
  expect(e.services.speech).not.toHaveBeenCalled();
});

it('closes an idle dialog on timeline changes and rejects a later run', async () => {
  const e = setup(); e.store.openTimeline(e.target);
  expect(e.d.el.isConnected).toBe(false);
  await e.d.run(); expect(e.services.image).not.toHaveBeenCalled();
});

it('cannot start another generation after closing', async () => {
  const e = setup(); e.d.close(); await e.d.run(); expect(e.services.image).not.toHaveBeenCalled();
});

it('captures placement while preserving same-context edits and one undo', async () => {
  const e = setup(), pending = defer(); e.store.seek(500000); e.services.image.mockReturnValue(pending.promise);
  const run = e.d.run(); e.store.seek(3e6); e.store.update('Rename', p => { p.name = 'Renamed'; });
  const before = structuredClone(e.store.project.tracks);
  pending.resolve(image()); await run;
  expect(e.store.project.tracks.flatMap(t => t.clips).find(c => c.type === 'image').start).toBe(500000);
  expect(e.store.project.name).toBe('Renamed'); e.store.undo(); expect(e.store.project.tracks).toEqual(before); expect(e.store.project.name).toBe('Renamed');
});

it.each(['Stop', 'Close', 'Escape'])('does not navigate after %s during a home-project save', async how => {
  const e = setup({ home: true }), pending = defer(); e.library.saveProject.mockReturnValue(pending.promise);
  const run = e.d.run(); await vi.waitFor(() => expect(e.library.saveProject).toHaveBeenCalledOnce());
  if (how === 'Stop') button(e.d, 'Stop').click();
  if (how === 'Close') e.d.el.querySelector('.dialog-close').click();
  if (how === 'Escape') e.d.el.dispatchEvent(new Event('cancel', { cancelable: true }));
  pending.resolve(); await run;
  expect(e.onProject).not.toHaveBeenCalled();
  expect(document.querySelector('.toast.success')).toBeNull();
  if (how === 'Stop') expect(e.d.el.textContent).toMatch(/saved.*library/i);
});

it('ignores a late save failure after closing', async () => {
  const e = setup({ home: true }), pending = defer(), errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  e.library.saveProject.mockReturnValue(pending.promise); const run = e.d.run(); await vi.waitFor(() => expect(e.library.saveProject).toHaveBeenCalledOnce());
  e.d.close(); const html = e.d.el.innerHTML; pending.reject(new Error('Late save failure')); await run;
  expect(e.d.el.innerHTML).toBe(html); expect(errors).not.toHaveBeenCalled(); expect(e.onProject).not.toHaveBeenCalled();
});

it('allows Close while Stop waits for reusable paid media, then ignores its completion', async () => {
  const e = setup(), pending = defer(); e.services.image.mockReturnValue(pending.promise); const run = e.d.run();
  const stop = button(e.d, 'Stop'); stop.focus(); stop.click();
  expect(stop.textContent).toBe('Close'); expect(e.d.el.textContent).toMatch(/Stopping/);
  stop.click(); const html = e.d.el.innerHTML; pending.resolve(image()); await run;
  expect(e.d.el.isConnected).toBe(false); expect(e.d.el.innerHTML).toBe(html); expect(document.activeElement).toBe(e.opener);
});

it('restores Create focus after Stop settles and retains paid media for retry', async () => {
  const e = setup(), pending = defer(); e.services.image.mockReturnValueOnce(pending.promise); const run = e.d.run();
  button(e.d, 'Stop').focus(); button(e.d, 'Stop').click(); pending.resolve(image()); await run;
  expect(document.activeElement).toBe(button(e.d, 'Create')); await e.d.run(); expect(e.services.image).toHaveBeenCalledOnce();
});

it.each(['write', 'suggest'])('ignores late %s results and errors after closing', async mode => {
  for (const fail of [false, true]) {
    const e = setup({ step: mode === 'write' ? 'script' : 'scenes' }), pending = defer(), errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    e.services.chat.mockReturnValue(pending.promise); button(e.d, mode === 'write' ? 'Write' : 'Suggest').click(); e.d.close(); const html = e.d.el.innerHTML;
    if (fail) pending.reject(new Error('Late chat failure')); else pending.resolve(mode === 'write' ? 'Changed script from AI.' : '["Changed picture"]');
    await tick(); expect(e.d.el.innerHTML).toBe(html); expect(errors).not.toHaveBeenCalled(); errors.mockRestore();
  }
});

it('keeps a script manually edited while writing is pending', async () => {
  const e = setup({ step: 'script' }), pending = defer(); e.services.chat.mockReturnValue(pending.promise); button(e.d, 'Write').click();
  const field = e.d.el.querySelector('.aic-script'); field.value = 'My revised script'; field.dispatchEvent(new Event('input'));
  pending.resolve('AI draft from the original topic.'); await tick(); expect(field.value).toBe('My revised script');
});

it('keeps manually edited pictures and narration while applying other suggestions without stealing focus', async () => {
  const e = setup({ step: 'script' }), pending = defer(); e.d.el.querySelector('.aic-script').value = 'First scene has quite a few words about a bee.\n\nSecond scene has quite a few words about a flower.\n\nThird scene has quite a few words about the honey.'; button(e.d, 'Next').click();
  e.services.chat.mockReturnValue(pending.promise); button(e.d, 'Suggest').click(); const pictures = e.d.el.querySelectorAll('.aic-picture'), narration = e.d.el.querySelector('.aic-narration');
  pictures[1].value = 'My own picture'; pictures[1].dispatchEvent(new Event('input')); pictures[1].focus(); narration.value = 'Changed narration'; narration.dispatchEvent(new Event('input'));
  pending.resolve('["Wrong first", "Wrong second", "Good third"]'); await tick();
  expect(e.d.scenes.map(s => s.picture)).toEqual(['', 'My own picture', 'Good third']); expect(document.activeElement).toBe(pictures[1]); expect(pictures[2].value).toBe('Good third');
});

it('restores an enabled action after an active error and allows retry', async () => {
  const e = setup({ step: 'script' }); vi.spyOn(console, 'error').mockImplementation(() => {}); e.services.chat.mockRejectedValueOnce(new Error('Offline'));
  const write = button(e.d, 'Write'); write.focus(); write.click(); write.blur(); await tick(); expect(write.disabled).toBe(false); expect(document.activeElement).toBe(write); expect(e.d.el.textContent).toMatch(/Offline/);
  write.click(); await tick(); expect(e.d.el.querySelector('.aic-script').value).toBe('A bee visits the flowers.');
});

it('removes its context observer on close', () => {
  const p = createProject(), store = new EditorStore(p), on = store.on.bind(store), off = vi.fn();
  vi.spyOn(store, 'on').mockImplementation((type, fn) => { const remove = on(type, fn); return () => { off(); remove(); }; });
  const d = openScriptDialog({ store, library: {} }); dialogs.push(d); expect(store.on).toHaveBeenCalledWith('change', expect.any(Function)); d.close(); expect(off).toHaveBeenCalledOnce();
});

it('normal home generation saves and opens once', async () => {
  const e = setup({ home: true }); await e.d.run(); expect(e.library.saveProject).toHaveBeenCalledOnce(); expect(e.onProject).toHaveBeenCalledOnce(); expect(e.d.el.isConnected).toBe(false);
});

it('prevents duplicate generation while a job is running or stopping', async () => {
  const e = setup(), pending = defer(); e.services.image.mockReturnValue(pending.promise); const first = e.d.run();
  await e.d.run(); button(e.d, 'Stop').click(); await e.d.run(); expect(e.services.image).toHaveBeenCalledOnce();
  pending.resolve(image()); await first; expect(e.services.speech).not.toHaveBeenCalled();
});

it('keeps an intentional focus move when script writing finishes', async () => {
  const e = setup({ step: 'script' }), pending = defer(); e.services.chat.mockReturnValue(pending.promise); button(e.d, 'Write').click();
  const voice = e.d.el.querySelector('[aria-label="Voice"]'); voice.focus(); pending.resolve('A fresh script with quite a few words.'); await tick();
  expect(document.activeElement).toBe(voice); expect(e.d.el.querySelector('.aic-script').value).toBe('A fresh script with quite a few words.');
});

it('recovers from an active generation failure and reuses the dialog', async () => {
  const e = setup(); vi.spyOn(console, 'error').mockImplementation(() => {});
  e.services.image.mockRejectedValueOnce(new Error('Image down')); e.services.speech.mockRejectedValueOnce(new Error('Voice down'));
  button(e.d, 'Create').focus(); await e.d.run(); expect(e.d.el.dataset.step).toBe('scenes'); expect(button(e.d, 'Create').disabled).toBe(false); expect(e.d.el.textContent).toMatch(/Image down/);
  await e.d.run(); expect(e.d.el.isConnected).toBe(false);
});

it('old closed-dialog callbacks cannot change a newer dialog job', async () => {
  const old = setup(), pending = defer(); old.services.image.mockReturnValue(pending.promise); const oldRun = old.d.run(); old.d.close();
  const fresh = setup(), next = defer(); fresh.services.image.mockReturnValue(next.promise); const newRun = fresh.d.run();
  const html = fresh.d.el.innerHTML; pending.resolve(image()); await oldRun;
  expect(fresh.d.el.innerHTML).toBe(html); expect(fresh.d.el.dataset.step).toBe('progress'); next.resolve(image()); await newRun; expect(fresh.d.el.isConnected).toBe(false);
});
