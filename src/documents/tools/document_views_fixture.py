"""Independent outline-view package: w:view, heading styles with outline levels and a direct level.

Written from the ECMA-376 schema (settings §17.15.1.92 w:view, paragraph §17.3.1.20 w:outlineLvl),
not exported by this editor, so opening it checks the reader rather than a round trip of the writer.
"""
from pathlib import Path
from zipfile import ZipFile, ZipInfo, ZIP_DEFLATED

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'tests/fixtures/document-views'
OUT.mkdir(parents=True, exist_ok=True)
W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'


def para(text, style=None, level=None, page_break=False):
    ppr = ''
    if style or level is not None:
        ppr = '<w:pPr>' + (f'<w:pStyle w:val="{style}"/>' if style else '') + (f'<w:outlineLvl w:val="{level}"/>' if level is not None else '') + '</w:pPr>'
    brk = '<w:r><w:br w:type="page"/></w:r>' if page_break else ''
    return f'<w:p>{ppr}<w:r><w:t xml:space="preserve">{text}</w:t></w:r>{brk}</w:p>'


def heading_style(n, size):
    return (f'<w:style w:type="paragraph" w:styleId="Heading{n}"><w:name w:val="heading {n}"/><w:basedOn w:val="Normal"/>'
            f'<w:next w:val="Normal"/><w:pPr><w:keepNext/><w:outlineLvl w:val="{n - 1}"/></w:pPr><w:rPr><w:b/><w:sz w:val="{size}"/></w:rPr></w:style>')


def package(name, view, body):
    parts = {
        '[Content_Types].xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>'
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
        '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>'
        '<Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/></Types>',
        '_rels/.rels': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
        'word/_rels/document.xml.rels': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
        '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/></Relationships>',
        'word/styles.xml': f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="{W}">'
        '<w:docDefaults><w:rPrDefault><w:rPr><w:sz w:val="22"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120"/></w:pPr></w:pPrDefault></w:docDefaults>'
        '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>'
        + heading_style(1, 32) + heading_style(2, 28) + heading_style(3, 24) + '</w:styles>',
        'word/settings.xml': f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:settings xmlns:w="{W}"><w:view w:val="{view}"/><w:zoom w:percent="100"/><w:defaultTabStop w:val="720"/></w:settings>',
        'word/document.xml': f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="{W}" xmlns:r="{R}"><w:body>{body}'
        '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>',
    }
    with ZipFile(OUT / name, 'w') as out:
        for part, data in parts.items():
            entry = ZipInfo(part, (2026, 10, 13, 0, 0, 0)); entry.compress_type = ZIP_DEFLATED
            out.writestr(entry, data.encode())


package('outline.docx', 'outline', ''.join([
    para('Plan', 'Heading1'), para('Why we plan at all.'),
    para('Goals', 'Heading2'), para('Ship the outline view.'),
    para('Risks', 'Heading2'), para('A direct level three note', level=2), para('Scope creep.'),
    para('Schedule', 'Heading1'), para('Two weeks.', page_break=True), para('After the break.'),
]))
package('normal.docx', 'normal', para('Draft text before a break.', page_break=True) + para('Draft text after it.'))
