import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseModuleEvents, pipelineModulesSettled, pipelineProducedWork } from './normalize';
import type { ScanMessage } from '@/lib/scan-context';

function moduleMessage(module: string, status: string): ScanMessage {
  return {
    index: 1,
    total: 1,
    type: 'module',
    content: JSON.stringify({ module, status }),
    timestamp: new Date().toISOString(),
  };
}

describe('pipeline progress helpers', () => {
  it('does not treat queued modules as finished work', () => {
    const live = parseModuleEvents([
      moduleMessage('sast', 'QUEUED'),
      moduleMessage('containers', 'QUEUED'),
    ]);
    assert.equal(pipelineProducedWork(live), false);
    assert.equal(pipelineModulesSettled(live), false);
  });

  it('unlocks after a finished run that includes a failed module', () => {
    const live = parseModuleEvents([
      moduleMessage('sast', 'COMPLETED'),
      moduleMessage('sca', 'COMPLETED'),
      moduleMessage('sbom', 'COMPLETED'),
      moduleMessage('secrets', 'COMPLETED'),
      moduleMessage('iac', 'SKIPPED'),
      moduleMessage('containers', 'FAILED'),
    ]);
    assert.equal(pipelineProducedWork(live), true);
    assert.equal(pipelineModulesSettled(live), true);
  });

  it('stays unsettled while any module is still running', () => {
    const live = parseModuleEvents([
      moduleMessage('sast', 'RUNNING'),
      moduleMessage('containers', 'FAILED'),
    ]);
    assert.equal(pipelineProducedWork(live), true);
    assert.equal(pipelineModulesSettled(live), false);
  });

  it('treats dast skipped as a terminal module when other work finished', () => {
    const live = parseModuleEvents([
      moduleMessage('sast', 'COMPLETED'),
      moduleMessage('dast', 'SKIPPED'),
    ]);
    assert.equal(pipelineProducedWork(live), true);
    assert.equal(pipelineModulesSettled(live), true);
  });
});

describe('unique finding ids', () => {
  it('keeps the first id and suffixes later collisions', async () => {
    const { uniqueFindingIds, findingRenderKey } = await import('./normalize');
    const findings = uniqueFindingIds([
      { id: 'sca:GHSA-43fc-jf86-j433:axios:0.26.1' },
      { id: 'sca:GHSA-43fc-jf86-j433:axios:0.26.1' },
      { id: 'sast:cwe-79:app.js:12:0' },
    ]);
    assert.deepEqual(findings.map((item) => item.id), [
      'sca:GHSA-43fc-jf86-j433:axios:0.26.1',
      'sca:GHSA-43fc-jf86-j433:axios:0.26.1#1',
      'sast:cwe-79:app.js:12:0',
    ]);
    assert.equal(
      findingRenderKey(findings[1], 1),
      'sca:GHSA-43fc-jf86-j433:axios:0.26.1#1::1',
    );
  });
});

describe('scoped pipeline display', () => {
  it('queues only the scoped module while a dast-only scan is running', async () => {
    const { mergeModules } = await import('./normalize');
    const modules = mergeModules(undefined, {}, { scanning: true, scopedTo: ['dast'] });
    assert.deepEqual(modules.map((item) => item.id), ['dast']);
    assert.equal(modules[0].status, 'QUEUED');
  });
});
