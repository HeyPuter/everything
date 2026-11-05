import { describe, it, expect } from 'vitest';
import { importKicad } from '../src/io/kicad/index.js';
import { parseSexpr, find, hasFlag } from '../src/io/kicad/sexpr.js';
import { arcFrom3 } from '../src/io/kicad/common.js';
import { parseProject, sheetExtents, defaultSheet } from '../src/model/project.js';
import { placeFootprint, placeSymbol } from '../src/model/place.js';
import { polyArea } from '../src/core/geom.js';

const F = '(effects (font (size 1.27 1.27)))';

const SCH = `(kicad_sch (version 20230121) (generator eeschema)
  (uuid "root")
  (paper "A4")
  (title_block (title "Divider") (rev "B") (company "Example"))
  (lib_symbols
    (symbol "Device:R" (pin_numbers hide) (pin_names (offset 0)) (in_bom yes) (on_board yes)
      (property "Reference" "R" (at 2.032 0 90) ${F})
      (property "Value" "R" (at 0 0 90) ${F})
      (symbol "R_0_1"
        (rectangle (start -1.016 -2.54) (end 1.016 2.54) (stroke (width 0.254) (type default)) (fill (type background))))
      (symbol "R_1_1"
        (pin passive line (at 0 3.81 270) (length 1.27) (name "~" ${F}) (number "1" ${F}))
        (pin passive line (at 0 -3.81 90) (length 1.27) (name "~" ${F}) (number "2" ${F}))))
    (symbol "power:VCC" (power) (pin_names (offset 0)) (in_bom yes) (on_board yes)
      (property "Reference" "#PWR" (at 0 -3.81 0) (effects (font (size 1.27 1.27)) hide))
      (property "Value" "VCC" (at 0 3.81 0) ${F})
      (symbol "VCC_0_1"
        (polyline (pts (xy -0.762 1.27) (xy 0 2.54) (xy 0.762 1.27)) (stroke (width 0) (type default)) (fill (type none)))
        (polyline (pts (xy 0 0) (xy 0 2.54)) (stroke (width 0) (type default)) (fill (type none))))
      (symbol "VCC_1_1"
        (pin power_in line (at 0 0 90) (length 0) hide (name "VCC" ${F}) (number "1" ${F})))))
  (junction (at 100.33 44.45) (diameter 0) (color 0 0 0 0) (uuid "j1"))
  (wire (pts (xy 100.33 41.91) (xy 100.33 46.99)) (stroke (width 0) (type default)) (uuid "w1"))
  (wire (pts (xy 100.33 44.45) (xy 110.49 44.45)) (stroke (width 0) (type default)) (uuid "w2"))
  (wire (pts (xy 110.49 44.45) (xy 110.49 46.99)) (stroke (width 0) (type default)) (uuid "w3"))
  (wire (pts (xy 100.33 54.61) (xy 100.33 58.42)) (stroke (width 0) (type default)) (uuid "w4"))
  (wire (pts (xy 110.49 54.61) (xy 110.49 58.42)) (stroke (width 0) (type default)) (uuid "w5"))
  (label "MID" (at 100.33 58.42 0) (effects (font (size 1.27 1.27)) (justify left bottom)) (uuid "l1"))
  (label "MID" (at 110.49 58.42 0) (effects (font (size 1.27 1.27)) (justify left bottom)) (uuid "l2"))
  (text "Voltage \\"divider\\"" (at 90 70 0) ${F} (uuid "t1"))
  (bus_entry (at 20 20) (size 2.54 2.54) (stroke (width 0)) (uuid "b1"))
  (symbol (lib_id "Device:R") (at 100.33 50.8 0) (unit 1) (in_bom yes) (on_board yes) (uuid "r1")
    (property "Reference" "R1" (at 102.87 49.53 0) (effects (font (size 1.27 1.27)) (justify left)))
    (property "Value" "10k" (at 102.87 52.07 0) (effects (font (size 1.27 1.27)) (justify left)))
    (property "Footprint" "Resistor_SMD:R_0603_1608Metric" (at 100.33 50.8 0) (effects (font (size 1.27 1.27)) hide))
    (pin "1" (uuid "p1")) (pin "2" (uuid "p2")))
  (symbol (lib_id "Device:R") (at 110.49 50.8 0) (mirror y) (unit 1) (in_bom yes) (on_board yes) (uuid "r2")
    (property "Reference" "R2" (at 113.03 49.53 0) (effects (font (size 1.27 1.27)) (justify left)))
    (property "Value" "4k7" (at 113.03 52.07 0) (effects (font (size 1.27 1.27)) (justify left)))
    (property "Footprint" "Resistor_SMD:R_0603_1608Metric" (at 110.49 50.8 0) (effects (font (size 1.27 1.27)) hide)))
  (symbol (lib_id "power:VCC") (at 100.33 41.91 0) (unit 1) (in_bom yes) (on_board yes) (uuid "pw1")
    (property "Reference" "#PWR01" (at 100.33 45.72 0) (effects (font (size 1.27 1.27)) hide))
    (property "Value" "VCC" (at 100.33 38.1 0) ${F}))
)`;

const R0603 = (ref, value, layer, at, padAngle, side) => `(footprint "Resistor_SMD:R_0603_1608Metric" (layer "${layer}") (at ${at})
    (fp_text reference "${ref}" (at 0 -1.43 ${padAngle}) (layer "${side}.SilkS") (effects (font (size 1 1) (thickness 0.15))))
    (fp_text value "${value}" (at 0 1.43 ${padAngle}) (layer "${side}.Fab") (effects (font (size 1 1) (thickness 0.15))))
    (fp_line (start -0.237 -0.5225) (end 0.237 -0.5225) (stroke (width 0.12) (type solid)) (layer "${side}.SilkS"))
    (fp_rect (start -1.48 -0.73) (end 1.48 0.73) (stroke (width 0.05) (type solid)) (fill none) (layer "${side}.CrtYd"))
    (fp_rect (start -0.8 -0.4) (end 0.8 0.4) (stroke (width 0.1) (type solid)) (fill none) (layer "${side}.Fab"))
    (pad "1" smd roundrect (at -0.825 0 ${padAngle}) (size 0.8 0.95) (layers "${side}.Cu" "${side}.Paste" "${side}.Mask") (roundrect_rratio 0.25) (net 1 "VCC"))
    (pad "2" smd roundrect (at 0.825 0 ${padAngle}) (size 0.8 0.95) (layers "${side}.Cu" "${side}.Paste" "${side}.Mask") (roundrect_rratio 0.25) (net 2 "/MID")))`;

const PCB = `(kicad_pcb (version 20221018) (generator pcbnew)
  (general (thickness 1.6))
  (paper "A4")
  (layers (0 "F.Cu" signal) (31 "B.Cu" signal) (36 "B.SilkS" user "B.Silkscreen") (37 "F.SilkS" user "F.Silkscreen") (44 "Edge.Cuts" user) (49 "F.Fab" user))
  (setup (pad_to_mask_clearance 0.05) (aux_axis_origin 0 0))
  (net 0 "")
  (net 1 "VCC")
  (net 2 "/MID")
  (net 3 "GND")
  ${R0603('R1', '10k', 'F.Cu', '10 10', 0, 'F')}
  ${R0603('R2', '4k7', 'B.Cu', '20 10 90', 90, 'B')}
  (footprint "Connector:PinHeader_1x02_P2.54mm" (layer "F.Cu") (at 30 20)
    (fp_text reference "J1" (at 0 -2.33) (layer "F.SilkS") (effects (font (size 1 1) (thickness 0.15))))
    (fp_text value "Conn" (at 0 4.87) (layer "F.Fab") (effects (font (size 1 1) (thickness 0.15))))
    (pad "1" thru_hole rect (at 0 0) (size 1.7 1.7) (drill 1) (layers "*.Cu" "*.Mask") (net 1 "VCC"))
    (pad "2" thru_hole oval (at 0 2.54) (size 1.7 1.7) (drill 1) (layers "*.Cu" "*.Mask") (net 3 "GND")))
  (gr_rect (start 0 0) (end 50 30) (stroke (width 0.1) (type default)) (fill none) (layer "Edge.Cuts"))
  (gr_text "REV B" (at 25 28) (layer "F.SilkS") (effects (font (size 1.5 1.5) (thickness 0.2))))
  (segment (start 10.825 10) (end 15 10) (width 0.25) (layer "F.Cu") (net 2))
  (arc (start 15 10) (mid 16.4142 10.5858) (end 17 12) (width 0.25) (layer "F.Cu") (net 2))
  (via (at 20 15) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net 1))
  (zone (net 3) (net_name "GND") (layer "B.Cu") (hatch edge 0.5) (connect_pads (clearance 0.3)) (min_thickness 0.25)
    (fill yes (thermal_gap 0.5) (thermal_bridge_width 0.5))
    (polygon (pts (xy 1 1) (xy 49 1) (xy 49 29) (xy 1 29))))
  (dimension (type aligned) (layer "Dwgs.User") (pts (xy 0 0) (xy 50 0)))
)`;

const MM = 1e6;

describe('S-expression reader', () => {
  it('parses nested lists, numbers, quoted strings and escapes', () => {
    const r = parseSexpr('(a 1 -2.5 1e3 "x \\"y\\"" sym (b "1") (hide yes))');
    expect(r[0]).toBe('a');
    expect(r.slice(1, 4)).toEqual([1, -2.5, 1000]);
    expect(r[4]).toBe('x "y"');
    expect(r[5]).toBe('sym');
    expect(find(r, 'b')[1]).toBe('1');
    expect(hasFlag(r, 'hide')).toBe(true);
  });

  it('parses a large board quickly', () => {
    const segs = [];
    for (let i = 0; i < 60000; i++) segs.push(`(segment (start ${i * 0.1} 1.5) (end ${i * 0.1 + 0.05} 2.5) (width 0.25) (layer "F.Cu") (net ${i % 50}) (uuid "${i}"))`);
    const text = `(kicad_pcb (version 1) ${segs.join('\n')})`;
    const t0 = performance.now();
    const r = parseSexpr(text);
    expect(r.length).toBe(60002); // head, (version 1) and the segments
    expect(performance.now() - t0).toBeLessThan(1500);
    expect(text.length).toBeGreaterThan(5_000_000);
  });

  it('computes counter-clockwise arcs from three points', () => {
    const a = arcFrom3([1, 0], [0, 1], [-1, 0]);
    expect(a.cx).toBeCloseTo(0);
    expect(a.r).toBeCloseTo(1);
    expect(a.a0).toBeCloseTo(0);
    expect(a.sweep).toBeCloseTo(180);
    const b = arcFrom3([-1, 0], [0, 1], [1, 0]);
    expect(b.a0).toBeCloseTo(0);
    expect(b.sweep).toBeCloseTo(180);
  });
});

describe('schematic import', () => {
  it('imports parts, wires, labels, power and junctions with a working netlist', async () => {
    const { project: data, warnings } = await importKicad([{ name: 'divider.kicad_sch', text: SCH }]);
    const p = parseProject(data);
    expect(p.name).toBe('divider');
    const sheet = p.sheets[0];
    expect(sheet.sheet.title).toBe('Divider');
    expect(sheet.sheet.revision).toBe('B');
    const H = sheetExtents(defaultSheet()).maxY;
    const items = [...sheet.items()];
    const r1 = items.find((o) => o.t === 'part' && o.designator === 'R1');
    const r2 = items.find((o) => o.t === 'part' && o.designator === 'R2');
    expect(r1.value).toBe('10k');
    expect(r1.x).toBe(100.33 * MM);
    expect(r1.y).toBe(H - 50.8 * MM);
    expect(r2.mirror).toBe(true);
    expect(r1.params.Footprint).toBe('Resistor_SMD:R_0603_1608Metric');
    // Pin 1 of R1 sits above the body (y up), at the wire end.
    const pins = placeSymbol(p.library[r1.comp], r1).pins;
    expect(pins.find((x) => x.num === '1')).toMatchObject({ x: 100.33 * MM, y: H - 46.99 * MM });
    const power = items.find((o) => o.t === 'power');
    expect(power).toMatchObject({ net: 'VCC', style: 'bar', x: 100.33 * MM, y: H - 41.91 * MM, rot: 0 });
    expect(items.filter((o) => o.t === 'wire')).toHaveLength(5);
    expect(items.filter((o) => o.t === 'label')).toHaveLength(2);
    expect(items.filter((o) => o.t === 'junction')).toHaveLength(1);
    expect(items.find((o) => o.t === 'text').text).toBe('Voltage "divider"');
    const nets = new Map(p.netlist().nets.map((n) => [n.name, n.nodes.map((x) => `${x.ref}-${x.pin}`).sort()]));
    expect(nets.get('VCC')).toEqual(['R1-1', 'R2-1']);
    expect(nets.get('MID')).toEqual(['R1-2', 'R2-2']);
    expect(warnings.some((w) => /bus entr/i.test(w))).toBe(true);
    // The symbol keeps its body fill and hidden pin numbers.
    const def = p.library[r1.comp];
    expect(def.symbol.graphics[0]).toMatchObject({ t: 'rect', fill: 'body' });
    expect(def.symbol.showPinNumbers).toBe(false);
    expect(def.prefix).toBe('R');
  });
});

describe('board import', () => {
  it('imports footprints, copper, outline, zones and layer mapping', async () => {
    const { project: data, warnings } = await importKicad([{ name: 'divider.kicad_pcb', text: PCB }]);
    const p = parseProject(data);
    const b = p.boards[0];
    expect(b.board.copper).toBe(2);
    expect(b.board.thickness).toBe(1.6 * MM);
    expect(Math.abs(polyArea(b.board.outline))).toBeCloseTo(50 * 30 * MM * MM, -6);
    expect(polyArea(b.board.outline)).toBeGreaterThan(0);
    expect(b.rules.maskExpansion).toBe(0.05 * MM);
    const items = [...b.items()];
    const comps = items.filter((o) => o.t === 'comp');
    expect(comps.map((c) => c.designator).sort()).toEqual(['J1', 'R1', 'R2']);
    const r1 = comps.find((c) => c.designator === 'R1');
    const r2 = comps.find((c) => c.designator === 'R2');
    expect(r1.padNets).toEqual({ 1: 'VCC', 2: 'MID' });
    expect(r1).toMatchObject({ x: 10 * MM, y: -10 * MM, side: 'top', value: '10k' });
    expect(r2).toMatchObject({ side: 'bottom', rot: 90 });
    // Pad 1 of R1 lands at x 10 - 0.825 mm; bottom R2 pad 1 lands where the file puts it.
    const p1 = placeFootprint(p.library[r1.comp], r1).pads.find((x) => x.num === '1');
    expect(p1).toMatchObject({ x: Math.round(9.175 * MM), y: -10 * MM, side: 'top' });
    const q1 = placeFootprint(p.library[r2.comp], r2).pads.find((x) => x.num === '1');
    expect(q1).toMatchObject({ x: 20 * MM, y: Math.round(-10.825 * MM), side: 'bottom' });
    // Bottom footprints are normalized to top-side definitions.
    const r2def = p.library[r2.comp];
    expect(r2def.footprint.pads.every((x) => x.side === 'top')).toBe(true);
    expect(r2def.footprint.graphics.some((g) => g.layer === 'topOverlay')).toBe(true);
    expect(r2def.footprint.courtyard).toBeTruthy();
    const j1 = p.library[comps.find((c) => c.designator === 'J1').comp];
    expect(j1.footprint.pads[0]).toMatchObject({ side: 'thru', drill: 1 * MM, shape: 'rect', plated: true });
    expect(j1.footprint.pads[1].shape).toBe('oval');
    const track = items.find((o) => o.t === 'track' && o.layer === 'top');
    expect(track).toMatchObject({ net: 'MID', w: 0.25 * MM, x1: 10.825 * MM, y1: -10 * MM });
    const arc = items.find((o) => o.t === 'arc');
    expect(arc.r).toBeCloseTo(2 * MM, -3);
    expect(arc.sweep).toBeCloseTo(90, 0);
    expect(items.find((o) => o.t === 'via')).toMatchObject({ net: 'VCC', d: 0.6 * MM, drill: 0.3 * MM });
    const pour = items.find((o) => o.t === 'pour');
    expect(pour).toMatchObject({ layer: 'bottom', net: 'GND', clearance: 0.3 * MM, minWidth: 0.25 * MM });
    expect(polyArea(pour.pts)).toBeGreaterThan(0);
    expect(items.find((o) => o.t === 'text')).toMatchObject({ layer: 'topOverlay', text: 'REV B' });
    expect(Object.keys(b.nets).sort()).toEqual(['GND', 'MID', 'VCC']);
    expect(warnings.some((w) => /dimension/i.test(w))).toBe(true);
  });

  it('links schematic parts to board footprints by designator', async () => {
    const { project: data, warnings } = await importKicad([
      { name: 'divider.kicad_pro', text: JSON.stringify({ net_settings: { classes: [{ name: 'Default', clearance: 0.15, track_width: 0.3, via_diameter: 0.7, via_drill: 0.35 }, { name: 'Power', clearance: 0.2, track_width: 0.6, nets: ['/VCC'] }] } }) },
      { name: 'divider.kicad_sch', text: SCH },
      { name: 'divider.kicad_pcb', text: PCB },
    ]);
    const p = parseProject(data);
    expect(p.sheets).toHaveLength(1);
    expect(p.boards).toHaveLength(1);
    const parts = [...p.sheets[0].items()].filter((o) => o.t === 'part');
    const comps = [...p.boards[0].items()].filter((o) => o.t === 'comp');
    for (const part of parts) {
      const comp = comps.find((c) => c.designator === part.designator);
      expect(comp.uid).toBe(part.uid);
      expect(comp.comp).toBe(part.comp);
      const def = p.library[part.comp];
      expect(def.symbol.pins).toHaveLength(2);
      expect(def.footprint.pads).toHaveLength(2);
    }
    expect(warnings.some((w) => /J1/.test(w))).toBe(true);
    const rules = p.boards[0].rules;
    expect(rules.clearance).toBe(0.15 * MM);
    expect(rules.trackWidth).toBe(0.3 * MM);
    expect(rules.netClasses.Power).toMatchObject({ width: 0.6 * MM, nets: ['VCC'] });
  });

  it('never throws on damaged input and reports it', async () => {
    const { project, warnings } = await importKicad([
      { name: 'broken.kicad_pcb', text: '(kicad_pcb (footprint "X" (pad "1" smd custom (at 0 0) (size 1 1) (layers "F.Cu"))))' },
      { name: 'notes.txt', text: 'hello' },
    ]);
    expect(() => parseProject(project)).not.toThrow();
    expect(warnings.some((w) => /notes\.txt/.test(w))).toBe(true);
    expect(warnings.some((w) => /custom/.test(w))).toBe(true);
    expect(warnings.some((w) => /Edge\.Cuts/.test(w))).toBe(true);
  });
});
