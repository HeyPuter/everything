// An image layer with a very long name that becomes an embedded object (by a
// distort or warp, or by editing its contents) gives the contents a name a
// project can hold, so the project reopens.
import { expect, it } from 'vitest';
import { layer, newDocument } from '../src/model/document';
import { Assets } from '../src/model/assets';
import { validateEmbeds } from '../src/model/embedded';
import { ensureEmbed } from '../src/features/embedded/contents';

it('shortens the contents name taken from a long layer name', () => {
  const doc = newDocument(32, 32);
  const l = { ...layer('image', 'n'.repeat(600), 16, 16), asset: 'placed' };
  doc.layers.push(l);
  ensureEmbed(doc, l, new Assets());
  const c = doc.embeds![l.embed!.contents];
  expect(c.name).toBe('n'.repeat(512));
  expect(() => validateEmbeds(doc)).not.toThrow();
  // The layer keeps its own name.
  expect(l.name.length).toBe(600);
});
