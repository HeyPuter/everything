import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import opentype from 'opentype.js';
import { installCanvasStub } from './helpers.js';
import { VDocument } from '../src/model/document.js';
import { createPath, createGroup, createText } from '../src/model/nodes.js';
import { rectangle, ellipse } from '../src/model/shapes.js';
import { anchor } from '../src/model/bezier.js';
import { liveArtwork, isLive, liveDef } from '../src/model/live.js';
import { nodeBounds, visualBounds } from '../src/model/geometry.js';
import { hitTest } from '../src/render/hit.js';
import { exportSVG } from '../src/features/io/svg-export.js';
import { writePDF } from '../src/features/io/pdf.js';
import { expandNodeAppearance, hasExpandableAppearance } from '../src/ops/expand-appearance.js';
import { normalizeEffect, effectLabel, createEffect } from '../src/features/paint/effects-model.js';
import { registerMeasureFont } from '../src/model/text-layout.js';
import { registerOutlineFont } from '../src/features/type/fonts.js';
import '../src/features/effects/registry.js';
import '../src/features/effects/text-effects.js';
import '../src/features/three-d/index.js';
import { newParams, threeDOf, VIEWS } from '../src/features/three-d/params.js';
import { orderPolys, faceGradient, buildModels, renderModels, makeCamera, clearMeshCache } from '../src/features/three-d/scene.js';
import { shade, MATERIALS, environment, baseColorOf, paintColor } from '../src/features/three-d/shading.js';
import { setDraft, sourceItems } from '../src/features/three-d/live-kind.js';
import { normalize } from '../src/features/three-d/math.js';

beforeAll(() => {
  installCanvasStub();
  const buf = readFileSync(resolve(process.cwd(), 'node_modules/@fontsource/inter/files/inter-latin-400-normal.woff'));
  const font = opentype.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  registerMeasureFont('Inter', 400, 'normal', font);
  registerOutlineFont('Inter', 400, 'normal', font);
});

const solid = (color) => ({ type: 'solid', color });
const fx3d = (kind, extra = {}) => normalizeEffect({ type: 'threeD', ...newParams(kind), ...extra });

function docWith(...nodes) {
  const doc = VDocument.create({ width: 600, height: 600 });
  const layer = doc.layers()[0].id;
  doc.transact('add', () => {
    for (const n of nodes) {
      if (n.kids) doc.insert(n.node, layer, Infinity, n.kids);
      else doc.insert(n, layer);
    }
  });
  doc.repairParents();
  return { doc, layer };
}

const rectPath = (x, y, w, h, style = {}) => createPath(rectangle(x, y, w, h), true, { fill: solid('#3366cc'), stroke: null, ...style });

/** Generated leaf nodes (paths and compounds) in paint order. */
function leaves(doc, node) {
  const { items, vdoc } = liveArtwork(doc, node);
  const out = [];
  const visit = (n) => {
    if (n.type === 'group') n.children.forEach((c) => visit(vdoc.get(c)));
    else out.push(n);
  };
  items.forEach(visit);
  return out;
}

describe('3D effect record', () => {
  it('normalizes and labels 3D records like other effects', () => {
    const e = normalizeEffect({ type: 'threeD', kind: 'revolve', angle: 900, rotX: 270, steps: 7.6, color: 'nope', material: 'bogus' });
    expect(e.angle).toBe(360);
    expect(e.rotX).toBe(-90);
    expect(e.steps).toBe(8);
    expect(e.color).toBe('');
    expect(e.material).toBe('satin');
    expect(effectLabel(e)).toBe('3D: Revolve');
    expect(createEffect('threeD', { kind: 'inflate' }).kind).toBe('inflate');
    // Rotate starts flat-colored, Inflate glossy.
    expect(newParams('rotate').material).toBe('unlit');
    expect(newParams('inflate').specular).toBeGreaterThan(newParams('extrude').specular);
  });
});

describe('3D ordering and shading', () => {
  const quad = (z, s = 10, dx = 0) => ({ pts: [[-s + dx, -s, z], [s + dx, -s, z], [s + dx, s, z], [-s + dx, s, z]], holes: [], id: z });

  it('orders faces back to front with and without perspective, BSP or sorted', () => {
    for (const eye of [null, [0, 0, 100]]) {
      for (const draft of [false, true]) {
        const out = orderPolys([quad(10), quad(-10), quad(0)], eye, { draft });
        expect(out.map((p) => p.id)).toEqual([-10, 0, 10]);
      }
    }
  });

  it('splits faces that cross each other so either can be in front', () => {
    const a = { pts: [[-10, -10, -10], [10, -10, 10], [10, 10, 10], [-10, 10, -10]], holes: [], id: 'a' };
    const b = { pts: [[-10, -10, 10], [10, -10, -10], [10, 10, -10], [-10, 10, 10]], holes: [], id: 'b' };
    const out = orderPolys([a, b], null, {});
    expect(out.length).toBe(3);
    // Of the two halves of the split face, the one nearer the viewer comes last.
    const last = out[out.length - 1];
    const z = last.pts.reduce((s, p) => s + p[2], 0) / last.pts.length;
    expect(z).toBeGreaterThan(0);
  });

  it('keeps holes when splitting caps', () => {
    const cap = { pts: [[-20, -20, 0], [20, -20, 0], [20, 20, 0], [-20, 20, 0]], holes: [[[-5, -5, 0], [-5, 5, 0], [5, 5, 0], [5, -5, 0]]], id: 'cap' };
    const wall = { pts: [[0, -30, -10], [0, 30, -10], [0, 30, 10], [0, -30, 10]], holes: [], id: 'wall' };
    const out = orderPolys([wall, cap], null, {});
    const pieces = out.filter((p) => p.id === 'cap');
    expect(pieces.length + out.filter((p) => p.id === 'wall').length).toBeGreaterThanOrEqual(3);
    expect(out.filter((p) => p.split && p.holes.length).length).toBeGreaterThan(0);
  });

  it('shades faces turned to the light brighter, with highlights and quantized bands', () => {
    const base = [0.2, 0.4, 0.8];
    const light = { dir: normalize([0, -1, 1]), color: [1, 1, 1], intensity: 0.9, ambient: 0.2 };
    const mat = MATERIALS.find((m) => m.id === 'satin');
    const lit = shade(base, normalize([0, -1, 1]), [0, 0, 1], mat, light);
    const dark = shade(base, [0, 1, 0], [0, 0, 1], mat, light);
    expect(lit[2]).toBeGreaterThan(dark[2]);
    expect(dark[2]).toBeCloseTo(base[2] * 0.2, 2);
    // A mirror-like highlight whitens the color.
    const half = normalize([0, -1, 2.414]);
    const gloss = shade(base, half, [0, 0, 1], MATERIALS.find((m) => m.id === 'gloss'), light);
    expect(gloss[0]).toBeGreaterThan(0.6);
    expect(shade(base, half, [0, 0, 1], MATERIALS.find((m) => m.id === 'unlit'), light)).toEqual(base);
    // Banded shading collapses a sweep of normals to a few tones.
    const tones = new Set();
    for (let a = 0; a <= 90; a += 2) {
      const t = (a * Math.PI) / 180;
      tones.add(shade(base, [0, -Math.sin(t), Math.cos(t)], [0, 0, 1], MATERIALS.find((m) => m.id === 'matte'), light, 4).map((v) => v.toFixed(4)).join());
    }
    expect(tones.size).toBeLessThanOrEqual(5);
    expect(environment([0, -1, 0])).toBeGreaterThan(environment([0, 1, 0]));
  });

  it('takes the base color from the fill, then the stroke', () => {
    expect(baseColorOf({ fill: solid('#112233') })).toBe('#112233');
    expect(baseColorOf({ fill: null, stroke: solid('#445566') })).toBe('#445566');
    expect(baseColorOf({ fill: solid('#112233') }, '#abcdef')).toBe('#abcdef');
    expect(paintColor({ type: 'linear', stops: [{ offset: 0, color: '#000000' }, { offset: 1, color: '#ffffff' }] })).toMatch(/^#[78]/);
  });

  it('fits smooth-shading gradients through corner colors', () => {
    const g = faceGradient(
      [
        [0, 0],
        [10, 0],
        [10, 10],
        [0, 10],
      ],
      [
        [0, 0, 0],
        [1, 1, 1],
        [1, 1, 1],
        [0, 0, 0],
      ],
    );
    expect(g.type).toBe('linear');
    expect(g.x2 - g.x1).toBeCloseTo(10);
    expect(Math.abs(g.y2 - g.y1)).toBeLessThan(1e-9);
    expect(g.stops[0].color).toBe('#000000');
    expect(g.stops[g.stops.length - 1].color).toBe('#ffffff');
    expect(faceGradient([[0, 0], [1, 0], [0, 1]], [[0.5, 0.5, 0.5], [0.5, 0.5, 0.5], [0.5, 0.5, 0.5]])).toBe(null);
  });

  it('projects with perspective: nearer points spread out', () => {
    const cam = makeCamera(60, 50, [0, 0]);
    expect(Math.abs(cam.project([10, 0, 40])[0])).toBeGreaterThan(Math.abs(cam.project([10, 0, -40])[0]));
    const flat = makeCamera(0, 50, [5, 5]);
    expect(flat.project([10, 0, 40])).toEqual([15, 5]);
  });
});

describe('3D scenes', () => {
  const items = (node) => [{ style: { fill: node.fill }, subpaths: [{ anchors: node.anchors, closed: true }], source: node.id }];

  it('shows one face of a box seen straight on and three at an angle', () => {
    clearMeshCache();
    const p = rectPath(0, 0, 100, 60);
    const front = renderModels(buildModels(items(p), fx3d('extrude', { rotX: 0, rotY: 0, rotZ: 0 })), fx3d('extrude', { rotX: 0, rotY: 0, rotZ: 0 }));
    expect(front.faces).toHaveLength(1);
    const f = fx3d('extrude', { rotX: 25, rotY: -30, rotZ: 0 });
    const angled = renderModels(buildModels(items(p), f), f);
    expect(angled.faces).toHaveLength(3);
    // The front cap, nearest the viewer, is drawn last.
    expect(angled.faces[2].rings[0]).toHaveLength(4);
    // Faces facing different ways get different shades.
    expect(new Set(angled.faces.map((x) => JSON.stringify(x.fill))).size).toBe(3);
  });

  it('shows the hole of a framed shape through its cap', () => {
    const outer = createPath(rectangle(0, 0, 100, 100), true);
    const inner = createPath(rectangle(30, 30, 40, 40), true);
    const it = [{ style: { fill: solid('#cc3333') }, subpaths: [{ anchors: outer.anchors, closed: true }, { anchors: inner.anchors, closed: true }], source: 'x' }];
    const f = fx3d('extrude', { rotX: 0, rotY: 0, rotZ: 0 });
    const out = renderModels(buildModels(it, f), f);
    expect(out.faces).toHaveLength(1);
    expect(out.faces[0].rings).toHaveLength(2);
    // With perspective the inner walls show through the hole.
    const p = fx3d('extrude', { rotX: 0, rotY: 0, rotZ: 0, perspective: 90 });
    const persp = renderModels(buildModels(it, p), p);
    expect(persp.faces.length).toBeGreaterThan(1);
  });

  it('drops a shadow below when the light is above, none when it is below', () => {
    const p = rectPath(0, 0, 100, 60);
    const on = fx3d('extrude', { shadow: true });
    expect(renderModels(buildModels(items(p), on), on).shadow.rings.length).toBeGreaterThan(0);
    const under = fx3d('extrude', { shadow: true, lightX: 0, lightY: 0.8, lightZ: 0.6 });
    expect(renderModels(buildModels(items(p), under), under).shadow).toBe(null);
    const behind = fx3d('extrude', { shadow: true, shadowPlane: 'behind' });
    const sh = renderModels(buildModels(items(p), behind), behind).shadow;
    expect(sh.rings.length).toBeGreaterThan(0);
    expect(sh.opacity).toBeCloseTo(0.35);
  });

  it('uses fewer faces while dragging (draft) and caches meshes between views', () => {
    clearMeshCache();
    const c = createPath(ellipse(0, 0, 100, 100), true, { fill: solid('#22aa66') });
    const f = fx3d('revolve', { detail: 'high' });
    const full = buildModels(items(c), f);
    const draftModels = buildModels(items(c), f, { draft: true });
    expect(draftModels.models[0].mesh.faces.length).toBeLessThan(full.models[0].mesh.faces.length);
    // Turning the object reuses the mesh.
    const again = buildModels(items(c), { ...f, rotY: 77 });
    expect(again.models[0].mesh).toBe(full.models[0].mesh);
    const deeper = buildModels(items(c), { ...f, angle: 200 });
    expect(deeper.models[0].mesh).not.toBe(full.models[0].mesh);
  });

  it('reuses the mesh when the object only moves, and draws it at the new place', () => {
    clearMeshCache();
    const f = fx3d('inflate', { rotX: 0, rotY: 0, rotZ: 0 });
    const a = createPath(ellipse(0, 0, 100, 60), true, { fill: solid('#22aa66') });
    const b = createPath(ellipse(250.5, -40, 100, 60), true, { fill: solid('#22aa66') });
    const here = buildModels(items(a), f);
    const there = buildModels(items(b), f);
    expect(there.models[0].mesh).toBe(here.models[0].mesh);
    const xs = (s) => renderModels(s, f).faces.flatMap((x) => x.rings.flat().map((q) => q[0]));
    expect(Math.min(...xs(there)) - Math.min(...xs(here))).toBeCloseTo(250.5, 6);
    // A different shape at the same place builds its own mesh.
    const c = createPath(ellipse(0, 0, 100, 70), true, { fill: solid('#22aa66') });
    expect(buildModels(items(c), f).models[0].mesh).not.toBe(here.models[0].mesh);
  });

  it('revolves about the left or right edge of the artwork', () => {
    const p = rectPath(100, 0, 50, 80);
    const span = (axis) => {
      const f = fx3d('revolve', { axis, rotX: 0, rotY: 0, rotZ: 0, detail: 'low' });
      const xs = renderModels(buildModels(items(p), f), f).faces.flatMap((x) => x.rings.flat().map((q) => q[0]));
      return [Math.round(Math.min(...xs)), Math.round(Math.max(...xs))];
    };
    expect(span('left')).toEqual([50, 150]);
    expect(span('right')).toEqual([100, 200]);
    const off = fx3d('revolve', { axis: 'left', offset: 20, rotX: 0, rotY: 0, rotZ: 0, detail: 'low' });
    const xs = renderModels(buildModels(items(p), off), off).faces.flatMap((x) => x.rings.flat().map((q) => q[0]));
    expect(Math.round(Math.min(...xs))).toBe(30);
  });

  it('views presets map to the faces they name', () => {
    const p = rectPath(0, 0, 100, 60);
    const at = (id) => {
      const v = VIEWS.find((x) => x.id === id);
      const f = fx3d('extrude', { rotX: v.x, rotY: v.y, rotZ: v.z, depth: 20 });
      return renderModels(buildModels(items(p), f), f).faces;
    };
    // Seen from the top, the visible face is the top side: 100 wide and 20 deep.
    const top = at('top');
    expect(top).toHaveLength(1);
    const xs = top[0].rings[0].map((q) => q[0]);
    const ys = top[0].rings[0].map((q) => q[1]);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(100);
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(20);
    expect(at('isoLeft')).toHaveLength(3);
  });
});

describe('3D live artwork', () => {
  it('draws generated faces for a path, keeps its own box and hits on the faces', () => {
    const p = rectPath(100, 100, 100, 60, { effects: [fx3d('extrude')] });
    const { doc } = docWith(p);
    const n = doc.get(p.id);
    expect(isLive(n)).toBe(true);
    expect(liveDef(n).key).toBe('threeD');
    expect(nodeBounds(doc, n)).toEqual({ x: 100, y: 100, w: 100, h: 60 });
    const vb = visualBounds(doc, n);
    expect(vb.w).toBeGreaterThan(100);
    const faces = leaves(doc, n);
    expect(faces.length).toBe(3);
    expect(faces.every((f) => f.source === p.id)).toBe(true);
    // A point on a side face outside the source rectangle still picks the path.
    const side = faces[0];
    const xs = side.anchors.map((a) => a.x);
    const ys = side.anchors.map((a) => a.y);
    const cx = xs.reduce((s, v) => s + v, 0) / xs.length;
    const cy = ys.reduce((s, v) => s + v, 0) / ys.length;
    expect(hitTest(doc, cx, cy, 0.5)?.id).toBe(p.id);
  });

  it('updates when the source outline changes and when the effect is hidden', () => {
    const p = rectPath(100, 100, 100, 60, { effects: [fx3d('extrude')] });
    const { doc } = docWith(p);
    const before = visualBounds(doc, doc.get(p.id));
    doc.transact('move', () => doc.update(p.id, { anchors: rectangle(300, 100, 100, 60) }));
    const after = visualBounds(doc, doc.get(p.id));
    expect(after.x - before.x).toBeCloseTo(200, 3);
    doc.transact('wider', () => doc.update(p.id, { anchors: rectangle(300, 100, 200, 60) }));
    expect(visualBounds(doc, doc.get(p.id)).w).toBeGreaterThan(after.w + 50);
    doc.transact('hide', () => doc.update(p.id, { effects: [{ ...doc.get(p.id).effects[0], hidden: true }] }));
    expect(isLive(doc.get(p.id))).toBe(false);
  });

  it('applies other geometry effects to the outline first', () => {
    const plain = rectPath(0, 0, 100, 100, { effects: [fx3d('extrude')] });
    const round = rectPath(0, 0, 100, 100, { effects: [createEffect('roundCorners', { radius: 30 }), fx3d('extrude')] });
    const { doc } = docWith(plain, round);
    const count = (id) => leaves(doc, doc.get(id)).reduce((s, f) => s + f.anchors.length, 0);
    expect(count(round.id)).toBeGreaterThan(count(plain.id) * 2);
  });

  it('extrudes a group, each object in its own color, and picks the object clicked', () => {
    const a = rectPath(0, 0, 80, 80, { fill: solid('#ff0000') });
    const b = rectPath(200, 0, 80, 80, { fill: solid('#0000ff') });
    const g = createGroup([a.id, b.id], { effects: [fx3d('extrude', { rotX: 0, rotY: 0, rotZ: 0, material: 'unlit' })] });
    const doc = VDocument.create({ width: 600, height: 600 });
    const layer = doc.layers()[0].id;
    doc.transact('add', () => doc.insert(g, layer, Infinity, [a, b].map((n) => ({ ...n, parent: g.id }))));
    const node = doc.get(g.id);
    expect(liveDef(node).key).toBe('threeD');
    const faces = leaves(doc, node);
    expect(faces.map((f) => f.fill.color).sort()).toEqual(['#0000ff', '#ff0000']);
    expect(hitTest(doc, 240, 40, 0.5, { deep: true })?.id ?? hitTest(doc, 240, 40, 0.5)?.id).toBeTruthy();
    expect(nodeBounds(doc, node)).toEqual({ x: 0, y: 0, w: 280, h: 80 });
    expect(sourceItems(doc, node)).toHaveLength(2);
  });

  it('takes over from other effects on groups and type', () => {
    const a = rectPath(0, 0, 80, 80);
    const g = createGroup([a.id], { effects: [createEffect('warp', { style: 'arc' }), fx3d('extrude')] });
    const doc = VDocument.create({ width: 600, height: 600 });
    doc.transact('add', () => doc.insert(g, doc.layers()[0].id, Infinity, [{ ...a, parent: g.id }]));
    expect(liveDef(doc.get(g.id)).key).toBe('threeD');
    const t = createText('A', 0, 100, { effects: [createEffect('roughen'), fx3d('extrude')] });
    expect(liveDef(t).key).toBe('threeD');
    // Without the 3D record the other effects keep their own live kinds.
    expect(liveDef({ ...t, effects: [createEffect('roughen')] }).key).toBe('textEffects');
  });

  it('turns type into solid letters from its outlines', async () => {
    const t = createText('Hi', 50, 100, { effects: [fx3d('extrude', { depth: 10 })] });
    const { doc } = docWith(t);
    let n = doc.get(t.id);
    expect(isLive(n)).toBe(true);
    let faces = leaves(doc, n);
    // Fonts may still be loading on first use; the text draws as type meanwhile.
    if (faces.length === 1 && faces[0].type === 'text') {
      await new Promise((r) => setTimeout(r, 50));
      doc.transact('touch', () => doc.update(t.id, { effects: [...n.effects] }));
      n = doc.get(t.id);
      faces = leaves(doc, n);
    }
    expect(faces.length).toBeGreaterThan(4);
    expect(faces.every((f) => f.type === 'path' || f.type === 'compound')).toBe(true);
  });

  it('rotates flat artwork keeping its own paint and stroke', () => {
    const p = rectPath(100, 100, 100, 60, { stroke: solid('#000000'), strokeWidth: 3, effects: [fx3d('rotate')] });
    const { doc } = docWith(p);
    const faces = leaves(doc, doc.get(p.id));
    expect(faces).toHaveLength(1);
    expect(faces[0].fill.color).toBe('#3366cc');
    expect(faces[0].stroke.color).toBe('#000000');
    expect(faces[0].strokeWidth).toBe(3);
    // Turned about the vertical axis with perspective: narrower than the original.
    const xs = faces[0].anchors.map((a) => a.x);
    expect(Math.max(...xs) - Math.min(...xs)).toBeLessThan(95);
  });

  it('expands into a group of plain faces without the 3D record', () => {
    const p = rectPath(100, 100, 100, 60, { effects: [fx3d('extrude', { shadow: true }), createEffect('dropShadow')], opacity: 0.8 });
    const { doc } = docWith(p);
    expect(hasExpandableAppearance(doc, doc.get(p.id))).toBe(true);
    let out;
    doc.transact('expand', () => (out = expandNodeAppearance(doc, p.id)));
    const g = doc.get(out);
    expect(g.type).toBe('group');
    expect(g.opacity).toBe(0.8);
    expect(g.effects.map((e) => e.type)).toEqual(['dropShadow']);
    // Shadow plus three faces, all plain objects.
    expect(g.children).toHaveLength(4);
    for (const c of g.children) {
      const k = doc.get(c);
      expect(isLive(k)).toBe(false);
      expect(k.source).toBeUndefined();
    }
    expect(doc.has(p.id)).toBe(false);
  });

  it('exports the generated faces to SVG', () => {
    const p = rectPath(100, 100, 100, 60, { effects: [fx3d('extrude', { shading: 'smooth' })] });
    const c = createPath(ellipse(300, 100, 80, 80), true, { fill: solid('#22aa66'), effects: [fx3d('inflate', { detail: 'low' })] });
    const { doc } = docWith(p, c);
    const svg = exportSVG(doc, { rect: { x: 0, y: 0, w: 600, h: 600 } });
    expect((svg.match(/<path/g) || []).length).toBeGreaterThan(20);
    expect(svg).toContain('linearGradient');
    expect(svg).not.toContain('threeD');
  });

  it('exports the generated faces to PDF', async () => {
    const p = rectPath(100, 100, 100, 60, { effects: [fx3d('extrude', { shading: 'smooth', shadow: true })] });
    const c = createPath(ellipse(300, 100, 80, 80), true, { fill: solid('#22aa66'), effects: [fx3d('extrude', { shading: 'smooth' })] });
    const { doc } = docWith(p, c);
    const { bytes } = await writePDF(doc, doc.artboards, { compress: false });
    const text = new TextDecoder('latin1').decode(bytes);
    // Faces filled or gradient-shaded (the cylinder's curved side), and the shadow.
    const paints = text.match(/\n(?:f\*?|B\*?|\/\w+ sh)\n/g) || [];
    expect(paints.length).toBeGreaterThanOrEqual(4);
    expect(text).toMatch(/\/ShadingType 2/);
  });

  it('renders in draft quality while dragging', () => {
    const c = createPath(ellipse(0, 0, 100, 100), true, { fill: solid('#22aa66'), effects: [fx3d('revolve', { detail: 'high' })] });
    const { doc } = docWith(c);
    setDraft(true);
    const d = leaves(doc, doc.get(c.id)).length;
    setDraft(false);
    doc.transact('touch', () => doc.update(c.id, { effects: [...doc.get(c.id).effects] }));
    const full = leaves(doc, doc.get(c.id)).length;
    expect(d).toBeLessThan(full);
    expect(threeDOf(doc.get(c.id)).fx.kind).toBe('revolve');
  });

  it('draws mesh edges for the wire frame material and see-through faces for glass', () => {
    const p = rectPath(100, 100, 100, 60, { effects: [fx3d('extrude', { material: 'wire' })] });
    const q = rectPath(300, 100, 100, 60, { effects: [fx3d('extrude', { material: 'glass', opacity: 0.45 })] });
    const { doc } = docWith(p, q);
    const wire = leaves(doc, doc.get(p.id));
    expect(wire.length).toBe(6);
    expect(wire.every((f) => f.fill === null && f.stroke)).toBe(true);
    const glass = leaves(doc, doc.get(q.id));
    expect(glass.length).toBe(6);
    expect(glass.every((f) => f.opacity < 1 && !f.stroke)).toBe(true);
  });

  it('revolves an open stroked profile in its stroke color', () => {
    const prof = createPath([anchor(100, 0), anchor(140, 50), anchor(100, 100)], false, { fill: null, stroke: solid('#aa5500'), effects: [fx3d('revolve', { detail: 'low', material: 'unlit' })] });
    const { doc } = docWith(prof);
    const faces = leaves(doc, doc.get(prof.id));
    expect(faces.length).toBeGreaterThan(10);
    expect(faces.every((f) => (f.fill.color || f.fill.stops?.[0].color) === '#aa5500')).toBe(true);
  });
});
