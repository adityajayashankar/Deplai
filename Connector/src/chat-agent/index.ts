// ── DeplAI Chat-Agent: Multi-Agent Orchestration Layer ────────────────────────
// Exports all public surfaces of the chat-agent system.

export * from './types';
export * from './tools';
export { runOrchestrator } from './orchestrator';
export type { OrchestratorInput } from './orchestrator';

// Individual agents (for unit testing or direct use)
export { runSignalWarden } from './agents/signal-warden';
export { runToolContractSentinel } from './agents/tool-contract-sentinel';
export { runChainChoreographer } from './agents/chain-choreographer';
export { runAdversarialVerifier } from './agents/adversarial-verifier';
export { runActionUIBinder } from './agents/action-ui-binder';
export { runRecoveryMarshall } from './agents/recovery-marshall';
export type { RecoveryInput } from './agents/recovery-marshall';
export { runNarrativeBlacksmith } from './agents/narrative-blacksmith';
export type { NarrativeInput } from './agents/narrative-blacksmith';
export { runMemoryForensicsKeeper } from './agents/memory-forensics-keeper';
