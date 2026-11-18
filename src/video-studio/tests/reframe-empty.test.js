import { it, expect, vi, afterEach } from 'vitest';
import { createSmartActions } from '../src/ui/smart-actions.js';
import { EditorStore } from '../src/model/store.js';
import { normalizeProject } from '../src/model/project.js';
import { fixture, clip, onMain } from './helpers.js';

const flush = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); };
afterEach(() => {
  document.querySelectorAll('.dialog-close').forEach(b => b.click());
  document.querySelector('.toasts')?.replaceChildren();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});
function setup(mode) {
  const p = fixture();
  if (mode !== 'empty') {
    const c = clip('image', 0, 4);
    onMain(p, c);
    if (mode === 'locked') p.tracks[0].locked = true;
    if (mode === 'missing') delete p.assets.img;
    if (mode === 'dimensions') p.assets.img.width = 0;
  }
  const store = new EditorStore(p), library = { mediaBlob: vi.fn() };
  if (mode !== 'empty') store.select([p.tracks[0].clips[0].id]);
  const ctx = { store, library };
  ctx.actions = createSmartActions(ctx);
  return { store, library, ctx };
}
async function run(x, ratio = 'keep') {
  await x.ctx.actions.autoReframe();
  document.querySelector('dialog[open] select').value = ratio;
  [...document.querySelectorAll('dialog[open] button')].find(b => b.textContent.trim() === 'Reframe').click();
  await flush();
}
it.each(['empty', 'locked', 'missing', 'dimensions'])('leaves the entire project and history unchanged with no eligible clips (%s)', async mode => {
  const x = setup(mode), before = JSON.stringify(x.store.projectForSave());
  await run(x);
  expect(JSON.stringify(x.store.projectForSave())).toBe(before);
  expect(x.store.history.undoStack).toHaveLength(0);
  expect(x.store.revision).toBe(0);
  expect(x.store.dirty).toBe(false);
  expect(x.library.mediaBlob).not.toHaveBeenCalled();
  expect(document.querySelector('.toast.success')).toBeNull();
  expect(document.querySelector('.toast.info')?.textContent).toContain('No clips could be reframed');
});
it('also skips an explicit frame shape that already matches the project', async () => {
  const x = setup('locked'), before = JSON.stringify(x.store.projectForSave());
  await run(x, '16:9');
  expect(JSON.stringify(x.store.projectForSave())).toBe(before);
  expect(x.store.history.undoStack).toHaveLength(0);
  expect(document.querySelector('.toast.success')).toBeNull();
});
it.each(['empty', 'locked'])('still changes frame shape with no eligible clips (%s), with accurate feedback and undo', async mode => {
  const x = setup(mode), before = JSON.stringify(x.store.project.tracks);
  await run(x, '9:16');
  expect(x.store.project.settings).toMatchObject({ width: 1080, height: 1920, ratio: '9:16' });
  expect(JSON.stringify(x.store.project.tracks)).toBe(before);
  expect(x.store.history.undoStack).toHaveLength(1);
  expect(x.library.mediaBlob).not.toHaveBeenCalled();
  expect(document.querySelector('.toast.success')?.textContent).toContain('Changed frame shape to 9:16');
  x.store.undo();
  expect(x.store.project.settings).toMatchObject({ width: 1920, height: 1080, ratio: '16:9' });
  x.store.redo();
  expect(normalizeProject(x.store.projectForSave()).settings).toMatchObject({ width: 1080, height: 1920, ratio: '9:16' });
  const saved = JSON.stringify(x.store.projectForSave());
  document.querySelector('.toasts')?.replaceChildren();
  await run(x);
  expect(JSON.stringify(x.store.projectForSave())).toBe(saved);
  expect(x.store.history.undoStack).toHaveLength(1);
  expect(document.querySelector('.toast.success')).toBeNull();
});
