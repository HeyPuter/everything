import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { EditorStore } from '../src/model/store.js';
import { openHighlightsDialog } from '../src/ui/highlights-dialog.js';
import { setPref } from '../src/ui/prefs.js';
import { mixdown, transcribeMix } from '../src/media/transcribe.js';
import { reframePlan } from '../src/ui/smart-actions.js';
import { fixture, clip, onMain } from './helpers.js';
vi.mock('../src/media/transcribe.js', async original => ({ ...await original(), mixdown: vi.fn(), transcribeMix: vi.fn() }));
vi.mock('../src/ui/smart-actions.js', async original => ({ ...await original(), reframePlan: vi.fn() }));
const dialogs = [], reply = '{"highlights":[{"title":"First","start":20,"end":59},{"title":"Second","start":100,"end":139}]}';
const words = Array.from({ length: 240 }, (_, i) => ({ text: `word${i}${i % 10 === 9 ? '.' : ''}`, start: i * .5, end: i * .5 + .4 }));
const defer = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const button = (d, text) => [...d.el.querySelectorAll('button')].find(b => b.textContent === text);
const select = (d, name, value) => { const el = d.el.querySelector(`[aria-label="${name}"]`); el.value = value; el.dispatchEvent(new Event('change')); };
beforeEach(() => {
  setPref('highlights', { target: 'projects', shape: 'keep' });
  mixdown.mockReset().mockResolvedValue(new Float32Array(16000));
  transcribeMix.mockReset().mockImplementation(async (_mix, _rate, { signal }) => { signal.throwIfAborted(); return words; });
  reframePlan.mockReset().mockResolvedValue(null);
});
afterEach(() => { dialogs.splice(0).forEach(d => d.close()); document.querySelectorAll('.toast').forEach(t => t.remove()); document.body.replaceChildren(); vi.restoreAllMocks(); });
function setup(stage) {
  const p = fixture(); p.assets.vid.duration = 200e6; onMain(p, clip('video', 0, 120));
  if (!['audio', 'speech'].includes(stage)) p.transcript = { language: 'en', words: words.map(w => ({ ...w, start: w.start * 1e6, end: w.end * 1e6 })) };
  const store = new EditorStore(p), library = { mediaBlob: vi.fn(async () => new Blob()), saveProject: vi.fn(async () => {}) }, chat = vi.fn(async () => reply);
  const d = openHighlightsDialog({ store, library }, { chat }); dialogs.push(d); return { d, store, library, chat };
}
async function start(e, stage, pending) {
  let target, value;
  if (stage === 'chat') { target = e.chat; value = reply; }
  if (stage === 'audio') { target = mixdown; value = new Float32Array(16000); }
  if (stage === 'speech') { target = transcribeMix; value = words; }
  if (['media', 'reframe', 'save'].includes(stage)) {
    await e.d.search(); if (stage !== 'save') select(e.d, 'Frame shape', '9:16');
    target = stage === 'media' ? e.library.mediaBlob : stage === 'reframe' ? reframePlan : e.library.saveProject;
    value = stage === 'media' ? new Blob() : null;
  }
  target.mockReturnValueOnce(pending.promise);
  const run = ['media', 'reframe', 'save'].includes(stage) ? e.d.make() : e.d.search();
  await vi.waitFor(() => expect(target).toHaveBeenCalled()); return { run, value };
}
it.each(['chat', 'audio', 'speech', 'media', 'reframe', 'save'])('acknowledges Stop immediately during %s and permits retry after settlement', async stage => {
  const e = setup(stage), pending = defer(), { run, value } = await start(e, stage, pending);
  try {
    const stop = button(e.d, 'Stop'); stop.focus(); stop.click();
    expect(e.d.el.querySelector('[role="status"]').textContent).toBe('Stopping...'); expect(stop.textContent).toBe('Close'); expect(document.activeElement).toBe(stop);
    const calls = e.chat.mock.calls.length, saves = e.library.saveProject.mock.calls.length;
    await e.d.search(); await e.d.make(); expect(e.chat).toHaveBeenCalledTimes(calls); expect(e.library.saveProject).toHaveBeenCalledTimes(saves);
    // Late provider progress must not replace cancellation feedback.
    if (stage === 'audio') mixdown.mock.calls[0][2].onProgress(.75);
    if (stage === 'speech') transcribeMix.mock.calls[0][2].onProgress(.75);
    if (stage === 'reframe') reframePlan.mock.calls[0][3].onProgress(.75);
    expect(e.d.el.querySelector('[role="status"]').textContent).toBe('Stopping...');
  } finally { pending.resolve(value); await run; }
  expect(e.d.el.isConnected).toBe(true); expect(document.querySelector('.toast.success')).toBeNull();
  if (['media', 'reframe', 'save'].includes(stage)) {
    expect(e.d.el.dataset.step).toBe('results'); expect(e.library.saveProject).toHaveBeenCalledTimes(stage === 'save' ? 1 : 0);
    if (stage === 'save') expect(document.querySelector('.toast.info')?.textContent).toContain('Stopped after 1 project');
    select(e.d, 'Frame shape', 'keep'); await e.d.make(); expect(e.library.saveProject).toHaveBeenCalledTimes(stage === 'save' ? 3 : 2);
  } else { expect(e.d.el.dataset.step).toBe('options'); await e.d.search(); expect(e.d.found).toHaveLength(2); }
});
it.each(['chat', 'speech', 'media', 'save'])('footer Close works while stopped %s remains pending', async stage => {
  const opener = document.createElement('button'); document.body.append(opener); opener.focus();
  const e = setup(stage), pending = defer(), { run, value } = await start(e, stage, pending);
  try {
    button(e.d, 'Stop').click(); const footer = e.d.el.querySelector('.dialog-actions');
    [...footer.querySelectorAll('button')].find(b => b.textContent === 'Close')?.click();
    expect(e.d.el.isConnected).toBe(false); expect(document.activeElement).toBe(opener);
    const html = e.d.el.innerHTML; pending.resolve(value); await run; expect(e.d.el.innerHTML).toBe(html); expect(document.querySelector('.toast.success')).toBeNull();
  } finally { pending.resolve(value); await run; }
});
it.each(['chat', 'speech', 'save'])('suppresses a late %s error after Stop', async stage => {
  const e = setup(stage), pending = defer(), errors = vi.spyOn(console, 'error').mockImplementation(() => {}), { run } = await start(e, stage, pending);
  button(e.d, 'Stop').click(); pending.reject(new Error('Late failure')); await run;
  expect(errors).not.toHaveBeenCalled(); expect(document.querySelector('.toast.error')).toBeNull(); expect(e.d.el.isConnected).toBe(true);
});
it('keeps ordinary Cancel and successful search/creation working', async () => {
  const canceled = setup(); button(canceled.d, 'Cancel').click(); expect(canceled.d.el.isConnected).toBe(false); expect(canceled.chat).not.toHaveBeenCalled();
  const e = setup(); await e.d.search(); expect(e.d.found).toHaveLength(2); await e.d.make(); expect(e.library.saveProject).toHaveBeenCalledTimes(2); expect(e.d.el.isConnected).toBe(false); expect(document.querySelector('.toast.success')).not.toBeNull();
});
