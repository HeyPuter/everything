// PropertyManager shown while editing a sketch: definition status, active
// tool options, and the relations of the selected entities (with buttons to
// add the relations that apply to the selection).

import type { Id, RelationType, SkDimension } from '../../model/types';
import { isDimension } from '../../model/types';
import { ORIGIN_ID } from '../../sketch/geom';
import { RELATION_LABELS, availableRelations, makeRelations, relationsOf } from '../../sketch/ops';
import { h } from '../../ui/dom';
import { icon, relationGlyph } from '../../ui/icons';
import type { App } from '../app';
import { PropertyPanel, checkbox, numberField, section } from '../pm';

const ENTITY_LABELS: Record<string, string> = { point: 'Point', line: 'Line', circle: 'Circle', arc: 'Arc', spline: 'Spline' };

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
    if (st) {
      const cls = st.status === 'over' ? 'error' : st.status === 'full' ? 'info' : '';
      const text = st.status === 'over'
        ? `Over defined: ${st.badConstraints.size} relation(s) or dimension(s) conflict or are redundant. Delete or make them driven (shown in red).`
        : st.status === 'full' ? 'Fully defined.' : `Under defined: ${st.dof} degree(s) of freedom remain. Add dimensions or relations (blue geometry can still move).`;
      out.push(h('div', { class: `pm-msg ${cls}`, role: 'status' }, text));
    }
    if (ed.tool?.options) out.push(section(`${ed.tool.label} Options`, ed.tool.options()));
    if (ed.tool) out.push(h('div', { class: 'pm-msg' }, ed.tool.hint));

    const ids = ed.selectedIds(['sk']);
    const dims = ed.selectedIds(['skdim']).map((id) => sk.constraints.find((c) => c.id === id)).filter((c): c is SkDimension => !!c && isDimension(c));
    if (ids.length) {
      const names = ids.map((id) => (id === ORIGIN_ID ? 'Origin' : `${ENTITY_LABELS[sk.entities.find((e) => e.id === id)?.t ?? 'point']} ${id}`));
      out.push(section('Selected Entities', [h('div', { class: 'selbox' }, names.map((n) => h('div', { class: 'item' }, n)))]));
      const rels = relationsOf(sk, ids);
      const existing = h('div', { class: 'relations-list' });
      if (!rels.length) existing.append(h('div', { class: 'field-label' }, 'No relations'));
      for (const r of rels) {
        const label = isDimension(r) ? `${r.name} (${r.type})${r.driven ? ', driven' : ''}` : `${RELATION_LABELS[r.type]}${st?.badConstraints.has(r.id) ? ' (conflict)' : ''}`;
        const del = h('button', { class: 'icon-btn', type: 'button', 'aria-label': `Delete ${label}` }, icon('trash', 14));
        del.addEventListener('click', () => ed.edit('Delete relation', (s2) => { s2.constraints = s2.constraints.filter((c) => c.id !== r.id); }));
        existing.append(h('div', { class: 'rel-btn', style: { cursor: 'default', color: st?.badConstraints.has(r.id) ? 'var(--danger)' : '' } },
          isDimension(r) ? icon('smartDimension', 16) : relationGlyph(r.type, 14), h('span', { class: 'grow' }, label), del));
      }
      out.push(section('Existing Relations', [existing]));
      const avail = availableRelations(sk, ids);
      if (avail.length) {
        const list = h('div', { class: 'relations-list' });
        for (const t of avail) {
          const b = h('button', { class: 'rel-btn', type: 'button' }, relationGlyph(t, 14), RELATION_LABELS[t]);
          b.addEventListener('click', () => this.addRelation(t, ids));
          list.append(b);
        }
        out.push(section('Add Relations', [list]));
      }
      const curves = ids.map((id) => sk.entities.find((e) => e.id === id)).filter((e) => e && e.t !== 'point');
      if (curves.length) {
        out.push(section('Options', [checkbox('For construction', curves.every((c) => c!.construction), () => ed.toggleConstruction())]));
      }
    } else if (dims.length === 1) {
      const d = dims[0];
      out.push(section(`Dimension ${d.name}`, [
        d.driven ? h('div', { class: 'field-label' }, 'Driven (reference) dimension') : numberField({
          label: 'Value', value: d.value, kind: d.type === 'angle' ? 'angle' : 'length', ctx: app.unitContext(),
          // Like the Modify box: lengths must be positive (a negative one over-defines the sketch).
          min: d.type === 'angle' ? 0 : 1e-6,
          // The angle between two lines is 0 to 180 degrees (the label side picks the sector).
          max: d.type === 'angle' ? 180 : undefined,
          onChange: (v) => ed.edit('Change dimension', (s2) => { (s2.constraints.find((c) => c.id === d.id) as SkDimension).value = v; }),
        }),
        checkbox('Driven (reference only)', !!d.driven, (v) => ed.edit(v ? 'Make dimension driven' : 'Make dimension driving', (s2) => { (s2.constraints.find((c) => c.id === d.id) as SkDimension).driven = v || undefined; })),
      ]));
    } else if (!ed.tool) {
      const counts = new Map<string, number>();
      for (const e of sk.entities) counts.set(e.t, (counts.get(e.t) ?? 0) + 1);
      const summary = [...counts].filter(([t]) => t !== 'point').map(([t, n]) => `${n} ${ENTITY_LABELS[t].toLowerCase()}${n > 1 ? 's' : ''}`).join(', ') || 'Empty sketch';
      out.push(section('Sketch', [
        h('div', { class: 'field-label' }, summary),
        h('div', { class: 'field-label' }, `${sk.constraints.filter((c) => !isDimension(c)).length} relations, ${sk.constraints.filter(isDimension).length} dimensions`),
        h('p', { class: 'field-label' }, 'Select entities to see and add relations. Drag geometry to see how it is constrained. Double-click a dimension to change it.'),
      ]));
    }
    const modelEdges = app.selection.ofKind('edge').length;
    if (modelEdges) out.push(h('div', { class: 'pm-msg info' }, `${modelEdges} model edge(s) selected. Use Convert Entities to project them into this sketch.`));
    return out;
  }

  private addRelation(t: RelationType, ids: Id[]) {
    const ed = this.app.sketchEditor!;
    ed.edit(`Add ${RELATION_LABELS[t].toLowerCase()} relation`, (sk, newId) => {
      sk.constraints.push(...makeRelations(sk, t, ids, newId));
    }, { select: ids });
  }
}
