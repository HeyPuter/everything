// Document identifiers end up in panel markup, so projects and shared
// documents are only accepted when every identifier has the editor's shape.
import { describe, expect, it } from 'vitest';
import { layer, newDocument, type PhotoDocument } from '../src/model/document';
import { newPixelLayer } from '../src/model/pixel-layer';
import { Assets } from '../src/model/assets';
import { deserialize, serialize, validateDocument } from '../src/model/serialization';
import { isDocumentId } from '../src/model/ids';
import { defaultTrackId } from '../src/model/audio-timeline';

const evil = 'x" onfocus="alert(1)" autofocus data-x="<img src=x onerror=alert(2)>';

function base() {
  const doc = newDocument(64, 64, 'Ids');
  doc.layers = [newPixelLayer('Background', doc), layer('solid', 'Fill', 64, 64)];
  return doc;
}
const withChange = (fn: (d: PhotoDocument & Record<string, unknown>) => void) => {
  const d = structuredClone(base()) as PhotoDocument & Record<string, unknown>;
  fn(d);
  return d;
};

describe('document identifiers', () => {
  it('accepts every format the editor makes', () => {
    for (const id of [crypto.randomUUID(), defaultTrackId, `user-${crypto.randomUUID()}`, `library-${'a1'.repeat(12)}`]) expect(isDocumentId(id)).toBe(true);
    for (const id of ['', evil, 'a b', 'a|b', '<x>', "it's", 'x'.repeat(129)]) expect(isDocumentId(id)).toBe(false);
  });

  it('refuses a document whose identifiers could carry markup', () => {
    const cases: [string, (d: PhotoDocument & Record<string, unknown>, id: string) => void][] = [
      ['layer', (d, id) => (d.layers[0].id = id)],
      ['nested layer', (d, id) => (d.layers = [{ ...layer('group', 'G', 64, 64), children: [{ ...d.layers[1], id }] }])],
      ['link group', (d, id) => (d.layers[0].linkGroup = id)],
      ['channel', (d, id) => (d.channels = [{ id, name: 'Alpha 1', grid: d.layers[0].pixels! } as never])],
      ['layer comp', (d, id) => (d.layerComps = [{ id, name: 'Comp', capture: { visibility: true, position: false, appearance: false }, layers: {} }])],
      ['slice', (d, id) => (d.slices = [{ id, rect: { x: 0, y: 0, width: 4, height: 4 } }] as never)],
      ['audio track', (d, id) => (d.timeline = { fps: 30, duration: 10, current: 0, clips: {}, audio: [{ id, name: 'Audio 1', clips: [] }] } as never)],
      ['count group', (d, id) => (d.annotations = { counts: [{ id, name: 'Count', color: '#ff0000', markerSize: 8, labelSize: 12, visible: true, points: [] }] } as never)],
    ];
    for (const [what, fn] of cases) {
      expect(() => validateDocument(withChange((d) => fn(d, crypto.randomUUID()))), what).not.toThrow();
      expect(() => validateDocument(withChange((d) => fn(d, evil))), what).toThrow();
    }
  });

  it('refuses such a .photo project cleanly, and opens a well-formed one', async () => {
    const assets = new Assets();
    const doc = base();
    const good = await deserialize(await serialize(doc, assets));
    expect(good.document.layers.map((l) => l.id)).toEqual(doc.layers.map((l) => l.id));
    const bad = withChange((d) => (d.layers[1].id = evil));
    await expect(deserialize(await serialize(bad, assets))).rejects.toThrow(/Invalid layer/);
  });
});
