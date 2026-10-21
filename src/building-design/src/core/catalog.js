/**
 * Built-in content: categories, materials, element types and project
 * templates. Every value here is original. Sizes are millimetres; imperial
 * projects get types sized and named in nominal inches.
 *
 * Element shapes (all lengths in mm, points are [x, y] in plan):
 *   level        { name, elevation }
 *   grid         { name, a, b }
 *   wall         { typeId, levelId, a, b, baseOffset, topLevelId, topOffset, height,
 *                  locationLine: 'center'|'exterior'|'interior', flipped, roomBounding,
 *                  joinA, joinB, mark, comments }
 *   door         { typeId, hostId, t, flipFacing, flipHand, mark }
 *   window       { typeId, hostId, t, sill, flipFacing, mark }
 *   opening      { hostId, t, width, height, sill }
 *   floor        { typeId, levelId, boundary, holes, offset }
 *   ceiling      { typeId, levelId, boundary, holes, offset }
 *   roof         { typeId, levelId, boundary, slopes, baseOffset }
 *   column       { typeId, levelId, at, rotation, baseOffset, topLevelId, topOffset, height }
 *   beam         { typeId, levelId, a, b, offset }
 *   stair        { typeId, levelId, topLevelId, baseOffset, topOffset, a, b, width }
 *   railing      { typeId, levelId, path, offset }
 *   component    { typeId, levelId, at, rotation, offset }
 *   room         { levelId, at, name, number, upperOffset, tagAt }
 *   roomSeparator{ levelId, a, b }
 *   dimension    { viewId, refs: [{ at, id, ref }], dir, line }
 *   text         { viewId, at, text, size, rotation }
 *   tag          { viewId, targetId, at, leader }
 *   detailLine   { viewId, a, b, style }
 *   refPlane     { a, b, name }                       (shown in every plan)
 *   modelLine    { levelId, a, b, offset, style }
 *   ramp         { typeId, levelId, topLevelId, baseOffset, topOffset, height, a, b, width, railings }
 *   area         { levelId, scheme, at, name, number, tagAt }
 *   areaBoundary { levelId, scheme, a, b }
 *   group        { typeId, levelId, at, rotation }     (members carry groupId)
 */
import { MM_PER_FOOT, MM_PER_INCH } from './units.js';
import { mepTypes } from './mep.js';

const IN = MM_PER_INCH;
const FT = MM_PER_FOOT;

// Categories -------------------------------------------------------------------

/** Visibility categories. `model` categories appear in 3D. */
export const CATEGORIES = [
  { id: 'walls', label: 'Walls', model: true },
  { id: 'doors', label: 'Doors', model: true },
  { id: 'windows', label: 'Windows', model: true },
  { id: 'floors', label: 'Floors', model: true },
  { id: 'ceilings', label: 'Ceilings', model: true },
  { id: 'roofs', label: 'Roofs', model: true },
  { id: 'columns', label: 'Columns', model: true },
  { id: 'beams', label: 'Structural Framing', model: true },
  { id: 'stairs', label: 'Stairs', model: true },
  { id: 'ramps', label: 'Ramps', model: true },
  { id: 'railings', label: 'Railings', model: true },
  { id: 'modelLines', label: 'Lines (Model)', model: true },
  { id: 'furniture', label: 'Furniture', model: true },
  { id: 'casework', label: 'Casework', model: true },
  { id: 'plumbing', label: 'Plumbing Fixtures', model: true },
  { id: 'equipment', label: 'Appliances', model: true },
  { id: 'planting', label: 'Planting', model: true },
  { id: 'lighting', label: 'Lighting Fixtures', model: true },
  { id: 'structuralFoundations', label: 'Structural Foundations', model: true },
  { id: 'braces', label: 'Structural Bracing', model: true },
  { id: 'ducts', label: 'Ducts', model: true },
  { id: 'pipes', label: 'Pipes', model: true },
  { id: 'cableTrays', label: 'Cable Trays', model: true },
  { id: 'conduits', label: 'Conduits', model: true },
  { id: 'mechanical', label: 'Mechanical Equipment', model: true },
  { id: 'airTerminals', label: 'Air Terminals', model: true },
  { id: 'sprinklers', label: 'Sprinklers', model: true },
  { id: 'wires', label: 'Wires', model: false },
  { id: 'electricalEquipment', label: 'Electrical Equipment', model: true },
  { id: 'electricalFixtures', label: 'Electrical Fixtures', model: true },
  { id: 'topography', label: 'Topography', model: true },
  { id: 'site', label: 'Site', model: true },
  { id: 'parking', label: 'Parking', model: true },
  { id: 'masses', label: 'Mass', model: true },
  { id: 'links', label: 'Linked Projects', model: true },
  { id: 'wallSweeps', label: 'Wall Sweeps and Reveals', model: true },
  { id: 'trusses', label: 'Structural Trusses', model: true },
  { id: 'spaces', label: 'Spaces', model: false },
  { id: 'siteCoordinates', label: 'Project Base Point and Survey Point', model: false },
  { id: 'scopeBoxes', label: 'Scope Boxes', model: false },
  { id: 'propertyLines', label: 'Property Lines', model: false },
  { id: 'rooms', label: 'Rooms', model: false },
  { id: 'roomSeparators', label: 'Room Separation Lines', model: false },
  { id: 'areas', label: 'Areas', model: false },
  { id: 'areaBoundaries', label: 'Area Boundary Lines', model: false },
  { id: 'grids', label: 'Grids', model: false },
  { id: 'refPlanes', label: 'Reference Planes', model: false },
  { id: 'levels', label: 'Levels', model: false },
  { id: 'dimensions', label: 'Dimensions', model: false },
  { id: 'text', label: 'Text Notes', model: false },
  { id: 'tags', label: 'Tags', model: false },
  { id: 'lines', label: 'Detail Lines', model: false },
  { id: 'detailItems', label: 'Detail Items', model: false },
  { id: 'revisionClouds', label: 'Revision Clouds', model: false },
  { id: 'genericAnnotations', label: 'Symbols', model: false },
  { id: 'colorLegends', label: 'Color Fill Legends', model: false },
  { id: 'legendComponents', label: 'Legend Components', model: false },
  { id: 'rasterImages', label: 'Raster Images', model: false },
  { id: 'markers', label: 'View Markers', model: false },
];

const KIND_CATEGORY = {
  wall: 'walls',
  door: 'doors',
  window: 'windows',
  opening: 'walls',
  floor: 'floors',
  ceiling: 'ceilings',
  roof: 'roofs',
  column: 'columns',
  beam: 'beams',
  stair: 'stairs',
  railing: 'railings',
  room: 'rooms',
  roomSeparator: 'roomSeparators',
  grid: 'grids',
  level: 'levels',
  dimension: 'dimensions',
  text: 'text',
  tag: 'tags',
  detailLine: 'lines',
  region: 'lines',
  refPlane: 'refPlanes',
  modelLine: 'modelLines',
  ramp: 'ramps',
  area: 'areas',
  areaBoundary: 'areaBoundaries',
  angularDim: 'dimensions',
  radialDim: 'dimensions',
  spot: 'dimensions',
  revisionCloud: 'revisionClouds',
  insulation: 'detailItems',
  detailItem: 'detailItems',
  detailArc: 'lines',
  symbol: 'genericAnnotations',
  colorLegend: 'colorLegends',
  legendComponent: 'legendComponents',
  image: 'rasterImages',
  footing: 'structuralFoundations',
  wallFooting: 'structuralFoundations',
  brace: 'braces',
  duct: 'ducts',
  pipe: 'pipes',
  cableTray: 'cableTrays',
  conduit: 'conduits',
  topo: 'topography',
  propertyLine: 'propertyLines',
  mass: 'masses',
  link: 'links',
  space: 'spaces',
  treadNumbers: 'tags',
  basePoint: 'siteCoordinates',
  scopeBox: 'scopeBoxes',
  truss: 'trusses',
  wire: 'wires',
  importedModel: 'links',
  wallSweep: 'wallSweeps',
};

/** Category of an element (components take theirs from the type). */
export function categoryOf(el, doc) {
  if (el.kind === 'component') return doc?.get(el.typeId)?.category || 'furniture';
  return KIND_CATEGORY[el.kind] || null;
}

/** Human names for element kinds (singular). */
export const KIND_LABEL = {
  wall: 'Wall',
  door: 'Door',
  window: 'Window',
  opening: 'Wall Opening',
  floor: 'Floor',
  ceiling: 'Ceiling',
  roof: 'Roof',
  column: 'Column',
  beam: 'Beam',
  stair: 'Stair',
  railing: 'Railing',
  component: 'Component',
  room: 'Room',
  roomSeparator: 'Room Separator',
  grid: 'Grid',
  level: 'Level',
  dimension: 'Dimension',
  text: 'Text Note',
  tag: 'Tag',
  detailLine: 'Detail Line',
  region: 'Filled Region',
  refPlane: 'Reference Plane',
  modelLine: 'Model Line',
  ramp: 'Ramp',
  area: 'Area',
  areaBoundary: 'Area Boundary',
  group: 'Model Group',
  angularDim: 'Angular Dimension',
  radialDim: 'Radial Dimension',
  spot: 'Spot Dimension',
  revisionCloud: 'Revision Cloud',
  revision: 'Revision',
  insulation: 'Insulation',
  detailItem: 'Detail Item',
  detailArc: 'Detail Arc',
  symbol: 'Symbol',
  colorLegend: 'Color Fill Legend',
  legendComponent: 'Legend Component',
  image: 'Raster Image',
  footing: 'Isolated Foundation',
  wallFooting: 'Wall Foundation',
  brace: 'Brace',
  duct: 'Duct',
  pipe: 'Pipe',
  cableTray: 'Cable Tray',
  conduit: 'Conduit',
  topo: 'Toposurface',
  propertyLine: 'Property Line',
  mass: 'Mass',
  link: 'Linked Project',
  treadNumbers: 'Tread Numbers',
  basePoint: 'Base Point',
  scopeBox: 'Scope Box',
  truss: 'Truss',
  wire: 'Wire',
  importedModel: 'Imported Model',
  wallSweep: 'Wall Sweep',
  space: 'Space',
  zone: 'Zone',
};

export const TYPE_KIND = {
  wall: 'wallType',
  door: 'doorType',
  window: 'windowType',
  floor: 'floorType',
  ceiling: 'ceilingType',
  roof: 'roofType',
  column: 'columnType',
  beam: 'beamType',
  stair: 'stairType',
  railing: 'railingType',
  component: 'componentType',
  ramp: 'rampType',
  group: 'groupType',
  footing: 'footingType',
  wallFooting: 'wallFootingType',
  wallSweep: 'wallSweepType',
  truss: 'trussType',
  brace: 'beamType',
  duct: 'ductType',
  pipe: 'pipeType',
  cableTray: 'cableTrayType',
  conduit: 'conduitType',
};

// Materials ----------------------------------------------------------------------

const MATERIALS = [
  ['mat-default', 'Default', '#c8c8c8', 'none'],
  ['mat-concrete', 'Concrete, Cast-in-Place', '#b9b6ae', 'concrete'],
  ['mat-masonry-brick', 'Masonry, Brick', '#a5553f', 'brick'],
  ['mat-cmu', 'Masonry, Concrete Block', '#a9a69e', 'diag'],
  ['mat-gypsum', 'Gypsum Wall Board', '#f1efe9', 'none'],
  ['mat-stud', 'Metal Stud Layer', '#d6d3cc', 'none'],
  ['mat-wood-frame', 'Wood, Framing', '#cfa978', 'wood'],
  ['mat-insulation', 'Insulation, Batt', '#f2dc8a', 'insulation'],
  ['mat-sheathing', 'Plywood, Sheathing', '#c79a63', 'diag'],
  ['mat-air', 'Air Space', '#e9eef2', 'none'],
  ['mat-membrane', 'Air Barrier', '#5d6672', 'none'],
  ['mat-plaster', 'Plaster, Exterior', '#e6e0d3', 'none'],
  ['mat-siding', 'Siding, Painted Wood', '#e9e6df', 'none'],
  ['mat-wood', 'Wood, Oak', '#b98b57', 'wood'],
  ['mat-wood-light', 'Wood, Birch', '#dcc09a', 'wood'],
  ['mat-steel', 'Steel', '#8d949c', 'solid'],
  ['mat-aluminum', 'Aluminum, Anodized', '#a7adb4', 'solid'],
  ['mat-glass', 'Glass', '#9cc7dd', 'none', 0.65],
  ['mat-roofing', 'Roofing, Asphalt Shingle', '#5b5e63', 'none'],
  ['mat-roof-metal', 'Roofing, Standing Seam Metal', '#6f7880', 'none'],
  ['mat-tile', 'Tile, Porcelain', '#e8e4dc', 'none'],
  ['mat-carpet', 'Carpet', '#8f8a80', 'none'],
  ['mat-timber-floor', 'Wood, Flooring', '#c49a6c', 'none'],
  ['mat-acoustic', 'Acoustic Ceiling Tile', '#f4f3ef', 'none'],
  ['mat-paint-white', 'Paint, White', '#f5f4f0', 'none'],
  ['mat-door', 'Door Panel, Painted', '#ece9e2', 'none'],
  ['mat-fabric', 'Fabric, Upholstery', '#6f7f8e', 'none'],
  ['mat-fabric-warm', 'Fabric, Linen', '#d9cfbf', 'none'],
  ['mat-porcelain', 'Porcelain, White', '#fbfbf8', 'none'],
  ['mat-stone', 'Stone, Countertop', '#9a9690', 'none'],
  ['mat-foliage', 'Foliage', '#5f8f4e', 'none'],
  ['mat-earth', 'Earth', '#8a7356', 'earth'],
];

export function defaultMaterials() {
  return MATERIALS.map(([id, name, color, cut, opacity]) => ({ id, kind: 'material', name, color, cut, opacity: opacity ?? 1 }));
}

// Types --------------------------------------------------------------------------

const L = (materialId, thickness, fn = 'structure') => ({ materialId, thickness, function: fn });

function wallTypes(imp) {
  const t = (mm, inch) => (imp ? inch * IN : mm);
  return [
    {
      id: 'wt-generic',
      name: imp ? 'Generic - 8"' : 'Generic - 200 mm',
      function: 'exterior',
      layers: [L('mat-default', t(200, 8))],
    },
    {
      id: 'wt-ext-brick-stud',
      name: imp ? 'Exterior - Brick on Wood Stud' : 'Exterior - Brick on Timber Frame',
      function: 'exterior',
      layers: [
        L('mat-masonry-brick', t(90, 3.625), 'finish'),
        L('mat-air', t(25, 1), 'air'),
        L('mat-sheathing', t(12, 0.5), 'substrate'),
        L('mat-wood-frame', t(140, 5.5), 'structure'),
        L('mat-gypsum', t(13, 0.5), 'finish'),
      ],
    },
    {
      id: 'wt-ext-siding',
      name: imp ? 'Exterior - Siding on Wood Stud' : 'Exterior - Cladding on Timber Frame',
      function: 'exterior',
      layers: [L('mat-siding', t(19, 0.75), 'finish'), L('mat-sheathing', t(12, 0.5), 'substrate'), L('mat-wood-frame', t(140, 5.5), 'structure'), L('mat-gypsum', t(13, 0.5), 'finish')],
    },
    {
      id: 'wt-ext-concrete',
      name: imp ? 'Exterior - 10" Concrete' : 'Exterior - Concrete 250 mm',
      function: 'exterior',
      layers: [L('mat-plaster', t(20, 0.75), 'finish'), L('mat-concrete', t(250, 10), 'structure'), L('mat-gypsum', t(13, 0.5), 'finish')],
    },
    {
      id: 'wt-ext-cmu',
      name: imp ? 'Exterior - 8" CMU, Insulated' : 'Exterior - Block 200 mm, Insulated',
      function: 'exterior',
      layers: [L('mat-plaster', t(20, 0.75), 'finish'), L('mat-cmu', t(190, 7.625), 'structure'), L('mat-insulation', t(50, 2), 'insulation'), L('mat-gypsum', t(13, 0.5), 'finish')],
    },
    {
      id: 'wt-int-partition',
      name: imp ? 'Interior - 4 7/8" Partition' : 'Interior - 125 mm Partition',
      function: 'interior',
      layers: [L('mat-gypsum', t(13, 0.625), 'finish'), L('mat-stud', t(92, 3.625), 'structure'), L('mat-gypsum', t(13, 0.625), 'finish')],
    },
    {
      id: 'wt-int-partition-wide',
      name: imp ? 'Interior - 6 7/8" Partition' : 'Interior - 175 mm Partition',
      function: 'interior',
      layers: [L('mat-gypsum', t(13, 0.625), 'finish'), L('mat-stud', t(146, 5.625), 'structure'), L('mat-gypsum', t(13, 0.625), 'finish')],
    },
    {
      id: 'wt-int-cmu',
      name: imp ? 'Interior - 6" Masonry' : 'Interior - Block 150 mm',
      function: 'interior',
      layers: [L('mat-cmu', t(150, 6), 'structure')],
    },
    {
      id: 'wt-retaining',
      name: imp ? 'Foundation - 12" Concrete' : 'Foundation - Concrete 300 mm',
      function: 'foundation',
      layers: [L('mat-concrete', t(300, 12), 'structure')],
    },
    {
      id: 'wt-curtain',
      name: 'Curtain Wall - Storefront',
      function: 'exterior',
      layers: [L('mat-glass', t(60, 2.5), 'structure')],
      curtain: { hSpacing: imp ? 5 * FT : 1500, vSpacing: imp ? 4 * FT : 1200, mullionWidth: t(50, 2), mullionDepth: t(150, 6), materialId: 'mat-aluminum' },
    },
  ].map((x) => ({ ...x, kind: 'wallType' }));
}

function floorTypes(imp) {
  const t = (mm, inch) => (imp ? inch * IN : mm);
  return [
    { id: 'ft-generic', name: imp ? 'Generic - 12"' : 'Generic - 300 mm', layers: [L('mat-default', t(300, 12))] },
    { id: 'ft-concrete', name: imp ? 'Concrete - 6" Slab, Tile' : 'Concrete - 150 mm Slab, Tile', layers: [L('mat-tile', t(15, 0.5), 'finish'), L('mat-concrete', t(150, 6), 'structure')] },
    {
      id: 'ft-wood',
      name: imp ? 'Wood Joist - 10" with Flooring' : 'Timber Joist - 250 mm with Flooring',
      layers: [L('mat-timber-floor', t(20, 0.75), 'finish'), L('mat-sheathing', t(18, 0.75), 'substrate'), L('mat-wood-frame', t(235, 9.25), 'structure')],
    },
    { id: 'ft-slab-grade', name: imp ? 'Slab on Grade - 4"' : 'Slab on Grade - 100 mm', layers: [L('mat-concrete', t(100, 4), 'structure')] },
    { id: 'ft-foundation', name: imp ? 'Foundation Slab - 12"' : 'Foundation Slab - 300 mm', layers: [L('mat-concrete', t(300, 12), 'structure')], foundation: true },
  ].map((x) => ({ ...x, kind: 'floorType' }));
}

function roofTypes(imp) {
  const t = (mm, inch) => (imp ? inch * IN : mm);
  return [
    { id: 'rt-generic', name: imp ? 'Generic - 12"' : 'Generic - 300 mm', layers: [L('mat-roofing', t(300, 12))] },
    {
      id: 'rt-shingle',
      name: imp ? 'Wood Rafter - Asphalt Shingle' : 'Timber Rafter - Asphalt Shingle',
      layers: [L('mat-roofing', t(10, 0.375), 'finish'), L('mat-sheathing', t(18, 0.75), 'substrate'), L('mat-wood-frame', t(235, 9.25), 'structure')],
    },
    { id: 'rt-metal', name: 'Standing Seam Metal', layers: [L('mat-roof-metal', t(40, 1.5), 'finish'), L('mat-insulation', t(150, 6), 'insulation'), L('mat-steel', t(10, 0.375), 'structure')] },
    { id: 'rt-concrete', name: imp ? 'Concrete - 8" Flat Roof' : 'Concrete - 200 mm Flat Roof', layers: [L('mat-membrane', t(10, 0.375), 'membrane'), L('mat-insulation', t(100, 4), 'insulation'), L('mat-concrete', t(200, 8), 'structure')] },
  ].map((x) => ({ ...x, kind: 'roofType' }));
}

function ceilingTypes(imp) {
  const t = (mm, inch) => (imp ? inch * IN : mm);
  return [
    { id: 'ct-gypsum', name: imp ? 'Gypsum Board - 5/8"' : 'Plasterboard - 13 mm', layers: [L('mat-gypsum', t(13, 0.625), 'finish')], pattern: 'none' },
    { id: 'ct-acoustic', name: imp ? 'Acoustic Tile - 2\' x 2\'' : 'Acoustic Tile - 600 x 600', layers: [L('mat-acoustic', t(20, 0.75), 'finish')], pattern: imp ? 2 * FT : 600 },
  ].map((x) => ({ ...x, kind: 'ceilingType' }));
}

function doorTypes(imp) {
  const d = (family, mmW, mmH, inW, inH, extra = {}) => {
    const width = imp ? inW * IN : mmW;
    const height = imp ? inH * IN : mmH;
    const size = imp ? `${inW}" x ${inH}"` : `${mmW} x ${mmH} mm`;
    return { family, width, height, size, frameWidth: imp ? 2 * IN : 50, frameDepth: imp ? 5 * IN : 125, thickness: imp ? 1.75 * IN : 44, panelMaterialId: 'mat-door', frameMaterialId: 'mat-wood-light', ...extra };
  };
  const list = [
    ['dt-single-36', 'Single Flush', d('single', 915, 2134, 36, 84)],
    ['dt-single-32', 'Single Flush', d('single', 813, 2134, 32, 84)],
    ['dt-single-30', 'Single Flush', d('single', 762, 2134, 30, 84)],
    ['dt-single-glass', 'Single Glazed', d('single', 915, 2134, 36, 84, { glazing: true })],
    ['dt-double-72', 'Double Flush', d('double', 1830, 2134, 72, 84)],
    ['dt-double-glass', 'Double Glazed', d('double', 1830, 2134, 72, 84, { glazing: true })],
    ['dt-sliding-72', 'Sliding Glass', d('sliding', 1830, 2134, 72, 84, { glazing: true, frameMaterialId: 'mat-aluminum' })],
    ['dt-bifold-48', 'Bifold', d('bifold', 1220, 2032, 48, 80)],
    ['dt-pocket-32', 'Pocket', d('pocket', 813, 2032, 32, 80)],
    ['dt-overhead-96', 'Overhead Sectional', d('overhead', 2440, 2134, 96, 84, { frameMaterialId: 'mat-aluminum' })],
    ['dt-opening-36', 'Cased Opening', d('opening', 915, 2134, 36, 84)],
  ];
  return list.map(([id, family, x]) => ({ id, kind: 'doorType', familyName: family, name: x.size, ...x }));
}

function windowTypes(imp) {
  const w = (family, mmW, mmH, inW, inH, extra = {}) => ({
    family,
    width: imp ? inW * IN : mmW,
    height: imp ? inH * IN : mmH,
    sill: imp ? 36 * IN : 900,
    size: imp ? `${inW}" x ${inH}"` : `${mmW} x ${mmH} mm`,
    frameWidth: imp ? 2.5 * IN : 60,
    frameDepth: imp ? 4 * IN : 100,
    frameMaterialId: 'mat-paint-white',
    ...extra,
  });
  const list = [
    ['wnt-fixed-36x48', 'Fixed', w('fixed', 900, 1200, 36, 48)],
    ['wnt-fixed-72x48', 'Fixed', w('fixed', 1800, 1200, 72, 48)],
    ['wnt-casement-24x48', 'Casement', w('casement', 600, 1200, 24, 48)],
    ['wnt-casement-36x60', 'Casement', w('casement', 900, 1500, 36, 60)],
    ['wnt-dh-36x60', 'Double Hung', w('doubleHung', 900, 1500, 36, 60)],
    ['wnt-sliding-48x48', 'Sliding', w('sliding', 1200, 1200, 48, 48)],
    ['wnt-awning-36x24', 'Awning', w('awning', 900, 600, 36, 24, { sill: imp ? 60 * IN : 1500 })],
    ['wnt-picture-96x72', 'Picture', w('fixed', 2400, 1800, 96, 72, { sill: imp ? 18 * IN : 450 })],
  ];
  return list.map(([id, familyName, x]) => ({ id, kind: 'windowType', familyName, name: x.size, ...x }));
}

function columnTypes(imp) {
  const t = (mm, inch) => (imp ? inch * IN : mm);
  return [
    { id: 'colt-rect-18', name: imp ? 'Rectangular - 18" x 18"' : 'Rectangular - 450 x 450 mm', shape: 'rect', width: t(450, 18), depth: t(450, 18), materialId: 'mat-concrete' },
    { id: 'colt-rect-12x24', name: imp ? 'Rectangular - 12" x 24"' : 'Rectangular - 300 x 600 mm', shape: 'rect', width: t(300, 12), depth: t(600, 24), materialId: 'mat-concrete' },
    { id: 'colt-round-18', name: imp ? 'Round - 18" Diameter' : 'Round - 450 mm Diameter', shape: 'round', width: t(450, 18), depth: t(450, 18), materialId: 'mat-concrete' },
    { id: 'colt-steel-hss', name: imp ? 'Steel Tube - 8" x 8"' : 'Steel Tube - 200 x 200 mm', shape: 'rect', width: t(200, 8), depth: t(200, 8), materialId: 'mat-steel' },
  ].map((x) => ({ ...x, kind: 'columnType', familyName: x.shape === 'round' ? 'Round Column' : 'Rectangular Column' }));
}

function beamTypes(imp) {
  const t = (mm, inch) => (imp ? inch * IN : mm);
  return [
    { id: 'bt-concrete', name: imp ? 'Concrete - 12" x 24"' : 'Concrete - 300 x 600 mm', width: t(300, 12), depth: t(600, 24), materialId: 'mat-concrete' },
    { id: 'bt-steel', name: imp ? 'Steel - 8" x 16"' : 'Steel - 200 x 400 mm', width: t(200, 8), depth: t(400, 16), materialId: 'mat-steel' },
    { id: 'bt-timber', name: imp ? 'Glulam - 5 1/2" x 18"' : 'Glulam - 140 x 450 mm', width: t(140, 5.5), depth: t(450, 18), materialId: 'mat-wood' },
  ].map((x) => ({ ...x, kind: 'beamType', familyName: 'Beam' }));
}

function stairTypes(imp) {
  const t = (mm, inch) => (imp ? inch * IN : mm);
  return [
    { id: 'st-concrete', name: 'Monolithic Concrete', maxRiser: t(180, 7), tread: t(280, 11), width: t(1100, 44), thickness: t(150, 6), materialId: 'mat-concrete', monolithic: true },
    { id: 'st-wood', name: 'Wood Treads', maxRiser: t(180, 7.5), tread: t(260, 10), width: t(1000, 36), thickness: t(40, 1.5), materialId: 'mat-wood', monolithic: false },
  ].map((x) => ({ ...x, kind: 'stairType', familyName: 'Stair' }));
}

function rampTypes(imp) {
  const t = (mm, inch) => (imp ? inch * IN : mm);
  return [
    { id: 'rpt-concrete', name: 'Concrete - 1:12', slopeRatio: 12, width: t(1200, 48), thickness: t(150, 6), materialId: 'mat-concrete' },
    { id: 'rpt-gentle', name: 'Concrete - 1:20', slopeRatio: 20, width: t(1500, 60), thickness: t(150, 6), materialId: 'mat-concrete' },
  ].map((x) => ({ ...x, kind: 'rampType', familyName: 'Ramp' }));
}

function foundationTypes(imp) {
  const t = (mm, inch) => (imp ? inch * IN : mm);
  return [
    { id: 'fdt-pad-1200', kind: 'footingType', familyName: 'Pad Footing', name: imp ? '48" x 48" x 18"' : '1200 x 1200 x 450 mm', width: t(1200, 48), length: t(1200, 48), thickness: t(450, 18), materialId: 'mat-concrete' },
    { id: 'fdt-pad-1800', kind: 'footingType', familyName: 'Pad Footing', name: imp ? '72" x 72" x 24"' : '1800 x 1800 x 600 mm', width: t(1800, 72), length: t(1800, 72), thickness: t(600, 24), materialId: 'mat-concrete' },
    { id: 'wft-600', kind: 'wallFootingType', familyName: 'Wall Foundation', name: imp ? 'Bearing Footing - 24" x 12"' : 'Bearing Footing - 600 x 300 mm', width: t(600, 24), thickness: t(300, 12), materialId: 'mat-concrete' },
    { id: 'wft-900', kind: 'wallFootingType', familyName: 'Wall Foundation', name: imp ? 'Bearing Footing - 36" x 12"' : 'Bearing Footing - 900 x 300 mm', width: t(900, 36), thickness: t(300, 12), materialId: 'mat-concrete' },
  ];
}

function sweepTypes(imp) {
  const t = (mm, inch) => (imp ? inch * IN : mm);
  return [
    { id: 'swt-cornice', name: imp ? 'Cornice - 8" x 10"' : 'Cornice - 200 x 250 mm', profile: 'cornice', width: t(200, 8), height: t(250, 10), materialId: 'mat-plaster' },
    { id: 'swt-band', name: imp ? 'String Course - 4" x 8"' : 'String Course - 100 x 200 mm', profile: 'chamfer', width: t(100, 4), height: t(200, 8), materialId: 'mat-concrete' },
    { id: 'swt-skirting', name: imp ? 'Skirting - 3/4" x 4"' : 'Skirting - 20 x 100 mm', profile: 'skirting', width: t(20, 0.75), height: t(100, 4), materialId: 'mat-wood' },
    { id: 'swt-drip', name: imp ? 'Drip Mould - 2" x 3"' : 'Drip Mould - 50 x 75 mm', profile: 'drip', width: t(50, 2), height: t(75, 3), materialId: 'mat-concrete' },
    { id: 'swt-reveal', name: imp ? 'Reveal - 1" x 1"' : 'Reveal - 20 x 20 mm', profile: 'rect', width: t(20, 0.75), height: t(20, 0.75), materialId: 'mat-default', reveal: true },
  ].map((x) => ({ ...x, kind: 'wallSweepType', familyName: x.reveal ? 'Wall Reveal' : 'Wall Sweep' }));
}

function trussTypes(imp) {
  const t = (mm, inch) => (imp ? inch * IN : mm);
  return [
    { id: 'tt-pratt', name: imp ? 'Pratt - 5\' deep' : 'Pratt - 1500 mm deep', pattern: 'pratt', height: t(1500, 60), chord: t(150, 6), web: t(100, 4), materialId: 'mat-steel' },
    { id: 'tt-warren', name: imp ? 'Warren - 4\' deep' : 'Warren - 1200 mm deep', pattern: 'warren', height: t(1200, 48), chord: t(150, 6), web: t(100, 4), materialId: 'mat-steel' },
    { id: 'tt-howe', name: imp ? 'Howe - Timber 5\'' : 'Howe - Timber 1500 mm', pattern: 'howe', height: t(1500, 60), chord: t(200, 8), web: t(150, 6), materialId: 'mat-wood' },
    { id: 'tt-fink', name: imp ? 'Fink - Roof 6\' rise' : 'Fink - Roof 1800 mm rise', pattern: 'fink', height: t(1800, 72), chord: t(150, 6), web: t(100, 4), materialId: 'mat-wood' },
    { id: 'tt-kingpost', name: imp ? 'King Post - 4\' rise' : 'King Post - 1200 mm rise', pattern: 'kingpost', height: t(1200, 48), chord: t(200, 8), web: t(150, 6), materialId: 'mat-wood' },
  ].map((x) => ({ ...x, kind: 'trussType', familyName: 'Truss' }));
}

function railingTypes(imp) {
  const t = (mm, inch) => (imp ? inch * IN : mm);
  return [
    { id: 'rlt-handrail', name: imp ? 'Handrail - 42"' : 'Handrail - 1100 mm', height: t(1100, 42), spacing: t(110, 4), rail: t(50, 2), baluster: t(20, 0.75), materialId: 'mat-steel', glass: false },
    { id: 'rlt-glass', name: imp ? 'Glass Panel - 42"' : 'Glass Panel - 1100 mm', height: t(1100, 42), spacing: t(1200, 48), rail: t(50, 2), baluster: t(50, 2), materialId: 'mat-aluminum', glass: true },
  ].map((x) => ({ ...x, kind: 'railingType', familyName: 'Railing' }));
}

/**
 * Component families. `family` selects the procedural geometry (families.js);
 * sizes are overall width (x), depth (y) and height (z).
 */
function componentTypes(imp) {
  const t = (mm, inch) => (imp ? inch * IN : mm);
  const c = (id, family, category, familyName, name, w, d, h, extra = {}) => ({ id, kind: 'componentType', family, category, familyName, name, width: w, depth: d, height: h, ...extra });
  return [
    c('cpt-bed-queen', 'bed', 'furniture', 'Bed', imp ? 'Queen 60" x 80"' : 'Double 1600 x 2000 mm', t(1600, 60), t(2050, 82), t(550, 22)),
    c('cpt-bed-single', 'bed', 'furniture', 'Bed', imp ? 'Twin 39" x 75"' : 'Single 900 x 2000 mm', t(950, 39), t(2050, 77), t(550, 22)),
    c('cpt-nightstand', 'cabinet', 'furniture', 'Nightstand', imp ? '20" x 16"' : '500 x 400 mm', t(500, 20), t(400, 16), t(550, 22)),
    c('cpt-sofa', 'sofa', 'furniture', 'Sofa', imp ? '84" Three Seat' : 'Three Seat 2100 mm', t(2100, 84), t(900, 36), t(800, 32)),
    c('cpt-armchair', 'armchair', 'furniture', 'Lounge Chair', imp ? '33"' : '850 mm', t(850, 33), t(850, 33), t(800, 32)),
    c('cpt-table-dining', 'table', 'furniture', 'Dining Table', imp ? '72" x 36"' : '1800 x 900 mm', t(1800, 72), t(900, 36), t(750, 30)),
    c('cpt-table-round', 'roundTable', 'furniture', 'Round Table', imp ? '48" Diameter' : '1200 mm Diameter', t(1200, 48), t(1200, 48), t(750, 30)),
    c('cpt-coffee', 'table', 'furniture', 'Coffee Table', imp ? '48" x 24"' : '1200 x 600 mm', t(1200, 48), t(600, 24), t(420, 17)),
    c('cpt-chair', 'chair', 'furniture', 'Chair', imp ? '18" x 20"' : '450 x 500 mm', t(450, 18), t(520, 20), t(850, 34)),
    c('cpt-desk', 'desk', 'furniture', 'Desk', imp ? '60" x 30"' : '1500 x 750 mm', t(1500, 60), t(750, 30), t(750, 30)),
    c('cpt-office-chair', 'chair', 'furniture', 'Task Chair', imp ? '26"' : '650 mm', t(650, 26), t(650, 26), t(1000, 40)),
    c('cpt-bookshelf', 'shelf', 'furniture', 'Bookshelf', imp ? '36" x 14"' : '900 x 350 mm', t(900, 36), t(350, 14), t(1800, 72)),
    c('cpt-wardrobe', 'cabinet', 'furniture', 'Wardrobe', imp ? '48" x 24"' : '1200 x 600 mm', t(1200, 48), t(600, 24), t(2100, 84)),
    c('cpt-base-cabinet', 'counter', 'casework', 'Base Cabinet', imp ? '36" x 24"' : '900 x 600 mm', t(900, 36), t(600, 24), t(900, 36)),
    c('cpt-counter-run', 'counter', 'casework', 'Counter Run', imp ? '96" x 24"' : '2400 x 600 mm', t(2400, 96), t(600, 24), t(900, 36)),
    c('cpt-upper-cabinet', 'upperCabinet', 'casework', 'Wall Cabinet', imp ? '36" x 12"' : '900 x 350 mm', t(900, 36), t(350, 12), t(750, 30), { elevation: t(1400, 54) }),
    c('cpt-fridge', 'fridge', 'equipment', 'Refrigerator', imp ? '36"' : '900 mm', t(900, 36), t(750, 30), t(1800, 70)),
    c('cpt-range', 'range', 'equipment', 'Range', imp ? '30"' : '760 mm', t(760, 30), t(650, 26), t(900, 36)),
    c('cpt-dishwasher', 'counter', 'equipment', 'Dishwasher', imp ? '24"' : '600 mm', t(600, 24), t(600, 24), t(850, 34)),
    c('cpt-washer', 'washer', 'equipment', 'Washer', imp ? '27"' : '600 mm', t(680, 27), t(700, 28), t(950, 38)),
    c('cpt-toilet', 'toilet', 'plumbing', 'Toilet', 'Floor Mounted', t(380, 15), t(700, 28), t(780, 31)),
    c('cpt-sink-vanity', 'vanity', 'plumbing', 'Vanity Sink', imp ? '36" x 22"' : '900 x 550 mm', t(900, 36), t(550, 22), t(850, 34)),
    c('cpt-sink-kitchen', 'kitchenSink', 'plumbing', 'Kitchen Sink', imp ? '33" Double Bowl' : '800 mm Double Bowl', t(800, 33), t(500, 22), t(200, 8), { elevation: t(700, 28) }),
    c('cpt-bathtub', 'bathtub', 'plumbing', 'Bathtub', imp ? '60" x 30"' : '1700 x 750 mm', t(1700, 60), t(750, 30), t(550, 22)),
    c('cpt-shower', 'shower', 'plumbing', 'Shower', imp ? '36" x 36"' : '900 x 900 mm', t(900, 36), t(900, 36), t(2000, 80)),
    c('cpt-tree', 'tree', 'planting', 'Tree', imp ? 'Deciduous 20\'' : 'Deciduous 6 m', t(4000, 160), t(4000, 160), t(6000, 240)),
    c('cpt-shrub', 'shrub', 'planting', 'Shrub', imp ? '36"' : '900 mm', t(900, 36), t(900, 36), t(900, 36)),
    c('cpt-pendant', 'pendant', 'lighting', 'Pendant Light', imp ? '16"' : '400 mm', t(400, 16), t(400, 16), t(300, 12), { elevation: t(2100, 84) }),
    c('cpt-floor-lamp', 'floorLamp', 'lighting', 'Floor Lamp', imp ? '18"' : '450 mm', t(450, 18), t(450, 18), t(1600, 64)),
    c('cpt-downlight', 'downlight', 'lighting', 'Recessed Downlight', imp ? '6"' : '150 mm', t(150, 6), t(150, 6), t(120, 5), { elevation: t(2700, 108) }),
    c('cpt-sprinkler', 'sprinkler', 'sprinklers', 'Pendant Sprinkler', imp ? 'K5.6 - 1/2 in' : 'K80 - 15 mm', t(70, 2.75), t(70, 2.75), t(60, 2.5), { elevation: t(2640, 104) }),
    c('cpt-diffuser', 'diffuser', 'airTerminals', 'Supply Diffuser', imp ? '24" x 24"' : '600 x 600 mm', t(600, 24), t(600, 24), t(60, 2.5), { elevation: t(2700, 108) }),
    c('cpt-grille', 'grille', 'airTerminals', 'Return Grille', imp ? '24" x 12"' : '600 x 300 mm', t(600, 24), t(300, 12), t(60, 2.5), { elevation: t(2700, 108) }),
    c('cpt-ahu', 'mechUnit', 'mechanical', 'Air Handling Unit', imp ? '72" x 36"' : '1800 x 900 mm', t(1800, 72), t(900, 36), t(1500, 60)),
    c('cpt-fan-coil', 'mechUnit', 'mechanical', 'Fan Coil Unit', imp ? '40" x 24"' : '1000 x 600 mm', t(1000, 40), t(600, 24), t(300, 12), { elevation: t(2700, 108) }),
    c('cpt-water-heater', 'waterHeater', 'plumbing', 'Water Heater', imp ? '24" Diameter' : '600 mm Diameter', t(600, 24), t(600, 24), t(1500, 60)),
    c('cpt-panel', 'panel', 'electricalEquipment', 'Distribution Panel', imp ? '20" x 6"' : '500 x 150 mm', t(500, 20), t(150, 6), t(800, 32), { elevation: t(1200, 48) }),
    c('cpt-receptacle', 'receptacle', 'electricalFixtures', 'Duplex Receptacle', 'Wall Mounted', t(80, 3), t(40, 1.5), t(120, 4.5), { elevation: t(300, 12) }),
    c('cpt-switch', 'switch', 'electricalFixtures', 'Light Switch', 'Wall Mounted', t(80, 3), t(40, 1.5), t(120, 4.5), { elevation: t(1100, 44) }),
    c('cpt-bench', 'bench', 'site', 'Bench', imp ? '72"' : '1800 mm', t(1800, 72), t(500, 20), t(450, 18)),
    c('cpt-bollard', 'bollard', 'site', 'Bollard', imp ? '8" Diameter' : '200 mm Diameter', t(200, 8), t(200, 8), t(900, 36)),
    c('cpt-parking', 'parking', 'parking', 'Parking Space', imp ? '9\' x 18\'' : '2500 x 5000 mm', t(2500, 108), t(5000, 216), t(10, 0.5)),
    c('cpt-parking-access', 'parking', 'parking', 'Accessible Parking Space', imp ? '16\' x 18\'' : '3600 x 5000 mm', t(3600, 192), t(5000, 216), t(10, 0.5)),
  ];
}

export function defaultTypes(system = 'metric') {
  const imp = system === 'imperial';
  return [
    ...wallTypes(imp),
    ...floorTypes(imp),
    ...roofTypes(imp),
    ...ceilingTypes(imp),
    ...doorTypes(imp),
    ...windowTypes(imp),
    ...columnTypes(imp),
    ...beamTypes(imp),
    ...stairTypes(imp),
    ...rampTypes(imp),
    ...railingTypes(imp),
    ...componentTypes(imp),
    ...foundationTypes(imp),
    ...sweepTypes(imp),
    ...trussTypes(imp),
    ...mepTypes(imp),
  ];
}

/** Total thickness of a layered type. */
export function typeThickness(type) {
  if (!type?.layers) return 0;
  let s = 0;
  for (const l of type.layers) s += +l.thickness || 0;
  return s;
}

/** Default type for new elements of a kind (first one, or the remembered one). */
export function defaultTypeFor(doc, kind, preferred) {
  const tk = TYPE_KIND[kind];
  if (!tk) return null;
  if (preferred && doc.get(preferred)?.kind === tk) return doc.get(preferred);
  return doc.all(tk)[0] ?? null;
}

/** Display name "Family: Type" for a type. */
export function typeLabel(t) {
  if (!t) return '';
  const fam = t.familyName || FAMILY_BY_KIND[t.kind] || '';
  return fam ? `${fam}: ${t.name}` : t.name;
}

export const FAMILY_BY_KIND = {
  wallType: 'Wall',
  floorType: 'Floor',
  roofType: 'Roof',
  ceilingType: 'Ceiling',
};
