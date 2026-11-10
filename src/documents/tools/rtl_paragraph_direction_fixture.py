"""Run direction inside right-to-left paragraphs: independent controls for the reference application.

Twelve one-line paragraphs vary w:bidi on the paragraph and w:rtl on its runs over the same Hebrew, Latin,
digit and punctuation text, with one tabbed line. tests/fixtures/rtl-paragraphs/README.md records how the
reference application orders each; tests/rtl-paragraph-controls.test.js holds the editor to it.
"""
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
from xml.sax.saxutils import escape
w='http://schemas.openxmlformats.org/wordprocessingml/2006/main'; r='http://schemas.openxmlformats.org/officeDocument/2006/relationships'
def run(t,rtl=False): return f'<w:r>{"<w:rPr><w:rtl/></w:rPr>" if rtl else ""}<w:t xml:space="preserve">{escape(t)}</w:t></w:r>'
# CT_PPrBase order: tabs come before bidi.
def para(runs,bidi=True,extra=''): return f'<w:p><w:pPr>{extra}{"<w:bidi/>" if bidi else ""}</w:pPr>{runs}</w:p>'
H1,H2='שלום','עולם'
cases=[
 para(run(f'1 {H1} {H2}.')),
 para(run('2 Hello world.')),
 para(run(f'3 {H1} {H2}.',True)),
 para(run('4 Hello world.',True)),
 para(run('5 abc ')+run(H1,True)+run(' def.')),
 para(run(f'6 {H1} abc {H2}.')),
 para(run(f'7 {H1} {H2}.'),False),
 para(run(f'8 ({H1}) 123 abc!')),
 para(run(f'9 {H1}')+run(' ')+run(f'{H2}')+run('.')),
 para(run('10 a')+'<w:r><w:tab/></w:r>'+run('b')+'<w:r><w:tab/></w:r>'+run(H1,True),True,'<w:tabs><w:tab w:val="left" w:pos="2880"/><w:tab w:val="right" w:pos="7200"/></w:tabs>'),
 para(run(f'11 {H1}: abc, {H2} (x) 12.5%')),
 para(run(f'12 {H1}: abc, {H2} (x) 12.5%',True)),
]
body=''.join(cases)+'<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>'
parts={'[Content_Types].xml':'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>',
'_rels/.rels':f'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="main" Type="{r}/officeDocument" Target="word/document.xml"/></Relationships>',
'word/_rels/document.xml.rels':f'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="styles" Type="{r}/styles" Target="styles.xml"/></Relationships>',
'word/styles.xml':f'<w:styles xmlns:w="{w}"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"/><w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:before="0" w:after="160"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style></w:styles>',
'word/document.xml':f'<w:document xmlns:w="{w}"><w:body>{body}</w:body></w:document>'}
target = Path(__file__).resolve().parents[1] / 'tests/fixtures/rtl-paragraphs/control.docx'
target.parent.mkdir(exist_ok=True)
with ZipFile(target, 'w', ZIP_DEFLATED) as z:
  for n, v in parts.items(): z.writestr(n, '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' + v)
print(target)
