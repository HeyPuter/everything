import { describe, it, expect, vi, afterEach } from 'vitest';
import { bootApp, bootAppWithFeatures } from './helpers.js';
import { createPath } from '../src/model/nodes.js';
import { rectangle } from '../src/model/shapes.js';

afterEach(() => vi.restoreAllMocks());

describe('Command errors', () => {
  it('shows expected validation messages without logging them as errors', async () => {
    const app = await bootAppWithFeatures();
    app.newDocument();
    const doc = app.editor.doc;
    const n = createPath(rectangle(0, 0, 10, 10), true);
    doc.transact('r', () => doc.insert(n, app.editor.targetLayer().id));
    app.editor.select([n.id]);
    const notes = [];
    app.notify = (m, o) => notes.push([m, o?.error]);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    // A lone rectangle: nothing else in the document matches it.
    await app.commands.run('select.globalEdit');
    expect(notes).toEqual([['No other objects match the selected object.', true]]);
    expect(err).not.toHaveBeenCalled();
  });

  it('still logs real errors', async () => {
    const app = bootApp();
    app.newDocument();
    app.commands.register({ id: 'test.boom', label: 'Boom', run: () => null.x });
    const notes = [];
    app.notify = (m) => notes.push(m);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await app.commands.run('test.boom');
    expect(err).toHaveBeenCalledTimes(1);
    expect(notes).toHaveLength(1);
  });
});
