import { el } from './dom.js';
import { openModal } from './modal.js';
import { t } from '../i18n/index.js';

/** Strict rules refuse entry; legacy non-strict rules only mark cells. */
export function validationAlertStyle(rule) {
  if (!rule || rule.showErrorMessage === false) return null;
  if (rule.strict !== false) return 'stop';
  return ['warning', 'information'].includes(rule.errorStyle) ? rule.errorStyle : null;
}

export function confirmValidation(verdict) {
  const style = validationAlertStyle(verdict.rule);
  if (!style) return Promise.resolve('accept');
  return new Promise(resolve => {
    let result = 'cancel';
    const finish = value => { result = value; modal.close(); };
    const retry = style === 'stop' && el('button.btn.btn-primary', { type: 'button', onclick: () => finish('retry') }, t('validationAlert.retry'));
    const accept = !retry && el('button.btn.btn-primary', { type: 'button', onclick: () => finish('accept') }, style === 'warning' ? t('validationAlert.useValue') : t('common.ok'));
    const content = el('div', {},
      el('p.modal-text', {}, verdict.message || t('validationAlert.defaultMessage')),
      el('div.row.row-end', {},
        el('button.btn.btn-ghost', { type: 'button', onclick: () => finish('cancel') }, t('common.cancel')),
        style === 'warning' && el('button.btn', { type: 'button', onclick: () => finish('retry') }, t('validationAlert.editValue')),
        retry || accept));
    // An Information alert starts on OK, as Excel's does: Enter keeps the entry rather than throwing it away.
    const modal = openModal({ title: verdict.rule.errorTitle || (style === 'warning' ? t('validationAlert.invalidTitle') : t('validationAlert.checkTitle')),
      content, initialFocus: retry || (style === 'information' ? accept : null), onClose: () => resolve(result) });
  });
}
