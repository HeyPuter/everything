"""Independent, handwritten OOXML for the table tools (stdlib only, no application code).

Writes tests/fixtures/table-tools/table-tools.docx: a styled table with an explicit
tblLook, a formula (=) field with a cached result, a row that ends early (gridAfter),
rotated and non-wrapping cells, alternative text, a floating table, and a document
table style with conditional regions. tests/table-tools-fixture.test.js opens,
edits, saves and reopens it.
"""
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
from canvas_first_section_fixture import parts as package_shell, W


def cell(text, props='', width=2400):
    run = f'<w:r><w:t xml:space="preserve">{text}</w:t></w:r>' if text else ''
    return f'<w:tc><w:tcPr><w:tcW w:w="{width}" w:type="dxa"/>{props}</w:tcPr><w:p>{run}</w:p></w:tc>'


def formula_cell(instruction, cached, width=2400):
    field = ('<w:r><w:fldChar w:fldCharType="begin"/></w:r>'
             f'<w:r><w:instrText xml:space="preserve"> {instruction} </w:instrText></w:r>'
             '<w:r><w:fldChar w:fldCharType="separate"/></w:r>'
             f'<w:r><w:t>{cached}</w:t></w:r>'
             '<w:r><w:fldChar w:fldCharType="end"/></w:r>')
    return f'<w:tc><w:tcPr><w:tcW w:w="{width}" w:type="dxa"/></w:tcPr><w:p>{field}</w:p></w:tc>'


def row(cells, props=''):
    return f'<w:tr>{f"<w:trPr>{props}</w:trPr>" if props else ""}{"".join(cells)}</w:tr>'


def table(rows, props, columns=3, width=2400):
    grid = ''.join(f'<w:gridCol w:w="{width}"/>' for _ in range(columns))
    return f'<w:tbl><w:tblPr>{props}</w:tblPr><w:tblGrid>{grid}</w:tblGrid>{"".join(rows)}</w:tbl>'


def generate():
    root = Path(__file__).resolve().parents[1]
    output = root / 'tests/fixtures/table-tools/table-tools.docx'
    output.parent.mkdir(parents=True, exist_ok=True)
    parts = dict(package_shell)
    style = ('<w:style w:type="table" w:styleId="Ledger"><w:name w:val="Ledger"/>'
             '<w:pPr><w:spacing w:after="0"/></w:pPr>'
             '<w:tblPr><w:tblStyleRowBandSize w:val="1"/><w:tblStyleColBandSize w:val="1"/>'
             '<w:tblBorders><w:top w:val="single" w:sz="8" w:space="0" w:color="1F4E79"/>'
             '<w:bottom w:val="single" w:sz="8" w:space="0" w:color="1F4E79"/></w:tblBorders>'
             '<w:tblCellMar><w:left w:w="100" w:type="dxa"/><w:right w:w="100" w:type="dxa"/></w:tblCellMar></w:tblPr>'
             '<w:tblStylePr w:type="firstRow"><w:rPr><w:b/><w:color w:val="FFFFFF"/></w:rPr>'
             '<w:tcPr><w:shd w:val="clear" w:color="auto" w:fill="1F4E79"/></w:tcPr></w:tblStylePr>'
             '<w:tblStylePr w:type="lastRow"><w:rPr><w:i/></w:rPr>'
             '<w:tcPr><w:tcBorders><w:top w:val="double" w:sz="6" w:space="0" w:color="1F4E79"/></w:tcBorders></w:tcPr></w:tblStylePr>'
             '<w:tblStylePr w:type="band1Horz"><w:tcPr><w:shd w:val="clear" w:color="auto" w:fill="DDEBF7"/></w:tcPr></w:tblStylePr>'
             '</w:style>')
    parts['word/styles.xml'] = (f'<w:styles xmlns:w="{W}"><w:docDefaults><w:rPrDefault><w:rPr><w:sz w:val="22"/></w:rPr></w:rPrDefault>'
                                '<w:pPrDefault><w:pPr><w:spacing w:after="120"/></w:pPr></w:pPrDefault></w:docDefaults>' + style + '</w:styles>')
    ledger = table([
        row([cell('Item'), cell('Units'), cell('Price')], '<w:tblHeader/>'),
        row([cell('Brushes'), cell('4'), cell('12.50')]),
        row([cell('Canvas'), cell('2'), cell('30')]),
        row([cell('Total'), formula_cell('=SUM(ABOVE)', '6'), formula_cell('=SUM(ABOVE) \\# "0.00"', '42.50')]),
    ], '<w:tblStyle w:val="Ledger"/><w:tblW w:w="7200" w:type="dxa"/>'
       '<w:tblLook w:val="0060" w:firstRow="1" w:lastRow="1" w:firstColumn="0" w:lastColumn="0" w:noHBand="0" w:noVBand="1"/>'
       '<w:tblCaption w:val="Supplies"/><w:tblDescription w:val="Units and prices of art supplies"/>')
    shapes = table([
        row([cell('Rotated', '<w:textDirection w:val="btLr"/>'), cell('Kept on one line', '<w:noWrap/>'), cell('Plain')]),
        row([cell('Short row'), cell('ends early')], '<w:gridAfter w:val="1"/><w:wAfter w:w="2400" w:type="dxa"/>'),
    ], '<w:tblW w:w="0" w:type="auto"/><w:tblBorders>'
       + ''.join(f'<w:{side} w:val="single" w:sz="4" w:space="0" w:color="000000"/>' for side in ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'])
       + '</w:tblBorders><w:tblLayout w:type="fixed"/>')
    floating = table([row([cell('Floating', width=2880)])],
                     '<w:tblpPr w:leftFromText="180" w:rightFromText="180" w:vertAnchor="text" w:horzAnchor="margin" w:tblpXSpec="right" w:tblpY="200"/>'
                     '<w:tblW w:w="2880" w:type="dxa"/><w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="808080"/>'
                     '<w:bottom w:val="single" w:sz="4" w:space="0" w:color="808080"/></w:tblBorders>', columns=1, width=2880)
    body = ('<w:p><w:r><w:t>Table tools fixture</w:t></w:r></w:p>' + ledger
            + '<w:p><w:r><w:t>Between tables</w:t></w:r></w:p>' + shapes
            + '<w:p/>' + floating
            + '<w:p><w:r><w:t xml:space="preserve">Text beside the floating table, long enough to wrap around it on the page.</w:t></w:r></w:p>'
            + '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>')
    parts['word/document.xml'] = f'<w:document xmlns:w="{W}"><w:body>{body}</w:body></w:document>'
    with ZipFile(output, 'w', ZIP_DEFLATED) as z:
        for name, text in parts.items():
            z.writestr(name, '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' + text)
    print(output)


if __name__ == '__main__':
    generate()
