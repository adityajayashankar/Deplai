import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildReferralShareMessage,
  computeReferralDiscountPaise,
  computeReferrerRewardCredits,
  isAttributionActive,
  maskEmail,
  normalizeReferralCode,
  referrerCanAcceptMore,
  referrerSlotsRemaining,
  validateReferralCodeFormat,
} from './logic';
import { getReferralProgramConfig } from './config';
import {
  REFERRAL_CODE_MAX_LENGTH,
  generateReferralCode,
  isLegacyReferralCode,
  isModernReferralCode,
  isRecognizedReferralCode,
  referralTagFromIdentity,
  verifyReferralCodeMatchesUser,
} from './codes';
import { REFERRAL_ATTRIBUTION_CODE_MAX_LENGTH } from './schema';

describe('referral code generation', () => {
  it('builds a username tag with cryptographic suffix', () => {
    assert.equal(referralTagFromIdentity({ login: 'aditya-j' }), 'ADITYAJ');
    const code = generateReferralCode({
      userId: 'user-123',
      login: 'aditya',
      email: 'aj@example.com',
    });
    assert.match(code, /^ADITYA-[A-Z0-9]{6}$/);
    assert.equal(isModernReferralCode(code), true);
    assert.equal(isRecognizedReferralCode(code), true);
    assert.equal(verifyReferralCodeMatchesUser(code, 'user-123'), true);
    assert.equal(verifyReferralCodeMatchesUser(code, 'other-user'), false);
    assert.ok(code.length <= REFERRAL_ATTRIBUTION_CODE_MAX_LENGTH);
  });

  it('keeps referral attribution storage aligned with the generated-code limit', () => {
    assert.equal(REFERRAL_ATTRIBUTION_CODE_MAX_LENGTH, REFERRAL_CODE_MAX_LENGTH);
  });

  it('still recognizes legacy DPL codes during migration', () => {
    assert.equal(isLegacyReferralCode('DPL14B398D3'), true);
    assert.equal(isRecognizedReferralCode('DPL14B398D3'), true);
    assert.equal(isModernReferralCode('DPL14B398D3'), false);
  });

  it('rejects malformed codes', () => {
    assert.equal(isRecognizedReferralCode('FAKECODE'), false);
    assert.equal(isRecognizedReferralCode('ADITY'), false);
  });
});

describe('referral code normalization', () => {
  it('normalizes valid codes to uppercase', () => {
    assert.equal(normalizeReferralCode('aditya-x7k2m9'), 'ADITYA-X7K2M9');
    assert.equal(validateReferralCodeFormat('ADITYA-X7K2M9'), true);
    const legacy = normalizeReferralCode('dpl12345678');
    assert.equal(legacy, 'DPL12345678');
    assert.equal(validateReferralCodeFormat('DPL12345678'), true);
  });

  it('rejects invalid codes', () => {
    assert.equal(normalizeReferralCode(''), null);
    assert.equal(normalizeReferralCode('ab'), null);
    assert.equal(validateReferralCodeFormat('!!'), false);
  });
});

describe('referral economics', () => {
  it('computes referee discount in paise', () => {
    assert.equal(computeReferralDiscountPaise(224_900, 10), 22_490);
    assert.equal(computeReferralDiscountPaise(0, 10), 0);
  });

  it('computes referrer reward credits from plan catalog', () => {
    assert.equal(
      computeReferrerRewardCredits({ planId: 'starter_20', cadence: 'monthly', rewardPercent: 20 }),
      5,
    );
    assert.equal(
      computeReferrerRewardCredits({ planId: 'pro_50', cadence: 'yearly', rewardPercent: 20 }),
      12,
    );
    assert.equal(
      computeReferrerRewardCredits({ planId: 'free', cadence: 'monthly', rewardPercent: 20 }),
      0,
    );
  });
});

describe('referral attribution state', () => {
  it('treats pending attributions before expiry as active', () => {
    const future = new Date(Date.now() + 60_000);
    assert.equal(isAttributionActive('pending', future), true);
    assert.equal(isAttributionActive('converted', future), false);
    assert.equal(isAttributionActive('pending', new Date(Date.now() - 1)), false);
  });
});

describe('referral program config', () => {
  it('exposes default reward terms', () => {
    const config = getReferralProgramConfig();
    assert.equal(config.refereeDiscountPercent, 10);
    assert.equal(config.referrerRewardPercent, 20);
    assert.equal(config.attributionWindowDays, 30);
    assert.equal(config.maxReferralsPerReferrer, 3);
    assert.match(config.refereeBenefit, /10%/);
    assert.match(config.referrerBenefit, /20%/);
  });
});

describe('referrer slot limits', () => {
  it('computes remaining referral slots', () => {
    assert.equal(referrerSlotsRemaining(2, 3), 1);
    assert.equal(referrerCanAcceptMore(3, 3), false);
    assert.equal(referrerCanAcceptMore(2, 3), true);
  });
});

describe('share message', () => {
  it('includes code and signup link', () => {
    const message = buildReferralShareMessage({
      referralCode: 'ADITYA-X7K2M9',
      referralUrl: 'https://deplai.in/auth/signup?ref=ADITYA-X7K2M9',
      discountPercent: 10,
    });
    assert.match(message, /ADITYA-X7K2M9/);
    assert.match(message, /10%/);
    assert.match(message, /signup\?ref=/);
  });
});

describe('maskEmail', () => {
  it('masks email addresses for referrer dashboard', () => {
    const masked = maskEmail('john.doe@example.com');
    assert.match(masked, /j.*e@/);
    assert.doesNotMatch(masked, /john\.doe@example\.com/);
  });
});
