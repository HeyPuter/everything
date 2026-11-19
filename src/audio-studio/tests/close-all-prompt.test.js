import { afterEach, expect, it, vi } from 'vitest';
import { App } from '../src/app.js';
import { AudioFile } from '../src/model/audio-file.js';
import { installCoreCommands } from '../src/commands/core.js';

afterEach(() => document.body.replaceChildren());

function setup(n) {
  localStorage.clear();
  const app = new App();
  app.notify = vi.fn();
  app.syncGraph = () => {};
  installCoreCommands(app);
  const docs = Array.from({ length: n }, (_, i) => {
    const d = app.addDocument(AudioFile.blank({ name: `F${i}.wav`, sampleRate: 1000, channels: 1, seconds: 1 }));
    d.apply('Edit', { ...d.state, markers: [] });
    return d;
  });
  return { app, docs };
}

const prompt = () => [...document.querySelectorAll('.dialog')].pop();
const press = (label) => [...prompt().querySelectorAll('.dialog-foot button')].find((b) => b.textContent === label).click();

it("Close All asks once with Don't Save Any for several unsaved files", async () => {
  const { app, docs } = setup(3);
  expect(docs.every((d) => d.dirty)).toBe(true);
  const closing = app.commands.run('file.closeAll');
  await vi.waitFor(() => expect(prompt()?.textContent).toContain('2 more files have unsaved changes'));
  press("Don't Save Any");
  await closing;
  expect(app.documents).toHaveLength(0);
  expect(document.querySelectorAll('.dialog')).toHaveLength(0);
});

it('asks for each file when answered one at a time, and stops on Cancel', async () => {
  const { app } = setup(2);
  const closing = app.commands.run('file.closeAll');
  await vi.waitFor(() => expect(prompt()?.textContent).toContain('1 more file has unsaved changes'));
  press("Don't Save");
  await vi.waitFor(() => expect(app.documents).toHaveLength(1));
  // The last file: no "all" choices.
  await vi.waitFor(() => expect(prompt()?.textContent).not.toContain('more file'));
  expect([...prompt().querySelectorAll('.dialog-foot button')].map((b) => b.textContent)).not.toContain('Save All');
  press('Cancel');
  await closing;
  expect(app.documents).toHaveLength(1);
});
