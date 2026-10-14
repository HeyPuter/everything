"""Validate document, style, settings, numbering and theme XML against official ECMA-376 transitional XSDs.

Downloads a hash-pinned standards archive to the OS temp directory. Never ships
schema files in the app. Requires lxml; see requirements-conformance.txt.
This is schema validation, not a complete OOXML/OPC or layout certification.
"""
import argparse
import hashlib
import io
from pathlib import Path
import tempfile
import subprocess
import sys
import urllib.request
import zipfile
from lxml import etree
from drawing_extension_schema import install as install_drawing_schemas, WPG, WPS, ADEC, A16, ASVG, DSP, WP14
from content_control_schema import appearance_schema, install_binding_schema, W15
from shadow_obscured_schema import shadow_schema, install_hidden_line, A14

URL = 'https://ecma-international.org/wp-content/uploads/ECMA-376-4_5th_edition_december_2016.zip'
SHA256 = 'bd25da1109f73762356596918bf5ff8b74a1331642dba5f1c1d1dfc6bed34ecd'
MC = 'http://schemas.openxmlformats.org/markup-compatibility/2006'
XML_URL = 'https://www.w3.org/2001/xml.xsd'
XML_SHA256 = '61960fb3131e38022caad5360e2f33a3382578ab3c80cd58bd74320ede61b20c'
DGM = 'http://schemas.openxmlformats.org/drawingml/2006/diagram'
DIAGRAM_TYPES = {
    'application/vnd.openxmlformats-officedocument.drawingml.diagram' + name + '+xml'
    for name in ['Data', 'Layout', 'Style', 'Colors']
} | {'application/vnd.ms-office.drawingml.diagramDrawing+xml'}


def schema():
    archive = Path(tempfile.gettempdir()) / 'documents-ecma376-part4.zip'
    if not archive.exists():
        with urllib.request.urlopen(URL, timeout=60) as response:
            archive.write_bytes(response.read())
    data = archive.read_bytes()
    if hashlib.sha256(data).hexdigest() != SHA256:
        raise RuntimeError('ECMA archive hash mismatch; review the source before changing the pin')
    xml_schema = Path(tempfile.gettempdir()) / 'documents-w3c-xml.xsd'
    if not xml_schema.exists():
        with urllib.request.urlopen(XML_URL, timeout=60) as response:
            xml_schema.write_bytes(response.read())
    if hashlib.sha256(xml_schema.read_bytes()).hexdigest() != XML_SHA256:
        raise RuntimeError('W3C xml.xsd hash mismatch')
    with tempfile.TemporaryDirectory(prefix='documents-ooxml-xsd-') as directory:
        with zipfile.ZipFile(io.BytesIO(data)) as outer:
            with zipfile.ZipFile(io.BytesIO(outer.read('OfficeOpenXML-XMLSchema-Transitional.zip'))) as inner:
                for name in inner.namelist():
                    if '/' in name or '\\' in name or not name.endswith('.xsd'):
                        raise RuntimeError(f'Unexpected schema archive entry: {name}')
                    Path(directory, name).write_bytes(inner.read(name))
        Path(directory, 'xml.xsd').write_bytes(xml_schema.read_bytes())
        # ECMA's wml.xsd imports the XML namespace without a schemaLocation.
        # Load the official W3C declarations first, without changing either schema.
        extension_imports = install_drawing_schemas(directory) + install_hidden_line(directory) + install_binding_schema(directory)
        wrapper = Path(directory, 'check.xsd')
        wrapper.write_text('<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema"><xs:import namespace="http://www.w3.org/XML/1998/namespace" schemaLocation="xml.xsd"/><xs:import namespace="http://schemas.openxmlformats.org/wordprocessingml/2006/main" schemaLocation="wml.xsd"/><xs:import namespace="http://schemas.openxmlformats.org/drawingml/2006/chart" schemaLocation="dml-chart.xsd"/><xs:import namespace="http://schemas.openxmlformats.org/officeDocument/2006/bibliography" schemaLocation="shared-bibliography.xsd"/><xs:import namespace="http://schemas.openxmlformats.org/officeDocument/2006/customXml" schemaLocation="shared-customXmlDataProperties.xsd"/>' + extension_imports + '</xs:schema>')
        return etree.XMLSchema(etree.parse(str(wrapper)))


def standard_tree(data, extensions=False):
    parser = etree.XMLParser(resolve_entities=False, no_network=True)
    root = etree.fromstring(data, parser)
    # ECMA conformance view understands the standard namespaces, not the vendor
    # drawing extensions. Select their standard fallback per Part 3; the group
    # fixture checker separately verifies the retained extension branches.
    understood = {'http://schemas.openxmlformats.org/' + suffix for suffix in ['wordprocessingml/2006/main', 'drawingml/2006/main', 'drawingml/2006/picture', 'drawingml/2006/chart', 'drawingml/2006/wordprocessingDrawing']}
    understood.add(DGM)
    if extensions: understood.update({WPG, WPS, ADEC, A16, ASVG, DSP, WP14})
    def alternatives(node):
        for child in list(node):
            if child.tag == f'{{{MC}}}AlternateContent':
                selected = None; fallback = None; count = 0
                for branch in child:
                    if branch.tag == f'{{{MC}}}Choice' and fallback is None:
                        count += 1
                        prefixes = branch.get('Requires', '').split()
                        if not prefixes or any(p not in branch.nsmap for p in prefixes): raise RuntimeError('Invalid MCE requirements')
                        if selected is None and all(branch.nsmap[p] in understood for p in prefixes): selected = branch
                    elif branch.tag == f'{{{MC}}}Fallback' and fallback is None: fallback = branch
                    else: raise RuntimeError('Invalid MCE branch ordering')
                if not count: raise RuntimeError('MCE has no Choice')
                branch = selected if selected is not None else fallback
                if branch is None: raise RuntimeError('MCE has no standard fallback for validation')
                alternatives(branch)
                at = node.index(child)
                for item in list(branch): node.insert(at, item); at += 1
                node.remove(child)
            else: alternatives(child)
    alternatives(root)
    # The fixtures use mc:Ignorable for optional vendor-extension attributes. Process only
    # those declared namespaces; don't broadly strip unknown content to pass XSD.
    def process(node, ignored):
        ignored = set(ignored)
        for prefix in node.get(f'{{{MC}}}Ignorable', '').split():
            if prefix not in node.nsmap:
                raise RuntimeError(f'Unbound mc:Ignorable prefix {prefix}')
            if node.nsmap[prefix] not in understood or node.nsmap[prefix] == WP14: ignored.add(node.nsmap[prefix])
        for key in list(node.attrib):
            uri = etree.QName(key).namespace
            if key == f'{{{MC}}}Ignorable' or uri in ignored:
                del node.attrib[key]
        for child in list(node):
            if not isinstance(child.tag, str):
                continue
            # This extension view validates percentage-position elements, while
            # retaining the existing ignorable treatment of other wp14 metadata.
            percentage = extensions and child.tag in {f'{{{WP14}}}pctPosHOffset', f'{{{WP14}}}pctPosVOffset'}
            if etree.QName(child).namespace in ignored and not percentage:
                node.remove(child)
            else:
                process(child, ignored)
    process(root, set())
    return root


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('paths', nargs='*')
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    paths = args.paths
    if not paths:
        exports = list((root / 'test-results').rglob('*.docx'))
        subprocess.run([sys.executable, str(root / 'tools/check_bookmark_insertion_exports.py'), '--check-fixtures', '--check-exports'], check=True)
        subprocess.run([sys.executable, str(root / 'tools/check_row_geometry_exports.py'), '--check-fixtures', '--check-exports'], check=True)
        subprocess.run([sys.executable, str(root / 'tools/check_continuation_exports.py'), '--check-fixtures', '--check-exports'], check=True)
        subprocess.run([sys.executable, str(root / 'tools/canvas_nil_border_fixture.py'), '--check-exports'], check=True)
        subprocess.run([sys.executable, str(root / 'tools/check_block_control_exports.py')], check=True)
        subprocess.run([sys.executable, str(root / 'tools/canvas_block_bookmark_fixtures.py'), '--check-exports'], check=True)
        required = {'edited.docx': [], 'formatted.docx': ['--paragraph-formatting'], 'fonts.docx': ['--font-formatting'], 'pages.docx': ['--page-settings'], 'indents-tabs.docx': ['--indents-tabs'], 'pagination.docx': ['--pagination'], 'numbering.docx': ['--numbering'], 'new-lists.docx': ['--new-lists'], 'styles.docx': ['--styles'], 'new-styles.docx': ['--new-styles'], 'character-styles.docx': ['--character-styles'], 'new-character-styles.docx': ['--new-character-styles'], 'tables.docx': ['--tables'], 'new-tables.docx': ['--new-tables'], 'autofit-tables.docx': ['--autofit-tables'], 'new-autofit-tables.docx': ['--new-autofit-tables'], 'merged-cells.docx': ['--merged-cells'], 'new-merged-cells.docx': ['--new-merged-cells'], 'vertical-cells.docx': ['--vertical-cells'], 'new-vertical-cells.docx': ['--new-vertical-cells'], 'vertical-pages.docx': ['--vertical-pages'], 'new-vertical-pages.docx': ['--new-vertical-pages'], 'table-headers.docx': ['--table-headers'], 'new-table-headers.docx': ['--new-table-headers'], 'inline-images.docx': ['--inline-images'], 'new-inline-images.docx': ['--new-inline-images'], 'cropped-images.docx': ['--cropped-images'], 'new-cropped-images.docx': ['--new-cropped-images'], 'flipped-images.docx': ['--flipped-images'], 'new-flipped-images.docx': ['--new-flipped-images'], 'rotated-images.docx': ['--rotated-images'], 'new-rotated-images.docx': ['--new-rotated-images'], 'outline-levels.docx': ['--outline-levels'], 'new-outline-levels.docx': ['--new-outline-levels'], 'text-colors.docx': ['--text-colors'], 'new-text-colors.docx': ['--new-text-colors'], 'text-highlights.docx': ['--text-highlights'], 'new-text-highlights.docx': ['--new-text-highlights'], 'style-toggles-off.docx': ['--style-toggles-off'], 'style-toggles-on.docx': ['--style-toggles-on'], 'script-text.docx': ['--script-text'], 'new-script-text.docx': ['--new-script-text'], 'baseline-shifts.docx': ['--baseline-shifts'], 'new-baseline-shifts.docx': ['--new-baseline-shifts'], 'character-spacing.docx': ['--character-spacing'], 'new-character-spacing.docx': ['--new-character-spacing'], 'text-width.docx': ['--text-width'], 'new-text-width.docx': ['--new-text-width'], 'contextual-spacing.docx': ['--contextual-spacing', 'body'], 'contextual-table-spacing.docx': ['--contextual-spacing', 'table'], 'new-contextual-spacing.docx': ['--contextual-spacing', 'new'], 'kerning.docx': ['--kerning'], 'new-kerning.docx': ['--new-kerning'], 'trailing-spaces.docx': ['--spaces', 'trailing'], 'wrapped-spaces.docx': ['--spaces', 'wrapped'], 'new-trailing-spaces.docx': ['--spaces', 'new'], 'strikethrough.docx': ['--strikethrough'], 'new-strikethrough.docx': ['--new-strikethrough'], 'capitalization.docx': ['--capitalization'], 'new-capitalization.docx': ['--new-capitalization'], 'underlines.docx': ['--underlines'], 'new-underlines.docx': ['--new-underlines'], 'hyperlinks.docx': ['--hyperlinks'], 'new-hyperlinks.docx': ['--new-hyperlinks'], 'bookmarks.docx': ['--bookmarks'], 'new-bookmarks.docx': ['--new-bookmarks'], 'paragraph-shading.docx': ['--paragraph-shading'], 'new-paragraph-shading.docx': ['--new-paragraph-shading']}
        required.update({'paragraph-borders.docx': ['--paragraph-borders'], 'new-paragraph-borders.docx': ['--new-paragraph-borders']})
        required.update({'cell-alignment.docx': ['--cell-alignment'], 'new-cell-alignment.docx': ['--new-cell-alignment']})
        required.update({'cell-shading.docx': ['--cell-shading'], 'new-cell-shading.docx': ['--new-cell-shading']})
        required.update({'cell-borders.docx': ['--cell-borders'], 'new-cell-borders.docx': ['--new-cell-borders']})
        required.update({'cell-margins.docx': ['--cell-margins'], 'new-cell-margins.docx': ['--new-cell-margins']})
        required.update({'justification.docx': ['--justification', 'main'], 'justification-soft-breaks.docx': ['--justification', 'soft'], 'new-justification.docx': ['--justification', 'new']})
        required.update({'tab-leaders.docx': ['--tab-leaders', 'main'], 'new-tab-leaders.docx': ['--tab-leaders', 'new']})
        required.update({'row-heights.docx': ['--row-heights', 'main'], 'new-row-heights.docx': ['--row-heights', 'new']})
        required.update({'line-spacing.docx': ['--line-spacing', 'main'], 'new-line-spacing.docx': ['--line-spacing', 'new']})
        required.update({'style-line-spacing.docx': ['--style-spacing', 'main'], 'new-style-line-spacing.docx': ['--style-spacing', 'new']})
        required.update({'find-replace.docx': ['--search', 'main'], 'new-find-replace.docx': ['--search', 'new']})
        required.update({'clear-text-formatting.docx': ['--clear-format', 'main'], 'new-clear-text-formatting.docx': ['--clear-format', 'new']})
        required.update({'clear-paragraph-formatting.docx': ['--paragraph-reset', 'main'], 'new-clear-paragraph-formatting.docx': ['--paragraph-reset', 'new']})
        missing = (set(required) | {'content-controls.docx', 'content-controls-unchanged.docx', 'charts-and-anchors.docx', 'grouped-drawings.docx', 'artwork-metadata.docx', 'exact-row-heights.docx', 'exact-rows-unchanged.docx', 'annual-report.docx', 'annual-table-format.docx'}) - {p.name for p in exports}
        if missing:
            raise RuntimeError(f'Missing browser acceptance exports {sorted(missing)}. Run npm run test:browser first.')
        if not any(p.name == 'styles-location.docx' for p in exports):
            raise RuntimeError('Missing styles-location.docx browser export. Run npm run test:browser first.')
        if not any(p.name == 'first-section.docx' for p in exports):
            raise RuntimeError('Missing first-section.docx browser export. Run npm run test:browser first.')
        if not any(p.name == 'numbering-location.docx' for p in exports):
            raise RuntimeError('Missing numbering-location.docx browser export. Run npm run test:browser first.')
        for name in ['anchor-position.docx', 'anchor-position-legacy.docx']:
            if not any(p.name == name for p in exports):
                raise RuntimeError(f'Missing {name} browser export. Run npm run test:browser first.')
        if not any(p.name == 'shape-picture-fills.docx' for p in exports):
            raise RuntimeError('Missing shape-picture-fills.docx browser export. Run npm run test:browser first.')
        if not any(p.name == 'temporary-control-formatting.docx' for p in exports):
            raise RuntimeError('Missing temporary-control-formatting.docx browser export. Run npm run test:browser first.')
        if not any(p.name == 'drawing-creation-ids.docx' for p in exports):
            raise RuntimeError('Missing drawing-creation-ids.docx browser export. Run npm run test:browser first.')
        if not any(p.name == 'group-locks.docx' for p in exports):
            raise RuntimeError('Missing group-locks.docx browser export. Run npm run test:browser first.')
        if not any(p.name == 'group-text-scaling.docx' for p in exports):
            raise RuntimeError('Missing group-text-scaling.docx browser export. Run npm run test:browser first.')
        if not any(p.name == 'font-families.docx' for p in exports):
            raise RuntimeError('Missing font-families.docx browser export. Run npm run test:browser first.')
        if not any(p.name == 'svg-pictures.docx' for p in exports):
            raise RuntimeError('Missing svg-pictures.docx browser export. Run npm run test:browser first.')
        if not any(p.name == 'control-hyperlinks.docx' for p in exports):
            raise RuntimeError('Missing control-hyperlinks.docx browser export. Run npm run test:browser first.')
        if not any(p.name == 'merged-autofit.docx' for p in exports):
            raise RuntimeError('Missing merged-autofit.docx browser export. Run npm run test:browser first.')
        if not any(p.name == 'border-coverage.docx' for p in exports):
            raise RuntimeError('Missing border-coverage.docx browser export. Run npm run test:browser first.')
        if not any(p.name == 'hidden-cell-mark.docx' for p in exports):
            raise RuntimeError('Missing hidden-cell-mark.docx browser export. Run npm run test:browser first.')
        for name in ['table-bookmarks.docx', 'table-bookmarks-merged.docx']:
            if not any(p.name == name for p in exports):
                raise RuntimeError(f'Missing {name} browser export. Run npm run test:browser first.')
        for path in exports:
            if path.name in {'table-bookmarks.docx', 'table-bookmarks-merged.docx'}:
                subprocess.run([sys.executable, str(root / 'tools/canvas_table_bookmark_fixture.py'), str(path)], check=True)
            if path.name == 'hidden-cell-mark.docx':
                subprocess.run([sys.executable, str(root / 'tools/canvas_hidden_cell_mark_fixture.py'), str(path)], check=True)
            if path.name == 'border-coverage.docx':
                subprocess.run([sys.executable, str(root / 'tools/canvas_border_coverage_fixture.py'), str(path)], check=True)
            if path.name == 'merged-autofit.docx':
                subprocess.run([sys.executable, str(root / 'tools/canvas_merged_autofit_fixture.py'), str(path)], check=True)
            if path.name == 'control-hyperlinks.docx':
                subprocess.run([sys.executable, str(root / 'tools/canvas_control_hyperlinks_fixture.py'), str(path)], check=True)
            if path.name == 'svg-pictures.docx':
                subprocess.run([sys.executable, str(root / 'tools/canvas_svg_fixture.py'), str(path)], check=True)
            if path.name == 'font-families.docx':
                subprocess.run([sys.executable, str(root / 'tools/canvas_font_family_fixture.py'), str(path)], check=True)
            if path.name == 'group-text-scaling.docx':
                subprocess.run([sys.executable, str(root / 'tools/canvas_group_text_fixture.py'), str(path)], check=True)
            if path.name == 'group-locks.docx':
                subprocess.run([sys.executable, str(root / 'tools/canvas_group_locks_fixture.py'), str(path)], check=True)
            if path.name == 'drawing-creation-ids.docx':
                subprocess.run([sys.executable, str(root / 'tools/canvas_creation_id_fixture.py'), str(path)], check=True)
            if path.name == 'temporary-control-formatting.docx':
                subprocess.run([sys.executable, str(root / 'tools/canvas_temporary_control_formatting_fixture.py'), str(path)], check=True)
            if path.name == 'shape-picture-fills.docx':
                subprocess.run([sys.executable, str(root / 'tools/canvas_picture_fill_fixture.py'), str(path)], check=True)
            if path.name in {'anchor-position.docx', 'anchor-position-legacy.docx'}:
                subprocess.run([sys.executable, str(root / 'tools/canvas_anchor_position_fixture.py'), str(path)], check=True)
            if path.name == 'numbering-location.docx':
                subprocess.run([sys.executable, str(root / 'tools/canvas_numbering_location_fixture.py'), str(path)], check=True)
            if path.name == 'first-section.docx':
                subprocess.run([sys.executable, str(root / 'tools/canvas_first_section_fixture.py'), str(path)], check=True)
            if path.name == 'styles-location.docx':
                subprocess.run([sys.executable, str(root / 'tools/canvas_styles_location_fixture.py'), str(path)], check=True)
            if path.name in {'content-controls.docx', 'content-controls-unchanged.docx'}:
                flags = ['--edited'] if path.name == 'content-controls.docx' else []
                subprocess.run([sys.executable, str(root / 'tools/canvas_content_control_fixture.py'), str(path), *flags], check=True)
            if path.name in {'exact-row-heights.docx', 'exact-rows-unchanged.docx'}:
                flags = ['--edited'] if path.name == 'exact-row-heights.docx' else []
                subprocess.run([sys.executable, str(root / 'tools/canvas_exact_row_fixture.py'), str(path), *flags], check=True)
            if path.name == 'artwork-metadata.docx':
                subprocess.run([sys.executable, str(root / 'tools/canvas_artwork_metadata_fixture.py'), str(path)], check=True)
            if path.name in {'annual-report.docx', 'annual-table-format.docx'}:
                subprocess.run([sys.executable, str(root / 'tools/canvas_annual_fixture.py'), str(path)], check=True)
            if path.name == 'grouped-drawings.docx':
                subprocess.run([sys.executable, str(root / 'tools/canvas_group_fixture.py'), str(path)], check=True)
            if path.name == 'charts-and-anchors.docx':
                subprocess.run([sys.executable, str(root / 'tools/canvas_drawings_fixture.py'), str(path)], check=True)
            if path.name in required:
                subprocess.run([sys.executable, str(root / 'tools/verify-canvas-docx.py'), *required[path.name], str(path)], check=True)
        paths = [*(root / 'public/fixtures').glob('*.docx'), *(root / 'public/fixtures/row-geometry').glob('*.docx'), *(root / 'public/fixtures/row-fragment-ends').glob('*.docx'), *(root / 'public/fixtures/continuation-borders').glob('*.docx'), *(root / 'public/fixtures/continuation-headings').glob('*.docx'), *(root / 'public/fixtures/continuation-exact').glob('*.docx'), *exports]
    if not sys.argv[1:]:
        paths.extend((root / 'tests/fixtures/page-stories').glob('*.docx'))
    validator = schema()
    for axis in ('H', 'V'):
        for value, valid in [('25000', True), ('-5000', True), ('25%', True), ('', False), ('NaN', False), ('25.5', False), ('2147483648', False)]:
            node = etree.fromstring(f'<wp14:pctPos{axis}Offset xmlns:wp14="{WP14}">{value}</wp14:pctPos{axis}Offset>'.encode())
            if validator.validate(node) != valid:
                raise RuntimeError(f'Validator self-check failed: percentage position {axis} {value!r}')
    for ns, tag in [(DGM, 'dataModel'), (DGM, 'layoutDef'), (DGM, 'styleDef'), (DSP, 'drawing')]:
        if validator.validate(etree.fromstring(f'<probe:{tag} xmlns:probe="{ns}"/>'.encode())):
            raise RuntimeError(f'Validator self-check failed: incomplete diagram {tag} accepted')
    valid_diagram = f'<dgm:dataModel xmlns:dgm="{DGM}"><dgm:ptLst/></dgm:dataModel>'.encode()
    if not validator.validate(etree.fromstring(valid_diagram)):
        raise RuntimeError('Validator self-check failed: valid minimal diagram data rejected')
    valid_drawing = f'<dsp:drawing xmlns:dsp="{DSP}"><dsp:spTree><dsp:nvGrpSpPr><dsp:cNvPr id="0" name=""/><dsp:cNvGrpSpPr/></dsp:nvGrpSpPr><dsp:grpSpPr/><dsp:sp modelId="1"><dsp:nvSpPr><dsp:cNvPr id="1" name="Shape"/><dsp:cNvSpPr/></dsp:nvSpPr><dsp:spPr/></dsp:sp></dsp:spTree></dsp:drawing>'.encode()
    if not validator.validate(etree.fromstring(valid_drawing)) or validator.validate(etree.fromstring(valid_drawing.replace(b' modelId="1"', b''))):
        raise RuntimeError('Validator self-check failed: diagram drawing shape model ID')
    for attrs, valid in [('', True), ('w="0"', True), ('w="20116800"', True), ('w="-1"', False), ('cap="future"', False)]:
        if validator.validate(etree.fromstring(f'<a14:hiddenLine xmlns:a14="{A14}" {attrs}/>'.encode())) != valid:
            raise RuntimeError('Validator self-check failed: hidden outline properties')
    if validator.validate(etree.fromstring(f'<a14:hiddenLine xmlns:a14="{A14}" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:future/></a14:hiddenLine>'.encode())):
        raise RuntimeError('Validator self-check failed: unknown hidden outline child')
    appearance = appearance_schema()
    binding_sample = f'<w15:dataBinding xmlns:w15="{W15}" xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" w:xpath="/root" w:storeItemID="{{00000000-0000-0000-0000-000000000000}}"/>'
    if not validator.validate(etree.fromstring(binding_sample.encode())) or validator.validate(etree.fromstring(binding_sample.replace(' w:xpath="/root"', '').encode())):
        raise RuntimeError('Validator self-check failed: data-binding required XPath')
    for content, valid in [('<a:noFill/>', True), ('<a:grpFill/>', True), ('', False), ('<a:noFill/><a:grpFill/>', False), ('<a:future/>', False)]:
        node = etree.fromstring(f'<a14:hiddenFill xmlns:a14="{A14}" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">{content}</a14:hiddenFill>'.encode())
        if validator.validate(node) != valid: raise RuntimeError('Validator self-check failed: saved fill properties')
    shadow = None
    invalid = b'<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:rPr><w:sz/></w:rPr></w:r></w:p></w:body></w:document>'
    if validator.validate(standard_tree(invalid)):
        raise RuntimeError('Validator self-check failed: missing required font-size value was accepted')
    invalid_page = b'<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p/><w:sectPr><w:pgMar w:left="1440"/></w:sectPr></w:body></w:document>'
    if validator.validate(standard_tree(invalid_page)):
        raise RuntimeError('Validator self-check failed: missing required page-margin attributes were accepted')
    for content in ['<w:tabs/>', '<w:tabs><w:tab w:val="left"/></w:tabs>']:
        invalid_tab = f'<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:pPr>{content}</w:pPr></w:p></w:body></w:document>'.encode()
        if validator.validate(standard_tree(invalid_tab)):
            raise RuntimeError('Validator self-check failed: invalid tab markup was accepted')
    invalid_numbering = b'<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:num w:numId="1"/></w:numbering>'
    if validator.validate(standard_tree(invalid_numbering)):
        raise RuntimeError('Validator self-check failed: numbering instance without an abstract reference was accepted')
    invalid_theme = b'<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Invalid"><a:themeElements/></a:theme>'
    if validator.validate(standard_tree(invalid_theme)):
        raise RuntimeError('Validator self-check failed: missing theme color/font/format schemes were accepted')
    if validator.validate(etree.fromstring(f'<asvg:svgBlip xmlns:asvg="{ASVG}"><asvg:bad/></asvg:svgBlip>'.encode())):
        raise RuntimeError('Validator self-check failed: SVG reference children accepted')
    failed = False
    invalid_footer = b'<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:pPr><w:jc w:val="right"/><w:spacing w:after="0"/></w:pPr></w:p></w:ftr>'
    if validator.validate(standard_tree(invalid_footer)):
        raise RuntimeError('Validator self-check failed: invalid footer paragraph property order accepted')
    invalid_chart = b'<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart><c:plotArea><c:barChart/></c:plotArea></c:chart></c:chartSpace>'
    if validator.validate(standard_tree(invalid_chart)):
        raise RuntimeError('Validator self-check failed: chart without bar direction was accepted')
    with zipfile.ZipFile(root/'tests/fixtures/chart-metadata/chart-metadata-order.docx') as negative:
        invalid_order = standard_tree(negative.read('word/charts/chart1.xml'))
    if validator.validate(invalid_order) or any('showDLblsOverMax' not in str(e) for e in validator.error_log):
        raise RuntimeError('Validator self-check failed: chart extension ordering')
    chart_ns = {'c': 'http://schemas.openxmlformats.org/drawingml/2006/chart'}
    chart = invalid_order.find('c:chart', chart_ns)
    flag = chart.find('c:showDLblsOverMax', chart_ns); chart.remove(flag)
    chart.insert(list(chart).index(chart.find('c:extLst', chart_ns)), flag)
    if not validator.validate(invalid_order):
        raise RuntimeError('Validator self-check failed: reordered chart control is not otherwise valid')
    for ns, name in [(WPG, 'wgp'), (WPS, 'wsp')]:
        if validator.validate(etree.fromstring(f'<x:{name} xmlns:x="{ns}"/>'.encode())):
            raise RuntimeError('Validator self-check failed: incomplete extension drawing accepted')
    if validator.validate(etree.fromstring(f'<adec:decorative xmlns:adec="{ADEC}" val="yes"/>'.encode())):
        raise RuntimeError('Validator self-check failed: invalid decorative metadata accepted')
    for value in ['invalid', '', '{aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa}']:
        if validator.validate(etree.fromstring(f'<a16:creationId xmlns:a16="{A16}" id="{value}"/>'.encode())):
            raise RuntimeError('Validator self-check failed: invalid drawing creation ID accepted')
    if not validator.validate(etree.fromstring(f'<a16:creationId xmlns:a16="{A16}"/>'.encode())):
        raise RuntimeError('Validator self-check failed: optional drawing creation ID rejected')
    for path in paths:
        with zipfile.ZipFile(path) as archive:
            types = standard_tree(archive.read('[Content_Types].xml'))
            themes = [node.get('PartName').lstrip('/') for node in types if node.get('ContentType') == 'application/vnd.openxmlformats-officedocument.theme+xml']
            diagrams = [node.get('PartName').lstrip('/') for node in types if node.get('ContentType') in DIAGRAM_TYPES]
            charts = [node.get('PartName').lstrip('/') for node in types if node.get('ContentType') == 'application/vnd.openxmlformats-officedocument.drawingml.chart+xml']
            styles = [node.get('PartName').lstrip('/') for node in types if node.get('ContentType') in ['application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml', 'application/vnd.ms-word.stylesWithEffects+xml']]
            numbering = [node.get('PartName').lstrip('/') for node in types if node.get('ContentType') == 'application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml']
            stories = [node.get('PartName').lstrip('/') for node in types if node.get('ContentType') in [f'application/vnd.openxmlformats-officedocument.wordprocessingml.{kind}+xml' for kind in ['header', 'footer', 'footnotes', 'endnotes']]]
            glossary = [node.get('PartName').lstrip('/') for node in types if node.get('ContentType') == 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.glossary+xml']
            settings = [node.get('PartName').lstrip('/') for node in types if node.get('ContentType') == 'application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml']
            fonts = [node.get('PartName').lstrip('/') for node in types if node.get('ContentType') == 'application/vnd.openxmlformats-officedocument.wordprocessingml.fontTable+xml']
            # Bibliography sources (Part 1 §22.6) and custom XML item properties (§22.5): other custom XML is free-form.
            item_props = [node.get('PartName').lstrip('/') for node in types if node.get('ContentType') == 'application/vnd.openxmlformats-officedocument.customXmlProperties+xml']
            bibliography = [n for n in archive.namelist() if n.startswith('customXml/item') and not n.startswith('customXml/itemProps') and n.endswith('.xml')
                            and b'officeDocument/2006/bibliography' in archive.read(n)[:400]]
            for name in ['word/document.xml', *styles, *numbering, *stories, *glossary, *settings, *fonts, *themes, *charts, *diagrams, *bibliography, *item_props]:
                if name not in archive.namelist():
                    raise RuntimeError(f'{path}: missing {name}')
                data = archive.read(name)
                if A14.encode() in data:
                    root = etree.fromstring(data, etree.XMLParser(resolve_entities=False, no_network=True))
                    hidden_lines = [n for n in root.iter() if n.tag in {f'{{{A14}}}hiddenLine', f'{{{A14}}}hiddenFill'}]
                    for node in hidden_lines:
                        if not validator.validate(node):
                            failed = True
                            print(f'FAIL {path}: {name} (MS-ODRAWXML saved appearance)\n{validator.error_log}')
                    if hidden_lines: print(f'CHECK {path}: {name} ({len(hidden_lines)} MS-ODRAWXML saved appearance declarations)')
                    metadata = list(root.iter(f'{{{A14}}}shadowObscured'))
                    if metadata and shadow is None: shadow = shadow_schema()
                    for node in metadata:
                        if not shadow.validate(node):
                            failed = True
                            print(f'FAIL {path}: {name} (MS-ODRAWXML shadowObscured)\n{shadow.error_log}')
                    if metadata: print(f'CHECK {path}: {name} ({len(metadata)} MS-ODRAWXML shadowObscured declarations)')
                if W15.encode() in data:
                    root = etree.fromstring(data, etree.XMLParser(resolve_entities=False, no_network=True))
                    metadata = list(root.iter(f'{{{W15}}}appearance'))
                    for node in metadata:
                        if not appearance.validate(node):
                            failed = True
                            print(f'FAIL {path}: {name} (MS-DOCX appearance)\n{appearance.error_log}')
                    if metadata: print(f'CHECK {path}: {name} ({len(metadata)} MS-DOCX appearance declarations)')
                    bindings = list(root.iter(f'{{{W15}}}dataBinding'))
                    for node in bindings:
                        if not validator.validate(node):
                            failed = True
                            print(f'FAIL {path}: {name} (MS-DOCX dataBinding)\n{validator.error_log}')
                    if bindings: print(f'CHECK {path}: {name} ({len(bindings)} MS-DOCX dataBinding declarations)')
                root = etree.fromstring(data, etree.XMLParser(resolve_entities=False, no_network=True))
                percentage_positions = list(root.iter(f'{{{WP14}}}pctPosHOffset')) + list(root.iter(f'{{{WP14}}}pctPosVOffset'))
                # Direct percentage children have no standard-only position
                # fallback. Validate the extended content model, not an empty
                # position produced by stripping its required extension child.
                views = [True] if name in diagrams or percentage_positions else [False, True] if any(ns.encode() in data for ns in [WPG, WPS, ADEC, A16, ASVG, DSP]) else [False]
                for extensions in views:
                    tree = standard_tree(data, extensions)
                    label = 'ECMA-376 + supported MS-ODRAWXML schemas' if extensions else 'ECMA-376 transitional XSD (standard MCE view)'
                    if not validator.validate(tree):
                        failed = True
                        print(f'FAIL {path}: {name} ({label})\n{validator.error_log}')
                    else:
                        print(f'PASS {path}: {name} ({label})')
    return int(failed)


if __name__ == '__main__':
    raise SystemExit(main())
