import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  isTerminalTerraformApplyStatus,
  terraformApplyNeedsPolling,
  waitForTerraformApplyResult,
} from './terraform-apply-wait';

describe('terraform apply wait', () => {
  it('treats running/accepted apply responses as needing a poll', () => {
    assert.equal(terraformApplyNeedsPolling({ status: 'running' }), true);
    assert.equal(terraformApplyNeedsPolling({ status: 'accepted' }), true);
    assert.equal(terraformApplyNeedsPolling({ status: 'completed', success: true }), false);
    assert.equal(isTerminalTerraformApplyStatus('awaiting_plan_confirmation'), true);
    assert.equal(isTerminalTerraformApplyStatus('running'), false);
  });

  it('keeps polling through status fetch failures until apply completes', async () => {
    let calls = 0;
    const waited: number[] = [];
    const outcome = await waitForTerraformApplyResult({
      timeoutMs: 1_000,
      intervalMs: 1,
      sleepFn: async (ms) => {
        waited.push(ms);
      },
      fetchStatus: async () => {
        calls += 1;
        if (calls < 3) {
          throw new Error('fetch failed');
        }
        return {
          status: 'completed',
          result: { success: true, outputs: { vpc_id: 'vpc-1' } },
        };
      },
    });

    assert.equal(outcome.timedOut, false);
    assert.equal(outcome.status, 'completed');
    assert.equal(outcome.result?.success, true);
    assert.ok(calls >= 3);
    assert.ok(waited.length >= 2);
  });

    it('does not treat a running container_id snapshot as a completed apply', async () => {
      const outcome = await waitForTerraformApplyResult({
        timeoutMs: 20,
        intervalMs: 1,
        sleepFn: async () => {},
        fetchStatus: async () => ({ status: 'running', result: { container_id: 'abc' } }),
      });

      assert.equal(outcome.timedOut, true);
      assert.equal(outcome.status, 'running');
      assert.equal(outcome.result, null);
    });

    it('does not treat idle + container_id as a completed apply', async () => {
      const outcome = await waitForTerraformApplyResult({
        timeoutMs: 20,
        intervalMs: 1,
        sleepFn: async () => {},
        fetchStatus: async () => ({ status: 'idle', result: { container_id: 'abc' } }),
      });

      assert.equal(outcome.timedOut, true);
      assert.equal(outcome.status, 'idle');
    });

    it('completes when idle status carries real Terraform outputs', async () => {
      const outcome = await waitForTerraformApplyResult({
        timeoutMs: 200,
        intervalMs: 1,
        sleepFn: async () => {},
        fetchStatus: async () => ({
          status: 'idle',
          result: { success: true, outputs: { app_url: 'http://example.test' } },
        }),
      });

      assert.equal(outcome.timedOut, false);
      assert.equal(outcome.result?.success, true);
    });

    it('treats applying as still needing a poll', () => {
      assert.equal(terraformApplyNeedsPolling({ status: 'applying' }), true);
    });
});
