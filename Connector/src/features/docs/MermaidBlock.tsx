'use client';

import { useEffect, useId, useRef, useState } from 'react';

export function MermaidBlock({ chart }: { chart: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const reactId = useId().replace(/:/g, '');
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    const render = async () => {
      try {
        const mod = await import('mermaid');
        const mermaid = mod.default;
        mermaid.initialize({
          startOnLoad: false,
          theme: 'neutral',
          securityLevel: 'strict',
          fontFamily: 'inherit',
        });
        const id = `guide-mermaid-${reactId}`;
        const { svg } = await mermaid.render(id, chart);
        if (cancelled || !ref.current) return;
        ref.current.innerHTML = svg;
      } catch {
        if (!cancelled) setFailed(true);
      }
    };
    void render();
    return () => {
      cancelled = true;
    };
  }, [chart, reactId]);

  if (failed) {
    return (
      <pre className="overflow-x-auto border-[3px] border-black bg-white p-4 font-mono text-[12px] leading-5 text-black">
        {chart}
      </pre>
    );
  }

  return <div ref={ref} className="overflow-x-auto border-[3px] border-black bg-white p-4" />;
}
