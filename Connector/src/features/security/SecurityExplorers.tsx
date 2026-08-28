'use client';

import { useEffect, useState } from 'react';
import { appBtnInk, appInput, secPaper } from '@/features/workspace/theme';
import { FindingTable } from './FindingTable';
import { RiskScore } from './RiskScore';
import { SeverityBadge } from './SeverityBadge';
import { DastAssetManager } from './DastAssetManager';
import { findingRenderKey } from './normalize';
import type {
  AttackPath,
  FindingCategory,
  FindingSeverity,
  ScanResultsPayload,
  SecurityModule,
  UnifiedFinding,
} from './types';

function EmptyState({ title, message }: { title: string; message: string }) {
  return (
    <div className={`${secPaper} p-6`}>
      <h3 className="text-sm font-semibold text-black">{title}</h3>
      <p className="mt-2 text-sm text-neutral-600">{message}</p>
    </div>
  );
}

function maskSecret(finding: UnifiedFinding): string {
  const fingerprint = String(finding.metadata?.fingerprint || finding.id || '');
  const tail = fingerprint.replace(/[^a-zA-Z0-9]/g, '').slice(-4);
  return tail ? `****${tail}` : '****';
}

export function SecretsExplorer({ findings }: { findings: UnifiedFinding[] }) {
  const secrets = findings.filter((item) => item.category === 'secrets');
  if (secrets.length === 0) {
    return (
      <EmptyState
        title="No secrets detected"
        message="The latest secret scan did not report credentials in this repository."
      />
    );
  }
  return (
    <div className={`${secPaper} overflow-hidden`}>
      <div className="border-b-[3px] border-black px-6 py-4">
        <h3 className="text-sm font-semibold text-black">Secrets</h3>
        <p className="mt-1 text-xs text-neutral-500">{secrets.length} detected · secret values are never shown</p>
      </div>
      <div className="divide-y divide-black/15">
        {secrets.map((finding, index) => (
          <div key={findingRenderKey(finding, index)} className="grid gap-3 px-6 py-4 sm:grid-cols-[140px_minmax(0,1fr)_120px]">
            <SeverityBadge severity={finding.severity} />
            <div>
              <p className="font-semibold text-black">{finding.title}</p>
              <p className="mt-1 font-mono text-xs text-neutral-500">{finding.asset}</p>
              <p className="mt-1 font-mono text-xs text-neutral-400">{maskSecret(finding)}</p>
            </div>
            <p className="text-xs capitalize text-neutral-500">{finding.status || 'active'}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

export function SupplyChainExplorer({
  findings,
  results,
}: {
  findings: UnifiedFinding[];
  results: ScanResultsPayload;
}) {
  const components = results.sbom?.components || [];
  const vulnerable = findings.filter((item) => item.category === 'sca');
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <div className={`${secPaper} p-4`}>
          <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-neutral-500">Components</p>
          <p className="mt-2 text-2xl font-bold text-black">{results.sbom?.component_count || 0}</p>
        </div>
        <div className={`${secPaper} p-4`}>
          <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-neutral-500">Vulnerable</p>
          <p className="mt-2 text-2xl font-bold text-black">{vulnerable.length}</p>
        </div>
        <div className={`${secPaper} p-4`}>
          <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-neutral-500">Fix available</p>
          <p className="mt-2 text-2xl font-bold text-black">
            {vulnerable.filter((item) => item.metadata?.fix_version).length}
          </p>
        </div>
      </div>
      {vulnerable.length > 0 ? (
        <FindingTable
          findings={vulnerable}
          category="sca"
          onCategoryChange={() => undefined}
          query=""
          onQueryChange={() => undefined}
          severity="all"
          onSeverityChange={() => undefined}
          hideFilters
        />
      ) : (
        <EmptyState title="No vulnerable components" message="Dependency scanning did not report known CVEs in this run." />
      )}
      {components.length > 0 ? (
        <div className={`${secPaper} overflow-hidden`}>
          <div className="border-b-[3px] border-black px-6 py-4">
            <h3 className="text-sm font-semibold text-black">Component explorer</h3>
            <p className="mt-1 text-xs text-neutral-500">First {components.length} components from the software bill of materials.</p>
          </div>
          <div className="custom-scrollbar max-h-[40vh] overflow-auto">
            <table className="w-full min-w-[640px] text-left text-sm">
              <thead>
                <tr className="border-b-[3px] border-black">
                  <th className="px-4 py-3 text-[10px] font-bold uppercase tracking-wider text-zinc-500">Package</th>
                  <th className="px-4 py-3 text-[10px] font-bold uppercase tracking-wider text-zinc-500">Version</th>
                  <th className="px-4 py-3 text-[10px] font-bold uppercase tracking-wider text-zinc-500">Ecosystem</th>
                </tr>
              </thead>
              <tbody>
                {components.map((item, index) => (
                  <tr key={`${item.name}-${item.version}-${index}`} className="border-b border-black/15">
                    <td className="px-4 py-3 text-black">{item.name}</td>
                    <td className="px-4 py-3 font-mono text-xs text-neutral-500">{item.version || '—'}</td>
                    <td className="px-4 py-3 font-mono text-xs text-neutral-500">{item.type || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function groupByType(findings: UnifiedFinding[], key: string): Record<string, UnifiedFinding[]> {
  const groups: Record<string, UnifiedFinding[]> = {};
  for (const finding of findings) {
    const label = String(finding.metadata?.[key] || finding.category || 'other');
    groups[label] = groups[label] || [];
    groups[label].push(finding);
  }
  return groups;
}

export function InfrastructureExplorer({
  findings,
  modules,
}: {
  findings: UnifiedFinding[];
  modules: SecurityModule[];
}) {
  const iac = findings.filter((item) => item.category === 'iac');
  const containers = findings.filter((item) => item.category === 'containers');
  const kubernetes = findings.filter((item) => item.category === 'kubernetes');
  const cicd = findings.filter((item) => item.category === 'cicd');
  const moduleById = Object.fromEntries(modules.map((item) => [item.id, item]));

  const sections: Array<{ id: string; title: string; items: UnifiedFinding[]; empty: string }> = [
    { id: 'iac', title: 'Infrastructure as code', items: iac, empty: 'No supported infrastructure files were scanned, or none failed policy checks.' },
    { id: 'containers', title: 'Containers', items: containers, empty: 'No container definition files were scanned, or none failed policy checks.' },
    { id: 'kubernetes', title: 'Kubernetes', items: kubernetes, empty: 'No Kubernetes manifests were scanned, or none failed policy checks.' },
    { id: 'cicd', title: 'CI/CD', items: cicd, empty: 'No CI/CD workflow files were scanned, or none failed policy checks.' },
  ];

  return (
    <div className="space-y-4">
      <div className={`${secPaper} p-4`}>
        <p className="text-sm text-neutral-600">
          Live AWS account scanning runs from the Cloud tab after this project has IaC configured and deployed. Kubernetes, IaC, containers, and CI/CD below use repository files from this run.
        </p>
      </div>
      {sections.map((section) => {
        const skipped = moduleById[section.id]?.status === 'SKIPPED';
        const groups = groupByType(section.items, 'check_type');
        return (
          <div key={section.id} className={`${secPaper} overflow-hidden`}>
            <div className="border-b-[3px] border-black px-6 py-4">
              <h3 className="text-sm font-semibold text-black">{section.title}</h3>
              <p className="mt-1 text-xs text-neutral-500">
                {skipped ? moduleById[section.id]?.reason || section.empty : `${section.items.length} finding${section.items.length === 1 ? '' : 's'}`}
              </p>
            </div>
            {section.items.length === 0 ? (
              <p className="px-6 py-5 text-sm text-neutral-500">{skipped ? moduleById[section.id]?.reason || section.empty : section.empty}</p>
            ) : (
              Object.entries(groups).map(([label, items]) => (
                <div key={label} className="border-t border-black/15 px-6 py-4">
                  <p className="mb-3 font-mono text-[10px] uppercase tracking-[0.16em] text-neutral-500">{label}</p>
                  <div className="space-y-3">
                    {items.map((item, index) => (
                      <div key={findingRenderKey(item, index)} className="flex flex-wrap items-start justify-between gap-3">
                        <div>
                          <p className="font-semibold text-black">{item.title}</p>
                          <p className="mt-1 font-mono text-xs text-neutral-500">{item.asset} · {item.location}</p>
                        </div>
                        <SeverityBadge severity={item.severity} />
                      </div>
                    ))}
                  </div>
                </div>
              ))
            )}
          </div>
        );
      })}
    </div>
  );
}

export function ApiExplorer({ findings, module }: { findings: UnifiedFinding[]; module?: SecurityModule }) {
  const apis = findings.filter((item) => item.category === 'api');
  if (module?.status === 'SKIPPED' && apis.length === 0) {
    return (
      <EmptyState
        title="API security is not configured"
        message={module.reason || 'Add an OpenAPI or Swagger specification to enable API security testing.'}
      />
    );
  }
  if (apis.length === 0) {
    return <EmptyState title="No API security findings" message="Your latest API security scan found no issues." />;
  }
  return (
    <div className={`${secPaper} overflow-hidden`}>
      <div className="border-b-[3px] border-black px-6 py-4">
        <h3 className="text-sm font-semibold text-black">API endpoints</h3>
        <p className="mt-1 text-xs text-neutral-500">{apis.length} finding{apis.length === 1 ? '' : 's'} from specification analysis.</p>
      </div>
      <div className="divide-y divide-black/15">
        {apis.map((item, index) => (
          <div key={findingRenderKey(item, index)} className="px-6 py-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="font-mono text-sm text-black">{item.asset}</p>
                <p className="mt-1 text-sm text-neutral-600">{item.title}</p>
              </div>
              <SeverityBadge severity={item.severity} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function DynamicTestingExplorer({
  findings,
  module,
  projectId,
  selectedAssetId,
  onSelectAsset,
  profile,
  onProfileChange,
  onRun,
  busy,
  error,
}: {
  findings: UnifiedFinding[];
  module?: SecurityModule;
  projectId: string;
  selectedAssetId: string;
  onSelectAsset: (asset: { id: string; target_url: string; status: string } | null) => void;
  profile: 'BASELINE' | 'FULL' | 'API';
  onProfileChange: (value: 'BASELINE' | 'FULL' | 'API') => void;
  onRun: () => void;
  busy?: boolean;
  error?: string | null;
}) {
  const dast = findings.filter((item) => item.category === 'dast');
  const skipped = module?.status === 'SKIPPED' && dast.length === 0;
  const failed = module?.status === 'FAILED';
  const blocked = Boolean(error && /DAST_|not associated|not been verified/i.test(error));

  return (
    <div className="space-y-4">
      <div className={`${secPaper} p-6`}>
        <h3 className="text-sm font-semibold text-black">
          {blocked ? 'Unauthorized target' : failed ? 'DAST failed' : skipped ? 'Dynamic testing is not configured' : 'Authorized target'}
        </h3>
        <p className="mt-2 text-sm text-neutral-600">
          {blocked
            ? (error || 'This target is not associated with the selected project and ownership has not been verified.')
            : failed
              ? (module?.error || 'The authorized target could not be tested. Confirm ownership, then retry.')
              : 'Select a verified project target. A URL can be registered here, but a scan starts only after ownership verification.'}
        </p>
      </div>
      <DastAssetManager
        projectId={projectId}
        selectedId={selectedAssetId}
        onSelect={onSelectAsset}
        profile={profile}
        onProfileChange={onProfileChange}
        compact
      />
      {error && !blocked ? <p className="text-sm text-red-700">{error}</p> : null}
      <button
        type="button"
        onClick={onRun}
        disabled={busy}
        className={appBtnInk}
      >
        {busy ? 'Starting DAST…' : 'Run dynamic testing'}
      </button>

      {dast.length === 0 && !skipped && !failed ? (
        <EmptyState title="No dynamic testing findings" message="The authorized target did not return DAST alerts in this run." />
      ) : null}

      {dast.length > 0 ? (
        <div className={`${secPaper} overflow-hidden`}>
          <div className="border-b-[3px] border-black px-6 py-4">
            <h3 className="text-sm font-semibold text-black">Dynamic application testing</h3>
            <p className="mt-1 text-xs text-neutral-500">{dast.length} finding{dast.length === 1 ? '' : 's'} against the authorized target.</p>
          </div>
          <div className="divide-y divide-black/15">
            {dast.map((item, index) => (
              <div key={findingRenderKey(item, index)} className="px-6 py-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="font-semibold text-black">{item.title}</p>
                    <p className="mt-1 font-mono text-xs text-neutral-500">{item.location}</p>
                  </div>
                  <SeverityBadge severity={item.severity} />
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function AssetExplorer({ findings }: { findings: UnifiedFinding[] }) {
  const assets = new Map<string, { name: string; findings: UnifiedFinding[] }>();
  for (const finding of findings) {
    const name = finding.asset || finding.location || 'unknown';
    const current = assets.get(name) || { name, findings: [] };
    current.findings.push(finding);
    assets.set(name, current);
  }
  const rows = Array.from(assets.values()).sort((a, b) => b.findings.length - a.findings.length);
  if (rows.length === 0) {
    return <EmptyState title="No assets yet" message="Assets appear from findings in the latest pipeline run." />;
  }
  return (
    <div className={`${secPaper} overflow-hidden`}>
      <div className="border-b-[3px] border-black px-6 py-4">
        <h3 className="text-sm font-semibold text-black">Assets</h3>
        <p className="mt-1 text-xs text-neutral-500">{rows.length} assets derived from current findings.</p>
      </div>
      <div className="divide-y divide-black/15">
        {rows.slice(0, 200).map((asset, index) => {
          const critical = asset.findings.filter((item) => String(item.severity).toLowerCase() === 'critical').length;
          const high = asset.findings.filter((item) => String(item.severity).toLowerCase() === 'high').length;
          return (
            <div key={`${asset.name}::${index}`} className="flex flex-wrap items-start justify-between gap-3 px-6 py-4">
              <div>
                <p className="font-mono text-sm text-black">{asset.name}</p>
                <p className="mt-1 text-xs text-neutral-500">{asset.findings.length} finding{asset.findings.length === 1 ? '' : 's'}</p>
              </div>
              <p className="text-xs text-neutral-500">Critical {critical} · High {high}</p>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function AttackPathExplorer({
  paths,
  onSelectFinding,
}: {
  paths: AttackPath[];
  onSelectFinding?: (id: string) => void;
}) {
  if (paths.length === 0) {
    return (
      <EmptyState
        title="No attack paths from this run"
        message="Attack paths appear when findings describe internet exposure or unauthenticated access. Relationships are never invented."
      />
    );
  }
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {paths.map((path, index) => (
        <button
          key={`${path.id}::${index}`}
          type="button"
          onClick={() => {
            const findingId = path.finding_ids?.[0];
            if (findingId) onSelectFinding?.(findingId);
          }}
          className={`${secPaper} p-5 text-left transition-transform hover:translate-x-0.5 hover:translate-y-0.5 hover:shadow-none`}
        >
          <div className="mb-3 flex items-center justify-between gap-3">
            <p className="text-sm font-semibold text-black">{path.title}</p>
            {typeof path.risk === 'number' ? <span className="font-mono text-xs text-neutral-500">Risk {path.risk}</span> : null}
          </div>
          <ol className="space-y-2">
            {path.hops.map((hop, index) => (
              <li key={`${path.id}-${hop.id}-${index}`} className="font-mono text-xs text-neutral-600">
                {hop.label}
                {index < path.hops.length - 1 ? <span className="block pl-2 text-neutral-400">↓</span> : null}
              </li>
            ))}
          </ol>
        </button>
      ))}
    </div>
  );
}

export function CloudExplorer({
  findings,
  module,
  deployed,
  onRun,
  busy,
  error,
  deployHref,
}: {
  findings: UnifiedFinding[];
  module?: SecurityModule;
  deployed: boolean;
  onRun: (creds: {
    aws_access_key_id: string;
    aws_secret_access_key: string;
    aws_session_token: string;
    aws_region: string;
  }) => void;
  busy?: boolean;
  error?: string | null;
  deployHref: string;
}) {
  const cloud = findings.filter((item) => item.category === 'cloud');
  const skipped = module?.status === 'SKIPPED' && cloud.length === 0;
  const failed = module?.status === 'FAILED';
  const [accessKey, setAccessKey] = useState('');
  const [secretKey, setSecretKey] = useState('');
  const [sessionToken, setSessionToken] = useState('');
  const [region, setRegion] = useState('eu-north-1');

  useEffect(() => {
    void import('@/features/deployment/state').then(({ readSavedAws }) => {
      const saved = readSavedAws();
      if (saved.aws_access_key_id) setAccessKey(saved.aws_access_key_id);
      if (saved.aws_secret_access_key) setSecretKey(saved.aws_secret_access_key);
      if (saved.aws_session_token) setSessionToken(saved.aws_session_token);
      if (saved.aws_region) setRegion(saved.aws_region);
    });
  }, []);

  const canRun = deployed && Boolean(accessKey.trim() && secretKey.trim()) && !busy;

  return (
    <div className="space-y-4">
      <div className={`${secPaper} p-6`}>
        <h3 className="text-sm font-semibold text-black">
          {failed ? 'Cloud scan failed' : skipped || !deployed ? 'Cloud scanning is not configured' : 'Authorized AWS account'}
        </h3>
        <p className="mt-2 text-sm text-neutral-600">
          {deployed
            ? 'Uses the same operator credentials as Deploy, limited to the deployment region. Credentials are not stored on the server.'
            : 'Cloud live-account scanning is available after IaC is configured and deployed for this project.'}
        </p>
        {!deployed ? (
          <a href={deployHref} className={`mt-4 inline-flex ${appBtnInk}`}>
            Open Deploy
          </a>
        ) : (
          <div className="mt-4 space-y-3">
            <label className="block font-mono text-[10px] uppercase tracking-[0.16em] text-neutral-500">
              Access key
              <input value={accessKey} onChange={(event) => setAccessKey(event.target.value)} className={`${appInput} mt-1`} autoComplete="off" />
            </label>
            <label className="block font-mono text-[10px] uppercase tracking-[0.16em] text-neutral-500">
              Secret key
              <input type="password" value={secretKey} onChange={(event) => setSecretKey(event.target.value)} className={`${appInput} mt-1`} autoComplete="off" />
            </label>
            <label className="block font-mono text-[10px] uppercase tracking-[0.16em] text-neutral-500">
              Session token
              <input value={sessionToken} onChange={(event) => setSessionToken(event.target.value)} placeholder="Required for ASIA keys" className={`${appInput} mt-1`} autoComplete="off" />
            </label>
            <label className="block font-mono text-[10px] uppercase tracking-[0.16em] text-neutral-500">
              Region
              <input value={region} onChange={(event) => setRegion(event.target.value)} className={`${appInput} mt-1`} />
            </label>
            {error ? <p className="text-sm text-red-700">{error}</p> : null}
            {failed && module?.error ? <p className="text-sm text-red-700">{module.error}</p> : null}
            <button
              type="button"
              disabled={!canRun}
              onClick={() => onRun({
                aws_access_key_id: accessKey.trim(),
                aws_secret_access_key: secretKey.trim(),
                aws_session_token: sessionToken.trim(),
                aws_region: region.trim() || 'eu-north-1',
              })}
              className={appBtnInk}
            >
              {busy ? 'Starting cloud scan…' : 'Run cloud scan'}
            </button>
          </div>
        )}
      </div>

      {cloud.length === 0 && deployed && !skipped && !failed ? (
        <EmptyState title="No cloud findings" message="The authorized account did not return failed live-account checks in this run." />
      ) : null}

      {cloud.length > 0 ? (
        <div className={`${secPaper} overflow-hidden`}>
          <div className="border-b-[3px] border-black px-6 py-4">
            <h3 className="text-sm font-semibold text-black">Cloud account findings</h3>
            <p className="mt-1 text-xs text-neutral-500">{cloud.length} failed check{cloud.length === 1 ? '' : 's'} in the deployment region.</p>
          </div>
          <div className="divide-y divide-black/15">
            {cloud.map((item, index) => (
              <div key={findingRenderKey(item, index)} className="px-6 py-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="font-semibold text-black">{item.title}</p>
                    <p className="mt-1 font-mono text-xs text-neutral-500">{item.asset} · {item.location}</p>
                  </div>
                  <SeverityBadge severity={item.severity} />
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function RiskExplorer({
  results,
  findings,
}: {
  results: ScanResultsPayload;
  findings: UnifiedFinding[];
}) {
  const exploitable = findings.filter((item) => Number(item.metadata?.epss_score || 0) >= 0.5 || item.category === 'dast').length;
  const secrets = findings.filter((item) => item.category === 'secrets').length;
  const exposed = (results.attack_paths || []).length;
  return (
    <div className="space-y-4">
      <RiskScore risk={results.risk} />
      <div className="grid gap-3 sm:grid-cols-3">
        <div className={`${secPaper} p-4`}>
          <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-neutral-500">Exploitable</p>
          <p className="mt-2 text-2xl font-bold text-black">{exploitable}</p>
        </div>
        <div className={`${secPaper} p-4`}>
          <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-neutral-500">Internet exposed</p>
          <p className="mt-2 text-2xl font-bold text-black">{exposed}</p>
        </div>
        <div className={`${secPaper} p-4`}>
          <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-neutral-500">Active secrets</p>
          <p className="mt-2 text-2xl font-bold text-black">{secrets}</p>
        </div>
      </div>
    </div>
  );
}

export type ExplorerCategory = FindingCategory | 'all';
export type ExplorerSeverity = 'all' | FindingSeverity;
