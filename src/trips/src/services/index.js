import { createServiceContext } from './core.js';
import { createGeocode } from './geocode.js';
import { createRoute } from './route.js';
import { planDay, routeDay } from './dayRoute.js';
import { createWeather } from './weather.js';
import { createFx } from './fx.js';
import { createHolidays } from './holidays.js';
import { createImages } from './images.js';
import { createPlaceInfo } from './placeInfo.js';
import { createAirports } from './airports.js';
import { createTimezone } from './tz.js';
import { createTiles } from './tiles.js';
import { createTransit } from './transit.js';
import { createFlights } from './flights.js';

export { dedupeResults, POI_CATEGORIES } from './geocode.js';
export { planDay, routeDay } from './dayRoute.js';
export { straightRoute, distance } from './route.js';
export { dailySummary, CONDITIONS } from './weather.js';
export { crossRate, freezeRate, rateString } from './fx.js';
export { openingStatus, parseOpeningHours } from './hours.js';

/** One instance per signed-in account; `keys(provider)` supplies the user's own API keys (ors, geoapify, unsplash, aerodatabox). */
export function createServices(options) {
  const context = createServiceContext(options);
  const tz = createTimezone(options);
  const route = createRoute(context);
  route.day = (input, opts = {}) => routeDay(route, planDay(input), opts);
  return {
    context, route, tz,
    geocode: createGeocode(context), weather: createWeather(context), fx: createFx(context), holidays: createHolidays(context), images: createImages(context),
    placeInfo: createPlaceInfo(context, { timezone: tz }), airports: createAirports(options),
    transit: createTransit(context), flights: createFlights(context),
    async tiles() { return createTiles(await context.loadConfig()); },
  };
}
