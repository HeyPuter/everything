// Depsgraph integration: the basis object of a metaball family evaluates to the polygonized
// surface of all its family members' elements (in the basis object's space); other members
// show no geometry of their own.
import { Matrix4 } from 'three';
import { dataEvaluators, type Depsgraph } from '../eval/depsgraph';
import type { DocumentData, ObjectData } from '../data/types';
import { basisOf, familyOf, metaballOf } from './data';
import { fieldElements, polygonize, type FieldElement } from './polygonize';
import type { MetaballData, MetaElement } from './types';

/** Live editing state, set by the Edit Mode transform provider. */
export const mballLive = { transforming: false };

const lastSignature = new Map<string, string>();

const elementKey = (e: MetaElement) => (e.hide ? '' : `${e.type},${e.co.join(',')},${e.rotation.join(',')},${e.radius},${e.stiffness},${e.size_x},${e.size_y},${e.size_z},${e.use_negative ? 1 : 0};`);

function cellSize(mb: MetaballData, graph: Depsgraph, editing: boolean) {
  let cell = graph.render ? mb.render_resolution : mb.resolution;
  if (editing && !graph.render && mb.update_method === 'HALFRES' && mballLive.transforming) cell *= 2;
  return cell;
}

function editingFamily(fam: ObjectData[], graph: Depsgraph) {
  return fam.some((o) => graph.editObjects.has(o.id));
}

dataEvaluators.META = {
  signature(doc, ob, graph) {
    const mb = metaballOf(doc, ob);
    if (!mb) return null;
    if (basisOf(doc, ob).id !== ob.id) return null;
    const fam = familyOf(doc, ob);
    const editing = editingFamily(fam, graph);
    const prev = lastSignature.get(ob.id);
    if (editing && !graph.render && prev && (mb.update_method === 'NEVER' || (mb.update_method === 'FAST' && mballLive.transforming))) return prev;
    const w = graph.get(ob.id)?.world;
    let s = `mb|${cellSize(mb, graph, editing)}|${mb.threshold}`;
    for (const m of fam) {
      const md = metaballOf(doc, m)!;
      s += `|${m.id}`;
      if (m !== ob) {
        const mw = graph.get(m.id)?.world;
        if (w && mw) s += ':' + new Matrix4().copy(w).invert().multiply(mw).elements.map((x) => x.toFixed(5)).join(',');
      }
      s += ':' + md.elements.map(elementKey).join('');
    }
    if (!graph.render) lastSignature.set(ob.id, s);
    return s;
  },
  build(doc, ob, graph) {
    const mb = metaballOf(doc, ob)!;
    const fam = familyOf(doc, ob);
    return polygonize(familyField(doc, ob, graph), mb.threshold, cellSize(mb, graph, editingFamily(fam, graph))).mesh;
  },
};

/** Field elements of a basis object's whole family, in the basis object's space. */
export function familyField(doc: DocumentData, basis: ObjectData, graph: Pick<Depsgraph, 'get'>): FieldElement[] {
  const w = graph.get(basis.id)?.world ?? new Matrix4();
  const inv = w.clone().invert();
  const out: FieldElement[] = [];
  for (const m of familyOf(doc, basis)) {
    const md = metaballOf(doc, m);
    if (!md) continue;
    const toSpace = m.id === basis.id ? new Matrix4() : inv.clone().multiply(graph.get(m.id)?.world ?? new Matrix4());
    out.push(...fieldElements(md.elements.filter((e) => !e.hide), toSpace));
  }
  return out;
}
