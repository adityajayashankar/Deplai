'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { useParams, useRouter } from 'next/navigation';
import * as THREE from 'three';
import {
  AlertCircle,
  Bot,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleDashed,
  ExternalLink,
  Eye,
  FileCode2,
  FileJson,
  GitPullRequest,
  Play,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  TerminalSquare,
} from 'lucide-react';
import { useScan, type VulnStatus } from '@/lib/scan-context';
import { useLLM, LLM_PROVIDERS } from '@/lib/llm-context';

type PipelineStageId = 'scan' | 'results' | 'remediate_setup' | 'remediate_run' | 'approval' | 'pr_rescan';

const SIDEBAR_STAGES: Array<{ id: PipelineStageId; label: string; details: string }> = [
  { id: 'scan', label: 'SAST / SCA Scan', details: 'Full codebase analysis' },
  { id: 'results', label: 'Vulnerability Results', details: 'Findings & KPIs' },
  { id: 'remediate_setup', label: 'AI Remediation', details: 'Configure Agent' },
  { id: 'remediate_run', label: 'Agent Execution', details: 'Live patching' },
  { id: 'approval', label: 'Review & Approval', details: 'Diff validation gate' },
  { id: 'pr_rescan', label: 'GitOps & Rescan', details: 'PR creation & verification' },
];

const STAGE_INDEX: Record<PipelineStageId, number> = {
  scan: 0,
  results: 1,
  remediate_setup: 2,
  remediate_run: 3,
  approval: 4,
  pr_rescan: 5,
};

const RESULTS_HEARTBEAT_MS = 30_000;
const REMEDIATION_PROVIDER = 'claude' as const;
const REMEDIATION_PROVIDER_CONFIG = LLM_PROVIDERS.find((entry) => entry.id === REMEDIATION_PROVIDER)!;
const REMEDIATION_DEFAULT_MODEL = 'claude-sonnet-4-5';

const EMPTY_STATS = { total: 0, critical: 0, high: 0, autoFixable: 0 };

interface Occurrence {
  filename: string;
  line_number: number;
  code_extract: string;
  documentation_url: string;
}

interface CWEGroup {
  cwe_id: string;
  title: string;
  severity: string;
  count: number;
  occurrences: Occurrence[];
}

interface SupplyChainVuln {
  name: string;
  type: string;
  version: string;
  severity: string;
  epss_score: number | null;
  fix_version: string | null;
  cve_id: string;
}

interface ScanResults {
  supply_chain: SupplyChainVuln[];
  code_security: CWEGroup[];
}

interface ScanStats {
  total: number;
  critical: number;
  high: number;
  autoFixable: number;
}

interface ProjectMeta {
  type: 'local' | 'github';
  installationId?: string;
  owner?: string;
  repo?: string;
  branch?: string;
}

interface ChangedFileEntry {
  path: string;
  reason?: string;
  diff?: string;
}

interface KgCorrelation {
  id: string;
  description: string;
  relationship: string;
  cvss: string;
}

interface KgQuery {
  entity: string;
  type: string;
  status: 'online' | 'offline';
  summary: string;
  direct_count: number;
  inferred_count: number;
  correlations: KgCorrelation[];
  inferred: KgCorrelation[];
  actions: string[];
}

interface KgContextFinding {
  cwe_id: string;
  title: string;
  severity: string;
  count: number;
}

interface KgContextVuln {
  cve_id: string;
  name: string;
  version: string;
  severity: string;
  fix_version: string | null;
}

interface KgContext {
  total_components: number;
  queries: KgQuery[];
  code_security: KgContextFinding[];
  supply_chain: KgContextVuln[];
}

interface KgResultPayload {
  business_logic_summary?: string;
  vulnerability_summary?: string;
  context?: KgContext;
}

function computeStats(data: ScanResults): ScanStats {
  const sc = Array.isArray(data.supply_chain) ? data.supply_chain : [];
  const cs = Array.isArray(data.code_security) ? data.code_security : [];
  return {
    total: sc.length + cs.reduce((sum, group) => sum + Number(group.count || 0), 0),
    critical:
      sc.filter((item) => item.severity.toLowerCase() === 'critical').length +
      cs.filter((item) => item.severity.toLowerCase() === 'critical').reduce((sum, group) => sum + Number(group.count || 0), 0),
    high:
      sc.filter((item) => item.severity.toLowerCase() === 'high').length +
      cs.filter((item) => item.severity.toLowerCase() === 'high').reduce((sum, group) => sum + Number(group.count || 0), 0),
    autoFixable: sc.filter((item) => item.fix_version !== null).length,
  };
}

function flattenCodeSecurity(groups: CWEGroup[]) {
  const out: Array<{ location: string; issue: string; severity: string; description: string }> = [];
  for (const group of groups || []) {
    const severity = String(group.severity || 'low');
    if (Array.isArray(group.occurrences) && group.occurrences.length > 0) {
      for (const occ of group.occurrences) {
        out.push({
          location: `${occ.filename || 'unknown'}:${occ.line_number || 0}`,
          issue: `CWE-${group.cwe_id}`,
          severity,
          description: group.title || occ.code_extract || '',
        });
      }
      continue;
    }
    out.push({
      location: 'multiple locations',
      issue: `CWE-${group.cwe_id}`,
      severity,
      description: group.title || '',
    });
  }
  return out;
}

function getSeverityBadgeClasses(severity: string) {
  const value = String(severity || '').toLowerCase();
  if (value === 'critical') return 'bg-rose-500/10 text-rose-500 border border-rose-500/20';
  if (value === 'high') return 'bg-amber-500/10 text-amber-500 border border-amber-500/20';
  if (value === 'medium') return 'bg-yellow-500/10 text-yellow-400 border border-yellow-500/20';
  return 'bg-sky-500/10 text-sky-400 border border-sky-500/20';
}

function parseHSL(hslStr: string): { h: number; s: number; l: number } {
  const match = hslStr.match(/([\d.]+)\s*([\d.]+)%?\s*([\d.]+)%?/);
  if (!match) return { h: 40, s: 80, l: 80 };
  return { h: Number.parseFloat(match[1]), s: Number.parseFloat(match[2]), l: Number.parseFloat(match[3]) };
}

function buildBoxShadow(glowColor: string, intensity: number): string {
  const { h, s, l } = parseHSL(glowColor);
  const base = `${h}deg ${s}% ${l}%`;
  const layers: Array<[number, number, number, number, number, boolean]> = [
    [0, 0, 0, 1, 100, true],
    [0, 0, 1, 0, 60, true],
    [0, 0, 3, 0, 50, true],
    [0, 0, 6, 0, 40, true],
    [0, 0, 15, 0, 30, true],
    [0, 0, 25, 2, 20, true],
    [0, 0, 50, 2, 10, true],
    [0, 0, 1, 0, 60, false],
    [0, 0, 3, 0, 50, false],
    [0, 0, 6, 0, 40, false],
    [0, 0, 15, 0, 30, false],
    [0, 0, 25, 2, 20, false],
    [0, 0, 50, 2, 10, false],
  ];
  return layers
    .map(([x, y, blur, spread, alpha, inset]) => {
      const a = Math.min(alpha * intensity, 100);
      return `${inset ? 'inset ' : ''}${x}px ${y}px ${blur}px ${spread}px hsl(${base} / ${a}%)`;
    })
    .join(', ');
}

function easeOutCubic(x: number) {
  return 1 - Math.pow(1 - x, 3);
}

function easeInCubic(x: number) {
  return x * x * x;
}

function animateValue({
  start = 0,
  end = 100,
  duration = 1000,
  delay = 0,
  ease = easeOutCubic,
  onUpdate,
  onEnd,
}: {
  start?: number;
  end?: number;
  duration?: number;
  delay?: number;
  ease?: (x: number) => number;
  onUpdate: (value: number) => void;
  onEnd?: () => void;
}) {
  const t0 = performance.now() + delay;
  function tick() {
    const elapsed = performance.now() - t0;
    const t = Math.min(elapsed / duration, 1);
    onUpdate(start + (end - start) * ease(t));
    if (t < 1) requestAnimationFrame(tick);
    else onEnd?.();
  }
  window.setTimeout(() => requestAnimationFrame(tick), delay);
}

const GRADIENT_POSITIONS = ['80% 55%', '69% 34%', '8% 6%', '41% 38%', '86% 85%', '82% 18%', '51% 4%'];
const COLOR_MAP = [0, 1, 2, 0, 1, 2, 1];

function buildMeshGradients(colors: string[]): string[] {
  const gradients: string[] = [];
  for (let i = 0; i < 7; i += 1) {
    const color = colors[Math.min(COLOR_MAP[i], colors.length - 1)];
    gradients.push(`radial-gradient(at ${GRADIENT_POSITIONS[i]}, ${color} 0px, transparent 50%)`);
  }
  gradients.push(`linear-gradient(${colors[0]} 0 100%)`);
  return gradients;
}

interface BorderGlowProps {
  children?: React.ReactNode;
  className?: string;
  edgeSensitivity?: number;
  glowColor?: string;
  backgroundColor?: string;
  borderRadius?: number;
  glowRadius?: number;
  glowIntensity?: number;
  coneSpread?: number;
  animated?: boolean;
  colors?: string[];
  fillOpacity?: number;
}

const BorderGlow: React.FC<BorderGlowProps> = ({
  children,
  className = '',
  edgeSensitivity = 30,
  glowColor = '40 80 80',
  backgroundColor = '#000000',
  borderRadius = 12,
  glowRadius = 30,
  glowIntensity = 0.3,
  coneSpread = 25,
  animated = false,
  colors = ['#3f3f46', '#18181b', '#000000'],
  fillOpacity = 0.5,
}) => {
  const cardRef = useRef<HTMLDivElement>(null);
  const [isHovered, setIsHovered] = useState(false);
  const [cursorAngle, setCursorAngle] = useState(animated ? 110 : 45);
  const [edgeProximity, setEdgeProximity] = useState(0);
  const [sweepActive, setSweepActive] = useState(animated);

  const getCenterOfElement = useCallback((element: HTMLElement) => {
    const { width, height } = element.getBoundingClientRect();
    return [width / 2, height / 2];
  }, []);

  const getEdgeProximity = useCallback(
    (element: HTMLElement, x: number, y: number) => {
      const [cx, cy] = getCenterOfElement(element);
      const dx = x - cx;
      const dy = y - cy;
      let kx = Number.POSITIVE_INFINITY;
      let ky = Number.POSITIVE_INFINITY;
      if (dx !== 0) kx = cx / Math.abs(dx);
      if (dy !== 0) ky = cy / Math.abs(dy);
      return Math.min(Math.max(1 / Math.min(kx, ky), 0), 1);
    },
    [getCenterOfElement],
  );

  const getCursorAngle = useCallback(
    (element: HTMLElement, x: number, y: number) => {
      const [cx, cy] = getCenterOfElement(element);
      const dx = x - cx;
      const dy = y - cy;
      if (dx === 0 && dy === 0) return 0;
      let degrees = Math.atan2(dy, dx) * (180 / Math.PI) + 90;
      if (degrees < 0) degrees += 360;
      return degrees;
    },
    [getCenterOfElement],
  );

  const handlePointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const card = cardRef.current;
      if (!card) return;
      const rect = card.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      setEdgeProximity(getEdgeProximity(card, x, y));
      setCursorAngle(getCursorAngle(card, x, y));
    },
    [getCursorAngle, getEdgeProximity],
  );

  useEffect(() => {
    if (!animated) return;
    const angleStart = 110;
    const angleEnd = 465;
    const timeoutIds: number[] = [];
    timeoutIds.push(window.setTimeout(() => setSweepActive(true), 0));
    timeoutIds.push(window.setTimeout(() => setCursorAngle(angleStart), 0));
    animateValue({ duration: 500, onUpdate: (value) => setEdgeProximity(value / 100) });
    animateValue({
      ease: easeInCubic,
      duration: 1500,
      end: 50,
      onUpdate: (value) => setCursorAngle((angleEnd - angleStart) * (value / 100) + angleStart),
    });
    animateValue({
      ease: easeOutCubic,
      delay: 1500,
      duration: 2250,
      start: 50,
      end: 100,
      onUpdate: (value) => setCursorAngle((angleEnd - angleStart) * (value / 100) + angleStart),
    });
    animateValue({
      ease: easeInCubic,
      delay: 2500,
      duration: 1500,
      start: 100,
      end: 0,
      onUpdate: (value) => setEdgeProximity(value / 100),
      onEnd: () => setSweepActive(false),
    });
    return () => {
      timeoutIds.forEach((id) => window.clearTimeout(id));
    };
  }, [animated]);

  const isVisible = isHovered || sweepActive;
  const borderOpacity = isVisible
    ? Math.max(0, (edgeProximity * 100 - (edgeSensitivity + 20)) / (100 - (edgeSensitivity + 20)))
    : 0;
  const glowOpacity = isVisible ? Math.max(0, (edgeProximity * 100 - edgeSensitivity) / (100 - edgeSensitivity)) : 0;
  const meshGradients = buildMeshGradients(colors);
  const borderBg = meshGradients.map((gradient) => `${gradient} border-box`);
  const fillBg = meshGradients.map((gradient) => `${gradient} padding-box`);
  const angleDeg = `${cursorAngle.toFixed(3)}deg`;

  return (
    <div
      ref={cardRef}
      onPointerMove={handlePointerMove}
      onPointerEnter={() => setIsHovered(true)}
      onPointerLeave={() => setIsHovered(false)}
      className={`relative grid isolate ${className}`}
      style={{ background: backgroundColor, borderRadius: `${borderRadius}px`, transform: 'translate3d(0, 0, 0.01px)' }}
    >
      <div
        className="absolute inset-0 rounded-[inherit] -z-[1]"
        style={{
          border: '1px solid transparent',
          background: [`linear-gradient(${backgroundColor} 0 100%) padding-box`, 'linear-gradient(rgb(255 255 255 / 0%) 0% 100%) border-box', ...borderBg].join(', '),
          opacity: borderOpacity,
          maskImage: `conic-gradient(from ${angleDeg} at center, black ${coneSpread}%, transparent ${coneSpread + 15}%, transparent ${100 - coneSpread - 15}%, black ${100 - coneSpread}%)`,
          WebkitMaskImage: `conic-gradient(from ${angleDeg} at center, black ${coneSpread}%, transparent ${coneSpread + 15}%, transparent ${100 - coneSpread - 15}%, black ${100 - coneSpread}%)`,
          transition: isVisible ? 'opacity 0.25s ease-out' : 'opacity 0.75s ease-in-out',
        }}
      />
      <div
        className="absolute inset-0 rounded-[inherit] -z-[1]"
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
        } as CSSProperties}
      />
      <span
        className="absolute pointer-events-none z-[1] rounded-[inherit]"
        style={{
          inset: `${-glowRadius}px`,
          maskImage: `conic-gradient(from ${angleDeg} at center, black 2.5%, transparent 10%, transparent 90%, black 97.5%)`,
          WebkitMaskImage: `conic-gradient(from ${angleDeg} at center, black 2.5%, transparent 10%, transparent 90%, black 97.5%)`,
          opacity: glowOpacity,
          mixBlendMode: 'plus-lighter',
          transition: isVisible ? 'opacity 0.25s ease-out' : 'opacity 0.75s ease-in-out',
        } as CSSProperties}
      >
        <span className="absolute rounded-[inherit]" style={{ inset: `${glowRadius}px`, boxShadow: buildBoxShadow(glowColor, glowIntensity) }} />
      </span>
      <div className="relative z-[1] flex h-full w-full flex-col">{children}</div>
    </div>
  );
};

class Pixel {
  width: number;
  height: number;
  ctx: CanvasRenderingContext2D;
  x: number;
  y: number;
  color: string;
  speed: number;
  size: number;
  sizeStep: number;
  minSize: number;
  maxSizeInteger: number;
  maxSize: number;
  delay: number;
  counter: number;
  counterStep: number;
  isIdle: boolean;
  isReverse: boolean;
  isShimmer: boolean;

  constructor(canvas: HTMLCanvasElement, context: CanvasRenderingContext2D, x: number, y: number, color: string, speed: number, delay: number) {
    const dpr = window.devicePixelRatio || 1;
    this.width = canvas.width / dpr;
    this.height = canvas.height / dpr;
    this.ctx = context;
    this.x = x;
    this.y = y;
    this.color = color;
    this.speed = this.getRandomValue(0.1, 0.9) * speed;
    this.size = 0;
    this.sizeStep = Math.random() * 0.4;
    this.minSize = 0.5;
    this.maxSizeInteger = 2;
    this.maxSize = this.getRandomValue(this.minSize, this.maxSizeInteger);
    this.delay = delay;
    this.counter = 0;
    this.counterStep = Math.random() * 4 + (this.width + this.height) * 0.01;
    this.isIdle = false;
    this.isReverse = false;
    this.isShimmer = false;
  }

  getRandomValue(min: number, max: number) {
    return Math.random() * (max - min) + min;
  }

  draw() {
    const centerOffset = this.maxSizeInteger * 0.5 - this.size * 0.5;
    this.ctx.fillStyle = this.color;
    this.ctx.fillRect(Math.round(this.x + centerOffset), Math.round(this.y + centerOffset), Math.round(this.size), Math.round(this.size));
  }

  appear() {
    this.isIdle = false;
    if (this.counter <= this.delay) {
      this.counter += this.counterStep;
      return;
    }
    if (this.size >= this.maxSize) this.isShimmer = true;
    if (this.isShimmer) this.shimmer();
    else this.size += this.sizeStep;
    this.draw();
  }

  disappear() {
    this.isShimmer = false;
    this.counter = 0;
    if (this.size <= 0) {
      this.isIdle = true;
      return;
    }
    this.size -= 0.1;
    this.draw();
  }

  shimmer() {
    if (this.size >= this.maxSize) this.isReverse = true;
    else if (this.size <= this.minSize) this.isReverse = false;
    if (this.isReverse) this.size -= this.speed;
    else this.size += this.speed;
  }
}

function getEffectiveSpeed(value: number, reducedMotion: boolean) {
  const throttle = 0.001;
  if (value <= 0 || reducedMotion) return 0;
  if (value >= 100) return 100 * throttle;
  return value * throttle;
}

interface PixelCardProps {
  gap?: number;
  speed?: number;
  colors?: string;
  noFocus?: boolean;
  className?: string;
  children: React.ReactNode;
}

const PixelCard: React.FC<PixelCardProps> = ({
  gap = 5,
  speed = 35,
  colors = '#f8fafc,#f1f5f9,#cbd5e1',
  noFocus = false,
  className = '',
  children,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pixelsRef = useRef<Pixel[]>([]);
  const animationRef = useRef<number | null>(null);
  const timePreviousRef = useRef(0);
  const reducedMotionRef = useRef(false);

  const initPixels = useCallback(() => {
    if (!containerRef.current || !canvasRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const width = Math.floor(rect.width);
    const height = Math.floor(rect.height);
    const ctx = canvasRef.current.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    canvasRef.current.width = width * dpr;
    canvasRef.current.height = height * dpr;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.scale(dpr, dpr);

    const colorsArray = colors.split(',');
    const pixels: Pixel[] = [];
    for (let x = 0; x < width; x += gap) {
      for (let y = 0; y < height; y += gap) {
        const color = colorsArray[Math.floor(Math.random() * colorsArray.length)];
        const dx = x - width / 2;
        const dy = y - height / 2;
        const distance = Math.sqrt(dx * dx + dy * dy);
        const delay = reducedMotionRef.current ? 0 : distance;
        pixels.push(new Pixel(canvasRef.current, ctx, x, y, color, getEffectiveSpeed(speed, reducedMotionRef.current), delay));
      }
    }
    pixelsRef.current = pixels;
  }, [colors, gap, speed]);

  const handleAnimation = useCallback((name: 'appear' | 'disappear') => {
    if (animationRef.current !== null) cancelAnimationFrame(animationRef.current);
    const tick = () => {
      animationRef.current = requestAnimationFrame(tick);
      const timeNow = performance.now();
      const timePassed = timeNow - timePreviousRef.current;
      const timeInterval = 1000 / 60;
      if (timePassed < timeInterval) return;
      timePreviousRef.current = timeNow - (timePassed % timeInterval);

      const canvas = canvasRef.current;
      const ctx = canvas?.getContext('2d');
      if (!canvas || !ctx) return;
      const dpr = window.devicePixelRatio || 1;
      ctx.clearRect(0, 0, canvas.width / dpr, canvas.height / dpr);

      let allIdle = true;
      for (const pixel of pixelsRef.current) {
        pixel[name]();
        if (!pixel.isIdle) allIdle = false;
      }
      if (allIdle && animationRef.current !== null) {
        cancelAnimationFrame(animationRef.current);
        animationRef.current = null;
      }
    };
    timePreviousRef.current = performance.now();
    animationRef.current = requestAnimationFrame(tick);
  }, []);

  useEffect(() => {
    reducedMotionRef.current = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    initPixels();
    const observer = new ResizeObserver(() => initPixels());
    if (containerRef.current) observer.observe(containerRef.current);
    return () => {
      observer.disconnect();
      if (animationRef.current !== null) cancelAnimationFrame(animationRef.current);
    };
  }, [initPixels]);

  return (
    <div
      ref={containerRef}
      className={`relative isolate overflow-hidden select-none transition-colors duration-200 ease-[cubic-bezier(0.5,1,0.89,1)] ${className}`}
      onMouseEnter={() => handleAnimation('appear')}
      onMouseLeave={() => handleAnimation('disappear')}
      onFocus={noFocus ? undefined : (event) => {
        if (event.currentTarget.contains(event.relatedTarget)) return;
        handleAnimation('appear');
      }}
      onBlur={noFocus ? undefined : (event) => {
        if (event.currentTarget.contains(event.relatedTarget)) return;
        handleAnimation('disappear');
      }}
      tabIndex={noFocus ? -1 : 0}
    >
      <canvas ref={canvasRef} className="pointer-events-none absolute inset-0 z-0 block h-full w-full" />
      <div className="relative z-10 flex h-full w-full flex-col">{children}</div>
    </div>
  );
};

const VERTEX_SRC = 'void main() { gl_Position = vec4(position, 1.0); }';
const FRAGMENT_SRC = `
precision highp float;
uniform vec3 uColor; uniform vec2 uResolution; uniform float uTime; uniform float uPixelSize; uniform float uPixelJitter; uniform float uEdgeFade; uniform float uNoiseAmount;
out vec4 fragColor;
float hash11(float n){ return fract(sin(n)*43758.5453); }
void main(){
  vec2 fragCoord = gl_FragCoord.xy - uResolution * .5;
  float h = fract(sin(dot(floor(fragCoord / uPixelSize), vec2(127.1, 311.7))) * 43758.5453);
  float M = 1.0 + (h - 0.5) * uPixelJitter;
  if (uEdgeFade > 0.0) {
    vec2 norm = gl_FragCoord.xy / uResolution;
    float edge = min(min(norm.x, norm.y), min(1.0 - norm.x, 1.0 - norm.y));
    M *= smoothstep(0.0, uEdgeFade, edge);
  }
  vec3 color = uColor;
  if (uNoiseAmount > 0.0) color += (hash11(dot(gl_FragCoord.xy, vec2(12.98, 78.23)) + uTime) - 0.5) * uNoiseAmount;
  fragColor = vec4(color, M * 0.1);
}
`;

const PixelBlast = ({
  pixelSize = 3,
  color = '#3f3f46',
  className,
  style,
  antialias = true,
  pixelSizeJitter = 0.5,
  edgeFade = 0.5,
  noiseAmount = 0.05,
}: {
  pixelSize?: number;
  color?: string;
  className?: string;
  style?: React.CSSProperties;
  antialias?: boolean;
  pixelSizeJitter?: number;
  edgeFade?: number;
  noiseAmount?: number;
}) => {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const renderer = new THREE.WebGLRenderer({ canvas: document.createElement('canvas'), antialias, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.appendChild(renderer.domElement);

    const uniforms = {
      uResolution: { value: new THREE.Vector2(0, 0) },
      uTime: { value: 0 },
      uColor: { value: new THREE.Color(color) },
      uPixelSize: { value: pixelSize },
      uPixelJitter: { value: pixelSizeJitter },
      uEdgeFade: { value: edgeFade },
      uNoiseAmount: { value: noiseAmount },
    };
    const scene = new THREE.Scene();
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const material = new THREE.ShaderMaterial({ vertexShader: VERTEX_SRC, fragmentShader: FRAGMENT_SRC, uniforms, transparent: true, glslVersion: THREE.GLSL3 });
    scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material));

    const clock = new THREE.Clock();
    const setSize = () => {
      renderer.setSize(container.clientWidth || 1, container.clientHeight || 1, false);
      uniforms.uResolution.value.set(renderer.domElement.width, renderer.domElement.height);
    };
    setSize();
    const resizeObserver = new ResizeObserver(setSize);
    resizeObserver.observe(container);

    let animationFrame = 0;
    const animate = () => {
      uniforms.uTime.value = clock.getElapsedTime();
      renderer.render(scene, camera);
      animationFrame = requestAnimationFrame(animate);
    };
    animationFrame = requestAnimationFrame(animate);

    return () => {
      resizeObserver.disconnect();
      cancelAnimationFrame(animationFrame);
      renderer.dispose();
      if (renderer.domElement.parentElement === container) container.removeChild(renderer.domElement);
    };
  }, [antialias, color, edgeFade, noiseAmount, pixelSize, pixelSizeJitter]);

  return <div ref={containerRef} className={`relative h-full w-full overflow-hidden ${className ?? ''}`} style={style} />;
};

function RunButton({
  onClick,
  disabled = false,
  className = '',
  children,
}: {
  onClick?: () => void;
  disabled?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={`h-12 w-full ${className}`}>
      <PixelCard
        noFocus
        colors="#3f3f46,#27272a,#18181b"
        gap={4}
        speed={35}
        className={`h-full w-full rounded-md transition-all ${
          disabled
            ? 'cursor-not-allowed border border-[#1A1A1A] bg-[#000000] opacity-50'
            : 'cursor-pointer border border-[#262626] bg-[#050505] shadow-[0_4px_15px_rgba(0,0,0,0.5)] hover:border-[#3f3f46] hover:bg-[#111111]'
        }`}
      >
        <button
          type="button"
          onClick={disabled ? undefined : onClick}
          disabled={disabled}
          className={`flex h-full w-full items-center justify-center gap-2 text-sm font-semibold outline-none transition-colors ${
            disabled ? 'text-zinc-600' : 'text-zinc-100'
          }`}
        >
          {children}
        </button>
      </PixelCard>
    </div>
  );
}

function SpinnerCard({ label }: { label: string }) {
  return (
    <div className="flex min-h-[280px] items-center justify-center rounded-lg border border-[#1A1A1A] bg-[#050505]">
      <div className="flex items-center gap-3 text-sm text-zinc-400">
        <RefreshCw className="h-4 w-4 animate-spin" />
        <span>{label}</span>
      </div>
    </div>
  );
}

function AlertCard({
  tone,
  title,
  message,
  action,
}: {
  tone: 'error' | 'warning' | 'success';
  title: string;
  message: string;
  action?: React.ReactNode;
}) {
  const toneClasses =
    tone === 'error'
      ? 'border-rose-500/20 bg-rose-500/10 text-rose-300'
      : tone === 'warning'
        ? 'border-amber-500/20 bg-amber-500/10 text-amber-300'
        : 'border-emerald-500/20 bg-emerald-500/10 text-emerald-300';
  return (
    <div className={`rounded-lg border p-5 ${toneClasses}`}>
      <div className="flex items-start gap-3">
        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold">{title}</div>
          <div className="mt-1 text-sm opacity-90">{message}</div>
          {action ? <div className="mt-4">{action}</div> : null}
        </div>
      </div>
    </div>
  );
}

function DiffViewer({ diff }: { diff: string }) {
  const lines = diff.split('\n');
  return (
    <div className="overflow-hidden rounded-lg border border-[#1A1A1A] bg-black">
      <div className="border-b border-[#1A1A1A] px-4 py-2 text-[11px] font-medium uppercase tracking-widest text-zinc-500">
        Unified Diff
      </div>
      <div className="max-h-[360px] overflow-auto px-4 py-3 font-mono text-[12px] leading-relaxed">
        {lines.map((line, index) => {
          let classes = 'text-zinc-400';
          if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('@@')) classes = 'text-indigo-300';
          else if (line.startsWith('+')) classes = 'text-emerald-400';
          else if (line.startsWith('-')) classes = 'text-rose-400';
          return (
            <div key={`${line}-${index}`} className={classes}>
              {line || ' '}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function inferBaseStage({
  setupOpen,
  approvalSent,
  remediationState,
  hasScanOutcome,
  hasVulnerabilities,
  scanState,
}: {
  setupOpen: boolean;
  approvalSent: boolean;
  remediationState: 'idle' | 'running' | 'waiting_decision' | 'waiting_approval' | 'completed' | 'error';
  hasScanOutcome: boolean;
  hasVulnerabilities: boolean;
  scanState: 'idle' | 'running' | 'completed' | 'error' | 'waiting_decision' | 'waiting_approval';
}): PipelineStageId {
  if (approvalSent || remediationState === 'completed') return 'pr_rescan';
  if (remediationState === 'waiting_decision') return 'approval';
  if (remediationState === 'waiting_approval') return 'approval';
  if (remediationState === 'running' || remediationState === 'error') return 'remediate_run';
  if (setupOpen && hasScanOutcome && hasVulnerabilities) return 'remediate_setup';
  if (hasScanOutcome || scanState === 'completed') return 'results';
  return 'scan';
}

export default function SecurityAnalysisPage() {
  const router = useRouter();
  const params = useParams();
  const projectId = params.projectId as string;

  const {
    getScanState,
    startScan,
    startRemediation,
    continueRemediationRound,
    pushCurrentRemediationChanges,
    approveRemediationPush,
    getRemediationState,
    getCachedResults,
    setCachedResults,
    resetRemediation,
    isAnyRemediating,
  } = useScan();
  const { apiKeys, setApiKey, selectedModels, setModel } = useLLM();

  const { state: scanState, messages: scanMessages, projectName: scanProjectName } = getScanState(projectId);
  const { state: remediationState, messages: remMessages } = getRemediationState(projectId);

  const [projectName, setProjectName] = useState<string>(scanProjectName || projectId);
  const [projectMeta, setProjectMeta] = useState<ProjectMeta | null>(null);
  const [loadingProject, setLoadingProject] = useState(true);

  const [vulnStatus, setVulnStatus] = useState<VulnStatus>('not_initiated');
  const [results, setResults] = useState<ScanResults | null>(null);
  const [scanStats, setScanStats] = useState<ScanStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingResults, setLoadingResults] = useState(false);
  const [scanActive, setScanActive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rerunInProgress, setRerunInProgress] = useState(false);

  const [setupOpen, setSetupOpen] = useState(false);
  const [githubToken, setGithubToken] = useState('');
  const [keyInput, setKeyInput] = useState('');
  const [modelInput, setModelInput] = useState('');
  const [approved, setApproved] = useState(false);
  const [locallyApproved, setLocallyApproved] = useState(false);
  const [prUrl, setPrUrl] = useState<string | null>(null);
  const [selectedDiffPath, setSelectedDiffPath] = useState<string | null>(null);
  const [kgExpanded, setKgExpanded] = useState(true);
  const [activeStage, setActiveStage] = useState<PipelineStageId>('scan');
  const [resultsTab, setResultsTab] = useState<'sca' | 'sast'>('sca');
  const [resultsQuery, setResultsQuery] = useState('');
  const [resultsSeverity, setResultsSeverity] = useState<'all' | 'critical' | 'high' | 'medium' | 'low'>('all');
  const [resultsLimit, setResultsLimit] = useState(100);
  const [lastResultsSyncAt, setLastResultsSyncAt] = useState<string | null>(null);

  const scanLogEndRef = useRef<HTMLDivElement>(null);
  const remediateLogEndRef = useRef<HTMLDivElement>(null);
  const fetchVersionRef = useRef(0);
  const previousBaseStageRef = useRef<PipelineStageId>('scan');

  useEffect(() => {
    setKeyInput(apiKeys[REMEDIATION_PROVIDER] || '');
    setModelInput(REMEDIATION_DEFAULT_MODEL);
  }, [apiKeys, selectedModels]);

  useEffect(() => {
    scanLogEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [scanActive, scanMessages.length]);

  useEffect(() => {
    remediateLogEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [remMessages.length]);

  useEffect(() => {
    let cancelled = false;
    async function fetchProject() {
      setLoadingProject(true);
      try {
        const res = await fetch(`/api/projects/${projectId}`, { cache: 'no-store' });
        if (!res.ok || cancelled) return;
        const data = await res.json();
        const project = data?.project;
        if (!project || cancelled) return;
        setProjectName(project.name || project.full_name || project.id || projectId);
        setProjectMeta({
          type: project.type === 'github' ? 'github' : 'local',
          installationId: project.installationId,
          owner: project.owner,
          repo: project.repo,
          branch: project.branch,
        });
      } catch {
        if (!cancelled) setProjectName(scanProjectName || projectId);
      } finally {
        if (!cancelled) setLoadingProject(false);
      }
    }
    void fetchProject();
    return () => {
      cancelled = true;
    };
  }, [projectId, scanProjectName]);

  const fetchPrUrl = useCallback(async () => {
    if (!projectId || projectMeta?.type !== 'github') {
      setPrUrl(null);
      return;
    }
    try {
      const response = await fetch('/api/pipeline/remediation-pr', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: projectId }),
      });
      if (!response.ok) return;
      const data = (await response.json()) as { pr_url?: string | null };
      setPrUrl(String(data.pr_url || '') || null);
    } catch {
      // ignore
    }
  }, [projectId, projectMeta?.type]);

  const fetchStatusAndResults = useCallback(
    async (options?: { trackError?: boolean }) => {
      const requestId = ++fetchVersionRef.current;
      try {
        const statusRes = await fetch(`/api/scan/status?project_id=${encodeURIComponent(projectId)}`, {
          cache: 'no-store',
          signal: AbortSignal.timeout(15_000),
        });
        const statusPayload = (await statusRes.json().catch(() => ({}))) as { status?: VulnStatus | 'running' | 'error'; detail?: string };
        if (requestId !== fetchVersionRef.current) return;

        if (statusPayload.status === 'running') {
          setScanActive(true);
          setLoading(false);
          setLoadingResults(false);
          return;
        }

        setScanActive(false);
        const rawStatus = statusPayload.status || 'not_initiated';
        if (rawStatus === 'error') {
          setLoading(false);
          setLoadingResults(false);
          setResults(null);
          setScanStats(null);
          setVulnStatus('not_initiated');
          setLastResultsSyncAt(null);
          if (options?.trackError) setError(statusPayload.detail || 'Unexpected scan status error');
          return;
        }

        const nextStatus = rawStatus as VulnStatus;
        setVulnStatus(nextStatus);

        if (nextStatus === 'not_found') {
          setResults(null);
          setScanStats(EMPTY_STATS);
          setCachedResults(projectId, { status: nextStatus, data: null });
          setLoading(false);
          setLoadingResults(false);
          setLastResultsSyncAt(new Date().toISOString());
          setError(null);
          return;
        }

        if (nextStatus === 'found') {
          setLoading(false);
          setLoadingResults(true);
          const resultsRes = await fetch(`/api/scan/results?project_id=${encodeURIComponent(projectId)}`, {
            cache: 'no-store',
            signal: AbortSignal.timeout(30_000),
          });
          if (!resultsRes.ok) {
            const body = (await resultsRes.json().catch(() => ({}))) as { error?: string };
            throw new Error(body.error || 'Failed to fetch scan results');
          }
          const resultsPayload = (await resultsRes.json()) as { data?: ScanResults };
          if (requestId !== fetchVersionRef.current) return;
          const nextResults = resultsPayload.data || { supply_chain: [], code_security: [] };
          setResults(nextResults);
          setScanStats(computeStats(nextResults));
          setCachedResults(projectId, { status: 'found', data: nextResults });
          setLoadingResults(false);
          setLastResultsSyncAt(new Date().toISOString());
          setError(null);
          return;
        }

        setResults(null);
        setScanStats(null);
        setLoading(false);
        setLoadingResults(false);
        setLastResultsSyncAt(null);
      } catch (fetchError) {
        if (requestId !== fetchVersionRef.current) return;
        setLoading(false);
        setLoadingResults(false);
        if (options?.trackError) setError(fetchError instanceof Error ? fetchError.message : 'Failed to load scan results');
      }
    },
    [projectId, setCachedResults],
  );

  useEffect(() => {
    if (!projectId) {
      setLoading(false);
      return;
    }
    const cached = getCachedResults(projectId);
    if (cached) {
      setVulnStatus(cached.status);
      if (cached.status === 'found' && cached.data) {
        const cachedResults = cached.data as ScanResults;
        setResults(cachedResults);
        setScanStats(computeStats(cachedResults));
        setLastResultsSyncAt(new Date().toISOString());
      } else if (cached.status === 'not_found') {
        setResults(null);
        setScanStats(EMPTY_STATS);
        setLastResultsSyncAt(new Date().toISOString());
      }
      setLoading(false);
      setLoadingResults(false);
      return;
    }
    setLoading(true);
    void fetchStatusAndResults();
  }, [fetchStatusAndResults, getCachedResults, projectId]);

  useEffect(() => {
    if (scanState !== 'running') return;
    fetchVersionRef.current += 1;
    setSetupOpen(false);
    setLocallyApproved(false);
    setApproved(false);
    setPrUrl(null);
    setError(null);
    setResults(null);
    setScanStats(null);
    setVulnStatus('not_initiated');
    setLoading(false);
    setLoadingResults(false);
    setScanActive(false);
  }, [scanState]);

  useEffect(() => {
    if (!scanActive || !projectId || scanState === 'running') return;
    const intervalId = window.setInterval(() => {
      void fetchStatusAndResults();
    }, 4000);
    return () => window.clearInterval(intervalId);
  }, [fetchStatusAndResults, projectId, scanActive, scanState]);

  useEffect(() => {
    if (!projectId || scanState !== 'completed') return;
    const cached = getCachedResults(projectId);
    if (cached) return;
    setLoading(true);
    setError(null);
    void fetchStatusAndResults({ trackError: true });
  }, [fetchStatusAndResults, getCachedResults, projectId, scanState]);

  useEffect(() => {
    if (!projectId || remediationState !== 'completed') return;
    fetchVersionRef.current += 1;
    setResults(null);
    setScanStats(null);
    setVulnStatus('not_initiated');
    setLoading(true);
    setLoadingResults(false);
    setSetupOpen(false);
    void fetchStatusAndResults({ trackError: true });
    void fetchPrUrl();
  }, [fetchPrUrl, fetchStatusAndResults, projectId, remediationState]);

  const approvalSent = useMemo(() => {
    if (locallyApproved || remediationState === 'completed') return true;
    return remMessages.some((message) => typeof message.content === 'string' && message.content.includes('Final approval received. Persisting approved remediation changes'));
  }, [locallyApproved, remMessages, remediationState]);

  const prUrlFromMessages = useMemo(() => {
    const message = [...remMessages].reverse().find((item) => item.type === 'success' && item.content.startsWith('Remediation PR created: '));
    if (!message) return null;
    return message.content.replace('Remediation PR created: ', '').trim() || null;
  }, [remMessages]);

  useEffect(() => {
    if (prUrlFromMessages) setPrUrl(prUrlFromMessages);
  }, [prUrlFromMessages]);

  useEffect(() => {
    if (projectMeta?.type !== 'github' || !approvalSent || prUrl) return;
    void fetchPrUrl();
    const intervalId = window.setInterval(() => {
      void fetchPrUrl();
    }, 4000);
    return () => window.clearInterval(intervalId);
  }, [approvalSent, fetchPrUrl, prUrl, projectMeta?.type]);

  const changedFiles = useMemo(() => {
    const byPath = new Map<string, ChangedFileEntry>();
    for (const message of remMessages) {
      if (message.type !== 'changed_files') continue;
      try {
        const payload = JSON.parse(message.content) as ChangedFileEntry[];
        for (const item of payload) {
          if (!item?.path) continue;
          byPath.set(item.path, { path: item.path, reason: item.reason, diff: item.diff });
        }
      } catch {
        // ignore malformed payload
      }
    }
    return Array.from(byPath.values());
  }, [remMessages]);

  useEffect(() => {
    if (!selectedDiffPath && changedFiles.length > 0) setSelectedDiffPath(changedFiles[0].path);
    if (selectedDiffPath && changedFiles.every((item) => item.path !== selectedDiffPath)) {
      setSelectedDiffPath(changedFiles[0]?.path || null);
    }
  }, [changedFiles, selectedDiffPath]);

  const latestKgResult = useMemo(() => {
    const message = [...remMessages].reverse().find((item) => item.type === 'kg_result');
    if (!message) return null;
    try {
      return JSON.parse(message.content) as KgResultPayload;
    } catch {
      return null;
    }
  }, [remMessages]);

  const hasScanOutcome = useMemo(() => vulnStatus !== 'not_initiated' || scanState === 'completed' || results !== null || loadingResults, [loadingResults, results, scanState, vulnStatus]);
  const hasVulnerabilities = useMemo(() => {
    if (!results) return vulnStatus === 'found';
    return (results.supply_chain?.length || 0) > 0 || (results.code_security?.length || 0) > 0;
  }, [results, vulnStatus]);
  const flatCodeFindings = useMemo(() => flattenCodeSecurity(results?.code_security || []), [results]);
  const normalizedResultsQuery = useMemo(() => resultsQuery.trim().toLowerCase(), [resultsQuery]);
  const filteredSupplyChain = useMemo(() => {
    const entries = results?.supply_chain || [];
    return entries.filter((item) => {
      const severityMatches = resultsSeverity === 'all' || String(item.severity || '').toLowerCase() === resultsSeverity;
      if (!severityMatches) return false;
      if (!normalizedResultsQuery) return true;
      const haystack = [item.name, item.cve_id, item.version, item.fix_version].filter(Boolean).join(' ').toLowerCase();
      return haystack.includes(normalizedResultsQuery);
    });
  }, [normalizedResultsQuery, results?.supply_chain, resultsSeverity]);
  const filteredCodeFindings = useMemo(() => {
    return flatCodeFindings.filter((item) => {
      const severityMatches = resultsSeverity === 'all' || String(item.severity || '').toLowerCase() === resultsSeverity;
      if (!severityMatches) return false;
      if (!normalizedResultsQuery) return true;
      const haystack = [item.location, item.issue, item.description].filter(Boolean).join(' ').toLowerCase();
      return haystack.includes(normalizedResultsQuery);
    });
  }, [flatCodeFindings, normalizedResultsQuery, resultsSeverity]);
  const visibleSupplyChain = useMemo(() => filteredSupplyChain.slice(0, resultsLimit), [filteredSupplyChain, resultsLimit]);
  const visibleCodeFindings = useMemo(() => filteredCodeFindings.slice(0, resultsLimit), [filteredCodeFindings, resultsLimit]);
  const remediatingThisProject = remediationState === 'running';
  const remediationFinished = remediationState === 'completed';
  const canLaunchRemediation = hasVulnerabilities && scanState !== 'running' && remediationState === 'idle' && !isAnyRemediating;

  useEffect(() => {
    setResultsLimit(100);
  }, [resultsQuery, resultsSeverity, resultsTab, results]);

  useEffect(() => {
    if (activeStage !== 'results' || !hasScanOutcome || scanState === 'running') return;
    const intervalId = window.setInterval(() => {
      void fetchStatusAndResults();
    }, RESULTS_HEARTBEAT_MS);
    return () => window.clearInterval(intervalId);
  }, [activeStage, fetchStatusAndResults, hasScanOutcome, scanState]);

  const baseStage = inferBaseStage({
    setupOpen,
    approvalSent,
    remediationState,
    hasScanOutcome,
    hasVulnerabilities,
    scanState,
  });
  const maxUnlockedIndex = STAGE_INDEX[baseStage];

  useEffect(() => {
    const previousBase = previousBaseStageRef.current;
    if (activeStage === previousBase || STAGE_INDEX[activeStage] > maxUnlockedIndex) setActiveStage(baseStage);
    previousBaseStageRef.current = baseStage;
  }, [activeStage, baseStage, maxUnlockedIndex]);

  const getStageStatus = useCallback(
    (stageId: PipelineStageId) => {
      const stageIndex = STAGE_INDEX[stageId];
      if (stageIndex > maxUnlockedIndex) return 'locked';
      if (stageId === activeStage) return 'active';
      return 'completed';
    },
    [activeStage, maxUnlockedIndex],
  );

  const progressPercentage = useMemo(() => (remediationFinished ? 100 : Math.round(((maxUnlockedIndex + 1) / SIDEBAR_STAGES.length) * 100)), [maxUnlockedIndex, remediationFinished]);
  const handleStageClick = useCallback((stageId: PipelineStageId) => {
    if (STAGE_INDEX[stageId] > maxUnlockedIndex) return;
    setActiveStage(stageId);
  }, [maxUnlockedIndex]);

  const handleStartScan = useCallback(async () => {
    if (!projectMeta || loadingProject) return;
    if (scanState === 'running' || rerunInProgress) return;
    setRerunInProgress(true);
    setError(null);
    try {
      const validateRes = await fetch('/api/scan/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project_id: projectId,
          project_name: projectName || projectId,
          project_type: projectMeta.type,
          installation_id: projectMeta.installationId,
          owner: projectMeta.owner,
          repo: projectMeta.repo,
          scan_type: 'all',
        }),
      });
      if (!validateRes.ok) {
        const body = (await validateRes.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error || 'Failed to validate scan');
      }
      await startScan(projectId, projectName || projectId);
      resetRemediation(projectId);
      setActiveStage('scan');
    } catch (scanError) {
      setError(scanError instanceof Error ? scanError.message : 'Failed to start scan');
    } finally {
      setRerunInProgress(false);
    }
  }, [loadingProject, projectId, projectMeta, projectName, rerunInProgress, resetRemediation, scanState, startScan]);

  const handleStartRemediation = useCallback(async () => {
    const trimmedKey = keyInput.trim();
    const trimmedModel = modelInput.trim() || REMEDIATION_DEFAULT_MODEL;
    const trimmedToken = githubToken.trim();

    if (trimmedKey && trimmedKey !== apiKeys[REMEDIATION_PROVIDER]) setApiKey(REMEDIATION_PROVIDER, trimmedKey);
    if (trimmedModel && trimmedModel !== selectedModels[REMEDIATION_PROVIDER]) setModel(REMEDIATION_PROVIDER, trimmedModel);

    setError(null);
    setSetupOpen(false);
    setLocallyApproved(false);
    setApproved(false);
    setPrUrl(null);
    setActiveStage('remediate_run');

    try {
      await startRemediation(
        projectId,
        undefined,
        trimmedToken || undefined,
        REMEDIATION_PROVIDER,
        trimmedKey || apiKeys[REMEDIATION_PROVIDER] || undefined,
        trimmedModel,
      );
      setGithubToken('');
    } catch (remediationError) {
      setError(remediationError instanceof Error ? remediationError.message : 'Failed to start remediation');
    }
  }, [apiKeys, githubToken, keyInput, modelInput, projectId, selectedModels, setApiKey, setModel, startRemediation]);

  const handleContinueRound = useCallback(() => {
    continueRemediationRound(projectId);
    setActiveStage('remediate_run');
  }, [continueRemediationRound, projectId]);

  const handlePushCurrentFixes = useCallback(() => {
    pushCurrentRemediationChanges(projectId);
  }, [projectId, pushCurrentRemediationChanges]);

  const handleApproveAndPush = useCallback(() => {
    setLocallyApproved(true);
    approveRemediationPush(projectId);
  }, [approveRemediationPush, projectId]);

  const selectedDiff = useMemo(() => changedFiles.find((item) => item.path === selectedDiffPath) || changedFiles[0] || null, [changedFiles, selectedDiffPath]);

  const renderScanView = () => {
    const scanRunning = scanState === 'running' || scanActive;
    return (
      <div className="relative z-10 mx-auto flex min-h-full w-full max-w-5xl animate-fade-in flex-col space-y-6 p-8">
        <div className="mb-6 border-b border-[#1A1A1A] pb-6">
          <h1 className="mb-1 text-2xl font-semibold text-zinc-100">Codebase Security Scan</h1>
          <p className="text-sm text-zinc-400">Execute comprehensive SAST and SCA engines over {projectName}.</p>
        </div>

        {error && scanState !== 'running' ? <AlertCard tone="error" title="Scan Error" message={error} /> : null}

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          <div className="lg:col-span-2">
            <BorderGlow backgroundColor="#050505" colors={['#6366f1', '#050505']} glowColor="250 80 50" borderRadius={8} className="flex h-[420px] flex-col overflow-hidden border border-[#1A1A1A] shadow-xl">
              <div className="flex items-center justify-between border-b border-[#1A1A1A] bg-[#000000] px-4 py-2.5">
                <div className="flex items-center gap-2 text-xs font-mono text-zinc-400">
                  <TerminalSquare className="h-4 w-4" />
                  <span>scanner-output</span>
                </div>
                {scanRunning ? (
                  <span className="relative flex h-2 w-2">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-indigo-400 opacity-75" />
                    <span className="relative inline-flex h-2 w-2 rounded-full bg-indigo-500" />
                  </span>
                ) : null}
              </div>
              <div className="custom-scrollbar flex-1 overflow-y-auto bg-[#000000] p-6 font-mono text-[13px] leading-relaxed">
                {scanMessages.length === 0 && !scanRunning ? <p className="text-zinc-600">Scan not initiated. Awaiting command...</p> : null}
                {scanMessages.map((message, index) => {
                  const toneClass =
                    message.type === 'success'
                      ? 'text-emerald-400 font-medium'
                      : message.type === 'error'
                        ? 'text-rose-400'
                        : message.type === 'phase'
                          ? 'text-indigo-300'
                          : 'text-zinc-300';
                  return (
                    <div key={`${message.timestamp}-${index}`} className="mb-1 flex gap-4 animate-fade-in">
                      <span className="shrink-0 text-zinc-600">{String(index + 1).padStart(2, '0')}</span>
                      <span className={toneClass}>{message.content}</span>
                    </div>
                  );
                })}
                {scanRunning ? <div className="mt-2 animate-pulse text-zinc-600">_</div> : null}
                <div ref={scanLogEndRef} />
              </div>
            </BorderGlow>
          </div>

          <div className="flex flex-col space-y-6">
            <BorderGlow backgroundColor="#050505" colors={['#27272a', '#050505']} borderRadius={8} className="flex-1 border border-[#1A1A1A] p-6 shadow-lg">
              <h3 className="mb-4 text-[10px] font-bold uppercase tracking-widest text-zinc-500">Scan Configuration</h3>
              <div className="space-y-4 text-sm">
                <div>
                  <span className="mb-1 block text-zinc-500">Target</span>
                  <span className="inline-flex rounded bg-[#111111] px-2 py-1 font-mono text-zinc-200">{projectMeta?.repo || projectName}</span>
                </div>
                <div>
                  <span className="mb-1 block text-zinc-500">Source</span>
                  <span className="text-zinc-200">{projectMeta?.type === 'github' ? 'GitHub repository' : 'Local upload'}</span>
                </div>
                <div>
                  <span className="mb-1 block text-zinc-500">Engines</span>
                  <span className="text-zinc-200">Bearer (SAST), Syft/Grype (SCA)</span>
                </div>
              </div>
            </BorderGlow>

            <RunButton onClick={() => void handleStartScan()} disabled={scanRunning || loadingProject || rerunInProgress}>
              <Play className="h-4 w-4" />
              {scanRunning ? 'Running...' : hasScanOutcome ? 'Run New Validation Scan' : 'Start Validation Scan'}
            </RunButton>
          </div>
        </div>
      </div>
    );
  };

  const renderResultsView = () => {
    if (loading || loadingResults) {
      return (
        <div className="relative z-10 mx-auto flex min-h-full w-full max-w-5xl animate-fade-in flex-col space-y-6 p-8">
          <div>
            <h1 className="mb-1 text-2xl font-semibold text-zinc-100">Vulnerability Results</h1>
            <p className="text-sm text-zinc-400">Loading latest findings and verification data.</p>
          </div>
          <SpinnerCard label="Loading scan results..." />
        </div>
      );
    }

    if (error && !results) {
      return (
        <div className="relative z-10 mx-auto flex min-h-full w-full max-w-5xl animate-fade-in flex-col space-y-6 p-8">
          <div>
            <h1 className="mb-1 text-2xl font-semibold text-zinc-100">Vulnerability Results</h1>
            <p className="text-sm text-zinc-400">The latest scan could not be loaded.</p>
          </div>
          <AlertCard tone="error" title="Results Unavailable" message={error} action={<RunButton className="max-w-[260px]" onClick={() => void fetchStatusAndResults({ trackError: true })}>Retry Loading Results</RunButton>} />
        </div>
      );
    }

    const stats = scanStats || EMPTY_STATS;
    const cleanState = !hasVulnerabilities;

    return (
      <div className="relative z-10 mx-auto flex min-h-full w-full max-w-5xl animate-fade-in flex-col space-y-6 p-8">
        <div>
          <h1 className="mb-1 text-2xl font-semibold text-zinc-100">Vulnerability Results</h1>
          <p className="text-sm text-zinc-400">Total findings across Static Analysis and Supply Chain.</p>
        </div>

        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <BorderGlow backgroundColor="#050505" colors={['#27272a', '#050505']} borderRadius={8} className="border border-[#1A1A1A] p-5"><h3 className="mb-2 text-[10px] font-bold uppercase tracking-widest text-zinc-500">Total Findings</h3><div className="text-3xl font-bold text-zinc-100">{stats.total}</div></BorderGlow>
          <BorderGlow backgroundColor="#050505" colors={['#f43f5e', '#050505']} glowColor="340 80 50" borderRadius={8} className="border border-[#1A1A1A] p-5"><h3 className="mb-2 text-[10px] font-bold uppercase tracking-widest text-rose-500">Critical</h3><div className="text-3xl font-bold text-rose-500">{stats.critical}</div></BorderGlow>
          <BorderGlow backgroundColor="#050505" colors={['#f59e0b', '#050505']} glowColor="35 100 50" borderRadius={8} className="border border-[#1A1A1A] p-5"><h3 className="mb-2 text-[10px] font-bold uppercase tracking-widest text-amber-500">High</h3><div className="text-3xl font-bold text-amber-500">{stats.high}</div></BorderGlow>
          <BorderGlow backgroundColor="#050505" colors={['#10b981', '#050505']} glowColor="150 80 50" borderRadius={8} className="border border-[#1A1A1A] p-5"><h3 className="mb-2 text-[10px] font-bold uppercase tracking-widest text-emerald-500">Auto-Fixable</h3><div className="text-3xl font-bold text-emerald-500">{stats.autoFixable}</div></BorderGlow>
        </div>

        {cleanState ? (
          <AlertCard
            tone="success"
            title="No Vulnerabilities Detected"
            message="This project passed the current security scan. Continue to deployment or return to the dashboard."
            action={(
              <div className="flex flex-wrap gap-3">
                <RunButton className="max-w-[260px]" onClick={() => router.push(`/dashboard/deploy?projectId=${encodeURIComponent(projectId)}&entry=card`)}>
                  Continue to Delivery
                </RunButton>
                <button
                  type="button"
                  onClick={() => router.push('/dashboard')}
                  className="inline-flex items-center justify-center rounded-md border border-[#262626] bg-[#050505] px-4 py-3 text-sm font-medium text-zinc-200 transition-colors hover:bg-[#111111]"
                >
                  Return to Dashboard
                </button>
              </div>
            )}
          />
        ) : (
          <>
            <div className="overflow-hidden rounded-xl border border-[#1A1A1A] bg-[#050505] shadow-xl">
              <div className="flex flex-wrap items-center justify-between gap-4 border-b border-[#1A1A1A] bg-[#000000] px-6 py-4">
                <div>
                  <h3 className="text-base font-semibold text-zinc-100">Live Findings Explorer</h3>
                  <p className="mt-1 text-xs text-zinc-500">
                    {lastResultsSyncAt
                      ? `Synced ${new Date(lastResultsSyncAt).toLocaleTimeString()} from live scan results`
                      : 'Showing the latest live scan payload'}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setResultsTab('sca')}
                    className={`rounded-md px-3 py-2 text-xs font-semibold transition-colors ${resultsTab === 'sca' ? 'bg-indigo-500/15 text-indigo-300' : 'bg-[#111111] text-zinc-400 hover:text-zinc-200'}`}
                  >
                    Supply Chain ({filteredSupplyChain.length})
                  </button>
                  <button
                    type="button"
                    onClick={() => setResultsTab('sast')}
                    className={`rounded-md px-3 py-2 text-xs font-semibold transition-colors ${resultsTab === 'sast' ? 'bg-indigo-500/15 text-indigo-300' : 'bg-[#111111] text-zinc-400 hover:text-zinc-200'}`}
                  >
                    Code Security ({filteredCodeFindings.length})
                  </button>
                  <button
                    type="button"
                    onClick={() => void fetchStatusAndResults({ trackError: true })}
                    className="inline-flex items-center gap-2 rounded-md border border-[#262626] bg-[#111111] px-3 py-2 text-xs font-medium text-zinc-300 transition-colors hover:bg-[#1A1A1A]"
                  >
                    <RefreshCw className="h-3.5 w-3.5" />
                    Refresh
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-1 gap-3 border-b border-[#1A1A1A] px-6 py-4 md:grid-cols-[minmax(0,1fr)_180px]">
                <input
                  value={resultsQuery}
                  onChange={(event) => setResultsQuery(event.target.value)}
                  placeholder={resultsTab === 'sca' ? 'Search package, CVE, version, fix version...' : 'Search file, CWE, issue, description...'}
                  className="w-full rounded-md border border-[#262626] bg-[#000000] px-4 py-2.5 text-sm text-zinc-200 outline-none transition-colors focus:border-indigo-500/50"
                />
                <select
                  value={resultsSeverity}
                  onChange={(event) => setResultsSeverity(event.target.value as typeof resultsSeverity)}
                  className="w-full rounded-md border border-[#262626] bg-[#000000] px-4 py-2.5 text-sm text-zinc-200 outline-none transition-colors focus:border-indigo-500/50"
                >
                  <option value="all">All severities</option>
                  <option value="critical">Critical</option>
                  <option value="high">High</option>
                  <option value="medium">Medium</option>
                  <option value="low">Low</option>
                </select>
              </div>

              {resultsTab === 'sca' ? (
                <div className="custom-scrollbar max-h-[55vh] overflow-auto">
                  <table className="w-full border-collapse text-left text-sm">
                    <thead className="sticky top-0 z-10 bg-[#050505]">
                      <tr className="border-b border-[#1A1A1A]">
                        <th className="px-4 py-3 text-[10px] font-bold uppercase tracking-wider text-zinc-500">Package</th>
                        <th className="px-4 py-3 text-[10px] font-bold uppercase tracking-wider text-zinc-500">Version</th>
                        <th className="px-4 py-3 text-[10px] font-bold uppercase tracking-wider text-zinc-500">CVE</th>
                        <th className="px-4 py-3 text-[10px] font-bold uppercase tracking-wider text-zinc-500">Fix Version</th>
                        <th className="px-4 py-3 text-[10px] font-bold uppercase tracking-wider text-zinc-500">Severity</th>
                      </tr>
                    </thead>
                    <tbody>
                      {visibleSupplyChain.map((item, index) => (
                        <tr key={`${item.cve_id}-${item.name}-${index}`} className="border-b border-[#1A1A1A] transition-colors hover:bg-[#111111]">
                          <td className="px-4 py-3 font-mono text-zinc-300">{item.name}</td>
                          <td className="px-4 py-3 font-mono text-xs text-zinc-400">{item.version || '-'}</td>
                          <td className="px-4 py-3 text-xs text-zinc-400">{item.cve_id || '-'}</td>
                          <td className="px-4 py-3 text-xs text-zinc-400">{item.fix_version || 'No fix published'}</td>
                          <td className="px-4 py-3"><span className={`rounded px-2 py-0.5 text-[10px] font-bold uppercase ${getSeverityBadgeClasses(item.severity)}`}>{item.severity}</span></td>
                        </tr>
                      ))}
                      {visibleSupplyChain.length === 0 ? (
                        <tr>
                          <td colSpan={5} className="px-4 py-8 text-center text-sm text-zinc-500">No supply-chain findings match the current filters.</td>
                        </tr>
                      ) : null}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="custom-scrollbar max-h-[55vh] overflow-auto">
                  <table className="w-full border-collapse text-left text-sm">
                    <thead className="sticky top-0 z-10 bg-[#050505]">
                      <tr className="border-b border-[#1A1A1A]">
                        <th className="px-4 py-3 text-[10px] font-bold uppercase tracking-wider text-zinc-500">Location</th>
                        <th className="px-4 py-3 text-[10px] font-bold uppercase tracking-wider text-zinc-500">Issue</th>
                        <th className="px-4 py-3 text-[10px] font-bold uppercase tracking-wider text-zinc-500">Description</th>
                        <th className="px-4 py-3 text-[10px] font-bold uppercase tracking-wider text-zinc-500">Severity</th>
                      </tr>
                    </thead>
                    <tbody>
                      {visibleCodeFindings.map((item, index) => (
                        <tr key={`${item.location}-${item.issue}-${index}`} className="border-b border-[#1A1A1A] transition-colors hover:bg-[#111111]">
                          <td className="px-4 py-3 font-mono text-xs text-zinc-300">{item.location}</td>
                          <td className="px-4 py-3 text-xs text-zinc-400">{item.issue}</td>
                          <td className="px-4 py-3 text-xs text-zinc-400">{item.description || '-'}</td>
                          <td className="px-4 py-3"><span className={`rounded px-2 py-0.5 text-[10px] font-bold uppercase ${getSeverityBadgeClasses(item.severity)}`}>{item.severity}</span></td>
                        </tr>
                      ))}
                      {visibleCodeFindings.length === 0 ? (
                        <tr>
                          <td colSpan={4} className="px-4 py-8 text-center text-sm text-zinc-500">No code-security findings match the current filters.</td>
                        </tr>
                      ) : null}
                    </tbody>
                  </table>
                </div>
              )}

              <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[#1A1A1A] px-6 py-4 text-xs text-zinc-500">
                <div>
                  {resultsTab === 'sca'
                    ? `Showing ${visibleSupplyChain.length} of ${filteredSupplyChain.length} supply-chain findings`
                    : `Showing ${visibleCodeFindings.length} of ${filteredCodeFindings.length} code-security findings`}
                </div>
                {((resultsTab === 'sca' && visibleSupplyChain.length < filteredSupplyChain.length) || (resultsTab === 'sast' && visibleCodeFindings.length < filteredCodeFindings.length)) ? (
                  <button
                    type="button"
                    onClick={() => setResultsLimit((value) => value + 100)}
                    className="rounded-md border border-[#262626] bg-[#111111] px-3 py-2 text-xs font-medium text-zinc-300 transition-colors hover:bg-[#1A1A1A]"
                  >
                    Load 100 More
                  </button>
                ) : null}
              </div>
            </div>

            {canLaunchRemediation ? (
              <PixelCard
                noFocus
                colors="#4338ca,#312e81,#18181b"
                gap={5}
                speed={28}
                className="mt-6 overflow-hidden rounded-xl border border-[#1A1A1A] bg-[#050505] shadow-xl"
              >
                <div className="relative z-10 flex items-center justify-between bg-gradient-to-r from-indigo-500/10 to-transparent p-6">
                  <div>
                    <h3 className="mb-1 flex items-center gap-2 text-base font-bold text-indigo-400"><Sparkles className="h-4 w-4" />AI Auto-Remediation Available</h3>
                    <p className="text-[13px] text-zinc-400">Deploy the remediation agent to patch these vulnerabilities, create a PR, and verify with a re-scan.</p>
                  </div>
                  <div className="w-[220px]"><RunButton onClick={() => { setSetupOpen(true); setActiveStage('remediate_setup'); }}>Setup AI Agent</RunButton></div>
                </div>
              </PixelCard>
            ) : null}
          </>
        )}
      </div>
    );
  };

  const renderRemediateSetupView = () => (
    <div className="relative z-10 mx-auto flex min-h-full w-full max-w-4xl animate-fade-in flex-col space-y-6 p-8">
      <div className="mb-6 mt-4 border-b border-[#1A1A1A] pb-6">
        <h1 className="mb-2 text-2xl font-semibold text-zinc-100">Configure AI Agent</h1>
        <p className="text-sm text-zinc-400">Initialize the remediation agent to automatically fix identified vulnerabilities.</p>
      </div>
      {error && remediationState === 'error' ? <AlertCard tone="error" title="Remediation Error" message={error} /> : null}
        <div className="space-y-6 rounded-lg border border-[#1A1A1A] bg-[#050505] p-6 shadow-xl">
        <div className="space-y-4">
          <div>
            <label className="mb-2 block text-[10px] font-bold uppercase text-zinc-500">Remediation Agent</label>
            <div className="rounded-md border border-orange-500/20 bg-orange-500/10 px-4 py-3">
              <div className="text-sm font-semibold text-orange-200">Claude Agent SDK</div>
              <p className="mt-1 text-xs text-orange-100/70">This remediation workflow is locked to Claude only.</p>
            </div>
          </div>
          <div>
            <label className="mb-2 block text-[10px] font-bold uppercase text-zinc-500">Claude Model</label>
            <input value={modelInput} onChange={(event) => setModelInput(event.target.value)} placeholder={REMEDIATION_DEFAULT_MODEL} className="w-full rounded-md border border-[#262626] bg-[#000000] px-4 py-2.5 font-mono text-sm text-zinc-200 outline-none transition-colors focus:border-indigo-500/50" />
          </div>
          <div>
            <label className="mb-2 block text-[10px] font-bold uppercase text-zinc-500">Anthropic API Key</label>
            <input type="password" value={keyInput} onChange={(event) => setKeyInput(event.target.value)} placeholder={REMEDIATION_PROVIDER_CONFIG.placeholder || 'API key'} className="w-full rounded-md border border-[#262626] bg-[#000000] px-4 py-2.5 font-mono text-sm text-zinc-200 outline-none transition-colors focus:border-indigo-500/50" />
          </div>
          <div className="border-t border-[#1A1A1A] pt-4">
            <label className="mb-2 block text-[10px] font-bold uppercase text-zinc-500">GitHub PAT (Optional)</label>
            <input type="password" value={githubToken} onChange={(event) => setGithubToken(event.target.value)} placeholder="ghp_..." className="w-full rounded-md border border-[#262626] bg-[#000000] px-4 py-2.5 font-mono text-sm text-zinc-200 outline-none transition-colors focus:border-indigo-500/50" />
            <p className="mt-2 text-[11px] text-zinc-500">Required only for pushing the fix branch automatically. Not stored persistently.</p>
          </div>
        </div>
        <div className="pt-6">
          <RunButton onClick={() => void handleStartRemediation()} disabled={remediatingThisProject || (isAnyRemediating && remediationState === 'idle')}>
            <Sparkles className="h-4 w-4" />
            <span>Start Remediation Engine</span>
          </RunButton>
        </div>
      </div>
    </div>
  );

  const renderRemediateRunView = () => (
    <div className="relative z-10 mx-auto flex min-h-full w-full max-w-5xl animate-fade-in flex-col space-y-6 p-8">
      <div className="mb-2 flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-zinc-100">{remediatingThisProject ? 'Agent Executing...' : remediationState === 'error' ? 'Execution Failed' : 'Execution Paused'}</h1>
        {remediatingThisProject ? <span className="relative flex h-2 w-2"><span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-indigo-400 opacity-75" /><span className="relative inline-flex h-2 w-2 rounded-full bg-indigo-500" /></span> : null}
      </div>
      {remediationState === 'error' ? <AlertCard tone="error" title="Remediation Failed" message={[...remMessages].reverse().find((message) => message.type === 'error')?.content || error || 'The remediation run failed.'} /> : null}

      <BorderGlow backgroundColor="#000000" colors={['#a855f7', '#000000']} glowColor="280 80 50" borderRadius={8} className="flex h-[500px] flex-col overflow-hidden border border-[#1A1A1A] shadow-2xl">
        <div className="flex items-center justify-between border-b border-[#1A1A1A] bg-[#0A0A0A] px-5 py-4">
          <div className="flex items-center gap-2"><Bot className="h-4 w-4 text-purple-400" /><h3 className="text-sm font-semibold text-zinc-200">Agent Terminal</h3></div>
        </div>
        <div className="custom-scrollbar flex-1 overflow-y-auto bg-[#000000] p-6 font-mono text-[13px] leading-relaxed">
          {remMessages.map((message, index) => {
            const logText = String(message.content || '');
            const toneClass = message.type === 'kg_phase' ? 'text-violet-300' : logText.includes('[waiting_approval]') || logText.includes('[waiting_decision]') || message.type === 'warning' ? 'text-amber-400 font-medium' : message.type === 'success' ? 'text-emerald-400' : message.type === 'error' ? 'text-rose-400' : 'text-zinc-400';
            return <div key={`${message.timestamp}-${index}`} className="mb-2 flex gap-4 animate-fade-in"><span className="shrink-0 text-zinc-600">{String(index + 1).padStart(2, '0')}</span><span className={toneClass}>{logText}</span></div>;
          })}
          {remediatingThisProject ? <div className="mt-2 animate-pulse text-zinc-600">_</div> : null}
          <div ref={remediateLogEndRef} />
        </div>
      </BorderGlow>

      {latestKgResult?.context ? (
        <BorderGlow backgroundColor="#050505" colors={['#6d28d9', '#050505']} glowColor="280 80 50" borderRadius={8} className="overflow-hidden border border-violet-500/20 shadow-lg">
          <button type="button" onClick={() => setKgExpanded((value) => !value)} className="flex w-full items-center justify-between border-b border-violet-500/15 bg-violet-500/5 px-5 py-4 text-left">
            <div><div className="text-xs font-semibold uppercase tracking-widest text-violet-300">Knowledge Graph Intelligence</div><div className="mt-1 text-[12px] text-zinc-500">{latestKgResult.context.total_components} components analysed · {latestKgResult.context.queries?.length || 0} KG queries</div></div>
            {kgExpanded ? <ChevronDown className="h-4 w-4 text-zinc-500" /> : <ChevronRight className="h-4 w-4 text-zinc-500" />}
          </button>
          {kgExpanded ? (
            <div className="space-y-4 p-5">
              {latestKgResult.business_logic_summary ? <div><div className="mb-2 text-[10px] font-bold uppercase tracking-widest text-zinc-500">Business Context</div><div className="rounded-lg border border-[#1A1A1A] bg-black/50 p-4 text-sm leading-relaxed text-zinc-300">{latestKgResult.business_logic_summary}</div></div> : null}
              {latestKgResult.vulnerability_summary ? <div><div className="mb-2 text-[10px] font-bold uppercase tracking-widest text-zinc-500">Vulnerability Summary</div><div className="custom-scrollbar max-h-[260px] overflow-y-auto rounded-lg border border-[#1A1A1A] bg-black/50 p-4 font-mono text-[12px] leading-relaxed text-zinc-300"><pre className="whitespace-pre-wrap">{latestKgResult.vulnerability_summary}</pre></div></div> : null}
            </div>
          ) : null}
        </BorderGlow>
      ) : null}
    </div>
  );

  const renderApprovalView = () => {
    const waitingForDecision = remediationState === 'waiting_decision';

    return (
      <div className="relative z-10 mx-auto flex min-h-full w-full max-w-4xl animate-fade-in flex-col space-y-6 p-8">
        <div className="mb-6 mt-4 flex items-center justify-between border-b border-[#1A1A1A] pb-6">
          <div>
            <h1 className="mb-2 text-2xl font-semibold text-zinc-100">{waitingForDecision ? 'Choose Next Step' : 'Approve & Push Fixes'}</h1>
            <p className="text-sm text-zinc-400">
              {waitingForDecision
                ? 'The first remediation round finished. Review the patch set and decide whether to push these fixes or run one more remediation round.'
                : 'Review the current patch set one last time, then approve persistence, PR creation, and the verification re-scan.'}
            </p>
          </div>
          <div className="inline-flex items-center gap-2 rounded border border-amber-500/20 bg-amber-500/10 px-3 py-1 text-[11px] font-bold uppercase text-amber-500">
            <CheckCircle2 className="h-3.5 w-3.5" />
            {waitingForDecision ? 'Decision Required' : 'Final Approval'}
          </div>
        </div>

        <div className="overflow-hidden rounded-lg border border-[#1A1A1A] bg-[#050505] shadow-xl">
          <div className="flex items-center justify-between border-b border-[#1A1A1A] bg-[#000000] p-4"><span className="text-sm font-semibold text-zinc-200">Changed Files</span><span className="text-xs font-mono text-zinc-500">{changedFiles.length} modification{changedFiles.length === 1 ? '' : 's'}</span></div>
          <div className="p-0">
            {changedFiles.length === 0 ? (
              <div className="p-4 text-sm text-zinc-500">No changed file metadata is available for this remediation run.</div>
            ) : changedFiles.map((item) => (
              <div key={item.path} className="flex items-center justify-between border-b border-[#1A1A1A] p-4 transition-colors last:border-b-0 hover:bg-[#111111]">
                <div className="flex min-w-0 items-center gap-3">
                  {item.path.endsWith('.json') ? <FileJson className="h-4 w-4 text-zinc-400" /> : <FileCode2 className="h-4 w-4 text-zinc-400" />}
                  <div className="min-w-0"><span className="block truncate text-sm font-mono text-zinc-300">{item.path}</span>{item.reason ? <span className="mt-0.5 block text-xs text-zinc-500">{item.reason}</span> : null}</div>
                </div>
                <button type="button" onClick={() => setSelectedDiffPath(item.path)} className="flex items-center gap-2 rounded bg-[#1A1A1A] px-3 py-1 text-xs font-medium text-zinc-300 transition-colors hover:bg-[#262626]"><Eye className="h-3 w-3" />View Diff</button>
              </div>
            ))}
          </div>
        </div>

        {selectedDiff ? <div className="space-y-3"><div className="flex items-center justify-between"><div className="text-sm font-semibold text-zinc-200">{selectedDiff.path}</div>{selectedDiff.reason ? <div className="text-xs text-zinc-500">{selectedDiff.reason}</div> : null}</div>{selectedDiff.diff ? <DiffViewer diff={selectedDiff.diff} /> : <AlertCard tone="warning" title="Diff Unavailable" message="This file change did not include a diff payload." />}</div> : null}

        {waitingForDecision ? (
          <div className="grid gap-4 rounded-lg border border-[#1A1A1A] bg-[#050505] p-6 md:grid-cols-2">
            <div className="rounded-md border border-[#1A1A1A] bg-[#000000] p-4">
              <div className="text-sm font-semibold text-zinc-100">Push current fixes</div>
              <p className="mt-2 text-sm leading-relaxed text-zinc-400">Stop after this patch set, move to final approval, and then create the PR with the current changes.</p>
              <div className="mt-4">
                <RunButton onClick={handlePushCurrentFixes}>Use These Fixes</RunButton>
              </div>
            </div>
            <div className="rounded-md border border-[#1A1A1A] bg-[#000000] p-4">
              <div className="text-sm font-semibold text-zinc-100">Run another round</div>
              <p className="mt-2 text-sm leading-relaxed text-zinc-400">Re-scan the updated codebase and let the remediation agent take one more pass before final approval.</p>
              <div className="mt-4">
                <RunButton onClick={handleContinueRound}>Run Another Round</RunButton>
              </div>
            </div>
          </div>
        ) : (
          <div className="rounded-lg border border-[#1A1A1A] bg-[#050505] p-6">
            <div className="mb-6 rounded-md border border-[#1A1A1A] bg-[#000000] p-4">
              <label className="flex cursor-pointer items-start gap-3">
                <input type="checkbox" checked={approved} onChange={(event) => setApproved(event.target.checked)} className="mt-1 h-4 w-4 rounded border-[#4B5563] bg-[#111111] text-indigo-600" />
                <span className="text-sm leading-relaxed text-zinc-400">I approve these code modifications. Persist the fix branch, open a Pull Request automatically if this is a GitHub project, and trigger the verification re-scan.</span>
              </label>
            </div>
            <RunButton disabled={!approved} onClick={handleApproveAndPush}>Approve &amp; Push PR</RunButton>
          </div>
        )}
      </div>
    );
  };

  const renderPrRescanView = () => {
    const verificationPending = !remediationFinished || loading || loadingResults;
    const stats = scanStats || EMPTY_STATS;
    const cleanVerification = stats.critical === 0 && stats.high === 0;
    const githubProject = projectMeta?.type === 'github';

    return (
      <div className="relative z-10 mx-auto flex min-h-full w-full max-w-5xl animate-fade-in flex-col space-y-6 p-8">
        <div className="mb-8 mt-4 flex items-center justify-between border-b border-[#1A1A1A] pb-6">
          <div>
            <h1 className="mb-2 text-2xl font-semibold text-zinc-100">Remediation Complete</h1>
            <p className="text-sm text-zinc-400">{githubProject ? 'PR creation and verification status are shown below.' : 'Local remediation persistence and verification status are shown below.'}</p>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <BorderGlow backgroundColor="#050505" colors={['#10b981', '#050505']} glowColor="150 80 50" borderRadius={8} className="border border-[#1A1A1A] p-8 shadow-xl">
            <div className="mb-6 flex h-12 w-12 items-center justify-center rounded-full border border-emerald-500/20 bg-emerald-500/10"><GitPullRequest className="h-6 w-6 text-emerald-400" /></div>
            <h3 className="mb-2 text-lg font-semibold text-zinc-100">{githubProject ? (prUrl ? 'Pull Request Created' : 'Creating Pull Request...') : 'Changes Persisted Locally'}</h3>
            <p className="mb-6 text-sm text-zinc-400">{githubProject ? (prUrl ? 'The remediation branch was pushed successfully. Open the PR to review or merge it in GitHub.' : 'The remediation engine is still persisting changes to GitHub and creating the Pull Request.') : 'The remediation engine wrote the approved changes back to the local project workspace.'}</p>
            {githubProject ? (
              <button type="button" onClick={() => prUrl && window.open(prUrl, '_blank', 'noopener,noreferrer')} disabled={!prUrl} className="flex w-full items-center justify-center gap-2 rounded-md border border-[#262626] bg-[#111111] py-2.5 text-sm font-medium text-zinc-200 transition-colors hover:bg-[#1A1A1A] disabled:cursor-not-allowed disabled:opacity-50">
                View PR on GitHub <ExternalLink className="h-4 w-4" />
              </button>
            ) : (
              <div className="rounded-md border border-[#262626] bg-[#111111] px-4 py-3 text-sm text-zinc-300">No GitHub PR is required for local projects.</div>
            )}
          </BorderGlow>

          <BorderGlow backgroundColor="#050505" colors={['#6366f1', '#050505']} glowColor="240 80 50" borderRadius={8} className="border border-[#1A1A1A] p-8 shadow-xl">
            <div className="mb-6 flex h-12 w-12 items-center justify-center rounded-full border border-indigo-500/20 bg-indigo-500/10">{verificationPending ? <RefreshCw className="h-6 w-6 animate-spin text-indigo-400" /> : <ShieldCheck className="h-6 w-6 text-indigo-400" />}</div>
            <h3 className="mb-2 text-lg font-semibold text-zinc-100">{verificationPending ? 'Verification Scan Running...' : cleanVerification ? 'Verification Complete' : 'Verification Found Remaining Risk'}</h3>
            <p className="mb-6 text-sm text-zinc-400">{verificationPending ? 'Automatically rescanning to confirm the latest vulnerability state after remediation.' : cleanVerification ? '0 Critical and 0 High vulnerabilities remain after the verification run.' : `${stats.critical} Critical and ${stats.high} High findings remain after verification.`}</p>
            {!verificationPending ? <div className="w-full"><RunButton onClick={() => router.push('/dashboard')}>Return to Dashboard</RunButton></div> : null}
          </BorderGlow>
        </div>
      </div>
    );
  };

  const renderContent = () => {
    if (activeStage === 'scan') return renderScanView();
    if (activeStage === 'results') return renderResultsView();
    if (activeStage === 'remediate_setup') return renderRemediateSetupView();
    if (activeStage === 'remediate_run') return renderRemediateRunView();
    if (activeStage === 'approval') return renderApprovalView();
    return renderPrRescanView();
  };

  return (
    <div className="relative flex h-screen overflow-hidden bg-[#000000] font-sans text-zinc-300 selection:bg-indigo-500/30">
      <div className="pointer-events-none absolute inset-0 z-0 opacity-20">
        <PixelBlast pixelSize={4} color="#3f3f46" noiseAmount={0.03} />
      </div>

      <aside className="relative z-20 flex h-full w-[260px] shrink-0 flex-col border-r border-[#1A1A1A] bg-[#050505]">
        <div className="flex h-16 items-center border-b border-[#1A1A1A] px-6">
          <div className="flex items-center gap-3">
            <div className="flex h-6 w-6 items-center justify-center rounded border border-[#262626] bg-[#111111] text-xs font-bold text-white">N</div>
            <span className="text-sm font-semibold tracking-wide text-white">DepLAI Sec</span>
          </div>
        </div>
        <div className="border-b border-[#1A1A1A] p-5">
          <div className="mb-2 flex items-center justify-between"><span className="text-xs font-medium text-zinc-400">Track Progress</span><span className="text-xs font-bold text-indigo-400">{progressPercentage}%</span></div>
          <div className="h-1 w-full overflow-hidden rounded-full bg-[#111111]"><div className="h-full bg-indigo-500 shadow-[0_0_10px_rgba(99,102,241,0.5)] transition-all duration-500" style={{ width: `${progressPercentage}%` }} /></div>
        </div>
        <div className="custom-scrollbar flex-1 space-y-1 overflow-y-auto px-3 py-6">
          {SIDEBAR_STAGES.map((stage) => {
            const status = getStageStatus(stage.id);
            const isLocked = status === 'locked';
            const isActive = status === 'active';
            const isCompleted = status === 'completed';
            return (
              <div key={stage.id} onClick={() => handleStageClick(stage.id)} className={`flex items-center gap-3 rounded-md px-3 py-2 transition-colors ${isLocked ? 'cursor-not-allowed opacity-40' : 'cursor-pointer'} ${isActive ? 'bg-[#111111] text-zinc-100' : 'text-zinc-400 hover:bg-[#0A0A0A]'}`}>
                <div className="flex shrink-0 items-center justify-center">
                  {isCompleted ? <CheckCircle2 className="h-4 w-4 text-emerald-500" /> : isActive ? <CircleDashed className="h-4 w-4 animate-spin text-indigo-500" /> : <div className="h-4 w-4 rounded-full border border-zinc-700" />}
                </div>
                <span className="text-[13px] font-medium">{stage.label}</span>
              </div>
            );
          })}
        </div>
      </aside>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-transparent">
        <header className="relative z-20 flex h-16 items-center justify-between border-b border-[#1A1A1A] bg-[#050505]/90 px-8 backdrop-blur-md">
          <div className="flex items-center gap-2 text-sm"><span className="font-medium text-zinc-500">{SIDEBAR_STAGES.find((stage) => stage.id === activeStage)?.label}</span></div>
          <div className="flex items-center gap-3">
            <span className="rounded-md border border-[#262626] bg-[#111111] px-3 py-1.5 font-mono text-xs text-zinc-400">{loadingProject ? 'Loading project...' : projectName}</span>
            <button type="button" onClick={() => router.push('/dashboard')} className="text-xs font-semibold text-zinc-400 transition-colors hover:text-white">Exit</button>
          </div>
        </header>

        <div className="custom-scrollbar min-h-0 flex-1 overflow-y-auto">
          {renderContent()}
        </div>
      </div>

      <style dangerouslySetInnerHTML={{ __html: `
        .custom-scrollbar::-webkit-scrollbar { width: 6px; height: 6px; }
        .custom-scrollbar::-webkit-scrollbar-track { background: transparent; }
        .custom-scrollbar::-webkit-scrollbar-thumb { background-color: #262626; border-radius: 10px; }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover { background-color: #3f3f46; }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(5px); } to { opacity: 1; transform: translateY(0); } }
        .animate-fade-in { animation: fadeIn 0.3s ease-out forwards; }
      ` }} />
    </div>
  );
}

