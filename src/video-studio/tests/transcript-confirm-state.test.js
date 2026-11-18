import { it, expect, afterEach } from 'vitest';
import { transcriptPanel } from '../src/ui/panels/transcript.js';
import { EditorStore } from '../src/model/store.js';
import { anchorWords, transcriptWords } from '../src/media/transcript.js';
import { mainTrack } from '../src/model/timeline.js';
import { normalizeProject } from '../src/model/project.js';
import { fixture, clip, onMain, s } from './helpers.js';
const panels = [];
afterEach(() => { panels.splice(0).forEach(p => p.dispose()); document.querySelectorAll('.dialog-close').forEach(b => b.click()); document.querySelector('.toasts')?.replaceChildren(); document.body.replaceChildren(); });
function project() {
  const p = fixture(); onMain(p, clip('video', 0, 4));
  p.transcript = { language: 'en', words: anchorWords(p, [{ text: 'um', start: s(.5), end: s(.8) }, { text: 'hello', start: s(1), end: s(1.3) }, { text: 'later', start: s(3), end: s(3.3) }]) }; return p;
}
function setup() { const store = new EditorStore(project()), panel = transcriptPanel({ store, player: null, library: {} }, { scope: 'all', language: 'en' }, () => {}); panels.push(panel); document.body.append(panel.el); return { store, panel }; }
function start(panel, kind) { [...panel.el.querySelectorAll('button')].find(b => b.textContent.startsWith(kind === 'fillers' ? 'Remove fillers' : 'Shorten pauses')).click(); }
async function answer(kind, yes = true) { const label = !yes ? 'Cancel' : kind === 'fillers' ? 'Remove' : 'Shorten'; [...document.querySelector('dialog[open]').querySelectorAll('button')].find(b => b.textContent === label).click(); for (let i = 0; i < 20; i++) await Promise.resolve(); }
for (const kind of ['fillers', 'pauses']) {
  it.each(['transcript', 'move', 'project', 'asset'])(`rejects the old ${kind} confirmation after a %s change`, async change => {
    const { store, panel } = setup(); start(panel, kind);
    if (change === 'project') store.load(project());
    else store.update(change, p => { if (change === 'transcript') p.transcript.words.unshift({ text: 'New', start: 0, end: s(.3) }); if (change === 'move') mainTrack(p).clips[0].start = s(5); if (change === 'asset') p.assets.vid.hash = 'replacement'; });
    const before = JSON.stringify(store.projectForSave()), history = store.history.undoStack.length; await answer(kind);
    expect(JSON.stringify(store.projectForSave())).toBe(before); expect(store.history.undoStack).toHaveLength(history); expect(document.body.textContent).toContain('Timeline or transcript changed'); expect(document.querySelector('.toast.success')).toBeNull();
  });
  it(`allows unrelated changes and keeps normal ${kind} cuts undoable`, async () => {
    const { store, panel } = setup(); start(panel, kind); store.update('Rename', p => { p.name = 'Renamed'; p.assets.unused = { ...p.assets.vid, id: 'unused' }; }); store.seek(s(.5)); store.clearSelection(); await answer(kind);
    expect(store.history.undoStack).toHaveLength(2); expect(store.project.name).toBe('Renamed'); const result = transcriptWords(store.project); store.undo(); expect(transcriptWords(store.project)).toHaveLength(3); store.redo(); expect(transcriptWords(normalizeProject(store.projectForSave()))).toEqual(result);
  });
  it(`can retry ${kind} after rejecting an obsolete confirmation`, async () => {
    const { store, panel } = setup(); start(panel, kind); store.update('Move', p => { mainTrack(p).clips[0].start = s(5); }); await answer(kind); expect(store.history.undoStack).toHaveLength(1);
    start(panel, kind); await answer(kind); expect(store.history.undoStack).toHaveLength(2); expect(mainTrack(store.project).clips.reduce((n,c) => n+c.duration,0)).toBeLessThan(s(4));
  });
  it(`keeps cancellation harmless even after the ${kind} source changes`, async () => {
    const { store, panel } = setup(); start(panel, kind); store.update('Move', p => { mainTrack(p).clips[0].start = s(5); }); const before = JSON.stringify(store.projectForSave()); await answer(kind, false); expect(JSON.stringify(store.projectForSave())).toBe(before); expect(document.querySelector('.toast.error')).toBeNull();
  });
}
it.each(['fillers', 'pauses'])('does not apply %s cuts after a later queued transcript edit', async kind => {
  const { store, panel } = setup(); start(panel, kind); let before, history;
  const label = kind === 'fillers' ? 'Remove' : 'Shorten';
  const confirm = [...document.querySelector('dialog[open]').querySelectorAll('button')].find(b => b.textContent === label);
  confirm.addEventListener('click', () => queueMicrotask(() => queueMicrotask(() => {
    store.update('Queued transcript edit', p => { p.transcript.words.unshift({ text: 'Keep this', start: 0, end: s(.3) }); });
    before = JSON.stringify(store.projectForSave()); history = store.history.undoStack.length;
  })));
  await answer(kind); expect(before).toBeTypeOf('string'); expect(JSON.stringify(store.projectForSave())).toBe(before); expect(store.history.undoStack).toHaveLength(history);
});
