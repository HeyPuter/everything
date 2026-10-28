// Writes watermarks.docx from fixture.js: node tests/fixtures/vml-watermarks/make-fixture.mjs
import { writeFileSync } from 'node:fs';
import { watermarkFixture } from './fixture.js';
writeFileSync(new URL('./watermarks.docx', import.meta.url), watermarkFixture());
