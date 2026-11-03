export const MAP_LOCALE_KEYS = Object.freeze({
  'Map.Title': 'map.label',
  'Marker.Title': 'map.marker',
  'LogoControl.Title': 'map.logo',
  'NavigationControl.ZoomIn': 'map.zoomIn',
  'NavigationControl.ZoomOut': 'map.zoomOut',
  'NavigationControl.ResetBearing': 'map.resetBearing',
  'GeolocateControl.FindMyLocation': 'map.findLocation',
  'GeolocateControl.LocationNotAvailable': 'map.locationUnavailable',
  'AttributionControl.ToggleAttribution': 'map.attributionToggle',
  'AttributionControl.MapFeedback': 'map.mapFeedback',
  'Popup.Close': 'map.closePopup',
  'CooperativeGesturesHandler.WindowsHelpText': 'map.gesturesWindows',
  'CooperativeGesturesHandler.MacHelpText': 'map.gesturesMac',
  'CooperativeGesturesHandler.MobileHelpText': 'map.gesturesMobile',
});
export function mapLocale(t) { return Object.fromEntries(Object.entries(MAP_LOCALE_KEYS).map(([native, key]) => [native, t(key)])); }
