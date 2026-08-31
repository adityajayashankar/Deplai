'use client';

import { StatusPill } from '@/features/deployment/deployment-ui';

export type ProcessStep = {
  id: string;
  label: string;
};

type ProcessStatusTrackProps = {
  steps: ProcessStep[];
  activePhase: string;
  failed?: boolean;
  statusMessage?: string | null;
  className?: string;
};

export function normalizeProcessPhase(phase: string): string {
  const normalized = String(phase || '').trim().toLowerCase();
  const aliases: Record<string, string> = {
    pending: 'starting',
    selecting_params: 'starting',
    fmt: 'staging',
    validating: 'validate',
    planning: 'plan',
    applying: 'apply',
    running: 'apply',
    deployed: 'completed',
    needs_review: 'completed',
    awaiting_plan: 'awaiting_plan_confirmation',
    awaiting_plan_confirmation: 'awaiting_plan_confirmation',
    error: 'failed',
    preparing: 'starting',
    generating: 'generating',
    complete: 'completed',
  };
  return aliases[normalized] || normalized || 'starting';
}

export function progressForProcessPhase(phase: string, steps: ProcessStep[]): number {
  const normalized = normalizeProcessPhase(phase);
  if (normalized === 'failed') return 100;
  if (normalized === 'completed') return 100;
  const index = steps.findIndex((step) => step.id === normalized);
  if (index < 0) return 5;
  if (index >= steps.length - 1) return 100;
  const span = 100 / Math.max(steps.length - 1, 1);
  return Math.round(index * span);
}

export function ProcessStatusTrack({
  steps,
  activePhase,
  failed = false,
  statusMessage,
  className = '',
}: ProcessStatusTrackProps) {
  const normalized = normalizeProcessPhase(activePhase);
  const activeIndex = steps.findIndex((step) => step.id === normalized);
  const resolvedIndex = activeIndex >= 0 ? activeIndex : 0;

  return (
    <div className={`space-y-3 ${className}`.trim()}>
      <div className="flex flex-wrap items-center gap-2">
        {steps.map((step, index) => {
          const done = failed ? index < resolvedIndex : index < resolvedIndex;
          const active = index === resolvedIndex && !failed && normalized !== 'completed';
          const complete = !failed && (index < resolvedIndex || normalized === 'completed');
          return (
            <div key={step.id} className="flex items-center gap-2">
              <StatusPill
                tone={failed && active ? 'danger' : complete ? 'ok' : active ? 'accent' : 'neutral'}
                live={active}
              >
                {step.label}
              </StatusPill>
              {index < steps.length - 1 && (
                <span
                  className={`h-px w-6 ${complete ? 'bg-[var(--dw-accent)]' : 'bg-[var(--dw-border)]'}`}
                  aria-hidden="true"
                />
              )}
            </div>
          );
        })}
      </div>
      {statusMessage ? (
        <p className="text-[12px] leading-relaxed text-[var(--dw-muted)]">{statusMessage}</p>
      ) : null}
    </div>
  );
}

export const TERRAFORM_APPLY_STEPS: ProcessStep[] = [
  { id: 'starting', label: 'Starting' },
  { id: 'staging', label: 'Staging' },
  { id: 'init', label: 'Init' },
  { id: 'validate', label: 'Validate' },
  { id: 'plan', label: 'Plan' },
  { id: 'awaiting_plan_confirmation', label: 'Confirm' },
  { id: 'apply', label: 'Apply' },
  { id: 'completed', label: 'Complete' },
];

export const TERRAFORM_GENERATION_STEPS: ProcessStep[] = [
  { id: 'starting', label: 'Preparing' },
  { id: 'generating', label: 'Generating' },
  { id: 'completed', label: 'Complete' },
];

export const TERRAFORM_APPLY_STATUS_LABEL: Record<string, string> = {
  starting: 'Starting deployment…',
  staging: 'Staging Terraform bundle on the server…',
  init: 'Running terraform init…',
  validate: 'Validating Terraform configuration…',
  plan: 'Planning infrastructure changes…',
  awaiting_plan_confirmation: 'Plan ready — waiting for your confirmation.',
  apply: 'Applying changes in AWS (this can take 15–45 minutes)…',
  completed: 'Deployment finished.',
  failed: 'Deployment failed.',
};
