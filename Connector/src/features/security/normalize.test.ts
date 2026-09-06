import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseModuleEvents } from './normalize';

test('terminal tool activity preserves earlier process evidence', () => {
  const messages = [
    { module: 'sca', status: 'RUNNING', container_id: 'container-123', image_id: 'sha256:engine' },
    { module: 'sca', status: 'COMPLETED', report_ref: 'run-Grype.json', report_validated: true, exit_code: 0 },
  ].map((payload, index) => ({ index, total: 2, type: 'module', content: JSON.stringify(payload), timestamp: '' }));
  const tool = parseModuleEvents(messages).sca;
  assert.equal(tool?.container_id, 'container-123');
  assert.equal(tool?.image_id, 'sha256:engine');
  assert.equal(tool?.report_validated, true);
  assert.equal(tool?.status, 'COMPLETED');
});
