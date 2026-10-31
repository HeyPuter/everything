import { el } from '../../../ui/dom.js';
import { button, emptyState } from '../../../ui/bits.js';
import { avatarStack } from '../../../ui/avatar.js';
import { checkbox, field } from '../../../ui/fields.js';
import { openMenu } from '../../../ui/menu.js';
import { confirmDialog } from '../../../ui/modal.js';
import { t } from '../../../lib/i18n/index.js';
import { zonedInstant, zonedParts } from '../../../shared/dates.js';
import { formDialog, icon, iconAction, keepFocus, plural, reconcile, revisionOf, statusChip } from './common.js';
import { nextVote, onStateKey, percentages, pollView, accessKey, votePatch } from './model.js';

const MAX_OPTIONS = 20;
const LONGEST_TIMER = 2 ** 31 - 1;

/** Polls: single or multiple choice, optional deadline (closed once it passes), results after voting. */
export function mountPolls(container, ctx) {
  const { space, uid } = ctx;
  let scheduled = false;
  let destroyed = false;
  let timer;
  let membersVersion = 0;
  const cache = new Map();

  const addButton = button(t('collab.polls.add'), { variant: 'primary', size: 'sm', icon: 'plus', onclick: () => openPollForm() });
  const list = el('ul.poll-list', { 'aria-label': t('collab.polls.list') });
  const empty = el('div', { hidden: true });
  container.replaceChildren(el('div.collab-section', {}, el('div.collab-toolbar', {}, el('span'), addButton), empty, list));

  function vote(poll, index) {
    const current = space.get('poll', poll.id);
    if (!current || !ctx.canPost()) return;
    void ctx.apply([space.ops.patch('poll', poll.id, votePatch(uid, nextVote(current, uid, index)))], { flush: true });
  }
  function withdraw(poll) { void ctx.apply([space.ops.patch('poll', poll.id, votePatch(uid, []))], { flush: true }); }
  function setClosed(poll, closed) {
    void ctx.apply([space.ops.patch('poll', poll.id, closed ? { set: { closed: true } } : { unset: ['closed'] })], { flush: true });
  }
  async function remove(poll) {
    if (await confirmDialog({ title: t('collab.polls.deleteTitle'), body: t('collab.polls.deleteBody', { question: poll.question }), confirmLabel: t('collab.delete'), danger: true })) {
      await ctx.apply([space.ops.remove('poll', poll.id)], { flush: true });
    }
  }

  function stateChip(poll, view) {
    if (poll.closed) return statusChip(t('collab.polls.closed'));
    if (view.expired) return statusChip(t('collab.polls.ended', { time: ctx.dateTime(poll.deadline) }));
    if (poll.deadline != null) return statusChip(t('collab.polls.closes', { time: ctx.dateTime(poll.deadline) }), 'accent');
    return null;
  }

  function optionContent(poll, view, index, shares) {
    const count = view.counts[index];
    const chosen = view.mine.includes(index);
    const people = view.voters[index].map((id) => { const person = ctx.person(id); return { id, name: person.name, photo: person.photo }; });
    return [
      el('span.poll-option-main', {},
        el('span.poll-check', { 'aria-hidden': 'true' }, chosen && icon('check', 14)),
        el('bdi.poll-option-label', {}, poll.options[index]),
        view.showResults && el('span.poll-count.num', {}, t('collab.polls.share', { percent: shares[index] }))),
      view.showResults && el('span.poll-bar', { 'aria-hidden': 'true' }, el('span.poll-bar-fill', { style: { '--share': `${shares[index]}%` } })),
      view.showResults && people.length > 0 && el('span.poll-voters', {}, avatarStack(people, { max: 5, size: 20 }), el('span.poll-votes', {}, plural(count, 'collab.polls.votesOne', 'collab.polls.votes'))),
    ];
  }

  function optionLabel(poll, view, index, shares) {
    const parts = [poll.options[index]];
    if (view.showResults) parts.push(plural(view.counts[index], 'collab.polls.votesOne', 'collab.polls.votes'), t('collab.polls.share', { percent: shares[index] }));
    return parts.join(', ');
  }

  function card(poll, view) {
    const manage = ctx.canManage(poll);
    const canVote = ctx.canPost() && !view.closed;
    const overlay = space.overlay('poll', poll.id);
    const shares = percentages(view.counts, view.people);
    const options = poll.options.map((_, index) => (canVote
      ? el(`button.poll-option${view.mine.includes(index) ? '.is-chosen' : ''}`, { type: 'button', 'aria-pressed': String(view.mine.includes(index)), 'aria-label': optionLabel(poll, view, index, shares), onclick: () => vote(poll, index) }, optionContent(poll, view, index, shares))
      : el(`div.poll-option.is-static${view.mine.includes(index) ? '.is-chosen' : ''}`, { role: 'listitem' }, optionContent(poll, view, index, shares))));
    const menuItems = manage ? [
      !view.closed && { label: t('collab.polls.close'), onSelect: () => setClosed(poll, true) },
      poll.closed && !view.expired && { label: t('collab.polls.reopen'), onSelect: () => setClosed(poll, false) },
      { label: t('collab.edit'), icon: 'pencil', onSelect: () => openPollForm(poll) },
      { separator: true },
      { label: t('collab.delete'), icon: 'trash', danger: true, onSelect: () => void remove(poll) },
    ].filter(Boolean) : [];
    return el('li', { dataset: { key: poll.id } }, el(`article.poll-card${view.closed ? '.is-closed' : ''}`, { 'aria-label': poll.question },
      el('div.poll-head', {},
        el('div.poll-title', {}, el('h3', {}, el('bdi', {}, poll.question)),
          el('span.poll-meta', {}, ctx.author(poll).name, ' · ', ctx.timeNode(poll.cr))),
        manage && iconAction('more', t('collab.polls.actions', { question: poll.question }), { onclick: (event) => openMenu(event.currentTarget, menuItems) })),
      el('div.poll-chips', {}, poll.multi && statusChip(t('collab.polls.multi')), stateChip(poll, view),
        overlay.local && statusChip(t('collab.saving')), overlay.conflict && statusChip(t('collab.notSaved'), 'warn')),
      el('div.poll-options', canVote ? { role: 'group', 'aria-label': t(poll.multi ? 'collab.polls.chooseMany' : 'collab.polls.chooseOne') } : { role: 'list' }, options),
      el('div.poll-foot', {},
        el('span.poll-summary', {}, view.showResults ? plural(view.people, 'collab.polls.peopleOne', 'collab.polls.people')
          : t(canVote ? 'collab.polls.voteToSee' : 'collab.polls.hidden', { count: view.people })),
        canVote && view.voted && button(t('collab.polls.withdraw'), { size: 'sm', variant: 'ghost', onclick: () => withdraw(poll) }))));
  }

  function render() {
    scheduled = false;
    clearTimeout(timer);
    if (destroyed) return;
    addButton.hidden = !ctx.canPost();
    const now = ctx.now();
    const polls = space.select.poll.all().map((poll) => ({ poll, view: pollView(poll, { uid, now }) }))
      .sort((a, b) => Number(a.view.closed) - Number(b.view.closed) || (b.poll.cr ?? 0) - (a.poll.cr ?? 0));
    const keep = new Set();
    keepFocus(list, () => reconcile(list, polls.map(({ poll, view }) => {
      keep.add(poll.id);
      const overlay = space.overlay('poll', poll.id);
      const sig = [revisionOf(poll), view.closed, overlay.local, overlay.conflict, ctx.canManage(poll), ctx.canPost(), membersVersion].join('|');
      const cached = cache.get(poll.id);
      if (cached?.sig === sig) return cached.node;
      const node = card(poll, view);
      cache.set(poll.id, { sig, node });
      return node;
    })));
    for (const id of cache.keys()) if (!keep.has(id)) cache.delete(id);
    empty.hidden = polls.length > 0;
    if (!polls.length) empty.replaceChildren(emptyState({ title: t('collab.polls.emptyTitle'), body: t(ctx.canPost() ? 'collab.polls.emptyBody' : 'collab.polls.emptyReadOnly'), icon: 'check',
      action: ctx.canPost() && button(t('collab.polls.add'), { variant: 'primary', icon: 'plus', onclick: () => openPollForm() }) }));
    // Re-render when the next deadline passes, so the poll shows as closed without a reload.
    const next = Math.min(...polls.map(({ poll, view }) => (!view.closed && poll.deadline != null ? poll.deadline - now : Infinity)));
    if (Number.isFinite(next)) timer = setTimeout(schedule, Math.min(LONGEST_TIMER, Math.max(0, next) + 500));
  }
  function schedule() { if (!scheduled && !destroyed) { scheduled = true; queueMicrotask(render); } }

  function localValue(epoch) {
    try { const { date, time } = zonedParts(epoch, ctx.zone); return `${date}T${time}`; } catch { return ''; }
  }

  function openPollForm(poll = null) {
    const voted = poll ? pollView(poll, { uid, now: ctx.now() }).people > 0 : false;
    const question = field({ label: t('collab.polls.question'), value: poll?.question ?? '', maxLength: 500, required: true, disabled: voted });
    const optionList = el('div.poll-form-options');
    const optionError = el('span.field-error', { role: 'alert', hidden: true });
    const addOption = button(t('collab.polls.addOption'), { size: 'sm', icon: 'plus', disabled: voted, onclick: () => { addRow(''); rows.at(-1).input.focus(); } });
    const rows = [];
    function syncRows() {
      rows.forEach((row, index) => {
        row.input.setAttribute('aria-label', t('collab.polls.option', { number: index + 1 }));
        row.remove.disabled = voted || rows.length <= 2;
      });
      addOption.disabled = voted || rows.length >= MAX_OPTIONS;
    }
    function addRow(value) {
      const input = el('input.input', { value, maxLength: 500, disabled: voted });
      const row = { input };
      row.remove = iconAction('close', t('collab.polls.removeOption'), { onclick: () => {
        rows.splice(rows.indexOf(row), 1); row.node.remove(); syncRows(); rows.at(-1)?.input.focus();
      } });
      row.node = el('div.poll-form-option', {}, input, row.remove);
      rows.push(row); optionList.append(row.node); syncRows();
    }
    for (const option of poll?.options ?? ['', '']) addRow(option);
    let multi = Boolean(poll?.multi);
    const multiField = checkbox(t('collab.polls.multiLabel'), { checked: multi, disabled: Boolean(poll), onChange: (value) => { multi = value; } });
    const deadline = field({ label: t('collab.polls.deadline'), type: 'datetime-local', value: poll?.deadline != null ? localValue(poll.deadline) : '', hint: t('collab.polls.deadlineHint') });
    const content = el('div', {}, voted && el('p.field-hint.poll-form-note', {}, t('collab.polls.lockedNote')), question.element,
      el('fieldset.poll-form-fieldset', {}, el('legend.field-label', {}, t('collab.polls.options')), optionList, optionError, addOption),
      multiField, deadline.element);
    return formDialog(ctx, {
      title: t(poll ? 'collab.polls.editTitle' : 'collab.polls.newTitle'), content, submitLabel: t(poll ? 'collab.save' : 'collab.polls.create'),
      async onSubmit() {
        const questionValue = question.input.value.trim();
        question.setError(questionValue ? '' : t('collab.polls.questionRequired'));
        const options = rows.map((row) => row.input.value.trim()).filter(Boolean);
        const unique = new Set(options.map((option) => option.toLocaleLowerCase())).size === options.length;
        optionError.textContent = options.length < 2 ? t('collab.polls.optionsRequired') : unique ? '' : t('collab.polls.optionsUnique');
        optionError.hidden = !optionError.textContent;
        let deadlineValue = null;
        let deadlineError = '';
        if (poll?.deadline != null && deadline.input.value === localValue(poll.deadline)) deadlineValue = poll.deadline;
        else if (deadline.input.value) {
          const [date, time = ''] = deadline.input.value.split('T');
          try { deadlineValue = zonedInstant(date, time.slice(0, 5), ctx.zone, { disambiguation: 'earlier' }); } catch { deadlineError = t('collab.polls.deadlineInvalid'); }
          if (!deadlineError && deadlineValue <= ctx.now()) deadlineError = t('collab.polls.deadlinePast');
        }
        deadline.setError(deadlineError);
        if (!questionValue || optionError.textContent || deadlineError) return false;
        if (!poll) {
          return ctx.apply([space.ops.create('poll', { question: questionValue, options, ...(multi ? { multi } : {}), ...(deadlineValue !== null ? { deadline: deadlineValue } : {}), author: uid })],
            { history: t('collab.polls.historyAdd'), flush: true });
        }
        const current = space.get('poll', poll.id);
        if (!current) return t('collab.polls.gone');
        const set = {};
        const unset = [];
        if (!voted && questionValue !== current.question) set.question = questionValue;
        if (!voted && JSON.stringify(options) !== JSON.stringify(current.options)) set.options = options;
        if (deadlineValue === null && current.deadline != null) unset.push('deadline');
        else if (deadlineValue !== null && deadlineValue !== current.deadline) set.deadline = deadlineValue;
        if (!Object.keys(set).length && !unset.length) return true;
        return ctx.apply([space.ops.patch('poll', poll.id, { set, unset })], { history: t('collab.polls.historyEdit'), flush: true });
      },
    });
  }

  const offs = [space.subscribe('poll', schedule), space.subscribe('member', () => { membersVersion += 1; schedule(); }), onStateKey(space, accessKey, schedule)];
  render();
  return () => { destroyed = true; clearTimeout(timer); for (const off of offs) off(); cache.clear(); };
}
