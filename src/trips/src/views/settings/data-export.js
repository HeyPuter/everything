// Settings → Your data: download everything this account keeps in Trips, and import a trip from a Trips file.
import '../io/io.css';
import { el } from '../../ui/dom.js';
import { button } from '../../ui/bits.js';
import { checkbox } from '../../ui/fields.js';
import { toast } from '../../ui/toast.js';
import { t } from '../../lib/i18n/index.js';
import { formatBytes } from '../../lib/files/format.js';
import { exportAllData } from '../../lib/io/data-export.js';
import { IO_LIMITS } from '../../lib/io/limits.js';
import { driveAvailable, errorLine, errorText, plural, progressBlock, saveToDrive } from '../io/common.js';
import { openTripImport } from '../io/entry.js';
import { group } from './ui.js';
import { saveBlob } from '../../lib/download.js';

const STAGES = { personal: 'io.stagePersonal', spaces: 'io.stageSpaces', files: 'io.stageFiles', zip: 'io.stageZip' };

export async function mount(container, context) {
  const { account, puter, signal } = context;
  const session = context.session ?? null;
  let includeFiles = false;
  const progress = progressBlock();
  progress.node.hidden = true;
  const error = errorLine();
  const result = el('div.io-result', { role: 'status', hidden: true });
  const filesBox = checkbox(t('io.includeFiles', { limit: formatBytes(IO_LIMITS.dataFileBytes) }), { checked: false, onChange: (value) => { includeFiles = value; } });
  let controller = null;

  async function run(target) {
    error.clear(); result.hidden = true;
    for (const control of actions) control.disabled = true;
    progress.node.hidden = false;
    controller = new AbortController();
    const stop = () => controller?.abort();
    signal?.addEventListener('abort', stop, { once: true });
    try {
      const worker = session?.deployer ? (await session.deployer.current())?.name ?? null : null;
      const { blob, name, summary } = await exportAllData({
        puter, api: session?.api ?? null, worker, account, includeFiles, readme: t('io.readme'), signal: controller.signal,
        onProgress: ({ stage, done, total }) => progress.set(t(STAGES[stage], { done: Math.min(done + 1, total), total }), done, total),
      });
      if (signal?.aborted) return;
      if (target === 'drive') void new Promise((resolve) => { resolve(saveToDrive(puter, blob, name)); }).then(() => toast(t('io.savedToPuter', { name })), (problem) => toast(errorText(problem)));
      else saveBlob(blob, name);
      const lines = [
        summary.spacesIncluded ? plural(summary.spaces, 'spacesSaved') : t('io.spacesNotIncluded'),
        includeFiles && summary.spacesIncluded ? plural(summary.files, 'filesSaved') : null,
        summary.failed.length ? plural(summary.failed.length, 'spacesFailed') : null,
        summary.skippedFiles.length ? plural(summary.skippedFiles.length, 'filesSkipped') : null,
      ].filter(Boolean);
      result.replaceChildren(el('span', {}, t('io.dataReady', { name, size: formatBytes(blob.size) })), el('ul', {}, lines.map((line) => el('li', {}, line))));
      result.hidden = false;
    } catch (problem) {
      if (!signal?.aborted) error.show(problem, () => run(target));
    } finally {
      signal?.removeEventListener('abort', stop);
      controller = null;
      progress.node.hidden = true;
      for (const control of actions) control.disabled = false;
    }
  }

  const actions = [
    button(t('io.downloadData'), { variant: 'primary', onclick: () => run('device') }),
    driveAvailable(puter) && button(t('io.saveToPuter'), { variant: 'outline', onclick: () => run('drive') }),
  ].filter(Boolean);
  const importButton = button(t('io.importTrip'), { variant: 'outline', onclick: () => { void openTripImport({ ...context, space: null }); } });
  container.replaceChildren(el('div.settings-stack', {},
    group(t('io.dataTitle'),
      el('p.pref-hint', {}, t('io.dataHint')),
      session?.api ? null : el('p.io-note', {}, t('io.dataPersonalOnly')),
      filesBox,
      el('div.io-section-actions', {}, actions),
      progress.node, error.node, result),
    group(t('io.importTripTitle'),
      el('p.pref-hint', {}, t('io.importTripHint')),
      el('div.io-section-actions', {}, importButton))));
  return () => controller?.abort();
}
