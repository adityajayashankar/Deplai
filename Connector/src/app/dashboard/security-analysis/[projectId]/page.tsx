'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import * as THREE from 'three';
import {
  AlertCircle,
  Bot,
  ChevronDown,
  ExternalLink,
  Eye,
  FileCode2,
  FileJson,
  GitPullRequest,
  RefreshCw,
  ScanSearch,
  Shield,
  ShieldCheck,
  Sparkles,
  TerminalSquare,
} from 'lucide-react';
import { useScan, type VulnStatus } from '@/lib/scan-context';
import { WorkspaceShell } from '@/features/workspace/WorkspaceNav';
import { SecurityStageRail } from '@/features/workspace/SecurityStageRail';
import {
  ApiExplorer,
  AssetExplorer,
  AttackPathExplorer,
  CloudExplorer,
  DynamicTestingExplorer,
  FindingTable,
  InfrastructureExplorer,
  PipelineConfig,
  RemediationModelPicker,
  RiskExplorer,
  RiskScore,
  ScanProgress,
  ScanReportDownloadButton,
  SecretsExplorer,
  SecurityKPI,
  SecurityModuleGrid,
  SupplyChainExplorer,
  defaultEnabledModules,
  mergeModules,
  modulesForScan,
  looksLikePublicHttpUrl,
  parseModuleEvents,
  pipelineModulesSettled,
  pipelineProducedWork,
  uniqueFindingIds,
  RESULTS_SURFACES,
  type FindingCategory,
  type RemediationModelValue,
  type ResultsSurface,
  type ScanResultsPayload,
  type SecurityModuleId,
  type UnifiedFinding,
} from '@/features/security';
import { readStoredDastAsset, readStoredDastTarget, storeDastAsset, storeDastTarget } from '@/features/security/dastTarget';
import { projectHasSuccessfulDeploy, readSavedAws, writeSavedAws } from '@/features/deployment/state';
import { UnifiedDiffStats, UnifiedDiffViewer } from '@/components/diff/UnifiedDiffViewer';
import { appBtnInk, appBtnPaper, appInput, secPaper } from '@/features/workspace/theme';

type PipelineStageId = 'scan' | 'results' | 'remediate_setup' | 'remediate_run' | 'approval' | 'pr_rescan';

const SIDEBAR_STAGES: Array<{ id: PipelineStageId; label: string; details: string }> = [
  { id: 'scan', label: 'Scan', details: 'Repository validation' },
  { id: 'results', label: 'Results', details: 'Findings & KPIs' },
  { id: 'remediate_setup', label: 'Agent setup', details: 'Configure remediation agent' },
  { id: 'remediate_run', label: 'Remediation', details: 'Live agent patching' },
  { id: 'approval', label: 'Review', details: 'Diff validation gate' },
  { id: 'pr_rescan', label: 'GitHub & verify', details: 'PR push & verification' },
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
const REMEDIATION_DEFAULT_MODEL = '';

const EMPTY_STATS = { total: 0, critical: 0, high: 0, medium: 0, low: 0, autoFixable: 0 };

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

interface ScanResults extends ScanResultsPayload {
  supply_chain: SupplyChainVuln[];
  code_security: CWEGroup[];
}

interface ScanStats {
  total: number;
  critical: number;
  high: number;
  medium: number;
  low: number;
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

function computeStats(data: ScanResults): ScanStats {
  const sc = Array.isArray(data.supply_chain) ? data.supply_chain : [];
  const cs = Array.isArray(data.code_security) ? data.code_security : [];
  const findings = Array.isArray(data.findings) ? data.findings : [];
  const autoFixable = sc.filter((item) => item.fix_version !== null).length;
  if (data.posture) {
    return {
      total: data.posture.total,
      critical: data.posture.critical,
      high: data.posture.high,
      medium: data.posture.medium,
      low: data.posture.low,
      autoFixable,
    };
  }
  if (findings.length > 0) {
    const count = (severity: string) => findings.filter((item) => String(item.severity || '').toLowerCase() === severity).length;
    return {
      total: findings.length,
      critical: count('critical'),
      high: count('high'),
      medium: count('medium'),
      low: count('low'),
      autoFixable,
    };
  }
  return {
    total: sc.length + cs.reduce((sum, group) => sum + Number(group.count || 0), 0),
    critical:
      sc.filter((item) => item.severity.toLowerCase() === 'critical').length +
      cs.filter((item) => item.severity.toLowerCase() === 'critical').reduce((sum, group) => sum + Number(group.count || 0), 0),
    high:
      sc.filter((item) => item.severity.toLowerCase() === 'high').length +
      cs.filter((item) => item.severity.toLowerCase() === 'high').reduce((sum, group) => sum + Number(group.count || 0), 0),
    medium:
      sc.filter((item) => item.severity.toLowerCase() === 'medium').length +
      cs.filter((item) => item.severity.toLowerCase() === 'medium').reduce((sum, group) => sum + Number(group.count || 0), 0),
    low:
      sc.filter((item) => item.severity.toLowerCase() === 'low').length +
      cs.filter((item) => item.severity.toLowerCase() === 'low').reduce((sum, group) => sum + Number(group.count || 0), 0),
    autoFixable,
  };
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
        className="absolute inset-0 rounded-[inherit] -z-1"
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
        } as CSSProperties}
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
        } as CSSProperties}
      >
        <span className="absolute rounded-[inherit]" style={{ inset: `${glowRadius}px`, boxShadow: buildBoxShadow(glowColor, glowIntensity) }} />
      </span>
      <div className="relative z-1 flex h-full w-full flex-col">{children}</div>
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
        className={`h-full w-full rounded-none transition-all ${
          disabled
            ? 'cursor-not-allowed border-[3px] border-black bg-white opacity-50'
            : 'cursor-pointer border-[3px] border-black bg-black shadow-[4px_4px_0_0_#000] hover:translate-x-0.5 hover:translate-y-0.5 hover:shadow-none'
        }`}
      >
        <button
          type="button"
          onClick={disabled ? undefined : onClick}
          disabled={disabled}
          className={`flex h-full w-full items-center justify-center gap-2 text-sm font-semibold outline-none transition-colors ${
            disabled ? 'text-neutral-400' : 'text-white'
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
    <div className={`flex min-h-70 items-center justify-center ${secPaper}`}>
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
      ? 'text-rose-800'
      : tone === 'warning'
        ? 'text-amber-800'
        : 'text-emerald-800';
  return (
    <div className={`${secPaper} p-5 ${toneClasses}`}>
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
  if (setupOpen && hasScanOutcome && hasVulnerabilities) return 'remediate_setup';
  if (approvalSent || remediationState === 'completed') return 'pr_rescan';
  if (remediationState === 'waiting_decision' || remediationState === 'waiting_approval') return 'approval';
  if (remediationState === 'running' || remediationState === 'error') return 'remediate_run';
  if (hasScanOutcome || scanState === 'completed') return 'results';
  return 'scan';
}

export default function SecurityAnalysisPage() {
  const router = useRouter();
  const params = useParams();
  const searchParams = useSearchParams();
  const projectId = params.projectId as string;
  const runAll = searchParams.get('runAll') === '1';
  const customizationSnapshotId = (searchParams.get('customizationSnapshotId') || '').trim();
  const tenantId = (searchParams.get('tenantId') || '').trim();

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
  } = useScan();
  const [agentModel, setAgentModel] = useState<RemediationModelValue>({
    accessMode: 'platform',
    model: REMEDIATION_DEFAULT_MODEL,
    provider: null,
    credentialId: null,
    ready: false,
    blockedReason: 'Loading model options…',
    sourceLabel: 'Platform',
  });

  const { state: scanState, messages: scanMessages, projectName: scanProjectName } = getScanState(projectId);
  const { state: remediationState, messages: remMessages } = getRemediationState(projectId);

  const [projectName, setProjectName] = useState<string>(scanProjectName || projectId);
  const [projectMeta, setProjectMeta] = useState<ProjectMeta | null>(null);
  const [loadingProject, setLoadingProject] = useState(true);
  const [projectAuthError, setProjectAuthError] = useState<string | null>(null);

  const [vulnStatus, setVulnStatus] = useState<VulnStatus>('not_initiated');
  const [results, setResults] = useState<ScanResults | null>(null);
  const [scanStats, setScanStats] = useState<ScanStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingResults, setLoadingResults] = useState(false);
  const [scanActive, setScanActive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rerunInProgress, setRerunInProgress] = useState(false);
  const [verificationScanRequested, setVerificationScanRequested] = useState(false);

  const [setupOpen, setSetupOpen] = useState(false);
  const [githubToken, setGithubToken] = useState('');
  const [approved, setApproved] = useState(false);
  const [locallyApproved, setLocallyApproved] = useState(false);
  const [prUrl, setPrUrl] = useState<string | null>(null);
  const [selectedDiffPath, setSelectedDiffPath] = useState<string | null>(null);
  const [activeStage, setActiveStage] = useState<PipelineStageId>('scan');
  const [resultsSurface, setResultsSurface] = useState<ResultsSurface>('overview');
  const [findingsCategory, setFindingsCategory] = useState<FindingCategory | 'all'>('all');
  const [resultsQuery, setResultsQuery] = useState('');
  const [resultsSeverity, setResultsSeverity] = useState<'all' | 'critical' | 'high' | 'medium' | 'low'>('all');
  const [enabledModules, setEnabledModules] = useState<SecurityModuleId[]>(defaultEnabledModules);
  const [dastTargetUrl, setDastTargetUrl] = useState('');
  const [dastAssetId, setDastAssetId] = useState('');
  const [dastProfile, setDastProfile] = useState<'BASELINE' | 'FULL' | 'API'>('BASELINE');
  const setDastTarget = useCallback((value: string, assetId?: string) => {
    setDastTargetUrl(value);
    storeDastTarget(projectId, value);
    if (assetId !== undefined) {
      setDastAssetId(assetId);
      storeDastAsset(projectId, assetId);
    }
    if (value.trim()) {
      setEnabledModules((current) => (current.includes('dast') ? current : [...current, 'dast']));
    }
  }, [projectId]);
  const [expandedFindingId, setExpandedFindingId] = useState<string | null>(null);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    const surface = searchParams.get('surface') as ResultsSurface | null;
    if (surface && RESULTS_SURFACES.some((item) => item.id === surface)) {
      setResultsSurface(surface);
    }
    const target = (searchParams.get('dastTarget') || readStoredDastTarget(projectId)).trim();
    const asset = (searchParams.get('dastAsset') || readStoredDastAsset(projectId)).trim();
    const profile = searchParams.get('dastProfile');
    setDastTargetUrl(target);
    setDastAssetId(asset);
    if (profile === 'FULL' || profile === 'API' || profile === 'BASELINE') {
      setDastProfile(profile);
    }
    if (target) {
      setEnabledModules((current) => (current.includes('dast') ? current : [...current, 'dast']));
    }
  }, [projectId, searchParams]);
  const [lastResultsSyncAt, setLastResultsSyncAt] = useState<string | null>(null);
  const [projectOptions, setProjectOptions] = useState<Array<{ id: string; name: string }>>([]);

  const scanLogEndRef = useRef<HTMLDivElement>(null);
  const remediateLogEndRef = useRef<HTMLDivElement>(null);
  const fetchVersionRef = useRef(0);
  const userStartedScanRef = useRef(false);
  const dastAutoStartRef = useRef(false);
  const cloudAutoStartRef = useRef(false);
  const scopedRunRef = useRef<SecurityModuleId[] | null>(null);
  const [scopedRun, setScopedRun] = useState<SecurityModuleId[] | null>(null);
  const scanStateRef = useRef(scanState);
  const modulesSettledRef = useRef(false);
  scanStateRef.current = scanState;


  useEffect(() => {
    scanLogEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [scanActive, scanMessages.length]);

  useEffect(() => {
    remediateLogEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [remMessages.length]);

  useEffect(() => {
    let cancelled = false;
    async function loadProjects() {
      try {
        const res = await fetch('/api/projects', { cache: 'no-store' });
        const data = (await res.json().catch(() => ({}))) as { projects?: Array<{ id: string; name: string }> };
        if (cancelled) return;
        const projects = Array.isArray(data.projects) ? data.projects : [];
        setProjectOptions(projects.map((p) => ({ id: p.id, name: p.name || p.id })));
      } catch {
        if (!cancelled) setProjectOptions([]);
      }
    }
    void loadProjects();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function fetchProject() {
      setLoadingProject(true);
      setProjectMeta(null);
      setProjectAuthError(null);
      try {
        const res = await fetch(`/api/projects/${projectId}`, { cache: 'no-store' });
        const data = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (!res.ok) {
          const message = res.status === 401
            ? 'Your session is not authorized for this project. Sign in again from the dashboard, then retry remediation.'
            : res.status === 403 || res.status === 404
              ? 'This project could not be verified for your account. Reopen it from the dashboard before running remediation.'
              : String(data?.error || 'Failed to load project metadata.');
          setProjectAuthError(message);
          setProjectName(scanProjectName || projectId);
          return;
        }
        const project = data?.project;
        if (!project) {
          setProjectAuthError('Project metadata response was empty. Reopen the project from the dashboard before running remediation.');
          return;
        }
        setProjectName(project.name || project.full_name || project.id || projectId);
        setProjectMeta({
          type: project.type === 'github' ? 'github' : 'local',
          installationId: project.installationId,
          owner: project.owner,
          repo: project.repo,
          branch: project.branch,
        });
        setProjectAuthError(null);
      } catch {
        if (!cancelled) {
          setProjectName(scanProjectName || projectId);
          setProjectAuthError('Project metadata could not be loaded. Check your session and reopen the project from the dashboard.');
        }
      } finally {
        if (!cancelled) setLoadingProject(false);
      }
    }
    void fetchProject();
    return () => {
      cancelled = true;
    };
  }, [projectId, scanProjectName]);

  useEffect(() => {
    userStartedScanRef.current = false;
    setScanActive(false);
    setVerificationScanRequested(false);
  }, [projectId]);

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
      const applyResults = async (nextStatus: VulnStatus) => {
        setLoading(false);
        setLoadingResults(true);
        const resultsRes = await fetch(`/api/scan/results?project_id=${encodeURIComponent(projectId)}`, {
          cache: 'no-store',
          signal: AbortSignal.timeout(30_000),
        });
        if (!resultsRes.ok) {
          if (nextStatus === 'not_found') {
            setResults(null);
            setScanStats(EMPTY_STATS);
            setCachedResults(projectId, { status: nextStatus, data: null });
            setLoadingResults(false);
            setLastResultsSyncAt(new Date().toISOString());
            setError(null);
            return true;
          }
          const body = (await resultsRes.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error || 'Failed to fetch scan results');
        }
        const resultsPayload = (await resultsRes.json()) as { data?: ScanResults };
        if (requestId !== fetchVersionRef.current) return true;
        const nextResults = resultsPayload.data || { supply_chain: [], code_security: [] };
        const derivedStatus: VulnStatus = nextStatus === 'found' || nextStatus === 'not_found'
          ? nextStatus
          : (
            (Array.isArray(nextResults.findings) && nextResults.findings.length > 0)
            || (nextResults.supply_chain?.length || 0) > 0
            || (nextResults.code_security?.length || 0) > 0
            || (nextResults.secrets?.length || 0) > 0
            || (nextResults.iac?.length || 0) > 0
            || (nextResults.containers?.length || 0) > 0
              ? 'found'
              : 'not_found'
          );
        setVulnStatus(derivedStatus);
        setResults(nextResults);
        setScanStats(computeStats(nextResults));
        setCachedResults(projectId, { status: derivedStatus, data: nextResults });
        setLoadingResults(false);
        setLastResultsSyncAt(new Date().toISOString());
        setError(null);
        return true;
      };

      try {
        const statusRes = await fetch(`/api/scan/status?project_id=${encodeURIComponent(projectId)}`, {
          cache: 'no-store',
          signal: AbortSignal.timeout(15_000),
        });
        const statusPayload = (await statusRes.json().catch(() => ({}))) as { status?: VulnStatus | 'running' | 'error'; detail?: string };
        if (requestId !== fetchVersionRef.current) return;

        const rawStatus = statusPayload.status || 'not_initiated';
        const finishedLocally = scanStateRef.current === 'completed'
          || scanStateRef.current === 'error'
          || modulesSettledRef.current;

        if (rawStatus === 'running' && !finishedLocally) {
          // Only attach to a live backend scan after this visit's Scan click.
          // Leftover agentic runs should not make opening Security Agent look like a new scan started.
          if (userStartedScanRef.current) {
            setScanActive(true);
          } else {
            setScanActive(false);
          }
          setLoading(false);
          setLoadingResults(false);
          return;
        }

        setScanActive(false);

        if (rawStatus === 'found' || rawStatus === 'not_found') {
          setVulnStatus(rawStatus);
          await applyResults(rawStatus);
          return;
        }

        if (finishedLocally || rawStatus === 'error') {
          try {
            await applyResults('not_initiated');
            return;
          } catch (loadError) {
            setLoading(false);
            setLoadingResults(false);
            if (options?.trackError) {
              setError(
                rawStatus === 'error'
                  ? (statusPayload.detail || 'Unexpected scan status error')
                  : (loadError instanceof Error ? loadError.message : 'Failed to load scan results'),
              );
            }
            return;
          }
        }

        setResults(null);
        setScanStats(null);
        setVulnStatus('not_initiated');
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
        if (cached.data) {
          const cachedResults = cached.data as ScanResults;
          setResults(cachedResults);
          setScanStats(computeStats(cachedResults));
        } else {
          setResults(null);
          setScanStats(EMPTY_STATS);
        }
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
    if (!verificationScanRequested) {
      setLocallyApproved(false);
      setApproved(false);
      setPrUrl(null);
    }
    setError(null);
    if (!scopedRunRef.current) {
      setResults(null);
      setScanStats(null);
      setVulnStatus('not_initiated');
    }
    setLoading(false);
    setLoadingResults(false);
    setScanActive(false);
  }, [scanState, verificationScanRequested]);

  useEffect(() => {
    if (!scanActive || !projectId || scanState === 'running') return;
    const intervalId = window.setInterval(() => {
      void fetchStatusAndResults();
    }, 4000);
    return () => window.clearInterval(intervalId);
  }, [fetchStatusAndResults, projectId, scanActive, scanState]);

  const liveModules = useMemo(() => parseModuleEvents(scanMessages), [scanMessages]);
  const modulesSettled = useMemo(() => pipelineModulesSettled(liveModules), [liveModules]);
  const scanProducedWork = useMemo(() => pipelineProducedWork(liveModules), [liveModules]);
  modulesSettledRef.current = modulesSettled;

  useEffect(() => {
    const scanFinished = scanState === 'completed'
      || modulesSettled
      || (scanState === 'error' && scanProducedWork);
    if (!projectId || !scanFinished) return;
    const cached = getCachedResults(projectId);
    if (cached) return;
    setLoading(true);
    setError(null);
    void fetchStatusAndResults({ trackError: true });
  }, [fetchStatusAndResults, getCachedResults, modulesSettled, projectId, scanProducedWork, scanState]);

  useEffect(() => {
    if (!projectId || remediationState !== 'completed') return;
    void fetchPrUrl();
  }, [fetchPrUrl, projectId, remediationState]);

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

  const hasScanOutcome = useMemo(() => (
    vulnStatus !== 'not_initiated'
    || scanState === 'completed'
    || results !== null
    || loadingResults
    || modulesSettled
    || (scanState === 'error' && scanProducedWork)
  ), [loadingResults, modulesSettled, results, scanProducedWork, scanState, vulnStatus]);
  const deploymentPath = useMemo(
    () => {
      const query = new URLSearchParams({ projectId, entry: 'run-all' });
      if (customizationSnapshotId) {
        query.set('customizationSnapshotId', customizationSnapshotId);
      }
      if (tenantId) {
        query.set('tenantId', tenantId);
      }
      return `/dashboard/deploy?${query.toString()}`;
    },
    [customizationSnapshotId, projectId, tenantId],
  );
  const canProceedToDeployment = useMemo(
    () => hasScanOutcome && !loading && !loadingResults && scanState !== 'running',
    [hasScanOutcome, loading, loadingResults, scanState],
  );
  const hasVulnerabilities = useMemo(() => {
    if (!results) return vulnStatus === 'found';
    if (Array.isArray(results.findings) && results.findings.length > 0) return true;
    return (results.supply_chain?.length || 0) > 0 || (results.code_security?.length || 0) > 0
      || (results.secrets?.length || 0) > 0 || (results.iac?.length || 0) > 0 || (results.containers?.length || 0) > 0
      || (results.kubernetes?.length || 0) > 0 || (results.cicd?.length || 0) > 0 || (results.api?.length || 0) > 0
      || (results.dast?.length || 0) > 0;
  }, [results, vulnStatus]);
  const unifiedFindings = useMemo<UnifiedFinding[]>(() => (
    uniqueFindingIds(Array.isArray(results?.findings) ? results.findings : [])
  ), [results]);
  const pipelineModules = useMemo(
    () => mergeModules(results?.modules, liveModules, {
      scanning: scanState === 'running' || scanActive,
      scopedTo: (scanState === 'running' || scanActive) ? scopedRun : null,
    }),
    [liveModules, results?.modules, scanActive, scanState, scopedRun],
  );
  const scannerLogMessages = useMemo(
    () => scanMessages.filter((message) => message.type !== 'module'),
    [scanMessages],
  );
  const remediatingThisProject = remediationState === 'running';
  const remediationFinished = remediationState === 'completed';
  const remediationCanStart = !['running', 'waiting_decision', 'waiting_approval'].includes(remediationState);
  const projectAccessReady = Boolean(projectMeta) && !loadingProject && !projectAuthError;
  const canOpenRemediationSetup = projectAccessReady && hasVulnerabilities && scanState !== 'running' && remediationCanStart;
  const canLaunchRemediation = canOpenRemediationSetup;

  useEffect(() => {
    if (activeStage !== 'results' || !hasScanOutcome || (scanState === 'running' && !modulesSettled)) return;
    const intervalId = window.setInterval(() => {
      void fetchStatusAndResults();
    }, RESULTS_HEARTBEAT_MS);
    return () => window.clearInterval(intervalId);
  }, [activeStage, fetchStatusAndResults, hasScanOutcome, modulesSettled, scanState]);

  const baseStage = inferBaseStage({
    setupOpen,
    approvalSent,
    remediationState,
    hasScanOutcome,
    hasVulnerabilities,
    scanState,
  });
  const canOpenResults = hasScanOutcome && (scanState !== 'running' || modulesSettled);
  const maxUnlockedIndex = useMemo(() => {
    const indices = [
      STAGE_INDEX[baseStage],
      STAGE_INDEX[activeStage],
      canOpenResults ? STAGE_INDEX.results : STAGE_INDEX.scan,
      canOpenRemediationSetup ? STAGE_INDEX.remediate_setup : STAGE_INDEX.scan,
    ];
    if (activeStage === 'remediate_run') {
      indices.push(STAGE_INDEX.remediate_run);
    }
    if (['running', 'error', 'waiting_decision', 'waiting_approval'].includes(remediationState)) {
      indices.push(STAGE_INDEX.remediate_run);
    }
    if (remediationState === 'waiting_decision' || remediationState === 'waiting_approval') {
      indices.push(STAGE_INDEX.approval);
    }
    if (approvalSent || remediationState === 'completed') {
      indices.push(STAGE_INDEX.pr_rescan);
    }
    return Math.max(...indices);
  }, [
    activeStage,
    approvalSent,
    baseStage,
    canOpenRemediationSetup,
    canOpenResults,
    remediationState,
  ]);

  useEffect(() => {
    if (STAGE_INDEX[activeStage] > maxUnlockedIndex) {
      setActiveStage(baseStage);
    }
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
    setSetupOpen(stageId === 'remediate_setup');
    setActiveStage(stageId);
  }, [maxUnlockedIndex]);

  const handleSelectModule = useCallback((id: SecurityModuleId) => {
    if (!canOpenResults) return;
    setActiveStage('results');
    if (id === 'sbom') {
      setResultsSurface('supply-chain');
      return;
    }
    if (id === 'secrets') {
      setResultsSurface('secrets');
      setFindingsCategory('secrets');
      return;
    }
    if (id === 'iac' || id === 'containers' || id === 'kubernetes' || id === 'cicd') {
      setResultsSurface('infrastructure');
      setFindingsCategory(id);
      return;
    }
    if (id === 'api') {
      setResultsSurface('apis');
      setFindingsCategory('api');
      return;
    }
    if (id === 'dast') {
      setResultsSurface('dynamic');
      setFindingsCategory('dast');
      return;
    }
    if (id === 'cloud') {
      setResultsSurface('cloud');
      setFindingsCategory('cloud');
      return;
    }
    setResultsSurface('findings');
    setFindingsCategory(id);
  }, [canOpenResults]);

  const handleStartScan = useCallback(async (options?: {
    dastOnly?: boolean;
    cloudOnly?: boolean;
    target?: string;
    assetId?: string;
    profile?: 'BASELINE' | 'FULL' | 'API';
    aws?: {
      aws_access_key_id: string;
      aws_secret_access_key: string;
      aws_session_token: string;
      aws_region: string;
    };
  }) => {
    if (loadingProject) {
      setError('Project metadata is still loading. Wait a moment, then retry.');
      return;
    }

    if (!projectMeta || projectAuthError) {
      setError(projectAuthError || 'Project access could not be verified.');
      return;
    }

    if (scanState === 'running' || rerunInProgress) return;

    const target = (options?.target ?? dastTargetUrl).trim();
    const assetId = (options?.assetId ?? dastAssetId).trim();
    const profile = options?.profile || dastProfile;
    if (options?.dastOnly && !assetId && !target) {
      setError('Verify a project target before running dynamic testing.');
      return;
    }
    if (target && !looksLikePublicHttpUrl(target) && !assetId) {
      setError('Dynamic testing only accepts a public http(s) URL you own. Internal and localhost addresses are rejected.');
      return;
    }
    if (options?.cloudOnly) {
      if (!projectHasSuccessfulDeploy(projectId)) {
        setError('Cloud scanning is available after IaC is configured and deployed for this project.');
        return;
      }
      const aws = options.aws || readSavedAws();
      if (!aws.aws_access_key_id.trim() || !aws.aws_secret_access_key.trim()) {
        setError('Enter the AWS operator credentials used to deploy this project.');
        return;
      }
    }

    const scopedTo: SecurityModuleId[] | null = options?.dastOnly
      ? ['dast']
      : options?.cloudOnly
        ? ['cloud']
        : null;
    scopedRunRef.current = scopedTo;
    setScopedRun(scopedTo);

    userStartedScanRef.current = true;
    setVerificationScanRequested(false);
    setRerunInProgress(true);
    setError(null);
    if (target) setDastTarget(target, assetId);
    if (assetId) {
      setDastAssetId(assetId);
      storeDastAsset(projectId, assetId);
    }

    const aws = options?.cloudOnly ? (options.aws || readSavedAws()) : null;
    if (aws) writeSavedAws(aws);

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
          enabled_modules: options?.dastOnly
            ? ['dast']
            : options?.cloudOnly
              ? ['cloud']
              : modulesForScan(enabledModules, target),
          dast_target_url: options?.cloudOnly ? undefined : (target || undefined),
          dast_asset_id: options?.cloudOnly ? undefined : (assetId || undefined),
          dast_scan_profile: options?.cloudOnly ? undefined : (assetId || target ? profile : undefined),
          aws_access_key_id: aws?.aws_access_key_id || undefined,
          aws_secret_access_key: aws?.aws_secret_access_key || undefined,
          aws_session_token: aws?.aws_session_token || undefined,
          aws_region: aws?.aws_region || undefined,
          customization_snapshot_id: customizationSnapshotId || undefined,
          tenant_id: tenantId || undefined,
        }),
      });

      const validateBody = await validateRes.json().catch(() => ({})) as {
        error?: string;
        code?: string;
        warnings?: Array<{ module?: string; message?: string }>;
      };
      if (!validateRes.ok) {
        throw new Error(validateBody.error || 'Failed to validate scan');
      }

      const dastWarning = validateBody.warnings?.find((item) => item.module === 'dast');
      if (dastWarning?.message) {
        setError(`DAST skipped: ${dastWarning.message} Continuing with SAST/SCA only.`);
      }

      await startScan(projectId, projectName || projectId, (options?.dastOnly || options?.cloudOnly) ? { preserveRemediation: true } : undefined);

      if (!options?.dastOnly && !options?.cloudOnly) {
        resetRemediation(projectId);
      }
      setActiveStage('scan');
      if (options?.dastOnly) {
        setResultsSurface('dynamic');
      }
      if (options?.cloudOnly) {
        setResultsSurface('cloud');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start scan');
    } finally {
      setRerunInProgress(false);
    }
  }, [
    customizationSnapshotId,
    loadingProject,
    projectAuthError,
    projectId,
    projectMeta,
    projectName,
    rerunInProgress,
    resetRemediation,
    scanState,
    startScan,
    tenantId,
    enabledModules,
    dastTargetUrl,
    dastAssetId,
    dastProfile,
    setDastTarget,
  ]);

  useEffect(() => {
    if (searchParams.get('run') !== 'dast') return;
    if (dastAutoStartRef.current) return;
    if (loadingProject || !projectMeta || projectAuthError) return;
    if (scanState === 'running' || rerunInProgress) return;
    const asset = (searchParams.get('dastAsset') || dastAssetId).trim();
    const target = (searchParams.get('dastTarget') || dastTargetUrl).trim();
    if (!asset && !target) return;
    dastAutoStartRef.current = true;
    const next = new URLSearchParams(searchParams.toString());
    next.delete('run');
    const suffix = next.toString();
    router.replace(`/dashboard/security-analysis/${encodeURIComponent(projectId)}${suffix ? `?${suffix}` : ''}`);
    void handleStartScan({ dastOnly: true, target, assetId: asset, profile: dastProfile });
  }, [
    dastTargetUrl,
    handleStartScan,
    loadingProject,
    projectAuthError,
    projectId,
    projectMeta,
    rerunInProgress,
    router,
    scanState,
    searchParams,
  ]);

  useEffect(() => {
    if (searchParams.get('run') !== 'cloud') return;
    if (cloudAutoStartRef.current) return;
    if (loadingProject || !projectMeta || projectAuthError) return;
    if (scanState === 'running' || rerunInProgress) return;
    cloudAutoStartRef.current = true;
    const next = new URLSearchParams(searchParams.toString());
    next.delete('run');
    const suffix = next.toString();
    router.replace(`/dashboard/security-analysis/${encodeURIComponent(projectId)}${suffix ? `?${suffix}` : ''}`);
    void handleStartScan({ cloudOnly: true, aws: readSavedAws() });
  }, [
    handleStartScan,
    loadingProject,
    projectAuthError,
    projectId,
    projectMeta,
    rerunInProgress,
    router,
    scanState,
    searchParams,
  ]);

  const handleStartRemediation = useCallback(async () => {
    const trimmedToken = githubToken.trim();

    if (loadingProject) {
      setError('Project metadata is still loading. Wait a moment, then retry remediation.');
      return;
    }
    if (!projectMeta || projectAuthError) {
      setError(projectAuthError || 'Project access could not be verified. Reopen it from the dashboard, then retry remediation.');
      return;
    }
    if (!canLaunchRemediation) {
      setError('Run a successful scan with current project access before starting remediation.');
      return;
    }
    if (!agentModel.ready) {
      setError(agentModel.blockedReason || 'Choose a platform model or a saved BYOK credential before starting remediation.');
      return;
    }

    setError(null);
    setSetupOpen(false);
    setLocallyApproved(false);
    setApproved(false);
    setPrUrl(null);
    setVerificationScanRequested(false);
    setActiveStage('remediate_run');

    try {
      if (remediationState !== 'idle') {
        resetRemediation(projectId);
      }
      await startRemediation(
        projectId,
        trimmedToken || undefined,
        agentModel.provider || undefined,
        undefined,
        agentModel.model,
        'major',
        agentModel.accessMode,
        agentModel.credentialId || undefined,
      );
      setGithubToken('');
    } catch (remediationError) {
      setError(remediationError instanceof Error ? remediationError.message : 'Failed to start remediation');
    }
  }, [agentModel, canLaunchRemediation, githubToken, loadingProject, projectAuthError, projectId, projectMeta, remediationState, resetRemediation, startRemediation]);

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

  const handleResetRemediation = useCallback(() => {
    resetRemediation(projectId);
    setError(null);
    setSetupOpen(true);
    setLocallyApproved(false);
    setApproved(false);
    setPrUrl(null);
    setSelectedDiffPath(null);
    setActiveStage('remediate_setup');
  }, [projectId, resetRemediation]);

  const handleVerificationRerun = useCallback(async () => {
    if (loadingProject) {
      setError('Project metadata is still loading. Wait a moment, then retry.');
      return;
    }
    if (!projectMeta || projectAuthError) {
      setError(projectAuthError || 'Project access could not be verified.');
      return;
    }
    if (scanState === 'running' || rerunInProgress) return;

    userStartedScanRef.current = true;
    setVerificationScanRequested(true);
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
          enabled_modules: modulesForScan(enabledModules, dastTargetUrl),
          dast_target_url: dastTargetUrl.trim() || undefined,
          dast_asset_id: dastAssetId.trim() || undefined,
          customization_snapshot_id: customizationSnapshotId || undefined,
          tenant_id: tenantId || undefined,
        }),
      });

      if (!validateRes.ok) {
        const body = await validateRes.json().catch(() => ({}));
        throw new Error(body.error || 'Failed to validate scan');
      }

      await startScan(projectId, projectName || projectId, { preserveRemediation: true });
      setActiveStage('pr_rescan');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start verification scan');
    } finally {
      setRerunInProgress(false);
    }
  }, [
    customizationSnapshotId,
    loadingProject,
    projectAuthError,
    projectId,
    projectMeta,
    projectName,
    rerunInProgress,
    scanState,
    startScan,
    tenantId,
    enabledModules,
    dastTargetUrl,
  ]);

  const selectedDiff = useMemo(() => changedFiles.find((item) => item.path === selectedDiffPath) || changedFiles[0] || null, [changedFiles, selectedDiffPath]);

  const scanRunning = scanState === 'running' || scanActive;
  const scanBusy = scanRunning || loadingProject || rerunInProgress;

  const renderSecurityToolbar = () => (
    <div className="mb-8 flex flex-col gap-4 border-b-[3px] border-black pb-8 sm:flex-row sm:items-start sm:justify-between">
      <div>
        <h1 className="font-display text-2xl font-semibold tracking-tight text-black sm:text-[28px]">Security &amp; Remediation</h1>
        <p className="mt-2 max-w-2xl text-[14px] leading-6 text-neutral-600">
          Scan repositories across code, dependencies, secrets, infrastructure, APIs, and authorized dynamic testing.
        </p>
      </div>
      <div className="flex shrink-0 flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative min-w-[220px]">
          <select
            value={projectId}
            onChange={(event) => {
              const nextId = event.target.value;
              if (!nextId || nextId === projectId) return;
              const query = searchParams.toString();
              router.push(`/dashboard/security-analysis/${encodeURIComponent(nextId)}${query ? `?${query}` : ''}`);
            }}
            className={appInput}
          >
            {projectOptions.length === 0 ? (
              <option value={projectId}>{projectName || 'Select repository…'}</option>
            ) : (
              projectOptions.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.name}
                </option>
              ))
            )}
          </select>
          <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-500" />
        </div>
        <button
          type="button"
          onClick={() => void handleStartScan()}
          disabled={scanBusy}
          className={appBtnInk}
        >
          <ScanSearch className="h-4 w-4" />
          {scanRunning ? 'Scanning…' : 'Run scan'}
        </button>
      </div>
    </div>
  );

  const renderScanView = () => {
    const showEmptyState = scanMessages.length === 0 && !scanRunning && !hasScanOutcome;

    return (
      <div className="animate-fade-in space-y-6">
        {error && scanState !== 'running' ? <AlertCard tone="error" title="Scan Error" message={error} /> : null}

        {showEmptyState ? (
          <div className={`flex min-h-[420px] flex-col items-center justify-center ${secPaper} px-8 py-16 text-center`}>
            <div className="mb-6 flex h-16 w-16 items-center justify-center border-[3px] border-black bg-white">
              <Shield className="h-8 w-8 text-black" strokeWidth={1.25} />
            </div>
            <h2 className="font-display text-xl font-semibold text-black">No scan results yet</h2>
            <p className="mt-3 max-w-md text-[14px] leading-6 text-neutral-500">
              Pick a repository, choose pipeline modules, then run a scan. Matching files are scanned; the rest are skipped with a reason.
            </p>
            <div className="mt-8 w-full max-w-2xl text-left">
              <PipelineConfig
                enabled={enabledModules}
                onToggle={(id) => {
                  setEnabledModules((current) => (
                    current.includes(id) ? current.filter((item) => item !== id) : [...current, id]
                  ));
                }}
                dastTargetUrl={dastTargetUrl}
                onDastTargetUrlChange={setDastTarget}
              />
            </div>
            <button
              type="button"
              onClick={() => void handleStartScan()}
              disabled={scanBusy}
              className={`mt-8 ${appBtnPaper}`}
            >
              <ScanSearch className="h-4 w-4" />
              Run first scan
            </button>
          </div>
        ) : (
          <>
            <div>
              <h2 className="mb-1 text-lg font-semibold text-zinc-100">Pipeline modules</h2>
              <p className="mb-4 text-sm text-zinc-500">
                {scopedRun?.length
                  ? `This run is limited to ${scopedRun.join(', ')}. Other scanners are not started.`
                  : 'Live status for this run. Skipped modules mean the project has no matching files or the module was not selected.'}
              </p>
              <div className="space-y-3">
                <ScanProgress modules={pipelineModules} />
                <SecurityModuleGrid modules={pipelineModules} onSelect={handleSelectModule} />
              </div>
            </div>
            {!scanRunning ? (
              <PipelineConfig
                enabled={enabledModules}
                onToggle={(id) => {
                  setEnabledModules((current) => (
                    current.includes(id) ? current.filter((item) => item !== id) : [...current, id]
                  ));
                }}
                dastTargetUrl={dastTargetUrl}
                onDastTargetUrlChange={setDastTarget}
              />
            ) : null}
            <div className={`${secPaper} overflow-hidden`}>
              <div className="flex items-center justify-between border-b-[3px] border-black px-4 py-3">
                <div className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.14em] text-neutral-500">
                  <TerminalSquare className="h-4 w-4" />
                  Scanner output
                </div>
                {scanRunning ? (
                  <span className="relative flex h-2 w-2">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-black opacity-75" />
                    <span className="relative inline-flex h-2 w-2 rounded-full bg-black" />
                  </span>
                ) : null}
              </div>
              <div className="sec-terminal custom-scrollbar max-h-[480px] overflow-y-auto bg-[#0d1117] p-6 font-mono text-[13px] leading-relaxed text-[#e6edf3]">
                {scannerLogMessages.map((message, index) => {
                  const toneClass =
                    message.type === 'success'
                      ? 'text-emerald-400 font-medium'
                      : message.type === 'error'
                        ? 'text-rose-400'
                        : message.type === 'phase'
                          ? 'text-lime-300'
                          : 'text-zinc-300';
                  return (
                    <div key={`${message.timestamp}-${index}`} className="mb-1 flex gap-4">
                      <span className="shrink-0 text-zinc-600">{String(index + 1).padStart(2, '0')}</span>
                      <span className={toneClass}>{message.content}</span>
                    </div>
                  );
                })}
                {scanRunning ? <div className="mt-2 animate-pulse text-zinc-600">_</div> : null}
                <div ref={scanLogEndRef} />
              </div>
            </div>
            {canOpenResults ? (
              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={() => setActiveStage('results')}
                  className={appBtnInk}
                >
                  <Eye className="h-4 w-4" />
                  View results
                </button>
              </div>
            ) : null}
          </>
        )}
      </div>
    );
  };

  const renderResultsView = () => {
    if (loading || loadingResults) {
      return (
        <div className="relative z-10 mx-auto flex min-h-full w-full max-w-5xl animate-fade-in flex-col space-y-6 p-8">
          <div>
            <h1 className="mb-1 text-2xl font-semibold text-zinc-100">Security Overview</h1>
            <p className="text-sm text-zinc-400">Loading latest findings and pipeline status.</p>
          </div>
          <SpinnerCard label="Loading scan results..." />
        </div>
      );
    }

    if (error && !results) {
      return (
        <div className="relative z-10 mx-auto flex min-h-full w-full max-w-5xl animate-fade-in flex-col space-y-6 p-8">
          <div>
            <h1 className="mb-1 text-2xl font-semibold text-zinc-100">Security Overview</h1>
            <p className="text-sm text-zinc-400">The latest scan could not be loaded.</p>
          </div>
          <AlertCard tone="error" title="Results Unavailable" message={error} action={<RunButton className="max-w-65" onClick={() => void fetchStatusAndResults({ trackError: true })}>Retry Loading Results</RunButton>} />
        </div>
      );
    }

    if (!results) {
      return (
        <div className="relative z-10 mx-auto flex min-h-full w-full max-w-5xl animate-fade-in flex-col space-y-6 p-8">
          <div>
            <h1 className="mb-1 text-2xl font-semibold text-zinc-100">Security Overview</h1>
            <p className="text-sm text-zinc-400">Findings are ready to load from the latest pipeline run.</p>
          </div>
          <AlertCard
            tone="warning"
            title="Results not loaded yet"
            message="The scan finished, but findings have not been fetched yet. Load results to continue."
            action={<RunButton className="max-w-65" onClick={() => void fetchStatusAndResults({ trackError: true })}>Load results</RunButton>}
          />
        </div>
      );
    }

    const stats = scanStats || EMPTY_STATS;
    const cleanState = !hasVulnerabilities;

    return (
      <div className="relative z-10 mx-auto flex min-h-full w-full max-w-5xl animate-fade-in flex-col space-y-6 p-8">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="mb-1 text-2xl font-semibold text-zinc-100">Security Overview</h1>
            <p className="text-sm text-zinc-400">
              {lastResultsSyncAt
                ? `Latest pipeline run synced ${new Date(lastResultsSyncAt).toLocaleTimeString()}`
                : 'Posture, modules, and findings from the latest pipeline run.'}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {RESULTS_SURFACES.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setResultsSurface(item.id)}
                className={`border-[3px] border-black px-3 py-2 text-xs font-bold transition-transform hover:translate-x-0.5 hover:translate-y-0.5 ${resultsSurface === item.id ? 'bg-black text-white shadow-none' : 'bg-white text-black shadow-[4px_4px_0_0_#000]'}`}
              >
                {item.label}
              </button>
            ))}
            <button
              type="button"
              onClick={() => void fetchStatusAndResults({ trackError: true })}
              className={appBtnPaper}
            >
              <RefreshCw className="h-3.5 w-3.5" />
              Refresh
            </button>
            <ScanReportDownloadButton projectId={projectId} disabled={!results} />
          </div>
        </div>

        <div>
          <p className="mb-3 font-mono text-[10px] font-medium uppercase tracking-[0.2em] text-zinc-500">Security posture</p>
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <SecurityKPI label="Critical" value={stats.critical} tone="critical" />
            <SecurityKPI label="High" value={stats.high} tone="high" />
            <SecurityKPI label="Medium" value={stats.medium} tone="medium" />
            <SecurityKPI label="Low" value={stats.low} tone="low" />
          </div>
        </div>

        {resultsSurface === 'overview' ? (
          <>
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
              <RiskScore risk={results.risk} onExplain={() => setResultsSurface('risk')} />
              <div className="grid grid-cols-2 gap-4">
                <SecurityKPI label="Total findings" value={stats.total} />
                <SecurityKPI label="Auto-fixable" value={stats.autoFixable} tone="success" />
                <SecurityKPI label="Attack paths" value={results.attack_paths?.length || 0} />
                <SecurityKPI label="Exploitable" value={unifiedFindings.filter((item) => Number(item.metadata?.epss_score || 0) >= 0.5 || item.category === 'dast').length} />
              </div>
            </div>
            <div>
              <p className="mb-3 font-mono text-[10px] font-medium uppercase tracking-[0.2em] text-zinc-500">Pipeline modules</p>
              <SecurityModuleGrid modules={pipelineModules} onSelect={handleSelectModule} />
            </div>
            {cleanState ? (
              <AlertCard
                tone="success"
                title="No vulnerabilities detected"
                message="This project passed the current security scan. Continue to deployment or return to the dashboard."
                action={(
                  <div className="flex flex-wrap gap-3">
                    <RunButton className="max-w-65" onClick={() => router.push(`/dashboard/deploy?projectId=${encodeURIComponent(projectId)}&entry=card`)}>
                      Continue to Delivery
                    </RunButton>
                    <button
                      type="button"
                      onClick={() => router.push('/dashboard')}
                      className={appBtnPaper}
                    >
                      Return to Dashboard
                    </button>
                  </div>
                )}
              />
            ) : null}
          </>
        ) : resultsSurface === 'findings' ? (
          <>
            {projectAuthError ? (
              <AlertCard
                tone="error"
                title="Project Access Required"
                message={projectAuthError}
              />
            ) : null}
            {cleanState ? (
              <AlertCard
                tone="success"
                title="No findings in this run"
                message="The latest pipeline run did not report vulnerabilities. Module status is still available on Overview."
              />
            ) : (
              <FindingTable
                findings={unifiedFindings}
                category={findingsCategory}
                onCategoryChange={setFindingsCategory}
                query={resultsQuery}
                onQueryChange={setResultsQuery}
                severity={resultsSeverity}
                onSeverityChange={setResultsSeverity}
                correlations={results.correlations}
                expandedId={expandedFindingId}
                onExpandedIdChange={setExpandedFindingId}
              />
            )}
          </>
        ) : resultsSurface === 'secrets' ? (
          <SecretsExplorer findings={unifiedFindings} />
        ) : resultsSurface === 'supply-chain' ? (
          <SupplyChainExplorer findings={unifiedFindings} results={results} />
        ) : resultsSurface === 'infrastructure' ? (
          <InfrastructureExplorer findings={unifiedFindings} modules={pipelineModules} />
        ) : resultsSurface === 'apis' ? (
          <ApiExplorer findings={unifiedFindings} module={pipelineModules.find((item) => item.id === 'api')} />
        ) : resultsSurface === 'dynamic' ? (
          <DynamicTestingExplorer
            findings={unifiedFindings}
            module={pipelineModules.find((item) => item.id === 'dast')}
            projectId={projectId}
            selectedAssetId={dastAssetId}
            onSelectAsset={(asset) => setDastTarget(asset?.target_url || '', asset?.id || '')}
            profile={dastProfile}
            onProfileChange={setDastProfile}
            onRun={() => void handleStartScan({ dastOnly: true })}
            busy={scanBusy}
            error={error}
          />
        ) : resultsSurface === 'cloud' ? (
          <CloudExplorer
            findings={unifiedFindings}
            module={pipelineModules.find((item) => item.id === 'cloud')}
            deployed={projectHasSuccessfulDeploy(projectId)}
            onRun={(aws) => void handleStartScan({ cloudOnly: true, aws })}
            busy={scanBusy}
            error={error}
            deployHref={`/dashboard/deploy?projectId=${encodeURIComponent(projectId)}`}
          />
        ) : resultsSurface === 'risk' ? (
          <RiskExplorer results={results} findings={unifiedFindings} />
        ) : resultsSurface === 'assets' ? (
          <AssetExplorer findings={unifiedFindings} />
        ) : (
          <AttackPathExplorer
            paths={results.attack_paths || []}
            onSelectFinding={(id) => {
              setExpandedFindingId(id);
              setResultsSurface('findings');
              setFindingsCategory('all');
            }}
          />
        )}

        {canLaunchRemediation ? (
          <div className={`${secPaper} overflow-hidden`}>
            <div className="relative z-10 flex flex-col gap-4 p-6 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h3 className="mb-1 flex items-center gap-2 text-base font-bold text-black"><Sparkles className="h-4 w-4" />AI Auto-Remediation Available</h3>
                <p className="text-[13px] text-neutral-600">Deploy the remediation agent to patch these vulnerabilities, create a PR, and verify with a re-scan.</p>
              </div>
              <div className="w-55"><RunButton onClick={() => { setSetupOpen(true); setActiveStage('remediate_setup'); }}>Setup AI Agent</RunButton></div>
            </div>
          </div>
        ) : null}

        {runAll && cleanState ? (
          <div className="flex justify-center pt-2">
            <RunButton className="max-w-65" disabled={!canProceedToDeployment} onClick={() => router.push(deploymentPath)}>
              Proceed to Deployment
            </RunButton>
          </div>
        ) : null}
      </div>
    );
  };

  const renderRemediateSetupView = () => (
    <div className="relative z-10 mx-auto flex min-h-full w-full max-w-4xl animate-fade-in flex-col space-y-6 p-8">
      <div className="mb-6 mt-4 border-b border-[#1A1A1A] pb-6">
        <h1 className="mb-2 text-2xl font-semibold text-zinc-100">Configure AI Agent</h1>
        <p className="text-sm text-zinc-400">Initialize the remediation agent to automatically fix identified vulnerabilities.</p>
      </div>
      {projectAuthError ? <AlertCard tone="error" title="Project Access Required" message={projectAuthError} /> : null}
      {error && remediationState === 'error' ? <AlertCard tone="error" title="Remediation Error" message={error} /> : null}
        <div className={`${secPaper} space-y-6 p-6`}>
        <div className="space-y-4">
          <div>
            <label className="mb-2 block text-[10px] font-bold uppercase text-zinc-500">Remediation Agent</label>
            <div className="border-[3px] border-black bg-white px-4 py-3">
              <div className="text-sm font-semibold text-black">Remediation Pipeline Engine</div>
              <p className="mt-1 text-xs text-neutral-600">
                Choose a subscription-hosted platform model or a vaulted BYOK key. API keys are not pasted on this page.
              </p>
            </div>
          </div>
          <RemediationModelPicker value={agentModel} onChange={setAgentModel} persistKey={projectId} />
          <div className="border-t border-[#1A1A1A] pt-4">
            <label className="mb-2 block text-[10px] font-bold uppercase text-zinc-500">GitHub PAT (Optional)</label>
            <input type="password" value={githubToken} onChange={(event) => setGithubToken(event.target.value)} placeholder="ghp_..." className={appInput} />
            <p className="mt-2 text-[11px] text-zinc-500">Required only for pushing the fix branch automatically. Not stored persistently.</p>
          </div>
        </div>
        <div className="pt-6 flex flex-wrap items-center gap-3">
          <RunButton onClick={() => void handleStartRemediation()} disabled={remediatingThisProject || !canLaunchRemediation || !agentModel.ready}>
            <Sparkles className="h-4 w-4" />
            <span>Start Remediation Engine</span>
          </RunButton>
          {!agentModel.ready ? (
            <p className="text-xs text-amber-800">{agentModel.blockedReason || 'Loading remediation models…'}</p>
          ) : null}
          {remediationState !== 'idle' ? (
            <button type="button" onClick={handleResetRemediation} className={appBtnPaper}>
              Reset remediation
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );

  const renderRemediateRunView = () => {
    const latestMessage = [...remMessages].reverse().find((message) => message.type !== 'changed_files');
    const agentStatusLabel =
      remediationState === 'running'
        ? 'Patching vulnerabilities'
        : remediationState === 'waiting_decision'
          ? 'Awaiting your decision'
          : remediationState === 'waiting_approval'
            ? 'Awaiting final approval'
            : remediationState === 'completed'
              ? 'Remediation complete'
              : remediationState === 'error'
                ? 'Run failed'
                : 'Standing by';

    return (
      <div className="animate-fade-in space-y-6">
        <div className="grid gap-4 lg:grid-cols-[minmax(0,320px)_1fr]">
          <div className={`${secPaper} p-5`}>
            <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-zinc-500">Active agent</p>
            <div className="mt-3 flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-none border-[3px] border-black bg-white">
                <Bot className="h-5 w-5 text-black" />
              </div>
              <div>
                <p className="text-sm font-semibold text-white">Remediation agent</p>
                <p className="text-[12px] text-zinc-500">{agentModel.sourceLabel} · {agentModel.model || REMEDIATION_DEFAULT_MODEL}</p>
              </div>
            </div>
            <div className="mt-5 space-y-3 border-t border-white/10 pt-4 text-[13px]">
              <div className="flex items-center justify-between gap-3">
                <span className="text-zinc-500">Status</span>
                <span
                  className={`font-semibold ${
                    remediationState === 'error'
                      ? 'text-rose-700'
                      : remediationState === 'waiting_decision' || remediationState === 'waiting_approval'
                        ? 'text-amber-800'
                        : 'text-emerald-800'
                  }`}
                >
                  {agentStatusLabel}
                </span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-zinc-500">Changed files</span>
                <span className="font-mono text-zinc-300">{changedFiles.length}</span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-zinc-500">Project</span>
                <span className="truncate font-mono text-zinc-300">{projectName}</span>
              </div>
            </div>
            {latestMessage ? (
              <div className="mt-4 border-[3px] border-black bg-white p-3">
                <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-zinc-600">Latest activity</p>
                <p className="mt-2 text-[12px] leading-5 text-zinc-400">{String(latestMessage.content).slice(0, 220)}{String(latestMessage.content).length > 220 ? '…' : ''}</p>
              </div>
            ) : null}
          </div>

          <div className={`${secPaper} overflow-hidden`}>
            <div className="flex items-center justify-between border-b-[3px] border-black px-5 py-4">
              <div className="flex items-center gap-2">
                <TerminalSquare className="h-4 w-4 text-lime-300" />
                <h3 className="text-sm font-semibold text-zinc-200">Agent execution log</h3>
              </div>
              {remediatingThisProject ? (
                <span className="relative flex h-2 w-2">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-black opacity-75" />
                    <span className="relative inline-flex h-2 w-2 rounded-full bg-black" />
                </span>
              ) : null}
            </div>
            <div className="sec-terminal custom-scrollbar max-h-[420px] overflow-y-auto bg-[#0d1117] p-6 font-mono text-[13px] leading-relaxed text-[#e6edf3]">
              {remMessages.map((message, index) => {
                if (message.type === 'changed_files') return null;
                const logText = String(message.content || '');
                const toneClass = logText.includes('[waiting_approval]') || logText.includes('[waiting_decision]') || message.type === 'warning'
                  ? 'text-amber-400 font-medium'
                  : message.type === 'success'
                    ? 'text-emerald-400'
                    : message.type === 'error'
                      ? 'text-rose-400'
                      : 'text-zinc-400';
                return (
                  <div key={`${message.timestamp}-${index}`} className="mb-2 flex gap-4">
                    <span className="shrink-0 text-zinc-600">{String(index + 1).padStart(2, '0')}</span>
                    <span className={toneClass}>{logText}</span>
                  </div>
                );
              })}
              {remediatingThisProject ? <div className="mt-2 animate-pulse text-zinc-600">_</div> : null}
              <div ref={remediateLogEndRef} />
            </div>
          </div>
        </div>

        {remediationState === 'error' ? (
          <AlertCard
            tone="error"
            title="Remediation Failed"
            message={[...remMessages].reverse().find((message) => message.type === 'error')?.content || error || 'The remediation run failed.'}
            action={
              <button type="button" onClick={handleResetRemediation} className={appBtnPaper}>
                Reset &amp; reconfigure
              </button>
            }
          />
        ) : null}

        {['running', 'waiting_decision', 'waiting_approval'].includes(remediationState) ? (
          <div className="flex justify-end">
            <button type="button" onClick={handleResetRemediation} className={appBtnPaper}>
              Stop &amp; reset remediation
            </button>
          </div>
        ) : null}
      </div>
    );
  };

  const renderApprovalView = () => {
    const waitingForDecision = remediationState === 'waiting_decision';

    return (
      <div className="relative z-10 mx-auto flex min-h-full w-full max-w-4xl animate-fade-in flex-col space-y-6 p-8">
        <div className="mb-6 mt-4 border-b border-[#1A1A1A] pb-6">
          <h1 className="mb-2 text-2xl font-semibold text-zinc-100">{waitingForDecision ? 'Choose Next Step' : 'Approve & Push Fixes'}</h1>
          <p className="text-sm text-zinc-400">
            {waitingForDecision
              ? 'The first remediation round finished. Review the patch set and decide whether to push these fixes or run one more remediation round.'
              : 'Review the current patch set one last time, then approve persistence and PR creation. You can rerun a verification scan after the PR exists.'}
          </p>
        </div>

        <div className={`${secPaper} overflow-hidden`}>
          <div className="flex items-center justify-between border-b-[3px] border-black p-4"><span className="text-sm font-semibold text-black">Changed Files</span><span className="font-mono text-xs text-neutral-600">{changedFiles.length} modification{changedFiles.length === 1 ? '' : 's'}</span></div>
          <div className="p-0">
            {changedFiles.length === 0 ? (
              <div className="p-4 text-sm text-neutral-600">No changed file metadata is available for this remediation run.</div>
            ) : changedFiles.map((item) => (
              <div key={item.path} className="flex items-center justify-between border-b-[3px] border-black p-4 transition-colors last:border-b-0 hover:bg-white/70">
                <div className="flex min-w-0 items-center gap-3">
                  {item.path.endsWith('.json') ? <FileJson className="h-4 w-4 text-black" /> : <FileCode2 className="h-4 w-4 text-black" />}
                  <div className="min-w-0"><span className="block truncate font-mono text-sm text-black">{item.path}</span>{item.reason ? <span className="mt-0.5 block text-xs text-neutral-600">{item.reason}</span> : null}</div>
                </div>
                <button type="button" onClick={() => setSelectedDiffPath(item.path)} className="flex items-center gap-2 border-[3px] border-black bg-white px-3 py-1 text-xs font-bold text-black shadow-[3px_3px_0_0_#000] hover:translate-x-0.5 hover:translate-y-0.5 hover:shadow-none"><Eye className="h-3 w-3" />View Diff</button>
              </div>
            ))}
          </div>
        </div>

        {selectedDiff ? (
          <div className={`${secPaper} overflow-hidden`}>
            <div className="flex items-center justify-between gap-4 border-b-[3px] border-black px-4 py-3">
              <div className="min-w-0">
                <div className="truncate font-mono text-sm font-semibold text-black">{selectedDiff.path}</div>
                {selectedDiff.reason ? (
                  <div className="mt-0.5 text-xs text-neutral-600">{selectedDiff.reason}</div>
                ) : null}
              </div>
              {selectedDiff.diff ? <UnifiedDiffStats diff={selectedDiff.diff} /> : null}
            </div>
            {selectedDiff.diff ? (
              <div className="p-4">
                <UnifiedDiffViewer diff={selectedDiff.diff} embedded />
              </div>
            ) : (
              <div className="p-4">
                <AlertCard tone="warning" title="Diff Unavailable" message="This file change did not include a diff payload." />
              </div>
            )}
          </div>
        ) : null}

        {waitingForDecision ? (
          <div className={`grid gap-4 ${secPaper} p-6 md:grid-cols-2`}>
            <div className="border-[3px] border-black bg-white p-4">
              <div className="text-sm font-semibold text-black">Push current fixes</div>
              <p className="mt-2 text-sm leading-relaxed text-neutral-600">Stop after this patch set, move to final approval, and then create the PR with the current changes.</p>
              <div className="mt-4">
                <RunButton onClick={handlePushCurrentFixes}>Use These Fixes</RunButton>
              </div>
            </div>
            <div className="border-[3px] border-black bg-white p-4">
              <div className="text-sm font-semibold text-black">Run another round</div>
              <p className="mt-2 text-sm leading-relaxed text-neutral-600">Re-scan the updated codebase and let the remediation agent take one more pass before final approval.</p>
              <div className="mt-4">
                <RunButton onClick={handleContinueRound}>Run Another Round</RunButton>
              </div>
            </div>
          </div>
        ) : (
          <div className={`${secPaper} p-6`}>
            <div className="mb-6 border-[3px] border-black bg-white p-4">
              <label className="flex cursor-pointer items-start gap-3">
                <input type="checkbox" checked={approved} onChange={(event) => setApproved(event.target.checked)} className="mt-1 h-4 w-4 rounded-none border-black bg-white text-black" />
                <span className="text-sm leading-relaxed text-neutral-600">I approve these code modifications. Persist the fix branch and open a Pull Request automatically if this is a GitHub project. Verification scan is optional after the PR is created.</span>
              </label>
            </div>
            <RunButton disabled={!approved} onClick={handleApproveAndPush}>Approve &amp; Push PR</RunButton>
          </div>
        )}
      </div>
    );
  };

  const renderPrRescanView = () => {
    const stats = scanStats || EMPTY_STATS;
    const cleanVerification = stats.critical === 0 && stats.high === 0;
    const githubProject = projectMeta?.type === 'github';
    const persistComplete = Boolean(prUrl)
      || remMessages.some((message) => (
        typeof message.content === 'string'
        && (
          message.content.startsWith('Remediation PR created: ')
          || message.content.includes('No GitHub changes detected')
          || message.content.includes('Remediation changes written to local')
          || message.content.includes('Remediation persisted.')
        )
      ))
      || remediationFinished;
    const prCreating = githubProject && !prUrl && !persistComplete && remediationState !== 'error';
    const verificationRunning = verificationScanRequested && (scanRunning || loading || loadingResults);
    const verificationDone = verificationScanRequested && !verificationRunning && (results !== null || vulnStatus === 'found' || vulnStatus === 'not_found');
    const canRerunVerification = persistComplete && !verificationRunning && !rerunInProgress && !loadingProject;

    let verificationTitle = 'Verification scan is optional';
    let verificationCopy = githubProject
      ? (prUrl
        ? 'The PR is ready. Click rerun if you want a fresh scan of the remediated branch.'
        : 'Wait until the pull request exists, then click rerun to scan the remediated code.')
      : 'Persistence finished. Click rerun if you want a fresh scan of the local workspace.';
    if (verificationRunning) {
      verificationTitle = 'Verification scan running…';
      verificationCopy = 'Rescanning to confirm the latest vulnerability state after remediation.';
    } else if (verificationDone) {
      verificationTitle = cleanVerification ? 'Verification complete' : 'Verification found remaining risk';
      verificationCopy = cleanVerification
        ? '0 Critical and 0 High vulnerabilities remain after the verification run.'
        : `${stats.critical} Critical and ${stats.high} High findings remain after verification.`;
    }

    return (
      <div className="relative z-10 mx-auto flex min-h-full w-full max-w-5xl animate-fade-in flex-col space-y-6 p-8">
        <div className="mb-8 mt-4 flex flex-wrap items-center justify-between gap-4 border-b border-[#1A1A1A] pb-6">
          <div>
            <h1 className="mb-2 text-2xl font-semibold text-zinc-100">Remediation Complete</h1>
            <p className="text-sm text-zinc-400">{githubProject ? 'PR creation and verification status are shown below.' : 'Local remediation persistence and verification status are shown below.'}</p>
          </div>
          <ScanReportDownloadButton projectId={projectId} disabled={!results} />
        </div>

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <div className={`${secPaper} p-8`}>
            <div className="mb-6 flex h-12 w-12 items-center justify-center border-[3px] border-black bg-white"><GitPullRequest className="h-6 w-6 text-black" /></div>
            <h3 className="mb-2 text-lg font-semibold text-black">{githubProject ? (prUrl ? 'Pull Request Created' : prCreating ? 'Creating Pull Request...' : 'No Pull Request Created') : 'Changes Persisted Locally'}</h3>
            <p className="mb-6 text-sm text-neutral-600">{githubProject ? (prUrl ? 'The remediation branch was pushed successfully. Open the PR to review or merge it in GitHub.' : prCreating ? 'The remediation engine is still persisting changes to GitHub and creating the Pull Request.' : 'No GitHub PR was created for this run. You can still rerun a verification scan if you want.') : 'The remediation engine wrote the approved changes back to the local project workspace.'}</p>
            {githubProject ? (
              <button type="button" onClick={() => prUrl && window.open(prUrl, '_blank', 'noopener,noreferrer')} disabled={!prUrl} className={`${appBtnInk} w-full disabled:cursor-not-allowed disabled:opacity-50`}>
                View PR on GitHub <ExternalLink className="h-4 w-4" />
              </button>
            ) : (
              <div className="border-[3px] border-black bg-white px-4 py-3 text-sm text-black">No GitHub PR is required for local projects.</div>
            )}
          </div>

          <div className={`${secPaper} p-8`}>
            <div className="mb-6 flex h-12 w-12 items-center justify-center border-[3px] border-black bg-white">{verificationRunning ? <RefreshCw className="h-6 w-6 animate-spin text-black" /> : <ShieldCheck className="h-6 w-6 text-black" />}</div>
            <h3 className="mb-2 text-lg font-semibold text-black">{verificationTitle}</h3>
            <p className="mb-6 text-sm text-neutral-600">{verificationCopy}</p>
            {error && verificationScanRequested ? <p className="mb-4 text-sm text-rose-700">{error}</p> : null}
            <div className="flex w-full flex-col gap-3">
              <RunButton disabled={!canRerunVerification} onClick={() => void handleVerificationRerun()}>
                {verificationRunning || rerunInProgress ? 'Scanning…' : 'Rerun scan'}
              </RunButton>
              {!verificationRunning ? (
                <RunButton onClick={() => router.push('/dashboard')}>Return to Dashboard</RunButton>
              ) : null}
            </div>
          </div>
        </div>

        {persistComplete ? (
          <div className={`${secPaper} p-8 text-center`}>
          <h3 className="font-display text-xl font-semibold text-black">Get your application deployed</h3>
            <p className="mx-auto mt-2 max-w-lg text-[14px] leading-6 text-zinc-400">
              Security remediation is complete. Continue to the deployment pipeline to ship this repository to AWS.
            </p>
            <button
              type="button"
              disabled={!canProceedToDeployment}
              onClick={() => router.push(deploymentPath)}
              className={`mt-6 ${appBtnInk}`}
            >
              Continue to deployment
            </button>
          </div>
        ) : null}
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
    <WorkspaceShell
      embedded
      active="security"
      section="Security"
      workspaceName={projectName || 'deplai-demo'}
      projectId={projectId}
      onNavigate={(href) => router.push(href)}
      onExit={() => router.push('/dashboard')}
      stageRail={(
        <SecurityStageRail
          activeStage={activeStage}
          maxUnlockedIndex={maxUnlockedIndex}
          onSelectStage={handleStageClick}
        />
      )}
    >
      <div className="security-workspace mx-auto w-full max-w-6xl px-5 py-8 sm:px-8">
        {renderSecurityToolbar()}
        {renderContent()}
      </div>
      <style dangerouslySetInnerHTML={{ __html: `
        @keyframes fadeIn { from { opacity: 0; transform: translateY(5px); } to { opacity: 1; transform: translateY(0); } }
        .animate-fade-in { animation: fadeIn 0.3s ease-out forwards; }
      ` }} />
    </WorkspaceShell>
  );
}


