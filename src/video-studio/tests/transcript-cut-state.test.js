import { it, expect, vi, afterEach } from 'vitest';
import { transcriptPanel } from '../src/ui/panels/transcript.js';
import { EditorStore } from '../src/model/store.js';
import { anchorWords, transcriptWords } from '../src/media/transcript.js';
import { normalizeProject } from '../src/model/project.js';
import { mainTrack } from '../src/model/timeline.js';
import { announce } from '../src/lib/dom.js';
import { fixture, clip, onMain, s } from './helpers.js';
vi.mock('../src/lib/dom.js', async original => ({ ...await original(), announce: vi.fn() }));
const panels = [];
afterEach(() => { panels.splice(0).forEach(p => p.dispose()); document.querySelectorAll('.dialog-close').forEach(b => b.click()); document.querySelector('.toasts')?.replaceChildren(); document.body.replaceChildren(); vi.restoreAllMocks(); announce.mockClear(); });
function setup(locked, extra = false) {
  const p = fixture(); onMain(p, clip('video', 0, 4)); mainTrack(p).locked = locked;
  p.transcript = { language: 'en', words: anchorWords(p, [{ text: 'um', start: s(.5), end: s(.8) }, { text: 'hello', start: s(1), end: s(1.3) }, { text: 'later', start: s(3), end: s(3.3) }, ...(extra ? [{ text: 'again', start: s(3.5), end: s(3.8) }] : [])]) };
  const store = new EditorStore(p), panel = transcriptPanel({ store, player: null, library: {} }, { scope: 'all', language: 'en' }, () => {}); panels.push(panel); document.body.append(panel.el);
  const body = panel.el.querySelector('.tr-words'); body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true })); body.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', shiftKey: true, bubbles: true })); announce.mockClear();
  return { store, panel };
}
async function run(panel, kind) {
  const label = kind === 'selection' ? 'Delete selection' : kind === 'fillers' ? 'Remove fillers' : 'Shorten pauses';
  [...panel.el.querySelectorAll('button')].find(b => b.textContent.startsWith(label)).click();
  if (kind !== 'selection') { const confirm = kind === 'fillers' ? 'Remove' : 'Shorten'; [...document.querySelector('dialog[open]').querySelectorAll('button')].find(b => b.textContent === confirm).click(); }
  for (let i = 0; i < 20; i++) await Promise.resolve();
}
it.each(['selection', 'fillers', 'pauses'])('reports an unchanged locked %s edit and supports unlock/retry', async kind => {
  const { store, panel } = setup(true), before = JSON.stringify(store.projectForSave()); await run(panel, kind);
  expect(JSON.stringify(store.projectForSave())).toBe(before); expect(store.history.undoStack).toHaveLength(0); expect(document.querySelector('.toast.error')).toBeTruthy();
  expect(announce.mock.calls.flat().join(' ')).not.toMatch(/words? cut|Removed \d/); expect(document.body.textContent).not.toContain('Removed 1 filler');
  store.update('Unlock', p => { mainTrack(p).locked = false; }); if (kind === 'selection') expect(panel.el.querySelector('.tr-sel-info').textContent).toContain('2 words');
  await run(panel, kind); expect(store.history.undoStack).toHaveLength(2); expect(mainTrack(store.project).clips.reduce((n,c) => n+c.duration,0)).toBeLessThan(s(4));
  const result = transcriptWords(store.project); store.undo(); expect(transcriptWords(store.project)).toHaveLength(3); store.redo(); expect(transcriptWords(normalizeProject(store.projectForSave()))).toEqual(result);
});
it.each(['selection', 'fillers', 'pauses'])('does not claim success for a refused %s edit', async kind => {
  const { store, panel } = setup(false), refuse = vi.spyOn(store, 'update').mockReturnValue(false); await run(panel, kind);
  expect(store.history.undoStack).toHaveLength(0); expect(document.querySelector('.toast.error')).toBeTruthy(); expect(announce.mock.calls.flat().join(' ')).not.toMatch(/words? cut|Removed \d/);
  refuse.mockRestore(); await run(panel, kind); expect(store.history.undoStack).toHaveLength(1);
});
it.each(['selection', 'fillers', 'pauses'])('keeps successful %s edits undoable and reopenable', async kind => {
  const { store, panel } = setup(false); await run(panel, kind); expect(document.querySelector('.toast.error')).toBeNull(); expect(store.history.undoStack).toHaveLength(1);
  expect(transcriptWords(store.project)).toHaveLength(kind === 'selection' ? 1 : kind === 'fillers' ? 2 : 3);
  const result = transcriptWords(store.project); store.undo(); expect(transcriptWords(store.project)).toHaveLength(3); store.redo(); expect(transcriptWords(normalizeProject(store.projectForSave()))).toEqual(result);
});

it.each(['button', 'Delete', 'Backspace'])('clears selection and places the cursor on the next word after a successful %s cut', how => {
  const { store, panel } = setup(false, true), body = panel.el.querySelector('.tr-words'), remove = [...panel.el.querySelectorAll('button')].find(b => b.textContent === 'Delete selection');
  if (how === 'button') remove.click(); else body.dispatchEvent(new KeyboardEvent('keydown', { key: how, bubbles: true }));
  expect(transcriptWords(store.project).map(w => w.text)).toEqual(['later', 'again']);
  expect(remove.disabled).toBe(true); expect(panel.el.querySelectorAll('.tr-word.sel')).toHaveLength(0); expect(panel.el.querySelector('.tr-sel-info').textContent).toBe(''); expect(panel.el.querySelector('.tr-word.cursor').textContent).toBe('later');
  body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true })); expect(store.history.undoStack).toHaveLength(1);
  store.undo(); expect(transcriptWords(store.project)).toHaveLength(4); store.redo(); expect(transcriptWords(normalizeProject(store.projectForSave()))).toHaveLength(2); expect(remove.disabled).toBe(true);
  body.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', shiftKey: true, bubbles: true })); expect(remove.disabled).toBe(false); expect(panel.el.querySelectorAll('.tr-word.sel')).toHaveLength(2);
});
