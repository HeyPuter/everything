/**
 * WordArt Styles for the text of a shape: text fill, text outline and text shadow on every run of the
 * shape's text box (`w:txbxContent`). Written as run properties: w:color (§17.3.2.6) for every reader,
 * and the w14 text effects (textFill, textOutline, shadow; MS-DOCX §2.6) that the drawing-text reader
 * paints. Elements are kept in CT_RPr order; other run properties stay as they are.
 */
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const W14 = 'http://schemas.microsoft.com/office/word/2010/wordml';
const XMLNS = 'http://www.w3.org/2000/xmlns/';
const ORDER = ['rStyle', 'rFonts', 'b', 'bCs', 'i', 'iCs', 'caps', 'smallCaps', 'strike', 'dstrike', 'outline', 'shadow', 'emboss', 'imprint', 'noProof', 'snapToGrid', 'vanish', 'webHidden', 'color', 'spacing', 'w', 'kern', 'position', 'sz', 'szCs', 'highlight', 'u', 'effect', 'bdr', 'shd', 'fitText', 'vertAlign', 'rtl', 'cs', 'em', 'lang', 'eastAsianLayout', 'specVanish', 'oMath'];
const ORDER14 = ['glow', 'shadow', 'reflection', 'textOutline', 'textFill', 'scene3d', 'props3d', 'ligatures', 'numForm', 'numSpacing', 'stylisticSets', 'cntxtAlts'];
const rank = node => node.namespaceURI === W ? (node.localName === 'rPrChange' ? 1000 : ORDER.indexOf(node.localName)) : node.namespaceURI === W14 ? 100 + ORDER14.indexOf(node.localName) : 500;

const MC = 'http://schemas.openxmlformats.org/markup-compatibility/2006';
// Whether the w14 namespace is already ignorable here (declared on this element or an ancestor).
const ignorable = node => {
  for (let at = node; at?.nodeType === 1; at = at.parentNode) if ((at.getAttributeNS(MC, 'Ignorable') || '').split(/\s+/).some(prefix => prefix && at.lookupNamespaceURI(prefix) === W14)) return true;
  return false;
};

function place(rPr, node) {
  const after = [...rPr.children].find(c => rank(c) > rank(node));
  rPr.insertBefore(node, after || null);
}
const w14 = (doc, name, attrs = {}) => {
  const node = doc.createElementNS(W14, `w14:${name}`);
  for (const [key, value] of Object.entries(attrs)) node.setAttributeNS(W14, `w14:${key}`, String(value));
  return node;
};
const solid = (doc, rgb, alpha) => {
  const fill = w14(doc, 'solidFill'), color = w14(doc, 'srgbClr', { val: rgb });
  if (alpha !== undefined && alpha < 1) color.append(w14(doc, 'alpha', { val: Math.round((1 - alpha) * 100000) }));
  fill.append(color); return fill;
};

/** patch: { color?: 'RRGGBB', fill?: 'RRGGBB' | 'none' | 'none-reset', outline?: { color?, width? } | 'none', shadow?: { distance, direction, blur, alpha, color? } | 'none' } */
export function setTextRunEffects(content, patch) {
  const doc = content.ownerDocument;
  const runs = [...content.getElementsByTagNameNS(W, 'r')];
  if (!runs.length) throw new Error('The shape has no text to format.');
  // The w14 prefix must be declared where the effects are written, and declared ignorable (ECMA-376
  // Part 3 §10.2.1) so consumers without the extension keep the plain text instead of rejecting it.
  if (!content.lookupNamespaceURI('w14')) content.setAttributeNS(XMLNS, 'xmlns:w14', W14);
  if (!ignorable(content)) {
    if (!content.lookupNamespaceURI('mc')) content.setAttributeNS(XMLNS, 'xmlns:mc', MC);
    const prefixes = new Set((content.getAttributeNS(MC, 'Ignorable') || '').split(/\s+/).filter(Boolean));
    prefixes.add(content.lookupPrefix(W14) || 'w14'); content.setAttributeNS(MC, `${content.lookupPrefix(MC) || 'mc'}:Ignorable`, [...prefixes].join(' '));
  }
  for (const run of runs) {
    let rPr = [...run.children].find(c => c.namespaceURI === W && c.localName === 'rPr');
    if (!rPr) { rPr = doc.createElementNS(W, 'w:rPr'); run.insertBefore(rPr, run.firstChild); }
    const remove = (ns, name) => { for (const node of [...rPr.children].filter(c => c.namespaceURI === ns && c.localName === name)) node.remove(); };
    const color = patch.color || (patch.fill && !['none', 'none-reset'].includes(patch.fill) ? patch.fill : null);
    if (color) { remove(W, 'color'); const node = doc.createElementNS(W, 'w:color'); node.setAttributeNS(W, 'w:val', color); place(rPr, node); }
    if (patch.fill !== undefined) {
      remove(W14, 'textFill');
      if (patch.fill === 'none') { const node = w14(doc, 'textFill'); node.append(w14(doc, 'noFill')); place(rPr, node); }
      else if (patch.fill !== 'none-reset') { const node = w14(doc, 'textFill'); node.append(solid(doc, patch.fill)); place(rPr, node); }
    }
    if (patch.outline !== undefined) {
      const old = [...rPr.children].find(c => c.namespaceURI === W14 && c.localName === 'textOutline');
      const oldColor = old?.getElementsByTagNameNS(W14, 'srgbClr')[0]?.getAttributeNS(W14, 'val');
      const oldWidth = old?.getAttributeNS(W14, 'w');
      remove(W14, 'textOutline');
      if (patch.outline !== 'none') {
        const node = w14(doc, 'textOutline', { w: Math.round(patch.outline.width ?? Number(oldWidth || 9525)), cap: 'flat', cmpd: 'sng', algn: 'ctr' });
        node.append(solid(doc, patch.outline.color || oldColor || '000000'), w14(doc, 'prstDash', { val: 'solid' }), w14(doc, 'round'));
        place(rPr, node);
      }
    }
    if (patch.shadow !== undefined) {
      remove(W14, 'shadow');
      if (patch.shadow !== 'none') {
        const s = patch.shadow;
        const node = w14(doc, 'shadow', { blurRad: Math.round(s.blur ?? 38100), dist: Math.round(s.distance ?? 38100), dir: Math.round(((s.direction ?? 45) % 360 + 360) % 360 * 60000), sx: 100000, sy: 100000, kx: 0, ky: 0, algn: 'tl' });
        node.append(w14(doc, 'srgbClr', { val: s.color || '000000' }));
        node.firstChild.append(w14(doc, 'alpha', { val: Math.round((1 - (s.alpha ?? 0.4)) * 100000) }));
        place(rPr, node);
      }
    }
    if (!rPr.children.length) rPr.remove();
  }
}
