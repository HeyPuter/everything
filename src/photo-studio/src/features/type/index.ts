// Type tools, on-canvas text editing, the Character/Paragraph panels and
// the Type menu, built on the typography engine in imaging/text.

import type { Editor } from '../../editor';
import { commands, contributeMenu, registerCommand, registerPanel } from '../../app/registry';
import { lazy, lazyPanel, lazyRun } from '../../app/lazy';
import { allLayers } from '../../model/document';
import { ensureFont } from '../../imaging/text/fonts';
import { installTypeTools, isTypeTool } from './tools';
import { installTypeOptions } from './options';
import { installTypePanels } from './panels';
import { installTypeCommands } from './commands';
import { installTextStyles } from './styles-panel';
import { installLanguageCommands } from './language';
import { installPathType } from './path-type';
import * as typeSession from './session';
import { commit, onSessionChange, session } from './session';
import { forgetLayout } from './text-utils';

// The Glyphs panel and Find and Replace / Check Spelling load on first use.
const glyphs = lazy(() => import('./glyphs'));
const findSpell = lazy(() => import('./find-spell'));
const matchFont = lazy(() => import('./match-font'));

export function installType(e: Editor) {
  installTypeTools(e);
  installTypeOptions(e);
  installTypePanels(e);
  installTypeCommands(e);
  registerPanel(lazyPanel({ id: 'glyphs', title: 'Glyphs', icon: 'glyphs', location: 'strip', hidden: true }, lazy(async () => (await glyphs()).glyphsPanel)));
  onSessionChange(() => glyphs.loaded?.followSession(e));
  installTextStyles(e);
  installLanguageCommands(e);
  const hasText = (e: Editor) => e.hasDocument && allLayers(e.doc.layers).some((l) => l.kind === 'text');
  registerCommand(
    {
      id: 'edit.find-replace-text',
      label: 'Find and Replace Text…',
      recordable: false,
      enabled: hasText,
      description: 'Find text in text layers and change it.',
      // The dialogs stay open beside the canvas; the command returns at once.
      ...lazyRun(findSpell, (m, e) => void m.findReplace(e)),
    },
    {
      id: 'edit.check-spelling',
      label: 'Check Spelling…',
      recordable: false,
      enabled: hasText,
      description: 'Check the spelling of text layers against an English dictionary.',
      ...lazyRun(findSpell, (m, e) => void m.checkSpelling(e)),
    },
    {
      id: 'type.match-font',
      label: 'Match Font…',
      recordable: false,
      enabled: (e) => e.hasDocument,
      description: 'Find fonts that look like text in the image and apply one to the selected text layer.',
      ...lazyRun(matchFont, (m, e) => void m.matchFontDialog(e)),
    },
  );
  contributeMenu('edit', ['edit.check-spelling', 'edit.find-replace-text'], 'edit.search');
  installPathType(e);
  // Any other command ends the editing session first, so its edit (or an
  // undo) applies to committed text rather than to the live draft.
  const run = e.runCommand.bind(e);
  e.runCommand = async (id: string, arg?: unknown) => {
    if (session && commands.has(id) && !/^(type|window|view|help)\./.test(id)) await commit(e);
    return run(id, arg);
  };
  e.onUpdate(() => {
    const s = session;
    if (!s) return;
    if (!isTypeTool(e.tool) || e.history.document !== s.draft || (!s.mask && e.selected !== s.layerId)) void commit(e);
  });
  // Double-clicking a text layer's thumbnail edits its text. Detected from
  // pointer presses because the first click re-renders the layer list, so
  // the browser's dblclick lands on a detached row.
  let last = { id: '', time: 0 };
  e.root.addEventListener(
    'pointerdown',
    (ev) => {
      const thumb = (ev.target as HTMLElement).closest?.('.layer-thumbnail.text');
      const id = thumb?.closest<HTMLElement>('[data-row]')?.dataset.row;
      if (!id || ev.button !== 0) return;
      const now = ev.timeStamp;
      if (last.id === id && now - last.time < 500) {
        last = { id: '', time: 0 };
        setTimeout(() => void e.runCommand('type.edit'), 0);
      } else last = { id, time: now };
    },
    true,
  );
  const fonts = (document as Document & { fonts?: FontFaceSet }).fonts;
  fonts?.addEventListener?.('loadingdone', () => {
    forgetLayout();
    if (session) e.overlay();
  });
  void ensureFont('Inter', 400, false);
  // Browser tests inspect the live session through the same module instance.
  if (import.meta.env.DEV) Object.assign(window, { photoStudioType: typeSession });
}
