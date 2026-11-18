import { it, expect, afterEach } from 'vitest';
import { transcriptPanel } from '../src/ui/panels/transcript.js';
import { EditorStore } from '../src/model/store.js';
import { anchorWords } from '../src/media/transcript.js';
import { fixture, clip, onMain, s } from './helpers.js';
const panels = [];
afterEach(() => { panels.splice(0).forEach(p => p.dispose()); document.querySelectorAll('.dialog-close').forEach(b => b.click()); document.querySelector('.toasts')?.replaceChildren(); document.body.replaceChildren(); });
function setup() {
  const p = fixture(); onMain(p, clip('video', 0, 4)); p.transcript = { language: 'en', words: anchorWords(p, [{ text: 'um', start: s(.5), end: s(.8) }, { text: 'hello', start: s(1), end: s(1.3) }, { text: 'later', start: s(3), end: s(3.3) }]) };
  const store = new EditorStore(p), panel = transcriptPanel({ store, player: null, library: {} }, { scope: 'all', language: 'en' }, () => {}); panels.push(panel); document.body.append(panel.el);
  const body = panel.el.querySelector('.tr-words'); body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true })); body.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', shiftKey: true, bubbles: true })); return { store, panel };
}
const button = (panel, kind) => [...panel.el.querySelectorAll('button')].find(b => b.textContent.startsWith(kind === 'selection' ? 'Delete selection' : kind === 'fillers' ? 'Remove fillers' : 'Shorten pauses'));
const confirm = kind => [...document.querySelector('dialog[open]').querySelectorAll('button')].find(b => b.textContent === (kind === 'fillers' ? 'Remove' : 'Shorten'));
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
it.each(['fillers', 'pauses'])('closes pending %s confirmation and rejects its retained button when disposed', async kind => {
  const { store, panel } = setup(); button(panel, kind).click(); const yes = confirm(kind), before = JSON.stringify(store.projectForSave()); panel.dispose(); const closed = !document.querySelector('dialog[open]'); yes.click(); await flush();
  expect(closed).toBe(true); expect(JSON.stringify(store.projectForSave())).toBe(before); expect(store.history.undoStack).toHaveLength(0); expect(document.querySelector('.toast.success')).toBeNull();
});
it.each(['selection', 'fillers', 'pauses'])('ignores retained %s actions after disposal', async kind => {
  const { store, panel } = setup(); const action = button(panel, kind), before = JSON.stringify(store.projectForSave()); panel.dispose(); action.click(); await flush(); const opened = !!document.querySelector('dialog[open]'); if (opened) confirm(kind).click(); await flush();
  expect(opened).toBe(false); expect(JSON.stringify(store.projectForSave())).toBe(before); expect(store.history.undoStack).toHaveLength(0); expect(document.querySelector('.toast.success')).toBeNull();
});
it.each(['fillers', 'pauses'])('rejects %s acceptance if disposal happens before the confirmation continuation', async kind => {
  const { store, panel } = setup(); button(panel, kind).click(); const before = JSON.stringify(store.projectForSave()); confirm(kind).click(); panel.dispose(); await flush();
  expect(JSON.stringify(store.projectForSave())).toBe(before); expect(store.history.undoStack).toHaveLength(0); expect(document.querySelector('.toast.success')).toBeNull();
});
it.each(['fillers', 'pauses'])('lets a new panel confirm %s after an old panel is disposed', async kind => {
  const old = setup(); button(old.panel, kind).click(); old.panel.dispose(); const fresh = setup(); button(fresh.panel, kind).click();
  const dialogs = document.querySelectorAll('dialog[open]'); const last = dialogs[dialogs.length - 1]; [...last.querySelectorAll('button')].find(b => b.textContent === (kind === 'fillers' ? 'Remove' : 'Shorten')).click(); await flush();
  expect(document.querySelector('dialog[open]')).toBeNull(); expect(old.store.history.undoStack).toHaveLength(0); expect(fresh.store.history.undoStack).toHaveLength(1);
});
