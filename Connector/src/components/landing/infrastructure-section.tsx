import {
  Activity,
  Cloud,
  Code2,
  DollarSign,
  FileCode2,
  GitBranch,
  Key,
  Layers,
  Link,
  MessageSquare,
  ShieldCheck,
  Terminal,
  type LucideIcon,
} from "lucide-react";

type WorkflowNode = {
  id: string;
  title: string;
  step: string;
  x: number;
  y: number;
  icons: LucideIcon[];
  path: string;
};

const workflow: WorkflowNode[] = [
  {
    id: "n1",
    title: "Codebase Analysis",
    step: "01",
    x: 200,
    y: 380,
    icons: [GitBranch, Code2, Terminal],
    path: "M 420 210 L 420 260 Q 420 275 405 275 L 215 275 Q 200 275 200 290 L 200 320",
  },
  {
    id: "n2",
    title: "Interactive Agent",
    step: "02",
    x: 200,
    y: 580,
    icons: [MessageSquare, Activity],
    path: "M 450 210 L 450 290 Q 450 305 435 305 L 115 305 Q 100 305 100 320 L 100 490 Q 100 505 115 505 L 200 505 L 200 520",
  },
  {
    id: "n3",
    title: "Arch & Cost Est.",
    step: "03",
    x: 500,
    y: 360,
    icons: [Layers, DollarSign],
    path: "M 480 210 L 480 240 Q 480 255 490 260 L 500 265 L 500 300",
  },
  {
    id: "n4",
    title: "Review & Approval",
    step: "04",
    x: 500,
    y: 560,
    icons: [ShieldCheck, Key],
    path: "M 520 210 L 520 240 Q 520 255 535 255 L 650 255 Q 665 255 665 270 L 665 470 Q 665 485 650 485 L 500 485 L 500 500",
  },
  {
    id: "n5",
    title: "Generate & Deploy",
    step: "05",
    x: 800,
    y: 380,
    icons: [FileCode2, Cloud, Terminal],
    path: "M 550 210 L 550 260 Q 550 275 565 275 L 785 275 Q 800 275 800 290 L 800 320",
  },
  {
    id: "n6",
    title: "Post-Deploy Artifacts",
    step: "06",
    x: 800,
    y: 580,
    icons: [Link, Key, Activity],
    path: "M 580 210 L 580 290 Q 580 305 595 305 L 885 305 Q 900 305 900 320 L 900 490 Q 900 505 885 505 L 800 505 L 800 520",
  },
];

function HexNode({
  x,
  y,
  title,
  step,
  icons,
  scale = 1,
  isHub = false,
}: {
  x: number;
  y: number;
  title?: string;
  step?: string;
  icons?: LucideIcon[];
  scale?: number;
  isHub?: boolean;
}) {
  const width = 260;
  const height = 140;

  return (
    <div
      className="group pointer-events-auto absolute -translate-x-1/2 -translate-y-1/2"
      style={{
        left: `${(x / 1000) * 100}%`,
        top: `${(y / 750) * 100}%`,
        width: `${width * scale}px`,
        height: `${height * scale}px`,
      }}
    >
      <svg viewBox={`0 0 ${width} ${height}`} className="h-full w-full drop-shadow-[0_0_15px_rgba(72,168,154,0.15)]" aria-hidden="true">
        <polygon
          points="40,10 220,10 250,50 220,90 40,90 10,50"
          fill={isHub ? "#05393F" : "#000000"}
          stroke="#48A89A"
          strokeWidth={isHub ? "2" : "1.5"}
          className="transition-colors duration-500 group-hover:fill-[#00524D]"
        />
        <polygon points="40,90 220,90 220,120 40,120" fill={isHub ? "#00524D" : "#05393F"} stroke="#48A89A" strokeWidth="1.5" />
        <polygon points="10,50 40,90 40,120 10,80" fill="#000000" stroke="#48A89A" strokeWidth="1.5" />
        <polygon points="220,90 250,50 250,80 220,120" fill="#000000" stroke="#48A89A" strokeWidth="1.5" />
        {isHub && (
          <g>
            <rect x="70" y="96" width="120" height="18" fill="#000000" stroke="#CBEFEB" strokeWidth="1" opacity="0.6" />
            {[0, 1, 2, 3, 4, 5, 6].map((index) => (
              <rect
                key={`data-light-${index}`}
                x={74 + index * 16}
                y={100}
                width="12"
                height="10"
                fill={index % 3 === 0 ? "#CBEFEB" : "#48A89A"}
                className="animate-pulse"
                style={{
                  animationDuration: `${1.5 + index * 0.2}s`,
                  animationDelay: `${index * 0.15}s`,
                  opacity: 0.8,
                }}
              />
            ))}
          </g>
        )}
      </svg>

      <div className="absolute inset-0 flex flex-col items-center justify-center text-center" style={{ top: "10px", height: `${80 * scale}px` }}>
        {isHub ? (
          <div className="-mt-2 flex flex-col items-center justify-center">
            <h2 className="text-lg font-semibold tracking-wide text-[#CBEFEB] drop-shadow-md" style={{ fontSize: `${16 * scale}px` }}>Enterprise</h2>
            <h3 className="mt-1 text-sm font-medium tracking-widest text-[#48A89A]" style={{ fontSize: `${12 * scale}px` }}>AI-ORCHESTRATOR</h3>
          </div>
        ) : (
          <div className="-mt-1 flex w-[80%] flex-col items-center justify-center">
            <h3 className="text-[13px] font-medium leading-tight text-[#CBEFEB]">{title}</h3>
            <span className="mt-1 font-mono text-[10px] tracking-wider text-[#48A89A] opacity-80">STEP {step}</span>
          </div>
        )}
      </div>

      {!isHub && icons && (
        <div className="absolute inset-0 flex items-center justify-center gap-3" style={{ top: `${90 * scale}px`, height: `${30 * scale}px` }}>
          {icons.map((Icon, index) => <Icon key={index} className="h-[14px] w-[14px] text-[#CBEFEB] opacity-80" strokeWidth={2} />)}
        </div>
      )}
    </div>
  );
}

export function InfrastructureSection() {
  return (
    <section id="infra" className="relative">
      <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-black font-sans">
        <div
          className="pointer-events-none absolute inset-0 z-0"
          style={{
            backgroundImage: "radial-gradient(circle, #05393F 1px, transparent 1px)",
            backgroundSize: "24px 24px",
            opacity: 0.6,
          }}
        />
        <div className="pointer-events-none absolute left-1/2 top-0 h-[400px] w-[800px] -translate-x-1/2 rounded-full bg-[#05393F]/40 blur-[120px]" />
        <div className="pointer-events-none absolute bottom-10 left-10 h-[400px] w-[400px] rounded-full bg-[#00524D]/20 blur-[120px]" />

        <main className="relative z-10 aspect-[4/3] max-h-screen w-full max-w-[1200px]">
          <svg viewBox="0 0 1000 750" className="pointer-events-none absolute inset-0 h-full w-full" aria-hidden="true">
            <defs>
              <linearGradient id="flowGrad" x1="0%" y1="0%" x2="100%" y2="0%">
                <stop offset="0%" stopColor="#00524D" />
                <stop offset="50%" stopColor="#48A89A" />
                <stop offset="100%" stopColor="#CBEFEB" />
              </linearGradient>
              <filter id="neonGlow" x="-20%" y="-20%" width="140%" height="140%">
                <feGaussianBlur stdDeviation="4" result="blur" />
                <feComposite in="SourceGraphic" in2="blur" operator="over" />
              </filter>
            </defs>

            {workflow.map((node, index) => (
              <g key={`path-${node.id}`}>
                <path d={node.path} fill="none" stroke="#05393F" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                <path
                  d={node.path}
                  fill="none"
                  stroke="url(#flowGrad)"
                  strokeWidth="3"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  filter="url(#neonGlow)"
                  className="animate-flow"
                  style={{ animationDelay: `${index * 0.5}s` }}
                />
              </g>
            ))}
          </svg>

          <HexNode x={500} y={130} isHub scale={1.4} />
          {workflow.map((node) => <HexNode key={node.id} {...node} />)}
        </main>
      </div>
    </section>
  );
}
