import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { decryptApiToken, encryptApiToken, generateApiToken, hashApiToken } from './crypto';
import {
  MAX_EFFICIENT_POOL,
  creditTone,
  formatCreditUsd,
  initialsFromName,
  maskApiToken,
  normalizeGithubUrl,
  normalizeLinkedinUrl,
  referralCodeFromUserId,
  routingModeById,
  validateCustomCreditUsd,
  validateEfficientPool,
  validateProfilePatch,
  validatePromoCode,
} from './logic';

describe('profile logic', () => {
  it('masks API tokens without exposing the secret', () => {
    const token = 'dpl_live_abcdefghijklmnopqrstuvwxyz012345';
    const masked = maskApiToken(token);
    assert.equal(masked.includes('abcdefghijklmnopqrstuvwxyz'), false);
    assert.equal(masked.startsWith('dpl_live'), true);
    assert.equal(masked.endsWith('2345'), true);
  });

  it('validates profile fields and social URLs', () => {
    const invalid = validateProfilePatch({ displayName: '', email: 'nope', linkedinUrl: 'https://example.com', githubUrl: 'not a url' });
    assert.equal(invalid.ok, false);
    const valid = validateProfilePatch({
      displayName: 'Aditya J',
      email: 'aj@example.com',
      linkedinUrl: 'https://www.linkedin.com/in/aditya',
      githubUrl: 'aj-dev',
    });
    assert.equal(valid.ok, true);
    if (valid.ok) {
      assert.equal(valid.value.githubUrl, 'https://github.com/aj-dev');
    }
    assert.equal(normalizeLinkedinUrl(''), '');
    assert.equal(normalizeGithubUrl('https://github.com/deplai'), 'https://github.com/deplai');
  });

  it('enforces the 10-model efficient pool cap', () => {
    const tooMany = Array.from({ length: MAX_EFFICIENT_POOL + 1 }, (_, index) => ({
      modelId: `openai:model-${index}`,
      variant: 'default',
    }));
    const rejected = validateEfficientPool(tooMany);
    assert.equal(rejected.ok, false);
    const accepted = validateEfficientPool(tooMany.slice(0, MAX_EFFICIENT_POOL));
    assert.equal(accepted.ok, true);
  });

  it('validates custom credit amounts and promo codes', () => {
    assert.equal(validateCustomCreditUsd(4).ok, false);
    assert.equal(validateCustomCreditUsd(20).ok, true);
    assert.equal(validatePromoCode('').ok, false);
    const promo = validatePromoCode(' launch-50 ');
    assert.equal(promo.ok, true);
    if (promo.ok) assert.equal(promo.code, 'LAUNCH-50');
  });

  it('formats credit balances and routing defaults', () => {
    assert.equal(formatCreditUsd(-0.13).startsWith('-'), true);
    assert.equal(creditTone(-1), 'negative');
    assert.equal(creditTone(0.2), 'warning');
    assert.equal(routingModeById('default').primaryAlias, 'best_cost');
    assert.equal(initialsFromName('Aditya J'), 'AJ');
    assert.equal(referralCodeFromUserId('14b398d3-cb65-4abc').startsWith('DPL'), true);
  });

  it('encrypts API tokens round-trip without using localStorage', () => {
    const token = generateApiToken();
    assert.equal(token.startsWith('dpl_live_'), true);
    const encrypted = encryptApiToken(token);
    assert.notEqual(encrypted, token);
    assert.equal(decryptApiToken(encrypted), token);
    assert.equal(hashApiToken(token).length, 64);
  });
});
