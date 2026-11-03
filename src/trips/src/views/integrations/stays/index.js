// Dawarich stays as journey check-ins and bucket-list matches, mounted in the Dawarich dialogs (dawarich.js).
import { el } from '../../../ui/dom.js';
import { button, chip } from '../../../ui/bits.js';
import { openMenu } from '../../../ui/menu.js';
import { toast } from '../../../ui/toast.js';
import { t } from '../../../lib/i18n/index.js';
import { formatDate } from '../../../lib/format.js';
import { newId } from '../../../shared/ids.js';
import { createBucketStore } from '../../../lib/atlas/bucket.js';
import { bucketMatches, journeyEntries } from '../../../lib/integrations/dawarich-match.js';
import { icon } from '../icons.js';

const titleOf = (entry) => entry?.title || t('dawarichMore.untitledJourney');

/** Journeys the user can write in, from `me:spaces`. */
export async function writableJourneys(personal) {
  let list = [];
  try { list = (await personal?.spaces?.list()) ?? []; } catch { list = []; }
  return list.filter((entry) => entry?.ref?.k === 'journey' && ['owner', 'editor'].includes(entry.role));
}

/**
 * "Add to journey…" for the stays dialog. `selected()` gives the chosen stays (with `name`, `date`, `time`, `lat`,
 * `lng`, `key`); `onAdded(stays, journeyId)` records the review decision. Hidden without journeys or a session.
 */
export function journeyButton({ context, selected, onAdded, onError }) {
  const session = context.session;
  const personal = session?.personal ?? context.personal;
  const node = button(t('dawarichMore.toJourney'), { variant: 'outline', hidden: true, onclick: () => void choose() });
  node.prepend(icon('stay', 16));
  let journeys = [];
  void writableJourneys(personal).then((list) => { journeys = list; node.hidden = !list.length || !session?.api; });

  async function add(journey) {
    const stays = selected();
    if (!stays.length) return;
    let drafts;
    try { drafts = journeyEntries(stays, { fallbackTitle: t('integrations.dawarich.unnamed') }); } catch (error) { onError(error); return; }
    const ops = drafts.map((fields) => ({ opId: newId(), t: 'entry', id: newId(), put: fields }));
    node.setAttribute('aria-busy', 'true');
    try {
      const response = await session.api.commit(journey.ref, JSON.stringify({ op: 'commit', space: journey.ref.s, ops }));
      if (!ops.every((op) => Number.isSafeInteger(response?.done?.[op.opId]))) throw Object.assign(new Error('invalid_commit_response'), { status: 502 });
      toast(t(ops.length === 1 ? 'dawarichMore.addedOne' : 'dawarichMore.added', { count: new Intl.NumberFormat().format(ops.length), journey: titleOf(journey) }),
        context.app?.navigate ? { action: { label: t('dawarichMore.openJourney'), onClick: () => context.app.navigate(`#/j/${journey.ref.w}/${journey.ref.s}`) } } : undefined);
      await onAdded(stays, journey.ref.s);
    } catch (error) { onError(error); } finally { node.setAttribute('aria-busy', 'false'); }
  }
  function choose() {
    if (journeys.length === 1) { void add(journeys[0]); return; }
    openMenu(node, journeys.map((journey) => ({ label: titleOf(journey), icon: 'map', onSelect: () => void add(journey) })));
  }
  return node;
}

/**
 * Bucket-list items the stays reached, to mark visited. `locate(lat, lng)` is the atlas country lookup. Returns
 * `{element}` (empty when nothing matches) after reading the bucket list.
 */
export async function bucketSection({ puter, personal, stays, locate, onError }) {
  if (!personal?.get) return { element: null };
  const store = createBucketStore({ personal, puter });
  let items = [];
  try { items = await store.list(); } catch { return { element: null }; }
  const matches = bucketMatches(stays, items, { locate });
  if (!matches.length) return { element: null };
  const rows = matches.map((match) => ({ match, input: el('input', { type: 'checkbox', checked: true, onchange: () => sync() }) }));
  const mark = button('', { variant: 'primary', onclick: () => void save() });
  const sync = () => {
    const n = rows.filter((row) => row.input.checked && !row.input.disabled).length;
    mark.textContent = n ? t(n === 1 ? 'dawarichMore.markOne' : 'dawarichMore.mark', { count: new Intl.NumberFormat().format(n) }) : t('dawarichMore.choose');
    mark.disabled = !n;
  };
  async function save() {
    mark.setAttribute('aria-busy', 'true');
    try {
      for (const row of rows) {
        if (!row.input.checked || row.input.disabled) continue;
        await store.setVisited(row.match.item.id, row.match.date);
        row.input.disabled = true;
        row.node.append(chip(t('dawarichMore.marked'), { status: 'success' }));
      }
      toast(t('dawarichMore.markedToast'));
    } catch (error) { onError(error); } finally { mark.setAttribute('aria-busy', 'false'); sync(); }
  }
  const list = el('ul.int-rows', { 'aria-label': t('dawarichMore.bucketLabel') }, rows.map((row) => {
    const { item, stay } = row.match;
    row.node = el('label.int-row-main', {}, row.input, icon('flag', 16),
      el('span.int-row-text', {}, el('span.int-row-name', {}, item.name || item.cc),
        el('span.int-row-meta', {}, t('dawarichMore.reached', { stay: stay.name || t('integrations.dawarich.unnamed'), date: formatDate(stay.date) }))));
    return el('li.int-row', {}, row.node);
  }));
  sync();
  return { element: el('section.int-group', {}, el('h3.int-group-title', {}, t('dawarichMore.bucketTitle')), el('p.int-muted', {}, t('dawarichMore.bucketIntro')), list, el('div.modal-actions', {}, mark)) };
}
