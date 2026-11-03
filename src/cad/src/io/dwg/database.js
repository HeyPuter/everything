/**
 * Reads a DWG file into a plain object database: header variables, classes
 * and every object decoded by its spec, keyed by handle.
 */
import { BitReader, codepageDecoder, R14, R2000, R2004, R2007, R2010 } from './bits.js';
import { readContainer } from './container.js';
import { readHeader, sectionStreams, stringStream } from './header.js';
import { SpecReader } from './spec.js';
import { TYPE_NAMES, ENTITY_TYPES, CLASS_ENTITIES, entityCommon, entityHandles, objectCommon, objectHandles, specFor, xrecordGroups } from './objects.js';

export const SENTINEL_CLASSES = [0x8d, 0xa1, 0xc4, 0xb8, 0xc4, 0xa9, 0xf8, 0xc5, 0xc0, 0xdc, 0xf4, 0x5f, 0xe7, 0xcf, 0xb6, 0x8a];

/** Classes by number: { num, dxfName, cppName, appName, isEntity }. */
export function readClasses(u8, ver, maint, decoder) {
  const out = new Map();
  if (!u8) return out;
  const st = sectionStreams(u8, ver, maint, SENTINEL_CLASSES);
  const r = st.data;
  r.decoder = decoder;
  const s = st.strings || r;
  s.decoder = decoder;
  let count = Infinity;
  if (ver >= R2004) {
    const max = r.BS();
    r.RC();
    r.RC();
    r.B();
    count = max - 499;
  }
  const end = st.strings ? st.strings.pos : r.end;
  for (let i = 0; i < count && end - r.pos >= 30; i++) {
    try {
      const num = r.BS();
      r.BS(); // proxy flags
      const appName = s.T();
      const cppName = s.T();
      const dxfName = s.T();
      r.B(); // was a zombie
      const itemId = r.BS();
      if (ver >= R2004) {
        r.BL();
        r.BL();
        r.BL();
        r.BL();
        r.BL();
      }
      if (num < 500 || num > 0x7fff) break;
      out.set(num, { num, dxfName, cppName, appName, isEntity: itemId === 0x1f2 });
    } catch {
      break;
    }
  }
  return out;
}

/** Object map: handle -> offset in the objects data. */
export function readObjectMap(u8) {
  const map = new Map();
  let p = 0;
  while (p + 2 <= u8.length) {
    const size = (u8[p] << 8) | u8[p + 1];
    if (size <= 2) break;
    const end = Math.min(u8.length, p + size);
    const r = new BitReader(u8, R2000, (p + 2) * 8, end * 8);
    let handle = 0;
    let loc = 0;
    while (r.pos < r.end) {
      handle += r.UMC();
      loc += r.MC();
      map.set(handle, loc);
    }
    p += size + 2;
  }
  return map;
}

/** Decode the extended data blocks of an object. */
function readEed(r, ver) {
  const out = [];
  for (let guard = 0; guard < 4096; guard++) {
    const size = r.BS();
    if (!size) break;
    const app = r.H().value;
    const bytes = r.bytes(size);
    out.push({ app, items: eedItems(bytes, ver, r.decoder) });
  }
  return out;
}

function eedItems(b, ver, decoder) {
  const items = [];
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let p = 0;
  try {
    while (p < b.length) {
      const code = b[p++];
      let value;
      switch (code) {
        case 0: {
          if (ver >= R2007) {
            const n = dv.getUint16(p, true);
            p += 2;
            let s = '';
            for (let i = 0; i < n; i++) s += String.fromCharCode(dv.getUint16(p + i * 2, true));
            p += n * 2;
            value = s;
          } else {
            const n = b[p];
            p += 3;
            value = (decoder || codepageDecoder(30)).decode(b.subarray(p, p + n));
            p += n;
          }
          break;
        }
        case 2:
          value = b[p++] ? '}' : '{';
          break;
        case 3:
        case 5:
          value = dv.getUint32(p, true) + dv.getUint32(p + 4, true) * 4294967296;
          p += 8;
          break;
        case 4: {
          const n = b[p++];
          value = b.slice(p, p + n);
          p += n;
          break;
        }
        case 10:
        case 11:
        case 12:
        case 13:
          value = [dv.getFloat64(p, true), dv.getFloat64(p + 8, true), dv.getFloat64(p + 16, true)];
          p += 24;
          break;
        case 40:
        case 41:
        case 42:
          value = dv.getFloat64(p, true);
          p += 8;
          break;
        case 70:
          value = dv.getInt16(p, true);
          p += 2;
          break;
        case 71:
          value = dv.getInt32(p, true);
          p += 4;
          break;
        default:
          return items;
      }
      items.push({ code: 1000 + code, value });
    }
  } catch {
    // truncated item: keep what was read
  }
  return items;
}

/**
 * Decode the object at `loc`. Returns { type, handle, entity, ...fields } or
 * throws on damaged data.
 */
export function decodeObject(u8, loc, ctx) {
  const ver = ctx.ver;
  const r = new BitReader(u8, ver, loc * 8);
  r.decoder = ctx.decoder;
  const size = r.MS();
  const hsize = ver >= R2010 ? r.UMC() : 0;
  const start = r.pos;
  const end = start + size * 8;
  if (end > u8.length * 8) throw new RangeError('object extends past the end of the file');
  r.end = end;
  const typeNum = r.OT();
  let bitsize = ver >= R2000 && ver <= R2007 ? r.RL() : 0;
  const handle = r.H().value;
  let name = TYPE_NAMES[typeNum];
  let entity = ENTITY_TYPES.has(typeNum);
  if (typeNum >= 500) {
    const cls = ctx.classes.get(typeNum);
    name = cls ? cls.dxfName : `CLASS${typeNum}`;
    entity = cls ? cls.isEntity || CLASS_ENTITIES.has(name) : false;
  }
  const obj = { type: name || `TYPE${typeNum}`, typeNum, handle, entity, eed: null };
  const eed = readEed(r, ver);
  if (eed.length) obj.eed = eed;
  if (entity && r.B()) {
    const gs = ver >= R2010 ? r.BLL() : r.RL();
    r.pos += gs * 8;
  }
  if (ver <= R14) bitsize = r.RL();
  const hstart = ver >= R2010 ? end - hsize : start + bitsize;
  const strings = ver >= R2007 ? stringStream(r, hstart) : null;
  if (strings) strings.decoder = ctx.decoder;
  r.end = strings ? strings.pos : hstart;
  const handles = r.fork(hstart, end);
  const io = new SpecReader(r, strings, handles, handle);
  io.o = obj;
  if (entity) {
    entityCommon(io);
    entityHandles(io, obj);
  } else {
    objectCommon(io);
    objectHandles(io, obj);
  }
  const spec = specFor(obj.type);
  if (spec) {
    try {
      spec(io, obj);
    } catch (err) {
      obj.error = err.message;
    }
    if (ctx.check) obj.left = { data: r.end - r.pos, strings: strings ? strings.end - strings.pos : 0, handles: handles.end - handles.pos };
  } else obj.unsupported = true;
  return obj;
}

/**
 * Read a whole DWG file. Returns { version, ver, header, classes, objects,
 * warnings } with objects a Map of handle -> decoded object.
 */
export function readDatabase(input, opts = {}) {
  const u8 = input instanceof Uint8Array ? input : new Uint8Array(input);
  const c = readContainer(u8);
  const ver = c.ver;
  const decoder = codepageDecoder(c.codepage);
  const warnings = [];
  let header = {};
  try {
    header = readHeader(c.sections.header, ver, c.maint, decoder);
  } catch (err) {
    warnings.push(`Header variables could not be read (${err.message}); defaults were used.`);
  }
  let classes = new Map();
  try {
    classes = readClasses(c.sections.classes, ver, c.maint, decoder);
  } catch (err) {
    warnings.push(`Class definitions could not be read (${err.message}).`);
  }
  const map = readObjectMap(c.sections.handles);
  const ctx = { ver, classes, decoder, check: !!opts.check };
  const objects = new Map();
  let bad = 0;
  for (const [handle, loc] of map) {
    try {
      const o = decodeObject(c.sections.objects, loc, ctx);
      if (o.handle !== handle) {
        bad++;
        continue;
      }
      objects.set(handle, o);
    } catch {
      bad++;
    }
  }
  if (bad) warnings.push(`${bad} damaged object${bad === 1 ? ' was' : 's were'} skipped.`);
  const db = { version: c.version, ver, maint: c.maint, codepage: c.codepage, header, classes, objects, warnings };
  applyRoundTrip(db, decoder);
  nameAnonymousBlocks(db);
  return db;
}

const TABLE_TYPES = new Set(['LAYER', 'LTYPE', 'STYLE', 'DIMSTYLE', 'BLOCK_HEADER', 'APPID', 'VIEW', 'UCS', 'VPORT']);

/**
 * Data that newer AutoCAD versions keep for drawings saved in older formats:
 * the ACAD_XREC_ROUNDTRIP extension record of table entries (mixed-case
 * names, layer true colors, lineweights, plot flags) and the true color in
 * the ACAD extended data of entities.
 */
function applyRoundTrip(db, decoder) {
  const objs = db.objects;
  let acad = 0;
  for (const o of objs.values()) if (o.type === 'APPID' && typeof o.name === 'string' && o.name.toUpperCase() === 'ACAD') acad = o.handle;
  for (const o of objs.values()) {
    if (o.xdic && TABLE_TYPES.has(o.type)) {
      const dict = objs.get(o.xdic);
      const i = dict && dict.type === 'DICTIONARY' ? (dict.names || []).indexOf('ACAD_XREC_ROUNDTRIP') : -1;
      const xr = i >= 0 ? objs.get(dict.items[i]) : null;
      if (xr && xr.type === 'XRECORD' && xr.data) {
        const g = xrecordGroups(xr.data, db.ver, decoder);
        for (let k = 0; k < g.length; k++) {
          if (g[k].code !== 102) continue;
          const key = g[k].value;
          const next = (code) => {
            for (let j = k + 1; j < g.length && g[j].code !== 102; j++) if (g[j].code === code) return g[j].value;
            return undefined;
          };
          if (key === 'EXTNAMES') {
            const nm = next(2);
            if (typeof nm === 'string' && nm && next(1) === o.name) o.name = nm;
          } else if (key === 'COLORTRUE' && o.type === 'LAYER') {
            const c = next(90);
            if (c !== undefined && (c >>> 24) === 0xc2 && o.color) o.color = { ...o.color, rgb: c & 0xffffff };
          } else if (key === 'LINEWEIGHT' && o.type === 'LAYER') {
            const w = next(280);
            if (w !== undefined) o.rtLineweight = w;
          } else if (key === 'PLOTBIT' && o.type === 'LAYER') {
            const b = next(280);
            if (b !== undefined) o.rtPlot = b !== 0;
          }
        }
      }
    }
    if (o.entity && o.eed && acad && db.ver < R2004) {
      for (const blk of o.eed) {
        if (blk.app !== acad) continue;
        const it = blk.items;
        for (let k = 0; k < it.length; k++) {
          if (it[k].code !== 1000 || it[k].value !== 'RTTcAl') continue;
          for (let j = k + 1; j < it.length && it[j].code !== 1000; j++) {
            if (it[j].code === 1071 && (it[j].value >>> 24) === 0xc2 && o.color) o.color = { ...o.color, rgb: it[j].value & 0xffffff };
          }
        }
      }
    }
  }
}

/**
 * Anonymous blocks are stored as '*D', '*U', ... and numbered when a
 * drawing is opened; give each a unique name the same way.
 */
function nameAnonymousBlocks(db) {
  const taken = new Set();
  const anon = [];
  for (const o of db.objects.values()) {
    if (o.type !== 'BLOCK_HEADER' || typeof o.name !== 'string') continue;
    if (/^\*[A-Za-z]+$/.test(o.name) && !/^\*(model|paper)_space$/i.test(o.name)) anon.push(o);
    else taken.add(o.name.toUpperCase());
  }
  const next = {};
  for (const o of anon) {
    const p = o.name.toUpperCase();
    let k = next[p] || 1;
    while (taken.has(p + k)) k++;
    o.name = p + k;
    taken.add(o.name);
    next[p] = k + 1;
  }
}

export { R2004 };
