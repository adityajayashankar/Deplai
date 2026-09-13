import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEPLOYMENT_PROVIDER_OPTIONS,
  deploymentProviderAvailabilityMessage,
  isDeployableProvider,
  parseDeploymentProvider,
} from './deployment-providers';

describe('deployment provider catalogue', () => {
  it('exposes AWS as the only deployable option', () => {
    assert.deepEqual(
      DEPLOYMENT_PROVIDER_OPTIONS.map(({ id, available }) => ({ id, available })),
      [
        { id: 'aws', available: true },
        { id: 'heroku', available: false },
        { id: 'azure', available: false },
        { id: 'gcp', available: false },
      ],
    );
    assert.equal(isDeployableProvider('aws'), true);
    assert.equal(isDeployableProvider('heroku'), false);
    assert.equal(isDeployableProvider('azure'), false);
    assert.equal(isDeployableProvider('gcp'), false);
  });

  it('normalizes known providers and keeps unavailable providers explicit', () => {
    assert.equal(parseDeploymentProvider(' AWS '), 'aws');
    assert.equal(parseDeploymentProvider('Heroku'), 'heroku');
    assert.equal(parseDeploymentProvider('digitalocean'), null);
    assert.match(deploymentProviderAvailabilityMessage('azure'), /Azure deployment is coming soon/);
  });
});
