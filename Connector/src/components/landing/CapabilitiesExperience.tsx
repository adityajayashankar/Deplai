'use client';

import { useEffect, useRef, useState } from 'react';
import { GitBranch, Github, Gitlab, HardDrive, Network, type LucideIcon } from 'lucide-react';

import styles from './CapabilitiesExperience.module.css';

type NodeType = 'center' | 'child' | 'secondary';

type TopologyNode = {
  x: number;
  y: number;
  baseX: number;
  baseY: number;
  targetX: number;
  targetY: number;
  radius: number;
  type: NodeType;
  offset: number;
};

type Connection = { from: number; to: number };

const integrations: ReadonlyArray<{ id: 'github' | 'local' | 'gitlab' | 'bitbucket'; label: string; icon: LucideIcon; soon?: boolean }> = [
  { id: 'github', label: 'GitHub', icon: Github },
  { id: 'local', label: 'Local files', icon: HardDrive },
  { id: 'gitlab', label: 'GitLab', icon: Gitlab, soon: true },
  { id: 'bitbucket', label: 'Bitbucket', icon: GitBranch, soon: true },
];

const workflow = [
  ['01. Ingestion', 'Connect cloud repositories or local environments instantly.'],
  ['02. Decoupled UI', 'Modify frontend interfaces securely without altering core business logic.'],
  ['03. Security remediation', 'Autonomous security scanning paired with AI-driven agent patching.'],
  ['04. Auto deployment', 'Auto-provision required infrastructure and execute zero-touch deployments.'],
] as const;

export function CapabilitiesExperience() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const canvasFrameRef = useRef<number | null>(null);
  const [activeIntegration, setActiveIntegration] = useState<'github' | 'local'>('github');
  const [health, setHealth] = useState(0);
  const [bars, setBars] = useState(() => Array.from({ length: 10 }, (_, index) => (index > 7 ? 88 : 26 + index * 6)));

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext('2d');
    if (!context) return;

    let nodes: TopologyNode[] = [];
    let connections: Connection[] = [];
    let mouseX = -1000;
    let mouseY = -1000;

    const initialiseCanvas = () => {
      const parent = canvas.parentElement;
      if (!parent) return;
      const { width, height } = parent.getBoundingClientRect();
      const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.max(1, Math.floor(width * pixelRatio));
      canvas.height = Math.max(1, Math.floor(height * pixelRatio));
      context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);

      const centerX = width / 2;
      const centerY = height / 2;
      nodes = [{ x: centerX, y: centerY, baseX: centerX, baseY: centerY, targetX: centerX, targetY: centerY, radius: 32, type: 'center', offset: 0 }];
      connections = [];

      for (let index = 0; index < 6; index += 1) {
        const angle = (index * Math.PI * 2) / 6;
        const x = centerX + Math.cos(angle) * 120;
        const y = centerY + Math.sin(angle) * 120;
        nodes.push({ x, y, baseX: x, baseY: y, targetX: x, targetY: y, radius: 12, type: 'child', offset: index });
        connections.push({ from: 0, to: nodes.length - 1 });
      }

      for (let index = 0; index < 8; index += 1) {
        const angle = (index * Math.PI * 2) / 8 + 0.5;
        const x = centerX + Math.cos(angle) * 240;
        const y = centerY + Math.sin(angle) * 240;
        nodes.push({ x, y, baseX: x, baseY: y, targetX: x, targetY: y, radius: 8, type: 'secondary', offset: index * 2 });
        connections.push({ from: (index % 6) + 1, to: nodes.length - 1 });
        if (index > 0 && index % 2 === 0) connections.push({ from: nodes.length - 2, to: nodes.length - 1 });
      }
    };

    const onPointerMove = (event: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      mouseX = event.clientX - rect.left;
      mouseY = event.clientY - rect.top;
    };
    const clearMouse = () => { mouseX = -1000; mouseY = -1000; };

    const draw = (time: number) => {
      const width = canvas.width / Math.min(window.devicePixelRatio || 1, 2);
      const height = canvas.height / Math.min(window.devicePixelRatio || 1, 2);
      context.clearRect(0, 0, width, height);

      nodes.forEach((node) => {
        if (node.type === 'child' || node.type === 'secondary') {
          const speed = node.type === 'child' ? 1000 : 1500;
          const magnitude = node.type === 'child' ? 8 : 15;
          node.targetX = node.baseX + Math.cos(time / speed + node.offset) * magnitude;
          node.targetY = node.baseY + Math.sin(time / speed + node.offset) * magnitude;
        } else {
          node.targetX = node.baseX;
          node.targetY = node.baseY;
        }

        const deltaX = mouseX - node.x;
        const deltaY = mouseY - node.y;
        const distance = Math.hypot(deltaX, deltaY);
        if (distance > 0.1 && distance < 100) {
          const force = (100 - distance) / 100;
          node.targetX -= (deltaX / distance) * force * 30;
          node.targetY -= (deltaY / distance) * force * 30;
        }
        node.x += (node.targetX - node.x) * 0.08;
        node.y += (node.targetY - node.y) * 0.08;
      });

      connections.forEach((connection) => {
        const from = nodes[connection.from];
        const to = nodes[connection.to];
        const gradient = context.createLinearGradient(from.x, from.y, to.x, to.y);
        gradient.addColorStop(0, 'rgba(255, 122, 158, 0.4)');
        gradient.addColorStop(1, 'rgba(255, 122, 158, 0.05)');
        context.beginPath();
        context.lineWidth = to.type === 'secondary' ? 1 : 2;
        context.strokeStyle = gradient;
        context.moveTo(from.x, from.y);
        context.lineTo(to.x, to.y);
        context.stroke();

        if (to.type === 'child') {
          const progress = (time % 1000) / 1000;
          const packetX = from.x + (to.x - from.x) * progress;
          const packetY = from.y + (to.y - from.y) * progress;
          context.beginPath();
          context.fillStyle = '#ff7a9e';
          context.shadowBlur = 10;
          context.shadowColor = '#ff7a9e';
          context.arc(packetX, packetY, 2, 0, Math.PI * 2);
          context.fill();
          context.shadowBlur = 0;
        }
      });

      nodes.forEach((node) => {
        context.beginPath();
        context.arc(node.x, node.y, node.radius, 0, Math.PI * 2);
        if (node.type === 'center') {
          context.fillStyle = '#050505';
          context.fill();
          context.lineWidth = 4;
          context.strokeStyle = '#ff7a9e';
          context.shadowBlur = Math.sin(time / 300) * 5 + 15;
          context.shadowColor = 'rgba(255, 122, 158, .6)';
          context.stroke();
          context.shadowBlur = 0;
        } else if (node.type === 'child') {
          context.fillStyle = '#1a1418';
          context.fill();
          context.lineWidth = 2;
          context.strokeStyle = '#ff7a9e';
          context.stroke();
        } else {
          context.fillStyle = 'rgba(255, 122, 158, .1)';
          context.fill();
          context.lineWidth = 1;
          context.strokeStyle = 'rgba(255, 122, 158, .5)';
          context.stroke();
        }
      });
      canvasFrameRef.current = requestAnimationFrame(draw);
    };

    const resizeObserver = new ResizeObserver(initialiseCanvas);
    resizeObserver.observe(canvas.parentElement!);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerleave', clearMouse);
    initialiseCanvas();
    canvasFrameRef.current = requestAnimationFrame(draw);

    return () => {
      if (canvasFrameRef.current) cancelAnimationFrame(canvasFrameRef.current);
      resizeObserver.disconnect();
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerleave', clearMouse);
    };
  }, []);

  useEffect(() => {
    let frameId = 0;
    const start = window.setTimeout(() => {
      const startedAt = performance.now();
      const updateHealth = (time: number) => {
        const progress = Math.min((time - startedAt) / 1380, 1);
        setHealth(Math.round(92 * (1 - Math.pow(1 - progress, 3))));
        if (progress < 1) frameId = requestAnimationFrame(updateHealth);
      };
      frameId = requestAnimationFrame(updateHealth);
    }, 500);
    return () => {
      window.clearTimeout(start);
      cancelAnimationFrame(frameId);
    };
  }, []);

  useEffect(() => {
    const interval = window.setInterval(() => {
      setBars((previous) => previous.map((_, index) => index > 7 ? 75 + Math.random() * 25 : 15 + Math.random() * 65));
    }, 400);
    return () => window.clearInterval(interval);
  }, []);

  const circumference = 2 * Math.PI * 45;
  const ringOffset = circumference - (health / 100) * circumference;

  return (
    <section id="features" className={styles.section}>
      <div className={styles.content}>
        <header className={styles.header}>
          <h2>Repository intelligence</h2>
          <p>An enterprise-grade engine unifying repository ingestion, decoupled UI customization, proactive security, and zero-touch deployment.</p>
          <div className={styles.integrations} aria-label="Repository sources">
            {integrations.map(({ id, label, icon: Icon, soon }) => {
              const isActive = activeIntegration === id;
              return <button key={id} type="button" className={`${styles.integration} ${isActive ? styles.integrationActive : ''} ${soon ? styles.integrationSoon : ''}`} disabled={soon} onClick={() => !soon && setActiveIntegration(id as 'github' | 'local')}><Icon size={18} /><span>{label}</span>{soon && <small>— soon</small>}</button>;
            })}
          </div>
        </header>

        <article className={styles.topology}>
          <div className={styles.cornerBrackets} aria-hidden="true" />
          <div className={styles.topologyHeader}><span><Network size={15} /> Live topology <i /></span></div>
          <div className={styles.workflow}>
            <div className={styles.workflowScan} aria-hidden="true" />
            {workflow.map(([title, description], index) => <div key={title} className={index === 0 ? styles.workflowPrimary : ''}><i aria-hidden="true" /><h3>{title}</h3><p>{description}</p></div>)}
          </div>
          <div className={styles.canvasShell}>
            <canvas ref={canvasRef} className={styles.canvas} aria-label="Interactive repository topology map" />
            <div className={styles.ringLarge} aria-hidden="true" />
            <div className={styles.ringSmall} aria-hidden="true" />
          </div>
          <div className={styles.telemetry}>
            <div className={styles.healthDial}>
              <svg viewBox="0 0 100 100" aria-hidden="true">
                <circle cx="50" cy="50" r="45" fill="none" stroke="rgba(255,255,255,.05)" strokeWidth="4" />
                <circle cx="50" cy="50" r="38" fill="none" stroke="rgba(255,255,255,.1)" strokeWidth="1" strokeDasharray="2 4" />
                <circle className={styles.healthRing} cx="50" cy="50" r="45" fill="none" strokeWidth="4" strokeDasharray={circumference} strokeDashoffset={ringOffset} strokeLinecap="round" />
              </svg>
              <div><strong>{health}%</strong><small>Health</small></div>
            </div>
            <div className={styles.equalizer}><div className={styles.bars}>{bars.map((height, index) => <i key={index} style={{ height: `${height}%`, opacity: height < 35 ? .3 : 1 }} />)}</div><div className={styles.signal}><i /><span><b /></span></div></div>
          </div>
        </article>
      </div>
    </section>
  );
}
