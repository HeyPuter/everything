import { el, uid } from '../../../../ui/dom.js';
import { button } from '../../../../ui/bits.js';
import { confirmDialog } from '../../../../ui/modal.js';
import { toast } from '../../../../ui/toast.js';
import { t } from '../../../../lib/i18n/index.js';
import { groupOf } from '../../../../lib/res/index.js';
import { clearJob, commitJob, discardCandidate, editCandidate, mergeCandidates, readyCandidates, setAction } from '../../../../lib/ai/import/job.js';
import { typeLabel } from '../display.js';
import { servicesFor, zoneDatalist } from '../pickers.js';
import { candidateCard } from './card.js';
import { sourceLine } from './progress.js';
import { icon } from './icons.js';

/**
 * The review step: one card per candidate, merge and discard, duplicate actions, and the batch commit.
 * `upload(file, links)` attaches source files after the write (omitted when the user cannot upload).
 */
export function reviewStep({ space, session, spaceId, initial, upload, close }) {
  const db = session?.db;
  const services = servicesFor(session);
  const zones = zoneDatalist();
  const cards = new Map();
  const selected = new Set();
  let job = initial;
  let busy = false;

  const reservations = () => space.select?.res?.all() ?? [];
  const opts = () => ({ db, reservations: reservations(), fallbackTitle: typeLabel });
  const headingId = uid('bi-review');
  const heading = el('h3.bi-section-title', { id: headingId, tabIndex: -1 });
  const notices = el('div.bi-notices');
  const alert = el('p.bi-note.danger', { role: 'alert', hidden: true });
  const list = el('ol.bi-cards', { 'aria-labelledby': headingId });
  const mergeButton = el('button.btn.btn-outline.btn-sm', { type: 'button', disabled: true, onclick: () => merge() }, icon('merge', 16), t('bookingImport.merge'));
  const commitButton = button(t('bookingImport.commit'), { variant: 'primary', onclick: () => commit() });
  const discardAll = button(t('bookingImport.discardAll'), { variant: 'ghost', onclick: async () => {
    if (await confirmDialog({ title: t('bookingImport.discardAllTitle'), body: t('bookingImport.discardAllBody'), confirmLabel: t('bookingImport.discardAll'), danger: true })) {
      await clearJob({ db, spaceId });
    }
  } });
  const element = el('div.bi-review', {},
    el('div.bi-review-head', {}, heading, el('p.bi-hint', {}, t('bookingImport.reviewHint'))),
    notices,
    el('div.bi-toolbar', { role: 'toolbar', 'aria-label': t('bookingImport.toolbar') }, mergeButton),
    list,
    zones.element,
    alert,
    el('div.modal-actions', {}, discardAll, button(t('bookingImport.later'), { onclick: () => close() }), commitButton));

  const ctx = {
    services, datalist: zones.id,
    resTitle: (id) => space.get?.('res', id)?.title ?? t('bookingImport.existingBooking'),
    candidateTitle: (id) => job?.candidates.find((candidate) => candidate.id === id)?.draft.title ?? '',
    onEdit: (id, fields) => editCandidate(spaceId, id, fields, opts()),
    onAction: (id, action) => setAction(spaceId, id, action, opts()),
    onDiscard: (id) => {
      const ids = job.candidates.map((candidate) => candidate.id);
      const next = ids[ids.indexOf(id) + 1] ?? ids[ids.indexOf(id) - 1];
      selected.delete(id);
      discardCandidate(spaceId, id, opts());
      (next && cards.get(next) ? cards.get(next) : { focus: () => heading.focus() }).focus();
    },
    onSelect: (id, on) => { if (on) selected.add(id); else selected.delete(id); paintToolbar(); },
  };

  function mergeable() {
    const chosen = job.candidates.filter((candidate) => selected.has(candidate.id));
    return chosen.length >= 2 && chosen.every((candidate) => groupOf(candidate.draft.type) === groupOf(chosen[0].draft.type));
  }
  function paintToolbar() {
    mergeButton.disabled = !mergeable();
    mergeButton.title = selected.size >= 2 && !mergeable() ? t('bookingImport.mergeMixed') : '';
  }
  function merge() {
    if (!mergeable()) return;
    const ids = job.candidates.filter((candidate) => selected.has(candidate.id)).map((candidate) => candidate.id);
    selected.clear();
    mergeCandidates(spaceId, ids, opts());
    const merged = job.candidates.find((candidate) => candidate.sourceIds && candidate.id.startsWith(`${ids[0]}+`));
    (merged && cards.get(merged.id))?.focus();
    toast(t('bookingImport.merged', { count: ids.length }));
  }

  function paintNotices() {
    const lines = [];
    if (job.error === 'credit') lines.push(el('p.bi-note.warn', { role: 'status' }, t('bookingImport.error.creditPartial')));
    const problems = job.sources.filter((source) => source.error || ['interrupted', 'skipped', 'cancelled'].includes(source.state) || source.notes?.length);
    if (problems.length) lines.push(el('ul.bi-sources', { 'aria-label': t('bookingImport.sourceProblems') }, problems.map(sourceLine)));
    notices.replaceChildren(...lines);
    notices.hidden = !lines.length;
  }

  function paint() {
    const ready = readyCandidates(job);
    const count = job.candidates.length;
    heading.textContent = count ? (count === 1 ? t('bookingImport.foundOne') : t('bookingImport.foundMany', { count })) : t('bookingImport.foundNone');
    commitButton.textContent = ready.length === 1 ? t('bookingImport.commitOne') : t('bookingImport.commitMany', { count: ready.length });
    commitButton.disabled = !ready.length || busy;
    paintNotices();
    const ids = new Set(job.candidates.map((candidate) => candidate.id));
    for (const [id, card] of cards) if (!ids.has(id)) { card.element.remove(); cards.delete(id); selected.delete(id); }
    let previous = null;
    for (const candidate of job.candidates) {
      let card = cards.get(candidate.id);
      if (card) card.update(candidate);
      else { card = candidateCard(candidate, ctx); cards.set(candidate.id, card); }
      card.setSelected(selected.has(candidate.id));
      const expected = previous ? previous.nextSibling : list.firstChild;
      if (expected !== card.element) list.insertBefore(card.element, expected);
      previous = card.element;
    }
    list.hidden = !count;
    paintToolbar();
  }

  async function commit() {
    if (busy || !readyCandidates(job).length) return;
    busy = true;
    alert.hidden = true;
    commitButton.setAttribute('aria-busy', 'true');
    let result;
    try {
      result = await commitJob({ space, spaceId, db, history: t('bookingImport.history'), upload: space.can?.('files.upload') ? upload : undefined });
    } catch {
      busy = false;
      commitButton.setAttribute('aria-busy', 'false');
      alert.textContent = t('bookingImport.commitFailed');
      alert.hidden = false;
      paint();
      return;
    }
    close('saved');
    const offline = ['offline', 'queued'].includes(space.state?.sync);
    const message = result.updated
      ? t('bookingImport.addedUpdated', { created: result.created, updated: result.updated })
      : result.created === 1 ? t('bookingImport.addedOne') : t('bookingImport.addedMany', { count: result.created });
    toast(`${message} ${t(offline ? 'bookingImport.addedOffline' : 'bookingImport.addedReview')}`);
    void result.attachments.then(({ failed }) => { if (failed) toast(t('bookingImport.attachFailed')); });
  }

  paint();
  return {
    element,
    update(next) { job = next; paint(); },
    focus: () => heading.focus(),
  };
}
