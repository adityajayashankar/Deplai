// ── Orchestrator ──────────────────────────────────────────────────────────────
// Runs all 8 agents in the correct sequence for each conversation turn.
//
// Pipeline per turn:
//   1. Memory Forensics Keeper  — validate context
//   2. Signal Warden            — classify intent & route
//   3. (if tool_call/chain) Tool Contract Sentinel — validate payload
//   4. (if multi_tool_chain)    Chain Choreographer — plan steps
//   5. (if tool pending)        Adversarial Verifier — challenge the call
//   6. Action-UI Binder         — map outcome → UI artifacts
//   7. (if error) Recovery Marshall — handle & retry logic
//   8. Narrative Blacksmith     — compose final user-facing response

import { randomUUID } from 'crypto';
import { AgentContext, ConnectedProject, ConversationTurn, OrchestratorResult, ToolName } from './types';
import { runSignalWarden } from './agents/signal-warden';
import { runToolContractSentinel } from './agents/tool-contract-sentinel';
import { runChainChoreographer } from './agents/chain-choreographer';
import { runAdversarialVerifier } from './agents/adversarial-verifier';
import { runActionUIBinder } from './agents/action-ui-binder';
import { runRecoveryMarshall } from './agents/recovery-marshall';
import { runNarrativeBlacksmith } from './agents/narrative-blacksmith';
import { runMemoryForensicsKeeper } from './agents/memory-forensics-keeper';

export interface OrchestratorInput {
  session_id: string | null;
  user_text: string;
  history: ConversationTurn[];
  projects: ConnectedProject[];
  active_project_id?: string | null;
  /** Raw tool call proposed by the LLM (if any) */
  proposed_tool?: { name: ToolName; params: Record<string, unknown> } | null;
  /** Error from a previous tool execution attempt */
  tool_error?: { error: unknown; attempt_count: number } | null;
  /** Direct answer text (for direct_answer mode) */
  direct_answer?: string;
}

export async function runOrchestrator(input: OrchestratorInput): Promise<OrchestratorResult> {
  const event_id = `evt_${Date.now()}_${randomUUID().slice(0, 8)}`;

  const ctx: AgentContext = {
    session_id: input.session_id,
    user_text: input.user_text,
    history: input.history,
    projects: input.projects,
    active_project_id: input.active_project_id ?? null,
    event_id,
  };

  // ── Step 1: Memory Forensics Keeper ────────────────────────────────────────
  const memory_forensics = runMemoryForensicsKeeper(ctx);

  // Apply repairs: remove stale entities from resolved context
  const cleanedProjectId =
    memory_forensics.stale_entities.includes('project_id')
      ? null
      : (memory_forensics.resolved_entities.project_id as string | undefined) ?? ctx.active_project_id;

  const cleanCtx: AgentContext = {
    ...ctx,
    active_project_id: cleanedProjectId ?? ctx.active_project_id,
  };

  // ── Step 2: Signal Warden ───────────────────────────────────────────────────
  const signal_warden = runSignalWarden(cleanCtx);

  // ── Step 3: Tool Contract Sentinel (tool calls only) ───────────────────────
  let tool_contract: OrchestratorResult['tool_contract'];
  let resolvedToolCall: OrchestratorResult['resolved_tool_call'] = null;

  if (input.proposed_tool && signal_warden.mode !== 'direct_answer') {
    tool_contract = runToolContractSentinel(
      input.proposed_tool.name,
      input.proposed_tool.params,
    );

    if (tool_contract.valid) {
      resolvedToolCall = {
        name: input.proposed_tool.name,
        params: tool_contract.sanitized_params,
      };
    }
  }

  // ── Step 4: Chain Choreographer (multi-tool intents) ──────────────────────
  let chain: OrchestratorResult['chain'];
  if (signal_warden.mode === 'multi_tool_chain') {
    chain = runChainChoreographer(cleanCtx, signal_warden);
    // Use first step's tool as the immediate call
    if (chain.length > 0 && !resolvedToolCall) {
      resolvedToolCall = { name: chain[0].tool, params: chain[0].params };
    }
  }

  // ── Step 5: Adversarial Verifier ───────────────────────────────────────────
  let adversarial: OrchestratorResult['adversarial_verifier'];
  if (resolvedToolCall) {
    adversarial = runAdversarialVerifier(
      cleanCtx,
      resolvedToolCall.name,
      resolvedToolCall.params,
      signal_warden,
    );

    // Blocked calls are not executed
    if (adversarial.challenge_status === 'rejected') {
      resolvedToolCall = null;
    }
  }

  // ── Step 6: Action-UI Binder ───────────────────────────────────────────────
  const toolOutcomeStatus = input.tool_error
    ? 'failure'
    : resolvedToolCall
    ? 'pending'
    : 'success';

  const action_ui = runActionUIBinder(cleanCtx, {
    tool: resolvedToolCall?.name ?? (input.proposed_tool?.name as ToolName) ?? 'run_scan',
    status: toolOutcomeStatus,
    result: resolvedToolCall?.params,
    error: input.tool_error ? String(input.tool_error.error) : undefined,
  });

  // ── Step 7: Recovery Marshall (errors only) ────────────────────────────────
  let recovery: OrchestratorResult['recovery'];
  if (input.tool_error) {
    recovery = runRecoveryMarshall({
      tool: (input.proposed_tool?.name ?? 'run_scan') as ToolName,
      error: input.tool_error.error,
      attempt_count: input.tool_error.attempt_count,
    });
  }

  // ── Step 8: Narrative Blacksmith ───────────────────────────────────────────
  const narrative = runNarrativeBlacksmith({
    ctx: cleanCtx,
    signal: signal_warden,
    tool_contract,
    adversarial,
    action_ui,
    recovery,
    direct_answer: input.direct_answer,
  });

  return {
    signal_warden,
    memory_forensics,
    tool_contract,
    chain,
    adversarial_verifier: adversarial,
    action_ui,
    recovery,
    narrative,
    resolved_tool_call: resolvedToolCall,
  };
}
