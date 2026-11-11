import { describe, it, expect } from 'vitest';

/** Recording 2D context: logs drawImage calls with the shadow state at the time. */
function recorder(log, canvas) {
  return {
    canvas,
    shadowBlur: 0,
    shadowColor: 'rgba(0,0,0,0)',
    shadowOffsetX: 0,
    shadowOffsetY: 0,
    globalCompositeOperation: 'source-over',
    globalAlpha: 1,
    fillStyle: '#000',
    setTransform() {},
    save() {},
    restore() { this.shadowBlur = 0; },
    fillRect() {},
    clearRect() {},
    drawImage(img, x, y) {
      log.push({ img, x, y, shadowBlur: this.shadowBlur, shadowOffsetX: this.shadowOffsetX, target: canvas });
    },
  };
}

function fakePool(log) {
  return {
    acquire(w, h) {
      const canvas = { width: w, height: h };
      return { canvas, ctx: recorder(log, canvas) };
    },
    release() {},
  };
}

describe('inner glow on the canvas', () => {
  it('blurs an inverted alpha that extends beyond the tight layer, so the edge glow is as strong as in SVG', async () => {
    const { compositeWithEffects } = await import('../src/render/effects.js');
    const log = [];
    const pool = fakePool(log);
    const layer = pool.acquire(120, 120);
    const target = recorder(log, { width: 400, height: 400 });
    compositeWithEffects(target, layer, [{ type: 'innerGlow', blur: 10, opacity: 1, color: '#ff0000', source: 'edge', mode: 'normal' }], 1, pool);
    const shadowDraw = log.find((d) => d.shadowBlur > 0);
    expect(shadowDraw).toBeTruthy();
    const blurPx = shadowDraw.shadowBlur; // canvas blur = 2 sigma
    const pad = (shadowDraw.img.width - 120) / 2;
    // The outside must reach at least 3 sigma (1.5 x shadowBlur) past the layer.
    expect(pad).toBeGreaterThanOrEqual(blurPx * 1.5);
    // Drawn so its interior lines up with the layer: x + shadowOffsetX === -pad.
    expect(shadowDraw.x + shadowDraw.shadowOffsetX).toBe(-pad);
  });
});

describe('rich text SVG round trip', () => {
  async function roundTrip(text, extra) {
    const { VDocument } = await import('../src/model/document.js');
    const { createText } = await import('../src/model/nodes.js');
    const { exportSVG } = await import('../src/features/io/svg-export.js');
    const { svgToDocument } = await import('../src/features/io/svg-import.js');
    const doc = VDocument.create({ width: 300, height: 200 });
    doc.transact('t', () => doc.insert(createText(text, 20, 40, extra), doc.layers()[0].id));
    const svg = exportSVG(doc, { rect: { x: 0, y: 0, w: 300, h: 200 }, cull: false });
    return { svg, back: svgToDocument(svg) };
  }

  it('writes one <text> with a <tspan> per style run and reads it back as one text object', async () => {
    const red = { type: 'solid', color: '#ff0000' };
    const { svg, back } = await roundTrip('Plain bold red end', { runs: [{ len: 6 }, { len: 8, fontWeight: 700, fill: red }, { len: 4 }] });
    expect(svg.match(/<text\b/g)).toHaveLength(1);
    expect(svg.match(/<tspan\b/g)).toHaveLength(3);
    const leaves = back.leaves();
    expect(leaves).toHaveLength(1);
    expect(leaves[0].text).toBe('Plain bold red end');
    expect(leaves[0].runs).toEqual([{ len: 6 }, { len: 8, fontWeight: 700, fill: red }, { len: 4 }]);
    expect(leaves[0].x).toBeCloseTo(20, 3);
    expect(leaves[0].y).toBeCloseTo(40, 3);
  });

  it('keeps multi-line mixed text, baseline shifts and underlines in one object', async () => {
    const { svg, back } = await roundTrip('E=mc2 is\nfamous', { runs: [{ len: 4 }, { len: 1, baselineShift: 5 }, { len: 4 }, { len: 3, underline: true }, { len: 3 }] });
    expect(svg.match(/<text\b/g)).toHaveLength(1);
    expect(svg).toContain('text-decoration="underline"');
    const leaves = back.leaves();
    expect(leaves).toHaveLength(1);
    const t = leaves[0];
    expect(t.text).toBe('E=mc2 is\nfamous');
    expect(t.runs.find((r) => r.baselineShift)).toMatchObject({ len: 1, baselineShift: 5 });
    expect(t.runs.find((r) => r.underline)).toMatchObject({ len: 3, underline: true });
  });

  it('continues a line across positioned tspans written by other design tools', async () => {
    const { svgToDocument } = await import('../src/features/io/svg-import.js');
    const { measure } = await import('../src/model/text-layout.js');
    const { DEFAULT_CHAR } = await import('../src/model/nodes.js');
    const w = measure('Hello ', { ...DEFAULT_CHAR, fontFamily: 'Arial', fontSize: 20 });
    const doc = svgToDocument(`<svg xmlns="http://www.w3.org/2000/svg" width="300" height="100">
      <text transform="translate(10 50)" font-family="Arial" font-size="20"><tspan x="0" y="0">Hello </tspan><tspan x="${w}" y="0" font-weight="bold">World</tspan><tspan x="0" y="24">Next</tspan></text>
    </svg>`);
    const leaves = doc.leaves();
    expect(leaves).toHaveLength(1);
    expect(leaves[0].text).toBe('Hello World\nNext');
    expect(leaves[0].runs).toEqual([{ len: 6 }, { len: 6, fontWeight: 700 }, { len: 4 }]);
  });
});

describe('artboard reference point', () => {
  const waitFor = async (fn) => {
    for (let i = 0; i < 100; i++) {
      const v = fn();
      if (v) return v;
      await new Promise((r) => setTimeout(r, 20));
    }
    return null;
  };
  const field = (root, label) => [...root.querySelectorAll('input.num-input')].find((i) => i.getAttribute('aria-label') === label);
  let app = null;
  const boot = async () => {
    if (!app) {
      const { bootAppWithFeatures } = await import('./helpers.js');
      app = await bootAppWithFeatures();
    }
    return app;
  };
  const setField = (input, v) => {
    input.value = String(v);
    input.dispatchEvent(new Event('blur'));
  };

  it('Artboard Options shows X/Y of the reference point (center by default) and resizes around it', async () => {
    const { artboardRef } = await import('../src/features/artboards/artboard-ops.js');
    artboardRef.index = 4;
    const app = await boot();
    app.newDocument({ width: 600, height: 400 });
    const ed = app.editor;
    ed.doc.transact('ab', () => ed.doc.updateRoot({ artboards: [{ ...ed.doc.artboards[0], x: 0, y: 0, w: 600, h: 400 }] }));
    const done = app.commands.run('artboards.options', { index: 0 });
    const dlg = await waitFor(() => document.querySelector('dialog[open]'));
    expect(field(dlg, 'X').value).toMatch(/^300/);
    expect(field(dlg, 'Y').value).toMatch(/^200/);
    expect(dlg.querySelectorAll('.ref-grid [role="radio"]')).toHaveLength(9);
    setField(field(dlg, 'Width'), 400);
    // Pick the top-left reference point: X/Y now show the corner.
    dlg.querySelectorAll('.ref-grid [role="radio"]')[0].click();
    expect(field(dlg, 'X').value).toMatch(/^100/);
    setField(field(dlg, 'Height'), 300);
    [...dlg.querySelectorAll('button')].find((b) => b.textContent === 'OK').click();
    await done;
    expect(ed.doc.artboards[0]).toMatchObject({ x: 100, y: 0, w: 400, h: 300 });
    artboardRef.index = 4;
  });

  it('the Artboard tool controls use the same reference point', async () => {
    const { artboardRef } = await import('../src/features/artboards/artboard-ops.js');
    artboardRef.index = 4;
    const app = await boot();
    app.newDocument({ width: 600, height: 400 });
    const ed = app.editor;
    ed.doc.transact('ab', () => ed.doc.updateRoot({ artboards: [{ ...ed.doc.artboards[0], x: 0, y: 0, w: 600, h: 400 }] }));
    app.setTool('artboard');
    const sec = await waitFor(() => document.querySelector('.ab-controls'));
    expect(sec).toBeTruthy();
    expect(await waitFor(() => /^300/.test(field(sec, 'X').value))).toBe(true);
    setField(field(sec, 'W'), 500);
    expect(ed.doc.artboards[0]).toMatchObject({ x: 50, w: 500 });
    sec.querySelectorAll('.ref-grid [role="radio"]')[8].click();
    expect(field(sec, 'X').value).toMatch(/^550/);
    setField(field(sec, 'Y'), 500);
    expect(ed.doc.artboards[0]).toMatchObject({ y: 100, h: 400 });
    artboardRef.index = 4;
  });
});

describe('rotated area type', () => {
  it('reflows its frame when scaled along its own rotated axes instead of stretching glyphs', async () => {
    const { VDocument } = await import('../src/model/document.js');
    const { createText } = await import('../src/model/nodes.js');
    const { transformNodes } = await import('../src/model/geometry.js');
    const { rotate, multiply, scale, apply } = await import('../src/lib/matrix.js');
    const doc = VDocument.create();
    const R = rotate(30, 50, 25);
    const n = createText('some area type that wraps', 0, 0, { kind: 'area', width: 100, height: 50, transform: R });
    doc.transact('add', () => doc.insert(n, doc.layers()[0].id));
    // Scale 2x along the frame's own x axis, around its top-left corner.
    const o = apply(R, 0, 0);
    const m = multiply(rotate(30, o.x, o.y), multiply(scale(2, 1, o.x, o.y), rotate(-30, o.x, o.y)));
    doc.transact('scale', () => transformNodes(doc, [n.id], m));
    const t = doc.get(n.id);
    R.forEach((v, i) => expect(t.transform[i]).toBeCloseTo(v, 9));
    expect(t.width).toBeCloseTo(200, 6);
    expect(t.height).toBeCloseTo(50, 6);
    expect(t.x).toBeCloseTo(0, 6);
    expect(t.char.fontSize).toBe(n.char.fontSize);
    // Scaling across the frame's axes (a shear in its space) still keeps the matrix.
    doc.transact('scale2', () => transformNodes(doc, [n.id], scale(2, 1)));
    expect(doc.get(n.id).transform[0]).not.toBeCloseTo(R[0], 6);
  });
});

describe('rotated frames in Transform Each and the Info panel', () => {
  async function rotatedRect(doc) {
    const { createPath } = await import('../src/model/nodes.js');
    const { rectangle } = await import('../src/model/shapes.js');
    const { transformNodes } = await import('../src/model/geometry.js');
    const { rotate } = await import('../src/lib/matrix.js');
    const n = createPath(rectangle(100, 100, 100, 40), true);
    doc.transact('add', () => doc.insert(n, doc.layers()[0].id));
    doc.transact('rot', () => transformNodes(doc, [n.id], rotate(30, 150, 120)));
    return n.id;
  }

  it('Transform Each scales a turned object along its own axes around its frame reference point', async () => {
    const { VDocument } = await import('../src/model/document.js');
    const { selectionFrame, frameToDoc } = await import('../src/model/geometry.js');
    const { transformEach } = await import('../src/commands/core.js');
    const doc = VDocument.create();
    const id = await rotatedRect(doc);
    const before = selectionFrame(doc, [id]);
    expect(Math.abs(before.angle)).toBeCloseTo(30, 6);
    const editor = { doc, topSelection: () => [id], prefs: null };
    doc.transact('each', () => transformEach(editor, { scaleX: 200, scaleY: 100, refX: 0, refY: 0 }));
    const after = selectionFrame(doc, [id]);
    expect(after.angle).toBeCloseTo(before.angle, 6);
    expect(after.w).toBeCloseTo(200, 6);
    expect(after.h).toBeCloseTo(40, 6);
    // The top-left corner of the frame stayed in place.
    const a = frameToDoc(before, before.x, before.y);
    const b = frameToDoc(after, after.x, after.y);
    expect(b.x).toBeCloseTo(a.x, 6);
    expect(b.y).toBeCloseTo(a.y, 6);
  });

  it('the Info panel reports W/H of the rotated frame', async () => {
    const { bootAppWithFeatures } = await import('./helpers.js');
    const app = await bootAppWithFeatures();
    app.newDocument({});
    const ed = app.editor;
    const id = await rotatedRect(ed.doc);
    ed.select([id]);
    app.openPanel('info');
    const panel = [...document.querySelectorAll('.info-grid')].pop();
    const inst = app.panels?.get?.('info') || null;
    inst?.update?.();
    await new Promise((r) => setTimeout(r, 50));
    const cells = [...panel.querySelectorAll('.info-cell')];
    const val = (k) => cells.find((c) => c.querySelector('.info-key').textContent === k).querySelector('.info-val').textContent;
    expect(val('W')).toMatch(/^100(\.0+)? pt$/);
    expect(val('H')).toMatch(/^40(\.0+)? pt$/);
  });
});

describe('SVG import: CSS transforms', () => {
  it('parses CSS transform functions and units', async () => {
    const { parseTransform } = await import('../src/features/io/svg-style.js');
    expect(parseTransform('translateX(10px) translateY(5px)')).toEqual([1, 0, 0, 1, 10, 5]);
    expect(parseTransform('translate3d(3px, 4px, 9px)')).toEqual([1, 0, 0, 1, 3, 4]);
    expect(parseTransform('scaleX(2) scaleY(3)')).toEqual([2, 0, 0, 3, 0, 0]);
    const r = parseTransform('rotateZ(0.25turn)');
    expect(r[1]).toBeCloseTo(1, 9);
    const g = parseTransform('rotate(100grad)');
    expect(g[1]).toBeCloseTo(1, 9);
    expect(parseTransform('skew(45deg)')[2]).toBeCloseTo(1, 9);
    expect(parseTransform('matrix3d(1,0,0,0, 0,1,0,0, 0,0,1,0, 7,8,0,1)')).toEqual([1, 0, 0, 1, 7, 8]);
    expect(parseTransform('translate(1in, 0)')).toEqual([1, 0, 0, 1, 72, 0]);
  });

  it('lets a CSS transform in a style attribute override the transform attribute, with transform-origin', async () => {
    const { svgToDocument } = await import('../src/features/io/svg-import.js');
    const { nodeBounds } = await import('../src/model/geometry.js');
    const doc = svgToDocument(`<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200">
      <rect width="10" height="10" transform="translate(100 100)" style="transform: translateX(20px) translateY(30px)"/>
      <rect width="10" height="10" style="transform: scale(2); transform-origin: 10px 10px"/>
      <rect width="10" height="10" transform="translate(50 0)" style="transform: none"/>
    </svg>`);
    const [a, b, c] = doc.leaves();
    expect(nodeBounds(doc, a)).toEqual({ x: 20, y: 30, w: 10, h: 10 });
    expect(nodeBounds(doc, b)).toEqual({ x: -10, y: -10, w: 20, h: 20 });
    expect(nodeBounds(doc, c)).toEqual({ x: 0, y: 0, w: 10, h: 10 });
  });
});

describe('radial gradient focal points', () => {
  const svg = (extra, attrs = '') => `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200">
    <radialGradient id="g" cx="100" cy="100" r="50" ${extra} gradientUnits="userSpaceOnUse" ${attrs}><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#000"/></radialGradient>
    <rect width="200" height="200" fill="url(#g)"/>
  </svg>`;

  it('imports fx/fy/fr as a focal offset in the gradient circle and no longer warns', async () => {
    const { svgToDocument } = await import('../src/features/io/svg-import.js');
    const doc = svgToDocument(svg('fx="125" fy="100" fr="5"'));
    const fill = doc.leaves()[0].fill;
    expect(fill.type).toBe('radial');
    const len = Math.hypot(...fill.focal);
    expect(len).toBeCloseTo(0.5, 5);
    expect(fill.focalRadius).toBeCloseTo(0.1, 5);
    expect(doc.importWarnings || []).not.toContain('Radial gradient focal points were ignored.');
  });

  it('renders with two circles and exports the focal point back to SVG and PDF', async () => {
    const { svgToDocument } = await import('../src/features/io/svg-import.js');
    const { exportSVG } = await import('../src/features/io/svg-export.js');
    const { paintStyle } = await import('../src/render/draw.js');
    const doc = svgToDocument(svg('fx="125" fy="90"', 'gradientTransform="rotate(30 100 100)"'));
    const node = doc.leaves()[0];
    const calls = [];
    const ctx = { createRadialGradient: (...a) => (calls.push(a), { addColorStop() {} }), createLinearGradient: () => ({ addColorStop() {} }) };
    paintStyle(ctx, doc, node, node.fill);
    const [fx, fy, r0, cx, cy, r1] = calls[0];
    expect(cx).toBeCloseTo(100, 6);
    expect(cy).toBeCloseTo(100, 6);
    expect(r1).toBeCloseTo(50, 6);
    expect(r0).toBe(0);
    // The focal point (125, 90) in gradient space, turned 30 degrees about the center.
    const a = (30 * Math.PI) / 180;
    expect(fx).toBeCloseTo(100 + 25 * Math.cos(a) + 10 * Math.sin(a), 3);
    expect(fy).toBeCloseTo(100 + 25 * Math.sin(a) - 10 * Math.cos(a), 3);
    const out = exportSVG(doc, { rect: { x: 0, y: 0, w: 200, h: 200 }, cull: false });
    expect(out).toMatch(/<radialGradient[^>]* fx="[\d.]+" fy="[\d.]+"/);
    const back = svgToDocument(out).leaves()[0].fill;
    expect(back.focal[0]).toBeCloseTo(node.fill.focal[0], 3);
    expect(back.focal[1]).toBeCloseTo(node.fill.focal[1], 3);
    const { writePDF } = await import('../src/features/io/pdf.js');
    const { bytes } = await writePDF(doc, [{ x: 0, y: 0, w: 200, h: 200, name: 'A' }], {});
    const pdf = new TextDecoder('latin1').decode(bytes);
    const coords = /\/ShadingType 3 [^>]*\/Coords \[([^\]]+)\]/.exec(pdf)[1].split(' ').map(Number);
    expect(coords[0]).toBeCloseTo(fx, 2);
    expect(coords[1]).toBeCloseTo(fy, 2);
    expect(coords.slice(3)).toEqual([100, 100, 50]);
  });
});

describe('responsive SVG import', () => {
  const big = (n) => `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400"><style>.a{fill:#3a7bd5}</style><g id="plot">${Array.from({ length: n }, (_, i) => `<g transform="translate(${i % 400} ${(i * 7) % 400})"><path class="a" d="M0 0h3v3h-3z"/></g>`).join('')}</g></svg>`;

  it('imports in time slices with progress and gives the same artwork as the synchronous importer', async () => {
    const { convertSVG, convertSVGAsync, svgToDocumentAsync } = await import('../src/features/io/svg-import.js');
    const text = big(300);
    const progress = [];
    let ticks = 0;
    const timer = setInterval(() => ticks++, 0);
    const r = await convertSVGAsync(text, { slice: 0, onProgress: (v) => progress.push(v) });
    clearInterval(timer);
    const s = convertSVG(text);
    expect(progress.length).toBeGreaterThan(10);
    expect(progress.every((v, i) => v >= 0 && v <= 1 && (i === 0 || v >= progress[i - 1]))).toBe(true);
    expect(ticks).toBeGreaterThan(0);
    const shape = (res) => [...res.nodes.values()].map((n) => `${n.type}:${n.children?.length ?? ''}:${n.fill?.color ?? ''}`).join(',');
    expect(shape(r)).toBe(shape(s));
    expect(r.artboard).toEqual(s.artboard);
    const doc = await svgToDocumentAsync(text, { name: 'Big' });
    expect(doc.name).toBe('Big');
    expect(doc.leaves()).toHaveLength(300);
  });

  it('shows a determinate progress bar while a slow import runs', async () => {
    const { withProgress } = await import('../src/features/io/progress.js');
    const root = document.createElement('div');
    let seen = null;
    await withProgress({ root }, 'Importing SVG', async (onProgress) => {
      await new Promise((r) => setTimeout(r, 20));
      onProgress(0.42);
      const bar = document.querySelector('[role="progressbar"]');
      seen = { now: bar?.getAttribute('aria-valuenow'), label: bar?.getAttribute('aria-label'), busy: root.getAttribute('aria-busy') };
    }, { delay: 0 });
    expect(seen).toEqual({ now: '42', label: 'Importing SVG', busy: 'true' });
    expect(document.querySelector('[role="progressbar"]')).toBeNull();
    expect(root.getAttribute('aria-busy')).toBe('false');
  });
  it('cancels a slow import from the pill or with Escape, leaving nothing behind', async () => {
    const { withProgress } = await import('../src/features/io/progress.js');
    const { convertSVGAsync } = await import('../src/features/io/svg-import.js');
    for (const how of ['click', 'escape']) {
      const root = document.createElement('div');
      const notes = [];
      let stopped = null;
      const r = await withProgress(
        { root, notify: (m) => notes.push(m) },
        'Importing SVG',
        async (onProgress, signal) => {
          let ticks = 0;
          try {
            return await convertSVGAsync(big(3000), {
              slice: 0,
              signal,
              onProgress: () => {
                if (++ticks !== 3) return;
                const btn = document.querySelector('.io-progress button');
                expect(btn.textContent).toBe('Cancel');
                if (how === 'click') btn.click();
                else window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
              },
            });
          } catch (err) {
            stopped = { name: err.name, ticks };
            throw err;
          }
        },
        { delay: 0, cancelable: true },
      );
      expect(r).toBeNull();
      // The work stopped at its next check instead of running to the end.
      expect(stopped).toEqual({ name: 'AbortError', ticks: 3 });
      expect(document.querySelector('.io-progress')).toBeNull();
      expect(root.getAttribute('aria-busy')).toBe('false');
      expect(document.body.classList.contains('io-busy')).toBe(false);
      expect(notes).toEqual(['Importing SVG canceled.']);
    }
    // Without cancelable the pill has no button.
    let btn;
    await withProgress({ root: null }, 'Importing SVG', async () => {
      await new Promise((r) => setTimeout(r, 5));
      btn = document.querySelector('.io-progress button');
    }, { delay: 0 });
    expect(btn).toBeNull();
  });

  it('stops opening a many-page PDF between pages when canceled', async () => {
    const { pdfToDocument } = await import('../src/features/interop/pdf/import.js');
    const objs = [];
    const add = (o) => objs.push(o);
    add('<< /Type /Catalog /Pages 2 0 R >>');
    add('<< /Type /Pages /Kids [4 0 R 5 0 R 6 0 R] /Count 3 >>');
    const content = '0 0 1 rg 10 10 50 50 re f\n';
    add(`<< /Length ${content.length} >>\nstream\n${content}endstream`);
    for (let i = 0; i < 3; i++) add('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 3 0 R >>');
    let out = '%PDF-1.4\n';
    const offs = objs.map((o, i) => {
      const at = out.length;
      out += `${i + 1} 0 obj\n${o}\nendobj\n`;
      return at;
    });
    const xref = out.length;
    out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    const bytes = Uint8Array.from(out, (c) => c.charCodeAt(0));
    expect((await pdfToDocument(bytes)).artboards).toHaveLength(3);
    const ctl = new AbortController();
    const seen = [];
    const run = pdfToDocument(bytes, { signal: ctl.signal, onProgress: (v) => (seen.push(v), ctl.abort()) });
    await expect(run).rejects.toMatchObject({ name: 'AbortError' });
    expect(seen).toHaveLength(1);
  });
});
