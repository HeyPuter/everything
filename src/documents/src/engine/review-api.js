// Review features' engine entry points, provided to views through the lazily loaded engine chunk.
export { protectionGuard, createPasswordVerifier, verifyPassword, hasPassword, permissionRanges, permissionApplies, originalText, ProtectionError } from './protection.js';
export { addPermissionRange, removePermissionRanges } from './permission-edits.js';
export { mergeDocuments, documentAuthor, finalText } from './compare.js';
export { contentControlRanges } from './content-controls.js';
export { describeFormatChange } from './revisions.js';
