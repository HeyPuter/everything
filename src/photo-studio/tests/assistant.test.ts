// The Assistant without a browser or a network: catalog search and details
// over the real registry, argument coercion, plan validation, the
// tool-calling loop with a scripted model, and running a plan as one undo
// step through the scripting host. Plus Generation History storage.
import { beforeAll, describe, expect, it } from 'vitest';
import { History } from '../src/history/history';
import { DocumentSession } from '../src/app/session';
import { newDocument, type PhotoDocument } from '../src/model/document';
import { newPixelLayer } from '../src/model/pixel-layer';
import { gridFromImage } from '../src/model/tiles';
import { commands, registerCommand } from '../src/app/registry';
import type { Editor } from '../src/editor';
import type { ChatMessage, ChatReply } from '../src/imaging/ai/puter-ai';
import { parseChatReply } from '../src/imaging/ai/puter-ai';
import { coerceArgs, coerceValue, matchOption, parseColor, parseNumber, type Param } from '../src/features/assistant/params';
import { parseAspect, stepRect, adjustmentParams } from '../src/features/assistant/ops';
import { buildPlan, commandArg, setArgs, stepDetail, validatePlan, type PlanEnv } from '../src/features/assistant/plan';
import { converse, systemPrompt, TOOLS, type ChatFn } from '../src/features/assistant/model';
import { PlanRun, runLabel } from '../src/features/assistant/runner';
import { Catalog, commandInput, commandParams, words } from '../src/features/assistant/catalog';
import { filterGenerations, GenerationStore } from '../src/persistence/generations';
import { MemoryStore } from '../src/persistence/local-store';
import { loadRegistry } from './registry-fixture';

type Registry = Awaited<ReturnType<typeof loadRegistry>>;
let reg: Registry;
let catalog: Catalog;
beforeAll(async () => {
  reg = await loadRegistry();
  catalog = new Catalog({ commands: reg.commands, tools: reg.tools, panels: reg.panels, skeleton: (await import('../src/app/menus')).menuSkeleton, contributions: reg.menuContributions });
}, 60_000);

describe('Assistant catalog', () => {
  const top = (q: string, kind?: 'command' | 'tool' | 'panel' | 'op') => catalog.search(q, { kind, limit: 5 }).map((e) => e.id);
  it('finds commands by everyday words', () => {
    expect(top('gaussian blur')[0]).toBe('filter.apply.gaussian-blur');
    expect(top('remove background')).toContain('layer.remove-background');
    expect(top('drop shadow')).toContain('layer.style-drop-shadow');
    expect(top('select subject')).toContain('select.subject');
    expect(top('rotate 90 clockwise')).toContain('image.rotate-cw');
    expect(top('crop to aspect ratio')).toContain('op.crop');
    expect(top('brush', 'tool')[0]).toBe('tool.brush');
    expect(top('layers', 'panel')[0]).toBe('panel.layers');
    // Synonyms reach menu names ("brighten" → brightness/exposure).
    expect(top('brighten').some((id) => /brightness|exposure|light/.test(id))).toBe(true);
    expect(top('')).toEqual([]);
  });
  it('leaves out hidden commands and commands the Assistant must not run', () => {
    const all = catalog.search('close script purge history', { limit: 40 }).map((e) => e.id);
    expect(all).not.toContain('file.close');
    expect(all).not.toContain('edit.purge-history');
    expect(all.some((id) => id.startsWith('script'))).toBe(false);
    expect(all.some((id) => id.startsWith('assistant.'))).toBe(false);
  });
  it('describes entries in one compact line with the menu path and input kind', () => {
    expect(catalog.line(catalog.get('filter.apply.gaussian-blur')!)).toBe('filter.apply.gaussian-blur | Gaussian Blur… | Filter > Blur | input: settings');
    expect(catalog.line(catalog.get('image.crop')!)).toBe('image.crop | Crop | Image');
    expect(catalog.line(catalog.get('tool.brush')!)).toMatch(/^tool\.brush \| Brush.* \| toolbar, key B$/);
    expect(commandInput({ id: 'edit.generate-image', label: 'Generate Image…' })).toBe('ai');
    expect(commandInput({ id: 'filter.apply.invert', label: 'Invert' })).toBe('none');
    expect(commandInput({ id: 'image.canvas-size', label: 'Canvas Size…' })).toBe('dialog');
  });
  it('gives settings schemas on demand, loading the filter catalog', async () => {
    const blur = await commandParams('filter.apply.gaussian-blur');
    expect(blur?.find((p) => p.key === 'radius')).toMatchObject({ type: 'number', min: expect.any(Number), max: expect.any(Number) });
    const text = await catalog.details(['filter.apply.gaussian-blur', 'op.add_adjustment_layer', 'tool.brush', 'nope'], { needsSelection: (id) => id === 'filter.apply.gaussian-blur' });
    expect(text).toContain('- radius: number');
    expect(text).toContain('Needs a selection.');
    expect(text).toContain('light-tone: exposure -5..5');
    expect(text).toContain('a plan cannot use them');
    expect(text).toContain('nope: not found');
  });
  it('stems words lightly', () => {
    expect(words('Blurring the Shadows')).toEqual(['blur', 'the', 'shadow']);
  });
});

describe('Assistant argument coercion', () => {
  const params: Param[] = [
    { key: 'radius', type: 'number', min: 0, max: 250, label: 'Radius' },
    { key: 'count', type: 'integer', min: 1, max: 4 },
    { key: 'mode', type: 'enum', options: [{ value: 'soft-light', label: 'Soft Light' }, { value: 'multiply', label: 'Multiply' }] },
    { key: 'color', type: 'color' },
    { key: 'on', type: 'boolean' },
    { key: 'text', type: 'text', required: true },
  ];
  it('converts numbers, choices, colors and switches the way a person would mean them', () => {
    const c = coerceArgs(params, { Radius: '12px', count: 2.6, mode: 'Soft Light', color: 'rgb(255, 128, 0)', on: 'yes', text: ' hi ', extra: 1 });
    expect(c.value).toEqual({ radius: 12, count: 3, mode: 'soft-light', color: '#ff8000', on: true, text: 'hi' });
    expect(c.notes).toEqual(['Ignored the unknown setting “extra”.']);
    expect(c.problems).toEqual([]);
  });
  it('clamps out-of-range values with a note and reports what it cannot use', () => {
    const c = coerceArgs(params, { radius: 900, mode: 'overlay', color: 'sort of blue', on: 'maybe' });
    expect(c.value.radius).toBe(250);
    expect(c.notes[0]).toBe('Radius 900 is above the maximum; using 250.');
    expect(c.problems).toEqual([
      'mode must be one of soft-light, multiply (got “overlay”).',
      'color must be a color such as #ff8800 (got “sort of blue”).',
      'on must be on or off (got “maybe”).',
      'text is required.',
    ]);
    expect(coerceArgs(params, 'nonsense').problems[0]).toBe('The settings must be a set of named values.');
  });
  it('parses colors and numbers in common forms', () => {
    expect(parseColor('#abc')).toBe('#aabbcc');
    expect(parseColor('white')).toBe('#ffffff');
    expect(parseColor([255, 0, 10])).toBe('#ff000a');
    expect(parseColor('nope')).toBeUndefined();
    expect(parseNumber('1,5')).toBe(1.5);
    expect(parseNumber('50%')).toBe(50);
    expect(parseNumber('ten')).toBeUndefined();
    expect(matchOption([{ value: 'color burn' }], 'Color-Burn')).toBe('color burn');
    expect(coerceValue({ key: 'p', type: 'point' }, { x: 2, y: '0.5' })).toEqual({ value: { x: 1, y: 0.5 } });
  });
  it('reads aspect ratios and places the largest rectangle', () => {
    expect(parseAspect('16:9')).toBeCloseTo(16 / 9);
    expect(parseAspect('4x5')).toBeCloseTo(0.8);
    expect(parseAspect('wide')).toBeUndefined();
    expect(stepRect({ aspect: '16:9' }, 200, 150)).toEqual({ x: 0, y: 19, width: 200, height: 113 });
    expect(stepRect({ aspect: '1:1', anchor: 'left' }, 300, 200)).toEqual({ x: 0, y: 0, width: 200, height: 200 });
    expect(stepRect({ width: 50, height: 20 }, 100, 100)).toEqual({ x: 25, y: 40, width: 50, height: 20 });
    expect(stepRect({}, 100, 100)).toBeUndefined();
  });
  it('maps flat adjustment settings onto the adjustment model', () => {
    expect(adjustmentParams('hue-saturation', { saturation: 30 }).params).toMatchObject({ master: { hue: 0, saturation: 30, lightness: 0 } });
    expect(adjustmentParams('photo-filter', { color: '#102030' }).params).toMatchObject({ color: [16, 32, 48], preset: 'custom' });
    expect(adjustmentParams('photo-filter', { preset: 'Cooling' }).params.color).toEqual([40, 120, 240]);
    expect(adjustmentParams('light-tone', { exposure: 9 }).notes[0]).toContain('above the maximum');
  });
});

/** A plan environment over a few fake commands. */
function env(over: Partial<PlanEnv> = {}): PlanEnv {
  const list = [
    { id: 'image.crop', label: 'Crop' },
    { id: 'select.all', label: 'All' },
    { id: 'select.deselect', label: 'Deselect' },
    { id: 'filter.apply.gaussian-blur', label: 'Gaussian Blur…' },
    { id: 'image.canvas-size', label: 'Canvas Size…' },
    { id: 'edit.generate-image', label: 'Generate Image…' },
    { id: 'file.close', label: 'Close' },
    { id: 'adjust.invert', label: 'Invert' },
  ];
  const input: Record<string, 'settings' | 'dialog' | 'ai' | 'none'> = { 'filter.apply.gaussian-blur': 'settings', 'image.canvas-size': 'dialog', 'edit.generate-image': 'ai' };
  return {
    entry: (id) => (list.some((c) => c.id === id) ? ({ id, kind: 'command', label: id, path: [], input: input[id] ?? 'none', words: [], descWords: [] } as never) : id === 'tool.brush' ? ({ id, kind: 'tool', label: 'Brush Tool' } as never) : undefined),
    command: (id) => list.find((c) => c.id === id),
    commands: () => list,
    params: (id) =>
      id === 'filter.apply.gaussian-blur'
        ? [{ key: 'radius', type: 'number', min: 0.1, max: 250, label: 'Radius', unit: 'px' }]
        : id === 'edit.generate-image'
          ? [{ key: 'prompt', type: 'text', required: true, label: 'Prompt' }]
          : undefined,
    needsSelection: (id) => id === 'image.crop',
    hasDocument: true,
    hasSelection: false,
    ...over,
  };
}

describe('Assistant plan validation', () => {
  it('resolves steps, coerces their settings and explains problems in plain words', () => {
    const plan = buildPlan(
      {
        title: 'Test',
        steps: [
          { action: 'image.crop' },
          { action: 'Filter > Blur > Gaussian Blur…', args: { radius: '3' } },
          { action: 'tool.brush' },
          { action: 'no.such' },
          { action: 'file.close' },
          { action: 'image.canvas-size', args: { width: 10 } },
          { action: 'op.select', args: { aspect: '16:9' } },
          { action: 'image.crop' },
          { action: 'edit.generate-image', args: { prompt: 'a kite' } },
        ],
      },
      'crop and blur',
      env(),
    );
    const s = plan.steps;
    expect(s[0].problems[0]).toBe('“Crop” needs a selection, and there is none at this point. Add a step that selects an area first.');
    expect(s[1]).toMatchObject({ action: 'filter.apply.gaussian-blur', label: 'Gaussian Blur', args: { radius: 3 }, problems: [] });
    expect(s[1].notes).toContain('Matched “Gaussian Blur…” by its name.');
    expect(commandArg(s[1])).toEqual({ params: { radius: 3 } });
    expect(stepDetail(s[1])).toBe('Radius 3 px');
    expect(s[2].problems[0]).toBe('The Brush Tool is used by hand on the canvas; a plan cannot use it.');
    expect(s[3].problems[0]).toBe('There is no command “no.such”.');
    expect(s[4].problems[0]).toBe('The Assistant does not run “Close”.');
    expect(s[5].problems).toEqual([]);
    expect(s[5].notes[0]).toContain('chosen in its dialog');
    expect(commandArg(s[5])).toBeUndefined();
    // A selection made by an earlier step satisfies the crop.
    expect(s[7].problems).toEqual([]);
    expect(commandArg(s[8])).toEqual({ prefill: { prompt: 'a kite', via: 'assistant' } });
    expect(stepDetail(s[8])).toContain('uses Puter AI credits');
  });
  it('tracks the selection through steps and rechecks after edits', () => {
    const e = env({ hasSelection: true });
    const plan = buildPlan({ steps: [{ action: 'op.add_adjustment_layer', args: { kind: 'curves' } }, { action: 'image.crop' }] }, 'r', e);
    // The adjustment layer takes the selection as its mask, so the crop has none.
    expect(plan.steps[1].problems).toHaveLength(1);
    plan.steps.reverse();
    validatePlan(plan, e);
    expect(plan.steps.every((s) => !s.problems.length)).toBe(true);
    // Editing settings re-coerces them.
    setArgs(plan.steps[1], { kind: 'nonsense' }, e);
    expect(plan.steps[1].problems[0]).toContain('Kind must be one of');
  });
  it('requires a document for most steps', () => {
    const plan = buildPlan({ steps: [{ action: 'select.all' }, { action: 'op.set_colors', args: { foreground: 'red' } }] }, 'r', env({ hasDocument: false }));
    expect(plan.steps[0].problems).toEqual(['Open or create a document first.']);
    expect(plan.steps[1].problems).toEqual([]);
    expect(plan.steps[1].args).toEqual({ foreground: '#ff0000' });
  });
  it('checks operation arguments', () => {
    const plan = buildPlan(
      { steps: [{ action: 'op.crop', args: { aspect: 'wide' } }, { action: 'op.layer_style', args: { style: { glow: true } } }, { action: 'op.add_text', args: {} }, { action: 'op.resize_image', args: {} }] },
      'r',
      env(),
    );
    expect(plan.steps.map((s) => s.problems[0])).toEqual([
      'The aspect ratio “wide” is not understood; use a form like 16:9.',
      'Unknown effect “glow”; use dropShadow, innerShadow, outerGlow, innerGlow, bevel, satin, colorOverlay, stroke.',
      'Text is required.',
      'Give a width, a height or a percentage.',
    ]);
  });
  it('keeps plans to a bounded length', () => {
    const plan = buildPlan({ steps: Array.from({ length: 40 }, () => ({ action: 'select.all' })) }, 'r', env());
    expect(plan.steps).toHaveLength(30);
  });
});

describe('Assistant conversation (scripted model)', () => {
  const reply = (calls: { name: string; args: unknown }[], text = ''): ChatReply => ({ text, calls: calls.map((c, i) => ({ id: `c${i}`, ...c })) });
  function scripted(...replies: (ChatReply | Error)[]) {
    const seen: ChatMessage[][] = [];
    const chat: ChatFn = async (messages) => {
      seen.push(JSON.parse(JSON.stringify(messages)));
      const r = replies.shift();
      if (r instanceof Error) throw r;
      return r ?? reply([], 'done');
    };
    return { chat, seen };
  }
  const base = () => ({ request: 'blur it', history: [], document: 'Document “x”: 10 × 10 px', catalog });
  it('searches, reads details, then proposes a plan', async () => {
    const { chat, seen } = scripted(
      reply([{ name: 'search_catalog', args: { query: 'gaussian blur' } }]),
      reply([{ name: 'get_details', args: { ids: ['filter.apply.gaussian-blur'] } }]),
      reply([{ name: 'propose_plan', args: { title: 'Blur', steps: [{ action: 'filter.apply.gaussian-blur', args: { radius: 2 } }] } }], 'Here you go.'),
    );
    const r = await converse({ ...base(), chat });
    expect(r).toMatchObject({ kind: 'plan', text: 'Here you go.', plan: { title: 'Blur' } });
    expect(seen).toHaveLength(3);
    expect(seen[0][0]).toMatchObject({ role: 'system' });
    expect(String(seen[0][0].content)).toContain('op.add_adjustment_layer');
    const tool1 = seen[1].at(-1) as { role: string; tool_call_id: string; content: string };
    expect(tool1).toMatchObject({ role: 'tool', tool_call_id: 'c0' });
    expect(tool1.content.split('\n')[0]).toBe('filter.apply.gaussian-blur | Gaussian Blur… | Filter > Blur | input: settings');
    expect(seen[1].at(-2)).toMatchObject({ role: 'assistant', tool_calls: [{ id: 'c0', type: 'function', function: { name: 'search_catalog' } }] });
    expect((seen[2].at(-1) as { content: string }).content).toContain('- radius: number');
  });
  it('answers questions and replies in text', async () => {
    const a = await converse({ ...base(), chat: scripted(reply([{ name: 'answer', args: { text: 'Use Image > Crop.', pointers: ['image.crop', 3] } }])).chat });
    expect(a).toEqual({ kind: 'answer', text: 'Use Image > Crop.', pointers: ['image.crop'] });
    const t = await converse({ ...base(), chat: scripted(reply([], 'Which layer?')).chat });
    expect(t).toEqual({ kind: 'text', text: 'Which layer?' });
  });
  it('sends the preview image and retries without it when the route refuses images', async () => {
    const err = Object.assign(new Error('images not supported'), { code: 'bad-request' });
    const { chat, seen } = scripted(err, reply([], 'ok'));
    await converse({ ...base(), image: 'data:image/jpeg;base64,AAAA', chat });
    expect(JSON.stringify(seen[0].at(-1))).toContain('image_url');
    expect(JSON.stringify(seen[1].at(-1))).not.toContain('image_url');
  });
  it('gives up after a bounded number of lookups', async () => {
    const chat: ChatFn = async () => reply([{ name: 'search_catalog', args: { query: 'x' } }]);
    expect(await converse({ ...base(), chat })).toMatchObject({ kind: 'text', text: expect.stringContaining('could not settle') });
  });
  it('carries earlier turns as plain text', async () => {
    const { chat, seen } = scripted(reply([], 'ok'));
    await converse({ ...base(), history: [{ role: 'user', text: 'first' }, { role: 'assistant', text: 'Proposed plan …' }], chat });
    expect(seen[0].slice(1, 3)).toEqual([{ role: 'user', content: 'first' }, { role: 'assistant', content: 'Proposed plan …' }]);
  });
  it('exposes four tools and a stable system prompt', () => {
    expect(TOOLS.map((t) => t.function.name)).toEqual(['search_catalog', 'get_details', 'propose_plan', 'answer']);
    expect(systemPrompt(catalog)).toBe(systemPrompt(catalog));
    expect(systemPrompt(catalog)).toContain('select.subject | Subject | Select');
  });
  it('reads OpenAI-style and content-block tool calls', () => {
    expect(parseChatReply({ message: { content: 'hi', tool_calls: [{ id: 'a', function: { name: 'answer', arguments: '{"text":"x"}' } }] } })).toEqual({ text: 'hi', calls: [{ id: 'a', name: 'answer', args: { text: 'x' } }] });
    expect(parseChatReply({ message: { content: [{ type: 'text', text: 'Hm. ' }, { type: 'tool_use', id: 'b', name: 'search_catalog', input: { query: 'q' } }] } })).toEqual({ text: 'Hm.', calls: [{ id: 'b', name: 'search_catalog', args: { query: 'q' } }] });
    expect(parseChatReply({ message: { tool_calls: [{ id: 'c', function: { name: 'answer', arguments: '{bad' } }] } }).calls[0].args).toEqual({ __unparsed: '{bad' });
    expect(parseChatReply('plain')).toEqual({ text: 'plain', calls: [] });
  });
});

/** The editor parts the scripting host uses, over a real session and history. */
function mockEditor() {
  const doc = newDocument(64, 48, 'Mock');
  const s = new DocumentSession(doc);
  s.hasDocument = true;
  const bg = newPixelLayer('Background', doc, gridFromImage(s.assets.tiles, { width: 64, height: 48, data: new Uint8ClampedArray(64 * 48 * 4).fill(200) }));
  s.history.reset({ ...doc, layers: [bg] });
  s.selectedIds = new Set([bg.id]);
  const e = {
    sessions: [s],
    session: s,
    color: '#000000',
    background: '#ffffff',
    hasDocument: true,
    get doc() {
      return s.doc;
    },
    get assets() {
      return s.assets;
    },
    get history(): History {
      return s.history;
    },
    get selectedIds() {
      return s.selectedIds;
    },
    async switchSession() {},
    selectLayers(ids: string[]) {
      s.selectedIds = new Set(ids);
    },
    command(label: string, edit: (d: PhotoDocument) => void) {
      s.history.execute(label, edit);
    },
    update() {},
    message() {},
    setForeground(c: string) {
      e.color = c;
    },
    setBackground(c: string) {
      e.background = c;
    },
  };
  return e;
}

describe('Assistant runs', () => {
  const planEnv = () => env({ command: (id) => (commands.has(id) ? { id, label: commands.get(id)!.label } : env().command(id)) });
  it('runs every step as one undo step named after the request', async () => {
    const e = mockEditor();
    registerCommand({ id: 'test.assistant-half', label: 'Half', run: (ed) => (ed as unknown as ReturnType<typeof mockEditor>).command('Half', (d) => void (d.layers[0].opacity = 0.5)) });
    const plan = buildPlan(
      {
        title: 'Tint and title',
        steps: [{ action: 'test.assistant-half' }, { action: 'op.add_fill_layer', args: { color: 'orange', opacity: '30', blendMode: 'soft light' } }, { action: 'op.set_layer', args: { layer: 'Background', name: 'Photo' } }, { action: 'op.set_colors', args: { foreground: '#123456' } }],
      },
      'tint it',
      planEnv(),
    );
    expect(plan.steps.flatMap((s) => s.problems)).toEqual([]);
    const start = e.history.position;
    const run = new PlanRun(e as unknown as Editor, plan);
    await run.run();
    expect(run.done).toBe(true);
    expect(plan.steps.map((s) => s.status)).toEqual(['done', 'done', 'done', 'done']);
    expect(e.history.position).toBe(start + 1);
    expect(e.history.labels.at(-1)).toBe('Assistant: Tint and title');
    expect(e.doc.layers.map((l) => [l.name, l.kind, l.opacity, l.blend])).toEqual([['Photo', 'pixel', 0.5, 'normal'], ['Color Fill', 'solid', 0.3, 'soft light']]);
    expect(e.color).toBe('#123456');
    e.history.undo();
    expect(e.doc.layers.map((l) => [l.name, l.opacity])).toEqual([['Background', 1]]);
    commands.delete('test.assistant-half');
  });
  it('stops at a failing step and keeps the steps before it as one undo step', async () => {
    const e = mockEditor();
    const plan = buildPlan({ title: 'Fails', steps: [{ action: 'op.set_layer', args: { opacity: 20 } }, { action: 'op.select_layer', args: { layer: 'Missing' } }, { action: 'op.set_layer', args: { opacity: 80 } }] }, 'r', planEnv());
    const start = e.history.position;
    const run = new PlanRun(e as unknown as Editor, plan);
    await expect(run.run()).rejects.toThrow('There is no layer named “Missing”.');
    run.finish();
    expect(plan.steps.map((s) => s.status)).toEqual(['done', 'failed', 'skipped']);
    expect(plan.steps[1].error).toBe('There is no layer named “Missing”.');
    expect(e.history.position).toBe(start + 1);
    expect(e.doc.layers[0].opacity).toBeCloseTo(0.2);
  });
  it('runs a step at a time and stops between steps', async () => {
    const e = mockEditor();
    const plan = buildPlan({ title: 'Steps', steps: [{ action: 'op.set_layer', args: { opacity: 40 } }, { action: 'op.select', args: { x: 2, y: 2, width: 10, height: 10 } }, { action: 'op.set_layer', args: { visible: false } }] }, 'r', planEnv());
    const start = e.history.position;
    const run = new PlanRun(e as unknown as Editor, plan);
    await run.run(1);
    expect(run.done).toBe(false);
    await run.run(1);
    expect(e.doc.selection).toEqual({ x: 2, y: 2, width: 10, height: 10 });
    run.stop();
    await run.run();
    expect(run.done).toBe(true);
    expect(plan.steps.map((s) => s.status)).toEqual(['done', 'done', 'skipped']);
    expect(e.history.position).toBe(start + 1);
    expect(e.doc.layers[0].visible).toBe(true);
  });
  it('refuses a step with unresolved problems', async () => {
    const e = mockEditor();
    const plan = buildPlan({ steps: [{ action: 'nope' }] }, 'r', planEnv());
    await expect(new PlanRun(e as unknown as Editor, plan).run()).rejects.toThrow('There is no command “nope”.');
  });
  it('names the undo step after the plan', () => {
    expect(runLabel({ title: '', request: 'make the sky more dramatic and then crop the image to sixteen by nine' })).toBe('Assistant: make the sky more dramatic and then crop the im…');
  });
});

describe('Generation History storage', () => {
  const blob = (n: number) => new Blob([new Uint8Array(n)]);
  const entry = (prompt: string, kind: 'generate' | 'fill' = 'generate', time = 0) => ({ kind, prompt, settings: {}, docName: 'Doc', width: 10, height: 10, time });
  it('keeps entries newest first and prunes by count and size', async () => {
    const store = new GenerationStore(new MemoryStore());
    for (let i = 0; i < 5; i++) await store.add(entry(`p${i}`, 'generate', i), blob(100), { count: 3, bytes: 1e9 });
    expect((await store.list()).map((x) => x.prompt)).toEqual(['p4', 'p3', 'p2']);
    await store.add(entry('big', 'generate', 10), blob(1000), { count: 10, bytes: 1050 });
    expect((await store.list()).map((x) => x.prompt)).toEqual(['big']);
    const [x] = await store.list();
    expect((await store.image(x.id))?.size).toBe(1000);
    await store.remove(x.id);
    expect(await store.list()).toEqual([]);
  });
  it('filters by kind and searches prompts', async () => {
    const store = new GenerationStore(new MemoryStore());
    await store.add(entry('red kite over hills', 'generate', 1), blob(1));
    await store.add(entry('wooden bench', 'fill', 2), blob(1));
    const list = await store.list();
    expect(filterGenerations(list, { kind: 'fill' }).map((x) => x.prompt)).toEqual(['wooden bench']);
    expect(filterGenerations(list, { query: 'KITE hills' }).map((x) => x.prompt)).toEqual(['red kite over hills']);
    expect(filterGenerations(list, { kind: 'all', query: 'doc' })).toHaveLength(2);
    await store.clear();
    expect(await store.list()).toEqual([]);
  });
});
