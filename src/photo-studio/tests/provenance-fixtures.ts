// Shared fixtures of the provenance codec tests.
import { addAI, addSource, addStep, newProvenanceRecord, type ProvenanceRecord } from '../src/model/provenance';

export const NOW = new Date('2026-01-02T03:04:05Z');

export function sampleRecord(): ProvenanceRecord {
  const r = newProvenanceRecord('opened', NOW);
  r.id = '11111111-2222-4333-8444-555555555555';
  addSource(r, { name: 'beach.jpg', format: 'jpeg', sha256: 'a'.repeat(64), size: 1234, when: NOW.toISOString(), role: 'opened' });
  addSource(r, { name: 'logo.png', format: 'png', sha256: 'b'.repeat(64), size: 99, when: '2026-01-02T03:05:00.000Z', role: 'placed' });
  addStep(r, { label: 'Brush Tool', tool: 'brush', when: '2026-01-02T03:06:00.000Z' });
  addStep(r, { label: 'Brush Tool', tool: 'brush', when: '2026-01-02T03:06:30.000Z' });
  addStep(r, { label: 'Gaussian Blur', command: 'filter.gaussian-blur', when: '2026-01-02T03:07:00.000Z' });
  addAI(r, { command: 'edit.generate-image', kind: 'generate', when: '2026-01-02T03:08:00.000Z', prompt: 'a red kite' });
  return r;
}
