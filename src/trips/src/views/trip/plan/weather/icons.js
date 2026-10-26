import {
  createElement, Sun, Moon, CloudSun, CloudMoon, Cloud, CloudFog, CloudDrizzle, CloudRain, CloudHail, CloudSnow, CloudLightning,
  Sunrise, Sunset, Wind, Droplets, Umbrella, Thermometer, PartyPopper, School, TriangleAlert, MapPin,
} from 'lucide';

const ICONS = {
  clear: Sun, 'clear-night': Moon, partly: CloudSun, 'partly-night': CloudMoon, cloudy: Cloud, fog: CloudFog, drizzle: CloudDrizzle,
  rain: CloudRain, sleet: CloudHail, snow: CloudSnow, thunder: CloudLightning, unknown: Cloud,
  sunrise: Sunrise, sunset: Sunset, wind: Wind, droplets: Droplets, umbrella: Umbrella, typical: Thermometer,
  holiday: PartyPopper, school: School, warning: TriangleAlert, pin: MapPin,
};

export function wxIcon(name, size = 16) {
  return createElement(ICONS[name] ?? Cloud, { width: size, height: size, 'stroke-width': 1.8, 'aria-hidden': 'true', focusable: 'false', class: 'icon' });
}
/** The condition icon, with night variants for clear and partly cloudy periods. */
export function conditionIcon(condition, { night = false, size = 16 } = {}) {
  const name = condition && Object.hasOwn(ICONS, condition) ? condition : 'unknown';
  return wxIcon(night && (name === 'clear' || name === 'partly') ? `${name}-night` : name, size);
}
