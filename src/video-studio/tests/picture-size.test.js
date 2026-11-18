import { it, expect } from 'vitest';
import { normalizeAsset, normalizeProject } from '../src/model/project.js';
import { pictureSizeFor } from '../src/model/picture-size.js';
import { fixture, clip, onMain } from './helpers.js';
import { evaluate } from '../src/engine/scene.js';

it('prefers clip framing over media defaults without changing the shared media', () => {
  const p = fixture();
  p.assets.img.pictureSize = { width: 72, height: 40.5 };
  const [c] = onMain(p, clip('image', 0, 4, { pictureSize: { width: 80, height: 60 } }));
  expect(evaluate(p, 0)[0]).toMatchObject({ width: 80, height: 60 });
  delete c.pictureSize;
  expect(evaluate(normalizeProject(p), 0)[0]).toMatchObject({ width: 72, height: 40.5 });
  expect(pictureSizeFor(c, p.assets.img)).toEqual(p.assets.img.pictureSize);
  expect(p.assets.img).toMatchObject({ width: 800, height: 600, pictureSize: { width: 72, height: 40.5 } });
});

it('normalizes valid picture defaults only for images and rejects malformed dimensions', () => {
  const pictureSize = { width: 72, height: 40.5 };
  expect(normalizeAsset({ kind: 'image', pictureSize }).pictureSize).toEqual(pictureSize);
  for (const kind of ['audio', 'video']) expect(normalizeAsset({ kind, pictureSize }).pictureSize).toBeUndefined();
  for (const value of [null, {}, { width: 0, height: 1 }, { width: 1, height: -1 }, { width: Infinity, height: 1 }, { width: 1, height: NaN }]) expect(normalizeAsset({ kind: 'image', pictureSize: value }).pictureSize).toBeUndefined();
});
