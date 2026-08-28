import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isPublicIpv4Address } from './net-guard';

describe('isPublicIpv4Address', () => {
  it('accepts public unicast addresses', () => {
    assert.equal(isPublicIpv4Address('1.1.1.1'), true);
    assert.equal(isPublicIpv4Address('8.8.8.8'), true);
  });

  it('rejects private, link-local, loopback, and metadata ranges', () => {
    assert.equal(isPublicIpv4Address('127.0.0.1'), false);
    assert.equal(isPublicIpv4Address('10.0.0.5'), false);
    assert.equal(isPublicIpv4Address('192.168.1.10'), false);
    assert.equal(isPublicIpv4Address('172.16.0.4'), false);
    assert.equal(isPublicIpv4Address('169.254.169.254'), false);
    assert.equal(isPublicIpv4Address('100.64.0.1'), false);
    assert.equal(isPublicIpv4Address('0.0.0.0'), false);
    assert.equal(isPublicIpv4Address('localhost'), false);
    assert.equal(isPublicIpv4Address('example.com'), false);
  });
});
