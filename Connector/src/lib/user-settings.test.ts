import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseStoredUserSettings, DEFAULT_USER_SETTINGS } from './user-settings';

describe('parseStoredUserSettings', () => {
  it('starts new accounts without demo MFA, devices, or billing', () => {
    const settings = parseStoredUserSettings({});
    assert.equal(settings.user.security.mfaEnabled, false);
    assert.equal(settings.user.security.passkeys.length, 0);
    assert.equal(settings.user.sessions.rows.length, 0);
    assert.equal(settings.user.billing.deployments, 0);
    assert.equal(settings.user.account.displayName, '');
    assert.equal(settings.user.integrations.githubUsername, '');
  });

  it('strips the shipped demo placeholders from stored JSON', () => {
    const settings = parseStoredUserSettings({
      user: {
        account: {
          displayName: 'AJ',
          contactEmail: 'aj@pesuventurelabs.com',
          roleTitle: 'AI Infrastructure Engineer',
          bio: 'Building DeplAI - multi-agent AWS deployment automation.',
          timezone: 'Asia/Kolkata (IST)',
        },
        security: {
          mfaEnabled: true,
          recoveryCodes: 8,
          passkeys: [{ id: 'pk-macbook', name: 'MacBook Pro', detail: 'Chrome' }],
        },
        sessions: {
          rows: [
            { id: 'sess-macbook', deviceType: 'laptop', name: 'MacBook Pro - Chrome', current: true },
            { id: 'sess-iphone', deviceType: 'phone', name: 'iPhone 15 - Safari', current: false },
          ],
        },
        integrations: { githubConnected: true, githubUsername: 'aj-dev' },
        billing: { deployments: 12, tokensUsed: 847000, apiCalls: 234, estimatedCostUsd: 3.21 },
      },
    });

    assert.equal(settings.user.account.displayName, '');
    assert.equal(settings.user.account.contactEmail, '');
    assert.equal(settings.user.account.timezone, 'Asia/Kolkata');
    assert.equal(settings.user.security.mfaEnabled, false);
    assert.equal(settings.user.security.passkeys.length, 0);
    assert.equal(settings.user.sessions.rows.length, 0);
    assert.equal(settings.user.integrations.githubUsername, '');
    assert.equal(settings.user.billing.tokensUsed, 0);
  });

  it('keeps real account fields', () => {
    const settings = parseStoredUserSettings({
      user: {
        account: {
          displayName: 'Aditya',
          contactEmail: 'aditya@example.com',
          roleTitle: 'Engineer',
          timezone: 'Asia/Kolkata',
        },
      },
    });
    assert.equal(settings.user.account.displayName, 'Aditya');
    assert.equal(settings.user.account.contactEmail, 'aditya@example.com');
    assert.equal(settings.user.preferences.density, DEFAULT_USER_SETTINGS.user.preferences.density);
  });
});
