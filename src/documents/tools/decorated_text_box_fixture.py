"""Original text box controls with a hyperlink, underlines, strikethrough, highlight and shading in
w:txbxContent (ECMA-376 Part 1 §17.3.2 run properties, §17.16.22 hyperlink); stdlib only."""
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
ROOT = Path(__file__).resolve().parents[1] / 'tests/fixtures/decorated-text-box'
NS = {'w': 'http://schemas.openxmlformats.org/wordprocessingml/2006/main', 'a': 'http://schemas.openxmlformats.org/drawingml/2006/main',
      'wp': 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing', 'r': 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
      'wps': 'http://schemas.microsoft.com/office/word/2010/wordprocessingShape', 'mc': 'http://schemas.openxmlformats.org/markup-compatibility/2006'}
DECL = ' '.join(f'xmlns:{k}="{v}"' for k, v in NS.items())
FONT = '<w:rFonts w:ascii="Arial" w:hAnsi="Arial"/><w:sz w:val="24"/>'
def run(text, props=''):
    return f'<w:r><w:rPr>{FONT}{props}</w:rPr><w:t xml:space="preserve">{text}</w:t></w:r>'
def paragraph(*runs):
    return '<w:p><w:pPr><w:spacing w:after="0"/></w:pPr>' + ''.join(runs) + '</w:p>'
BOX = (paragraph(run('Visit '), '<w:hyperlink r:id="rLink" w:history="1">' + run('the site', '<w:color w:val="0563C1"/><w:u w:val="single"/>') + '</w:hyperlink>', run(' today.'))
       + paragraph(run('Single', '<w:u w:val="single"/>'), run(' and '), run('wavy', '<w:u w:val="wave" w:color="FF0000"/>'))
       + paragraph(run('Struck', '<w:strike/>'), run(' and '), run('double', '<w:dstrike/>'))
       + paragraph(run('Marked', '<w:highlight w:val="yellow"/>'), run(' and '), run('shaded', '<w:shd w:val="clear" w:color="auto" w:fill="C6E0B4"/>')))
def drawing():
    shape = ('<wps:wsp><wps:cNvPr id="101" name="Decorated text box"/><wps:cNvSpPr txBox="1"/><wps:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="3657600" cy="1371600"/></a:xfrm>'
             '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill><a:ln w="9525"><a:solidFill><a:srgbClr val="000000"/></a:solidFill></a:ln></wps:spPr>'
             f'<wps:txbx><w:txbxContent>{BOX}</w:txbxContent></wps:txbx><wps:bodyPr lIns="91440" rIns="91440" tIns="45720" bIns="45720" anchor="t" wrap="square"><a:noAutofit/></wps:bodyPr></wps:wsp>')
    return ('<w:p><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="3657600" cy="1371600"/><wp:docPr id="1" name="Text Box 1"/><wp:cNvGraphicFramePr/>'
            f'<a:graphic><a:graphicData uri="{NS["wps"]}">{shape}</a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>')
def generate():
    ROOT.mkdir(parents=True, exist_ok=True)
    parts = {
        '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
        '_rels/.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rDoc" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
        'word/_rels/document.xml.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rLink" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com/" TargetMode="External"/></Relationships>',
        'word/document.xml': f'<w:document {DECL} mc:Ignorable="wps"><w:body>' + paragraph(run('Before the text box')) + drawing() + paragraph(run('After the text box'))
            + '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:bottom="1440" w:left="1440" w:right="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>',
    }
    with ZipFile(ROOT / 'control.docx', 'w', ZIP_DEFLATED) as z:
        for name, value in parts.items():
            z.writestr(name, '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' + value)
    print(ROOT / 'control.docx')
if __name__ == '__main__':
    generate()
