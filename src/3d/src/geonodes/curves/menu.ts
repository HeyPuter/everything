// Add-menu placement of the curve, text, import, Grease Pencil and gizmo nodes. Entries are
// inserted into the geometry Add menu in the order of the full menu layout (listed below), so
// nodes registered by other families keep their places.
import { GEOMETRY_MENU } from '../menu';
import { getNodeType } from '../../nodes/registry';
import type { MenuCategory, MenuEntry } from '../../nodes/types';

type Item = MenuEntry | MenuCategory | 'SEPARATOR';

/** Order of items (node labels or submenu labels) per menu path. */
const ORDER: Record<string, string[]> = {
  '': ['Input', 'Output', 'Attribute', 'Geometry', 'Curve', 'Grease Pencil', 'Instances', 'Mesh', 'Mesh Primitives', 'Point', 'Volume', 'Simulation', 'Material', 'Texture', 'Utilities', 'Vector'],
  Input: ['Constant', 'Gizmo', 'Group', 'Import', 'Scene'],
  'Input/Gizmo': ['Dial Gizmo', 'Linear Gizmo', 'Transform Gizmo'],
  'Input/Import': ['CSV (.csv)', 'Wavefront (.obj)', 'Stanford PLY (.ply)', 'STL (.stl)', 'Text (.txt)', 'OpenVDB (.vdb)'],
  Curve: ['Read', 'Sample', 'Write', 'Operations', 'Primitives', 'Topology'],
  'Curve/Read': [
    'Curve Handle Positions',
    'Curve Length',
    'Curve Tangent',
    'Curve Tilt',
    'Endpoint Selection',
    'Handle Type Selection',
    'Is Spline Cyclic',
    'Spline Length',
    'Spline Parameter',
    'Spline Resolution',
  ],
  'Curve/Sample': ['Sample Curve'],
  'Curve/Write': [
    'Set Curve Normal',
    'Set Curve Radius',
    'Set Curve Tilt',
    'Set Handle Positions',
    'Set Handle Type',
    'Set NURBS Order',
    'Set NURBS Weight',
    'Set Spline Cyclic',
    'Set Spline Resolution',
    'Set Spline Type',
  ],
  'Curve/Operations': [
    'Curve to Mesh',
    'Curve to Points',
    'Curves to Grease Pencil',
    'Deform Curves on Surface',
    'Fill Curve',
    'Fillet Curve',
    'Interpolate Curves',
    'Resample Curve',
    'Reverse Curve',
    'Subdivide Curve',
    'Trim Curve',
  ],
  'Curve/Primitives': ['Arc', 'Bézier Segment', 'Curve Circle', 'Curve Line', 'Spiral', 'Quadratic Bézier', 'Quadrilateral', 'Star'],
  'Curve/Topology': ['Curve of Point', 'Offset Point in Curve', 'Points of Curve'],
  'Grease Pencil': ['Read', 'Write', 'Operations'],
  'Grease Pencil/Read': ['Named Layer Selection'],
  'Grease Pencil/Write': ['Set Grease Pencil Color', 'Set Grease Pencil Depth', 'Set Grease Pencil Softness'],
  'Grease Pencil/Operations': ['Grease Pencil to Curves', 'Merge Layers'],
  Point: [
    'Distribute Points in Grid',
    'Distribute Points in Volume',
    'Distribute Points on Faces',
    'Points',
    'Points to Curves',
    'Points to SDF Grid',
    'Points to Vertices',
    'Points to Volume',
    'Set Point Radius',
  ],
  Utilities: ['Math', 'Text', 'Vector', 'Bundle', 'Closure', 'Field', 'List', 'Matrix', 'Rotation', 'Sound'],
  'Utilities/Text': [
    'Format String',
    'Join Strings',
    'Match String',
    'Replace String',
    'Reverse String',
    'Slice String',
    'Set String Case',
    'Split String',
    'Trim String',
    'Find in String',
    'String Length',
    'String to Curves',
    'String to Value',
    'Value to String',
    'Special Characters',
    'Tag Filter',
  ],
  'Utilities/Sound': ['Sample Sound Frequencies'],
};

const labelOf = (it: Item): string => (it === 'SEPARATOR' ? '' : 'idname' in it ? (it.label ?? getNodeType(it.idname)?.label ?? it.idname) : it.label);
const isCategory = (it: Item): it is MenuCategory => it !== 'SEPARATOR' && 'items' in it;

/** Insert `item` into `items` after the last item that comes before it in `order`. */
function insertOrdered(items: Item[], item: Item, order: string[]) {
  const label = labelOf(item);
  const rank = order.indexOf(label);
  let at = -1;
  if (rank >= 0) {
    for (let i = 0; i < items.length; i++) {
      const r = order.indexOf(labelOf(items[i]));
      if (r >= 0 && r < rank) at = i;
    }
    if (at < 0) {
      // before the first item that comes after it
      const after = items.findIndex((it) => order.indexOf(labelOf(it)) > rank);
      if (after >= 0) {
        items.splice(after, 0, item);
        return;
      }
      at = items.length - 1;
    }
  } else at = items.length - 1;
  items.splice(at + 1, 0, item);
}

function category(path: string[]): MenuCategory | { items: Item[] } {
  let items: Item[] = GEOMETRY_MENU as Item[];
  let node: MenuCategory | { items: Item[] } = { items };
  const done: string[] = [];
  for (const name of path) {
    let cat = items.find((it): it is MenuCategory => isCategory(it) && it.label === name);
    if (!cat) {
      cat = { label: name, items: [] };
      insertOrdered(items, cat, ORDER[done.join('/')] ?? []);
    }
    done.push(name);
    node = cat;
    items = cat.items;
  }
  return node;
}

/** Place a node entry in the geometry Add menu (`path` like 'Curve/Read'). */
export function place(path: string, idname: string, label?: string) {
  const cat = category(path.split('/'));
  if (cat.items.some((it) => it !== 'SEPARATOR' && 'idname' in it && it.idname === idname && (it.label ?? '') === (label ?? ''))) return;
  const entry: MenuEntry = label ? { idname, label } : { idname };
  const order = ORDER[path] ?? [];
  insertOrdered(cat.items, entry, order);
  sortKnown(cat.items, order);
}

/** Reorder the items listed in `order` among the slots they occupy (other items stay put). */
function sortKnown(items: Item[], order: string[]) {
  const slots: number[] = [];
  items.forEach((it, i) => {
    if (order.includes(labelOf(it))) slots.push(i);
  });
  const sorted = slots.map((i) => items[i]).sort((a, b) => order.indexOf(labelOf(a)) - order.indexOf(labelOf(b)));
  slots.forEach((s, k) => (items[s] = sorted[k]));
}
