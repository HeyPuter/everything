// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';

(globalThis as unknown as { requestAnimationFrame: (f: () => void) => number }).requestAnimationFrame = (f) => setTimeout(f, 0) as unknown as number;

import { Vector3 } from 'three';
import { App, setApp, app } from '../../src/app/app';
import { startupDocument, newObject } from '../../src/data/defaults';
import type { ObjectData } from '../../src/data/types';
import { addObjectToScene } from '../../src/ops/object';
import '../../src/ops/data';
import '../../src/object/index';
import '../../src/ops/view3d';

beforeEach(() => setApp(new App(startupDocument())));

function select(...obs: ObjectData[]) {
  for (const o of Object.values(app.doc.objects)) o.select = false;
  for (const o of obs) o.select = true;
  app.doc.scene.active_object = obs[0]?.id ?? null;
  app.graph.evaluate(app.doc, false);
}
function run(op: string, props: Record<string, unknown> = {}) {
  const r = app.run(op, props, { invoke: false });
  app.graph.evaluate(app.doc, false);
  return r;
}
const worldPos = (ob: ObjectData) => new Vector3().setFromMatrixPosition(app.graph.get(ob.id)!.world);
const round = (v: Vector3) => v.toArray().map((x) => +x.toFixed(4) + 0);

function parentPair() {
  const p = newObject('P', 'EMPTY', null);
  addObjectToScene(app.doc, p, { location: [1, 0, 0] });
  const c = newObject('C', 'EMPTY', null);
  addObjectToScene(app.doc, c, { location: [3, 0, 0] });
  c.parent = p.id;
  // keep the child's world position: parent inverse of the parent's world
  c.matrix_parent_inverse = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -1, 0, 0, 1] as never;
  app.graph.evaluate(app.doc, false);
  return { p, c };
}

describe('snap selection with parent and child selected', () => {
  it('moves the child with its parent (to cursor)', () => {
    const { p, c } = parentPair();
    expect(round(worldPos(c))).toEqual([3, 0, 0]);
    app.doc.scene.cursor.location = [0, 5, 0];
    select(p, c);
    run('view3d.snap_selected_to_cursor', { use_offset: true });
    // the median (2, 0, 0) lands on the cursor: everything shifts by (-2, 5, 0)
    expect(round(worldPos(p))).toEqual([-1, 5, 0]);
    expect(round(worldPos(c))).toEqual([1, 5, 0]);
  });

  it('moves the child with its parent (to grid)', () => {
    const { p, c } = parentPair();
    p.location = [1.4, 0, 0];
    app.graph.evaluate(app.doc, false);
    select(p, c);
    run('view3d.snap_selected_to_grid');
    expect(round(worldPos(p))).toEqual([1, 0, 0]);
    expect(round(worldPos(c))).toEqual([3, 0, 0]);
  });
});
