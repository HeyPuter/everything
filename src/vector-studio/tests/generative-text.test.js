import { describe, it, expect, vi, afterEach } from 'vitest';
import { bootAppWithFeatures } from './helpers.js';
import { fakeAI, until, flush } from './generative-helpers.js';
import { createText } from '../src/model/nodes.js';
import { layoutText } from '../src/model/text-layout.js';
import { frameCapacity, textTargets, applyTexts } from '../src/features/generative/text-ai.js';

afterEach(() => {
  vi.restoreAllMocks();
  document.querySelectorAll('dialog').forEach((d) => d.remove());
});

async function setup(chat) {
  const app = await bootAppWithFeatures();
  const ai = fakeAI({ chat });
  app.generativeAI = ai;
  const ed = app.newDocument({ width: 400, height: 300 });
  return { app, ed, doc: ed.doc, ai };
}

function addText(doc, text, extra = {}) {
  const n = createText(text, 20, 40, extra);
  doc.transact('add text', () => doc.insert(n, doc.layers()[0].id));
  return n.id;
}

const dialog = () => until(() => document.querySelector('dialog[open]'));
const button = (dlg, label) => [...dlg.querySelectorAll('button')].find((b) => b.textContent.trim() === label);

describe('text targets', () => {
  it('use the selected characters while editing type', async () => {
    const { app, ed, doc } = await setup();
    const id = addText(doc, 'Hello wrold today');
    ed.select([id]);
    expect(textTargets(app)).toEqual([{ id, start: 0, end: 17 }]);
    const setSelection = vi.fn();
    app.typeSession = { editor: ed, id, node: () => doc.get(id), range: () => [6, 11], setSelection };
    ed.textEdit = { id, caret: 11, anchor: 6 };
    expect(textTargets(app)).toEqual([{ id, start: 6, end: 11 }]);
    applyTexts(app, textTargets(app), ['world'], 'Fix');
    expect(doc.get(id).text).toBe('Hello world today');
    expect(setSelection).toHaveBeenCalledWith(6, 11);
  });
});

describe('Rewrite', () => {
  it('offers alternatives and applies the chosen one with its style', async () => {
    const { app, ed, doc, ai } = await setup(() => JSON.stringify(['Big sale today!', 'Everything is on sale.', 'Save big now.']));
    const id = addText(doc, 'We have a sale.', { char: { ...createText('', 0, 0).char, fontSize: 30 } });
    ed.select([id]);
    expect(app.commands.isEnabled('generative.text.rewrite')).toBe(true);
    const done = app.commands.run('generative.text.rewrite');
    const dlg = await dialog();
    expect(dlg.querySelector('.gen-original').textContent).toBe('We have a sale.');
    expect(button(dlg, 'Apply').disabled).toBe(true);
    dlg.querySelector('select').value = 'playful';
    dlg.querySelector('.gen-go').click();
    await until(() => dlg.querySelectorAll('.gen-option').length === 3);
    expect(ai.calls.chat[0].prompt).toMatch(/playful/);
    expect(ai.calls.chat[0].prompt).toMatch(/We have a sale\./);
    dlg.querySelectorAll('.gen-option')[1].click();
    expect(dlg.querySelectorAll('.gen-option')[1].getAttribute('aria-checked')).toBe('true');
    button(dlg, 'Apply').click();
    await done;
    expect(doc.get(id).text).toBe('Everything is on sale.');
    expect(doc.get(id).char.fontSize).toBe(30);
    expect(doc.undoLabel).toBe('Rewrite');
    doc.undo();
    expect(doc.get(id).text).toBe('We have a sale.');
    expect(app.generativeHistory.entries[0]).toMatchObject({ kind: 'text', settings: { action: 'rewrite', tone: 'playful' } });
  });
});

describe('Proofread', () => {
  it('shows the corrections, then applies them', async () => {
    const { app, ed, doc } = await setup(() => JSON.stringify({ text: 'Hello world today', changes: [{ from: 'wrold', to: 'world', why: 'spelling' }] }));
    const id = addText(doc, 'Hello wrold today');
    ed.select([id]);
    const done = app.commands.run('generative.text.proofread');
    const dlg = await dialog();
    expect(dlg.querySelector('del').textContent).toBe('wrold');
    expect(dlg.querySelector('ins').textContent).toBe('world');
    expect(dlg.querySelector('.gen-proof-notes').textContent).toMatch(/spelling/);
    button(dlg, 'Apply Corrections').click();
    await done;
    expect(doc.get(id).text).toBe('Hello world today');
    expect(doc.undoLabel).toBe('Proofread');
  });

  it('says so when nothing needs fixing', async () => {
    const { app, ed, doc } = await setup(() => JSON.stringify({ text: 'All good.', changes: [] }));
    const id = addText(doc, 'All good.');
    ed.select([id]);
    const notify = vi.spyOn(app, 'notify');
    await app.commands.run('generative.text.proofread');
    expect(notify).toHaveBeenCalledWith('No corrections needed.', expect.anything());
    expect(document.querySelector('dialog[open]')).toBe(null);
  });
});

describe('Translate', () => {
  it('translates every selected text object in one step and remembers the language', async () => {
    const { app, ed, doc, ai } = await setup((p) => (p.includes('Good morning') ? 'Buenos días' : 'Gracias'));
    const a = addText(doc, 'Good morning');
    const b = addText(doc, 'Thank you');
    ed.select([a, b]);
    const done = app.commands.run('generative.text.translate');
    const dlg = await dialog();
    dlg.querySelector('select').value = 'Spanish';
    button(dlg, 'Translate').click();
    await done;
    expect(ai.calls.chat).toHaveLength(2);
    expect(ai.calls.chat[0].prompt).toMatch(/into Spanish/);
    expect(doc.get(a).text).toBe('Buenos días');
    expect(doc.get(b).text).toBe('Gracias');
    expect(app.prefs.get('generativeLanguage')).toBe('Spanish');
    doc.undo();
    expect(doc.get(a).text).toBe('Good morning');
    expect(doc.get(b).text).toBe('Thank you');
  });
});

describe('Generate Text', () => {
  it('writes into a new text frame on the artboard', async () => {
    const { app, ed, doc, ai } = await setup(() => 'Open Monday to Saturday, 8 to 6.');
    ed.clearSelection();
    const done = app.commands.run('generative.text.generate');
    const dlg = await dialog();
    expect(dlg.textContent).toMatch(/new text frame/);
    dlg.querySelector('.gen-prompt').value = 'bakery opening hours';
    dlg.querySelector('.gen-go').click();
    await until(() => !dlg.querySelector('.gen-result').closest('[hidden]'));
    expect(ai.calls.chat[0].prompt).toMatch(/bakery opening hours/);
    expect(button(dlg, 'Insert').disabled).toBe(false);
    dlg.querySelector('.gen-result').value = 'Open Monday to Saturday, 8 to 6!';
    button(dlg, 'Insert').click();
    await done;
    const node = doc.get([...ed.selection][0]);
    expect(node.type).toBe('text');
    expect(node.kind).toBe('area');
    expect(node.text).toBe('Open Monday to Saturday, 8 to 6!');
    expect(node.x).toBeGreaterThan(0);
    expect(node.x + node.width).toBeLessThan(400);
  });

  it('replaces the selected text', async () => {
    const { app, ed, doc } = await setup(() => 'Fresh Bread Daily');
    const id = addText(doc, 'Title');
    ed.select([id]);
    const done = app.commands.run('generative.text.generate');
    const dlg = await dialog();
    dlg.querySelector('.gen-prompt').value = 'a bakery headline';
    dlg.querySelector('.gen-go').click();
    await until(() => !button(dlg, 'Insert').disabled);
    button(dlg, 'Insert').click();
    await done;
    expect(doc.get(id).text).toBe('Fresh Bread Daily');
  });
});

describe('Fit Text to Frame', () => {
  it('measures the room in a frame', async () => {
    const n = createText('Short', 0, 0, { kind: 'area', width: 120, height: 40 });
    const cap = frameCapacity(n);
    expect(cap.overflow).toBe(false);
    expect(cap.capacity).toBeGreaterThan(20);
    const over = createText('word '.repeat(300), 0, 0, { kind: 'area', width: 120, height: 40 });
    expect(frameCapacity(over).overflow).toBe(true);
    expect(frameCapacity(over).capacity).toBeLessThan(over.text.length);
  });

  it('rewrites overflowing area type until it fits', async () => {
    const replies = ['word '.repeat(200).trim(), 'Short and sweet.'];
    const { app, ed, doc, ai } = await setup(() => replies.shift() || 'x');
    const id = addText(doc, 'word '.repeat(300).trim(), { kind: 'area', width: 120, height: 40 });
    ed.select([id]);
    expect(layoutText(doc.get(id)).overflow).toBe(true);
    expect(app.commands.isEnabled('generative.text.fit')).toBe(true);
    await app.commands.run('generative.text.fit');
    await flush();
    expect(ai.calls.chat).toHaveLength(2);
    expect(doc.get(id).text).toBe('Short and sweet.');
    expect(layoutText(doc.get(id)).overflow).toBe(false);
  });

  it('is only for area type', async () => {
    const { app, ed, doc } = await setup();
    ed.select([addText(doc, 'Point type')]);
    expect(app.commands.isEnabled('generative.text.fit')).toBe(false);
  });
});

describe('signed out', () => {
  it('explains instead of calling the service', async () => {
    const app = await bootAppWithFeatures();
    const ed = app.newDocument();
    app.puter = { ai: { chat: vi.fn(), txt2img: vi.fn() } };
    const id = addText(ed.doc, 'Hello');
    ed.select([id]);
    const notify = vi.spyOn(app, 'notify');
    await app.commands.run('generative.text.proofread');
    expect(notify).toHaveBeenCalledWith(expect.stringMatching(/Sign in to Puter/), expect.anything());
    expect(app.puter.ai.chat).not.toHaveBeenCalled();
  });
});
