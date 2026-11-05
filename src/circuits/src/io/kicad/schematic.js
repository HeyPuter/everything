// Schematic import: lib_symbols become component definitions and symbol
// instances become parts; wires, buses, junctions, labels, power symbols,
// no-connect markers, text and graphics map to their Circuits objects.
//
// Coordinates: schematic positions are in mm with y down from the top of the
// sheet, so y becomes sheetHeight - y. Library symbol coordinates already
// have y up and are used as is.
//
// Symbol orientation: the instance mirror is applied in symbol space first,
// then the rotation (counter-clockwise on screen). Multi-unit symbols get one
// definition per unit, holding that unit's pins plus the common (unit 0)
// graphics and pins; the board footprint is attached to the lowest unit.

import { parseSexpr, find, findAll, val, hasFlag, points, property } from './sexpr.js';
import { nm, norm360, slug, arcFrom3, fontSize, strokeWidth, textAlign } from './common.js';
import { uid } from '../../core/emitter.js';
import { sheetExtents, defaultSheet } from '../../model/project.js';
import { textWidth } from '../../render/font.js';
import { SCH_TEXT } from '../../model/sch.js';

const PIN_TYPE = {
  input: 'input', output: 'output', bidirectional: 'bidir', tri_state: 'tristate', passive: 'passive',
  free: 'passive', unspecified: 'passive', power_in: 'power', power_out: 'power',
  open_collector: 'opencollector', open_emitter: 'openemitter', no_connect: 'nc',
};
const PIN_SHAPE = { line: 'none', inverted: 'dot', clock: 'clock', inverted_clock: 'dotclock' };
const PORT_IO = { input: 'in', output: 'out', bidirectional: 'bidir', tri_state: 'bidir', passive: 'unspec' };
const PAPER = { A4: 'A4', A3: 'A3', A2: 'A2', A1: 'A1', A0: 'A0', A: 'A', B: 'B', C: 'C', D: 'D', E: 'E', USLetter: 'Letter', USLegal: 'Letter', USLedger: 'B' };

const rot90 = (a) => norm360(Math.round(norm360(a) / 90) * 90);

function fillOf(item) {
  const t = val(find(item, 'fill'), 'type');
  if (t === 'background') return 'body';
  if (t === 'outline' || t === 'color') return 'solid';
  return undefined;
}

/** Converts one lib graphic item (y up, mm) to a Circuits graphic. */
function libGraphic(item, warnings) {
  const w = nm(strokeWidth(item));
  switch (item[0]) {
    case 'rectangle': {
      const s = find(item, 'start'), e = find(item, 'end');
      if (!s || !e) return null;
      return { t: 'rect', x1: nm(s[1]), y1: nm(s[2]), x2: nm(e[1]), y2: nm(e[2]), w, fill: fillOf(item) };
    }
    case 'polyline': {
      const pts = points(item).flatMap(([x, y]) => [nm(x), nm(y)]);
      if (pts.length < 4) return null;
      const fill = fillOf(item);
      return fill ? { t: 'poly', pts, w, fill } : { t: 'polyline', pts, w };
    }
    case 'circle': {
      const c = find(item, 'center');
      if (!c) return null;
      return { t: 'circle', cx: nm(c[1]), cy: nm(c[2]), r: nm(val(item, 'radius', 1, 0)), w, fill: fillOf(item) };
    }
    case 'arc': {
      const s = find(item, 'start'), m = find(item, 'mid'), e = find(item, 'end');
      if (!s || !m || !e) { warnings.add('Some symbol arcs use an old format and were skipped.'); return null; }
      const a = arcFrom3([s[1], s[2]], [m[1], m[2]], [e[1], e[2]]);
      if (!a) return { t: 'line', x1: nm(s[1]), y1: nm(s[2]), x2: nm(e[1]), y2: nm(e[2]), w };
      return { t: 'arc', cx: nm(a.cx), cy: nm(a.cy), r: nm(a.r), a0: a.a0, sweep: a.sweep, w };
    }
    case 'text': {
      const at = find(item, 'at');
      if (!at) return null;
      let ang = Number(at[3]) || 0;
      if (Math.abs(ang) > 360) ang /= 10;
      return { t: 'text', x: nm(at[1]), y: nm(at[2]), text: String(item[1] ?? ''), size: nm(fontSize(item)), rot: rot90(ang), align: textAlign(item) };
    }
    case 'bezier': {
      warnings.add('Bezier curves in symbols were imported as straight segments.');
      const pts = points(item).flatMap(([x, y]) => [nm(x), nm(y)]);
      return pts.length >= 4 ? { t: 'polyline', pts, w } : null;
    }
    default:
      return null;
  }
}

function libPin(item) {
  const at = find(item, 'at');
  if (!at) return null;
  const etype = typeof item[1] === 'string' ? item[1] : 'passive';
  const shape = typeof item[2] === 'string' ? item[2] : 'line';
  const name = val(item, 'name', 1, '');
  const num = String(val(item, 'number', 1, ''));
  const type = PIN_TYPE[etype] || 'passive';
  const hidden = hasFlag(item, 'hide');
  return {
    num, name: name === '~' ? '' : String(name), x: nm(at[1]), y: nm(at[2]), length: nm(val(item, 'length', 1, 2.54)),
    rot: rot90(Number(at[3]) || 0), type, shape: PIN_SHAPE[shape] || 'none',
    // Hidden power inputs join the net named after the pin, as in the source tool.
    ...(hidden && etype === 'power_in' ? { hidden: true } : hidden ? { hideName: true, hideNum: true } : {}),
  };
}

/** Parses lib_symbols into reusable symbol descriptions keyed by lib id. */
function readLibSymbols(root, warnings) {
  const out = new Map();
  for (const sym of findAll(find(root, 'lib_symbols'), 'symbol')) {
    const libId = String(sym[1]);
    if (find(sym, 'extends')) warnings.add(`Symbol ${libId} extends another symbol; only its own drawing was imported.`);
    const units = new Map();
    const unitOf = (u) => { if (!units.has(u)) units.set(u, { pins: [], graphics: [] }); return units.get(u); };
    const absorb = (container, unit) => {
      for (let i = 1; i < container.length; i++) {
        const item = container[i];
        if (!Array.isArray(item)) continue;
        if (item[0] === 'pin') { const p = libPin(item); if (p) unitOf(unit).pins.push(p); } else if (['rectangle', 'polyline', 'circle', 'arc', 'text', 'bezier'].includes(item[0])) {
          const g = libGraphic(item, warnings);
          if (g) unitOf(unit).graphics.push(g);
        }
      }
    };
    absorb(sym, 0);
    for (const sub of findAll(sym, 'symbol')) {
      const m = /_(\d+)_(\d+)$/.exec(String(sub[1]));
      const unit = m ? Number(m[1]) : 0, style = m ? Number(m[2]) : 1;
      if (style > 1) continue; // alternate body styles are not imported
      absorb(sub, unit);
    }
    const ref = property(sym, 'Reference'), value = property(sym, 'Value');
    const pos = (p) => { const at = find(p, 'at'); return at ? { x: nm(at[1]), y: nm(at[2]) } : undefined; };
    const allGraphics = [...units.values()].flatMap((u) => u.graphics);
    let sumY = 0, count = 0;
    for (const g of allGraphics) for (const y of [g.y1, g.y2, g.cy, ...(g.pts || []).filter((_, i) => i % 2)]) if (Number.isFinite(y)) { sumY += y; count++; }
    out.set(libId, {
      libId,
      name: libId.includes(':') ? libId.split(':').pop() : libId,
      isPower: !!find(sym, 'power'),
      prefix: String(ref?.[2] ?? 'U').replace(/\?$/, '') || 'U',
      value: String(value?.[2] ?? ''),
      description: String(property(sym, 'Description')?.[2] ?? property(sym, 'ki_description')?.[2] ?? ''),
      keywords: String(property(sym, 'ki_keywords')?.[2] ?? '').split(/\s+/).filter(Boolean),
      designatorPos: pos(ref), valuePos: pos(value),
      showPinNames: !hasFlag(find(sym, 'pin_names'), 'hide'),
      showPinNumbers: !hasFlag(find(sym, 'pin_numbers'), 'hide'),
      units,
      maxUnit: Math.max(1, ...[...units.keys()]),
      pointsDown: count > 0 && sumY / count < 0,
    });
  }
  return out;
}

/** Builds (once) the definition for one unit of a lib symbol. */
export function symbolDef(lib, unit, defs) {
  const multi = lib.maxUnit > 1;
  const id = `kicad-sym-${slug(lib.libId)}${multi ? `-u${unit}` : ''}`;
  if (defs.has(id)) return defs.get(id);
  const common = lib.units.get(0) || { pins: [], graphics: [] };
  const own = lib.units.get(unit) || (multi ? { pins: [], graphics: [] } : lib.units.get(1) || { pins: [], graphics: [] });
  const def = {
    id, name: multi ? `${lib.name} (unit ${unit})` : lib.name, description: lib.description, category: 'Imported',
    prefix: lib.prefix, value: lib.value, params: {}, keywords: lib.keywords,
    symbol: {
      pins: [...common.pins, ...own.pins], graphics: [...common.graphics, ...own.graphics],
      designatorPos: lib.designatorPos, valuePos: lib.valuePos,
      showPinNames: lib.showPinNames, showPinNumbers: lib.showPinNumbers,
    },
    footprint: null,
  };
  defs.set(id, def);
  return def;
}

/** Symbol space to sheet space for an instance (mirror first, then rotate). */
function instanceTransform(inst, H) {
  const at = find(inst, 'at') || ['at', 0, 0, 0];
  const X = nm(at[1]), Y = H - nm(at[2]);
  const theta = rot90(Number(at[3]) || 0);
  const mir = val(inst, 'mirror');
  const c = Math.round(Math.cos((theta * Math.PI) / 180)), s = Math.round(Math.sin((theta * Math.PI) / 180));
  const apply = (lx, ly) => {
    let x = lx, y = ly;
    if (mir === 'y') x = -x; else if (mir === 'x') y = -y;
    return [X + x * c - y * s, Y + x * s + y * c];
  };
  const rot = mir === 'x' ? norm360(theta + 180) : theta;
  return { X, Y, theta, mirror: mir === 'x' || mir === 'y', rot, apply };
}

function textAnchor(prop, H, text, hidden) {
  const at = find(prop, 'at');
  if (!at) return null;
  const size = SCH_TEXT;
  const w = textWidth(String(text || ''), size);
  let x = nm(at[1]), y = H - nm(at[2]);
  const just = find(find(prop, 'effects'), 'justify') || [];
  if (just.includes('right')) x -= w; else if (!just.includes('left')) x -= w / 2;
  if (just.includes('top')) y -= size; else if (!just.includes('bottom')) y -= size / 2;
  return { x: Math.round(x), y: Math.round(y), hidden };
}

function propHidden(p) {
  return hasFlag(p, 'hide') || hasFlag(find(p, 'effects'), 'hide');
}

/**
 * Imports the schematic files. Returns
 * { sheets: [{ id, name, sheet, objects }], defs: Map, partsByRef: Map<ref, [{ part, unit, lib, sheetId }]> }
 */
export function importSchematics(files, warnings) {
  const parsed = [];
  for (const f of files) {
    try { parsed.push({ ...f, root: parseSexpr(f.text) }); } catch (err) { warnings.add(`${f.name}: ${err.message}`); }
  }
  // Root sheet first: the one no other sheet refers to.
  const referenced = new Set();
  for (const p of parsed) for (const sh of findAll(p.root, 'sheet')) {
    const file = property(sh, 'Sheetfile')?.[2] ?? property(sh, 'Sheet file')?.[2];
    if (file) referenced.add(String(file).split(/[\\/]/).pop());
  }
  parsed.sort((a, b) => Number(referenced.has(a.name)) - Number(referenced.has(b.name)));
  const counts = new Map();
  for (const f of referenced) counts.set(f, (counts.get(f) || 0) + 1);

  const defs = new Map();
  const partsByRef = new Map();
  const sheets = [];
  parsed.forEach((p, index) => {
    const root = p.root;
    if (root[0] !== 'kicad_sch') { warnings.add(`${p.name} is not a schematic file.`); return; }
    const paper = find(root, 'paper');
    const size = PAPER[paper?.[1]] || 'A4';
    if (paper && !PAPER[paper[1]]) warnings.add(`${p.name}: paper size ${paper[1]} became A4.`);
    const portrait = paper?.includes('portrait');
    const tb = find(root, 'title_block');
    const sheet = {
      ...defaultSheet(), size, orientation: portrait ? 'portrait' : 'landscape', number: index + 1,
      title: String(val(tb, 'title', 1, '')), revision: String(val(tb, 'rev', 1, '')), company: String(val(tb, 'company', 1, '')),
    };
    const H = sheetExtents(sheet).maxY;
    const pt = (x, y) => [nm(x), H - nm(y)];
    const libs = readLibSymbols(root, warnings);
    const objects = [];
    const sheetId = uid('d');
    // KiCad 6 keeps instance designators at the end of the root file.
    const instRefs = new Map();
    for (const path of findAll(find(root, 'symbol_instances'), 'path')) {
      const id = String(path[1]).split('/').pop();
      instRefs.set(id, { ref: val(path, 'reference'), unit: val(path, 'unit') });
    }

    for (const item of root.slice(1)) {
      if (!Array.isArray(item)) continue;
      switch (item[0]) {
        case 'symbol': {
          const libId = String(val(item, 'lib_id', 1, ''));
          const lib = libs.get(libId);
          if (!lib) { warnings.add(`Symbol ${libId} is missing from the file's symbol library and was skipped.`); break; }
          const tr = instanceTransform(item, H);
          const refProp = property(item, 'Reference'), valProp = property(item, 'Value');
          let ref = String(refProp?.[2] ?? '');
          const inst = find(find(find(item, 'instances'), 'project'), 'path');
          if (inst && val(inst, 'reference') && !String(val(inst, 'reference')).endsWith('?')) ref = String(val(inst, 'reference'));
          const legacy = instRefs.get(String(val(item, 'uuid', 1, '')));
          if (legacy?.ref) ref = String(legacy.ref);
          const unit = Number(val(item, 'unit', 1, 1)) || 1;
          const value = String(valProp?.[2] ?? lib.value);
          if (lib.isPower || ref.startsWith('#')) {
            const def = symbolDef(lib, unit, defs);
            const pin = def.symbol.pins[0];
            const [x, y] = pin ? tr.apply(pin.x, pin.y) : [tr.X, tr.Y];
            const ground = /gnd|vss|ground|earth|^0$/i.test(value) || lib.pointsDown;
            const style = /earth/i.test(value) ? 'earth' : ground ? 'gnd' : 'bar';
            const [dx, dy] = tr.apply(0, ground ? -1000 : 1000).map((v, i) => v - (i ? tr.Y : tr.X));
            const phi = (Math.atan2(dy, dx) * 180) / Math.PI;
            objects.push({ id: uid(), t: 'power', x: Math.round(x), y: Math.round(y), rot: rot90(ground ? phi + 90 : phi - 90), net: value, style });
            break;
          }
          const def = symbolDef(lib, unit, defs);
          const params = {};
          for (const pr of findAll(item, 'property')) {
            const k = String(pr[1]);
            if (['Reference', 'Value'].includes(k) || pr[2] === '' || pr[2] === '~') continue;
            params[k] = String(pr[2]);
          }
          const part = {
            id: uid(), t: 'part', comp: def.id, x: tr.X, y: tr.Y, rot: tr.rot, mirror: tr.mirror,
            designator: ref || `${lib.prefix}?`, value, params, uid: uid('u'),
          };
          if (hasFlag(item, 'dnp')) part.dnp = true;
          const fields = {};
          for (const [name, prop, text] of [['designator', refProp, part.designator], ['value', valProp, value]]) {
            const a = prop && textAnchor(prop, H, text, propHidden(prop));
            if (a) fields[name] = { dx: a.x - part.x, dy: a.y - part.y, ...(a.hidden ? { hidden: true } : {}) };
          }
          if (Object.keys(fields).length) part.fields = fields;
          objects.push(part);
          if (ref) {
            if (!partsByRef.has(ref)) partsByRef.set(ref, []);
            partsByRef.get(ref).push({ part, unit, lib, sheetId, footprint: params.Footprint || '' });
          }
          break;
        }
        case 'wire': case 'bus': {
          const pts = points(item).flatMap(([x, y]) => pt(x, y));
          if (pts.length >= 4) objects.push({ id: uid(), t: item[0], pts });
          break;
        }
        case 'junction': {
          const at = find(item, 'at');
          if (at) { const [x, y] = pt(at[1], at[2]); objects.push({ id: uid(), t: 'junction', x, y }); }
          break;
        }
        case 'no_connect': {
          const at = find(item, 'at');
          if (at) { const [x, y] = pt(at[1], at[2]); objects.push({ id: uid(), t: 'noerc', x, y }); }
          break;
        }
        case 'label': {
          const at = find(item, 'at');
          if (!at) break;
          const [x, y] = pt(at[1], at[2]);
          objects.push({ id: uid(), t: 'label', x, y, rot: rot90(Number(at[3]) || 0), text: String(item[1]) });
          break;
        }
        case 'global_label': case 'hierarchical_label': {
          const at = find(item, 'at');
          if (!at) break;
          const [x, y] = pt(at[1], at[2]);
          objects.push({ id: uid(), t: 'port', x, y, rot: rot90(Number(at[3]) || 0), name: String(item[1]), io: PORT_IO[val(item, 'shape')] || 'unspec' });
          break;
        }
        case 'text': {
          const at = find(item, 'at');
          if (!at) break;
          const [x, y] = pt(at[1], at[2]);
          objects.push({ id: uid(), t: 'text', x, y, rot: rot90(Number(at[3]) || 0), text: String(item[1] ?? ''), size: nm(fontSize(item)) });
          break;
        }
        case 'polyline': {
          const pts = points(item).flatMap(([x, y]) => pt(x, y));
          if (pts.length >= 4) objects.push({ id: uid(), t: 'gline', pts, w: nm(strokeWidth(item)) });
          break;
        }
        case 'rectangle': {
          const s = find(item, 'start'), e = find(item, 'end');
          if (s && e) { const [x1, y1] = pt(s[1], s[2]), [x2, y2] = pt(e[1], e[2]); objects.push({ id: uid(), t: 'grect', x1, y1, x2, y2, w: nm(strokeWidth(item)) }); }
          break;
        }
        case 'circle': {
          const c = find(item, 'center');
          if (c) { const [cx, cy] = pt(c[1], c[2]); objects.push({ id: uid(), t: 'gcircle', cx, cy, r: nm(val(item, 'radius', 1, 1)), w: nm(strokeWidth(item)) }); }
          break;
        }
        case 'sheet': {
          // Hierarchical sheet: draw its box and turn its pins into ports.
          const at = find(item, 'at'), sz = find(item, 'size');
          const name = String(property(item, 'Sheetname')?.[2] ?? property(item, 'Sheet name')?.[2] ?? 'Sheet');
          const file = String(property(item, 'Sheetfile')?.[2] ?? property(item, 'Sheet file')?.[2] ?? '');
          if (at && sz) {
            const [x1, y1] = pt(at[1], at[2]), [x2, y2] = pt(Number(at[1]) + Number(sz[1]), Number(at[2]) + Number(sz[2]));
            objects.push({ id: uid(), t: 'grect', x1, y1, x2, y2, w: 0 });
            objects.push({ id: uid(), t: 'text', x: x1, y: y1 + nm(1), rot: 0, text: `${name} (${file})`, size: SCH_TEXT });
          }
          if ((counts.get(file.split(/[\\/]/).pop()) || 0) > 1) warnings.add(`${file} is used by more than one sheet symbol; its nets are shared between the copies.`);
          for (const pin of findAll(item, 'pin')) {
            const pat = find(pin, 'at');
            if (!pat) continue;
            const [x, y] = pt(pat[1], pat[2]);
            objects.push({ id: uid(), t: 'port', x, y, rot: rot90((Number(pat[3]) || 0) + 180), name: String(pin[1]), io: PORT_IO[pin[2]] || 'unspec' });
          }
          break;
        }
        case 'bus_entry': warnings.add('Bus entries are not supported and were skipped.'); break;
        case 'image': warnings.add('Images in schematics are not supported and were skipped.'); break;
        case 'netclass_flag': case 'directive_label': warnings.add('Net class flags were skipped.'); break;
        case 'arc': warnings.add('Arcs drawn on schematic sheets were skipped.'); break;
        default:
      }
    }
    sheets.push({ id: sheetId, name: p.name.replace(/\.kicad_sch$/i, '.sch'), sheet, objects });
  });
  return { sheets, defs, partsByRef };
}
