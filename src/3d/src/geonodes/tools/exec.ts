// Running a geometry node group as a tool: the group takes the mesh of each edited object (with
// its Edit Mode selection), and its result replaces the mesh data (geometry.execute_node_group).
// Tools are offered in the 3D viewport's Node Tools menu for the modes and object types they
// are made for.
import { Matrix4, Euler, Quaternion, Vector3 } from 'three';
import { app, onAppReady, registerOperators } from '../../app/app';
import type { DocumentData, MeshData, ModifierBase, NodeGroupData, ObjectData } from '../../data/types';
import { baseEvalMesh } from '../../eval/depsgraph';
import type { EvalMesh } from '../../eval/types';
import { evalMeshToGeometry, geometryToEvalMesh, materialSlots, UV_DEFAULT } from '../convert';
import { evaluateGroup, makeEnv } from '../modifier';
import { EdgeHash, isInternal, readAttribute, type MeshComponent } from '../geometry';
import { eulerToQuat } from '../rotmath';
import type { AttrArray } from '../types';
import type { AttributeType, MeshAttribute } from '../../data/types';
import type { ToolEnv } from '../exec';
import { syncModifierInputs } from '../editor';
import { modeMenus } from '../../editors/view3d/modemenus';
import type { MenuItem } from '../../ui/menu';
import { activeView3D } from '../../editors/view3d/view3d';
import { active as editActive } from '../../modes/editmesh/context';
import { TOOL_SELECTION } from './nodes';

type ToolMode = ToolEnv['mode'];

/** Mode of the app as a tool mode (null when tools do not apply). */
export function toolMode(doc: DocumentData = app.doc): ToolMode | null {
  return doc.mode === 'OBJECT' ? 'OBJECT' : doc.mode === 'EDIT' ? 'EDIT' : doc.mode === 'SCULPT' ? 'SCULPT' : null;
}

/** Whether a tool group is offered in a mode for an object type. */
export function toolApplies(g: NodeGroupData, mode: ToolMode, type: string): boolean {
  if (!g.is_tool || g.tree.type !== 'GEOMETRY') return false;
  const modeOk = mode === 'OBJECT' ? g.is_mode_object !== false : mode === 'EDIT' ? g.is_mode_edit !== false : g.is_mode_sculpt !== false;
  const typeOk = type === 'MESH' ? g.is_type_mesh !== false : type === 'CURVES' ? !!g.is_type_curve : type === 'POINTCLOUD' ? !!g.is_type_pointcloud : false;
  return modeOk && typeOk;
}

/** Tool groups of the file. */
export const toolGroups = (doc: DocumentData = app.doc) => Object.values(doc.node_groups).filter((g) => g.is_tool && g.tree.type === 'GEOMETRY');

/** Write an evaluated mesh into mesh data (topology, UVs, smoothing, edges flags). */
export function writeMesh(me: MeshData, m: EvalMesh) {
  const sameTopology =
    m.positions.length === me.positions.length && m.offsets.length === me.offsets.length && m.indices.length === me.indices.length && m.indices.every((v, i) => v === me.indices[i]);
  me.positions = new Float32Array(m.positions);
  me.offsets = new Uint32Array(m.offsets);
  me.indices = new Uint32Array(m.indices);
  me.uvs = new Float32Array(m.uvs);
  me.normals = new Float32Array(m.normals);
  me.smooth = m.smooth ? new Uint8Array(m.smooth) : undefined;
  me.material_index = m.material_index ? new Uint16Array(m.material_index) : undefined;
  me.seams = m.seams ? new Uint32Array(m.seams) : undefined;
  me.sharp = m.sharp ? new Uint32Array(m.sharp) : undefined;
  me.creases = m.creases ? new Float32Array(m.creases) : undefined;
  me.loose_edges = m.looseEdges?.length ? new Uint32Array(m.looseEdges) : undefined;
  me.custom_normals = m.custom_normals ? new Float32Array(m.custom_normals) : undefined;
  if (!sameTopology) {
    // per-element data the tool does not output no longer matches the elements
    me.bevel_weight_edge = me.bevel_weight_vert = me.crease_vert = undefined;
    me.quad_flip = me.face_strength = undefined;
    me.skin_vertices = undefined;
    me.sculpt_mask = undefined;
    me.sculpt_face_set = undefined;
    me.hide_poly = undefined;
    me.uv_select = me.uv_pin = me.uv_hide = undefined;
  }
  if (m.weights && m.vertex_groups) me.weights = m.weights.map((w) => new Float32Array(w));
  me.shape_keys = [];
  me.hide_vert = undefined;
  me.color_attributes = m.colors ? [{ name: me.color_attributes[me.active_color_index]?.name ?? 'Color', domain: 'CORNER', data: new Float32Array(m.colors) }] : [];
}

/** Names the mesh keeps in its own layers rather than as generic attributes. */
const BUILTIN = new Set(['position', 'sharp_face', 'material_index', 'sharp_edge', 'custom_normal', 'crease_edge', UV_DEFAULT]);

/**
 * Write the generic attributes of a tool's output mesh into mesh data (extra UV maps go back to
 * the UV map list); `mesh` must be the mesh the evaluated arrays were made from.
 */
export function writeAttributes(me: MeshData, mesh: MeshComponent) {
  if (mesh.positions.length !== me.positions.length || mesh.corners.length !== me.indices.length) return;
  const skip = new Set([...BUILTIN, me.uv_map_name, ...me.vertex_groups.map((g) => g.name), ...me.color_attributes.map((c) => c.name)]);
  const uvNames = new Set((me.uv_layers_extra ?? []).map((u) => u.name));
  const uvExtra: { name: string; data: Float32Array }[] = [];
  const list: MeshAttribute[] = [];
  const nc = mesh.cornerCount;
  let edgeOf: ((k: number) => number) | null = null;
  for (const [name, a] of mesh.attrs) {
    if (isInternal(name) || skip.has(name) || a.type === 'FLOAT_COLOR') continue;
    if (uvNames.has(name) && a.domain === 'CORNER' && a.type === 'FLOAT2') {
      uvExtra.push({ name, data: new Float32Array(a.data) });
      continue;
    }
    if (a.domain !== 'POINT' && a.domain !== 'EDGE' && a.domain !== 'FACE' && a.domain !== 'CORNER') continue;
    // rotations are Euler triples here, quaternions (w, x, y, z) in mesh data
    const quat = a.type === 'QUATERNION';
    const w = quat ? 4 : a.type === 'FLOAT_VECTOR' ? 3 : a.type === 'FLOAT2' ? 2 : a.type === 'FLOAT4X4' ? 16 : 1;
    let src = a.data;
    if (quat) {
      const n = src.length / 3;
      const q = new Float32Array(n * 4);
      for (let i = 0; i < n; i++) q.set(eulerToQuat(src[i * 3], src[i * 3 + 1], src[i * 3 + 2]), i * 4);
      src = q;
    }
    let data: AttrArray = src.slice();
    if (a.domain === 'EDGE') {
      // stored per face corner (the edge starting there), then per loose edge
      if (!edgeOf) {
        const topo = mesh.topology();
        const hash = new EdgeHash(topo.edgeCount);
        for (let e = 0; e < topo.edgeCount; e++) hash.getOrAdd(topo.edges[e * 2], topo.edges[e * 2 + 1], e);
        const loose = me.loose_edges ?? new Uint32Array(0);
        edgeOf = (k) => (k < nc ? topo.cornerEdge[k] : hash.get(loose[(k - nc) * 2], loose[(k - nc) * 2 + 1]));
      }
      const n = nc + (me.loose_edges?.length ?? 0) / 2;
      data = new (src.constructor as { new (n: number): AttrArray })(n * w);
      for (let k = 0; k < n; k++) {
        const e = edgeOf(k);
        if (e >= 0) for (let j = 0; j < w; j++) data[k * w + j] = src[e * w + j];
      }
    }
    list.push({ name, domain: a.domain, data_type: a.type as AttributeType, data: data as MeshAttribute['data'] });
  }
  me.attributes = list;
  if (uvExtra.length || me.uv_layers_extra) me.uv_layers_extra = uvExtra.length ? uvExtra : undefined;
}

/** Tool environment for an object: cursor in its local space, active element, pointer and view. */
export function toolEnvFor(doc: DocumentData, ob: ObjectData, mode: ToolMode): ToolEnv {
  const world = app.graph.get(ob.id)?.world ?? new Matrix4();
  const inv = world.clone().invert();
  const c = doc.scene.cursor;
  const loc = new Vector3(...c.location).applyMatrix4(inv);
  const q = new Quaternion().setFromRotationMatrix(new Matrix4().extractRotation(inv)).multiply(new Quaternion().setFromEuler(new Euler(...c.rotation_euler)));
  const e = new Euler().setFromQuaternion(q);
  const env: ToolEnv = { mode, cursor: { location: [loc.x, loc.y, loc.z], rotation: [e.x, e.y, e.z] } };
  if (mode === 'EDIT' && editActive.objectId === ob.id && editActive.kind && editActive.index >= 0)
    env.active = { domain: editActive.kind === 'VERT' ? 'POINT' : editActive.kind === 'EDGE' ? 'EDGE' : 'FACE', index: editActive.index };
  const v = activeView3D() as unknown as { el: HTMLElement; camera?: { matrixWorldInverse: Matrix4; projectionMatrix: Matrix4; isOrthographicCamera?: boolean } } | null;
  if (v?.el) {
    const r = v.el.getBoundingClientRect();
    env.mouse = { x: Math.round(app.pointer.x - r.left), y: Math.round(r.bottom - app.pointer.y), width: Math.round(r.width), height: Math.round(r.height) };
    const cam = v.camera;
    if (cam) env.view = { view: [...cam.matrixWorldInverse.clone().multiply(world).elements], projection: [...cam.projectionMatrix.elements], ortho: !!cam.isOrthographicCamera };
  }
  return env;
}

/** Run a tool group on one mesh object. Returns an error message, or null. */
export function runTool(doc: DocumentData, ob: ObjectData, g: NodeGroupData, mode: ToolMode, inputs: Record<string, unknown> = {}): string | null {
  if (ob.type !== 'MESH' || !ob.data || !doc.meshes[ob.data]) return `"${ob.name}" is not a mesh`;
  const me = doc.meshes[ob.data];
  if (Object.values(doc.objects).filter((o) => o.data === me.id).length > 1) return `"${ob.name}" shares its mesh with other objects`;
  let input = evalMeshToGeometry(baseEvalMesh(me, mode === 'EDIT'), me);
  if (mode === 'EDIT' && input.mesh) {
    const mm = input.mesh.copy();
    const nv = me.positions.length / 3;
    const sel = new Uint8Array(nv);
    if (me.select_vert?.length === nv) sel.set(me.select_vert);
    mm.attrs.set(TOOL_SELECTION, { domain: 'POINT', type: 'BOOLEAN', data: sel });
    input = input.with(mm);
  }
  const m = { id: 'tool', name: g.name, type: 'NODES', node_group: g.id, show_viewport: true } as unknown as ModifierBase;
  syncModifierInputs(m, g);
  Object.assign(m, inputs);
  const env = { ...makeEnv(doc, ob, app.graph, doc.scene.frame_current, false), tool: toolEnvFor(doc, ob, mode) };
  const r = evaluateGroup(g, m, env, input, `tool:${Math.random()}`, `tool/${ob.id}/${g.id}`, false);
  const errors = [...r.log.warnings.entries()].flatMap(([k, msgs]) => msgs.filter((x) => r.log.kinds?.get(`${k}\n${x}`) === 'ERROR'));
  if (errors.length) return errors[0];
  const out = geometryToEvalMesh(r.geometry, { uvName: me.uv_map_name, vertexGroups: me.vertex_groups, slots: materialSlots(doc, ob) });
  writeMesh(me, out);
  if (r.geometry.mesh) writeAttributes(me, r.geometry.mesh);
  const nv = me.positions.length / 3;
  const sel = r.geometry.mesh ? readAttribute(r.geometry.mesh, TOOL_SELECTION, 'POINT') : undefined;
  me.select_vert = sel && sel.data.length === nv ? Uint8Array.from(sel.data as ArrayLike<number>, (x) => (x ? 1 : 0)) : mode === 'EDIT' ? new Uint8Array(nv) : undefined;
  app.graph.invalidate(ob.id);
  return null;
}

/** Objects a tool runs on in the current mode. */
function toolObjects(): ObjectData[] {
  const mode = toolMode();
  if (mode === 'EDIT') return app.editObjects().filter((o) => o.type === 'MESH');
  if (mode === 'SCULPT') return app.activeObject ? [app.activeObject] : [];
  return app.selectedObjects().filter((o) => o.type === 'MESH');
}

const findGroup = (p: Record<string, unknown>) => toolGroups().find((g) => g.id === p.session_uid) ?? toolGroups().find((g) => g.name === p.name);

registerOperators([
  {
    idname: 'geometry.execute_node_group',
    label: 'Run Node Tool',
    description: 'Run a geometry node group made as a tool on the selected objects (in Edit Mode: on the edited meshes, with their selection)',
    props: [
      { id: 'name', label: 'Name', type: 'string', default: '' },
      { id: 'session_uid', label: 'Session UID', type: 'string', default: '', hidden: true },
      { id: 'inputs', label: 'Inputs', type: 'string', default: '', hidden: true },
    ],
    poll: () => !!toolMode() && toolObjects().length > 0,
    exec: (_ctx, p) => {
      const g = findGroup(p);
      const mode = toolMode();
      if (!g || !mode) {
        app.report('ERROR', `No node tool named "${String(p.name ?? '')}"`);
        return 'CANCELLED';
      }
      let inputs: Record<string, unknown> = {};
      try {
        inputs = p.inputs ? JSON.parse(String(p.inputs)) : {};
      } catch {
        app.report('ERROR', 'The tool inputs are not valid JSON');
        return 'CANCELLED';
      }
      let ran = 0;
      for (const ob of toolObjects()) {
        if (!toolApplies(g, mode, 'MESH')) continue;
        const err = runTool(app.doc, ob, g, mode, inputs);
        if (err) app.report('ERROR', `${g.name}: ${err}`);
        else ran++;
      }
      if (!ran) return 'CANCELLED';
      app.changed('doc', 'geometry');
    },
  },
]);

// ---------------------------------------------------------------------------
// 3D viewport: a Node Tools menu with the tools for the current mode

function toolsMenu(): MenuItem[] {
  const mode = toolMode();
  const type = app.activeObject?.type === 'MESH' ? 'MESH' : (app.activeObject?.type ?? '');
  if (!mode) return [];
  const list = toolGroups()
    .filter((g) => toolApplies(g, mode, type))
    .sort((a, b) => a.name.localeCompare(b.name));
  return list.map((g) => ({ label: g.name, op: 'geometry.execute_node_group', props: { name: g.name, session_uid: g.id }, icon: 'geometry_nodes' }));
}

onAppReady(() => {
  for (const mode of ['OBJECT', 'EDIT', 'SCULPT']) {
    const prev = modeMenus[mode] ?? {};
    const header = prev.header;
    modeMenus[mode] = {
      ...prev,
      header: () => {
        const base = header?.() ?? [];
        return toolsMenu().length ? [...base, ['Node Tools', toolsMenu] as [string, () => MenuItem[]]] : base;
      },
    };
  }
});
