// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { TextDocument, paragraph } from '../src/engine/model.js';
import { createLayoutTab } from '../src/views/layout-tab.js';
import { createLineNumbers } from '../src/views/line-numbers.js';

/** A stand-in for the canvas editor: the same transaction contract over a real document model. */
function fakeEditor(texts) {
  const doc = new TextDocument(texts.map(text => paragraph(text)));
  const engine = {
    model: doc, session: { body: doc, path: null },
    finishComposition() {}, focus() {}, editStory() {},
    execute(action, onFailure) {
      const before = doc.snapshot();
      try { action(); return true; } catch (e) { doc.restore(before); onFailure?.(e); return false; }
    },
    setPageSettings(patch, options) { return this.execute(() => doc.setPageSettings(patch, options)); },
  };
  return { doc, engine };
}

// Line Numbers > Continuous, Restart Each Page or Restart Each Section with a selection across sections gave every
// one of them the caret section's numbering, so a section counting by 5 from 10 was renumbered from 1 by 1.
it('changes how numbering restarts in each selected section, keeping each section\'s own count and start', () => {
  const { doc, engine } = fakeEditor(['One', 'Two', 'Three']);
  const error = vi.fn();
  const layout = createLayoutTab({ editor: () => engine, pkg: () => ({}), error });
  const { commands } = createLineNumbers({ editor: () => engine, pkg: () => ({}), error, commands: layout.commands });
  doc.select(4); doc.insertSectionBreak('nextPage');
  doc.select(doc.text.indexOf('Three')); doc.insertSectionBreak('nextPage');
  doc.select(doc.text.indexOf('Two'));
  commands.setLineNumbers({ countBy: 5, start: 9, distance: 720, restart: 'newSection' });
  doc.select(0);
  commands.setLineNumbers({ countBy: 1, start: 0, distance: null, restart: 'newPage' });
  const numbering = () => doc.sectionSettings.map(s => s.lineNumbers);
  expect(numbering()).toEqual([{ countBy: 1, start: 0, distance: null, restart: 'newPage' }, { countBy: 5, start: 9, distance: 720, restart: 'newSection' }, null]);
  doc.select(1, doc.text.length - 1);
  commands.lineNumberItems().find(i => i.label === 'Continuous').onSelect();
  expect(numbering()).toEqual([{ countBy: 1, start: 0, distance: null, restart: 'continuous' }, { countBy: 5, start: 9, distance: 720, restart: 'continuous' }, { countBy: 1, start: 0, distance: null, restart: 'continuous' }]);
  commands.lineNumberItems().find(i => i.label === 'None').onSelect();
  expect(numbering()).toEqual([null, null, null]);
  expect(error).not.toHaveBeenCalled();
});
