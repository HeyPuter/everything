// Inline stroke icons (Lucide-style, 24x24, currentColor). Returned as markup
// strings so they can be dropped straight into template literals.
const P =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'

const RAW = {
  search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  star: '<path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8L3.5 9.7l5.9-.9z"/>',
  starFilled:
    '<path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8L3.5 9.7l5.9-.9z" fill="currentColor" stroke="none"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>',
  phone:
    '<path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18 14 14 0 0 1 0-18z"/>',
  mapPin: '<path d="M12 21s7-5.5 7-11a7 7 0 1 0-14 0c0 5.5 7 11 7 11z"/><circle cx="12" cy="10" r="2.5"/>',
  cake: '<path d="M4 20h16M5 20v-7a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v7M4 14c1.5 0 1.5 1.2 3 1.2S9.5 14 11 14s1.5 1.2 3 1.2 1.5-1.2 3-1.2M12 8V5m0 0 1-1.5M12 5l-1-1.5"/>',
  calendar:
    '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  note: '<path d="M5 3h9l5 5v13a0 0 0 0 1 0 0H5a0 0 0 0 1 0 0z"/><path d="M14 3v5h5M8 13h8M8 17h6"/>',
  tag: '<path d="M3 7v5l9 9 7-7-9-9H4a1 1 0 0 0-1 1z"/><circle cx="7.5" cy="7.5" r="1.5"/>',
  building:
    '<rect x="5" y="3" width="14" height="18" rx="1.5"/><path d="M9 7h2M13 7h2M9 11h2M13 11h2M9 15h2M13 15h2M9 21v-3h6v3"/>',
  user: '<circle cx="12" cy="8.5" r="3.5"/><path d="M5 20c0-4 3-6 7-6s7 2 7 6"/>',
  more: '<circle cx="12" cy="5" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="12" cy="19" r="1.4"/>',
  trash: '<path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13M10 11v6M14 11v6"/>',
  edit: '<path d="M4 20h4L19 9a2 2 0 0 0-3-3L5 17z"/><path d="M14 6l4 4"/>',
  download: '<path d="M12 3v12m0 0 4-4m-4 4-4-4M5 21h14"/>',
  upload: '<path d="M12 21V9m0 0 4 4m-4-4-4 4M5 3h14"/>',
  sparkles:
    '<path d="M12 3l1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6zM19 14l.8 2.2L22 17l-2.2.8L19 20l-.8-2.2L16 17l2.2-.8z"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  check: '<path d="M5 12.5 10 17l9-10"/>',
  minus: '<path d="M6 12h12"/>',
  back: '<path d="M15 5l-7 7 7 7"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4 12H2M22 12h-2M5 5l1.5 1.5M17.5 17.5 19 19M19 5l-1.5 1.5M6.5 17.5 5 19"/>',
  moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4a7 7 0 1 0 10.5 10.5z"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/>',
  logout: '<path d="M9 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h3M16 16l4-4-4-4M20 12H9"/>',
  settings:
    '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
  contacts:
    '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M4 8H2M4 12H2M4 16H2"/><circle cx="12" cy="10" r="2.5"/><path d="M8.5 17c.6-2 1.8-3 3.5-3s2.9 1 3.5 3"/>',
  github:
    '<path d="M9 19c-4 1.5-4-2-6-2.5m12 4.5v-3.5c0-1 .1-1.4-.5-2 2.8-.3 5.5-1.4 5.5-6a4.6 4.6 0 0 0-1.3-3.2 4.3 4.3 0 0 0-.1-3.2s-1-.3-3.4 1.3a11.7 11.7 0 0 0-6 0C6.3 2.9 5.3 3.2 5.3 3.2a4.3 4.3 0 0 0-.1 3.2A4.6 4.6 0 0 0 3.9 9.6c0 4.6 2.7 5.7 5.5 6-.4.4-.5.9-.5 1.6V21"/>',
}

export const icons = Object.fromEntries(
  Object.entries(RAW).map(([name, body]) => [name, `${P}${body}</svg>`]),
)

/** Return an icon as a base64 data URI (for puter.ui.contextMenu icons). */
export function iconDataUri(name, color = '#1a1d24') {
  const svg = (icons[name] || '').replace('stroke="currentColor"', `stroke="${color}"`)
  return 'data:image/svg+xml;base64,' + btoa(svg)
}
