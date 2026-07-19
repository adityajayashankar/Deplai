"use client";

import { Eye, FileCheck, Lock, Shield } from "lucide-react";
import { useEffect, useRef, useState } from "react";

const securityChecks = [
  { code: "SAST", title: "Static application testing", detail: "Inspect source code for vulnerable patterns and insecure implementation paths." },
  { code: "DAST", title: "Dynamic application testing", detail: "Test reachable application behavior and runtime surfaces after deployment." },
  { code: "SCA", title: "Software composition analysis", detail: "Identify vulnerable dependencies, license signals, and supply-chain exposure." },
];

const workflowControls = [
  { icon: Shield, title: "Repository ownership", detail: "Verify the project and GitHub installation before protected actions run." },
  { icon: Lock, title: "Server-side credentials", detail: "Keep GitHub App tokens out of long-lived browser storage." },
  { icon: Eye, title: "Review before execution", detail: "Inspect remediation and infrastructure changes before approval." },
  { icon: FileCheck, title: "Validation trail", detail: "Retain scan, remediation, and runtime context in the project workflow." },
];

const providers = ["OpenAI", "Anthropic", "Gemini", "BYOK"];

export function SecuritySection() {
  const [isVisible, setIsVisible] = useState(false);
  const sectionRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const observer = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting) setIsVisible(true); },
      { threshold: 0.1 }
    );
    if (sectionRef.current) observer.observe(sectionRef.current);
    return () => observer.disconnect();
  }, []);

  return (
    <section id="security" ref={sectionRef} className="relative overflow-hidden py-24 lg:py-32">
      <div className="mx-auto max-w-[1400px] px-6 lg:px-12">
        <div className="grid items-end gap-8 lg:grid-cols-12">
          <div className="lg:col-span-7">
            <span className={`inline-flex items-center gap-3 font-mono text-sm text-muted-foreground transition-all duration-700 ${isVisible ? "opacity-100" : "opacity-0"}`}>
              <span className="h-px w-12 bg-foreground/30" />
              Security coverage
            </span>
            <h2 className={`mt-7 max-w-4xl font-display text-5xl font-semibold leading-[0.92] tracking-[-0.05em] md:text-6xl lg:text-8xl transition-all duration-1000 ${isVisible ? "translate-y-0 opacity-100" : "translate-y-8 opacity-0"}`}>
              Find risk early.
              <br />
              <span className="text-muted-foreground">Remediate with control.</span>
            </h2>
          </div>
          <p className={`max-w-xl text-lg leading-8 text-muted-foreground transition-all delay-150 duration-1000 lg:col-span-5 lg:pb-2 ${isVisible ? "translate-y-0 opacity-100" : "translate-y-4 opacity-0"}`}>
            Run layered checks against source, dependencies, and reachable application surfacesâ€”then take validated remediation through a reviewable workflow.
          </p>
        </div>

        <div className={`mt-16 grid gap-5 lg:grid-cols-12 transition-all duration-1000 ${isVisible ? "translate-y-0 opacity-100" : "translate-y-8 opacity-0"}`}>
          <article className="rounded-2xl border border-white/10 bg-white/[0.025] p-6 sm:p-8 lg:col-span-7">
            <div className="flex flex-col justify-between gap-3 border-b border-white/10 pb-6 sm:flex-row sm:items-end">
              <div>
                <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-violet-200">Checks we offer</p>
                <h3 className="mt-2 font-display text-3xl font-semibold tracking-[-0.04em]">Layered security analysis</h3>
              </div>
              <p className="max-w-xs text-sm leading-6 text-muted-foreground">Choose the checks that fit the repository and deployment stage.</p>
            </div>

            <div className="mt-6 grid gap-3 md:grid-cols-3">
              {securityChecks.map((check) => (
                <div key={check.code} className="rounded-xl border border-white/10 bg-black/20 p-5">
                  <span className="font-mono text-xs tracking-[0.16em] text-violet-200">{check.code}</span>
                  <h4 className="mt-5 text-sm font-semibold text-white">{check.title}</h4>
                  <p className="mt-2 text-sm leading-6 text-muted-foreground">{check.detail}</p>
                </div>
              ))}
            </div>

            <div className="mt-6 grid gap-3 border-t border-white/10 pt-6 sm:grid-cols-3">
              <div>
                <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-white/45">Estimated scan time</p>
                <p className="mt-2 text-sm font-semibold text-white">Calculated per scan</p>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">Based on repository size and selected checks.</p>
              </div>
              <div>
                <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-white/45">Validation success rate</p>
                <p className="mt-2 text-sm font-semibold text-white">Tracked per project</p>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">Measured after remediation validation completes.</p>
              </div>
              <div>
                <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-white/45">Remediation progress</p>
                <p className="mt-2 text-sm font-semibold text-white">Tracked per finding</p>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">Keep review and approval state visible end to end.</p>
              </div>
            </div>
          </article>

          <div className="lg:col-span-5">
            <article className="rounded-2xl border border-white/10 bg-[linear-gradient(145deg,rgba(129,140,248,.14),rgba(255,255,255,.025))] p-7">
              <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-violet-200">AI remediation</p>
              <h3 className="mt-3 font-display text-3xl font-semibold tracking-[-0.04em]">Use the model you trust.</h3>
              <p className="mt-3 text-sm leading-6 text-muted-foreground">Generate remediation for found vulnerabilities with OpenAI, Anthropic, Gemini, or your own provider key.</p>
              <div className="mt-6 flex flex-wrap gap-2">
                {providers.map((provider) => <span key={provider} className="rounded-full border border-violet-200/20 bg-violet-200/[0.08] px-3 py-1.5 font-mono text-[11px] text-violet-100">{provider}</span>)}
              </div>
            </article>
          </div>

          <article className="overflow-hidden rounded-2xl border border-white/10 bg-white/[0.025] lg:col-span-12">
            <div className="grid lg:grid-cols-12">
              <div className="relative min-h-[330px] overflow-hidden border-b border-white/10 bg-black lg:col-span-5 lg:border-b-0 lg:border-r">
                <img
                  src="/images/shield.png"
                  alt="Repository ownership checks"
                  className="absolute inset-0 h-full w-full object-cover object-center opacity-80"
                />
                <div className="absolute inset-0 bg-[linear-gradient(90deg,rgba(0,0,0,.2),rgba(0,0,0,.74)),linear-gradient(0deg,rgba(0,0,0,.76),transparent_55%)]" />
                <div className="absolute inset-x-0 bottom-0 p-7 sm:p-8">
                  <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-violet-100">Workflow controls</p>
                  <p className="mt-5 font-display text-6xl font-semibold leading-none tracking-[-0.06em] text-white">4</p>
                  <p className="mt-2 text-sm text-white/65">Core control boundaries for protected project actions.</p>
                  <div className="mt-6 flex flex-wrap gap-2">
                    {["GitHub OAuth", "GitHub App", "Approval gates", "Project ownership"].map((item) => (
                      <span key={item} className="border border-white/15 bg-black/35 px-2.5 py-1 font-mono text-[10px] text-white/70">{item}</span>
                    ))}
                  </div>
                </div>
              </div>
              <div className="p-6 sm:p-7 lg:col-span-7 lg:p-8">
                <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-white/45">Built for reviewable execution</p>
                <h3 className="mt-2 font-display text-3xl font-semibold tracking-[-0.04em]">Controls that stay close to the work.</h3>
                <div className="mt-6 grid gap-3 sm:grid-cols-2">
                {workflowControls.map(({ icon: Icon, title, detail }) => (
                  <div key={title} className="rounded-xl border border-white/8 bg-black/20 p-4">
                    <Icon className="h-4 w-4 text-violet-200" />
                    <h4 className="mt-4 text-sm font-semibold text-white">{title}</h4>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">{detail}</p>
                  </div>
                ))}
                </div>
              </div>
            </div>
          </article>
        </div>
      </div>
    </section>
  );
}
