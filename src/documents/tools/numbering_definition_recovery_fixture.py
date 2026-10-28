"""Original rich-paragraph controls for rejected numbering definitions."""
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
import image_recovery_fixture as base

OUT = Path(__file__).resolve().parents[1] / 'tests/fixtures/numbering-definition-recovery'


def main():
    base.OUT = OUT
    base.build(False)
    with ZipFile(OUT / 'healthy.docx') as archive:
        original = {name: archive.read(name) for name in archive.namelist()}
    for variant in ['healthy', 'format', 'inherited', 'missing', 'missing-level', 'override']:
        parts = dict(original)

        def paragraph(number):
            style = 'BadList' if variant == 'inherited' else 'Heading'
            level = 1 if variant == 'missing-level' else 0
            reference = '' if variant in ['healthy', 'inherited'] else f'<w:numPr><w:ilvl w:val="{level}"/><w:numId w:val="2"/></w:numPr>'
            picture = base.picture(number).replace(f'r:embed="image{number}"', 'r:embed="image1"')
            return f'<w:p><w:pPr><w:pStyle w:val="{style}"/>{reference}<w:spacing w:after="240"/><w:ind w:left="540"/></w:pPr><w:r><w:t>Retained {number}</w:t></w:r>{picture}<w:r><w:rPr><w:i/></w:rPr><w:t>After picture</w:t></w:r></w:p>'

        good_props = '<w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr>'
        parts['word/document.xml'] = parts['word/document.xml'].decode().replace('<w:p>' + base.picture(1) + '</w:p>', paragraph(10)).replace('<w:p>' + base.picture(2) + '</w:p>', '').replace(base.p('Retained table cell'), paragraph(20)).replace('<w:sectPr>', base.p('Second supported item', good_props) + '<w:sectPr>').encode()
        parts['word/header1.xml'] = f'<w:hdr xmlns:w="{base.W}" xmlns:r="{base.R}" xmlns:a="{base.A}" xmlns:wp="{base.WP}" xmlns:pic="{base.PIC}">{base.p("Retained header")}{paragraph(30)}{base.p("Supported header item", good_props)}</w:hdr>'.encode()
        parts['word/_rels/header1.xml.rels'] = f'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="image1" Type="{base.R}/image" Target="media/image1.png"/></Relationships>'.encode()
        if variant == 'inherited':
            style = '<w:style w:type="paragraph" w:styleId="BadList"><w:name w:val="Bad list"/><w:basedOn w:val="Heading"/><w:pPr><w:numPr><w:numId w:val="2"/></w:numPr></w:pPr></w:style>'
            parts['word/styles.xml'] = parts['word/styles.xml'].decode().replace('</w:styles>', style + '</w:styles>').encode()
        fmt = 'thaiCounting' if variant in ['format', 'inherited'] else 'decimal'
        level = f'<w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="{fmt}"/><w:lvlText w:val="%1"/><w:lvlJc w:val="left"/></w:lvl>'
        override = '<w:lvlOverride w:ilvl="0">' + level.replace('w:val="decimal"', 'w:val="thaiCounting"') + '</w:lvlOverride>' if variant == 'override' else ''
        instance = '' if variant == 'missing' else f'<w:num w:numId="2"><w:abstractNumId w:val="1"/>{override}</w:num>'
        parts['word/numbering.xml'] = parts['word/numbering.xml'].decode().replace('<w:num w:numId="1">', f'<w:abstractNum w:abstractNumId="1">{level}</w:abstractNum><w:num w:numId="1">').replace('</w:numbering>', instance + '</w:numbering>').encode()
        with ZipFile(OUT / (variant + '.docx'), 'w', ZIP_DEFLATED) as archive:
            for name, data in parts.items():
                archive.writestr(name, data)


if __name__ == '__main__':
    main()
