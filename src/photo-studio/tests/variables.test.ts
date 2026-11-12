import { describe, expect, it } from 'vitest';
import { detectDelimiter, formatDelimited, parseDelimited } from '../src/model/delimited';
import {
  captureDataSet, dataSetsFromText, outputName, parseVisibility, pixelPlacement, setChanges, validateVariables, validVariableName, variablesOf,
  type DocumentVariables,
} from '../src/model/variables';
import { layer, type PhotoDocument } from '../src/model/document';

describe('delimited text', () => {
  it('parses quotes, embedded delimiters and line breaks', () => {
    const t = 'name,quote,n\r\n"Smith, Jo","She said ""hi""\nthen left",3\nplain,,"x"\n';
    expect(parseDelimited(t)).toEqual([
      ['name', 'quote', 'n'],
      ['Smith, Jo', 'She said "hi"\nthen left', '3'],
      ['plain', '', 'x'],
    ]);
  });
  it('handles a byte order mark, CR line ends, blank lines and no final newline', () => {
    expect(parseDelimited('﻿a,b\r\r1,2\r3,4')).toEqual([['a', 'b'], ['1', '2'], ['3', '4']]);
    expect(parseDelimited('a,b\n1,')).toEqual([['a', 'b'], ['1', '']]);
  });
  it('detects tabs and semicolons', () => {
    expect(detectDelimiter('a\tb,c\n1\t2')).toBe('\t');
    expect(detectDelimiter('a;b;c\n')).toBe(';');
    expect(detectDelimiter('"x;y",b\n')).toBe(',');
    expect(parseDelimited('a\tb\n"1\t2"\t3')).toEqual([['a', 'b'], ['1\t2', '3']]);
  });
  it('round-trips through formatting', () => {
    const rows = [['a', 'b, c'], ['line\nbreak', 'say "x"'], [' pad', '']];
    expect(parseDelimited(formatDelimited(rows))).toEqual(rows);
  });
});

function doc(): PhotoDocument {
  const title = layer('text', 'Title', 100, 20);
  title.id = 'title';
  title.text = 'Hello';
  const badge = layer('pixel', 'Badge', 10, 10);
  badge.id = 'badge';
  const photo = layer('pixel', 'Photo', 10, 10);
  photo.id = 'photo';
  const variables: DocumentVariables = {
    layers: {
      title: { text: 'headline', visibility: 'showTitle' },
      badge: { visibility: 'sale' },
      photo: { pixel: { name: 'image', method: 'fit', alignX: 0.5, alignY: 0.5, clip: true, bounds: { x: 10, y: 20, width: 200, height: 100 } } },
    },
    sets: [],
  };
  return { name: 'd', width: 400, height: 300, layers: [photo, badge, title], selection: null, variables } as unknown as PhotoDocument;
}

describe('variables and data sets', () => {
  it('lists variables and validates names', () => {
    expect(variablesOf(doc()).map((v) => `${v.name}:${v.kind}`)).toEqual(['image:pixel', 'sale:visibility', 'showTitle:visibility', 'headline:text']);
    expect(validVariableName('headline')).toBe(true);
    expect(validVariableName('_x.1-b')).toBe(true);
    expect(validVariableName('1abc')).toBe(false);
    expect(validVariableName('has space')).toBe(false);
  });
  it('imports sets from CSV with the first row naming variables', () => {
    const d = doc();
    const csv = 'headline,sale,image\n"Big, bold",yes,cat.jpg\nQuiet,false,dog.png\n';
    const { sets, errors } = dataSetsFromText(csv, variablesOf(d));
    expect(errors).toEqual([]);
    expect(sets).toEqual([
      { name: 'Data Set 1', values: { headline: 'Big, bold', sale: true, image: 'cat.jpg' } },
      { name: 'Data Set 2', values: { headline: 'Quiet', sale: false, image: 'dog.png' } },
    ]);
    expect(dataSetsFromText('headline,missing\na,b', variablesOf(d)).errors[0]).toMatch(/missing/);
    expect(dataSetsFromText('sale\nmaybe', variablesOf(d)).errors[0]).toMatch(/visibility/);
    expect(parseVisibility(' Hidden ')).toBe(false);
  });
  it('turns a set into layer changes', () => {
    const d = doc();
    const c = setChanges(d, { name: 's', values: { headline: 'New', sale: false, showTitle: true, image: ' cat.jpg ' } });
    expect(c.text.get('title')).toBe('New');
    expect(c.visible.get('badge')).toBe(false);
    expect(c.visible.get('title')).toBe(true);
    expect(c.pixel.get('photo')!.file).toBe('cat.jpg');
    // Missing values leave layers alone; an empty image keeps the pixels.
    const none = setChanges(d, { name: 's', values: { image: '' } });
    expect(none.text.size + none.visible.size + none.pixel.size).toBe(0);
  });
  it('captures the current state as a set', () => {
    const s = captureDataSet(doc(), 'Now');
    expect(s.values).toEqual({ image: '', sale: true, showTitle: true, headline: 'Hello' });
  });
  it('places replacement images by method and alignment', () => {
    const b = { x: 10, y: 20, width: 200, height: 100 };
    expect(pixelPlacement({ method: 'fit', alignX: 0.5, alignY: 0.5, bounds: b }, 50, 50)).toEqual({ x: 60, y: 20, width: 100, height: 100 });
    expect(pixelPlacement({ method: 'fill', alignX: 0, alignY: 0, bounds: b }, 50, 50)).toEqual({ x: 10, y: 20, width: 200, height: 200 });
    expect(pixelPlacement({ method: 'fill', alignX: 0.5, alignY: 1, bounds: b }, 50, 50)).toEqual({ x: 10, y: -80, width: 200, height: 200 });
    expect(pixelPlacement({ method: 'as-is', alignX: 1, alignY: 0, bounds: b }, 50, 30)).toEqual({ x: 160, y: 20, width: 50, height: 30 });
    expect(pixelPlacement({ method: 'conform', alignX: 0, alignY: 0, bounds: b }, 5, 7)).toEqual(b);
  });
  it('names output files', () => {
    const set = { name: 'Spring / Sale', values: { headline: 'Hi', image: 'photos/cat.jpg', sale: true } };
    expect(outputName(set, 0, 'number')).toBe('001');
    expect(outputName(set, 4, 'name', 'card-')).toBe('card-Spring _ Sale');
    expect(outputName(set, 0, 'image')).toBe('cat');
    expect(outputName(set, 2, 'missing')).toBe('003');
  });
  it('validates stored definitions and sets', () => {
    const v = doc().variables!;
    expect(() => validateVariables(v)).not.toThrow();
    expect(() => validateVariables({ ...v, sets: [{ name: 'a', values: { x: 3 } }] })).toThrow();
    expect(() => validateVariables({ layers: { a: { text: 'dup' }, b: { visibility: 'dup' } }, sets: [] })).toThrow();
    expect(() => validateVariables({ ...v, current: 2 })).toThrow();
  });
});

describe('applying a data set', () => {
  it('applies to the document as it is when the set is ready, even if it changed meanwhile', async () => {
    const { applySet } = await import('../src/features/variables/apply');
    const { History } = await import('../src/history/history');
    const start = doc();
    start.variables!.sets = [{ name: 'Off', values: { sale: false } }];
    const h = new History(start);
    const messages: string[] = [];
    let preparing = 0;
    const e = {
      get doc() {
        return h.document;
      },
      // Read when preparing starts: another change lands meanwhile (a person
      // editing a shared document, for example).
      get assets() {
        if (++preparing === 1) h.execute('Rename', (d) => void (d.layers[0].name = 'Renamed meanwhile'));
        return undefined;
      },
      command: (label: string, f: (d: PhotoDocument) => void) => h.execute(label, f),
      message: (t: string) => messages.push(t),
    };
    await applySet(e as never, 0);
    const out = h.document;
    expect(out.layers.find((l) => l.id === 'badge')!.visible).toBe(false);
    expect(out.layers[0].name).toBe('Renamed meanwhile');
    expect(h.labels.at(-1)).toBe('Apply Data Set');
  });
});
