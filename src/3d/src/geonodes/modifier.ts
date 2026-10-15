// The Geometry Nodes modifier (type NODES): evaluates its node group on the incoming mesh.
import { registerModifier } from '../eval/modifiers';
import { preEvaluateHooks, type Depsgraph } from '../eval/depsgraph';
import type { EvalMesh, ModifierContext } from '../eval/types';
import type { DocumentData, ModifierBase, NodeGroupData, NodeTreeData, ObjectData, SocketValue } from '../data/types';
import { interfaceSocketType, findSocket, allSockets } from '../nodes/registry';
import { alwaysEvaluated, geoExecs, type EvalEnv, type Val } from './exec';
import { TreeEval, pruneCache, hash, coerce, FIELD_TYPES, type NodeCache, type EvalLog } from './evaluator';
import { GeometrySet, identity, adaptDomain, dataComps, type Component } from './geometry';
import { evalMeshToGeometry, geometryToEvalMesh, curveDataToCurves, materialSlots } from './convert';
import { curveObjectModifierInput } from './curves/curvedata';
import { greasePencilGeometry } from './curves/gpdata';
import { attributeField } from './inputs';
import { Field, ConstField } from './field';
import { storeOn } from './nodes/geometry';
import { isActiveViewer, VIEWER } from './nodes/output';
import { gnResults, viewerState, resultListeners } from './results';
import { fieldTypeOfEnum, type Domain, type FieldType } from './types';
import { hasDomain } from './nodes/common';

let currentDoc: DocumentData | null = null;
let currentGraph: Depsgraph | null = null;
preEvaluateHooks.push((graph, doc) => {
  currentDoc = doc;
  currentGraph = graph;
});

export const nodeGroupOf = (doc: DocumentData, m: ModifierBase): NodeGroupData | undefined => (typeof m.node_group === 'string' ? doc.node_groups[m.node_group] : undefined);

/** All trees used by a group (nested groups included). */
export function groupTrees(doc: DocumentData, tree: NodeTreeData, out = new Set<NodeTreeData>(), depth = 0): Set<NodeTreeData> {
  if (out.has(tree) || depth > 32) return out;
  out.add(tree);
  for (const n of tree.nodes) {
    const gid = n.props.node_tree as string | undefined;
    if (n.type === 'GeometryNodeGroup' && gid && doc.node_groups[gid]) groupTrees(doc, doc.node_groups[gid].tree, out, depth + 1);
  }
  return out;
}

function interfaceInputs(tree: NodeTreeData) {
  return (tree.interface ?? []).filter((i) => i.in_out === 'INPUT');
}

export function modifierDeps(doc: DocumentData, m: ModifierBase): string[] {
  const g = nodeGroupOf(doc, m);
  if (!g) return [];
  const out = new Set<string>();
  for (const t of groupTrees(doc, g.tree))
    for (const n of t.nodes) {
      const ex = geoExecs[n.type];
      for (const id of ex?.deps?.(n, doc) ?? []) out.add(id);
    }
  // object / collection inputs of the modifier
  for (const it of interfaceInputs(g.tree)) {
    const { type } = interfaceSocketType(it.socket_type);
    const v = m[it.identifier];
    if (type === 'OBJECT' && typeof v === 'string') out.add(v);
    if (type === 'COLLECTION' && typeof v === 'string') for (const id of collectionObjects(doc, v)) out.add(id);
  }
  return [...out];
}

export function collectionObjects(doc: DocumentData, cid: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const walk = (c: string, d = 0) => {
    const co = doc.collections[c];
    if (!co || seen.has(c) || d > 32) return;
    seen.add(c);
    for (const o of co.objects) if (doc.objects[o] && !out.includes(o)) out.push(o);
    for (const ch of co.children) walk(ch, d + 1);
  };
  walk(cid);
  return out;
}

function usesTime(doc: DocumentData, m: ModifierBase): boolean {
  const g = nodeGroupOf(doc, m);
  if (!g) return false;
  for (const t of groupTrees(doc, g.tree)) for (const n of t.nodes) if (geoExecs[n.type]?.timeDependent && !n.mute) return true;
  return false;
}

/** Whether this modifier currently displays its tree's active viewer. */
export function viewerActiveFor(doc: DocumentData, ob: ObjectData, m: ModifierBase): boolean {
  if (viewerState.objectId !== ob.id || viewerState.modifierId !== m.id) return false;
  const g = nodeGroupOf(doc, m);
  return !!g?.tree.nodes.some(isActiveViewer);
}

// ---------------------------------------------------------------------------
// Signatures of incoming meshes (typed array identities)

const arrIds = new WeakMap<object, number>();
let nextArr = 1;
const aid = (a: object | undefined | null) => {
  if (!a) return 0;
  let i = arrIds.get(a);
  if (!i) arrIds.set(a, (i = nextArr++));
  return i;
};
function meshSig(m: EvalMesh) {
  return [m.positions, m.offsets, m.indices, m.uvs, m.smooth, m.material_index, m.sharp, m.creases, m.seams, m.colors, m.looseEdges, m.pointRadius, ...(m.weights ?? [])].map(aid).join('.');
}

// ---------------------------------------------------------------------------
// Environment

function makeEnv(doc: DocumentData, ob: ObjectData, graph: Depsgraph, frame: number, render: boolean): EvalEnv {
  const self = graph.get(ob.id)?.world.elements ?? Array.from(identity());
  const geoCache = new Map<string, GeometrySet | null>();
  return {
    doc,
    ob,
    selfWorld: self,
    frame,
    fps: doc.scene.render.fps / (doc.scene.render.fps_base || 1),
    render,
    objectGeometry(id) {
      if (geoCache.has(id)) return geoCache.get(id)!;
      const ev = graph.get(id);
      const o = doc.objects[id];
      let g: GeometrySet | null = null;
      if (ev && o) {
        const cu = o.type === 'CURVE' && o.data ? doc.curves[o.data] : undefined;
        const r = gnResults.get(id);
        if (r && ev.mesh && r.evalMesh === ev.mesh) g = r.geometry;
        else if (cu && !cu.bevel_depth && !cu.extrude && !(o.modifiers ?? []).length) g = new GeometrySet(undefined, undefined, curveDataToCurves(cu));
        else if (o.type === 'GREASEPENCIL') {
          g = new GeometrySet();
          g.greasePencil = greasePencilGeometry(doc, o, frame) ?? undefined;
        } else if (ev.mesh) g = evalMeshToGeometry(ev.mesh, o.type === 'MESH' && o.data ? doc.meshes[o.data] : null);
        else g = GeometrySet.empty();
        if (g.mesh && o.type === 'MESH' && o.data && !g.mesh.materials.length) {
          const mm = g.mesh.copy();
          mm.materials = materialSlots(doc, o);
          g = g.with(mm);
        }
      }
      geoCache.set(id, g);
      return g;
    },
    objectWorld: (id) => graph.get(id)?.world.elements ?? null,
    collectionObjects: (cid) => collectionObjects(doc, cid),
    objectSig: (id) => {
      const ev = graph.get(id);
      return ev ? `${id}:${ev.geomVersion}:${ev.world.elements.map((x) => x.toFixed(5)).join(',')}` : `${id}:-`;
    },
  };
}

// ---------------------------------------------------------------------------
// Evaluation

const caches = new Map<string, NodeCache>();
let generation = 0;

export interface GroupEvaluation {
  geometry: GeometrySet;
  outputs: Record<string, Val>;
  viewer?: GeometrySet;
  viewerDomain?: Domain;
  log: EvalLog;
}

/** Group input values supplied by a modifier (or defaults). */
export function modifierInputValue(tree: NodeTreeData, m: ModifierBase, identifier: string, inputGeometry: GeometrySet): Val {
  const items = interfaceInputs(tree);
  const it = items.find((i) => i.identifier === identifier);
  if (!it) return undefined;
  const { type } = interfaceSocketType(it.socket_type);
  if (type === 'GEOMETRY') return items.find((i) => interfaceSocketType(i.socket_type).type === 'GEOMETRY') === it ? inputGeometry : GeometrySet.empty();
  if (FIELD_TYPES.has(type) && m[`${identifier}_use_attribute`]) {
    const name = String(m[`${identifier}_attribute_name`] ?? '');
    return name ? attributeField(name, type as FieldType) : new ConstField(type as FieldType, 0);
  }
  const v = m[identifier] as SocketValue | undefined;
  return coerce(v === undefined ? it.default_value : v, type);
}

/** Evaluate a node group for an object's modifier. */
export function evaluateGroup(group: NodeGroupData, m: ModifierBase, env: EvalEnv, input: GeometrySet, inputSig: string, cacheKey: string, withViewer: boolean): GroupEvaluation {
  let cache = caches.get(cacheKey);
  if (!cache) caches.set(cacheKey, (cache = new Map()));
  const log: EvalLog = {
    warnings: new Map(),
    executed: 0,
    generation: ++generation,
  };
  const tree = group.tree;
  const root = new TreeEval(
    env,
    tree,
    `${cacheKey}`,
    (id) => modifierInputValue(tree, m, id, input),
    (id) => {
      const it = interfaceInputs(tree).find((i) => i.identifier === id);
      if (it && interfaceSocketType(it.socket_type).type === 'GEOMETRY') return inputSig;
      return JSON.stringify([m[id] ?? null, m[`${id}_use_attribute`] ?? null, m[`${id}_attribute_name`] ?? null, it?.default_value ?? null]);
    },
    cache,
    log,
  );
  const outputs = root.groupOutputs();
  for (const n of tree.nodes) if (alwaysEvaluated.has(n.type) && !n.mute) root.nodeOutputs(n);
  const outItems = (tree.interface ?? []).filter((i) => i.in_out === 'OUTPUT');
  const geoItem = outItems.find((i) => interfaceSocketType(i.socket_type).type === 'GEOMETRY');
  let geometry = geoItem && outputs[geoItem.identifier] instanceof GeometrySet ? (outputs[geoItem.identifier] as GeometrySet) : GeometrySet.empty();
  // non-geometry outputs stored as attributes (Output Attributes panel)
  for (const it of outItems) {
    const { type } = interfaceSocketType(it.socket_type);
    const name = String(m[`${it.identifier}_attribute_name`] ?? '');
    if (!name || !FIELD_TYPES.has(type)) continue;
    const v = outputs[it.identifier];
    const f = v instanceof Field ? v : new ConstField(type as FieldType, (v ?? 0) as number);
    const domain = ((it as { attribute_domain?: string }).attribute_domain ?? 'POINT') as Domain;
    geometry = geometry.map((c) => storeOn(c, domain, name, type as FieldType, f));
  }
  let viewer: GeometrySet | undefined;
  let viewerDomain: Domain | undefined;
  if (withViewer) {
    const vn = tree.nodes.find(isActiveViewer);
    if (vn) {
      const socks = allSockets(vn, root.sctx).inputs;
      const gs = socks.find((s) => s.identifier === 'Geometry');
      const vs = socks.find((s) => s.identifier === 'Value');
      const gv = gs ? root.inputValue(vn, gs) : undefined;
      viewer = gv instanceof GeometrySet ? gv : GeometrySet.empty();
      const dom = String(vn.props.domain ?? 'AUTO');
      if (vs && root.links(vn.id, 'Value').length) {
        const t = fieldTypeOfEnum(vn.props.data_type ?? 'FLOAT');
        const v = root.inputValue(vn, vs);
        const f = v instanceof Field ? v : new ConstField(t, (v ?? 0) as number);
        viewer = viewer.map((c: Component) => {
          const d: Domain = dom !== 'AUTO' && hasDomain(c, dom as Domain) ? (dom as Domain) : c.kind === 'INSTANCES' ? 'INSTANCE' : 'POINT';
          viewerDomain = d;
          return storeOn(c, d, '.viewer', t, f);
        });
      }
    }
  }
  pruneCache(cache, generation);
  return { geometry, outputs, viewer, viewerDomain, log };
}

/** Drop node caches of modifiers that no longer exist. */
export function pruneModifierCaches(doc: DocumentData) {
  const live = new Set<string>();
  for (const ob of Object.values(doc.objects)) for (const m of ob.modifiers) if (m.type === 'NODES') live.add(`${ob.id}/${m.id}`);
  for (const k of caches.keys()) if (!live.has(k)) caches.delete(k);
}

const VIEWER_COLOR = '.viewer_color';

/** Display colors of the viewed attribute (values clamped to 0..1, vectors as RGB). */
function viewerColors(g: GeometrySet): GeometrySet {
  const m = g.mesh;
  const a = m?.attrs.get('.viewer');
  if (!m || !a) return g;
  const data = a.domain === 'FACE' || a.domain === 'EDGE' ? adaptDomain(m, a.data, a.type, a.domain, 'CORNER') : a.data;
  const domain = a.domain === 'FACE' || a.domain === 'EDGE' ? 'CORNER' : a.domain;
  const comps = dataComps(a.type);
  const n = data.length / comps;
  const col = new Float32Array(n * 4);
  const c01 = (x: number) => Math.max(0, Math.min(1, x));
  for (let i = 0; i < n; i++) {
    if (comps === 1) col[i * 4] = col[i * 4 + 1] = col[i * 4 + 2] = c01(data[i]);
    else for (let k = 0; k < 3; k++) col[i * 4 + k] = c01(data[i * comps + k]);
    col[i * 4 + 3] = 1;
  }
  const mm = m.copy();
  mm.attrs.set(VIEWER_COLOR, { domain, type: 'FLOAT_COLOR', data: col });
  return g.with(mm);
}

let nameHook: (() => string) | null = null;
/** UI layer hook naming new modifiers ("GeometryNodes", made unique per object). */
export function setModifierNameHook(fn: () => string) {
  nameHook = fn;
}

registerModifier({
  type: 'NODES',
  label: 'Geometry Nodes',
  category: 'GENERATE',
  icon: 'geometry_nodes',
  supportsEditMode: true,
  defaults: () => ({
    node_group: null,
    ...(nameHook ? { name: nameHook() } : {}),
  }),
  deps: (m) => (currentDoc ? modifierDeps(currentDoc, m) : []),
  timeDependent: (m) => (currentDoc ? usesTime(currentDoc, m) : false),
  signature: (m, { doc, ob }) => {
    const g = nodeGroupOf(doc, m);
    if (!g) return 'none';
    const trees = [...groupTrees(doc, g.tree)].map((t) => JSON.stringify(t));
    const viewer = viewerActiveFor(doc, ob, m) ? 'V' : '';
    // object/collection membership and material slots referenced by the tree
    const colls: string[] = [];
    for (const t of groupTrees(doc, g.tree))
      for (const n of t.nodes) if (n.type === 'GeometryNodeCollectionInfo' && typeof n.inputs.Collection === 'string') colls.push(collectionObjects(doc, n.inputs.Collection).join(','));
    return hash(`${trees.join('|')}|${viewer}|${colls.join(';')}|${JSON.stringify(materialSlots(doc, ob))}`);
  },
  apply: (mesh: EvalMesh, m: ModifierBase, ctx: ModifierContext): EvalMesh => {
    const group = nodeGroupOf(ctx.doc, m);
    if (!group) return mesh;
    if (group.tree.type !== 'GEOMETRY') throw new Error('Node group is not a geometry node tree');
    const t0 = performance.now();
    const graph = ctx.graph ?? currentGraph;
    const env = makeEnv(ctx.doc, ctx.ob, graph, ctx.frame, ctx.render);
    const cin = curveObjectModifierInput(ctx.doc, ctx.ob, m.id, ctx.render);
    const input = cin ? new GeometrySet(undefined, undefined, cin) : evalMeshToGeometry(mesh, ctx.source);
    const withViewer = !ctx.render && viewerActiveFor(ctx.doc, ctx.ob, m);
    const r = evaluateGroup(group, m, env, input, meshSig(mesh), `${ctx.ob.id}/${m.id}`, withViewer);
    const shown = r.viewer ? viewerColors(r.viewer) : r.geometry;
    const source = ctx.source;
    const out = geometryToEvalMesh(shown, {
      uvName: source?.uv_map_name,
      colorName: r.viewer ? VIEWER_COLOR : source?.color_attributes[source.active_color_index]?.name,
      vertexGroups: mesh.vertex_groups,
      slots: materialSlots(ctx.doc, ctx.ob),
    });
    gnResults.set(ctx.ob.id, {
      modifierId: m.id,
      evalMesh: out,
      geometry: r.geometry,
      viewer: r.viewer,
      viewerDomain: r.viewerDomain,
      warnings: r.log.warnings,
      ms: performance.now() - t0,
      executed: r.log.executed,
    });
    for (const fn of resultListeners) fn();
    return out;
  },
});

export { VIEWER, findSocket };
