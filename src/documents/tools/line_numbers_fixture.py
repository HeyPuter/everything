"""Original line-numbering fixture (public/fixtures/line-numbers.docx).

Written from scratch with the standard library (zipfile + hand-written
WordprocessingML) so it does not depend on the editor's own DOCX writer.
Two sections: the first numbers every line and restarts on each page, with a
"Line Number" character style and one paragraph that suppresses numbering
directly and one through its paragraph style; the second section uses two
columns, counts by five, restarts at 10 and continues across its pages. A table
in the first section is not numbered (tables are outside the numbered flow).

Run: python3 tools/line_numbers_fixture.py
"""
from pathlib import Path
from zipfile import ZipFile, ZipInfo, ZIP_DEFLATED

ROOT = Path(__file__).resolve().parents[1] / 'public/fixtures'
W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'

LOREM = ('Numbered lines help reviewers point at a passage: each line of this paragraph '
         'wraps several times so the margin shows a column of small numbers beside it. ')


def para(text, style=None, suppress=None, section=None):
    props = ''
    if style:
        props += f'<w:pStyle w:val="{style}"/>'
    if suppress is not None:
        props += '<w:suppressLineNumbers/>' if suppress else '<w:suppressLineNumbers w:val="0"/>'
    if section:
        props += section
    ppr = f'<w:pPr>{props}</w:pPr>' if props else ''
    run = f'<w:r><w:t xml:space="preserve">{text}</w:t></w:r>' if text else ''
    return f'<w:p>{ppr}{run}</w:p>'


def table():
    cell = lambda t: f'<w:tc><w:tcPr><w:tcW w:w="4500" w:type="dxa"/></w:tcPr>{para(t)}</w:tc>'
    rows = ''.join(f'<w:tr>{cell(f"Cell {r}A")}{cell(f"Cell {r}B")}</w:tr>' for r in (1, 2))
    borders = ''.join(f'<w:{s} w:val="single" w:sz="4" w:space="0" w:color="808080"/>' for s in ('top', 'left', 'bottom', 'right', 'insideH', 'insideV'))
    return (f'<w:tbl><w:tblPr><w:tblW w:w="9000" w:type="dxa"/><w:tblBorders>{borders}</w:tblBorders></w:tblPr>'
            f'<w:tblGrid><w:gridCol w:w="4500"/><w:gridCol w:w="4500"/></w:tblGrid>{rows}</w:tbl>')


def section(line_numbers, columns='', break_type=None):
    kind = f'<w:type w:val="{break_type}"/>' if break_type else ''
    return (f'<w:sectPr>{kind}<w:pgSz w:w="12240" w:h="15840"/>'
            '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/>'
            f'{line_numbers}{columns}</w:sectPr>')


def build():
    first = section('<w:lnNumType w:countBy="1" w:restart="newPage"/>')
    second = section('<w:lnNumType w:countBy="5" w:start="9" w:distance="288" w:restart="newSection"/>',
                     '<w:cols w:num="2" w:space="720"/>', 'nextPage')
    body = ''.join([
        para('Line numbering sample', 'Title'),
        para(LOREM * 3),
        para(''),
        para('This paragraph is not numbered: it suppresses line numbers directly. ' * 2, suppress=True),
        para('This one uses the Unnumbered paragraph style, which suppresses them too. ' * 2, 'Unnumbered'),
        para('This paragraph turns numbering back on over its style. ' * 2, 'Unnumbered', suppress=False),
        table(),
        para(LOREM * 12, section=first),
        para('Second section: two columns, every fifth line, restarting at 10. ' + LOREM * 14),
        para(LOREM * 10),
    ])
    document = (f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                f'<w:document xmlns:w="{W}" xmlns:r="{R}"><w:body>{body}{second}</w:body></w:document>')
    styles = (f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="{W}">'
              '<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Noto Sans" w:hAnsi="Noto Sans"/><w:sz w:val="22"/></w:rPr></w:rPrDefault>'
              '<w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="259" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>'
              '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>'
              '<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:rPr><w:sz w:val="48"/></w:rPr></w:style>'
              '<w:style w:type="paragraph" w:styleId="Unnumbered"><w:name w:val="Unnumbered"/><w:basedOn w:val="Normal"/><w:pPr><w:suppressLineNumbers/></w:pPr><w:rPr><w:i/></w:rPr></w:style>'
              '<w:style w:type="character" w:default="1" w:styleId="DefaultParagraphFont"><w:name w:val="Default Paragraph Font"/></w:style>'
              '<w:style w:type="character" w:styleId="LineNumber"><w:name w:val="line number"/><w:basedOn w:val="DefaultParagraphFont"/><w:rPr><w:color w:val="7F7F7F"/><w:sz w:val="16"/></w:rPr></w:style>'
              '</w:styles>')
    content_types = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                     '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
                     '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
                     '<Default Extension="xml" ContentType="application/xml"/>'
                     '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
                     '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>'
                     '</Types>')
    rels = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
            '</Relationships>')
    doc_rels = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
                '</Relationships>')
    path = ROOT / 'line-numbers.docx'
    with ZipFile(path, 'w', ZIP_DEFLATED) as z:
        for name, data in [('[Content_Types].xml', content_types), ('_rels/.rels', rels), ('word/document.xml', document),
                           ('word/_rels/document.xml.rels', doc_rels), ('word/styles.xml', styles)]:
            # A fixed timestamp keeps the fixture byte-for-byte reproducible.
            z.writestr(ZipInfo(name, (2026, 1, 1, 0, 0, 0)), data, ZIP_DEFLATED)
    return path


if __name__ == '__main__':
    print(build())
