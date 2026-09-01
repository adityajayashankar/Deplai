export type SecurityPolicyConfiguration = {
  blockCritical: boolean;
  blockExposedSecrets: boolean;
  requireSast: boolean;
  requireSca: boolean;
  requireContainerScan: boolean;
  requireDast: boolean;
  criticalThreshold: number;
  highThreshold: number;
  productionApprovals: number;
};

export const DEFAULT_SECURITY_POLICY: SecurityPolicyConfiguration = {
  blockCritical: true,
  blockExposedSecrets: true,
  requireSast: true,
  requireSca: true,
  requireContainerScan: true,
  requireDast: false,
  criticalThreshold: 0,
  highThreshold: 5,
  productionApprovals: 2,
};

export type SecurityEvidence = {
  criticalFindings: number;
  highFindings: number;
  exposedSecrets: number;
  sastCompleted: boolean;
  scaCompleted: boolean;
  containerScanCompleted: boolean;
  dastCompleted: boolean;
};

export function evaluateSecurityPolicy(
  policy: SecurityPolicyConfiguration,
  evidence: SecurityEvidence,
): { decision: 'PASS' | 'FAIL' | 'WARNING'; reasons: string[] } {
  const failures: string[] = [];
  const warnings: string[] = [];
  if (policy.blockCritical && evidence.criticalFindings > policy.criticalThreshold) {
    failures.push(`Critical findings exceed threshold (${evidence.criticalFindings}/${policy.criticalThreshold})`);
  }
  if (evidence.highFindings > policy.highThreshold) {
    failures.push(`High findings exceed threshold (${evidence.highFindings}/${policy.highThreshold})`);
  }
  if (policy.blockExposedSecrets && evidence.exposedSecrets > 0) failures.push('Exposed secrets were detected');
  if (policy.requireSast && !evidence.sastCompleted) failures.push('SAST evidence is missing');
  if (policy.requireSca && !evidence.scaCompleted) failures.push('SCA evidence is missing');
  if (policy.requireContainerScan && !evidence.containerScanCompleted) failures.push('Container scan evidence is missing');
  if (policy.requireDast && !evidence.dastCompleted) failures.push('DAST evidence is missing');
  if (!policy.requireDast && !evidence.dastCompleted) warnings.push('DAST was not required or completed');
  if (failures.length) return { decision: 'FAIL', reasons: failures };
  if (warnings.length) return { decision: 'WARNING', reasons: warnings };
  return { decision: 'PASS', reasons: [] };
}

export function approvalRequirementSatisfied(input: {
  approvalsRequired: number;
  validApproverIds: readonly string[];
  expired: boolean;
}): boolean {
  if (input.expired) return false;
  return new Set(input.validApproverIds.filter(Boolean)).size >= Math.max(0, input.approvalsRequired);
}
