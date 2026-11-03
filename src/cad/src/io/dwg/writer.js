/**
 * DWG writer. The drawing is first written as DXF by the DXF writer (which
 * already resolves names, dimension blocks, hatch patterns and handles),
 * then those records are turned into DWG objects, completed with the objects
 * DWG requires and DXF may leave out (table control objects, layouts, the
 * multiline style, dictionaries), and serialized.
 *
 * Output: DWG 2004 (AC1018, the default: true colors and layer
 * transparency are kept) or DWG 2000 (AC1015).
 */
import { writeDxf } from '../dxf/writer.js';
import { BitWriter, crc16, crc32, R2000, R2004, R2007, R2010 } from './bits.js';
import { compress2004, checksum2004, headerMask } from './container.js';
import { SpecWriter } from './spec.js';
import { headerSpec, SENTINEL_HEADER, SENTINEL_HEADER_END } from './header.js';
import { SENTINEL_CLASSES } from './database.js';
import { TYPES, entityCommon, entityHandles, objectCommon, objectHandles, specFor } from './objects.js';
import { LW_TABLE } from './import.js';

const DEG = Math.PI / 180;
const SENTINEL_CLASSES_END = [0x72, 0x5e, 0x3b, 0x47, 0x3b, 0x56, 0x07, 0x3a, 0x3f, 0x23, 0x0b, 0xa0, 0x18, 0x30, 0x49, 0x75];
const SENTINEL_FILE_HEADER = [0x95, 0xa0, 0x4e, 0x28, 0x99, 0x82, 0x1a, 0xe5, 0x5e, 0x41, 0xe0, 0x5f, 0x9d, 0x3a, 0x4d, 0x00];
const SENTINEL_PREVIEW = [0x1f, 0x25, 0x6d, 0x07, 0xd4, 0x36, 0x28, 0x28, 0x9d, 0x57, 0xca, 0x3f, 0x9d, 0x44, 0x10, 0x2b];
const SENTINEL_PREVIEW_END = [0xe0, 0xda, 0x92, 0xf8, 0x2b, 0xc9, 0xd7, 0xd7, 0x62, 0xa8, 0x35, 0xc0, 0x62, 0xbb, 0xef, 0xd4];

/** Classes this writer can emit, by DXF name. */
const CLASS_DEFS = {
  ACDBDICTIONARYWDFLT: { cpp: 'AcDbDictionaryWithDefault', proxy: 0 },
  ACDBPLACEHOLDER: { cpp: 'AcDbPlaceHolder', proxy: 0 },
  LAYOUT: { cpp: 'AcDbLayout', proxy: 0 },
};

const ref = (code, value) => ({ code, value: value || 0 });
const soft = (h) => ref(4, h);
const hard = (h) => ref(5, h);
const owner = (h) => ref(3, h);

/* ------------------------------------------------------------------ */
/* DXF records                                                         */
/* ------------------------------------------------------------------ */

class Rec {
  constructor(type) {
    this.type = type;
    this.g = [];
  }
  first(code) {
    for (const [c, v] of this.g) if (c === code) return v;
    return undefined;
  }
  str(code, def = '') {
    const v = this.first(code);
    return v === undefined ? def : v;
  }
  num(code, def = 0) {
    const v = this.first(code);
    if (v === undefined) return def;
    const n = +v;
    return Number.isFinite(n) ? n : def;
  }
  int(code, def = 0) {
    return Math.trunc(this.num(code, def));
  }
  hnd(code) {
    const v = this.first(code);
    return v ? parseInt(v, 16) || 0 : 0;
  }
  pt(code) {
    return [this.num(code), this.num(code + 10), this.num(code + 20)];
  }
  pt2(code) {
    return [this.num(code), this.num(code + 10)];
  }
}

/** Split the DXF text of the DXF writer into records by section. */
function dxfSections(text) {
  const lines = text.split(/\r?\n/);
  const out = {};
  let sec = null;
  let cur = null;
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = parseInt(lines[i], 10);
    const val = lines[i + 1];
    if (code === 0) {
      cur = new Rec(val);
      if (val === 'SECTION') sec = null;
      else if (val === 'ENDSEC') {
        sec = null;
        cur = null;
      } else if (sec) out[sec].push(cur);
      continue;
    }
    if (!cur) continue;
    if (cur.type === 'SECTION' && code === 2 && !sec) {
      sec = val;
      out[sec] = [];
      if (val === 'HEADER') out[sec].push(cur);
      continue;
    }
    cur.g.push([code, val]);
  }
  return out;
}

/** Decode the \U+XXXX escapes the DXF writer uses for non-ASCII text. */
function unescape(s) {
  if (s.indexOf('\\U+') < 0) return s;
  return s.replace(/\\U\+([0-9A-Fa-f]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

function lwIndex(lw) {
  if (lw === -1) return 29;
  if (lw === -2) return 30;
  if (lw === -3) return 31;
  let best = 0;
  for (let i = 0; i < LW_TABLE.length; i++) if (Math.abs(LW_TABLE[i] - lw) < Math.abs(LW_TABLE[best] - lw)) best = i;
  return best;
}

/** Julian day and milliseconds of a date. */
function julian(date) {
  const ms = date.getTime();
  const day = Math.floor(ms / 86400000) + 2440588;
  return [day, ms - Math.floor(ms / 86400000) * 86400000];
}

/* ------------------------------------------------------------------ */
/* Database                                                            */
/* ------------------------------------------------------------------ */

class Builder {
  constructor(ver, warnings) {
    this.ver = ver;
    this.warnings = warnings;
    this.objs = new Map();
    this.maxHandle = 0;
    this.names = { LAYER: new Map(), LTYPE: new Map(), STYLE: new Map(), DIMSTYLE: new Map(), BLOCK: new Map(), APPID: new Map() };
    this.hv = {};
    this.classes = [];
    this.classNum = new Map();
  }

  warn(msg) {
    if (!this.warnings.includes(msg)) this.warnings.push(msg);
  }

  newHandle() {
    return ++this.maxHandle;
  }

  add(handle, type, v, entity = false) {
    if (!handle) handle = this.newHandle();
    if (handle > this.maxHandle) this.maxHandle = handle;
    const o = { handle, type, entity, v: { numReactors: 0, reactors: [], ...v } };
    if (o.v.reactors.length) o.v.numReactors = o.v.reactors.length;
    if (!entity) {
      o.v.xdicMissing = this.ver >= R2004 ? 1 : 0;
      o.v.xdic = owner(0);
    }
    this.objs.set(handle, o);
    return o;
  }

  typeNum(type) {
    if (TYPES[type] !== undefined) return TYPES[type];
    let n = this.classNum.get(type);
    if (n === undefined) {
      n = 500 + this.classes.length;
      const d = CLASS_DEFS[type];
      this.classes.push({ num: n, dxf: type, cpp: d.cpp, proxy: d.proxy, entity: false });
      this.classNum.set(type, n);
    }
    return n;
  }

  named(table, name) {
    return this.names[table].get(String(name).toLowerCase()) || 0;
  }

  /* ---------------- reading the DXF records ---------------- */

  load(sec) {
    const recsH = (sec.HEADER || [])[0];
    for (const r of sec.TABLES || []) if (r.type !== 'TABLE' && r.type !== 'ENDTAB') this.seen(r);
    for (const r of sec.BLOCKS || []) this.seen(r);
    for (const r of sec.ENTITIES || []) this.seen(r);
    for (const r of sec.OBJECTS || []) this.seen(r);
    this.tables(sec.TABLES || []);
    this.objectsSection(sec.OBJECTS || []);
    this.blocks(sec.BLOCKS || []);
    this.entitiesSection(sec.ENTITIES || []);
    this.finish(recsH);
  }

  /** Track the highest handle used by the DXF writer. */
  seen(r) {
    const h = r.hnd(5) || r.hnd(105);
    if (h > this.maxHandle) this.maxHandle = h;
  }

  tables(recs) {
    let table = '';
    let control = 0;
    this.controls = {};
    for (const r of recs) {
      if (r.type === 'TABLE') {
        table = r.str(2);
        control = r.hnd(5);
        if (table !== 'BLOCK_RECORD' || true) this.controls[table] = { handle: control, entries: [] };
        if (r.hnd(5) > this.maxHandle) this.maxHandle = r.hnd(5);
        continue;
      }
      if (r.type === 'ENDTAB') continue;
      const h = r.hnd(5) || r.hnd(105);
      const name = unescape(r.str(2));
      const c = this.controls[table];
      switch (r.type) {
        case 'VPORT':
          c.entries.push(h);
          this.add(h, 'VPORT', this.vport(r, name, c.handle));
          break;
        case 'LTYPE': {
          const key = name.toLowerCase();
          this.names.LTYPE.set(key, h);
          if (key !== 'bylayer' && key !== 'byblock') c.entries.push(h);
          const n = r.int(73);
          const dashes = [];
          for (const [code, val] of r.g) if (code === 49) dashes.push({ length: +val, shape: 0, dx: 0, dy: 0, scale: 1, rotation: 0, shapeFlag: 0, shapeFile: hard(0) });
          void n;
          this.add(h, 'LTYPE', {
            owner: soft(c.handle),
            name,
            flag64: 1,
            description: unescape(r.str(3)),
            patternLength: r.num(40),
            alignment: 65,
            numDashes: dashes.length,
            dashes,
            strings: new Uint8Array(256),
            xref: hard(0),
          });
          break;
        }
        case 'LAYER': {
          this.names.LAYER.set(name.toLowerCase(), h);
          c.entries.push(h);
          this.pendingLayers = this.pendingLayers || [];
          this.pendingLayers.push({ r, h, name, control: c.handle });
          break;
        }
        case 'STYLE':
          this.names.STYLE.set(name.toLowerCase(), h);
          c.entries.push(h);
          this.add(h, 'STYLE', {
            owner: soft(c.handle),
            name,
            flag64: 1,
            vertical: (r.int(70) & 4) !== 0,
            shapeFile: (r.int(70) & 1) !== 0,
            fixedHeight: r.num(40),
            widthFactor: r.num(41, 1),
            oblique: r.num(50) * DEG,
            generation: r.int(71),
            lastHeight: r.num(42, 2.5),
            font: r.str(3, 'txt'),
            bigFont: r.str(4),
            xref: hard(0),
          });
          break;
        case 'APPID':
          this.names.APPID.set(name.toLowerCase(), h);
          c.entries.push(h);
          this.add(h, 'APPID', { owner: soft(c.handle), name, flag64: 1, unknown: 0, xref: hard(0) });
          break;
        case 'DIMSTYLE':
          this.names.DIMSTYLE.set(name.toLowerCase(), h);
          c.entries.push(h);
          this.pendingDims = this.pendingDims || [];
          this.pendingDims.push({ r, h, name, control: c.handle });
          break;
        case 'BLOCK_RECORD':
          this.names.BLOCK.set(name.toLowerCase(), h);
          this.blockRecords = this.blockRecords || [];
          this.blockRecords.push({ h, name, control: c.handle });
          break;
      }
    }
  }

  vport(r, name, control) {
    const height = r.num(40, 100);
    return {
      owner: soft(control),
      name,
      flag64: 1,
      height,
      aspect: r.num(41, 1) * height,
      center: r.pt2(12),
      target: r.pt(17),
      dir: [r.num(16), r.num(26), r.num(36, 1)],
      twist: r.num(51) * DEG,
      lens: r.num(42, 50),
      front: r.num(43),
      back: r.num(44),
      renderMode: r.int(281),
      lowerLeft: r.pt2(10),
      upperRight: [r.num(11, 1), r.num(21, 1)],
      circleZoom: r.int(72, 100),
      fastZoom: r.int(73, 1),
      ucsIcon: r.int(74, 3),
      gridOn: r.int(76),
      gridSpacing: [r.num(15, 10), r.num(25, 10)],
      snapOn: r.int(75),
      snapStyle: r.int(77),
      snapIsopair: r.int(78),
      snapRot: r.num(50) * DEG,
      snapBase: r.pt2(13),
      snapSpacing: [r.num(14, 10), r.num(24, 10)],
      ucsPerViewport: r.int(65, 1),
      ucsOrigin: r.pt(110),
      ucsX: [r.num(111, 1), r.num(121), r.num(131)],
      ucsY: [r.num(112), r.num(122, 1), r.num(132)],
      ucsElevation: r.num(146),
      ucsOrtho: r.int(79),
      xref: hard(0),
      namedUcs: hard(0),
      baseUcs: hard(0),
    };
  }

  layerObjects() {
    for (const { r, h, name, control } of this.pendingLayers || []) {
      const flags = r.int(70);
      const ci = r.int(62, 7);
      const lw = r.int(370, -3);
      const plot = r.first(290) === undefined ? 1 : r.int(290);
      const values = (flags & 1 ? 1 : 0) | (ci < 0 ? 2 : 0) | (flags & 4 ? 8 : 0) | (plot ? 16 : 0) | (lwIndex(lw) << 5);
      const rgb = r.first(420) !== undefined && this.ver >= R2004 ? r.int(420) & 0xffffff : null;
      this.add(h, 'LAYER', {
        owner: soft(control),
        name,
        flag64: 1,
        values,
        color: { index: Math.abs(ci) || 7, rgb },
        xref: hard(0),
        plotstyle: hard(r.hnd(390)),
        material: hard(0),
        ltype: hard(this.named('LTYPE', r.str(6, 'Continuous')) || this.named('LTYPE', 'Continuous')),
        unknownHandle: hard(0),
        __eed: this.eedFrom(r),
      });
    }
  }

  dimstyleObjects() {
    for (const { r, h, name, control } of this.pendingDims || []) {
      const post = unescape(r.str(3));
      const v = {
        owner: soft(control),
        name,
        flag64: 1,
        DIMPOST: post,
        DIMSCALE: r.num(40, 1),
        DIMASZ: r.num(41, 2.5),
        DIMEXO: r.num(42, 0.625),
        DIMEXE: r.num(44, 1.25),
        DIMTIH: r.int(73),
        DIMTOH: r.int(74),
        DIMTAD: r.int(77, 1),
        DIMZIN: r.int(78, 8),
        DIMTXT: r.num(140, 2.5),
        DIMCEN: r.num(141, 2.5),
        DIMTSZ: r.num(142),
        DIMGAP: r.num(147, 0.625),
        DIMSAH: r.int(173),
        DIMCLRD: { index: r.int(176), rgb: null },
        DIMCLRE: { index: r.int(177), rgb: null },
        DIMCLRT: { index: r.int(178), rgb: null },
        DIMDEC: r.int(271, 2),
        DIMTDEC: r.int(271, 2),
        xref: hard(0),
        DIMTXSTY: hard(r.hnd(340)),
        DIMLDRBLK: hard(0),
        DIMBLKH: hard(r.hnd(342)),
        DIMBLK1H: hard(0),
        DIMBLK2H: hard(0),
        DIMLTYPE: hard(0),
        DIMLTEX1: hard(0),
        DIMLTEX2: hard(0),
      };
      this.add(h, 'DIMSTYLE', v);
    }
  }

  /** Extended data groups (1001 ...) of a record as EED blocks. */
  eedFrom(r) {
    const out = [];
    let cur = null;
    for (const [code, val] of r.g) {
      if (code === 1001) {
        const app = this.named('APPID', val);
        cur = app ? { app, items: [] } : null;
        if (cur) out.push(cur);
      } else if (cur && code >= 1000) cur.items.push([code, val]);
    }
    return out;
  }

  objectsSection(recs) {
    this.dicts = [];
    for (const r of recs) {
      const h = r.hnd(5);
      const reactors = [];
      let ownerH = 0;
      let inReact = false;
      for (const [code, val] of r.g) {
        if (code === 102) inReact = val.startsWith('{ACAD_REACTORS');
        else if (code === 330) {
          if (inReact) reactors.push(soft(parseInt(val, 16)));
          else ownerH = parseInt(val, 16);
        }
      }
      if (r.type === 'DICTIONARY' || r.type === 'ACDBDICTIONARYWDFLT') {
        const names = [];
        const items = [];
        for (const [code, val] of r.g) {
          if (code === 3) names.push(unescape(val));
          else if (code === 350 || code === 360) items.push(soft(parseInt(val, 16)));
        }
        const v = { owner: soft(ownerH), reactors, numItems: names.length, cloning: r.int(281, 1), hardOwner: 0, names, items };
        if (r.type === 'ACDBDICTIONARYWDFLT') {
          v.defaultEntry = hard(r.hnd(340));
          this.typeNum('ACDBDICTIONARYWDFLT');
        }
        this.add(h, r.type, v);
        this.dicts.push(h);
      } else if (r.type === 'ACDBPLACEHOLDER') {
        this.typeNum('ACDBPLACEHOLDER');
        this.add(h, 'ACDBPLACEHOLDER', { owner: soft(ownerH), reactors });
      }
    }
  }

  blocks(recs) {
    this.blockDefs = [];
    let cur = null;
    for (const r of recs) {
      if (r.type === 'BLOCK') {
        cur = { begin: r, br: r.hnd(330), entities: [], end: null };
        this.blockDefs.push(cur);
      } else if (r.type === 'ENDBLK') {
        if (cur) cur.end = r;
        cur = null;
      } else if (cur) cur.entities.push(r);
    }
  }

  entitiesSection(recs) {
    this.modelEntities = recs;
  }

  /* ---------------- entities ---------------- */

  common(r, br, model) {
    const v = {};
    v.entmode = model ? 2 : 0;
    if (!model) v.owner = soft(br);
    v.xdicMissing = this.ver >= R2004 ? 1 : 0;
    v.xdic = owner(0);
    v.isByLayerLt = 1;
    v.noLinks = 0;
    const ci = r.first(62) === undefined ? 256 : r.int(62);
    const tc = r.first(420);
    v.color = { index: ci, rgb: tc !== undefined && this.ver >= R2004 ? r.int(420) & 0xffffff : null, alpha: null, book: false };
    v.ltscale = r.num(48, 1);
    const lt = r.str(6, 'ByLayer').toLowerCase();
    if (lt === 'bylayer') v.ltFlags = 0;
    else if (lt === 'byblock') v.ltFlags = 1;
    else if (lt === 'continuous') v.ltFlags = 2;
    else {
      v.ltFlags = 3;
      v.ltype = hard(this.named('LTYPE', lt));
    }
    v.psFlags = 0;
    v.matFlags = 0;
    v.shadowFlags = 0;
    v.invisible = r.int(60) & 1;
    v.lwIndex = lwIndex(r.first(370) === undefined ? -1 : r.int(370));
    v.layer = hard(this.named('LAYER', unescape(r.str(8, '0'))) || this.named('LAYER', '0'));
    return v;
  }

  /** Convert one entity record; returns the created object or null. */
  entity(r, br, model) {
    const fn = ENTITY_IN[r.type];
    if (!fn) {
      this.warn(`${r.type} entities are not written to DWG.`);
      return null;
    }
    const base = this.common(r, br, model);
    const res = fn.call(this, r, base);
    if (!res) return null;
    const [type, v] = res;
    const o = this.add(r.hnd(5), type, { ...base, ...v }, true);
    o.v.__eed = this.eedFrom(r);
    return o;
  }

  /** Link a block's entities (R2000 next/previous pointers). */
  link(list) {
    for (let i = 0; i < list.length; i++) {
      list[i].v.prev = soft(i > 0 ? list[i - 1].handle : 0);
      list[i].v.next = soft(i + 1 < list.length ? list[i + 1].handle : 0);
    }
  }

  /* ---------------- completing the database ---------------- */

  finish(hdr) {
    const ver = this.ver;
    this.layerObjects();
    this.dimstyleObjects();
    const C = this.controls;
    const hv = this.hv;

    // block records, their BLOCK/ENDBLK entities and contents
    const brByHandle = new Map((this.blockRecords || []).map((b) => [b.h, b]));
    const defs = new Map(this.blockDefs.map((d) => [d.br, d]));
    const msH = this.named('BLOCK', '*Model_Space');
    const psH = this.named('BLOCK', '*Paper_Space');
    const blockControl = C.BLOCK_RECORD.handle;
    const entries = [];
    for (const br of this.blockRecords || []) {
      const def = defs.get(br.h);
      const model = br.h === msH;
      const paper = br.h === psH;
      const list = [];
      const src = model ? this.modelEntities : def ? def.entities : [];
      for (const r of src) {
        const o = this.entity(r, br.h, model);
        if (o) {
          if (paper) o.v.entmode = 1;
          list.push(o);
        }
      }
      if (ver <= R2000) this.link(list);
      const begin = def?.begin;
      const flags = begin ? begin.int(70) : 0;
      const bh = begin ? begin.hnd(5) : this.newHandle();
      const eh = def?.end ? def.end.hnd(5) : this.newHandle();
      const layer0 = hard(this.named('LAYER', '0'));
      const entCommon = (h) => ({ entmode: 0, owner: soft(br.h), xdicMissing: ver >= R2004 ? 1 : 0, xdic: owner(0), isByLayerLt: 1, noLinks: 1, color: { index: 256, rgb: null }, ltscale: 1, ltFlags: 0, psFlags: 0, invisible: 0, lwIndex: 29, layer: layer0, handle: h });
      this.add(bh, 'BLOCK', { ...entCommon(bh), name: br.name }, true);
      this.add(eh, 'ENDBLK', entCommon(eh), true);
      const bv = {
        owner: soft(blockControl),
        name: br.name,
        flag64: 1,
        anonymous: flags & 1,
        hasAttribs: 0,
        isXref: 0,
        isOverlay: 0,
        loaded: 0,
        base: begin ? begin.pt(10) : [0, 0, 0],
        xrefPath: '',
        insertCount: 0,
        description: '',
        previewSize: 0,
        xref: hard(0),
        blockEntity: owner(bh),
        firstEntity: soft(list.length ? list[0].handle : 0),
        lastEntity: soft(list.length ? list[list.length - 1].handle : 0),
        numOwned: list.length,
        owned: list.map((o) => owner(o.handle)),
        endblk: owner(eh),
        inserts: [],
        layout: hard(0),
      };
      this.add(br.h, 'BLOCK_HEADER', bv);
      if (!model && !paper) entries.push(br.h);
      void brByHandle;
    }

    // control objects
    const control = (table, type, extra = {}) => {
      const c = C[table] || { handle: this.newHandle(), entries: [] };
      this.add(c.handle, type, { owner: soft(0), numEntries: c.entries.length, entries: c.entries.map(soft), ...extra });
      return c.handle;
    };
    hv.BLOCK_CONTROL = hard(control('BLOCK_RECORD', 'BLOCK_CONTROL', { numEntries: entries.length, entries: entries.map(soft), modelSpace: owner(msH), paperSpace: owner(psH) }));
    hv.LAYER_CONTROL = hard(control('LAYER', 'LAYER_CONTROL'));
    hv.STYLE_CONTROL = hard(control('STYLE', 'STYLE_CONTROL'));
    const byLayer = this.named('LTYPE', 'ByLayer');
    const byBlock = this.named('LTYPE', 'ByBlock');
    hv.LTYPE_CONTROL = hard(control('LTYPE', 'LTYPE_CONTROL', { byBlock: owner(byBlock), byLayer: owner(byLayer) }));
    hv.VIEW_CONTROL = hard(control('VIEW', 'VIEW_CONTROL'));
    hv.UCS_CONTROL = hard(control('UCS', 'UCS_CONTROL'));
    hv.VPORT_CONTROL = hard(control('VPORT', 'VPORT_CONTROL'));
    hv.APPID_CONTROL = hard(control('APPID', 'APPID_CONTROL'));
    hv.DIMSTYLE_CONTROL = hard(control('DIMSTYLE', 'DIMSTYLE_CONTROL', { numExtra: 0, extra: [] }));
    if (ver <= R2000) hv.VX_CONTROL = hard(control('VX', 'VX_CONTROL'));

    // dictionaries: complete the named object dictionary
    const root = this.objs.get(this.dicts[0]);
    const dictItem = (d, name) => {
      const i = d.v.names.indexOf(name);
      return i >= 0 ? d.v.items[i].value : 0;
    };
    const addDict = (name, items = {}) => {
      const h = this.newHandle();
      const names = Object.keys(items);
      this.add(h, 'DICTIONARY', { owner: soft(root.handle), reactors: [soft(root.handle)], numItems: names.length, cloning: 1, hardOwner: 0, names, items: names.map((n) => soft(items[n])) });
      root.v.names.push(name);
      root.v.items.push(soft(h));
      return h;
    };
    const mlsH = this.newHandle();
    const mlDict = addDict('ACAD_MLINESTYLE', { Standard: mlsH });
    this.add(mlsH, 'MLINESTYLE', {
      owner: soft(mlDict),
      reactors: [soft(mlDict)],
      name: 'Standard',
      description: '',
      flags: 0,
      fillColor: { index: 256, rgb: null },
      startAngle: Math.PI / 2,
      endAngle: Math.PI / 2,
      numLines: 2,
      lines: [
        { offset: 0.5, color: { index: 256, rgb: null }, ltIndex: -1, ltype: hard(byLayer) },
        { offset: -0.5, color: { index: 256, rgb: null }, ltIndex: -1, ltype: hard(byLayer) },
      ],
    });
    const modelLayout = this.newHandle();
    const paperLayout = this.newHandle();
    const layoutDict = addDict('ACAD_LAYOUT', { Layout1: paperLayout, Model: modelLayout });
    const psDict = addDict('ACAD_PLOTSETTINGS');
    const ext = this.extents;
    const layout = (h, name, br, tab, flags) => {
      this.typeNum('LAYOUT');
      this.add(h, 'LAYOUT', {
        owner: soft(layoutDict),
        reactors: [soft(layoutDict)],
        layoutName: name,
        tabOrder: tab,
        layoutFlags: flags,
        plotFlags: name === 'Model' ? 1712 : 688,
        extMin: ext ? [ext[0], ext[1], 0] : [1e20, 1e20, 1e20],
        extMax: ext ? [ext[2], ext[3], 0] : [-1e20, -1e20, -1e20],
        plotView: hard(0),
        visualStyle: soft(0),
        blockRecord: soft(br),
        lastViewport: soft(0),
        baseUcs: hard(0),
        namedUcs: hard(0),
        numViewports: 0,
        viewports: [],
      });
      const bhObj = this.objs.get(br);
      if (bhObj) bhObj.v.layout = hard(h);
    };
    layout(modelLayout, 'Model', msH, 0, 1);
    layout(paperLayout, 'Layout1', psH, 1, 1);
    // keep the root dictionary sorted, as AutoCAD writes it
    const pairs = root.v.names.map((n, i) => [n, root.v.items[i]]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    root.v.names = pairs.map((p) => p[0]);
    root.v.items = pairs.map((p) => p[1]);
    root.v.numItems = pairs.length;
    root.v.owner = soft(0);

    hv.DICT_NAMED = hard(root.handle);
    hv.DICT_GROUP = hard(dictItem(root, 'ACAD_GROUP'));
    hv.DICT_MLINESTYLE = hard(mlDict);
    hv.DICT_LAYOUT = hard(layoutDict);
    hv.DICT_PLOTSETTINGS = hard(psDict);
    hv.DICT_PLOTSTYLE = hard(dictItem(root, 'ACAD_PLOTSTYLENAME'));
    hv.DICT_MATERIAL = hard(0);
    hv.DICT_COLOR = hard(0);
    hv.DICT_VISUALSTYLE = hard(0);
    hv.DICT_UNKNOWN = hard(0);
    hv.CMLSTYLE = hard(mlsH);
    hv.BLOCK_MODEL_SPACE = hard(msH);
    hv.BLOCK_PAPER_SPACE = hard(psH);
    hv.LTYPE_BYLAYER = hard(byLayer);
    hv.LTYPE_BYBLOCK = hard(byBlock);
    hv.LTYPE_CONTINUOUS = hard(this.named('LTYPE', 'Continuous'));

    // header variables from the DXF header
    const vars = {};
    if (hdr) {
      let name = '';
      for (const [code, val] of hdr.g) {
        if (code === 9) name = val;
        else if (name) {
          (vars[name] ||= []).push([code, val]);
        }
      }
    }
    const one = (n, def) => (vars[n] ? vars[n][0][1] : def);
    const pt = (n) => (vars[n] ? vars[n].map((x) => +x[1]) : null);
    const units = { 0: 0, 1: 1, 2: 2, 4: 4, 5: 5, 6: 6 };
    hv.INSUNITS = units[+one('$INSUNITS', 0)] ?? 0;
    this.metric = +one('$MEASUREMENT', 1) === 1;
    hv.LTSCALE = +one('$LTSCALE', 1);
    hv.TEXTSIZE = +one('$TEXTSIZE', 2.5);
    hv.LUNITS = +one('$LUNITS', 2);
    hv.LUPREC = +one('$LUPREC', 4);
    hv.AUNITS = +one('$AUNITS', 0);
    hv.AUPREC = +one('$AUPREC', 0);
    hv.PDMODE = +one('$PDMODE', 0);
    hv.PDSIZE = +one('$PDSIZE', 0);
    hv.CECOLOR = { index: +one('$CECOLOR', 256), rgb: null };
    hv.CLAYER = hard(this.named('LAYER', unescape(one('$CLAYER', '0'))) || this.named('LAYER', '0'));
    hv.CELTYPE = hard(this.named('LTYPE', one('$CELTYPE', 'ByLayer')) || byLayer);
    hv.TEXTSTYLE = hard(this.named('STYLE', unescape(one('$TEXTSTYLE', 'Standard'))) || this.named('STYLE', 'Standard'));
    hv.DIMSTYLE = hard(this.named('DIMSTYLE', unescape(one('$DIMSTYLE', 'Standard'))) || this.named('DIMSTYLE', 'Standard'));
    const celw = +one('$CELWEIGHT', -1);
    hv.FLAGS = (lwIndex(celw) & 0x1f) | 0x200 | 0x800;
    const emin = pt('$EXTMIN');
    const emax = pt('$EXTMAX');
    if (emin && emax) {
      hv.EXTMIN = emin;
      hv.EXTMAX = emax;
    }
    if (!this.metric) {
      hv.LIMMAX = [12, 9];
      hv.PLIMMAX = [12, 9];
      Object.assign(hv, IMPERIAL_DIMS);
    }
    const now = julian(new Date());
    hv.TDCREATE = now;
    hv.TDUPDATE = now;
    const ds = this.objs.get(hv.DIMSTYLE.value);
    if (ds) for (const k of Object.keys(ds.v)) if (k.startsWith('DIM') && k.length > 3 && !k.endsWith('H') && typeof ds.v[k] !== 'object') hv[k] = ds.v[k];
    hv.PUCSNAME = hard(0);
    hv.UCSNAME = hard(0);
    for (const k of ['PUCSORTHOREF', 'PUCSBASE', 'UCSORTHOREF', 'UCSBASE', 'DIMTXSTY', 'DIMLDRBLK', 'DIMBLK', 'DIMBLK1', 'DIMBLK2', 'DIMLTYPE', 'DIMLTEX1', 'DIMLTEX2', 'CMATERIAL', 'INTERFEREOBJVS', 'INTERFEREVPVS', 'DRAGVS', 'VPORT_ENTITY_HEADER']) hv[k] ??= hard(0);
    hv.DIMTXSTY = hard(this.named('STYLE', 'Standard'));
    hv.HANDSEED = this.maxHandle + 1;
    void R2007;
    void R2010;
  }
}

/** Imperial defaults for dimension variables of a drawing in inches. */
const IMPERIAL_DIMS = { DIMASZ: 0.18, DIMEXO: 0.0625, DIMDLI: 0.38, DIMEXE: 0.18, DIMTXT: 0.18, DIMCEN: 0.09, DIMGAP: 0.09, DIMALTF: 25.4, DIMTAD: 0, DIMZIN: 0, DIMTIH: 1, DIMTOH: 1, DIMTOFL: 0, DIMDEC: 4, DIMTDEC: 4, DIMDSEP: 46 };

/* ------------------------------------------------------------------ */
/* Entities                                                            */
/* ------------------------------------------------------------------ */

const DIM_TYPES = { 0: 'DIMENSION_LINEAR', 1: 'DIMENSION_ALIGNED', 2: 'DIMENSION_ANG2LN', 3: 'DIMENSION_DIAMETER', 4: 'DIMENSION_RADIUS', 5: 'DIMENSION_ANG3PT', 6: 'DIMENSION_ORDINATE' };

const ENTITY_IN = {
  LINE(r) {
    const a = r.pt(10);
    const b = r.pt(11);
    return ['LINE', { zzero: a[2] === 0 && b[2] === 0 ? 1 : 0, x1: a[0], y1: a[1], z1: a[2], x2: b[0], y2: b[1], z2: b[2], p1: a, p2: b, thickness: r.num(39), extrusion: [r.num(210), r.num(220), r.num(230, 1)] }];
  },
  XLINE(r) {
    return ['XLINE', { pt: r.pt(10), dir: r.pt(11) }];
  },
  RAY(r) {
    return ['RAY', { pt: r.pt(10), dir: r.pt(11) }];
  },
  CIRCLE(r) {
    return ['CIRCLE', { center: r.pt(10), radius: r.num(40), thickness: 0, extrusion: [0, 0, 1] }];
  },
  ARC(r) {
    return ['ARC', { center: r.pt(10), radius: r.num(40), thickness: 0, extrusion: [0, 0, 1], start: r.num(50) * DEG, end: r.num(51) * DEG }];
  },
  ELLIPSE(r) {
    return ['ELLIPSE', { center: r.pt(10), major: r.pt(11), extrusion: [r.num(210), r.num(220), r.num(230, 1)], ratio: r.num(40, 1), start: r.num(41), end: r.num(42, Math.PI * 2) }];
  },
  POINT(r) {
    return ['POINT', { pt: r.pt(10), thickness: 0, extrusion: [0, 0, 1], xAngle: 0 }];
  },
  LWPOLYLINE(r) {
    const pts = [];
    const bulges = [];
    for (const [code, val] of r.g) {
      if (code === 10) {
        pts.push([+val, 0]);
        bulges.push(0);
      } else if (code === 20 && pts.length) pts[pts.length - 1][1] = +val;
      else if (code === 42 && pts.length) bulges[bulges.length - 1] = +val;
    }
    const cw = r.num(43);
    const hasB = bulges.some((b) => b !== 0);
    let flags = (r.int(70) & 1 ? 512 : 0) | (r.int(70) & 128 ? 256 : 0);
    if (cw) flags |= 4;
    if (hasB) flags |= 16;
    return ['LWPOLYLINE', { flags, constWidth: cw, numPts: pts.length, numBulges: hasB ? bulges.length : 0, pts, bulges: hasB ? bulges : [], ids: [], widths: [] }];
  },
  SPLINE(r) {
    const knots = [];
    const ctrl = [];
    for (const [code, val] of r.g) {
      if (code === 40) knots.push(+val);
      else if (code === 10) ctrl.push({ pt: [+val, 0, 0] });
      else if (code === 20 && ctrl.length) ctrl[ctrl.length - 1].pt[1] = +val;
      else if (code === 30 && ctrl.length) ctrl[ctrl.length - 1].pt[2] = +val;
    }
    const f = r.int(70);
    return [
      'SPLINE',
      {
        scenario: 1,
        splineFlags: 0,
        knotParam: 0,
        degree: r.int(71, 3),
        rational: 0,
        closed: f & 1 ? 1 : 0,
        periodic: 0,
        knotTol: r.num(42, 1e-10),
        ctrlTol: r.num(43, 1e-10),
        numKnots: knots.length,
        numCtrl: ctrl.length,
        weighted: 0,
        knots,
        ctrl,
      },
    ];
  },
  TEXT(r) {
    const ins = r.pt2(10);
    const has11 = r.first(11) !== undefined;
    let valign = 0;
    let seen = 0;
    for (const [code, val] of r.g) {
      if (code === 100) seen++;
      else if (code === 73 && seen >= 2) valign = +val;
    }
    return [
      'TEXT',
      {
        dataFlags: 0,
        elevation: r.num(30),
        ins,
        align: has11 ? r.pt2(11) : ins,
        extrusion: [0, 0, 1],
        thickness: 0,
        oblique: r.num(51) * DEG,
        rotation: r.num(50) * DEG,
        height: r.num(40, 2.5),
        widthFactor: r.num(41, 1),
        value: textValue(r.str(1)),
        generation: 0,
        halign: r.int(72),
        valign,
        style: hard(this.named('STYLE', unescape(r.str(7, 'Standard'))) || this.named('STYLE', 'Standard')),
      },
    ];
  },
  MTEXT(r) {
    let text = '';
    for (const [code, val] of r.g) if (code === 3) text += val;
    text += r.str(1);
    return [
      'MTEXT',
      {
        ins: r.pt(10),
        extrusion: [0, 0, 1],
        xdir: r.first(11) !== undefined ? r.pt(11) : [1, 0, 0],
        rectWidth: r.num(41),
        rectHeight: 0,
        height: r.num(40, 2.5),
        attach: r.int(71, 1),
        drawDir: r.int(72, 1),
        extHeight: 0,
        extWidth: 0,
        text: textValue(text),
        lsStyle: r.int(73, 1),
        lsFactor: r.num(44, 1),
        unknownBit: 0,
        bgFlags: 0,
        style: hard(this.named('STYLE', unescape(r.str(7, 'Standard'))) || this.named('STYLE', 'Standard')),
      },
    ];
  },
  LEADER(r) {
    const pts = [];
    for (const [code, val] of r.g) {
      if (code === 10) pts.push([+val, 0, 0]);
      else if (code === 20 && pts.length) pts[pts.length - 1][1] = +val;
      else if (code === 30 && pts.length) pts[pts.length - 1][2] = +val;
    }
    const xd = r.first(211) !== undefined ? [r.num(211), r.num(221), r.num(231)] : [1, 0, 0];
    return [
      'LEADER',
      {
        unknownBit: 0,
        annotType: r.int(73, 3),
        pathType: r.int(72),
        numPts: pts.length,
        pts,
        origin: pts[0] || [0, 0, 0],
        extrusion: [0, 0, 1],
        xdir: xd,
        blockOffset: [0, 0, 0],
        endProj: [0, 0, 0],
        boxHeight: r.num(40),
        boxWidth: r.num(41),
        hookOnX: xd[0] >= 0 ? 1 : 0,
        arrowOn: r.int(71, 1),
        u6: 0,
        u7: 0,
        u8: 0,
        annotation: hard(r.hnd(340)),
        dimstyle: hard(this.named('DIMSTYLE', unescape(r.str(3, 'Standard'))) || this.named('DIMSTYLE', 'Standard')),
      },
    ];
  },
  HATCH(r) {
    return ['HATCH', hatchValues.call(this, r)];
  },
  INSERT(r) {
    const name = unescape(r.str(2));
    const block = this.named('BLOCK', name);
    if (!block) return null;
    return [
      'INSERT',
      {
        ins: r.pt(10),
        scaleFlags: 0,
        sx: r.num(41, 1),
        sy: r.num(42, 1),
        sz: r.num(43, 1),
        rotation: r.num(50) * DEG,
        extrusion: [0, 0, 1],
        hasAttribs: 0,
        block: hard(block),
      },
    ];
  },
  DIMENSION(r) {
    const flags = r.int(70);
    const type = DIM_TYPES[flags & 7];
    if (!type) return null;
    const tm = r.pt(11);
    return [
      type,
      {
        extrusion: [0, 0, 1],
        textMid: [tm[0], tm[1]],
        elevation: tm[2],
        flags1: 11,
        userText: textValue(r.str(1)),
        textRotation: r.num(53) * DEG,
        horizDir: r.num(51) * DEG,
        insScale: [1, 1, 1],
        insRotation: 0,
        attach: 5,
        lsStyle: 1,
        lsFactor: 1,
        measurement: 0,
        p12: [0, 0],
        p10: r.pt(10),
        p13: r.pt(13),
        p14: r.pt(14),
        p15: r.pt(15),
        p16: r.pt2(16),
        flags2: flags & 64 ? 1 : 0,
        extRotation: r.num(52) * DEG,
        dimRotation: r.num(50) * DEG,
        leaderLength: r.num(40),
        dimstyle: hard(this.named('DIMSTYLE', unescape(r.str(3, 'Standard'))) || this.named('DIMSTYLE', 'Standard')),
        block: hard(this.named('BLOCK', unescape(r.str(2)))),
      },
    ];
  },
};

/**
 * Text as DWG stores it: DXF caret codes (^ followed by a space for a caret,
 * ^I for a tab, ^J for a line feed) and \U+ escapes decoded. %% codes stay.
 */
function textValue(s) {
  s = unescape(s);
  if (s.indexOf('^') < 0) return s;
  return s.replace(/\^([\s\S])/g, (m, c) => {
    if (c === ' ') return '^';
    const k = c.charCodeAt(0);
    return k >= 64 && k <= 95 ? String.fromCharCode(k - 64) : m;
  });
}

function hatchValues(r) {
  const g = r.g;
  let i = 0;
  const v = { gradient: 0, gradNumColors: 0, gradColors: [], gradName: '' };
  for (; i < g.length; i++) {
    const [c, val] = g[i];
    if (c === 30) v.elevation = +val;
    else if (c === 2) v.name = val;
    else if (c === 70) v.solid = +val & 1;
    else if (c === 71) v.associative = +val;
    else if (c === 91) {
      i++;
      break;
    }
  }
  v.extrusion = [r.num(210), r.num(220), r.num(230, 1)];
  const paths = [];
  // our DXF writer emits polyline boundary paths only
  while (i < g.length && g[i][0] === 92) {
    const flags = +g[i][1];
    i++;
    const p = { flags, hasBulges: 0, closed: 1, numVerts: 0, verts: [], numBoundary: 0 };
    if (g[i] && g[i][0] === 72) p.hasBulges = +g[i++][1];
    if (g[i] && g[i][0] === 73) p.closed = +g[i++][1];
    if (g[i] && g[i][0] === 93) p.numVerts = +g[i++][1];
    for (let k = 0; k < p.numVerts && i < g.length; k++) {
      const pt = [0, 0];
      let bulge = 0;
      if (g[i][0] === 10) pt[0] = +g[i++][1];
      if (g[i] && g[i][0] === 20) pt[1] = +g[i++][1];
      if (p.hasBulges && g[i] && g[i][0] === 42) bulge = +g[i++][1];
      p.verts.push({ pt, bulge });
    }
    if (g[i] && g[i][0] === 97) {
      p.numBoundary = 0;
      i++;
    }
    paths.push(p);
  }
  v.numPaths = paths.length;
  v.paths = paths;
  const lines = [];
  let line = null;
  for (; i < g.length; i++) {
    const [c, val] = g[i];
    if (c === 75) v.style = +val;
    else if (c === 76) v.patternType = +val;
    else if (c === 52) v.angle = +val * DEG;
    else if (c === 41) v.scale = +val;
    else if (c === 77) v.double = +val;
    else if (c === 53) {
      line = { angle: +val * DEG, base: [0, 0], offset: [0, 0], dashes: [] };
      lines.push(line);
    } else if (line && c === 43) line.base[0] = +val;
    else if (line && c === 44) line.base[1] = +val;
    else if (line && c === 45) line.offset[0] = +val;
    else if (line && c === 46) line.offset[1] = +val;
    else if (line && c === 49) line.dashes.push(+val);
  }
  if (!v.solid && !lines.length) {
    // no definition was supplied: DWG readers drop pattern hatches without
    // lines, so draw it as 45 degree lines (the ANSI31 family)
    const a = (v.angle || 0) + Math.PI / 4;
    const sp = 3.175 * (v.scale || 1);
    lines.push({ angle: a, base: [0, 0], offset: [-sp * Math.sin(a), sp * Math.cos(a)], dashes: [] });
    this.warn(`Hatch pattern '${v.name}' has no definition and was written to DWG as 45° lines.`);
  }
  for (const l of lines) l.numDashes = l.dashes.length;
  v.numLines = lines.length;
  v.lines = lines;
  v.numSeeds = 0;
  v.seeds = [];
  v.boundary = [];
  return v;
}

/* ------------------------------------------------------------------ */
/* Serialization                                                       */
/* ------------------------------------------------------------------ */

function eedBytes(w, blocks, ver) {
  for (const b of blocks || []) {
    const bytes = [];
    for (const [code, val] of b.items) {
      const c = code - 1000;
      if (c === 0) {
        const s = unescape(val);
        if (ver >= R2007) {
          bytes.push(0, s.length & 0xff, s.length >> 8);
          for (let k = 0; k < s.length; k++) bytes.push(s.charCodeAt(k) & 0xff, s.charCodeAt(k) >> 8);
        } else {
          const enc = [];
          for (let k = 0; k < s.length; k++) enc.push(s.charCodeAt(k) < 256 ? s.charCodeAt(k) : 63);
          // length, then the codepage high byte first
          bytes.push(0, enc.length, 0, 30, ...enc);
        }
      } else if (c === 70) {
        const n = +val;
        bytes.push(70, n & 0xff, (n >> 8) & 0xff);
      } else if (c === 71) {
        const n = +val | 0;
        bytes.push(71, n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff);
      } else if (c === 40 || c === 41 || c === 42) {
        const f = new Uint8Array(new Float64Array([+val]).buffer);
        bytes.push(c, ...f);
      }
    }
    if (!bytes.length) continue;
    w.BS(bytes.length);
    w.H(5, b.app);
    w.rawBytes(bytes);
  }
  w.BS(0);
}

/** Patch a 32-bit raw long at a bit position without disturbing other bits. */
function patchRL(w, pos, value) {
  const save = w.pos;
  w.pos = pos;
  for (let i = 0; i < 4; i++) {
    const byte = (value >>> (i * 8)) & 0xff;
    for (let b = 7; b >= 0; b--) w.B((byte >> b) & 1);
  }
  w.pos = save;
}

function encodeObject(b, o) {
  const ver = b.ver;
  const d = new BitWriter(ver, 256);
  const hs = new BitWriter(ver, 64);
  d.OT(b.typeNum(o.type));
  const bsPos = d.pos;
  if (ver >= R2000 && ver <= R2007) d.RL(0);
  d.H(0, o.handle);
  eedBytes(d, o.v.__eed, ver);
  if (o.entity) d.B(0);
  const io = new SpecWriter(d, null, hs, o.v);
  io.o = o.v;
  if (o.entity) {
    entityCommon(io);
    entityHandles(io, o.v);
  } else {
    objectCommon(io);
    objectHandles(io, o.v);
  }
  const spec = specFor(o.type);
  if (spec) spec(io, o.v);
  patchRL(d, bsPos, d.pos);
  d.append(hs);
  const body = d.bytes();
  const head = new BitWriter(ver, 8);
  head.MS(body.length);
  const hb = head.bytes();
  const out = new Uint8Array(hb.length + body.length + 2);
  out.set(hb, 0);
  out.set(body, hb.length);
  const crc = crc16(out, 0, hb.length + body.length, 0xc0c1);
  out[out.length - 2] = crc & 0xff;
  out[out.length - 1] = crc >> 8;
  return out;
}

/** A sentinel-framed section: sentinel, RL size, data, CRC, end sentinel. */
function framed(start, data, end) {
  const out = new Uint8Array(16 + 4 + data.length + 2 + 16);
  out.set(start, 0);
  const n = data.length;
  out[16] = n & 0xff;
  out[17] = (n >> 8) & 0xff;
  out[18] = (n >> 16) & 0xff;
  out[19] = n >>> 24;
  out.set(data, 20);
  const crc = crc16(out, 16, 20 + n, 0xc0c1);
  out[20 + n] = crc & 0xff;
  out[21 + n] = crc >> 8;
  out.set(end, 22 + n);
  return out;
}

function headerBytes(b) {
  const w = new BitWriter(b.ver, 4096);
  const io = new SpecWriter(w, null, null, b.hv);
  headerSpec(io);
  return framed(SENTINEL_HEADER, w.bytes(), SENTINEL_HEADER_END);
}

function classBytes(b) {
  const w = new BitWriter(b.ver, 512);
  const r2004 = b.ver >= R2004;
  if (r2004) {
    w.BS(499 + b.classes.length);
    w.RC(0);
    w.RC(0);
    w.B(1);
  }
  const counts = new Map();
  for (const o of b.objs.values()) counts.set(o.type, (counts.get(o.type) || 0) + 1);
  for (const c of b.classes) {
    w.BS(c.num);
    w.BS(c.proxy);
    w.TV('ObjectDBX Classes');
    w.TV(c.cpp);
    w.TV(c.dxf);
    w.B(0);
    w.BS(c.entity ? 0x1f2 : 0x1f3);
    if (r2004) {
      w.BL(counts.get(c.dxf) || 0);
      w.BL(0);
      w.BL(0);
      w.BL(0);
      w.BL(0);
    }
  }
  return framed(SENTINEL_CLASSES, w.bytes(), SENTINEL_CLASSES_END);
}

function objectMapBytes(entries) {
  const chunks = [];
  let i = 0;
  while (i < entries.length) {
    const w = new BitWriter(R2000, 2048);
    w.RS(0); // size, patched below (big-endian)
    let lastH = 0;
    let lastL = 0;
    while (i < entries.length) {
      const [h, loc] = entries[i];
      const t = new BitWriter(R2000, 16);
      t.UMC(h - lastH);
      t.MC(loc - lastL);
      if (w.byteLength + t.byteLength > 2030) break;
      w.rawBytes(t.bytes());
      lastH = h;
      lastL = loc;
      i++;
    }
    const sec = w.bytes();
    sec[0] = sec.length >> 8;
    sec[1] = sec.length & 0xff;
    const crc = crc16(sec, 0, sec.length, 0xc0c1);
    const out = new Uint8Array(sec.length + 2);
    out.set(sec);
    out[sec.length] = crc >> 8;
    out[sec.length + 1] = crc & 0xff;
    chunks.push(out);
  }
  const last = new Uint8Array([0, 2, 0, 0]);
  const crc = crc16(last, 0, 2, 0xc0c1);
  last[2] = crc >> 8;
  last[3] = crc & 0xff;
  chunks.push(last);
  return concat(chunks);
}

function concat(parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function le16(v) {
  return [v & 0xff, (v >> 8) & 0xff];
}

function le32(v) {
  return [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff];
}

function auxHeader(b) {
  const verCode = b.ver >= R2004 ? 25 : 23;
  const t = b.hv.TDCREATE || [0, 0];
  const bytes = [0xff, 0x77, 0x01, ...le16(verCode), ...le16(0), ...le32(1), ...le32(0xffffffff), ...le16(1), ...le16(0), ...le32(0)];
  bytes.push(...le16(verCode), ...le16(0), ...le16(verCode), ...le16(0));
  bytes.push(...le16(5), ...le16(0x893), ...le16(5), ...le16(0x893), ...le16(0), ...le16(1));
  for (let i = 0; i < 5; i++) bytes.push(...le32(0));
  bytes.push(...le32(t[0]), ...le32(t[1]), ...le32(t[0]), ...le32(t[1]));
  bytes.push(...le32(b.hv.HANDSEED < 0x7fffffff ? b.hv.HANDSEED : 0xffffffff), ...le32(0), ...le16(0), ...le16(1));
  for (let i = 0; i < 3; i++) bytes.push(...le32(0));
  bytes.push(...le32(1));
  for (let i = 0; i < 4; i++) bytes.push(...le32(0));
  return new Uint8Array(bytes);
}

function previewBytes() {
  return new Uint8Array([...SENTINEL_PREVIEW, ...le32(1), 0, ...SENTINEL_PREVIEW_END]);
}

function objFreeSpace(b, numObjects, objStart) {
  const t = b.hv.TDUPDATE || [0, 0];
  return new Uint8Array([
    ...le32(0), ...le32(numObjects), ...le32(t[0]), ...le32(t[1]), ...le32(objStart), 4,
    ...le32(0x32), ...le32(0), ...le32(0x64), ...le32(0), ...le32(0x200), ...le32(0), ...le32(0xffffffff), ...le32(0),
  ]);
}

/** The R13-R2000 file: file header, sections, objects and the object map. */
function serializeR2000(b) {
  const nSec = 6;
  const fileHeaderSize = 0x19 + nSec * 9 + 2 + 16;
  const aux = auxHeader(b);
  const preview = previewBytes();
  const header = headerBytes(b);
  const classes = classBytes(b);
  const handles = [...b.objs.keys()].sort((x, y) => x - y);
  const objStart = fileHeaderSize + aux.length + preview.length + header.length + classes.length;
  const parts = [];
  const entries = [];
  let off = objStart;
  for (const h of handles) {
    const bytes = encodeObject(b, b.objs.get(h));
    entries.push([h, off]);
    parts.push(bytes);
    off += bytes.length;
  }
  const objects = concat(parts);
  const map = objectMapBytes(entries);
  const free = objFreeSpace(b, handles.length, objStart);
  const template = new Uint8Array([...le16(0), ...le16(b.metric ? 1 : 0)]);

  const addrAux = fileHeaderSize;
  const addrPreview = addrAux + aux.length;
  const addrHeader = addrPreview + preview.length;
  const addrClasses = addrHeader + header.length;
  const addrMap = objStart + objects.length;
  const addrFree = addrMap + map.length;
  const addrTemplate = addrFree + free.length;

  const fh = new Uint8Array(fileHeaderSize);
  const vs = 'AC1015';
  for (let i = 0; i < 6; i++) fh[i] = vs.charCodeAt(i);
  fh[0x0b] = 0;
  fh[0x0c] = 1;
  fh.set(le32(addrPreview), 0x0d);
  fh[0x11] = 23;
  fh[0x12] = 0;
  fh.set(le16(30), 0x13);
  fh.set(le32(nSec), 0x15);
  const secs = [
    [0, addrHeader, header.length],
    [1, addrClasses, classes.length],
    [2, addrMap, map.length],
    [3, addrFree, free.length],
    [4, addrTemplate, template.length],
    [5, addrAux, aux.length],
  ];
  secs.forEach(([id, a, n], k) => {
    const p = 0x19 + k * 9;
    fh[p] = id;
    fh.set(le32(a), p + 1);
    fh.set(le32(n), p + 5);
  });
  const crcAt = 0x19 + nSec * 9;
  const crc = crc16(fh, 0, crcAt, 0) ^ 0x8461;
  fh[crcAt] = crc & 0xff;
  fh[crcAt + 1] = crc >> 8;
  fh.set(SENTINEL_FILE_HEADER, crcAt + 2);
  return concat([fh, aux, preview, header, classes, objects, map, free, template]);
}

/* ------------------------------------------------------------------ */
/* R2004 container                                                     */
/* ------------------------------------------------------------------ */

const PAGE_MAX = 0x7400;
/** Bytes 0xEC - 0xFF of every R2004+ file. */
const R2004_TAIL = [0xf8, 0x46, 0x6a, 0x04, 0x96, 0x73, 0x0e, 0xd9, 0x16, 0x2f, 0x67, 0x68, 0xd4, 0xf7, 0x4a, 0x4a, 0xd0, 0x57, 0x68, 0x76];

function setU32(u8, p, v) {
  u8[p] = v & 0xff;
  u8[p + 1] = (v >>> 8) & 0xff;
  u8[p + 2] = (v >>> 16) & 0xff;
  u8[p + 3] = (v >>> 24) & 0xff;
}

function setU64(u8, p, v) {
  setU32(u8, p, v % 4294967296);
  setU32(u8, p + 4, Math.floor(v / 4294967296));
}

const align32 = (n) => (n + 31) & ~31;

/** Text of the R2004 summary info: 8-bit strings with a 16-bit length. */
function summaryInfo(b) {
  const out = [];
  const str = (s) => {
    out.push(...le16(s.length + 1));
    for (let i = 0; i < s.length; i++) out.push(s.charCodeAt(i) & 0xff);
    out.push(0);
  };
  for (let i = 0; i < 8; i++) str('');
  for (let i = 0; i < 2; i++) out.push(...le32(0));
  const t = b.hv.TDCREATE || [0, 0];
  out.push(...le32(t[0]), ...le32(t[1]), ...le32(t[0]), ...le32(t[1]));
  out.push(...le16(0), ...le32(0), ...le32(0));
  return new Uint8Array(out);
}

function appInfo() {
  const out = [];
  const str = (s) => {
    out.push(...le16(s.length + 1));
    for (let i = 0; i < s.length; i++) out.push(s.charCodeAt(i) & 0xff);
    out.push(0);
  };
  str('AppInfoDataList');
  out.push(...le32(2));
  str('4001');
  str('<ProductInformation name ="Puter CAD" build_version="0.1" registry_version="16.0" install_id_string="CAD" registry_localeID="1033"/>');
  str('Puter CAD');
  return new Uint8Array(out);
}

/** The R2004 file: encrypted header, data pages, section map and page map. */
function serializeR2004(b) {
  const header = headerBytes(b);
  const classes = classBytes(b);
  const handles = [...b.objs.keys()].sort((x, y) => x - y);
  const parts = [new Uint8Array(le32(0x0dca))];
  const entries = [];
  let off = 4;
  for (const h of handles) {
    const bytes = encodeObject(b, b.objs.get(h));
    entries.push([h, off]);
    parts.push(bytes);
    off += bytes.length;
  }
  const objects = concat(parts);
  const map = objectMapBytes(entries);
  // sections in file order (ids as AutoCAD numbers them)
  const sections = [
    { name: 'AcDb:SummaryInfo', id: 9, data: summaryInfo(b), compressed: false },
    { name: 'AcDb:Preview', id: 10, data: previewBytes(), compressed: false },
    { name: 'AcDb:AppInfo', id: 11, data: appInfo(), compressed: false },
    { name: 'AcDb:AcDbObjects', id: 7, data: objects, compressed: true },
    { name: 'AcDb:ObjFreeSpace', id: 6, data: objFreeSpace(b, handles.length, 0), compressed: true },
    { name: 'AcDb:Template', id: 5, data: new Uint8Array([...le16(0), ...le16(b.metric ? 1 : 0)]), compressed: true },
    { name: 'AcDb:Handles', id: 4, data: map, compressed: true },
    { name: 'AcDb:Classes', id: 3, data: classes, compressed: true },
    { name: 'AcDb:AuxHeader', id: 2, data: auxHeader(b), compressed: true },
    { name: 'AcDb:Header', id: 1, data: header, compressed: true },
  ];
  const pages = [];
  let addr = 0x100;
  let pageNum = 0;
  for (const sec of sections) {
    sec.pages = [];
    sec.max = sec.compressed ? PAGE_MAX : align32(sec.data.length);
    for (let start = 0; start < sec.data.length || (start === 0 && !sec.pages.length); start += sec.max) {
      const chunk = sec.data.subarray(start, Math.min(sec.data.length, start + sec.max));
      let body;
      if (sec.compressed) body = compress2004(chunk);
      else {
        body = new Uint8Array(sec.max);
        body.set(chunk);
      }
      const size = align32(32 + body.length);
      const page = new Uint8Array(size);
      page.set(body, 32);
      const dataSum = checksum2004(0, body, 0, body.length);
      const w = [0x4163043b, sec.id, body.length, size, start, 0, 0, dataSum];
      const hb = new Uint8Array(32);
      w.forEach((v, i) => setU32(hb, i * 4, v));
      w[6] = checksum2004(dataSum, hb, 0, 32);
      const mask = (0x4164536b ^ addr) >>> 0;
      w.forEach((v, i) => setU32(page, i * 4, (v ^ mask) >>> 0));
      const num = ++pageNum;
      pages.push({ num, addr, size, bytes: page });
      sec.pages.push({ num, size: body.length, offset: start });
      if (sec.name === 'AcDb:Preview') b.previewAddr = addr + 32;
      if (sec.name === 'AcDb:SummaryInfo') b.summaryAddr = addr + 32;
      if (sec.name === 'AcDb:AppInfo') b.appInfoAddr = addr + 32;
      addr += size;
      if (!chunk.length) break;
    }
  }
  // section map
  const smId = ++pageNum;
  const pmId = ++pageNum;
  const desc = [];
  const all = [{ name: '', id: 0, data: new Uint8Array(0), compressed: true, max: PAGE_MAX, pages: [] }, ...[...sections].sort((x, y) => y.id - x.id)];
  const smData = new Uint8Array(20 + all.reduce((n, s) => n + 96 + s.pages.length * 16, 0));
  setU32(smData, 0, all.length);
  setU32(smData, 4, 2);
  setU32(smData, 8, PAGE_MAX);
  setU32(smData, 12, 0);
  setU32(smData, 16, all.length);
  let p = 20;
  for (const s of all) {
    setU64(smData, p, s.data.length);
    setU32(smData, p + 8, s.pages.length);
    setU32(smData, p + 12, s.max);
    setU32(smData, p + 16, 1);
    setU32(smData, p + 20, s.compressed ? 2 : 1);
    setU32(smData, p + 24, s.id);
    setU32(smData, p + 28, 0);
    for (let k = 0; k < s.name.length; k++) smData[p + 32 + k] = s.name.charCodeAt(k);
    p += 96;
    for (const pg of s.pages) {
      setU32(smData, p, pg.num);
      setU32(smData, p + 4, pg.size);
      setU64(smData, p + 8, pg.offset);
      p += 16;
    }
  }
  void desc;
  const systemPage = (type, data) => {
    const comp = compress2004(data);
    const size = align32(20 + comp.length);
    const page = new Uint8Array(size);
    setU32(page, 0, type);
    setU32(page, 4, data.length);
    setU32(page, 8, comp.length);
    setU32(page, 12, 2);
    page.set(comp, 20);
    let sum = checksum2004(0, page, 0, 20);
    sum = checksum2004(sum, comp, 0, comp.length);
    setU32(page, 16, sum);
    return page;
  };
  const smPage = systemPage(0x4163003b, smData);
  pages.push({ num: smId, addr, size: smPage.length, bytes: smPage });
  addr += smPage.length;
  // page map: every page with its size, including itself
  const pmData = new Uint8Array((pages.length + 1) * 8);
  pages.forEach((pg, i) => {
    setU32(pmData, i * 8, pg.num);
    setU32(pmData, i * 8 + 4, pg.size);
  });
  // the page map's own size depends on its compressed length, which is
  // the same for any 32-byte aligned value: compute it once, then write it
  setU32(pmData, pages.length * 8, pmId);
  setU32(pmData, pages.length * 8 + 4, 0);
  const pmSize = systemPage(0x41630e3b, pmData).length;
  setU32(pmData, pages.length * 8 + 4, pmSize);
  const pmPage = systemPage(0x41630e3b, pmData);
  const pmAddr = addr;
  pages.push({ num: pmId, addr, size: pmPage.length, bytes: pmPage });
  addr += pmPage.length;
  const secondAddr = addr;

  // encrypted file header
  const h = new Uint8Array(0x6c);
  const id = 'AcFssFcAJMB';
  for (let i = 0; i < id.length; i++) h[i] = id.charCodeAt(i);
  setU32(h, 0x0c, 0);
  setU32(h, 0x10, 0x6c);
  setU32(h, 0x14, 4);
  setU32(h, 0x24, 1);
  setU32(h, 0x28, pmId);
  setU64(h, 0x2c, addr - 0x100);
  setU64(h, 0x34, secondAddr);
  setU32(h, 0x3c, 0);
  setU32(h, 0x40, pages.length);
  setU32(h, 0x44, 0x20);
  setU32(h, 0x48, 0x80);
  setU32(h, 0x4c, 0x40);
  setU32(h, 0x50, pmId);
  setU64(h, 0x54, pmAddr - 0x100);
  setU32(h, 0x5c, smId);
  setU32(h, 0x60, pmId);
  setU32(h, 0x64, 0);
  setU32(h, 0x68, crc32(h, 0, 0x6c, 0));
  const mask = headerMask(0x6c);
  const enc = h.map((x, i) => x ^ mask[i]);

  const fh = new Uint8Array(0x100);
  const vs = 'AC1018';
  for (let i = 0; i < 6; i++) fh[i] = vs.charCodeAt(i);
  fh[0x0b] = 0;
  fh[0x0c] = 3;
  setU32(fh, 0x0d, b.previewAddr || 0);
  fh[0x11] = 25;
  fh[0x12] = 0;
  fh.set(le16(30), 0x13);
  setU32(fh, 0x18, 0);
  setU32(fh, 0x1c, 0);
  setU32(fh, 0x20, b.summaryAddr || 0);
  setU32(fh, 0x24, 0);
  setU32(fh, 0x28, 0x80);
  setU32(fh, 0x2c, b.appInfoAddr || 0);
  fh.set(enc, 0x80);
  fh.set(R2004_TAIL, 0xec);
  return concat([fh, ...pages.map((pg) => pg.bytes), enc]);
}

/** DWG versions this writer produces. */
export const DWG_VERSIONS = { 2000: R2000, 2004: R2004 };

/**
 * Write a drawing (core/schema.js model) as a DWG file.
 * Options are those of writeDxf (dimBlocks, hatchPatterns, extents) plus
 * `warnings`, an array that receives messages about lost information.
 * @returns {Uint8Array}
 */
export function writeDwg(drawing, opts = {}) {
  const warnings = Array.isArray(opts.warnings) ? opts.warnings : [];
  const ver = DWG_VERSIONS[opts.version ?? 2004];
  if (!ver) throw new Error(`Cannot write DWG version ${opts.version}.`);
  const text = writeDxf(drawing, { ...opts, warnings });
  const b = new Builder(ver, warnings);
  const ext = opts.extents;
  if (ext) b.extents = Array.isArray(ext) ? ext.map(Number) : [ext.minX, ext.minY, ext.maxX, ext.maxY].map(Number);
  b.load(dxfSections(text));
  return ver === R2000 ? serializeR2000(b) : serializeR2004(b);
}
