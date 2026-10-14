"""Writes insert-features.docx from hand-written WordprocessingML, independently of the editor's
engine (no engine code or output is used). Each part exercises one Insert feature the editor reads
and writes: a drop cap frame, DATE and DOCPROPERTY fields, an inline equation, an SVG picture with a
PNG fallback, a grouped diagram with shape text, a bar chart part, a WordArt text box with w14
effects and section page numbering. Run: python3 make_fixture.py (standard library only)."""
import zipfile, struct, zlib

W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
NS = ('xmlns:w="%s" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" '
      'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" '
      'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape" '
      'xmlns:wpg="http://schemas.microsoft.com/office/word/2010/wordprocessingGroup" xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" '
      'xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math" xmlns:asvg="http://schemas.microsoft.com/office/drawing/2016/SVG/main" '
      'xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" mc:Ignorable="w14"') % W

def png(width, height, rgb):
    raw = b''.join(b'\x00' + bytes(rgb) * width for _ in range(height))
    chunk = lambda kind, data: struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data) & 0xffffffff)
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b'')

SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#1F3864" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M8 12h8M12 8v8"/></svg>'
inline = lambda pid, name, cx, cy, graphic, descr='': (
    '<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="%d" cy="%d"/><wp:effectExtent l="0" t="0" r="0" b="0"/>'
    '<wp:docPr id="%d" name="%s"%s/><wp:cNvGraphicFramePr/>%s</wp:inline></w:drawing></w:r>') % (cx, cy, pid, name, ' descr="%s"' % descr if descr else '', graphic)
picture = ('<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="0" name="mark"/><pic:cNvPicPr/></pic:nvPicPr>'
    '<pic:blipFill><a:blip r:embed="rPng"><a:extLst><a:ext uri="{96DAC541-7B7A-43D3-8B79-37D633B846F1}"><asvg:svgBlip r:embed="rSvg"/></a:ext></a:extLst></a:blip><a:stretch><a:fillRect/></a:stretch></pic:blipFill>'
    '<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="457200" cy="457200"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic>')
def box(i, x, preset, text):
    return ('<wps:wsp><wps:cNvPr id="%d" name="Step %d"/><wps:cNvSpPr/><wps:spPr><a:xfrm><a:off x="%d" y="0"/><a:ext cx="1371600" cy="685800"/></a:xfrm><a:prstGeom prst="%s"><a:avLst/></a:prstGeom>'
            '<a:solidFill><a:srgbClr val="1E6E6A"/></a:solidFill><a:ln><a:noFill/></a:ln></wps:spPr><wps:txbx><w:txbxContent><w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:rPr><w:color w:val="FFFFFF"/></w:rPr><w:t>%s</w:t></w:r></w:p></w:txbxContent></wps:txbx>'
            '<wps:bodyPr rot="0" vert="horz" wrap="square" lIns="45720" tIns="45720" rIns="45720" bIns="45720" anchor="ctr" anchorCtr="0"><a:noAutofit/></wps:bodyPr></wps:wsp>') % (i, i, x, preset, text)
group = ('<a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingGroup"><wpg:wgp><wpg:cNvGrpSpPr/><wpg:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="4572000" cy="685800"/>'
    '<a:chOff x="0" y="0"/><a:chExt cx="4572000" cy="685800"/></a:xfrm></wpg:grpSpPr>%s%s%s</wpg:wgp></a:graphicData></a:graphic>') % (box(1, 0, 'homePlate', 'Plan'), box(2, 1600200, 'chevron', 'Make'), box(3, 3200400, 'chevron', 'Ship'))
chart_graphic = '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart r:id="rChart"/></a:graphicData></a:graphic>'
wordart = ('<w:r><w:drawing><wp:anchor distT="0" distB="0" distL="114300" distR="114300" simplePos="0" relativeHeight="3" behindDoc="0" locked="0" layoutInCell="1" allowOverlap="1"><wp:simplePos x="0" y="0"/>'
    '<wp:positionH relativeFrom="column"><wp:posOffset>0</wp:posOffset></wp:positionH><wp:positionV relativeFrom="paragraph"><wp:posOffset>0</wp:posOffset></wp:positionV><wp:extent cx="2743200" cy="640080"/>'
    '<wp:effectExtent l="0" t="0" r="0" b="0"/><wp:wrapTopAndBottom/><wp:docPr id="5" name="WordArt 5"/><wp:cNvGraphicFramePr/><a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape">'
    '<wps:wsp><wps:cNvSpPr txBox="1"/><wps:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="2743200" cy="640080"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln><a:noFill/></a:ln></wps:spPr>'
    '<wps:txbx><w:txbxContent><w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:rPr><w:b/><w:color w:val="C55A11"/><w:sz w:val="56"/><w14:textOutline w14:w="9525" w14:cap="flat" w14:cmpd="sng" w14:algn="ctr"><w14:solidFill><w14:srgbClr w14:val="7F3F00"/></w14:solidFill><w14:prstDash w14:val="solid"/><w14:round/></w14:textOutline></w:rPr><w:t>Headline</w:t></w:r></w:p></w:txbxContent></wps:txbx>'
    '<wps:bodyPr rot="0" vert="horz" wrap="square" lIns="91440" tIns="45720" rIns="91440" bIns="45720" anchor="t" anchorCtr="0"><a:spAutoFit/></wps:bodyPr></wps:wsp></a:graphicData></a:graphic></wp:anchor></w:drawing></w:r>')
body = (
    '<w:p><w:pPr><w:keepNext/><w:framePr w:dropCap="drop" w:lines="3" w:wrap="around" w:vAnchor="text" w:hAnchor="text"/><w:spacing w:after="0" w:line="827" w:lineRule="exact"/></w:pPr><w:r><w:rPr><w:position w:val="-6"/><w:sz w:val="98"/></w:rPr><w:t>O</w:t></w:r></w:p>'
    '<w:p><w:r><w:t xml:space="preserve">nce upon a time this paragraph began with a dropped capital that spans three lines of text, written by hand for this fixture so that the editor reads a drop cap it did not write.</w:t></w:r></w:p>'
    '<w:p><w:r><w:t xml:space="preserve">Dated </w:t></w:r><w:fldSimple w:instr=" DATE \\@ &quot;MMMM d, yyyy&quot; "><w:r><w:t>October 3, 2026</w:t></w:r></w:fldSimple><w:r><w:t xml:space="preserve"> for </w:t></w:r>'
    '<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> DOCPROPERTY Company \\* MERGEFORMAT </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>Fixture Works</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r><w:r><w:t>.</w:t></w:r></w:p>'
    '<w:p><w:r><w:t xml:space="preserve">Area: </w:t></w:r><m:oMath><m:r><m:t>A=π</m:t></m:r><m:sSup><m:e><m:r><m:t>r</m:t></m:r></m:e><m:sup><m:r><m:t>2</m:t></m:r></m:sup></m:sSup></m:oMath></w:p>'
    '<w:p>' + inline(2, 'Icon 2', 457200, 457200, picture, 'Plus in a circle') + '</w:p>'
    '<w:p>' + inline(3, 'Diagram 3', 4572000, 685800, group, 'Diagram: Chevron Process (Teal)&#10;Plan&#10;Make&#10;Ship') + '</w:p>'
    '<w:p>' + inline(4, 'Chart 4', 4572000, 2743200, chart_graphic) + '</w:p>'
    '<w:p>' + wordart + '</w:p>'
    '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/><w:pgNumType w:fmt="upperRoman" w:start="4"/></w:sectPr>')
chart = ('<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><c:roundedCorners val="0"/><c:chart><c:autoTitleDeleted val="1"/><c:plotArea><c:layout/>'
    '<c:barChart><c:barDir val="col"/><c:grouping val="clustered"/><c:varyColors val="0"/><c:ser><c:idx val="0"/><c:order val="0"/><c:tx><c:v>Units</c:v></c:tx>'
    '<c:spPr><a:solidFill><a:srgbClr val="1E6E6A"/></a:solidFill></c:spPr><c:invertIfNegative val="0"/>'
    '<c:cat><c:strLit><c:ptCount val="3"/><c:pt idx="0"><c:v>North</c:v></c:pt><c:pt idx="1"><c:v>South</c:v></c:pt><c:pt idx="2"><c:v>West</c:v></c:pt></c:strLit></c:cat>'
    '<c:val><c:numLit><c:formatCode>General</c:formatCode><c:ptCount val="3"/><c:pt idx="0"><c:v>4</c:v></c:pt><c:pt idx="1"><c:v>7</c:v></c:pt><c:pt idx="2"><c:v>5</c:v></c:pt></c:numLit></c:val></c:ser>'
    '<c:gapWidth val="150"/><c:axId val="101"/><c:axId val="102"/></c:barChart>'
    '<c:catAx><c:axId val="101"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="b"/><c:numFmt formatCode="General" sourceLinked="0"/><c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/><c:crossAx val="102"/><c:crosses val="autoZero"/><c:auto val="1"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/><c:noMultiLvlLbl val="0"/></c:catAx>'
    '<c:valAx><c:axId val="102"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="l"/><c:majorGridlines/><c:numFmt formatCode="General" sourceLinked="0"/><c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/><c:crossAx val="101"/><c:crosses val="autoZero"/><c:crossBetween val="between"/></c:valAx>'
    '</c:plotArea><c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/></c:chart></c:chartSpace>')
parts = {
    '[Content_Types].xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="svg" ContentType="image/svg+xml"/>'
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/charts/chart1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>',
    '_rels/.rels': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>',
    'docProps/app.xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Company>Fixture Works</Company></Properties>',
    'word/_rels/document.xml.rels': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rPng" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/mark.png"/><Relationship Id="rSvg" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/mark.svg"/><Relationship Id="rChart" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="charts/chart1.xml"/></Relationships>',
    'word/document.xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document %s><w:body>%s</w:body></w:document>' % (NS, body),
    'word/media/mark.png': png(48, 48, (31, 56, 100)),
    'word/media/mark.svg': SVG,
    'word/charts/chart1.xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' + chart,
}
with zipfile.ZipFile('insert-features.docx', 'w', zipfile.ZIP_DEFLATED) as z:
    for name, data in parts.items():
        z.writestr(zipfile.ZipInfo(name, (2026, 10, 13, 0, 0, 0)), data if isinstance(data, bytes) else data.encode('utf-8'), zipfile.ZIP_DEFLATED)
