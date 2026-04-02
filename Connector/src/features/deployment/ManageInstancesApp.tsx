'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Activity,
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Copy,
  Cpu,
  Database,
  ExternalLink,
  FileText,
  GitCommit,
  Github,
  Grid,
  HardDrive,
  Info,
  LayoutGrid,
  List,
  LogOut,
  MonitorSmartphone,
  Network,
  Play,
  Plus,
  Power,
  RefreshCw,
  Rocket,
  RotateCw,
  Search,
  Server,
  Settings,
  TerminalSquare,
  Ticket,
  Trash2,
  Upload,
  User,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import {
  DEPLOY_STATE_STORAGE_PREFIX,
  extractDeploymentSummary,
  listProjectDeploymentRecords,
  removeDeploySnapshot,
  readSavedAws,
  type ProjectRecord,
} from './state';

type TabKey = 'overview' | 'deployments' | 'manage_instances' | 'settings';
type ViewMode = 'list' | 'grid';

interface DeploymentListItem {
  id: string;
  projectId: string;
  name: string;
  source: string;
  branch: string;
  time: string;
  status: 'success' | 'pending';
  visibility: 'PUBLIC' | 'PRIVATE';
}

interface ManagedInstanceItem {
  id: string;
  projectId: string;
  name: string;
  branch: string;
  cloud: string;
  region: string;
  specs: string;
  ip: string;
  privateIp: string;
  dns: string;
  status: 'running' | 'stopped';
  uptime: string;
  lastDeploy: string;
  ami: string;
  volumes: number;
  vpc: string;
  subnet: string;
  nacl: string;
  iamRole: string;
  arn: string;
  cloudfront: string;
}

interface DeploymentHistoryItem {
  id: string;
  projectId: string;
  repo: string;
  branch: string;
  commit: string;
  status: 'success' | 'failed';
  time: string;
  user: string;
}

interface AwsRuntimeLiveInstance {
  instance_id?: string;
  public_ipv4_address?: string;
  private_ipv4_address?: string;
  instance_state?: string;
  instance_type?: string;
  public_dns?: string;
  private_dns?: string;
  vpc_id?: string;
  subnet_id?: string;
  instance_arn?: string;
  launch_time?: string | null;
}

interface AwsRuntimeLiveCounts {
  ec2_instances_total?: number;
  ec2_instances_running?: number;
  s3_buckets?: number;
  cloudfront_distributions?: number;
}

interface AwsRuntimeLiveDetails {
  region?: string;
  account_id?: string;
  lookup_status?: 'ok' | 'not_found' | 'unavailable' | string;
  lookup_error?: string | null;
  instance?: AwsRuntimeLiveInstance;
  resource_counts?: AwsRuntimeLiveCounts;
}

const REFRESH_INTERVAL_MS = 8000;
const KPI_TICK_INTERVAL_MS = 15000;
const RUNTIME_DETAILS_REFRESH_MS = 12000;
const INSTANCE_MONTHLY_USD: Record<string, number> = {
  't2.micro': 8,
  't2.small': 16,
  't3.micro': 8,
  't3.small': 16,
  't3.medium': 32,
  't3a.micro': 7,
};
const INSTANCE_VCPU_COUNT: Record<string, number> = {
  't2.micro': 1,
  't2.small': 1,
  't3.micro': 2,
  't3.small': 2,
  't3.medium': 2,
  't3a.micro': 2,
};

function relativeTimeLabel(isoLike: string | null | undefined, nowMs: number = Date.now()): string {
  if (!isoLike) return 'just now';
  const ts = Date.parse(String(isoLike));
  if (!Number.isFinite(ts)) return 'just now';
  const deltaMs = nowMs - ts;
  const mins = Math.floor(deltaMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function numericFromString(input: string): number {
  const match = String(input || '').match(/\d+/);
  return match ? Number(match[0]) : 0;
}

function hoursSince(isoLike: string | null | undefined, nowMs: number): number {
  const ts = Date.parse(String(isoLike || ''));
  if (!Number.isFinite(ts)) return 1;
  const value = (nowMs - ts) / 3_600_000;
  return Math.max(1, Math.min(24, value));
}

function instanceTypeFromSpecs(specs: string): string {
  return String(specs || '').split('•')[0]?.trim().toLowerCase() || '';
}

function instanceMonthlyCost(instanceType: string, status: 'running' | 'stopped'): number {
  const base = INSTANCE_MONTHLY_USD[instanceType] ?? 6;
  return status === 'running' ? base : base * 0.25;
}

function formatUptimeFromLaunch(launchIso: string | null | undefined, nowMs: number): string {
  if (!launchIso) return '-';
  const started = Date.parse(String(launchIso));
  if (!Number.isFinite(started)) return '-';
  const deltaMs = Math.max(0, nowMs - started);
  const totalMinutes = Math.floor(deltaMs / 60000);
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h`;
  return `${Math.max(minutes, 1)}m`;
}

function instanceSpecLabel(instanceType: string): string {
  const type = String(instanceType || '').trim();
  const known: Record<string, string> = {
    't2.micro': '1 vCPU • 1GB',
    't2.small': '1 vCPU • 2GB',
    't3.micro': '2 vCPU • 1GB',
    't3.small': '2 vCPU • 2GB',
    't3.medium': '2 vCPU • 4GB',
    't3a.micro': '2 vCPU • 1GB',
  };
  if (!type || type === 'n/a') return 'n/a • n/a';
  return `${type} • ${known[type] || 'n/a'}`;
}

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
    this.ctx.fillRect(
      Math.round(this.x + centerOffset),
      Math.round(this.y + centerOffset),
      Math.round(this.size),
      Math.round(this.size),
    );
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

function PixelCard({
  gap = 5,
  speed = 35,
  colors = '#18181b,#27272a,#3f3f46',
  noFocus = false,
  className = '',
  children,
}: {
  gap?: number;
  speed?: number;
  colors?: string;
  noFocus?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const pixelsRef = useRef<Pixel[]>([]);
  const animationRef = useRef<number | null>(null);
  const timePreviousRef = useRef<number>(performance.now());
  const reducedMotionRef = useRef(false);

  useEffect(() => {
    reducedMotionRef.current = Boolean(window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }, []);

  const initPixels = useCallback(() => {
    if (!containerRef.current || !canvasRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const width = Math.floor(rect.width);
    const height = Math.floor(rect.height);
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.scale(dpr, dpr);

    const colorsArray = colors.split(',');
    const pxs: Pixel[] = [];
    for (let x = 0; x < width; x += gap) {
      for (let y = 0; y < height; y += gap) {
        const color = colorsArray[Math.floor(Math.random() * colorsArray.length)] || '#27272a';
        const distance = Math.sqrt(Math.pow(x - width / 2, 2) + Math.pow(y - height / 2, 2));
        pxs.push(new Pixel(canvas, ctx, x, y, color, speed * 0.001, reducedMotionRef.current ? 0 : distance));
      }
    }
    pixelsRef.current = pxs;
  }, [colors, gap, speed]);

  const doAnimate = useCallback((fnName: 'appear' | 'disappear') => {
    animationRef.current = requestAnimationFrame(() => doAnimate(fnName));
    const timeNow = performance.now();
    const timePassed = timeNow - timePreviousRef.current;
    if (timePassed < 1000 / 60) return;
    timePreviousRef.current = timeNow - (timePassed % (1000 / 60));

    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!ctx || !canvas) return;
    const dpr = window.devicePixelRatio || 1;
    ctx.clearRect(0, 0, canvas.width / dpr, canvas.height / dpr);

    let allIdle = true;
    pixelsRef.current.forEach((pixel) => {
      pixel[fnName]();
      if (!pixel.isIdle) allIdle = false;
    });
    if (allIdle && animationRef.current !== null) {
      cancelAnimationFrame(animationRef.current);
      animationRef.current = null;
    }
  }, []);

  const handleAnimation = useCallback((name: 'appear' | 'disappear') => {
    if (animationRef.current !== null) cancelAnimationFrame(animationRef.current);
    animationRef.current = requestAnimationFrame(() => doAnimate(name));
  }, [doAnimate]);

  useEffect(() => {
    initPixels();
    const observer = new ResizeObserver(() => initPixels());
    if (containerRef.current) observer.observe(containerRef.current);
    return () => {
      observer.disconnect();
      if (animationRef.current !== null) cancelAnimationFrame(animationRef.current);
    };
  }, [initPixels, noFocus]);

  return (
    <div
      ref={containerRef}
      className={`relative isolate select-none overflow-hidden transition-colors duration-200 ease-[cubic-bezier(0.5,1,0.89,1)] ${className}`}
      onMouseEnter={() => handleAnimation('appear')}
      onMouseLeave={() => handleAnimation('disappear')}
      onFocus={(event) => {
        if (!noFocus && !event.currentTarget.contains(event.relatedTarget as Node | null)) handleAnimation('appear');
      }}
      onBlur={(event) => {
        if (!noFocus && !event.currentTarget.contains(event.relatedTarget as Node | null)) handleAnimation('disappear');
      }}
      tabIndex={noFocus ? -1 : 0}
    >
      <canvas className="pointer-events-none absolute inset-0 z-0 block h-full w-full" ref={canvasRef} />
      <div className="relative z-10 flex h-full w-full flex-col">{children}</div>
    </div>
  );
}

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
    <div className={`h-10.5 w-full ${className}`}>
      <PixelCard
        noFocus
        colors="#3f3f46,#27272a,#18181b"
        gap={4}
        speed={35}
        className={`h-full w-full rounded-md border shadow-sm transition-all ${
          disabled
            ? 'cursor-not-allowed border-[#262626] bg-[#111111] opacity-50'
            : 'cursor-pointer border-zinc-200 bg-white shadow-[0_0_15px_rgba(255,255,255,0.15)] hover:bg-zinc-200'
        }`}
      >
        <button
          onClick={disabled ? undefined : onClick}
          disabled={disabled}
          className={`flex h-full w-full items-center justify-center gap-2 text-[13px] font-bold tracking-wide outline-none transition-colors ${
            disabled ? 'text-zinc-500' : 'text-black'
          }`}
        >
          {children}
        </button>
      </PixelCard>
    </div>
  );
}

function parseHSL(hslStr: string): { h: number; s: number; l: number } {
  const match = hslStr.match(/([\d.]+)\s*([\d.]+)%?\s*([\d.]+)%?/);
  if (!match) return { h: 0, s: 0, l: 100 };
  return { h: Number(match[1]), s: Number(match[2]), l: Number(match[3]) };
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

function easeOutCubic(x: number): number {
  return 1 - Math.pow(1 - x, 3);
}

function easeInCubic(x: number): number {
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
  for (let idx = 0; idx < 7; idx += 1) {
    const color = colors[Math.min(COLOR_MAP[idx] || 0, colors.length - 1)] || '#ffffff';
    gradients.push(`radial-gradient(at ${GRADIENT_POSITIONS[idx]}, ${color} 0px, transparent 50%)`);
  }
  gradients.push(`linear-gradient(${colors[0] || '#ffffff'} 0 100%)`);
  return gradients;
}

function BorderGlow({
  children,
  className = '',
  edgeSensitivity = 30,
  glowColor = '0 0 100',
  backgroundColor = '#050505',
  borderRadius = 12,
  glowRadius = 30,
  glowIntensity = 0.5,
  coneSpread = 25,
  animated = false,
  colors = ['#ffffff', '#71717a', '#000000'],
  fillOpacity = 0.3,
}: {
  children: React.ReactNode;
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
}) {
  const cardRef = useRef<HTMLDivElement | null>(null);
  const [isHovered, setIsHovered] = useState(false);
  const [cursorAngle, setCursorAngle] = useState(45);
  const [edgeProximity, setEdgeProximity] = useState(0);
  const [sweepActive, setSweepActive] = useState(false);

  const getCenterOfElement = useCallback((el: HTMLDivElement): [number, number] => {
    const { width, height } = el.getBoundingClientRect();
    return [width / 2, height / 2];
  }, []);

  const getEdgeProximity = useCallback((el: HTMLDivElement, x: number, y: number): number => {
    const [cx, cy] = getCenterOfElement(el);
    const dx = x - cx;
    const dy = y - cy;
    let kx = Number.POSITIVE_INFINITY;
    let ky = Number.POSITIVE_INFINITY;
    if (dx !== 0) kx = cx / Math.abs(dx);
    if (dy !== 0) ky = cy / Math.abs(dy);
    return Math.min(Math.max(1 / Math.min(kx, ky), 0), 1);
  }, [getCenterOfElement]);

  const getCursorAngle = useCallback((el: HTMLDivElement, x: number, y: number): number => {
    const [cx, cy] = getCenterOfElement(el);
    const dx = x - cx;
    const dy = y - cy;
    if (dx === 0 && dy === 0) return 0;
    const radians = Math.atan2(dy, dx);
    let degrees = radians * (180 / Math.PI) + 90;
    if (degrees < 0) degrees += 360;
    return degrees;
  }, [getCenterOfElement]);

  const handlePointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const card = cardRef.current;
    if (!card) return;
    const rect = card.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    setEdgeProximity(getEdgeProximity(card, x, y));
    setCursorAngle(getCursorAngle(card, x, y));
  }, [getCursorAngle, getEdgeProximity]);

  useEffect(() => {
    if (!animated) return;
    const angleStart = 110;
    const angleEnd = 465;
    setSweepActive(true);
    setCursorAngle(angleStart);

    animateValue({ duration: 500, onUpdate: (value) => setEdgeProximity(value / 100) });
    animateValue({
      ease: easeInCubic,
      duration: 1500,
      end: 50,
      onUpdate: (value) => {
        setCursorAngle((angleEnd - angleStart) * (value / 100) + angleStart);
      },
    });
    animateValue({
      ease: easeOutCubic,
      delay: 1500,
      duration: 2250,
      start: 50,
      end: 100,
      onUpdate: (value) => {
        setCursorAngle((angleEnd - angleStart) * (value / 100) + angleStart);
      },
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
  const borderBg = meshGradients.map((gradient) => `${gradient} border-box`);
  const fillBg = meshGradients.map((gradient) => `${gradient} padding-box`);
  const angleDeg = `${cursorAngle.toFixed(3)}deg`;

  return (
    <div
      ref={cardRef}
      onPointerMove={handlePointerMove}
      onPointerEnter={() => setIsHovered(true)}
      onPointerLeave={() => setIsHovered(false)}
      className={`relative isolate grid ${className}`}
      style={{
        background: backgroundColor,
        borderRadius: `${borderRadius}px`,
        transform: 'translate3d(0, 0, 0.01px)',
        boxShadow: 'rgba(0,0,0,0.2) 0 4px 20px',
      }}
    >
      <div
        className="absolute inset-0 -z-1 rounded-[inherit]"
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
        className="absolute inset-0 -z-1 rounded-[inherit]"
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
        className="pointer-events-none absolute z-1 rounded-[inherit]"
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

      <div className="relative z-1 flex h-full w-full flex-col">{children}</div>
    </div>
  );
}

function ConfigurationCard({
  title,
  desc,
  btnText,
  icon: Icon,
  href,
  disabled = false,
}: {
  title: string;
  desc: string;
  btnText: string;
  icon: LucideIcon;
  href?: string;
  disabled?: boolean;
}) {
  return (
    <div className="group flex flex-col rounded-lg border border-[#262626] bg-[#050505] p-5 transition-all hover:border-zinc-500">
      <div className="mb-2 flex items-center gap-2">
        <Icon className="h-4 w-4 text-zinc-400 transition-colors group-hover:text-white" />
        <h5 className="text-sm font-bold text-white">{title}</h5>
      </div>
      <p className="mb-5 flex-1 text-xs leading-relaxed text-zinc-500">{desc}</p>
      <button
        disabled={disabled || !href}
        onClick={() => {
          if (disabled || !href) return;
          window.open(href, '_blank', 'noopener,noreferrer');
        }}
        className={`flex items-center gap-2 self-start rounded border px-4 py-1.5 text-xs font-bold transition-colors ${
          disabled || !href
            ? 'cursor-not-allowed border-[#262626] bg-[#0A0A0A] text-zinc-600'
            : 'border-[#333333] bg-[#111111] text-zinc-300 hover:bg-white hover:text-black'
        }`}
      >
        {btnText} <ExternalLink className="h-3 w-3" />
      </button>
    </div>
  );
}

export default function ManageInstancesApp({ embedded = false }: { embedded?: boolean }) {
  const router = useRouter();
  const [activeTab, setActiveTab] = useState<TabKey>('manage_instances');
  const [viewMode, setViewMode] = useState<ViewMode>('list');
  const [expandedInstanceId, setExpandedInstanceId] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  const [runtimeDetailsByProject, setRuntimeDetailsByProject] = useState<Record<string, AwsRuntimeLiveDetails>>({});
  const [busyActions, setBusyActions] = useState<Record<string, boolean>>({});

  const loadProjects = useCallback(async (withSpinner: boolean) => {
    if (withSpinner) setRefreshing(true);
    try {
      const response = await fetch('/api/projects', { cache: 'no-store' });
      const data = (await response.json().catch(() => ({}))) as { projects?: ProjectRecord[] };
      setProjects(Array.isArray(data.projects) ? data.projects : []);
    } finally {
      if (withSpinner) setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void loadProjects(true);
  }, [loadProjects]);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      void loadProjects(false);
    }, REFRESH_INTERVAL_MS);
    return () => {
      window.clearInterval(intervalId);
    };
  }, [loadProjects]);

  useEffect(() => {
    const tickId = window.setInterval(() => {
      setNowMs(Date.now());
    }, KPI_TICK_INTERVAL_MS);
    return () => window.clearInterval(tickId);
  }, []);

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key && event.key.startsWith(DEPLOY_STATE_STORAGE_PREFIX)) {
        void loadProjects(false);
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [loadProjects]);

  const records = useMemo(() => listProjectDeploymentRecords(projects), [projects]);

  const setActionBusy = useCallback((key: string, busy: boolean) => {
    setBusyActions((prev) => {
      if (!busy) {
        const next = { ...prev };
        delete next[key];
        return next;
      }
      return { ...prev, [key]: true };
    });
  }, []);

  const refreshRuntimeDetails = useCallback(async () => {
    if (records.length === 0) {
      setRuntimeDetailsByProject({});
      return;
    }
    const aws = readSavedAws();
    if (!aws.aws_access_key_id || !aws.aws_secret_access_key) {
      setRuntimeDetailsByProject({});
      return;
    }

    const results = await Promise.all(
      records.map(async (record) => {
        try {
          const summary = extractDeploymentSummary(record.latest?.deployResult || record.snapshot.deployResult);
          const instanceId = summary.instanceId && summary.instanceId !== 'n/a' && !summary.instanceId.startsWith('project-')
            ? summary.instanceId
            : undefined;
          const region = String(record.latest?.region || aws.aws_region || 'eu-north-1');

          const response = await fetch('/api/pipeline/runtime-details', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              project_id: record.projectId,
              aws_access_key_id: aws.aws_access_key_id,
              aws_secret_access_key: aws.aws_secret_access_key,
              aws_region: region,
              instance_id: instanceId,
            }),
          });
          const data = (await response.json().catch(() => ({}))) as { success?: boolean; details?: AwsRuntimeLiveDetails };
          if (!response.ok || data.success !== true || !data.details) return null;
          return [record.projectId, data.details] as const;
        } catch {
          return null;
        }
      }),
    );

    const next: Record<string, AwsRuntimeLiveDetails> = {};
    for (const row of results) {
      if (!row) continue;
      next[row[0]] = row[1];
    }
    setRuntimeDetailsByProject(next);
  }, [records]);

  useEffect(() => {
    void refreshRuntimeDetails();
    const intervalId = window.setInterval(() => {
      void refreshRuntimeDetails();
    }, RUNTIME_DETAILS_REFRESH_MS);
    return () => window.clearInterval(intervalId);
  }, [refreshRuntimeDetails]);

  const deployments = useMemo<DeploymentListItem[]>(() => {
    return records.map((record) => {
      const status = record.snapshot.status === 'done' ? 'success' : 'pending';
      const project = projects.find((item) => item.id === record.projectId);
      return {
        id: record.projectId,
        projectId: record.projectId,
        name: record.projectName,
        source: project?.type === 'github' ? 'Github' : 'Local',
        branch: project?.branch || 'main',
        time: `Deployed ${relativeTimeLabel(record.snapshot.updatedAt, nowMs)}`,
        status,
        visibility: String(project?.access || 'PUBLIC').toUpperCase() === 'PRIVATE' ? 'PRIVATE' : 'PUBLIC',
      };
    });
  }, [nowMs, projects, records]);

  const instances = useMemo<ManagedInstanceItem[]>(() => {
    return records
      .map((record) => {
      const summary = extractDeploymentSummary(record.latest?.deployResult || record.snapshot.deployResult);
      const project = projects.find((item) => item.id === record.projectId);
      const runtime = runtimeDetailsByProject[record.projectId];
      if (runtime?.lookup_status === 'not_found') {
        return null;
      }
      const liveInstance = runtime?.instance;
      const stateRaw = String(liveInstance?.instance_state || summary.instanceState || '').toLowerCase();
      const status: 'running' | 'stopped' = stateRaw.includes('running') ? 'running' : 'stopped';
      const region = String(runtime?.region || record.latest?.region || 'eu-north-1');
      const launchTime = String(liveInstance?.launch_time || '').trim() || null;
      const instanceType = String(liveInstance?.instance_type || summary.instanceType || '').trim();
      return {
        id: String(liveInstance?.instance_id || summary.instanceId) !== 'n/a'
          ? String(liveInstance?.instance_id || summary.instanceId)
          : `project-${record.projectId}`,
        projectId: record.projectId,
        name: record.projectName.toLowerCase().replace(/\s+/g, '-'),
        branch: project?.branch || 'main',
        cloud: 'AWS',
        region,
        specs: instanceSpecLabel(instanceType),
        ip: String(liveInstance?.public_ipv4_address || summary.publicIp),
        privateIp: String(liveInstance?.private_ipv4_address || summary.privateIp),
        dns: String(liveInstance?.public_dns || summary.publicDns),
        status,
        uptime: status === 'running'
          ? (launchTime ? formatUptimeFromLaunch(launchTime, nowMs) : `${relativeTimeLabel(record.snapshot.updatedAt, nowMs).replace(' ago', '')}`)
          : '-',
        lastDeploy: relativeTimeLabel(record.snapshot.updatedAt, nowMs),
        ami: 'n/a',
        volumes: 1,
        vpc: String(liveInstance?.vpc_id || summary.vpcId),
        subnet: String(liveInstance?.subnet_id || summary.subnetId),
        nacl: 'n/a',
        iamRole: 'n/a',
        arn: String(liveInstance?.instance_arn || summary.instanceArn),
        cloudfront: summary.cloudfrontUrl,
      };
      })
      .filter((item): item is ManagedInstanceItem => Boolean(item));
  }, [nowMs, projects, records, runtimeDetailsByProject]);

  const deploymentHistory = useMemo<DeploymentHistoryItem[]>(() => {
    const rows: Array<DeploymentHistoryItem & { ts: number }> = [];
    records.forEach((record) => {
      const project = projects.find((item) => item.id === record.projectId);
      const branch = project?.branch || 'main';
      record.snapshot.deploymentHistory.forEach((entry) => {
        const ts = Date.parse(entry.createdAt);
        rows.push({
          id: `${record.projectId}-${entry.id}`,
          projectId: record.projectId,
          repo: record.projectName,
          branch,
          commit: String(entry.id).slice(0, 7),
          status: entry.status === 'done' ? 'success' : 'failed',
          time: relativeTimeLabel(entry.createdAt, nowMs),
          user: project?.owner || 'system-auto',
          ts: Number.isFinite(ts) ? ts : 0,
        });
      });
    });
    return rows.sort((a, b) => b.ts - a.ts).slice(0, 24).map(({ ts: _ts, ...row }) => row);
  }, [nowMs, projects, records]);

  const filteredDeployments = useMemo(() => {
    const query = searchTerm.trim().toLowerCase();
    if (!query) return deployments;
    return deployments.filter((dep) => dep.name.toLowerCase().includes(query) || dep.branch.toLowerCase().includes(query));
  }, [deployments, searchTerm]);

  const activeInstances = instances.filter((instance) => instance.status === 'running').length;

  const managedCloudfrontCount = useMemo(() => {
    const unique = new Set<string>();
    instances.forEach((instance) => {
      const url = String(instance.cloudfront || '').trim();
      if (!url || url === 'n/a') return;
      unique.add(url.toLowerCase());
    });
    return unique.size;
  }, [instances]);

  const managedS3Count = 0;

  const totalVcpu = instances.reduce((sum, item) => {
    const type = instanceTypeFromSpecs(item.specs);
    if (item.status !== 'running') return sum;
    if (type in INSTANCE_VCPU_COUNT) return sum + (INSTANCE_VCPU_COUNT[type] || 0);
    return sum + numericFromString(item.specs.split('•')[1] || '');
  }, 0);

  const averageHoursWindow = records.length > 0
    ? records.reduce((sum, record) => sum + hoursSince(record.snapshot.updatedAt, nowMs), 0) / records.length
    : 1;

  const networkEgressGb = (
    (activeInstances * 0.35)
    + (managedCloudfrontCount * 0.6)
    + (managedS3Count * 0.08)
  ) * averageHoursWindow;

  const estMonthlyCost = instances.reduce((sum, item) => {
    const type = instanceTypeFromSpecs(item.specs);
    return sum + instanceMonthlyCost(type, item.status);
  }, 0)
    + (managedCloudfrontCount * 8)
    + (managedS3Count * 0.5);

  const openInstanceTerminal = useCallback((instance: ManagedInstanceItem) => {
    const region = encodeURIComponent(String(instance.region || 'eu-north-1'));
    const hasInstanceId = Boolean(instance.id && instance.id !== 'n/a' && !instance.id.startsWith('project-'));
    if (!hasInstanceId) {
      window.alert('Live instance id is not available yet for this environment.');
      return;
    }
    const instanceId = encodeURIComponent(instance.id);
    const url = `https://${instance.region}.console.aws.amazon.com/ec2/home?region=${region}#ConnectToInstance:instanceId=${instanceId}`;
    window.open(url, '_blank', 'noopener,noreferrer');
  }, []);

  const runInstanceAction = useCallback(
    async (instance: ManagedInstanceItem, action: 'start' | 'stop' | 'reboot') => {
      const aws = readSavedAws();
      if (!aws.aws_access_key_id || !aws.aws_secret_access_key) {
        window.alert('AWS credentials are missing. Open Deployment Track and set AWS credentials first.');
        return;
      }
      const hasInstanceId = Boolean(instance.id && instance.id !== 'n/a' && !instance.id.startsWith('project-'));
      if (!hasInstanceId) {
        window.alert('Live instance id is not available yet for this environment.');
        return;
      }

      const actionKey = `${instance.projectId}:${instance.id}:${action}`;
      setActionBusy(actionKey, true);
      try {
        const response = await fetch('/api/pipeline/runtime-instance', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            project_id: instance.projectId,
            aws_access_key_id: aws.aws_access_key_id,
            aws_secret_access_key: aws.aws_secret_access_key,
            aws_region: instance.region || aws.aws_region,
            instance_id: instance.id,
            action,
          }),
        });
        const data = (await response.json().catch(() => ({}))) as { success?: boolean; error?: string };
        if (!response.ok || data.success !== true) {
          window.alert(data.error || `Failed to ${action} instance.`);
          return;
        }

        await loadProjects(false);
        await refreshRuntimeDetails();
      } finally {
        setActionBusy(actionKey, false);
      }
    },
    [loadProjects, refreshRuntimeDetails, setActionBusy],
  );

  const handleTogglePower = useCallback(
    async (instance: ManagedInstanceItem) => {
      const action: 'start' | 'stop' = instance.status === 'running' ? 'stop' : 'start';
      const confirmMessage = action === 'stop'
        ? `Stop instance ${instance.id}?`
        : `Start instance ${instance.id}?`;
      if (!window.confirm(confirmMessage)) return;
      await runInstanceAction(instance, action);
    },
    [runInstanceAction],
  );

  const handleRestart = useCallback(
    async (instance: ManagedInstanceItem) => {
      if (instance.status !== 'running') {
        window.alert('Only running instances can be rebooted.');
        return;
      }
      if (!window.confirm(`Reboot instance ${instance.id}?`)) return;
      await runInstanceAction(instance, 'reboot');
    },
    [runInstanceAction],
  );

  const handleDestroy = useCallback(
    async (instance: ManagedInstanceItem) => {
      const aws = readSavedAws();
      if (!aws.aws_access_key_id || !aws.aws_secret_access_key) {
        window.alert('AWS credentials are missing. Open Deployment Track and set AWS credentials first.');
        return;
      }
      if (!window.confirm(`Destroy runtime resources for ${instance.name}? This cannot be undone.`)) return;

      const actionKey = `${instance.projectId}:${instance.id}:destroy`;
      setActionBusy(actionKey, true);
      try {
        const response = await fetch('/api/pipeline/deploy/destroy', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            project_id: instance.projectId,
            aws_access_key_id: aws.aws_access_key_id,
            aws_secret_access_key: aws.aws_secret_access_key,
            aws_region: instance.region || aws.aws_region,
          }),
        });
        const data = (await response.json().catch(() => ({}))) as { success?: boolean; error?: string };
        if (!response.ok || data.success !== true) {
          window.alert(data.error || 'Failed to destroy runtime resources.');
          return;
        }

        removeDeploySnapshot(instance.projectId);
        setRuntimeDetailsByProject((prev) => {
          const next = { ...prev };
          delete next[instance.projectId];
          return next;
        });
        setExpandedInstanceId((prev) => (prev === instance.id ? null : prev));

        await loadProjects(false);
        await refreshRuntimeDetails();
      } finally {
        setActionBusy(actionKey, false);
      }
    },
    [loadProjects, refreshRuntimeDetails, setActionBusy],
  );

  const renderDeploymentsView = () => (
    <div className="custom-scrollbar flex-1 overflow-y-auto p-8">
      <div className="mb-10 grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
        <BorderGlow backgroundColor="#050505" glowColor="0 0 100" borderRadius={12} className="border border-[#1A1A1A] shadow-sm">
          <PixelCard colors="#3f3f46,#27272a,#18181b" gap={8} speed={35} className="h-full w-full rounded-[inherit] p-5">
            <h3 className="mb-3 text-[11px] font-bold uppercase tracking-widest text-zinc-500">Deployments</h3>
            <div className="mb-5 flex items-end gap-3">
              <span className="text-4xl font-semibold leading-none text-white">{filteredDeployments.length}</span>
              <span className="mb-1 text-[13px] text-zinc-500">active</span>
            </div>
            <div className="mt-auto flex gap-2">
              <span className="flex items-center gap-1.5 rounded border border-[#262626] bg-[#111111] px-2 py-1 text-[11px] font-medium text-zinc-400">
                <Github className="h-3 w-3 text-white" /> {filteredDeployments.filter((item) => item.source === 'Github').length} remote
              </span>
              <span className="flex items-center gap-1.5 rounded border border-[#262626] bg-[#111111] px-2 py-1 text-[11px] font-medium text-zinc-400">
                <FileText className="h-3 w-3 text-white" /> {filteredDeployments.filter((item) => item.source !== 'Github').length} local
              </span>
            </div>
          </PixelCard>
        </BorderGlow>

        <BorderGlow
          backgroundColor="#0A0A0A"
          colors={['#ffffff', '#a1a1aa', '#000000']}
          glowColor="0 0 100"
          borderRadius={12}
          animated
          className="group cursor-pointer border border-[#262626]"
        >
          <PixelCard colors="#71717a,#52525b,#3f3f46" gap={8} speed={35} className="h-full w-full rounded-[inherit] p-5">
            <div className="mb-3 flex items-center gap-3">
              <div className="flex h-8 w-8 items-center justify-center rounded border border-white/20 bg-white/10">
                <Plus className="h-4 w-4 text-white" />
              </div>
              <h3 className="text-base font-semibold text-white">Add Project</h3>
            </div>
            <p className="mb-4 text-[13px] leading-relaxed text-zinc-400">Connect more GitHub repositories to secure your supply chain.</p>
            <div className="mt-auto flex items-center gap-1 text-[13px] font-medium text-white opacity-70 transition-opacity group-hover:opacity-100">
              Connect now <ChevronRight className="h-3.5 w-3.5" />
            </div>
          </PixelCard>
        </BorderGlow>

        <BorderGlow backgroundColor="#050505" glowColor="0 0 100" borderRadius={12} className="overflow-hidden border border-[#1A1A1A]">
          <PixelCard colors="#3f3f46,#27272a,#18181b" gap={8} speed={35} className="h-full w-full rounded-[inherit] p-5">
            <div className="relative z-10 mb-2 flex items-center gap-2">
              <Zap className="h-4 w-4 text-white" />
              <h3 className="text-base font-semibold text-white">Global Edge</h3>
            </div>
            <p className="relative z-10 mb-5 text-[13px] leading-relaxed text-zinc-500">Deploy live endpoints to global edge networks instantly.</p>
            <div className="relative z-10 mt-auto">
              <RunButton onClick={() => router.push('/dashboard/deploy')}>
                <Play className="h-3.5 w-3.5 fill-current" /> Start Edge Deploy
              </RunButton>
            </div>
          </PixelCard>
        </BorderGlow>

        <BorderGlow backgroundColor="#050505" glowColor="0 0 100" borderRadius={12} className="group cursor-pointer border border-[#1A1A1A] transition-colors">
          <PixelCard colors="#3f3f46,#27272a,#18181b" gap={8} speed={35} className="h-full w-full items-center justify-center rounded-[inherit] p-5 text-center">
            <div className="flex h-full flex-col items-center justify-center">
              <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-lg border border-[#262626] bg-[#111111] transition-transform group-hover:-translate-y-0.5">
                <Upload className="h-4 w-4 text-white" />
              </div>
              <h3 className="mb-1.5 text-[15px] font-semibold text-white">Upload Project</h3>
              <p className="rounded border border-[#1A1A1A] bg-[#111111] px-2.5 py-1 text-[11px] text-zinc-500">.zip supported</p>
            </div>
          </PixelCard>
        </BorderGlow>
      </div>

      <div className="relative z-10">
        <div className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <h2 className="text-xl font-semibold text-white">Deployments</h2>
            <span className="rounded border border-[#1A1A1A] bg-[#111111] px-2 py-0.5 text-[11px] font-medium text-zinc-400">{filteredDeployments.length}</span>
          </div>

          <div className="flex items-center gap-3">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" />
              <input
                type="text"
                value={searchTerm}
                onChange={(event) => setSearchTerm(event.target.value)}
                placeholder="Search deployments..."
                className="w-70 rounded-md border border-[#1A1A1A] bg-[#050505] py-1.5 pl-9 pr-4 text-[13px] text-white placeholder:text-zinc-600 focus:border-zinc-500 focus:outline-none"
              />
            </div>

            <div className="flex items-center rounded-md border border-[#1A1A1A] bg-[#050505] p-0.5">
              <button
                onClick={() => setViewMode('list')}
                className={`rounded p-1.5 ${viewMode === 'list' ? 'bg-[#1A1A1A] text-white' : 'text-zinc-500 transition-colors hover:text-white'}`}
              >
                <List className="h-4 w-4" />
              </button>
              <button
                onClick={() => setViewMode('grid')}
                className={`rounded p-1.5 ${viewMode === 'grid' ? 'bg-[#1A1A1A] text-white' : 'text-zinc-500 transition-colors hover:text-white'}`}
              >
                <Grid className="h-4 w-4" />
              </button>
            </div>
          </div>
        </div>

        <div className="space-y-2">
          {filteredDeployments.map((dep) => (
            <div key={dep.id} className="flex items-center gap-4 rounded-lg border border-[#1A1A1A] bg-[#050505] p-4 transition-colors hover:border-[#262626]">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-[#262626] bg-[#111111]">
                <MonitorSmartphone className="h-5 w-5 text-white" />
              </div>

              <div className="flex min-w-0 flex-1 flex-col justify-center">
                <div className="mb-1 flex items-center gap-3">
                  <h4 className="truncate text-[15px] font-semibold text-white">{dep.name}</h4>
                  {dep.visibility === 'PUBLIC' && (
                    <span className="rounded border border-white bg-white/10 px-1.5 py-0.5 text-[9px] font-bold tracking-wider text-white">PUBLIC</span>
                  )}
                </div>
                <div className="flex items-center gap-2 text-[12px] text-zinc-500">
                  <span>{dep.source}</span>
                  <span className="h-1 w-1 rounded-full bg-zinc-600" />
                  <span className="text-zinc-300">{dep.branch}</span>
                  <span className="mx-1 text-white">•</span>
                  <span className="font-medium text-white">{dep.time}</span>
                </div>
              </div>

              <div className="flex shrink-0 items-center gap-3">
                {dep.status === 'success' ? (
                  <button
                    onClick={() => router.push(`/dashboard/deploy?projectId=${encodeURIComponent(dep.projectId)}`)}
                    className="flex items-center gap-2 rounded border border-[#333333] bg-transparent px-3 py-1.5 text-[12px] font-semibold text-white transition-all hover:bg-white hover:text-black"
                  >
                    <FileText className="h-3.5 w-3.5" /> View Logs <ChevronRight className="h-3 w-3" />
                  </button>
                ) : (
                  <div className="w-32">
                    <RunButton onClick={() => router.push(`/dashboard/deploy?projectId=${encodeURIComponent(dep.projectId)}`)}>
                      <Play className="h-3.5 w-3.5 fill-current" /> Deploy Now
                    </RunButton>
                  </div>
                )}

                <button className="flex items-center gap-1.5 rounded border border-[#262626] bg-[#111111] px-3 py-1.5 text-[12px] font-medium text-zinc-400 transition-colors hover:text-white">
                  <Ticket className="h-3.5 w-3.5" /> Raise Ticket
                </button>

                <button className="ml-1 rounded p-1.5 text-zinc-500 transition-colors hover:text-white" title="Delete">
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            </div>
          ))}
          {filteredDeployments.length === 0 && (
            <div className="rounded-lg border border-dashed border-[#1A1A1A] bg-[#050505] p-8 text-center text-sm text-zinc-500">No deployments found.</div>
          )}
        </div>
      </div>
    </div>
  );

  const renderManageInstancesView = () => (
    <div className="custom-scrollbar flex-1 overflow-y-auto p-8">
      <div className="mb-8 grid grid-cols-1 gap-4 md:grid-cols-4">
        <BorderGlow backgroundColor="#050505" glowColor="0 0 100" borderRadius={12} glowIntensity={0.6} className="border border-[#1A1A1A]">
          <PixelCard colors="#3f3f46,#27272a,#18181b" gap={6} speed={35} className="h-full w-full rounded-[inherit] p-5">
            <div className="relative z-10 mb-2 flex items-center gap-3">
              <div className="flex h-8 w-8 items-center justify-center rounded border border-white/20 bg-white/10">
                <Activity className="h-4 w-4 text-white" />
              </div>
              <h3 className="text-[12px] font-semibold text-zinc-400">Active Instances</h3>
            </div>
            <div className="relative z-10 text-3xl font-bold text-white">{activeInstances}</div>
          </PixelCard>
        </BorderGlow>

        <BorderGlow backgroundColor="#050505" glowColor="0 0 100" borderRadius={12} glowIntensity={0.6} className="border border-[#1A1A1A]">
          <PixelCard colors="#3f3f46,#27272a,#18181b" gap={6} speed={35} className="h-full w-full rounded-[inherit] p-5">
            <div className="relative z-10 mb-2 flex items-center gap-3">
              <div className="flex h-8 w-8 items-center justify-center rounded border border-[#262626] bg-[#111111]">
                <Cpu className="h-4 w-4 text-white" />
              </div>
              <h3 className="text-[12px] font-semibold text-zinc-400">Compute Used</h3>
            </div>
            <div className="relative z-10 text-3xl font-bold text-white">{totalVcpu} <span className="text-lg font-normal text-zinc-500">vCPU</span></div>
          </PixelCard>
        </BorderGlow>

        <BorderGlow backgroundColor="#050505" glowColor="0 0 100" borderRadius={12} glowIntensity={0.6} className="border border-[#1A1A1A]">
          <PixelCard colors="#3f3f46,#27272a,#18181b" gap={6} speed={35} className="h-full w-full rounded-[inherit] p-5">
            <div className="relative z-10 mb-2 flex items-center gap-3">
              <div className="flex h-8 w-8 items-center justify-center rounded border border-[#262626] bg-[#111111]">
                <Network className="h-4 w-4 text-white" />
              </div>
              <h3 className="text-[12px] font-semibold text-zinc-400">Network Egress</h3>
            </div>
            <div className="relative z-10 text-3xl font-bold text-white">{networkEgressGb.toFixed(1)} <span className="text-lg font-normal text-zinc-500">GB</span></div>
          </PixelCard>
        </BorderGlow>

        <BorderGlow backgroundColor="#050505" glowColor="0 0 100" borderRadius={12} glowIntensity={0.6} className="border border-[#1A1A1A]">
          <PixelCard colors="#3f3f46,#27272a,#18181b" gap={6} speed={35} className="h-full w-full rounded-[inherit] p-5">
            <div className="relative z-10 mb-2 flex items-center gap-3">
              <div className="flex h-8 w-8 items-center justify-center rounded border border-[#262626] bg-[#111111]">
                <span className="font-bold text-white">$</span>
              </div>
              <h3 className="text-[12px] font-semibold text-zinc-400">Est. Monthly Cost</h3>
            </div>
            <div className="relative z-10 text-3xl font-bold text-white">${estMonthlyCost.toFixed(2)}</div>
          </PixelCard>
        </BorderGlow>
      </div>

      <div className="relative z-10 grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="flex items-center gap-2 text-lg font-semibold text-white">Deployed Environments</h2>
            <div className="flex gap-2">
              <button className="rounded-md border border-[#262626] bg-[#111111] px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-white hover:text-black">All Regions</button>
              <button className="flex items-center gap-1.5 rounded-md border border-[#262626] bg-[#111111] px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-white hover:text-black"><List className="h-3.5 w-3.5" /> Filter</button>
            </div>
          </div>

          {instances.map((instance) => (
            <div key={instance.id} className="group rounded-xl border border-[#1A1A1A] bg-[#050505] p-5 transition-colors hover:border-[#333333]">
              {(() => {
                const region = String(instance.region || 'eu-north-1').trim() || 'eu-north-1';
                const regionParam = encodeURIComponent(region);
                const hasInstanceId = Boolean(instance.id && instance.id !== 'n/a' && !instance.id.startsWith('project-'));
                const instanceIdParam = encodeURIComponent(instance.id || '');
                const instanceDetailsUrl = hasInstanceId
                  ? `https://${region}.console.aws.amazon.com/ec2/home?region=${regionParam}#InstanceDetails:instanceId=${instanceIdParam}`
                  : `https://${region}.console.aws.amazon.com/ec2/home?region=${regionParam}#Instances:`;
                const rdsUrl = `https://${region}.console.aws.amazon.com/rds/home?region=${regionParam}#databases:`;
                const albUrl = `https://${region}.console.aws.amazon.com/ec2/home?region=${regionParam}#LoadBalancers:`;
                const monitoringUrl = hasInstanceId
                  ? `https://${region}.console.aws.amazon.com/ec2/home?region=${regionParam}#InstanceDetails:instanceId=${instanceIdParam};tab=monitoring`
                  : `https://${region}.console.aws.amazon.com/cloudwatch/home?region=${regionParam}`;
                const snapshotUrl = `https://${region}.console.aws.amazon.com/ebs/home?region=${regionParam}#LifecyclePolicies:`;
                const billingUrl = 'https://console.aws.amazon.com/costmanagement/home?#/budgets';

                return (
                  <>
              <div className="mb-4 flex items-start justify-between">
                <div className="flex items-start gap-4">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-[#262626] bg-[#111111]">
                    <Server className="h-5 w-5 text-white" />
                  </div>
                  <div>
                    <div className="mb-1 flex items-center gap-3">
                      <h3 className="text-base font-semibold text-white">{instance.name}</h3>
                      <span className="rounded border border-[#262626] bg-[#111111] px-1.5 py-0.5 font-mono text-[10px] text-zinc-400">{instance.id}</span>
                    </div>
                    <div className="flex items-center gap-2 text-xs font-medium text-zinc-500">
                      <GitCommit className="h-3.5 w-3.5" /> Branch: <span className="font-mono text-zinc-300">{instance.branch}</span>
                      <span className="px-1 text-zinc-600">•</span>
                      <span>{instance.cloud} {instance.region}</span>
                    </div>
                  </div>
                </div>

                {instance.status === 'running' ? (
                  <div className="flex items-center gap-1.5 rounded border border-white/20 bg-white/10 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-white">
                    <span className="relative flex h-1.5 w-1.5"><span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-white opacity-75" /><span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-white" /></span>
                    Running
                  </div>
                ) : (
                  <div className="flex items-center gap-1.5 rounded border border-zinc-800 bg-zinc-900 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-zinc-500">
                    <div className="h-1.5 w-1.5 rounded-full bg-zinc-600" /> Stopped
                  </div>
                )}
              </div>

              <div className="mb-4 grid grid-cols-3 gap-4 border-b border-t border-[#1A1A1A] py-4">
                <div>
                  <span className="mb-1 block text-[10px] font-bold uppercase tracking-widest text-zinc-500">Instance Specs</span>
                  <div className="text-[13px] font-medium text-zinc-300">{instance.specs}</div>
                </div>
                <div>
                  <span className="mb-1 block text-[10px] font-bold uppercase tracking-widest text-zinc-500">IP Address</span>
                  <div className="flex items-center gap-2 font-mono text-[13px] text-zinc-300">
                    {instance.ip} <Copy className="h-3 w-3 cursor-pointer text-zinc-500 transition-colors hover:text-white" />
                  </div>
                </div>
                <div>
                  <span className="mb-1 block text-[10px] font-bold uppercase tracking-widest text-zinc-500">Uptime</span>
                  <div className="text-[13px] font-medium text-zinc-300">{instance.uptime}</div>
                </div>
              </div>

              {expandedInstanceId === instance.id && (
                <div className="animate-fade-in mb-2 mt-6 border-t border-[#1A1A1A] pt-6">
                  <div className="mb-8">
                    <h4 className="mb-4 flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-white">
                      <Info className="h-4 w-4 text-zinc-400" /> Instance Summary
                    </h4>
                    <div className="grid grid-cols-2 gap-x-4 gap-y-6 rounded-lg border border-[#262626] bg-[#050505] p-5 md:grid-cols-4">
                      <div className="flex flex-col gap-1.5">
                        <span className="text-[10px] font-bold uppercase text-zinc-500">Instance ID</span>
                        <div className="flex items-center gap-2 font-mono text-xs text-zinc-200">
                          <span className="truncate">{instance.id}</span>
                          <Copy className="h-3 w-3 cursor-pointer text-zinc-600 transition-colors hover:text-white" />
                        </div>
                      </div>

                      <div className="flex flex-col gap-1.5">
                        <span className="text-[10px] font-bold uppercase text-zinc-500">Public IPv4</span>
                        <div className="flex items-center gap-2 font-mono text-xs text-zinc-200">
                          <span className="truncate">{instance.ip}</span>
                          <ExternalLink className="h-3 w-3 cursor-pointer text-zinc-600 transition-colors hover:text-white" />
                        </div>
                      </div>

                      <div className="flex flex-col gap-1.5">
                        <span className="text-[10px] font-bold uppercase text-zinc-500">Private IPv4</span>
                        <div className="flex items-center gap-2 font-mono text-xs text-zinc-200">
                          <span className="truncate">{instance.privateIp}</span>
                          <Copy className="h-3 w-3 cursor-pointer text-zinc-600 transition-colors hover:text-white" />
                        </div>
                      </div>

                      <div className="flex flex-col gap-1.5">
                        <span className="text-[10px] font-bold uppercase text-zinc-500">Instance State</span>
                        <div className="flex items-center gap-2 text-xs font-semibold text-zinc-200">
                          {instance.status === 'running' && <span className="h-1.5 w-1.5 rounded-full bg-white" />}
                          {instance.status === 'stopped' && <span className="h-1.5 w-1.5 rounded-full bg-zinc-600" />}
                          <span className="capitalize">{instance.status}</span>
                        </div>
                      </div>

                      <div className="flex flex-col gap-1.5 md:col-span-2">
                        <span className="text-[10px] font-bold uppercase text-zinc-500">Public DNS</span>
                        <div className="flex items-center gap-2 font-mono text-[11px] text-zinc-300">
                          <span className="truncate">{instance.dns}</span>
                          <ExternalLink className="h-3 w-3 shrink-0 cursor-pointer text-zinc-600 transition-colors hover:text-white" />
                        </div>
                      </div>

                      <div className="flex flex-col gap-1.5">
                        <span className="text-[10px] font-bold uppercase text-zinc-500">Instance Type</span>
                        <div className="flex items-center gap-2 font-mono text-xs text-zinc-200">
                          <span>{instance.specs.split(' • ')[0]}</span>
                        </div>
                      </div>

                      <div className="flex flex-col gap-1.5">
                        <span className="text-[10px] font-bold uppercase text-zinc-500">IAM Role</span>
                        <div className="flex items-center gap-2 font-mono text-[11px] text-zinc-300">
                          <span className="truncate cursor-pointer hover:text-white hover:underline">{instance.iamRole}</span>
                        </div>
                      </div>

                      <div className="flex flex-col gap-1.5">
                        <span className="text-[10px] font-bold uppercase text-zinc-500">VPC ID</span>
                        <div className="flex items-center gap-2 font-mono text-[11px] text-zinc-300">
                          <span className="truncate cursor-pointer hover:text-white hover:underline">{instance.vpc}</span>
                        </div>
                      </div>

                      <div className="flex flex-col gap-1.5">
                        <span className="text-[10px] font-bold uppercase text-zinc-500">Subnet ID</span>
                        <div className="flex items-center gap-2 font-mono text-[11px] text-zinc-300">
                          <span className="truncate cursor-pointer hover:text-white hover:underline">{instance.subnet}</span>
                        </div>
                      </div>

                      <div className="flex flex-col gap-1.5 md:col-span-2">
                        <span className="text-[10px] font-bold uppercase text-zinc-500">Instance ARN</span>
                        <div className="flex items-center gap-2 font-mono text-[11px] text-zinc-500">
                          <span className="truncate">{instance.arn}</span>
                        </div>
                      </div>
                    </div>
                  </div>

                  <div>
                    <h4 className="mb-4 flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-white">
                      <Settings className="h-4 w-4 text-zinc-400" /> Configuration & Actions
                    </h4>
                    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
                      <ConfigurationCard
                        title="Connect to your instance"
                        desc="Once your instance is running, log into it securely from your local computer."
                        btnText="Connect"
                        icon={TerminalSquare}
                        href={instanceDetailsUrl}
                      />
                      <ConfigurationCard
                        title="Connect an RDS database"
                        desc="Configure the connection between an EC2 instance and a database to allow traffic flow."
                        btnText="Connect RDS"
                        icon={Database}
                        href={rdsUrl}
                      />
                      <ConfigurationCard
                        title="Create Load Balancer"
                        desc="Create an application, network gateway or classic Elastic Load Balancer for this target."
                        btnText="Create ALB"
                        icon={Network}
                        href={albUrl}
                      />
                      <ConfigurationCard
                        title="Manage detailed monitoring"
                        desc="Enable or disable detailed monitoring. View high-resolution graphs with a 1-minute period."
                        btnText="Manage monitoring"
                        icon={Activity}
                        href={monitoringUrl}
                      />
                      <ConfigurationCard
                        title="Create EBS snapshot policy"
                        desc="Create a policy that automates the creation, retention, and deletion of EBS snapshots."
                        btnText="Create policy"
                        icon={HardDrive}
                        href={snapshotUrl}
                      />
                      <ConfigurationCard
                        title="Create billing usage alerts"
                        desc="To manage costs and avoid surprise bills, set up email notifications for usage thresholds."
                        btnText="Create alerts"
                        icon={AlertCircle}
                        href={billingUrl}
                      />
                    </div>
                  </div>
                </div>
              )}

              <div className="mt-2 flex items-center justify-between">
                <div className="flex items-center gap-1.5 text-xs text-zinc-500">Last deployed {instance.lastDeploy}</div>
                <div className="flex gap-2">
                  <button
                    onClick={() => setExpandedInstanceId(expandedInstanceId === instance.id ? null : instance.id)}
                    className={`flex h-8 items-center gap-1.5 rounded px-3 text-xs font-medium transition-colors ${
                      expandedInstanceId === instance.id
                        ? 'border border-white bg-white text-black'
                        : 'border border-[#262626] bg-[#111111] text-zinc-300 hover:bg-[#1A1A1A]'
                    }`}
                  >
                    {expandedInstanceId === instance.id ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />} Details
                  </button>
                  <div className="mx-1 h-5 w-px self-center bg-[#262626]" />
                  <button
                    onClick={() => openInstanceTerminal(instance)}
                    className="flex h-8 items-center gap-2 rounded border border-[#262626] bg-[#111111] px-3 text-xs font-medium text-zinc-300 transition-colors hover:bg-white hover:text-black"
                  >
                    <TerminalSquare className="h-3.5 w-3.5" /> Terminal
                  </button>
                  <button
                    onClick={() => void handleRestart(instance)}
                    disabled={Boolean(busyActions[`${instance.projectId}:${instance.id}:reboot`])}
                    className="flex h-8 w-8 items-center justify-center rounded border border-[#262626] bg-[#111111] text-zinc-400 transition-colors hover:bg-white hover:text-black disabled:cursor-not-allowed disabled:opacity-50"
                    title="Restart"
                  >
                    <RotateCw className="h-3.5 w-3.5" />
                  </button>
                  <button
                    onClick={() => void handleTogglePower(instance)}
                    disabled={Boolean(busyActions[`${instance.projectId}:${instance.id}:${instance.status === 'running' ? 'stop' : 'start'}`])}
                    className="flex h-8 w-8 items-center justify-center rounded border border-[#262626] bg-[#111111] text-zinc-400 transition-colors hover:bg-white hover:text-black disabled:cursor-not-allowed disabled:opacity-50"
                    title="Stop/Start"
                  >
                    <Power className="h-3.5 w-3.5" />
                  </button>
                  <button
                    onClick={() => void handleDestroy(instance)}
                    disabled={Boolean(busyActions[`${instance.projectId}:${instance.id}:destroy`])}
                    className="ml-2 flex h-8 w-8 items-center justify-center rounded border border-[#262626] bg-[#111111] text-zinc-400 transition-colors hover:bg-white hover:text-black disabled:cursor-not-allowed disabled:opacity-50"
                    title="Destroy"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
                  </>
                );
              })()}
            </div>
          ))}
          {instances.length === 0 && (
            <div className="rounded-lg border border-dashed border-[#1A1A1A] bg-[#050505] p-8 text-center text-sm text-zinc-500">No managed instances found yet. Run a deployment first.</div>
          )}
        </div>

        <div className="lg:col-span-1">
          <div className="sticky top-4 flex h-[calc(100vh-220px)] flex-col rounded-xl border border-[#1A1A1A] bg-[#050505]">
            <div className="flex items-center gap-2 border-b border-[#1A1A1A] p-4">
              <HistoryIcon className="h-4 w-4 text-white" />
              <h3 className="text-sm font-semibold text-white">Deployment History</h3>
            </div>

            <div className="custom-scrollbar flex-1 overflow-y-auto p-5">
              <div className="relative space-y-6 before:absolute before:inset-0 before:ml-2.75 before:h-full before:w-0.5 before:-translate-x-px before:bg-linear-to-b before:from-transparent before:via-[#333333] before:to-transparent md:before:mx-auto md:before:translate-x-0">
                {deploymentHistory.map((log) => (
                  <div key={log.id} className="relative flex items-start gap-4">
                    <div className={`absolute left-0 z-10 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-4 border-[#050505] ${log.status === 'success' ? 'bg-white' : 'border border-white bg-black'}`}>
                      {log.status === 'success' ? <CheckCircle2 className="h-3 w-3 text-black" /> : <AlertCircle className="h-3 w-3 text-white" />}
                    </div>

                    <div className="ml-8 w-full rounded-lg border border-[#262626] bg-[#0A0A0A] p-3">
                      <div className="mb-1 flex items-start justify-between">
                        <span className="text-xs font-bold text-white">{log.repo}</span>
                        <span className="whitespace-nowrap text-[10px] text-zinc-500">{log.time}</span>
                      </div>
                      <p className="mb-2 text-[11px] text-zinc-400">
                        Deployed branch <span className="font-mono text-zinc-300">{log.branch}</span> • <span className="font-mono text-white">{log.commit}</span>
                      </p>
                      <div className="flex items-center gap-1.5 text-[10px] font-medium text-zinc-500">
                        <User className="h-3 w-3" /> by {log.user}
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              <button className="mt-6 w-full rounded border border-[#262626] bg-transparent py-2 text-xs font-semibold text-zinc-300 transition-colors hover:bg-white hover:text-black">
                Load More Activity
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );

  if (embedded) {
    return (
      <>
        {renderManageInstancesView()}
        <style
          dangerouslySetInnerHTML={{
            __html: `
              @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');

              .custom-scrollbar::-webkit-scrollbar {
                width: 6px;
              }
              .custom-scrollbar::-webkit-scrollbar-track {
                background: transparent;
              }
              .custom-scrollbar::-webkit-scrollbar-thumb {
                background-color: #262626;
                border-radius: 10px;
              }
              .custom-scrollbar::-webkit-scrollbar-thumb:hover {
                background-color: #3f3f46;
              }
              @keyframes fadeIn {
                from { opacity: 0; transform: translateY(-5px); }
                to { opacity: 1; transform: translateY(0); }
              }
              .animate-fade-in {
                animation: fadeIn 0.25s ease-out forwards;
              }
            `,
          }}
        />
      </>
    );
  }

  return (
    <div
      className="flex h-screen bg-[#000000] text-zinc-300 selection:bg-white selection:text-black"
      style={{ fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" }}
    >
      <aside className="flex w-64 shrink-0 flex-col border-r border-[#1A1A1A] bg-[#050505]">
        <div className="flex h-16 items-center gap-3 border-b border-[#1A1A1A] px-6">
          <div className="flex h-7 w-7 items-center justify-center rounded border border-[#333333] bg-[#0A0A0A]">
            <Server className="h-4 w-4 text-white" />
          </div>
          <span className="text-sm font-bold tracking-wide text-white">DEPL_AI</span>
        </div>

        <nav className="flex-1 space-y-1 px-3 py-6">
          <button
            onClick={() => setActiveTab('overview')}
            className={`w-full rounded-lg border px-3 py-2.5 text-sm font-medium transition-all ${
              activeTab === 'overview'
                ? 'border-[#262626] bg-[#111111] text-white'
                : 'border-transparent text-zinc-400 hover:bg-[#0A0A0A] hover:text-zinc-200'
            }`}
          >
            <span className="flex items-center gap-3">
              <LayoutGrid className="h-4 w-4" />
              Overview
            </span>
          </button>

          <button
            onClick={() => setActiveTab('deployments')}
            className={`relative w-full rounded-lg border px-3 py-2.5 text-sm font-medium transition-all ${
              activeTab === 'deployments'
                ? 'border-[#262626] bg-[#111111] text-white'
                : 'border-transparent text-zinc-400 hover:bg-[#0A0A0A] hover:text-zinc-200'
            }`}
          >
            {activeTab === 'deployments' && <div className="absolute bottom-1.5 left-0 top-1.5 w-1 rounded-r-md bg-white shadow-[0_0_10px_rgba(255,255,255,0.5)]" />}
            <span className="flex items-center gap-3">
              <Rocket className="h-4 w-4" />
              Deployments
            </span>
          </button>

          <button
            onClick={() => setActiveTab('manage_instances')}
            className={`relative w-full rounded-lg border px-3 py-2.5 text-sm font-medium transition-all ${
              activeTab === 'manage_instances'
                ? 'border-[#262626] bg-[#111111] text-white'
                : 'border-transparent text-zinc-400 hover:bg-[#0A0A0A] hover:text-zinc-200'
            }`}
          >
            {activeTab === 'manage_instances' && <div className="absolute bottom-1.5 left-0 top-1.5 w-1 rounded-r-md bg-white shadow-[0_0_10px_rgba(255,255,255,0.5)]" />}
            <span className="flex items-center gap-3">
              <HardDrive className="h-4 w-4" />
              Manage Instance
            </span>
          </button>

          <button
            onClick={() => setActiveTab('settings')}
            className={`w-full rounded-lg border px-3 py-2.5 text-sm font-medium transition-all ${
              activeTab === 'settings'
                ? 'border-[#262626] bg-[#111111] text-white'
                : 'border-transparent text-zinc-400 hover:bg-[#0A0A0A] hover:text-zinc-200'
            }`}
          >
            <span className="flex items-center gap-3">
              <Settings className="h-4 w-4" />
              Settings
            </span>
          </button>
        </nav>

        <div className="border-t border-[#1A1A1A] p-4">
          <div className="flex cursor-pointer items-center gap-3 rounded-lg px-2 py-2 transition-colors hover:bg-[#111111]">
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-zinc-200">
              <div className="flex h-6 w-6 items-center justify-center rounded-full bg-black/10 text-xs font-bold text-black">A</div>
            </div>
            <div className="flex-1 overflow-hidden">
              <p className="truncate text-sm font-bold text-white">adityajayashankar</p>
              <div className="mt-0.5 flex items-center gap-1 text-[11px] text-zinc-500">
                <LogOut className="h-3 w-3" />
                <span>Sign out</span>
              </div>
            </div>
          </div>
        </div>
      </aside>

      <main className="flex h-full flex-1 flex-col overflow-hidden bg-[#000000]">
        <header className="flex h-16 items-center justify-between border-b border-[#1A1A1A] px-8">
          <div className="flex items-center gap-2 text-[13px] text-zinc-500">
            <span className="cursor-pointer transition-colors hover:text-zinc-300" onClick={() => router.push('/dashboard')}>Dashboard</span>
            <span className="text-zinc-700">/</span>
            <span className="font-medium text-white">{activeTab === 'manage_instances' ? 'Manage Instance' : 'Command Center'}</span>
          </div>

          <div className="flex items-center gap-3">
            <button className="flex items-center gap-2 rounded-md border border-[#262626] bg-[#0A0A0A] px-3 py-1.5 text-[13px] font-bold text-zinc-300 transition-all hover:bg-white hover:text-black">
              <Server className="h-3.5 w-3.5" />
              Manage Org
            </button>
            <div className="mx-1 h-4 w-px bg-[#262626]" />
            <button
              onClick={() => void loadProjects(true)}
              className="rounded-md p-1.5 text-zinc-500 transition-all hover:bg-white hover:text-black"
              title="Refresh"
            >
              <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
            </button>
          </div>
        </header>

        {activeTab === 'deployments' && renderDeploymentsView()}
        {activeTab === 'manage_instances' && renderManageInstancesView()}
        {activeTab === 'overview' && <div className="flex flex-1 items-center justify-center font-medium text-zinc-600">Overview Panel (Coming Soon)</div>}
        {activeTab === 'settings' && <div className="flex flex-1 items-center justify-center font-medium text-zinc-600">Settings Panel (Coming Soon)</div>}
      </main>

      <style
        dangerouslySetInnerHTML={{
          __html: `
            @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');

            .custom-scrollbar::-webkit-scrollbar {
              width: 6px;
            }
            .custom-scrollbar::-webkit-scrollbar-track {
              background: transparent;
            }
            .custom-scrollbar::-webkit-scrollbar-thumb {
              background-color: #262626;
              border-radius: 10px;
            }
            .custom-scrollbar::-webkit-scrollbar-thumb:hover {
              background-color: #3f3f46;
            }
            @keyframes fadeIn {
              from { opacity: 0; transform: translateY(-5px); }
              to { opacity: 1; transform: translateY(0); }
            }
            .animate-fade-in {
              animation: fadeIn 0.25s ease-out forwards;
            }
          `,
        }}
      />
    </div>
  );
}

function HistoryIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg
      {...props}
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
      <path d="M3 3v5h5" />
      <path d="M12 7v5l4 2" />
    </svg>
  );
}
