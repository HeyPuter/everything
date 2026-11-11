import { describe, expect, it } from 'vitest';
import type { Editor } from '../src/editor';
import { newDocument, type PhotoDocument } from '../src/model/document';
import { convertToMode } from '../src/features/color/modes';

// A stand-in editor whose current document can be switched while a
// conversion waits (as clicking another document tab does).
function mockEditor(doc: PhotoDocument) {
  const e = {
    doc,
    hasDocument: true,
    messages: [] as string[],
    commands: [] as { label: string; doc: PhotoDocument }[],
    assets: { raster: () => undefined, tiles: undefined },
    message(text: string) {
      e.messages.push(text);
    },
    command(label: string, edit: (d: PhotoDocument) => void) {
      const d = structuredClone(e.doc);
      edit(d);
      e.commands.push({ label, doc: e.doc });
      e.doc = d;
    },
  };
  return e;
}

describe('mode conversions', { timeout: 120000 }, () => {
  it('do not land in another document chosen while the CMYK profile is prepared', async () => {
    const a = newDocument(8, 8, 'a');
    const b = newDocument(8, 8, 'b');
    a.layers = [];
    b.layers = [];
    const e = mockEditor(a);
    const running = convertToMode(e as unknown as Editor, 'cmyk');
    // The user switches to document b before the profile is ready.
    e.doc = b;
    await expect(running).rejects.toThrow(/nothing was converted/);
    expect(e.commands).toEqual([]);
    expect(e.doc).toBe(b);
    expect(b.mode).toBeUndefined();
    // Without a switch the conversion is one step in its own document.
    const f = mockEditor(a);
    await convertToMode(f as unknown as Editor, 'cmyk');
    expect(f.commands.map((c) => [c.label, c.doc])).toEqual([['Convert to CMYK Color', a]]);
    expect(f.doc.mode).toBe('cmyk');
  });
});
