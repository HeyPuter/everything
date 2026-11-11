// A document holds up to MAX_LAYERS layers wherever layers come from (Photoshop
// allows 8000). Moving and grouping used to refuse anything past 200 layers
// although New Layer, Paste and opening animations as layers made more.
import { describe, expect, it } from 'vitest';
import { layer, MAX_LAYERS, newDocument, type PhotoDocument } from '../src/model/document';
import { groupLayers, moveLayers } from '../src/model/layers';
import { validateDocument } from '../src/model/serialization';

function docWith(n: number): PhotoDocument {
  const doc = newDocument(16, 16, 'Many');
  doc.layers = Array.from({ length: n }, (_, i) => layer('solid', `Layer ${i}`, 16, 16));
  return doc;
}

describe('layer count limit', () => {
  it('is the same as Photoshop’s', () => expect(MAX_LAYERS).toBe(8000));

  it('moves and groups layers in a document with more than 200 layers', () => {
    const doc = docWith(450);
    const [a, b] = [doc.layers[3].id, doc.layers[4].id];
    moveLayers(doc, new Set([a]), doc.layers[400].id, 'above');
    expect(doc.layers[400].id).toBe(a);
    const g = groupLayers(doc, new Set([b]));
    expect(doc.layers.some((l) => l.id === g)).toBe(true);
    expect(() => validateDocument(structuredClone(doc))).not.toThrow();
  });

  it('refuses grouping past the limit, and projects within it reopen', () => {
    const full = docWith(MAX_LAYERS);
    expect(() => groupLayers(full, new Set([full.layers[1].id]))).toThrow(/up to 8000 layers/);
    // (Edits run on a draft that is dropped when they throw.)
    const doc = docWith(MAX_LAYERS);
    expect(() => moveLayers(doc, new Set([doc.layers[1].id]), null, 'above')).not.toThrow();
    expect(() => validateDocument(structuredClone(doc))).not.toThrow();
  });
});
