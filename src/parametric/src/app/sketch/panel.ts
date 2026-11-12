// PropertyManager shown while editing a sketch: definition status, active
// tool options, and the constraints of the selected entities (with buttons
// to add the constraints that apply to the selection, model edges and
// vertices included).

import type { SkDimension } from '../../model/types';
import { isDimension } from '../../model/types';
import { ORIGIN_ID } from '../../sketch/geom';
import { RELATION_LABELS, relationsOf } from '../../sketch/ops';
import { unlinkExternal } from '../../sketch/external';
import { isTargetItem } from './editor';
import { h } from '../../ui/dom';
import { icon, relationGlyph } from '../../ui/icons';
import type { App } from '../app';
import type { SolveResult } from '../../sketch/solver';
import { PropertyPanel, checkbox, numberField, section } from '../pm';

const ENTITY_LABELS: Record<string, string> = { point: 'Point', line: 'Line', circle: 'Circle', arc: 'Arc', spline: 'Spline' };

export function sketchDefinitionStatus(st: SolveResult): HTMLElement {
  const cls = st.status === 'over' ? 'error' : st.status === 'full' ? 'info' : '';
  // A redundant relation repeats what others already fix and the sketch still
  // solves; only a conflicting one cannot be met. Saying which keeps a
  // harmless duplicate from reading as a contradiction.
  const conflicts = st.conflicting.size;
  const redundant = [...st.badConstraints].filter((id) => !st.conflicting.has(id)).length;
  const text = st.status === 'over'
    ? conflicts && redundant
      ? `Over defined: ${conflicts} constraint(s) or dimension(s) conflict and ${redundant} are redundant. Delete them or make dimensions driven (shown in red).`
      : conflicts
        ? `Over defined: ${conflicts} constraint(s) or dimension(s) conflict. Delete them or make dimensions driven (shown in red).`
        : `Over defined: ${redundant} constraint(s) or dimension(s) are redundant, already fixed by others. Delete them or make dimensions driven (shown in red).`
    : st.status === 'full' ? 'Fully defined.' : `Under defined: ${st.dof} degree(s) of freedom remain. Add dimensions or constraints (blue geometry can still move).`;
  return h('div', { class: `pm-msg sketch-definition ${cls}`, role: 'status' }, text);
}

export class SketchPanel extends PropertyPanel {
  title: string;
  confirm = false;

  constructor(private app: App) {
    super();
    const ed = app.sketchEditor!;
    this.title = ed.tool ? ed.tool.label : ed.sketch.name;
    this.icon = ed.tool ? ed.tool.id : 'sketch';
    this.closeLabel = 'Exit Sketch';
    this.onCloseClick = () => app.exitSketch(true);
  }

  ok() {
    return true;
  }

  render(): HTMLElement[] {
    const app = this.app;
    const ed = app.sketchEditor!;
    const sk = ed.sketch;
    const out: HTMLElement[] = [];
    const st = ed.solve;
    if (st) out.push(sketchDefinitionStatus(st));
    if (ed.tool?.options) {
      const options = section(`${ed.tool.label} Options`, ed.tool.options());
      options.classList.add('sketch-tool-options');
      out.push(options);
    }
    if (ed.tool) out.push(h('div', { class: 'pm-msg' }, ed.tool.hint));

    const ids = ed.selectedIds(['sk']);
    const dims = ed.selectedIds(['skdim']).map((id) => sk.constraints.find((c) => c.id === id)).filter((c): c is SkDimension => !!c && isDimension(c));
    const targets = app.selection.items.filter(isTargetItem);
    if (targets.length) {
      const names = targets.map((it) => {
        if (it.kind === 'edge') return 'Model edge';
        if (it.kind === 'vertex') return 'Model vertex';
        if (it.id === ORIGIN_ID) return 'Origin';
        const e = sk.entities.find((x) => x.id === it.id);
        return `${ENTITY_LABELS[e?.t ?? 'point']} ${it.id}${e?.ext ? ' (projected)' : ''}`;
      });
      out.push(section('Selected Entities', [h('div', { class: 'selbox' }, names.map((n) => h('div', { class: 'item' }, n)))]));
      const rels = ids.length ? relationsOf(sk, ids) : [];
      const existing = h('div', { class: 'relations-list' });
      const linked = sk.entities.filter((e) => e.ext && ids.includes(e.id));
      for (const e of linked) {
        const lost = ed.lostExternal.has(e.id);
        const label = lost ? 'Projected: model edge not found' : e.ext!.kind === 'vertex' ? 'Projected from a model vertex' : 'Projected from a model edge';
        const unlink = h('button', { class: 'btn small', type: 'button', title: 'Keep this geometry where it is, no longer linked to the model' }, 'Unlink');
        unlink.addEventListener('click', () => ed.edit('Unlink projected geometry', (s2, newId) => { unlinkExternal(s2, [e.id], newId); }));
        existing.append(h('div', { class: 'rel-btn', style: { cursor: 'default', color: lost ? 'var(--danger)' : '' } },
          icon('convertEntities', 16), h('span', { class: 'grow' }, label), unlink));
      }
      if (!rels.length && !linked.length) existing.append(h('div', { class: 'field-label' }, ids.length ? 'No constraints' : 'Not in the sketch yet: adding a constraint projects it, linked to the model.'));
      for (const r of rels) {
        const label = isDimension(r) ? `${r.name} (${r.type})${r.driven ? ', driven' : ''}` : `${RELATION_LABELS[r.type]}${st?.conflicting.has(r.id) ? ' (conflict)' : st?.badConstraints.has(r.id) ? ' (redundant)' : ''}`;
        const del = h('button', { class: 'icon-btn', type: 'button', 'aria-label': `Delete ${label}` }, icon('trash', 14));
        del.addEventListener('click', () => ed.edit('Delete constraint', (s2) => { s2.constraints = s2.constraints.filter((c) => c.id !== r.id); }));
        existing.append(h('div', { class: 'rel-btn', style: { cursor: 'default', color: st?.badConstraints.has(r.id) ? 'var(--danger)' : '' } },
          isDimension(r) ? icon('smartDimension', 16) : relationGlyph(r.type, 14), h('span', { class: 'grow' }, label), del));
      }
      out.push(section('Existing Constraints', [existing]));
      const avail = ed.selectionRelations();
      if (avail.length) {
        const list = h('div', { class: 'relations-list' });
        for (const t of avail) {
          const b = h('button', { class: 'rel-btn', type: 'button' }, relationGlyph(t, 14), RELATION_LABELS[t]);
          b.addEventListener('click', () => ed.addRelation(t, targets));
          list.append(b);
        }
        out.push(section('Add Constraints', [list]));
      }
      const curves = ids.map((id) => sk.entities.find((e) => e.id === id)).filter((e) => e && e.t !== 'point');
      if (curves.length) {
        out.push(section('Options', [checkbox('For construction', curves.every((c) => c!.construction), () => ed.toggleConstruction())]));
      }
    } else if (dims.length === 1) {
      const d = dims[0];
      out.push(section(`Dimension ${d.name}`, [
        d.driven ? h('div', { class: 'field-label' }, 'Driven (reference) dimension') : h('div', { class: 'sketch-dimension-field' }, numberField({
          label: 'Value', value: d.value, kind: d.type === 'angle' ? 'angle' : 'length', ctx: app.unitContext(),
          // Like the Modify box: lengths must be positive (a negative one over-defines the sketch).
          min: d.type === 'angle' ? 0 : 1e-6,
          // The angle between two lines is 0 to 180 degrees (the label side picks the sector).
          max: d.type === 'angle' ? 180 : undefined,
          onChange: (v) => {
            // Removing a focused field can emit change before detaching it.
            // The field must still own this dimension, not a deleted or replaced one.
            if (!ed.sketch?.constraints.includes(d)) return;
            ed.edit('Change dimension', (s2) => { (s2.constraints.find((c) => c.id === d.id) as SkDimension).value = v; }, { keepNumberField: true });
          },
        })),
        checkbox('Driven (reference only)', !!d.driven, (v) => ed.setDriven(d.id, v)),
      ]));
    } else if (!ed.tool) {
      const counts = new Map<string, number>();
      for (const e of sk.entities) counts.set(e.t, (counts.get(e.t) ?? 0) + 1);
      const summary = [...counts].filter(([t]) => t !== 'point').map(([t, n]) => `${n} ${ENTITY_LABELS[t].toLowerCase()}${n > 1 ? 's' : ''}`).join(', ') || 'Empty sketch';
      out.push(section('Sketch', [
        h('div', { class: 'field-label' }, summary),
        h('div', { class: 'field-label' }, `${sk.constraints.filter((c) => !isDimension(c)).length} constraints, ${sk.constraints.filter(isDimension).length} dimensions`),
        h('p', { class: 'field-label' }, 'Pick a constraint in the Constrain group of the Sketch tab, then click the geometry it applies to. Or select geometry first (Shift-click to add model edges and vertices) to see the constraints that fit. Drag geometry to see how it is constrained. Double-click a dimension to change it.'),
      ]));
    }
    const model = app.selection.items.filter((it) => it.kind === 'edge' || it.kind === 'face' || it.kind === 'vertex').length;
    if (model) out.push(h('div', { class: 'pm-msg info' }, `${model} model item(s) selected. Use Convert Entities to project them into this sketch, linked to the model.`));
    const lost = sk.entities.filter((e) => e.ext && ed.lostExternal.has(e.id)).length;
    if (lost) out.push(h('div', { class: 'pm-msg error' }, `${lost} projected entit${lost === 1 ? 'y' : 'ies'} (red) lost ${lost === 1 ? 'its' : 'their'} model edge and stay${lost === 1 ? 's' : ''} where ${lost === 1 ? 'it was' : 'they were'}. Delete or unlink ${lost === 1 ? 'it' : 'them'}, or project the edge again.`));
    return out;
  }
}

