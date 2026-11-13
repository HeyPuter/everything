// The script API: batch calls, geometry, path operations, forms, progress, error lines and the reference.
import { describe, it, expect, beforeAll, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { bootAppWithFeatures } from './helpers.js';
import { setGeomSource, loadGeom } from '../src/features/geometry/engine/index.js';
import {
  scriptAPI,
  runScript,
  SCRIPT_CORE,
  API_REFERENCE,
} from '../src/features/scripts/runner.js';
import { createPath, createCompound } from '../src/model/nodes.js';
import { rectangle } from '../src/model/shapes.js';

let app;
beforeAll(async () => {
  setGeomSource(fs.readFileSync(path.resolve(__dirname, '../src/wasm/geom.wasm')));
  await loadGeom();
  app = await bootAppWithFeatures();
});

const solid = (color) => ({ type: 'solid', color });

function setup() {
  const ed = app.newDocument();
  const doc = ed.doc;
  const layer = ed.targetLayer().id;
  const red = createPath(rectangle(0, 0, 10, 10), true, { fill: solid('#ff0000'), stroke: null });
  const blue = createPath(rectangle(5, 0, 10, 10), true, { fill: solid('#0000ff') });
  const line = createPath(rectangle(40, 0, 10, 10), false, { fill: null });
  const comp = createCompound([], { fill: solid('#FF0000') }, { fillRule: 'evenodd' });
  const kids = [rectangle(100, 0, 40, 40), rectangle(110, 10, 20, 20)].map((r) => ({
    ...createPath(r, true, {}),
    parent: comp.id,
  }));
  comp.children = kids.map((k) => k.id);
  doc.transact('setup', () => {
    for (const n of [red, blue, line]) doc.insert(n, layer);
    doc.insert(comp, layer, Infinity, kids);
  });
  const { api, changes } = scriptAPI(app, ed, 'Test');
  return { ed, doc, layer, api, changes, red: red.id, blue: blue.id, line: line.id, comp: comp.id };
}

describe('script API: objects and batches', () => {
  it('filters objects by type, fill, closed and copies only the asked fields', () => {
    const { api, red, blue, comp, line } = setup();
    const all = api.objects();
    // The paths inside a compound path are part of it, not objects of their own...
    expect(all.map((n) => n.id)).toEqual([red, blue, line, comp]);
    // ...unless asked for.
    expect(api.objects({ compoundParts: true })).toHaveLength(6);
    const reds = api.objects({ fill: '#ff0000', fields: ['name'] });
    expect(reds.map((n) => n.id)).toEqual([red, comp]);
    expect(Object.keys(reds[0]).sort()).toEqual(['id', 'name', 'parent', 'type']);
    expect(api.objects({ fill: false }).map((n) => n.id)).toEqual([line]);
    expect(api.objects({ type: ['path', 'compound'], closed: true }).map((n) => n.id)).toEqual([
      red,
      blue,
      comp,
    ]);
    expect(() => api.objects({ colour: 'red' })).toThrow(/Unknown option "colour"/);
    expect(() => api.objects({ fill: 'red' })).toThrow(/#rrggbb/);
  });

  it('updates and creates many objects in one undo step', async () => {
    const { api, doc, red, blue, layer } = setup();
    const before = doc.undoStack.length;
    expect(
      api.updateMany([
        { id: red, patch: { opacity: 0.5 } },
        { id: blue, patch: { name: 'Blue', id: 'x' } },
      ]),
    ).toBe(2);
    const ids = api.createMany([
      {
        type: 'path',
        closed: true,
        anchors: [
          { x: 0, y: 0 },
          { x: 5, y: 0 },
          { x: 5, y: 5 },
        ],
      },
      { type: 'text', text: '7', x: 1, y: 2 },
      { type: 'compound', children: [{ anchors: rectangle(0, 0, 4, 4) }] },
    ]);
    expect(ids).toHaveLength(3);
    expect(doc.get(ids[2]).children).toHaveLength(1);
    expect(doc.get(ids[0]).parent).toBe(layer);
    const newLayer = api.create({ type: 'layer', name: 'Result' });
    expect(doc.get(newLayer).parent).toBe('root');
    const copies = api.duplicate([blue, red], { parent: newLayer });
    // Copies line up with the ids given, whatever their paint order.
    expect(doc.get(copies[0]).name).toBe('Blue');
    expect(doc.get(copies[1]).opacity).toBe(0.5);
    expect(api.layers().map((l) => l.name)).toContain('Result');
    expect(doc.undoStack.length).toBe(before + 1);
    expect(doc.get(red).opacity).toBe(0.5);
    expect(doc.get(blue).id).toBe(blue);
    doc.undo();
    expect(doc.get(red).opacity).toBe(1);
    expect(doc.get(ids[0])).toBeUndefined();
    expect(doc.get(newLayer)).toBeUndefined();
  });

  it('checks every change of a batch before making any', () => {
    const { api, doc, red } = setup();
    expect(() =>
      api.updateMany([
        { id: red, patch: { opacity: 0.2 } },
        { id: 'nope', patch: {} },
      ]),
    ).toThrow(/No object/);
    expect(doc.get(red).opacity).toBe(1);
    expect(() => api.updateMany([{ id: red, patch: { fill: 'red' } }])).toThrow(/valid value/);
    expect(() => api.get({ id: red })).toThrow(/object id/);
    expect(() => api.create({ type: 'layer' }, { parent: red })).toThrow(/cannot hold/);
    expect(() => api.create({ type: 'path' }, { index: NaN })).toThrow(/"index"/);
    expect(api.remove([red])).toBe(1);
    expect(doc.get(red)).toBeUndefined();
  });
});

describe('script API: geometry', () => {
  it('gives bounds, areas and label points for one id or a list', async () => {
    const { api, red, comp, line } = setup();
    expect(api.bounds(red)).toEqual({ x: 0, y: 0, w: 10, h: 10 });
    expect(api.bounds([red, comp])[1]).toEqual({ x: 100, y: 0, w: 40, h: 40 });
    const areas = await api.area([red, comp]);
    expect(areas[0]).toBeCloseTo(100, 3);
    expect(areas[1]).toBeCloseTo(1600 - 400, 1);
    // An open path's area is the area it would fill (closed up).
    expect(await api.area(line)).toBeCloseTo(100, 3);
    const lp = await api.labelPoint(red);
    expect(lp.radius).toBeCloseTo(5, 1);
    expect(lp.x).toBeCloseTo(5, 0);
    await expect(api.labelPoint(red, { precision: -1 })).rejects.toThrow(/precision/);
  });
});

describe('script API: path operations', () => {
  it('runs a pathfinder on given ids without a dialog, in one undo step', async () => {
    const { api, doc, red, blue } = setup();
    const before = doc.undoStack.length;
    const ids = await api.pathfinder('unite', [red, blue]);
    expect(ids).toHaveLength(1);
    expect(doc.get(red)).toBeUndefined();
    expect(await api.area(ids[0])).toBeCloseTo(150, 1);
    expect(doc.undoStack.length).toBe(before + 1);
    await expect(api.pathfinder('glue', [red])).rejects.toThrow(/Unknown pathfinder/);
    await expect(api.pathfinder('intersect', [ids[0]])).rejects.toThrow(/two or more/);
    expect(document.querySelector('dialog[open]')).toBeNull();
  });

  it('divides into a group of faces', async () => {
    const { api, doc, red, blue } = setup();
    const [group] = await api.pathfinder('divide', [red, blue]);
    expect(doc.get(group).type).toBe('group');
    expect(doc.get(group).children).toHaveLength(3);
  });

  it('offsets paths and outlines strokes with given settings', async () => {
    const { api, doc, red, blue } = setup();
    const [grown] = await api.offsetPath(red, { offset: 2, joins: 'miter' });
    expect(api.bounds(grown)).toEqual({ x: -2, y: -2, w: 14, h: 14 });
    expect(doc.get(red)).toBeTruthy();
    await expect(api.offsetPath(red, { offset: 2, joins: 'pointy' })).rejects.toThrow(/joins/);
    await expect(api.offsetPath(red, {})).rejects.toThrow(/needs "offset"/);
    const outlined = await api.outlineStroke([blue]);
    expect(outlined).toHaveLength(1);
    expect(doc.get(blue)).toBeUndefined();
    expect(document.querySelector('dialog[open]')).toBeNull();
  });
});

describe('script API: forms and progress', () => {
  it('asks several settings at once through the app form', async () => {
    const { api } = setup();
    const seen = [];
    const original = app.dialogs.form;
    app.dialogs.form = async (opts) => {
      seen.push(opts);
      return { width: 2, name: 'x', kind: 'b', __action: 'hack' };
    };
    try {
      const v = await api.form('Settings', [
        { key: 'width', label: 'Width', type: 'length', value: 1, min: 0 },
        { type: 'heading', label: 'More' },
        { key: 'name', label: 'Name' },
        {
          key: 'kind',
          label: 'Kind',
          type: 'select',
          value: 'a',
          options: ['a', { value: 'b', label: 'B' }],
        },
      ]);
      expect(v).toEqual({ width: 2, name: 'x', kind: 'b' });
      expect(seen[0].title).toBe('Settings');
      expect(seen[0].fields[3].options).toEqual([
        { value: 'a', label: 'a' },
        { value: 'b', label: 'B' },
      ]);
      await expect(api.form('T', [{ key: 'a', type: 'file' }])).rejects.toThrow(/unknown type/);
      await expect(api.form('T', [{ key: 'a' }, { key: 'a' }])).rejects.toThrow(/unique/);
      await expect(api.form('T', [{ key: 'a', onInput: 'x' }])).rejects.toThrow(/Unknown option/);
      await expect(api.form('T', [])).rejects.toThrow(/1 to 40/);
    } finally {
      app.dialogs.form = original;
    }
  });

  it('keeps a script that reports progress running past the time limit, and stops it from the status bar', async () => {
    app.newDocument();
    const progress = [];
    const run = runScript(app, '', {
      name: 'Long',
      timeoutMs: 300,
      onProgress: (v, m) => progress.push([v, m]),
    });
    const frame = document.querySelector('iframe[sandbox]');
    const send = (data) =>
      window.dispatchEvent(new MessageEvent('message', { data, source: frame.contentWindow }));
    let settled = false;
    run.then(() => (settled = true));
    for (let i = 0; i < 6; i++) {
      await new Promise((r) => setTimeout(r, 150));
      send({ __vs: 'call', id: i + 1, method: 'progress', args: [i / 6, 'Working'] });
    }
    expect(settled).toBe(false);
    expect(progress.at(-1)).toEqual([5 / 6, 'Working']);
    const stop = document.querySelector('.status-script-stop');
    expect(stop).toBeTruthy();
    expect(document.querySelector('.status-script-label').textContent).toBe('Long: Working');
    stop.click();
    expect(await run).toMatchObject({ ok: false, stopped: true });
    expect(document.querySelector('.status-script')).toBeNull();
    expect(frame.isConnected).toBe(false);
  });

  it('still stops a silent script, and stops on an abort signal', async () => {
    app.newDocument();
    const silent = await runScript(app, '', { timeoutMs: 50 });
    expect(silent).toMatchObject({ ok: false });
    expect(silent.error).toMatch(/without reporting progress/);
    const controller = new AbortController();
    const run = runScript(app, '', { signal: controller.signal });
    controller.abort();
    expect(await run).toMatchObject({ ok: false, stopped: true });
  });
});

describe('script errors and the reference', () => {
  /** Run source through the script side of the protocol, answering calls with `answer`. */
  function playCore(source, answer) {
    const core = new Function(`return ${SCRIPT_CORE};`)();
    let deliver = null;
    return new Promise((resolve) => {
      core(
        (m) => {
          if (m.__vs === 'call') deliver({ __vs: 'reply', id: m.id, ...answer(m) });
          if (m.__vs === 'done') resolve(m);
        },
        (fn) => {
          deliver = fn;
        },
      );
      deliver({ __vs: 'run', doc: {}, source });
    });
  }

  it('reports the script line of an error', async () => {
    const r = await playCore('const a = 1;\n\nnope();\n', () => ({ value: null }));
    expect(r.error).toMatch(/nope/);
    expect(r.line).toBe(3);
  });

  it('reports the line of a failed API call', async () => {
    const r = await playCore('await vs.get("a");\nawait vs.update("x", {});\n', (m) =>
      m.method === 'update' ? { error: 'No object with id "x".' } : { value: null },
    );
    expect(r.error).toBe('No object with id "x".');
    expect(r.line).toBe(2);
  });

  it('reports syntax errors as such', async () => {
    const r = await playCore('const = 3;', () => ({}));
    expect(r.error).toMatch(/^Syntax error/);
    expect(r.syntax).toBe(true);
  });

  it('documents every vs call in the reference and in the runner header', () => {
    const header = fs
      .readFileSync(path.resolve(__dirname, '../src/features/scripts/runner.js'), 'utf8')
      .split('*/')[0]
      .replace(/\s*\n\s*\*\s*/g, ' ');
    const methods = [...SCRIPT_CORE.matchAll(/^\s{8}(\w+): /gm)].map((m) => m[1]);
    expect(methods.length).toBeGreaterThan(20);
    const sigs = API_REFERENCE.flatMap((s) => s.items.map(([sig]) => sig));
    for (const m of [...methods.filter((x) => x !== 'doc'), 'doc']) {
      const re = new RegExp(`vs\\.${m}\\b`);
      expect(
        sigs.some((s) => re.test(s)),
        `${m} in the reference`,
      ).toBe(true);
    }
    for (const sig of sigs) expect(header, sig).toContain(sig);
  });

  it('lists the editor and the reference in File > Scripts and opens them', async () => {
    setup();
    const items = app.menuSources.get('scripts')(app);
    expect(items).toContain('file.scriptEditor');
    expect(items).toContain('file.scriptReference');
    expect(items).toContain('script.color-by-number');
    expect(app.commands.label('script.color-by-number')).toBe('Color by Number...');
    app.commands.run('file.scriptReference');
    const ref = document.querySelector('dialog[open]');
    expect(ref.textContent).toContain('vs.labelPoint');
    ref.querySelector('.dialog-footer .btn').click();
    await new Promise((r) => setTimeout(r, 0));
    expect(document.querySelector('dialog[open]')).toBeNull();
    vi.restoreAllMocks();
  });
});
