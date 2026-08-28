'use client';

import React, { useMemo, useState } from 'react';
import { Check, Copy, Download, ExternalLink, Globe, Server } from 'lucide-react';
import {
  Callout,
  Chip,
  CodeSurface,
  EmptyState,
  Panel,
  SectionLabel,
  StatusPill,
  buttonClass,
  paperInsetClass,
  secondaryButtonClass,
} from '@/features/deployment/deployment-ui';
import {
  asExternalHref,
  isSensitiveOutputKey,
  type InfraAccessBriefing,
  type InfraOutputEntry,
  isProvisionedValue,
  type InfraSpecRow,
} from '@/features/deployment/infra-access-briefing';

export type InfraEndpointCheck = {
  label: string;
  url: string;
  ok: boolean;
  status: number | null;
  detail: string;
};

function CopyIconButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        await navigator.clipboard.writeText(value);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1600);
      }}
      className="shrink-0 rounded-none border-[3px] border-black bg-white p-1.5 text-black hover:bg-neutral-100"
      aria-label={copied ? `Copied ${label}` : `Copy ${label}`}
    >
      {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
    </button>
  );
}

function CopyTextButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        await navigator.clipboard.writeText(value);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1600);
      }}
      className={buttonClass('secondary', { size: 'sm' })}
    >
      {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
      {copied ? 'Copied' : label}
    </button>
  );
}

function SpecList({ rows }: { rows: InfraSpecRow[] }) {
  if (rows.length === 0) return null;
  return (
    <div className="space-y-0">
      {rows.map((row) => (
        <div key={`${row.label}:${row.value}`} className="flex items-start justify-between gap-3 border-b-[3px] border-black/10 py-3 last:border-0 last:pb-0 first:pt-0">
          <div className="min-w-0">
            <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-[var(--dw-faint)]">{row.label}</div>
            <div className="mt-1.5 break-all font-mono text-[13px] text-[var(--dw-fg)]">{row.value}</div>
            {row.hint ? <div className="mt-1 text-[12px] leading-relaxed text-[var(--dw-muted)]">{row.hint}</div> : null}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {row.copy ? <CopyIconButton value={row.value} label={row.label} /> : null}
            {row.href ? (
              <button
                type="button"
                onClick={() => window.open(row.href, '_blank', 'noopener,noreferrer')}
                className="rounded-none border-[3px] border-black bg-white p-1.5 text-black hover:bg-neutral-100"
                aria-label={`Open ${row.label}`}
              >
                <ExternalLink className="h-3.5 w-3.5" />
              </button>
            ) : null}
          </div>
        </div>
      ))}
    </div>
  );
}

export function InfraOutputsStage({
  briefing,
  generatedPem,
  databaseEnv,
  keyPairMessage,
  oauthAppUrl,
  oauthCallbackPaths,
  missingOauthSecrets,
  endpointChecks,
  canVerify,
  history,
  onDownloadPem,
  onDownloadPpk,
  onDownloadDatabase,
  actions,
  rawOutputs,
  consoleSlot,
  showOauthPanel = false,
}: {
  briefing: InfraAccessBriefing;
  generatedPem: string | null;
  databaseEnv?: string | null;
  keyPairMessage: string;
  oauthAppUrl: string | null;
  oauthCallbackPaths: string[];
  missingOauthSecrets: boolean;
  showOauthPanel?: boolean;
  endpointChecks: InfraEndpointCheck[];
  canVerify: boolean;
  history: Array<{ id: string; createdAt: string; status: 'done' | 'error'; instanceId: string }>;
  onDownloadPem: () => void;
  onDownloadPpk: () => void;
  onDownloadDatabase?: () => void;
  actions?: React.ReactNode;
  rawOutputs?: InfraOutputEntry[] | null;
  consoleSlot?: React.ReactNode;
}) {
  const visibleRaw = useMemo(
    () => (rawOutputs || []).filter((entry) => {
      if (isSensitiveOutputKey(entry.key) || isSensitiveOutputKey(entry.label || '')) return false;
      return isProvisionedValue(Array.isArray(entry.value) ? entry.value.join(',') : entry.value);
    }),
    [rawOutputs],
  );
  const stateTone = briefing.instanceState?.toLowerCase() === 'running' ? 'ok' : briefing.instanceState ? 'warn' : 'neutral';

  return (
    <div className="space-y-5">
      <Panel elevation="raised" padded={false}>
        <div className="flex flex-wrap items-start justify-between gap-4 border-b-[3px] border-black px-5 py-4">
          <div className="min-w-0">
            <SectionLabel className="mb-0">How to access</SectionLabel>
            <p className="mt-2 text-[13px] text-[var(--dw-muted)]">
              {briefing.strategyLabel} in {briefing.region}. Public HTTP is below; SSH and data stores stay on the VPC.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Chip tone="accent" mono>{briefing.region}</Chip>
            {briefing.instanceType ? <Chip mono>{briefing.instanceType}</Chip> : null}
            {briefing.instanceState ? <StatusPill tone={stateTone}>{briefing.instanceState}</StatusPill> : null}
            {briefing.diskGb ? <Chip mono>{briefing.diskGb} GB disk</Chip> : null}
          </div>
        </div>
        {briefing.stack.length > 0 ? (
          <div className="flex flex-wrap gap-2 border-b-[3px] border-black px-5 py-3">
            {briefing.stack.map((item) => (
              <Chip key={item} mono>{item}</Chip>
            ))}
          </div>
        ) : null}
        <div className="space-y-4 px-5 py-5">
          {briefing.appUrl ? (
            <div className={`${paperInsetClass} p-4`}>
              <div className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.16em] text-[var(--dw-faint)]">
                <Globe className="h-3.5 w-3.5" /> Application
              </div>
              <div className="mt-2 break-all font-mono text-[18px] leading-snug text-[var(--dw-fg)]">{briefing.appUrl}</div>
              <p className="mt-2 text-[12.5px] text-[var(--dw-muted)]">
                {briefing.appPort
                  ? `App process listens on port ${briefing.appPort}; HTTP is exposed on 80. Give DNS a minute if this is a fresh ALB or CloudFront distribution.`
                  : 'Give DNS a minute if this is a fresh load balancer or CloudFront distribution.'}
              </p>
              <div className="mt-4 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => window.open(asExternalHref(briefing.appUrl) || briefing.appUrl || '', '_blank', 'noopener,noreferrer')}
                  className={buttonClass('primary', { size: 'sm' })}
                >
                  <ExternalLink className="h-4 w-4" /> Open app
                </button>
                <CopyTextButton value={briefing.appUrl} label="Copy URL" />
              </div>
            </div>
          ) : (
            <EmptyState title="No public URL yet" description="Deploy or fetch latest runtime details to hydrate the application URL, Elastic IP, or load balancer DNS." />
          )}
          <ol className="list-decimal space-y-1.5 pl-5 text-[13px] leading-relaxed text-[var(--dw-muted)]">
            {briefing.accessSteps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
          {briefing.access.length > 0 ? <SpecList rows={briefing.access} /> : null}
        </div>
      </Panel>

      {briefing.sshCommand || briefing.rdsCommand || briefing.redisCommand ? (
        <Panel>
          <SectionLabel>Connect</SectionLabel>
          <div className="space-y-4">
            {briefing.sshCommand ? (
              <div>
                <div className="mb-2 flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.16em] text-[var(--dw-faint)]">
                  <Server className="h-3.5 w-3.5" /> SSH
                </div>
                <CodeSurface
                  code={briefing.sshCommand}
                  language="bash"
                  filename="ssh"
                  maxHeight="6rem"
                  actions={<CopyTextButton value={briefing.sshCommand} label="Copy" />}
                />
                <p className="mt-2 text-[12.5px] text-[var(--dw-muted)]">
                  Amazon Linux uses <span className="font-mono">ec2-user</span>. On macOS/Linux run <span className="font-mono">chmod 400</span> on the PEM first. On Windows, OpenSSH works with the PEM, or download the PPK for PuTTY.
                </p>
              </div>
            ) : null}
            {briefing.rdsCommand ? (
              <div>
                <div className="mb-2 font-mono text-[11px] uppercase tracking-[0.16em] text-[var(--dw-faint)]">RDS</div>
                <CodeSurface
                  code={briefing.rdsCommand}
                  language="bash"
                  filename="psql"
                  maxHeight="6rem"
                  actions={<CopyTextButton value={briefing.rdsCommand} label="Copy" />}
                />
                <p className="mt-2 text-[12.5px] text-[var(--dw-muted)]">
                  Run this from the app instance (or another host in the VPC). The database is not publicly reachable.
                </p>
              </div>
            ) : null}
            {briefing.redisCommand ? (
              <div>
                <div className="mb-2 font-mono text-[11px] uppercase tracking-[0.16em] text-[var(--dw-faint)]">Redis</div>
                <CodeSurface
                  code={briefing.redisCommand}
                  language="bash"
                  filename="redis-cli"
                  maxHeight="6rem"
                  actions={<CopyTextButton value={briefing.redisCommand} label="Copy" />}
                />
              </div>
            ) : null}
          </div>
        </Panel>
      ) : null}

      <div className={`grid grid-cols-1 gap-5 ${briefing.strategy === 'ec2' ? 'xl:grid-cols-2' : ''}`}>
        {briefing.strategy === 'ec2' ? (
        <Panel>
          <SectionLabel>Keys &amp; secrets</SectionLabel>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={onDownloadPem} disabled={!generatedPem} className={`${secondaryButtonClass(!generatedPem)} flex-1 text-[12px]`}>
              <Download className="h-4 w-4" /> Download .PEM
            </button>
            <button type="button" onClick={onDownloadPpk} disabled={!generatedPem} className={`${secondaryButtonClass(!generatedPem)} flex-1 text-[12px]`}>
              <Download className="h-4 w-4" /> Download .PPK
            </button>
            {onDownloadDatabase ? (
              <button type="button" onClick={onDownloadDatabase} disabled={!databaseEnv} className={`${secondaryButtonClass(!databaseEnv)} flex-1 text-[12px]`}>
                <Download className="h-4 w-4" /> Database password
              </button>
            ) : null}
          </div>
          {briefing.keyName ? (
            <p className="mt-3 font-mono text-[12px] text-[var(--dw-muted)]">Key pair: {briefing.keyName}</p>
          ) : null}
          {!generatedPem && !databaseEnv && keyPairMessage ? (
            <Callout tone="warn" className="mt-4">{keyPairMessage}</Callout>
          ) : generatedPem || databaseEnv ? (
            <Callout tone="info" className="mt-4">
              Download now. After you save the files, DeplAI deletes them. The next deploy creates a new SSH key tagged with the new instance ID; the previous PEM will not work.
            </Callout>
          ) : null}
        </Panel>
        ) : null}
        {briefing.observability.length > 0 ? (
          <Panel>
            <SectionLabel>Ops &amp; console</SectionLabel>
            <SpecList rows={briefing.observability} />
          </Panel>
        ) : (
          <Panel>
            <SectionLabel>Ops &amp; console</SectionLabel>
            <p className="text-[13px] text-[var(--dw-muted)]">Console links and log groups appear after a successful apply.</p>
            {briefing.consoleUrl ? (
              <button
                type="button"
                onClick={() => window.open(briefing.consoleUrl || '', '_blank', 'noopener,noreferrer')}
                className={`${buttonClass('secondary', { size: 'sm' })} mt-3`}
              >
                <ExternalLink className="h-4 w-4" /> Open AWS console
              </button>
            ) : null}
          </Panel>
        )}
      </div>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
        {briefing.compute.length > 0 ? (
          <Panel>
            <SectionLabel>Compute specs</SectionLabel>
            <SpecList rows={briefing.compute} />
          </Panel>
        ) : null}
        {briefing.networking.length > 0 ? (
          <Panel>
            <SectionLabel>Networking</SectionLabel>
            <SpecList rows={briefing.networking} />
          </Panel>
        ) : null}
      </div>

      {briefing.data.length > 0 ? (
        <Panel>
          <SectionLabel>Data stores</SectionLabel>
          <p className="mb-3 text-[12.5px] text-[var(--dw-muted)]">
            These endpoints are private. The app reaches them from the VPC; they are not meant to be opened in a browser.
          </p>
          <SpecList rows={briefing.data} />
        </Panel>
      ) : null}

      {consoleSlot ? (
        <div className="dw-no-scroll-anchor" style={{ overflowAnchor: 'none' }} data-no-scroll-anchor="true">
          {consoleSlot}
        </div>
      ) : null}

      {showOauthPanel && (
        <Panel>
          <SectionLabel>OAuth callback URLs</SectionLabel>
          <p className="text-[12.5px] leading-relaxed text-[var(--dw-muted)]">
            Register these redirect URLs in Google / GitHub (or other) OAuth consoles. Save client secrets in App Secrets, then reboot the instance so it reloads Secrets Manager.
          </p>
          {oauthAppUrl ? (
            <p className="mt-3 break-all font-mono text-[13px] text-[var(--dw-fg)]">{oauthAppUrl}</p>
          ) : (
            <p className="mt-3 text-[12px] text-[var(--dw-warn)]">App URL not available yet — deploy first, then register callbacks.</p>
          )}
          {oauthCallbackPaths.length > 0 && (
            <ul className="mt-3 space-y-2">
              {oauthCallbackPaths.map((path) => {
                const url = oauthAppUrl ? `${oauthAppUrl.replace(/\/$/, '')}${path}` : path;
                return (
                  <li key={path} className="flex items-start justify-between gap-3">
                    <span className="min-w-0 break-all font-mono text-[12px] text-[var(--dw-muted)]">{url}</span>
                    <CopyIconButton value={url} label={path} />
                  </li>
                );
              })}
            </ul>
          )}
          {missingOauthSecrets ? (
            <Callout tone="warn" className="mt-3">
              Missing Google/GitHub (or other) keys in App Secrets — login providers will fail until those values are saved.
            </Callout>
          ) : null}
        </Panel>
      )}

      {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}

      <Panel>
        <SectionLabel>Endpoint verification</SectionLabel>
        {endpointChecks.length > 0 ? (
          <div className="space-y-3">
            {endpointChecks.map((check) => (
              <div key={`${check.label}-${check.url || 'empty'}`} className={`${paperInsetClass} p-4`}>
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-[13px] font-medium text-[var(--dw-fg)]">{check.label}</div>
                    <div className="mt-1 break-all font-mono text-[12px] text-[var(--dw-muted)]">{check.url || 'n/a'}</div>
                  </div>
                  <StatusPill tone={check.ok ? 'ok' : 'danger'}>
                    {check.ok ? `HTTP ${check.status ?? 200}` : (check.status ? `HTTP ${check.status}` : 'Unreachable')}
                  </StatusPill>
                </div>
                {check.detail ? <div className="mt-3 text-[12px] leading-relaxed text-[var(--dw-muted)]">{check.detail}</div> : null}
              </div>
            ))}
          </div>
        ) : (
          <EmptyState
            title="No verification yet"
            description={canVerify ? 'Run Verify live endpoints to test the deployed URLs.' : 'Verification is unavailable until this repo has a successful deploy and live runtime details.'}
          />
        )}
      </Panel>

      {visibleRaw.length > 0 ? (
        <Panel>
          <SectionLabel>All Terraform outputs</SectionLabel>
          <p className="mb-3 text-[12.5px] text-[var(--dw-muted)]">Raw values returned by apply. Empty and secret outputs are hidden.</p>
          <SpecList
            rows={visibleRaw.map((entry) => ({
              label: entry.label || entry.key,
              value: Array.isArray(entry.value) ? entry.value.join(', ') : String(entry.value),
              copy: true,
            }))}
          />
        </Panel>
      ) : null}

      <Panel>
        <SectionLabel>Deployment history</SectionLabel>
        <div className="space-y-3">
          {history.length === 0 ? (
            <EmptyState title="No runs yet" description="Successful or failed deploys for this workspace will appear here." />
          ) : (
            history.map((entry) => (
              <div key={entry.id} className={`flex items-center justify-between gap-3 ${paperInsetClass} p-4`}>
                <div>
                  <p className="text-[13px] font-medium text-[var(--dw-fg)]">{new Date(entry.createdAt).toLocaleString()}</p>
                  <p className="mt-1 font-mono text-[12px] text-[var(--dw-muted)]">
                    {entry.instanceId && entry.instanceId !== 'n/a' ? `EC2: ${entry.instanceId}` : briefing.strategyLabel}
                  </p>
                </div>
                <StatusPill tone={entry.status === 'done' ? 'ok' : 'danger'}>
                  {entry.status === 'done' ? 'Success' : 'Error'}
                </StatusPill>
              </div>
            ))
          )}
        </div>
      </Panel>
    </div>
  );
}
