const reserved = new Set(['__proto__', 'constructor', 'prototype']);
const anchors = new Set(['center', 'left', 'right', 'top', 'bottom', 'top-left', 'top-right', 'bottom-left', 'bottom-right']);
export function textLabel(value, language = 'en') {
  if (typeof value === 'number' && Number.isFinite(value)) return new Intl.NumberFormat(language).format(value);
  if (typeof value !== 'string') return '';
  return [...value.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, ' ')].slice(0, 300).join('');
}
export function labelOptions(options = {}) {
  const textProperty = options.textProperty ?? 'title';
  if (typeof textProperty !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(textProperty) || reserved.has(textProperty)) throw new RangeError('Invalid label property');
  const textSize = options.textSize ?? 12, haloWidth = options.haloWidth ?? 1.5;
  const anchor = options.anchor ?? 'center', placement = options.placement ?? 'point';
  const offset = options.offset ?? [0, 0], font = options.font ?? ['Noto Sans Regular'];
  if (!Number.isFinite(textSize) || textSize < 8 || textSize > 40 || !Number.isFinite(haloWidth) || haloWidth < 0 || haloWidth > 4 || !anchors.has(anchor) || !['point', 'line', 'line-center'].includes(placement)) throw new RangeError('Invalid label style');
  if (!Array.isArray(offset) || offset.length !== 2 || offset.some(value => !Number.isFinite(value) || Math.abs(value) > 10)) throw new RangeError('Invalid label offset');
  if (!Array.isArray(font) || !font.length || font.length > 3 || font.some(value => typeof value !== 'string' || !value || value.length > 100)) throw new RangeError('Invalid label font');
  if (options.allowOverlap !== undefined && typeof options.allowOverlap !== 'boolean') throw new RangeError('Invalid label overlap');
  return { ...options, textProperty, textSize, haloWidth, anchor, placement, offset: [...offset], font: [...font], allowOverlap: options.allowOverlap ?? false };
}
export function prepareLabels(data, options, language) {
  const allowed = options.placement === 'point' ? ['Point', 'MultiPoint'] : ['LineString', 'MultiLineString'];
  for (const feature of data.features) {
    if (!allowed.includes(feature.geometry.type)) throw new RangeError('Label placement does not match geometry');
    const properties = feature.properties ?? {};
    feature.properties = { ...properties, __trips_label: textLabel(Object.hasOwn(properties, options.textProperty) ? properties[options.textProperty] : undefined, language) };
  }
  return data;
}
