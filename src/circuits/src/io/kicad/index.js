// KiCad project import. Accepts any mix of .kicad_sch, .kicad_pcb and
// .kicad_pro files and returns a Circuits project (saved JSON shape) plus a
// list of warnings about anything that could not be carried over.
//
// When both a schematic and a board are given, parts and footprints are
// linked by designator: the part's definition gains the board footprint and
// the board component shares the part's uid, so later schematic-to-board
// updates work. Pins map to pads by number.

import { importSchematics } from './schematic.js';
import { importBoard } from './board.js';
import { parseSexpr } from './sexpr.js';
import { Warnings, nm, slug } from './common.js';
import { uid } from '../../core/emitter.js';
import { FORMAT, FORMAT_VERSION, defaultRules } from '../../model/schema.js';

function kindOf(f) {
  const n = f.name.toLowerCase();
  if (n.endsWith('.kicad_sch')) return 'sch';
  if (n.endsWith('.kicad_pcb')) return 'pcb';
  if (n.endsWith('.kicad_pro')) return 'pro';
  const head = String(f.text || '').trimStart().slice(0, 12);
  if (head.startsWith('(kicad_sch')) return 'sch';
  if (head.startsWith('(kicad_pcb')) return 'pcb';
  if (head.startsWith('{')) return 'pro';
  return null;
}

/** Design rules and net classes from the project settings file. */
function rulesFromPro(pro, warnings) {
  const rules = defaultRules();
  if (!pro) return rules;
  const ns = pro.net_settings || {};
  const classes = Array.isArray(ns.classes) ? ns.classes : [];
  const assign = ns.netclass_assignments || {};
  const def = classes.find((c) => c.name === 'Default');
  if (def) {
    if (def.clearance) rules.clearance = nm(def.clearance);
    if (def.track_width) rules.trackWidth = nm(def.track_width);
    if (def.via_diameter) rules.viaDiameter = nm(def.via_diameter);
    if (def.via_drill) rules.viaDrill = nm(def.via_drill);
  }
  const dr = pro.board?.design_settings?.rules || {};
  if (dr.min_track_width) rules.minTrackWidth = nm(dr.min_track_width);
  if (dr.min_through_hole_diameter) rules.minDrill = nm(dr.min_through_hole_diameter);
  if (dr.min_via_annular_width) rules.minAnnularRing = nm(dr.min_via_annular_width);
  if (dr.min_copper_edge_clearance) rules.edgeClearance = nm(dr.min_copper_edge_clearance);
  rules.netClasses = {};
  for (const c of classes) {
    if (!c.name || c.name === 'Default') continue;
    const nets = [...(Array.isArray(c.nets) ? c.nets : []), ...Object.entries(assign).filter(([, cls]) => cls === c.name).map(([n]) => n)].map((n) => String(n).replace(/^\//, ''));
    rules.netClasses[c.name] = {
      width: nm(c.track_width || 0.25), clearance: nm(c.clearance || 0.2),
      ...(c.via_diameter ? { viaDiameter: nm(c.via_diameter) } : {}), ...(c.via_drill ? { viaDrill: nm(c.via_drill) } : {}),
      nets,
    };
  }
  if (Array.isArray(ns.netclass_patterns) && ns.netclass_patterns.length) warnings.add('Net class patterns were not applied; assign nets to classes in the design rules.');
  return rules;
}

/**
 * @param {Array<{name:string, text:string}>} files
 * @returns {Promise<{ project: object, warnings: string[] }>}
 */
export async function importKicad(files) {
  const warnings = new Warnings();
  const groups = { sch: [], pcb: [], pro: [] };
  for (const f of files) {
    const k = kindOf(f);
    if (k) groups[k].push(f); else warnings.add(`${f.name} is not a supported file and was skipped.`);
  }
  if (!groups.sch.length && !groups.pcb.length) throw new Error('No KiCad schematic (.kicad_sch) or board (.kicad_pcb) was selected.');
  // A damaged or cut-off file fails the whole import rather than giving a
  // project with parts silently missing.
  const damaged = (f, err) => new Error(`${f.name} is damaged or incomplete and nothing was imported. ${err.message}`);
  for (const key of ['sch', 'pcb']) {
    groups[key] = groups[key].map((f) => {
      try { return { ...f, root: parseSexpr(f.text) }; } catch (err) { throw damaged(f, err); }
    });
  }
  let pro = null;
  if (groups.pro[0]) {
    try { pro = JSON.parse(groups.pro[0].text); } catch (err) { throw damaged(groups.pro[0], err); }
  }

  const sch = groups.sch.length ? importSchematics(groups.sch, warnings) : { sheets: [], defs: new Map(), partsByRef: new Map() };
  const library = new Map(sch.defs);
  const boards = [];
  for (const f of groups.pcb) {
    const b = importBoard(f, warnings);
    if (b) boards.push(b);
  }

  // Link parts and footprints by designator.
  for (const b of boards) {
    for (const { comp, def, ref, fpName } of b.comps) {
      const entries = ref ? sch.partsByRef.get(ref) : null;
      if (!entries?.length) {
        library.set(def.id, def);
        if (sch.sheets.length) warnings.add(`Footprint ${ref || fpName} has no matching schematic part.`);
        continue;
      }
      const first = entries.reduce((a, e) => (e.unit < a.unit ? e : a), entries[0]);
      const symDef = library.get(first.part.comp);
      const mergedId = `${symDef.id}--${slug(fpName)}`;
      let merged = library.get(mergedId);
      if (!merged) {
        merged = { ...symDef, id: mergedId, footprint: def.footprint, value: symDef.value || def.value };
        const pins = new Set(symDef.symbol.pins.map((p) => p.num));
        const pads = new Set(def.footprint.pads.map((p) => p.num).filter(Boolean));
        const missing = [...pins].filter((n) => !pads.has(n));
        if (missing.length && entries.length === 1) warnings.add(`${ref}: pins ${missing.slice(0, 6).join(', ')} have no pad on footprint ${fpName}.`);
        library.set(mergedId, merged);
      }
      first.part.comp = mergedId;
      comp.comp = mergedId;
      comp.uid = first.part.uid;
      if (!comp.value) comp.value = first.part.value;
    }
  }
  for (const [ref, entries] of sch.partsByRef) {
    if (entries.length > 1 && new Set(entries.map((e) => e.unit)).size === entries.length) continue;
    if (entries.length > 1) warnings.add(`Designator ${ref} is used more than once.`);
  }

  // Keep only definitions something uses.
  const used = new Set();
  for (const s of sch.sheets) for (const o of s.objects) if (o.comp) used.add(o.comp);
  for (const b of boards) for (const o of b.objects) if (o.comp) used.add(o.comp);
  const lib = {};
  for (const [id, def] of library) if (used.has(id)) lib[id] = def;

  const rules = rulesFromPro(pro, warnings);
  const nameFile = groups.pro[0] || groups.sch[0] || groups.pcb[0];
  const name = nameFile ? nameFile.name.replace(/\.(kicad_pro|kicad_sch|kicad_pcb)$/i, '') : 'Imported project';
  const now = new Date().toISOString();
  const documents = [
    ...sch.sheets.map((s) => ({ id: s.id, kind: 'sch', name: s.name, sheet: s.sheet, objects: s.objects })),
    ...boards.map((b) => ({ id: uid('d'), kind: 'pcb', name: b.name, board: b.board, rules: { ...rules, ...b.rulesPatch }, nets: b.nets, objects: b.objects })),
  ];
  if (!documents.length) throw new Error(`No schematic or board could be read from the selected files. ${warnings.list.join(' ')}`.trim());
  const project = {
    format: FORMAT, version: FORMAT_VERSION, id: uid('p'), name, created: now, modified: now,
    settings: { units: 'mm' }, library: lib, documents,
  };
  return { project, warnings: warnings.list };
}

export { kindOf };
