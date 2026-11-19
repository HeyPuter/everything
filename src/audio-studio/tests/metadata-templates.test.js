import { afterEach, expect, it, vi } from 'vitest';
import { Prefs } from '../src/lib/prefs.js';
import { metaTemplates, saveMetaTemplate, deleteMetaTemplate, applyMetaTemplate } from '../src/panels/metadata-templates.js';

afterEach(() => document.body.replaceChildren());

it('saves templates without per-file fields and applies them over a file', () => {
  const prefs = new Prefs(null);
  saveMetaTemplate(prefs, ' Station ', { bextOriginator: 'Radio 1', copyright: 'Radio 1 Ltd', bextUmid: 'AB'.repeat(32), title: '' });
  expect(metaTemplates(prefs)).toEqual([{ name: 'Station', meta: { bextOriginator: 'Radio 1', copyright: 'Radio 1 Ltd' } }]);
  // Same name, any case: replaced.
  saveMetaTemplate(prefs, 'station', { artist: 'Host' });
  expect(metaTemplates(prefs).map((t) => t.name)).toEqual(['station']);
  const t = { name: 'S', meta: { copyright: 'New', artist: 'Host' } };
  expect(applyMetaTemplate({ title: 'Show 12', copyright: 'Old', bextUmid: 'X' }, t)).toEqual({ title: 'Show 12', copyright: 'New', artist: 'Host', bextUmid: 'X' });
  expect(applyMetaTemplate({ title: 'Show 12', bextUmid: 'X' }, t, { replace: true })).toEqual({ title: 'Show 12', copyright: 'New', artist: 'Host', bextUmid: 'X' });
  deleteMetaTemplate(prefs, 'station');
  expect(metaTemplates(prefs)).toEqual([]);
});

it('saves and applies templates from the Metadata panel as one undo step', async () => {
  localStorage.clear();
  const { App } = await import('../src/app.js');
  const { AudioFile } = await import('../src/model/audio-file.js');
  const { metadataPanel } = await import('../src/panels/metadata.js');
  const app = new App();
  const a = app.addDocument(AudioFile.blank({ name: 'A.wav', sampleRate: 8000, channels: 1, seconds: 1 }));
  a.apply('Meta', { ...a.state, meta: { copyright: '2026 Me', title: 'A' } });
  const panel = metadataPanel(app);
  document.body.append(panel.el);
  panel.show();
  const bar = panel.el.querySelector('.meta-templates');
  [...bar.querySelectorAll('button')].find((b) => b.textContent === 'Save...').click();
  await vi.waitFor(() => expect(document.querySelector('.dialog input')).not.toBeNull());
  document.querySelector('.dialog input').value = 'Mine';
  document.querySelector('.dialog-foot .btn.primary').click();
  await vi.waitFor(() => expect(metaTemplates(app.prefs).map((t) => t.name)).toEqual(['Mine']));
  expect(metaTemplates(app.prefs)[0].meta).toEqual({ copyright: '2026 Me' });
  const b = app.addDocument(AudioFile.blank({ name: 'B.wav', sampleRate: 8000, channels: 1, seconds: 1 }));
  app.activate(b);
  panel.show();
  const sel = bar.querySelector('select');
  sel.value = 'Mine';
  sel.dispatchEvent(new Event('change'));
  [...bar.querySelectorAll('button')].find((x) => x.textContent === 'Apply').click();
  expect(b.state.meta).toEqual({ copyright: '2026 Me' });
  b.history.undo();
  expect(b.state.meta || {}).toEqual({});
});
