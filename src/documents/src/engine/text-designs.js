// Insert → Text Box, WordArt and Signature Line: original designs written as WordprocessingML
// shapes with text (`wps:wsp` with `wps:txbx`, ECMA-376 Part 1 §20.4 and the wordprocessingShape
// extension) whose paragraphs carry ordinary run properties and, for WordArt, the w14 text effects
// (textOutline, textFill, shadow) the engine reads and paints in drawing text.
import { shapeDrawingXml, EMU_PER_INCH } from './authored-shapes.js';
import { xmlEscape } from './inserted-drawings.js';

const W14 = 'http://schemas.microsoft.com/office/word/2010/wordml';
const ACCENT = '2F5597', DARK = '1F3864';
const BODY = (anchor = 't', fit = false, insets = [91440, 45720]) => `<wps:bodyPr rot="0" vert="horz" wrap="square" lIns="${insets[0]}" tIns="${insets[1]}" rIns="${insets[0]}" bIns="${insets[1]}" anchor="${anchor}" anchorCtr="0">${fit ? '<a:spAutoFit/>' : '<a:noAutofit/>'}</wps:bodyPr>`;

/** w:rPr XML from a small run description: { bold, italic, size (pt), color, font, caps, outline: { width, color }, fill, shadow: { color, alpha } }. */
export function runPropertiesXml(run = {}) {
  let xml = '';
  if (run.font) xml += `<w:rFonts w:ascii="${xmlEscape(run.font)}" w:hAnsi="${xmlEscape(run.font)}"/>`;
  if (run.bold) xml += '<w:b/>';
  if (run.italic) xml += '<w:i/>';
  if (run.caps) xml += '<w:caps/>';
  if (run.color) xml += `<w:color w:val="${run.color}"/>`;
  if (run.spacing) xml += `<w:spacing w:val="${Math.round(run.spacing * 20)}"/>`;
  if (run.size) xml += `<w:sz w:val="${Math.round(run.size * 2)}"/><w:szCs w:val="${Math.round(run.size * 2)}"/>`;
  if (run.underline) xml += '<w:u w:val="single"/>';
  // w14 effects follow the w: elements of CT_RPr (MS-DOCX §2.6): shadow, textOutline, textFill.
  if (run.shadow) xml += `<w14:shadow w14:blurRad="38100" w14:dist="${run.shadow.distance ?? 38100}" w14:dir="2700000" w14:sx="100000" w14:sy="100000" w14:kx="0" w14:ky="0" w14:algn="tl"><w14:srgbClr w14:val="${run.shadow.color || '000000'}"><w14:alpha w14:val="${Math.round((1 - (run.shadow.alpha ?? 0.6)) * 100000)}"/></w14:srgbClr></w14:shadow>`;
  if (run.outline) xml += `<w14:textOutline w14:w="${run.outline.width}" w14:cap="flat" w14:cmpd="sng" w14:algn="ctr"><w14:solidFill><w14:srgbClr w14:val="${run.outline.color}"/></w14:solidFill><w14:prstDash w14:val="solid"/><w14:round/></w14:textOutline>`;
  if (run.fill) xml += `<w14:textFill>${run.fill === 'none' ? '<w14:noFill/>' : `<w14:solidFill><w14:srgbClr w14:val="${run.fill}"/></w14:solidFill>`}</w14:textFill>`;
  return xml ? `<w:rPr>${xml}</w:rPr>` : '';
}
/** A w:p from { text, align, run, spaceAfter (pt), border: { side, color, size } (body paragraphs only), tabs }. Lines in text become line breaks. */
export function paragraphXml({ text = '', align = null, run = {}, spaceAfter = null, spaceBefore = null, border = null, tabs = null }) {
  const pPr = [
    border ? `<w:pBdr><w:${border.side} w:val="single" w:sz="${border.size || 8}" w:space="${border.space ?? 1}" w:color="${border.color || '000000'}"/></w:pBdr>` : '',
    tabs ? `<w:tabs>${tabs.map(t => `<w:tab w:val="${t.alignment}" w:pos="${t.position}"/>`).join('')}</w:tabs>` : '',
    spaceAfter !== null || spaceBefore !== null ? `<w:spacing${spaceBefore !== null ? ` w:before="${spaceBefore * 20}"` : ''}${spaceAfter !== null ? ` w:after="${spaceAfter * 20}"` : ''}/>` : '',
    align ? `<w:jc w:val="${align}"/>` : '',
  ].join('');
  const rPr = runPropertiesXml(run);
  const runs = String(text).split('\n').map((line, i) => `<w:r>${rPr}${i ? '<w:br/>' : ''}${line.split('\t').map((part, j) => `${j ? '<w:tab/>' : ''}${part ? `<w:t xml:space="preserve">${xmlEscape(part)}</w:t>` : ''}`).join('')}</w:r>`).join('');
  return `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ''}${runs}</w:p>`;
}

// Each design's sample text, shown until the box is given text of its own.
const PROMPTS = Object.freeze({
  simple: 'Type your text here. Text boxes can sit anywhere on the page.',
  sidebar: 'Use a sidebar for notes, a summary or a list of key points beside the main text.',
  quote: 'Draw the reader in with a memorable line from the document.',
  banded: 'An announcement or heading across the page',
  note: 'Add a short note here.',
  callout: 'Point out something important.',
});
export const WORDART_PROMPT = 'Your text here';

/** Text box gallery: [id, name, hint, prompt, build(text) → shape params]. Sizes in inches; placement in the column. */
export const TEXT_BOX_DESIGNS = Object.freeze([
  { id: 'simple', name: 'Simple Text Box', hint: 'A plain box with a thin outline', width: 2.5, height: 1.2,
    shape: { fill: 'FFFFFF', line: '000000', lineWidth: 6350 },
    prompt: PROMPTS.simple,
    paragraphs: text => [paragraphXml({ text: text || PROMPTS.simple })] },
  { id: 'sidebar', name: 'Sidebar', hint: 'A tall shaded panel at the right', width: 2, height: 4.5, align: 'right',
    shape: { fill: 'DEEAF6', line: null, lineWidth: 0 },
    prompt: PROMPTS.sidebar,
    paragraphs: text => [paragraphXml({ text: 'Sidebar Title', run: { bold: true, size: 14, color: DARK }, spaceAfter: 6 }),
      paragraphXml({ text: text || PROMPTS.sidebar, run: { size: 10, color: '262626' } })] },
  { id: 'quote', name: 'Pull Quote', hint: 'A large centered quotation in an accent frame', width: 4.5, height: 1.3, align: 'center',
    shape: { fill: null, line: ACCENT, lineWidth: 28575 }, anchor: 'ctr',
    prompt: PROMPTS.quote,
    paragraphs: text => [paragraphXml({ text: `“${text || PROMPTS.quote}”`, align: 'center', run: { italic: true, size: 16, color: ACCENT }, spaceAfter: 4 }),
      paragraphXml({ text: '— Name', align: 'right', run: { size: 10, color: '595959' } })] },
  { id: 'banded', name: 'Banded', hint: 'White text on a dark band', width: 6.5, height: 0.8,
    shape: { fill: DARK, line: null, lineWidth: 0 }, anchor: 'ctr',
    prompt: PROMPTS.banded,
    paragraphs: text => [paragraphXml({ text: text || PROMPTS.banded, align: 'center', run: { bold: true, size: 16, color: 'FFFFFF' } })] },
  { id: 'note', name: 'Note', hint: 'A soft yellow note with an accent outline', width: 2.5, height: 1.5,
    shape: { fill: 'FFF2CC', line: 'BF9000', lineWidth: 9525 },
    prompt: PROMPTS.note,
    paragraphs: text => [paragraphXml({ text: 'Note', run: { bold: true, color: '7F6000' }, spaceAfter: 3 }), paragraphXml({ text: text || PROMPTS.note, run: { size: 10, color: '3F3F3F' } })] },
  { id: 'callout', name: 'Rounded Callout', hint: 'A rounded box with an accent fill', width: 2.75, height: 1.25, preset: 'roundRect',
    shape: { fill: ACCENT, line: null, lineWidth: 0 }, anchor: 'ctr',
    prompt: PROMPTS.callout,
    paragraphs: text => [paragraphXml({ text: text || PROMPTS.callout, align: 'center', run: { size: 12, color: 'FFFFFF' } })] },
]);

/** WordArt styles: original combinations of fill, outline and shadow over a bold display face. */
export const WORDART_STYLES = Object.freeze([
  { id: 'fillBlack', name: 'Fill: Black', run: { color: '000000' } },
  { id: 'fillBlue', name: 'Fill: Blue, Shadow', run: { color: ACCENT, shadow: { color: '000000', alpha: 0.4 } } },
  { id: 'outlineBlue', name: 'Outline: Blue', run: { color: 'FFFFFF', fill: 'none', outline: { width: 12700, color: ACCENT } } },
  { id: 'whiteOutline', name: 'Fill: White, Outline: Blue', run: { color: 'FFFFFF', fill: 'FFFFFF', outline: { width: 19050, color: ACCENT }, shadow: { color: '000000', alpha: 0.35 } } },
  { id: 'orange', name: 'Fill: Orange, Outline: Dark', run: { color: 'ED7D31', fill: 'ED7D31', outline: { width: 9525, color: '7F3F00' } } },
  { id: 'gold', name: 'Fill: Gold, Shadow', run: { color: 'BF9000', fill: 'FFC000', outline: { width: 6350, color: '7F6000' }, shadow: { color: '7F6000', alpha: 0.5 } } },
  { id: 'green', name: 'Fill: Green', run: { color: '548235', fill: '70AD47' } },
  { id: 'red', name: 'Fill: Red, Outline: White', run: { color: 'C00000', fill: 'C00000', outline: { width: 12700, color: 'FFFFFF' }, shadow: { color: '000000', alpha: 0.5 } } },
  { id: 'gray', name: 'Fill: Gray, Shadow', run: { color: '595959', fill: '7F7F7F', shadow: { color: '000000', alpha: 0.5, distance: 50800 } } },
  { id: 'purpleOutline', name: 'Outline: Purple', run: { color: 'FFFFFF', fill: 'none', outline: { width: 19050, color: '7030A0' } } },
  { id: 'navyCaps', name: 'Fill: Navy, Spaced Capitals', run: { color: DARK, caps: true, spacing: 3 } },
  { id: 'teal', name: 'Fill: Teal, Outline: Dark', run: { color: '1E6E6A', fill: '2E9E98', outline: { width: 9525, color: '0F3735' } } },
]);

/** Shape parameters for shapeDrawingXml from a text box design, at the given id and stacking order. */
export function textBoxParams(design, { id, order = 1, text = '', textWidth = 6.5 * EMU_PER_INCH, x = null, y = 0, width = null, height = null, anchor: placement = null } = {}) {
  const w = width ?? Math.round(design.width * EMU_PER_INCH), h = height ?? Math.round(design.height * EMU_PER_INCH);
  const left = x ?? (design.align === 'right' ? Math.max(0, textWidth - w) : design.align === 'center' ? Math.max(0, (textWidth - w) / 2) : 0);
  return { id, name: `Text Box ${id}`, preset: design.preset || 'rect', width: w, height: h, ...design.shape,
    anchor: placement || { horizontal: 'column', vertical: 'paragraph', x: Math.round(left), y: Math.round(y), wrap: 'square', behind: false, order },
    text: design.paragraphs(text).join(''), bodyXml: BODY(design.anchor || 't') };
}

/** Shape parameters for WordArt: an unfilled, unbordered box that grows to fit its large text. */
export function wordArtParams(style, { id, order = 1, text = WORDART_PROMPT, size = 40, textWidth = 6.5 * EMU_PER_INCH } = {}) {
  const lines = String(text || WORDART_PROMPT).split('\n');
  const longest = Math.max(...lines.map(l => [...l].length));
  const width = Math.min(textWidth, Math.max(EMU_PER_INCH, Math.round(longest * size * 0.62 / 72 * EMU_PER_INCH + 182880)));
  const height = Math.round(lines.length * size * 1.3 / 72 * EMU_PER_INCH + 91440);
  return { id, name: `WordArt ${id}`, preset: 'rect', width, height, fill: null, line: null, lineWidth: 0,
    anchor: { horizontal: 'column', vertical: 'paragraph', x: Math.max(0, Math.round((textWidth - width) / 2)), y: 0, wrap: 'topAndBottom', behind: false, order },
    text: paragraphXml({ text: lines.join('\n'), align: 'center', run: { bold: true, size, font: style.font, ...style.run } }), bodyXml: BODY('t', true) };
}

/** A signature line: an X over a rule, then the signer's name and title; instructions travel as alt text. */
export function signatureLineParams({ id, order = 1, signer = '', title = '', email = '', date = false } = {}) {
  const width = Math.round(3 * EMU_PER_INCH), rows = 1 + [signer, title, email].filter(Boolean).length + (date ? 1 : 0);
  // Text box paragraphs take no borders in this engine: the rule is a row of low lines after the X.
  const paragraphs = [paragraphXml({ text: `X${'\u005F'.repeat(34)}`, run: { size: 14, color: '404040' }, spaceAfter: 0, spaceBefore: 12 })];
  for (const line of [signer, title, email]) if (line) paragraphs.push(paragraphXml({ text: line, run: { size: 10, color: '262626' }, spaceAfter: 0 }));
  if (date) paragraphs.push(paragraphXml({ text: 'Date: ____________', run: { size: 10, color: '595959' }, spaceAfter: 0 }));
  const height = Math.round((0.55 + rows * 0.2) * EMU_PER_INCH);
  return { id, name: `Signature Line ${id}`, preset: 'rect', width, height, fill: null, line: null, lineWidth: 0,
    anchor: { horizontal: 'column', vertical: 'paragraph', x: 0, y: 0, wrap: 'topAndBottom', behind: false, order },
    text: paragraphs.join(''), bodyXml: BODY('t', false, [45720, 45720]) };
}

const MC = 'http://schemas.openxmlformats.org/markup-compatibility/2006';
/**
 * The w:drawing XML for these parameters. WordArt's w14 effects are an extension: the drawing declares
 * them ignorable (ECMA-376 Part 3 §10.2.1), so consumers without them keep the plain text.
 */
export function textShapeXml(params) {
  const xml = shapeDrawingXml(params);
  return /<w14:/.test(xml) ? xml.replace('<w:drawing ', `<w:drawing xmlns:mc="${MC}" xmlns:w14="${W14}" mc:Ignorable="w14" `) : xml;
}
