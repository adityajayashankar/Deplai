import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveDeploymentStatusTarget } from './status-target';

describe('resolveDeploymentStatusTarget', () => {
  it('keeps a runtime apply on the project-scoped runtime status endpoint', () => {
    assert.equal(
      resolveDeploymentStatusTarget({ runId: 'generated-iac-run', mode: 'runtime_apply' }),
      'runtime_apply',
    );
  });

  it('preserves the legacy IaC run-id status lookup', () => {
    assert.equal(resolveDeploymentStatusTarget({ runId: 'generated-iac-run', mode: 'iac_pipeline' }), 'iac_pipeline');
    assert.equal(resolveDeploymentStatusTarget({ runId: 'generated-iac-run' }), 'iac_pipeline');
  });

  it('uses runtime status when no IaC run exists', () => {
    assert.equal(resolveDeploymentStatusTarget({}), 'runtime_apply');
  });
});
