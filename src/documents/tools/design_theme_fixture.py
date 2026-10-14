"""Independently authored Design-tab probe: a theme part, theme-linked styles, a header watermark
and a picture page background, written directly as OPC/XML with the Python standard library only.

Usage: python3 tools/design_theme_fixture.py            -> writes public/fixtures/design-theme.docx
       python3 tools/design_theme_fixture.py out.docx   -> checks a browser export of the fixture
"""
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
from xml.etree import ElementTree as ET
import base64, struct, sys, zlib

W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
REL = 'http://schemas.openxmlformats.org/package/2006/relationships'
A = 'http://schemas.openxmlformats.org/drawingml/2006/main'
WP = 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing'
WPS = 'http://schemas.microsoft.com/office/word/2010/wordprocessingShape'
V = 'urn:schemas-microsoft-com:vml'
O = 'urn:schemas-microsoft-com:office:office'
CT = 'application/vnd.openxmlformats-officedocument.'


def png(width, height, rgb):
    """A solid-color RGB PNG with a 96 dpi pHYs chunk, encoded here."""
    def chunk(kind, data):
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data) & 0xffffffff)
    raw = b''.join(b'\x00' + bytes(rgb) * width for _ in range(height))
    ppm = round(96 / 0.0254)
    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0))
            + chunk(b'pHYs', struct.pack('>IIB', ppm, ppm, 1)) + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b''))


COLORS = dict(dk1='111111', lt1='FFFFFF', dk2='2B3A4A', lt2='E8ECEF', accent1='2E7D5B', accent2='C2563A',
              accent3='3F6FB5', accent4='B58A2E', accent5='7A4E9C', accent6='3B9AA6', hlink='3F6FB5', folHlink='7A4E9C')


def theme():
    scheme = ''.join(f'<a:{k}><a:srgbClr val="{v}"/></a:{k}>' for k, v in COLORS.items())
    fonts = ''.join(f'<a:{tag}><a:latin typeface="{face}"/><a:ea typeface=""/><a:cs typeface=""/></a:{tag}>'
                    for tag, face in [('majorFont', 'Montserrat'), ('minorFont', 'Open Sans')])
    fill = '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>'
    lines = ''.join(f'<a:ln w="{w}"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>' for w in (9525, 19050, 28575))
    effects = '<a:effectStyle><a:effectLst/></a:effectStyle>' * 3
    return (f'<a:theme xmlns:a="{A}" name="Probe Forest"><a:themeElements><a:clrScheme name="Probe Forest">{scheme}</a:clrScheme>'
            f'<a:fontScheme name="Probe Forest">{fonts}</a:fontScheme><a:fmtScheme name="Probe Forest"><a:fillStyleLst>{fill * 3}</a:fillStyleLst>'
            f'<a:lnStyleLst>{lines}</a:lnStyleLst><a:effectStyleLst>{effects}</a:effectStyleLst><a:bgFillStyleLst>{fill * 3}</a:bgFillStyleLst>'
            '</a:fmtScheme></a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>')


STYLES = (f'<w:styles xmlns:w="{W}"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:asciiTheme="minorHAnsi" w:hAnsiTheme="minorHAnsi"/>'
          '<w:sz w:val="22"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="160"/></w:pPr></w:pPrDefault></w:docDefaults>'
          '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>'
          '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>'
          '<w:pPr><w:keepNext/><w:spacing w:before="240" w:after="80"/><w:outlineLvl w:val="0"/></w:pPr>'
          '<w:rPr><w:rFonts w:asciiTheme="majorHAnsi" w:hAnsiTheme="majorHAnsi"/><w:b/><w:color w:val="2E7D5B" w:themeColor="accent1"/><w:sz w:val="36"/></w:rPr></w:style>'
          '<w:style w:type="paragraph" w:styleId="Signature"><w:name w:val="Signature"/><w:basedOn w:val="Normal"/>'
          '<w:rPr><w:rFonts w:ascii="Courier New" w:hAnsi="Courier New"/></w:rPr></w:style></w:styles>')

WATERMARK = (f'<w:r><w:drawing><wp:anchor distT="0" distB="0" distL="0" distR="0" simplePos="0" relativeHeight="1" behindDoc="1" locked="0" layoutInCell="1" allowOverlap="1">'
             '<wp:simplePos x="0" y="0"/><wp:positionH relativeFrom="margin"><wp:align>center</wp:align></wp:positionH>'
             '<wp:positionV relativeFrom="margin"><wp:align>center</wp:align></wp:positionV><wp:extent cx="4572000" cy="914400"/>'
             '<wp:effectExtent l="0" t="0" r="0" b="0"/><wp:wrapNone/><wp:docPr id="77" name="Document Watermark"/><wp:cNvGraphicFramePr/>'
             f'<a:graphic><a:graphicData uri="{WPS}"><wps:wsp><wps:cNvSpPr txBox="1"/><wps:spPr><a:xfrm rot="18900000"><a:off x="0" y="0"/><a:ext cx="4572000" cy="914400"/></a:xfrm>'
             '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln><a:noFill/></a:ln></wps:spPr><wps:txbx><w:txbxContent><w:p><w:pPr><w:jc w:val="center"/></w:pPr>'
             '<w:r><w:rPr><w:color w:val="D0D0D0"/><w:sz w:val="96"/></w:rPr><w:t>PROBE</w:t></w:r></w:p></w:txbxContent></wps:txbx>'
             '<wps:bodyPr wrap="square" lIns="0" tIns="0" rIns="0" bIns="0" anchor="ctr"><a:noAutofit/></wps:bodyPr></wps:wsp></a:graphicData></a:graphic></wp:anchor></w:drawing></w:r>')


def parts():
    return {
        '[Content_Types].xml': (f'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
                                '<Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/>'
                                f'<Override PartName="/word/document.xml" ContentType="{CT}wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="{CT}wordprocessingml.styles+xml"/>'
                                f'<Override PartName="/word/settings.xml" ContentType="{CT}wordprocessingml.settings+xml"/><Override PartName="/word/theme/forest.xml" ContentType="{CT}theme+xml"/>'
                                f'<Override PartName="/word/top.xml" ContentType="{CT}wordprocessingml.header+xml"/></Types>'),
        '_rels/.rels': f'<Relationships xmlns="{REL}"><Relationship Id="main" Type="{R}/officeDocument" Target="word/document.xml"/></Relationships>',
        'word/_rels/document.xml.rels': (f'<Relationships xmlns="{REL}"><Relationship Id="styles" Type="{R}/styles" Target="styles.xml"/>'
                                         f'<Relationship Id="settings" Type="{R}/settings" Target="settings.xml"/><Relationship Id="theme" Type="{R}/theme" Target="theme/forest.xml"/>'
                                         f'<Relationship Id="top" Type="{R}/header" Target="top.xml"/><Relationship Id="paper" Type="{R}/image" Target="media/paper.png"/></Relationships>'),
        'word/theme/forest.xml': theme(),
        'word/styles.xml': STYLES,
        'word/settings.xml': f'<w:settings xmlns:w="{W}"><w:displayBackgroundShape/><w:defaultTabStop w:val="720"/></w:settings>',
        'word/top.xml': f'<w:hdr xmlns:w="{W}" xmlns:wp="{WP}" xmlns:a="{A}" xmlns:wps="{WPS}"><w:p>{WATERMARK}<w:r><w:t>Probe header</w:t></w:r></w:p></w:hdr>',
        'word/media/paper.png': png(8, 8, (250, 246, 236)),
        'word/document.xml': (f'<w:document xmlns:w="{W}" xmlns:r="{R}" xmlns:v="{V}" xmlns:o="{O}">'
                              '<w:background w:color="FAF6EC"><v:background id="_x0000_s1025" o:bwmode="white"><v:fill r:id="paper" o:title="Paper" type="tile"/></v:background></w:background>'
                              '<w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Design probe</w:t></w:r></w:p>'
                              '<w:p><w:r><w:t>Body text in the theme body font.</w:t></w:r></w:p>'
                              '<w:p><w:pPr><w:pStyle w:val="Signature"/></w:pPr><w:r><w:t>Explicit font kept</w:t></w:r></w:p>'
                              '<w:sectPr><w:headerReference w:type="default" r:id="top"/><w:pgSz w:w="12240" w:h="15840"/>'
                              '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>'),
    }


def check(path):
    with ZipFile(path) as z:
        names = z.namelist()
        theme_root = ET.fromstring(z.read('word/theme/forest.xml'))
        assert theme_root.get('name') != 'Probe Forest', 'the theme was not changed'
        header = z.read('word/top.xml').decode()
        assert 'Probe header' in header
        styles = ET.fromstring(z.read('word/styles.xml'))
        signature = [s for s in styles.iter(f'{{{W}}}style') if s.get(f'{{{W}}}styleId') == 'Signature'][0]
        assert signature.find(f'{{{W}}}rPr/{{{W}}}rFonts').get(f'{{{W}}}ascii') == 'Courier New'
        assert 'word/media/paper.png' in names
    print('PASS design-theme browser export:', path)


if __name__ == '__main__':
    if len(sys.argv) > 1:
        check(sys.argv[1])
    else:
        out = Path(__file__).resolve().parents[1] / 'public/fixtures/design-theme.docx'
        with ZipFile(out, 'w', ZIP_DEFLATED) as z:
            for name, data in parts().items():
                z.writestr(name, data if isinstance(data, bytes) else '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' + data)
        print(out)
