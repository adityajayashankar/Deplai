'use client';
/* eslint-disable @typescript-eslint/no-explicit-any, react-hooks/exhaustive-deps, react-hooks/refs, react-hooks/purity, prefer-const, @typescript-eslint/no-unused-vars */

import React, { useRef, useEffect, useState, useMemo, useCallback, ElementType } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import * as THREE from 'three';
import { LogIn, Github } from 'lucide-react';
import { LoadingScreen } from '@/components/loading-spinner';

interface SessionPayload {
  isLoggedIn?: boolean;
  user?: {
    id: string;
    login: string;
    name: string;
    email: string;
    avatarUrl: string;
  };
}

interface InstallationRecord {
  id: string;
  installation_id: number;
  account_login: string;
  account_type: string;
  installed_at: string | null;
  created_at: string;
}

const GITHUB_APP_INSTALL_URL = 'https://github.com/apps/deplai-app/installations/new';

// ==========================================
// TEXT TYPE COMPONENT 
// ==========================================

interface TextTypeProps {
  className?: string;
  showCursor?: boolean;
  hideCursorWhileTyping?: boolean;
  cursorCharacter?: string | React.ReactNode;
  cursorBlinkDuration?: number;
  cursorClassName?: string;
  text: string | string[];
  as?: ElementType;
  typingSpeed?: number;
  initialDelay?: number;
  pauseDuration?: number;
  deletingSpeed?: number;
  loop?: boolean;
  textColors?: string[];
  variableSpeed?: { min: number; max: number };
  onSentenceComplete?: (sentence: string, index: number) => void;
  startOnVisible?: boolean;
  reverseMode?: boolean;
}

const TextType = ({
  text,
  as: Component = 'div',
  typingSpeed = 50,
  initialDelay = 0,
  pauseDuration = 2000,
  deletingSpeed = 30,
  loop = true,
  className = '',
  showCursor = true,
  hideCursorWhileTyping = false,
  cursorCharacter = '|',
  cursorClassName = '',
  cursorBlinkDuration = 0.5,
  textColors = [],
  variableSpeed,
  onSentenceComplete,
  startOnVisible = false,
  reverseMode = false,
  ...props
}: TextTypeProps & React.HTMLAttributes<HTMLElement>) => {
  const [displayedText, setDisplayedText] = useState('');
  const [currentCharIndex, setCurrentCharIndex] = useState(0);
  const [isDeleting, setIsDeleting] = useState(false);
  const [currentTextIndex, setCurrentTextIndex] = useState(0);
  const [isVisible, setIsVisible] = useState(!startOnVisible);
  const cursorRef = useRef<HTMLSpanElement>(null);
  const containerRef = useRef<HTMLElement>(null);

  const textArray = useMemo(() => (Array.isArray(text) ? text : [text]), [text]);

  const getRandomSpeed = useCallback(() => {
    if (!variableSpeed) return typingSpeed;
    const { min, max } = variableSpeed;
    return Math.random() * (max - min) + min;
  }, [variableSpeed, typingSpeed]);

  const getCurrentTextColor = () => {
    if (textColors.length === 0) return 'inherit';
    return textColors[currentTextIndex % textColors.length];
  };

  useEffect(() => {
    if (!startOnVisible || !containerRef.current) return;

    const observer = new IntersectionObserver(
      entries => {
        entries.forEach(entry => {
          if (entry.isIntersecting) {
            setIsVisible(true);
          }
        });
      },
      { threshold: 0.1 }
    );

    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, [startOnVisible]);

  useEffect(() => {
    if (showCursor && cursorRef.current) {
      const anim = cursorRef.current.animate(
        [{ opacity: 1 }, { opacity: 0 }],
        { 
          duration: cursorBlinkDuration * 1000, 
          iterations: Infinity, 
          direction: 'alternate', 
          easing: 'ease-in-out' 
        }
      );
      return () => anim.cancel();
    }
  }, [showCursor, cursorBlinkDuration]);

  useEffect(() => {
    if (!isVisible) return;

    let timeout: ReturnType<typeof setTimeout>;

    const currentText = textArray[currentTextIndex];
    const processedText = reverseMode ? currentText.split('').reverse().join('') : currentText;

    const executeTypingAnimation = () => {
      if (isDeleting) {
        if (displayedText === '') {
          setIsDeleting(false);
          if (currentTextIndex === textArray.length - 1 && !loop) {
            return;
          }

          if (onSentenceComplete) {
            onSentenceComplete(textArray[currentTextIndex], currentTextIndex);
          }

          setCurrentTextIndex(prev => (prev + 1) % textArray.length);
          setCurrentCharIndex(0);
          timeout = setTimeout(() => {}, pauseDuration);
        } else {
          timeout = setTimeout(() => {
            setDisplayedText(prev => prev.slice(0, -1));
          }, deletingSpeed);
        }
      } else {
        if (currentCharIndex < processedText.length) {
          timeout = setTimeout(
            () => {
              setDisplayedText(prev => prev + processedText[currentCharIndex]);
              setCurrentCharIndex(prev => prev + 1);
            },
            variableSpeed ? getRandomSpeed() : typingSpeed
          );
        } else if (textArray.length >= 1) {
          if (!loop && currentTextIndex === textArray.length - 1) return;
          timeout = setTimeout(() => {
            setIsDeleting(true);
          }, pauseDuration);
        }
      }
    };

    if (currentCharIndex === 0 && !isDeleting && displayedText === '') {
      timeout = setTimeout(executeTypingAnimation, initialDelay);
    } else {
      executeTypingAnimation();
    }

    return () => clearTimeout(timeout);
  }, [
    currentCharIndex,
    displayedText,
    isDeleting,
    typingSpeed,
    deletingSpeed,
    pauseDuration,
    textArray,
    currentTextIndex,
    loop,
    initialDelay,
    isVisible,
    reverseMode,
    variableSpeed,
    onSentenceComplete
  ]);

  const shouldHideCursor =
    hideCursorWhileTyping && (currentCharIndex < textArray[currentTextIndex].length || isDeleting);

  return React.createElement(
    Component as any,
    {
      ref: containerRef,
      className: `inline-block whitespace-pre-wrap tracking-tight ${className}`,
      ...props
    },
    <span className="inline" style={{ color: getCurrentTextColor() || 'inherit' }}>
      {displayedText}
    </span>,
    showCursor && (
      <span
        ref={cursorRef}
        className={`ml-1 inline-block opacity-100 ${shouldHideCursor ? 'hidden' : ''} ${cursorClassName}`}
      >
        {cursorCharacter}
      </span>
    )
  );
};

// ==========================================
// TEXT PRESSURE COMPONENT
// ==========================================

interface TextPressureProps {
  text?: string;
  fontFamily?: string;
  fontUrl?: string;
  width?: boolean;
  weight?: boolean;
  italic?: boolean;
  alpha?: boolean;
  flex?: boolean;
  stroke?: boolean;
  scale?: boolean;
  textColor?: string;
  strokeColor?: string;
  strokeWidth?: number;
  className?: string;
  minFontSize?: number;
}

const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return Math.sqrt(dx * dx + dy * dy);
};

const getAttr = (distance: number, maxDist: number, minVal: number, maxVal: number) => {
  const val = maxVal - Math.abs((maxVal * distance) / maxDist);
  return Math.max(minVal, val + minVal);
};

const debounce = (func: (...args: any[]) => void, delay: number) => {
  let timeoutId: ReturnType<typeof setTimeout>;
  return function (this: any, ...args: any[]) {
    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => {
      func.apply(this, args);
    }, delay);
  };
};

const TextPressure: React.FC<TextPressureProps> = ({
  text = 'Compressa',
  fontFamily = 'Compressa VF',
  fontUrl = 'https://res.cloudinary.com/dr6lvwubh/raw/upload/v1529908256/CompressaPRO-GX.woff2',
  width = true,
  weight = true,
  italic = true,
  alpha = false,
  flex = true,
  stroke = false,
  scale = false,
  textColor = '#FFFFFF',
  strokeColor = '#FF0000',
  strokeWidth = 2,
  className = '',
  minFontSize = 24
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const titleRef = useRef<HTMLHeadingElement | null>(null);
  const spansRef = useRef<(HTMLSpanElement | null)[]>([]);

  const mouseRef = useRef({ x: 0, y: 0 });
  const cursorRef = useRef({ x: 0, y: 0 });

  const [fontSize, setFontSize] = useState(minFontSize);
  const [scaleY, setScaleY] = useState(1);
  const [lineHeight, setLineHeight] = useState(1);

  const chars = text.split('');

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      cursorRef.current.x = e.clientX;
      cursorRef.current.y = e.clientY;
    };
    const handleTouchMove = (e: TouchEvent) => {
      const t = e.touches[0];
      cursorRef.current.x = t.clientX;
      cursorRef.current.y = t.clientY;
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('touchmove', handleTouchMove, { passive: true });

    if (containerRef.current) {
      const { left, top, width, height } = containerRef.current.getBoundingClientRect();
      mouseRef.current.x = left + width / 2;
      mouseRef.current.y = top + height / 2;
      cursorRef.current.x = mouseRef.current.x;
      cursorRef.current.y = mouseRef.current.y;
    }

    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('touchmove', handleTouchMove);
    };
  }, []);

  const setSize = useCallback(() => {
    if (!containerRef.current || !titleRef.current) return;

    const { width: containerW, height: containerH } = containerRef.current.getBoundingClientRect();

    let newFontSize = containerW / (chars.length / 2);
    newFontSize = Math.max(newFontSize, minFontSize);

    setFontSize(newFontSize);
    setScaleY(1);
    setLineHeight(1);

    requestAnimationFrame(() => {
      if (!titleRef.current) return;
      const textRect = titleRef.current.getBoundingClientRect();

      if (scale && textRect.height > 0) {
        const yRatio = containerH / textRect.height;
        setScaleY(yRatio);
        setLineHeight(yRatio);
      }
    });
  }, [chars.length, minFontSize, scale]);

  useEffect(() => {
    const debouncedSetSize = debounce(setSize, 100);
    debouncedSetSize();
    window.addEventListener('resize', debouncedSetSize);
    return () => window.removeEventListener('resize', debouncedSetSize);
  }, [setSize]);

  useEffect(() => {
    let rafId: number;
    const animate = () => {
      mouseRef.current.x += (cursorRef.current.x - mouseRef.current.x) / 15;
      mouseRef.current.y += (cursorRef.current.y - mouseRef.current.y) / 15;

      if (titleRef.current) {
        const titleRect = titleRef.current.getBoundingClientRect();
        const maxDist = titleRect.width / 2;

        spansRef.current.forEach(span => {
          if (!span) return;

          const rect = span.getBoundingClientRect();
          const charCenter = {
            x: rect.x + rect.width / 2,
            y: rect.y + rect.height / 2
          };

          const d = dist(mouseRef.current, charCenter);

          const wdth = width ? Math.floor(getAttr(d, maxDist, 5, 200)) : 100;
          const wght = weight ? Math.floor(getAttr(d, maxDist, 100, 900)) : 400;
          const italVal = italic ? getAttr(d, maxDist, 0, 1).toFixed(2) : '0';
          const alphaVal = alpha ? getAttr(d, maxDist, 0, 1).toFixed(2) : '1';

          const newFontVariationSettings = `'wght' ${wght}, 'wdth' ${wdth}, 'ital' ${italVal}`;

          if (span.style.fontVariationSettings !== newFontVariationSettings) {
            span.style.fontVariationSettings = newFontVariationSettings;
          }
          if (alpha && span.style.opacity !== alphaVal) {
            span.style.opacity = alphaVal;
          }
        });
      }

      rafId = requestAnimationFrame(animate);
    };

    animate();
    return () => cancelAnimationFrame(rafId);
  }, [width, weight, italic, alpha]);

  const styleElement = useMemo(() => {
    return (
      <style>{`
        @font-face {
          font-family: '${fontFamily}';
          src: url('${fontUrl}');
          font-style: normal;
        }
        .stroke span {
          position: relative;
          color: ${textColor};
        }
        .stroke span::after {
          content: attr(data-char);
          position: absolute;
          left: 0;
          top: 0;
          color: transparent;
          z-index: -1;
          -webkit-text-stroke-width: ${strokeWidth}px;
          -webkit-text-stroke-color: ${strokeColor};
        }
      `}</style>
    );
  }, [fontFamily, fontUrl, stroke, textColor, strokeColor, strokeWidth]);

  return (
    <div ref={containerRef} className="relative w-full h-full overflow-hidden bg-transparent">
      {styleElement}
      <h1
        ref={titleRef}
        className={`text-pressure-title ${className} ${
          flex ? 'flex justify-between' : ''
        } ${stroke ? 'stroke' : ''} uppercase text-center`}
        style={{
          fontFamily,
          fontSize: fontSize,
          lineHeight,
          transform: `scale(1, ${scaleY})`,
          transformOrigin: 'center top',
          margin: 0,
          fontWeight: 100,
          color: stroke ? undefined : textColor
        }}
      >
        {chars.map((char, i) => (
          <span
            key={i}
            ref={el => {
              spansRef.current[i] = el;
            }}
            data-char={char}
            className="inline-block"
          >
            {char}
          </span>
        ))}
      </h1>
    </div>
  );
};


// ==========================================
// HYPERSPEED PRESETS (Preset 5: "Highway")
// ==========================================

const hyperspeedPresets = {
  five: {
    onSpeedUp: () => {},
    onSlowDown: () => {},
    distortion: 'turbulentDistortion',
    length: 400,
    roadWidth: 9,
    islandWidth: 2,
    lanesPerRoad: 3,
    fov: 90,
    fovSpeedUp: 150,
    speedUp: 2,
    carLightsFade: 0.4,
    totalSideLightSticks: 50,
    lightPairsPerRoadWay: 50,
    shoulderLinesWidthPercentage: 0.05,
    brokenLinesWidthPercentage: 0.1,
    brokenLinesLengthPercentage: 0.5,
    lightStickWidth: [0.12, 0.5] as [number, number],
    lightStickHeight: [1.3, 1.7] as [number, number],
    movingAwaySpeed: [60, 80] as [number, number],
    movingCloserSpeed: [-120, -160] as [number, number],
    carLightsLength: [400 * 0.05, 400 * 0.15] as [number, number],
    carLightsRadius: [0.05, 0.14] as [number, number],
    carWidthPercentage: [0.3, 0.5] as [number, number],
    carShiftX: [-0.2, 0.2] as [number, number],
    carFloorSeparation: [0.05, 1] as [number, number],
    colors: {
      roadColor: 0x080808,
      islandColor: 0x0a0a0a,
      background: 0x000000,
      shoulderLines: 0x131318,
      brokenLines: 0x131318,
      leftCars: [0xdc5b20, 0xdca320, 0xdc2020], // Highway reds
      rightCars: [0x334bf7, 0xe5e6ed, 0xbfc6f3], // Highway blues/whites
      sticks: 0xc5e8eb
    }
  }
};

// ==========================================
// HYPERSPEED BACKGROUND COMPONENT (NATIVE THREE.JS)
// ==========================================

interface Distortion {
  uniforms: Record<string, { value: any }>;
  getDistortion: string;
  getJS?: (progress: number, time: number) => THREE.Vector3;
}

interface Colors {
  roadColor: number;
  islandColor: number;
  background: number;
  shoulderLines: number;
  brokenLines: number;
  leftCars: number[];
  rightCars: number[];
  sticks: number;
}

interface HyperspeedOptions {
  onSpeedUp?: (ev: MouseEvent | TouchEvent) => void;
  onSlowDown?: (ev: MouseEvent | TouchEvent) => void;
  distortion?: string | Distortion;
  length: number;
  roadWidth: number;
  islandWidth: number;
  lanesPerRoad: number;
  fov: number;
  fovSpeedUp: number;
  speedUp: number;
  carLightsFade: number;
  totalSideLightSticks: number;
  lightPairsPerRoadWay: number;
  shoulderLinesWidthPercentage: number;
  brokenLinesWidthPercentage: number;
  brokenLinesLengthPercentage: number;
  lightStickWidth: [number, number];
  lightStickHeight: [number, number];
  movingAwaySpeed: [number, number];
  movingCloserSpeed: [number, number];
  carLightsLength: [number, number];
  carLightsRadius: [number, number];
  carWidthPercentage: [number, number];
  carShiftX: [number, number];
  carFloorSeparation: [number, number];
  colors: Colors;
}

const hyperspeedDefaultOptions: HyperspeedOptions = {
  ...hyperspeedPresets.five
};

function nsin(val: number) {
  return Math.sin(val) * 0.5 + 0.5;
}

const turbulentUniforms = {
  uFreq: { value: new THREE.Vector4(4, 8, 8, 1) },
  uAmp: { value: new THREE.Vector4(25, 5, 10, 10) }
};

const distortions: Record<string, Distortion> = {
  turbulentDistortion: {
    uniforms: turbulentUniforms,
    getDistortion: `
      uniform vec4 uFreq;
      uniform vec4 uAmp;
      float nsin(float val){
        return sin(val) * 0.5 + 0.5;
      }
      #define PI 3.14159265358979
      float getDistortionX(float progress){
        return (
          cos(PI * progress * uFreq.r + uTime) * uAmp.r +
          pow(cos(PI * progress * uFreq.g + uTime * (uFreq.g / uFreq.r)), 2. ) * uAmp.g
        );
      }
      float getDistortionY(float progress){
        return (
          -nsin(PI * progress * uFreq.b + uTime) * uAmp.b +
          -pow(nsin(PI * progress * uFreq.a + uTime / (uFreq.b / uFreq.a)), 5.) * uAmp.a
        );
      }
      vec3 getDistortion(float progress){
        return vec3(
          getDistortionX(progress) - getDistortionX(0.0125),
          getDistortionY(progress) - getDistortionY(0.0125),
          0.
        );
      }
    `,
    getJS: (progress: number, time: number) => {
      const uFreq = turbulentUniforms.uFreq.value;
      const uAmp = turbulentUniforms.uAmp.value;
      const getX = (p: number) => Math.cos(Math.PI * p * uFreq.x + time) * uAmp.x + Math.pow(Math.cos(Math.PI * p * uFreq.y + time * (uFreq.y / uFreq.x)), 2) * uAmp.y;
      const getY = (p: number) => -nsin(Math.PI * p * uFreq.z + time) * uAmp.z - Math.pow(nsin(Math.PI * p * uFreq.w + time / (uFreq.z / uFreq.w)), 5) * uAmp.w;
      const distortion = new THREE.Vector3(getX(progress) - getX(progress + 0.007), getY(progress) - getY(progress + 0.007), 0);
      const lookAtAmp = new THREE.Vector3(-2, -5, 0);
      const lookAtOffset = new THREE.Vector3(0, 0, -10);
      return distortion.multiply(lookAtAmp).add(lookAtOffset);
    }
  }
};

function random(base: number | [number, number]): number {
  if (Array.isArray(base)) return Math.random() * (base[1] - base[0]) + base[0];
  return Math.random() * base;
}

function pickRandom<T>(arr: T | T[]): T {
  if (Array.isArray(arr)) return arr[Math.floor(Math.random() * arr.length)];
  return arr;
}

function lerp(current: number, target: number, speed = 0.1, limit = 0.001): number {
  let change = (target - current) * speed;
  if (Math.abs(change) < limit) change = target - current;
  return change;
}

class CarLights {
  webgl: HyperspeedEngine;
  options: HyperspeedOptions;
  colors: number[] | THREE.Color;
  speed: [number, number];
  fade: THREE.Vector2;
  mesh!: THREE.Mesh<THREE.InstancedBufferGeometry, THREE.ShaderMaterial>;

  constructor(webgl: HyperspeedEngine, options: HyperspeedOptions, colors: number[] | THREE.Color, speed: [number, number], fade: THREE.Vector2) {
    this.webgl = webgl;
    this.options = options;
    this.colors = colors;
    this.speed = speed;
    this.fade = fade;
  }

  init() {
    const options = this.options;
    const curve = new THREE.LineCurve3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1));
    const geometry = new THREE.TubeGeometry(curve, 40, 1, 8, false);
    const instanced = new THREE.InstancedBufferGeometry().copy(geometry as any) as THREE.InstancedBufferGeometry;
    instanced.instanceCount = options.lightPairsPerRoadWay * 2;

    const laneWidth = options.roadWidth / options.lanesPerRoad;
    const aOffset: number[] = [];
    const aMetrics: number[] = [];
    const aColor: number[] = [];

    let colorArray: THREE.Color[] = Array.isArray(this.colors) ? this.colors.map(c => new THREE.Color(c)) : [new THREE.Color(this.colors)];

    for (let i = 0; i < options.lightPairsPerRoadWay; i++) {
      const radius = random(options.carLightsRadius);
      const length = random(options.carLightsLength);
      const spd = random(this.speed);
      const carLane = i % options.lanesPerRoad;
      let laneX = carLane * laneWidth - options.roadWidth / 2 + laneWidth / 2;
      const carWidth = random(options.carWidthPercentage) * laneWidth;
      const carShiftX = random(options.carShiftX) * laneWidth;
      laneX += carShiftX;
      const offsetY = random(options.carFloorSeparation) + radius * 1.3;
      const offsetZ = -random(options.length);

      aOffset.push(laneX - carWidth / 2, offsetY, offsetZ);
      aOffset.push(laneX + carWidth / 2, offsetY, offsetZ);
      aMetrics.push(radius, length, spd);
      aMetrics.push(radius, length, spd);
      
      const color = pickRandom<THREE.Color>(colorArray);
      aColor.push(color.r, color.g, color.b);
      aColor.push(color.r, color.g, color.b);
    }

    instanced.setAttribute('aOffset', new THREE.InstancedBufferAttribute(new Float32Array(aOffset), 3, false));
    instanced.setAttribute('aMetrics', new THREE.InstancedBufferAttribute(new Float32Array(aMetrics), 3, false));
    instanced.setAttribute('aColor', new THREE.InstancedBufferAttribute(new Float32Array(aColor), 3, false));

    const material = new THREE.ShaderMaterial({
      fragmentShader: `
        #define USE_FOG
        ${THREE.ShaderChunk['fog_pars_fragment']}
        varying vec3 vColor;
        varying vec2 vUv; 
        uniform vec2 uFade;
        void main() {
          vec3 color = vec3(vColor);
          float alpha = smoothstep(uFade.x, uFade.y, vUv.x);
          gl_FragColor = vec4(color, alpha);
          if (gl_FragColor.a < 0.0001) discard;
          ${THREE.ShaderChunk['fog_fragment']}
        }
      `,
      vertexShader: `
        #define USE_FOG
        ${THREE.ShaderChunk['fog_pars_vertex']}
        attribute vec3 aOffset;
        attribute vec3 aMetrics;
        attribute vec3 aColor;
        uniform float uTravelLength;
        uniform float uTime;
        varying vec2 vUv; 
        varying vec3 vColor; 
        #include <getDistortion_vertex>
        void main() {
          vec3 transformed = position.xyz;
          float radius = aMetrics.r;
          float myLength = aMetrics.g;
          float speed = aMetrics.b;
          transformed.xy *= radius;
          transformed.z *= myLength;
          transformed.z += myLength - mod(uTime * speed + aOffset.z, uTravelLength);
          transformed.xy += aOffset.xy;
          float progress = abs(transformed.z / uTravelLength);
          transformed.xyz += getDistortion(progress);
          vec4 mvPosition = modelViewMatrix * vec4(transformed, 1.);
          gl_Position = projectionMatrix * mvPosition;
          vUv = uv;
          vColor = aColor;
          ${THREE.ShaderChunk['fog_vertex']}
        }
      `,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      uniforms: Object.assign(
        { uTime: { value: 0 }, uTravelLength: { value: options.length }, uFade: { value: this.fade } },
        this.webgl.fogUniforms,
        (typeof this.options.distortion === 'object' ? this.options.distortion.uniforms : {}) || {}
      )
    });

    material.onBeforeCompile = shader => {
      shader.vertexShader = shader.vertexShader.replace(
        '#include <getDistortion_vertex>',
        typeof this.options.distortion === 'object' ? this.options.distortion.getDistortion : ''
      );
    };

    const mesh = new THREE.Mesh(instanced, material);
    mesh.frustumCulled = false;
    this.webgl.scene.add(mesh);
    this.mesh = mesh;
  }

  update(time: number) {
    if (this.mesh.material.uniforms.uTime) {
      this.mesh.material.uniforms.uTime.value = time;
    }
  }
}

class LightsSticks {
  webgl: HyperspeedEngine;
  options: HyperspeedOptions;
  mesh!: THREE.Mesh<THREE.InstancedBufferGeometry, THREE.ShaderMaterial>;

  constructor(webgl: HyperspeedEngine, options: HyperspeedOptions) {
    this.webgl = webgl;
    this.options = options;
  }

  init() {
    const options = this.options;
    const geometry = new THREE.PlaneGeometry(1, 1);
    const instanced = new THREE.InstancedBufferGeometry().copy(geometry as any) as THREE.InstancedBufferGeometry;
    const totalSticks = options.totalSideLightSticks;
    instanced.instanceCount = totalSticks;

    const stickoffset = options.length / (totalSticks - 1);
    const aOffset: number[] = [];
    const aColor: number[] = [];
    const aMetrics: number[] = [];

    let colorArray: THREE.Color[] = Array.isArray(options.colors.sticks) ? options.colors.sticks.map(c => new THREE.Color(c)) : [new THREE.Color(options.colors.sticks)];

    for (let i = 0; i < totalSticks; i++) {
      const width = random(options.lightStickWidth);
      const height = random(options.lightStickHeight);
      aOffset.push((i - 1) * stickoffset * 2 + stickoffset * Math.random());
      const color = pickRandom<THREE.Color>(colorArray);
      aColor.push(color.r, color.g, color.b);
      aMetrics.push(width, height);
    }

    instanced.setAttribute('aOffset', new THREE.InstancedBufferAttribute(new Float32Array(aOffset), 1, false));
    instanced.setAttribute('aColor', new THREE.InstancedBufferAttribute(new Float32Array(aColor), 3, false));
    instanced.setAttribute('aMetrics', new THREE.InstancedBufferAttribute(new Float32Array(aMetrics), 2, false));

    const material = new THREE.ShaderMaterial({
      fragmentShader: `
        #define USE_FOG
        ${THREE.ShaderChunk['fog_pars_fragment']}
        varying vec3 vColor;
        void main(){
          vec3 color = vec3(vColor);
          gl_FragColor = vec4(color,1.);
          ${THREE.ShaderChunk['fog_fragment']}
        }
      `,
      vertexShader: `
        #define USE_FOG
        ${THREE.ShaderChunk['fog_pars_vertex']}
        attribute float aOffset;
        attribute vec3 aColor;
        attribute vec2 aMetrics;
        uniform float uTravelLength;
        uniform float uTime;
        varying vec3 vColor;
        mat4 rotationY( in float angle ) {
          return mat4(cos(angle), 0, sin(angle), 0, 0, 1.0, 0, 0, -sin(angle), 0, cos(angle), 0, 0, 0, 0, 1);
        }
        #include <getDistortion_vertex>
        void main(){
          vec3 transformed = position.xyz;
          float width = aMetrics.x;
          float height = aMetrics.y;
          transformed.xy *= vec2(width, height);
          float time = mod(uTime * 60. * 2. + aOffset, uTravelLength);
          transformed = (rotationY(3.14/2.) * vec4(transformed,1.)).xyz;
          transformed.z += - uTravelLength + time;
          float progress = abs(transformed.z / uTravelLength);
          transformed.xyz += getDistortion(progress);
          transformed.y += height / 2.;
          transformed.x += -width / 2.;
          vec4 mvPosition = modelViewMatrix * vec4(transformed, 1.);
          gl_Position = projectionMatrix * mvPosition;
          vColor = aColor;
          ${THREE.ShaderChunk['fog_vertex']}
        }
      `,
      side: THREE.DoubleSide,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      uniforms: Object.assign(
        { uTravelLength: { value: options.length }, uTime: { value: 0 } },
        this.webgl.fogUniforms,
        (typeof options.distortion === 'object' ? options.distortion.uniforms : {}) || {}
      )
    });

    material.onBeforeCompile = shader => {
      shader.vertexShader = shader.vertexShader.replace(
        '#include <getDistortion_vertex>',
        typeof this.options.distortion === 'object' ? this.options.distortion.getDistortion : ''
      );
    };

    const mesh = new THREE.Mesh(instanced, material);
    mesh.frustumCulled = false;
    this.webgl.scene.add(mesh);
    this.mesh = mesh;
  }

  update(time: number) {
    if (this.mesh.material.uniforms.uTime) {
      this.mesh.material.uniforms.uTime.value = time;
    }
  }
}

class Road {
  webgl: HyperspeedEngine;
  options: HyperspeedOptions;
  uTime: { value: number };
  leftRoadWay!: THREE.Mesh;
  rightRoadWay!: THREE.Mesh;
  island!: THREE.Mesh;

  constructor(webgl: HyperspeedEngine, options: HyperspeedOptions) {
    this.webgl = webgl;
    this.options = options;
    this.uTime = { value: 0 };
  }

  createPlane(side: number, width: number, isRoad: boolean) {
    const options = this.options;
    const geometry = new THREE.PlaneGeometry(isRoad ? options.roadWidth : options.islandWidth, options.length, 20, 100);

    let uniforms: Record<string, { value: any }> = {
      uTravelLength: { value: options.length },
      uColor: { value: new THREE.Color(isRoad ? options.colors.roadColor : options.colors.islandColor) },
      uTime: this.uTime
    };

    if (isRoad) {
      uniforms = Object.assign(uniforms, {
        uLanes: { value: options.lanesPerRoad },
        uBrokenLinesColor: { value: new THREE.Color(options.colors.brokenLines) },
        uShoulderLinesColor: { value: new THREE.Color(options.colors.shoulderLines) },
        uShoulderLinesWidthPercentage: { value: options.shoulderLinesWidthPercentage },
        uBrokenLinesLengthPercentage: { value: options.brokenLinesLengthPercentage },
        uBrokenLinesWidthPercentage: { value: options.brokenLinesWidthPercentage }
      });
    }

    const material = new THREE.ShaderMaterial({
      fragmentShader: isRoad ? `
        #define USE_FOG
        varying vec2 vUv; 
        uniform vec3 uColor;
        uniform float uTime;
        uniform float uLanes;
        uniform vec3 uBrokenLinesColor;
        uniform vec3 uShoulderLinesColor;
        uniform float uShoulderLinesWidthPercentage;
        uniform float uBrokenLinesWidthPercentage;
        uniform float uBrokenLinesLengthPercentage;
        ${THREE.ShaderChunk['fog_pars_fragment']}
        void main() {
          vec2 uv = vUv;
          vec3 color = vec3(uColor);
          uv.y = mod(uv.y + uTime * 0.05, 1.);
          float laneWidth = 1.0 / uLanes;
          float brokenLineWidth = laneWidth * uBrokenLinesWidthPercentage;
          float laneEmptySpace = 1. - uBrokenLinesLengthPercentage;
          float brokenLines = step(1.0 - brokenLineWidth, fract(uv.x * 2.0)) * step(laneEmptySpace, fract(uv.y * 10.0));
          float sideLines = step(1.0 - brokenLineWidth, fract((uv.x - laneWidth * (uLanes - 1.0)) * 2.0)) + step(brokenLineWidth, uv.x);
          brokenLines = mix(brokenLines, sideLines, uv.x);
          gl_FragColor = vec4(color, 1.);
          ${THREE.ShaderChunk['fog_fragment']}
        }
      ` : `
        #define USE_FOG
        varying vec2 vUv; 
        uniform vec3 uColor;
        uniform float uTime;
        ${THREE.ShaderChunk['fog_pars_fragment']}
        void main() {
          vec2 uv = vUv;
          vec3 color = vec3(uColor);
          gl_FragColor = vec4(color, 1.);
          ${THREE.ShaderChunk['fog_fragment']}
        }
      `,
      vertexShader: `
        #define USE_FOG
        uniform float uTime;
        ${THREE.ShaderChunk['fog_pars_vertex']}
        uniform float uTravelLength;
        varying vec2 vUv; 
        #include <getDistortion_vertex>
        void main() {
          vec3 transformed = position.xyz;
          vec3 distortion = getDistortion((transformed.y + uTravelLength / 2.) / uTravelLength);
          transformed.x += distortion.x;
          transformed.z += distortion.y;
          transformed.y += -1. * distortion.z;  
          vec4 mvPosition = modelViewMatrix * vec4(transformed, 1.);
          gl_Position = projectionMatrix * mvPosition;
          vUv = uv;
          ${THREE.ShaderChunk['fog_vertex']}
        }
      `,
      side: THREE.DoubleSide,
      uniforms: Object.assign(uniforms, this.webgl.fogUniforms, (typeof options.distortion === 'object' ? options.distortion.uniforms : {}) || {})
    });

    material.onBeforeCompile = shader => {
      shader.vertexShader = shader.vertexShader.replace(
        '#include <getDistortion_vertex>',
        typeof this.options.distortion === 'object' ? this.options.distortion.getDistortion : ''
      );
    };

    const mesh = new THREE.Mesh(geometry, material);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.z = -options.length / 2;
    mesh.position.x += (this.options.islandWidth / 2 + options.roadWidth / 2) * side;
    this.webgl.scene.add(mesh);
    return mesh;
  }

  init() {
    this.leftRoadWay = this.createPlane(-1, this.options.roadWidth, true);
    this.rightRoadWay = this.createPlane(1, this.options.roadWidth, true);
    this.island = this.createPlane(0, this.options.islandWidth, false);
  }

  update(time: number) {
    this.uTime.value = time;
  }
}

class HyperspeedEngine {
  container: HTMLElement;
  options: HyperspeedOptions;
  renderer: THREE.WebGLRenderer;
  camera: THREE.PerspectiveCamera;
  scene: THREE.Scene;
  clock: THREE.Clock;
  disposed: boolean;
  road: Road;
  leftCarLights: CarLights;
  rightCarLights: CarLights;
  leftSticks: LightsSticks;
  fogUniforms: Record<string, { value: any }>;
  fovTarget: number;
  speedUpTarget: number;
  speedUp: number;
  timeOffset: number;
  lastWidth: number;
  lastHeight: number;

  constructor(container: HTMLElement, options: HyperspeedOptions) {
    this.options = options;
    if (!this.options.distortion) this.options.distortion = distortions['turbulentDistortion'];
    this.container = container;

    const initW = Math.max(1, container.offsetWidth);
    const initH = Math.max(1, container.offsetHeight);
    this.lastWidth = initW;
    this.lastHeight = initH;

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setSize(initW, initH, false);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    container.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(options.fov, initW / initH, 0.1, 10000);
    this.camera.position.set(0, 8, -5);
    this.scene = new THREE.Scene();
    this.scene.background = null;

    const fog = new THREE.Fog(options.colors.background, options.length * 0.2, options.length * 500);
    this.scene.fog = fog;
    this.fogUniforms = { fogColor: { value: fog.color }, fogNear: { value: fog.near }, fogFar: { value: fog.far } };

    this.clock = new THREE.Clock();
    this.disposed = false;

    this.road = new Road(this, options);
    this.leftCarLights = new CarLights(this, options, options.colors.leftCars, options.movingAwaySpeed, new THREE.Vector2(0, 1 - options.carLightsFade));
    this.rightCarLights = new CarLights(this, options, options.colors.rightCars, options.movingCloserSpeed, new THREE.Vector2(1, 0 + options.carLightsFade));
    this.leftSticks = new LightsSticks(this, options);

    this.fovTarget = options.fov;
    this.speedUpTarget = 0;
    this.speedUp = 0;
    this.timeOffset = 0;

    this.tick = this.tick.bind(this);
    this.onWindowResize = this.onWindowResize.bind(this);
    window.addEventListener('resize', this.onWindowResize);
  }

  onWindowResize() {
    const width = this.container.offsetWidth;
    const height = this.container.offsetHeight;
    if (width <= 0 || height <= 0) return;
    this.lastWidth = width;
    this.lastHeight = height;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  init() {
    const options = this.options;
    this.road.init();
    this.leftCarLights.init();
    this.leftCarLights.mesh.position.setX(-options.roadWidth / 2 - options.islandWidth / 2);
    this.rightCarLights.init();
    this.rightCarLights.mesh.position.setX(options.roadWidth / 2 + options.islandWidth / 2);
    this.leftSticks.init();
    this.leftSticks.mesh.position.setX(-(options.roadWidth + options.islandWidth / 2));
    this.tick();
  }

  update(delta: number) {
    const lerpPercentage = Math.exp(-(-60 * Math.log2(1 - 0.1)) * delta);
    this.speedUp += lerp(this.speedUp, this.speedUpTarget, lerpPercentage, 0.00001);
    this.timeOffset += this.speedUp * delta;
    const time = this.clock.elapsedTime + this.timeOffset;

    this.rightCarLights.update(time);
    this.leftCarLights.update(time);
    this.leftSticks.update(time);
    this.road.update(time);

    let updateCamera = false;
    const fovChange = lerp(this.camera.fov, this.fovTarget, lerpPercentage);
    if (fovChange !== 0) {
      this.camera.fov += fovChange * delta * 6;
      updateCamera = true;
    }

    if (typeof this.options.distortion === 'object' && this.options.distortion.getJS) {
      const distortion = this.options.distortion.getJS(0.025, time);
      this.camera.lookAt(new THREE.Vector3(this.camera.position.x + distortion.x, this.camera.position.y + distortion.y, this.camera.position.z + distortion.z));
      updateCamera = true;
    }

    if (updateCamera) this.camera.updateProjectionMatrix();
  }

  tick() {
    if (this.disposed) return;
    
    const width = this.container.clientWidth;
    const height = this.container.clientHeight;
    
    if (width !== this.lastWidth || height !== this.lastHeight) {
      this.lastWidth = width;
      this.lastHeight = height;
      this.renderer.setSize(width, height, false);
      this.camera.aspect = width / height;
      this.camera.updateProjectionMatrix();
    }

    const delta = this.clock.getDelta();
    this.update(delta);
    this.renderer.render(this.scene, this.camera);
    requestAnimationFrame(this.tick);
  }

  dispose() {
    this.disposed = true;
    if (this.scene) {
      this.scene.traverse(object => {
        const obj = object as unknown as THREE.Mesh;
        if (!obj.isMesh) return;
        if (obj.geometry) obj.geometry.dispose();
        if (obj.material) {
          if (Array.isArray(obj.material)) obj.material.forEach(m => m.dispose());
          else obj.material.dispose();
        }
      });
      this.scene.clear();
    }
    if (this.renderer) {
      this.renderer.dispose();
      this.renderer.forceContextLoss();
      if (this.renderer.domElement && this.renderer.domElement.parentNode) {
        this.renderer.domElement.parentNode.removeChild(this.renderer.domElement);
      }
    }
    window.removeEventListener('resize', this.onWindowResize);
  }
}

const Hyperspeed: React.FC<{ effectOptions?: Partial<HyperspeedOptions> }> = ({ effectOptions = {} }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const appRef = useRef<HyperspeedEngine | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const options: HyperspeedOptions = {
      ...hyperspeedDefaultOptions,
      ...effectOptions,
      colors: { ...hyperspeedDefaultOptions.colors, ...effectOptions.colors }
    };
    if (typeof options.distortion === 'string') options.distortion = distortions[options.distortion];

    const engine = new HyperspeedEngine(containerRef.current, options);
    appRef.current = engine;
    engine.init();

    return () => {
      if (appRef.current) appRef.current.dispose();
    };
  }, [effectOptions]);

  return <div className="absolute inset-0 w-full h-full z-0" ref={containerRef}></div>;
};

// ==========================================
// PIXEL CARD COMPONENT
// ==========================================

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

function getEffectiveSpeed(value: number, reducedMotion: boolean) {
  const min = 0;
  const max = 100;
  const throttle = 0.001;
  if (value <= min || reducedMotion) return min;
  else if (value >= max) return max * throttle;
  else return value * throttle;
}

interface PixelCardProps {
  gap?: number;
  speed?: number;
  colors?: string;
  noFocus?: boolean;
  className?: string;
  children: React.ReactNode;
}

const PixelCard: React.FC<PixelCardProps> = ({ gap = 5, speed = 35, colors = '#f8fafc,#f1f5f9,#cbd5e1', noFocus = false, className = '', children }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pixelsRef = useRef<Pixel[]>([]);
  const animationRef = useRef<ReturnType<typeof requestAnimationFrame> | null>(null);
  const timePreviousRef = useRef(performance.now());
  const reducedMotion = useRef(
    typeof window !== 'undefined' ? window.matchMedia('(prefers-reduced-motion: reduce)').matches : false,
  ).current;

  const initPixels = () => {
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
  };

  const doAnimate = (fnName: 'appear' | 'disappear') => {
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
  };

  const handleAnimation = (name: 'appear' | 'disappear') => {
    if (animationRef.current !== null) cancelAnimationFrame(animationRef.current);
    animationRef.current = requestAnimationFrame(() => doAnimate(name));
  };

  useEffect(() => {
    initPixels();
    const observer = new ResizeObserver(() => initPixels());
    if (containerRef.current) observer.observe(containerRef.current);
    return () => { observer.disconnect(); if (animationRef.current !== null) cancelAnimationFrame(animationRef.current); };
  }, [gap, speed, colors, noFocus]);

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
      <canvas className="absolute inset-0 w-full h-full block pointer-events-none z-0" ref={canvasRef} />
      <div className="relative z-10 w-full h-full flex flex-col">{children}</div>
    </div>
  );
};

interface RunButtonProps {
  onClick?: (e?: React.MouseEvent) => void;
  disabled?: boolean;
  className?: string;
  children: React.ReactNode;
}

const RunButton: React.FC<RunButtonProps> = ({ onClick, disabled = false, className = '', children }) => {
  return (
    <div className={`h-[48px] w-full ${className}`}>
      <PixelCard
        noFocus={true}
        colors="#3f3f46,#27272a,#18181b" 
        gap={4}
        speed={35}
        className={`w-full h-full rounded-md transition-all shadow-sm ${
          disabled 
            ? 'bg-[#000000] opacity-50 cursor-not-allowed border border-[#1A1A1A]' 
            : 'bg-[#050505] hover:bg-[#111111] cursor-pointer border border-[#262626] hover:border-[#3f3f46] shadow-[0_4px_15px_rgba(0,0,0,0.5)]'
        }`}
      >
        <button 
          onClick={disabled ? undefined : onClick} 
          disabled={disabled}
          className={`w-full h-full flex items-center justify-center gap-2 font-semibold text-sm outline-none focus:outline-none transition-colors ${
            disabled ? 'text-zinc-600' : 'text-zinc-100'
          }`}
        >
          {children}
        </button>
      </PixelCard>
    </div>
  );
};

// ==========================================
// LANDING PAGE APP COMPONENT
// ==========================================

export default function App() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [booting, setBooting] = useState(true);
  const [session, setSession] = useState<SessionPayload | null>(null);
  const [installations, setInstallations] = useState<InstallationRecord[]>([]);

  const loadState = useCallback(async (syncAfterReturn = false) => {
    try {
      const sessionRes = await fetch('/api/auth/session', { cache: 'no-store' });
      const sessionData = await sessionRes.json().catch(() => ({})) as SessionPayload;
      setSession(sessionData);

      if (!sessionData.isLoggedIn || !sessionData.user) {
        setInstallations([]);
        return;
      }

      if (syncAfterReturn) {
        await fetch('/api/sync', { method: 'POST' }).catch(() => undefined);
      }

      let installationsRes = await fetch('/api/installations', { cache: 'no-store' });
      if (!installationsRes.ok) {
        await fetch('/api/sync', { method: 'POST' }).catch(() => undefined);
        installationsRes = await fetch('/api/installations', { cache: 'no-store' });
      }

      const installationsData = await installationsRes.json().catch(() => ({})) as {
        installations?: InstallationRecord[];
      };
      setInstallations(Array.isArray(installationsData.installations) ? installationsData.installations : []);
    } finally {
      setBooting(false);
    }
  }, []);

  useEffect(() => {
    void loadState(Boolean(searchParams.get('error')));
  }, [loadState, searchParams]);

  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        void loadState(true);
      }
    };
    const handlePageShow = () => {
      void loadState(true);
    };

    document.addEventListener('visibilitychange', handleVisibility);
    window.addEventListener('pageshow', handlePageShow);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibility);
      window.removeEventListener('pageshow', handlePageShow);
    };
  }, [loadState]);

  const isLoggedIn = Boolean(session?.isLoggedIn && session?.user);
  const githubConnected = installations.length > 0;

  const handleGitHubAction = useCallback(() => {
    if (!isLoggedIn) {
      window.location.assign('/api/auth/login?force=1');
      return;
    }
    if (!githubConnected) {
      router.push('/dashboard/projects');
      return;
    }
    router.push('/dashboard');
  }, [githubConnected, isLoggedIn, router]);

  const handleLaunchWorkspace = useCallback(() => {
    if (isLoggedIn) {
      router.push('/dashboard');
      return;
    }
    window.location.assign('/api/auth/login?force=1');
  }, [isLoggedIn, router]);

  if (booting) {
    return <LoadingScreen invert />;
  }

  return (
    <div className="relative w-full h-screen bg-[#000000] overflow-hidden flex flex-col justify-between selection:bg-indigo-500">
      {/* Background Effect */}
      <div className="absolute inset-0 z-0">
         <Hyperspeed effectOptions={hyperspeedPresets.five} />
         {/* Top Gradient Fade to block hard edge */}
         <div className="absolute inset-0 bg-gradient-to-b from-[#000000]/90 via-[#000000]/20 to-[#000000]/90 pointer-events-none"></div>
      </div>

      {/* Header */}
      <header className="relative z-10 flex justify-between items-center p-8 w-full max-w-7xl mx-auto">
        <div className="w-64 h-16 relative cursor-default">
          <TextPressure 
            text="DEPLAI" 
            flex={true} 
            alpha={false} 
            stroke={false} 
            width={true} 
            weight={true} 
            italic={true} 
            scale={true}
            textColor="#ffffff" 
          />
        </div>
        <div className="relative group">
          <button 
            className="flex items-center justify-center w-10 h-10 rounded-full border border-[#262626] bg-[#050505] group-hover:bg-[#111111] group-hover:border-zinc-600 transition-all duration-300 cursor-pointer shadow-[0_0_15px_rgba(99,102,241,0.2)]"
          >
            <LogIn className="w-4 h-4 text-zinc-400 group-hover:text-white transition-colors" />
          </button>
          
          {/* Dropdown Menu */}
          <div className="absolute right-0 top-full pt-3 opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto transition-all duration-300 z-50 w-56">
            <div className="translate-y-2 group-hover:translate-y-0 transition-transform duration-300">
              <RunButton onClick={handleGitHubAction}>
                <Github className="w-4 h-4 text-white" />
                <span>Continue with GitHub</span>
              </RunButton>
            </div>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="relative z-10 flex flex-col items-center justify-center text-center px-4 w-full flex-1 pointer-events-none">
        <TextType 
          text={[
            "Deploy Anywhere\nTest Everything",
            "Ship Faster\nBreak Nothing",
            "Scale Globally\nSecure Instantly"
          ]}
          as="h2"
          className="text-5xl md:text-7xl font-bold text-white tracking-tight leading-tight drop-shadow-2xl"
          typingSpeed={60}
          deletingSpeed={30}
          pauseDuration={3000}
        />

        <div className="mt-16 w-64 pointer-events-auto">
           <RunButton onClick={handleLaunchWorkspace}>
             Launch Workspace
           </RunButton>
        </div>
      </main>

      {/* Footer */}
      <footer className="relative z-10 p-8 w-full max-w-7xl mx-auto flex items-center justify-center text-xs text-zinc-500 border-t border-[#1A1A1A] mt-auto bg-[#000000]/50 backdrop-blur-sm pointer-events-none">
        <p>Built for developers, by developers.</p>
      </footer>
    </div>
  );
}
