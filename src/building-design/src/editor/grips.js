/**
 * Grips (direct manipulation handles) of selected elements. Each grip has a
 * position in the view's coordinates, a shape, and either a drag handler
 * (called inside a live transaction with the snapped pointer point) or a
 * click handler.
 */
import { add, sub, scale, perp, mid, dot, eq, dist, angleOf } from '../core/geom.js';
import { radialTarget } from '../core/annotate.js';

/** Edge and corner handles that resize a crop rectangle stored on a view. */
export function cropGrips(doc, view, r) {
  const set = (patch) => {
    const c = { ...doc.get(view.id).crop, ...patch };
    if (c.x1 - c.x0 < 100 || c.y1 - c.y0 < 100) return;
    doc.update(view.id, { crop: c });
  };
  const mx = (r.x0 + r.x1) / 2;
  const my = (r.y0 + r.y1) / 2;
  const g = (at, f) => ({ at, shape: 'square', title: 'Drag to resize the crop region', drag: (p) => set(f(p)) });
  return [
    g([r.x0, my], (p) => ({ x0: p[0] })),
    g([r.x1, my], (p) => ({ x1: p[0] })),
    g([mx, r.y0], (p) => ({ y0: p[1] })),
    g([mx, r.y1], (p) => ({ y1: p[1] })),
    g([r.x0, r.y0], (p) => ({ x0: p[0], y0: p[1] })),
    g([r.x1, r.y0], (p) => ({ x1: p[0], y0: p[1] })),
    g([r.x1, r.y1], (p) => ({ x1: p[0], y1: p[1] })),
    g([r.x0, r.y1], (p) => ({ x0: p[0], y1: p[1] })),
  ];
}
import { wallAxis, openingSize, rampLayout } from '../core/model.js';
import { sectionFrame } from '../core/plan.js';
import { dimensionGeometry } from '../core/plan.js';

/** Walls whose ends coincide with point p (other than `except`). */
function wallsEndingAt(doc, p, except) {
  const out = [];
  for (const w of doc.all('wall')) {
    if (w.id === except) continue;
    if (eq(w.a, p, 1)) out.push({ id: w.id, end: 'a' });
    else if (eq(w.b, p, 1)) out.push({ id: w.id, end: 'b' });
  }
  return out;
}

/** Grips of view annotations; the same in plans, elevations and sections. */
function annotationGrips(doc, el, out) {
  const end = (key, title = 'Drag end') => out.push({ at: el[key], shape: 'circle', title, exclude: [el.id], drag: (p) => doc.update(el.id, { [key]: p }) });
  switch (el.kind) {
    case 'spot':
      end('at', 'Drag the measured point');
      if (el.leader) end('leader', 'Drag the label');
      break;
    case 'insulation':
      end('a');
      end('b');
      break;
    case 'image': {
      // The far corner scales the picture, keeping its proportions.
      const rot = ((+el.rotation || 0) * Math.PI) / 180;
      const w = +el.w || 1000;
      const hh = +el.h || 1000;
      const corner = add(el.at, [w * Math.cos(rot) - hh * Math.sin(rot), w * Math.sin(rot) + hh * Math.cos(rot)]);
      out.push({ at: corner, shape: 'square', title: 'Drag to resize', exclude: [el.id], drag: (p) => {
        const k = dist(p, el.at) / Math.hypot(w, hh);
        if (k > 0.01) doc.update(el.id, { w: w * k, h: hh * k });
      } });
      break;
    }
    case 'angularDim': {
      let a1 = el.a1;
      while (a1 < el.a0) a1 += Math.PI * 2;
      const am = (el.a0 + a1) / 2;
      out.push({ at: add(el.c, scale([Math.cos(am), Math.sin(am)], el.r)), shape: 'diamond', title: 'Drag the arc', exclude: [el.id], drag: (p) => doc.update(el.id, { r: Math.max(10, dist(el.c, p)) }) });
      break;
    }
    case 'radialDim': {
      const { c, r } = radialTarget(doc, el);
      out.push({ at: add(c, scale([Math.cos(el.angle || 0), Math.sin(el.angle || 0)], r)), shape: 'diamond', title: 'Drag around the circle', noSnap: true, drag: (p) => doc.update(el.id, { angle: angleOf(sub(p, c)) }) });
      break;
    }
    case 'detailArc':
      out.push({ at: add(el.c, scale([Math.cos(el.a0 ?? 0), Math.sin(el.a0 ?? 0)], el.r)), shape: 'diamond', title: 'Drag the radius', exclude: [el.id], drag: (p) => doc.update(el.id, { r: Math.max(1, dist(el.c, p)) }) });
      break;
    case 'revisionCloud':
      (el.boundary || []).forEach((v, i) =>
        out.push({
          at: v,
          shape: 'square',
          title: 'Drag vertex',
          exclude: [el.id],
          drag: (p) => {
            const b = el.boundary.slice();
            b[i] = p;
            doc.update(el.id, { boundary: b });
          },
        }),
      );
      break;
    case 'text':
      (el.leaders || []).forEach((tip, i) =>
        out.push({
          at: tip,
          shape: 'circle',
          title: 'Drag the leader',
          exclude: [el.id],
          drag: (p) => {
            const l = el.leaders.slice();
            l[i] = p;
            doc.update(el.id, { leaders: l });
          },
        }),
      );
      break;
    default:
      break;
  }
}

export function gripsFor(app, el, vc) {
  const doc = app.doc;
  const out = [];
  if (!el) return out;
  if (el.viewId) annotationGrips(doc, el, out);
  if (vc.is2D) {
    switch (el.kind) {
      case 'wall': {
        for (const end of ['a', 'b']) {
          const joined = wallsEndingAt(doc, el[end], el.id);
          out.push({
            at: el[end],
            shape: 'circle',
            title: 'Drag wall end',
            exclude: [el.id, ...joined.map((j) => j.id)],
            drag: (p) => {
              doc.update(el.id, { [end]: p });
              for (const j of joined) doc.update(j.id, { [j.end]: p });
            },
          });
        }
        const ax = wallAxis(doc, el);
        const ext = el.flipped ? -1 : 1;
        out.push({
          at: add(mid(ax.a, ax.b), scale(ax.n, ext * (ax.half + 12 * vc.mmPerPx()))),
          shape: 'flip',
          angle: Math.atan2(ax.n[1], ax.n[0]),
          title: 'Flip wall orientation',
          click: () => app.commit('Flip wall', () => doc.update(el.id, { flipped: !el.flipped })),
        });
        break;
      }
      case 'door':
      case 'window': {
        const host = doc.get(el.hostId);
        if (!host) break;
        const ax = wallAxis(doc, host);
        const c = add(ax.a, scale(ax.dir, el.t));
        const { width } = openingSize(doc, el);
        const face = el.flipFacing ? -1 : 1;
        const off = ax.half + 14 * vc.mmPerPx();
        out.push({
          at: add(c, scale(ax.n, face * (el.kind === 'window' ? -1 : 1) * off)),
          shape: 'flip',
          angle: Math.atan2(ax.n[1], ax.n[0]),
          title: 'Flip facing',
          click: () => app.commit('Flip facing', () => doc.update(el.id, { flipFacing: !el.flipFacing })),
        });
        if (el.kind === 'door') {
          out.push({
            at: add(add(c, scale(ax.dir, width / 2 + 14 * vc.mmPerPx())), scale(ax.n, -face * off)),
            shape: 'flip',
            angle: Math.atan2(ax.dir[1], ax.dir[0]),
            title: 'Flip hand',
            click: () => app.commit('Flip hand', () => doc.update(el.id, { flipHand: !el.flipHand })),
          });
        }
        break;
      }
      case 'grid':
      case 'detailLine':
      case 'roomSeparator':
      case 'beam':
      case 'ramp':
        out.push({ at: el.a, shape: 'circle', title: 'Drag start', exclude: [el.id], drag: (p) => doc.update(el.id, { a: p, b: add(p, sub(el.b, el.a)) }) });
        out.push({ at: rampLayout(doc, el).end, shape: 'circle', title: 'Drag to turn the ramp', exclude: [el.id], drag: (p) => doc.update(el.id, { b: p }) });
        break;
      case 'scopeBox':
        for (const [kx, ky] of [['x0', 'y0'], ['x1', 'y0'], ['x1', 'y1'], ['x0', 'y1']])
          out.push({ at: [el[kx], el[ky]], shape: 'square', title: 'Drag corner', exclude: [el.id], drag: (p) => doc.update(el.id, { [kx]: p[0], [ky]: p[1] }) });
        break;
      case 'propertyLine':
      case 'mass':
        (el.boundary || []).forEach((v, i) =>
          out.push({
            at: v,
            shape: 'square',
            title: 'Drag vertex',
            exclude: [el.id],
            drag: (p) => {
              const b = el.boundary.slice();
              b[i] = p;
              doc.update(el.id, { boundary: b });
            },
          }),
        );
        break;
      case 'topo':
        (el.points || []).forEach((v, i) =>
          out.push({
            at: [v[0], v[1]],
            shape: 'square',
            title: `Drag point (elevation ${v[2]})`,
            exclude: [el.id],
            drag: (p) => {
              const pts = el.points.slice();
              pts[i] = [p[0], p[1], v[2]];
              doc.update(el.id, { points: pts });
            },
          }),
        );
        break;
      case 'stair':
      case 'refPlane':
      case 'modelLine':
      case 'areaBoundary':
      case 'brace':
      case 'truss':
      case 'duct':
      case 'pipe':
      case 'cableTray':
      case 'conduit':
        for (const end of ['a', 'b'])
          out.push({
            at: el[end],
            shape: 'circle',
            title: 'Drag end',
            exclude: [el.id],
            drag: (p) => doc.update(el.id, { [end]: p }),
          });
        break;
      case 'section': {
        for (const end of ['a', 'b'])
          out.push({
            at: el[end],
            shape: 'circle',
            title: 'Drag end',
            exclude: [el.id],
            drag: (p) => doc.update(el.id, { [end]: p }),
          });
        const { look } = sectionFrame(el);
        out.push({
          at: add(mid(el.a, el.b), scale(look, 18 * vc.mmPerPx())),
          shape: 'flip',
          angle: Math.atan2(look[1], look[0]),
          title: 'Flip section',
          click: () => app.commit('Flip section', () => doc.update(el.id, { flip: !el.flip })),
        });
        out.push({
          at: add(mid(el.a, el.b), scale(look, +el.depth || 10000)),
          shape: 'diamond',
          title: 'Drag view depth',
          drag: (p) => doc.update(el.id, { depth: Math.max(100, dot(sub(p, mid(el.a, el.b)), look)) }),
        });
        break;
      }
      case 'floor':
      case 'ceiling':
      case 'roof':
        (el.boundary || []).forEach((v, i) =>
          out.push({
            at: v,
            shape: 'square',
            title: 'Drag vertex',
            exclude: [el.id],
            drag: (p) => {
              const b = el.boundary.slice();
              b[i] = p;
              doc.update(el.id, { boundary: b });
            },
          }),
        );
        break;
      case 'railing':
        (el.path || []).forEach((v, i) =>
          out.push({
            at: v,
            shape: 'square',
            title: 'Drag vertex',
            exclude: [el.id],
            drag: (p) => {
              const b = el.path.slice();
              b[i] = p;
              doc.update(el.id, { path: b });
            },
          }),
        );
        break;
      case 'plan':
      case 'ceilingPlan':
      case 'areaPlan':
        if (el.calloutOf && el.crop) out.push(...cropGrips(doc, el, el.crop).slice(4));
        break;
      case 'room':
      case 'area':
        out.push({ at: el.tagAt || el.at, shape: 'diamond', title: 'Move label', exclude: [el.id], drag: (p) => doc.update(el.id, { tagAt: p }) });
        break;
      case 'dimension': {
        if (!el.refs?.length) break;
        const g = dimensionGeometry(doc, app.scene.walls, el);
        const s0 = Math.min(...g.pos);
        const s1 = Math.max(...g.pos);
        out.push({
          at: g.at((s0 + s1) / 2),
          shape: 'diamond',
          title: 'Move dimension line',
          drag: (p) => {
            const n = perp(g.dir);
            const off = dot(sub(p, el.line), n);
            doc.update(el.id, { line: add(el.line, scale(n, off)) });
          },
        });
        break;
      }
      default:
        break;
    }
  } else if (vc.kind === 'elevation' || vc.kind === 'section') {
    if (el.kind === 'level') {
      const range = vc.modelRange?.(vc.frame());
      const u = (vc.frame().u1 ?? range?.u1 ?? 0) + 12 * (+vc.view.scale || 100);
      out.push({
        at: [u, el.elevation],
        shape: 'circle',
        title: 'Drag level',
        noSnap: true,
        drag: (p) => doc.update(el.id, { elevation: Math.round(p[1]) }),
      });
    } else if (el.kind === 'detailLine') {
      for (const end of ['a', 'b']) out.push({ at: el[end], shape: 'circle', title: 'Drag end', drag: (p) => doc.update(el.id, { [end]: p }) });
    }
  }
  return out;
}

