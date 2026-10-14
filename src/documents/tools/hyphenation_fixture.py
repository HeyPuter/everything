"""Independent hyphenation fixture (public/fixtures/hyphenation.docx), written here by hand from
ECMA-376 Part 1 §17.15.1 (autoHyphenation, consecutiveHyphenLimit, hyphenationZone,
doNotHyphenateCaps) and §17.3.1 (suppressAutoHyphens). Original text; no other editor produced it.
Run: python3 tools/hyphenation_fixture.py"""
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
from xml.sax.saxutils import escape
ROOT = Path(__file__).resolve().parents[1]
W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
REL = 'http://schemas.openxmlformats.org/package/2006/relationships'
TEXT = ('Automatic hyphenation divides longer words at the ends of lines, so justified paragraphs keep '
        'comfortable spacing. Communication, organization, responsibility and international documentation '
        'are typical candidates; the document text itself never changes.')

def run(text, props=''):
    parts = escape(text).replace('­', '</w:t></w:r><w:r>' + props + '<w:softHyphen/></w:r><w:r>' + props + '<w:t xml:space="preserve">')
    return f'<w:r>{props}<w:t xml:space="preserve">{parts}</w:t></w:r>'

def para(content, ppr=''):
    return f'<w:p><w:pPr>{ppr}<w:jc w:val="both"/></w:pPr>{content}</w:p>'

heading = lambda text: f'<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr>{run(text)}</w:p>'
body = ''.join([
    heading('Automatic hyphenation'),
    para(run(TEXT)),
    heading('A paragraph that is not hyphenated'),
    para(run(TEXT), '<w:suppressAutoHyphens/>'),
    heading('Words in capitals'),
    para(run('INTERNATIONAL COMMUNICATION ORGANIZATIONS RESPONSIBILITY DOCUMENTATION CONFIDENTIAL INFORMATION')),
    heading('Another language'),
    para(run('Donaudampfschifffahrtsgesellschaftskapitän Rechtsschutzversicherungsgesellschaften Kraftfahrzeughaftpflichtversicherung', '<w:rPr><w:lang w:val="de-DE"/></w:rPr>')),
    heading('Manual soft hyphens and nonbreaking hyphens'),
    para(run('Manual soft hyphens: extra­ordinary super­califragilistic counter­revolutionary, kept exactly as written. ')
         + '<w:r><w:t>Nonbreaking</w:t></w:r><w:r><w:noBreakHyphen/></w:r><w:r><w:t xml:space="preserve">hyphen stays together.</w:t></w:r>'),
])
body += ('<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="4320" w:bottom="1440" w:left="1440" '
         'w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>')
settings = (f'<w:settings xmlns:w="{W}"><w:zoom w:percent="100"/><w:defaultTabStop w:val="720"/><w:autoHyphenation/>'
            '<w:consecutiveHyphenLimit w:val="2"/><w:hyphenationZone w:val="284"/><w:doNotHyphenateCaps/>'
            '<w:characterSpacingControl w:val="doNotCompress"/></w:settings>')
styles = (f'<w:styles xmlns:w="{W}"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Liberation Serif" w:hAnsi="Liberation Serif"/>'
          '<w:sz w:val="24"/><w:lang w:val="en-US"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="264" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>'
          '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>'
          '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/>'
          '<w:pPr><w:keepNext/><w:spacing w:before="240" w:after="80"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="28"/></w:rPr></w:style></w:styles>')
parts = {
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/></Types>',
    '_rels/.rels': f'<Relationships xmlns="{REL}"><Relationship Id="main" Type="{R}/officeDocument" Target="word/document.xml"/></Relationships>',
    'word/_rels/document.xml.rels': f'<Relationships xmlns="{REL}"><Relationship Id="styles" Type="{R}/styles" Target="styles.xml"/><Relationship Id="settings" Type="{R}/settings" Target="settings.xml"/></Relationships>',
    'word/document.xml': f'<w:document xmlns:w="{W}"><w:body>{body}</w:body></w:document>',
    'word/styles.xml': styles,
    'word/settings.xml': settings,
}
with ZipFile(ROOT / 'public/fixtures/hyphenation.docx', 'w', ZIP_DEFLATED) as z:
    for name, data in parts.items():
        z.writestr(name, data)
