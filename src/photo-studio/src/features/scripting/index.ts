// Scripting, script events and the remaining automation: File → Scripts
// (installed scripts, Browse, Script Events Manager, Statistics), the
// Scripts panel, File → Automate → Lens Correction and Create Batch Link.
// Registration is light; the sandbox, editor and dialogs load on first use.
import type { Editor } from '../../editor';
import { commands, registerCommand, registerPanel, type Command } from '../../app/registry';
import { lazy, lazyPanel, lazyRun, whenIdle } from '../../app/lazy';
import { emitAppEvent, onAppEvent } from '../../app/app-events';
import { allActions, playAction } from '../actions';
import { dispatchEvent } from './event-dispatch';
import { BATCH_LINK_PREFIX } from './batch-link-core';
import { eventSettings, findScript, listScripts, loadScripts, onScriptsChanged, scriptSelection } from './store';

const runner = lazy(() => import('./run'));
const manage = lazy(() => import('./manage'));
const editor = lazy(() => import('./code-editor'));
const events = lazy(() => import('./events'));
const samples = lazy(() => import('./samples'));
const statistics = lazy(() => import('./statistics'));
const lensBatch = lazy(() => import('./lens-batch'));
const batchLink = lazy(() => import('./batch-link'));
const panel = lazy(() => import('./panel'));

const SCRIPT_PREFIX = 'script.run.';
/** Run an installed script by its record ID. */
async function runInstalled(e: Editor, id: string) {
  const s = findScript(id);
  if (!s) return e.message('That script is no longer installed.');
  await (await runner()).runScript(e, { id: s.id, name: s.name, source: s.source });
}
// File → Scripts lists the enabled scripts, each with its shortcut.
function syncScriptCommands(e: Editor) {
  for (const id of [...commands.keys()]) if (id.startsWith(SCRIPT_PREFIX)) commands.delete(id);
  listScripts()
    .filter((s) => s.enabled)
    .forEach((s, i) =>
      registerCommand({
        id: SCRIPT_PREFIX + s.id,
        label: s.name,
        menu: 'file.scripts',
        order: i,
        shortcut: s.shortcut,
        description: s.description || 'Installed script',
        run: (e) => runInstalled(e, s.id),
        prefetch: runner.prefetch,
      }),
    );
  e.dock?.update();
}

export function installScripting(e: Editor) {
  const selected = () => !!findScript(scriptSelection.id);
  const cmd = (c: Omit<Command, 'recordable'> & { recordable?: boolean }) => registerCommand({ recordable: false, ...c });
  cmd({ id: 'file.scripts-browse', label: 'Browse…', description: 'Run a script file from this device', ...lazyRun(manage, (m, e) => m.browse(e, 'device')) });
  cmd({ id: 'file.scripts-browse-cloud', label: 'Browse Puter…', description: 'Run a script file from Puter', ...lazyRun(manage, (m, e) => m.browse(e, 'puter')) });
  cmd({ id: 'file.script-events', label: 'Script Events Manager…', description: 'Run scripts or actions when documents open, save, export or close', ...lazyRun(events, (m, e) => m.scriptEventsManager(e)) });
  cmd({ id: 'file.statistics', label: 'Statistics…', description: 'Combine several images into one embedded object with a stack mode', ...lazyRun(statistics, (m, e) => m.statisticsDialog(e)) });
  cmd({ id: 'file.lens-correction-batch', label: 'Lens Correction…', description: 'Correct many photos at once with automatic or custom settings', ...lazyRun(lensBatch, (m, e) => m.lensCorrectionBatch(e)) });
  cmd({ id: 'file.batch-link', label: 'Create Batch Link…', description: 'Make a link that opens Photo Studio ready to run an action on dropped photos', ...lazyRun(batchLink, (m, e) => m.createBatchLink(e)) });
  cmd({ id: 'scripts.new', label: 'New Script…', description: 'Write a script in the built-in editor', ...lazyRun(editor, (m, e) => m.openScriptEditor(e)) });
  cmd({ id: 'scripts.install', label: 'Install Script…', description: 'Add a .js script file to the Scripts panel and File → Scripts', ...lazyRun(manage, (m, e) => m.installFromFile(e)) });
  cmd({ id: 'scripts.run-selected', label: 'Run Script', enabled: selected, run: (e) => runInstalled(e, scriptSelection.id), prefetch: runner.prefetch });
  cmd({ id: 'scripts.edit-selected', label: 'Edit Script…', enabled: selected, ...lazyRun(editor, (m, e) => m.openScriptEditor(e, scriptSelection.id)) });
  cmd({ id: 'scripts.shortcut', label: 'Keyboard Shortcut…', enabled: selected, description: 'Assign a shortcut that runs the selected script', ...lazyRun(manage, (m, e) => m.assignShortcut(e, scriptSelection.id)) });
  cmd({ id: 'scripts.export', label: 'Save Script as File', enabled: selected, ...lazyRun(manage, (m) => m.exportScript(scriptSelection.id)) });
  cmd({ id: 'scripts.delete', label: 'Delete Script', enabled: selected, ...lazyRun(manage, (m, e) => m.removeScript(e, scriptSelection.id)) });
  cmd({
    id: 'scripts.restore-samples',
    label: 'Restore Sample Scripts',
    description: 'Install the bundled sample scripts that were removed',
    ...lazyRun(samples, async (m, e) => {
      const n = await m.installSamples(false);
      e.message(n ? `Restored ${n} sample script${n > 1 ? 's' : ''}.` : 'Every sample script is installed.');
    }),
  });
  cmd({ id: 'scripts.clear-output', label: 'Clear Output', ...lazyRun(runner, (m) => m.clearScriptLog()) });
  registerPanel(scriptsPanel);

  onScriptsChanged(() => syncScriptCommands(e));
  void loadScripts().then(() => {
    syncScriptCommands(e);
    // Samples install once, the first time Photo Studio starts.
    whenIdle(() => void samples().then((m) => m.installSamples(true)).catch(() => undefined));
  });

  // A batch link opens its window at startup or when pasted into an open tab.
  const openLinkInAddress = () => {
    if (location.hash.startsWith(BATCH_LINK_PREFIX)) void batchLink().then((m) => m.openBatchLink(e, location.hash));
  };
  window.addEventListener('hashchange', openLinkInAddress);

  // Script events. Closing is announced here (the editor's close hooks).
  e.closeHooks.push((s) => void emitAppEvent('close-document', s));
  onAppEvent(async (event, session) => {
    if (event === 'start') openLinkInAddress();
    await loadScripts();
    await dispatchEvent(eventSettings(), event, session, {
      busy: () => !!runner.loaded?.scriptRunning(),
      script: async (record, ev) => {
        const { runScript } = await runner();
        const go = () => runScript(e, { id: record.id, name: record.name, source: record.source, event: ev });
        // Hold the editor for the run unless the event came from inside a command.
        if (e.busy) await go();
        else await e.run(async () => void (await go()));
      },
      action: async (id, s) => {
        const found = allActions().find((a) => a.action.id === id);
        if (!found) return;
        // Plays on the event's document while it is open, holding the editor
        // as a script run does: a tab chosen meanwhile is shown afterwards.
        const play = async () => {
          if (s && s !== e.session && e.sessions.includes(s)) await e.switchSession(s);
          if (e.hasDocument) await playAction(e, found.action);
        };
        if (e.busy) await play();
        else await e.run(play);
      },
    });
  });
}

/** The Scripts panel (Window → Scripts). */
const scriptsPanel = lazyPanel(
  {
    id: 'scripts',
    title: 'Scripts',
    icon: 'square-code',
    location: 'strip',
    menu: () => ['scripts.run-selected', 'scripts.edit-selected', 'scripts.shortcut', 'scripts.export', 'scripts.delete', '-', 'scripts.new', 'scripts.install', 'scripts.restore-samples', '-', 'file.script-events', '-', 'scripts.clear-output'],
  },
  panel,
);
