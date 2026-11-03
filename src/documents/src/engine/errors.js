const NOTICE = /^This document contains ([\s\S]*), which this first editor version cannot edit yet\. The original file has not been changed\.$/;
export class UnsupportedDocumentError extends Error {
  constructor(feature) {
    // A reason kept as text (a style or list definition's error) and raised again names its feature once.
    for (let match; typeof feature === 'string' && (match = NOTICE.exec(feature));) feature = match[1];
    super(`This document contains ${feature}, which this first editor version cannot edit yet. The original file has not been changed.`);
    this.name = 'UnsupportedDocumentError';
    this.feature = feature;
  }
}

/** A package part that is not well-formed XML, or not in an encoding XML parts may use (UTF-8 or UTF-16). */
export class InvalidXmlError extends Error {
  constructor(message = 'The DOCX contains invalid XML.', reason = 'invalid XML') {
    super(message);
    this.name = 'InvalidXmlError';
    this.reason = reason;
  }
}
