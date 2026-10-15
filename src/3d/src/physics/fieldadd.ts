// Add ▸ Force Field for the field types beyond the basic ones (the basic types keep their original
// operator behaviour): Curve Guide adds a path curve, the others an empty.
import { app, onAppReady, operators, registerOperators, type Operator } from '../app/app';
import { newCurve, newObject } from '../data/defaults';
import { addObjectToScene } from '../ops/object';
import { defaultField, FIELD_TYPES, type ForceFieldX } from './types';

const BASIC = new Set(['FORCE', 'WIND', 'VORTEX', 'TURBULENCE', 'DRAG']);

onAppReady(() => {
  const prev = operators.get('object.effector_add');
  const op: Operator = {
    ...(prev ?? { idname: 'object.effector_add', label: 'Add Effector' }),
    idname: 'object.effector_add',
    label: 'Add Effector',
    description: 'Add an empty (or a curve for guides) with a force field',
    props: [{ id: 'type', label: 'Type', type: 'enum', default: 'FORCE', items: FIELD_TYPES.map(([v, l]) => [v, l] as [string, string]) }, ...(prev?.props ?? []).filter((p) => p.id !== 'type')],
    poll: (ctx) => ctx.doc.mode === 'OBJECT',
    exec: (ctx, p) => {
      const type = p.type as ForceFieldX['type'];
      if (BASIC.has(type) && prev?.exec) return prev.exec(ctx, p);
      const label = FIELD_TYPES.find(([v]) => v === type)?.[1] ?? 'Field';
      const props = { ...p };
      if (props.location === null || props.location === undefined) props.location = [...ctx.doc.scene.cursor.location];
      if (props.rotation === null) delete props.rotation;
      let ob;
      if (type === 'GUIDE') {
        // a straight path along X for the particles to follow
        const cu = newCurve('CurveGuide');
        cu.splines.push({
          type: 'NURBS',
          bezier_points: [],
          points: [-2, -1, 0, 1, 2].map((x) => ({ co: [x, 0, 0, 1], radius: 1, tilt: 0, weight: 1, select: false }) as never),
          use_cyclic_u: false,
          resolution_u: 12,
          order_u: 4,
          use_endpoint_u: true,
          use_smooth: true,
          material_index: 0,
        });
        cu.path_duration = 100;
        ctx.doc.curves[cu.id] = cu;
        ob = newObject('CurveGuide', 'CURVE', cu.id);
      } else {
        ob = newObject(label.replace(/[^A-Za-z]/g, '') || 'Field', 'EMPTY', null);
        ob.empty_display_type = 'SPHERE';
      }
      ob.field = defaultField(type);
      addObjectToScene(ctx.doc, ob, props);
    },
  };
  registerOperators([op]);
});
