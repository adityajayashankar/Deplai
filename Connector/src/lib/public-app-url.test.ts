import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildReferralSignupUrl, CANONICAL_APP_ORIGIN, getShareableAppOrigin } from './public-app-url';

describe('shareable app origin', () => {
  const originalAppUrl = process.env.NEXT_PUBLIC_APP_URL;
  const originalCanonical = process.env.NEXT_PUBLIC_CANONICAL_APP_URL;

  function restoreEnv() {
    if (originalAppUrl === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
    else process.env.NEXT_PUBLIC_APP_URL = originalAppUrl;
    if (originalCanonical === undefined) delete process.env.NEXT_PUBLIC_CANONICAL_APP_URL;
    else process.env.NEXT_PUBLIC_CANONICAL_APP_URL = originalCanonical;
  }

  it('uses canonical deplai.in when app url is localhost', () => {
    process.env.NEXT_PUBLIC_APP_URL = 'http://localhost:3000';
    delete process.env.NEXT_PUBLIC_CANONICAL_APP_URL;
    assert.equal(getShareableAppOrigin('http://localhost:3000'), CANONICAL_APP_ORIGIN);
    restoreEnv();
  });

  it('uses configured production app url when set', () => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://deplai.in';
    assert.equal(getShareableAppOrigin(), 'https://deplai.in');
    restoreEnv();
  });

  it('builds referral signup links on the canonical domain', () => {
    process.env.NEXT_PUBLIC_APP_URL = 'http://localhost:3000';
    delete process.env.NEXT_PUBLIC_CANONICAL_APP_URL;
    assert.equal(
      buildReferralSignupUrl('ADITYAJAYA-VNYHK5', 'http://localhost:3000'),
      'https://deplai.in/auth/signup?ref=ADITYAJAYA-VNYHK5',
    );
    restoreEnv();
  });
});
