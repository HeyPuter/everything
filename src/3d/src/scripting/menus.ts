// Script menus: `bpy.types.Menu` subclasses with bl_idname / bl_label / draw(context). They open
// with bpy.ops.wm.call_menu(name=…), from a panel's layout.menu(…), or as submenus of other
// script menus. Their layout becomes a regular menu (operators, labels, separators, submenus).
import { app, onAppReady, operators } from '../app/app';
import type { MenuItem } from '../ui/menu';
import { UILayout, type LayoutItem } from './registry';
import { pyError } from './rna';

export interface ScriptMenuSpec {
  idname: string;
  label: string;
  draw: (layout: UILayout) => void;
  poll?: () => boolean;
  language: 'python' | 'javascript';
}

export const scriptMenus = new Map<string, ScriptMenuSpec>();

export function registerScriptMenu(spec: ScriptMenuSpec) {
  if (!spec.idname) throw pyError('ValueError', 'register_class(): menus need a bl_idname');
  scriptMenus.set(spec.idname, spec);
}

export function unregisterScriptMenu(idname: string) {
  return scriptMenus.delete(idname);
}

function itemsOf(layout: UILayout): MenuItem[] {
  const out: MenuItem[] = [];
  const walk = (items: LayoutItem[]) => {
    for (const it of items) {
      if (it.t === 'operator') {
        const op = operators.get(it.idname);
        const props = Object.fromEntries(Object.entries(it.props).filter(([k]) => k !== '__kind'));
        out.push({ label: it.text ?? op?.label ?? it.idname, op: it.idname, props, icon: it.icon?.toLowerCase(), disabled: !op });
      } else if (it.t === 'label') out.push({ heading: it.text });
      else if (it.t === 'separator') out.push({ separator: true });
      else if (it.t === 'menu') {
        const m = scriptMenus.get(it.idname);
        out.push({ label: it.text ?? m?.label ?? it.idname, submenu: () => menuItems(it.idname), disabled: !m });
      } else if (it.t === 'layout') walk(it.layout.items);
    }
  };
  walk(layout.items);
  return out;
}

/** The items a script menu draws now. */
export function menuItems(idname: string): MenuItem[] {
  const m = scriptMenus.get(idname);
  if (!m) return [];
  if (m.poll && !m.poll()) return [{ label: 'Not available here', disabled: true }];
  const layout = new UILayout();
  try {
    m.draw(layout);
  } catch (e) {
    app.report('ERROR', `Menu ${idname}: ${(e as Error).message}`);
  }
  return itemsOf(layout);
}

export function openScriptMenu(idname: string, at: { x: number; y: number } | HTMLElement) {
  const m = scriptMenus.get(idname);
  if (!m) return false;
  const items = menuItems(idname);
  // the menu UI is loaded on demand (scripting itself runs without the DOM)
  void import('../ui/menu').then(({ openMenu }) => openMenu(items, at, { title: m.label }));
  return true;
}

// wm.call_menu opens script menus by their bl_idname; other names go to the app's own menus.
onAppReady(() => {
  const op = operators.get('wm.call_menu');
  const exec = op?.exec;
  if (!op || !exec) return;
  op.exec = (ctx, p) => (openScriptMenu(String(p.name), { x: app.pointer.x, y: app.pointer.y }) ? 'FINISHED' : exec(ctx, p));
});
