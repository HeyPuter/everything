"""Original OPC/XML references fixture: notes, citations, bibliography, index,
table of authorities, captions and contents entries with deliberately stale
caches. Written by hand from ECMA-376 Part 1 (§17.11, §17.16, §22.6), not by
any word processor, so tests can check that this editor reads, refreshes and
writes them independently."""
from pathlib import Path
from zipfile import ZipFile, ZipInfo, ZIP_DEFLATED
from xml.sax.saxutils import escape

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'tests/fixtures/references'
OUT.mkdir(parents=True, exist_ok=True)
W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
REL = 'http://schemas.openxmlformats.org/package/2006/relationships'
B = 'http://schemas.openxmlformats.org/officeDocument/2006/bibliography'
DS = 'http://schemas.openxmlformats.org/officeDocument/2006/customXml'
CT = 'http://schemas.openxmlformats.org/package/2006/content-types'
WML = 'application/vnd.openxmlformats-officedocument.wordprocessingml.'


def run(text, properties=''):
    return '<w:r>' + ('<w:rPr>' + properties + '</w:rPr>' if properties else '') + '<w:t xml:space="preserve">' + escape(text) + '</w:t></w:r>'


def paragraph(contents, style=None):
    return '<w:p>' + ('<w:pPr><w:pStyle w:val="' + style + '"/></w:pPr>' if style else '') + contents + '</w:p>'


def code(instruction):
    return '<w:r><w:instrText xml:space="preserve">' + escape(instruction) + '</w:instrText></w:r>'


def begin():
    return '<w:r><w:fldChar w:fldCharType="begin"/></w:r>'


def separate():
    return '<w:r><w:fldChar w:fldCharType="separate"/></w:r>'


def end():
    return '<w:r><w:fldChar w:fldCharType="end"/></w:r>'


def inline_field(instruction, cache):
    return begin() + code(instruction) + separate() + run(cache) + end()


def entry(instruction):
    """XE, TA and TC entries have no result (no separate delimiter)."""
    return begin() + code(instruction) + end()


def note_reference(kind, identifier, custom=False):
    flag = ' w:customMarkFollows="1"' if custom else ''
    return '<w:r><w:rPr><w:vertAlign w:val="superscript"/></w:rPr><w:' + kind + 'Reference' + flag + ' w:id="' + str(identifier) + '"/></w:r>'


def block_field(instruction, lines, style=None):
    """A field whose result spans whole paragraphs: begin in the first, end in the last."""
    out = []
    for i, line in enumerate(lines):
        contents = (begin() + code(instruction) + separate() if i == 0 else '') + run(line) + (end() if i == len(lines) - 1 else '')
        out.append(paragraph(contents, style))
    return ''.join(out)


body = ''
body += paragraph(run('Reference fixture'), 'Heading1')
body += block_field(r' TOC \o "1-2" \t "Subtitle,2" \f C \h \z \u ', ['Stale contents entry\t9'])
body += paragraph(run('Notes and citations'), 'Heading1')
body += paragraph(run('Engines compute') + note_reference('footnote', 1) + run(' and machines learn') + note_reference('endnote', 1) + run(' ') + inline_field(' CITATION Lov20 \\l 1033 \\p 4 ', '(stale citation)') + run('.'))
body += paragraph(run('A dagger note') + note_reference('footnote', 2, custom=True) + run('*', '<w:vertAlign w:val="superscript"/>') + run(' and a second numbered note') + '<w:bookmarkStart w:id="1" w:name="_RefNote"/>' + note_reference('footnote', 3) + '<w:bookmarkEnd w:id="1"/>' + run('; see note ') + inline_field(' NOTEREF _RefNote \\h ', '9') + run('.'))
body += paragraph(run('Plain subtitle entry'), 'Subtitle')
body += paragraph(run('Index and authorities'), 'Heading1')
body += paragraph(run('Mercury') + entry(' XE "Mercury:planet" ') + run(' and Venus') + entry(' XE "Venus" \\b ') + run(' orbit. ') + entry(' TC "Hidden contents entry" \\f C \\l 2 '))
body += paragraph(run('As held in Smith v. Jones, 1 U.S. 1 (1999)') + entry(' TA \\l "Smith v. Jones, 1 U.S. 1 (1999)" \\s "Smith v. Jones" \\c 1 ') + run(' and again in Smith v. Jones') + entry(' TA \\s "Smith v. Jones" ') + run('.'))
body += paragraph(run('Figure ') + '<w:fldSimple w:instr=" SEQ Figure \\* ARABIC "><w:r><w:t>7</w:t></w:r></w:fldSimple>' + run(': Orbits'), 'Caption')
body += block_field(r' INDEX \h "A" \c "1" \z "1033" ', ['Stale index'])
body += block_field(r' TOA \h \c "1" \p ', ['Stale authorities'])
body += block_field(r' BIBLIOGRAPHY \l 1033 ', ['Stale bibliography'])
body += '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>'
document = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="' + W + '" xmlns:r="' + R + '"><w:body>' + body + '</w:body></w:document>'


def notes(kind, items):
    sep = lambda t, i, mark: '<w:' + kind + ' w:type="' + t + '" w:id="' + str(i) + '"><w:p><w:r><w:' + mark + '/></w:r></w:p></w:' + kind + '>'
    out = sep('separator', -1, 'separator') + sep('continuationSeparator', 0, 'continuationSeparator')
    for identifier, own, text in items:
        mark = '<w:r><w:rPr><w:vertAlign w:val="superscript"/></w:rPr><w:' + kind + 'Ref/></w:r>' if own else run('*', '<w:vertAlign w:val="superscript"/>')
        out += '<w:' + kind + ' w:id="' + str(identifier) + '"><w:p><w:pPr><w:pStyle w:val="NoteText"/></w:pPr>' + mark + run(' ' + text) + '</w:p></w:' + kind + '>'
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:' + kind + 's xmlns:w="' + W + '">' + out + '</w:' + kind + 's>'


styles = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="' + W + '">' + ''.join([
    '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>',
    '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="32"/></w:rPr></w:style>',
    '<w:style w:type="paragraph" w:styleId="Subtitle"><w:name w:val="Subtitle"/><w:basedOn w:val="Normal"/></w:style>',
    '<w:style w:type="paragraph" w:styleId="Caption"><w:name w:val="caption"/><w:basedOn w:val="Normal"/><w:rPr><w:i/></w:rPr></w:style>',
    '<w:style w:type="paragraph" w:styleId="NoteText"><w:name w:val="footnote text"/><w:basedOn w:val="Normal"/><w:rPr><w:sz w:val="20"/></w:rPr></w:style>',
]) + '</w:styles>'
settings = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:settings xmlns:w="' + W + '"><w:defaultTabStop w:val="720"/><w:footnotePr><w:numFmt w:val="upperRoman"/><w:numStart w:val="2"/><w:footnote w:id="-1"/><w:footnote w:id="0"/></w:footnotePr><w:endnotePr><w:pos w:val="docEnd"/><w:numFmt w:val="decimal"/><w:endnote w:id="-1"/><w:endnote w:id="0"/></w:endnotePr></w:settings>'
sources = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Sources xmlns="' + B + '" SelectedStyle="harvard" StyleName="Harvard Author-Date">' + ''.join([
    '<Source><Tag>Lov20</Tag><SourceType>Book</SourceType><Author><Author><NameList><Person><Last>Lovelace</Last><First>Ada</First></Person></NameList></Author></Author><Title>Notes on engines</Title><Year>2020</Year><City>London</City><Publisher>Harbor Press</Publisher></Source>',
    '<Source><Tag>Hop19</Tag><SourceType>JournalArticle</SourceType><Author><Author><NameList><Person><Last>Hopper</Last><First>Grace</First></Person></NameList></Author></Author><Title>Compilers</Title><JournalName>Machine Review</JournalName><Year>2019</Year><Volume>4</Volume><Issue>2</Issue><Pages>1-9</Pages></Source>',
]) + '</Sources>'
props = '<?xml version="1.0" encoding="UTF-8" standalone="no"?><ds:datastoreItem ds:itemID="{6F1A2B3C-4D5E-4F60-8172-93A4B5C6D7E8}" xmlns:ds="' + DS + '"><ds:schemaRefs><ds:schemaRef ds:uri="' + B + '"/></ds:schemaRefs></ds:datastoreItem>'
rels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="' + REL + '">' + ''.join([
    '<Relationship Id="rStyles" Type="' + R + '/styles" Target="styles.xml"/>',
    '<Relationship Id="rSettings" Type="' + R + '/settings" Target="settings.xml"/>',
    '<Relationship Id="rFootnotes" Type="' + R + '/footnotes" Target="footnotes.xml"/>',
    '<Relationship Id="rEndnotes" Type="' + R + '/endnotes" Target="endnotes.xml"/>',
    '<Relationship Id="rBibliography" Type="' + R + '/customXml" Target="../customXml/item1.xml"/>',
]) + '</Relationships>'
types = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="' + CT + '"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' + ''.join(
    '<Override PartName="' + name + '" ContentType="' + kind + '"/>' for name, kind in [
        ('/word/document.xml', WML + 'document.main+xml'), ('/word/styles.xml', WML + 'styles+xml'), ('/word/settings.xml', WML + 'settings+xml'),
        ('/word/footnotes.xml', WML + 'footnotes+xml'), ('/word/endnotes.xml', WML + 'endnotes+xml'),
        ('/customXml/itemProps1.xml', 'application/vnd.openxmlformats-officedocument.customXmlProperties+xml')]) + '</Types>'
package_rels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="' + REL + '"><Relationship Id="rDocument" Type="' + R + '/officeDocument" Target="word/document.xml"/></Relationships>'
item_rels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="' + REL + '"><Relationship Id="rProps" Type="' + R + '/customXmlProps" Target="itemProps1.xml"/></Relationships>'

parts = {
    '[Content_Types].xml': types, '_rels/.rels': package_rels, 'word/document.xml': document, 'word/_rels/document.xml.rels': rels,
    'word/styles.xml': styles, 'word/settings.xml': settings,
    'word/footnotes.xml': notes('footnote', [(1, True, 'First footnote.'), (2, False, 'Custom-marked footnote.'), (3, True, 'Third footnote.')]),
    'word/endnotes.xml': notes('endnote', [(1, True, 'Only endnote.')]),
    'customXml/item1.xml': sources, 'customXml/itemProps1.xml': props, 'customXml/_rels/item1.xml.rels': item_rels,
}
with ZipFile(OUT / 'references.docx', 'w', ZIP_DEFLATED) as archive:
    for name, text in parts.items():
        # A fixed timestamp keeps the fixture byte-for-byte reproducible.
        archive.writestr(ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0)), text, compress_type=ZIP_DEFLATED)
print(OUT / 'references.docx')
