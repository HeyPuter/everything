// Light entry points for the import and export dialogs; the dialogs and parsers load on first use.
// `context` is a view context: `space` (the open trip), `session`, `account`, `puter`, `personal`, `app`.
import { t } from '../../lib/i18n/index.js';
import { toast } from '../../ui/toast.js';

const load = () => import('./index.js');
const failed = () => toast(t('io.loadFailed'));

/** Export dialog for the open trip (JSON, GPX, KML, KMZ). */
export const openTripExport = (context) => load().then((module) => module.openTripExport(context), failed);
/** Import dialog: a Trips file as a new trip (or into `context.space`), or GPX/KML/KMZ into `context.space`. */
export const openTripImport = (context, options) => load().then((module) => module.openTripImport(context, options), failed);
/** GPX/KML/KMZ into the open trip. */
export const openTrackImport = (context, options) => load().then((module) => module.openTrackImport(context, options), failed);

/** Menu items for a trip view's menu: import tracks (editors) and export. */
export function ioMenuItems(context) {
  const space = context?.space;
  if (!space) return [];
  return [
    space.can('plan.edit') && { label: t('io.menuImportTracks'), icon: 'map', onSelect: () => { void openTrackImport(context); } },
    { label: t('io.menuExport'), icon: 'file', onSelect: () => { void openTripExport(context); } },
  ].filter(Boolean);
}

/** Palette commands for the open trip; returns a function that removes them. */
export function registerTripCommands(context) {
  const commands = context?.app?.commands;
  if (!commands?.register || !context.space) return () => {};
  const offs = [];
  for (const command of [
    { id: 'trip-export', labelKey: 'io.cmdExportTrip', run: () => openTripExport(context) },
    { id: 'trip-import', labelKey: 'io.cmdImportFile', run: () => openTripImport(context) },
    { id: 'tracks-import', labelKey: 'io.cmdImportTracks', run: () => openTrackImport(context) },
  ]) {
    try { const off = commands.register(command); if (typeof off === 'function') offs.push(off); } catch { /* registered by another pane */ }
  }
  return () => { for (const off of offs.splice(0)) off(); };
}
