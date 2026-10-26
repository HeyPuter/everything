/** Native geolocation stays one-shot and starts only from a trusted button click. */
export function createGeolocationControl(library, { onLocation = () => {}, onError = () => {} } = {}) {
  if (!library.GeolocateControl) return null;
  const native = new library.GeolocateControl({ positionOptions: { enableHighAccuracy: false, timeout: 6000, maximumAge: 60_000 }, trackUserLocation: false, showUserLocation: true, showAccuracyCircle: true });
  let element;
  const trustedClick = event => { if (!event.isTrusted) event.stopImmediatePropagation(); };
  native.on('geolocate', onLocation); native.on('error', onError);
  return {
    onAdd(map) { element = native.onAdd(map); element.addEventListener('click', trustedClick, true); return element; },
    onRemove() { element?.removeEventListener('click', trustedClick, true); native.off('geolocate', onLocation); native.off('error', onError); native.onRemove(); element = null; },
  };
}
