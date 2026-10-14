import { openCanvasDocument } from './engine/open-document.js';
import './styles/index.css';
import { el } from './ui/dom.js';
import { editorView } from './views/editor.js';
import { createDocx } from './engine/docx.js';
import { paragraph } from './engine/model.js';
import { parseLink } from './collab/protocol.js';
import { localGuest } from './views/collab.js';

/** The local harness uses no cloud SDK or account. All files stay in this tab. */
class LocalDocument extends EventTarget {
  constructor(name, blob) { super(); this.name = name; this.blob = blob; this.dirty = false; this.path = null; }
  attach(exporter) { this.exporter = exporter; }
  changed() { if (this.writes === false) return; this.dirty = true; this.dispatchEvent(new Event('status')); }
  discardEdits() { this.dirty = false; }
  /** A tab that joined a local shared document keeps no changes of its own to download. */
  setSaving(on) { this.writes = on; if (!on) this.dirty = false; }
  async flush() { return true; }
  destroy() {}
}

let current, request = 0;
const host = el('div.playground-editor');
const open = async (name, blob, { initial = false, collab = null } = {}) => {
  const token = ++request;
  try {
    if (blob) { const { images } = await openCanvasDocument(blob); for (const image of images.values()) image.close(); }
  }
  catch (e) { document.getElementById('playground-error').textContent = e.message; return; }
  if (token !== request) return;
  if (!initial && current?.doc.dirty && !window.confirm('Open another document? Download your current changes first if you want to keep them.')) return;
  current?.destroy();
  const doc = new LocalDocument(name, blob);
  if (collab) { doc.collab = collab; doc.setSaving(false); }
  current = editorView({
    doc, local: true,
    goHome: () => sample(false), newDoc: () => open('Untitled document', null),
    importFile: file => open(file.name.replace(/\.docx$/i, ''), file),
  });
  host.replaceChildren(current.el);
  document.getElementById('playground-error').textContent = '';
  current.ready.catch(() => {});
};
function sample(long, initial = false) {
  const first = 'A small beginning. Click anywhere in this paragraph and start writing.';
  const second = 'Select words across these two paragraphs, apply bold, then undo. Download the DOCX and open it here again to check that your changes survived.';
  const ps = long ? [paragraph(first), paragraph(`${second} ${'Every page is another chance to make the editor a little better. '.repeat(60)}`)] : [paragraph(first), paragraph(second)];
  return open(long ? 'Across two pages' : 'Two paragraphs', createDocx(ps).export(), { initial });
}
document.getElementById('app').append(el('main.playground-shell', {},
  el('nav.playground-nav', { 'aria-label': 'Playground samples' },
    el('strong', {}, 'Editor playground'),
    el('button.btn', { onclick: () => open('Untitled document', null) }, 'New'),
    el('button.btn', { onclick: () => sample(false) }, 'Two paragraphs'),
    el('button.btn', { onclick: () => sample(true) }, 'Across pages'),
    el('details.playground-samples', {}, el('summary', {}, 'Sample documents'), el('div.playground-sample-list', {},
    el('a', { href: `${import.meta.env.BASE_URL}fixtures/two-paragraphs.docx`, download: true }, 'Sample DOCX'),
    el('a', { href: `${import.meta.env.BASE_URL}fixtures/font-formatting.docx`, download: true }, 'Font sample'),
    el('a', { href: `${import.meta.env.BASE_URL}fixtures/page-settings.docx`, download: true }, 'Page sample'),
    el('a', { href: `${import.meta.env.BASE_URL}fixtures/indents-tabs.docx`, download: true }, 'Indent/tab sample'),
    el('a', { href: `${import.meta.env.BASE_URL}fixtures/paragraph-pagination.docx`, download: true }, 'Pagination sample'),
    el('a', { href: `${import.meta.env.BASE_URL}fixtures/numbering.docx`, download: true }, 'List sample'),
    el('a', { href: `${import.meta.env.BASE_URL}fixtures/styles.docx`, download: true }, 'Style sample'),
    el('a', { href: `${import.meta.env.BASE_URL}fixtures/character-styles.docx`, download: true }, 'Character style sample'),
    el('a', { href: `${import.meta.env.BASE_URL}fixtures/contextual-spacing.docx`, download: true }, 'Contextual spacing sample'),
    el('a', { href: `${import.meta.env.BASE_URL}fixtures/tab-leaders.docx`, download: true }, 'Tab leaders sample'),
    el('a', { href: `${import.meta.env.BASE_URL}fixtures/row-heights.docx`, download: true }, 'Row heights sample'),
    el('a', { href: `${import.meta.env.BASE_URL}fixtures/exact-row-heights.docx`, download: true }, 'Exact row heights sample'),
    el('a', { href: `${import.meta.env.BASE_URL}fixtures/content-controls.docx`, download: true }, 'Temporary content controls sample'),
    el('a', { href: `${import.meta.env.BASE_URL}fixtures/line-spacing.docx`, download: true }, 'Line spacing sample'),
    el('a', { href: `${import.meta.env.BASE_URL}fixtures/style-line-spacing.docx`, download: true }, 'Style line spacing sample'),
    el('a', { href: `${import.meta.env.BASE_URL}fixtures/find-replace.docx`, download: true }, 'Find and replace sample'),
    el('a', { href: `${import.meta.env.BASE_URL}fixtures/clear-text-formatting.docx`, download: true }, 'Clear text formatting sample'),
    el('a', { href: `${import.meta.env.BASE_URL}fixtures/grouped-drawings.docx`, download: true }, 'Grouped drawings and sections sample'),
    el('a', { href: `${import.meta.env.BASE_URL}fixtures/annual-report.docx`, download: true }, 'Annual report feature sample'),
    el('a', { href: `${import.meta.env.BASE_URL}fixtures/artwork-metadata.docx`, download: true }, 'Locked and decorative artwork sample'),
    el('a', { href: `${import.meta.env.BASE_URL}fixtures/clear-paragraph-formatting.docx`, download: true }, 'Clear paragraph formatting sample'),
    el('a', { href: `${import.meta.env.BASE_URL}fixtures/kerning.docx`, download: true }, 'Kerning sample'),
    el('a', { href: `${import.meta.env.BASE_URL}fixtures/trailing-spaces.docx`, download: true }, 'Trailing spaces sample'),
    el('a', { href: `${import.meta.env.BASE_URL}fixtures/underlines.docx`, download: true }, 'Underline sample'),
    el('a', { href: `${import.meta.env.BASE_URL}fixtures/hyperlinks.docx`, download: true }, 'Hyperlink sample'),
    el('a', { href: `${import.meta.env.BASE_URL}fixtures/paragraph-shading.docx`, download: true }, 'Paragraph shading sample'),
    el('a', { href: `${import.meta.env.BASE_URL}fixtures/paragraph-borders.docx`, download: true }, 'Paragraph borders sample'),
    el('a', { href: `${import.meta.env.BASE_URL}fixtures/cell-alignment.docx`, download: true }, 'Cell alignment sample'),
    el('a', { href: `${import.meta.env.BASE_URL}fixtures/cell-shading.docx`, download: true }, 'Cell shading sample'),
    el('a', { href: `${import.meta.env.BASE_URL}fixtures/cell-borders.docx`, download: true }, 'Cell borders sample'),
    el('a', { href: `${import.meta.env.BASE_URL}fixtures/cell-margins.docx`, download: true }, 'Cell margins sample'),
    el('a', { href: `${import.meta.env.BASE_URL}fixtures/justification.docx`, download: true }, 'Justification sample'),
    el('a', { href: `${import.meta.env.BASE_URL}fixtures/bookmarks.docx`, download: true }, 'Bookmark sample'),
    el('a', { href: `${import.meta.env.BASE_URL}fixtures/capitalization.docx`, download: true }, 'Capitalization sample'),
    el('a', { href: `${import.meta.env.BASE_URL}fixtures/strikethrough.docx`, download: true }, 'Strikethrough sample'),
    el('a', { href: `${import.meta.env.BASE_URL}fixtures/text-width.docx`, download: true }, 'Text width sample'),
    el('a', { href: `${import.meta.env.BASE_URL}fixtures/character-spacing.docx`, download: true }, 'Character spacing sample'),
    el('a', { href: `${import.meta.env.BASE_URL}fixtures/baseline-shifts.docx`, download: true }, 'Baseline shift sample'),
    el('a', { href: `${import.meta.env.BASE_URL}fixtures/script-text.docx`, download: true }, 'Superscript and subscript sample'),
    el('a', { href: `${import.meta.env.BASE_URL}fixtures/style-toggles-on.docx`, download: true }, 'Style inheritance sample'),
    el('a', { href: `${import.meta.env.BASE_URL}fixtures/tables.docx`, download: true }, 'Table sample'),
    el('a', { href: `${import.meta.env.BASE_URL}fixtures/autofit-tables.docx`, download: true }, 'AutoFit sample'),
    el('a', { href: `${import.meta.env.BASE_URL}fixtures/merged-cells.docx`, download: true }, 'Merged cells sample'),
    el('a', { href: `${import.meta.env.BASE_URL}fixtures/vertical-cells.docx`, download: true }, 'Vertical cells sample'),
    el('a', { href: `${import.meta.env.BASE_URL}fixtures/vertical-pages.docx`, download: true }, 'Flowing tables sample'),
    el('a', { href: `${import.meta.env.BASE_URL}fixtures/table-headers.docx`, download: true }, 'Table headers sample'),
    el('a', { href: `${import.meta.env.BASE_URL}fixtures/inline-images.docx`, download: true }, 'Inline images sample'),
    el('a', { href: `${import.meta.env.BASE_URL}fixtures/cropped-images.docx`, download: true }, 'Cropped images sample'),
    el('a', { href: `${import.meta.env.BASE_URL}fixtures/flipped-images.docx`, download: true }, 'Flipped images sample'),
    el('a', { href: `${import.meta.env.BASE_URL}fixtures/rotated-images.docx`, download: true }, 'Rotated images sample'),
    el('a', { href: `${import.meta.env.BASE_URL}fixtures/outline-levels.docx`, download: true }, 'Outline sample'),
    el('a', { href: `${import.meta.env.BASE_URL}fixtures/text-colors.docx`, download: true }, 'Text color sample'),
    el('a', { href: `${import.meta.env.BASE_URL}fixtures/text-highlights.docx`, download: true }, 'Highlight sample'),
    )), el('a', { href: './index.html' }, 'Open app')),
  el('p', { id: 'playground-error', role: 'alert' }), host));
window.addEventListener('beforeunload', e => { if (current?.doc.dirty) { e.preventDefault(); e.returnValue = ''; } });
// A link from Share in another tab of this browser (#collab-local=…) joins that tab's document.
async function joinFromLink() {
  let link = null;
  try { link = parseLink(location.href); } catch (e) { document.getElementById('playground-error').textContent = e.message; }
  if (!link?.local) return false;
  try {
    const { joinRoom } = await import('./collab/live.js');
    const joined = await joinRoom(link, localGuest());
    await open(joined.name, new Blob([joined.base]), { initial: true, collab: { client: joined.client, link } });
    return true;
  } catch (e) { document.getElementById('playground-error').textContent = e.message; return false; }
}
joinFromLink().then(joined => { if (!joined) sample(false, true); });
