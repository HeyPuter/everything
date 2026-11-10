// Constraint tools (Coincident, Parallel...: pick the geometry, the
// constraint is added once enough is picked) and Convert Entities, which
// projects model edges, faces and vertices into the sketch as geometry that
// stays linked to the model.

import type { EdgeInfo } from '../../kernel/protocol';
import type { Vec3 } from '../../math/vec';
import type { RelationType } from '../../model/types';
import { projectEdgeInto, projectVertexInto } from '../../sketch/external';
import { RELATION_LABELS, kindOf } from '../../sketch/ops';
import { toast } from '../../ui/overlay';
import { type SelItem, sameItem } from '../selection';
import type { VPEvent } from '../viewport';
import { type SkTool, type SketchEditor, type TargetItem, isTargetItem } from './editor';

/** Order of the constraint commands (ribbon, menus, command search). */
export const CONSTRAINTS: RelationType[] = [
  'coincident', 'horizontal', 'vertical', 'parallel', 'perpendicular', 'tangent',
  'equal', 'concentric', 'midpoint', 'collinear', 'symmetric', 'fix',
];

/** What each constraint does and what to pick for it. */
export const CONSTRAINT_HINTS: Record<RelationType, string> = {
  coincident: 'Make a point lie on another point, or on a line, arc, circle or spline. Pick two points, or a point and a curve. Model edges and vertices work too.',
  horizontal: 'Make lines horizontal, or line up points horizontally. Pick a line, or two points.',
  vertical: 'Make lines vertical, or line up points vertically. Pick a line, or two points.',
  parallel: 'Make two lines parallel. Pick two lines.',
  perpendicular: 'Make two lines perpendicular. Pick two lines.',
  tangent: 'Make a curve touch another without crossing it. Pick a line and an arc or circle, or two arcs or circles.',
  equal: 'Give two lines the same length, or two arcs or circles the same radius. Pick two of them.',
  concentric: 'Give arcs and circles the same centre. Pick two arcs or circles, or a point and an arc or circle.',
  midpoint: 'Put a point at the middle of a line. Pick a point and a line.',
  collinear: 'Put two lines on the same infinite line. Pick two lines.',
  symmetric: 'Mirror two points, lines, arcs or circles about a line. Pick the two, then the line.',
  fix: 'Hold sketch geometry where it is. Pick the geometry to fix.',
};

/** Picks that complete a constraint, given what was picked first. */
function picksNeeded(type: RelationType, first: string | undefined): number {
  if (type === 'fix') return 1;
  if (type === 'symmetric') return 3;
  if ((type === 'horizontal' || type === 'vertical') && first === 'line') return 1;
  return 2;
}

/** What kind of sketch geometry an item is (or would be, once projected). */
function itemKind(ed: SketchEditor, it: TargetItem): string | undefined {
  if (it.kind === 'sk') return kindOf(ed.sketch, it.id);
  if (it.kind === 'vertex') return 'point';
  const e = ed.app.edges[it.index];
  return e?.type === 'line' ? 'line' : e?.type;
}

/** The sketch entity or model edge/vertex under the cursor. */
function pickTarget(ed: SketchEditor, raw: [number, number], e: VPEvent): TargetItem | null {
  const hit = ed.pickAt(raw, 8);
  if (hit) return { kind: 'sk', id: hit.id };
  const m = ed.app.viewport.pickItem(e.x, e.y, { edge: true, vertex: true });
  return m && isTargetItem(m) ? m : null;
}

/**
 * Applies a constraint to the selection if it is complete and fits. Returns
 * false when more picks are needed.
 */
function applyPicks(ed: SketchEditor, type: RelationType, picks: TargetItem[]): 'applied' | 'refused' | 'more' {
  if (!picks.length || picks.length < picksNeeded(type, itemKind(ed, picks[0]))) return 'more';
  if (!ed.selectionRelations(picks).includes(type)) {
    toast({ kind: 'warning', title: `${RELATION_LABELS[type]} does not fit`, message: CONSTRAINT_HINTS[type] });
    return 'refused';
  }
  ed.addRelation(type, picks);
  return 'applied';
}

/**
 * Tool that adds one kind of constraint: pick the geometry it applies to and
 * it is added as soon as enough is picked. The tool stays active for the next
 * one; Esc drops the picks, a second Esc leaves the tool.
 */
export function constraintTool(ed: SketchEditor, type: RelationType, seed: TargetItem[] = []): SkTool {
  let picks: TargetItem[] = [...seed];
  const label = RELATION_LABELS[type];
  const hint = `${label}: ${CONSTRAINT_HINTS[type]} Esc to finish.`;
  if (picks.length) ed.app.selection.set(picks);
  return {
    id: `constraint:${type}`,
    label,
    hint,
    picks: true,
    move(s, e) {
      const hit = ed.pickAt(s.p, 8);
      if (hit?.id !== ed.hovered?.id) { ed.hovered = hit; ed.queueRender(); }
      ed.app.selection.setHover(hit ? null : ed.app.viewport.pickItem(e.x, e.y, { edge: true, vertex: true }));
    },
    click(s, e) {
      const it = pickTarget(ed, s.p, e);
      if (!it) return true;
      // Picking something again takes it back.
      const i = picks.findIndex((p) => sameItem(p, it));
      if (i >= 0) picks.splice(i, 1);
      else picks.push(it);
      ed.app.selection.set(picks);
      const r = applyPicks(ed, type, picks);
      if (r === 'more') {
        const need = picks.length ? picksNeeded(type, itemKind(ed, picks[0])) : 0;
        ed.app.setStatus(picks.length ? `${label}: picked ${picks.length} of ${need}. Pick the next one, or press Esc to start again.` : hint);
        return true;
      }
      picks = [];
      ed.app.selection.clear();
      ed.app.setStatus(hint);
      return true;
    },
    cancel() {
      const was = picks.length > 0;
      picks = [];
      ed.app.selection.clear();
      ed.hovered = null;
      ed.app.selection.setHover(null);
      return was;
    },
  };
}

/**
 * Runs a constraint command: a selection that fits gets the constraint at
 * once; otherwise the tool starts with what is selected as its first picks.
 */
export function runConstraint(ed: SketchEditor, type: RelationType) {
  // The same command again leaves the tool.
  if (ed.tool?.id === `constraint:${type}`) { ed.setTool(null); return; }
  const items = [...ed.app.selection.items];
  const targets = items.filter(isTargetItem);
  const other = items.some((it) => !isTargetItem(it) && it.kind !== 'skdim' && it.kind !== 'skrel');
  // Leaving the current tool clears the selection; it was read above.
  if (ed.tool) ed.setTool(null);
  if (targets.length && !other && ed.selectionRelations(targets).includes(type)
      && targets.length >= picksNeeded(type, itemKind(ed, targets[0]))) {
    ed.addRelation(type, targets);
    return;
  }
  const seed = other ? [] : targets.slice(0, picksNeeded(type, targets[0] ? itemKind(ed, targets[0]) : undefined) - 1);
  if (!seed.length) ed.app.selection.clear();
  ed.setTool(constraintTool(ed, type, seed));
}

// ---------- Convert Entities ----------

/**
 * Projects model edges, faces (all of their edges) and vertices into the
 * sketch as linked geometry, as one undo step. Returns how many could not be.
 */
export function projectModelItems(ed: SketchEditor, items: SelItem[]): number {
  const app = ed.app;
  const edges: EdgeInfo[] = [];
  const vertices: Vec3[] = [];
  for (const it of items) {
    if (it.kind === 'edge') { const e = app.edges[it.index]; if (e && !edges.includes(e)) edges.push(e); }
    else if (it.kind === 'face') {
      for (const e of app.edges) if (e.faces.includes(it.index) && !edges.includes(e)) edges.push(e);
    } else if (it.kind === 'vertex') vertices.push(it.p);
  }
  let skipped = 0;
  ed.edit('Convert entities', (sk, newId) => {
    for (const e of edges) if (!projectEdgeInto(sk, ed.frame, e, newId)) skipped++;
    for (const p of vertices) if (!projectVertexInto(sk, ed.frame, p, app.edges, newId)) skipped++;
  });
  if (skipped) toast({ kind: 'warning', message: `${skipped} item(s) could not be converted. Lines and vertices can be, and circles and arcs parallel to the sketch plane.` });
  return skipped;
}

/** Pick mode of Convert Entities, when nothing was selected to convert. */
export function convertTool(ed: SketchEditor): SkTool {
  const filter = { edge: true, vertex: true, face: true };
  return {
    id: 'convertEntities',
    label: 'Convert Entities',
    hint: 'Click model edges, faces or vertices to project them into the sketch. Projected geometry stays linked to the model. Esc to finish.',
    picks: true,
    move(_s, e) {
      ed.app.selection.setHover(ed.app.viewport.pickItem(e.x, e.y, filter));
    },
    click(_s, e) {
      const m = ed.app.viewport.pickItem(e.x, e.y, filter);
      if (m && (m.kind === 'edge' || m.kind === 'face' || m.kind === 'vertex')) projectModelItems(ed, [m]);
      return true;
    },
    cancel() {
      ed.app.selection.setHover(null);
      return false;
    },
  };
}
