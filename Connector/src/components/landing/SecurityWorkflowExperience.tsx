'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { gsap } from 'gsap';
import * as THREE from 'three';
import { Check, Cpu, Merge, Pause, Play, SatelliteDish, ShieldAlert } from 'lucide-react';

import styles from './SecurityWorkflowExperience.module.css';

type WorkflowStep = 0 | 1 | 2 | 3;

const workflowSteps = [
  { id: '01', label: 'Discovery' },
  { id: '02', label: 'Risk Map' },
  { id: '03', label: 'Remediation' },
  { id: '04', label: 'Validation' },
] as const;

const PARTICLE_COUNT = 2600;

function randomPointInSphere(radius: number) {
  const theta = Math.random() * Math.PI * 2;
  const phi = Math.acos(Math.random() * 2 - 1);
  const distance = Math.cbrt(Math.random()) * radius;
  const sinPhi = Math.sin(phi);
  return {
    x: distance * sinPhi * Math.cos(theta),
    y: distance * sinPhi * Math.sin(theta),
    z: distance * Math.cos(phi),
  };
}

export function SecurityWorkflowExperience() {
  const canvasContainerRef = useRef<HTMLDivElement>(null);
  const animationStateRef = useRef<{
    updateStep: (step: WorkflowStep) => void;
  } | null>(null);
  const [activeStep, setActiveStep] = useState<WorkflowStep>(0);
  const [isPlaying, setIsPlaying] = useState(false);

  useEffect(() => {
    const container = canvasContainerRef.current;
    if (!container) return;

    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2('#050505', 0.045);
    const camera = new THREE.PerspectiveCamera(58, 1, 0.1, 1000);
    camera.position.set(-3.5, 0, 15);
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.8));
    renderer.setClearAlpha(0);
    container.appendChild(renderer.domElement);

    const geometry = new THREE.BufferGeometry();
    const positions = new Float32Array(PARTICLE_COUNT * 3);
    const colors = new Float32Array(PARTICLE_COUNT * 3);
    const sphere = new Float32Array(PARTICLE_COUNT * 3);
    const fragmentedCore = new Float32Array(PARTICLE_COUNT * 3);
    const dna = new Float32Array(PARTICLE_COUNT * 3);
    const torus = new Float32Array(PARTICLE_COUNT * 3);
    const accent = new THREE.Color('#ff7a9e');
    const alert = new THREE.Color('#ff4444');
    const success = new THREE.Color('#00e676');
    const muted = new THREE.Color('#3b242d');

    for (let index = 0; index < PARTICLE_COUNT; index += 1) {
      const index3 = index * 3;
      const spherePoint = randomPointInSphere(7.5);
      sphere[index3] = positions[index3] = spherePoint.x;
      sphere[index3 + 1] = positions[index3 + 1] = spherePoint.y;
      sphere[index3 + 2] = positions[index3 + 2] = spherePoint.z;

      const coreRadius = 5.75 + Math.sin(index * 0.1) * 3;
      const coreAngle = Math.random() * Math.PI * 2;
      const corePolar = Math.acos(Math.random() * 2 - 1);
      fragmentedCore[index3] = coreRadius * Math.sin(corePolar) * Math.cos(coreAngle);
      fragmentedCore[index3 + 1] = coreRadius * Math.sin(corePolar) * Math.sin(coreAngle) + (Math.random() - 0.5) * 4;
      fragmentedCore[index3 + 2] = coreRadius * Math.cos(corePolar);

      const helixPosition = (index / PARTICLE_COUNT) * Math.PI * 20;
      const helixOffset = index % 2 === 0 ? Math.PI : 0;
      dna[index3] = Math.cos(helixPosition + helixOffset) * 4;
      dna[index3 + 1] = (index / PARTICLE_COUNT) * 15 - 7.5;
      dna[index3 + 2] = Math.sin(helixPosition + helixOffset) * 4;

      const tubeAngle = Math.random() * Math.PI * 2;
      const ringAngle = Math.random() * Math.PI * 2;
      torus[index3] = (5.75 + 1.9 * Math.cos(tubeAngle)) * Math.cos(ringAngle);
      torus[index3 + 1] = 1.9 * Math.sin(tubeAngle);
      torus[index3 + 2] = (5.75 + 1.9 * Math.cos(tubeAngle)) * Math.sin(ringAngle);
      accent.toArray(colors, index3);
    }

    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    const particleMaterial = new THREE.PointsMaterial({
      size: 0.075,
      vertexColors: true,
      blending: THREE.AdditiveBlending,
      transparent: true,
      opacity: 0.82,
      depthWrite: false,
    });
    const particleSystem = new THREE.Points(geometry, particleMaterial);
    scene.add(particleSystem);

    const rings = new THREE.Group();
    const ringGeometry = new THREE.TorusGeometry(9.8, 0.018, 12, 96);
    const ringMaterial = new THREE.MeshBasicMaterial({ color: '#ff7a9e', transparent: true, opacity: 0.2 });
    for (let index = 0; index < 3; index += 1) {
      const ring = new THREE.Mesh(ringGeometry, ringMaterial);
      ring.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, 0);
      rings.add(ring);
    }
    scene.add(rings);

    const resize = () => {
      const { width, height } = container.getBoundingClientRect();
      if (!width || !height) return;
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height, false);
    };
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(container);
    resize();

    let targetShape = sphere;
    let lerpSpeed = 0.04;
    let targetRotation = { x: 0.01, y: 0.015 };
    const currentRotation = { x: 0.002, y: 0.003 };
    const updateStep = (step: WorkflowStep) => {
      const colorData = (geometry.getAttribute('color') as THREE.BufferAttribute).array as Float32Array;
      if (step === 0) {
        targetShape = sphere; lerpSpeed = 0.04; targetRotation = { x: 0.01, y: 0.015 };
        for (let index = 0; index < PARTICLE_COUNT; index += 1) accent.toArray(colorData, index * 3);
      } else if (step === 1) {
        targetShape = fragmentedCore; lerpSpeed = 0.03; targetRotation = { x: 0.001, y: 0.005 };
        for (let index = 0; index < PARTICLE_COUNT; index += 1) ((index * 17) % 5 === 0 ? alert : muted).toArray(colorData, index * 3);
      } else if (step === 2) {
        targetShape = dna; lerpSpeed = 0.02; targetRotation = { x: 0.005, y: 0.02 };
        for (let index = 0; index < PARTICLE_COUNT; index += 1) (index % 2 === 0 ? accent : success).toArray(colorData, index * 3);
      } else {
        targetShape = torus; lerpSpeed = 0.05; targetRotation = { x: 0.002, y: 0.002 };
        for (let index = 0; index < PARTICLE_COUNT; index += 1) accent.toArray(colorData, index * 3);
      }
      geometry.getAttribute('color').needsUpdate = true;
      gsap.to(camera.position, { x: -3.5 + step * 1.25, z: 15 - step * 0.85, duration: reduceMotion ? 0 : 1.8, ease: 'power2.inOut', overwrite: true });
    };
    animationStateRef.current = { updateStep };
    updateStep(0);

    const clock = new THREE.Clock();
    let frameId = 0;
    const animate = () => {
      frameId = window.requestAnimationFrame(animate);
      currentRotation.x += (targetRotation.x - currentRotation.x) * 0.045;
      currentRotation.y += (targetRotation.y - currentRotation.y) * 0.045;
      particleSystem.rotation.x += currentRotation.x;
      particleSystem.rotation.y += currentRotation.y;
      rings.rotation.x += currentRotation.x * 0.45;
      rings.rotation.y += currentRotation.y * 0.45;
      rings.children.forEach((ring, index) => { ring.rotation.x += 0.0009 * (index + 1); });
      if (!reduceMotion) {
        const particlePositions = (geometry.getAttribute('position') as THREE.BufferAttribute).array as Float32Array;
        for (let index = 0; index < particlePositions.length; index += 1) particlePositions[index] += (targetShape[index] - particlePositions[index]) * lerpSpeed;
        geometry.getAttribute('position').needsUpdate = true;
        particleSystem.position.y = Math.sin(clock.getElapsedTime()) * 0.42;
      }
      renderer.render(scene, camera);
    };
    animate();

    return () => {
      animationStateRef.current = null;
      window.cancelAnimationFrame(frameId);
      resizeObserver.disconnect();
      gsap.killTweensOf(camera.position);
      geometry.dispose(); particleMaterial.dispose(); ringGeometry.dispose(); ringMaterial.dispose(); renderer.dispose(); renderer.domElement.remove();
    };
  }, []);

  const selectStep = useCallback((step: WorkflowStep) => {
    setActiveStep(step);
    animationStateRef.current?.updateStep(step);
  }, []);

  useEffect(() => {
    if (!isPlaying) return;
    const interval = window.setInterval(() => {
      setActiveStep((step) => {
        const nextStep = ((step + 1) % workflowSteps.length) as WorkflowStep;
        animationStateRef.current?.updateStep(nextStep);
        return nextStep;
      });
    }, 4000);
    return () => window.clearInterval(interval);
  }, [isPlaying]);

  return (
    <div className={styles.experience}>
      <div ref={canvasContainerRef} className={styles.canvas} aria-hidden="true" />
      <div className={styles.overlay}>
        <aside className={styles.navigation} aria-label="Security workflow stages">
          <div className={styles.identity}>
            <div className={styles.identityTitle}><span className={styles.identityDot} /> Sys.Core</div>
            <div className={styles.identityVersion}>V 3.4.1 // Active</div>
          </div>
          <div className={styles.steps}>
            {workflowSteps.map((step, index) => {
              const isActive = index === activeStep;
              return <button key={step.id} type="button" className={`${styles.step} ${isActive ? styles.stepActive : ''}`} onClick={() => selectStep(index as WorkflowStep)} aria-pressed={isActive}><span className={styles.stepId}>[ {step.id} ]</span><span className={styles.stepLabel}>{step.label}</span></button>;
            })}
          </div>
          <button type="button" className={styles.playButton} onClick={() => setIsPlaying((playing) => !playing)}><span><strong>{isPlaying ? 'Pause Simulation' : 'Execute Chain'}</strong><small>Auto-sequencer</small></span>{isPlaying ? <Pause size={14} aria-hidden="true" /> : <Play size={14} aria-hidden="true" />}</button>
        </aside>
        <section className={styles.hud} aria-live="polite"><div className={styles.bracket} aria-hidden="true" /><WorkflowPanel step={activeStep} /></section>
      </div>
    </div>
  );
}

function WorkflowPanel({ step }: { step: WorkflowStep }) {
  if (step === 0) return <div className={styles.panel}><PanelHeading eyebrow="Status: Scanning" title="Deep Context Analysis" icon={<SatelliteDish size={16} />} /><div className={styles.dataGrid}><DataCell label="Vectors indexed" value="14,204" /><DataCell label="Dependencies" value="3,192" /><div className={`${styles.dataCell} ${styles.ruleset}`}><span>Active ruleset</span><strong>OWASP Core v4</strong></div></div><div className={styles.load}><div><span>Engine load</span><span>84%</span></div><div className={styles.loadTrack}><i /></div></div></div>;
  if (step === 1) return <div className={styles.panel}><PanelHeading eyebrow="Status: Anomalies detected" title="Threat Isolation" badge="3 Crit" icon={<ShieldAlert size={16} />} /><div className={styles.findings}><Finding mark="[!]" title="SQL Injection Vector" location="auth_controller.js:142" severity="critical" /><Finding mark="[-]" title="Outdated Package" location="lodash < 4.17.21" severity="high" /><Finding mark="[i]" title="Hardcoded Secret Suspected" location="config/db.yml:12" severity="info" /></div></div>;
  if (step === 2) return <div className={styles.panel}><PanelHeading eyebrow="Status: Synthesizing code" title="AI Resolution" icon={<Cpu size={16} />} /><div className={styles.diff}><div className={styles.scanLine} /><p className={styles.diffMeta}>@@ -141,4 +141,5 @@</p><p className={styles.diffRemoved}><span>-</span>query = &quot;SELECT * FROM users WHERE id = &quot; + req.body.id;</p><p className={styles.diffAdded}><span>+</span>query = &quot;SELECT * FROM users WHERE id = $1&quot;;</p><p className={styles.diffAdded}><span>+</span>const values = [req.body.id];</p><p className={styles.diffMeta}>  return db.query(query, values);</p></div><div className={styles.metadata}><div><span>Engine</span><strong>Internal LLM</strong></div><div><span>Privacy</span><strong>BYOK enforced</strong></div></div></div>;
  return <div className={styles.panel}><PanelHeading eyebrow="Status: Verified" title="Deployment Gate" icon={<Check size={16} />} status /><div className={styles.dataGrid}><DataCell label="Residual risk" value="0.0%" success /><DataCell label="Build pipeline" value="PASS" /></div><button type="button" className={styles.mergeButton}><span>Merge Pull Request</span><Merge size={15} aria-hidden="true" /></button></div>;
}

function PanelHeading({ eyebrow, title, icon, badge, status }: { eyebrow: string; title: string; icon: ReactNode; badge?: string; status?: boolean }) {
  return <div className={styles.panelHeading}><div><p className={`${styles.eyebrow} ${status ? styles.successText : ''}`}>{eyebrow}</p><h3>{title}</h3></div>{badge ? <span className={styles.badge}>{badge}</span> : status ? <span className={styles.statusDot} /> : <span className={styles.headingIcon}>{icon}</span>}</div>;
}

function DataCell({ label, value, success }: { label: string; value: string; success?: boolean }) {
  return <div className={styles.dataCell}><span>{label}</span><strong className={success ? styles.successText : ''}>{value}</strong></div>;
}

function Finding({ mark, title, location, severity }: { mark: string; title: string; location: string; severity: 'critical' | 'high' | 'info' }) {
  return <div className={`${styles.finding} ${styles[severity]}`}><span>{mark}</span><div><strong>{title}</strong><small>{location}</small></div></div>;
}
