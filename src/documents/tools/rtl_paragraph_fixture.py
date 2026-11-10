"""Independent right-to-left paragraph controls (ECMA-376 Part 1 17.3.1.6 bidi).

Written directly as WordprocessingML, without the editor's serializer: paragraph direction, alignment and
indents relative to the reading edge, a hanging indent with a tab, a numbered list, a style that carries
the direction, a table cell, and a right-to-left section (17.6.1).
"""
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
from xml.sax.saxutils import escape

root = Path(__file__).resolve().parents[1]
w = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
r = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'


def run(text, rtl=False):
    props = '<w:rPr><w:rtl/></w:rPr>' if rtl else ''
    return f'<w:r>{props}<w:t xml:space="preserve">{escape(text)}</w:t></w:r>'


def para(runs, props=''):
    return f'<w:p><w:pPr>{props}</w:pPr>{runs}</w:p>'


hebrew = 'שלום עולם'
arabic = 'هذا نص عربي طويل يكفي لملء أكثر من سطر واحد في الصفحة حتى يظهر التفاف الأسطر والمحاذاة من الجهتين في فقرة تبدأ من اليمين وتنتهي في اليسار'
body = [
    para(run('Left to right paragraph')),
    para(run(hebrew, True) + run(' mixed 123.'), '<w:bidi/>'),
    para(run(arabic, True), '<w:bidi/><w:jc w:val="both"/>'),
    para(run('Trailing side', False), '<w:bidi/><w:jc w:val="right"/>'),
    para(run('Centered', False), '<w:bidi/><w:jc w:val="center"/>'),
    para(run('Label') + '<w:r><w:tab/></w:r>' + run('hanging text', False), '<w:bidi/><w:ind w:left="1440" w:hanging="720"/>'),
    para(run('First item'), '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr><w:bidi/>'),
    para(run('Second item'), '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr><w:bidi/>'),
    para(run('Styled direction'), '<w:pStyle w:val="RtlBody"/>'),
    para(run('Explicit left to right'), '<w:pStyle w:val="RtlBody"/><w:bidi w:val="0"/>'),
    '<w:tbl><w:tblPr><w:tblW w:w="4680" w:type="dxa"/><w:tblLayout w:type="fixed"/></w:tblPr><w:tblGrid><w:gridCol w:w="4680"/></w:tblGrid><w:tr><w:tc><w:tcPr><w:tcW w:w="4680" w:type="dxa"/></w:tcPr>'
    + para(run('Cell text'), '<w:bidi/>') + '</w:tc></w:tr></w:tbl>',
    para(run('Last paragraph')),
    '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/><w:bidi/></w:sectPr>',
]
parts = {
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/></Types>',
    '_rels/.rels': f'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="main" Type="{r}/officeDocument" Target="word/document.xml"/></Relationships>',
    'word/_rels/document.xml.rels': f'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="styles" Type="{r}/styles" Target="styles.xml"/><Relationship Id="settings" Type="{r}/settings" Target="settings.xml"/><Relationship Id="numbering" Type="{r}/numbering" Target="numbering.xml"/></Relationships>',
    'word/styles.xml': f'<w:styles xmlns:w="{w}"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"/><w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:before="0" w:after="160"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="RtlBody"><w:name w:val="Rtl Body"/><w:basedOn w:val="Normal"/><w:pPr><w:bidi/></w:pPr></w:style></w:styles>',
    'word/settings.xml': f'<w:settings xmlns:w="{w}"><w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat></w:settings>',
    'word/numbering.xml': f'<w:numbering xmlns:w="{w}"><w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="singleLevel"/><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>',
    'word/document.xml': f'<w:document xmlns:w="{w}"><w:body>{"".join(body)}</w:body></w:document>',
}
target = root / 'public/fixtures/rtl-paragraphs.docx'
with ZipFile(target, 'w', ZIP_DEFLATED) as z:
    for name, value in parts.items():
        z.writestr(name, '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' + value)
print(target)
