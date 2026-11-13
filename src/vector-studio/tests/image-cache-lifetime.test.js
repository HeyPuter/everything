import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';
import { imageFor } from '../src/render/draw.js';

it('releases unused decoded images while retaining cache hits for live assets', () => {
  // An isolated Node process exposes GC without changing the test runner's heap.
  // WeakRefs are checked only after advancing tasks and collecting, so the
  // observer itself does not keep the objects alive during collection.
  const moduleURL = pathToFileURL(resolve(import.meta.dirname, '../src/render/draw.js')).href;
  const result = execFileSync(process.execPath, ['--expose-gc', '--input-type=module', '-e', `
    import { imageFor } from ${JSON.stringify(moduleURL)};
    let decodes = 0;
    globalThis.Image = class {
      set src(value) { decodes++; this.onload(); }
    };
    const released = (() => {
      const asset = { data: 'data:image/png;base64,AAAA' };
      const doc = { assets: new Map([['photo', asset]]) };
      const image = imageFor(doc, 'photo');
      return { asset: new WeakRef(asset), image: new WeakRef(image), assets: new WeakRef(doc.assets) };
    })();
    const live = { assets: new Map([['photo', { data: 'data:image/png;base64,BBBB' }]]) };
    const cached = imageFor(live, 'photo');
    for (let i = 0; i < 5; i++) {
      await new Promise(setImmediate);
      globalThis.gc();
    }
    console.log(JSON.stringify({
      released: Object.values(released).every((ref) => ref.deref() === undefined),
      cacheHit: imageFor(live, 'photo') === cached,
      decodes,
    }));
  `], { encoding: 'utf8', timeout: 10000 });
  expect(JSON.parse(result)).toEqual({ released: true, cacheHit: true, decodes: 2 });
});

it('keeps malformed image asset records from crashing rendering', () => {
  for (const asset of [null, undefined, 'invalid', 42, false]) {
    expect(imageFor({ assets: new Map([['photo', asset]]) }, 'photo')).toBeNull();
  }
});
