// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { followShortLink, isShortLink, parseCoordinates, parseLocation } from '../../src/views/trip/places/parse.js';

describe('parseCoordinates', () => {
  it.each([
    ['48.8584, 2.2945', { lat: 48.8584, lng: 2.2945 }],
    ['48.8584,2.2945', { lat: 48.8584, lng: 2.2945 }],
    ['48.8584 2.2945', { lat: 48.8584, lng: 2.2945 }],
    ['(-33.8568, 151.2153)', { lat: -33.8568, lng: 151.2153 }],
    ['-33.8568; 151.2153', { lat: -33.8568, lng: 151.2153 }],
    ['48.8584° N, 2.2945° E', { lat: 48.8584, lng: 2.2945 }],
    ['N 48.8584, E 2.2945', { lat: 48.8584, lng: 2.2945 }],
    ['33.8568 S 151.2153 E', { lat: -33.8568, lng: 151.2153 }],
    ['2.2945 E, 48.8584 N', { lat: 48.8584, lng: 2.2945 }],
    ['48°51\'30.2"N 2°17\'40.2"E', { lat: 48.858389, lng: 2.294500 }],
    ['40°26′46″N 79°58′56″W', { lat: 40.446111, lng: -79.982222 }],
    ['48°51.5\'N, 2°17.7\'E', { lat: 48.858333, lng: 2.295 }],
    ['0.5, -0.5', { lat: 0.5, lng: -0.5 }],
  ])('reads %s', (text, expected) => {
    const result = parseCoordinates(text);
    expect(result.lat).toBeCloseTo(expected.lat, 5);
    expect(result.lng).toBeCloseTo(expected.lng, 5);
  });

  it.each([
    'coffee', '48, 2', '91.5, 2.3', '48.5, 181.2', '48.5', '48.5, 2.3, 4.1', '48.5 N, 2.3 N', '-48.5 S, 2.3',
    '48.5°60\'N 2.3E', '48.5\'N 2.3E', '21 Club', '',
  ])('refuses %s', (text) => {
    expect(parseCoordinates(text)).toBeNull();
  });
});

describe('parseLocation', () => {
  it('prefers the dropped pin in a Google place link over the viewport', () => {
    const link = 'https://www.google.com/maps/place/Eiffel+Tower/@48.8583701,2.2919064,17z/data=!3m1!4b1!4m6!3m5!1s0x0:0x0!8m2!3d48.8583701!4d2.2944813';
    expect(parseLocation(link)).toEqual({ lat: 48.85837, lng: 2.294481, name: 'Eiffel Tower' });
  });

  it.each([
    ['https://www.google.com/maps/place/Caf%C3%A9+de+Flore/@48.854,2.3325,17z', { lat: 48.854, lng: 2.3325, name: 'Café de Flore' }],
    ['https://www.google.com/maps/@48.8584,2.2945,15z', { lat: 48.8584, lng: 2.2945 }],
    ['https://maps.google.com/?q=48.8584,2.2945', { lat: 48.8584, lng: 2.2945 }],
    ['https://maps.google.co.uk/maps?ll=51.5,-0.12&q=Big+Ben', { lat: 51.5, lng: -0.12, name: 'Big Ben' }],
    ['https://www.google.com/maps/search/?api=1&query=47.5951518%2C-122.3316393', { lat: 47.595152, lng: -122.331639 }],
    ['https://www.google.com/maps/dir/?api=1&destination=40.7128,-74.006', { lat: 40.7128, lng: -74.006 }],
    ['https://www.google.com/maps/place/48.8584,2.2945/@48.8584,2.2945,17z', { lat: 48.8584, lng: 2.2945 }],
    ['google.com/maps/@35.6586,139.7454,16z', { lat: 35.6586, lng: 139.7454 }],
    ['https://www.openstreetmap.org/#map=17/48.85837/2.29448', { lat: 48.85837, lng: 2.29448 }],
    ['https://www.openstreetmap.org/?mlat=48.8584&mlon=2.2945#map=12/48.9/2.3', { lat: 48.8584, lng: 2.2945 }],
    ['https://www.openstreetmap.org/node/123456#map=18/41.40363/2.17436', { lat: 41.40363, lng: 2.17436 }],
    ['https://maps.apple.com/?ll=48.8584,2.2945&q=Eiffel%20Tower', { lat: 48.8584, lng: 2.2945, name: 'Eiffel Tower' }],
    ['https://maps.apple.com/place?coordinate=35.6586,139.7454&name=Tokyo%20Tower', { lat: 35.6586, lng: 139.7454, name: 'Tokyo Tower' }],
    ['https://www.waze.com/ul?ll=40.758,-73.9855&navigate=yes', { lat: 40.758, lng: -73.9855 }],
    ['https://www.waze.com/live-map/directions?to=ll.40.758%2C-73.9855', { lat: 40.758, lng: -73.9855 }],
    ['geo:37.786971,-122.399677;u=35', { lat: 37.786971, lng: -122.399677 }],
    ['geo:0,0?q=37.786971,-122.399677(Moscone)', { lat: 37.786971, lng: -122.399677, name: 'Moscone' }],
  ])('reads %s', (link, expected) => {
    expect(parseLocation(link)).toEqual(expected);
  });

  it.each([
    ['https://www.google.com/maps/search/coffee/@48.85,2.29,15z', { query: 'coffee' }],
    ['https://maps.google.com/?q=Eiffel+Tower', { query: 'Eiffel Tower' }],
    ['https://www.google.com/maps/search/?api=1&query=Pike%20Place%20Market', { query: 'Pike Place Market' }],
    ['https://www.openstreetmap.org/search?query=Sagrada%20Familia', { query: 'Sagrada Familia' }],
    ['https://maps.apple.com/?q=Golden+Gate+Bridge', { query: 'Golden Gate Bridge' }],
    ['geo:0,0?q=1600+Amphitheatre+Parkway', { query: '1600 Amphitheatre Parkway' }],
  ])('turns name-only links into a search: %s', (link, expected) => {
    expect(parseLocation(link)).toEqual(expected);
  });

  it('follows consent pages to the map link they wrap', () => {
    const wrapped = `https://consent.google.com/m?continue=${encodeURIComponent('https://www.google.com/maps/@48.8584,2.2945,15z')}`;
    expect(parseLocation(wrapped)).toEqual({ lat: 48.8584, lng: 2.2945 });
  });

  it('marks short links to follow and ignores everything else', () => {
    expect(parseLocation('https://maps.app.goo.gl/AbCdEf123')).toEqual({ short: 'https://maps.app.goo.gl/AbCdEf123' });
    expect(parseLocation('http://goo.gl/maps/xyz')).toEqual({ short: 'https://goo.gl/maps/xyz' });
    for (const text of ['https://goo.gl/other', 'https://example.com/maps/@48.8,2.2,10z', 'https://www.google.com/search?q=48.85,2.29', 'javascript:alert(1)', 'ftp://maps.google.com/?q=1.5,2.5', 'hello world', 'https://maps.app.goo.gl/']) {
      expect(parseLocation(text), text).toBeNull();
    }
    expect(isShortLink('http://maps.app.goo.gl/x')).toBe(false);
  });
});

describe('followShortLink', () => {
  const response = (location) => ({ headers: { get: (name) => (name === 'location' ? location : null) } });
  it('reads only the Location header, across hops', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(response('https://goo.gl/maps/next'))
      .mockResolvedValueOnce(response('https://www.google.com/maps/place/Louvre/@48.8606,2.3376,17z'));
    expect(await followShortLink('https://maps.app.goo.gl/abc', fetch)).toEqual({ lat: 48.8606, lng: 2.3376, name: 'Louvre' });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('gives up without a redirect or after three hops', async () => {
    expect(await followShortLink('https://maps.app.goo.gl/abc', async () => response(null))).toBeNull();
    expect(await followShortLink('https://maps.app.goo.gl/abc', async () => response('https://maps.app.goo.gl/loop'))).toBeNull();
  });
});
