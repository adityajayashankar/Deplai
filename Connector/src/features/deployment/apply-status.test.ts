import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  APPLY_TIMEOUT_MESSAGE,
  APPLY_UNREACHABLE_MESSAGE,
  applyLooksInFlight,
  classifyUpstreamError,
  isApplyStillRunningResponse,
  isRecoverableApplyTransportError,
  isTransportFalseFailureMessage,
  mergeAcceptedApplyResult,
} from './apply-status';

describe('classifyUpstreamError', () => {
  it('maps TimeoutError on fetch cause to timeout, not unreachable', () => {
    const cause = new Error('The operation was aborted due to timeout');
    cause.name = 'TimeoutError';
    const err = new TypeError('fetch failed');
    (err as Error & { cause: Error }).cause = cause;
    const classified = classifyUpstreamError(err);
    assert.equal(classified.error, APPLY_TIMEOUT_MESSAGE);
    assert.notEqual(classified.error, APPLY_UNREACHABLE_MESSAGE);
  });

  it('maps a plain fetch failed / connection refused to unreachable', () => {
    const classified = classifyUpstreamError(new TypeError('fetch failed'));
    assert.equal(classified.error, APPLY_UNREACHABLE_MESSAGE);
  });
});

describe('apply still-running / recoverable transport', () => {
  it('treats 202 apply_accepted as still running', () => {
    assert.equal(
      isApplyStillRunningResponse(202, {
        success: true,
        status: 'running',
        apply_accepted: true,
        details: { apply_still_running: true },
      }),
      true,
    );
  });

  it('treats 504 still-running payloads as recoverable', () => {
    assert.equal(
      isRecoverableApplyTransportError(504, {
        error: 'Terraform apply is still running. Multi-AZ RDS often takes 15–25 minutes',
        status: 'running',
        details: { apply_still_running: true },
      }),
      true,
    );
  });

  it('treats dropped browser fetch as recoverable', () => {
    assert.equal(
      isRecoverableApplyTransportError(0, null, 'Connector could not reach the deployment runtime service.'),
      true,
    );
    assert.equal(
      isRecoverableApplyTransportError(0, { error: APPLY_UNREACHABLE_MESSAGE }, ''),
      true,
    );
  });

  it('does not treat a real terraform failure as recoverable', () => {
    assert.equal(
      isRecoverableApplyTransportError(200, {
        success: false,
        error: 'apply failed: InvalidParameterValue',
      }),
      false,
    );
  });
});

describe('isTransportFalseFailureMessage', () => {
  it('recognizes connector transport gaps that are not real apply failures', () => {
    assert.equal(isTransportFalseFailureMessage(APPLY_UNREACHABLE_MESSAGE), true);
    assert.equal(isTransportFalseFailureMessage('Terraform apply is still running. Multi-AZ RDS often takes 15–25 minutes'), true);
    assert.equal(isTransportFalseFailureMessage('apply failed: InvalidParameterValue'), false);
  });
});

describe('applyLooksInFlight / mergeAcceptedApplyResult', () => {
  it('clears transport errors when marking apply accepted', () => {
    const merged = mergeAcceptedApplyResult(
      { success: false, error: APPLY_UNREACHABLE_MESSAGE, status: 'error' },
      { success: true, status: 'running' },
    );
    assert.equal(merged.success, true);
    assert.equal(merged.apply_accepted, true);
    assert.equal(merged.error, undefined);
    assert.equal(applyLooksInFlight(merged), true);
  });
});
