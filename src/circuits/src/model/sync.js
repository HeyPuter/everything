// Schematic to board synchronisation. Compares the schematic (parts and the
// netlist) with a board and lists the changes needed: components to add,
// remove or update, and pad nets to assign. The user reviews the list and
// applies all or some of it as one undoable step.

import { mm } from '../core/units.js';
import { padForPin } from './place.js';
import { footprintBox, pcbBounds } from './pcb.js';
import { bboxOfFlat } from '../core/geom.js';

/**
 * @returns {Array<{id:string, kind:'add'|'remove'|'update'|'nets'|'rename'|'netlist', label:string, detail:string, apply:(store)=>void}>}
 */
export function planSync(project, boardDoc) {
  const lib = project.library;
  const netlist = project.netlist();
  const changes = [];

  // Schematic parts that belong on the board (have a footprint).
  const parts = new Map();
  for (const sheet of project.sheets) {
    for (const o of sheet.items()) {
      if (o.t !== 'part') continue;
      const def = lib[o.comp];
      if (!def?.footprint) continue;
      parts.set(o.uid, { part: o, def });
    }
  }

  const comps = new Map();
  for (const o of boardDoc.items()) if (o.t === 'comp' && o.uid) comps.set(o.uid, o);

  const padNetsFor = (part, def) => {
    const nets = {};
    for (const pin of def.symbol.pins) {
      const net = netlist.byPin.get(`${part.id}:${pin.num}`);
      if (net) nets[padForPin(def, pin.num)] = net;
    }
    return nets;
  };

  // Placement for new components: a grid to the right of the board outline.
  const outline = bboxOfFlat(boardDoc.board?.outline || [0, 0, 0, 0]);
  let cursorX = outline.maxX + mm(10), cursorY = outline.maxY, rowH = 0;
  // Parts from an earlier update may still wait there: start below them.
  for (const o of boardDoc.items()) {
    if (o.t !== 'comp') continue;
    const b = pcbBounds(o, lib);
    if (b.maxX > outline.maxX && b.minY - mm(3) < cursorY) cursorY = b.minY - mm(3);
  }
  const colLimit = outline.maxX + mm(10) + Math.max(mm(60), (outline.maxX - outline.minX) * 0.8);

  const sortedParts = [...parts.values()].sort((a, b) => a.part.designator.localeCompare(b.part.designator, undefined, { numeric: true }));
  for (const { part, def } of sortedParts) {
    const existing = comps.get(part.uid);
    const padNets = padNetsFor(part, def);
    if (!existing) {
      const fb = footprintBox(def);
      const w = fb.maxX - fb.minX, h = fb.maxY - fb.minY;
      if (cursorX + w > colLimit && cursorX > outline.maxX + mm(10)) { cursorX = outline.maxX + mm(10); cursorY -= rowH + mm(3); rowH = 0; }
      const x = Math.round((cursorX - fb.minX) / 50_000) * 50_000, y = Math.round((cursorY - fb.maxY) / 50_000) * 50_000;
      cursorX += w + mm(3);
      rowH = Math.max(rowH, h);
      const comp = { t: 'comp', comp: part.comp, x, y, rot: 0, side: 'top', designator: part.designator, value: part.value ?? def.value ?? '', uid: part.uid, padNets };
      changes.push({ id: `add:${part.uid}`, kind: 'add', label: `Add ${part.designator}`, detail: `${def.footprint.name} ${comp.value}`.trim(), apply: (store) => store.add(comp) });
      continue;
    }
    const upd = {};
    const notes = [];
    if (existing.designator !== part.designator) { upd.designator = part.designator; notes.push(`designator ${existing.designator} to ${part.designator}`); }
    const value = part.value ?? def.value ?? '';
    if ((existing.value ?? '') !== value) { upd.value = value; notes.push(`value to ${value || '(none)'}`); }
    if (existing.comp !== part.comp) { upd.comp = part.comp; notes.push(`footprint to ${def.footprint.name}`); }
    if (Object.keys(upd).length) {
      changes.push({ id: `upd:${part.uid}`, kind: 'update', label: `Update ${existing.designator}`, detail: notes.join(', '), apply: (store) => store.update(existing.id, upd) });
    }
    if (!sameNets(existing.padNets, padNets)) {
      const diff = describeNetDiff(existing.padNets || {}, padNets);
      changes.push({ id: `nets:${part.uid}`, kind: 'nets', label: `Nets of ${part.designator}`, detail: diff, apply: (store) => store.update(existing.id, { padNets }) });
    }
  }

  // Renamed nets: every pad that carried a net moved to one other net
  // (annotation renamed an automatic net, a label was added, two nets merged).
  // Routed copper and net class members follow. Nets are followed by their
  // pads, not their names: the old name may live on as the name of another
  // net (annotation shifts NetR1_2 to NetR2_2 and NetR2_2 to NetR3_2).
  const renameTargets = new Map();
  for (const [u, comp] of comps) {
    const entry = parts.get(u);
    if (!entry) continue;
    const next = padNetsFor(entry.part, entry.def);
    for (const [pad, from] of Object.entries(comp.padNets || {})) {
      if (!from) continue;
      let set = renameTargets.get(from);
      if (!set) renameTargets.set(from, (set = new Set()));
      set.add(next[pad] || '');
    }
  }
  const renames = new Map();
  for (const [from, targets] of renameTargets) {
    const to = targets.size === 1 ? [...targets][0] : '';
    if (to && to !== from) renames.set(from, to);
  }
  const renamedFrom = new Map();
  const netObjects = new Map();
  if (renames.size) {
    for (const o of boardDoc.items()) {
      if (o.t === 'comp' || !o.net || !renames.has(o.net)) continue;
      if (!netObjects.has(o.net)) netObjects.set(o.net, []);
      netObjects.get(o.net).push(o.id);
    }
  }
  const plannedClasses = boardDoc.rules?.netClasses || {};
  const classNets = Object.values(plannedClasses).flatMap((c) => c.nets || []);
  // Class members are rewritten from the planned lists with every rename
  // applied so far, so a name handed along a chain is not renamed twice.
  const appliedRenames = new Map();
  for (const [from, to] of renames) {
    if (!renamedFrom.has(to)) renamedFrom.set(to, from);
    const ids = netObjects.get(from) || [];
    const inClass = classNets.includes(from);
    if (!ids.length && !inClass) continue;
    const what = [];
    if (ids.length) what.push(`${ids.length} object${ids.length === 1 ? '' : 's'}`);
    if (inClass) what.push('net class');
    changes.push({
      id: `rename:${from}`,
      kind: 'rename',
      label: `Rename net ${from}`,
      detail: `to ${to} (${what.join(' and ')})`,
      apply: (store) => {
        for (const id of ids) store.update(id, (o) => (o.net === from ? { ...o, net: to } : o));
        if (!inClass) return;
        appliedRenames.set(from, to);
        store.update('rules', (r) => {
          const next = Object.entries(r.netClasses || {}).map(([k, c]) => {
            const planned = plannedClasses[k]?.nets;
            if (!planned?.some((n) => appliedRenames.has(n))) return [k, c];
            return [k, { ...c, nets: [...new Set(planned.map((n) => appliedRenames.get(n) ?? n))] }];
          });
          return { ...r, netClasses: Object.fromEntries(next) };
        });
      },
    });
  }

  for (const [u, comp] of comps) {
    if (parts.has(u)) continue;
    changes.push({ id: `rm:${u}`, kind: 'remove', label: `Remove ${comp.designator}`, detail: 'not in the schematic', apply: (store) => store.remove(comp.id) });
  }

  // Board net list (for net classes and routing).
  // A renamed net keeps its class; a name whose net was renamed away is a new net.
  const netInfo = (name) => (renames.has(name) ? null : boardDoc.nets[name]) || boardDoc.nets[renamedFrom.get(name)] || {};
  const names = Object.fromEntries(netlist.nets.map((n) => [n.name, netInfo(n.name)]));
  const before = Object.keys(boardDoc.nets).sort().join('\n');
  const after = Object.keys(names).sort().join('\n');
  const moved = Object.keys(names).some((n) => n in boardDoc.nets && JSON.stringify(names[n]) !== JSON.stringify(boardDoc.nets[n]));
  if (before !== after || moved) {
    const added = Object.keys(names).filter((n) => !(n in boardDoc.nets)).length;
    const removed = Object.keys(boardDoc.nets).filter((n) => !(n in names)).length;
    const detail = added || removed ? `${added} added, ${removed} removed` : 'settings follow the renamed nets';
    changes.push({ id: 'netlist', kind: 'netlist', label: 'Update net list', detail, apply: (store) => store.update('nets', { nets: names }) });
  }
  return changes;
}

function sameNets(a = {}, b = {}) {
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => a[k] === b[k]);
}

function describeNetDiff(a, b) {
  const out = [];
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (a[k] !== b[k]) out.push(`pad ${k}: ${a[k] || 'none'} to ${b[k] || 'none'}`);
    if (out.length >= 3) { out.push('...'); break; }
  }
  return out.join(', ');
}

/** Applies a subset of planned changes as one undoable step. */
export function applySync(boardDoc, changes) {
  boardDoc.store.transact('Update board from schematic', (store) => {
    for (const c of changes) c.apply(store);
  });
}
