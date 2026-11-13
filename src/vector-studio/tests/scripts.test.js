import { describe, it, expect } from 'vitest';
import { bootAppWithFeatures } from './helpers.js';
import { scriptAPI, SCRIPT_CORE } from '../src/features/scripts/runner.js';
import { BUILT_IN_SCRIPTS } from '../src/features/scripts/index.js';
import { createPath } from '../src/model/nodes.js';
import { rectangle } from '../src/model/shapes.js';

/** Run a script's source in-process against the API (the sandboxed iframe does this in the browser). */
async function runInline(app, source) {
  const { api, changes } = scriptAPI(app, app.editor, 'Test');
  const vs = { doc: { artboards: app.editor.doc.root.artboards }, ...Object.fromEntries(Object.entries(api).map(([k, fn]) => [k, async (...a) => JSON.parse(JSON.stringify((await fn(...a)) ?? null))])) };
  const fn = new Function('vs', `return (async () => {${source}})();`);
  return { value: await fn(vs), changes: changes() };
}

describe('scripts', () => {
  async function setup() {
    const app = await bootAppWithFeatures();
    app.newDocument();
    const doc = app.editor.doc;
    const a = createPath(rectangle(0, 0, 10, 10), true);
    const b = createPath(rectangle(20, 0, 10, 10), true);
    doc.transact('add', () => {
      doc.insert(a, app.editor.targetLayer().id);
      doc.insert(b, app.editor.targetLayer().id);
    });
    app.editor.select([a.id, b.id]);
    return { app, doc, a, b };
  }

  it('changes objects through the API in one undo step', async () => {
    const { app, doc, a, b } = await setup();
    const before = doc.undoStack.length;
    const r = await runInline(app, BUILT_IN_SCRIPTS.find((s) => s.id === 'random-fills').source);
    expect(r.value).toBe('Recolored 2 objects.');
    expect(doc.get(a.id).fill.color).not.toBe('#ffffff');
    expect(doc.get(b.id).fill.color).toMatch(/^#[0-9a-f]{6}$/);
    expect(doc.undoStack.length).toBe(before + 1);
    doc.undo();
    expect(doc.get(a.id).fill.color).toBe('#ffffff');
  });

  it('does not number objects after the starting-number prompt is cancelled', async () => {
    const { app, doc } = await setup();
    const before = doc.undoStack.length;
    const objects = doc.nodes.size;
    app.dialogs.form = async () => null;
    const r = await runInline(app, BUILT_IN_SCRIPTS.find((s) => s.id === 'number-objects').source);
    expect(r.changes).toBe(0);
    expect(doc.nodes.size).toBe(objects);
    expect(doc.undoStack.length).toBe(before);
  });

  it('numbers the selected objects from an accepted zero', async () => {
    const { app, doc } = await setup();
    app.dialogs.form = async () => ({ v: '0' });
    const r = await runInline(app, BUILT_IN_SCRIPTS.find((s) => s.id === 'number-objects').source);
    expect(r.value).toBe('Numbered 2 objects.');
    expect([...doc.nodes.values()].filter((n) => n.type === 'text').map((n) => n.text)).toEqual(['0', '1']);
    doc.undo();
    expect([...doc.nodes.values()].filter((n) => n.type === 'text')).toHaveLength(0);
  });

  it('creates and removes objects, guards ids and structure', async () => {
    const { app, doc, a } = await setup();
    const { api } = scriptAPI(app, app.editor, 'Test');
    const id = api.create({ type: 'text', text: 'Hi', x: 5, y: 5, char: { fontSize: 20 } });
    expect(doc.get(id).char.fontFamily).toBeTruthy();
    expect(doc.get(id).char.fontSize).toBe(20);
    api.update(a.id, { id: 'hacked', parent: 'root', opacity: 0.5 });
    expect(doc.get(a.id).opacity).toBe(0.5);
    expect(doc.get(a.id).parent).not.toBe('root');
    expect(() => api.update('nope', {})).toThrow(/No object/);
    expect(() => api.create({ type: 'image' })).toThrow(/path, text and group/);
    api.remove(id);
    expect(doc.get(id)).toBeUndefined();
  });

  it('runs the script side of the protocol (as the worker does), keeping line breaks around the source', async () => {
    const core = new Function(`return ${SCRIPT_CORE};`)();
    const sent = [];
    let deliver = null;
    const done = new Promise((resolve) => {
      core(
        (m) => {
          sent.push(m);
          if (m.__vs === 'call') deliver({ __vs: 'reply', id: m.id, value: [{ id: 'a' }, { id: 'b' }] });
          if (m.__vs === 'done') resolve(m);
        },
        (fn) => {
          deliver = fn;
        },
      );
      expect(sent[0]).toEqual({ __vs: 'ready' });
      deliver({ __vs: 'run', doc: { name: 'D' }, source: 'const all = await vs.objects();\nreturn vs.doc.name + all.length // a trailing comment' });
    });
    expect(await done).toEqual({ __vs: 'done', value: 'D2' });
  });

  it('fills in curve handles for points given as { x, y }', async () => {
    const { app, doc, a } = await setup();
    const { api } = scriptAPI(app, app.editor, 'Test');
    const id = api.create({ type: 'path', closed: true, anchors: [{ x: 0, y: 0 }, { x: 10, y: 0, ox: 12, oy: 3 }, null, { x: 5, y: 'no' }] });
    expect(doc.get(id).anchors).toEqual([
      { x: 0, y: 0, ix: 0, iy: 0, ox: 0, oy: 0 },
      { x: 10, y: 0, ix: 10, iy: 0, ox: 12, oy: 3 },
    ]);
    api.update(a.id, { anchors: [{ x: 1, y: 2 }, { x: 3, y: 4 }] });
    expect(doc.get(a.id).anchors[1]).toEqual({ x: 3, y: 4, ix: 3, iy: 4, ox: 3, oy: 4 });
  });

  it('lists built-in scripts in File > Scripts', async () => {
    const { app } = await setup();
    const items = app.menuSources.get('scripts')(app);
    expect(items).toContain('script.export-artboards-svg');
    expect(items[items.length - 1]).toBe('file.otherScript');
  });
});
