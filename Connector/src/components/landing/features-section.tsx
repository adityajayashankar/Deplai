import {
  CheckCircle2,
  Github,
  Gitlab,
  HardDrive,
  MessageSquare,
  Network,
  ShieldAlert,
  Sparkles,
  User,
  type LucideIcon,
} from "lucide-react";
import type { ReactNode } from "react";

type IntegrationBadgeProps = {
  icon?: LucideIcon;
  label: string;
  active?: boolean;
  status?: string;
};

type FeatureCardProps = {
  title: string;
  description: string;
  icon: LucideIcon;
  children: ReactNode;
};

function IntegrationBadge({ icon: Icon, label, active, status }: IntegrationBadgeProps) {
  return (
    <span className={`inline-flex items-center gap-2 rounded-full border px-4 py-2 text-sm font-medium transition-colors ${active ? "border-[#FF7A9E]/40 bg-[#1A1418]/70 text-[#F5F5F7] hover:bg-[#25161D]" : "border-[#F25577]/50 bg-transparent text-[#FF7A9E]/60"}`}>
      {Icon && <Icon className="h-4 w-4" />}
      {label}
      {status && <span className="ml-1 text-[10px] uppercase tracking-wider text-[#FF7A9E]/80">- {status}</span>}
    </span>
  );
}

function FeatureCard({ title, description, icon: Icon, children }: FeatureCardProps) {
  return (
    <article className="group relative overflow-hidden rounded-2xl border border-white/[0.08] transition-all duration-500 hover:border-[#FF95B0]/40" style={{ background: "linear-gradient(145deg, #111214 0%, #1A1418 55%, #25161D 100%)", boxShadow: "0 20px 60px rgba(0,0,0,.35)" }}>
      <div className="pointer-events-none absolute -inset-px z-0 bg-gradient-to-br from-[#F25577]/20 to-[#FF7A9E]/10 opacity-0 blur-2xl transition-opacity duration-500 group-hover:opacity-100" />
      <div className="relative z-10 flex h-full flex-col">
        <div className="h-48 overflow-hidden border-b border-white/[0.08] bg-gradient-to-b from-[#25161D]/70 to-transparent">
          {children}
        </div>
        <div className="p-6">
          <div className="mb-2 flex items-center gap-3">
            <Icon className="h-4 w-4 text-[#FF7A9E] transition-colors group-hover:text-[#FF95B0]" />
            <h3 className="text-sm font-semibold uppercase tracking-wide text-[#F5F5F7]">{title}</h3>
          </div>
          <p className="text-sm font-light leading-relaxed text-[#A7A7B0]">{description}</p>
        </div>
      </div>
    </article>
  );
}

function CodebaseMap() {
  return (
    <div className="relative flex h-full w-full items-center justify-center">
      <svg viewBox="0 0 200 100" className="h-full w-full overflow-visible" aria-hidden="true">
        <path d="M100 50 L40 20 M100 50 L40 80 M100 50 L160 20 M100 50 L160 80" stroke="#F25577" strokeWidth="1.5" opacity="0.45" />
        <path d="M100 50 L40 20 M100 50 L40 80 M100 50 L160 20 M100 50 L160 80" stroke="url(#repositoryMapGradient)" strokeWidth="2" className="repository-animate-flow" opacity="0.8" />
        <g className="origin-center transition-transform duration-500 group-hover:scale-110">
          <circle cx="100" cy="50" r="14" fill="#000000" stroke="url(#repositoryMapGradient)" strokeWidth="2" />
          <circle cx="100" cy="50" r="24" fill="none" stroke="url(#repositoryMapGradient)" strokeWidth="1" opacity="0.4" className="repository-pulse-ring" />
        </g>
        {[[40, 20], [40, 80], [160, 20], [160, 80]].map(([cx, cy]) => <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r="8" fill="#1A1418" stroke="#F25577" strokeWidth="1.5" />)}
      </svg>
    </div>
  );
}

function AgentConversation() {
  return (
    <div className="relative flex h-full flex-col justify-center gap-3 overflow-hidden px-6 py-2">
      <div className="repository-chat-user relative z-10 w-[85%] self-end origin-bottom-right rounded-2xl rounded-tr-sm border border-[#FF7A9E]/30 bg-gradient-to-r from-[#25161D] to-[#F25577]/30 p-3 shadow-lg">
        <div className="mb-2 flex items-center justify-end gap-3">
          <div className="flex w-full flex-col items-end gap-1.5">
            <span className="h-1.5 w-full max-w-[120px] rounded-full bg-[#F5F5F7]/80" />
            <span className="h-1.5 w-2/3 rounded-full bg-[#F5F5F7]/40" />
          </div>
          <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full border border-[#FF7A9E]/40 bg-[#FF7A9E]/20"><User className="h-3 w-3 text-[#F5F5F7]" /></span>
        </div>
      </div>

      <div className="relative h-[100px] w-full self-start">
        <div className="repository-chat-typing absolute left-0 top-0 flex h-10 w-16 origin-bottom-left items-center justify-center gap-1.5 rounded-2xl rounded-tl-sm border border-[#F25577]/60 bg-[#111214] p-3 shadow-xl">
          <span className="repository-blink h-1.5 w-1.5 rounded-full bg-[#FF7A9E]" />
          <span className="repository-blink h-1.5 w-1.5 rounded-full bg-[#FF7A9E] [animation-delay:0.2s]" />
          <span className="repository-blink h-1.5 w-1.5 rounded-full bg-[#FF7A9E] [animation-delay:0.4s]" />
        </div>

        <div className="repository-chat-reply absolute left-0 top-0 w-[90%] origin-bottom-left rounded-2xl rounded-tl-sm border border-[#F25577]/60 bg-[#111214]/95 p-3.5 shadow-[0_0_20px_rgba(255,122,158,0.12)] transition-colors duration-500 group-hover:border-[#FF95B0]/50">
          <div className="mb-2.5 flex items-center gap-2.5">
            <span className="grid h-5 w-5 place-items-center rounded-full bg-gradient-to-tr from-[#F25577] to-[#FF8DAA] shadow-[0_0_10px_rgba(255,122,158,0.12)]"><Sparkles className="h-3 w-3 text-[#F5F5F7]" /></span>
            <div className="flex flex-1 gap-2"><span className="h-1.5 w-1/2 rounded-full bg-[#F5F5F7]/60" /><span className="h-1.5 w-1/4 rounded-full bg-[#F5F5F7]/30" /></div>
          </div>
          <div className="relative flex h-12 w-full items-center justify-center overflow-hidden rounded-lg border border-[#FF7A9E]/30 bg-[#25161D]/70">
            <svg viewBox="0 0 100 40" className="h-full w-full overflow-visible drop-shadow-[0_0_8px_rgba(255,122,158,0.12)]" aria-hidden="true">
              <path d="M35 20 L65 20" stroke="url(#repositoryMapGradient)" strokeWidth="1.5" strokeDasharray="100" className="repository-box-draw" />
              <rect x="15" y="10" width="20" height="20" rx="4" stroke="#FF7A9E" strokeWidth="1" strokeDasharray="100" className="repository-box-draw" />
              <circle cx="25" cy="20" r="4" fill="#FF7A9E" opacity="0.5" className="repository-blink-slow" />
              <rect x="65" y="10" width="20" height="20" rx="4" stroke="#F5F5F7" strokeWidth="1" strokeDasharray="100" className="repository-box-draw" />
              <circle cx="75" cy="20" r="4" fill="#F5F5F7" opacity="0.5" className="repository-blink-slow" />
            </svg>
            <span className="repository-chat-scan absolute left-0 top-0 h-full w-[2px] bg-gradient-to-b from-transparent via-[#F5F5F7] to-transparent shadow-[0_0_8px_rgba(255,122,158,0.35)]" />
          </div>
        </div>
      </div>
    </div>
  );
}

function SecurityContext() {
  return (
    <div className="relative flex h-full w-full items-center justify-center p-6">
      <div className="relative w-full max-w-[200px] overflow-hidden rounded-md border border-[#F25577]/60 bg-[#1A1418]/70 p-4 font-mono text-[8px] leading-relaxed">
        <span className="mb-2 block h-1.5 w-3/4 rounded bg-[#25161D]" />
        <span className="mb-2 block h-1.5 w-1/2 rounded bg-[#25161D]" />
        <span className="relative mb-2 block h-1.5 w-full rounded border border-[#FF7A9E]/60 bg-[#25161D]"><span className="absolute -left-2 top-1/2 h-1 w-1 -translate-y-1/2 rounded-full bg-[#F5F5F7] animate-ping" /></span>
        <span className="mb-2 block h-1.5 w-5/6 rounded bg-[#25161D]" />
        <span className="block h-1.5 w-2/3 rounded bg-[#25161D]" />
        <span className="repository-scan-line absolute left-0 z-20 h-[2px] w-full bg-gradient-to-r from-transparent via-[#FF7A9E] to-transparent shadow-[0_0_8px_rgba(255,122,158,0.35)]" />
        <span className="repository-scan-fade absolute left-0 z-10 h-8 w-full bg-gradient-to-b from-transparent to-[#25161D]/60" />
      </div>
    </div>
  );
}

const bars = ["60%", "80%", "40%", "90%", "50%", "70%", "100%", "65%"];

function DeploymentReadiness() {
  return (
    <div className="relative flex h-full w-full items-center justify-center gap-6 p-6">
      <div className="relative h-28 w-28 shrink-0 transition-transform duration-700 group-hover:scale-105">
        <svg viewBox="0 0 100 100" className="h-full w-full overflow-visible" aria-hidden="true">
          <circle cx="50" cy="50" r="45" fill="none" stroke="#F25577" strokeWidth="1" opacity="0.45" />
          <circle cx="50" cy="50" r="35" fill="none" stroke="#F25577" strokeWidth="4" opacity="0.3" />
          <g className="origin-center animate-[spin_8s_linear_infinite]"><circle cx="50" cy="50" r="45" fill="none" stroke="url(#repositoryReadyGradient)" strokeWidth="2" strokeDasharray="4 8" /></g>
          <g className="origin-center animate-[spin_12s_linear_infinite_reverse]"><circle cx="50" cy="50" r="35" fill="none" stroke="url(#repositoryReadyGradient)" strokeWidth="5" strokeDasharray="60 40 30 20" strokeLinecap="round" className="opacity-80" /></g>
          <text x="50" y="54" textAnchor="middle" fill="#F5F5F7" fontSize="14" fontWeight="bold" fontFamily="monospace">92%</text>
        </svg>
        <div className="absolute inset-0 overflow-hidden rounded-full border border-[#FF7A9E]/20 shadow-[inset_0_0_20px_rgba(255,122,158,0.12)]">
          <span className="absolute left-1/2 top-1/2 h-[2px] w-1/2 origin-left bg-gradient-to-r from-transparent via-[#F5F5F7] to-white animate-[spin_3s_linear_infinite]" />
          <span className="absolute left-1/2 top-1/2 h-1/2 w-1/2 origin-top-left bg-gradient-to-br from-[#FF7A9E]/40 to-transparent animate-[spin_3s_linear_infinite] [clip-path:polygon(0_0,100%_0,100%_100%)]" />
        </div>
      </div>

      <div className="flex flex-1 flex-col gap-4">
        <div className="flex h-12 items-end gap-1 border-b border-[#F25577]/50 pb-1">
          {bars.map((height, index) => <span key={`${height}-${index}`} className="relative h-full w-full overflow-hidden rounded-t-sm bg-[#25161D]"><span className="repository-bar-pulse absolute bottom-0 w-full origin-bottom rounded-t-sm bg-gradient-to-t from-[#F25577] to-[#FF8DAA]" style={{ height, animationDelay: `${-0.2 * index}s` }} /></span>)}
        </div>
        <div className="space-y-2.5">
          {["w-full", "w-[75%]"].map((width, index) => (
            <div key={width} className="flex items-center gap-3">
              <span className="h-1.5 w-1.5 rounded-full bg-[#F5F5F7] shadow-[0_0_8px_#FF7A9E] animate-pulse" style={index ? { animationDelay: "0.5s" } : undefined} />
              <span className="h-1 flex-1 overflow-hidden rounded-full bg-[#25161D]"><span className={`block h-full ${width} bg-gradient-to-r from-[#F25577] to-[#FF8DAA]`} /></span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function FeaturesSection() {
  return (
    <section id="features" className="relative min-h-screen overflow-hidden px-8 py-16 font-sans text-[#F5F5F7] md:px-16" style={{ background: "radial-gradient(circle at 80% 0%, rgba(255,122,158,.08), transparent 40%), linear-gradient(180deg, #050505 0%, #090909 100%)" }}>
      <div className="pointer-events-none absolute right-1/4 top-0 h-[600px] w-[600px] rounded-full bg-[#FF7A9E]/10 blur-[150px]" />
      <div className="pointer-events-none absolute bottom-0 left-1/4 h-[500px] w-[500px] rounded-full bg-[#F25577]/10 blur-[120px]" />
      <svg className="absolute h-0 w-0" aria-hidden="true">
        <defs>
          <linearGradient id="repositoryMapGradient" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stopColor="#F25577" /><stop offset="100%" stopColor="#FF7A9E" /></linearGradient>
          <linearGradient id="repositoryReadyGradient" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stopColor="#FF7A9E" /><stop offset="100%" stopColor="#F5F5F7" /></linearGradient>
        </defs>
      </svg>

      <div className="relative z-10 mx-auto w-full max-w-[1200px]">
        <div className="mb-16 max-w-3xl">
          <h2 className="mb-6 text-4xl font-bold tracking-tight text-[#F5F5F7] md:text-5xl">Repository intelligence</h2>
          <p className="mb-8 text-lg font-light text-[#A7A7B0]">Bring repositories and local files into one unified security and deployment workflow.</p>
          <div className="flex flex-wrap items-center gap-3">
            <IntegrationBadge icon={Github} label="GitHub" active />
            <IntegrationBadge icon={HardDrive} label="Local files" active />
            <IntegrationBadge icon={Gitlab} label="GitLab" status="soon" />
            <IntegrationBadge label="Bitbucket" status="soon" />
          </div>
        </div>

        <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
          <FeatureCard title="Codebase Map" description="Unified topology of all dependencies, frameworks, and services." icon={Network}><CodebaseMap /></FeatureCard>
          <FeatureCard title="Agent Conversation" description="Specify your infrastructure needs in plain English and get tailored blueprints." icon={MessageSquare}><AgentConversation /></FeatureCard>
          <FeatureCard title="Security Context" description="Vulnerabilities traced directly back to affected source code lines." icon={ShieldAlert}><SecurityContext /></FeatureCard>
          <FeatureCard title="Deployment Readiness" description="Pre-flight validation for missing configurations and architecture decisions." icon={CheckCircle2}><DeploymentReadiness /></FeatureCard>
        </div>
      </div>
    </section>
  );
}
