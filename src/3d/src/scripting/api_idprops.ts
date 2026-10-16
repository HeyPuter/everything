// Custom property settings from scripts: `ob.id_properties_ui("prop").update(min=0, max=10,
// subtype="DISTANCE", description="…")`, `.as_dict()`, `.clear()`; deleting a property drops them.
import { Struct, kwMethod, mixin, pyError, touched, type Raw } from './rna';
import { customPropMeta, setCustomPropMeta, type CustomPropMeta } from '../ui/custommeta';

const KEYS = ['subtype', 'min', 'max', 'soft_min', 'soft_max', 'precision', 'step', 'default', 'description'] as const;

class IdPropertyUI {
  constructor(
    private raw: Raw,
    private key: string,
  ) {}
  update(...args: unknown[]) {
    const meta: CustomPropMeta = { ...customPropMeta(this.raw, this.key) };
    KEYS.forEach((k, i) => {
      const v = args[i];
      if (v === undefined || v === null) return;
      (meta as Record<string, unknown>)[k] = k === 'subtype' || k === 'description' ? String(v) : k === 'default' ? v : Number(v);
    });
    setCustomPropMeta(this.raw, this.key, meta);
    touched();
  }
  as_dict() {
    const m = customPropMeta(this.raw, this.key);
    return { subtype: m.subtype ?? 'NONE', description: m.description ?? '', ...m };
  }
  clear() {
    setCustomPropMeta(this.raw, this.key, null);
    touched();
  }
  update_from(other: unknown) {
    if (!(other instanceof IdPropertyUI)) throw pyError('TypeError', 'update_from(): expected the result of id_properties_ui()');
    setCustomPropMeta(this.raw, this.key, { ...other.as_dict() });
    touched();
  }
  toString() {
    return `<bpy id property UI data of "${this.key}">`;
  }
}
kwMethod(IdPropertyUI.prototype, 'update', [...KEYS]);

class StructIdProps {
  /** Settings of the custom property `key` (limits, default, subtype, description). */
  id_properties_ui(this: Struct, key: string) {
    const c = this.__raw.custom as Raw | undefined;
    if (!c || !(key in c)) throw pyError('KeyError', `'id_properties_ui(): key "${key}" not found'`);
    return new IdPropertyUI(this.__raw, key);
  }
  delItem(this: Struct, key: string) {
    const c = this.__raw.custom as Raw | undefined;
    if (c) delete c[key];
    setCustomPropMeta(this.__raw, key, null);
    touched();
  }
}
mixin(Struct, StructIdProps, true);
