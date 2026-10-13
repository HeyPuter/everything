import { describe, expect, it, vi } from 'vitest';
import { History } from '../src/history/history';
import { DocumentSession } from '../src/app/session';
import { findLayer, newDocument, type PhotoDocument } from '../src/model/document';
import { newPixelLayer, commitPixelTranslation, pixelTransformKind } from '../src/model/pixel-layer';
import { gridFromImage, readRGBA } from '../src/model/tiles';
import { registerCommand, commands } from '../src/app/registry';
import { ScriptHost, describeLayers, trimTransparent, type ScriptUI } from '../src/features/scripting/host';
import { highlight, tokenize } from '../src/features/scripting/highlight';
import { scriptMetadata, setScriptBackend, saveScript, newScriptRecord, findScript, deleteScript, saveEvents, eventSettings, loadScripts, listScripts } from '../src/features/scripting/store';
import { dispatchEvent, rulesFor } from '../src/features/scripting/event-dispatch';
import { decodeBatchLink, encodeBatchLink, linkableCommand } from '../src/features/scripting/batch-link-core';
import { SANDBOX_CSP, sandboxCode, sandboxDocument } from '../src/features/scripting/sandbox';
import { MemoryStore } from '../src/persistence/local-store';
import type { Editor } from '../src/editor';

/** The parts of the editor the scripting host uses, over real sessions and history. */
function mockEditor() {
  const sessions: DocumentSession[] = [];
  const add = (doc: PhotoDocument) => {
    const s = new DocumentSession(doc);
    s.hasDocument = true;
    // Pixel layer moves are baked when an edit is committed, as in the editor.
    s.history.normalize = (d) => {
      for (const l of d.layers) if (l.kind === 'pixel' && pixelTransformKind(l) === 'translate') commitPixelTranslation(l);
    };
    sessions.push(s);
    return s;
  };
  const doc = newDocument(64, 48, 'Mock');
  const s0 = add(doc);
  const bg = newPixelLayer('Background', doc, gridFromImage(s0.assets.tiles, { width: 64, height: 48, data: new Uint8ClampedArray(64 * 48 * 4).fill(200) }));
  s0.history.reset({ ...doc, layers: [bg] });
  let active = s0;
  const e = {
    sessions,
    color: '#112233',
    background: '#ffffff',
    busy: false,
    messages: [] as string[],
    get session() {
      return active;
    },
    get hasDocument() {
      return active.hasDocument;
    },
    get doc() {
      return active.doc;
    },
    get assets() {
      return active.assets;
    },
    get history() {
      return active.history;
    },
    get selectedIds() {
      return active.selectedIds;
    },
    async switchSession(s: DocumentSession) {
      active = s;
    },
    selectLayers(ids: string[]) {
      active.selectedIds = new Set(ids);
    },
    command(label: string, edit: (d: PhotoDocument) => void) {
      active.history.execute(label, edit);
    },
    update() {},
    message(t: string) {
      e.messages.push(t);
    },
    transform: {
      nudge(dx: number, dy: number) {
        const ids = [...active.selectedIds];
        e.command('Nudge layers', (d) => {
          for (const id of ids) {
            const l = findLayer(d.layers, id)!;
            l.transform.x += dx;
            l.transform.y += dy;
          }
        });
      },
    },
    async closeSession(s: DocumentSession) {
      sessions.splice(sessions.indexOf(s), 1);
      if (active === s) active = sessions[0];
      return true;
    },
    add,
  };
  return e;
}
const ui = (): ScriptUI & { log: string[] } => {
  const log: string[] = [];
  return {
    log,
    alert: async (m) => void log.push(`alert ${m}`),
    confirm: async () => true,
    prompt: async (_m, v) => v,
    form: async (_t, fields) => Object.fromEntries(fields.map((f) => [f.name, f.value])),
    progress: (f, m) => void log.push(`progress ${f} ${m}`),
    openFiles: async () => [],
    saveFiles: async (files) => (log.push(`save ${files.map((f) => f.name).join(',')}`), true),
  };
};

describe('scripting API host', () => {
  it('describes documents and layers', async () => {
    const e = mockEditor();
    const host = new ScriptHost(e as unknown as Editor, ui(), 'Test');
    const doc = (await host.call('documents.active', [])) as { id: string; width: number; height: number; name: string };
    expect(doc).toMatchObject({ width: 64, height: 48, name: 'Mock' });
    const layers = (await host.call('layers.list', [doc.id])) as { name: string; kind: string; opacity: number; bounds: unknown }[];
    expect(layers).toEqual([expect.objectContaining({ name: 'Background', kind: 'pixel', opacity: 100, bounds: { x: 0, y: 0, width: 64, height: 48 } })]);
    host.finish();
  });

  it('creates and edits layers as one undo step per run', async () => {
    const e = mockEditor();
    const start = e.history.position;
    const host = new ScriptHost(e as unknown as Editor, ui(), 'My Script (script)');
    const id = e.session.id;
    const red = (await host.call('layers.create', [id, { name: 'Red', fill: '#ff0000', rect: { x: 4, y: 6, width: 10, height: 8 } }])) as { id: string; bounds: unknown };
    expect(red.bounds).toEqual({ x: 4, y: 6, width: 10, height: 8 });
    await host.call('layers.set', [id, red.id, { opacity: 40, blendMode: 'color-burn', name: 'Red box', visible: false }]);
    await host.call('layers.translate', [id, red.id, 3, -2]);
    const group = (await host.call('layers.create', [id, { kind: 'group', name: 'G' }])) as { id: string };
    await host.call('layers.arrange', [id, red.id, { inside: group.id }]);
    const moved = (await host.call('layers.get', [id, red.id])) as { parentId: string; bounds: unknown; opacity: number; blendMode: string; name: string; visible: boolean };
    expect(moved).toMatchObject({ parentId: group.id, bounds: { x: 7, y: 4, width: 10, height: 8 }, opacity: 40, blendMode: 'color burn', name: 'Red box', visible: false });
    expect(e.history.position).toBeGreaterThan(start + 3);
    expect(host.finish()).toBe(1);
    // One step, labelled with the script; undo returns to the start.
    expect(e.history.position).toBe(start + 1);
    expect(e.history.labels.at(-1)).toBe('My Script (script)');
    e.history.undo();
    expect(e.doc.layers.map((l) => l.name)).toEqual(['Background']);
  });

  it('reads and writes pixels as RGBA arrays', async () => {
    const e = mockEditor();
    const host = new ScriptHost(e as unknown as Editor, ui(), 'Pixels');
    const id = e.session.id;
    const l = (await host.call('layers.create', [id, { name: 'P' }])) as { id: string };
    const data = new Uint8ClampedArray(2 * 2 * 4).fill(255);
    data[0] = 10;
    await host.call('layers.setPixels', [id, l.id, { x: 5, y: 7, width: 2, height: 2, data }]);
    const px = (await host.call('layers.getPixels', [id, l.id])) as { x: number; y: number; width: number; height: number; data: Uint8ClampedArray };
    expect([px.x, px.y, px.width, px.height]).toEqual([5, 7, 2, 2]);
    expect(Array.from(px.data.slice(0, 4))).toEqual([10, 255, 255, 255]);
    const layer = findLayer(e.doc.layers, l.id)!;
    expect(Array.from(readRGBA(e.assets.tiles, layer.pixels!, { x: 6, y: 8, width: 1, height: 1 }).data)).toEqual([255, 255, 255, 255]);
    await expect(host.call('layers.setPixels', [id, l.id, { width: 2, height: 2, data: [1, 2, 3] }])).rejects.toThrow('needs 16');
    host.finish();
  });

  it('selects shapes and combines selections', async () => {
    const e = mockEditor();
    const host = new ScriptHost(e as unknown as Editor, ui(), 'Select');
    const id = e.session.id;
    expect(await host.call('selection.get', [id])).toBeNull();
    expect(await host.call('selection.set', [id, { x: 4, y: 4, width: 10, height: 10 }])).toEqual({ x: 4, y: 4, width: 10, height: 10 });
    expect(await host.call('selection.set', [id, { x: 10, y: 10, width: 10, height: 10 }, 'add'])).toEqual({ x: 4, y: 4, width: 16, height: 16 });
    const mask = (await host.call('selection.getMask', [id])) as { width: number; data: Uint8Array };
    expect(mask.width).toBe(16);
    expect(mask.data[0]).toBe(255);
    expect(mask.data[15]).toBe(0);
    await host.call('selection.clear', [id]);
    expect(await host.call('selection.get', [id])).toBeNull();
    await expect(host.call('selection.set', [id, { x: 0, y: 0, width: 4, height: 4 }, 'xor'])).rejects.toThrow('operation must be');
    host.finish();
  });

  it('runs registered commands with the arguments actions record, and refuses scripting commands', async () => {
    const e = mockEditor();
    const run = vi.fn();
    // Provenance attributes the command's steps through the editor's current and last command.
    let named: unknown[] = [];
    registerCommand({ id: 'test.script-arg', label: 'Arg Test', run: (ed, arg) => ((named = [ed.currentCommand, ed.lastCommand]), run(arg)) });
    registerCommand({ id: 'test.disabled', label: 'Disabled Test', enabled: () => false, run: () => {} });
    const host = new ScriptHost(e as unknown as Editor, ui(), 'Cmd');
    await host.call('commands.run', ['test.script-arg', { params: { amount: 3 } }]);
    expect(run).toHaveBeenCalledWith({ params: { amount: 3 } });
    expect(named).toEqual(['test.script-arg', 'test.script-arg']);
    expect([(e as unknown as Editor).currentCommand, (e as unknown as Editor).lastCommand]).toEqual([undefined, 'test.script-arg']);
    await expect(host.call('commands.run', ['test.disabled'])).rejects.toThrow('not available');
    await expect(host.call('commands.run', ['script.run.anything'])).rejects.toThrow('cannot run');
    await expect(host.call('commands.run', ['no.such.command'])).rejects.toThrow('Unknown command');
    expect(((await host.call('commands.list', [])) as { id: string }[]).some((c) => c.id === 'test.script-arg')).toBe(true);
    commands.delete('test.script-arg');
    commands.delete('test.disabled');
    host.finish();
  });

  it('never runs the Assistant or Generation History, which need the person’s own action', async () => {
    const e = mockEditor();
    const asked = vi.fn();
    registerCommand({ id: 'assistant.ask', label: 'Describe an Edit…', run: asked }, { id: 'generations.clear', label: 'Clear Generation History…', run: asked });
    const host = new ScriptHost(e as unknown as Editor, ui(), 'Cmd');
    await expect(host.call('commands.run', ['assistant.ask', { prompt: 'make it pop' }])).rejects.toThrow('Scripts cannot run “assistant.ask”.');
    await expect(host.call('commands.run', ['generations.clear'])).rejects.toThrow('cannot run');
    expect(((await host.call('commands.list', [])) as { id: string }[]).filter((c) => /^(assistant|generations)\./.test(c.id))).toEqual([]);
    // Recorded actions (an imported file can name any command) refuse them too.
    const { playAction } = await import('../src/features/actions');
    const messages: string[] = [];
    const ed = { message: (m: string) => messages.push(m), update() {} } as unknown as Editor;
    expect(await playAction(ed, { id: 'a', name: 'Ask', steps: [{ command: 'assistant.ask', arg: { prompt: 'make it pop' }, enabled: true, dialog: false }] })).toBe(false);
    expect(messages).toEqual(['Action stopped: Actions cannot run “Describe an Edit”.']);
    expect(asked).not.toHaveBeenCalled();
    commands.delete('assistant.ask');
    commands.delete('generations.clear');
    host.finish();
  });
  it('can keep each edit as its own step or add checkpoints', async () => {
    const e = mockEditor();
    const start = e.history.position;
    const host = new ScriptHost(e as unknown as Editor, ui(), 'Steps');
    const id = e.session.id;
    await host.call('layers.create', [id, { name: 'A' }]);
    await host.call('history.checkpoint', ['First part']);
    await host.call('layers.create', [id, { name: 'B' }]);
    await host.call('layers.create', [id, { name: 'C' }]);
    host.finish();
    expect(e.history.labels.slice(start)).toEqual(['First part', 'Steps']);
    const host2 = new ScriptHost(e as unknown as Editor, ui(), 'Separate');
    await host2.call('history.grouping', [false]);
    await host2.call('layers.create', [id, { name: 'D' }]);
    await host2.call('layers.create', [id, { name: 'E' }]);
    host2.finish();
    expect(e.history.labels.slice(start)).toEqual(['First part', 'Steps', 'New Layer', 'New Layer']);
  });

  it('checks arguments and passes dialogs and files to the UI', async () => {
    const e = mockEditor();
    const u = ui();
    const host = new ScriptHost(e as unknown as Editor, u, 'Checks');
    const id = e.session.id;
    await expect(host.call('no.method', [])).rejects.toThrow('Unknown API method');
    await expect(host.call('constructor', [])).rejects.toThrow('Unknown API method');
    await expect(host.call('layers.create', [id, { kind: 'pixel', opacity: 'high' }])).rejects.toThrow('opacity must be a finite number');
    await expect(host.call('layers.set', [id, 'missing', {}])).rejects.toThrow('no longer exists');
    await expect(host.call('documents.get', ['nope'])).rejects.toThrow('no longer open');
    await expect(host.call('layers.set', [id, e.doc.layers[0].id, { blendMode: 'sparkle' }])).rejects.toThrow('Unknown blend mode');
    expect(await host.call('ui.form', ['T', [{ name: 'n', type: 'number', value: 3 }, { name: 'c', type: 'checkbox' }]])).toEqual({ n: 3, c: false });
    await expect(host.call('ui.form', ['T', [{ name: 'x', type: 'password' }]])).rejects.toThrow('Field type');
    expect(await host.call('files.saveAll', [[{ name: 'a/b.txt', data: 'hi' }, { name: 'c.bin', data: new Uint8Array(3) }], 'out.zip'])).toBe(true);
    expect(u.log).toContain('save a_b.txt,c.bin');
    await expect(host.call('layers.setStyle', [id, e.doc.layers[0].id, { sparkle: {} }])).rejects.toThrow('Unknown effect');
    await host.call('layers.setStyle', [id, e.doc.layers[0].id, { stroke: { size: 4, color: '#00ff00', position: 'inside' }, dropShadow: true }]);
    const style = e.doc.layers[0].style as { stroke: { size: number; position: string; fill: { color: number[] } }[]; dropShadow: unknown[] };
    expect(style.stroke[0]).toMatchObject({ size: 4, position: 'inside', fill: { type: 'color', color: [0, 255, 0] } });
    expect(style.dropShadow).toHaveLength(1);
    await expect(host.call('layers.setStyle', [id, e.doc.layers[0].id, { stroke: { position: 'around' } }])).rejects.toThrow('stroke.position must be');
    host.finish();
  });

  it('lists layers top to bottom with children after their group', () => {
    const doc = newDocument(10, 10);
    const a = newPixelLayer('A', doc),
      g = newPixelLayer('G', doc),
      c = newPixelLayer('C', doc);
    g.kind = 'group';
    g.children = [c];
    expect(describeLayers('d', [a, g]).map((l) => [l.name, l.depth])).toEqual([['G', 0], ['C', 1], ['A', 0]]);
  });

  it('trims transparent edges', () => {
    const data = new Uint8ClampedArray(5 * 4 * 4);
    data[(2 * 5 + 3) * 4 + 3] = 255;
    expect(trimTransparent({ width: 5, height: 4, data })).toMatchObject({ width: 1, height: 1 });
  });
});

describe('history grouping', () => {
  it('squashes edits since a mark, in linear and non-linear history', () => {
    for (const nonLinear of [false, true]) {
      const h = new History(newDocument(10, 10), 2);
      h.nonLinear = () => nonLinear;
      h.execute('before', (d) => (d.name = 'x'));
      const mark = h.mark();
      for (let i = 0; i < 5; i++) h.execute(`edit ${i}`, (d) => (d.name = `n${i}`));
      // The limit does not drop states while a mark is open.
      expect(h.labels).toContain('before');
      expect(h.squash(mark, 'Script')).toBe(true);
      expect(h.labels).toEqual(['before', 'Script']);
      expect(h.document.name).toBe('n4');
      h.undo();
      expect(h.document.name).toBe('x');
    }
  });
  it('drops a group that returns to the start and ignores closed marks', () => {
    const h = new History(newDocument(10, 10));
    const mark = h.mark();
    h.execute('a', (d) => (d.name = 'a'));
    h.undo();
    h.execute('b', (d) => (d.name = 'b'));
    h.undo();
    expect(h.squash(mark, 'Script')).toBe(false);
    expect(h.position).toBe(0);
    expect(h.squash(mark, 'Again')).toBe(false);
  });
});

describe('script editor highlighting', () => {
  it('round-trips the source and classifies tokens', () => {
    const src = "// @name X\nconst re = /a\\/b[/]+/g; const n = 0x1F + 2.5e3;\nconst s = `a ${studio.x + `in ${1}`} b`;\nif (a / b > 1) return 'str\\'s';\n/* block */";
    expect(tokenize(src).map((t) => t.text).join('')).toBe(src);
    const kinds = (text: string) => tokenize(src).filter((t) => t.text === text).map((t) => t.kind);
    expect(kinds('// @name X')).toEqual(['comment']);
    expect(kinds('/a\\/b[/]+/g')).toEqual(['regex']);
    expect(kinds('0x1F')).toEqual(['number']);
    expect(kinds('studio')).toEqual(['api']);
    expect(kinds('return')).toEqual(['keyword']);
    expect(kinds("'str\\'s'")).toEqual(['string']);
    expect(kinds('/* block */')).toEqual(['comment']);
    // "a / b" is a division, not a regular expression.
    expect(tokenize(src).some((t) => t.kind === 'regex' && t.text.startsWith('/ b'))).toBe(false);
  });
  it('escapes markup and survives unfinished code', () => {
    expect(highlight('<b>&')).toBe('&lt;b&gt;&amp;');
    for (const s of ['"open', '`open ${', '/* open', '/[', 'a /']) expect(tokenize(s).map((t) => t.text).join('')).toBe(s);
    expect(highlight("'<x>'")).toBe('<span class="tok-string">\'&lt;x&gt;\'</span>');
  });
});

describe('script records and events', () => {
  it('reads metadata from the header comments', () => {
    expect(scriptMetadata('// @name  Hello  \n// @description Says hi\n// @timeout 90\nconst x = 1;\n// @name Later')).toEqual({ name: 'Hello', description: 'Says hi', timeout: 90 });
    expect(scriptMetadata('const x = 1; // @name No')).toEqual({ name: '', description: '' });
  });
  it('stores scripts and event rules, and removes rules with their script', async () => {
    setScriptBackend(new MemoryStore());
    await loadScripts();
    const r = newScriptRecord('// @name Stored\n', 'fallback');
    expect(r).toMatchObject({ name: 'Stored', trusted: false, enabled: true });
    await saveScript(r);
    await saveEvents({ enabled: true, rules: [{ id: '1', event: 'open-document', kind: 'script', target: r.id, enabled: true }, { id: '2', event: 'open-document', kind: 'action', target: 'act', enabled: true }] });
    expect(findScript(r.id)?.name).toBe('Stored');
    await deleteScript(r.id);
    expect(listScripts()).toEqual([]);
    expect(eventSettings().rules.map((x) => x.id)).toEqual(['2']);
  });
  it('dispatches enabled rules in order and only for enabled, installed scripts', async () => {
    setScriptBackend(new MemoryStore());
    await loadScripts();
    const on = newScriptRecord('// @name On\n', 'On');
    const off = { ...newScriptRecord('// @name Off\n', 'Off'), enabled: false };
    await saveScript(on);
    await saveScript(off);
    const settings = {
      enabled: true,
      rules: [
        { id: 'a', event: 'new-document' as const, kind: 'action' as const, target: 'act1', enabled: true },
        { id: 'b', event: 'new-document' as const, kind: 'script' as const, target: on.id, enabled: true },
        { id: 'c', event: 'new-document' as const, kind: 'script' as const, target: off.id, enabled: true },
        { id: 'd', event: 'new-document' as const, kind: 'script' as const, target: on.id, enabled: false },
        { id: 'e', event: 'after-save' as const, kind: 'script' as const, target: on.id, enabled: true },
      ],
    };
    expect(rulesFor(settings, 'new-document').map((r) => r.id)).toEqual(['a', 'b', 'c']);
    expect(rulesFor({ ...settings, enabled: false }, 'new-document')).toEqual([]);
    const calls: string[] = [];
    const runners = { busy: () => false, action: async (id: string) => void calls.push(`action ${id}`), script: async (r: { name: string }, ev: { name: string }) => void calls.push(`script ${r.name} ${ev.name}`) };
    await dispatchEvent(settings, 'new-document', undefined, runners);
    expect(calls).toEqual(['action act1', 'script On New Document']);
    calls.length = 0;
    await dispatchEvent(settings, 'new-document', undefined, { ...runners, busy: () => true });
    expect(calls).toEqual([]);
  });
});

describe('batch links', () => {
  const known = (id: string) => ['adjust.desaturate', 'image.flip-horizontal', 'file.fit-image'].includes(id);
  it('round-trips a link and checks what it may run', () => {
    const hash = encodeBatchLink({ v: 1, name: 'Mono ✓', steps: [{ command: 'adjust.desaturate' }, { command: 'file.fit-image', arg: { width: 800 } }], format: 'webp', quality: 70, fit: { width: 1200, height: 900 } });
    expect(hash.startsWith('#batch=')).toBe(true);
    expect(decodeBatchLink(hash, known)).toEqual({ v: 1, name: 'Mono ✓', steps: [{ command: 'adjust.desaturate' }, { command: 'file.fit-image', arg: { width: 800 } }], format: 'webp', quality: 70, fit: { width: 1200, height: 900 } });
    expect(linkableCommand('script.run.x')).toBe(false);
    expect(linkableCommand('file.save')).toBe(false);
    expect(linkableCommand('file.fit-image')).toBe(true);
    const bad = encodeBatchLink({ v: 1, name: 'x', steps: [{ command: 'script.run.abc' }], format: 'png', quality: 90 });
    expect(() => decodeBatchLink(bad, () => true)).toThrow('links cannot run');
    expect(() => decodeBatchLink(encodeBatchLink({ v: 1, name: 'x', steps: [{ command: 'filter.new' }], format: 'png', quality: 90 }), known)).toThrow('does not have');
    expect(() => decodeBatchLink('#batch=%%%', known)).toThrow('damaged');
    // Out-of-range settings fall back to safe values.
    const odd = decodeBatchLink('#batch=' + btoa(JSON.stringify({ v: 1, name: '', steps: [{ command: 'adjust.desaturate' }], format: 'exe', quality: 900, fit: { width: -1, height: 5 } })).replace(/=+$/, ''), known);
    expect(odd).toMatchObject({ name: 'Batch', format: 'jpeg', quality: 85, fit: undefined });
  });
});

describe('script sandbox', () => {
  it('uses a strict policy and an opaque-origin iframe document', () => {
    expect(SANDBOX_CSP).toContain("default-src 'none'");
    expect(SANDBOX_CSP).not.toMatch(/connect-src|unsafe-eval|https?:/);
    const html = sandboxDocument();
    expect(html).toContain(`content="${SANDBOX_CSP}"`);
    expect(html).toContain('ev.source !== parent');
  });
  it('wraps the script after the runtime and knows its first line', () => {
    const { code, lineOffset } = sandboxCode('first();\nsecond();');
    const lines = code.split('\n');
    expect(lines[lineOffset]).toBe('first();');
    expect(lines[lineOffset + 1]).toBe('second();');
    expect(code).toContain('__studioRegister(async function (studio, console) {');
  });
});
