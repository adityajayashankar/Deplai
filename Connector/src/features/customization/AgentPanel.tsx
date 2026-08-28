'use client';

import type { FormEvent, RefObject } from 'react';
import { Bot, Loader2, Send, Sparkles, User, Wand2 } from 'lucide-react';
import type { ChatMessage } from './types';
import { formatUiText } from './utils';

const SUGGESTIONS = [
  "Make the hero headline bolder and change the CTA to 'Start free trial'",
  'Switch the accent color to cyan and round the buttons',
  'Rewrite the subheading to sound more enterprise',
  'Give the landing a darker, high-contrast background',
];

const focusRing =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-black/35 focus-visible:ring-offset-2 focus-visible:ring-offset-white';

export function AgentPanel({
  messages,
  input,
  loading,
  disabled,
  chatEndRef,
  onInputChange,
  onSubmit,
  onSuggestionSubmit,
}: {
  messages: ChatMessage[];
  input: string;
  loading: boolean;
  disabled: boolean;
  chatEndRef: RefObject<HTMLDivElement | null>;
  onInputChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onSuggestionSubmit: (suggestion: string) => void;
}) {
  const hasConversation = messages.some((message) => message.role === 'user');

  return (
    <aside
      aria-label="Customization agent"
      className="app-paper flex min-h-[430px] min-w-0 flex-col overflow-hidden"
    >
      <header className="flex shrink-0 items-center gap-3 border-b-[3px] border-black px-6 py-5">
        <div className="flex h-10 w-10 items-center justify-center rounded-none border-[3px] border-black bg-black text-white">
          <Wand2 className="h-5 w-5" />
        </div>
        <div>
          <h2 className="font-display text-[15px] font-semibold text-black">Customization agent</h2>
          <p className="mt-0.5 text-[11px] text-zinc-600">presentational edits only</p>
        </div>
      </header>

      <div className="customization-scrollbar min-h-0 flex-1 overflow-y-auto px-6 py-7">
        {!hasConversation ? (
          <div className="mx-auto flex max-w-xl flex-col items-center pt-5 text-center">
            <Sparkles className="mb-6 h-7 w-7 text-violet-400" />
            <p className="text-[15px] text-neutral-700">Describe the change you want. Try one of these:</p>
            <div className="mt-6 w-full space-y-2.5 text-left">
              {SUGGESTIONS.map((suggestion) => (
                <button
                  type="button"
                  key={suggestion}
                  onClick={() => onSuggestionSubmit(suggestion)}
                  disabled={disabled || loading}
                  className={`w-full rounded-none border-[3px] border-black bg-white px-4 py-3 text-left text-[13px] leading-5 text-neutral-700 shadow-[4px_4px_0_0_#000] transition-transform hover:translate-x-0.5 hover:translate-y-0.5 hover:shadow-none disabled:cursor-not-allowed disabled:opacity-45 ${focusRing}`}
                >
                  {suggestion}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="space-y-5">
            {messages.map((message, index) => (
              <article key={`${message.timestamp}-${index}`} className={`flex gap-3 ${message.role === 'user' ? 'flex-row-reverse' : ''}`}>
                <span
                  className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-none border-[3px] border-black ${
                    message.role === 'agent'
                      ? 'bg-black text-white'
                      : 'bg-white text-black'
                  }`}
                >
                  {message.role === 'agent' ? <Bot className="h-3.5 w-3.5" /> : <User className="h-3.5 w-3.5" />}
                </span>
                <div className={`min-w-0 max-w-[86%] ${message.role === 'user' ? 'text-right' : ''}`}>
                  <p
                    className={`inline-block whitespace-pre-wrap rounded-none border-[3px] border-black px-3.5 py-3 text-left text-[13px] leading-5 ${
                      message.role === 'user'
                        ? 'bg-black text-white'
                        : 'bg-white text-black'
                    }`}
                  >
                    {formatUiText(message.content)}
                  </p>
                </div>
              </article>
            ))}
            {loading && (
              <p className="flex items-center gap-2 pl-10 text-xs text-zinc-500" role="status">
                <Loader2 className="h-3.5 w-3.5 animate-spin text-violet-400" />
                Applying changesâ€¦
              </p>
            )}
          </div>
        )}
        <div ref={chatEndRef} />
      </div>

      <div className="shrink-0 border-t-[3px] border-black p-5">
        <form onSubmit={onSubmit} className="flex gap-2.5">
          <label className="sr-only" htmlFor="customization-agent-prompt">
            Customization instruction
          </label>
          <input
            id="customization-agent-prompt"
            value={input}
            onChange={(event) => onInputChange(event.target.value)}
            disabled={loading || disabled}
            placeholder="e.g. make the CTA green and pill-shaped"
            className={`h-12 min-w-0 flex-1 rounded-none border-[3px] border-black bg-white px-4 text-[13px] text-black placeholder:text-neutral-500 disabled:opacity-50 ${focusRing}`}
          />
          <button
            type="submit"
            disabled={!input.trim() || loading || disabled}
            aria-label="Send instruction"
            className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-none border-[3px] border-black bg-black text-white shadow-[4px_4px_0_0_#000] transition-transform hover:translate-x-0.5 hover:translate-y-0.5 hover:shadow-none disabled:cursor-not-allowed disabled:opacity-30 ${focusRing}`}
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          </button>
        </form>
      </div>
    </aside>
  );
}
