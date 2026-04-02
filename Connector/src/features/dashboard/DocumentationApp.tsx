// @ts-nocheck
'use client';

import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { 
  Book, LayoutGrid, TerminalSquare, Code, ChevronRight, Search, ArrowLeft,
  Server, Database, Globe, Network, Cpu, ShieldAlert, Settings, Activity,
  AlertCircle, ArrowRight, ArrowDown, Play, FileJson, Layers, Users, Box, HardDrive,
  GitPullRequest, CheckCircle2, Shield, Terminal, Key, FileCode2, Copy, Info,
  Rocket, Cloud, User
} from 'lucide-react';

// ==========================================
// PIXEL CARD COMPONENT
// ==========================================

class Pixel {
  constructor(canvas, context, x, y, color, speed, delay) {
    const dpr = window.devicePixelRatio || 1;
    this.width = canvas.width / dpr;
    this.height = canvas.height / dpr;
    this.ctx = context;
    this.x = x;
    this.y = y;
    this.color = color;
    this.speed = (Math.random() * 0.8 + 0.1) * speed;
    this.size = 0;
    this.sizeStep = Math.random() * 0.4;
    this.minSize = 0.5;
    this.maxSizeInteger = 2;
    this.maxSize = Math.random() * (this.maxSizeInteger - this.minSize) + this.minSize;
    this.delay = delay;
    this.counter = 0;
    this.counterStep = Math.random() * 4 + (this.width + this.height) * 0.01;
    this.isIdle = false;
    this.isReverse = false;
    this.isShimmer = false;
  }

  draw() {
    const centerOffset = this.maxSizeInteger * 0.5 - this.size * 0.5;
    this.ctx.fillStyle = this.color;
    this.ctx.fillRect(Math.round(this.x + centerOffset), Math.round(this.y + centerOffset), Math.round(this.size), Math.round(this.size));
  }

  appear() {
    this.isIdle = false;
    if (this.counter <= this.delay) { this.counter += this.counterStep; return; }
    if (this.size >= this.maxSize) this.isShimmer = true;
    if (this.isShimmer) this.shimmer();
    else this.size += this.sizeStep;
    this.draw();
  }

  disappear() {
    this.isShimmer = false;
    this.counter = 0;
    if (this.size <= 0) { this.isIdle = true; return; }
    else this.size -= 0.1;
    this.draw();
  }

  shimmer() {
    if (this.size >= this.maxSize) this.isReverse = true;
    else if (this.size <= this.minSize) this.isReverse = false;
    if (this.isReverse) this.size -= this.speed;
    else this.size += this.speed;
  }
}

const PixelCard = ({ gap = 5, speed = 35, colors = '#18181b,#27272a,#3f3f46', noFocus = false, className = '', children }) => {
  const containerRef = useRef(null);
  const canvasRef = useRef(null);
  const pixelsRef = useRef([]);
  const animationRef = useRef(null);
  const timePreviousRef = useRef(performance.now());
  const reducedMotion = useRef(window.matchMedia('(prefers-reduced-motion: reduce)').matches).current;

  const initPixels = useCallback(() => {
    if (!containerRef.current || !canvasRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const width = Math.floor(rect.width);
    const height = Math.floor(rect.height);
    const ctx = canvasRef.current.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    canvasRef.current.width = width * dpr;
    canvasRef.current.height = height * dpr;
    if (ctx) ctx.scale(dpr, dpr);

    const colorsArray = colors.split(',');
    const pxs = [];
    for (let x = 0; x < width; x += gap) {
      for (let y = 0; y < height; y += gap) {
        const color = colorsArray[Math.floor(Math.random() * colorsArray.length)];
        const distance = Math.sqrt(Math.pow(x - width / 2, 2) + Math.pow(y - height / 2, 2));
        if (!ctx) return;
        pxs.push(new Pixel(canvasRef.current, ctx, x, y, color, (speed * 0.001), reducedMotion ? 0 : distance));
      }
    }
    pixelsRef.current = pxs;
  }, [colors, gap, reducedMotion, speed]);

  const doAnimate = useCallback((fnName) => {
    animationRef.current = requestAnimationFrame(() => doAnimate(fnName));
    const timeNow = performance.now();
    const timePassed = timeNow - timePreviousRef.current;
    if (timePassed < 1000 / 60) return;
    timePreviousRef.current = timeNow - (timePassed % (1000 / 60));

    const ctx = canvasRef.current?.getContext('2d');
    if (!ctx || !canvasRef.current) return;
    const dpr = window.devicePixelRatio || 1;
    ctx.clearRect(0, 0, canvasRef.current.width / dpr, canvasRef.current.height / dpr);

    let allIdle = true;
    pixelsRef.current.forEach(pixel => {
      pixel[fnName]();
      if (!pixel.isIdle) allIdle = false;
    });
    if (allIdle && animationRef.current) cancelAnimationFrame(animationRef.current);
  }, []);

  const handleAnimation = useCallback((name) => {
    if (animationRef.current !== null) cancelAnimationFrame(animationRef.current);
    animationRef.current = requestAnimationFrame(() => doAnimate(name));
  }, [doAnimate]);

  useEffect(() => {
    initPixels();
    const observer = new ResizeObserver(() => initPixels());
    if (containerRef.current) observer.observe(containerRef.current);
    return () => { observer.disconnect(); if (animationRef.current !== null) cancelAnimationFrame(animationRef.current); };
  }, [initPixels]);

  return (
    <div
      ref={containerRef}
      className={`relative overflow-hidden isolate transition-colors duration-200 ease-[cubic-bezier(0.5,1,0.89,1)] select-none ${className}`}
      onMouseEnter={() => handleAnimation('appear')}
      onMouseLeave={() => handleAnimation('disappear')}
      onFocus={(e) => { if (!noFocus && !e.currentTarget.contains(e.relatedTarget)) handleAnimation('appear'); }}
      onBlur={(e) => { if (!noFocus && !e.currentTarget.contains(e.relatedTarget)) handleAnimation('disappear'); }}
      tabIndex={noFocus ? -1 : 0}
    >
      <canvas className="absolute inset-0 w-full h-full block pointer-events-none z-0 mix-blend-lighten" ref={canvasRef} />
      <div className="relative z-10 w-full h-full flex flex-col">{children}</div>
    </div>
  );
};

// ==========================================
// BORDER GLOW UTILITIES & COMPONENT
// ==========================================

function parseHSL(hslStr) {
  const match = hslStr.match(/([\d.]+)\s*([\d.]+)%?\s*([\d.]+)%?/);
  if (!match) return { h: 0, s: 0, l: 100 }; // Default to white
  return { h: parseFloat(match[1]), s: parseFloat(match[2]), l: parseFloat(match[3]) };
}

function buildBoxShadow(glowColor, intensity) {
  const { h, s, l } = parseHSL(glowColor);
  const base = `${h}deg ${s}% ${l}%`;
  const layers = [
    [0, 0, 0, 1, 100, true], [0, 0, 1, 0, 60, true], [0, 0, 3, 0, 50, true],
    [0, 0, 6, 0, 40, true], [0, 0, 15, 0, 30, true], [0, 0, 25, 2, 20, true],
    [0, 0, 50, 2, 10, true],
    [0, 0, 1, 0, 60, false], [0, 0, 3, 0, 50, false], [0, 0, 6, 0, 40, false],
    [0, 0, 15, 0, 30, false], [0, 0, 25, 2, 20, false], [0, 0, 50, 2, 10, false],
  ];
  return layers.map(([x, y, blur, spread, alpha, inset]) => {
    const a = Math.min(alpha * intensity, 100);
    return `${inset ? 'inset ' : ''}${x}px ${y}px ${blur}px ${spread}px hsl(${base} / ${a}%)`;
  }).join(', ');
}

function easeOutCubic(x) { return 1 - Math.pow(1 - x, 3); }
function easeInCubic(x) { return x * x * x; }

function animateValue({ start = 0, end = 100, duration = 1000, delay = 0, ease = easeOutCubic, onUpdate, onEnd }) {
  const t0 = performance.now() + delay;
  function tick() {
    const elapsed = performance.now() - t0;
    const t = Math.min(elapsed / duration, 1);
    onUpdate(start + (end - start) * ease(t));
    if (t < 1) requestAnimationFrame(tick);
    else if (onEnd) onEnd();
  }
  setTimeout(() => requestAnimationFrame(tick), delay);
}

const GRADIENT_POSITIONS = ['80% 55%', '69% 34%', '8% 6%', '41% 38%', '86% 85%', '82% 18%', '51% 4%'];
const COLOR_MAP = [0, 1, 2, 0, 1, 2, 1];

function buildMeshGradients(colors) {
  const gradients = [];
  for (let i = 0; i < 7; i++) {
    const c = colors[Math.min(COLOR_MAP[i], colors.length - 1)];
    gradients.push(`radial-gradient(at ${GRADIENT_POSITIONS[i]}, ${c} 0px, transparent 50%)`);
  }
  gradients.push(`linear-gradient(${colors[0]} 0 100%)`);
  return gradients;
}

const BorderGlow = ({
  children,
  className = '',
  edgeSensitivity = 30,
  glowColor = '0 0 100', // Pure White
  backgroundColor = '#050505',
  borderRadius = 12,
  glowRadius = 30,
  glowIntensity = 0.5,
  coneSpread = 25,
  animated = false,
  colors = ['#ffffff', '#71717a', '#000000'], // White to Black gradients
  fillOpacity = 0.3,
}) => {
  const cardRef = useRef(null);
  const [isHovered, setIsHovered] = useState(false);
  const [cursorAngle, setCursorAngle] = useState(45);
  const [edgeProximity, setEdgeProximity] = useState(0);
  const [sweepActive, setSweepActive] = useState(false);

  const getCenterOfElement = useCallback((el) => {
    const { width, height } = el.getBoundingClientRect();
    return [width / 2, height / 2];
  }, []);

  const getEdgeProximity = useCallback((el, x, y) => {
    const [cx, cy] = getCenterOfElement(el);
    const dx = x - cx;
    const dy = y - cy;
    let kx = Infinity;
    let ky = Infinity;
    if (dx !== 0) kx = cx / Math.abs(dx);
    if (dy !== 0) ky = cy / Math.abs(dy);
    return Math.min(Math.max(1 / Math.min(kx, ky), 0), 1);
  }, [getCenterOfElement]);

  const getCursorAngle = useCallback((el, x, y) => {
    const [cx, cy] = getCenterOfElement(el);
    const dx = x - cx;
    const dy = y - cy;
    if (dx === 0 && dy === 0) return 0;
    const radians = Math.atan2(dy, dx);
    let degrees = radians * (180 / Math.PI) + 90;
    if (degrees < 0) degrees += 360;
    return degrees;
  }, [getCenterOfElement]);

  const handlePointerMove = useCallback((e) => {
    const card = cardRef.current;
    if (!card) return;
    const rect = card.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    setEdgeProximity(getEdgeProximity(card, x, y));
    setCursorAngle(getCursorAngle(card, x, y));
  }, [getEdgeProximity, getCursorAngle]);

  useEffect(() => {
    if (!animated) return;
    const angleStart = 110;
    const angleEnd = 465;
    setSweepActive(true);
    setCursorAngle(angleStart);

    animateValue({ duration: 500, onUpdate: v => setEdgeProximity(v / 100) });
    animateValue({ ease: easeInCubic, duration: 1500, end: 50, onUpdate: v => {
      setCursorAngle((angleEnd - angleStart) * (v / 100) + angleStart);
    }});
    animateValue({ ease: easeOutCubic, delay: 1500, duration: 2250, start: 50, end: 100, onUpdate: v => {
      setCursorAngle((angleEnd - angleStart) * (v / 100) + angleStart);
    }});
    animateValue({ ease: easeInCubic, delay: 2500, duration: 1500, start: 100, end: 0,
      onUpdate: v => setEdgeProximity(v / 100),
      onEnd: () => setSweepActive(false),
    });
  }, [animated]);

  const colorSensitivity = edgeSensitivity + 20;
  const isVisible = isHovered || sweepActive;
  const borderOpacity = isVisible
    ? Math.max(0, (edgeProximity * 100 - colorSensitivity) / (100 - colorSensitivity))
    : 0;
  const glowOpacity = isVisible
    ? Math.max(0, (edgeProximity * 100 - edgeSensitivity) / (100 - edgeSensitivity))
    : 0;

  const meshGradients = buildMeshGradients(colors);
  const borderBg = meshGradients.map(g => `${g} border-box`);
  const fillBg = meshGradients.map(g => `${g} padding-box`);
  const angleDeg = `${cursorAngle.toFixed(3)}deg`;

  return (
    <div
      ref={cardRef}
      onPointerMove={handlePointerMove}
      onPointerEnter={() => setIsHovered(true)}
      onPointerLeave={() => setIsHovered(false)}
      className={`relative grid isolate ${className}`}
      style={{
        background: backgroundColor,
        borderRadius: `${borderRadius}px`,
        transform: 'translate3d(0, 0, 0.01px)',
        boxShadow: 'rgba(0,0,0,0.4) 0 4px 20px',
      }}
    >
      <div
        className="absolute inset-0 rounded-[inherit] -z-1"
        style={{
          border: '1px solid transparent',
          background: [
            `linear-gradient(${backgroundColor} 0 100%) padding-box`,
            'linear-gradient(rgb(255 255 255 / 0%) 0% 100%) border-box',
            ...borderBg,
          ].join(', '),
          opacity: borderOpacity,
          maskImage: `conic-gradient(from ${angleDeg} at center, black ${coneSpread}%, transparent ${coneSpread + 15}%, transparent ${100 - coneSpread - 15}%, black ${100 - coneSpread}%)`,
          WebkitMaskImage: `conic-gradient(from ${angleDeg} at center, black ${coneSpread}%, transparent ${coneSpread + 15}%, transparent ${100 - coneSpread - 15}%, black ${100 - coneSpread}%)`,
          transition: isVisible ? 'opacity 0.25s ease-out' : 'opacity 0.75s ease-in-out',
        }}
      />
      <div
        className="absolute inset-0 rounded-[inherit] -z-1"
        style={{
          border: '1px solid transparent',
          background: fillBg.join(', '),
          maskImage: [
            'linear-gradient(to bottom, black, black)',
            'radial-gradient(ellipse at 50% 50%, black 40%, transparent 65%)',
            'radial-gradient(ellipse at 66% 66%, black 5%, transparent 40%)',
            'radial-gradient(ellipse at 33% 33%, black 5%, transparent 40%)',
            'radial-gradient(ellipse at 66% 33%, black 5%, transparent 40%)',
            'radial-gradient(ellipse at 33% 66%, black 5%, transparent 40%)',
            `conic-gradient(from ${angleDeg} at center, transparent 5%, black 15%, black 85%, transparent 95%)`,
          ].join(', '),
          WebkitMaskImage: [
            'linear-gradient(to bottom, black, black)',
            'radial-gradient(ellipse at 50% 50%, black 40%, transparent 65%)',
            'radial-gradient(ellipse at 66% 66%, black 5%, transparent 40%)',
            'radial-gradient(ellipse at 33% 33%, black 5%, transparent 40%)',
            'radial-gradient(ellipse at 66% 33%, black 5%, transparent 40%)',
            'radial-gradient(ellipse at 33% 66%, black 5%, transparent 40%)',
            `conic-gradient(from ${angleDeg} at center, transparent 5%, black 15%, black 85%, transparent 95%)`,
          ].join(', '),
          maskComposite: 'subtract, add, add, add, add, add',
          WebkitMaskComposite: 'source-out, source-over, source-over, source-over, source-over, source-over',
          opacity: borderOpacity * fillOpacity,
          mixBlendMode: 'soft-light',
          transition: isVisible ? 'opacity 0.25s ease-out' : 'opacity 0.75s ease-in-out',
        }}
      />
      <span
        className="absolute pointer-events-none z-1 rounded-[inherit]"
        style={{
          inset: `${-glowRadius}px`,
          maskImage: `conic-gradient(from ${angleDeg} at center, black 2.5%, transparent 10%, transparent 90%, black 97.5%)`,
          WebkitMaskImage: `conic-gradient(from ${angleDeg} at center, black 2.5%, transparent 10%, transparent 90%, black 97.5%)`,
          opacity: glowOpacity,
          mixBlendMode: 'plus-lighter',
          transition: isVisible ? 'opacity 0.25s ease-out' : 'opacity 0.75s ease-in-out',
        }}
      >
        <span
          className="absolute rounded-[inherit]"
          style={{
            inset: `${glowRadius}px`,
            boxShadow: buildBoxShadow(glowColor, glowIntensity),
          }}
        />
      </span>

      <div className="flex flex-col relative h-full w-full z-1">
        {children}
      </div>
    </div>
  );
};

// ==========================================
// TYPOGRAPHY & HELPERS
// ==========================================

const PAGE_TITLES = {
  'overview': 'Platform Overview',
  'quickstart': 'Quick Start',
  'architecture': 'System Architecture',
  'stage-model': 'Stage Model',
  'agents': 'Agent Architecture',
  'api': 'API Reference',
  'contracts': 'Architecture Contracts',
  'configuration': 'Configuration',
  'runbook': 'Operational Runbook',
  'troubleshooting': 'Troubleshooting'
};

const CodeBlockWithCopy = ({ lang, rawText }) => {
  const [copied, setCopied] = useState(false);
  
  const handleCopy = () => {
    navigator.clipboard.writeText(rawText).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  
  return (
    <div className="bg-[#050505] border border-[#262626] rounded-lg my-4 overflow-hidden">
      <div className="px-4 py-2 border-b border-[#1A1A1A] bg-[#0A0A0A] flex justify-between items-center">
        <span className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest">{lang}</span>
        <button 
          onClick={handleCopy} 
          className="text-[10px] font-bold text-zinc-400 hover:text-white transition-colors bg-[#111111] px-2 py-1 rounded border border-[#262626]"
        >
          {copied ? 'COPIED!' : 'COPY'}
        </button>
      </div>
      <div className="p-4 overflow-x-auto custom-scrollbar">
        <pre className="text-[13px] font-mono text-zinc-300 leading-relaxed"><code>{rawText}</code></pre>
      </div>
    </div>
  );
};

const H1 = ({ children }) => <h1 className="text-3xl font-bold text-white mb-6 tracking-tight">{children}</h1>;
const H2 = ({ children, icon: Icon }) => (
  <h2 className="text-lg font-bold text-white mt-12 mb-6 pb-3 border-b border-[#1A1A1A] flex items-center gap-2">
    {Icon && <Icon className="w-5 h-5 text-zinc-500" />}
    {children}
  </h2>
);
const H3 = ({ children }) => <h3 className="text-[11px] font-bold text-zinc-500 uppercase tracking-widest mb-4">{children}</h3>;
const P = ({ children }) => <p className="text-sm text-zinc-400 leading-relaxed mb-4">{children}</p>;
const InlineCode = ({ children }) => <code className="bg-[#111111] border border-[#262626] px-1.5 py-0.5 rounded text-[13px] text-zinc-200 font-mono">{children}</code>;

const MethodBadge = ({ method }) => {
  let style = "bg-[#111111] text-zinc-300 border border-[#262626]"; 
  if (method === 'GET') style = "bg-white text-black";
  if (method === 'POST') style = "bg-zinc-800 text-white";
  
  return <span className={`inline-block px-2 py-1 rounded text-[10px] font-bold mr-3 min-w-12.5 text-center ${style}`}>{method}</span>;
};

// Architecture Nodes for the flowchart
const ArchNode = ({ title, subtitle, icon: Icon, highlight, highlightColor = 'indigo' }) => {
  const isEmerald = highlightColor === 'emerald';
  const isBlue = highlightColor === 'blue';
  const isIndigo = highlightColor === 'indigo';
  
  const bg = highlight 
    ? (isIndigo ? 'bg-indigo-500/10' : isEmerald ? 'bg-emerald-500/10' : 'bg-blue-500/10')
    : 'bg-[#111111]';
    
  const border = highlight
    ? (isIndigo ? 'border-indigo-500/30' : isEmerald ? 'border-emerald-500/30' : 'border-blue-500/30')
    : 'border-[#262626]';
    
  const titleCol = highlight
    ? (isIndigo ? 'text-indigo-300' : isEmerald ? 'text-emerald-300' : 'text-blue-300')
    : 'text-zinc-200';
    
  const iconCol = highlight
    ? (isIndigo ? 'text-indigo-400' : isEmerald ? 'text-emerald-400' : 'text-blue-400')
    : 'text-zinc-400';

  return (
    <div className={`p-3 rounded-md flex items-center gap-3 border ${bg} ${border} shadow-sm transition-colors hover:border-zinc-500`}>
      {Icon && <Icon className={`w-4 h-4 shrink-0 ${iconCol}`} />}
      <div className="flex flex-col">
        <span className={`text-xs font-semibold ${titleCol}`}>{title}</span>
        {subtitle && <span className="text-[10px] font-mono text-zinc-500 mt-0.5">{subtitle}</span>}
      </div>
    </div>
  );
};

const DownArrow = () => (
  <div className="flex justify-center py-1.5">
    <ArrowDown className="w-4 h-4 text-zinc-600" />
  </div>
);

// ==========================================
// MAIN APP COMPONENT
// ==========================================

export default function DocumentationPortal() {
  const router = useRouter();
  const [activePage, setActivePage] = useState('architecture'); // Set default to architecture to show the new flow
  const mainScrollRef = useRef(null);

  useEffect(() => {
    if (mainScrollRef.current) {
      mainScrollRef.current.scrollTop = 0;
    }
  }, [activePage]);

  const navigate = (e, pageId) => {
    e.preventDefault();
    setActivePage(pageId);
  };

  const navItems = [
    { id: 'overview', label: 'Platform Overview', icon: Book },
    { id: 'quickstart', label: 'Quick Start', icon: Play },
    { id: 'architecture', label: 'System Architecture', icon: LayoutGrid },
    { id: 'stage-model', label: 'Stage Model', icon: Layers },
    { id: 'agents', label: 'Agent Architecture', icon: Cpu },
    { id: 'api', label: 'API Reference', icon: Code },
    { id: 'contracts', label: 'Architecture Contracts', icon: FileJson },
    { id: 'configuration', label: 'Configuration', icon: Settings },
    { id: 'runbook', label: 'Operational Runbook', icon: TerminalSquare },
    { id: 'troubleshooting', label: 'Troubleshooting', icon: ShieldAlert }
  ];

  return (
    <div className="flex h-screen bg-[#000000] text-zinc-300 font-sans selection:bg-white selection:text-black overflow-hidden">
      <style dangerouslySetInnerHTML={{ __html: `
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');
        
        .custom-scrollbar::-webkit-scrollbar { width: 6px; }
        .custom-scrollbar::-webkit-scrollbar-track { background: transparent; }
        .custom-scrollbar::-webkit-scrollbar-thumb { background-color: #262626; border-radius: 10px; }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover { background-color: #3f3f46; }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
        .animate-fade-in { animation: fadeIn 0.3s ease-out forwards; }
      `}} />

      {/* --- SIDEBAR --- */}
      <aside className="w-72 border-r border-[#1A1A1A] bg-[#050505] flex flex-col shrink-0 z-20">
        <div className="h-16 flex items-center px-6 border-b border-[#1A1A1A] shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-7 h-7 rounded border border-[#333333] bg-[#0A0A0A] flex items-center justify-center">
              <Book className="w-4 h-4 text-white" />
            </div>
            <div className="text-white font-bold tracking-wide text-sm">
              <button
                type="button"
                onClick={() => router.push('/dashboard')}
                className="hover:text-zinc-300 transition-colors"
              >
                DEPL_AI
              </button>
              <span className="text-zinc-600 font-normal mx-1">/</span>
              <span>DOCS</span>
            </div>
          </div>
        </div>

        <div className="p-5 border-b border-[#1A1A1A] shrink-0">
          <div className="relative">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" />
            <input 
              type="text" 
              placeholder="Search docs..." 
              className="w-full pl-9 pr-4 py-2 bg-[#0A0A0A] border border-[#262626] rounded-md text-[13px] focus:outline-none focus:border-white text-white placeholder:text-zinc-600 transition-colors"
            />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto custom-scrollbar p-4 space-y-1">
          <div className="text-[10px] font-bold text-zinc-600 uppercase tracking-widest mb-3 px-2 pt-2">Documentation</div>
          {navItems.map((item) => {
            const Icon = item.icon;
            const isActive = activePage === item.id;
            return (
              <button 
                key={item.id}
                onClick={(e) => navigate(e, item.id)}
                className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg transition-all text-[13px] font-medium ${
                  isActive 
                    ? 'bg-[#111111] text-white border border-[#262626]' 
                    : 'hover:bg-[#0A0A0A] text-zinc-400 hover:text-zinc-200 border border-transparent'
                }`}
              >
                <Icon className="w-4 h-4 shrink-0" />
                {item.label}
                {isActive && <ChevronRight className="w-4 h-4 ml-auto text-zinc-600" />}
              </button>
            )
          })}
        </div>
      </aside>

      {/* --- MAIN CONTENT --- */}
      <div className="flex-1 flex flex-col overflow-hidden bg-transparent">
        <header className="h-16 flex items-center justify-between px-8 border-b border-[#1A1A1A] bg-[#050505]/90 backdrop-blur-md z-10 shrink-0">
          <div className="flex items-center gap-2 text-[13px] text-zinc-500">
            <button
              type="button"
              onClick={() => router.push('/dashboard')}
              className="hover:text-zinc-300 cursor-pointer transition-colors"
            >
              DeplAI
            </button>
            <span className="text-zinc-700">/</span>
            <span className="text-white font-medium">{PAGE_TITLES[activePage]}</span>
          </div>
          <button
            onClick={() => router.push('/dashboard')}
            className="flex items-center gap-2 text-xs font-medium text-zinc-400 hover:text-white transition-colors"
          >
            <ArrowLeft className="w-4 h-4" /> Back to Dashboard
          </button>
        </header>

        <main className="flex-1 overflow-y-auto custom-scrollbar bg-[#000000]" ref={mainScrollRef}>
          <div className="max-w-5xl mx-auto px-10 py-12 pb-32 animate-fade-in">
            
            {/* OVERVIEW SECTION */}
            {activePage === 'overview' && (
              <div className="animate-fade-in">
                <H1>Platform Overview</H1>
                <P>
                  DeplAI is an agentic DevSecOps platform that takes a GitHub repository or local upload, runs security analysis, drives a human-reviewed remediation loop, generates architecture and cost outputs, produces infrastructure artifacts, enforces delivery policy, and then deploys through either GitOps or direct runtime apply.
                </P>

                <div className="flex gap-4 p-4 border border-[#262626] bg-[#0A0A0A] rounded-lg items-start my-6">
                  <div className="bg-[#111111] p-2 rounded-md border border-[#262626]"><Info className="w-4 h-4 text-white" /></div>
                  <div>
                    <strong className="block text-white mb-1">Active Runtime</strong>
                    <span className="text-sm text-zinc-400">The live stack is: <InlineCode>Connector</InlineCode> (Next.js 16 BFF), <InlineCode>Agentic Layer</InlineCode> (FastAPI), <InlineCode>KGagent</InlineCode> (in-process), and the <InlineCode>Stage 7 subprocess</InlineCode> for diagram and cost generation.</span>
                  </div>
                </div>

                <H2 icon={Activity}>What DeplAI Does</H2>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 my-6">
                  {[
                    { t: "Scan & Analyze", d: "SAST via Bearer, SCA via Syft and Grype — enriched with graph-backed CVE/CWE intelligence.", i: Search },
                    { t: "Supervised Remediation", d: "Claude-powered proposer/critic loop with root-cause deduplication and approval gates.", i: Box },
                    { t: "Architecture & Cost", d: "AWS architecture JSON generation, cost estimation, and Mermaid diagram packaging.", i: Network },
                    { t: "IaC & Deploy", d: "Terraform bundle generation, policy and budget gating, and AWS runtime apply.", i: Play },
                    { t: "Stage Gates", d: "Every high-risk transition requires explicit human approval.", i: Shield },
                    { t: "Live Telemetry", d: "WebSocket-backed pipeline dashboard with HMAC tokens for scoped sessions.", i: Globe }
                  ].map((s, i) => (
                    <BorderGlow key={i} borderRadius={8} className="border border-[#1A1A1A]">
                      <PixelCard gap={6} speed={25} className="p-5 rounded-[inherit] h-full">
                        <div className="w-8 h-8 rounded bg-[#111111] border border-[#262626] flex items-center justify-center mb-4"><s.i className="w-4 h-4 text-white" /></div>
                        <h4 className="text-sm font-bold text-white mb-2">{s.t}</h4>
                        <p className="text-xs text-zinc-500 leading-relaxed">{s.d}</p>
                      </PixelCard>
                    </BorderGlow>
                  ))}
                </div>

                <H2 icon={Layers}>Component Overview</H2>
                <BorderGlow borderRadius={12} className="border border-[#1A1A1A] overflow-hidden my-6">
                  <div className="bg-[#050505] rounded-[inherit]">
                    <table className="w-full text-left border-collapse text-sm">
                      <thead>
                        <tr className="bg-[#0A0A0A] border-b border-[#1A1A1A]">
                          <th className="p-4 text-[10px] font-bold text-zinc-500 uppercase tracking-widest">Component</th>
                          <th className="p-4 text-[10px] font-bold text-zinc-500 uppercase tracking-widest">Runtime</th>
                          <th className="p-4 text-[10px] font-bold text-zinc-500 uppercase tracking-widest hidden md:table-cell">Role</th>
                          <th className="p-4 text-[10px] font-bold text-zinc-500 uppercase tracking-widest">Status</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-[#1A1A1A]">
                        <tr className="hover:bg-[#111111] transition-colors">
                          <td className="p-4 font-mono text-[13px] text-zinc-300">Connector</td><td className="p-4 text-zinc-400 text-xs">Next.js 16</td><td className="p-4 text-zinc-400 text-xs hidden md:table-cell">Control plane, BFF, auth</td>
                          <td className="p-4"><span className="px-2 py-0.5 rounded text-[10px] font-bold uppercase bg-white text-black">Active</span></td>
                        </tr>
                        <tr className="hover:bg-[#111111] transition-colors">
                          <td className="p-4 font-mono text-[13px] text-zinc-300">Agentic Layer</td><td className="p-4 text-zinc-400 text-xs">FastAPI</td><td className="p-4 text-zinc-400 text-xs hidden md:table-cell">Orchestration, scan, deploy</td>
                          <td className="p-4"><span className="px-2 py-0.5 rounded text-[10px] font-bold uppercase bg-white text-black">Active</span></td>
                        </tr>
                        <tr className="hover:bg-[#111111] transition-colors">
                          <td className="p-4 font-mono text-[13px] text-zinc-300">KGagent</td><td className="p-4 text-zinc-400 text-xs">In-process</td><td className="p-4 text-zinc-400 text-xs hidden md:table-cell">Security intelligence</td>
                          <td className="p-4"><span className="px-2 py-0.5 rounded text-[10px] font-bold uppercase bg-zinc-800 text-zinc-300">Graceful degrade</span></td>
                        </tr>
                        <tr className="hover:bg-[#111111] transition-colors">
                          <td className="p-4 font-mono text-[13px] text-zinc-300">diagram_cost...</td><td className="p-4 text-zinc-400 text-xs">Subprocess</td><td className="p-4 text-zinc-400 text-xs hidden md:table-cell">Stage 7 packaging</td>
                          <td className="p-4"><span className="px-2 py-0.5 rounded text-[10px] font-bold uppercase bg-white text-black">Active</span></td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                </BorderGlow>
              </div>
            )}

            {/* QUICKSTART SECTION */}
            {activePage === 'quickstart' && (
              <div className="animate-fade-in">
                <H1>Quick Start</H1>
                <P>Get the full DeplAI stack running locally in under 10 minutes.</P>

                <H2 icon={CheckCircle2}>Prerequisites</H2>
                <div className="bg-[#050505] border border-[#1A1A1A] rounded-lg p-6 my-6">
                  <ul className="space-y-4 text-sm text-zinc-300">
                    <li className="flex items-start gap-3"><CheckCircle2 className="w-5 h-5 text-zinc-500 shrink-0" /><span><strong>Node.js 20+</strong> — required for Connector frontend</span></li>
                    <li className="flex items-start gap-3"><CheckCircle2 className="w-5 h-5 text-zinc-500 shrink-0" /><span><strong>Python 3.13+</strong> — required for Agentic Layer, KGagent, agents</span></li>
                    <li className="flex items-start gap-3"><CheckCircle2 className="w-5 h-5 text-zinc-500 shrink-0" /><span><strong>Docker Desktop / Engine</strong> — scan execution and agentic-layer container</span></li>
                    <li className="flex items-start gap-3"><CheckCircle2 className="w-5 h-5 text-zinc-500 shrink-0" /><span><strong>MySQL 8+</strong> — application metadata persistence</span></li>
                    <li className="flex items-start gap-3"><CheckCircle2 className="w-5 h-5 text-zinc-500 shrink-0" /><span><strong>GitHub OAuth + App</strong> — for repository-backed flows</span></li>
                  </ul>
                </div>

                <H2 icon={Play}>Startup Sequence</H2>
                <H3>1 — Initialize the database</H3>
                <CodeBlockWithCopy lang="BASH" rawText="mysql -u root -p < Connector/database.sql" />
                
                <H3>2 — Install frontend dependencies</H3>
                <CodeBlockWithCopy lang="BASH" rawText="cd Connector && npm install" />
                
                <H3>3 — Start Agentic Layer</H3>
                <CodeBlockWithCopy lang="BASH" rawText="docker compose up -d --build agentic-layer" />
                
                <H3>4 — Start Connector</H3>
                <CodeBlockWithCopy lang="BASH" rawText="cd Connector && npm run dev" />
                
                <H3>5 — Verify Health</H3>
                <CodeBlockWithCopy lang="BASH" rawText={`curl http://localhost:8000/health\ncurl http://localhost:3000/api/pipeline/health`} />

                <div className="flex gap-3 p-4 border border-[#262626] bg-[#0A0A0A] rounded-lg items-start my-6">
                  <div className="bg-[#111111] p-2 rounded-md border border-[#262626]"><AlertCircle className="w-4 h-4 text-white" /></div>
                  <div>
                    <strong className="block text-white mb-1">Compose scope</strong>
                    <span className="text-sm text-zinc-400"><InlineCode>docker-compose.yml</InlineCode> only starts <InlineCode>agentic-layer</InlineCode>. MySQL, Neo4j, and Qdrant must be started separately.</span>
                  </div>
                </div>
              </div>
            )}

            {/* ARCHITECTURE SECTION */}
            {activePage === 'architecture' && (
              <div className="animate-fade-in">
                <H1>System Architecture</H1>
                <P>DeplAI is structured as a two-tier runtime: a Next.js control plane (Connector) fronts a FastAPI orchestration service (Agentic Layer), with Docker, KG services, and AWS as backend runtimes.</P>

                <H2 icon={Network}>System Architecture Flow</H2>
                
                <BorderGlow borderRadius={12} className="border border-[#1A1A1A] my-6">
                  <PixelCard gap={8} speed={30} colors="#3f3f46,#27272a,#18181b" className="p-8 rounded-[inherit]">
                    <div className="overflow-x-auto pb-6 custom-scrollbar">
                      <div className="min-w-275 flex flex-col gap-8 relative z-10">

                        {/* Tier 1: User & Connector */}
                        <div className="flex items-center gap-4 bg-[#000000]/50 p-4 rounded-xl border border-[#262626]">
                          <ArchNode title="User Browser" icon={User} />
                          <ArrowRight className="w-4 h-4 text-zinc-600" />
                          <ArchNode title="Connector UI & BFF" subtitle="Next.js" icon={LayoutGrid} highlight highlightColor="indigo" />
                          <ArrowRight className="w-4 h-4 text-zinc-600" />
                          <div className="text-xs text-zinc-500 italic">Initiates Pipeline</div>
                        </div>

                        {/* Tier 2: The Main Pipeline */}
                        <div className="flex items-stretch gap-3">
                          {/* Security & Analysis */}
                          <div className="flex-1 border border-[#262626] bg-[#000000]/50 rounded-xl p-4 flex flex-col shadow-lg">
                            <div className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest mb-4 flex items-center gap-2"><ShieldAlert className="w-3 h-3"/> Security & Analysis</div>
                            <ArchNode title="Stage 1 Security Scan" subtitle="Bearer + Syft + Grype" />
                            <DownArrow />
                            <ArchNode title="Stage 2 KG Analysis" subtitle="KGagent" />
                            <DownArrow />
                            <ArchNode title="Stage 3 Remediation" subtitle="Claude-only Supervisor" />
                          </div>

                          <div className="flex items-center justify-center px-1"><ArrowRight className="w-5 h-5 text-zinc-600" /></div>

                          {/* Persistence & Validation */}
                          <div className="flex-1 border border-[#262626] bg-[#000000]/50 rounded-xl p-4 flex flex-col shadow-lg">
                            <div className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest mb-4 flex items-center gap-2"><GitPullRequest className="w-3 h-3"/> Persistence & Validation</div>
                            <ArchNode title="Stage 4 PR / Local Persist" />
                            <DownArrow />
                            <ArchNode title="Stage 4.5 Merge Gate" />
                            <DownArrow />
                            <ArchNode title="Stage 4.6 Post-Merge Re-scan" />
                          </div>

                          <div className="flex items-center justify-center px-1"><ArrowRight className="w-5 h-5 text-zinc-600" /></div>

                          {/* Infrastructure & Costing */}
                          <div className="flex-1 border border-[#262626] bg-[#000000]/50 rounded-xl p-4 flex flex-col shadow-lg">
                            <div className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest mb-4 flex items-center gap-2"><Cpu className="w-3 h-3"/> Infrastructure & Costing</div>
                            <ArchNode title="Stage 6 Q & A Context" />
                            <DownArrow />
                            <ArchNode title="Stage 7 Arch & Cost Agent" subtitle="AWS only" />
                            <DownArrow />
                            <ArchNode title="Stage 7.5 Approval Gate" />
                          </div>

                          <div className="flex items-center justify-center px-1"><ArrowRight className="w-5 h-5 text-zinc-600" /></div>

                          {/* Deployment */}
                          <div className="flex-1 border border-[#262626] bg-[#000000]/50 rounded-xl p-4 flex flex-col shadow-lg">
                            <div className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest mb-4 flex items-center gap-2"><Rocket className="w-3 h-3"/> Deployment</div>
                            <ArchNode title="Stage 8 terraform_agent" />
                            <DownArrow />
                            <ArchNode title="Stage 9 Policy & Budget Gate" />
                            <DownArrow />
                            <ArchNode title="Stage 10 Deployment" />
                          </div>

                          <div className="flex items-center justify-center px-1"><ArrowRight className="w-5 h-5 text-zinc-600" /></div>

                          {/* Delivery Targets */}
                          <div className="flex-1 border border-emerald-500/20 bg-emerald-500/10 rounded-xl p-4 flex flex-col justify-center gap-3 shadow-lg">
                            <div className="text-[10px] font-bold text-emerald-500 uppercase tracking-widest mb-2 flex items-center gap-2"><Cloud className="w-3 h-3"/> Delivery Targets</div>
                            <ArchNode title="AWS Runtime Apply" highlight highlightColor="emerald" />
                            <ArchNode title="GitOps Repository Push" highlight highlightColor="emerald" />
                          </div>
                        </div>

                        {/* Tier 3: Supporting Services */}
                        <div className="grid grid-cols-3 gap-6">
                          {/* Backend Services */}
                          <div className="col-span-2 border border-[#262626] bg-[#000000]/50 rounded-xl p-5 shadow-lg">
                            <div className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest mb-4 flex items-center gap-2"><Server className="w-4 h-4"/> Backend Services</div>
                            <div className="flex items-center gap-6">
                               <div className="w-1/3 flex flex-col gap-2">
                                 <div className="text-[10px] font-bold text-zinc-600 text-center uppercase">From Connector</div>
                                 <div className="flex justify-center"><ArrowDown className="w-4 h-4 text-zinc-600" /></div>
                                 <ArchNode title="Agentic Layer" subtitle="FastAPI Orchestrator" icon={TerminalSquare} highlight highlightColor="indigo" />
                               </div>
                               <div className="flex flex-col items-center justify-center">
                                  <ArrowRight className="w-5 h-5 text-zinc-600" />
                               </div>
                               <div className="flex-1 grid grid-cols-2 gap-3">
                                 <ArchNode title="Docker Volumes & Runners" />
                                 <ArchNode title="diagram_cost-estimation_agent" />
                                 <ArchNode title="Terraform" />
                                 <ArchNode title="AWS APIs" />
                               </div>
                            </div>
                          </div>

                          {/* Data Layer */}
                          <div className="border border-[#262626] bg-[#000000]/50 rounded-xl p-5 shadow-lg">
                            <div className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest mb-4 flex items-center gap-2"><Database className="w-4 h-4"/> Data Layer</div>
                            <div className="flex flex-col gap-3">
                               <div className="text-[10px] font-bold text-zinc-600 uppercase flex items-center gap-2 mb-1">From KGagent <ArrowRight className="w-3 h-3"/></div>
                               <ArchNode title="Neo4j" icon={Database} highlight highlightColor="blue" />
                               <ArchNode title="Qdrant" icon={Database} highlight highlightColor="blue" />
                            </div>
                          </div>
                        </div>

                      </div>
                    </div>
                  </PixelCard>
                </BorderGlow>

                <H2 icon={ShieldAlert}>Trust Boundaries</H2>
                <div className="bg-[#050505] border border-[#1A1A1A] rounded-lg overflow-hidden my-6">
                  <table className="w-full text-left border-collapse text-sm">
                    <thead>
                      <tr className="bg-[#0A0A0A] border-b border-[#1A1A1A]">
                        <th className="p-4 text-[10px] font-bold text-zinc-500 uppercase tracking-widest">Boundary</th>
                        <th className="p-4 text-[10px] font-bold text-zinc-500 uppercase tracking-widest">Mechanism</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[#1A1A1A]">
                      <tr className="hover:bg-[#111111] transition-colors"><td className="p-4 text-zinc-300">Browser → Connector</td><td className="p-4 text-zinc-400 font-mono text-xs">iron-session cookie</td></tr>
                      <tr className="hover:bg-[#111111] transition-colors"><td className="p-4 text-zinc-300">Connector → Agentic Layer</td><td className="p-4 text-zinc-400 font-mono text-xs">DEPLAI_SERVICE_KEY (X-API-Key)</td></tr>
                      <tr className="hover:bg-[#111111] transition-colors"><td className="p-4 text-zinc-300">Connector → Agentic WS</td><td className="p-4 text-zinc-400 font-mono text-xs">HMAC token via WS_TOKEN_SECRET</td></tr>
                      <tr className="hover:bg-[#111111] transition-colors"><td className="p-4 text-zinc-300">Agentic Layer → AWS</td><td className="p-4 text-zinc-400 font-mono text-xs">AWS SDK credentials</td></tr>
                    </tbody>
                  </table>
                </div>

                <H2 icon={HardDrive}>Execution Artifacts</H2>
                <P>All scan and remediation I/O flows through Docker volumes managed by the Agentic Layer:</P>
                <div className="bg-[#050505] border border-[#1A1A1A] rounded-lg overflow-hidden my-6">
                  <table className="w-full text-left border-collapse text-sm">
                    <thead>
                      <tr className="bg-[#0A0A0A] border-b border-[#1A1A1A]">
                        <th className="p-4 text-[10px] font-bold text-zinc-500 uppercase tracking-widest">Volume</th>
                        <th className="p-4 text-[10px] font-bold text-zinc-500 uppercase tracking-widest">Contents</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[#1A1A1A]">
                      <tr className="hover:bg-[#111111] transition-colors"><td className="p-4 font-mono text-xs text-white">codebase_deplai</td><td className="p-4 text-zinc-400 text-sm">Checked-out repository code for scan execution</td></tr>
                      <tr className="hover:bg-[#111111] transition-colors"><td className="p-4 font-mono text-xs text-white">security_reports</td><td className="p-4 text-zinc-400 text-sm">Raw and parsed scan output from Bearer, Syft, Grype</td></tr>
                      <tr className="hover:bg-[#111111] transition-colors"><td className="p-4 font-mono text-xs text-white">LLM_Output</td><td className="p-4 text-zinc-400 text-sm">Remediation patches, summaries, and synthesized changes</td></tr>
                      <tr className="hover:bg-[#111111] transition-colors"><td className="p-4 font-mono text-xs text-white">grype_db_cache</td><td className="p-4 text-zinc-400 text-sm">Cached Grype vulnerability database</td></tr>
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* STAGE MODEL SECTION */}
            {activePage === 'stage-model' && (
              <div className="animate-fade-in">
                <H1>Stage Model</H1>
                <P>DeplAI orchestrates delivery through 13 discrete stages. Each stage is gated — transition only occurs on explicit success or human approval.</P>

                <H2 icon={Layers}>Canonical Stage Order</H2>
                <div className="space-y-2 my-6">
                  {[
                    { n: "0", t: "Preflight", d: "Validate scan prerequisites, environment checks, project setup" },
                    { n: "1", t: "Scan", d: "SAST (Bearer) + SCA (Syft, Grype) — streamed progress via WebSocket" },
                    { n: "2", t: "KG Analysis", d: "KGagent queries Neo4j + Qdrant; builds CVE/CWE context for remediation" },
                    { n: "3", t: "Remediation", d: "Claude proposer/critic loop — root-cause deduped, budget-capped, repo-wide" },
                    { n: "4", t: "Remediation PR", d: "Push branch + open PR (GitHub) or copy to local-projects path" },
                    { n: "4.5", t: "Merge Gate", d: "Human approval required before post-merge actions proceed" },
                    { n: "4.6", t: "Post-Merge", d: "Verification re-scan on merged codebase" },
                    { n: "6", t: "Q/A Context", d: "Gather deployment intent, target region, scale, and constraints" },
                    { n: "7", t: "Architecture + Cost", d: "AWS architecture JSON generation, cost estimation, Mermaid diagram" },
                    { n: "7.5", t: "Approval Gate", d: "Sign-off on architecture + cost before IaC is generated" },
                    { n: "8", t: "IaC Generation", d: "RAG-based Terraform bundle via terraform_agent, with Connector fallback" },
                    { n: "9", t: "GitOps / Policy", d: "Budget check and delivery policy enforcement before deployment" },
                    { n: "10", t: "Deploy", d: "AWS runtime Terraform apply OR GitOps repository-oriented delivery" }
                  ].map((s, i) => (
                    <div key={i} className="flex gap-4 p-4 bg-[#050505] border border-[#1A1A1A] rounded-lg items-center hover:border-[#262626] transition-colors">
                      <div className="w-8 h-8 rounded bg-white text-black font-bold flex items-center justify-center shrink-0">{s.n}</div>
                      <div>
                        <h4 className="text-sm font-bold text-white mb-1">{s.t}</h4>
                        <p className="text-xs text-zinc-400">{s.d}</p>
                      </div>
                    </div>
                  ))}
                </div>

                <div className="flex gap-3 p-4 border border-[#262626] bg-[#0A0A0A] rounded-lg items-start my-6">
                  <div className="bg-[#111111] p-2 rounded-md border border-[#262626]"><Info className="w-4 h-4 text-white" /></div>
                  <div>
                    <strong className="block text-white mb-1">Remediation cap</strong>
                    <span className="text-sm text-zinc-400">Cycles are capped at <strong>2</strong> to prevent unbounded spend. Large repositories may not reach full remediation in a single run even with root-cause dedupe.</span>
                  </div>
                </div>
              </div>
            )}

            {/* AGENTS SECTION */}
            {activePage === 'agents' && (
              <div className="animate-fade-in">
                <H1>Agent Architecture</H1>
                <P>DeplAI uses a set of specialized agents across the pipeline. The remediation path is the most agentic — a LangGraph-style proposer/critic/synthesizer loop with budget awareness and safe-write validation.</P>

                <H2 icon={Cpu}>Active Agent Roles</H2>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 my-6">
                  {[
                    { n: "EnvironmentInitializer", r: "Validates scan prerequisites and prepares execution environment before Stage 1." },
                    { n: "run_analysis_agent", r: "Queries KGagent concurrently for top CVEs and CWEs; produces structured business logic and vulnerability summaries." },
                    { n: "run_remediation_supervisor", r: "LangGraph proposer/critic/synthesizer loop. Root-cause deduped, repo-wide, Claude-only via Anthropic SDK." },
                    { n: "run_claude_remediation", r: "Fallback single-pass Claude remediator. Shares the same budget tracker as the supervisor." },
                    { n: "diagram_cost-estimation_agent", r: "Subprocess agent for Stage 7: diagram generation, cost packaging, and approval payload preparation." },
                    { n: "terraform_agent", r: "RAG-based Terraform generation engine. Produces validated bundles consumed by Stage 8." }
                  ].map((a, i) => (
                    <PixelCard key={i} gap={8} speed={30} className="p-5 border border-[#1A1A1A] bg-[#050505] rounded-lg h-full">
                      <h4 className="text-xs font-mono font-bold text-white mb-2">{a.n}</h4>
                      <p className="text-xs text-zinc-400 leading-relaxed">{a.r}</p>
                    </PixelCard>
                  ))}
                </div>

                <H2 icon={GitPullRequest}>Root-Cause Deduplication</H2>
                <div className="bg-[#050505] border border-[#1A1A1A] rounded-lg overflow-hidden my-6">
                  <table className="w-full text-left border-collapse text-sm">
                    <thead>
                      <tr className="bg-[#0A0A0A] border-b border-[#1A1A1A]">
                        <th className="p-4 text-[10px] font-bold text-zinc-500 uppercase tracking-widest">Finding Type</th>
                        <th className="p-4 text-[10px] font-bold text-zinc-500 uppercase tracking-widest">Dedup Key</th>
                        <th className="p-4 text-[10px] font-bold text-zinc-500 uppercase tracking-widest">Purpose</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[#1A1A1A]">
                      <tr className="hover:bg-[#111111] transition-colors"><td className="p-4 text-zinc-300">Code security (SAST)</td><td className="p-4 text-white font-mono text-xs">CWE + relative file path</td><td className="p-4 text-zinc-400 text-sm">Avoid redundant prompts on the same pattern</td></tr>
                      <tr className="hover:bg-[#111111] transition-colors"><td className="p-4 text-zinc-300">Supply chain (SCA)</td><td className="p-4 text-white font-mono text-xs">package + installed version + fix version</td><td className="p-4 text-zinc-400 text-sm">Collapse duplicate dependency findings</td></tr>
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* API SECTION */}
            {activePage === 'api' && (
              <div className="animate-fade-in">
                <H1>API Reference</H1>
                <P>All Connector BFF routes enforce session ownership. Agentic Layer routes require <InlineCode>DEPLAI_SERVICE_KEY</InlineCode> in the <InlineCode>X-API-Key</InlineCode> header.</P>

                <H2 icon={Globe}>Scan & Remediation</H2>
                <div className="bg-[#050505] border border-[#1A1A1A] rounded-lg overflow-hidden my-6">
                  <table className="w-full text-left border-collapse text-sm">
                    <thead>
                      <tr className="bg-[#0A0A0A] border-b border-[#1A1A1A]">
                        <th className="p-4 text-[10px] font-bold text-zinc-500 uppercase tracking-widest w-25">Method</th>
                        <th className="p-4 text-[10px] font-bold text-zinc-500 uppercase tracking-widest">Route</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[#1A1A1A]">
                      {[
                        { m: 'POST', r: '/api/scan/validate' },
                        { m: 'GET', r: '/api/scan/status' },
                        { m: 'GET', r: '/api/scan/results' },
                        { m: 'GET', r: '/api/scan/ws-token' },
                        { m: 'WS', r: '/ws/scan/{project_id}' },
                        { m: 'POST', r: '/api/remediate/start' },
                        { m: 'POST', r: '/api/remediate/validate' },
                        { m: 'WS', r: '/ws/remediate/{project_id}' }
                      ].map((item, i) => (
                        <tr key={i} className="hover:bg-[#111111] transition-colors">
                          <td className="p-4"><MethodBadge method={item.m} /></td>
                          <td className="p-4 font-mono text-[13px] text-zinc-300">{item.r}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <H2 icon={Play}>Architecture & Deploy</H2>
                <div className="bg-[#050505] border border-[#1A1A1A] rounded-lg overflow-hidden my-6">
                  <table className="w-full text-left border-collapse text-sm">
                    <thead>
                      <tr className="bg-[#0A0A0A] border-b border-[#1A1A1A]">
                        <th className="p-4 text-[10px] font-bold text-zinc-500 uppercase tracking-widest w-25">Method</th>
                        <th className="p-4 text-[10px] font-bold text-zinc-500 uppercase tracking-widest">Route</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[#1A1A1A]">
                      {[
                        { m: 'POST', r: '/api/architecture' },
                        { m: 'POST', r: '/api/cost' },
                        { m: 'POST', r: '/api/pipeline/stage7' },
                        { m: 'POST', r: '/api/pipeline/iac' },
                        { m: 'POST', r: '/api/pipeline/deploy' },
                        { m: 'POST', r: '/api/pipeline/deploy/status' },
                        { m: 'POST', r: '/api/pipeline/deploy/stop' },
                        { m: 'POST', r: '/api/pipeline/runtime-details' }
                      ].map((item, i) => (
                        <tr key={i} className="hover:bg-[#111111] transition-colors">
                          <td className="p-4"><MethodBadge method={item.m} /></td>
                          <td className="p-4 font-mono text-[13px] text-zinc-300">{item.r}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <div className="flex gap-3 p-4 border border-rose-500/20 bg-rose-500/10 rounded-lg items-start my-6">
                  <div className="bg-rose-500 p-2 rounded-md border border-rose-600"><AlertCircle className="w-4 h-4 text-white" /></div>
                  <div>
                    <strong className="block text-rose-500 mb-1">Destructive: Global Cleanup</strong>
                    <span className="text-sm text-zinc-400"><InlineCode>POST /api/cleanup</InlineCode> is destructive across ALL projects. The backend must be started with <InlineCode>ALLOW_GLOBAL_CLEANUP=true</InlineCode>. Never run in production without explicit intent.</span>
                  </div>
                </div>
              </div>
            )}

            {/* CONTRACTS SECTION */}
            {activePage === 'contracts' && (
              <div className="animate-fade-in">
                <H1>Architecture Contracts</H1>
                <P>The canonical Architecture JSON format is the shared contract between the Architecture Generator, Cost Estimator, Diagram Generator, and Terraform Generator. All four stages validate against this schema.</P>

                <H2 icon={FileJson}>Canonical Architecture JSON</H2>
                <CodeBlockWithCopy 
                  lang="JSON"
                  rawText={`{
  "title": "Production Web App",
  "provider": "aws",
  "schema_version": "1.0",
  "metadata": { "source": "deterministic_template" },
  "nodes": [
    {
      "id": "webAppServer",
      "type": "AmazonEC2",
      "label": "Web Server",
      "region": "Asia Pacific (Mumbai)",
      "attributes": { "instanceType": "t3.micro", "instanceCount": 1 }
    }
  ],
  "edges": [
    { "from": "webAppServer", "to": "websiteBucket", "label": "writes static content" }
  ]
}`}
                />

                <H2 icon={CheckCircle2}>Validation Rules</H2>
                <div className="bg-[#050505] border border-[#1A1A1A] rounded-lg overflow-hidden my-6">
                  <table className="w-full text-left border-collapse text-sm">
                    <thead>
                      <tr className="bg-[#0A0A0A] border-b border-[#1A1A1A]">
                        <th className="p-4 text-[10px] font-bold text-zinc-500 uppercase tracking-widest">Field</th>
                        <th className="p-4 text-[10px] font-bold text-zinc-500 uppercase tracking-widest">Rule</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[#1A1A1A]">
                      <tr className="hover:bg-[#111111] transition-colors"><td className="p-4 font-mono text-xs text-white">title</td><td className="p-4 text-zinc-400 text-sm">Required, non-empty string</td></tr>
                      <tr className="hover:bg-[#111111] transition-colors"><td className="p-4 font-mono text-xs text-white">provider</td><td className="p-4 text-zinc-400 text-sm">Optional — when present must be <InlineCode>aws</InlineCode> | <InlineCode>azure</InlineCode> | <InlineCode>gcp</InlineCode></td></tr>
                      <tr className="hover:bg-[#111111] transition-colors"><td className="p-4 font-mono text-xs text-white">schema_version</td><td className="p-4 text-zinc-400 text-sm">Defaults to <InlineCode>1.0</InlineCode></td></tr>
                      <tr className="hover:bg-[#111111] transition-colors"><td className="p-4 font-mono text-xs text-white">nodes</td><td className="p-4 text-zinc-400 text-sm">Required, at least one item</td></tr>
                      <tr className="hover:bg-[#111111] transition-colors"><td className="p-4 font-mono text-xs text-white">node.id</td><td className="p-4 text-zinc-400 text-sm">Matches regex, unique across all nodes</td></tr>
                      <tr className="hover:bg-[#111111] transition-colors"><td className="p-4 font-mono text-xs text-white">node.attributes</td><td className="p-4 text-zinc-400 text-sm">Object — defaults to <InlineCode>{`{}`}</InlineCode> if missing</td></tr>
                      <tr className="hover:bg-[#111111] transition-colors"><td className="p-4 font-mono text-xs text-white">edges</td><td className="p-4 text-zinc-400 text-sm">Defaults to <InlineCode>[]</InlineCode> — both from and to must reference existing node IDs</td></tr>
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* CONFIGURATION SECTION */}
            {activePage === 'configuration' && (
              <div className="animate-fade-in">
                <H1>Configuration</H1>
                <P>All environment variables go in the repo-root <InlineCode>.env</InlineCode> file. Connector and Agentic Layer share this file at startup.</P>

                <H2 icon={Settings}>Core Runtime</H2>
                <div className="bg-[#050505] border border-[#1A1A1A] rounded-lg overflow-hidden my-6">
                  <table className="w-full text-left border-collapse text-sm">
                    <tbody className="divide-y divide-[#1A1A1A]">
                      <tr className="hover:bg-[#111111] transition-colors"><td className="p-4 font-mono text-xs text-white w-64">NEXT_PUBLIC_APP_URL</td><td className="p-4 text-zinc-400 text-sm">Connector public URL</td><td className="p-4"><span className="px-2 py-0.5 rounded text-[10px] font-bold uppercase bg-white text-black">Req</span></td></tr>
                      <tr className="hover:bg-[#111111] transition-colors"><td className="p-4 font-mono text-xs text-white w-64">AGENTIC_LAYER_URL</td><td className="p-4 text-zinc-400 text-sm">Internal URL for REST calls</td><td className="p-4"><span className="px-2 py-0.5 rounded text-[10px] font-bold uppercase bg-white text-black">Req</span></td></tr>
                      <tr className="hover:bg-[#111111] transition-colors"><td className="p-4 font-mono text-xs text-white w-64">DEPLAI_SERVICE_KEY</td><td className="p-4 text-zinc-400 text-sm">Shared secret in X-API-Key</td><td className="p-4"><span className="px-2 py-0.5 rounded text-[10px] font-bold uppercase bg-white text-black">Req</span></td></tr>
                      <tr className="hover:bg-[#111111] transition-colors"><td className="p-4 font-mono text-xs text-white w-64">WS_TOKEN_SECRET</td><td className="p-4 text-zinc-400 text-sm">HMAC signing secret</td><td className="p-4"><span className="px-2 py-0.5 rounded text-[10px] font-bold uppercase bg-white text-black">Req</span></td></tr>
                      <tr className="hover:bg-[#111111] transition-colors"><td className="p-4 font-mono text-xs text-white w-64">SESSION_SECRET</td><td className="p-4 text-zinc-400 text-sm">iron-session encryption secret</td><td className="p-4"><span className="px-2 py-0.5 rounded text-[10px] font-bold uppercase bg-white text-black">Req</span></td></tr>
                    </tbody>
                  </table>
                </div>

                <H2 icon={Cpu}>Remediation</H2>
                <div className="bg-[#050505] border border-[#1A1A1A] rounded-lg overflow-hidden my-6">
                  <table className="w-full text-left border-collapse text-sm">
                    <tbody className="divide-y divide-[#1A1A1A]">
                      <tr className="hover:bg-[#111111] transition-colors"><td className="p-4 font-mono text-xs text-white w-72">ANTHROPIC_API_KEY</td><td className="p-4 text-zinc-400 text-sm">API key for all Claude SDK calls</td><td className="p-4"><span className="px-2 py-0.5 rounded text-[10px] font-bold uppercase bg-white text-black">Req</span></td></tr>
                      <tr className="hover:bg-[#111111] transition-colors"><td className="p-4 font-mono text-xs text-white w-72">REMEDIATION_CLAUDE_MODEL</td><td className="p-4 text-zinc-400 text-sm">Model slug (e.g. claude-sonnet-4-5)</td><td className="p-4"><span className="px-2 py-0.5 rounded text-[10px] font-bold uppercase bg-white text-black">Req</span></td></tr>
                      <tr className="hover:bg-[#111111] transition-colors"><td className="p-4 font-mono text-xs text-white w-72">DEPLAI_MAX_REMEDIATION_COST_USD</td><td className="p-4 text-zinc-400 text-sm">Hard cap on Claude spend per run</td><td className="p-4"><span className="px-2 py-0.5 rounded text-[10px] font-bold uppercase bg-white text-black">Req</span></td></tr>
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* RUNBOOK SECTION */}
            {activePage === 'runbook' && (
              <div className="animate-fade-in">
                <H1>Operational Runbook</H1>
                <P>Step-by-step procedures for starting, operating, and recovering the DeplAI stack in production or staging environments.</P>

                <H2 icon={Activity}>Health Checks</H2>
                <CodeBlockWithCopy lang="BASH" rawText="curl http://localhost:8000/health" />
                <CodeBlockWithCopy lang="BASH" rawText="curl http://localhost:3000/api/pipeline/health" />
                <CodeBlockWithCopy lang="BASH" rawText="docker volume ls" />
                <P>Expected Docker volumes: <InlineCode>codebase_deplai</InlineCode>, <InlineCode>security_reports</InlineCode>, <InlineCode>LLM_Output</InlineCode>, <InlineCode>grype_db_cache</InlineCode>.</P>

                <H2 icon={Terminal}>Log Inspection</H2>
                <CodeBlockWithCopy lang="BASH" rawText="docker compose logs -f agentic-layer" />
                <CodeBlockWithCopy lang="BASH" rawText={`docker run --rm -v security_reports:/vol alpine sh -c "ls -lah /vol"`} />

                <H2 icon={Play}>Deploy Modes</H2>
                <div className="bg-[#050505] border border-[#1A1A1A] rounded-lg overflow-hidden my-6">
                  <table className="w-full text-left border-collapse text-sm">
                    <thead>
                      <tr className="bg-[#0A0A0A] border-b border-[#1A1A1A]">
                        <th className="p-4 text-[10px] font-bold text-zinc-500 uppercase tracking-widest">Mode</th>
                        <th className="p-4 text-[10px] font-bold text-zinc-500 uppercase tracking-widest">Flag</th>
                        <th className="p-4 text-[10px] font-bold text-zinc-500 uppercase tracking-widest">Behavior</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[#1A1A1A]">
                      <tr className="hover:bg-[#111111] transition-colors"><td className="p-4 text-white font-bold text-sm">GitOps</td><td className="p-4 font-mono text-xs text-zinc-400">runtime_apply=false</td><td className="p-4 text-zinc-400 text-sm">Push Terraform bundle to repository; delivery via external GitOps tooling</td></tr>
                      <tr className="hover:bg-[#111111] transition-colors"><td className="p-4 text-white font-bold text-sm">Runtime Apply</td><td className="p-4 font-mono text-xs text-zinc-400">runtime_apply=true</td><td className="p-4 text-zinc-400 text-sm">Backend executes <InlineCode>terraform apply</InlineCode> using HashiCorp image — AWS only</td></tr>
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* TROUBLESHOOTING SECTION */}
            {activePage === 'troubleshooting' && (
              <div className="animate-fade-in">
                <H1>Troubleshooting</H1>
                <P>Diagnosis guide for common failure modes in scan, remediation, IaC, and deployment stages.</P>

                <H2 icon={ShieldAlert}>Scan Stays not_initiated</H2>
                <div className="flex gap-3 p-4 border border-[#262626] bg-[#0A0A0A] rounded-lg items-start my-4">
                  <div className="bg-[#111111] p-2 rounded-md border border-[#262626]"><AlertCircle className="w-4 h-4 text-white" /></div>
                  <div className="text-sm text-zinc-400 pt-1">Verify Docker is running, <InlineCode>agentic-layer</InlineCode> is healthy, and <InlineCode>DEPLAI_SERVICE_KEY</InlineCode> matches between Connector and backend.</div>
                </div>
                <CodeBlockWithCopy lang="BASH" rawText={`docker info\ncurl http://localhost:8000/health\ndocker compose logs -f agentic-layer`} />

                <H2 icon={Globe}>WebSocket Closes with 1008</H2>
                <P>This code means token rejection. Likely causes: missing or expired token, <InlineCode>WS_TOKEN_SECRET</InlineCode> mismatch, or project/user mismatch in the token claims.</P>
                <P>Check <InlineCode>/api/scan/ws-token</InlineCode> and backend logs around WebSocket verification.</P>

                <H2 icon={FileCode2}>Remediation Produces No PR</H2>
                <div className="bg-[#050505] border border-[#1A1A1A] rounded-lg overflow-hidden my-6">
                  <table className="w-full text-left border-collapse text-sm">
                    <thead>
                      <tr className="bg-[#0A0A0A] border-b border-[#1A1A1A]">
                        <th className="p-4 text-[10px] font-bold text-zinc-500 uppercase tracking-widest">Possible Cause</th>
                        <th className="p-4 text-[10px] font-bold text-zinc-500 uppercase tracking-widest">Check</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[#1A1A1A]">
                      <tr className="hover:bg-[#111111] transition-colors"><td className="p-4 text-white font-medium text-sm">No safe file changes accepted</td><td className="p-4 text-zinc-400 text-sm">Review remediation WebSocket messages</td></tr>
                      <tr className="hover:bg-[#111111] transition-colors"><td className="p-4 text-white font-medium text-sm">GitHub push permissions failed</td><td className="p-4 text-zinc-400 text-sm">Verify GitHub App token and repo access</td></tr>
                      <tr className="hover:bg-[#111111] transition-colors"><td className="p-4 text-white font-medium text-sm">Stopped early on budget cap</td><td className="p-4 text-zinc-400 text-sm">Check <InlineCode>DEPLAI_MAX_REMEDIATION_COST_USD</InlineCode></td></tr>
                    </tbody>
                  </table>
                </div>

                <H2 icon={Database}>KG Unavailable</H2>
                <div className="flex gap-3 p-4 border border-[#262626] bg-[#0A0A0A] rounded-lg items-start my-4">
                  <div className="bg-[#111111] p-2 rounded-md border border-[#262626]"><CheckCircle2 className="w-4 h-4 text-white" /></div>
                  <div className="text-sm text-zinc-400 pt-1"><strong>Expected behavior</strong> — remediation continues with degraded context when KGagent/Neo4j is unavailable. Check Neo4j connectivity and backend logs for KG import errors.</div>
                </div>

                <H2 icon={AlertCircle}>Deploy Blocked by Budget</H2>
                <div className="flex gap-3 p-4 border border-[#262626] bg-[#0A0A0A] rounded-lg items-start my-4">
                  <div className="bg-[#111111] p-2 rounded-md border border-[#262626]"><AlertCircle className="w-4 h-4 text-white" /></div>
                  <div className="text-sm text-zinc-400 pt-1">Deploy returns a blocked response when <InlineCode>estimated_monthly_usd &gt; budget_limit_usd</InlineCode> and no override is set. Options: raise budget limit, set override (requires sign-off), or reduce planned architecture.</div>
                </div>
              </div>
            )}

          </div>
        </main>
      </div>
    </div>
  );
}

