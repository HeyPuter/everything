import { createProject } from '../src/core/template.js';

/** A metric project with helpers to add elements in one transaction each. */
export function project(system = 'metric') {
  const doc = createProject({ system });
  const levels = doc.levels();
  const add = (el) => doc.transact('add', () => doc.add(el));
  const wall = (a, b, extra = {}) => add({ kind: 'wall', typeId: 'wt-generic', levelId: levels[0].id, a, b, baseOffset: 0, topLevelId: levels[1].id, topOffset: 0, height: 3000, locationLine: 'center', ...extra });
  /** Closed rectangle of walls, returns the four walls. */
  const box = (x0, y0, x1, y1, extra) => [wall([x0, y0], [x1, y0], extra), wall([x1, y0], [x1, y1], extra), wall([x1, y1], [x0, y1], extra), wall([x0, y1], [x0, y0], extra)];
  return { doc, levels, add, wall, box, L1: levels[0], L2: levels[1] };
}
