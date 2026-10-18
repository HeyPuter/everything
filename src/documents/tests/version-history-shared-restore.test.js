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
