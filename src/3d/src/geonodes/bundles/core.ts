// Bundles, closures and lists: node types and evaluation (imported with the geometry nodes core).
import './nodes';
import './lists';
import { placeFromLayout } from './menu';

placeFromLayout([
  'NodeCombineBundle',
  'NodeSeparateBundle',
  'NodeGetBundleItem',
  'NodeStoreBundleItem',
  'NodeJoinBundle',
  'NodeClosureInput',
  'NodeEvaluateClosure',
  'GeometryNodeClosureToList',
  'GeometryNodeFieldToList',
  'GeometryNodeFilterList',
  'GeometryNodeListGetItem',
  'GeometryNodeListLength',
  'GeometryNodeSortList',
]);
