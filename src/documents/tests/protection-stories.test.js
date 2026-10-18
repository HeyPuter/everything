import { beforeAll, afterAll, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { DocxPackage } from '../src/engine/docx.js';
import { TextDocument } from '../src/engine/model.js';
import { StorySession } from '../src/engine/story-session.js';
import { protectionGuard } from '../src/engine/protection.js';

let dom;
beforeAll(() => { dom = new JSDOM(); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => dom.window.close());

async function footerSession(protection) {
  const pkg = await DocxPackage.open(readFileSync('public/fixtures/default-paragraph-spacing-after.docx'));
  const doc = new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets);
  doc.trackChanges = true; doc.revisionAuthor = 'Reviewer';
  const session = new StorySession(doc, pkg.pageStories);
  session.guard = protectionGuard({ enforcement: true, ...protection }, { name: 'Reviewer' });
  const path = Object.keys(pkg.pageStories.stories).find(p => ['header', 'footer'].includes(pkg.pageStories.stories[p].kind) && pkg.pageStories.stories[p].editable !== false);
  session.activate(path);
  return session;
}

it('refuses changes to a header or footer where every change must be tracked', async () => {
  const session = await footerSession({ edit: 'trackedChanges' });
  const before = session.model.text;
  expect(() => session.run(m => { m.select(0, m.text.length); m.replace('Rewritten without a trace'); })).toThrow(/tracked/);
  expect(session.model.text).toBe(before);
});

it('applies formatting restrictions in headers and footers too', async () => {
  const session = await footerSession({ edit: 'none', formatting: true });
  expect(() => session.run(m => { m.select(0, Math.max(1, m.text.length)); m.setRunFormat({ bold: true }); })).toThrow(/Formatting is restricted/);
  session.run(m => { m.select(0); m.replace('Typed '); });
  expect(session.model.text.startsWith('Typed ')).toBe(true);
});
