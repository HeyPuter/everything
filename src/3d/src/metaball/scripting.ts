// Scripting: bpy.data.metaballs items expose `elements` with new(type) / remove(element) / clear();
// element and metaball fields (co, radius, stiffness, type, use_negative, resolution, threshold…)
// are reached through the generic struct wrapper.
import { ID_CLASSES, IDStruct } from '../scripting/api';
import { PropCollection, Struct, proxify, pyError, touched, type Raw } from '../scripting/rna';
import { newMetaElement } from './data';
import type { MetaballData, MetaElement, MetaElementType } from './types';

const TYPES: MetaElementType[] = ['BALL', 'CAPSULE', 'PLANE', 'ELLIPSOID', 'CUBE'];

class MetaElementStruct extends Struct {
  constructor(
    readonly __mb: () => MetaballData,
    readonly __el: MetaElement,
    path: string,
  ) {
    super('MetaElement', () => (__mb().elements.includes(__el) ? (__el as unknown as Raw) : null), path);
  }
  get type() {
    return this.__el.type;
  }
  set type(v: string) {
    const t = String(v).toUpperCase() as MetaElementType;
    if (!TYPES.includes(t)) throw pyError('TypeError', `bpy_struct: item.attr = val: enum "${v}" not found in (${TYPES.map((x) => `'${x}'`).join(', ')})`);
    this.__el.type = t;
    touched('geometry');
  }
}

class MetaElements extends PropCollection<unknown> {
  constructor(
    path: string,
    readonly __mb: () => MetaballData,
  ) {
    super(path);
  }
  private wrap(e: MetaElement, i: number) {
    return proxify(new MetaElementStruct(this.__mb, e, `${this.__path}[${i}]`));
  }
  list() {
    return this.__mb().elements.map((e, i) => this.wrap(e, i));
  }
  nameOf() {
    return '';
  }
  /** Add an element (BALL by default) at the origin. */
  new(type: string = 'BALL') {
    const t = String(type ?? 'BALL').toUpperCase() as MetaElementType;
    if (!TYPES.includes(t)) throw pyError('TypeError', `MetaBallElements.new(): enum "${type}" not found in (${TYPES.map((x) => `'${x}'`).join(', ')})`);
    const mb = this.__mb();
    const e = newMetaElement(t);
    mb.elements.push(e);
    touched('geometry');
    return this.wrap(e, mb.elements.length - 1);
  }
  remove(element: unknown) {
    const mb = this.__mb();
    const el = (element as { __el?: MetaElement } | null)?.__el;
    const i = el ? mb.elements.indexOf(el) : -1;
    if (i < 0) throw pyError('ValueError', 'MetaBallElements.remove(): element not found');
    mb.elements.splice(i, 1);
    if ((mb.active_element ?? -1) >= mb.elements.length) mb.active_element = -1;
    touched('geometry');
  }
  clear() {
    this.__mb().elements = [];
    this.__mb().active_element = -1;
    touched('geometry');
  }
  get active() {
    const mb = this.__mb();
    const i = mb.active_element ?? -1;
    return i >= 0 && mb.elements[i] ? this.wrap(mb.elements[i], i) : null;
  }
}

class MetaballStruct extends IDStruct {
  get elements() {
    return new MetaElements(`${this.__path}.elements`, () => this.__raw as unknown as MetaballData);
  }
  get is_editmode() {
    return false;
  }
}

ID_CLASSES.metaballs = MetaballStruct;
