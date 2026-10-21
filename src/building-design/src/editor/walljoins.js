/**
 * Wall Joins: click near where two walls meet to cycle the corner through
 * a miter and a butt join either way round.
 */
import { Tool } from './tool.js';
import { dist } from '../core/geom.js';
import { PLAN_VIEW_KINDS } from '../core/doc.js';

const NEAR = 400;

export class WallJoinsTool extends Tool {
  get title() {
    return 'Wall Joins';
  }

  get viewKinds() {
    return PLAN_VIEW_KINDS;
  }

  get prompt() {
    return 'Click near a corner where two walls meet to change how they join';
  }

  /** The two wall ends meeting nearest to a point: [{ wall, end }, { wall, end }]. */
  cornerAt(p) {
    const levelId = this.vc.view.levelId;
    const ends = [];
    for (const w of this.doc.all('wall')) {
      if (w.levelId !== levelId) continue;
      if (w.joinA !== false) ends.push({ wall: w, end: 'A', p: w.a });
      if (w.joinB !== false) ends.push({ wall: w, end: 'B', p: w.b });
    }
    let best = null;
    for (const e of ends) {
      const d = dist(e.p, p);
      if (d > NEAR) continue;
      const mates = ends.filter((o) => o.wall.id !== e.wall.id && dist(o.p, e.p) < 2);
      if (mates.length !== 1) continue;
      if (!best || d < best.d) best = { d, pair: [e, mates[0]] };
    }
    return best?.pair ?? null;
  }

  move(ev) {
    this.pair = ev.p ? this.cornerAt(ev.p) : null;
    this.app.setHover(this.pair?.[0].wall.id ?? null);
    this.app.requestRender();
  }

  down(ev) {
    if (!ev.p) return;
    const pair = this.cornerAt(ev.p);
    if (!pair) return this.app.setPrompt('No corner of two walls there');
    const key = (e) => `joinStyle${e.end}`;
    const [a, b] = pair;
    const sa = a.wall[key(a)] === 'butt';
    const sb = b.wall[key(b)] === 'butt';
    // Miter -> first wall butts -> second wall butts -> miter.
    const next = !sa && !sb ? ['butt', 'miter'] : sa ? ['miter', 'butt'] : ['miter', 'miter'];
    this.app.commit('Wall join', () => {
      this.doc.update(a.wall.id, { [key(a)]: next[0] });
      this.doc.update(b.wall.id, { [key(b)]: next[1] });
    });
    this.app.setPrompt(next[0] === 'butt' || next[1] === 'butt' ? 'Butt join. Click again to swap which wall runs through.' : 'Mitered corner.');
  }
}
