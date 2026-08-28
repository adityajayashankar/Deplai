import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { defaultEnabledModules, looksLikePublicHttpUrl, modulesForScan } from './dastTarget';

describe('dast target helpers', () => {
  it('adds dast when a target URL is present', () => {
    const modules = modulesForScan(defaultEnabledModules(), 'https://staging.example.com');
    assert.equal(modules.includes('dast'), true);
  });

  it('does not add dast without a URL', () => {
    const modules = modulesForScan(defaultEnabledModules(), '   ');
    assert.equal(modules.includes('dast'), false);
  });

  it('rejects localhost and non-http URLs', () => {
    assert.equal(looksLikePublicHttpUrl('https://staging.example.com'), true);
    assert.equal(looksLikePublicHttpUrl('http://127.0.0.1/'), false);
    assert.equal(looksLikePublicHttpUrl('https://localhost/app'), false);
    assert.equal(looksLikePublicHttpUrl('ftp://example.com'), false);
  });
});
