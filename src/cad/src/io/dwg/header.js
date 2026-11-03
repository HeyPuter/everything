/**
 * DWG header variables (the AcDb:Header section), in file order. The
 * defaults are those of a new metric drawing and are what the writer uses
 * for variables the drawing model does not hold.
 */
import { BitReader, crc16, R13, R14, R2000, R2004, R2007, R2010, R2013, R2018 } from './bits.js';
import { SpecReader } from './spec.js';

export const SENTINEL_HEADER = [0xcf, 0x7b, 0x1f, 0x23, 0xfd, 0xde, 0x38, 0xa9, 0x5f, 0x7c, 0x68, 0xb8, 0x4e, 0x6d, 0x33, 0x5f];
export const SENTINEL_HEADER_END = [0x30, 0x84, 0xe0, 0xdc, 0x02, 0x21, 0xc7, 0x56, 0xa0, 0x83, 0x97, 0x47, 0xb1, 0x92, 0xcc, 0xa0];

/** The header variables, in file order. */
export function headerSpec(io) {
  const v = io.ver;
  const R1314 = v <= R14;
  if (v >= R2013) io.BLL('REQUIREDVERSIONS', 0);
  io.BD('unknown1', 412148564080.0);
  io.BD('unknown2', 1);
  io.BD('unknown3', 1);
  io.BD('unknown4', 1);
  io.T('unknown5', '');
  io.T('unknown6', '');
  io.T('unknown7', '');
  io.T('unknown8', '');
  io.BL('unknown9', 24);
  io.BL('unknown10', 0);
  if (R1314) io.BS('unknown11', 0);
  if (v <= R2000) io.H('VPORT_ENTITY_HEADER', 0);
  io.B('DIMASO', 1);
  io.B('DIMSHO', 1);
  if (R1314) io.B('DIMSAV', 0);
  io.B('PLINEGEN', 0);
  io.B('ORTHOMODE', 0);
  io.B('REGENMODE', 1);
  io.B('FILLMODE', 1);
  io.B('QTEXTMODE', 0);
  io.B('PSLTSCALE', 1);
  io.B('LIMCHECK', 0);
  if (R1314) io.B('BLIPMODE', 0);
  if (v >= R2004) io.B('unknown12', 0);
  io.B('USRTIMER', 1);
  io.B('SKPOLY', 0);
  io.B('ANGDIR', 0);
  io.B('SPLFRAME', 0);
  if (R1314) {
    io.B('ATTREQ', 1);
    io.B('ATTDIA', 0);
  }
  io.B('MIRRTEXT', 0);
  io.B('WORLDVIEW', 1);
  if (R1314) io.B('WIREFRAME', 0);
  io.B('TILEMODE', 1);
  io.B('PLIMCHECK', 0);
  io.B('VISRETAIN', 1);
  if (R1314) io.B('DELOBJ', 1);
  io.B('DISPSILH', 0);
  io.B('PELLIPSE', 0);
  io.BS('PROXYGRAPHICS', 1);
  if (R1314) io.BS('DRAGMODE', 2);
  io.BS('TREEDEPTH', 3020);
  io.BS('LUNITS', 2);
  io.BS('LUPREC', 4);
  io.BS('AUNITS', 0);
  io.BS('AUPREC', 0);
  if (R1314) io.BS('OSMODE', 37);
  io.BS('ATTMODE', 1);
  if (R1314) io.BS('COORDS', 1);
  io.BS('PDMODE', 0);
  if (R1314) io.BS('PICKSTYLE', 1);
  if (v >= R2004) {
    io.BL('unknown13', 0);
    io.BL('unknown14', 0);
    io.BL('unknown15', 0);
  }
  io.BS('USERI1', 0);
  io.BS('USERI2', 0);
  io.BS('USERI3', 0);
  io.BS('USERI4', 0);
  io.BS('USERI5', 0);
  io.BS('SPLINESEGS', 8);
  io.BS('SURFU', 6);
  io.BS('SURFV', 6);
  io.BS('SURFTYPE', 6);
  io.BS('SURFTAB1', 6);
  io.BS('SURFTAB2', 6);
  io.BS('SPLINETYPE', 6);
  io.BS('SHADEDGE', 3);
  io.BS('SHADEDIF', 70);
  io.BS('UNITMODE', 0);
  io.BS('MAXACTVP', 64);
  io.BS('ISOLINES', 4);
  io.BS('CMLJUST', 0);
  io.BS('TEXTQLTY', 50);
  io.BD('LTSCALE', 1);
  io.BD('TEXTSIZE', 2.5);
  io.BD('TRACEWID', 1);
  io.BD('SKETCHINC', 1);
  io.BD('FILLETRAD', 0);
  io.BD('THICKNESS', 0);
  io.BD('ANGBASE', 0);
  io.BD('PDSIZE', 0);
  io.BD('PLINEWID', 0);
  io.BD('USERR1', 0);
  io.BD('USERR2', 0);
  io.BD('USERR3', 0);
  io.BD('USERR4', 0);
  io.BD('USERR5', 0);
  io.BD('CHAMFERA', 0);
  io.BD('CHAMFERB', 0);
  io.BD('CHAMFERC', 0);
  io.BD('CHAMFERD', 0);
  io.BD('FACETRES', 0.5);
  io.BD('CMLSCALE', 20);
  io.BD('CELTSCALE', 1);
  if (v <= R2004) io.T('MENUNAME', 'acad');
  io.TIME('TDCREATE', [2451545, 0]);
  io.TIME('TDUPDATE', [2451545, 0]);
  if (v >= R2004) {
    io.BL('unknown16', 0);
    io.BL('unknown17', 0);
    io.BL('unknown18', 0);
  }
  io.TIME('TDINDWG', [0, 0]);
  io.TIME('TDUSRTIMER', [0, 0]);
  io.CMC('CECOLOR', { index: 256, rgb: null });
  io.HD('HANDSEED', 0);
  io.H('CLAYER', 0);
  io.H('TEXTSTYLE', 0);
  io.H('CELTYPE', 0);
  if (v >= R2007) io.H('CMATERIAL', 0);
  io.H('DIMSTYLE', 0);
  io.H('CMLSTYLE', 0);
  if (v >= R2000) io.BD('PSVPSCALE', 0);
  io.BD3('PINSBASE');
  io.BD3('PEXTMIN', [1e20, 1e20, 1e20]);
  io.BD3('PEXTMAX', [-1e20, -1e20, -1e20]);
  io.RD2('PLIMMIN', [0, 0]);
  io.RD2('PLIMMAX', [420, 297]);
  io.BD('PELEVATION', 0);
  io.BD3('PUCSORG');
  io.BD3('PUCSXDIR', [1, 0, 0]);
  io.BD3('PUCSYDIR', [0, 1, 0]);
  io.H('PUCSNAME', 0);
  if (v >= R2000) {
    io.H('PUCSORTHOREF', 0);
    io.BS('PUCSORTHOVIEW', 0);
    io.H('PUCSBASE', 0);
    io.BD3('PUCSORGTOP');
    io.BD3('PUCSORGBOTTOM');
    io.BD3('PUCSORGLEFT');
    io.BD3('PUCSORGRIGHT');
    io.BD3('PUCSORGFRONT');
    io.BD3('PUCSORGBACK');
  }
  io.BD3('INSBASE');
  io.BD3('EXTMIN', [1e20, 1e20, 1e20]);
  io.BD3('EXTMAX', [-1e20, -1e20, -1e20]);
  io.RD2('LIMMIN', [0, 0]);
  io.RD2('LIMMAX', [420, 297]);
  io.BD('ELEVATION', 0);
  io.BD3('UCSORG');
  io.BD3('UCSXDIR', [1, 0, 0]);
  io.BD3('UCSYDIR', [0, 1, 0]);
  io.H('UCSNAME', 0);
  if (v >= R2000) {
    io.H('UCSORTHOREF', 0);
    io.BS('UCSORTHOVIEW', 0);
    io.H('UCSBASE', 0);
    io.BD3('UCSORGTOP');
    io.BD3('UCSORGBOTTOM');
    io.BD3('UCSORGLEFT');
    io.BD3('UCSORGRIGHT');
    io.BD3('UCSORGFRONT');
    io.BD3('UCSORGBACK');
    io.T('DIMPOST', '');
    io.T('DIMAPOST', '');
  }
  if (R1314) {
    io.B('DIMTOL', 0);
    io.B('DIMLIM', 0);
    io.B('DIMTIH', 0);
    io.B('DIMTOH', 0);
    io.B('DIMSE1', 0);
    io.B('DIMSE2', 0);
    io.B('DIMALT', 0);
    io.B('DIMTOFL', 1);
    io.B('DIMSAH', 0);
    io.B('DIMTIX', 0);
    io.B('DIMSOXD', 0);
    io.RC('DIMALTD', 3);
    io.RC('DIMZIN', 8);
    io.B('DIMSD1', 0);
    io.B('DIMSD2', 0);
    io.RC('DIMTOLJ', 0);
    io.RC('DIMJUST', 0);
    io.RC('DIMFIT', 3);
    io.B('DIMUPT', 0);
    io.RC('DIMTZIN', 8);
    io.RC('DIMALTZ', 0);
    io.RC('DIMALTTZ', 0);
    io.RC('DIMTAD', 1);
    io.BS('DIMUNIT', 2);
    io.BS('DIMAUNIT', 0);
    io.BS('DIMDEC', 2);
    io.BS('DIMTDEC', 2);
    io.BS('DIMALTU', 2);
    io.BS('DIMALTTD', 3);
    io.H('DIMTXSTY', 0);
  }
  io.BD('DIMSCALE', 1);
  io.BD('DIMASZ', 2.5);
  io.BD('DIMEXO', 0.625);
  io.BD('DIMDLI', 3.75);
  io.BD('DIMEXE', 1.25);
  io.BD('DIMRND', 0);
  io.BD('DIMDLE', 0);
  io.BD('DIMTP', 0);
  io.BD('DIMTM', 0);
  if (v >= R2007) {
    io.BD('DIMFXL', 1);
    io.BD('DIMJOGANG', Math.PI / 4);
    io.BS('DIMTFILL', 0);
    io.CMC('DIMTFILLCLR', { index: 0, rgb: null });
  }
  if (v >= R2000) {
    io.B('DIMTOL', 0);
    io.B('DIMLIM', 0);
    io.B('DIMTIH', 0);
    io.B('DIMTOH', 0);
    io.B('DIMSE1', 0);
    io.B('DIMSE2', 0);
    io.BS('DIMTAD', 1);
    io.BS('DIMZIN', 8);
    io.BS('DIMAZIN', 0);
  }
  if (v >= R2007) io.BS('DIMARCSYM', 0);
  io.BD('DIMTXT', 2.5);
  io.BD('DIMCEN', 2.5);
  io.BD('DIMTSZ', 0);
  io.BD('DIMALTF', 0.03937007874);
  io.BD('DIMLFAC', 1);
  io.BD('DIMTVP', 0);
  io.BD('DIMTFAC', 1);
  io.BD('DIMGAP', 0.625);
  if (R1314) {
    io.T('DIMPOST', '');
    io.T('DIMAPOST', '');
    io.T('DIMBLK', '');
    io.T('DIMBLK1', '');
    io.T('DIMBLK2', '');
  }
  if (v >= R2000) {
    io.BD('DIMALTRND', 0);
    io.B('DIMALT', 0);
    io.BS('DIMALTD', 3);
    io.B('DIMTOFL', 1);
    io.B('DIMSAH', 0);
    io.B('DIMTIX', 0);
    io.B('DIMSOXD', 0);
  }
  if (v >= R2004) {
    io.CMC('DIMCLRD', { index: 0, rgb: null });
    io.CMC('DIMCLRE', { index: 0, rgb: null });
    io.CMC('DIMCLRT', { index: 0, rgb: null });
  } else {
    io.BS('DIMCLRD', 0);
    io.BS('DIMCLRE', 0);
    io.BS('DIMCLRT', 0);
  }
  if (v >= R2000) {
    io.BS('DIMADEC', 0);
    io.BS('DIMDEC', 2);
    io.BS('DIMTDEC', 2);
    io.BS('DIMALTU', 2);
    io.BS('DIMALTTD', 3);
    io.BS('DIMAUNIT', 0);
    io.BS('DIMFRAC', 0);
    io.BS('DIMLUNIT', 2);
    io.BS('DIMDSEP', 44);
    io.BS('DIMTMOVE', 0);
    io.BS('DIMJUST', 0);
    io.B('DIMSD1', 0);
    io.B('DIMSD2', 0);
    io.BS('DIMTOLJ', 0);
    io.BS('DIMTZIN', 8);
    io.BS('DIMALTZ', 0);
    io.BS('DIMALTTZ', 0);
    io.B('DIMUPT', 0);
    io.BS('DIMATFIT', 3);
  }
  if (v >= R2007) io.B('DIMFXLON', 0);
  if (v >= R2010) {
    io.B('DIMTXTDIRECTION', 0);
    io.BD('DIMALTMZF', 0);
    io.T('DIMALTMZS', '');
    io.BD('DIMMZF', 0);
    io.T('DIMMZS', '');
  }
  if (v >= R2000) {
    io.H('DIMTXSTY', 0);
    io.H('DIMLDRBLK', 0);
    io.H('DIMBLK', 0);
    io.H('DIMBLK1', 0);
    io.H('DIMBLK2', 0);
  }
  if (v >= R2007) {
    io.H('DIMLTYPE', 0);
    io.H('DIMLTEX1', 0);
    io.H('DIMLTEX2', 0);
  }
  if (v >= R2000) {
    io.BSs('DIMLWD', -2);
    io.BSs('DIMLWE', -2);
  }
  io.H('BLOCK_CONTROL', 0);
  io.H('LAYER_CONTROL', 0);
  io.H('STYLE_CONTROL', 0);
  io.H('LTYPE_CONTROL', 0);
  io.H('VIEW_CONTROL', 0);
  io.H('UCS_CONTROL', 0);
  io.H('VPORT_CONTROL', 0);
  io.H('APPID_CONTROL', 0);
  io.H('DIMSTYLE_CONTROL', 0);
  if (v <= R2000) io.H('VX_CONTROL', 0);
  io.H('DICT_GROUP', 0);
  io.H('DICT_MLINESTYLE', 0);
  io.H('DICT_NAMED', 0);
  if (v >= R2000) {
    io.BS('TSTACKALIGN', 1);
    io.BS('TSTACKSIZE', 70);
    io.T('HYPERLINKBASE', '');
    io.T('STYLESHEET', '');
    io.H('DICT_LAYOUT', 0);
    io.H('DICT_PLOTSETTINGS', 0);
    io.H('DICT_PLOTSTYLE', 0);
  }
  if (v >= R2004) {
    io.H('DICT_MATERIAL', 0);
    io.H('DICT_COLOR', 0);
  }
  if (v >= R2007) io.H('DICT_VISUALSTYLE', 0);
  if (v >= R2013) io.H('DICT_UNKNOWN', 0);
  if (v >= R2000) {
    io.BL('FLAGS', 0x1d | 0x200 | 0x800);
    io.BS('INSUNITS', 4);
    const t = io.BS('CEPSNTYPE', 0);
    if (t === 3) io.H('CPSNID', 0);
    io.T('FINGERPRINTGUID', '{00000000-0000-0000-0000-000000000000}');
    io.T('VERSIONGUID', '{00000000-0000-0000-0000-000000000000}');
  }
  if (v >= R2004) {
    io.RC('SORTENTS', 127);
    io.RC('INDEXCTL', 0);
    io.RC('HIDETEXT', 1);
    io.RC('XCLIPFRAME', 0);
    io.RC('DIMASSOC', 2);
    io.RC('HALOGAP', 0);
    io.BS('OBSCUREDCOLOR', 257);
    io.BS('INTERSECTIONCOLOR', 257);
    io.RC('OBSCUREDLTYPE', 0);
    io.RC('INTERSECTIONDISPLAY', 0);
    io.T('PROJECTNAME', '');
  }
  io.H('BLOCK_PAPER_SPACE', 0);
  io.H('BLOCK_MODEL_SPACE', 0);
  io.H('LTYPE_BYLAYER', 0);
  io.H('LTYPE_BYBLOCK', 0);
  io.H('LTYPE_CONTINUOUS', 0);
  if (v >= R2007) {
    io.B('CAMERADISPLAY', 0);
    io.BL('unknown19', 0);
    io.BL('unknown20', 0);
    io.BD('unknown21', 0);
    io.BD('STEPSPERSEC', 2);
    io.BD('STEPSIZE', 6);
    io.BD('3DDWFPREC', 2);
    io.BD('LENSLENGTH', 50);
    io.BD('CAMERAHEIGHT', 0);
    io.RC('SOLIDHIST', 0);
    io.RC('SHOWHIST', 1);
    io.BD('PSOLWIDTH', 5);
    io.BD('PSOLHEIGHT', 80);
    io.BD('LOFTANG1', Math.PI / 2);
    io.BD('LOFTANG2', Math.PI / 2);
    io.BD('LOFTMAG1', 0);
    io.BD('LOFTMAG2', 0);
    io.BS('LOFTPARAM', 7);
    io.RC('LOFTNORMALS', 1);
    io.BD('LATITUDE', 37.795);
    io.BD('LONGITUDE', -122.394);
    io.BD('NORTHDIRECTION', 0);
    io.BL('TIMEZONE', -8000);
    io.RC('LIGHTGLYPHDISPLAY', 1);
    io.RC('TILEMODELIGHTSYNCH', 1);
    io.RC('DWFFRAME', 2);
    io.RC('DGNFRAME', 0);
    io.B('unknown22', 0);
    io.CMC('INTERFERECOLOR', { index: 1, rgb: null });
    io.H('INTERFEREOBJVS', 0);
    io.H('INTERFEREVPVS', 0);
    io.H('DRAGVS', 0);
    io.RC('CSHADOW', 0);
    io.BD('unknown23', 0);
  }
  if (v >= R14) {
    io.BS('unknown24', 0);
    io.BS('unknown25', 0);
    io.BS('unknown26', 0);
    io.BS('unknown27', 0);
  }
  void R13;
  void R2018;
}

function hasSentinel(u8, at, s) {
  for (let i = 0; i < 16; i++) if (u8[at + i] !== s[i]) return false;
  return true;
}

/**
 * Start position and stream boundaries of a sentinel-framed section
 * (header or classes): { data, strings, handles, endBits }.
 */
export function sectionStreams(u8, ver, maint, sentinel) {
  if (!hasSentinel(u8, 0, sentinel)) throw new Error('Damaged DWG section: sentinel missing.');
  const r = new BitReader(u8, ver, 16 * 8);
  const size = r.RL();
  let endBits = 160;
  if (ver >= R2010 && maint > 3) {
    r.RL();
    endBits += 32;
  }
  const dataEnd = Math.min(u8.length * 8, (20 + size) * 8 + (endBits - 160));
  if (ver < R2007) {
    r.end = dataEnd;
    return { data: r, strings: null, handles: null, size };
  }
  const bitsize = r.RL();
  endBits += bitsize;
  const handles = r.fork(endBits, dataEnd);
  const strings = stringStream(r, endBits);
  r.end = endBits;
  return { data: r, strings, handles, size };
}

/**
 * Locate the R2007+ string stream that ends at `endBits`. Returns a reader
 * positioned at its start, or null when the object has no strings.
 */
export function stringStream(r, endBits) {
  const s = r.fork(endBits - 1, endBits);
  if (!s.B()) return null;
  let p = endBits - 1 - 16;
  s.pos = p;
  s.end = p + 16;
  let size = s.RS();
  if (size & 0x8000) {
    p -= 16;
    s.pos = p;
    s.end = p + 16;
    const hi = s.RS();
    size = (size & 0x7fff) | (hi << 15);
  }
  const start = p - size;
  return r.fork(start, p);
}

/** Read the header variables. Returns the values by name. */
export function readHeader(u8, ver, maint, decoder) {
  const st = sectionStreams(u8, ver, maint, SENTINEL_HEADER);
  st.data.decoder = decoder;
  const io = new SpecReader(st.data, st.strings, st.handles, 0);
  if (st.strings) st.strings.decoder = decoder;
  headerSpec(io);
  return io.o;
}

export { crc16 };
