/**
 * DWG object layouts (R13 - R2018), written as specs (see spec.js) so the
 * reader and the writer share one description of every field.
 *
 * Each object is
 *   size MS, [R2010+ handle stream size MC], type OT, [R2000-R2007 bit size RL],
 *   handle H, extended data, [entity: graphics], common data, type data,
 *   handle stream (owner, reactors, xdictionary, ... type handles), CRC.
 *
 * Specs receive (io, o) where `o` holds the common data already read or the
 * values to write.
 */
import { R13, R14, R2000, R2004, R2007, R2010, R2013, R2018 } from './bits.js';

/** Fixed object type numbers. Class-based types start at 500. */
export const TYPES = {
  TEXT: 1,
  ATTRIB: 2,
  ATTDEF: 3,
  BLOCK: 4,
  ENDBLK: 5,
  SEQEND: 6,
  INSERT: 7,
  MINSERT: 8,
  VERTEX_2D: 10,
  VERTEX_3D: 11,
  VERTEX_MESH: 12,
  VERTEX_PFACE: 13,
  VERTEX_PFACE_FACE: 14,
  POLYLINE_2D: 15,
  POLYLINE_3D: 16,
  ARC: 17,
  CIRCLE: 18,
  LINE: 19,
  DIMENSION_ORDINATE: 20,
  DIMENSION_LINEAR: 21,
  DIMENSION_ALIGNED: 22,
  DIMENSION_ANG3PT: 23,
  DIMENSION_ANG2LN: 24,
  DIMENSION_RADIUS: 25,
  DIMENSION_DIAMETER: 26,
  POINT: 27,
  '3DFACE': 28,
  POLYLINE_PFACE: 29,
  POLYLINE_MESH: 30,
  SOLID: 31,
  TRACE: 32,
  SHAPE: 33,
  VIEWPORT: 34,
  ELLIPSE: 35,
  SPLINE: 36,
  REGION: 37,
  '3DSOLID': 38,
  BODY: 39,
  RAY: 40,
  XLINE: 41,
  DICTIONARY: 42,
  OLEFRAME: 43,
  MTEXT: 44,
  LEADER: 45,
  TOLERANCE: 46,
  MLINE: 47,
  BLOCK_CONTROL: 48,
  BLOCK_HEADER: 49,
  LAYER_CONTROL: 50,
  LAYER: 51,
  STYLE_CONTROL: 52,
  STYLE: 53,
  LTYPE_CONTROL: 56,
  LTYPE: 57,
  VIEW_CONTROL: 60,
  VIEW: 61,
  UCS_CONTROL: 62,
  UCS: 63,
  VPORT_CONTROL: 64,
  VPORT: 65,
  APPID_CONTROL: 66,
  APPID: 67,
  DIMSTYLE_CONTROL: 68,
  DIMSTYLE: 69,
  VX_CONTROL: 70,
  VX_TABLE_RECORD: 71,
  GROUP: 72,
  MLINESTYLE: 73,
  OLE2FRAME: 74,
  DUMMY: 75,
  LONG_TRANSACTION: 76,
  LWPOLYLINE: 77,
  HATCH: 78,
  XRECORD: 79,
  ACDBPLACEHOLDER: 80,
  VBA_PROJECT: 81,
  LAYOUT: 82,
};

export const TYPE_NAMES = {};
for (const [k, v] of Object.entries(TYPES)) TYPE_NAMES[v] = k;

/** Object types that are entities. */
export const ENTITY_TYPES = new Set([
  1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30,
  31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 43, 44, 45, 46, 47, 74, 77, 78,
]);

/** Class-based entity names (item class id 0x1F2 also marks them). */
export const CLASS_ENTITIES = new Set([
  'MULTILEADER', 'ACAD_TABLE', 'IMAGE', 'WIPEOUT', 'ARC_DIMENSION', 'LARGE_RADIAL_DIMENSION', 'HELIX', 'MESH',
  'SURFACE', 'EXTRUDEDSURFACE', 'LOFTEDSURFACE', 'REVOLVEDSURFACE', 'SWEPTSURFACE', 'PLANESURFACE',
  'NURBSURFACE', 'LIGHT', 'SECTIONOBJECT', 'UNDERLAY', 'PDFUNDERLAY', 'DWFUNDERLAY', 'DGNUNDERLAY',
  'GEOPOSITIONMARKER', 'CAMERA', 'POINTCLOUD', 'POINTCLOUDEX', 'ACAD_PROXY_ENTITY',
]);

/* ------------------------------------------------------------------ */
/* Common data                                                         */
/* ------------------------------------------------------------------ */

/** Entity data between the handle/EED and the type data. */
export function entityCommon(io) {
  const v = io.ver;
  io.BB('entmode', 2);
  io.BL('numReactors', 0);
  if (v >= R2004) io.B('xdicMissing', 1);
  if (v >= R2013) io.B('hasDs', 0);
  if (v <= R14) io.B('isByLayerLt', 1);
  if (v <= R2000) io.B('noLinks', 1);
  if (v >= R2004) io.ENC('color', { index: 256, rgb: null, alpha: null, book: false });
  else io.CMC('color', { index: 256, rgb: null });
  io.BD('ltscale', 1);
  if (v >= R2000) {
    io.BB('ltFlags', 0);
    io.BB('psFlags', 0);
  }
  if (v >= R2007) {
    io.BB('matFlags', 0);
    io.RC('shadowFlags', 0);
  }
  if (v >= R2010) {
    io.B('hasFullVs', 0);
    io.B('hasFaceVs', 0);
    io.B('hasEdgeVs', 0);
  }
  io.BS('invisible', 0);
  if (v >= R2000) io.RC('lwIndex', 29);
}

/** Entity handles that come before the type handles. */
export function entityHandles(io, o) {
  const v = io.ver;
  if (o.entmode === 0) io.H('owner');
  reactors(io, o);
  if (!o.xdicMissing) io.H('xdic');
  if (v <= R14) {
    io.H('layer');
    if (!o.isByLayerLt) io.H('ltype');
  }
  if (v <= R2000 && !o.noLinks) {
    io.H('prev');
    io.H('next');
  }
  if (v >= R2004 && o.color && o.color.book) io.H('colorBook');
  if (v >= R2000) {
    io.H('layer');
    if (o.ltFlags === 3) io.H('ltype');
  }
  if (v >= R2007 && o.matFlags === 3) io.H('material');
  if (v >= R2000 && o.psFlags === 3) io.H('plotstyle');
  if (v >= R2010) {
    if (o.hasFullVs) io.H('fullVs');
    if (o.hasFaceVs) io.H('faceVs');
    if (o.hasEdgeVs) io.H('edgeVs');
  }
}

/** Non-entity data between the handle/EED and the type data. */
export function objectCommon(io) {
  io.BL('numReactors', 0);
  if (io.ver >= R2004) io.B('xdicMissing', 1);
  if (io.ver >= R2013) io.B('hasDs', 0);
}

export function objectHandles(io, o) {
  io.H('owner');
  reactors(io, o);
  if (!o.xdicMissing) io.H('xdic');
}

function reactors(io, o) {
  const n = o.numReactors || 0;
  const list = io.o.reactors || [];
  const out = [];
  for (let i = 0; i < n; i++) {
    io.o.__r = list[i] ?? 0;
    out.push(io.H('__r'));
  }
  delete io.o.__r;
  io.o.reactors = out;
}

/** A list of handles of length n stored under key. */
function handleList(io, key, n) {
  const list = io.o[key] || [];
  const out = [];
  for (let i = 0; i < n; i++) {
    io.o.__h = list[i] ?? 0;
    out.push(io.H('__h'));
  }
  delete io.o.__h;
  io.o[key] = out;
  return out;
}

/** A list of values read with fn(io, i) into key. */
function list(io, key, n, fn) {
  const src = io.o[key] || [];
  const out = [];
  const saved = io.o;
  for (let i = 0; i < n; i++) {
    io.o = typeof src[i] === 'object' && src[i] !== null && !Array.isArray(src[i]) ? src[i] : { v: src[i] };
    const r = fn(io, i);
    out.push(r === undefined ? io.o : r);
    io.o = saved;
  }
  io.o = saved;
  io.o[key] = out;
  return out;
}

/** Common table entry prefix: name and xref flags. */
function tableEntry(io) {
  io.T('name', '');
  if (io.ver >= R2007) {
    io.BS('xrefIndex', 0);
    return;
  }
  io.B('flag64', 0);
  io.BS('xrefIndex', 0);
  io.B('xdep', 0);
}

/* ------------------------------------------------------------------ */
/* Entities                                                            */
/* ------------------------------------------------------------------ */

function textCommon(io) {
  const v = io.ver;
  if (v <= R14) {
    io.BD('elevation');
    io.RD2('ins');
    io.RD2('align');
    io.BD3('extrusion', [0, 0, 1]);
    io.BD('thickness');
    io.BD('oblique');
    io.BD('rotation');
    io.BD('height');
    io.BD('widthFactor', 1);
    io.T('value');
    io.BS('generation');
    io.BS('halign');
    io.BS('valign');
    return;
  }
  const f = io.RC('dataFlags', 0);
  if (!(f & 1)) io.RD('elevation');
  else io.o.elevation = io.o.elevation ?? 0;
  const ins = io.RD2('ins');
  if (!(f & 2)) io.DD2('align', ins);
  else io.o.align = io.o.align ?? ins;
  io.BE('extrusion');
  io.BT('thickness');
  if (!(f & 4)) io.RD('oblique');
  if (!(f & 8)) io.RD('rotation');
  io.RD('height');
  if (!(f & 0x10)) io.RD('widthFactor', 1);
  else io.o.widthFactor = io.o.widthFactor ?? 1;
  io.T('value');
  if (!(f & 0x20)) io.BS('generation');
  if (!(f & 0x40)) io.BS('halign');
  if (!(f & 0x80)) io.BS('valign');
}

function attribTail(io, def) {
  const v = io.ver;
  if (v >= R2010) io.RC('attVersion', 0);
  if (v >= R2018) {
    const t = io.RC('attType', 1);
    if (t > 1) {
      // multiline attribute: an embedded MTEXT, then its annotation data
      io.o.multiline = true;
      return false;
    }
  }
  io.T('tag');
  io.BS('fieldLength');
  io.RC('flags');
  if (v >= R2007) io.B('lockPosition');
  if (def && v >= R2010) io.RC('defVersion', 0);
  if (def) io.T('prompt');
  return true;
}

const ENT = {
  TEXT(io) {
    textCommon(io);
    io.H('style');
  },
  ATTRIB(io) {
    textCommon(io);
    if (attribTail(io, false)) io.H('style');
  },
  ATTDEF(io) {
    textCommon(io);
    if (attribTail(io, true)) io.H('style');
  },
  BLOCK(io) {
    io.T('name');
  },
  ENDBLK() {},
  SEQEND() {},
  INSERT(io) {
    insertCommon(io, false);
  },
  MINSERT(io) {
    insertCommon(io, true);
  },
  VERTEX_2D(io) {
    io.RC('flags');
    io.BD3('pt');
    const sw = io.BD('startWidth');
    if (sw < 0) {
      io.o.startWidth = io.o.endWidth = -sw;
    } else io.BD('endWidth');
    io.BD('bulge');
    if (io.ver >= R2010) io.BL('vertexId');
    io.BD('tangent');
  },
  VERTEX_3D(io) {
    io.RC('flags');
    io.BD3('pt');
  },
  VERTEX_MESH(io) {
    io.RC('flags');
    io.BD3('pt');
  },
  VERTEX_PFACE(io) {
    io.RC('flags');
    io.BD3('pt');
  },
  VERTEX_PFACE_FACE(io) {
    io.BS('i1');
    io.BS('i2');
    io.BS('i3');
    io.BS('i4');
  },
  POLYLINE_2D(io) {
    io.BS('flags');
    io.BS('curveType');
    io.BD('startWidth');
    io.BD('endWidth');
    io.BT('thickness');
    io.BD('elevation');
    io.BE('extrusion');
    polylineHandles(io);
  },
  POLYLINE_3D(io) {
    io.RC('curveFlags');
    io.RC('flags');
    polylineHandles(io);
  },
  POLYLINE_PFACE(io) {
    io.BS('numVerts');
    io.BS('numFaces');
    polylineHandles(io);
  },
  POLYLINE_MESH(io) {
    io.BS('flags');
    io.BS('curveType');
    io.BS('mCount');
    io.BS('nCount');
    io.BS('mDensity');
    io.BS('nDensity');
    polylineHandles(io);
  },
  ARC(io) {
    io.BD3('center');
    io.BD('radius');
    io.BT('thickness');
    io.BE('extrusion');
    io.BD('start');
    io.BD('end');
  },
  CIRCLE(io) {
    io.BD3('center');
    io.BD('radius');
    io.BT('thickness');
    io.BE('extrusion');
  },
  LINE(io) {
    if (io.ver <= R14) {
      io.BD3('p1');
      io.BD3('p2');
    } else {
      const zz = io.B('zzero');
      const x1 = io.RD('x1');
      io.DD('x2', x1);
      const y1 = io.RD('y1');
      io.DD('y2', y1);
      if (!zz) {
        const z1 = io.RD('z1');
        io.DD('z2', z1);
      }
    }
    io.BT('thickness');
    io.BE('extrusion');
  },
  DIMENSION_ORDINATE(io) {
    dimCommon(io);
    io.BD3('p10');
    io.BD3('p13');
    io.BD3('p14');
    io.RC('flags2');
    dimHandles(io);
  },
  DIMENSION_LINEAR(io) {
    dimCommon(io);
    io.BD3('p13');
    io.BD3('p14');
    io.BD3('p10');
    io.BD('extRotation');
    io.BD('dimRotation');
    dimHandles(io);
  },
  DIMENSION_ALIGNED(io) {
    dimCommon(io);
    io.BD3('p13');
    io.BD3('p14');
    io.BD3('p10');
    io.BD('extRotation');
    dimHandles(io);
  },
  DIMENSION_ANG3PT(io) {
    dimCommon(io);
    io.BD3('p10');
    io.BD3('p13');
    io.BD3('p14');
    io.BD3('p15');
    dimHandles(io);
  },
  DIMENSION_ANG2LN(io) {
    dimCommon(io);
    io.RD2('p16');
    io.BD3('p13');
    io.BD3('p14');
    io.BD3('p15');
    io.BD3('p10');
    dimHandles(io);
  },
  DIMENSION_RADIUS(io) {
    dimCommon(io);
    io.BD3('p10');
    io.BD3('p15');
    io.BD('leaderLength');
    dimHandles(io);
  },
  DIMENSION_DIAMETER(io) {
    dimCommon(io);
    io.BD3('p15');
    io.BD3('p10');
    io.BD('leaderLength');
    dimHandles(io);
  },
  POINT(io) {
    io.BD3('pt');
    io.BT('thickness');
    io.BE('extrusion');
    io.BD('xAngle');
  },
  '3DFACE'(io) {
    if (io.ver <= R14) {
      io.BD3('c1');
      io.BD3('c2');
      io.BD3('c3');
      io.BD3('c4');
      io.BS('invis');
      return;
    }
    const noFlags = io.B('noFlags', 1);
    const zz = io.B('zzero');
    const x = io.RD('x1');
    const y = io.RD('y1');
    const z = zz ? 0 : io.RD('z1');
    io.o.c1 = [x, y, z];
    io.DD2('c2xy', [x, y]);
    io.o.c2 = [...io.o.c2xy, io.DD('c2z', z)];
    io.DD2('c3xy', io.o.c2xy);
    io.o.c3 = [...io.o.c3xy, io.DD('c3z', io.o.c2[2])];
    io.DD2('c4xy', io.o.c3xy);
    io.o.c4 = [...io.o.c4xy, io.DD('c4z', io.o.c3[2])];
    if (!noFlags) io.BS('invis');
  },
  SOLID(io) {
    solidCommon(io);
  },
  TRACE(io) {
    solidCommon(io);
  },
  ELLIPSE(io) {
    io.BD3('center');
    io.BD3('major');
    io.BD3('extrusion', [0, 0, 1]);
    io.BD('ratio', 1);
    io.BD('start');
    io.BD('end', Math.PI * 2);
  },
  SPLINE(io) {
    const v = io.ver;
    let sc = io.BL('scenario', 1);
    if (v >= R2013) {
      const f = io.BL('splineFlags', 0);
      const kp = io.BL('knotParam', 0);
      if (f & 1) sc = 2;
      if (kp === 15) sc = 1;
      io.o.scenario = sc;
    }
    io.BL('degree', 3);
    if (sc === 2) {
      io.BD('fitTol');
      io.BD3('startTan');
      io.BD3('endTan');
      const nf = io.BL('numFit');
      list(io, 'fit', nf, (s) => s.BD3('v'));
    } else {
      io.B('rational');
      io.B('closed');
      io.B('periodic');
      io.BD('knotTol', 1e-10);
      io.BD('ctrlTol', 1e-10);
      const nk = io.BL('numKnots');
      const nc = io.BL('numCtrl');
      const w = io.B('weighted');
      list(io, 'knots', nk, (s) => s.BD('v'));
      list(io, 'ctrl', nc, (s) => {
        s.BD3('pt');
        if (w) s.BD('w', 1);
      });
    }
  },
  RAY(io) {
    io.BD3('pt');
    io.BD3('dir');
  },
  XLINE(io) {
    io.BD3('pt');
    io.BD3('dir');
  },
  MTEXT(io) {
    const v = io.ver;
    io.BD3('ins');
    io.BD3('extrusion', [0, 0, 1]);
    io.BD3('xdir', [1, 0, 0]);
    io.BD('rectWidth');
    if (v >= R2007) io.BD('rectHeight');
    io.BD('height');
    io.BS('attach', 1);
    io.BS('drawDir', 1);
    io.BD('extHeight');
    io.BD('extWidth');
    io.T('text');
    if (v >= R2000) {
      io.BS('lsStyle', 1);
      io.BD('lsFactor', 1);
      io.B('unknownBit');
    }
    if (v >= R2004) {
      const bg = io.BL('bgFlags', 0);
      if (bg & 1 || (v >= R2007 && bg & 0x10)) {
        io.BL('bgScale', 1);
        io.CMC('bgColor');
        io.BL('bgAlpha', 0);
      }
    }
    io.H('style');
  },
  LEADER(io) {
    const v = io.ver;
    io.B('unknownBit');
    io.BS('annotType', 3);
    io.BS('pathType', 0);
    const n = io.BL('numPts');
    list(io, 'pts', n, (s) => s.BD3('v'));
    io.BD3('origin');
    io.BD3('extrusion', [0, 0, 1]);
    io.BD3('xdir', [1, 0, 0]);
    io.BD3('blockOffset');
    if (v >= R2010) {
      // R2010+ pack the box size, hook and arrow flags differently; they are
      // not needed to draw the leader (the handles are a separate stream)
      io.H('annotation');
      io.H('dimstyle');
      return;
    }
    if (v >= R14) io.BD3('endProj');
    if (v <= R14) io.BD('dimgap');
    io.BD('boxHeight');
    io.BD('boxWidth');
    io.B('hookOnX');
    io.B('arrowOn', 1);
    if (v <= R14) {
      io.BS('arrowType');
      io.BD('dimasz');
      io.B('u1');
      io.B('u2');
      io.BS('u3');
      io.BS('byBlockColor');
      io.B('u4');
      io.B('u5');
    } else {
      io.BS('u6');
      io.B('u7');
      io.B('u8');
    }
    io.H('annotation');
    io.H('dimstyle');
  },
  LWPOLYLINE(io) {
    const v = io.ver;
    const f = io.BS('flags');
    if (f & 4) io.BD('constWidth');
    if (f & 8) io.BD('elevation');
    if (f & 2) io.BD('thickness');
    if (f & 1) io.BD3('extrusion', [0, 0, 1]);
    const np = io.BL('numPts');
    const nb = f & 16 ? io.BL('numBulges') : 0;
    const nid = v >= R2010 && f & 1024 ? io.BL('numIds') : 0;
    const nw = f & 32 ? io.BL('numWidths') : 0;
    let prev = null;
    list(io, 'pts', np, (s) => {
      if (v <= R14 || !prev) prev = s.RD2('v');
      else prev = s.DD2('v', prev);
      return prev;
    });
    list(io, 'bulges', nb, (s) => s.BD('v'));
    list(io, 'ids', nid, (s) => s.BL('v'));
    list(io, 'widths', nw, (s) => [s.BD('s'), s.BD('e')]);
  },
  HATCH(io) {
    const v = io.ver;
    if (v >= R2004) {
      const g = io.BL('gradient', 0);
      io.BL('gradReserved', 0);
      io.BD('gradAngle', 0);
      io.BD('gradShift', 0);
      io.BL('gradSingle', 0);
      io.BD('gradTint', 0);
      const nc = io.BL('gradNumColors', 0);
      list(io, 'gradColors', nc, (s) => {
        s.BD('value');
        s.CMC('color');
      });
      io.T('gradName', '');
      void g;
    }
    io.BD('elevation');
    io.BD3('extrusion', [0, 0, 1]);
    io.T('name', 'SOLID');
    const solid = io.B('solid', 1);
    io.B('associative', 0);
    const np = io.BL('numPaths');
    let derived = false;
    let nBoundary = 0;
    list(io, 'paths', np, (s) => {
      const pf = s.BL('flags');
      if (pf & 4) derived = true;
      if (!(pf & 2)) {
        const ns = s.BL('numSegs');
        list(s, 'segs', ns, (e) => {
          const t = e.RC('type', 1);
          if (t === 1) {
            e.RD2('p0');
            e.RD2('p1');
          } else if (t === 2) {
            e.RD2('center');
            e.BD('radius');
            e.BD('start');
            e.BD('end');
            e.B('ccw', 1);
          } else if (t === 3) {
            e.RD2('center');
            e.RD2('major');
            e.BD('ratio');
            e.BD('start');
            e.BD('end');
            e.B('ccw', 1);
          } else if (t === 4) {
            e.BL('degree', 3);
            const rat = e.B('rational');
            e.B('periodic');
            const nk = e.BL('numKnots');
            const nc = e.BL('numCtrl');
            list(e, 'knots', nk, (k) => k.BD('v'));
            list(e, 'ctrl', nc, (c) => {
              c.RD2('pt');
              if (rat) c.BD('w', 1);
            });
            if (e.ver >= R2010) {
              const nf = e.BL('numFit', 0);
              if (nf > 0) {
                list(e, 'fit', nf, (q) => q.RD2('v'));
                e.RD2('startTan');
                e.RD2('endTan');
              }
            }
          } else throw new Error(`unknown hatch edge type ${t}`);
        });
      } else {
        const hb = s.B('hasBulges');
        s.B('closed');
        const nv = s.BL('numVerts');
        list(s, 'verts', nv, (q) => {
          q.RD2('pt');
          if (hb) q.BD('bulge');
        });
      }
      nBoundary += s.BL('numBoundary', 0);
    });
    io.BS('style', 0);
    io.BS('patternType', 1);
    if (!solid) {
      io.BD('angle');
      io.BD('scale', 1);
      io.B('double');
      const nl = io.BS('numLines');
      list(io, 'lines', nl, (s) => {
        s.BD('angle');
        s.BD2('base');
        s.BD2('offset');
        const nd = s.BS('numDashes');
        list(s, 'dashes', nd, (d) => d.BD('v'));
      });
    }
    if (derived) io.BD('pixelSize');
    const ns = io.BL('numSeeds', 0);
    list(io, 'seeds', ns, (s) => s.RD2('v'));
    handleList(io, 'boundary', nBoundary);
  },
};

function insertCommon(io, multi) {
  const v = io.ver;
  io.BD3('ins');
  if (v <= R14) {
    io.BD('sx', 1);
    io.BD('sy', 1);
    io.BD('sz', 1);
  } else {
    const f = io.BB('scaleFlags', 0);
    if (f === 3) io.o.sx = io.o.sy = io.o.sz = 1;
    else if (f === 1) {
      io.o.sx = 1;
      io.DD('sy', 1);
      io.DD('sz', 1);
    } else if (f === 2) {
      const x = io.RD('sx', 1);
      io.o.sy = io.o.sz = x;
    } else {
      const x = io.RD('sx', 1);
      io.DD('sy', x);
      io.DD('sz', x);
    }
  }
  io.BD('rotation');
  io.BD3('extrusion', [0, 0, 1]);
  const has = io.B('hasAttribs');
  const n = v >= R2004 && has ? io.BL('numOwned') : 0;
  if (multi) {
    io.BS('cols', 1);
    io.BS('rows', 1);
    io.BD('colSpacing');
    io.BD('rowSpacing');
  }
  io.H('block');
  if (has) {
    if (v <= R2000) {
      io.H('firstAttrib');
      io.H('lastAttrib');
    } else handleList(io, 'owned', n);
    io.H('seqend');
  }
}

function polylineHandles(io) {
  const v = io.ver;
  const n = v >= R2004 ? io.BL('numOwned') : 0;
  if (v <= R2000) {
    io.H('firstVertex');
    io.H('lastVertex');
  } else handleList(io, 'owned', n);
  io.H('seqend');
}

function solidCommon(io) {
  io.BT('thickness');
  io.BD('elevation');
  io.RD2('c1');
  io.RD2('c2');
  io.RD2('c3');
  io.RD2('c4');
  io.BE('extrusion');
}

function dimCommon(io) {
  const v = io.ver;
  if (v >= R2010) io.RC('dimVersion', 0);
  io.BD3('extrusion', [0, 0, 1]);
  io.RD2('textMid');
  io.BD('elevation');
  io.RC('flags1', 0);
  io.T('userText', '');
  io.BD('textRotation');
  io.BD('horizDir');
  io.BD3('insScale', [1, 1, 1]);
  io.BD('insRotation');
  if (v >= R2000) {
    io.BS('attach', 5);
    io.BS('lsStyle', 1);
    io.BD('lsFactor', 1);
    io.BD('measurement');
  }
  if (v >= R2007) {
    io.B('unknownB');
    io.B('flipArrow1');
    io.B('flipArrow2');
  }
  io.RD2('p12');
}

function dimHandles(io) {
  io.H('dimstyle');
  io.H('block');
}

/* ------------------------------------------------------------------ */
/* Class-based entities                                                */
/* ------------------------------------------------------------------ */

const CLASS_OBJ = {
  ACDBDICTIONARYWDFLT(io, o) {
    OBJ.DICTIONARY(io, o);
    io.H('defaultEntry');
  },
  ACDBPLACEHOLDER() {},
  LAYOUT(io) {
    const v = io.ver;
    // plot settings
    io.T('pageSetup', '');
    io.T('printer', 'none_device');
    io.BS('plotFlags', 688);
    io.BD('marginLeft', 7.5);
    io.BD('marginBottom', 20);
    io.BD('marginRight', 7.5);
    io.BD('marginTop', 20);
    io.BD('paperWidth', 210);
    io.BD('paperHeight', 297);
    io.T('paperSize', 'ISO_A4_(210.00_x_297.00_MM)');
    io.BD2('plotOrigin');
    io.BS('paperUnits', 1);
    io.BS('plotRotation', 0);
    io.BS('plotType', 0);
    io.BD2('windowMin');
    io.BD2('windowMax');
    if (v <= R2000) io.T('plotView', '');
    io.BD('realUnits', 1);
    io.BD('drawingUnits', 1);
    io.T('styleSheet', '');
    io.BS('scaleType', 16);
    io.BD('scaleFactor', 1);
    io.BD2('imageOrigin');
    if (v >= R2004) {
      io.BS('shadeMode', 0);
      io.BS('shadeLevel', 2);
      io.BS('shadeDpi', 300);
    }
    // layout
    io.T('layoutName', 'Model');
    io.BS('tabOrder', 0);
    io.BS('layoutFlags', 1);
    io.BD3('ucsOrigin');
    io.RD2('limMin');
    io.RD2('limMax', [420, 297]);
    io.BD3('insBase');
    io.BD3('ucsX', [1, 0, 0]);
    io.BD3('ucsY', [0, 1, 0]);
    io.BD('elevation');
    io.BS('orthoType');
    io.BD3('extMin', [1e20, 1e20, 1e20]);
    io.BD3('extMax', [-1e20, -1e20, -1e20]);
    const nvp = v >= R2004 ? io.BL('numViewports', 0) : 0;
    if (v >= R2004) io.H('plotView');
    if (v >= R2007) io.H('visualStyle');
    io.H('blockRecord');
    io.H('lastViewport');
    io.H('baseUcs');
    io.H('namedUcs');
    handleList(io, 'viewports', nvp);
  },
};

const CLASS_ENT = {
  /** Only the block reference part: the table is drawn through its block. */
  ACAD_TABLE(io) {
    if (io.ver >= R2010) throw new Error('tables saved by AutoCAD 2010 and later are not supported');
    insertCommon(io, false);
  },
  MULTILEADER(io) {
    mleader(io);
  },
};

/** MULTILEADER: the leader lines and text of its context data. */
function mleader(io) {
  const v = io.ver;
  if (v >= R2010) io.BS('mlVersion', 2);
  // context data (AcDbMLeaderObjectContextData)
  const nRoots = io.BL('numRoots');
  list(io, 'roots', nRoots, (s) => {
    s.B('contentValid');
    s.B('unknownB');
    s.BD3('connection');
    s.BD3('direction');
    const nb = s.BL('numBreaks');
    list(s, 'breaks', nb, (b) => {
      b.BD3('start');
      b.BD3('end');
    });
    s.BL('index');
    s.BD('landingDistance');
    const nl = s.BL('numLines');
    list(s, 'lines', nl, (l) => {
      const np = l.BL('numPts');
      list(l, 'pts', np, (p) => p.BD3('v'));
      const nbr = l.BL('numBreakInfo');
      if (nbr > 0) {
        l.BL('segIndex');
        list(l, 'breakPts', nbr, (b) => {
          b.BD3('start');
          b.BD3('end');
        });
      }
      l.BL('lineIndex');
      if (l.ver >= R2010) {
        l.BS('lineType');
        l.CMC('lineColor');
        l.H('ltype');
        l.BL('lineWeight');
        l.BD('arrowSize');
        l.H('arrow');
        l.BL('lineFlags');
      }
    });
    if (s.ver >= R2010) s.BS('attachDir');
  });
  io.BD('scale', 1);
  io.BD3('contentBase');
  io.BD('textHeight');
  io.BD('arrowSize');
  io.BD('landingGap');
  io.BS('leftAttach');
  io.BS('rightAttach');
  io.BS('textAlignType');
  io.BS('attachType');
  const hasText = io.B('hasText');
  if (hasText) {
    io.T('label');
    io.BD3('normal', [0, 0, 1]);
    io.H('textStyle');
    io.BD3('location');
    io.BD3('dir', [1, 0, 0]);
    io.BD('rotation');
    io.BD('boundWidth');
    io.BD('boundHeight');
    io.BD('lsFactor', 1);
    io.BS('lsStyle', 1);
    io.CMC('textColor');
    io.BS('alignment');
    io.BS('flowDir');
    io.CMC('bgColor');
    io.BD('bgScale');
    io.BL('bgAlpha');
    io.B('bgEnabled');
    io.B('bgMask');
    io.BS('colType');
    io.B('autoHeight');
    io.BD('colWidth');
    io.BD('colGutter');
    io.B('colReversed');
    const nc = io.BL('numColSizes');
    list(io, 'colSizes', nc, (s) => s.BD('v'));
    io.B('wordBreak');
    io.B('unknownB2');
  } else if (io.B('hasBlock')) {
    io.H('block');
    io.BD3('blockNormal');
    io.BD3('blockLocation');
    io.BD3('blockScale');
    io.BD('blockRotation');
    io.CMC('blockColor');
    list(io, 'blockMatrix', 16, (s) => s.BD('v'));
  }
  // the rest (base point, style overrides) is not needed for drawing
}

/* ------------------------------------------------------------------ */
/* Tables and objects                                                  */
/* ------------------------------------------------------------------ */

function control(io, extra) {
  const n = io.BL('numEntries');
  let nExtra = 0;
  if (extra === 'dimstyle' && io.ver >= R2000) nExtra = io.RC('numExtra', 0);
  return { n, nExtra };
}

const OBJ = {
  BLOCK_CONTROL(io) {
    const { n } = control(io);
    handleList(io, 'entries', n);
    io.H('modelSpace');
    io.H('paperSpace');
  },
  LAYER_CONTROL: genericControl,
  STYLE_CONTROL: genericControl,
  VIEW_CONTROL: genericControl,
  UCS_CONTROL: genericControl,
  VPORT_CONTROL: genericControl,
  APPID_CONTROL: genericControl,
  VX_CONTROL: genericControl,
  LTYPE_CONTROL(io) {
    const { n } = control(io);
    handleList(io, 'entries', n);
    io.H('byBlock');
    io.H('byLayer');
  },
  DIMSTYLE_CONTROL(io) {
    const { n, nExtra } = control(io, 'dimstyle');
    handleList(io, 'entries', n);
    handleList(io, 'extra', nExtra);
  },
  BLOCK_HEADER(io) {
    const v = io.ver;
    tableEntry(io);
    io.B('anonymous');
    io.B('hasAttribs');
    const xref = io.B('isXref');
    const overlay = io.B('isOverlay');
    if (v >= R2000) io.B('loaded');
    const n = v >= R2004 && !xref && !overlay ? io.BL('numOwned') : 0;
    io.BD3('base');
    io.T('xrefPath');
    // R2000+: one non-zero byte per insert handle, ended by a zero byte
    const nIns = v >= R2000 ? io.RUN('insertCount') : 0;
    if (v >= R2000) {
      io.T('description');
      const np = io.BL('previewSize', 0);
      if (np) io.X('preview', np);
    }
    if (v >= R2007) {
      io.BS('insUnits', 0);
      io.B('explodable', 1);
      io.RC('blockScaling', 0);
    }
    io.H('xref');
    io.H('blockEntity');
    if (v <= R2000) {
      if (!xref && !overlay) {
        io.H('firstEntity');
        io.H('lastEntity');
      }
    } else handleList(io, 'owned', n);
    io.H('endblk');
    if (v >= R2000) {
      handleList(io, 'inserts', nIns);
      io.H('layout');
    }
  },
  LAYER(io) {
    const v = io.ver;
    tableEntry(io);
    if (v <= R14) {
      io.B('frozen');
      io.B('off');
      io.B('frozenNew');
      io.B('locked');
    } else io.BS('values', 0);
    io.CMC('color', { index: 7, rgb: null });
    io.H('xref');
    if (v >= R2000) io.H('plotstyle');
    if (v >= R2007) io.H('material');
    io.H('ltype');
    if (v >= R2013) io.H('unknownHandle');
  },
  STYLE(io) {
    tableEntry(io);
    io.B('vertical');
    io.B('shapeFile');
    io.BD('fixedHeight');
    io.BD('widthFactor', 1);
    io.BD('oblique');
    io.RC('generation');
    io.BD('lastHeight', 2.5);
    io.T('font', 'txt');
    io.T('bigFont', '');
    io.H('xref');
  },
  LTYPE(io) {
    const v = io.ver;
    tableEntry(io);
    io.T('description');
    io.BD('patternLength');
    io.RC('alignment', 65);
    const n = io.RC('numDashes');
    let hasText = false;
    list(io, 'dashes', n, (s) => {
      s.BD('length');
      s.BS('shape');
      s.RD('dx');
      s.RD('dy');
      s.BD('scale', 1);
      s.BD('rotation');
      const f = s.BS('shapeFlag');
      if (f & 2) hasText = true;
    });
    if (v <= R2004) io.X('strings', 256);
    else if (hasText) io.X('strings', 512);
    io.H('xref');
    const dashes = io.o.dashes;
    for (const d of dashes) {
      const saved = io.o;
      io.o = d;
      io.H('shapeFile');
      io.o = saved;
    }
  },
  APPID(io) {
    tableEntry(io);
    io.RC('unknown', 0);
    io.H('xref');
  },
  DIMSTYLE(io) {
    dimstyleSpec(io);
  },
  VPORT(io) {
    const v = io.ver;
    tableEntry(io);
    io.BD('height', 100);
    io.BD('aspect', 150);
    io.RD2('center');
    io.BD3('target');
    io.BD3('dir', [0, 0, 1]);
    io.BD('twist');
    io.BD('lens', 50);
    io.BD('front');
    io.BD('back');
    io.B('vmUcsFollow');
    io.B('vmFront');
    io.B('vmBack');
    io.B('vmPersp');
    if (v >= R2000) io.RC('renderMode');
    if (v >= R2007) {
      io.B('defaultLights', 1);
      io.RC('lightingType', 1);
      io.BD('brightness');
      io.BD('contrast');
      io.CMC('ambient', { index: 250, rgb: null });
    }
    io.RD2('lowerLeft');
    io.RD2('upperRight', [1, 1]);
    io.B('ucsFollow');
    io.BS('circleZoom', 1000);
    io.B('fastZoom', 1);
    io.BB('ucsIcon', 3);
    io.B('gridOn');
    io.RD2('gridSpacing', [10, 10]);
    io.B('snapOn');
    io.B('snapStyle');
    io.BS('snapIsopair');
    io.BD('snapRot');
    io.RD2('snapBase');
    io.RD2('snapSpacing', [10, 10]);
    if (v >= R2000) {
      io.B('unknownB');
      io.B('ucsPerViewport', 1);
      io.BD3('ucsOrigin');
      io.BD3('ucsX', [1, 0, 0]);
      io.BD3('ucsY', [0, 1, 0]);
      io.BD('ucsElevation');
      io.BS('ucsOrtho');
    }
    if (v >= R2007) {
      io.BS('gridFlags', 7);
      io.BS('gridMajor', 5);
    }
    io.H('xref');
    if (v >= R2007) {
      io.H('background');
      io.H('visualStyle');
      io.H('sun');
    }
    if (v >= R2000) {
      io.H('namedUcs');
      io.H('baseUcs');
    }
  },
  MLINESTYLE(io) {
    io.T('name', 'Standard');
    io.T('description', '');
    io.BS('flags');
    io.CMC('fillColor', { index: 256, rgb: null });
    io.BD('startAngle', Math.PI / 2);
    io.BD('endAngle', Math.PI / 2);
    const n = io.RC('numLines', 2);
    list(io, 'lines', n, (s) => {
      s.BD('offset');
      s.CMC('color', { index: 256, rgb: null });
      if (s.ver >= R2018) s.H('ltype');
      else s.BSs('ltIndex', 0);
    });
  },
  XRECORD(io) {
    const n = io.BL('numBytes');
    io.X('data', n);
    if (io.ver >= R2000) io.BS('cloning', 1);
  },
  DICTIONARY(io) {
    const v = io.ver;
    const n = io.BL('numItems');
    if (v === R14) io.RC('unknownR14');
    if (v >= R2000) {
      io.BS('cloning', 1);
      io.RC('hardOwner', 0);
    }
    list(io, 'names', n, (s) => s.T('v'));
    handleList(io, 'items', n);
  },
};

function genericControl(io) {
  const { n } = control(io);
  handleList(io, 'entries', n);
}

/** DIMSTYLE fields (also the order of the $DIM header variables). */
function dimstyleSpec(io) {
  const v = io.ver;
  tableEntry(io);
  if (v <= R14) {
    io.B('DIMTOL');
    io.B('DIMLIM');
    io.B('DIMTIH', 1);
    io.B('DIMTOH', 1);
    io.B('DIMSE1');
    io.B('DIMSE2');
    io.B('DIMALT');
    io.B('DIMTOFL');
    io.B('DIMSAH');
    io.B('DIMTIX');
    io.B('DIMSOXD');
    io.RC('DIMALTD', 2);
    io.RC('DIMZIN');
    io.B('DIMSD1');
    io.B('DIMSD2');
    io.RC('DIMTOLJ', 1);
    io.RC('DIMJUST');
    io.RC('DIMFIT', 3);
    io.B('DIMUPT');
    io.RC('DIMTZIN');
    io.RC('DIMALTZ');
    io.RC('DIMALTTZ');
    io.RC('DIMTAD');
    io.BS('DIMUNIT', 2);
    io.BS('DIMAUNIT');
    io.BS('DIMDEC', 4);
    io.BS('DIMTDEC', 4);
    io.BS('DIMALTU', 2);
    io.BS('DIMALTTD', 2);
    io.BD('DIMSCALE', 1);
    io.BD('DIMASZ', 0.18);
    io.BD('DIMEXO', 0.0625);
    io.BD('DIMDLI', 0.38);
    io.BD('DIMEXE', 0.18);
    io.BD('DIMRND');
    io.BD('DIMDLE');
    io.BD('DIMTP');
    io.BD('DIMTM');
    io.BD('DIMTXT', 0.18);
    io.BD('DIMCEN', 0.09);
    io.BD('DIMTSZ');
    io.BD('DIMALTF', 25.4);
    io.BD('DIMLFAC', 1);
    io.BD('DIMTVP');
    io.BD('DIMTFAC', 1);
    io.BD('DIMGAP', 0.09);
    io.T('DIMPOST');
    io.T('DIMAPOST');
    io.T('DIMBLK');
    io.T('DIMBLK1');
    io.T('DIMBLK2');
    io.BS('DIMCLRD');
    io.BS('DIMCLRE');
    io.BS('DIMCLRT');
  } else {
    io.T('DIMPOST');
    io.T('DIMAPOST');
    io.BD('DIMSCALE', 1);
    io.BD('DIMASZ', 2.5);
    io.BD('DIMEXO', 0.625);
    io.BD('DIMDLI', 3.75);
    io.BD('DIMEXE', 1.25);
    io.BD('DIMRND');
    io.BD('DIMDLE');
    io.BD('DIMTP');
    io.BD('DIMTM');
    if (v >= R2007) {
      io.BD('DIMFXL', 1);
      io.BD('DIMJOGANG', Math.PI / 4);
      io.BS('DIMTFILL');
      io.CMC('DIMTFILLCLR', { index: 0, rgb: null });
    }
    io.B('DIMTOL');
    io.B('DIMLIM');
    io.B('DIMTIH');
    io.B('DIMTOH');
    io.B('DIMSE1');
    io.B('DIMSE2');
    io.BS('DIMTAD', 1);
    io.BS('DIMZIN', 8);
    io.BS('DIMAZIN');
    if (v >= R2007) io.BS('DIMARCSYM');
    io.BD('DIMTXT', 2.5);
    io.BD('DIMCEN', 2.5);
    io.BD('DIMTSZ');
    io.BD('DIMALTF', 0.03937007874);
    io.BD('DIMLFAC', 1);
    io.BD('DIMTVP');
    io.BD('DIMTFAC', 1);
    io.BD('DIMGAP', 0.625);
    io.BD('DIMALTRND');
    io.B('DIMALT');
    io.BS('DIMALTD', 3);
    io.B('DIMTOFL', 1);
    io.B('DIMSAH');
    io.B('DIMTIX');
    io.B('DIMSOXD');
    io.CMC('DIMCLRD', { index: 0, rgb: null });
    io.CMC('DIMCLRE', { index: 0, rgb: null });
    io.CMC('DIMCLRT', { index: 0, rgb: null });
    io.BS('DIMADEC');
    io.BS('DIMDEC', 2);
    io.BS('DIMTDEC', 2);
    io.BS('DIMALTU', 2);
    io.BS('DIMALTTD', 3);
    io.BS('DIMAUNIT');
    io.BS('DIMFRAC');
    io.BS('DIMLUNIT', 2);
    io.BS('DIMDSEP', 46);
    io.BS('DIMTMOVE');
    io.BS('DIMJUST');
    io.B('DIMSD1');
    io.B('DIMSD2');
    io.BS('DIMTOLJ', 1);
    io.BS('DIMTZIN', 8);
    io.BS('DIMALTZ');
    io.BS('DIMALTTZ');
    io.B('DIMUPT');
    io.BS('DIMATFIT', 3);
    if (v >= R2007) io.B('DIMFXLON');
    if (v >= R2010) {
      io.B('DIMTXTDIRECTION');
      io.BD('DIMALTMZF');
      io.T('DIMALTMZS');
      io.BD('DIMMZF');
      io.T('DIMMZS');
    }
    io.BSs('DIMLWD', -2);
    io.BSs('DIMLWE', -2);
  }
  io.B('flag0');
  io.H('xref');
  io.H('DIMTXSTY');
  if (v >= R2000) {
    io.H('DIMLDRBLK');
    io.H('DIMBLKH');
    io.H('DIMBLK1H');
    io.H('DIMBLK2H');
  }
  if (v >= R2007) {
    io.H('DIMLTYPE');
    io.H('DIMLTEX1');
    io.H('DIMLTEX2');
  }
}

/** Spec for a fixed type name, or null. */
/**
 * Groups of XRECORD data bytes: [{ code, value }]. Handles come as numbers,
 * points as [x, y, z].
 */
export function xrecordGroups(bytes, ver, decoder) {
  const out = [];
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let p = 0;
  try {
    while (p + 2 <= bytes.length) {
      const code = dv.getInt16(p, true);
      p += 2;
      let value;
      const k = groupKind(code);
      if (k === 's') {
        if (ver >= R2007) {
          const n = dv.getUint16(p, true);
          p += 2;
          let str = '';
          for (let i = 0; i < n; i++) str += String.fromCharCode(dv.getUint16(p + i * 2, true));
          p += n * 2;
          value = str;
        } else {
          const n = dv.getUint16(p, true);
          p += 3;
          value = decoder.decode(bytes.subarray(p, p + n));
          p += n;
        }
      } else if (k === 'p') {
        value = [dv.getFloat64(p, true), dv.getFloat64(p + 8, true), dv.getFloat64(p + 16, true)];
        p += 24;
      } else if (k === 'd') {
        value = dv.getFloat64(p, true);
        p += 8;
      } else if (k === 'c') value = bytes[p++];
      else if (k === 'h16') {
        value = dv.getInt16(p, true);
        p += 2;
      } else if (k === 'l') {
        value = dv.getInt32(p, true);
        p += 4;
      } else if (k === 'h' || k === 'll') {
        value = dv.getUint32(p, true) + dv.getUint32(p + 4, true) * 4294967296;
        p += 8;
      } else if (k === 'b') {
        const n = bytes[p++];
        value = bytes.slice(p, p + n);
        p += n;
      } else break;
      out.push({ code, value });
    }
  } catch {
    // truncated: keep what was read
  }
  return out;
}

function groupKind(c) {
  if ((c >= 0 && c <= 9) || c === 100 || c === 101 || c === 102 || c === 105 || (c >= 300 && c <= 309) || (c >= 410 && c <= 419) || (c >= 430 && c <= 439) || (c >= 470 && c <= 479) || c === 999 || (c >= 1000 && c <= 1003) || (c >= 1005 && c <= 1009)) return 's';
  if ((c >= 10 && c <= 18) || (c >= 110 && c <= 112) || c === 210 || (c >= 1010 && c <= 1013)) return 'p';
  if ((c >= 19 && c <= 59) || (c >= 113 && c <= 149) || (c >= 211 && c <= 239) || (c >= 460 && c <= 469) || (c >= 1014 && c <= 1059)) return 'd';
  if ((c >= 280 && c <= 299)) return 'c';
  if ((c >= 60 && c <= 79) || (c >= 170 && c <= 179) || (c >= 270 && c <= 279) || (c >= 400 && c <= 409) || (c >= 1060 && c <= 1070)) return 'h16';
  if ((c >= 90 && c <= 99) || (c >= 420 && c <= 429) || (c >= 440 && c <= 449) || c === 1071) return 'l';
  if ((c >= 320 && c <= 369) || (c >= 390 && c <= 399) || (c >= 480 && c <= 481)) return 'h';
  if (c >= 160 && c <= 169) return 'll';
  if ((c >= 310 && c <= 319) || c === 1004) return 'b';
  return null;
}

export function specFor(name) {
  return ENT[name] || OBJ[name] || CLASS_ENT[name] || CLASS_OBJ[name] || null;
}

/** True when the named type is an entity. */
export function isEntityName(name) {
  return !!(ENT[name] || CLASS_ENT[name] || CLASS_ENTITIES.has(name));
}

export { R13 };
