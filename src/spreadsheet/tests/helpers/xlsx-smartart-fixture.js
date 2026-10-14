import * as X from '../../src/vendor/xlsx.mjs';
import { otherProgramsXlsx } from './xlsx-fixture.js';

/**
 * An .xlsx holding a diagram as another program saves one: a graphic frame pointing at its diagram parts
 * (data, layout) and at the shapes that program drew for it (a dsp:drawing part), in a two-cell anchor.
 * `drawn: false` leaves the drawn shapes out, as some writers do.
 */
export function foreignDiagramXlsx({ drawn = true, layout = 'urn:microsoft.com/office/officeart/2005/8/layout/process1' } = {}) {
  const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const rels = (body) => `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${body}</Relationships>`;
  const bytes = otherProgramsXlsx({ sheetNames: ['Diagram'], sheetXml: { Diagram: { rows: '<row r="1"><c r="A1" t="inlineStr"><is><t>Plan</t></is></c></row>', tail: '<drawing r:id="rIdD"/>' } } });
  const zip = X.CFB.read(new Uint8Array(bytes), { type: 'array' });
  const add = (part, xml) => X.CFB.utils.cfb_add(zip, part, new TextEncoder().encode(xml));
  add('xl/worksheets/_rels/sheet1.xml.rels', rels(`<Relationship Id="rIdD" Type="${R}/drawing" Target="../drawings/drawing1.xml"/>`));
  add('xl/drawings/drawing1.xml', `<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="${R}">`
    + '<xdr:twoCellAnchor><xdr:from><xdr:col>1</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>2</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>'
    + '<xdr:to><xdr:col>7</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>14</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>'
    + '<xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="2" name="Diagram 1" descr="How we ship"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr>'
    + '<xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/diagram">'
    + '<dgm:relIds xmlns:dgm="http://schemas.openxmlformats.org/drawingml/2006/diagram" r:dm="rId1" r:lo="rId2" r:qs="rId3" r:cs="rId4"/></a:graphicData></a:graphic></xdr:graphicFrame>'
    + '<xdr:clientData/></xdr:twoCellAnchor></xdr:wsDr>');
  add('xl/drawings/_rels/drawing1.xml.rels', rels(`<Relationship Id="rId1" Type="${R}/diagramData" Target="../diagrams/data1.xml"/>`
    + `<Relationship Id="rId2" Type="${R}/diagramLayout" Target="../diagrams/layout1.xml"/>`
    + (drawn ? '<Relationship Id="rId6" Type="http://schemas.microsoft.com/office/2007/relationships/diagramDrawing" Target="../diagrams/drawing1.xml"/>' : '')));
  const pt = (id, text, type = '') => `<dgm:pt modelId="${id}"${type ? ` type="${type}"` : ''}><dgm:prSet/><dgm:spPr/>${text == null ? '' : `<dgm:t><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US"/><a:t>${text}</a:t></a:r></a:p></dgm:t>`}</dgm:pt>`;
  const cxn = (id, src, dest, ord, type = '') => `<dgm:cxn modelId="${id}"${type ? ` type="${type}"` : ''} srcId="${src}" destId="${dest}" srcOrd="${ord}" destOrd="0"/>`;
  add('xl/diagrams/data1.xml', '<dgm:dataModel xmlns:dgm="http://schemas.openxmlformats.org/drawingml/2006/diagram" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><dgm:ptLst>'
    + `<dgm:pt modelId="{D}" type="doc"><dgm:prSet loTypeId="${layout}"/><dgm:spPr/></dgm:pt>`
    + pt('{A}', 'Design') + pt('{B}', 'Sketches') + pt('{C}', 'Build') + pt('{E}', 'Ship') + pt('{P1}', null, 'pres') + pt('{S1}', null, 'sibTrans')
    + '</dgm:ptLst><dgm:cxnLst>' + cxn('{X1}', '{D}', '{A}', 0) + cxn('{X2}', '{A}', '{B}', 0) + cxn('{X3}', '{D}', '{C}', 1) + cxn('{X4}', '{D}', '{E}', 2)
    + cxn('{X5}', '{A}', '{P1}', 0, 'presOf') + '</dgm:cxnLst><dgm:bg/><dgm:whole/>'
    + '<dgm:extLst><a:ext uri="http://schemas.microsoft.com/office/drawing/2008/diagram"><dsp:dataModelExt xmlns:dsp="http://schemas.microsoft.com/office/drawing/2008/diagram" relId="rId6" minVer="http://schemas.openxmlformats.org/drawingml/2006/diagram"/></a:ext></dgm:extLst>'
    + '</dgm:dataModel>');
  add('xl/diagrams/layout1.xml', `<dgm:layoutDef xmlns:dgm="http://schemas.openxmlformats.org/drawingml/2006/diagram" uniqueId="${layout}"/>`);
  const sp = (id, x, text, color) => `<dsp:sp modelId="${id}"><dsp:nvSpPr><dsp:cNvPr id="0" name=""/><dsp:cNvSpPr/></dsp:nvSpPr><dsp:spPr><a:xfrm><a:off x="${x}" y="1000000"/><a:ext cx="1500000" cy="900000"/></a:xfrm>`
    + `<a:prstGeom prst="roundRect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="${color}"/></a:solidFill><a:ln><a:noFill/></a:ln></dsp:spPr>`
    + `<dsp:txBody><a:bodyPr anchor="ctr"/><a:lstStyle/><a:p><a:pPr algn="ctr"/><a:r><a:rPr lang="en-US" sz="1800"><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></a:rPr><a:t>${text}</a:t></a:r></a:p></dsp:txBody>`
    + `<dsp:txXfrm><a:off x="${x}" y="1000000"/><a:ext cx="1500000" cy="900000"/></dsp:txXfrm></dsp:sp>`;
  if (drawn) add('xl/diagrams/drawing1.xml', '<dsp:drawing xmlns:dsp="http://schemas.microsoft.com/office/drawing/2008/diagram" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><dsp:spTree>'
    + '<dsp:nvGrpSpPr><dsp:cNvPr id="0" name=""/><dsp:cNvGrpSpPr/></dsp:nvGrpSpPr><dsp:grpSpPr/>'
    + sp('{A}', 100000, 'Design', 'C0504D') + sp('{C}', 1900000, 'Build', '9BBB59') + sp('{E}', 3700000, 'Ship', '4F81BD') + '</dsp:spTree></dsp:drawing>');
  const types = X.CFB.find(zip, '/[Content_Types].xml');
  types.content = new TextEncoder().encode(new TextDecoder().decode(types.content).replace('</Types>',
    '<Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>'
    + '<Override PartName="/xl/diagrams/data1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.diagramData+xml"/>'
    + '<Override PartName="/xl/diagrams/layout1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.diagramLayout+xml"/>'
    + (drawn ? '<Override PartName="/xl/diagrams/drawing1.xml" ContentType="application/vnd.ms-office.drawingml.diagramDrawing+xml"/>' : '') + '</Types>'));
  types.size = types.content.length;
  return X.CFB.write(zip, { type: 'array', fileType: 'zip' });
}
