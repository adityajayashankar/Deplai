import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, verifyProjectOwnership } from '@/lib/auth';
import { validateArchitectureJson } from '@/lib/architecture-contract';
import { resolveAwsIconName } from '@/lib/aws-icons';

interface DiagramBody {
  project_id?: string;
  architecture_json?: unknown;
}

interface DiagramNodePreview {
  id: string;
  label: string;
  type: string;
  icon_name: string;
  icon_url: string;
}

function safeId(value: string, fallback: string): string {
  const v = value.replace(/[^a-zA-Z0-9_]/g, '_');
  return v.length > 0 ? v : fallback;
}

export async function POST(req: NextRequest) {
  try {
    const { user, error } = await requireAuth();
    if (error) return error;

    const body = await req.json() as DiagramBody;
    const projectId = String(body.project_id || '').trim();
    if (projectId) {
      const owned = await verifyProjectOwnership(user.id, projectId);
      if ('error' in owned) return owned.error;
    }

    const archValidation = validateArchitectureJson(body.architecture_json);
    if (!archValidation.valid || !archValidation.normalized) {
      return NextResponse.json(
        { error: `architecture_json contract validation failed: ${archValidation.errors.join('; ')}` },
        { status: 400 },
      );
    }
    const architecture = archValidation.normalized;
    const nodes = architecture.nodes;
    const edges = architecture.edges;
    const title = architecture.title;

    const nodeLines: string[] = [];
    const nodePreview: DiagramNodePreview[] = [];
    const idMap = new Map<string, string>();
    nodes.forEach((node, idx) => {
      const rawId = String(node.id || `node_${idx + 1}`);
      const mermaidId = safeId(rawId, `node_${idx + 1}`);
      idMap.set(rawId, mermaidId);
      const labelValue = String(node.label || node.type || rawId);
      const label = labelValue.replace(/"/g, '\\"');
      const typeValue = String(node.type || '');
      const iconName = resolveAwsIconName(typeValue, labelValue);
      const iconUrl = `/api/assets/aws-icon/${encodeURIComponent(iconName)}`;
      nodeLines.push(`  ${mermaidId}["${label}"]`);
      nodePreview.push({
        id: rawId,
        label: labelValue,
        type: typeValue,
        icon_name: iconName,
        icon_url: iconUrl,
      });
    });

    const edgeLines: string[] = [];
    edges.forEach((edge, idx) => {
      const fromRaw = String(edge.from || '');
      const toRaw = String(edge.to || '');
      const from = idMap.get(fromRaw) || safeId(fromRaw, `from_${idx + 1}`);
      const to = idMap.get(toRaw) || safeId(toRaw, `to_${idx + 1}`);
      if (!from || !to) return;
      const label = String(edge.label || '').trim().replace(/"/g, '\\"');
      edgeLines.push(label ? `  ${from} -->|${label}| ${to}` : `  ${from} --> ${to}`);
    });

    const mermaid = [
      'flowchart LR',
      ...nodeLines,
      ...edgeLines,
    ].join('\n');

    return NextResponse.json({
      success: true,
      diagram: {
        title,
        type: 'mermaid',
        content: mermaid,
        node_count: nodes.length,
        edge_count: edges.length,
        nodes: nodePreview,
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to generate diagram';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
