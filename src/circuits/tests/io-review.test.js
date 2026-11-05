// Regression tests from the manufacturing-output and import review.
import { describe, it, expect, vi } from 'vitest';
import { exportGerbers } from '../src/io/gerber.js';
import { mm } from '../src/core/units.js';
import { defaultRules } from '../src/model/schema.js';
import { compFieldPlacement } from '../src/model/pcb.js';
import { importKicad } from '../src/io/kicad/index.js';
import { parseSexpr } from '../src/io/kicad/sexpr.js';
import { polyArea, bboxOfFlat } from '../src/core/geom.js';

const square = (x0, y0, x1, y1) => [x0, y0, x1, y0, x1, y1, x0, y1];

function inRing(x, y, r) {
  let inside = false;
  for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) {
    const xi = r[i],
      yi = r[i + 1],
      xj = r[j],
      yj = r[j + 1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Whether the regions of a 4.6 mm Gerber file leave (x, y) dark, honouring LPD/LPC order. */
function regionDarkAt(text, x, y) {
  let dark = true,
    region = null,
    ring = null,
    result = false;
  for (const m of text.matchAll(/%(LP[DC])\*%|(G36|G37)\*|X(-?\d+)Y(-?\d+)D0([12])\*/g)) {
    if (m[1]) dark = m[1] === 'LPD';
    else if (m[2] === 'G36') region = [];
    else if (m[2] === 'G37') {
      if (region.some((r) => inRing(x, y, r))) result = dark;
      region = null;
    } else if (region) {
      if (m[5] === '2') region.push((ring = []));
      ring.push(Number(m[3]), Number(m[4]));
    }
  }
  return result;
}

function pourBoard(objects) {
  return {
    id: 'b',
    kind: 'pcb',
    name: 'Pours',
    board: { outline: square(0, 0, mm(40), mm(30)), origin: { x: 0, y: 0 }, copper: 2 },
    rules: defaultRules(),
    nets: {},
    objects,
  };
}

describe('Gerber pours', () => {
  it('keeps a pour that sits inside another pour’s hole, whatever the document order', () => {
    const small = {
      id: 'small',
      t: 'pour',
      layer: 'bottom',
      pts: square(mm(14), mm(12), mm(22), mm(18)),
      net: 'VCC',
    };
    const big = {
      id: 'big',
      t: 'pour',
      layer: 'bottom',
      pts: square(mm(1), mm(1), mm(39), mm(29)),
      net: 'GND',
    };
    const pourFills = {
      small: [[square(mm(14), mm(12), mm(22), mm(18))]],
      big: [[square(mm(1), mm(1), mm(39), mm(29)), square(mm(13.7), mm(11.7), mm(22.3), mm(18.3))]],
    };
    for (const objects of [
      [small, big],
      [big, small],
    ]) {
      const files = exportGerbers(pourBoard(objects), {}, { pourFills });
      const gbl = files.find((f) => f.layer === 'bottom').content;
      expect(regionDarkAt(gbl, mm(18), mm(15))).toBe(true); // the small pour
      expect(regionDarkAt(gbl, mm(13.8), mm(15))).toBe(false); // the clearance gap
      expect(regionDarkAt(gbl, mm(5), mm(5))).toBe(true); // the big pour
      // Each pour keeps its own net attribute.
      expect(gbl).toContain('%TO.N,VCC*%');
      expect(gbl).toContain('%TO.N,GND*%');
    }
  });
});

/** Bounding box of every drawn coordinate in a Gerber file, in nm. */
function drawnBox(text) {
  const b = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const m of text.matchAll(/X(-?\d+)Y(-?\d+)D0[123]\*/g)) {
    const x = Number(m[1]),
      y = Number(m[2]);
    b.minX = Math.min(b.minX, x);
    b.maxX = Math.max(b.maxX, x);
    b.minY = Math.min(b.minY, y);
    b.maxY = Math.max(b.maxY, y);
  }
  return b;
}

describe('Gerber silkscreen fields', () => {
  const chip = {
    id: 'chip',
    name: 'Chip',
    prefix: 'R',
    symbol: { pins: [], graphics: [] },
    footprint: {
      name: '0805',
      graphics: [],
      pads: [
        { num: '1', x: -mm(1), y: 0, shape: 'rect', w: mm(1), h: mm(1.3), side: 'top' },
        { num: '2', x: mm(1), y: 0, shape: 'rect', w: mm(1), h: mm(1.3), side: 'top' },
      ],
    },
  };
  const boardWith = (comp) =>
    pourBoard([{ id: 'c', t: 'comp', comp: 'chip', designator: 'R1', value: '10k', ...comp }]);
  const legend = (b, layer) =>
    exportGerbers(b, { chip }, {}).find((f) => f.layer === layer).content;

  it('places the designator where the board canvas shows it', () => {
    for (const [side, rot] of [
      ['top', 90],
      ['top', 180],
      ['bottom', 270],
      ['top', 0],
    ]) {
      const comp = { x: mm(20), y: mm(15), rot, side };
      const b = boardWith(comp);
      const f = compFieldPlacement(b.objects[0], 'designator', chip);
      const box = drawnBox(legend(b, side === 'top' ? 'topOverlay' : 'bottomOverlay'));
      expect(Math.abs((box.minX + box.maxX) / 2 - f.x)).toBeLessThan(mm(0.15));
      expect(Math.abs((box.minY + box.maxY) / 2 - f.y)).toBeLessThan(mm(0.15));
      // Text along the part's rotation: a quarter turn makes the text run vertically.
      const vertical = box.maxY - box.minY > box.maxX - box.minX;
      expect(vertical).toBe(rot % 180 === 90);
    }
  });

  it('draws a value field that is shown on the board', () => {
    const shown = legend(
      boardWith({
        x: mm(20),
        y: mm(15),
        rot: 0,
        side: 'top',
        fields: { value: { hidden: false } },
      }),
      'topOverlay',
    );
    const hidden = legend(boardWith({ x: mm(20), y: mm(15), rot: 0, side: 'top' }), 'topOverlay');
    const f = compFieldPlacement(
      { x: mm(20), y: mm(15), rot: 0, side: 'top', fields: { value: { hidden: false } } },
      'value',
      chip,
    );
    expect(drawnBox(shown).minY).toBeLessThan(f.y);
    expect(drawnBox(hidden).minY).toBeGreaterThan(mm(15));
  });

  it('honours the alignment of board text', () => {
    const text = {
      id: 't',
      t: 'text',
      layer: 'topOverlay',
      x: mm(20),
      y: mm(15),
      text: 'ABC',
      h: mm(1),
      w: mm(0.15),
      align: { h: 'right', v: 'top' },
    };
    const box = drawnBox(legend(pourBoard([text]), 'topOverlay'));
    expect(box.maxX).toBeLessThanOrEqual(mm(20) + mm(0.1));
    expect(box.maxY).toBeLessThanOrEqual(mm(15) + mm(0.1));
  });
});

// A KiCad 5 board: 20 x 10 mm with 2 mm rounded corners drawn as legacy arcs
// (start = centre, end = first point, angle clockwise on screen).
const KICAD5_PCB = `(kicad_pcb (version 20171130) (host pcbnew 5.1.9)
  (general (thickness 1.6))
  (layers (0 F.Cu signal) (31 B.Cu signal) (44 Edge.Cuts user))
  (net 0 "") (net 1 GND)
  (gr_line (start 102 100) (end 118 100) (layer Edge.Cuts) (width 0.05))
  (gr_line (start 120 102) (end 120 108) (layer Edge.Cuts) (width 0.05))
  (gr_line (start 118 110) (end 102 110) (layer Edge.Cuts) (width 0.05))
  (gr_line (start 100 108) (end 100 102) (layer Edge.Cuts) (width 0.05))
  (gr_arc (start 102 102) (end 100 102) (angle 90) (layer Edge.Cuts) (width 0.05))
  (gr_arc (start 118 102) (end 118 100) (angle 90) (layer Edge.Cuts) (width 0.05))
  (gr_arc (start 118 108) (end 120 108) (angle 90) (layer Edge.Cuts) (width 0.05))
  (gr_arc (start 102 108) (end 102 110) (angle 90) (layer Edge.Cuts) (width 0.05))
  (gr_arc (start 110 105) (end 112 105) (angle -180) (layer F.SilkS) (width 0.15))
  (module R_0805 (layer F.Cu) (tedit 5B36C52B) (tstamp 5E3F1A2B) (at 105 105)
    (fp_text reference R1 (at 0 -1.65) (layer F.SilkS) (effects (font (size 1 1) (thickness 0.15))))
    (fp_text value 0402 (at 0 1.65) (layer F.Fab) (effects (font (size 1 1) (thickness 0.15))))
    (fp_arc (start 0 0) (end 1 0) (angle 90) (layer F.SilkS) (width 0.12))
    (pad 01 smd rect (at -0.95 0) (size 1 1.3) (layers F.Cu F.Paste F.Mask) (net 1 GND))
    (pad 2 smd rect (at 0.95 0) (size 1 1.3) (layers F.Cu F.Paste F.Mask))
  )
)`;

describe('KiCad 5 boards', () => {
  it('imports legacy arcs on the outline, the board and in footprints', async () => {
    const { project, warnings } = await importKicad([{ name: 'old.kicad_pcb', text: KICAD5_PCB }]);
    expect(warnings).toEqual([]);
    const pcb = project.documents[0];
    const area = Math.abs(polyArea(pcb.board.outline)) / 1e12;
    expect(area).toBeCloseTo(200 - (4 - Math.PI) * 4, 0);
    const b = bboxOfFlat(pcb.board.outline);
    expect([b.minX, b.maxX, b.minY, b.maxY]).toEqual([mm(100), mm(120), -mm(110), -mm(100)]);
    // Silkscreen half circle: counter-clockwise on screen from the right, the upper half.
    const arc = pcb.objects.find((o) => o.t === 'arc');
    expect(arc).toMatchObject({ layer: 'topOverlay', cx: mm(110), cy: -mm(105), r: mm(2) });
    expect(arc.a0).toBeCloseTo(0);
    expect(arc.sweep).toBeCloseTo(180);
    // Footprint quarter arc: clockwise on screen from +x, so down the page (y up: from 270 to 360).
    const fpArc = Object.values(project.library)[0].footprint.graphics.find((g) => g.t === 'arc');
    expect(fpArc.a0).toBeCloseTo(270, 3);
    expect(fpArc.sweep).toBeCloseTo(90, 3);
  });
});

describe('KiCad unquoted names', () => {
  it('keeps names spelled like numbers as written', async () => {
    const { project } = await importKicad([{ name: 'old.kicad_pcb', text: KICAD5_PCB }]);
    const comp = project.documents[0].objects.find((o) => o.t === 'comp');
    expect(comp.value).toBe('0402');
    expect(comp.padNets).toEqual({ '01': 'GND' });
    const def = project.library[comp.comp];
    expect(def.footprint.pads.map((p) => p.num)).toEqual(['01', '2']);
    // Numbers stay numbers for geometry.
    expect([...parseSexpr('(at 1.50 -0.0)')]).toEqual(['at', 1.5, -0]);
  });
});

describe('kernel worker', () => {
  it('loads the kernel once when requests arrive while it is loading, and retries after a failure', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const bytes = fs.readFileSync(path.resolve(import.meta.dirname, '../src/kernel/kernel.wasm'));
    const posted = [];
    let fetches = 0;
    let fail = true;
    const prevSelf = globalThis.self,
      prevFetch = globalThis.fetch;
    globalThis.self = {
      postMessage: (m) => posted.push(m),
      location: new URL('http://localhost/'),
    };
    globalThis.fetch = async () => {
      fetches++;
      if (fail) return new Response('missing', { status: 404 });
      return new Response(bytes, { headers: { 'Content-Type': 'application/wasm' } });
    };
    try {
      vi.resetModules();
      await import('../src/kernel/worker.js');
      const send = (id) => self.onmessage({ data: { id, op: 'ping', input: new Float64Array(0) } });
      await send(1);
      expect(posted[0]).toMatchObject({ id: 1, error: expect.stringContaining('404') });
      fail = false;
      fetches = 0;
      await Promise.all([send(2), send(3), send(4)]);
      expect(fetches).toBe(1);
      expect(posted.slice(1).map((m) => m.result)).toEqual([true, true, true]);
    } finally {
      globalThis.self = prevSelf;
      globalThis.fetch = prevFetch;
    }
  });
});

describe('Gerber solder mask', () => {
  it('opens the mask over a via marked as not tented', () => {
    const via = (id, extra) => ({
      id,
      t: 'via',
      x: mm(10),
      y: mm(10),
      d: mm(0.6),
      drill: mm(0.3),
      from: 'top',
      to: 'bottom',
      ...extra,
    });
    const flashes = (objects, opts = {}) => {
      const files = exportGerbers(pourBoard(objects), {}, opts);
      return ['topSolder', 'bottomSolder'].map(
        (l) => (files.find((f) => f.layer === l).content.match(/D03\*/g) || []).length,
      );
    };
    expect(flashes([via('v')])).toEqual([0, 0]);
    expect(flashes([via('v', { tented: false })])).toEqual([1, 1]);
    expect(flashes([via('v')], { untentVias: true })).toEqual([1, 1]);
  });
});
