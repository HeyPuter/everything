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
