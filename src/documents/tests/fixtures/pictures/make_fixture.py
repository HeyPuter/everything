"""Writes pictures.docx from hand-written WordprocessingML, independently of the editor's engine (no
engine code or output is used). It exercises what Picture Format, Shape Format and Arrange read and
write: picture colour effects, outline and shadow, alt text with a decorative flag and title, a
processed picture keeping its original layer, tight wrapping with a wrap polygon, a cropped picture, a
group of shapes with gradient and dashed outlines, a text box with WordArt run effects, centred text
and glow, soft edge and reflection effects, and a hidden shape. Run: python3 make_fixture.py
(standard library only)."""
import zipfile, struct, zlib

NS = ('xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" '
      'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" '
      'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape" '
      'xmlns:wpg="http://schemas.microsoft.com/office/word/2010/wordprocessingGroup" xmlns:a14="http://schemas.microsoft.com/office/drawing/2010/main" '
      'xmlns:adec="http://schemas.microsoft.com/office/drawing/2017/decorative" '
      'xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" mc:Ignorable="w14"')

def png(width, height, colour):
    # Two-tone stripes so effects and crops are visible.
    rows = []
    for y in range(height):
        row = b''.join(bytes(colour if (x // 8 + y // 8) % 2 else (240, 240, 230)) for x in range(width))
        rows.append(b'\x00' + row)
    chunk = lambda kind, data: struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data) & 0xffffffff)
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(b''.join(rows))) + chunk(b'IEND', b'')

def anchor(pid, name, cx, cy, graphic, wrap='<wp:wrapNone/>', h='<wp:posOffset>0</wp:posOffset>', v='<wp:posOffset>0</wp:posOffset>', hfrom='column', vfrom='paragraph', order=1, extra='', dist='distT="0" distB="0" distL="114300" distR="114300"', docpr_attrs=''):
    return ('<w:r><w:drawing><wp:anchor %s simplePos="0" relativeHeight="%d" behindDoc="0" locked="0" layoutInCell="1" allowOverlap="1"><wp:simplePos x="0" y="0"/>'
            '<wp:positionH relativeFrom="%s">%s</wp:positionH><wp:positionV relativeFrom="%s">%s</wp:positionV><wp:extent cx="%d" cy="%d"/><wp:effectExtent l="0" t="0" r="0" b="0"/>%s'
            '<wp:docPr id="%d" name="%s"%s>%s</wp:docPr><wp:cNvGraphicFramePr/>%s</wp:anchor></w:drawing></w:r>') % (dist, order, hfrom, h, vfrom, v, cx, cy, wrap, pid, name, docpr_attrs, extra, graphic)

def inline(pid, name, cx, cy, graphic, docpr_attrs='', extra=''):
    return ('<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="%d" cy="%d"/><wp:effectExtent l="0" t="0" r="0" b="0"/>'
            '<wp:docPr id="%d" name="%s"%s>%s</wp:docPr><wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr>%s</wp:inline></w:drawing></w:r>') % (cx, cy, pid, name, docpr_attrs, extra, graphic)

def picture(rel, cx, cy, blip_children='', fill_extra='', sp_extra=''):
    return ('<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="0" name="photo"/><pic:cNvPicPr><a:picLocks noChangeAspect="1"/></pic:cNvPicPr></pic:nvPicPr>'
            '<pic:blipFill><a:blip r:embed="%s">%s</a:blip>%s<a:stretch><a:fillRect/></a:stretch></pic:blipFill>'
            '<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="%d" cy="%d"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom>%s</pic:spPr></pic:pic></a:graphicData></a:graphic>') % (rel, blip_children, fill_extra, cx, cy, sp_extra)

decorative = '<a:extLst><a:ext uri="{C183D7F6-B498-43B3-948B-1728B52AA6E4}"><adec:decorative val="1"/></a:ext></a:extLst>'
styled = picture('rPhoto', 1371600, 914400, '<a:lum bright="10000" contrast="20000"/><a:grayscl/><a:alphaModFix amt="80000"/>',
                 sp_extra='<a:ln w="50800"><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></a:ln><a:effectLst><a:outerShdw blurRad="63500" dist="38100" dir="2700000" algn="tl" rotWithShape="0"><a:srgbClr val="000000"><a:alpha val="40000"/></a:srgbClr></a:outerShdw></a:effectLst>')
layered = picture('rProcessed', 914400, 914400, '<a:extLst><a:ext uri="{BEBA8EAE-BF5A-486C-A8C5-ECC9F3942E4B}"><a14:imgProps><a14:imgLayer r:embed="rPhoto"><a14:imgEffect><a14:saturation sat="0"/></a14:imgEffect></a14:imgLayer></a14:imgProps></a:ext></a:extLst>')
cropped = picture('rPhoto', 1371600, 685800, fill_extra='<a:srcRect l="10000" t="5000" r="10000" b="5000"/>')
polygon = '<wp:wrapPolygon edited="0"><wp:start x="0" y="0"/><wp:lineTo x="0" y="21600"/><wp:lineTo x="21600" y="21600"/><wp:lineTo x="21600" y="0"/><wp:lineTo x="0" y="0"/></wp:wrapPolygon>'

def shape(i, x, y, cx, cy, preset, fill, line, extra_sp='', name=None):
    return ('<wps:wsp><wps:cNvPr id="%d" name="%s"/><wps:cNvSpPr/><wps:spPr><a:xfrm><a:off x="%d" y="%d"/><a:ext cx="%d" cy="%d"/></a:xfrm><a:prstGeom prst="%s"><a:avLst/></a:prstGeom>%s%s%s</wps:spPr><wps:bodyPr/></wps:wsp>'
            % (i, name or 'Shape %d' % i, x, y, cx, cy, preset, fill, line, extra_sp))
gradient = '<a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:srgbClr val="DDEBF7"/></a:gs><a:gs pos="100000"><a:srgbClr val="2E75B6"/></a:gs></a:gsLst><a:lin ang="5400000" scaled="1"/></a:gradFill>'
dashed = '<a:ln w="19050" cmpd="dbl"><a:solidFill><a:srgbClr val="C00000"/></a:solidFill><a:prstDash val="dash"/></a:ln>'
group = ('<a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingGroup"><wpg:wgp><wpg:cNvGrpSpPr/><wpg:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="2743200" cy="914400"/>'
         '<a:chOff x="0" y="0"/><a:chExt cx="2743200" cy="914400"/></a:xfrm></wpg:grpSpPr>%s%s</wpg:wgp></a:graphicData></a:graphic>') % (
    shape(11, 0, 0, 1371600, 914400, 'ellipse', gradient, dashed, name='Blue oval'),
    shape(12, 1600200, 228600, 1143000, 457200, 'roundRect', '<a:solidFill><a:srgbClr val="70AD47"/></a:solidFill>', '<a:ln><a:noFill/></a:ln>', name='Green box'))
textbox = ('<a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"><wps:wsp><wps:cNvSpPr txBox="1"/><wps:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="2286000" cy="914400"/></a:xfrm>'
           '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="FFF2CC"/></a:solidFill><a:ln w="12700"><a:solidFill><a:srgbClr val="BF9000"/></a:solidFill></a:ln>'
           '<a:effectLst><a:glow rad="63500"><a:srgbClr val="FFC000"><a:alpha val="60000"/></a:srgbClr></a:glow><a:reflection blurRad="6350" stA="50000" stPos="0" endA="300" endPos="35000" dist="0" dir="5400000" sy="-100000" algn="bl" rotWithShape="0"/><a:softEdge rad="12700"/></a:effectLst></wps:spPr>'
           '<wps:txbx><w:txbxContent><w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:rPr><w:b/><w:color w:val="C00000"/><w:sz w:val="36"/>'
           '<w14:shadow w14:blurRad="38100" w14:dist="25400" w14:dir="2700000" w14:sx="100000" w14:sy="100000" w14:kx="0" w14:ky="0" w14:algn="tl"><w14:srgbClr w14:val="000000"><w14:alpha w14:val="60000"/></w14:srgbClr></w14:shadow>'
           '<w14:textOutline w14:w="9525" w14:cap="flat" w14:cmpd="sng" w14:algn="ctr"><w14:solidFill><w14:srgbClr w14:val="000000"/></w14:solidFill><w14:prstDash w14:val="solid"/><w14:round/></w14:textOutline>'
           '<w14:textFill><w14:solidFill><w14:srgbClr w14:val="C00000"/></w14:solidFill></w14:textFill></w:rPr><w:t>Notice</w:t></w:r></w:p></w:txbxContent></wps:txbx>'
           '<wps:bodyPr rot="0" vert="horz" wrap="square" lIns="91440" tIns="45720" rIns="91440" bIns="45720" anchor="ctr" anchorCtr="0"><a:noAutofit/></wps:bodyPr></wps:wsp></a:graphicData></a:graphic>')
hidden = ('<a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape">%s</a:graphicData></a:graphic>'
          % shape(0, 0, 0, 914400, 457200, 'star5', '<a:solidFill><a:srgbClr val="FFC000"/></a:solidFill>', '<a:ln><a:noFill/></a:ln>').replace('<wps:cNvPr id="0" name="Shape 0"/>', ''))
text = lambda s: '<w:r><w:t xml:space="preserve">%s</w:t></w:r>' % s
para = ' '.join(['Pictures and shapes in this fixture sit beside ordinary text so that wrapping can be seen.'] * 3)
body = (
    '<w:p>' + inline(1, 'Styled photo', 1371600, 914400, styled, ' descr="A striped test picture" title="Stripes"') + text(' A picture with colour effects, an outline and a shadow.') + '</w:p>'
    '<w:p>' + inline(2, 'Decorative stripes', 914400, 914400, layered, '', decorative) + text(' A processed picture that keeps its original.') + '</w:p>'
    '<w:p>' + anchor(3, 'Tight photo', 1371600, 685800, cropped, '<wp:wrapTight wrapText="bothSides">%s</wp:wrapTight>' % polygon, h='<wp:posOffset>3657600</wp:posOffset>', v='<wp:posOffset>0</wp:posOffset>', order=2) + text(para) + '</w:p>'
    '<w:p>' + anchor(4, 'Group of shapes', 2743200, 914400, group, h='<wp:align>center</wp:align>', v='<wp:posOffset>182880</wp:posOffset>', hfrom='margin', order=3) + text(para) + '</w:p>'
    '<w:p>' + anchor(5, 'Notice box', 2286000, 914400, textbox, '<wp:wrapSquare wrapText="largest"/>', h='<wp:posOffset>0</wp:posOffset>', order=4, dist='distT="0" distB="0" distL="114300" distR="228600"') + text(para) + '</w:p>'
    '<w:p>' + anchor(6, 'Hidden star', 914400, 457200, hidden, h='<wp:posOffset>4572000</wp:posOffset>', order=5, docpr_attrs=' hidden="1"') + text('A hidden star is anchored here.') + '</w:p>'
    '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>')
parts = {
    '[Content_Types].xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/>'
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    '_rels/.rels': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    'word/_rels/document.xml.rels': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rPhoto" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/photo.png"/><Relationship Id="rProcessed" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/processed.png"/></Relationships>',
    'word/document.xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document %s><w:body>%s</w:body></w:document>' % (NS, body),
    'word/media/photo.png': png(64, 48, (46, 117, 182)),
    'word/media/processed.png': png(48, 48, (128, 128, 128)),
}
with zipfile.ZipFile('pictures.docx', 'w', zipfile.ZIP_DEFLATED) as z:
    for name, data in parts.items():
        z.writestr(zipfile.ZipInfo(name, (2026, 10, 13, 0, 0, 0)), data if isinstance(data, bytes) else data.encode('utf-8'), zipfile.ZIP_DEFLATED)
