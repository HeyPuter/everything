import { describe, it, expect, vi } from 'vitest';
import { PDFDocument, PDFName, PDFRawStream, PDFString, StandardFonts } from 'pdf-lib';
import { parsePageRange, formatPageRange, extractPages } from '../src/core/pages.js';
import { addLink, listLinks } from '../src/core/links.js';
import { duplicatePage } from '../src/core/document.js';
import { PDFNumber } from 'pdf-lib';

describe('page ranges', () => {
  it('parses lists, ranges, descending ranges and loose spacing', () => {
    expect(parsePageRange('1-3, 5', 10)).toEqual([0, 1, 2, 4]);
    expect(parsePageRange(' 4 – 2 ;7', 10)).toEqual([3, 2, 1, 6]);
    expect(parsePageRange('10', 10)).toEqual([9]);
    expect(parsePageRange('2,2', 3)).toEqual([1, 1]);
  });
  it('rejects empty, malformed and out-of-range input with a usable message', () => {
    expect(() => parsePageRange('', 3)).toThrow('like 1-3, 5');
    expect(() => parsePageRange('a-b', 3)).toThrow('like 1-3, 5');
    expect(() => parsePageRange('1-', 3)).toThrow('like 1-3, 5');
    expect(() => parsePageRange('0', 3)).toThrow('between 1 and 3');
    expect(() => parsePageRange('2-4', 3)).toThrow('between 1 and 3');
  });
  it('formats indices back into compact ranges', () => {
    expect(formatPageRange([0, 1, 2, 4])).toBe('1-3, 5');
    expect(formatPageRange([3, 2, 1])).toBe('4, 3, 2');
    expect(formatPageRange([6])).toBe('7');
  });
});

describe('page extraction', () => {
  async function sample() {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    for (let i = 0; i < 4; i++) {
      const page = doc.addPage([300 + i * 10, 400]);
      page.drawText(`Page ${i + 1}`, { x: 20, y: 300, size: 20, font });
    }
    doc.getForm().createTextField('Name').addToPage(doc.getPage(1), { x: 20, y: 100 });
    doc.getForm().getTextField('Name').setText('Ada');
    // A large stream that only page 4 uses must not travel with the other pages.
    const heavy = doc.context.register(doc.context.stream(new Uint8Array(400000)));
    doc.getPage(3).node.set(PDFName.of('Heavy'), heavy);
    doc.setTitle('Sample title');
    return doc.save();
  }
  it('copies the chosen pages in order, keeps the title and flattens the form', async () => {
    const bytes = await sample();
    const out = await PDFDocument.load(await extractPages(bytes, [2, 1]));
    expect(out.getPageCount()).toBe(2);
    expect(out.getPage(0).getWidth()).toBe(320);
    expect(out.getPage(1).getWidth()).toBe(310);
    expect(out.getTitle()).toBe('Sample title');
    expect(out.getForm().getFields()).toEqual([]);
    // The flattened field keeps its appearance on the page.
    expect(out.getPage(1).node.Resources()?.lookup(PDFName.of('XObject'))).toBeDefined();
  });
  it('leaves behind what the other pages carried', async () => {
    const bytes = await sample();
    const one = await extractPages(bytes, [0]);
    expect(one.length).toBeLessThan(bytes.length / 4);
    expect((await PDFDocument.load(one)).getPageCount()).toBe(1);
  });
  it('keeps keywords and lets odd metadata through without stopping', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([200, 200]);
    doc.addPage([200, 200]);
    doc.setKeywords(['invoice', 'q3']);
    doc.setAuthor('Ada');
    doc.getInfoDict().set(PDFName.of('Title'), PDFNumber.of(42));
    const out = await PDFDocument.load(await extractPages(await doc.save(), [1]));
    expect(out.getPageCount()).toBe(1);
    expect(out.getKeywords()).toBe('invoice q3');
    expect(out.getAuthor()).toBe('Ada');
    expect(out.getTitle()).toBeUndefined();
  });
  it('rejects extraction that would orphan a field without an appearance', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);
    doc
      .getForm()
      .createTextField('name')
      .addToPage(page, { x: 50, y: 700, width: 200, height: 24 });
    const signature = doc.context.register(
      doc.context.obj({
        FT: 'Sig',
        T: 'Signature1',
        Type: 'Annot',
        Subtype: 'Widget',
        Rect: [50, 600, 250, 650],
        F: 4,
        P: page.ref,
      }),
    );
    doc.catalog.getOrCreateAcroForm().Fields().push(signature);
    page.node.addAnnot(signature);
    doc.addPage([200, 200]);
    const bytes = await doc.save();
    await expect(extractPages(bytes, [0])).rejects.toThrow('could not be flattened safely');
    const out = await PDFDocument.load(await extractPages(bytes, [1]));
    expect(out.getPageCount()).toBe(1);
    expect(out.getPage(0).getWidth()).toBe(200);
    expect((await PDFDocument.load(bytes)).getPage(0).node.Annots().size()).toBe(2);
  });
  it('rejects empty and out-of-range selections', async () => {
    const bytes = await sample();
    await expect(extractPages(bytes, [])).rejects.toThrow('at least one page');
    await expect(extractPages(bytes, [4])).rejects.toThrow('between 1 and 4');
  });
  it('remaps internal links to extracted pages, drops the rest, and leaves no hidden page copies', async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    for (let i = 0; i < 3; i++)
      doc.addPage([400, 400]).drawText(`Page ${i + 1}`, { x: 40, y: 300, size: 16, font });
    // A big picture on page 3 so a hidden copy of it would show up in the size.
    const bytes4 = new Uint8Array(4096 * 4).map((_, i) => (i % 4 === 3 ? 255 : (i * 37) % 256));
    const image = doc.context.flateStream(bytes4, {
      Type: 'XObject',
      Subtype: 'Image',
      Width: 64,
      Height: 64,
      ColorSpace: 'DeviceRGB',
      BitsPerComponent: 8,
    });
    const imageRef = doc.context.register(image);
    doc
      .getPage(2)
      .node.set(PDFName.of('Resources'), doc.context.obj({ XObject: { Im: imageRef } }));
    doc
      .getPage(2)
      .node.set(
        PDFName.of('Contents'),
        doc.context.register(doc.context.flateStream('q 300 0 0 300 50 50 cm /Im Do Q')),
      );
    addLink(doc, 0, { rect: { x: 20, y: 360, width: 60, height: 16 }, page: 2 }); // page 1 -> 3
    addLink(doc, 0, { rect: { x: 20, y: 330, width: 60, height: 16 }, url: 'example.com' });
    addLink(doc, 2, { rect: { x: 20, y: 360, width: 60, height: 16 }, page: 0 }); // page 3 -> 1
    const source = await doc.save();
    const countPageDicts = async (out) => {
      const reopened = await PDFDocument.load(out);
      let dicts = 0;
      for (const [, obj] of reopened.context.enumerateIndirectObjects())
        if (obj.get?.(PDFName.of('Type')) === PDFName.of('Page')) dicts++;
      return { reopened, dicts };
    };
    // Both ends travel: the link is remapped to the new index, no page copy is dragged in.
    const both = await extractPages(source, [0, 2]);
    const bothInfo = await countPageDicts(both);
    expect(bothInfo.dicts).toBe(2); // no orphan page copies
    expect(listLinks(bothInfo.reopened, 0).map((l) => l.url)).toEqual([
      null,
      'https://example.com/',
    ]);
    // The page-1 link now points at extracted page index 1; the URL link is intact.
    const dest0 = bothInfo.reopened
      .getPage(0)
      .node.lookup(PDFName.of('Annots'))
      .asArray()
      .map((r) => bothInfo.reopened.context.lookup(r))
      .find((a) => a.has(PDFName.of('Dest')));
    expect(bothInfo.reopened.context.lookup(dest0.get(PDFName.of('Dest'))).get(0)).toBe(
      bothInfo.reopened.getPage(1).ref,
    );
    // Page 1 alone: its link to page 3 has no target, so the jump is dropped and the big
    // picture does not travel; the URL link stays.
    const alone = await extractPages(source, [0]);
    expect((await countPageDicts(alone)).dicts).toBe(1);
    expect(alone.length).toBeLessThan(source.length / 2);
    const aloneDoc = await PDFDocument.load(alone);
    const links = listLinks(aloneDoc, 0);
    // The page link box stays but its destination is gone; the URL link is unchanged.
    expect(links.map((l) => l.url)).toEqual([null, 'https://example.com/']);
    const pageLink = aloneDoc
      .getPage(0)
      .node.lookup(PDFName.of('Annots'))
      .asArray()
      .map((r) => aloneDoc.context.lookup(r))
      .find((a) => a.get(PDFName.of('Subtype')) === PDFName.of('Link') && !a.has(PDFName.of('A')));
    expect(pageLink.has(PDFName.of('Dest'))).toBe(false);
  });
  it('copies the chosen pages without copying the pages their links lead to', async () => {
    // A contents page links to every page, and every page back to it; copying a linked page
    // once meant copying the whole document's content, only to throw it away again.
    const doc = await PDFDocument.create();
    for (let i = 0; i < 6; i++) {
      const page = doc.addPage([300, 300]);
      const content = doc.context.flateStream(`0 0 ${10 + i} 10 re f`, { PuterTestPage: i });
      page.node.set(PDFName.of('Contents'), doc.context.register(content));
    }
    for (let i = 1; i < 6; i++) {
      addLink(doc, 0, { rect: { x: 10, y: 20 * i, width: 40, height: 10 }, page: i });
      addLink(doc, i, { rect: { x: 10, y: 10, width: 40, height: 10 }, page: 0 });
    }
    const source = await doc.save();
    const copied = new Set();
    const clone = PDFRawStream.prototype.clone;
    const spy = vi.spyOn(PDFRawStream.prototype, 'clone').mockImplementation(function (context) {
      const page = this.dict.lookup(PDFName.of('PuterTestPage'));
      if (page) copied.add(page.asNumber());
      return clone.call(this, context);
    });
    try {
      const extracted = await PDFDocument.load(await extractPages(source, [0, 3]));
      expect([...copied].sort()).toEqual([0, 3]);
      const targets = (pdf, index) =>
        pdf
          .getPage(index)
          .node.Annots()
          .asArray()
          .map((ref) => {
            const link = pdf.context.lookup(ref);
            const dest =
              link.lookup(PDFName.of('Dest')) ??
              link.lookup(PDFName.of('A'))?.lookup(PDFName.of('D'));
            const at = pdf.getPages().findIndex((page) => page.ref === dest?.get(0));
            return at < 0 ? null : at;
          });
      expect(targets(extracted, 0)).toEqual([null, null, 1, null, null]);
      expect(targets(extracted, 1)).toEqual([0]);
      copied.clear();
      const reopened = await PDFDocument.load(source);
      await duplicatePage(reopened, 0);
      expect([...copied]).toEqual([0]);
      expect(targets(reopened, 1)).toEqual([2, 3, 4, 5, 6]);
    } finally {
      spy.mockRestore();
    }
  });
  it('leaves article threads behind with the pages they run on to', async () => {
    const doc = await PDFDocument.create();
    const ctx = doc.context;
    const pages = [0, 1, 2].map((i) => {
      const page = doc.addPage([200, 200]);
      page.node.set(PDFName.of('Contents'), ctx.register(ctx.stream(`0 0 ${10 + i} 10 re f`)));
      return page;
    });
    const thread = ctx.obj({ Type: 'Thread' });
    const threadRef = ctx.register(thread);
    const beads = pages.map((page) =>
      ctx.obj({ Type: 'Bead', T: threadRef, P: page.ref, R: [0, 0, 100, 100] }),
    );
    const refs = beads.map((bead) => ctx.register(bead));
    beads.forEach((bead, i) => {
      bead.set(PDFName.of('N'), refs[(i + 1) % 3]);
      bead.set(PDFName.of('V'), refs[(i + 2) % 3]);
      pages[i].node.set(PDFName.of('B'), ctx.obj([refs[i]]));
    });
    thread.set(PDFName.of('F'), refs[0]);
    doc.catalog.set(PDFName.of('Threads'), ctx.obj([threadRef]));
    const source = await doc.save();
    const extracted = await PDFDocument.load(await extractPages(source, [1]));
    const objects = [...extracted.context.enumerateIndirectObjects()].map(([, object]) =>
      String(object),
    );
    expect(objects.filter((text) => /Bead|Thread|PuterCopyPageIndex/.test(text))).toEqual([]);
    expect(extracted.getPage(0).node.has(PDFName.of('B'))).toBe(false);
    const reopened = await PDFDocument.load(source);
    await duplicatePage(reopened, 0);
    expect(reopened.getPage(1).node.has(PDFName.of('B'))).toBe(false);
    expect(reopened.getPage(0).node.has(PDFName.of('B'))).toBe(true);
  });
});

describe('document settings of extracted pages', () => {
  it('keep the language, the title in the window, and the reading direction', async () => {
    const doc = await PDFDocument.create();
    for (let i = 0; i < 3; i++) doc.addPage([200, 200]);
    doc.setTitle('Annual report');
    doc.catalog.set(PDFName.of('Lang'), PDFString.of('ar-EG'));
    doc.catalog.set(
      PDFName.of('ViewerPreferences'),
      doc.context.obj({ DisplayDocTitle: true, Direction: 'R2L', PrintPageRange: [0, 2] }),
    );
    const extracted = await PDFDocument.load(await extractPages(await doc.save(), [1, 2]));
    expect(extracted.catalog.lookup(PDFName.of('Lang')).decodeText()).toBe('ar-EG');
    const preferences = extracted.catalog.lookup(PDFName.of('ViewerPreferences'));
    expect(String(preferences.get(PDFName.of('DisplayDocTitle')))).toBe('true');
    expect(preferences.get(PDFName.of('Direction'))).toBe(PDFName.of('R2L'));
    // Page numbers of the source mean other pages here.
    expect(preferences.has(PDFName.of('PrintPageRange'))).toBe(false);
    const plain = await PDFDocument.create();
    plain.addPage();
    const copy = await PDFDocument.load(await extractPages(await plain.save(), [0]));
    expect(copy.catalog.has(PDFName.of('Lang'))).toBe(false);
    expect(copy.catalog.has(PDFName.of('ViewerPreferences'))).toBe(false);
  });
});
