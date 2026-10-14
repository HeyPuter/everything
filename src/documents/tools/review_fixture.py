"""Independently generated Review fixtures: protection with a password verifier, permission
ranges, tracked moves and formatting changes, proofing languages, documents to compare, and a
document with accessibility problems. Written directly from ECMA-376 Part 1; no editor code is used.

Run: python3 tools/review_fixture.py  (writes tests/fixtures/review/*.docx deterministically)
"""
import base64, hashlib, struct, zlib
from pathlib import Path
from zipfile import ZipFile, ZipInfo, ZIP_DEFLATED

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'tests/fixtures/review'
OUT.mkdir(parents=True, exist_ok=True)
W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'

# ---- The password verifier (ECMA-376 Part 1 §17.15.1.29, legacy-compatible key first) ----
CODES = [0xE1F0, 0x1D0F, 0xCC9C, 0x84C0, 0x110C, 0x0E10, 0xF1CE, 0x313E, 0x1872, 0xE139, 0xD40F, 0x84F9, 0x280C, 0xA96A, 0x4EC3]
SEEDS = [0xAEFC, 0x7B61, 0x4563, 0x0375, 0xD849, 0x6F45, 0xEB23, 0x47D3, 0xB861, 0x45A0, 0xAA51, 0x76B4, 0x3730, 0x3331, 0x1021]
def row(seed):
    out = [seed]
    while len(out) < 7:
        v = out[-1]
        out.append(((v << 1) & 0xFFFF) ^ (0x1021 if v & 0x8000 else 0))
    return out
MATRIX = [row(s) for s in SEEDS]
def legacy_key(password):
    units = [int.from_bytes(password.encode('utf-16-le')[i:i + 2], 'little') for i in range(0, len(password.encode('utf-16-le')), 2)][:15]
    data = [(u & 0xFF) or (u >> 8) for u in units]
    if not data:
        return 0
    high = CODES[len(data) - 1]
    for i, c in enumerate(data):
        for bit in range(7):
            if c & (1 << bit):
                high ^= MATRIX[15 - len(data) + i][bit]
    low = 0
    for c in reversed(data):
        low = (((low >> 14) & 1) | ((low << 1) & 0x7FFF)) ^ c
    low = (((low >> 14) & 1) | ((low << 1) & 0x7FFF)) ^ len(data) ^ 0xCE4B
    return ((high << 16) | low) & 0xFFFFFFFF
def verifier(password, salt, spin=100000):
    data = struct.pack('<I', legacy_key(password)).hex().upper().encode('utf-16-le')
    digest = hashlib.sha512(salt + data).digest()
    for i in range(spin):
        digest = hashlib.sha512(digest + struct.pack('<I', i)).digest()
    return base64.b64encode(digest).decode(), base64.b64encode(salt).decode()

# ---- Packaging ----
def package(name, document, *, settings=None, styles=None, extra=None, rels=(), types=()):
    parts = {
        '[Content_Types].xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
        + ('<Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>' if settings is not None else '')
        + ('<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' if styles is not None else '')
        + '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>'
        + ''.join(types) + '</Types>',
        '_rels/.rels': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>',
        'word/_rels/document.xml.rels': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        + ('<Relationship Id="rIdSettings" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/>' if settings is not None else '')
        + ('<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' if styles is not None else '')
        + ''.join(rels) + '</Relationships>',
        'docProps/core.xml': f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:creator>{extra.pop("creator", "Fixture Author") if extra else "Fixture Author"}</dc:creator></cp:coreProperties>',
        'word/document.xml': f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="{W}" xmlns:r="{R}"><w:body>{document}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>',
    }
    if settings is not None:
        parts['word/settings.xml'] = f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:settings xmlns:w="{W}">{settings}<w:defaultTabStop w:val="720"/></w:settings>'
    if styles is not None:
        parts['word/styles.xml'] = f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="{W}">{styles}</w:styles>'
    for key, value in (extra or {}).items():
        parts[key] = value
    with ZipFile(OUT / name, 'w') as archive:
        for part, data in parts.items():
            entry = ZipInfo(part, (2026, 10, 13, 0, 0, 0)); entry.compress_type = ZIP_DEFLATED
            archive.writestr(entry, data if isinstance(data, bytes) else data.encode('utf-8'))

STYLES = ('<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Noto Sans" w:hAnsi="Noto Sans"/><w:sz w:val="22"/><w:lang w:val="en-US"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="160"/></w:pPr></w:pPrDefault></w:docDefaults>'
          '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>'
          '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="32"/></w:rPr></w:style>'
          '<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:sz w:val="28"/></w:rPr></w:style>'
          '<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:outlineLvl w:val="2"/></w:pPr><w:rPr><w:b/></w:rPr></w:style>'
          '<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:rPr><w:color w:val="0563C1"/><w:u w:val="single"/></w:rPr></w:style>')
def p(text, ppr='', rpr=''):
    return f'<w:p>{f"<w:pPr>{ppr}</w:pPr>" if ppr else ""}<w:r>{f"<w:rPr>{rpr}</w:rPr>" if rpr else ""}<w:t xml:space="preserve">{text}</w:t></w:r></w:p>'
DATE = '2026-10-01T09:00:00Z'

# 1. Protected: read only with a password ("secret"), an editable region for everyone.
hash_value, salt_value = verifier('secret', bytes(range(1, 17)))
package('protected.docx',
    p('Policy title', '<w:pStyle w:val="Heading1"/>')
    + '<w:p><w:r><w:t xml:space="preserve">This sentence is protected. </w:t></w:r><w:permStart w:id="1" w:edGrp="everyone"/><w:r><w:t>Anyone may edit this part.</w:t></w:r><w:permEnd w:id="1"/></w:p>'
    + p('The closing paragraph is protected too.'),
    settings=f'<w:documentProtection w:edit="readOnly" w:enforcement="1" w:algorithmName="SHA-512" w:hashValue="{hash_value}" w:saltValue="{salt_value}" w:spinCount="100000"/>',
    styles=STYLES)

# 2. Tracked: an insertion, a deletion, a move, a run and a paragraph formatting change, languages.
package('tracked.docx',
    '<w:p><w:pPr><w:jc w:val="center"/><w:pPrChange w:id="10" w:author="Ada" w:date="' + DATE + '"><w:pPr/></w:pPrChange></w:pPr><w:r><w:t xml:space="preserve">Centered by Ada. </w:t></w:r><w:ins w:id="11" w:author="Ada" w:date="' + DATE + '"><w:r><w:t xml:space="preserve">Added words. </w:t></w:r></w:ins><w:del w:id="12" w:author="Grace" w:date="' + DATE + '"><w:r><w:delText xml:space="preserve">Removed words. </w:delText></w:r></w:del></w:p>'
    + '<w:p><w:moveFromRangeStart w:id="13" w:name="move1" w:author="Grace" w:date="' + DATE + '"/><w:moveFrom w:id="14" w:author="Grace" w:date="' + DATE + '"><w:r><w:t xml:space="preserve">Travelling sentence. </w:t></w:r></w:moveFrom><w:moveFromRangeEnd w:id="13"/><w:r><w:t xml:space="preserve">Staying sentence. </w:t></w:r><w:r><w:rPr><w:b/><w:rPrChange w:id="15" w:author="Grace" w:date="' + DATE + '"><w:rPr/></w:rPrChange></w:rPr><w:t>Bolded by Grace.</w:t></w:r></w:p>'
    + '<w:p><w:r><w:t xml:space="preserve">Ending. </w:t></w:r><w:moveToRangeStart w:id="16" w:name="move1" w:author="Grace" w:date="' + DATE + '"/><w:moveTo w:id="17" w:author="Grace" w:date="' + DATE + '"><w:r><w:t xml:space="preserve">Travelling sentence. </w:t></w:r></w:moveTo><w:moveToRangeEnd w:id="16"/></w:p>'
    + '<w:p><w:r><w:t xml:space="preserve">English text, then </w:t></w:r><w:r><w:rPr><w:lang w:val="fr-FR"/></w:rPr><w:t xml:space="preserve">un texte français, </w:t></w:r><w:r><w:rPr><w:noProof/></w:rPr><w:t>xyzzyplugh</w:t></w:r></w:p>',
    settings='<w:trackRevisions/>', styles=STYLES)

# 3. Compare: an original and a revised copy with a table.
def table(rows):
    grid = ''.join('<w:gridCol w:w="3000"/>' for _ in rows[0])
    body = ''.join('<w:tr>' + ''.join(f'<w:tc><w:tcPr><w:tcW w:w="3000" w:type="dxa"/></w:tcPr>{p(cell)}</w:tc>' for cell in r) + '</w:tr>' for r in rows)
    return f'<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid>{grid}</w:tblGrid>{body}</w:tbl>'
package('original.docx',
    p('Quarterly report', '<w:pStyle w:val="Heading1"/>') + p('Sales grew by ten percent this quarter.') + p('The team hired two engineers.')
    + table([['Region', 'Sales'], ['North', '120'], ['South', '80']]) + p('We expect steady growth next year.'),
    styles=STYLES, extra={'creator': 'Original Author'})
package('revised.docx',
    p('Quarterly report', '<w:pStyle w:val="Heading1"/>') + p('Sales grew by twelve percent this quarter.') + p('The team hired three engineers and a designer.')
    + table([['Region', 'Sales'], ['North', '125'], ['South', '80'], ['West', '40']]) + p('We expect strong growth next year.') + p('Questions go to the finance team.'),
    styles=STYLES, extra={'creator': 'Rae Viewer'})

# 4. Accessibility: a picture without a description, a table without a header row, low contrast,
# empty paragraphs for spacing, a skipped heading level, an unclear link, repeated spaces.
def png():
    raw = b''.join(b'\x00' + b'\x33\x66\x99' * 4 for _ in range(4))
    chunk = lambda kind, data: struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data) & 0xffffffff)
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', 4, 4, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b'')
picture = ('<w:p><w:r><w:drawing><wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" distT="0" distB="0" distL="0" distR="0"><wp:extent cx="457200" cy="457200"/><wp:docPr id="1" name="Picture 1"/>'
           '<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="1" name="Picture 1"/><pic:cNvPicPr/></pic:nvPicPr>'
           f'<pic:blipFill><a:blip r:embed="rIdImage"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="457200" cy="457200"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>')
package('accessibility.docx',
    p('Accessible report', '<w:pStyle w:val="Heading1"/>') + p('Details', '<w:pStyle w:val="Heading3"/>')
    + picture + p('Pale text that is hard to read.', rpr='<w:color w:val="DDDDDD"/>')
    + '<w:p/><w:p/><w:p/>'
    + '<w:p><w:r><w:t xml:space="preserve">For more, </w:t></w:r><w:hyperlink r:id="rIdLink"><w:r><w:rPr><w:rStyle w:val="Hyperlink"/></w:rPr><w:t>click here</w:t></w:r></w:hyperlink><w:r><w:t xml:space="preserve">.     Spaced out.</w:t></w:r></w:p>'
    + table([['Name', 'Score'], ['Ana', '9'], ['', '']]) + p('End of report.'),
    styles=STYLES,
    rels=('<Relationship Id="rIdImage" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/>',
          '<Relationship Id="rIdLink" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com/report" TargetMode="External"/>'),
    extra={'word/media/image1.png': png()})
print('wrote', sorted(path.name for path in OUT.glob('*.docx')))
