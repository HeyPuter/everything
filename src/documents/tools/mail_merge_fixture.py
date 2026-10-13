"""Original OPC/XML mail merge fixtures, written by hand from ECMA-376 Part 1.

letter.docx: a form-letter main document with simple and complex MERGEFIELDs,
ADDRESSBLOCK and GREETINGLINE fields whose instructions span lines, IF and
SKIPIF rules whose operands are nested MERGEFIELDs (with stale cached
results), a field inside a table cell, and a w:mailMerge settings block
(§17.14) linked to an external data source with ODSO field mappings.

labels.docx: a label main document: a fixed table of label cells whose later
cells begin with NEXT.

recipients.xlsx / recipients.csv: recipient data with shared and inline
strings, a date-formatted serial number, a boolean, quoted commas and line
breaks, and a byte order mark.
"""
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
from xml.sax.saxutils import escape, quoteattr

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'tests/fixtures/mail-merge'
OUT.mkdir(parents=True, exist_ok=True)
W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
REL = 'http://schemas.openxmlformats.org/package/2006/relationships'


def run(text, properties=''):
    return '<w:r>' + ('<w:rPr>' + properties + '</w:rPr>' if properties else '') + '<w:t xml:space="preserve">' + escape(text) + '</w:t></w:r>'


def paragraph(contents, properties=''):
    return '<w:p><w:pPr><w:spacing w:before="0" w:after="120"/>' + properties + '</w:pPr>' + contents + '</w:p>'


def begin():
    return '<w:r><w:fldChar w:fldCharType="begin"/></w:r>'


def code(text):
    return '<w:r><w:instrText xml:space="preserve">' + escape(text) + '</w:instrText></w:r>'


def separate():
    return '<w:r><w:fldChar w:fldCharType="separate"/></w:r>'


def end():
    return '<w:r><w:fldChar w:fldCharType="end"/></w:r>'


def field(instruction, cache, properties='<w:noProof/>'):
    return begin() + code(instruction) + separate() + run(cache, properties) + end()


def simple(instruction, cache):
    return '<w:fldSimple w:instr=' + quoteattr(instruction) + '>' + run(cache, '<w:noProof/>') + '</w:fldSimple>'


address_format = '<<_TITLE0_ >><<_FIRST0_>><< _LAST0_>>\n<<_COMPANY_\n>><<_STREET1_\n>><<_STREET2_\n>><<_CITY_>><<, _STATE_>><< _POSTAL_>><<\n_COUNTRY_>>'
address = begin() + code(' ADDRESSBLOCK \\f "' + address_format.split('\n')[0] + '\n') + code('\n'.join(address_format.split('\n')[1:]) + '" \\c 1 \\e "United States" ') + separate() + run('«AddressBlock»', '<w:noProof/>') + end()
greeting = field(' GREETINGLINE \\f "<<_BEFORE_ Dear >><<_TITLE0_ >><<_LAST0_>><<_AFTER_ ,>>" \\e "Dear Customer," ', '«GreetingLine»')
nested_if = begin() + code(' IF "') + field(' MERGEFIELD City ', 'Lisbon') + code('" = "Oslo" "See you at the fjord." "See you soon." ') + separate() + run('See you soon.') + end()
skip = begin() + code(' SKIPIF ') + field(' MERGEFIELD Status ', 'active') + code(' = "inactive" ') + separate() + end()

body = paragraph(skip + run('Account review'), '<w:jc w:val="right"/>')
body += paragraph(address)
body += paragraph(greeting)
body += paragraph(run('Your order ships to ') + simple(' MERGEFIELD City ', '«City»') + run(' on ') + field(' MERGEFIELD "Ship Date" \\@ "MMMM d, yyyy" ', '«Ship Date»') + run('.'))
body += paragraph(nested_if)
body += ('<w:tbl><w:tblPr><w:tblW w:w="6000" w:type="dxa"/><w:tblLayout w:type="fixed"/></w:tblPr><w:tblGrid><w:gridCol w:w="3000"/><w:gridCol w:w="3000"/></w:tblGrid><w:tr>'
         + '<w:tc><w:tcPr><w:tcW w:w="3000" w:type="dxa"/></w:tcPr>' + paragraph(run('Balance')) + '</w:tc>'
         + '<w:tc><w:tcPr><w:tcW w:w="3000" w:type="dxa"/></w:tcPr>' + paragraph(field(' MERGEFIELD Balance \\# "$#,##0.00" ', '«Balance»')) + '</w:tc></w:tr></w:tbl>')
body += paragraph(run('Record ') + field(' MERGEREC ', '«Merge Record #»'))
body += '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>'

settings = ('<w:settings xmlns:w="' + W + '" xmlns:r="' + R + '"><w:mailMerge><w:mainDocumentType w:val="formLetters"/><w:linkToQuery/>'
            '<w:dataType w:val="textFile"/><w:connectString w:val=""/><w:query w:val="SELECT * FROM contacts.csv"/><w:dataSource r:id="rMergeSource"/>'
            '<w:viewMergedData/><w:activeRecord w:val="2"/><w:odso><w:udl w:val="Provider=Text"/><w:table w:val="contacts.csv"/><w:src r:id="rMergeSource"/><w:colDelim w:val="44"/><w:type w:val="text"/><w:fHdr/>'
            '<w:fieldMapData><w:type w:val="dbColumn"/><w:name w:val="Given"/><w:mappedName w:val="First Name"/><w:column w:val="1"/><w:lid w:val="en-US"/></w:fieldMapData>'
            '</w:odso></w:mailMerge><w:defaultTabStop w:val="720"/><w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat></w:settings>')


def package(document_body, settings_xml, settings_rels=None):
    overrides = [('document', 'document.main'), ('styles', 'styles'), ('settings', 'settings')]
    parts = {
        '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' + ''.join('<Override PartName="/word/' + name + '.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.' + kind + '+xml"/>' for name, kind in overrides) + '</Types>',
        '_rels/.rels': '<Relationships xmlns="' + REL + '"><Relationship Id="main" Type="' + R + '/officeDocument" Target="word/document.xml"/></Relationships>',
        'word/_rels/document.xml.rels': '<Relationships xmlns="' + REL + '">' + ''.join('<Relationship Id="' + name + '" Type="' + R + '/' + name + '" Target="' + name + '.xml"/>' for name in ['styles', 'settings']) + '</Relationships>',
        'word/document.xml': '<w:document xmlns:w="' + W + '"><w:body>' + document_body + '</w:body></w:document>',
        'word/styles.xml': '<w:styles xmlns:w="' + W + '"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial"/><w:sz w:val="22"/></w:rPr></w:rPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style></w:styles>',
        'word/settings.xml': settings_xml,
    }
    if settings_rels:
        parts['word/_rels/settings.xml.rels'] = settings_rels
    return parts


def write(name, parts):
    with ZipFile(OUT / name, 'w', ZIP_DEFLATED) as archive:
        for part, content in parts.items():
            archive.writestr(part, content.encode('utf-8') if isinstance(content, str) else content)


write('letter.docx', package(body, settings, '<Relationships xmlns="' + REL + '"><Relationship Id="rMergeSource" Type="' + R + '/mailMergeSource" Target="file:///C:/Data/contacts.csv" TargetMode="External"/></Relationships>'))

# Labels: 2 columns x 3 rows of 2 x 4 in labels with a 0.25 in gap column.
cell = lambda width, contents: '<w:tc><w:tcPr><w:tcW w:w="' + str(width) + '" w:type="dxa"/></w:tcPr>' + contents + '</w:tc>'
label = lambda first: paragraph(('' if first else field(' NEXT ', '«Next Record»')) + field(' MERGEFIELD "First Name" ', '«First Name»') + run(' ') + field(' MERGEFIELD City ', '«City»'))
rows = ''
for r in range(3):
    rows += '<w:tr><w:trPr><w:trHeight w:val="2880" w:hRule="exact"/></w:trPr>' + cell(5760, label(r == 0)) + cell(360, paragraph('')) + cell(5760, label(False)) + '</w:tr>'
labels_body = ('<w:tbl><w:tblPr><w:tblW w:w="11880" w:type="dxa"/><w:tblLayout w:type="fixed"/><w:tblCellMar><w:left w:w="72" w:type="dxa"/><w:right w:w="72" w:type="dxa"/></w:tblCellMar></w:tblPr>'
               '<w:tblGrid><w:gridCol w:w="5760"/><w:gridCol w:w="360"/><w:gridCol w:w="5760"/></w:tblGrid>' + rows + '</w:tbl>' + paragraph('')
               + '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="720" w:right="180" w:bottom="0" w:left="180" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>')
write('labels.docx', package(labels_body, '<w:settings xmlns:w="' + W + '"><w:mailMerge><w:mainDocumentType w:val="mailingLabels"/><w:dataType w:val="textFile"/></w:mailMerge></w:settings>'))

# A small workbook: headings in shared strings, a date-styled serial, a boolean, an inline string and a gap column.
S = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
strings = ['First Name', 'Last Name', 'City', 'Ship Date', 'Member', 'Balance', 'Rosa', 'Vidal', 'Oslo', 'Ken', 'Ito', 'Austin']
sst = '<sst xmlns="' + S + '" count="' + str(len(strings)) + '" uniqueCount="' + str(len(strings)) + '">' + ''.join('<si><t>' + escape(s) + '</t></si>' for s in strings) + '</sst>'
def s(ref, i): return '<c r="' + ref + '" t="s"><v>' + str(i) + '</v></c>'
sheet = ('<worksheet xmlns="' + S + '"><sheetData>'
         '<row r="1">' + s('A1', 0) + s('B1', 1) + s('C1', 2) + s('D1', 3) + s('E1', 4) + s('F1', 5) + '</row>'
         '<row r="2">' + s('A2', 6) + s('B2', 7) + s('C2', 8) + '<c r="D2" s="1"><v>46082</v></c><c r="E2" t="b"><v>1</v></c><c r="F2"><v>1234.5</v></c></row>'
         '<row r="4">' + s('A4', 9) + s('B4', 10) + s('C4', 11) + '<c r="D4" s="1"><v>46083.5</v></c><c r="E4" t="b"><v>0</v></c><c r="F4" t="inlineStr"><is><t>n/a</t></is></c></row>'
         '</sheetData></worksheet>')
styles = '<styleSheet xmlns="' + S + '"><numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy\\-mm\\-dd"/></numFmts><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="164" applyNumberFormat="1"/></cellXfs></styleSheet>'
workbook = '<workbook xmlns="' + S + '" xmlns:r="' + R + '"><sheets><sheet name="Contacts" sheetId="1" r:id="rSheet1"/></sheets></workbook>'
xlsx = {
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>',
    '_rels/.rels': '<Relationships xmlns="' + REL + '"><Relationship Id="rId1" Type="' + R + '/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    'xl/_rels/workbook.xml.rels': '<Relationships xmlns="' + REL + '"><Relationship Id="rSheet1" Type="' + R + '/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rStrings" Type="' + R + '/sharedStrings" Target="sharedStrings.xml"/><Relationship Id="rStyles" Type="' + R + '/styles" Target="styles.xml"/></Relationships>',
    'xl/workbook.xml': workbook,
    'xl/worksheets/sheet1.xml': sheet,
    'xl/sharedStrings.xml': sst,
    'xl/styles.xml': styles,
}
write('recipients.xlsx', xlsx)

csv = '\ufeffTitle,First Name,Last Name,Company,Address Line 1,City,State,ZIP Code,Country,Email\r\n'
csv += 'Ms.,Rosa,Vidal,"Tide Works, Ltd.",1 Pier Rd,Oslo,,0150,Norway,rosa@example.com\r\n'
csv += ',Ken,Ito,,"9 Elm St\nApt 4",Austin,TX,78701,United States,ken@example.com\r\n'
csv += 'Dr.,Ana,"Silva ""Nana""",,15 Rua Nova,Lima,,15001,Peru,\r\n'
(OUT / 'recipients.csv').write_bytes(csv.encode('utf-8'))
