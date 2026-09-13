'use client';

import { useEffect, useRef } from 'react';
import { Bot, Send, User, LoaderCircle, ArrowRight } from 'lucide-react';
import { buttonClass } from './deployment-ui';
import type { InfraConsultantMessage } from './state';

export function DeploymentConversation({ messages, input, onInput, onSend, loading, ready, onPlan, locked }: {
  messages: InfraConsultantMessage[]; input: string; onInput: (value: string) => void;
  onSend: () => void; loading: boolean; ready: boolean; onPlan: () => void; locked: boolean;
}) {
  const scroll = useRef<HTMLDivElement>(null);
  useEffect(() => { scroll.current?.scrollTo({ top: scroll.current.scrollHeight, behavior: 'smooth' }); }, [messages, loading]);
  return (
    <section className="overflow-hidden border-[3px] border-black bg-white shadow-[6px_6px_0_0_#000]">
      <header className="flex items-center justify-between gap-3 border-b-[3px] border-black px-5 py-4">
        <div className="flex items-center gap-3"><Bot className="h-5 w-5" /><div><h2 className="font-semibold text-black">Deployment conversation</h2><p className="mt-1 text-xs text-neutral-500">Tell DeplAI what you need. We’ll work through the setup together.</p></div></div>
        <span className="font-mono text-[10px] uppercase tracking-widest text-neutral-500">{loading ? 'Thinking' : locked ? 'Plan ready' : 'GLM 5.3'}</span>
      </header>
      <div ref={scroll} role="log" aria-label="Deployment planning conversation" aria-live="polite" aria-busy={loading} className="max-h-[520px] min-h-[280px] space-y-6 overflow-y-auto p-5 sm:p-7">
        {messages.map((message, index) => (
          <article key={index} className={`flex gap-3 ${message.role === 'user' ? 'flex-row-reverse' : ''}`}>
            <div className={`flex h-8 w-8 shrink-0 items-center justify-center border-2 border-black ${message.role === 'user' ? 'bg-black text-white' : 'bg-white text-black'}`}>{message.role === 'user' ? <User size={15} /> : <Bot size={15} />}</div>
            <div className={`max-w-[85%] border-2 border-black px-4 py-3 ${message.role === 'user' ? 'bg-black text-white' : 'bg-neutral-50 text-black'}`}>
              <p className="mb-2 font-mono text-[10px] uppercase tracking-widest opacity-60">{message.role === 'user' ? 'You' : 'DeplAI'}</p>
              <p className="whitespace-pre-wrap break-words text-sm leading-7">{message.content}</p>
            </div>
          </article>
        ))}
        {loading && <p role="status" className="flex items-center gap-2 text-sm text-neutral-500"><LoaderCircle size={16} className="animate-spin" />DeplAI is considering your requirements…</p>}
        {!loading && messages.length === 0 && <p className="text-sm text-neutral-500">Start the conversation to discuss your deployment requirements.</p>}
      </div>
      <form className="border-t-[3px] border-black p-4" onSubmit={(event) => { event.preventDefault(); if (input.trim() && !loading && !locked) onSend(); }}>
        <label htmlFor="deployment-message" className="sr-only">Message DeplAI about your deployment</label>
        <div className="flex items-end gap-3">
          <textarea id="deployment-message" value={input} onChange={(event) => onInput(event.target.value)} disabled={loading || locked} maxLength={3000} rows={3}
            placeholder="Describe what you’re building, ask a question, or tell us what matters to you…"
            className="min-w-0 flex-1 resize-y border-2 border-black bg-white p-3 text-sm leading-6 text-black outline-none focus:ring-2 focus:ring-black/20 disabled:bg-neutral-100"
            onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); if (input.trim() && !loading && !locked) onSend(); } }} />
          <button type="submit" aria-label="Send message" disabled={loading || locked || !input.trim()} className={buttonClass('primary', { disabled: loading || locked || !input.trim() })}><Send size={17} /><span className="hidden sm:inline">Send</span></button>
        </div>
        <p className="mt-2 text-xs text-neutral-500">{locked ? 'Your plan is ready for review below. Choose Change answers to continue the conversation.' : 'Enter to send · Shift+Enter for a new line. Keep passwords and API keys for the Secrets step.'}</p>
        {ready && !locked && <button type="button" disabled={loading} onClick={onPlan} className={`${buttonClass('primary', { disabled: loading })} mt-4`}>Generate my deployment plan <ArrowRight size={16} /></button>}
      </form>
    </section>
  );
}
