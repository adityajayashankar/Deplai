'use client';

import type { FormEvent } from 'react';
import { Bot, CircleAlert, Loader2, Send, ShieldCheck, Sparkles } from 'lucide-react';
import type { ChatMessage, UiuxAgentHealth, UiuxRefactorRunResponse, UiuxStepRequirement } from './types';

const SUGGESTIONS = [
  'Refactor the dashboard settings panel into a clean enterprise SaaS experience with WCAG AA contrast.',
  'Modernize the landing page hero and CTA components with a premium dark visual system and responsive states.',
  'Upgrade the deployment screens to a compact, data-dense operations dashboard while preserving every interaction.',
];

const focusRing =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-black/35 focus-visible:ring-offset-2 focus-visible:ring-offset-white';

function formatRunStatus(status?: string) {
  const normalized = (status || '').toUpperCase();
  if (normalized === 'PAUSED') return 'Waiting for input';
  if (normalized === 'RUNNING') return 'Running';
  if (normalized === 'COMPLETED') return 'Completed';
  if (normalized === 'ERROR') return 'Failed';
  return status || 'Starting';
}

export function UiuxAgentPanel({
  messages,
  input,
  loading,
  disabled,
  health,
  activeRun,
  clarificationDraft,
  onClarificationChange,
  onInputChange,
  onSubmit,
  onSuggestionSubmit,
  onContinueRun,
}: {
  messages: ChatMessage[];
  input: string;
  loading: boolean;
  disabled: boolean;
  health: UiuxAgentHealth | null;
  activeRun: UiuxRefactorRunResponse | null;
  clarificationDraft: Record<string, string>;
  onClarificationChange: (field: string, value: string) => void;
  onInputChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onSuggestionSubmit: (suggestion: string) => void;
  onContinueRun: () => void;
}) {
  const checking = health === null;
  const unavailable = health?.available === false;
  const runStatus = (activeRun?.status || '').toUpperCase();
  const isPaused = runStatus === 'PAUSED' || activeRun?.requires_user_input;
  const isRunning = runStatus === 'RUNNING' || runStatus === 'PENDING' || loading;
  const interactionDisabled = disabled || loading || unavailable || checking;
  const inputSchema = activeRun?.user_input_schema || [];
  const pendingRequirement = (activeRun?.step_requirements || []).find(
    (req: UiuxStepRequirement) => req.requires_user_input,
  );
  const clarificationMessage = activeRun?.user_input_message || pendingRequirement?.user_input_message;
  const schemaFields = inputSchema.length > 0
    ? inputSchema
    : (pendingRequirement?.user_input_schema || [
      { name: 'style_direction', required: true },
      { name: 'scope', required: true },
      { name: 'constraints', required: false },
      { name: 'references', required: false },
    ]);

  const canContinue = isPaused && schemaFields.every((field) => {
    if (!field.required) return true;
    return Boolean(clarificationDraft[field.name]?.trim());
  });

  return (
    <aside
      aria-label="UI/UX refactor agent"
      className="app-paper flex min-h-[430px] min-w-0 flex-col overflow-hidden"
    >
      <header className="flex shrink-0 items-center gap-3 border-b-[3px] border-black px-6 py-5">
        <div className="flex h-10 w-10 items-center justify-center rounded-none border-[3px] border-black bg-black text-white">
          <Sparkles className="h-5 w-5" />
        </div>
        <div className="min-w-0">
          <h2 className="font-display text-[15px] font-semibold text-black">UI/UX refactor agent</h2>
          <p className="mt-0.5 text-[11px] text-zinc-600">AgentOS · component-scoped · approval required</p>
        </div>
        <span
          className={`ml-auto inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-1 font-mono text-[9px] uppercase tracking-[0.08em] ${
            unavailable
              ? 'border-rose-400/30 bg-rose-400/10 text-rose-300'
              : health?.available
                ? 'border-emerald-400/30 bg-emerald-400/10 text-emerald-300'
                : 'border-zinc-500/30 bg-white/[0.03] text-zinc-500'
          }`}
        >
          <span className={`h-1.5 w-1.5 rounded-full ${unavailable ? 'bg-rose-400' : health?.available ? 'bg-emerald-400' : 'bg-zinc-500'}`} />
          {unavailable ? 'setup needed' : health?.available ? 'ready' : 'checking'}
        </span>
      </header>

      <div className="customization-scrollbar min-h-0 flex-1 overflow-y-auto px-6 py-7">
        <div className="rounded-md border border-violet-400/15 bg-violet-500/[0.04] p-4 text-[12px] leading-5 text-zinc-400">
          <div className="flex items-center gap-2 text-violet-200">
            <ShieldCheck className="h-3.5 w-3.5" />
            <span className="font-medium">Protected refactor flow</span>
          </div>
          <p className="mt-2">The agent indexes the selected project, limits changes to presentational code, and pauses for clarification or approval before a patch can be applied.</p>
        </div>

        {activeRun?.run_id ? (
          <div className="mt-4 rounded-md border border-white/10 bg-white/[0.02] p-3 text-[11px] text-zinc-400">
            <p className="font-mono uppercase tracking-[0.08em] text-zinc-500">Active run</p>
            <p className="mt-1 text-zinc-200">{formatRunStatus(activeRun.status)}</p>
            <p className="mt-1 break-all font-mono text-[10px] text-zinc-600">run={activeRun.run_id}</p>
          </div>
        ) : null}

        {unavailable ? (
          <div className="mt-4 flex gap-2 rounded-md border border-rose-400/15 bg-rose-400/[0.04] p-3 text-[12px] leading-5 text-rose-200">
            <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <p>{health?.detail || 'The local UI/UX agent is unavailable. Start AgentOS and try again.'}</p>
          </div>
        ) : (
          <>
            {messages.length > 0 ? (
              <div className="mt-5 space-y-3">
                {messages.map((message, index) => (
                  <div
                    key={`${message.timestamp}-${index}`}
                      className={`rounded-none border-[3px] border-black px-3 py-2 text-[12px] leading-5 ${
                      message.role === 'user'
                        ? 'bg-black text-white'
                        : 'bg-white text-black'
                    }`}
                  >
                    <p className="whitespace-pre-wrap">{message.content}</p>
                  </div>
                ))}
              </div>
            ) : (
              <>
                <p className="mt-6 text-[13px] text-neutral-700">Describe the style direction and the area you want to upgrade.</p>
                <div className="mt-4 space-y-2.5">
                  {SUGGESTIONS.map((suggestion) => (
                    <button
                      type="button"
                      key={suggestion}
                      onClick={() => onSuggestionSubmit(suggestion)}
                      disabled={interactionDisabled || isRunning}
                      className={`w-full rounded-none border-[3px] border-black bg-white px-4 py-3 text-left text-[12px] leading-5 text-neutral-700 shadow-[4px_4px_0_0_#000] transition-transform hover:translate-x-0.5 hover:translate-y-0.5 hover:shadow-none disabled:cursor-not-allowed disabled:opacity-45 ${focusRing}`}
                    >
                      {suggestion}
                    </button>
                  ))}
                </div>
              </>
            )}

            {isPaused ? (
              <div className="mt-5 rounded-md border border-amber-400/20 bg-amber-400/[0.04] p-4">
                <p className="text-[12px] font-medium text-amber-100">Clarification required</p>
                <p className="mt-1 text-[11px] leading-5 text-amber-100/80">
                  {clarificationMessage || 'Provide a style direction and scope before the agent continues.'}
                </p>
                <div className="mt-3 space-y-2">
                  {schemaFields.map((field) => (
                    <label key={field.name} className="block text-[11px] text-zinc-400">
                      <span className="mb-1 block capitalize text-zinc-300">
                        {field.name.replace(/_/g, ' ')}
                        {field.required ? ' *' : ''}
                      </span>
                      <input
                        value={clarificationDraft[field.name] || ''}
                        onChange={(event) => onClarificationChange(field.name, event.target.value)}
                        className={`h-10 w-full rounded-none border-[3px] border-black bg-white px-3 text-[12px] text-black ${focusRing}`}
                      />
                    </label>
                  ))}
                </div>
                <button
                  type="button"
                  onClick={() => onContinueRun()}
                  disabled={!canContinue || loading}
                  className={`mt-3 inline-flex h-9 items-center border-[3px] border-black bg-black px-3 text-[12px] font-bold text-white shadow-[4px_4px_0_0_#000] transition-transform hover:translate-x-0.5 hover:translate-y-0.5 hover:shadow-none disabled:cursor-not-allowed disabled:opacity-40 ${focusRing}`}
                >
                  Continue refactor run
                </button>
              </div>
            ) : null}
          </>
        )}
      </div>

      <div className="shrink-0 border-t-[3px] border-black p-5">
        <form onSubmit={onSubmit} className="flex gap-2.5">
          <label className="sr-only" htmlFor="uiux-agent-prompt">UI/UX refactor instruction</label>
          <input
            id="uiux-agent-prompt"
            value={input}
            onChange={(event) => onInputChange(event.target.value)}
            disabled={interactionDisabled || isPaused}
            placeholder="e.g. modernize Settings as enterprise SaaS, retain current behavior"
            className={`h-12 min-w-0 flex-1 rounded-none border-[3px] border-black bg-white px-4 text-[13px] text-black placeholder:text-neutral-500 disabled:opacity-50 ${focusRing}`}
          />
          <button
            type="submit"
            disabled={!input.trim() || interactionDisabled || isPaused || isRunning}
            aria-label="Start UI/UX refactor run"
            className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-none border-[3px] border-black bg-black text-white shadow-[4px_4px_0_0_#000] transition-transform hover:translate-x-0.5 hover:translate-y-0.5 hover:shadow-none disabled:cursor-not-allowed disabled:opacity-30 ${focusRing}`}
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          </button>
        </form>
        {disabled ? <p className="mt-2 text-[10px] text-zinc-600">Select a project before starting a refactor run.</p> : null}
        {!disabled && !unavailable ? (
          <p className="mt-2 flex items-center gap-1.5 text-[10px] text-zinc-600">
            <Bot className="h-3 w-3" /> No file changes are applied without AgentOS confirmation.
          </p>
        ) : null}
      </div>
    </aside>
  );
}
