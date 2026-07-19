import {
  ArrowRight,
  Bot,
  Box,
  CheckCircle2,
  Clock,
  GitPullRequest,
  Search,
  Shield,
} from "lucide-react";

const scanTypes = [
  { code: "SAST", label: "Code" },
  { code: "DAST", label: "Runtime" },
  { code: "SCA", label: "Dependencies" },
];

const stages = [
  { icon: Search, label: "Scan", detail: "SAST · DAST · SCA" },
  { icon: Shield, label: "Triage", detail: "Risk map" },
  { icon: Bot, label: "Remediate", detail: "AI-assisted" },
  { icon: CheckCircle2, label: "Validate", detail: "Review gate" },
];

const metrics = [
  { icon: Clock, label: "Scan ETA", value: "Per scan" },
  { icon: CheckCircle2, label: "Success rate", value: "Per project" },
  { icon: GitPullRequest, label: "Remediation", value: "Per finding" },
];

const controls = ["Repository ownership", "Server-side tokens", "Approval gates", "Validation trail"];
const providers = ["OpenAI", "Anthropic", "Gemini", "BYOK"];

export function SecuritySection() {
  return (
    <section id="security" className="relative overflow-hidden py-24 lg:py-32">
      <div className="mx-auto max-w-[1400px] px-6 lg:px-12">
        <div className="grid items-end gap-8 lg:grid-cols-12">
          <div className="lg:col-span-8">
            <span className="inline-flex items-center gap-3 font-mono text-sm text-muted-foreground">
              <span className="h-px w-12 bg-foreground/30" />
              Security workflow
            </span>
            <h2 className="mt-7 font-display text-5xl font-semibold leading-[0.92] tracking-[-0.05em] md:text-6xl lg:text-8xl">
              See risk. <span className="text-muted-foreground">Ship the fix.</span>
            </h2>
          </div>
          <p className="font-mono text-xs uppercase tracking-[0.16em] text-violet-200 lg:col-span-4 lg:pb-3">
            Scan → review → remediate → validate
          </p>
        </div>

        <div className="mt-14 grid gap-5 lg:grid-cols-12">
          <article className="overflow-hidden rounded-2xl border border-white/10 bg-white/[0.025] lg:col-span-8">
            <div className="flex items-center justify-between border-b border-white/10 px-6 py-4 sm:px-7">
              <span className="font-mono text-[11px] uppercase tracking-[0.16em] text-violet-200">Protected delivery lane</span>
              <span className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.14em] text-white/45"><span className="h-1.5 w-1.5 rounded-full bg-violet-200" /> Active</span>
            </div>
            <div className="grid divide-y divide-white/10 sm:grid-cols-4 sm:divide-x sm:divide-y-0">
              {stages.map(({ icon: Icon, label, detail }, index) => (
                <div key={label} className="relative p-6 sm:min-h-48 sm:p-7">
                  <span className="font-mono text-[10px] text-white/35">0{index + 1}</span>
                  <Icon className="mt-7 h-5 w-5 text-violet-200" strokeWidth={1.5} />
                  <h3 className="mt-5 text-lg font-semibold text-white">{label}</h3>
                  <p className="mt-1 font-mono text-[11px] uppercase tracking-[0.1em] text-muted-foreground">{detail}</p>
                  {index < stages.length - 1 && <ArrowRight className="absolute right-3 top-1/2 hidden h-4 w-4 -translate-y-1/2 text-white/25 sm:block" />}
                </div>
              ))}
            </div>
            <div className="grid gap-2 border-t border-white/10 p-4 sm:grid-cols-3 sm:p-5">
              {scanTypes.map((scan) => (
                <div key={scan.code} className="flex items-center justify-between rounded-lg border border-white/10 bg-black/20 px-4 py-3">
                  <span className="font-mono text-xs tracking-[0.16em] text-violet-100">{scan.code}</span>
                  <span className="text-xs text-muted-foreground">{scan.label}</span>
                </div>
              ))}
            </div>
          </article>

          <aside className="relative min-h-80 overflow-hidden rounded-2xl border border-white/10 bg-black lg:col-span-4">
            <img src="/images/shield.png" alt="" aria-hidden="true" className="absolute inset-0 h-full w-full object-cover object-center opacity-55" />
            <div className="absolute inset-0 bg-[linear-gradient(135deg,rgba(8,8,12,.95),rgba(8,8,12,.34)),linear-gradient(0deg,rgba(8,8,12,.88),transparent)]" />
            <div className="relative flex h-full min-h-80 flex-col justify-between p-7">
              <div>
                <span className="font-mono text-[11px] uppercase tracking-[0.16em] text-violet-200">AI remediation</span>
                <h3 className="mt-3 font-display text-4xl font-semibold tracking-[-0.05em] text-white">Your model.<br />Your key.</h3>
              </div>
              <div className="flex flex-wrap gap-2">
                {providers.map((provider) => <span key={provider} className="rounded-full border border-white/20 bg-black/30 px-3 py-1.5 font-mono text-[11px] text-white/90">{provider}</span>)}
              </div>
            </div>
          </aside>
        </div>

        <article className="mt-5 overflow-hidden rounded-2xl border border-white/10 bg-white/[0.025]">
          <div className="grid lg:grid-cols-12">
            <div className="border-b border-white/10 p-6 sm:p-7 lg:col-span-4 lg:border-b-0 lg:border-r">
              <span className="font-mono text-[11px] uppercase tracking-[0.16em] text-white/45">Control metrics</span>
              <div className="mt-6 grid grid-cols-3 gap-3 lg:grid-cols-1">
                {metrics.map(({ icon: Icon, label, value }) => (
                  <div key={label} className="flex items-start gap-3">
                    <Icon className="mt-0.5 h-4 w-4 shrink-0 text-violet-200" strokeWidth={1.5} />
                    <div>
                      <p className="font-mono text-[10px] uppercase tracking-[0.1em] text-white/45">{label}</p>
                      <p className="mt-1 text-sm font-medium text-white">{value}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
            <div className="p-6 sm:p-7 lg:col-span-8">
              <div className="flex items-center justify-between gap-4">
                <span className="font-mono text-[11px] uppercase tracking-[0.16em] text-white/45">Workflow controls</span>
                <Box className="h-4 w-4 text-violet-200" strokeWidth={1.5} />
              </div>
              <div className="mt-6 grid gap-3 sm:grid-cols-2">
                {controls.map((control, index) => (
                  <div key={control} className="flex items-center gap-4 rounded-xl border border-white/8 bg-black/20 px-4 py-4">
                    <span className="font-mono text-xs text-violet-200">0{index + 1}</span>
                    <span className="text-sm font-medium text-white">{control}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </article>
      </div>
    </section>
  );
}
