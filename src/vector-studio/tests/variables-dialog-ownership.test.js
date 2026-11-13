import { describe, expect, it, vi } from 'vitest';
import { VDocument } from '../src/model/document.js';
import { createText } from '../src/model/nodes.js';
import { VariablesPanel } from '../src/features/variables/panel.js';
import { addVariable, bind, variablesOf } from '../src/features/variables/model.js';

function setup() {
  const doc = VDocument.create();
  let variable;
  doc.transact('Setup', () => {
    const text = createText('Original', 0, 0);
    doc.insert(text, doc.layers()[0].id);
    variable = addVariable(doc, 'text', 'Title');
    bind(doc, text.id, 'text', variable.id);
  });
  // Opening another copy of a saved document preserves variable IDs.
  const other = VDocument.fromJSON(doc.toJSON());
  let resolve;
  const answer = new Promise((done) => { resolve = done; });
  const app = { editor: { doc }, notify: vi.fn(), dialogs: { form: () => answer, confirm: () => answer } };
  return { doc, other, variable, app, panel: new VariablesPanel(app), resolve };
}

const actions = [
  { name: 'new', run: (panel) => panel.newVariable(), answer: { name: 'New', type: 'text' } },
  { name: 'rename', run: (panel, variable) => panel.renameVariable(variable), answer: { name: 'Renamed' } },
  { name: 'delete', run: (panel, variable) => panel.deleteVariable(variable.id), answer: true },
];

describe('variable dialog ownership', () => {
  for (const action of actions) {
    it(`does not apply a ${action.name} answer to another document`, async () => {
      const { doc, other, variable, app, panel, resolve } = setup();
      const pending = action.run(panel, variable);
      app.editor = { doc: other };
      resolve(action.answer);
      await pending;
      expect(variablesOf(doc)).toEqual([variable]);
      expect(variablesOf(other)).toEqual([variable]);
      expect(other.undoStack).toHaveLength(0);
    });

    it(`keeps the normal ${action.name} operation undoable`, async () => {
      const { doc, variable, panel, resolve } = setup();
      const pending = action.run(panel, variable);
      resolve(action.answer);
      await pending;
      expect(variablesOf(doc)).not.toEqual([variable]);
      doc.undo();
      expect(variablesOf(doc)).toEqual([variable]);
    });
  }
});
