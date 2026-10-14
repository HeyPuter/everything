/**
 * A small sample house that shows the main element types: layered walls,
 * doors, windows, a floor, a ceiling, a hip roof, rooms, furniture, grids,
 * dimensions and a section.
 */
import { createProject } from './template.js';
import { newId } from './doc.js';
import { VIEW_DEFAULTS } from './template.js';

export function createSampleProject({ system = 'metric' } = {}) {
  const doc = createProject({ system, name: 'Sample House' });
  const [L1, L2] = doc.levels();
  const plan1 = doc.all('plan').find((v) => v.levelId === L1.id);
  doc.transact('Sample', () => {
    doc.update('project', { name: 'Sample House', number: '2026-01', client: 'Example Client', address: '1 Example Street', author: 'Building Design' });
    const ext = { kind: 'wall', typeId: 'wt-ext-brick-stud', levelId: L1.id, baseOffset: 0, topLevelId: L2.id, topOffset: 0, height: 3000, locationLine: 'exterior', joinA: true, joinB: true, roomBounding: true };
    const int = { ...ext, typeId: 'wt-int-partition', locationLine: 'center' };
    const W = 12000;
    const D = 8000;
    // Clockwise, so the exterior is on the left of each wall.
    const west = doc.add({ ...ext, a: [0, 0], b: [0, D] });
    const north = doc.add({ ...ext, a: [0, D], b: [W, D] });
    const east = doc.add({ ...ext, a: [W, D], b: [W, 0] });
    const south = doc.add({ ...ext, a: [W, 0], b: [0, 0] });
    const wa = doc.add({ ...int, a: [7000, 0], b: [7000, D] });
    const wb = doc.add({ ...int, a: [7000, 4500], b: [W, 4500] });
    const wc = doc.add({ ...int, a: [9800, 0], b: [9800, 4500] });

    let mark = 1;
    const door = (host, t, typeId, extra = {}) => doc.add({ kind: 'door', typeId, hostId: host.id, t, flipFacing: false, flipHand: false, mark: String(mark++), ...extra });
    let wmark = 1;
    const win = (host, t, typeId, extra = {}) => doc.add({ kind: 'window', typeId, hostId: host.id, t, mark: `W${wmark++}`, ...extra });
    door(south, 9000, 'dt-single-glass', { flipFacing: true });
    door(wa, 6250, 'dt-single-36', { flipFacing: false });
    door(wa, 2500, 'dt-single-32', { flipHand: true });
    door(wb, 3900, 'dt-single-32', { flipFacing: true });
    win(south, 6200, 'wnt-fixed-72x48');
    win(south, 1700, 'wnt-casement-36x60');
    win(south, 3600, 'wnt-dh-36x60');
    win(north, 2500, 'wnt-picture-96x72');
    win(north, 6000, 'wnt-casement-36x60');
    win(north, 9500, 'wnt-sliding-48x48');
    win(east, 2500, 'wnt-sliding-48x48');
    win(east, 6500, 'wnt-casement-36x60');
    win(west, 4000, 'wnt-dh-36x60');

    const outline = [
      [0, 0],
      [W, 0],
      [W, D],
      [0, D],
    ];
    doc.add({ kind: 'floor', typeId: 'ft-concrete', levelId: L1.id, boundary: outline, holes: [], offset: 0 });
    const inner = [
      [140, 140],
      [W - 140, 140],
      [W - 140, D - 140],
      [140, D - 140],
    ];
    doc.add({ kind: 'ceiling', typeId: 'ct-gypsum', levelId: L1.id, boundary: inner, holes: [], offset: 2700 });
    const o = 600;
    doc.add({
      kind: 'roof',
      typeId: 'rt-shingle',
      levelId: L2.id,
      boundary: [
        [-o, -o],
        [W + o, -o],
        [W + o, D + o],
        [-o, D + o],
      ],
      slopes: [30, 30, 30, 30],
      baseOffset: 0,
    });

    const room = (at, name, number) => doc.add({ kind: 'room', levelId: L1.id, at, name, number, upperOffset: 2700 });
    room([3500, 4000], 'Living', '101');
    room([9500, 6250], 'Bedroom', '102');
    room([8400, 2250], 'Bath', '103');
    room([10900, 2250], 'Bedroom', '104');

    const comp = (typeId, at, rotation = 0, extra = {}) => doc.add({ kind: 'component', typeId, levelId: L1.id, at, rotation, offset: 0, ...extra });
    comp('cpt-sofa', [2600, 5600], 180);
    comp('cpt-coffee', [2600, 4300]);
    comp('cpt-armchair', [4400, 3800], 90);
    comp('cpt-table-dining', [3000, 1700]);
    for (const [x, y, r] of [
      [2500, 1050, 0],
      [3500, 1050, 0],
      [2500, 2350, 180],
      [3500, 2350, 180],
    ])
      comp('cpt-chair', [x, y], r);
    comp('cpt-counter-run', [420, 6000], 90);
    comp('cpt-fridge', [480, 4300], 90);
    comp('cpt-range', [460, 7300], 90);
    comp('cpt-bed-queen', [9600, 6800], 0);
    comp('cpt-nightstand', [8450, 7520]);
    comp('cpt-nightstand', [10750, 7520]);
    comp('cpt-wardrobe', [11420, 5400], -90);
    comp('cpt-bed-single', [11300, 1500], -90);
    comp('cpt-desk', [10900, 3850], 0);
    comp('cpt-toilet', [7500, 3900], 90);
    comp('cpt-sink-vanity', [8500, 4100], 0);
    comp('cpt-bathtub', [8400, 560], 0);
    comp('cpt-tree', [-3500, 9500]);
    comp('cpt-tree', [15500, -2500]);
    comp('cpt-shrub', [5000, -1500]);
    comp('cpt-shrub', [6200, -1400]);

    const grid = (name, a, b) => doc.add({ kind: 'grid', name, a, b });
    grid('1', [0, -2500], [0, D + 2500]);
    grid('2', [7000, -2500], [7000, D + 2500]);
    grid('3', [W, -2500], [W, D + 2500]);
    grid('A', [-2500, 0], [W + 2500, 0]);
    grid('B', [-2500, D], [W + 2500, D]);

    doc.add({
      kind: 'dimension',
      viewId: plan1.id,
      refs: [
        { at: [0, -1500], id: west.id, ref: 'left' },
        { at: [7000, -1500], id: wa.id, ref: 'center' },
        { at: [W, -1500], id: east.id, ref: 'left' },
      ],
      dir: [1, 0],
      line: [0, -1500],
    });
    doc.add({
      kind: 'section',
      id: newId('v'),
      name: 'Section 1',
      a: [5200, D + 2000],
      b: [5200, -2000],
      flip: false,
      scale: plan1.scale,
      ...VIEW_DEFAULTS.section,
      depth: 9000,
    });
    void north;
  });
  doc.clearHistory();
  doc.markSaved();
  return doc;
}
