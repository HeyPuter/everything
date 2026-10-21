/**
 * IFC4 export (STEP physical file). The spatial structure is project,
 * site, building and one storey per level. Elements carry their exact
 * tessellated geometry (IfcTriangulatedFaceSet); rooms become spaces with
 * extruded outlines. Lengths are millimetres.
 */
import { MODEL_KINDS } from '../core/scene.js';
import { levelOf } from '../core/model.js';
import { typeLabel } from '../core/catalog.js';

const CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$';

export function ifcGuid() {
  let s = CHARS[Math.floor(Math.random() * 4)];
  for (let i = 1; i < 22; i++) s += CHARS[Math.floor(Math.random() * 64)];
  return s;
}

/** Encode text for a STEP string (ASCII with \X2\ escapes). */
export function stepString(s) {
  if (s == null) return '$';
  let out = '';
  for (const ch of String(s)) {
    const c = ch.codePointAt(0);
    if (ch === "'") out += "''";
    else if (ch === '\\') out += '\\\\';
    else if (c >= 32 && c < 127) out += ch;
    else out += `\\X2\\${c.toString(16).toUpperCase().padStart(4, '0')}\\X0\\`;
  }
  return `'${out}'`;
}

const num = (v) => {
  const r = Math.round(v * 1000) / 1000;
  const s = String(r);
  return s.includes('.') || s.includes('e') ? s : `${s}.`;
};

const ENTITY = {
  wall: (g, n, p, r, tag) => `IFCWALL('${g}',$,${n},$,$,${p},${r},${tag},.NOTDEFINED.)`,
  floor: (g, n, p, r, tag) => `IFCSLAB('${g}',$,${n},$,$,${p},${r},${tag},.FLOOR.)`,
  ceiling: (g, n, p, r, tag) => `IFCCOVERING('${g}',$,${n},$,$,${p},${r},${tag},.CEILING.)`,
  roof: (g, n, p, r, tag) => `IFCROOF('${g}',$,${n},$,$,${p},${r},${tag},.NOTDEFINED.)`,
  door: (g, n, p, r, tag, el, ctx) => `IFCDOOR('${g}',$,${n},$,$,${p},${r},${tag},${num(ctx.size(el).height)},${num(ctx.size(el).width)},.DOOR.,.NOTDEFINED.,$)`,
  window: (g, n, p, r, tag, el, ctx) => `IFCWINDOW('${g}',$,${n},$,$,${p},${r},${tag},${num(ctx.size(el).height)},${num(ctx.size(el).width)},.WINDOW.,.NOTDEFINED.,$)`,
  column: (g, n, p, r, tag) => `IFCCOLUMN('${g}',$,${n},$,$,${p},${r},${tag},.COLUMN.)`,
  beam: (g, n, p, r, tag) => `IFCBEAM('${g}',$,${n},$,$,${p},${r},${tag},.BEAM.)`,
  stair: (g, n, p, r, tag) => `IFCSTAIR('${g}',$,${n},$,$,${p},${r},${tag},.STRAIGHT_RUN_STAIR.)`,
  railing: (g, n, p, r, tag) => `IFCRAILING('${g}',$,${n},$,$,${p},${r},${tag},.HANDRAIL.)`,
  furniture: (g, n, p, r, tag) => `IFCFURNITURE('${g}',$,${n},$,$,${p},${r},${tag},.NOTDEFINED.)`,
  plumbing: (g, n, p, r, tag) => `IFCSANITARYTERMINAL('${g}',$,${n},$,$,${p},${r},${tag},.NOTDEFINED.)`,
  proxy: (g, n, p, r, tag) => `IFCBUILDINGELEMENTPROXY('${g}',$,${n},$,$,${p},${r},${tag},.NOTDEFINED.)`,
};

export function writeIFC(app) {
  const doc = app.doc;
  const scene = app.scene;
  const lines = [];
  let id = 0;
  const add = (s) => {
    lines.push(`#${++id}=${s};`);
    return `#${id}`;
  };
  const project = doc.project;
  const origin = add('IFCCARTESIANPOINT((0.,0.,0.))');
  const zAxis = add('IFCDIRECTION((0.,0.,1.))');
  const xAxis = add('IFCDIRECTION((1.,0.,0.))');
  const place = add(`IFCAXIS2PLACEMENT3D(${origin},${zAxis},${xAxis})`);
  const context = add(`IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,${place},$)`);
  const body = add(`IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Body','Model',*,*,*,*,${context},$,.MODEL_VIEW.,$)`);
  const u1 = add('IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.)');
  const u2 = add('IFCSIUNIT(*,.AREAUNIT.,$,.SQUARE_METRE.)');
  const u3 = add('IFCSIUNIT(*,.VOLUMEUNIT.,$,.CUBIC_METRE.)');
  const u4 = add('IFCSIUNIT(*,.PLANEANGLEUNIT.,$,.RADIAN.)');
  const units = add(`IFCUNITASSIGNMENT((${u1},${u2},${u3},${u4}))`);
  const proj = add(`IFCPROJECT('${ifcGuid()}',$,${stepString(project.name)},${stepString(project.number ? `Project ${project.number}` : null)},$,$,$,(${context}),${units})`);
  const sitePl = add(`IFCLOCALPLACEMENT($,${place})`);
  const site = add(`IFCSITE('${ifcGuid()}',$,'Site',$,$,${sitePl},$,$,.ELEMENT.,$,$,$,${stepString(project.address || null)},$)`);
  const bldPl = add(`IFCLOCALPLACEMENT(${sitePl},${place})`);
  const building = add(`IFCBUILDING('${ifcGuid()}',$,${stepString(project.name)},$,$,${bldPl},$,$,.ELEMENT.,$,$,$)`);
  add(`IFCRELAGGREGATES('${ifcGuid()}',$,$,$,${proj},(${site}))`);
  add(`IFCRELAGGREGATES('${ifcGuid()}',$,$,$,${site},(${building}))`);
  const storeys = new Map();
  for (const lv of doc.levels()) {
    const p = add(`IFCCARTESIANPOINT((0.,0.,${num(lv.elevation)}))`);
    const ax = add(`IFCAXIS2PLACEMENT3D(${p},${zAxis},${xAxis})`);
    const pl = add(`IFCLOCALPLACEMENT(${bldPl},${ax})`);
    const st = add(`IFCBUILDINGSTOREY('${ifcGuid()}',$,${stepString(lv.name)},$,$,${pl},$,$,.ELEMENT.,${num(lv.elevation)})`);
    storeys.set(lv.id, { st, pl, z: lv.elevation, items: [], spaces: [] });
  }
  if (storeys.size) add(`IFCRELAGGREGATES('${ifcGuid()}',$,$,$,${building},(${[...storeys.values()].map((s) => s.st).join(',')}))`);
  const firstStorey = [...storeys.values()][0];
  // Element placement: the building origin; geometry in absolute coordinates.
  const elPlace = add(`IFCLOCALPLACEMENT(${bldPl},${place})`);
  const ctx = { size: (el) => {
    const t = doc.get(el.typeId) || {};
    return { width: +t.width || 900, height: +t.height || 2100 };
  } };
  for (const k of MODEL_KINDS)
    for (const el of k === 'link' ? [] : doc.all(k)) {
      const m = scene.mesh(el);
      if (!m || !m.pos.length) continue;
      const n = m.pos.length / 3;
      // Merge identical vertices to keep the file small.
      const index = new Map();
      const pts = [];
      const tris = [];
      for (let t = 0; t < n; t += 3) {
        const tri = [];
        for (let k2 = 0; k2 < 3; k2++) {
          const i = t + k2;
          const key = `${Math.round(m.pos[i * 3] * 10)},${Math.round(m.pos[i * 3 + 1] * 10)},${Math.round(m.pos[i * 3 + 2] * 10)}`;
          let v = index.get(key);
          if (v === undefined) {
            v = pts.length;
            index.set(key, v);
            pts.push(`(${num(m.pos[i * 3])},${num(m.pos[i * 3 + 1])},${num(m.pos[i * 3 + 2])})`);
          }
          tri.push(v + 1);
        }
        if (tri[0] !== tri[1] && tri[1] !== tri[2] && tri[0] !== tri[2]) tris.push(`(${tri.join(',')})`);
      }
      if (!tris.length) continue;
      const pl = add(`IFCCARTESIANPOINTLIST3D((${pts.join(',')}),$)`);
      const fs = add(`IFCTRIANGULATEDFACESET(${pl},$,.F.,(${tris.join(',')}),$)`);
      const sr = add(`IFCSHAPEREPRESENTATION(${body},'Body','Tessellation',(${fs}))`);
      const pds = add(`IFCPRODUCTDEFINITIONSHAPE($,$,(${sr}))`);
      const type = doc.get(el.typeId);
      const name = stepString(type ? typeLabel(type) : k);
      const tag = stepString(el.mark || el.id);
      let maker = ENTITY[k];
      if (k === 'component') maker = type?.category === 'plumbing' ? ENTITY.plumbing : type?.category === 'furniture' || type?.category === 'casework' ? ENTITY.furniture : ENTITY.proxy;
      const ent = add(maker(ifcGuid(), name, elPlace, pds, tag, el, ctx));
      const lv = levelOf(doc, el);
      (storeys.get(lv?.id) || firstStorey)?.items.push(ent);
    }
  // Rooms as spaces.
  for (const r of doc.all('room')) {
    const region = scene.rooms.room(r);
    const s = storeys.get(r.levelId);
    if (!region || !s) continue;
    const pts = region.outer.map((p) => add(`IFCCARTESIANPOINT((${num(p[0])},${num(p[1])}))`));
    const poly = add(`IFCPOLYLINE((${[...pts, pts[0]].join(',')}))`);
    const prof = add(`IFCARBITRARYCLOSEDPROFILEDEF(.AREA.,$,${poly})`);
    const p0 = add(`IFCCARTESIANPOINT((0.,0.,${num(s.z)}))`);
    const ax = add(`IFCAXIS2PLACEMENT3D(${p0},${zAxis},${xAxis})`);
    const solid = add(`IFCEXTRUDEDAREASOLID(${prof},${ax},${zAxis},${num(+r.upperOffset || 2700)})`);
    const sr = add(`IFCSHAPEREPRESENTATION(${body},'Body','SweptSolid',(${solid}))`);
    const pds = add(`IFCPRODUCTDEFINITIONSHAPE($,$,(${sr}))`);
    s.spaces.push(add(`IFCSPACE('${ifcGuid()}',$,${stepString(r.number || r.name)},$,$,${elPlace},${pds},${stepString(r.name)},.ELEMENT.,.INTERNAL.,$)`));
  }
  for (const s of storeys.values()) {
    if (s.items.length) add(`IFCRELCONTAINEDINSPATIALSTRUCTURE('${ifcGuid()}',$,$,$,(${s.items.join(',')}),${s.st})`);
    if (s.spaces.length) add(`IFCRELAGGREGATES('${ifcGuid()}',$,$,$,${s.st},(${s.spaces.join(',')}))`);
  }
  const now = new Date().toISOString().slice(0, 19);
  const header = [
    'ISO-10303-21;',
    'HEADER;',
    "FILE_DESCRIPTION(('ViewDefinition [ReferenceView]'),'2;1');",
    `FILE_NAME(${stepString(`${project.name}.ifc`)},'${now}',(${stepString(project.author || '')}),(''),'Building Design','Building Design','');`,
    "FILE_SCHEMA(('IFC4'));",
    'ENDSEC;',
    'DATA;',
  ];
  return [...header, ...lines, 'ENDSEC;', 'END-ISO-10303-21;', ''].join('\n');
}
