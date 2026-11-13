import { it, expect, vi } from 'vitest';
import { EditorStore } from '../src/model/store.js';
import { addTrack } from '../src/model/timeline.js';
import { openHighlightsDialog } from '../src/ui/highlights-dialog.js';
import { transcriptPanel } from '../src/ui/panels/transcript.js';
import { fixture, clip, onMain } from './helpers.js';
vi.mock('../src/media/transcribe.js', async original => ({ ...await original(), mixdown: vi.fn(async () => new Float32Array(16000)) }));
it('does not use the base video transcript for a newly added overlapping source video', async () => {
  const p = fixture(); p.assets.vid.duration = 200e6; onMain(p, clip('video', 0, 120));
  p.assets.other = { ...p.assets.vid, id: 'other', hash: 'other-video-content', name: 'Different talk' };
  let prefix = 'base'; const words = () => Array.from({ length: 240 }, (_, i) => ({ text: `${prefix}${i}.`, start: i * .5, end: i * .5 + .4 }));
  const ai = vi.fn(async () => ({ words: words() })); vi.stubGlobal('puter', { ai: { speech2txt: ai } });
  const store = new EditorStore(p), ctx = { store, library: { backend: { kind: 'puter' } }, player: null, account: {} }, panel = transcriptPanel(ctx, { language: 'en', scope: 'main' }, () => {}); document.body.append(panel.el);
  let d; const chat = vi.fn(async () => '{"highlights":[{"title":"First","start":20,"end":59}]}');
  try {
    [...panel.el.querySelectorAll('button')].find(b => b.textContent === 'Transcribe').click(); await vi.waitFor(() => expect(store.project.transcript?.words[0]?.a).toBe('vid'));
    const other = clip('video', 0, 120, { assetId: 'other' }); store.update('Add another talk', p => { addTrack(p, 'video').clips.push(other); }); store.select([other.id]); prefix = 'selected';
    d = openHighlightsDialog(ctx, { chat }); expect(d.el.textContent).toContain('Different talk'); await d.search(); expect(chat.mock.calls[0][0]).toContain('selected20'); expect(d.words[0].text).toBe('selected0.');
  } finally { d?.close(); panel.dispose(); vi.unstubAllGlobals(); document.querySelectorAll('.toast').forEach(t => t.remove()); document.body.replaceChildren(); }
});
