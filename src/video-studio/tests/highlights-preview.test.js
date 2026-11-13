import { afterEach, expect, it, vi } from 'vitest';
import { Editor } from '../src/ui/editor.js';
import { openHighlightsDialog } from '../src/ui/highlights-dialog.js';
import { Library } from '../src/storage/library.js';
import { memoryBackend } from '../src/storage/backends.js';
import { setPref } from '../src/ui/prefs.js';
import { fixture, clip, onMain } from './helpers.js';

const parents = [], dialogs = [];
const button = (d, text) => [...d.el.querySelectorAll('button')].find(b => b.textContent === text);
const previews = d => [...d.el.querySelectorAll('.aic-cand button')];
afterEach(() => { dialogs.splice(0).forEach(d => d.close()); parents.splice(0).forEach(p => p.dispose()); vi.restoreAllMocks(); document.querySelectorAll('.toast').forEach(t => t.remove()); document.body.replaceChildren(); });
async function setup({ whole = false, loop = false, playing = false, range = false } = {}) {
  setPref('loopPlayback', loop); setPref('highlights', { target: 'here', captions: 'yellow-caption' });
  const root = document.createElement('div'); root.id = 'app'; document.body.append(root);
  const library = new Library(memoryBackend(), { cache: null }), project = fixture(); project.assets.vid.duration = 200e6; onMain(project, clip('video', 0, whole ? 20 : 120)); project.range = { in: 0, out: 5e6 };
  project.transcript = { language: 'en', words: Array.from({ length: whole ? 40 : 240 }, (_, i) => ({ text: `w${i}${i % 10 === 9 ? '.' : ''}`, start: i * 500000, end: i * 500000 + 400000 })) };
  await library.saveProject(project); const editor = new Editor(root, { library, project, account: {}, onExit() {}, onNewProject() {} }); parents.push(editor);
  await new Promise(r => setTimeout(r, 20)); const player = editor.ctx.player; vi.spyOn(player, 'renderFrame').mockImplementation(() => {});
  if (playing) player.play({ range });
  const d = openHighlightsDialog(editor.ctx, { chat: async () => whole ? '{"highlights":[{"title":"Whole","start":0,"end":39}]}' : '{"highlights":[{"title":"First","start":20,"end":59},{"title":"Second","start":100,"end":139}]}' }); dialogs.push(d); await d.search();
  const advance = seconds => { cancelAnimationFrame(player.raf); player.timeStart = editor.store.time; player.clockStart = performance.now() - seconds * 1000; player._startWait = null; player._tick(); cancelAnimationFrame(player.raf); player.raf = 0; };
  return { d, player, store: editor.store, advance, editor };
}
it.each([
  { name: 'paused', playing: false }, { name: 'normal playback', playing: true },
  { name: 'range playback', playing: true, range: true }, { name: 'looping range playback', playing: true, range: true, loop: true },
])('previews the selected span during $name', async options => {
  const e = await setup(options), btn = previews(e.d)[0], from = e.d.found[0].start; btn.click();
  expect(e.store.time).toBe(from); e.advance(1); expect(e.store.time).toBeGreaterThanOrEqual(from); expect(e.store.time).toBeLessThan(e.d.found[0].end); expect(e.player.playing).toBe(true);
  expect(btn.getAttribute('aria-pressed')).toBe('true'); expect(e.store.project.range).toEqual({ in: 0, out: 5e6 });
});
it.each([false, true])('stops a whole-project preview at the end with Loop set to %s', async loop => {
  const e = await setup({ whole: true, loop }), btn = previews(e.d)[0]; btn.click(); e.advance(21);
  expect(e.player.playing).toBe(false); expect(e.store.time).toBe(20e6); expect(btn.getAttribute('aria-pressed')).toBe('false'); expect(e.player.loop).toBe(loop);
});
it('keeps previews one-shot even when preferences change during playback', async () => {
  const e = await setup({ whole: true }); previews(e.d)[0].click(); e.editor.ctx.toggleLoop(); e.advance(21);
  expect(e.player.playing).toBe(false); expect(e.store.time).toBe(20e6); expect(e.player.loop).toBe(true);
});
it('switches previews and stops only at the current highlight end', async () => {
  const e = await setup({ playing: true, range: true, loop: true }), [first, second] = previews(e.d); first.click(); e.advance(1); second.click();
  expect(first.getAttribute('aria-pressed')).toBe('false'); expect(second.getAttribute('aria-pressed')).toBe('true'); const from = e.d.found[1].start;
  expect(e.store.time).toBe(from); e.advance(1); expect(e.player.playing).toBe(true); expect(e.store.time).toBeGreaterThan(from);
  e.advance(21); expect(e.player.playing).toBe(false); expect(second.getAttribute('aria-pressed')).toBe('false');
});
it.each(['button', 'external pause', 'close', 'search again', 'source edit'])('releases preview playback on %s and retains normal looping afterward', async how => {
  const e = await setup({ loop: true }), btn = previews(e.d)[0]; btn.click();
  if (how === 'button') btn.click();
  if (how === 'external pause') e.player.pause();
  if (how === 'close') e.d.close();
  if (how === 'search again') button(e.d, 'Search again').click();
  if (how === 'source edit') e.store.update('Slip', p => { p.tracks[0].clips[0].in = 1e6; });
  expect(e.player.playing).toBe(false); expect(btn.getAttribute('aria-pressed')).toBe('false'); expect(e.player.loop).toBe(true);
  e.store.seek(119e6); e.player.play(); e.advance(2); expect(e.player.playing).toBe(true); expect(e.store.time).toBe(0);
});
it('still honors normal range playback after finishing a preview', async () => {
  const e = await setup(); previews(e.d)[0].click(); e.advance(21); e.store.seek(0); e.player.play({ range: true }); e.advance(6);
  expect(e.player.playing).toBe(false); expect(e.store.time).toBe(5e6);
});
it('preserves title-field focus when a preview ends', async () => {
  const e = await setup(), btn = previews(e.d)[0]; btn.click(); const title = e.d.el.querySelector('[aria-label="Title of highlight 1"]'); title.focus(); e.advance(21);
  expect(e.player.playing).toBe(false); expect(btn.textContent).toBe('Preview'); expect(document.activeElement).toBe(title);
});
