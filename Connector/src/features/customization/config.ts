import {
  Bot,
  Braces,
  GitCompareArrows,
  Image as ImageIcon,
  Layers,
  Microscope,
  Monitor,
  Settings2,
  ShieldCheck,
  Wrench,
} from 'lucide-react';
import type {
  AssetOption,
  ByokModel,
  ByokProvider,
  PipelineMode,
  PreviewDevice,
  WorkspaceTab,
  WorkflowStage,
} from './types';

export const TENANT_STORAGE_KEY = 'deplai.customization.tenant-id';
export const AUTO_APPLY_STORAGE_KEY = 'deplai.customization.auto-apply-approved';
export const DEFAULT_APP_TARGETS = ['frontend', 'admin-frontend', 'expert', 'corporates'];
export const INITIAL_CHAT_TIMESTAMP = '--:--:--';
export const REVERT_TO_BASE_CHAT_PATTERN =
  /(revert|reset|restore|undo).*(original|base|default).*(ui|theme|frontend|site|design)/i;

export const PIPELINE_MODE_OPTIONS = [
  { value: 'hybrid' as PipelineMode, label: 'Hybrid', description: 'LLM + deterministic', icon: Layers },
  { value: 'llm_only' as PipelineMode, label: 'LLM only', description: 'AI-driven changes', icon: Bot },
  { value: 'deterministic_only' as PipelineMode, label: 'Deterministic', description: 'Rule-based changes', icon: Wrench },
  { value: 'diagnostic' as PipelineMode, label: 'Diagnostic', description: 'Dry run and report', icon: Microscope },
];

export const PROVIDER_MODEL_MAP: Record<ByokProvider, ByokModel[]> = {
  Anthropic: [
    { id: 'claude-opus-4-5', name: 'Claude Opus 4.5' },
    { id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5' },
    { id: 'claude-haiku-3-5', name: 'Claude Haiku 3.5' },
  ],
  OpenAI: [
    { id: 'gpt-4o', name: 'GPT-4o' },
    { id: 'gpt-4.1', name: 'GPT-4.1' },
    { id: 'o3-mini', name: 'o3-mini' },
  ],
  Groq: [
    { id: 'llama-3.3-70b-versatile', name: 'Llama 3.3 70B' },
    { id: 'meta-llama/llama-4-scout-17b-16e-instruct', name: 'Llama 4 Scout' },
    { id: 'moonshotai/kimi-k2-instruct', name: 'Kimi K2' },
  ],
  OpenRouter: [
    { id: 'nvidia/nemotron-3-ultra-550b-a55b:free', name: 'Nemotron 3 Ultra 550B' },
    { id: 'nvidia/nemotron-3-super-120b-a12b:free', name: 'Nemotron 3 Super 120B' },
    { id: 'qwen/qwen3-coder:free', name: 'Qwen3 Coder 480B' },
    { id: 'openai/gpt-oss-120b:free', name: 'GPT OSS 120B' },
    { id: 'meta-llama/llama-3.3-70b-instruct:free', name: 'Llama 3.3 70B Instruct' },
    { id: 'nousresearch/hermes-3-llama-3.1-405b:free', name: 'Hermes 3 405B' },
    { id: 'nex-agi/nex-n2-pro:free', name: 'Nex-N2-Pro' },
    { id: 'qwen/qwen3-next-80b-a3b-instruct:free', name: 'Qwen3 Next 80B' },
    { id: 'google/gemma-4-31b-it:free', name: 'Gemma 4 31B' },
    { id: 'google/gemma-4-26b-a4b-it:free', name: 'Gemma 4 26B' },
    { id: 'poolside/laguna-m.1:free', name: 'Laguna M.1' },
    { id: 'poolside/laguna-xs.2:free', name: 'Laguna XS.2' },
    { id: 'nvidia/nemotron-3-nano-30b-a3b:free', name: 'Nemotron 3 Nano 30B' },
    { id: 'nvidia/nemotron-nano-9b-v2:free', name: 'Nemotron Nano 9B' },
    { id: 'openai/gpt-oss-20b:free', name: 'GPT OSS 20B' },
    { id: 'meta-llama/llama-3.2-3b-instruct:free', name: 'Llama 3.2 3B' },
  ],
  MiniMax: [
    { id: 'minimax-m3', name: 'MiniMax M3' },
    { id: 'minimax-m2.7', name: 'MiniMax M2.7' },
    { id: 'minimax-m2.7-highspeed', name: 'MiniMax M2.7 Highspeed' },
  ],
};

export const PROVIDER_TO_BACKEND_ID: Record<ByokProvider, string> = {
  Anthropic: 'claude',
  OpenAI: 'openai',
  Groq: 'groq',
  OpenRouter: 'openrouter',
  MiniMax: 'minimax',
};

export const ASSET_OPTIONS: AssetOption[] = [
  { value: 'logo_light', label: 'Logo (light)' },
  { value: 'logo_dark', label: 'Logo (dark)' },
  { value: 'favicon', label: 'Favicon' },
  { value: 'og_image', label: 'Social image' },
  { value: 'hero_illustration', label: 'Hero illustration' },
  { value: 'why_background', label: 'Why background' },
  { value: 'activities_background', label: 'Activities background' },
  { value: 'curated_image', label: 'Curated image' },
];

export const PREVIEW_DEVICE_OPTIONS = [
  { value: 'desktop' as PreviewDevice, label: 'Desktop', width: '100%' },
  { value: 'tablet' as PreviewDevice, label: 'Tablet', width: '768px' },
  { value: 'mobile' as PreviewDevice, label: 'Mobile', width: '390px' },
];

export const WORKSPACE_TABS: Array<{ value: WorkspaceTab; label: string; icon: typeof Monitor }> = [
  { value: 'preview', label: 'Preview', icon: Monitor },
  { value: 'changes', label: 'Changes', icon: GitCompareArrows },
  { value: 'quality', label: 'Quality', icon: ShieldCheck },
  { value: 'manifest', label: 'Manifest', icon: Braces },
  { value: 'assets', label: 'Assets', icon: ImageIcon },
  { value: 'settings', label: 'Settings', icon: Settings2 },
];

export const WORKFLOW_STEPS: Array<{ value: WorkflowStage; label: string; description: string }> = [
  { value: 'draft', label: 'Draft', description: 'Capture intent' },
  { value: 'review', label: 'Review', description: 'Inspect manifest' },
  { value: 'apply', label: 'Apply', description: 'Write changes' },
  { value: 'validate', label: 'Validate', description: 'Run quality gates' },
  { value: 'preview', label: 'Preview', description: 'Verify output' },
  { value: 'ready', label: 'Ready', description: 'Handoff' },
];
