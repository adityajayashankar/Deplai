'use client';

import { useMemo, useState } from 'react';
import {
  COMPARE_BASELINE,
  COMPARE_PERFORMANCE_RECOMMENDATION,
  COMPARE_UPDATED,
  THINKING_EFFORT_BY_PROVIDER,
  effortNotesForModel,
  effortTiersForModel,
  formatEffortTier,
} from '@/lib/ai-platform/catalog/compare-reference';
import { CapabilityBar, Panel } from './ui';

type Model = {
  id: string;
  providerId: string;
  providerModelId: string;
  displayName: string;
  family: string;
  lifecycle: string;
  contextWindow: number;
  latencyProfile: string;
  capabilities: {
    reasoning: boolean;
    coding: boolean;
    agents: boolean;
    tools: boolean;
    vision: boolean;
    scores: Record<string, { value: number; source: string }>;
  };
  pricing: { inputPerMillionUsd: number | null; outputPerMillionUsd: number | null; source: string };
  metadata?: Record<string, unknown>;
};

type TaskId = 'security' | 'deploy' | 'customization' | 'agents' | 'cost';

const TASKS: Array<{
  id: TaskId;
  label: string;
  alias: string;
  blurb: string;
}> = [
  {
    id: 'security',
    label: 'Security analysis',
    alias: 'best_reasoning',
    blurb: 'Scan triage, finding write-ups, and remediation plans. Prefers reasoning plus tool use.',
  },
  {
    id: 'deploy',
    label: 'Infrastructure / deploy',
    alias: 'best_coding',
    blurb: 'Terraform, apply logs, and instance ops. Prefers coding plus multi-step agents.',
  },
  {
    id: 'customization',
    label: 'UI customization',
    alias: 'best_coding',
    blurb: 'Frontend diffs in the studio. Prefers coding with a faster latency profile.',
  },
  {
    id: 'agents',
    label: 'Multi-step agents',
    alias: 'best_agent',
    blurb: 'Tool-calling loops across security, deploy, and customization.',
  },
  {
    id: 'cost',
    label: 'High-volume / cost',
    alias: 'best_cost',
    blurb: 'Bulk summaries and classification where price matters more than peak reasoning.',
  },
];

function cap(model: Model, key: 'reasoning' | 'coding' | 'agentic', fallbackFlag: boolean): number {
  const scored = model.capabilities.scores[key]?.value;
  if (typeof scored === 'number') return scored;
  return fallbackFlag ? 7 : 2;
}

function cheapScore(model: Model): number {
  const price = model.pricing.outputPerMillionUsd ?? 15;
  return Math.max(0, 10 - Math.min(price, 40) / 4);
}

function fastScore(model: Model): number {
  if (model.latencyProfile === 'fast') return 10;
  if (model.latencyProfile === 'balanced') return 6;
  return 3;
}

function scoreForTask(model: Model, task: TaskId): number {
  const reasoning = cap(model, 'reasoning', model.capabilities.reasoning);
  const coding = cap(model, 'coding', model.capabilities.coding);
  const agents = cap(model, 'agentic', model.capabilities.agents);
  switch (task) {
    case 'security':
      return reasoning * 0.5 + agents * 0.3 + coding * 0.2;
    case 'deploy':
      return coding * 0.5 + agents * 0.3 + reasoning * 0.2;
    case 'customization':
      return coding * 0.45 + fastScore(model) * 0.25 + agents * 0.3;
    case 'agents':
      return agents * 0.55 + reasoning * 0.25 + coding * 0.2;
    case 'cost':
      return cheapScore(model) * 0.55 + coding * 0.25 + agents * 0.2;
    default:
      return (reasoning + coding + agents) / 3;
  }
}

function whyFits(model: Model, task: TaskId): string {
  const bits: string[] = [];
  if (task === 'security' && model.capabilities.reasoning) bits.push('reasoning');
  if ((task === 'deploy' || task === 'customization') && model.capabilities.coding) bits.push('coding');
  if ((task === 'agents' || task === 'security') && model.capabilities.agents) bits.push('agents');
  if (model.capabilities.tools) bits.push('tools');
  if (task === 'cost' && (model.pricing.outputPerMillionUsd ?? 99) <= 5) bits.push('low output price');
  if (task === 'customization' && model.latencyProfile === 'fast') bits.push('fast');
  if (model.contextWindow >= 200_000) bits.push('long context');
  const effort = effortTiersForModel(model.metadata);
  if (effort?.includes('extrahigh')) bits.push('extrahigh effort');
  return bits.length ? bits.join(' · ') : 'General-purpose';
}

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value % 1_000_000 === 0 ? 0 : 1)}M`;
  if (value >= 1000) return `${Math.round(value / 1000)}k`;
  return String(value);
}

function formatEffortList(tiers: string[] | null | undefined): string {
  if (!tiers?.length) return 'Not documented';
  return tiers.map((tier) => formatEffortTier(tier as Parameters<typeof formatEffortTier>[0])).join(' · ');
}

export function CompareModels({ models }: { models: Model[] }) {
  const [taskId, setTaskId] = useState<TaskId>('security');
  const task = TASKS.find((item) => item.id === taskId) || TASKS[0];

  const activeModels = useMemo(
    () => models.filter((model) => model.lifecycle === 'ACTIVE' || model.lifecycle === 'PREVIEW'),
    [models],
  );

  const ranked = useMemo(() => {
    return activeModels
      .map((model) => ({ model, score: scoreForTask(model, task.id) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 10);
  }, [activeModels, task.id]);

  const flagshipRows = useMemo(() => {
    const ids = new Set([
      'minimax:MiniMax-M3',
      'xai:grok-4.6',
      'xai:grok-4.5',
      'gemini:gemini-3.1-pro',
      'openai:gpt-5.6-sol',
      'anthropic:claude-fable-5',
      'anthropic:claude-opus-5',
      'anthropic:claude-sonnet-5',
    ]);
    return activeModels.filter((model) => ids.has(model.id));
  }, [activeModels]);

  const winner = ranked[0]?.model;

  return (
    <div>
      <h2 className="font-display text-2xl font-semibold text-black">Compare</h2>
      <p className="mt-2 max-w-3xl text-[13px] leading-relaxed text-zinc-500">
        Ranked for DeplAI jobs, not a generic chat playground. Security, deploy, and customization resolve aliases like{' '}
        <span className="font-mono text-black">{task.alias}</span> instead of a vendor hardcoded in each agent. Catalog
        refreshed <span className="font-mono text-black">{COMPARE_UPDATED}</span>.
      </p>

      <Panel className="mt-6 border-black bg-neutral-50 p-5">
        <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-zinc-500">{COMPARE_PERFORMANCE_RECOMMENDATION.title}</p>
        <p className="mt-2 text-lg font-semibold text-black">
          {COMPARE_PERFORMANCE_RECOMMENDATION.models.map((item) => item.displayName).join(' or ')}
        </p>
        <p className="mt-1 font-mono text-[11px] text-zinc-500">
          Use {COMPARE_PERFORMANCE_RECOMMENDATION.effortLabel} · refreshed {COMPARE_UPDATED}
        </p>
        <p className="mt-2 text-[13px] leading-relaxed text-zinc-600">{COMPARE_PERFORMANCE_RECOMMENDATION.summary}</p>
        <div className="mt-4 grid gap-3 md:grid-cols-2">
          {COMPARE_PERFORMANCE_RECOMMENDATION.models.map((item) => (
            <div key={item.modelId} className="border-[3px] border-black bg-white p-4">
              <p className="text-sm font-medium text-black">{item.displayName}</p>
              <p className="mt-1 font-mono text-[11px] text-zinc-500">
                {item.providerId} · {item.modelId}
              </p>
              <p className="mt-2 text-[12px] text-zinc-600">{item.note}</p>
            </div>
          ))}
        </div>
      </Panel>

      <Panel className="mt-6 p-5">
        <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-zinc-500">Platform baseline</p>
        <p className="mt-2 text-lg font-semibold text-black">{COMPARE_BASELINE.displayName}</p>
        <p className="mt-1 font-mono text-[11px] text-zinc-500">
          {COMPARE_BASELINE.providerId} · {COMPARE_BASELINE.modelId}
        </p>
        <p className="mt-2 text-[13px] leading-relaxed text-zinc-600">{COMPARE_BASELINE.note}</p>
      </Panel>

      <div className="mt-6">
        <h3 className="font-display text-lg text-black">Thinking effort tiers</h3>
        <p className="mt-2 max-w-3xl text-[13px] leading-relaxed text-zinc-500">
          Effort controls how much internal reasoning a model spends before answering. It is configured on the provider
          API—not as a separate DeplAI model row. Where a provider uses <span className="font-mono text-black">xhigh</span>,
          the Compare ladder labels it <span className="font-mono text-black">extrahigh</span>.
        </p>
        <div className="mt-4 overflow-x-auto border-[3px] border-black bg-white">
          <table className="min-w-full text-left text-[12px]">
            <thead className="border-b-[3px] border-black bg-neutral-50 font-mono text-[10px] uppercase tracking-wider text-zinc-600">
              <tr>
                <th className="px-4 py-3">Provider</th>
                <th className="px-4 py-3">Parameter</th>
                <th className="px-4 py-3">Shared ladder</th>
                <th className="px-4 py-3">Default</th>
                <th className="px-4 py-3">Notes</th>
              </tr>
            </thead>
            <tbody>
              {THINKING_EFFORT_BY_PROVIDER.map((profile) => (
                <tr key={profile.providerId} className="border-b border-neutral-200 last:border-0">
                  <td className="px-4 py-3 font-medium text-black">{profile.providerId}</td>
                  <td className="px-4 py-3 font-mono text-[11px] text-zinc-600">{profile.parameter}</td>
                  <td className="px-4 py-3 text-zinc-700">
                    {profile.tiers.map((tier) => formatEffortTier(tier)).join(' · ')}
                    {profile.extendedTiers?.length ? (
                      <span className="mt-1 block text-[11px] text-zinc-500">
                        Also: {profile.extendedTiers.join(', ')}
                      </span>
                    ) : null}
                  </td>
                  <td className="px-4 py-3 font-mono text-[11px] text-zinc-700">{formatEffortTier(profile.defaultTier)}</td>
                  <td className="px-4 py-3 text-zinc-600">{profile.notes}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {flagshipRows.length > 0 ? (
        <div className="mt-8">
          <h3 className="font-display text-lg text-black">September 2026 flagship models</h3>
          <p className="mt-2 max-w-3xl text-[13px] text-zinc-500">
            Current generation models for BYOK comparison. Prices reflect provider list rates as of {COMPARE_UPDATED};
            promotional cuts (for example GPT-5.6 Sol at $4/$20) may apply on your vendor account.
          </p>
          <div className="mt-4 space-y-3">
            {flagshipRows.map((model) => {
              const effort = effortTiersForModel(model.metadata);
              const effortNotes = effortNotesForModel(model.metadata);
              return (
                <Panel key={model.id} className="p-5">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <p className="text-sm font-medium text-black">{model.displayName}</p>
                      <p className="mt-1 font-mono text-[11px] text-zinc-500">
                        {model.providerId} · {model.providerModelId} · context {formatTokens(model.contextWindow)}
                      </p>
                    </div>
                    <p className="font-mono text-[11px] text-zinc-600">
                      {model.pricing.inputPerMillionUsd != null ? `$${model.pricing.inputPerMillionUsd}/M in` : 'Price unknown'}
                      {model.pricing.outputPerMillionUsd != null ? ` · $${model.pricing.outputPerMillionUsd}/M out` : ''}
                      {model.pricing.source ? ` · ${model.pricing.source.replaceAll('_', ' ')}` : ''}
                    </p>
                  </div>
                  <p className="mt-3 text-[12px] text-zinc-600">
                    Effort: {formatEffortList(effort)}
                    {effortNotes ? ` — ${effortNotes}` : ''}
                  </p>
                </Panel>
              );
            })}
          </div>
        </div>
      ) : null}

      <div className="mt-8 flex flex-wrap gap-2">
        {TASKS.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => setTaskId(item.id)}
            className={
              item.id === task.id
                ? 'border-[3px] border-black bg-black px-3 py-2 font-mono text-[10px] font-bold uppercase tracking-wider text-white'
                : 'border-[3px] border-black bg-white px-3 py-2 font-mono text-[10px] font-bold uppercase tracking-wider text-black'
            }
          >
            {item.label}
          </button>
        ))}
      </div>
      <p className="mt-3 text-[13px] text-zinc-600">{task.blurb}</p>

      {winner ? (
        <Panel className="mt-6 p-5">
          <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-zinc-500">Best fit for this job</p>
          <p className="mt-2 text-lg font-semibold text-black">{winner.displayName}</p>
          <p className="mt-1 font-mono text-[11px] text-zinc-500">
            {winner.providerId} · alias {task.alias} · {whyFits(winner, task.id)}
          </p>
        </Panel>
      ) : (
        <p className="mt-6 text-[13px] text-zinc-500">Sync the catalog after adding a key to compare models.</p>
      )}

      <div className="mt-6 space-y-3">
        {ranked.map(({ model, score }, index) => (
          <Panel key={model.id} className="p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="text-sm font-medium text-black">
                  <span className="mr-2 font-mono text-[11px] text-zinc-500">#{index + 1}</span>
                  {model.displayName}
                  {model.id === COMPARE_BASELINE.modelId || model.providerModelId === COMPARE_BASELINE.modelId ? (
                    <span className="ml-2 border border-black px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider text-zinc-600">
                      baseline
                    </span>
                  ) : null}
                </p>
                <p className="mt-1 font-mono text-[11px] text-zinc-500">
                  {model.providerId} · {model.providerModelId} · context {formatTokens(model.contextWindow)}
                </p>
                <p className="mt-2 text-[12px] text-zinc-600">{whyFits(model, task.id)}</p>
                {effortTiersForModel(model.metadata) ? (
                  <p className="mt-1 text-[11px] text-zinc-500">
                    Thinking effort: {formatEffortList(effortTiersForModel(model.metadata))}
                  </p>
                ) : null}
              </div>
              <div className="text-right">
                <p className="font-display text-2xl text-black">{score.toFixed(1)}</p>
                <p className="font-mono text-[10px] uppercase tracking-wider text-zinc-500">fit</p>
                <p className="mt-2 font-mono text-[11px] text-zinc-600">
                  {model.pricing.outputPerMillionUsd != null ? `$${model.pricing.outputPerMillionUsd}/M out` : 'Price unknown'}
                </p>
              </div>
            </div>
            <div className="mt-4 space-y-2">
              <CapabilityBar label="Reasoning" value={cap(model, 'reasoning', model.capabilities.reasoning)} source={model.capabilities.scores.reasoning?.source} />
              <CapabilityBar label="Coding" value={cap(model, 'coding', model.capabilities.coding)} source={model.capabilities.scores.coding?.source} />
              <CapabilityBar label="Agents" value={cap(model, 'agentic', model.capabilities.agents)} source={model.capabilities.scores.agentic?.source} />
            </div>
          </Panel>
        ))}
      </div>

      <p className="mt-8 max-w-3xl text-[11px] leading-relaxed text-zinc-500">
        Capability bars combine provider-declared scores and DeplAI-inferred fit for workspace jobs. They are not
        independent public benchmarks. For effort tiers not listed above, consult your provider documentation before
        production rollout.
      </p>
    </div>
  );
}
