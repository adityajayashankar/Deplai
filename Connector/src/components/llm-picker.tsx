'use client';

import { useState, useRef, useEffect } from 'react';
import { useLLM, LLM_PROVIDERS, type LLMProvider } from '@/lib/llm-context';

const PROVIDER_ICONS: Record<LLMProvider, React.ReactNode> = {
  // Anthropic double-A brand mark
  claude: (
    <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor">
      <path d="M13.827 3.52h3.603L24 20h-3.603l-6.57-16.48zm-7.257 0h3.604L16.744 20H13.14L6.57 3.52z" />
    </svg>
  ),
  openai: (
    <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor">
      <path d="M22.282 9.821a5.985 5.985 0 0 0-.516-4.91 6.046 6.046 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a5.985 5.985 0 0 0-3.998 2.9 6.046 6.046 0 0 0 .743 7.097 5.98 5.98 0 0 0 .51 4.911 6.051 6.051 0 0 0 6.515 2.9A5.985 5.985 0 0 0 13.26 24a6.056 6.056 0 0 0 5.772-4.206 5.99 5.99 0 0 0 3.997-2.9 6.056 6.056 0 0 0-.747-7.073zM13.26 22.43a4.476 4.476 0 0 1-2.876-1.04l.141-.081 4.779-2.758a.795.795 0 0 0 .392-.681v-6.737l2.02 1.168a.071.071 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.494 4.494zM3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085 4.783 2.759a.771.771 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.032.065L9.57 19.958a4.5 4.5 0 0 1-5.97-1.654zm-1.12-9.66a4.472 4.472 0 0 1 2.34-1.968V12.9a.766.766 0 0 0 .388.676l5.815 3.355-2.02 1.168a.076.076 0 0 1-.071 0L4.73 15.368A4.503 4.503 0 0 1 2.48 8.644zm16.44 3.862-5.836-3.37 2.02-1.163a.08.08 0 0 1 .071 0l4.103 2.367a4.5 4.5 0 0 1-.699 8.115v-5.654a.79.79 0 0 0-.659-.296zm2.01-3.023-.141-.085-4.774-2.782a.776.776 0 0 0-.785 0L9.409 9.99V7.658a.071.071 0 0 1 .028-.061l4.103-2.367a4.5 4.5 0 0 1 6.683 4.663zm-12.66 4.135-2.02-1.164a.08.08 0 0 1-.038-.057V7.245a4.5 4.5 0 0 1 7.375-3.453l-.142.08L8.67 6.63a.795.795 0 0 0-.394.681zm1.097-2.365 2.602-1.5 2.607 1.5v2.999l-2.597 1.5-2.607-1.5Z"/>
    </svg>
  ),
  gemini: (
    <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 24A14.304 14.304 0 0 0 0 12 14.304 14.304 0 0 0 12 0a14.305 14.305 0 0 0 12 12 14.305 14.305 0 0 0-12 12" />
    </svg>
  ),
  // Groq G letterform
  groq: (
    <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor">
      <path d="M20 12h-7v2h4.8c-.6 2.3-2.7 4-5.3 4-3 0-5.5-2.5-5.5-5.5S9.5 7 12.5 7c1.4 0 2.7.5 3.6 1.4l1.5-1.5C16.3 5.7 14.5 5 12.5 5 8.4 5 5 8.4 5 12.5S8.4 20 12.5 20c4.1 0 7.5-3.4 7.5-7.5V12z" />
    </svg>
  ),
  // OpenRouter: double-chevron (routing) icon
  openrouter: (
    <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor">
      <path d="M5.293 6.707L9.586 11H3v2h6.586l-4.293 4.293 1.414 1.414L13.414 12 6.707 5.293zM14.707 5.293l-1.414 1.414L17.586 11H11v2h6.586l-4.293 4.293 1.414 1.414L21.414 12z"/>
    </svg>
  ),
};

const PROVIDER_COLORS: Record<LLMProvider, string> = {
  claude:     'text-orange-400',
  openai:     'text-emerald-400',
  gemini:     'text-blue-400',
  groq:       'text-purple-400',
  openrouter: 'text-sky-400',
};

const PROVIDER_BG: Record<LLMProvider, string> = {
  claude:     'bg-orange-500/10 border-orange-500/20',
  openai:     'bg-emerald-500/10 border-emerald-500/20',
  gemini:     'bg-blue-500/10 border-blue-500/20',
  groq:       'bg-purple-500/10 border-purple-500/20',
  openrouter: 'bg-sky-500/10 border-sky-500/20',
};

// Preset model list per provider (label shown in dropdown, model sent to API)
const MODEL_OPTIONS: Record<LLMProvider, { model: string; label: string; desc: string }[]> = {
  claude: [
    { model: 'claude-sonnet-4-5',      label: 'Claude Sonnet 4.5',  desc: '200k Context' },
    { model: 'claude-opus-4-5',        label: 'Claude Opus 4.5',    desc: "Anthropic's Advanced Model" },
    { model: 'claude-3-5-haiku-20241022', label: 'Claude Haiku 3.5', desc: 'Fast & Lightweight' },
  ],
  openai: [
    { model: 'gpt-4o',        label: 'GPT-4o',       desc: "OpenAI's Latest Model" },
    { model: 'gpt-4o-mini',   label: 'GPT-4o Mini',  desc: 'Fast & Cost-Effective' },
    { model: 'o3-mini',       label: 'o3 Mini',      desc: 'Advanced Reasoning' },
  ],
  gemini: [
    { model: 'gemini-2.5-pro',   label: 'Gemini 2.5 Pro',   desc: "Google's Best Model" },
    { model: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', desc: 'Fastest Gemini' },
  ],
  groq: [
    { model: 'llama-3.3-70b-versatile',       label: 'Llama 3.3 70B',    desc: 'Fast Inference' },
    { model: 'llama-3.1-8b-instant',          label: 'Llama 3.1 8B',     desc: 'Ultra Fast' },
    { model: 'deepseek-r1-distill-llama-70b', label: 'DeepSeek R1 70B',  desc: 'Reasoning Model' },
  ],
  openrouter: [
    { model: 'anthropic/claude-opus-4-5',              label: 'Claude Opus 4.5',   desc: 'via OpenRouter' },
    { model: 'google/gemini-2.5-pro-preview',          label: 'Gemini 2.5 Pro',    desc: 'via OpenRouter' },
    { model: 'meta-llama/llama-3.3-70b-instruct:free', label: 'Llama 3.3 70B',    desc: 'Free · OpenRouter' },
  ],
};

export default function LLMPicker() {
  const { provider, setProvider, apiKeys, setApiKey, setModel, currentModel, currentConfig } = useLLM();
  const [open, setOpen] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [keyInput, setKeyInput] = useState('');
  const panelRef = useRef<HTMLDivElement>(null);

  // Sync key field on provider change
  useEffect(() => {
    setKeyInput(apiKeys[provider] || '');
    setShowKey(false);
  }, [provider, apiKeys]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const hasKey = !!apiKeys[provider]?.trim();
  const activeOptions = MODEL_OPTIONS[provider];
  const matchedLabel = activeOptions.find(o => o.model === currentModel)?.label
    ?? currentModel.split('/').pop()?.replace(/-/g, ' ') ?? currentModel;
  const shortLabel = matchedLabel.length > 20 ? matchedLabel.slice(0, 18) + '…' : matchedLabel;

  return (
    <div className="relative" ref={panelRef}>
      {/* Trigger */}
      <button
        onClick={() => setOpen(o => !o)}
        className={`flex items-center gap-2 px-3 py-1.5 rounded-lg border text-sm font-medium transition-all ${
          open
            ? 'bg-white/8 border-white/20 text-white'
            : 'bg-white/5 border-white/8 text-zinc-300 hover:bg-white/8 hover:border-white/15'
        }`}
      >
        <span className={PROVIDER_COLORS[provider]}>{PROVIDER_ICONS[provider]}</span>
        <span>{currentConfig.label}</span>
        <span className="text-zinc-500 text-xs">{shortLabel}</span>
        {hasKey && <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 shrink-0" title="API key saved" />}
        <svg className={`w-3.5 h-3.5 text-zinc-500 transition-transform shrink-0 ${open ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {/* Dropdown */}
      {open && (
        <div className="absolute top-full mt-2 right-0 w-72 bg-[#1C1C1F] border border-white/10 rounded-2xl shadow-2xl shadow-black/70 overflow-hidden z-100">

          {/* Provider icon tabs */}
          <div className="flex items-center gap-0.5 p-2 border-b border-white/8">
            {LLM_PROVIDERS.map(p => (
              <button
                key={p.id}
                onClick={() => setProvider(p.id)}
                title={p.label}
                className={`flex-1 flex items-center justify-center py-1.5 rounded-lg transition-all ${
                  provider === p.id
                    ? `${PROVIDER_BG[p.id]} ${PROVIDER_COLORS[p.id]}`
                    : 'text-zinc-600 hover:text-zinc-300 hover:bg-white/5'
                }`}
              >
                {PROVIDER_ICONS[p.id]}
              </button>
            ))}
          </div>

          {/* Model list */}
          <div className="py-1">
            {activeOptions.map(({ model, label, desc }) => {
              const selected = currentModel === model;
              return (
                <button
                  key={model}
                  onClick={() => { setModel(provider, model); setOpen(false); }}
                  className={`w-full flex items-center gap-3 px-4 py-2.5 transition-colors text-left ${
                    selected ? 'bg-white/6' : 'hover:bg-white/4'
                  }`}
                >
                  <span className={`${PROVIDER_COLORS[provider]} shrink-0`}>{PROVIDER_ICONS[provider]}</span>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-white">{label}</div>
                    <div className="text-xs text-zinc-500">{desc}</div>
                  </div>
                  {selected && (
                    <svg className="w-4 h-4 text-white shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                    </svg>
                  )}
                </button>
              );
            })}
          </div>

          {/* API Key section */}
          <div className="border-t border-white/8 px-4 py-3">
            <button
              onClick={() => setShowKey(k => !k)}
              className="flex items-center justify-between w-full"
            >
              <span className={`text-[11px] font-semibold uppercase tracking-wider ${hasKey ? 'text-emerald-500' : 'text-zinc-500 hover:text-zinc-300'} transition-colors`}>
                {hasKey ? '✓ API Key Saved' : '+ Add API Key'}
              </span>
              <svg className={`w-3 h-3 text-zinc-600 transition-transform ${showKey ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </button>
            {showKey && (
              <div className="mt-2.5 space-y-2">
                <input
                  type="password"
                  value={keyInput}
                  onChange={e => setKeyInput(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') { setApiKey(provider, keyInput.trim()); setShowKey(false); } }}
                  placeholder={currentConfig.placeholder}
                  className="w-full bg-black/50 border border-white/10 rounded-lg px-3 py-2 text-xs text-white placeholder-zinc-600 focus:border-indigo-500/50 outline-none font-mono"
                  autoFocus
                  autoComplete="off"
                />
                <div className="flex gap-2">
                  <button
                    onClick={() => { setApiKey(provider, keyInput.trim()); setShowKey(false); }}
                    className="flex-1 py-1.5 bg-white text-black text-xs font-semibold rounded-lg hover:bg-zinc-200 transition"
                  >
                    Save
                  </button>
                  {hasKey && (
                    <button
                      onClick={() => { setApiKey(provider, ''); setKeyInput(''); }}
                      className="px-3 py-1.5 bg-red-500/10 border border-red-500/20 text-red-400 text-xs rounded-lg hover:bg-red-500/20 transition"
                    >
                      Remove
                    </button>
                  )}
                </div>
                <p className="text-[10px] text-zinc-600">Stored in your browser only.</p>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

