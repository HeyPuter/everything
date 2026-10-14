"""Write tests/fixtures/core-properties/properties.docx: an original one-paragraph package whose
docProps/core.xml carries every ECMA-376 Part 2 §11 core property, plus an extended-properties part
and a custom element order, written by hand with zipfile (independent of the editor's engine)."""
import sys
import zipfile
from pathlib import Path

OUT = Path(sys.argv[1] if len(sys.argv) > 1 else 'tests/fixtures/core-properties/properties.docx')
W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
PARTS = {
    '[Content_Types].xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        '<Default Extension="xml" ContentType="application/xml"/>'
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
        '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>'
        '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>'
        '</Types>',
    '_rels/.rels': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
        '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>'
        '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>'
        '</Relationships>',
    'word/document.xml': f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="{W}"><w:body>'
        '<w:p><w:r><w:t>Harbour survey notes</w:t></w:r></w:p>'
        '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>'
        '</w:body></w:document>',
    'docProps/core.xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" '
        'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" '
        'xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">'
        '<dcterms:modified xsi:type="dcterms:W3CDTF">2024-03-02T09:30:00Z</dcterms:modified>'
        '<dc:title>Harbour Survey</dc:title><dc:subject>Tide gauges</dc:subject>'
        '<dc:creator>R. Okafor</dc:creator><cp:keywords>tides; harbour; 2024</cp:keywords>'
        '<dc:description>Field notes from the spring survey.</dc:description>'
        '<cp:lastModifiedBy>R. Okafor</cp:lastModifiedBy><cp:revision>3</cp:revision>'
        '<cp:category>Survey</cp:category><cp:contentStatus>Draft</cp:contentStatus>'
        '<dcterms:created xsi:type="dcterms:W3CDTF">2024-03-01T08:00:00Z</dcterms:created>'
        '</cp:coreProperties>',
    'docProps/app.xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">'
        '<Application>Fixture writer</Application><Company>Harbour Board</Company></Properties>',
}

OUT.parent.mkdir(parents=True, exist_ok=True)
with zipfile.ZipFile(OUT, 'w', zipfile.ZIP_DEFLATED) as z:
    for name, text in PARTS.items():
        z.writestr(name, text.encode('utf-8'))
print(OUT)
