// View layers, light groups and light / shadow linking read from a .blend file
// (tests/fixtures/blend/make_viewlayers.py).
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readBlend } from '../../src/io/blend/convert';
import type { DocumentData } from '../../src/data/types';
import { layerFlags, layerRender } from '../../src/scenes/viewlayers';
import { linkMembers } from '../../src/scenes/lightlinking';

let doc: DocumentData;
beforeAll(async () => {
  doc = (await readBlend(new Uint8Array(readFileSync(join(process.cwd(), 'tests/fixtures/blend/viewlayers_zstd.blend'))))).doc;
});
const ob = (n: string) => Object.values(doc.objects).find((o) => o.name === n)!;
const col = (n: string) => Object.values(doc.collections).find((c) => c.name === n)!;

describe('view layers from .blend files', () => {
  it('keeps every view layer with its flags', () => {
    expect(doc.scene.view_layers!.map((l) => l.name)).toEqual(['ViewLayer', 'Background']);
    expect(doc.scene.active_view_layer).toBe(0);
    expect(col('Props').holdout).toBe(true);
    expect(col('Props').exclude).toBe(false);
    expect(layerFlags(doc, doc.scene, 1, col('Props').id).exclude).toBe(true);
    expect(layerRender(doc.scene, 1).use_view_layer).toBe(false);
    expect(layerRender(doc.scene, 0).use_view_layer).toBe(true);
  });

  it('reads light groups and light linking', () => {
    expect(doc.scene.view_layers![0].lightgroups).toEqual([{ name: 'key' }]);
    expect(ob('Light').lightgroup).toBe('key');
    expect(doc.worlds[doc.scene.world!].lightgroup).toBe('sky');
    const ll = ob('Light').light_linking!;
    expect(doc.collections[ll.receiver_collection!].name).toBe('Light Linking for Light');
    expect(Object.fromEntries(linkMembers(doc, ll.receiver_collection!))).toEqual({ [ob('Cube').id]: 'EXCLUDE' });
    expect(doc.collections[ll.blocker_collection!].objects).toEqual([ob('Sphere').id]);
  });
});
