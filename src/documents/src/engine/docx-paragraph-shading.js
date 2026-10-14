import { UnsupportedDocumentError } from './errors.js';
import { checkedShading } from './backgrounds.js';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const percentages=new Map([5,10,12,15,20,25,30,35,37,40,45,50,55,60,62,65,70,75,80,85,87,90,95].map(n=>['pct'+n,2*n+([12,37,62,87].includes(n)?1:0)]));

// CT_Shd is an atomic declaration: omitted color channels mean auto, rather
// than inheriting individual attributes from a preceding shading declaration.
export function readParagraphShading(pPr, readColor) {
  const nodes = [...(pPr?.children || [])].filter(n => n.namespaceURI === W && n.localName === 'shd');
  if (!nodes.length) return undefined;
  if (nodes.length !== 1) throw new UnsupportedDocumentError('duplicate paragraph shading');
  if ([...nodes[0].childNodes].some(n => n.nodeType === 1 || [3, 4].includes(n.nodeType) && n.textContent.trim())) throw new UnsupportedDocumentError('paragraph shading with child content');
  const pattern = nodes[0].getAttributeNS(W, 'val');
  if (!['clear', 'solid', 'nil'].includes(pattern)&&!percentages.has(pattern)) throw new UnsupportedDocumentError('unsupported paragraph shading pattern');
  const fill = readColor(pPr, 'shd', 'fill'), color = readColor(pPr, 'shd', 'color');
  // [MS-OI29500] §2.1.553: nil declarations are ignored, retaining inheritance.
  if(pattern==='nil')return undefined;
  if(percentages.has(pattern)) return patternedFill(pattern, color, fill);
  return pattern === 'clear' ? fill : color === 'auto' ? 'foreground' : color;
}

/** The percentage patterns (§17.18.78 pct5–pct95) a flat fill can stand for. */
export const SHADING_PERCENTAGES = Object.freeze([...percentages.keys()]);
/**
 * A percentage pattern painted as flat sRGB. Automatic channels are black/white even on dark page/cell
 * backgrounds. A rounded signed channel delta is added to the background (half ties toward foreground).
 */
export function patternedFill(pattern, color, fill) {
  const weight=percentages.get(pattern),foreground=color==='auto'?'000000':color,background=fill==='auto'?'FFFFFF':fill;
  if (weight === undefined) throw new Error('Unsupported shading pattern.');
  return [0,2,4].map(i=>{
    const back=parseInt(background.slice(i,i+2),16),delta=parseInt(foreground.slice(i,i+2),16)-back;
    return (back+Math.sign(delta)*Math.floor((Math.abs(delta)*weight+100)/200)).toString(16).padStart(2,'0');
  }).join('').toUpperCase();
}

export function writeParagraphShading(node, value) {
  value = checkedShading(value);
  // An authored RGB/no-fill declaration replaces source theme and pattern
  // channels. Unrelated paragraph edits never call this writer.
  for (const attr of [...node.attributes]) if (attr.namespaceURI === W) node.removeAttributeNode(attr);
  node.setAttributeNS(W, 'w:val', value === 'foreground' ? 'solid' : 'clear');
  node.setAttributeNS(W, 'w:color', 'auto');
  node.setAttributeNS(W, 'w:fill', value === 'foreground' ? 'auto' : value);
}
