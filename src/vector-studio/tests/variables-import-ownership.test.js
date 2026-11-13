import { afterEach, describe, expect, it, vi } from 'vitest';
import { VDocument } from '../src/model/document.js';
import { VariablesPanel, LIBRARY_FORMAT } from '../src/features/variables/panel.js';
import { variablesOf, dataSetsOf } from '../src/features/variables/model.js';

const library = JSON.stringify({ format: LIBRARY_FORMAT, variables: [{ id: 'title', name: 'Title', type: 'text' }], dataSets: [{ name: 'One', values: { title: 'Hello' } }] });
function setup() {
  const doc = VDocument.create();
  const other = VDocument.create();
  const app = { editor: { doc }, notify: vi.fn() };
  const panel = new VariablesPanel(app);
  let resolve;
  const text = new Promise((done) => { resolve = done; });
  return { doc, other, app, panel, resolve, file: { text: () => text } };
}

afterEach(() => {
  vi.restoreAllMocks();
  document.querySelectorAll('input[type="file"]').forEach((el) => el.remove());
});

describe('variable import ownership', () => {
  it('does not load a delayed library into a different document', async () => {
    const { doc, other, app, panel, file, resolve } = setup();
    const loading = panel.loadLibrary(file);
    app.editor = { doc: other };
    resolve(library);
    expect(await loading).toBe(0);
    expect(variablesOf(doc)).toEqual([]);
    expect(variablesOf(other)).toEqual([]);
    expect(other.undoStack).toHaveLength(0);
  });

  it('loads a library normally and keeps it undoable', async () => {
    const { doc, panel, file, resolve } = setup();
    const loading = panel.loadLibrary(file);
    resolve(library);
    expect(await loading).toBe(1);
    expect(variablesOf(doc)[0].name).toBe('Title');
    expect(dataSetsOf(doc)).toHaveLength(1);
    doc.undo();
    expect(variablesOf(doc)).toEqual([]);
    expect(dataSetsOf(doc)).toEqual([]);
  });

  it('imports CSV normally and applies the first data set', async () => {
    const { doc, panel, file, resolve } = setup();
    vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {});
    panel.importData();
    const input = document.querySelector('input[type="file"]');
    Object.defineProperty(input, 'files', { value: [file] });
    input.dispatchEvent(new Event('change'));
    resolve('Title\nHello\n');
    await vi.waitFor(() => expect(doc.root.dataSet).toBeTruthy());
    expect(variablesOf(doc)[0].name).toBe('Title');
    expect(dataSetsOf(doc)).toHaveLength(1);
    expect(input.isConnected).toBe(false);
    doc.undo(); // apply
    doc.undo(); // import
    expect(variablesOf(doc)).toEqual([]);
  });

  it.each(['before choosing', 'while reading'])('does not import CSV into another document after switching %s', async (when) => {
    const { doc, other, app, panel, file, resolve } = setup();
    vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {});
    panel.importData();
    const input = document.querySelector('input[type="file"]');
    if (when === 'before choosing') app.editor = { doc: other };
    Object.defineProperty(input, 'files', { value: [file] });
    input.dispatchEvent(new Event('change'));
    if (when === 'while reading') app.editor = { doc: other };
    resolve('Title\nHello\n');
    await new Promise((done) => setTimeout(done, 0));
    expect(variablesOf(doc)).toEqual([]);
    expect(variablesOf(other)).toEqual([]);
    expect(other.undoStack).toHaveLength(0);
    expect(app.notify).not.toHaveBeenCalled();
  });
});
