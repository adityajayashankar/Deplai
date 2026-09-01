'use client';

import type {
  DecisionDiagramEdge,
  DecisionDiagramModel,
  DecisionDiagramNode,
} from '@/features/deployment/decision-topology-diagram';
import {
  getTopologyNodeHeight,
  TOPOLOGY_NODE_WIDTH,
  TOPOLOGY_THEME,
  topologyEdgePath,
  topologyNodePositions,
} from '@/features/deployment/decision-topology-diagram';

const LEGEND_ITEMS: Array<{ label: string; color: string }> = [
  { label: 'Networking', color: '#58a6ff' },
  { label: 'Compute', color: '#d29922' },
  { label: 'Data', color: '#3fb950' },
  { label: 'Security', color: '#f85149' },
];

const FONT_DISPLAY = 'var(--font-display, "Space Grotesk", sans-serif)';
const FONT_MONO = 'var(--font-mono, "JetBrains Mono", monospace)';

function TopologyNodeCard({ node }: { node: DecisionDiagramNode }) {
  const height = getTopologyNodeHeight(node);
  const details = node.details.slice(0, 2);
  const isInternet = node.id === 'internet';
  const fill = isInternet ? TOPOLOGY_THEME.nodeFillInternet : TOPOLOGY_THEME.nodeFill;

  return (
    <g transform={`translate(${node.x},${node.y})`}>
      {/* Brutalist offset shadow — matches dw-panel hard shadow on recessed surfaces */}
      <rect
        x="3"
        y="3"
        width={TOPOLOGY_NODE_WIDTH}
        height={height}
        fill="#000000"
        opacity="0.45"
      />
      <rect
        width={TOPOLOGY_NODE_WIDTH}
        height={height}
        fill={fill}
        stroke={TOPOLOGY_THEME.border}
        strokeWidth="2"
      />
      <rect x="0" y="0" width={TOPOLOGY_NODE_WIDTH} height="3" fill={node.color} />
      <text
        x="14"
        y={details.length ? 26 : height / 2 + 5}
        fill={TOPOLOGY_THEME.fg}
        fontSize="12"
        fontWeight="600"
        style={{ fontFamily: FONT_DISPLAY }}
      >
        {node.label}
      </text>
      {details.map((line, index) => (
        <text
          key={`${node.id}-detail-${index}`}
          x="14"
          y={44 + index * 14}
          fill={TOPOLOGY_THEME.muted}
          fontSize="9.5"
          style={{ fontFamily: FONT_MONO }}
        >
          {line}
        </text>
      ))}
    </g>
  );
}

function TopologyEdge({
  edge,
  index,
  positions,
}: {
  edge: DecisionDiagramEdge;
  index: number;
  positions: ReturnType<typeof topologyNodePositions>;
}) {
  const from = positions.get(edge.from);
  const to = positions.get(edge.to);
  if (!from || !to) return null;

  const { path, labelX, labelY } = topologyEdgePath(from, to);
  const label = String(edge.label || '').trim();

  return (
    <g key={`${edge.from}-${edge.to}-${index}`}>
      <path
        d={path}
        fill="none"
        stroke={TOPOLOGY_THEME.accent}
        strokeWidth="2"
        markerEnd="url(#topology-flow-arrow)"
      />
      {label ? (
        <g>
          <rect
            x={labelX - 36}
            y={labelY - 9}
            width="72"
            height="16"
            fill={TOPOLOGY_THEME.canvas}
            stroke={TOPOLOGY_THEME.border}
            strokeWidth="1.5"
          />
          <text
            x={labelX}
            y={labelY + 3}
            textAnchor="middle"
            fill={TOPOLOGY_THEME.accent}
            fontSize="8.5"
            letterSpacing="0.06em"
            style={{ fontFamily: FONT_MONO }}
          >
            {label}
          </text>
        </g>
      ) : null}
    </g>
  );
}

export function DecisionTopologyDiagram({ model }: { model: DecisionDiagramModel }) {
  const positions = topologyNodePositions(model.nodes);
  const uniqueNodes = Array.from(new Map(model.nodes.map((node) => [node.id, node])).values());
  const canvasHeight = model.canvasHeight;

  return (
    <svg
      viewBox={`0 0 980 ${canvasHeight}`}
      className="w-full"
      style={{ background: TOPOLOGY_THEME.canvas }}
      role="img"
      aria-label="AWS deployment topology diagram"
    >
      <defs>
        <marker id="topology-flow-arrow" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto">
          <polygon points="0 0, 8 3, 0 6" fill={TOPOLOGY_THEME.accent} />
        </marker>
        <pattern id="topology-grid" width="24" height="24" patternUnits="userSpaceOnUse">
          <path d="M 24 0 L 0 0 0 24" fill="none" stroke={TOPOLOGY_THEME.grid} strokeWidth="1" />
        </pattern>
      </defs>

      <rect x="0" y="0" width="980" height={canvasHeight} fill="url(#topology-grid)" />

      {model.hasVpcBoundary ? (
        <>
          <rect
            x="190"
            y="48"
            width="740"
            height={model.hasPrivateTier ? 420 : 260}
            fill="rgba(255,255,255,0.02)"
            stroke={TOPOLOGY_THEME.border}
            strokeWidth="2"
          />
          <text
            x="214"
            y="76"
            fill={TOPOLOGY_THEME.fgSoft}
            fontSize="10"
            letterSpacing="0.16em"
            style={{ fontFamily: FONT_MONO }}
          >
            VPC · {String(model.awsRegion).toUpperCase()}
          </text>
          <rect
            x="220"
            y="100"
            width="680"
            height={model.hasPrivateTier ? 170 : 180}
            fill="rgba(255,255,255,0.015)"
            stroke={TOPOLOGY_THEME.borderSoft}
            strokeWidth="1.5"
            strokeDasharray="6 4"
          />
          <text x="240" y="120" fill={TOPOLOGY_THEME.muted} fontSize="9.5" letterSpacing="0.18em" style={{ fontFamily: FONT_MONO }}>
            PUBLIC SUBNET
          </text>
          <text x="240" y="136" fill={TOPOLOGY_THEME.faint} fontSize="8.5" style={{ fontFamily: FONT_MONO }}>
            Internet-facing · inbound allowed
          </text>
          {model.hasPrivateTier ? (
            <>
              <rect
                x="220"
                y="292"
                width="680"
                height="150"
                fill="rgba(255,255,255,0.01)"
                stroke={TOPOLOGY_THEME.borderSoft}
                strokeWidth="1.5"
                strokeDasharray="6 4"
              />
              <text x="240" y="312" fill={TOPOLOGY_THEME.muted} fontSize="9.5" letterSpacing="0.18em" style={{ fontFamily: FONT_MONO }}>
                PRIVATE SUBNET{model.hasMultiAz ? ' · MULTI-AZ' : ''}
              </text>
              <text x="240" y="328" fill={TOPOLOGY_THEME.faint} fontSize="8.5" style={{ fontFamily: FONT_MONO }}>
                Internal only · no direct inbound
              </text>
            </>
          ) : null}
        </>
      ) : null}

      {model.edges.map((edge, index) => (
        <TopologyEdge key={`edge-${edge.from}-${edge.to}-${index}`} edge={edge} index={index} positions={positions} />
      ))}

      {uniqueNodes.map((node) => (
        <TopologyNodeCard key={node.id} node={node} />
      ))}

      <g transform={`translate(214, ${canvasHeight - 34})`}>
        <text fill={TOPOLOGY_THEME.faint} fontSize="8.5" letterSpacing="0.14em" style={{ fontFamily: FONT_MONO }}>
          LEGEND
        </text>
        {LEGEND_ITEMS.map((item, index) => {
          const x = 72 + index * 118;
          return (
            <g key={item.label} transform={`translate(${x}, 0)`}>
              <rect x="-2" y="0" width="8" height="8" fill={item.color} stroke={TOPOLOGY_THEME.border} strokeWidth="1" />
              <text x="12" y="7" fill={TOPOLOGY_THEME.muted} fontSize="8.5" style={{ fontFamily: FONT_MONO }}>
                {item.label}
              </text>
            </g>
          );
        })}
      </g>
    </svg>
  );
}
