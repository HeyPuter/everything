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
import { addNode, connect, ctxOf } from '../../src/nodes/tree';
import { emptyDocument, newMaterial, newText } from '../../src/data/defaults';

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
