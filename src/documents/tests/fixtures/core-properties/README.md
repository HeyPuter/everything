# Core properties fixture

`tools/core_properties_fixture.py` writes `properties.docx` by hand with Python's `zipfile`,
independently of the editor's engine. Its `docProps/core.xml` carries every core property of
ECMA-376 Part 2 §11 (title, subject, creator, keywords, description, lastModifiedBy, revision,
category, contentStatus, created, modified) in a non-default element order, and the package has an
extended-properties part (`docProps/app.xml`) that the editor must keep byte for byte.
