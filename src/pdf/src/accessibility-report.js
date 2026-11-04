import { el, icon } from './lib/ui.js';
import './accessibility-report.css';

/** The repairs the editor offers, keyed by a failed rule's `fix`. */
const FIXES = {
  title: { label: 'Set title…', dialog: 'title' },
  language: { label: 'Set language…', dialog: 'language' },
  'tab-order': { label: 'Fix tab order' },
  'mark-info': { label: 'Mark as tagged' },
  tags: { label: 'Autotag document' },
  'tag-annotations': { label: 'Tag annotations' },
  'link-descriptions': { label: 'Describe links' },
  'alt-text': { label: 'Set alternate text…', dialog: 'alt-text' },
  'field-descriptions': {
    label: 'Add descriptions…',
    dialog: 'field-descriptions',
  },
  bookmarks: { label: 'Add bookmarks' },
  protection: { label: 'Change protection…', dialog: 'protection' },
};

/**
 * The Accessibility Check report: a summary of passed, failed, and manual-check rules, then
 * the rules by category, each with its explanation, the pages it concerns, and a Fix button
 * when the editor can repair it. `onFix(fixId, rule)` runs a fix; `onGoTo(pageIndex)` shows a
 * page (0-based).
 */
const STATUS = {
  failed: { label: 'Failed', glyph: 'X' },
  manual: { label: 'Needs manual check', glyph: 'Info' },
  passed: { label: 'Passed', glyph: 'Check' },
  skipped: { label: 'Not applicable', glyph: 'Minus' },
};
const DETAILS_SHOWN = 3;

export function createAccessibilityReport({ onFix, onGoTo } = {}) {
  const summary = el('div', {
    class: 'a11y-summary',
    role: 'status',
    'aria-live': 'polite',
  });
  const empty = el(
    'p',
    { class: 'a11y-empty muted' },
    'Run the check to see how well this PDF works with screen readers and other assistive technology.',
  );
  const categories = el('div', { class: 'a11y-categories' });
  const root = el('div', { class: 'a11y-report' }, summary, empty, categories);
  const open = new Map(); // category name → whether it was left expanded
  let busy = false;
  // A fix disables its button while it runs and the report is drawn again afterwards, which
  // drops the focus. It comes back to the same rule's Fix button, or to its category once the
  // rule passes; a category heading that had the focus keeps it.
  let fixed = null, // the rule whose Fix was chosen last
    refocus = null;
  const ruleTarget = (id) => () => {
    const row = root.querySelector(`[data-rule="${CSS.escape(id)}"]`);
    return (
      row?.querySelector('.a11y-fix:not(:disabled)') ||
      row?.closest('.a11y-category')?.querySelector('summary')
    );
  };
  const categoryTarget = (name) => () =>
    root.querySelector(`.a11y-category[data-category="${CSS.escape(name)}"] > summary`);
  const restoreFocus = () => {
    if (busy || !refocus) return;
    const target = refocus;
    refocus = null;
    const active = document.activeElement;
    if (active && active !== document.body && !root.contains(active)) return;
    target()?.focus();
  };

  const fixButton = (rule) => {
    const fix = FIXES[rule.fix];
    const node = el(
      'button',
      {
        type: 'button',
        class: 'btn a11y-fix',
        onclick: () => {
          if (busy) return;
          fixed = rule.id;
          onFix?.(rule.fix, rule);
        },
        'aria-label': `${fix?.label.replace(/…$/, '') || 'Fix'}: ${rule.name}`,
      },
      fix?.label || 'Fix',
    );
    node.disabled = busy;
    return node;
  };
  const detailRow = (detail) =>
    el(
      'li',
      {},
      Number.isInteger(detail.page)
        ? el(
            'button',
            {
              type: 'button',
              class: 'a11y-page',
              onclick: () => onGoTo?.(detail.page),
              title: `Go to page ${detail.page + 1}`,
            },
            `Page ${detail.page + 1}`,
          )
        : null,
      detail.text ? el('span', {}, detail.text) : null,
    );
  const detailList = (details) => {
    if (!details.length) return null;
    const first = el(
      'ul',
      { class: 'a11y-details' },
      details.slice(0, DETAILS_SHOWN).map(detailRow),
    );
    if (details.length <= DETAILS_SHOWN) return first;
    const rest = details.slice(DETAILS_SHOWN);
    return el(
      'div',
      {},
      first,
      el(
        'details',
        { class: 'a11y-more' },
        el('summary', {}, `${rest.length} more`),
        el('ul', { class: 'a11y-details' }, rest.map(detailRow)),
      ),
    );
  };
  const ruleRow = (rule) => {
    const status = STATUS[rule.status] || STATUS.manual;
    return el(
      'li',
      { class: `a11y-rule is-${rule.status}`, 'data-rule': rule.id },
      el(
        'span',
        { class: 'a11y-status', title: status.label },
        icon(status.glyph, 16),
        el('span', { class: 'sr-only' }, status.label),
      ),
      el(
        'div',
        { class: 'a11y-rule-body' },
        el('span', { class: 'a11y-rule-name' }, rule.name),
        el('span', { class: 'a11y-rule-text muted' }, rule.description),
        detailList(rule.details || []),
      ),
      rule.fix && rule.status !== 'passed' ? fixButton(rule) : null,
    );
  };
  const categoryBlock = (category) => {
    const counts = { failed: 0, manual: 0, passed: 0, skipped: 0 };
    for (const rule of category.rules) counts[rule.status]++;
    const parts = ['failed', 'manual', 'passed']
      .filter((status) => counts[status])
      .map((status) => `${counts[status]} ${status === 'manual' ? 'to check' : status}`);
    const node = el(
      'details',
      { class: 'a11y-category', 'data-category': category.name },
      el(
        'summary',
        {},
        el('span', { class: 'a11y-chevron', 'aria-hidden': 'true' }, icon('ChevronRight', 16)),
        el('span', { class: 'a11y-category-name' }, category.name),
        el(
          'span',
          {
            class: `a11y-category-counts muted${counts.failed ? ' has-failures' : ''}`,
          },
          parts.join(' · ') || 'Not applicable',
        ),
      ),
      el('ul', { class: 'a11y-rules' }, category.rules.map(ruleRow)),
    );
    node.open = open.has(category.name) ? open.get(category.name) : counts.failed > 0;
    node.addEventListener('toggle', () => open.set(category.name, node.open));
    return node;
  };
  const chip = (status, count) =>
    el(
      'span',
      { class: `a11y-chip is-${status}` },
      icon(STATUS[status].glyph, 14),
      el('strong', {}, String(count)),
      ` ${STATUS[status].label}`,
    );

  return {
    el: root,
    /** Render a checkAccessibility report (or clear the panel with null). */
    show(report) {
      const active = document.activeElement;
      let focused = null;
      if (root.contains(active)) {
        const rule = active.closest('[data-rule]')?.dataset.rule;
        const category = active.closest('[data-category]')?.dataset.category;
        focused = rule ? ruleTarget(rule) : category ? categoryTarget(category) : null;
      } else if ((!active || active === document.body) && fixed) focused = ruleTarget(fixed);
      fixed = null;
      empty.hidden = !!report;
      if (!report) {
        summary.replaceChildren();
        categories.replaceChildren();
        return;
      }
      const { passed = 0, failed = 0, manual = 0 } = report.summary || {};
      summary.replaceChildren(
        chip('failed', failed),
        chip('manual', manual),
        chip('passed', passed),
      );
      if (report.truncated)
        summary.append(
          el(
            'p',
            { class: 'muted a11y-note' },
            'The tag tree is very large; only part of it was checked.',
          ),
        );
      summary.setAttribute(
        'aria-label',
        `${failed} failed, ${manual} need a manual check, ${passed} passed`,
      );
      categories.replaceChildren(...report.categories.map(categoryBlock));
      refocus = focused;
      restoreFocus();
    },
    /** Disable the Fix buttons while a fix or a new check runs. */
    setBusy(value) {
      busy = !!value;
      root.setAttribute('aria-busy', String(busy));
      for (const node of root.querySelectorAll('.a11y-fix')) node.disabled = busy;
      restoreFocus();
    },
  };
}
