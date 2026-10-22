/**
 * The Accessibility pane (Review ▸ Check Accessibility, or the status bar's Accessibility item): the
 * inspection results in three tiers, Errors, Warnings and Tips, each rule opening onto the places it
 * found, a click going there, and the rule's Additional Information (why and how to fix it) below.
 * The results follow the workbook while the pane is open.
 */
import { el } from './dom.js';
import { icon } from './icons.js';
import { checkAccessibility, groupFindings } from '../core/accessibility-check.js';

const TIER = { error: 'Errors', warning: 'Warnings', tip: 'Tips' };

export function createAccessibilityPane(ctx) {
  let chosenRule = null;
  let lastVersion = -1;
  let findings = [];
  const results = el('div.a11y-results');
  const info = el('div.a11y-info', { hidden: true });
  const close = el('button.icon-btn', { type: 'button', 'aria-label': 'Close Accessibility', html: icon('x', 16), onclick: () => api.hide() });
  const root = el('section.a11y-pane', { role: 'region', 'aria-label': 'Accessibility', hidden: true },
    el('div.a11y-head', {}, el('span.a11y-title', {}, 'Accessibility'), close),
    el('div.a11y-body', {}, el('h3.a11y-heading', {}, 'Inspection Results'), results, info));

  const describe = (rule) => {
    if (!rule) { info.hidden = true; return; }
    info.hidden = false;
    info.replaceChildren(el('h3.a11y-heading', {}, 'Additional Information'),
      el('h4', {}, 'Why Fix:'), el('p', {}, rule.why), el('h4', {}, 'How to Fix:'), el('p', {}, rule.how));
  };

  function render(force = false) {
    if (root.hidden) return;
    if (!force && ctx.wb.version === lastVersion) return;
    lastVersion = ctx.wb.version;
    findings = checkAccessibility(ctx.wb);
    // Drawn again after every change, the results keep the tiers and rules folded or opened as the user left them,
    // and the heading or item focus was on: drawn afresh, each edit (a co-author's too) undid both.
    const opened = new Map([...results.querySelectorAll('details[data-key]')].map((d) => [d.dataset.key, d.open]));
    const focused = results.contains(document.activeElement) ? document.activeElement.closest('[data-key]') : null;
    const focusKey = focused?.dataset.key, onSummary = focused?.tagName === 'DETAILS';
    if (!findings.length) {
      results.replaceChildren(el('p.a11y-clear', {}, el('span', { html: icon('check', 18, 2) }),
        'No accessibility issues found. People with disabilities should not have difficulty reading this workbook.'));
      describe(null);
      return;
    }
    const groups = groupFindings(findings).filter((g) => g.count);
    const open = (key, fallback) => opened.get(key) ?? fallback;
    results.replaceChildren(...groups.map((group) => el('details.a11y-tier', { open: open(`tier:${group.severity}`, true), dataset: { key: `tier:${group.severity}` } },
      el('summary', {}, `${TIER[group.severity]} (${group.count})`),
      ...group.rules.map((rule) => {
        const node = el('details.a11y-rule', { open: open(`rule:${rule.rule}`, chosenRule === rule.rule), dataset: { key: `rule:${rule.rule}` } },
          el('summary', { onclick: () => { chosenRule = rule.rule; describe(rule); } }, `${rule.label} (${rule.items.length})`),
          el('ul', {}, ...rule.items.map((item) => el('li', {}, el('button.a11y-item', {
            type: 'button', dataset: { key: `item:${rule.rule}:${item.label}` }, onclick: () => { chosenRule = rule.rule; describe(rule); ctx.reveal(item); },
          }, item.label)))));
        return node;
      }))));
    if (focusKey) {
      const same = [...results.querySelectorAll('[data-key]')].find((n) => n.dataset.key === focusKey);
      (onSummary ? same?.querySelector(':scope > summary') : same)?.focus({ preventScroll: true });
    }
    describe(chosenRule ? groupFindings(findings).flatMap((g) => g.rules).find((r) => r.rule === chosenRule) : null);
  }

  const unsubscribe = ctx.subscribe(() => render());
  const api = {
    el: root,
    get open() { return !root.hidden; },
    show() { root.hidden = false; render(true); },
    hide() { root.hidden = true; ctx.grid.focus(); },
    toggle() { if (root.hidden) api.show(); else api.hide(); },
    destroy() { unsubscribe(); root.remove(); },
  };
  return api;
}
