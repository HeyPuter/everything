// @vitest-environment happy-dom
// Viewport materials are rebuilt when data they read outside the material changes: the text
// data-block an IES Texture node reads.
import { it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import '../../src/nodes/common';
import '../../src/nodes/shader/defs';
import '../../src/nodes/shader/nodegen';
import '../../src/nodes/shader/extra';
import { compileMaterial } from '../../src/nodes/shader/material';
import { setMaterialCompiler, viewportMaterial } from '../../src/render/pbr';
import { addNode, connect, ctxOf, makeGroup } from '../../src/nodes/tree';
import { emptyDocument, newImage, newMaterial, newText } from '../../src/data/defaults';

const ies = (f: string) => readFileSync(resolve(process.cwd(), 'tests/fixtures/shcomp', f), 'utf8');

it('an edited IES text rebuilds the material that reads it', () => {
  const doc = emptyDocument();
  const ma = newMaterial('Lamp');
  doc.materials[ma.id] = ma;
  const text = newText('lamp.ies', ies('symmetric.ies'), 'text');
  doc.texts[text.id] = text;
  const tree = ma.tree;
  const out = tree.nodes.find((n) => n.type === 'ShaderNodeOutputMaterial')!;
  const n = addNode(tree, 'ShaderNodeTexIES', [0, 0], { ies: text.id });
  const em = addNode(tree, 'ShaderNodeEmission', [200, 0]);
  const ctx = ctxOf(doc, tree);
  connect(ctx, n.id, 'Fac', em.id, 'Strength');
  connect(ctx, em.id, 'Emission', out.id, 'Surface');
  let compiles = 0;
  setMaterialCompiler((d, m) => (compiles++, compileMaterial(d, m)));
  viewportMaterial(doc, ma.id);
  viewportMaterial(doc, ma.id);
  expect(compiles).toBe(1);
  text.body = ies('bilateral.ies');
  viewportMaterial(doc, ma.id);
  expect(compiles).toBe(2);
});

it('rebuilds on every real change, not when nodes are moved or selected', () => {
  const doc = emptyDocument();
  const ma = newMaterial('Mat');
  doc.materials[ma.id] = ma;
  const tree = ma.tree;
  const bsdf = tree.nodes.find((n) => n.type === 'ShaderNodeBsdfPrincipled')!;
  const math = addNode(tree, 'ShaderNodeMath', [-200, 0]);
  const ctx = ctxOf(doc, tree);
  let compiles = 0;
  setMaterialCompiler((d, m) => (compiles++, compileMaterial(d, m)));
  const step = () => {
    const before = compiles;
    viewportMaterial(doc, ma.id);
    return compiles - before;
  };
  expect(step()).toBe(1);
  // drawing-only edits
  bsdf.location = [40, 30];
  bsdf.select = true;
  bsdf.hide = true;
  tree.active_node = bsdf.id;
  expect(step()).toBe(0);
  // links, values, mute, material settings
  connect(ctx, math.id, 'Value', bsdf.id, 'Roughness');
  expect(step()).toBe(1);
  math.inputs.Value = 0.25;
  expect(step()).toBe(1);
  math.mute = true;
  expect(step()).toBe(1);
  ma.blend_method = 'BLEND';
  expect(step()).toBe(1);
  // node groups and images
  const gnode = makeGroup(doc, tree, new Set([math.id]))!;
  expect(step()).toBe(1);
  const inner = doc.node_groups[gnode.props.node_tree as string].tree.nodes.find((n) => n.type === 'ShaderNodeMath')!;
  inner.location = [5, 5];
  expect(step()).toBe(0);
  inner.inputs.Value = 0.75;
  expect(step()).toBe(1);
  const img = newImage('tex', 4, 4);
  doc.images[img.id] = img;
  addNode(tree, 'ShaderNodeTexImage', [-400, 0], { image: img.id });
  expect(step()).toBe(1);
  img.revision = (img.revision ?? 0) + 1;
  expect(step()).toBe(1);
});
