// Country-aware address layout (pure). Each format declares which fields to
// show, how to lay them out, and country-specific labels / dropdown options.
import { countryName } from './countries.js'

export const ADDRESS_FIELDS = ['country', 'street', 'street2', 'city', 'state', 'postalCode', 'poBox']

export const ADDRESS_FIELD_LABELS = {
  street: 'Street address',
  street2: 'Street address line 2',
  city: 'City',
  state: 'State',
  postalCode: 'Postal code',
  poBox: 'PO box',
}

const US_STATES = [
  'Alabama', 'Alaska', 'Arizona', 'Arkansas', 'California', 'Colorado', 'Connecticut',
  'Delaware', 'District of Columbia', 'Florida', 'Georgia', 'Hawaii', 'Idaho', 'Illinois',
  'Indiana', 'Iowa', 'Kansas', 'Kentucky', 'Louisiana', 'Maine', 'Maryland', 'Massachusetts',
  'Michigan', 'Minnesota', 'Mississippi', 'Missouri', 'Montana', 'Nebraska', 'Nevada',
  'New Hampshire', 'New Jersey', 'New Mexico', 'New York', 'North Carolina', 'North Dakota',
  'Ohio', 'Oklahoma', 'Oregon', 'Pennsylvania', 'Rhode Island', 'South Carolina',
  'South Dakota', 'Tennessee', 'Texas', 'Utah', 'Vermont', 'Virginia', 'Washington',
  'West Virginia', 'Wisconsin', 'Wyoming',
]
const CA_PROVINCES = [
  'Alberta', 'British Columbia', 'Manitoba', 'New Brunswick', 'Newfoundland and Labrador',
  'Northwest Territories', 'Nova Scotia', 'Nunavut', 'Ontario', 'Prince Edward Island',
  'Quebec', 'Saskatchewan', 'Yukon',
]
const AU_STATES = [
  'Australian Capital Territory', 'New South Wales', 'Northern Territory', 'Queensland',
  'South Australia', 'Tasmania', 'Victoria', 'Western Australia',
]
const AE_EMIRATES = [
  'Abu Dhabi', 'Ajman', 'Dubai', 'Fujairah', 'Ras Al Khaimah', 'Sharjah', 'Umm Al Quwain',
]

// rows: ordered groups of field keys (a row with two keys renders side-by-side)
const FORMATS = {
  US: {
    rows: [['street'], ['street2'], ['city'], ['state', 'postalCode'], ['poBox']],
    labels: { state: 'State', postalCode: 'ZIP code' },
    states: US_STATES,
  },
  CA: {
    rows: [['street'], ['street2'], ['city'], ['state', 'postalCode'], ['poBox']],
    labels: { state: 'Province', postalCode: 'Postal code' },
    states: CA_PROVINCES,
  },
  AU: {
    rows: [['street'], ['street2'], ['city'], ['state', 'postalCode'], ['poBox']],
    labels: { state: 'State/Territory', postalCode: 'Postcode', city: 'City/Suburb' },
    states: AU_STATES,
  },
  AE: {
    rows: [['street'], ['street2'], ['state'], ['poBox']],
    labels: { state: 'Emirate' },
    states: AE_EMIRATES,
  },
  GB: {
    rows: [['street'], ['street2'], ['city'], ['state'], ['postalCode'], ['poBox']],
    labels: { state: 'County', postalCode: 'Postcode', city: 'Town/City' },
  },
  IN: {
    rows: [['street'], ['street2'], ['city'], ['state', 'postalCode'], ['poBox']],
    labels: { state: 'State', postalCode: 'PIN code' },
  },
  DE: {
    rows: [['street'], ['street2'], ['postalCode', 'city'], ['poBox']],
    labels: { postalCode: 'Postal code' },
  },
  DEFAULT: {
    rows: [['street'], ['street2'], ['city'], ['state', 'postalCode'], ['poBox']],
    labels: { state: 'State/Province/Region', postalCode: 'Postal code' },
  },
}
// Several countries share Germany's "postal code then city, no region" layout.
FORMATS.FR = FORMATS.DE
FORMATS.ES = FORMATS.DE
FORMATS.IT = FORMATS.DE
FORMATS.NL = FORMATS.DE

/** The address format descriptor for a country code (DEFAULT if unknown). */
export function addressFormat(code) {
  return FORMATS[code] || FORMATS.DEFAULT
}

/** Label to show for a field within a given format. */
export function fieldLabel(format, key) {
  return (format.labels && format.labels[key]) || ADDRESS_FIELD_LABELS[key] || ''
}

/** Build the city / postal / region line using the country's form field order. */
function formatLocalityLine(addr, format) {
  // When postal code and city share a form row (DE/FR/ES/IT/NL), keep that order
  // with a space: "10117 Berlin" rather than the US-style "Berlin, 10117".
  const cityPostalRow = (format.rows || []).find(
    (row) => row.includes('city') && row.includes('postalCode'),
  )
  if (cityPostalRow) {
    return cityPostalRow
      .filter((k) => k === 'city' || k === 'state' || k === 'postalCode')
      .map((k) => addr[k])
      .filter(Boolean)
      .join(' ')
  }
  const region = [addr.state, addr.postalCode].filter(Boolean).join(' ')
  return [addr.city, region].filter(Boolean).join(', ')
}

/** Render an address as display lines (street, city/region, PO box, country). */
export function formatAddressLines(addr) {
  if (!addr) return []
  const lines = []
  if (addr.street) lines.push(addr.street)
  if (addr.street2) lines.push(addr.street2)
  const cityLine = formatLocalityLine(addr, addressFormat(addr.country))
  if (cityLine) lines.push(cityLine)
  if (addr.poBox) lines.push(`PO Box ${addr.poBox}`)
  const cn = countryName(addr.country)
  if (cn) lines.push(cn)
  return lines
}

/** True when an address has no meaningful content (country/label alone don't count). */
export function isEmptyAddress(a) {
  return !a || !(a.street || a.street2 || a.city || a.state || a.postalCode || a.poBox)
}
