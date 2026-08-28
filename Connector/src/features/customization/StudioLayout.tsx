'use client';

import {
  AlertTriangle,
  Check,
  Copy,
  Download,
  Eye,
  GitPullRequest,
  Loader2,
  Monitor,
  RotateCcw,
  ShieldCheck,
  Smartphone,
  Tablet,
  X,
} from 'lucide-react';
import { CUSTOMIZATION_MODES, PREVIEW_DEVICE_OPTIONS, STUDIO_INSPECTOR_TABS, STUDIO_PHASES } from './config';
import { PreviewPanel } from './PreviewPanel';
import type {
  CustomizationMode,
  DiffEntry,
  FrontendFileListing,
  FrontendRunView,
  PreviewDevice,
  PreviewMetaResponse,
  StudioBottomTab,
} from './types';
import { diffLineClassName } from './utils';

const focusRing =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-black/35 focus-visible:ring-offset-2 focus-visible:ring-offset-white';

function fileName(path: string) {
  return path.split('/').pop() || path;
}

function fileDir(path: string) {
  const parts = path.split('/');
  return parts.length > 1 ? parts.slice(0, -1).join('/') : '';
}

function runHeadline(run: FrontendRunView) {
  if (run.interrupt_required) return 'Waiting for you';
  if (run.status === 'failed') return 'Stopped';
  if (run.status === 'completed') return 'Done';
  if (run.status === 'queued') return 'Starting…';
  return 'Working…';
}

function currentWork(run: FrontendRunView) {
  const completed = new Set(run.completed_nodes || []);
  for (const phase of STUDIO_PHASES) {
    const current = phase.stages.find((stage) => stage.id === run.current_stage);
    if (current && !completed.has(current.id)) return current.doing;
    const next = phase.stages.find((stage) => !completed.has(stage.id));
    if (next) return next.doing;
  }
  return 'Wrapping up.';
}

function phaseState(run: FrontendRunView, stageIds: string[]): 'done' | 'now' | 'next' {
  const completed = run.completed_nodes || [];
  if (stageIds.every((id) => completed.includes(id))) return 'done';
  if (stageIds.some((id) => completed.includes(id) || run.current_stage === id)) return 'now';
  return 'next';
}

function ScoreBar({ label, value }: { label: string; value?: number }) {
  const score = Math.max(0, Math.min(100, value ?? 0));
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-[11px]">
        <span className="text-neutral-600">{label}</span>
        <span className="font-mono text-black">{score || '—'}</span>
      </div>
      <div className="h-2 border-[2px] border-black bg-white">
        <div className="h-full bg-black" style={{ width: `${score}%` }} />
      </div>
    </div>
  );
}

export function StudioHome({
  projectName,
  stackSummary,
  goal,
  mode,
  selectedScreens,
  availableScreens,
  starting,
  canStart,
  modelHint,
  onGoalChange,
  onModeChange,
  onToggleScreen,
  onStart,
}: {
  projectName: string;
  stackSummary: string;
  goal: string;
  mode: CustomizationMode;
  selectedScreens: string[];
  availableScreens: string[];
  starting: boolean;
  canStart: boolean;
  modelHint?: string;
  onGoalChange: (value: string) => void;
  onModeChange: (value: CustomizationMode) => void;
  onToggleScreen: (screen: string) => void;
  onStart: () => void;
}) {
  return (
    <section className="app-paper mx-auto w-full max-w-4xl p-6 sm:p-8">
      <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-neutral-500">AI analysis</p>
      <h2 className="mt-2 font-display text-2xl font-semibold text-black">Customize this frontend</h2>
      <p className="mt-2 max-w-2xl text-sm leading-6 text-neutral-600">
        The system analyzes the repository, protects business logic, then transforms presentational UI into a repository-specific enterprise experience.
      </p>
      <dl className="mt-6 grid gap-3 sm:grid-cols-2">
        <div className="border-[3px] border-black bg-white px-4 py-3">
          <dt className="text-[10px] font-semibold uppercase tracking-[0.16em] text-neutral-500">Repository</dt>
          <dd className="mt-1 font-mono text-sm text-black">{projectName || 'Select a project'}</dd>
        </div>
        <div className="border-[3px] border-black bg-white px-4 py-3">
          <dt className="text-[10px] font-semibold uppercase tracking-[0.16em] text-neutral-500">Detected stack</dt>
          <dd className="mt-1 text-sm text-black">{stackSummary || 'Will be detected from the repository'}</dd>
        </div>
      </dl>
      <label className="mt-6 block text-[11px] font-semibold uppercase tracking-[0.14em] text-neutral-500" htmlFor="customization-goal">
        Customization goals
      </label>
      <textarea
        id="customization-goal"
        value={goal}
        onChange={(event) => onGoalChange(event.target.value)}
        rows={3}
        className={`mt-2 w-full rounded-none border-[3px] border-black bg-white px-3 py-2 text-sm text-black ${focusRing}`}
      />
      <p className="mt-5 text-[11px] font-semibold uppercase tracking-[0.14em] text-neutral-500">Mode</p>
      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        {CUSTOMIZATION_MODES.map((item) => (
          <button
            type="button"
            key={item.value}
            onClick={() => onModeChange(item.value)}
            className={`border-[3px] px-3 py-3 text-left ${focusRing} ${
              mode === item.value ? 'border-black bg-black text-white' : 'border-black bg-white text-black hover:bg-neutral-100'
            }`}
          >
            <span className="block text-[13px] font-bold">{item.label}</span>
            <span className={`mt-1 block text-[11px] ${mode === item.value ? 'text-white/70' : 'text-neutral-500'}`}>{item.description}</span>
          </button>
        ))}
      </div>
      {mode === 'targeted_screen' && availableScreens.length > 0 ? (
        <div className="mt-5">
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-neutral-500">Screens</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {availableScreens.map((screen) => {
              const active = selectedScreens.includes(screen);
              return (
                <button
                  type="button"
                  key={screen}
                  onClick={() => onToggleScreen(screen)}
                  className={`border-[3px] border-black px-2 py-1 font-mono text-[11px] ${active ? 'bg-black text-white' : 'bg-white text-black'}`}
                >
                  {screen}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
      <button
        type="button"
        onClick={onStart}
        disabled={!canStart || starting}
        className={`mt-6 inline-flex h-12 items-center gap-2 border-[3px] border-black bg-black px-5 text-[13px] font-bold text-white shadow-[4px_4px_0_0_#000] hover:translate-x-0.5 hover:translate-y-0.5 hover:shadow-none disabled:cursor-not-allowed disabled:opacity-40 ${focusRing}`}
      >
        {starting ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
        {starting ? 'Starting analysis…' : 'Start customization'}
      </button>
      {modelHint ? <p className="mt-3 text-[12px] text-amber-700">{modelHint}</p> : null}
    </section>
  );
}

export function StudioWorkspace({
  run,
  files,
  diffs,
  selectedFile,
  inspectorTab,
  previewDevice,
  compareOriginal,
  previewMeta,
  previewMetaLoading,
  previewFrameSrc,
  mode,
  continuing,
  restoring,
  finalizing,
  onInspectorTab,
  onSelectFile,
  onPreviewDevice,
  onToggleCompare,
  onRefreshPreview,
  onModeChange,
  onContinue,
  onRestore,
  onDownloadZip,
  onFinalize,
  onCreatePr,
  creatingGitPr,
}: {
  run: FrontendRunView;
  files: FrontendFileListing | null;
  diffs: DiffEntry[];
  selectedFile: string;
  inspectorTab: StudioBottomTab | null;
  previewDevice: PreviewDevice;
  compareOriginal: boolean;
  previewMeta: PreviewMetaResponse | null;
  previewMetaLoading: boolean;
  previewFrameSrc: string;
  mode: CustomizationMode;
  continuing: boolean;
  restoring: boolean;
  finalizing: boolean;
  onInspectorTab: (tab: StudioBottomTab | null) => void;
  onSelectFile: (file: string) => void;
  onPreviewDevice: (device: PreviewDevice) => void;
  onToggleCompare: () => void;
  onRefreshPreview: () => void;
  onModeChange: (value: CustomizationMode) => void;
  onContinue: () => void;
  onRestore: (checkpointId: string) => void;
  onDownloadZip: () => void;
  onFinalize: () => void;
  onCreatePr: () => void;
  creatingGitPr: boolean;
}) {
  const changed = [
    ...(files?.files_changed || []).map((item) => ({ ...item, kind: 'Modified' as const })),
    ...(files?.files_added || []).map((item) => ({ ...item, kind: 'Added' as const })),
    ...(files?.files_deleted || []).map((item) => ({ ...item, kind: 'Deleted' as const })),
  ];
  const changedSet = new Set(changed.map((item) => item.file));
  const tree = (files?.tree && files.tree.length
    ? files.tree
    : [
        ...(run.frontend_manifest?.frontend_files || []).map((file) => ({ file, status: 'unchanged' })),
        ...(run.frontend_manifest?.routes || []).flatMap((route) => (route.file ? [{ file: route.file, status: 'unchanged' }] : [])),
      ]
  ).filter((item, index, list) => item.file && list.findIndex((entry) => entry.file === item.file) === index);
  const visibleFiles = (tree.length ? tree : changed).slice().sort((left, right) => {
    const leftChanged = changedSet.has(left.file) || (left.status && left.status !== 'unchanged') ? 0 : 1;
    const rightChanged = changedSet.has(right.file) || (right.status && right.status !== 'unchanged') ? 0 : 1;
    return leftChanged - rightChanged || left.file.localeCompare(right.file);
  });
  const selectedDiff = diffs.find((entry) => entry.file === selectedFile) || diffs[0];
  const deviceWidth = PREVIEW_DEVICE_OPTIONS.find((item) => item.value === previewDevice)?.width || '100%';
  const scores = run.quality_scores || {};
  const review = run.final_review || {};
  const modeConfirm = run.interrupt_kind === 'confirm_mode' || (run.interrupt_schema || []).some((field) => field.name === 'mode');
  const continueLabel =
    run.interrupt_kind === 'policy' || run.interrupt_kind === 'safety'
      ? 'Review and continue'
      : run.interrupt_kind === 'review'
        ? 'Continue to delivery'
        : 'Continue';

  const pickFile = (file: string) => {
    onSelectFile(file);
    if (changedSet.has(file)) onInspectorTab('diff');
  };

  return (
    <div className="grid min-h-[640px] flex-1 gap-5 xl:grid-cols-[240px_minmax(0,1fr)_minmax(260px,300px)]">
      <aside className="app-paper flex min-h-[420px] flex-col overflow-hidden">
        <div className="border-b-[3px] border-black px-3 py-3">
          <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-neutral-500">Files</p>
          <p className="mt-1 text-[12px] text-black">
            {visibleFiles.length ? `${visibleFiles.length} in this frontend` : 'Looking through the repository…'}
            {changed.length ? <span className="text-neutral-500"> · {changed.length} edited</span> : null}
          </p>
        </div>
        <div className="customization-scrollbar min-h-0 flex-1 overflow-y-auto p-2">
          {visibleFiles.length === 0 ? (
            <p className="px-2 py-6 text-center text-[12px] leading-5 text-neutral-600">
              Frontend files from this repository show up here. Edited files move to the top after agents start writing.
            </p>
          ) : (
            visibleFiles.slice(0, 160).map((item) => {
              const edited = changedSet.has(item.file) || (item.status && item.status !== 'unchanged');
              const active = selectedFile === item.file;
              return (
                <button
                  type="button"
                  key={item.file}
                  onClick={() => pickFile(item.file)}
                  className={`mb-1 w-full border-[3px] px-2 py-2 text-left ${active ? 'border-black bg-black text-white' : 'border-transparent hover:border-black'}`}
                >
                  <span className="block truncate font-mono text-[11px]">{fileName(item.file)}</span>
                  <span className={`mt-1 block truncate text-[10px] ${active ? 'text-white/70' : 'text-neutral-500'}`}>
                    {fileDir(item.file) || 'root'}
                    {edited ? ' · edited' : ''}
                  </span>
                </button>
              );
            })
          )}
        </div>
      </aside>

      <div className="flex min-w-0 flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-[13px] text-neutral-600">
            <Eye className="h-4 w-4" />
            Live preview
            <span className="rounded-none border-[3px] border-black px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.08em]">
              {run.status === 'running' ? 'updating' : 'sandboxed iframe'}
            </span>
          </div>
          <div className="flex items-center gap-1">
            {PREVIEW_DEVICE_OPTIONS.map((item) => {
              const Icon = item.value === 'mobile' ? Smartphone : item.value === 'tablet' ? Tablet : Monitor;
              return (
                <button
                  type="button"
                  key={item.value}
                  onClick={() => onPreviewDevice(item.value)}
                  className={`inline-flex h-8 items-center gap-1 border-[3px] border-black px-2 text-[10px] font-bold ${
                    previewDevice === item.value ? 'bg-black text-white' : 'bg-white text-black'
                  }`}
                >
                  <Icon className="h-3.5 w-3.5" />
                  {item.label}
                </button>
              );
            })}
            <button type="button" onClick={onToggleCompare} className={`h-8 border-[3px] border-black px-2 text-[10px] font-bold ${compareOriginal ? 'bg-black text-white' : 'bg-white text-black'}`}>
              Compare original
            </button>
            <button type="button" onClick={onRefreshPreview} className="h-8 border-[3px] border-black bg-white px-2 text-[10px] font-bold text-black">
              Refresh
            </button>
          </div>
        </div>
        <div className={`grid min-h-0 flex-1 gap-3 ${compareOriginal ? 'lg:grid-cols-2' : ''}`}>
          {compareOriginal ? (
            <div className="border-[3px] border-black bg-neutral-100 p-4 text-sm text-neutral-600">
              <p className="font-semibold text-black">Original</p>
              <p className="mt-2 text-xs leading-5">The unmodified repository remains isolated in the run workspace. The live iframe shows the customized working copy only.</p>
            </div>
          ) : null}
          <div className="min-h-[360px]" style={{ width: previewDevice === 'desktop' ? '100%' : deviceWidth, maxWidth: '100%', margin: '0 auto' }}>
            <PreviewPanel meta={previewMeta} metaLoading={previewMetaLoading} frameSrc={previewFrameSrc} compact />
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {STUDIO_INSPECTOR_TABS.map((tab) => (
            <button
              type="button"
              key={tab.value}
              onClick={() => onInspectorTab(inspectorTab === tab.value ? null : tab.value)}
              className={`h-9 border-[3px] border-black px-3 text-[11px] font-bold ${
                inspectorTab === tab.value ? 'bg-black text-white' : 'bg-white text-black hover:bg-neutral-100'
              }`}
            >
              {tab.label}
            </button>
          ))}
          {inspectorTab ? (
            <button type="button" onClick={() => onInspectorTab(null)} className="inline-flex h-9 items-center gap-1 px-2 text-[11px] font-bold text-neutral-600 hover:text-black">
              <X className="h-3.5 w-3.5" /> Hide
            </button>
          ) : (
            <p className="text-[11px] text-neutral-500">Diff, activity, and review stay hidden until you open them.</p>
          )}
        </div>

        {inspectorTab ? (
          <div className="app-paper overflow-hidden">
            <div className="customization-scrollbar max-h-64 overflow-auto p-4 text-[12px]">
              {inspectorTab === 'changes' && (
                changed.length ? (
                  <ul className="space-y-2">
                    {changed.map((item) => (
                      <li key={item.file}>
                        <button type="button" onClick={() => pickFile(item.file)} className="flex w-full items-center justify-between gap-3 border-[3px] border-black px-3 py-2 text-left">
                          <span className="truncate font-mono">{item.file}</span>
                          <span>{item.kind}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : <p className="text-neutral-600">No files have been edited yet. The list on the left is the current frontend.</p>
              )}
              {inspectorTab === 'diff' && (
                selectedDiff ? (
                  <pre className="overflow-x-auto font-mono text-[11px] leading-5">
                    {selectedDiff.diff.split('\n').map((line, index) => (
                      <div key={`${selectedDiff.file}-${index}`} className={diffLineClassName(line)}>{line || ' '}</div>
                    ))}
                  </pre>
                ) : <p className="text-neutral-600">Select an edited file to inspect its diff.</p>
              )}
              {inspectorTab === 'logs' && (
                <div className="space-y-4">
                  <ol className="space-y-2">
                    {(run.events || []).length ? (run.events || []).map((event, index) => (
                      <li key={`${event.at}-${index}`} className="border-[3px] border-black px-3 py-2">
                        <p className="font-semibold text-black">{event.summary}</p>
                        <p className="mt-1 font-mono text-[10px] text-neutral-500">{event.stage} · {event.at}</p>
                      </li>
                    )) : <p className="text-neutral-600">Activity appears as the run moves through analysis and edits.</p>}
                  </ol>
                  {(run.checkpoints || []).length ? (
                    <ul className="space-y-2">
                      {(run.checkpoints || []).map((checkpoint) => (
                        <li key={checkpoint.checkpoint_id} className="flex items-center justify-between gap-3 border-[3px] border-black px-3 py-2">
                          <div>
                            <p className="font-semibold text-black">{checkpoint.summary || checkpoint.stage}</p>
                            <p className="font-mono text-[10px] text-neutral-500">Restore point</p>
                          </div>
                          <button type="button" disabled={restoring} onClick={() => onRestore(checkpoint.checkpoint_id)} className="inline-flex items-center gap-1 border-[3px] border-black px-2 py-1 text-[10px] font-bold">
                            <RotateCcw className="h-3 w-3" /> Restore
                          </button>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              )}
              {inspectorTab === 'review' && (
                <div className="space-y-4">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <ScoreBar label="UI quality" value={scores.ui_quality} />
                    <ScoreBar label="Consistency" value={scores.consistency} />
                    <ScoreBar label="Accessibility" value={scores.accessibility} />
                    <ScoreBar label="Functional safety" value={scores.functional_safety} />
                  </div>
                  <p className="font-semibold text-black">{review.summary || 'Review scores fill in after validation.'}</p>
                  <div className="space-y-2">
                    <p><span className="text-neutral-500">Branch:</span> <span className="font-mono">{run.github?.branch || 'Created when the run is ready'}</span></p>
                    <div className="flex flex-wrap gap-2">
                      <button type="button" onClick={() => void navigator.clipboard.writeText(run.github?.branch || '')} className="inline-flex items-center gap-1 border-[3px] border-black px-2 py-1 font-bold">
                        <Copy className="h-3 w-3" /> Copy branch
                      </button>
                      <button type="button" onClick={onCreatePr} disabled={creatingGitPr || !run.gate_passed} className="inline-flex items-center gap-1 border-[3px] border-black bg-black px-2 py-1 font-bold text-white disabled:opacity-40">
                        <GitPullRequest className="h-3 w-3" /> {creatingGitPr ? 'Creating PR…' : 'Open PR'}
                      </button>
                      <button type="button" disabled={!run.gate_passed} onClick={onDownloadZip} className="inline-flex items-center gap-1 border-[3px] border-black px-3 py-2 font-bold disabled:opacity-40">
                        <Download className="h-3.5 w-3.5" /> Download ZIP
                      </button>
                      <button type="button" disabled={!run.gate_passed || finalizing} onClick={onFinalize} className="inline-flex items-center gap-1 border-[3px] border-black bg-black px-3 py-2 font-bold text-white disabled:opacity-40">
                        {finalizing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldCheck className="h-3.5 w-3.5" />}
                        Prepare GitHub snapshot
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        ) : null}
      </div>

      <aside className="app-paper flex min-h-[420px] flex-col overflow-hidden">
        <div className="border-b-[3px] border-black px-4 py-4">
          <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-neutral-500">What’s happening</p>
          <p className="mt-1 text-sm font-semibold text-black">{runHeadline(run)}</p>
          <p className="mt-2 text-[12px] leading-5 text-neutral-600">{run.interrupt_required ? (run.interrupt_reason || 'A decision is needed before work continues.') : currentWork(run)}</p>
        </div>
        <div className="customization-scrollbar min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
          {STUDIO_PHASES.map((phase) => {
            const state = phaseState(run, phase.stages.map((stage) => stage.id));
            return (
              <div key={phase.id} className="border-[3px] border-black px-3 py-2">
                <p className="text-[12px] font-bold text-black">{phase.label}</p>
                <p className="mt-1 text-[11px] text-neutral-600">
                  {state === 'done' ? 'Done' : state === 'now' ? 'In progress' : 'Up next'}
                </p>
              </div>
            );
          })}
        </div>
        {run.interrupt_required ? (
          <div className="border-t-[3px] border-black p-4">
            <p className="flex items-start gap-2 text-[12px] leading-5 text-black">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              {modeConfirm
                ? 'We could not auto-detect this repo’s frontend stack. Continue with the mode you already chose, or switch it first.'
                : run.interrupt_reason || 'Review this before the run continues.'}
            </p>
            {modeConfirm ? (
              <div className="mt-3 grid gap-2">
                {CUSTOMIZATION_MODES.map((item) => (
                  <button
                    type="button"
                    key={item.value}
                    onClick={() => onModeChange(item.value)}
                    className={`border-[3px] px-2 py-2 text-left text-[11px] font-bold ${
                      mode === item.value ? 'border-black bg-black text-white' : 'border-black bg-white text-black'
                    }`}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            ) : null}
            <button type="button" onClick={onContinue} disabled={continuing} className="mt-3 inline-flex h-9 w-full items-center justify-center border-[3px] border-black bg-black px-3 text-[12px] font-bold text-white">
              {continuing ? 'Continuing…' : continueLabel}
            </button>
          </div>
        ) : (
          <div className="border-t-[3px] border-black p-4 text-[11px] leading-5 text-neutral-600">
            Business logic stays protected
            {(run.business_logic_boundary?.protected_file_count || 0) > 0
              ? ` · ${run.business_logic_boundary?.protected_file_count} files locked`
              : '. Agents only edit presentational UI.'}
          </div>
        )}
      </aside>
    </div>
  );
}
