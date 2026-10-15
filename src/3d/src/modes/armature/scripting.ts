// Scripting: armature bone collections (`arm.collections.new()` / `.remove()` / `.active`,
// `bcoll.assign(bone)` / `.unassign(bone)` / `.bones`, `bone.collections`). Other armature and
// bone fields go through the generic struct wrapper.
import { ID_CLASSES, IDStruct } from '../../scripting/api';
import { PropCollection, Struct, proxify, pyError, touched, type Raw } from '../../scripting/rna';
import type { ArmatureData, Bone, BoneCollection } from '../../data/types';
import * as A from './armkernels';

/** Bone record behind a script value (a bone struct, or a bone name). */
function boneOf(arm: ArmatureData, v: unknown): Bone {
  if (typeof v === 'string') {
    const b = arm.bones.find((x) => x.name === v);
    if (b) return b;
  } else if (v instanceof Struct) {
    const raw = v.__resolve() as unknown as Bone | null;
    if (raw && arm.bones.includes(raw)) return raw;
  }
  throw pyError('TypeError', 'expected a bone of this armature');
}

class BoneCollectionStruct extends Struct {
  constructor(
    readonly __arm: () => ArmatureData,
    readonly __c: BoneCollection,
    path: string,
  ) {
    super('BoneCollection', () => (__arm().collections?.includes(__c) ? (__c as unknown as Raw) : null), path);
  }
  get name() {
    return this.__c.name;
  }
  set name(v: string) {
    const arm = this.__arm();
    A.renameCollection(arm, arm.collections!.indexOf(this.__c), String(v));
    touched();
  }
  get bones() {
    const arm = this.__arm();
    return arm.bones.filter((b) => b.collections?.includes(this.__c.name)).map((b) => b.name);
  }
  assign(bone: unknown) {
    A.assignBone(boneOf(this.__arm(), bone), this.__c.name);
    touched();
    return true;
  }
  unassign(bone: unknown) {
    A.unassignBone(boneOf(this.__arm(), bone), this.__c.name);
    touched();
    return true;
  }
}

class BoneCollections extends PropCollection<unknown> {
  constructor(
    path: string,
    readonly __arm: () => ArmatureData,
  ) {
    super(path);
  }
  private wrap(c: BoneCollection, i: number) {
    return proxify(new BoneCollectionStruct(this.__arm, c, `${this.__path}[${i}]`));
  }
  list() {
    return A.collectionsOf(this.__arm()).map((c, i) => this.wrap(c, i));
  }
  nameOf(item: unknown) {
    return (item as BoneCollectionStruct).name;
  }
  new(name: string = 'Bones') {
    const arm = this.__arm();
    const c = A.addCollection(arm, String(name || 'Bones'));
    touched();
    return this.wrap(c, arm.collections!.length - 1);
  }
  remove(bcoll: unknown) {
    const arm = this.__arm();
    const c = (bcoll as BoneCollectionStruct | null)?.__c;
    const i = c ? A.collectionsOf(arm).indexOf(c) : -1;
    if (i < 0) throw pyError('ValueError', 'BoneCollections.remove(): collection not found');
    A.removeCollection(arm, i);
    touched();
  }
  get active() {
    const arm = this.__arm();
    const cols = A.collectionsOf(arm);
    const i = arm.active_collection_index ?? 0;
    return cols[i] ? this.wrap(cols[i], i) : null;
  }
  set active(v: unknown) {
    const arm = this.__arm();
    const i = A.collectionsOf(arm).indexOf((v as BoneCollectionStruct)?.__c);
    if (i >= 0) arm.active_collection_index = i;
    touched();
  }
  get active_index() {
    return this.__arm().active_collection_index ?? 0;
  }
  set active_index(i: number) {
    this.__arm().active_collection_index = Math.max(0, Math.min(Number(i), A.collectionsOf(this.__arm()).length - 1));
    touched();
  }
  get active_name() {
    return this.active ? (this.active as BoneCollectionStruct).name : '';
  }
}

class ArmatureStruct extends IDStruct {
  get collections() {
    return new BoneCollections(`${this.__path}.collections`, () => this.__raw as unknown as ArmatureData);
  }
  get collections_all() {
    return this.collections;
  }
}

ID_CLASSES.armatures = ArmatureStruct;
