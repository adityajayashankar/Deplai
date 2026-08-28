'use client';

import React, { useMemo } from 'react';
import {
  ArrowLeft,
  Check,
  ChevronRight,
  Database,
  GitBranch,
  RotateCcw,
  Send,
} from 'lucide-react';
import type { ArchitectureQuestion, RepositoryContextJson } from '@/features/deployment/state';
import {
  Chip,
  EmptyState,
  KeyValueRow,
  Panel,
  PanelHeader,
  SectionLabel,
  Skeleton,
  StatCard,
  StatusPill,
  StickyActionBar,
  buttonClass,
  paperInsetClass,
  pipelinePrimaryButtonClass,
} from '@/features/deployment/deployment-ui';
import {
  WorkspaceNav,
} from '@/features/workspace/WorkspaceNav';

export type PipelineStageId =
  | 'analysis'
  | 'qa'
  | 'architecture'
  | 'cost_estimation'
  | 'terraform'
  | 'aws_config'
  | 'app_secrets'
  | 'deploy'
  | 'outputs';

export type PipelineDisplayStepId = Exclude<PipelineStageId, 'aws_config'>;

export const PIPELINE_STEPS: Array<{
  id: PipelineDisplayStepId;
  label: string;
}> = [
  { id: 'analysis', label: 'Analysis' },
  { id: 'qa', label: 'Planning' },
  { id: 'architecture', label: 'Architecture' },
  { id: 'cost_estimation', label: 'Approval' },
  { id: 'terraform', label: 'Terraform' },
  { id: 'app_secrets', label: 'Secrets' },
  { id: 'deploy', label: 'Deploy' },
  { id: 'outputs', label: 'Outputs' },
];

export function pipelineStageToStepIndex(stage: PipelineStageId): number {
  const map: Record<PipelineStageId, number> = {
    analysis: 0,
    qa: 1,
    architecture: 2,
    cost_estimation: 3,
    terraform: 4,
    aws_config: 4,
    app_secrets: 5,
    deploy: 6,
    outputs: 7,
  };
  return map[stage] ?? 0;
}

export function stepIdToStage(stepId: PipelineDisplayStepId, currentStage: PipelineStageId): PipelineStageId {
  if (stepId === 'terraform' && currentStage === 'aws_config') return 'aws_config';
  return stepId;
}

const focusRing =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-black/35 focus-visible:ring-offset-2 focus-visible:ring-offset-white';

export function DeploymentWorkspaceNav({
  workspaceName,
  projectId,
  onNavigate,
}: {
  workspaceName: string;
  projectId?: string | null;
  onNavigate: (href: string) => void;
}) {
  return (
    <WorkspaceNav
      active="deployment"
      workspaceName={workspaceName}
      projectId={projectId}
      onNavigate={onNavigate}
    />
  );
}

export function DeploymentCommandHeader({ onExit }: { onExit: () => void }) {
  return (
    <header className="workspace-command-header flex h-12 shrink-0 items-center justify-between border-b border-white/10 bg-[var(--app-canvas,#05060a)] px-5 sm:px-6 md:pr-20">
      <nav aria-label="Breadcrumb" className="flex items-center gap-2.5 text-[13px]">
        <span className="font-mono text-[12px] uppercase tracking-[0.16em] text-white/40">deplai</span>
        <ChevronRight className="h-3.5 w-3.5 text-white/30" />
        <span className="font-display font-semibold text-white">Deployment</span>
      </nav>
      <div className="flex items-center gap-2.5">
        <div className="hidden items-center gap-2 border-2 border-white/20 px-3 py-1.5 font-mono text-[11px] text-white/50 sm:flex">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
          All systems operational
        </div>
        <button
          type="button"
          onClick={onExit}
          className="inline-flex h-8 items-center gap-2 border-2 border-white/20 px-3 text-[12px] font-bold text-white/80 transition hover:border-white hover:bg-white hover:text-black"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Exit
        </button>
      </div>
    </header>
  );
}

export function DeploymentPipelineHeader({
  projects,
  selectedProjectId,
  onSelectProject,
  onRestart,
  restartDisabled,
}: {
  projects: Array<{ id: string; name: string }>;
  selectedProjectId: string | null;
  onSelectProject: (projectId: string) => void;
  onRestart: () => void;
  restartDisabled?: boolean;
}) {
  return (
    <div className="flex shrink-0 flex-wrap items-end justify-between gap-4 border-b-[3px] border-black bg-white px-5 pb-4 pt-5 sm:px-8">
      <div className="min-w-0">
        <p className="mb-1.5 font-mono text-[10px] font-medium uppercase tracking-[0.2em] text-neutral-500">
          Pipeline
        </p>
        <h1 className="text-[20px] font-semibold tracking-tight text-black sm:text-[22px]">
          Deployment
        </h1>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {projects.length > 0 ? (
          <label className="relative">
            <span className="sr-only">Select repository</span>
            <GitBranch className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-neutral-500" />
            <select
              value={selectedProjectId || ''}
              onChange={(event) => {
                const next = event.target.value.trim();
                if (next) onSelectProject(next);
              }}
              className={`h-9 min-w-56 appearance-none rounded-none border-[3px] border-black bg-white pl-8 pr-8 text-[13px] text-black ${focusRing}`}
            >
              {!selectedProjectId ? <option value="">Select repository</option> : null}
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
            <ChevronRight className="pointer-events-none absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 rotate-90 text-neutral-500" />
          </label>
        ) : null}
        <button
          type="button"
          onClick={onRestart}
          disabled={restartDisabled}
          className={`inline-flex h-9 items-center gap-2 rounded-none border-[3px] border-black bg-white px-3 text-[13px] font-bold text-black shadow-[4px_4px_0_0_#000] transition-transform hover:translate-x-0.5 hover:translate-y-0.5 hover:shadow-none disabled:cursor-not-allowed disabled:opacity-40 ${focusRing}`}
        >
          <RotateCcw className="h-3.5 w-3.5" />
          Restart
        </button>
      </div>
    </div>
  );
}

/**
 * Horizontal stage rail. The connector between nodes fills to show progress,
 * and `stepIdToStage` keeps the hidden `aws_config` stage mapped onto the
 * shared `terraform` step index.
 */
export function DeploymentStageRail({
  activeStage,
  onSelectStage,
}: {
  activeStage: PipelineStageId;
  onSelectStage: (stage: PipelineStageId) => void;
}) {
  const activeIndex = pipelineStageToStepIndex(activeStage);
  const total = PIPELINE_STEPS.length;
  const percent = total > 1 ? Math.round((activeIndex / (total - 1)) * 100) : 0;
  const activeLabel = PIPELINE_STEPS[activeIndex]?.label || 'Analysis';

  return (
    <div className="shrink-0 border-b-[3px] border-black bg-white px-5 pb-4 sm:px-8">
      <div className="mb-3 flex items-end justify-between gap-4">
        <p className="font-mono text-[10px] font-medium uppercase tracking-[0.2em] text-neutral-500">
          Stages
        </p>
        <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-neutral-500">
          <span className="text-black">{String(activeIndex + 1).padStart(2, '0')}</span>
          <span className="text-neutral-400"> / {String(total).padStart(2, '0')}</span>
          <span className="mx-2 text-neutral-300">·</span>
          <span className="text-black">{activeLabel}</span>
          <span className="mx-2 text-neutral-300">·</span>
          <span className="text-neutral-600">{percent}%</span>
        </p>
      </div>

      <div className="mb-4 h-px w-full bg-neutral-200" aria-hidden="true">
        <div
          className="h-px bg-black transition-[width] duration-500 ease-out"
          style={{ width: `${percent}%` }}
        />
      </div>

      <ol className="dw-scrollbar flex items-stretch overflow-x-auto">
        {PIPELINE_STEPS.map((step, index) => {
          const complete = index < activeIndex;
          const active = index === activeIndex;
          const locked = index > activeIndex;

          return (
            <li key={step.id} className="flex min-w-0 flex-1 items-center">
              <button
                type="button"
                disabled={locked}
                onClick={() => onSelectStage(stepIdToStage(step.id, activeStage))}
                aria-current={active ? 'step' : undefined}
                title={step.label}
                className={`flex min-w-0 items-center gap-2.5 border-b-[3px] py-2 pr-3 text-left transition-colors ${focusRing} ${
                  locked
                    ? 'cursor-not-allowed border-transparent'
                    : active
                      ? 'border-black'
                      : 'cursor-pointer border-transparent hover:border-black/30'
                }`}
              >
                <span
                  className={`flex h-6 w-6 shrink-0 items-center justify-center border-[2px] border-black font-mono text-[10px] font-medium ${
                    complete || active
                      ? 'bg-black text-white'
                      : 'bg-white text-neutral-500'
                  }`}
                >
                  {complete ? <Check className="h-3 w-3" strokeWidth={2.2} /> : String(index + 1).padStart(2, '0')}
                </span>
                <span
                  className={`hidden truncate text-[12px] tracking-tight md:inline ${
                    active
                      ? 'font-bold text-black'
                      : complete
                        ? 'text-neutral-700'
                        : 'text-neutral-500'
                  }`}
                >
                  {step.label}
                </span>
              </button>
              {index < total - 1 ? (
                <span
                  aria-hidden="true"
                  className="relative mx-1 hidden h-px min-w-3 flex-1 bg-neutral-200 sm:block"
                >
                  <span
                    className="absolute inset-y-0 left-0 bg-black transition-[width] duration-500 ease-out"
                    style={{ width: complete ? '100%' : '0%' }}
                  />
                </span>
              ) : null}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/** @deprecated Use `DeploymentStageRail`. */
export const PipelineStepper = DeploymentStageRail;

export type AnalysisMetrics = {
  runtime: string;
  framework: string;
  ports: string;
  dependencies: string;
};

export function deriveAnalysisMetrics(repoContext: RepositoryContextJson | null): AnalysisMetrics {
  if (!repoContext) {
    return { runtime: '—', framework: '—', ports: '—', dependencies: '—' };
  }

  const runtime = String(repoContext.language?.runtime || repoContext.language?.primary || 'Unknown');
  const frameworks = Array.isArray(repoContext.frameworks) ? repoContext.frameworks : [];
  const frameworkNames = frameworks
    .map((item) => String(item?.name || '').trim())
    .filter(Boolean);
  const framework = frameworkNames[0] || 'Unknown';

  const build = repoContext.build || {};
  const health = repoContext.health || {};
  const portCandidate =
    build.dockerfile_port ??
    health.port ??
    (Array.isArray(repoContext.processes)
      ? repoContext.processes.find((item) => item && typeof item === 'object' && 'port' in item)?.port
      : undefined);
  const ports = portCandidate ? String(portCandidate) : '8000';

  const detectedNames = repoContext.language?.detected_names;
  let dependencyCount = 0;
  if (Array.isArray(detectedNames)) {
    dependencyCount = detectedNames.length;
  } else if (typeof repoContext.language?.dependency_count === 'number') {
    dependencyCount = repoContext.language.dependency_count as number;
  } else {
    dependencyCount = frameworks.reduce((sum, item) => {
      const signals = Array.isArray(item?.signals) ? item.signals.length : 0;
      return sum + Math.max(signals, 1);
    }, 0);
  }

  return {
    runtime,
    framework,
    ports,
    dependencies: dependencyCount > 0 ? String(dependencyCount) : '—',
  };
}

export type DetectedService = {
  name: string;
  detail: string;
  confidence: 'high' | 'medium' | 'low';
};

export function deriveDetectedServices(repoContext: RepositoryContextJson | null): DetectedService[] {
  if (!repoContext) return [];

  const services: DetectedService[] = [];
  const dataStores = Array.isArray(repoContext.data_stores) ? repoContext.data_stores : [];

  for (const raw of dataStores) {
    const type = String(raw?.type || '').trim();
    if (!type) continue;
    const confidenceRaw = String(raw?.confidence || 'medium').toLowerCase();
    const confidence: DetectedService['confidence'] =
      confidenceRaw === 'high' ? 'high' : confidenceRaw === 'low' ? 'low' : 'medium';
    const signals = Array.isArray(raw?.signals)
      ? raw.signals.map((item) => String(item || '').trim()).filter(Boolean)
      : [];
    const signalHint = signals.find((signal) => signal.startsWith('dependency:'));
    const detail = signalHint
      ? `found '${signalHint.replace('dependency:', '')}' dependency`
      : signals.length > 0
        ? signals.slice(0, 2).join(', ')
        : `${type} signals detected in repository scan`;
    services.push({
      name: type.replace(/_/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase()),
      detail,
      confidence,
    });
  }

  const hints = repoContext.infrastructure_hints || {};
  if (Boolean(hints.s3_or_uploads) || Boolean(hints.file_uploads)) {
    services.push({
      name: 'S3 Bucket',
      detail: 'file upload handlers detected in routes',
      confidence: 'medium',
    });
  }

  const hasRedis = dataStores.some((item) => String(item?.type || '').toLowerCase().includes('redis'));
  if (!hasRedis) {
    services.push({
      name: 'Redis',
      detail: 'no clear caching layer detected, may be required',
      confidence: 'low',
    });
  }

  return services;
}

function confidenceTone(confidence: DetectedService['confidence']): 'accent' | 'warn' | 'neutral' {
  if (confidence === 'high') return 'accent';
  if (confidence === 'medium') return 'warn';
  return 'neutral';
}

export function AnalysisMetricCards({ metrics, loading = false }: { metrics: AnalysisMetrics; loading?: boolean }) {
  const cards = [
    { label: 'Runtime', value: metrics.runtime },
    { label: 'Framework', value: metrics.framework },
    { label: 'Ports', value: metrics.ports },
    { label: 'Dependencies', value: metrics.dependencies },
  ];

  return (
    <div className="grid grid-cols-2 gap-3.5 lg:grid-cols-4">
      {cards.map((card) => (
        <StatCard key={card.label} label={card.label} value={card.value} loading={loading} />
      ))}
    </div>
  );
}

export function DetectedServicesList({ services, loading = false }: { services: DetectedService[]; loading?: boolean }) {
  return (
    <Panel padded={false}>
      <SectionLabel className="mb-0 px-5 pt-4">Detected services</SectionLabel>
      <div className="px-5 pb-5 pt-3">
        {loading ? (
          <div className="space-y-2.5">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
        ) : services.length === 0 ? (
          <EmptyState
            icon={<Database className="h-5 w-5" />}
            title="No external services detected"
            description="The scan found no databases, caches, or object storage in this repository. The plan will provision compute only."
          />
        ) : (
          <ul className="space-y-2.5">
            {services.map((service, index) => (
              <li
                key={`${service.name}-${index}`}
                className={`flex items-start justify-between gap-4 ${paperInsetClass} px-4 py-3.5 transition-colors hover:bg-neutral-50`}
              >
                <div className="min-w-0">
                  <div className="text-[13.5px] font-semibold text-[var(--dw-fg)]">{service.name}</div>
                  <div className="mt-1 text-[12.5px] leading-relaxed text-[var(--dw-muted)]">{service.detail}</div>
                </div>
                <Chip
                  tone={confidenceTone(service.confidence)}
                  mono
                  className="shrink-0 uppercase tracking-[0.14em]"
                >
                  {service.confidence}
                </Chip>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Panel>
  );
}

export function AnalysisStagePanel({
  loading,
  metrics,
  services,
  continueDisabled,
  onContinue,
}: {
  loading: boolean;
  metrics: AnalysisMetrics;
  services: DetectedService[];
  continueDisabled: boolean;
  onContinue: () => void;
}) {
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-5">
      {loading ? (
        <Panel className="flex items-center gap-3" glow>
          <StatusPill tone="accent" live>
            Scanning
          </StatusPill>
          <span className="text-[13px] text-[var(--dw-fg-soft)]">
            Reading the codebase and waiting on the Agentic Layer…
          </span>
        </Panel>
      ) : null}
      <AnalysisMetricCards metrics={metrics} loading={loading} />
      <DetectedServicesList services={services} loading={loading} />
      <StickyActionBar
        hint={loading ? 'The scan must finish before planning can start.' : 'Scan complete. Hand off to the planning agent.'}
      >
        <button
          type="button"
          onClick={onContinue}
          disabled={continueDisabled}
          className={pipelinePrimaryButtonClass(continueDisabled)}
        >
          {loading ? 'Scanning repository…' : 'Continue to planning →'}
        </button>
      </StickyActionBar>
    </div>
  );
}

export function PlanningAgentPanel({
  projectName,
  loading,
  messages,
  input,
  onInputChange,
  onSubmit,
  submitDisabled,
  onContinue,
  continueDisabled,
  budgetChips,
  onSelectBudget,
  showDecision,
  onRefine,
  approved,
  planSummary,
  planNotes,
  region,
  estimateUsd,
  budgetUsd,
  componentRows,
  deploySequence,
  currentQuestion,
  questionIndex,
  questionTotal,
  onSelectOption,
  onSkip,
  questionsComplete,
  onRetryGenerate,
  selectedValue,
  currentAnswered,
  previousAnswers,
  onJumpToQuestion,
  onBack,
  onNext,
  backDisabled,
  nextDisabled,
  nextLabel,
}: {
  projectName: string;
  loading: boolean;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  input: string;
  onInputChange: (value: string) => void;
  onSubmit: () => void;
  submitDisabled: boolean;
  onContinue: () => void;
  continueDisabled: boolean;
  budgetChips?: number[];
  onSelectBudget?: (cap: number) => void;
  showDecision?: boolean;
  onRefine?: () => void;
  approved?: boolean;
  planSummary?: string;
  planNotes?: string[];
  region?: string;
  estimateUsd?: number;
  budgetUsd?: number;
  componentRows?: Array<{ name: string; details: string }>;
  deploySequence?: string[];
  currentQuestion?: ArchitectureQuestion | null;
  questionIndex?: number;
  questionTotal?: number;
  onSelectOption?: (value: string) => void;
  onSkip?: () => void;
  questionsComplete?: boolean;
  onRetryGenerate?: () => void;
  selectedValue?: string;
  currentAnswered?: boolean;
  previousAnswers?: Array<{ index: number; prompt: string; answer: string }>;
  onJumpToQuestion?: (index: number) => void;
  onBack?: () => void;
  onNext?: () => void;
  backDisabled?: boolean;
  nextDisabled?: boolean;
  nextLabel?: string;
}) {
  const latestAssistant = useMemo(() => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index]?.role === 'assistant') return messages[index];
    }
    return null;
  }, [messages]);

  const introMessage =
    latestAssistant?.content ||
    (loading
      ? `Analyzing \`${projectName}\` — preparing deployment questions from the scan...`
      : `I've analyzed \`${projectName}\`. I'll ask a short set of questions so we can generate the AWS plan.`);
  const awaitingPlan = Boolean(questionsComplete && !showDecision && !currentQuestion);
  const scripted = Boolean(currentQuestion && !showDecision);
  const questionOptions = currentQuestion?.options || [];
  const isFreeText = scripted && questionOptions.length === 0;
  const progressLabel =
    typeof questionIndex === 'number' && typeof questionTotal === 'number' && questionTotal > 0
      ? `Question ${questionIndex + 1} of ${questionTotal}`
      : null;

  const notes = (planNotes || []).filter(Boolean);
  const rows = componentRows || [];
  const sequence = deploySequence || [];
  const showBudget = Boolean(budgetChips?.length && onSelectBudget && !showDecision);

  return (
    <div className="flex w-full flex-col gap-5">
      {showDecision ? (
        <Panel elevation="raised" padded={false}>
          <PanelHeader
            title="Proposed plan"
            subtitle={approved ? 'Locked. Continue to architecture when you are ready.' : 'Review this setup, then continue. You can still change answers first.'}
            actions={
              <StatusPill tone={approved ? 'ok' : 'accent'}>
                {approved ? 'Ready' : 'Draft'}
              </StatusPill>
            }
          />
          <div className="space-y-5 p-5 sm:p-6">
            {notes.length > 0 ? (
              <ul className="space-y-2.5 text-[14px] leading-7 text-[var(--dw-fg)]">
                {notes.map((note, index) => (
                  <li key={`${index}-${note.slice(0, 24)}`} className="border-l-[3px] border-black pl-3">
                    {note}
                  </li>
                ))}
              </ul>
            ) : planSummary ? (
              <p className="whitespace-pre-wrap text-[14px] leading-7 text-[var(--dw-fg)]">{planSummary}</p>
            ) : null}

            <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_220px]">
              <div>
                <SectionLabel>Services</SectionLabel>
                {rows.length > 0 ? (
                  <ul className="divide-y divide-black/15 border-y border-black/15">
                    {rows.map((row) => (
                      <li key={row.name} className="flex flex-wrap items-baseline justify-between gap-2 py-2.5">
                        <span className="text-[14px] font-semibold text-black">{row.name}</span>
                        {row.details ? (
                          <span className="font-mono text-[12px] text-neutral-500">{row.details}</span>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-[13px] text-[var(--dw-muted)]">No services in this draft yet.</p>
                )}
                {sequence.length > 1 ? (
                  <div className="mt-4">
                    <SectionLabel>Bring-up order</SectionLabel>
                    <ol className="mt-1 flex flex-wrap items-center gap-1.5 text-[12.5px] text-black">
                      {sequence.map((step, index) => (
                        <li key={`${step}-${index}`} className="flex items-center gap-1.5">
                          <span className="font-mono">{step}</span>
                          {index < sequence.length - 1 ? (
                            <ChevronRight className="h-3.5 w-3.5 text-neutral-400" />
                          ) : null}
                        </li>
                      ))}
                    </ol>
                  </div>
                ) : null}
              </div>
              <div>
                <SectionLabel>Facts</SectionLabel>
                <KeyValueRow label="Region" value={region || '—'} />
                <KeyValueRow
                  label="Budget"
                  value={budgetUsd && budgetUsd > 0 ? `$${budgetUsd.toFixed(0)}/mo` : 'unset'}
                />
                <KeyValueRow
                  label="Estimate"
                  value={estimateUsd && estimateUsd > 0 ? `$${estimateUsd.toFixed(0)}/mo` : 'pending'}
                  tone={estimateUsd && budgetUsd && estimateUsd > budgetUsd ? 'warn' : 'neutral'}
                />
              </div>
            </div>

            {onRefine ? (
              <button
                type="button"
                onClick={onRefine}
                disabled={loading}
                className={buttonClass('ghost', { disabled: loading, size: 'sm' })}
              >
                Change answers
              </button>
            ) : null}
          </div>
        </Panel>
      ) : (
        <Panel elevation="raised" padded={false} glow={loading}>
          <PanelHeader
            title="Planning"
            subtitle={
              loading
                ? awaitingPlan
                  ? 'Building the AWS plan from your answers…'
                  : 'Preparing the next question…'
                : awaitingPlan
                  ? 'The questionnaire is complete. Generate the plan to continue.'
                  : progressLabel
                    ? `${progressLabel} for ${projectName}`
                    : `Answer a few questions for ${projectName}.`
            }
            actions={
              <StatusPill tone={loading ? 'agent' : awaitingPlan ? 'warn' : 'neutral'} live={loading}>
                {loading ? 'Working' : awaitingPlan ? 'Plan not locked' : progressLabel || 'Awaiting answer'}
              </StatusPill>
            }
          />
          <div className="space-y-4 p-5 sm:p-6">
            {previousAnswers && previousAnswers.length > 0 ? (
              <div>
                <SectionLabel>Your answers</SectionLabel>
                <ul className="divide-y divide-black/15 border-y border-black/15">
                  {previousAnswers.map((item) => (
                    <li key={`${item.index}-${item.prompt.slice(0, 24)}`} className="flex items-start justify-between gap-3 py-2.5">
                      <div className="min-w-0">
                        <div className="font-mono text-[10.5px] uppercase tracking-[0.16em] text-[var(--dw-muted)]">
                          Question {item.index + 1}
                        </div>
                        <div className="mt-0.5 truncate text-[13px] text-[var(--dw-fg)]" title={item.prompt}>
                          {item.answer}
                        </div>
                      </div>
                      {onJumpToQuestion ? (
                        <button
                          type="button"
                          onClick={() => onJumpToQuestion(item.index)}
                          disabled={loading}
                          className={buttonClass('ghost', { disabled: loading, size: 'sm' })}
                        >
                          Change
                        </button>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {awaitingPlan ? (
              <div className="space-y-3">
                <p className="text-[14.5px] leading-7 text-[var(--dw-fg)]">
                  {loading
                    ? 'Locking compute, networking, and data-layer choices into an AWS plan.'
                    : 'Answers are saved. Go back to change any of them, or generate the plan to continue.'}
                </p>
                {onRetryGenerate && !loading ? (
                  <button
                    type="button"
                    onClick={onRetryGenerate}
                    className={buttonClass('primary')}
                  >
                    Generate plan
                  </button>
                ) : null}
              </div>
            ) : (
            <p className="whitespace-pre-wrap text-[14.5px] leading-7 text-[var(--dw-fg)]">
              {introMessage.split(/(`[^`]+`)/g).map((part, index) =>
                part.startsWith('`') && part.endsWith('`') ? (
                  <code
                    key={index}
                    className="rounded-none border-[2px] border-black bg-white px-1.5 py-0.5 font-mono text-[12.5px]"
                  >
                    {part.slice(1, -1)}
                  </code>
                ) : (
                  <React.Fragment key={index}>{part}</React.Fragment>
                ),
              )}
            </p>
            )}
            {scripted && questionOptions.length > 0 ? (
              <div>
                <SectionLabel>{currentAnswered ? 'Your choice' : 'Choose one'}</SectionLabel>
                <div className="grid gap-2">
                  {questionOptions.map((option) => {
                    const selected = currentAnswered && selectedValue === option.value;
                    return (
                    <button
                      key={option.value}
                      type="button"
                      onClick={() => onSelectOption?.(option.value)}
                      disabled={loading}
                      aria-pressed={selected}
                      className={`rounded-none border-[3px] border-black px-3 py-2.5 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${focusRing} ${
                        selected ? 'bg-black text-white' : 'bg-white hover:bg-black hover:text-white'
                      }`}
                    >
                      <div className="text-[13px] font-semibold">{option.label}</div>
                      {option.description ? (
                        <div className="mt-0.5 text-[12px] leading-relaxed opacity-80">{option.description}</div>
                      ) : null}
                    </button>
                    );
                  })}
                </div>
              </div>
            ) : null}
            {isFreeText ? (
              <div>
                <SectionLabel>{currentQuestion?.required === false ? 'Optional' : 'Your answer'}</SectionLabel>
                <div className="flex flex-wrap gap-2">
                  {currentQuestion?.required === false && onSkip ? (
                    <button
                      type="button"
                      onClick={onSkip}
                      disabled={loading}
                      aria-pressed={currentAnswered && selectedValue === ''}
                      className={`rounded-none border-[3px] border-black px-3 py-1.5 font-mono text-[12px] transition-all disabled:cursor-not-allowed disabled:opacity-40 ${focusRing} ${
                        currentAnswered && selectedValue === ''
                          ? 'bg-black text-white'
                          : 'bg-white text-black hover:bg-black hover:text-white'
                      }`}
                    >
                      Skip
                    </button>
                  ) : null}
                </div>
              </div>
            ) : null}
            {showBudget && !scripted ? (
              <div>
                <SectionLabel>Quick budget</SectionLabel>
                <div className="flex flex-wrap gap-2">
                  {budgetChips!.map((cap) => (
                    <button
                      key={cap}
                      type="button"
                      onClick={() => onSelectBudget!(cap)}
                      disabled={loading}
                      className={`rounded-none border-[3px] border-black bg-white px-3 py-1.5 font-mono text-[12px] text-black transition-all hover:bg-black hover:text-white disabled:cursor-not-allowed disabled:opacity-40 ${focusRing}`}
                    >
                      ${cap}/mo
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        </Panel>
      )}

      {scripted && isFreeText ? (
      <Panel padded="sm">
        {messages.length > 1 ? (
          <details className="mb-3">
            <summary className="cursor-pointer select-none list-none font-mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--dw-muted)]">
              Conversation · {messages.length} turns
            </summary>
            <div className="dw-scrollbar mt-3 max-h-56 space-y-3 overflow-y-auto pr-1">
              {messages.map((message, index) => (
                <div key={`${message.role}-${index}`} className="whitespace-pre-wrap leading-relaxed">
                  <span
                    className={`font-mono text-[9.5px] uppercase tracking-[0.18em] ${
                      message.role === 'assistant' ? 'text-[var(--dw-agent)]' : 'text-[var(--dw-faint)]'
                    }`}
                  >
                    {message.role === 'assistant' ? 'Agent' : 'You'}
                  </span>
                  <div className="mt-1 text-[13px] text-[var(--dw-fg-soft)]">{message.content}</div>
                </div>
              ))}
            </div>
          </details>
        ) : null}
        <div className="flex gap-2.5">
          <textarea
            value={input}
            onChange={(event) => onInputChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                onSubmit();
              }
            }}
            placeholder="example.com"
            disabled={loading || approved}
            className="dw-scrollbar min-h-[68px] flex-1 resize-none rounded-none border-[3px] border-black bg-white px-4 py-3 text-[13.5px] text-black outline-none transition-colors placeholder:text-neutral-500 focus:border-black disabled:cursor-not-allowed disabled:opacity-40"
          />
          <button
            type="button"
            onClick={onSubmit}
            disabled={submitDisabled}
            aria-label="Send answer"
            className={`${buttonClass('primary', { disabled: submitDisabled })} self-end`}
          >
            {loading ? '…' : <Send className="h-4 w-4" />}
          </button>
        </div>
      </Panel>
      ) : !scripted && !showDecision && !awaitingPlan ? (
      <Panel padded="sm">
        {messages.length > 1 ? (
          <details className="mb-3">
            <summary className="cursor-pointer select-none list-none font-mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--dw-muted)]">
              Conversation · {messages.length} turns
            </summary>
            <div className="dw-scrollbar mt-3 max-h-56 space-y-3 overflow-y-auto pr-1">
              {messages.map((message, index) => (
                <div key={`${message.role}-${index}`} className="whitespace-pre-wrap leading-relaxed">
                  <span
                    className={`font-mono text-[9.5px] uppercase tracking-[0.18em] ${
                      message.role === 'assistant' ? 'text-[var(--dw-agent)]' : 'text-[var(--dw-faint)]'
                    }`}
                  >
                    {message.role === 'assistant' ? 'Agent' : 'You'}
                  </span>
                  <div className="mt-1 text-[13px] text-[var(--dw-fg-soft)]">{message.content}</div>
                </div>
              ))}
            </div>
          </details>
        ) : null}
        <div className="flex gap-2.5">
          <textarea
            value={input}
            onChange={(event) => onInputChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                onSubmit();
              }
            }}
            placeholder="e.g. single-AZ is fine, ~100 users, $50/mo"
            disabled={loading || approved}
            className="dw-scrollbar min-h-[68px] flex-1 resize-none rounded-none border-[3px] border-black bg-white px-4 py-3 text-[13.5px] text-black outline-none transition-colors placeholder:text-neutral-500 focus:border-black disabled:cursor-not-allowed disabled:opacity-40"
          />
          <button
            type="button"
            onClick={onSubmit}
            disabled={submitDisabled}
            aria-label="Send message"
            className={`${buttonClass('primary', { disabled: submitDisabled })} self-end`}
          >
            {loading ? '…' : <Send className="h-4 w-4" />}
          </button>
        </div>
        <p className="mt-2 px-1 font-mono text-[10px] uppercase tracking-[0.16em] text-[var(--dw-muted)]">
          Enter to send · Shift + Enter for a new line
        </p>
      </Panel>
      ) : messages.length > 1 ? (
      <Panel padded="sm">
        <details>
          <summary className="cursor-pointer select-none list-none font-mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--dw-muted)]">
            Conversation · {messages.length} turns
          </summary>
          <div className="dw-scrollbar mt-3 max-h-56 space-y-3 overflow-y-auto pr-1">
            {messages.map((message, index) => (
              <div key={`${message.role}-${index}`} className="whitespace-pre-wrap leading-relaxed">
                <span
                  className={`font-mono text-[9.5px] uppercase tracking-[0.18em] ${
                    message.role === 'assistant' ? 'text-[var(--dw-agent)]' : 'text-[var(--dw-faint)]'
                  }`}
                >
                  {message.role === 'assistant' ? 'Agent' : 'You'}
                </span>
                <div className="mt-1 text-[13px] text-[var(--dw-fg-soft)]">{message.content}</div>
              </div>
            ))}
          </div>
        </details>
      </Panel>
      ) : null}

      <StickyActionBar
        hint={
          continueDisabled
            ? awaitingPlan
              ? loading
                ? 'Building the plan from your answers…'
                : 'Go back to change an answer, or generate the plan to unlock architecture.'
              : 'Use Back to change a previous answer. Continue unlocks architecture after the plan is ready.'
            : 'Continuing locks this plan and opens architecture.'
        }
      >
        {onBack && !showDecision ? (
          <button
            type="button"
            onClick={onBack}
            disabled={Boolean(backDisabled || loading)}
            className={`${buttonClass('secondary', { disabled: Boolean(backDisabled || loading) })} gap-2`}
          >
            <ArrowLeft className="h-4 w-4" />
            Back
          </button>
        ) : null}
        {onNext && scripted ? (
          <button
            type="button"
            onClick={onNext}
            disabled={Boolean(nextDisabled || loading)}
            className={buttonClass('secondary', { disabled: Boolean(nextDisabled || loading) })}
          >
            {nextLabel || 'Next question'}
          </button>
        ) : null}
        <button
          type="button"
          onClick={onContinue}
          disabled={continueDisabled}
          className={pipelinePrimaryButtonClass(continueDisabled)}
        >
          Continue to architecture →
        </button>
      </StickyActionBar>
    </div>
  );
}
