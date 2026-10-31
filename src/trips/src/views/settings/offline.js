import './offline.css';
import { el, uid } from '../../ui/dom.js';
import { button, emptyState, skeleton } from '../../ui/bits.js';
import { confirmDialog } from '../../ui/modal.js';
import { toast } from '../../ui/toast.js';
import { t } from '../../lib/i18n/index.js';
import { displayLocale } from '../../lib/prefs.js';
import { formatDateRange } from '../../lib/format.js';
import { openDatabase } from '../../lib/idb.js';
import { offlineFor, setForcedOffline, isForcedOffline, appOnline, onForcedOffline, openConflict, conflictListFor } from '../../lib/offline/index.js';
import { alertRegion, group, plural, row } from './ui.js';

const ERRORS = new Set(['offline', 'credit', 'forbidden', 'gone', 'busy', 'storage_full', 'map_unavailable', 'tile_host_refused', 'tiles_refused', 'tiles_failed', 'failed']);
const errorText = (code) => t(`offline.error.${ERRORS.has(code) ? code : 'failed'}`);

export function formatBytes(bytes, locale = displayLocale()) {
  const value = Math.max(0, Number(bytes) || 0);
  for (const [unit, size] of [['gigabyte', 1024 ** 3], ['megabyte', 1024 ** 2], ['kilobyte', 1024]]) {
    if (value >= size) return new Intl.NumberFormat(locale, { style: 'unit', unit, unitDisplay: 'short', maximumFractionDigits: value >= 10 * size ? 0 : 1 }).format(value / size);
  }
  return new Intl.NumberFormat(locale, { style: 'unit', unit: 'byte', unitDisplay: 'short' }).format(value);
}
const formatTime = (at) => new Intl.DateTimeFormat(displayLocale(), { dateStyle: 'medium', timeStyle: 'short' }).format(at);

function switchControl({ checked, label, onChange, disabled = false }) {
  const node = el('button.switch', { type: 'button', role: 'switch', 'aria-checked': checked, 'aria-label': label, disabled,
    onclick: () => { const next = node.getAttribute('aria-checked') !== 'true'; node.setAttribute('aria-checked', String(next)); onChange(next, node); } }, el('span.switch-thumb'));
  return node;
}

function stateLabel(trip) {
  if (trip.keep) return t(trip.mode === 'on' ? 'offline.statePinned' : 'offline.stateAuto');
  if (trip.mode === 'off') return t('offline.stateOff');
  return t(trip.start || trip.end ? 'offline.stateEnded' : 'offline.stateUndated');
}

/** Session from the shell, or the parts Settings can open itself (no downloads without the worker client). */
async function resolveSession(context) {
  if (context.session?.db && context.session?.personal) return { session: context.session, close: () => {} };
  const db = await openDatabase(context.account.uuid);
  return { session: { account: context.account, db, personal: context.personal }, close: () => db.close() };
}

export async function mount(container, context) {
  const { signal, account } = context;
  container.replaceChildren(el('div.settings-stack', { 'aria-busy': 'true' }, skeleton(), skeleton('70%'), skeleton('40%')));
  let resolved;
  try { resolved = await resolveSession(context); }
  catch {
    if (!signal.aborted) container.replaceChildren(el('div.settings-error', { role: 'alert' }, el('p', {}, t('offline.loadError'))));
    return undefined;
  }
  if (signal.aborted) { resolved.close(); return undefined; }
  const { session } = resolved;
  const manager = offlineFor(session, { puter: context.puter ?? globalThis.puter });
  const canDownload = Boolean(session.api);
  if (canDownload) manager.start();
  const win = globalThis.window;
  const cleanups = [resolved.close];
  const alert = alertRegion();

  // Connection
  const status = el('p.pref-hint', { role: 'status' });
  const notice = el('p.settings-warning', { role: 'status', hidden: true });
  const pending = el('span.pref-hint');
  const syncNow = button(t('offline.syncNow'), { size: 'sm', variant: 'outline', onclick: async () => {
    syncNow.setAttribute('aria-busy', 'true'); status.textContent = '';
    try {
      const result = await manager.resync();
      if (signal.aborted) return;
      const left = await manager.pendingWrites();
      status.textContent = result?.skipped ? t('offline.error.offline') : left.trips + left.personal ? t('offline.syncFailed') : t('offline.synced');
    } catch { if (!signal.aborted) status.textContent = t('offline.actionFailed'); }
    finally { syncNow.setAttribute('aria-busy', 'false'); void refreshAll(); }
  } });
  const force = switchControl({ checked: isForcedOffline(), label: t('offline.force'), onChange: (on) => {
    setForcedOffline(on, { username: account?.username });
    renderConnection();
  } });
  const forceRow = row({ label: t('offline.force'), hint: t('offline.forceHint'), control: force });
  force.removeAttribute('aria-label');
  force.setAttribute('aria-labelledby', forceRow.labelId);
  force.setAttribute('aria-describedby', forceRow.hintId);
  const connection = group(t('offline.connection'), forceRow.node, el('div.pref-row', {}, el('div.pref-text', {}, pending, status), syncNow));
  function renderConnection() {
    const forced = isForcedOffline();
    force.setAttribute('aria-checked', String(forced));
    notice.hidden = appOnline();
    notice.textContent = forced ? t('offline.forcedNotice') : t('offline.browserOffline');
    syncNow.disabled = !appOnline();
  }
  async function renderPending() {
    try {
      const counts = await manager.pendingWrites();
      if (signal.aborted) return;
      const total = counts.trips + counts.personal;
      pending.textContent = total ? plural(total, 'offline.pendingOne', 'offline.pendingOther') : t('offline.pendingNone');
    } catch { if (!signal.aborted) pending.textContent = ''; }
  }

  // Downloads
  const tilesSwitch = switchControl({ checked: true, label: t('offline.tiles'), onChange: async (on, node) => {
    node.setAttribute('aria-busy', 'true');
    try {
      if (on) await manager.requestPersist();
      await manager.setTiles(on);
      if (on && canDownload && appOnline()) void manager.run({ explicit: false }).catch(() => {});
    } catch { alert.show(t('offline.actionFailed')); node.setAttribute('aria-checked', String(!on)); }
    finally { node.setAttribute('aria-busy', 'false'); void refreshStorage(); }
  } });
  const tilesRow = row({ label: t('offline.tiles'), hint: t('offline.tilesHint'), control: tilesSwitch });
  tilesSwitch.removeAttribute('aria-label');
  tilesSwitch.setAttribute('aria-labelledby', tilesRow.labelId);
  tilesSwitch.setAttribute('aria-describedby', tilesRow.hintId);
  const persistText = el('span.pref-hint');
  const persistButton = button(t('offline.persist'), { size: 'sm', variant: 'outline', hidden: true, onclick: async () => {
    persistButton.setAttribute('aria-busy', 'true');
    const granted = await manager.requestPersist();
    persistButton.setAttribute('aria-busy', 'false');
    if (signal.aborted) return;
    if (!granted) persistText.textContent = t('offline.persistDenied');
    else void refreshStorage();
  } });
  const persistRow = el('div.pref-row', {}, el('div.pref-text', {}, persistText), persistButton);
  const downloadAll = button(t('offline.downloadAll'), { size: 'sm', variant: 'primary', onclick: () => { void manager.run({ explicit: true }).catch(() => {}); } });
  const stop = button(t('offline.stop'), { size: 'sm', variant: 'ghost', hidden: true, onclick: () => manager.stopRun() });
  const tripList = el('div.offline-trips', { 'aria-busy': 'true' }, skeleton(), skeleton('60%'));
  const downloads = group(t('offline.downloads'), tilesRow.node, persistRow, el('p.pref-hint', {}, t('offline.tripsHint')),
    canDownload ? null : el('p.pref-hint', {}, t('offline.noSession')),
    el('div.settings-actions', {}, downloadAll, stop), tripList);
  let trips = [];
  const progressNodes = new Map();

  function tripStatus(trip, snapshot) {
    const live = snapshot.progress?.key === trip.key ? snapshot.progress : null;
    const result = snapshot.results[trip.key];
    if (live) {
      const text = live.stage === 'files' ? t('offline.stageFiles', { done: live.done, total: live.total })
        : live.stage === 'map' ? t('offline.stageMap', { done: live.done, total: live.total }) : t('offline.stageData');
      const bar = el('progress.meter', { max: Math.max(live.total, 1), value: live.total ? live.done : undefined,
        'aria-label': t('offline.progressLabel', { title: trip.title || t('offline.untitled') }) });
      return [el('span.pref-hint', {}, text), bar];
    }
    const error = result?.state === 'error' ? result.error : trip.error;
    if (trip.keep && error) return [el('span.field-error', {}, errorText(error))];
    return [];
  }
  function tripRow(trip, snapshot) {
    const title = trip.title || t('offline.untitled');
    const dates = formatDateRange(trip.start, trip.end);
    const sizes = [trip.replica.loaded && trip.replica.bytes ? t('offline.sizeData', { size: formatBytes(trip.replica.bytes) }) : null,
      trip.files?.bytes ? t('offline.sizeFiles', { size: formatBytes(trip.files.bytes) }) : null,
      trip.tiles?.bytes ? t('offline.sizeMap', { size: formatBytes(trip.tiles.bytes) }) : null].filter(Boolean);
    const updated = trip.warmAt ? t('offline.downloadedAt', { time: formatTime(trip.warmAt) }) : trip.keep ? t('offline.notDownloaded') : null;
    const flags = [trip.replica.pending ? el('span.chip.chip-warn', {}, t('offline.pendingTrip')) : null,
      trip.replica.conflicts ? el('span.chip.chip-warn', {}, t('offline.conflictTrip')) : null].filter(Boolean);
    const live = el('div.offline-trip-live', {}, tripStatus(trip, snapshot));
    progressNodes.set(trip.key, { node: live, trip });
    const keep = switchControl({ checked: trip.keep, label: t('offline.keepNamed', { title }), onChange: async (on, node) => {
      node.setAttribute('aria-busy', 'true');
      const mode = on === trip.auto ? 'auto' : on ? 'on' : 'off';
      try {
        await manager.setMode(trip.ref, mode);
        if (on) await manager.requestPersist();
        if (canDownload && appOnline()) void (on ? manager.download(trip.ref) : manager.run({ refs: [trip.ref] })).catch(() => {});
        await refreshTrips();
      } catch { alert.show(t('offline.actionFailed')); node.setAttribute('aria-checked', String(!on)); }
      finally { node.setAttribute('aria-busy', 'false'); }
    } });
    keep.dataset.focus = `keep:${trip.key}`;
    const download = trip.keep && canDownload ? button(t('offline.downloadNow'), { size: 'sm', variant: 'ghost', disabled: !appOnline() || snapshot.running,
      'aria-label': t('offline.downloadNamed', { title }), onclick: () => { void manager.download(trip.ref).catch(() => {}); } }) : null;
    if (download) download.dataset.focus = `download:${trip.key}`;
    return el('div.list-row.offline-trip', { dataset: { trip: trip.key } },
      el('div.row-text', {},
        el('span.pref-label', {}, title),
        el('span.pref-hint', {}, [dates, stateLabel(trip)].filter(Boolean).join(' · ')),
        el('span.pref-hint', {}, [updated, ...sizes].filter(Boolean).join(' · ')),
        trip.tiles?.truncated ? el('span.pref-hint', {}, t('offline.mapLimited')) : null,
        flags.length ? el('span.offline-flags', {}, flags) : null,
        live),
      el('div.offline-trip-actions', {}, download, keep));
  }
  function renderTrips() {
    const focused = document.activeElement?.dataset?.focus;
    const snapshot = manager.snapshot();
    progressNodes.clear();
    tripList.replaceChildren(trips.length ? el('div.card', {}, trips.map((trip) => tripRow(trip, snapshot)))
      : emptyState({ title: t('offline.noTrips'), body: t('offline.noTripsBody'), icon: 'map', level: 4 }));
    tripList.removeAttribute('aria-busy');
    if (focused) tripList.querySelector(`[data-focus="${CSS.escape(focused)}"]`)?.focus();
  }
  async function refreshTrips() {
    try {
      const [list, settings] = await Promise.all([manager.listTrips({ sizes: true }), manager.settings()]);
      if (signal.aborted) return;
      trips = list.sort((a, b) => Number(b.keep) - Number(a.keep) || (a.start ?? '9999').localeCompare(b.start ?? '9999') || a.title.localeCompare(b.title));
      tilesSwitch.setAttribute('aria-checked', String(settings.tiles));
      renderTrips();
    } catch {
      if (signal.aborted) return;
      tripList.removeAttribute('aria-busy');
      tripList.replaceChildren(el('div.settings-error', {}, el('p', {}, t('offline.loadError')), button(t('offline.retry'), { size: 'sm', variant: 'outline', onclick: refreshTrips })));
    }
  }

  // Storage
  const usage = el('div.usage', { 'aria-busy': 'true' }, skeleton(), skeleton('50%'));
  const clear = button(t('offline.clear'), { size: 'sm', variant: 'danger', onclick: async () => {
    if (!await confirmDialog({ title: t('offline.clearTitle'), body: t('offline.clearBody'), confirmLabel: t('offline.clear'), danger: true })) return;
    clear.setAttribute('aria-busy', 'true');
    try { await manager.clearCache(); if (!signal.aborted) toast(t('offline.cleared')); }
    catch { if (!signal.aborted) alert.show(t('offline.actionFailed')); }
    finally { clear.setAttribute('aria-busy', 'false'); void refreshAll(); }
  } });
  const storageGroup = group(t('offline.storage'), usage, el('div.settings-actions', {}, clear));
  async function refreshStorage() {
    try {
      const use = await manager.storage({ trips });
      if (signal.aborted) return;
      const meterId = uid('offline-usage');
      const line = use.usage == null ? t('offline.storageUnavailable')
        : use.quota ? t('offline.used', { used: formatBytes(use.usage), quota: formatBytes(use.quota) }) : t('offline.usedOnly', { used: formatBytes(use.usage) });
      const parts = [['offline.app', use.app], ['offline.data', use.data], ['offline.files', use.files], ['offline.map', use.tiles]];
      usage.replaceChildren(...[
        use.usage != null && use.quota ? el('meter.meter', { id: meterId, min: 0, max: use.quota, value: Math.min(use.usage, use.quota), 'aria-label': line }) : null,
        el('p.usage-line', {}, line),
        el('dl.offline-breakdown', {}, parts.flatMap(([key, bytes]) => [el('dt', {}, t(key)), el('dd', {}, formatBytes(bytes))]))].filter(Boolean));
      persistText.textContent = t(use.persisted ? 'offline.persisted' : 'offline.notPersisted');
      persistButton.hidden = use.persisted !== false;
    } catch {
      if (!signal.aborted) usage.replaceChildren(el('p.pref-hint', {}, t('offline.storageUnavailable')));
    } finally { usage.removeAttribute('aria-busy'); }
  }

  // Needs your attention
  const attention = el('div.offline-attention', { 'aria-busy': 'true' }, skeleton());
  const attentionGroup = group(t('offline.attention'), attention);
  function failedRow(item) {
    const type = item.key?.endsWith(':exp') ? t('offline.failedExp') : t('offline.failedPack');
    const name = typeof item.value?.name === 'string' ? item.value.name.slice(0, 120) : '';
    const label = item.op === 'remove' ? t('offline.failedRemoved', { type }) : name ? t('offline.failedItem', { type, name }) : type;
    const dismiss = button(t('offline.dismiss'), { size: 'sm', variant: 'ghost', 'aria-label': t('offline.dismissNamed', { name: label }), onclick: async () => {
      dismiss.setAttribute('aria-busy', 'true');
      try { await manager.dismissFailed(item.qid); await refreshAttention(); }
      catch { if (!signal.aborted) alert.show(t('offline.actionFailed')); dismiss.setAttribute('aria-busy', 'false'); }
    } });
    return el('div.list-row', {}, el('div.row-text', {}, el('span.pref-label', {}, label),
      Number.isFinite(item.at) ? el('span.pref-hint', {}, formatTime(item.at)) : null), dismiss);
  }
  async function refreshAttention() {
    try {
      const [failed, conflicts] = await Promise.all([manager.failedWrites(), manager.conflicts()]);
      if (signal.aborted) return;
      const blocks = [];
      if (failed.length) {
        const id = uid('offline-failed');
        blocks.push(el('section.offline-block', { 'aria-labelledby': id }, el('h4.offline-block-title', { id }, t('offline.failedTitle')),
          el('p.pref-hint', {}, t('offline.failedHint')), el('div.card', {}, [...failed].reverse().map(failedRow))));
      }
      for (const entry of conflicts) {
        const id = uid('offline-conflicts');
        const title = entry.title || t('offline.untitled');
        blocks.push(el('section.offline-block', { 'aria-labelledby': id }, el('h4.offline-block-title', { id }, t('offline.conflictsIn', { title })),
          conflictListFor({ conflicts: entry.conflicts, formatTime, onOpen: (conflict) => openConflict({ conflict, resolve: async (choice) => {
            await manager.resolveConflict(entry.ref, conflict.op.opId, choice);
            if (signal.aborted) return;
            toast(t('offline.resolved'));
            void refreshAttention(); void renderPending(); void refreshTrips();
          } }) })));
      }
      attention.replaceChildren(...(blocks.length ? blocks : [el('p.pref-hint', {}, t('offline.attentionNone'))]));
    } catch {
      if (!signal.aborted) attention.replaceChildren(el('div.settings-error', {}, el('p', {}, t('offline.loadError')), button(t('offline.retry'), { size: 'sm', variant: 'outline', onclick: refreshAttention })));
    } finally { attention.removeAttribute('aria-busy'); }
  }

  async function refreshAll() {
    renderConnection();
    await Promise.all([renderPending(), refreshTrips(), refreshAttention()]);
    await refreshStorage();
  }

  let wasRunning = manager.snapshot().running;
  cleanups.push(manager.subscribe((snapshot) => {
    stop.hidden = !snapshot.running;
    downloadAll.disabled = snapshot.running || !appOnline() || !canDownload;
    for (const { node, trip } of progressNodes.values()) node.replaceChildren(...tripStatus(trip, snapshot));
    if (wasRunning && !snapshot.running) void refreshAll();
    wasRunning = snapshot.running;
  }));
  const connectivity = () => { renderConnection(); downloadAll.disabled = manager.snapshot().running || !appOnline() || !canDownload; renderTrips(); };
  win?.addEventListener('online', connectivity);
  win?.addEventListener('offline', connectivity);
  cleanups.push(() => { win?.removeEventListener('online', connectivity); win?.removeEventListener('offline', connectivity); });
  cleanups.push(onForcedOffline(connectivity));

  stop.hidden = !manager.snapshot().running;
  downloadAll.disabled = manager.snapshot().running || !appOnline() || !canDownload;
  container.replaceChildren(el('div.settings-stack.offline-settings', {}, alert.node, notice, connection, downloads, storageGroup, attentionGroup));
  await refreshAll();
  return () => { for (const cleanup of cleanups.splice(0)) cleanup(); };
}
