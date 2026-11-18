import { it, expect, vi, afterEach } from 'vitest';
import { createActions } from '../src/ui/actions.js';
import { EditorStore } from '../src/model/store.js';
import { normalizeProject } from '../src/model/project.js';
import { findClip } from '../src/model/timeline.js';
import { fixture, clip, onMain } from './helpers.js';

vi.mock('../src/media/tracker.js', async original => ({
  ...await original(),
  grayFrames: async function* (_blob, times) {
    const frame = new Float32Array(192 * 108).fill(.5);
    for (const t of times) yield { t, frame };
  },
}));
vi.mock('../src/media/flicker.js', async original => ({
  ...await original(), frameLumas: async (_blob, times) => times.map((_, i) => i % 2 ? .55 : .45),
}));
const actions = [['stabilize', 'Stabilize'], ['removeFlicker', 'Remove flicker']];
const button = label => [...document.querySelectorAll('dialog[open] button')].find(b => b.textContent.trim() === label);
const flush = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); };
afterEach(() => {
  document.querySelectorAll('.dialog-close').forEach(b => b.click());
  document.querySelector('.toasts')?.replaceChildren();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});
function setup() {
  const p = fixture(), [target] = onMain(p, clip('video', 0, .8));
  target.keyframes.x = [{ t: 0, v: .1, ease: 'linear' }];
  const store = new EditorStore(p), library = { mediaBlob: vi.fn(async () => new Blob()) };
  store.select(target.id);
  const ctx = { store, library };
  ctx.actions = createActions(ctx);
  return { ctx, store, target, library };
}
async function open(x, action, label) {
  await x.ctx.actions[action]();
  return { dialog: document.querySelector('dialog[open]'), go: button(label) };
}
for (const [action, label] of actions) {
  it.each(['cancel', 'close', 'escape'])(`${label} ignores a retained submit control after %s`, async how => {
    const x = setup(), ui = await open(x, action, label), before = JSON.stringify(x.store.projectForSave());
    if (how === 'cancel') button('Cancel').click();
    else if (how === 'close') ui.dialog.querySelector('.dialog-close').click();
    else ui.dialog.dispatchEvent(new Event('cancel', { cancelable: true }));
    ui.go.click();
    await flush();
    expect(x.library.mediaBlob).not.toHaveBeenCalled();
    expect(JSON.stringify(x.store.projectForSave())).toBe(before);
    expect(x.store.history.undoStack).toHaveLength(0);
    expect(document.querySelector('dialog[open]')).toBeNull();
    expect(document.querySelector('.toast.success')).toBeNull();
    const fresh = await open(x, action, label);
    fresh.go.click();
    await flush();
    expect(x.store.history.undoStack).toHaveLength(1);
    const result = structuredClone(findClip(x.store.project, x.target.id).clip);
    x.store.undo();
    expect(findClip(x.store.project, x.target.id).clip.keyframes.x).toEqual([{ t: 0, v: .1, ease: 'linear' }]);
    x.store.redo();
    expect(findClip(normalizeProject(x.store.projectForSave()), x.target.id).clip).toEqual(result);
  });
  it(`${label} accepts its settings only once, during analysis and after completion`, async () => {
    const x = setup(), releases = [];
    x.library.mediaBlob.mockImplementation(() => new Promise(r => releases.push(() => r(new Blob()))));
    const ui = await open(x, action, label);
    ui.go.click(); ui.go.click();
    await flush();
    const reads = x.library.mediaBlob.mock.calls.length, dialogs = document.querySelectorAll('dialog[open]').length;
    releases.splice(0).forEach(r => r());
    await flush();
    expect(reads).toBe(1);
    expect(dialogs).toBe(1);
    expect(x.store.history.undoStack).toHaveLength(1);
    x.library.mediaBlob.mockResolvedValue(new Blob());
    const before = JSON.stringify(x.store.projectForSave());
    ui.go.click();
    await flush();
    expect(JSON.stringify(x.store.projectForSave())).toBe(before);
    expect(x.library.mediaBlob).toHaveBeenCalledOnce();
    expect(x.store.history.undoStack).toHaveLength(1);
  });
  it(`${label} cannot restart canceled analysis from its old settings control`, async () => {
    const x = setup(), releases = [], before = JSON.stringify(x.store.projectForSave());
    x.library.mediaBlob.mockImplementation(() => new Promise(r => releases.push(() => r(new Blob()))));
    const ui = await open(x, action, label);
    ui.go.click();
    await flush();
    button('Cancel').click();
    ui.go.click();
    await flush();
    releases.splice(0).forEach(r => r());
    await flush();
    expect(x.library.mediaBlob).toHaveBeenCalledOnce();
    expect(JSON.stringify(x.store.projectForSave())).toBe(before);
    expect(x.store.history.undoStack).toHaveLength(0);
    expect(document.querySelector('dialog[open]')).toBeNull();
    expect(document.querySelector('.toast.success')).toBeNull();
  });
}
