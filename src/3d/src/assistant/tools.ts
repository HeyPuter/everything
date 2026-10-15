// The assistant's tools: function schemas for the model and what each does.
// Building and changing the scene goes through run_script, which runs code
// against the app's bpy-style scripting API (the same one the Text Editor and
// Python Console use). A script that fails is rolled back, so the scene is
// never left half-changed; one that succeeds reports what it changed, with the
// new sizes and positions, so the model can check its work.

import type { App } from '../app/app';
import { operators } from '../app/app';
import type { DocumentData, ObjectData } from '../data/types';
import { constraintTypes } from '../eval/constraints';
import { modifierTypes } from '../eval/modifiers';
import { getNodeType, nodeTypes } from '../nodes/registry';
import { bridge, loadPython, runPythonText } from '../scripting/python';
import { formatValue, jsGlobals, output, runJavaScript } from '../scripting/runner';
import { Inspector } from './inspect';

type Obj = Record<string, unknown>;

export interface ToolResult {
  ok: boolean;
  content: string;
  /** The document changed. */
  changed?: boolean;
  /** A screenshot (data URL) the model should look at. */
  image?: string;
}

export interface ToolSpec {
  type: 'function';
  function: { name: string; description: string; parameters: Obj };
}

export const VIEWS = ['CURRENT', 'FRONT', 'BACK', 'LEFT', 'RIGHT', 'TOP', 'BOTTOM', 'ISOMETRIC', 'CAMERA'] as const;
export type CaptureView = (typeof VIEWS)[number];
export const SHADINGS = ['SOLID', 'MATERIAL', 'WIREFRAME'] as const;
export type CaptureShading = (typeof SHADINGS)[number];

export interface ViewOptions {
  view?: CaptureView;
  shading?: CaptureShading;
  /** 'ALL', 'SELECTED', 'NONE' (keep the framing) or object names. */
  frame?: 'ALL' | 'SELECTED' | 'NONE' | string[];
}

/** What the tools need from the page around the scene; missing when running without one (tests). */
export interface AssistantUI {
  /** A screenshot of the 3D Viewport (the user's view is restored afterwards). */
  capture(o: ViewOptions): Promise<string>;
  /** Changes the user's 3D Viewport; says what it did. */
  setView(o: ViewOptions): string;
}

export interface AssistantHost {
  app: App;
  ui?: AssistantUI;
}

export class ToolError extends Error {}

interface ToolDef {
  name: string;
  description: string;
  parameters: Obj;
  ui?: boolean;
  run(a: Obj, host: AssistantHost): Promise<ToolResult | string> | ToolResult | string;
}

const obj = (properties: Obj, required: string[] = []): Obj => ({ type: 'object', properties, required, additionalProperties: false });
const S = (description: string, extra: Obj = {}): Obj => ({ type: 'string', description, ...extra });

const FRAME: Obj = {
  description: '"ALL" fits every visible object, "SELECTED" the selection, "NONE" keeps the framing, or a list of object names to fit',
  anyOf: [{ type: 'string', enum: ['ALL', 'SELECTED', 'NONE'] }, { type: 'array', items: { type: 'string' } }],
};

const short = (s: string, max: number) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};
const cutLines = (s: string, max: number) => (s.length > max ? `${s.slice(0, max)}\n[…${s.length - max} more characters cut; print less]` : s);

// ---------------------------------------------------------------------------
// What a script changed

interface ObjState {
  name: string;
  type: string;
  transform: string;
  parent: string | null;
  data: string | null;
  geometry: unknown[];
  modifiers: string;
  constraints: string;
  materials: string;
  visibility: string;
  animation: string;
  other: string;
}

interface SceneState {
  objects: Map<string, ObjState>;
  materials: Map<string, string>;
  materialNames: Map<string, string>;
  scene: Record<string, string>;
  mode: string;
  active: string | null;
  selected: string;
}

function geometryRefs(d: DocumentData, ob: ObjectData): unknown[] {
  if (!ob.data) return [];
  if (ob.type === 'MESH') {
    const me = d.meshes[ob.data];
    return me ? [me, me.positions, me.indices, me.offsets, me.smooth, me.uvs] : [];
  }
  const tables: Partial<Record<string, Record<string, unknown>>> = { CURVE: d.curves, SURFACE: d.curves, FONT: d.curves, LIGHT: d.lights, CAMERA: d.cameras, ARMATURE: d.armatures, LATTICE: d.lattices };
  const t = tables[ob.type];
  const data = t?.[ob.data];
  return data ? [JSON.stringify(data, (_k, v) => (ArrayBuffer.isView(v) ? Array.from(v as unknown as ArrayLike<number>) : v))] : [];
}

function sceneState(d: DocumentData): SceneState {
  const objects = new Map<string, ObjState>();
  for (const ob of Object.values(d.objects)) {
    objects.set(ob.id, {
      name: ob.name,
      type: ob.type,
      transform: JSON.stringify([ob.location, ob.rotation_euler, ob.rotation_quaternion, ob.rotation_mode, ob.scale, ob.delta_location, ob.delta_rotation_euler, ob.delta_scale]),
      parent: ob.parent,
      data: ob.data,
      geometry: geometryRefs(d, ob),
      modifiers: JSON.stringify(ob.modifiers),
      constraints: JSON.stringify(ob.constraints),
      materials: JSON.stringify([ob.object_materials, ob.material_slots_link, ob.data && d.meshes[ob.data]?.materials, ob.data && (d.curves[ob.data] as unknown as { materials?: unknown })?.materials]),
      visibility: JSON.stringify([ob.hide, ob.hide_viewport, ob.hide_render, ob.hide_select, ob.display_type]),
      animation: JSON.stringify([ob.animation_data, ob.animation_data?.action ? d.actions[ob.animation_data.action] : null]),
      other: JSON.stringify([ob.rigid_body, ob.particle_systems, ob.field, ob.collision, ob.color, (ob as unknown as { custom?: unknown }).custom]),
    });
  }
  const materials = new Map<string, string>();
  const materialNames = new Map<string, string>();
  for (const m of Object.values(d.materials)) {
    materials.set(m.id, JSON.stringify(m));
    materialNames.set(m.id, m.name);
  }
  const s = d.scene;
  return {
    objects,
    materials,
    materialNames,
    scene: {
      'frame range': JSON.stringify([s.frame_start, s.frame_end, s.render.fps]),
      'current frame': String(s.frame_current),
      render: JSON.stringify(s.render),
      world: JSON.stringify(s.world ? d.worlds[s.world] : null),
      'scene camera': String(s.camera),
      collections: JSON.stringify(d.collections),
      '3D cursor': JSON.stringify(s.cursor),
      units: JSON.stringify(s.unit_settings),
      'rigid body world': JSON.stringify(s.rigidbody_world),
      compositing: JSON.stringify([s.use_nodes, s.compositing_node_group, s.compositor]),
      'timeline markers': JSON.stringify(s.timeline_markers),
    },
    mode: d.mode,
    active: s.active_object,
    selected: Object.values(d.objects)
      .filter((o) => o.select)
      .map((o) => o.id)
      .join(','),
  };
}

const ASPECTS: (keyof ObjState)[] = ['transform', 'parent', 'data', 'modifiers', 'constraints', 'materials', 'visibility', 'animation', 'other'];

/** What changed between two states, in words; with the lines of the objects added or changed. */
function describeChanges(before: SceneState, after: SceneState, ins: Inspector, d: DocumentData): { text: string; changed: boolean } {
  const q = JSON.stringify;
  const added: ObjectData[] = [];
  const changed: { ob: ObjectData; what: string[] }[] = [];
  const removed: string[] = [];
  for (const [id, a] of after.objects) {
    const b = before.objects.get(id);
    const ob = d.objects[id];
    if (!b) {
      added.push(ob);
      continue;
    }
    const what: string[] = [];
    if (a.name !== b.name) what.push(`renamed from ${q(b.name)}`);
    if (a.type !== b.type) what.push(`converted to ${a.type}`);
    if (a.geometry.length !== b.geometry.length || a.geometry.some((x, i) => x !== b.geometry[i])) what.push(ob.type === 'MESH' ? 'geometry' : 'data');
    for (const k of ASPECTS) if (k !== 'data' && a[k] !== b[k]) what.push(k === 'other' ? 'physics/custom properties' : k);
    if (a.data !== b.data && !what.includes('data') && !what.includes('geometry')) what.push('data');
    if (what.length) changed.push({ ob, what });
  }
  for (const [id, b] of before.objects) if (!after.objects.has(id)) removed.push(b.name);
  const lines: string[] = [];
  if (added.length) lines.push(`Added ${added.length} object${added.length === 1 ? '' : 's'}: ${added.slice(0, 30).map((o) => `${q(o.name)} (${o.type})`).join(', ')}${added.length > 30 ? ', …' : ''}`);
  if (removed.length) lines.push(`Removed: ${removed.slice(0, 30).map((x) => q(x)).join(', ')}${removed.length > 30 ? ', …' : ''}`);
  if (changed.length) lines.push(`Changed: ${changed.slice(0, 30).map((c) => `${q(c.ob.name)} (${c.what.join(', ')})`).join('; ')}${changed.length > 30 ? '; …' : ''}`);
  const matAdded = [...after.materials.keys()].filter((k) => !before.materials.has(k)).map((k) => after.materialNames.get(k)!);
  const matRemoved = [...before.materials.keys()].filter((k) => !after.materials.has(k)).map((k) => before.materialNames.get(k)!);
  const matChanged = [...after.materials.keys()].filter((k) => before.materials.has(k) && before.materials.get(k) !== after.materials.get(k)).map((k) => after.materialNames.get(k)!);
  if (matAdded.length) lines.push(`New materials: ${matAdded.map((x) => q(x)).join(', ')}`);
  if (matChanged.length) lines.push(`Materials changed: ${matChanged.map((x) => q(x)).join(', ')}`);
  if (matRemoved.length) lines.push(`Materials removed: ${matRemoved.map((x) => q(x)).join(', ')}`);
  const sceneChanged = Object.keys(after.scene).filter((k) => after.scene[k] !== before.scene[k]);
  if (sceneChanged.length) lines.push(`Scene settings changed: ${sceneChanged.join(', ')}`);
  if (after.mode !== before.mode) lines.push(`Mode is now ${after.mode}.`);
  const selection = after.active !== before.active || after.selected !== before.selected;
  const any = lines.length > 0;
  if (!any) lines.push(selection ? 'Only the selection changed.' : 'Nothing in the scene changed.');
  const show = [...added, ...changed.map((c) => c.ob)].slice(0, 25);
  if (show.length) {
    lines.push('Now:');
    for (const ob of show) lines.push(ins.objectLine(ob));
    const more = added.length + changed.length - show.length;
    if (more > 0) lines.push(`… and ${more} more; use get_scene or get_object for them.`);
  }
  return { text: lines.join('\n'), changed: any || selection };
}

// ---------------------------------------------------------------------------
// run_script

async function runScript(a: Obj, host: AssistantHost): Promise<ToolResult> {
  const app = host.app;
  const code = String(a.code ?? '');
  if (!code.trim()) throw new ToolError('code is empty.');
  const python = a.language === 'python';
  if (app.modal) throw new ToolError('The user is in the middle of an interactive tool in the viewport. Ask them to finish it (Enter) or cancel it (Esc), then try again.');
  if (python) {
    try {
      await loadPython();
    } catch (e) {
      throw new ToolError(`${(e as Error).message} Write the script in JavaScript instead.`);
    }
  }
  const ins = new Inspector(app);
  ins.settle();
  const before = sceneState(app.doc);
  const mark = app.undo.mark();
  const reports = app.reports.length;
  const printed: string[] = [];
  const push = output.push;
  // Printed lines go back to the model, not into the user's Python Console.
  output.push = (text: string, type = 'OUTPUT') => {
    for (const l of String(text).replace(/\n$/, '').split('\n')) printed.push(type === 'ERROR' ? `[error] ${l}` : type === 'INFO' ? `[warning] ${l}` : l);
  };
  const label = `Assistant: ${short(String(a.description ?? '') || 'Script', 40)}`;
  let r;
  try {
    r = python ? runPythonText(code, 'assistant.py', label) : runJavaScript(code, 'assistant.js', label);
  } finally {
    output.push = push;
  }
  const opReports = app.reports
    .slice(reports)
    .filter((x) => x.type === 'ERROR' || x.type === 'WARNING')
    .map((x) => `[${x.type.toLowerCase()}] ${x.message}`);
  const out = printed.length ? `Printed:\n${cutLines(printed.join('\n'), 8000)}` : '';
  if (!r.ok) {
    const where = r.line ? ` at line ${r.line}` : '';
    const line = r.line ? code.split('\n')[r.line - 1] : undefined;
    app.revertUndo(mark);
    ins.settle();
    return {
      ok: false,
      content: [`Error${where}: ${r.error}`, line ? `  ${r.line} | ${line.trim()}` : '', out, opReports.join('\n'), 'The script was rolled back: the scene is as it was before it ran. Fix the problem and run the whole script again.'].filter(Boolean).join('\n'),
    };
  }
  ins.settle();
  const diff = describeChanges(before, sceneState(app.doc), ins, app.doc);
  const evalErrors = [...app.graph.objects.values()].filter((ev) => ev.error).map((ev) => `[error] ${JSON.stringify(ev.ob.name)}: ${ev.error}`);
  if (a.dry_run === true) {
    app.revertUndo(mark);
    ins.settle();
    return { ok: true, content: ['The script ran as a dry run: its changes were undone, the scene is as it was.', out, [...opReports, ...evalErrors].join('\n'), diff.changed ? `It would have made these changes:\n${diff.text}` : ''].filter(Boolean).join('\n') };
  }
  return { ok: true, changed: diff.changed, content: ['The script ran.', out, [...opReports, ...evalErrors].join('\n'), diff.text].filter(Boolean).join('\n') };
}

// ---------------------------------------------------------------------------
// api_help

const fmtDefault = (v: unknown) => (typeof v === 'number' ? String(Number(v.toFixed(5))) : JSON.stringify(v));

function operatorHelp(idname: string, app: App): string {
  const op = operators.get(idname)!;
  const lines = [`bpy.ops.${idname}: ${op.label}${op.description ? ` — ${op.description}` : ''}`, `Can run now: ${app.poll(idname) ? 'yes' : 'no (its poll fails in the current context, e.g. wrong mode or nothing selected)'}`];
  const props = (op.props ?? []).filter((p) => !p.hidden);
  if (props.length) {
    lines.push('Properties (pass as an object, e.g. bpy.ops.' + idname + '({' + props[0].id + ': …})):');
    for (const p of props) {
      const range = p.min !== undefined || p.max !== undefined ? ` [${p.min ?? '-∞'}…${p.max ?? '∞'}]` : '';
      const items = p.items ? ` one of ${p.items.map((i) => i[0]).join(', ')}` : '';
      lines.push(`- ${p.id} (${p.type}${p.subtype && p.subtype !== 'none' ? `, ${p.subtype}` : ''}) = ${fmtDefault(p.default)}${range}${items}${p.label && p.label.toLowerCase() !== p.id.replace(/_/g, ' ') ? ` — ${p.label}` : ''}`);
    }
  } else lines.push('No properties.');
  return lines.join('\n');
}

function nodeHelp(idname: string): string {
  const def = getNodeType(idname)!;
  const sock = (s: { name: string; identifier: string; type: string; default?: unknown }) => `${JSON.stringify(s.name)}${s.identifier !== s.name ? ` (id ${s.identifier})` : ''} ${s.type}${s.default !== undefined ? ` = ${fmtDefault(s.default)}` : ''}`;
  const lines = [`${def.idname}: "${def.label}" (${def.treeTypes.join(', ')} trees)`];
  if (def.inputs.length) lines.push(`Inputs: ${def.inputs.map(sock).join('; ')}`);
  if (def.outputs.length) lines.push(`Outputs: ${def.outputs.map(sock).join('; ')}`);
  if (def.props.length) lines.push(`Properties (node.<id>): ${def.props.map((p) => `${p.id}${p.d !== undefined ? ` = ${fmtDefault(p.d)}` : ''}${p.items ? ` (${p.items.map((i) => i[0]).join('|')})` : ''}`).join(', ')}`);
  lines.push('Sockets are listed in order, unavailable ones included; which are available can depend on the properties (e.g. a Mix node\'s data_type).');
  return lines.join('\n');
}

function apiHelp(topic: string, app: App): string {
  const t = topic.trim().replace(/\(\)$/, '');
  if (!t) throw new ToolError('Give a topic.');
  const lower = t.toLowerCase();
  if (lower === 'operators' || t === 'bpy.ops') {
    const mods = new Map<string, number>();
    for (const k of operators.keys()) mods.set(k.split('.')[0], (mods.get(k.split('.')[0]) ?? 0) + 1);
    return `Operator modules (count): ${[...mods].sort().map(([m, c]) => `${m} (${c})`).join(', ')}\nAsk for "bpy.ops.<module>" to list one module's operators.`;
  }
  const opm = /^(?:bpy\.ops\.)?([a-z0-9_]+)(?:\.([a-z0-9_]+))?$/.exec(t);
  if (opm && (t.startsWith('bpy.ops.') || opm[2])) {
    const [, mod, name] = opm;
    if (name) {
      if (operators.has(`${mod}.${name}`)) return operatorHelp(`${mod}.${name}`, app);
    } else {
      const ops = [...operators.entries()].filter(([k]) => k.startsWith(`${mod}.`));
      if (ops.length) return `bpy.ops.${mod} (${ops.length}):\n${ops.map(([k, op]) => `- ${k.slice(mod.length + 1)}: ${op.label}`).join('\n')}`;
    }
    if (t.startsWith('bpy.ops.')) {
      const word = name ?? mod;
      const near = [...operators.keys()].filter((k) => k.includes(word)).slice(0, 20);
      throw new ToolError(`No operator ${t}.${near.length ? ` Similar: ${near.join(', ')}` : ''}`);
    }
  }
  const mod = /^modifiers?(?:[ .:]+([A-Za-z_]+))?$/i.exec(t);
  if (mod) {
    const type = mod[1]?.toUpperCase();
    if (!type) return `Modifier types (ob.modifiers.new(name, TYPE)):\n${Object.values(modifierTypes).map((m) => `- ${m.type}: ${m.label} (${m.category})`).join('\n')}`;
    const m = modifierTypes[type];
    if (!m) throw new ToolError(`No modifier type ${type}. Types: ${Object.keys(modifierTypes).join(', ')}`);
    return `${m.type} (${m.label}) settings and defaults:\n${Object.entries(m.defaults()).map(([k, v]) => `- ${k} = ${fmtDefault(v)}`).join('\n')}`;
  }
  const con = /^constraints?(?:[ .:]+([A-Za-z_]+))?$/i.exec(t);
  if (con) {
    const type = con[1]?.toUpperCase();
    if (!type) return `Constraint types (ob.constraints.new(TYPE)): ${Object.keys(constraintTypes).join(', ')}`;
    const c = constraintTypes[type] as unknown as { defaults?: () => Obj } | undefined;
    if (!c) throw new ToolError(`No constraint type ${type}. Types: ${Object.keys(constraintTypes).join(', ')}`);
    return `${type} settings and defaults:\n${Object.entries(c.defaults?.() ?? {}).map(([k, v]) => `- ${k} = ${fmtDefault(v)}`).join('\n')}`;
  }
  const nodes = /^nodes?(?:[ .:]+(.+))?$/i.exec(t);
  if (nodes) {
    const query = nodes[1]?.trim() ?? '';
    if (query && getNodeType(query)) return nodeHelp(query);
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const hits = Object.values(nodeTypes).filter((d) => !d.hidden && words.every((w) => `${d.idname} ${d.label} ${d.treeTypes.join(' ')}`.toLowerCase().includes(w)));
    if (!hits.length) throw new ToolError(`No node type matches "${query}".`);
    if (hits.length === 1) return nodeHelp(hits[0].idname);
    return `Node types${query ? ` matching "${query}"` : ''} (${hits.length}; nodes.new(idname)):\n${hits.slice(0, 150).map((d) => `- ${d.idname}: ${d.label} (${d.treeTypes.join(', ')})`).join('\n')}${hits.length > 150 ? '\n…' : ''}\nAsk for "node <idname>" to see its sockets.`;
  }
  if (getNodeType(t)) return nodeHelp(t);
  // Anything else is a JavaScript expression over the scripting globals.
  const g = jsGlobals();
  let v: unknown;
  try {
    v = new Function(...Object.keys(g), `"use strict"; return (${t});`)(...Object.values(g));
  } catch (e) {
    throw new ToolError(`Could not evaluate ${t}: ${(e as Error).message}. Topics: "operators", "bpy.ops.<module>", "bpy.ops.<module>.<name>", "modifiers", "modifier <TYPE>", "constraints", "nodes <words>", "node <idname>", or an expression such as D.objects['Cube'].data.`);
  }
  if (v === null || v === undefined || typeof v !== 'object') return `${t} = ${formatValue(v)} (${v === null ? 'null' : typeof v})`;
  const lines = [`${t}: ${bridge.typename(v)} ${short(formatValue(v), 300)}`];
  let names: string[] = [];
  try {
    names = bridge.dir(v);
  } catch {
    names = [];
  }
  const fields: string[] = [];
  const methods: string[] = [];
  for (const k of names.slice(0, 200)) {
    let x: unknown;
    try {
      x = (v as Obj)[k];
    } catch {
      continue;
    }
    if (typeof x === 'function') methods.push(k);
    else fields.push(`${k} = ${short(formatValue(x), 120)}`);
  }
  if (fields.length) lines.push(`Properties:\n${fields.map((f) => `- ${f}`).join('\n')}`);
  if (methods.length) lines.push(`Methods: ${methods.join(', ')}`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// tools

const TOOLS: ToolDef[] = [
  {
    name: 'get_scene',
    description: 'The whole scene: every object with its type, transform, size, bounds, materials and modifiers, the collection tree, data-blocks (materials, meshes, actions, images…), render settings and markers. The snapshot with each message already lists up to 60 objects; use this when there are more or you need the data-blocks.',
    parameters: obj({}),
    run: (_a, h) => new Inspector(h.app).sceneText(),
  },
  {
    name: 'get_object',
    description: "One object in full: transform, size and world bounds, parent and children, collections, mesh statistics, light or camera settings, material slots, every modifier and constraint with all its settings, keyframes, custom properties.",
    parameters: obj({ name: S('Object name') }, ['name']),
    run: (a, h) => {
      const ins = new Inspector(h.app);
      const ob = ins.findObject(String(a.name ?? ''));
      if (!ob) throw new ToolError(`No object named ${JSON.stringify(a.name)}. Objects: ${ins.objectsInOrder().slice(0, 60).map((o) => JSON.stringify(o.name)).join(', ')}`);
      return ins.objectText(ob);
    },
  },
  {
    name: 'get_material',
    description: 'A material: viewport settings, the objects using it, and its shader node tree (each node with the inputs that differ from their defaults, and the links).',
    parameters: obj({ name: S('Material name') }, ['name']),
    run: (a, h) => {
      const ins = new Inspector(h.app);
      const m = ins.findMaterial(String(a.name ?? ''));
      if (!m) throw new ToolError(`No material named ${JSON.stringify(a.name)}. Materials: ${Object.values(h.app.doc.materials).map((x) => JSON.stringify(x.name)).join(', ') || 'none'}`);
      return ins.materialText(m);
    },
  },
  {
    name: 'run_script',
    description:
      "Run a script against the app's bpy API to build or change anything in the scene: add and delete objects, set transforms, edit meshes, add modifiers, materials and shader nodes, lights, cameras, keyframes, world and render settings. JavaScript by default (see the system prompt for how it differs from Python). " +
      "print() output comes back to you. If the script throws, all its changes are rolled back and the error and line are returned; fix it and run the whole script again. On success the result lists the objects added and changed with their new sizes and bounds. Every change the assistant makes in one message is one undo step for the user.",
    parameters: obj(
      {
        code: S('The script'),
        language: S('Script language (default javascript). Python loads a runtime of about 10 MB the first time; use it only when the user asks for Python.', { enum: ['javascript', 'python'] }),
        description: S('What the script does, in a few words for the user (e.g. "Build the table legs")'),
        dry_run: { type: 'boolean', description: 'Run it, report what it printed and would change, then undo everything. For experiments, such as creating a node to inspect its sockets. Never throw on purpose to undo a script; use this.' },
      },
      ['code', 'description'],
    ),
    run: runScript,
  },
  {
    name: 'api_help',
    description:
      'Look up the scripting API of this app (it follows the `bpy` naming conventions, but not everything is there and details differ, so check here instead of guessing). Topics: "operators" (modules), "bpy.ops.mesh" (operators in a module), "bpy.ops.mesh.primitive_cylinder_add" (its properties, defaults and enum values), "modifiers" / "modifier BEVEL", "constraints" / "constraint TRACK_TO", "nodes noise texture" (search node types) / "node ShaderNodeBsdfPrincipled" (sockets), or any JavaScript expression such as "D.objects[\'Cube\'].data" or "C.scene.render" to list its properties with current values and its methods.',
    parameters: obj({ topic: S('What to look up') }, ['topic']),
    run: (a, h) => apiHelp(String(a.topic ?? ''), h.app),
  },
  {
    name: 'capture_view',
    description:
      "Take a screenshot of the 3D Viewport to see the scene, e.g. to check shapes, proportions, placement and materials after building. The user's own view is left as it was. Use view ISOMETRIC (a 3/4 perspective) for an overview, an axis view (orthographic) to check alignment, CAMERA to see the render framing.",
    parameters: obj({
      view: S('Viewpoint (default CURRENT: what the user sees)', { enum: [...VIEWS] }),
      shading: S('Viewport shading (default: the viewport\'s). MATERIAL shows material colors and textures with lighting.', { enum: [...SHADINGS] }),
      frame: FRAME,
    }),
    ui: true,
    run: async (a, h) => {
      const image = await h.ui!.capture(viewOptions(a));
      return { ok: true, content: 'Screenshot taken; it follows.', image };
    },
  },
  {
    name: 'set_view',
    description: "Change the user's 3D Viewport: point of view, framing and shading. Use it when the user asks to see something, or to show them the result.",
    parameters: obj({
      view: S('Viewpoint (CURRENT keeps it)', { enum: [...VIEWS] }),
      shading: S('Viewport shading', { enum: [...SHADINGS, 'RENDERED'] }),
      frame: FRAME,
    }),
    ui: true,
    run: (a, h) => h.ui!.setView(viewOptions(a)),
  },
];

function viewOptions(a: Obj): ViewOptions {
  const view = String(a.view ?? 'CURRENT').toUpperCase();
  if (!(VIEWS as readonly string[]).includes(view)) throw new ToolError(`view must be one of ${VIEWS.join(', ')}.`);
  const shading = a.shading === undefined ? undefined : String(a.shading).toUpperCase();
  if (shading !== undefined && ![...SHADINGS, 'RENDERED'].includes(shading)) throw new ToolError(`shading must be one of ${SHADINGS.join(', ')}.`);
  const f = a.frame;
  const frame = Array.isArray(f) ? f.map(String) : f === undefined ? undefined : (String(f).toUpperCase() as 'ALL' | 'SELECTED' | 'NONE');
  if (typeof frame === 'string' && !['ALL', 'SELECTED', 'NONE'].includes(frame)) throw new ToolError('frame must be ALL, SELECTED, NONE or a list of object names.');
  return { view: view as CaptureView, shading: shading as CaptureShading | undefined, frame };
}

/** Schemas for the model; the viewport tools only when there is a viewport. */
export function toolSpecs(host: AssistantHost): ToolSpec[] {
  return TOOLS.filter((t) => !t.ui || host.ui).map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
}

export async function runTool(host: AssistantHost, name: string, args: Obj): Promise<ToolResult> {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool || (tool.ui && !host.ui)) return { ok: false, content: `Error: there is no tool named ${name}.` };
  try {
    const r = await tool.run(args ?? {}, host);
    return typeof r === 'string' ? { ok: true, content: r } : r;
  } catch (e) {
    if (e instanceof ToolError) return { ok: false, content: `Error: ${e.message}` };
    console.error(e);
    return { ok: false, content: `Error: ${(e as Error)?.message ?? String(e)}` };
  }
}
