/**
 * Grips (direct manipulation handles) of selected elements. Each grip has a
 * position in the view's coordinates, a shape, and either a drag handler
 * (called inside a live transaction with the snapped pointer point) or a
 * click handler.
 */
import { add, sub, scale, perp, mid, dot, eq } from '../core/geom.js';
import { wallAxis, openingSize } from '../core/model.js';
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

export function gripsFor(app, el, vc) {
  const doc = app.doc;
  const out = [];
  if (!el) return out;
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
      case 'stair':
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
      case 'room':
        out.push({ at: el.tagAt || el.at, shape: 'diamond', title: 'Move room tag', exclude: [el.id], drag: (p) => doc.update(el.id, { tagAt: p }) });
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

