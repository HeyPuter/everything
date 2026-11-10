# Read-only preview feature list

`control.docx` is independently authored by `tools/preview_issues_fixture.py`.
It combines right-to-left paragraph layout, repeated hidden-text declarations,
and a wave paragraph border with ordinary bold text. These declarations expose
several existing import limitations without adding a new rendering feature.
Hidden text (2026-10-09) and right-to-left paragraphs (2026-11-10) have since
become editable: the wave border is the limitation the list still reports, and
the other declarations check that supported features are not listed.

Tests require a document-specific, deduplicated diagnostic list, retained
supported text formatting, unchanged package parts and the existing read-only
export guard. Browser tests cover the app and playground, native keyboard
expansion/collapse, original-byte downloads, and clearing the notice when opening
an editable document. Unit tests separately cover layout/image fallback reasons
and safe text rendering of document-controlled diagnostic strings.

The list reports limitations actually detected by import and rendering. It is
not an exhaustive OOXML feature inventory: a fallback can skip a larger object
before all its nested limitations are encountered. The UI says "detected" and
retains an explicit unknown-reason message when no diagnostic is available.
No parser support, editing guard, rendering rule or source markup is changed.
