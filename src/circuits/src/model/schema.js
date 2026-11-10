// Data model reference. All lengths are integer nanometres (see core/units.js),
// angles are degrees counter-clockwise, and +y points up.
//
// A project file (.circuits) is JSON:
//
// {
//   format: 'circuits-project', version: 1,
//   id, name, created, modified,               // ISO timestamps
//   settings: { units: 'mm' | 'mil' },
//   library: { [componentId]: ComponentDef },  // definitions used by this project
//   documents: [SchematicDoc | BoardDoc],
// }
//
// Projects embed every component definition they use, so a project opens the
// same way on any machine, and editing the library never silently changes a
// finished board.

export const FORMAT = 'circuits-project';
export const FORMAT_VERSION = 1;
export const LIBRARY_FORMAT = 'circuits-library';

/**
 * @typedef {object} ComponentDef
 * @property {string} id            stable id, unique within a library
 * @property {string} name          'Resistor'
 * @property {string} [description]
 * @property {string} [category]    'Passives', 'Diodes', ...
 * @property {string} prefix        designator prefix: 'R', 'C', 'U'
 * @property {string} [value]       default value shown on the sheet: '10k'
 * @property {Record<string,string>} [params] free-form parameters (Manufacturer, MPN, Tolerance...)
 * @property {string[]} [keywords]
 * @property {Symbol} symbol
 * @property {Footprint|null} footprint
 * @property {Record<string,string>} [pinMap] symbol pin number -> footprint pad number (default: identical)
 */

/**
 * Schematic symbol in local coordinates (the origin is the placement point).
 * @typedef {object} Symbol
 * @property {Pin[]} pins
 * @property {Graphic[]} graphics
 * @property {{x:number,y:number}} [designatorPos]  label anchor (left-baseline)
 * @property {{x:number,y:number}} [valuePos]
 */

/**
 * A pin. (x, y) is the electrical end, where wires connect. The pin line runs
 * from there for `length` in direction `rot` (0 = +x, 90 = +y, ...) toward the
 * body. A pin on the left side of a body therefore has rot 0.
 * @typedef {object} Pin
 * @property {string} num            '1', 'A3'
 * @property {string} name           'VCC', '~RESET' (a leading ~ draws an overbar)
 * @property {number} x
 * @property {number} y
 * @property {number} length
 * @property {0|90|180|270} rot
 * @property {PinType} type
 * @property {boolean} [hideName]
 * @property {boolean} [hideNum]
 * @property {boolean} [hidden]      hidden power pin; joins the net named by `name`
 * @property {'none'|'dot'|'clock'|'dotclock'} [shape]
 */

/** @typedef {'passive'|'input'|'output'|'bidir'|'power'|'opencollector'|'openemitter'|'tristate'|'nc'} PinType */
export const PIN_TYPES = ['passive', 'input', 'output', 'bidir', 'tristate', 'opencollector', 'openemitter', 'power', 'nc'];
export const PIN_TYPE_LABELS = {
  passive: 'Passive', input: 'Input', output: 'Output', bidir: 'I/O', tristate: 'Tri-state',
  opencollector: 'Open collector', openemitter: 'Open emitter', power: 'Power', nc: 'Not connected',
};

/**
 * Drawing primitives, shared by symbols, footprints and sheets.
 * Footprint graphics also carry `layer` (local layer id: 'topOverlay', 'mech1',
 * 'courtyard', 'top' for copper artwork, ...). Widths are stroke widths; w: 0
 * means the standard line for the context. `fill` is true or 'solid' (filled
 * with the stroke color) or 'body' (filled with the theme's symbol body color).
 * @typedef {(
 *   {t:'line', x1:number,y1:number,x2:number,y2:number, w:number, layer?:string} |
 *   {t:'polyline', pts:number[], w:number, layer?:string} |
 *   {t:'rect', x1:number,y1:number,x2:number,y2:number, w:number, fill?:boolean, layer?:string} |
 *   {t:'circle', cx:number,cy:number,r:number, w:number, fill?:boolean, layer?:string} |
 *   {t:'arc', cx:number,cy:number,r:number, a0:number, sweep:number, w:number, layer?:string} |
 *   {t:'poly', pts:number[], w:number, fill?:boolean, layer?:string} |
 *   {t:'text', x:number,y:number, text:string, size:number, rot?:number, align?:TextAlign, layer?:string}
 * )} Graphic
 */

/** @typedef {'left'|'center'|'right'} HAlign */
/** @typedef {{h?:HAlign, v?:'bottom'|'middle'|'top'}} TextAlign */

/**
 * Footprint in local coordinates, top side view.
 * @typedef {object} Footprint
 * @property {string} name          '0603', 'SOIC-8'
 * @property {string} [description]
 * @property {Pad[]} pads
 * @property {Graphic[]} graphics   silkscreen (topOverlay), assembly (mech1), courtyard...
 * @property {{x1:number,y1:number,x2:number,y2:number}} [courtyard]
 * @property {{w:number, h:number, height:number, color?:string, shape?:'box'|'cylinder', x?:number, y?:number}} [body]  3D body
 */

/**
 * @typedef {object} Pad
 * @property {string} num
 * @property {number} x
 * @property {number} y
 * @property {'round'|'rect'|'roundrect'|'oval'} shape   round uses w only; oval is a stadium
 * @property {number} w
 * @property {number} h
 * @property {number} [rot]
 * @property {number} [radius]       corner radius ratio for roundrect, 0..0.5 of min(w,h)
 * @property {'top'|'bottom'|'thru'} side   thru = plated or unplated through-hole
 * @property {number} [drill]        hole diameter (thru pads)
 * @property {boolean} [plated]      default true
 * @property {number} [maskExpansion] default from rules
 * @property {boolean} [noPaste]
 */

/**
 * Schematic document. One project may have several sheets; nets join across
 * sheets through net labels, power ports and ports with the same name.
 * @typedef {object} SchematicDoc
 * @property {string} id
 * @property {'sch'} kind
 * @property {string} name          'Main.sch'
 * @property {{size:SheetSize, orientation:'landscape'|'portrait', title?:string, revision?:string, author?:string, company?:string, showBorder?:boolean, showTitleBlock?:boolean}} sheet
 * @property {SchObject[]} objects
 */

/** @typedef {'A4'|'A3'|'A2'|'A1'|'A0'|'A'|'B'|'C'|'D'|'E'|'Letter'} SheetSize */

/**
 * @typedef {(
 *   {id:string, t:'part', comp:string, x:number,y:number, rot:0|90|180|270, mirror?:boolean, designator:string, value?:string, params?:Record<string,string>, footprint?:string, uid:string, fields?:{designator?:Field, value?:Field}, dnp?:boolean} |
 *   {id:string, t:'wire', pts:number[]} |
 *   {id:string, t:'bus', pts:number[]} |
 *   {id:string, t:'junction', x:number,y:number} |
 *   {id:string, t:'label', x:number,y:number, rot:0|90|180|270, text:string} |
 *   {id:string, t:'power', x:number,y:number, rot:0|90|180|270, net:string, style:PowerStyle} |
 *   {id:string, t:'port', x:number,y:number, rot:0|90|180|270, name:string, io:'in'|'out'|'bidir'|'unspec'} |
 *   {id:string, t:'noerc', x:number,y:number} |
 *   {id:string, t:'text', x:number,y:number, rot?:number, text:string, size:number} |
 *   {id:string, t:'gline', pts:number[], w:number} |
 *   {id:string, t:'grect', x1:number,y1:number,x2:number,y2:number, w:number, fill?:boolean} |
 *   {id:string, t:'gcircle', cx:number,cy:number,r:number, w:number, fill?:boolean}
 * )} SchObject
 */

/**
 * Field placement relative to the part origin, in sheet orientation (it does
 * not rotate with the part, so labels stay readable). align is the text
 * alignment, default left/bottom.
 * @typedef {{dx:number, dy:number, hidden?:boolean, align?:{h?:'left'|'center'|'right', v?:'bottom'|'middle'|'top'}}} Field
 */

/** @typedef {'gnd'|'signalgnd'|'earth'|'bar'|'arrow'|'circle'|'wave'} PowerStyle */
export const POWER_STYLES = ['bar', 'arrow', 'circle', 'wave', 'gnd', 'signalgnd', 'earth'];
export const GROUND_STYLES = new Set(['gnd', 'signalgnd', 'earth']);

/**
 * Board document.
 * @typedef {object} BoardDoc
 * @property {string} id
 * @property {'pcb'} kind
 * @property {string} name          'Board.pcb'
 * @property {Board} board
 * @property {Rules} rules
 * @property {Record<string,{class?:string}>} nets   known nets (from the schematic)
 * @property {PcbObject[]} objects
 */

/**
 * @typedef {object} Board
 * @property {number[]} outline      closed polygon, flat [x0,y0,x1,y1,...], counter-clockwise
 * @property {number[][]} [cutouts]  internal holes in the board
 * @property {{x:number,y:number}} origin   user origin for coordinates and exports
 * @property {2|4|6} copper           copper layer count
 * @property {number} thickness       board thickness (nm)
 * @property {string} [maskColor]     3D view: '#1d6b3a'
 * @property {string} [silkColor]
 * @property {string} [finish]        'HASL', 'ENIG'
 */

/**
 * Design rules. A net class overrides width and clearance for its nets.
 * @typedef {object} Rules
 * @property {number} clearance          copper to copper
 * @property {number} trackWidth         preferred width for new tracks
 * @property {number} minTrackWidth
 * @property {number} viaDiameter
 * @property {number} viaDrill
 * @property {number} minDrill
 * @property {number} minAnnularRing
 * @property {number} edgeClearance      copper to board edge
 * @property {number} maskExpansion      solder mask opening growth around pads
 * @property {number} pasteExpansion     (negative shrinks)
 * @property {number} silkWidth          default silkscreen stroke
 * @property {number} pourClearance      default clearance for new pours
 * @property {{spoke:number, gap:number, count:number}} thermal   pour connections to pads
 * @property {Record<string,{width:number, clearance:number, viaDiameter?:number, viaDrill?:number, nets:string[]}>} netClasses
 */

/**
 * @typedef {(
 *   {id:string, t:'comp', comp:string, x:number,y:number, rot:number, side:'top'|'bottom', designator:string, value?:string, uid:string, padNets:Record<string,string>, locked?:boolean, fields?:{designator?:PcbField, value?:PcbField}} |
 *   {id:string, t:'track', layer:string, x1:number,y1:number,x2:number,y2:number, w:number, net?:string} |
 *   {id:string, t:'arc', layer:string, cx:number,cy:number, r:number, a0:number, sweep:number, w:number, net?:string} |
 *   {id:string, t:'via', x:number,y:number, d:number, drill:number, from:string, to:string, net?:string} |
 *   {id:string, t:'pad', x:number,y:number, shape:string, w:number,h:number, rot?:number, side:'top'|'bottom'|'thru', drill?:number, plated?:boolean, num?:string, net?:string} |
 *   {id:string, t:'fill', layer:string, x1:number,y1:number,x2:number,y2:number, net?:string} |
 *   {id:string, t:'pour', layer:string, pts:number[], net?:string, clearance:number, minWidth?:number, removeIslands?:boolean, thermals?:boolean, priority?:number, name?:string} |
 *   {id:string, t:'region', layer:string, pts:number[], net?:string} |
 *   {id:string, t:'text', layer:string, x:number,y:number, text:string, h:number, w:number, rot?:number, mirror?:boolean} |
 *   {id:string, t:'dim', layer:string, x1:number,y1:number,x2:number,y2:number, offset:number, h:number}
 * )} PcbObject
 *
 * Non-copper drawing on any layer (silkscreen lines, mechanical outlines) uses
 * 'track' and 'arc' without a net. A 'region' on 'keepout' blocks copper.
 * Pour fill shapes are derived data and are not saved (see kernel/).
 */

/** @typedef {{dx:number, dy:number, rot?:number, h?:number, hidden?:boolean}} PcbField */

export function defaultRules() {
  return {
    clearance: 200_000,
    trackWidth: 250_000,
    minTrackWidth: 150_000,
    viaDiameter: 600_000,
    viaDrill: 300_000,
    minDrill: 200_000,
    minAnnularRing: 125_000,
    edgeClearance: 300_000,
    maskExpansion: 50_000,
    pasteExpansion: 0,
    silkWidth: 150_000,
    pourClearance: 300_000,
    thermal: { spoke: 300_000, gap: 250_000, count: 4 },
    netClasses: {
      Power: { width: 500_000, clearance: 250_000, nets: [] },
    },
  };
}
