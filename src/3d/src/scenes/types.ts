// Data model of multiple scenes, view layers, light linking and light groups. Everything is
// stored additively on the existing document types:
//
// - `doc.scene` stays the *active* scene, so editors keep reading it directly. The other scenes
//   live in `doc.scenes` (keyed by scene id); an inactive scene keeps its master collection in
//   `scene.master_collection` (the active scene's master collection is in `doc.collections`).
// - The active view layer's settings are "live": its passes in `scene.render` and its collection
//   flags (exclude / hide / holdout / indirect only) on the collections. Inactive layers keep a
//   stored copy (`ViewLayerData.stored`); switching layers swaps them (src/scenes/viewlayers.ts).
import type { CollectionData, ID, RenderSettings } from '../data/types';

/** Per view layer flags of a collection. */
export interface LayerCollectionFlags {
  exclude?: boolean;
  hide?: boolean;
  holdout?: boolean;
  indirect_only?: boolean;
}

export interface LightGroupData {
  name: string;
}

export interface ViewLayerData {
  name: string;
  /** settings of an inactive layer (the active one's are live on the scene and collections) */
  stored?: {
    render: Partial<RenderSettings>;
    collections: Record<ID, LayerCollectionFlags>;
  };
  lightgroups?: LightGroupData[];
  active_lightgroup_index?: number;
  active_aov_index?: number;
  /** path tracer samples for this layer (0 = the scene's samples) */
  samples?: number;
}

export type LightLinkState = 'INCLUDE' | 'EXCLUDE';

export interface ObjectLightLinking {
  receiver_collection: ID | null;
  blocker_collection: ID | null;
}

declare module '../data/types' {
  interface SceneData {
    /** stable id of the scene data-block */
    id?: ID;
    view_layers?: ViewLayerData[];
    /** index of the active view layer in `view_layers` */
    active_view_layer?: number;
    /** master collection of an inactive scene (moved back into doc.collections when it becomes active) */
    master_collection?: CollectionData;
    use_fake_user?: boolean;
  }
  interface DocumentData {
    /** scenes other than the active one, keyed by their id */
    scenes?: Record<ID, SceneData>;
  }
  interface CollectionData {
    /** light linking: how members (objects or child collections) are linked when the collection is used for linking */
    light_linking?: Record<ID, LightLinkState>;
  }
  interface ObjectData {
    light_linking?: ObjectLightLinking;
    /** light group the object's emission is rendered into */
    lightgroup?: string;
  }
  interface WorldData {
    lightgroup?: string;
  }
  interface RenderSettings {
    /** F12 renders only the active view layer */
    use_single_layer?: boolean;
  }
}
