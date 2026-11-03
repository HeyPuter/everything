import { el } from '../../../ui/dom.js';
import { t } from '../../../lib/i18n/index.js';
import { prefs, AI_MODELS } from '../../../lib/prefs.js';
import { group, prefSelect, keepInSync, statusLine } from '../ui.js';

const MODEL_LABELS = {
  'claude-sonnet-5-5': 'settings.modelSonnet',
  'claude-opus-5-5': 'settings.modelOpus',
  'claude-haiku-5-5': 'settings.modelHaiku',
};
const RECOMMENDED = { aiModel: AI_MODELS.main[0], aiQuickModel: AI_MODELS.quick[0] };

function models(key, list) {
  const ids = list.includes(prefs()[key]) ? list : [...list, prefs()[key]];
  return ids.map((id) => {
    const name = Object.hasOwn(MODEL_LABELS, id) ? t(MODEL_LABELS[id]) : id;
    return { value: id, label: id === RECOMMENDED[key] ? t('settings.modelRecommended', { name }) : name };
  });
}

export function render(container, { signal }) {
  const modelControls = [
    prefSelect('aiModel', t('settings.aiModel'), models('aiModel', AI_MODELS.main), { hint: t('settings.aiModelHint') }),
    prefSelect('aiQuickModel', t('settings.aiQuickModel'), models('aiQuickModel', AI_MODELS.quick), { hint: t('settings.aiQuickModelHint') }),
  ];
  keepInSync(modelControls, signal);
  // The assistant always waits for approval, so `assistantApproval` has no setting here.
  container.replaceChildren(el('div.settings-stack', {},
    el('p.pref-hint', {}, t('settings.aiHint')),
    group(t('settings.aiModels'), ...modelControls.map((control) => control.node)),
    group(t('settings.assistant'), el('p.pref-hint', {}, t('settings.assistantApprovalNote'))),
    statusLine(signal)));
}
