// Application resource ceiling, measured in the editor's UTF-16 positions.
// Shared by import, mutations and search so a loaded document remains editable.
export const MAX_DOCUMENT_CHARACTERS = 5_000_000;
export const DOCUMENT_CHARACTER_LIMIT_MESSAGE = 'This editor currently supports up to 5,000,000 characters.';

/**
 * Text kept in an XML attribute, such as alternative text and object names: line breaks (CR, CR LF,
 * the vertical tab of a pasted line break, form feed) become line feeds, and characters XML 1.0
 * cannot hold are dropped, so a description pasted from a document never makes the file unreadable.
 */
export const xmlAttributeText = text => String(text ?? '').replace(/\r\n?|[\v\f]/g, '\n').replace(/[\u0000-\u0008\u000e-\u001f\ufffe\uffff]/g, '');
