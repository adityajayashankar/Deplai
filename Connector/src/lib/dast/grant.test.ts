import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { hostsEqual, hostnameInScope, isHostnameInDomain } from './scope';
import { canonicalGrant, issueGrant, signGrant, verifyGrant } from './grant';

describe('dast hostname scope', () => {
  it('matches subdomains without suffix confusion', () => {
    assert.equal(isHostnameInDomain('app.example.com', 'example.com'), true);
    assert.equal(isHostnameInDomain('evil-example.com', 'example.com'), false);
    assert.equal(isHostnameInDomain('example.com.attacker.com', 'example.com'), false);
    assert.equal(hostsEqual('APP.example.com', 'app.example.com'), true);
    assert.equal(hostnameInScope('admin.example.com', 'app.example.com', 'VERIFIED_HOST'), false);
    assert.equal(hostnameInScope('app.example.com', 'example.com', 'VERIFIED_DOMAIN'), true);
  });
});

describe('dast grant hmac', () => {
  it('signs and verifies a canonical grant', () => {
    process.env.DAST_AUTHZ_SECRET = 'unit-test-secret';
    const grant = issueGrant({
      assetId: 'asset-1',
      projectId: 'proj-1',
      hostname: 'app.example.com',
      scopeMode: 'VERIFIED_HOST',
      verificationExpiresAt: '2026-11-25T00:00:00Z',
      verificationMethod: 'DNS_TXT',
      scheme: 'https',
    });
    assert.equal(verifyGrant(grant), true);
    const tampered = { ...grant, hostname: 'google.com' };
    tampered.signature = grant.signature;
    assert.equal(verifyGrant(tampered), false);
    assert.equal(canonicalGrant(grant).includes('google.com'), false);
    assert.equal(signGrant(grant).length, 64);
  });
});
