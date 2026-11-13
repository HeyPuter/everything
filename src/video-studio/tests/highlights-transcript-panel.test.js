import { it, expect, vi } from 'vitest';
import { EditorStore } from '../src/model/store.js';
import { openHighlightsDialog } from '../src/ui/highlights-dialog.js';
import { transcriptPanel } from '../src/ui/panels/transcript.js';
import { fixture, clip, onMain } from './helpers.js';
vi.mock('../src/media/transcribe.js', async original => ({ ...await original(), mixdown: vi.fn(async () => new Float32Array(16000)) }));
it('uses the replacement transcript when a pending panel transcription finishes', async () => {
  const p = fixture(); p.assets.vid.duration = 200e6; onMain(p, clip('video', 0, 120));
  const words = prefix => Array.from({ length: 240 }, (_, i) => ({ text: `${prefix}${i}${i % 10 === 9 ? '.' : ''}`, start: i * .5, end: i * .5 + .4 }));
  p.transcript = { language: 'en', words: words('old').map(w => ({ ...w, start: w.start * 1e6, end: w.end * 1e6 })) };
  let release; const pending = new Promise(r => { release = r; }), ai = vi.fn(() => pending); vi.stubGlobal('puter', { ai: { speech2txt: ai } });
  const store = new EditorStore(p), ctx = { store, library: { backend: { kind: 'puter' } }, player: null, account: {} }, panel = transcriptPanel(ctx, { language: 'en', scope: 'all' }, () => {}); document.body.append(panel.el);
  let d; const chat = vi.fn(async () => '{"highlights":[{"title":"First","start":20,"end":59}]}');
  try {
    panel.el.querySelector('[aria-label="More transcript options"]').click();
    [...document.querySelectorAll('[role="menuitem"]')].find(b => b.textContent.includes('Transcribe again')).click();
    await vi.waitFor(() => expect(ai).toHaveBeenCalledOnce()); store.undo();
    d = openHighlightsDialog(ctx, { chat }); await d.search(); expect(d.words[0].text).toBe('old0');
    release({ words: words('new') }); await vi.waitFor(() => expect(store.project.transcript.words[0].text).toBe('new0'));
    [...d.el.querySelectorAll('button')].find(b => b.textContent === 'Search again').click(); await d.search();
    expect(chat.mock.calls[1][0]).toContain('new20');
  } finally { d?.close(); panel.dispose(); vi.unstubAllGlobals(); document.querySelectorAll('.toast').forEach(t => t.remove()); document.body.replaceChildren(); }
});
