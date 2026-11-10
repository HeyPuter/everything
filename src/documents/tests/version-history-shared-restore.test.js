// @vitest-environment jsdom
import { it, expect, vi } from 'vitest';
import { TextDocument, paragraph } from '../src/engine/model.js';
import { StorySession } from '../src/engine/story-session.js';

const version = new TextDocument([paragraph('Old text from version 1')]);
vi.mock('../src/lib/engine-api.js', () => ({ engineApi: () => ({ openCanvasDocument: async () => ({ pkg: version, images: new Map() }) }) }));
vi.mock('../src/lib/puter.js', async (importOriginal) => ({ ...await importOriginal(), readFile: async () => ({ arrayBuffer: async () => new ArrayBuffer(4) }) }));
const { createVersionHistory } = await import('../src/views/version-history.js');

globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });

it('restores a version of a shared document through the room instead of replacing the file', async () => {
  const session = new StorySession(new TextDocument([paragraph('Current shared text')]));
  const engine = { session, images: new Map(), get model() { return session.model; }, finishComposition() {}, relayout() {}, paint() {}, focus() {}, undo() { session.undo(); },
    execute(action) { session.run(() => action(session.model)); return true; } };
  const restoreFile = vi.fn();
  const history = createVersionHistory({ editor: () => engine, pkg: () => ({}), doc: { path: 'Documents/Plan.docx' }, error: e => { throw e; }, live: () => ({}), restoreFile });
  const restoring = history.restore({ path: 'Documents/.versions/Plan/v1.docx', time: 1 });
  await vi.waitFor(() => expect(document.querySelector('.modal-panel')).not.toBeNull());
  [...document.querySelectorAll('.modal-panel button')].find(b => b.textContent === 'Restore').click();
  expect(await restoring).toBe(true);
  expect(restoreFile).not.toHaveBeenCalled();
  expect(engine.model.text).toBe('Old text from version 1');
  engine.undo();
  expect(engine.model.text).toBe('Current shared text');
});

it('the Restored toast’s Undo takes back the restore only while it is the latest change', async () => {
  document.body.replaceChildren();
  const session = new StorySession(new TextDocument([paragraph('Current shared text')]));
  const engine = { session, images: new Map(), get model() { return session.model; }, finishComposition() {}, relayout() {}, paint() {}, focus() {}, undo() { session.undo(); },
    execute(action) { session.run(() => action(session.model)); return true; } };
  const history = createVersionHistory({ editor: () => engine, pkg: () => ({}), doc: { path: 'Documents/Plan.docx' }, error: e => { throw e; }, live: () => ({}), restoreFile: vi.fn() });
  const restoring = history.restore({ path: 'Documents/.versions/Plan/v1.docx', time: 1 });
  await vi.waitFor(() => expect(document.querySelector('.modal-panel')).not.toBeNull());
  [...document.querySelectorAll('.modal-panel button')].find(b => b.textContent === 'Restore').click();
  expect(await restoring).toBe(true);
  const undo = [...document.querySelectorAll('.toast-action')].filter(b => b.textContent === 'Undo').at(-1);
  // An edit made after the restore: the toast's Undo would have taken it back and kept the version.
  session.run(model => { model.select(model.text.length); model.replace(' and more'); });
  undo.click();
  expect(engine.model.text).toBe('Old text from version 1 and more');
  // Unchanged since, it takes the restore back.
  session.run(model => { model.select(0, model.text.length); model.replace('Fresh text'); });
  const again = history.restore({ path: 'Documents/.versions/Plan/v1.docx', time: 1 });
  await vi.waitFor(() => expect(document.querySelector('.modal-panel:not(.closing)')).not.toBeNull());
  [...document.querySelectorAll('.modal-panel button')].filter(b => b.textContent === 'Restore').at(-1).click();
  expect(await again).toBe(true);
  expect(engine.model.text).toBe('Old text from version 1');
  [...document.querySelectorAll('.toast-action')].filter(b => b.textContent === 'Undo').at(-1).click();
  expect(engine.model.text).toBe('Fresh text');
});
