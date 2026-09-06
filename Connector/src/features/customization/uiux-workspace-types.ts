export type UiuxProject = { id: string; name: string; type: string; owner?: string; repo?: string; branch?: string };
export type UiuxFile = { path: string; size: number; editable: boolean };
export type UiuxRepository = { project: UiuxProject; files: UiuxFile[]; source_sha: string; warnings: string[] };
export type UiuxRun = {
  run_id: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'blocked';
  prompt?: string;
  summary?: string;
  events: { sequence: number; type: string; message: string; timestamp: string }[];
  changes: { path: string; before: string; after: string }[];
  warnings?: string[];
  conflicts?: string[];
  source_sha?: string;
  usage?: { requests?: number; input_tokens?: number; output_tokens?: number };
  error?: string;
  pr_url?: string;
};
