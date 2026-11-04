// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { documentHtml } from '../src/lib/mail-messages.js';
import { copyFragment, fragmentHtml } from '../src/engine/clipboard-fragment.js';
import * as Y from 'yjs';
import { TextDocument, paragraph } from '../src/engine/model.js';
import { StorySession } from '../src/engine/story-session.js';
import { protectionGuard } from '../src/engine/protection.js';
import { createSharedDoc } from '../src/collab/shared-doc.js';
import { CollabBinding, editorState } from '../src/collab/binding.js';
import { CollabClient } from '../src/collab/client.js';
import { MemoryHub, checkCommentOnly } from '../src/collab/transports.js';
import { colorFor, PERSON_COLORS, shareLink, parseLink, initials } from '../src/collab/protocol.js';

/** Just enough of CanvasEditor for the binding: a story session and no-op painting. */
class FakeEngine {
  constructor(paragraphs) { this.session = new StorySession(new TextDocument(paragraphs)); this.images = new Map(); this.composition = null; this.readOnly = false; this.viewOnly = false; this.changes = 0; }
  get model() { return this.session.model; }
  relayout() {} paint() {} syncInput() {} focus() {}
  onChange() { this.changes++; }
  setViewOnly(on) { this.viewOnly = !!on; }
  travelHistory(direction) { this.session[direction](); }
  undo() { this.travelHistory('undo'); }
  redo() { this.travelHistory('redo'); }
  execute(action) { if (this.readOnly || this.viewOnly) return false; try { this.session.run(() => action(this.model)); return true; } catch { return false; } }
}

const tick = (ms = 5) => new Promise(r => setTimeout(r, ms));
async function settle() { for (let i = 0; i < 6; i++) await tick(); }

async function room(text = 'Hello world', roles = ['owner', 'editor']) {
  const seed = new TextDocument([paragraph(text)]);
  const hub = new MemoryHub(Y.encodeStateAsUpdate(createSharedDoc(editorState({ session: { body: seed, storyEdits: {} } }))));
  const people = [];
  for (const [i, role] of roles.entries()) {
    const client = new CollabClient({ transport: hub.connect(role), user: { id: `u${i}`, name: `Person ${i}` }, room: 'r1', sendDelay: 0 });
    const joined = await client.connect();
    const engine = new FakeEngine([paragraph('')]);
    const binding = new CollabBinding({ engine, ydoc: client.ydoc, session: { id: client.session, name: client.user.name } });
    client.attach(binding);
    binding.apply();
    binding.setRole(joined.role, { commentGuard: protectionGuard({ edit: 'comments', enforcement: true }, { name: client.user.name }) });
    people.push({ client, engine, binding });
  }
  return { hub, people };
}



/**
 * Anyone in a co-editing room writes the shared document, and the formatting it held went into the model as
 * written: a peer's color of `000"><img src=…>` became markup in the HTML of every email a merge sent and of
 * every copy put on the clipboard. Shared formatting is held to the values the editor writes before it becomes
 * the model, and the HTML writers take only those values.
 */
const EVIL = '000000"><img src="https://evil.invalid/x" data-x="';
const images = html => new DOMParser().parseFromString(html, 'text/html').querySelectorAll('img').length;
const htmlOf = model => {
  model.select(0, model.text.length);
  return { mail: documentHtml(model), copy: fragmentHtml(copyFragment(model)) };
};

it('keeps formatting a peer wrote out of the HTML of merged email and copies', async () => {
  const { people: [ann, bob] } = await room('Hello world');
  const body = ann.client.ydoc.getText('body');
  body.format(0, 5, { 'r:color': JSON.stringify(EVIL), 'r:fontSize': JSON.stringify('12pt"><img src=x>'), 'r:highlight': JSON.stringify('constructor'), 'r:underlineColor': JSON.stringify(EVIL) });
  body.format(5, 1, { 'r:color': JSON.stringify('1F4E79'), 'r:fontSize': JSON.stringify(14) });
  body.format(11, 1, { 'p:format': JSON.stringify({ alignment: 'center"><img src=x data-x="' }) });
  await settle();
  const [run, kept] = bob.engine.model.paragraphs[0].runs;
  expect([run.color, run.fontSize, run.highlight, run.underlineColor]).toEqual(['auto', 12, 'none', 'auto']);
  // Values the editor writes come through as they are.
  expect([kept.color, kept.fontSize]).toEqual(['1F4E79', 14]);
  expect(bob.engine.model.paragraphs[0].format?.alignment).toBeUndefined();
  const { mail, copy } = htmlOf(bob.engine.model);
  expect(images(mail)).toBe(0);
  expect(images(copy)).toBe(0);
  expect(mail).toContain('color:#1F4E79;font-size:14pt');
});

it('keeps formatting out of a single-editor snapshot a peer wrote', async () => {
  const { people: [ann, bob] } = await room('Hello world');
  const snapshot = JSON.parse(JSON.stringify(bob.engine.model.paragraphs));
  Object.assign(snapshot[0].runs[0], { text: 'Howdy world', color: EVIL, fontSize: '1"><img src=x>' });
  snapshot[0].format = { ...snapshot[0].format, alignment: 'right"><img src=x>' };
  ann.client.ydoc.transact(() => {
    const meta = ann.client.ydoc.getMap('meta');
    meta.set('snapshot', JSON.stringify({ ...JSON.parse(JSON.stringify({ paragraphs: snapshot, tables: [], pageSettings: bob.engine.model.pageSettings, numbering: bob.engine.model.numbering, styles: bob.engine.model.styles, stylesEnabled: bob.engine.model.stylesEnabled })) }));
    meta.set('mode', 'single');
  });
  await settle();
  const model = bob.engine.model;
  expect(model.text).toBe('Howdy world');
  expect(model.paragraphs[0].runs[0].color).toBe('auto');
  const { mail, copy } = htmlOf(model);
  expect(images(mail)).toBe(0);
  expect(images(copy)).toBe(0);
});

it('writes only colors, sizes and alignments the editor makes into email and copied HTML', () => {
  const model = new TextDocument([{ runs: [{ text: 'Hi', color: EVIL, fontSize: '9pt"><img src=x>', highlight: 'constructor' }, { text: ' there', color: '00AA00', fontSize: 16, highlight: 'yellow' }], format: { alignment: 'both"><img src=x>' } }]);
  // Set after construction, as a model rebuilt from shared state that skipped the checks would hold them.
  Object.assign(model.paragraphs[0].runs[0], { color: EVIL, fontSize: '9pt"><img src=x>', highlight: 'constructor' });
  model.paragraphs[0].format = { ...model.paragraphs[0].format, alignment: 'both"><img src=x>' };
  const { mail, copy } = htmlOf(model);
  expect(images(mail)).toBe(0);
  expect(images(copy)).toBe(0);
  expect(mail).toContain('<span style="color:#00AA00;font-size:16pt"> there</span>');
  expect(copy).toContain('color:#00AA00;background-color:#FFFF00;font-size:16pt');
  model.paragraphs[0].format = { ...model.paragraphs[0].format, alignment: 'both' };
  expect(htmlOf(model).mail).toContain('<p style="text-align:justify">');
});
