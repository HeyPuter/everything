"""Independent fixture for the Format area: hidden text, mirrored indents, suppression flags, a bar
tab, defined bullet and number formats, percentage shading, page borders and a custom style.
Written directly as WordprocessingML (ECMA-376 Part 1), without the editor's serializer."""
from pathlib import Path
from zipfile import ZipFile, ZipInfo, ZIP_DEFLATED

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'tests/fixtures/format-features'
OUT.mkdir(parents=True, exist_ok=True)
W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'

def run(text, props=''):
    rpr = f'<w:rPr>{props}</w:rPr>' if props else ''
    return f'<w:r>{rpr}<w:t xml:space="preserve">{text}</w:t></w:r>'

def para(content, ppr=''):
    return f'<w:p>{f"<w:pPr>{ppr}</w:pPr>" if ppr else ""}{content}</w:p>'

body = ''.join([
    para(run('Visible ') + run('hidden words', '<w:vanish/>') + run(' end.')),
    para(run('Mirrored paragraph'), '<w:suppressLineNumbers/><w:suppressAutoHyphens/><w:ind w:left="1440" w:right="360"/><w:mirrorIndents/>'),
    para(run('Bar\tafter'), '<w:tabs><w:tab w:val="bar" w:pos="720"/><w:tab w:val="left" w:pos="2880"/></w:tabs>'),
    para(run('Star bullet'), '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>'),
    para(run('Step item'), '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="2"/></w:numPr>'),
    para(run('Shaded twenty-five percent'), '<w:shd w:val="pct25" w:color="auto" w:fill="auto"/>'),
    para(run('Outlined', '<w14:textOutline w14:w="9525" w14:cap="flat" w14:cmpd="sng" w14:algn="ctr"><w14:solidFill><w14:srgbClr w14:val="C00000"/></w14:solidFill><w14:prstDash w14:val="solid"/><w14:round/></w14:textOutline>')),
    para(run('Aside styled'), '<w:pStyle w:val="Aside"/>'),
    '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/>'
    '<w:pgBorders w:offsetFrom="page"><w:top w:val="double" w:sz="6" w:space="24" w:color="auto"/><w:left w:val="double" w:sz="6" w:space="24" w:color="auto"/>'
    '<w:bottom w:val="double" w:sz="6" w:space="24" w:color="auto"/><w:right w:val="double" w:sz="6" w:space="24" w:color="auto"/></w:pgBorders></w:sectPr>',
])
document = f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="{W}" xmlns:r="{R}" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" mc:Ignorable="w14"><w:body>{body}</w:body></w:document>'
styles = (f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="{W}">'
          '<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Noto Sans" w:hAnsi="Noto Sans"/><w:sz w:val="22"/></w:rPr></w:rPrDefault>'
          '<w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="259" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>'
          '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>'
          '<w:style w:type="paragraph" w:customStyle="1" w:styleId="Aside"><w:name w:val="Aside"/><w:basedOn w:val="Normal"/>'
          '<w:pPr><w:jc w:val="right"/></w:pPr><w:rPr><w:i/></w:rPr></w:style></w:styles>')
numbering = (f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:numbering xmlns:w="{W}">'
             '<w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="singleLevel"/><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/>'
             '<w:lvlText w:val="★"/><w:lvlJc w:val="center"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum>'
             '<w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="singleLevel"/><w:lvl w:ilvl="0"><w:start w:val="3"/><w:numFmt w:val="upperRoman"/>'
             '<w:suff w:val="space"/><w:lvlText w:val="Step %1:"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="1080" w:hanging="720"/></w:pPr><w:rPr><w:b/></w:rPr></w:lvl></w:abstractNum>'
             '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num></w:numbering>')
parts = {
    '[Content_Types].xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>'
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
        '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>'
        '<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/></Types>',
    '_rels/.rels': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    'word/_rels/document.xml.rels': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
        '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/></Relationships>',
    'word/document.xml': document, 'word/styles.xml': styles, 'word/numbering.xml': numbering,
}
with ZipFile(OUT / 'format.docx', 'w') as package:
    for name, data in parts.items():
        entry = ZipInfo(name, (2026, 10, 13, 0, 0, 0)); entry.compress_type = ZIP_DEFLATED
        package.writestr(entry, data.encode('utf-8'))
print(OUT / 'format.docx')
