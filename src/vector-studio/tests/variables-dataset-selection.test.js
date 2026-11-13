import { describe, expect, it, vi } from 'vitest';
import { bootApp } from './helpers.js';
import { createText } from '../src/model/nodes.js';
import { addVariable, bind } from '../src/features/variables/model.js';
import { VariablesPanel, LIBRARY_FORMAT } from '../src/features/variables/panel.js';

describe('Variables data set selection', () => {
  it('does not claim an unapplied library data set is already selected', async () => {
    const app = await bootApp();
    const ed = app.newDocument();
    const doc = ed.doc;
    const node = createText('Original', 10, 10);
    doc.transact('Set up', () => {
      doc.insert(node, ed.targetLayer().id);
      const variable = addVariable(doc, 'text', 'Title');
      bind(doc, node.id, 'text', variable.id);
    });
    const panel = new VariablesPanel(app);
    panel.ensureBuilt();
    await panel.loadLibrary({ text: async () => JSON.stringify({
      format: LIBRARY_FORMAT,
      variables: [{ id: 'title', name: 'Title', type: 'text' }],
      dataSets: [{ name: 'First', values: { title: 'First artwork' } }],
    }) });
    panel.update();
    expect(doc.get(node.id).text).toBe('Original');
    expect(panel.dsSelect.value).toBe('');
    expect(panel.dsSelect.disabled).toBe(false);
    // The first (and only) data set must be a change from the placeholder.
    panel.dsSelect.value = doc.root.dataSets[0].id;
    panel.dsSelect.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(doc.get(node.id).text).toBe('First artwork'));
    panel.update();
    expect(panel.dsSelect.value).toBe(doc.root.dataSet);
    expect(panel.dsSelect.options).toHaveLength(1);
    doc.undo();
    panel.update();
    expect(doc.get(node.id).text).toBe('Original');
    expect(panel.dsSelect.value).toBe('');
  });
});
