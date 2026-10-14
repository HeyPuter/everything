"""Original page-layout probe for section breaks and document page settings.

Authored directly as OPC/XML with the standard library (no word processor, no
third-party content). Three sections exercise ECMA-376 Part 1 §17.6.22 section
types (next page, odd page, continuous), §17.6.13/§17.6.11 page size and margins,
§17.6.4 columns with a separator, §17.6.23 vertical alignment of the title page, and the
§17.15.1.57 mirrorMargins setting; a §17.3.3.1 text-wrapping break clears floats.

  python3 tools/section_layout_fixture.py            write public/fixtures/section-layout.docx
  python3 tools/section_layout_fixture.py out.docx   check a browser export of it
"""
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
from xml.etree import ElementTree as ET
import sys
from canvas_first_section_fixture import parts as shell, W, R, CT

parts = dict(shell)
parts['[Content_Types].xml'] = shell['[Content_Types].xml'].replace('</Types>', f'<Override PartName="/word/settings.xml" ContentType="{CT}settings+xml"/></Types>')
parts['word/_rels/document.xml.rels'] = shell['word/_rels/document.xml.rels'].replace('</Relationships>', f'<Relationship Id="settings" Type="{R}/settings" Target="settings.xml"/></Relationships>')
parts['word/settings.xml'] = f'<w:settings xmlns:w="{W}"><w:mirrorMargins/><w:defaultTabStop w:val="720"/></w:settings>'


def para(text, section=''):
    properties = f'<w:pPr>{section}</w:pPr>' if section else ''
    return f'<w:p>{properties}<w:r><w:t xml:space="preserve">{text}</w:t></w:r></w:p>'


margins = '<w:pgMar w:top="1440" w:right="1080" w:bottom="1440" w:left="1800" w:header="720" w:footer="720" w:gutter="360"/>'
first = f'<w:sectPr><w:pgSz w:w="12240" w:h="15840"/>{margins}<w:vAlign w:val="center"/></w:sectPr>'
second = f'<w:sectPr><w:type w:val="oddPage"/><w:pgSz w:w="15840" w:h="12240" w:orient="landscape"/>{margins}<w:cols w:num="2" w:space="720" w:sep="1"/></w:sectPr>'
final = f'<w:sectPr><w:type w:val="continuous"/><w:pgSz w:w="15840" w:h="12240" w:orient="landscape"/>{margins}</w:sectPr>'
column_text = 'Two columns on a landscape page that begins on an odd page. ' * 6
body = (para('Section one: a portrait title page with mirrored margins.', first)
        + para(column_text)
        + '<w:p><w:r><w:t xml:space="preserve">Before a text-wrapping break </w:t></w:r><w:r><w:br w:clear="all"/></w:r><w:r><w:t>after it.</w:t></w:r></w:p>'
        + para('End of the two-column section.', second)
        + para('Section three continues on the same page in one column.')
        + final)
parts['word/document.xml'] = f'<w:document xmlns:w="{W}"><w:body>{body}</w:body></w:document>'

if __name__ == '__main__':
    if len(sys.argv) > 1:
        with ZipFile(sys.argv[1]) as z:
            root = ET.fromstring(z.read('word/document.xml'))
            settings = ET.fromstring(z.read('word/settings.xml'))
        sections = list(root.iter(f'{{{W}}}sectPr'))
        assert len(sections) == 3, len(sections)
        types = [s.find(f'{{{W}}}type') for s in sections]
        assert [t.get(f'{{{W}}}val') if t is not None else 'nextPage' for t in types] == ['nextPage', 'oddPage', 'continuous']
        assert sections[1].find(f'{{{W}}}cols').get(f'{{{W}}}sep') == '1'
        assert settings.find(f'{{{W}}}mirrorMargins') is not None
        assert any(br.get(f'{{{W}}}clear') == 'all' for br in root.iter(f'{{{W}}}br'))
        print('PASS section-layout browser export:', sys.argv[1])
    else:
        out = Path(__file__).resolve().parents[1] / 'public/fixtures/section-layout.docx'
        with ZipFile(out, 'w', ZIP_DEFLATED) as z:
            for name, text in parts.items(): z.writestr(name, '<?xml version="1.0" encoding="UTF-8"?>' + text)
        print('wrote', out)
