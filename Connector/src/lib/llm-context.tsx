'use client';

import { createContext, useContext, useState, useEffect, useCallback } from 'react';

export type LLMProvider = 'claude' | 'openai' | 'gemini' | 'groq' | 'openrouter';

export interface LLMProviderConfig {
  id: LLMProvider;
  label: string;
  flagship: string;   // model slug sent to backend
  placeholder: string;
  keyPrefix: string;
}

export const LLM_PROVIDERS: LLMProviderConfig[] = [
  { id: 'claude',     label: 'Claude',     flagship: 'claude-opus-4-5',            placeholder: 'sk-ant-...',    keyPrefix: 'sk-ant-' },
  { id: 'openai',     label: 'OpenAI',     flagship: 'gpt-4o',                      placeholder: 'sk-...',        keyPrefix: 'sk-' },
  { id: 'gemini',     label: 'Gemini',     flagship: 'gemini-2.5-pro',              placeholder: 'AIza...',       keyPrefix: 'AIza' },
  { id: 'groq',       label: 'Groq',       flagship: 'llama-3.3-70b-versatile',    placeholder: 'gsk_...',       keyPrefix: 'gsk_' },
  { id: 'openrouter', label: 'OpenRouter', flagship: 'anthropic/claude-opus-4-5',  placeholder: 'sk-or-v1-...',  keyPrefix: 'sk-or-' },
];

const DEFAULT_MODELS: Record<LLMProvider, string> = {
  claude:     'claude-opus-4-5',
  openai:     'gpt-4o',
  gemini:     'gemini-2.5-pro',
  groq:       'llama-3.3-70b-versatile',
  openrouter: 'anthropic/claude-opus-4-5',
};

const LS_PROVIDER_KEY = 'deplai_llm_provider';
const LS_KEYS_KEY    = 'deplai_llm_keys';
const LS_MODELS_KEY  = 'deplai_llm_models';

interface LLMContextValue {
  provider: LLMProvider;
  setProvider: (p: LLMProvider) => void;
  apiKeys: Record<LLMProvider, string>;
  setApiKey: (provider: LLMProvider, key: string) => void;
  selectedModels: Record<LLMProvider, string>;
  setModel: (provider: LLMProvider, model: string) => void;
  currentKey: string;
  currentModel: string;
  currentConfig: LLMProviderConfig;
}

const LLMContext = createContext<LLMContextValue | null>(null);

export function LLMProviderContext({ children }: { children: React.ReactNode }) {
  const [provider, setProviderState] = useState<LLMProvider>('claude');
  const [apiKeys, setApiKeys] = useState<Record<LLMProvider, string>>(
    { claude: '', openai: '', gemini: '', groq: '', openrouter: '' }
  );
  const [selectedModels, setSelectedModels] = useState<Record<LLMProvider, string>>({ ...DEFAULT_MODELS });

  useEffect(() => {
    try {
      const savedProvider = localStorage.getItem(LS_PROVIDER_KEY) as LLMProvider | null;
      if (savedProvider && LLM_PROVIDERS.find(p => p.id === savedProvider)) {
        setProviderState(savedProvider);
      }
      const savedKeys = localStorage.getItem(LS_KEYS_KEY);
      if (savedKeys) setApiKeys(prev => ({ ...prev, ...JSON.parse(savedKeys) }));
      const savedModels = localStorage.getItem(LS_MODELS_KEY);
      if (savedModels) setSelectedModels(prev => ({ ...prev, ...JSON.parse(savedModels) }));
    } catch { /* ignore */ }
  }, []);

  const setProvider = useCallback((p: LLMProvider) => {
    setProviderState(p);
    try { localStorage.setItem(LS_PROVIDER_KEY, p); } catch { /* ignore */ }
  }, []);

  const setApiKey = useCallback((p: LLMProvider, key: string) => {
    setApiKeys(prev => {
      const next = { ...prev, [p]: key };
      try { localStorage.setItem(LS_KEYS_KEY, JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  }, []);

  const setModel = useCallback((p: LLMProvider, model: string) => {
    setSelectedModels(prev => {
      const next = { ...prev, [p]: model };
      try { localStorage.setItem(LS_MODELS_KEY, JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  }, []);

  const currentKey = apiKeys[provider] || '';
  const currentModel = selectedModels[provider] || DEFAULT_MODELS[provider];
  const currentConfig = LLM_PROVIDERS.find(p => p.id === provider) ?? LLM_PROVIDERS[0];

  return (
    <LLMContext.Provider value={{ provider, setProvider, apiKeys, setApiKey, selectedModels, setModel, currentKey, currentModel, currentConfig }}>
      {children}
    </LLMContext.Provider>
  );
}

export function useLLM() {
  const ctx = useContext(LLMContext);
  if (!ctx) throw new Error('useLLM must be used within LLMProviderContext');
  return ctx;
}
