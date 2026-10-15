// UV selection operators: click, loop, ring, linked, box/circle/lasso, more/less, similar,
// overlap, pinned, split, winding, shortest path, select mode and hide/reveal.
import { app, registerOperators, operators, type OpContext } from '../../app/app';
import { UVTopo, SelEdit, isPinned, faceUVCenter, pointInPolygon, visibleFaces, type UVLayer } from './uvcore';
import { pickVert, pickEdge, pickFace, edgeLoop, edgeRing, growCorners, shrinkCorners, similarCorners, overlappingFaces, windingFaces, shortestVertPath, shortestFacePath, type SimilarType, type Compare } from './uvselect';
import { uvLayers, layerTopos, uvSelectMode, stickyMode, uvEditPoll, ctxUVEditor, pickRadius, uvChanged, type EditLayer } from './uvcontext';

type SelMode = 'SET' | 'ADD' | 'SUB';

/** Last picked element, the start of shortest-path picks. */
export const uvActive: { objectId: string; kind: 'VERT' | 'FACE'; index: number } = { objectId: '', kind: 'VERT', index: -1 };

/** UV location of the operator's event in the UV editor. */
export function eventUV(ctx: OpContext): [number, number] | null {
  const view = ctxUVEditor(ctx);
  if (!view) return null;
  const ev = ctx.event ?? app.pointer;
  const l = view.local({ clientX: ev.x, clientY: ev.y });
  const uv = view.toUV(l.x, l.y);
  return [uv.u, uv.v];
}

/** Invoke for location-based operators: take the location from the pointer. */
export function locInvoke(exec: (ctx: OpContext, p: Record<string, unknown>) => unknown) {
  return (ctx: OpContext, p: Record<string, unknown>) => {
    const loc = eventUV(ctx);
    if (!loc) return 'CANCELLED' as const;
    p.location = loc;
    return exec(ctx, p) as 'FINISHED' | 'CANCELLED' | undefined;
  };
}

function locProp() {
  return { id: 'location', label: 'Location', type: 'vec2' as const, default: [0, 0], hidden: true };
}

/** Corners of the element under (u, v) in the current select mode, per layer. */
export function elementAt(layers: { layer: EditLayer; t: UVTopo }[], u: number, v: number, radius: number): { li: number; corners: number[]; corner: number; face: number } | null {
  const mode = uvSelectMode();
  const sticky = stickyMode();
  let best: { li: number; corners: number[]; corner: number; face: number; d: number } | null = null;
  layers.forEach(({ t }, li) => {
    if (mode === 'VERTEX') {
      const p = pickVert(t, u, v, radius);
      if (p && (!best || p.d < best.d)) best = { li, corners: t.stickyCorners(p.corner, sticky), corner: p.corner, face: t.cornerFace[p.corner], d: p.d };
    } else if (mode === 'EDGE') {
      const p = pickEdge(t, u, v, radius);
      if (p && (!best || p.d < best.d)) best = { li, corners: [...t.stickyCorners(p.corner, sticky), ...t.stickyCorners(t.next(p.corner), sticky)], corner: p.corner, face: t.cornerFace[p.corner], d: p.d };
    } else {
      const f = pickFace(t, u, v, radius);
      if (f < 0) return;
      const [cu, cv] = faceUVCenter(t.me, f);
      const d = Math.hypot(cu - u, cv - v);
      if (best && d >= best.d) return;
      let corners: number[];
      if (mode === 'ISLAND') {
        const { faceIsland } = t.islands;
        corners = [];
        for (const g of t.faces) if (faceIsland[g] === faceIsland[f]) for (let c = t.me.offsets[g]; c < t.me.offsets[g + 1]; c++) corners.push(c);
      } else corners = Array.from({ length: t.me.offsets[f + 1] - t.me.offsets[f] }, (_, i) => t.me.offsets[f] + i);
      best = { li, corners, corner: t.me.offsets[f], face: f, d };
    }
  });
  return best;
}

function commitAll(edits: SelEdit[]) {
  for (const e of edits) e.commit();
  uvChanged(true);
}

const selectOp = {
  idname: 'uv.select',
  label: 'Select',
  description: 'Select the UV element under the pointer',
  props: [
    { id: 'extend', label: 'Extend', type: 'bool' as const, default: false },
    { id: 'deselect', label: 'Deselect', type: 'bool' as const, default: false },
    { id: 'toggle', label: 'Toggle Selection', type: 'bool' as const, default: false },
    { id: 'deselect_all', label: 'Deselect On Nothing', type: 'bool' as const, default: false },
    locProp(),
  ],
  poll: uvEditPoll,
  exec: (ctx: OpContext, p: Record<string, unknown>) => {
    const [u, v] = p.location as number[];
    const tl = layerTopos();
    const hit = elementAt(tl, u, v, pickRadius(ctxUVEditor(ctx)));
    const edits = tl.map(({ layer }) => new SelEdit(layer));
    if (!hit) {
      if (!p.deselect_all) return 'CANCELLED';
      edits.forEach((e) => e.clear());
      commitAll(edits);
      return 'FINISHED';
    }
    const e = edits[hit.li];
    const already = hit.corners.every((c) => e.get(c));
    let on = true;
    if (p.deselect) on = false;
    else if (p.toggle) on = !already;
    if (!p.extend && !p.deselect && !p.toggle) edits.forEach((x) => x.clear());
    for (const c of hit.corners) e.set(c, on);
    if (on) {
      const mode = uvSelectMode();
      uvActive.objectId = tl[hit.li].layer.objectId ?? '';
      uvActive.kind = mode === 'FACE' || mode === 'ISLAND' ? 'FACE' : 'VERT';
      uvActive.index = uvActive.kind === 'FACE' ? hit.face : tl[hit.li].t.uvVert[hit.corner];
    }
    commitAll(edits);
    return 'FINISHED';
  },
  undo: true,
};

function loopOp(idname: string, label: string, ring: boolean) {
  return {
    idname,
    label,
    props: [{ id: 'extend', label: 'Extend', type: 'bool' as const, default: false }, locProp()],
    poll: uvEditPoll,
    exec: (ctx: OpContext, p: Record<string, unknown>) => {
      const [u, v] = p.location as number[];
      const tl = layerTopos();
      const radius = pickRadius(ctxUVEditor(ctx));
      let best: { li: number; corner: number; d: number } | null = null;
      tl.forEach(({ t }, li) => {
        const e = pickEdge(t, u, v, radius * 2);
        if (e && (!best || e.d < best.d)) best = { li, corner: e.corner, d: e.d };
      });
      if (!best) return 'CANCELLED';
      const b = best as { li: number; corner: number };
      const { t } = tl[b.li];
      const edits = tl.map(({ layer }) => new SelEdit(layer));
      if (!p.extend) edits.forEach((x) => x.clear());
      const e = edits[b.li];
      const faceMode = uvSelectMode() === 'FACE' || uvSelectMode() === 'ISLAND';
      let corners: number[] = [];
      if (faceMode) {
        // a loop of faces: the faces crossed by the ring through the picked edge
        const faces = edgeRing(t, b.corner).faces;
        for (const f of faces) for (let c = t.me.offsets[f]; c < t.me.offsets[f + 1]; c++) corners.push(c);
      } else {
        const edges = ring ? edgeRing(t, b.corner).corners : edgeLoop(t, b.corner);
        for (const c of edges) corners.push(...t.vertCorners[t.uvVert[c]], ...t.vertCorners[t.uvVert[t.next(c)]]);
      }
      const on = !(p.extend && corners.every((c) => e.get(c)));
      for (const c of corners) e.set(c, on);
      commitAll(edits);
    },
  };
}

function islandCornersOf(t: UVTopo, seedFaces: Set<number>): number[] {
  const { faceIsland } = t.islands;
  const islands = new Set([...seedFaces].map((f) => faceIsland[f]));
  const out: number[] = [];
  for (const f of t.faces) if (islands.has(faceIsland[f])) for (let c = t.me.offsets[f]; c < t.me.offsets[f + 1]; c++) out.push(c);
  return out;
}

/** Box, circle and lasso share this: select the elements matched by a UV-space test. */
export function selectByTest(test: (u: number, v: number) => boolean, mode: SelMode, pinnedOnly = false) {
  const selMode = uvSelectMode();
  const sticky = stickyMode();
  const tl = layerTopos();
  const edits = tl.map(({ layer }) => new SelEdit(layer));
  if (mode === 'SET') edits.forEach((e) => e.clear());
  tl.forEach(({ t }, li) => {
    const e = edits[li];
    const on = mode !== 'SUB';
    if ((selMode === 'FACE' || selMode === 'ISLAND') && !pinnedOnly) {
      const hit = new Set<number>();
      for (const f of t.faces) {
        const [cu, cv] = faceUVCenter(t.me, f);
        if (test(cu, cv)) hit.add(f);
      }
      const corners = selMode === 'ISLAND' ? islandCornersOf(t, hit) : [...hit].flatMap((f) => Array.from({ length: t.me.offsets[f + 1] - t.me.offsets[f] }, (_, i) => t.me.offsets[f] + i));
      for (const c of corners) e.set(c, on);
      return;
    }
    for (let id = 0; id < t.vertCount; id++) {
      const c0 = t.vertCorners[id][0];
      if (!test(t.u(c0), t.v(c0))) continue;
      if (pinnedOnly && !t.vertCorners[id].some((c) => isPinned(t.me, c))) continue;
      for (const c of t.stickyCorners(c0, sticky)) e.set(c, on);
    }
  });
  commitAll(edits);
}

const modeProp = { id: 'mode', label: 'Mode', type: 'enum' as const, default: 'SET', items: [['SET', 'Set'], ['ADD', 'Extend'], ['SUB', 'Subtract']] as [string, string][] };

registerOperators([
  selectOp,
  {
    idname: 'uv.select_all',
    label: '(De)select All',
    description: 'Change the selection of all UV elements',
    props: [{ id: 'action', label: 'Action', type: 'enum', default: 'TOGGLE', items: [['TOGGLE', 'Toggle'], ['SELECT', 'Select'], ['DESELECT', 'Deselect'], ['INVERT', 'Invert']] }],
    poll: uvEditPoll,
    redo: false,
    exec: (_ctx, p) => {
      const tl = layerTopos();
      let action = p.action as string;
      if (action === 'TOGGLE') action = tl.some(({ layer, sel }) => layer.faces.some((f) => anySel(layer, sel, f))) ? 'DESELECT' : 'SELECT';
      const edits = tl.map(({ layer }) => new SelEdit(layer));
      tl.forEach(({ layer }, li) => {
        const e = edits[li];
        const me = layer.me;
        if (layer.sync && action === 'INVERT') {
          // per vertex: visit each vertex once
          const seen = new Set<number>();
          for (const f of layer.faces)
            for (let c = me.offsets[f]; c < me.offsets[f + 1]; c++) {
              if (seen.has(me.indices[c])) continue;
              seen.add(me.indices[c]);
              e.set(c, !e.get(c));
            }
          return;
        }
        for (const f of layer.faces) for (let c = me.offsets[f]; c < me.offsets[f + 1]; c++) e.set(c, action === 'SELECT' ? true : action === 'DESELECT' ? false : !e.get(c));
      });
      commitAll(edits);
    },
  },
  loopOp('uv.select_loop', 'Loop Select', false),
  loopOp('uv.select_edge_ring', 'Edge Ring Select', true),
  {
    idname: 'uv.select_linked',
    label: 'Select Linked',
    description: 'Select all UVs connected to the selection',
    poll: uvEditPoll,
    exec: () => {
      const tl = layerTopos();
      const edits = tl.map(({ layer }) => new SelEdit(layer));
      tl.forEach(({ t, sel }, li) => {
        const seeds = new Set(t.faces.filter((f) => anySel(t, sel, f)));
        for (const c of islandCornersOf(t, seeds)) edits[li].set(c, true);
      });
      commitAll(edits);
    },
  },
  {
    idname: 'uv.select_linked_pick',
    label: 'Select Linked Pick',
    description: 'Select or deselect all UVs connected to the element under the pointer',
    props: [{ id: 'extend', label: 'Extend', type: 'bool', default: false }, { id: 'deselect', label: 'Deselect', type: 'bool', default: false }, locProp()],
    poll: uvEditPoll,
    exec: (ctx, p) => {
      const [u, v] = p.location as number[];
      const tl = layerTopos();
      const radius = pickRadius(ctxUVEditor(ctx));
      let best: { li: number; face: number; d: number } | null = null;
      tl.forEach(({ t }, li) => {
        let f = pickFace(t, u, v, radius);
        let d = 0;
        if (f < 0) {
          const pv = pickVert(t, u, v, radius * 2);
          if (!pv) return;
          f = t.cornerFace[pv.corner];
          d = pv.d;
        }
        if (!best || d < best.d) best = { li, face: f, d };
      });
      if (!best) return 'CANCELLED';
      const b = best as { li: number; face: number };
      const edits = tl.map(({ layer }) => new SelEdit(layer));
      if (!p.extend && !p.deselect) edits.forEach((e) => e.clear());
      for (const c of islandCornersOf(tl[b.li].t, new Set([b.face]))) edits[b.li].set(c, !p.deselect);
      commitAll(edits);
    },
  },
  {
    idname: 'uv.select_box',
    label: 'Box Select',
    description: 'Select UVs inside a rectangle',
    props: [
      { id: 'pinned', label: 'Pinned', type: 'bool', default: false },
      modeProp,
      { id: 'xmin', type: 'float', default: 0, hidden: true },
      { id: 'xmax', type: 'float', default: 0, hidden: true },
      { id: 'ymin', type: 'float', default: 0, hidden: true },
      { id: 'ymax', type: 'float', default: 0, hidden: true },
    ],
    poll: uvEditPoll,
    invoke: (ctx, p) => startShapeSelect(ctx, 'BOX', p),
    exec: (_ctx, p) => {
      const [x0, x1, y0, y1] = [p.xmin, p.xmax, p.ymin, p.ymax] as number[];
      selectByTest((u, v) => u >= x0 && u <= x1 && v >= y0 && v <= y1, p.mode as SelMode, !!p.pinned);
    },
  },
  {
    idname: 'uv.select_circle',
    label: 'Circle Select',
    description: 'Select UVs by painting with a circle',
    props: [modeProp, { id: 'radius', label: 'Radius', type: 'int', default: 25, min: 1, max: 1000 }, { id: 'x', type: 'float', default: 0, hidden: true }, { id: 'y', type: 'float', default: 0, hidden: true }, { id: 'uv_radius', type: 'float', default: 0, hidden: true }],
    poll: uvEditPoll,
    invoke: (ctx, p) => startShapeSelect(ctx, 'CIRCLE', p),
    exec: (_ctx, p) => {
      const x = p.x as number,
        y = p.y as number,
        r = p.uv_radius as number;
      selectByTest((u, v) => Math.hypot(u - x, v - y) <= r, p.mode as SelMode);
    },
  },
  {
    idname: 'uv.select_lasso',
    label: 'Lasso Select',
    description: 'Select UVs inside a freehand outline',
    props: [modeProp, { id: 'path', type: 'string', default: '', hidden: true }],
    poll: uvEditPoll,
    invoke: (ctx, p) => startShapeSelect(ctx, 'LASSO', p),
    exec: (_ctx, p) => {
      let path: [number, number][] = [];
      try {
        path = JSON.parse((p.path as string) || '[]');
      } catch {
        return 'CANCELLED';
      }
      if (path.length < 3) return 'CANCELLED';
      selectByTest((u, v) => pointInPolygon(u, v, path), p.mode as SelMode);
    },
  },
  {
    idname: 'uv.select_more',
    label: 'Select More',
    description: 'Grow the UV selection by one step',
    poll: uvEditPoll,
    exec: () => {
      const tl = layerTopos();
      const faceMode = uvSelectMode() === 'FACE' || uvSelectMode() === 'ISLAND';
      const edits = tl.map(({ layer }) => new SelEdit(layer));
      tl.forEach(({ t, sel }, li) => {
        for (const c of growCorners(t, sel, faceMode)) edits[li].set(c, true);
      });
      commitAll(edits);
    },
  },
  {
    idname: 'uv.select_less',
    label: 'Select Less',
    description: 'Shrink the UV selection by one step',
    poll: uvEditPoll,
    exec: () => {
      const tl = layerTopos();
      const faceMode = uvSelectMode() === 'FACE' || uvSelectMode() === 'ISLAND';
      const edits = tl.map(({ layer }) => new SelEdit(layer));
      tl.forEach(({ t, sel }, li) => {
        for (const c of shrinkCorners(t, sel, faceMode)) edits[li].set(c, false);
      });
      commitAll(edits);
    },
  },
  {
    idname: 'uv.select_similar',
    label: 'Select Similar',
    description: 'Select UV elements with properties like the selected ones',
    props: [
      {
        id: 'type',
        label: 'Type',
        type: 'enum',
        default: 'PIN',
        items: [['PIN', 'Pinned'], ['LENGTH', 'Length'], ['LENGTH_3D', 'Length 3D'], ['AREA', 'Area'], ['AREA_3D', 'Area 3D'], ['MATERIAL', 'Material'], ['OBJECT', 'Object'], ['SIDES', 'Polygon Sides'], ['WINDING', 'Winding'], ['FACE', 'Amount of Faces in Island']],
      },
      { id: 'compare', label: 'Compare', type: 'enum', default: 'EQUAL', items: [['EQUAL', 'Equal'], ['GREATER', 'Greater'], ['LESS', 'Less']] },
      { id: 'threshold', label: 'Threshold', type: 'float', default: 0, min: 0, max: 1, subtype: 'factor' },
    ],
    poll: uvEditPoll,
    exec: (_ctx, p) => {
      const tl = layerTopos();
      const out = similarCorners(
        tl.map(({ t, sel }, i) => ({ t, sel, objectIndex: i })),
        uvSelectMode(),
        p.type as SimilarType,
        p.compare as Compare,
        p.threshold as number,
      );
      const edits = tl.map(({ layer }) => new SelEdit(layer));
      out.forEach((cs, li) => cs.forEach((c) => edits[li].set(c, true)));
      commitAll(edits);
    },
  },
  {
    idname: 'uv.select_overlap',
    label: 'Select Overlap',
    description: 'Select faces whose UVs overlap other faces',
    props: [{ id: 'extend', label: 'Extend', type: 'bool', default: false }],
    poll: uvEditPoll,
    exec: (_ctx, p) => {
      const tl = layerTopos();
      const faces = overlappingFaces(tl.map((x) => x.t));
      const edits = tl.map(({ layer }) => new SelEdit(layer));
      if (!p.extend) edits.forEach((e) => e.clear());
      faces.forEach((fs, li) => {
        const me = tl[li].layer.me;
        for (const f of fs) for (let c = me.offsets[f]; c < me.offsets[f + 1]; c++) edits[li].set(c, true);
      });
      commitAll(edits);
    },
  },
  {
    idname: 'uv.select_pinned',
    label: 'Select Pinned',
    description: 'Select all pinned UVs',
    poll: uvEditPoll,
    exec: () => {
      const tl = layerTopos();
      const edits = tl.map(({ layer }) => new SelEdit(layer));
      tl.forEach(({ layer }, li) => {
        const me = layer.me;
        for (const f of layer.faces) for (let c = me.offsets[f]; c < me.offsets[f + 1]; c++) if (isPinned(me, c)) edits[li].set(c, true);
      });
      commitAll(edits);
    },
  },
  {
    idname: 'uv.select_split',
    label: 'Select Split',
    description: 'Keep only fully selected faces selected, so they detach from their neighbours when moved',
    poll: (ctx) => uvEditPoll() && !app.doc.scene.tool_settings.use_uv_select_sync && !!ctx,
    exec: () => {
      const tl = layerTopos();
      const edits = tl.map(({ layer }) => new SelEdit(layer));
      let n = 0;
      tl.forEach(({ layer, sel }, li) => {
        const me = layer.me;
        for (const f of layer.faces) {
          if (faceAll(layer, sel, f)) continue;
          for (let c = me.offsets[f]; c < me.offsets[f + 1]; c++)
            if (sel(c)) {
              edits[li].set(c, false);
              n++;
            }
        }
      });
      if (!n) return 'CANCELLED';
      commitAll(edits);
    },
  },
  {
    idname: 'uv.select_by_winding',
    label: 'Select by Winding',
    description: 'Select faces by the direction their UVs wind (negative = flipped)',
    props: [
      { id: 'winding', label: 'Winding', type: 'enum', default: 'NEGATIVE', items: [['POSITIVE', 'Positive'], ['NEGATIVE', 'Negative']] },
      { id: 'extend', label: 'Extend', type: 'bool', default: false },
    ],
    poll: uvEditPoll,
    exec: (_ctx, p) => {
      const tl = layerTopos();
      const edits = tl.map(({ layer }) => new SelEdit(layer));
      if (!p.extend) edits.forEach((e) => e.clear());
      tl.forEach(({ t }, li) => {
        for (const f of windingFaces(t, p.winding === 'POSITIVE')) for (let c = t.me.offsets[f]; c < t.me.offsets[f + 1]; c++) edits[li].set(c, true);
      });
      commitAll(edits);
    },
  },
  {
    idname: 'uv.shortest_path_pick',
    label: 'Pick Shortest Path',
    description: 'Select the shortest path from the last picked element to the one under the pointer',
    props: [{ id: 'use_topology_distance', label: 'Topology Distance', type: 'bool', default: false }, locProp()],
    poll: uvEditPoll,
    exec: (ctx, p) => {
      const [u, v] = p.location as number[];
      const tl = layerTopos();
      const hit = elementAt(tl, u, v, pickRadius(ctxUVEditor(ctx)));
      if (!hit) return 'CANCELLED';
      const { t, layer } = tl[hit.li];
      const faceMode = uvSelectMode() === 'FACE' || uvSelectMode() === 'ISLAND';
      const edits = tl.map(({ layer: l }) => new SelEdit(l));
      const e = edits[hit.li];
      const target = faceMode ? hit.face : t.uvVert[hit.corner];
      const sameStart = uvActive.objectId === (layer.objectId ?? '') && uvActive.kind === (faceMode ? 'FACE' : 'VERT') && uvActive.index >= 0;
      if (sameStart) {
        const path = faceMode ? shortestFacePath(t, uvActive.index, target, !!p.use_topology_distance) : uvActive.index < t.vertCount ? shortestVertPath(t, uvActive.index, target, !!p.use_topology_distance) : [];
        if (faceMode) for (const f of path) for (let c = t.me.offsets[f]; c < t.me.offsets[f + 1]; c++) e.set(c, true);
        else for (const id of path) for (const c of t.vertCorners[id]) e.set(c, true);
      }
      for (const c of hit.corners) e.set(c, true);
      uvActive.objectId = layer.objectId ?? '';
      uvActive.kind = faceMode ? 'FACE' : 'VERT';
      uvActive.index = target;
      commitAll(edits);
    },
  },
  {
    idname: 'uv.shortest_path_select',
    label: 'Select Shortest Path',
    description: 'Select the shortest path between two selected UV vertices or faces',
    props: [{ id: 'use_topology_distance', label: 'Topology Distance', type: 'bool', default: false }],
    poll: uvEditPoll,
    exec: (_ctx, p) => {
      const tl = layerTopos();
      const faceMode = uvSelectMode() === 'FACE' || uvSelectMode() === 'ISLAND';
      let done = false;
      const edits = tl.map(({ layer }) => new SelEdit(layer));
      tl.forEach(({ t, sel, layer }, li) => {
        if (done) return;
        if (faceMode) {
          const fs = layer.faces.filter((f) => faceAll(layer, sel, f));
          if (fs.length !== 2) return;
          for (const f of shortestFacePath(t, fs[0], fs[1], !!p.use_topology_distance)) for (let c = t.me.offsets[f]; c < t.me.offsets[f + 1]; c++) edits[li].set(c, true);
        } else {
          const vs: number[] = [];
          for (let id = 0; id < t.vertCount; id++) if (t.vertCorners[id].some(sel)) vs.push(id);
          if (vs.length !== 2) return;
          for (const id of shortestVertPath(t, vs[0], vs[1], !!p.use_topology_distance)) for (const c of t.vertCorners[id]) edits[li].set(c, true);
        }
        done = true;
      });
      if (!done) {
        app.report('WARNING', 'Select exactly two UV vertices or faces');
        return 'CANCELLED';
      }
      commitAll(edits);
    },
  },
  {
    idname: 'uv.select_mode',
    label: 'UV Select Mode',
    description: 'Change the UV selection mode',
    props: [{ id: 'type', label: 'Type', type: 'enum', default: 'VERTEX', items: [['VERTEX', 'Vertex'], ['EDGE', 'Edge'], ['FACE', 'Face'], ['ISLAND', 'Island']] }],
    poll: () => app.doc.mode === 'EDIT',
    undo: false,
    exec: (_ctx, p) => {
      const ts = app.doc.scene.tool_settings;
      if (ts.use_uv_select_sync) {
        const i = ['VERTEX', 'EDGE', 'FACE'].indexOf(p.type as string);
        if (i >= 0) app.run('mesh.select_mode', { type: ['VERT', 'EDGE', 'FACE'][i] }, { invoke: false });
        return 'FINISHED';
      }
      ts.uv_select_mode = p.type as typeof ts.uv_select_mode;
      // tidy the selection so it matches the new mode
      if (ts.uv_select_mode === 'FACE' || ts.uv_select_mode === 'ISLAND') {
        const tl = layerTopos();
        const edits = tl.map(({ layer }) => new SelEdit(layer));
        tl.forEach(({ layer, sel, t }, li) => {
          const full = new Set(layer.faces.filter((f) => faceAll(layer, sel, f)));
          const keep = ts.uv_select_mode === 'ISLAND' ? new Set(islandCornersOf(t, full)) : null;
          for (const f of layer.faces)
            for (let c = layer.me.offsets[f]; c < layer.me.offsets[f + 1]; c++) edits[li].set(c, keep ? keep.has(c) : full.has(f));
        });
        for (const e of edits) e.commit();
      }
      app.pushUndo('UV Select Mode');
      uvChanged(true);
    },
  },
  {
    idname: 'uv.hide',
    label: 'Hide Selected',
    description: 'Hide the selected (or unselected) UV faces',
    props: [{ id: 'unselected', label: 'Unselected', type: 'bool', default: false }],
    poll: uvEditPoll,
    exec: (_ctx, p) => {
      if (app.doc.scene.tool_settings.use_uv_select_sync) return app.run('mesh.hide', { unselected: p.unselected }, { invoke: false }) === 'FINISHED' ? 'FINISHED' : 'CANCELLED';
      let n = 0;
      for (const { layer, sel } of layerTopos()) {
        const me = layer.me;
        const nf = me.offsets.length - 1;
        const hide = me.uv_hide && me.uv_hide.length === nf ? new Uint8Array(me.uv_hide) : new Uint8Array(nf);
        for (const f of layer.faces) {
          if (p.unselected ? !anySel(layer, sel, f) : faceAll(layer, sel, f)) {
            hide[f] = 1;
            n++;
          }
        }
        me.uv_hide = hide;
      }
      if (!n) return 'CANCELLED';
      uvChanged(true);
    },
  },
  {
    idname: 'uv.reveal',
    label: 'Reveal Hidden',
    description: 'Show UV faces hidden in the UV editor',
    props: [{ id: 'select', label: 'Select', type: 'bool', default: true }],
    poll: uvEditPoll,
    exec: (_ctx, p) => {
      if (app.doc.scene.tool_settings.use_uv_select_sync) return app.run('mesh.reveal', { select: p.select }, { invoke: false }) === 'FINISHED' ? 'FINISHED' : 'CANCELLED';
      let n = 0;
      for (const l of uvLayers()) {
        const me = l.me;
        if (!me.uv_hide) continue;
        const nf = me.offsets.length - 1;
        const was = me.uv_hide.length === nf ? me.uv_hide : new Uint8Array(nf);
        me.uv_hide = undefined;
        const faces = visibleFaces(me, false);
        const edit = new SelEdit({ me, faces, sync: false });
        for (const f of faces)
          if (was[f]) {
            n++;
            for (let c = me.offsets[f]; c < me.offsets[f + 1]; c++) edit.set(c, !!p.select);
          }
        edit.commit();
      }
      if (!n) return 'CANCELLED';
      uvChanged(true);
    },
  },
]);

function anySel(l: UVLayer | UVTopo, sel: (c: number) => boolean, f: number) {
  const me = l.me;
  for (let c = me.offsets[f]; c < me.offsets[f + 1]; c++) if (sel(c)) return true;
  return false;
}

function faceAll(l: UVLayer, sel: (c: number) => boolean, f: number) {
  const me = l.me;
  for (let c = me.offsets[f]; c < me.offsets[f + 1]; c++) if (!sel(c)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// interactive box / circle / lasso

/** Draw state of a running shape selection, read by the editor's overlay. */
export const shapeSelect: { kind: 'BOX' | 'CIRCLE' | 'LASSO' | null; pts: { x: number; y: number }[]; radius: number } = { kind: null, pts: [], radius: 25 };

/** Box/circle/lasso from a key press or menu: drag to select, release to finish. */
function startShapeSelect(ctx: OpContext, kind: 'BOX' | 'CIRCLE' | 'LASSO', p: Record<string, unknown>) {
  const view = ctxUVEditor(ctx);
  if (!view) return 'CANCELLED';
  const r = view.el.getBoundingClientRect();
  const local = (e: { clientX: number; clientY: number }) => ({ x: e.clientX - r.left, y: e.clientY - r.top });
  let dragging = false;
  let mode = p.mode as SelMode;
  shapeSelect.kind = kind;
  shapeSelect.pts = [];
  if (kind === 'CIRCLE') {
    shapeSelect.radius = (p.radius as number) || shapeSelect.radius;
    shapeSelect.pts = [{ x: app.pointer.x - r.left, y: app.pointer.y - r.top }];
  }
  const circleAt = (pt: { x: number; y: number }, m: SelMode) => {
    const c = view.toUV(pt.x, pt.y);
    app.run('uv.select_circle', { x: c.u, y: c.v, uv_radius: shapeSelect.radius / view.scale(), mode: m === 'SET' ? 'ADD' : m, radius: shapeSelect.radius }, { invoke: false, area: ctx.area });
  };
  const finish = () => {
    shapeSelect.kind = null;
    view.draw();
  };
  app.startModal({
    label: kind === 'BOX' ? 'Box Select' : kind === 'CIRCLE' ? 'Circle Select' : 'Lasso Select',
    cursor: 'crosshair',
    header: () => (kind === 'CIRCLE' ? 'Circle select: drag to select (Shift: deselect), wheel to resize, Esc/right-click to finish' : 'Drag to select (Shift: deselect, Ctrl: extend)'),
    onPointerDown(e) {
      if (e.button !== 0) return kind === 'CIRCLE' ? 'FINISHED' : 'CANCELLED';
      dragging = true;
      const pt = local(e);
      if (kind === 'CIRCLE') {
        mode = e.shiftKey || mode === 'SUB' ? 'SUB' : 'ADD';
        circleAt(pt, mode);
      } else shapeSelect.pts = [pt, pt];
      if (e.shiftKey && kind !== 'CIRCLE') mode = 'SUB';
      else if (e.ctrlKey && kind !== 'CIRCLE') mode = 'ADD';
      view.draw();
    },
    onPointerMove(e) {
      const pt = local(e);
      if (kind === 'CIRCLE') {
        shapeSelect.pts = [pt];
        if (dragging) circleAt(pt, mode);
      } else if (dragging) {
        if (kind === 'BOX') shapeSelect.pts[1] = pt;
        else shapeSelect.pts.push(pt);
      }
      view.draw();
    },
    onPointerUp() {
      if (!dragging) return;
      dragging = false;
      if (kind === 'CIRCLE') return;
      const pts = shapeSelect.pts;
      if (kind === 'BOX') {
        const a = view.toUV(Math.min(pts[0].x, pts[1].x), Math.max(pts[0].y, pts[1].y)),
          b = view.toUV(Math.max(pts[0].x, pts[1].x), Math.min(pts[0].y, pts[1].y));
        finish();
        app.endModal('CANCELLED');
        app.run('uv.select_box', { ...p, xmin: a.u, xmax: b.u, ymin: a.v, ymax: b.v, mode }, { invoke: false, area: ctx.area });
      } else {
        finish();
        app.endModal('CANCELLED');
        const path = pts.map((q) => {
          const uv = view.toUV(q.x, q.y);
          return [uv.u, uv.v];
        });
        app.run('uv.select_lasso', { mode, path: JSON.stringify(path) }, { invoke: false, area: ctx.area });
      }
      return undefined;
    },
    onWheel(e) {
      if (kind !== 'CIRCLE') return;
      shapeSelect.radius = Math.max(2, Math.min(500, shapeSelect.radius * (e.deltaY > 0 ? 0.9 : 1.1)));
      view.draw();
    },
    onKey(e) {
      if (e.type !== 'keydown') return true;
      if (e.key === 'Escape' || e.key === 'Enter' || (kind === 'CIRCLE' && e.key === ' ')) return 'CANCELLED';
      if (kind === 'CIRCLE' && (e.key === '+' || e.key === '=')) shapeSelect.radius *= 1.1;
      if (kind === 'CIRCLE' && e.key === '-') shapeSelect.radius /= 1.1;
      view.draw();
      return true;
    },
    cancel() {
      finish();
    },
  });
  return 'RUNNING_MODAL';
}

/** Dragged shape selections started directly by a tool (no key press): returns false when not handled. */
export function runShapeSelect(view: { toUV(x: number, y: number): { u: number; v: number }; scale(): number; draw(): void }, kind: 'BOX' | 'LASSO', pts: { x: number; y: number }[], mode: SelMode, area: OpContext['area']) {
  if (kind === 'BOX') {
    const a = view.toUV(Math.min(pts[0].x, pts[1].x), Math.max(pts[0].y, pts[1].y)),
      b = view.toUV(Math.max(pts[0].x, pts[1].x), Math.min(pts[0].y, pts[1].y));
    app.run('uv.select_box', { xmin: a.u, xmax: b.u, ymin: a.v, ymax: b.v, mode }, { invoke: false, area });
  } else {
    const path = pts.map((q) => {
      const uv = view.toUV(q.x, q.y);
      return [uv.u, uv.v];
    });
    app.run('uv.select_lasso', { mode, path: JSON.stringify(path) }, { invoke: false, area });
  }
}

// picking operators take their location from the pointer when invoked
for (const id of ['uv.select', 'uv.select_loop', 'uv.select_edge_ring', 'uv.select_linked_pick', 'uv.shortest_path_pick']) {
  const op = operators.get(id)!;
  op.invoke = locInvoke(op.exec!);
}
