import { afterEach, expect, it, vi } from 'vitest';
import { Editor } from '../src/ui/editor.js';
import { Home } from '../src/ui/home.js';
import * as script from '../src/ui/script-video.js';
import { Library } from '../src/storage/library.js';
import { memoryBackend } from '../src/storage/backends.js';
import { createProject, normalizeAsset } from '../src/model/project.js';

const parents = [], dialogs = [];
const realOpen = script.openScriptVideo, realDialog = script.openScriptDialog, realNeed = script.needAiDialog;
const defer = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const image = () => new Blob(['png'], { type: 'image/png' });
const sound = () => new Blob(['wav'], { type: 'audio/wav' });
afterEach(() => { for (const p of parents.splice(0)) p.dispose(); for (const d of dialogs.splice(0)) d?.close(); delete globalThis.__vsAiStub; vi.restoreAllMocks(); document.body.replaceChildren(); });
async function setup(kind, { signedIn = true } = {}) {
  const root = document.createElement('div'); root.id = 'app'; document.body.append(root);
  const library = new Library(memoryBackend(), { cache: null }), project = createProject(), onOpen = vi.fn();
  await library.saveProject(project);
  const parent = kind === 'editor' ? new Editor(root, { library, project, account: {}, onExit() {}, onNewProject() {} }) : new Home(root, { library, account: {}, onOpen, onCreate() {}, onImportFiles() {} });
  parents.push(parent); if (signedIn) globalThis.__vsAiStub = true;
  let n = 0, current;
  const services = { image: vi.fn(async () => image()), speech: vi.fn(async () => sound()), words: vi.fn(async () => null), music: vi.fn(async () => sound()), backdrop: vi.fn(async () => new File([image()], 'backdrop.png', { type: 'image/png' })), addMedia: vi.fn(async (file, origin) => normalizeAsset({ id: `a${++n}`, kind: file.type.startsWith('image/') ? 'image' : 'audio', name: file.name, duration: file.type.startsWith('image/') ? 0 : 2e6, hasAudio: !file.type.startsWith('image/'), width: 320, height: 180, origin })) };
  const record = d => { current = d; if (d) dialogs.push(d); return d; };
  vi.spyOn(script, 'openScriptVideo').mockImplementation((ctx, extra) => record(realOpen(ctx, { ...extra, services })));
  vi.spyOn(script, 'openScriptDialog').mockImplementation((env, extra) => record(realDialog(env, { ...extra, services })));
  vi.spyOn(script, 'needAiDialog').mockImplementation((...args) => record(realNeed(...args)));
  const open = () => kind === 'editor' ? parent.ctx.openScriptVideo() : parent.scriptToVideo();
  await new Promise(r => setTimeout(r, 20));
  return { parent, library, onOpen, services, open, get dialog() { return current; } };
}
function ready(d) { d.el.querySelector('.aic-script').value = 'A bee visits the flowers on a sunny day.'; [...d.el.querySelectorAll('button')].find(b => b.textContent.startsWith('Next')).click(); }

it.each(['editor', 'home'])('%s closes an idle script dialog when disposed', async kind => {
  const e = await setup(kind); await e.open(); const d = e.dialog; e.parent.dispose(); expect(d.el.isConnected).toBe(false);
});

it.each(['editor', 'home'])('%s cancels late generation on disposal', async kind => {
  const e = await setup(kind), pending = defer(); e.services.image.mockReturnValue(pending.promise); await e.open(); const d = e.dialog; ready(d);
  const tracks = kind === 'editor' ? structuredClone(e.parent.store.project.tracks) : null, save = vi.spyOn(e.library, 'saveProject');
  const run = d.run(); e.parent.dispose(); pending.resolve(image()); await run;
  expect(d.el.isConnected).toBe(false); expect(e.services.speech).not.toHaveBeenCalled(); expect(save).not.toHaveBeenCalled(); expect(e.onOpen).not.toHaveBeenCalled();
  if (tracks) expect(e.parent.store.project.tracks).toEqual(tracks);
});

it.each(['editor', 'home'])('%s ignores a module load that settles after disposal', async kind => {
  const e = await setup(kind); const opening = e.open(); e.parent.dispose(); await opening; expect(document.querySelector('dialog')).toBeNull();
});

it.each(['editor', 'home'])('%s cannot open a dialog after disposal', async kind => {
  const e = await setup(kind); e.parent.dispose(); await e.open(); expect(document.querySelector('dialog')).toBeNull();
});

it.each(['editor', 'home'])('%s shares repeated opening requests and permits reopening after Close', async kind => {
  const e = await setup(kind); await Promise.all([e.open(), e.open()]); const first = e.dialog;
  expect(document.querySelectorAll('dialog')).toHaveLength(1); await e.open(); expect(e.dialog).toBe(first); expect(document.querySelectorAll('dialog')).toHaveLength(1);
  first.close(); await e.open(); expect(e.dialog).not.toBe(first); expect(e.dialog.el.isConnected).toBe(true);
});

it.each(['editor', 'home'])('%s closes its sign-in explanation on disposal', async kind => {
  const e = await setup(kind, { signedIn: false }); await e.open(); const d = document.querySelector('dialog'); expect(d.textContent).toContain('Sign in to use AI'); e.parent.dispose(); expect(d.isConnected).toBe(false);
});

it('home disposal suppresses navigation after an already-started save', async () => {
  const e = await setup('home'), pending = defer(), save = vi.spyOn(e.library, 'saveProject').mockReturnValue(pending.promise); await e.open(); const d = e.dialog; ready(d);
  const run = d.run(); await vi.waitFor(() => expect(save).toHaveBeenCalledOnce()); e.parent.dispose(); pending.resolve(); await run; expect(e.onOpen).not.toHaveBeenCalled(); expect(d.el.isConnected).toBe(false);
});

it.each(['editor', 'home'])('%s normal creation still completes and the next dialog is fresh', async kind => {
  const e = await setup(kind); await e.open(); const d = e.dialog; ready(d); const before = kind === 'editor' ? structuredClone(e.parent.store.project.tracks) : null;
  await d.run(); expect(d.el.isConnected).toBe(false); if (before) { expect(e.parent.store.project.tracks.flatMap(t => t.clips).length).toBeGreaterThan(0); e.parent.store.undo(); expect(e.parent.store.project.tracks).toEqual(before); } else expect(e.onOpen).toHaveBeenCalledOnce();
  await e.open(); expect(e.dialog).not.toBe(d); expect(e.dialog.el.isConnected).toBe(true);
});

it('closing an older dialog cannot clear ownership of its immediate replacement', async () => {
  const e = await setup('editor'); const first = realOpen(e.parent.ctx, { services: e.services }); dialogs.push(first); first.close();
  const next = realOpen(e.parent.ctx, { services: e.services }); dialogs.push(next); await Promise.resolve();
  expect(realOpen(e.parent.ctx, { services: e.services })).toBe(next); expect(document.querySelectorAll('dialog')).toHaveLength(1);
});

it.each(['script', 'sign-in'])('releases the parent abort listener when the %s dialog closes', async kind => {
  const controller = new AbortController(), remove = vi.spyOn(controller.signal, 'removeEventListener');
  const d = kind === 'script' ? realDialog({ library: {}, signal: controller.signal }) : realNeed({}, 'Script to video', { signal: controller.signal });
  dialogs.push(d); d.close(); expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
});
