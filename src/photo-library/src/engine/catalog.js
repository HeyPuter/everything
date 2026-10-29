/**
 * Photo Library catalog (original). Lightroom-inspired — not Adobe Lightroom.
 * Non-destructive adjust metadata only; no LIVE cloud sync (DOCUMENTED).
 */

/** @typedef {{ exposure:number, contrast:number, saturation:number, temperature:number }} Adjustments */
/** @typedef {{ id:string, name:string, rating:number, flag:'pick'|'reject'|null, adjustments:Adjustments, tags:string[] }} Photo */
/** @typedef {{ photos:Photo[], filter:{ minRating:number, tag:string } }} Catalog */

/** @returns {Adjustments} */
export function defaultAdjustments() {
  return { exposure: 0, contrast: 0, saturation: 0, temperature: 0 };
}

/** @returns {Catalog} */
export function createCatalog() {
  return {
    photos: [
      seed('p1', 'Harbor Morning', 4, ['travel', 'blue']),
      seed('p2', 'Forest Trail', 3, ['nature']),
      seed('p3', 'City Night', 5, ['urban', 'night']),
      seed('p4', 'Studio Portrait', 2, ['people']),
      seed('p5', 'Desert Road', 0, ['travel']),
    ],
    filter: { minRating: 0, tag: '' },
  };
}

/** @param {string} id @param {string} name @param {number} rating @param {string[]} tags */
function seed(id, name, rating, tags) {
  return {
    id,
    name,
    rating,
    flag: null,
    adjustments: defaultAdjustments(),
    tags,
  };
}

/** @param {Catalog} cat @param {string} photoId @param {number} rating */
export function setRating(cat, photoId, rating) {
  const r = Math.max(0, Math.min(5, Math.round(rating)));
  return mapPhoto(cat, photoId, (p) => ({ ...p, rating: r }));
}

/** @param {Catalog} cat @param {string} photoId @param {'pick'|'reject'|null} flag */
export function setFlag(cat, photoId, flag) {
  return mapPhoto(cat, photoId, (p) => ({ ...p, flag }));
}

/** @param {Catalog} cat @param {string} photoId @param {Partial<Adjustments>} patch */
export function adjustPhoto(cat, photoId, patch) {
  return mapPhoto(cat, photoId, (p) => ({
    ...p,
    adjustments: { ...p.adjustments, ...patch },
  }));
}

/** Non-destructive: original pixels untouched; CSS/filter recipe from adjustments. */
export function previewFilter(adj) {
  const brightness = 1 + adj.exposure * 0.15;
  const contrast = 1 + adj.contrast * 0.1;
  const saturate = 1 + adj.saturation * 0.12;
  const hue = adj.temperature * 6;
  return `brightness(${brightness.toFixed(3)}) contrast(${contrast.toFixed(3)}) saturate(${saturate.toFixed(3)}) hue-rotate(${hue.toFixed(1)}deg)`;
}

/** @param {Catalog} cat */
export function visiblePhotos(cat) {
  const tag = cat.filter.tag.trim().toLowerCase();
  return cat.photos.filter((p) => {
    if (p.rating < cat.filter.minRating) return false;
    if (tag && !p.tags.some((t) => t.toLowerCase().includes(tag))) return false;
    return true;
  });
}

/** @param {Catalog} cat @param {{ minRating?:number, tag?:string }} filter */
export function setFilter(cat, filter) {
  return { ...cat, filter: { ...cat.filter, ...filter } };
}

/** @param {Catalog} cat @param {string} photoId @param {(p:Photo)=>Photo} fn */
function mapPhoto(cat, photoId, fn) {
  return {
    ...cat,
    photos: cat.photos.map((p) => (p.id === photoId ? fn(p) : p)),
  };
}
