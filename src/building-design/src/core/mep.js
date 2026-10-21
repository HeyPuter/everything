/**
 * Building services runs: ducts, pipes, cable trays and conduits. Each is a
 * straight segment a→b on a level at a middle elevation (offset), with a
 * size from its type (or its own override). Chains drawn in one go meet at
 * their ends; the solids are extended there so corners close.
 *
 *   duct      { typeId, levelId, a, b, offset, width, height, diameter, system }
 *   pipe      { typeId, levelId, a, b, offset, diameter, system }
 *   cableTray { typeId, levelId, a, b, offset, width, height }
 *   conduit   { typeId, levelId, a, b, offset, diameter }
 */
import { add, sub, scale, norm, perp, eq } from './geom.js';

export const MEP_KINDS = ['duct', 'pipe', 'cableTray', 'conduit'];

export const SYSTEMS = {
  duct: [
    { value: 'supply', label: 'Supply Air', color: '#3d7fc4' },
    { value: 'return', label: 'Return Air', color: '#c4743d' },
    { value: 'exhaust', label: 'Exhaust Air', color: '#7a5bb3' },
  ],
  pipe: [
    { value: 'cold', label: 'Domestic Cold Water', color: '#2f9e6b' },
    { value: 'hot', label: 'Domestic Hot Water', color: '#c94848' },
    { value: 'sanitary', label: 'Sanitary', color: '#8a6d3b' },
    { value: 'hydronic', label: 'Hydronic Supply', color: '#c48a1f' },
    { value: 'fire', label: 'Fire Protection', color: '#b52d2d' },
  ],
  cableTray: [{ value: 'power', label: 'Power', color: '#6b7684' }],
  conduit: [{ value: 'power', label: 'Power', color: '#6b7684' }],
};

export function systemOf(el) {
  const list = SYSTEMS[el.kind] || [];
  return list.find((s) => s.value === el.system) || list[0] || { value: '', label: '', color: '#888888' };
}

/** Cross-section of a run: { round, w, h } in millimetres. */
export function mepSize(doc, el) {
  const t = doc.get(el.typeId) || {};
  const round = el.kind === 'pipe' || el.kind === 'conduit' || (el.kind === 'duct' && (el.shape || t.shape) === 'round');
  if (round) {
    const d = +(el.diameter ?? t.diameter) || (el.kind === 'conduit' ? 25 : el.kind === 'pipe' ? 50 : 300);
    return { round: true, w: d, h: d };
  }
  return { round: false, w: +(el.width ?? t.width) || 400, h: +(el.height ?? t.height) || 250 };
}

/** Plan outline and centre line of a run, extended at ends shared with other runs. */
export function mepPlan(doc, el) {
  const { w } = mepSize(doc, el);
  const d = norm(sub(el.b, el.a));
  const n = perp(d);
  const ext = (p) => (connected(doc, el, p) ? w / 2 : 0);
  const a = sub(el.a, scale(d, ext(el.a)));
  const b = add(el.b, scale(d, ext(el.b)));
  const h = scale(n, w / 2);
  return { a, b, d, n, outline: [sub(a, h), sub(b, h), add(b, h), add(a, h)] };
}

/** Does another run of the same kind on the same level end at p? */
export function connected(doc, el, p) {
  for (const o of doc.all(el.kind)) {
    if (o.id === el.id || o.levelId !== el.levelId) continue;
    if (eq(o.a, p, 1) || eq(o.b, p, 1)) return true;
  }
  return false;
}

/** Default MEP types. */
export function mepTypes(imp) {
  const t = (mm, inch) => (imp ? inch * 25.4 : mm);
  return [
    { id: 'dct-rect', kind: 'ductType', familyName: 'Rectangular Duct', name: imp ? '16" x 10"' : '400 x 250 mm', shape: 'rect', width: t(400, 16), height: t(250, 10), materialId: 'mat-steel' },
    { id: 'dct-round', kind: 'ductType', familyName: 'Round Duct', name: imp ? '12" Diameter' : '300 mm Diameter', shape: 'round', diameter: t(300, 12), materialId: 'mat-steel' },
    { id: 'pt-copper', kind: 'pipeType', familyName: 'Pipe', name: imp ? 'Copper 1"' : 'Copper 28 mm', diameter: t(28, 1), materialId: 'mat-steel' },
    { id: 'pt-pvc', kind: 'pipeType', familyName: 'Pipe', name: imp ? 'PVC 4"' : 'PVC 110 mm', diameter: t(110, 4), materialId: 'mat-default' },
    { id: 'ctt-ladder', kind: 'cableTrayType', familyName: 'Cable Tray', name: imp ? 'Ladder 12" x 4"' : 'Ladder 300 x 100 mm', width: t(300, 12), height: t(100, 4), materialId: 'mat-steel' },
    { id: 'cdt-emt', kind: 'conduitType', familyName: 'Conduit', name: imp ? 'EMT 3/4"' : 'Steel 25 mm', diameter: t(25, 0.75), materialId: 'mat-steel' },
  ];
}
