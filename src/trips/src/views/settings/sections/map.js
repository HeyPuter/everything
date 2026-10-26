import { el } from '../../../ui/dom.js';
import { t } from '../../../lib/i18n/index.js';
import { group, prefChoice, prefSwitch, keepInSync, statusLine } from '../ui.js';

export function render(container, { signal }) {
  const style = prefChoice('mapStyle', t('settings.mapStyle'), [
    { value: 'auto', label: t('settings.mapAuto'), hint: t('settings.mapAutoHint') },
    { value: 'light', label: t('settings.mapLight') },
    { value: 'dark', label: t('settings.mapDark') },
    { value: 'satellite', label: t('settings.mapSatellite'), hint: t('settings.mapSatelliteHint') },
  ], { cards: true, bare: true });
  const layers = [
    prefSwitch('mapPlaceLabels', t('settings.mapPlaceLabels'), t('settings.mapPlaceLabelsHint')),
    prefSwitch('mapEndpointLabels', t('settings.mapEndpointLabels'), t('settings.mapEndpointLabelsHint')),
    prefSwitch('mapExplorePills', t('settings.mapExplorePills'), t('settings.mapExplorePillsHint')),
  ];
  const routes = [
    prefSwitch('mapAlwaysRoutes', t('settings.mapAlwaysRoutes'), t('settings.mapAlwaysRoutesHint')),
    prefSwitch('mapOptimizeFromHotel', t('settings.mapOptimizeFromHotel'), t('settings.mapOptimizeFromHotelHint')),
  ];
  keepInSync([style, ...layers, ...routes], signal);
  container.replaceChildren(el('div.settings-stack', {},
    group(t('settings.mapStyle'), style.node),
    group(t('settings.mapLayers'), ...layers.map((control) => control.node)),
    group(t('settings.mapRoutes'), ...routes.map((control) => control.node)),
    statusLine(signal)));
}
