"use client";

import { useEffect, useRef, useState } from "react";

const stages = [
  { step: "01", name: "Repository context", detail: "Connect GitHub and build a codebase map before work begins.", signal: "GitHub linked" },
  { step: "02", name: "Review security signals", detail: "Keep findings tied to the owned source and service they affect.", signal: "Findings reviewed" },
  { step: "03", name: "Generate infrastructure", detail: "Turn approved architecture decisions into a reviewable Terraform bundle.", signal: "IaC prepared" },
  { step: "04", name: "Verify runtime", detail: "Apply to AWS, verify endpoints, and retain the operational context.", signal: "Runtime ready" },
];

export function InfrastructureSection() {
  const [isVisible, setIsVisible] = useState(false);
  const [activeStage, setActiveStage] = useState(0);
  const sectionRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const observer = new IntersectionObserver(([entry]) => { if (entry.isIntersecting) setIsVisible(true); }, { threshold: 0.1 });
    if (sectionRef.current) observer.observe(sectionRef.current);
    return () => observer.disconnect();
  }, []);

  return (
    <section id="infra" ref={sectionRef} className="relative overflow-hidden py-24 lg:py-32">
      <div className="mx-auto max-w-[1400px] px-6 lg:px-12">
        <div className="grid items-end gap-8 lg:grid-cols-12">
          <div className="lg:col-span-7">
            <span className={`inline-flex items-center gap-3 font-mono text-sm text-muted-foreground transition-all duration-700 ${isVisible ? "opacity-100" : "opacity-0"}`}><span className="h-px w-12 bg-foreground/30" />Delivery workflow</span>
            <h2 className={`mt-7 max-w-4xl font-display text-5xl font-semibold leading-[0.92] tracking-[-0.05em] md:text-6xl lg:text-8xl transition-all duration-1000 ${isVisible ? "translate-y-0 opacity-100" : "translate-y-8 opacity-0"}`}>From source to service,<br /><span className="text-muted-foreground">with review at every step.</span></h2>
          </div>
          <p className={`max-w-xl text-lg leading-8 text-muted-foreground transition-all delay-150 duration-1000 lg:col-span-5 lg:pb-2 ${isVisible ? "translate-y-0 opacity-100" : "translate-y-4 opacity-0"}`}>DeplAI carries the decisions made in your repository through security, infrastructure, and runtime operations—without losing context between teams.</p>
        </div>
        <div className={`mt-16 grid gap-5 lg:grid-cols-[minmax(0,1.45fr)_minmax(300px,.75fr)] transition-all duration-1000 ${isVisible ? "translate-y-0 opacity-100" : "translate-y-8 opacity-0"}`}>
          <article className="overflow-hidden rounded-2xl border border-white/10 bg-white/[0.025] p-5 sm:p-7 lg:p-9">
            <div className="flex flex-col gap-3 border-b border-white/10 pb-6 sm:flex-row sm:items-end sm:justify-between"><div><p className="font-mono text-[11px] uppercase tracking-[0.16em] text-white/45">Delivery control plane</p><h3 className="mt-2 font-display text-3xl font-semibold tracking-[-0.04em]">One continuous workflow</h3></div><p className="max-w-xs text-sm leading-6 text-muted-foreground">Select a stage to inspect what carries forward.</p></div>
            <ol className="mt-5 space-y-2">{stages.map((stage, index) => { const isActive = activeStage === index; return <li key={stage.step}><button type="button" onMouseEnter={() => setActiveStage(index)} onFocus={() => setActiveStage(index)} onClick={() => setActiveStage(index)} className={`grid w-full grid-cols-[auto_1fr_auto] items-center gap-4 rounded-xl border px-4 py-4 text-left transition-colors sm:px-5 ${isActive ? "border-violet-300/30 bg-violet-300/[0.08]" : "border-white/8 bg-black/20 hover:border-white/20 hover:bg-white/[0.035]"}`}><span className={`font-mono text-xs ${isActive ? "text-violet-200" : "text-white/40"}`}>{stage.step}</span><span><span className="block text-sm font-semibold text-white">{stage.name}</span><span className="mt-1 block text-sm leading-6 text-muted-foreground">{stage.detail}</span></span><span className={`hidden rounded-full border px-2.5 py-1 font-mono text-[10px] sm:inline-flex ${isActive ? "border-violet-200/25 bg-violet-200/10 text-violet-100" : "border-white/10 text-white/45"}`}>{stage.signal}</span></button></li>; })}</ol>
          </article>
          <aside className="grid gap-5 sm:grid-cols-2 lg:grid-cols-1"><article className="rounded-2xl border border-white/10 bg-white/[0.025] p-7"><p className="font-mono text-[11px] uppercase tracking-[0.16em] text-violet-200">Review gates</p><h3 className="mt-8 font-display text-2xl font-semibold tracking-[-0.04em]">Approve before apply.</h3><p className="mt-3 text-sm leading-6 text-muted-foreground">Review remediation, architecture choices, and generated infrastructure before anything reaches a cloud account.</p></article><article className="rounded-2xl border border-white/10 bg-[linear-gradient(145deg,rgba(129,140,248,.14),rgba(255,255,255,.025))] p-7"><p className="font-mono text-[11px] uppercase tracking-[0.16em] text-violet-200">Runtime context</p><h3 className="mt-8 font-display text-2xl font-semibold tracking-[-0.04em]">Operate with the full picture.</h3><p className="mt-3 text-sm leading-6 text-muted-foreground">Track endpoints, infrastructure outputs, and managed AWS resources from the same workspace.</p></article></aside>
        </div>
      </div>
    </section>
  );
}
