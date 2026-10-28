import { UnsupportedDocumentError } from './errors.js';
import { elementChildren } from './docx-xml.js';

const DGM = 'http://schemas.openxmlformats.org/drawingml/2006/diagram';
const pointTypes = new Set(['doc', 'node', 'asst', 'parTrans', 'sibTrans', 'pres']);
const connectionTypes = new Set(['parOf', 'presOf', 'presParOf', 'unknownRelationship']);
const fail = reason => { throw new UnsupportedDocumentError(`diagram data with ${reason}`); };
const children = node => node?.children ? elementChildren(node) : [];
function list(root, name, optional = false) {
  const matches = children(root).filter(n => n.namespaceURI === DGM && n.localName === name);
  if (optional && !matches.length) return [];
  if (matches.length !== 1) fail(`missing or duplicate ${name}`);
  return children(matches[0]);
}
function ordinal(node, name) {
  const text = node.getAttribute(name);
  if (text === null) return 0;
  if (!/^\d+$/.test(text) || Number(text) > 0xffffffff) fail(`invalid ${name}`);
  return Number(text);
}

// ECMA-376 Part 1 21.4.3: retain the data graph separately from its presentation
// graph and cached drawings. Nodes retain their source XML for later styling;
// this reader never rewrites a package or treats the drawing cache as layout.
export function readDiagramDataModel(root) {
  if (root?.namespaceURI !== DGM || root.localName !== 'dataModel') fail('an invalid model root');
  const points = new Map(), connections = new Map(), outgoing = new Map(), parent = new Map();
  for (const xml of list(root, 'ptLst')) {
    if (xml.namespaceURI !== DGM || xml.localName !== 'pt') fail('an unsupported point-list child');
    const id = xml.getAttribute('modelId'), type = xml.getAttribute('type') || 'node';
    if (!id || points.has(id) || !pointTypes.has(type)) fail('missing, duplicate or unsupported points');
    points.set(id, { id, type, xml, order: points.size });
  }
  const roots = [...points.values()].filter(p => p.type === 'doc');
  if (roots.length !== 1) fail('missing or ambiguous document points');
  for (const xml of list(root, 'cxnLst', true)) {
    if (xml.namespaceURI !== DGM || xml.localName !== 'cxn') fail('an unsupported connection-list child');
    const id = xml.getAttribute('modelId'), type = xml.getAttribute('type') || 'parOf';
    const source = points.get(xml.getAttribute('srcId')), destination = points.get(xml.getAttribute('destId'));
    if (!id || connections.has(id) || points.has(id) || !connectionTypes.has(type) || !source || !destination) fail('invalid connection identities or endpoints');
    const connection = { id, type, source, destination, sourceOrder: ordinal(xml, 'srcOrd'), destinationOrder: ordinal(xml, 'destOrd'), xml };
    connections.set(id, connection);
    if (type !== 'parOf') continue;
    if (!['doc', 'node', 'asst'].includes(source.type) || !['node', 'asst'].includes(destination.type) || parent.has(destination.id)) fail('an unsupported parent graph');
    parent.set(destination.id, connection);
    if (!outgoing.has(source.id)) outgoing.set(source.id, []);
    outgoing.get(source.id).push(connection);
  }
  // A nil-GUID document root is repaired and its children renumbered in point
  // storage order. A paired native control differing only in root identity
  // preserves declared srcOrd with a non-nil root. Do not generalize the repair
  // behavior to normal graphs or rewrite the original package identities.
  const repairedRoot = roots[0].id === '{00000000-0000-0000-0000-000000000000}';
  for (const edges of outgoing.values()) edges.sort((a, b) =>
    (!repairedRoot ? a.sourceOrder - b.sourceOrder : 0) || a.destination.order - b.destination.order);
  const visited = new Set(), queue = [roots[0]];
  for (let i = 0; i < queue.length; i++) {
    const point = queue[i];
    if (visited.has(point.id)) fail('a cyclic parent graph');
    visited.add(point.id);
    for (const edge of outgoing.get(point.id) || []) queue.push(edge.destination);
  }
  for (const point of points.values()) {
    if (['node', 'asst'].includes(point.type) && !visited.has(point.id)) fail('disconnected or cyclic data points');
    if (['parTrans', 'sibTrans'].includes(point.type)) {
      const connection = connections.get(point.xml.getAttribute('cxnId'));
      if (!connection || connection.type !== 'parOf') fail('an unresolved transition');
    }
  }
  for (const connection of connections.values()) if (connection.type === 'parOf') {
    for (const [attribute, type] of [['parTransId', 'parTrans'], ['sibTransId', 'sibTrans']]) {
      const id = connection.xml.getAttribute(attribute);
      if (id === null) continue;
      const point = points.get(id);
      if (!point || point.type !== type || point.xml.getAttribute('cxnId') !== connection.id) fail('inconsistent transition links');
    }
  }
  return { root: roots[0], points, connections, outgoing, parent };
}

export function diagramDataChildren(model, point = model.root) {
  return (model.outgoing.get(point.id) || []).map(edge => edge.destination);
}
