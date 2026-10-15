// Add-menu places of zones, mesh operations, sampling and instance nodes, following the menu
// layout of the geometry node editor (labels in order; '---' marks separators).
import { getNodeType } from '../nodes/registry';
import type { MenuCategory, MenuEntry } from '../nodes/types';
import { GEOMETRY_MENU } from './menu';
import { findCategory, insertByRank, moveItems, placeEntries, tidy, category } from './menuplace';

export const MENU_ORDER: Record<string, string[]> = {
  '': ['Input', 'Output', '---', 'Attribute', 'Geometry', '---', 'Curve', 'Grease Pencil', 'Instances', 'Mesh', 'Point', 'Volume', '---', 'Simulation', '---', 'Color', 'Texture', 'Utilities'],
  Attribute: [
    'Attribute Statistic',
    'Domain Size',
    'Get Attribute Names',
    '---',
    'Blur Attribute',
    'Capture Attribute',
    'Remove Named Attribute',
    'Rename Attribute',
    'Store Named Attribute',
    'Transfer Attributes',
  ],
  Geometry: ['Read', 'Sample', 'Write', '---', 'Material', 'Operations', '---', 'Geometry to Instance', 'Join Geometry'],
  'Geometry/Operations': [
    'Bake',
    'Bounding Box',
    'Convex Hull',
    'Delete Geometry',
    'Duplicate Elements',
    'Merge by Distance',
    'Merge Points',
    'Sort Elements',
    'Transform Geometry',
    '---',
    'Get Geometry Component',
    'Separate Components',
    'Separate Geometry',
    'Split to Instances',
  ],
  'Geometry/Sample': ['Geometry Proximity', 'Index of Nearest', 'Raycast', 'Sample Index', 'Sample Nearest'],
  Instances: [
    'Instance on Points',
    'Instances to Points',
    '---',
    'Realize Instances',
    'Rotate Instances',
    'Scale Instances',
    'Set Instance Transform',
    'Translate Instances',
    '---',
    'Instance Bounds',
    'Instance Reference',
    'Instance Transform',
    'Instance Rotation',
    'Instance Scale',
  ],
  Mesh: ['Read', 'Sample', 'Write', '---', 'Operations', 'Primitives', 'Topology', 'UV'],
  'Mesh/Read': [
    'Cluster by Connected',
    'Edge Angle',
    'Edge Neighbors',
    'Edge Vertices',
    'Edges to Face Groups',
    'Face Area',
    'Face Group Boundaries',
    'Face Neighbors',
    'Is Edge Smooth',
    'Is Face Planar',
    'Is Face Smooth',
    'Mesh Island',
    'Shortest Edge Paths',
    'Vertex Neighbors',
  ],
  'Mesh/Sample': ['Sample Nearest Surface', 'Sample UV Surface'],
  'Mesh/Write': ['Set Mesh Normal', 'Set Shade Smooth'],
  'Mesh/Operations': [
    'Dual Mesh',
    'Edge Paths to Curves',
    'Edge Paths to Selection',
    'Extrude Mesh',
    'Flip Faces',
    'Mesh Bevel',
    'Mesh Boolean',
    'Mesh to Curve',
    'Mesh to Density Grid',
    'Mesh to Points',
    'Mesh to SDF Grid',
    'Mesh to Volume',
    'Scale Elements',
    'Split Edges',
    'Subdivide Mesh',
    'Subdivision Surface',
    'Triangulate',
  ],
  'Mesh/Primitives': ['Cone', 'Cube', 'Cylinder', 'Grid', 'Ico Sphere', 'Mesh Circle', 'Mesh Line', 'UV Sphere'],
  'Mesh/UV': ['Pack UV Islands', 'UV Tangent', 'UV Unwrap'],
  Point: [
    'Distribute Points in Grid',
    'Distribute Points in Volume',
    'Distribute Points on Faces',
    '---',
    'Points',
    'Points to Curves',
    'Points to SDF Grid',
    'Points to Vertices',
    'Points to Volume',
    '---',
    'Set Point Radius',
  ],
  Simulation: ['Simulation', '---', 'XPBD Solver'],
  Utilities: [
    'Math',
    'Text',
    'Vector',
    '---',
    'Bundle',
    'Closure',
    'Field',
    'List',
    'Matrix',
    'Rotation',
    'Sound',
    '---',
    'Implicit Conversion',
    'For Each Element',
    'Index Switch',
    'Menu Switch',
    'Random Value',
    'Repeat',
    'Switch',
  ],
};

const e = (idname: string, label?: string): MenuEntry => ({
  idname,
  ...(label ? { label } : {}),
});

/** Menu entries of this module's nodes, by menu path. */
const ENTRIES: Record<string, MenuEntry[]> = {
  Attribute: [e('GeometryNodeTransferAttributes')],
  Geometry: [e('GeometryNodeGeometryToInstance')],
  'Geometry/Operations': [e('GeometryNodeBake'), e('GeometryNodeDuplicateElements'), e('GeometryNodeMergePoints'), e('GeometryNodeSortElements'), e('GeometryNodeSplitToInstances')],
  'Geometry/Sample': [e('GeometryNodeProximity'), e('GeometryNodeIndexOfNearest'), e('GeometryNodeRaycast'), e('GeometryNodeSampleNearest')],
  Instances: [e('GeometryNodeInstancesToPoints')],
  'Mesh/Read': [e('GeometryNodeEdgesToFaceGroups'), e('GeometryNodeMeshFaceSetBoundaries')],
  'Mesh/Sample': [e('GeometryNodeSampleNearestSurface'), e('GeometryNodeSampleUVSurface')],
  'Mesh/Write': [e('GeometryNodeSetMeshNormal')],
  'Mesh/Operations': [
    e('GeometryNodeDualMesh'),
    e('GeometryNodeEdgePathsToCurves'),
    e('GeometryNodeEdgePathsToSelection'),
    e('GeometryNodeMeshBevel'),
    e('GeometryNodeMeshBoolean'),
    e('GeometryNodeScaleElements'),
    e('GeometryNodeSplitEdges'),
  ],
  'Mesh/UV': [e('GeometryNodeUVPackIslands'), e('GeometryNodeUVUnwrap')],
  Point: [e('GeometryNodePoints')],
  Simulation: [e('GeometryNodeSimulationInput', 'Simulation')],
  Utilities: [e('GeometryNodeForeachGeometryElementInput', 'For Each Element'), e('GeometryNodeRepeatInput', 'Repeat')],
};

type Item = MenuCategory['items'][number];

/** Existing top-level "Mesh Primitives" becomes Mesh ▸ Primitives. */
function nestMeshPrimitives() {
  const i = GEOMETRY_MENU.findIndex((c) => c.label === 'Mesh Primitives');
  if (i < 0) return;
  const prims = GEOMETRY_MENU[i];
  GEOMETRY_MENU.splice(i, 1);
  const mesh = category(['Mesh'], MENU_ORDER);
  if (!mesh) return;
  const existing = mesh.items.find((it) => it !== 'SEPARATOR' && !('idname' in it) && it.label === 'Primitives') as MenuCategory | undefined;
  if (existing) for (const it of prims.items) insertByRank(existing.items, it, MENU_ORDER['Mesh/Primitives']);
  else insertByRank(mesh.items, { label: 'Primitives', items: prims.items }, MENU_ORDER.Mesh);
}

/** Loose geometry operations move into Geometry ▸ Operations. */
function nestGeometryOperations() {
  const geo = findCategory(['Geometry']);
  if (!geo) return;
  const ops = MENU_ORDER['Geometry/Operations'].filter((l) => l !== '---');
  moveItems(['Geometry'], ['Geometry', 'Operations'], ops, MENU_ORDER['Geometry/Operations'], { Geometry: MENU_ORDER.Geometry });
  tidy(geo.items as Item[]);
}

export function placeMenus() {
  nestMeshPrimitives();
  nestGeometryOperations();
  for (const [path, entries] of Object.entries(ENTRIES)) {
    const parts = path.split('/');
    const ok = entries.filter((x) => getNodeType(x.idname)?.treeTypes.includes('GEOMETRY'));
    if (!ok.length) continue;
    // parent orders keyed by their path ('' = top level)
    placeEntries(parts, MENU_ORDER[path] ?? [], ok, MENU_ORDER);
  }
}
