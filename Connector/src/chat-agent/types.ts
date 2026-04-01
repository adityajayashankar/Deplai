// ── Shared types for the DeplAI multi-agent chat orchestration layer ──────────

export type ExecutionMode = 'tool_call' | 'multi_tool_chain' | 'direct_answer' | 'clarification';

export type ToolName =
  | 'run_scan'
  | 'navigate_to_results'
  | 'start_remediation'
  | 'plan_deployment'
  | 'create_github_repo'
  | 'ask_for_github_pat'
  | 'generate_code';

export interface ConnectedProject {
  id: string;
  name: string;
  repo?: string;
  owner?: string;
  installationId?: string;
  type: 'local' | 'github';
}

export interface ConversationTurn {
  role: 'user' | 'assistant';
  content: string;
}

// ── Signal Warden output ──────────────────────────────────────────────────────

export interface SignalWardenResult {
  mode: ExecutionMode;
  intent: string;
  confidence: number;          // 0–1
  required_params: string[];
  missing_params: string[];
  selected_project_id: string | null;
}

// ── Tool Contract Sentinel output ─────────────────────────────────────────────

export interface ToolError {
  field: string;
  code: string;
  message: string;
}

export interface ToolContractResult {
  tool_name: ToolName;
  valid: boolean;
  errors: ToolError[];
  sanitized_params: Record<string, unknown>;
}

// ── Chain Choreographer output ────────────────────────────────────────────────

export interface ChainStep {
  step: number;
  tool: ToolName;
  params: Record<string, unknown>;
  preconditions: string[];
  success_condition: string;
}

export type ChainChoreographerResult = ChainStep[];

// ── Adversarial Verifier output ───────────────────────────────────────────────

export type ChallengeStatus = 'approved' | 'rejected' | 'needs_human_review';

export interface AdversarialVerifierResult {
  tool_name: ToolName;
  challenge_status: ChallengeStatus;
  counterarguments: string[];
  risk_score: number;          // 0–100
  rationale: string;
}

// ── Action-UI Binder output ───────────────────────────────────────────────────

export interface UIEvent {
  type: string;
  payload: Record<string, unknown>;
}

export interface UICard {
  type: 'scan_started' | 'scan_completed' | 'remediation_started' | 'repo_created' | 'error';
  data: Record<string, unknown>;
}

export interface UIButton {
  label: string;
  action: string;
  variant: 'primary' | 'danger' | 'secondary';
  payload: Record<string, unknown>;
}

export interface ActionUIBinderResult {
  ui_events: UIEvent[];
  route_push: string | null;
  cards: UICard[];
  buttons: UIButton[];
}

// ── Recovery Marshall output ──────────────────────────────────────────────────

export type ErrorType = 'transient' | 'permanent' | 'policy_blocked';
export type RecoveryStatus = 'resolved' | 'failed' | 'escalated';

export interface RecoveryMarshallResult {
  error_type: ErrorType;
  retry_attempted: boolean;
  attempt_count: number;       // 0–2
  final_status: RecoveryStatus;
  fallback_message: string;
}

// ── Narrative Blacksmith output ───────────────────────────────────────────────

export interface NarrativeBlacksmithResult {
  markdown: string;            // Full markdown response
  status: 'completed' | 'in_progress' | 'failed' | 'partial';
  refs: string[];              // Internal event IDs cited
}

// ── Memory Forensics Keeper output ───────────────────────────────────────────

export interface MemoryConflict {
  entity: string;
  reason: string;
}

export interface MemoryRepair {
  entity: string;
  action: 'remove' | 'replace';
  replacement?: unknown;
}

export interface MemoryForensicsResult {
  context_ok: boolean;
  resolved_entities: Record<string, unknown>;
  stale_entities: string[];
  conflicts: MemoryConflict[];
  recommended_repairs: MemoryRepair[];
}

// ── Orchestrator context ───────────────────────────────────────────────────────

export interface AgentContext {
  session_id: string | null;
  user_text: string;
  history: ConversationTurn[];
  projects: ConnectedProject[];
  active_project_id: string | null;
  event_id: string;            // Unique ID for this turn (for Narrative Blacksmith refs)
}

export interface OrchestratorResult {
  signal_warden: SignalWardenResult;
  memory_forensics: MemoryForensicsResult;
  tool_contract?: ToolContractResult;
  chain?: ChainChoreographerResult;
  adversarial_verifier?: AdversarialVerifierResult;
  action_ui: ActionUIBinderResult;
  recovery?: RecoveryMarshallResult;
  narrative: NarrativeBlacksmithResult;
  // The raw tool call to execute (null = direct answer)
  resolved_tool_call: { name: ToolName; params: Record<string, unknown> } | null;
}
