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
  CustomizationMode,
  PipelineMode,
  PreviewDevice,
  StudioBottomTab,
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

export const CUSTOMIZATION_MODES: Array<{ value: CustomizationMode; label: string; description: string }> = [
  { value: 'full_transformation', label: 'Full UI/UX transformation', description: 'Enterprise upgrade across the product' },
  { value: 'targeted_screen', label: 'Targeted screen', description: 'Focus on selected routes' },
  { value: 'design_system', label: 'Design system upgrade', description: 'Tokens, type, spacing, components' },
  { value: 'responsive', label: 'Responsive upgrade', description: 'Mobile and tablet layouts' },
  { value: 'accessibility', label: 'Accessibility upgrade', description: 'Focus, contrast, skip links, labels' },
];

export const ENGINE_STAGES: Array<{ id: string; label: string; group: 'analysis' | 'implementation' | 'qa' }> = [
  { id: 'intake', label: 'Repository analyzed', group: 'analysis' },
  { id: 'mapping', label: 'Frontend map created', group: 'analysis' },
  { id: 'business_logic', label: 'Business logic boundaries identified', group: 'analysis' },
  { id: 'ux_research', label: 'Product UX model generated', group: 'analysis' },
  { id: 'ux_strategy', label: 'UX architecture generated', group: 'analysis' },
  { id: 'design_system', label: 'Design system generated', group: 'analysis' },
  { id: 'screen_planner', label: 'Screen plan created', group: 'analysis' },
  { id: 'implement_shell', label: 'Application shell', group: 'implementation' },
  { id: 'implement_screens', label: 'Screens updated', group: 'implementation' },
  { id: 'implement_responsive', label: 'Responsive behavior', group: 'implementation' },
  { id: 'implement_a11y', label: 'Accessibility', group: 'implementation' },
  { id: 'visual_qa', label: 'Visual QA', group: 'qa' },
  { id: 'functional_safety', label: 'Functional safety', group: 'qa' },
  { id: 'preview_verify', label: 'Preview verification', group: 'qa' },
  { id: 'review_gate', label: 'Final review', group: 'qa' },
];

export const STUDIO_INSPECTOR_TABS: Array<{ value: StudioBottomTab; label: string }> = [
  { value: 'diff', label: 'Diff' },
  { value: 'changes', label: 'Changes' },
  { value: 'logs', label: 'Activity' },
  { value: 'review', label: 'Review' },
];

export const STUDIO_PHASES: Array<{
  id: 'understand' | 'design' | 'apply';
  label: string;
  stages: Array<{ id: string; doing: string }>;
}> = [
  {
    id: 'understand',
    label: '1. Understand the product',
    stages: [
      { id: 'intake', doing: 'Reading the repository and detecting the frontend.' },
      { id: 'mapping', doing: 'Mapping screens, routes, and UI files.' },
      { id: 'business_logic', doing: 'Locking files that must not be changed.' },
    ],
  },
  {
    id: 'design',
    label: '2. Design the UI',
    stages: [
      { id: 'ux_research', doing: 'Learning how this product is used.' },
      { id: 'ux_strategy', doing: 'Choosing layout and navigation changes.' },
      { id: 'design_system', doing: 'Building a design system from this repo.' },
      { id: 'screen_planner', doing: 'Planning screen-by-screen updates.' },
    ],
  },
  {
    id: 'apply',
    label: '3. Apply and check',
    stages: [
      { id: 'implement_shell', doing: 'Updating the application shell.' },
      { id: 'implement_screens', doing: 'Updating screens.' },
      { id: 'implement_responsive', doing: 'Checking tablet and mobile layouts.' },
      { id: 'implement_a11y', doing: 'Improving accessibility.' },
      { id: 'visual_qa', doing: 'Checking visual quality.' },
      { id: 'functional_safety', doing: 'Confirming business logic was not touched.' },
      { id: 'preview_verify', doing: 'Refreshing the live preview.' },
      { id: 'review_gate', doing: 'Preparing the final review.' },
    ],
  },
];
