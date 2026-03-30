export type ArchitectureProvider = 'aws' | 'azure' | 'gcp';

export interface ArchitectureNode {
  id: string;
  type: string;
  label?: string;
  region?: string;
  attributes: Record<string, unknown>;
  [key: string]: unknown;
}

export interface ArchitectureEdge {
  from: string;
  to: string;
  label?: string;
  [key: string]: unknown;
}

export interface ArchitectureJson {
  title: string;
  schema_version: string;
  provider?: ArchitectureProvider;
  nodes: ArchitectureNode[];
  edges: ArchitectureEdge[];
  metadata: Record<string, unknown>;
  [key: string]: unknown;
}

export interface ArchitectureValidationResult {
  valid: boolean;
  errors: string[];
  normalized?: ArchitectureJson;
}

const NODE_ID_RE = /^[A-Za-z][A-Za-z0-9_-]{0,127}$/;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function readOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function validateArchitectureJson(input: unknown): ArchitectureValidationResult {
  const root = asRecord(input);
  if (!root) {
    return { valid: false, errors: ['architecture_json must be an object'] };
  }

  const errors: string[] = [];
  const title = readOptionalString(root.title);
  if (!title) errors.push('title is required and must be a non-empty string');

  const schemaVersion = readOptionalString(root.schema_version) || '1.0';
  const providerRaw = readOptionalString(root.provider);
  const provider = providerRaw ? providerRaw.toLowerCase() : undefined;
  if (provider && !['aws', 'azure', 'gcp'].includes(provider)) {
    errors.push('provider must be one of aws, azure, gcp when provided');
  }

  const rawNodes = Array.isArray(root.nodes) ? root.nodes : null;
  if (!rawNodes) {
    errors.push('nodes must be an array');
  } else if (rawNodes.length === 0) {
    errors.push('nodes must contain at least one node');
  }

  const nodes: ArchitectureNode[] = [];
  const nodeIds = new Set<string>();

  if (rawNodes) {
    rawNodes.forEach((item, idx) => {
      const node = asRecord(item);
      if (!node) {
        errors.push(`nodes[${idx}] must be an object`);
        return;
      }

      const id = readOptionalString(node.id);
      if (!id) {
        errors.push(`nodes[${idx}].id is required`);
        return;
      }
      if (!NODE_ID_RE.test(id)) {
        errors.push(`nodes[${idx}].id must match ${NODE_ID_RE.toString()}`);
      }
      if (nodeIds.has(id)) {
        errors.push(`duplicate node id found: ${id}`);
      }
      nodeIds.add(id);

      const type = readOptionalString(node.type);
      if (!type) {
        errors.push(`nodes[${idx}].type is required`);
      }

      const attributes = asRecord(node.attributes) || {};
      const normalizedNode: ArchitectureNode = {
        ...node,
        id,
        type: type || '',
        attributes,
      };
      const label = readOptionalString(node.label);
      if (label) normalizedNode.label = label;
      const region = readOptionalString(node.region);
      if (region) normalizedNode.region = region;
      nodes.push(normalizedNode);
    });
  }

  const rawEdges = Array.isArray(root.edges) ? root.edges : [];
  if (!Array.isArray(root.edges) && root.edges !== undefined) {
    errors.push('edges must be an array when provided');
  }

  const edges: ArchitectureEdge[] = [];
  rawEdges.forEach((item, idx) => {
    const edge = asRecord(item);
    if (!edge) {
      errors.push(`edges[${idx}] must be an object`);
      return;
    }
    const from = readOptionalString(edge.from);
    const to = readOptionalString(edge.to);
    if (!from) errors.push(`edges[${idx}].from is required`);
    if (!to) errors.push(`edges[${idx}].to is required`);
    if (!from || !to) return;

    if (!nodeIds.has(from) || !nodeIds.has(to)) {
      errors.push(`edges[${idx}] references unknown node(s): ${from} -> ${to}`);
    }

    const normalizedEdge: ArchitectureEdge = { ...edge, from, to };
    const label = readOptionalString(edge.label);
    if (label) normalizedEdge.label = label;
    edges.push(normalizedEdge);
  });

  const metadata = asRecord(root.metadata) || {};

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  const normalized: ArchitectureJson = {
    ...root,
    title: title as string,
    schema_version: schemaVersion,
    nodes,
    edges,
    metadata,
  };
  if (provider === 'aws' || provider === 'azure' || provider === 'gcp') {
    normalized.provider = provider;
  }

  return {
    valid: true,
    errors: [],
    normalized,
  };
}
