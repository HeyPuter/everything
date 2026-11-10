// Electrical rules check for schematics. Each finding points at a location
// on a sheet so the Messages panel can zoom to it.

import { placeSymbol } from './place.js';
import { connectionPoints } from './sch.js';

const key = (x, y) => `${x},${y}`;

const DRIVERS = new Set(['output', 'power']);

/**
 * @param {Array<{id:string,name:string,objects:object[]}>} sheets
 * @param {Record<string, object>} lib
 * @param {ReturnType<import('./netlist.js').buildNetlist>} netlist
 * @param {{ requireFootprints?: boolean }} [opts]
 * @returns {Array<{severity:'error'|'warning', rule:string, message:string, sheetId:string, x:number, y:number, ids:string[]}>}
 */
export function runErc(sheets, lib, netlist, opts = {}) {
  const out = [];
  const add = (severity, rule, message, sheetId, x, y, ids = []) => out.push({ severity, rule, message, sheetId, x, y, ids });

  // Designators.
  const seen = new Map();
  for (const s of sheets) for (const o of s.objects) {
    if (o.t !== 'part') continue;
    const def = lib[o.comp];
    if (!def) { add('error', 'missing-component', `${o.designator}: component definition is missing from the project library`, s.id, o.x, o.y, [o.id]); continue; }
    if (!o.designator || /\?$/.test(o.designator)) add('error', 'unannotated', `${o.designator || 'Part'} is not annotated`, s.id, o.x, o.y, [o.id]);
    else if (seen.has(o.designator)) {
      const prev = seen.get(o.designator);
      add('error', 'duplicate-designator', `Duplicate designator ${o.designator}`, s.id, o.x, o.y, [o.id, prev.id]);
    } else seen.set(o.designator, o);
    if (opts.requireFootprints !== false && !def.footprint && def.symbol.pins.length) add('warning', 'no-footprint', `${o.designator} has no footprint`, s.id, o.x, o.y, [o.id]);
  }

  // Pin connections.
  const netByName = new Map(netlist.nets.map((n) => [n.name, n]));
  for (const s of sheets) {
    const si = netlist.sheets.get(s.id);
    for (const o of s.objects) {
      if (o.t !== 'part') continue;
      const def = lib[o.comp];
      if (!def) continue;
      for (const p of placeSymbol(def, o).pins) {
        if (p.hidden) continue;
        const net = netlist.byPin.get(`${o.id}:${p.num}`);
        const n = net ? netByName.get(net) : null;
        const connected = n && (n.nodes.length > 1 || n.labels.some((l) => l.kind !== 'hidden'));
        const flagged = si?.noErc.has(key(p.x, p.y));
        if (p.type === 'nc') {
          if (connected && !flagged) add('warning', 'nc-connected', `${o.designator} pin ${p.num} (${p.name}) is marked not connected but has a connection`, s.id, p.x, p.y, [o.id]);
          continue;
        }
        if (!connected && !flagged) {
          const sev = p.type === 'input' || p.type === 'power' ? 'error' : 'warning';
          add(sev, 'unconnected-pin', `Unconnected pin ${o.designator}-${p.num} (${p.name || p.type})`, s.id, p.x, p.y, [o.id]);
        }
      }
    }
  }

  // Net level checks.
  for (const n of netlist.nets) {
    const pins = n.nodes.filter((x) => !x.hidden);
    const outputs = n.nodes.filter((x) => x.type === 'output');
    if (outputs.length > 1) {
      const f = outputs[1];
      add('error', 'output-conflict', `Net ${n.name} is driven by several outputs (${outputs.map((x) => `${x.ref}-${x.pin}`).join(', ')})`, f.sheetId, f.x, f.y, [f.partId]);
    }
    const inputs = n.nodes.filter((x) => x.type === 'input');
    const hasDriver = n.nodes.some((x) => DRIVERS.has(x.type) || x.type === 'bidir' || x.type === 'tristate' || x.type === 'passive' || x.type === 'opencollector' || x.type === 'openemitter')
      || n.labels.some((l) => l.kind === 'power' || l.kind === 'port');
    if (inputs.length && !hasDriver) {
      const f = inputs[0];
      add('warning', 'undriven-input', `Net ${n.name} has inputs but no driver`, f.sheetId, f.x, f.y, [f.partId]);
    }
    if (pins.length === 1 && n.labels.some((l) => l.kind === 'label')) {
      const l = n.labels.find((x) => x.kind === 'label');
      add('warning', 'single-pin-net', `Net ${n.name} connects to only one pin`, l.sheetId, l.obj.x, l.obj.y, [l.obj.id]);
    }
    if (!pins.length && n.labels.length) {
      for (const l of n.labels) if (l.obj && l.kind === 'label' && l.attached) add('warning', 'floating-label', `Net label ${l.name} is not connected to any pin`, l.sheetId, l.obj.x, l.obj.y, [l.obj.id]);
    }
    // A name that touches nothing still joins its net by name, so the wire
    // or pin it was meant for silently stays on another net.
    for (const l of n.labels) {
      if (!l.obj || l.attached) continue;
      const what = l.kind === 'label' ? 'Net label' : l.kind === 'power' ? 'Power port' : 'Port';
      add('warning', 'floating-label', `${what} ${l.name} is not attached to a wire or pin`, l.sheetId, l.obj.x, l.obj.y, [l.obj.id]);
    }
    if (n.aliases.length) {
      const l = n.labels.find((x) => x.obj) || n.nodes[0];
      if (l) add('warning', 'multiple-names', `Net ${n.name} also has the names ${n.aliases.join(', ')}`, l.sheetId, l.obj?.x ?? l.x, l.obj?.y ?? l.y, l.obj ? [l.obj.id] : []);
    }
  }

  // Dangling wire ends (not on a pin, label, port, junction or other wire).
  for (const s of sheets) {
    const si = netlist.sheets.get(s.id);
    if (!si) continue;
    const named = namedPoints(s, lib);
    const junctionSet = new Set(si.junctions.map(([x, y]) => key(x, y)));
    for (const o of s.objects) {
      if (o.t !== 'wire') continue;
      const n = o.pts.length;
      for (const [x, y] of [[o.pts[0], o.pts[1]], [o.pts[n - 2], o.pts[n - 1]]]) {
        const k = key(x, y);
        const count = si.pointCount.get(k) || 0;
        if (count < 2 && !junctionSet.has(k) && !si.noErc.has(k) && !named.has(k)) {
          add('warning', 'dangling-wire', 'Wire end is not connected', s.id, x, y, [o.id]);
        }
      }
    }
  }

  out.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1));
  return out;
}

/** Points occupied by labels, power ports, ports and junctions on a sheet. */
function namedPoints(sheet, lib) {
  const out = new Set();
  for (const o of sheet.objects) {
    if (o.t === 'port') for (const [x, y] of connectionPoints(o, lib)) out.add(key(x, y));
    else if (o.t === 'label' || o.t === 'power' || o.t === 'junction') out.add(key(o.x, o.y));
  }
  return out;
}
