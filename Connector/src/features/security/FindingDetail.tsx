'use client';

import { SeverityBadge } from './SeverityBadge';
import { findingRenderKey } from './normalize';
import type { FindingCorrelation, UnifiedFinding } from './types';

function meta(finding: UnifiedFinding, key: string): string {
  const value = finding.metadata?.[key];
  if (value === null || value === undefined || value === '') return '';
  return String(value);
}

function whyThisMatters(finding: UnifiedFinding): string {
  const category = String(finding.category || '');
  if (category === 'secrets') {
    return 'A credential or secret was detected in source. Treat it as active until it is rotated and the finding is marked revoked.';
  }
  if (category === 'sca') {
    const cve = meta(finding, 'cve_id') || 'This package';
    const epss = meta(finding, 'epss_score');
    return epss
      ? `${cve} is present in a dependency. EPSS ${epss} indicates how likely exploitation is.`
      : `${cve} is present in a production dependency tree.`;
  }
  if (category === 'dast') {
    return 'This issue was observed against a running target, not only inferred from source.';
  }
  if (category === 'api') {
    return 'The API specification describes an endpoint with a security gap that attackers can probe once the service is reachable.';
  }
  if (category === 'iac' || category === 'kubernetes' || category === 'cicd' || category === 'containers') {
    return 'Misconfigured infrastructure or pipelines can expose workloads, credentials, or deployment paths.';
  }
  return 'This finding was produced by the security pipeline and should be reviewed before the next release.';
}

function suggestedFix(finding: UnifiedFinding): string {
  const category = String(finding.category || '');
  if (category === 'secrets') return 'Rotate the credential, remove it from source history where possible, and mark the finding revoked after confirmation.';
  if (category === 'sca') {
    const fix = meta(finding, 'fix_version');
    return fix ? `Upgrade ${finding.asset} to ${fix} and re-scan.` : `Review ${finding.asset} for a patched release, then re-scan.`;
  }
  const guideline = meta(finding, 'guideline');
  if (guideline) return `Apply the secure configuration described in the policy guidance, then re-scan.`;
  if (category === 'sast') return 'Patch the reported source location, then re-scan to verify.';
  if (category === 'dast') return 'Confirm the running service behavior, apply the source or configuration fix, then re-test the authorized target.';
  return 'Apply the suggested control for this asset, then re-scan.';
}

export function FindingDetail({
  finding,
  correlated,
}: {
  finding: UnifiedFinding;
  correlated?: UnifiedFinding[];
}) {
  const cwe = meta(finding, 'cwe_id');
  const cve = meta(finding, 'cve_id');
  const extract = meta(finding, 'code_extract');
  const guideline = meta(finding, 'guideline');
  const docs = meta(finding, 'documentation_url');
  const evidence = meta(finding, 'evidence');
  const version = meta(finding, 'version');
  const fixVersion = meta(finding, 'fix_version');
  const related = (correlated || []).filter((item) => item.id !== finding.id);

  return (
    <div className="space-y-5 text-sm text-neutral-700">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <SeverityBadge severity={finding.severity} />
          <h3 className="mt-2 text-base font-semibold text-black">{finding.title}</h3>
          <p className="mt-1 font-mono text-xs text-neutral-500">{finding.location || finding.asset}</p>
        </div>
        {typeof finding.risk === 'number' ? (
          <div className="text-right">
            <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-neutral-500">Risk</p>
            <p className="text-2xl font-bold text-black">{finding.risk}</p>
          </div>
        ) : null}
      </div>

      <section>
        <h4 className="mb-1 font-mono text-[10px] uppercase tracking-[0.16em] text-neutral-500">Why this matters</h4>
        <p>{whyThisMatters(finding)}</p>
      </section>

      <section>
        <h4 className="mb-1 font-mono text-[10px] uppercase tracking-[0.16em] text-neutral-500">Evidence</h4>
        <div className="grid gap-2 sm:grid-cols-2">
          <p><span className="text-neutral-500">Source</span> · {finding.evidence_source || finding.category}</p>
          {finding.scanner ? <p><span className="text-neutral-500">Evidence source</span> · {finding.scanner}</p> : null}
          {cwe ? <p><span className="text-neutral-500">CWE</span> · {cwe}</p> : null}
          {cve ? <p><span className="text-neutral-500">CVE</span> · {cve}</p> : null}
          {version ? <p><span className="text-neutral-500">Current version</span> · {version}</p> : null}
          {fixVersion ? <p><span className="text-neutral-500">Fixed version</span> · {fixVersion}</p> : null}
          {meta(finding, 'resource') ? <p><span className="text-neutral-500">Resource</span> · {meta(finding, 'resource')}</p> : null}
          {evidence ? <p className="sm:col-span-2"><span className="text-neutral-500">Observed</span> · {evidence}</p> : null}
        </div>
        {extract ? (
          <pre className="mt-3 overflow-auto border-[3px] border-black bg-neutral-50 p-3 font-mono text-[11px] text-neutral-800">{extract}</pre>
        ) : null}
      </section>

      {related.length > 0 ? (
        <section>
          <h4 className="mb-1 font-mono text-[10px] uppercase tracking-[0.16em] text-neutral-500">Correlated evidence</h4>
          <ol className="space-y-2">
            {[finding, ...related].map((item, index) => (
              <li key={findingRenderKey(item, index)} className="border-l-[3px] border-black pl-3">
                <p className="font-semibold text-black">{item.evidence_source || item.category}</p>
                <p className="text-xs text-neutral-500">{item.title}</p>
              </li>
            ))}
          </ol>
        </section>
      ) : null}

      <section>
        <h4 className="mb-1 font-mono text-[10px] uppercase tracking-[0.16em] text-neutral-500">Remediation</h4>
        <p>{suggestedFix(finding)}</p>
        {guideline ? <p className="mt-2 text-xs break-all text-neutral-500">{guideline}</p> : null}
        {docs ? <p className="mt-2 text-xs break-all text-neutral-500">{docs}</p> : null}
      </section>
    </div>
  );
}

export function correlatedFor(
  finding: UnifiedFinding,
  findings: UnifiedFinding[],
  correlations: FindingCorrelation[] | undefined,
): UnifiedFinding[] {
  const groups = (correlations || []).filter((item) => item.finding_ids.includes(finding.id));
  const ids = new Set(groups.flatMap((item) => item.finding_ids));
  return findings.filter((item) => ids.has(item.id));
}
