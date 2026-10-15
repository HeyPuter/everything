// Outliner: view-layer tree of collections, objects and their data.
import { h, patch, type Child } from '../ui/h';
import { icon } from '../ui/icons';
import { app, registerOperators, type ChangeKind } from '../app/app';
import { registerEditor, type Area, type Editor } from '../ui/screen';
import { openMenu, promptText, type MenuItem } from '../ui/menu';
import type { CollectionData, ObjectData, DocumentData } from '../data/types';
import { newCollection } from '../data/defaults';
import { uniqueName, setActiveCollection, activeCollection, deleteObjects } from '../ops/object';
import { applyMatrixToObject, fromMatrix4 } from '../eval/transform';
import { Matrix4 } from 'three';
import { modifierTypes } from '../eval/modifiers';
import { textField } from '../ui/widgets';

const OB_ICON: Record<string, string> = {
  MESH: 'outliner_ob_mesh',
  CURVE: 'outliner_ob_curve',
  FONT: 'outliner_ob_font',
  EMPTY: 'outliner_ob_empty',
  LIGHT: 'outliner_ob_light',
  CAMERA: 'outliner_ob_camera',
  ARMATURE: 'outliner_ob_armature',
  LATTICE: 'outliner_ob_lattice',
  POINTCLOUD: 'outliner_ob_pointcloud',
  GREASEPENCIL: 'outliner_ob_greasepencil',
  META: 'outliner_ob_meta',
};
const DATA_ICON: Record<string, string> = { MESH: 'mesh_data', CURVE: 'curve_data', FONT: 'curve_data', LIGHT: 'light_data', CAMERA: 'camera_data', ARMATURE: 'armature_data', LATTICE: 'outliner_ob_lattice', GREASEPENCIL: 'outliner_data_greasepencil', META: 'meta_data' };

interface Row {
  key: string;
  depth: number;
  kind: 'collection' | 'object' | 'data' | 'modifier' | 'material' | 'scene' | 'constraint' | 'bone' | 'vgroup' | 'action';
  label: string;
  icon: string;
  id?: string;
  collection?: CollectionData;
  ob?: ObjectData;
  expandable: boolean;
  expanded: boolean;
  /** extra small icons to the right of the name (data, modifiers, ...) */
  chips?: string[];
}

export class Outliner implements Editor {
  el: HTMLElement;
  keymaps = ['Outliner', 'Window', 'Screen'];
  private list: HTMLElement;
  private expanded = new Set<string>();
  private collapsed = new Set<string>();
  private filter = '';
  displayMode: 'VIEW_LAYER' | 'SCENES' | 'BLENDER_FILE' | 'ORPHAN_DATA' = 'VIEW_LAYER';
  private renaming: string | null = null;
  private lastClicked: string | null = null;
  private rows: Row[] = [];
  private drag: { ids: string[]; kind: 'object' | 'collection' } | null = null;

  constructor(public area: Area) {
    this.el = document.createElement('div');
    this.el.className = 'outliner';
    this.list = document.createElement('div');
    this.list.className = 'ol-list';
    this.list.tabIndex = -1;
    this.el.append(this.list);
    this.list.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (!(e.target as HTMLElement).closest('.ol-row')) openMenu([{ label: 'New Collection', op: 'outliner.collection_new' }, { separator: true }, { label: 'Show All', op: 'object.hide_view_clear' }], { x: e.clientX, y: e.clientY });
    });
  }

  header(): Child {
    return h(
      'div',
      { class: 'hdr-row' },
      h(
        'button',
        {
          class: 'hdr-icondrop',
          'data-tip': 'Display Mode',
          onpointerdown: (e: PointerEvent) => {
            e.preventDefault();
            openMenu(
              [
                ['VIEW_LAYER', 'View Layer', 'view_layer'],
                ['SCENES', 'Scenes', 'scene_data'],
                ['BLENDER_FILE', 'Data Blocks', 'file_3d'],
                ['ORPHAN_DATA', 'Unused Data', 'trash'],
              ].map(([v, l, i]) => ({ label: l, icon: i, active: this.displayMode === v, action: () => ((this.displayMode = v as Outliner['displayMode']), this.update()) })),
              e.currentTarget as HTMLElement,
              { title: 'Display Mode' },
            );
          },
        },
        icon(this.displayMode === 'VIEW_LAYER' ? 'view_layer' : this.displayMode === 'SCENES' ? 'scene_data' : this.displayMode === 'BLENDER_FILE' ? 'file_3d' : 'trash'),
        icon('down_arrow_hlt', 'tiny'),
      ),
      h('div', { class: 'hdr-search' }, textField('ol-search', this.filter, (v) => ((this.filter = v), this.update()), { placeholder: 'Search', icon: 'search', live: true })),
      h('button', { class: 'hdr-toggle', 'data-tip': 'New Collection\nAdd a new collection inside selected collection', onclick: () => app.run('outliner.collection_new') }, icon('collection_new')),
    );
  }

  private buildRows(doc: DocumentData): Row[] {
    const rows: Row[] = [];
    const f = this.filter.toLowerCase();
    if (this.displayMode === 'BLENDER_FILE' || this.displayMode === 'ORPHAN_DATA') {
      const used = new Set<string>();
      for (const o of Object.values(doc.objects)) {
        if (o.data) used.add(o.data);
        const d = o.data ? ((doc.meshes[o.data] ?? doc.curves[o.data] ?? doc.metaballs?.[o.data]) as { materials?: (string | null)[] }) : undefined;
        d?.materials?.forEach((m) => m && used.add(m));
        if (o.animation_data?.action) used.add(o.animation_data.action);
      }
      if (doc.scene.world) used.add(doc.scene.world);
      const groups: [string, keyof DocumentData, string][] = [
        ['Actions', 'actions', 'action'],
        ['Armatures', 'armatures', 'armature_data'],
        ['Brushes', 'brushes', 'brush'],
        ['Cameras', 'cameras', 'camera_data'],
        ['Collections', 'collections', 'collection'],
        ['Curves', 'curves', 'curve_data'],
        ['Images', 'images', 'image'],
        ['Lights', 'lights', 'light_data'],
        ['Materials', 'materials', 'material'],
        ['Meshes', 'meshes', 'mesh_data'],
        ['Node Groups', 'node_groups', 'node_tree'],
        ['Objects', 'objects', 'object'],
        ['Texts', 'texts', 'text'],
        ['Worlds', 'worlds', 'world'],
      ];
      for (const [label, key, ic] of groups) {
        let items = Object.values(doc[key] as Record<string, { id: string; name: string; use_fake_user?: boolean }>);
        if (this.displayMode === 'ORPHAN_DATA') items = items.filter((x) => !used.has(x.id) && key !== 'objects' && key !== 'collections' && key !== 'brushes');
        if (!items.length) continue;
        const gk = `g:${key}`;
        const exp = !this.collapsed.has(gk);
        rows.push({ key: gk, depth: 0, kind: 'scene', label: `${label}`, icon: ic, expandable: true, expanded: exp });
        if (exp)
          for (const it of items)
            if (!f || it.name.toLowerCase().includes(f)) rows.push({ key: `${key}:${it.id}`, depth: 1, kind: key === 'objects' ? 'object' : 'data', id: it.id, ob: key === 'objects' ? (it as unknown as ObjectData) : undefined, label: it.name, icon: ic, expandable: false, expanded: false });
      }
      return rows;
    }
    const master = doc.collections[doc.scene.collection];
    const sceneKey = 'scene';
    if (this.displayMode === 'SCENES') rows.push({ key: sceneKey, depth: 0, kind: 'scene', label: doc.scene.name, icon: 'scene_data', expandable: false, expanded: true });
    const base = this.displayMode === 'SCENES' ? 1 : 0;
    const walk = (c: CollectionData, depth: number) => {
      const ck = `c:${c.id}`;
      const exp = !this.collapsed.has(ck);
      const isMaster = c.id === master.id;
      rows.push({ key: ck, depth, kind: 'collection', label: isMaster ? 'Scene Collection' : c.name, icon: isMaster ? 'scene' : 'collection', id: c.id, collection: c, expandable: c.children.length + c.objects.length > 0, expanded: exp });
      if (!exp) return;
      for (const ch of c.children) {
        const cc = doc.collections[ch];
        if (cc) walk(cc, depth + 1);
      }
      // objects: only roots (children nest under parents in the same collection)
      const inCol = new Set(c.objects);
      const objects = c.objects.map((id) => doc.objects[id]).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name));
      for (const ob of objects) if (!ob.parent || !inCol.has(ob.parent)) this.objectRows(doc, ob, depth + 1, rows, inCol, f);
    };
    walk(master, base);
    return rows;
  }

  private objectRows(doc: DocumentData, ob: ObjectData, depth: number, rows: Row[], inCol: Set<string>, f: string) {
    const ok = `o:${ob.id}`;
    const children = Object.values(doc.objects).filter((c) => c.parent === ob.id).sort((a, b) => a.name.localeCompare(b.name));
    const hasData = !!ob.data || ob.modifiers.length > 0 || ob.constraints.length > 0;
    const exp = this.expanded.has(ok);
    const match = !f || ob.name.toLowerCase().includes(f);
    const chips: string[] = [];
    if (ob.data) chips.push(DATA_ICON[ob.type] ?? 'mesh_data');
    if (ob.modifiers.length) chips.push('modifier');
    if (ob.constraints.length) chips.push('constraint');
    const mats = ob.data ? ((doc.meshes[ob.data] ?? doc.curves[ob.data] ?? doc.metaballs?.[ob.data]) as { materials?: (string | null)[] } | undefined)?.materials?.filter(Boolean) ?? [] : [];
    if (mats.length && !exp) chips.push('material');
    if (match) rows.push({ key: ok, depth, kind: 'object', label: ob.name, icon: OB_ICON[ob.type] ?? 'object', id: ob.id, ob, expandable: hasData || children.length > 0, expanded: exp, chips: exp ? [] : chips });
    if (exp && match) {
      if (ob.data) {
        const data = (doc.meshes[ob.data] ?? doc.curves[ob.data] ?? doc.lights[ob.data] ?? doc.cameras[ob.data] ?? doc.armatures[ob.data] ?? doc.lattices[ob.data] ?? doc.grease_pencils?.[ob.data] ?? doc.metaballs?.[ob.data]) as { name: string } | undefined;
        rows.push({ key: `d:${ob.id}`, depth: depth + 1, kind: 'data', label: data?.name ?? '', icon: DATA_ICON[ob.type] ?? 'mesh_data', ob, expandable: false, expanded: false });
        for (const m of mats) rows.push({ key: `m:${ob.id}:${m}`, depth: depth + 2, kind: 'material', label: doc.materials[m!]?.name ?? '', icon: 'material', ob, expandable: false, expanded: false });
        if (ob.type === 'MESH') {
          const me = doc.meshes[ob.data];
          for (const g of me?.vertex_groups ?? []) rows.push({ key: `vg:${ob.id}:${g.name}`, depth: depth + 2, kind: 'vgroup', label: g.name, icon: 'group_vertex', ob, expandable: false, expanded: false });
        }
      }
      if (ob.modifiers.length) {
        const mk = `ms:${ob.id}`;
        const mexp = !this.collapsed.has(mk);
        rows.push({ key: mk, depth: depth + 1, kind: 'modifier', label: 'Modifiers', icon: 'modifier', ob, expandable: true, expanded: mexp });
        if (mexp) for (const m of ob.modifiers) rows.push({ key: `md:${ob.id}:${m.id}`, depth: depth + 2, kind: 'modifier', label: m.name, icon: modifierTypes[m.type]?.icon ?? 'modifier', ob, expandable: false, expanded: false });
      }
      for (const c of ob.constraints) rows.push({ key: `cn:${ob.id}:${c.id}`, depth: depth + 1, kind: 'constraint', label: c.name, icon: 'constraint', ob, expandable: false, expanded: false });
      if (ob.animation_data?.action && doc.actions[ob.animation_data.action]) rows.push({ key: `ac:${ob.id}`, depth: depth + 1, kind: 'action', label: doc.actions[ob.animation_data.action].name, icon: 'action', ob, expandable: false, expanded: false });
    }
    if (!exp && children.length && !f) {
      // collapsed parents still list children (reference behaviour shows them nested once expanded)
    }
    if (exp || f) for (const c of children) this.objectRows(doc, c, depth + 1, rows, inCol, f);
  }

  update(kinds?: Set<ChangeKind>) {
    void kinds;
    const doc = app.doc;
    this.rows = this.buildRows(doc);
    const act = doc.scene.active_object;
    const actCol = activeCollection(doc);
    patch(
      this.list,
      this.rows.map((r, i) => {
        const ob = r.ob;
        const isObjRow = r.kind === 'object' && ob;
        const selected = isObjRow && ob.select && app.isVisible(ob.id);
        const active = isObjRow && act === ob.id;
        const colActive = r.kind === 'collection' && r.id === actCol;
        const hidden = isObjRow ? !app.isVisible(ob.id) : r.collection ? r.collection.hide || r.collection.exclude : false;
        return h(
          'div',
          {
            key: r.key,
            class: { 'ol-row': true, alt: i % 2 === 1, selected: !!selected || colActive, active: !!active, dim: !!hidden, editmode: !!(active && doc.mode === 'EDIT') },
            style: { '--depth': String(r.depth) },
            draggable: r.kind === 'object' || (r.kind === 'collection' && r.id !== doc.scene.collection) ? 'true' : 'false',
            onpointerdown: (e: PointerEvent) => this.onRowDown(e, r),
            ondblclick: (e: MouseEvent) => {
              if ((e.target as HTMLElement).closest('.ol-toggle, .ol-arrow')) return;
              this.renaming = r.key;
              this.update();
            },
            oncontextmenu: (e: MouseEvent) => {
              e.preventDefault();
              this.contextMenu(e, r);
            },
            ondragstart: (e: DragEvent) => {
              if (r.kind === 'object' && ob) {
                const ids = ob.select ? app.selectedObjects().map((o) => o.id) : [ob.id];
                this.drag = { ids, kind: 'object' };
              } else if (r.kind === 'collection' && r.id) this.drag = { ids: [r.id], kind: 'collection' };
              e.dataTransfer?.setData('text/plain', r.label);
            },
            ondragover: (e: DragEvent) => {
              if (!this.drag) return;
              if (r.kind === 'collection' || r.kind === 'object') {
                e.preventDefault();
                (e.currentTarget as HTMLElement).classList.add('drop');
              }
            },
            ondragleave: (e: DragEvent) => (e.currentTarget as HTMLElement).classList.remove('drop'),
            ondrop: (e: DragEvent) => {
              e.preventDefault();
              (e.currentTarget as HTMLElement).classList.remove('drop');
              this.onDrop(r, e.shiftKey, e.ctrlKey || e.metaKey);
            },
          },
          h('span', { class: 'ol-indent' }),
          r.expandable
            ? h(
                'button',
                {
                  class: 'ol-arrow',
                  tabindex: '-1',
                  onpointerdown: (e: PointerEvent) => {
                    e.stopPropagation();
                    this.toggleExpand(r, e.shiftKey);
                  },
                },
                icon(r.expanded ? 'disclosure_tri_down' : 'disclosure_tri_right'),
              )
            : h('span', { class: 'ol-arrow-space' }),
          h('span', { class: 'ol-icon' }, icon(r.icon)),
          this.renaming === r.key
            ? h('input', {
                class: 'ol-rename',
                value: r.label,
                ref: (el: HTMLInputElement) =>
                  requestAnimationFrame(() => {
                    el.focus();
                    el.select();
                  }),
                onkeydown: (e: KeyboardEvent) => {
                  e.stopPropagation();
                  if (e.key === 'Enter') this.rename(r, (e.target as HTMLInputElement).value);
                  if (e.key === 'Escape') {
                    this.renaming = null;
                    this.update();
                  }
                },
                onblur: (e: FocusEvent) => this.renaming === r.key && this.rename(r, (e.target as HTMLInputElement).value),
              })
            : h('span', { class: 'ol-name' }, r.label),
          r.chips?.length ? h('span', { class: 'ol-chips' }, r.chips.map((c) => icon(c))) : null,
          h('span', { class: 'ol-spacer' }),
          this.toggles(r),
        );
      }),
    );
  }

  private toggles(r: Row): Child {
    const doc = app.doc;
    if (r.kind === 'collection' && r.collection && r.id !== doc.scene.collection) {
      const c = r.collection;
      return h(
        'span',
        { class: 'ol-toggles' },
        h('button', { class: { 'ol-toggle': true, off: c.exclude }, 'data-tip': 'Exclude from View Layer', onpointerdown: (e: PointerEvent) => this.flipCollection(e, c, 'exclude') }, icon(c.exclude ? 'checkbox_dehlt' : 'checkbox_hlt')),
        h('button', { class: { 'ol-toggle': true, off: c.hide }, 'data-tip': 'Hide in Viewport', onpointerdown: (e: PointerEvent) => this.flipCollection(e, c, 'hide') }, icon(c.hide ? 'hide_on' : 'hide_off')),
        h('button', { class: { 'ol-toggle': true, off: c.hide_render }, 'data-tip': 'Disable in Renders', onpointerdown: (e: PointerEvent) => this.flipCollection(e, c, 'hide_render') }, icon(c.hide_render ? 'restrict_render_on' : 'restrict_render_off')),
      );
    }
    if (r.kind === 'object' && r.ob && this.displayMode !== 'BLENDER_FILE' && this.displayMode !== 'ORPHAN_DATA') {
      const ob = r.ob;
      return h(
        'span',
        { class: 'ol-toggles' },
        h('button', { class: { 'ol-toggle': true, off: ob.hide }, 'data-tip': 'Hide in Viewport (H)', onpointerdown: (e: PointerEvent) => this.flipObject(e, ob, 'hide') }, icon(ob.hide ? 'hide_on' : 'hide_off')),
        h('button', { class: { 'ol-toggle': true, off: ob.hide_render }, 'data-tip': 'Disable in Renders', onpointerdown: (e: PointerEvent) => this.flipObject(e, ob, 'hide_render') }, icon(ob.hide_render ? 'restrict_render_on' : 'restrict_render_off')),
      );
    }
    return null;
  }

  private flipCollection(e: PointerEvent, c: CollectionData, key: 'exclude' | 'hide' | 'hide_render') {
    e.stopPropagation();
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      // isolate: only this collection visible
      for (const other of Object.values(app.doc.collections)) if (other.id !== app.doc.scene.collection) other[key] = other.id !== c.id;
    } else c[key] = !c[key];
    app.pushUndo('Collection Visibility');
    app.changed('doc', 'select');
  }

  private flipObject(e: PointerEvent, ob: ObjectData, key: 'hide' | 'hide_render') {
    e.stopPropagation();
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      for (const o of Object.values(app.doc.objects)) o[key] = o.id !== ob.id;
    } else {
      ob[key] = !ob[key];
      if (key === 'hide' && ob.hide) ob.select = false;
      // shift: apply to children too
      if (e.shiftKey) for (const c of Object.values(app.doc.objects)) if (c.parent === ob.id) c[key] = ob[key];
    }
    app.pushUndo('Object Visibility');
    app.changed('doc', 'select');
  }

  private toggleExpand(r: Row, recursive: boolean) {
    const set = r.kind === 'object' ? this.expanded : this.collapsed;
    const isOpen = r.expanded;
    const flip = (key: string) => {
      if (r.kind === 'object') {
        if (isOpen) set.delete(key);
        else set.add(key);
      } else if (isOpen) set.add(key);
      else set.delete(key);
    };
    flip(r.key);
    if (recursive && r.collection) {
      const walk = (c: CollectionData) => {
        for (const ch of c.children) {
          if (isOpen) this.collapsed.add(`c:${ch}`);
          else this.collapsed.delete(`c:${ch}`);
          walk(app.doc.collections[ch]);
        }
      };
      walk(r.collection);
    }
    this.update();
  }

  private onRowDown(e: PointerEvent, r: Row) {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest('.ol-toggle, .ol-arrow, input')) return;
    const doc = app.doc;
    if (r.kind === 'collection' && r.id) {
      setActiveCollection(r.id);
      app.changed('ui');
      this.update();
      return;
    }
    const ob = r.ob;
    if (!ob) return;
    if (r.kind === 'material' || r.kind === 'modifier' || r.kind === 'data' || r.kind === 'constraint') {
      // activating a sub-item activates its object and jumps to the matching properties tab
      for (const o of Object.values(doc.objects)) o.select = false;
      ob.select = true;
      doc.scene.active_object = ob.id;
      const tab = r.kind === 'material' ? 'MATERIAL' : r.kind === 'modifier' ? 'MODIFIER' : r.kind === 'constraint' ? 'CONSTRAINT' : 'DATA';
      (window as unknown as { __propertiesTab?: string }).__propertiesTab = tab;
      app.pushUndo('Outliner Select');
      app.changed('select', 'doc');
      return;
    }
    if (doc.mode !== 'OBJECT' && doc.mode !== 'POSE' && doc.scene.active_object !== ob.id) {
      // switching the edited object (mode transfer)
      app.run('object.mode_set', { mode: 'OBJECT' });
    }
    const ctrl = e.ctrlKey || e.metaKey;
    if (e.shiftKey && this.lastClicked) {
      // range select in row order
      const ids = this.rows.filter((x) => x.kind === 'object' && x.ob).map((x) => x.ob!.id);
      const a = ids.indexOf(this.lastClicked),
        b = ids.indexOf(ob.id);
      if (a >= 0 && b >= 0) for (const id of ids.slice(Math.min(a, b), Math.max(a, b) + 1)) doc.objects[id].select = true;
    } else if (ctrl) {
      ob.select = !ob.select || doc.scene.active_object !== ob.id;
    } else {
      for (const o of Object.values(doc.objects)) o.select = false;
      ob.select = true;
    }
    if (ob.select) doc.scene.active_object = ob.id;
    this.lastClicked = ob.id;
    // children of a selected collection move with the active collection
    const col = Object.values(doc.collections).find((c) => c.objects.includes(ob.id));
    if (col) setActiveCollection(col.id);
    app.pushUndo('Outliner Select');
    app.changed('select', 'doc');
  }

  private rename(r: Row, name: string) {
    this.renaming = null;
    const doc = app.doc;
    name = name.trim();
    if (name) {
      if (r.kind === 'object' && r.ob) r.ob.name = uniqueName(doc, name);
      else if (r.kind === 'collection' && r.collection && r.id !== doc.scene.collection) r.collection.name = uniqueName(doc, name, 'collections');
      else if (r.kind === 'data' && r.ob?.data) {
        const d = (doc.meshes[r.ob.data] ?? doc.curves[r.ob.data] ?? doc.lights[r.ob.data] ?? doc.cameras[r.ob.data] ?? doc.armatures[r.ob.data] ?? doc.metaballs?.[r.ob.data]) as { name: string } | undefined;
        if (d) d.name = name;
      } else if (r.kind === 'modifier' && r.ob) {
        const id = r.key.split(':')[2];
        const m = r.ob.modifiers.find((x) => x.id === id);
        if (m) m.name = name;
      } else if (r.kind === 'material' && r.key.startsWith('m:')) {
        const id = r.key.split(':')[2];
        if (doc.materials[id]) doc.materials[id].name = name;
      } else if (r.id && r.key.includes(':')) {
        const [table, id] = r.key.split(':');
        const item = (doc as unknown as Record<string, Record<string, { name: string }>>)[table]?.[id];
        if (item) item.name = name;
      }
      app.pushUndo('Rename');
    }
    app.changed('doc');
    this.update();
  }

  private onDrop(r: Row, shift: boolean, ctrl: boolean) {
    const doc = app.doc;
    const d = this.drag;
    this.drag = null;
    if (!d) return;
    if (d.kind === 'object' && r.kind === 'collection' && r.id) {
      for (const id of d.ids) {
        if (!ctrl) for (const c of Object.values(doc.collections)) c.objects = c.objects.filter((x) => x !== id);
        if (!doc.collections[r.id].objects.includes(id)) doc.collections[r.id].objects.push(id);
        // dropping onto a collection also clears the parent (like dragging out of the parent)
        if (shift) doc.objects[id].parent = null;
      }
      app.pushUndo(ctrl ? 'Link to Collection' : 'Move to Collection');
    } else if (d.kind === 'object' && r.kind === 'object' && r.ob) {
      // parent to the target object (keep transform)
      const parent = r.ob;
      const pw = app.graph.get(parent.id)!.world.clone();
      for (const id of d.ids) {
        if (id === parent.id) continue;
        const ob = doc.objects[id];
        let q: string | null = parent.id,
          cycle = false;
        while (q) {
          if (q === id) cycle = true;
          q = doc.objects[q]?.parent ?? null;
        }
        if (cycle) continue;
        const w = app.graph.get(id)!.world.clone();
        ob.parent = parent.id;
        ob.matrix_parent_inverse = fromMatrix4(new Matrix4());
        applyMatrixToObject(ob, pw.clone().invert().multiply(w));
      }
      app.pushUndo('Drop to Set Parent');
    } else if (d.kind === 'collection' && r.kind === 'collection' && r.id && d.ids[0] !== r.id) {
      const moving = d.ids[0];
      // prevent cycles
      const isDesc = (c: string): boolean => c === moving || doc.collections[c]?.children.some(isDesc) || false;
      void isDesc;
      const contains = (root: string, x: string): boolean => root === x || doc.collections[root].children.some((ch) => contains(ch, x));
      if (contains(moving, r.id)) return;
      for (const c of Object.values(doc.collections)) c.children = c.children.filter((x) => x !== moving);
      doc.collections[r.id].children.push(moving);
      app.pushUndo('Move Collection');
    }
    app.changed('doc', 'select');
  }

  private contextMenu(e: MouseEvent, r: Row) {
    const doc = app.doc;
    let items: MenuItem[] = [];
    if (r.kind === 'collection' && r.collection) {
      const c = r.collection;
      const isMaster = r.id === doc.scene.collection;
      items = [
        { label: 'New Collection', op: 'outliner.collection_new' },
        ...(isMaster
          ? []
          : [
              { label: 'Duplicate Collection', action: () => app.run('outliner.collection_duplicate', { collection: c.id }) },
              { label: 'Delete', action: () => app.run('outliner.collection_delete', { collection: c.id, hierarchy: false }) },
              { label: 'Delete Hierarchy', action: () => app.run('outliner.collection_delete', { collection: c.id, hierarchy: true }) },
            ]),
        { separator: true },
        { label: 'Select Objects', action: () => app.run('outliner.collection_objects_select', { collection: c.id }) },
        { label: 'Deselect Objects', action: () => app.run('outliner.collection_objects_select', { collection: c.id, deselect: true }) },
        { separator: true },
        { label: 'Instance to Scene', disabled: isMaster, action: () => app.run('object.collection_instance_add', { collection: c.id }, { invoke: false }) },
        { separator: true },
        { label: 'Set Color Tag', submenu: () => (['NONE', 'COLOR_01', 'COLOR_02', 'COLOR_03', 'COLOR_04', 'COLOR_05', 'COLOR_06', 'COLOR_07', 'COLOR_08'] as const).map((t) => ({ label: t === 'NONE' ? 'None' : `Color ${t.slice(-1)}`, action: () => ((c.color_tag = t), app.pushUndo('Color Tag'), app.changed('doc')) })) },
        { separator: true },
        { label: 'Rename', action: () => ((this.renaming = r.key), this.update()) },
      ];
    } else if (r.kind === 'object' && r.ob) {
      if (!r.ob.select) {
        for (const o of Object.values(doc.objects)) o.select = false;
        r.ob.select = true;
        doc.scene.active_object = r.ob.id;
        app.changed('select');
      }
      items = [
        { label: 'Copy', op: 'view3d.copybuffer' },
        { label: 'Paste', op: 'view3d.pastebuffer' },
        { separator: true },
        { label: 'Delete', op: 'object.delete', props: { confirm: false } },
        { label: 'Delete Hierarchy', action: () => app.run('outliner.object_delete_hierarchy', { object: r.ob!.id }) },
        { separator: true },
        { label: 'Select', action: () => ((r.ob!.select = true), app.pushUndo('Select'), app.changed('select')) },
        { label: 'Select Hierarchy', action: () => app.run('outliner.object_select_hierarchy', { object: r.ob!.id }) },
        { label: 'Deselect', action: () => ((r.ob!.select = false), app.pushUndo('Deselect'), app.changed('select')) },
        { separator: true },
        { label: 'Show/Hide', submenu: () => [{ label: 'Show One Level', action: () => this.update() }, { label: 'Hide Selected', op: 'object.hide_view_set' }, { label: 'Show All', op: 'object.hide_view_clear' }] },
        { label: 'Rename', shortcut: 'F2', action: () => ((this.renaming = r.key), this.update()) },
      ];
    } else items = [{ label: 'Rename', action: () => ((this.renaming = r.key), this.update()) }];
    openMenu(items, { x: e.clientX, y: e.clientY });
  }

  onKey(e: KeyboardEvent): boolean {
    const doc = app.doc;
    if (e.code === 'KeyX' || e.code === 'Delete') {
      const sel = app.selectedObjects();
      if (sel.length) {
        deleteObjects(doc, new Set(sel.map((o) => o.id)));
        app.pushUndo('Delete');
        app.changed('doc');
        return true;
      }
    }
    if (e.code === 'F2') {
      const act = doc.scene.active_object;
      if (act) {
        this.renaming = `o:${act}`;
        this.update();
        return true;
      }
    }
    if (e.code === 'KeyA' && !e.altKey && !e.ctrlKey) {
      app.run('object.select_all', { action: 'SELECT' });
      return true;
    }
    if (e.code === 'KeyA' && e.altKey) {
      app.run('object.select_all', { action: 'DESELECT' });
      return true;
    }
    if (e.code === 'KeyH') {
      app.run(e.altKey ? 'object.hide_view_clear' : 'object.hide_view_set');
      return true;
    }
    if (e.code === 'NumpadDecimal' || e.code === 'Period') {
      // show active row: expand ancestors
      const act = doc.scene.active_object ? doc.objects[doc.scene.active_object] : null;
      let p = act?.parent;
      while (p) {
        this.expanded.add(`o:${p}`);
        p = doc.objects[p]?.parent;
      }
      this.update();
      this.list.querySelector('.ol-row.active')?.scrollIntoView({ block: 'nearest' });
      return true;
    }
    return false;
  }

  dispose() {}
}

registerEditor({ id: 'OUTLINER', label: 'Outliner', icon: 'outliner', group: 'Data', create: (area) => new Outliner(area) });

registerOperators([
  {
    idname: 'outliner.collection_new',
    label: 'New Collection',
    description: 'Add a new collection inside selected collection',
    exec: (ctx) => {
      const doc = ctx.doc;
      const parent = activeCollection(doc);
      const c = newCollection(uniqueName(doc, 'Collection', 'collections'));
      doc.collections[c.id] = c;
      doc.collections[parent].children.push(c.id);
      setActiveCollection(c.id);
    },
  },
  {
    idname: 'outliner.collection_delete',
    label: 'Delete Collection',
    props: [{ id: 'collection', label: 'Collection', type: 'string', default: '', hidden: true }, { id: 'hierarchy', label: 'Hierarchy', type: 'bool', default: false }],
    exec: (ctx, p) => {
      const doc = ctx.doc;
      const id = p.collection as string;
      const c = doc.collections[id];
      if (!c || id === doc.scene.collection) return 'CANCELLED';
      const parent = Object.values(doc.collections).find((x) => x.children.includes(id))!;
      const remove = (cid: string, objects: Set<string>) => {
        const cc = doc.collections[cid];
        for (const ch of cc.children) remove(ch, objects);
        cc.objects.forEach((o) => objects.add(o));
        delete doc.collections[cid];
      };
      if (p.hierarchy) {
        const objs = new Set<string>();
        remove(id, objs);
        parent.children = parent.children.filter((x) => x !== id);
        // only delete objects that are not linked elsewhere
        for (const o of [...objs]) if (Object.values(doc.collections).some((x) => x.objects.includes(o))) objs.delete(o);
        deleteObjects(doc, objs);
      } else {
        parent.children = parent.children.filter((x) => x !== id).concat(c.children);
        for (const o of c.objects) if (!parent.objects.includes(o)) parent.objects.push(o);
        delete doc.collections[id];
      }
    },
  },
  {
    idname: 'outliner.collection_duplicate',
    label: 'Duplicate Collection',
    props: [{ id: 'collection', label: 'Collection', type: 'string', default: '', hidden: true }],
    exec: (ctx, p) => {
      const doc = ctx.doc;
      const src = doc.collections[p.collection as string];
      if (!src) return 'CANCELLED';
      const c = newCollection(uniqueName(doc, src.name, 'collections'));
      c.objects = [...src.objects];
      doc.collections[c.id] = c;
      const parent = Object.values(doc.collections).find((x) => x.children.includes(src.id)) ?? doc.collections[doc.scene.collection];
      parent.children.push(c.id);
    },
  },
  {
    idname: 'outliner.collection_objects_select',
    label: 'Select Objects',
    props: [{ id: 'collection', label: 'Collection', type: 'string', default: '', hidden: true }, { id: 'deselect', label: 'Deselect', type: 'bool', default: false }],
    exec: (ctx, p) => {
      const c = ctx.doc.collections[p.collection as string];
      if (!c) return 'CANCELLED';
      for (const id of c.objects) if (ctx.doc.objects[id]) ctx.doc.objects[id].select = !p.deselect;
    },
  },
  {
    idname: 'outliner.object_delete_hierarchy',
    label: 'Delete Hierarchy',
    props: [{ id: 'object', label: 'Object', type: 'string', default: '', hidden: true }],
    exec: (ctx, p) => {
      const ids = new Set<string>([p.object as string]);
      let grew = true;
      while (grew) {
        grew = false;
        for (const o of Object.values(ctx.doc.objects))
          if (o.parent && ids.has(o.parent) && !ids.has(o.id)) {
            ids.add(o.id);
            grew = true;
          }
      }
      deleteObjects(ctx.doc, ids);
    },
  },
  {
    idname: 'outliner.object_select_hierarchy',
    label: 'Select Hierarchy',
    props: [{ id: 'object', label: 'Object', type: 'string', default: '', hidden: true }],
    exec: (ctx, p) => {
      const ids = new Set<string>([p.object as string]);
      let grew = true;
      while (grew) {
        grew = false;
        for (const o of Object.values(ctx.doc.objects))
          if (o.parent && ids.has(o.parent) && !ids.has(o.id)) {
            ids.add(o.id);
            grew = true;
          }
      }
      for (const id of ids) ctx.doc.objects[id].select = true;
    },
  },
]);

export { promptText };
