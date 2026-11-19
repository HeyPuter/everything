import { afterEach, expect, it, vi } from 'vitest';
import { Prefs } from '../src/lib/prefs.js';
import { userTemplates, saveTemplate, renameTemplate, templateFileText, parseTemplateFile, templateFromState } from '../src/multitrack/templates.js';
import { createSessionState } from '../src/model/session-edits.js';
import { preferencesDialog } from '../src/ui/preferences.js';

afterEach(() => document.body.replaceChildren());

const template = (label) => templateFromState(createSessionState({ sampleRate: 48000, tracks: 3 }), label);

it('renames, exports and imports templates', () => {
  const prefs = new Prefs(null);
  const a = { ...template('Podcast'), id: 'a' };
  const b = { ...template('Band'), id: 'b' };
  saveTemplate(prefs, a);
  saveTemplate(prefs, b);
  // Taking another template's name replaces it.
  renameTemplate(prefs, 'b', 'podcast');
  expect(userTemplates(prefs).map((t) => [t.id, t.label])).toEqual([['b', 'podcast']]);
  const back = parseTemplateFile(templateFileText(a));
  expect(back.label).toBe('Podcast');
  expect(back.tracks).toEqual(a.tracks);
  expect(back.id).not.toBe('a');
  expect(() => parseTemplateFile('{"type":"x"}')).toThrow('not a session template');
  expect(() => parseTemplateFile('nope')).toThrow('not a session template');
});

it('lists saved templates in Preferences > Media & Disk Cache and deletes them', async () => {
  localStorage.clear();
  const prefs = new Prefs(null);
  saveTemplate(prefs, { ...template('Interview'), id: 'i' });
  const app = { prefs, commands: { isEnabled: () => false, run() {}, get: () => null }, notify: vi.fn(), preferenceSections: [] };
  const pending = preferencesDialog(app, { category: 'cache' });
  await vi.waitFor(() => expect(document.querySelector('.prefs-template')).not.toBeNull());
  expect(document.querySelector('.prefs-template').textContent).toContain('Interview');
  expect(document.querySelector('.prefs-template').textContent).toContain('3 tracks');
  document.querySelector('[aria-label="Delete Interview"]').click();
  await vi.waitFor(() => expect([...document.querySelectorAll('.dialog-foot button')].some((b) => b.textContent === 'Delete')).toBe(true));
  [...document.querySelectorAll('.dialog-foot button')].find((b) => b.textContent === 'Delete').click();
  await vi.waitFor(() => expect(document.querySelector('.prefs-template')).toBeNull());
  expect(userTemplates(prefs)).toEqual([]);
  // Cancel brings the template back with every other preference.
  [...document.querySelectorAll('.dialog-foot button')].find((b) => b.textContent === 'Cancel').click();
  await pending;
  expect(userTemplates(prefs).map((t) => t.label)).toEqual(['Interview']);
});
