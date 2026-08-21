'use client';

import type { FormEvent, RefObject } from 'react';
import { Bot, Key, Loader2, PanelLeftClose, RotateCcw, Send, Sparkles, User } from 'lucide-react';
import type { ChatMessage } from './types';
import { formatUiText } from './utils';

const focusRing =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-300 focus-visible:ring-offset-2 focus-visible:ring-offset-[#0a0a0b]';

export function AgentPanel({
  open,
  width,
  messages,
  input,
  loading,
  disabled,
  byokLabel,
  chatEndRef,
  onInputChange,
  onSubmit,
  onClose,
  onOpenByok,
  onResetSession,
  onResizeStart,
}: {
  open: boolean;
  width: number;
  messages: ChatMessage[];
  input: string;
  loading: boolean;
  disabled: boolean;
  byokLabel: string;
  chatEndRef: RefObject<HTMLDivElement | null>;
  onInputChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onClose: () => void;
  onOpenByok: () => void;
  onResetSession: () => void;
  onResizeStart: () => void;
}) {
  if (!open) return null;
  return (
    <aside
      aria-label="Customization agent"
      style={{ width }}
      className="absolute inset-y-0 left-0 z-30 flex max-w-[88vw] shrink-0 flex-col border-r border-white/8 bg-[#0c0c0e] shadow-2xl md:relative md:z-10 md:shadow-none"
    >
      <div className="flex h-11 shrink-0 items-center justify-between border-b border-white/8 px-3">
        <div className="flex min-w-0 items-center gap-2">
          <Bot className="h-4 w-4 shrink-0 text-zinc-400" />
          <span className="truncate text-xs font-medium text-zinc-200">Agent</span>
          <button
            type="button"
            onClick={onOpenByok}
            className={`inline-flex items-center gap-1 rounded border border-white/10 px-1.5 py-1 text-[9px] font-medium text-zinc-500 hover:bg-white/5 hover:text-zinc-200 ${focusRing}`}
            title="Configure bring-your-own-key"
          >
            <Key className="h-2.5 w-2.5" />
            {byokLabel}
          </button>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={onResetSession}
            aria-label="Reset agent session"
            className={`rounded p-1.5 text-zinc-600 hover:bg-white/5 hover:text-zinc-300 ${focusRing}`}
          >
            <RotateCcw className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close agent panel"
            className={`rounded p-1.5 text-zinc-600 hover:bg-white/5 hover:text-zinc-300 ${focusRing}`}
          >
            <PanelLeftClose className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
      <div className="customization-scrollbar flex-1 space-y-5 overflow-y-auto p-4">
        {messages.map((message, index) => (
          <article key={`${message.timestamp}-${index}`} className={`flex gap-2.5 ${message.role === 'user' ? 'flex-row-reverse' : ''}`}>
            <span
              className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full border ${
                message.role === 'agent'
                  ? 'border-white/10 bg-zinc-100 text-zinc-950'
                  : 'border-white/10 bg-zinc-800 text-zinc-300'
              }`}
            >
              {message.role === 'agent' ? <Bot className="h-3 w-3" /> : <User className="h-3 w-3" />}
            </span>
            <div className={`min-w-0 ${message.role === 'user' ? 'text-right' : ''}`}>
              <div className="mb-1 flex items-center gap-2 text-[9px] text-zinc-700">
                <span>{message.role === 'agent' ? 'DeplAI' : 'You'}</span>
                <time>{message.timestamp}</time>
              </div>
              <p
                className={`inline-block max-w-full whitespace-pre-wrap text-left text-xs leading-5 ${
                  message.role === 'user'
                    ? 'rounded-lg rounded-tr-sm bg-zinc-100 px-3 py-2 text-zinc-950'
                    : 'text-zinc-400'
                }`}
              >
                {formatUiText(message.content)}
              </p>
            </div>
          </article>
        ))}
        {loading && (
          <div className="flex items-center gap-2 text-xs text-zinc-500" role="status">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Updating manifest…
          </div>
        )}
        <div ref={chatEndRef} />
      </div>
      <div className="border-t border-white/8 p-3">
        <form onSubmit={onSubmit}>
          <label className="sr-only" htmlFor="customization-agent-prompt">
            Customization instruction
          </label>
          <div className="flex items-end rounded-lg border border-white/10 bg-[#09090b] focus-within:border-zinc-500">
            <Sparkles className="mb-3 ml-3 h-3.5 w-3.5 shrink-0 text-zinc-600" />
            <textarea
              id="customization-agent-prompt"
              value={input}
              onChange={(event) => onInputChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }
              }}
              rows={2}
              disabled={loading || disabled}
              placeholder="Describe a customization…"
              className="max-h-32 min-h-16 flex-1 resize-none bg-transparent px-2 py-2.5 text-xs leading-5 text-zinc-200 placeholder:text-zinc-700 focus:outline-none disabled:opacity-50"
            />
            <button
              type="submit"
              disabled={!input.trim() || loading || disabled}
              aria-label="Send instruction"
              className={`m-2 rounded-md bg-zinc-100 p-2 text-zinc-950 transition hover:bg-white disabled:cursor-not-allowed disabled:opacity-30 ${focusRing}`}
            >
              <Send className="h-3.5 w-3.5" />
            </button>
          </div>
          <p className="mt-2 text-[9px] text-zinc-700">Changes stop at Review until you confirm them.</p>
        </form>
      </div>
      <button
        type="button"
        tabIndex={-1}
        aria-hidden="true"
        onMouseDown={onResizeStart}
        className="absolute inset-y-0 -right-1 hidden w-2 cursor-col-resize md:block"
      />
    </aside>
  );
}
