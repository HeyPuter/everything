// Line rendering operators: line sets (add / remove / copy / paste / move), line styles and
// their modifiers, Fill Range by Selection, and edge / face marks in mesh Edit Mode.
import { app, registerOperators, type OpContext } from '../app/app';
import { withEdit } from '../modes/editmesh/context';
import { edgeKey } from '../modes/editmesh/meshedit';
import type { DocumentData } from '../data/types';
import { activeLineSet, addLineStyle, freestyleSettings, lineStyleOf, modifierList, newLineSet, newLineStyleModifier, uniqueIn, MODIFIER_TYPES, type ModifierKind } from './defaults';
import { linestyleTable, type LineSet, type LineStyleModifier } from './types';

const editPoll = (ctx: OpContext) => ctx.doc.mode === 'EDIT' && app.activeObject?.type === 'MESH';

let lineSetClipboard: LineSet | null = null;

const KINDS: [string, string][] = [
  ['COLOR', 'Color'],
  ['ALPHA', 'Alpha'],
  ['THICKNESS', 'Thickness'],
  ['GEOMETRY', 'Geometry'],
];
const kindOf = (k: unknown): ModifierKind => String(k ?? 'COLOR').toLowerCase() as ModifierKind;

/** The modifier an operator acts on (kind + index in the active line style), or null. */
function targetModifier(doc: DocumentData, p: Record<string, unknown>) {
  const ls = lineStyleOf(doc, activeLineSet(doc));
  if (!ls) return null;
  const list = modifierList(ls, kindOf(p.modifier_type));
  const i = Math.round(Number(p.index ?? 0));
  return list[i] ? { ls, list, i, m: list[i] } : null;
}

const modifierTarget = [
  { id: 'modifier_type', label: 'Modifier Type', type: 'enum' as const, default: 'COLOR', items: KINDS, hidden: true },
  { id: 'index', label: 'Index', type: 'int' as const, default: 0, min: 0, hidden: true },
];

function addModifierOp(kind: ModifierKind, idname: string, label: string, description: string) {
  return {
    idname,
    label,
    description,
    props: [{ id: 'type', label: 'Type', type: 'enum' as const, default: MODIFIER_TYPES[kind][0][0], items: MODIFIER_TYPES[kind] }],
    poll: (ctx: OpContext) => !!lineStyleOf(ctx.doc, activeLineSet(ctx.doc)),
    exec: (ctx: OpContext, p: Record<string, unknown>) => {
      const ls = lineStyleOf(ctx.doc, activeLineSet(ctx.doc));
      if (!ls) return 'CANCELLED' as const;
      const list = modifierList(ls, kind);
      const m = newLineStyleModifier(kind, String(p.type));
      m.name = uniqueIn(list.map((x) => x.name), m.name);
      list.push(m);
    },
  };
}

registerOperators([
  {
    idname: 'scene.freestyle_lineset_add',
    label: 'Add Line Set',
    description: 'Add a line set with its own line style to the view layer',
    poll: () => true,
    exec: (ctx) => {
      const fs = freestyleSettings(ctx.doc);
      const style = addLineStyle(ctx.doc, 'LineStyle');
      const names = fs.linesets.map((s) => s.name);
      let n = fs.linesets.length + 1;
      while (names.includes(`LineSet ${n}`)) n++;
      fs.linesets.push(newLineSet(fs.linesets.length ? `LineSet ${n}` : 'LineSet', style.id));
      fs.active_lineset_index = fs.linesets.length - 1;
    },
  },
  {
    idname: 'scene.freestyle_lineset_remove',
    label: 'Remove Line Set',
    description: 'Remove the active line set',
    poll: (ctx) => !!activeLineSet(ctx.doc),
    exec: (ctx) => {
      const fs = freestyleSettings(ctx.doc);
      if (!fs.linesets.length) return 'CANCELLED';
      fs.linesets.splice(fs.active_lineset_index, 1);
      fs.active_lineset_index = 0;
    },
  },
  {
    idname: 'scene.freestyle_lineset_copy',
    label: 'Copy Line Set',
    description: 'Copy the active line set to the clipboard',
    undo: false,
    poll: (ctx) => !!activeLineSet(ctx.doc),
    exec: (ctx) => {
      lineSetClipboard = structuredClone(activeLineSet(ctx.doc)!);
      return 'CANCELLED';
    },
  },
  {
    idname: 'scene.freestyle_lineset_paste',
    label: 'Paste Line Set',
    description: 'Replace the settings of the active line set with the copied ones',
    poll: (ctx) => !!lineSetClipboard && !!activeLineSet(ctx.doc),
    exec: (ctx) => {
      const fs = freestyleSettings(ctx.doc);
      const cur = activeLineSet(ctx.doc);
      if (!cur || !lineSetClipboard) return 'CANCELLED';
      const copy = structuredClone(lineSetClipboard);
      copy.name = uniqueIn(fs.linesets.filter((s) => s !== cur).map((s) => s.name), copy.name);
      if (copy.linestyle && !linestyleTable(ctx.doc)[copy.linestyle]) copy.linestyle = cur.linestyle;
      fs.linesets[fs.active_lineset_index] = copy;
    },
  },
  {
    idname: 'scene.freestyle_lineset_move',
    label: 'Move Line Set',
    description: 'Move the active line set up or down in the list (later sets draw on top)',
    props: [
      {
        id: 'direction',
        label: 'Direction',
        type: 'enum',
        default: 'UP',
        items: [
          ['UP', 'Up'],
          ['DOWN', 'Down'],
        ],
      },
    ],
    poll: (ctx) => freestyleSettings(ctx.doc).linesets.length > 1,
    exec: (ctx, p) => {
      const fs = freestyleSettings(ctx.doc);
      const i = fs.active_lineset_index;
      const j = p.direction === 'UP' ? i - 1 : i + 1;
      if (j < 0 || j >= fs.linesets.length) return 'CANCELLED';
      [fs.linesets[i], fs.linesets[j]] = [fs.linesets[j], fs.linesets[i]];
      fs.active_lineset_index = j;
    },
  },
  {
    idname: 'scene.freestyle_linestyle_new',
    label: 'New Line Style',
    description: 'Give the active line set a new line style (a copy of its current one)',
    poll: (ctx) => !!activeLineSet(ctx.doc),
    exec: (ctx) => {
      const set = activeLineSet(ctx.doc)!;
      const cur = lineStyleOf(ctx.doc, set);
      const ls = addLineStyle(ctx.doc, 'LineStyle', cur ?? undefined);
      set.linestyle = ls.id;
    },
  },
  addModifierOp('color', 'scene.freestyle_color_modifier_add', 'Add Line Color Modifier', 'Add a modifier that changes the line colour'),
  addModifierOp('alpha', 'scene.freestyle_alpha_modifier_add', 'Add Alpha Transparency Modifier', 'Add a modifier that changes the line opacity'),
  addModifierOp('thickness', 'scene.freestyle_thickness_modifier_add', 'Add Line Thickness Modifier', 'Add a modifier that changes the line thickness'),
  addModifierOp('geometry', 'scene.freestyle_geometry_modifier_add', 'Add Stroke Geometry Modifier', 'Add a modifier that reshapes the strokes'),
  {
    idname: 'scene.freestyle_modifier_remove',
    label: 'Remove Modifier',
    description: 'Remove the modifier from the line style',
    props: modifierTarget,
    poll: (ctx) => !!lineStyleOf(ctx.doc, activeLineSet(ctx.doc)),
    exec: (ctx, p) => {
      const t = targetModifier(ctx.doc, p);
      if (!t) return 'CANCELLED';
      t.list.splice(t.i, 1);
    },
  },
  {
    idname: 'scene.freestyle_modifier_copy',
    label: 'Copy Modifier',
    description: 'Duplicate the modifier right below it',
    props: modifierTarget,
    poll: (ctx) => !!lineStyleOf(ctx.doc, activeLineSet(ctx.doc)),
    exec: (ctx, p) => {
      const t = targetModifier(ctx.doc, p);
      if (!t) return 'CANCELLED';
      const c: LineStyleModifier = structuredClone(t.m);
      c.name = uniqueIn(t.list.map((x) => x.name), c.name);
      t.list.splice(t.i + 1, 0, c);
    },
  },
  {
    idname: 'scene.freestyle_modifier_move',
    label: 'Move Modifier',
    description: 'Move the modifier up or down in its list',
    props: [
      ...modifierTarget,
      {
        id: 'direction',
        label: 'Direction',
        type: 'enum',
        default: 'UP',
        items: [
          ['UP', 'Up'],
          ['DOWN', 'Down'],
        ],
      },
    ],
    poll: (ctx) => !!lineStyleOf(ctx.doc, activeLineSet(ctx.doc)),
    exec: (ctx, p) => {
      const t = targetModifier(ctx.doc, p);
      if (!t) return 'CANCELLED';
      const j = p.direction === 'UP' ? t.i - 1 : t.i + 1;
      if (j < 0 || j >= t.list.length) return 'CANCELLED';
      [t.list[t.i], t.list[j]] = [t.list[j], t.list[t.i]];
    },
  },
  {
    idname: 'scene.freestyle_fill_range_by_selection',
    label: 'Fill Range by Selection',
    description: 'Set the distance range of a modifier to the nearest and farthest vertices of the selected objects',
    props: [
      { id: 'type', label: 'Type', type: 'enum', default: 'COLOR', items: KINDS.slice(0, 3) },
      { id: 'name', label: 'Name', type: 'string', default: '' },
    ],
    poll: (ctx) => !!lineStyleOf(ctx.doc, activeLineSet(ctx.doc)),
    exec: (ctx, p) => {
      const ls = lineStyleOf(ctx.doc, activeLineSet(ctx.doc));
      if (!ls) return 'CANCELLED';
      const list = modifierList(ls, kindOf(p.type));
      const m = list.find((x) => x.name === p.name) ?? list.find((x) => x.type === 'DISTANCE_FROM_CAMERA' || x.type === 'DISTANCE_FROM_OBJECT');
      if (!m || (m.type !== 'DISTANCE_FROM_CAMERA' && m.type !== 'DISTANCE_FROM_OBJECT')) {
        app.report('ERROR', 'The modifier measures no distance');
        return 'CANCELLED';
      }
      // reference point: the scene camera or the modifier's target object
      const refId = m.type === 'DISTANCE_FROM_CAMERA' ? ctx.doc.scene.camera : (m.target as string | null);
      const ref = refId ? app.graph.get(refId) : undefined;
      if (!ref) {
        app.report('ERROR', m.type === 'DISTANCE_FROM_CAMERA' ? 'The scene has no camera' : 'The modifier has no target object');
        return 'CANCELLED';
      }
      const rx = ref.world.elements[12],
        ry = ref.world.elements[13],
        rz = ref.world.elements[14];
      let lo = Infinity,
        hi = -Infinity;
      for (const ob of app.selectedObjects()) {
        if (ob.id === refId) continue;
        const ev = app.graph.get(ob.id);
        if (!ev) continue;
        const e = ev.world.elements;
        const P = ev.mesh?.positions;
        const pts = P && P.length ? P : new Float32Array(3);
        for (let i = 0; i < pts.length; i += 3) {
          const x = e[0] * pts[i] + e[4] * pts[i + 1] + e[8] * pts[i + 2] + e[12],
            y = e[1] * pts[i] + e[5] * pts[i + 1] + e[9] * pts[i + 2] + e[13],
            z = e[2] * pts[i] + e[6] * pts[i + 1] + e[10] * pts[i + 2] + e[14];
          const d = Math.hypot(x - rx, y - ry, z - rz);
          lo = Math.min(lo, d);
          hi = Math.max(hi, d);
        }
      }
      if (!Number.isFinite(lo)) {
        app.report('ERROR', 'Select the objects whose distance range to use');
        return 'CANCELLED';
      }
      m.range_min = lo;
      m.range_max = hi;
    },
  },
  // ------------------------------------------------------------------ marks
  {
    idname: 'mesh.mark_freestyle_edge',
    label: 'Mark Freestyle Edge',
    description: 'Mark (or clear) the selected edges for line rendering (Edge Mark line type)',
    props: [{ id: 'clear', label: 'Clear', type: 'bool', default: false }],
    poll: editPoll,
    exec: (_ctx, p) =>
      void withEdit((m) => {
        const sel = m.selectedEdges();
        if (!sel.length) return false;
        for (const [a, b] of sel) {
          if (p.clear) m.fsEdges.delete(edgeKey(a, b));
          else m.fsEdges.add(edgeKey(a, b));
        }
      }),
  },
  {
    idname: 'mesh.mark_freestyle_face',
    label: 'Mark Freestyle Face',
    description: 'Mark (or clear) the selected faces for line rendering (Face Marks selection)',
    props: [{ id: 'clear', label: 'Clear', type: 'bool', default: false }],
    poll: editPoll,
    exec: (_ctx, p) =>
      void withEdit((m) => {
        const sel = m.selectedFaces();
        if (!sel.length) return false;
        for (const f of sel) m.faces[f] = { ...m.faces[f], fsFace: p.clear ? undefined : true };
      }),
  },
]);
