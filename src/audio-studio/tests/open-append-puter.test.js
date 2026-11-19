import { afterEach, expect, it, vi } from 'vitest';
import { App } from '../src/app.js';
import { AudioFile } from '../src/model/audio-file.js';
import { installCoreCommands } from '../src/commands/core.js';

afterEach(() => delete window.puter);

it('Open Append picks files from Puter when signed in, like Open', async () => {
  localStorage.clear();
  const app = new App();
  installCoreCommands(app);
  app.addDocument(AudioFile.blank({ name: 'A.wav', sampleRate: 8000, channels: 1, seconds: 1 }));
  const showOpenFilePicker = vi.fn(async () => []);
  window.puter = { auth: { isSignedIn: () => true }, ui: { showOpenFilePicker } };
  await app.commands.run('file.appendCurrent');
  await app.commands.run('file.appendNew');
  expect(showOpenFilePicker).toHaveBeenCalledTimes(2);
  expect(showOpenFilePicker.mock.calls[0][0]).toMatchObject({ multiple: true });
});
