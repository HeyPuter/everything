// Metadata panel: the active audio file's tags, on tabs by format.
//   BWF: broadcast extension (description, originator, origination date and
//        time, time reference, UMID, coding history), written as a WAV bext chunk.
//   iXML: production sound fields (project, scene, take, tape, circled, note),
//        merged into the file's own iXML chunk (other elements are kept).
//   ID3: title, artist, album, year, genre, track and the other music tags,
//        written as ID3v2 (MP3, AIFF), Vorbis comments (FLAC, Ogg) or MP4 atoms.
//   RIFF: the WAV INFO list, sharing the general fields with ID3.
//   Cart: radio traffic fields, written as a WAV cart chunk.
//   XMP: Dublin Core properties (title, creator, description, rights,
//        keywords...), written as an XMP packet in WAV, MP3 and AIFF exports
//        (see audio/xmp.js for where and when).
// Fields shared between tabs are one value. Edits are undoable ("Edit
// Metadata") and are written into exports when "Include markers and other
// metadata" is on.

import { h } from '../lib/dom.js';
import { Fingerprint } from 'lucide';
import { icon, registerIcons } from '../ui/icons.js';
import { ALL_META_FIELDS, cleanMeta, newUmid } from '../audio/meta.js';
import { subTabs } from './subtabs.js';

/** New document state with one field changed (null when nothing changes). Pure. */
export function withMetaField(state, field, value) {
  const current = state.meta || {};
  const next = cleanMeta({ ...current, [field]: value });
  const before = cleanMeta(current);
  if (JSON.stringify(next) === JSON.stringify(before)) return null;
  return { ...state, meta: next };
}

/** Tabs and their fields; a second entry relabels a shared field for that format. */
export const META_TABS = [
  { id: 'bwf', label: 'BWF', note: 'Saved in WAV exports as a broadcast extension (bext) chunk.', fields: ['bextDescription', 'bextOriginator', 'bextOriginatorRef', 'bextDate', 'bextTime', 'bextTimeRef', 'bextUmid', 'bextCodingHistory'] },
  {
    id: 'ixml',
    label: 'iXML',
    note: 'Saved in WAV exports as an iXML chunk, read by field recorders and video editors. Other iXML data the file came with is kept.',
    fields: ['ixmlProject', 'ixmlScene', 'ixmlTake', 'ixmlTape', 'ixmlCircled', 'ixmlNote'],
  },
  {
    id: 'id3',
    label: 'ID3',
    note: 'Saved in MP3, AIFF, FLAC, Ogg and M4A exports.',
    fields: ['title', 'artist', 'album', 'albumArtist', 'year', 'track', 'genre', 'composer', 'copyright', 'bpm', 'key', 'comment'],
  },
  {
    id: 'riff',
    label: 'RIFF',
    note: 'Saved in WAV exports as an INFO list.',
    fields: [['title', 'Name'], 'artist', ['album', 'Product'], ['year', 'Creation Date'], 'genre', ['comment', 'Comments'], 'copyright', 'engineer', 'technician', 'software', 'subject', 'keywords', 'source', 'track'],
  },
  {
    id: 'cart',
    label: 'Cart',
    note: 'Saved in WAV exports as a cart chunk for broadcast traffic systems.',
    fields: ['title', 'artist', 'cartCutId', 'cartClientId', 'cartCategory', 'cartClassification', 'cartOutCue', 'cartStartDate', 'cartStartTime', 'cartEndDate', 'cartEndTime', 'cartUserDef', 'cartUrl', 'cartTagText'],
  },
  {
    id: 'xmp',
    label: 'XMP',
    note: 'Saved as an XMP packet in WAV (_PMX chunk), MP3 and AIFF (ID3 PRIV frame) exports when a field only XMP holds (Description, Publisher, Contributors, Language, Date, Identifier or Relation) is filled in. Separate keywords and other lists with commas, creators with semicolons.',
    fields: ['title', ['artist', 'Creator'], 'description', ['copyright', 'Rights'], 'keywords', 'publisher', 'contributor', 'language', 'xmpDate', 'identifier', 'source', 'relation'],
  },
];

const FIELD = new Map(ALL_META_FIELDS.map((f) => [f.id, f]));

/** Normalizes typed text for a field: trims, checks dates, times and whole numbers. Returns { value } or { error }. */
export function normalizeMetaValue(field, text) {
  const f = FIELD.get(field);
  let v = String(text ?? '').trim();
  if (!v) return { value: '' };
  if (f?.kind === 'int') {
    if (!/^\d+$/.test(v)) return { error: 'Enter a whole number.' };
    v = String(Number(v));
  } else if (f?.kind === 'date') {
    const m = v.match(/^(\d{4})[-/.:]?(\d{1,2})[-/.:]?(\d{1,2})$/);
    if (!m || Number(m[2]) < 1 || Number(m[2]) > 12 || Number(m[3]) < 1 || Number(m[3]) > 31) return { error: 'Enter a date as YYYY-MM-DD.' };
    v = `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  } else if (f?.kind === 'hex') {
    v = v.replace(/[\s:-]+/g, '');
    if (!/^([0-9a-fA-F]{2}){32}$|^([0-9a-fA-F]{2}){64}$/.test(v)) return { error: 'Enter 64 or 128 hexadecimal digits.' };
    return { value: v.toUpperCase() };
  } else if (f?.kind === 'bool') {
    if (/^(y|yes|true|1|on|circled)$/i.test(v)) return { value: 'TRUE' };
    if (/^(n|no|false|0|off)$/i.test(v)) return { value: 'FALSE' };
    return { error: 'Enter Yes or No.' };
  } else if (f?.kind === 'time') {
    const m = v.match(/^(\d{1,2})[:.-](\d{1,2})(?:[:.-](\d{1,2}))?$/);
    if (!m || Number(m[1]) > 23 || Number(m[2]) > 59 || Number(m[3] || 0) > 59) return { error: 'Enter a time as HH:MM:SS.' };
    v = [m[1], m[2], m[3] || '0'].map((x) => x.padStart(2, '0')).join(':');
  }
  if (f?.max && new TextEncoder().encode(v).length > f.max) return { error: `Use at most ${f.max} characters.` };
  return { value: v };
}

const pad2 = (n) => String(n).padStart(2, '0');

registerIcons({ fingerprint: Fingerprint });

export function metadataPanel(app) {
  const inputs = new Map(); // field id -> inputs showing it (one per tab)
  let n = 0;

  const commit = (fieldId, input, error) => {
    const doc = app.active;
    if (!doc || doc.kind !== 'audio') return;
    const r = normalizeMetaValue(fieldId, input.value);
    if (r.error) {
      input.setAttribute('aria-invalid', 'true');
      error.textContent = r.error;
      error.hidden = false;
      return;
    }
    input.removeAttribute('aria-invalid');
    error.hidden = true;
    input.value = r.value;
    const state = withMetaField(doc.state, fieldId, r.value);
    if (state) doc.apply('Edit Metadata', state);
  };

  const fieldRow = (spec) => {
    const [fieldId, label] = Array.isArray(spec) ? spec : [spec, null];
    const f = FIELD.get(fieldId);
    const id = `meta-${fieldId}-${++n}`;
    const errId = `${id}-err`;
    const placeholder = f.kind === 'date' ? 'YYYY-MM-DD' : f.kind === 'time' ? 'HH:MM:SS' : f.kind === 'bool' ? 'Yes or No' : null;
    const input = f.multiline
      ? h('textarea.input.meta-comment', { id, rows: fieldId === 'bextDescription' ? 2 : 3, spellcheck: 'true', 'aria-describedby': errId })
      : h(`input.input${f.kind === 'hex' ? '.meta-hex' : ''}`, { id, type: 'text', autocomplete: 'off', spellcheck: f.kind === 'hex' ? 'false' : null, placeholder, inputMode: f.kind === 'int' || fieldId === 'year' ? 'numeric' : null, maxLength: f.kind === 'hex' ? 200 : f.max || (fieldId === 'year' ? 10 : 500), 'aria-describedby': errId });
    const error = h('div.meta-error', { id: errId, hidden: true, role: 'alert' });
    input.addEventListener('change', () => commit(fieldId, input, error));
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter' && !f.multiline) {
        commit(fieldId, input, error);
        input.blur();
      } else if (e.key === 'Escape') {
        input.value = app.active?.state?.meta?.[fieldId] || '';
        input.removeAttribute('aria-invalid');
        error.hidden = true;
        input.blur();
      }
    });
    if (!inputs.has(fieldId)) inputs.set(fieldId, []);
    inputs.get(fieldId).push(input);
    return [h('label', { for: id }, `${label || f.label}:`), h('div.meta-field', input, error)];
  };

  /** BWF: fills the origination date and time with now (and the originator when empty). */
  const stampNow = () => {
    const doc = app.active;
    if (!doc || doc.kind !== 'audio') return;
    const d = new Date();
    const meta = {
      ...(doc.state.meta || {}),
      bextDate: `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`,
      bextTime: `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`,
    };
    if (!meta.bextOriginator) meta.bextOriginator = 'Audio Studio';
    doc.apply('Edit Metadata', { ...doc.state, meta: cleanMeta(meta) });
  };

  /** BWF: a new basic UMID (replacing the current one). */
  const generateUmid = () => {
    const doc = app.active;
    if (!doc || doc.kind !== 'audio') return;
    const state = withMetaField(doc.state, 'bextUmid', newUmid());
    if (state) doc.apply('Edit Metadata', state);
  };

  const tabs = subTabs(
    META_TABS.map((t) => {
      const form = h('div.form-grid.meta-form', ...t.fields.flatMap(fieldRow));
      const extra = t.id === 'bwf'
        ? h(
            'div.meta-actions',
            h('button.btn.sm', { type: 'button', title: 'Set the origination date and time to now', onclick: stampNow }, icon('clock', 13), 'Stamp Date and Time'),
            h('button.btn.sm', { type: 'button', title: 'Give the file a new unique material identifier', onclick: generateUmid }, icon('fingerprint', 13), 'New UMID'),
          )
        : null;
      return { id: t.id, label: t.label, pane: h('div.meta-pane', form, extra, h('p.muted.meta-note', t.note)) };
    }),
    { label: 'Metadata formats', value: app.prefs.get('metadataTab') || 'bwf', onChange: (id) => app.prefs.set('metadataTab', id) },
  );
  const empty = h('div.empty-state', 'Open an audio file to edit its metadata.');
  const el = h('div.metadata-panel', tabs.el, empty);

  const render = () => {
    const doc = app.active;
    const ok = doc?.kind === 'audio';
    tabs.el.hidden = !ok;
    empty.hidden = ok;
    if (!ok) return;
    const meta = doc.state.meta || {};
    for (const [id, list] of inputs) {
      for (const input of list) {
        if (document.activeElement === input) continue;
        input.value = meta[id] || '';
        input.removeAttribute('aria-invalid');
        input.nextElementSibling.hidden = true;
      }
    }
    // Tabs with content get a dot, so filled-in formats are easy to find.
    for (const t of META_TABS) {
      const btn = tabs.bar.querySelector(`[data-tab="${t.id}"]`);
      btn?.classList.toggle('has-data', t.fields.some((spec) => meta[Array.isArray(spec) ? spec[0] : spec]));
    }
  };
  app.on('active', render);
  app.on('doc-change', (doc, e) => doc === app.active && (e.kind === 'edit' || e.kind === 'history') && render());
  render();
  return { el, show: render, focus: () => tabs.bar.querySelector('[aria-selected=true]')?.focus() };
}
