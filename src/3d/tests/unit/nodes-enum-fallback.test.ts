// @vitest-environment happy-dom
// Enum properties holding values this version does not know (newer or damaged files) fall back to
// the default instead of breaking shader compilation; enums filled at run time are left alone.
import { it, expect } from 'vitest';
import '../../src/nodes/common';
import '../../src/nodes/shader/defs';
import '../../src/nodes/shader/nodegen';
import '../../src/nodes/shader/extra';
import '../../src/compositor/nodes/defs';
import '../../src/compositor/nodes/extra';
import { getNodeType, propValue, validEnumValue } from '../../src/nodes/registry';
import { addNode, connect, ctxOf } from '../../src/nodes/tree';
import { compileTree } from '../../src/nodes/shader/codegen';
import { emptyDocument } from '../../src/data/defaults';
import type { NodeTreeData } from '../../src/data/types';

function voronoiTree(props: Record<string, string>) {
  const doc = emptyDocument();
  const tree: NodeTreeData = { type: 'SHADER', nodes: [], links: [] };
  const out = addNode(tree, 'ShaderNodeOutputMaterial', [300, 0]);
  const n = addNode(tree, 'ShaderNodeTexVoronoi', [0, 0]);
  Object.assign(n.props, props);
  connect(ctxOf(doc, tree), n.id, 'Color', out.id, 'Surface');
  return compileTree(doc, tree, 'MATERIAL');
}

it('a Voronoi node with unknown enum values compiles like the defaults, with a message', () => {
  const ok = voronoiTree({});
  const bad = voronoiTree({ voronoi_dimensions: '5D', feature: 'NEWEST_FEATURE', distance: 'WARP' });
  expect(bad.body).toBe(ok.body);
  expect(bad.errors.some((e) => /unknown voronoi_dimensions "5D"/.test(e))).toBe(true);
  expect(ok.errors).toEqual([]);
});

it('only fixed enums are checked', () => {
  const vor = getNodeType('ShaderNodeTexVoronoi')!;
  const feature = vor.props.find((p) => p.id === 'feature')!;
  expect(validEnumValue(feature, 'F1')).toBe(true);
  expect(validEnumValue(feature, 'NOPE')).toBe(false);
  expect(propValue({ id: 'n', type: vor.idname, name: 'V', location: [0, 0], inputs: {}, props: { feature: 'NOPE' } }, 'feature')).toBe(feature.d);
  // run-time items (e.g. the layers of an image) accept any stored name
  const img = getNodeType('CompositorNodeImage')!;
  const layer = img.props.find((p) => p.id === 'layer');
  if (layer) expect(validEnumValue(layer, 'RenderLayer')).toBe(true);
});
