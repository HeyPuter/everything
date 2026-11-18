// A generated layer saved with a prompt longer than the project limit still
// opens: the prompt (which only describes how the layer was made) is cut.
import { expect, it } from 'vitest';
import { Assets } from '../src/model/assets';
import { layer, newDocument } from '../src/model/document';
import { newPixelLayer } from '../src/model/pixel-layer';
import { deserialize, serialize } from '../src/model/serialization';

it('opens a project whose generated layers have prompts over 4000 characters', async () => {
  const assets = new Assets();
  const doc = newDocument(8, 8, 'Generated');
  const top = newPixelLayer('Generated', doc);
  top.generated = { kind: 'generate', prompt: `${'a'.repeat(3999)}bcd`, model: 'm' };
  const nested = newPixelLayer('Edited', doc);
  nested.generated = { kind: 'edit', prompt: 'e'.repeat(9000) };
  const g = layer('group', 'Group', 8, 8);
  g.children.push(nested);
  doc.layers.push(top, g);
  const loaded = await deserialize(await serialize(doc, assets));
  const [a, b] = [loaded.document.layers[0], loaded.document.layers[1].children[0]];
  expect(a.generated).toEqual({ kind: 'generate', prompt: `${'a'.repeat(3999)}b`, model: 'm' });
  expect(b.generated?.prompt).toBe('e'.repeat(4000));
  // Prompts within the limit are kept as they are.
  top.generated = { kind: 'generate', prompt: 'a kite' };
  expect(
    (await deserialize(await serialize(doc, assets))).document.layers[0].generated?.prompt,
  ).toBe('a kite');
});
