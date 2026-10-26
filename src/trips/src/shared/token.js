// Unverified decode of a Puter token's claims; identity is trusted only after Puter accepts the token itself.
// Tokens come in two shapes: the long form (`type`, `user_uid`, `app_uid`, `full_access`) and the compact `v: 2`
// form (`t`, `uu`, `au`, `su`), where ids are base64 of the 16 raw UUID bytes.

const BASE64_16 = /^[A-Za-z0-9+/]{22}==$/;
const base64 = (text) => (typeof atob === 'function' ? atob(text) : Buffer.from(text, 'base64').toString('binary'));
const uuidOf = (packed) => {
  if (typeof packed !== 'string' || !BASE64_16.test(packed)) return undefined;
  let hex = '';
  try { for (const char of base64(packed)) hex += char.charCodeAt(0).toString(16).padStart(2, '0'); } catch { return undefined; }
  return hex.length === 32 ? `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}` : undefined;
};

export function tokenClaims(token) {
  try {
    if (typeof token !== 'string' || token.length > 16_384) return {};
    const value = JSON.parse(base64(token.split('.')[1].replaceAll('-', '+').replaceAll('_', '/')));
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    if (Object.hasOwn(value, 't') && Object.hasOwn(value, 'type')) return {};
    const type = value.t === 't' ? 'access-token' : value.type;
    const user_uid = value.user_uid ?? uuidOf(value.uu);
    const app_uid = value.app_uid ?? uuidOf(value.au);
    return { ...value, type, ...(user_uid !== undefined ? { user_uid } : {}), ...(app_uid !== undefined ? { app_uid } : {}) };
  } catch { return {}; }
}
