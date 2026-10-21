// F-Modifiers on NLA strips: add / copy / paste operators (Shift Ctrl M) and the sidebar's
// Modifiers tab. Strip modifiers act on every channel the strip produces (anim/evaluate.ts).
import { app, registerOperators, type OpContext } from '../app/app';
import { addKeys } from '../app/keymap';
import type { Child } from '../ui/h';
import { h } from '../ui/h';
import type { FModifier } from '../data/types';
import { overMain } from './animeditor';
import { NlaEditor, nlaSidebarTabs } from './nla';
import { MOD_TYPES, newModifier } from './graph';
import { fmodifierStackUI } from './graphsidebar';
import { isClip } from './nlaedit';

const nlaEd = (ctx: OpContext) => (ctx.area?.editor instanceof NlaEditor ? ctx.area.editor : null);

/** Strips modifiers can be added to: the active one, or every selected action clip. */
function targets(ctx: OpContext, onlyActive: boolean) {
  const ed = nlaEd(ctx);
  if (!ed) return [];
  const act = ed.activeStripRef();
  const list = onlyActive ? (act ? [act] : []) : ed.selectedStrips();
  return list.filter((r) => isClip(r.strip)).map((r) => r.strip);
}

let clipboard: FModifier[] | null = null;

registerOperators([
  {
    idname: 'nla.fmodifier_add',
    label: 'Add F-Modifier',
    description: 'Add an F-Modifier to the active or selected NLA strips',
    props: [
      { id: 'type', label: 'Type', type: 'enum', default: 'NOISE', items: MOD_TYPES },
      { id: 'only_active', label: 'Only Active', type: 'bool', default: true },
    ],
    poll: (ctx) => !!nlaEd(ctx)?.selectedStrips().length || !!nlaEd(ctx)?.activeStripRef(),
    exec: (ctx, p) => {
      const list = targets(ctx, !!p.only_active);
      let n = 0;
      for (const s of list) {
        const mods = (s.modifiers ??= []);
        if (p.type === 'CYCLES' && mods.some((m) => m.type === 'CYCLES')) continue;
        mods.push(newModifier(p.type as string));
        n++;
      }
      if (!n) return 'CANCELLED';
    },
  },
  {
    idname: 'nla.fmodifier_copy',
    label: 'Copy F-Modifiers',
    description: 'Copy the F-Modifiers of the active NLA strip',
    undo: false,
    poll: (ctx) => !!nlaEd(ctx)?.activeStripRef()?.strip.modifiers?.length,
    exec: (ctx) => {
      clipboard = structuredClone(nlaEd(ctx)!.activeStripRef()!.strip.modifiers!);
    },
  },
  {
    idname: 'nla.fmodifier_paste',
    label: 'Paste F-Modifiers',
    description: 'Add the copied F-Modifiers to the active or selected NLA strips',
    props: [
      { id: 'only_active', label: 'Only Active', type: 'bool', default: true },
      { id: 'replace', label: 'Replace Existing', type: 'bool', default: false },
    ],
    poll: (ctx) => !!nlaEd(ctx) && !!clipboard,
    exec: (ctx, p) => {
      const list = targets(ctx, !!p.only_active);
      if (!list.length || !clipboard) return 'CANCELLED';
      for (const s of list) {
        if (p.replace) s.modifiers = [];
        const mods = (s.modifiers ??= []);
        for (const m of structuredClone(clipboard)) {
          if (m.type === 'CYCLES' && mods.some((o) => o.type === 'CYCLES')) continue;
          mods.push(m);
        }
      }
    },
  },
]);

addKeys('NLA Editor', [
  {
    key: 'M',
    shift: true,
    ctrl: true,
    menu: () => MOD_TYPES.map(([v, l]) => ({ label: l, op: 'nla.fmodifier_add', props: { type: v, only_active: false } })),
    menuTitle: 'Add F-Modifier',
    when: overMain,
  },
]);

/** Sidebar ▸ Modifiers: the active strip's modifier stack. */
nlaSidebarTabs.push({
  id: 'modifiers',
  label: 'Modifiers',
  draw: (ed: NlaEditor): Child => {
    const ref = ed.activeStripRef();
    if (!ref || !isClip(ref.strip)) return h('div', { class: 'sb-empty' }, 'No active action strip');
    return fmodifierStackUI(ref.strip, {
      prefix: 'nm',
      add: (type) => app.run('nla.fmodifier_add', { type, only_active: true }, { area: ed.area }),
      copy: app.poll('nla.fmodifier_copy', ed.area) ? () => app.run('nla.fmodifier_copy', {}, { area: ed.area }) : null,
      paste: app.poll('nla.fmodifier_paste', ed.area) ? () => app.run('nla.fmodifier_paste', { only_active: true }, { area: ed.area }) : null,
      copyTip: 'Copy F-Modifiers\nCopy the modifiers of the active strip',
      pasteTip: 'Paste F-Modifiers\nAdd the copied modifiers to the active strip',
    });
  },
});
