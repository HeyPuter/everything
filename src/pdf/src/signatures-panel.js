import { el, icon, button } from './lib/ui.js';

/**
 * The Signatures panel and the document message bar: every certificate signature in the PDF
 * with its validity, signer, time, reason, and certificate details, like a desktop PDF
 * reader's Signature panel. Statuses come from verifySignatures (core/digital-signature.js).
 */
const STATUS = {
  valid: { glyph: 'Check', tone: 'good', label: 'Signature is valid' },
  'valid-unknown-identity': {
    glyph: 'Info',
    tone: 'unknown',
    label: 'Signature is valid, but the signer’s identity is unknown',
  },
  modified: {
    glyph: 'Info',
    tone: 'bad',
    label: 'The document was changed after it was signed',
  },
  invalid: { glyph: 'X', tone: 'bad', label: 'Signature is invalid' },
  unsupported: { glyph: 'Info', tone: 'unknown', label: 'Signature could not be checked' },
};

const when = (date) =>
  date instanceof Date && !Number.isNaN(date.getTime())
    ? date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
    : '';

/** One sentence for the bar above the document, from all of its signatures. */
export function signatureSummary(reports) {
  if (!reports.length) return null;
  const count = reports.length === 1 ? 'The signature' : `All ${reports.length} signatures`;
  if (reports.some((r) => r.status === 'invalid'))
    return { tone: 'bad', text: 'At least one signature is invalid.' };
  if (reports.some((r) => r.status === 'modified'))
    return {
      tone: 'bad',
      text: 'At least one signature has problems: the document changed after it was signed.',
    };
  if (reports.some((r) => r.status === 'unsupported'))
    return { tone: 'unknown', text: 'At least one signature could not be checked.' };
  if (reports.every((r) => r.status === 'valid'))
    return {
      tone: 'good',
      text: `Signed, and ${count.toLowerCase()} ${reports.length === 1 ? 'is' : 'are'} valid.`,
    };
  return {
    tone: 'unknown',
    text: `Signed. ${count} ${reports.length === 1 ? 'is' : 'are'} valid, but the signer’s identity is not trusted on this device.`,
  };
}

export function createSignaturesPanel({ onGoTo, onValidate }) {
  const list = el('ol', { class: 'signature-list', 'aria-label': 'Signatures' });
  const empty = el('p', { class: 'panel-empty muted' }, 'This PDF has no certificate signatures.');
  const validate = button('Validate all', 'RefreshCw', () => onValidate(), 'btn panel-action');
  const root = el('div', { class: 'signatures-panel' }, validate, empty, list);

  function details(report) {
    const rows = [
      ['Signed by', [report.signer?.name, report.signer?.email].filter(Boolean).join(' · ')],
      ['Organization', report.signer?.organization],
      ['Time', when(report.signingTime)],
      ['Reason', report.reason],
      ['Location', report.location],
      ['Contact', report.contactInfo],
      ['Field', report.fieldName],
      [
        'Certificate',
        report.chain?.length
          ? report.chain
              .map((cert) => cert.commonName || cert.subject || '')
              .filter(Boolean)
              .join(' → ')
          : '',
      ],
      ['Revision', report.totalRevisions ? `${report.revision} of ${report.totalRevisions}` : ''],
      ['Certification', report.certification ? `Level ${report.certification.level}` : ''],
      [
        'Certificate valid',
        report.chain?.[0]
          ? `${when(new Date(report.chain[0].validFrom))} to ${when(new Date(report.chain[0].validTo))}`
          : '',
      ],
      ['Revocation', report.revocation],
    ].filter(([, value]) => value);
    const changes = [
      ...(report.modifications?.allowed || []).map((text) => el('li', {}, text)),
      ...(report.modifications?.disallowed || []).map((text) => el('li', { class: 'bad' }, text)),
    ];
    const problems = [...(report.errors || []), ...(report.warnings || [])];
    return el(
      'details',
      { class: 'signature-details' },
      el('summary', {}, 'Details'),
      el('dl', {}, ...rows.flatMap(([term, value]) => [el('dt', {}, term), el('dd', {}, value)])),
      changes.length > 0 && el('p', { class: 'signature-subhead' }, 'Changes after signing'),
      changes.length > 0 && el('ul', { class: 'signature-changes' }, ...changes),
      problems.length > 0 &&
        el('ul', { class: 'signature-problems' }, ...problems.map((text) => el('li', {}, text))),
    );
  }

  return {
    el: root,
    show(reports) {
      empty.hidden = reports.length > 0;
      validate.hidden = !reports.length;
      list.replaceChildren(
        ...reports.map((report, i) => {
          const status = STATUS[report.status] || STATUS.unsupported;
          const signer = report.signer?.name || report.fieldName || `Signature ${i + 1}`;
          return el(
            'li',
            { class: `signature-item tone-${status.tone}` },
            el(
              'div',
              { class: 'signature-head' },
              el(
                'span',
                { class: 'signature-status', 'aria-hidden': 'true' },
                icon(status.glyph, 14),
              ),
              el(
                'div',
                { class: 'signature-text' },
                el(
                  'span',
                  { class: 'signature-title' },
                  `Rev. ${report.revision ?? i + 1}: Signed by ${signer}`,
                ),
                el('span', { class: 'signature-state' }, report.summary || status.label),
              ),
            ),
            Number.isInteger(report.page) &&
              button(
                `Go to signature on page ${report.page + 1}`,
                null,
                () => onGoTo(report),
                'text-btn signature-go',
              ),
            details(report),
          );
        }),
      );
    },
  };
}

/** The message bar above the pages for a signed PDF. */
export function createSignatureBar({ onOpenPanel }) {
  const text = el('span', { class: 'signature-bar-text' });
  const glyph = el('span', { class: 'signature-bar-icon', 'aria-hidden': 'true' });
  const root = el(
    'div',
    { class: 'signature-bar', role: 'status', hidden: true },
    glyph,
    text,
    button('Signature panel', null, () => onOpenPanel(), 'text-btn'),
  );
  return {
    el: root,
    show(reports) {
      const summary = signatureSummary(reports);
      root.hidden = !summary;
      if (!summary) return;
      root.className = `signature-bar tone-${summary.tone}`;
      glyph.replaceChildren(icon(summary.tone === 'good' ? 'Check' : 'Info', 15));
      text.textContent = summary.text;
    },
  };
}
