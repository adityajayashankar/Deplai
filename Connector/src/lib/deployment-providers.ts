/**
 * The deployment provider catalogue is shared by the pipeline UI and its
 * request handlers.  A provider can be displayed before its execution path is
 * available, but only an `available` provider may generate or apply IaC.
 */
export const DEPLOYMENT_PROVIDER_OPTIONS = [
  { id: 'aws', label: 'AWS', available: true },
  { id: 'heroku', label: 'Heroku', available: false },
  { id: 'azure', label: 'Azure', available: false },
  { id: 'gcp', label: 'GCP', available: false },
] as const;

export type DeploymentProviderId = (typeof DEPLOYMENT_PROVIDER_OPTIONS)[number]['id'];
export type DeployableProviderId = Extract<
  (typeof DEPLOYMENT_PROVIDER_OPTIONS)[number],
  { available: true }
>['id'];

export function parseDeploymentProvider(value: unknown): DeploymentProviderId | null {
  const candidate = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return DEPLOYMENT_PROVIDER_OPTIONS.some((provider) => provider.id === candidate)
    ? candidate as DeploymentProviderId
    : null;
}

export function isDeployableProvider(provider: DeploymentProviderId): provider is DeployableProviderId {
  return DEPLOYMENT_PROVIDER_OPTIONS.some((option) => option.id === provider && option.available);
}

export function deploymentProviderAvailabilityMessage(provider: DeploymentProviderId): string {
  const option = DEPLOYMENT_PROVIDER_OPTIONS.find((candidate) => candidate.id === provider);
  const label = option?.label || provider.toUpperCase();
  return `${label} deployment is coming soon. AWS is currently the only deployable provider.`;
}
