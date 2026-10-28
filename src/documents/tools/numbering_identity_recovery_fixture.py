"""Independent mixed-content controls for malformed numbering identity recovery.

Uses the existing original numbering-definition fixture, not corpus artwork.
Invalid variants deliberately violate identity requirements; they are not
examples of conforming numbering or evidence of native reference repair semantics.
"""
from pathlib import Path
from zipfile import ZipFile, ZipInfo, ZIP_DEFLATED
import re

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'tests/fixtures/numbering-identity-recovery'


def main():
    OUT.mkdir(exist_ok=True)
    with ZipFile(ROOT / 'tests/fixtures/numbering-definition-recovery/format.docx') as archive:
        source = {name: archive.read(name) for name in archive.namelist()}
    numbering = source['word/numbering.xml'].decode().replace('thaiCounting', 'decimal')
    abstract = re.search(r'<w:abstractNum w:abstractNumId="1">.*?</w:abstractNum>', numbering).group()
    instance = '<w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>'
    variants = {
        'duplicate-abstract': numbering.replace(abstract, abstract + abstract.replace('%1', 'wrong %1')),
        'duplicate-instance': numbering.replace(instance, instance + instance.replace('w:val="1"', 'w:val="0"')),
        'invalid-abstract': numbering.replace('w:abstractNumId="1"', 'w:abstractNumId="bogus"'),
        'missing-abstract': numbering.replace(' w:abstractNumId="1"', ''),
        'invalid-instance': numbering.replace('w:numId="2"', 'w:numId="bogus"'),
        'missing-instance': numbering.replace(' w:numId="2"', ''),
        'zero-instance': numbering.replace('w:numId="2"', 'w:numId="0"'),
    }
    variants['combined'] = variants['duplicate-abstract'].replace(instance, instance + instance)
    for name, content in variants.items():
        parts = {**source, 'word/numbering.xml': content.encode()}
        with ZipFile(OUT / f'{name}.docx', 'w', ZIP_DEFLATED) as archive:
            for part, data in parts.items():
                info = ZipInfo(part, (2026, 1, 1, 0, 0, 0))
                info.compress_type = ZIP_DEFLATED
                archive.writestr(info, data)


if __name__ == '__main__':
    main()
