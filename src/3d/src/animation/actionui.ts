// Action data-block selector (browse / name / users / fake user / new / unlink) used in the
// Action Editor header.
import { h, type Child } from '../ui/h';
import { icon } from '../ui/icons';
import { app } from '../app/app';
import { openMenu } from '../ui/menu';
import { idSelectorMenuHooks } from '../ui/idmenu';
import { textField } from '../ui/widgets';
import type { ObjectData } from '../data/types';
import { activeAction } from './channels';
import { ensureAnimData } from './actionops';
import { actionUsers, assignAction } from '../anim/slots';

export function browseActions(ob: ObjectData, anchor: HTMLElement | { x: number; y: number }, onPick?: (id: string) => void) {
  const acts = Object.values(app.doc.actions).sort((a, b) => a.name.localeCompare(b.name));
  if (!acts.length) {
    openMenu([{ label: 'No actions', disabled: true }], anchor);
    return;
  }
  openMenu(
    acts.map((a) => ({
      label: `${a.use_fake_user ? 'F ' : ''}${a.name}`,
      icon: 'action',
      active: ob.animation_data?.action === a.id,
      action: () => {
        if (onPick) return onPick(a.id);
        assignAction(app.doc, ob, ensureAnimData(ob), a.id);
        app.pushUndo('Assign Action');
        app.changed('doc');
      },
    })),
    anchor,
    { title: 'Browse Action' },
  );
}

export function actionSelector(ob: ObjectData): Child {
  const act = activeAction(app.doc, ob);
  const users = act ? new Set(actionUsers(app.doc, act.id).map((u) => u.ob)).size : 0;
  return h(
    'div',
    {
      key: 'action-sel',
      class: 'anim-idblock',
      // the same extra entries as data-block selectors (Mark as Asset, …)
      oncontextmenu: (e: MouseEvent) => {
        const extra = act ? idSelectorMenuHooks.flatMap((f) => f(act.id)) : [];
        if (!extra.length) return;
        e.preventDefault();
        e.stopPropagation();
        openMenu(extra, { x: e.clientX, y: e.clientY });
      },
    },
    h(
      'button',
      {
        class: 'anim-id-browse',
        'data-tip': 'Browse Action\nBrowse Action to be linked',
        onpointerdown: (e: PointerEvent) => (e.preventDefault(), browseActions(ob, e.currentTarget as HTMLElement)),
      },
      icon('action'),
      icon('down_arrow_hlt', 'tiny'),
    ),
    act
      ? [
          textField(
            'action-name',
            act.name,
            (v) => {
              if (!v.trim()) return;
              act.name = v.trim();
              app.pushUndo('Rename Action');
              app.changed('doc');
            },
            { className: 'anim-id-name' },
          ),
          users > 1
            ? h(
                'button',
                {
                  class: 'anim-id-users',
                  'data-tip': 'Users\nNumber of data-blocks using this action (click to give the active object its own copy)',
                  onclick: () => app.run('action.new'),
                },
                String(users),
              )
            : null,
          h(
            'button',
            {
              class: { 'anim-id-btn': true, on: !!act.use_fake_user },
              'data-tip': 'Fake User\nSave this data-block even if it has no users',
              onclick: () => ((act.use_fake_user = !act.use_fake_user), app.pushUndo('Fake User'), app.changed('doc')),
            },
            icon(act.use_fake_user ? 'fake_user_on' : 'fake_user_off'),
          ),
          h(
            'button',
            {
              class: 'anim-id-btn',
              'data-tip': 'New Action\nCreate new action (copy of the current one)',
              onclick: () => app.run('action.new'),
            },
            icon('duplicate'),
          ),
          h(
            'button',
            {
              class: 'anim-id-btn',
              'data-tip': 'Unlink Action\nUnlink this action from the active action slot',
              onclick: () => app.run('action.unlink'),
            },
            icon('x'),
          ),
        ]
      : h('button', { class: 'anim-id-new', onclick: () => app.run('action.new') }, icon('add'), 'New'),
  );
}
