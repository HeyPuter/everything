import { afterEach, expect, it } from 'vitest';
import { App } from '../src/app.js';
import { installCoreCommands } from '../src/commands/core.js';
import { parseRate } from '../src/ui/rate-field.js';

afterEach(() => document.body.replaceChildren());

it('reads typed sample rates', () => {
  expect(parseRate('48000')).toBe(48000);
  expect(parseRate(' 37800 Hz')).toBe(37800);
  expect(parseRate('44100.5')).toBe(null);
  expect(parseRate('100')).toBe(null);
  expect(parseRate('')).toBe(null);
});

it('creates a new audio file at any typed rate and refuses one out of range', async () => {
  localStorage.clear();
  const app = new App();
  app.notify = () => {};
  installCoreCommands(app);
  const done = app.commands.run('file.newAudio');
  const dialog = [...document.querySelectorAll('.dialog')].pop();
  const rate = dialog.querySelector('[aria-label="Sample rate (Hz)"]');
  expect(rate.value).toBe('48000');
  rate.value = '50';
  dialog.querySelector('.dialog-foot .btn.primary').click();
  expect(dialog.isConnected).toBe(true);
  expect(dialog.querySelector('.dlg-error').textContent).toContain('3000');
  rate.value = '37800';
  dialog.querySelector('.dialog-foot .btn.primary').click();
  await done;
  expect(app.active.sampleRate).toBe(37800);
  expect(app.prefs.get('defaultRate')).toBe(37800);
});
