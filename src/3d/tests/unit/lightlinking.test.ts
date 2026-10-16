// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';

(globalThis as unknown as { requestAnimationFrame: (f: () => void) => number }).requestAnimationFrame = (f) => setTimeout(f, 0) as unknown as number;

import { App, setApp, app } from '../../src/app/app';
import { startupDocument, newCollection } from '../../src/data/defaults';
import '../../src/ops/data';
import '../../src/object/index';
import '../../src/scenes/lightlinkui';
import { computeLinkTable, linkAffects, linkMembers } from '../../src/scenes/lightlinking';
import { layerVisibility } from '../../src/scenes/rendervis';

beforeEach(() => setApp(new App(startupDocument())));
const ob = (n: string) => Object.values(app.doc.objects).find((o) => o.name === n)!;

describe('light linking', () => {
  it('include / exclude rules', () => {
    const m = new Map([['a', 'INCLUDE' as const]]);
    expect(linkAffects(m, 'a')).toBe(true);
    expect(linkAffects(m, 'b')).toBe(false);
    const x = new Map([['a', 'EXCLUDE' as const]]);
    expect(linkAffects(x, 'a')).toBe(false);
    expect(linkAffects(x, 'b')).toBe(true);
    expect(linkAffects(null, 'b')).toBe(true);
  });

  it('child collections pass their state to their objects', () => {
    const c = newCollection('L');
    const child = newCollection('Kids');
    child.objects.push('o1', 'o2');
    c.children.push(child.id);
    c.objects.push('o3');
    c.light_linking = { [child.id]: 'EXCLUDE' };
    app.doc.collections[c.id] = c;
    app.doc.collections[child.id] = child;
    const m = linkMembers(app.doc, c.id);
    expect(Object.fromEntries(m)).toEqual({ o3: 'INCLUDE', o1: 'EXCLUDE', o2: 'EXCLUDE' });
  });

  it('operators build the receiver collection and the renderer table', () => {
    const light = ob('Light'),
      cube = ob('Cube');
    for (const o of Object.values(app.doc.objects)) o.select = o === light || o === cube;
    app.doc.scene.active_object = light.id;
    app.evaluate();
    expect(app.run('object.light_linking_receivers_link', { link_state: 'EXCLUDE' }, { invoke: false })).toBe('FINISHED');
    const cid = light.light_linking!.receiver_collection!;
    expect(app.doc.collections[cid].name).toBe('Light Linking for Light');
    expect(app.doc.collections[cid].objects).toEqual([cube.id]);
    const t = computeLinkTable(app.doc, [cube.id, ob('Camera').id], [light.id])!;
    const g = t.objectGroup.get(cube.id)!;
    expect(g).not.toBe(0);
    expect(t.objectGroup.get(ob('Camera').id)).toBe(0);
    const masks = t.lights.get(light.id)!;
    expect(masks.receive & (1 << g)).toBe(0);
    expect(masks.receive & 1).toBe(1);
    expect(masks.block & (1 << g)).not.toBe(0);
    // unlink
    app.run('object.light_linking_unlink_from_collection', { collection: cid, item: cube.id }, { invoke: false });
    expect(app.doc.collections[cid].objects).toEqual([]);
    expect(computeLinkTable(app.doc, [cube.id], [ob('Camera').id])).toBeNull();
  });

  it('select receivers and new blocker collection', () => {
    const light = ob('Light');
    for (const o of Object.values(app.doc.objects)) o.select = o === light;
    app.doc.scene.active_object = light.id;
    app.evaluate();
    app.run('object.light_linking_blocker_collection_new', {}, { invoke: false });
    expect(app.doc.collections[light.light_linking!.blocker_collection!].name).toBe('Shadow Linking for Light');
  });
});

describe('view layer render visibility', () => {
  it('holdout and indirect only follow collections and object flags', () => {
    const col = Object.values(app.doc.collections).find((c) => c.name === 'Collection')!;
    col.holdout = true;
    expect(layerVisibility(app.doc).holdout.has(ob('Cube').id)).toBe(true);
    col.holdout = false;
    col.indirect_only = true;
    expect(layerVisibility(app.doc).indirect.has(ob('Light').id)).toBe(true);
    col.indirect_only = false;
    ob('Cube').is_holdout = true;
    expect([...layerVisibility(app.doc).holdout]).toEqual([ob('Cube').id]);
  });
});
