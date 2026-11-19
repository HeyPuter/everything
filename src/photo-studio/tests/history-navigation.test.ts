import { expect, it } from 'vitest';
import { History } from '../src/history/history';
import { newDocument } from '../src/model/document';

for (const target of [0, 1]) it(`retains history row ${target} while a new edit reaches the limit`, () => {
  const h = new History(newDocument(16, 12, 'Original'), 1);
  h.execute('First', (d) => { d.name = 'First'; });
  const position = h.holdPosition(target);
  h.execute('Second', (d) => { d.name = 'Second'; });
  position.restore();
  position.release();
  expect(h.document.name).toBe(target ? 'First' : 'Original');
  expect(h.redoLabels).toEqual(target ? ['Second'] : ['First', 'Second']);
  while (h.canRedo) h.redo();
  expect(h.document.name).toBe('Second');
  h.execute('Third', (d) => { d.name = 'Third'; });
  expect(h.labels).toEqual(['Third']);
});

it('releases an abandoned navigation once and resumes normal history trimming', () => {
  const h = new History(newDocument(), 1);
  h.execute('First', (d) => { d.name = 'First'; });
  const position = h.holdPosition(0);
  h.execute('Second', (d) => { d.name = 'Second'; });
  position.release();
  position.release();
  expect(h.labels).toEqual(['Second']);
  h.execute('Third', (d) => { d.name = 'Third'; });
  expect(h.labels).toEqual(['Third']);
});

it('reports an invalidated redo row instead of selecting a different state', () => {
  const h = new History(newDocument());
  h.execute('First', (d) => { d.name = 'First'; });
  h.undo();
  const position = h.holdPosition(1);
  h.execute('Second', (d) => { d.name = 'Second'; });
  expect(() => position.restore()).toThrow('no longer available');
  position.release();
  expect(h.document.name).toBe('Second');
});

it('a run marked after a step never merges its first edit into that step', () => {
  const h = new History(newDocument(16, 12, 'Original'));
  h.execute('Frame', (d) => { d.name = 'Frame 1'; }, true);
  const mark = h.mark();
  h.execute('Frame', (d) => { d.name = 'Frame 2'; }, true);
  h.execute('Other', (d) => { d.width = 20; });
  expect(h.squash(mark, 'Script')).toBe(true);
  expect(h.labels).toEqual(['Frame', 'Script']);
  h.undo();
  // Undoing the run returns to the step before it, as it was.
  expect([h.document.name, h.document.width]).toEqual(['Frame 1', 16]);
  // A run continuing its own step (resume) still joins it.
  h.redo();
  const again = h.resume('Script');
  h.execute('Script', (d) => { d.name = 'Frame 3'; }, true);
  h.squash(again, 'Script');
  expect(h.labels).toEqual(['Frame', 'Script']);
  h.undo();
  expect(h.document.name).toBe('Frame 1');
});
