// Curve Object Data tab: Active Spline panel (Edit Mode) for the spline of the active point.
import { h } from '../../ui/h';
import { panel } from '../../ui/widgets';
import { num, bool } from '../../ui/props';
import { curveDataPanels } from '../../editors/properties/tabs';
import { activePoint, inCurveEdit } from './curve';
import * as K from './curveops';

curveDataPanels.push((ob, cu) => {
  if (ob.type !== 'CURVE' || !inCurveEdit()) return null;
  return panel('cu-active-spline', 'Active Spline', () => {
    const act = activePoint();
    // the spline of the active point, else the first spline with a selected point
    const sp = act ? cu.splines[act.s] : cu.splines.find((x) => [...Array(K.pointCount(x)).keys()].some((i) => K.isSel(x, i)));
    if (!sp) return h('div', { class: 'prop-note' }, 'Select a control point to edit its spline.');
    const nurbs = sp.type === 'NURBS';
    return [
      bool(sp, 'use_cyclic_u', 'Cyclic U'),
      nurbs ? bool(sp as never, 'use_bezier_u' as never, 'Bézier U') : null,
      nurbs ? bool(sp as never, 'use_endpoint_u' as never, 'Endpoint U') : null,
      nurbs ? num(sp, 'order_u', 'Order U', { int: true, min: 2, max: Math.max(2, Math.min(6, K.pointCount(sp))) }) : null,
      sp.type !== 'POLY' ? num(sp, 'resolution_u', 'Resolution U', { int: true, min: 1, max: 1024 }) : null,
      bool(sp, 'use_smooth', 'Smooth'),
      num(sp, 'material_index', 'Material Index', { int: true, min: 0, max: Math.max(0, cu.materials.length - 1) }),
    ];
  });
});

