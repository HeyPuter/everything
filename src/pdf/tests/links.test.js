import { describe, expect, it } from 'vitest';
import { PDFDocument, PDFName, PDFNumber, PDFString } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import {
  addLink,
  annotationId,
  listLinks,
  normalizeUrl,
  removeLink,
  safeLinkUrl,
  updateLink,
} from '../src/core/links.js';

async function annotations(bytes, number = 1) {
  const task = pdfjs.getDocument({ data: bytes.slice() });
  try {
    const pdf = await task.promise;
    const page = await pdf.getPage(number);
    const list = await page.getAnnotations();
    return { pdf, list: list.filter((a) => a.subtype === 'Link'), destroy: () => task.destroy() };
  } catch (error) {
    await task.destroy();
    throw error;
  }
}

describe('links', () => {
  it('updates destinations in place, preserves appearance, and validates before changing anything', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([300, 300]);
    doc.addPage([300, 300]);
    const id = addLink(doc, 0, {
      rect: { x: 10, y: 30, width: 90, height: 20 },
      url: 'example.com',
    });
    const ref = doc.getPage(0).node.Annots().get(0);
    const dict = doc.context.lookup(ref);
    dict.set(PDFName.of('Border'), doc.context.obj([0, 0, 2]));
    dict.set(PDFName.of('C'), doc.context.obj([1, 0, 0]));
    const before = dict.toString();
    expect(() => updateLink(doc, 0, id, { url: 'javascript:alert(1)' })).toThrow();
    expect(() => updateLink(doc, 0, id, { page: 2 })).toThrow();
    expect(dict.toString()).toBe(before);
    expect(updateLink(doc, 1, id, { page: 0 })).toBe(false);
    expect(updateLink(doc, 0, id, { page: 1 })).toBe(true);
    expect(dict.has(PDFName.of('A'))).toBe(false);
    expect(dict.lookup(PDFName.of('Dest')).get(0)).toBe(doc.getPage(1).ref);
    expect(updateLink(doc, 0, id, { url: 'example.org/a)b' })).toBe(true);
    expect(dict.has(PDFName.of('Dest'))).toBe(false);
    expect(doc.getPage(0).node.Annots().asArray()).toEqual([ref]);
    const reopened = await PDFDocument.load(await doc.save());
    expect(listLinks(reopened, 0)).toEqual([
      { id, rect: [10, 30, 100, 50], url: 'https://example.org/a)b' },
    ]);
    const saved = reopened.context.lookup(reopened.getPage(0).node.Annots().get(0));
    expect(saved.lookup(PDFName.of('Border')).toString()).toBe('[ 0 0 2 ]');
    expect(saved.lookup(PDFName.of('C')).toString()).toBe('[ 1 0 0 ]');
  });
  it('normalizes typed addresses and refuses what a link cannot open', () => {
    expect(normalizeUrl('example.com/page')).toBe('https://example.com/page');
    expect(normalizeUrl('  http://example.org ')).toBe('http://example.org/');
    expect(normalizeUrl('mailto:hi@example.com')).toBe('mailto:hi@example.com');
    expect(normalizeUrl('tel:+15551234')).toBe('tel:+15551234');
    expect(normalizeUrl(' hi@example.com ')).toBe('mailto:hi@example.com');
    expect(normalizeUrl('example.com/@team')).toBe('https://example.com/@team');
    expect(normalizeUrl('https://example.com/ü?q=a b')).toBe('https://example.com/%C3%BC?q=a%20b');
    expect(() => normalizeUrl('')).toThrow('Enter the web address');
    expect(() => normalizeUrl('javascript:alert(1)')).toThrow('web pages, email addresses');
    expect(() => normalizeUrl('file:///etc/passwd')).toThrow('web pages, email addresses');
    expect(() => normalizeUrl('nodots')).toThrow('valid web address');
    expect(() => normalizeUrl('http://')).toThrow('valid web address');
    expect(() => normalizeUrl('x'.repeat(2100))).toThrow('2,048');
  });
  it('makes a typed email with a subject a mail link, and a typed phone number a phone link', () => {
    expect(normalizeUrl('hi@example.com?subject=Our call')).toBe(
      'mailto:hi@example.com?subject=Our%20call',
    );
    expect(normalizeUrl('+1 (555) 123-4567')).toBe('tel:+1(555)123-4567');
    expect(normalizeUrl('555-1234')).toBe('tel:555-1234');
    // Addresses written out with numbers stay web addresses.
    expect(normalizeUrl('192.168.0.1')).toBe('https://192.168.0.1/');
    expect(normalizeUrl('localhost:3000/x')).toBe('https://localhost:3000/x');
  });
  it('refuses mail and phone links without an address, and a number read as an address', () => {
    expect(() => normalizeUrl('mailto:')).toThrow('Enter the email address');
    expect(() => normalizeUrl('mailto:?subject=Hi')).toThrow('Enter the email address');
    expect(() => normalizeUrl('tel:')).toThrow('Enter the phone number');
    // "12" (a page number typed in the wrong field, say) would link to https://0.0.0.12/.
    expect(() => normalizeUrl('12')).toThrow('valid web address');
    expect(() => normalizeUrl('0x7f.1')).toThrow('valid web address');
    expect(normalizeUrl('http://10.0.0.1:8080/')).toBe('http://10.0.0.1:8080/');
  });
  it('opens only web, mail, and phone addresses found in a PDF', () => {
    expect(safeLinkUrl('https://example.com/a?b=c#d')).toBe('https://example.com/a?b=c#d');
    expect(safeLinkUrl(' http://example.org ')).toBe('http://example.org/');
    expect(safeLinkUrl('ftp://files.example.com/x')).toBe('ftp://files.example.com/x');
    expect(safeLinkUrl('mailto:hi@example.com')).toBe('mailto:hi@example.com');
    expect(safeLinkUrl('tel:+15551234')).toBe('tel:+15551234');
    for (const unsafe of [
      'javascript:alert(1)',
      'JavaScript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'file:///etc/passwd',
      'vbscript:msgbox(1)',
      'blob:https://example.com/1234',
      'chrome://settings',
      'page2.html',
      '',
      null,
      undefined,
      'x'.repeat(2100),
    ])
      expect(safeLinkUrl(unsafe), String(unsafe)).toBeNull();
  });
  it('checks the encoded address length and accepts the exact limit consistently', async () => {
    const prefix = 'https://example.com/';
    for (const address of [prefix + '界'.repeat(230), 'example.com/' + 'a'.repeat(2030)])
      expect(() => normalizeUrl(address)).toThrow('2,048');
    const typed = prefix + '界'.repeat(225) + 'abc';
    const normalized = normalizeUrl(typed);
    expect(normalized).toHaveLength(2048);
    expect(normalizeUrl(normalized)).toBe(normalized);
    expect(safeLinkUrl(normalized)).toBe(normalized);
    const doc = await PDFDocument.create();
    doc.addPage([300, 300]);
    const id = addLink(doc, 0, {
      rect: { x: 10, y: 10, width: 100, height: 20 },
      url: normalized,
    });
    const before = await doc.save();
    expect(() => updateLink(doc, 0, id, { url: prefix + '界'.repeat(230) })).toThrow('2,048');
    expect(await doc.save()).toEqual(before);
    const seen = await annotations(before);
    try {
      expect(seen.list[0].url).toBe(normalized);
    } finally {
      await seen.destroy();
    }
  });
  it('accepts bare domains with ports and IPv6 web addresses without permitting other schemes', () => {
    for (const [typed, expected] of [
      ['example.com:8080/report?q=1#part', 'https://example.com:8080/report?q=1#part'],
      ['LOCALHOST:8443/report', 'https://localhost:8443/report'],
      ['127.0.0.1:8080/report', 'https://127.0.0.1:8080/report'],
      ['[::1]:8080/report', 'https://[::1]:8080/report'],
      ['https://[2001:db8::1]/report', 'https://[2001:db8::1]/report'],
    ]) {
      expect(normalizeUrl(typed)).toBe(expected);
      expect(normalizeUrl(expected)).toBe(expected);
    }
    for (const invalid of [
      'javascript:1234',
      'data:1234',
      'file:1234',
      'example.com:65536',
      '[::bad::]:8080',
    ])
      expect(() => normalizeUrl(invalid)).toThrow();
  });
  it('adds web and page links that PDF.js reports, lists them by id, and removes one', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([300, 300]);
    doc.addPage([300, 300]);
    const web = addLink(doc, 0, {
      rect: { x: 20, y: 200, width: 100, height: 20 },
      url: 'example.com',
    });
    const jump = addLink(doc, 0, { rect: { x: 20, y: 100, width: 100, height: 20 }, page: 1 });
    expect(web).toMatch(/^\d+R$/);
    expect(jump).not.toBe(web);
    const listed = listLinks(doc, 0);
    expect(listed.map((l) => l.id)).toEqual([web, jump]);
    expect(listed[0]).toMatchObject({ url: 'https://example.com/', rect: [20, 200, 120, 220] });
    expect(listed[1].url).toBeNull();
    const bytes = await doc.save();
    const { pdf, list, destroy } = await annotations(bytes);
    try {
      expect(list).toHaveLength(2);
      expect(list.map((a) => a.id)).toEqual([web, jump]);
      expect(list[0].url).toBe('https://example.com/');
      expect(list[0].rect).toEqual([20, 200, 120, 220]);
      expect(await pdf.getPageIndex(list[1].dest[0])).toBe(1);
    } finally {
      await destroy();
    }
    const reopened = await PDFDocument.load(bytes);
    expect(removeLink(reopened, 0, web)).toBe(true);
    expect(removeLink(reopened, 0, web)).toBe(false);
    expect(listLinks(reopened, 0).map((l) => l.id)).toEqual([jump]);
    expect(listLinks(reopened, 1)).toEqual([]);
    expect(removeLink(reopened, 1, jump)).toBe(false);
  });
  it('escapes parentheses and backslashes so an address cannot break out of its string', async () => {
    const addresses = [
      'https://example.com/a)b',
      'https://example.com/?q=a\\b',
      'mailto:me@example.com?subject=hi)',
      'tel:555)123',
      // A payload shaped to end the URI early and add a JavaScript action in its place.
      'https://example.com/)/S/JavaScript/JS(app.alert\\(1\\))/URI(',
    ];
    for (const address of addresses) {
      const doc = await PDFDocument.create();
      doc.addPage([200, 200]);
      const expected = normalizeUrl(address);
      addLink(doc, 0, { rect: { x: 10, y: 10, width: 50, height: 20 }, url: address });
      const bytes = await doc.save({ useObjectStreams: false });
      const reopened = await PDFDocument.load(bytes);
      const [link] = listLinks(reopened, 0);
      expect(link.url, address).toBe(expected);
      const action = reopened.context
        .lookup(reopened.getPage(0).node.Annots().get(0))
        .lookup(PDFName.of('A'));
      expect(action.get(PDFName.of('S')), address).toBe(PDFName.of('URI'));
      expect(action.has(PDFName.of('JS')), address).toBe(false);
      expect(action.lookup(PDFName.of('URI'))).toBeInstanceOf(PDFString);
      const { list, destroy } = await annotations(bytes);
      try {
        expect(list, address).toHaveLength(1);
        expect(list[0].url ?? list[0].unsafeUrl, address).toBe(expected);
      } finally {
        await destroy();
      }
    }
  });
  it('lists nothing and can still add a link on a page whose Annots is not an array', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([300, 300]).node.set(PDFName.of('Annots'), PDFNumber.of(5));
    expect(listLinks(doc, 0)).toEqual([]);
    expect(removeLink(doc, 0, '1R')).toBe(false);
    const id = addLink(doc, 0, {
      rect: { x: 10, y: 10, width: 50, height: 50 },
      url: 'example.com',
    });
    expect(listLinks(doc, 0).map((link) => link.id)).toEqual([id]);
    const seen = await annotations(await doc.save());
    expect(seen.list.map((a) => a.subtype)).toEqual(['Link']);
    await seen.destroy();
  });
  it('leaves other annotations alone and validates its inputs', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([300, 300]);
    const note = doc.context.register(
      doc.context.obj({ Type: 'Annot', Subtype: 'Text', Rect: [10, 10, 30, 30], Contents: 'hi' }),
    );
    page.node.addAnnot(note);
    const id = addLink(doc, 0, { rect: { x: 0, y: 0, width: 50, height: 50 }, url: 'a.b' });
    expect(removeLink(doc, 0, annotationId(note))).toBe(false);
    expect(removeLink(doc, 0, id)).toBe(true);
    expect(page.node.Annots().size()).toBe(1);
    expect(doc.context.lookup(page.node.Annots().get(0)).get(PDFName.of('Subtype'))).toBe(
      PDFName.of('Text'),
    );
    expect(() =>
      addLink(doc, 0, { rect: { x: 0, y: 0, width: 0, height: 5 }, url: 'a.b' }),
    ).toThrow('area');
    expect(() => addLink(doc, 0, { rect: { x: 0, y: 0, width: 5, height: 5 }, page: 3 })).toThrow(
      'between 1 and 1',
    );
    expect(() =>
      addLink(doc, 0, { rect: { x: 0, y: 0, width: 5, height: 5 }, url: 'bad' }),
    ).toThrow('valid web address');
  });
});

it.each([64, 128, 64 | 128, 128 | 512])(
  'link flags %i reject destination changes and deletion',
  async (flags) => {
    const doc = await PDFDocument.create();
    doc.addPage([300, 300]);
    doc.addPage([300, 300]);
    const id = addLink(doc, 0, {
      rect: { x: 10, y: 10, width: 100, height: 20 },
      url: 'example.com/original',
    });
    const dict = doc.context.lookup(doc.getPage(0).node.Annots().get(0));
    dict.set(PDFName.of('F'), PDFNumber.of(4 | flags));
    const before = await doc.save();
    expect(() => updateLink(doc, 0, id, { url: 'example.com/changed' })).toThrow('locked');
    expect(() => updateLink(doc, 0, id, { page: 1 })).toThrow('locked');
    expect(() => removeLink(doc, 0, id)).toThrow('locked');
    expect(await doc.save()).toEqual(before);
  },
);

it('content-locked links still permit destination edits and deletion', async () => {
  const doc = await PDFDocument.create();
  doc.addPage([300, 300]);
  const id = addLink(doc, 0, {
    rect: { x: 10, y: 10, width: 100, height: 20 },
    url: 'example.com/original',
  });
  const dict = doc.context.lookup(doc.getPage(0).node.Annots().get(0));
  dict.set(PDFName.of('F'), PDFNumber.of(4 | 512));
  const contents = PDFString.of('Locked description');
  dict.set(PDFName.of('Contents'), contents);
  expect(updateLink(doc, 0, id, { url: 'example.com/changed' })).toBe(true);
  expect(listLinks(doc, 0)[0].url).toBe('https://example.com/changed');
  expect(dict.get(PDFName.of('Contents'))).toBe(contents);
  expect(removeLink(doc, 0, id)).toBe(true);
});

it('edits and removes imported links whose subtype is an indirect name', async () => {
  const doc = await PDFDocument.create();
  doc.addPage([300, 300]);
  doc.addPage([300, 300]);
  const id = addLink(doc, 0, { rect: { x: 10, y: 20, width: 90, height: 30 }, url: 'example.com' });
  const ref = doc.getPage(0).node.Annots().get(0);
  const dict = doc.context.lookup(ref);
  const subtype = doc.context.register(PDFName.of('Link'));
  dict.set(PDFName.of('Subtype'), subtype);
  const before = await annotations(await doc.save());
  expect(before.list.map((a) => [a.id, a.url])).toEqual([[id, 'https://example.com/']]);
  await before.destroy();
  expect(listLinks(doc, 0)).toEqual([{ id, rect: [10, 20, 100, 50], url: 'https://example.com/' }]);
  expect(updateLink(doc, 0, id, { page: 1 })).toBe(true);
  expect(dict.get(PDFName.of('Subtype'))).toBe(subtype);
  const changed = await annotations(await doc.save());
  try {
    expect(await changed.pdf.getPageIndex(changed.list[0].dest[0])).toBe(1);
  } finally {
    await changed.destroy();
  }
  expect(updateLink(doc, 0, id, { url: 'example.org' })).toBe(true);
  expect(listLinks(doc, 0)[0].url).toBe('https://example.org/');
  const reopened = await PDFDocument.load(await doc.save());
  expect(removeLink(reopened, 0, id)).toBe(true);
  const removed = await annotations(await reopened.save());
  expect(removed.list).toEqual([]);
  await removed.destroy();
});

it.each([64, 128, 64 | 128, 128 | 512])(
  'indirect link subtypes retain locked flags %i',
  async (flags) => {
    const doc = await PDFDocument.create();
    doc.addPage([300, 300]);
    const id = addLink(doc, 0, {
      rect: { x: 10, y: 20, width: 90, height: 30 },
      url: 'example.com',
    });
    const dict = doc.context.lookup(doc.getPage(0).node.Annots().get(0));
    dict.set(PDFName.of('Subtype'), doc.context.register(PDFName.of('Link')));
    dict.set(PDFName.of('F'), doc.context.register(PDFNumber.of(flags)));
    const before = dict.toString();
    expect(() => updateLink(doc, 0, id, { url: 'example.org' })).toThrow('locked');
    expect(() => removeLink(doc, 0, id)).toThrow('locked');
    expect(dict.toString()).toBe(before);
  },
);
