import assert from 'node:assert/strict';
import test from 'node:test';
import { headingId, resolveGuideHref } from './guide-links';

test('resolveGuideHref maps markdown files to dashboard docs routes', () => {
  assert.equal(resolveGuideHref('concepts.md'), '/dashboard/documentation/concepts');
  assert.equal(resolveGuideHref('agents/security-agent.md'), '/dashboard/documentation/security-agent');
  assert.equal(resolveGuideHref('../how-it-works.md'), '/dashboard/documentation/how-it-works');
  assert.equal(resolveGuideHref('../architecture.md'), '/dashboard/documentation/how-it-works');
  assert.equal(resolveGuideHref('billing.md#plans'), '/dashboard/documentation/billing#plans');
  assert.equal(resolveGuideHref('https://docs.bearer.com/'), 'https://docs.bearer.com/');
  assert.equal(resolveGuideHref('mailto:support@deplai.tech'), 'mailto:support@deplai.tech');
});

test('headingId slugs section titles', () => {
  assert.equal(headingId('Agent setup'), 'agent-setup');
  assert.equal(headingId('GitHub & verify'), 'github-verify');
});
