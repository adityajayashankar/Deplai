export type DastScopeMode = 'VERIFIED_HOST' | 'VERIFIED_DOMAIN' | 'PROJECT_ASSET';
export type DastAssetStatus = 'PENDING' | 'VERIFIED' | 'EXPIRED' | 'REVOKED' | 'REJECTED';
export type DastVerifyMethod = 'DNS_TXT' | 'HTTP';
export type DastScanProfile = 'BASELINE' | 'FULL' | 'API';
export type DastScanIntent = 'PASSIVE' | 'ACTIVE' | 'API_ACTIVE';

export function splitLabels(hostname: string): string[] {
  return String(hostname || '')
    .trim()
    .replace(/\.$/, '')
    .toLowerCase()
    .split('.')
    .filter(Boolean);
}

export function hostsEqual(left: string, right: string): boolean {
  const a = splitLabels(left);
  const b = splitLabels(right);
  return a.length > 0 && a.length === b.length && a.every((part, index) => part === b[index]);
}

export function isHostnameInDomain(hostname: string, domain: string): boolean {
  const hostLabels = splitLabels(hostname);
  const domainLabels = splitLabels(domain);
  if (!hostLabels.length || !domainLabels.length || hostLabels.length < domainLabels.length) {
    return false;
  }
  return domainLabels.every((label, index) => hostLabels[hostLabels.length - domainLabels.length + index] === label);
}

export function hostnameInScope(hostname: string, assetHost: string, scopeMode: DastScopeMode): boolean {
  if (scopeMode === 'VERIFIED_DOMAIN') {
    return isHostnameInDomain(hostname, assetHost);
  }
  return hostsEqual(hostname, assetHost);
}
