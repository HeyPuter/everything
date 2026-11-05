import './styles/app.css';
import { App, DEFAULT_SETTINGS, type Settings } from './app/app';
import { makeHooks, registerCommands } from './app/actions';
import { FileOps } from './app/fileops';
import { StartScreen, bindAccountMenu, refreshAccount } from './app/start';
import { TaskPane, recentItems } from './app/taskpane';
import { AssistantPanel } from './assistant/panel';
import { KV_SETTINGS_KEY, kvGet, kvSet, loadPuter, puter } from './platform/puter';
import { applyTheme } from './platform/theme';
import { toast } from './ui/overlay';

const SETTINGS_KEY = 'parametric:settings';

function localSettings(): Partial<Settings> {
  try {
    return JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
  } catch {
    return {};
  }
}

async function boot() {
  applyTheme();
  const root = document.getElementById('app')!;
  const app = new App();
  const files = new FileOps(app);
  registerCommands(app, files);
  const hooks = makeHooks(app);
  let start: StartScreen | null = null;
  hooks.recent = () => recentItems(app, files);
  hooks.gettingStarted = () => app.openTaskPane('help');
  hooks.afterLoad = () => start?.hide();
  hooks.saveSettings = (s) => {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch { /* storage unavailable */ }
    // One small KV entry for all settings, written only on change.
    void kvSet(KV_SETTINGS_KEY, s);
  };
  try {
    app.mount(root, hooks);
  } catch (e) {
    console.error(e);
    root.removeAttribute('aria-busy');
    return;
  }
  app.applySettings({ ...DEFAULT_SETTINGS, ...localSettings() });
  app.loadRemoteSettings = async () => {
    const remote = await kvGet<Partial<Settings>>(KV_SETTINGS_KEY);
    if (remote && typeof remote === 'object') app.applySettings({ ...app.settings, ...remote });
  };
  // Development builds expose the app for debugging and browser tests.
  if (import.meta.env.DEV) (window as unknown as { __parametric: App }).__parametric = app;
  const taskPane = new TaskPane(app, files, new AssistantPanel(app));
  // The assistant starts open wherever it docks beside the viewport; on
  // tablets and phones it would cover the model, so it waits to be opened.
  // No focus, so single-key shortcuts keep working.
  if (matchMedia('(min-width: 981px)').matches) taskPane.open('assistant', false);
  start = new StartScreen(app, files);
  bindAccountMenu(app);
  root.removeAttribute('aria-busy');
  app.newDocument('Part1');

  await loadPuter();
  void refreshAccount(app);
  void app.loadRemoteSettings();
  files.handleLaunchItems();
  files.handleWindowClose();
  const launched = !!puter()?.ui?.wasLaunchedWithItems?.();
  const restored = launched ? false : await files.checkRecovery();
  if (!restored && !launched) start.show();
}

window.addEventListener('unhandledrejection', (e) => {
  const msg = (e.reason as Error)?.message ?? String(e.reason ?? '');
  if (/ResizeObserver|AbortError/.test(msg)) return;
  console.error(e.reason);
});

boot().catch((e) => {
  console.error(e);
  toast({ kind: 'error', title: 'Parametric could not start', message: (e as Error).message, timeout: 0 });
});
