/**
 * SVG Interactivity panel: JavaScript event handlers on objects and script
 * files for the document, written into exported SVG (as on* attributes and
 * <script> elements) for interactive web graphics. Nothing runs in the
 * editor.
 *
 *   node.svgEvents   { onclick: 'code', ... }
 *   root.svgScripts  [url, ...]      script files the SVG links to
 *   root.svgScript   'code'          a script embedded in the SVG
 */
import { h } from '../../lib/dom.js';
import { Panel, emptyState, setListItems } from '../../ui/panels/panel.js';
import { iconButton } from '../../ui/widgets.js';
import { registerIcons } from '../../ui/icons.js';
import { openDialog } from '../../ui/dialogs/dialog.js';
import { svgExportHooks } from '../io/hooks.js';
import './styles.css';

export const SVG_EVENTS = ['onclick', 'onmousedown', 'onmouseup', 'onmouseover', 'onmousemove', 'onmouseout', 'onfocusin', 'onfocusout', 'onkeydown', 'onkeyup', 'onload'];

const attr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/\n/g, '&#10;');

export function svgEventAttrs(node) {
  const ev = node?.svgEvents;
  if (!ev) return '';
  let out = '';
  for (const name of SVG_EVENTS) if (ev[name]) out += ` ${name}="${attr(ev[name])}"`;
  return out;
}

export function svgScriptMarkup(doc) {
  const root = doc?.root;
  if (!root) return '';
  const parts = [];
  for (const url of root.svgScripts || []) if (url) parts.push(`<script href="${attr(url)}"/>`);
  if (root.svgScript) parts.push(`<script><![CDATA[\n${String(root.svgScript).replace(/]]>/g, ']]]]><![CDATA[>')}\n]]></script>`);
  return parts.join('');
}

registerIcons({
  'panel-svg-interactivity': [['path', { d: 'M4 6h16v12H4z', 'stroke-linejoin': 'round' }], ['path', { d: 'm9 10-2 2 2 2M15 10l2 2-2 2M13 9l-2 6' }]],
});

export class SvgInteractivityPanel extends Panel {
  static id = 'svgInteractivity';
  static title = 'SVG Interactivity';
  static icon = 'panel-svg-interactivity';

  menu() {
    const ed = this.app.editor;
    const node = ed && ed.selection.size === 1 ? ed.selectedNodes()[0] : null;
    const withEvents = [];
    ed?.doc.walk((n) => {
      if (n.svgEvents) withEvents.push(n.id);
    });
    const root = ed?.doc.root;
    return [
      { label: 'Remove Event', enabled: Boolean(node?.svgEvents?.[this.eventSel.value]), run: () => this.setEvent(this.eventSel.value, '') },
      { label: 'Clear Events', enabled: Boolean(node?.svgEvents), run: () => ed.doc.transact('Clear Events', () => ed.doc.update(node.id, { svgEvents: undefined })) },
      { label: 'Clear All Events in Document', enabled: withEvents.length > 0, run: () => ed.doc.transact('Clear All Events', () => withEvents.forEach((id) => ed.doc.update(id, { svgEvents: undefined }))) },
      { label: 'Select Objects with Events', enabled: withEvents.length > 0, run: () => ed.select(withEvents) },
      '-',
      { label: 'Document Scripts...', enabled: Boolean(ed), run: () => this.editScripts() },
      { label: 'Remove All Scripts', enabled: Boolean(root?.svgScripts?.length || root?.svgScript), run: () => ed.doc.transact('Remove Scripts', () => ed.doc.updateRoot({ svgScripts: undefined, svgScript: undefined })) },
    ];
  }

  build() {
    this.eventSel = h('select.svgi-event', { 'aria-label': 'Event' }, SVG_EVENTS.map((e) => h('option', { value: e }, e)));
    this.code = h('textarea.svgi-code', { rows: 3, placeholder: 'JavaScript, e.g. alert(evt.target.id)', 'aria-label': 'JavaScript for the event', spellcheck: false });
    this.code.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) this.addEvent();
    });
    this.addBtn = h('button.btn.small', { type: 'button', onclick: () => this.addEvent() }, 'Set Event');
    this.list = h('div.svgi-list', { role: 'list', 'aria-label': 'Events on the selected object' });
    this.scriptsBtn = h('button.btn.small', { type: 'button', onclick: () => this.editScripts() }, 'Document Scripts…');
    this.el.append(h('div.svgi-form', h('div.svgi-row', this.eventSel, this.addBtn), this.code), this.list, h('div.svgi-footer', this.scriptsBtn));
  }

  update() {
    const ed = this.app.editor;
    this.el.classList.toggle('disabled', !ed);
    const node = ed && ed.selection.size === 1 ? ed.selectedNodes()[0] : null;
    this.node = node;
    this.addBtn.disabled = !node;
    this.code.disabled = !node;
    this.scriptsBtn.disabled = !ed;
    if (!ed) return setListItems(this.list, [], emptyState('Open a document to add interactivity.'));
    if (!node) return setListItems(this.list, [], emptyState('Select one object to give it event handlers for SVG export.'));
    const entries = Object.entries(node.svgEvents || {}).filter(([, v]) => v);
    setListItems(
      this.list,
      entries.map(([name, code]) =>
        h(
          'div.svgi-item',
          { role: 'listitem' },
          h('button.svgi-name', { type: 'button', 'aria-label': `Edit ${name}`, onclick: () => ((this.eventSel.value = name), (this.code.value = code), this.code.focus()) }, name),
          h('code.svgi-snippet', code),
          iconButton('trash', `Remove ${name}`, () => this.setEvent(name, ''), { className: 'small' }),
        ),
      ),
      h('p.panel-empty', 'No events. Choose an event, type JavaScript and Set Event.'),
    );
  }

  setEvent(name, code) {
    const ed = this.app.editor;
    const node = this.node;
    if (!ed || !node) return;
    const events = { ...(node.svgEvents || {}) };
    if (code) events[name] = code;
    else delete events[name];
    ed.doc.transact('SVG Interactivity', () => ed.doc.update(node.id, { svgEvents: Object.keys(events).length ? events : undefined }));
  }

  addEvent() {
    const code = this.code.value.trim();
    if (!code) return;
    this.setEvent(this.eventSel.value, code);
    this.code.value = '';
  }

  async editScripts() {
    const ed = this.app.editor;
    const root = ed.doc.root;
    const urls = h('textarea.svgi-code', { rows: 3, placeholder: 'One script URL per line', spellcheck: false }, (root.svgScripts || []).join('\n'));
    const inline = h('textarea.svgi-code', { rows: 6, placeholder: 'JavaScript embedded in the SVG', spellcheck: false }, root.svgScript || '');
    for (const t of [urls, inline]) t.addEventListener('keydown', (e) => e.stopPropagation());
    const ok = await openDialog({
      title: 'Document Scripts',
      body: h('div.form', h('label.svgi-label', 'Linked script files', urls), h('label.svgi-label', 'Embedded script', inline), h('p.form-help', 'Scripts are written into exported SVG files and run when the SVG is opened in a browser.')),
      buttons: [
        { label: 'Cancel', value: false },
        { label: 'OK', primary: true, value: true },
      ],
    });
    if (!ok) return;
    const list = urls.value.split('\n').map((s) => s.trim()).filter(Boolean);
    ed.doc.transact('Document Scripts', () => ed.doc.updateRoot({ svgScripts: list.length ? list : undefined, svgScript: inline.value.trim() || undefined }));
  }
}

export function install(app) {
  app.registerPanel(SvgInteractivityPanel);
  if (!svgExportHooks.attrs.includes(svgEventAttrs)) svgExportHooks.attrs.push(svgEventAttrs);
  if (!svgExportHooks.head.includes(svgScriptMarkup)) svgExportHooks.head.push(svgScriptMarkup);
}
