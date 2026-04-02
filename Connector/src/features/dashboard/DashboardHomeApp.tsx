'use client';

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { useRouter } from 'next/navigation';
import * as THREE from 'three';
import {
  ArrowRight,
  Check,
  ChevronDown,
  Cpu,
  FileText,
  Github,
  Grid,
  LayoutGrid,
  List,
  LogOut,
  Play,
  Plus,
  RefreshCw,
  Rocket,
  Search,
  Server,
  Settings,
  Trash2,
  Upload,
  Zap,
  GitBranch,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useScan } from '@/lib/scan-context';
import ManageInstancesApp from '@/features/deployment/ManageInstancesApp';

type ViewMode = 'list' | 'grid';
type PixelBlastVariant = 'square' | 'circle' | 'triangle' | 'diamond';

type SessionResponse = {
  isLoggedIn?: boolean;
  user?: {
    login?: string;
    name?: string;
    avatarUrl?: string;
  };
};

type ProjectRecord = {
  id: string;
  name: string;
  owner?: string;
  repo?: string;
  type: 'local' | 'github';
  source?: string;
  branch?: string;
  installationId?: string;
  access?: string;
  lastSyncedAt?: string | null;
  createdAt?: string;
  canDelete?: boolean;
};

type ProjectsResponse = {
  projects?: ProjectRecord[];
};

interface TextTypeProps extends React.HTMLAttributes<HTMLElement> {
  className?: string;
  showCursor?: boolean;
  hideCursorWhileTyping?: boolean;
  cursorCharacter?: string | React.ReactNode;
  cursorClassName?: string;
  text: string | string[];
  as?: React.ElementType;
  typingSpeed?: number;
  initialDelay?: number;
  pauseDuration?: number;
  deletingSpeed?: number;
  loop?: boolean;
  textColors?: string[];
}

interface BorderGlowProps {
  children: ReactNode;
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

type PixelBlastProps = {
  variant?: PixelBlastVariant;
  pixelSize?: number;
  color?: string;
  className?: string;
  style?: CSSProperties;
  antialias?: boolean;
  patternScale?: number;
  patternDensity?: number;
  pixelSizeJitter?: number;
  enableRipples?: boolean;
  rippleIntensityScale?: number;
  rippleThickness?: number;
  rippleSpeed?: number;
  speed?: number;
  transparent?: boolean;
  edgeFade?: number;
  noiseAmount?: number;
};

type DashboardRepository = {
  id: string;
  name: string;
  source: string;
  currentBranch: string;
  installationId?: string;
  owner?: string;
  repo?: string;
  visibility: string;
  type: 'local' | 'github';
  canDelete: boolean;
};

const DASHBOARD_TABS: Array<{ key: string; label: string; icon: LucideIcon }> = [
  { key: 'overview', label: 'Overview', icon: LayoutGrid },
  { key: 'deployments', label: 'Deployments', icon: Rocket },
  { key: 'instances', label: 'Manage Instance', icon: Cpu },
  { key: 'settings', label: 'Settings', icon: Settings },
];

const SELECTED_PROJECT_STORAGE_KEY = 'deplai.pipeline.selectedProjectId';
const CURRENT_STAGE_STORAGE_PREFIX = 'deplai.pipeline.currentStage.';
const DEPLOY_UI_STAGE_STORAGE_PREFIX = 'deplai.deploy.stage.';
const PLANNING_PROJECT_KEY = 'deplai.pipeline.planningProjectId';
const SHAPE_MAP: Record<PixelBlastVariant, number> = {
  square: 0,
  circle: 1,
  triangle: 2,
  diamond: 3,
};
const MAX_CLICKS = 10;
const GRADIENT_POSITIONS = ['80% 55%', '69% 34%', '8% 6%', '41% 38%', '86% 85%', '82% 18%', '51% 4%'];
const COLOR_MAP = [0, 1, 2, 0, 1, 2, 1];
const VERTEX_SRC = `
void main() {
  gl_Position = vec4(position, 1.0);
}
`;
const FRAGMENT_SRC = `
precision highp float;
uniform vec3 uColor;
uniform vec2 uResolution;
uniform float uTime;
uniform float uPixelSize;
uniform float uScale;
uniform float uDensity;
uniform float uPixelJitter;
uniform int uEnableRipples;
uniform float uRippleSpeed;
uniform float uRippleThickness;
uniform float uRippleIntensity;
uniform float uEdgeFade;
uniform float uNoiseAmount;
uniform int uShapeType;
const int SHAPE_CIRCLE = 1;
const int SHAPE_TRIANGLE = 2;
const int SHAPE_DIAMOND = 3;
const int MAX_CLICKS = 10;
uniform vec2 uClickPos[MAX_CLICKS];
uniform float uClickTimes[MAX_CLICKS];
out vec4 fragColor;
float Bayer2(vec2 a) { a = floor(a); return fract(a.x / 2. + a.y * a.y * .75); }
#define Bayer4(a) (Bayer2(.5*(a))*0.25 + Bayer2(a))
#define Bayer8(a) (Bayer4(.5*(a))*0.25 + Bayer2(a))
#define FBM_OCTAVES 5
#define FBM_LACUNARITY 1.25
#define FBM_GAIN 1.0
float hash11(float n){ return fract(sin(n)*43758.5453); }
float vnoise(vec3 p){
  vec3 ip = floor(p); vec3 fp = fract(p);
  float n000 = hash11(dot(ip + vec3(0.0,0.0,0.0), vec3(1.0,57.0,113.0)));
  float n100 = hash11(dot(ip + vec3(1.0,0.0,0.0), vec3(1.0,57.0,113.0)));
  float n010 = hash11(dot(ip + vec3(0.0,1.0,0.0), vec3(1.0,57.0,113.0)));
  float n110 = hash11(dot(ip + vec3(1.0,1.0,0.0), vec3(1.0,57.0,113.0)));
  float n001 = hash11(dot(ip + vec3(0.0,0.0,1.0), vec3(1.0,57.0,113.0)));
  float n101 = hash11(dot(ip + vec3(1.0,0.0,1.0), vec3(1.0,57.0,113.0)));
  float n011 = hash11(dot(ip + vec3(0.0,1.0,1.0), vec3(1.0,57.0,113.0)));
  float n111 = hash11(dot(ip + vec3(1.0,1.0,1.0), vec3(1.0,57.0,113.0)));
  vec3 w = fp*fp*fp*(fp*(fp*6.0-15.0)+10.0);
  float x00 = mix(n000, n100, w.x);
  float x10 = mix(n010, n110, w.x);
  float x01 = mix(n001, n101, w.x);
  float x11 = mix(n011, n111, w.x);
  float y0 = mix(x00, x10, w.y);
  float y1 = mix(x01, x11, w.y);
  return mix(y0, y1, w.z) * 2.0 - 1.0;
}
float fbm2(vec2 uv, float t){
  vec3 p = vec3(uv * uScale, t);
  float amp = 1.0; float freq = 1.0; float sum = 1.0;
  for (int i = 0; i < FBM_OCTAVES; ++i){ sum += amp * vnoise(p * freq); freq *= FBM_LACUNARITY; amp *= FBM_GAIN; }
  return sum * 0.5 + 0.5;
}
float maskCircle(vec2 p, float cov){
  float r = sqrt(cov) * .25;
  float d = length(p - 0.5) - r;
  float aa = 0.5 * fwidth(d);
  return cov * (1.0 - smoothstep(-aa, aa, d * 2.0));
}
float maskTriangle(vec2 p, vec2 id, float cov){
  bool flip = mod(id.x + id.y, 2.0) > 0.5;
  if (flip) p.x = 1.0 - p.x;
  float r = sqrt(cov);
  float d = p.y - r*(1.0 - p.x);
  float aa = fwidth(d);
  return cov * clamp(0.5 - d/aa, 0.0, 1.0);
}
float maskDiamond(vec2 p, float cov){
  float r = sqrt(cov) * 0.564;
  return step(abs(p.x - 0.49) + abs(p.y - 0.49), r);
}
void main(){
  float pixelSize = uPixelSize;
  vec2 fragCoord = gl_FragCoord.xy - uResolution * .5;
  float aspectRatio = uResolution.x / uResolution.y;
  vec2 pixelId = floor(fragCoord / pixelSize);
  vec2 pixelUV = fract(fragCoord / pixelSize);
  float cellPixelSize = 8.0 * pixelSize;
  vec2 cellId = floor(fragCoord / cellPixelSize);
  vec2 cellCoord = cellId * cellPixelSize;
  vec2 uv = cellCoord / uResolution * vec2(aspectRatio, 1.0);
  float base = fbm2(uv, uTime * 0.05);
  base = base * 0.5 - 0.65;
  float feed = base + (uDensity - 0.5) * 0.3;
  if (uEnableRipples == 1) {
    for (int i = 0; i < MAX_CLICKS; ++i){
      vec2 pos = uClickPos[i];
      if (pos.x < 0.0) continue;
      vec2 cuv = (((pos - uResolution * .5 - cellPixelSize * .5) / (uResolution))) * vec2(aspectRatio, 1.0);
      float t = max(uTime - uClickTimes[i], 0.0);
      float r = distance(uv, cuv);
      float waveR = uRippleSpeed * t;
      float ring = exp(-pow((r - waveR) / uRippleThickness, 2.0));
      float atten = exp(-1.0 * t) * exp(-10.0 * r);
      feed = max(feed, ring * atten * uRippleIntensity);
    }
  }
  float bayer = Bayer8(fragCoord / uPixelSize) - 0.5;
  float bw = step(0.5, feed + bayer);
  float h = fract(sin(dot(floor(fragCoord / uPixelSize), vec2(127.1, 311.7))) * 43758.5453);
  float coverage = bw * (1.0 + (h - 0.5) * uPixelJitter);
  float M;
  if (uShapeType == SHAPE_CIRCLE) M = maskCircle(pixelUV, coverage);
  else if (uShapeType == SHAPE_TRIANGLE) M = maskTriangle(pixelUV, pixelId, coverage);
  else if (uShapeType == SHAPE_DIAMOND) M = maskDiamond(pixelUV, coverage);
  else M = coverage;
  if (uEdgeFade > 0.0) {
    vec2 norm = gl_FragCoord.xy / uResolution;
    float edge = min(min(norm.x, norm.y), min(1.0 - norm.x, 1.0 - norm.y));
    M *= smoothstep(0.0, uEdgeFade, edge);
  }
  vec3 color = uColor;
  if (uNoiseAmount > 0.0) {
    float noiseVal = hash11(dot(gl_FragCoord.xy, vec2(12.9898, 78.233)) + uTime);
    color += (noiseVal - 0.5) * uNoiseAmount;
  }
  vec3 srgbColor = mix(color * 12.92, 1.055 * pow(color, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, color));
  fragColor = vec4(srgbColor, M);
}
`;

function parseHSL(hslStr: string): { h: number; s: number; l: number } {
  const match = hslStr.match(/([\d.]+)\s*([\d.]+)%?\s*([\d.]+)%?/);
  if (!match) return { h: 40, s: 80, l: 80 };
  return { h: Number.parseFloat(match[1]), s: Number.parseFloat(match[2]), l: Number.parseFloat(match[3]) };
}

function buildBoxShadow(glowColor: string, intensity: number): string {
  const { h, s, l } = parseHSL(glowColor);
  const base = `${h}deg ${s}% ${l}%`;
  const layers: Array<[number, number, number, number, number, boolean]> = [
    [0, 0, 0, 1, 100, true], [0, 0, 1, 0, 60, true], [0, 0, 3, 0, 50, true],
    [0, 0, 6, 0, 40, true], [0, 0, 15, 0, 30, true], [0, 0, 25, 2, 20, true],
    [0, 0, 50, 2, 10, true], [0, 0, 1, 0, 60, false], [0, 0, 3, 0, 50, false],
    [0, 0, 6, 0, 40, false], [0, 0, 15, 0, 30, false], [0, 0, 25, 2, 20, false],
    [0, 0, 50, 2, 10, false],
  ];
  return layers.map(([x, y, blur, spread, alpha, inset]) => {
    const a = Math.min(alpha * intensity, 100);
    return `${inset ? 'inset ' : ''}${x}px ${y}px ${blur}px ${spread}px hsl(${base} / ${a}%)`;
  }).join(', ');
}

function easeOutCubic(x: number) { return 1 - Math.pow(1 - x, 3); }
function easeInCubic(x: number) { return x * x * x; }

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
  ease?: (t: number) => number;
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

function buildMeshGradients(colors: string[]): string[] {
  const gradients: string[] = [];
  for (let i = 0; i < 7; i += 1) {
    const color = colors[Math.min(COLOR_MAP[i], colors.length - 1)];
    gradients.push(`radial-gradient(at ${GRADIENT_POSITIONS[i]}, ${color} 0px, transparent 50%)`);
  }
  gradients.push(`linear-gradient(${colors[0]} 0 100%)`);
  return gradients;
}

function writeStoredString(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // ignore storage failures
  }
}

const TextType = ({
  text,
  as: Component = 'div',
  typingSpeed = 50,
  initialDelay = 0,
  pauseDuration = 2000,
  deletingSpeed = 30,
  loop = false,
  className = '',
  showCursor = true,
  hideCursorWhileTyping = false,
  cursorCharacter = '|',
  cursorClassName = '',
  textColors = [],
  ...props
}: TextTypeProps) => {
  const [displayedText, setDisplayedText] = useState('');
  const [currentCharIndex, setCurrentCharIndex] = useState(0);
  const [isDeleting, setIsDeleting] = useState(false);
  const [currentTextIndex, setCurrentTextIndex] = useState(0);
  const textArray = useMemo(() => (Array.isArray(text) ? text : [text]), [text]);

  useEffect(() => {
    let timeout: ReturnType<typeof setTimeout>;
    const currentText = textArray[currentTextIndex] || '';
    const executeTypingAnimation = () => {
      if (isDeleting) {
        if (displayedText === '') {
          setIsDeleting(false);
          if (currentTextIndex === textArray.length - 1 && !loop) return;
          setCurrentTextIndex((prev) => (prev + 1) % textArray.length);
          setCurrentCharIndex(0);
          timeout = setTimeout(() => undefined, pauseDuration);
        } else {
          timeout = setTimeout(() => setDisplayedText((prev) => prev.slice(0, -1)), deletingSpeed);
        }
        return;
      }
      if (currentCharIndex < currentText.length) {
        timeout = setTimeout(() => {
          setDisplayedText((prev) => prev + currentText[currentCharIndex]);
          setCurrentCharIndex((prev) => prev + 1);
        }, typingSpeed);
        return;
      }
      if (!loop && currentTextIndex === textArray.length - 1) return;
      timeout = setTimeout(() => setIsDeleting(true), pauseDuration);
    };
    if (currentCharIndex === 0 && !isDeleting && displayedText === '') {
      timeout = setTimeout(executeTypingAnimation, initialDelay);
    } else {
      executeTypingAnimation();
    }
    return () => clearTimeout(timeout);
  }, [currentCharIndex, currentTextIndex, deletingSpeed, displayedText, initialDelay, isDeleting, loop, pauseDuration, textArray, typingSpeed]);

  const shouldHideCursor = hideCursorWhileTyping && (currentCharIndex < (textArray[currentTextIndex] || '').length || isDeleting);
  const color = textColors.length === 0 ? 'inherit' : textColors[currentTextIndex % textColors.length];
  return React.createElement(
    Component,
    {
      className: `inline-block whitespace-pre-wrap tracking-tight ${className}`,
      ...props,
    },
    <span className="inline" style={{ color }}>{displayedText}</span>,
    showCursor && (
      <span className={`ml-[1px] inline-block opacity-100 ${shouldHideCursor ? 'hidden' : ''} ${cursorClassName}`}>
        {cursorCharacter}
      </span>
    ),
  );
};

const BorderGlow = ({
  children,
  className = '',
  edgeSensitivity = 30,
  glowColor = '40 80 80',
  backgroundColor = '#060010',
  borderRadius = 28,
  glowRadius = 40,
  glowIntensity = 1,
  coneSpread = 25,
  animated = false,
  colors = ['#c084fc', '#f472b6', '#38bdf8'],
  fillOpacity = 0.5,
}: BorderGlowProps) => {
  const cardRef = useRef<HTMLDivElement>(null);
  const [isHovered, setIsHovered] = useState(false);
  const [cursorAngle, setCursorAngle] = useState(45);
  const [edgeProximity, setEdgeProximity] = useState(0);
  const [sweepActive, setSweepActive] = useState(false);

  const getCenterOfElement = useCallback((element: HTMLElement) => {
    const { width, height } = element.getBoundingClientRect();
    return [width / 2, height / 2];
  }, []);

  const getEdgeProximity = useCallback((element: HTMLElement, x: number, y: number) => {
    const [cx, cy] = getCenterOfElement(element);
    const dx = x - cx;
    const dy = y - cy;
    let kx = Number.POSITIVE_INFINITY;
    let ky = Number.POSITIVE_INFINITY;
    if (dx !== 0) kx = cx / Math.abs(dx);
    if (dy !== 0) ky = cy / Math.abs(dy);
    return Math.min(Math.max(1 / Math.min(kx, ky), 0), 1);
  }, [getCenterOfElement]);

  const getCursorAngle = useCallback((element: HTMLElement, x: number, y: number) => {
    const [cx, cy] = getCenterOfElement(element);
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
    const frameId = requestAnimationFrame(() => {
      setSweepActive(true);
      setCursorAngle(angleStart);
    });
    animateValue({ duration: 500, onUpdate: (value) => setEdgeProximity(value / 100) });
    animateValue({ ease: easeInCubic, duration: 1500, end: 50, onUpdate: (value) => setCursorAngle((angleEnd - angleStart) * (value / 100) + angleStart) });
    animateValue({ ease: easeOutCubic, delay: 1500, duration: 2250, start: 50, end: 100, onUpdate: (value) => setCursorAngle((angleEnd - angleStart) * (value / 100) + angleStart) });
    animateValue({ ease: easeInCubic, delay: 2500, duration: 1500, start: 100, end: 0, onUpdate: (value) => setEdgeProximity(value / 100), onEnd: () => setSweepActive(false) });
    return () => cancelAnimationFrame(frameId);
  }, [animated]);

  const colorSensitivity = edgeSensitivity + 20;
  const isVisible = isHovered || sweepActive;
  const borderOpacity = isVisible ? Math.max(0, (edgeProximity * 100 - colorSensitivity) / (100 - colorSensitivity)) : 0;
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
      style={{
        background: backgroundColor,
        borderRadius: `${borderRadius}px`,
        transform: 'translate3d(0, 0, 0.01px)',
        boxShadow: 'rgba(0,0,0,0.2) 0 4px 12px',
      }}
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
          maskImage: ['linear-gradient(to bottom, black, black)', 'radial-gradient(ellipse at 50% 50%, black 40%, transparent 65%)', 'radial-gradient(ellipse at 66% 66%, black 5%, transparent 40%)', 'radial-gradient(ellipse at 33% 33%, black 5%, transparent 40%)', 'radial-gradient(ellipse at 66% 33%, black 5%, transparent 40%)', 'radial-gradient(ellipse at 33% 66%, black 5%, transparent 40%)', `conic-gradient(from ${angleDeg} at center, transparent 5%, black 15%, black 85%, transparent 95%)`].join(', '),
          WebkitMaskImage: ['linear-gradient(to bottom, black, black)', 'radial-gradient(ellipse at 50% 50%, black 40%, transparent 65%)', 'radial-gradient(ellipse at 66% 66%, black 5%, transparent 40%)', 'radial-gradient(ellipse at 33% 33%, black 5%, transparent 40%)', 'radial-gradient(ellipse at 66% 33%, black 5%, transparent 40%)', 'radial-gradient(ellipse at 33% 66%, black 5%, transparent 40%)', `conic-gradient(from ${angleDeg} at center, transparent 5%, black 15%, black 85%, transparent 95%)`].join(', '),
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

const PixelBlast = ({
  variant = 'square',
  pixelSize = 3,
  color = '#818CF8',
  className,
  style,
  antialias = true,
  patternScale = 2,
  patternDensity = 1,
  pixelSizeJitter = 0,
  enableRipples = true,
  rippleIntensityScale = 1,
  rippleThickness = 0.1,
  rippleSpeed = 0.3,
  speed = 0.5,
  transparent = true,
  edgeFade = 0.5,
  noiseAmount = 0,
}: PixelBlastProps) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const speedRef = useRef(speed);
  const threeRef = useRef<{
    uniforms: Record<string, { value: unknown }>;
    renderer: THREE.WebGLRenderer;
  } | null>(null);

  useEffect(() => {
    speedRef.current = speed;
  }, [speed]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const canvas = document.createElement('canvas');
    const renderer = new THREE.WebGLRenderer({
      canvas,
      antialias,
      alpha: true,
      powerPreference: 'high-performance',
    });

    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    container.appendChild(renderer.domElement);

    if (transparent) renderer.setClearAlpha(0);
    else renderer.setClearColor(0x000000, 1);

    const uniforms = {
      uResolution: { value: new THREE.Vector2(0, 0) },
      uTime: { value: 0 },
      uColor: { value: new THREE.Color(color) },
      uClickPos: { value: Array.from({ length: MAX_CLICKS }, () => new THREE.Vector2(-1, -1)) },
      uClickTimes: { value: new Float32Array(MAX_CLICKS) },
      uShapeType: { value: SHAPE_MAP[variant] ?? 0 },
      uPixelSize: { value: pixelSize * renderer.getPixelRatio() },
      uScale: { value: patternScale },
      uDensity: { value: patternDensity },
      uPixelJitter: { value: pixelSizeJitter },
      uEnableRipples: { value: enableRipples ? 1 : 0 },
      uRippleSpeed: { value: rippleSpeed },
      uRippleThickness: { value: rippleThickness },
      uRippleIntensity: { value: rippleIntensityScale },
      uEdgeFade: { value: edgeFade },
      uNoiseAmount: { value: noiseAmount },
    };

    const scene = new THREE.Scene();
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const material = new THREE.ShaderMaterial({
      vertexShader: VERTEX_SRC,
      fragmentShader: FRAGMENT_SRC,
      uniforms,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      glslVersion: THREE.GLSL3,
    });

    const quadGeom = new THREE.PlaneGeometry(2, 2);
    const quad = new THREE.Mesh(quadGeom, material);
    scene.add(quad);

    const clock = new THREE.Clock();
    const setSize = () => {
      const width = container.clientWidth || 1;
      const height = container.clientHeight || 1;
      renderer.setSize(width, height, false);
      uniforms.uResolution.value.set(renderer.domElement.width, renderer.domElement.height);
      uniforms.uPixelSize.value = pixelSize * renderer.getPixelRatio();
    };
    setSize();

    const resizeObserver = new ResizeObserver(setSize);
    resizeObserver.observe(container);
    const timeOffset = Math.random() * 1000;
    let clickIndex = 0;

    const mapToPixels = (event: PointerEvent) => {
      const rect = renderer.domElement.getBoundingClientRect();
      const scaleX = renderer.domElement.width / rect.width;
      const scaleY = renderer.domElement.height / rect.height;
      const fx = (event.clientX - rect.left) * scaleX;
      const fy = (rect.height - (event.clientY - rect.top)) * scaleY;
      return { fx, fy };
    };

    const onPointerDown = (event: PointerEvent) => {
      const { fx, fy } = mapToPixels(event);
      (uniforms.uClickPos.value as THREE.Vector2[])[clickIndex].set(fx, fy);
      (uniforms.uClickTimes.value as Float32Array)[clickIndex] = uniforms.uTime.value;
      clickIndex = (clickIndex + 1) % MAX_CLICKS;
    };
    renderer.domElement.addEventListener('pointerdown', onPointerDown, { passive: true });

    let rafId = 0;
    const animate = () => {
      uniforms.uTime.value = timeOffset + clock.getElapsedTime() * speedRef.current;
      renderer.render(scene, camera);
      rafId = requestAnimationFrame(animate);
    };
    rafId = requestAnimationFrame(animate);
    threeRef.current = { uniforms, renderer };

    return () => {
      resizeObserver.disconnect();
      cancelAnimationFrame(rafId);
      renderer.domElement.removeEventListener('pointerdown', onPointerDown);
      quadGeom.dispose();
      material.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      if (renderer.domElement.parentElement === container) {
        container.removeChild(renderer.domElement);
      }
      threeRef.current = null;
    };
  }, [antialias, color, edgeFade, enableRipples, noiseAmount, patternDensity, patternScale, pixelSize, pixelSizeJitter, rippleIntensityScale, rippleSpeed, rippleThickness, transparent, variant]);

  return (
    <div
      ref={containerRef}
      className={`relative h-full w-full overflow-hidden ${className ?? ''}`}
      style={style}
      aria-label="PixelBlast interactive background"
    />
  );
};

function BranchDropdown({
  installationId,
  owner,
  repo,
  currentBranch,
}: {
  installationId?: string;
  owner?: string;
  repo?: string;
  currentBranch: string;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [selected, setSelected] = useState(currentBranch);
  const [branches, setBranches] = useState<string[]>(currentBranch ? [currentBranch] : ['main']);
  const [loading, setLoading] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  useEffect(() => {
    setSelected(currentBranch);
    setBranches(currentBranch ? [currentBranch] : ['main']);
  }, [currentBranch]);

  const loadBranches = useCallback(async () => {
    if (!installationId || !owner || !repo || loading) return;
    if (branches.length > 1) return;
    setLoading(true);
    try {
      const response = await fetch(
        `/api/repositories/branches?installation_id=${encodeURIComponent(installationId)}&owner=${encodeURIComponent(owner)}&repo=${encodeURIComponent(repo)}`,
        { cache: 'no-store' },
      );
      if (!response.ok) return;
      const payload = await response.json() as { branches?: string[] };
      const nextBranches = Array.isArray(payload.branches) && payload.branches.length > 0
        ? payload.branches
        : [currentBranch || 'main'];
      setBranches(nextBranches);
    } finally {
      setLoading(false);
    }
  }, [branches.length, currentBranch, installationId, loading, owner, repo]);

  return (
    <div className="relative" ref={dropdownRef}>
      <div
        onClick={() => {
          const nextOpen = !isOpen;
          setIsOpen(nextOpen);
          if (nextOpen) {
            void loadBranches();
          }
        }}
        className={`group relative flex min-w-[120px] cursor-pointer items-center rounded-md border bg-[#13161F] py-1 pl-2.5 pr-7 transition-colors ${isOpen ? 'border-indigo-500/50' : 'border-[#1E2330] hover:border-[#2A3143]'}`}
      >
        <GitBranch className={`mr-2 h-3.5 w-3.5 transition-colors ${isOpen ? 'text-indigo-400' : 'text-[#4B5563] group-hover:text-indigo-400'}`} />
        <span className="flex-1 truncate font-mono text-[12px] leading-none text-slate-300">{selected}</span>
        <ChevronDown className={`pointer-events-none absolute right-2 h-3.5 w-3.5 transition-transform duration-200 ${isOpen ? 'rotate-180 text-indigo-400' : 'text-[#4B5563] group-hover:text-slate-300'}`} />
      </div>
      <div className={`absolute left-0 top-[calc(100%+6px)] z-[80] min-w-[160px] origin-top overflow-hidden rounded-lg border border-[#1E2330] bg-[#0A0C12] shadow-[0_10px_40px_-10px_rgba(0,0,0,0.8)] transition-all duration-200 ${isOpen ? 'translate-y-0 scale-y-100 opacity-100' : 'pointer-events-none -translate-y-2 scale-y-95 opacity-0'}`}>
        <div className="p-1">
          {loading && <div className="px-3 py-2 text-[12px] text-slate-400">Loading branches...</div>}
          {branches.map((branch) => (
            <div
              key={branch}
              onClick={() => {
                setSelected(branch);
                setIsOpen(false);
              }}
              className={`flex cursor-pointer items-center justify-between rounded-md px-3 py-2 font-mono text-[12px] transition-colors ${selected === branch ? 'bg-indigo-500/10 font-medium text-indigo-400' : 'text-slate-300 hover:bg-[#181C27] hover:text-white'}`}
            >
              <div className="flex items-center gap-2">
                <GitBranch className={`h-3 w-3 ${selected === branch ? 'text-indigo-400' : 'text-transparent'}`} />
                {branch}
              </div>
              {selected === branch && <Check className="h-3.5 w-3.5 text-indigo-400" />}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function PixelNoiseButton({
  onClick,
  children,
  className = '',
  theme = 'light',
}: {
  onClick: () => void;
  children: React.ReactNode;
  className?: string;
  theme?: 'light' | 'orange';
}) {
  class PixelButtonNode {
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

  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const pixelsRef = useRef<PixelButtonNode[]>([]);
  const animationRef = useRef<number | null>(null);
  const timePreviousRef = useRef<number>(performance.now());
  const reducedMotionRef = useRef(false);

  useEffect(() => {
    reducedMotionRef.current = Boolean(window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }, []);

  const initPixels = useCallback(() => {
    if (!buttonRef.current || !canvasRef.current) return;
    const rect = buttonRef.current.getBoundingClientRect();
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

    const colors = theme === 'orange'
      ? ['#FF9900', '#FFB84D', '#F97316']
      : ['#111111', '#3f3f46', '#52525b'];
    const gap = 5;
    const speed = 35 * 0.001;
    const nextPixels: PixelButtonNode[] = [];

    for (let x = 0; x < width; x += gap) {
      for (let y = 0; y < height; y += gap) {
        const color = colors[Math.floor(Math.random() * colors.length)] || '#3f3f46';
        const distance = Math.sqrt(Math.pow(x - width / 2, 2) + Math.pow(y - height / 2, 2));
        nextPixels.push(new PixelButtonNode(canvas, ctx, x, y, color, speed, reducedMotionRef.current ? 0 : distance));
      }
    }
    pixelsRef.current = nextPixels;
  }, [theme]);

  const animate = useCallback((mode: 'appear' | 'disappear') => {
    animationRef.current = requestAnimationFrame(() => animate(mode));
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
      pixel[mode]();
      if (!pixel.isIdle) allIdle = false;
    });

    if (allIdle && animationRef.current !== null) {
      cancelAnimationFrame(animationRef.current);
      animationRef.current = null;
    }
  }, []);

  const triggerAnimation = useCallback((mode: 'appear' | 'disappear') => {
    if (animationRef.current !== null) cancelAnimationFrame(animationRef.current);
    animationRef.current = requestAnimationFrame(() => animate(mode));
  }, [animate]);

  useEffect(() => {
    initPixels();
    const observer = new ResizeObserver(() => initPixels());
    if (buttonRef.current) observer.observe(buttonRef.current);

    return () => {
      observer.disconnect();
      if (animationRef.current !== null) cancelAnimationFrame(animationRef.current);
    };
  }, [initPixels]);

  const buttonThemeClass = theme === 'orange'
    ? 'border-[#FF9900]/50 bg-[#FF9900]/15 text-[#FF9900] shadow-[0_0_15px_rgba(255,153,0,0.18)] hover:bg-[#FF9900]/25'
    : 'border-zinc-200/80 bg-zinc-100 text-black shadow-[0_2px_10px_rgba(255,255,255,0.15)] hover:bg-white';

  return (
    <button
      ref={buttonRef}
      onClick={onClick}
      onMouseEnter={() => triggerAnimation('appear')}
      onMouseLeave={() => triggerAnimation('disappear')}
      onFocus={() => triggerAnimation('appear')}
      onBlur={() => triggerAnimation('disappear')}
      className={`group/pixel relative overflow-hidden rounded-md border px-4 py-1.5 text-[12px] font-semibold transition-all ${buttonThemeClass} ${className}`}
    >
      <canvas ref={canvasRef} aria-hidden className="pointer-events-none absolute inset-0 h-full w-full" />
      <span className="relative z-10 flex items-center gap-1.5">{children}</span>
    </button>
  );
}

function mapProjectsToRepositories(projects: ProjectRecord[]): DashboardRepository[] {
  return projects.map((project) => ({
    id: project.id,
    name: project.name,
    source: project.source || (project.type === 'github' ? 'GitHub' : 'Local'),
    currentBranch: project.branch || 'main',
    installationId: project.installationId,
    owner: project.owner,
    repo: project.repo,
    visibility: String(project.access || 'Local').toUpperCase(),
    type: project.type,
    canDelete: Boolean(project.canDelete),
  }));
}

export default function DashboardHomeApp() {
  const router = useRouter();
  const { startScan } = useScan();
  const [activeTab, setActiveTab] = useState('overview');
  const [viewMode, setViewMode] = useState<ViewMode>('list');
  const [typingTrigger, setTypingTrigger] = useState(0);
  const [hasScrolledDown, setHasScrolledDown] = useState(false);
  const [search, setSearch] = useState('');
  const [repositories, setRepositories] = useState<DashboardRepository[]>([]);
  const [projectsById, setProjectsById] = useState<Record<string, ProjectRecord>>({});
  const [userName, setUserName] = useState('adityajayashankar');
  const [loggingOut, setLoggingOut] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const loadDashboardData = useCallback(async () => {
    setRefreshing(true);
    try {
      const [sessionRes, projectsRes] = await Promise.all([
        fetch('/api/auth/session', { cache: 'no-store' }),
        fetch('/api/projects', { cache: 'no-store' }),
      ]);

      if (sessionRes.ok) {
        const session = await sessionRes.json() as SessionResponse;
        const nextUser = session.user?.login || session.user?.name;
        if (nextUser) setUserName(nextUser);
      }

      if (projectsRes.ok) {
        const payload = await projectsRes.json() as ProjectsResponse;
        const projects = Array.isArray(payload.projects) ? payload.projects : [];
        setRepositories(mapProjectsToRepositories(projects));
        setProjectsById(Object.fromEntries(projects.map((project) => [project.id, project])));
      }
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void loadDashboardData();
  }, [loadDashboardData]);

  const filteredRepositories = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return repositories;
    return repositories.filter((repo) => repo.name.toLowerCase().includes(term) || repo.source.toLowerCase().includes(term));
  }, [repositories, search]);

  const primePipelineState = useCallback((projectId: string, stage: string) => {
    writeStoredString(SELECTED_PROJECT_STORAGE_KEY, projectId);
    writeStoredString(`${CURRENT_STAGE_STORAGE_PREFIX}${projectId}`, stage);
    try {
      sessionStorage.setItem(PLANNING_PROJECT_KEY, projectId);
    } catch {
      // ignore storage failures
    }
  }, []);

  const handleDeploy = useCallback((projectId: string) => {
    primePipelineState(projectId, 'analysis');
    writeStoredString(`${DEPLOY_UI_STAGE_STORAGE_PREFIX}${projectId}`, 'analysis');
    router.push(`/dashboard/deploy?projectId=${encodeURIComponent(projectId)}&entry=card`);
  }, [primePipelineState, router]);

  const handleRunScan = useCallback(async (projectId: string) => {
    const project = projectsById[projectId];
    if (!project) return;
    primePipelineState(projectId, 'scan');
    try {
      const response = await fetch('/api/scan/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project_id: projectId,
          project_name: project.name,
          project_type: project.type,
          installation_id: project.installationId,
          owner: project.owner,
          repo: project.repo,
          scan_type: 'all',
        }),
      });

      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error || 'Failed to start scan');
      }

      await startScan(projectId, project.name);
      router.push(`/dashboard/security-analysis/${encodeURIComponent(projectId)}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to start scan';
      window.alert(message);
    }
  }, [primePipelineState, projectsById, router, startScan]);

  const handleDelete = useCallback(async (projectId: string) => {
    const project = projectsById[projectId];
    if (!project) return;
    const confirmed = window.confirm(`Delete "${project.name}" from the dashboard?`);
    if (!confirmed) return;
    const endpoint = project.type === 'github'
      ? `/api/repositories/${encodeURIComponent(projectId)}`
      : `/api/projects/${encodeURIComponent(projectId)}`;
    const response = await fetch(endpoint, { method: 'DELETE' });
    if (response.ok) {
      await loadDashboardData();
    }
  }, [loadDashboardData, projectsById]);

  const handleLogout = useCallback(async () => {
    setLoggingOut(true);
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } finally {
      router.push('/');
    }
  }, [router]);

  const handleMainScroll = (event: React.UIEvent<HTMLDivElement>) => {
    const scrollTop = event.currentTarget.scrollTop;
    if (scrollTop > 50 && !hasScrolledDown) {
      setHasScrolledDown(true);
    } else if (scrollTop === 0 && hasScrolledDown) {
      setHasScrolledDown(false);
      setTypingTrigger((prev) => prev + 1);
    }
  };

  const activeCount = repositories.length;
  const githubCount = repositories.filter((repo) => repo.type === 'github').length;
  const localCount = repositories.filter((repo) => repo.type === 'local').length;
  const firstRepository = repositories[0];

  return (
    <div className="relative flex h-screen overflow-hidden bg-[#06070B] font-sans text-slate-300 selection:bg-indigo-500/30">
      <div className="pointer-events-none absolute inset-0 z-0 opacity-40">
        <PixelBlast
          variant="diamond"
          color="#6366f1"
          pixelSize={4}
          patternScale={2}
          patternDensity={0.6}
          speed={0.2}
          noiseAmount={0.05}
          transparent
        />
      </div>

      <aside className="relative z-20 flex w-64 shrink-0 flex-col border-r border-[#1E2330] bg-[#06070B]">
        <div className="group flex h-16 cursor-pointer items-center border-b border-[#1E2330] px-8" onMouseEnter={() => setTypingTrigger((prev) => prev + 1)}>
          <TextType
            key={typingTrigger}
            text="DEPL_AI"
            as="h1"
            className="text-lg font-bold tracking-widest text-white"
            typingSpeed={100}
            loop={false}
            showCursor
            cursorCharacter="|"
            cursorClassName="animate-[customBlink_1s_step-end_infinite] font-light text-indigo-400"
          />
        </div>

        <nav className="flex-1 space-y-1 px-3 py-6">
          {DASHBOARD_TABS.map(({ key, label, icon: Icon }) => (
            <button
              key={key}
              onClick={() => {
                setActiveTab(key);
                if (key === 'deployments') router.push('/dashboard/deploy');
                if (key === 'instances') return;
              }}
              className={`relative flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-all ${activeTab === key ? 'border border-indigo-500/20 bg-gradient-to-r from-indigo-500/10 to-transparent text-indigo-100' : 'text-[#8F98A8] hover:bg-[#0A0D14] hover:text-slate-200'}`}
            >
              {activeTab === key && <div className="absolute -left-px top-2 bottom-2 w-[3px] rounded-r-md bg-indigo-500 shadow-[0_0_12px_rgba(99,102,241,0.8)]" />}
              <Icon className={`h-4 w-4 ${activeTab === key ? 'text-indigo-400' : ''}`} />
              {label}
            </button>
          ))}
        </nav>

        <div className="border-t border-[#1E2330] p-4">
          <button onClick={handleLogout} disabled={loggingOut} className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left transition-colors hover:bg-[#0A0D14]">
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-[#71D08C]">
              <div className="flex h-6 w-6 items-center justify-center rounded-full bg-white/20 text-xs font-bold text-[#06070B]">
                {(userName || 'U').charAt(0).toUpperCase()}
              </div>
            </div>
            <div className="flex-1 overflow-hidden">
              <p className="truncate text-sm font-medium text-white">{userName}</p>
              <div className="mt-0.5 flex items-center gap-1 text-[11px] text-[#8F98A8]">
                <LogOut className="h-3 w-3" />
                <span>{loggingOut ? 'Signing out...' : 'Sign out'}</span>
              </div>
            </div>
          </button>
        </div>
      </aside>

      <main className="relative z-10 flex h-full flex-1 flex-col overflow-hidden bg-transparent">
        <header className="flex h-16 items-center justify-between border-b border-[#1E2330]/50 bg-[#06070B]/60 px-8 backdrop-blur-md">
          <div className="flex items-center gap-2 text-[13px] text-[#8F98A8]">
            <span className="cursor-pointer transition-colors hover:text-slate-200">Dashboard</span>
            <span className="text-[#4B5563]">/</span>
            <span className="font-medium text-white">{activeTab === 'instances' ? 'Manage Instance' : 'Command Center'}</span>
          </div>
          <div className="flex items-center gap-3">
            <button onClick={() => router.push('/dashboard/projects')} className="flex items-center gap-2 rounded-md border border-[#1E2330] px-3 py-1.5 text-[13px] font-medium text-slate-300 transition-all hover:bg-[#13161F]">
              <Server className="h-3.5 w-3.5" />
              Manage Org
            </button>
            <div className="mx-1 h-4 w-px bg-[#1E2330]" />
            <button onClick={() => void loadDashboardData()} className="rounded-md p-1.5 text-[#8F98A8] transition-all hover:bg-[#13161F] hover:text-white" title="Refresh">
              <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
            </button>
          </div>
        </header>

        {activeTab === 'instances' ? (
          <ManageInstancesApp embedded />
        ) : (
        <div className="custom-scrollbar relative z-10 flex-1 overflow-y-auto p-8" onScroll={handleMainScroll}>
          <div className="mb-10 grid grid-cols-1 gap-5 md:grid-cols-2 lg:grid-cols-4">
            <BorderGlow backgroundColor="#000000" glowColor="230 80 60" glowIntensity={1} glowRadius={15} fillOpacity={0} borderRadius={16} className="p-6 shadow-lg">
              <div className="mb-4 flex items-center justify-between">
                <h3 className="text-xs font-semibold uppercase tracking-widest text-[#8F98A8]">Repositories</h3>
                <div className="flex gap-1">
                  <div className="h-1 w-6 rounded-full bg-[#1E2330]" />
                  <div className="h-1 w-6 rounded-full bg-[#1E2330]" />
                </div>
              </div>
              <div className="mt-2 mb-6 flex items-end gap-3">
                <span className="text-5xl leading-none tracking-tight text-white">{activeCount}</span>
                <span className="mb-1 text-[13px] font-medium text-[#8F98A8]">tracked</span>
              </div>
              <div className="mt-auto flex gap-2">
                <span className="flex items-center gap-1.5 rounded-md border border-[#1E2330] bg-[#13161F] px-2.5 py-1 text-[11px] font-medium text-[#8F98A8]"><Github className="h-3.5 w-3.5" /> {githubCount} remote</span>
                <span className="flex items-center gap-1.5 rounded-md border border-[#1E2330] bg-[#13161F] px-2.5 py-1 text-[11px] font-medium text-[#8F98A8]"><FileText className="h-3.5 w-3.5" /> {localCount} local</span>
              </div>
            </BorderGlow>

            <BorderGlow backgroundColor="#000000" colors={['#818CF8', '#C084FC', '#38BDF8']} glowColor="260 70 60" glowIntensity={1} glowRadius={15} fillOpacity={0} borderRadius={16} animated className="group cursor-pointer p-6 shadow-lg">
              <button onClick={() => router.push('/dashboard/projects')} className="flex h-full w-full flex-col items-start text-left">
                <div className="mb-3 mt-1 flex items-center gap-3">
                  <div className="flex h-8 w-8 items-center justify-center rounded-md border border-white/10 bg-white/5">
                    <Plus className="h-4 w-4 text-indigo-300" />
                  </div>
                  <h3 className="text-base font-semibold text-white">Add Project</h3>
                </div>
                <p className="mb-4 text-[13px] leading-relaxed text-indigo-200/60">Connect more GitHub repositories to secure your supply chain.</p>
                <div className="mt-auto flex items-center gap-1 text-[13px] font-medium text-indigo-300 transition-colors group-hover:text-indigo-200">
                  Connect now <ArrowRight className="ml-1 h-3.5 w-3.5" />
                </div>
              </button>
            </BorderGlow>

            <BorderGlow backgroundColor="#000000" colors={['#FF9900', '#FFB84D', '#FF7300']} glowColor="35 100 50" glowIntensity={1} glowRadius={15} fillOpacity={0} borderRadius={16} animated className="group flex cursor-pointer flex-col overflow-hidden p-6 shadow-lg">
              <div className="pointer-events-none absolute top-0 right-0 h-28 w-28 text-[#FF9900] opacity-10">
                <svg viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M50 0C77.6 0 100 22.4 100 50C100 77.6 77.6 100 50 100C22.4 100 0 77.6 0 50" stroke="currentColor" strokeWidth="10" strokeDasharray="20 10" />
                  <path d="M50 20C66.5 20 80 33.5 80 50C80 66.5 66.5 80 50 80C33.5 80 20 66.5 20 50" stroke="currentColor" strokeWidth="6" strokeDasharray="15 15" />
                </svg>
              </div>
              <div className="relative z-10 mb-2 mt-1 flex items-center gap-2">
                <Server className="h-4 w-4 text-[#FF9900]" />
                <h3 className="text-base font-semibold text-slate-200">AWS Deployment</h3>
              </div>
              <p className="relative z-10 mb-6 text-[13px] leading-relaxed text-[#8F98A8]">Deploy live endpoints directly to Amazon Web Services infrastructure.</p>
              <PixelNoiseButton
                onClick={() => (firstRepository ? handleDeploy(firstRepository.id) : router.push('/dashboard/deploy'))}
                theme="orange"
                className="relative z-10 mt-auto w-full justify-center py-2.5 text-[13px]"
              >
                <Play className="h-3.5 w-3.5 fill-current" /> Deploy to AWS
              </PixelNoiseButton>
            </BorderGlow>

            <BorderGlow backgroundColor="#000000" glowColor="220 40 50" glowIntensity={1} glowRadius={15} fillOpacity={0} borderRadius={16} className="group cursor-pointer p-1 shadow-lg">
              <button onClick={() => router.push('/dashboard/projects')} className="flex h-full w-full flex-col items-center justify-center rounded-xl border border-dashed border-[#2A3143] p-5 text-center transition-colors group-hover:border-[#4B5563] group-hover:bg-[#10131C]/50">
                <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-md border border-[#2A3143] bg-[#181C27] shadow-sm transition-transform group-hover:-translate-y-0.5">
                  <Upload className="h-4 w-4 text-indigo-400" />
                </div>
                <h3 className="mb-2 text-[14px] font-semibold text-slate-200">Upload Project</h3>
                <p className="rounded border border-[#1E2330] bg-[#181C27] px-2.5 py-1 text-[11px] font-medium text-[#8F98A8]">.zip supported</p>
              </button>
            </BorderGlow>
          </div>

          <div className="mt-8">
            <div className="mb-6 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <h2 className="text-xl font-semibold text-white">Repositories</h2>
                <span className="rounded border border-[#1E2330] bg-[#181C27] px-2 py-0.5 text-[11px] font-medium text-[#8F98A8]">{filteredRepositories.length}</span>
              </div>
              <div className="flex items-center gap-3">
                <div className="relative">
                  <Search className="absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-[#8F98A8]" />
                  <input
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    type="text"
                    placeholder="Search repositories..."
                    className="w-[280px] rounded-md border border-[#1E2330] bg-[#0A0D14] py-1.5 pr-4 pl-9 text-[13px] text-slate-200 placeholder:text-[#4B5563] focus:border-indigo-500/50 focus:outline-none"
                  />
                </div>
                <div className="flex items-center rounded-md border border-[#1E2330] bg-[#0A0D14] p-0.5">
                  <button onClick={() => setViewMode('list')} className={`rounded p-1.5 transition-colors ${viewMode === 'list' ? 'bg-[#1E2330] text-white' : 'text-[#8F98A8] hover:text-white'}`}><List className="h-4 w-4" /></button>
                  <button onClick={() => setViewMode('grid')} className={`rounded p-1.5 transition-colors ${viewMode === 'grid' ? 'bg-[#1E2330] text-white' : 'text-[#8F98A8] hover:text-white'}`}><Grid className="h-4 w-4" /></button>
                </div>
              </div>
            </div>

            <div className={viewMode === 'list' ? 'space-y-3' : 'grid grid-cols-1 gap-4 lg:grid-cols-2'}>
              {filteredRepositories.map((repo, index) => (
                <div key={repo.id} className="relative" style={{ zIndex: filteredRepositories.length - index }}>
                  <BorderGlow backgroundColor="#000000" colors={['#818CF8', '#C084FC', '#38BDF8']} glowColor="230 70 60" glowIntensity={0.8} glowRadius={12} fillOpacity={0} borderRadius={12} className="group border border-[#1E2330] shadow-sm transition-colors hover:border-transparent">
                    <div className={`flex h-full w-full p-4 ${viewMode === 'list' ? 'items-center gap-4' : 'flex-col items-start gap-4'}`}>
                      <div className={`flex w-full ${viewMode === 'list' ? 'flex-1 items-center gap-4' : 'items-start gap-3'}`}>
                        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-[#1E2330] bg-[#141824] shadow-sm transition-colors group-hover:border-[#2A3143]">
                          <Github className="h-5 w-5 text-indigo-400" />
                        </div>
                        <div className="flex min-w-0 flex-1 flex-col justify-center">
                          <div className="mb-1 flex items-center gap-3">
                            <h4 className="truncate text-[15px] font-semibold text-slate-200">{repo.name}</h4>
                            <span className={`rounded px-1.5 py-0.5 text-[9px] font-bold tracking-wider ${repo.visibility === 'PUBLIC' ? 'border border-[#04D288]/20 bg-[#04D288]/10 text-[#04D288]' : 'border border-[#F59E0B]/20 bg-[#F59E0B]/10 text-[#F59E0B]'}`}>{repo.visibility}</span>
                          </div>
                          <div className="flex flex-wrap items-center gap-2 text-[12px] text-[#8F98A8]">
                            <span>{repo.source}</span>
                            <span className="h-1 w-1 rounded-full bg-[#4B5563]" />
                            <BranchDropdown
                              installationId={repo.installationId}
                              owner={repo.owner}
                              repo={repo.repo}
                              currentBranch={repo.currentBranch}
                            />
                          </div>
                        </div>
                      </div>

                      <div className={`flex shrink-0 items-center gap-2 ${viewMode === 'grid' ? 'w-full justify-between border-t border-[#1E2330] pt-2' : ''}`}>
                        <div className="flex gap-2">
                          <PixelNoiseButton onClick={() => handleDeploy(repo.id)}>
                            <Rocket className="h-3.5 w-3.5" /> Deploy
                          </PixelNoiseButton>
                          <PixelNoiseButton onClick={() => void handleRunScan(repo.id)}>
                            <Zap className="h-3.5 w-3.5 fill-current" /> Run Scan
                          </PixelNoiseButton>
                        </div>
                        <div className="flex items-center gap-1">
                          <div className={`mx-1 h-5 w-px bg-[#1E2330] ${viewMode === 'grid' ? 'hidden' : ''}`} />
                          <button onClick={() => void handleDelete(repo.id)} className="ml-1 rounded-md p-1.5 text-[#8F98A8] transition-colors hover:bg-[#F43F5E]/10 hover:text-[#F43F5E]" title="Delete">
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </div>
                      </div>
                    </div>
                  </BorderGlow>
                </div>
              ))}
            </div>
          </div>
        </div>
        )}
      </main>

      <style dangerouslySetInnerHTML={{ __html: `
        .custom-scrollbar::-webkit-scrollbar { width: 6px; }
        .custom-scrollbar::-webkit-scrollbar-track { background: transparent; }
        .custom-scrollbar::-webkit-scrollbar-thumb { background-color: #1E2330; border-radius: 10px; }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover { background-color: #2A3143; }
        @keyframes customBlink {
          0%, 100% { opacity: 1; }
          50% { opacity: 0; }
        }
      ` }}
      />
    </div>
  );
}
