'use client';

import { useState } from 'react';
import { useLLM, LLM_PROVIDERS } from '@/lib/llm-context';

interface RemediationRequestProps {
  isOpen: boolean;
  onClose: () => void;
  onContinue: (githubToken?: string, llmProvider?: string, llmApiKey?: string, llmModel?: string) => void;
  projectType?: 'local' | 'github' | null;
}

const REMEDIATION_PROVIDER = 'claude' as const;
const REMEDIATION_PROVIDER_CONFIG = LLM_PROVIDERS.find((provider) => provider.id === REMEDIATION_PROVIDER)!;
const REMEDIATION_DEFAULT_MODEL = 'claude-sonnet-4-5';

export default function RemediationRequest({ isOpen, onClose, onContinue, projectType }: RemediationRequestProps) {
  const [githubToken, setGithubToken] = useState('');
  const { apiKeys, setApiKey, selectedModels, setModel } = useLLM();
  const [keyInput, setKeyInput] = useState('');
  const [modelInput, setModelInput] = useState('');

  if (!isOpen) return null;

  const handleContinue = () => {
    const token = githubToken.trim();
    const key = keyInput.trim();
    const model = modelInput.trim() || REMEDIATION_DEFAULT_MODEL;
    if (key && key !== apiKeys[REMEDIATION_PROVIDER]) setApiKey(REMEDIATION_PROVIDER, key);
    if (model !== selectedModels[REMEDIATION_PROVIDER]) setModel(REMEDIATION_PROVIDER, model);
    onContinue(token || undefined, REMEDIATION_PROVIDER, key || apiKeys[REMEDIATION_PROVIDER] || undefined, model);
    setGithubToken('');
    onClose();
  };

  const handleClose = () => {
    setGithubToken('');
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-200">
      {/* Modal */}
      <div className="bg-[#101012] border border-white/10 rounded-2xl w-full max-w-md shadow-2xl relative overflow-hidden animate-in zoom-in-95 duration-200">

        {/* Top glow accent */}
        <div className="absolute top-0 left-1/2 -translate-x-1/2 w-4/5 h-24 bg-indigo-500/20 blur-[50px] pointer-events-none" />

        {/* Close button */}
        <button
          onClick={handleClose}
          className="absolute top-4 right-4 text-zinc-500 hover:text-white transition-colors bg-white/5 hover:bg-white/10 p-1.5 rounded-lg z-10"
          aria-label="Close"
        >
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>

        <div className="p-6 pt-8">
          {/* Header */}
          <div className="flex flex-col items-center text-center mb-6">
            <div className="relative w-14 h-14 rounded-2xl bg-linear-to-br from-indigo-500/10 to-purple-500/10 border border-indigo-500/20 flex items-center justify-center mb-5 shadow-[0_0_20px_rgba(99,102,241,0.15)]">
              <div className="absolute inset-0 bg-indigo-500/20 blur-xl rounded-2xl" />
              <svg className="w-7 h-7 text-indigo-400 relative z-10" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.5">
                <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 00-2.456 2.456zM16.894 20.567L16.5 21.75l-.394-1.183a2.25 2.25 0 00-1.423-1.423L13.5 18.75l1.183-.394a2.25 2.25 0 001.423-1.423l.394-1.183.394 1.183a2.25 2.25 0 001.423 1.423l1.183.394-1.183.394a2.25 2.25 0 00-1.423 1.423z" />
              </svg>
            </div>
            <h2 className="text-2xl font-bold text-white tracking-tight">AI Remediation</h2>
            <p className="text-[15px] text-zinc-400 mt-2 leading-relaxed">
              Fix detected security vulnerabilities with <span className="text-zinc-200 font-medium">Agent417</span>
            </p>
          </div>

          {/* Claude remediation config */}
          <div className="mb-5">
            <label className="block text-sm font-medium text-zinc-300 mb-2.5">Remediation Agent</label>
            <div className="rounded-xl border border-orange-500/20 bg-orange-500/10 px-3 py-2.5">
              <div className="text-sm font-semibold text-orange-200">Claude Agent SDK</div>
              <p className="mt-1 text-[11px] leading-relaxed text-orange-100/70">
                Remediation runs on Claude only. Other LLM providers are not used for this workflow.
              </p>
            </div>
            {/* Model text input */}
            <div className="mt-2.5">
              <input
                type="text"
                value={modelInput !== '' ? modelInput : REMEDIATION_DEFAULT_MODEL}
                onChange={e => setModelInput(e.target.value)}
                onFocus={() => { if (modelInput === '') setModelInput(REMEDIATION_DEFAULT_MODEL); }}
                placeholder={REMEDIATION_DEFAULT_MODEL}
                className="w-full bg-black/40 border border-white/10 rounded-xl px-3 py-2.5 text-xs text-white placeholder-zinc-600 focus:border-indigo-500/50 focus:ring-1 focus:ring-indigo-500/30 outline-none transition-all font-mono"
                autoComplete="off"
                spellCheck={false}
              />
            </div>
            {/* API key input */}
            <div className="mt-2 relative">
              <input
                type="password"
                value={keyInput !== '' ? keyInput : (apiKeys[REMEDIATION_PROVIDER] || '')}
                onChange={e => setKeyInput(e.target.value)}
                onFocus={() => { if (keyInput === '') setKeyInput(apiKeys[REMEDIATION_PROVIDER] || ''); }}
                placeholder={REMEDIATION_PROVIDER_CONFIG.placeholder || 'API key...'}
                className="w-full bg-black/40 border border-white/10 rounded-xl px-3 py-2.5 text-xs text-white placeholder-zinc-600 focus:border-indigo-500/50 focus:ring-1 focus:ring-indigo-500/30 outline-none transition-all font-mono"
                autoComplete="off"
                spellCheck={false}
              />
            </div>
            <p className="text-[10px] text-zinc-600 mt-1.5">Key stored in your browser — never sent to our servers</p>
          </div>

          {/* GitHub token input */}
          <div className="mb-7">
            <label className="block text-sm font-medium text-zinc-300 mb-2">
              GitHub Token
              {projectType !== 'github' && (
                <span className="text-zinc-500 font-normal ml-1">(optional)</span>
              )}
              <span className="text-zinc-500 font-normal ml-1">— runtime only, never stored</span>
            </label>
            <div className="relative">
              <input
                type="password"
                value={githubToken}
                onChange={(e) => setGithubToken(e.target.value)}
                placeholder="ghp_... (used to create a PR for this run)"
                className="w-full bg-black/40 border border-white/10 rounded-xl pl-10 pr-4 py-3.5 text-[15px] text-white placeholder-zinc-600 focus:border-indigo-500/50 focus:ring-1 focus:ring-indigo-500/50 outline-none transition-all"
                autoComplete="off"
              />
              <svg className="w-4 h-4 text-zinc-500 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" />
              </svg>
            </div>
          </div>

          {/* Action buttons */}
          <div className="flex gap-3">
            <button
              onClick={handleClose}
              className="flex-1 bg-white/5 hover:bg-white/10 text-white font-semibold py-3.5 rounded-xl transition-colors border border-white/10"
            >
              Cancel
            </button>
            <button
              onClick={handleContinue}
              className="flex-2 bg-white hover:bg-zinc-200 text-black font-semibold py-3.5 rounded-xl transition-colors shadow-[0_0_20px_rgba(255,255,255,0.15)] flex items-center justify-center gap-2"
            >
              Continue
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M14 5l7 7m0 0l-7 7m7-7H3" />
              </svg>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}


