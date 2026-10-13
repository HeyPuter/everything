import { describe, it, expect, beforeAll } from 'vitest';
import { inflateSync } from 'node:zlib';
import { installCanvasStub } from './helpers.js';
import { VDocument } from '../src/model/document.js';
import { createPath, createGroup } from '../src/model/nodes.js';
import { rectangle } from '../src/model/shapes.js';
import { exportSVG } from '../src/features/io/svg-export.js';
import { svgToDocument } from '../src/features/io/svg-import.js';
import { writePDF } from '../src/features/io/pdf.js';
import { svgExportHooks, exportBakers } from '../src/features/io/hooks.js';
import { appearanceAttrs, layerAppearanceBaker } from '../src/features/io/svg-appearance.js';
import { stackItems, itemPaint } from '../src/model/appearance.js';
import { exportView } from '../src/features/io/export-view.js';
import { applyBatch } from '../src/features/collab/ops.js';

beforeAll(() => {
  installCanvasStub();
  // What the io feature installs.
  if (!svgExportHooks.attrs.includes(appearanceAttrs)) svgExportHooks.attrs.push(appearanceAttrs);
  if (!exportBakers.includes(layerAppearanceBaker)) exportBakers.push(layerAppearanceBaker);
});

const solid = (color) => ({ type: 'solid', color });
const rect = { x: 0, y: 0, w: 200, h: 200 };
const STACK = [{ type: 'stroke', stroke: solid('#00ff00'), strokeWidth: 10, strokeJoin: 'round', opacity: 0.5 }, { type: 'fill', base: true }, { type: 'stroke', base: true }];

function docWith(...nodes) {
  const doc = VDocument.create({ width: 200, height: 200 });
  const layer = doc.layers()[0].id;
  doc.transact('build', () => nodes.forEach((n) => doc.insert(n, layer)));
  return doc;
}

const latin1 = (b) => Array.from(b, (c) => String.fromCharCode(c)).join('');
function pdfStreams(bytes) {
  const s = latin1(bytes);
  const out = [];
  const re = /<<([^]*?)\/Length (\d+) >>\nstream\n/g;
  let m;
  while ((m = re.exec(s))) {
    const start = m.index + m[0].length;
    const raw = bytes.subarray(start, start + Number(m[2]));
    out.push(/FlateDecode/.test(m[1]) ? latin1(inflateSync(raw)) : latin1(raw));
  }
  return out.join('\n');
}

describe('appearance stacks in SVG', () => {
  it('writes one element per fill and stroke and reads the stack back', () => {
    const node = createPath(rectangle(20, 20, 60, 40), true, { fill: solid('#ff0000'), stroke: solid('#0000ff'), strokeWidth: 2, appearance: STACK, opacity: 0.8 }, { name: 'Badge' });
    const svg = exportSVG(docWith(node), { rect });
    expect(svg).toContain('data-appearance="stack"');
    expect((svg.match(/data-appearance-item=/g) || []).length).toBe(3);
    expect(svg).toContain('data-appearance-item="fill base"');
    expect(svg).toMatch(/stroke="#0f0"|stroke="#00ff00"/);
    const back = svgToDocument(svg);
    const leaves = back.leaves();
    expect(leaves).toHaveLength(1);
    const n = leaves[0];
    expect(n.type).toBe('path');
    expect(n.name).toBe('Badge');
    expect(n.opacity).toBeCloseTo(0.8);
    expect(n.fill).toEqual(solid('#ff0000'));
    expect(n.stroke).toEqual(solid('#0000ff'));
    expect(n.strokeWidth).toBe(2);
    const items = stackItems(n);
    expect(items.map((it) => (it.base ? `${it.type}*` : it.type))).toEqual(['stroke', 'fill*', 'stroke*']);
    expect(itemPaint(n, items[0])).toEqual(solid('#00ff00'));
    expect(items[0]).toMatchObject({ strokeWidth: 10, strokeJoin: 'round', opacity: 0.5 });
  });

  it('keeps groups that are not one outline as groups', () => {
    const a = createPath(rectangle(0, 0, 10, 10), true, { fill: solid('#ff0000'), stroke: null });
    const b = createPath(rectangle(20, 0, 10, 10), true, { fill: solid('#00ff00'), stroke: null });
    const svg = exportSVG(docWith(a, b), { rect }).replace('<path', '<g data-appearance="stack"><path').replace(/(<path[^>]*\/>\s*<path[^>]*\/>)/, '$1</g>');
    const back = svgToDocument(svg);
    expect(back.leaves()).toHaveLength(2);
  });

  it('exports group and layer stacks', () => {
    const a = createPath(rectangle(10, 10, 20, 20), true, { fill: solid('#ff0000'), stroke: null });
    const g = createGroup([a.id], { appearance: [{ type: 'stroke', stroke: solid('#00ff00'), strokeWidth: 4 }, { type: 'contents' }] });
    const doc = VDocument.create({ width: 200, height: 200 });
    const layer = doc.layers()[0];
    doc.transact('build', () => {
      doc.insert(g, layer.id, Infinity, [a]);
      doc.update(layer.id, { appearance: [{ type: 'contents' }, { type: 'fill', fill: solid('#0000ff'), opacity: 0.25 }] });
    });
    doc.repairParents();
    const svg = exportSVG(doc, { rect });
    expect(svg).toContain('data-appearance-item="stroke"');
    expect(svg).toContain('data-appearance-item="fill"');
    expect(svg).toMatch(/fill="#(00f|0000ff)"/);
    // The layer's own fill paints over its contents.
    const view = exportView(doc);
    const baked = view.get(layer.id);
    expect(baked.children).toHaveLength(2);
    expect(baked.appearance).toBeUndefined();
  });
});

describe('appearance stacks in PDF and collaboration', () => {
  it('draws every fill and stroke in PDF', async () => {
    const node = createPath(rectangle(20, 20, 60, 40), true, { fill: solid('#ff0000'), stroke: solid('#0000ff'), strokeWidth: 2, appearance: STACK });
    const streams = pdfStreams((await writePDF(docWith(node), [rect])).bytes);
    // A wide green stroke, the red fill and the blue stroke.
    expect(streams).toMatch(/0 1 0 RG/);
    expect(streams).toMatch(/1 0 0 rg/);
    expect(streams).toMatch(/0 0 1 RG/);
    expect(streams).toMatch(/\n10 w\n|\b10 w\b/);
  });

  it('replays stack edits in shared documents', () => {
    const node = createPath(rectangle(20, 20, 60, 40), true, { fill: solid('#ff0000') });
    const doc = docWith(node);
    const copy = VDocument.fromJSON(JSON.parse(JSON.stringify(doc.toJSON())));
    applyBatch(copy, { id: 'b1', nodes: [{ id: node.id, set: { appearance: STACK } }] });
    expect(copy.get(node.id).appearance).toEqual(STACK);
    applyBatch(copy, { id: 'b2', nodes: [{ id: node.id, unset: ['appearance'] }] });
    expect(copy.get(node.id).appearance).toBeUndefined();
  });
});
