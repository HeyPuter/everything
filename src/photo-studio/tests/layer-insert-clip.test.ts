import { describe, expect, it } from 'vitest';
import { layer, newDocument, type PhotoDocument } from '../src/model/document';
import { insertAboveSelection } from '../src/features/layers/insert';
import { addAdjustmentLayer } from '../src/features/adjust/layers';
import { TileStore } from '../src/model/tiles';
import type { Editor } from '../src/editor';
import { insertLayer } from '../src/features/type/text-utils';
import { insertInstance } from '../src/features/embedded/contents';
import type { EmbeddedContents } from '../src/model/embedded';

function editor(doc: PhotoDocument, selected: string) {
  const e = {
    doc,
    selected,
    hasDocument: true,
    assets: { tiles: new TileStore() },
    command(_label: string, fn: (d: PhotoDocument) => void) {
      const d = structuredClone(e.doc);
      fn(d);
      e.doc = d;
    },
    update() {},
  };
  return e;
}
// Bottom to top: Background, Base, Clipped (clipped to Base), Top.
function clipFixture() {
  const doc = newDocument(40, 30);
  const bg = layer('solid', 'Background', 40, 30);
  const base = layer('solid', 'Base', 40, 30);
  const clipped = layer('solid', 'Clipped', 40, 30);
  clipped.clipped = true;
  const top = layer('solid', 'Top', 40, 30);
  doc.layers = [bg, base, clipped, top];
  return { doc, bg, base, clipped, top };
}

describe('inserting layers into a clipping group', () => {
  it('a new layer above the base of a clipping group joins the group', () => {
    const { doc, base } = clipFixture();
    const e = editor(doc, base.id);
    const l = layer('pixel', 'New', 40, 30);
    insertAboveSelection(e as unknown as Editor, l, 'New Layer');
    expect(e.doc.layers.map((x) => [x.name, !!x.clipped])).toEqual([
      ['Background', false],
      ['Base', false],
      ['New', true],
      ['Clipped', true],
      ['Top', false],
    ]);
  });
  it('a new layer above an unclipped layer outside a group stays unclipped', () => {
    const { doc, bg, top } = clipFixture();
    for (const anchor of [bg.id, top.id]) {
      const e = editor(doc, anchor);
      insertAboveSelection(e as unknown as Editor, layer('pixel', 'New', 40, 30), 'New Layer');
      expect(e.doc.layers.find((x) => x.name === 'New')!.clipped).toBeFalsy();
    }
  });
  it('a new adjustment layer above the base of a clipping group joins the group', () => {
    const { doc, base } = clipFixture();
    const e = editor(doc, base.id);
    addAdjustmentLayer(e as unknown as Editor, 'invert');
    expect(e.doc.layers.map((x) => [x.kind, !!x.clipped])).toEqual([
      ['solid', false],
      ['solid', false],
      ['adjustment', true],
      ['solid', true],
      ['solid', false],
    ]);
  });
  it('a new type layer above the base joins the group without changing the original document', () => {
    const { doc, base } = clipFixture();
    const out = insertLayer(doc, layer('text', 'Text', 1, 1), base.id);
    expect(out.layers.map((x) => [x.name, !!x.clipped])).toEqual([
      ['Background', false],
      ['Base', false],
      ['Text', true],
      ['Clipped', true],
      ['Top', false],
    ]);
    expect(doc.layers.length).toBe(4);
  });
  it('a placed embedded object above the base joins the group', () => {
    const { doc, base } = clipFixture();
    const e = editor(doc, base.id);
    const c = { id: crypto.randomUUID(), name: 'Placed', width: 10, height: 10, composite: 'asset' } as EmbeddedContents;
    const l = layer('image', 'Placed', 10, 10);
    insertInstance(e as unknown as Editor, l, c, 'Place Embedded');
    expect(e.doc.layers.map((x) => [x.name, !!x.clipped])).toEqual([
      ['Background', false],
      ['Base', false],
      ['Placed', true],
      ['Clipped', true],
      ['Top', false],
    ]);
  });
});
