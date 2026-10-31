/**
 * Route files to Everything office apps by extension.
 * Addresses the WPS-style "open almost every document" request (#31) on the web/PWA path.
 */

/** @type {{ id:string, title:string, blurb:string, url:string, extensions:string[] }[]} */
export const OFFICE_APPS = [
  {
    id: 'documents',
    title: 'Documents',
    blurb: 'Word-style documents (.docx and rich text in the Documents app).',
    url: 'https://documents.puter.com/',
    extensions: ['.docx', '.doc', '.odt', '.rtf', '.txt', '.md'],
  },
  {
    id: 'spreadsheet',
    title: 'Spreadsheet',
    blurb: 'Sheets / Excel-style workbooks.',
    url: 'https://spreadsheet.puter.com/',
    extensions: ['.xlsx', '.xls', '.ods', '.csv'],
  },
  {
    id: 'presentation',
    title: 'Presentation',
    blurb: 'Slides / PowerPoint-style decks.',
    url: 'https://presentation.puter.com/',
    extensions: ['.pptx', '.ppt', '.odp'],
  },
  {
    id: 'pdf',
    title: 'PDF',
    blurb: 'View and work with PDF files.',
    url: 'https://pdf.puter.com/',
    extensions: ['.pdf'],
  },
];

/**
 * @param {string} filename
 * @returns {typeof OFFICE_APPS[number] | null}
 */
export function routeFile(filename) {
  const lower = String(filename || '').toLowerCase();
  const dot = lower.lastIndexOf('.');
  if (dot < 0) return null;
  const ext = lower.slice(dot);
  return OFFICE_APPS.find((a) => a.extensions.includes(ext)) || null;
}

/** @param {string} filename */
export function suggestOpenUrl(filename) {
  const app = routeFile(filename);
  return app ? app.url : null;
}
