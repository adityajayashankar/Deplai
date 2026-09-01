import assert from 'node:assert/strict';
import { describe, it, beforeEach, afterEach } from 'node:test';
import {
  readRemediationModelPreference,
  remediationModelStorageKey,
  storeRemediationModelPreference,
} from '@/features/security/remediationModelPreference';

describe('remediationModelPreference', () => {
  const projectId = 'project-test-123';
  const storage = new Map<string, string>();

  beforeEach(() => {
    storage.clear();
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: globalThis,
    });
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => {
          storage.set(key, value);
        },
        removeItem: (key: string) => {
          storage.delete(key);
        },
      },
    });
  });

  afterEach(() => {
    Reflect.deleteProperty(globalThis, 'localStorage');
    Reflect.deleteProperty(globalThis, 'window');
  });

  it('stores and reads a remediation model preference per project', () => {
    storeRemediationModelPreference(projectId, {
      accessMode: 'byok',
      model: 'claude-sonnet-5',
      provider: 'anthropic',
      credentialId: 'cred-1',
    });

    const saved = readRemediationModelPreference(projectId);
    assert.deepEqual(saved, {
      accessMode: 'byok',
      model: 'claude-sonnet-5',
      provider: 'anthropic',
      credentialId: 'cred-1',
    });
    assert.equal(storage.get(remediationModelStorageKey(projectId))?.includes('cred-1'), true);
  });

  it('returns null for invalid stored payloads', () => {
    storage.set(remediationModelStorageKey(projectId), JSON.stringify({ accessMode: 'invalid', model: '' }));
    assert.equal(readRemediationModelPreference(projectId), null);
  });
});
