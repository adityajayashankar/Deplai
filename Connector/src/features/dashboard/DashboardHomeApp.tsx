'use client';

import React, {
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import { useRouter } from 'next/navigation';
import * as THREE from 'three';
import {
  Check,
  ChevronDown,
} from 'lucide-react';
import { useScan } from '@/lib/scan-context';
import { LOGIN_HREF } from '@/lib/auth-providers';
import ManageInstancesApp from '@/features/deployment/ManageInstancesApp';
import SettingsApp from '@/features/dashboard/SettingsApp';
import IntegrationsApp from '@/features/dashboard/IntegrationsApp';
import { WorkspaceCommandHeader } from '@/features/workspace/WorkspaceNav';
import { ProjectSourceThumb } from '@/components/project-icons';
import { buildCustomizationHref } from '@/features/customization/utils';

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

type SidebarItem = { key: string; label: string };

const SIDEBAR_SECTIONS: Array<{ label: string; items: SidebarItem[] }> = [
  {
    label: 'Dashboard',
    items: [
      { key: 'overview', label: 'Dashboard' },
      { key: 'organizations', label: 'Organizations' },
      { key: 'usage', label: 'Usage' },
    ],
  },
  {
    label: 'Services',
    items: [
      { key: 'agents', label: 'Agents' },
      { key: 'sessions', label: 'Sessions' },
      { key: 'deployments', label: 'Deployment' },
      { key: 'instances', label: 'Instance Management' },
      { key: 'scans', label: 'Scans' },
      { key: 'customization', label: 'UIUX customizer' },
    ],
  },
  {
    label: 'Account',
    items: [
      { key: 'subscription', label: 'Subscription' },
      { key: 'invoices', label: 'Invoices' },
      { key: 'credits', label: 'Credits' },
      { key: 'byok', label: 'AI credentials' },
      { key: 'integrations', label: 'Integrations' },
      { key: 'settings', label: 'Settings' },
      { key: 'documentation', label: 'Documentation' },
      { key: 'api-reference', label: 'API reference' },
    ],
  },
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
      <span className={`ml-px inline-block opacity-100 ${shouldHideCursor ? 'hidden' : ''} ${cursorClassName}`}>
        {cursorCharacter}
      </span>
    ),
  );
};

const PixelBlast = ({
  variant = 'square',
  pixelSize = 3,
  color = '#ffffff',
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
        className="group relative flex min-w-30 cursor-pointer items-center border-[3px] border-black bg-white py-1 pl-2.5 pr-7"
      >
        <span className="mr-2 font-mono text-[9px] font-semibold uppercase tracking-[0.14em] text-neutral-500">br</span>
        <span className="flex-1 truncate font-mono text-[12px] leading-none text-black">{selected}</span>
        <ChevronDown className={`pointer-events-none absolute right-2 h-3.5 w-3.5 text-black transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`} />
      </div>
      <div className={`absolute left-0 top-[calc(100%+6px)] z-80 min-w-40 origin-top border-[3px] border-black bg-white shadow-[4px_4px_0_0_#000] transition-all duration-200 ${isOpen ? 'translate-y-0 scale-y-100 opacity-100' : 'pointer-events-none -translate-y-2 scale-y-95 opacity-0'}`}>
        <div className="p-1">
          {loading && <div className="px-3 py-2 text-[12px] text-neutral-500">Loading branches…</div>}
          {branches.map((branch) => (
            <div
              key={branch}
              onClick={() => {
                setSelected(branch);
                setIsOpen(false);
              }}
              className={`flex cursor-pointer items-center justify-between px-3 py-2 font-mono text-[12px] ${selected === branch ? 'bg-black font-medium text-white' : 'text-black hover:bg-neutral-100'}`}
            >
              <span className="truncate">{branch}</span>
              {selected === branch && <Check className="h-3.5 w-3.5 text-white" />}
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
  disabled = false,
}: {
  onClick: () => void;
  children: React.ReactNode;
  className?: string;
  disabled?: boolean;
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

    const colors = ['#111111', '#3f3f46', '#52525b'];
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
  }, []);

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

  const buttonThemeClass = 'border-[3px] border-black bg-black text-white shadow-[4px_4px_0_0_#000] hover:translate-x-0.5 hover:translate-y-0.5 hover:shadow-none';

  return (
    <button
      ref={buttonRef}
      onClick={onClick}
      disabled={disabled}
      onMouseEnter={() => triggerAnimation('appear')}
      onMouseLeave={() => triggerAnimation('disappear')}
      onFocus={() => triggerAnimation('appear')}
      onBlur={() => triggerAnimation('disappear')}
      className={`group/pixel relative rounded-none border px-4 py-1.5 text-[12px] font-semibold transition-all ${buttonThemeClass} ${disabled ? 'cursor-not-allowed opacity-60' : ''} ${className}`}
    >
      <span className="pointer-events-none absolute inset-0 overflow-hidden">
        <canvas ref={canvasRef} aria-hidden className="h-full w-full" />
      </span>
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

export default function DashboardHomeApp({ initialTab = 'overview' }: { initialTab?: string }) {
  const router = useRouter();
  const { startScan } = useScan();
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const [activeTab, setActiveTab] = useState(initialTab);
  const [viewMode, setViewMode] = useState<ViewMode>('list');
  const [typingTrigger, setTypingTrigger] = useState(0);
  const [hasScrolledDown, setHasScrolledDown] = useState(false);
  const [search, setSearch] = useState('');
  const [repositories, setRepositories] = useState<DashboardRepository[]>([]);
  const [projectsById, setProjectsById] = useState<Record<string, ProjectRecord>>({});
  const [userName, setUserName] = useState('Signed out');
  const [userAvatarUrl, setUserAvatarUrl] = useState('');
  const [loggingOut, setLoggingOut] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [uploadingLocalProject, setUploadingLocalProject] = useState(false);
  const [runAllProjectId, setRunAllProjectId] = useState<string | null>(null);

  const loadDashboardData = useCallback(async () => {
    setRefreshing(true);
    try {
      const sessionRes = await fetch('/api/auth/session', { cache: 'no-store' });

      if (sessionRes.ok) {
        const session = await sessionRes.json() as SessionResponse;
        if (!session.isLoggedIn || !session.user) {
          window.location.assign(LOGIN_HREF);
          return;
        }
        const nextUser = session.user.login || session.user.name;
        setUserName(nextUser || 'Signed in');
        setUserAvatarUrl(session.user.avatarUrl || '');
      } else {
        window.location.assign(LOGIN_HREF);
        return;
      }

      const projectsRes = await fetch('/api/projects', { cache: 'no-store' });
      if (projectsRes.ok) {
        const payload = await projectsRes.json() as ProjectsResponse;
        const projects = Array.isArray(payload.projects) ? payload.projects : [];
        setRepositories(mapProjectsToRepositories(projects));
        setProjectsById(Object.fromEntries(projects.map((project) => [project.id, project])));
      } else if (projectsRes.status === 401) {
        window.location.assign(LOGIN_HREF);
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

  const validateAndStartScan = useCallback(async (projectId: string, project: ProjectRecord) => {
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
  }, [startScan]);

  const handleRunScan = useCallback(async (projectId: string) => {
    const project = projectsById[projectId];
    if (!project) return;
    primePipelineState(projectId, 'scan');
    try {
      await validateAndStartScan(projectId, project);
      router.push(`/dashboard/security-analysis/${encodeURIComponent(projectId)}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to start scan';
      window.alert(message);
    }
  }, [primePipelineState, projectsById, router, validateAndStartScan]);

  const handleOpenCustomization = useCallback((repo: DashboardRepository) => {
    router.push(buildCustomizationHref(repo.id, repo.name));
  }, [router]);

  const handleSidebarNavigation = useCallback((key: string) => {
    if (key === 'settings') {
      router.push('/dashboard/settings');
      return;
    }
    if (key === 'organizations') {
      router.push('/dashboard/organization');
      return;
    }
    if (key === 'deployments') {
      router.push('/dashboard/deploy');
      return;
    }
    if (key === 'instances') {
      router.push('/dashboard/instances');
      return;
    }
    if (key === 'documentation' || key === 'api-reference') {
      router.push('/dashboard/documentation');
      return;
    }
    if (key === 'customization') {
      const repo = repositories[0];
      if (repo) handleOpenCustomization(repo);
      return;
    }
    if (key === 'byok') {
      router.push('/dashboard/ai');
      return;
    }
    if (key === 'credits') {
      router.push('/dashboard/credits');
      return;
    }
    setActiveTab(key);
  }, [handleOpenCustomization, repositories, router]);

  const handleRunAll = useCallback((repo: DashboardRepository) => {
    if (runAllProjectId) return;
    setRunAllProjectId(repo.id);
    const url = `${buildCustomizationHref(repo.id, repo.name)}&runAll=1`;
    router.push(url);
    window.setTimeout(() => {
      setRunAllProjectId((current) => (current === repo.id ? null : current));
    }, 5000);
  }, [router, runAllProjectId]);

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

  const handleUploadCardClick = useCallback(() => {
    if (uploadingLocalProject) return;
    uploadInputRef.current?.click();
  }, [uploadingLocalProject]);

  const handleLocalProjectFileChange = useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const file = input.files?.[0];
    if (!file) return;

    const defaultName = file.name.replace(/\.zip$/i, '').trim() || 'Local Project';
    const projectName = window.prompt('Project name', defaultName);

    if (!projectName || !projectName.trim()) {
      input.value = '';
      return;
    }

    setUploadingLocalProject(true);
    try {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('name', projectName.trim());

      const response = await fetch('/api/projects/upload', {
        method: 'POST',
        body: formData,
      });

      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error || 'Failed to upload local project');
      }

      await loadDashboardData();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to upload local project';
      window.alert(message);
    } finally {
      setUploadingLocalProject(false);
      input.value = '';
    }
  }, [loadDashboardData]);

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
  const activeSidebarItem = SIDEBAR_SECTIONS.flatMap((section) => section.items)
    .find((item) => item.key === activeTab);
  const headerTitle = activeTab === 'instances'
    ? 'Instance Management'
    : activeTab === 'settings'
      ? 'Settings'
      : activeTab === 'integrations'
        ? 'Integrations'
        : activeSidebarItem?.label || 'Command Center';

  return (
    <div className="relative flex h-full overflow-hidden bg-transparent font-sans">
      <style>{`
        .dashboard-shell { --font-sans: 'Instrument Sans', 'Noto Sans', sans-serif; --font-display: 'Space Grotesk', sans-serif; --font-mono: 'JetBrains Mono', monospace; }
        .dashboard-shell h1, .dashboard-shell h2, .dashboard-shell .font-display { font-family: var(--font-display); }
      `}</style>
      <main className="relative z-10 flex h-full min-w-0 flex-1 flex-col overflow-hidden bg-transparent">
        <WorkspaceCommandHeader
          section={headerTitle}
          onExit={() => router.push('/')}
        />

        {activeTab === 'instances' ? (
          <Suspense fallback={<div className="flex-1 bg-white" />}>
            <ManageInstancesApp embedded />
          </Suspense>
        ) : activeTab === 'settings' ? (
        <div className="custom-scrollbar relative z-10 flex-1 overflow-y-auto p-8" onScroll={handleMainScroll}>
          <SettingsApp />
        </div>
        ) : activeTab === 'integrations' ? (
        <div className="custom-scrollbar relative z-10 flex-1 overflow-y-auto p-8">
          <IntegrationsApp />
        </div>
        ) : (
        <div className="custom-scrollbar relative z-10 flex-1 overflow-y-auto p-8" onScroll={handleMainScroll}>
          <div className="mb-10 grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
            <div className="app-paper p-6">
              <p className="font-mono text-[10px] font-medium uppercase tracking-[0.2em] text-neutral-500">Repositories</p>
              <div className="mt-4 mb-5 flex items-end gap-2.5">
                <span className="font-display text-5xl font-semibold leading-none tracking-tight text-black">{activeCount}</span>
                <span className="mb-1 text-[13px] font-medium text-neutral-500">tracked</span>
              </div>
              <div className="mt-auto flex gap-2">
                <span className="border-2 border-black px-2.5 py-1 font-mono text-[11px] font-bold">{githubCount} remote</span>
                <span className="border-2 border-black px-2.5 py-1 font-mono text-[11px] font-bold">{localCount} local</span>
              </div>
            </div>

            <button type="button" onClick={() => router.push('/dashboard/projects')} className="app-paper group flex h-full w-full flex-col items-start p-6 text-left">
              <p className="font-mono text-[10px] font-medium uppercase tracking-[0.2em] text-neutral-500">Connect</p>
              <h3 className="mt-3 font-display text-lg font-semibold text-black">Add Project</h3>
              <p className="mt-2 mb-5 text-[13px] leading-relaxed text-neutral-600">Link GitHub repositories to your deployment workspace.</p>
              <div className="mt-auto text-[13px] font-bold">
                Connect now →
              </div>
            </button>

            <div className="app-paper flex flex-col p-6">
              <p className="font-mono text-[10px] font-medium uppercase tracking-[0.2em] text-neutral-500">Deployment</p>
              <h3 className="mt-3 font-display text-lg font-semibold text-black">Cloud Deployment</h3>
              <p className="mt-2 mb-5 text-[13px] leading-relaxed text-neutral-600">Ship live endpoints to AWS, Azure, GCP, and Heroku from one workspace.</p>
              <PixelNoiseButton
                onClick={() => (firstRepository ? handleDeploy(firstRepository.id) : router.push('/dashboard/deploy'))}
                className="mt-auto w-full justify-center py-2.5 text-[13px]"
              >
                Deploy now
              </PixelNoiseButton>
            </div>

            <button type="button" onClick={handleUploadCardClick} disabled={uploadingLocalProject} className="app-paper group flex h-full w-full flex-col items-start justify-between p-6 text-left disabled:cursor-not-allowed disabled:opacity-70">
              <p className="font-mono text-[10px] font-medium uppercase tracking-[0.2em] text-neutral-500">Local</p>
              <div>
                <h3 className="font-display text-[15px] font-semibold text-black">{uploadingLocalProject ? 'Uploading…' : 'Upload Project'}</h3>
                <p className="mt-2 text-[12px] text-neutral-500">ZIP archives supported</p>
              </div>
            </button>

            <input
              ref={uploadInputRef}
              type="file"
              accept=".zip,application/zip"
              className="hidden"
              onChange={handleLocalProjectFileChange}
            />
          </div>

          <div className="mt-8">
            <div className="mb-6 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <h2 className="font-display text-xl font-semibold text-black">Repositories</h2>
                <span className="border-2 border-black px-2 py-0.5 font-mono text-[11px] font-bold text-black">{filteredRepositories.length}</span>
              </div>
              <div className="flex items-center gap-3">
                <div className="relative">
                  <input
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    type="text"
                    placeholder="Search repositories…"
                    className="w-70 border-[3px] border-black bg-white py-2 pr-4 pl-3.5 text-[13px] text-black placeholder:text-neutral-400 focus:outline-none"
                  />
                </div>
                <div className="flex items-center border-[3px] border-black p-0.5">
                  <button onClick={() => setViewMode('list')} className={`px-2.5 py-1.5 text-[11px] font-bold ${viewMode === 'list' ? 'bg-black text-white' : 'text-neutral-500 hover:text-black'}`}>List</button>
                  <button onClick={() => setViewMode('grid')} className={`px-2.5 py-1.5 text-[11px] font-bold ${viewMode === 'grid' ? 'bg-black text-white' : 'text-neutral-500 hover:text-black'}`}>Grid</button>
                </div>
              </div>
            </div>

            <div className={viewMode === 'list' ? 'space-y-3' : 'grid grid-cols-1 gap-4 lg:grid-cols-2'}>
              {filteredRepositories.map((repo, index) => (
                <div key={repo.id} className="relative" style={{ zIndex: filteredRepositories.length - index }}>
                  <div className="app-paper group">
                    <div className={`flex h-full w-full p-4 ${viewMode === 'list' ? 'items-center gap-4' : 'flex-col items-start gap-4'}`}>
                      <div className={`flex w-full ${viewMode === 'list' ? 'flex-1 items-center gap-4' : 'items-start gap-3'}`}>
                        <ProjectSourceThumb type={repo.type} owner={repo.owner} />
                        <div className="flex min-w-0 flex-1 flex-col justify-center">
                          <div className="mb-1 flex items-center gap-3">
                            <h4 className="truncate text-[15px] font-semibold text-black">{repo.name}</h4>
                            <span className={`border-2 border-black px-1.5 py-0.5 font-mono text-[9px] font-bold tracking-wider ${repo.visibility === 'PUBLIC' ? 'bg-black text-white' : 'bg-white text-black'}`}>{repo.visibility}</span>
                          </div>
                          <div className="flex flex-wrap items-center gap-2 text-[12px] text-neutral-600">
                            <span>{repo.source}</span>
                            <span className="h-1 w-1 bg-black" />
                            <BranchDropdown
                              installationId={repo.installationId}
                              owner={repo.owner}
                              repo={repo.repo}
                              currentBranch={repo.currentBranch}
                            />
                          </div>
                        </div>
                      </div>

                      <div className={`flex shrink-0 items-center gap-2 ${viewMode === 'grid' ? 'w-full justify-between border-t-2 border-black pt-3' : ''}`}>
                        <div className="flex flex-wrap gap-2">
                          <PixelNoiseButton
                            onClick={() => void handleRunAll(repo)}
                            disabled={Boolean(runAllProjectId)}
                            className="px-4 py-2 text-sm"
                          >
                            {runAllProjectId === repo.id ? 'Running…' : 'Run All'}
                          </PixelNoiseButton>
                          <PixelNoiseButton onClick={() => handleDeploy(repo.id)} className="px-4 py-2 text-sm">
                            Deploy
                          </PixelNoiseButton>
                          <PixelNoiseButton onClick={() => void handleRunScan(repo.id)} className="px-4 py-2 text-sm">
                            Scan
                          </PixelNoiseButton>
                          <PixelNoiseButton onClick={() => handleOpenCustomization(repo)} className="px-4 py-2 text-sm">
                            Customize
                          </PixelNoiseButton>
                        </div>
                        <div className="flex items-center gap-1">
                          <div className={`mx-1 h-5 w-px bg-black ${viewMode === 'grid' ? 'hidden' : ''}`} />
                          <button onClick={() => void handleDelete(repo.id)} className="ml-1 px-2 py-1.5 text-[11px] font-bold text-neutral-500 hover:bg-black hover:text-white" title="Delete">
                            Delete
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
        )}
      </main>

      <style dangerouslySetInnerHTML={{ __html: `
        @keyframes customBlink {
          0%, 100% { opacity: 1; }
          50% { opacity: 0; }
        }
      ` }}
      />
    </div>
  );
}


